// Private synchronous SDK response handoff. Public DataStore/flow results retain
// their existing shapes, and nested SDK calls never share a response frame.
const captures = new WeakMap();
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
export function handoffPluginResponse(store, operation, entity, frame, token) {
  const active = captures.get(store)?.at(-1),
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
