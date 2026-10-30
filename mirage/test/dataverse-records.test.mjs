// @test-kind unproven: local Web API record handler models; a test with native evidence carries its own tag
// Simulated Dataverse record handlers: collections, single rows, properties,
// navigation, $ref, paging, writes and bound actions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DataStore, emptyState } from '../lib/data.mjs';
import {
  ACCESS_RIGHTS,
  baseCurrencyId,
  createPrincipals,
  ensureSecurityModel,
  grantAccess,
} from '../lib/dataverse-security.mjs';
import { dataverseError, encodeSkipToken, parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';
import { createRecordHandlers, createRecordHooks } from '../lib/dataverse-records.mjs';
import { fieldSecurity } from '../lib/dataverse-fls.mjs';
import { DataError } from '../lib/data-error.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { stringifyExactJson } from '../lib/exact-numeric.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const VERSION = 'v9.2';
const ORG = '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const BASIC_OID = 'aaaaaaaa-0000-4000-8000-000000000002';
const MISSING = '00000000-0000-4000-8000-0000000000ff';
const CURRENCY = '_transactioncurrencyid_value';
const SETTINGS = {
  organizationId: ORG,
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [
    { objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] },
    { objectId: BASIC_OID, upn: 'basic@example.test', displayName: 'Basic', roles: ['Basic User'] },
  ],
};

const lookup = { dataverseType: 'lookup' };
const text = { dataverseType: 'nvarchar' };

function fixtureState() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: 'widget',
    entitySet: 'widgets',
    idColumn: 'widgetid',
    nameColumn: 'name',
    alternateKeys: [{ name: 'widget_code', attributes: ['code'] }],
    relationships: {
      widget_gadgets: { entity: 'gadget', from: 'widgetid', to: 'widgetid', many: true },
      widget_tags: {
        entity: 'tag',
        from: 'widgetid',
        to: 'tagid',
        many: true,
        intersect: { entity: 'widget_tag', from: 'widgetid', to: 'tagid' },
      },
    },
    fields: {
      name: text,
      code: text,
      price: { dataverseType: 'money' },
      status: { dataverseType: 'picklist' },
      statecode: { dataverseType: 'int' },
      statuscode: {
        dataverseType: 'picklist',
        options: [
          { value: 1, label: 'Active', state: 0 },
          { value: 2, label: 'Inactive', state: 1 },
        ],
      },
      ownerid: lookup,
      owninguser: lookup,
      owningteam: lookup,
      owningbusinessunit: lookup,
      createdby: lookup,
      createdonbehalfby: lookup,
      modifiedby: lookup,
      modifiedonbehalfby: lookup,
    },
  };
  state.mappings.gadget = {
    // User-owned without declaring any owner or audit column.
    logicalName: 'gadget',
    entitySet: 'gadgets',
    idColumn: 'gadgetid',
    nameColumn: 'name',
    ownership: 'UserOwned',
    relationships: {
      widgetid: { entity: 'widget', from: 'widgetid', to: 'widgetid', many: false, cascade: { delete: 'RemoveLink' } },
    },
    fields: { name: text, widgetid: lookup },
  };
  state.mappings.tag = {
    logicalName: 'tag',
    entitySet: 'tags',
    idColumn: 'tagid',
    nameColumn: 'name',
    fields: { name: text },
  };
  state.mappings.widget_tag = {
    logicalName: 'widget_tag',
    entitySet: 'widget_tags',
    idColumn: 'widget_tagid',
    fields: { widgetid: lookup, tagid: lookup },
  };
  for (const logical of ['widget', 'gadget', 'tag', 'widget_tag']) state.tables[logical] = [];
  return state;
}

async function setup(options = {}) {
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const changes = createChangeLog(store);
  const handlers = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals,
    metadataFields: () => undefined,
    changes,
    ...options,
  });
  const admin = principals.byObjectId(ADMIN_OID);
  const basic = principals.byObjectId(BASIC_OID);
  const send = async (method, path, { user = admin, caller = user, body, headers = {}, bodyBuffer } = {}) => {
    const url = new URL(path, ORIGIN);
    const lowered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    return handlers.handle({
      method,
      route: parseDataverseRoute(url.pathname),
      url,
      origin: ORIGIN,
      version: VERSION,
      prefer: parsePrefer(lowered.prefer),
      headers: lowered,
      body,
      bodyBuffer,
      user,
      caller,
      identity: { admin: true, id: user.systemuserid, systemUserId: user.systemuserid },
      requestId: 'test',
    });
  };
  return { store, principals, send, admin, basic, handlers, changes };
}

// POST a row and return its id from OData-EntityId.
async function create(t, set, body, user = t.admin) {
  const res = await t.send('POST', `/api/data/${VERSION}/${set}`, { body, user });
  assert.equal(res.status, 204);
  return /\(([^()]+)\)$/.exec(res.headers['OData-EntityId'])[1];
}

async function failure(promise) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('expected the call to fail');
}

const lowerId = (value) => String(value?.id ?? value).toLowerCase();

test('wide single-record reads reuse metadata during projection and observe later changes', async (t) => {
  const fields = {
    widgetid: { dataverseType: 'primarykey' },
    name: text,
    statuscode: { dataverseType: 'status', options: [{ value: 1, label: 'First' }] },
    ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['extra' + i, text])),
  };
  let reads = 0;
  const runtime = await setup({
    metadata: {
      recordFields: () => {
        reads++;
        return fields;
      },
    },
    metadataFields: () => fields,
  });
  t.after(() => runtime.handlers.close());
  const id = randomUUID();
  runtime.store.state.tables.widget.push({
    widgetid: id,
    name: 'Wide',
    statuscode: 1,
    ...Object.fromEntries(Array.from({ length: 200 }, (_, i) => ['extra' + i, 'Value ' + i])),
  });
  const url = `/api/data/${VERSION}/widgets(${id})`;
  const headers = { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' };
  const first = await runtime.send('GET', url, { headers });
  assert.equal(first.body.extra199, 'Value 199');
  assert.ok(reads <= 2, `Metadata resolved ${reads} times for one record`);
  fields.statuscode.options[0].label = 'Second';
  reads = 0;
  const second = await runtime.send('GET', url, { headers });
  assert.equal(second.body['statuscode@OData.Community.Display.V1.FormattedValue'], 'Second');
  assert.ok(reads <= 2);
});

test('a single-record read checks only its own row for a stored currency, not every row of the table', async (t) => {
  const runtime = await setup();
  t.after(() => runtime.handlers.close());
  let currencyReads = 0;
  const counted = (row) =>
    Object.defineProperty(row, 'transactioncurrencyid', {
      enumerable: true,
      configurable: true,
      get: () => {
        currencyReads++;
        return null;
      },
    });
  const ids = Array.from({ length: 2000 }, () => randomUUID());
  for (const id of ids) runtime.store.state.tables.widget.push(counted({ widgetid: id, name: 'Invented' }));
  const url = `/api/data/${VERSION}/widgets(${ids[1500]})`;
  assert.equal((await runtime.send('GET', url)).status, 200);
  currencyReads = 0;
  const response = await runtime.send('GET', url);
  assert.equal(response.status, 200);
  assert.ok(currencyReads <= 4, `One record read the currency of ${currencyReads} rows`);
});

test('wide FetchXML pages derive record metadata per table and refresh it on the next request', async (t) => {
  const fields = {
    widgetid: { dataverseType: 'primarykey' },
    name: text,
    statuscode: { dataverseType: 'status', options: [{ value: 1, label: 'First' }] },
    ...Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['extra' + i, text])),
  };
  let reads = 0;
  const runtime = await setup({
    metadata: {
      recordFields: () => {
        reads++;
        return fields;
      },
    },
    metadataFields: () => fields,
  });
  t.after(() => runtime.handlers.close());
  runtime.store.state.tables.widget.push(
    ...Array.from({ length: 25 }, (_, i) => ({
      widgetid: randomUUID(),
      name: 'Wide ' + i,
      statuscode: 1,
      ...Object.fromEntries(Array.from({ length: 80 }, (_, j) => ['extra' + j, 'Value ' + j])),
    })),
  );
  const url =
    `/api/data/${VERSION}/widgets?fetchXml=` +
    encodeURIComponent('<fetch count="25"><entity name="widget"><all-attributes/></entity></fetch>');
  const headers = { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' };
  const first = await runtime.send('GET', url, { headers });
  assert.equal(first.status, 200);
  assert.equal(first.body.value.length, 25);
  assert.equal(first.body.value[0].extra79, 'Value 79');
  assert.ok(reads <= 2, `Metadata resolved ${reads} times for one table's page`);
  fields.statuscode.options[0].label = 'Second';
  reads = 0;
  const second = await runtime.send('GET', url, { headers });
  assert.equal(second.body.value[0]['statuscode@OData.Community.Display.V1.FormattedValue'], 'Second');
  assert.ok(reads <= 2);
});

test('wide read definitions resolve original metadata once per list and retain observed option labels', async (t) => {
  const fields = {
    widgetid: { dataverseType: 'uniqueidentifier' },
    name: text,
    statuscode: { dataverseType: 'status', options: [{ value: 1, label: 'Observed active' }] },
    ...Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`extra${index}`, text])),
  };
  let definitionsRead = 0,
    originalRead = 0;
  const runtime = await setup({
    metadata: {
      recordFields: () => {
        definitionsRead++;
        return fields;
      },
    },
    metadataFields: () => {
      originalRead++;
      return fields;
    },
  });
  t.after(() => runtime.handlers.close());
  const id = randomUUID();
  runtime.store.state.tables.widget.push({
    widgetid: id,
    name: 'Wide row',
    statuscode: 1,
    ...Object.fromEntries(Array.from({ length: 80 }, (_, index) => [`extra${index}`, `Value ${index}`])),
  });
  const result = await runtime.send('GET', `/api/data/${VERSION}/widgets(${id})`, {
    headers: { Prefer: 'odata.include-annotations="OData.Community.Display.V1.FormattedValue"' },
  });
  assert.equal(result.status, 200);
  assert.equal(result.body.statuscode, 1);
  assert.equal(result.body['statuscode@OData.Community.Display.V1.FormattedValue'], 'Observed active');
  assert.equal(result.body.extra79, 'Value 79');
  assert.ok(definitionsRead > 0);
  // One source resolution per definition list; resolving per field would read it once for each of the 80+ columns.
  assert.ok(
    originalRead <= definitionsRead,
    `${originalRead} source resolutions for ${definitionsRead} definition lists`,
  );
});
const annotate = (name) => ({ prefer: `odata.include-annotations="${name}"` });

test('collection GET returns context, etags, the id under $select and no annotations by default', async () => {
  const t = await setup();
  const first = await create(t, 'widgets', { name: 'Alpha', price: 12.5 });
  await create(t, 'widgets', { name: 'Beta', price: 3 });
  const res = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`);
  assert.equal(res.status, 200);
  assert.equal(res.body['@odata.context'], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(name)`);
  assert.equal(res.body.value.length, 2);
  for (const row of res.body.value) {
    assert.ok(row.widgetid, 'primary id is returned even when not selected');
    assert.match(row['@odata.etag'], /^W\/"/);
    assert.ok(!Object.keys(row).some((key) => key.includes('FormattedValue')));
  }
  assert.ok(res.body.value.some((row) => row.widgetid === first));
});

test('$count is capped at 5000 and totalrecordcount annotations follow $count', async () => {
  const t = await setup();
  for (let i = 0; i < 5001; i += 1)
    t.store.state.tables.widget.push({ widgetid: randomUUID(), name: `n${i}`, ownerid: null });
  const res = await t.send('GET', `/api/data/${VERSION}/widgets?$count=true&$select=name`, {
    headers: {
      prefer:
        'odata.include-annotations="Microsoft.Dynamics.CRM.totalrecordcount,Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"',
    },
  });
  assert.equal(res.body['@odata.count'], 5000);
  assert.equal(res.body['@Microsoft.Dynamics.CRM.totalrecordcount'], 5000);
  assert.equal(res.body['@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded'], true);
  const plain = await t.send('GET', `/api/data/${VERSION}/widgets/$count`);
  assert.equal(plain.body, '5000');
});

test('maxpagesize pages through rows with $skiptoken until no nextLink remains', async () => {
  const t = await setup();
  const ids = [];
  for (let i = 0; i < 5; i += 1) ids.push(await create(t, 'widgets', { name: `P${i}` }));
  const headers = { prefer: 'odata.maxpagesize=2' };
  const seen = [];
  let res = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, { headers });
  assert.equal(res.headers['Preference-Applied'], 'odata.maxpagesize=2');
  for (let page = 0; page < 3; page += 1) {
    seen.push(...res.body.value.map((row) => row.widgetid));
    if (!res.body['@odata.nextLink']) break;
    const next = new URL(res.body['@odata.nextLink']);
    assert.match(next.search, /\$skiptoken=/);
    res = await t.send('GET', next.pathname + next.search, { headers });
  }
  assert.equal(res.body['@odata.nextLink'], undefined, 'the last page has no nextLink');
  assert.deepEqual(seen.sort(), ids.sort());
});

test('change tracking: a delta link follows the full read, and the delta reports changed and deleted rows', async () => {
  const t = await setup();
  const first = await create(t, 'widgets', { name: 'First' });
  const second = await create(t, 'widgets', { name: 'Second' });
  const full = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, {
    headers: { prefer: 'odata.track-changes' },
  });
  assert.equal(full.status, 200);
  assert.equal(full.headers['Preference-Applied'], 'odata.track-changes');
  assert.equal(full.body.value.length, 2);
  const link = full.body['@odata.deltaLink'];
  assert.ok(link.startsWith(`${ORIGIN}/api/data/${VERSION}/widgets?$select=name&$deltatoken=`), link);
  assert.match(link, /\$deltatoken=\d+%21\d\d%2f\d\d%2f\d{4}%20\d\d%3a\d\d%3a\d\d$/);
  const nothing = await t.send('GET', link, { headers: { prefer: 'odata.track-changes' } });
  assert.equal(nothing.body['@odata.context'], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(name)/$delta`);
  assert.deepEqual(nothing.body.value, []);
  assert.equal(nothing.headers['Preference-Applied'], 'odata.track-changes');
  await t.send('PATCH', `/api/data/${VERSION}/widgets(${first})`, { body: { name: 'Changed' } });
  await t.send('DELETE', `/api/data/${VERSION}/widgets(${second})`);
  const third = await create(t, 'widgets', { name: 'Third' });
  const delta = await t.send('GET', link);
  const changed = delta.body.value.filter((item) => !item.reason);
  assert.deepEqual(changed.map((row) => row.widgetid).sort(), [first, third].sort());
  assert.equal(changed.find((row) => row.widgetid === first).name, 'Changed');
  assert.deepEqual(
    delta.body.value.filter((item) => item.reason),
    [
      {
        '@odata.context': `${ORIGIN}/api/data/${VERSION}/$metadata#widgets/$deletedEntity`,
        id: second,
        reason: 'deleted',
      },
    ],
  );
  assert.notEqual(delta.body['@odata.deltaLink'], link, 'the delta carries a newer token');
  assert.equal(delta.headers['Preference-Applied'], undefined, 'no echo without the preference');
  const fourth = await create(t, 'widgets', { name: 'Fourth' });
  await t.send('DELETE', `/api/data/${VERSION}/widgets(${fourth})`);
  const again = await t.send('GET', delta.body['@odata.deltaLink']);
  assert.deepEqual(
    again.body.value.map((item) => [item.id, item.reason]),
    [[fourth, 'deleted']],
    'created then deleted inside the window reports deleted only',
  );
});

