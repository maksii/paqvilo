// @test-kind contract: Mirage render provenance design (every element of every page of the example projects that renders in-process is bound to its exported source region or to the platform part that generated it, and no derived binding is without a region)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'parse5';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { isToolkitElement } from '../lib/render-provenance.mjs';
import { exampleRuntime } from './support/example-runtime.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
// Only the harness of the Company Operations project is read (its README and other parts select no suite).
const harness = path.resolve(here, '../../examples/company-operations/portal-harness');
const ACCOUNT = 'a4300000-0000-4000-8000-000000001001';
// The example persona with the richest role: the one contact the example pack gives Workspace Editors.
const EDITOR = {
  id: 'a4300000-0000-4000-8000-000000002001',
  contactId: 'a4300000-0000-4000-8000-000000002001',
  fullname: 'Alex Example 01',
  roles: ['Workspace Editors', 'Authenticated Users'],
};

/**
 * The Company Operations permission harness as its deployment writes it (portal-harness/deploy.mjs): a home page, the
 * /permission-lab/ shell page and its /permission-lab/liquid/ data endpoint, with the compiled shell and dispatcher
 * web templates (portal-harness/compile.mjs prepare, written to a temporary directory).
 */
async function harnessPortal() {
  const { prepare } = await import(pathToFileURL(path.join(harness, 'compile.mjs')).href);
  const { shellSource } = await import(pathToFileURL(path.join(harness, 'deploy.mjs')).href);
  const output = await fsp.mkdtemp(path.join(os.tmpdir(), 'paqvilo-harness-'));
  try {
    const { manifest, templates } = await prepare({ outputDirectory: output });
    const id = (n) => `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
    const record = (kind, n, name, extra = {}) => ({ kind, id: id(n), name, ...extra });
    const webTemplates = [
      ...templates.map((template, index) => ({ id: id(1000 + index), ...template })),
      { id: id(2), name: 'CO Permission Lab Shell', source: await shellSource(manifest) },
    ].map((template) => ({ ...template, metadata: record('webtemplate', 0, template.name, { id: template.id }) }));
    const dispatcher = webTemplates.find((template) => template.name === 'CO Permission Lab Liquid Dispatcher');
    const page = (n, name, url, parentId, pageTemplateId) => ({
      id: id(n),
      name,
      title: name,
      url,
      parentId,
      pageTemplateId,
      html: '',
      css: '',
      js: '',
      summary: '',
      metadata: record('webpage', n, name, { title: name }),
    });
    const pages = [
      page(10, 'Home', '/', null, id(20)),
      page(11, 'Permission Lab', '/permission-lab/', id(10), id(21)),
      page(12, 'Permission Lab Liquid Data', '/permission-lab/liquid/', id(11), id(22)),
    ];
    const pageTemplate = (n, name, webTemplateId, useHeaderFooter) => ({
      id: id(n),
      name,
      webTemplateId,
      useHeaderFooter,
      rewriteUrl: null,
      metadata: record('pagetemplate', n, name),
    });
    return {
      sourceDir: null,
      website: { id: id(1), name: 'Invented harness site' },
      pages,
      pageTemplates: [
        pageTemplate(20, 'Home', null, true),
        pageTemplate(21, 'CO Permission Lab', id(2), true),
        pageTemplate(22, 'CO Permission Lab Liquid Data', dispatcher.id, false),
      ],
      templates: Object.fromEntries(webTemplates.map((template) => [template.id, template])),
      snippets: {},
      settings: {},
      records: [
        ...pages.map((item) => item.metadata),
        ...webTemplates.map((item) => item.metadata),
        record('pagetemplate', 20, 'Home'),
        record('pagetemplate', 21, 'CO Permission Lab'),
        record('pagetemplate', 22, 'CO Permission Lab Liquid Data'),
      ],
      weblinkSets: [],
      weblinks: {},
      sitemarkers: {},
      webFiles: [],
      websiteLanguages: [],
      shortcuts: [],
    };
  } finally {
    await fsp.rm(output, { recursive: true, force: true });
  }
}

/** total / literal / derived (all with a region) / platform / unbound elements of a finalized document. */
function census(html, provenance) {
  const byId = new Map(provenance.bindings.map((binding) => [binding.id, binding]));
  const row = { total: 0, literal: 0, derived: 0, platform: 0, unbound: 0, derivedWithoutRegion: [] };
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (!child.tagName) continue;
      if (!isToolkitElement(child.attrs.map((attribute) => attribute.name))) {
        row.total++;
        const binding = byId.get(child.attrs.find((attribute) => attribute.name === 'data-paqvilo-source')?.value);
        if (!binding) row.unbound++;
        else row[binding.mapping] = (row[binding.mapping] ?? 0) + 1;
        if (binding?.mapping === 'derived' && !binding.region) row.derivedWithoutRegion.push(child.tagName);
      }
      walk(child);
      if (child.content) walk(child.content);
    }
  };
  walk(parse(html));
  return row;
}

async function gate(t, renderer, targets, label) {
  const table = [];
  for (const [url, identity] of targets) {
    const rendered = await renderer.renderPage(url, identity ? { user: identity } : {});
    if (!rendered.isDocument && !/^\s*<!doctype html/i.test(rendered.html)) {
      table.push({
        page: url,
        identity: identity ? 'signed in' : 'anonymous',
        document: false,
        status: rendered.status,
      });
      continue;
    }
    const { html, provenance } = renderer.provenanceFor(rendered);
    const row = census(html, provenance);
    table.push({ page: url, identity: identity ? 'signed in' : 'anonymous', status: rendered.status, ...row });
    assert.equal(provenance.unbound, 0, `${label} ${url}: no element without a binding`);
    assert.equal(provenance.omitted, 0, `${label} ${url}: no binding omitted`);
    assert.equal(row.unbound, 0, `${label} ${url}`);
    assert.deepEqual(row.derivedWithoutRegion, [], `${label} ${url}: every derived binding has a region`);
  }
  for (const row of table)
    t.diagnostic(
      row.document === false
        ? `${label} ${row.page} [${row.identity}] status ${row.status}: not an HTML document`
        : `${label} ${row.page} [${row.identity}] status ${row.status}: total ${row.total}, literal ${row.literal}, derived ${row.derived} (all with a region), platform ${row.platform}, unbound ${row.unbound}`,
    );
  return table;
}

test('every page of examples/project binds every element, anonymous and as the editor persona', async (t) => {
  const { portal, renderer } = await exampleRuntime({ owner: 'visitor:gate' });
  const native = '/approach/out-of-the-box/account/';
  const urls = [
    ...portal.pages.map((page) => page.url),
    `${native}?mode=create`,
    `${native}?id=${ACCOUNT}&mode=edit`,
    `${native}?id=${ACCOUNT}`,
  ];
  const table = await gate(
    t,
    renderer,
    urls.flatMap((url) => [
      [url, null],
      [url, EDITOR],
    ]),
    'project',
  );
  assert.equal(table.length, urls.length * 2);
  assert.ok(table.every((row) => row.document !== false));
});

test('every page of the Company Operations harness binds every element, anonymous and as the test runner', async (t) => {
  const portal = await harnessPortal();
  const renderer = createPortalRenderer(portal);
  const runner = {
    id: 'c0de0000-0000-4000-8000-0000000000f1',
    contactId: 'c0de0000-0000-4000-8000-0000000000f1',
    roles: ['CO Test Runner'],
  };
  const table = await gate(
    t,
    renderer,
    portal.pages.flatMap((page) => [
      [page.url, null],
      [page.url, runner],
    ]),
    'harness',
  );
  const documents = table.filter((row) => row.document !== false).map((row) => row.page);
  assert.ok(documents.includes('/permission-lab/'), 'the harness page renders as a document');
});

/** Every element `select` picks, with its binding: the file relative to `root`, the region and the contexts' code. */
function boundElements(html, provenance, index, root, select) {
  const byId = new Map(provenance.bindings.map((binding) => [binding.id, binding]));
  const found = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (!child.tagName) continue;
      const attribute = (name) => child.attrs.find((item) => item.name === name)?.value ?? '';
      if (select(child.tagName, attribute)) {
        const binding = byId.get(attribute('data-paqvilo-source'));
        const source = index.sources.get(binding?.sourceRefId);
        found.push({
          tag: child.tagName,
          className: attribute('class'),
          mapping: binding?.mapping,
          file: source?.file ? path.relative(root, source.file).split(path.sep).join('/') : null,
          start: binding?.region?.start,
          line: binding?.region?.line,
          contexts: (binding?.contexts ?? []).map((context) => {
            // A context without a place (the record that configures a component) is named by null.
            const host = index.sources.get(context.sourceRefId);
            return context.region ? host.text.slice(context.region.start, context.region.end) : null;
          }),
        });
      }
      walk(child);
    }
  };
  walk(parse(html));
  return found;
}

test('pages generated by Liquid conditions, loops and includes over data: every element bound, each construct to its own place', async (t) => {
  const {
    writeDynamicPortal,
    exportRenderer,
    DYNAMIC,
    DYNAMIC_FILES,
    DYNAMIC_PAGES,
    EDITOR: PERSONA,
  } = await import('../../test/fixtures/dynamic-liquid-portal.mjs');
  const output = await fsp.mkdtemp(path.join(os.tmpdir(), 'paqvilo-dynamic-gate-'));
  t.after(() => fsp.rm(output, { recursive: true, force: true }));
  // The source index names files by their real path; a temporary directory reached through a Windows 8.3 alias
  // (hosted runners, local validation) is not one, so the root the files are named against is resolved the same way.
  const root = fs.realpathSync.native(writeDynamicPortal(path.join(output, 'portal')));
  const { renderer } = await exportRenderer(root);
  const table = await gate(
    t,
    renderer,
    DYNAMIC_PAGES.flatMap((url) => [
      [url, null],
      [url, structuredClone(PERSONA)],
    ]),
    'dynamic',
  );
  assert.ok(table.every((row) => row.document !== false && row.status === 200));

  const page = DYNAMIC_FILES[DYNAMIC.page];
  const card = DYNAMIC_FILES[DYNAMIC.card];
  const lineOf = (text, at) => text.slice(0, at).split('\n').length;
  const place = (text, file, needle) => ({
    mapping: 'literal',
    file: file,
    start: text.indexOf(needle),
    line: lineOf(text, text.indexOf(needle)),
  });
  const pageAt = (needle) => place(page, DYNAMIC.page, needle);
  const index = renderer.sourceIndex();
  const pick = async (url, user, select) => {
    const { html, provenance } = renderer.provenanceFor(await renderer.renderPage(url, user ? { user } : {}));
    return boundElements(html, provenance, index, root, select);
  };
  const strip = ({ mapping, file, start, line }) => ({ mapping, file, start, line });
  const classed = (name) => (_tag, attribute) => attribute('class').split(' ').includes(name);

  // Each item of a loop is the loop body's tag; the empty loop's else branch is its own tag.
  const colors = await pick('/dyn/alpha/', null, classed('dyn-color'));
  assert.equal(colors.length, 4, 'limit 4 offset 1 over five colours');
  assert.deepEqual(
    colors.map(strip),
    colors.map(() => pageAt('<li class="dyn-color')),
  );
  assert.deepEqual((await pick('/dyn/alpha/', null, classed('dyn-empty-else'))).map(strip), [
    pageAt('<li class="dyn-empty-else">'),
  ]);
  // Each branch of a condition is its own place: anonymous on Alpha, signed in anywhere.
  assert.deepEqual((await pick('/dyn/alpha/', null, classed('dyn-greeting'))).map(strip), [
    pageAt('<p class="dyn-greeting alpha">'),
  ]);
  assert.deepEqual((await pick('/dyn/beta/', null, classed('dyn-greeting'))).map(strip), [
    pageAt('<p class="dyn-greeting guest">'),
  ]);
  assert.deepEqual((await pick('/dyn/beta/', structuredClone(PERSONA), classed('dyn-greeting'))).map(strip), [
    pageAt('<p class="dyn-greeting signed">'),
  ]);
  // A partial included twice with different parameters, and once per loop item, names its own line, with the
  // including template's include tag as context.
  const cards = await pick('/dyn/alpha/', null, classed('dyn-card'));
  assert.deepEqual(
    cards.map((row) => [row.className, strip(row), row.contexts[0]]),
    [
      ['dyn-card tone-warm', "{% include 'Dyn Card' heading: 'First card' tone: 'warm' %}"],
      ['dyn-card tone-cool', "{% include 'Dyn Card' heading: 'Second card' tone: 'cool' %}"],
      ['dyn-card tone-loop', "{% include 'Dyn Card' heading: color tone: 'loop' %}"],
      ['dyn-card tone-loop', "{% include 'Dyn Card' heading: color tone: 'loop' %}"],
      ['dyn-card tone-record', "{% include 'Dyn Card' heading: account.name tone: 'record' %}"],
      ['dyn-card tone-record', "{% include 'Dyn Card' heading: account.name tone: 'record' %}"],
      ['dyn-card tone-record', "{% include 'Dyn Card' heading: account.name tone: 'record' %}"],
    ].map(([className, context]) => [className, place(card, DYNAMIC.card, '<article class="dyn-card'), context]),
  );
  // A snippet printed in a loop is the snippet's markup each time.
  const notes = await pick('/dyn/alpha/', null, classed('dyn-note'));
  assert.deepEqual(
    notes.map(strip),
    [0, 1].map(() => place(DYNAMIC_FILES[DYNAMIC.note], DYNAMIC.note, '<small class="dyn-note">')),
  );
  // ... and names the output that printed it, as an included template names its include tag.
  assert.deepEqual(
    notes.map((row) => row.contexts[0]),
    [0, 1].map(() => "{{ snippets['Dyn/Row note'] }}"),
  );
  // Captured markup printed as it is stays the literal of the capture; printed through a filter, the filter wrote it.
  const banners = await pick('/dyn/alpha/', null, classed('dyn-banner'));
  assert.deepEqual(banners.map(strip)[0], pageAt('<strong class="dyn-banner">'));
  assert.deepEqual(
    [banners[1].mapping, page.slice(banners[1].start).startsWith("{{ banner | replace: 'Captured', 'Shouted' }}")],
    ['derived', true],
  );
  // Rows tablerow writes are its own output.
  const rows = await pick('/dyn/alpha/', null, (tag) => tag === 'tr' || tag === 'td');
  const tablerow = rows.filter((row) => /^row\d|^col\d/.test(row.className));
  assert.ok(tablerow.length > 0);
  assert.ok(tablerow.every((row) => row.mapping === 'derived' && page.slice(row.start).startsWith('{% tablerow')));
  // A form a Liquid tag renders is the form's own configuration, and names the tag that asked for it: of several
  // form tags in a template, the one that ran.
  const fields = (
    await pick('/dyn/gamma/', structuredClone(PERSONA), (tag) => tag === 'input' || tag === 'select')
  ).filter((row) => row.mapping === 'platform');
  // (Inputs of the page shell around the form are no Liquid tag's: they carry no such place.)
  const asked = fields.filter((row) => row.contexts.some((context) => context !== null));
  assert.ok(asked.length >= 3, 'the form has several fields');
  assert.deepEqual(
    [...new Set(asked.flatMap((row) => row.contexts.filter((context) => context !== null)))],
    ["{% entityform name: 'Account Create' %}"],
  );
});
