import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createFixture } from './fixture.mjs';
import { miragePaths, stopOwnedSessions, processIdentity } from '../lense/commands/mirage.mjs';
import { persistCommandPayload } from '../lense/command-payload.mjs';
import { listenerPort } from '../lense/stop-command.mjs';
import { standaloneMirageConfiguration } from '../lense/standalone-mirage.mjs';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/paqvilo.mjs', import.meta.url));
async function availablePair() {
  for (let attempt = 0; attempt < 10; attempt++) {
    const servers = [net.createServer(), net.createServer()];
    try {
      const listen = (server, port) =>
        new Promise((resolve, reject) => {
          server.once('error', reject);
          server.listen(port, '127.0.0.1', resolve);
        });
      // Stay below the OS ephemeral range: concurrent fixture listeners should
      // not consume the second planned port immediately after these probes close.
      await listen(servers[0], 20000 + Math.floor(Math.random() * 10000));
      const base = servers[0].address().port;
      if (base === 65535) continue;
      await listen(servers[1], base + 1);
      return base;
    } catch (error) {
      if (error.code !== 'EADDRINUSE') throw error;
    } finally {
      await Promise.all(
        servers.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))),
      );
    }
  }
  throw new Error('The loopback fixture could not reserve consecutive ports.');
}
async function workspace(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-stop-scope-'));
  const fixture = createFixture();
  const tracked = [];
  t.after(async () => {
    for (const item of tracked) {
      const stopped = await stopOwnedSessions({ paths: item.paths, pids: item.pids });
      assert.deepEqual(stopped.remaining, []);
    }
    fixture.cleanup();
    await fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });
  const defaults = path.join(directory, 'default checkout');
  const alternate = path.join(directory, 'alternate checkout');
  await fs.cp(fixture.dir, path.join(defaults, 'portal'), { recursive: true });
  await fs.cp(fixture.dir, path.join(alternate, 'portal'), { recursive: true });
  const cwd = path.join(directory, 'copy hint here');
  await fs.mkdir(cwd);
  const shim = path.join(cwd, 'npx-shim.mjs');
  const preload = path.join(cwd, 'collect-cli.mjs');
  await fs.writeFile(
    preload,
    'if(process.argv[1]===process.env.PAQ_REAL_CLI){console.log(JSON.stringify(process.argv.slice(2)));process.exit(0)}',
  );
  await fs.writeFile(
    shim,
    "import assert from 'node:assert/strict';import {execFileSync} from 'node:child_process';assert.equal(process.argv[2],'paqvilo');const args=process.argv.slice(3);if(process.env.PAQ_CAPTURE_HINT)console.log(JSON.stringify(args));else execFileSync(process.execPath,[process.env.PAQ_REAL_CLI,...args],{stdio:'inherit'});",
  );
  if (process.platform === 'win32') await fs.writeFile(path.join(cwd, 'npx.cmd'), '@node "%PAQ_NPX_SHIM%" %*\r\n');
  else {
    await fs.writeFile(path.join(cwd, 'npx'), '#!/bin/sh\nexec node "$PAQ_NPX_SHIM" "$@"\n');
    await fs.chmod(path.join(cwd, 'npx'), 0o755);
  }
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^(?:PAQVILO_|GIT_)/.test(key)),
  );
  const run = async (args, extraEnvironment = {}, from = cwd) => {
    try {
      return {
        status: 0,
        ...(await execute(process.execPath, [cli, ...args], {
          cwd: from,
          env: { ...environment, ...extraEnvironment },
          windowsHide: true,
          timeout: 120000,
        })),
      };
    } catch (error) {
      if (typeof error.code !== 'number') throw error;
      return { status: error.code, stdout: error.stdout, stderr: error.stderr };
    }
  };
  const start = async (args) => {
    const result = await run(['mirage', 'start', ...args, '--json']);
    const report = JSON.parse(result.stdout);
    const config = args.includes('--config') ? args[args.indexOf('--config') + 1] : null;
    const project = args.includes('--project') ? args[args.indexOf('--project') + 1] : null;
    const standaloneOverride =
      project && config && args.includes('--runtime') && args[args.indexOf('--runtime') + 1] !== 'power-pages';
    const stateDir = path.join(
      standaloneOverride ? cwd : config ? path.dirname(config) : project ? path.dirname(project) : cwd,
      '.paqvilo',
    );
    tracked.push({
      paths: miragePaths({ stateDir }),
      pids: (report.portals ?? [report]).filter((item) => item.pid).map((item) => item.pid),
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return report;
  };
  const writeCatalogue = async (file, { all = false, project, port = 0 } = {}) => {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        sourceRoot: defaults,
        defaultSite: 'first',
        portals: all ? 'all' : 'selected',
        sites: Object.fromEntries(
          (all ? ['first', 'second'] : ['first']).map((id) => [
            id,
            {
              source: 'portal',
              environments: { dev: 'https://invented.example.invalid' },
              mirage: { solutionRoots: [], port, ...(project ? { project } : {}) },
            },
          ]),
        ),
      }),
    );
  };
  const replay = async (hint, capture = false, from = cwd) => {
    const shell = process.platform === 'win32' ? 'powershell.exe' : '/bin/sh';
    const args = process.platform === 'win32' ? ['-NoProfile', '-NonInteractive', '-Command', hint] : ['-c', hint];
    return execute(shell, args, {
      cwd: from,
      windowsHide: true,
      timeout: 120000,
      env: {
        ...environment,
        PATH: cwd + path.delimiter + process.env.PATH,
        PAQ_REAL_CLI: cli,
        PAQ_NPX_SHIM: shim,
        ...(capture
          ? {
              PAQ_CAPTURE_HINT: '1',
              NODE_OPTIONS: ((environment.NODE_OPTIONS ?? '') + ' --import=' + pathToFileURL(preload).href).trim(),
            }
          : {}),
      },
    });
  };
  return { directory, cwd, alternate, defaults, run, start, writeCatalogue, replay, tracked };
}
function fixtureStatusURL(session) {
  let address;
  try {
    address = new URL(session.url);
  } catch {
    throw new Error('Expected an owned HTTP loopback runtime address.');
  }
  const port = Number(address.port || 80);
  if (
    address.protocol !== 'http:' ||
    address.hostname !== '127.0.0.1' ||
    address.username ||
    address.password ||
    address.pathname !== '/' ||
    address.search ||
    address.hash ||
    !/^http:\/\/127\.0\.0\.1(?::[1-9]\d{0,4})?\/?$/.test(session.url) ||
    !Number.isSafeInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error('Expected an owned HTTP loopback runtime address.');
  // Only the validated numeric listener port crosses this boundary. Neither
  // a record's URL nor any file content becomes a request host/path/header.
  return `http://127.0.0.1:${port}/_sim/api/status`;
}
const requestStatus = (session) =>
  fetch(fixtureStatusURL(session), { redirect: 'error', signal: AbortSignal.timeout(5000) });
const alive = async (session) => assert.equal((await requestStatus(session)).status, 200);
const stopped = (session) => assert.rejects(requestStatus(session), /fetch failed/);
const portalProject = (sourceDir) => ({
  version: 2,
  defaultPortal: 'first',
  portals: ['first', 'second'].map((id) => ({ id, path: sourceDir })),
  solutions: [],
});

test('owned status probes admit only a numeric port on the fixed HTTP loopback endpoint', () => {
  assert.equal(fixtureStatusURL({ url: 'http://127.0.0.1:12345' }), 'http://127.0.0.1:12345/_sim/api/status');
  assert.equal(fixtureStatusURL({ url: 'http://127.0.0.1:80/' }), 'http://127.0.0.1:80/_sim/api/status');
  for (const url of [
    'https://127.0.0.1:12345',
    'http://invented.example.invalid:12345',
    'http://127.0.0.1.invented.invalid:12345',
    'http://localhost:12345',
    'http://[::1]:12345',
    'http://2130706433:12345',
    'http://user:secret@127.0.0.1:12345',
    'http://127.0.0.1:12345/other',
    'http://127.0.0.1:12345/?value=invented',
    'http://127.0.0.1:12345/#fragment',
    'http://127.0.0.1:12345/?',
    'http://127.0.0.1:12345/#',
    'http://127.0.0.1:0',
    'http://127.0.0.1:65536',
    'http://127.0.0.1:00123',
    'http://127.0.0.1:12345\\',
    'http://127.0.0.1:12345\n',
    'file:///invented',
  ])
    assert.throws(() => fixtureStatusURL({ url }), /owned HTTP loopback runtime address/);
});

test('standalone settings-only catalogues keep editor settings without claiming a site, and invalid selected sites fail', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-settings-only-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = path.join(directory, 'settings.json');
  await fs.writeFile(config, JSON.stringify({ editor: 'code --profile Invented', sites: {} }));
  const cfg = standaloneMirageConfiguration(null, { config, runtime: 'model-driven' });
  assert.equal(cfg.editor, process.env.PAQVILO_EDITOR ?? 'code --profile Invented');
  assert.equal(cfg.catalogueScope, null);
  assert.equal(cfg.stateDir, path.join(process.cwd(), '.paqvilo'));
  assert.throws(
    () => standaloneMirageConfiguration(null, { config, runtime: 'model-driven', site: 'missing' }),
    /Unknown Mirage configuration 'missing'/,
  );
  await fs.writeFile(
    config,
    JSON.stringify({ defaultSite: 'missing', sites: { first: { mirage: { runtime: { kind: 'model-driven' } } } } }),
  );
  assert.throws(
    () => standaloneMirageConfiguration(null, { config, runtime: 'model-driven' }),
    /Unknown Mirage configuration/,
  );
});

