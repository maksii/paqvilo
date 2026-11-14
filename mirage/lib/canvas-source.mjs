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
import { readSolutionAssetEntries, SOLUTION_ASSET_LIMITS } from './dataverse-solution-assets.mjs';
import { readLocalFile } from '../../lense/local-file.mjs';
import { unsupportedControls } from './canvas-controls.mjs';
import { CANVAS_ASSETS, CANVAS_ASSET_MAX_BYTES, CANVAS_ASSET_TOTAL_BYTES, canvasAssetName } from './canvas-assets.mjs';
import { prepareCanvasSource } from './canvas-components.mjs';

const CANVAS_SCHEMA_VERSIONS = Object.freeze(['3.0']);
const TOP_LEVEL = new Set(['App', 'Screens', 'ComponentDefinitions', 'DataSources', 'EditorState']);
const SRC = /^src\//i;
const PA_YAML = /\.pa\.ya?ml$/i;
const FX_YAML = /\.fx\.ya?ml$/i;
const DATA_SOURCE_JSON = /^DataSources\/[^/]+\.json$/i;
const LEGACY_COMPONENT_JSON = /^Src\/Components\/[^/]+\.json$/i;
const LEGACY_MANIFEST_JSON = /^CanvasManifest\.json$/i;
const wanted = (name) =>
  PA_YAML.test(name) ||
  FX_YAML.test(name) ||
  DATA_SOURCE_JSON.test(name.replaceAll('\\', '/')) ||
  LEGACY_MANIFEST_JSON.test(name.replaceAll('\\', '/')) ||
  LEGACY_COMPONENT_JSON.test(name.replaceAll('\\', '/'));
// `.fx.yaml` control keys: `Name As type[.variant]`; a quoted name keeps its spaces.
function /* NOSONAR */ fxControlTypeStarts(text, end) {
  // NOSONAR: preserve state, evaluation order, and lifecycle
  const starts = new Set();
  let cursor = end;
  while (cursor > 0) {
    if (/\w/.test(text[cursor - 1])) {
      while (cursor > 0 && /\w/.test(text[cursor - 1])) cursor--;
      starts.add(cursor);
    } else if (text[cursor - 1] === "'") {
      const close = --cursor;
      cursor--;
      while (cursor >= 0) {
        if (text[cursor] !== "'") cursor--;
        else if (text[cursor - 1] === "'") cursor -= 2;
        else break;
      }
      if (cursor < 0 || close - cursor < 2) break;
    } else break;
    if (text[cursor - 1] !== '.') break;
    cursor--;
  }
  return starts;
}
function /* NOSONAR */ fxControl(key) {
  // NOSONAR: preserve state, evaluation order, and lifecycle
  const end = key.trimEnd().length;
  const starts = fxControlTypeStarts(key, end);
  let leading = 0;
  while (leading < key.length && /\s/.test(key[leading])) leading++;
  let quotedEnd = -1;
  if (key[leading] === "'") {
    let cursor = leading + 1;
    while (cursor < key.length) {
      if (key[cursor] !== "'") cursor++;
      else if (key[cursor + 1] === "'") cursor += 2;
      else {
        quotedEnd = cursor;
        break;
      }
    }
  }
  let fallback;
  for (const match of key.matchAll(/As/g)) {
    const at = match.index;
    if (!/\s/.test(key[at - 1] ?? '') || !/\s/.test(key[at + 2] ?? '')) continue;
    let before = at,
      after = at + 2;
    while (before > 0 && /\s/.test(key[before - 1])) before--;
    while (after < key.length && /\s/.test(key[after])) after++;
    if (!starts.has(after)) continue;
    const control = key.slice(after, end);
    if (quotedEnd > leading + 1 && quotedEnd + 1 === before)
      return [undefined, key.slice(leading + 1, quotedEnd), undefined, control];
    if (fallback) continue;
    let nameStart = leading,
      nameEnd = before;
    if (nameEnd <= nameStart) {
      nameStart = at - 2;
      while (nameStart >= 0 && /[\r\n\u2028\u2029]/.test(key[nameStart])) nameStart--;
      nameEnd = nameStart + 1;
    }
    if (nameStart >= 0 && nameStart < nameEnd && !/[\r\n\u2028\u2029]/.test(key.slice(nameStart, nameEnd)))
      fallback = [undefined, undefined, key.slice(nameStart, nameEnd), control];
  }
  return fallback ?? null;
}

const entriesOf = (node) =>
  isMap(node)
    ? node.items.map((pair) => [String(isScalar(pair.key) ? pair.key.value : pair.key), pair.value, pair.key])
    : [];
const field = (node, key) => (isMap(node) ? node.get(key, true) : undefined);
const text = (node) => {
  if (node == null) return null;
  return String(isScalar(node) ? node.value : node);
};

