import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import YAML from 'yaml';
import { createSourceInspector } from '../lense/source-inspection.mjs';
import { buildPortalSourceIndex, sourceEditorTarget } from '../mirage/lib/portal-source-index.mjs';
import { importPortal } from '../mirage/lib/importer.mjs';
import { createPortalRenderer } from '../mirage/lib/liquid.mjs';
import { inspectionFixture } from './source-inspection-fixture.mjs';
import { editSource } from '../lense/source-edit.mjs';
import { loadDeploymentProfiles, resolveDeploymentProfiles } from '../mirage/lib/deployment-profiles.mjs';

test(
  'Windows source links use native canonical paths and still refuse edited source bytes',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const fx = inspectionFixture();
    t.after(fx.cleanup);
    const index = buildPortalSourceIndex({ portal: await importPortal(fx.portal) });
    const source = index.templates.get('main');
    assert.ok(source);
    const native = fs.realpathSync.native;
    t.mock.method(fs, 'realpathSync', () => assert.fail('source links must not repeat the legacy component walker'));
    fs.realpathSync.native = native;
    assert.equal(sourceEditorTarget(source).file, native(source.file));
    fs.writeFileSync(source.file, source.text + '\n<!-- edited -->');
    assert.equal(sourceEditorTarget(source), null, 'native lookup retains the final content revision guard');
  },
);

test('shared index revision agrees with renderer/inspector and source links revalidate current field identity', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } });
  const { report } = await inspector.inspect('/');
  const renderer = createPortalRenderer(await importPortal(fx.portal));
  assert.equal(report.sourceRevision, renderer.sourceIndex().sourceRevision);
  const source = report.portalSources.find(
    (source) => source.kind === 'webtemplate' && source.fieldPath[0] === 'source' && source.recordId === 'main',
  );
  assert.ok(source);
  const body = {
    sourceKey: source.key,
    sourceRevision: source.sourceRevision,
    contentRevision: source.contentRevision,
    region: { start: 0, end: 1 },
  };
  const admitted = await inspector.lookupSource(body);
  assert.equal(admitted.state, 'exact');
  assert.match(admitted.editorTarget.file, /Main\.webtemplate\.source\.html$/);
  fs.writeFileSync(admitted.editorTarget.file, '<section>New source</section>');
  assert.equal((await inspector.lookupSource(body)).state, 'stale');
});

test('imports and index builds touch each shared export file once instead of once per record', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const file = path.join(fx.portal, 'contentsnippet.yml');
  const work = async (count) => {
    fs.writeFileSync(
      file,
      JSON.stringify(
        Array.from({ length: count }, (_, index) => ({
          adx_contentsnippetid: 'shared-' + index,
          adx_name: 'Shared ' + index,
          adx_value: `<b id="shared-${index}"></b>`,
        })),
      ),
    );
    const reads = t.mock.method(fs.promises, 'readFile');
    let portal;
    try {
      portal = await importPortal(fx.portal);
    } finally {
      reads.mock.restore();
    }
    assert.equal(portal.snippets['Shared ' + (count - 1)], `<b id="shared-${count - 1}"></b>`);
    const realpath = t.mock.method(fs, 'realpathSync');
    try {
      const index = buildPortalSourceIndex({ portal });
      const linked = [...index.sources.values()].filter(
        (source) => source.file === file && source.fieldPath[0] === 'value' && source.ref,
      );
      assert.equal(linked.length, count, 'every row keeps its own editor reference into the shared file');
      return { reads: reads.mock.callCount(), resolutions: realpath.mock.callCount() };
    } finally {
      realpath.mock.restore();
    }
  };
  // Each absent sidecar probe and each Windows realpath (one lstat per path
  // component) is a filesystem round trip; per-row work made a 4,200-row
  // export take minutes to import and index.
  assert.deepEqual(await work(40), await work(80));
});

