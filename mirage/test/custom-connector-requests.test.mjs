import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { inventoryEntry, mergeInventory } from '../lib/solution-inventory.mjs';
import { customConnectorsOf } from '../lib/custom-connector.mjs';
import { createConnectorRuntime, connectionSettings } from '../lib/connector-runtime.mjs';
import { executeFlowDefinition } from '../lib/flow-runtime.mjs';

// Tasks 53, 54, 42: request bodies by `consumes`, nextLink continuations, OAuth client credentials and response setheader.
const NAME = 'x_5ffxreq', AT = `Connectors/${NAME}/`;
const ok = { 200: { description: 'ok' } };
const OPENAPI = { swagger: '2.0', info: { title: 'Invented FX requests' }, host: 'api.example.test', basePath: '/v1', schemes: ['https'],
  securityDefinitions: { key: { type: 'apiKey', in: 'header', name: 'x-fx-key' } },
  paths: {
    '/items': { get: { operationId: 'ListItems', parameters: [], responses: ok } },
    '/forms': { post: { operationId: 'PostForm', consumes: ['application/x-www-form-urlencoded'], parameters: [{ name: 'x_name', in: 'formData', type: 'string', required: true }, { name: 'x_code', in: 'formData', type: 'string' }], responses: ok } },
    '/upload': { post: { operationId: 'Upload', consumes: ['multipart/form-data'], parameters: [{ name: 'x_file', in: 'formData', type: 'file', required: true }, { name: 'x_label', in: 'formData', type: 'string' }], responses: ok } },
  } };
const POLICIES = [
  { templateId: 'setheader', parameters: { 'x-ms-apimTemplateParameter.name': 'x-fx-client', 'x-ms-apimTemplateParameter.value': 'invented', 'x-ms-apimTemplate-policySection': 'Request' } },
  { templateId: 'setqueryparameter', parameters: { 'x-ms-apimTemplateParameter.name': 'api-version', 'x-ms-apimTemplateParameter.value': '2026-01-01', 'x-ms-apimTemplate-policySection': 'Request' } },
  { templateId: 'setheader', parameters: { 'x-ms-apimTemplateParameter.name': 'x-fx-seen', 'x-ms-apimTemplateParameter.value': "@headers('x-fx-origin')", 'x-ms-apimTemplate-policySection': 'Response' } },
];
const entry = (file, value) => inventoryEntry(AT + file, { size: 100, text: JSON.stringify(value), component: 'connector', componentName: NAME })[0];
const compiled = (doc = OPENAPI, policies = POLICIES) => customConnectorsOf(mergeInventory([entry(`${NAME}_openapidefinition.json`, doc), entry(`${NAME}_policytemplateinstances.json`, policies)]));

async function serve(t, handler) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    seen.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString('latin1') });
    const answer = handler(req, server.address().port);
    res.writeHead(answer.status ?? 200, { 'content-type': 'application/json', ...(answer.headers ?? {}) });
    res.end(JSON.stringify(answer.body ?? {}));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return { seen, origin: `http://127.0.0.1:${server.address().port}` };
}
const runtime = (origin, auth = { apiKey: 'env:X_FX_REQ_KEY' }, customConnectors = () => compiled(), extra = {}) => createConnectorRuntime({ ...extra, customConnectors,
  connections: connectionSettings({ [NAME]: { connector: NAME, provider: `custom-connector:${NAME}`, settings: { rewrites: { 'https://api.example.test/v1/': origin + '/', 'https://login.example.test/': origin + '/login/' }, auth } } }) });
process.env.X_FX_REQ_KEY = 'invented-key';

