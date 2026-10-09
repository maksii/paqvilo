import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createFixture, SITE } from './fixture.mjs';
import { inspectCheckout } from '../lense/commands/doctor.mjs';
import { editSource } from '../lense/source-edit.mjs';
import { componentContent } from '../lense/portal-model.mjs';

let fx;
before(() => { fx = createFixture(); });
after(() => fx.cleanup());
const cli = fileURLToPath(new URL('../lense/cli.mjs', import.meta.url));
function runWithin(timeout, ...args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_') && !key.startsWith('GIT_')));
  return spawnSync(process.execPath, [cli, ...args], { env, encoding: 'utf8', windowsHide: true, timeout });
}
const run = (...args) => runWithin(30_000, ...args);

test('offline doctor diagnoses the extract and unavailable baseline without fetch', (t) => {
  t.mock.method(globalThis, 'fetch', () => { throw new Error('Network access is forbidden in offline diagnostics'); });
  const cfg = { siteName: 'test', envName: 'dev', origin: 'https://portal.example', sourceDir: fx.dir, site: structuredClone(SITE) };
  const report = inspectCheckout(cfg);
  assert.equal(report.ready, true);
  assert.equal(report.counts.mappedWebFiles, 2);
  assert.ok(report.warnings.some((w) => w.includes('orphan')));
  cfg.site.markup.baseline = 'nonexistent-ref';
  assert.equal(inspectCheckout(cfg).ready, false);
});

test('standalone CLI resolves the baseline in the portal repository and discovers its extracts', () => {
  const file = fx.file('standalone-catalogue.yml');
  fs.writeFileSync(file, 'sourceRoot: missing-checkout\nsites:\n  test:\n    source: .\n    environments:\n      dev: https://portal.example\n');
  const result = run('doctor', '--config', file, '--repo', fx.dir, '--all', '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.reports[0].source, fx.dir);
  assert.equal(report.reports[0].baseline.commit, execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fx.dir, encoding: 'utf8', windowsHide: true }).trim());
  const listed = run('list', '--config', file, '--repo', fx.dir, '--settings', '--json');
  assert.equal(listed.status, 0, listed.stdout + listed.stderr);
  assert.equal(JSON.parse(listed.stdout).sourceRoot, fx.dir);
  assert.match(JSON.parse(listed.stdout).supportedSettings.PAQVILO_REPO, /worktree/);
});

test('CLI errors are concise and invalid list selections fail in JSON mode', () => {
  const typo = run('list', '--typo');
  assert.equal(typo.status, 1);
  assert.match(typo.stderr, /paqvilo:/);
  assert.doesNotMatch(typo.stderr, /node:internal/);
  const file = fx.file('catalogue.yml');
  fs.writeFileSync(file, `sites:\n  test:\n    source: .\n    environments:\n      dev: https://portal.example\n`);
  const invalid = run('list', '--config', file, '--site', 'missing', '--json');
  assert.equal(invalid.status, 1);
  assert.match(JSON.parse(invalid.stdout).problem, /Unknown site/);
  const doctor = run('doctor', '--config', file, '--all', '--json');
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).offline, true);
  assert.equal(run('map', 'unexpected').status, 1);
});

test('Mirage status is available as a structured toolkit command', () => {
  const config = fx.file('mirage-catalogue.yml');
  fs.writeFileSync(config, `defaultSite: test\nsites:\n  test:\n    source: .\n    environments:\n      dev: https://portal.example.com\n`);
  const result = run('mirage', 'status', '--config', config, '--repo', fx.dir, '--json');
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.command, 'mirage');
  assert.equal(report.ok, true);
  assert.ok(Array.isArray(report.sessions));
});

