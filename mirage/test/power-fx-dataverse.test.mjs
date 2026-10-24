// The core Power Fx engine end to end through the Web API: formula columns (read, $filter, lookup navigation, error values),
// a Dataverse Function (custom API with fxexpressionid) reading and writing tables as the caller inside its transaction,
// automated low-code plug-ins (Set on ThisRecord, Error refusing the write), delegation push-down against the in-memory
// read with the delegation warning.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { exactNumeric } from '../lib/exact-numeric.mjs';

const ADMIN = '77777777-7777-4777-8777-777777777777';
const LIMITED = '77777777-7777-4777-8777-777777777778';
const BASIC = '77777777-7777-4777-8777-777777777779';
const PARENT = '77777777-7777-4777-8777-777777777701';
const ITEM = '77777777-7777-4777-8777-777777777702';
const ITEM2 = '77777777-7777-4777-8777-777777777703';
const id = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const formula = (text, dataverseType = 'decimal', extra = {}) => ({
  dataverseType,
  ...extra,
  columnMetadata: { sourceType: 3, formulaDefinition: text },
});

const EXPRESSIONS = {
  x_Add: '{ Z: X + Y }',
  x_Log: 'Collect(x_logs, { x_name: Name }); { Count: CountRows(x_logs) }',
  x_Fail:
    'Collect(x_logs, { x_name: "invented" }); Error({ Kind: ErrorKind.Validation, Message: "Invented validation failed" })',
  x_Notes: '{ Count: CountRows(x_notes), Found: LookUp(x_note, x_name = "b").x_name }',
  x_Money: '{ Total: Sum(x_items, x_price), Exact: Sum(x_items, x_price) = 0.3 }',
  x_Big:
    '{ Delegated: CountRows(Filter(x_bulks, x_number >= 590)), Local: CountRows(Filter(x_bulks, Mod(x_number, 1) = 0 && x_number >= 590)), Found: LookUp(x_bulks, x_name = "bulk 599").x_number, Top: First(Sort(x_bulks, x_number, SortOrder.Descending)).x_number }',
  x_Upper: 'Set(ThisRecord.x_name, Upper(ThisRecord.x_name)); Set(x_amount, 7)',
  x_Plant: 'Set(ThisRecord.x_secret, "planted")',
  x_Each: 'ForAll(Sequence(2), Collect(x_logs, { x_name: "each" })); { Out: "after" }',
  x_Deleg:
    '{ Now: CountRows(Filter(x_bulks, x_when < Now())), Upper: CountRows(Filter(x_bulks, Upper(x_name) = "BULK 599")), Left: CountRows(Filter(x_bulks, Left(x_name, 6) = "bulk 5")), Mid: CountRows(Filter(x_bulks, Mid(x_name, 6, 3) = "599")), Price: CountRows(Filter(x_bulks, x_price > 0)), Right: CountRows(Filter(x_bulks, Right(x_name, 3) = "599")), Substitute: CountRows(Filter(x_bulks, Substitute(x_name, "bulk ", "#") = "#598")) }',
  x_Guard: 'If(ThisRecord.x_quantity < 0, Error("Quantity must not be negative"))',
};

