// @test-kind contract: the live capture CLI runs the admin cache-clear cycle and the cache refresh with the run's own write permission.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { runBaselineCapture } from './support/baseline-capture-cli.mjs';
import { makeTemporaryDirectory, assertTemporaryDirectory } from '../testing/owned-fixture.mjs';
async function fakeBridge() {
  const fs = await import('node:fs');
  const readline = await import('node:readline');
  const marker = process.argv[2],
    mode = process.argv[3];
  let cleared = false;
  // Only ends an orphan whose parent never closes stdin; it is longer than any run, so it never decides a result.
  const timer = setTimeout(() => process.exit(99), 300_000);
  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  readline
    .createInterface({ input: process.stdin })
    .on('line', async (line) => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      if (message.method === 'initialize') return send({ id: message.id, result: { protocolVersion: '2024-11-05' } });
      if (message.method === 'tools/list')
        return send({ id: message.id, result: { tools: [{ name: 'browser_run_code_unsafe' }] } });
      const code = message.params.arguments.code;
      const options = JSON.parse(/const result = await run\(page, (\{[^\n]*\})\);/.exec(code)[1]);
      const id = options.scenario.id;
      if (id === 'clear-cache' && mode !== 'success')
        return send({ id: message.id, error: { code: -32000, message: 'Invented cache bridge failure' } });
      if (id === 'clear-cache') cleared = true;
      const status = id.startsWith('persona-') && !cleared ? 'failed' : 'captured';
      const captured = {
        summary: {
          id,
          status,
          problems: status === 'failed' ? ['Invented persona not yet settled'] : [],
          finishedAt: new Date().toISOString(),
        },
        raw: {
          requests: [],
          console: [],
          pageErrors: [],
          elements: [],
          dom: '<p>Invented fixture</p>',
          finalUrl: 'https://fixture.invalid/',
        },
      };
      const tail = code.slice(code.lastIndexOf('const posted = await fetch('));
      const endpoint = JSON.parse(/fetch\(("[^"]+")/.exec(tail)[1]);
      if (!/^http:\/\/127\.0\.0\.1:\d+\/capture$/.test(endpoint)) throw Error('Expected owned loopback receiver');
      const token = /"x-baseline-token": "([a-f0-9]+)"/.exec(tail)[1];
      const run = /"x-baseline-run": "([a-f0-9]+)"/.exec(tail)[1];
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-baseline-token': token, 'x-baseline-run': run },
        body: JSON.stringify(captured),
      });
      send({
        id: message.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ ...captured.summary, posted: response.status }) }] },
      });
    })
    .on('close', () => {
      clearTimeout(timer);
      fs.writeFileSync(marker, 'closed');
      process.exit(0);
    });
}
async function run(mode, signal, { refresh = false, allowWrites = true, selection = ['--only', 'fixture/read'] } = {}) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'baseline admin cleanup '));
  try {
    const marker = path.join(directory, 'bridge-closed.txt');
    const hookMarker = path.join(directory, 'hook-events.txt');
    const server = path.join(directory, 'server.mjs');
    const hook = path.join(directory, 'hook.mjs');
    await fs.writeFile(server, `(${fakeBridge.toString()})();`);
    await fs.writeFile(
      hook,
      `import fs from 'node:fs';fs.appendFileSync(process.argv[2],process.argv[3]+'\\n');if(process.argv[4]==='add-error'&&process.argv[3]==='add')process.exit(7);if(process.argv[4]==='cleanup-error'&&process.argv[3]==='remove')process.exit(9);`,
    );
    const hookCommand = (action) => `"${process.execPath}" "${hook}" "${hookMarker}" ${action} ${mode}`;
    const matrix = path.join(directory, 'matrix.json');
    await fs.writeFile(
      matrix,
      JSON.stringify({
        version: 1,
        origin: 'https://fixture.invalid',
        live: {
          command: process.execPath,
          args: [server, marker, mode],
          clearCache: { attempts: 1, delay: 0, steps: [{ goto: '/clear' }] },
          ...(refresh ? { refresh: { steps: [{ goto: '/refresh' }] } } : {}),
        },
        hooks: { liveAdminAdd: hookCommand('add'), liveAdminRemove: hookCommand('remove') },
        personas: { editor: { verify: { attempts: 1, delay: 0, steps: [{ goto: '/probe' }] } } },
        scenarios: [{ id: 'fixture/read', persona: 'editor', steps: [{ goto: '/' }] }],
      }),
    );
    const { code, output } = await runBaselineCapture(
      [
        '--matrix',
        matrix,
        '--out',
        path.join(directory, 'out'),
        '--side',
        'live',
        ...selection,
        ...(allowWrites ? ['--allow-writes'] : []),
      ],
      signal,
    );
    // A set-up refused for missing write permission never starts the bridge, so it leaves no close marker.
    if (allowWrites) assert.equal(await fs.readFile(marker, 'utf8'), 'closed', `owned bridge closed\n${output}`);
    const events = await fs.readFile(hookMarker, 'utf8').then(
      (text) => text.trim().split('\n'),
      (error) => {
        if (error.code === 'ENOENT') return [];
        throw error;
      },
    );
    const record = await fs.readFile(path.join(directory, 'out', 'run-live.json'), 'utf8').then(JSON.parse, () => null);
    return { code, events, output, record };
  } finally {
    const physical = await assertTemporaryDirectory(directory);
    await fs.rm(physical, { recursive: true, force: true });
  }
}

test('baseline removes temporary admin after bridge cache failure', async (t) => {
  const result = await run('clear-error', t.signal);
  assert.equal(result.code, 2);
  assert.deepEqual(result.events, ['add', 'remove']);
  assert.match(result.output, /Invented cache bridge failure/);
});
test('baseline does not blindly remove membership after a failed add hook', async (t) => {
  const result = await run('add-error', t.signal);
  assert.equal(result.code, 2);
  assert.deepEqual(result.events, ['add']);
  assert.match(result.output, /Hook failed \(7\)/);
});
test('baseline retains primary cache error and explicit cleanup-hook failure', async (t) => {
  const result = await run('cleanup-error', t.signal);
  assert.equal(result.code, 2);
  assert.deepEqual(result.events, ['add', 'remove']);
  assert.match(result.output, /Invented cache bridge failure/);
  assert.match(result.output, /admin role cleanup also failed/);
  assert.match(result.output, /Hook failed \(9\)/);
});
test('baseline live capture with --all-scenarios runs every scenario and records the choice', async (t) => {
  const result = await run('success', t.signal, { selection: ['--all-scenarios'] });
  assert.equal(result.code, 0, result.output);
  assert.equal(result.record.allScenarios, true);
  assert.equal(result.record.allowWrites, true);
  assert.deepEqual(
    result.record.scenarios.map((scenario) => scenario.id),
    ['fixture/read'],
  );
});
// @test-kind security: a refresh step writes to the live portal, so a run without --allow-writes must refuse it.
test('baseline refuses a live refresh step in a run without --allow-writes', async (t) => {
  const result = await run('success', t.signal, { refresh: true, allowWrites: false });
  assert.equal(result.code, 1);
  assert.deepEqual(result.events, []);
  assert.match(result.output, /matrix\.live\.refresh/);
  assert.match(result.output, /rerun with --allow-writes/);
});
test('baseline successful cache cycle removes admin before capture and closes owned bridge', async (t) => {
  const result = await run('success', t.signal);
  assert.equal(result.code, 0, result.output);
  assert.deepEqual(result.events, ['add', 'remove']);
});