test('resolved source paths are remembered for one index build only, so a retargeted root is followed', (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const copy = path.join(fx.work, 'copy'),
    link = path.join(fx.work, 'selected');
  fs.cpSync(fx.portal, copy, { recursive: true });
  fs.symlinkSync(fx.portal, link, 'junction');
  const relative = 'web-templates/Partial.webtemplate.source.html';
  const text = fs.readFileSync(path.join(fx.portal, relative), 'utf8');
  const source = {
    file: path.join(link, relative),
    sourceDir: link,
    region: { start: 0 },
    contentRevision: createHash('sha256').update(text).digest('hex'),
  };
  assert.equal(sourceEditorTarget(source, undefined, new Map()).file, fs.realpathSync(path.join(fx.portal, relative)));
  fs.unlinkSync(link);
  fs.symlinkSync(copy, link, 'junction');
  assert.equal(
    sourceEditorTarget(source, undefined, new Map()).file,
    fs.realpathSync(path.join(copy, relative)),
    'a later build resolves the retargeted root again',
  );
});

test('localized JSON source identity follows LCID rather than mutable array position', () => {
  const record = {
    kind: 'advancedformstep',
    id: 'step',
    name: 'Step',
    title: JSON.stringify([
      { LCID: 1033, Value: '<p>English</p>' },
      { LCID: 1036, Value: '<p>French</p>' },
    ]),
  };
  const portal = {
    sourceDir: null,
    website: {},
    records: [record],
    templates: {},
    pages: [],
    snippets: {},
    selectedLcid: 1033,
  };
  const first = buildPortalSourceIndex({ portal });
  const english = [...first.sources.values()].find((source) => source.lcid === 1033);
  record.title = JSON.stringify([
    { LCID: 1036, Value: '<p>French</p>' },
    { LCID: 1033, Value: '<p>English</p>' },
  ]);
  const second = buildPortalSourceIndex({ portal });
  const current = [...second.sources.values()].find((source) => source.lcid === 1033);
  assert.equal(english.id, current.id);
  assert.equal(english.contentRevision, current.contentRevision);
  assert.deepEqual(current.jsonPath, [1, 'Value']);
  assert.notEqual(first.sourceRevision, second.sourceRevision);
});

test('duplicate localized identities remain conflicting instead of silently selecting an array ordinal', () => {
  const record = {
    kind: 'advancedformstep',
    id: 'step',
    name: 'Step',
    title: JSON.stringify([
      { LCID: 1033, Value: '<p>First</p>' },
      { LCID: 1033, Value: '<p>Second</p>' },
    ]),
  };
  const index = buildPortalSourceIndex({
    portal: { sourceDir: null, website: {}, records: [record], templates: {}, pages: [], snippets: {} },
  });
  const source = [...index.sources.values()].find((source) => source.fieldPath[0] === 'title');
  assert.equal(source.ambiguous, true);
  assert.equal(
    index.snapshot().some((ref) => ref.id === source.id),
    false,
  );
  assert.ok(index.diagnostics.some((issue) => issue.reason === 'duplicate-source-identity'));
});

test('profile overrides bind the actual profile field and preserve unrelated source definitions', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  fs.mkdirSync(path.join(fx.portal, 'deployment-profiles'));
  fs.writeFileSync(
    path.join(fx.portal, 'deployment-profiles/preview.deployment.yml'),
    'adx_webtemplate:\n  - adx_webtemplateid: main\n    adx_source: "<article>Profile content</article>"\n',
  );
  const portal = await importPortal(fx.portal, { deploymentProfile: 'preview' });
  const index = buildPortalSourceIndex({ portal });
  const source = index.templates.get('main');
  assert.equal(source.profileId, 'preview');
  assert.match(source.file, /preview\.deployment\.yml$/);
  assert.equal(source.text, '<article>Profile content</article>');
  assert.equal(index.templates.get('partial').profileId, null);
});