test('change tracking rejects the unsupported query options and a bad token', async () => {
  const t = await setup();
  for (const option of ["$filter=name eq 'x'", '$orderby=name', '$top=1', '$expand=widget_gadgets']) {
    const error = await failure(
      t.send('GET', `/api/data/${VERSION}/widgets?${option}`, { headers: { prefer: 'odata.track-changes' } }),
    );
    assert.equal(error.status, 400);
    assert.equal(
      error.message,
      `The "${option.split('=')[0]}" query parameter isn't supported when Change Tracking is enabled.`,
    );
  }
  const bad = await failure(t.send('GET', `/api/data/${VERSION}/widgets?$deltatoken=nope`));
  assert.equal(bad.status, 400);
  assert.equal(bad.message, 'The $deltatoken is not valid.');
  const plain = await t.send('GET', `/api/data/${VERSION}/widgets?$top=1`);
  assert.equal(plain.status, 200, 'without the preference the options still work');
  assert.equal(plain.body['@odata.deltaLink'], undefined);
  assert.equal(plain.headers['Preference-Applied'], undefined);
});

test('unsupported query options are rejected', async () => {
  const t = await setup();
  const error = await failure(t.send('GET', `/api/data/${VERSION}/widgets?$skip=1`));
  assert.equal(error.status, 400);
  assert.equal(error.code, 'UnsupportedQuery');
  assert.equal(error.message, 'The query parameter $skip is not supported');
});

test('unknown entity set answers 404 with the Dataverse segment error', async () => {
  const t = await setup();
  const error = await failure(t.send('GET', `/api/data/${VERSION}/nothings`));
  assert.equal(error.status, 404);
  // Native: 0x80060888, not 0x8006088a.
  assert.equal(error.details.innerCode, '0x80060888');
  assert.equal(error.message, "Resource not found for the segment 'nothings'.");
});

test('entity GET by GUID and by alternate key, with 404 for a missing row', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Keyed', code: 'W-1' });
  const byId = await t.send('GET', `/api/data/${VERSION}/widgets(${id})?$select=name`);
  assert.equal(byId.status, 200);
  assert.equal(byId.body['@odata.context'], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(name)/$entity`);
  assert.equal(byId.body.name, 'Keyed');
  const byKey = await t.send('GET', `/api/data/${VERSION}/widgets(code='W-1')`);
  assert.equal(byKey.body.widgetid, id);
  const missing = await failure(t.send('GET', `/api/data/${VERSION}/widgets(${MISSING})`));
  assert.equal(missing.status, 404);
  assert.equal(missing.message, `widget With Id = ${MISSING} Does Not Exist`);
});

test('an organization-service lookup finds its target row through the primary key instead of scanning the target table', async () => {
  const t = await setup();
  let idReads = 0;
  const ids = Array.from({ length: 2000 }, () => randomUUID());
  for (const id of ids)
    t.store.state.tables.widget.push(
      Object.defineProperty({ name: 'Invented' }, 'widgetid', {
        enumerable: true,
        configurable: true,
        get: () => {
          idReads++;
          return id;
        },
      }),
    );
  // An organization-service create names its lookup as { id, logical_name } and checks appendTo on that row.
  const context = {
    user: t.admin,
    caller: t.admin,
    url: new URL(ORIGIN),
    origin: ORIGIN,
    version: VERSION,
    identity: { admin: true, id: t.admin.systemuserid, systemUserId: t.admin.systemuserid },
  };
  const bind = (name) =>
    t.handlers.createInternal(context, 'gadget', {
      name,
      widgetid: { id: ids.at(-1), logical_name: 'widget' },
    });
  await bind('First');
  idReads = 0;
  await bind('Second');
  assert.equal(t.store.state.tables.gadget.at(-1).widgetid.id, ids.at(-1));
  assert.ok(idReads < 200, `One lookup bind read the id of ${idReads} target rows`);
});

test('POST creates with OData-EntityId, honours return=representation and binds absolute references', async () => {
  const t = await setup();
  const widget = await create(t, 'widgets', { name: 'Parent' });
  const res = await t.send('POST', `/api/data/${VERSION}/gadgets`, {
    body: { name: 'Child', 'widgetid@odata.bind': `${ORIGIN}/api/data/${VERSION}/widgets(${widget})` },
  });
  assert.equal(res.status, 204);
  const gadget = /\(([^()]+)\)$/.exec(res.headers['OData-EntityId'])[1];
  assert.equal(t.store.state.tables.gadget.find((row) => row.gadgetid === gadget).widgetid.id, widget);
  const represented = await t.send('POST', `/api/data/${VERSION}/widgets`, {
    body: { name: 'Shown' },
    headers: { prefer: 'return=representation' },
  });
  assert.equal(represented.status, 201);
  assert.equal(represented.headers['Preference-Applied'], 'return=representation');
  assert.equal(represented.body['@odata.context'], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets/$entity`);
  assert.equal(represented.body.name, 'Shown');
});

test('PATCH updates, enforces If-Match and If-None-Match, and rejects stale etags', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Old' });
  const updated = await t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, { body: { name: 'New' } });
  assert.equal(updated.status, 204);
  assert.equal(t.store.state.tables.widget.find((row) => row.widgetid === id).name, 'New');

  const missingIfMatch = await failure(
    t.send('PATCH', `/api/data/${VERSION}/widgets(${MISSING})`, { body: { name: 'x' }, headers: { 'if-match': '*' } }),
  );
  assert.equal(missingIfMatch.status, 404);
  // Native: 404 0x80040217 worded with "Entity '<table>'".
  assert.equal(missingIfMatch.message, `Entity 'widget' With Id = ${MISSING} Does Not Exist`);
  assert.equal(missingIfMatch.details.innerCode, '0x80040217');

  const exists = await failure(
    t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, { body: { name: 'x' }, headers: { 'if-none-match': '*' } }),
  );
  assert.equal(exists.status, 412);
  assert.equal(exists.details.innerCode, '0x80040237');

  const stale = await failure(
    t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, { body: { name: 'x' }, headers: { 'if-match': 'W/"1"' } }),
  );
  assert.equal(stale.status, 412);
  assert.equal(stale.details.innerCode, '0x80060882');
});

test('PATCH with an alternate key upserts and echoes the key form', async () => {
  const t = await setup();
  const res = await t.send('PATCH', `/api/data/${VERSION}/widgets(code='K-9')`, { body: { name: 'Keyed' } });
  assert.equal(res.status, 204);
  assert.equal(res.headers['OData-EntityId'], `${ORIGIN}/api/data/${VERSION}/widgets(code='K-9')`);
  assert.equal(t.store.state.tables.widget.find((row) => row.code === 'K-9').name, 'Keyed');
});

test('properties: PUT, GET, $value and DELETE set and clear a value', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Start', price: 4 });
  assert.equal(
    (await t.send('PUT', `/api/data/${VERSION}/widgets(${id})/name`, { body: { value: 'Put' } })).status,
    204,
  );
  const prop = await t.send('GET', `/api/data/${VERSION}/widgets(${id})/name`);
  assert.equal(prop.body.value, 'Put');
  assert.equal(prop.body['@odata.context'], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(${id})/name`);
  const raw = await t.send('GET', `/api/data/${VERSION}/widgets(${id})/name/$value`);
  assert.deepEqual(raw, { status: 200, body: 'Put' });
  assert.equal((await t.send('DELETE', `/api/data/${VERSION}/widgets(${id})/price`)).status, 204);
  assert.equal((await t.send('GET', `/api/data/${VERSION}/widgets(${id})/price`)).status, 204);
  // Native: an unknown path segment after a record is a missing resource, 404 0x80060888 without a period.
  const unknown = await failure(t.send('GET', `/api/data/${VERSION}/widgets(${id})/nosuch`));
  assert.equal(unknown.status, 404);
  assert.equal(unknown.details.innerCode, '0x80060888');
  assert.equal(unknown.message, "Resource not found for the segment 'nosuch'");
});

test('single-valued navigation returns the target entity, or 204 when unset', async () => {
  const t = await setup();
  const widget = await create(t, 'widgets', { name: 'Owner' });
  const linked = await create(t, 'gadgets', { name: 'Linked', 'widgetid@odata.bind': `/widgets(${widget})` });
  const bare = await create(t, 'gadgets', { name: 'Bare' });
  const res = await t.send('GET', `/api/data/${VERSION}/gadgets(${linked})/widgetid?$select=name`);
  assert.equal(res.body.name, 'Owner');
  assert.equal(res.body['@odata.context'], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(name)/$entity`);
  assert.equal((await t.send('GET', `/api/data/${VERSION}/gadgets(${bare})/widgetid`)).status, 204);
});

test('collection navigation and $ref cover N:N associate, list and disassociate', async () => {
  const t = await setup();
  const widget = await create(t, 'widgets', { name: 'Tagged' });
  const gadget = await create(t, 'gadgets', { name: 'Under', 'widgetid@odata.bind': `/widgets(${widget})` });
  const navigated = await t.send('GET', `/api/data/${VERSION}/widgets(${widget})/widget_gadgets?$select=name`);
  assert.deepEqual(
    navigated.body.value.map((row) => row.gadgetid),
    [gadget],
  );
  assert.match(navigated.body['@odata.context'], /#gadgets\(name\)$/);

  const tag = await create(t, 'tags', { name: 'red' });
  const associated = await t.send('POST', `/api/data/${VERSION}/widgets(${widget})/widget_tags/$ref`, {
    body: { '@odata.id': `${ORIGIN}/api/data/${VERSION}/tags(${tag})` },
  });
  assert.equal(associated.status, 204);
  const listed = await t.send('GET', `/api/data/${VERSION}/widgets(${widget})/widget_tags/$ref`);
  assert.equal(listed.body['@odata.context'], `${ORIGIN}/api/data/${VERSION}/$metadata#Collection($ref)`);
  assert.deepEqual(listed.body.value, [{ '@odata.id': `${ORIGIN}/api/data/${VERSION}/tags(${tag})` }]);
  assert.deepEqual(
    (await t.send('GET', `/api/data/${VERSION}/widgets(${widget})/widget_tags?$select=name`)).body.value.map(
      (row) => row.name,
    ),
    ['red'],
  );
  assert.equal((await t.send('GET', `/api/data/${VERSION}/widgets(${widget})/widget_tags/$count`)).body, '1');

  const removed = await t.send('DELETE', `/api/data/${VERSION}/widgets(${widget})/widget_tags(${tag})/$ref`);
  assert.equal(removed.status, 204);
  assert.deepEqual((await t.send('GET', `/api/data/${VERSION}/widgets(${widget})/widget_tags/$ref`)).body.value, []);
});

test('$ref associate and disassociate stamp modifiedby with the calling user, not the creator', async () => {
  const t = await setup();
  // basic creates both rows; admin associates and then disassociates the child.
  const widget = await create(t, 'widgets', { name: 'Parent' }, t.basic);
  const gadget = await create(t, 'gadgets', { name: 'Child' }, t.basic);
  const row = () => t.store.state.tables.gadget.find((item) => item.gadgetid === gadget);
  const associated = await t.send('POST', `/api/data/${VERSION}/widgets(${widget})/widget_gadgets/$ref`, {
    body: { '@odata.id': `${ORIGIN}/api/data/${VERSION}/gadgets(${gadget})` },
  });
  assert.equal(associated.status, 204);
  assert.equal(lowerId(row().widgetid), widget);
  assert.equal(lowerId(row().modifiedby), t.admin.systemuserid);
  assert.equal(lowerId(row().createdby), t.basic.systemuserid, 'createdby never changes on update');
  const removed = await t.send('DELETE', `/api/data/${VERSION}/widgets(${widget})/widget_gadgets(${gadget})/$ref`);
  assert.equal(removed.status, 204);
  assert.equal(row().widgetid, null);
  assert.equal(lowerId(row().modifiedby), t.admin.systemuserid);
});

test("deleting a parent whose child cascades RemoveLink stamps the child's modifiedby with the deleting user", async () => {
  const t = await setup();
  const widget = await create(t, 'widgets', { name: 'Parent' }, t.basic);
  const gadget = await create(t, 'gadgets', { name: 'Child', 'widgetid@odata.bind': `/widgets(${widget})` }, t.basic);
  const row = () => t.store.state.tables.gadget.find((item) => item.gadgetid === gadget);
  assert.equal(lowerId(row().modifiedby), t.basic.systemuserid);
  const deleted = await t.send('DELETE', `/api/data/${VERSION}/widgets(${widget})`);
  assert.equal(deleted.status, 204);
  assert.equal(row().widgetid, null, 'the child link is removed, not the child');
  assert.equal(lowerId(row().modifiedby), t.admin.systemuserid);
  assert.equal(lowerId(row().createdby), t.basic.systemuserid, 'createdby never changes on update');
});

test('DELETE removes the row, then GET answers 404', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Gone' });
  assert.equal((await t.send('DELETE', `/api/data/${VERSION}/widgets(${id})`)).status, 204);
  const after = await failure(t.send('GET', `/api/data/${VERSION}/widgets(${id})`));
  assert.equal(after.status, 404);
});

