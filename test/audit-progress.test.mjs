// @test-kind security: bounded authenticated audit progress cannot excuse stalled or unadmitted work.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { auditInventory, createAuditProgress } from '../scripts/audit-progress.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const identity = (name, source) => `security-advisory:${name}:${source}`;
const derived = (name, source) =>
  createHash('sha512')
    .update(JSON.stringify([name, source]))
    .digest('base64');
const fixture = {
  packages: {
    '': { dependencies: { alpha: '1' } },
    'node_modules/alpha': { version: '1', dependencies: { bravo: '1' } },
    'node_modules/bravo': { version: '1', dependencies: { charlie: '1' } },
    'node_modules/charlie': { version: '1' },
  },
};
function harness({ seeds = [{ name: 'charlie', source: 123 }], timeout = 60, lock = fixture, inventoryAt = 0 } = {}) {
  let now = 0;
  let sequence = 0;
  let scheduled;
  const failures = [];
  const guard = createAuditProgress({
    inventory: auditInventory(lock),
    nonce: 'test',
    timeout,
    clock: { now: () => now },
    schedule: (callback) => {
      scheduled = callback;
      return 0;
    },
    cancel: () => {},
    fail: (error) => failures.push(error),
  });
  const send = (packet) => guard.accept({ v: 1, nonce: 'test', seq: ++sequence, ...packet });
  send({ type: 'hello' });
  now = inventoryAt;
  send({ type: 'inventory', seeds });
  return {
    guard,
    send,
    failures,
    at(value) {
      now = value;
    },
    tick(value) {
      now = value;
      scheduled();
    },
    calculate(name, source, action = 'start') {
      send({ type: 'calculation', action, name, source: String(source) });
    },
    work(name, source, kind, action) {
      send({ type: 'work', action, kind, name, id: hash(kind === 'packument' ? name : identity(name, source)) });
    },
  };
}
function load(h, name, source, start, end) {
  h.calculate(name, source);
  inputs(h, name, source);
  h.at(start);
  h.work(name, source, 'load', 'start');
  h.at(end);
  h.work(name, source, 'load', 'end');
  h.calculate(name, source, 'end');
}
function inputs(h, name, source) {
  const cached = derived(name, source);
  h.work(name, cached, 'cache:get', 'start');
  h.work(name, cached, 'cache:get', 'end');
  h.work(name, '', 'packument', 'start');
  h.work(name, '', 'packument', 'end');
}

test('finite genuine metadata work succeeds beyond the old flat deadline, with typed cache identities', () => {
  const h = harness();
  h.calculate('charlie', 123);
  h.work('charlie', derived('charlie', 123), 'cache:get', 'start');
  h.at(1);
  h.work('charlie', derived('charlie', 123), 'cache:get', 'end');
  h.work('charlie', '', 'packument', 'start');
  h.work('charlie', '', 'packument', 'end');
  h.work('charlie', 123, 'load', 'start');
  h.at(31);
  h.work('charlie', 123, 'load', 'end');
  h.calculate('charlie', 123, 'end');
  const bravoSource = derived('charlie', 123);
  load(h, 'bravo', bravoSource, 32, 62);
  load(h, 'alpha', derived('bravo', bravoSource), 63, 93);
  h.send({ type: 'complete' });
  assert.doesNotThrow(() => h.guard.finish());
  h.guard.stop();
});

test('a pending IO span excludes only bounded synchronous load time, never unrelated progress', () => {
  const h = harness({
    seeds: [
      { name: 'bravo', source: 1 },
      { name: 'charlie', source: 2 },
    ],
  });
  h.calculate('bravo', 1);
  h.work('bravo', 'ignored', 'packument', 'start');
  h.at(40);
  h.calculate('charlie', 2);
  inputs(h, 'charlie', 2);
  h.work('charlie', 2, 'load', 'start');
  h.at(90);
  h.work('charlie', 2, 'load', 'end');
  h.calculate('charlie', 2, 'end');
  h.at(110);
  assert.throws(() => h.work('bravo', '', 'packument', 'end'), /packument stalled/);
  h.guard.stop();
});

test('late queued events cannot forgive expired IO, loads, startup or the anchored whole budget', () => {
  const io = harness();
  io.calculate('charlie', 123);
  io.work('charlie', '', 'packument', 'start');
  io.at(60);
  assert.throws(() => io.work('charlie', 123, 'load', 'start'), /packument stalled/);
  io.guard.stop();
  const cpu = harness();
  cpu.calculate('charlie', 123);
  inputs(cpu, 'charlie', 123);
  cpu.work('charlie', 123, 'load', 'start');
  cpu.at(60);
  assert.throws(() => cpu.work('charlie', 123, 'load', 'end'), /load stalled/);
  cpu.guard.stop();
  const whole = harness();
  load(whole, 'charlie', 123, 0, 59);
  load(whole, 'bravo', derived('charlie', 123), 59, 118);
  load(whole, 'alpha', derived('bravo', derived('charlie', 123)), 118, 177);
  whole.at(240);
  assert.throws(() => whole.send({ type: 'complete' }), /whole-audit deadline/);
  whole.guard.stop();
});

