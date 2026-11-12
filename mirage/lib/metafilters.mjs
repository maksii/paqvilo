// Metadata filters of entity lists (adx_filter_definition): the filter groups parsed from a list's definition, and the
// options of those groups with the ones the mf query selects checked. Pure functions over the definition text; they do
// no I/O and import nothing from the list, Liquid or server modules.
import { DataError } from './data-error.mjs';

/** The definition as a JSON object. A malformed definition fails as malformed grid settings do. */
function parseDefinition(value) {
  if (value == null || value === '') return {};
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new DataError('Grid filter definition JSON is malformed', 501, 'GRID_SETTINGS_INVALID');
  }
}

/** Metadata filter definition (adx_filter_definition) applied from the serialized "mf" query. */
export function metaFilterGroups(definition) {
  const parsed = parseDefinition(definition || '{}');
  const entity = parsed.entity ?? {};
  const groups = [];
  for (const filter of entity.filters ?? []) groups.push({ kind: 'filter', node: filter });
  for (const link of entity.links ?? []) groups.push({ kind: 'link', node: link });
  return groups
    .map(({ kind, node }) => ({
      kind,
      node,
      id: String(node['adx.id'] ?? ''),
      label: node['adx.uiname'] ?? node['adx.attribute'] ?? '',
      order: Number(node['adx.uiorder'] ?? 0),
      type: node['adx.filtertype'] ?? '',
      selectionMode: node['adx.uiselectionmode'] ?? (node['adx.filtertype'] === 'textfilter' ? 'Text' : 'Multiple'),
    }))
    .sort((a, b) => a.order - b.order);
}

const selectedValues = (params, id) =>
  params
    .getAll(id)
    .map((value) => value.trim())
    .filter(Boolean);
// A link group's options are the conditions of its static filter; other groups keep them on the node.
const optionNodes = (group) =>
  group.kind === 'link'
    ? (group.node.filters?.[0]?.conditions ?? [])
    : (group.node.conditions ?? group.node.filters ?? []);
function optionGroup(group, params) {
  const selected = selectedValues(params, group.id);
  const options =
    group.type === 'textfilter'
      ? [{ id: group.id, label: group.label, type: 'text', text: selected[0] ?? '', checked: selected.length > 0 }]
      : optionNodes(group).map((option) => {
          const id = String(option['adx.id'] ?? '');
          return {
            id,
            label: String(option['adx.uiname'] ?? id),
            type: 'option',
            text: null,
            checked: selected.includes(id),
          };
        });
  return { id: group.id, label: group.label, selection_mode: group.selectionMode, options };
}

/** The filter groups of a definition, each option checked when the mf query (a serialized query string) selects it. */
export function metaFilterOptionGroups(definition, query) {
  const params = new URLSearchParams(query ?? '');
  return metaFilterGroups(definition).map((group) => optionGroup(group, params));
}
