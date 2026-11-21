// End to end over HTTP: the auditing and file-limit facts a table or column carries, however it was defined (metadata
// API create and PUT, a Solution-imported table with fieldMetadata only), reach the audit functions and the file routes.
// @test-kind contract: Paqvilo's own metadata writes feed its own audit and file-size seams; no native capture is cited
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const APP = '55555555-5555-4555-8555-000000000017';
const CRM = 'Microsoft.Dynamics.CRM.';
const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
const column = (type, schema, extra = {}) => ({
  '@odata.type': `#${CRM}${type}AttributeMetadata`,
  SchemaName: schema,
  DisplayName: label(schema),
  ...extra,
});
const tableBody = (schema, extra = {}) => ({
  '@odata.type': `#${CRM}EntityMetadata`,
  SchemaName: schema,
  DisplayName: label(schema),
  DisplayCollectionName: label(`${schema}s`),
  OwnershipType: 'OrganizationOwned',
  IsActivity: false,
  HasActivities: false,
  HasNotes: false,
  Attributes: [column('String', 'fx_Name', { IsPrimaryName: true, MaxLength: 100, FormatName: { Value: 'Text' } })],
  ...extra,
});
// A PNG signature, so an image upload passes the content check and only its size decides.
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// A Solution-imported table: its columns are in fieldMetadata only (applySolutionData), with no mapping.fields.
function importedState() {
  const state = emptyState();
  state.mappings.fx_import = {
    logicalName: 'fx_import',
    entitySet: 'fx_imports',
    idColumn: 'fx_importid',
    nameColumn: 'fx_name',
    inferred: true,
    dataverseMetadata: { IsAuditEnabled: true },
    fieldMetadata: {
      fx_importid: { dataverseType: 'uniqueidentifier' },
      fx_name: { dataverseType: 'nvarchar', columnMetadata: { type: 'nvarchar', isAuditEnabled: true } },
    },
    relationships: {},
  };
  state.tables.fx_import = [];
  return state;
}

