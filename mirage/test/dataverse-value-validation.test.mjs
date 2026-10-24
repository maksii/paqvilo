// Dataverse Web API write-value rules (dataverseWebApi) against the portal's coercion, which keeps its
// lenient rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { ensureSecurityModel, createPrincipals } from '../lib/dataverse-security.mjs';
import { createRecordHandlers } from '../lib/dataverse-records.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const VERSION = 'v9.2';
const ORG = '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SETTINGS = {
  organizationId: ORG,
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [{ objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] }],
};
const ADMIN_IDENTITY = { admin: true };
const lookup = { dataverseType: 'lookup' };
const text = { dataverseType: 'nvarchar' };
const SET = 'contoso_widgets';

function fixtureState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: 'contoso_widget',
    entitySet: SET,
    idColumn: 'contoso_widgetid',
    nameColumn: 'contoso_name',
    fields: {
      contoso_name: text,
      contoso_notes: text,
      contoso_day: { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly', format: 'DateOnly' },
      contoso_priority: {
        dataverseType: 'picklist',
        options: [
          { value: 1, label: 'Low' },
          { value: 2, label: 'High' },
        ],
      },
      contoso_state: { dataverseType: 'state', options: [{ value: 0, label: 'Active' }] },
      contoso_tags: {
        dataverseType: 'multiselectpicklist',
        options: [
          { value: 10, label: 'Red' },
          { value: 20, label: 'Blue' },
        ],
      },
      contoso_amount: { dataverseType: 'float', minValue: -1000, maxValue: 1000 },
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
  state.tables.contoso_widget = [];
  return state;
}

async function setup() {
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const handlers = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals,
    metadataFields: () => undefined,
    changes: createChangeLog(store),
  });
  const admin = principals.byObjectId(ADMIN_OID);
  const send = async (method, path, body) => {
    const url = new URL(path, ORIGIN);
    return handlers.handle({
      method,
      route: parseDataverseRoute(url.pathname),
      url,
      origin: ORIGIN,
      version: VERSION,
      prefer: parsePrefer(undefined),
      headers: {},
      body,
      user: admin,
      caller: admin,
      identity: { admin: true, id: admin.systemuserid, systemUserId: admin.systemuserid },
      requestId: 'test',
    });
  };
  return { store, send };
}

