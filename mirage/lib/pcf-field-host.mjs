// The Power Pages form field host of a code component (basic and multistep forms), as captured on a live site:
// which columns it admits, the markup it renders instead of the
// native control and the hidden input that carries the field value as JSON, and how a save reads that input.

import { isExactNumeric, parseNumericLiteral } from './exact-numeric.mjs';

// The attribute type codes the host loads a field component for, as its server log names them (warning RTDTPC19,
// captured). Any other column type (Lookup, Customer, Owner, PartyList, Virtual for File and
// Image, ...) keeps the native control and is listed in the form's code component summary.
export const NATIVE_FIELD_ADMISSION = Object.freeze([
  'Boolean',
  'DateTime',
  'Decimal',
  'Double',
  'Integer',
  'Memo',
  'Money',
  'Picklist',
  'String',
  'BigInt',
  'Status',
  'State',
  'MultiSelectPicklist',
]);
const ATTRIBUTE_TYPE_CODES = {
  nvarchar: 'String',
  string: 'String',
  ntext: 'Memo',
  memo: 'Memo',
  int: 'Integer',
  integer: 'Integer',
  bigint: 'BigInt',
  decimal: 'Decimal',
  float: 'Double',
  double: 'Double',
  money: 'Money',
  datetime: 'DateTime',
  bit: 'Boolean',
  boolean: 'Boolean',
  picklist: 'Picklist',
  state: 'State',
  status: 'Status',
  multiselectpicklist: 'MultiSelectPicklist',
  lookup: 'Lookup',
  customer: 'Customer',
  owner: 'Owner',
  partylist: 'PartyList',
  file: 'Virtual',
  image: 'Virtual',
  virtual: 'Virtual',
  uniqueidentifier: 'Uniqueidentifier',
  primarykey: 'Uniqueidentifier',
  entityname: 'EntityName',
};
// Without an exported Dataverse type the native control kind (platform.mjs nativeControlKind) names the column type.
const CONTROL_TYPE_CODES = {
  text: 'String',
  email: 'String',
  textarea: 'Memo',
  richtext: 'Memo',
  integer: 'Integer',
  decimal: 'Decimal',
  double: 'Double',
  money: 'Money',
  datetime: 'DateTime',
  boolean: 'Boolean',
  picklist: 'Picklist',
  state: 'State',
  status: 'Status',
  multiselect: 'MultiSelectPicklist',
  lookup: 'Lookup',
  file: 'Virtual',
  image: 'Virtual',
};

/** The attribute type code of a native form column and whether the form host admits a field component for it. */
export function nativeFieldAdmission(control, dataverseType) {
  const typeCode =
    ATTRIBUTE_TYPE_CODES[String(dataverseType ?? '').toLowerCase()] ?? CONTROL_TYPE_CODES[control] ?? null;
  return { typeCode, admitted: Boolean(typeCode && NATIVE_FIELD_ADMISSION.includes(typeCode)) };
}

/** The summary entry of a refused column (captured wording). */
export function nativeFieldRefusal(typeCode, label, column) {
  return `${typeCode} data type used by ${label} (${column}) is not supported for use with code components in portals.`;
}

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/** The summary entry of a control the host could not load for another reason, here a static input value it cannot
 * convert (captured wording: a TwoOptions static "1"). It carries no link. */
export function nativeFieldUnknownProblem(label, column) {
  return `Couldn't load code component for ${label} (${column}) because of an unknown problem.`;
}

// Element text (the platform writes the apostrophe of its wording as is).
const escapeText = (value) =>
  String(value ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);

/** The form's summary of refused field components, after its validation summary (captured markup and link).
 * Entries: { message, link } (a refused column type links to the documentation). */
export function nativeFieldRefusalSummary(viewId, entries) {
  if (!entries.length) return '';
  const items = entries
    .map(
      ({ message, link }) =>
        `<li>${escapeText(message)}${link ? " <a href='https://go.microsoft.com/fwlink/?linkid=2155120 '>Learn more</a>" : ''}</li>`,
    )
    .join('');
  return `<div id="FailePcfControlsSummary_${escapeHtml(viewId)}" class="validation-summary alert alert-error alert-danger alert-block"><h2 class='validation-header'><span role='presentation' class='fa fa-info-circle'></span> Couldn't load one or more code components on this form.</h2><ul>${items}</ul></div>`;
}

/** A static FormXml input as the host converts it (captured): text and Enum values stay
 * strings ("3"), a whole number "12" is 12, a decimal "2.5" is 2.5, a Two Options value is "true" or "false"; a value
 * the host cannot convert (Two Options "1") refuses the whole control. Number types other than those captured follow
 * the decimal rule, and date and lookup types keep the text (LOCAL MODEL, unproven). */
export function nativeStaticValue(text, type) {
  const value = String(text ?? '');
  if (type === 'TwoOptions')
    return /^(true|false)$/i.test(value) ? { value: /^true$/i.test(value) } : { refused: true };
  if (String(type).startsWith('Whole.'))
    return /^[+-]?\d+$/.test(value.trim()) ? { value: Number(value) } : { refused: true };
  if (['Decimal', 'FP', 'Currency'].includes(type))
    return value.trim() !== '' && Number.isFinite(Number(value)) ? { value: Number(value) } : { refused: true };
  return { value };
}

