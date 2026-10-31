import { AsyncLocalStorage } from 'node:async_hooks';

const operations = new AsyncLocalStorage();
const defaults = new WeakMap();

export const storeOperationFields = [
  'pluginInTransaction',
  'pluginRollbackBoundary',
  'pluginReadOnly',
  'pluginParentContext',
  'pluginExecutionUserId',
  'pluginSdkTag',
  'pluginRequestId',
  'rowTransaction',
  'committedEventCandidates',
  'flowChain',
  'pluginODataChangeset',
];

const active = (store) => {
  for (let frame = operations.getStore(); frame; frame = frame.parent)
    if (frame.store === store && !frame.closed) return frame;
  return null;
};
const values = (store) => {
  const frame = active(store);
  if (frame) return frame.values;
  if (!defaults.has(store)) defaults.set(store, {});
  return defaults.get(store);
};

export const hasStoreOperationContext = (store) => Boolean(active(store));
export const storeOperationValue = (store, name) => values(store)[name];
export const setStoreOperationValue = (store, name, value) => {
  values(store)[name] = value;
};

/** Each operation owns its mutable pipeline capabilities. A nested SDK call
 * joins its caller; a queued transaction opens a fresh child after its turn
 * starts. Closed asynchronous ancestors never supply a later request's state. */
export function withStoreOperationContext(store, fn, { fresh = false } = {}) {
  if (!fresh && active(store)) return fn();
  const frame = { store, parent: operations.getStore(), values: { ...values(store) }, closed: false };
  let result;
  try {
    result = operations.run(frame, fn);
    if (typeof result?.then === 'function')
      return Promise.resolve(result).finally(() => {
        frame.closed = true;
      });
    return result;
  } catch (error) {
    frame.closed = true;
    throw error;
  } finally {
    if (typeof result?.then !== 'function') frame.closed = true;
  }
}
