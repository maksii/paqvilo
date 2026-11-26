// @test-kind contract: request-language metadata controls the page bound to the portal route and navigation honors the shared shortcut access rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';
import { createSimulator } from '../api.mjs';
import { AssetCache } from '../lib/asset-cache.mjs';
import { importPortal } from '../lib/importer.mjs';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { resolvePageResources } from '../lib/page-resources.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { signInHeaders } from '../testing/session.mjs';

const record = (kind, id, fields = {}) => ({
  [`adx_${kind}id`]: id,
  adx_name: id,
  ...Object.fromEntries(Object.entries(fields).map(([name, value]) => [`adx_${name}`, value])),
});
const page = (id, fields) => record('webpage', id, { isroot: true, ...fields });
const child = (parent, language, fields) =>
  page(`${parent}-${language}`, { isroot: false, rootwebpageid: parent, webpagelanguageid: language, ...fields });

const CONTACT = '77777777-7777-4777-8777-777777777719';
const DRAFT_LINK_SET = '77777777-7777-4777-8777-777777777720';
const PUBLISHED_LINK_SET = '77777777-7777-4777-8777-777777777721';

async function fixture(
  t,
  { displayLanguageCode = true, authoredDescription, customErrors = false, withState = false } = {},
) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'localized-portal-routing-'));
  const owned = ownedFixture(t);
  owned.remove(() => fs.rm(dir, { recursive: true, force: true }));
  const bindings = (locale) => ({
    pagetemplateid: `template-${locale}`,
    entityformid: `form-${locale}`,
    webformid: `wizard-${locale}`,
    entitylistid: `list-${locale}`,
  });
  const files = {
    'website.yml': record('website', 'site', { defaultlanguage: 'en', website_language: 1033 }),
    'websitelanguage.yml': [
      record('websitelanguage', 'en', { languagecode: 'en-US', lcid: 1033 }),
      record('websitelanguage', 'fr', { languagecode: 'fr-FR', lcid: 1036, portallanguageid: 'fr-catalogue' }),
    ],
    'sitesetting.yml': record('sitesetting', 'language-path', {
      name: 'MultiLanguage/DisplayLanguageCodeInURL',
      value: String(displayLanguageCode),
    }),
    'site.publishingstate.yml': [
      record('publishingstate', 'published', { isvisible: true }),
      record('publishingstate', 'draft', { isvisible: false }),
    ],
    'site.webrole.yml': [
      record('webrole', 'preview-editors', { name: 'Editor' }),
      record('webrole', 'navigation-editors', { name: 'Navigation editor' }),
    ],
    'site.websiteaccess.yml': [
      record('websiteaccess', 'preview-right', {
        previewunpublishedentities: true,
        websiteaccess_webrole: ['preview-editors'],
      }),
      record('websiteaccess', 'navigation-right', {
        manageweblinksets: true,
        websiteaccess_webrole: ['navigation-editors'],
      }),
    ],
    'site.weblinkset.yml': [
      record('weblinkset', 'preview-links', { display_name: 'Fixture "links" <sample>' }),
      record('weblinkset', DRAFT_LINK_SET, {
        name: 'Same name',
        title: 'Draft set title',
        publishingstateid: 'draft',
      }),
      record('weblinkset', PUBLISHED_LINK_SET, { name: 'Same name', title: 'Published duplicate title' }),
    ],
    'site.weblink.yml': [
      record('weblink', 'preview-link', {
        name: 'Draft page navigation link',
        pageid: 'restricted',
        weblinksetid: 'preview-links',
      }),
      record('weblink', 'external-draft', {
        name: 'Draft external record',
        weblinksetid: 'preview-links',
        externalurl: 'https://example.invalid/draft',
        publishingstateid: 'draft',
      }),
      record('weblink', 'target-bypass', {
        name: 'Published bypass record',
        weblinksetid: 'preview-links',
        pageid: 'restricted',
        disablepagevalidation: true,
      }),
      record('weblink', 'draft-child', {
        name: 'Draft child record',
        weblinksetid: 'preview-links',
        pageid: 'visible',
        disablepagevalidation: true,
        parentweblinkid: 'target-bypass',
        publishingstateid: 'draft',
      }),
    ],
    'site.ad.yml': record('ad', 'draft-ad', { name: 'Draft fixture ad', publishingstateid: 'draft' }),
    'site.webpage.yml': [
      page('home', { partialurl: '/', pagetemplateid: 'navigation' }),
      page('visible', { partialurl: 'visible', parentpageid: 'home' }),
      child('visible', 'en', bindings('english')),
      child('visible', 'fr', bindings('french')),
      page('restricted', { partialurl: 'restricted', parentpageid: 'home' }),
      child('restricted', 'en', { ...bindings('english'), publishingstateid: 'published' }),
      child('restricted', 'fr', { ...bindings('french'), publishingstateid: 'draft' }),
      page('seo', {
        partialurl: 'seo',
        parentpageid: 'home',
        pagetemplateid: 'seo',
        meta_description: 'Literal "&" detail',
      }),
      child('seo', 'en', {}),
      child('seo', 'fr', { meta_description: 'Détails français' }),
    ],
    'site.pagetemplate.yml': ['navigation', 'template-english', 'template-french', 'seo'].map((name) =>
      record('pagetemplate', name, { webtemplateid: name, usewebsiteheaderandfooter: name === 'seo' }),
    ),
    'Seo.webtemplate.yml': record('webtemplate', 'seo'),
    'Seo.webtemplate.source.html': "<main>{% include 'component' heading: 'Fixture content', count: '04' %}</main>",
    'Component.webtemplate.yml': record('webtemplate', 'component'),
    'Component.webtemplate.source.html':
      '{% manifest %}{"type":"Functional","displayName":"Fixture component","params":[{"id":"heading"},{"id":"count"}]}{% endmanifest %}' +
      '<h2>{{ heading }}</h2><p>{{ count }}={{ count | integer }}</p>',
    'robots.txt.webfile.yml': record('webfile', 'robots', { partialurl: 'robots.txt', parentpageid: 'home' }),
    'robots.txt': 'User-agent: *\n',
    'sitemap.xml.webfile.yml': record('webfile', 'sitemap', { partialurl: 'sitemap.xml', parentpageid: 'home' }),
    'sitemap.xml': '<urlset/>',
    'public.txt.webfile.yml': record('webfile', 'public-file', { partialurl: 'public.txt', parentpageid: 'home' }),
    'draft.txt.webfile.yml': record('webfile', 'draft-file', {
      partialurl: 'draft.txt',
      parentpageid: 'home',
      publishingstateid: 'draft',
    }),
    'public.txt': 'public fixture',
    'draft.txt': 'draft fixture',
    'site.shortcut.yml': [
      record('shortcut', 'public-shortcut', {
        title: 'Public file',
        description: 'A <source> description',
        parentpage_webpageid: 'home',
        webfileid: 'public-file',
      }),
      record('shortcut', 'missing-target', {
        title: 'Unresolved preferred target',
        parentpage_webpageid: 'home',
        webpageid: 'missing-page',
        webfileid: 'public-file',
      }),
      record('shortcut', 'draft-shortcut', {
        title: 'Draft file',
        parentpage_webpageid: 'home',
        webfileid: 'draft-file',
      }),
      record('shortcut', 'parent-shortcut', {
        title: 'Parent checked',
        parentpage_webpageid: 'restricted',
        webfileid: 'public-file',
        disabletargetvalidation: true,
      }),
      record('shortcut', 'external-shortcut', {
        title: 'External preferred',
        parentpage_webpageid: 'home',
        externalurl: 'https://example.invalid/resource',
        webpageid: 'restricted',
      }),
    ],
    'Navigation.webtemplate.yml': record('webtemplate', 'navigation'),
    'Navigation.webtemplate.source.html':
      "{% for node in sitemap.root.children %}[{{ node.name }}={{ node.url }}{% if node.description %}: {{ node.description | h }}{% endif %}]{% endfor %}|{% for node in sitemap['/restricted/'].children %}[{{ node.name }}]{% endfor %}" +
      "|{% for link in weblinks['preview-links'].weblinks %}[{{ link.name }}]{% for child in link.weblinks %}[{{ child.name }}]{% endfor %}{% endfor %}|{{ ads['Draft fixture ad'].name }}" +
      `|[name:{{ weblinks['Same name'].title }}][draft-id:{{ weblinks['${DRAFT_LINK_SET}'].title }}][published-id:{{ weblinks['${PUBLISHED_LINK_SET}'].title }}]` +
      `{% assign primary_nav = weblinks['preview-links'] %}<div id="cms-navigation"{% if primary_nav.editable %} class="xrm-entity xrm-editable-adx_weblinkset"{% endif %}>{% editable primary_nav %}</div>`,
  };
  if (authoredDescription) {
    files['Head.contentsnippet.yml'] = record('contentsnippet', 'head', { name: 'Head/Bottom' });
    files['Head.contentsnippet.value.html'] = authoredDescription;
  }
  if (customErrors) {
    files['DefaultError.contentsnippet.yml'] = record('contentsnippet', 'default-error', {
      name: 'Portal Generic Error',
      type: 756150000,
    });
    files['DefaultError.contentsnippet.value.html'] = 'Text fixture <b>{{ site.secret_setting }}</b>';
    files['FrenchError.contentsnippet.yml'] = record('contentsnippet', 'french-error', {
      name: 'Portal Generic Error',
      type: 756150001,
      contentsnippetlanguageid: 'fr',
    });
    files['FrenchError.contentsnippet.value.html'] = '<strong>HTML fixture {{ site.secret_setting }}</strong>';
  }
  for (const name of ['english', 'french']) {
    files[`${name}.webtemplate.yml`] = record('webtemplate', `template-${name}`);
    files[`${name}.webtemplate.source.html`] =
      `${name}|{{ page.adx_entityform.id }}|{{ page.adx_webform.id }}|{{ page.adx_entitylist.id }}`;
  }
  for (const [file, value] of Object.entries(files))
    await fs.writeFile(path.join(dir, file), typeof value === 'string' ? value : stringify(value));
  const app = await createSimulator({
    sourceDir: dir,
    ...(withState ? { stateFile: path.join(dir, 'state.json') } : {}),
    port: 0,
    watch: false,
    ...(customErrors
      ? {
          observed: {
            pageErrorPresentation: 'generic-error',
            requestValidation: 'aspnet-query',
            evidence: 'invented fixture',
          },
        }
      : {}),
    initial: {
      version: 1,
      mappings: { contact: { idColumn: 'contactid' } },
      tables: {
        contact: [{ contactid: CONTACT, fullname: 'Visitor fixture', adx_preferredlanguageid: 'fr-catalogue' }],
      },
      simulator: { mode: 'local', pageMode: 'local' },
    },
  });
  owned.add(() => app.close());
  return { app, dir, get: (route, options) => fetch(app.url + route, { redirect: 'manual', ...options }) };
}

