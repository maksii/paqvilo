// Canvas app source reader: reads the Power Apps YAML source code (`Src/**/*.pa.yaml`, or the retired unpacked
// `Src/*.fx.yaml` with its `DataSources/*.json` when an app has no pa.yaml) of an `.msapp` archive or an extracted
// directory and lists app, screens, controls, components, data sources and formulas. Parsing never evaluates a formula;
// canvas-runtime.mjs hosts the parsed app headlessly.
//
// Format references (Microsoft):
// - Source files, `.msapp` layout and "read-only, for review" status:
//   https://learn.microsoft.com/power-apps/maker/canvas-apps/power-apps-yaml
// - Static schema v3.0 (App, Screens, ComponentDefinitions, DataSources, EditorState):
//   https://raw.githubusercontent.com/microsoft/PowerApps-Tooling/refs/heads/master/schemas/pa-yaml/v3.0/pa.schema.yaml
// - Formula grammar (`=`-prefixed YAML scalars): https://learn.microsoft.com/power-platform/power-fx/yaml-formula-grammar
// - Retired `.fx.yaml` unpack format: https://learn.microsoft.com/power-platform/developer/cli/reference/canvas#pac-canvas-unpack
// - Canvas apps in Solutions: https://learn.microsoft.com/power-platform/alm/solution-packager-tool
import fs from 'node:fs/promises';
import path from 'node:path';
import { LineCounter, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { readSolutionAssetEntries } from './dataverse-solution-assets.mjs';
import { unsupportedControls } from './canvas-controls.mjs';

export const CANVAS_SCHEMA_VERSIONS = Object.freeze(['3.0']);
const TOP_LEVEL = new Set(['App', 'Screens', 'ComponentDefinitions', 'DataSources', 'EditorState']);
const SRC = /^src\//i;
const PA_YAML = /\.pa\.ya?ml$/i;
const FX_YAML = /\.fx\.ya?ml$/i;
const DATA_SOURCE_JSON = /^DataSources\/[^/]+\.json$/i;
const wanted = name => PA_YAML.test(name) || FX_YAML.test(name) || DATA_SOURCE_JSON.test(name.replaceAll('\\', '/'));
// `.fx.yaml` control keys: `Name As type[.variant]` (Learn power-apps-yaml "Experimental format"); a quoted name keeps its spaces.
const FX_CONTROL = /^\s*(?:'((?:[^']|'')+)'|(.+?))\s+As\s+([\w.]+)\s*$/;

const entriesOf = node => isMap(node) ? node.items.map(pair => [String(isScalar(pair.key) ? pair.key.value : pair.key), pair.value, pair.key]) : [];
const field = (node, key) => isMap(node) ? node.get(key, true) : undefined;
const text = node => node == null ? null : String(isScalar(node) ? node.value : node);

async function directoryFiles(dir) {
  const names = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of names) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    const name = path.relative(dir, full).replaceAll('\\', '/');
    if (wanted(name)) files.push({ name, read: () => fs.readFile(full, 'utf8') });
  }
  return files;
}

