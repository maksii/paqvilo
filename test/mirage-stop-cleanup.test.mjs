// The stop-scope workspace never leaves a runtime behind: not when a test fails or times out while
// a CLI is still starting one, and not when the test process itself ends abruptly.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isAlive } from '../lense/commands/mirage.mjs';
import { workspace, cli, stopped } from './mirage-stop-workspace.mjs';
import { processesNaming } from './mirage-reaper.mjs';

const standalone = (directory) => [
  'mirage',
  'start',
  '--runtime',
  'model-driven',
  '--state',
  path.join(directory, 'standalone.json'),
  '--port',
  '0',
  '--simulation',
  'dry-run',
  '--json',
];

test('workspace cleanup on a failed or timed-out test ends a CLI still starting and the runtime it launched', async (t) => {
  const work = await workspace(t);
  // The CLI launches and records its runtime, reports it on stdout, then blocks before answering,
  // as a CLI does when the test times out during its start.
  const formatter = pathToFileURL(fileURLToPath(new URL('../lense/stop-command.mjs', import.meta.url))).href;
  // A standalone start records its runtime under <cwd>/.paqvilo/mirage/sessions.json.
  const replacement = `import fs from 'node:fs';import path from 'node:path';export {listenerPort} from ${JSON.stringify(formatter + '?original')};function hang(){const sessions=JSON.parse(fs.readFileSync(path.join(process.cwd(),'.paqvilo','mirage','sessions.json'),'utf8')).sessions;fs.writeSync(1,JSON.stringify(sessions.map(({pid,url})=>({pid,url})))+'\\n');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0)}export {hang as mirageCommandHint,hang as mirageStopCommand};`;
  const hooks = path.join(work.directory, 'hang-after-launch.mjs');
  fs.writeFileSync(
    hooks,
    `import {registerHooks} from 'node:module';registerHooks({resolve(specifier,context,next){const result=next(specifier,context);return result.url===${JSON.stringify(formatter)}?{url:${JSON.stringify('data:text/javascript,' + encodeURIComponent(replacement))},shortCircuit:true}:result}});`,
  );
  const { child, result } = work.launchCli(standalone(work.directory), {
    NODE_OPTIONS: '--import=' + pathToFileURL(hooks).href,
  });
  const [line] = await once(child.stdout, 'data');
  const [session] = JSON.parse(String(line));
  assert.ok(isAlive(session.pid), 'the hung CLI has a running runtime');
  // What the owned fixture runs after a failure or timeout.
  await work.dispose();
  assert.notEqual((await result).status, 0, 'the hung CLI was ended');
  assert.equal(child.exitCode !== null || child.signalCode !== null, true);
  assert.equal(isAlive(session.pid), false, 'its runtime was stopped');
  await stopped(session);
});

// `after start`: the test process dies once its CLI has started and recorded a runtime.
// `during start`: it dies while the CLI is still starting. On Windows the CLI then dies with it (a
// libuv child joins its parent's kill-on-close job), so a runtime it launched has no record.
for (const moment of ['after start', 'during start'])
  test(`an abruptly ended test process leaves its workspace to the reaper (${moment})`, async (t) => {
    const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-reaped-')));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const reaper = new URL('./mirage-reaper.mjs', import.meta.url).href;
    // A stand-in test process: it starts the reaper and a tracked CLI that launches a runtime, and is
    // then killed. The reaper inherits its stdout, so the stream ends only once the reaper finished.
    const script = `import {startReaper} from ${JSON.stringify(reaper)};import {execFile} from 'node:child_process';import {once} from 'node:events';import fs from 'node:fs';const [directory,cli,args,moment]=process.argv.slice(1);const reaper=startReaper(directory);let output='';const child=execFile(process.execPath,[cli,...JSON.parse(args)],{cwd:directory,windowsHide:true},(error,stdout)=>{output=stdout});await reaper.track(child);if(moment==='after start'){await once(child,'close');output=JSON.parse(output).pid}fs.writeSync(1,JSON.stringify({cli:child.pid,runtime:output||null})+'\\n');process.kill(process.pid,'SIGKILL');`;
    const stand = spawn(
      process.execPath,
      ['--input-type=module', '-e', script, directory, cli, JSON.stringify(standalone(directory)), moment],
      { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
    );
    let written = '';
    stand.stdout.setEncoding('utf8').on('data', (chunk) => (written += chunk));
    await once(stand.stdout, 'end');
    const [started, report] = written.trim().split('\n').map(JSON.parse);
    t.diagnostic(JSON.stringify(report));
    // Once a child closes, Windows can reuse its PID for an unrelated process. Match the unique workspace instead.
    const named = await processesNaming(directory);
    assert.equal(named.includes(started.cli), false, 'the reaper waited for the CLI belonging to this workspace');
    if (moment === 'after start') {
      assert.equal(typeof started.runtime, 'number', 'the CLI started a runtime');
      assert.deepEqual(report.reaped, [started.runtime], 'the reaper stopped the recorded runtime');
    }
    assert.deepEqual(report.left, []);
    for (const pid of [...report.reaped, ...report.strays])
      assert.equal(named.includes(pid), false, 'the stopped workspace process is no longer present');
    assert.deepEqual(named, [], 'no process names the workspace any longer');
    assert.equal(fs.existsSync(directory), false, 'the reaper removed the workspace');
  });

test('a live unrelated process does not count as a workspace CLI when a PID is reused', async (t) => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'paqvilo-reaper-identity-')));
  const script = "process.stdout.write('ready\\n');process.stdin.resume()";
  const start = (args) =>
    spawn(process.execPath, ['-e', script, ...args], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true,
    });
  const child = start([]),
    matching = start([directory]);
  const closed = [once(child, 'close'), once(matching, 'close')];
  t.after(async () => {
    child.stdin.end();
    matching.stdin.end();
    await Promise.all(closed);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  await Promise.all([once(child.stdout, 'data'), once(matching.stdout, 'data')]);
  assert.equal(isAlive(child.pid), true);
  assert.equal(isAlive(matching.pid), true);
  const named = await processesNaming(directory);
  assert.equal(named.includes(matching.pid), true, 'a live process naming the workspace is found');
  assert.equal(named.includes(child.pid), false, 'a live unrelated process is excluded');
});
