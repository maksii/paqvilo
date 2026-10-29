// Test-only ownership: acquire a single after hook before registering resources.
// Shared fixture builders receive the same TestContext and therefore the same owner.
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

const owners = new WeakMap();

/** Remove drained fixture state while Windows retires an already-closed browser handle. */
export function removeFixtureDirectory(directory) {
  return fs.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const fail = (errors, message) => {
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, message);
};

/** Drain a late-bound resource collection without skipping later owners after failure. */
export async function drainFixture(callbacks, { concurrent = false } = {}) {
  const errors = [];
  if (concurrent) {
    const results = await Promise.allSettled(callbacks.map(async (callback) => callback()));
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
  } else {
    for (const callback of callbacks) {
      try {
        await callback();
      } catch (error) {
        errors.push(error);
      }
    }
  }
  fail(errors, 'Owned fixture resource collection failed to close.');
}

export function ownedFixture(context) {
  const existing = owners.get(context);
  if (existing) return existing;
  if (!context || typeof context.after !== 'function') throw new TypeError('An owned fixture needs a test context.');
  const closers = [],
    removers = [];
  let closing = false;
  const register = (list, callback) => {
    if (closing) throw new Error('Fixture cleanup has already started.');
    if (typeof callback !== 'function') throw new TypeError('Fixture cleanup must be a function.');
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
    fail(errors, 'Owned fixture resources failed to close.');
    // State and evidence directories are retained when resource draining fails.
    for (const remove of removers) {
      try {
        await remove();
      } catch (error) {
        errors.push(error);
      }
    }
    fail(errors, 'Owned fixture directories failed to be removed.');
  });
  owners.set(context, owner);
  return owner;
}

/**
 * Create an owned workspace at its physical path, preserving the caller's complete prefix. The parent is created too:
 * a fresh CI checkout has no ignored state folders such as .paqvilo/.
 */
export async function makeTemporaryDirectory(prefix) {
  await fs.mkdir(path.dirname(prefix), { recursive: true });
  return fs.realpath(await fs.mkdtemp(prefix));
}

/** Synchronous physical workspace creation for fixtures that initialize before test registration. */
export function makeTemporaryDirectorySync(prefix) {
  fsSync.mkdirSync(path.dirname(prefix), { recursive: true });
  return fsSync.realpathSync.native(fsSync.mkdtempSync(prefix));
}

/** Assert an owned workspace's physical containment before returning its safe deletion target. */
export async function assertTemporaryDirectory(directory, { parent = os.tmpdir(), directChild = false } = {}) {
  const [physicalParent, physicalDirectory] = await Promise.all([fs.realpath(parent), fs.realpath(directory)]);
  const relative = path.relative(physicalParent, physicalDirectory);
  assert.ok(
    relative && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative),
    'Fixture directory must be strictly inside its owned temporary parent.',
  );
  if (directChild)
    assert.equal(path.dirname(relative), '.', 'Fixture directory must be a direct child of its temporary parent.');
  return physicalDirectory;
}
