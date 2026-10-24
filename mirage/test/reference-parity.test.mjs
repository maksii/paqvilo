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
import { ownedFixture } from "../testing/owned-fixture.mjs";

test('reference projections preserve nulls, missing-field errors, ordering and explicit status-only checks', () => {
  const plan = { collection: 'value', fields: ['id', 'name'], unordered: true };
  assert.deepEqual(normalizeContract({ value: [{ id: 2, name: null, noise: 'volatile' }, { id: 1, name: 'A' }] }, plan), [{ id: 1, name: 'A' }, { id: 2, name: null }]);
  assert.throws(() => normalizeContract({ value: [{ id: 1 }] }, plan), /configured field/);
  assert.throws(() => normalizeContract({}, plan), /collection/);
  assert.equal(normalizeContract('Not JSON', { statusOnly: true }), null);
  assert.throws(()=>normalizeContract({value:[]},{statusOnly:'false'}),/statusOnly must be a boolean/);
  assert.throws(()=>normalizeContract({}, {fields:['constructor']}),/configured field/);
  assert.throws(()=>normalizeContract({}, {fields:['toString']}),/configured field/);
  assert.deepEqual(normalizeContract(JSON.parse('{"constructor":"explicit value"}'),{fields:['constructor']}),{constructor:'explicit value'});
  assert.deepEqual(normalizeContract({items:['first','second']},{fields:['items.0']}),{'items.0':'first'});
});

test('malformed reference options fail before local or reference reads instead of weakening comparison',async()=>{
  let requests=0;
  const options={localUrl:'http://127.0.0.1:1',origin:'https://reference.invalid',outputDir:'unused-evidence',contracts:[],bridge:{request:async()=>{requests++;return{status:200,body:'{}'};}}};
  const valid={id:'valid',path:'/_api/widgets'};
  for(const contract of [null,[],{...valid,id:{secret:'must not be copied'}},{...valid,id:'x'.repeat(161)},{...valid,statusOnly:'false'},{...valid,unordered:1},{...valid,collection:{}},{...valid,fields:[null]},{...valid,fields:Array(1)},{...valid,method:''},{...valid,kind:false}])await assert.rejects(compareReferenceContracts({...options,contracts:[valid,contract]}));
  assert.equal(requests,0);
});

