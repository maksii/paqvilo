import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createSharePointContractRoutes,
  createSharePointFixtureServer,
  sharePointContractDescriptor,
  validateSharePointFixtures,
} from '../lib/sharepoint-contract.mjs';

const fixtures = {
  sites: { 'site-a': { name: 'Invented site' } },
  drives: { 'drive-a': { siteId: 'site-a' } },
  items: [
    { driveId: 'drive-a', path: 'x_case/Case one/notes.txt', content: 'hello', contentType: 'text/plain' },
    { driveId: 'drive-a', path: 'x_case/Empty', folder: true },
  ],
};
const base = '/v1.0/sites/site-a/drives/drive-a';

async function server(t, diagnostics = []) {
  const fixture = await createSharePointFixtureServer({ fixtures, diagnostic: (entry) => diagnostics.push(entry) });
  t.after(() => fixture.close());
  const call = async (method, path, { body, headers } = {}) => {
    const response = await fetch(fixture.url + path, { method, headers, body, signal: AbortSignal.timeout(10000) });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null };
  };
  return { ...fixture, call };
}

test('list children answers Graph-shaped driveItems', async (t) => {
  const { call } = await server(t);
  const listed = await call('GET', `${base}/root:/x_case:/children`);
  assert.equal(listed.status, 200);
  const names = listed.body.value.map((item) => item.name).sort();
  assert.deepEqual(names, ['Case one', 'Empty']);
  const folder = listed.body.value.find((item) => item.name === 'Case one');
  assert.deepEqual(folder.folder, { childCount: 1 });
  assert.equal(folder.parentReference.driveId, 'drive-a');
  const files = await call('GET', `${base}/root:/x_case/Case%20one:/children`);
  assert.equal(files.body.value[0].file.mimeType, 'text/plain');
  assert.equal(files.body.value[0].size, 5);
  assert.match(files.body.value[0].eTag, /^".+"$/);
});

test('upload creates then replaces, and If-Match guards the replace', async (t) => {
  const { call } = await server(t);
  const created = await call('PUT', `${base}/root:/x_case/Empty/a.txt:/content`, {
    body: 'one',
    headers: { 'content-type': 'text/plain' },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.size, 3);
  const replaced = await call('PUT', `${base}/root:/x_case/Empty/a.txt:/content`, {
    body: 'two!',
    headers: { 'if-match': created.body.eTag },
  });
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.id, created.body.id);
  assert.notEqual(replaced.body.eTag, created.body.eTag);
  const stale = await call('PUT', `${base}/root:/x_case/Empty/a.txt:/content`, {
    body: 'x',
    headers: { 'if-match': created.body.eTag },
  });
  assert.equal(stale.status, 412);
  assert.equal(stale.body.error.code, 'resourceModified');
  const failed = await call('PUT', `${base}/root:/x_case/Empty/a.txt:/content?@microsoft.graph.conflictBehavior=fail`, {
    body: 'x',
  });
  assert.equal(failed.status, 409);
});

test('create folder honours conflictBehavior and delete honours If-Match', async (t) => {
  const { call } = await server(t);
  const created = await call('POST', `${base}/root:/x_case:/children`, {
    body: JSON.stringify({ name: 'New', folder: {} }),
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(created.status, 201);
  assert.deepEqual(created.body.folder, { childCount: 0 });
  const conflict = await call('POST', `${base}/root:/x_case:/children`, {
    body: JSON.stringify({ name: 'new', folder: {} }),
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.error.code, 'nameAlreadyExists');
  const renamed = await call('POST', `${base}/root:/x_case:/children`, {
    body: JSON.stringify({ name: 'New', folder: {}, '@microsoft.graph.conflictBehavior': 'rename' }),
  });
  assert.equal(renamed.body.name, 'New 1');
  const stale = await call('DELETE', `${base}/items/${created.body.id}`, { headers: { 'if-match': '"{other},1"' } });
  assert.equal(stale.status, 412);
  assert.equal(
    (await call('DELETE', `${base}/items/${created.body.id}`, { headers: { 'if-match': created.body.eTag } })).status,
    204,
  );
  assert.equal((await call('DELETE', `${base}/items/${created.body.id}`)).status, 404);
});

test('unknown paths, drives and operations answer Graph errors', async (t) => {
  const diagnostics = [];
  const { call } = await server(t, diagnostics);
  const missing = await call('GET', `${base}/root:/nowhere:/children`);
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.code, 'itemNotFound');
  assert.equal((await call('GET', '/v1.0/sites/site-b/drives/drive-a/root:/x_case:/children')).status, 404);
  for (let i = 0; i < 2; i++) {
    const unsupported = await call('GET', `${base}/items/abc/versions`);
    assert.equal(unsupported.status, 501);
    assert.equal(unsupported.body.error.innerError.code, 'ProviderOperationUnsupported');
  }
  assert.equal(diagnostics.filter((entry) => entry.code === 'SHAREPOINT_CONTRACT_UNSUPPORTED').length, 1);
});

test('a malformed percent-escape answers 400 and the fixture server keeps answering', async (t) => {
  const { call } = await server(t);
  const malformed = await call('GET', `${base}/root:/%E0:/children`);
  assert.equal(malformed.status, 400);
  assert.equal(malformed.body.error.code, 'invalidRequest');
  assert.equal((await call('GET', `${base}/root:/x_case:/children`)).status, 200);
});

test('the fixture server takes its clock and ids from the injected seam', async (t) => {
  const { fixedClock, sequentialIds } = await import('../lib/runtime-clock.mjs');
  const clock = fixedClock();
  const fixture = await createSharePointFixtureServer({ fixtures, clock, ids: sequentialIds() });
  t.after(() => fixture.close());
  const response = await fetch(fixture.url + `${base}/root:/x_case:/children`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Fresh', folder: {} }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.createdDateTime, new Date(clock.now()).toISOString());
  assert.match(created.id, /^[0-9A-F]{32}$/);
});

test('routes answer the same listing in process, without a server', () => {
  const routes = createSharePointContractRoutes({ fixtures });
  const list = routes.find((route) => route.operation === 'listChildren');
  assert.equal(list.method, 'GET');
  const answer = list.handle({ method: 'GET', url: `${base}/root:/x_case:/children`, headers: {} });
  assert.equal(answer.status, 200);
  assert.deepEqual(answer.body.value.map((item) => item.name).sort(), ['Case one', 'Empty']);
});

test('fixture validation refuses undeclared sites, traversal, unknown keys, duplicates and non-loopback hosts; the descriptor is contract level', async () => {
  assert.deepEqual(validateSharePointFixtures(undefined), { sites: {}, drives: {}, items: [] });
  assert.throws(() => validateSharePointFixtures({ drives: { d: { siteId: 'nope' } } }), /declared site/);
  assert.throws(
    () => validateSharePointFixtures({ ...fixtures, items: [{ driveId: 'drive-a', path: '../x' }] }),
    /\.\./,
  );
  assert.throws(() => validateSharePointFixtures({ extra: 1 }), /Unknown/);
  assert.throws(
    () => createSharePointContractRoutes({ fixtures: { ...fixtures, items: [fixtures.items[0], fixtures.items[0]] } }),
    /twice/,
  );
  await assert.rejects(createSharePointFixtureServer({ fixtures, host: '0.0.0.0' }), /loopback/);
  assert.equal(sharePointContractDescriptor.level, 'contract');
  assert.deepEqual(sharePointContractDescriptor.requires, ['connection:sharepoint']);
  assert.deepEqual(
    [...sharePointContractDescriptor.operations],
    ['listChildren', 'uploadContent', 'createFolder', 'deleteItem'],
  );
});