test('Mirage start waits for runtime readiness and exposes page dependency context', async () => {
  const config = fx.file('mirage-runtime-catalogue.yml');
  fs.writeFileSync(config, `defaultSite: test\nsites:\n  test:\n    source: .\n    environments:\n      dev: https://portal.example.com\n    mirage:\n      observed:\n        loginPath: /SignIn\n        evidence: notes/observed-signin.json\n`);
  // A busy machine can need more than 30 s to import. The command's own startup timeout ends
  // first, so a failed start stops its runtime instead of being killed and leaving it running.
  const started = runWithin(150_000, 'mirage', 'start', '--config', config, '--repo', fx.dir, '--port', '0', '--startup-timeout', '120000', '--json');
  assert.equal(started.status, 0, started.stdout + started.stderr);
  const session = JSON.parse(started.stdout);
  assert.equal(session.ok, true);
  assert.equal(session.ready, true);
  assert.equal(session.owned, true);
  assert.equal(session.started, true);
  assert.equal(session.adminUrl, new URL('/_sim/', session.url).href);
  assert.ok(path.isAbsolute(session.stateFile));
  assert.ok(session.stateFile.startsWith(path.join(path.dirname(config), '.paqvilo') + path.sep));
  assert.match(session.stop, /npx paqvilo mirage stop --site test/);
  assert.equal(session.runtime.liveWrites, 'disabled', 'without --allow-live-writes no live write can leave the runtime');
  let stopped;
  try {
    const response = await fetch(new URL('/_sim/api/page-resources?path=/', session.url));
    assert.equal(response.status, 200, response.body);
    const resources = await response.json();
    assert.equal(resources.path, '/');
    assert.ok(Array.isArray(resources.dependencies));
    assert.ok(Array.isArray(resources.sourceRoots));
    // The Mirage reads the catalogue this command resolved (--config), so the site's
    // observed behaviour reaches the runtime.
    const state = await (await fetch(new URL('/_sim/api/state?summary=1', session.url))).json();
    assert.deepEqual(state.status.bootstrap.observed, { loginPath: '/SignIn', evidence: 'notes/observed-signin.json' });
    assert.deepEqual([state.status.bootstrap.signInPath.path, state.status.bootstrap.signInPath.source], ['/SignIn', 'observed']);
    const status = JSON.parse(run('mirage', 'status', '--config', config, '--repo', fx.dir, '--json').stdout);
    const listed = status.sessions.find((item) => item.pid === session.pid);
    assert.equal(listed.owned, true);
    assert.equal(listed.ready, true);
    assert.equal(listed.stateFile, session.stateFile);
    assert.equal(listed.adminUrl, session.adminUrl);
    assert.ok(Object.hasOwn(listed, 'project') && Object.hasOwn(listed, 'portal'));
    assert.equal(listed.runtime.liveWrites, 'disabled');
    assert.match(run('mirage', 'status', '--config', config, '--repo', fx.dir).stdout, /live writes disabled/);
  } finally {
    stopped = run('mirage', 'stop', '--config', config, '--repo', fx.dir, '--json');
    assert.equal(stopped.status, 0, stopped.stdout + stopped.stderr);
  }
  const report = JSON.parse(stopped.stdout);
  assert.deepEqual(report.stopped.map((item) => item.pid), [session.pid]);
  assert.equal(report.stopped[0].graceful, true);
  assert.equal(report.remaining.length, 0);
});

test('machine-readable CLI failures reject ignored options and interactive JSON workflows', () => {
  for (const args of [
    ['resources', '--check', '--json'], ['map', '--limit', '10', '--json'], ['list', '--pick', '--json'],
    ['doctor', '--all', '--site', 'sample', '--json'], ['verify', '--headless', '--headed', '--json'], ['agent', 'pages', 'extra'],
  ]) {
    const result = run(...args);
    assert.equal(result.status, 1);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ok, false);
    assert.equal(report.schemaVersion, 1);
    assert.ok(report.error.message);
    assert.equal(result.stderr, '');
  }
  const typo = run('resources', '--unknown-option', '--json');
  assert.equal(JSON.parse(typo.stdout).error.code, 'INVALID_ARGUMENT');
  assert.equal(JSON.parse(run('--help', '--json').stdout).command, 'help');
  assert.equal(JSON.parse(run('agent', '--help').stdout).command, 'help', 'agent commands consistently produce JSON');
});

