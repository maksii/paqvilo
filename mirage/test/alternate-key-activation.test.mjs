// Alternate key index jobs (Learn define-alternate-keys-entity#monitor-index-creation-for-alternate-keys).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { failDuplicateSeededKeys } from '../lib/dataverse-metadata-tables.mjs';

const APP = '55555555-5555-4555-8555-555555555555';
const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
const column = (schema, extra = {}) => ({ '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata', SchemaName: schema, DisplayName: label(schema), FormatName: { Value: 'Text' }, MaxLength: 50, ...extra });

let counter = 0;
async function server(t, state = emptyState()) {
  const variable = `PAQ_KEY_SECRET_${process.pid}_${++counter}`; process.env[variable] = 'invented-secret';
  const store = await new DataStore({ state }).init();
  const settings = dataverseSettings({ enabled: true, tds: { enabled: false }, applications: [{ appId: APP, displayName: 'Invented', secretEnvironmentVariable: variable, roles: ['System Administrator'] }] });
  const api = await startDataverseApi({ store, settings, log: () => {} });
  t.after(async () => { delete process.env[variable]; await api.close(); });
  const token = (await (await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, { method: 'POST',
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: APP, client_secret: 'invented-secret', scope: `${api.origin}/.default` }) })).json()).access_token;
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(`${api.origin}/api/data/v9.2${path}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  return { store, request };
}

async function table(host, codes, headers = {}) {
  assert.equal((await host.request('POST', '/EntityDefinitions', { '@odata.type': '#Microsoft.Dynamics.CRM.EntityMetadata', SchemaName: 'fx_Dupe', DisplayName: label('Dupe'),
    DisplayCollectionName: label('Dupes'), OwnershipType: 'OrganizationOwned', IsActivity: false, HasActivities: false, HasNotes: false,
    Attributes: [column('fx_Name', { IsPrimaryName: true, MaxLength: 100 })] }, headers)).status, 204);
  assert.equal((await host.request('POST', "/EntityDefinitions(LogicalName='fx_dupe')/Attributes", column('fx_Code'), headers)).status, 204);
  for (const [index, code] of codes.entries()) assert.equal((await host.request('POST', '/fx_dupes', { fx_name: `row ${index}`, fx_code: code })).status, 204);
}
const keyRow = (host) => host.store.state.mappings.fx_dupe.alternateKeys.find((key) => key.name === 'fx_codekey');
async function settled(host) {
  for (let i = 0; i < 200; i++) {
    const key = keyRow(host);
    const job = key?.asyncJob && host.store.state.tables.asyncoperation.find((row) => row.asyncoperationid === key.asyncJob);
    if (job?.statecode === 3) return { key, job };
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('The index job did not complete.');
}
const createKey = (host, headers = {}) => host.request('POST', "/EntityDefinitions(LogicalName='fx_dupe')/Keys", { SchemaName: 'fx_CodeKey', KeyAttributes: ['fx_code'], DisplayName: label('Code') }, headers);
const status = async (host) => (await host.request('GET', "/EntityDefinitions(LogicalName='fx_dupe')/Keys?$select=LogicalName,EntityKeyIndexStatus")).json.value[0].EntityKeyIndexStatus;

test('creating a key over duplicate values ends Failed with a failed index job that names the duplicates', async (t) => {
  const host = await server(t);
  // Collation equality: 'a' and 'A ' are not duplicates of each other, 'A' and 'a' are.
  await table(host, ['A', 'a', 'B']);
  assert.equal((await createKey(host)).status, 204);
  const { job } = await settled(host);
  assert.equal(await status(host), 'Failed');
  assert.equal(job.statuscode, 31);
  assert.equal(job.name, 'Create index for fx_CodeKey for table fx_dupe');
  assert.match(job.message, /fx_code: \(A\)/);
});

test('a Failed key neither resolves a key segment nor enforces uniqueness', async (t) => {
  const host = await server(t);
  await table(host, ['A', 'A']);
  await createKey(host);
  await settled(host);
  assert.equal(await status(host), 'Failed');
  assert.equal((await host.request('GET', "/fx_dupes(fx_code='A')")).status, 400);
  assert.equal((await host.request('POST', '/fx_dupes', { fx_name: 'third', fx_code: 'A' })).status, 204);
});

// A seeded table (Solution source, state or pack rows) whose declared key already has duplicate values.
function seededState(codes) {
  const state = emptyState();
  state.mappings.fx_seeded = { logicalName: 'fx_seeded', entitySet: 'fx_seededs', idColumn: 'fx_seededid', nameColumn: 'fx_name',
    fields: { fx_name: { dataverseType: 'nvarchar' }, fx_code: { dataverseType: 'nvarchar' } }, alternateKeys: [{ name: 'fx_codekey', attributes: ['fx_code'] }] };
  state.tables.fx_seeded = codes.map((code, index) => ({ fx_seededid: `77777777-7777-4777-8777-77777777770${index}`, fx_name: `row ${index}`, fx_code: code }));
  return state;
}

test('a seeded key over duplicate rows is Failed with ALTERNATE_KEY_DUPLICATES, never Active', async (t) => {
  const diagnostics = [];
  const api = { store: { state: seededState(['A', 'a', 'B']) } };
  failDuplicateSeededKeys(api, (diagnostic) => diagnostics.push(diagnostic));
  assert.equal(api.store.state.mappings.fx_seeded.alternateKeys[0].indexStatus, 'Failed');
  assert.deepEqual(diagnostics.map((d) => [d.code, d.entity, d.key, d.duplicates]), [['ALTERNATE_KEY_DUPLICATES', 'fx_seeded', 'fx_codekey', [['A']]]]);
  const unique = { store: { state: seededState(['A', 'B']) } };
  failDuplicateSeededKeys(unique);
  assert.equal(unique.store.state.mappings.fx_seeded.alternateKeys[0].indexStatus, undefined);

  const host = await server(t, seededState(['A', 'A']));
  const keys = (await host.request('GET', "/EntityDefinitions(LogicalName='fx_seeded')/Keys?$select=LogicalName,EntityKeyIndexStatus")).json.value;
  assert.deepEqual(keys.map((key) => key.EntityKeyIndexStatus), ['Failed']);
  assert.equal((await host.request('GET', "/fx_seededs(fx_code='A')")).status, 400);
});

test('creating a key over unique values goes Pending, then Active when its job completes', async (t) => {
  const host = await server(t);
  await table(host, ['A', 'B', null]);
  await createKey(host);
  assert.ok(['Pending', 'Active'].includes(keyRow(host).indexStatus));
  const { job } = await settled(host);
  assert.equal(job.statuscode, 30);
  assert.equal(await status(host), 'Active');
});

test('ReactivateEntityKey after the duplicate is fixed makes a Failed key Active', async (t) => {
  const host = await server(t);
  await table(host, ['A', 'A']);
  await createKey(host);
  await settled(host);
  const failedJob = keyRow(host).asyncJob;
  const twin = host.store.state.tables.fx_dupe[1].fx_dupeid;
  const patched = await host.request('PATCH', `/fx_dupes(${twin})`, { fx_code: 'C' });
  assert.equal(patched.status, 204, JSON.stringify(patched.json));
  assert.equal((await host.request('POST', '/ReactivateEntityKey', { EntityLogicalName: 'fx_dupe', EntityKeyLogicalName: 'fx_codekey' })).status, 204);
  for (let i = 0; i < 200 && keyRow(host).asyncJob === failedJob; i++) await new Promise((resolve) => setTimeout(resolve, 10));
  await settled(host);
  assert.equal(await status(host), 'Active');
});

test('an imported key over existing duplicate rows is Failed', async (t) => {
  const src = await server(t);
  await src.request('POST', '/publishers', { uniquename: 'fx_pub', friendlyname: 'FX', customizationprefix: 'fx', customizationoptionvalueprefix: 10000 });
  const pub = (await src.request('GET', "/publishers?$select=publisherid&$filter=uniquename eq 'fx_pub'")).json.value[0].publisherid;
  await src.request('POST', '/solutions', { uniquename: 'fx_keys', friendlyname: 'fx_keys', version: '1.0.0.0', 'publisherid@odata.bind': `/publishers(${pub})` });
  const H = { 'MSCRM.SolutionUniqueName': 'fx_keys' };
  await table(src, [], H);
  const exportOf = async () => Buffer.from((await src.request('POST', '/ExportSolution', { SolutionName: 'fx_keys', Managed: false })).json.ExportSolutionFile, 'base64').toString('base64');
  const first = await exportOf();
  await createKey(src, H);
  const second = await exportOf();
  const dst = await server(t);
  assert.equal((await dst.request('POST', '/ImportSolution', { CustomizationFile: first })).status, 204);
  for (const code of ['A', 'A']) await dst.request('POST', '/fx_dupes', { fx_name: code, fx_code: code });
  assert.equal((await dst.request('POST', '/ImportSolution', { CustomizationFile: second })).status, 204);
  await settled(dst);
  assert.equal(await status(dst), 'Failed');
});