test('a body is sent as the operation consumes it: urlencoded, multipart, and any other media type blocks the connector', async t => {
  const { seen, origin } = await serve(t, () => ({ body: { ok: true } }));
  const connectors = runtime(origin);
  await connectors.invoke({ connectorId: NAME, operationId: 'PostForm', parameters: { x_name: 'a b', x_code: 'c&d' } });
  assert.equal(seen[0].headers['content-type'], 'application/x-www-form-urlencoded');
  assert.equal(seen[0].body, 'x_name=a+b&x_code=c%26d');
  await connectors.invoke({ connectorId: NAME, operationId: 'Upload', parameters: { x_file: { '$content-type': 'text/plain', $content: Buffer.from('invented').toString('base64') }, x_label: 'l1' } });
  const boundary = /^multipart\/form-data; boundary=(.+)$/.exec(seen[1].headers['content-type'])?.[1];
  assert.ok(boundary, seen[1].headers['content-type']);
  assert.match(seen[1].body, /name="x_file"; filename="x_file"\r\nContent-Type: text\/plain\r\n\r\ninvented\r\n/);
  assert.match(seen[1].body, /name="x_label"\r\n\r\nl1\r\n/);
  const xml = { ...OPENAPI, paths: { ...OPENAPI.paths, '/xml': { post: { operationId: 'PostXml', consumes: ['application/xml'], parameters: [{ name: 'doc', in: 'body', required: true, schema: { type: 'object' } }], responses: ok } } } };
  const [blocked] = compiled(xml);
  assert.equal(blocked.blocked.code, 'CONNECTOR_MEDIA_TYPE_UNSUPPORTED');
  await assert.rejects(async () => runtime(origin, undefined, () => [blocked]).invoke({ connectorId: NAME, operationId: 'PostXml', parameters: { doc: { x_a: 1 } } }), { status: 501, code: 'OperationUnsupported' });
  assert.equal(seen.length, 2);
});

test('a nextLink page carries the authentication and request policies, stays on the operation host and reports its own failure', async t => {
  let page2 = 200, foreign = false;
  const { seen, origin } = await serve(t, (req, port) => !req.headers['x-fx-key'] ? { status: 401, body: { error: 'unauthorized' } }
    : req.url.includes('page=2') ? { status: page2, body: { value: [{ x_id: 2 }] } }
      : { body: { value: [{ x_id: 1 }], '@odata.nextLink': `http://${foreign ? 'localhost' : '127.0.0.1'}:${port}/items?page=2` } });
  const flow = { triggers: { manual: { type: 'Request', kind: 'Button', inputs: { schema: {} } } }, actions: {
    List: { type: 'OpenApiConnection', runAfter: {}, runtimeConfiguration: { paginationPolicy: { minimumItemCount: 5 } }, inputs: { host: { apiId: `/providers/Microsoft.PowerApps/apis/${NAME}`, operationId: 'ListItems' }, parameters: {} } },
    Reply: { type: 'Response', runAfter: { List: ['Succeeded', 'Failed'] }, inputs: { statusCode: 200, body: { status: "@actions('List')?['status']", code: "@outputs('List')?['statusCode']", out: "@body('List')" } } } } };
  const answer = await executeFlowDefinition({ definition: flow, input: {}, connectors: runtime(origin) });
  assert.deepEqual(answer.body, { status: 'Succeeded', code: 200, out: { value: [{ x_id: 1 }, { x_id: 2 }] } });
  assert.deepEqual(seen.map(r => [r.url, r.headers['x-fx-key'], r.headers['x-fx-client']]),
    [['/items?api-version=2026-01-01', 'invented-key', 'invented'], ['/items?page=2&api-version=2026-01-01', 'invented-key', 'invented']]);
  page2 = 500;
  const failed = await executeFlowDefinition({ definition: flow, input: {}, connectors: runtime(origin) });
  assert.deepEqual([failed.body.status, failed.body.code], ['Failed', 500]);
  // A nextLink on another origin (localhost is not 127.0.0.1) is refused before anything is sent there.
  foreign = true;
  const before = seen.length;
  await assert.rejects(runtime(origin).invoke({ connectorId: NAME, operationId: 'ListItems', parameters: {}, pagination: { minimumItemCount: 5 } }), { status: 403, code: 'PermissionDenied' });
  assert.equal(seen.length, before + 1);
});