test('reference parity uses explicit local visitors, membership and override roles without changing runtime identity', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-visitor-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const files = {
    'website.yml': 'adx_name: Parity fixture\nadx_websiteid: site',
    'webrole.yml': '- adx_webroleid: reader\n  adx_name: Reader\n- adx_webroleid: public\n  adx_name: Public\n  adx_anonymoususersrole: true',
    'sitesetting.yml': '- adx_sitesettingid: enabled\n  adx_name: Webapi/widget/enabled\n  adx_value: "true"\n- adx_sitesettingid: fields\n  adx_name: Webapi/widget/fields\n  adx_value: widgetid',
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(directory, name), body);
  const initial = { mappings: { contact: { entitySet: 'contacts', idColumn: 'contactid' }, widget: { entitySet: 'widgets', idColumn: 'widgetid' } }, tables: { contact: [{ contactid: 'reader', fullname: 'Local Reader' }, { contactid: 'other', fullname: 'Other' }], widget: [{ widgetid: 'one' }] }, permissions: [{ id: 'read', entity: 'widget', scope: 'global', roles: ['Reader'], operations: ['read'] }], settings: { permissionMode: 'enforce' }, simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', identity: { contactId: 'reader', roleSource: 'memberships' }, contactRoles: [{ contactId: 'reader', roleId: 'reader' }], endpoints: [] } };
  const app = await createSimulator({ sourceDir: directory, stateFile: path.join(directory, 'state.json'), initial, port: 0, watch: false });
  ownedFixture(t).add(() => app.close());
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
  const override = await compareReferenceContracts({ ...options, localVisitor: { configuredPersona: true } });
  assert.equal(override.passed, true, JSON.stringify(override));
  app.store.state.simulator.identity = identity;
  const changedScope = await compareReferenceContracts({ ...options, bridge: { request: async () => {
    app.store.state.simulator.identityScope = 'configured';
    return { status: 200, body: { value: [{ widgetid: 'one' }] } };
  } } });
  assert.equal(changedScope.contracts[0].localStatus, 403, 'an explicit anonymous cookie stays anonymous when identity scope changes after setup');
  assert.equal(changedScope.localVisitor.signedIn, false);
  delete app.store.state.simulator.identityScope;
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
  let revision = 1, localReads = 0;
  const anonymousCookie = 'fixture-visitor=private-anonymous-session';
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/__sim/api/state') || req.url.startsWith('/_sim/api/state')) return res.end(JSON.stringify({ csrf: 'fixture-session-control', config: { mode: 'local', pageMode: 'local', endpoints: [], identity: { id: 'local' } }, status: { revision, sourceFingerprint: 'source' } }));
    if (req.url === '/_sim/api/session/sign-out') {
      assert.equal(req.method, 'POST'); assert.equal(req.headers['x-sim-csrf'], 'fixture-session-control');
      res.setHeader('set-cookie', `${anonymousCookie}; Path=/; HttpOnly`);
      return res.end(JSON.stringify({ signedIn: false, contactId: null, roles: [], roleSource: 'memberships' }));
    }
    if (req.url === '/_sim/api/session') {
      assert.equal(req.headers.cookie, anonymousCookie);
      return res.end(JSON.stringify({ signedIn: false, contactId: null, roles: [], roleSource: 'memberships' }));
    }
    localReads++;
    assert.equal(req.method, 'GET'); assert.equal(req.url, '/_api/items?secret=hidden');
    assert.equal(req.headers.cookie, anonymousCookie);
    assert.equal(req.headers['x-paqvilo-local-only'], 'true');
    assert.equal(req.headers.prefer, 'odata.maxpagesize=3');
    assert.equal(req.headers.authorization, undefined);
    res.end(JSON.stringify({ value: [{ id: 'one', name: 'Local' }] }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(directory, { recursive: true, force: true }); });
  const options = { localUrl: `http://127.0.0.1:${server.address().port}`, origin: 'https://example.powerappsportals.com', outputDir: directory, contracts: [{ id: 'record', path: '/_api/items?secret=hidden', prefer: 'odata.maxpagesize=3', collection: 'value', fields: ['id'] }], bridge: { request: async (route, init) => {
    assert.equal(route, '/_api/items?secret=hidden'); assert.deepEqual(init, { method: 'GET', prefer: 'odata.maxpagesize=3' });
    return { status: 200, body: Buffer.from('{"value":[{"id":"one","name":"Native"}]}') };
  } } };
  const passed = await compareReferenceContracts(options); assert.equal(passed.passed, true); assert.equal(JSON.stringify(passed).includes('hidden'), false);
  assert.equal((await compareReferenceContracts({ ...options, contracts: [{ ...options.contracts[0], fields: ['name'] }] })).passed, false);
  assert.equal((await compareReferenceContracts({ ...options, bridge: { request: async () => ({ status: 403, body: '{}' }) } })).passed, false);
  assert.equal((await compareReferenceContracts({ ...options, contracts: [{ ...options.contracts[0], expectedCount: 2 }] })).passed, false);
  assert.equal((await compareReferenceContracts({ ...options, bridge: { request: async () => { revision++; return { status: 200, body: '{"value":[{"id":"one"}]}' }; } } })).passed, false);
  await assert.rejects(compareReferenceContracts({ ...options, contracts: [{ ...options.contracts[0], method: 'POST' }] }), /GET/);
  assert.equal(localReads, 5);
  assert.doesNotMatch(await fs.readFile(passed.report, 'utf8'), /private-anonymous-session|fixture-session-control|hidden/);
});

test('anonymous parity requires session controls and refuses runtime-state redirects before reference access', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'reference-session-guard-'));
  let forwardedRequests = 0, referenceRequests = 0, redirect = true;
  const destination = http.createServer((_req, res) => { forwardedRequests++; res.end('{}'); });
  destination.listen(0, '127.0.0.1'); await once(destination, 'listening');
  const server = http.createServer((req, res) => {
    if (redirect) { res.writeHead(302, { location: `http://127.0.0.1:${destination.address().port}/must-not-receive-state` }); return res.end(); }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ config: { mode: 'local', pageMode: 'local', endpoints: [] } }));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {
    for (const current of [server, destination]) { current.closeAllConnections(); await new Promise(resolve => current.close(resolve)); }
    await fs.rm(directory, { recursive: true, force: true });
  });
  const options = { localUrl: `http://127.0.0.1:${server.address().port}`, origin: 'https://reference.invalid', outputDir: directory, contracts: [{ id: 'read', path: '/_api/widgets', statusOnly: true }], bridge: { request: async () => { referenceRequests++; return { status: 200, body: '{}' }; } } };
  await assert.rejects(compareReferenceContracts(options), error => /redirect/i.test(error.cause?.message ?? error.message));
  assert.equal(forwardedRequests, 0);
  redirect = false;
  await assert.rejects(compareReferenceContracts(options), /did not provide session controls/);
  assert.equal(referenceRequests, 0);
});
