// Headless canvas app runtime: hosts the logic of a parsed canvas app (canvas-source.mjs) without rendering it. One app
// instance per app and principal holds the current screen and navigation history, global variables, per-screen context
// variables, collections, control input state, gallery selection, form state, notifications, launches and errors.
//
// Formulas run on the Power Fx engine's host contract (power-fx.mjs): every formula, behaviour or not, is one engine
// evaluation with `values` (screens and controls as lazy records, ThisItem, Self, Parent) and `host` (variables, the
// screen's context, Dataverse data sources, navigate/back/notify callbacks and the canvas-only functions SubmitForm,
// NewForm, EditForm, ViewForm, ResetForm, Reset, Select, Refresh and Launch). Set, UpdateContext, Collect, ClearCollect,
// Clear, Patch, Remove, If, IfError and every other function therefore behave the same at statement level and nested.
// Dataverse tables are the engine's data sources (power-fx-dataverse.mjs dataverseHost): reads delegate to the records
// layer as the caller (never SYSTEM) when the predicate is delegable, else read up to the data row limit with the
// engine's delegation warning; writes go through the records pipeline as the caller. Rows carry display-name aliases.
// Control properties are a reactive formula graph: a property is computed on read, memoized and dirtied when an input it
// read changes; a behaviour formula may change anything, so it clears the memo when it completes.
// Connector operations (`Source.Operation(...)`) are asynchronous: a formula suspends at a call that has no answer yet and
// runs again once it has one (see the behaviour section).
import { COMMON_DEFAULTS, CONTROL_CATALOGUE, controlKind, unsupportedControls } from './canvas-controls.mjs';
import { prepareCanvasSource } from './canvas-components.mjs';
import { CANVAS_ASSETS, canvasAssetUrls } from './canvas-assets.mjs';
import {
  CAUSE,
  ErrorKind,
  FxDataSource,
  FxDate,
  FxError,
  FxEnum,
  FxRecordRef,
  choiceDisplayValue,
  evaluateFx,
  fromFx,
  isNumeric,
  powerFxBuiltinEnums,
  parse as parsePowerFx,
  typedPowerFxFunction,
} from './power-fx.mjs';
import { dataverseHost } from './power-fx-dataverse.mjs';
import { isExactNumeric } from './exact-numeric.mjs';

const enumOf = (...names) => Object.freeze(Object.fromEntries(names.map((name) => [name, name])));
// Canvas enumerations the engine does not hold. Power Apps enum values are opaque; only equality is relied on.
const ENUMS = Object.freeze({
  FormMode: enumOf('Edit', 'New', 'View'),
  DisplayMode: enumOf('Edit', 'View', 'Disabled'),
  ScreenTransition: enumOf('None', 'Fade', 'Cover', 'CoverRight', 'UnCover', 'UnCoverRight'),
  ScreenSize: Object.freeze({ Small: 1, Medium: 2, Large: 3, ExtraLarge: 4 }),
  Layout: enumOf('Horizontal', 'Vertical'),
  LayoutDirection: enumOf('Horizontal', 'Vertical'),
  LayoutAlignItems: enumOf('Start', 'Center', 'End', 'Stretch'),
  LayoutJustifyContent: enumOf('Start', 'Center', 'End', 'SpaceBetween', 'SpaceAround', 'SpaceEvenly'),
  LayoutAlign: enumOf('SetByContainer', 'Start', 'Center', 'End', 'Stretch'),
  LayoutOverflow: enumOf('Hide', 'Scroll'),
  Font: enumOf(
    'Arial',
    'Arial Black',
    'ArialBlack',
    'Courier New',
    'CourierNew',
    'Georgia',
    'Lato',
    'Open Sans',
    'OpenSans',
    'Segoe UI',
    'SegoeUI',
    'Verdana',
  ),
  LayoutMode: enumOf('Auto', 'Manual'),
  Align: enumOf('Left', 'Center', 'Right', 'Justify'),
  TextFormat: enumOf('Text', 'Number'),
  FontWeight: enumOf('Normal', 'Lighter', 'Semibold', 'Bold'),
  DropShadow: enumOf('None', 'Light', 'Regular', 'Bold', 'ExtraBold'),
  LoadingSpinner: enumOf('None', 'Controls', 'Data'),
  TextMode: enumOf('SingleLine', 'MultiLine', 'Password'),
  BorderStyle: enumOf('None', 'Solid', 'Dashed', 'Dotted'),
  TextRole: enumOf('Default', 'Heading1', 'Heading2', 'Heading3', 'Heading4'),
  VerticalAlign: enumOf('Top', 'Middle', 'Bottom'),
  AlignInContainer: enumOf('SetByContainer', 'Start', 'Center', 'End', 'Stretch'),
  Icon: enumOf(
    'Add',
    'BackArrow',
    'Cancel',
    'Check',
    'ChevronDown',
    'ChevronLeft',
    'ChevronRight',
    'ChevronUp',
    'Close',
    'Delete',
    'Edit',
    'Filter',
    'Home',
    'Information',
    'Menu',
    'More',
    'NextArrow',
    'Refresh',
    'Save',
    'Search',
    'Settings',
    'Sort',
    'Trash',
    'View',
  ),
});
const CANVAS_DATA_ROW_LIMIT = 500;
const BEHAVIOUR_PROPERTY = /^On[A-Z]/;
const MAX_LOG = 200;
const MAX_CONNECTOR_CALLS = 50; // distinct connector answers one behaviour formula may wait for
const SUSPEND = Symbol('canvas.connector-pending');
const SCREEN = 'canvas-screen',
  CONTROL = 'canvas-control';
const kindName = (kind) =>
  typeof kind === 'number'
    ? (Object.keys(ErrorKind).find((name) => ErrorKind[name] === kind) ?? String(kind))
    : String(kind ?? 'Unknown');

// ---- formula text scanning (strings, quoted identifiers, comments and brackets aware) ----
function scan(text, visit) {
  let depth = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (char === '"' || (char === '$' && text[index + 1] === '"')) {
      if (char === '$') index++;
      // ponytail: an interpolated string's holes are skipped as text; a `"` inside a hole ends it early.
      for (index++; index < text.length; index++)
        if (text[index] === '"') {
          if (text[index + 1] === '"') index++;
          else break;
        }
      continue;
    }
    if (char === "'") {
      for (index++; index < text.length; index++)
        if (text[index] === "'") {
          if (text[index + 1] === "'") index++;
          else break;
        }
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index++;
      continue;
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end < 0 ? text.length : end + 1;
      continue;
    }
    if ('([{'.includes(char)) {
      if (visit(char, index, depth) === false) return;
      depth++;
      continue;
    }
    if (')]}'.includes(char)) {
      depth--;
      if (visit(char, index, depth) === false) return;
      continue;
    }
    if (visit(char, index, depth) === false) return;
  }
}
/** Split at a separator outside brackets and strings. */
export function splitTop(text, separator) {
  const parts = [];
  let start = 0;
  scan(text, (char, index, depth) => {
    if (char === separator && depth === 0) {
      parts.push(text.slice(start, index));
      start = index + 1;
    }
  });
  parts.push(text.slice(start));
  return parts.map((part) => part.trim());
}
const closing = (text, open) => {
  let found = -1;
  scan(text.slice(open), (char, index, depth) => {
    if (char === ')' && depth === 0) {
      found = open + index;
      return false;
    }
  });
  return found;
};
const unquote = (name) => (/^'.*'$/s.test(name) ? name.slice(1, -1).replaceAll("''", "'") : name);
const staticIdentifier = (text) => {
  try {
    const node = parsePowerFx(text ?? '');
    return node.t === 'id' && !node.global ? node.name : null;
  } catch {
    return null;
  }
};
/** Every call `Name(` (or `Source.Op(`) outside strings, outermost first: [{ start, open, end, name, member }]. */
function callsIn(text, accept) {
  const calls = [];
  scan(text, (char, index) => {
    if (char !== '(') return;
    const head = /(?:([A-Za-z_][\w]*)\s*\.\s*)?([A-Za-z_][\w]*)\s*$/.exec(text.slice(0, index));
    if (!head || /[\w.]$/.test(text.slice(0, head.index))) return;
    const call = { start: head.index, open: index, name: head[1] ?? head[2], member: head[1] ? head[2] : null };
    if (!accept(call)) return;
    call.end = closing(text, index);
    if (call.end > 0) calls.push(call);
  });
  return calls;
}

const isPlain = (value) =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;
const blank = (value) => value === undefined || value === null || value === '';
const literal = (raw) =>
  raw === 'true' ? true : raw === 'false' ? false : raw !== '' && Number.isFinite(Number(raw)) ? Number(raw) : raw;
const fail = (message, code, status = 400) => Object.assign(new Error(message), { code, status });

/** Validate and copy a player viewport before any app behavior runs. */
export function canvasViewport(viewport) {
  const { width, height } = viewport ?? {};
  if (![width, height].every((value) => Number.isInteger(value) && value >= 1 && value <= 8192))
    throw fail('viewport needs integer width and height between 1 and 8192.', 'CanvasActionInvalid');
  return { width, height };
}

/** A JSON-safe copy of a formula value for snapshots and API answers. */
function observable(value, depth = 0) {
  if (value === undefined || value === null) return null;
  // An exact decimal (exact-numeric.mjs) stays exact: canvas-http.mjs writes it with stringifyExactJson, every digit kept.
  if (isExactNumeric(value)) return value;
  if (value instanceof FxError)
    return { error: value.errors.map((item) => ({ kind: kindName(item.Kind), message: item.Message ?? null })) };
  if (value instanceof FxDataSource) return { dataSource: value.name };
  if (value instanceof FxRecordRef && value.canvasName)
    return { [value.table === SCREEN ? 'screen' : 'control']: value.canvasName };
  if (typeof value === 'object' && !Array.isArray(value) && !isPlain(value)) return fromFx(value);
  if (typeof value === 'function' || typeof value === 'symbol') return null;
  if (typeof value !== 'object' || depth > 6) return value;
  if (Array.isArray(value)) return value.map((item) => observable(item, depth + 1));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, observable(item, depth + 1)]));
}

/**
 * One app instance. `app` = { uniqueName, source } (canvas-http.mjs entries; `source.tree` from canvasTree, else
 * `source.screens` with controls); `evaluator` = createPowerFxEvaluator() (the core engine; a pack adapter receives the same
 * values and host); `principal` = { kind, principalId }; `api` = the organization api and `caller(principal)` → the write
 * context `{ user[, caller] }` (null: no Dataverse data sources); `transact(fn)` runs one behaviour formula's writes
 * (the host change slot); `connectors({ reference, operationId, body, principal, caller: 'canvas' })` → result or
 * undefined; `launch(entry)` hears every Launch; `diagnostic(record)` receives runtime diagnostics.
 */
