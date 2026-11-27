// @test-kind unproven: the sharepointdocument rows Mirage lists from its SharePoint storage route; the hosted rows with the integration on were not capturable (hosted session F7 summary section 8)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EXTENSION } from '../lib/sharepoint-documents.mjs';
import { createLocalDiskStorage } from '../lib/storage-local-disk.mjs';
import { createStorageRouter, storageSettings } from '../lib/storage-provider.mjs';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { ownedFixture, makeTemporaryDirectory, removeFixtureDirectory } from '../testing/owned-fixture.mjs';
import { F7_CONTACT, F7_RECORD, F7_ROLE, writeHostedF7Site } from './parity/hosted-f7-fixture-site.mjs';

const CASE = '55555555-5555-4555-8555-555555555555';
const OTHER = '55555555-5555-4555-8555-555555555556';
const SITE = '66666666-6666-4666-8666-666666666666';
const ADMIN = { admin: true };
const mappings = {
  x_case: {
    logicalName: 'x_case',
    entitySet: 'x_cases',
    idColumn: 'x_caseid',
    nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  },
};
const tables = {
  x_case: [
    { x_caseid: CASE, x_name: 'Invented case', statecode: 0, statuscode: 1 },
    { x_caseid: OTHER, x_name: 'Invented other', statecode: 0, statuscode: 1 },
  ],
  sharepointsite: [{ sharepointsiteid: SITE, name: 'Default Site', isdefault: true, statecode: 0, statuscode: 1 }],
};

async function withStorage(t) {
  const owner = ownedFixture(t);
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'sharepoint-document-table-'));
  owner.remove(() => fs.rm(root, { recursive: true, force: true }));
  const local = createLocalDiskStorage({ root });
  const storage = createStorageRouter({ config: storageSettings({}), providers: { local } });
  const fixture = await contractModuleFixture(
    { after: (callback) => owner.add(callback) },
    { mappings, tables, extension: EXTENSION, options: { storage } },
  );
  owner.add(() => local.close());
  return fixture;
}

const prefer = { prefer: 'odata.include-annotations="*"' };

test('with the storage route a regarding read lists the record folder as sharepointdocument rows', async (t) => {
  const { api, request, json } = await withStorage(t);
  const sp = api.sharepoint;
  const { sharepointdocumentlocationid: id } = await sp.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, ADMIN);
  await sp.upload(id, { name: 'report.pdf', bytes: Buffer.from('invented bytes') }, ADMIN);
  await sp.createFolder(id, { path: [], name: 'Drafts' }, ADMIN);
  await sp.upload(id, { path: ['Drafts'], name: 'nested.txt', bytes: Buffer.from('x') }, ADMIN);
  const other = await sp.ensureLocation({ logicalName: 'x_case', id: OTHER }, {}, ADMIN);
  await sp.upload(other.sharepointdocumentlocationid, { name: 'elsewhere.txt', bytes: Buffer.from('y') }, ADMIN);

  const listed = await json(
    await request(
      'GET',
      `/sharepointdocuments?$select=fullname,isfolder,filesize,filetype,locationid&$filter=_regardingobjectid_value eq ${CASE}&$orderby=fullname`,
    ),
    200,
  );
  assert.deepEqual(
    listed.value.map(({ fullname, isfolder, filesize, filetype, locationid }) => ({
      fullname,
      isfolder,
      filesize,
      filetype,
      locationid,
    })),
    [
      { fullname: 'Drafts', isfolder: true, filesize: null, filetype: null, locationid: id },
      { fullname: 'report.pdf', isfolder: false, filesize: 14, filetype: 'pdf', locationid: id },
    ],
  );
  const xml = `<fetch><entity name="sharepointdocument"><attribute name="fullname"/><filter><condition attribute="regardingobjectid" operator="eq" value="${OTHER}"/></filter></entity></fetch>`;
  const fetched = await json(await request('GET', `/sharepointdocuments?fetchXml=${encodeURIComponent(xml)}`), 200);
  assert.deepEqual(
    fetched.value.map((row) => row.fullname),
    ['elsewhere.txt'],
  );
  // A read without a regarding condition stays empty, and /$count answers -1, as with the integration off.
  assert.deepEqual(
    (await json(await request('GET', '/sharepointdocuments?$select=fullname', undefined, prefer), 200)).value,
    [],
  );
  const count = await request('GET', '/sharepointdocuments/$count');
  assert.equal(await count.text(), '-1');
});