// @test-kind parity: native recorder corpus 2026-10-30, bulk scenario captured twice: Web API DeleteMultiple on a non-elastic table answers 405 0x8004023b "DeleteMultiple has not yet been implemented"
// @parity-evidence: native recorder corpus 2026-10-30 bulk and native-r2/bulk: DeleteMultiple 405 0x8004023b in both captures; the captured table is a custom non-elastic table
test('CreateMultiple returns Ids; DeleteMultiple is not implemented', async () => {
  const t = await setup();
  const res = await t.send('POST', `/api/data/${VERSION}/widgets/Microsoft.Dynamics.CRM.CreateMultiple`, {
    body: { Targets: [{ '@odata.type': '#Microsoft.Dynamics.CRM.widget', name: 'a' }, { name: 'b' }] },
  });
  assert.equal(res.status, 200);
  assert.equal(
    res.body['@odata.context'],
    `${ORIGIN}/api/data/${VERSION}/$metadata#Microsoft.Dynamics.CRM.CreateMultipleResponse`,
  );
  assert.equal(res.body.Ids.length, 2);
  const id = await create(t, 'widgets', { name: 'kept' });
  const deleted = await failure(
    t.send('POST', `/api/data/${VERSION}/widgets/Microsoft.Dynamics.CRM.DeleteMultiple`, {
      body: { Targets: [{ '@odata.type': 'Microsoft.Dynamics.CRM.widget', widgetid: id }] },
    }),
  );
  assert.equal(deleted.status, 405);
  assert.equal(deleted.details.innerCode, '0x8004023b');
  assert.equal((await t.send('GET', `/api/data/${VERSION}/widgets(${id})`)).status, 200);
});

test('FetchXML collection omits null columns and reports more records only when requested', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'First', price: 1 });
  await create(t, 'widgets', { name: 'Second' });
  const fetchXml =
    '<fetch count="1"><entity name="widget"><attribute name="name"/><attribute name="price"/></entity></fetch>';
  const path = `/api/data/${VERSION}/widgets?fetchXml=${encodeURIComponent(fetchXml)}`;
  const plain = await t.send('GET', path);
  assert.equal(plain.body.value.length, 1);
  assert.equal(plain.body['@Microsoft.Dynamics.CRM.morerecords'], undefined);
  const withPage = await t.send('GET', path, { headers: annotate('Microsoft.Dynamics.CRM.morerecords') });
  assert.equal(withPage.body['@Microsoft.Dynamics.CRM.morerecords'], true);
  const nameOnly = await t.send(
    'GET',
    `/api/data/${VERSION}/widgets?fetchXml=${encodeURIComponent('<fetch><entity name="widget"><attribute name="price"/></entity></fetch>')}`,
  );
  assert.ok(nameOnly.body.value.every((row) => !('price' in row) || row.price !== null));
  const mismatch = await failure(
    t.send('GET', `/api/data/${VERSION}/gadgets?fetchXml=${encodeURIComponent(fetchXml)}`),
  );
  assert.equal(mismatch.status, 400);
  assert.equal(mismatch.details.innerCode, '0x80060888');
});

test('Basic User sees only owned widgets and is denied others and unprivileged tables', async () => {
  const t = await setup();
  const adminWidget = await create(t, 'widgets', { name: "Admin's" });
  const mine = await create(t, 'widgets', { name: "Basic's" }, t.basic);
  const list = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, { user: t.basic });
  assert.deepEqual(
    list.body.value.map((row) => row.widgetid),
    [mine],
  );
  const denied = await failure(t.send('GET', `/api/data/${VERSION}/widgets(${adminWidget})`, { user: t.basic }));
  assert.equal(denied.status, 403);
  assert.equal(denied.details.innerCode, '0x80048306');
  // tags are organization-owned: Basic User has no create privilege on them.
  const noPrivilege = await failure(
    t.send('POST', `/api/data/${VERSION}/tags`, { body: { name: 'x' }, user: t.basic }),
  );
  assert.equal(noPrivilege.status, 403);
  assert.equal(noPrivilege.details.innerCode, '0x80040220');
});

const businessUnitOf = (user) => String(user.businessunitid?.id ?? user.businessunitid).toLowerCase();

test('unknown payload properties answer 400 0x80048d19 on create and update, and nothing is written', async () => {
  const t = await setup();
  const created = await failure(t.send('POST', `/api/data/${VERSION}/widgets`, { body: { name: 'x', bogus: 1 } }));
  assert.equal(created.status, 400);
  assert.equal(created.details.innerCode, '0x80048d19');
  // The payload-reader form of native batch.rollback, without its stack trace.
  assert.equal(
    created.message,
    "Error identified in Payload provided by the user for Entity :'widgets', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : Microsoft.Crm.CrmException: Invalid property 'bogus' was found in entity 'Microsoft.Dynamics.CRM.widget'. ---> Microsoft.OData.ODataException: The property 'bogus' does not exist on type 'Microsoft.Dynamics.CRM.widget'. Make sure to only use property names that are defined by the type.",
  );
  assert.equal(t.store.state.tables.widget.length, 0);
  const id = await create(t, 'widgets', { name: 'Real' });
  const patched = await failure(t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, { body: { nonsense: 'x' } }));
  assert.equal(patched.details.innerCode, '0x80048d19');
  assert.match(patched.message, /Invalid property 'nonsense'/);
  const dangling = await failure(
    t.send('POST', `/api/data/${VERSION}/gadgets`, { body: { name: 'g', 'nope@odata.bind': `/widgets(${id})` } }),
  );
  assert.equal(dangling.status, 400);
  assert.equal(dangling.details.innerCode, '0x80048d19');
  assert.match(dangling.message, /An undeclared property 'nope'/);
});

test('unknown $select, $filter, $orderby and $expand properties answer 400 0x80060888 while declared ones pass', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'Known' });
  const expected = (name) => `Could not find a property named '${name}' on type 'Microsoft.Dynamics.CRM.widget'.`;
  const select = await failure(t.send('GET', `/api/data/${VERSION}/widgets?$select=bogus`));
  assert.equal(select.status, 400);
  assert.equal(select.details.innerCode, '0x80060888');
  assert.equal(select.message, expected('bogus'));
  const filter = await failure(t.send('GET', `/api/data/${VERSION}/widgets?$filter=bogus eq 1`));
  assert.equal(filter.details.innerCode, '0x80060888');
  assert.equal(filter.message, expected('bogus'));
  const order = await failure(t.send('GET', `/api/data/${VERSION}/widgets?$orderby=bogus`));
  assert.equal(order.details.innerCode, '0x80060888');
  assert.equal(order.message, expected('bogus'));
  const expand = await failure(t.send('GET', `/api/data/${VERSION}/widgets?$expand=bogus`));
  assert.equal(expand.details.innerCode, '0x80060888');
  assert.equal(expand.message, expected('bogus'));
  const ok = await t.send(
    'GET',
    `/api/data/${VERSION}/widgets?$filter=name eq 'Known' and _ownerid_value ne null&$orderby=name desc&$expand=widget_gadgets`,
  );
  assert.equal(ok.status, 200);
  assert.equal(ok.body.value.length, 1);
});

test('logical table names do not route; only entity set names do', async () => {
  const t = await setup();
  const error = await failure(t.send('GET', `/api/data/${VERSION}/widget`));
  assert.equal(error.status, 404);
  assert.equal(error.details.innerCode, '0x80060888'); // native unknown-set code
  assert.equal(error.message, "Resource not found for the segment 'widget'.");
});

test('skiptokens for pages below 2 answer 400 0x80060888, and next links keep the cookie escaping', async () => {
  const t = await setup();
  const first = encodeSkipToken({ pageNumber: 1, lastId: MISSING, firstId: MISSING, idColumn: 'widgetid' });
  const error = await failure(t.send('GET', `/api/data/${VERSION}/widgets?$skiptoken=${encodeURIComponent(first)}`));
  assert.equal(error.status, 400);
  assert.equal(error.details.innerCode, '0x80060888');
  assert.equal(error.message, 'The $skiptoken is not valid.');
  for (let i = 0; i < 3; i += 1) await create(t, 'widgets', { name: `S${i}` });
  const page = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, {
    headers: { prefer: 'odata.maxpagesize=2' },
  });
  assert.match(page.body['@odata.nextLink'], /%253c/i);
  assert.doesNotMatch(page.body['@odata.nextLink'], /%25253c/i);
});

test('assigning an org-owned row answers 400 0x80048d19 before any assign privilege is checked', async () => {
  const t = await setup();
  const id = await create(t, 'tags', { name: 'red' });
  const error = await failure(
    t.send('PATCH', `/api/data/${VERSION}/tags(${id})`, {
      body: { 'ownerid@odata.bind': `/systemusers(${t.admin.systemuserid})` },
    }),
  );
  assert.equal(error.status, 400);
  assert.equal(error.details.innerCode, '0x80048d19');
  assert.match(error.message, /An undeclared property 'ownerid'/);
});

test('ownerid defaults to the caller, the owner columns follow it on create and are recomputed when it is reassigned', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Owned' }, t.basic);
  let row = t.store.state.tables.widget.find((item) => item.widgetid === id);
  assert.equal(lowerId(row.ownerid), t.basic.systemuserid.toLowerCase());
  assert.equal(lowerId(row.owninguser), t.basic.systemuserid.toLowerCase());
  assert.equal(lowerId(row.owningbusinessunit), businessUnitOf(t.basic));
  const moved = await t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, {
    body: { 'ownerid@odata.bind': `/systemusers(${t.admin.systemuserid})` },
  });
  assert.equal(moved.status, 204);
  row = t.store.state.tables.widget.find((item) => item.widgetid === id);
  assert.equal(lowerId(row.ownerid), t.admin.systemuserid.toLowerCase());
  assert.equal(lowerId(row.owninguser), t.admin.systemuserid.toLowerCase());
  assert.equal(lowerId(row.owningbusinessunit), businessUnitOf(t.admin));
});

test('an impersonating caller is recorded in createdonbehalfby and modifiedonbehalfby', async () => {
  const t = await setup();
  const created = await t.send('POST', `/api/data/${VERSION}/widgets`, {
    body: { name: 'Imp' },
    user: t.basic,
    caller: t.admin,
  });
  assert.equal(created.status, 204);
  const id = /\(([^()]+)\)$/.exec(created.headers['OData-EntityId'])[1];
  let row = t.store.state.tables.widget.find((item) => item.widgetid === id);
  assert.equal(lowerId(row.createdby), t.basic.systemuserid.toLowerCase());
  assert.equal(lowerId(row.createdonbehalfby), t.admin.systemuserid.toLowerCase());
  assert.equal(lowerId(row.modifiedonbehalfby), t.admin.systemuserid.toLowerCase());
  await t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, {
    body: { name: 'Imp2' },
    user: t.admin,
    caller: t.basic,
  });
  row = t.store.state.tables.widget.find((item) => item.widgetid === id);
  assert.equal(lowerId(row.modifiedonbehalfby), t.basic.systemuserid.toLowerCase());
  await t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, { body: { name: 'Direct' }, user: t.basic });
  assert.equal(
    t.store.state.tables.widget.find((item) => item.widgetid === id).modifiedonbehalfby,
    null,
    'a direct write clears it',
  );
  const plain = await create(t, 'widgets', { name: 'Plain' });
  const plainRow = t.store.state.tables.widget.find((item) => item.widgetid === plain);
  assert.equal(plainRow.createdonbehalfby, null);
});

test('create defaults statecode to 0 and statuscode to the state-0 status, keeping explicit values', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Defaults' });
  const row = t.store.state.tables.widget.find((item) => item.widgetid === id);
  assert.equal(row.statecode, 0);
  assert.equal(row.statuscode, 1);
  const explicit = await create(t, 'widgets', { name: 'Explicit', statecode: 1, statuscode: 2 });
  const kept = t.store.state.tables.widget.find((item) => item.widgetid === explicit);
  assert.equal(kept.statecode, 1);
  assert.equal(kept.statuscode, 2);
});

test('create answers 204 with OData-EntityId and the same Location; a 201 representation has neither', async () => {
  const t = await setup();
  const created = await t.send('POST', `/api/data/${VERSION}/widgets`, { body: { name: 'H' } });
  assert.equal(created.status, 204);
  assert.match(created.headers['OData-EntityId'], /\/widgets\([0-9a-f-]{36}\)$/);
  assert.equal(created.headers.Location, created.headers['OData-EntityId']);
  const shown = await t.send('POST', `/api/data/${VERSION}/widgets`, {
    body: { name: 'S' },
    headers: { prefer: 'return=representation' },
  });
  assert.equal(shown.status, 201);
  assert.equal(shown.headers['OData-EntityId'], undefined);
  assert.equal(shown.headers.Location, undefined);
  assert.equal(shown.headers['Preference-Applied'], 'return=representation');
});

test('a duplicate alternate key answers 412 0x80060892 with the key name and columns', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'a', code: 'D1' });
  const error = await failure(t.send('POST', `/api/data/${VERSION}/widgets`, { body: { name: 'b', code: 'D1' } }));
  assert.equal(error.status, 412);
  assert.equal(error.details.innerCode, '0x80060892');
  assert.equal(error.details.keyName, 'widget_code');
  assert.deepEqual(error.details.columns, ['code']);
  assert.equal(
    error.message,
    'Entity Key widget_code violated. A record with the same value for code already exists. A duplicate record cannot be created. Select one or more unique values and try again.',
  );
});

test('304 answers an empty text/html response with no ETag and no OData-Version', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Tagged' });
  const etag = (await t.send('GET', `/api/data/${VERSION}/widgets(${id})`)).headers.ETag;
  const again = await t.send('GET', `/api/data/${VERSION}/widgets(${id})`, { headers: { 'if-none-match': etag } });
  assert.equal(again.status, 304);
  assert.equal(again.headers['Content-Type'], 'text/html; charset=utf-8');
  assert.equal(again.headers.ETag, undefined);
  assert.equal(again.headers['OData-Version'], undefined);
});

test('lookups to the owner carry their navigation name when annotations are requested', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Owned' });
  const res = await t.send('GET', `/api/data/${VERSION}/widgets(${id})`, {
    headers: annotate('Microsoft.Dynamics.CRM.associatednavigationproperty'),
  });
  assert.equal(res.body['_ownerid_value@Microsoft.Dynamics.CRM.associatednavigationproperty'], 'ownerid');
});

