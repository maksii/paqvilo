import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runBaselineCapture } from './support/baseline-capture-cli.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
// A run takes one to two seconds; this bound only reports a hang (and its abort stops the child), whatever the runner's
// --test-timeout. It is not a speed requirement.
const RUN_TIMEOUT_MS = 60_000;
const ids = ['fixture/alpha-one', 'fixture/alpha-two', 'fixture/beta-one', 'fixture/beta-two'];

async function bridgeFixture() {
  const fs = await import('node:fs');
  const readline = await import('node:readline');
  const [closed, events, mode] = process.argv.slice(2);
  // Only ends an orphan whose parent never closes stdin; it is longer than RUN_TIMEOUT_MS, so it never decides a result.
  const watchdog = setTimeout(() => process.exit(99), 300_000);
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
      fs.appendFileSync(events, id + '\n');
      if (id === 'clear-cache' && mode === 'aggregate-error')
        return send({ id: message.id, error: { code: -32000, message: 'Invented cache transport failure' } });
      const failed =
        id.startsWith('persona-alpha-') &&
        ['admin-add-error', 'admin-remove-error', 'aggregate-error', 'probe-error'].includes(mode);
      const capture = {
        summary: {
          id,
          status: failed ? 'failed' : 'captured',
          problems: failed ? ['Invented read-only persona probe mismatch'] : [],
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
      const token = /"x-baseline-token": "([a-f0-9]+)"/.exec(tail)[1],
        run = /"x-baseline-run": "([a-f0-9]+)"/.exec(tail)[1];
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-baseline-token': token, 'x-baseline-run': run },
        body: JSON.stringify(capture),
      });
      send({
        id: message.id,
        result: { content: [{ type: 'text', text: JSON.stringify({ ...capture.summary, posted: response.status }) }] },
      });
    })
    .on('close', () => {
      clearTimeout(watchdog);
      fs.writeFileSync(closed, 'closed');
      process.exit(0);
    });
}
async function fixture(t, mode) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'baseline uncertain hook '));
  try {
    const server = path.join(directory, 'bridge.mjs'),
      hook = path.join(directory, 'hook.mjs');
    const closed = path.join(directory, 'closed.txt'),
      hookEvents = path.join(directory, 'hooks.txt'),
      bridgeEvents = path.join(directory, 'bridge-events.txt');
    await fs.writeFile(server, `(${bridgeFixture.toString()})();`);
    await fs.writeFile(
      hook,
      `import fs from 'node:fs';const[event,mode,file]=process.argv.slice(2);fs.appendFileSync(file,event+'\\n');if(mode==='persona-error'&&event==='persona:alpha'||mode==='reset-error'&&event==='reset'||mode==='admin-add-error'&&event==='add'||['admin-remove-error','aggregate-error'].includes(mode)&&event==='remove')process.exit(7);`,
    );
    const command = (event) => `"${process.execPath}" "${hook}" "${event}" ${mode} "${hookEvents}"`;
    const hooks =
      mode === 'probe-error' ? {} : { livePersona: command('persona:{persona}'), liveReset: command('reset') };
    const live = { command: process.execPath, args: [server, closed, bridgeEvents, mode] };
    if (['admin-add-error', 'admin-remove-error', 'aggregate-error'].includes(mode)) {
      hooks.liveAdminAdd = command('add');
      hooks.liveAdminRemove = command('remove');
      live.clearCache = { attempts: 1, delay: 0, steps: [{ goto: '/clear' }] };
    }
    const matrix = {
      version: 1,
      origin: 'https://fixture.invalid',
      delayMs: 0,
      live,
      hooks,
      personas: {
        alpha: { verify: { attempts: 1, delay: 0, steps: [{ goto: '/probe-alpha' }] } },
        beta: { verify: { attempts: 1, delay: 0, steps: [{ goto: '/probe-beta' }] } },
      },
      scenarios: ids.map((id, index) => ({ id, persona: index < 2 ? 'alpha' : 'beta', steps: [{ goto: '/read' }] })),
    };
    const matrixFile = path.join(directory, 'matrix.json'),
      out = path.join(directory, 'out');
    await fs.writeFile(matrixFile, JSON.stringify(matrix));
    // A run that never exits fails on the test timeout, whose abort signal also stops the child.
    const { code: exit, output } = await runBaselineCapture(
      ['--matrix', matrixFile, '--out', out, '--side', 'live'],
      t.signal,
    );
    assert.equal(await fs.readFile(closed, 'utf8'), 'closed', output);
    const run = JSON.parse(await fs.readFile(path.join(out, 'run-live.json'), 'utf8'));
    const readEvents = async (file) => {
      try {
        return (await fs.readFile(file, 'utf8')).trim().split('\n').filter(Boolean);
      } catch (error) {
        if (error.code === 'ENOENT') return [];
        throw error;
      }
    };
    const files = [];
    async function walk(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(file);
        else files.push(path.relative(out, file));
      }
    }
    await walk(out);
    return { exit, run, hooks: await readEvents(hookEvents), bridge: await readEvents(bridgeEvents), files, output };
  } finally {
    assert.ok(directory.startsWith(os.tmpdir() + path.sep));
    await fs.rm(directory, { recursive: true, force: true });
  }
}
function assertBlocked(result, hook, phase) {
  assert.equal(result.exit, 2);
  assert.deepEqual(
    result.run.scenarios.map((row) => row.id),
    ids,
    'every selected ID receives a receipt',
  );
  assert.equal(result.run.totals.captured, 0);
  assert.equal(result.run.totals.error, 4);
  assert.equal(result.run.totals.notAttempted, 3);
  assert.deepEqual(result.run.scenarios[0].uncertainHook, {
    hook,
    code: 'BASELINE_MUTATING_HOOK_UNCERTAIN',
    reconciliationRequired: true,
  });
  assert.equal(result.run.scenarios[0].notAttempted, undefined, 'original hook error remains attempted');
  for (const row of result.run.scenarios.slice(1)) {
    assert.equal(row.status, 'error');
    assert.equal(row.notAttempted, true);
    assert.deepEqual(row.blockedBy, { scenario: ids[0], phase, hook, code: 'BASELINE_MUTATING_HOOK_UNCERTAIN' });
    assert.deepEqual(row.ms, {});
    assert.equal(row.requests, undefined);
    assert.equal(row.elements, undefined);
    assert.equal(
      result.files.some((file) => file.startsWith(row.id + path.sep)),
      false,
      'blocked case has no phantom capture',
    );
  }
}