test('language pages render their own template and form bindings and enforce their publishing state', async (t) => {
  const { get, dir } = await fixture(t);
  assert.equal(await (await get('/visible/')).text(), 'english|form-english|wizard-english|list-english');
  assert.equal(await (await get('/fr-FR/visible/')).text(), 'french|form-french|wizard-french|list-french');
  assert.equal((await get('/restricted/')).status, 200);
  const draft = await get('/fr-FR/restricted/');
  assert.equal(draft.status, 302);
  assert.equal(draft.headers.get('x-sim-route'), 'sign-in');
  const deniedLocation = new URL(draft.headers.get('location'));
  assert.equal(deniedLocation.pathname, '/fr-FR/signin');
  assert.equal(deniedLocation.searchParams.get('ReturnUrl'), '/fr-FR/restricted/');

  const canonical = await get('/fr-FR/visible?x=1');
  assert.equal(canonical.status, 301);
  assert.equal(canonical.headers.get('location'), '/fr-FR/visible/?x=1');

  const resources = resolvePageResources(await importPortal(dir), '/fr-FR/visible/');
  assert.equal(resources.pageTemplate.id, 'template-french');
});

test('rendered sitemap checks web file shortcuts, localized parents and external target precedence', async (t) => {
  const { get, dir } = await fixture(t);
  for (const route of ['/', '/fr-FR/']) {
    const response = await get(route);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /\[Public file=\/public\.txt: A &lt;source&gt; description\]/);
    assert.match(html, /\[External preferred=https:\/\/example\.invalid\/resource\]/);
    assert.doesNotMatch(html, /Draft file|Unresolved preferred target/);
    if (route === '/') assert.match(html, /Parent checked/);
    else assert.doesNotMatch(html, /Parent checked/);
  }
  const { diagnostics } = await importPortal(dir);
  const unresolved = diagnostics.find((entry) => entry.code === 'SHORTCUT_TARGET_UNRESOLVED');
  assert.deepEqual(
    { shortcutId: unresolved.shortcutId, targetKind: unresolved.targetKind, targetId: unresolved.targetId },
    { shortcutId: 'missing-target', targetKind: 'webpage', targetId: 'missing-page' },
  );
});