// Creates one row and returns its id from OData-EntityId.
async function create(t, body) {
  const res = await t.send('POST', `/api/data/${VERSION}/${SET}`, body);
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

const rowPath = (id) => `/api/data/${VERSION}/${SET}(${id})`;

// The portal's coercion of the same write: no dataverseWebApi option.
function portalWrite(t, data) {
  return t.store.createRecord('contoso_widget', data, ADMIN_IDENTITY, { coerce: true });
}

function portalError(t, data) {
  try {
    portalWrite(t, data);
  } catch (error) {
    return error;
  }
  return null;
}

test('text: a NUL character is rejected on create and patch as an invalid character', async () => {
  const t = await setup();
  const bad = 'a\u0000b';
  const error = await failure(
    t.send('POST', `/api/data/${VERSION}/${SET}`, { contoso_name: 'NUL', contoso_notes: bad }),
  );
  assert.equal(error.status, 400);
  assert.equal(error.details.innerCode, '0x80040278');
  assert.equal(
    error.message,
    "Invalid character in field 'contoso_notes': '.', hexadecimal value 0x00, is an invalid character.",
  );
  const id = await create(t, { contoso_name: 'Plain', contoso_notes: 'ok' });
  const patch = await failure(t.send('PATCH', rowPath(id), { contoso_notes: bad }));
  assert.equal(patch.details.innerCode, '0x80040278');
  // The portal's text rule is unchanged.
  assert.equal(portalError(t, { contoso_name: 'NUL', contoso_notes: bad }), null);
});

test('DateOnly columns take Edm.Date text only: timestamps and impossible dates are a conversion error', async () => {
  const t = await setup();
  for (const value of ['2020-01-15T23:00:00-08:00', '2020-02-30', 'bad']) {
    const error = await failure(
      t.send('POST', `/api/data/${VERSION}/${SET}`, { contoso_name: 'Day', contoso_day: value }),
    );
    assert.equal(error.details.innerCode, '0x80048d19', value);
  }
  const id = await create(t, { contoso_name: 'Day', contoso_day: '2020-01-15' });
  const read = await t.send('GET', `${rowPath(id)}?$select=contoso_day`);
  assert.equal(read.body.contoso_day, '2020-01-15');
  const patch = await failure(t.send('PATCH', rowPath(id), { contoso_day: '2020-01-15T23:00:00-08:00' }));
  assert.equal(patch.details.innerCode, '0x80048d19');
  // The portal still reads a timestamp into a DateOnly column.
  assert.equal(portalError(t, { contoso_name: 'Day', contoso_day: '2020-01-15T23:00:00-08:00' }), null);
});

test('non-string DateOnly writes report Edm.Date for API create and patch while instant and portal diagnostics retain their types', async () => {
  const t = await setup();
  const expected = "Cannot convert the literal '0' to the expected type 'Edm.Date'.";
  const created = await failure(t.send('POST', `/api/data/${VERSION}/${SET}`, { contoso_name: 'Day', contoso_day: 0 }));
  assert.equal(created.status, 400);
  assert.equal(created.details.innerCode, '0x80048d19');
  assert.equal(created.message, expected);
  assert.equal(t.store.state.tables.contoso_widget.length, 0);
  const id = await create(t, { contoso_name: 'Day', contoso_day: '2020-01-15' });
  const patched = await failure(t.send('PATCH', rowPath(id), { contoso_day: 0 }));
  assert.equal(patched.message, expected);
  assert.equal((await t.send('GET', `${rowPath(id)}?$select=contoso_day`)).body.contoso_day, '2020-01-15');
  t.store.state.mappings.contoso_widget.fields.contoso_instant = {
    dataverseType: 'datetime',
    dateTimeBehavior: 'UserLocal',
  };
  const instant = await failure(t.send('PATCH', rowPath(id), { contoso_instant: 0 }));
  assert.equal(instant.message, "Cannot convert the literal '0' to the expected type 'Edm.DateTimeOffset'.");
  assert.equal(
    portalError(t, { contoso_name: 'Day', contoso_day: 0 }).message,
    "Cannot convert the literal '0' to the expected type 'Edm.DateTimeOffset'.",
  );
});

test('multiselect takes a comma-separated string of option values', async () => {
  const t = await setup();
  const empty = await failure(
    t.send('POST', `/api/data/${VERSION}/${SET}`, { contoso_name: 'Tags', contoso_tags: '' }),
  );
  assert.equal(empty.details.innerCode, '0x80060888');
  assert.equal(empty.message, 'Edm Object passed should have the options selected. ');
  const notInteger = await failure(
    t.send('POST', `/api/data/${VERSION}/${SET}`, { contoso_name: 'Tags', contoso_tags: '10,bad' }),
  );
  assert.equal(notInteger.details.innerCode, '0x80060888');
  assert.equal(notInteger.message, 'The optionset values sent bad are not valid integers.');
  const array = await failure(
    t.send('POST', `/api/data/${VERSION}/${SET}`, { contoso_name: 'Tags', contoso_tags: [10] }),
  );
  assert.equal(array.details.innerCode, '0x80048d19');
  const id = await create(t, { contoso_name: 'Tags', contoso_tags: '10,20' });
  assert.equal((await t.send('GET', `${rowPath(id)}?$select=contoso_tags`)).body.contoso_tags, '10,20');
  // A repeated option is stored once, in first-seen order (as native does).
  const repeated = await create(t, { contoso_name: 'Tags', contoso_tags: '20,10,20' });
  assert.equal((await t.send('GET', `${rowPath(repeated)}?$select=contoso_tags`)).body.contoso_tags, '20,10');
  const patch = await failure(t.send('PATCH', rowPath(id), { contoso_tags: '' }));
  assert.equal(patch.details.innerCode, '0x80060888');
  // The portal keeps its lenient multiselect rules: an empty string is no selection.
  assert.equal(portalError(t, { contoso_name: 'Tags', contoso_tags: '' }), null);
});

test('a plain picklist accepts -1 on create and patch; state and option validation still apply', async () => {
  const t = await setup();
  // Dataverse accepts -1 on a plain picklist and reads it back.
  const id = await create(t, { contoso_name: 'Choice', contoso_priority: -1 });
  assert.equal((await t.send('GET', `${rowPath(id)}?$select=contoso_priority`)).body.contoso_priority, -1);
  assert.equal((await t.send('PATCH', rowPath(id), { contoso_priority: -1 })).status, 204);
  const other = await failure(
    t.send('POST', `/api/data/${VERSION}/${SET}`, { contoso_name: 'Choice', contoso_priority: 3 }),
  );
  assert.equal(other.details.innerCode, '0x8004431a');
  const state = await failure(
    t.send('POST', `/api/data/${VERSION}/${SET}`, { contoso_name: 'State', contoso_state: -1 }),
  );
  assert.equal(state.status, 400);
  // The portal rejects -1 as an option value.
  assert.equal(portalError(t, { contoso_name: 'Choice', contoso_priority: -1 }).status, 400);
});

test('a float column rejects Infinity as outside its range, with the infinity sign in the message', async () => {
  const t = await setup();
  const error = await failure(
    t.send('POST', `/api/data/${VERSION}/${SET}`, { contoso_name: 'Amount', contoso_amount: 'Infinity' }),
  );
  assert.equal(error.details.innerCode, '0x80044330');
  assert.equal(
    error.message,
    'A validation error occurred for contoso_widget.contoso_amount. The value ∞ of type System.Double is outside the valid range(-1000 to 1000).',
  );
  const id = await create(t, { contoso_name: 'Amount', contoso_amount: 12.5 });
  const patch = await failure(t.send('PATCH', rowPath(id), { contoso_amount: '-Infinity' }));
  assert.equal(patch.details.innerCode, '0x80044330');
  assert.ok(patch.message.includes('The value -∞ of type System.Double'));
  // The portal reads Infinity text as a non-finite Edm.Double and rejects it as a conversion.
  assert.equal(portalError(t, { contoso_name: 'Amount', contoso_amount: 'Infinity' }).details.innerCode, '0x80048d19');
});