/** Inventory one canvas app. Pass `msapp` (bytes) or `dir` (an extracted `.msapp`); `name`/`version` come from the Solution when known. */
export async function readCanvasSource({ msapp, dir, name, version = null } = {}) {
  if (!msapp === !dir) throw new TypeError('readCanvasSource needs exactly one of msapp or dir.');
  const result = { app: { name: name ?? (dir ? path.basename(path.resolve(dir)) : 'App'), version, schemaVersion: null },
    screens: [], components: [], formulas: [], dataSources: [], diagnostics: [] };
  const diagnostic = (code, message, source = null, severity) => result.diagnostics.push({ code, message, source, ...(severity ? { severity } : {}) });
  let files;
  if (msapp) {
    try {
      files = readSolutionAssetEntries(msapp, { include: wanted })
        .map(entry => ({ name: entry.name, read: () => entry.data.toString('utf8') }));
    } catch (error) {
      diagnostic('CANVAS_SOURCE_ARCHIVE_INVALID', `The .msapp archive cannot be read (${error.code ?? 'InvalidArchive'}).`, null, 'error');
      return result;
    }
  } else files = await directoryFiles(dir);
  for (const file of files) file.name = file.name.replaceAll('\\', '/');
  files.sort((left, right) => left.name.localeCompare(right.name));

  const legacy = files.filter(file => FX_YAML.test(file.name));
  const sources = files.filter(file => SRC.test(file.name) && PA_YAML.test(file.name));
  if (!sources.length && legacy.some(file => SRC.test(file.name))) {
    diagnostic('CANVAS_SOURCE_LEGACY_FXYAML', `The app is read from the retired .fx.yaml format (${legacy.length} file(s)); re-save it in Power Apps Studio to get Src/*.pa.yaml.`, legacy[0].name);
    await readFxYaml(files, result, diagnostic);
    return result;
  }
  if (legacy.length) diagnostic('CANVAS_SOURCE_LEGACY_FXYAML', `Retired .fx.yaml sources are ignored (${legacy.length} file(s)); re-save the app in Power Apps Studio to get Src/*.pa.yaml.`, legacy[0].name);
  if (!sources.length) {
    diagnostic('CANVAS_SOURCE_NO_PAYAML', 'No Src/*.pa.yaml source code was found; re-save the app in Power Apps Studio.');
    return result;
  }

  let unknownVersion = null;
  for (const file of sources) {
    const source = file.name, content = await file.read(), counter = new LineCounter();
    const document = parseDocument(content, { lineCounter: counter, uniqueKeys: true });
    if (document.errors.length) {
      const [error] = document.errors;
      // The parser message quotes source text; report only position and code.
      diagnostic('CANVAS_SOURCE_YAML_INVALID', `${source}: YAML parse error at line ${error.linePos?.[0]?.line ?? '?'} (${error.code}).`, source);
      continue;
    }
    const declared = /\$schema=\S*pa-yaml\/v(\d+(?:\.\d+)*)\//.exec(content)?.[1];
    if (declared && !CANVAS_SCHEMA_VERSIONS.includes(declared)) unknownVersion ??= declared;
    const line = node => node?.range ? counter.linePos(node.range[0]).line : null;
    const properties = (node, owner) => {
      for (const [property, value, key] of entriesOf(node))
        result.formulas.push({ owner, property, text: text(value) ?? '', source, line: line(key) });
    };
    const controls = (sequence, prefix, parent, out) => {
      if (!isSeq(sequence)) return;
      for (const item of sequence.items) for (const [control, body] of entriesOf(item)) {
        out.push({ name: control, control: text(field(body, 'Control')), parent,
          ...(field(body, 'Variant') ? { variant: text(field(body, 'Variant')) } : {}),
          ...(field(body, 'ComponentName') ? { componentName: text(field(body, 'ComponentName')) } : {}) });
        properties(field(body, 'Properties'), `${prefix}.${control}`);
        controls(field(body, 'Children'), prefix, control, out);
      }
    };
    for (const [key, value, keyNode] of entriesOf(document.contents)) {
      if (!TOP_LEVEL.has(key)) {
        diagnostic('CANVAS_SOURCE_SCHEMA_UNKNOWN', `${source}: top-level key "${key}" at line ${line(keyNode)} is not part of the pa.yaml v3.0 schema.`, source);
        continue;
      }
      if (key === 'App') properties(field(value, 'Properties'), 'App');
      else if (key === 'Screens') for (const [screen, body] of entriesOf(value)) {
        const entry = { name: screen, controls: [] };
        properties(field(body, 'Properties'), screen);
        controls(field(body, 'Children'), screen, null, entry.controls);
        result.screens.push(entry);
      } else if (key === 'ComponentDefinitions') for (const [component, body] of entriesOf(value)) {
        const entry = { name: component, definitionType: text(field(body, 'DefinitionType')), controls: [] };
        properties(field(body, 'Properties'), component);
        controls(field(body, 'Children'), component, null, entry.controls);
        result.components.push(entry);
      } else if (key === 'DataSources') for (const [dataSource, body] of entriesOf(value)) {
        const table = text(field(field(body, 'Parameters'), 'TableLogicalName')), connectorId = text(field(body, 'ConnectorId'));
        result.dataSources.push({ name: dataSource, kind: text(field(body, 'Type')), ...(table ? { table } : {}), ...(connectorId ? { connectorId } : {}) });
      } else if (key === 'EditorState') {
        // unverified: EditorState.ScreensOrder (pa.schema.yaml v3.0) as the Studio screen order; the first one is the default start screen.
        const order = field(value, 'ScreensOrder');
        if (isSeq(order)) result.app.screensOrder = order.items.map(text);
      }
    }
  }
  if (unknownVersion) diagnostic('CANVAS_SOURCE_SCHEMA_UNKNOWN', `pa.yaml schema v${unknownVersion} is not recognised; known: ${CANVAS_SCHEMA_VERSIONS.join(', ')}.`);
  result.app.schemaVersion = unknownVersion ?? CANVAS_SCHEMA_VERSIONS.at(-1);
  return result;
}

