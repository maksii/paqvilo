import { isAlias, isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { appCoverage, appPath, appRule, atNode } from './app-common.mjs';

const yamlReference = 'https://learn.microsoft.com/power-apps/maker/canvas-apps/power-apps-yaml';
const formulaReference = 'https://learn.microsoft.com/power-platform/power-fx/yaml-formula-grammar';
const startupReference = 'https://learn.microsoft.com/power-apps/maker/canvas-apps/working-with-large-apps';
const forallReference = 'https://learn.microsoft.com/power-platform/power-fx/reference/function-forall';
export const canvasRules = [
  appRule(
    'APP-CANVAS-001',
    'Invalid Canvas YAML source',
    'error',
    'reliability',
    'Canvas YAML contains invalid syntax, duplicate keys or an invalid document root.',
    'Correct the YAML structure, then run the native Canvas compiler/App Checker; local parsing does not establish runtime behavior.',
    { references: [yamlReference] },
  ),
  appRule(
    'APP-CANVAS-002',
    'Canvas property formula prefix',
    'error',
    'compatibility',
    'A PA-YAML Properties value is not a string expression beginning with an equals sign.',
    'Represent each property as an equals-prefixed Power Fx string; quote record literals or use a YAML block scalar where necessary.',
    { references: [formulaReference] },
  ),
  appRule(
    'APP-CANVAS-003',
    'Canvas component creation keywords',
    'error',
    'compatibility',
    'An explicit CanvasComponent or CodeComponent instance has missing or conflicting creation keywords.',
    'Supply ComponentName. Component instances do not support Variant/Layout; CodeComponent also does not support ComponentLibraryUniqueName.',
    { references: [yamlReference] },
  ),
  appRule(
    'APP-CANVAS-004',
    'Retired Canvas source format',
    'hint',
    'compatibility',
    'Legacy FX-YAML source was found; current PA-YAML checks do not apply to this representation.',
    'Preserve the original sources and assess migration with the current supported Canvas tooling. Do not relabel legacy source as validated PA-YAML.',
    { references: [yamlReference] },
  ),
  appRule(
    'APP-CANVAS-005',
    'Imperative startup navigation',
    'hint',
    'performance',
    'App.OnStart contains an unqualified Navigate call.',
    'Review whether App.StartScreen can express initial navigation declaratively; verify dependencies and native behavior before changing it.',
    { references: [startupReference], confidence: 'medium' },
  ),
  appRule(
    'APP-CANVAS-006',
    'Startup collection initialization',
    'hint',
    'performance',
    'App.OnStart contains collection initialization.',
    'Measure startup work and distinguish external data calls from local collections. Consider lazy formulas or deferred loading; parallelize only proven independent calls.',
    { references: [startupReference], confidence: 'medium' },
  ),
  appRule(
    'APP-CANVAS-007',
    'Iterative Power Fx data work',
    'hint',
    'performance',
    'A formula contains nested ForAll or Patch inside ForAll.',
    'Review data volume, delegation and target connector semantics. Validate any batched or server-side alternative; this source pattern does not prove one HTTP call per row.',
    { references: [forallReference], confidence: 'medium' },
  ),
  appRule(
    'APP-CANVAS-008',
    'Canvas source analysis boundary',
    'hint',
    'compatibility',
    'Canvas source uses aliases, unsupported top-level structure, or exceeds the local syntax-inspection budget.',
    'Use the native Canvas compiler and an explicit supported source export. The local analyzer does not expand aliases or guess unknown schema semantics.',
    { references: [yamlReference], confidence: 'medium' },
  ),
  appRule(
    'APP-CANVAS-009',
    'Canvas accessible name review',
    'hint',
    'accessibility',
    'An explicitly recognized interactive control has no AccessibleLabel property.',
    'Check the actual accessible name, including valid platform defaults, with the Accessibility Checker and keyboard/screen-reader testing.',
    {
      references: ['https://learn.microsoft.com/power-apps/maker/canvas-apps/accessibility-checker'],
      confidence: 'medium',
    },
  ),
];

export const canvasTopLevelKeys = new Set(['App', 'Screens', 'ComponentDefinitions', 'DataSources', 'EditorState']);
const interactive = new Set([
  'Button',
  'ModernButton',
  'TextInput',
  'ModernTextInput',
  'DropDown',
  'ModernDropdown',
  'ComboBox',
  'ModernCombobox',
  'Gallery',
]);
const keyOf = (node) => (isScalar(node) && typeof node.value === 'string' ? node.value : null);
const member = (node, name) => (isMap(node) ? node.items.find((pair) => keyOf(pair.key) === name)?.value : undefined);
const scalar = (node) => (isScalar(node) ? node.value : undefined);
function quotedEnd(text, start) {
  const quote = text[start];
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] !== quote) continue;
    if (text[index + 1] === quote) index++;
    else return index + 1;
  }
  return text.length;
}
function triviaEnd(text, index) {
  if (text.startsWith('//', index)) {
    const next = text.indexOf('\n', index + 2);
    return next < 0 ? text.length : next + 1;
  }
  if (text.startsWith('/*', index)) {
    const next = text.indexOf('*/', index + 2);
    return next < 0 ? text.length : next + 2;
  }
  if (text[index] === '"' || text[index] === "'") return quotedEnd(text, index);
  return index;
}
function recordFormulaCall(state, name) {
  const global = state.previous !== '.';
  if (global && name === 'navigate') state.result.navigate = true;
  if (global && ['collect', 'clearcollect'].includes(name)) state.result.collect = true;
  if (global && state.forAll > 0 && ['forall', 'patch'].includes(name)) state.result.iterative = true;
  const active = global && name === 'forall';
  state.calls.push(active);
  if (active) state.forAll++;
}
function scanFormulaWord(text, state) {
  const start = state.cursor++;
  while (state.cursor < text.length && /\w/.test(text[state.cursor])) state.cursor++;
  const name = text.slice(start, state.cursor).toLowerCase();
  while (state.cursor < text.length && /\s/.test(text[state.cursor])) state.cursor++;
  if (text[state.cursor] === '(') {
    recordFormulaCall(state, name);
    state.cursor++;
  }
  state.previous = 'identifier';
}
function scanFormulaPunctuation(text, state) {
  const character = text[state.cursor++];
  if (character === '(') state.calls.push(false);
  else if (character === ')' && state.calls.pop()) state.forAll--;
  if (!/\s/.test(character)) state.previous = character;
}
// A single pass over literal formula syntax. It does not evaluate expressions or infer external data sources.
function formulaPatterns(text) {
  const result = { navigate: false, collect: false, iterative: false };
  // Interpolation islands require a full Power Fx lexer; never mistake text inside them for a call.
  if (text.includes('$"')) return result;
  const state = { result, calls: [], forAll: 0, previous: '', cursor: 0 };
  while (state.cursor < text.length) {
    const skipped = triviaEnd(text, state.cursor);
    if (skipped > state.cursor) {
      if (text[state.cursor] === '"' || text[state.cursor] === "'") state.previous = 'literal';
      state.cursor = skipped;
    } else if (/[A-Za-z_]/.test(text[state.cursor])) scanFormulaWord(text, state);
    else scanFormulaPunctuation(text, state);
  }
  return result;
}
function inspectProperties(node, app, entry, emit) {
  const properties = member(node, 'Properties');
  if (!properties) return;
  if (!isMap(properties)) {
    emit('APP-CANVAS-002', entry, 'Properties', atNode(properties));
    return;
  }
  for (const pair of properties.items) {
    const formula = scalar(pair.value);
    if (typeof formula !== 'string' || !formula.startsWith('=')) {
      emit('APP-CANVAS-002', entry, 'Properties', atNode(pair.value));
      continue;
    }
    const patterns = formulaPatterns(formula);
    const offset = atNode(pair.value);
    if (app && keyOf(pair.key) === 'OnStart' && patterns.navigate) emit('APP-CANVAS-005', entry, 'OnStart', offset);
    if (app && keyOf(pair.key) === 'OnStart' && patterns.collect) emit('APP-CANVAS-006', entry, 'OnStart', offset);
    if (patterns.iterative) emit('APP-CANVAS-007', entry, 'Properties', offset);
  }
}
function inspectComponent(node, entry, emit) {
  const control = scalar(member(node, 'Control'));
  if (typeof control !== 'string') return;
  const kind = control.replace(/^Classic\//, '').split('@')[0];
  const component = kind === 'CanvasComponent' || kind === 'CodeComponent';
  if (component) {
    const name = scalar(member(node, 'ComponentName'));
    if (
      typeof name !== 'string' ||
      !name.trim() ||
      member(node, 'Variant') ||
      member(node, 'Layout') ||
      (kind === 'CodeComponent' && member(node, 'ComponentLibraryUniqueName'))
    )
      emit('APP-CANVAS-003', entry, 'Control', atNode(node));
  }
  const properties = member(node, 'Properties');
  if (interactive.has(kind) && !member(properties, 'AccessibleLabel'))
    emit('APP-CANVAS-009', entry, 'Properties', atNode(node));
}
function appendCanvasChildren(current, root, pending, entry, emit) {
  const { node, app, named, inspect } = current;
  if (isMap(node)) {
    if (inspect) {
      inspectProperties(node, app, entry, emit);
      inspectComponent(node, entry, emit);
    }
    for (const pair of node.items) {
      const key = keyOf(pair.key);
      pending.push({
        node: pair.value,
        app: node === root && key === 'App',
        named: key === 'Children' || (node === root && ['Screens', 'ComponentDefinitions'].includes(key)),
        inspect: named || (node === root && key === 'App'),
      });
    }
  } else if (isSeq(node))
    for (const value of node.items) pending.push({ node: value, app: false, named, inspect: false });
}
function inspectDocument(root, entry, emit) {
  if (!isMap(root)) {
    emit('APP-CANVAS-001', entry);
    return;
  }
  if (!root.items.length || root.items.some((pair) => !canvasTopLevelKeys.has(keyOf(pair.key)))) {
    emit('APP-CANVAS-008', entry);
    return;
  }
  const pending = [{ node: root, app: false, named: false, inspect: false }];
  let inspected = 0;
  while (pending.length) {
    const current = pending.pop();
    const { node } = current;
    if (++inspected > 100000 || isAlias(node)) {
      emit('APP-CANVAS-008', entry, undefined, atNode(node));
      return;
    }
    appendCanvasChildren(current, root, pending, entry, emit);
  }
}
function inspectCanvas(entry, emit) {
  let document;
  try {
    document = parseDocument(entry.text, { uniqueKeys: true });
  } catch {
    emit('APP-CANVAS-001', entry);
    return;
  }
  if (document.errors.length) emit('APP-CANVAS-001', entry);
  else inspectDocument(document.contents, entry, emit);
}
export function analyzeCanvas(entries, emit) {
  let files = 0;
  for (const entry of entries) {
    if (/\.pa\.ya?ml$/i.test(appPath(entry))) {
      files++;
      inspectCanvas(entry, emit);
    } else if (/\.fx\.ya?ml$/i.test(appPath(entry))) {
      files++;
      emit('APP-CANVAS-004', entry);
    }
  }
  return appCoverage(files, [
    'native-canvas-compiler',
    'app-checker-and-accessibility-checker',
    'delegation-and-connector-runtime',
    'partial-literal-power-fx-patterns',
    'interpolated-power-fx-not-pattern-scanned',
    'rendered-layout-and-control-versions',
  ]);
}