test('Solution-only edits change current FormXml content evidence without relabeling the portal revision', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } });
  const { report } = await inspector.inspect('/');
  const source = report.portalSources.find((source) => source.componentKey === 'form:widget-form');
  assert.ok(source);
  const placement = report.portalSources.find(
    (source) => source.componentKey?.startsWith('control:widget-form:') && source.fieldPath?.includes('fx_title'),
  );
  assert.ok(placement, 'selected form includes an independently identified actual FormXml control placement');
  const cold = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } });
  assert.equal(
    (
      await cold.lookupSource({
        sourceKey: placement.key,
        sourceRevision: placement.sourceRevision,
        contentRevision: placement.contentRevision,
      })
    ).state,
    'exact',
  );
  const request = {
    sourceKey: source.key,
    sourceRevision: source.sourceRevision,
    contentRevision: source.contentRevision,
  };
  assert.equal((await inspector.lookupSource(request)).state, 'exact');
  const file = path.join(fx.solution, 'Entities/fx_widget/FormXml/main/widget-form.xml');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('name="GENERAL"', 'name="CHANGED"'));
  assert.equal((await inspector.lookupSource(request)).state, 'stale');
  const next = await inspector.inspect('/');
  assert.equal(next.report.sourceRevision, report.sourceRevision);
  assert.notEqual(
    next.report.portalSources.find((ref) => ref.id === source.id).contentRevision,
    source.contentRevision,
  );
});

test('web-file implementation opens actual blob code and treats a leading BOM as an editor encoding marker', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  fs.writeFileSync(path.join(fx.portal, 'web-files/widget.js'), '\uFEFFwindow.bom=true;\r\nwindow.second=true;');
  const inspector = createSourceInspector({ sourceDir: fx.portal });
  const index = await inspector.sourceIndexFor('/');
  const source = [...index.sources.values()].find(
    (source) => source.componentKey === 'web-file:widget-js' && source.rawBytes,
  );
  assert.ok(source);
  assert.match(source.ref, /widget\.js$/);
  const request = {
    sourceKey: source.key,
    sourceRevision: source.sourceRevision,
    contentRevision: source.contentRevision,
  };
  const first = await inspector.lookupSource({ ...request, region: { start: 1, end: 2 } });
  assert.equal(first.state, 'exact');
  assert.equal(first.editorTarget.line, 1);
  assert.equal(first.editorTarget.column, 1);
  const offset = source.text.indexOf('window.second');
  const second = await inspector.lookupSource({ ...request, region: { start: offset, end: offset + 1 } });
  assert.equal(second.editorTarget.line, 2);
  assert.equal(second.editorTarget.column, 1);
});

test('editor positions count CRLF, CR and LF as one line break each at every offset, with or without a shared cache', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const text = 'a\r\nbb\rc\n\nd\r\r\ne';
  fs.writeFileSync(path.join(fx.portal, 'web-files/widget.js'), text);
  const index = await createSourceInspector({ sourceDir: fx.portal }).sourceIndexFor('/');
  const source = [...index.sources.values()].find(
    (source) => source.componentKey === 'web-file:widget-js' && source.rawBytes,
  );
  const cache = new Map();
  for (let start = 0; start <= text.length; start++) {
    const prefix = text.slice(0, start),
      last = Math.max(prefix.lastIndexOf('\n'), prefix.lastIndexOf('\r'));
    const expected = { line: prefix.split(/\r\n|\r|\n/).length, column: Math.max(1, start - last) };
    for (const target of [sourceEditorTarget(source, { start }), sourceEditorTarget(source, { start }, cache)])
      assert.deepEqual({ line: target.line, column: target.column }, expected, 'offset ' + start);
  }
});

