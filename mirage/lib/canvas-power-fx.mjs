// Power Fx evaluation seam. The default evaluator is Paqvilo's own interpreter (power-fx.mjs: the Learn Power Fx grammar,
// typed values, error values and the function table of power-fx-functions.mjs), so formula columns, Dataverse Functions,
// low-code plug-ins, api.fxEvaluator (the ExecuteFxExpression message in dataverse-org-messages.mjs) and canvas formulas
// evaluate for real. A trusted pack's `powerFx` export ({ evaluate | evaluateSync, check? | checkSync? }) replaces it.
// createPowerFxEvaluator({ engine: false }) is the explicitly disabled engine: it answers 501 `PowerFxNotImplemented`, and
// the Power Fx-backed custom APIs and plug-ins refuse with 501 PowerFxEvaluatorMissing.
// The synchronous members answer formula columns and api.fxEvaluator, which read synchronously; an async-only adapter is
// refused on that path.
//
// Options passed through to the engine: { symbols, values, principal, host }. host is the engine's host contract (data
// sources, variables, context, navigation and notification callbacks, clock and time zone; see power-fx.mjs). The answer
// is { value } plus the engine's { diagnostics } (delegation warnings) when it gives them.
import { DataError } from './data-error.mjs';
import { packCheck, registerPackExport } from './pack-exports.mjs';
import { powerFxEngine } from './power-fx.mjs';

const notImplemented = () => new DataError('Power Fx evaluation is disabled; enable the engine or register a pack powerFx adapter.', 501, 'PowerFxNotImplemented');
const asyncAdapter = () => new DataError('Power Fx adapter answered asynchronously; a synchronous adapter is required for this path.', 501, 'PowerFxAsyncAdapter');
const isAsync = fn => fn?.constructor?.name === 'AsyncFunction';
const isThenable = value => value !== null && typeof value === 'object' && typeof value.then === 'function';
const shaped = result => {
  if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'value')) throw new DataError('The powerFx adapter must return { value }.', 500, 'PowerFxAdapterInvalid');
  return Array.isArray(result.diagnostics) && result.diagnostics.length ? { value: result.value, diagnostics: result.diagnostics } : { value: result.value };
};
// A synchronous answer. A promise is refused; it is detached so that its rejection is not reported as unhandled.
const syncAnswer = result => {
  if (!isThenable(result)) return result;
  Promise.resolve(result).catch(() => {});
  throw asyncAdapter();
};

export const notImplementedPowerFx = Object.freeze({
  check: () => ({ ok: false, diagnostics: [{ code: 'POWERFX_NOT_IMPLEMENTED', message: 'Power Fx checking is disabled; enable the engine or register a pack powerFx adapter.' }] }),
  checkSync: () => { throw notImplemented(); },
  evaluate: () => { throw notImplemented(); },
  evaluateSync: () => { throw notImplemented(); },
});

/** Shape check for the pack `powerFx` export: `evaluate` or `evaluateSync` (one required); `check` and `checkSync` optional. */
export function validatePowerFxAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object') throw new TypeError('powerFx adapter must be an object with an evaluate or evaluateSync function.');
  if (typeof adapter.evaluate !== 'function' && typeof adapter.evaluateSync !== 'function') throw new TypeError('powerFx.evaluate or powerFx.evaluateSync must be a function.');
  for (const member of ['evaluate', 'evaluateSync', 'check', 'checkSync'])
    if (adapter[member] !== undefined && typeof adapter[member] !== 'function') throw new TypeError(`powerFx.${member} must be a function when present.`);
  return adapter;
}

/**
 * The runtime's Power Fx evaluator: a pack adapter when one is given, else the core engine, else (engine: false) the
 * disabled answer. `registered` is true for a pack adapter; `available` is true when any engine answers; `source` is
 * 'adapter', 'core' or 'disabled'.
 */
export function createPowerFxEvaluator({ adapter, engine = true } = {}) {
  const registered = adapter !== undefined;
  const source = registered ? 'adapter' : engine === false ? 'disabled' : 'core';
  const active = registered ? validatePowerFxAdapter(adapter) : source === 'core' ? powerFxEngine : notImplementedPowerFx;
  const available = source !== 'disabled';
  const expressionText = expression => {
    if (typeof expression !== 'string' || !expression.trim()) throw new DataError('A Power Fx expression is required.', 400, 'PowerFxExpressionRequired');
    return expression;
  };
  // The engine's options: host only when given, so an adapter sees exactly { symbols, values, principal } otherwise.
  const optionsOf = ({ symbols = {}, values = {}, principal = null, host } = {}) => ({ symbols, values, principal, ...(host ? { host } : {}) });
  const hasSyncEvaluate = available && (typeof active.evaluateSync === 'function' || (typeof active.evaluate === 'function' && !isAsync(active.evaluate)));
  const hasSyncCheck = available && (typeof active.checkSync === 'function' || (typeof active.check === 'function' && !isAsync(active.check)));
  // A synchronous member answers directly. Without an evaluateSync, a non-async evaluate is called; an async one is never
  // called on this path (its promise cannot be read synchronously), it is refused with PowerFxAsyncAdapter.
  const evaluateSync = (expression, options = {}) => {
    const args = [expressionText(expression), optionsOf(options)];
    if (typeof active.evaluateSync === 'function') return shaped(syncAnswer(active.evaluateSync(...args)));
    if (typeof active.evaluate === 'function') {
      if (isAsync(active.evaluate)) throw asyncAdapter();
      return shaped(syncAnswer(active.evaluate(...args)));
    }
    throw notImplemented();
  };
  const checkSync = (expression, { symbols = {}, host } = {}) => {
    const args = [expressionText(expression), { symbols, ...(host ? { host } : {}) }];
    if (typeof active.checkSync === 'function') return syncAnswer(active.checkSync(...args));
    if (typeof active.check === 'function') {
      if (isAsync(active.check)) throw asyncAdapter();
      return syncAnswer(active.check(...args));
    }
    throw notImplemented();
  };
  const level = (ok) => (available && ok ? 'behaviour' : 'contract');
  return {
    registered,
    available,
    source,
    evaluateSync,
    checkSync,
    async check(expression, { symbols = {}, host } = {}) {
      if (typeof active.check === 'function') return active.check(expressionText(expression), { symbols, ...(host ? { host } : {}) });
      if (typeof active.checkSync === 'function') return checkSync(expression, { symbols, host });
      return { ok: false, diagnostics: [{ code: 'POWERFX_CHECK_NOT_IMPLEMENTED', message: 'The registered powerFx adapter has no check function.' }] };
    },
    async evaluate(expression, options = {}) {
      if (typeof active.evaluate === 'function') return shaped(await active.evaluate(expressionText(expression), optionsOf(options)));
      return evaluateSync(expression, options);
    },
    describe: () => ({ name: 'power-fx', version: 1, kind: 'provider', level: level(true), source,
      operations: [
        { name: 'evaluate', level: level(true) },
        { name: 'evaluateSync', level: level(hasSyncEvaluate) },
        { name: 'check', level: level(typeof active.check === 'function' || typeof active.checkSync === 'function') },
        { name: 'checkSync', level: level(hasSyncCheck) },
      ],
      requires: available ? [] : ['adapter:powerFx'], principal: 'caller', stateOwner: 'none', lifecycle: 'stateless' }),
  };
}

// One adapter per runtime: two packs exporting powerFx collide on the key 'adapter'.
registerPackExport('powerFx', { kind: 'value', entries: (adapter) => [['adapter', adapter]], check: packCheck(validatePowerFxAdapter) });