async function directoryFiles(dir) {
  const names = await fs.readdir(dir, { recursive: true, withFileTypes: true });
  const files = [];
  for (const entry of names) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath ?? entry.path, entry.name);
    const name = path.relative(dir, full).replaceAll('\\', '/');
    if (wanted(name) || canvasAssetName(name))
      files.push({
        name,
        read: (binary = false) =>
          readLocalFile(full, {
            root: dir,
            maxBytes: binary ? CANVAS_ASSET_MAX_BYTES : SOLUTION_ASSET_LIMITS.entryBytes,
            ...(binary ? {} : { encoding: 'utf8' }),
          }),
      });
  }
  // Code-unit order: listing order differs between file systems, and the asset byte budget is spent in this order.
  return files.sort((a, b) => Number(a.name > b.name) - Number(a.name < b.name));
}

function addCanvasControls(sequence, prefix, parent, out, names, componentScope, context) {
  if (sequence === undefined) return;
  if (!isSeq(sequence)) {
    context.invalid(sequence, 'Children must be a sequence');
    return;
  }
  for (const item of sequence.items) addCanvasControlItem(item, prefix, parent, out, names, componentScope, context);
}

/* NOSONAR */ function addCanvasControlItem(item, prefix, parent, out, names, componentScope, context) {
  if (!isMap(item) || item.items.length !== 1) {
    context.invalid(item, 'Each child must name one control');
    return;
  }
  for (const [control, body] of entriesOf(item)) {
    if (!isMap(body)) {
      context.invalid(body, 'Control must be a mapping');
      continue;
    }
    const normalized = control.toLowerCase();
    if (names.has(normalized)) {
      context.invalid(body, 'Duplicate control definition');
      continue;
    }
    names.add(normalized);
    if (!componentScope && (context.appControlNames.has(normalized) || context.screenNames.has(normalized)))
      context.collision(body);
    if (!componentScope) context.appControlNames.add(normalized);
    out.push({
      name: control,
      control: text(field(body, 'Control')),
      parent,
      ...(field(body, 'Variant') ? { variant: text(field(body, 'Variant')) } : {}),
      ...(field(body, 'ComponentName') ? { componentName: text(field(body, 'ComponentName')) } : {}),
      ...(field(body, 'ComponentLibraryUniqueName')
        ? { componentLibraryUniqueName: text(field(body, 'ComponentLibraryUniqueName')) }
        : {}),
    });
    context.properties(field(body, 'Properties'), `${prefix}.${control}`);
    addCanvasControls(field(body, 'Children'), prefix, control, out, names, componentScope, context);
  }
}

function canvasCustomProperty(value, invalid) {
  const node = field(value, 'Parameters');
  let parametersValid = node === undefined || isSeq(node);
  const parameters = [];
  const names = new Set();
  if (isSeq(node))
    for (const item of node.items) {
      if (!isMap(item) || item.items.length !== 1) {
        parametersValid = false;
        continue;
      }
      const [[name, body]] = entriesOf(item);
      if (!isMap(body) || names.has(name.toLowerCase()) || !text(field(body, 'DataType'))) {
        parametersValid = false;
        continue;
      }
      names.add(name.toLowerCase());
      parameters.push({
        name,
        dataType: text(field(body, 'DataType')),
        optional: field(body, 'IsOptional')?.value === true,
        default: text(field(body, 'Default')),
      });
    }
  if (!parametersValid) invalid(node, 'Function parameters must be a sequence of uniquely named typed parameters');
  return {
    kind: text(field(value, 'PropertyKind')),
    dataType: text(field(value, 'DataType')),
    returnType: text(field(value, 'ReturnType')),
    default: text(field(value, 'Default')),
    ...(field(value, 'RaiseOnReset') ? { raiseOnReset: field(value, 'RaiseOnReset')?.value === true } : {}),
    parameters,
    parametersValid,
  };
}

function canvasProperties(node, owner, source, line, result, invalid) {
  if (node !== undefined && !isMap(node)) {
    invalid(node, 'Properties must be a mapping');
    return;
  }
  for (const [property, value, key] of entriesOf(node))
    result.formulas.push({ owner, property, text: text(value) ?? '', source, line: line(key) });
}

function processCanvasScreens(value, context) {
  for (const [screen, body] of entriesOf(value)) {
    const normalized = screen.toLowerCase();
    if (context.screenNames.has(normalized)) {
      context.invalid(body, 'Duplicate screen definition');
      continue;
    }
    context.screenNames.add(normalized);
    if (context.appControlNames.has(normalized) || context.componentNames.has(normalized)) context.collision(body);
    if (!isMap(body)) {
      context.invalid(body, 'Screen must be a mapping');
      continue;
    }
    const entry = { name: screen, controls: [] };
    context.properties(field(body, 'Properties'), screen);
    context.controls(field(body, 'Children'), screen, null, entry.controls);
    context.result.screens.push(entry);
  }
}

