// @test-kind observation: hosted session F7 (2026-11-27) relationships-1795734331127.json: document management on a table creates <table>_SharePointDocumentLocations with Cascade Assign, Delete and Share, applied here from the Solution inference to the records
// The document location cascade a document-managed table gets from its Solution (solution-schema.mjs inference, applied
// through importSolutionData): deleting, reassigning and sharing a record reach its own locations only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importSolutionData } from '../lib/solution-data.mjs';
import { EXTENSION } from '../lib/dataverse-cascade.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { systemUserMapping } from './support/parent-child-tables.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const CASE = '57575757-0000-4000-8000-000000000001';
const OTHER_CASE = '57575757-0000-4000-8000-000000000002';
const USER_ONE = '57575757-0000-4000-8000-0000000000a1';
const USER_TWO = '57575757-0000-4000-8000-0000000000a2';
const location = (n) => `57575757-0000-4000-8000-00000000010${n}`;
const owner = (id) => ({ id, logical_name: 'systemuser', name: 'Invented user' });

const attribute = (name, type) =>
  `<attribute PhysicalName="${name}"><Type>${type}</Type><Name>${name}</Name><LogicalName>${name}</LogicalName></attribute>`;
const entity = (name, extra = '') =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><attributes>${attribute(`${name}id`, 'primarykey')}${attribute('x_name', 'nvarchar')}${attribute('ownerid', 'owner')}</attributes><EntitySetName>${name}s</EntitySetName>${extra}</entity></EntityInfo></Entity>`;

// The columns the requests write, declared as the record layer reads them.
const withColumns = (mapping) => ({
  ...mapping,
  fields: { ...mapping.fields, x_name: { dataverseType: 'nvarchar' }, ownerid: { dataverseType: 'owner' } },
});

async function documentManagedOrganization(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'sharepoint-document-cascade-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedDocs</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_case/Entity.xml': entity('x_case', '<IsDocumentManagementEnabled>1</IsDocumentManagementEnabled>'),
    'Entities/x_other/Entity.xml': entity('x_other'),
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  const { mappings } = await importSolutionData([root]);
  const locationMapping = {
    ...mappings.sharepointdocumentlocation,
    logicalName: 'sharepointdocumentlocation',
    entitySet: 'sharepointdocumentlocations',
    idColumn: 'sharepointdocumentlocationid',
    nameColumn: 'name',
    fields: {
      ...mappings.sharepointdocumentlocation?.fields,
      name: { dataverseType: 'nvarchar' },
      regardingobjectid: { dataverseType: 'lookup' },
      ownerid: { dataverseType: 'owner' },
    },
  };
  const row = (n, regardingobjectid) => ({
    sharepointdocumentlocationid: location(n),
    name: `Location ${n}`,
    regardingobjectid,
    ownerid: owner(USER_ONE),
    statecode: 0,
    statuscode: 1,
  });
  const fixture = await contractModuleFixture(
    { after: (callback) => ownedFixture(t).add(callback) },
    {
      mappings: {
        systemuser: systemUserMapping(),
        x_case: withColumns(mappings.x_case),
        x_other: withColumns(mappings.x_other),
        sharepointdocumentlocation: locationMapping,
      },
      tables: {
        systemuser: [
          { systemuserid: USER_ONE, fullname: 'Invented one', statecode: 0 },
          { systemuserid: USER_TWO, fullname: 'Invented two', statecode: 0 },
        ],
        x_case: [
          { x_caseid: CASE, x_name: 'Invented case', ownerid: owner(USER_ONE), statecode: 0, statuscode: 1 },
          { x_caseid: OTHER_CASE, x_name: 'Other case', ownerid: owner(USER_ONE), statecode: 0, statuscode: 1 },
        ],
        // A row of another table with the same id as the case.
        x_other: [{ x_otherid: CASE, x_name: 'Same id elsewhere', ownerid: owner(USER_ONE), statecode: 0 }],
        sharepointdocumentlocation: [
          row(1, { id: CASE, logical_name: 'x_case', name: 'Invented case' }),
          row(2, { id: OTHER_CASE, logical_name: 'x_case', name: 'Other case' }),
          row(3, { id: CASE, logical_name: 'x_other', name: 'Same id elsewhere' }),
          // A bare id: it names no table, so it is no location of the case.
          row(4, CASE),
        ],
      },
      extension: EXTENSION,
    },
  );
  return { ...fixture, relationship: mappings.x_case.relationships.x_case_SharePointDocumentLocations };
}
const remaining = (store) =>
  store.state.tables.sharepointdocumentlocation.map((row) => row.sharepointdocumentlocationid).sort();

test('deleting a document-managed record deletes its own document locations only', async (t) => {
  const { request, store, relationship } = await documentManagedOrganization(t);
  assert.equal(relationship.cascade.delete, 'Cascade');
  assert.equal((await request('DELETE', `/x_cases(${CASE})`)).status, 204);
  assert.deepEqual(remaining(store), [location(2), location(3), location(4)]);
});

test('reassigning and sharing a document-managed record reach its own document locations only', async (t) => {
  const { request, json, store } = await documentManagedOrganization(t);
  await json(await request('PATCH', `/x_cases(${CASE})`, { 'ownerid@odata.bind': `/systemusers(${USER_TWO})` }), 200);
  const ownerOf = (n) =>
    store.state.tables.sharepointdocumentlocation.find((row) => row.sharepointdocumentlocationid === location(n))
      .ownerid.id;
  assert.deepEqual([1, 2, 3, 4].map(ownerOf), [USER_TWO, USER_ONE, USER_ONE, USER_ONE]);
  const shared = await request('POST', '/GrantAccess', {
    Target: { '@odata.type': 'Microsoft.Dynamics.CRM.x_case', x_caseid: CASE },
    PrincipalAccess: {
      Principal: { '@odata.type': 'Microsoft.Dynamics.CRM.systemuser', systemuserid: USER_ONE },
      AccessMask: 'ReadAccess',
    },
  });
  assert.equal(shared.status, 204, await shared.clone().text());
  const inherited = (n) =>
    Number(
      (store.state.tables.principalobjectaccess ?? []).find(
        (entry) => String(entry.objectid).toLowerCase() === location(n) && entry.principalid?.id === USER_ONE,
      )?.inheritedaccessrightsmask ?? 0,
    );
  assert.deepEqual([1, 2, 3, 4].map(inherited), [1, 0, 0, 0]);
});
