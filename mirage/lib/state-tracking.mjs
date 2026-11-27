/**
 * Copy-on-handout rollback backups of a store's state (DataStore#transact).
 *
 * A transaction whose callback may write anything used to copy the whole state first. The state is mostly
 * tables and table metadata (`state.tables`, `state.mappings`), and a transaction reaches few of them. While
 * such a transaction runs, the members of those two containers are accessor properties: the first time a
 * member is handed out (read or replaced) since the transaction began, every open backup that does not hold
 * it yet receives a copy of it, taken before the caller can change it. A backup opened later first copies the
 * members already handed out, because references to them may be held. A member never handed out cannot have
 * changed, so a backup shares it with the live state instead of copying it.
 *
 * What this relies on: a member is changed only through a reference obtained from the container after the
 * transaction began, or through the store's row operations (which hand the table out first). A row, table or
 * mapping changed in place through a reference kept from before the transaction is not seen. So only a transaction
 * that asks for it (`tracked`) or journals its rows is tracked; any other still copies the whole state first.
 *
 * The containers are plain data again as soon as the transaction's callback and commit stagers finished, so
 * persistence never meets an accessor. Code that walks a whole graph meanwhile (clone, compare, digest) reads
 * through `untracked`, which neither hands members out nor meets accessors.
 */

import { types } from 'node:util';

/**
 * Self-check for tests: with `verify` set, every tracker also keeps whole copies (of the state when it starts, and
 * when each backup opens) and, when it is released, fails unless every member never handed out is unchanged and
 * every backup equals its whole copy. It costs what the tracking saves, so nothing enables it outside tests.
 */
export const stateTrackingChecks = { verify: false };

// Installed containers only: container -> Tracked.
const trackedContainers = new WeakMap();
let installed = 0;

const define = (target, key, value) =>
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });

const plainContainer = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/**
 * A member assigned as a plain property before it was ever handed out: each open backup that shares the replaced
 * value keeps it, unchanged since nothing handed it out.
 */
function keepReplaced(tracked, name) {
  const previous = tracked.values.get(name);
  for (const part of tracked.parts) if (part.names.has(name) && !part.copies.has(name)) part.copies.set(name, previous);
}

/** One container (`state.tables` or `state.mappings`) while its members are accessors. */
class Tracked {
  constructor(container, { clone, count }) {
    this.container = container;
    this.clone = clone;
    this.count = count;
    // The current value of every member that is, or was, an accessor. A deleted member keeps its last value: an
    // open backup may still share it.
    this.values = new Map();
    this.getters = new Map();
    this.handed = new Set();
    this.parts = new Set();
  }
  /** False when a member is not an ordinary data property: the container is then left as it is. */
  install() {
    const names = Object.keys(this.container);
    for (const name of names) {
      const descriptor = Object.getOwnPropertyDescriptor(this.container, name);
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.writable || !descriptor.configurable)
        return false;
    }
    for (const name of names) this.accessor(name, this.container[name]);
    trackedContainers.set(this.container, this);
    installed += 1;
    return true;
  }
  accessor(name, value) {
    this.values.set(name, value);
    let get = this.getters.get(name);
    if (!get) {
      get = () => {
        if (!this.handed.has(name)) this.hand(name);
        return this.values.get(name);
      };
      this.getters.set(name, get);
    }
    Object.defineProperty(this.container, name, {
      enumerable: true,
      configurable: true,
      get,
      set: (value) => {
        if (!this.handed.has(name)) this.hand(name);
        this.values.set(name, value);
      },
    });
  }
  /** The first handout of a member: every open backup without it receives one shared copy. */
  hand(name) {
    this.handed.add(name);
    let copy;
    for (const part of this.parts) {
      if (part.copies.has(name) || !part.names.has(name)) continue;
      copy ??= this.copy(this.values.get(name));
      part.copies.set(name, copy);
    }
  }
  copy(value) {
    this.count?.(value);
    return this.clone(value);
  }
  /**
   * Members assigned as new properties (a table created by `tables.x = []`, or deleted and assigned again) are plain
   * data until this adopts them. Such a member counts as handed out: it was read and written without the accessor.
   * A backup that shared the replaced value keeps that value, unchanged since nothing handed it out.
   */
  sync() {
    for (const name of Object.keys(this.container)) {
      const descriptor = Object.getOwnPropertyDescriptor(this.container, name);
      if (descriptor.get && descriptor.get === this.getters.get(name)) continue;
      if (!Object.hasOwn(descriptor, 'value')) continue; // a foreign accessor: read through it, never copied lazily
      if (this.values.has(name) && !this.handed.has(name)) keepReplaced(this, name);
      this.handed.add(name);
      if (descriptor.configurable && descriptor.writable) this.accessor(name, descriptor.value);
      else this.values.set(name, descriptor.value);
    }
  }
  /** The current value of a member, without handing it out. */
  current(name) {
    const descriptor = Object.getOwnPropertyDescriptor(this.container, name);
    if (!descriptor) return undefined;
    if (descriptor.get && descriptor.get === this.getters.get(name)) return this.values.get(name);
    return Object.hasOwn(descriptor, 'value') ? descriptor.value : this.container[name];
  }
  /** A plain object of the current members, without handing any out. */
  plain() {
    const result = {};
    for (const name of Object.keys(this.container)) define(result, name, this.current(name));
    return result;
  }
  /** Opens a backup of this container as it is now. */
  part() {
    this.sync();
    const keys = Object.keys(this.container),
      part = { tracked: this, keys, names: new Set(keys), copies: new Map(), shared: null };
    for (const name of keys) if (this.handed.has(name)) part.copies.set(name, this.copy(this.values.get(name)));
    this.parts.add(part);
    return part;
  }
  /** Ends the tracking: open backups keep what they share, and the members are plain data again. */
  release() {
    for (const part of this.parts) {
      part.shared = new Map();
      for (const name of part.keys) if (!part.copies.has(name)) part.shared.set(name, this.values.get(name));
    }
    this.parts.clear();
    for (const name of Object.keys(this.container)) {
      const descriptor = Object.getOwnPropertyDescriptor(this.container, name);
      if (descriptor.get && descriptor.get === this.getters.get(name))
        define(this.container, name, this.values.get(name));
    }
    trackedContainers.delete(this.container);
    installed -= 1;
  }
}

