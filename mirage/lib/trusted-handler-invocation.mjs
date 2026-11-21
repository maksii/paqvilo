import { cloneStateData } from './state-clone.mjs';
import { pluginExecutionLifetime, pluginInvocationDepth } from './plugin-execution-lifetime.mjs';

/** How long an invocation waits for its handler: the time a plug-in may run. */
const TRUSTED_HANDLER_LIMIT_MS = 120_000;

/** Passive request information must never alias a graph captured before the
 * invocation's transaction. Only API capabilities and an already-live working
 * target row retain access to the store, fenced by this invocation's lifetime.
 * A handler (`label` names it) that has not settled within the limit ends its invocation with 504: the invocation
 * stops waiting, and its closed lifetime refuses what the handler does through the API afterwards. */
export async function invokeTrustedHandler(
  api,
  handler,
  information,
  {
    trace,
    workingTarget = false,
    label = 'A data pack handler',
    limitMs = TRUSTED_HANDLER_LIMIT_MS,
    clock = globalThis,
  } = {},
) {
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
  let timer;
  const expired = new Promise((_resolve, reject) => {
    timer = clock.setTimeout(
      () =>
        reject(
          Object.assign(
            new Error(
              `${label} did not answer within ${Math.round(limitMs / 1000)} s. A handler must return or throw; its invocation has ended.`,
            ),
            { status: 504, code: 'PackHandlerTimeout' },
          ),
        ),
      limitMs,
    );
    timer?.unref?.();
  });
  try {
    const pending = execution.run(async () => execution.snapshot(await handler(context)));
    // The handler may still reject after its invocation ended: that rejection has no invocation left to report it.
    pending.catch(() => {});
    return await Promise.race([pending, expired]);
  } finally {
    clock.clearTimeout(timer);
    execution.close();
  }
}