/**
 * The retired unpacked format: `Src/App.fx.yaml` (`App As appinfo`), one `Src/<Screen>.fx.yaml` per screen whose map mixes
 * `=formula` properties with `Name As type` child controls, `Src/Components/*.fx.yaml` (`Name As component`) and
 * `DataSources/<Name>.json`. Learn: power-apps-yaml "Experimental format (*.fx.yaml)" (retired, layout not documented further).
 */
async function readFxYaml(files, result, diagnostic) {
  result.app.format = 'fx.yaml';
  for (const file of files.filter(item => SRC.test(item.name) && FX_YAML.test(item.name))) {
    const source = file.name, counter = new LineCounter();
    const document = parseDocument(await file.read(), { lineCounter: counter, uniqueKeys: true });
    if (document.errors.length) {
      const [error] = document.errors;
      diagnostic('CANVAS_SOURCE_YAML_INVALID', `${source}: YAML parse error at line ${error.linePos?.[0]?.line ?? '?'} (${error.code}).`, source);
      continue;
    }
    const line = node => node?.range ? counter.linePos(node.range[0]).line : null;
    // One map: scalar entries are properties of `owner`, `Name As type` entries are children.
    const walk = (node, owner, screen, parent, out) => {
      for (const [key, value, keyNode] of entriesOf(node)) {
        const match = FX_CONTROL.exec(key);
        if (!match) { result.formulas.push({ owner, property: key, text: text(value) ?? '', source, line: line(keyNode) }); continue; }
        const name = match[1]?.replaceAll("''", "'") ?? match[2];
        out.push({ name, control: match[3], parent });
        walk(value, `${screen}.${name}`, screen, name, out);
      }
    };
    for (const [key, body] of entriesOf(document.contents)) {
      const match = FX_CONTROL.exec(key);
      const name = match ? match[1]?.replaceAll("''", "'") ?? match[2] : key, type = match?.[3]?.toLowerCase();
      if (type === 'appinfo') walk(body, 'App', 'App', null, []);
      else if (type === 'screen') {
        const entry = { name, controls: [] };
        walk(body, name, name, null, entry.controls);
        result.screens.push(entry);
      } else if (type === 'component') {
        const entry = { name, definitionType: 'CanvasComponent', controls: [] };
        walk(body, name, name, null, entry.controls);
        result.components.push(entry);
      } else diagnostic('CANVAS_SOURCE_SCHEMA_UNKNOWN', `${source}: top-level key "${key}" is not an appinfo, screen or component.`, source);
    }
  }
  // unverified: DataSources/<Name>.json as an array (or one object) of { Name, LogicalName|TableLogicalName, ApiId } entries.
  for (const file of files.filter(item => DATA_SOURCE_JSON.test(item.name))) {
    let entries;
    try { entries = JSON.parse(await file.read()); } catch { diagnostic('CANVAS_SOURCE_DATASOURCE_INVALID', `${file.name} is not valid JSON.`, file.name); continue; }
    for (const entry of [entries].flat()) {
      if (!entry?.Name || result.dataSources.some(item => item.name === entry.Name)) continue;
      const table = entry.TableLogicalName ?? entry.LogicalName ?? null, connectorId = entry.ApiId ? String(entry.ApiId).split('/').at(-1) : null;
      result.dataSources.push({ name: entry.Name, kind: table ? 'Table' : connectorId ? 'Actions' : String(entry.Type ?? 'Unknown'), ...(table ? { table } : {}), ...(connectorId ? { connectorId } : {}) });
    }
  }
  result.app.schemaVersion = null;
}

