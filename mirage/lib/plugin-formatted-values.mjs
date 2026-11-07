// Entity.FormattedValues of the entities a plug-in sees (Targets and entity images), as the native pipeline fills
// them (dataverse-recorder parity corpus, 2026-10-30):
// - images carry a label for every typed value: booleans, choices, state/status, named references (name), money
//   (currency symbol, column precision), decimals/doubles (column precision), whole numbers and dates; strings,
//   unnamed references and identifiers have none. Choices list their labels as "; Red; Blue; ".
// - a Create/CreateMultiple Target carries them from PreOperation on, for the attributes the platform prepared
//   before PreOperation (the request, PreValidation edits and system values). Attributes PreOperation plug-ins
//   add and the core operation computes (exchangerate, <money>_base) carry none; Targets name no references.
// - an Update Target carries them only when the request entered as UpdateMultiple/UpsertMultiple; a single
//   Update (and every PreValidation Target) carries none. Choices list their labels as "Red; Blue".
// - dates are sortable ISO text: a user-local value in the user's time zone with its offset
//   (2026-10-30T14:55:48+00:00), a date-only or time-zone-independent value without one.
import { dateTimeBehavior, fieldKind, formattedValue, isDateOnlyField } from './dataverse-values.mjs';
import { exactNumeric } from './exact-numeric.mjs';
import { TIME_ZONE_IDS } from './platform-time-zones.mjs';
import { baseCurrencyRow } from './dataverse-security.mjs';
import { organizationRecord } from './organization-context.mjs';
import { standardFieldDefinition } from './dataverse-standard.mjs';

