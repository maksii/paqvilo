// Currency in the Dataverse API: a table with money columns carries a transaction currency, its exchange rate and base amounts.
//
// On create, and on an update that gives a money value or a currency, the beforeWrite hook stamps the row before it is stored:
//   1. transactioncurrencyid: the payload's currency (plain key or transactioncurrencyid@odata.bind), else the currency the stored
//      row already holds (update), else the organization base currency (organization.basecurrencyid, else the first
//      transactioncurrency row). No base currency: CURRENCY_BASE_MISSING once per table, and the stamp is skipped.
//   2. exchangerate: the currency's exchangerate. The base currency is 1, whatever its stored value.
//   3. <column>_base = <column> / exchangerate, rounded to the currency's currencyprecision (fallback: the column's precision, then
//      2), for each money column that holds a value.
// A payload naming a currency that does not exist fails the write with 400 and innerCode 0x80040217.
// Tables without a money column are not touched. The transactioncurrency table is the one dataverse-security.mjs seeds (with the
// organization base currency); RetrieveExchangeRate is registered by dataverse-predefined.mjs and reused here, not registered again.
// ponytail: base amounts are computed when the row is written; a change to a currency's exchangerate does not restate rows
// already stored. Upgrade: a re-base pass over the rows that hold the currency.
// ponytail: money values are converted as JavaScript numbers; a decimal with more digits than a double keeps loses them. Upgrade:
// the exact-numeric helpers in dataverse-values.mjs.
// unverified: the rate direction (base = value / exchangerate) comes from the module brief, not Microsoft Learn.
// unverified: the rounding mode (half away from zero assumed).
// unverified: the 400 status for an unknown transactioncurrency on write (other lookup misses answer 404).
// unverified: the messages for a non-numeric money value, a non-positive exchange rate and a currency binding that names no id.
import { DataError } from "./data-error.mjs";
import { fieldKind } from "./dataverse-values.mjs";
import { isExactNumeric } from "./exact-numeric.mjs";

const CURRENCY_TABLE = "transactioncurrency";
const ORGANIZATION_TABLE = "organization";
const NOT_FOUND_CODE = "0x80040217";
const BIND = "transactioncurrencyid@odata.bind";
const OPERATIONS = ["CurrencyStamp", "BaseAmount", "RetrieveExchangeRate"];

const bare = (value) => String(value ?? "").replace(/[{}]/g, "").toLowerCase();
const refId = (value) => (value !== null && typeof value === "object" ? value.id : value);
const empty = (value) => value === null || value === undefined || value === "";
const isCount = (value) => !empty(value) && Number.isInteger(Number(value)) && Number(value) >= 0;

const notFound = (id) => new DataError(`transactioncurrency With Id = ${id} Does Not Exist`, 400, "InvalidRequest", { id, innerCode: NOT_FOUND_CODE }); // unverified: status
const bindId = (value) => {
  const match = /\(([^()]+)\)\s*$/.exec(String(value ?? ""));
  if (!match) throw new DataError(`The transactioncurrencyid binding '${value}' names no currency.`, 400, "InvalidRequest"); // unverified: message text
  return bare(match[1]);
};

// Rounds half away from zero to the given number of decimal places.
function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Number((Math.sign(value) * Math.round(Math.abs(value) * factor) / factor).toFixed(digits));
}

const states = new WeakMap();
function stateOf(api) {
  if (!states.has(api)) states.set(api, { diagnostic: null, diagnostics: [], seen: new Set() });
  return states.get(api);
}

// Diagnostics: once per code and table, then never again until reset.
function report(state, entry) {
  const key = `${entry.code}\u0000${entry.table}`;
  if (state.seen.has(key)) return;
  state.seen.add(key);
  const diagnostic = { severity: "warning", ...entry };
  state.diagnostics.push(diagnostic);
  state.diagnostic?.(diagnostic);
}

// The payload's currency id (plain key or bind), removing the bind so the store does not read it again; null when none is given.
function currencyOfPayload(data) {
  const plain = refId(data.transactioncurrencyid);
  const bound = data[BIND];
  if (empty(plain) && empty(bound)) return null;
  delete data[BIND];
  return empty(plain) ? bindId(bound) : bare(plain);
}

