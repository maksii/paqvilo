// Ownership of managed components: components of a managed solution are not edited or deleted directly; a customizable
// one takes an unmanaged layer on top; uninstall removes them.
import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { readSolutionZip } from '../lib/solution-schema.mjs';
import { zipOf } from '../lib/dataverse-solutions.mjs';

const APP = '55555555-5555-4555-8555-555555555555';
const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
const column = (schema, extra = {}) => ({
  '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata',
  SchemaName: schema,
  DisplayName: label(schema),
  FormatName: { Value: 'Text' },
  ...extra,
});
const tableBody = (schema) => ({
  '@odata.type': '#Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: schema,
  DisplayName: label(schema),
  DisplayCollectionName: label(schema + 's'),
  Description: label(''),
  OwnershipType: 'OrganizationOwned',
  IsActivity: false,
  HasActivities: false,
  HasNotes: false,
  Attributes: [column('fx_Name', { IsPrimaryName: true, MaxLength: 100 })],
});

let counter = 0;
async function server(owner) {
  const variable = `PAQ_OWNERSHIP_SECRET_${process.pid}_${++counter}`;
  process.env[variable] = 'invented-secret';
  const store = await new DataStore({ state: emptyState() }).init();
  const settings = dataverseSettings({
    enabled: true,
    tds: { enabled: false },
    applications: [
      { appId: APP, displayName: 'Invented', secretEnvironmentVariable: variable, roles: ['System Administrator'] },
    ],
  });
  const api = await startDataverseApi({ store, settings, log: () => {} });
  owner.after(async () => {
    delete process.env[variable];
    await api.close();
  });
  const token = (
    await (
      await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: APP,
          client_secret: 'invented-secret',
          scope: `${api.origin}/.default`,
        }),
      })
    ).json()
  ).access_token;
  const request = async (method, path, body, headers = {}) => {
    const response = await fetch(`${api.origin}/api/data/v9.2${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null };
  };
  return { store, request };
}

// A managed fx_base with fx_widget (fx_code customizable, fx_note not customizable) and the key fx_codekey, exported once
// per file and imported into a new organization by each test.
let zip;
before(async () => {
  const closers = [];
  const src = await server({ after: (fn) => closers.push(fn) });
  await src.request('POST', '/publishers', {
    uniquename: 'fx_pub',
    friendlyname: 'Fx',
    customizationprefix: 'fx',
    customizationoptionvalueprefix: 10000,
  });
  const pub = (await src.request('GET', "/publishers?$select=publisherid&$filter=uniquename eq 'fx_pub'")).json.value[0]
    .publisherid;
  await src.request('POST', '/solutions', {
    uniquename: 'fx_base',
    friendlyname: 'fx_base',
    version: '1.0.0.0',
    'publisherid@odata.bind': `/publishers(${pub})`,
  });
  const H = { 'MSCRM.SolutionUniqueName': 'fx_base' };
  await src.request('POST', '/EntityDefinitions', tableBody('fx_widget'), H);
  for (const name of ['fx_Code', 'fx_Note'])
    await src.request(
      'POST',
      "/EntityDefinitions(LogicalName='fx_widget')/Attributes",
      column(name, { MaxLength: 20 }),
      H,
    );
  assert.equal(
    (
      await src.request(
        'POST',
        "/EntityDefinitions(LogicalName='fx_widget')/Keys",
        { SchemaName: 'fx_CodeKey', KeyAttributes: ['fx_code'], DisplayName: label('Code') },
        H,
      )
    ).status,
    204,
  );
  const exported = Buffer.from(
    (await src.request('POST', '/ExportSolution', { SolutionName: 'fx_base', Managed: true })).json.ExportSolutionFile,
    'base64',
  );
  zip = zipOf(
    readSolutionZip(exported).map((entry) => ({
      name: entry.name,
      data: Buffer.from(
        entry.xml != null
          ? entry.xml.replace(/(<attribute PhysicalName="fx_Note">)/i, '$1<IsCustomizable>0</IsCustomizable>')
          : entry.read(),
      ),
    })),
  );
  for (const close of closers) await close();
});

async function managedImport(t) {
  const dst = await server(t);
  assert.equal(
    (await dst.request('POST', '/ImportSolution', { CustomizationFile: zip.toString('base64') })).status,
    204,
  );
  const idOf = async (name) =>
    (
      await dst.request(
        'GET',
        `/EntityDefinitions(LogicalName='fx_widget')/Attributes(LogicalName='${name}')?$select=MetadataId`,
      )
    ).json.MetadataId;
  return { dst, idOf };
}

test('managed-imported tables, columns and keys report IsManaged and refuse DELETE with 0x8004F013', async (t) => {
  const { dst, idOf } = await managedImport(t);
  assert.equal(
    (await dst.request('GET', "/EntityDefinitions(LogicalName='fx_widget')?$select=IsManaged")).json.IsManaged,
    true,
  );
  assert.equal(
    (
      await dst.request(
        'GET',
        "/EntityDefinitions(LogicalName='fx_widget')/Attributes(LogicalName='fx_code')?$select=IsManaged",
      )
    ).json.IsManaged,
    true,
  );
  const keys = (
    await dst.request(
      'GET',
      "/EntityDefinitions(LogicalName='fx_widget')/Keys?$select=LogicalName,IsManaged,MetadataId",
    )
  ).json.value;
  assert.deepEqual(
    keys.map((key) => [key.LogicalName, key.IsManaged]),
    [['fx_codekey', true]],
  );
  const column = await dst.request(
    'DELETE',
    `/EntityDefinitions(LogicalName='fx_widget')/Attributes(${await idOf('fx_note')})`,
  );
  assert.equal(column.status, 400);
  assert.equal(column.json.error.code, '0x8004f013');
  const key = await dst.request('DELETE', `/EntityDefinitions(LogicalName='fx_widget')/Keys(${keys[0].MetadataId})`);
  assert.equal(key.json.error.code, '0x8004f013');
  const table = await dst.request('DELETE', "/EntityDefinitions(LogicalName='fx_widget')");
  assert.equal(table.json.error.code, '0x8004f013');
  assert.ok(dst.store.state.mappings.fx_widget?.fields?.fx_note);
  // The uninstall owns the layer: it removes the components.
  assert.equal((await dst.request('POST', '/UninstallSolutionAsync', { SolutionUniqueName: 'fx_base' })).status, 200);
  for (let i = 0; i < 100 && dst.store.state.mappings.fx_widget; i++)
    await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(dst.store.state.mappings.fx_widget, undefined);
});

test('a customizable managed column takes PUT as an unmanaged layer that RemoveActiveCustomization removes', async (t) => {
  const { dst, idOf } = await managedImport(t);
  const id = await idOf('fx_code');
  assert.equal(
    (
      await dst.request('PUT', `/EntityDefinitions(LogicalName='fx_widget')/Attributes(${id})`, {
        ...column('fx_Code', { MaxLength: 60 }),
        LogicalName: 'fx_code',
      })
    ).status,
    204,
  );
  const read = async () =>
    (
      await dst.request(
        'GET',
        "/EntityDefinitions(LogicalName='fx_widget')/Attributes(LogicalName='fx_code')/Microsoft.Dynamics.CRM.StringAttributeMetadata?$select=MaxLength,IsManaged",
      )
    ).json;
  assert.equal((await read()).MaxLength, 60);
  assert.equal(
    (await dst.request('POST', '/RemoveActiveCustomization', { LogicalName: 'attribute', Id: id })).json.Success,
    true,
  );
  assert.deepEqual([(await read()).MaxLength, (await read()).IsManaged], [20, true]);
});

test('a managed column that is not customizable refuses PUT', async (t) => {
  const { dst, idOf } = await managedImport(t);
  const put = await dst.request(
    'PUT',
    `/EntityDefinitions(LogicalName='fx_widget')/Attributes(${await idOf('fx_note')})`,
    { ...column('fx_Note', { MaxLength: 60 }), LogicalName: 'fx_note' },
  );
  assert.equal(put.status, 400);
  assert.equal(put.json.error.code, '0x80047008');
});

test('a table created outside a managed solution reports IsManaged false and is deletable', async (t) => {
  const src = await server(t);
  await src.request('POST', '/EntityDefinitions', tableBody('fx_plain'));
  assert.equal(
    (await src.request('GET', "/EntityDefinitions(LogicalName='fx_plain')?$select=IsManaged")).json.IsManaged,
    false,
  );
  assert.equal((await src.request('DELETE', "/EntityDefinitions(LogicalName='fx_plain')")).status, 204);
});
