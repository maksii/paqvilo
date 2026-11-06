// Trusted pack mutations share portal authorization and the organization pipeline.
import { createHash } from 'node:crypto';
import { portalRecordWrites } from './form-service.mjs';
import { isElastic } from './dataverse-elastic.mjs';

const fail = (message, status = 400, code = 'PackWriteRefused') => Object.assign(new Error(message), { status, code });
const keyOf = (entity, operation, id) => JSON.stringify([entity, operation, id ?? null]);
const supported = new Set(['create', 'update', 'delete']);
// Normalize to the JSON wire contract before committing. A generic deep clone
// would preserve Dates/non-finite numbers and skip toJSON, unlike the response.
function wireValue(value) {
  const serialized = JSON.stringify(value ?? null);
  return JSON.parse(serialized);
}
const digest = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

function requestReceipt(endpoint, context, body, store) {
  const token = context.req.headers['idempotency-key'];
  if (token !== undefined && (typeof token !== 'string' || !/^[\w.-]{1,128}$/.test(token)))
    throw fail('Invalid idempotency key.');
  const scope = digest([endpoint.packId, endpoint.id, context.identity.contactId ?? context.identity.id, token]);
  const inputDigest = digest([context.req.method, context.url.pathname, context.url.search, body]);
  const saved = token && store.state.simulator?.packEndpointReceipts?.[scope];
  if (saved && saved.inputDigest !== inputDigest)
    throw fail('Idempotency key was used for another request.', 409, 'IdempotencyConflict');
  return { token, scope, inputDigest, saved };
}

function targetRow(store, mapping, declaration, id, receipt) {
  if (declaration.operation === 'create') return declaration.values ?? {};
  if (typeof id !== 'string' || !id) throw fail('A record target requires an id.');
  const row = store.findByKey(mapping, id);
  if (row) return row;
  // A duplicate committed delete has no current row. Reauthorize its retained
  // preimage against current permissions before returning the original receipt.
  const key = keyOf(mapping.logicalName, declaration.operation, id);
  const saved = declaration.operation === 'delete' && receipt.saved?.deleted?.find((entry) => entry.key === key);
  if (!saved) throw fail('Record not found.', 404, 'NotFound');
  return saved.row;
}

async function authorizeTargets(endpoint, context, body, store, receipt) {
  const declarations = await endpoint.writes({
    body: wireValue(body),
    match: [...context.match],
    identity: wireValue(context.identity),
  });
  if (!Array.isArray(declarations) || !declarations.length || declarations.length > 100)
    throw fail('Pack writes must declare 1 to 100 permission-scoped targets.');
  const targets = new Map();
  for (const declaration of declarations) {
    if (!supported.has(declaration?.operation)) throw fail('Unsupported pack write operation.');
    const mapping = store.resolveMapping(declaration.entity);
    if (isElastic(mapping) || mapping.isVirtual || mapping.dataProviderId)
      throw fail('Atomic pack writes require local standard tables.', 409);
    const id = declaration.operation === 'create' ? null : declaration.id;
    const row = targetRow(store, mapping, declaration, id, receipt);
    store.assertAllowed(mapping.logicalName, declaration.operation, row, context.identity);
    const key = keyOf(mapping.logicalName, declaration.operation, id);
    if (targets.has(key)) throw fail('Duplicate pack write declaration.');
    targets.set(key, { ...declaration, mapping, row: declaration.operation === 'delete' ? wireValue(row) : row });
  }
  return targets;
}

function createWriteUnit({ store, context, targets, assertLocal }) {
  const writer = portalRecordWrites(store, { portalRequest: true });
  let active = true,
    entered = false,
    count = 0,
    failure;
  const pending = [];
  const poison = (cause) => {
    failure ??= { cause };
  };
  const apply = (operation, entity, id, values) => {
    if (operation === 'create') return writer.create(entity, values, context.identity);
    if (operation === 'update') return writer.update(entity, id, values, context.identity);
    return writer.remove(entity, id, context.identity);
  };
  const write = (operation, entity, id, values) => {
    try {
      if (!active || !entered) throw fail('Pack write capability has expired.', 409);
      assertLocal();
      const mapping = store.resolveMapping(entity);
      const target = targets.get(keyOf(mapping.logicalName, operation, id));
      if (!target) throw fail('Undeclared pack write target.', 403);
      if (++count > 100) throw fail('Pack write operation limit exceeded.', 413);
      const result = Promise.resolve().then(async () => {
        const row = await apply(operation, entity, id, values);
        // Internal pipeline rows are privileged mutable state. A write grants
        // no read capability: acknowledge its key and use scoped read for data.
        return { [mapping.idColumn]: wireValue((operation === 'delete' ? target.row : row)[mapping.idColumn]) };
      });
      pending.push(result);
      result.catch(poison);
      return result;
    } catch (cause) {
      poison(cause);
      throw cause;
    }
  };
  const records = Object.freeze({
    create: (entity, values) => write('create', entity, null, values),
    update: (entity, id, values) => write('update', entity, id, values),
    remove: (entity, id) => write('delete', entity, id),
    read: context.read,
  });
  return {
    async transaction(work) {
      try {
        if (entered || !active || typeof work !== 'function') throw fail('Use one pack transaction per request.');
        entered = true;
        return await work(records);
      } catch (cause) {
        poison(cause);
        throw cause;
      } finally {
        active = false;
      }
    },
    async finish() {
      active = false;
      await Promise.allSettled(pending);
      if (failure) throw failure.cause ?? fail('Pack transaction failed.', 500);
    },
  };
}

async function runHandler(endpoint, context, body, unit) {
  try {
    return await endpoint.handle({
      url: context.url,
      match: context.match,
      mode: 'local',
      identity: wireValue(context.identity),
      body: wireValue(body),
      read: context.read,
      error: context.error,
      transaction: unit.transaction,
    });
  } finally {
    await unit.finish();
  }
}

function saveReceipt(store, receipt, result, targets) {
  if (!receipt.token) return;
  store.state.simulator ??= {};
  const saved = (store.state.simulator.packEndpointReceipts ??= {});
  const deleted = [...targets]
    .filter(([, target]) => target.operation === 'delete')
    .map(([key, target]) => ({ key, row: target.row }));
  const entry = { inputDigest: receipt.inputDigest, result, deleted };
  if (Buffer.byteLength(JSON.stringify(entry)) > 1024 * 1024) throw fail('Pack write receipt exceeds 1 MiB.', 413);
  saved[receipt.scope] = entry;
  for (const key of Object.keys(saved).slice(0, Math.max(0, Object.keys(saved).length - 128))) delete saved[key];
}

/** All checks, handler work and receipt publication execute inside the host's atomic write slot. */
export async function invokePackMutation({ endpoint, context, body, store, atomic, local }) {
  const assertLocal = () => {
    if (!local()) throw fail('Pack writes require local providers.', 409, 'LocalRuntimeRequired');
  };
  assertLocal();
  return atomic(async () => {
    assertLocal();
    const receipt = requestReceipt(endpoint, context, body, store);
    const targets = await authorizeTargets(endpoint, context, body, store, receipt);
    if (receipt.saved) return wireValue(receipt.saved.result);
    for (const target of targets.values()) store.assertPrecondition(target.mapping, target.row, target);
    const unit = createWriteUnit({ store, context, targets, assertLocal });
    const result = wireValue(await runHandler(endpoint, context, body, unit));
    if (Buffer.byteLength(JSON.stringify(result)) > 1024 * 1024) throw fail('Pack write result exceeds 1 MiB.', 413);
    saveReceipt(store, receipt, result, targets);
    return result;
  });
}
