// Named deterministic recreation, deliberately without restoring an active
// runtime's arbitrary provider closures, timer callbacks or identity counter.
import { fixedClock, sequentialIds, createScheduler } from '../lib/runtime-clock.mjs';
import { inspectionBudget } from '../lib/inspection-budget.mjs';

function isolatedState(state) {
  let cloned;
  try {
    cloned = structuredClone(state);
  } catch {
    throw new TypeError('Fixture recipe state must be cloneable data, without runtime callbacks.');
  }
  const pending = [cloned],
    seen = new Set(),
    charge = inspectionBudget(1000000, 'Fixture recipe');
  while (pending.length) {
    charge();
    const value = pending.pop();
    if (!value || typeof value !== 'object' || seen.has(value)) continue;
    seen.add(value);
    if (
      value instanceof SharedArrayBuffer ||
      ((ArrayBuffer.isView(value) || value instanceof WebAssembly.Memory) && value.buffer instanceof SharedArrayBuffer)
    )
      throw new TypeError('Fixture recipe state cannot contain shared-memory buffers.');
    if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) continue;
    const children =
      value instanceof Map
        ? [...value].flat()
        : value instanceof Set
          ? [...value]
          : Object.getOwnPropertyNames(value).map((key) => value[key]);
    charge(children.length);
    for (const child of children) pending.push(child);
  }
  return cloned;
}

const plain = (value) => value && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const validName = (value) =>
  typeof value === 'string' &&
  /^[a-z0-9][a-z0-9_.-]{0,63}$/i.test(value) &&
  !['constructor', 'prototype'].includes(value);

/** Capture immutable project-owned recipe definitions; create(name) always returns a fresh, idle fixture. */
export function createFixtureRecipes(definitions) {
  if (!plain(definitions) || Object.keys(definitions).length > 100)
    throw new TypeError('Fixture recipes require a named object with at most 100 definitions.');
  const recipes = new Map();
  for (const [name, definition] of Object.entries(definitions)) {
    if (!validName(name) || !plain(definition) || !plain(definition.state))
      throw new TypeError('Each fixture recipe needs a valid name and a plain state.');
    if (
      definition.epochMs !== undefined &&
      (typeof definition.epochMs !== 'number' || !Number.isFinite(definition.epochMs))
    )
      throw new TypeError('Fixture recipe epochMs must be finite.');
    const epochMs = definition.epochMs ?? Date.UTC(2026, 0, 1);
    const namespace = definition.namespace ?? '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
    sequentialIds(namespace); // Validate the namespace without advancing a fixture's counter.
    const state = isolatedState(definition.state);
    recipes.set(name, { state, epochMs, namespace });
  }
  return Object.freeze({
    names: () => [...recipes.keys()].sort(),
    create(name) {
      const recipe = recipes.get(name);
      if (!recipe) throw new Error('Unknown fixture recipe.');
      const clock = fixedClock(recipe.epochMs),
        ids = sequentialIds(recipe.namespace);
      return { state: structuredClone(recipe.state), clock, ids, scheduler: createScheduler({ clock, manual: true }) };
    },
  });
}
