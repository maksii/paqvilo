import { types } from 'node:util';
import fs from 'node:fs';
import { pagedRecordsOf, RecordPageSession } from './record-tables.mjs';

const references = new WeakMap();
const put = (object, key, value) =>
  Object.defineProperty(object, key, { value, enumerable: true, configurable: true, writable: true });
const pathOf = (frame) => {
  const path = [];
  for (let current = frame; current.parent; current = current.parent) path.push(current.key);
  return path.reverse();
};

/* NOSONAR */ function enterReferenceFrame(frame, { directory, ownerKey, refs, active }) {
  frame.entered = true;
  const table = pagedRecordsOf(frame.source);
  if (table) {
    let target = directory;
    if (directory)
      try {
        target = fs.realpathSync.native(directory);
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
    if ((directory && table.session.directory !== target) || (ownerKey && table.session.ownerKey !== ownerKey))
      throw Object.assign(
        new Error(
          "Record table belongs to a different local storage; use this store's record context or a detached snapshot",
        ),
        { code: 'InvalidRecordStorage', status: 400 },
      );
    refs.push({ path: pathOf(frame), table: table.session.describe(frame.source) });
    frame.result = null;
    frame.done = true;
  } else if (!frame.source || typeof frame.source !== 'object' || types.isProxy(frame.source)) frame.done = true;
  else {
    if (active.has(frame.source)) throw TypeError('Cannot persist circular state');
    active.add(frame.source);
    frame.keys = Object.keys(frame.source);
    frame.index = 0;
  }
}

function copyReferenceParent(parent) {
  const result = Array.isArray(parent.source)
    ? new Array(parent.source.length)
    : Object.create(Object.getPrototypeOf(parent.source));
  for (const key of Reflect.ownKeys(parent.source)) {
    if (Array.isArray(parent.source) && key === 'length') continue;
    const descriptor = Object.getOwnPropertyDescriptor(parent.source, key);
    Object.defineProperty(result, key, {
      ...descriptor,
      configurable: true,
      ...(Object.hasOwn(descriptor, 'value') ? { writable: true } : {}),
    });
  }
  return result;
}

function propagateCompletedReference(frame, active) {
  active.delete(frame.source);
  const value = Object.hasOwn(frame, 'result') ? frame.result : frame.source;
  if (!frame.parent) return { root: true, value };
  if (value === frame.source) return { root: false };
  const parent = frame.parent;
  if (!Object.hasOwn(parent, 'result')) parent.result = copyReferenceParent(parent);
  put(parent.result, frame.key, value);
  return { root: false };
}

function pushNextReferenceFrame(frame, stack) {
  if (frame.done || frame.index >= frame.keys.length) return false;
  const key = frame.keys[frame.index++],
    descriptor = Object.getOwnPropertyDescriptor(frame.source, key);
  // Accessors/toJSON retain ordinary serializer behavior. Explicit record
  // streams are data properties; never invoke an unrelated getter here.
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) return true;
  if (Array.isArray(frame.source) && !/^(0|[1-9]\d*)$/.test(key)) return true;
  stack.push({ source: descriptor.value, parent: frame, key });
  return true;
}

// References live in the journal operation envelope, outside user state. This
// avoids reserving/escaping any business JSON property or marker-shaped value.
export function encodeRecordReferences(entry, { directory, ownerKey } = {}) {
  const refs = [],
    active = new Set(),
    stack = [{ source: entry, parent: null }];
  let result = entry;
  while (stack.length) {
    const frame = stack.at(-1);
    if (!frame.entered) {
      enterReferenceFrame(frame, { directory, ownerKey, refs, active });
    }
    if (pushNextReferenceFrame(frame, stack)) continue;
    stack.pop();
    const completed = propagateCompletedReference(frame, active);
    if (completed.root) result = completed.value;
  }
  return refs.length ? { ...result, recordRefs: refs } : result;
}

/** Decode placeholders only after the journal operation JSON has parsed. File
 * verification waits until a committed state has survived checksum recovery. */
export function decodeRecordReferences(entry) {
  if (!Object.hasOwn(entry, 'recordRefs')) return entry;
  if (!Array.isArray(entry.recordRefs)) throw new Error('Invalid record reference manifest');
  const seen = new Set();
  for (const reference of entry.recordRefs) {
    if (
      !Array.isArray(reference?.path) ||
      !reference.path.length ||
      reference.path.some((key) => typeof key !== 'string') ||
      !['row', 'value'].includes(reference.path[0])
    )
      throw new Error('Invalid record reference path');
    const path = reference.path,
      identity = JSON.stringify(path);
    if (seen.has(identity)) throw new Error('Duplicate record reference');
    seen.add(identity);
    let parent = entry;
    for (const key of path.slice(0, -1)) {
      const descriptor = parent && typeof parent === 'object' && Object.getOwnPropertyDescriptor(parent, key);
      if (
        !descriptor ||
        !Object.hasOwn(descriptor, 'value') ||
        !descriptor.value ||
        typeof descriptor.value !== 'object'
      )
        throw new Error('Missing record reference parent');
      parent = descriptor.value;
    }
    const key = path.at(-1),
      descriptor = Object.getOwnPropertyDescriptor(parent, key);
    if (descriptor?.value !== null) throw new Error('Record reference must replace its null placeholder');
    const placeholder = {};
    references.set(placeholder, reference.table);
    put(parent, key, placeholder);
  }
  return entry;
}

export async function restoreRecordReferences(state, directory, options) {
  const sites = [],
    pending = [{ value: state, parent: null }],
    seen = new Set();
  while (pending.length) {
    const site = pending.pop(),
      value = site.value;
    if (!value || typeof value !== 'object') continue;
    const descriptor = references.get(value);
    if (descriptor) {
      sites.push({ ...site, descriptor });
      continue;
    }
    if (seen.has(value)) continue;
    seen.add(value);
    for (const key of Object.keys(value)) pending.push({ value: value[key], parent: value, key });
  }
  if (!sites.length) return { state, session: null };
  // Stored descriptors name the random owner key of their directory. Those
  // written before keys existed verify against its files instead.
  const owners = new Set(sites.map((site) => site.descriptor?.owner).filter((owner) => owner !== undefined));
  if (owners.size > 1) throw new Error('Record directory belongs to a different state');
  const [ownerKey] = owners;
  const session = new RecordPageSession(
    directory,
    ownerKey === undefined ? { ...options, adoptOwner: true } : { ...options, ownerKey },
  );
  try {
    const tables = await session.restoreMany(sites.map((site) => site.descriptor));
    sites.forEach((site, index) => {
      if (site.parent) put(site.parent, site.key, tables[index]);
      else state = tables[index];
    });
    return { state, session };
  } catch (error) {
    session.close();
    throw error;
  }
}