async function start(t) {
  const variable = `PAQ_FIX17_SECRET_${process.pid}`;
  process.env[variable] = 'invented-secret';
  const store = await new DataStore({ state: importedState() }).init();
  const settings = dataverseSettings({
    enabled: true,
    tds: { enabled: false },
    applications: [
      { appId: APP, displayName: 'Invented', secretEnvironmentVariable: variable, roles: ['System Administrator'] },
    ],
  });
  const api = await startDataverseApi({ store, settings, log: () => {} });
  ownedFixture(t).add(async () => {
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
  const request = async (method, suffix, body, headers = {}) => {
    const binary = Buffer.isBuffer(body);
    const response = await fetch(`${api.origin}/api/data/v9.2/${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': binary ? 'application/octet-stream' : 'application/json' }),
        ...headers,
      },
      body: body === undefined || binary ? body : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
  };
  const created = (response) => {
    assert.equal(response.status, 204, JSON.stringify(response.json));
    return /\(([0-9a-f-]{36})\)$/i.exec(response.headers.get('odata-entityid'))[1];
  };
  // Organization auditing on, as an administrator turns it on.
  await store.transact(() => {
    store.tableRows('organization')[0].isauditenabled = true;
  });
  const flush = async () => {
    await store.flushCommittedEvents();
    await store.queue;
  };
  return { api, store, request, created, flush };
}

test('a file or image column created or updated through the metadata API enforces its MaxSizeInKB', async (t) => {
  const { request, created } = await start(t);
  created(await request('POST', 'EntityDefinitions', tableBody('fx_Doc')));
  const attributes = "EntityDefinitions(LogicalName='fx_doc')/Attributes";
  created(await request('POST', attributes, column('File', 'fx_File', { MaxSizeInKB: 1 })));
  created(await request('POST', attributes, column('Image', 'fx_Picture', { MaxSizeInKB: 1 })));
  assert.equal((await request('GET', `${attributes}(LogicalName='fx_file')`)).json.MaxSizeInKB, 1);
  const id = created(await request('POST', 'fx_docs', { fx_name: 'one' }));
  const upload = (columnName, bytes) =>
    request('PATCH', `fx_docs(${id})/${columnName}`, bytes, { 'x-ms-file-name': `${columnName}.bin` });
  const file = await upload('fx_file', Buffer.alloc(3000, 1));
  assert.equal(file.status, 400, 'a 3,000-byte file exceeds MaxSizeInKB 1');
  assert.equal(file.json.error.message, 'Attachment file size is too big.');
  const image = await upload('fx_picture', Buffer.concat([PNG, Buffer.alloc(3000)]));
  assert.equal(image.status, 400, 'a 3,008-byte image exceeds MaxSizeInKB 1');
  assert.match(image.json.error.message, /^Error occured when processing image\. Reason: File size is too big\./);
  assert.equal((await upload('fx_file', Buffer.alloc(1000, 1))).status, 204, 'within the limit');
  // A chunked upload counts its blocks against the same limit.
  const session = await request('POST', 'InitializeFileBlocksUpload', {
    Target: { '@odata.type': `${CRM}fx_doc`, fx_docid: id },
    FileAttributeName: 'fx_file',
    FileName: 'big.bin',
  });
  assert.equal(session.status, 200, JSON.stringify(session.json));
  const block = await request('POST', 'UploadBlock', {
    BlockId: Buffer.from('block-1').toString('base64'),
    BlockData: Buffer.alloc(3000, 1).toString('base64'),
    FileContinuationToken: session.json.FileContinuationToken,
  });
  assert.equal(block.status, 400);
  assert.equal(block.json.error.message, 'Attachment file size is too big.');
  // A PUT raises the limit, and the same upload is accepted.
  const fileId = (await request('GET', `${attributes}(LogicalName='fx_file')?$select=MetadataId`)).json.MetadataId;
  assert.equal(
    (await request('PUT', `${attributes}(${fileId})`, { ...column('File', 'fx_File'), MaxSizeInKB: 4 })).status,
    204,
  );
  assert.equal((await upload('fx_file', Buffer.alloc(3000, 1))).status, 204);
});

test('IsAuditEnabled set on EntityDefinitions POST and PUT is kept and drives the audit rows', async (t) => {
  const { request, created, flush } = await start(t);
  created(await request('POST', 'EntityDefinitions', tableBody('fx_Audited', { IsAuditEnabled: { Value: true } })));
  const read = async (name) =>
    (await request('GET', `EntityDefinitions(LogicalName='${name}')?$select=IsAuditEnabled`)).json.IsAuditEnabled.Value;
  assert.equal(await read('fx_audited'), true);
  created(await request('POST', 'EntityDefinitions', tableBody('fx_Plain')));
  assert.equal(await read('fx_plain'), false);
  assert.equal(
    (
      await request('PUT', "EntityDefinitions(LogicalName='fx_plain')", {
        ...tableBody('fx_Plain'),
        IsAuditEnabled: { Value: true },
      })
    ).status,
    204,
  );
  assert.equal(await read('fx_plain'), true, 'a PUT turns table auditing on');
  // An audited column on the audited table: create and update write audit rows readable through all three functions.
  created(
    await request(
      'POST',
      "EntityDefinitions(LogicalName='fx_audited')/Attributes",
      column('String', 'fx_Code', { MaxLength: 20, FormatName: { Value: 'Text' }, IsAuditEnabled: { Value: true } }),
    ),
  );
  const id = created(await request('POST', 'fx_auditeds', { fx_name: 'A', fx_code: 'x' }));
  assert.equal((await request('PATCH', `fx_auditeds(${id})`, { fx_code: 'y' })).status, 204);
  await flush();
  const target = encodeURIComponent(JSON.stringify({ '@odata.id': `fx_auditeds(${id})` }));
  const records = await request('GET', `RetrieveRecordChangeHistory(Target=@t)?@t=${target}`);
  assert.equal(records.status, 200, JSON.stringify(records.json));
  assert.equal(records.json.AuditDetailCollection.AuditDetails.length, 2);
  const attribute = await request(
    'GET',
    `RetrieveAttributeChangeHistory(Target=@t,AttributeLogicalName='fx_code')?@t=${target}`,
  );
  assert.equal(attribute.status, 200, JSON.stringify(attribute.json));
  const [latest] = attribute.json.AuditDetailCollection.AuditDetails;
  assert.deepEqual([latest.OldValue.fx_code, latest.NewValue.fx_code], ['x', 'y']);
  const audits = (await request('GET', `audits?$filter=_objectid_value eq ${id}&$select=auditid`)).json.value;
  assert.equal(audits.length, 2);
  const detail = await request('GET', `audits(${audits[0].auditid})/${CRM}RetrieveAuditDetails()`);
  assert.equal(detail.status, 200, JSON.stringify(detail.json));
  assert.equal(detail.json.AuditDetail['@odata.type'], `#${CRM}AttributeAuditDetail`);
});

test('audit reads and writes work on a Solution-imported table that has fieldMetadata and no fields', async (t) => {
  const { request, created, flush } = await start(t);
  const id = created(await request('POST', 'fx_imports', { fx_name: 'before' }));
  assert.equal((await request('PATCH', `fx_imports(${id})`, { fx_name: 'after' })).status, 204);
  await flush();
  const target = encodeURIComponent(JSON.stringify({ '@odata.id': `fx_imports(${id})` }));
  const history = await request(
    'GET',
    `RetrieveAttributeChangeHistory(Target=@t,AttributeLogicalName='fx_name')?@t=${target}`,
  );
  assert.equal(history.status, 200, JSON.stringify(history.json));
  const [latest] = history.json.AuditDetailCollection.AuditDetails;
  assert.deepEqual([latest.OldValue.fx_name, latest.NewValue.fx_name], ['before', 'after']);
  const unknown = await request(
    'GET',
    `RetrieveAttributeChangeHistory(Target=@t,AttributeLogicalName='fx_missing')?@t=${target}`,
  );
  assert.equal(unknown.status, 400);
  assert.equal(unknown.json.error.message, 'fx_missing is not a valid attribute of fx_import.');
});

test('DeleteRecordChangeHistory takes the typed entity reference as well as @odata.id', async (t) => {
  const { request, created, flush } = await start(t);
  const first = created(await request('POST', 'fx_imports', { fx_name: 'one' }));
  const second = created(await request('POST', 'fx_imports', { fx_name: 'two' }));
  await flush();
  const typed = await request('POST', 'DeleteRecordChangeHistory', {
    Target: { '@odata.type': `${CRM}fx_import`, fx_importid: first },
  });
  assert.equal(typed.status, 200, JSON.stringify(typed.json));
  assert.equal(typed.json.DeletedEntriesCount, 1);
  const byId = await request('POST', 'DeleteRecordChangeHistory', { Target: { '@odata.id': `fx_imports(${second})` } });
  assert.equal(byId.json.DeletedEntriesCount, 1);
  const missingKey = await request('POST', 'DeleteRecordChangeHistory', {
    Target: { '@odata.type': `${CRM}fx_import` },
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.json.error.message, 'Target must be an entity reference.');
});