test(
  'project stop hints survive valid path remaps, portal renames and removals without selecting a same-source sibling',
  { timeout: 120000 },
  async (t) => {
    const work = await workspace(t);
    const config = path.join(work.directory, 'catalogue controls', 'selected.json');
    const other = path.join(path.dirname(config), 'unrelated.json');
    const project = path.join(work.directory, 'external projects', 'editable.json');
    const elsewhere = path.join(work.directory, 'replay edited project here');
    await fs.mkdir(path.dirname(project), { recursive: true });
    await fs.mkdir(elsewhere);
    await work.writeCatalogue(config);
    await work.writeCatalogue(other);
    const before = portalProject(path.join(work.alternate, 'portal'));
    await fs.writeFile(project, JSON.stringify(before));
    const sibling = await work.start([
      '--config',
      other,
      '--project',
      project,
      '--portal',
      'first',
      '--state',
      path.join(work.directory, 'unrelated state.json'),
      '--port',
      '0',
    ]);
    for (const edit of ['path-remap', 'portal-rename', 'portal-remove']) {
      await fs.writeFile(project, JSON.stringify(before));
      const selected = await work.start([
        '--config',
        config,
        '--project',
        project,
        '--portal',
        'first',
        '--state',
        path.join(work.directory, edit + '.json'),
        '--port',
        '0',
      ]);
      const after = structuredClone(before);
      if (edit === 'path-remap') after.portals[0].path = path.join(work.defaults, 'portal');
      else if (edit === 'portal-rename') {
        after.portals[0].id = 'renamed';
        after.defaultPortal = 'renamed';
      } else {
        after.portals.shift();
        after.defaultPortal = 'second';
      }
      await fs.writeFile(project, JSON.stringify(after));
      await work.replay(selected.stop, false, elsewhere);
      await stopped(selected);
      await alive(sibling);
    }
    for (const action of ['start', 'dev', 'inspect']) {
      const refused = await work.run([
        'mirage',
        action,
        '--config',
        config,
        '--project',
        project,
        '--portal',
        'first',
        '--port',
        '0',
        ...(action === 'dev' ? [] : ['--json']),
      ]);
      assert.equal(refused.status, 1, refused.stdout + refused.stderr);
      assert.match(
        refused.stdout + refused.stderr,
        /Unknown Mirage portal \\?"first\\?"|Portal 'first' is not configured/,
      );
    }
  },
);

