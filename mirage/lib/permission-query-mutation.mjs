import { DataError } from './data-error.mjs';
import { parseXmlDocument } from './fetchxml-engine.mjs';

// A retained join keeps the compiler's privilege only when its complete binding
// (including its parent bindings) is unchanged. Ordinals are rebuilt after a
// trusted step removes redundant generated trees; stale ordinals are never used.
export function rebindPermissionQuery(original, source) {
  if (!original.permissionLinkCount || source === original.xml) return original;
  const links = (xml) => {
    const result = [];
    const visit = (node, parents = []) => {
      let path = parents;
      if (node.name === 'link-entity') {
        path = [...parents, Object.fromEntries(Object.entries(node.attrs).sort(([a], [b]) => a.localeCompare(b)))];
        result.push({ key: JSON.stringify(path), alias: node.attrs.alias });
      }
      for (const child of node.children ?? []) visit(child, path);
    };
    visit(parseXmlDocument(xml));
    return result;
  };
  const before = links(original.xml),
    after = links(source),
    generated = new Set(original.generatedLinkOrdinals ?? []);
  const available = new Map();
  before.forEach((link, index) => {
    const matches = available.get(link.key) ?? [];
    matches.push(index);
    available.set(link.key, matches);
  });
  const retained = new Set(),
    ordinals = [];
  for (let index = 0; index < after.length; index++) {
    const previous = available.get(after[index].key)?.shift();
    if (previous === undefined)
      throw new DataError(
        'Changing permission-expanded query link structure/bindings requires a source-qualified mutation adapter.',
        501,
        'LocalPluginQueryUnsupported',
      );
    retained.add(previous);
    if (generated.has(previous)) ordinals.push(index);
  }
  if (before.some((_, index) => !generated.has(index) && !retained.has(index)))
    throw new DataError(
      'Removing authored permission-query links requires a source-qualified mutation adapter.',
      501,
      'LocalPluginQueryUnsupported',
    );
  return {
    ...original,
    generatedLinkOrdinals: ordinals,
    generatedLinkAliases: ordinals.map((index) => after[index].alias).filter(Boolean),
    // Rebinding a condition to the kept alias changes the optimization's proof.
    // The ordinary join evaluator remains exact and does not require that proof.
    generatedTerminalConditions: [],
  };
}