export function createCanvasApp({
  app,
  evaluator,
  principal = null,
  api = null,
  caller = null,
  transact = (fn) => fn(),
  connectors = null,
  launch = () => {},
  diagnostic = () => {},
  parameters = {},
  viewport = { width: 1366, height: 768 },
}) {
  if (!evaluator) throw new TypeError('createCanvasApp needs the Power Fx evaluator (createPowerFxEvaluator).');
  if (app.source?.diagnostics?.some((entry) => entry.code === 'CANVAS_SOURCE_NAME_COLLISION'))
    throw fail('Canvas source has colliding names and cannot be hosted safely.', 'CanvasSourceNameCollision', 501);
  const core = evaluator.describe?.().source === 'core';
  const context = api && caller ? caller(principal) : null;
  if (api && caller && !context?.user)
    throw fail('The principal running the canvas app is not a Dataverse user.', 'CanvasPrincipalUnavailable', 401);
  const source = prepareCanvasSource(app.source);
  const records = context
    ? dataverseHost(api, {
        c: context,
        fieldAliases: source.dataSources,
        diagnostic: (entry) => hostDiagnostic(entry, 'Dataverse'),
      })
    : null;
  const tree = source.tree ?? {
    format: source.app?.format ?? 'pa.yaml',
    screens: source.screens ?? [],
    components: source.components ?? [],
  };
  const format = tree.format ?? 'pa.yaml';

  // ---- static model ----
  const formulas = new Map();
  for (const row of source.formulas ?? []) {
    const owner = row.owner.includes('.') ? row.owner.slice(row.owner.indexOf('.') + 1) : row.owner;
    if (!formulas.has(owner)) formulas.set(owner, new Map());
    const raw = String(row.text ?? '').trimStart();
    const blankFormula = /^=(?:\s|\/\/[^\r\n]*(?:\r?\n|$)|\/\*(?:[^*]|\*+[^*/])*\*+\/)*$/.test(raw);
    // A formula starts with `=`; any other scalar is a literal value.
    formulas.get(owner).set(
      row.property,
      raw.startsWith('=') && !blankFormula
        ? {
            formula: raw.slice(1).trim(),
            source: row.source,
            line: row.line,
            componentDefinition: row.componentDefinition,
          }
        : {
            value: blankFormula ? null : literal(raw),
            source: row.source,
            line: row.line,
            componentDefinition: row.componentDefinition,
          },
    );
  }
  const screens = new Map(),
    controls = new Map(),
    lower = new Map();
  for (const screen of tree.screens) {
    if (lower.has(screen.name.toLowerCase()))
      throw fail('Canvas source has colliding names and cannot be hosted safely.', 'CanvasSourceNameCollision', 501);
    screens.set(screen.name, { name: screen.name });
    lower.set(screen.name.toLowerCase(), screen.name);
    for (const control of screen.controls ?? []) {
      if (lower.has(control.name.toLowerCase()))
        throw fail('Canvas source has colliding names and cannot be hosted safely.', 'CanvasSourceNameCollision', 501);
      const sourceKind = controlKind(control.control, format);
      const kind = control.componentName && sourceKind !== 'codecomponent' ? null : sourceKind;
      controls.set(control.name, {
        name: control.name,
        type: control.control ?? null,
        modern: /^modern/i.test(control.control ?? ''),
        variant: control.variant ?? null,
        kind,
        supported: Boolean(kind),
        screen: screen.name,
        parent: control.parent ?? null,
        children: [],
      });
      lower.set(control.name.toLowerCase(), control.name);
    }
  }
  for (const control of controls.values())
    if (control.parent) controls.get(control.parent)?.children.push(control.name);
  const order = (tree.screensOrder ?? []).filter((name) => screens.has(name));
  const screenNames = [...order, ...[...screens.keys()].filter((name) => !order.includes(name))];
  const dataSources = new Map((source.dataSources ?? []).map((entry) => [entry.name, entry]));
  const unsupported = unsupportedControls({ tree, app: source.app });
  const namedFormulas = new Map(
    splitTop(formulas.get('App')?.get('Formulas')?.formula ?? '', ';')
      .filter(Boolean)
      .map((entry) => {
        const at = entry.indexOf('=');
        return [unquote(entry.slice(0, at).trim()), entry.slice(at + 1).trim()];
      })
      .filter(([name, formula]) => name && formula),
  );
  const kindOf = (name) => controls.get(name)?.kind;
  const ancestors = (name) => {
    const out = [];
    for (let at = controls.get(name)?.parent; at; at = controls.get(at)?.parent) out.push(at);
    return out;
  };
  const formOf = (name) => ancestors(name).find((at) => ['form', 'formviewer'].includes(kindOf(at))) ?? null;
  const galleryOf = (name) => ancestors(name).find((at) => kindOf(at) === 'gallery') ?? null;
  const descendants = (name) => (controls.get(name)?.children ?? []).flatMap((child) => [child, ...descendants(child)]);

  const formulaComponent = (name, entry) => {
    let component = source.componentScopes?.[name];
    if (!entry.componentDefinition) return source.componentScopes?.[component?.parent];
    while (component && component.definition !== entry.componentDefinition)
      component = source.componentScopes?.[component.parent];
    return component;
  };

  // ---- state ----
  // Set, UpdateContext, Navigate's context record, Collect and ClearCollect establish a name, which reads
  // blank (a collection: empty) until a formula fills it.
  const componentVariables = new Map();
  const variables = {},
    globals = new Set(),
    collections = new Set(),
    contexts = new Map(screenNames.map((name) => [name, {}]));
  // Legacy exports can declare local collections as data sources. They are local state, not table providers.
  for (const entry of dataSources.values()) {
    if (String(entry.kind).toLowerCase() === 'collectiondatasourceinfo') {
      variables[entry.name] = [];
      collections.add(entry.name);
    }
  }
  const recordKeys = (text) =>
    /^\{[\s\S]*\}$/.test(text?.trim() ?? '')
      ? splitTop(text.trim().slice(1, -1), ',')
          .map((entry) => unquote(entry.slice(0, entry.indexOf(':')).trim()))
          .filter(Boolean)
      : [];
  for (const [owner, properties] of formulas)
    for (const entry of properties.values()) {
      if (!entry.formula) continue;
      const home = screens.has(owner) ? owner : controls.get(owner)?.screen;
      const component = formulaComponent(owner, entry);
      let target = variables;
      if (component && !component.accessAppScope) {
        if (!componentVariables.has(component.root)) componentVariables.set(component.root, {});
        target = componentVariables.get(component.root);
      }
      for (const call of callsIn(
        entry.formula,
        (item) => !item.member && ['Set', 'UpdateContext', 'Navigate', 'Collect', 'ClearCollect'].includes(item.name),
      )) {
        const args = splitTop(entry.formula.slice(call.open + 1, call.end), ',');
        const first = staticIdentifier(args[0]);
        if (call.name === 'Set' && first) {
          target[first] ??= null;
          if (target === variables) globals.add(first);
        } else if (call.name.endsWith('Collect') && first && !dataSources.has(first)) {
          if (target === variables) collections.add(first);
          target[first] = [];
        } else if (call.name === 'UpdateContext') {
          for (const key of recordKeys(args[0])) if (contexts.has(home)) contexts.get(home)[key] ??= null;
        } else if (call.name === 'Navigate') {
          const target = first,
            screen = screens.has(target) ? target : controls.get(target)?.screen;
          for (const key of recordKeys(args[2])) if (contexts.has(screen)) contexts.get(screen)[key] ??= null;
        }
      }
    }
  const state = {
    current: null,
    transition: 'None',
    clockKey: crypto.randomUUID(),
    viewport: canvasViewport(viewport),
    history: [],
    inputs: new Map(),
    selected: new Map(),
    windows: new Map(),
    timers: new Map(),
    media: new Map(),
    forms: new Map(),
    notifications: [],
    launches: [],
    errors: [],
    log: [],
    diagnostics: [],
    started: false,
  };
  const cache = new Map(),
    dependents = new Map(),
    stack = [];
  let pending = [];
  const log = (entry) => {
    state.log.push(entry);
    if (state.log.length > MAX_LOG) state.log.shift();
  };
  const report = (entry) => {
    if (state.diagnostics.some((item) => item.code === entry.code && item.source === entry.source)) return;
    state.diagnostics.push(entry);
    diagnostic({ ...entry, app: app.uniqueName });
  };
  const assetSymbols = new Map();
  const ambiguousAssets = new Set();
  const assets = source[CANVAS_ASSETS];
  if (assets instanceof Map) {
    for (const [filename, url] of Object.entries(canvasAssetUrls(app.uniqueName, assets))) {
      const basename = filename.split('/').at(-1);
      const stem = basename.slice(0, basename.lastIndexOf('.'));
      if (!/^[A-Za-z_][\w]*$/.test(stem)) continue;
      const key = stem.toLowerCase();
      if (assetSymbols.has(key)) ambiguousAssets.add(key);
      else assetSymbols.set(key, { stem, url });
    }
    for (const key of ambiguousAssets) {
      assetSymbols.delete(key);
      report({
        code: 'CANVAS_ASSET_NAME_AMBIGUOUS',
        source: key,
        message: 'Multiple assets share this formula identifier.',
      });
    }
  }
  const sourceEnums = new Map();
  const conflictingEnums = new Set();
  const reservedEnumNames = new Set(
    [
      'app',
      ...Object.keys(ENUMS),
      ...powerFxBuiltinEnums(),
      ...lower.keys(),
      ...dataSources.keys(),
      ...namedFormulas.keys(),
      ...Object.keys(variables),
      ...[...contexts.values()].flatMap((entry) => Object.keys(entry)),
      ...[...componentVariables.values()].flatMap((entry) => Object.keys(entry)),
      ...Object.values(source.componentScopes ?? {}).flatMap((entry) => [
        entry.definition,
        ...Object.keys(entry.locals ?? {}),
      ]),
      ...[...assetSymbols.values()].map((entry) => entry.stem),
    ].map((name) => name.toLowerCase()),
  );
  for (const [name, entries] of Object.entries(source.enums ?? {})) {
    const key = name.toLowerCase();
    if (reservedEnumNames.has(key) || sourceEnums.has(key)) {
      conflictingEnums.add(key);
      continue;
    }
    if (!name || ['__proto__', 'constructor', 'prototype'].includes(key) || !isPlain(entries)) {
      conflictingEnums.add(key);
      continue;
    }
    const labels = Object.entries(entries),
      seen = new Set();
    if (
      labels.some(([label, value]) => {
        const normalized = label.toLowerCase();
        if (!label || seen.has(normalized) || !Number.isSafeInteger(value)) return true;
        seen.add(normalized);
        return false;
      })
    ) {
      conflictingEnums.add(key);
      continue;
    }
    sourceEnums.set(key, { name, value: new FxEnum(name, entries) });
  }
  for (const key of conflictingEnums) {
    sourceEnums.delete(key);
    report({
      code: 'CANVAS_ENUM_NAME_AMBIGUOUS',
      source: key,
      message: 'The source option enum name or labels are ambiguous.',
    });
  }
  // The engine's warnings (delegation): fromFx of a data source passed to a canvas function is not a query, so it is not reported.
  function hostDiagnostic(entry, where) {
    if (entry?.operation !== 'fromFx') report({ ...entry, source: where });
  }
  const track = (key) => {
    if (stack.length) {
      if (!dependents.has(key)) dependents.set(key, new Set());
      dependents.get(key).add(stack.at(-1));
    }
  };
  const changed = (key) => {
    const queue = [key];
    while (queue.length) {
      const next = queue.pop();
      for (const dependent of dependents.get(next) ?? []) {
        cache.delete(dependent);
        if (dependent.startsWith('prop:')) {
          const property = dependent.slice(5);
          propertyAnswers.delete(property.includes('#') ? property : `${property}#`);
        }
        queue.push(dependent);
      }
      dependents.delete(next);
    }
  };
  const forget = () => {
    cache.clear();
    dependents.clear();
  };
  const pushError = (entry, dedupe) => {
    if (dedupe && state.errors.some((item) => item.source === entry.source && item.message === entry.message))
      return entry;
    state.errors.push(entry);
    if (state.errors.length > MAX_LOG) state.errors.shift();
    return entry;
  };
  const location = (where) => {
    let entry;
    for (const [owner, properties] of formulas) {
      if (where.startsWith(`${owner}.`)) {
        entry = properties.get(where.slice(owner.length + 1));
        if (entry) break;
      }
    }
    if (!entry && where.startsWith('App.Formulas.')) entry = formulas.get('App')?.get('Formulas');
    return entry?.source ? { file: entry.source, ...(entry.line ? { line: entry.line } : {}) } : {};
  };
  // A plug-in fault's trace identity (plugin-fault.mjs traceError) stays on the entry, non-enumerable, so the snapshot and
  // the answer are unchanged and the canvas host's trace spans record the fault as the Dataverse spans do (D-R3-19).
  const fromError = (error, where) => {
    const entry = {
      ...location(where),
      code: error.code ?? 'CanvasFormulaError',
      kind: error.details?.kind ?? error.kind ?? 'Unknown',
      message: error.message,
      source: where,
      ...(error.status ? { status: error.status } : {}),
    };
    if (error.traceError) Object.defineProperty(entry, 'traceError', { value: error.traceError });
    return entry;
  };
  // A data source refusal keeps its cause; a plug-in fault's trace identity rides along as for fromError.
  const fromFxError = (value, where) =>
    value.errors.map((item) => {
      const entry = {
        ...location(where),
        code: 'PowerFxError',
        kind: kindName(item.Kind),
        message: item.Message ?? '',
        source: where,
        ...(item.Details?.HttpStatusCode ? { status: item.Details.HttpStatusCode } : {}),
      };
      const traceError = item[CAUSE]?.traceError;
      if (traceError) Object.defineProperty(entry, 'traceError', { value: traceError });
      return entry;
    });

  const isBehaviour = (name, property) =>
    BEHAVIOUR_PROPERTY.test(property) ||
    (source.codeComponents?.[name]?.events ?? []).includes(property) ||
    Boolean(source.componentFunctions?.[name]?.[property]);

  // ---- formula scope ----
  // A screen or control as a lazy record: the engine reads one property at a time through the getters.
  const reference = (name, scope) => {
    const isScreen = screens.has(name) && !controls.has(name);
    const ref = new FxRecordRef(isScreen ? SCREEN : CONTROL, name, () => {
      const target = {};
      const names = new Set([
        ...(formulas.get(name)?.keys() ?? []),
        ...Object.keys(COMMON_DEFAULTS),
        ...Object.keys(CONTROL_CATALOGUE[isScreen ? 'screen' : kindOf(name)]?.defaults ?? {}),
        ...(OUTPUTS[isScreen ? 'screen' : kindOf(name)] ?? []),
        ...(source.codeComponents?.[name]?.properties?.map((property) => property.name) ?? []),
      ]);
      // Behaviour properties (On…) run only as behaviour; they are not values of the record.
      for (const property of names)
        if (!isBehaviour(name, property))
          Object.defineProperty(target, property, { enumerable: true, get: () => read(name, property, scope) });
      if (isScreen) target.Name = name;
      return target;
    });
    ref.canvasName = name;
    return ref;
  };
  const nameOf = (value) => {
    const id =
      value instanceof FxRecordRef
        ? value.canvasName
        : isPlain(value) && [SCREEN, CONTROL].includes(value.logical_name)
          ? lower.get(value.id)
          : null;
    return id ?? null;
  };
  const screenOf = (scope) => scope.screen ?? (scope.control ? controls.get(scope.control)?.screen : null);
  const values = (scope = {}) => {
    const out = { ...ENUMS };
    for (const { name, value } of sourceEnums.values())
      Object.defineProperty(out, name, { value, enumerable: true, configurable: true, writable: true });
    if (scope.pureComponent) return Object.assign(out, scope.extra ?? {});
    const define = (name, get) => Object.defineProperty(out, name, { enumerable: true, configurable: true, get });
    const component = scope.component;
    for (const { stem, url } of assetSymbols.values())
      if ((component && !component.accessAppScope) || !lower.has(stem.toLowerCase())) define(stem, () => url);
    if (!component || component.accessAppScope) {
      for (const name of screenNames) define(name, () => reference(name, {}));
      for (const name of controls.keys())
        define(name, () => reference(name, galleryOf(name) && scope.gallery === galleryOf(name) ? scope : {}));
      for (const name of namedFormulas.keys()) define(name, () => read('App', `#formula:${name}`, {}));
      define('App', () => ({
        get Width() {
          return read('App', 'Width');
        },
        get Height() {
          return read('App', 'Height');
        },
        get MinScreenWidth() {
          return read('App', 'MinScreenWidth');
        },
        get MinScreenHeight() {
          return read('App', 'MinScreenHeight');
        },
        get SizeBreakpoints() {
          return read('App', 'SizeBreakpoints');
        },
        get ActiveScreen() {
          track('screen:current');
          return state.current ? reference(state.current, {}) : null;
        },
      }));
    }
    if (component) {
      define(component.definition, () => reference(component.root, scope));
      for (const [name, internal] of Object.entries(component.locals)) define(name, () => reference(internal, scope));
    }
    if (scope.control) {
      out.Self = reference(scope.control, scope);
      const parent = controls.get(scope.control)?.parent ?? controls.get(scope.control)?.screen;
      if (parent) out.Parent = reference(parent, scope);
      const form = formOf(scope.control);
      if (scope.item !== undefined) out.ThisItem = out.ThisRecord = scope.item;
      else if (form) define('ThisItem', () => formRecord(form));
    }
    return Object.assign(out, scope.extra ?? {});
  };
  // Track scalar variable and context reads so a Set/UpdateContext invalidates only affected property answers.
  const trackedState = (target, prefix) =>
    target &&
    new Proxy(target, {
      get(object, key, receiver) {
        if (typeof key === 'string') track(`${prefix}:${key}`);
        return Reflect.get(object, key, receiver);
      },
      set(object, key, value, receiver) {
        const before = object[key];
        const ok = Reflect.set(object, key, value, receiver);
        if (ok && typeof key === 'string' && !Object.is(before, value)) changed(`${prefix}:${key}`);
        return ok;
      },
    });
  const localVariables = (root) => {
    if (!componentVariables.has(root)) componentVariables.set(root, {});
    return componentVariables.get(root);
  };
  const hostFor = (scope, where) =>
    scope.pureComponent
      ? {
          pureComponent: true,
          ...(scope.componentArguments ? { scope: scope.extra } : {}),
          functions: {},
          random: () => journaled('random', Math.random),
          now: () => journaled('now', records ? records.now : Date.now),
        }
      : {
          ...(scope.componentArguments ? { scope: scope.extra } : {}),
          variables:
            scope.component && !scope.component.accessAppScope
              ? trackedState(localVariables(scope.component.root), `component:${scope.component.root}`)
              : trackedState(variables, 'variable'),
          context:
            scope.component && !scope.component.accessAppScope
              ? undefined
              : trackedState(contexts.get(screenOf(scope)), `context:${screenOf(scope)}`),
          app: 'canvas',
          dataRowLimit: CANVAS_DATA_ROW_LIMIT,
          dataSource: (name) => {
            if (scope.component && !scope.component.accessAppScope) return undefined;
            const entry = dataSources.get(name),
              table = entry?.table ?? name;
            // By entity set: a store mapping keyed by logical name need not repeat its logicalName.
            const found = records?.dataSource(api.store?.state?.mappings?.[table]?.entitySet ?? table);
            if (found) return new FxDataSource(name, journaledAdapter(found.adapter, name));
            if (entry && String(entry.kind).toLowerCase() === 'table') {
              const message = `Canvas data source ${name} is declared but has no configured local table.`;
              report({ code: 'CANVAS_DATASOURCE_UNAVAILABLE', source: name, message });
              return new FxError([{ Kind: ErrorKind.NotSupported, Message: message }]);
            }
            return undefined;
          },
          diagnostic: (entry) => hostDiagnostic(entry, where),
          ...(records ? { user: records.user, timeZone: records.timeZone, language: records.language } : {}),
          // Now() and GUID() answer from the replay journal when a behaviour formula runs again after a connector answer.
          now: () => journaled('now', records ? records.now : Date.now),
          guid: () => journaled('guid', () => crypto.randomUUID()),
          random: () => journaled('random', Math.random),
          // Navigation is applied when the behaviour formula completes; the docs state that queueing for Select only, so it is a guess here.
          navigate: (target, transition, update) => {
            const named = nameOf(target),
              screen = screens.has(named) ? named : controls.get(named)?.screen;
            if (!screen) throw fail(`Navigate target is not a screen of this app.`, 'CanvasScreenNotFound', 404);
            pending.push(
              Object.assign(
                () =>
                  show(screen, {
                    transition: transition ?? 'None',
                    update: isPlain(update) ? update : null,
                    push: true,
                  }),
                { navigation: 'navigate' },
              ),
            );
          },
          // Back answers whether there is an earlier screen, counting the navigations this formula has queued.
          back: (transition) => {
            const depth =
              state.history.length +
              pending.filter((task) => task.navigation === 'navigate').length -
              pending.filter((task) => task.navigation === 'back').length;
            if (depth < 2) return false;
            pending.push(Object.assign(() => goBack(transition), { navigation: 'back' }));
            return true;
          },
          notify: (message, type, timeout) => {
            state.notifications.push({
              message: String(message ?? ''),
              type: type || 'Information',
              timeout: timeout || 10000,
            });
            log({ event: 'notify', type });
          },
          trace: (message) => log({ event: 'trace', message: String(message) }),
          functions: new Proxy(canvasFunctions(scope, where), {
            get: (target, name) =>
              typeof name !== 'string'
                ? undefined
                : Object.hasOwn(target, name)
                  ? target[name]
                  : (componentFunction(name, scope) ??
                    connectorFunction(name, scope.connectors ?? { list: [], next: 0 })),
          }),
        };
  const evaluate = (text, scope, where) =>
    core
      ? evaluateFx(text, { values: values(scope), host: hostFor(scope, where) }).value
      : evaluator.evaluateSync(text, { symbols: {}, values: values(scope), principal, host: hostFor(scope, where) })
          .value;

  // ---- reactive properties ----
  const keyOf = (name, property, scope) =>
    `prop:${name}.${property}${scope.itemIndex !== undefined ? `#${scope.itemIndex}` : ''}`;
  function read(name, property, scope = {}) {
    const key = keyOf(name, property, scope);
    track(key);
    if (cache.has(key)) return cache.get(key);
    if (stack.includes(key)) {
      const loop = [...stack.slice(stack.indexOf(key)), key].map((item) => item.slice(5));
      report({
        code: 'CANVAS_FORMULA_CYCLE',
        source: loop[0],
        properties: loop,
        message: `Formula cycle: ${loop.join(' → ')}; the property reads blank.`,
      });
      return null;
    }
    stack.push(key);
    // A gallery row's property depends on the row: it is dirtied with the gallery's Items.
    if (scope.gallery && scope.itemIndex !== undefined) track(`prop:${scope.gallery}.Items`);
    if (scope.option && scope.itemIndex !== undefined) track(`prop:${name}.Items`);
    let value;
    try {
      value = compute(name, property, scope);
      if (property === 'Text' && ['label', 'button', 'textinput'].includes(kindOf(name)))
        value = choiceDisplayValue(value);
    } finally {
      stack.pop();
    }
    cache.set(key, value);
    return value;
  }
  // A property formula's value; an error value or a failed evaluation reads blank and is recorded once.
  const pure = (formula, scope, where) => {
    const tapeKey = `${where}#${scope.itemIndex ?? ''}`;
    if (!propertyAnswers.has(tapeKey)) propertyAnswers.set(tapeKey, []);
    try {
      const value = evaluate(
        formula,
        { ...scope, connectors: { list: propertyAnswers.get(tapeKey), next: 0, key: tapeKey } },
        where,
      );
      if (value instanceof FxError) {
        for (const entry of fromFxError(value, where)) pushError(entry, true);
        return null;
      }
      return value ?? null;
    } catch (error) {
      // A property formula's connector call: blank until settle() has the answer (then the property is computed again).
      if (error?.[SUSPEND]) {
        propertyWaits.set(tapeKey, error[SUSPEND]);
        return null;
      }
      pushError(fromError(error, where), true);
      return null;
    }
  };
  const declared = (name, property, scope) => {
    const entry = formulas.get(name)?.get(property);
    if (!entry) return { found: false };
    return {
      found: true,
      value:
        'formula' in entry
          ? pure(
              entry.formula,
              {
                ...scope,
                component: formulaComponent(name, entry),
                control: controls.has(name) ? name : undefined,
                screen: screens.has(name) && !controls.has(name) ? name : scope.screen,
              },
              `${name}.${property}`,
            )
          : entry.value,
    };
  };
  const fallback = (name, property, scope) => {
    const result = declared(name, property, scope);
    if (result.found) return result.value;
    const kind = screens.has(name) && !controls.has(name) ? 'screen' : kindOf(name);
    if (Object.hasOwn(CONTROL_CATALOGUE[kind]?.defaults ?? {}, property))
      return CONTROL_CATALOGUE[kind].defaults[property];
    return COMMON_DEFAULTS[property] ?? null;
  };
  const input = (name, scope) => {
    const key = `input:${name}${scope.itemIndex !== undefined ? `#${scope.itemIndex}` : ''}`;
    track(key);
    return state.inputs.get(key);
  };
  // A table value's rows: a delegated data source query reads through its adapter (no row limit, no warning: the query
  // was delegated); a non-delegable formula already read its rows in the engine, with the warning.
  const rowsOf = (value) =>
    value instanceof FxDataSource ? value.adapter.read(value.query) : Array.isArray(value) ? value : [];
  const items = (name) => {
    const key = `rows:${name}`;
    track(key);
    if (cache.has(key)) return cache.get(key);
    stack.push(key);
    let rows;
    try {
      rows = rowsOf(read(name, 'Items', {}));
    } finally {
      stack.pop();
    }
    cache.set(key, rows);
    return rows;
  };
  const formState = (name) => {
    track(`form:${name}`);
    return state.forms.get(name) ?? {};
  };
  const formSource = (form) => {
    const value = read(form, 'DataSource', {});
    return value instanceof FxDataSource ? value : null;
  };
  const formRecord = (name) => {
    if (read(name, 'Mode', {}) === 'New') return formSource(name)?.adapter.defaults() ?? {};
    const item = read(name, 'Item', {});
    return item && typeof item === 'object' ? item : null;
  };
  const cards = (name) => descendants(name).filter((child) => kindOf(child) === 'card');
  const sameRow = (left, right) =>
    left === right ||
    (isPlain(left) && isPlain(right) && JSON.stringify(observable(left)) === JSON.stringify(observable(right)));
  // Compute the straightforward single-line flex allocation from source properties. Wrapping and complex
  // native layout remain renderer approximations; explicit sizes stay authoritative on the cross axis.
  function autoLayoutDimension(name, property, scope) {
    if (!['Width', 'Height'].includes(property)) return undefined;
    const child = controls.get(name),
      parent = controls.get(child?.parent);
    if (!parent || parent.kind !== 'container' || read(parent.name, 'LayoutWrap', scope) === true) return undefined;
    const explicitDirection = read(parent.name, 'LayoutDirection', scope);
    const variant = String(parent.variant ?? '');
    const direction =
      explicitDirection ?? (/horizontal/i.test(variant) ? 'Horizontal' : /vertical/i.test(variant) ? 'Vertical' : null);
    if (!['Horizontal', 'Vertical'].includes(direction)) return undefined;
    const vertical = direction === 'Vertical';
    const main = vertical ? 'Height' : 'Width';
    const cross = vertical ? 'Width' : 'Height';
    const start = property === 'Width' ? 'PaddingLeft' : 'PaddingTop';
    const end = property === 'Width' ? 'PaddingRight' : 'PaddingBottom';
    const dimension = () => {
      const size = read(parent.name, property, scope);
      if (typeof size !== 'number' || !Number.isFinite(size)) return null;
      const pad = (key) => Math.max(0, Number(read(parent.name, key, scope)) || 0);
      return Math.max(0, size - pad(start) - pad(end));
    };
    if (property === cross && !formulas.get(name)?.has(property)) {
      const align = read(name, 'AlignInContainer', scope) ?? 'SetByContainer';
      const effective = align === 'SetByContainer' ? read(parent.name, 'LayoutAlignItems', scope) : align;
      if (effective !== 'Stretch') return undefined;
      return dimension() ?? undefined;
    }
    if (property !== main) return undefined;
    const portion = Number(read(name, 'FillPortions', scope)) || 0;
    if (!(portion > 0)) return undefined;
    const available = dimension();
    if (available === null) return undefined;
    const siblings = parent.children.filter((sibling) => read(sibling, 'Visible', scope) !== false);
    const minimum = vertical ? 'LayoutMinHeight' : 'LayoutMinWidth';
    let fixed = 0,
      weights = 0,
      minima = 0,
      ownMinimum = 0;
    for (const sibling of siblings) {
      const weight = Math.max(0, Number(read(sibling, 'FillPortions', scope)) || 0);
      if (weight > 0) {
        const min = Math.max(0, Number(read(sibling, minimum, scope)) || 0);
        weights += weight;
        minima += min;
        if (sibling === name) ownMinimum = min;
      } else {
        const size = read(sibling, property, scope);
        if (typeof size !== 'number' || !Number.isFinite(size)) return undefined;
        fixed += Math.max(0, size);
      }
    }
    if (!weights || !siblings.includes(name)) return undefined;
    const gap = Math.max(0, Number(read(parent.name, 'LayoutGap', scope)) || 0);
    const free = Math.max(0, available - fixed - minima - gap * Math.max(0, siblings.length - 1));
    return ownMinimum + (free * portion) / weights;
  }
  function compute(name, property, scope) {
    const layout = autoLayoutDimension(name, property, scope);
    if (layout !== undefined) return layout;
    if (kindOf(name) === 'codecomponent') {
      const definition = source.codeComponents?.[name];
      const descriptor = definition?.properties?.find((entry) => entry.name === property);
      if (descriptor) {
        const key = `pcf:${name}.${property}${scope.itemIndex !== undefined ? `#${scope.itemIndex}` : ''}`;
        track(key);
        if (state.inputs.has(key)) return state.inputs.get(key);
        const value = declared(name, property, scope);
        if (value.found) return value.value;
        if (typeof descriptor.defaultFormula === 'string') {
          const formula = descriptor.defaultFormula.replace(/^\s*=/, '').trim();
          if (/%[^%]+%/.test(formula)) {
            const message = 'The code component default uses an unsupported reserved placeholder.';
            report({ code: 'CANVAS_PCF_DEFAULT_UNSUPPORTED', source: `${name}.${property}`, message });
            return new FxError([{ Kind: ErrorKind.NotSupported, Message: message }]);
          }
          return formula
            ? pure(
                formula,
                {
                  ...scope,
                  control: name,
                  screen: controls.get(name)?.screen,
                  component: source.componentScopes?.[name],
                },
                `${name}.${property}`,
              )
            : null;
        }
        return descriptor.defaultValue ?? null;
      }
    }

    if (name === 'App' && (property === 'Width' || property === 'Height')) {
      track('viewport');
      return state.viewport[property.toLowerCase()];
    }
    if (name === 'App' && ['MinScreenWidth', 'MinScreenHeight', 'SizeBreakpoints'].includes(property)) {
      const result = declared(name, property, scope);
      return result.found ? result.value : property === 'SizeBreakpoints' ? [600, 900, 1200] : 0;
    }
    if (screens.has(name) && !controls.has(name)) {
      const result = declared(name, property, scope);
      if (result.found) return result.value;
      if (property === 'Width' || property === 'Height')
        return Math.max(read('App', property), Number(read('App', `MinScreen${property}`)) || 0);
      if (property === 'Size') {
        const breakpoints = read('App', 'SizeBreakpoints');
        const width = read(name, 'Width');
        return (
          1 +
          (Array.isArray(breakpoints) ? breakpoints : []).filter((item) => width >= Number(item?.Value ?? item)).length
        );
      }
      if (property === 'Orientation') return read(name, 'Width') > read(name, 'Height') ? 'Horizontal' : 'Vertical';
    }
    if (name === 'App' && property.startsWith('#formula:'))
      return pure(namedFormulas.get(property.slice(9)), {}, `App.Formulas.${property.slice(9)}`);
    switch (`${kindOf(name)}.${property}`) {
      case 'textinput.Text': {
        const typed = input(name, scope);
        return typed !== undefined ? typed : (fallback(name, 'Default', scope) ?? '');
      }
      case 'addmedia.Media':
      case 'addmedia.FileName': {
        const media = input(name, scope);
        return property === 'Media' ? (media?.uri ?? null) : (media?.name ?? '');
      }
      case 'slider.Value':
      case 'numberinput.Value': {
        const set = input(name, scope);
        return set !== undefined ? set : fallback(name, 'Default', scope);
      }
      case 'combobox.SearchText': {
        const key = `search:${name}${scope.itemIndex !== undefined ? `#${scope.itemIndex}` : ''}`;
        track(key);
        return state.inputs.get(key) ?? '';
      }
      case 'audio.Paused':
      case 'video.Paused':
      case 'audio.Time':
      case 'video.Time': {
        track(`media:${name}`);
        const media = state.media.get(name);
        return property === 'Paused' ? (media?.paused ?? true) : (media?.time ?? 0);
      }
      case 'timer.Value':
      case 'timer.Running': {
        track(`timer:${name}`);
        const timer = state.timers.get(name);
        return property === 'Value' ? (timer?.value ?? 0) : (timer?.running ?? false);
      }
      case 'checkbox.Checked':
      case 'toggle.Checked':
      case 'checkbox.Value':
      case 'toggle.Value': {
        const set = input(name, scope);
        if (set !== undefined) return set;
        const modern = controls.get(name)?.modern;
        return fallback(name, modern ? 'Checked' : 'Default', scope) === true;
      }
      case 'datepicker.SelectedDate': {
        const set = input(name, scope);
        return set !== undefined ? set : fallback(name, 'DefaultDate', scope);
      }
      case 'radio.Selected':
      case 'dropdown.Selected': {
        const list = items(name),
          chosen = input(name, scope);
        if (chosen !== undefined) return list[chosen] ?? null;
        const wanted = fallback(name, 'Default', scope);
        // Default is the initial value; without one the first item is selected.
        return (
          list.find((row) => (isPlain(row) ? Object.values(row).some((value) => value === wanted) : row === wanted)) ??
          list[0] ??
          null
        );
      }
      case 'combobox.SelectedItems': {
        const list = items(name),
          chosen = input(name, scope);
        if (chosen !== undefined) return chosen.map((index) => list[index]).filter(Boolean);
        return rowsOf(fallback(name, 'DefaultSelectedItems', scope));
      }
      case 'combobox.Selected':
        return read(name, 'SelectedItems', scope)?.at(-1) ?? null;
      case 'gallery.AllItems':
        return items(name);
      case 'gallery.AllItemsCount':
        return read(name, 'AllItems', scope).length;
      case 'gallery.Selected': {
        track(`sel:${name}`);
        const list = items(name),
          chosen = state.selected.get(name);
        if (chosen !== undefined) return list[chosen] ?? null;
        const wanted = declared(name, 'Default', scope);
        return (
          (wanted.found && wanted.value ? list.find((row) => sameRow(row, wanted.value)) : null) ?? list[0] ?? null
        );
      }
      case 'form.Mode':
        return formState(name).mode ?? fallback(name, 'DefaultMode', scope) ?? 'Edit';
      case 'formviewer.Mode':
        return 'View';
      case 'form.DisplayMode':
      case 'formviewer.DisplayMode':
        return read(name, 'Mode', scope) === 'View' ? 'View' : 'Edit';
      case 'form.Updates':
        return Object.fromEntries(
          cards(name)
            .map((card) => [read(card, 'DataField', {}), read(card, 'Update', {})])
            .filter(([field]) => typeof field === 'string' && field),
        );
      case 'form.Valid':
        return cards(name).every((card) => read(card, 'Valid', {}) !== false);
      case 'form.Unsaved':
        return cards(name).some((card) => read(card, 'Update', {}) !== read(card, 'Default', {}));
      case 'form.LastSubmit':
        return formState(name).lastSubmit ?? null;
      case 'form.Error':
        return formState(name).error ?? '';
      case 'form.ErrorKind':
        return formState(name).errorKind ?? ErrorKind.None;
      case 'card.Default': {
        const result = declared(name, property, scope);
        if (result.found || !formOf(name)) return result.value ?? null;
        const record = formRecord(formOf(name)),
          field = read(name, 'DataField', scope);
        return record && typeof field === 'string' ? (record[field] ?? null) : null;
      }
      case 'card.Update': {
        const result = declared(name, property, scope);
        return result.found ? result.value : read(name, 'Default', scope);
      }
      case 'card.Valid':
        return !(read(name, 'Required', scope) === true && blank(read(name, 'Update', scope)));
      case 'card.DisplayMode': {
        // Cards usually take Parent.DisplayMode (the form's).
        const result = declared(name, property, scope);
        return result.found
          ? result.value
          : formOf(name)
            ? read(formOf(name), 'DisplayMode', {})
            : COMMON_DEFAULTS.DisplayMode;
      }
      default:
        return fallback(name, property, scope);
    }
  }

  // ---- canvas functions the engine calls back (arguments arrive as host values: a control is { id, logical_name }) ----
  function canvasFunctions(scope, where) {
    const controlArg = (value, kinds, label) => {
      const name = nameOf(value);
      if (!controls.has(name) || (kinds && !kinds.includes(kindOf(name))))
        throw fail(
          `${label} needs ${kinds ? kinds.join(' or ') : 'a control'} of this app.`,
          'CanvasControlNotFound',
          404,
        );
      return name;
    };
    const mode = (form, next) => {
      setForm(form, { mode: next, error: undefined, errorKind: undefined });
      clearInputs(form);
      return true;
    };
    return {
      // Param returns the named launch parameter as text, blank when it was not passed;
      // names are case-sensitive. A custom page receives recordId and entityName (Xrm.Navigation.navigateTo).
      Param: (name) => (Object.hasOwn(parameters, String(name ?? '')) ? String(parameters[String(name)]) : null),
      SubmitForm: (form) => {
        submit(controlArg(form, ['form'], 'SubmitForm'), where);
        return true;
      },
      NewForm: (form) => mode(controlArg(form, ['form'], 'NewForm'), 'New'),
      EditForm: (form) => mode(controlArg(form, ['form'], 'EditForm'), 'Edit'),
      ViewForm: (form) => mode(controlArg(form, ['form'], 'ViewForm'), 'View'),
      ResetForm: (target) => {
        const form = controlArg(target, ['form'], 'ResetForm');
        if (read(form, 'Mode') === 'View') return true; // ResetForm has no effect in FormMode.View
        clearInputs(form);
        setForm(form, {
          mode: read(form, 'Mode') === 'New' ? 'Edit' : state.forms.get(form)?.mode,
          error: undefined,
          errorKind: undefined,
        });
        pending.push(() => behaviour(form, 'OnReset', {}));
        return true;
      },
      Reset: (target) => {
        const control = controlArg(target, null, 'Reset');
        clearInputs(control, true);
        if (source.componentScopes?.[control]?.root === control) pending.push(() => behaviour(control, 'OnReset', {}));
        return true;
      },
      // The target's OnSelect is queued and runs after the current formula.
      Select: (target) => {
        const control = controlArg(target, null, 'Select');
        pending.push(() => select(control, scope.gallery && scope.gallery === galleryOf(control) ? scope : {}));
        return true;
      },
      Refresh: typedPowerFxFunction((target) => {
        if (target instanceof FxDataSource) writeErrors.delete(target.name);
        pending.push(() => forget());
        return true;
      }),
      Launch: (address, ...parameters) => {
        const entry = { address: String(address ?? ''), parameters };
        state.launches.push(entry);
        // The host hears it when the formula completes, so an undone attempt never reaches it.
        pending.push(() => {
          launch(entry);
          log({ event: 'launch' });
        });
        return true;
      },
    };
  }
  function submit(form, _where) {
    const mode = read(form, 'Mode');
    if (mode === 'View') return; // SubmitForm has no effect in FormMode.View
    if (!read(form, 'Valid')) {
      setForm(form, { error: 'A required value is missing.', errorKind: ErrorKind.Validation }); // Native message text not known.
      pending.push(() => behaviour(form, 'OnFailure', {}));
      return;
    }
    const target = formSource(form),
      updates = read(form, 'Updates');
    try {
      if (!target) throw fail(`${form} has no Dataverse data source.`, 'CanvasDataSourceNotFound', 404);
      const saved =
        mode === 'New' ? target.adapter.create(updates) : target.adapter.update(read(form, 'Item'), updates);
      setForm(form, {
        lastSubmit: saved,
        error: undefined,
        errorKind: undefined,
        mode: mode === 'New' ? 'Edit' : state.forms.get(form)?.mode,
      });
      clearInputs(form);
      log({ event: 'submit', form });
      pending.push(() => behaviour(form, 'OnSuccess', {}));
    } catch (error) {
      const kind = error.powerFxKind ?? (error.status === 404 ? 'NotFound' : 'Sync');
      pushError({ ...fromError(error, `${form}.SubmitForm`), kind });
      setForm(form, { error: error.message, errorKind: ErrorKind[kind] ?? ErrorKind.Unknown });
      pending.push(() => behaviour(form, 'OnFailure', {}));
    }
  }
  const setForm = (form, change) => {
    state.forms.set(form, { ...state.forms.get(form), ...change });
    changed(`form:${form}`);
  };
  const clearInputs = (name, self = false) => {
    if (self && kindOf(name) === 'codecomponent') {
      for (const key of [...state.inputs.keys()].filter((key) => key.startsWith(`pcf:${name}.`))) {
        state.inputs.delete(key);
        changed(key);
      }
    }
    if (self && ['audio', 'video'].includes(kindOf(name))) {
      state.media.delete(name);
      changed(`media:${name}`);
    }
    if (self && kindOf(name) === 'timer') {
      state.timers.delete(name);
      changed(`timer:${name}`);
    }
    for (const control of [...(self ? [name] : []), ...descendants(name)])
      for (const key of [...state.inputs.keys()].filter(
        (key) => key === `input:${control}` || key.startsWith(`input:${control}#`),
      )) {
        state.inputs.delete(key);
        changed(key);
      }
    if (self && kindOf(name) === 'gallery') {
      state.selected.delete(name);
      changed(`sel:${name}`);
    }
  };

  // ---- behaviour ----
  // Connector operations are host functions `Source.Operation` resolved where the engine calls them, so a call in an
  // untaken branch never runs. The engine is synchronous and a connector answers asynchronously: a call whose answer is
  // not known yet suspends the formula; the in-memory app state of the attempt is restored, the connector is called once,
  // and the formula runs again with that answer. Answers are matched by call order, never by arguments: the nth connector
  // call of an attempt takes the nth recorded answer.
  // `tape` = { list: answers in call order, next: the next call's position (reset per attempt), journal }.
  // `Source.Operation` of any connector data source (the operations are the connector's, not listed in the app source).
  const componentTypeMatches = (type, value) =>
    value == null ||
    (type === 'Text' && typeof value === 'string') ||
    (type === 'Boolean' && typeof value === 'boolean') ||
    (['Number', 'Currency'].includes(type) && isNumeric(value)) ||
    (type === 'DateAndTime' && value instanceof FxDate) ||
    (type === 'Record' && (isPlain(value) || value instanceof FxRecordRef)) ||
    (type === 'Table' && (Array.isArray(value) || value instanceof FxDataSource)) ||
    (type === 'Screen' && value instanceof FxRecordRef && value.table === SCREEN);
  const componentCallStack = [];
  const componentFunction = (name, scope) => {
    const dot = name.indexOf('.');
    if (dot <= 0) return undefined;
    const owner = name.slice(0, dot),
      property = name.slice(dot + 1);
    const local = scope.component;
    const root = local?.definition === owner ? local.root : (local?.locals?.[owner] ?? owner);
    const descriptor = source.componentFunctions?.[root]?.[property];
    if (!descriptor) return undefined;
    return typedPowerFxFunction((...args) => {
      const pureCall = descriptor.kind === 'InputFunction' || descriptor.kind === 'OutputFunction';
      if (['InputFunction', 'Event'].includes(descriptor.kind) && scope.component?.root !== root)
        throw fail(
          'Component input functions and events can only be invoked by their component.',
          'CanvasComponentActionInvalid',
        );
      if (!pureCall && !scope.behaviour)
        throw fail('Component behavior properties require a behavior formula.', 'CanvasComponentActionInvalid');
      const allowed = new Set(['Text', 'Number', 'Boolean', 'DateAndTime', 'Record', 'Table', 'Screen', 'Currency']);
      const parameters = descriptor.parameters ?? [];
      if (
        parameters.length > 32 ||
        parameters.some((parameter) => !allowed.has(parameter.dataType)) ||
        (descriptor.returnType && ![...allowed, 'None'].includes(descriptor.returnType))
      )
        throw fail(
          'This component function uses an unsupported parameter or return type.',
          'CanvasComponentFunctionUnsupported',
          501,
        );
      if (args.length > parameters.length || parameters.slice(args.length).some((parameter) => !parameter.optional))
        throw fail('Component function argument count is invalid.', 'CanvasComponentArgumentInvalid');
      const entry = formulas.get(root)?.get(property);
      if (!entry?.formula) throw fail('Component function has no formula.', 'CanvasComponentFunctionUnsupported', 501);
      const key = `${root}.${property}`;
      if (componentCallStack.includes(key) || componentCallStack.length >= 32)
        throw fail('Recursive component function calls are unsupported.', 'CanvasComponentRecursion', 501);
      componentCallStack.push(key);
      try {
        const component = formulaComponent(root, entry);
        const extra = {};
        for (let index = 0; index < parameters.length; index++) {
          const parameter = parameters[index];
          let value = args[index];
          if (value === undefined && parameter.default != null) {
            const text = String(parameter.default).replace(/^\s*=/, '');
            value = evaluate(
              text,
              { ...scope, component, pureComponent: pureCall, componentArguments: true, extra },
              `${key}.${parameter.name}`,
            );
          }
          if (value instanceof FxError) return value;
          if (!componentTypeMatches(parameter.dataType, value))
            throw fail('Component function argument has an unsupported type.', 'CanvasComponentArgumentInvalid');
          extra[parameter.name] = value ?? null;
        }
        const result = evaluate(
          entry.formula,
          {
            ...scope,
            control: root,
            screen: controls.get(root)?.screen,
            component,
            pureComponent: pureCall,
            componentArguments: true,
            extra,
          },
          key,
        );
        if (
          !(result instanceof FxError) &&
          descriptor.returnType &&
          descriptor.returnType !== 'None' &&
          !componentTypeMatches(descriptor.returnType, result)
        )
          throw fail('Component function returned a value of the wrong type.', 'CanvasComponentArgumentInvalid');
        return result;
      } finally {
        componentCallStack.pop();
      }
    });
  };
  const connectorFunction = (name, tape) => {
    const dot = name.indexOf('.'),
      entry = dot > 0 ? dataSources.get(name.slice(0, dot)) : null;
    if (!entry?.connectorId) return undefined;
    const operation = name.slice(dot + 1);
    return (...args) => {
      const index = tape.next++;
      if (index < tape.list.length) return tape.list[index];
      throw Object.assign(new Error('connector call pending'), { [SUSPEND]: { entry, operation, args } });
    };
  };
  // The replay journal: the operations a suspended attempt completed before its connector call (Dataverse reads and writes
  // through the data sources, Now(), GUID()) keep their results with the suspension, and the attempt that runs again
  // takes them from the journal in call order instead of executing them again. A Patch made before a connector call is
  // therefore committed once, with the id the connector was sent (a behaviour formula's actions happen in sequence and
  // are not undone). `journal` = { entries: [{ op, value | error }], next } of the formula
  // evaluating now; it is set only while one attempt evaluates synchronously.
  let journal = null;
  const journaled = (op, fn) => {
    if (!journal) return fn();
    const index = journal.next++;
    if (index < journal.entries.length) {
      const entry = journal.entries[index];
      if (entry.op !== op)
        throw fail(
          `The formula reached ${op} where its earlier attempt reached ${entry.op}; it cannot resume after the connector answer.`,
          'CanvasReplayDiverged',
          500,
        );
      if (Object.hasOwn(entry, 'error')) throw entry.error;
      return entry.value;
    }
    try {
      const value = fn();
      journal.entries.push({ op, value });
      return value;
    } catch (error) {
      journal.entries.push({ op, error });
      throw error;
    }
  };
  const writeErrors = new Map();
  const journaledAdapter = (adapter, sourceName) => {
    const trackWrite = (operation, record, run) => {
      writeErrors.delete(sourceName);
      try {
        return journaled(operation, run);
      } catch (error) {
        if (error?.status)
          writeErrors.set(sourceName, [
            {
              Record: record,
              Column: error.column ?? null,
              Message: error.message,
              Error: ErrorKind[error.powerFxKind] ?? (error.status === 404 ? ErrorKind.NotFound : ErrorKind.Sync),
            },
          ]);
        throw error;
      }
    };
    return {
      ...adapter,
      read: (query) => journaled('read', () => adapter.read(query)),
      count: (query) => journaled('count', () => adapter.count(query)),
      errors: () => writeErrors.get(sourceName) ?? [],
      create: (record) => trackWrite('create', null, () => adapter.create(record)),
      update: (base, changes) => trackWrite('update', base, () => adapter.update(base, changes)),
      remove: (record) => trackWrite('remove', record, () => adapter.remove(record)),
    };
  };
  // A connector failure is a Power Fx error value, so IfError/IsError handle it and the chain's later statements run.
  // Only network errors carry details: HttpStatusCode and HttpResponse (the connector's response body).
  // Power Apps' own message text for a failed connector call is not known.
  const EXCERPT = 2000; // ponytail: HttpResponse keeps the first 2000 characters of the body; raise it if a body needs more.
  const connectorFailure = (source, status, body, kind = ErrorKind.Network) => {
    const text = body === undefined || body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
    const reason =
      body?.error?.message ??
      body?.message ??
      (status ? `the connector answered HTTP ${status}` : 'the connector call failed');
    // Details belong to network errors only; a not-simulated operation (NotSupported) carries none.
    return new FxError([
      {
        Kind: kind,
        Message: `${source} failed: ${reason}`,
        Source: source,
        ...(kind === ErrorKind.NotSupported
          ? {}
          : {
              Details: {
                HttpStatusCode: status ?? null,
                HttpResponse: text.length > EXCERPT ? text.slice(0, EXCERPT) : text,
              },
            }),
      },
    ]);
  };
  // The answer of one connector call: a provider HTTP answer ({ statusCode, body }) reads as its body when 2xx and as an
  // error value otherwise; another value is the answer itself.
  const callConnector = async ({ entry, operation, args }) => {
    const source = `${entry.name}.${operation}`;
    if (!connectors)
      return connectorFailure(
        source,
        null,
        `Connector ${entry.name} is not available in this runtime.`,
        ErrorKind.NotSupported,
      );
    const body = args.length === 1 && isPlain(args[0]) ? args[0] : args.length ? { args } : {};
    let result;
    try {
      result = await connectors({
        reference: { key: entry.name, apiId: entry.connectorId },
        operationId: operation,
        body,
        principal,
        caller: 'canvas',
      });
    } catch (error) {
      log({ event: 'connector', dataSource: entry.name, operationId: operation, status: error?.status ?? null });
      return connectorFailure(source, error?.status ?? null, error?.body ?? error?.message ?? null);
    }
    if (result === undefined)
      return connectorFailure(
        source,
        null,
        `Connector operation ${operation} on ${entry.connectorId} is not simulated.`,
        ErrorKind.NotSupported,
      );
    const status = Number.isInteger(result?.statusCode) ? result.statusCode : null;
    log({ event: 'connector', dataSource: entry.name, operationId: operation, ...(status === null ? {} : { status }) });
    if (status === null) return result;
    return status >= 200 && status < 300 ? (result.body ?? null) : connectorFailure(source, status, result.body);
  };
  // The app state a suspended attempt may have changed, copied so the attempt can be undone.
  const saveState = () => ({
    variables: Object.fromEntries(
      Object.entries(variables).map(([key, item]) => [key, Array.isArray(item) ? [...item] : item]),
    ),
    contexts: new Map([...contexts].map(([screen, values]) => [screen, { ...values }])),
    componentVariables: new Map(
      [...componentVariables].map(([root, values]) => [
        root,
        Object.fromEntries(Object.entries(values).map(([key, item]) => [key, Array.isArray(item) ? [...item] : item])),
      ]),
    ),
    forms: new Map(state.forms),
    inputs: new Map(state.inputs),
    selected: new Map(state.selected),
    timers: new Map([...state.timers].map(([name, timer]) => [name, { ...timer }])),
    media: new Map([...state.media].map(([name, value]) => [name, { ...value }])),
    notifications: state.notifications.length,
    launches: state.launches.length,
    pending: pending.length,
  });
  const restoreState = (saved) => {
    for (const key of Object.keys(variables)) delete variables[key];
    Object.assign(
      variables,
      Object.fromEntries(
        Object.entries(saved.variables).map(([key, item]) => [key, Array.isArray(item) ? [...item] : item]),
      ),
    );
    componentVariables.clear();
    for (const [root, values] of saved.componentVariables) componentVariables.set(root, values);
    for (const [screen, values] of saved.contexts) {
      const target = contexts.get(screen);
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, values);
    }
    state.forms = saved.forms;
    state.inputs = saved.inputs;
    state.selected = saved.selected;
    state.timers = saved.timers;
    state.media = saved.media;
    state.notifications.length = saved.notifications;
    state.launches.length = saved.launches;
    pending.length = saved.pending;
    forget();
  };
  // Connector answers persist until a tracked dependency changes or refresh; settle() resumes waiting properties.
  const propertyAnswers = new Map(),
    propertyWaits = new Map();
  async function settle() {
    for (let round = 0; round < MAX_CONNECTOR_CALLS; round++) {
      propertyWaits.clear();
      instance.snapshot();
      if (!propertyWaits.size) return;
      for (const [key, wait] of [...propertyWaits]) propertyAnswers.get(key).push(await callConnector(wait));
      forget();
    }
  }
  // Input changes are checked only after explicit actions settle; reads remain inert.
  const componentInputBaseline = new Map();
  const resetInputs = Object.entries(source.componentScopes ?? {})
    .filter(([name, component]) => component.root === name && component.resetInputs?.length)
    .flatMap(([name, component]) =>
      component.resetInputs.map((property) => ({ name, property, key: `${name}.${property}` })),
    );
  function captureResetInputs() {
    return resetInputs.map((input) => ({
      ...input,
      value: JSON.stringify(observable(read(input.name, input.property))),
    }));
  }
  function initializeResetInputs() {
    for (const input of captureResetInputs()) componentInputBaseline.set(input.key, input.value);
  }
  async function synchronizeResetInputs() {
    for (let round = 0; round < 32; round++) {
      const changedRoots = new Set();
      for (const input of captureResetInputs()) {
        if (componentInputBaseline.has(input.key) && componentInputBaseline.get(input.key) !== input.value)
          changedRoots.add(input.name);
        componentInputBaseline.set(input.key, input.value);
      }
      if (!changedRoots.size) return;
      for (const root of changedRoots) await behaviour(root, 'OnReset', {});
      await settle();
    }
    report({
      code: 'CANVAS_COMPONENT_RESET_LIMIT',
      source: 'components',
      message: 'Component input changes exceeded the bounded reset limit.',
    });
  }
  /** Runs one behaviour formula; its errors are recorded (the chain itself continues). */
  async function run(text, scope, where) {
    let errors = [],
      value = null;
    const tape = { list: [], next: 0, journal: { entries: [], next: 0 } };
    try {
      for (let attempt = 0; ; attempt++) {
        if (attempt > MAX_CONNECTOR_CALLS)
          throw fail(
            `${where} called more than ${MAX_CONNECTOR_CALLS} connector operations.`,
            'CanvasConnectorLimit',
            508,
          );
        const saved = saveState();
        tape.next = 0;
        tape.journal.next = 0;
        const outcome = await transact(() => {
          journal = tape.journal;
          try {
            return { result: evaluate(text, { ...scope, behaviour: true, connectors: tape }, where) };
          } catch (error) {
            if (error?.[SUSPEND]) return { suspended: error[SUSPEND] };
            throw error;
          } finally {
            journal = null;
          }
        });
        if (!outcome.suspended) {
          // An error value, or a table holding error values (ForAll over failed writes), is the formula's failure.
          const failed =
            outcome.result instanceof FxError
              ? [outcome.result]
              : Array.isArray(outcome.result)
                ? outcome.result.filter((item) => item instanceof FxError)
                : [];
          if (failed.length) errors = failed.flatMap((item) => fromFxError(item, where));
          else value = outcome.result;
          break;
        }
        restoreState(saved);
        tape.list.push(await callConnector(outcome.suspended));
      }
    } catch (error) {
      errors = [fromError(error, where)];
    }
    forget();
    for (const entry of errors) pushError(entry);
    const queued = pending;
    pending = [];
    for (const task of queued) await task();
    if (errors.length && !scope.handled) await onError(errors, where);
    return { value, errors };
  }
  async function onError(errors, where) {
    const handler = formulas.get('App')?.get('OnError')?.formula;
    if (!handler || where === 'App.OnError') return;
    const toRecord = (error) => ({
      Kind: ErrorKind[error.kind] ?? ErrorKind.Unknown,
      Message: error.message,
      Source: error.source,
      Observed: where,
    });
    await run(
      handler,
      { extra: { FirstError: toRecord(errors[0]), AllErrors: errors.map(toRecord) }, handled: true },
      'App.OnError',
    );
  }
  async function show(screen, { transition, update, push }) {
    const previous = state.current;
    if (previous) {
      await behaviour(previous, 'OnHidden', { screen: previous });
      for (const entry of controls.values()) {
        if (
          entry.screen !== previous ||
          !['audio', 'video'].includes(entry.kind) ||
          read(entry.name, 'AutoPause') === false
        )
          continue;
        const media = state.media.get(entry.name);
        if (media && !media.paused) {
          state.media.set(entry.name, { ...media, paused: true });
          changed(`media:${entry.name}`);
        }
      }
    }
    if (update) {
      Object.assign(trackedState(contexts.get(screen), `context:${screen}`), update);
      forget();
    }
    state.current = screen;
    state.transition = transition;
    if (push) state.history.push({ screen, transition });
    changed('screen:current');
    log({ event: 'navigate', from: previous, to: screen, transition });
    await behaviour(screen, 'OnVisible', { screen });
    for (const control of controls.values()) {
      if (control.screen === screen && control.kind === 'timer' && read(control.name, 'AutoStart') === true)
        await startTimer(control.name);
      if (
        control.screen === screen &&
        ['audio', 'video'].includes(control.kind) &&
        read(control.name, 'AutoStart') === true
      ) {
        state.media.set(control.name, { ...(state.media.get(control.name) ?? { time: 0 }), paused: false });
        changed(`media:${control.name}`);
        await behaviour(control.name, 'OnStart', {});
      }
    }
  }
  async function goBack(transition) {
    if (state.history.length < 2) return false; // Back returns false when the user has not navigated since the app started
    state.history.pop();
    await show(state.history.at(-1).screen, { transition: transition ?? 'inverse', push: false });
    return true;
  }
  async function behaviour(owner, property, scope) {
    const entry = formulas.get(owner)?.get(property);
    if (!entry?.formula) return undefined;
    return run(
      entry.formula,
      {
        ...scope,
        component: formulaComponent(owner, entry),
        control: controls.has(owner) ? owner : scope.control,
        screen: screens.has(owner) && !controls.has(owner) ? owner : scope.screen,
      },
      `${owner}.${property}`,
    );
  }
  async function startTimer(name) {
    const previous = state.timers.get(name) ?? { value: 0, running: false };
    if (previous.running) return;
    state.timers.set(name, {
      ...previous,
      value: previous.completed ? 0 : previous.value,
      running: true,
      manualPause: false,
      completed: false,
    });
    changed(`timer:${name}`);
    await behaviour(name, 'OnTimerStart', {});
  }
  async function syncTimer(entry) {
    const name = entry.name;
    if (entry.screen !== state.current && read(name, 'AutoPause') !== false) return;
    const start = read(name, 'Start') === true;
    const current = state.timers.get(name);
    if (start && !current?.running && !current?.manualPause && !current?.completed) {
      await startTimer(name);
      state.timers.set(name, { ...state.timers.get(name), startDriven: true });
    } else if (!start && current?.startDriven) {
      state.timers.set(name, { ...current, running: false, startDriven: false, completed: false, manualPause: false });
      changed(`timer:${name}`);
    }
  }
  async function syncTimers() {
    for (const entry of controls.values()) if (entry.kind === 'timer') await syncTimer(entry);
  }
  async function tickTimers(milliseconds) {
    for (const entry of controls.values()) {
      if (entry.kind !== 'timer') continue;
      const name = entry.name;
      if (entry.screen !== state.current && read(name, 'AutoPause') !== false) continue;
      await syncTimer(entry);
      let remaining = milliseconds,
        iterations = 0;
      while (remaining > 0 && state.timers.get(name)?.running) {
        if (entry.screen !== state.current && read(name, 'AutoPause') !== false) break;
        const timer = state.timers.get(name);
        const duration = Math.min(86400000, Math.max(1, Number(read(name, 'Duration')) || 60000));
        const step = Math.min(remaining, Math.max(0, duration - timer.value));
        const value = timer.value + step;
        state.timers.set(name, { ...timer, value });
        changed(`timer:${name}`);
        remaining -= step;
        if (value < duration) break;
        const repeat = read(name, 'Repeat') === true;
        state.timers.set(name, { ...timer, value: repeat ? 0 : duration, running: repeat, completed: !repeat });
        changed(`timer:${name}`);
        await behaviour(name, 'OnTimerEnd', {});
        if (
          repeat &&
          state.timers.get(name)?.running &&
          (entry.screen === state.current || read(name, 'AutoPause') === false)
        )
          await behaviour(name, 'OnTimerStart', {});
        if (++iterations >= 100 && remaining > 0) {
          report({
            code: 'CANVAS_TIMER_TICK_LIMIT',
            source: name,
            message: 'Timer tick exceeded 100 transitions; remaining time was not applied.',
          });
          break;
        }
      }
    }
  }
  async function select(control, scope) {
    if (kindOf(control) === 'timer') {
      const timer = state.timers.get(control);
      if (timer?.running) {
        state.timers.set(control, { ...timer, running: false });
        changed(`timer:${control}`);
      } else await startTimer(control);
    }
    const gallery = kindOf(control) === 'gallery' ? control : galleryOf(control);
    if (gallery && scope.itemIndex !== undefined) {
      state.selected.set(gallery, scope.itemIndex);
      changed(`sel:${gallery}`);
    }
    log({ event: 'select', control, ...(scope.itemIndex !== undefined ? { item: scope.itemIndex } : {}) });
    return behaviour(control, 'OnSelect', scope);
  }

  // ---- driver API ----
  const itemScope = (control, item) => {
    const gallery = kindOf(control) === 'gallery' ? control : galleryOf(control);
    if (item === undefined || item === null) return gallery ? { gallery } : {};
    if (!gallery)
      throw fail(`${control} is not inside a gallery; item applies to gallery rows.`, 'CanvasActionInvalid');
    const list = items(gallery),
      index = Number(item);
    if (!Number.isInteger(index) || index < 0 || index >= list.length)
      throw fail(`Gallery ${gallery} has no item ${item}.`, 'CanvasItemNotFound', 404);
    return { gallery, itemIndex: index, item: list[index] };
  };
  const hosted = (name) => {
    if (!controls.has(name)) throw fail(`Control ${name} is not part of this app.`, 'CanvasControlNotFound', 404);
    if (!controls.get(name).supported)
      throw fail(
        `Control ${name} (${controls.get(name).type}) is not hosted by the canvas runtime.`,
        'CanvasControlUnsupported',
        501,
      );
    return controls.get(name);
  };
  async function setInput(name, given, item) {
    const entry = hosted(name),
      scope = itemScope(name, item);
    const key = `input:${name}${scope.itemIndex !== undefined ? `#${scope.itemIndex}` : ''}`;
    let next;
    const indexOf = (list, choice) =>
      Number.isInteger(choice)
        ? choice
        : list.findIndex((row) => (isPlain(row) ? Object.values(row).includes(choice) : row === choice));
    if (entry.kind === 'textinput') next = given === null || given === undefined ? '' : String(given);
    else if (entry.kind === 'checkbox' || entry.kind === 'toggle') next = given === true || given === 'true';
    else if (entry.kind === 'datepicker') {
      next = given ? new Date(given) : null;
      if (next && Number.isNaN(next.getTime())) throw fail('The date is not valid.', 'CanvasInputInvalid');
    } else if (entry.kind === 'slider' || entry.kind === 'numberinput') {
      next = Number(given);
      if (!Number.isFinite(next)) throw fail('The number is not valid.', 'CanvasInputInvalid');
      const min = read(name, 'Min', scope),
        max = read(name, 'Max', scope);
      if ((min !== null && next < Number(min)) || (max !== null && next > Number(max)))
        throw fail('The number is outside the control bounds.', 'CanvasInputInvalid');
    } else if (entry.kind === 'dropdown' || entry.kind === 'radio') {
      const list = items(name);
      next = indexOf(list, given);
      if (next < 0 || next >= list.length) throw fail(`${name} has no item ${given}.`, 'CanvasItemNotFound', 404);
    } else if (entry.kind === 'combobox') {
      const list = items(name);
      next = [given].flat().map((choice) => indexOf(list, choice));
      if (next.length > 1 && read(name, 'SelectMultiple', scope) === false)
        throw fail(`${name} allows only one selection.`, 'CanvasInputInvalid');
      if (next.some((index) => index < 0 || index >= list.length))
        throw fail(`${name} has no such item.`, 'CanvasItemNotFound', 404);
    } else throw fail(`${name} (${entry.type}) takes no input.`, 'CanvasActionInvalid');
    const checked = entry.kind === 'checkbox' || entry.kind === 'toggle';
    if (checked && read(name, 'Value', scope) === next) return;
    state.inputs.set(key, next);
    changed(key);
    log({ event: 'input', control: name, ...(scope.itemIndex !== undefined ? { item: scope.itemIndex } : {}) });
    const result = await behaviour(name, 'OnChange', scope);
    if (checked) await behaviour(name, next ? 'OnCheck' : 'OnUncheck', scope);
    return result;
  }
  let queue = Promise.resolve();
  const serial = (task) => {
    const next = queue.then(task, task);
    queue = next.catch(() => {});
    return next;
  };
  const instance = {
    app: app.uniqueName,
    principal,
    /**
     * Runs App.OnStart, then shows App.StartScreen (else the first screen) and runs its OnVisible. A Navigate in OnStart
     * opens its screen instead, and only that screen's OnVisible runs.
     */
    start: () =>
      serial(async () => {
        if (state.started) return instance.snapshot();
        state.started = true;
        await behaviour('App', 'OnStart', {});
        const start = formulas.get('App')?.has('StartScreen') ? nameOf(read('App', 'StartScreen', {})) : null;
        const first = screens.has(start) ? start : screenNames[0];
        if (first && !state.current) await show(first, { transition: 'None', push: true });
        await syncTimers();
        await settle();
        initializeResetInputs();
        return instance.snapshot();
      }),
    /**
     * One driver action: { action: 'select', control, item? } runs OnSelect (item = gallery row index); 'input' sets a
     * control's user value ({ control, value, item? }) and runs OnChange; 'navigate' { screen }; 'back'; 'run' { formula }
     * runs a behaviour formula on the current screen; 'evaluate' { formula } answers its value; 'resize' { width, height }
     * changes the bounded viewport; 'refresh' rereads data.
     */
    act: (request) =>
      serial(async () => {
        const before = state.errors.length;
        let result = null;
        switch (request?.action) {
          case 'select':
            hosted(request.control);
            await select(request.control, itemScope(request.control, request.item));
            break;
          case 'input':
            await setInput(request.control, request.value, request.item);
            break;
          case 'add-media': {
            const entry = hosted(request.control);
            if (entry.kind !== 'addmedia') throw fail('add-media needs an add picture control.', 'CanvasActionInvalid');
            const scope = itemScope(entry.name, request.item);
            if (read(entry.name, 'DisplayMode', scope) !== 'Edit')
              throw fail('The control is not editable.', 'CanvasActionInvalid');
            const { name, mime, data } = request;
            if (
              typeof name !== 'string' ||
              !name ||
              name.length > 255 ||
              [...name].some(
                (character) =>
                  character.charCodeAt(0) < 32 ||
                  character.charCodeAt(0) === 127 ||
                  character === '/' ||
                  character === '\\',
              ) ||
              !['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(mime) ||
              typeof data !== 'string' ||
              data.length > Math.ceil((1024 * 1024) / 3) * 4 ||
              !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)
            )
              throw fail('The picture is invalid or exceeds the local size limit.', 'CanvasInputInvalid');
            const bytes = Buffer.from(data, 'base64');
            if (!bytes.length || bytes.length > 1024 * 1024 || bytes.toString('base64') !== data)
              throw fail('The picture is invalid or exceeds the local size limit.', 'CanvasInputInvalid');
            const valid =
              mime === 'image/png'
                ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
                : mime === 'image/jpeg'
                  ? bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
                  : mime === 'image/gif'
                    ? ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
                    : bytes.length >= 12 &&
                      bytes.subarray(0, 4).toString('ascii') === 'RIFF' &&
                      bytes.subarray(8, 12).toString('ascii') === 'WEBP';
            if (!valid) throw fail('The picture does not match its declared image type.', 'CanvasInputInvalid');
            const key = `input:${entry.name}${scope.itemIndex !== undefined ? `#${scope.itemIndex}` : ''}`;
            state.inputs.set(key, { name, uri: `data:${mime};base64,${data}` });
            changed(key);
            await behaviour(entry.name, 'OnChange', scope);
            break;
          }
          case 'codecomponent-event': {
            const entry = hosted(request.control);
            const definition = source.codeComponents?.[entry.name];
            if (entry.kind !== 'codecomponent' || !definition?.admitted)
              throw fail('Code component is not admitted by its manifest.', 'CanvasControlUnsupported', 501);
            if (typeof request.event !== 'string' || !(definition.events ?? []).includes(request.event))
              throw fail('Code component event is not declared by its manifest.', 'CanvasActionInvalid');
            const scope = itemScope(entry.name, request.item);
            if (read(entry.name, 'DisplayMode', scope) !== 'Edit')
              throw fail('Code component is not editable.', 'CanvasActionInvalid');
            await behaviour(entry.name, request.event, scope);
            break;
          }
          case 'codecomponent': {
            const entry = hosted(request.control);
            const definition = source.codeComponents?.[entry.name];
            if (entry.kind !== 'codecomponent' || !definition?.admitted)
              throw fail('Code component is not admitted by its manifest.', 'CanvasControlUnsupported', 501);
            const scope = itemScope(entry.name, request.item);
            if (read(entry.name, 'DisplayMode', scope) !== 'Edit')
              throw fail('Code component is not editable.', 'CanvasActionInvalid');
            if (!isPlain(request.values) || Object.keys(request.values).length > 128)
              throw fail('Code component values must be a bounded property object.', 'CanvasActionInvalid');
            const changes = [];
            for (const [property, value] of Object.entries(request.values)) {
              const descriptor = definition.properties.find((item) => item.name === property);
              if (!descriptor || !['output', 'bound'].includes(descriptor.usage))
                throw fail(`Code component property ${property} is not writable.`, 'CanvasActionInvalid');
              const type = descriptor.ofType.toLowerCase();
              const integer = [
                'whole.none',
                'whole.duration',
                'whole.timezone',
                'whole.language',
                'optionset',
              ].includes(type);
              const numeric = integer || ['decimal', 'fp', 'currency'].includes(type);
              const text = [
                'singleline.text',
                'singleline.textarea',
                'singleline.email',
                'singleline.phone',
                'singleline.url',
                'singleline.ticker',
                'multiple',
              ].includes(type);
              const enumeration = type === 'enum';
              const date = ['datetime.dateonly', 'datetime.datetime'].includes(type);
              const valid =
                value === null ||
                (numeric &&
                  typeof value === 'number' &&
                  Number.isFinite(value) &&
                  (!integer || Number.isSafeInteger(value))) ||
                (text && typeof value === 'string' && value.length <= 65536) ||
                (type === 'twooptions' && typeof value === 'boolean') ||
                (enumeration &&
                  ((typeof value === 'string' && value.length <= 65536) || Number.isSafeInteger(value))) ||
                (date &&
                  typeof value === 'string' &&
                  (type === 'datetime.dateonly'
                    ? /^\d{4}-\d{2}-\d{2}$/.test(value)
                    : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) &&
                  !Number.isNaN(Date.parse(value)) &&
                  new Date(value).toISOString().slice(0, 10) === value.slice(0, 10));
              if (!valid || (!numeric && !text && !date && !enumeration && type !== 'twooptions'))
                throw fail(`Code component property ${property} has an invalid value.`, 'CanvasInputInvalid');
              changes.push([
                `pcf:${entry.name}.${property}${scope.itemIndex !== undefined ? `#${scope.itemIndex}` : ''}`,
                value,
              ]);
            }
            for (const [key, value] of changes) {
              state.inputs.set(key, value);
              changed(key);
            }
            if (changes.length) await behaviour(entry.name, 'OnChange', scope);
            break;
          }
          case 'media': {
            const entry = hosted(request.control);
            if (!['audio', 'video'].includes(entry.kind) || !['play', 'pause', 'end', 'seek'].includes(request.event))
              throw fail('media needs an audio or video control and a valid event.', 'CanvasActionInvalid');
            const prior = state.media.get(entry.name) ?? { paused: true, time: 0 };
            if (
              request.event === 'seek' &&
              (typeof request.time !== 'number' ||
                !Number.isFinite(request.time) ||
                request.time < 0 ||
                request.time > 86400)
            )
              throw fail('media seek needs a time from 0 to 86400 seconds.', 'CanvasActionInvalid');
            const next =
              request.event === 'seek'
                ? { ...prior, time: request.time }
                : request.event === 'play'
                  ? { ...prior, paused: false }
                  : request.event === 'end' && read(entry.name, 'Loop') === true
                    ? { paused: false, time: 0 }
                    : { ...prior, paused: true };
            state.media.set(entry.name, next);
            changed(`media:${entry.name}`);
            if (request.event === 'play' && prior.paused) await behaviour(entry.name, 'OnStart', {});
            if (request.event === 'pause' && !prior.paused) await behaviour(entry.name, 'OnPause', {});
            if (request.event === 'end') await behaviour(entry.name, 'OnEnd', {});
            break;
          }
          case 'tick': {
            if (!Number.isInteger(request.milliseconds) || request.milliseconds < 1 || request.milliseconds > 60000)
              throw fail('tick needs integer milliseconds from 1 to 60000.', 'CanvasActionInvalid');
            await tickTimers(request.milliseconds);
            break;
          }
          case 'search': {
            const entry = hosted(request.control);
            if (entry.kind !== 'combobox' || typeof request.value !== 'string' || request.value.length > 1000)
              throw fail('search needs a combo box and text up to 1000 characters.', 'CanvasActionInvalid');
            const scope = itemScope(request.control, request.item);
            const key = `search:${request.control}${scope.itemIndex !== undefined ? `#${scope.itemIndex}` : ''}`;
            state.inputs.set(key, request.value);
            changed(key);
            break;
          }
          case 'gallery-window': {
            const entry = hosted(request.control);
            if (
              entry.kind !== 'gallery' ||
              !Number.isSafeInteger(request.offset) ||
              request.offset < 0 ||
              request.offset > 1000000
            )
              throw fail('gallery-window needs a gallery and an offset from 0 to 1000000.', 'CanvasActionInvalid');
            state.windows.set(request.control, request.offset);
            break;
          }
          case 'navigate':
            if (!screens.has(request.screen))
              throw fail(`Screen ${request.screen} is not part of this app.`, 'CanvasScreenNotFound', 404);
            await show(request.screen, { transition: 'None', push: true });
            break;
          case 'back':
            result = await goBack();
            break;
          case 'run':
            if (typeof request.formula !== 'string' || !request.formula.trim())
              throw fail('run needs a formula.', 'CanvasActionInvalid');
            result = (await run(request.formula.replace(/^\s*=/, ''), { screen: state.current }, 'driver')).value;
            break;
          case 'evaluate': {
            if (typeof request.formula !== 'string' || !request.formula.trim())
              throw fail('evaluate needs a formula.', 'CanvasActionInvalid');
            const value = evaluate(request.formula.replace(/^\s*=/, ''), { screen: state.current }, 'driver');
            result = value instanceof FxDataSource ? rowsOf(value) : value;
            break;
          }
          case 'resize': {
            const viewport = canvasViewport(request);
            if (viewport.width !== state.viewport.width || viewport.height !== state.viewport.height) {
              state.viewport = viewport;
              changed('viewport');
            }
            break;
          }
          case 'refresh':
            propertyAnswers.clear();
            forget();
            break;
          default:
            throw fail(
              `Unknown canvas action ${request?.action}; use select, input, codecomponent, media, tick, search, gallery-window, navigate, back, run, evaluate, resize or refresh.`,
              'CanvasActionInvalid',
            );
        }
        if (request?.action !== 'evaluate') await syncTimers();
        await settle();
        if (request?.action !== 'evaluate') await synchronizeResetInputs();
        return { result: observable(result), errors: state.errors.slice(before), snapshot: instance.snapshot() };
      }),
    /** The snapshot after the connector calls property formulas wait for have answered. */
    observe: () =>
      serial(async () => {
        await settle();
        return instance.snapshot();
      }),
    /** Observable state: current screen, history, variables, collections, data sources, every control's property values. */
    snapshot() {
      const describe = (name, scope = {}) => {
        const entry = controls.get(name);
        const names = [
          ...new Set([
            ...(formulas.get(name)?.keys() ?? []),
            ...(OUTPUTS[entry.kind] ?? []),
            ...Object.keys(COMMON_DEFAULTS),
            ...Object.keys(CONTROL_CATALOGUE[entry.kind]?.defaults ?? {}),
            ...(source.codeComponents?.[name]?.properties?.map((property) => property.name) ?? []),
          ]),
        ].filter(
          (property) =>
            !isBehaviour(name, property) &&
            !(entry.kind === 'combobox' && property === 'ItemDisplayText') &&
            !(entry.kind === 'gallery' && property === 'TemplateFill' && scope.item === undefined),
        );
        const out = {
          name,
          type: entry.type,
          variant: entry.variant,
          kind: entry.kind,
          parent: entry.parent,
          supported: entry.supported,
          properties: Object.fromEntries(names.map((property) => [property, observable(read(name, property, scope))])),
          behaviours: [...(formulas.get(name)?.keys() ?? [])].filter((property) => isBehaviour(name, property)),
        };
        if (entry.kind === 'codecomponent') out.codeComponent = source.codeComponents?.[name] ?? null;
        if (['combobox', 'dropdown', 'radio'].includes(entry.kind) && !scope.gallery) {
          const rows = items(name);
          out.optionsTotal = rows.length;
          out.options = rows.slice(0, CANVAS_DATA_ROW_LIMIT).map((item, index) => {
            const label =
              entry.kind === 'combobox' && formulas.get(name)?.has('ItemDisplayText')
                ? read(name, 'ItemDisplayText', { item, itemIndex: index, option: true })
                : isPlain(item)
                  ? (item.Label ?? item.Value ?? Object.values(item)[0] ?? '')
                  : item;
            return { index, value: observable(item), label: observable(label) };
          });
        }
        if (entry.kind === 'gallery') {
          const rows = items(name),
            offset = state.windows.get(name) ?? 0;
          out.total = rows.length;
          out.offset = offset;
          out.hasMore = offset + SNAPSHOT_ITEMS < rows.length;
          out.items = rows.slice(offset, offset + SNAPSHOT_ITEMS).map((item, rowIndex) => {
            const index = offset + rowIndex;
            const children = descendants(name).filter((child) => controls.get(child).supported);
            return {
              index,
              templateProperties: formulas.get(name)?.has('TemplateFill')
                ? { TemplateFill: observable(read(name, 'TemplateFill', { gallery: name, itemIndex: index, item })) }
                : {},
              controls: Object.fromEntries(
                children.map((child) => [child, describe(child, { gallery: name, itemIndex: index, item }).properties]),
              ),
              controlInfo: Object.fromEntries(
                children.map((child) => {
                  const model = controls.get(child);
                  return [
                    child,
                    {
                      name: child,
                      parent: model.parent,
                      type: model.type,
                      kind: model.kind,
                      variant: model.variant,
                      ...(model.kind === 'codecomponent'
                        ? { codeComponent: source.codeComponents?.[child] ?? null }
                        : {}),
                      behaviours: [...(formulas.get(child)?.keys() ?? [])].filter((property) =>
                        isBehaviour(child, property),
                      ),
                    },
                  ];
                }),
              ),
            };
          });
        }
        return out;
      };
      // A collection: established by Collect/ClearCollect, or created by one at run time (a driver formula).
      for (const key of Object.keys(variables))
        if (!globals.has(key) && Array.isArray(variables[key])) collections.add(key);
      const names = Object.keys(variables);
      return {
        app: app.uniqueName,
        name: source.app?.name ?? app.uniqueName,
        rendered: false,
        clockKey: state.clockKey,
        viewport: { ...state.viewport },
        currentScreen: state.current,
        transition: state.transition,
        history: state.history.map((entry) => entry.screen),
        variables: Object.fromEntries(
          names
            .filter((key) => !collections.has(key) && variables[key] !== null)
            .map((key) => [key, observable(variables[key])]),
        ),
        // Established names that were never set read blank and are left out.
        context: Object.fromEntries(
          [...contexts]
            .map(([screen, values]) => [
              screen,
              Object.fromEntries(Object.entries(values).filter(([, item]) => item !== null && item !== undefined)),
            ])
            .filter(([, values]) => Object.keys(values).length)
            .map(([screen, values]) => [screen, observable(values)]),
        ),
        collections: Object.fromEntries([...collections].map((key) => [key, observable(variables[key] ?? [])])),
        dataSources: [...dataSources.values()].map((entry) => ({
          name: entry.name,
          kind: entry.kind,
          ...(entry.table ? { table: entry.table, hosted: Boolean(records) } : {}),
          ...(entry.connectorId ? { connectorId: entry.connectorId } : {}),
        })),
        screens: screenNames.map((screen) => ({
          name: screen,
          current: screen === state.current,
          properties: Object.fromEntries(
            [...new Set([...(formulas.get(screen)?.keys() ?? []), 'Width', 'Height', 'Size', 'Orientation'])]
              .filter((property) => !BEHAVIOUR_PROPERTY.test(property))
              .map((property) => [property, observable(read(screen, property))]),
          ),
          behaviours: [...(formulas.get(screen)?.keys() ?? [])].filter((property) => BEHAVIOUR_PROPERTY.test(property)),
          controls: [...controls.values()]
            .filter((entry) => entry.screen === screen && !galleryOf(entry.name))
            .map((entry) => describe(entry.name)),
        })),
        forms: Object.fromEntries(
          [...controls.values()]
            .filter((entry) => entry.kind === 'form')
            .map((entry) => [
              entry.name,
              {
                mode: read(entry.name, 'Mode'),
                error: read(entry.name, 'Error'),
                errorKind: kindName(read(entry.name, 'ErrorKind')),
              },
            ]),
        ),
        notifications: [...state.notifications],
        launches: observable(state.launches),
        errors: [...state.errors],
        unsupported,
        diagnostics: [...state.diagnostics],
        log: [...state.log],
      };
    },
  };
  return instance;
}
const SNAPSHOT_ITEMS = 50; // Gallery windows bound each snapshot; gallery-window selects subsequent rows.
// Properties the runtime maintains for each kind (beyond the declared ones).
const OUTPUTS = Object.freeze({
  textinput: ['Text'],
  addmedia: ['Media', 'FileName'],
  slider: ['Value'],
  numberinput: ['Value'],
  radio: ['Selected'],
  timer: ['Value', 'Running'],
  audio: ['Paused', 'Time'],
  video: ['Paused', 'Time'],
  checkbox: ['Value', 'Checked'],
  toggle: ['Value', 'Checked'],
  datepicker: ['SelectedDate'],
  dropdown: ['Selected'],
  combobox: ['SelectedItems', 'Selected', 'SearchText'],
  gallery: ['Selected', 'AllItems', 'AllItemsCount'],
  form: ['Mode', 'DisplayMode', 'Updates', 'Valid', 'Unsaved', 'LastSubmit', 'Error', 'ErrorKind'],
  formviewer: ['Mode', 'DisplayMode'],
  card: ['Default', 'Update', 'Valid', 'DisplayMode'],
  screen: ['Width', 'Height', 'Size', 'Orientation'],
});