async function organization(t) {
  const secrets = [ADMIN, LIMITED, BASIC].map((_app) => {
    const variable = `PAQVILO_PX1_${process.pid}_${Math.random().toString(36).slice(2).toUpperCase()}`;
    process.env[variable] = 'invented';
    t.after(() => {
      delete process.env[variable];
    });
    return variable;
  });
  const state = emptyState();
  state.mappings.x_parent = {
    logicalName: 'x_parent',
    entitySet: 'x_parents',
    idColumn: 'x_parentid',
    nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' }, x_rate: { dataverseType: 'decimal' } },
  };
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_amount: { dataverseType: 'decimal' },
      x_quantity: { dataverseType: 'int' },
      x_price: { dataverseType: 'money' },
      x_fee: { dataverseType: 'decimal' },
      x_big: { dataverseType: 'bigint' },
      x_precise: { dataverseType: 'decimal' },
      x_sum: formula('x_price + x_fee', 'decimal', { precision: 10 }),
      x_bigger: formula('x_big + 1', 'bigint'),
      x_double: formula('x_precise * 2', 'decimal', { precision: 10 }),
      x_due: { dataverseType: 'datetime' },
      x_parentid: { dataverseType: 'lookup', targets: ['x_parent'] },
      x_total: formula('x_amount * x_quantity'),
      x_label: formula('x_name & " / " & Text(x_quantity, "0")', 'nvarchar'),
      x_rated: formula('x_parentid.x_rate * x_amount + x_total'),
      x_next: formula('Text(DateAdd(x_due, 1, TimeUnit.Months), "yyyy-mm-dd")', 'nvarchar'),
      x_broken: formula('x_amount / (x_quantity - x_quantity)'),
    },
    relationships: { x_parent: { many: false, from: 'x_parentid', to: 'x_parentid', entity: 'x_parent' } },
  };
  state.mappings.x_log = {
    logicalName: 'x_log',
    entitySet: 'x_logs',
    idColumn: 'x_logid',
    nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.mappings.x_bulk = {
    logicalName: 'x_bulk',
    entitySet: 'x_bulks',
    idColumn: 'x_bulkid',
    nameColumn: 'x_name',
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_number: { dataverseType: 'int' },
      x_when: { dataverseType: 'datetime' },
      x_price: { dataverseType: 'money' },
    },
  };
  // A secured column, a formula column over it and an automated plug-in that sets it (column security).
  state.mappings.x_memo = {
    logicalName: 'x_memo',
    entitySet: 'x_memos',
    idColumn: 'x_memoid',
    nameColumn: 'x_name',
    ownership: 'UserOwned',
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_secret: { dataverseType: 'nvarchar', columnMetadata: { isSecured: true } },
    },
  };
  state.tables.x_memo = [];
  state.mappings.x_vault = {
    logicalName: 'x_vault',
    entitySet: 'x_vaults',
    idColumn: 'x_vaultid',
    nameColumn: 'x_name',
    ownership: 'OrganizationOwned',
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_secret: { dataverseType: 'nvarchar', columnMetadata: { isSecured: true } },
      x_shown: formula('x_secret & "!"', 'nvarchar'),
    },
  };
  state.tables.x_vault = [{ x_vaultid: id(960), x_name: 'vault', x_secret: 'hidden' }];
  state.tables.x_parent = [{ x_parentid: PARENT, x_name: 'Invented parent', x_rate: 3 }];
  state.tables.x_item = [
    {
      x_itemid: ITEM,
      x_name: 'Invented',
      x_amount: 4,
      x_quantity: 2,
      x_due: '2024-01-31T10:00:00Z',
      x_parentid: { id: PARENT, logical_name: 'x_parent' },
      x_price: 0.1,
      x_fee: 0.2,
      x_big: exactNumeric('9007199254740992', 'Int64'),
      x_precise: exactNumeric('1234567890.123456789012345678', 'Decimal'),
    },
    { x_itemid: ITEM2, x_name: 'Second', x_price: 0.2 },
  ];
  state.tables.x_log = [];
  // A mapping keyed by its logical name without a logicalName field (as some internal tables are declared).
  state.mappings.x_note = {
    entitySet: 'x_notes',
    idColumn: 'x_noteid',
    nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  };
  state.tables.x_note = [
    { x_noteid: id(950), x_name: 'a' },
    { x_noteid: id(951), x_name: 'b' },
  ];
  state.tables.x_bulk = Array.from({ length: 600 }, (_, n) => ({
    x_bulkid: id(1000 + n),
    x_name: `bulk ${n}`,
    x_number: n,
    x_when: '2020-01-01T00:00:00Z',
    x_price: 1,
  }));
  const names = Object.keys(EXPRESSIONS);
  state.tables.fxexpression = names.map((name, n) => ({
    fxexpressionid: id(100 + n),
    name,
    uniquename: name,
    expression: EXPRESSIONS[name],
    statecode: 0,
    ...(name === 'x_Upper'
      ? { messagename: 'Create', entitylogicalname: 'x_item' }
      : name === 'x_Plant'
        ? { messagename: 'Create', entitylogicalname: 'x_memo' }
        : name === 'x_Guard'
          ? { messagename: 'Update', entitylogicalname: 'x_item' }
          : {}),
  }));
  const functions = ['x_Add', 'x_Log', 'x_Fail', 'x_Big', 'x_Money', 'x_Notes', 'x_Each', 'x_Deleg'];
  state.tables.customapi = functions.map((name) => ({
    customapiid: id(200 + names.indexOf(name)),
    uniquename: name,
    name,
    bindingtype: 0,
    isfunction: false,
    fxexpressionid: { id: id(100 + names.indexOf(name)), logical_name: 'fxexpression' },
  }));
  const api = (name) => id(200 + names.indexOf(name));
  let p = 300;
  const param = (name, apiName, type) => ({
    customapirequestparameterid: id(p++),
    uniquename: name,
    name,
    type,
    isoptional: false,
    customapiid: api(apiName),
  });
  const prop = (name, apiName, type) => ({
    customapiresponsepropertyid: id(p++),
    uniquename: name,
    name,
    type,
    customapiid: api(apiName),
  });
  state.tables.customapirequestparameter = [param('X', 'x_Add', 6), param('Y', 'x_Add', 6), param('Name', 'x_Log', 10)];
  state.tables.customapiresponseproperty = [
    prop('Z', 'x_Add', 6),
    prop('Count', 'x_Log', 7),
    prop('Out', 'x_Fail', 10),
    prop('Delegated', 'x_Big', 7),
    prop('Local', 'x_Big', 7),
    prop('Found', 'x_Big', 7),
    prop('Top', 'x_Big', 7),
    prop('Total', 'x_Money', 8),
    prop('Exact', 'x_Money', 0),
    prop('Count', 'x_Notes', 7),
    prop('Found', 'x_Notes', 10),
    prop('Out', 'x_Each', 10),
    ...['Now', 'Upper', 'Left', 'Mid', 'Price', 'Right', 'Substitute'].map((name) => prop(name, 'x_Deleg', 7)),
  ];
  const store = await new DataStore({ state }).init();
  const diagnostics = [];
  const providers = { powerFx: createPowerFxEvaluator() };
  const runtime = await createOrganizationRuntime({
    store,
    providers,
    diagnostic: (entry) => diagnostics.push(entry),
    extensions: await sourceOrganizationExtensions({}),
    settings: dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: ADMIN,
          displayName: 'Invented admin',
          secretEnvironmentVariable: secrets[0],
          roles: ['System Administrator'],
        },
        { appId: LIMITED, displayName: 'Invented limited', secretEnvironmentVariable: secrets[1], roles: [] },
        { appId: BASIC, displayName: 'Invented basic', secretEnvironmentVariable: secrets[2], roles: ['Basic User'] },
      ],
    }),
  });
  const transport = await startDataverseApi({ organization: runtime });
  t.after(async () => {
    await transport.close();
    await runtime.close();
  });
  const tokenOf = async (app) =>
    (
      await (
        await fetch(transport.authority + '/oauth2/v2.0/token', {
          method: 'POST',
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: app,
            client_secret: 'invented',
            scope: transport.origin + '/.default',
          }),
        })
      ).json()
    ).access_token;
  const tokens = { admin: await tokenOf(ADMIN), limited: await tokenOf(LIMITED), basic: await tokenOf(BASIC) };
  const call = async (method, route, value, as = 'admin') => {
    const response = await fetch(transport.origin + '/api/data/v9.2/' + route, {
      method,
      headers: {
        authorization: `Bearer ${tokens[as]}`,
        prefer: 'return=representation',
        ...(value ? { 'content-type': 'application/json' } : {}),
      },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : null, text };
  };
  return { store, runtime, call, diagnostics };
}

