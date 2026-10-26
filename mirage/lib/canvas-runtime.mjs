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
import { ErrorKind, FxDataSource, FxError, FxRecordRef, evaluateFx, fromFx } from './power-fx.mjs';
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
const IDENT = /^(?:[A-Za-z_][\w]*|'(?:[^']|'')+')$/;
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
 * (the host change slot); `connectors({ reference, operationId, body, principal })` → result or undefined; `launch(entry)`
 * hears every Launch; `diagnostic(record)` receives runtime diagnostics.
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
  const records = context
    ? dataverseHost(api, { c: context, diagnostic: (entry) => hostDiagnostic(entry, 'Dataverse') })
    : null;
  const source = app.source,
    tree = source.tree ?? {
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
    // A formula starts with `=`; any other scalar is a literal value.
    formulas
      .get(owner)
      .set(
        row.property,
        raw.startsWith('=')
          ? { formula: raw.slice(1).trim(), source: row.source, line: row.line }
          : { value: literal(raw), source: row.source, line: row.line },
      );
  }
  const screens = new Map(),
    controls = new Map(),
    lower = new Map();
  for (const screen of tree.screens) {
    screens.set(screen.name, { name: screen.name });
    lower.set(screen.name.toLowerCase(), screen.name);
    for (const control of screen.controls ?? []) {
      const kind = control.componentName ? null : controlKind(control.control, format);
      controls.set(control.name, {
        name: control.name,
        type: control.control ?? null,
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

  // ---- state ----
  // Set, UpdateContext, Navigate's context record, Collect and ClearCollect establish a name, which reads
  // blank (a collection: empty) until a formula fills it.
  const variables = {},
    globals = new Set(),
    collections = new Set(),
    contexts = new Map(screenNames.map((name) => [name, {}]));
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
      for (const call of callsIn(
        entry.formula,
        (item) => !item.member && ['Set', 'UpdateContext', 'Navigate', 'Collect', 'ClearCollect'].includes(item.name),
      )) {
        const args = splitTop(entry.formula.slice(call.open + 1, call.end), ',');
        if (call.name === 'Set' && IDENT.test(args[0])) {
          variables[unquote(args[0])] ??= null;
          globals.add(unquote(args[0]));
        } else if (call.name.endsWith('Collect') && IDENT.test(args[0]) && !dataSources.has(unquote(args[0]))) {
          collections.add(unquote(args[0]));
          variables[unquote(args[0])] = [];
        } else if (call.name === 'UpdateContext') {
          for (const key of recordKeys(args[0])) if (contexts.has(home)) contexts.get(home)[key] ??= null;
        } else if (call.name === 'Navigate') {
          const target = IDENT.test(args[0]) ? unquote(args[0]) : null,
            screen = screens.has(target) ? target : controls.get(target)?.screen;
          for (const key of recordKeys(args[2])) if (contexts.has(screen)) contexts.get(screen)[key] ??= null;
        }
      }
    }
  const state = {
    current: null,
    viewport: canvasViewport(viewport),
    history: [],
    inputs: new Map(),
    selected: new Map(),
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
  const fromError = (error, where) => ({
    ...location(where),
    code: error.code ?? 'CanvasFormulaError',
    kind: error.details?.kind ?? error.kind ?? 'Unknown',
    message: error.message,
    source: where,
    ...(error.status ? { status: error.status } : {}),
  });
  const fromFxError = (value, where) =>
    value.errors.map((item) => ({
      ...location(where),
      code: 'PowerFxError',
      kind: kindName(item.Kind),
      message: item.Message ?? '',
      source: where,
      ...(item.Details?.HttpStatusCode ? { status: item.Details.HttpStatusCode } : {}),
    }));

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
      ]);
      // Behaviour properties (On…) run only as behaviour; they are not values of the record.
      for (const property of names)
        if (!BEHAVIOUR_PROPERTY.test(property))
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
    const define = (name, get) => Object.defineProperty(out, name, { enumerable: true, configurable: true, get });
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
  const hostFor = (scope, where) => ({
    variables: trackedState(variables, 'variable'),
    context: trackedState(contexts.get(screenOf(scope)), `context:${screenOf(scope)}`),
    app: 'canvas',
    dataRowLimit: CANVAS_DATA_ROW_LIMIT,
    dataSource: (name) => {
      const entry = dataSources.get(name),
        table = entry?.table ?? name;
      // By entity set: a store mapping keyed by logical name need not repeat its logicalName.
      const found = records?.dataSource(api.store?.state?.mappings?.[table]?.entitySet ?? table);
      return found ? new FxDataSource(name, journaledAdapter(found.adapter)) : undefined;
    },
    diagnostic: (entry) => hostDiagnostic(entry, where),
    ...(records ? { user: records.user, timeZone: records.timeZone, language: records.language } : {}),
    // Now() and GUID() answer from the replay journal when a behaviour formula runs again after a connector answer.
    now: () => journaled('now', records ? records.now : Date.now),
    guid: () => journaled('guid', () => crypto.randomUUID()),
    // Navigation is applied when the behaviour formula completes; the docs state that queueing for Select only, so it is a guess here.
    navigate: (target, transition, update) => {
      const named = nameOf(target),
        screen = screens.has(named) ? named : controls.get(named)?.screen;
      if (!screen) throw fail(`Navigate target is not a screen of this app.`, 'CanvasScreenNotFound', 404);
      pending.push(
        Object.assign(
          () => show(screen, { transition: transition ?? 'None', update: isPlain(update) ? update : null, push: true }),
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
            : connectorFunction(name, scope.connectors ?? { list: [], next: 0 }),
    }),
  });
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
    let value;
    try {
      value = compute(name, property, scope);
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
  function compute(name, property, scope) {
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
      case 'checkbox.Value':
      case 'toggle.Value': {
        const set = input(name, scope);
        return set !== undefined ? set : fallback(name, 'Default', scope) === true;
      }
      case 'datepicker.SelectedDate': {
        const set = input(name, scope);
        return set !== undefined ? set : fallback(name, 'DefaultDate', scope);
      }
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
        clearInputs(controlArg(target, null, 'Reset'), true);
        return true;
      },
      // The target's OnSelect is queued and runs after the current formula.
      Select: (target) => {
        const control = controlArg(target, null, 'Select');
        pending.push(() => select(control, scope.gallery && scope.gallery === galleryOf(control) ? scope : {}));
        return true;
      },
      Refresh: () => {
        pending.push(() => forget());
        return true;
      },
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
  const journaledAdapter = (adapter) => ({
    ...adapter,
    read: (query) => journaled('read', () => adapter.read(query)),
    count: (query) => journaled('count', () => adapter.count(query)),
    create: (record) => journaled('create', () => adapter.create(record)),
    update: (base, changes) => journaled('update', () => adapter.update(base, changes)),
    remove: (record) => journaled('remove', () => adapter.remove(record)),
  });
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
    forms: new Map(state.forms),
    inputs: new Map(state.inputs),
    selected: new Map(state.selected),
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
    for (const [screen, values] of saved.contexts) {
      const target = contexts.get(screen);
      for (const key of Object.keys(target)) delete target[key];
      Object.assign(target, values);
    }
    state.forms = saved.forms;
    state.inputs = saved.inputs;
    state.selected = saved.selected;
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
            return { result: evaluate(text, { ...scope, connectors: tape }, where) };
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
    if (previous) await behaviour(previous, 'OnHidden', { screen: previous });
    if (update) {
      Object.assign(trackedState(contexts.get(screen), `context:${screen}`), update);
      forget();
    }
    state.current = screen;
    if (push) state.history.push({ screen, transition });
    changed('screen:current');
    log({ event: 'navigate', from: previous, to: screen, transition });
    await behaviour(screen, 'OnVisible', { screen });
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
        control: controls.has(owner) ? owner : scope.control,
        screen: screens.has(owner) && !controls.has(owner) ? owner : scope.screen,
      },
      `${owner}.${property}`,
    );
  }
  async function select(control, scope) {
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
    } else if (entry.kind === 'dropdown') {
      const list = items(name);
      next = indexOf(list, given);
      if (next < 0 || next >= list.length) throw fail(`${name} has no item ${given}.`, 'CanvasItemNotFound', 404);
    } else if (entry.kind === 'combobox') {
      const list = items(name);
      next = [given].flat().map((choice) => indexOf(list, choice));
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
        await settle();
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
              `Unknown canvas action ${request?.action}; use select, input, navigate, back, run, evaluate, resize or refresh.`,
              'CanvasActionInvalid',
            );
        }
        await settle();
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
          ]),
        ].filter((property) => !BEHAVIOUR_PROPERTY.test(property));
        const out = {
          name,
          type: entry.type,
          variant: entry.variant,
          kind: entry.kind,
          parent: entry.parent,
          supported: entry.supported,
          properties: Object.fromEntries(names.map((property) => [property, observable(read(name, property, scope))])),
          behaviours: [...(formulas.get(name)?.keys() ?? [])].filter((property) => BEHAVIOUR_PROPERTY.test(property)),
        };
        if (entry.kind === 'gallery')
          out.items = items(name)
            .slice(0, SNAPSHOT_ITEMS)
            .map((item, index) => ({
              index,
              controls: Object.fromEntries(
                descendants(name)
                  .filter((child) => controls.get(child).supported)
                  .map((child) => [child, describe(child, { gallery: name, itemIndex: index, item }).properties]),
              ),
            }));
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
        viewport: { ...state.viewport },
        currentScreen: state.current,
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
const SNAPSHOT_ITEMS = 50; // ponytail: a snapshot lists the first 50 gallery rows; drive later rows by index through the API.
// Properties the runtime maintains for each kind (beyond the declared ones).
const OUTPUTS = Object.freeze({
  textinput: ['Text'],
  checkbox: ['Value'],
  toggle: ['Value'],
  datepicker: ['SelectedDate'],
  dropdown: ['Selected'],
  combobox: ['SelectedItems', 'Selected'],
  gallery: ['Selected', 'AllItems'],
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
      if (!instances.has(key)) {
        const app = (apps() ?? []).find((entry) => entry.uniqueName === uniqueName);
        if (!app) throw fail('Canvas app not found.', 'CanvasAppNotFound', 404);
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
        instances.set(key, created);
        await created.start().catch((error) => {
          instances.delete(key);
          throw error;
        });
      }
      return instances.get(key);
    },
    /** The started instance, or null: reading never starts an app (no OnStart without a CSRF-checked POST). */
    existing(uniqueName, principal) {
      return instances.get(keyOf(uniqueName, principal)) ?? null;
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
    operations: ['open', 'select', 'input', 'navigate', 'back', 'run', 'evaluate', 'resize', 'refresh'].map((name) => ({
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