test('Basic-depth reads include rows shared with the caller', async () => {
  const t = await setup();
  const shared = await create(t, 'widgets', { name: 'Shared' });
  await create(t, 'widgets', { name: 'Private' });
  const mine = await create(t, 'widgets', { name: 'Mine' }, t.basic);
  await grantAccess(t.store, {
    target: { logical: 'widget', id: shared },
    principal: { id: t.basic.systemuserid, logical_name: 'systemuser' },
    mask: ACCESS_RIGHTS.Read,
  });
  const list = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name&$orderby=name`, { user: t.basic });
  assert.deepEqual(
    list.body.value.map((row) => row.widgetid),
    [mine, shared],
  );
  const single = await t.send('GET', `/api/data/${VERSION}/widgets(${shared})`, { user: t.basic });
  assert.equal(single.status, 200);
  const write = await failure(
    t.send('PATCH', `/api/data/${VERSION}/widgets(${shared})`, { body: { name: 'Changed' }, user: t.basic }),
  );
  assert.equal(write.details.innerCode, '0x80048306', 'a Read share does not grant Write');
});

test('money columns serialize with four decimals, a currency symbol and the base currency lookup', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Priced', price: 12.5 });
  const res = await t.send('GET', `/api/data/${VERSION}/widgets(${id})?$select=price,${CURRENCY}`, {
    headers: annotate('*'),
  });
  assert.equal(res.status, 200);
  const currency = t.store.state.tables.transactioncurrency[0];
  assert.equal(res.body[CURRENCY], currency.transactioncurrencyid);
  assert.equal(res.body[`${CURRENCY}@OData.Community.Display.V1.FormattedValue`], 'Base currency');
  assert.equal(res.body[`${CURRENCY}@Microsoft.Dynamics.CRM.lookuplogicalname`], 'transactioncurrency');
  assert.equal(res.body['price@OData.Community.Display.V1.FormattedValue'], '$12.50');
  assert.match(stringifyExactJson(res.body), /"price":12\.5000[,}]/);
  const plain = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`);
  assert.ok(!(CURRENCY in plain.body.value[0]), 'rows without a money column carry no currency');
  const list = await t.send('GET', `/api/data/${VERSION}/widgets?$select=price,${CURRENCY}`);
  assert.equal(list.body.value[0][CURRENCY], currency.transactioncurrencyid);
  const priceOnly = await t.send('GET', `/api/data/${VERSION}/widgets?$select=price`, { headers: annotate('*') });
  assert.ok(
    !(CURRENCY in priceOnly.body.value[0]),
    'a $select without the currency lookup omits it and its annotations',
  );
  assert.equal(priceOnly.body.value[0]['price@OData.Community.Display.V1.FormattedValue'], '$12.50');
  assert.ok(
    !Object.keys(list.body.value[0]).some((key) => key.includes('@') && !key.startsWith('@odata.')),
    'annotations stay opt-in',
  );
});

test('money formatting uses the Dataverse base currency when a portal currency row is listed first', async () => {
  const t = await setup();
  // A currency imported for the portal, placed before the base currency in the table.
  await t.store.transact(() =>
    t.store.state.tables.transactioncurrency.unshift({
      transactioncurrencyid: 'eeeeeeee-0000-4000-8000-000000000001',
      currencyname: 'Euro',
      currencysymbol: '€',
      currencyprecision: 2,
    }),
  );
  const id = await create(t, 'widgets', { name: 'Priced', price: 12.5 });
  const res = await t.send('GET', `/api/data/${VERSION}/widgets(${id})?$select=price,${CURRENCY}`, {
    headers: annotate('*'),
  });
  assert.equal(res.body[CURRENCY], baseCurrencyId(ORG));
  assert.equal(res.body[`${CURRENCY}@OData.Community.Display.V1.FormattedValue`], 'Base currency');
  assert.equal(res.body['price@OData.Community.Display.V1.FormattedValue'], '$12.50');
});

test('system columns are written whether or not the mapping declares them, and follow an owner reassignment', async () => {
  const t = await setup();
  const root = t.store.state.tables.businessunit[0].businessunitid;
  // gadget declares neither owner nor audit columns.
  const id = await create(t, 'gadgets', { name: 'Owned' }, t.basic);
  const row = () => t.store.state.tables.gadget.find((item) => item.gadgetid === id);
  assert.equal(lowerId(row().ownerid), t.basic.systemuserid);
  assert.equal(lowerId(row().owninguser), t.basic.systemuserid);
  assert.equal(row().owningteam, null);
  assert.equal(lowerId(row().owningbusinessunit), root);
  assert.equal(lowerId(row().createdby), t.basic.systemuserid);
  assert.equal(lowerId(row().modifiedby), t.basic.systemuserid);
  assert.equal(row().createdonbehalfby, null);
  const assign = await t.send('PATCH', `/api/data/${VERSION}/gadgets(${id})`, {
    body: { 'ownerid@odata.bind': `/systemusers(${t.admin.systemuserid})` },
  });
  assert.equal(assign.status, 204);
  assert.equal(lowerId(row().ownerid), t.admin.systemuserid);
  assert.equal(lowerId(row().owninguser), t.admin.systemuserid);
  assert.equal(lowerId(row().modifiedby), t.admin.systemuserid);
  assert.equal(lowerId(row().createdby), t.basic.systemuserid, 'createdby never changes on update');
  // tags are organization-owned: audit columns only.
  const tag = await create(t, 'tags', { name: 'Org' });
  const tagRow = t.store.state.tables.tag.find((item) => item.tagid === tag);
  assert.equal(lowerId(tagRow.createdby), t.admin.systemuserid);
  assert.ok(!('ownerid' in tagRow) && !('owningbusinessunit' in tagRow));
});

test('undeclared system lookups read as null _x_value and can be selected and filtered', async () => {
  const t = await setup();
  const id = await create(t, 'gadgets', { name: 'Plain' });
  const plain = await t.send('GET', `/api/data/${VERSION}/gadgets(${id})`);
  assert.equal(plain.status, 200);
  assert.equal(plain.body._createdonbehalfby_value, null);
  assert.ok(!('createdonbehalfby' in plain.body));
  const owner = t.admin.systemuserid;
  const selected = await t.send('GET', `/api/data/${VERSION}/gadgets?$select=_ownerid_value`);
  assert.equal(selected.status, 200);
  assert.equal(lowerId(selected.body.value[0]._ownerid_value), owner.toLowerCase());
  const filtered = await t.send('GET', `/api/data/${VERSION}/gadgets?$filter=_ownerid_value eq ${owner}`);
  assert.equal(filtered.status, 200);
  assert.deepEqual(
    filtered.body.value.map((row) => row.gadgetid),
    [id],
  );
});

test('a deep-inserted org-owned child gets audit columns only', async () => {
  const t = await setup();
  const res = await t.send('POST', `/api/data/${VERSION}/widgets`, {
    body: { name: 'Parent', widget_tags: [{ name: 'child-tag' }] },
  });
  assert.equal(res.status, 204);
  const tag = t.store.state.tables.tag.find((row) => row.name === 'child-tag');
  assert.ok(tag, 'the child row was written');
  assert.equal(lowerId(tag.createdby), t.admin.systemuserid.toLowerCase());
  for (const column of ['ownerid', 'owninguser', 'owningteam', 'owningbusinessunit'])
    assert.ok(!(column in tag), column);
});

test("change tracking answers only organization-level readers, and a limited reader's delta leaks no deleted id", async () => {
  const t = await setup();
  const own = await create(t, 'widgets', { name: "Admin's" });
  const denied = await failure(
    t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, {
      user: t.basic,
      headers: { prefer: 'odata.track-changes' },
    }),
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.details.innerCode, '0x80040220');
  assert.match(denied.message, /prvReadWidget\b/);
  const full = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, {
    headers: { prefer: 'odata.track-changes' },
  });
  const link = full.body['@odata.deltaLink'];
  await t.send('DELETE', `/api/data/${VERSION}/widgets(${own})`);
  const limited = await failure(t.send('GET', link, { user: t.basic }));
  assert.equal(limited.status, 403);
  const delta = await t.send('GET', link);
  assert.deepEqual(
    delta.body.value.map((item) => [item.id, item.reason]),
    [[own, 'deleted']],
  );
});

test('a paged tracked read keeps changes made between its pages', async () => {
  const t = await setup();
  for (let i = 0; i < 3; i += 1) await create(t, 'widgets', { name: `Q${i}` });
  const headers = { prefer: 'odata.maxpagesize=2, odata.track-changes' };
  const first = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, { headers });
  assert.ok(first.body['@odata.nextLink'], 'the first page has a nextLink');
  const onFirstPage = first.body.value[0].widgetid;
  await t.send('PATCH', `/api/data/${VERSION}/widgets(${onFirstPage})`, { body: { name: 'Edited' } });
  const next = new URL(first.body['@odata.nextLink']);
  const last = await t.send('GET', next.pathname + next.search, { headers });
  assert.equal(last.body['@odata.nextLink'], undefined);
  const delta = await t.send('GET', last.body['@odata.deltaLink']);
  assert.deepEqual(
    delta.body.value.map((row) => row.widgetid),
    [onFirstPage],
  );
});

test('delta rows carry only the annotations the caller asked for', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Priced', price: 2 });
  const full = await t.send('GET', `/api/data/${VERSION}/widgets`, { headers: { prefer: 'odata.track-changes' } });
  await t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, { body: { name: 'Again', price: 3 } });
  const delta = await t.send('GET', full.body['@odata.deltaLink']);
  const row = delta.body.value.find((item) => !item.reason);
  assert.ok(row, 'the changed row is in the delta');
  assert.deepEqual(
    Object.keys(row).filter((key) => key.includes('@') && key !== '@odata.etag'),
    [],
  );
});

test('$count with a delta token counts the changed and deleted rows', async () => {
  const t = await setup();
  const a = await create(t, 'widgets', { name: 'a' });
  const b = await create(t, 'widgets', { name: 'b' });
  const full = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, {
    headers: { prefer: 'odata.track-changes' },
  });
  await t.send('PATCH', `/api/data/${VERSION}/widgets(${a})`, { body: { name: 'a2' } });
  await t.send('DELETE', `/api/data/${VERSION}/widgets(${b})`);
  const count = await t.send('GET', full.body['@odata.deltaLink'].replace('/widgets?', '/widgets/$count?'));
  assert.deepEqual(count, { status: 200, body: '2' });
});

test('a delta never echoes maxpagesize, because it is not paged', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'a' });
  const full = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, {
    headers: { prefer: 'odata.track-changes' },
  });
  const delta = await t.send('GET', full.body['@odata.deltaLink'], {
    headers: { prefer: 'odata.maxpagesize=2, odata.track-changes' },
  });
  assert.equal(delta.headers['Preference-Applied'], 'odata.track-changes');
});

test('tables whose metadata disables change tracking refuse it with 0x80072491', async () => {
  const t = await setup({ changeTrackingEnabled: (logical) => (logical === 'tag' ? false : undefined) });
  const refused = await failure(
    t.send('GET', `/api/data/${VERSION}/tags?$select=name`, { headers: { prefer: 'odata.track-changes' } }),
  );
  assert.equal(refused.status, 400);
  assert.equal(refused.details.innerCode, '0x80072491');
  assert.equal(refused.message, "Entity tag isn't enabled for change tracking.");
  assert.equal(
    (await t.send('GET', `/api/data/${VERSION}/tags?$select=name`)).status,
    200,
    'without the preference the table reads',
  );
  const widgets = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, {
    headers: { prefer: 'odata.track-changes' },
  });
  assert.equal(widgets.status, 200, 'tables without the flag keep tracking');
});

test('change tracking with FetchXML or $apply answers 400 instead of ignoring the preference', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'x' });
  const xml = encodeURIComponent('<fetch><entity name="widget"><attribute name="name"/></entity></fetch>');
  const fetched = await failure(
    t.send('GET', `/api/data/${VERSION}/widgets?fetchXml=${xml}`, { headers: { prefer: 'odata.track-changes' } }),
  );
  assert.equal(fetched.status, 400);
  assert.equal(fetched.details.innerCode, '0x80060888');
  const applied = await failure(
    t.send('GET', `/api/data/${VERSION}/widgets?$apply=groupby((name))`, {
      headers: { prefer: 'odata.track-changes' },
    }),
  );
  assert.equal(applied.status, 400);
  assert.equal(applied.message, 'The "$apply" query parameter isn\'t supported when Change Tracking is enabled.');
});

test('close() unsubscribes the change log from the store', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'before' });
  assert.equal((await t.changes.since('widget', 0)).changed.length, 1);
  t.handlers.close();
  await create(t, 'widgets', { name: 'after' });
  assert.equal((await t.changes.since('widget', 0)).changed.length, 1, 'a closed log records nothing new');
});

