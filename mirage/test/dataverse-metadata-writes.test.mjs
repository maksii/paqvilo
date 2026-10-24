// Metadata ids of solution components, upsert locations, secured primary names and $batch metadata writes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import '../lib/provider-modules.mjs';

const APP = '77777777-7777-4777-8777-777777777777', NOBODY = '77777777-7777-4777-8777-7777777777b1';
const SOLUTION = { solutionid: '77777777-7777-4777-8777-7777777777a1', uniquename: 'x_sol', friendlyname: 'x_sol', version: '1.0', ismanaged: false };

async function start(t, state, users = []) {
  const store = await new DataStore({ state }).init();
  const secret = `METADATA_WRITES_${process.pid}_${Math.random().toString(36).slice(2).toUpperCase()}`;
  process.env[secret] = 's';
  t.after(() => { delete process.env[secret]; });
  const server = await startDataverseApi({ store, extensions: EXTENSIONS, log: () => {}, settings: dataverseSettings({ enabled: true,
    applications: [{ appId: APP, displayName: 'a', secretEnvironmentVariable: secret, roles: ['System Administrator'] }], users }) });
  t.after(() => server.close());
  const token = (await (await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: APP, client_secret: 's', scope: `${server.origin}/.default` }) })).json()).access_token;
  const call = async (method, path, body, headers = {}) => {
    const r = await fetch(`${server.origin}/api/data/v9.2${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : body && JSON.stringify(body) });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch {}
    return { status: r.status, headers: r.headers, text, json };
  };
  return { store, server, call };
}

test('a mixed-case key and a global choice resolve by their MetadataId and join the solution as rows', async (t) => {
  const state = emptyState();
  state.mappings.x_widget = { logicalName: 'x_widget', entitySet: 'x_widgets', idColumn: 'x_widgetid', nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' }, x_code: { dataverseType: 'nvarchar' } }, alternateKeys: [{ name: 'x_Code_Key', attributes: ['x_code'] }] };
  state.tables.x_widget = [];
  state.tables.solution = [{ ...SOLUTION }];
  state.dataverse = { globalOptionSets: { x_MixedSet: { name: 'x_MixedSet', type: 'picklist', MetadataId: '11111111-1111-4111-8111-111111111111', options: [{ value: 1, label: 'One' }] } } };
  const { store, call } = await start(t, state);
  const component = (id) => store.state.tables.solutioncomponent.find(r => r.solutioncomponentid === id);
  const key = (await call('GET', "/EntityDefinitions(LogicalName='x_widget')?$select=MetadataId&$expand=Keys($select=MetadataId,LogicalName)")).json.Keys[0];
  const added = await call('POST', '/AddSolutionComponent', { ComponentId: key.MetadataId, ComponentType: 14, SolutionUniqueName: 'x_sol', AddRequiredComponents: false });
  assert.equal(added.status, 200, added.text);
  assert.equal(component(added.json.id)?.componenttype, 14, 'a key writes a solutioncomponent row (never id null)');
  assert.equal(component(added.json.id).objectid, key.MetadataId);
  const set = (await call('GET', "/GlobalOptionSetDefinitions(Name='x_MixedSet')")).json;
  assert.notEqual(set.MetadataId, '11111111-1111-4111-8111-111111111111', 'the reader answers the derived id, not a stored one');
  const setAdded = await call('POST', '/AddSolutionComponent', { ComponentId: set.MetadataId, ComponentType: 9, SolutionUniqueName: 'x_sol', AddRequiredComponents: false });
  assert.equal(setAdded.status, 200, setAdded.text);
  assert.equal(component(setAdded.json.id)?.componenttype, 9);
  assert.equal(component(setAdded.json.id).objectid, set.MetadataId);
});

test('an upsert answers the stored row location; an If-Match:* update keeps the addressed key', async (t) => {
  const A = '77777777-7777-4777-8777-7777777777c1';
  const state = emptyState();
  state.mappings.x_item = { logicalName: 'x_item', entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' }, x_code: { dataverseType: 'nvarchar' } }, alternateKeys: [{ name: 'x_code_key', attributes: ['x_code'] }] };
  state.tables.x_item = [{ x_itemid: A, x_name: 'Alpha', x_code: 'A1' }];
  const { store, call } = await start(t, state);
  const created = await call('PATCH', "/x_items(x_code='N1')", { x_code: 'B2', x_name: 'Beta' });
  assert.equal(created.status, 204);
  const location = created.headers.get('odata-entityid');
  assert.equal(created.headers.get('location'), location);
  const path = location.slice(location.indexOf('/x_items'));
  const got = await call('GET', `${path}?$select=x_code`);
  assert.equal(got.status, 200, `the location names the stored row: ${location}`);
  assert.equal(got.json.x_code, 'B2');
  const same = await call('PATCH', "/x_items(x_code='A1')", { x_name: 'Alpha 2' });
  assert.match(same.headers.get('odata-entityid'), /x_items\(x_code='A1'\)$/, 'the URL key still names the row it holds');
  const update = await call('PATCH', "/x_items(x_code='A1')", { x_code: 'Z9' }, { 'if-match': '*' });
  assert.equal(update.status, 204);
  assert.equal(store.state.tables.x_item.find(r => r.x_itemid === A).x_code, 'A1', 'the addressed key value is dropped (same rule as Upsert)');
});

test('metadata that secures a primary name column is refused at load', async (t) => {
  const state = emptyState();
  state.mappings.x_item = { logicalName: 'x_item', entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar', columnMetadata: { isSecured: true } } } };
  state.tables.x_item = [];
  await assert.rejects(start(t, state), /primary name column x_name of table x_item can't be secured/);
});

const L = (t) => ({ LocalizedLabels: [{ Label: t, LanguageCode: 1033 }] });
const table = (s) => ({ '@odata.type': '#Microsoft.Dynamics.CRM.EntityMetadata', SchemaName: s, DisplayName: L(s), DisplayCollectionName: L(`${s}s`), Description: L(''),
  OwnershipType: 'UserOwned', IsActivity: false, HasNotes: false, HasActivities: false,
  Attributes: [{ '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata', SchemaName: `${s}_Name`, IsPrimaryName: true, MaxLength: 100, FormatName: { Value: 'Text' }, DisplayName: L('Name') }] });

test('a metadata write in a $batch changeset commits with it and rolls back with it; part impersonation applies', async (t) => {
  const { store, server, call } = await start(t, emptyState(), [{ objectId: NOBODY, fullname: 'No Roles', domainname: 'n@example.test', roles: [] }]);
  const CRLF = '\r\n';
  const part = (id, method, path, json, extra = []) => ['Content-Type: application/http', 'Content-Transfer-Encoding: binary', `Content-ID: ${id}`, '',
    `${method} ${server.origin}/api/data/v9.2/${path} HTTP/1.1`, ...extra, 'Content-Type: application/json', '', JSON.stringify(json)].join(CRLF);
  const mp = (b, parts) => `${parts.map(x => `--${b}${CRLF}${x}`).join(CRLF)}${CRLF}--${b}--`;
  const changeset = (parts) => ['Content-Type: multipart/mixed; boundary=cc', '', mp('cc', parts)].join(CRLF);
  const batch = (parts) => call('POST', '/$batch', mp('bb', [changeset(parts)]), { 'content-type': 'multipart/mixed; boundary=bb' });
  const ok = await batch([part('1', 'POST', 'EntityDefinitions', table('new_good'))]);
  assert.equal(ok.status, 200, ok.text);
  assert.equal(store.state.mappings.new_good?.logicalName, 'new_good', 'the changeset created the table');
  const failed = await batch([part('1', 'POST', 'EntityDefinitions', table('new_gone')), part('2', 'POST', 'new_nothings', { name: 'x' })]);
  assert.notEqual(failed.status, 200);
  assert.match(failed.text, /Content-ID: 2\r\n\r\nHTTP\/1\.1 404 Not Found[\s\S]*"code":"0x80060888"/, 'the failing part answers its own error');
  assert.equal(store.state.mappings.new_gone, undefined, 'the table rolls back with the changeset');
  assert.equal((await call('GET', "/EntityDefinitions(LogicalName='new_gone')")).status, 404);
  const denied = await batch([part('1', 'POST', 'EntityDefinitions', table('new_denied'), [`CallerObjectId: ${NOBODY}`])]);
  assert.match(denied.text, /0x80040220/);
  assert.equal(store.state.mappings.new_denied, undefined);
});
