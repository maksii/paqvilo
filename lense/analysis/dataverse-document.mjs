import YAML from 'yaml';
import { parseSolutionXml } from '../../mirage/lib/solution-xml.mjs';
import { classifyYamlPath, yamlNode, YAML_ROOTS } from '../../mirage/lib/solution-yaml.mjs';

const folders = new Set([
  'entities',
  'entityrelationships',
  'optionsets',
  'environmentvariabledefinitions',
  'connectionreferences',
  'sdkmessageprocessingsteps',
  'pluginassemblies',
  'plugintypes',
  'webresources',
  'appmodules',
  'appmodulesitemaps',
  'sitemaps',
  'customapis',
  'savedqueries',
  'systemforms',
  'formxml',
]);
const files = new Set(['solution.xml', 'customizations.xml', 'solution.yml', 'solution.yaml', 'app-spec.json']);
export const lower = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();
export const localName = (node) => lower(node?.name).split(':').at(-1);
export const metadataFields = (value) =>
  Object.fromEntries(Object.entries(value ?? {}).map(([key, item]) => [lower(key).replace(/^@/, ''), item]));
export const directNode = (node, name) => node?.children?.find((item) => localName(item) === name);
export const nodeValue = (node, name) => {
  const attr = Object.entries(node?.attrs ?? {}).find(([key]) => lower(key) === name);
  return attr?.[1] ?? directNode(node, name)?.text?.trim();
};

export function dataverseEntry(entry) {
  const parts = lower(entry.relativeFile ?? entry.file)
    .replaceAll('\\', '/')
    .split('/');
  const name = parts.at(-1);
  if (files.has(name)) return true;
  if (name.endsWith('.json') && /deployment.*settings|settings.*deployment/.test(name)) return true;
  return /\.(?:xml|json|ya?ml)$/.test(name) && parts.some((part) => folders.has(part));
}

export function xmlRows(root, table = null) {
  const rows = [],
    pending = [{ node: root, parent: null, table, depth: 0, fetch: false }];
  while (pending.length) {
    const row = pending.pop();
    if (rows.length >= 100000 || row.depth > 128) throw new Error('Metadata structure budget');
    if (['entity', 'link-entity'].includes(localName(row.node))) row.table = nodeValue(row.node, 'name') ?? row.table;
    if (row.table && String(row.table).length > 512) throw new Error('Metadata identity budget');
    row.fetch ||= ['fetch', 'fetchxml'].includes(localName(row.node));
    rows.push(row);
    for (let index = row.node.children.length - 1; index >= 0; index--)
      pending.push({
        node: row.node.children[index],
        parent: row.node,
        table: row.table,
        depth: row.depth + 1,
        fetch: row.fetch,
      });
  }
  return rows;
}

function validateObjectBudget(value) {
  const pending = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const row = pending.pop();
    if (++count > 100000 || row.depth > 128) throw new Error('Metadata structure budget');
    if (row.value && typeof row.value === 'object')
      for (const item of Object.values(row.value)) pending.push({ value: item, depth: row.depth + 1 });
  }
}

function validateSpecCollections(entry, value) {
  if (!/(?:^|\/)app-spec\.json$/i.test(entry.relativeFile ?? entry.file)) return;
  for (const key of [
    'entities',
    'relationships',
    'forms',
    'views',
    'globalChoices',
    'webResources',
    'environmentVariables',
    'connectionReferences',
    'customApis',
  ])
    if (Object.hasOwn(value ?? {}, key) && !Array.isArray(value[key]))
      throw new Error('Unsupported App Spec collection shape');
}