function processCanvasComponents(value, context) {
  for (const [component, body] of entriesOf(value)) {
    const normalized = component.toLowerCase();
    if (context.componentNames.has(normalized)) {
      context.invalid(body, 'Duplicate component definition');
      continue;
    }
    if (context.screenNames.has(normalized)) context.collision(body);
    context.componentNames.add(normalized);
    if (!isMap(body)) {
      context.invalid(body, 'Component definition must be a mapping');
      continue;
    }
    const custom = field(body, 'CustomProperties');
    if (custom !== undefined && !isMap(custom)) context.invalid(custom, 'CustomProperties must be a mapping');
    const entry = {
      name: component,
      definitionType: text(field(body, 'DefinitionType')),
      controls: [],
      ...(field(body, 'AccessAppScope') ? { accessAppScope: field(body, 'AccessAppScope')?.value === true } : {}),
      ...(custom
        ? {
            customProperties: Object.fromEntries(
              entriesOf(custom).map(([name, value]) => [name, canvasCustomProperty(value, context.invalid)]),
            ),
          }
        : {}),
    };
    context.properties(field(body, 'Properties'), component);
    context.controls(field(body, 'Children'), component, null, entry.controls, new Set(), true);
    context.result.components.push(entry);
  }
}

function processCanvasDataSources(value, result) {
  for (const [dataSource, body] of entriesOf(value)) {
    const table = text(field(field(body, 'Parameters'), 'TableLogicalName')),
      connectorId = text(field(body, 'ConnectorId'));
    result.dataSources.push({
      name: dataSource,
      kind: text(field(body, 'Type')),
      ...(table ? { table } : {}),
      ...(connectorId ? { connectorId } : {}),
    });
  }
}

function processCanvasTopLevel(key, value, keyNode, context) {
  if (!TOP_LEVEL.has(key)) {
    context.diagnostic(
      'CANVAS_SOURCE_SCHEMA_UNKNOWN',
      `${context.source}: top-level key "${key}" at line ${context.line(keyNode)} is not part of the pa.yaml v3.0 schema.`,
      context.source,
    );
    return;
  }
  if (!isMap(value)) {
    context.invalid(value, `${key} must be a mapping`);
    return;
  }
  if (key === 'App') context.properties(field(value, 'Properties'), 'App');
  else if (key === 'Screens') processCanvasScreens(value, context);
  else if (key === 'ComponentDefinitions') processCanvasComponents(value, context);
  else if (key === 'DataSources') processCanvasDataSources(value, context.result);
  else if (key === 'EditorState') {
    // Assumption: EditorState.ScreensOrder (pa.schema.yaml v3.0) is the Studio screen order; the first one is the default start screen.
    const order = field(value, 'ScreensOrder');
    if (isSeq(order)) context.result.app.screensOrder = order.items.map(text);
  }
}

function processCanvasYamlSource({
  content,
  source,
  result,
  screenNames,
  componentNames,
  appControlNames,
  unknownVersion,
  diagnostic,
}) {
  const counter = new LineCounter();
  const document = parseDocument(content, { lineCounter: counter, uniqueKeys: true });
  if (document.errors.length) {
    const [error] = document.errors;
    // The parser message quotes source text; report only position and code.
    diagnostic(
      'CANVAS_SOURCE_YAML_INVALID',
      `${source}: YAML parse error at line ${error.linePos?.[0]?.line ?? '?'} (${error.code}).`,
      source,
    );
    return unknownVersion;
  }
  const declared = /\$schema=\S*pa-yaml\/v(\d+(?:\.\d+)*)\//.exec(content)?.[1];
  if (declared && !CANVAS_SCHEMA_VERSIONS.includes(declared)) unknownVersion ??= declared;
  const line = (node) => (node?.range ? counter.linePos(node.range[0]).line : null);
  const invalid = (node, description) =>
    diagnostic('CANVAS_SOURCE_STRUCTURE_INVALID', `${source}: ${description} at line ${line(node) ?? '?'}.`, source);
  const collision = (node) =>
    diagnostic(
      'CANVAS_SOURCE_NAME_COLLISION',
      `${source}: Control name collides in the local runtime at line ${line(node) ?? '?'}.`,
      source,
    );
  const properties = (node, owner) => canvasProperties(node, owner, source, line, result, invalid);
  const controlContext = { invalid, properties, collision, appControlNames, screenNames };
  const controls = (sequence, prefix, parent, out, names = new Set(), componentScope = false) =>
    addCanvasControls(sequence, prefix, parent, out, names, componentScope, controlContext);
  const topLevelContext = {
    source,
    line,
    diagnostic,
    invalid,
    collision,
    properties,
    controls,
    screenNames,
    componentNames,
    appControlNames,
    result,
  };
  if (!isMap(document.contents)) {
    invalid(document.contents, 'Document must be a mapping');
    return unknownVersion;
  }
  for (const [key, value, keyNode] of entriesOf(document.contents))
    processCanvasTopLevel(key, value, keyNode, topLevelContext);
  return unknownVersion;
}

