// @test-kind contract: Paqvilo's PCF_CODE_RESOURCE_MODULE import diagnostic for a declared code resource that is an ES module bundle (design decision; the control stays imported), exercised with invented controls
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importCodeComponents, renderCodeComponent } from '../lib/code-components.mjs';
import { writeFixtureFiles } from './support/pcf-fixture-files.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

/** Imports one invented field control whose declared code resource is `bundle` at `codePath` (with `codeAttributes`). */
async function importBundle(t, bundle, { codePath = 'bundle.js', codeAttributes = '' } = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-pcf-module-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await writeFixtureFiles(dir, {
    'Controls/inv_Invented.Probe/ControlManifest.xml': `<manifest><control namespace="Invented" constructor="Probe" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="input"/><resources><code path="${codePath}" order="1"${codeAttributes}/></resources></control></manifest>`,
    'Controls/inv_Invented.Probe/ControlManifest.xml.data.xml':
      '<CustomControl><Name>inv_Invented.Probe</Name></CustomControl>',
    [`Controls/inv_Invented.Probe/${codePath}`]: bundle,
  });
  const catalog = await importCodeComponents([{ dir }]);
  return {
    catalog,
    modules: catalog.diagnostics.filter((entry) => entry.code === 'PCF_CODE_RESOURCE_MODULE'),
  };
}

const classic = [
  // The pcf-scripts webpack output: a classic script with one var and an IIFE.
  'var pcf_tools_1;(()=>{"use strict";var e={};pcf_tools_1=e;})();',
  // Dynamic import(), module words in strings, comments and property names are classic syntax.
  'ComponentFramework.registerControl("Invented.Probe",class{init(){const text="import x from \'y\'; export {}";/* export default */this.load=()=>import("./lazy.js");this.export=1;}});',
  // A bundle with an unrelated syntax error is not diagnosed as a module.
  'var = ;',
];

test('a classic bundle is imported without PCF_CODE_RESOURCE_MODULE', async (t) => {
  for (const bundle of classic) {
    const { catalog, modules } = await importBundle(t, bundle);
    assert.ok(catalog.controls.has('inv_Invented.Probe'), bundle);
    assert.deepEqual(modules, [], bundle);
  }
});

test('an ES module bundle reports PCF_CODE_RESOURCE_MODULE and stays imported', async (t) => {
  const cases = [
    [
      "import { helper } from './helper.js';\nComponentFramework.registerControl('Invented.Probe', class {});",
      /import statement/,
    ],
    ['export class Probe { init() {} }', /Unexpected token 'export'/],
    ['export default class {}', /Unexpected token 'export'/],
    ['const base = import.meta.url;', /import\.meta/],
    ['await Promise.resolve();', /await is only valid/],
  ];
  for (const [bundle, reason] of cases) {
    const { catalog, modules } = await importBundle(t, bundle);
    assert.ok(catalog.controls.has('inv_Invented.Probe'), bundle);
    assert.equal(modules.length, 1, bundle);
    assert.equal(modules[0].severity, 'warning');
    assert.equal(modules[0].path, 'bundle.js');
    assert.match(modules[0].file, /bundle\.js$/);
    assert.match(modules[0].message, /^PCF code resource bundle\.js is an ES module bundle: it holds ES module syntax/);
    assert.match(modules[0].message, reason);
    assert.match(modules[0].message, /loads declared code resources as classic scripts/);
  }
});

test('a code resource declared type="module" or named .mjs reports PCF_CODE_RESOURCE_MODULE', async (t) => {
  const plain = "ComponentFramework.registerControl('Invented.Probe', class {});";
  const typed = await importBundle(t, plain, { codeAttributes: ' type="module"' });
  assert.deepEqual(
    typed.modules.map((entry) => entry.message.match(/: ([^.]+)\./)[1]),
    ['the manifest declares it type="module"'],
  );
  const mjs = await importBundle(t, plain, { codePath: 'bundle.mjs' });
  assert.deepEqual(
    mjs.modules.map((entry) => [entry.path, /: it is an \.mjs file\./.test(entry.message)]),
    [['bundle.mjs', true]],
  );
});

/** The attributes of every script element of `html` that loads a `/_pcfwebresource/` address, in any order. */
function bundleScripts(html) {
  return [...html.matchAll(/<script\b([^>]*)>/gi)]
    .map((match) =>
      Object.fromEntries(
        [...match[1].matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*"([^"]*)")?/g)].map((attribute) => [
          attribute[1].toLowerCase(),
          attribute[2] ?? '',
        ]),
      ),
    )
    .filter((attributes) => attributes.src?.startsWith('/_pcfwebresource/'));
}

/** The Liquid host markup of the invented control imported from `bundle`. */
async function hostMarkup(t, bundle) {
  const { catalog } = await importBundle(t, bundle);
  return renderCodeComponent({
    name: 'inv_Invented.Probe',
    portal: {},
    catalog,
    args: { value: 'text' },
    liquidTag: true,
  });
}

/** A classic `type="text/javascript"` bundle script; a nonce (the captured pages carry one) is the only other attribute. */
function assertClassicBundleScript(html) {
  const scripts = bundleScripts(html);
  assert.equal(scripts.length, 1, html);
  const { type, src, nonce, ...others } = scripts[0];
  assert.equal(type, 'text/javascript');
  assert.match(src, /^\/_pcfwebresource\/[0-9a-f-]{36}\?\d+$/);
  assert.ok(nonce === undefined || nonce.length > 0, 'an empty nonce');
  assert.deepEqual(others, {});
}

// @test-kind observation: Power Pages loads a code component bundle with a classic script element (type "text/javascript", src "/_pcfwebresource/<id>?<stamp>", a nonce on list pages), live captures paqvilo-developer pcf-parity raw r2 and r3 list-ny.html, r2 edit-full-ny.html and lq-field-probe-ny.html (paqvilo3, 2026-11-26)
test('the host markup loads a classic bundle with a classic script element at its /_pcfwebresource/ address', async (t) => {
  assertClassicBundleScript(await hostMarkup(t, "ComponentFramework.registerControl('Invented.Probe', class {});"));
});

test('the host markup loads an ES module bundle with the same classic script element, never as a module', async (t) => {
  const html = await hostMarkup(t, 'export class Probe {}');
  assertClassicBundleScript(html);
  assert.ok(!bundleScripts(html).some((attributes) => attributes.type === 'module'));
});
