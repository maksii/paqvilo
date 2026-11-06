import { parseSolutionXml } from '../../mirage/lib/solution-xml.mjs';
import { localName, nodeValue, sourceAt, rootKey, lower, xmlRows } from './dataverse-document.mjs';
import { collectSpecSchema, analyzeDataverseSpec } from './dataverse-spec.mjs';

const scopedName = (entry, name) => JSON.stringify([rootKey(entry), lower(name)]);
const resourceName = (value) => lower(value).replace(/^\$webresource:/, '');
const finiteValue = (value) => (value === undefined || String(value).trim() === '' ? undefined : Number(value));

function collectSchemaRow(document, { node, table, fetch }, facts) {
  if (fetch) return;
  const kind = localName(node);
  if (kind === 'entity' && table) facts.tables.add(scopedName(document.entry, table));
  if (kind === 'attribute' && table) {
    const name = nodeValue(node, 'logicalname') ?? nodeValue(node, 'name');
    const key = scopedName(document.entry, table),
      fields = facts.columns.get(key) ?? new Set();
    if (name) {
      fields.add(lower(name));
      facts.tables.add(key);
    }
    facts.columns.set(key, fields);
  }
  if (kind === 'webresource') {
    const name = nodeValue(node, 'name');
    if (name) facts.resources.add(scopedName(document.entry, resourceName(name)));
  }
}

export function collectDataverseSchema(documents) {
  const facts = { tables: new Set(), columns: new Map(), resources: new Set() };
  for (const document of documents) {
    if (document.format !== 'xml') collectSpecSchema(document, facts);
    else for (const row of document.rows) collectSchemaRow(document, row, facts);
  }
  return facts;
}

function inspectColumn(document, node, emit) {
  const minimum = finiteValue(nodeValue(node, 'minvalue')),
    maximum = finiteValue(nodeValue(node, 'maxvalue'));
  if (Number.isFinite(minimum) && Number.isFinite(maximum) && minimum > maximum)
    emit('DV-SCHEMA-001', sourceAt(document, node), 'minvalue');
}

function inspectChoices(document, node, emit) {
  const values = new Set();
  for (const option of node.children.filter((item) => localName(item) === 'option')) {
    const value = nodeValue(option, 'value');
    if (!/^-?\d{1,10}$/.test(value ?? '')) continue;
    const integer = Number(value);
    if (values.has(integer)) emit('DV-SCHEMA-002', sourceAt(document, option), 'value');
    values.add(integer);
  }
}

function inspectRelationship(document, node, facts, emit) {
  for (const field of ['referencedentityname', 'referencingentityname', 'entity1name', 'entity2name']) {
    const target = nodeValue(node, field);
    if (target && !facts.tables.has(scopedName(document.entry, target)))
      emit('DV-SCHEMA-003', sourceAt(document, node), field);
  }
}

function inspectHandler(document, node, facts, emit) {
  if (['false', '0'].includes(lower(nodeValue(node, 'enabled')))) return;
  const library = nodeValue(node, 'libraryname');
  if (library && !facts.resources.has(scopedName(document.entry, resourceName(library))))
    emit('DV-MODEL-001', sourceAt(document, node), 'libraryname');
}

function inspectHandlers(document, node, emit) {
  const seen = new Set();
  for (const handler of node.children.filter((item) => localName(item) === 'handler')) {
    if (['false', '0'].includes(lower(nodeValue(handler, 'enabled')))) continue;
    const key = JSON.stringify(
      ['libraryname', 'functionname', 'parameters', 'passexecutioncontext'].map(
        (field) => nodeValue(handler, field) ?? '',
      ),
    );
    if (seen.has(key)) emit('DV-MODEL-002', sourceAt(document, handler));
    seen.add(key);
  }
}

function inspectFormColumn(document, row, facts, emit) {
  const field = nodeValue(row.node, 'datafieldname');
  if (!field || !row.table) return;
  const columns = facts.columns.get(scopedName(document.entry, row.table));
  if (columns && !columns.has(lower(field))) emit('DV-MODEL-003', sourceAt(document, row.node), 'datafieldname');
}

function inspectQueryColumn(document, row, facts, emit) {
  const name = nodeValue(row.node, 'name');
  if (!name || name === '*' || !row.table) return;
  const columns = facts.columns.get(scopedName(document.entry, row.table));
  if (columns && !columns.has(lower(name))) emit('DV-MODEL-004', sourceAt(document, row.node), 'name');
}

function inspectFetch(document, row, emit) {
  const { node } = row;
  if (localName(node) === 'all-attributes' && row.fetch) emit('DV-QUERY-001', sourceAt(document, node));
  if (localName(node) !== 'fetchxml' || !node.text.trim()) return true;
  try {
    const root = parseSolutionXml(node.text),
      source = sourceAt(document, node);
    if (xmlRows(root).some((row) => localName(row.node) === 'all-attributes')) emit('DV-QUERY-001', source);
    return true;
  } catch {
    emit('DV-SOURCE-001', sourceAt(document, node), 'fetchxml');
    return false;
  }
}

export function analyzeDataverseSchema(document, facts, emit) {
  if (document.format !== 'xml') return analyzeDataverseSpec(document, facts, emit);
  let complete = true;
  for (const row of document.rows) {
    const { node } = row,
      kind = localName(node);
    if (kind === 'attribute' && !row.fetch) inspectColumn(document, node, emit);
    else if (kind === 'attribute' && row.fetch) inspectQueryColumn(document, row, facts, emit);
    else if (kind === 'options') inspectChoices(document, node, emit);
    else if (kind === 'entityrelationship') inspectRelationship(document, node, facts, emit);
    else if (kind === 'handler') inspectHandler(document, node, facts, emit);
    else if (kind === 'handlers') inspectHandlers(document, node, emit);
    else if (kind === 'control') inspectFormColumn(document, row, facts, emit);
    else if (kind === 'fetchxml' || kind === 'all-attributes') complete = inspectFetch(document, row, emit) && complete;
  }
  return complete;
}