test('query hook: a full result short-circuits the collection, and FetchXML runs through the paged reader', async () => {
  const hooks = createRecordHooks();
  const seen = [];
  hooks.add('query', (c, mapping) => {
    seen.push(mapping.logicalName);
    const marker = c.url.searchParams.get('@marker');
    if (marker === 'full') return { status: 200, body: { value: [{ name: 'from hook' }] } };
    if (marker === 'xml') return { fetchXml: '<fetch><entity name="widget"><attribute name="name"/></entity></fetch>' };
    return undefined;
  });
  const t = await setup({ hooks });
  await create(t, 'widgets', { name: 'real' });
  assert.deepEqual((await t.send('GET', `/api/data/${VERSION}/widgets?@marker=full`)).body, {
    value: [{ name: 'from hook' }],
  });
  assert.deepEqual(
    (await t.send('GET', `/api/data/${VERSION}/widgets?@marker=xml`)).body.value.map((row) => row.name),
    ['real'],
  );
  assert.deepEqual(
    (await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`)).body.value.map((row) => row.name),
    ['real'],
  );
  assert.deepEqual(seen, ['widget', 'widget', 'widget'], 'the hook is consulted first on every collection read');
});

test('query hook on a navigation collection gets the parent as c.mapping and the related mapping as its argument', async () => {
  const hooks = createRecordHooks();
  const calls = [];
  hooks.add('query', (c, mapping) => {
    if (!c.navigation) return undefined;
    calls.push({
      parent: c.mapping.logicalName,
      related: mapping.logicalName,
      parentId: String(c.navigation.parent.id).toLowerCase(),
      parentMapping: c.navigation.parent.mapping.logicalName,
      name: c.navigation.name,
      route: c.route.kind,
    });
    return { status: 200, body: { value: [{ name: 'from hook' }] } };
  });
  const t = await setup({ hooks });
  const id = await create(t, 'widgets', { name: 'Parent' });
  const res = await t.send('GET', `/api/data/${VERSION}/widgets(${id})/widget_gadgets`);
  assert.deepEqual(res.body, { value: [{ name: 'from hook' }] });
  assert.deepEqual(calls, [
    {
      parent: 'widget',
      related: 'gadget',
      parentId: id.toLowerCase(),
      parentMapping: 'widget',
      name: 'widget_gadgets',
      route: 'property',
    },
  ]);
});

test("stream hook answers property and value routes on any verb, ahead of the route's own answer", async () => {
  const hooks = createRecordHooks();
  hooks.add('stream', (c) =>
    c.route.kind === 'value' && c.route.segment === 'name' ? { status: 200, body: 'streamed' } : undefined,
  );
  const t = await setup({ hooks });
  const id = await create(t, 'widgets', { name: 'Plain' });
  assert.equal((await t.send('GET', `/api/data/${VERSION}/widgets(${id})/name/$value`)).body, 'streamed');
  assert.equal(
    (await t.send('GET', `/api/data/${VERSION}/widgets(${id})/name`)).body.value,
    'Plain',
    'other answers stay with the store',
  );
});

test("project hook mutates each formatted row, root and expanded, with the expanded row's own table", async () => {
  const hooks = createRecordHooks();
  hooks.add('project', (c, mapping, formatted) => {
    formatted.marked = mapping.logicalName;
  });
  const t = await setup({ hooks });
  const id = await create(t, 'widgets', { name: 'P' });
  await create(t, 'gadgets', { name: 'G', 'widgetid@odata.bind': `/widgets(${id})` });
  const res = await t.send('GET', `/api/data/${VERSION}/widgets(${id})?$expand=widget_gadgets`);
  assert.equal(res.body.marked, 'widget');
  assert.equal(res.body.widget_gadgets[0].marked, 'gadget');
});

test('write hooks run before and after each write, and a beforeWrite throw stores nothing', async () => {
  const hooks = createRecordHooks();
  const log = [];
  hooks.add('beforeWrite', (c, mapping, info) => {
    log.push(['before', info.operation]);
    if (info.operation === 'create' && info.data.name === 'blocked') {
      throw new DataError('Blocked by hook.', 403, 'Forbidden', { innerCode: '0x80040220' });
    }
  });
  hooks.add('afterWrite', (c, mapping, info) => log.push(['after', info.operation, info.id != null]));
  const t = await setup({ hooks });
  const id = await create(t, 'widgets', { name: 'ok' });
  const blocked = await failure(t.send('POST', `/api/data/${VERSION}/widgets`, { body: { name: 'blocked' } }));
  assert.equal(blocked.message, 'Blocked by hook.');
  assert.equal(
    t.store.state.tables.widget.some((row) => row.name === 'blocked'),
    false,
  );
  await t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, { body: { name: 'renamed' } });
  await t.send('DELETE', `/api/data/${VERSION}/widgets(${id})`);
  assert.deepEqual(log, [
    ['before', 'create'],
    ['after', 'create', true],
    ['before', 'create'],
    ['before', 'update'],
    ['after', 'update', true],
    ['before', 'delete'],
    ['after', 'delete', true],
  ]);
});

test('deep-inserted children reach the write hooks as creates of their own table', async () => {
  const hooks = createRecordHooks();
  const children = [];
  hooks.add('beforeWrite', (c, mapping, info) => {
    if (info.operation === 'create' && mapping.logicalName === 'gadget') children.push(info.data.name);
  });
  const t = await setup({ hooks });
  await t.send('POST', `/api/data/${VERSION}/widgets`, { body: { name: 'Parent', widget_gadgets: [{ name: 'kid' }] } });
  assert.deepEqual(children, ['kid']);
});

test('deep insert authorizes each nested child as a create, append and appendto, and a refusal names the child table', async () => {
  const t = await setup();
  const denied = await failure(
    t.send('POST', `/api/data/${VERSION}/widgets`, {
      body: { name: 'Parent', widget_tags: [{ name: 'tagged' }] },
      user: t.basic,
    }),
  );
  assert.equal(denied.status, 403);
  assert.equal(denied.details.innerCode, '0x80040220');
  assert.match(denied.message, /\btag\b/);
  assert.equal(t.store.state.tables.widget.length, 0, 'a refused child writes nothing');
  await t.send('POST', `/api/data/${VERSION}/widgets`, {
    body: { name: 'Parent', widget_gadgets: [{ name: 'kid' }] },
    user: t.basic,
  });
  assert.equal(t.store.state.tables.widget.length, 1);
  assert.equal(t.store.state.tables.gadget.length, 1);
});

test("deep-inserted children carry their own table's audit and owner columns, with the caller on behalf", async () => {
  const t = await setup();
  await t.send('POST', `/api/data/${VERSION}/widgets`, {
    body: { name: 'Parent', widget_gadgets: [{ name: 'kid' }] },
    user: t.basic,
    caller: t.admin,
  });
  const kid = t.store.state.tables.gadget[0];
  assert.equal(lowerId(kid.createdby), t.basic.systemuserid.toLowerCase());
  assert.equal(lowerId(kid.createdonbehalfby), t.admin.systemuserid.toLowerCase());
  assert.equal(lowerId(kid.ownerid), t.basic.systemuserid.toLowerCase());
});

test('create and update take the next org-wide row version across tables, and the ETag is that versionnumber', async () => {
  const t = await setup();
  const widgetId = await create(t, 'widgets', { name: 'Alpha' });
  const widget = t.store.state.tables.widget[0];
  const created = widget.versionnumber;
  await create(t, 'tags', { name: 'Beta' });
  const tag = t.store.state.tables.tag[0];
  assert.equal(tag.versionnumber, created + 1, 'the tag takes the next version after the widget');
  await t.send('PATCH', `/api/data/${VERSION}/widgets(${widgetId})`, { body: { name: 'Alpha2' } });
  const patched = t.store.state.tables.widget[0];
  assert.equal(patched.versionnumber, tag.versionnumber + 1, 'the patch takes the next version after the tag');
  assert.equal(t.store.state.rowVersion, patched.versionnumber);
  const etag = (await t.send('GET', `/api/data/${VERSION}/widgets(${widgetId})`)).headers.ETag;
  assert.equal(etag, `W/"${patched.versionnumber}"`);
});

test('a delete after a token is logged after that token, so a delta read reports it', async () => {
  const t = await setup();
  const widgetId = await create(t, 'widgets', { name: 'Doomed' });
  const token = t.changes.token();
  await t.send('DELETE', `/api/data/${VERSION}/widgets(${widgetId})`);
  const { revision } = t.changes.parse(token);
  assert.deepEqual(await t.changes.since('widget', revision), { changed: [], deleted: [widgetId.toLowerCase()] });
});

test('system columns in a payload are ignored on create and update; overriddencreatedon sets createdon on create only', async () => {
  const t = await setup();
  const id = await create(
    t,
    'widgets',
    {
      name: 'Stamped',
      'createdby@odata.bind': `/systemusers(${t.admin.systemuserid})`,
      createdon: '2001-01-01T00:00:00Z',
      'owninguser@odata.bind': `/systemusers(${t.admin.systemuserid})`,
      versionnumber: 99,
      overriddencreatedon: '2020-01-02T03:04:05Z',
    },
    t.basic,
  );
  const row = () => t.store.state.tables.widget.find((item) => lowerId(item.widgetid) === id.toLowerCase());
  assert.equal(lowerId(row().createdby), t.basic.systemuserid.toLowerCase(), 'the system stamp wins over the payload');
  assert.equal(lowerId(row().owninguser), t.basic.systemuserid.toLowerCase());
  assert.notEqual(row().versionnumber, 99);
  assert.equal(row().createdon, '2020-01-02T03:04:05.000Z');
  assert.equal(row().overriddencreatedon, '2020-01-02T03:04:05.000Z');
  // Not observed natively: ignoring these silently on update is a guess.
  await t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, {
    body: {
      name: 'Patched',
      createdon: '2031-01-01T00:00:00Z',
      overriddencreatedon: '2030-01-01T00:00:00Z',
      'modifiedby@odata.bind': `/systemusers(${t.basic.systemuserid})`,
    },
    user: t.admin,
  });
  assert.equal(row().name, 'Patched');
  assert.equal(row().createdon, '2020-01-02T03:04:05.000Z', 'createdon never changes on update');
  assert.equal(row().overriddencreatedon, '2020-01-02T03:04:05.000Z', 'overriddencreatedon is ignored on update');
  assert.equal(
    lowerId(row().modifiedby),
    t.admin.systemuserid.toLowerCase(),
    'modifiedby is stamped with the caller, not the bind',
  );
});

test('a plain lookup, owner or audit property answers 400 0x0 and writes nothing; its bind form is accepted and ignored', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Plain' }, t.basic);
  const refused = [
    { name: 'x', ownerid: { id: t.admin.systemuserid, logical_name: 'systemuser' } },
    { name: 'x', createdby: t.admin.systemuserid },
    { name: 'x', _ownerid_value: t.admin.systemuserid },
  ];
  for (const body of refused) {
    const create400 = await failure(t.send('POST', `/api/data/${VERSION}/widgets`, { body, user: t.basic }));
    assert.equal(create400.status, 400);
    assert.equal(create400.details.innerCode, '0x0');
    assert.match(create400.message, /Does not support untyped value in non-open type/);
  }
  const patch400 = await failure(
    t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, {
      body: { createdby: t.admin.systemuserid, ownerid: { id: t.admin.systemuserid, logical_name: 'systemuser' } },
      user: t.basic,
    }),
  );
  assert.equal(patch400.status, 400);
  assert.equal(patch400.details.innerCode, '0x0');
  const row = t.store.state.tables.widget.find((item) => item.widgetid === id);
  assert.equal(lowerId(row.createdby), t.basic.systemuserid.toLowerCase());
  assert.equal(lowerId(row.ownerid), t.basic.systemuserid.toLowerCase());
  // The bind form of an audit column is accepted and ignored: the stored createdby stays the caller.
  const bound = await create(
    t,
    'widgets',
    { name: 'Bound', 'createdby@odata.bind': `/systemusers(${t.admin.systemuserid})` },
    t.basic,
  );
  const bow = t.store.state.tables.widget.find((item) => item.widgetid === bound);
  assert.equal(lowerId(bow.createdby), t.basic.systemuserid.toLowerCase());
});

test('$expand, navigation $filter and FetchXML link-entity trim rows the caller cannot read', async () => {
  const t = await setup();
  const adminWidget = await create(t, 'widgets', { name: 'AdminWidget' });
  const mine = await create(t, 'widgets', { name: 'BasicWidget' }, t.basic);
  const gadget = await create(
    t,
    'gadgets',
    { name: 'BasicGadget', 'widgetid@odata.bind': `/widgets(${mine})` },
    t.basic,
  );
  // The basic user cannot bind to the admin's widget, so the link is set in state.
  t.store.state.tables.gadget.find((row) => lowerId(row.gadgetid) === gadget.toLowerCase()).widgetid = adminWidget;
  const expanded = await t.send('GET', `/api/data/${VERSION}/gadgets?$select=name&$expand=widgetid($select=name)`, {
    user: t.basic,
  });
  assert.equal(expanded.body.value[0].widgetid, null);
  assert.ok(!JSON.stringify(expanded.body).includes('AdminWidget'));
  const reached = await t.send(
    'GET',
    `/api/data/${VERSION}/gadgets?$select=name&$filter=widgetid/name eq 'AdminWidget'`,
    { user: t.basic },
  );
  assert.deepEqual(reached.body.value, []);
  const admin = await t.send('GET', `/api/data/${VERSION}/gadgets?$select=name&$filter=widgetid/name eq 'AdminWidget'`);
  assert.equal(admin.body.value.length, 1, 'the admin reads the link, so the filter is not simply broken');
  const xml = `<fetch><entity name="gadget"><attribute name="name"/><link-entity name="widget" from="widgetid" to="widgetid" link-type="outer" alias="w"><attribute name="name" alias="w.name"/></link-entity></entity></fetch>`;
  const linked = await t.send('GET', `/api/data/${VERSION}/gadgets?fetchXml=${encodeURIComponent(xml)}`, {
    user: t.basic,
  });
  assert.equal(linked.body.value.length, 1);
  assert.ok(!JSON.stringify(linked.body).includes('AdminWidget'));
});

test('collection responses carry the global metadata version after the count, when requested', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'a' });
  const res = await t.send('GET', `/api/data/${VERSION}/widgets?$count=true&$select=name`, {
    headers: annotate('Microsoft.Dynamics.CRM.globalmetadataversion'),
  });
  assert.deepEqual(Object.keys(res.body).slice(0, 3), [
    '@odata.context',
    '@odata.count',
    '@Microsoft.Dynamics.CRM.globalmetadataversion',
  ]);
  assert.match(res.body['@Microsoft.Dynamics.CRM.globalmetadataversion'], /^\d+$/);
  const plain = await t.send('GET', `/api/data/${VERSION}/widgets?$count=true&$select=name`);
  assert.equal(plain.body['@Microsoft.Dynamics.CRM.globalmetadataversion'], undefined);
});

test('FetchXML with returntotalrecordcount answers the count and, when included, the total and its limit flag', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'a' });
  await create(t, 'widgets', { name: 'b' });
  const counted = encodeURIComponent(
    '<fetch returntotalrecordcount="true"><entity name="widget"><attribute name="name"/></entity></fetch>',
  );
  const res = await t.send('GET', `/api/data/${VERSION}/widgets?fetchXml=${counted}`, { headers: annotate('*') });
  assert.equal(res.body['@odata.count'], 2);
  assert.equal(res.body['@Microsoft.Dynamics.CRM.totalrecordcount'], 2);
  assert.equal(res.body['@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded'], false);
  assert.equal(res.body.value.length, 2);
  const plain = encodeURIComponent('<fetch><entity name="widget"><attribute name="name"/></entity></fetch>');
  const uncounted = await t.send('GET', `/api/data/${VERSION}/widgets?fetchXml=${plain}`, { headers: annotate('*') });
  assert.equal(uncounted.body['@odata.count'], undefined);
  assert.equal(uncounted.body['@Microsoft.Dynamics.CRM.totalrecordcount'], undefined);
});

test('savedQuery and userQuery answer 501 when no query hook answers them, on collections and navigations', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'a' });
  for (const name of ['savedQuery', 'userQuery']) {
    const denied = await failure(t.send('GET', `/api/data/${VERSION}/widgets?${name}=${MISSING}`));
    assert.equal(denied.status, 501);
    assert.equal(denied.details.innerCode, '0x80040216');
    assert.equal(denied.message, `${name} has not yet been implemented.`);
  }
  const nav = await failure(t.send('GET', `/api/data/${VERSION}/widgets(${id})/widget_gadgets?savedQuery=${MISSING}`));
  assert.equal(nav.status, 501);
});

test('UpdateMultiple keeps the first target per key; UpsertMultiple refuses a repeated key before writing', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'orig' });
  const res = await t.send('POST', `/api/data/${VERSION}/widgets/Microsoft.Dynamics.CRM.UpdateMultiple`, {
    body: {
      Targets: [
        { widgetid: id, name: 'first' },
        { widgetid: id, name: 'second' },
      ],
    },
  });
  assert.equal(res.status, 204);
  assert.equal(t.store.state.tables.widget[0].name, 'first');
  const dup = await failure(
    t.send('POST', `/api/data/${VERSION}/widgets/Microsoft.Dynamics.CRM.UpsertMultiple`, {
      body: {
        Targets: [
          { '@odata.id': `/widgets(${id})`, name: 'a' },
          { '@odata.id': `/widgets(${id})`, name: 'b' },
        ],
      },
    }),
  );
  assert.equal(dup.status, 400);
  assert.equal(dup.details.innerCode, '0x80040203');
  assert.equal(dup.message, 'Duplicate key in Targets.');
  assert.equal(t.store.state.tables.widget[0].name, 'first', 'nothing is written');
});

test("change tracking reads the mapping's flag (or its metadata) unless the option overrides it", async () => {
  const refused = await setup();
  refused.store.state.mappings.tag.changeTrackingEnabled = false;
  const error = await failure(
    refused.send('GET', `/api/data/${VERSION}/tags?$select=name`, { headers: { prefer: 'odata.track-changes' } }),
  );
  assert.equal(error.details.innerCode, '0x80072491');
  const metadata = await setup();
  metadata.store.state.mappings.tag.dataverseMetadata = { ChangeTrackingEnabled: false };
  assert.equal(
    (
      await failure(
        metadata.send('GET', `/api/data/${VERSION}/tags?$select=name`, { headers: { prefer: 'odata.track-changes' } }),
      )
    ).details.innerCode,
    '0x80072491',
  );
  const overridden = await setup({ changeTrackingEnabled: () => undefined });
  overridden.store.state.mappings.tag.changeTrackingEnabled = false;
  assert.equal(
    (
      await overridden.send('GET', `/api/data/${VERSION}/tags?$select=name`, {
        headers: { prefer: 'odata.track-changes' },
      })
    ).status,
    200,
  );
});

test("afterWrite runs inside the write's transaction: an awaited hook sees the row, and its throw rolls back the write and its own changes", async () => {
  const hooks = createRecordHooks();
  const seen = [];
  hooks.add('beforeWrite', async (c, mapping, info) => {
    await Promise.resolve();
    seen.push(`before:${info.operation}`);
  });
  hooks.add('afterWrite', async (c, mapping, info) => {
    await Promise.resolve();
    seen.push(`after:${info.operation}`);
    if (mapping.logicalName !== 'widget' || info.operation !== 'create') return;
    seen.push(`row-visible:${t.store.state.tables.widget.some((row) => row.name === c.body.name)}`);
    t.store.insertRow('tag', t.store.state.tables.tag, { tagid: randomUUID(), name: `mark-${c.body.name}` });
    if (c.body.name === 'veto')
      throw new DataError('Vetoed after the write.', 403, 'Forbidden', { innerCode: '0x80040220' });
  });
  const t = await setup({ hooks });
  const vetoed = await failure(t.send('POST', `/api/data/${VERSION}/widgets`, { body: { name: 'veto' } }));
  assert.equal(vetoed.message, 'Vetoed after the write.');
  assert.equal(
    t.store.state.tables.widget.some((row) => row.name === 'veto'),
    false,
    'the write rolls back',
  );
  assert.equal(
    t.store.state.tables.tag.some((row) => row.name === 'mark-veto'),
    false,
    "the hook's own change rolls back",
  );
  await t.send('POST', `/api/data/${VERSION}/widgets`, { body: { name: 'kept' } });
  assert.equal(
    t.store.state.tables.widget.some((row) => row.name === 'kept'),
    true,
  );
  assert.equal(
    t.store.state.tables.tag.some((row) => row.name === 'mark-kept'),
    true,
    "the hook's change persists with the write",
  );
  assert.deepEqual(
    seen.slice(0, 3),
    ['before:create', 'after:create', 'row-visible:true'],
    'the row is visible to the awaited hook inside the transaction',
  );
});

test('expanding or linking to a table the caller cannot read answers 403, with or without rows in it', async () => {
  const t = await setup();
  const mine = await create(t, 'widgets', { name: 'BasicWidget' }, t.basic);
  t.store.state.mappings.vault = {
    logicalName: 'vault',
    entitySet: 'vaults',
    idColumn: 'vaultid',
    nameColumn: 'name',
    fields: { name: text },
  };
  t.store.state.mappings.widget.relationships.widget_vault = {
    entity: 'vault',
    from: 'widgetid',
    to: 'vaultid',
    many: false,
  };
  // Every built-in role reads org-owned tables, so the vault table is added without privileges.
  t.store.state.tables.vault = [];
  const expanded = await failure(
    t.send('GET', `/api/data/${VERSION}/widgets(${mine})?$expand=widget_vault`, { user: t.basic }),
  );
  assert.equal(expanded.status, 403);
  assert.equal(expanded.details.innerCode, '0x80040220');
  t.store.state.tables.vault.push({ vaultid: randomUUID(), name: 'gold' });
  const withRow = await failure(
    t.send('GET', `/api/data/${VERSION}/widgets(${mine})?$expand=widget_vault`, { user: t.basic }),
  );
  assert.equal(withRow.status, 403);
  assert.equal(withRow.details.innerCode, '0x80040220');
  const xml =
    '<fetch><entity name="widget"><attribute name="name"/><link-entity name="vault" from="vaultid" to="widgetid" link-type="outer" alias="v"><attribute name="name" alias="v.name"/></link-entity></entity></fetch>';
  const linked = await failure(
    t.send('GET', `/api/data/${VERSION}/widgets?fetchXml=${encodeURIComponent(xml)}`, { user: t.basic }),
  );
  assert.equal(linked.status, 403);
  assert.equal(linked.details.innerCode, '0x80040220');
});

test('the raw request body reaches the stream and write hooks as c.bodyBuffer', async () => {
  const hooks = createRecordHooks();
  const raw = [];
  hooks.add('stream', (c) => {
    if (c.route.kind === 'value') raw.push(['stream', c.bodyBuffer.toString('utf8')]);
    return undefined;
  });
  hooks.add('beforeWrite', (c, mapping, info) => {
    raw.push(['before', info.operation, Buffer.isBuffer(c.bodyBuffer) && c.bodyBuffer.toString('utf8')]);
  });
  const t = await setup({ hooks });
  const id = await create(t, 'widgets', { name: 'Raw' });
  raw.length = 0;
  await t.send('GET', `/api/data/${VERSION}/widgets(${id})/name/$value`, { bodyBuffer: Buffer.from('raw-get') });
  await t.send('POST', `/api/data/${VERSION}/widgets`, {
    body: { name: 'x' },
    bodyBuffer: Buffer.from('{"name":"x"}'),
  });
  assert.deepEqual(raw, [
    ['stream', 'raw-get'],
    ['before', 'create', '{"name":"x"}'],
  ]);
});

test('FetchXML aggregates answer a formatted value for count and sum when annotations are requested', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'a', price: 1.5 });
  await create(t, 'widgets', { name: 'b', price: 2.25 });
  const xml = encodeURIComponent(
    '<fetch aggregate="true"><entity name="widget"><attribute name="widgetid" aggregate="count" alias="n"/><attribute name="price" aggregate="sum" alias="total"/></entity></fetch>',
  );
  const res = await t.send('GET', `/api/data/${VERSION}/widgets?fetchXml=${xml}`, {
    headers: annotate('OData.Community.Display.V1.FormattedValue'),
  });
  const [row] = res.body.value;
  assert.equal(row.n, 2);
  assert.equal(row['n@OData.Community.Display.V1.FormattedValue'], '2');
  assert.equal(row['total@OData.Community.Display.V1.FormattedValue'], '3.75');
});

test('an expanded collection over 5000 rows answers the first page and a nav@odata.nextLink that pages on', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Parent' });
  for (let i = 0; i < 5001; i++)
    t.store.state.tables.gadget.push({ gadgetid: randomUUID(), name: `g${i}`, widgetid: id });
  const res = await t.send('GET', `/api/data/${VERSION}/widgets(${id})?$expand=widget_gadgets`);
  assert.equal(res.body.widget_gadgets.length, 5000);
  const link = res.body['widget_gadgets@odata.nextLink'];
  assert.ok(link.startsWith(`${ORIGIN}/api/data/${VERSION}/widgets(${id})/widget_gadgets?$skiptoken=`), link);
  const rest = await t.send('GET', link);
  assert.equal(rest.body.value.length, 1);
});

test('expansion options are checked: $skip is refused, and a paged many-valued expansion nested under another is refused', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'P' });
  const skip = await failure(t.send('GET', `/api/data/${VERSION}/widgets(${id})?$expand=widget_gadgets($skip=1)`));
  assert.equal(skip.details.innerCode, '0x80060888');
  assert.equal(skip.message, '$skip, $count, $search, and $levels are not supported inside $expand');
  const nested = await failure(
    t.send('GET', `/api/data/${VERSION}/gadgets?$expand=widgetid($expand=widget_gadgets($top=1))`),
  );
  assert.equal(nested.details.innerCode, '0x80060888');
});

test('a $filter with a negated Dataverse query function answers 400 0x80060888', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'a' });
  const error = await failure(
    t.send(
      'GET',
      `/api/data/${VERSION}/widgets?$filter=not Microsoft.Dynamics.CRM.Between(PropertyName='name',PropertyValues=['a','b'])`,
    ),
  );
  assert.equal(error.details.innerCode, '0x80060888');
  assert.match(error.message, /Not operator along with the Custom Named Condition operators/);
});

test('$apply aggregate aliases carry a formatted value when annotations are requested', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'a', price: 1.5 });
  await create(t, 'widgets', { name: 'b', price: 2.25 });
  const res = await t.send('GET', `/api/data/${VERSION}/widgets?$apply=aggregate(price with sum as total)`, {
    headers: annotate('OData.Community.Display.V1.FormattedValue'),
  });
  assert.equal(res.body.value[0].total, 3.75);
  assert.equal(res.body.value[0]['total@OData.Community.Display.V1.FormattedValue'], '3.75');
  const plain = await t.send('GET', `/api/data/${VERSION}/widgets?$apply=aggregate(price with sum as total)`);
  assert.equal(plain.body.value[0]['total@OData.Community.Display.V1.FormattedValue'], undefined);
});

// Column-level security over the record handlers: the handlers read api.fieldSecurity through the getter.
// The widget and gadget secret columns are secured; BASIC has no field permissions, the admin bypasses them.
async function securedSetup() {
  let api;
  const hooks = createRecordHooks();
  const t = await setup({ fieldSecurity: () => api?.fieldSecurity, hooks });
  api = {
    store: t.store,
    principals: t.principals,
    settings: SETTINGS,
    change: (fn) => fn(),
    registry: { register() {} },
    recordHooks: hooks,
  };
  await fieldSecurity.install(api);
  const secured = { dataverseType: 'nvarchar', columnMetadata: { isSecured: true } };
  t.store.state.mappings.widget.fields.secret = secured;
  t.store.state.mappings.gadget.fields.secret = secured;
  return t;
}

// Rows are created by the basic user, who owns them, so the basic user reads them; the secret values are set in state
// (the basic user holds no field permission to write them).
async function securedRow(t, set, values, user = t.basic) {
  const id = await create(
    t,
    set,
    { name: values.name, ...(values.bind ? { 'widgetid@odata.bind': values.bind } : {}) },
    user,
  );
  const logical = set === 'widgets' ? 'widget' : 'gadget';
  const row = t.store.state.tables[logical].find((item) => lowerId(item[`${logical}id`]) === id.toLowerCase());
  if (values.secret !== undefined) row.secret = values.secret;
  return id;
}

test('FetchXML hides secured root and link-entity columns, aliased ones too, and refuses aggregates over them', async () => {
  const t = await securedSetup();
  const w1 = await securedRow(t, 'widgets', { name: 'W1', secret: 's1' });
  await securedRow(t, 'gadgets', { name: 'G1', secret: 'g1', bind: `/widgets(${w1})` });
  const linked = `<fetch><entity name="gadget"><attribute name="name"/><attribute name="secret"/><link-entity name="widget" from="widgetid" to="widgetid" link-type="outer" alias="w"><attribute name="secret"/><attribute name="name" alias="w.name"/><attribute name="secret" alias="ws"/></link-entity></entity></fetch>`;
  const path = `/api/data/${VERSION}/gadgets?fetchXml=${encodeURIComponent(linked)}`;
  const basic = await t.send('GET', path, { user: t.basic });
  const row = basic.body.value[0];
  assert.equal(row.name, 'G1');
  assert.equal(row['w.name'], 'W1');
  for (const hidden of ['secret', 'w.secret', 'ws']) assert.equal(Object.hasOwn(row, hidden), false, hidden);
  assert.ok(!JSON.stringify(basic.body).includes('s1') && !JSON.stringify(basic.body).includes('g1'));
  const admin = await t.send('GET', path);
  assert.equal(admin.body.value[0].secret, 'g1');
  assert.equal(admin.body.value[0]['w.secret'], 's1');
  assert.equal(admin.body.value[0].ws, 's1');
  // An aggregate over the root or a link-entity secured column answers 403 for the basic user, 200 for the admin.
  const rootAgg = `<fetch aggregate="true"><entity name="gadget"><attribute name="secret" aggregate="count" alias="n"/></entity></fetch>`;
  const linkAgg = `<fetch aggregate="true"><entity name="gadget"><attribute name="name" aggregate="count" alias="n"/><link-entity name="widget" from="widgetid" to="widgetid" link-type="outer" alias="w"><attribute name="secret" aggregate="max" alias="m"/></link-entity></entity></fetch>`;
  for (const xml of [rootAgg, linkAgg]) {
    const refused = await failure(
      t.send('GET', `/api/data/${VERSION}/gadgets?fetchXml=${encodeURIComponent(xml)}`, { user: t.basic }),
    );
    assert.equal(refused.status, 403);
    assert.equal(refused.details.innerCode, '0x8004f508');
    assert.equal((await t.send('GET', `/api/data/${VERSION}/gadgets?fetchXml=${encodeURIComponent(xml)}`)).status, 200);
  }
  // $apply over a secured column is refused the same way; the admin groups it.
  const applied = await failure(
    t.send('GET', `/api/data/${VERSION}/widgets?$apply=groupby((secret))`, { user: t.basic }),
  );
  assert.equal(applied.details.innerCode, '0x8004f508');
  assert.equal((await t.send('GET', `/api/data/${VERSION}/widgets?$apply=groupby((secret))`)).status, 200);
});

test('a Dataverse groupby without $orderby answers its groups in ascending key order', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'Beta', price: 1 });
  await create(t, 'widgets', { name: 'Alpha', price: 2 });
  await create(t, 'widgets', { name: 'Beta', price: 4 });
  // Native sorts groups by key when there is no $orderby.
  const grouped = await t.send(
    'GET',
    `/api/data/${VERSION}/widgets?$apply=groupby((name),aggregate(price with sum as total))`,
  );
  assert.equal(grouped.status, 200);
  assert.deepEqual(
    grouped.body.value.map((row) => [row.name, row.total]),
    [
      ['Alpha', 2],
      ['Beta', 5],
    ],
  );
});

test('$filter, $orderby and $count on a hidden secured column read it as null for the caller', async () => {
  const t = await securedSetup();
  await securedRow(t, 'widgets', { name: 'a' });
  await securedRow(t, 'widgets', { name: 'b' });
  const names = (res) => res.body.value.map((row) => row.name);
  // The unsorted order follows the store, not insertion; give the first unsorted row the lower secret so a leaked
  // descending sort on secret would reverse it.
  const unsorted = names(await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, { user: t.basic }));
  for (const [index, name] of unsorted.entries())
    t.store.state.tables.widget.find((row) => row.name === name).secret = `s${index + 1}`;
  // The hidden value is null, so an equality on it matches nothing for the basic user and one row for the admin.
  const hiddenEq = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name,secret&$filter=secret eq 's1'`, {
    user: t.basic,
  });
  assert.deepEqual(hiddenEq.body.value, []);
  assert.equal(
    (await t.send('GET', `/api/data/${VERSION}/widgets?$select=name&$filter=secret eq 's1'`)).body.value.length,
    1,
  );
  // A count is an Edm.Int32: a $filter that names the hidden column is refused, as it is for any property.
  const countHidden = await failure(
    t.send('GET', `/api/data/${VERSION}/widgets/$count?$filter=secret eq 's1'`, { user: t.basic }),
  );
  assert.equal(countHidden.message, "Could not find a property named 'secret' on type 'Edm.Int32'.");
  // A sort on the hidden column is dropped for the basic user: the order is the unsorted one.
  const hiddenSort = names(
    await t.send('GET', `/api/data/${VERSION}/widgets?$select=name&$orderby=secret desc`, { user: t.basic }),
  );
  assert.deepEqual(hiddenSort, unsorted);
  // The admin sorts on the real values.
  assert.deepEqual(
    names(await t.send('GET', `/api/data/${VERSION}/widgets?$select=name&$orderby=secret desc`)),
    [...unsorted].reverse(),
  );
  // A $apply filter on the hidden column leaves the pipeline and matches nothing for the basic user.
  assert.equal(
    (await t.send('GET', `/api/data/${VERSION}/widgets?$apply=filter(secret eq 's1')`, { user: t.basic })).body.value
      .length,
    0,
  );
  assert.equal(
    (await t.send('GET', `/api/data/${VERSION}/widgets?$apply=filter(secret eq 's1')`)).body.value.length,
    1,
  );
  // Plain reads still hide the value itself.
  const plain = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name,secret`, { user: t.basic });
  assert.ok(plain.body.value.every((row) => row.secret == null));
});

test('a read with no $select or $select=* answers every table column, unset ones as null; a $select list names only its columns', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Sparse' });
  const star = await t.send('GET', `/api/data/${VERSION}/widgets?$select=*`);
  assert.equal(star.body['@odata.context'], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(*)`);
  const row = star.body.value[0];
  assert.equal(row.widgetid, id);
  assert.equal((await t.send('GET', `/api/data/${VERSION}/widgets(${id})?$select=*`)).body.name, 'Sparse');
  for (const column of [
    'widgetid',
    'name',
    'code',
    'price',
    'status',
    'createdon',
    'statecode',
    'statuscode',
    '_createdby_value',
    '_ownerid_value',
  ]) {
    assert.ok(column in row, `${column} is answered`);
  }
  assert.equal(row.code, null);
  assert.equal(row.price, null);
  assert.equal(row[CURRENCY], null, 'the base currency lookup is answered null when no money is set');
  assert.equal(row.price_base, null);
  // Without $select the answer is the same set of columns, single-row reads included.
  const plain = await t.send('GET', `/api/data/${VERSION}/widgets(${id})`);
  assert.equal(plain.body.code, null);
  assert.ok('status' in plain.body);
  // A $select list still answers only its own columns.
  const named = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`);
  assert.deepEqual(
    Object.keys(named.body.value[0])
      .filter((key) => !key.includes('@'))
      .sort(),
    ['name', 'widgetid'],
  );
});

test('a row with a money value answers its base amount, the base currency and exchange rate 1', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'Priced', price: 12.5 });
  const row = (await t.send('GET', `/api/data/${VERSION}/widgets`)).body.value[0];
  assert.match(stringifyExactJson(row), /"price_base":12\.5000[,}]/);
  assert.equal(row.exchangerate, 1);
  assert.equal(row[CURRENCY], baseCurrencyId(ORG));
});

test('a full-row read formats the base companion like its money column and the rate at 12 places', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'Priced', price: 12.5 });
  const row = (await t.send('GET', `/api/data/${VERSION}/widgets`, { headers: annotate('*') })).body.value[0];
  const formatted = '@OData.Community.Display.V1.FormattedValue';
  assert.equal(row[`price${formatted}`], '$12.50');
  assert.equal(row[`price_base${formatted}`], row[`price${formatted}`]);
  assert.equal(row[`exchangerate${formatted}`], '1.000000000000');
});

test('the @odata.context lists a repeated $select column once, then each expansion with its columns', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Parent' });
  await create(t, 'gadgets', { name: 'Child', 'widgetid@odata.bind': `/widgets(${id})` });
  const deduped = await t.send(
    'GET',
    `/api/data/${VERSION}/widgets?$select=name,name&$expand=widget_gadgets($select=name,name)`,
  );
  assert.equal(
    deduped.body['@odata.context'],
    `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(name,widget_gadgets(name))`,
  );
  const filtered = await t.send('GET', `/api/data/${VERSION}/widgets?$expand=widget_gadgets($filter=name eq 'Child')`);
  assert.equal(filtered.body['@odata.context'], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(widget_gadgets())`);
});