/** The host element id: PcfControl_ and the hex digits of the FormXml control uniqueid (captured). */
export function nativeFieldHostId(controlId, fallback) {
  const hex = String(controlId ?? '').replaceAll(/[^0-9a-f]/gi, '');
  // A FormXml uniqueid is a GUID; any other control id names the host by the field.
  return `PcfControl_${hex.length === 32 ? hex.toLowerCase() : String(fallback ?? '').replaceAll(/[^\w-]/g, '')}`;
}

const pad = (value, size = 2) => String(value).padStart(size, '0');
const DATE_TEXT = /^(\d{4})-(\d{2})-(\d{2})/;
const TIME_TEXT = /^[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?/i;
const ZONE_TEXT = /^(Z|[+-]\d{2}:?\d{2})?$/i;
// [year, month, day, hour, minute, second, fraction, zone] of `YYYY-MM-DD[( |T)HH:mm[:ss[.f]]][Z|+hh:mm]`, unset
// parts undefined; null for any other text.
function dateTextParts(text) {
  const date = DATE_TEXT.exec(text);
  if (!date) return null;
  let rest = text.slice(date[0].length);
  const time = TIME_TEXT.exec(rest);
  if (time) rest = rest.slice(time[0].length);
  const zone = ZONE_TEXT.exec(rest);
  if (!zone) return null;
  return [date[1], date[2], date[3], time?.[1], time?.[2], time?.[3], time?.[4], zone[1]];
}
// The calendar and clock fields of a date value: a value with a zone (Z or an offset) by its UTC clock, a value
// without one as written.
function dateParts(value) {
  const text = String(value ?? '').trim();
  const match = dateTextParts(text);
  if (!match) return null;
  const [year, month, day, hour = '00', minute = '00', second = '00', fraction = '', zone] = match;
  if (!zone) return { year, month, day, hour, minute, second, fraction };
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return null;
  return {
    year: pad(date.getUTCFullYear(), 4),
    month: pad(date.getUTCMonth() + 1),
    day: pad(date.getUTCDate()),
    hour: pad(date.getUTCHours()),
    minute: pad(date.getUTCMinutes()),
    second: pad(date.getUTCSeconds()),
    fraction: pad(date.getUTCMilliseconds(), 3),
  };
}

const scalarOf = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value.value ?? value.id) : value;
const multiValues = (value) => {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value.map((item) => Number(scalarOf(item)));
  return String(value)
    .split(',')
    .filter((item) => item.trim() !== '')
    .map(Number);
};

function reshownHiddenValue(text) {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function dateServerValue(column, value) {
  const parts = dateParts(value);
  if (!parts) return String(value);
  const { year, month, day, hour, minute, second } = parts;
  if (column.behavior === 'DateOnly') return `${year}-${month}-${day}T00:00:00`;
  if (column.behavior === 'TimeZoneIndependent') return `${year}-${month}-${day}T${hour}:${minute}:${second}`;
  // A user-local value without a zone is a UTC instant in the store.
  const instant = new Date(/(?:Z|[+-]\d{2}:?\d{2})$/i.test(String(value)) ? value : String(value) + 'Z');
  return Number.isFinite(instant.getTime()) ? instant.toISOString().replace(/\.\d{3}Z$/, 'Z') : String(value);
}

/** The column value the host hands the component, as the server writes it into pcf-controlcontext ControlProperties
 * and (JSON-encoded) into the hidden input: text as is, numbers, booleans, a choice as { Value }, choices as an array
 * of { Value }, a date-only or time-zone-independent date as its wall clock ("2026-03-15T00:00:00") and a user-local
 * date as its UTC instant ("2026-03-15T14:05:09Z") (captured). `column` names the native
 * control kind and the date behaviour of the column. */
export function nativeFieldServerValue(column, current) {
  // A form re-rendered from its postback shows the posted hidden input again.
  if (isPcfHiddenValue(current)) return reshownHiddenValue(current.pcfHiddenValue);
  const value = scalarOf(current);
  if (value == null || value === '') return null;
  switch (column.control) {
    case 'picklist':
    case 'status':
    case 'state':
      return { Value: Number(value) };
    case 'multiselect': {
      const values = multiValues(current);
      return values.length ? values.map((item) => ({ Value: item })) : null;
    }
    case 'boolean':
      return value === true || value === 1 || /^(true|1)$/i.test(String(value));
    case 'integer':
    case 'decimal':
    case 'double':
    case 'money':
      return Number.isFinite(Number(value)) ? Number(value) : String(value);
    case 'datetime':
      return dateServerValue(column, value);
    default:
      return String(value);
  }
}

/** The hidden input value of a mounted field: the server value as JSON, "" for an empty column; decimal and currency
 * numbers carry the stored scale of ten digits ("1234.5000000000", captured) and keep every stored digit (an exact
 * store value is written from its digit text, never through a JavaScript number). */
export function nativeFieldHiddenValue(column, current) {
  if (isPcfHiddenValue(current)) return current.pcfHiddenValue;
  if (['decimal', 'money', 'integer'].includes(column.control)) {
    const digits = exactDigits(current);
    if (digits != null) return column.control === 'integer' ? digits : padScale(digits, 10);
  }
  const value = nativeFieldServerValue(column, current);
  if (value == null) return '';
  if (['decimal', 'money'].includes(column.control) && typeof value === 'number') return value.toFixed(10);
  return JSON.stringify(value);
}

const NUMBER_LITERAL = /^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/;
// The digit text of a stored number: an exact store value (DataverseNumeric) or a plain literal string; null for a
// JavaScript number or anything else.
function exactDigits(current) {
  if (isExactNumeric(current)) return current.value;
  return typeof current === 'string' && NUMBER_LITERAL.test(current.trim()) ? current.trim() : null;
}
function padScale(digits, scale) {
  if (/[eE]/.test(digits)) return digits;
  const [whole, fraction = ''] = digits.split('.');
  return fraction.length >= scale ? digits : `${whole}.${fraction.padEnd(scale, '0')}`;
}

const NUMBER_CONTROLS = new Set(['integer', 'decimal', 'double', 'money']);
const OPTION_CONTROLS = new Set(['picklist', 'status', 'state']);
/** Thrown for a hidden input value the column cannot take (FormFieldInvalid). */
export class PcfFieldValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PcfFieldValueError';
  }
}
const optionValue = (item) =>
  item && typeof item === 'object' && !Array.isArray(item) && Number.isInteger(item.Value) ? item.Value : undefined;