test('formula columns compute through the core engine: arithmetic, text, lookup navigation, dates, $filter', async (t) => {
  const { call } = await organization(t);
  const row = (await call('GET', `x_items(${ITEM})`)).body;
  assert.equal(row.x_total, 8);
  assert.equal(row.x_label, 'Invented / 2');
  assert.equal(
    row.x_rated,
    20,
    'x_parentid.x_rate * x_amount + x_total: 3 * 4 + 8 through the related row and another formula column',
  );
  assert.equal(row.x_next, '2024-02-29', 'DateAdd by one month keeps the end of the month (Learn DateAdd)');
  const filtered = await call('GET', 'x_items?$select=x_name,x_total&$filter=x_total gt 5');
  assert.equal(filtered.status, 200, JSON.stringify(filtered.body));
  assert.deepEqual(
    filtered.body.value.map((item) => item.x_total),
    [8],
  );
  assert.equal((await call('GET', 'x_items?$select=x_name&$filter=x_total gt 8')).body.value.length, 0);
});

test('a formula that answers an error value reads null with one FORMULA_ERROR naming the kind', async (t) => {
  const { call, diagnostics } = await organization(t);
  await call('GET', `x_items(${ITEM})`);
  const row = (await call('GET', `x_items(${ITEM})`)).body;
  assert.equal(row.x_broken, null);
  const reported = diagnostics.filter((entry) => entry.code === 'FORMULA_ERROR' && entry.column === 'x_broken');
  assert.equal(reported.length, 1);
  assert.equal(reported[0].kind, 'Div0');
});

