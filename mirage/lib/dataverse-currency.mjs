// Currency in the Dataverse API: a table with money columns carries a transaction currency, its exchange rate and base amounts.
//
// A create or update that gives a money value or a currency stamps the row before it is stored. Merely creating a row in a
// table with money columns leaves its currency and exchange rate unset until a value or currency is supplied:
//   1. transactioncurrencyid: the payload's currency (plain key or transactioncurrencyid@odata.bind), else the currency the stored
//      row already holds (update), else the organization base currency (organization.basecurrencyid, else the first
//      transactioncurrency row). No base currency: CURRENCY_BASE_MISSING once per table, and the stamp is skipped.
//      The payload carries it, so plug-ins see it in the PreValidation Target.
//   Steps 2 and 3 run at the main operation, on the row PreOperation left (the PostOperation Target shows them):
//   2. exchangerate: the currency's exchangerate. The base currency is 1, whatever its stored value.
//   3. <column>_base = <column> / exchangerate, for each money column that holds a value, rounded to the digits of the column's
//      PrecisionSource (MoneyAttributeMetadata): 2 the currency's currencyprecision, 1 the organization's pricingdecimalprecision,
//      0 or absent the column's precision; each falls back to the column's precision, then 2. The <column>_base definition is
//      used when the table defines one.
// A payload naming a currency that does not exist fails the write with 400 and innerCode 0x80040217.
// Tables without a money column are not touched. The transactioncurrency table is the one dataverse-security.mjs seeds (with the
// organization base currency); RetrieveExchangeRate is registered by dataverse-predefined.mjs and reused here, not registered again.
// ponytail: base amounts are computed when the row is written; a change to a currency's exchangerate does not restate rows
// already stored. Upgrade: a re-base pass over the rows that hold the currency.
// ponytail: money values are converted as JavaScript numbers; a decimal with more digits than a double keeps loses them. Upgrade:
// the exact-numeric helpers in dataverse-values.mjs.
// Assumptions, not confirmed against the platform: the rate direction (base = value / exchangerate), the rounding mode
// (half away from zero), the PrecisionSource 1 digits (pricingdecimalprecision; Learn's enum, not captured), the 400 status for
// an unknown transactioncurrency on write (other lookup misses answer 404), and the messages for a non-positive exchange rate
// and a currency binding that names no id.
import { DataError } from './data-error.mjs';
import { fieldKind } from './dataverse-values.mjs';
import { isExactNumeric } from './exact-numeric.mjs';
import { organizationRecord } from './organization-context.mjs';
import { runRetrieveExchangeRate } from './plugin-platform-messages.mjs';

const CURRENCY_TABLE = 'transactioncurrency';
const ORGANIZATION_TABLE = 'organization';
const NOT_FOUND_CODE = '0x80040217';
const BIND = 'transactioncurrencyid@odata.bind';
const currencyBindings = (data) => Object.keys(data).filter((name) => name.toLowerCase() === BIND);
const OPERATIONS = ['CurrencyStamp', 'BaseAmount', 'RetrieveExchangeRate'];

const bare = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const refId = (value) => (value !== null && typeof value === 'object' ? value.id : value);
const empty = (value) => value === null || value === undefined || value === '';
const isCount = (value) => !empty(value) && Number.isInteger(Number(value)) && Number(value) >= 0;

const notFound = (id) =>
  new DataError(`transactioncurrency With Id = ${id} Does Not Exist`, 400, 'InvalidRequest', {
    id,
    innerCode: NOT_FOUND_CODE,
  }); // status assumed (see header)
const bindId = (value) => {
  const match = /\(([^()]+)\)\s*$/.exec(String(value ?? ''));
  if (!match)
    throw new DataError(`The transactioncurrencyid binding '${value}' names no currency.`, 400, 'InvalidRequest'); // native message text not known
  return bare(match[1]);
};

// Rounds half away from zero to the given number of decimal places.
function roundTo(value, digits) {
  const factor = 10 ** digits;
  return Number(((Math.sign(value) * Math.round(Math.abs(value) * factor)) / factor).toFixed(digits));
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
  const diagnostic = { severity: 'warning', ...entry };
  state.diagnostics.push(diagnostic);
  state.diagnostic?.(diagnostic);
}