test(
  'unqualified project stop includes recorded portals absent from current multi- and single-portal mappings',
  { timeout: 90000 },
  async (t) => {
    const work = await workspace(t);
    const config = path.join(work.directory, 'catalogue controls', 'selected.json');
    const other = path.join(path.dirname(config), 'unrelated.json');
    const project = path.join(work.directory, 'external projects', 'editable.json');
    await fs.mkdir(path.dirname(project), { recursive: true });
    await work.writeCatalogue(config);
    await work.writeCatalogue(other);
    const before = portalProject(path.join(work.alternate, 'portal'));
    await fs.writeFile(project, JSON.stringify(before));
    const sibling = await work.start(['--config', other, '--project', project, '--portal', 'first', '--port', '0']);
    for (const count of [2, 1]) {
      await fs.writeFile(project, JSON.stringify(before));
      const group = await work.start(['--config', config, '--project', project, '--port', '0']);
      await fs.writeFile(
        project,
        JSON.stringify({
          ...before,
          defaultPortal: 'replacement',
          portals: Array.from({ length: count }, (_, index) => ({
            id: index ? 'another' : 'replacement',
            path: path.join(work.defaults, 'portal'),
          })),
        }),
      );
      const report = await work.run(['mirage', 'stop', '--config', config, '--project', project, '--json']);
      assert.equal(report.status, 0, report.stdout + report.stderr);
      assert.deepEqual(
        JSON.parse(report.stdout)
          .stopped.map(({ pid }) => pid)
          .sort(),
        group.portals.map(({ pid }) => pid).sort(),
      );
      for (const session of group.portals) await stopped(session);
      await alive(sibling);
    }
  },
);

