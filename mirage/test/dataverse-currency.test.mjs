// Currency (lib/dataverse-currency.mjs): money columns stamped with the transaction currency, its rate and the base amounts on
// write; RetrieveExchangeRate (dataverse-predefined.mjs) answers 200 and 404.
import test from "node:test";
import assert from "node:assert/strict";
import { EXTENSION } from "../lib/dataverse-currency.mjs";
import { baseCurrencyId } from "../lib/dataverse-security.mjs";
import { contractModuleFixture } from "./contract-module-fixture.mjs";

const EURO = "66666666-6666-4666-8666-666666666611";
const BARE = "66666666-6666-4666-8666-666666666612";
const UNKNOWN = "66666666-6666-4666-8666-666666666699";
const HELD = "66666666-6666-4666-8666-666666666601";
const HELD_LOST = "66666666-6666-4666-8666-666666666602";
// The Web API names a lookup through its bind; a plain transactioncurrencyid key is refused before the write.
const currencyBind = (id) => ({ "transactioncurrencyid@odata.bind": `/transactioncurrencies(${id})` });

const mappings = {
  x_ledger: {
    logicalName: "x_ledger", entitySet: "x_ledgers", idColumn: "x_ledgerid", nameColumn: "x_name",
    // A money table's currency lookup, as its metadata declares it.
    relationships: { transactioncurrencyid: { entity: "transactioncurrency", from: "transactioncurrencyid", to: "transactioncurrencyid", many: false } },
    fields: {
      x_name: { dataverseType: "nvarchar" },
      x_price: { dataverseType: "money", precision: 2 },
      x_cost: { dataverseType: "money", precision: 4 },
    },
  },
  x_note: {
    logicalName: "x_note", entitySet: "x_notes", idColumn: "x_noteid", nameColumn: "x_name",
    fields: { x_name: { dataverseType: "nvarchar" } },
  },
};