// @test-kind security: a preview cookie attenuates a website role's access and cannot grant it to other visitors.
test('publishing preview switches the direct page, file and Liquid navigation together', async (t) => {
  const { app, get } = await fixture(t);
  const editor = signInHeaders(app, CONTACT, { roles: ['Editor'] });
  const visitor = signInHeaders(app, CONTACT);
  const preview = (headers, value) => ({
    cookie: [headers.cookie, `adxPreviewUnpublishedEntities=${value}`].filter(Boolean).join('; '),
  });
  for (const headers of [preview(editor, 'false'), preview(editor, 'invalid'), preview(visitor, 'true')]) {
    assert.equal((await get('/fr-FR/restricted/?adxPreviewUnpublishedEntities=true', { headers })).status, 403);
    assert.equal((await get('/draft.txt', { headers })).status, 403);
    const html = await (await get('/fr-FR/', { headers })).text();
    assert.doesNotMatch(html, /Draft page navigation link|Draft file|Draft fixture ad/);
  }
  for (const headers of [editor, preview(editor, 'TrUe')]) {
    assert.equal((await get('/fr-FR/restricted/', { headers })).status, 200);
    const file = await get('/draft.txt', { headers });
    assert.equal(file.status, 200);
    assert.equal(file.headers.get('cache-control'), 'private, no-store');
    assert.equal(await file.text(), 'draft fixture');
    const html = await (await get('/fr-FR/', { headers })).text();
    assert.match(html, /Draft page navigation link/);
    assert.match(html, /Draft file/);
    assert.match(html, /Draft fixture ad/);
  }
  assert.equal((await get('/draft.txt', { headers: preview({}, 'true') })).status, 302);
  assert.equal((await get('/public.txt', { headers: editor })).headers.get('cache-control'), 'public, max-age=3600');
});