test('a Function evaluates its expression for real', async (t) => {
  const { call } = await organization(t);
  const answer = await call('POST', 'x_Add', { X: 2, Y: 3.5 });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.Z, 5.5);
});

test('a Function writes a table as the caller and reads it back (Collect, CountRows)', async (t) => {
  const { call, store } = await organization(t);
  const answer = await call('POST', 'x_Log', { Name: 'invented entry' });
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.Count, 1);
  assert.deepEqual(
    store.tableRows('x_log').map((row) => row.x_name),
    ['invented entry'],
  );
});

test('a Function without the caller privilege fails and writes nothing (never SYSTEM)', async (t) => {
  const { call, store } = await organization(t);
  const answer = await call('POST', 'x_Log', { Name: 'refused' }, 'limited');
  // The Collect is refused for the caller (an error value) and the read that follows answers the caller's privilege error.
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.equal(answer.body.error.code, '0x80040220');
  assert.match(answer.body.error.message, /prvReadX_log/);
  assert.equal(store.tableRows('x_log').length, 0);
});

test('an Error() in a Function answers the plug-in fault with its message and rolls its writes back', async (t) => {
  const { call, store } = await organization(t);
  const answer = await call('POST', 'x_Fail', {});
  assert.equal(answer.status, 400, JSON.stringify(answer.body));
  assert.equal(answer.body.error.code, '0x80040265');
  assert.equal(answer.body.error.message, 'Invented validation failed');
  assert.equal(store.tableRows('x_log').length, 0, 'the Collect before the error is rolled back with the function');
});

test('delegation: delegable predicates query the store past the data row limit; others read 500 rows with the warning', async (t) => {
  const { call, diagnostics } = await organization(t);
  const answer = await call('POST', 'x_Big', {});
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.Delegated, 10, 'Filter(x_bulks, x_number >= 590) is pushed down (rows 590..599)');
  assert.equal(
    answer.body.Local,
    0,
    'Mod() is not delegable: only the first 500 rows are read, so 590..599 are missed (Learn delegation overview)',
  );
  assert.equal(answer.body.Found, 599, 'LookUp with a text comparison is delegated');
  assert.equal(answer.body.Top, 599, 'Sort by a column is delegated before First');
  const warnings = diagnostics.filter((entry) => entry.code === 'POWERFX_DELEGATION');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].dataSource, 'x_bulks');
  assert.equal(warnings[0].rowLimit, 500);
  assert.equal(warnings[0].truncated, true);
});

test('an automated low-code plug-in changes the target with Set and refuses the write with Error()', async (t) => {
  const { call, store } = await organization(t);
  const created = await call('POST', 'x_items', { x_name: 'invented', x_quantity: 1 });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.x_name, 'INVENTED');
  assert.equal(created.body.x_amount, 7, 'Set(column) reaches a column the payload does not name');
  const refused = await call('PATCH', `x_items(${ITEM})`, { x_quantity: -1 });
  assert.equal(refused.status, 400, JSON.stringify(refused.body));
  assert.equal(refused.body.error.message, 'Quantity must not be negative');
  assert.equal(
    store.tableRows('x_item').find((row) => row.x_itemid === ITEM).x_quantity,
    2,
    'the refused update stored nothing',
  );
  assert.equal((await call('PATCH', `x_items(${ITEM})`, { x_quantity: 3 })).status, 200);
});

test('a synchronous SDK create runs the automated plug-in inline through the core engine', async (t) => {
  const { store } = await organization(t);
  const sdk = localOrganizationService(store, {
    userId: id(900),
    evidence: 'invented test grant',
    grants: [{ entity: 'x_item', operations: ['read', 'create'] }],
  });
  const row = sdk.create('x_item', { x_name: 'sdk' });
  assert.equal(row.x_name, 'SDK');
});