test(
  'catalogue site/portal ID collisions never broaden project stop and ambiguous legacy records require exact selectors',
  { timeout: 120000 },
  async (t) => {
    const work = await workspace(t);
    const config = path.join(work.directory, 'catalogue controls', 'shared.json');
    const project = path.join(work.directory, 'external projects', 'shared.json');
    await fs.mkdir(path.dirname(project), { recursive: true });
    await fs.writeFile(
      project,
      JSON.stringify({
        version: 2,
        defaultPortal: 'first',
        portals: ['first', 'second'].map((id) => ({ id, path: path.join(work.alternate, 'portal') })),
        solutions: [],
      }),
    );
    await work.writeCatalogue(config, { all: true, project });
    const catalogue = JSON.parse(await fs.readFile(config, 'utf8'));
    catalogue.portals = 'selected';
    await fs.writeFile(config, JSON.stringify(catalogue));
    const firstArgs = ['--config', config, '--site', 'first', '--project', project, '--portal', 'first', '--port', '0'];
    const secondArgs = [
      '--config',
      config,
      '--site',
      'second',
      '--project',
      project,
      '--portal',
      'second',
      '--port',
      '0',
    ];
    const first = await work.start(firstArgs);
    const second = await work.start(secondArgs);
    const reused = await work.start(firstArgs);
    assert.equal(reused.pid, first.pid);
    assert.equal(reused.started, false);
    const broadArgs = ['mirage', 'stop', '--config', config, '--site', 'first', '--project', project, '--json'];
    const wrongSite = await work.run([
      ...broadArgs,
      '--portal',
      'second',
      '--state',
      second.stateFile,
      '--port',
      listenerPort(second.url),
    ]);
    assert.equal(wrongSite.status, 0, wrongSite.stdout + wrongSite.stderr);
    assert.deepEqual(
      JSON.parse(wrongSite.stdout).stopped,
      [],
      'exact selectors never bypass a marked catalogue-site mismatch',
    );
    await alive(second);
    const modern = await work.run(broadArgs);
    assert.equal(modern.status, 0, modern.stdout + modern.stderr);
    assert.deepEqual(
      JSON.parse(modern.stdout).stopped.map(({ pid }) => pid),
      [first.pid],
    );
    await alive(second);
    const restarted = await work.start(firstArgs);
    const paths = miragePaths({ stateDir: path.join(path.dirname(config), '.paqvilo') });
    const records = JSON.parse(await fs.readFile(paths.ownershipFile, 'utf8'));
    for (const entry of records.sessions) {
      delete entry.identity.scope.version;
      delete entry.identity.scope.catalogueSite;
    }
    await fs.writeFile(paths.ownershipFile, JSON.stringify(records));
    const modernAfterLegacy = await work.start(firstArgs);
    assert.notEqual(modernAfterLegacy.pid, restarted.pid, 'markerless scope cannot satisfy the new identity for reuse');
    assert.equal(modernAfterLegacy.started, true);
    const ambiguous = await work.run(broadArgs);
    assert.equal(ambiguous.status, 1, ambiguous.stdout + ambiguous.stderr);
    assert.match(JSON.parse(ambiguous.stdout).error.message, /legacy.*ownership.*ambiguous/i);
    const requestedZero = await work.run([...broadArgs, '--state', restarted.stateFile, '--port', '0']);
    assert.equal(requestedZero.status, 1, requestedZero.stdout + requestedZero.stderr);
    assert.match(JSON.parse(requestedZero.stdout).error.message, /legacy.*ownership.*ambiguous/i);
    await alive(restarted);
    await alive(modernAfterLegacy);
    await alive(second);
    await work.replay(restarted.stop);
    await stopped(restarted);
    await work.replay(modernAfterLegacy.stop);
    await stopped(modernAfterLegacy);
    await alive(second);
    const oneSite = structuredClone(catalogue);
    delete oneSite.sites.first;
    oneSite.defaultSite = 'second';
    await fs.writeFile(config, JSON.stringify(oneSite));
    const unambiguous = await work.run([
      'mirage',
      'stop',
      '--config',
      config,
      '--site',
      'second',
      '--project',
      project,
      '--json',
    ]);
    assert.equal(unambiguous.status, 0, unambiguous.stdout + unambiguous.stderr);
    assert.deepEqual(
      JSON.parse(unambiguous.stdout).stopped.map(({ pid }) => pid),
      [second.pid],
    );
    const overridden = structuredClone(catalogue);
    delete overridden.sites.second.mirage.project;
    await fs.writeFile(config, JSON.stringify(overridden));
    const override = await work.start([
      '--config',
      config,
      '--site',
      'second',
      '--project',
      project,
      '--portal',
      'first',
      '--port',
      '0',
    ]);
    const overriddenRecords = JSON.parse(await fs.readFile(paths.ownershipFile, 'utf8'));
    const legacyOverride = overriddenRecords.sessions.find(({ pid }) => pid === override.pid);
    delete legacyOverride.identity.scope.version;
    delete legacyOverride.identity.scope.catalogueSite;
    legacyOverride.identity.scope.siteName = 'first';
    await fs.writeFile(paths.ownershipFile, JSON.stringify(overriddenRecords));
    const stillAmbiguous = await work.run(broadArgs);
    assert.equal(stillAmbiguous.status, 1, stillAmbiguous.stdout + stillAmbiguous.stderr);
    assert.match(JSON.parse(stillAmbiguous.stdout).error.message, /legacy.*ownership.*ambiguous/i);
    await alive(override);
    await work.replay(override.stop);
    await stopped(override);
  },
);

