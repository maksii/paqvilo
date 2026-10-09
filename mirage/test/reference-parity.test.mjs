import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeContract, compareReferenceContracts } from '../reference-parity.mjs';

test('reference projections preserve nulls, missing-field errors, ordering and explicit status-only checks', () => {
  const plan = { collection: 'value', fields: ['id', 'name'], unordered: true };
  assert.deepEqual(normalizeContract({ value: [{ id: 2, name: null, noise: 'volatile' }, { id: 1, name: 'A' }] }, plan), [{ id: 1, name: 'A' }, { id: 2, name: null }]);
  assert.throws(() => normalizeContract({ value: [{ id: 1 }] }, plan), /configured field/);
  assert.throws(() => normalizeContract({}, plan), /collection/);
  assert.equal(normalizeContract('Not JSON', { statusOnly: true }), null);
});

test('reference runner detects JSON/status/state mismatches, rejects writes and redacts query values', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-contract-'));
  let revision = 1;
  const server = http.createServer((req, res) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(req.url.startsWith('/__sim') ? { config: { mode: 'local', pageMode: 'local', endpoints: [], identity: { id: 'local' } }, status: { revision, sourceFingerprint: 'source' } } : { value: [{ id: 'one', name: 'Local' }] })); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const options = { localUrl: `http://127.0.0.1:${server.address().port}`, origin: 'https://example.powerappsportals.com', outputDir: directory, contracts: [{ id: 'record', path: '/_api/items?secret=hidden', collection: 'value', fields: ['id'] }], bridge: { request: async () => ({ status: 200, body: Buffer.from('{"value":[{"id":"one","name":"Native"}]}') }) } };
  const passed = await compareReferenceContracts(options); assert.equal(passed.passed, true); assert.equal(JSON.stringify(passed).includes('hidden'), false);
  assert.equal((await compareReferenceContracts({ ...options, contracts: [{ ...options.contracts[0], fields: ['name'] }] })).passed, false);
  assert.equal((await compareReferenceContracts({ ...options, bridge: { request: async () => ({ status: 403, body: '{}' }) } })).passed, false);
  assert.equal((await compareReferenceContracts({ ...options, contracts: [{ ...options.contracts[0], expectedCount: 2 }] })).passed, false);
  assert.equal((await compareReferenceContracts({ ...options, bridge: { request: async () => { revision++; return { status: 200, body: '{"value":[{"id":"one"}]}' }; } } })).passed, false);
  await assert.rejects(compareReferenceContracts({ ...options, contracts: [{ ...options.contracts[0], method: 'POST' }] }), /GET/);
});