test('a FetchXML context lists the columns alphabetically with the id, and an aggregate has no column list', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'Listed', price: 2 });
  const listed = await t.send(
    'GET',
    `/api/data/${VERSION}/widgets?fetchXml=${encodeURIComponent("<fetch><entity name='widget'><attribute name='price'/><attribute name='name'/></entity></fetch>")}`,
  );
  assert.equal(listed.body['@odata.context'], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets(name,price,widgetid)`);
  const total = await t.send(
    'GET',
    `/api/data/${VERSION}/widgets?fetchXml=${encodeURIComponent("<fetch aggregate='true'><entity name='widget'><attribute name='price' aggregate='sum' alias='total'/></entity></fetch>")}`,
  );
  assert.equal(total.body['@odata.context'], `${ORIGIN}/api/data/${VERSION}/$metadata#widgets`);
});

test('a single-valued $ref answers the $ref context', async () => {
  const t = await setup();
  const widget = await create(t, 'widgets', { name: 'Target' });
  const gadget = await create(t, 'gadgets', { name: 'Pointer', 'widgetid@odata.bind': `/widgets(${widget})` });
  const ref = await t.send('GET', `/api/data/${VERSION}/gadgets(${gadget})/widgetid/$ref`);
  assert.equal(ref.body['@odata.context'], `${ORIGIN}/api/data/${VERSION}/$metadata#$ref`);
  assert.equal(ref.body['@odata.id'], `${ORIGIN}/api/data/${VERSION}/widgets(${widget})`);
});