test(
  'standalone catalogue scope survives inferred/explicit runtime dispatch independently of its ownership store',
  { timeout: 120000 },
  async (t) => {
    const work = await workspace(t);
    const config = path.join(work.directory, 'catalogue controls', 'shared.json');
    const project = path.join(work.directory, 'external projects', 'standalone.json');
    await fs.mkdir(path.dirname(project), { recursive: true });
    await fs.writeFile(project, JSON.stringify({ version: 2, runtime: { kind: 'model-driven' }, solutions: [] }));
    await work.writeCatalogue(config, { all: true, project });
    const catalogue = JSON.parse(await fs.readFile(config, 'utf8'));
    catalogue.portals = 'selected';
    await fs.writeFile(config, JSON.stringify(catalogue));
    const elsewhere = path.join(work.directory, 'different hint cwd');
    await fs.mkdir(elsewhere);
    for (const runtime of [[], ['--runtime', 'model-driven']]) {
      const first = await work.start([
        '--config',
        config,
        '--site',
        'first',
        '--project',
        project,
        ...runtime,
        '--port',
        '0',
      ]);
      const second = await work.start([
        '--config',
        config,
        '--site',
        'second',
        '--project',
        project,
        ...runtime,
        '--port',
        '0',
      ]);
      const ownershipCwd = runtime.length ? work.cwd : path.dirname(config);
      const stop = [
        'mirage',
        'stop',
        '--config',
        config,
        '--site',
        'first',
        '--project',
        project,
        '--runtime',
        'model-driven',
        '--json',
      ];
      const wrong = await work.run(
        [...stop, '--state', second.stateFile, '--port', listenerPort(second.url)],
        {},
        ownershipCwd,
      );
      assert.equal(wrong.status, 0, wrong.stdout + wrong.stderr);
      assert.deepEqual(JSON.parse(wrong.stdout).stopped, []);
      await alive(first);
      await alive(second);
      const broad = await work.run(stop, {}, ownershipCwd);
      assert.equal(broad.status, 0, broad.stdout + broad.stderr);
      assert.deepEqual(
        JSON.parse(broad.stdout).stopped.map(({ pid }) => pid),
        [first.pid],
      );
      await stopped(first);
      await alive(second);
      await work.replay(second.stop, false, elsewhere);
      await stopped(second);
    }
    const invalid = await work.run([
      'mirage',
      'start',
      '--config',
      config,
      '--site',
      'not-configured',
      '--project',
      project,
      '--runtime',
      'model-driven',
      '--port',
      '0',
      '--json',
    ]);
    assert.equal(invalid.status, 1, invalid.stdout + invalid.stderr);
    assert.match(JSON.parse(invalid.stdout).error.message, /Unknown Mirage configuration 'not-configured'/);
  },
);