for (const entry of [
  {
    kind: 'webtemplate',
    recordId: 'main',
    field: 'source',
    file: 'web-templates/Main.webtemplate.source.html',
    body: '\uFEFF<article>First</article>\r\n<section>Second</section>',
    second: '<section>',
  },
  {
    kind: 'contentsnippet',
    recordId: 'banner',
    field: 'value',
    file: 'content-snippets/Banner.contentsnippet.value.html',
    body: '\uFEFF<p>First</p>\r\n<span>Second</span>',
    second: '<span>',
  },
  {
    kind: 'webpage',
    recordId: 'home',
    field: 'customjavascript',
    file: 'web-pages/home/Home.webpage.custom_javascript.js',
    body: '\uFEFFwindow.first=true;\r\nwindow.second=true;',
    second: 'window.second',
  },
])
  test(`${entry.kind} BOM sidecar source opens with byte identity and encoding-aware editor positions`, async (t) => {
    const fx = inspectionFixture();
    t.after(fx.cleanup);
    const file = path.join(fx.portal, entry.file);
    fs.writeFileSync(file, entry.body);
    const inspector = createSourceInspector({ sourceDir: fx.portal }),
      index = await inspector.sourceIndexFor('/');
    const source = [...index.sources.values()].find(
      (source) =>
        source.kind === entry.kind && source.recordId === entry.recordId && source.fieldPath[0] === entry.field,
    );
    assert.equal(source.text, entry.body, 'the actual imported source retains its BOM and CRLF bytes');
    assert.ok(source.ref);
    assert.deepEqual(sourceEditorTarget(source, { start: 1, end: 2 }), { file, line: 1, column: 1, mapped: true });
    const request = {
      sourceKey: source.key,
      sourceRevision: source.sourceRevision,
      contentRevision: source.contentRevision,
    };
    const first = await inspector.lookupSource({ ...request, region: { start: 1, end: 2 } });
    assert.equal(first.state, 'exact');
    assert.equal(first.editorTarget.line, 1);
    assert.equal(first.editorTarget.column, 1);
    const middle = await inspector.lookupSource({ ...request, region: { start: 3, end: 4 } });
    assert.equal(middle.state, 'exact');
    assert.equal(middle.editorTarget.line, 1);
    assert.equal(middle.editorTarget.column, 3);
    const offset = entry.body.indexOf(entry.second),
      second = await inspector.lookupSource({ ...request, region: { start: offset, end: offset + 1 } });
    assert.equal(second.state, 'exact');
    assert.equal(second.editorTarget.line, 2);
    assert.equal(second.editorTarget.column, 1, 'BOM correction applies only to the first physical line');
    fs.writeFileSync(file, entry.body + '\r\nchanged');
    assert.equal(sourceEditorTarget(source), null, 'a fresh final read cannot reuse the old BOM source revision');
    assert.equal((await inspector.lookupSource(request)).state, 'stale');
  });

test('global source revision covers all languages while winners and their source identities stay explicit', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  fs.appendFileSync(path.join(fx.portal, 'website.yml'), '\nadx_defaultlanguage: en\n');
  fs.writeFileSync(
    path.join(fx.portal, 'websitelanguage.yml'),
    '- adx_websitelanguageid: en\n  adx_name: English\n  adx_languagecode: en-US\n  adx_lcid: 1033\n- adx_websitelanguageid: fr\n  adx_name: French\n  adx_languagecode: fr-FR\n  adx_lcid: 1036\n',
  );
  for (const [language, body] of [
    ['en', '<p>English</p>'],
    ['fr', '<p>French</p>'],
  ]) {
    fs.writeFileSync(
      path.join(fx.portal, `content-snippets/Banner-${language}.contentsnippet.yml`),
      `adx_contentsnippetid: banner-${language}\nadx_name: Banner\nadx_contentsnippetlanguageid: ${language}`,
    );
    fs.writeFileSync(path.join(fx.portal, `content-snippets/Banner-${language}.contentsnippet.value.html`), body);
  }
  const en = buildPortalSourceIndex({ portal: await importPortal(fx.portal, { languageId: 'en', lcid: 1033 }) });
  const fr = buildPortalSourceIndex({ portal: await importPortal(fx.portal, { languageId: 'fr', lcid: 1036 }) });
  assert.equal(en.sourceRevision, fr.sourceRevision);
  assert.equal(en.snippet('Banner').recordId, 'banner-en');
  assert.equal(fr.snippet('Banner').recordId, 'banner-fr');
  assert.equal(en.snippet('Banner').languageId, 'en');
  assert.equal(fr.snippet('Banner').languageId, 'fr');
  assert.notEqual(en.snippet('Banner').contentRevision, fr.snippet('Banner').contentRevision);
});