test('an expanded collection links its children, each child carries its parent lookup, and an unselected expansion answers every column', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Parent' });
  await create(t, 'gadgets', { name: 'Child', 'widgetid@odata.bind': `/widgets(${id})` });
  const selected = await t.send('GET', `/api/data/${VERSION}/widgets?$expand=widget_gadgets($select=name)`, {
    headers: annotate('*'),
  });
  const row = selected.body.value[0];
  assert.equal(
    row['widget_gadgets@odata.nextLink'],
    `${ORIGIN}/api/data/${VERSION}/widgets(${id})/widget_gadgets?$select=name`,
  );
  assert.equal(row.widget_gadgets[0]._widgetid_value, id);
  assert.ok(
    !('OData.Community.Display.V1.FormattedValue' in row.widget_gadgets[0]) &&
      !Object.keys(row.widget_gadgets[0]).some((key) => key.includes('@OData')),
    'no formatted annotation leaks into an expanded row without a Prefer',
  );
  const all = await t.send('GET', `/api/data/${VERSION}/widgets?$expand=widget_gadgets`);
  assert.ok('createdon' in all.body.value[0].widget_gadgets[0], 'a child with no $select answers every column');
  const single = await t.send('GET', `/api/data/${VERSION}/gadgets?$expand=widgetid($select=name)`);
  assert.match(single.body.value[0].widgetid['@odata.etag'], /^W\/"\d+"$/);
});

test('query options Dataverse refuses answer 400 0x80060888 with its message', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'Counted' });
  const cases = [
    ['$filter=', "The value for OData query '$filter' cannot be empty."],
    ['$count=garbage', "'garbage' is not a valid count option."],
    ['$top=0', 'Invalid value for $top query option.'],
    ['$top=1&$top=2', "Query option '$top' was specified more than once, but it must be specified at most once."],
  ];
  for (const [query, message] of cases) {
    const error = await failure(t.send('GET', `/api/data/${VERSION}/widgets?${query}`));
    assert.equal(error.status, 400, query);
    assert.equal(error.details.innerCode, '0x80060888', query);
    assert.equal(error.message, message, query);
  }
  const counted = await t.send('GET', `/api/data/${VERSION}/widgets?$count=false`);
  assert.equal(counted.status, 200);
  assert.equal(counted.body['@odata.count'], undefined);
});

test('a $skiptoken that is not a paging cookie answers malformed XML (0x80040201)', async () => {
  const t = await setup();
  const error = await failure(t.send('GET', `/api/data/${VERSION}/widgets?$skiptoken=bad-token`));
  assert.equal(error.status, 400);
  assert.equal(error.details.innerCode, '0x80040201');
  assert.equal(error.message, 'Malformed XML');
});

test('a non-32-bit odata.maxpagesize answers 405 0x80060888, and maxpagesize=0 pages with the default size and is echoed', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'Paged' });
  const error = await failure(
    t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, { headers: { prefer: 'odata.maxpagesize=abc' } }),
  );
  assert.equal(error.status, 405);
  assert.equal(error.details.innerCode, '0x80060888');
  const response = dataverseError(error);
  assert.equal(response.status, 405);
  assert.deepEqual(response.body.error, {
    code: '0x80060888',
    message: 'Prefer Odata.maxpagesize value should be 32 bit integer.',
  });
  const huge = await failure(
    t.send('GET', `/api/data/${VERSION}/widgets`, { headers: { prefer: 'odata.maxpagesize=2147483648' } }),
  );
  assert.equal(huge.status, 405);
  const zero = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, {
    headers: { prefer: 'odata.maxpagesize=0' },
  });
  assert.equal(zero.status, 200);
  assert.equal(zero.headers['Preference-Applied'], 'odata.maxpagesize=0');
});

test("an unknown property's $value answers the $value URI error, not the property error", async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Raw' });
  const error = await failure(t.send('GET', `/api/data/${VERSION}/widgets(${id})/nosuch/$value`));
  assert.equal(error.status, 400);
  assert.equal(error.details.innerCode, '0x80060888');
  assert.equal(error.message, "The URI segment '$value' is invalid after the segment 'nosuch'.");
  const raw = await t.send('GET', `/api/data/${VERSION}/widgets(${id})/name/$value`);
  assert.deepEqual(raw, { status: 200, body: 'Raw' });
});

test('$count with a $filter that names a property answers 0x80060888 on Edm.Int32', async () => {
  const t = await setup();
  await create(t, 'widgets', { name: 'Counted' });
  const error = await failure(t.send('GET', `/api/data/${VERSION}/widgets/$count?$filter=name eq 'Counted'`));
  assert.equal(error.status, 400);
  assert.equal(error.details.innerCode, '0x80060888');
  assert.equal(error.message, "Could not find a property named 'name' on type 'Edm.Int32'.");
  const all = await t.send('GET', `/api/data/${VERSION}/widgets/$count`);
  assert.equal(all.body, '1');
});

test('a write representation answers every declared column with unset ones null, and a $select keeps only what it names', async () => {
  const t = await setup();
  const full = await t.send('POST', `/api/data/${VERSION}/widgets`, {
    body: { name: 'Full' },
    headers: { prefer: 'return=representation' },
  });
  assert.equal(full.status, 201);
  assert.equal(full.body.name, 'Full');
  assert.equal(full.body.code, null, 'an unset declared column is answered as null');
  assert.equal(full.body.price, null);
  assert.equal(full.headers.ETag, undefined, "a create's 201 carries no ETag header");
  assert.equal(full.headers['Preference-Applied'], 'return=representation');
  const narrow = await t.send('POST', `/api/data/${VERSION}/widgets?$select=name`, {
    body: { name: 'Narrow' },
    headers: { prefer: 'return=representation' },
  });
  const keys = Object.keys(narrow.body)
    .filter((key) => !key.startsWith('@'))
    .sort();
  assert.deepEqual(keys, ['name', 'widgetid']);
});

test('PATCH answers its headers by shape, and a representation drops the null columns', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Patch' });
  const plain = await t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, { body: { name: 'Plain' } });
  assert.equal(plain.status, 204);
  assert.ok(plain.headers.Location.endsWith(`/widgets(${id})`));
  assert.equal(plain.headers['OData-EntityId'], plain.headers.Location);
  const shown = await t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, {
    body: { name: 'Shown', price: 3 },
    headers: { prefer: 'return=representation' },
  });
  assert.equal(shown.status, 200);
  assert.equal(shown.headers['OData-EntityId'], undefined, 'a 200 representation names no OData-EntityId');
  assert.match(shown.headers.ETag, /^W\/"/);
  assert.equal(shown.headers['Preference-Applied'], 'return=representation');
  assert.ok(!('code' in shown.body), "an unset column is omitted from an update's representation");
  assert.ok(!('code@OData.Community.Display.V1.FormattedValue' in shown.body));
  assert.equal(shown.body.name, 'Shown');
  assert.ok('price_base' in shown.body, 'a set money column returns its base amount');
});