test(
  'failed mutating persona hook blocks both remaining persona groups without extra calls',
  { timeout: RUN_TIMEOUT_MS },
  async (t) => {
    const result = await fixture(t, 'persona-error');
    assertBlocked(result, 'livePersona', 'persona');
    assert.deepEqual(result.hooks, ['persona:alpha']);
    assert.deepEqual(result.bridge, []);
    assert.match(result.run.scenarios[0].problems[0], /Hook failed \(7\)/);
  },
);
test(
  'failed reset hook runs once and blocks every remaining case rather than blindly retrying',
  { timeout: RUN_TIMEOUT_MS },
  async (t) => {
    const result = await fixture(t, 'reset-error');
    assertBlocked(result, 'liveReset', 'reset');
    assert.deepEqual(result.hooks, ['persona:alpha', 'reset']);
    assert.deepEqual(result.bridge, ['persona-alpha-1']);
  },
);
test(
  'uncertain admin add does not remove unknown original membership or attempt another persona',
  { timeout: RUN_TIMEOUT_MS },
  async (t) => {
    const result = await fixture(t, 'admin-add-error');
    assertBlocked(result, 'liveAdminAdd', 'persona');
    assert.deepEqual(result.hooks, ['persona:alpha', 'add']);
    assert.deepEqual(result.bridge, ['persona-alpha-1']);
  },
);
test(
  'failed admin removal after successful grant and cache cycle blocks later groups',
  { timeout: RUN_TIMEOUT_MS },
  async (t) => {
    const result = await fixture(t, 'admin-remove-error');
    assertBlocked(result, 'liveAdminRemove', 'persona');
    assert.deepEqual(result.hooks, ['persona:alpha', 'add', 'remove']);
    assert.deepEqual(result.bridge, ['persona-alpha-1', 'clear-cache']);
  },
);
test(
  'aggregate cache and cleanup failure retains both errors and its mutating-hook stop marker',
  { timeout: RUN_TIMEOUT_MS },
  async (t) => {
    const result = await fixture(t, 'aggregate-error');
    assertBlocked(result, 'liveAdminRemove', 'persona');
    assert.deepEqual(result.hooks, ['persona:alpha', 'add', 'remove']);
    assert.match(result.run.scenarios[0].problems[0], /Invented cache transport failure/);
    assert.match(result.run.scenarios[0].problems[0], /admin role cleanup also failed/);
  },
);
test(
  'ordinary read-only probe mismatch still lets a different persona group capture',
  { timeout: RUN_TIMEOUT_MS },
  async (t) => {
    const result = await fixture(t, 'probe-error');
    assert.equal(result.exit, 2);
    assert.deepEqual(
      result.run.scenarios.map((row) => row.id),
      ids,
    );
    assert.equal(result.run.totals.captured, 2);
    assert.equal(result.run.totals.error, 2);
    assert.equal(result.run.totals.notAttempted, 0);
    assert.equal(
      result.run.scenarios.some((row) => row.notAttempted || row.blockedBy || row.uncertainHook),
      false,
    );
    assert.deepEqual(result.hooks, []);
    assert.deepEqual(result.bridge, ['persona-alpha-1', 'persona-beta-1', ids[2], ids[3]]);
  },
);
test(
  'successful hook protocol still captures both personas and all four cases',
  { timeout: RUN_TIMEOUT_MS },
  async (t) => {
    const result = await fixture(t, 'success');
    assert.equal(result.exit, 0, result.output);
    assert.equal(result.run.totals.captured, 4);
    assert.equal(result.run.totals.error, 0);
    assert.equal(result.run.totals.notAttempted, 0);
    assert.deepEqual(result.hooks, ['persona:alpha', 'reset', 'reset', 'persona:beta', 'reset', 'reset']);
    assert.deepEqual(result.bridge, ['persona-alpha-1', ids[0], ids[1], 'persona-beta-1', ids[2], ids[3]]);
  },
);