// The value a backup part holds for `name`: its copy, else the member it shares with the live state.
const partValue = (part, name) => {
  if (part.copies.has(name)) return { value: part.copies.get(name), copied: true };
  return { value: part.shared ? part.shared.get(name) : part.tracked.values.get(name), copied: false };
};
// The container as the part recorded it; copies are cloned (`fresh`) so the backup can be restored again.
const partContainer = (part, fresh) => {
  const result = {};
  for (const name of part.keys) {
    const { value, copied } = partValue(part, name);
    define(result, name, copied && fresh ? fresh(value) : value);
  }
  return result;
};
const partEquals = (part, container, equal) => {
  const tracked = trackedContainers.get(container);
  if (tracked !== part.tracked && (tracked || part.shared === null || container !== part.tracked.container))
    return equal(untracked(container), partContainer(part, null));
  if (tracked) tracked.sync();
  const names = Object.keys(container);
  if (names.length !== part.keys.length) return false;
  for (const name of names) {
    if (!part.names.has(name)) return false;
    const { value, copied } = partValue(part, name),
      current = tracked ? tracked.current(name) : container[name];
    // A member no transaction reached is unchanged; one assigned anew under the same name is compared.
    if (copied || current !== value ? !equal(current, value) : false) return false;
  }
  return true;
};

const CONTAINERS = ['tables', 'mappings'];

/** The names of the members of a tracked `tables` container that differ from what `part` recorded. */
function changedMembers(part, tables, equal) {
  const tracked = trackedContainers.get(tables);
  if (tracked) tracked.sync();
  const changed = new Set();
  for (const name of Object.keys(tables)) {
    if (!part.names.has(name)) {
      changed.add(name);
      continue;
    }
    const { value, copied } = partValue(part, name),
      current = tracked ? tracked.current(name) : tables[name];
    if ((copied || current !== value) && !equal(current, value)) changed.add(name);
  }
  for (const name of part.keys) if (!Object.hasOwn(tables, name)) changed.add(name);
  return changed;
}

/**
 * The state as it was when the backup was opened. `restore()` builds a new state object: members a transaction
 * reached are copies, the others are the live members (unchanged). A backup can be restored more than once.
 */
