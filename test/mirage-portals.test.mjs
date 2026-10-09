// mirage init/start/status/stop for every catalogue site (portals=all): one project and one
// runtime per site. Loopback Mirages on synthetic exports only; no portal is contacted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFixture } from './fixture.mjs';
import { severalPortals } from '../lense/commands/mirage.mjs';

const cli = fileURLToPath(new URL('../lense/cli.mjs', import.meta.url));
const ENHANCED = fs.realpathSync.native(fileURLToPath(new URL('../test-browser/fixtures/enhanced/', import.meta.url)));
function run(...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')));
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 150_000 });
}
const json = (result) => JSON.parse(result.stdout);

/**
 * A fixture portal in a folder of its own. Solution discovery looks at the sibling folders of the
 * portal's Git repository; a repository directly in the temporary folder would discover other
 * tests' temporary Solution folders (which can disappear while this test runs).
 */
function isolatedFixture() {
  const fixture = createFixture();
  const container = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-portals-')));
  const dir = path.join(container, 'portal');
  fs.cpSync(fixture.dir, dir, { recursive: true });
  fixture.cleanup();
  return { dir, cleanup: () => fs.rmSync(container, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) };
}

test('portals=all reaches every catalogue site for dev and start; init and stop with --site stay with that site', () => {
  const all = { portals: 'all' };
  assert.equal(severalPortals(all, {}, 'dev'), true);
  assert.equal(severalPortals(all, { site: 'sample' }, 'dev'), true, '--site picks the first portal');
  assert.equal(severalPortals(all, { site: 'sample' }, 'start'), true);
  assert.equal(severalPortals(all, { site: 'sample' }, 'init'), false);
  assert.equal(severalPortals(all, { site: 'sample' }, 'stop'), false);
  assert.equal(severalPortals(all, {}, 'stop'), true);
  assert.equal(severalPortals(all, { portals: 'selected' }, 'dev'), false);
  assert.equal(severalPortals({ portals: 'selected' }, { portals: 'all', site: 'sample' }, 'stop'), true);
  assert.equal(severalPortals(all, {}, 'inspect'), false);
  assert.equal(severalPortals(all, {}, 'status'), false);
});

