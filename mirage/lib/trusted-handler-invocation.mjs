import { cloneStateData } from './state-clone.mjs';
import { pluginExecutionLifetime, pluginInvocationDepth } from './plugin-execution-lifetime.mjs';

/** Passive request information must never alias a graph captured before the
 * invocation's transaction. Only API capabilities and an already-live working
 * target row retain access to the store, fenced by this invocation's lifetime. */
export async function invokeTrustedHandler(api, handler, information, { trace, workingTarget = false } = {}) {
  const store = api.store;
  store?.ensureReadSnapshot?.();
  // Registry-only fixtures can invoke a data-only handler without a DataStore.
  const execution = pluginExecutionLifetime(store ?? {}, pluginInvocationDepth(store));
  const context = cloneStateData(information);
  if (workingTarget && information.target?.row) {
    const { logicalName, id, row } = information.target;
    const mapping = store.resolveMapping(logicalName);
    const rows = store.tableRows(mapping.logicalName);
    const current = rows[store.rowIndex(mapping, rows, id, { partitionId: row.partitionid })];
    if (current === row) context.target.row = execution.exposed(current);
  }
  context.api = execution.exposed(api);
  if (trace) context.trace = execution.exposed(trace);
  try {
    return await execution.run(async () => execution.snapshot(await handler(context)));
  } finally {
    execution.close();
  }
}