function yamlMetadataRoot(entry, value) {
  const parts = String(entry.relativeFile ?? entry.file)
    .replaceAll('\\', '/')
    .split('/');
  const start = parts.findIndex((part) => ['entities', 'optionsets', 'entityrelationships'].includes(lower(part)));
  const info = start >= 0 ? classifyYamlPath(parts.slice(start).join('/')) : null;
  if (info) return { root: yamlNode(entry.text, YAML_ROOTS[info.part]), table: info.entityDir };
  const name = lower(parts.at(-1)),
    fields = metadataFields(value);
  if (/^solution\.ya?ml$/.test(name))
    return { root: yamlNode(JSON.stringify(fields.solutionmanifest ?? fields.solution ?? value), 'SolutionManifest') };
  const roots = {
    environmentvariabledefinitions: 'environmentvariabledefinition',
    connectionreferences: 'connectionreference',
    sdkmessageprocessingsteps: 'SdkMessageProcessingStep',
    pluginassemblies: 'PluginAssembly',
    plugintypes: 'PluginType',
  };
  const folder = parts.find((part) => Object.hasOwn(roots, lower(part)));
  if (folder)
    return {
      root: yamlNode(
        entry.text,
        name.includes('environmentvariablevalue') ? 'environmentvariablevalues' : roots[lower(folder)],
      ),
    };
  return null;
}

export function readDataverseDocument(entry) {
  if (/\.xml$/i.test(entry.file)) {
    const root = parseSolutionXml(entry.text, { locations: true });
    return { entry, root, rows: xmlRows(root), format: 'xml' };
  }
  let value;
  if (/\.json$/i.test(entry.file)) value = JSON.parse(entry.text);
  else {
    const document = YAML.parseDocument(entry.text, { uniqueKeys: true });
    if (document.errors.length) throw new Error('Invalid metadata YAML');
    value = document.toJS({ maxAliasCount: 0 });
  }
  validateObjectBudget(value);
  validateSpecCollections(entry, value);
  if (/\.ya?ml$/i.test(entry.file)) {
    const metadata = yamlMetadataRoot(entry, value);
    if (metadata)
      return {
        entry: { ...entry, exactLocation: false },
        root: metadata.root,
        rows: xmlRows(metadata.root, metadata.table),
        format: 'xml',
      };
  }
  return { entry, value, format: 'object' };
}

export function sourceAt(document, node) {
  if (!node?.region) return document.entry;
  return { ...document.entry, line: node.region.line, column: node.region.column, exactLocation: false };
}

export const rootKey = (entry) => String(entry.rootId ?? 'selected');
export function objectRows(value) {
  if (Array.isArray(value)) return value;
  return value && typeof value === 'object' ? [value] : [];
}

export function knownMetadataKind(document) {
  if (document.format === 'xml') {
    const names = new Set(document.rows.map(({ node }) => localName(node)));
    return [...names].some((name) =>
      [
        'importexportxml',
        'solutionmanifest',
        'solution',
        'entity',
        'attribute',
        'entityrelationship',
        'optionset',
        'environmentvariabledefinition',
        'environmentvariablevalue',
        'connectionreference',
        'sdkmessageprocessingstep',
        'pluginassembly',
        'plugintype',
        'webresource',
        'appmodule',
        'appmodulecomponent',
        'sitemap',
        'form',
        'savedquery',
        'customapi',
      ].includes(name),
    );
  }
  const value = document.value;
  if (Array.isArray(value))
    return /(?:^|\/)environmentvariabledefinitions\//i.test(document.entry.relativeFile ?? document.entry.file);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  if (/(?:^|\/)environmentvariabledefinitions\//i.test(document.entry.relativeFile ?? document.entry.file)) return true;
  const keys = Object.keys(metadataFields(value));
  if (/(?:^|\/)app-spec\.json$/i.test(document.entry.relativeFile ?? document.entry.file))
    return keys.some((key) =>
      [
        'solution',
        'entities',
        'relationships',
        'forms',
        'views',
        'webresources',
        'globalchoices',
        'environmentvariables',
        'connectionreferences',
        'customapis',
      ].includes(key),
    );
  return keys.some((key) =>
    [
      'solution',
      'uniquename',
      'environmentvariables',
      'environmentvariabledefinition',
      'environmentvariablevalues',
      'environmentvariablevalue',
      'connectionreferences',
      'connectionreference',
      'schemaname',
      'entity',
      'sdkmessageprocessingstep',
      'entities',
      'customapis',
      'connectionreferencelogicalname',
    ].includes(key),
  );
}