/**
 * App instances per app and principal. `apps()` → [{ uniqueName, source }]; `evaluator` (or a function answering it) and
 * the other options as createCanvasApp. `session(uniqueName, principal)` returns the started instance (created on first
 * use; `options.parameters` are the launch parameters Param reads, applied when the instance is created);
 * `reset(uniqueName, principal)` drops it.
 */
export function createCanvasRuntime({
  apps,
  evaluator,
  api = null,
  caller = null,
  transact,
  connectors = null,
  launch,
  diagnostic,
} = {}) {
  const instances = new Map();
  const keyOf = (uniqueName, principal) =>
    `${uniqueName}\u0000${principal?.kind ?? 'anonymous'}:${principal?.principalId ?? ''}`;
  const resolve = (value) => (typeof value === 'function' ? value() : value);
  return {
    async session(uniqueName, principal, { parameters = {}, viewport } = {}) {
      const key = keyOf(uniqueName, principal);
      const app = (apps() ?? []).find((entry) => entry.uniqueName === uniqueName);
      if (!app) {
        instances.delete(key);
        throw fail('Canvas app not found.', 'CanvasAppNotFound', 404);
      }
      const revision = app.source?.revision;
      const previous = instances.get(key);
      if (
        previous &&
        typeof previous.revision === 'string' &&
        typeof revision === 'string' &&
        previous.revision !== revision
      )
        instances.delete(key);
      if (!instances.has(key)) {
        const created = createCanvasApp({
          app,
          evaluator: resolve(evaluator),
          principal,
          api: resolve(api),
          caller,
          transact,
          connectors,
          launch,
          diagnostic,
          parameters,
          ...(viewport === undefined ? {} : { viewport }),
        });
        const originalSnapshot = created.snapshot.bind(created);
        created.snapshot = () => ({ ...originalSnapshot(), sourceRevision: revision ?? null });
        const record = { instance: created, revision };
        instances.set(key, record);
        await created.start().catch((error) => {
          if (instances.get(key) === record) instances.delete(key);
          throw error;
        });
        if (instances.get(key) !== record)
          throw fail('Canvas source changed while the app was starting.', 'CanvasSourceChanged', 409);
      }
      return instances.get(key).instance;
    },
    /** Reads do not start apps; a changed revision evicts the old session. */
    existing(uniqueName, principal) {
      const key = keyOf(uniqueName, principal),
        record = instances.get(key);
      if (!record) return null;
      const app = (apps() ?? []).find((entry) => entry.uniqueName === uniqueName);
      const revision = app?.source?.revision;
      if (
        !app ||
        (typeof record.revision === 'string' && typeof revision === 'string' && record.revision !== revision)
      ) {
        instances.delete(key);
        return null;
      }
      return record.instance;
    },
    reset(uniqueName, principal) {
      return instances.delete(keyOf(uniqueName, principal));
    },
    get size() {
      return instances.size;
    },
  };
}

