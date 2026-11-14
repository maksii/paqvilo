import test from 'node:test';
import assert from 'node:assert/strict';
import { createRecordCapabilitiesSummary } from '../lib/record-capabilities-summary.mjs';
import { statusResponseChunks } from '../lib/status-response.mjs';
import { stringifyExactJson, parseExactJson } from '../lib/exact-numeric.mjs';
import { immutableStatus, immutableStatusBytes } from '../lib/immutable-status.mjs';

test('status encoding admits only private plain snapshots and retains legacy special-type serialization', () => {
  for (const item of [new Uint8Array([1, 2]), new Date(0), new Map([['key', 1]])]) {
    const value = { item };
    assert.equal(immutableStatus(value), undefined);
    assert.equal(Object.isFrozen(value), false);
    assert.equal(immutableStatusBytes(value), undefined);
    const parts = statusResponseChunks({ report: value }, { encoded: () => undefined });
    assert.equal(parts.join(''), stringifyExactJson({ report: value }));
  }
  const publicValue = Object.freeze({ nested: { value: 1 } });
  assert.equal(immutableStatusBytes(publicValue), undefined, 'A frozen root does not establish private ownership.');
});

test('local HTTP capability summaries are immutable, bounded by current table names and separate from public copies', () => {
  const store = { state: { mappings: { invented: {} } } };
  const summary = createRecordCapabilitiesSummary(store);
  const first = summary({ reuse: true });
  assert.equal(summary({ reuse: true }), first);
  assert.ok(Object.isFrozen(first.invented));
  const copy = summary();
  copy.invented.update = false;
  assert.equal(summary({ reuse: true }).invented.update, true);
  store.state.mappings.extra = {};
  assert.equal(summary({ reuse: true }).extra.create, true);
  delete store.state.mappings.extra;
  assert.equal(summary({ reuse: true }).extra, undefined);
});

test('adapter capability changes stay fresh even when table names and store revision are unchanged', () => {
  let writable = true,
    calls = 0;
  const store = {
    state: { mappings: { invented: {} } },
    storageAdapter: {
      recordCapabilities() {
        calls++;
        return { create: writable, update: writable, delete: writable };
      },
    },
  };
  const summary = createRecordCapabilitiesSummary(store);
  assert.equal(summary({ reuse: true }).invented.create, true);
  writable = false;
  assert.equal(summary({ reuse: true }).invented.create, false);
  assert.equal(calls, 2);
});

test('status parts preserve exact bytes and reuse only immutable local capability buffers', () => {
  const store = { state: { mappings: { invented: {} } } };
  const summary = createRecordCapabilitiesSummary(store);
  const payload = {
    precise: parseExactJson('12345678901234567890.1234'),
    skipped: undefined,
    recordCapabilities: summary({ reuse: true }),
    label: 'Δ " \\',
    revision: 1,
  };
  const first = statusResponseChunks(payload, summary);
  assert.equal(Buffer.concat(first.map((value) => Buffer.from(value))).toString(), stringifyExactJson(payload));
  assert.equal(statusResponseChunks(payload, summary).find(Buffer.isBuffer), first.find(Buffer.isBuffer));
  assert.equal(summary.encoded(summary()), undefined, 'Public mutable values never reuse encoded bytes.');
  store.state.mappings.extra = {};
  payload.recordCapabilities = summary({ reuse: true });
  const next = statusResponseChunks(payload, summary);
  assert.notEqual(next.find(Buffer.isBuffer), first.find(Buffer.isBuffer));
  assert.equal(Buffer.concat(next.map((value) => Buffer.from(value))).toString(), stringifyExactJson(payload));
  assert.equal(
    JSON.parse(Buffer.concat(first.map((value) => Buffer.from(value))).toString()).recordCapabilities.extra,
    undefined,
  );
});