test('JSON setting discovery includes descriptions and resolved disabled agent access', () => {
  const file = fx.file('agent-catalogue.yml');
  fs.writeFileSync(file, 'agent:\n  enabled: false\nsites:\n  test:\n    source: .\n    environments:\n      dev: https://portal.example\n');
  const result = run('list', '--config', file, '--settings', '--json');
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.inEffect.agent, { enabled: false });
  assert.match(report.supportedSettings.PAQVILO_AGENT, /disable/);
  assert.ok(report.supportedSettings['PAQVILO_<SITE>_SOURCE']);
  assert.ok(report.supportedSettings['PAQVILO_<SITE>_ENV_<NAME>']);
  assert.deepEqual(report.settings, {});
  assert.equal(Object.hasOwn(JSON.parse(run('list', '--config', file, '--json').stdout), 'supportedSettings'), false);
});

test('list exposes configured portal coverage and refuses ambiguous all-mode origins', () => {
  const file = fx.file('coverage-catalogue.yml');
  fs.writeFileSync(file, 'sites:\n  first:\n    source: .\n    environments:\n      dev: https://first.example\n      test: https://first-test.example\n  second:\n    source: .\n    environments:\n      dev: https://second.example\n');
  const selected = JSON.parse(run('list', '--config', file, '--json').stdout);
  assert.equal(selected.inEffect.portals, 'selected');
  assert.equal(selected.coverage.configuredTargetCount, 3);
  assert.equal(selected.coverage.targets.length, 1);
  const all = run('list', '--config', file, '--portals', 'all', '--site', 'second', '--json');
  assert.equal(all.status, 0, all.stderr);
  const report = JSON.parse(all.stdout);
  assert.equal(report.coverage.mode, 'all');
  assert.equal(report.coverage.ready, true);
  assert.equal(report.coverage.targets.length, 3);
  assert.deepEqual(report.coverage.targets.filter((target) => target.initial).map((target) => target.site), ['second']);
  const text = run('list', '--config', file, '--portals', 'all');
  assert.match(text.stdout, /dev coverage: all, 3 target\(s\)/);
  assert.match(text.stdout, /second @ dev\s+https:\/\/second.example/);
  fs.appendFileSync(file, '  duplicate:\n    source: .\n    environments:\n      extra: https://SECOND.example:443/path\n');
  const duplicate = run('list', '--config', file, '--portals', 'all', '--json');
  assert.equal(duplicate.status, 1);
  const invalid = JSON.parse(duplicate.stdout);
  assert.equal(invalid.coverage.ready, false);
  assert.deepEqual(invalid.coverage.targets, []);
  assert.match(invalid.problem, /Duplicate portal origin/);
  assert.equal(run('resources', '--portals', 'all', '--json').status, 1, 'the switch is specific to dev and its list preview');
  const conflict = run('list', '--config', file, '--portals', 'all', '--url', 'https://custom.example', '--json');
  assert.equal(conflict.status, 1);
  assert.match(JSON.parse(conflict.stdout).problem, /portals=all cannot be combined with --url/);
});