test('mirage with portals=all writes one project per site, starts one runtime per site, labels them in status and stops them together', { timeout: 300_000 }, () => {
  const classic = isolatedFixture();
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-mirage-portals-')));
  const config = path.join(work, 'paqvilo.config.yml');
  const project = (site) => path.join(work, `${site}.project.yml`);
  fs.writeFileSync(config, JSON.stringify({
    defaultSite: 'classic',
    portals: 'all',
    sites: {
      classic: { source: classic.dir, defaultEnv: 'dev', environments: { dev: 'https://classic.example.com' }, mirage: { port: 0, project: project('classic') } },
      enhanced: { source: ENHANCED, defaultEnv: 'dev', environments: { dev: 'https://enhanced.example.com' }, mirage: { port: 0, project: project('enhanced') } },
    },
  }, null, 2));
  let started = null;
  try {
    const init = run('mirage', 'init', '--config', config, '--json');
    assert.equal(init.status, 0, init.stdout + init.stderr);
    assert.deepEqual(json(init).projects.map((item) => [item.site, item.file]), [['classic', project('classic')], ['enhanced', project('enhanced')]]);
    assert.ok(fs.existsSync(project('classic')) && fs.existsSync(project('enhanced')));
    // With --site, init stays with that site (and refuses to overwrite silently).
    assert.match(json(run('mirage', 'init', '--config', config, '--site', 'classic', '--json')).error.message, /already exists/);

    // --port, --state, --preset and --solution-root apply to the selected site; options that name
    // one runtime of a project, or one source, do not fit several catalogue portals.
    const conflict = run('mirage', 'start', '--config', config, '--portal', 'classic', '--json');
    assert.equal(conflict.status, 1);
    assert.match(json(conflict).error.message, /--portal applies to a single runtime\. \(--port, --state, --preset, --solution-root apply to the selected site\.\)/);
    const misplaced = run('mirage', 'status', '--config', config, '--allow-live-writes', '--json');
    assert.equal(misplaced.status, 1);
    assert.match(json(misplaced).error.message, /--allow-live-writes applies only to mirage dev and start/);

    started = run('mirage', 'start', '--config', config, '--startup-timeout', '120000', '--json');
    assert.equal(started.status, 0, started.stdout + started.stderr);
    const portals = json(started).portals;
    assert.deepEqual(portals.map((item) => item.site), ['classic', 'enhanced']);
    assert.ok(portals.every((item) => item.started && /^http:\/\/127\.0\.0\.1:\d+$/.test(item.url) && item.adminUrl === new URL('/_sim/', item.url).href));
    assert.notEqual(portals[0].url, portals[1].url);

    const status = json(run('mirage', 'status', '--config', config, '--json')).sessions;
    for (const item of portals) {
      const listed = status.find((session) => session.pid === item.pid);
      assert.ok(listed, `status lists ${item.site}`);
      assert.deepEqual([listed.site, listed.ready, listed.owned], [item.site, true, true]);
    }

    // Starting again reuses both runtimes.
    const again = json(run('mirage', 'start', '--config', config, '--json')).portals;
    assert.deepEqual(again.map((item) => [item.pid, item.started]), portals.map((item) => [item.pid, false]));

    // A catalogue that puts two sites on one port is refused before anything starts.
    const clash = path.join(work, 'clash.config.yml');
    const catalogue = JSON.parse(fs.readFileSync(config, 'utf8'));
    catalogue.sites.classic.mirage.port = 18797;
    catalogue.sites.enhanced.mirage.port = 18797;
    fs.writeFileSync(clash, JSON.stringify(catalogue));
    const refused = run('mirage', 'start', '--config', clash, '--json');
    assert.equal(refused.status, 1);
    assert.match(json(refused).error.message, /Each Mirage needs its own port \(port 18797: classic, enhanced\)/);
  } finally {
    const stopped = run('mirage', 'stop', '--config', config, '--json');
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    if (started?.status === 0) {
      const report = json(stopped);
      assert.deepEqual(report.stopped.map((item) => item.pid).sort(), json(started).portals.map((item) => item.pid).sort());
      assert.equal(report.remaining.length, 0);
    }
    classic.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('the dev selection offers one local target per running Mirage first, the selected site opening first, then the live targets', async () => {
  const { loadConfig } = await import('../lense/config.mjs');
  const { portalSelection } = await import('../lense/commands/mirage.mjs');
  const classic = isolatedFixture();
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-portal-selection-')));
  try {
    const config = path.join(work, 'paqvilo.config.yml');
    fs.writeFileSync(config, JSON.stringify({
      defaultSite: 'classic',
      portals: 'all',
      sites: {
        classic: { source: classic.dir, defaultEnv: 'dev', environments: { dev: 'https://classic-dev.example.com', test: 'https://classic-test.example.com' } },
        enhanced: { source: ENHANCED, defaultEnv: 'dev', environments: { dev: 'https://enhanced-dev.example.com' } },
      },
    }, null, 2));
    const site = (name) => loadConfig({ config, site: name }, {});
    const running = [
      { cfg: await site('classic'), session: { url: 'http://127.0.0.1:18781', sourceDir: classic.dir, launch: { solutionRoots: [] }, pid: 1, started: true } },
      { cfg: await site('enhanced'), session: { url: 'http://127.0.0.1:18782', sourceDir: ENHANCED, launch: { solutionRoots: [] }, pid: 2, started: false } },
    ];
    const { selection, live, note } = await portalSelection(await site('enhanced'), { config }, running);
    assert.equal(note, null);
    assert.equal(live, 3);
    assert.deepEqual(selection.targets.map((target) => [target.siteName, target.envName, target.origin, Boolean(target.mirage)]), [
      ['classic Mirage', 'local', 'http://127.0.0.1:18781', true],
      ['enhanced Mirage', 'local', 'http://127.0.0.1:18782', true],
      ['classic', 'dev', 'https://classic-dev.example.com', false],
      ['classic', 'test', 'https://classic-test.example.com', false],
      ['enhanced', 'dev', 'https://enhanced-dev.example.com', false],
    ]);
    assert.equal(selection.initial, selection.targets[1], 'the selected site opens first');
    const { browserProfileInfo } = await import('../lense/browser-profile.mjs');
    assert.equal(browserProfileInfo(selection.initial).name, 'mirage', 'local Mirages use their own browser profile');
    assert.equal(browserProfileInfo(selection.targets[2]).name, 'catalogue');
    assert.deepEqual(selection.initial.mirageSourceRoots, [ENHANCED]);
    assert.equal(selection.initial.mirageSession.adminUrl, 'http://127.0.0.1:18782/_sim/');
  } finally {
    classic.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('doctor --all warns when catalogue sites share a Mirage port', () => {
  const classic = isolatedFixture();
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-portal-doctor-')));
  try {
    const config = path.join(work, 'paqvilo.config.yml');
    fs.writeFileSync(config, JSON.stringify({
      defaultSite: 'classic',
      defaults: { mirage: { port: 18799 } },
      sites: {
        classic: { source: classic.dir, environments: { dev: 'https://classic.example.com' } },
        enhanced: { source: ENHANCED, environments: { dev: 'https://enhanced.example.com' }, mirage: { port: 18798 } },
        other: { source: classic.dir, environments: { dev: 'https://other.example.com' } },
      },
    }, null, 2));
    const report = JSON.parse(run('doctor', '--config', config, '--all', '--json').stdout);
    const warnings = (site) => report.reports.find((item) => item.site === site).mirage.warnings.filter((warning) => warning.includes('distinct port'));
    assert.match(warnings('classic')[0], /Mirage port 18799 is also configured for other/);
    assert.match(warnings('other')[0], /Mirage port 18799 is also configured for classic/);
    assert.deepEqual(warnings('enhanced'), []);
  } finally {
    classic.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('a project with several portals starts one runtime per portal on consecutive ports and stops them together', { timeout: 300_000 }, () => {
  const classic = isolatedFixture();
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-mirage-project-')));
  const config = path.join(work, 'paqvilo.config.yml');
  const projectFile = path.join(work, 'workspace.project.json');
  fs.writeFileSync(config, JSON.stringify({ defaultSite: 'classic', sites: { classic: { source: classic.dir, environments: { dev: 'https://classic.example.com' } } } }, null, 2));
  fs.writeFileSync(projectFile, JSON.stringify({
    version: 1,
    defaultPortal: 'enhanced',
    portals: [{ id: 'classic', path: classic.dir }, { id: 'enhanced', path: ENHANCED }],
    solutions: [],
    references: [],
  }, null, 2));
  let started = null;
  try {
    assert.match(json(run('mirage', 'start', '--config', config, '--project', projectFile, '--state', path.join(work, 'one.json'), '--json')).error.message, /keeps a state file per portal/);
    started = run('mirage', 'start', '--config', config, '--project', projectFile, '--port', '0', '--startup-timeout', '120000', '--json');
    assert.equal(started.status, 0, started.stdout + started.stderr);
    const portals = json(started).portals;
    assert.deepEqual(portals.map((item) => item.site), ['classic', 'enhanced']);
    assert.ok(portals.every((item) => item.started && item.url));
    assert.match(json(started).stop, /stop --project/);
    const status = json(run('mirage', 'status', '--config', config, '--json')).sessions;
    assert.deepEqual(portals.map((item) => status.find((session) => session.pid === item.pid)?.portal), ['classic', 'enhanced']);
  } finally {
    const stopped = run('mirage', 'stop', '--config', config, '--project', projectFile, '--json');
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
    if (started?.status === 0) assert.deepEqual(json(stopped).stopped.map((item) => item.pid).sort(), json(started).portals.map((item) => item.pid).sort());
    classic.cleanup();
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('Mirage ownership records survive concurrent updates from several toolkit processes', async () => {
  const work = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-ownership-')));
  try {
    const ownershipFile = path.join(work, 'mirage', 'sessions.json');
    const module = new URL('../lense/commands/mirage.mjs', import.meta.url).href;
    const writer = (index) => new Promise((resolve, reject) => {
      const code = [
        `const { updateOwnedSessions } = await import(${JSON.stringify(module)});`,
        `const paths = { ownershipFile: ${JSON.stringify(ownershipFile)} };`,
        `await Promise.all(Array.from({ length: 25 }, (_, i) => updateOwnedSessions(paths, (sessions) => [...sessions, { pid: ${index * 1000} + i, startedAt: 'test' }])));`,
      ].join('\n');
      const child = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('exit', (status) => (status === 0 ? resolve() : reject(new Error(stderr))));
    });
    await Promise.all([1, 2, 3, 4].map(writer));
    const sessions = JSON.parse(fs.readFileSync(ownershipFile, 'utf8')).sessions;
    assert.equal(sessions.length, 100, 'no process lost another process\'s records');
    assert.equal(new Set(sessions.map((item) => item.pid)).size, 100);
    assert.equal(fs.existsSync(`${ownershipFile}.lock`), false, 'the lock is released');
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test('every Mirage started from the catalogue reads the catalogue file and checkout this command resolved', async () => {
  const { catalogueStartPlans, cliArgs } = await import('../lense/commands/mirage.mjs');
  const site = (name) => ({ siteName: name, envName: 'dev', sourceDir: path.join(os.tmpdir(), name), origin: `https://${name}.example.com`, mirageConfig: { port: 0, preset: `${name}-default` } });
  const option = (values, name) => values.slice(values.indexOf(name), values.indexOf(name) + 2);
  const plans = catalogueStartPlans([{ site: 'alpha', cfg: site('alpha') }, { site: 'beta', cfg: site('beta') }], { config: 'catalogue.yml', repo: 'checkout', 'startup-timeout': '5000', 'allow-live-writes': true, preset: 'demo', port: '9911', state: 'alpha-state.json', 'solution-root': ['solutions/a'] }, 'beta');
  assert.deepEqual(plans.map((plan) => plan.site), ['alpha', 'beta']);
  for (const plan of plans) {
    const { values } = cliArgs(plan.cfg, 'serve', plan.args);
    assert.deepEqual(option(values, '--site'), ['--site', plan.site]);
    assert.deepEqual(option(values, '--config'), ['--config', path.resolve('catalogue.yml')]);
    assert.deepEqual(option(values, '--repo'), ['--repo', path.resolve('checkout')]);
    assert.ok(values.includes('--allow-live-writes'), 'live writes are allowed for every runtime of the command, or none');
  }
  // --preset, --port, --state and --solution-root apply to the selected site (beta); the other
  // sites keep their catalogue settings.
  const [alpha, beta] = plans.map((plan) => cliArgs(plan.cfg, 'serve', plan.args).values);
  assert.deepEqual([option(alpha, '--preset'), option(alpha, '--port'), alpha.includes('--state'), alpha.includes('--solution-root')], [['--preset', 'alpha-default'], ['--port', '0'], false, false]);
  assert.deepEqual([option(beta, '--preset'), option(beta, '--port'), option(beta, '--state'), option(beta, '--solution-root')], [['--preset', 'demo'], ['--port', '9911'], ['--state', path.resolve('alpha-state.json')], ['--solution-root', path.resolve('solutions/a')]]);
  const off = cliArgs(site('alpha'), 'serve', { 'allow-live-writes': false }).values;
  assert.equal(off.includes('--allow-live-writes'), false, 'live writes stay off unless the flag is given');
  const projected = cliArgs(site('alpha'), 'serve', { 'allow-live-writes': true }, { configFile: path.join(os.tmpdir(), 'alpha.project.yml'), defaultPortal: 'alpha' }).values;
  assert.ok(projected.includes('--allow-live-writes'), 'a project runtime gets the flag too');
  const plain = cliArgs(site('alpha'), 'serve', {}).values;
  assert.ok(!plain.includes('--config') && !plain.includes('--repo'), 'without --config the Mirage reads the default catalogue, as this command did');
  const project = cliArgs(site('alpha'), 'serve', { config: 'catalogue.yml', repo: 'checkout' }, { configFile: path.join(os.tmpdir(), 'alpha.project.yml'), defaultPortal: 'alpha' }).values;
  assert.ok(!project.includes('--config') && !project.includes('--repo'), 'a project file names everything its runtime reads');
});

test('mirage stop keeps the record of a live process whose start identity cannot be verified, and never signals it', async (t) => {
  const { stopOwnedSessions, ownedSessions, processIdentity, isAlive } = await import('../lense/commands/mirage.mjs');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-mirage-unverified-')));
  const paths = { discoveryRoot: path.join(root, 'simulator'), ownershipFile: path.join(root, 'mirage', 'sessions.json'), logRoot: path.join(root, 'logs') };
  fs.mkdirSync(paths.discoveryRoot, { recursive: true });
  const idle = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const unreadable = idle(), unrecorded = idle();
  t.after(() => {
    for (const child of [unreadable, unrecorded]) { try { child.kill(); } catch { /* exited */ } }
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  await Promise.all([unreadable, unrecorded].map((child) => new Promise((resolve) => child.once('spawn', resolve))));
  const sourceDir = path.join(root, 'portal');
  const record = (child, processIdentity) => ({ pid: child.pid, processIdentity, sourceDir, discovery: path.join(paths.discoveryRoot, `session-${child.pid}.json`), url: 'http://127.0.0.1:9/', ready: true });
  fs.mkdirSync(path.dirname(paths.ownershipFile), { recursive: true });
  fs.writeFileSync(paths.ownershipFile, JSON.stringify({ version: 1, sessions: [record(unreadable, processIdentity(unreadable.pid)), record(unrecorded, null)] }));

  // The first identity cannot be read now (PowerShell timing out on a busy machine, say); the
  // second was never recorded. Neither is proof of a reused process ID, nor safe to signal.
  const identityOf = (pid) => (pid === unreadable.pid ? null : processIdentity(pid));
  const report = await stopOwnedSessions({ paths, sourceDir, deadline: 2000, identityOf });
  assert.deepEqual([report.stopped, report.pruned, report.remaining], [[], [], []]);
  assert.deepEqual(report.unverified.map((item) => [item.pid, item.reason]), [
    [unreadable.pid, 'its start identity could not be read now; run stop again'],
    [unrecorded.pid, 'no start identity was recorded when it started, so it is never signalled'],
  ]);
  assert.ok(isAlive(unreadable.pid) && isAlive(unrecorded.pid), 'an unverified process is never signalled');
  assert.deepEqual((await ownedSessions(paths)).map((item) => item.pid), [unreadable.pid, unrecorded.pid], 'the records stay for a later stop');

  // Once the identity can be read again, stop ends that process.
  const again = await stopOwnedSessions({ paths, sourceDir, deadline: 5000 });
  assert.deepEqual(again.stopped.map((item) => item.pid), [unreadable.pid]);
  assert.equal(isAlive(unreadable.pid), false);
  assert.deepEqual(again.unverified.map((item) => item.pid), [unrecorded.pid]);
});