test('replayed, unknown, overlapping, unbalanced and excess work cannot extend audit life', () => {
  const cases = [
    (h) => h.guard.accept({ v: 1, nonce: 'test', seq: 2, type: 'hello' }),
    (h) => h.guard.accept({ v: 1, nonce: 'other', seq: 3, type: 'hello' }),
    (h) => h.send({ type: 'inventory', seeds: [] }),
    (h) => h.send({ type: 'heartbeat' }),
    (h) => h.calculate('unrelated', 999),
    (h) => h.work('charlie', 123, 'load', 'end'),
    (h) => {
      h.calculate('charlie', 123);
      h.calculate('charlie', 123);
    },
    (h) => {
      h.calculate('charlie', 123);
      inputs(h, 'charlie', 123);
      h.work('charlie', 123, 'load', 'start');
      h.work('charlie', 123, 'load', 'start');
    },
    (h) => {
      h.calculate('charlie', 123);
      h.send({ type: 'complete' });
    },
    (h) => h.guard.finish(),
  ];
  for (const run of cases) {
    const h = harness();
    assert.throws(() => run(h), /Audit progress/);
    h.guard.stop();
  }
});

test('node-instance inventory retains separate version edges instead of collapsing package names', () => {
  const inventory = auditInventory({
    packages: {
      '': {},
      'node_modules/parent': { dependencies: { leaf: '1' } },
      'node_modules/parent/node_modules/leaf': { version: '1' },
      'node_modules/other': { dependencies: { leaf: '2' } },
      'node_modules/other/node_modules/leaf': { version: '2' },
    },
  });
  assert.equal(inventory.edges.length, 2);
  assert.equal(new Set(inventory.edges.map((edge) => edge.to)).size, 2);
  assert.throws(
    () =>
      harness({
        seeds: [
          { name: 'charlie', source: 123 },
          { name: 'charlie', source: '123' },
        ],
      }),
    /ambiguous/,
  );
});

test('causal phase prerequisites reject forged pauses and unfinished source propagation', () => {
  const cases = [
    (h) => {
      h.calculate('charlie', 123);
      h.work('charlie', 123, 'load', 'start');
    },
    (h) => {
      h.calculate('charlie', 123);
      h.work('charlie', derived('charlie', 123), 'cache:put', 'start');
    },
    (h) => {
      h.calculate('charlie', 123);
      h.calculate('bravo', derived('charlie', 123));
    },
    (h) => h.send({ type: 'complete' }),
  ];
  for (const run of cases) {
    const h = harness();
    assert.throws(() => run(h), /Audit progress/);
    h.guard.stop();
  }
});

test('unique fresh inventory and completion boundaries begin their own stall windows without moving the whole cap', () => {
  const h = harness({ inventoryAt: 59 });
  h.at(100);
  load(h, 'charlie', 123, 100, 110);
  h.at(169);
  h.send({ type: 'complete' });
  h.at(228);
  h.guard.finish();
  h.at(229);
  assert.throws(() => h.guard.finish(), /stall deadline/);
  h.guard.stop();
});

test('the scheduled guard detects a stalled operation without receiving any further event', () => {
  const h = harness();
  h.calculate('charlie', 123);
  h.work('charlie', '', 'packument', 'start');
  h.tick(60);
  assert.equal(h.failures.length, 1);
  assert.match(h.failures[0].message, /packument stalled/);
  h.guard.stop();
});

test('distinct advisories may reuse a completed per-name packument while each cache input remains mandatory', () => {
  const h = harness({
    seeds: [
      { name: 'charlie', source: 1 },
      { name: 'charlie', source: 2 },
    ],
  });
  load(h, 'charlie', 1, 0, 30);
  h.calculate('charlie', 2);
  h.work('charlie', derived('charlie', 2), 'cache:get', 'start');
  h.work('charlie', derived('charlie', 2), 'cache:get', 'end');
  h.work('charlie', 2, 'load', 'start');
  h.at(65);
  h.work('charlie', 2, 'load', 'end');
  h.calculate('charlie', 2, 'end');
  h.send({ type: 'complete' });
  assert.doesNotThrow(() => h.guard.finish());
  h.guard.stop();
});
