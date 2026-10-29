import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RecordPageSession, pagedRecordsOf } from '../lib/record-tables.mjs';
import { encodeRecordReferences, decodeRecordReferences, restoreRecordReferences } from '../lib/record-state.mjs';

test('journal references have no reserved business marker and retain nested saved tables and frozen inputs', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'invented-record-state-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const session = new RecordPageSession(root);
  t.after(() => session.close());
  const rows = session.from([{ id: 'one', recordRefs: { $paqvilo: 'records' } }], { primaryKey: 'id' });
  const marker = { $paqviloRecordTable: { malicious: false }, recordRefs: [{ path: ['business'], table: null }] };
  const value = Object.freeze({
    tables: Object.freeze({ one: rows }),
    saved: [Object.freeze({ tables: { two: rows } })],
    marker,
  });
  const entry = { op: 'section', key: 'presets', value };
  const encoded = encodeRecordReferences(entry);
  assert.equal(encoded.value.marker, marker);
  assert.equal(encoded.recordRefs.length, 2);
  assert.equal(value.tables.one, rows);
  const parsed = decodeRecordReferences(JSON.parse(JSON.stringify(encoded)));
  const restored = await restoreRecordReferences({ presets: parsed.value }, root);
  t.after(() => restored.session.close());
  assert.ok(pagedRecordsOf(restored.state.presets.tables.one));
  assert.deepEqual(pagedRecordsOf(restored.state.presets.saved[0].tables.two).raw(0), {
    id: 'one',
    recordRefs: { $paqvilo: 'records' },
  });
  assert.deepEqual(restored.state.presets.marker, marker);
});

test('reference paths reject duplicates, inherited traversal and substitutions of ordinary data', () => {
  const entry = () => ({
    op: 'section',
    key: 'presets',
    value: { sample: null },
    recordRefs: [{ path: ['value', 'sample'], table: {} }],
  });
  const duplicate = entry();
  duplicate.recordRefs.push(duplicate.recordRefs[0]);
  assert.throws(() => decodeRecordReferences(duplicate), /Duplicate record reference/);
  const inherited = entry();
  inherited.recordRefs[0].path = ['value', 'toString', 'sample'];
  assert.throws(() => decodeRecordReferences(inherited), /Missing record reference parent/);
  const wrong = entry();
  wrong.value.sample = [];
  assert.throws(() => decodeRecordReferences(wrong), /null placeholder/);
  const circular = { op: 'section', key: 'presets', value: {} };
  circular.value.self = circular.value;
  assert.throws(() => encodeRecordReferences(circular), /circular state/);
});
