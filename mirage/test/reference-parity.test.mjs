import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { normalizeContract, compareReferenceContracts } from '../reference-parity.mjs';
import { createSimulator } from '../server.mjs';
import { createPortalSession } from '../testing/sessions.mjs';

test('reference projections preserve nulls, missing-field errors, ordering and explicit status-only checks', () => {
  const plan = { collection: 'value', fields: ['id', 'name'], unordered: true };
  assert.deepEqual(normalizeContract({ value: [{ id: 2, name: null, noise: 'volatile' }, { id: 1, name: 'A' }] }, plan), [{ id: 1, name: 'A' }, { id: 2, name: null }]);
  assert.throws(() => normalizeContract({ value: [{ id: 1 }] }, plan), /configured field/);
  assert.throws(() => normalizeContract({}, plan), /collection/);
  assert.equal(normalizeContract('Not JSON', { statusOnly: true }), null);
});

test('reference parity uses explicit local visitors, membership and override roles without changing runtime identity', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-visitor-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_name: Parity fixture\nadx_websiteid: site',
    'webrole.yml': '- adx_webroleid: reader\n  adx_name: Reader\n- adx_webroleid: public\n  adx_name: Public\n  adx_anonymoususersrole: true',
    'sitesetting.yml': '- adx_sitesettingid: enabled\n  adx_name: Webapi/widget/enabled\n  adx_value: "true"\n- adx_sitesettingid: fields\n  adx_name: Webapi/widget/fields\n  adx_value: widgetid',
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(directory, name), body);
  const initial = { mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' }, widget: { entitySet: 'widgets', idColumn: 'widgetid' } }, tables: { contact: [{ contactid: 'reader', fullname: 'Local Reader' }, { contactid: 'other', fullname: 'Other' }], widget: [{ widgetid: 'one' }] }, permissions: [{ id: 'read', entity: 'widget', scope: 'global', roles: ['Reader'], operations: ['read'] }], settings: { permissionMode: 'enforce' }, simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', identity: { contactId: 'reader', roleSource: 'memberships' }, contactRoles: [{ contactId: 'reader', roleId: 'reader' }], endpoints: [] } };
  const app = await createSimulator({ sourceDir: directory, stateFile: path.join(directory, 'state.json'), initial, port: 0, watch: false });
  t.after(() => app.close());
  const options = { localUrl: app.url, origin: 'https://reference.invalid', outputDir: path.join(directory, 'evidence'), contracts: [{ id: 'protected', path: '/_api/widgets', collection: 'value', fields: ['widgetid'] }], bridge: { request: async () => ({ status: 200, body: { value: [{ widgetid: 'one' }] } }) } };
  const identity = structuredClone(app.store.state.simulator.identity);
  assert.equal((await compareReferenceContracts(options)).contracts[0].localStatus, 403);
  for (const localVisitor of [{ contactId: 'reader' }, { contactId: 'other', roles: ['Reader'] }, { configuredPersona: true }]) {
    const report = await compareReferenceContracts({ ...options, localVisitor });
    assert.equal(report.passed, true, JSON.stringify(report));
    assert.equal(report.localVisitor.signedIn, true);
    const evidence = await fs.readFile(report.report, 'utf8');
    assert.doesNotMatch(evidence, /cookie|csrf|paqvilo-mirage-auth/i);
  }
  assert.deepEqual(app.store.state.simulator.identity, identity);
  app.store.state.simulator.identity = { contactId: 'other', roleSource: 'override', roles: ['Reader'] };
  assert.equal((await compareReferenceContracts({ ...options, localVisitor: { configuredPersona: true } })).passed, true, 'configured override roles remain visitor-local');
  app.store.state.simulator.identity = identity;
  app.store.state.simulator.identityScope = 'configured';
  assert.equal((await compareReferenceContracts(options)).contracts[0].localStatus, 403, 'compatibility scope does not grant the default parity visitor access');
  delete app.store.state.simulator.identityScope;
  const session = await createPortalSession({ origin: app.url, contactId: 'reader' });
  assert.equal((await compareReferenceContracts({ ...options, localSession: session })).passed, true);
  assert.equal((await session.session()).signedIn, true, 'caller-owned session stays open');
  const changed = await compareReferenceContracts({ ...options, localSession: session, bridge: { request: async () => { await session.signIn('other', { roles: ['Reader'] }); return { status: 200, body: { value: [{ widgetid: 'one' }] } }; } } });
  assert.equal(changed.contracts[0].passed, true);
  assert.equal(changed.localVisitor.unchanged, false);
  assert.equal(changed.passed, false, 'same projected rows cannot hide an identity change');
  await assert.rejects(compareReferenceContracts({ ...options, localSession: { ...session, origin: 'http://127.0.0.1:1' } }), /selected loopback origin/);
  await assert.rejects(compareReferenceContracts({ ...options, localSession: null }), /selected loopback origin/);
  session.close();
  await assert.rejects(compareReferenceContracts({ ...options, localSession: session }), /session is unavailable/);
  await assert.rejects(compareReferenceContracts({ ...options, localVisitor: { roles: ['Reader'] } }), /requires an existing contactId/);
  app.store.state.simulator.identity = { roles: ['Reader'] };
  await assert.rejects(compareReferenceContracts({ ...options, localVisitor: { configuredPersona: true } }), /no configured persona/);
  // Public anonymous reads retain normal exported-role permission checks.
  app.store.state.permissions[0].roles = ['Public'];
  assert.equal((await compareReferenceContracts(options)).passed, true);
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
