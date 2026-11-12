// @test-kind contract: multi-select writes of Paqvilo's own shell and portal runtime on invented choice fixtures
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createWebApiFormatter } from '../lib/webapi-format.mjs';
import { compileOperator } from '../lib/dataverse-conditions.mjs';
import { validateValues } from '../lib/model-driven/data.mjs';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { multiSelectValues } from '../lib/platform.mjs';
import { attributeEntry } from '../lib/native-services.mjs';
import { buildCatalog, projectRow } from '../lib/dataverse-tds-catalog.mjs';
import { liquidRecord, choiceColumnsOf } from '../lib/liquid.mjs';
import { formatOutput } from '../lib/liquid-engine.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { NS } from '../lib/dataverse-soap-xml.mjs';
import { ensureSecurityModel, createPrincipals } from '../lib/dataverse-security.mjs';
import { createRecordHandlers, createRecordHooks } from '../lib/dataverse-records.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import { runAtomic } from '../lib/dataverse-api.mjs';

const field = {
  name: 'x_choices',
  label: 'Choices',
  type: 'multiselect',
  dataverseType: 'multiselectpicklist',
  options: [
    { value: 1, label: 'One' },
    { value: 2, label: 'Two' },
  ],
};

test('multiselect shell writes validate all selections and normalize at the Dataverse boundary', () => {
  const table = { fields: { x_choices: field } };
  assert.deepEqual(validateValues(table, { x_choices: [2, 1, 2] }, 'update'), { x_choices: '2,1' });
  assert.deepEqual(validateValues(table, { x_choices: [] }, 'update'), { x_choices: null });
  assert.deepEqual(validateValues(table, { x_choices: null }, 'update'), { x_choices: null });
  for (const value of [[3], ['1'], [1.5], '1,2', [1, null]])
    assert.throws(() => validateValues(table, { x_choices: value }, 'update'), /known choice values/);
  assert.throws(
    () => validateValues({ fields: { x_choices: { ...field, required: true } } }, { x_choices: [] }, 'create'),
    /required/,
  );
});

test('a portal write stores a multi-select value in the canonical form the Dataverse Web API stores', async () => {
  const store = new DataStore({
    state: {
      mappings: {
        contact: {
          entitySet: 'contacts',
          idColumn: 'contactid',
          fields: { hobbies: { dataverseType: 'multiselectpicklist', options: [{ value: 1 }, { value: 2 }] } },
        },
      },
      tables: { contact: [] },
      permissions: [{ entity: 'contact', operations: ['read', 'create'], roles: ['Member'], scope: 'global' }],
    },
  });
  const admin = { admin: true };
  const portalWrite = { coerce: true, portalRequest: true };
  await store.create('contacts', { hobbies: '1,1, 2' }, admin, portalWrite);
  await store.create('contacts', { hobbies: [2, 1] }, admin, portalWrite);
  assert.deepEqual(
    store.snapshot().tables.contact.map((row) => row.hobbies),
    ['1,2', '2,1'],
  );
});

test('boolean metadata choice values retain boolean form writes for both option labels', () => {
  const table = {
    fields: {
      x_approved: {
        name: 'x_approved',
        label: 'Approved',
        type: 'boolean',
        dataverseType: 'bit',
        options: [
          { value: 0, label: 'No' },
          { value: 1, label: 'Yes' },
        ],
      },
    },
  };
  assert.deepEqual(validateValues(table, { x_approved: false }, 'update'), { x_approved: false });
  assert.deepEqual(validateValues(table, { x_approved: true }, 'update'), { x_approved: true });
  assert.deepEqual(
    validateValues(
      {
        fields: {
          x_approved: {
            ...table.fields.x_approved,
            options: [
              { value: false, label: 'No' },
              { value: true, label: 'Yes' },
            ],
          },
        },
      },
      { x_approved: false },
      'update',
    ),
    { x_approved: false },
  );
  assert.throws(() => validateValues(table, { x_approved: 1 }, 'update'), /boolean/);
});