test(
  'multi-project hints retain separate catalogue/project ownership and never stop an unrelated same-source catalogue',
  { timeout: 120000 },
  async (t) => {
    const work = await workspace(t);
    const config = path.join(work.directory, 'catalogue controls', 'custom.json');
    const other = path.join(path.dirname(config), 'unrelated.json');
    const project = path.join(work.directory, 'external projects', 'workspace.json');
    await fs.mkdir(path.dirname(project), { recursive: true });
    await fs.writeFile(
      project,
      JSON.stringify({
        version: 2,
        defaultPortal: 'first',
        portals: ['first', 'second'].map((id) => ({ id, path: path.join(work.alternate, 'portal') })),
        solutions: [],
      }),
    );
    await work.writeCatalogue(config);
    await work.writeCatalogue(other);
    const sibling = await work.start(['--config', other, '--repo', work.alternate, '--port', '0']);
    const base = String(await availablePair());
    const selected = await work.start(['--config', config, '--project', project, '--port', base]);
    assert.equal(selected.portals.length, 2);
    const human = await work.run(['mirage', 'start', '--config', config, '--project', project, '--port', base]);
    assert.equal(human.status, 0, human.stderr);
    const humanHint = /^Stop:\s+(.+)$/m.exec(human.stdout)?.[1];
    assert.equal(humanHint, selected.stop, 'human and JSON output advertise the same exact targets');
    await work.replay(humanHint);
    for (const session of selected.portals) await stopped(session);
    await alive(sibling);
    const projectOnly = await work.start(['--project', project, '--port', '0']);
    await work.replay(projectOnly.stop);
    for (const session of projectOnly.portals) await stopped(session);
    await alive(sibling);
    const manualGroup = await work.start(['--config', config, '--project', project, '--port', base]);
    const edited = JSON.parse(await fs.readFile(config, 'utf8'));
    edited.sites.first.mirage.port = Number(base) + 4;
    await fs.writeFile(config, JSON.stringify(edited));
    const explicitRange = await work.run([
      'mirage',
      'stop',
      '--config',
      config,
      '--project',
      project,
      '--port',
      base,
      '--json',
    ]);
    assert.equal(explicitRange.status, 0, explicitRange.stdout + explicitRange.stderr);
    assert.deepEqual(
      JSON.parse(explicitRange.stdout)
        .stopped.map((item) => item.pid)
        .sort(),
      manualGroup.portals.map((item) => item.pid).sort(),
    );
    for (const session of manualGroup.portals) await stopped(session);
    await alive(sibling);
  },
);

test(
  'catalogue-all exact batch retains selected state/port override and init next retains custom catalogue/checkout',
  { timeout: 120000 },
  async (t) => {
    const work = await workspace(t);
    const config = path.join(work.directory, 'catalogue controls', 'custom.json');
    const other = path.join(path.dirname(config), 'unrelated.json');
    await work.writeCatalogue(config, { all: true });
    await work.writeCatalogue(other);
    const sibling = await work.start(['--config', other, '--repo', work.alternate, '--port', '0']);
    const init = await work.run(['mirage', 'init', '--config', config, '--repo', work.alternate, '--json']);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const nextArgs = JSON.parse((await work.replay(JSON.parse(init.stdout).next, true)).stdout);
    assert.ok(nextArgs.includes(config) && nextArgs.includes(work.alternate));
    assert.deepEqual(nextArgs.slice(-2), ['--portals', 'all']);
    const selected = await work.start([
      '--config',
      config,
      '--repo',
      work.alternate,
      '--state',
      path.join(work.directory, 'selected override.json'),
      '--port',
      '0',
    ]);
    const human = await work.run([
      'mirage',
      'start',
      '--config',
      config,
      '--repo',
      work.alternate,
      '--state',
      path.join(work.directory, 'selected override.json'),
      '--port',
      '0',
    ]);
    assert.equal(human.status, 0, human.stderr);
    assert.equal(/^Stop:\s+(.+)$/m.exec(human.stdout)?.[1], selected.stop);
    await work.replay(selected.stop);
    for (const session of selected.portals) await stopped(session);
    await alive(sibling);
  },
);

