// Test-only ownership: acquire a single after hook before registering resources.
// Shared fixture builders receive the same TestContext and therefore the same owner.
const owners = new WeakMap();

const fail = (errors, message) => {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
};

/** Drain a late-bound resource collection without skipping later owners after failure. */
export async function drainFixture(callbacks, { concurrent = false } = {}) {
  const errors = [];
  if (concurrent) {
    const results = await Promise.allSettled(
      callbacks.map(async (callback) => callback()),
    );
    for (const result of results)
      if (result.status === "rejected") errors.push(result.reason);
  } else {
    for (const callback of callbacks) {
      try {
        await callback();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  fail(errors, "Owned fixture resource collection failed to close.");
}

export function ownedFixture(context) {
  const existing = owners.get(context);
  if (existing) return existing;
  if (!context || typeof context.after !== "function")
    throw new TypeError("An owned fixture needs a test context.");
  const closers = [],
    removers = [];
  let closing = false;
  const register = (list, callback) => {
    if (closing) throw new Error("Fixture cleanup has already started.");
    if (typeof callback !== "function")
      throw new TypeError("Fixture cleanup must be a function.");
    list.push(callback);
  };
  const owner = Object.freeze({
    add: (callback) => register(closers, callback),
    remove: (callback) => register(removers, callback),
  });
  context.after(async () => {
    closing = true;
    const errors = [];
    // Preserve registration order and attempt every close, including after one fails.
    for (const close of closers) {
      try {
        await close();
      } catch (error) {
        errors.push(error);
      }
    }
    fail(errors, "Owned fixture resources failed to close.");
    // State and evidence directories are retained when resource draining fails.
    for (const remove of removers) {
      try {
        await remove();
      } catch (error) {
        errors.push(error);
      }
    }
    fail(errors, "Owned fixture directories failed to be removed.");
  });
  owners.set(context, owner);
  return owner;
}