/** Inventory one canvas app. Pass `msapp` (bytes) or `dir` (an extracted `.msapp`); `name`/`version` come from the Solution when known. */
/* NOSONAR */ export async function readCanvasSource({ msapp, dir, name, version = null } = {}) {
  if ((msapp ? 1 : 0) === (dir ? 1 : 0)) throw new TypeError('readCanvasSource needs exactly one of msapp or dir.');
  const result = {
    app: { name: name ?? (dir ? path.basename(path.resolve(dir)) : 'App'), version, schemaVersion: null },
    screens: [],
    components: [],
    formulas: [],
    dataSources: [],
    diagnostics: [],
  };
  const diagnostic = (code, message, source = null, severity) =>
    result.diagnostics.push({ code, message, source, ...(severity ? { severity } : {}) });
  let files;
  if (msapp) {
    try {
      files = readSolutionAssetEntries(msapp, { include: wanted }).map((entry) => ({
        name: entry.name,
        read: () => entry.data.toString('utf8'),
      }));
    } catch (error) {
      diagnostic(
        'CANVAS_SOURCE_ARCHIVE_INVALID',
        `The .msapp archive cannot be read (${error.code ?? 'InvalidArchive'}).`,
        null,
        'error',
      );
      return result;
    }
  } else files = await directoryFiles(dir);
  const assets = new Map();
  const assetDiagnostic = (source = null) => {
    if (result.assetDiagnostics == null) result.assetDiagnostics = [];
    return result.assetDiagnostics.push({
      code: 'CANVAS_ASSET_UNAVAILABLE',
      message: 'One or more canvas media assets exceed limits or cannot be read.',
      source,
    });
  };
  let assetFiles = files.filter((file) => canvasAssetName(file.name));
  if (msapp) {
    try {
      assetFiles = readSolutionAssetEntries(msapp, {
        include: (name) => Boolean(canvasAssetName(name.replaceAll('\\', '/'))),
        entryBytes: CANVAS_ASSET_MAX_BYTES,
        totalBytes: CANVAS_ASSET_TOTAL_BYTES,
      }).map((entry) => ({ name: entry.name.replaceAll('\\', '/'), read: () => entry.data }));
    } catch {
      assetDiagnostic();
      assetFiles = [];
    }
  }
  let assetBytes = 0;
  for (const file of assetFiles) {
    const asset = canvasAssetName(file.name);
    try {
      const data = await file.read(true);
      assetBytes += data.length;
      if (
        assetBytes > CANVAS_ASSET_TOTAL_BYTES ||
        [...assets.keys()].some((name) => name.toLowerCase() === asset.name.toLowerCase())
      )
        throw new Error('Asset limit or duplicate');
      assets.set(asset.name, { type: asset.type, data });
    } catch {
      assetDiagnostic(file.name);
    }
  }
  if (assets.size) result[CANVAS_ASSETS] = assets;
  for (const file of files) file.name = file.name.replaceAll('\\', '/');
  // Code-unit order: a locale-aware order differs between processes, and the sources are read in this order.
  files.sort((left, right) => Number(left.name > right.name) - Number(left.name < right.name));

  const legacy = files.filter((file) => FX_YAML.test(file.name));
  const sources = files.filter((file) => SRC.test(file.name) && PA_YAML.test(file.name));
  if (!sources.length && legacy.some((file) => SRC.test(file.name))) {
    diagnostic(
      'CANVAS_SOURCE_LEGACY_FXYAML',
      `The app is read from the retired .fx.yaml format (${legacy.length} file(s)); re-save it in Power Apps Studio to get Src/*.pa.yaml.`,
      legacy[0].name,
    );
    await readFxYaml(files, result, diagnostic);
    const manifest = files.find((file) => LEGACY_MANIFEST_JSON.test(file.name));
    if (manifest) {
      try {
        const value = JSON.parse(await manifest.read());
        if (value.ScreenOrder !== undefined) {
          const names = new Set(result.screens.map((screen) => screen.name));
          if (
            !Array.isArray(value.ScreenOrder) ||
            value.ScreenOrder.some((name) => typeof name !== 'string' || !names.has(name)) ||
            new Set(value.ScreenOrder).size !== value.ScreenOrder.length
          )
            throw new Error('Invalid ScreenOrder');
          result.app.screensOrder = [...value.ScreenOrder];
        }
      } catch {
        diagnostic(
          'CANVAS_SOURCE_MANIFEST_INVALID',
          `${manifest.name} has invalid JSON or ScreenOrder.`,
          manifest.name,
          'error',
        );
      }
    }
    return result;
  }
  if (legacy.length)
    diagnostic(
      'CANVAS_SOURCE_LEGACY_FXYAML',
      `Retired .fx.yaml sources are ignored (${legacy.length} file(s)); re-save the app in Power Apps Studio to get Src/*.pa.yaml.`,
      legacy[0].name,
    );
  if (!sources.length) {
    diagnostic(
      'CANVAS_SOURCE_NO_PAYAML',
      'No Src/*.pa.yaml source code was found; re-save the app in Power Apps Studio.',
    );
    return result;
  }

  let unknownVersion = null;
  const screenNames = new Set();
  const componentNames = new Set();
  // The runtime resolves control formula owners across the app, including component definitions.
  const appControlNames = new Set();
  for (const file of sources) {
    const source = file.name,
      content = await file.read();
    unknownVersion = processCanvasYamlSource({
      content,
      source,
      result,
      screenNames,
      componentNames,
      appControlNames,
      unknownVersion,
      diagnostic,
    });
  }
  if (unknownVersion)
    diagnostic(
      'CANVAS_SOURCE_SCHEMA_UNKNOWN',
      `pa.yaml schema v${unknownVersion} is not recognised; known: ${CANVAS_SCHEMA_VERSIONS.join(', ')}.`,
    );
  result.app.schemaVersion = unknownVersion ?? CANVAS_SCHEMA_VERSIONS.at(-1);
  return result;
}