async function setup(t) {
  const diagnostics = [];
  const fixture = await contractModuleFixture(t, {
    mappings,
    tables: {
      x_ledger: [
        { x_ledgerid: HELD, x_name: "Held", x_price: 100, transactioncurrencyid: EURO, exchangerate: 1.3, x_price_base: 76.923, statecode: 0, statuscode: 1 },
        { x_ledgerid: HELD_LOST, x_name: "Lost currency", x_price: 50, transactioncurrencyid: UNKNOWN, exchangerate: 1.3, x_price_base: 38.462, statecode: 0, statuscode: 1 },
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
    { transactioncurrencyid: EURO, currencyname: "Invented euro", isocurrencycode: "XEU", currencysymbol: "E", currencyprecision: 3, exchangerate: 1.3 },
    { transactioncurrencyid: BARE, currencyname: "Invented bare", isocurrencycode: "XBA", currencysymbol: "B", currencyprecision: null, exchangerate: 3 },
  );
  const organization = store.state.tables.organization[0];
  assert.equal(store.state.tables.transactioncurrency[0].transactioncurrencyid, baseCurrencyId(organization.organizationid));
  const ledger = (name) => store.state.tables.x_ledger.find((row) => row.x_name === name) ?? null;
  return { ...fixture, diagnostics, ledger };
}

test("create without a currency stamps the base currency: rate 1 and each money _base at the base precision", async (t) => {
  const { request, json, store } = await setup(t);
  const created = await json(await request("POST", "/x_ledgers", { x_name: "Base", x_price: 100.456, x_cost: 10.5 }), 201);
  assert.equal(created.x_price_base, 100.46);
  assert.equal(created.x_cost_base, 10.5);
  const row = store.state.tables.x_ledger.find((item) => item.x_name === "Base");
  assert.equal(row.exchangerate, 1);
  assert.equal(row.transactioncurrencyid, store.state.tables.transactioncurrency[0].transactioncurrencyid);
});

test("money-free creates retain an unset currency until a zero money value is written", async (t) => {
  const { request, json, ledger, store } = await setup(t);
  for (const [name, values] of [['Omitted', {}], ['Explicit null', { x_price: null, x_cost: null }]]) {
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

test("an explicit currency alone still supplies its rate without inventing money amounts", async (t) => {
  const { request, json, ledger } = await setup(t);
  await json(await request('POST', '/x_ledgers', { x_name: 'Currency only', ...currencyBind(EURO) }), 201);
  assert.equal(ledger('Currency only').transactioncurrencyid, EURO);
  assert.equal(ledger('Currency only').exchangerate, 1.3);
  assert.equal(ledger('Currency only').x_price_base, undefined);
});

test('invalid money payloads retain the shared OData validation code and roll back derived stamps', async t => {
  const { request, json, store } = await setup(t);
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

test("create with an explicit currency divides by its rate, rounded to the currency precision (not the column's)", async (t) => {
  const { request, json, ledger } = await setup(t);
  await json(await request("POST", "/x_ledgers", { x_name: "Euro", x_price: 100, x_cost: 10, ...currencyBind(EURO) }), 201);
  assert.equal(ledger("Euro").transactioncurrencyid, EURO);
  assert.equal(ledger("Euro").exchangerate, 1.3);
  assert.equal(ledger("Euro").x_price_base, 76.923);
  assert.equal(ledger("Euro").x_cost_base, 7.692);
});

test("a currency without a precision rounds each money _base to its column precision", async (t) => {
  const { request, json, ledger } = await setup(t);
  await json(await request("POST", "/x_ledgers", { x_name: "Bare", x_price: 10, x_cost: 10, ...currencyBind(BARE) }), 201);
  assert.equal(ledger("Bare").x_price_base, 3.33);
  assert.equal(ledger("Bare").x_cost_base, 3.3333);
});

test("a bind naming an unknown currency is refused with the lookup inner code and stores nothing", async (t) => {
  const { request, json, ledger } = await setup(t);
  // Native code not known: the Web API resolves the bind before the hook runs and answers 404, not the hook's 400.
  const body = await json(await request("POST", "/x_ledgers", { x_name: "Lost", x_price: 1, ...currencyBind(UNKNOWN) }), 404);
  assert.equal(body.error.code, "0x80040217");
  assert.equal(ledger("Lost"), null);
});

test("an update of a row whose held currency no longer exists is refused with the lookup inner code and changes nothing", async (t) => {
  const { request, json, store } = await setup(t);
  const before = structuredClone(store.state.tables.x_ledger.find((row) => row.x_ledgerid === HELD_LOST));
  // Native code not known: the records layer resolves the stored lookup before the hook and answers 404, not the hook's 400.
  const body = await json(await request("PATCH", `/x_ledgers(${HELD_LOST})`, { x_price: 60 }), 404);
  assert.equal(body.error.code, "0x80040217");
  assert.deepEqual(store.state.tables.x_ledger.find((row) => row.x_ledgerid === HELD_LOST), before);
});

test("an update that gives a money value keeps the currency the row holds and its rate", async (t) => {
  const { request, json, store } = await setup(t);
  await json(await request("PATCH", `/x_ledgers(${HELD})`, { x_price: 130 }), 200);
  const row = store.state.tables.x_ledger.find((item) => item.x_ledgerid === HELD);
  assert.equal(row.transactioncurrencyid, EURO);
  assert.equal(row.exchangerate, 1.3);
  assert.equal(row.x_price_base, 100);
});

test("a table without money columns is untouched: no currency, rate or diagnostic is stamped", async (t) => {
  const { request, json, store, diagnostics } = await setup(t);
  await json(await request("POST", "/x_notes", { x_name: "Plain" }), 201);
  const row = store.state.tables.x_note.find((item) => item.x_name === "Plain");
  assert.equal("transactioncurrencyid" in row, false);
  assert.equal("exchangerate" in row, false);
  assert.equal(diagnostics.some((entry) => entry.code === "CURRENCY_BASE_MISSING"), false);
});

test("a missing base currency emits CURRENCY_BASE_MISSING once and the write proceeds without stamping", async (t) => {
  const { request, json, store, diagnostics, ledger } = await setup(t);
  store.state.tables.transactioncurrency.splice(0);
  await json(await request("POST", "/x_ledgers", { x_name: "First", x_price: 5 }), 201);
  await json(await request("POST", "/x_ledgers", { x_name: "Second", x_price: 6 }), 201);
  assert.equal(diagnostics.filter((entry) => entry.code === "CURRENCY_BASE_MISSING").length, 1);
  assert.equal("x_price_base" in ledger("First"), false);
  assert.equal(ledger("Second").x_price, 6);
});

test("RetrieveExchangeRate answers the base and an invented currency, and 404 for an unknown id", async (t) => {
  const { request, json, store } = await setup(t);
  const base = store.state.tables.transactioncurrency[0].transactioncurrencyid;
  assert.equal((await json(await request("GET", `/RetrieveExchangeRate(TransactionCurrencyId=${base})`), 200)).ExchangeRate, 1);
  assert.equal((await json(await request("GET", `/RetrieveExchangeRate(TransactionCurrencyId=${EURO})`), 200)).ExchangeRate, 1.3);
  const missing = await json(await request("GET", `/RetrieveExchangeRate(TransactionCurrencyId=${UNKNOWN})`), 404);
  assert.equal(missing.error.code, "0x80040217");
});

test("describe names the stamping and the reused exchange-rate function at behaviour level", () => {
  const record = EXTENSION.describe();
  assert.equal(record.level, "behaviour");
  assert.deepEqual(record.requires, ["table:transactioncurrency"]);
  assert.ok(record.operations.includes("CurrencyStamp"));
  assert.ok(record.operations.includes("RetrieveExchangeRate"));
});
