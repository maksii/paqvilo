import { AsyncLocalStorage } from 'node:async_hooks';
export const organizationContext = new AsyncLocalStorage();
export const runOwned = fn => organizationContext.run(true, fn);

export async function runAtomic(api, fn) {
  const revision = api.changes?.current();
  const elasticSequence = api.store.elasticCommitSequence ?? 0;
  try {
    return await api.store.transact(fn, { isolated: true, cloneResult: false });
  } catch (error) {
    // The rolled-back writes' committed events must not survive in the change log (a DELETE would read as deleted).
    await api.store.flushCommittedEvents?.();
    // Standard writes roll back. Elastic writes have independent commit semantics;
    // their preserved events are flushed by the store after restoring that state.
    if ((api.store.elasticCommitSequence ?? 0) === elasticSequence) api.changes?.rewind(revision);
    throw error;
  }
}