test('decimal, currency and whole-number formula columns and sums are exact decimals, not doubles', async (t) => {
  const { call } = await organization(t);
  const { body: row, text } = await call('GET', `x_items(${ITEM})?$select=x_sum,x_bigger,x_double`);
  assert.equal(row.x_sum, 0.3, '0.1 (money) + 0.2 (decimal) reads 0.3 exactly');
  assert.match(
    text,
    /"x_bigger":9007199254740993,/,
    '2^53 + 1 on a whole-number column round-trips (JSON text, beyond a double)',
  );
  assert.match(text, /"x_double":2469135780\.246913578,/, 'a 28-digit decimal keeps its digits at precision 10');
  assert.equal((await call('GET', 'x_items?$select=x_name&$filter=x_sum eq 0.3')).body.value.length, 1);
  const money = await call('POST', 'x_Money', {});
  assert.equal(money.status, 200, JSON.stringify(money.body));
  assert.equal(money.body.Total, 0.3, 'Sum over a currency column: 0.1 + 0.2');
  assert.equal(money.body.Exact, true);
});

test('a table whose mapping is keyed by logical name without a logicalName field resolves as a data source', async (t) => {
  const { call } = await organization(t);
  const answer = await call('POST', 'x_Notes', {});
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.Count, 2);
  assert.equal(answer.body.Found, 'b');
});

test('a refused write inside ForAll fails the Function with the privilege error and writes nothing', async (t) => {
  const { call, store } = await organization(t);
  const answer = await call('POST', 'x_Each', {}, 'limited');
  assert.equal(answer.status, 403, JSON.stringify(answer.body));
  assert.equal(answer.body.error.code, '0x80040220');
  assert.match(answer.body.error.message, /prvCreateX_log/);
  assert.equal(store.tableRows('x_log').length, 0);
});

test('delegation follows the Learn Dataverse table: text functions push down; Now() and currency read 500 rows with the warning', async (t) => {
  const { call, diagnostics } = await organization(t);
  const answer = await call('POST', 'x_Deleg', {});
  assert.equal(answer.status, 200, JSON.stringify(answer.body));
  assert.equal(answer.body.Upper, 1, 'Upper(column) = text is delegated (row 599 is past the row limit)');
  assert.equal(answer.body.Left, 111, 'Left(column, 6) = text is delegated');
  assert.equal(answer.body.Mid, 1, 'Mid(column, 6, 3) = text is delegated');
  assert.equal(answer.body.Right, 1, 'Right(column, 3) = text is delegated');
  assert.equal(answer.body.Substitute, 1, 'Substitute(column, old, new) = text is delegated');
  assert.equal(answer.body.Now, 500, 'a comparison with Now() is not delegated (note 3)');
  assert.equal(answer.body.Price, 500, 'a currency column is not delegated (note 1)');
  const warnings = diagnostics.filter((entry) => entry.code === 'POWERFX_DELEGATION');
  assert.equal(warnings.length, 2);
  assert.ok(warnings.every((entry) => entry.truncated === true));
});

test('column security: a formula column over a secured column is reported; a plug-in Set on a secured column passes the caller column security', async (t) => {
  const { call, store, diagnostics } = await organization(t);
  const reported = diagnostics.filter((entry) => entry.code === 'FORMULA_COLUMN_OVER_SECURED_COLUMN');
  assert.deepEqual(
    reported.map((entry) => [entry.table, entry.column, entry.columns]),
    [['x_vault', 'x_shown', ['x_vault.x_secret']]],
  );
  const refused = await call('POST', 'x_memos', { x_name: 'basic' }, 'basic');
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, '0x8004f502');
  assert.equal(store.tableRows('x_memo').length, 0);
  const allowed = await call('POST', 'x_memos', { x_name: 'admin' });
  assert.equal(allowed.status, 201, JSON.stringify(allowed.body));
  assert.equal(store.tableRows('x_memo')[0].x_secret, 'planted');
  const shown = await call('GET', `x_vaults(${id(960)})?$select=x_secret,x_shown`, null, 'basic');
  assert.equal(shown.status, 200, JSON.stringify(shown.body));
  assert.equal(shown.body.x_secret, null, 'the secured column itself is hidden');
  assert.equal(
    shown.body.x_shown,
    'hidden!',
    'the platform-computed formula column shows it, as natively (Learn column-level security best practices)',
  );
});