export class LazyBackup {
  constructor(state, sections, parts, { clone, equal }) {
    this.order = Object.keys(state);
    this.sections = sections;
    this.parts = parts;
    this.clone = clone;
    this.equal = equal;
    this.closed = false;
  }
  #build(fresh) {
    const sections = fresh ? fresh(this.sections) : this.sections,
      result = {};
    for (const key of this.order)
      define(result, key, this.parts.has(key) ? partContainer(this.parts.get(key), fresh) : sections[key]);
    return result;
  }
  #open() {
    if (this.closed) throw new Error('State tracking: a closed backup is used');
  }
  restore() {
    this.#open();
    return this.#build(this.clone);
  }
  /** The same state without copying: its members are the backup's own and the live ones, to read only. */
  view() {
    this.#open();
    return this.#build(null);
  }
  equals(state) {
    this.#open();
    const names = Object.keys(state);
    if (names.length !== this.order.length) return false;
    const rest = {};
    for (const name of names) {
      if (!this.order.includes(name)) return false;
      if (this.parts.has(name)) {
        if (!partEquals(this.parts.get(name), state[name], this.equal)) return false;
      } else define(rest, name, state[name]);
    }
    return this.equal(rest, this.sections);
  }
  /**
   * The tables that may differ from the backup, for a commit that names what it changed: a table the transaction
   * reached is compared with its copy, a table it never reached is unchanged. null when anything else differs
   * (a section, a mapping, the set of sections) or the tables are no longer the tracked container. The row version
   * counter alone advances with every row write and names no table.
   */
  changedTables(state) {
    this.#open();
    const names = Object.keys(state),
      part = this.parts.get('tables');
    if (!part || names.length !== this.order.length || state.tables !== part.tracked.container) return null;
    const rest = {};
    for (const name of names) {
      if (!this.order.includes(name)) return null;
      if (name === 'tables' || name === 'rowVersion') continue;
      if (!this.parts.has(name)) define(rest, name, state[name]);
      else if (!partEquals(this.parts.get(name), state[name], this.equal)) return null;
    }
    const { rowVersion, ...sections } = this.sections;
    if (!this.equal(rest, sections)) return null;
    return changedMembers(part, state.tables, this.equal);
  }
  /**
   * Stops collecting copies, for a backup no boundary refers to any more; it is never restored, viewed or compared
   * again. A replaced rollback point that a commit still reads (persistenceBackup) is not closed.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    for (const part of this.parts.values()) part.tracked.parts.delete(part);
  }
}

/** The tracking of one state object for one transaction. */
export class StateTracker {
  // [container key, member name, current value] of every member that existed at the start and was never handed out.
  #unreached() {
    const result = [];
    for (const [key, entry] of this.tracked)
      for (const [name, value] of entry.values)
        if (!entry.handed.has(name) && Object.hasOwn(this.checks.start[key] ?? {}, name))
          result.push([key, name, value]);
    return result;
  }
  /** null when the state's containers cannot be tracked (the caller then copies the state, as before). */
  static install(state, { clone, equal, count = null }) {
    const tracked = new Map();
    for (const key of CONTAINERS) {
      const container = Object.getOwnPropertyDescriptor(state, key)?.value;
      if (!plainContainer(container) || trackedContainers.has(container)) continue;
      const entry = new Tracked(container, { clone, count: count ? (value) => count(key, value) : null });
      if (entry.install()) tracked.set(key, entry);
    }
    if (!tracked.size) return null;
    const tracker = new StateTracker(state, tracked, { clone, equal });
    if (stateTrackingChecks.verify) tracker.checks = { start: clone(untracked(state)), backups: [] };
    return tracker;
  }
  constructor(state, tracked, options) {
    this.state = state;
    this.tracked = tracked;
    this.options = options;
    this.released = false;
  }
  /** True while `state` still holds the containers this tracker installed. */
  covers(state) {
    if (this.released || state !== this.state) return false;
    for (const [key, entry] of this.tracked) if (state[key] !== entry.container) return false;
    return true;
  }
  /** A backup of the state as it is now, or null when the state no longer holds the tracked containers. */
  backup() {
    if (!this.covers(this.state)) return null;
    const rest = {};
    for (const key of Object.keys(this.state)) if (!this.tracked.has(key)) define(rest, key, this.state[key]);
    const parts = new Map();
    for (const [key, entry] of this.tracked) parts.set(key, entry.part());
    const backup = new LazyBackup(this.state, this.options.clone(rest), parts, this.options);
    this.checks?.backups.push([backup, this.options.clone(untracked(this.state))]);
    return backup;
  }
  /** Hands a member out without reading it: a row operation is about to write the table, whoever holds its rows. */
  reach(key, name) {
    const entry = this.tracked.get(key);
    if (entry && !this.released && entry.values.has(name) && !entry.handed.has(name)) entry.hand(name);
  }
  /** A backup of one tracked container alone (`key`), or null. */
  part(key) {
    const entry = this.tracked.get(key);
    return !this.released && entry && this.state[key] === entry.container ? entry.part() : null;
  }
  release() {
    if (this.released) return;
    this.released = true;
    const unreached = this.checks ? this.#unreached() : null;
    for (const entry of this.tracked.values()) entry.release();
    if (!this.checks) return;
    const { equal } = this.options;
    for (const [key, name, value] of unreached)
      if (!equal(value, this.checks.start[key]?.[name]))
        throw new Error(`State tracking: ${key}.${name} changed without being handed out`);
    for (const [backup, whole] of this.checks.backups)
      if (!backup.closed && !equal(backup.view(), whole))
        throw new Error('State tracking: a backup differs from the whole copy');
  }
}

