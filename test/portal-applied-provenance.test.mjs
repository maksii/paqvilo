// @test-kind contract: which bindings a document rewritten by Lense may carry: markup Lense wrote from the local file ("applied"), markup found in the served document where the export puts it ("served"), and the portal's own shell
import { makeTemporaryDirectorySync } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { buildPortalSourceIndex } from '../mirage/lib/portal-source-index.mjs';
import { SITE } from './fixture.mjs';
import { createHash } from 'node:crypto';

function fixture(t, base, current) {
  const dir = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-applied-proof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(dir, 'Main.html');
  fs.writeFileSync(file, current);
  const record = { id: 'main', kind: 'webtemplate', name: 'Main', _file: file, source: current };
  const index = buildPortalSourceIndex({
    portal: {
      sourceDir: dir,
      website: {},
      records: [record],
      templates: { Main: { id: 'main', name: 'Main', metadata: record, source: current } },
      snippets: {},
      // The requested page renders this template: only a source the page is seen to reach is named by short markup.
      pageTemplates: [{ id: 'layout', name: 'Layout', webTemplateId: 'main', useHeaderFooter: false }],
      pages: [
        {
          id: 'home',
          url: '/',
          pageTemplateId: 'layout',
          metadata: { id: 'home', kind: 'webpage', name: 'Home' },
          translations: {},
        },
      ],
    },
  });
  const model = {
    sourceDir: dir,
    inlineSources: [{ kind: 'web-template', mode: 'markup', file, rel: 'Main.html' }],
    languageCodes: new Set(),
  };
  const baseline = { changedFiles: () => new Set([file]), show: () => base };
  const rewriter = new HtmlRewriter({ model, baseline, site: SITE });
  return { rewriter, index };
}
const document = (body) => '<!doctype html><html><body>' + body + '</body></html>';
// Markup Lense itself wrote from the local file: a literal binding that is not read off the served document.
const applied = (result) =>
  result.provenance.bindings.filter((binding) => binding.mapping === 'literal' && binding.origin !== 'served');
// Every binding that names a source file, however it was found.
const sourced = (result) =>
  result.provenance.bindings.filter((binding) => binding.sourceRefId || binding.sourceRefIds?.length);

test('only actual accepted local literal markup receives response provenance with exact field spans', (t) => {
  const current = '<section id="inserted"><button id="local">New local content</button></section>';
  const { rewriter, index } = fixture(t, '<p>Original local content</p>', current);
  const result = rewriter.rewrite(document('<p>Original local content</p>'), '/', {
    sourceIndex: index,
    isDocument: true,
  });
  assert.equal(result.provenance.channel, 'lense-applied-response');
  assert.deepEqual(
    applied(result).map((binding) => binding.tag),
    ['section', 'button'],
  );
  for (const binding of applied(result))
    assert.equal(current.slice(binding.region.start, binding.region.end).startsWith('<' + binding.tag), true);
  // The document around the local markup is the portal's: named as its shell, never as a source's markup.
  assert.deepEqual(
    sourced(result).map((binding) => binding.tag),
    ['section', 'button'],
  );
  const body = result.provenance.bindings.find((binding) => binding.tag === 'body');
  assert.equal(body.mapping, 'platform');
  assert.equal(body.component.kind, 'platform-shell');
  assert.deepEqual(body.sourceRefIds, []);
});

test('server-rendered expression gaps, rejected hunks and XHR fragments do not acquire authored node proof', (t) => {
  const { rewriter, index } = fixture(
    t,
    '<div class="{{ cls }}">Old local content</div>',
    '<div class="{{ cls }}">New local content</div>',
  );
  const response = document('<div class="runtime-value">Old local content</div>');
  const result = rewriter.rewrite(response, '/', { sourceIndex: index, isDocument: true });
  assert.equal(result.applied.length, 1);
  assert.equal(applied(result).length, 0, 'start tag crosses a server-produced value');
  // The served tag is still the template's tag, with a value the server wrote in it: found where the source puts it,
  // marked as carrying server output, and placed on the whole tag in the file.
  const [found] = sourced(result);
  assert.equal(sourced(result).length, 1);
  assert.deepEqual([found.tag, found.mapping, found.origin, found.dynamic], ['div', 'literal', 'served', true]);
  assert.equal(
    '<div class="{{ cls }}">New local content</div>'.slice(found.region.start, found.region.end),
    '<div class="{{ cls }}">',
  );
  assert.equal(rewriter.rewrite(response, '/', { sourceIndex: index, isDocument: false }).provenance, undefined);
  const absent = rewriter.rewrite(document('<p>Unrelated</p>'), '/', { sourceIndex: index, isDocument: true });
  assert.equal(sourced(absent).length, 0);
});