/**
 * The retired unpacked format: `Src/App.fx.yaml` (`App As appinfo`), one `Src/<Screen>.fx.yaml` per screen whose map mixes
 * `=formula` properties with `Name As type` child controls, `Src/Components/*.fx.yaml` (`Name As component`) and
 * `DataSources/<Name>.json`. The retired format's layout is not documented further.
 */
function walkFxNode(node, owner, screen, parent, out, componentScope, context) {
  for (const [key, value, keyNode] of entriesOf(node)) {
    const match = fxControl(key);
    if (!match) {
      context.result.formulas.push({
        owner,
        property: key,
        text: text(value) ?? '',
        source: context.source,
        line: context.line(keyNode),
      });
      continue;
    }
    const name = match[1]?.replaceAll("''", "'") ?? match[2];
    const normalized = name.toLowerCase();
    if (!componentScope && (context.controlNames.has(normalized) || context.screenNames.has(normalized)))
      context.collision(keyNode);
    if (!componentScope) context.controlNames.add(normalized);
    out.push({ name, control: match[3], parent });
    walkFxNode(value, `${screen}.${name}`, screen, name, out, componentScope, context);
  }
}

function processFxScreen(name, body, context) {
  const normalized = name.toLowerCase();
  if (context.screenNames.has(normalized) || context.controlNames.has(normalized)) context.collision(body);
  context.screenNames.add(normalized);
  const entry = { name, controls: [] };
  walkFxNode(body, name, name, null, entry.controls, false, context);
  context.result.screens.push(entry);
}

function processFxComponent(name, body, context) {
  const normalized = name.toLowerCase();
  if (context.componentNames.has(normalized)) {
    context.invalid(body, 'Duplicate component definition');
    return;
  }
  context.componentNames.add(normalized);
  const entry = { name, definitionType: 'CanvasComponent', controls: [] };
  walkFxNode(body, name, name, null, entry.controls, true, context);
  context.result.components.push(entry);
}

function processFxTopLevel(key, body, context) {
  const match = fxControl(key);
  const name = match ? (match[1]?.replaceAll("''", "'") ?? match[2]) : key;
  const type = match?.[3]?.toLowerCase();
  if (type === 'appinfo') walkFxNode(body, 'App', 'App', null, [], false, context);
  else if (type === 'screen') processFxScreen(name, body, context);
  else if (type === 'component' || type === 'canvascomponent') processFxComponent(name, body, context);
  else
    context.diagnostic(
      'CANVAS_SOURCE_SCHEMA_UNKNOWN',
      `${context.source}: top-level key "${key}" is not an appinfo, screen or component.`,
      context.source,
    );
}

function applyFxComponentMetadata(component, metadata, metadataFile, diagnostic) {
  const access = metadata.ComponentManifest?.AllowAccessToGlobals;
  if (typeof access === 'boolean') component.accessAppScope = access;
  if (Array.isArray(metadata.CustomProperties) && metadata.CustomProperties.length) {
    // Experimental JSON does not document property directions. Retain names
    // and types but never guess input versus output semantics.
    component.customProperties = Object.fromEntries(
      metadata.CustomProperties.filter((item) => typeof item.Name === 'string').map((item) => [
        item.Name,
        {
          kind: 'LegacyUnknown',
          directionKnown: false,
          functionScope: item.PropertyScopeKey != null,
          dataType: typeof item.PropertyDataTypeKey === 'string' ? item.PropertyDataTypeKey : null,
        },
      ]),
    );
    diagnostic(
      'CANVAS_COMPONENT_LEGACY_PROPERTY_UNKNOWN',
      'Legacy component property directions are not available from supported source metadata.',
      metadataFile.name,
    );
  }
}