test('without the storage route the regarding read fails as the platform plug-in does', async (t) => {
  const { request, json } = await contractModuleFixture(
    { after: (callback) => ownedFixture(t).add(callback) },
    { mappings, tables, extension: EXTENSION, options: {} },
  );
  const failed = await json(
    await request('GET', `/sharepointdocuments?$filter=_regardingobjectid_value eq ${CASE}`, undefined, prefer),
    400,
  );
  assert.equal(failed.error.code, '0x80071017');
  assert.equal(
    failed.error['@Microsoft.PowerApps.CDS.ErrorDetails.ApiExceptionSourceKey'],
    'Plugin/Microsoft.Crm.ObjectModel.SharePointDocumentService',
  );
});

// @test-kind observation: hosted session F7 (2026-11-27) runs a and b, liquid-s0.json and liquid-s1-loc.json: with the integration off, {% fetchxml %} on sharepointdocument with a regarding condition prints the target-invocation error wherever its results are read, while the sharepointdocumentlocation query returns the record's location
test('Liquid FetchXML on sharepointdocument prints the target-invocation error with the integration off', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'sharepoint-document-liquid-'));
  ownedFixture(t).remove(() => removeFixtureDirectory(directory));
  const app = await createSimulator(await writeHostedF7Site(directory, 's1-loc-fields'));
  ownedFixture(t).add(() => app.close());
  const { cookie } = signInHeaders(app, F7_CONTACT, { roles: [F7_ROLE] });
  const response = await fetch(`${app.url}/pqf7-liquid/?id=${F7_RECORD}`, { headers: { cookie, accept: 'text/html' } });
  assert.equal(response.status, 200);
  const printed = /<pre id="pqf7-out">([\s\S]*?)<\/pre>/.exec(await response.text())?.[1];
  const error = 'Liquid error: Exception has been thrown by the target of an invocation.';
  assert.equal(
    printed.split('\n').slice(1).join('\n'),
    [
      '"locations":[{"name":"Documents on pqf7 lab site","relativeurl":"f7 a view first_F7F7F7F7000040008000000000001001","absoluteurl":"","parent":"pqf7_case"}],',
      '"locationsCount":"1",',
      `"documents":[${error}],`,
      `"documentsCount":"${error}",`,
      '"record":"f7 a view first"}',
    ].join('\n'),
  );
});

// @test-kind observation: Webapi/<table>/fields * refuses every read of the table as 403 90040122 naming no attribute (hosted session F1, pcf-parity summary-F.md section 1 and summary-A2.md, its probe tables; hosted session F7 api-s0, sharepointdocument and sharepointdocumentlocation)
test('a wildcard column list refuses any table as 403 90040122', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'sharepoint-document-wildcard-'));
  ownedFixture(t).remove(() => removeFixtureDirectory(directory));
  const options = await writeHostedF7Site(directory, 's0');
  await fs.appendFile(
    path.join(options.sourceDir, 'sitesetting.yml'),
    "- adx_name: Webapi/pqf7_case/fields\n  adx_value: '*'\n",
  );
  const app = await createSimulator({ ...options, observed: { evidence: 'Invented site without inner errors.' } });
  ownedFixture(t).add(() => app.close());
  const { cookie } = signInHeaders(app, F7_CONTACT, { roles: [F7_ROLE] });
  const response = await fetch(`${app.url}/_api/pqf7_cases(${F7_RECORD})?$select=pqf7_name`, {
    headers: { cookie, accept: 'application/json' },
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: { code: '90040122', message: 'You are unauthorized to process this request.' },
  });
});

