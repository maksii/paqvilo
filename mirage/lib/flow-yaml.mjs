// Modern flows of a YAML source-control repository (modernflows/, "Power Automate cloud flows ... YAML format only":
// https://learn.microsoft.com/power-platform/alm/solution-source-control-yaml-format#component-type-support) normalised into the
// same workflow entry the classic Workflows/<name>.json export gives (exported-operations.mjs importOperationWorkflows):
// { file, name, active, activation, definition: { properties: { definition, connectionReferences } } }, so triggers, actions,
// expressions and connection references run through the one flow interpreter.
// unverified: Learn does not describe the files under modernflows/. A flow is a modernflows/<folder>/ of YAML or JSON files;
// they are merged, and the flow is read from the workflow row fields (workflowid, name, statecode, clientdata as JSON text or
// an object) or from a client data document ({ properties: { definition, connectionReferences } } or { definition }), keys
// matched without case. A folder without a workflow id or a definition is not imported (its inventory record says so).
// ponytail: YAML numbers become JavaScript numbers before the exact-numeric JSON parse; integers above 2^53 in YAML lose digits.
import path from 'node:path';
import YAML from 'yaml';
import { parseExactJson, stringifyExactJson } from './exact-numeric.mjs';

const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const GUID = /^\{?([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\}?$/i;
// The value of a key at any depth up to 4, matched without case.
function find(node, names, depth = 0, max = 4) {
  if (!isMap(node) || depth > max) return undefined;
  for (const [key, value] of Object.entries(node)) if (names.includes(key.toLowerCase()) && value !== undefined && value !== null) return value;
  for (const value of Object.values(node)) { const found = find(value, names, depth + 1, max); if (found !== undefined) return found; }
  return undefined;
}
// The client data of a document: { properties: { definition, connectionReferences } }, or null.
function clientData(document) {
  let data = find(document, ['clientdata']);
  if (typeof data === 'string') { try { data = parseExactJson(data); } catch { data = null; } }
  if (isMap(data)) document = data;
  const properties = isMap(document?.properties) && isMap(document.properties.definition) ? document.properties
    : isMap(document?.definition) && isMap(document.definition.triggers) ? { definition: document.definition, connectionReferences: document.connectionReferences } : null;
  return properties ? { properties: { definition: properties.definition, ...(isMap(properties.connectionReferences) ? { connectionReferences: properties.connectionReferences } : {}) } } : null;
}

export const YAML_INVALID = 'MODERNFLOW_YAML_INVALID';
/**
 * The document of one modernflows/ file: { document } or { invalid } when it does not parse, where invalid is the
 * MODERNFLOW_YAML_INVALID diagnostic naming the file and the parser's line (an unquoted `@` expression is invalid YAML).
 */
export function parseModernFlowFile(text, file) {
  try {
    return { document: /\.json$/i.test(file) ? parseExactJson(text) : parseExactJson(JSON.stringify(YAML.parse(text, { maxAliasCount: 100 }) ?? null)) };
  } catch (error) {
    const line = error.linePos?.[0]?.line ?? null;
    const reason = String(error.message ?? error).split(/\r?\n/)[0];
    return { invalid: { code: YAML_INVALID, severity: 'error', file, line, message: `${YAML_INVALID}: ${file}${line ? ` line ${line}` : ''} does not parse (${reason}); quote values that start with @ or other YAML indicators.` } };
  }
}

/** What one modernflows/ file carries: { workflowId, definition } (booleans), for the inventory level of its flow, and invalid. */
export function modernFlowFacts(text, file) {
  const { document, invalid } = parseModernFlowFile(text, file);
  if (invalid) return { workflowId: false, definition: false, invalid };
  const id = find(document, ['workflowid'], 0, 1);
  return { workflowId: typeof id === 'string' && GUID.test(id), definition: clientData(document) !== null };
}

/**
 * The workflow entries of one YAML layer: Map(processId -> entry). files: the layer's classified files ({ path, relative });
 * read(file) answers its UTF-8 text or null; diagnostic(entry) receives MODERNFLOW_YAML_INVALID for a file that does not parse.
 */
export function modernFlowWorkflows(files, read, { diagnostic = () => {} } = {}) {
  const folders = new Map();
  for (const file of files) {
    const relative = String(file.relative ?? '').replaceAll('\\', '/');
    const match = /^modernflows\/([^/]+)\/.+\.(?:ya?ml|json)$/i.exec(relative);
    if (!match) continue;
    const list = folders.get(match[1]) ?? [];
    list.push(file);
    folders.set(match[1], list);
  }
  const result = new Map();
  for (const [folder, list] of folders) {
    let id = null, name = null, state = null, definition = null, source = null;
    for (const file of list.sort((a, b) => String(a.relative).localeCompare(String(b.relative)))) {
      const text = read(file);
      if (text == null) continue;
      const { document, invalid } = parseModernFlowFile(text, String(file.relative).replaceAll('\\', '/'));
      if (invalid) { diagnostic(invalid); continue; }
      const workflowId = find(document, ['workflowid'], 0, 1);
      if (!id && typeof workflowId === 'string' && GUID.test(workflowId)) id = GUID.exec(workflowId)[1].toLowerCase();
      const named = find(document, ['name'], 0, 1);
      name ??= typeof named === 'string' ? named : null;
      const code = find(document, ['statecode'], 0, 1);
      if (state === null && code !== undefined) state = String(code?.value ?? code);
      const data = clientData(document);
      if (data && !definition) { definition = data; source = file.path; }
    }
    if (!id || !definition) continue;
    const active = state === null ? null : ['1', 'activated'].includes(state.toLowerCase());
    result.set(id, { file: source, name: name ?? folder, active, activation: { sourceValue: state, sourceFile: source ? path.dirname(source) : null }, definition: parseExactJson(stringifyExactJson(definition)), format: 'yaml' });
  }
  return result;
}