test('the OAuth client credentials flow acquires and caches a token; other flows answer 501; response setheader applies', async t => {
  let issued = 0;
  const { seen, origin } = await serve(t, req => req.url.startsWith('/login/') ? (issued++, { body: { access_token: 'invented-token-' + issued, token_type: 'Bearer', expires_in: 3600 } })
    : { headers: { 'x-fx-origin': 'svc' }, body: { value: [], '@odata.nextLink': 'https://api.example.test/v1/items?page=2&api-version=2025-01-01' } });
  process.env.X_FX_REQ_CLIENT = 'invented-client';
  process.env.X_FX_REQ_SECRET = 'invented-secret';
  t.after(() => { delete process.env.X_FX_REQ_CLIENT; delete process.env.X_FX_REQ_SECRET; });
  const oauth = flow => ({ ...OPENAPI, securityDefinitions: { o: { type: 'oauth2', flow, tokenUrl: 'https://login.example.test/token', authorizationUrl: 'https://login.example.test/authorize', scopes: { 'api://x/.default': 'invented' } } } });
  const notes = [];
  const list = compiled(oauth('application')); // the hosts memoise the compiled list, so the provider and its token cache persist
  const connectors = runtime(origin, { clientId: 'env:X_FX_REQ_CLIENT', clientSecret: 'env:X_FX_REQ_SECRET' }, () => list, { diagnostic: note => notes.push(note) });
  const first = await connectors.invoke({ connectorId: NAME, operationId: 'ListItems', parameters: {} });
  assert.equal(first.headers['x-fx-seen'], 'svc');
  await connectors.invoke({ connectorId: NAME, operationId: 'ListItems', parameters: {}, pagination: { minimumItemCount: 1, maxPages: 2 } });
  const token = seen.filter(r => r.url.startsWith('/login/'));
  assert.equal(token.length, 1);
  assert.deepEqual(Object.fromEntries(new URLSearchParams(token[0].body)), { grant_type: 'client_credentials', client_id: 'invented-client', client_secret: 'invented-secret', scope: 'api://x/.default' });
  const api = seen.filter(r => !r.url.startsWith('/login/'));
  assert.ok(api.every(r => r.headers.authorization === 'Bearer invented-token-1'));
  // The continuation keeps the nextLink's own api-version (a setqueryparameter policy fills only a missing parameter).
  assert.ok(api.some(r => r.url === '/items?page=2&api-version=2025-01-01'), api.map(r => r.url).join(' '));
  assert.ok(!JSON.stringify(notes).includes('invented-secret') && !JSON.stringify(notes).includes('invented-token'));
  const code = createConnectorRuntime({ customConnectors: () => compiled(oauth('accessCode')),
    connections: connectionSettings({ [NAME]: { connector: NAME, settings: { rewrites: { 'https://api.example.test/v1/': origin + '/' } } } }) });
  // Task 42: the authorization code flow runs locally; without a sign-in the call is unauthorized and names the sign-in route.
  await assert.rejects(code.invoke({ connectorId: NAME, operationId: 'ListItems', parameters: {} }), e => e.status === 401 && e.code === 'ConnectionUnauthorized' && /authorize/.test(e.message));
  assert.equal(compiled(oauth('implicit'))[0].blocked.code, 'CONNECTOR_AUTH_UNSUPPORTED');
});

test('a merged paging result keeps no body continuation when complete and the latest one when truncated (RB1-07)', async () => {
  const pack = { id: 'x-pages', connectors: { x_pages: { operations: { List: request => {
    const page = request.nextLink ? Number(request.nextLink.split('=')[1]) : 1;
    return { statusCode: 200, body: { value: [page], nextLink: `https://api.example.test/v1/items?page=${page + 1}`, '@odata.nextLink': `https://api.example.test/v1/items?page=${page + 1}` }, nextLink: `https://api.example.test/v1/items?page=${page + 1}` };
  } } } } };
  const connectors = createConnectorRuntime({ packs: [pack], connections: { x_pages: { connector: 'x_pages', provider: 'pack:x-pages' } } });
  const complete = await connectors.invoke({ connectorId: 'x_pages', operationId: 'List', pagination: { minimumItemCount: 3, maxPages: 5 } });
  assert.deepEqual(complete.body, { value: [1, 2, 3] });
  assert.equal(complete.nextLink, undefined);
  const truncated = await connectors.invoke({ connectorId: 'x_pages', operationId: 'List', pagination: { minimumItemCount: 9, maxPages: 2 } });
  assert.deepEqual([truncated.body.value, truncated.body.nextLink, truncated.body['@odata.nextLink'], truncated.nextLink],
    [[1, 2], ...Array(3).fill('https://api.example.test/v1/items?page=3')]);
});

test('an Http action nextLink on another origin is refused before its headers are sent there (RB1-05)', async t => {
  const other = await serve(t, () => ({ body: { value: [] } }));
  const { seen, origin } = await serve(t, () => ({ body: { value: [1], '@odata.nextLink': other.origin + '/steal' } }));
  const connectors = createConnectorRuntime();
  await assert.rejects(async () => connectors.invoke({ connectorId: 'http', operationId: 'Http', parameters: { method: 'GET', uri: origin + '/items', headers: { Authorization: 'Bearer invented-http-secret' } }, pagination: { minimumItemCount: 5 } }),
    { status: 403, code: 'PermissionDenied' });
  assert.deepEqual([seen.length, other.seen.length], [1, 0]);
});