// @test-kind security: publication filters each link and set independently of target validation for the current persona.
test('web link and set publishing states apply before optional link target validation', async (t) => {
  const { app, get } = await fixture(t);
  const { cookie } = signInHeaders(app, CONTACT, { roles: ['Editor'] });
  const loadNavigation = async (header) => {
    const response = await get('/fr-FR/', header ? { headers: { cookie: header } } : undefined);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /\bno-store\b/);
    return response.text();
  };
  for (const header of [undefined, `${cookie}; adxPreviewUnpublishedEntities=false`]) {
    const html = await loadNavigation(header);
    assert.equal(
      /Draft external record|Draft child record|Draft page navigation link|Draft set title/.test(html),
      false,
      'preview-free navigation excludes draft records',
    );
    assert.match(html, /\[Published bypass record\]/);
    assert.match(html, /\[name:\]\[draft-id:\]\[published-id:Published duplicate title\]/);
  }
  const html = await loadNavigation(`${cookie}; adxPreviewUnpublishedEntities=true`);
  assert.match(html, /\[Draft external record\]/);
  assert.match(html, /\[Published bypass record\]\[Draft child record\]/);
  assert.match(html, /\[name:Draft set title\]\[draft-id:Draft set title\]\[published-id:Published duplicate title\]/);
});