/**
 * Capability record `canvas-apps`: the hosted logic is behaviour and the local player has bounded rendering support.
 * `evaluatorLevel` is the Power Fx evaluator's describe().level.
 */
export function describeCanvasRuntime({ evaluatorLevel = 'contract' } = {}) {
  const level = evaluatorLevel === 'contract' || evaluatorLevel === 'inventory' ? 'contract' : 'behaviour';
  return {
    name: 'canvas-apps',
    version: 1,
    kind: 'host-surface',
    level: 'behaviour',
    principal: 'caller',
    stateOwner: 'memory',
    lifecycle: 'per-session',
    requires: ['power-fx'],
    operations: [
      'open',
      'select',
      'input',
      'codecomponent',
      'codecomponent-event',
      'add-media',
      'media',
      'tick',
      'search',
      'gallery-window',
      'navigate',
      'back',
      'run',
      'evaluate',
      'resize',
      'refresh',
    ].map((name) => ({
      name,
      level,
    })),
    fidelity: {
      notes: [
        'A bounded local HTML player presents supported controls; the runtime snapshot remains headless and does not claim pixel-perfect Power Apps rendering.',
        `Dataverse tables are Power Fx data sources read and written as the caller; delegable queries push down, others read up to ${CANVAS_DATA_ROW_LIMIT} rows with the delegation warning.`,
        'Controls outside the hosted catalogue (canvas-controls.mjs) and component instances are listed as unsupported (requirement canvas:app/<name>).',
      ],
    },
  };
}
