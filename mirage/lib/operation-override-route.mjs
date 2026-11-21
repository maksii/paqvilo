import { validateOperationOverrides } from './operation-catalogue.mjs';

// Why an operation cannot be configured at all, or null.
const unconfigurable = (item) => {
  if (item.configurable) return null;
  return item.kind === 'plugin-step'
    ? item.unsupported || 'This plugin registration is disabled in the export.'
    : 'This workflow has no exported portal consumer or trigger route. Add its consumer to the portal sources first.';
};

// Why a validated override cannot run for this operation, or null.
function unavailableMode(item, value) {
  if (value.mode === 'handler') {
    if (!item.registered) return 'No trusted project handler is registered for this operation.';
    return item.unsupported || null;
  }
  if (value.mode === 'clr') {
    if (!item.clrAvailable)
      return 'No explicitly trusted CLR descriptor is registered for this exact exported plugin step/type.';
    return item.unsupported || null;
  }
  if (value.mode === 'exported' && !item.definitionAvailable)
    return 'The selected sources do not include this operation definition.';
  return null;
}

// The configurable operation `key` names in the current source exports: unknown answers 404, unconfigurable 409.
function configurableItem(items, key, fail) {
  const item = items.find((item) => item.key === key);
  if (!item) throw fail('This operation is not in the current source exports.', 404);
  const refused = unconfigurable(item);
  if (refused) throw fail(refused, 409);
  return item;
}

// An invalid override answers 400, a mode the operation cannot run 409.
function checkValue(item, key, value, fail) {
  validateOperationOverrides({ [key]: value }, { pluginStep: item.kind === 'plugin-step' ? item : undefined });
  const unavailable = unavailableMode(item, value);
  if (unavailable) throw fail(unavailable, 409);
}

/**
 * The `operations` map of PATCH /_sim/api/config on both hosts replaces every override: each entry is refused exactly as
 * PATCH /_sim/api/operations/<key> refuses it, before the host applies the map.
 */
export function checkOperationOverrides(overrides, operations, fail) {
  validateOperationOverrides(overrides);
  const items = operations();
  for (const [key, value] of Object.entries(overrides ?? {}))
    checkValue(configurableItem(items, key, fail), key, value, fail);
}

/**
 * PATCH or DELETE /_sim/api/operations/<key> on both hosts (mirage/docs/operations.md): validates one operation's
 * override against the current source exports, then calls `apply(next, commit)` with the whole next override map;
 * `commit()` stores the one changed key as a transaction on the live state (`initial()` creates a missing simulator
 * section). `fail(message, status)` builds the host's error. Answers the operation list after the change.
 */
export async function changeOperationOverride({ key, method, readBody, operations, store, initial, apply, fail }) {
  const item = configurableItem(operations(), key, fail);
  let value;
  if (method !== 'DELETE') {
    value = await readBody();
    checkValue(item, key, value, fail);
  }
  const withChange = (overrides) => {
    const changed = { ...overrides };
    if (method === 'DELETE') delete changed[key];
    else changed[key] = value;
    return changed;
  };
  const commit = () =>
    store.transact(() => {
      store.state.simulator ??= initial();
      store.state.simulator.operations = withChange(store.state.simulator.operations);
    });
  await apply(withChange(store.state.simulator?.operations), commit);
  return { items: operations() };
}
