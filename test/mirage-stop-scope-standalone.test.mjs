// Standalone runtimes: stop and init hints keep their ownership directory and runtime from another
// cwd, a failed hint stops what it started, and shared hint payloads outlive unverified targets.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { miragePaths, stopOwnedSessions, processIdentity } from '../lense/commands/mirage.mjs';
import { persistCommandPayload } from '../lense/command-payload.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { workspace, cli, alive, stopped } from './mirage-stop-workspace.mjs';

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
    const formatter = pathToFileURL(fileURLToPath(new URL('../lense/stop-command.mjs', import.meta.url))).href;
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
    const standalone = (file) =>
      work.start(['--runtime', 'model-driven', '--state', file, '--port', '0', '--simulation', 'dry-run']);
    // Separate states: independent launches.
    const [first, sibling] = await Promise.all([
      standalone(state),
      standalone(path.join(work.directory, 'other standalone.json')),
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
    // Closed with the workspace's other processes, before its directory is removed.
    ownedFixture(t).add(async () => {
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