export { partContainer, partEquals };

/** One member of a tracked container without handing it out (no open backup copies it); a plain read otherwise. */
export function untrackedMember(container, name) {
  const tracked = installed ? trackedContainers.get(container) : undefined;
  return tracked ? tracked.current(name) : container?.[name];
}

/** The members of a tracked container as [name, value] pairs, without handing any out; plain entries otherwise. */
export function untrackedEntries(container) {
  const tracked = installed ? trackedContainers.get(container) : undefined;
  if (!tracked) return Object.entries(container);
  return Object.keys(container).map((name) => [name, tracked.current(name)]);
}

/**
 * `value` for code that only reads it: a tracked container, or an object holding one as `tables` or `mappings`,
 * becomes a plain object of the same members. Reading it hands nothing out. Any other value is returned as it is.
 */
export function untracked(value) {
  if (!installed || value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const tracked = trackedContainers.get(value);
  if (tracked) return tracked.plain();
  let copy = null;
  for (const key of CONTAINERS) {
    const member = Object.getOwnPropertyDescriptor(value, key)?.value,
      entry = member && typeof member === 'object' ? trackedContainers.get(member) : undefined;
    if (!entry) continue;
    copy ??= ownMembersCopy(value);
    define(copy, key, entry.plain());
  }
  return copy ?? value;
}

/** A plain object of `value`'s own members, each read once: an accessor is read here, as a clone would read it. */
function ownMembersCopy(value) {
  const copy = {};
  for (const name of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    define(copy, name, Object.hasOwn(descriptor, 'value') ? descriptor.value : value[name]);
  }
  return copy;
}

const sameOrder = (names, keys) => names.length === keys.length && names.every((name, index) => name === keys[index]);

/**
 * Restores the live `container` to what `part` recorded, keeping the container and every member no transaction
 * reached. `restoreMember(current, saved)` (a savepoint inside a running pipeline) restores a copied member in place,
 * so references held to it stay valid; without it the member is replaced by a fresh copy.
 */
export function restorePartInPlace(part, container, { fresh, restoreMember = null }) {
  const tracked = trackedContainers.get(container);
  if (tracked) tracked.sync();
  const current = (name) => (tracked ? tracked.current(name) : container[name]);
  for (const name of Object.keys(container)) if (!part.names.has(name)) delete container[name];
  for (const name of part.keys) {
    const { value, copied } = partValue(part, name),
      present = Object.hasOwn(container, name);
    if (!copied) {
      if (!present || current(name) !== value) container[name] = value;
    } else if (restoreMember && present) container[name] = restoreMember(container[name], value);
    else container[name] = fresh(value);
  }
  if (sameOrder(Object.keys(container), part.keys)) return;
  restoreMemberOrder(part, container, tracked);
}

/** A member removed and restored would otherwise move to the end: the members are put back in the recorded order. */
function restoreMemberOrder(part, container, tracked) {
  if (tracked) tracked.sync();
  const current = (name) => (tracked ? tracked.current(name) : container[name]);
  const values = part.keys.map((name) => current(name));
  for (const name of part.keys) delete container[name];
  part.keys.forEach((name, index) => {
    if (tracked) tracked.accessor(name, values[index]);
    else define(container, name, values[index]);
  });
}

/**
 * The container `part` recorded, built for a detached copy of the state (`copy`: the copied container as it is
 * now): a member no transaction reached is taken from that copy, so the result shares nothing with the live state.
 */
export function restorePartOnto(part, copy, fresh) {
  const result = {};
  for (const name of part.keys) {
    const { value, copied } = partValue(part, name);
    define(result, name, copied || !copy || !Object.hasOwn(copy, name) ? fresh(value) : copy[name]);
  }
  return result;
}