function resolveFxComponentInstances(result, definitions) {
  for (const owner of [...result.screens, ...result.components])
    for (const control of owner.controls) {
      const definition = definitions.get(String(control.control ?? '').toLowerCase());
      if (definition) Object.assign(control, { control: 'CanvasComponent', componentName: definition.name });
    }
}

function processLegacyOptionSet(entry, enums, ambiguousEnums, file, diagnostic) {
  if (
    entry.Type === 'OptionSetInfo' &&
    typeof entry.DisplayName === 'string' &&
    entry.OptionSetInfoNameMapping &&
    typeof entry.OptionSetInfoNameMapping === 'object' &&
    !Array.isArray(entry.OptionSetInfoNameMapping)
  ) {
    const options = Object.entries(entry.OptionSetInfoNameMapping);
    const labels = options.map(([, label]) => (typeof label === 'string' ? label.toLowerCase() : null));
    const key = entry.DisplayName.toLowerCase();
    if (
      options.every(
        ([value, label]) =>
          /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value)) && typeof label === 'string' && label.length > 0,
      ) &&
      new Set(labels).size === labels.length &&
      entry.DisplayName.length > 0 &&
      !enums.has(key) &&
      !ambiguousEnums.has(key)
    ) {
      enums.set(key, [entry.DisplayName, Object.fromEntries(options.map(([value, label]) => [label, Number(value)]))]);
    } else {
      enums.delete(key);
      ambiguousEnums.add(key);
      diagnostic('CANVAS_SOURCE_OPTIONSET_INVALID', 'Legacy option-set mapping is invalid or ambiguous.', file.name);
    }
  } else if (entry.Type === 'OptionSetInfo')
    diagnostic('CANVAS_SOURCE_OPTIONSET_INVALID', 'Legacy option-set mapping cannot be read.', file.name);
}

function legacyFieldAliases(rawAliases, table, file, diagnostic) {
  if (!table || rawAliases === undefined) return undefined;
  if (!rawAliases || typeof rawAliases !== 'object' || Array.isArray(rawAliases)) {
    diagnostic(
      'CANVAS_SOURCE_DATASOURCE_ALIAS_INVALID',
      'Legacy data-source column aliases cannot be read.',
      file.name,
    );
    return undefined;
  }
  const pairs = Object.entries(rawAliases);
  const logicalCounts = new Map(),
    displayCounts = new Map();
  for (const [logical, display] of pairs) {
    if (logical && typeof display === 'string' && display) {
      const l = logical.toLowerCase(),
        d = display.toLowerCase();
      logicalCounts.set(l, (logicalCounts.get(l) ?? 0) + 1);
      displayCounts.set(d, (displayCounts.get(d) ?? 0) + 1);
    }
  }
  const valid = pairs.filter(
    ([logical, display]) =>
      logical &&
      typeof display === 'string' &&
      display &&
      logicalCounts.get(logical.toLowerCase()) === 1 &&
      displayCounts.get(display.toLowerCase()) === 1,
  );
  if (valid.length !== pairs.length)
    diagnostic(
      'CANVAS_SOURCE_DATASOURCE_ALIAS_INVALID',
      'Legacy data-source column aliases are invalid or ambiguous.',
      file.name,
    );
  return Object.fromEntries(valid);
}

function processLegacyDataSource(entry, result, enums, ambiguousEnums, file, diagnostic) {
  if (!entry?.Name || result.dataSources.some((item) => item.name === entry.Name)) return;
  processLegacyOptionSet(entry, enums, ambiguousEnums, file, diagnostic);
  const table = entry.TableLogicalName ?? entry.LogicalName ?? null;
  const connectorId = entry.ApiId ? String(entry.ApiId).split('/').at(-1) : null;
  const fieldAliases = legacyFieldAliases(entry.NativeCDSDataSourceInfoNameMapping, table, file, diagnostic);
  result.dataSources.push({
    name: entry.Name,
    kind: (() => {
      if (table) return 'Table';
      if (connectorId) return 'Actions';
      return String(entry.Type ?? 'Unknown');
    })(),
    ...(table ? { table } : {}),
    ...(connectorId ? { connectorId } : {}),
    ...(fieldAliases ? { fieldAliases } : {}),
  });
}

