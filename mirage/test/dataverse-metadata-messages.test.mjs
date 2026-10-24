// Metadata messages (dataverse-metadata-messages.mjs): reference checks, autonumber seeds, key activation, languages,
// localized labels and translation files, called through the operation registry. The store is seeded with
// ensureSecurityModel, so privileges are the runtime shapes.
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import { EXTENSION } from '../lib/dataverse-metadata-messages.mjs';
import { createPrincipals, ensureSecurityModel } from '../lib/dataverse-security.mjs';
import { zipOf } from '../lib/dataverse-solutions.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const VERSION = 'v9.2';
const ORG = '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const CLERK_OID = 'bbbbbbbb-0000-4000-8000-000000000002';
const FORM_ID = '11111111-2222-4333-8444-555555555555';
const SOLUTION_ID = '22222222-2222-4333-8444-555555555555';
const WIDGET_ID = '33333333-2222-4333-8444-555555555555';
const SETTINGS = {
  organizationId: ORG,
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [
    { objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] },
    { objectId: CLERK_OID, upn: 'clerk@example.test', displayName: 'Clerk', roles: ['Basic User'] },
  ],
};

async function fixture() {
  const state = emptyState();
  state.mappings.new_widget = {
    logicalName: 'new_widget',
    entitySet: 'new_widgets',
    idColumn: 'new_widgetid',
    nameColumn: 'new_name',
    dataverseMetadata: { labels: { DisplayName: { 1033: 'Widget' } } },
    fields: {
      new_name: { dataverseType: 'nvarchar' },
      new_serial: { dataverseType: 'nvarchar', autoNumberFormat: 'INV-{SEQNUM:4}', autoNumberSeed: 1000 },
    },
    relationships: {},
  };
  state.tables.new_widget = [];
  state.mappings.new_owner = {
    logicalName: 'new_owner',
    entitySet: 'new_owners',
    idColumn: 'new_ownerid',
    nameColumn: 'new_name',
    fields: { new_name: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.tables.new_owner = [];
  // An intersect table: no relationship may name it as either side.
  state.mappings.new_owner_widget = {
    logicalName: 'new_owner_widget',
    entitySet: 'new_owner_widgets',
    idColumn: 'new_owner_widgetid',
    intersect: { entity: 'new_owner_widget' },
    fields: {},
    relationships: {},
  };
  state.tables.new_owner_widget = [];
  state.mappings.systemform = {
    logicalName: 'systemform',
    entitySet: 'systemforms',
    idColumn: 'formid',
    nameColumn: 'name',
    fields: { name: { dataverseType: 'nvarchar' }, description: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.tables.systemform = [{ formid: FORM_ID, name: 'Main form' }];
  state.tables.new_widget = [{ new_widgetid: WIDGET_ID, new_name: 'Widget one' }];
  state.tables.solution = [{ solutionid: SOLUTION_ID, uniquename: 'new_Invented' }];
  const store = new DataStore({ state });
  await ensureSecurityModel(store, SETTINGS);
  return store;
}

async function apiFor(settings = {}) {
  const store = await fixture();
  const api = {
    store,
    change: (fn) => fn(),
    settings: { organizationId: ORG, languagePacks: [1036], ...settings },
    schema: null,
    addRoute() {},
    registry: createOperationRegistry(),
    principals: createPrincipals(store, SETTINGS),
  };
  // A system job runs its work at once here; the real one runs on a later tick (dataverse-async.mjs).
  api.jobs = [];
  api.systemJob = async (spec, work) => {
    const id = randomUUID();
    api.jobs.push({ id, ...spec });
    await work();
    return id;
  };
  EXTENSION.install(api);
  return api;
}

const ADMIN = (api) => api.principals.byObjectId(ADMIN_OID);
const CLERK = (api) => api.principals.byObjectId(CLERK_OID);

// Calls a registered operation the way the router does: actions read the body, functions the URL parameters.
async function call(api, name, { body, params, caller = ADMIN(api) } = {}) {
  const op =
    api.registry.find({ name, kind: 'action', binding: 'unbound' }) ??
    api.registry.find({ name, kind: 'function', binding: 'unbound' }) ??
    api.registry.find({ name, kind: 'action', binding: 'collection', entity: 'solution' });
  assert.ok(op, `${name} is registered`);
  return op.handle({
    method: 'POST',
    body,
    params,
    user: caller,
    caller,
    api,
    origin: ORIGIN,
    version: VERSION,
    headers: {},
  });
}

// The entries of a zip written by zipOf (local headers carry the sizes), stored or deflated.
function zipEntries(buffer) {
  const entries = new Map();
  for (let p = 0; buffer.readUInt32LE(p) === 0x04034b50;) {
    const method = buffer.readUInt16LE(p + 8),
      size = buffer.readUInt32LE(p + 18);
    const nameLength = buffer.readUInt16LE(p + 26),
      extraLength = buffer.readUInt16LE(p + 28);
    const name = buffer.toString('utf8', p + 30, p + 30 + nameLength);
    const start = p + 30 + nameLength + extraLength;
    const data = buffer.subarray(start, start + size);
    entries.set(name, method === 8 ? inflateRawSync(data) : data);
    p = start + size;
  }
  return entries;
}
const unzipNames = (buffer) => [...zipEntries(buffer).keys()];
const unzipText = (buffer, name) => zipEntries(buffer).get(name).toString('utf8');

// Native binding of each metadata message: unbound action or function, ExportTranslation bound to the solution collection.
const BINDINGS = {
  action: [
    'CanBeReferenced',
    'CanBeReferencing',
    'CanManyToMany',
    'DeactivateEntityKey',
    'ReactivateEntityKey',
    'GetAutoNumberSeed',
    'GetNextAutoNumberValue',
    'SetAutoNumberSeed',
    'ProvisionLanguage',
    'ProvisionLanguageAsync',
    'DeprovisionLanguage',
    'SetLocLabels',
    'ImportTranslation',
    'ImportTranslationAsync',
    'ImportFieldTranslation',
  ],
  function: [
    'GetValidManyToMany',
    'GetValidReferencedEntities',
    'GetValidReferencingEntities',
    'RetrieveAvailableLanguages',
    'RetrieveDeprovisionedLanguages',
    'RetrieveInstalledLanguagePacks',
    'RetrieveInstalledLanguagePackVersion',
    'RetrieveProvisionedLanguagePackVersion',
    'RetrieveProvisionedLanguages',
    'RetrieveLocLabels',
    'ExportFieldTranslation',
  ],
};

test('PublishAllXmlAsync returns a publication system job and refuses a basic user before queueing', async () => {
  const api = await apiFor();
  const response = await call(api, 'PublishAllXmlAsync');
  assert.match(response.body.AsyncOperationId, /^[0-9a-f-]{36}$/);
  assert.equal(api.jobs[0].operationtype, 204);
  assert.equal(api.jobs[0].callerId, ADMIN(api).systemuserid);
  await assert.rejects(call(api, 'PublishAllXmlAsync', { caller: CLERK(api) }), (error) => error.status === 403);
  assert.equal(api.jobs.length, 1);
});

test('every metadata message is registered with its native binding and no other', async () => {
  const api = await apiFor();
  const kindsOf = (name) =>
    ['action', 'function'].filter((kind) => api.registry.find({ name, kind, binding: 'unbound' }));
  for (const [kind, names] of Object.entries(BINDINGS)) {
    for (const name of names) assert.deepEqual(kindsOf(name), [kind], name);
  }
  assert.ok(
    api.registry.find({ name: 'ExportTranslation', kind: 'action', binding: 'collection', entity: 'solution' }),
  );
  assert.deepEqual(kindsOf('ExportTranslation'), [], 'ExportTranslation is bound to the solution collection only');
});

test('CanBeReferenced and CanBeReferencing refuse intersect tables; CanManyToMany allows only standard tables', async () => {
  const api = await apiFor();
  assert.equal((await call(api, 'CanBeReferenced', { body: { EntityName: 'new_widget' } })).body.CanBeReferenced, true);
  assert.equal(
    (await call(api, 'CanBeReferenced', { body: { EntityName: 'new_owner_widget' } })).body.CanBeReferenced,
    false,
  );
  assert.equal(
    (await call(api, 'CanBeReferencing', { body: { EntityName: 'new_owner_widget' } })).body.CanBeReferencing,
    false,
  );
  assert.equal((await call(api, 'CanManyToMany', { body: { EntityName: 'new_owner' } })).body.CanManyToMany, true);
  assert.equal(
    (await call(api, 'CanManyToMany', { body: { EntityName: 'new_owner_widget' } })).body.CanManyToMany,
    false,
  );
});

test('GetValidManyToMany lists the standard tables, never the intersect table', async () => {
  const api = await apiFor();
  const { body } = await call(api, 'GetValidManyToMany');
  assert.ok(body.EntityNames.includes('new_widget') && body.EntityNames.includes('new_owner'));
  assert.ok(!body.EntityNames.includes('new_owner_widget'));
});

test('GetValidReferencedEntities and GetValidReferencingEntities answer from the table kinds', async () => {
  const api = await apiFor();
  const referenced = (
    await call(api, 'GetValidReferencedEntities', { params: { ReferencingEntityName: 'new_widget' } })
  ).body.EntityNames;
  assert.ok(referenced.includes('new_owner') && !referenced.includes('new_owner_widget'));
  const referencing = (
    await call(api, 'GetValidReferencingEntities', { params: { ReferencedEntityName: 'new_owner' } })
  ).body.EntityNames;
  assert.ok(referencing.includes('new_widget') && !referencing.includes('new_owner_widget'));
  const none = (
    await call(api, 'GetValidReferencedEntities', { params: { ReferencingEntityName: 'new_owner_widget' } })
  ).body.EntityNames;
  assert.deepEqual(none, []);
});

test('an unknown table is not found', async () => {
  const api = await apiFor();
  await assert.rejects(call(api, 'CanBeReferenced', { body: { EntityName: 'new_missing' } }), {
    status: 404,
    code: 'UnknownEntity',
  });
});

test('autonumber seed defaults to 1000, SetAutoNumberSeed moves the next value, and the record writer uses it', async () => {
  const api = await apiFor();
  assert.equal(
    (await call(api, 'GetAutoNumberSeed', { body: { EntityName: 'new_widget', AttributeName: 'new_serial' } })).body
      .AutoNumberSeedValue,
    1000,
  );
  const set = await call(api, 'SetAutoNumberSeed', {
    body: { EntityName: 'new_widget', AttributeName: 'new_serial', Value: 5000 },
  });
  assert.equal(set.status, 204);
  assert.equal(
    (await call(api, 'GetNextAutoNumberValue', { body: { EntityName: 'new_widget', AttributeName: 'new_serial' } }))
      .body.NextAutoNumberValue,
    5000,
  );
  // The next create takes the value and advances the counter.
  const row = {};
  api.store.applyAutoNumbers(api.store.state.mappings.new_widget, row);
  assert.equal(row.new_serial, 'INV-5000');
  assert.equal(
    (await call(api, 'GetNextAutoNumberValue', { body: { EntityName: 'new_widget', AttributeName: 'new_serial' } }))
      .body.NextAutoNumberValue,
    5001,
  );
});

test('SetAutoNumberSeed refuses a non-autonumber column and a basic user', async () => {
  const api = await apiFor();
  await assert.rejects(
    call(api, 'GetAutoNumberSeed', { body: { EntityName: 'new_widget', AttributeName: 'new_name' } }),
    /not an autonumber column/,
  );
  await assert.rejects(
    call(api, 'SetAutoNumberSeed', {
      body: { EntityName: 'new_widget', AttributeName: 'new_serial', Value: 7 },
      caller: CLERK(api),
    }),
    { status: 403, code: 'PrivilegeDenied', message: /missing prvWriteAttribute privilege/ },
  );
});

test('languages: the base language is provisioned; an installed pack can be provisioned and deprovisioned', async () => {
  const api = await apiFor();
  assert.deepEqual((await call(api, 'RetrieveProvisionedLanguages')).body.RetrieveProvisionedLanguages, [1033]);
  assert.deepEqual(
    (await call(api, 'RetrieveInstalledLanguagePacks')).body.RetrieveInstalledLanguagePacks,
    [1033, 1036],
  );
  assert.deepEqual((await call(api, 'RetrieveAvailableLanguages')).body.LocaleIds, [1033, 1036]);
  assert.equal((await call(api, 'ProvisionLanguage', { body: { Language: 1036 } })).status, 204);
  assert.deepEqual((await call(api, 'RetrieveProvisionedLanguages')).body.RetrieveProvisionedLanguages, [1033, 1036]);
  await assert.rejects(call(api, 'ProvisionLanguage', { body: { Language: 1036 } }), /already provisioned/);
  await assert.rejects(call(api, 'ProvisionLanguage', { body: { Language: 1040 } }), /not installed/);
  await call(api, 'DeprovisionLanguage', { body: { Language: 1036, CleanupLanguageRows: true } });
  assert.deepEqual((await call(api, 'RetrieveDeprovisionedLanguages')).body.RetrieveDeprovisionedLanguages, [1036]);
  assert.deepEqual((await call(api, 'RetrieveProvisionedLanguages')).body.RetrieveProvisionedLanguages, [1033]);
  await assert.rejects(call(api, 'DeprovisionLanguage', { body: { Language: 1033 } }), /base language/);
});

test('ProvisionLanguageAsync refuses a bad language now and provisions in a system job (operationtype 209)', async () => {
  const api = await apiFor();
  await assert.rejects(call(api, 'ProvisionLanguageAsync', { body: { Language: 1040 } }), /not installed/);
  const { body } = await call(api, 'ProvisionLanguageAsync', { body: { Language: 1036 } });
  assert.match(body.AsyncOperationId, /^[0-9a-f]{8}-/);
  assert.deepEqual(
    api.jobs.map((job) => [job.id, job.operationtype]),
    [[body.AsyncOperationId, 209]],
  );
  assert.ok((await call(api, 'RetrieveProvisionedLanguages')).body.RetrieveProvisionedLanguages.includes(1036));
});

test('PublishXml and PublishAllXml are declared with their native CSDL and keep the ParameterXml check', async () => {
  const api = await apiFor();
  const csdl = api.registry.csdlFragments();
  assert.match(csdl, /<Action Name="PublishAllXml" \/>/);
  assert.match(csdl, /<Action Name="PublishXml"><Parameter Name="ParameterXml" Type="Edm.String" Nullable="false"/);
  assert.equal((await call(api, 'PublishAllXml')).status, 204);
  assert.equal((await call(api, 'PublishXml', { body: { ParameterXml: '<importexportxml/>' } })).status, 204);
  await assert.rejects(call(api, 'PublishXml', { body: {} }), { status: 400 });
});

test('localized labels: SetLocLabels stores per LCID and RetrieveLocLabels reads them back', async () => {
  const api = await apiFor();
  const moniker = { '@odata.type': 'Microsoft.Dynamics.CRM.systemform', formid: FORM_ID };
  await call(api, 'ProvisionLanguage', { body: { Language: 1036 } });
  const set = await call(api, 'SetLocLabels', {
    body: {
      EntityMoniker: moniker,
      AttributeName: 'name',
      Labels: [
        { Label: 'Formulaire principal', LanguageCode: 1036 },
        { Label: 'Main form', LanguageCode: 1033 },
      ],
    },
  });
  assert.equal(set.status, 204);
  const { body } = await call(api, 'RetrieveLocLabels', {
    params: { EntityMoniker: moniker, AttributeName: 'name', IncludeUnpublished: false },
  });
  assert.equal(body.Label.UserLocalizedLabel.Label, 'Main form');
  assert.deepEqual(body.Label.LocalizedLabels.map((l) => [l.LanguageCode, l.Label]).sort(), [
    [1033, 'Main form'],
    [1036, 'Formulaire principal'],
  ]);
});

test('localized labels refuse an attribute Learn does not list, an unprovisioned language and a missing row', async () => {
  const api = await apiFor();
  const moniker = { '@odata.type': 'Microsoft.Dynamics.CRM.systemform', formid: FORM_ID };
  await assert.rejects(
    call(api, 'SetLocLabels', { body: { EntityMoniker: moniker, AttributeName: 'formxml', Labels: [] } }),
    /does not support localized labels/,
  );
  await assert.rejects(
    call(api, 'SetLocLabels', {
      body: { EntityMoniker: moniker, AttributeName: 'name', Labels: [{ Label: 'Bonjour', LanguageCode: 1036 }] },
    }),
    /not provisioned/,
  );
  const missing = {
    '@odata.type': 'Microsoft.Dynamics.CRM.systemform',
    formid: '44444444-2222-4333-8444-555555555555',
  };
  await assert.rejects(
    call(api, 'RetrieveLocLabels', { params: { EntityMoniker: missing, AttributeName: 'name' } }),
    /Could not find item/,
  );
});

test('ExportTranslation writes a zip whose CrmTranslations.xml ImportTranslation reads back', async () => {
  const api = await apiFor();
  const exported = await call(api, 'ExportTranslation', { body: { SolutionName: 'new_Invented' } });
  const zip = Buffer.from(exported.body.ExportTranslationFile, 'base64');
  assert.equal(zip.readUInt32LE(0), 0x04034b50, 'a zip archive');
  // Change the table label, then import the exported file: the original label comes back.
  api.store.state.mappings.new_widget.dataverseMetadata.labels.DisplayName = { 1033: 'Changed' };
  const imported = await call(api, 'ImportTranslation', {
    body: { TranslationFile: exported.body.ExportTranslationFile, ImportJobId: SOLUTION_ID },
  });
  assert.equal(imported.status, 204);
  assert.equal(api.store.state.mappings.new_widget.dataverseMetadata.labels.DisplayName[1033], 'Widget');
});

test('ExportTranslation writes SpreadsheetML with the Localized Labels header and one column per provisioned language', async () => {
  const api = await apiFor();
  const { body } = await call(api, 'ExportTranslation', { body: { SolutionName: 'new_Invented' } });
  const files = unzipNames(Buffer.from(body.ExportTranslationFile, 'base64'));
  assert.ok(files.includes('CrmTranslations.xml') && files.includes('[Content_Types].xml'));
  const xml = unzipText(Buffer.from(body.ExportTranslationFile, 'base64'), 'CrmTranslations.xml');
  assert.match(xml, /<\?mso-application progid="Excel.Sheet"\?>/);
  for (const sheet of ['Information', 'Display Strings', 'Localized Labels'])
    assert.match(xml, new RegExp(`ss:Name="${sheet}"`));
  assert.match(
    xml,
    /<Data ss:Type="String">Entity Name<\/Data><\/Cell><Cell><Data ss:Type="String">Object Type<\/Data>/,
  );
  assert.match(xml, /<Data ss:Type="String">1033<\/Data>/);
});

test('ImportTranslation refuses a zip without CrmTranslations.xml (0x80048061) and a non-workbook CrmTranslations.xml (0x80044249)', async () => {
  const api = await apiFor();
  const noTranslations = zipOf([{ name: '[Content_Types].xml', data: Buffer.from('<Types />') }]).toString('base64');
  await assert.rejects(
    call(api, 'ImportTranslation', { body: { TranslationFile: noTranslations, ImportJobId: SOLUTION_ID } }),
    { status: 400, details: { innerCode: '0x80048061' } },
  );
  const notWorkbook = zipOf([{ name: 'CrmTranslations.xml', data: Buffer.from('<other />') }]).toString('base64');
  await assert.rejects(
    call(api, 'ImportTranslation', { body: { TranslationFile: notWorkbook, ImportJobId: SOLUTION_ID } }),
    { status: 400, details: { innerCode: '0x80044249' } },
  );
});

test('ImportTranslationAsync parses the file now and imports in a system job (operationtype 210)', async () => {
  const api = await apiFor();
  const exported = await call(api, 'ExportTranslation', { body: { SolutionName: 'new_Invented' } });
  api.store.state.mappings.new_widget.dataverseMetadata.labels.DisplayName = { 1033: 'Changed' };
  const { body } = await call(api, 'ImportTranslationAsync', {
    body: { TranslationFile: exported.body.ExportTranslationFile, ImportJobId: SOLUTION_ID },
  });
  assert.deepEqual(
    api.jobs.map((job) => job.operationtype),
    [210],
  );
  assert.equal(body.AsyncOperationId, api.jobs[0].id);
  assert.equal(api.store.state.mappings.new_widget.dataverseMetadata.labels.DisplayName[1033], 'Widget');
});

test('ExportTranslation names a missing solution as not found', async () => {
  const api = await apiFor();
  await assert.rejects(call(api, 'ExportTranslation', { body: { SolutionName: 'new_Missing' } }), /does not exist/);
});

test('ImportTranslation refuses a label longer than 500 characters and a file that is not a zip archive', async () => {
  const api = await apiFor();
  api.store.state.mappings.new_widget.dataverseMetadata.labels.DisplayName = { 1033: 'x'.repeat(501) };
  const long = (await call(api, 'ExportTranslation', { body: { SolutionName: 'new_Invented' } })).body
    .ExportTranslationFile;
  await assert.rejects(
    call(api, 'ImportTranslation', { body: { TranslationFile: long, ImportJobId: SOLUTION_ID } }),
    /longer than 500/,
  );
  await assert.rejects(
    call(api, 'ImportTranslation', {
      body: { TranslationFile: Buffer.from('not a zip').toString('base64'), ImportJobId: SOLUTION_ID },
    }),
    { status: 400, message: /not a zip archive/ },
  );
});

test('ExportFieldTranslation carries the row labels written by SetLocLabels and ImportFieldTranslation reads them back', async () => {
  const api = await apiFor();
  const moniker = { '@odata.type': 'Microsoft.Dynamics.CRM.systemform', formid: FORM_ID };
  await call(api, 'ProvisionLanguage', { body: { Language: 1036 } });
  await call(api, 'SetLocLabels', {
    body: {
      EntityMoniker: moniker,
      AttributeName: 'description',
      Labels: [{ Label: 'Description FR', LanguageCode: 1036 }],
    },
  });
  const exported = await call(api, 'ExportFieldTranslation', { params: {} });
  const zip = Buffer.from(exported.body.ExportTranslationFile, 'base64');
  assert.ok(zip.includes(Buffer.from('CrmFieldTranslations.xml')));
  // Remove the label, then import the export: it is back.
  api.store.state.dataverse.locLabels = {};
  const imported = await call(api, 'ImportFieldTranslation', {
    body: { TranslationFile: exported.body.ExportTranslationFile },
  });
  assert.match(imported.body.importjobid, /^[0-9a-f]{8}-/);
  const { body } = await call(api, 'RetrieveLocLabels', {
    params: { EntityMoniker: moniker, AttributeName: 'description' },
  });
  assert.deepEqual(
    body.Label.LocalizedLabels.map((l) => [l.LanguageCode, l.Label]),
    [[1036, 'Description FR']],
  );
});

test('DeactivateEntityKey fails an Active key; ReactivateEntityKey needs a failed key and queues an index job (operationtype 63)', async () => {
  const api = await apiFor();
  const key = { name: 'new_widget_code', schemaName: 'new_WidgetCode', attributes: ['new_name'] };
  api.store.state.mappings.new_widget.alternateKeys = [key];
  const body = { EntityKeyLogicalName: 'new_widget_code', EntityLogicalName: 'new_widget' };
  await assert.rejects(call(api, 'ReactivateEntityKey', { body }), {
    status: 400,
    details: { innerCode: '0x80060897' },
  });
  assert.equal((await call(api, 'DeactivateEntityKey', { body })).status, 204);
  assert.equal(key.indexStatus, 'Failed');
  await assert.rejects(call(api, 'DeactivateEntityKey', { body }), {
    status: 400,
    details: { innerCode: '0x8009050B' },
  });
  assert.equal((await call(api, 'ReactivateEntityKey', { body })).status, 204);
  assert.equal(key.indexStatus, 'Active');
  assert.equal(key.deactivated, false);
  assert.deepEqual(
    api.jobs.map((job) => job.operationtype),
    [63],
  );
  assert.equal(key.asyncJob, api.jobs[0].id);
  await assert.rejects(
    call(api, 'DeactivateEntityKey', { body: { ...body, EntityKeyLogicalName: 'new_absent' } }),
    /Could not find the key/,
  );
});

test('language pack versions answer the organization version and refuse a pack that is not installed', async () => {
  const api = await apiFor({ version: '9.2.25041.00000' });
  await assert.rejects(
    call(api, 'RetrieveInstalledLanguagePackVersion', { params: { Language: 1040 } }),
    /not installed/,
  );
  assert.equal(
    (await call(api, 'RetrieveInstalledLanguagePackVersion', { params: { Language: 1036 } })).body.Version,
    '9.2.25041.00000',
  );
  assert.equal(
    (await call(api, 'RetrieveProvisionedLanguagePackVersion', { params: { Language: 1033 } })).body.Version,
    '9.2.25041.00000',
  );
});
