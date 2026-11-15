// Composite (string key, immutable record locator) ordering retains
// duplicate keys without an unbounded token list inside one leaf.
import { compareKeyPair as compare } from './record-key-sort.mjs';
function lowerBound(list, value, select = (item) => item) {
  let low = 0,
    high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compare(select(list[mid]), value) < 0) low = mid + 1;
    else high = mid;
  }
  return low;
}
const pairOf = (key, token) => {
  if (typeof key !== 'string' || !Number.isSafeInteger(token) || token <= 0)
    throw TypeError('Invalid string key or row token');
  return [key, token];
};
const validated = new WeakMap();
function validateSummaryEntry(node, entry, previous) {
  const min = node.leaf ? entry : entry.min,
    max = node.leaf ? entry : entry.max;
  if (!Array.isArray(min) || min.length !== 2 || !Array.isArray(max) || max.length !== 2)
    throw new Error('Invalid key-tree bounds');
  pairOf(...min);
  pairOf(...max);
  if (
    compare(min, max) > 0 ||
    (previous && compare(previous, min) >= 0) ||
    (!node.leaf &&
      (!Number.isSafeInteger(entry.id) || entry.id <= 0 || !Number.isSafeInteger(entry.size) || entry.size <= 0))
  )
    throw new Error('Invalid key-tree order or child');
  return { min, max };
}
// Bounds, size and child depth of a structurally valid node.
function summarize(node) {
  const entries = node?.leaf ? node.pairs : node?.children;
  if (!Array.isArray(entries) || !entries.length) throw new Error('Invalid key-tree node');
  const childDepth = node.leaf ? undefined : entries[0]?.depth;
  if (!node.leaf && (!Number.isInteger(childDepth) || entries.some((child) => child.depth !== childDepth)))
    throw new Error('Invalid key-tree child depth');
  let previous,
    size = 0;
  for (const entry of entries) {
    const { max } = validateSummaryEntry(node, entry, previous);
    previous = max;
    size += node.leaf ? 1 : entry.size;
  }
  return {
    leaf: Boolean(node.leaf),
    entries: entries.length,
    childDepth,
    min: node.leaf ? entries[0] : entries[0].min,
    max: node.leaf ? entries.at(-1) : entries.at(-1).max,
    size,
  };
}

function removeKeyTreeLeaf(tree, ref, node, pair, minimum, writes) {
  const position = lowerBound(node.pairs, pair);
  if (position === node.pairs.length || compare(node.pairs[position], pair)) return { ref, changed: false };
  const pairs = [...node.pairs];
  pairs.splice(position, 1);
  return { ref: tree.write({ leaf: true, pairs }, writes), changed: true, under: pairs.length < minimum };
}

function rebalanceKeyTreeChildren(tree, children, position, result, writes) {
  if (!result.ref || !result.under || children.length <= 1) return;
  const leftIndex = position > 0 ? position - 1 : 0;
  const left = tree.node(children[leftIndex]),
    right = tree.node(children[leftIndex + 1]);
  if (left.leaf !== right.leaf) throw new Error('Unbalanced key-tree siblings');
  const values = [...(left.leaf ? left.pairs : left.children), ...(right.leaf ? right.pairs : right.children)];
  const replacements = tree.split(
    left.leaf ? { leaf: true, pairs: values } : { leaf: false, children: values },
    writes,
  );
  children.splice(leftIndex, 2, ...replacements);
}

function removeKeyTreeNode(tree, ref, pair, minimum, writes) {
  if (!ref || compare(pair, ref.min) < 0 || compare(pair, ref.max) > 0) return { ref, changed: false };
  const node = tree.node(ref);
  if (node.leaf) return removeKeyTreeLeaf(tree, ref, node, pair, minimum, writes);
  const position = lowerBound(node.children, pair, (child) => child.max);
  if (position === node.children.length) return { ref, changed: false };
  const result = removeKeyTreeNode(tree, node.children[position], pair, minimum, writes);
  if (!result.changed) return { ref, changed: false };
  const children = [...node.children];
  if (result.ref) children[position] = result.ref;
  else children.splice(position, 1);
  rebalanceKeyTreeChildren(tree, children, position, result, writes);
  return { ref: tree.write({ leaf: false, children }, writes), changed: true, under: children.length < minimum };
}