// @test-kind security: rendering editable navigation metadata requires the specific website access right.
test('editable navigation requires Manage Web Link Sets and emits inert source metadata', async (t) => {
  const { app, get } = await fixture(t);
  const permitted = signInHeaders(app, CONTACT, { roles: ['Navigation editor'] });
  const previewOnly = signInHeaders(app, CONTACT, { roles: ['Editor'] });
  for (const headers of [{}, previewOnly]) {
    const body = await (await get('/fr-FR/', { headers })).text();
    assert.match(body, /<div id="cms-navigation"><\/div>/);
  }

  const response = await get('/fr-FR/', { headers: permitted });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /\bno-store\b/);
  const body = await response.text();
  assert.equal(
    body.includes('<div id="cms-navigation" class="xrm-entity xrm-editable-adx_weblinkset">'),
    true,
    'the authored editable flag enables the editor DOM branch',
  );
  assert.match(
    body,
    /<span hidden aria-hidden="true" data-mirage-editable="weblinkset" data-logicalname="adx_weblinkset" data-id="preview-links" data-label="Fixture &quot;links&quot; &lt;sample&gt;"><\/span>/,
  );
  assert.doesNotMatch(body, /\/_services\/portal\/|Draft set title/);
});

test('an explicit URL language survives its redirect and overrides the contact or cookie preference', async (t) => {
  const { app, get } = await fixture(t, { displayLanguageCode: false });
  const contact = signInHeaders(app, CONTACT);
  assert.match(await (await get('/visible/', { headers: contact })).text(), /^french\|/);
  assert.match(
    await (await get('/visible/', { headers: { cookie: `${contact.cookie}; ContextLanguageCode=unknown` } })).text(),
    /^french\|/,
  );
  const selected = await get('/en-US/visible/', {
    headers: { cookie: `${contact.cookie}; ContextLanguageCode=fr-FR` },
  });
  assert.equal(selected.status, 302);
  assert.equal(selected.headers.get('location'), '/visible/');
  const language = selected.headers.getSetCookie().find((value) => value.startsWith('ContextLanguageCode='));
  assert.match(language, /^ContextLanguageCode=en-US; Path=\/; HttpOnly; SameSite=Lax$/);
  const headers = { cookie: `${contact.cookie}; ${language.split(';')[0]}` };
  assert.match(await (await get('/visible/', { headers })).text(), /^english\|/);
});

test('localized default search keeps the visible language prefix in its action', async (t) => {
  const { get } = await fixture(t);
  const response = await get('/fr-FR/search/?q=fixture');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('x-sim-route'), 'portal-search-local');
  const html = await response.text();
  assert.match(html, /<html lang="fr-FR">/);
  assert.match(html, /<title>Recherch(?:e|er)<\/title>/);
  assert.match(html, /action="\/fr-FR\/search\/"/);
  assert.match(html, /name="q" value="fixture"/);
});

