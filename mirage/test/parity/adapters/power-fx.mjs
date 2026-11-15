// Adapter for the power-fx surface: recorded formula and host -> Mirage Power Fx interpreter -> the oracle's recorded shape.
// Only `input` drives Mirage. `input.host` is the host context the oracle ran with (culture, timeZone, clock, numberIsFloat,
// random, values); `input.hostFunctions` are the host functions it supplied. `input.result` describes the row shape the
// producer recorded for the corpus. It is constant within a suite:
//   fields     the keys the producer recorded for each row (order is not significant)
//   check      'none': no Check phase. 'phase': a failed Check records phase 'check', success false and diagnostics.
//              'compile-error': a failed Check records kind 'compile-error', errors [{Message, severity}] and messages.
//   valueForm  'json': a value is its JSON form (a Decimal is a number). 'typed': a Decimal is {kind, text}, a boolean
//              {kind, value}, a string {kind, value}; an error value is nested as {kind: 'error', errors}.
//   errorForm  'errors': an error row carries value null and errors [{kind: name, Message}]; a value row carries errors null.
//              'message': an error row carries kind and message, and no value. 'typed': an error row carries value
//              {kind: 'error', errors: [{kind, kindName, Message}]} and no top-level errors. 'none': an error throws.
// Host keys: culture, timeZone, numberIsFloat, clock or fixedClock (the same frozen instant), random and values are
// applied. parseCulture, dontFakeMonotonic, allowsSideEffects, mutationFunctions, setDefinitions, freshEnginePerCase and
// explicitPredeclaredVariables are recorded for the reader, not applied: a result that depends on one of them shows up
// as a declared gap in known-gaps/power-fx.json.
// Field rules (a field with no rule for the row is omitted, a field name without a rule throws):
//   expression, phase ('evaluation'), success, diagnostics, type or valueType, kind ('value' or 'error'), value,
//   errors, message (first error), errorKind and errorKindName (first error), valueKind, length and valueSha256 (of a
//   string value), calls (host function calls), clockReads (host clock reads), messages (check messages, failed Check).
// Mirage's values are reached through evaluateFx and powerFxEngine.checkSync; the conversions below are the same for
// every case, so they are the one place where a Mirage value becomes an oracle value.
import { createHash } from 'node:crypto';
import { ErrorKind, FxDate, FxError, FxFloat, evaluateFx, fromFx, powerFxEngine } from '../../../lib/power-fx.mjs';
import { decimalParts, decimalText, isExactNumeric } from '../../../lib/exact-numeric.mjs';
import { TIME_ZONE_IDS } from '../../../lib/platform-time-zones.mjs';

const CHECK_MODES = ['none', 'phase', 'compile-error'];
const VALUE_FORMS = ['json', 'typed'];
const ERROR_FORMS = ['errors', 'message', 'typed', 'none'];
// Fields that describe an evaluation; a failed Check records none of them.
const EVALUATION_FIELDS = new Set([
  'value',
  'type',
  'valueType',
  'errorKind',
  'errorKindName',
  'message',
  'valueKind',
  'length',
  'valueSha256',
]);
// Fields that only a failed Check of the compile-error kind records.
const COMPILE_ERROR_ONLY = new Set(['kind', 'errors', 'messages']);

const kindName = (number) => Object.keys(ErrorKind).find((name) => ErrorKind[name] === number) ?? String(number);
const zoneOf = (name) => TIME_ZONE_IDS.find(([, windows]) => windows === name)?.[2] ?? name;
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

function hostOf(input) {
  const host = input.host ?? {};
  const counts = { clockReads: 0, touchCalls: 0 };
  const built = {};
  if (host.culture !== undefined) built.language = host.culture;
  if (host.timeZone !== undefined) built.timeZone = zoneOf(host.timeZone);
  if (host.numberIsFloat !== undefined) built.numberIsFloat = host.numberIsFloat;
  const clock = host.clock ?? host.fixedClock;
  if (clock !== undefined) {
    const fixed = clock === 'system-current' ? undefined : Date.parse(clock);
    built.now = () => {
      counts.clockReads += 1;
      return fixed ?? Date.now();
    };
  }
  if (host.random !== undefined) built.random = () => host.random;
  const functions = Object.entries(input.hostFunctions ?? {});
  if (functions.length > 0) {
    built.functions = Object.fromEntries(
      functions.map(([name, spec]) => [
        name,
        () => {
          counts.touchCalls += 1;
          return spec.returns;
        },
      ]),
    );
  }
  return { built, counts, values: host.values ?? {} };
}

// The recorded shape of a value: a float is a JS number, an exact numeric is a Decimal. The oracle serialises a
// date-only value as midnight ISO; Mirage holds the date part alone, so the same rule applies to every date value.
function jsonOf(value, fx) {
  if (value instanceof FxFloat) return value.value;
  if (isExactNumeric(value)) return Number(value.value);
  if (value instanceof FxDate && value.kind === 'date') return `${fromFx(value, fx)}T00:00:00`;
  return fromFx(value, fx);
}

function typedOf(value, fx) {
  if (isExactNumeric(value)) return { kind: 'decimal', text: decimalText(decimalParts(value)) };
  if (typeof value === 'boolean') return { kind: 'boolean', value };
  if (typeof value === 'string') return { kind: 'string', value };
  return jsonOf(value, fx);
}