/* NOSONAR */ async function readFxYaml(files, result, diagnostic) {
  result.app.format = 'fx.yaml';
  const enums = new Map(),
    ambiguousEnums = new Set();
  const screenNames = new Set(),
    controlNames = new Set(),
    componentNames = new Set();
  for (const file of files.filter((item) => SRC.test(item.name) && FX_YAML.test(item.name))) {
    const source = file.name,
      counter = new LineCounter();
    const document = parseDocument(await file.read(), { lineCounter: counter, uniqueKeys: true });
    if (document.errors.length) {
      const [error] = document.errors;
      diagnostic(
        'CANVAS_SOURCE_YAML_INVALID',
        `${source}: YAML parse error at line ${error.linePos?.[0]?.line ?? '?'} (${error.code}).`,
        source,
      );
      continue;
    }
    const line = (node) => (node?.range ? counter.linePos(node.range[0]).line : null);
    /* NOSONAR: identical bodies capture different state */ const collision = (node) =>
      diagnostic(
        'CANVAS_SOURCE_NAME_COLLISION',
        `${source}: Control name collides in the local runtime at line ${line(node) ?? '?'}.`,
        source,
      );
    const invalid = (node, description) =>
      diagnostic('CANVAS_SOURCE_STRUCTURE_INVALID', `${source}: ${description} at line ${line(node) ?? '?'}.`, source);
    const context = { source, line, collision, invalid, result, controlNames, screenNames, componentNames, diagnostic };
    for (const [key, body] of entriesOf(document.contents)) processFxTopLevel(key, body, context);
  }
  // The deprecated unpacker emits component instances using the definition's
  // type name. Resolve only names present in its own component definitions.
  const definitions = new Map(result.components.map((item) => [item.name.toLowerCase(), item]));
  for (const component of result.components) {
    const metadataFile = files.find(
      (item) => item.name.toLowerCase() === `src/components/${component.name.toLowerCase()}.json`,
    );
    if (!metadataFile) continue;
    try {
      const metadata = JSON.parse(await metadataFile.read());
      applyFxComponentMetadata(component, metadata, metadataFile, diagnostic);
    } catch {
      diagnostic(
        'CANVAS_COMPONENT_LEGACY_METADATA_INVALID',
        'Legacy component metadata cannot be read.',
        metadataFile.name,
      );
    }
  }
  resolveFxComponentInstances(result, definitions);
  // Assumption: DataSources/<Name>.json is an array (or one object) of { Name, LogicalName|TableLogicalName, ApiId } entries.
  for (const file of files.filter((item) => DATA_SOURCE_JSON.test(item.name))) {
    let entries;
    try {
      entries = JSON.parse(await file.read());
    } catch {
      diagnostic('CANVAS_SOURCE_DATASOURCE_INVALID', `${file.name} is not valid JSON.`, file.name);
      continue;
    }
    for (const entry of [entries].flat()) {
      processLegacyDataSource(entry, result, enums, ambiguousEnums, file, diagnostic);
    }
  }
  if (enums.size) result.enums = Object.fromEntries(enums.values());
  result.app.schemaVersion = null;
}

/**
 * Solution inventory record for a canvas app. A parsed app (one screen or more) is hosted headlessly by canvas-runtime.mjs:
 * level `behaviour` (rendering is the documented `canvas:rendering` boundary), with `tree` (screens and components with
 * their control tree) and `unsupported` (controls the runtime lists but does not host); an app without readable source
 * stays `inventory` with the diagnostic as reason.
 */
// A readable screen does not prove the remaining source was parsed. Keep partial
// trees available for inspection, while exposing gaps to coverage consumers.
export function canvasSourceCoverageGaps(source) {
  return (prepareCanvasSource(source).diagnostics ?? []).filter(
    (item) =>
      item.code?.startsWith('CANVAS_COMPONENT_') ||
      [
        'CANVAS_SOURCE_YAML_INVALID',
        'CANVAS_SOURCE_SCHEMA_UNKNOWN',
        'CANVAS_SOURCE_DATASOURCE_INVALID',
        'CANVAS_SOURCE_DATASOURCE_ALIAS_INVALID',
        'CANVAS_SOURCE_OPTIONSET_INVALID',
        'CANVAS_SOURCE_STRUCTURE_INVALID',
        'CANVAS_SOURCE_NAME_COLLISION',
        'CANVAS_SOURCE_MANIFEST_INVALID',
      ].includes(item.code),
  );
}

export function canvasInventoryRecord(
  source,
  { id = null, solution = null, layer = null, file = null, format = null } = {},
) {
  const dependencies = [];
  for (const dataSource of source.dataSources) {
    if (dataSource.table) dependencies.push({ component: 'table', name: dataSource.table });
    if (dataSource.connectorId) dependencies.push({ component: 'connector', name: dataSource.connectorId });
  }
  const parsed = source.screens.length > 0;
  const sourceGaps = canvasSourceCoverageGaps(source);
  return {
    component: 'canvasapp',
    componentType: 300,
    id,
    name: source.app.name,
    version: source.app.version ?? null,
    solution,
    layer,
    source: file,
    format,
    dependencies,
    level: parsed ? 'behaviour' : 'inventory',
    reason: parsed
      ? null
      : (source.diagnostics.find((item) => item.severity === 'error')?.code ??
        source.diagnostics[0]?.code ??
        'CANVAS_SOURCE_NO_PAYAML'),
    ...(sourceGaps.length ? { sourceDiagnostics: sourceGaps } : {}),
    ...(source[CANVAS_ASSETS] ? { [CANVAS_ASSETS]: source[CANVAS_ASSETS] } : {}),
    ...(parsed ? { tree: canvasTree(source), unsupported: unsupportedControls(prepareCanvasSource(source)) } : {}),
  };
}

