// Task 42: custom connector policy templates applied in order (set host URL, route request with method, set header/query,
// set property, convert array to object and object to array) and the OAuth authorization code flow with a loopback redirect
// listener, PKCE and refresh, against a loopback fake authorization server. Invented connector, hosts and credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { DataStore, emptyState } from '../lib/data.mjs';
import { inventoryEntry, mergeInventory } from '../lib/solution-inventory.mjs';
import { customConnectorsOf, buildRequest, applyResponsePolicies } from '../lib/custom-connector.mjs';
import { createConnectorRuntime, connectionSettings } from '../lib/connector-runtime.mjs';

const NAME = 'x_5fpolicyapi', AT = `Connectors/${NAME}/`;
const entry = (file, value) => inventoryEntry(AT + file, { size: 100, text: JSON.stringify(value), component: 'connector', componentName: NAME })[0];
const compiled = (openapi, policies = []) => customConnectorsOf(mergeInventory([entry(`${NAME}_openapidefinition.json`, openapi), entry(`${NAME}_policytemplateinstances.json`, policies)]));
const policy = (templateId, values, section, operations) => ({ templateId, parameters: { ...Object.fromEntries(Object.entries(values).map(([k, v]) => ['x-ms-apimTemplateParameter.' + k, v])),
  ...(section ? { 'x-ms-apimTemplate-policySection': section } : {}), ...(operations ? { 'x-ms-apimTemplate-operationName': operations } : {}) } });
const OPENAPI = { swagger: '2.0', info: { title: 'Invented policies' }, host: 'api.example.test', basePath: '/v1', schemes: ['https'],
  paths: { '/people/{id}': { get: { operationId: 'GetPeople', parameters: [{ name: 'id', in: 'path', required: true, type: 'string' }, { name: 'payload', in: 'body', schema: { type: 'object' } }], consumes: ['application/json'], responses: { 200: { description: 'ok' } } } } } };

test('policy templates apply in order to the request and the response', () => {
  const [connector] = compiled(OPENAPI, [
    policy('dynamichosturl', { urlTemplate: "https://@connectionParameters('x_region').example.test/@header('x-tenant')" }),
    policy('setheader', { name: 'x-tenant', value: 'later', existsAction: 'override' }, 'Request'),
    policy('routerequesttoendpoint', { newPath: '/v2/people/{id}', httpMethod: 'POST' }, null, ['GetPeople']),
    policy('setqueryparameter', { name: 'api-version', value: "@headers('x-tenant')" }, 'Request'),
    policy('setproperty', { newPropertyParentPathTemplate: '@body()', newPropertySubPathTemplate: 'name', propertyValuePathTemplate: '{@body().first} {@body().last}' }, 'Request'),
    policy('convertarraytoobject', { propertyParentPath: '@body()', propertySubPath: 'peopleArray', keyWithinCollectionPath: 'Name', newPropertyPath: 'peopleObject', retainKey: 'false' }, 'Response'),
    policy('convertobjecttoarray', { propertyParentPath: '@body().sets', propertySubPath: 'people', newPropertyPath: '@item().people', keyName: 'Name', valueName: 'Details' }, 'Response'),
    policy('setproperty', { newPropertyParentPathTemplate: '@body().sets', newPropertySubPathTemplate: 'tag', propertyValuePathTemplate: 'x' }, 'Response'),
  ]);
  assert.equal(connector.blocked, null, connector.blocked?.message);
  const req = buildRequest(connector, 'GetPeople', { id: '7', 'x-tenant': 'ignored', payload: { first: 'Ada', last: 'Lovelace' } }, { parameters: { x_region: 'eu' } });
  // The host template sees the headers as they were when it ran (no x-tenant yet), the later query policy the header the
  // setheader policy set; the route policy changes path and method.
  assert.equal(req.method, 'POST');
  assert.equal(req.url, 'https://eu.example.test/v2/people/7?api-version=later');
  assert.deepEqual(JSON.parse(req.body), { first: 'Ada', last: 'Lovelace', name: 'Ada Lovelace' });
  const answer = applyResponsePolicies(connector, 'GetPeople', { statusCode: 200, headers: {}, body: {
    peopleArray: [{ Name: 'XYZ', Age: '30' }, { Name: 'ABC', Age: '23' }],
    sets: [{ people: { PQR: { Age: '32' } } }, { people: { MNO: { Age: '26' } } }] } });
  assert.deepEqual(answer.body.peopleObject, { XYZ: { Age: '30' }, ABC: { Age: '23' } });
  assert.deepEqual(answer.body.sets, [{ people: [{ Name: 'PQR', Details: { Age: '32' } }], tag: 'x' }, { people: [{ Name: 'MNO', Details: { Age: '26' } }], tag: 'x' }]);
  // A policy expression Learn does not list blocks the connector.
  assert.equal(compiled(OPENAPI, [policy('setheader', { name: 'x', value: '@unknownFunction()' }, 'Request')])[0].blocked.code, 'CONNECTOR_POLICY_UNSUPPORTED');
});