const UTC_CODE = 92;
const bare = (value) =>
  String(value?.id ?? value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const pad = (value) => String(value).padStart(2, '0');

// The user's time zone: usersettings.timezonecode, UTC when the user has no row (as staff-session.mjs staffContext).
function userTimeZone(store, userId) {
  const settings = store.tableRows?.('usersettings')?.find((row) => bare(row.systemuserid) === bare(userId)) ?? {},
    code = Number(settings.timezonecode ?? UTC_CODE);
  return (TIME_ZONE_IDS.find(([id]) => id === code) ?? TIME_ZONE_IDS.find(([id]) => id === UTC_CODE))?.[2] ?? 'UTC';
}
function offsetMinutes(iana, ms) {
  const name =
    new Intl.DateTimeFormat('en-US', { timeZone: iana, timeZoneName: 'longOffset' })
      .formatToParts(new Date(ms))
      .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
  const match = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  if (!match) return 0;
  const sign = match[1] === '-' ? -1 : 1;
  return sign * (Number(match[2]) * 60 + Number(match[3]));
}
function isoText(ms, offset) {
  const local = new Date(ms + (offset ?? 0) * 60000).toISOString().slice(0, 19);
  if (offset == null) return local;
  const minutes = Math.abs(offset);
  return `${local}${offset < 0 ? '-' : '+'}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

function definitionOf(store, entity, key, cache) {
  cache.platform ??= store.platformFields?.(entity) ?? {};
  // A standard table's labels come from the catalogue (native mergeAccount: 'Allow', 'Default Value', 'Any', 'Active').
  return (
    (store.state ? standardFieldDefinition(store, entity, key) : undefined) ??
    store.fieldDefinition?.(entity, key) ??
    cache.platform[key]
  );
}
// The record's currency (an image or Target may omit transactioncurrencyid), else the organization's base currency.
function currencySymbol(store, attributes, currencyId) {
  const id = attributes.transactioncurrencyid?.id ?? currencyId?.id ?? currencyId,
    row =
      (id && store.tableRows?.('transactioncurrency')?.find((r) => bare(r.transactioncurrencyid) === bare(id))) ||
      baseCurrencyRow(store, organizationRecord(store)?.organizationid);
  return row?.currencysymbol ?? store.state?.settings?.currencySymbol ?? '';
}

// A null money, choice (not state or status) or date column is listed with a null value in a Create Target.
const listsNull = (field) => {
  const kind = fieldKind(field),
    raw = String(field.dataverseType ?? field.type ?? '').toLowerCase();
  return kind === 'money' || kind === 'datetime' || (kind === 'choice' && !['state', 'status'].includes(raw));
};

function formatOne(store, value, field, { attributes, retrieved, zone, currencyId }) {
  const kind = fieldKind(field);
  if (typeof value === 'boolean') return formattedValue(value, field);
  if (typeof value === 'number')
    return ['integer', 'double', 'decimal'].includes(kind) ? formattedValue(value, field) : undefined;
  if (!value || typeof value !== 'object') return undefined;
  switch (value.$type) {
    case 'OptionSetValue':
      return formattedValue(value.value, field);
    case 'OptionSetValueCollection':
      return formatOptionSetValues(value, field, retrieved);
    case 'Double':
      return formatDoubleValue(value, field, kind);
    case 'EntityReference':
      return formatEntityReference(value);
    case 'Money':
    case 'Decimal':
      return formatMoneyValue(store, value, field, kind, attributes, currencyId);
    case 'DateTime': {
      return formatDateTime(value, field, kind, zone);
    }
    default:
      return undefined;
  }
}

function formatOptionSetValues(value, field, retrieved) {
  const labels = (value.values ?? []).map((item) =>
    formattedValue(item?.value ?? item, { ...field, dataverseType: 'picklist' }),
  );
  if (!labels.length || labels.includes(undefined)) return undefined;
  return retrieved ? `; ${labels.join('; ')}; ` : labels.join('; ');
}

function formatDoubleValue(value, field, kind) {
  return kind === 'double' ? formattedValue(Number(value.value), field) : undefined;
}

function formatEntityReference(value) {
  return typeof value.name === 'string' ? value.name : undefined;
}

function formatMoneyValue(store, value, field, kind, attributes, currencyId) {
  if (!['money', 'decimal'].includes(kind)) return undefined;
  return formattedValue(exactNumeric(String(value.value), 'Decimal'), field, {
    currencySymbol: currencySymbol(store, attributes, currencyId),
  });
}

function formatDateTime(value, field, kind, zone) {
  // A date-only or time-zone-independent value is a wall-clock time; an unzoned user-local value is UTC.
  const text = String(value.value);
  let parsable = `${text}Z`;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(text)) parsable = text;
  else if (text.length === 10) parsable = `${text}T00:00:00Z`;
  const ms = Date.parse(parsable);
  if (!Number.isFinite(ms) || kind !== 'datetime') return undefined;
  const wallClock = isDateOnlyField(field) || dateTimeBehavior(field) === 'timezoneindependent';
  return isoText(ms, wallClock ? null : offsetMinutes(zone, ms));
}

function formatAttribute(store, entity, key, value, options, cache, out) {
  if (options.keys && !options.keys.includes(key)) return;
  const field = definitionOf(store, entity, key, cache);
  if (!field) return;
  if (value == null) {
    if (options.nullEntries && listsNull(field)) out[key] = null;
    return;
  }
  if (value?.$type === 'DateTime') options.zone ??= userTimeZone(store, options.userId);
  const text = formatOne(store, value, field, {
    attributes: options.attributes,
    retrieved: options.retrieved,
    zone: options.zone,
    currencyId: options.currencyId,
  });
  if (text !== undefined && text !== null) out[key] = text;
}

/** FormattedValues of an SDK entity for the user the pipeline runs as. keys limits the formatted attributes. */
export function pipelineFormattedValues(
  store,
  entity,
  sdkEntity,
  { userId, retrieved = false, keys, currencyId, nullEntries = false } = {},
) {
  const attributes = sdkEntity?.attributes ?? {},
    cache = {},
    out = {},
    options = { attributes, retrieved, userId, keys, currencyId, nullEntries };
  for (const [key, value] of Object.entries(attributes)) {
    formatAttribute(store, entity, key, value, options, cache, out);
  }
  return out;
}

// Values the core operation computes after PreOperation: the exchange rate and base-currency amounts.
const computedByCore = (store, entity, key, cache) =>
  key === 'exchangerate' || (key.endsWith('_base') && fieldKind(definitionOf(store, entity, key, cache)) === 'money');

/** Sets the FormattedValues of a Create/Update(Multiple) context's Target or Targets in place (see header). */
export function formatPipelineTargets(store, { entity, operation, stage, frame, userId, values, currencyId }) {
  const bulk = ['createmultiple', 'updatemultiple'].includes(operation);
  if (!bulk && !['create', 'update'].includes(operation)) return;
  const list = bulk ? values?.Targets?.entities : [values?.Target];
  if (!Array.isArray(list) || !list.every((target) => target?.$type === 'Entity')) return;
  const formatted = stage !== 10 && (operation.startsWith('create') || frame.bulkOrigin === true);
  // The first PreOperation (else PostOperation) context records the attributes the platform prepared.
  if (formatted) frame.formattedTargetKeys ??= list.map((target) => Object.keys(target.attributes ?? {}));
  const cache = {};
  const next = list.map((target, index) => {
    const { formattedValues: _, ...rest } = target; // NOSONAR: binding is excluded from the rest object or is a placeholder
    if (!formatted) return rest;
    const keys = (frame.formattedTargetKeys[index] ?? Object.keys(target.attributes ?? {})).filter(
      (key) => !computedByCore(store, entity, key, cache),
    );
    const fv = pipelineFormattedValues(store, entity, target, {
      userId,
      keys,
      currencyId,
      nullEntries: operation.startsWith('create'),
    });
    return Object.keys(fv).length ? { ...rest, formattedValues: fv } : rest;
  });
  if (bulk) values.Targets = { ...values.Targets, entities: next };
  else values.Target = next[0];
}
