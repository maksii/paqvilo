// @test-kind unproven: local currency model (stamping, rate direction, half-away rounding, refusal codes and messages) without a native capture; tests with native proof carry their own tag
// Currency (lib/dataverse-currency.mjs): money columns stamped with the transaction currency, its rate and the base amounts on
// write; RetrieveExchangeRate (dataverse-predefined.mjs) answers 200 and 404.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION } from '../lib/dataverse-currency.mjs';
import { baseCurrencyId } from '../lib/dataverse-security.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const EURO = '66666666-6666-4666-8666-666666666611';
const BARE = '66666666-6666-4666-8666-666666666612';
const UNKNOWN = '66666666-6666-4666-8666-666666666699';
const BASE_LEDGER = '66666666-6666-4666-8666-666666666621';
const NONE_LEDGER = '66666666-6666-4666-8666-666666666622';
const ANNOTATE = { Prefer: 'odata.include-annotations="*"' };
const PRICE_FORMATTED = 'x_price@OData.Community.Display.V1.FormattedValue';
const CURRENCY_NAME = '_transactioncurrencyid_value@OData.Community.Display.V1.FormattedValue';
// The base, euro and no-currency rows of a ledger, read with a money $select that omits the currency lookup.
async function moneyRows(t) {
  const fixture = await setup(t);
  const base = fixture.store.state.tables.transactioncurrency[0].transactioncurrencyid;
  fixture.store.state.tables.x_ledger.push(
    { x_ledgerid: BASE_LEDGER, x_name: 'Base', x_price: 100, transactioncurrencyid: base, statecode: 0, statuscode: 1 },
    { x_ledgerid: NONE_LEDGER, x_name: 'None', x_price: 40, statecode: 0, statuscode: 1 },
  );
  return fixture;
}
const HELD = '66666666-6666-4666-8666-666666666601';
const HELD_LOST = '66666666-6666-4666-8666-666666666602';
// The Web API names a lookup through its bind; a plain transactioncurrencyid key is refused before the write.
const currencyBind = (id) => ({ 'transactioncurrencyid@odata.bind': `/transactioncurrencies(${id})` });

const mappings = {
  x_ledger: {
    logicalName: 'x_ledger',
    entitySet: 'x_ledgers',
    idColumn: 'x_ledgerid',
    nameColumn: 'x_name',
    // A money table's currency lookup, as its metadata declares it.
    relationships: {
      transactioncurrencyid: {
        entity: 'transactioncurrency',
        from: 'transactioncurrencyid',
        to: 'transactioncurrencyid',
        many: false,
      },
    },
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      // AccuracySource 2 (the currency's precision), 0 (the column's own precision).
      x_price: { dataverseType: 'money', precision: 2, precisionSource: 2 },
      x_cost: { dataverseType: 'money', precision: 4, precisionSource: 2 },
      // AccuracySource 0 (the column's own precision) and 2 (the currency's precision).
      x_exact: { dataverseType: 'money', precision: 4, precisionSource: 0 },
      x_rounded: { dataverseType: 'money', precision: 4, precisionSource: 2 },
    },
  },
  x_note: {
    logicalName: 'x_note',
    entitySet: 'x_notes',
    idColumn: 'x_noteid',
    nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  },
};

