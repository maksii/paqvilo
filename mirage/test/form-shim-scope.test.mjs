// @test-kind observation: native portal observed 2026-11-12 on a developer environment (single capture): `String.prototype.trim` and `document.getElementsByClassName` are replaced only on pages that load the basic-form or multistep-form scripts (crmentityformview.js / webform.js); on a list-only page both are native and `getElementsByClassName` returns an HTMLCollection; the overrides are installed by the form scripts themselves
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const FORM_SCRIPTS = { 'webform.js': 'xrm-webform-compat.js', 'crmentityformview.js': 'crmentityformview-compat.js' };
const sourceOf = (file) => fs.readFileSync(new URL(`../lib/${file}`, import.meta.url), 'utf8');

// A stand-in document: the native getElementsByClassName is inherited (an HTMLCollection stand-in marked
// `native`), and the form configuration script is present only on pages that render a form.
function createPage({ form }) {
  const nativeDocument = { getElementsByClassName: () => Object.assign([], { native: true }) };
  const document = Object.create(nativeDocument, {
    readyState: { value: 'complete' },
    getElementsByTagName: { value: () => [{ className: 'form-control' }, { className: 'control' }] },
    getElementById: { value: () => null },
    querySelector: {
      value: (selector) => (selector === 'script[data-paqvilo-mirage-form-config]' && form ? {} : null),
    },
    querySelectorAll: { value: () => [] },
    addEventListener: { value: () => {} },
  });
  const context = vm.createContext({ document, console, addEventListener: () => {}, setTimeout: () => {} });
  // Runs the named form scripts in page order, as the markup of the page names them.
  const load = (names) => {
    for (const name of names) vm.runInContext(sourceOf(FORM_SCRIPTS[name]), context);
    return context;
  };
  return { context, load };
}

const trimIsNative = (context) => /\[native code\]/.test(vm.runInContext('String.prototype.trim.toString()', context));
// 'native' for the inherited HTMLCollection stand-in, 'array' for the shim's Array.
const classNameKind = (context) =>
  vm.runInContext(
    "(() => { const found = document.getElementsByClassName('form-control'); return found.native ? 'native' : Array.isArray(found) ? 'array' : 'other'; })()",
    context,
  );

test('a list-only page that loads neither form script keeps the native trim and an HTMLCollection stand-in', () => {
  const { context } = createPage({ form: false });
  assert.equal(trimIsNative(context), true);
  assert.equal(classNameKind(context), 'native');
});

test('a basic-form page loads both form scripts: the replacements apply and getElementsByClassName returns an Array', () => {
  const { load } = createPage({ form: true });
  const context = load(['webform.js', 'crmentityformview.js']);
  assert.equal(trimIsNative(context), false);
  assert.equal(classNameKind(context), 'array');
  assert.equal(
    vm.runInContext(
      "JSON.stringify(document.getElementsByClassName('form-control').map((element) => element.className))",
      context,
    ),
    '["form-control"]',
  );
  assert.equal(vm.runInContext("'  x  '.trim()", context), 'x');
});

test('a page without a form whose markup names crmentityformview.js has the replacements too', () => {
  const { load } = createPage({ form: false });
  const context = load(['crmentityformview.js']);
  assert.equal(trimIsNative(context), false);
  assert.equal(classNameKind(context), 'array');
});
