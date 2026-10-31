import { AsyncLocalStorage } from 'node:async_hooks';
// The store is `true` (legacy owned flag) or a request context (request-context.mjs). A context owns the host change slot
// only when its inBatch flag is set, so plain request contexts still queue their writes.
export const organizationContext = new AsyncLocalStorage();
const owning = (value) =>
  value && typeof value === 'object' ? (value.inBatch ? value : value.with({ inBatch: true })) : true;
/** Runs fn as the owner of the host change slot ($batch, local administration), keeping the request context. */
export const runOwned = (fn) => organizationContext.run(owning(organizationContext.getStore()), fn);
/** True inside runOwned: a record write must not enter the host change queue again. */
export const ownsChange = () => {
  const value = organizationContext.getStore();
  return value === true || value?.inBatch === true;
};

/** pluginVisible false: the boundary is the request's own, invisible to IsInTransaction (data.mjs transact). */
export async function runAtomic(api, fn, { pluginVisible = true } = {}) {
  const revision = api.changes?.current();
  const elasticSequence = api.store.elasticCommitSequence ?? 0;
  try {
    return await api.store.transact(fn, { isolated: true, cloneResult: false, pluginVisible });
  } catch (error) {
    // The rolled-back writes' committed events must not survive in the change log (a DELETE would read as deleted).
    await api.store.flushCommittedEvents?.();
    // Standard writes roll back. Elastic writes have independent commit semantics;
    // their preserved events are flushed by the store after restoring that state.
    if ((api.store.elasticCommitSequence ?? 0) === elasticSequence) api.changes?.rewind(revision);
    throw error;
  }
}
