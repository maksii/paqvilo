// Render spans (docs/design/tracing.md): renderPage opens one `render` span; every template invocation opens one
// `render-template` span under the enclosing invocation's span, and reads issued by a template run inside its span.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importPortal } from '../lib/importer.mjs';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const files = {
  'website.yml':
    'adx_websiteid: site\nadx_name: Invented\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer\nadx_defaultlanguage: english',
  'web-pages/home/Home.webpage.yml':
    'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: main',
  'page-templates/Main.pagetemplate.yml':
    'adx_pagetemplateid: main\nadx_name: Main\nadx_usewebsiteheaderandfooter: true\nadx_webtemplateid: content',
  'web-templates/header/Header.webtemplate.yml': 'adx_webtemplateid: header\nadx_name: Header',
  'web-templates/header/Header.webtemplate.source.html': '<header>head</header>',
  'web-templates/footer/Footer.webtemplate.yml': 'adx_webtemplateid: footer\nadx_name: Footer',
  'web-templates/footer/Footer.webtemplate.source.html': '<footer>foot</footer>',
  'web-templates/content/Content.webtemplate.yml': 'adx_webtemplateid: content\nadx_name: Content',
  'web-templates/content/Content.webtemplate.source.html': "<main>{% include 'Inner' %}</main>",
  'web-templates/inner/Inner.webtemplate.yml': 'adx_webtemplateid: inner\nadx_name: Inner',
  'web-templates/inner/Inner.webtemplate.source.html':
    '{% fetchxml rows %}<fetch><entity name="x_item"><attribute name="x_name"/></entity></fetch>{% endfetchxml %}<p id="count">{{ rows.results.entities.size }}</p>',
};

async function portalFixture(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-render-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  for (const [name, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  return importPortal(dir);
}

test('a page render nests render-template spans through the template invocation tree; reads run inside their template', async (t) => {
  const portal = await portalFixture(t);
  const traces = createTraceStore({ settings: { level: 'summary' } });
  const readers = [];
  const renderer = createPortalRenderer(portal, {
    traces,
    fetchXml: async () => {
      readers.push(traces.current());
      return { entities: [{ x_name: 'one' }, { x_name: 'two' }], more_records: false };
    },
  });
  const result = await renderer.renderPage('/');
  assert.equal(result.status, 200);
  assert.match(result.html, /<p id="count">2<\/p>/);
  const [summary] = traces.query({ kind: 'render' }).items;
  const tree = traces.tree(summary.traceId);
  const render = tree.spans.find((span) => span.kind === 'render');
  assert.equal(render.parentSpanId, null);
  assert.equal(render.name, '/');
  assert.equal(render.module, 'liquid');
  assert.equal(render.status, 'ok');
  assert.deepEqual(
    [render.attributes.pageId, render.attributes.template, render.attributes.status],
    ['home', 'Main', 200],
  );
  const templates = tree.spans.filter((span) => span.kind === 'render-template');
  const byId = new Map(tree.spans.map((span) => [span.spanId, span]));
  assert.ok(templates.length >= 2, JSON.stringify(templates.map((span) => span.name)));
  for (const span of templates) {
    assert.equal(span.status, 'ok');
    assert.ok(['render', 'render-template'].includes(byId.get(span.parentSpanId)?.kind), span.name);
  }
  // The include runs inside the Content template's invocation, so its span is a child of that template's span.
  const content = templates.find((span) => /Content/.test(span.name));
  const inner = templates.find((span) => /Inner/.test(span.name));
  assert.equal(content.parentSpanId, render.spanId);
  assert.equal(inner.parentSpanId, content.spanId);
  assert.ok(inner.attributes.sourceRefId);
  // The FetchXML read was issued while the Inner template's span was current.
  assert.equal(readers.length, 1);
  assert.equal(readers[0].spanId, inner.spanId);
  assert.equal(tree.trace.ended, true);
});

test('an infrastructure read failure fails the template span and the render span; level off opens no span at all', async (t) => {
  const portal = await portalFixture(t);
  const traces = createTraceStore({ settings: { level: 'summary' } });
  let refuse = true;
  const renderer = createPortalRenderer(portal, {
    traces,
    fetchXml: async () => {
      if (refuse) throw Object.assign(new Error('Invented read failure'), { code: 'InventedFailure', status: 503 });
      return { entities: [], more_records: false };
    },
  });
  const failed = await renderer.renderPage('/');
  assert.equal(failed.status, 503);
  const tree = traces.tree(traces.query({ kind: 'render' }).items[0].traceId);
  const render = tree.spans.find((span) => span.kind === 'render');
  assert.equal(render.status, 'error');
  assert.equal(render.attributes.status, 503);
  const inner = tree.spans.find((span) => span.kind === 'render-template' && /Inner/.test(span.name));
  assert.equal(inner.status, 'error');
  assert.equal(inner.error.message, 'Invented read failure');

  traces.clear();
  traces.configure({ level: 'off' });
  refuse = false;
  assert.equal((await renderer.renderPage('/')).status, 200);
  assert.equal(traces.status().spans, 0);
});

test('a source without a reference is named by its slot; an empty source keeps its span, marked empty', async (t) => {
  const portal = await portalFixture(t);
  const traces = createTraceStore({ settings: { level: 'summary' } });
  const renderer = createPortalRenderer(portal, {
    traces,
    fetchXml: async () => ({ entities: [], more_records: false }),
  });
  assert.equal((await renderer.renderPage('/')).status, 200);
  const tree = traces.tree(traces.query({ kind: 'render' }).items[0].traceId);
  const templates = tree.spans.filter((span) => span.kind === 'render-template');
  assert.deepEqual(
    templates.filter((span) => span.name === 'template').map((span) => span.attributes),
    [],
    'no unnamed render-template span',
  );
  // The export has neither snippet: each slot still renders (real work), with no source reference.
  for (const name of ['snippet Head/Bottom', 'snippet Browser Title Suffix']) {
    const span = templates.find((item) => item.name === name);
    assert.ok(span, `${name} in ${templates.map((item) => item.name).join(', ')}`);
    assert.deepEqual([span.attributes.empty, span.attributes.sourceRefId ?? null], [true, null], name);
  }
  assert.equal(templates.find((item) => /Content/.test(item.name)).attributes.empty, undefined);
});

test('a runtime template and a missing include are named by their include name, never a bare "template"', async (t) => {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-render-builtin-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sources = {
    ...files,
    'web-templates/content/Content.webtemplate.source.html':
      "<main>{% include 'breadcrumbs' %}{% include 'No such template' %}{{ snippets['Greeting'] }}</main>",
    'content-snippets/Greeting.contentsnippet.yml': 'adx_contentsnippetid: greeting\nadx_name: Greeting',
    'content-snippets/Greeting.contentsnippet.value.html': 'Hello {{ page.title }}',
  };
  for (const [name, content] of Object.entries(sources)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), content);
  }
  const traces = createTraceStore({ settings: { level: 'summary' } });
  const renderer = createPortalRenderer(await importPortal(dir), {
    traces,
    fetchXml: async () => ({ entities: [], more_records: false }),
  });
  assert.equal((await renderer.renderPage('/')).status, 200);
  const tree = traces.tree(traces.query({ kind: 'render' }).items[0].traceId);
  const names = tree.spans.filter((span) => span.kind === 'render-template').map((span) => span.name);
  assert.ok(names.includes('builtin breadcrumbs'), names.join(', '));
  assert.ok(names.includes('missing No such template'), names.join(', '));
  assert.equal(names.includes('template'), false, names.join(', '));
});
