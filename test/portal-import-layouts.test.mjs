// @test-kind contract: Lense and Mirage consume the same source records and refuse an ambiguous enhanced Solution.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { describeResources } from '../lense/commands/resources.mjs';
import { PortalModel, isPortalMetadata, sourceText } from '../lense/portal-model.mjs';
import { auditResources } from '../lense/resource-audit.mjs';
import { editSource } from '../lense/source-edit.mjs';
import { importPortal } from '../mirage/lib/importer.mjs';
import { buildPortalSourceIndex, sourceEditorTarget } from '../mirage/lib/portal-source-index.mjs';
import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import { SITE } from './fixture.mjs';

async function fixture(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-portal-layout-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return {
    root,
    async write(relative, value) {
      const file = path.join(root, relative);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, value);
      return file;
    },
  };
}

const id = (n) => `e8000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

test('both loaders index standard .yaml records and Lense binds their actual sidecars', async (t) => {
  const site = await fixture(t);
  await site.write('website.yaml', `adx_websiteid: ${id(1)}\nadx_name: Invented Site\n`);
  const page = await site.write(
    'web-pages/home/Home.webpage.yaml',
    `adx_webpageid: ${id(2)}\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_entityform: ${id(3)}\nadx_title: 'Text <em>title</em>'\n`,
  );
  await site.write('web-pages/home/Home.webpage.copy.html', '<main>Home</main>');
  await site.write(
    'basic-forms/Inquiry.basicform.yaml',
    `adx_entityformid: ${id(3)}\nadx_name: Inquiry\nadx_instructions: Ask a question\n`,
  );
  await site.write('basic-forms/Inquiry.basicform.custom_javascript.js', 'void 0;');
  await site.write(
    'web-files/site.css.webfile.yaml',
    `adx_webfileid: ${id(4)}\nadx_name: site.css\nadx_partialurl: site.css\nadx_parentpageid: ${id(2)}\n`,
  );
  const asset = await site.write('web-files/site.css', 'main { color: red; }');
  await site.write('sitesetting.yaml', '- adx_name: HTTP/X-Frame-Options\n  adx_value: SAMEORIGIN\n');

  const lense = await PortalModel.create(site.root);
  const mirage = await importPortal(site.root);
  assert.equal(lense.website.adx_websiteid, mirage.website.id);
  assert.equal(lense.pagePath(id(2)), mirage.pages[0].url);
  assert.equal(lense.findWebFile('/site.css').file, asset);
  assert.equal(mirage.webFiles[0].url, '/site.css');
  assert.equal(lense.siteSettings['HTTP/X-Frame-Options'], mirage.settings['HTTP/X-Frame-Options']);
  assert.equal(lense.inlineSources.find((source) => source.kind === 'page-copy').pageUrl, '/');
  assert.deepEqual(lense.inlineSources.find((source) => source.kind === 'basic-form-js').usedOn, ['/']);
  const instructions = lense.inlineSources.find((source) => source.field === 'adx_instructions');
  assert.equal(sourceText(instructions), 'Ask a question');
  assert.equal(instructions.recordId, id(3));
  assert.equal(isPortalMetadata(path.relative(site.root, page)), true);
  const title = auditResources(lense, SITE).resources.find((record) => record.field === 'adx_title');
  assert.equal(title.status, 'deployment');
  assert.match(title.reason, /renders the configured page title as text/);
});

test('enhanced mspp_ YAML keeps page, language and permission identities and edits the original field', async (t) => {
  const site = await fixture(t);
  await site.write('website.yaml', `mspp_websiteid: ${id(1)}\nmspp_name: Enhanced\nmspp_defaultlanguage: ${id(5)}\n`);
  await site.write(
    'web-pages/home/Home.webpage.yaml',
    `mspp_webpageid: ${id(2)}\nmspp_name: Home\nmspp_isroot: true\nmspp_partialurl: /\n`,
  );
  await site.write(
    'web-pages/home/content-pages/fr-CA/Home.webpage.yaml',
    `mspp_webpageid: ${id(3)}\nmspp_name: Accueil\nmspp_isroot: false\nmspp_rootwebpageid: ${id(2)}\nmspp_webpagelanguageid: ${id(5)}\n`,
  );
  await site.write('web-pages/home/content-pages/fr-CA/Home.webpage.copy.html', '<main>Accueil</main>');
  await site.write(
    'websitelanguage.yaml',
    `- mspp_websitelanguageid: ${id(5)}\n  mspp_name: French - Canada\n  mspp_languagecode: fr-CA\n  mspp_lcid: 3084\n`,
  );
  const snippet = await site.write(
    'content-snippets/Welcome.contentsnippet.yaml',
    `mspp_contentsnippetid: ${id(6)}\nmspp_name: Welcome\nmspp_contentsnippetlanguageid: ${id(5)}\nmspp_value: Bienvenue\nmspp_description: Keep me\n`,
  );
  await site.write(
    'web-files/style.css.webfile.yaml',
    `mspp_webfileid: ${id(7)}\nmspp_name: style.css\nmspp_parentpageid: ${id(2)}\nmspp_partialurl: style.css\n`,
  );
  await site.write('web-files/style.css', 'main { color: red; }');
  await site.write(
    'table-permissions/Article.tablepermission.yaml',
    `mspp_entitypermissionid: ${id(8)}\nmspp_name: Article\nmspp_entitylogicalname: invented_article\nmspp_read: true\nmspp_entitypermission_webrole: [${id(9)}]\n`,
  );

  const lense = await PortalModel.create(site.root);
  const mirage = await importPortal(site.root, { lcid: 3084 });
  assert.equal(mirage.source.dialect, 'enhanced-yaml');
  assert.equal(mirage.dataModel, 'enhanced');
  assert.equal(mirage.dataModelSource, 'export');
  assert.equal(mirage.website.id, id(1));
  assert.equal(mirage.websiteLanguages[0].code, 'fr-CA');
  assert.equal(mirage.pages[0].html, '<main>Accueil</main>');
  assert.equal(mirage.webFiles[0].id, id(7));
  assert.equal(mirage.records.find((record) => record.id === id(8)).powerpagecomponenttype, 18);
  assert.equal(lense.pagePath(id(3)), '/');
  assert.ok(lense.languageCodes.has('fr-ca'));
  assert.equal(lense.findWebFile('/style.css').id, id(7));
  assert.equal(lense.inlineSources.find((row) => row.kind === 'page-copy').pageUrl, '/');
  const source = lense.inlineSources.find((row) => row.file === snippet);
  assert.deepEqual(
    [source.fieldPath, source.recordIdField, source.recordId, source.recordLanguageField, source.recordLanguageId],
    [['mspp_value'], 'mspp_contentsnippetid', id(6), 'mspp_contentsnippetlanguageid', id(5)],
  );
  editSource(source, () => 'Bonjour');
  assert.equal(sourceText(source), 'Bonjour');
  assert.match(await fs.readFile(snippet, 'utf8'), /^mspp_description: Keep me$/m);
  assert.equal((await importPortal(site.root, { lcid: 3084 })).snippets.Welcome, 'Bonjour');
  const audit = auditResources(lense, {
    ...SITE,
    markup: { ...SITE.markup, kinds: [...SITE.markup.kinds, 'metadata-markup'] },
  });
  assert.equal(audit.coverage.complete, true, JSON.stringify(audit.totals));
});

test('source links and resource writeback choose the effective mspp_ alias for the selected language', async (t) => {
  const site = await fixture(t);
  await site.write('website.yaml', `mspp_websiteid: ${id(1)}\nmspp_name: Enhanced\nmspp_defaultlanguage: ${id(5)}\n`);
  await site.write(
    'web-pages/home/Home.webpage.yaml',
    `mspp_webpageid: ${id(2)}\nmspp_name: Home\nmspp_partialurl: /\n`,
  );
  const snippet = await site.write(
    'content-snippets/Welcome.contentsnippet.yaml',
    [
      'value: Shadowed placeholder',
      `mspp_contentsnippetid: ${id(6)}`,
      'mspp_name: Welcome',
      `mspp_contentsnippetlanguageid: ${id(5)}`,
      'adx_value: null',
      'mspp_value: Bienvenue',
      '',
    ].join('\n'),
  );

  const portal = await importPortal(site.root);
  const source = buildPortalSourceIndex({ portal, languageId: id(5) }).snippet('Welcome');
  assert.equal(source.text, 'Bienvenue');
  const position = sourceEditorTarget(source);
  assert.equal(position.file, snippet);
  assert.equal(position.line, 6, 'the editor must open the same field that supplied the rendered text');

  const model = await PortalModel.create(site.root);
  const report = describeResources({ sourceDir: site.root, site: SITE }, model, { available: false }, new Set());
  const descriptor = report.resources.find((item) => item.path === snippet && item.kind === 'metadata-markup');
  assert.deepEqual(descriptor.fieldPath, ['mspp_value']);
  assert.equal(descriptor.recordLanguageField, 'mspp_contentsnippetlanguageid');
  assert.equal(descriptor.recordLanguageId, id(5));
  editSource(descriptor, () => 'Bonjour');
  const edited = await fs.readFile(snippet, 'utf8');
  assert.match(edited, /^value: Shadowed placeholder$/m);
  assert.match(edited, /^adx_value: null$/m);
  assert.match(edited, /^mspp_value: Bonjour$/m);
  assert.equal((await importPortal(site.root)).snippets.Welcome, 'Bonjour');
  assert.equal(sourceEditorTarget(source), null, 'the previous source revision is stale after writing');

  const reassigned = edited.replace(
    `mspp_contentsnippetlanguageid: ${id(5)}`,
    `mspp_contentsnippetlanguageid: ${id(9)}`,
  );
  await fs.writeFile(snippet, reassigned);
  assert.throws(() => editSource(descriptor, () => 'Wrong language'), /stale language identity/);
  assert.equal(await fs.readFile(snippet, 'utf8'), reassigned);
});

const enhancedComponent = (n, type, name, content, site = 1, extra = '') =>
  `<powerpagecomponent powerpagecomponentid="${id(n)}">` +
  `<content><![CDATA[${JSON.stringify(content)}]]></content><name>${name}</name>` +
  `<powerpagecomponenttype>${type}</powerpagecomponenttype><statecode>0</statecode>` +
  `<powerpagesiteid><powerpagesiteid>${id(site)}</powerpagesiteid></powerpagesiteid>${extra}</powerpagecomponent>`;

const componentFile = (n) => `powerpagecomponents/${id(n)}/powerpagecomponent.xml`;
const siteRecord = (n, name) =>
  `<powerpagesite powerpagesiteid="${id(n)}"><name>${name}</name><content>{}</content></powerpagesite>`;

test('enhanced content preserves literal closing-tag text and ignores XML-like content and comments', async (t) => {
  const site = await fixture(t);
  await site.write(componentFile(2), enhancedComponent(2, 2, 'Home', { isroot: true, partialurl: '/' }));
  const source = '<p>Valid </content> &amp; literal</p><!-- <statecode>1</statecode> -->';
  const template = enhancedComponent(3, 8, 'Template', { source }).replace(
    '<content>',
    '<!-- <content>not metadata</content><name>not a name</name> --><content>',
  );
  await site.write(componentFile(3), template);

  const lense = new PortalModel(site.root);
  const mirage = await importPortal(site.root);
  const lenseTemplate = lense.inlineSources.find((item) => item.kind === 'web-template');
  assert.equal(sourceText(lenseTemplate), source);
  assert.equal(mirage.templates.Template.source, source);
  assert.ok(!mirage.diagnostics.some((diagnostic) => diagnostic.code === 'invalid-enhanced-content'));
});

test('both loaders reject mixed-site enhanced Solutions before exposing pages, assets, settings or grants', async (t) => {
  const site = await fixture(t);
  const writeSites = (...records) =>
    site.write('Assets/powerpagesites.xml', `<powerpagesites>${records.join('')}</powerpagesites>`);
  await writeSites(siteRecord(1, 'First'));
  const components = [
    [2, 2, 'Home', { isroot: true, partialurl: '/' }],
    [
      3,
      3,
      'Site CSS',
      { partialurl: 'site.css', parentpageid: id(2) },
      '<filecontent mimetype="text/css">site.css</filecontent>',
    ],
    [4, 9, 'HTTP/X-Frame-Options', { value: 'SAMEORIGIN' }],
    [5, 11, 'Member', {}],
    [6, 18, 'Scoped grant', { entitylogicalname: 'invented_article', read: true }],
  ];
  const writeComponent = ([n, type, name, content, extra], owner) =>
    site.write(componentFile(n), enhancedComponent(n, type, name, content, owner, extra));
  for (const component of components) await writeComponent(component, 1);
  await site.write(`powerpagecomponents/${id(3)}/filecontent/site.css`, 'main { color: red; }');
  const lense = new PortalModel(site.root);
  assert.ok(lense.findWebFile('/site.css'));
  assert.equal(lense.siteSettings['HTTP/X-Frame-Options'], 'SAMEORIGIN');
  const mirage = await importPortal(site.root);
  assert.equal(mirage.website.id, id(1));
  assert.equal(mirage.pages[0].id, id(2));
  assert.equal(mirage.webFiles[0].id, id(3));
  assert.ok(mirage.records.some((record) => record.id === id(6)));

  const refuse = async () => {
    assert.throws(() => new PortalModel(site.root), { code: 'AMBIGUOUS_PORTAL_SITE' });
    await assert.rejects(importPortal(site.root), { code: 'AMBIGUOUS_PORTAL_SITE' });
  };
  await writeSites(siteRecord(1, 'First'), siteRecord(99, 'Second'));
  await refuse();
  assert.throws(() => lense.load(), { code: 'AMBIGUOUS_PORTAL_SITE' });
  assert.equal(lense.ambiguousSite, true);
  assert.equal(lense.findWebFile('/site.css'), null);
  await writeSites(siteRecord(1, 'First'));
  lense.load();
  assert.equal(lense.ambiguousSite, false);
  assert.ok(lense.findWebFile('/site.css'));
  for (const component of components) {
    await writeComponent(component, 99);
    await refuse();
    await writeComponent(component, 1);
  }
});

test('both loaders skip one malformed component envelope and keep the rest of the Solution', async (t) => {
  const site = await fixture(t);
  await site.write('Assets/powerpagesites.xml', `<powerpagesites>${siteRecord(1, 'First')}</powerpagesites>`);
  await site.write(componentFile(2), enhancedComponent(2, 2, 'Home', { isroot: true, partialurl: '/' }));
  await site.write(componentFile(3), enhancedComponent(3, 9, 'Valid/Setting', { value: 'kept' }));
  // A character reference outside Unicode is not well-formed XML (String.fromCodePoint throws on it).
  await site.write(componentFile(4), enhancedComponent(4, 9, 'Bad&#x110000;Name', { value: 'x' }));
  await site.write(
    componentFile(5),
    enhancedComponent(5, 8, 'Template', { source: 'body' }).replace(
      '<powerpagecomponenttype>8<',
      '<powerpagecomponenttype>&#1114112;<',
    ),
  );

  const lense = new PortalModel(site.root);
  for (const n of [4, 5])
    assert.ok(lense.warnings.includes(`powerpagecomponents/${id(n)}/powerpagecomponent.xml: malformed component XML`));
  assert.equal(lense.siteSettings['Valid/Setting'], 'kept');
  assert.equal(lense.pagePath(id(2)), '/');
  assert.equal(
    lense.inlineSources.find((item) => item.kind === 'web-template'),
    undefined,
  );
  lense.load();
  assert.doesNotThrow(() => auditResources(lense, SITE));

  const mirage = await importPortal(site.root);
  assert.equal(mirage.pages[0].id, id(2));
  assert.ok(mirage.records.some((record) => record.id === id(3)));
  for (const n of [4, 5]) {
    assert.ok(!mirage.records.some((record) => record.id === id(n)));
    assert.ok(
      mirage.diagnostics.some(
        (diagnostic) =>
          diagnostic.code === 'invalid-enhanced-content' &&
          diagnostic.file.endsWith(path.join(id(n), 'powerpagecomponent.xml')),
      ),
    );
  }
});

const siteLanguage = (n, owner, code) =>
  `<powerpagesitelanguages><powerpagesitelanguage powerpagesitelanguageid="${id(n)}"><name>${code}</name>` +
  `<languagecode>${code}</languagecode><powerpagesiteid><powerpagesiteid>${id(owner)}</powerpagesiteid></powerpagesiteid>` +
  `</powerpagesitelanguage></powerpagesitelanguages>`;
const ignoredMetadata = (portal) =>
  portal.diagnostics.filter((diagnostic) => diagnostic.code === 'ENHANCED_SITE_METADATA_IGNORED');

test('both loaders read site metadata only from Assets/ or the root, never from a stray copy', async (t) => {
  const site = await fixture(t);
  await site.write(componentFile(2), enhancedComponent(2, 2, 'Home', { isroot: true, partialurl: '/' }));
  await site.write('Assets/powerpagesites.xml', `<powerpagesites>${siteRecord(1, 'First')}</powerpagesites>`);
  await site.write('Assets/powerpagesitelanguages.xml', siteLanguage(7, 1, 'en-US'));
  await site.write('Other/previous/powerpagesites.xml', `<powerpagesites>${siteRecord(9, 'Stray')}</powerpagesites>`);
  await site.write('Other/previous/powerpagesitelanguages.xml', siteLanguage(8, 9, 'fr-FR'));

  const lense = new PortalModel(site.root);
  assert.equal(lense.ambiguousSite, false);
  assert.deepEqual([...lense.languageCodes], ['en-us']);
  const mirage = await importPortal(site.root);
  assert.equal(mirage.website.id, id(1));
  assert.equal(mirage.website.name, 'First');
  const languages = mirage.records.filter((record) => record.kind === 'websitelanguage').map((record) => record.id);
  assert.deepEqual(languages, [id(7)]);
  assert.deepEqual(
    ignoredMetadata(mirage).map((diagnostic) => diagnostic.files),
    [['Other/previous/powerpagesitelanguages.xml', 'Other/previous/powerpagesites.xml']],
  );

  // The root is a metadata location for both loaders, so a second site there is ambiguous for both.
  await site.write('powerpagesites.xml', `<powerpagesites>${siteRecord(9, 'Stray')}</powerpagesites>`);
  assert.throws(() => new PortalModel(site.root), { code: 'AMBIGUOUS_PORTAL_SITE' });
  await assert.rejects(importPortal(site.root), { code: 'AMBIGUOUS_PORTAL_SITE' });
});

test('Mirage reads site metadata of a Solution nested below the source folder and reports metadata it ignores', async (t) => {
  const site = await fixture(t);
  const solution = 'exports/Invented Solution_1_0_0_0';
  await site.write(
    `${solution}/${componentFile(2)}`,
    enhancedComponent(2, 2, 'Home', { isroot: true, partialurl: '/' }),
  );
  await site.write(
    `${solution}/Assets/powerpagesites.xml`,
    `<powerpagesites>${siteRecord(1, 'First')}</powerpagesites>`,
  );
  await site.write(`${solution}/Assets/powerpagesitelanguages.xml`, siteLanguage(7, 1, 'en-US'));

  // Lense opens the Solution itself; Mirage also accepts a folder above it and reads the same site.
  const lense = new PortalModel(path.join(site.root, solution));
  assert.equal(lense.format, 'enhanced');
  assert.deepEqual([...lense.languageCodes], ['en-us']);
  const nested = await importPortal(path.join(site.root, solution));
  const parent = await importPortal(site.root);
  for (const portal of [nested, parent]) {
    assert.equal(portal.website.id, id(1));
    assert.equal(portal.website.name, 'First');
    assert.deepEqual(ignoredMetadata(portal), []);
  }
  assert.equal(parent.records.length, nested.records.length);
  assert.deepEqual(
    parent.records.map((record) => record.id),
    nested.records.map((record) => record.id),
  );

  // Site metadata in neither Assets/ nor the root of the Solution names no site, and the import says so.
  await fs.rename(path.join(site.root, solution, 'Assets'), path.join(site.root, 'exports', 'Assets'));
  const unread = await importPortal(site.root);
  assert.deepEqual(unread.website, {});
  const [diagnostic] = ignoredMetadata(unread);
  assert.deepEqual(diagnostic.files, [
    'exports/Assets/powerpagesitelanguages.xml',
    'exports/Assets/powerpagesites.xml',
  ]);
  assert.match(diagnostic.message, /^No site metadata was read/);
});