test(
  'single Power Pages hints retain repo and intersect assigned port/state after configuration edits',
  { timeout: 120000 },
  async (t) => {
    const work = await workspace(t);
    const config = path.join(work.directory, 'catalogue controls', 'custom.json');
    await work.writeCatalogue(config);
    const state = path.join(work.directory, 'shared state.json');
    const first = await work.start(['--config', config, '--repo', work.alternate, '--state', state, '--port', '0']);
    const document = JSON.parse(await fs.readFile(config, 'utf8'));
    document.sites.first.mirage.sourceMaps = false;
    document.sites.first.mirage.port = 65530;
    await fs.writeFile(config, JSON.stringify(document));
    const sameState = await work.start(['--config', config, '--repo', work.alternate, '--state', state, '--port', '0']);
    const otherState = await work.start([
      '--config',
      config,
      '--repo',
      work.alternate,
      '--state',
      path.join(work.directory, 'other state.json'),
      '--port',
      '0',
    ]);
    await work.replay(first.stop);
    await stopped(first);
    await alive(sameState);
    await alive(otherState);
    const broad = await work.run([
      'mirage',
      'stop',
      '--config',
      config,
      '--repo',
      work.alternate,
      '--site',
      'first',
      '--json',
    ]);
    assert.equal(broad.status, 0, broad.stdout + broad.stderr);
    assert.deepEqual(
      JSON.parse(broad.stdout)
        .stopped.map((item) => item.pid)
        .sort(),
      [sameState.pid, otherState.pid].sort(),
    );
  },
);

test('listener selectors normalize default ports without binding privileged listeners', () => {
  assert.equal(listenerPort('http://127.0.0.1:80'), '80');
  assert.equal(listenerPort('https://localhost:443'), '443');
  assert.equal(listenerPort('http://127.0.0.1:1234'), '1234');
  assert.equal(listenerPort(null), undefined);
});

test(
  'hint preparation failure stops newly started single/group sessions and preserves a reused sibling',
  { timeout: 90000 },
  async (t) => {
    const work = await workspace(t);
    const config = path.join(work.directory, 'catalogue', 'custom.json');
    await work.writeCatalogue(config, { all: true });
    const existing = await work.start(['--config', config, '--site', 'first', '--portals', 'selected']);
    const paths = miragePaths({ stateDir: path.join(path.dirname(config), '.paqvilo') });
    const captured = path.join(work.directory, 'failed-hint-sessions.json');
    const hooks = path.join(work.directory, 'hint-failure.mjs');
    const formatter = pathToFileURL(path.resolve('lense/stop-command.mjs')).href;
    const replacement = `import fs from 'node:fs';export {listenerPort} from ${JSON.stringify(formatter + '?original')};function fail(){const entries=JSON.parse(fs.readFileSync(process.env.PAQ_TEST_OWNERSHIP,'utf8')).sessions;fs.writeFileSync(process.env.PAQ_TEST_CAPTURE,JSON.stringify(entries.map(({pid,url})=>({pid,url}))));throw Error('Invented hint preparation failure')}export {fail as mirageCommandHint,fail as mirageStopCommand};`;
    await fs.writeFile(
      hooks,
      `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){const result=next(specifier,context);return result.url===${JSON.stringify(formatter)}?{url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(replacement))},shortCircuit:true}:result}});`,
    );
    const env = {
      NODE_OPTIONS: '--import=' + pathToFileURL(hooks).href,
      PAQ_TEST_OWNERSHIP: paths.ownershipFile,
      PAQ_TEST_CAPTURE: captured,
    };
    for (const selection of [
      [],
      ['--site', 'first', '--portals', 'selected', '--state', path.join(work.directory, 'new-single-state.json')],
    ]) {
      const result = await work.run(['mirage', 'start', '--config', config, ...selection, '--json'], env);
      const sessions = JSON.parse(await fs.readFile(captured, 'utf8'));
      work.tracked.push({ paths, pids: sessions.map(({ pid }) => pid) });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(JSON.parse(result.stdout).error.message, /Invented hint preparation failure/);
      const started = sessions.filter(({ pid }) => pid !== existing.pid);
      assert.equal(started.length, 1, 'the failure follows a real runtime launch');
      for (const session of started) await stopped(session);
      await alive(existing);
      assert.deepEqual(
        JSON.parse(await fs.readFile(paths.ownershipFile, 'utf8')).sessions.map(({ pid }) => pid),
        [existing.pid],
      );
    }
  },
);

