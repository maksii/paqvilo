// Exact locations inside a JSON or YAML document that a rule reads as plain objects. The text is parsed again as a
// syntax tree only when a finding needs a location; values always come from the rule's own parse.
import YAML from 'yaml';

const keyOf = (pair) => String(YAML.isScalar(pair.key) ? pair.key.value : pair.key);
const loose = (key) => String(key).toLowerCase().replace(/^@/, '');

// An alias stands for the anchored node it names, so a value reached through it (or through a merge key) is located
// at that node's own position.
const anchored = (node, document) => (YAML.isAlias(node) ? node.resolve(document) : node);

// Queues the syntax nodes of a parsed object's members, each paired with the value they produced.
function queueMembers(node, data, pending) {
  if (YAML.isMap(node) && !Array.isArray(data)) {
    const last = new Map(node.items.map((pair) => [keyOf(pair), pair]));
    for (const [key, pair] of last) if (Object.hasOwn(data, key)) pending.push([pair.value, data[key]]);
  } else if (YAML.isSeq(node) && Array.isArray(data))
    node.items.forEach((item, position) => pending.push([item, data[position]]));
}

/**
 * `at(owner, key)` for `value` parsed from `entry.text`: a source at the value of member `key` of the parsed object
 * `owner` (an array index for an array), at `owner` itself when the member is absent or `key` is omitted, or the
 * entry's approximate anchor when `owner` is not part of this document (for example JSON decoded from a string).
 */
export function structuredLocator(entry, value) {
  const approximate = { ...entry, exactLocation: false };
  let nodes, counter;
  const index = () => {
    nodes = new WeakMap();
    counter = new YAML.LineCounter();
    const document = YAML.parseDocument(entry.text, { lineCounter: counter, uniqueKeys: false });
    if (document.errors.length) return;
    const pending = [[document.contents, value]];
    for (let count = 0; pending.length && count < 100000; count++) {
      const [item, data] = pending.pop();
      // A value already placed keeps its node, so an alias cycle in the data ends here.
      if (data === null || typeof data !== 'object' || nodes.has(data)) continue;
      const node = anchored(item, document);
      if (!node) continue;
      nodes.set(data, node);
      queueMembers(node, data, pending);
    }
  };
  return (owner, key) => {
    if (owner === null || typeof owner !== 'object') return approximate;
    if (!nodes) index();
    const node = nodes.get(owner);
    if (!node) return approximate;
    let member;
    if (YAML.isMap(node) && key !== undefined)
      member =
        node.items.findLast((pair) => keyOf(pair) === String(key)) ??
        node.items.findLast((pair) => loose(keyOf(pair)) === loose(key));
    else if (YAML.isSeq(node) && Number.isInteger(key)) member = { value: node.items[key] };
    const offset = (member?.value ?? node)?.range?.[0];
    if (offset === undefined) return approximate;
    const { line, col } = counter.linePos(offset);
    return { ...entry, line, column: col, exactLocation: true };
  };
}
