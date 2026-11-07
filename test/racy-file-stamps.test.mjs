// Same-size rewrites inside one file-time tick keep every stat field. Freezing the times every stat call
// reports (tick) reproduces that on any file system, so these regressions fail deterministically without the
// racy-window rule (lense/file-cache.mjs recordedStamp/racyStat); `settled` proves unchanged files are still reused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { FileBodyCache } from '../lense/file-cache.mjs';
import { PortalModel } from '../lense/portal-model.mjs';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { createModelDrivenMetadataIndex } from '../lense/model-driven-metadata.mjs';
import { modelDrivenControlKey } from '../mirage/lib/model-driven/provenance-registry.mjs';
import { freezeFileTimes as tick, freezeSettledFileTimes as settled } from '../mirage/test/support/file-times.mjs';
import { SITE } from './fixture.mjs';

function directory(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'paq-racy-stamps-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }));
  return (rel, text) => {
    const file = path.join(dir, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
    return file;
  };
}

test('served-body cache serves a same-size rewrite made in the tick of the cached read', (t) => {
  const write = directory(t);
  const file = write('app.js', 'alpha();');
  tick(t);
  const cache = new FileBodyCache();
  assert.equal(cache.read(file).toString(), 'alpha();');
  write('app.js', 'omega();');
  assert.equal(cache.read(file).toString(), 'omega();');
});

test('served-body cache still reuses a settled file without reading it again', (t) => {
  const write = directory(t);
  const file = write('app.js', 'alpha();');
  settled(t);
  const cache = new FileBodyCache();
  let reads = 0;
  const count = (body) => (reads++, body);
  cache.read(file, '', count);
  assert.equal(cache.read(file, '', count).toString(), 'alpha();');
  assert.equal(reads, 1);
});

test('portal model reload sees a same-size metadata rewrite made in the tick of the previous load', (t) => {
  const write = directory(t);
  write('website.yml', 'adx_name: Invented\nadx_websiteid: 11111111-1111-1111-1111-111111111111\n');
  const page = (name) =>
    `adx_webpageid: 00000000-0000-0000-0000-000000000001\nadx_name: ${name}\nadx_partialurl: /\nadx_isroot: true\n`;
  const file = write('web-pages/home/Home.webpage.yml', page('alpha'));
  tick(t);
  const model = new PortalModel(path.dirname(path.dirname(path.dirname(file))));
  const name = () => [...model.pages.values()][0].name;
  assert.equal(name(), 'alpha');
  write('web-pages/home/Home.webpage.yml', page('omega'));
  model.load();
  assert.equal(name(), 'omega');
});

test('portal model reload reuses settled metadata without parsing it again', (t) => {
  const write = directory(t);
  write('website.yml', 'adx_name: Invented\nadx_websiteid: 11111111-1111-1111-1111-111111111111\n');
  const file = write(
    'web-pages/home/Home.webpage.yml',
    'adx_webpageid: 00000000-0000-0000-0000-000000000001\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\n',
  );
  settled(t);
  const model = new PortalModel(path.dirname(path.dirname(path.dirname(file))));
  const reads = [];
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...args) => (reads.push(target), read(target, ...args)));
  model.load();
  assert.equal([...model.pages.values()][0].name, 'Home');
  assert.deepEqual(
    reads.filter((target) => target === file),
    [],
  );
});

test('rewriter revalidation re-reads a same-size source rewrite made in the tick of its read', (t) => {
  const write = directory(t);
  const file = write('form.js', 'alpha();');
  const rewriter = () =>
    new HtmlRewriter({
      model: { inlineSources: [{ rel: 'form.js', file, kind: 'basic-form-js', mode: 'block', tag: 'script' }] },
      site: SITE,
      baseline: { changedFiles: () => new Set([file]), show: () => 'online();' },
    });
  tick(t);
  const ticked = rewriter();
  assert.equal(ticked.rewrite('<script>online();</script>', '/').html, '<script>alpha();</script>');
  write('form.js', 'omega();');
  ticked.refresh([], { revalidate: true });
  assert.equal(ticked.rewrite('<script>online();</script>', '/').html, '<script>omega();</script>');
});

test('rewriter revalidation keeps settled source bytes without reading them again', (t) => {
  const write = directory(t);
  const file = write('form.js', 'alpha();');
  settled(t);
  const rewriter = new HtmlRewriter({
    model: { inlineSources: [{ rel: 'form.js', file, kind: 'basic-form-js', mode: 'block', tag: 'script' }] },
    site: SITE,
    baseline: { changedFiles: () => new Set([file]), show: () => 'online();' },
  });
  const reads = [];
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (target, ...args) => (reads.push(target), read(target, ...args)));
  rewriter.refresh([], { revalidate: true });
  assert.deepEqual(reads, []);
  assert.equal(rewriter.rewrite('<script>online();</script>', '/').html, '<script>alpha();</script>');
});

test('model-driven source opening refuses a same-size rewrite made in the tick of the indexed read', (t) => {
  const write = directory(t);
  const form = (name) =>
    `<form><tabs><tab id="tab-guid" name="${name}"><columns><column><sections><section id="section-guid" name="fixture_section"><rows>` +
    `<row><cell><control id="fixture_name" uniqueid="{10000000-0000-4000-8000-000000001000}" datafieldname="fixture_name"/></cell></row>` +
    `</rows></section></sections></column></columns></tab></tabs></form>`;
  const formId = '10000000-0000-4000-8000-000000000001';
  const xml = form('fixture_alpha');
  const file = write('form.xml', xml);
  tick(t);
  const index = createModelDrivenMetadataIndex({
    assets: new Map(),
    layers: [],
    metadata: {
      sourceRevisions: { [file]: createHash('sha256').update(xml).digest('hex') },
      entities: {},
      forms: [{ id: formId, entity: 'fixture_item', name: 'Fixture', xml, file, systemFormType: 2 }],
      views: [],
    },
  });
  const [ref] = index.sourceRefsFor([
    modelDrivenControlKey(formId, { uniqueId: '10000000-0000-4000-8000-000000001000' }),
  ]);
  const open = () =>
    index.resolveOpen({ sourceKey: ref.id, sourceRevision: ref.sourceRevision, contentRevision: ref.contentRevision });
  assert.equal(open().ok, true);
  write('form.xml', form('fixture_omega'));
  assert.deepEqual(open(), { ok: false, reason: 'source-content-changed' });
});