test('imported multiselect metadata round trips through the shared organization pipeline', async (t) => {
  const fixture = await modelDrivenFixture(t, { defer: true });
  const file = path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml');
  const xml = await fs.readFile(file, 'utf8');
  await fs.writeFile(
    file,
    xml.replace(
      '</attributes>',
      '<attribute PhysicalName="x_choices"><Name>x_choices</Name><LogicalName>x_choices</LogicalName><Type>multiselectpicklist</Type><optionset Name="x_choices"><options><option value="1"><labels><label description="One" languagecode="1033"/></labels></option><option value="2"><labels><label description="Two" languagecode="1033"/></labels></option></options></optionset></attribute></attributes>',
    ),
  );
  const sim = await fixture.start();
  const origin = sim.url;
  const catalogue = await (await fetch(origin + '/_apps/api')).json();
  assert.equal(catalogue.tables.x_item.fields.x_choices.type, 'multiselect');
  assert.equal(catalogue.tables.x_item.entitySet, 'x_items');
  const headers = { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf };
  const response = await fetch(origin + '/_apps/api/tables/x_item', {
    method: 'POST',
    headers,
    body: JSON.stringify({ x_name: 'Choices round trip', x_choices: [2, 1] }),
  });
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.row.x_choices, '2,1');
  const id = created.row.x_itemid;
  const invalid = await fetch(origin + '/_apps/api/tables/x_item/' + id, {
    method: 'PATCH',
    headers: { ...headers, 'if-match': created.etag },
    body: JSON.stringify({ x_name: 'Must not change', x_choices: [9] }),
  });
  assert.equal(invalid.status, 400);
  const saved = await (await fetch(origin + '/_apps/api/tables/x_item/' + id)).json();
  assert.equal(saved.row.x_name, 'Choices round trip');
  const cleared = await fetch(origin + '/_apps/api/tables/x_item/' + id, {
    method: 'PATCH',
    headers: { ...headers, 'if-match': saved.etag },
    body: JSON.stringify({ x_choices: [] }),
  });
  assert.equal(cleared.status, 200);
  assert.equal((await cleared.json()).row.x_choices ?? null, null);
  const empty = await (await fetch(origin + '/_apps/api/tables/x_item/' + id)).json();
  assert.equal(empty.row.x_choices ?? null, null);
});

// One contact stored twice: by a portal write (the canonical string) and by an internal write (an array).
async function storeContactTwice(fields) {
  const contact = {
    logicalName: 'contact',
    entitySet: 'contacts',
    idColumn: 'contactid',
    schemaComplete: true,
    fields,
  };
  const store = new DataStore({
    state: {
      mappings: { contact },
      tables: { contact: [] },
      permissions: [{ entity: 'contact', operations: ['read', 'create'], roles: ['Member'], scope: 'global' }],
    },
  });
  const admin = { admin: true };
  await store.create('contacts', { hobbies: '2,1' }, admin, { coerce: true, portalRequest: true });
  await store.create('contacts', { hobbies: [2, 1] }, admin, { coerce: true });
  return { store, contact };
}

test('the Dataverse Web API reads one multi-select wire value for a portal write and an internal write', async () => {
  const { store, contact } = await storeContactTwice({
    hobbies: { dataverseType: 'multiselectpicklist', options: [{ value: 1 }, { value: 2 }] },
  });
  const formatter = createWebApiFormatter({ store, metadata: () => contact.fields });
  const wire = store
    .snapshot()
    .tables.contact.map((row) => formatter.formatEntity(row, contact, { etag: false }).hobbies);
  assert.deepEqual(wire, ['2,1', '2,1']);
});

async function contactRowsByForm() {
  const { store, contact } = await storeContactTwice({
    hobbies: { dataverseType: 'multiselectpicklist', options: [{ value: 1 }, { value: 2 }] },
    notes: { dataverseType: 'string' },
  });
  const [text, array] = store.snapshot().tables.contact;
  const formatter = createWebApiFormatter({ store, metadata: () => contact.fields });
  return { store, contact, text, array, formatter };
}
const hobbyKeys = (out) => Object.fromEntries(Object.entries(out).filter(([key]) => key.startsWith('hobbies')));

test('a multi-select array reads as the comma string on the Web API, and a JSON array in another column is untouched', async () => {
  const { contact, text, array, formatter } = await contactRowsByForm();
  assert.equal(Array.isArray(array.hobbies), true, 'the internal write keeps its array in the store');
  assert.equal(typeof text.hobbies, 'string', 'the portal write keeps its string in the store');
  assert.deepEqual(
    hobbyKeys(formatter.formatEntity(array, contact, { etag: false })),
    hobbyKeys(formatter.formatEntity(text, contact, { etag: false })),
  );
  assert.equal(formatter.formatEntity(array, contact, { etag: false }).hobbies, '2,1');
  const plain = formatter.formatEntity({ contactid: array.contactid, notes: [1, 2] }, contact, { etag: false });
  assert.deepEqual(plain.notes, [1, 2]);
});