test('a rewriter/source-index revision mismatch cannot attach current identity to old prepared bytes', (t) => {
  const { rewriter, index } = fixture(t, '<p>Old local content</p>', '<p>New local content</p>');
  for (const ref of index.sources.values()) ref.contentRevision = 'different-current-field';
  const result = rewriter.rewrite(document('<p>Old local content</p>'), '/', { sourceIndex: index, isDocument: true });
  assert.equal(result.applied.length, 1);
  assert.equal(sourced(result).length, 0);
});

test('CRLF response offsets preserve original decoded source line/column', (t) => {
  const current = '<div>First</div>\r\n<section id="next">New local content</section>\r\n';
  const { rewriter, index } = fixture(t, '<div>First</div>\r\n<p>Old local content</p>\r\n', current);
  const result = rewriter.rewrite(document('<div>First</div>\r\n<p>Old local content</p>\r\n'), '/', {
    sourceIndex: index,
    isDocument: true,
  });
  const binding = result.provenance.bindings.find((item) => item.tag === 'section');
  assert.ok(binding);
  assert.equal(binding.region.line, 2);
  assert.equal(binding.region.column, 1);
  assert.equal(current.slice(binding.region.start, binding.region.end), '<section id="next">');
});

test('replaced inline code with sourceMaps disabled retains script implementation proof without DOM ownership', (t) => {
  const dir = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-inline-proof-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  const file = path.join(dir, 'Form.basicform.custom_javascript.js'),
    metadataFile = path.join(dir, 'Form.basicform.yml');
  const before = 'const one=1;\nconst two=2;\nwindow.before=true;',
    current = 'const one=1;\nconst two=2;\nwindow.after=true;';
  fs.writeFileSync(file, current);
  fs.writeFileSync(metadataFile, 'adx_entityformid: form\nadx_name: Form');
  const record = { id: 'form', kind: 'basicform', name: 'Form', _file: metadataFile };
  const index = buildPortalSourceIndex({
    portal: {
      sourceDir: dir,
      website: {},
      records: [record],
      templates: {},
      snippets: {},
      pages: [],
      forms: [{ metadata: record, js: current }],
    },
  });
  const rewriter = new HtmlRewriter({
    model: {
      sourceDir: dir,
      inlineSources: [{ kind: 'basic-form-js', mode: 'block', tag: 'script', file, rel: path.basename(file) }],
      languageCodes: new Set(),
    },
    site: SITE,
    sourceMaps: false,
    baseline: { changedFiles: () => new Set([file]), show: () => before },
  });
  const result = rewriter.rewrite(document('<script>' + before + '</script>'), '/', {
    isDocument: true,
    sourceIndex: index,
  });
  // The script is not markup of the form's JavaScript: no literal binding. The element is the one the portal wrote
  // to carry that field, and says so.
  assert.equal(applied(result).length, 0);
  const [carrier] = sourced(result);
  assert.equal(sourced(result).length, 1);
  assert.deepEqual([carrier.tag, carrier.mapping, carrier.origin], ['script', 'derived', 'served']);
  assert.deepEqual(carrier.region, { start: 0, end: current.length, line: 1, column: 1 });
  assert.equal(
    result.provenance.sourceRefs.find((ref) => ref.id === carrier.sourceRefId).fieldPath[0],
    'customjavascript',
  );
  assert.equal(result.provenance.scriptProofs.length, 1);
  assert.equal(result.provenance.scriptProofs[0].generatedHash, createHash('sha256').update(current).digest('hex'));
  assert.ok(
    result.provenance.sourceRefs.some((ref) => ref.fieldPath[0] === 'customjavascript' && ref.ref.endsWith('.js')),
  );
  assert.doesNotMatch(result.html, /sourceMappingURL|sourceURL/);
});