/**
 * Solution inventory record for a canvas app. A parsed app (one screen or more) is hosted headlessly by canvas-runtime.mjs:
 * level `behaviour` (rendering is the documented `canvas:rendering` boundary), with `tree` (screens and components with
 * their control tree) and `unsupported` (controls the runtime lists but does not host); an app without readable source
 * stays `inventory` with the diagnostic as reason.
 */
export function canvasInventoryRecord(source, { id = null, solution = null, layer = null, file = null, format = null } = {}) {
  const dependencies = [];
  for (const dataSource of source.dataSources) {
    if (dataSource.table) dependencies.push({ component: 'table', name: dataSource.table });
    if (dataSource.connectorId) dependencies.push({ component: 'connector', name: dataSource.connectorId });
  }
  const parsed = source.screens.length > 0;
  return { component: 'canvasapp', componentType: 300, id, name: source.app.name, version: source.app.version ?? null,
    solution, layer, source: file, format, dependencies, level: parsed ? 'behaviour' : 'inventory',
    reason: parsed ? null : source.diagnostics.find(item => item.severity === 'error')?.code ?? source.diagnostics[0]?.code ?? 'CANVAS_SOURCE_NO_PAYAML',
    ...(parsed ? { tree: canvasTree(source), unsupported: unsupportedControls(source) } : {}) };
}

/** Screens and components with their control trees, the start-screen order and the source format (canvas-runtime.mjs input). */
export const canvasTree = source => ({ format: source.app.format ?? 'pa.yaml', screensOrder: source.app.screensOrder ?? null,
  screens: source.screens.map(({ name, controls }) => ({ name, controls })), components: source.components.map(({ name, definitionType, controls }) => ({ name, definitionType, controls })) });

/**
 * Inventory records of the project `canvas.sources` paths (an `.msapp` file or an extracted folder each), resolved against
 * projectRoot. A record carries the parsed `canvas` facts canvasAppsOf (organization-host.mjs) serves under /_apps/canvas/
 * and `source` = the configured path. A missing or unreadable path is CANVAS_SOURCE_MISSING (an error diagnostic, no record).
 */
export async function readCanvasSources(sources = [], { projectRoot = process.cwd() } = {}) {
  const records = [], diagnostics = [];
  for (const source of sources ?? []) {
    const file = path.resolve(projectRoot, source);
    let stat;
    try { stat = await fs.stat(file); } catch (error) {
      diagnostics.push({ code: 'CANVAS_SOURCE_MISSING', severity: 'error', source,
        message: `Canvas source ${source} cannot be read (${error.code ?? 'unreadable'}); set canvas.sources to an .msapp file or an extracted app folder.` });
      continue;
    }
    const name = path.basename(file).replace(/\.msapp$/i, '');
    const parsed = stat.isDirectory() ? await readCanvasSource({ dir: file, name }) : await readCanvasSource({ msapp: await fs.readFile(file), name });
    records.push({ ...canvasInventoryRecord(parsed, { file: source, format: stat.isDirectory() ? 'directory' : 'msapp' }),
      canvas: { schemaVersion: parsed.app.schemaVersion, screens: parsed.screens.map(screen => screen.name), components: parsed.components.map(component => component.name),
        dataSources: parsed.dataSources, formulas: parsed.formulas, diagnostics: parsed.diagnostics } });
  }
  return { records, diagnostics };
}

/** Validates the project `canvas` key: { enabled?: boolean, sources?: string[] }. Registered by provider-modules.mjs. */
export function canvasSettings(value, label = 'canvas') {
  if (value == null) return value;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!['enabled', 'sources'].includes(key)) throw new Error(`Unknown ${label} key '${key}'; expected enabled or sources`);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error(`${label}.enabled must be true or false`);
  if (value.sources !== undefined && (!Array.isArray(value.sources) || value.sources.some((source) => typeof source !== 'string' || !source.trim())))
    throw new Error(`${label}.sources must be an array of non-empty paths`);
  return { ...(value.enabled !== undefined ? { enabled: value.enabled } : {}), ...(value.sources !== undefined ? { sources: [...value.sources] } : {}) };
}