/** Screens and components with their control trees, the start-screen order and the source format (canvas-runtime.mjs input). */
const canvasTree = (source) => ({
  format: source.app.format ?? 'pa.yaml',
  screensOrder: source.app.screensOrder ?? null,
  screens: source.screens.map(({ name, controls }) => ({ name, controls })),
  components: source.components.map(({ name, definitionType, controls, accessAppScope, customProperties }) => ({
    name,
    definitionType,
    controls,
    ...(accessAppScope === undefined ? {} : { accessAppScope }),
    ...(customProperties === undefined ? {} : { customProperties }),
  })),
});

/**
 * Inventory records of the project `canvas.sources` paths (an `.msapp` file or an extracted folder each), resolved against
 * projectRoot. A record carries the parsed `canvas` facts canvasAppsOf (organization-host.mjs) serves under /_apps/canvas/
 * and `source` = the configured path. A missing or unreadable path is CANVAS_SOURCE_MISSING (an error diagnostic, no record).
 */
export async function readCanvasSources(sources = [], { projectRoot = process.cwd() } = {}) {
  const records = [],
    diagnostics = [];
  for (const source of sources ?? []) {
    const file = path.resolve(projectRoot, source);
    let stat, parsed;
    const name = path.basename(file).replace(/\.msapp$/i, '');
    try {
      stat = await fs.stat(file);
      parsed = stat.isDirectory()
        ? await readCanvasSource({ dir: file, name })
        : await readCanvasSource({
            msapp: await readLocalFile(file, { maxBytes: SOLUTION_ASSET_LIMITS.archiveBytes }),
            name,
          });
    } catch (error) {
      diagnostics.push({
        code: 'CANVAS_SOURCE_MISSING',
        severity: 'error',
        source,
        message: `Canvas source ${source} cannot be read (${error.code ?? 'unreadable'}); set canvas.sources to an .msapp file or an extracted app folder.`,
      });
      continue;
    }
    records.push({
      ...canvasInventoryRecord(parsed, { file: source, format: stat.isDirectory() ? 'directory' : 'msapp' }),
      canvas: {
        schemaVersion: parsed.app.schemaVersion,
        screens: parsed.screens.map((screen) => screen.name),
        components: parsed.components.map((component) => component.name),
        dataSources: parsed.dataSources,
        ...(parsed.enums ? { enums: parsed.enums } : {}),
        formulas: parsed.formulas,
        diagnostics: parsed.diagnostics,
        ...(parsed.assetDiagnostics?.length ? { assetDiagnostics: parsed.assetDiagnostics } : {}),
      },
    });
  }
  return { records, diagnostics };
}

/**
 * The file watch of the configured canvas.sources paths (resolved against projectRoot): `roots` for the watcher, and
 * `contains(file)`, true for a file under one of them outside VCS, dependency and build folders (never ignored by the watcher).
 */
export function canvasSourceWatch(sources = [], projectRoot = process.cwd()) {
  const roots = (sources ?? []).map((source) => path.resolve(projectRoot, source));
  const keys = roots.map((root) => root.toLowerCase());
  const contains = (file) => {
    const full = path.resolve(file).toLowerCase();
    const base = keys.find((root) => full === root || full.startsWith(root + path.sep));
    return (
      Boolean(base) &&
      !full
        .slice(base.length)
        .split(path.sep)
        .some((part) => /^(?:\.git|node_modules|\.paqvilo|bin|obj)$/i.test(part))
    );
  };
  return { roots, contains };
}

/** Validates the project `canvas` key: { enabled?: boolean, sources?: string[] }. Registered by provider-modules.mjs. */
export function canvasSettings(value, label = 'canvas') {
  if (value == null) return value;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value))
    if (!['enabled', 'sources', 'codeComponents'].includes(key))
      throw new Error(`Unknown ${label} key '${key}'; expected enabled, sources or codeComponents`);
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    throw new Error(`${label}.enabled must be true or false`);
  if (value.codeComponents !== undefined && typeof value.codeComponents !== 'boolean')
    throw new Error(`${label}.codeComponents must be true or false`);
  if (
    value.sources !== undefined &&
    (!Array.isArray(value.sources) || value.sources.some((source) => typeof source !== 'string' || !source.trim()))
  )
    throw new Error(`${label}.sources must be an array of non-empty paths`);
  return {
    ...(value.enabled !== undefined ? { enabled: value.enabled } : {}),
    ...(value.codeComponents !== undefined ? { codeComponents: value.codeComponents } : {}),
    ...(value.sources !== undefined ? { sources: [...value.sources] } : {}),
  };
}
