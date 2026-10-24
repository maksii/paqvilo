// Canonical Dataverse Git YAML (Git integration, `pac solution clone`) → the XML node shape solution-xml.mjs produces, so the
// one schema parser (solution-schema.mjs parseSchemaDocument) reads tables, attributes, forms, views, global option sets and
// relationships with the same membership and layering as the classic XML layout.
// Learn: https://learn.microsoft.com/power-platform/alm/solution-source-control-yaml-format ("Components stored as XML
// internally are automatically converted between XML and YAML"); the documented publisher.yml shows the conversion: an
// element is a key, an attribute is an '@name' key, a repeated element is a list and an empty element is null.
// Learn documents per-file key shapes only for publisher.yml. Entity, attribute, form, view, option set and
// relationship files are read by the same rule; a file that yields no component is reported (SOLUTION_YAML_COMPONENT_NOT_IMPORTED)
// instead of guessed. Mixed text and attributes on one element ('#text') follow the common XML→YAML convention.
// The file layout of modernflows/ (Power Automate cloud flows, YAML format only) is not described on Learn, so a
// modern flow stays an inventory record (solution-inventory.mjs, MODERNFLOW_YAML_NOT_IMPORTED) that strict preflight blocks on.
import YAML from 'yaml';
import { child, descendants } from './solution-xml.mjs';

const YAML_FILE = /\.ya?ml$/i;
/** The element each YAML component file describes (its root element in the classic XML layout). */
export const YAML_ROOTS = Object.freeze({ entity: 'Entity', attribute: 'attribute', form: 'systemform', view: 'savedquery', optionset: 'optionset', relationship: 'EntityRelationship' });

/**
 * `{ kind: 'yaml', part, entityDir?, formType? }` for a YAML-format repository path that carries runtime metadata, else null:
 * entities/<t>/entity.yml, entities/<t>/attributes/*.yml, entities/<t>/formxml/[<type>/]*.yml, entities/<t>/savedqueries/*.yml,
 * optionsets/*.yml and entityrelationships/**.yml.
 */
export function classifyYamlPath(relative) {
  const parts = String(relative).replace(/\\/g, '/').split('/').filter(Boolean);
  const lower = parts.map(part => part.toLowerCase());
  if (!YAML_FILE.test(lower.at(-1) ?? '')) return null;
  if (lower[0] === 'entities' && parts.length >= 3) {
    const entityDir = parts[1];
    if (parts.length === 3 && /^entity\.ya?ml$/.test(lower[2])) return { kind: 'yaml', part: 'entity', entityDir };
    if (lower[2] === 'attributes' && parts.length === 4) return { kind: 'yaml', part: 'attribute', entityDir };
    if (lower[2] === 'formxml' && parts.length >= 4) return { kind: 'yaml', part: 'form', entityDir, ...(parts.length === 5 ? { formType: lower[3] } : {}) };
    if (lower[2] === 'savedqueries' && parts.length === 4) return { kind: 'yaml', part: 'view', entityDir };
    return null;
  }
  if (lower[0] === 'optionsets' && parts.length === 2) return { kind: 'yaml', part: 'optionset' };
  if (lower[0] === 'entityrelationships' && parts.length >= 2) return { kind: 'yaml', part: 'relationship' };
  return null;
}

function element(name, value) {
  const node = { name, attrs: {}, children: [], text: '' };
  if (value == null) return node;
  if (typeof value !== 'object') { node.text = String(value); return node; }
  for (const [key, item] of Object.entries(value)) {
    if (key.startsWith('@')) { node.attrs[key.slice(1)] = item == null ? '' : String(item); continue; }
    if (key === '#text') { node.text = item == null ? '' : String(item); continue; }
    for (const entry of Array.isArray(item) ? item : [item]) node.children.push(element(key, entry));
  }
  return node;
}

/**
 * The XML node of one YAML document. A mapping whose single key names `root` or its plural (any case) wraps the element; any
 * other mapping is that element's content. Throws on invalid YAML or a non-mapping document.
 */
export function yamlNode(text, root) {
  const document = YAML.parse(String(text), { maxAliasCount: 100 });
  if (!document || typeof document !== 'object' || Array.isArray(document)) throw new Error(`The YAML document is not a ${root} mapping.`);
  const keys = Object.keys(document);
  // The element itself or its collection element (EntityRelationships, savedqueries, forms) may wrap the document.
  const wrapped = keys.length === 1 && [root.toLowerCase(), `${root.toLowerCase()}s`].includes(keys[0].toLowerCase());
  return element(wrapped ? keys[0] : root, wrapped ? document[keys[0]] : document);
}

/** The nodes of `name` at or below `node`. */
const all = (node, name) => [...(node.name === name ? [node] : []), ...descendants(node, name)];
const empty = name => ({ name, attrs: {}, children: [], text: '' });
const ensure = (parent, name) => child(parent, name) ?? (parent.children.push(empty(name)), parent.children.at(-1));

/**
 * One table folder as a Customizations.xml <Entity> node: entity.yml (or an empty shell named after the folder), its attribute
 * files under EntityInfo/entity/attributes, form files under FormXml/forms[type] and view files under SavedQueries/savedqueries.
 * parts: [{ part, node, formType }]. Returns { node, unread: [{ part, index }] } where unread names part files that carry no
 * component (an attribute without a name, a form without <form>, a view without savedqueryid).
 */
export function yamlEntityNode(entityDir, parts) {
  const node = parts.find(item => item.part === 'entity')?.node ?? empty('Entity');
  const info = ensure(node, 'EntityInfo');
  const header = ensure(info, 'entity');
  if (!header.attrs.Name && !child(node, 'Name')?.text.trim()) header.attrs.Name = entityDir;
  const unread = [];
  parts.forEach((item, index) => {
    if (item.part === 'attribute') {
      const named = all(item.node, 'attribute').filter(attribute => attribute.attrs.PhysicalName || child(attribute, 'LogicalName') || child(attribute, 'Name'));
      if (named.length) ensure(header, 'attributes').children.push(...named); else unread.push({ part: item.part, index });
    } else if (item.part === 'form') {
      const forms = all(item.node, 'systemform').filter(form => child(form, 'form'));
      if (forms.length) ensure(node, 'FormXml').children.push({ ...empty('forms'), attrs: item.formType ? { type: item.formType } : {}, children: forms });
      else unread.push({ part: item.part, index });
    } else if (item.part === 'view') {
      const views = all(item.node, 'savedquery').filter(view => child(view, 'savedqueryid'));
      if (views.length) ensure(ensure(node, 'SavedQueries'), 'savedqueries').children.push(...views); else unread.push({ part: item.part, index });
    }
  });
  return { node, unread };
}

/**
 * The document node of a global option set or relationship file in the shape parseSchemaDocument reads (ImportExportXml/optionsets,
 * EntityRelationships), or null when the file names none (an option set without Name, a relationship without Name).
 */
export function yamlComponentNode(part, node) {
  if (part === 'optionset') {
    const sets = all(node, 'optionset').filter(set => set.attrs.Name);
    return sets.length ? { ...empty('ImportExportXml'), children: [{ ...empty('optionsets'), children: sets }] } : null;
  }
  if (part === 'relationship') {
    const relationships = all(node, 'EntityRelationship').filter(relationship => relationship.attrs.Name && relationship.children.length);
    return relationships.length ? { ...empty('EntityRelationships'), children: relationships } : null;
  }
  return null;
}