function typeOf(value) {
  if (value instanceof FxError) return 'ErrorValue';
  if (typeof value === 'string') return 'StringValue';
  if (typeof value === 'boolean') return 'BooleanValue';
  if (typeof value === 'number' || value instanceof FxFloat) return 'NumberValue';
  if (isExactNumeric(value)) return 'DecimalValue';
  if (value instanceof FxDate) return { date: 'DateValue', time: 'TimeValue' }[value.kind] ?? 'DateTimeValue';
  if (Array.isArray(value)) return 'TableValue';
  throw new Error(`no Power Fx type name for ${String(value)}`);
}

const errorsOf = (error) => error.errors.map((item) => ({ kind: kindName(item.Kind), Message: item.Message }));
const typedErrorsOf = (error) =>
  error.errors.map((item) => ({ kind: item.Kind, kindName: kindName(item.Kind), Message: item.Message }));
const diagnosticsOf = (fx) => (fx.warnings ?? []).map((warning) => ({ message: String(warning?.message ?? warning) }));
const checkDiagnosticOf = (item) =>
  item.severity === undefined ? { message: item.message } : { message: item.message, severity: item.severity };

function describe(spec) {
  if (!spec || !Array.isArray(spec.fields)) throw new Error('power-fx input.result must list the recorded fields');
  if (!CHECK_MODES.includes(spec.check))
    throw new Error(`power-fx input.result.check ${spec.check} is not a check mode`);
  if (!VALUE_FORMS.includes(spec.valueForm))
    throw new Error(`power-fx input.result.valueForm ${spec.valueForm} is unknown`);
  if (!ERROR_FORMS.includes(spec.errorForm))
    throw new Error(`power-fx input.result.errorForm ${spec.errorForm} is unknown`);
  return spec;
}

const unknownField = (field) => new Error(`power-fx projection has no rule for recorded field ${field}`);

// A failed Check: the recorded row carries the check phase only. No evaluation ran, so the counters are zero.
function failedRow(expression, spec, diagnostics) {
  const out = {};
  for (const field of spec.fields) {
    if (field === 'expression') out.expression = expression;
    else if (field === 'phase') out.phase = 'check';
    else if (field === 'success') out.success = false;
    else if (field === 'diagnostics') out.diagnostics = diagnostics.map(checkDiagnosticOf);
    else if (field === 'kind' && spec.check === 'compile-error') out.kind = 'compile-error';
    else if (field === 'errors' && spec.check === 'compile-error') {
      out.errors = diagnostics.map((item) => ({
        Message: item.message,
        ...(item.severity === undefined ? {} : { severity: item.severity }),
      }));
    } else if (field === 'messages' && spec.check === 'compile-error')
      out.messages = diagnostics.map((item) => item.message);
    else if (field === 'calls' || field === 'clockReads') out[field] = 0;
    else if (!COMPILE_ERROR_ONLY.has(field) && !EVALUATION_FIELDS.has(field)) throw unknownField(field);
  }
  return out;
}

function evaluatedRow(expression, spec, host, { value, fx }) {
  const error = value instanceof FxError;
  if (error && spec.errorForm === 'none') {
    throw new Error(`formula raised ${value.errors[0].Kind}: ${value.errors[0].Message}`);
  }
  const first = error ? value.errors[0] : null;
  const out = {};
  for (const field of spec.fields) {
    switch (field) {
      case 'expression':
        out.expression = expression;
        break;
      case 'phase':
        out.phase = 'evaluation';
        break;
      case 'success':
        out.success = !error;
        break;
      case 'diagnostics':
        out.diagnostics = error ? [] : diagnosticsOf(fx);
        break;
      case 'type':
      case 'valueType':
        out[field] = error ? 'ErrorValue' : typeOf(value);
        break;
      case 'kind':
        out.kind = error ? 'error' : 'value';
        break;
      case 'value':
        if (!error) out.value = spec.valueForm === 'typed' ? typedOf(value, fx) : jsonOf(value, fx);
        else if (spec.errorForm === 'errors') out.value = null;
        else if (spec.errorForm === 'typed') out.value = { kind: 'error', errors: typedErrorsOf(value) };
        break;
      case 'errors':
        if (spec.errorForm === 'errors') out.errors = error ? errorsOf(value) : null;
        break;
      case 'message':
        if (error) out.message = first.Message;
        break;
      case 'errorKind':
        if (error) out.errorKind = first.Kind;
        break;
      case 'errorKindName':
        if (error) out.errorKindName = kindName(first.Kind);
        break;
      case 'valueKind':
        if (typeof value === 'string') out.valueKind = 'string';
        break;
      case 'length':
        if (typeof value === 'string') out.length = value.length;
        break;
      case 'valueSha256':
        if (typeof value === 'string') out.valueSha256 = sha256(value);
        break;
      case 'calls':
        out.calls = host.counts.touchCalls;
        break;
      case 'clockReads':
        out.clockReads = host.counts.clockReads;
        break;
      case 'messages':
        break;
      default:
        throw unknownField(field);
    }
  }
  return out;
}

/**
 * Evaluates the recorded formula with the recorded host and answers the row in the producer's recorded shape.
 * @param {object} input recorded input of one case: { expression, host?, hostFunctions?, result }
 * @returns {Promise<object>} the oracle's recorded result shape
 */
export default async function run(input) {
  const spec = describe(input.result);
  const host = hostOf(input);
  if (spec.check !== 'none') {
    const check = powerFxEngine.checkSync(input.expression, { host: host.built });
    if (!check.ok) return failedRow(input.expression, spec, check.diagnostics);
  }
  return evaluatedRow(
    input.expression,
    spec,
    host,
    evaluateFx(input.expression, { values: host.values, host: host.built }),
  );
}