function refusePostedValue() {
  throw new PcfFieldValueError('The hidden input of the code component holds a value the column cannot take.');
}

// The posted JSON; text that is not JSON, and null, are refused.
function parsePostedJson(text) {
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    refusePostedValue();
  }
  if (value == null) refusePostedValue();
  return value;
}

function postedChoices(value) {
  if (!Array.isArray(value)) refusePostedValue();
  const values = value.map((item) => (Number.isInteger(item) ? item : optionValue(item)));
  if (values.includes(undefined)) refusePostedValue();
  return values.length ? values.join(',') : null;
}

function postedOption(value) {
  const option = Number.isInteger(value) ? value : optionValue(value);
  if (option === undefined) refusePostedValue();
  return option;
}

function postedNumber(text, value, control) {
  const literal = String(text).trim();
  if (typeof value !== 'number' || !NUMBER_LITERAL.test(literal)) return value;
  return control === 'double' ? value : parseNumericLiteral(literal);
}

function postedDate(value, behavior) {
  const parts = dateParts(value);
  if (!parts) return value;
  const { year, month, day, hour, minute, second, fraction } = parts;
  if (behavior === 'DateOnly') return `${year}-${month}-${day}T00:00:00.0000000`;
  const time = `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(7, '0').slice(0, 7)}`;
  return behavior === 'TimeZoneIndependent' ? time : time + 'Z';
}

/** Reads the posted hidden input of a mounted field component as the native form would post the column: the one
 * decoder of both save transports (the postback and the JSON transport hand the hidden input text to the form
 * service). Captured saves (and their read-backs): strings,
 * numbers, booleans, a choice as the Value of its option object, choices as the joined Values, a user-local value as
 * its instant, a time-zone-independent value as the UTC clock of the posted instant and a date-only value as its UTC
 * calendar date. The last mirrors a platform quirk: the host posts toISOString(), so east of UTC an output of local
 * midnight saves the previous day (Kyiv). Numbers keep their posted digits (exact numeric for decimal, money and whole
 * numbers). An empty input clears the column (captured).
 * A value of the wrong type stays as posted, so the column's native validators refuse it (a quoted "abc" on a whole
 * number is "must be a valid integer value", captured). The text "null" and text that is not
 * JSON make the platform's save fail with HTTP 500 and nothing saved (captured, one load): they throw
 * PcfFieldValueError, as do (LOCAL MODEL, unproven) values no native validator covers (a non-string on rich text,
 * choices that are not option values, a choice without a Value). `column`: { control, behavior }. */
export function nativeFieldPostedValue(text, column) {
  if (text == null || text === '') return null;
  const value = parsePostedJson(text);
  const control = column.control;
  if (control === 'multiselect') return postedChoices(value);
  if (OPTION_CONTROLS.has(control)) return postedOption(value);
  if (control === 'richtext' && typeof value !== 'string') refusePostedValue();
  if (NUMBER_CONTROLS.has(control)) return postedNumber(text, value, control);
  if (control === 'datetime' && typeof value === 'string') return postedDate(value, column.behavior);
  return value;
}

/** Marks the posted value of a mounted field so the form service decodes it (nativeFieldPostedValue). */
export function pcfHiddenValue(text) {
  return { pcfHiddenValue: String(text ?? '') };
}
export function isPcfHiddenValue(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && Object.hasOwn(value, 'pcfHiddenValue'));
}
