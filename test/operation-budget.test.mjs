// @test-kind tooling: finite operation inventories override inherited Node CLI aggregate deadlines while retaining each original operation guard and failure.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { operationBudget, countOperations } from './helpers/operation-budget.mjs';

test('only finite positive operation inventories fit the runner timer range', () => {
  assert.equal(operationBudget(28, 300_000), 8_400_000);
  for (const [count, guard] of [
    [0, 10],
    [2, 0],
    [Infinity, 10],
    [2, Infinity],
    [2, 2_147_483_647],
  ])
    assert.throws(() => operationBudget(count, guard), /positive safe integers|timer limits/);
});

test('operation inventories reject omitted and extra work without replacing an earlier failure', () => {
  const fixture = () => {
    const hooks = [];
    const context = { after: (hook) => hooks.push(hook), signal: new AbortController().signal };
    return { context, finish: () => hooks.forEach((hook) => hook()) };
  };
  const complete = fixture();
  const counted = countOperations(complete.context, 2, (value) => value + 1);
  assert.equal(counted(1), 2);
  assert.equal(counted(2), 3);
  complete.finish();
  assert.throws(() => counted(3), /exceeded its declared operation inventory/);
  const omitted = fixture();
  countOperations(omitted.context, 1, () => {});
  assert.throws(omitted.finish, /declared operation inventory completed/);
  omitted.context.error = new Error('the original operation failure');
  assert.doesNotThrow(omitted.finish);
});

async function runner(t, mode) {
  const environment = { ...process.env };
  // This is an independent runner with its own IPC clock, not the parent's
  // internal child-test protocol endpoint.
  delete environment.NODE_TEST_CONTEXT;
  const child = spawn(
    process.execPath,
    ['--test-timeout=10', fileURLToPath(new URL('./helpers/operation-budget-worker.mjs', import.meta.url)), mode],
    { env: environment, stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true },
  );
  const closed = new Promise((resolve) => child.once('close', (status) => resolve(status)));
  ownedFixture(t).add(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed;
  });
  let output = '';
  const messages = [];
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stderr.on('data', (chunk) => (output += chunk));
  child.on('message', (message) => {
    messages.push(message);
    if (message.type === 'entered') child.send({ type: 'advance', ms: mode === 'stalled' ? 11 : 6 });
  });
  return { status: await closed, output, messages };
}

test('the real Node CLI keeps operation guards while a finite workflow outlives its inherited default', async (t) => {
  const inherited = await runner(t, 'infinity');
  assert.equal(inherited.status, 1, inherited.output);
  assert.match(inherited.output, /test timed out after 10ms/);
  assert.deepEqual(inherited.messages.at(-1), { type: 'done', mode: 'infinity', now: 12 });
  const finite = await runner(t, 'finite');
  assert.equal(finite.status, 0, finite.output);
  assert.deepEqual(finite.messages.at(-1), { type: 'done', mode: 'finite', now: 12 });
  const stalled = await runner(t, 'stalled');
  assert.equal(stalled.status, 1, stalled.output);
  assert.match(stalled.output, /test timed out after 10ms/);
  assert.deepEqual(stalled.messages.at(-1), { type: 'done', mode: 'stalled', now: 11 });
});

test('the real runner reports omitted work and preserves an original operation failure', async (t) => {
  const omitted = await runner(t, 'omitted');
  assert.equal(omitted.status, 1, omitted.output);
  assert.match(omitted.output, /the declared operation inventory completed/);
  assert.deepEqual(omitted.messages.at(-1), { type: 'done', mode: 'omitted', now: 6 });
  const primary = await runner(t, 'primary');
  assert.equal(primary.status, 1, primary.output);
  assert.match(primary.output, /invented primary operation failure/);
  assert.doesNotMatch(primary.output, /the declared operation inventory completed/);
  assert.deepEqual(primary.messages.at(-1), { type: 'done', mode: 'primary', now: 0 });
});