// @test-kind security: listed sharepointdocument rows belong to the request that listed them: never stored, never seen by a later or concurrent read of another record
test('listed rows stay request-local: not stored, not seen by another record read or a concurrent request', async (t) => {
  const { api, store, request, json } = await withStorage(t);
  const sp = api.sharepoint;
  const mine = await sp.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, ADMIN);
  await sp.upload(mine.sharepointdocumentlocationid, { name: 'secret.txt', bytes: Buffer.from('s') }, ADMIN);
  const other = await sp.ensureLocation({ logicalName: 'x_case', id: OTHER }, {}, ADMIN);
  await sp.upload(other.sharepointdocumentlocationid, { name: 'other.txt', bytes: Buffer.from('o') }, ADMIN);
  const names = async (id) =>
    (
      await json(
        await request('GET', `/sharepointdocuments?$select=fullname&$filter=_regardingobjectid_value eq ${id}`),
        200,
      )
    ).value.map((row) => row.fullname);
  assert.deepEqual(await names(CASE), ['secret.txt']);
  assert.deepEqual(store.state.tables.sharepointdocument, [], 'nothing is stored');
  assert.deepEqual(store.tableRows('sharepointdocument'), [], 'outside a request no row is read');
  // A read without a regarding condition, and a regarding read of a record without a folder, see none of them.
  assert.deepEqual((await json(await request('GET', '/sharepointdocuments?$select=fullname'), 200)).value, []);
  assert.deepEqual(await names('55555555-5555-4555-8555-555555555559'), []);
  // Concurrent requests each read their own record's listing.
  for (let round = 0; round < 5; round++)
    assert.deepEqual(await Promise.all([names(CASE), names(OTHER)]), [['secret.txt'], ['other.txt']]);
});

// @test-kind security: an organization caller without Read on the regarding record or its location lists none of its documents, and a portal visitor needs the document control's list permissions (fail closed)
test('listed rows follow the regarding record and location Read rules on both paths', async (t) => {
  const { api, store } = await withStorage(t);
  const sp = api.sharepoint;
  const location = await sp.ensureLocation({ logicalName: 'x_case', id: CASE }, {}, ADMIN);
  await sp.upload(location.sharepointdocumentlocationid, { name: 'secret.txt', bytes: Buffer.from('s') }, ADMIN);
  // A location whose regardingobjectid is a bare id of another table never names this record.
  await store.transact(() => {
    store.state.tables.sharepointdocumentlocation.push({
      sharepointdocumentlocationid: '55555555-5555-4555-8555-55555555555a',
      name: 'Bare',
      relativeurl: 'bare',
      regardingobjectid: CASE,
      statecode: 0,
    });
  });
  const url = new URL(`http://invented.test/sharepointdocuments?$filter=_regardingobjectid_value eq ${CASE}`);
  const [source] = api.recordHooks
    .list('source')
    .filter((hook) => api.recordHooks.moduleOf(hook) === 'sharepoint-document-table');
  const organizationRows = (user) =>
    store.withRequestRows(async () => {
      await source({ user, url }, { logicalName: 'sharepointdocument' });
      return store.tableRows('sharepointdocument').map((row) => row.fullname);
    });
  const nobody = {
    systemuserid: '55555555-5555-4555-8555-55555555555b',
    fullname: 'Invented Nobody',
    isdisabled: false,
  };
  assert.deepEqual(await organizationRows(nobody), [], 'a user without Read lists nothing');
  assert.deepEqual(await organizationRows(undefined), [], 'no caller lists nothing');
  // The portal path: the document control's list rule (parent Read and Append To, Document Location Read).
  const portalRows = store.portalReadRowSources.get('sharepointdocument');
  const visitor = { id: 'contact-1', contactId: 'contact-1', roles: ['Member'] };
  const read = {
    table: 'sharepointdocuments',
    params: new URLSearchParams({ $filter: `_regardingobjectid_value eq ${CASE}` }),
  };
  store.state.settings = { ...store.state.settings, permissionMode: 'enforce' };
  const parent = { id: 'case', entity: 'x_case', scope: 'global', roles: ['Member'], operations: ['read', 'appendTo'] };
  const child = {
    id: 'docs',
    entity: 'sharepointdocumentlocation',
    scope: 'parent',
    roles: ['Member'],
    operations: ['read'],
    parentPermissionId: 'case',
    relationship: { entity: 'x_case', from: 'regardingobjectid', to: 'x_caseid' },
  };
  for (const [label, permissions, expected] of [
    ['no permission', [], []],
    ['parent only', [parent], []],
    ['parent and Document Location Read', [parent, child], ['secret.txt']],
  ]) {
    store.state.permissions = permissions;
    assert.deepEqual(
      (await portalRows(read, visitor)).map((row) => row.fullname),
      expected,
      label,
    );
  }
  // Another table's FetchXML is not parsed for this table.
  assert.equal(await portalRows({ fetchXml: '<fetch><entity name="x_case"/></fetch>' }, visitor), null);
});