test('browser/profile CLI choices are discoverable offline and incompatible commands reject them', () => {
  const file = fx.file('profile-catalogue.yml');
  fs.writeFileSync(file, 'sites:\n  test:\n    source: .\n    environments:\n      dev: https://portal.example\n');
  const named = run('list', '--config', file, '--browser', 'chrome', '--profile', 'Team-Work', '--settings', '--json');
  assert.equal(named.status, 0, named.stderr);
  const report = JSON.parse(named.stdout);
  assert.equal(report.inEffect.browser.channel, 'chrome');
  assert.equal(report.inEffect.browser.profile, 'team-work');
  assert.equal(report.inEffect.browser.profileMode, 'named');
  assert.equal(report.inEffect.browser.userDataDir, null);
  assert.deepEqual(report.inEffect.browser.profileInfo, { kind: 'named', name: 'team-work', channel: 'chrome', userDataDir: path.join(fx.dir, '.paqvilo', 'profiles', 'named', 'chrome', 'team-work'), profileDirectory: 'Default' });
  assert.ok(report.supportedSettings.PAQVILO_PROFILE);
  assert.ok(report.supportedSettings.PAQVILO_USER_DATA_DIR);
  assert.ok(report.supportedSettings.PAQVILO_PROFILE_DIRECTORY);
  const external = run('list', '--config', file, '--user-data-dir', 'test-browser-root', '--profile-directory', 'Profile 1', '--json');
  assert.equal(external.status, 0, external.stderr);
  const externalReport = JSON.parse(external.stdout);
  assert.equal(externalReport.inEffect.browser.profileMode, 'external');
  assert.equal(externalReport.inEffect.browser.userDataDir, path.resolve('test-browser-root'));
  assert.equal(externalReport.inEffect.browser.profileDirectory, 'Profile 1');
  assert.equal(externalReport.inEffect.browser.profileInfo.userDataDir, path.resolve('test-browser-root'));
  const attach = run('list', '--config', file, '--cdp-url', 'http://127.0.0.1:9222', '--json');
  assert.equal(attach.status, 0, attach.stderr);
  assert.equal(JSON.parse(attach.stdout).inEffect.browser.mode, 'attach');
  assert.equal(JSON.parse(attach.stdout).inEffect.browser.profileMode, 'attached');
  assert.deepEqual(JSON.parse(attach.stdout).inEffect.browser.profileInfo, { kind: 'attached', name: null, channel: null, userDataDir: null, profileDirectory: null });
  const conflict = run('list', '--config', file, '--profile', 'work', '--user-data-dir', 'test-browser-root', '--json');
  assert.equal(conflict.status, 1);
  assert.match(JSON.parse(conflict.stdout).problem, /cannot be combined/);
  const doctor = run('doctor', '--config', file, '--browser', 'chromium', '--profile', 'diagnostics', '--json');
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.equal(JSON.parse(doctor.stdout).offline, true);
  for (const args of [['map', '--profile', 'work'], ['resources', '--browser', 'chrome'], ['verify', '--cdp-url', 'http://127.0.0.1:9222'], ['agent', 'sessions', '--user-data-dir', 'test-browser-root']]) {
    const invalid = run(...args, '--json');
    assert.equal(invalid.status, 1);
    assert.match(JSON.parse(invalid.stdout).error.message, /not supported/);
  }
  const invalidDev = run('dev', '--config', file, '--profile', '../escape');
  assert.equal(invalidDev.status, 1);
  assert.match(invalidDev.stderr, /browser.profile/);
  assert.match(run('list', '--config', file, '--profile', 'work').stdout, /named toolkit profile work/);
});