async function setup(t) {
  const diagnostics = [];
  const fixture = await contractModuleFixture(t, {
    mappings,
    tables: {
      x_ledger: [
        {
          x_ledgerid: HELD,
          x_name: 'Held',
          x_price: 100,
          transactioncurrencyid: EURO,
          exchangerate: 1.3,
          x_price_base: 76.923,
          statecode: 0,
          statuscode: 1,
        },
        {
          x_ledgerid: HELD_LOST,
          x_name: 'Lost currency',
          x_price: 50,
          transactioncurrencyid: UNKNOWN,
          exchangerate: 1.3,
          x_price_base: 38.462,
          statecode: 0,
          statuscode: 1,
        },
      ],
      x_note: [],
    },
    extension: EXTENSION,
    options: { diagnostic: (entry) => diagnostics.push(entry) },
  });
  const { store } = fixture;
  // The base currency is seeded at startup and stays the first row (the fallback when the organization names none).
  // Other currencies follow it: euro (precision 3, rate 1.3) and a bare one (no precision, rate 3).
  store.state.tables.transactioncurrency.push(
    {
      transactioncurrencyid: EURO,
      currencyname: 'Invented euro',
      isocurrencycode: 'XEU',
      currencysymbol: 'E',
      currencyprecision: 3,
      exchangerate: 1.3,
    },
    {
      transactioncurrencyid: BARE,
      currencyname: 'Invented bare',
      isocurrencycode: 'XBA',
      currencysymbol: 'B',
      currencyprecision: null,
      exchangerate: 3,
    },
  );
  const organization = store.state.tables.organization[0];
  assert.equal(
    store.state.tables.transactioncurrency[0].transactioncurrencyid,
    baseCurrencyId(organization.organizationid),
  );
  const ledger = (name) => store.state.tables.x_ledger.find((row) => row.x_name === name) ?? null;
  return { ...fixture, diagnostics, ledger };
}