test('semantic configuration changes after index admission fail the final guarded container read', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const inspector = createSourceInspector({ sourceDir: fx.portal });
  const index = await inspector.sourceIndexFor('/'),
    source = [...index.sources.values()].find((source) => source.componentKey === 'basic-form:widget-edit');
  assert.ok(source.ref);
  const original = inspector.sourceIndexFor.bind(inspector);
  inspector.sourceIndexFor = async (...args) => {
    const current = await original(...args),
      file = path.join(fx.portal, 'basic-forms/Widget.basicform.yml');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('adx_mode: 100000001', 'adx_mode: 100000002'));
    return current;
  };
  assert.notEqual(
    (
      await inspector.lookupSource({
        sourceKey: source.key,
        sourceRevision: source.sourceRevision,
        contentRevision: source.contentRevision,
      })
    ).state,
    'exact',
  );
});

test('lazy source indexing preserves imported sidecar revisions when files change before first render', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  const snippet = path.join(fx.portal, 'content-snippets/Banner.contentsnippet.value.html');
  fs.writeFileSync(snippet, '<p>Imported</p>');
  const imported = await importPortal(fx.portal);
  fs.writeFileSync(snippet, '<p>Changed after import</p>');
  const renderer = createPortalRenderer(imported),
    index = renderer.sourceIndex();
  const source = index.snippet('Banner');
  assert.equal(source.text, '<p>Imported</p>');
  const context = renderer.contextForPage(
    imported.pages.find((page) => page.id === 'home'),
    '/',
  );
  const result = await renderer.renderStringWithProvenance("{{ snippets['Banner'] }}", context);
  const binding = result.provenance.bindings.find((binding) => binding.tag === 'p');
  assert.equal(binding.sourceRefId, source.id);
  assert.equal(
    result.provenance.sourceRefs.find((ref) => ref.id === source.id).contentRevision,
    source.contentRevision,
  );
  const current = buildPortalSourceIndex({ portal: await importPortal(fx.portal) }).snippet('Banner');
  assert.equal(current.id, source.id);
  assert.notEqual(current.contentRevision, source.contentRevision);
  const inspector = createSourceInspector({ sourceDir: fx.portal });
  assert.equal(
    (
      await inspector.lookupSource({
        sourceKey: source.key,
        sourceRevision: source.sourceRevision,
        contentRevision: source.contentRevision,
      })
    ).state,
    'stale',
  );
});

test('enrichment refreshes current Solution placements and keeps the trusted Mirage deployment profile', async (t) => {
  const fx = inspectionFixture();
  t.after(fx.cleanup);
  fs.mkdirSync(path.join(fx.portal, 'deployment-profiles'));
  fs.writeFileSync(
    path.join(fx.portal, 'deployment-profiles/preview.deployment.yml'),
    'adx_webtemplate:\n  - adx_webtemplateid: main\n    adx_source: "<main>Profile</main>"\n',
  );
  const inspector = createSourceInspector({ sourceDir: fx.portal, mirageConfig: { solutionRoots: [fx.solution] } });
  const { report } = await inspector.inspect('/');
  const profileIndex = await inspector.sourceIndexFor('/', { deploymentProfile: 'preview' });
  report.portalProfile = { deploymentProfile: 'preview' };
  report.sourceRevision = profileIndex.sourceRevision;
  report.portalSources = profileIndex.snapshot(report);
  const observedForm = report.portalSources.find((source) => source.componentKey === 'form:widget-form');
  const file = path.join(fx.solution, 'Entities/fx_widget/FormXml/main/widget-form.xml');
  fs.writeFileSync(
    file,
    fs
      .readFileSync(file, 'utf8')
      .replace('</rows>', '<row><cell><control id="another-control" datafieldname="fx_title"/></cell></row></rows>'),
  );
  const enriched = await inspector.enrich(report);
  assert.equal(
    enriched.sourceRevision,
    profileIndex.sourceRevision,
    'a Solution-only edit does not relabel literal portal origins',
  );
  const currentForm = enriched.portalSources.find((source) => source.id === observedForm.id);
  assert.notEqual(currentForm.contentRevision, observedForm.contentRevision);
  assert.ok(
    enriched.portalSources.some((source) => source.componentKey?.startsWith('control:widget-form:another-control:')),
    'new current placement is indexed independently of the old response',
  );
  assert.ok(
    enriched.portalSources.some(
      (source) => source.recordId === 'main' && source.fieldPath[0] === 'source' && source.profileId === 'preview',
    ),
  );
  assert.equal(
    observedForm.contentRevision,
    profileIndex.snapshot(report).find((source) => source.id === observedForm.id).contentRevision,
    'the old observed snapshot stays immutable',
  );
});