test('the shell emits encoded localized page descriptions and preserves authored SEO web files', async (t) => {
  const { get } = await fixture(t);
  assert.match(
    await (await get('/seo/')).text(),
    /<meta name="description" content="Literal &quot;&amp;&quot; detail">/,
  );
  assert.match(await (await get('/fr-FR/seo/')).text(), /<meta name="description" content="Détails français">/);
  assert.equal(await (await get('/robots.txt')).text(), 'User-agent: *\n');
  assert.equal(await (await get('/sitemap.xml')).text(), '<urlset/>');
  assert.doesNotMatch(await (await get('/visible/')).text(), /name="description"/);
});

test('authored description metadata in Head/Bottom takes precedence', async (t) => {
  const { get } = await fixture(t, { authoredDescription: '<meta content="Authored" name="Description">' });
  const html = await (await get('/seo/')).text();
  assert.deepEqual(html.match(/<meta\b[^>]*name="description"[^>]*>/gi), [
    '<meta content="Authored" name="Description">',
  ]);
});

test('the selected generic error uses the exported Text or HTML snippet without evaluating Liquid', async (t) => {
  const { get } = await fixture(t, { customErrors: true });
  const plain = await get('/visible/?q=%3Cem%3E');
  assert.equal(plain.status, 500);
  const plainHtml = await plain.text();
  assert.match(plainHtml, /<p>Text fixture &lt;b&gt;&lt;\/b&gt;<\/p>/);
  assert.match(plainHtml, /Error ID: \[[0-9a-f-]{36}\]/);
  assert.match(plainHtml, /Date and time: [0-9T:.-]+Z/);
  assert.match(plainHtml, /Portal ID: site/);
  const localized = await get('/fr-FR/visible/?q=%3Cem%3E');
  assert.equal(localized.status, 500);
  const localizedHtml = await localized.text();
  assert.match(localizedHtml, /<strong>HTML fixture <\/strong>/);
  assert.doesNotMatch(localizedHtml, /secret_setting|Text fixture/);
});

test('web template manifests remain hidden while authored parameters flow through the include', async (t) => {
  const { get, dir } = await fixture(t);
  const rendered = await (await get('/seo/')).text();
  assert.match(rendered, /<h2>Fixture content<\/h2><p>04=4<\/p>/);
  assert.doesNotMatch(rendered, /Fixture component/);
  const portal = await importPortal(dir);
  const renderer = createPortalRenderer(portal);
  const site = renderer.contextForPage(portal.pages[0]);
  assert.equal(
    await renderer.renderString('{% manifest %}{"params":[{}]}{% endmanifest %}ordinary copy', site),
    'ordinary copy',
  );
  assert.ok(site.__diagnostics.some(({ code }) => code === 'WEB_TEMPLATE_MANIFEST_INVALID'));
});

// @test-kind contract: a source reload invalidates an in-flight page before it can combine source revisions.
test('an in-flight localized page can retry after the source revision changes during routing', async (t) => {
  const { app, get, dir } = await fixture(t, { withState: true });
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  ownedFixture(t).add(() => release.resolve());
  const cacheGet = AssetCache.prototype.get;
  let held = false;
  t.mock.method(AssetCache.prototype, 'get', async function (...args) {
    if (args[0] === '/visible/' && !held) {
      held = true;
      entered.resolve();
      await release.promise;
    }
    return cacheGet.apply(this, args);
  });
  const inFlight = get('/fr-FR/visible/');
  await entered.promise;
  try {
    await fs.writeFile(path.join(dir, 'french.webtemplate.source.html'), 'later French fixture');
    await app.reload();
  } finally {
    release.resolve();
  }
  const raced = await inFlight;
  assert.equal(raced.status, 409);
  assert.match(await raced.text(), /Portal sources changed while resolving this page/);
  const refreshed = await get('/fr-FR/visible/');
  assert.equal(refreshed.status, 200);
  assert.equal(await refreshed.text(), 'later French fixture');
});