// The payload's currency id (plain key or bind), removing the bind so the store does not read it again; null when none is given.
function currencyOfPayload(data) {
  const plain = refId(data.transactioncurrencyid);
  const bindings = currencyBindings(data);
  if (bindings.length > 1)
    throw new DataError('The currency lookup has ambiguous navigation bindings.', 400, 'InvalidLookup');
  const bound = data[bindings[0]];
  if (empty(plain) && empty(bound)) return null;
  if (bindings.length) delete data[bindings[0]];
  return empty(plain) ? bindId(bound) : bare(plain);
}

const currencyById = (api, id) =>
  api.store.tableRows(CURRENCY_TABLE).find((row) => bare(row.transactioncurrencyid) === id) ?? null;

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
  if (!Number.isFinite(rate) || rate <= 0)
    throw new DataError(
      `The exchange rate of currency '${row.isocurrencycode ?? row.transactioncurrencyid}' must be a positive number.`,
      400,
      'InvalidRequest',
    );
  return rate;
}

// Money columns of a table: kind money, excluding the _base companions.
function moneyColumnsOf(api, logical) {
  return Object.entries(api.store.fieldDefinitions(logical, api.metadataFields)).filter(
    ([name, definition]) => fieldKind(definition) === 'money' && !name.endsWith('_base'),
  );
}

// Stamps the currency, its exchange rate and each money column's base amount onto the payload (data).
function stamp(api, state, mapping, { operation: _operation, data, existing }) {
  const money = moneyColumnsOf(api, mapping.logicalName);
  if (!money.length) return;
  const explicit = currencyOfPayload(data);
  const moneyGiven = money.some(([name]) => !empty(data[name]));
  if (explicit === null && !moneyGiven) return;

  const held = existing ? bare(refId(existing.transactioncurrencyid)) : '';
  const base = baseCurrencyOf(api);
  const id = explicit ?? (empty(held) ? null : held);
  let row;
  if (id !== null) {
    row = currencyById(api, id);
    if (!row) throw notFound(id);
  } else {
    if (!base) {
      report(state, {
        code: 'CURRENCY_BASE_MISSING',
        table: mapping.logicalName,
        message: `Table '${mapping.logicalName}' has money columns, but the organization has no base currency; no currency was stamped.`,
      });
      return;
    }
    row = base;
  }
  // A non-positive rate fails the write before any plug-in runs.
  rateOf(row, base);
  // Source navigation names may use PascalCase (TransactionCurrencyId), and
  // native forms may post an empty lookup. Once stamping selects a currency,
  // consume its binding before emitting the plain lookup value.
  for (const binding of currencyBindings(data)) delete data[binding];
  data.transactioncurrencyid = row.transactioncurrencyid;
}

// Digits of a <money>_base amount, by the column's PrecisionSource (see the header, item 3).
function baseDigits(api, definitions, name, definition, currency) {
  const column = definitions[`${name}_base`] ?? definition;
  const source = Number(column.precisionSource);
  const sourced =
    source === 2
      ? currency.currencyprecision
      : source === 1
        ? organizationRecord(api.store)?.pricingdecimalprecision
        : null;
  if (isCount(sourced)) return Number(sourced);
  return isCount(column.precision) ? Number(column.precision) : 2;
}