// One organization for the cases that only add rows under their own names, read, or are refused and roll back: a
// fixture starts a whole Dataverse API, so they share it. The case that empties the currency table calls setup(t) for
// its own. Cases run in file order (node:test runs a file's tests one at a time).
const cleanups = [];
let shared = null;
const sharedSetup = () => (shared ??= setup({ after: (fn) => cleanups.push(fn) }));
after(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

test('create without a currency stamps the base currency: rate 1 and each money _base at the base precision', async () => {
  const { request, json, store } = await sharedSetup();
  const created = await json(
    await request('POST', '/x_ledgers', { x_name: 'Base', x_price: 100.456, x_cost: 10.5 }),
    201,
  );
  assert.equal(created.x_price_base, 100.46);
  assert.equal(created.x_cost_base, 10.5);
  const row = store.state.tables.x_ledger.find((item) => item.x_name === 'Base');
  assert.equal(row.exchangerate, 1);
  assert.equal(row.transactioncurrencyid, store.state.tables.transactioncurrency[0].transactioncurrencyid);
});

test('money-free creates retain an unset currency until a zero money value is written', async () => {
  const { request, json, ledger, store } = await sharedSetup();
  for (const [name, values] of [
    ['Omitted', {}],
    ['Explicit null', { x_price: null, x_cost: null }],
  ]) {
    const created = await json(await request('POST', '/x_ledgers', { x_name: name, ...values }), 201);
    const row = ledger(name);
    assert.equal(row.transactioncurrencyid, undefined);
    assert.equal(row.exchangerate, undefined);
    assert.equal(created._transactioncurrencyid_value, null);
    const retrieved = await json(await request('GET', `/x_ledgers(${row.x_ledgerid})`), 200);
    assert.equal(retrieved._transactioncurrencyid_value, null);
    await json(await request('PATCH', `/x_ledgers(${row.x_ledgerid})`, { x_price: 0 }), 200);
    assert.equal(ledger(name).transactioncurrencyid, store.state.tables.transactioncurrency[0].transactioncurrencyid);
    assert.equal(ledger(name).exchangerate, 1);
    assert.equal(ledger(name).x_price_base, 0);
    await json(await request('PATCH', `/x_ledgers(${row.x_ledgerid})`, { x_price: null }), 200);
    assert.equal(ledger(name).transactioncurrencyid, store.state.tables.transactioncurrency[0].transactioncurrencyid);
    assert.equal(ledger(name).x_price_base, null);
    const cleared = await json(await request('GET', `/x_ledgers(${row.x_ledgerid})`), 200);
    assert.equal(cleared.x_price_base, null);
  }
});

test('an explicit currency alone still supplies its rate without inventing money amounts', async () => {
  const { request, json, ledger } = await sharedSetup();
  await json(await request('POST', '/x_ledgers', { x_name: 'Currency only', ...currencyBind(EURO) }), 201);
  assert.equal(ledger('Currency only').transactioncurrencyid, EURO);
  assert.equal(ledger('Currency only').exchangerate, 1.3);
  assert.equal(ledger('Currency only').x_price_base, undefined);
});

test('invalid money payloads retain the shared OData validation code and roll back derived stamps', async () => {
  const { request, json, store } = await sharedSetup();
  const before = structuredClone(store.state.tables.x_ledger);
  for (const value of ['NaN', {}]) {
    const error = await json(await request('POST', '/x_ledgers', { x_name: 'Invalid money', x_price: value }), 400);
    assert.equal(error.error.code, '0x80048d19');
    assert.deepEqual(store.state.tables.x_ledger, before);
    const updated = await json(await request('PATCH', `/x_ledgers(${HELD})`, { x_price: value }), 400);
    assert.equal(updated.error.code, '0x80048d19');
    assert.deepEqual(store.state.tables.x_ledger, before);
  }
});

// @test-kind parity: native and native-r2 currency (pqwp_money 7.125 stores pqwp_money_base 7.125, column AccuracySource 0 Accuracy 4) and MoneyAttributeMetadata.PrecisionSource (Microsoft.Xrm.Sdk)
test('the base amount takes the digits of its column PrecisionSource: 0 the column precision, 2 the currency precision', async () => {
  const { request, json, ledger } = await sharedSetup();
  await json(await request('POST', '/x_ledgers', { x_name: 'Source', x_exact: 7.125, x_rounded: 7.125 }), 201);
  assert.equal(ledger('Source').exchangerate, 1);
  assert.equal(ledger('Source').x_exact_base, 7.125);
  assert.equal(ledger('Source').x_rounded_base, 7.13);
});

test("create with an explicit currency divides by its rate, rounded to the currency precision (not the column's)", async () => {
  const { request, json, ledger } = await sharedSetup();
  await json(
    await request('POST', '/x_ledgers', { x_name: 'Euro', x_price: 100, x_cost: 10, ...currencyBind(EURO) }),
    201,
  );
  assert.equal(ledger('Euro').transactioncurrencyid, EURO);
  assert.equal(ledger('Euro').exchangerate, 1.3);
  assert.equal(ledger('Euro').x_price_base, 76.923);
  assert.equal(ledger('Euro').x_cost_base, 7.692);
});

test('a currency without a precision rounds each money _base to its column precision', async () => {
  const { request, json, ledger } = await sharedSetup();
  await json(
    await request('POST', '/x_ledgers', { x_name: 'Bare', x_price: 10, x_cost: 10, ...currencyBind(BARE) }),
    201,
  );
  assert.equal(ledger('Bare').x_price_base, 3.33);
  assert.equal(ledger('Bare').x_cost_base, 3.3333);
});

test('a bind naming an unknown currency is refused with the lookup inner code and stores nothing', async () => {
  const { request, json, ledger } = await sharedSetup();
  // Native code not known: the Web API resolves the bind before the hook runs and answers 404, not the hook's 400.
  const body = await json(
    await request('POST', '/x_ledgers', { x_name: 'Lost', x_price: 1, ...currencyBind(UNKNOWN) }),
    404,
  );
  assert.equal(body.error.code, '0x80040217');
  assert.equal(ledger('Lost'), null);
});

test('an update of a row whose held currency no longer exists is refused with the lookup inner code and changes nothing', async () => {
  const { request, json, store } = await sharedSetup();
  const before = structuredClone(store.state.tables.x_ledger.find((row) => row.x_ledgerid === HELD_LOST));
  // Native code not known: the records layer resolves the stored lookup before the hook and answers 404, not the hook's 400.
  const body = await json(await request('PATCH', `/x_ledgers(${HELD_LOST})`, { x_price: 60 }), 404);
  assert.equal(body.error.code, '0x80040217');
  assert.deepEqual(
    store.state.tables.x_ledger.find((row) => row.x_ledgerid === HELD_LOST),
    before,
  );
});

test('an update that gives a money value keeps the currency the row holds and its rate', async () => {
  const { request, json, store } = await sharedSetup();
  await json(await request('PATCH', `/x_ledgers(${HELD})`, { x_price: 130 }), 200);
  const row = store.state.tables.x_ledger.find((item) => item.x_ledgerid === HELD);
  assert.equal(row.transactioncurrencyid, EURO);
  assert.equal(row.exchangerate, 1.3);
  assert.equal(row.x_price_base, 100);
});

test('a table without money columns is untouched: no currency, rate or diagnostic is stamped', async () => {
  const { request, json, store, diagnostics } = await sharedSetup();
  await json(await request('POST', '/x_notes', { x_name: 'Plain' }), 201);
  const row = store.state.tables.x_note.find((item) => item.x_name === 'Plain');
  assert.equal('transactioncurrencyid' in row, false);
  assert.equal('exchangerate' in row, false);
  assert.equal(
    diagnostics.some((entry) => entry.code === 'CURRENCY_BASE_MISSING'),
    false,
  );
});

test('a missing base currency emits CURRENCY_BASE_MISSING once and the write proceeds without stamping', async (t) => {
  const { request, json, store, diagnostics, ledger } = await setup(t);
  store.state.tables.transactioncurrency.splice(0);
  await json(await request('POST', '/x_ledgers', { x_name: 'First', x_price: 5 }), 201);
  await json(await request('POST', '/x_ledgers', { x_name: 'Second', x_price: 6 }), 201);
  assert.equal(diagnostics.filter((entry) => entry.code === 'CURRENCY_BASE_MISSING').length, 1);
  assert.equal('x_price_base' in ledger('First'), false);
  assert.equal(ledger('Second').x_price, 6);
});

test('RetrieveExchangeRate answers the base and an invented currency, and 404 for an unknown id', async () => {
  const { request, json, store } = await sharedSetup();
  const base = store.state.tables.transactioncurrency[0].transactioncurrencyid;
  assert.equal(
    (await json(await request('GET', `/RetrieveExchangeRate(TransactionCurrencyId=${base})`), 200)).ExchangeRate,
    1,
  );
  assert.equal(
    (await json(await request('GET', `/RetrieveExchangeRate(TransactionCurrencyId=${EURO})`), 200)).ExchangeRate,
    1.3,
  );
  const missing = await json(await request('GET', `/RetrieveExchangeRate(TransactionCurrencyId=${UNKNOWN})`), 404);
  assert.equal(missing.error.code, '0x80040217');
});

// @test-kind contract: the extension's capability record (Paqvilo design)
test('describe names the stamping and the reused exchange-rate function at behaviour level', () => {
  const record = EXTENSION.describe();
  assert.equal(record.level, 'behaviour');
  assert.deepEqual(record.requires, ['table:transactioncurrency']);
  assert.ok(record.operations.includes('CurrencyStamp'));
  assert.ok(record.operations.includes('RetrieveExchangeRate'));
});

// @test-kind compatibility: a money value is stated in its row's transaction currency, with that currency's symbol and precision (Microsoft Learn, Dataverse Web API money columns)
test('a money read without the currency lookup states each row in its own currency (single read)', async (t) => {
  const { request, json } = await moneyRows(t);
  const euro = await json(await request('GET', `/x_ledgers(${HELD})?$select=x_name,x_price`, undefined, ANNOTATE), 200);
  assert.equal(euro._transactioncurrencyid_value, EURO);
  assert.equal(euro[CURRENCY_NAME], 'Invented euro');
  assert.equal(euro[PRICE_FORMATTED], 'E100.000');
  const base = await json(
    await request('GET', `/x_ledgers(${BASE_LEDGER})?$select=x_name,x_price`, undefined, ANNOTATE),
    200,
  );
  assert.equal(base[PRICE_FORMATTED], '$100.00', 'a base-currency row keeps the base symbol and precision');
  const none = await json(
    await request('GET', `/x_ledgers(${NONE_LEDGER})?$select=x_name,x_price`, undefined, ANNOTATE),
    200,
  );
  assert.equal(none[PRICE_FORMATTED], '$40.00', 'a row with no currency states its money in the base currency');
});

// @test-kind compatibility: a money value is stated in its row's transaction currency, with that currency's symbol and precision (Microsoft Learn, Dataverse Web API money columns)
test('a money collection read without the currency lookup states each row in its own currency', async (t) => {
  const { request, json } = await moneyRows(t);
  const list = await json(await request('GET', '/x_ledgers?$select=x_name,x_price', undefined, ANNOTATE), 200);
  const byName = Object.fromEntries(list.value.map((row) => [row.x_name, row]));
  assert.equal(byName.Held[PRICE_FORMATTED], 'E100.000');
  assert.equal(byName.Base[PRICE_FORMATTED], '$100.00', 'a base-currency row keeps the base symbol and precision');
  assert.equal(byName.None[PRICE_FORMATTED], '$40.00', 'a row with no currency states its money in the base currency');
});

// @test-kind compatibility: a row's exchangerate is its currency's exchange rate, and each money _base value is the amount divided by that rate, in the base currency (Microsoft Learn, transaction currency behaviour)
test('a euro row reads its stored exchange rate and base amount in the base currency, with no $select', async (t) => {
  const { request, json, ledger } = await moneyRows(t);
  await json(await request('POST', '/x_ledgers', { x_name: 'Euro 130', x_price: 130, ...currencyBind(EURO) }), 201);
  const id = ledger('Euro 130').x_ledgerid;
  const read = await json(await request('GET', `/x_ledgers(${id})`, undefined, ANNOTATE), 200);
  assert.equal(read.exchangerate, 1.3);
  assert.equal(read.x_price_base, 100);
  assert.equal(read['x_price_base@OData.Community.Display.V1.FormattedValue'], '$100.00');
  const selected = await json(await request('GET', `/x_ledgers(${id})?$select=x_price_base`), 200);
  assert.equal(selected.x_price_base, 100);
  const base = await json(await request('GET', `/x_ledgers(${BASE_LEDGER})`), 200);
  assert.equal(base.exchangerate, 1);
  assert.equal(base.x_price_base, 100);
});

// @test-kind compatibility: the exchange rate is captured when a row's money or currency is written, not restated when the currency's rate changes (Microsoft Learn, transaction currency behaviour)
test('a later change of a currency rate leaves a stored row unchanged until its money or currency is written', async (t) => {
  const { request, json, store, ledger } = await setup(t);
  await json(await request('POST', '/x_ledgers', { x_name: 'Captured', x_price: 130, ...currencyBind(EURO) }), 201);
  const id = ledger('Captured').x_ledgerid;
  store.state.tables.transactioncurrency.find((row) => row.transactioncurrencyid === EURO).exchangerate = 2;
  const read = await json(await request('GET', `/x_ledgers(${id})`), 200);
  assert.equal(read.exchangerate, 1.3);
  assert.equal(read.x_price_base, 100);
  await json(await request('PATCH', `/x_ledgers(${id})`, { x_name: 'Renamed' }), 200);
  assert.equal(ledger('Renamed').exchangerate, 1.3);
  assert.equal(ledger('Renamed').x_price_base, 100);
  await json(await request('PATCH', `/x_ledgers(${id})`, { x_price: 130 }), 200);
  assert.equal(ledger('Renamed').exchangerate, 2);
  assert.equal(ledger('Renamed').x_price_base, 65);
});
