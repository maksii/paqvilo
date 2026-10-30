import { AsyncLocalStorage } from 'node:async_hooks';
import { DataError } from './data-error.mjs';
import { copyPluginValueSource } from './plugin-value-provenance.mjs';

// Async callbacks retain their invocation, including after Promise.race has
// returned. A finished invocation must never re-enter the organization store.
const executions = new AsyncLocalStorage();
const storeViews = new WeakMap();
const guardedValues = new WeakMap();

// Internal SDK adapters unwrap only after checking the exposed invocation scope.
export function pluginStoreScope(value) {
  const scope = storeViews.get(value);
  scope?.assertActive();
  return scope;
}

function expired() {
  throw new DataError(
    'The plug-in execution has completed; its asynchronous continuation cannot access the organization.',
    400,
    'LocalPluginExecutionExpired',
    { innerCode: '0x80040224' },
  );
}
const closedExecution = (frame, current) =>
  frame.closed && !(frame !== current && frame.recordHook && frame.closeReason === 'completed');
function assertFrameActive(frame) {
  for (let current = frame; current; current = current.parent) if (closedExecution(current, frame)) expired();
}

function guardedScope(store, frame) {
  const memo = new WeakMap();
  const assertActive = () => assertFrameActive(frame);
  const input = (value) => {
    if (typeof value === 'function')
      return (...args) => {
        assertActive();
        const result = value(...args.map(guard));
        return result?.then
          ? result.then((answer) => guardedValues.get(answer) ?? answer)
          : (guardedValues.get(result) ?? result);
      };
    return guardedValues.get(value) ?? snapshot(value);
  };
  const guard = (value) => {
    if (!value || !['object', 'function'].includes(typeof value)) return value;
    if (memo.has(value)) return memo.get(value);
    // A separate proxy target lets frozen runtime clocks/IDs expose guarded
    // methods without violating non-configurable property invariants.
    const shadow =
      typeof value === 'function'
        ? (...args) => args
        : Array.isArray(value)
          ? []
          : Object.create(Object.getPrototypeOf(value));
    const proxy = new Proxy(shadow, {
      apply(_target, receiver, args) {
        assertActive();
        return guard(Reflect.apply(value, guardedValues.get(receiver) ?? receiver, args.map(input)));
      },
      construct(_target, args) {
        assertActive();
        return guard(Reflect.construct(value, args.map(input)));
      },
      get(_target, name) {
        assertActive();
        const member = Reflect.get(value, name, value);
        if (typeof member === 'function')
          return (...args) => {
            assertActive();
            const result = Reflect.apply(member, value, args.map(input));
            return result?.then ? result.then(guard) : guard(result);
          };
        return guard(member);
      },
      set(_target, name, member) {
        assertActive();
        return Reflect.set(value, name, input(member));
      },
      deleteProperty(_target, name) {
        assertActive();
        return Reflect.deleteProperty(value, name);
      },
      defineProperty(_target, name, descriptor) {
        assertActive();
        if (!descriptor.configurable || descriptor.writable === false || descriptor.get || descriptor.set)
          throw new DataError(
            'Exposed plug-in state requires configurable writable data properties.',
            400,
            'LocalPluginStateMutationUnsupported',
          );
        return Reflect.defineProperty(value, name, {
          ...descriptor,
          writable: true,
          ...(Object.hasOwn(descriptor, 'value') ? { value: input(descriptor.value) } : {}),
        });
      },
      getOwnPropertyDescriptor(_target, name) {
        assertActive();
        if (Array.isArray(value) && name === 'length')
          return { value: value.length, writable: true, enumerable: false, configurable: false };
        const descriptor = Reflect.getOwnPropertyDescriptor(value, name);
        return descriptor
          ? {
              ...descriptor,
              configurable: true,
              ...(Object.hasOwn(descriptor, 'value') ? { value: guard(descriptor.value) } : {}),
            }
          : descriptor;
      },
      ownKeys() {
        assertActive();
        return Reflect.ownKeys(value);
      },
      getPrototypeOf() {
        assertActive();
        return Reflect.getPrototypeOf(value);
      },
      setPrototypeOf() {
        assertActive();
        throw new DataError(
          'Exposed plug-in state requires its existing prototype; prototype replacement is unsupported.',
          400,
          'LocalPluginStateMutationUnsupported',
        );
      },
      preventExtensions() {
        assertActive();
        throw new DataError(
          'Exposed plug-in state cannot be made immutable.',
          400,
          'LocalPluginStateMutationUnsupported',
        );
      },
    });
    memo.set(value, proxy);
    copyPluginValueSource(value, proxy);
    guardedValues.set(proxy, value);
    return proxy;
  };
  const snapshot = (value, seen = new WeakMap()) => {
    value = guardedValues.get(value) ?? value;
    if (!value || typeof value !== 'object') return value;
    if (seen.has(value)) return seen.get(value);
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return structuredClone(value);
    const result = Array.isArray(value) ? [] : {};
    copyPluginValueSource(value, result);
    seen.set(value, result);
    for (const key of Object.keys(value))
      Object.defineProperty(result, key, {
        value: snapshot(value[key], seen),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    return result;
  };
  const scope = { store, assertActive, guard, snapshot };
  const view = guard(store);
  storeViews.set(view, scope);
  return { ...scope, view };
}

export function pluginInvocationDepth(store) {
  for (let frame = executions.getStore(); frame; frame = frame.parent) if (frame.store === store) return frame.depth;
  return 0;
}

export function pluginInvocationParent(store) {
  for (let frame = executions.getStore(); frame; frame = frame.parent)
    if (frame.store === store && frame.context)
      return typeof frame.context === 'function' ? frame.context() : frame.context;
  return null;
}

export function pluginExecutionLifetime(
  store,
  depth = pluginInvocationDepth(store),
  context,
  { recordHook = false } = {},
) {
  const frame = { store, parent: executions.getStore(), closed: false, depth, context, recordHook };
  let scope;
  return {
    run: (fn) => executions.run(frame, fn),
    assertActive: () => assertFrameActive(frame),
    close: (reason = 'completed') => {
      if (frame.closed) return;
      frame.closed = true;
      frame.closeReason = reason;
    },
    exposed: (api) => {
      scope ??= guardedScope(store, frame);
      return scope.guard(api);
    },
    snapshot: (value) => (scope ? scope.snapshot(value) : value),
  };
}

export function assertPluginExecutionActive(store) {
  const current = executions.getStore();
  for (let frame = current; frame; frame = frame.parent)
    if (frame.store === store && closedExecution(frame, current))
      throw new DataError(
        'The plug-in execution has completed; its asynchronous continuation cannot access the organization.',
        400,
        'LocalPluginExecutionExpired',
        {
          innerCode: '0x80040224',
        },
      );
}