async function listen(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
const form = req => new Promise(resolve => { let text = ''; req.on('data', c => { text += c; }); req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(text)))); });

test('the authorization code flow signs in through the loopback redirect with PKCE and refreshes its token', async t => {
  const issued = [], challenges = new Map(), api = [];
  let generation = 0;
  const auth = await listen(t, async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/authorize') {
      challenges.set('invented-code', url.searchParams.get('code_challenge'));
      assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
      const back = new URL(url.searchParams.get('redirect_uri'));
      back.searchParams.set('code', 'invented-code'); back.searchParams.set('state', url.searchParams.get('state'));
      res.writeHead(302, { location: back.href }); return res.end();
    }
    const body = await form(req);
    issued.push(body);
    if (body.grant_type === 'authorization_code' && createHash('sha256').update(body.code_verifier).digest('base64url') !== challenges.get(body.code)) { res.writeHead(400); return res.end(); }
    generation++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ access_token: 'invented-access-' + generation, refresh_token: 'invented-refresh-' + generation, expires_in: 60, token_type: 'Bearer' }));
  });
  const service = await listen(t, (req, res) => { api.push(req.headers.authorization); res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}'); });
  const definition = { ...OPENAPI, securityDefinitions: { o: { type: 'oauth2', flow: 'accessCode', authorizationUrl: 'https://login.example.test/authorize', tokenUrl: 'https://login.example.test/token', scopes: { 'api://x/.default': 'invented' } } } };
  const list = compiled(definition);
  process.env.X_POLICY_CLIENT = 'invented-client';
  t.after(() => { delete process.env.X_POLICY_CLIENT; });
  let time = Date.parse('2026-01-01T00:00:00Z');
  const notes = [];
  const store = await new DataStore({ state: emptyState() }).init();
  const connectors = createConnectorRuntime({ store, customConnectors: () => list, clock: { now: () => time }, diagnostic: n => notes.push(n),
    connections: connectionSettings({ 'conn-oauth': { connector: NAME, provider: `custom-connector:${NAME}`, settings: { auth: { clientId: 'env:X_POLICY_CLIENT' },
      rewrites: { 'https://login.example.test/': auth + '/', 'https://api.example.test/v1/': service + '/' } } } }) });
  await assert.rejects(async () => connectors.invoke({ connectorId: NAME, operationId: 'GetPeople', connection: connectors.resolve({ connectorId: NAME, connectionId: 'conn-oauth' }), parameters: { id: '1' } }), { code: 'ConnectionUnauthorized' });

  const started = await connectors.oauth.authorize('conn-oauth');
  assert.match(started.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/callback$/);
  const page = await fetch(started.authorizeUrl); // the browser: the authorization server redirects to the loopback listener
  assert.equal(page.status, 200);
  const done = await started.completion;
  assert.equal(done.connectionId, 'conn-oauth');
  assert.deepEqual(issued[0], { grant_type: 'authorization_code', client_id: 'invented-client', code: 'invented-code', redirect_uri: started.redirectUri, code_verifier: issued[0].code_verifier });
  const status = connectors.oauth.status('conn-oauth');
  assert.deepEqual([status.signedIn, status.refreshable], [true, true]);
  assert.ok(!JSON.stringify(status).includes('invented-access'));
  assert.equal(store.state.simulator.connectionTokens['conn-oauth'].alg, 'A256GCM');
  assert.ok(!JSON.stringify(store.state).includes('invented-access') && !JSON.stringify(store.state).includes('invented-refresh'), 'tokens are sealed in state');

  await connectors.invoke({ connectorId: NAME, operationId: 'GetPeople', connection: connectors.resolve({ connectorId: NAME, connectionId: 'conn-oauth' }), parameters: { id: '1' } });
  time += 61000; // the access token expired: the refresh token grant runs once
  await connectors.invoke({ connectorId: NAME, operationId: 'GetPeople', connection: connectors.resolve({ connectorId: NAME, connectionId: 'conn-oauth' }), parameters: { id: '2' } });
  assert.deepEqual(api, ['Bearer invented-access-1', 'Bearer invented-access-2']);
  assert.deepEqual([issued[1].grant_type, issued[1].refresh_token, issued[1].scope], ['refresh_token', 'invented-refresh-1', 'api://x/.default']);
  assert.ok(!JSON.stringify(notes).includes('invented-access') && !JSON.stringify(notes).includes('invented-refresh'), 'no token in diagnostics');
});