for (const [format, bom] of [
  ['yml', false],
  ['yml', true],
  ['json', false],
  ['json', true],
])
  test(`${format}${bom ? ' BOM' : ''} external profile opens only the selected record, field and exact file`, async (t) => {
    const fx = inspectionFixture();
    t.after(fx.cleanup);
    const file = path.join(fx.work, 'selected-profile.' + format),
      other = path.join(fx.work, 'unselected-profile.' + format);
    const data = {
      webtemplate: [{ id: 'main', name: 'Main', source: '<article>External profile</article>' }],
      pagetemplate: [{ id: 'main', name: 'Main', description: 'Sibling preserved' }],
    };
    const profile = (bom ? '\uFEFF' : '') + (format === 'json' ? JSON.stringify(data, null, 2) : YAML.stringify(data));
    fs.writeFileSync(file, profile);
    fs.writeFileSync(other, profile);
    const profileConfig = resolveDeploymentProfiles(
      { default: 'external', profiles: { external: { pages: file } } },
      fx.work,
      {
        sourceDir: fx.portal,
      },
    );
    const loaded = await loadDeploymentProfiles(profileConfig);
    assert.equal(
      loaded.pagesFile,
      file,
      'configured profile loading accepts the same physical encoding as import and guarded opening',
    );
    const selection = { deploymentProfile: 'external', deploymentProfileFile: file };
    const portal = await importPortal(fx.portal, selection),
      index = buildPortalSourceIndex({ portal }),
      source = index.templates.get('main');
    assert.match(source.ref, /^_profiles\//);
    const inspector = createSourceInspector({ sourceDir: fx.portal });
    const request = {
      sourceKey: source.key,
      sourceRevision: source.sourceRevision,
      contentRevision: source.contentRevision,
      portalProfile: selection,
    };
    const opened = await inspector.lookupSource(request);
    assert.equal(opened.state, 'exact');
    assert.equal(opened.editorTarget.file, file);
    assert.equal(opened.editorTarget.externalProfile, true);
    if (format === 'json') {
      assert.equal(opened.editorTarget.line, 1);
      assert.equal(opened.editorTarget.column, 1);
      assert.equal(opened.editorTarget.mapped, false);
      assert.equal(opened.editorTarget.container, true);
    }
    assert.equal(
      sourceEditorTarget({ ...source, file: other }),
      null,
      'another file in the same parent has no private admission',
    );
    fs.writeFileSync(file, profile.replace('External profile', 'Changed profile'));
    assert.equal((await inspector.lookupSource(request)).state, 'stale');
    const current = await inspector.sourceIndexFor('/', selection),
      updated = current.templates.get('main');
    const reopened = await inspector.lookupSource({
      ...request,
      sourceRevision: updated.sourceRevision,
      contentRevision: updated.contentRevision,
    });
    assert.equal(reopened.state, 'exact');
    assert.equal(reopened.sourceRef.recordId, 'main');
    assert.deepEqual(reopened.sourceRef.fieldPath, ['source']);
    const contents = fs.readFileSync(file, 'utf8'),
      parsed = format === 'json' ? JSON.parse(contents.replace(/^\uFEFF/, '')) : YAML.parse(contents);
    assert.equal(
      parsed.pagetemplate[0].description,
      'Sibling preserved',
      'the same-ID sibling table is never mistaken for the selected field',
    );
    assert.equal(fs.readFileSync(other, 'utf8'), profile, 'unselected neighboring files remain untouched');
    if (format === 'json' && bom) {
      fs.writeFileSync(file, '\uFEFF{\n "webtemplate": "INVENTED_PRIVATE_CONFIG_VALUE",\n }\n');
      await assert.rejects(
        loadDeploymentProfiles(profileConfig),
        (error) =>
          error.code === 'InvalidDeploymentProfile' &&
          error.details.line === 3 &&
          !error.message.includes('INVENTED_PRIVATE_CONFIG_VALUE'),
        'BOM-aware parser errors retain the real line and redact source values',
      );
    }
  });

for (const variant of ['classic', 'enhanced', 'short-key'])
  test(`${variant} localized advanced-step title opens by actual record and LCID after array reordering`, async (t) => {
    const fx = inspectionFixture();
    t.after(fx.cleanup);
    const root = path.join(fx.work, variant),
      directory = variant === 'short-key' ? path.join(root, '.powerpages-site') : root;
    fs.mkdirSync(directory, { recursive: true });
    const title = JSON.stringify([
      { LCID: 1033, Value: 'English title' },
      { LCID: 1036, Value: 'French title' },
    ]);
    const enhanced = variant === 'enhanced',
      field = variant === 'classic' ? 'adx_title' : 'title';
    const file = path.join(
      directory,
      enhanced ? 'powerpagecomponents/step/powerpagecomponent.xml' : 'advanced-forms/Step.advancedformstep.yml',
    );
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (enhanced) {
      const content = JSON.stringify({ title, description: 'Sibling preserved' })
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
      fs.writeFileSync(
        file,
        `<powerpagecomponent powerpagecomponentid="step"><content>${content}</content><name>Step</name><powerpagecomponenttype>20</powerpagecomponenttype><statecode>0</statecode><statuscode>1</statuscode></powerpagecomponent>`,
      );
    } else {
      fs.writeFileSync(
        path.join(directory, 'website.yml'),
        YAML.stringify(
          variant === 'classic'
            ? { adx_websiteid: 'site', adx_name: 'Locale fixture' }
            : { id: 'site', name: 'Locale fixture' },
        ),
      );
      fs.writeFileSync(
        file,
        YAML.stringify(
          variant === 'classic'
            ? { adx_webformstepid: 'step', adx_name: 'Step', adx_title: title, adx_description: 'Sibling preserved' }
            : { id: 'step', name: 'Step', title, description: 'Sibling preserved' },
        ),
      );
    }
    const inspector = createSourceInspector({ sourceDir: root }),
      index = await inspector.sourceIndexFor('/');
    const sourceFor = (index, lcid) =>
      [...index.sources.values()].find(
        (source) => source.recordId === 'step' && source.fieldPath[0] === 'title' && source.lcid === lcid,
      );
    const english = sourceFor(index, 1033),
      french = sourceFor(index, 1036);
    assert.ok(english);
    assert.ok(french);
    const body = (source) => ({
      sourceKey: source.key,
      sourceRevision: source.sourceRevision,
      contentRevision: source.contentRevision,
    });
    for (const source of [english, french]) {
      const opened = await inspector.lookupSource(body(source));
      assert.equal(opened.state, 'exact');
      assert.equal(opened.editorTarget.file, file);
      assert.equal(opened.editorTarget.container, true);
      assert.equal(opened.sourceRef.lcid, source.lcid);
    }
    assert.equal(
      (await inspector.lookupSource({ ...body(english), contentRevision: french.contentRevision })).state,
      'stale',
      'a sibling locale hash cannot authorize this identity',
    );
    editSource(
      {
        file,
        ...(enhanced
          ? { componentId: 'step', field: 'title' }
          : {
              format: 'yaml',
              field,
              fieldPath: [field],
              recordId: 'step',
              recordIdField: variant === 'classic' ? 'adx_webformstepid' : 'id',
            }),
      },
      (value) => JSON.stringify(JSON.parse(value).reverse()),
    );
    assert.equal((await inspector.lookupSource(body(english))).state, 'stale');
    const current = await inspector.sourceIndexFor('/'),
      reordered = sourceFor(current, 1033);
    assert.equal(reordered.id, english.id);
    assert.equal(reordered.contentRevision, english.contentRevision);
    assert.deepEqual(reordered.jsonPath, [1, 'Value']);
    const reopened = await inspector.lookupSource(body(reordered));
    assert.equal(reopened.state, 'exact');
    assert.equal(reopened.sourceRef.lcid, 1033);
    assert.deepEqual(reopened.sourceRef.jsonPath, [1, 'Value']);
    const imported = await importPortal(root),
      record = imported.records.find((record) => record.id === 'step');
    assert.equal(record.adx_description ?? record.description, 'Sibling preserved');
  });
