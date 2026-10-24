import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { ownedFixture } from '../testing/owned-fixture.mjs';

test('one context shares its owner across builders and retains the declared close order', async () => {
  const hooks = [],
    context = { after: (hook) => hooks.push(hook) },
    events = [];
  const first = ownedFixture(context),
    second = ownedFixture(context);
  assert.equal(first, second);
  first.remove(() => events.push('remove-first'));
  second.add(async () => {
    await Promise.resolve();
    events.push('close-first');
  });
  first.remove(() => events.push('remove-second'));
  first.add(() => events.push('close-second'));
  assert.equal(hooks.length, 1);
  await hooks[0]();
  assert.deepEqual(events, ['close-first', 'close-second', 'remove-first', 'remove-second']);
});

test('all closers run after failure; one exact error is retained and every remover is skipped', async () => {
  const hooks = [],
    events = [],
    failure = new Error('Invented close failure');
  const context = { after: (hook) => hooks.push(hook) },
    owner = ownedFixture(context);
  owner.add(() => {
    events.push('first');
    throw failure;
  });
  owner.remove(() => events.push('remove-first'));
  owner.add(async () => events.push('second'));
  owner.remove(() => events.push('remove-second'));
  await assert.rejects(hooks[0], (error) => error === failure);
  assert.deepEqual(events, ['first', 'second']);
});

test('several close failures retain all original causes in registration order', async () => {
  const hooks = [],
    first = new Error('First owned failure'),
    second = new Error('Second owned failure');
  const owner = ownedFixture({ after: (hook) => hooks.push(hook) });
  owner.add(() => {
    throw first;
  });
  owner.add(async () => {
    throw second;
  });
  owner.remove(() => assert.fail('A failed drain must retain its directories'));
  await assert.rejects(
    hooks[0],
    (error) => error instanceof AggregateError && error.errors[0] === first && error.errors[1] === second,
  );
});

test('a directory failure occurs after listener shutdown and cannot retain its process handle', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-fixture-listener-'));
  const server = http.createServer((request, response) => response.end('invented'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + server.address().port,
    hooks = [],
    failure = new Error('Invented removal failure');
  const owner = ownedFixture({ after: (hook) => hooks.push(hook) });
  owner.remove(() => {
    assert.equal(server.listening, false);
    throw failure;
  });
  owner.add(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  try {
    await assert.rejects(hooks[0], (error) => error === failure);
    await assert.rejects(fetch(url, { signal: AbortSignal.timeout(1000) }), /fetch failed/);
    assert.ok((await fs.stat(root)).isDirectory());
  } finally {
    server.closeAllConnections();
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('cleanup awaits accepted asynchronous work before removing its state directory', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'owned-fixture-write-'));
  const hooks = [],
    owner = ownedFixture({ after: (hook) => hooks.push(hook) });
  let release,
    removed = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const write = (async () => {
    await gate;
    await fs.writeFile(path.join(root, 'committed.json'), 'invented bytes');
  })();
  owner.remove(async () => {
    removed = true;
    assert.equal(await fs.readFile(path.join(root, 'committed.json'), 'utf8'), 'invented bytes');
    await fs.rm(root, { recursive: true, force: true });
  });
  owner.add(() => write);
  const cleanup = hooks[0]();
  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(removed, false);
    release();
    await cleanup;
    await assert.rejects(fs.stat(root), { code: 'ENOENT' });
  } finally {
    release();
    await write;
    await cleanup.catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('independent contexts remain isolated when one context cannot drain', async () => {
  const firstHooks = [],
    secondHooks = [],
    first = ownedFixture({ after: (hook) => firstHooks.push(hook) });
  const second = ownedFixture({ after: (hook) => secondHooks.push(hook) }),
    failure = new Error('One context failed');
  let removed = false;
  first.add(() => {
    throw failure;
  });
  second.remove(() => {
    removed = true;
  });
  await assert.rejects(firstHooks[0], (error) => error === failure);
  await secondHooks[0]();
  assert.equal(removed, true);
});

test('the original test failure remains visible while later cleanup still runs', () => {
  const helperUrl = new URL('../testing/owned-fixture.mjs', import.meta.url).href;
  const source = `
    import test from 'node:test';
    import { ownedFixture } from ${JSON.stringify(helperUrl)};
    test('owned primary failure', context => {
      const owner = ownedFixture(context);
      owner.remove(() => console.log('UNEXPECTED_REMOVER'));
      owner.add(() => { throw new Error('INVENTED_DRAIN_FAILURE'); });
      owner.add(() => console.log('LATER_RESTORATION_RAN'));
      throw new Error('INVENTED_PRIMARY_FAILURE');
    });
  `;
  const result = spawnSync(process.execPath, [...process.execArgv, '--input-type=module', '-e', source], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.match(result.stdout + result.stderr, /INVENTED_PRIMARY_FAILURE/);
  assert.match(result.stdout + result.stderr, /LATER_RESTORATION_RAN/);
  assert.doesNotMatch(result.stdout + result.stderr, /UNEXPECTED_REMOVER/);
});