// The main operation derives the exchange rate and base amounts from the row as PreOperation left it (native Create:
// they first appear in the PostOperation Target). An update re-derives them only when it writes a money column or the
// currency; clearing a money value clears its base amount.
function settle(api, mapping, { operation, row, previous, target, identity, options }) {
  const money = moneyColumnsOf(api, mapping.logicalName);
  if (!money.length) return;
  const touched = operation === 'create' ? null : new Set(Object.keys(target ?? {}));
  for (const [name] of money)
    if (touched?.has(name) && empty(row[name]) && row[`${name}_base`] != null) row[`${name}_base`] = null;
  const id = bare(refId(row.transactioncurrencyid));
  if (!id || (touched && !touched.has('transactioncurrencyid') && !money.some(([name]) => touched.has(name)))) return;
  const currency = currencyById(api, id);
  if (!currency) throw notFound(id);
  let rate = rateOf(currency, baseCurrencyOf(api));
  // A CreateMultiple record's rate: the request's one RetrieveExchangeRate already ran (bulkRates).
  const preset = options?.currencyRates && Object.hasOwn(options.currencyRates, id) ? options.currencyRates[id] : null;
  // The platform's RetrieveExchangeRate sub-operation (internal stage 25) runs with its own plug-in pipeline; its
  // ExchangeRate output prices the base amounts (recorded native crud and currency). An Update that writes a money column
  // runs it also when the value is null (native nullSemantics: an all-null PATCH on a row holding a currency runs it under
  // Update/25 < Update/30). A Create runs it only for a non-empty money value (a POST with money null runs none).
  const rerDue = touched ? money.some(([name]) => touched.has(name)) : money.some(([name]) => !empty(row[name]));
  if (preset != null) rate = preset;
  else if (rerDue)
    rate = runRetrieveExchangeRate(api.store, {
      mapping,
      operation,
      row,
      previous,
      target,
      currencyId: id,
      rate,
      identity,
      options,
    });
  row.exchangerate = rate;
  const definitions = api.store.fieldDefinitions(mapping.logicalName, api.metadataFields);
  for (const [name, definition] of money) {
    if (empty(row[name])) continue;
    const amount = Number(isExactNumeric(row[name]) ? row[name].value : row[name]);
    // The shared payload validator owns invalid decimal values and their OData
    // error envelope. A derived amount must not replace that validation error.
    if (!Number.isFinite(amount)) continue;
    row[`${name}_base`] = roundTo(amount / rate, baseDigits(api, definitions, name, definition, currency));
  }
}

// A CreateMultiple (Web API or SDK) runs RetrieveExchangeRate once per request before its first record's main operation,
// once per distinct currency of the records that write a money value, in record order (native currency: one
// RetrieveExchangeRate 20/40/async for two records). values: each record's columns; ctx.issuer() names the issuing
// contexts. Answers { currencyId: rate } for the records' main operations, or null.
function bulkRates(api, mapping, values, { identity, options, issuer }) {
  const money = moneyColumnsOf(api, mapping.logicalName);
  if (!money.length) return null;
  const base = baseCurrencyOf(api),
    rates = {};
  for (const record of values) {
    if (!money.some(([name]) => !empty(record[name]))) continue;
    const held = bare(refId(record.transactioncurrencyid));
    const currency = held ? currencyById(api, held) : base;
    if (!currency) {
      if (held) throw notFound(held);
      continue;
    }
    const id = bare(currency.transactioncurrencyid);
    if (Object.hasOwn(rates, id)) continue;
    const issuing = issuer();
    rates[id] = runRetrieveExchangeRate(api.store, {
      mapping,
      operation: 'create',
      row: issuing.record,
      target: issuing.target,
      currencyId: id,
      rate: rateOf(currency, base),
      identity,
      options,
      bulk: issuing,
    });
  }
  return Object.keys(rates).length ? rates : null;
}

/** install(api, { diagnostic }): diagnostic receives each diagnostic once. Exposes api.currency = { diagnostics(), bulkRates }. */
function install(api, { diagnostic } = {}) {
  const state = stateOf(api);
  state.diagnostic = diagnostic ?? api.diagnostic ?? null;
  api.currency = {
    diagnostics: () => [...state.diagnostics],
    bulkRates: (mapping, values, ctx) => bulkRates(api, mapping, values, ctx),
  };
  api.recordHooks.add('beforeWrite', (c, mapping, info) => {
    if (info.operation === 'delete' || !info.data) return;
    stamp(api, state, mapping, info);
  });
  api.recordHooks.add('mainOperation', (c, mapping, info) => settle(api, mapping, info));
}

// Runs on every reseed, inside the server's change queue.
function reset(api) {
  const state = stateOf(api);
  state.seen.clear();
  state.diagnostics.length = 0;
}

/** Capability record. RetrieveExchangeRate executes in dataverse-predefined.mjs; listed here as the currency contract. */
function describe() {
  return {
    name: 'dataverse-currency',
    version: 1,
    kind: 'dataverse-extension',
    level: 'behaviour',
    operations: OPERATIONS,
    requires: ['table:transactioncurrency'],
    principal: 'caller',
    stateOwner: 'none',
    lifecycle: 'per-request',
  };
}

export const EXTENSION = { name: 'dataverse-currency', install, reset, describe };