export class PersistentKeyTree {
  constructor(store, { root = null, files = [], capacity = 256 } = {}) {
    if (!Number.isInteger(capacity) || capacity < 4 || capacity > 512 || capacity % 2)
      throw RangeError('Invalid key-tree capacity');
    this.store = store;
    this.root = root;
    this.files = new Set(files);
    this.capacity = capacity;
  }
  node(ref) {
    if (!ref || !Number.isInteger(ref.depth) || ref.depth < 0 || ref.depth > 32)
      throw new Error('Invalid key-tree depth');
    const node = this.store.read(ref.id);
    // A node is structurally validated once; each visit checks it against its reference.
    let summary = validated.get(node);
    if (!summary) {
      summary = summarize(node);
      validated.set(node, summary);
    }
    if (summary.entries > this.capacity || summary.leaf !== (ref.depth === 0)) throw new Error('Invalid key-tree node');
    if (!summary.leaf && summary.childDepth !== ref.depth - 1) throw new Error('Invalid key-tree child depth');
    if (
      !Array.isArray(ref.min) ||
      !Array.isArray(ref.max) ||
      compare(ref.min, summary.min) ||
      compare(ref.max, summary.max) ||
      ref.size !== summary.size
    )
      throw new Error('Key-tree reference disagrees with node');
    return node;
  }
  write(node, writes) {
    const entries = node.leaf ? node.pairs : node.children;
    if (!entries.length) return null;
    const id = this.store.write(node);
    const file = this.store.fileOf?.(id);
    if (file !== undefined) writes.add(file);
    return {
      id,
      depth: node.leaf ? 0 : entries[0].depth + 1,
      min: node.leaf ? entries[0] : entries[0].min,
      max: node.leaf ? entries.at(-1) : entries.at(-1).max,
      size: node.leaf ? entries.length : entries.reduce((sum, child) => sum + child.size, 0),
    };
  }
  split(node, writes) {
    const values = node.leaf ? node.pairs : node.children;
    if (values.length <= this.capacity) return [this.write(node, writes)];
    const mid = Math.floor(values.length / 2);
    return [0, mid].map((start, index) =>
      this.write(
        node.leaf
          ? { leaf: true, pairs: values.slice(start, index ? undefined : mid) }
          : { leaf: false, children: values.slice(start, index ? undefined : mid) },
        writes,
      ),
    );
  }
  insert(key, token) {
    const pair = pairOf(key, token),
      writes = new Set();
    const insert = (ref) => {
      if (!ref) return [this.write({ leaf: true, pairs: [pair] }, writes)];
      const node = this.node(ref);
      if (node.leaf) {
        const position = lowerBound(node.pairs, pair);
        if (position < node.pairs.length && compare(node.pairs[position], pair) === 0) return [ref];
        const pairs = [...node.pairs];
        pairs.splice(position, 0, pair);
        return this.split({ leaf: true, pairs }, writes);
      }
      let position = lowerBound(node.children, pair, (child) => child.max);
      if (position === node.children.length) position--;
      const changed = insert(node.children[position]);
      if (changed.length === 1 && changed[0] === node.children[position]) return [ref];
      const children = [...node.children];
      children.splice(position, 1, ...changed);
      return this.split({ leaf: false, children }, writes);
    };
    const result = insert(this.root);
    const root = result.length === 1 ? result[0] : this.write({ leaf: false, children: result }, writes);
    this.root = root;
    for (const file of writes) this.files.add(file);
  }
  delete(key, token) {
    const pair = pairOf(key, token),
      writes = new Set(),
      minimum = this.capacity / 2;
    const remove = (ref) => removeKeyTreeNode(this, ref, pair, minimum, writes);
    let result = remove(this.root);
    if (!result.changed) return false;
    while (result.ref?.depth > 0) {
      const node = this.node(result.ref);
      if (node.children.length !== 1) break;
      result = { ...result, ref: node.children[0] };
    }
    this.root = result.ref;
    for (const file of writes) this.files.add(file);
    if (!this.root) this.files.clear();
    return true;
  }
  lookup(key) {
    if (typeof key !== 'string') throw TypeError('A key lookup requires a string');
    const found = [];
    const visit = (ref) => {
      if (!ref || key < ref.min[0] || key > ref.max[0]) return;
      const node = this.node(ref);
      if (node.leaf) {
        for (let i = lowerBound(node.pairs, [key, 0]); i < node.pairs.length && node.pairs[i][0] === key; i++)
          found.push(node.pairs[i][1]);
      } else for (const child of node.children) if (child.min[0] <= key && child.max[0] >= key) visit(child);
    };
    visit(this.root);
    return found;
  }
  *entries() {
    const store = this; // NOSONAR: this is used inside a nested non-arrow function
    function* visit(ref) {
      if (!ref) return;
      const node = store.node(ref);
      if (node.leaf) yield* node.pairs;
      else for (const child of node.children) yield* visit(child);
    }
    yield* visit(this.root);
  }
  fork() {
    return new PersistentKeyTree(this.store, { root: this.root, files: this.files, capacity: this.capacity });
  }
  static *buildSorted(store, pairs, { capacity = 256 } = {}) {
    const tree = new PersistentKeyTree(store, { capacity }),
      writes = new Set(),
      leaves = [];
    let pending = [],
      previous;
    for (const [key, token] of pairs) {
      const pair = pairOf(key, token);
      if (isOutOfOrder(previous, pair)) throw new Error('Key bulk input is not sorted');
      if (isDuplicatePair(previous, pair)) continue;
      pending.push(pair);
      previous = pair;
      if (pending.length === capacity) {
        leaves.push(tree.write({ leaf: true, pairs: pending }, writes));
        pending = [];
        yield;
      }
    }
    finishBulkLeaves(tree, pending, leaves, writes, capacity);
    let level = leaves;
    while (level.length > 1) {
      const next = [];
      const groups = Math.ceil(level.length / capacity),
        size = Math.floor(level.length / groups),
        extra = level.length % groups;
      let at = 0;
      for (let group = 0; group < groups; group++) {
        const count = size + Number(group < extra);
        next.push(tree.write({ leaf: false, children: level.slice(at, at + count) }, writes));
        at += count;
        yield;
      }
      level = next;
    }
    tree.root = level[0] ?? null;
    tree.files = writes;
    return tree;
  }
  static fromSorted(store, pairs, options) {
    const iterator = this.buildSorted(store, pairs, options);
    for (;;) {
      const step = iterator.next();
      if (step.done) return step.value;
    }
  }
  static async fromSortedAsync(store, pairs, { yieldWork = async () => {}, ...options } = {}) {
    const iterator = this.buildSorted(store, pairs, options);
    try {
      for (;;) {
        const step = iterator.next();
        if (step.done) return step.value;
        await yieldWork();
      }
    } finally {
      iterator.return?.();
    }
  }
}

const isOutOfOrder = (previous, pair) => previous && compare(previous, pair) > 0;
const isDuplicatePair = (previous, pair) => previous && compare(previous, pair) === 0;
const needsLeafRebalance = (pending, capacity, leaves) => pending.length < capacity / 2 && leaves.length;

function finishBulkLeaves(tree, pending, leaves, writes, capacity) {
  if (!pending.length) return leaves;
  if (needsLeafRebalance(pending, capacity, leaves)) {
    const previous = tree.node(leaves.pop()),
      combined = [...previous.pairs, ...pending],
      mid = Math.floor(combined.length / 2);
    leaves.push(
      tree.write({ leaf: true, pairs: combined.slice(0, mid) }, writes),
      tree.write({ leaf: true, pairs: combined.slice(mid) }, writes),
    );
  } else leaves.push(tree.write({ leaf: true, pairs: pending }, writes));
  return leaves;
}
