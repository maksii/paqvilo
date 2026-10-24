// In-memory upload session bounds: the maxUploadSessions cap, the maxUploadBytes budget and the idle TTL that each use
// of a session restarts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { install } from '../lib/dataverse-files.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const DOC = '77777777-7777-4777-8777-7777777777b1';
const USER = { systemuserid: '77777777-7777-4777-8777-7777777777b2' };
const MINUTE = 60 * 1000;
const b64 = (text) => Buffer.from(text).toString('base64');
const target = { '@odata.type': 'Microsoft.Dynamics.CRM.fx_document', fx_documentid: DOC };

function harness(settings) {
  const state = emptyState();
  state.mappings.fx_document = {
    logicalName: 'fx_document',
    entitySet: 'fx_documents',
    idColumn: 'fx_documentid',
    fields: { fx_file: { dataverseType: 'file', MaxSizeInKB: 64 } },
  };
  state.tables.fx_document = [{ fx_documentid: DOC }];
  const ops = [];
  install({
    store: new DataStore({ state }),
    settings,
    principals: { authorize() {} },
    change: (fn) => fn(),
    registry: { register: (op) => ops.push(op) },
    recordHooks: { add() {} },
    addRoute() {},
    records: { handle: async () => ({}) },
  });
  const call = (name, body) =>
    ops
      .find((op) => op.name === name)
      .handle({
        method: 'POST',
        user: USER,
        origin: ORIGIN,
        version: 'v9.2',
        headers: {},
        body,
        url: new URL(`${ORIGIN}/x`),
      });
  const open = async () =>
    (await call('InitializeFileBlocksUpload', { Target: target, FileAttributeName: 'fx_file', FileName: 'a.bin' })).body
      .FileContinuationToken;
  const upload = (token, id, data) =>
    call('UploadBlock', { BlockId: b64(id), BlockData: b64(data), FileContinuationToken: token });
  return { open, upload };
}

test('the 33rd concurrent upload session is refused and names dataverse.maxUploadSessions', async () => {
  const h = harness();
  for (let i = 0; i < 32; i++) await h.open();
  await assert.rejects(
    h.open(),
    (error) =>
      error.status === 400 && /at most 32 open upload sessions \(dataverse\.maxUploadSessions\)/.test(error.message),
  );
});

test('a configured maxUploadSessions caps sessions; expired sessions free their slot', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const h = harness(dataverseSettings({ maxUploadSessions: 2 }));
  await h.open();
  await h.open();
  await assert.rejects(h.open(), /at most 2 open upload sessions/);
  now += 16 * MINUTE;
  assert.ok(await h.open());
});

test('each block upload restarts the fifteen-minute idle TTL', async (t) => {
  let now = 1_000_000;
  t.mock.method(Date, 'now', () => now);
  const h = harness();
  const token = await h.open();
  for (let i = 1; i <= 3; i++) {
    now += 10 * MINUTE;
    assert.equal(
      (await h.upload(token, `block-000${i}`, 'x')).status,
      204,
      `still live after ${i * 10} minutes of activity`,
    );
  }
  now += 15 * MINUTE + 1;
  await assert.rejects(h.upload(token, 'block-0009', 'x'), /continuation token is not valid/);
});

test('bytes buffered across sessions stay within dataverse.maxUploadBytes', async () => {
  const h = harness(dataverseSettings({ maxUploadBytes: 100 }));
  const first = await h.open(),
    second = await h.open();
  assert.equal((await h.upload(first, 'block-0001', 'a'.repeat(60))).status, 204);
  await assert.rejects(
    h.upload(second, 'block-0001', 'b'.repeat(60)),
    (error) => error.status === 400 && /at most 100 bytes .*dataverse\.maxUploadBytes/.test(error.message),
  );
  // Re-sending a block replaces its bytes, so it does not count twice.
  assert.equal((await h.upload(first, 'block-0001', 'c'.repeat(60))).status, 204);
  assert.equal((await h.upload(second, 'block-0001', 'd'.repeat(40))).status, 204);
});

test('dataverse settings validate the upload bounds and omit them unless configured', () => {
  assert.equal(dataverseSettings({}).maxUploadSessions, undefined);
  assert.deepEqual(
    [
      dataverseSettings({ maxUploadSessions: 4, maxUploadBytes: 1024 }).maxUploadSessions,
      dataverseSettings({ maxUploadBytes: 1024 }).maxUploadBytes,
    ],
    [4, 1024],
  );
  assert.throws(() => dataverseSettings({ maxUploadSessions: 0 }), /dataverse\.maxUploadSessions must be an integer/);
  assert.throws(() => dataverseSettings({ maxUploadBytes: 1.5 }), /dataverse\.maxUploadBytes must be an integer/);
});
