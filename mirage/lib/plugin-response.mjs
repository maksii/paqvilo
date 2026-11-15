import { AsyncLocalStorage } from 'node:async_hooks';
// Private SDK response handoff. Public DataStore/flow results retain
// their existing shapes, and nested SDK calls never share a response frame.
const captures = new WeakMap();
const asynchronousCaptures = new WeakMap();
const asynchronousScope = new AsyncLocalStorage();
// Populate at the main-operation boundary, even when no post observer runs.
// Later post observers may replace or remove these keys without reseeding.
export function populatePluginSystemOutputs(frame, values) {
  if (frame.systemOutputsPopulated) return;
  frame.outputParameters = { $type: 'ParameterCollection', values: { ...frame.outputParameters?.values, ...values } };
  frame.systemOutputsPopulated = true;
}
export function captureSdkResponse(store, operation, entity, execute) {
  const stack = captures.get(store) ?? [];
  if (!stack.length) captures.set(store, stack);
  const frame = { operation, entity, token: {}, results: undefined };
  stack.push(frame);
  try {
    return { value: execute(frame.token), results: frame.results };
  } finally {
    stack.pop();
    if (!stack.length) captures.delete(store);
  }
}
/** Awaited transports carry an opaque token, independent of concurrent calls
 * and the synchronous SDK stack. A completed token can never be reused. */
export async function captureSdkResponseAsync(store, operation, entity, execute) {
  const token = {},
    frame = { store, operation, entity, token, results: undefined };
  asynchronousCaptures.set(token, frame);
  try {
    const value = await asynchronousScope.run(frame, () => execute(token));
    return { value, results: frame.results };
  } finally {
    asynchronousCaptures.delete(token);
  }
}
export function handoffPluginResponse(store, operation, entity, frame, token) {
  const asynchronous = token && asynchronousCaptures.get(token),
    active =
      captures.get(store)?.at(-1) ??
      (asynchronous?.store === store && asynchronousScope.getStore() === asynchronous ? asynchronous : undefined),
    parameters = frame?.outputParameters;
  if (
    active?.operation === operation &&
    active.entity === entity &&
    token === active.token &&
    parameters?.$type === 'ParameterCollection' &&
    parameters.values &&
    typeof parameters.values === 'object' &&
    !Array.isArray(parameters.values)
  )
    active.results = structuredClone(parameters.values);
}