const currencyById = (api, id) => api.store.tableRows(CURRENCY_TABLE).find((row) => bare(row.transactioncurrencyid) === id) ?? null;

// The organization's base currency row, or null when there is none to stamp.
function baseCurrencyOf(api) {
  const organization = api.store.tableRows(ORGANIZATION_TABLE)[0];
  const held = refId(organization?.basecurrencyid);
  if (!empty(held)) return currencyById(api, bare(held));
  return api.store.tableRows(CURRENCY_TABLE)[0] ?? null;
}

// The exchange rate of a currency row: the base currency is 1; any other must hold a positive rate (no guessed rate).
function rateOf(row, base) {
  if (base && bare(row.transactioncurrencyid) === bare(base.transactioncurrencyid)) return 1;
  const rate = Number(refId(row.exchangerate));
  if (!Number.isFinite(rate) || rate <= 0) throw new DataError(`The exchange rate of currency '${row.isocurrencycode ?? row.transactioncurrencyid}' must be a positive number.`, 400, "InvalidRequest");
  return rate;
}

// Money columns of a table: kind money, excluding the _base companions.
function moneyColumnsOf(api, logical) {
  return Object.entries(api.store.fieldDefinitions(logical, api.metadataFields))
    .filter(([name, definition]) => fieldKind(definition) === "money" && !name.endsWith("_base"));
}

// Stamps the currency, its exchange rate and each money column's base amount onto the payload (data).
function stamp(api, state, mapping, { operation, data, existing }) {
  const money = moneyColumnsOf(api, mapping.logicalName);
  if (!money.length) return;
  const creating = operation === "create" || (operation === "upsert" && !existing);
  const explicit = currencyOfPayload(data);
  const moneyGiven = money.some(([name]) => !empty(data[name]));
  if (!creating && explicit === null && !moneyGiven) return;

  const held = existing ? bare(refId(existing.transactioncurrencyid)) : "";
  const base = baseCurrencyOf(api);
  const id = explicit ?? (empty(held) ? null : held);
  let row;
  if (id !== null) {
    row = currencyById(api, id);
    if (!row) throw notFound(id);
  } else {
    if (!base) {
      report(state, { code: "CURRENCY_BASE_MISSING", table: mapping.logicalName, message: `Table '${mapping.logicalName}' has money columns, but the organization has no base currency; no currency was stamped.` });
      return;
    }
    row = base;
  }
  const rate = rateOf(row, base);
  data.transactioncurrencyid = row.transactioncurrencyid;
  data.exchangerate = rate;

  const merged = { ...(existing ?? {}), ...data };
  for (const [name, definition] of money) {
    if (empty(merged[name])) continue;
    const amount = Number(isExactNumeric(merged[name]) ? merged[name].value : merged[name]);
    if (!Number.isFinite(amount)) throw new DataError(`The money value of '${name}' is not a number.`, 400, "InvalidRequest"); // unverified: message text
    const digits = isCount(row.currencyprecision) ? Number(row.currencyprecision) : isCount(definition.precision) ? Number(definition.precision) : 2;
    data[`${name}_base`] = roundTo(amount / rate, digits);
  }
}

/** install(api, { diagnostic }): diagnostic receives each diagnostic once. Exposes api.currency = { diagnostics() }. */
function install(api, { diagnostic } = {}) {
  const state = stateOf(api);
  state.diagnostic = diagnostic ?? api.diagnostic ?? null;
  api.currency = { diagnostics: () => [...state.diagnostics] };
  api.recordHooks.add("beforeWrite", (c, mapping, info) => {
    if (info.operation === "delete" || !info.data) return;
    stamp(api, state, mapping, info);
  });
}

// Runs on every reseed, inside the server's change queue.
function reset(api) {
  const state = stateOf(api);
  state.seen.clear();
  state.diagnostics.length = 0;
}

/** Capability record (ARCH §2.4). RetrieveExchangeRate executes in dataverse-predefined.mjs; listed here as the currency contract. */
function describe() {
  return {
    name: "dataverse-currency",
    version: 1,
    kind: "dataverse-extension",
    level: "behaviour",
    operations: OPERATIONS,
    requires: ["table:transactioncurrency"],
    principal: "caller",
    stateOwner: "none",
    lifecycle: "per-request",
  };
}

export const EXTENSION = { name: "dataverse-currency", install, reset, describe };
