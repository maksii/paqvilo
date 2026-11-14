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
      pages: [],
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

test('only actual accepted local literal markup receives response provenance with exact field spans', (t) => {
  const current = '<section id="inserted"><button id="local">New local content</button></section>';
  const { rewriter, index } = fixture(t, '<p>Original local content</p>', current);
  const result = rewriter.rewrite(document('<p>Original local content</p>'), '/', {
    sourceIndex: index,
    isDocument: true,
  });
  assert.equal(result.provenance.channel, 'lense-applied-response');
  assert.deepEqual(
    result.provenance.bindings.map((binding) => binding.tag),
    ['section', 'button'],
  );
  for (const binding of result.provenance.bindings)
    assert.equal(current.slice(binding.region.start, binding.region.end).startsWith('<' + binding.tag), true);
  assert.equal(
    result.provenance.bindings.some((binding) => binding.tag === 'body'),
    false,
  );
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
  assert.equal(result.provenance.bindings.length, 0, 'start tag crosses a server-produced value');
  assert.equal(rewriter.rewrite(response, '/', { sourceIndex: index, isDocument: false }).provenance, undefined);
  const absent = rewriter.rewrite(document('<p>Unrelated</p>'), '/', { sourceIndex: index, isDocument: true });
  assert.equal(absent.provenance.bindings.length, 0);
});

test('a rewriter/source-index revision mismatch cannot attach current identity to old prepared bytes', (t) => {
  const { rewriter, index } = fixture(t, '<p>Old local content</p>', '<p>New local content</p>');
  for (const ref of index.sources.values()) ref.contentRevision = 'different-current-field';
  const result = rewriter.rewrite(document('<p>Old local content</p>'), '/', { sourceIndex: index, isDocument: true });
  assert.equal(result.applied.length, 1);
  assert.equal(result.provenance.bindings.length, 0);
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
  assert.equal(result.provenance.bindings.length, 0);
  assert.equal(result.provenance.scriptProofs.length, 1);
  assert.equal(result.provenance.scriptProofs[0].generatedHash, createHash('sha256').update(current).digest('hex'));
  assert.ok(
    result.provenance.sourceRefs.some((ref) => ref.fieldPath[0] === 'customjavascript' && ref.ref.endsWith('.js')),
  );
  assert.doesNotMatch(result.html, /sourceMappingURL|sourceURL/);
});