test('a FetchXML result reads a multi-select array as the comma string', async () => {
  const { text, array, formatter } = await contactRowsByForm();
  const info = {
    root: 'contact',
    idColumn: 'contactid',
    aliases: {},
    columns: [{ key: 'hobbies', entity: 'contact', attribute: 'hobbies' }],
  };
  const read = (row) => formatter.formatFetchRow({ contactid: row.contactid, hobbies: row.hobbies }, info);
  assert.deepEqual(hobbyKeys(read(array)), hobbyKeys(read(text)));
});

test('contain-values matches a multi-select array row as it matches the comma string row', async () => {
  const { contact, text, array } = await contactRowsByForm();
  const containing = (value) =>
    compileOperator('contain-values', { attribute: 'hobbies', values: [value], definition: contact.fields.hobbies });
  for (const value of [2, 3]) {
    assert.equal(containing(value)(array.hobbies), containing(value)(text.hobbies), `option ${value}`);
  }
  assert.equal(containing(2)(array.hobbies), true);
  assert.equal(containing(3)(array.hobbies), false);
});

test('the plug-in context reads a multi-select array and the comma string as the same option collection', async () => {
  const { recordToSdkEntity } = await import('../lib/plugin-clr.mjs');
  const { store, text, array } = await contactRowsByForm();
  const options = (row) => recordToSdkEntity(store, 'contact', row, { allColumns: true }).attributes.hobbies;
  assert.deepEqual(options(array), options(text));
});

// The same selection (3, 1, 2) stored two ways: the comma text another writer stores, and the array a plug-in or SDK write keeps.
const threeChoices = {
  logicalName: 'contact',
  entitySet: 'contacts',
  idColumn: 'contactid',
  schemaComplete: true,
  fields: {
    hobbies: {
      dataverseType: 'multiselectpicklist',
      options: [
        { value: 1, label: 'One' },
        { value: 2, label: 'Two' },
        { value: 3, label: 'Three' },
      ],
    },
  },
};
async function selectionRows() {
  const store = new DataStore({
    state: {
      mappings: { contact: threeChoices },
      tables: { contact: [] },
      permissions: [{ entity: 'contact', operations: ['read', 'create'], roles: ['Member'], scope: 'global' }],
    },
  });
  const admin = { admin: true };
  await store.create('contacts', { hobbies: '3,1,2' }, admin, { coerce: true });
  await store.create('contacts', { hobbies: [3, 1, 2] }, admin, { coerce: true });
  const [text, array] = store.snapshot().tables.contact;
  const formatter = createWebApiFormatter({ store, metadata: () => threeChoices.fields });
  return { store, contact: threeChoices, text, array, formatter };
}
const withoutId = (out) => Object.fromEntries(Object.entries(out).filter(([key]) => key !== 'contactid'));

test('the model-driven host reads an array-stored selection as the string-stored selection', async () => {
  const { text, array } = await selectionRows();
  assert.deepEqual(multiSelectValues(text.hobbies), ['3', '1', '2']);
  assert.deepEqual(multiSelectValues(array.hobbies), multiSelectValues(text.hobbies));
});

test('the organisation service attribute of an array-stored selection equals the string-stored attribute', async () => {
  const { text, array, contact } = await selectionRows();
  const entry = (row) =>
    attributeEntry('hobbies', row.hobbies, {
      field: contact.fields.hobbies,
      settings: {},
      entity: undefined,
      primaryName: 'name',
    });
  assert.deepEqual(entry(array), entry(text));
  assert.deepEqual(entry(text).Value, [
    { Value: 3, ExtensionData: {} },
    { Value: 1, ExtensionData: {} },
    { Value: 2, ExtensionData: {} },
  ]);
});

const SOAP_DECL = Object.entries(NS)
  .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
  .join(' ');
const soapPair = (key, valueXml) =>
  `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key>${valueXml}</a:KeyValuePairOfstringanyType>`;
const soapExecute = (type, name, pairs) =>
  `<s:Envelope ${SOAP_DECL}><s:Body><Execute xmlns="${NS.svc}"><request i:type="a:${type}"><a:Parameters>${pairs.join('')}</a:Parameters><a:RequestName>${name}</a:RequestName></request></Execute></s:Body></s:Envelope>`;
const contactQuery =
  '<b:value i:type="a:QueryExpression"><a:EntityName>contact</a:EntityName>' +
  '<a:ColumnSet i:type="a:ColumnSet"><a:AllColumns>true</a:AllColumns><a:Columns/></a:ColumnSet>' +
  '<a:Criteria><a:FilterOperator>And</a:FilterOperator><a:Conditions/><a:Filters/></a:Criteria>' +
  '<a:PageInfo><a:Count>10</a:Count><a:PageNumber>1</a:PageNumber><a:PagingCookie i:nil="true"/>' +
  '<a:ReturnTotalRecordCount>false</a:ReturnTotalRecordCount></a:PageInfo></b:value>';