test('a key read that selects a money column answers the base currency lookup once the row has held money, even when the money is now null', async () => {
  const t = await setup();
  const base = t.store.state.tables.transactioncurrency[0].transactioncurrencyid;
  // Native: a row never given money has no currency lookup, selected or not.
  const blank = await create(t, 'widgets', { name: 'Blank' });
  const never = await t.send('GET', `/api/data/${VERSION}/widgets(${blank})?$select=name,price`, {
    headers: annotate('*'),
  });
  assert.ok(!(CURRENCY in never.body), 'a row never given money carries no lookup');
  const held = await create(t, 'widgets', { name: 'Held', price: 3 });
  await t.send('PATCH', `/api/data/${VERSION}/widgets(${held})`, { body: { price: null } });
  const single = await t.send('GET', `/api/data/${VERSION}/widgets(${held})?$select=name,price`, {
    headers: annotate('*'),
  });
  assert.equal(single.body[CURRENCY], base);
  const list = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name,price`, { headers: annotate('*') });
  assert.ok(
    list.body.value.every((row) => !(CURRENCY in row)),
    'a collection with the same $select omits the lookup',
  );
});

test('a negative money value reads in parentheses with the currency symbol inside them', async () => {
  const t = await setup();
  // Native: (₴1,000.0000) with a minus-sign money read as parentheses.
  const id = await create(t, 'widgets', { name: 'Owed', price: -3 });
  const res = await t.send('GET', `/api/data/${VERSION}/widgets(${id})?$select=price`, { headers: annotate('*') });
  assert.equal(res.body['price@OData.Community.Display.V1.FormattedValue'], '($3.00)');
  assert.match(stringifyExactJson(res.body), /"price":-3\.0000[,}]/);
});

test('owner lookups carry the annotations native gives each owner column', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Owned' }, t.basic);
  const res = await t.send('GET', `/api/data/${VERSION}/widgets(${id})`, { headers: annotate('*') });
  const nav = '@Microsoft.Dynamics.CRM.associatednavigationproperty';
  const formatted = '@OData.Community.Display.V1.FormattedValue';
  assert.equal(res.body[`_owninguser_value${nav}`], undefined, 'the user-owner lookup has no navigation name');
  assert.equal(res.body[`_owninguser_value${formatted}`], undefined, 'the user-owner lookup has no formatted value');
  assert.equal(res.body[`_owninguser_value@Microsoft.Dynamics.CRM.lookuplogicalname`], 'systemuser');
  assert.equal(res.body[`_owningbusinessunit_value${nav}`], 'owningbusinessunit');
  assert.equal(res.body[`_ownerid_value${nav}`], 'ownerid');
});

test('an organization-owned row always answers the organization lookup, selected or not', async () => {
  const t = await setup();
  const id = await create(t, 'tags', { name: 'Shared' });
  const single = await t.send('GET', `/api/data/${VERSION}/tags(${id})?$select=name`);
  assert.equal(single.body._organizationid_value, ORG);
  const list = await t.send('GET', `/api/data/${VERSION}/tags?$select=name`);
  assert.equal(list.body.value[0]._organizationid_value, ORG);
});

test('an explicit navigation collection projection omits the unselected organization lookup', async () => {
  const t = await setup();
  const parent = await create(t, 'widgets', { name: 'Parent' });
  const child = await create(t, 'tags', { name: 'Related' });
  await t.send('POST', `/api/data/${VERSION}/widgets(${parent})/widget_tags/$ref`, {
    body: { '@odata.id': `${ORIGIN}/api/data/${VERSION}/tags(${child})` },
  });
  const result = await t.send('GET', `/api/data/${VERSION}/widgets(${parent})/widget_tags?$select=name`);
  assert.equal(result.body.value[0].name, 'Related');
  assert.equal(Object.hasOwn(result.body.value[0], '_organizationid_value'), false);
});

test('generated time-zone version values receive formatted annotations only when requested', async () => {
  const t = await setup();
  t.store.state.mappings.widget.fields.occurredon = { dataverseType: 'datetime' };
  const id = await create(t, 'widgets', { name: 'Dated', occurredon: '2026-10-20T10:30:00Z' });
  const key = 'timezoneruleversionnumber@OData.Community.Display.V1.FormattedValue';
  const formatted = await t.send('GET', `/api/data/${VERSION}/widgets(${id})`, { headers: annotate('*') });
  assert.equal(formatted.body.timezoneruleversionnumber, 4);
  assert.equal(formatted.body[key], '4');
  const plain = await t.send('GET', `/api/data/${VERSION}/widgets(${id})`);
  assert.equal(Object.hasOwn(plain.body, key), false);
});

test('DateOnly values imply the time-zone rule stamp without a UserLocal value', async () => {
  const t = await setup();
  t.store.state.mappings.widget.fields.occurredon = { dataverseType: 'datetime', dateTimeBehavior: 'UserLocal' };
  t.store.state.mappings.widget.fields.duedate = { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly' };
  const key = 'timezoneruleversionnumber@OData.Community.Display.V1.FormattedValue';
  const onlyDate = await create(t, 'widgets', { name: 'Date only', duedate: '2026-10-20' });
  const read = await t.send('GET', `/api/data/${VERSION}/widgets(${onlyDate})`, { headers: annotate('*') });
  assert.equal(read.body.timezoneruleversionnumber, 4);
  assert.equal(read.body[key], '4');
  assert.equal(read.body.occurredon, null);
  const both = await create(t, 'widgets', {
    name: 'Both dates',
    duedate: '2026-10-20',
    occurredon: '2026-10-20T10:30:00Z',
  });
  const clearLocal = await t.send('PATCH', `/api/data/${VERSION}/widgets(${both})`, {
    body: { occurredon: null },
    headers: { prefer: 'return=representation,odata.include-annotations="*"' },
  });
  assert.equal(clearLocal.body.timezoneruleversionnumber, 4);
  assert.equal(clearLocal.body[key], '4');
  assert.equal(clearLocal.body.duedate, '2026-10-20');
  const plain = await t.send('GET', `/api/data/${VERSION}/widgets(${onlyDate})`);
  assert.equal(Object.hasOwn(plain.body, key), false);
});

test('organization date writes persist their rule version across clearing every date and later unrelated patches', async (t) => {
  const runtime = await setup();
  t.after(() => runtime.handlers.close());
  Object.assign(runtime.store.state.mappings.widget.fields, {
    timezoneruleversionnumber: { dataverseType: 'int' },
    independenton: { dataverseType: 'datetime', dateTimeBehavior: 'TimeZoneIndependent' },
    localon: { dataverseType: 'datetime', dateTimeBehavior: 'UserLocal' },
    dateonly: { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly' },
  });
  const annotation = 'timezoneruleversionnumber@OData.Community.Display.V1.FormattedValue';
  const headers = { prefer: 'return=representation,odata.include-annotations="*"' };
  const stored = (id) => runtime.store.tableRows('widget').find((row) => row.widgetid === id);
  for (const [column, value] of Object.entries({
    independenton: '2026-10-20T10:30:00',
    localon: '2026-10-20T10:30:00Z',
    dateonly: '2026-10-20',
  })) {
    const id = await create(runtime, 'widgets', { name: column, [column]: value });
    assert.equal(stored(id).timezoneruleversionnumber, 4, column);
    for (const body of [{ [column]: null }, { name: 'Unrelated later change' }]) {
      const patched = await runtime.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, { body, headers });
      assert.equal(patched.status, 200);
      assert.equal(patched.body.timezoneruleversionnumber, 4);
      assert.equal(patched.body[annotation], '4');
      assert.equal(stored(id)[column], null);
      assert.equal(stored(id).timezoneruleversionnumber, 4);
    }
    const beforeRead = runtime.store.snapshot();
    const read = await runtime.send('GET', `/api/data/${VERSION}/widgets(${id})?$select=timezoneruleversionnumber`, {
      headers: annotate('*'),
    });
    assert.equal(read.body.timezoneruleversionnumber, 4);
    assert.equal(read.body[annotation], '4');
    assert.deepEqual(runtime.store.snapshot(), beforeRead);
  }
  const textId = await create(runtime, 'widgets', { name: 'Only text' });
  assert.equal(stored(textId).timezoneruleversionnumber, undefined);
  await runtime.send('PATCH', `/api/data/${VERSION}/widgets(${textId})`, { body: { name: 'Still only text' } });
  assert.equal(stored(textId).timezoneruleversionnumber, undefined);
  await runtime.send('PATCH', `/api/data/${VERSION}/widgets(${textId})`, {
    body: { independenton: '2026-10-20T10:30:00' },
  });
  assert.equal(stored(textId).timezoneruleversionnumber, 4);
  await runtime.send('PATCH', `/api/data/${VERSION}/widgets(${textId})`, { body: { independenton: null } });
  assert.equal(stored(textId).timezoneruleversionnumber, 4);
});

test('legacy date rows acquire history only on organization writes and portal storage does not stamp it', async (t) => {
  const runtime = await setup();
  t.after(() => runtime.handlers.close());
  runtime.store.state.mappings.widget.fields.localon = { dataverseType: 'datetime', dateTimeBehavior: 'UserLocal' };
  const legacyId = randomUUID(),
    unknownId = randomUUID();
  runtime.store.state.tables.widget.push(
    { widgetid: legacyId, name: 'Legacy populated date', localon: '2026-10-20T10:30:00Z' },
    { widgetid: unknownId, name: 'Legacy unknown history', localon: null },
  );
  const beforeRead = runtime.store.snapshot();
  assert.equal(
    (await runtime.send('GET', `/api/data/${VERSION}/widgets(${legacyId})`)).body.timezoneruleversionnumber,
    4,
  );
  assert.deepEqual(runtime.store.snapshot(), beforeRead);
  await runtime.send('PATCH', `/api/data/${VERSION}/widgets(${legacyId})`, { body: { name: 'Organization write' } });
  assert.equal(runtime.store.tableRows('widget').find((row) => row.widgetid === legacyId).timezoneruleversionnumber, 4);
  await runtime.send('PATCH', `/api/data/${VERSION}/widgets(${unknownId})`, {
    body: { name: 'History remains unknown' },
  });
  assert.equal(
    runtime.store.tableRows('widget').find((row) => row.widgetid === unknownId).timezoneruleversionnumber,
    undefined,
  );
  const portal = await runtime.store.create(
    'widget',
    { name: 'Portal date', localon: '2026-10-20T10:30:00Z' },
    { admin: true },
  );
  assert.equal(portal.timezoneruleversionnumber, undefined);
});

test('Preference-Applied echoes the annotations preference on a single read and on a write', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Echo' });
  const read = await t.send('GET', `/api/data/${VERSION}/widgets(${id})`, { headers: annotate('*') });
  assert.equal(read.headers['Preference-Applied'], 'odata.include-annotations="*"');
  const bare = await t.send('GET', `/api/data/${VERSION}/widgets(${id})`);
  assert.equal(bare.headers['Preference-Applied'], undefined);
  const written = await t.send('PATCH', `/api/data/${VERSION}/widgets(${id})`, {
    body: { name: 'Echo2' },
    headers: { prefer: 'return=representation,odata.include-annotations="*"' },
  });
  assert.match(written.headers['Preference-Applied'], /return=representation/);
  assert.match(written.headers['Preference-Applied'], /odata\.include-annotations="\*"/);
});

test("a keyed PUT answers 405 with the record's Allow methods", async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Verb' });
  const error = await failure(t.send('PUT', `/api/data/${VERSION}/widgets(${id})`, { body: { name: 'Put' } }));
  assert.equal(error.status, 405);
  assert.equal(error.details.allow, 'GET,PATCH,DELETE,OPTIONS,GET,HEAD,POST');
});

test('a picklist value with no option answers a null FormattedValue when annotations are requested', async () => {
  const t = await setup();
  const id = await create(t, 'widgets', { name: 'Unlisted' });
  t.store.state.tables.widget.find((item) => item.widgetid === id).statuscode = -1;
  const res = await t.send('GET', `/api/data/${VERSION}/widgets(${id})?$select=statuscode`, { headers: annotate('*') });
  assert.equal(res.body.statuscode, -1);
  assert.equal(res.body['statuscode@OData.Community.Display.V1.FormattedValue'], null);
  const plain = await t.send('GET', `/api/data/${VERSION}/widgets(${id})?$select=statuscode`);
  assert.ok(!Object.keys(plain.body).some((key) => key.includes('FormattedValue')));
});

test('a tracked first page without $orderby answers in row-version order, and the order is not echoed in the delta link', async () => {
  const t = await setup();
  const b = await create(t, 'widgets', { name: 'b' });
  await create(t, 'widgets', { name: 'a' });
  await create(t, 'widgets', { name: 'c' });
  await t.send('PATCH', `/api/data/${VERSION}/widgets(${b})`, { body: { name: 'b2' } });
  const full = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name`, {
    headers: { prefer: 'odata.track-changes' },
  });
  // Native: the initial tracked page is in creation and update order (the updated row last).
  assert.deepEqual(
    full.body.value.map((row) => row.name),
    ['a', 'c', 'b2'],
  );
  assert.ok(!full.body['@odata.deltaLink'].includes('orderby'), 'the internal sort stays out of the link');
});

test("a $orderby paging cookie carries the order column's first and last values before the id element", async () => {
  const t = await setup();
  for (const name of ['a', 'b', 'c']) await create(t, 'widgets', { name });
  const page = await t.send('GET', `/api/data/${VERSION}/widgets?$select=name&$orderby=name`, {
    headers: { prefer: 'odata.maxpagesize=2' },
  });
  assert.deepEqual(
    page.body.value.map((row) => row.name),
    ['a', 'b'],
  );
  const token = new URL(page.body['@odata.nextLink']).searchParams.get('$skiptoken');
  // The pagingcookie attribute is percent-encoded once inside the token: decoding it gives the cookie's XML.
  const inner = decodeURIComponent(/pagingcookie="([^"]*)"/.exec(token)[1]);
  assert.match(
    inner,
    /<name last="b" first="a" \/><widgetid last="\{[0-9A-F-]+\}" first="\{[0-9A-F-]+\}" \/><\/cookie>$/,
  );
  assert.match(page.body['@odata.nextLink'], /\$orderby=name&/);
  const next = await t.send('GET', page.body['@odata.nextLink'].replace(/^https?:\/\/[^/]+/, ''), {
    headers: { prefer: 'odata.maxpagesize=2' },
  });
  assert.deepEqual(
    next.body.value.map((row) => row.name),
    ['c'],
  );
});