test(
  'projectless standalone stop and init next preserve ownership cwd and runtime from another empty directory',
  { timeout: 60000 },
  async (t) => {
    const work = await workspace(t);
    const elsewhere = path.join(work.directory, 'different empty cwd');
    await fs.mkdir(elsewhere);
    const state = path.join(work.directory, 'first standalone.json');
    const first = await work.start([
      '--runtime',
      'model-driven',
      '--state',
      state,
      '--port',
      '0',
      '--simulation',
      'dry-run',
    ]);
    const sibling = await work.start([
      '--runtime',
      'model-driven',
      '--state',
      path.join(work.directory, 'other standalone.json'),
      '--port',
      '0',
      '--simulation',
      'dry-run',
    ]);
    await work.replay(first.stop, false, elsewhere);
    await stopped(first);
    await alive(sibling);
    const init = await work.run([
      'mirage',
      'init',
      '--runtime',
      'model-driven',
      '--state',
      state,
      '--port',
      '0',
      '--simulation',
      'dry-run',
      '--solution-root',
      work.alternate,
      '--json',
    ]);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const report = JSON.parse(init.stdout);
    assert.deepEqual(report.writesFiles, []);
    assert.doesNotMatch(report.skipped, /catalogue settings configure/);
    const args = JSON.parse((await work.replay(report.next, true, elsewhere)).stdout);
    assert.ok(args.includes('model-driven') && args.includes(state) && args.includes(work.alternate));
    assert.ok(args.includes('--simulation') && args.includes('dry-run'));
  },
);

test(
  'standalone project with external configuration replays both inferred and explicit runtimes from another cwd',
  { timeout: 90000 },
  async (t) => {
    const work = await workspace(t);
    const elsewhere = path.join(work.directory, 'another empty cwd');
    await fs.mkdir(elsewhere);
    const project = path.join(work.directory, 'standalone project', 'workspace.json');
    await fs.mkdir(path.dirname(project), { recursive: true });
    await fs.writeFile(project, JSON.stringify({ version: 2, runtime: { kind: 'model-driven' }, solutions: [] }));
    const config = path.join(work.directory, 'external browser config', 'custom.json');
    await work.writeCatalogue(config);
    for (const runtime of [[], ['--runtime', 'model-driven']]) {
      const args = [
        '--config',
        config,
        '--project',
        project,
        '--repo',
        work.alternate,
        ...runtime,
        '--port',
        '0',
        '--simulation',
        'dry-run',
      ];
      const started = await work.start(args);
      await work.replay(started.stop, false, elsewhere);
      await stopped(started);
    }
    const init = await work.run([
      'mirage',
      'init',
      '--config',
      config,
      '--project',
      project,
      '--runtime',
      'model-driven',
      '--repo',
      work.alternate,
      '--json',
    ]);
    assert.equal(init.status, 0, init.stdout + init.stderr);
    const args = JSON.parse((await work.replay(JSON.parse(init.stdout).next, true, elsewhere)).stdout);
    assert.ok(
      args.includes(config) && args.includes(work.alternate) && args.includes(project) && args.includes('model-driven'),
    );
  },
);

test(
  'shared hint payload stays while a target is unverified and is removed after the final owned target stops',
  { timeout: 30000 },
  async (t) => {
    const work = await workspace(t);
    const paths = miragePaths({ stateDir: path.join(work.directory, '.paqvilo') });
    const children = [0, 1].map(() =>
      spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore', windowsHide: true }),
    );
    t.after(async () => {
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) {
          const closed = once(child, 'close');
          child.kill();
          await closed;
        }
    });
    await Promise.all(children.map((child) => once(child, 'spawn')));
    const payload = persistCommandPayload(
      path.join(path.dirname(paths.ownershipFile), 'commands'),
      Buffer.from(JSON.stringify([[cli, 'mirage', 'stop']])),
    );
    const records = children.map((child, index) => ({
      pid: child.pid,
      processIdentity: index === 0 ? processIdentity(child.pid) : null,
      sourceDir: null,
      url: null,
      hintFiles: [payload],
    }));
    await fs.mkdir(path.dirname(paths.ownershipFile), { recursive: true });
    await fs.writeFile(paths.ownershipFile, JSON.stringify({ sessions: records }));
    const first = await stopOwnedSessions({ paths, pids: [children[0].pid] });
    assert.equal(first.stopped.length, 1);
    await fs.access(payload);
    records[1].processIdentity = processIdentity(children[1].pid);
    await fs.writeFile(paths.ownershipFile, JSON.stringify({ sessions: [records[1]] }));
    const last = await stopOwnedSessions({ paths, pids: [children[1].pid] });
    assert.equal(last.stopped.length, 1);
    await assert.rejects(fs.access(payload), { code: 'ENOENT' });
  },
);