test('verification edits enhanced fields without overwriting other fields or XML metadata', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-source-edit-'));
  try {
    const file = path.join(dir, 'powerpagecomponent.xml');
    fs.writeFileSync(file, '<component><content><![CDATA[{"customjavascript":"old","customcss":"red"}]]></content><name>Keep me</name></component>');
    const source = (field) => ({ file, rel: `component.xml#${field}`, field, extract: (xml) => componentContent(xml)?.[field] ?? null });
    editSource(source('customjavascript'), (text) => text + '\nif (a < b && c > d) {}');
    editSource(source('customcss'), () => 'body {color: blue}');
    const xml = fs.readFileSync(file, 'utf8');
    assert.deepEqual(componentContent(xml), { customjavascript: 'old\nif (a < b && c > d) {}', customcss: 'body {color: blue}' });
    assert.match(xml, /<name>Keep me<\/name>/);
    assert.match(xml, /&lt;/);
    editSource({ path: file, relativePath: 'powerpagecomponent.xml', field: 'customcss' }, () => 'body {color: green}');
    assert.equal(componentContent(fs.readFileSync(file, 'utf8')).customcss, 'body {color: green}');
    assert.match(fs.readFileSync(file, 'utf8'), /<name>Keep me<\/name>/);
    const before = fs.readFileSync(file, 'utf8');
    assert.throws(() => editSource({ path: file }, () => 'would replace XML'), /explicit field/);
    assert.equal(fs.readFileSync(file, 'utf8'), before);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('mirage init writes a validated project file from the catalogue site and refuses silent overwrites', async () => {
  const solutions = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-init-solutions-')));
  try {
    fs.mkdirSync(path.join(solutions, 'Example.Solutions.BaseLayer'));
    fs.mkdirSync(path.join(solutions, 'Example.Solutions.BusinessLayer'));
    const config = fx.file('mirage-init-catalogue.yml');
    fs.writeFileSync(config, [
      'defaultSite: test',
      'sites:',
      '  test:',
      '    source: .',
      '    defaultEnv: dev',
      '    environments:',
      '      prod: { url: https://prod.example.com, caution: true }',
      '      dev: https://portal.example.com',
      '      loopback: http://127.0.0.1:9000',
      '    mirage:',
      `      solutionRoots: [${JSON.stringify(path.join(solutions, 'Example.Solutions.BaseLayer'))}, ${JSON.stringify(path.join(solutions, 'Example.Solutions.BusinessLayer'))}]`,
      '',
    ].join('\n'));
    const out = path.join(solutions, 'projects', 'test.project.yml');
    const first = run('mirage', 'init', '--config', config, '--repo', fx.dir, '--out', out, '--json');
    assert.equal(first.status, 0, first.stdout + first.stderr);
    const report = JSON.parse(first.stdout);
    assert.equal(report.action, 'init');
    assert.equal(report.file, out);
    assert.equal(report.catalogued, false);
    assert.match(report.next, /paqvilo mirage dev --project/);
    assert.ok(report.notes.some((note) => note.includes('loopback')), 'non-HTTPS environments are reported, not recorded');
    const { loadProjectConfig } = await import('../mirage/lib/project-config.mjs');
    const project = await loadProjectConfig(out);
    assert.equal(project.defaultPortal, 'test');
    assert.equal(project.portals.length, 1);
    assert.equal(project.portals[0].sourceDir, fs.realpathSync.native(fx.dir));
    assert.equal(project.portals[0].origin, 'https://portal.example.com');
    assert.deepEqual(project.solutionRoots, ['Example.Solutions.BaseLayer', 'Example.Solutions.BusinessLayer'].map((name) => path.join(solutions, name)), 'catalogue order is the load order');
    assert.deepEqual(project.references.map((item) => item.id), ['dev', 'prod'], 'the selected environment comes first');
    assert.match(project.references[1].name, /real data/);
    const text = fs.readFileSync(out, 'utf8');
    assert.ok(text.includes('path: ../Example.Solutions.BaseLayer'), 'nearby sources are written relative to the project file');
    assert.ok(!text.includes(solutions.split(path.sep).join('/')), 'no absolute path for nearby sources');
    const again = run('mirage', 'init', '--config', config, '--repo', fx.dir, '--out', out, '--json');
    assert.equal(again.status, 1);
    assert.match(JSON.parse(again.stdout).error.message, /already exists.*--force/);
    const forced = run('mirage', 'init', '--config', config, '--repo', fx.dir, '--out', out, '--force', '--json');
    assert.equal(forced.status, 0, forced.stdout + forced.stderr);
    const misplaced = run('mirage', 'status', '--config', config, '--repo', fx.dir, '--out', out, '--json');
    assert.equal(misplaced.status, 1);
    assert.match(JSON.parse(misplaced.stdout).error.message, /only to mirage init/);
    const missing = path.join(solutions, 'missing.project.yml');
    fs.appendFileSync(config, `      project: ${JSON.stringify(missing)}\n`);
    const unavailable = run('mirage', 'start', '--config', config, '--repo', fx.dir, '--port', '0', '--json');
    assert.equal(unavailable.status, 1);
    assert.match(JSON.parse(unavailable.stdout).error.message, /missing\.project\.yml, which does not exist.*paqvilo mirage init/);
    const catalogued = run('mirage', 'init', '--config', config, '--repo', fx.dir, '--json');
    assert.equal(catalogued.status, 0, catalogued.stdout + catalogued.stderr);
    assert.equal(JSON.parse(catalogued.stdout).file, missing, 'without --out the catalogued project path is written');
    assert.equal(JSON.parse(catalogued.stdout).catalogued, true);
    assert.equal((await loadProjectConfig(missing)).portals[0].id, 'test');
  } finally { fs.rmSync(solutions, { recursive: true, force: true }); }
});

test('list and doctor expose catalogue Mirage settings and offline readiness without changing overlay readiness', () => {
  const roots = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-mirage-roots-')));
  try {
    fs.mkdirSync(path.join(roots, 'Base'));
    const config = fx.file('mirage-settings-catalogue.yml');
    fs.writeFileSync(config, [
      'defaultSite: test',
      'defaults:',
      '  mirage: { port: 0 }',
      'sites:',
      '  test:',
      '    source: .',
      '    environments:',
      '      dev: https://portal.example.com',
      '    mirage:',
      `      solutionRoots: [${JSON.stringify(path.join(roots, 'Base'))}]`,
      '      preset: open-sandbox',
      '  broken:',
      '    source: .',
      '    environments:',
      '      dev: https://broken.example.com',
      '    mirage:',
      `      solutionRoots: [${JSON.stringify(path.join(roots, 'Missing'))}]`,
      '',
    ].join('\n'));
    const listed = run('list', '--config', config, '--repo', fx.dir, '--json');
    assert.equal(listed.status, 0, listed.stdout + listed.stderr);
    const list = JSON.parse(listed.stdout);
    const site = list.sites.find((item) => item.name === 'test');
    assert.deepEqual(site.mirage.configured, { port: 0, solutionRoots: [path.join(roots, 'Base')], preset: 'open-sandbox' });
    assert.deepEqual(site.mirage.resolved, { project: null, solutionRoots: [path.join(roots, 'Base')], solutionOrder: 'derived', dataPacks: [], port: 0, preset: 'open-sandbox', observed: null });
    assert.deepEqual(list.inEffect.mirage, site.mirage.resolved);
    assert.match(run('list', '--config', config, '--repo', fx.dir).stdout, /mirage: 1 Solution root\(s\), preset open-sandbox/);
    const doctor = run('doctor', '--config', config, '--repo', fx.dir, '--all', '--json');
    assert.equal(doctor.status, 0, doctor.stdout + doctor.stderr);
    const reports = JSON.parse(doctor.stdout).reports;
    const ready = reports.find((item) => item.site === 'test').mirage;
    assert.equal(ready.ready, true, JSON.stringify(ready));
    assert.equal(ready.dependencies.ready, true);
    assert.equal(ready.project.configured, false);
    assert.deepEqual(ready.solutionRoots, { source: 'catalogue', order: 'derived', roots: [{ path: path.join(roots, 'Base'), exists: true }] });
    assert.equal(ready.stateDir.writable, true);
    assert.deepEqual(ready.port, { port: 0, available: true });
    const broken = reports.find((item) => item.site === 'broken');
    assert.equal(broken.ready, true, 'Mirage readiness is reported beside the overlay verdict');
    assert.equal(broken.mirage.ready, false);
    assert.ok(broken.mirage.errors.some((error) => /Solution root does not exist/.test(error)));
    assert.match(run('doctor', '--config', config, '--repo', fx.dir, '--site', 'broken').stdout, /mirage NOT READY[\s\S]*MIRAGE ERROR: Mirage Solution root does not exist/);
  } finally { fs.rmSync(roots, { recursive: true, force: true }); }
});

test('mirage stop ends owned starting processes, prunes stale records and never touches other programs', async (t) => {
  const { stopOwnedSessions, mirageStatus, ownedSessions, processIdentity, isAlive } = await import('../lense/commands/mirage.mjs');
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-mirage-owned-')));
  const paths = { discoveryRoot: path.join(root, 'simulator'), ownershipFile: path.join(root, 'mirage', 'sessions.json'), logRoot: path.join(root, 'logs') };
  fs.mkdirSync(paths.discoveryRoot, { recursive: true });
  fs.mkdirSync(path.dirname(paths.ownershipFile), { recursive: true });
  const idle = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  const starting = idle(), unrelated = idle(), finished = idle();
  t.after(() => {
    for (const child of [starting, unrelated, finished]) { try { child.kill(); } catch { /* exited */ } }
    fs.rmSync(root, { recursive: true, force: true });
  });
  await Promise.all([starting, unrelated, finished].map((child) => once(child, 'spawn')));
  finished.kill();
  await once(finished, 'exit');
  const sourceDir = path.join(root, 'portal');
  const discovery = (pid) => path.join(paths.discoveryRoot, `session-${pid}.json`);
  fs.writeFileSync(paths.ownershipFile, JSON.stringify({ version: 1, sessions: [
    { pid: starting.pid, processIdentity: processIdentity(starting.pid), sourceDir, discovery: discovery(starting.pid), url: null, ready: false },
    { pid: finished.pid, processIdentity: 'start-time-of-an-exited-mirage', sourceDir, discovery: discovery(finished.pid), url: 'http://127.0.0.1:9/', ready: true },
    { pid: unrelated.pid, processIdentity: 'start-time-of-an-earlier-process-with-this-pid', sourceDir, discovery: discovery(unrelated.pid), url: 'http://127.0.0.1:9/', ready: true },
  ] }));
  const status = await mirageStatus(paths);
  assert.deepEqual(status.map((item) => [item.pid, item.starting, item.owned]), [[starting.pid, true, true]], 'an owned process that has not announced itself is listed as starting');
  fs.writeFileSync(discovery(finished.pid), JSON.stringify({ pid: finished.pid, url: 'http://127.0.0.1:9/', sourceDir }));
  fs.writeFileSync(discovery(unrelated.pid), JSON.stringify({ pid: unrelated.pid, url: 'http://127.0.0.1:9/', sourceDir }));
  const report = await stopOwnedSessions({ paths, sourceDir, deadline: 5000 });
  assert.deepEqual(report.stopped.map((item) => [item.pid, item.graceful, item.wasReady]), [[starting.pid, false, false]]);
  assert.deepEqual(report.remaining, []);
  assert.deepEqual(report.pruned.map((item) => item.pid).sort((a, b) => a - b), [finished.pid, unrelated.pid].sort((a, b) => a - b));
  // Windows may reuse the exited PID for one of the concurrent process probes.
  assert.match(report.pruned.find((item) => item.pid === finished.pid).reason, /exited|another program/);
  assert.match(report.pruned.find((item) => item.pid === unrelated.pid).reason, /another program/);
  assert.equal(isAlive(starting.pid), false);
  assert.equal(isAlive(unrelated.pid), true, 'a reused PID belongs to another program and is never signalled');
  assert.equal(fs.existsSync(discovery(finished.pid)), false, 'discovery files of exited processes are removed');
  assert.equal(fs.existsSync(discovery(unrelated.pid)), true, 'a live process keeps its discovery file');
  assert.deepEqual(await ownedSessions(paths), []);
  const repeated = await stopOwnedSessions({ paths, pids: [unrelated.pid] });
  assert.deepEqual([repeated.stopped, repeated.pruned, repeated.remaining], [[], [], []]);
  assert.equal(isAlive(unrelated.pid), true);
});

test('mirage start refuses a port held by another program before spawning anything', async (t) => {
  const { createServer } = await import('node:net');
  const blocker = createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => blocker.close(resolve)));
  const config = fx.file('mirage-port-catalogue.yml');
  fs.writeFileSync(config, `defaultSite: test\nsites:\n  test:\n    source: .\n    environments:\n      dev: https://portal.example.com\n    mirage:\n      port: ${blocker.address().port}\n`);
  const busy = run('mirage', 'start', '--config', config, '--repo', fx.dir, '--json');
  assert.equal(busy.status, 1);
  assert.match(JSON.parse(busy.stdout).error.message, new RegExp(`Port ${blocker.address().port} is already in use.*--port 0`));
});