const SOAP_ADMIN_OID = 'bbbbbbbb-0000-4000-8000-000000000001';
const SOAP_SETTINGS = {
  organizationId: '3e4f5a6b-7c8d-4e9f-8a0b-1c2d3e4f5a6b',
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [
    { objectId: SOAP_ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] },
  ],
};

async function soapSelectionRows() {
  const state = emptyState();
  state.mappings.contact = threeChoices;
  state.tables.contact = [];
  const store = new DataStore({ state });
  await ensureSecurityModel(store, SOAP_SETTINGS);
  const principals = createPrincipals(store, SOAP_SETTINGS);
  const changes = createChangeLog(store);
  const recordHooks = createRecordHooks();
  const records = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals,
    metadataFields: () => undefined,
    changes,
    hooks: recordHooks,
  });
  const api = {
    store,
    change: (fn) => fn(),
    registry: createOperationRegistry(),
    principals,
    metadata: null,
    metadataFields: () => undefined,
    records,
    recordHooks,
    changes,
    settings: SOAP_SETTINGS,
    clock: () => Date.parse('2026-11-12T10:00:00Z'),
    log: () => {},
  };
  api.runAtomic = (fn) => runAtomic(api, fn);
  const admin = principals.byObjectId(SOAP_ADMIN_OID);
  await store.create('contacts', { hobbies: '3,1,2' }, { admin: true }, { coerce: true });
  await store.create('contacts', { hobbies: [3, 1, 2] }, { admin: true }, { coerce: true });
  const send = (xml) =>
    handleSoap(
      {
        method: 'POST',
        headers: {},
        bodyText: xml,
        user: admin,
        caller: admin,
        identity: { admin: true, id: admin.systemuserid, systemUserId: admin.systemuserid },
        origin: 'http://127.0.0.1:5555',
        version: 'v9.2',
        requestId: 'test',
      },
      api,
    );
  return { send };
}

test('a SOAP RetrieveMultiple returns the same selection value for an array-stored and a string-stored row', async () => {
  const t = await soapSelectionRows();
  const res = await t.send(
    soapExecute('RetrieveMultipleRequest', 'RetrieveMultiple', [soapPair('Query', contactQuery)]),
  );
  assert.equal(res.status, 200, res.body);
  const values = [...res.body.matchAll(/<b:key>hobbies<\/b:key><b:value i:type="([^"]+)">([^<]*)<\/b:value>/g)].map(
    (match) => [match[1], match[2]],
  );
  assert.deepEqual(values, [
    ['c:string', '3,1,2'],
    ['c:string', '3,1,2'],
  ]);
});

test('the TDS catalog projects the same SQL row for an array-stored and a string-stored selection', async () => {
  const { store, contact, text, array, formatter } = await selectionRows();
  const table = buildCatalog({ store, metadataFields: () => undefined }).tables.get('contact');
  assert.equal(
    table.columns.some((column) => column.name === 'hobbies'),
    false,
  );
  const project = (row) => withoutId(projectRow(table, row, formatter.formatEntity(row, contact, { etag: false })));
  assert.deepEqual(project(array), project(text));
});

test('a Liquid entity exposes an array-stored selection as the string-stored selection', async () => {
  const { text, array } = await selectionRows();
  const multiSelect = choiceColumnsOf({ entities: { contact: { fields: threeChoices.fields } } }, 'contact');
  const shown = (row) => formatOutput(liquidRecord(row, undefined, { multiSelect }).hobbies);
  assert.equal(shown(text), '3,1,2');
  assert.equal(shown(array), shown(text));
});

test('null operators on an array-stored selection match as they match the string-stored selection', async () => {
  const { contact, text, array } = await selectionRows();
  const predicate = (operator, values = []) =>
    compileOperator(operator, { attribute: 'hobbies', values, definition: contact.fields.hobbies });
  for (const [operator, values] of [
    ['null', []],
    ['not-null', []],
    ['eq', [null]],
    ['ne', [null]],
  ])
    assert.equal(predicate(operator, values)(array.hobbies), predicate(operator, values)(text.hobbies), operator);
  assert.equal(predicate('null')(array.hobbies), false);
  assert.equal(predicate('not-null')(array.hobbies), true);
});
