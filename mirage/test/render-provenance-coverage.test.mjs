// @test-kind contract: Mirage render provenance design (every element of a rendered document is bound to its exported source region or to the platform part that generated it; Lense X-ray consumes the bindings)
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import { importPortal } from '../lib/importer.mjs';
import {
  createPortalRenderer,
  accountPageEdits,
  applyMarkupEdits,
  platformDocumentFragment,
  shellTags,
} from '../lib/liquid.mjs';
import { signInContent } from '../lib/auth-session.mjs';
import { externalProviders } from '../lib/external-login.mjs';
import { signInPartTags } from '../lib/sign-in-provenance.mjs';
import { renderPortalSearchPage } from '../lib/portal-search.mjs';
import { injectRuntimeCompatibility } from '../lib/source-dependencies.mjs';
import { observedHeaderNotifications } from '../lib/header-notification-capture.mjs';
import { observedFooterLogos } from '../lib/footer-capture.mjs';
import { registerShellConventions } from '../lib/extensions.mjs';
import { LiquidEngine, LiquidContext } from '../lib/liquid-engine.mjs';
import { buildPortalSourceIndex } from '../lib/portal-source-index.mjs';
import {
  createRenderTrace,
  createRenderBuffer,
  renderFragment,
  finalizePortalProvenance,
  isToolkitElement,
  markupEdit,
  applyRenderEdits,
  scanStartTags,
} from '../lib/render-provenance.mjs';

const example = fileURLToPath(new URL('../../examples/project/portal', import.meta.url));
const MARKER = '<!--paqvilo-mirage-sign-in-content-->';

/** Every element of a document with the binding its provenance stamp names (none when unstamped). */
function elements(html, provenance) {
  const byId = new Map((provenance?.bindings ?? []).map((binding) => [binding.id, binding]));
  const rows = [];
  const walk = (node, trail) => {
    for (const child of node.childNodes ?? []) {
      if (!child.tagName) continue;
      if (isToolkitElement(child.attrs.map((attribute) => attribute.name))) continue;
      const id = child.attrs.find((attribute) => attribute.name === 'data-paqvilo-source')?.value;
      const path = `${trail}>${child.tagName}${child.attrs.find((a) => a.name === 'id') ? '#' + child.attrs.find((a) => a.name === 'id').value : ''}`;
      rows.push({ tag: child.tagName, path, node: child, binding: id ? (byId.get(id) ?? null) : null });
      walk(child, path);
      if (child.content) walk(child.content, path + '>#content');
    }
  };
  walk(parse(html), '');
  return rows;
}
function counts(rows) {
  const result = { total: rows.length, literal: 0, derived: 0, platform: 0, none: 0 };
  for (const row of rows) result[row.binding?.mapping ?? 'none'] = (result[row.binding?.mapping ?? 'none'] ?? 0) + 1;
  return result;
}
const unbound = (rows) => rows.filter((row) => !row.binding).map((row) => row.path);
const keyOf = (row) => row.binding?.component?.key;
const attribute = (row, name) => row.node.attrs.find((item) => item.name === name)?.value;

async function examplePortal() {
  return importPortal(example);
}
const exampleRenderer = (portal) =>
  createPortalRenderer(portal, {
    provenance: true,
    renderComponent: async (tag) => {
      throw new Error(`The anonymous example pages render no ${tag} component.`);
    },
  });

for (const route of ['/', '/liquid/data/', '/liquid/views/', '/access-denied/'])
  test(`example page ${route} binds every element to a source or to the platform part that generated it`, async () => {
    const portal = await examplePortal();
    const renderer = exampleRenderer(portal);
    const rendered = await renderer.renderPage(route);
    assert.equal(rendered.status, 200);
    const rows = elements(rendered.html, rendered.provenance);
    assert.deepEqual(unbound(rows), [], `${route} ${JSON.stringify(counts(rows))}`);
    const index = renderer.sourceIndex();
    const byTag = (tag) => rows.filter((row) => row.tag === tag);
    assert.equal(keyOf(byTag('html')[0]), 'platform-shell:document');
    assert.equal(keyOf(byTag('head')[0]), 'platform-shell:head');
    assert.equal(keyOf(byTag('body')[0]), 'platform-shell:body');
    assert.ok(byTag('meta').every((row) => keyOf(row) === 'platform-shell:meta'));
    const title = byTag('title')[0];
    assert.equal(keyOf(title), 'platform-shell:title');
    const page = portal.pages.find((item) => item.url === route);
    const localized = Object.values(page.translations ?? {})[0]?.metadata ?? page.metadata;
    const titleSource = index.source(localized, 'title') ?? index.source(page.metadata, 'title');
    if (titleSource) assert.ok(title.binding.sourceRefIds.includes(titleSource.id), 'title names the page title');
    assert.equal(
      keyOf(rows.find((row) => attribute(row, 'id') === 'offlineNotificationBar')),
      'platform-shell:offline-bar',
    );
    assert.equal(keyOf(rows.find((row) => attribute(row, 'id') === 'antiforgerytoken')), 'platform-shell:antiforgery');
    assert.equal(
      keyOf(rows.find((row) => attribute(row, 'id') === 'pp-native-controls-react-root')),
      'platform-shell:native-controls-root',
    );
    // Stylesheets of exported web files name the web file and its content source.
    const sheets = rows.filter(
      (row) => row.tag === 'link' && portal.webFiles.some((file) => file.url === attribute(row, 'href')),
    );
    assert.ok(sheets.length > 0);
    for (const sheet of sheets) {
      const file = portal.webFiles.find((item) => item.url === attribute(sheet, 'href'));
      assert.equal(keyOf(sheet), `web-file:${file.id}`);
      assert.deepEqual(sheet.binding.sourceRefIds, [index.source({ id: file.id }, '$content').id]);
    }
    // The page copy editable wrappers name the page field they wrap.
    const wrapper = rows.find((row) => /xrm-editable-html/.test(attribute(row, 'class') ?? ''));
    if (wrapper) {
      assert.equal(wrapper.binding.component.kind, 'webpage-field');
      assert.match(keyOf(wrapper), /^webpage:[0-9a-f-]{36}:copy$/);
    }
  });

// An invented portal: a Page.aspx rewrite template, built-in templates, web links, site markers, a site setting with
// markup, snippets (one missing), page CSS/JS and a theme web file.
function inventedPortal() {
  const id = (n) => `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const page = (n, name, url, parentId, extra = {}) => ({
    id: id(n),
    name,
    title: name,
    url,
    parentId,
    pageTemplateId: id(90),
    html: `<p class="copy">${name} copy</p>`,
    css: '',
    js: '',
    summary: '',
    metadata: { id: id(n), kind: 'webpage', name, title: name, adx_title: name },
    ...extra,
  });
  const pages = [
    page(1, 'Home', '/', null),
    page(2, 'Area', '/area/', id(1)),
    page(3, 'Leaf', '/area/leaf/', id(2), {
      css: '.leaf{color:red}',
      js: 'window.leaf = true;',
      metadata: { id: id(3), kind: 'webpage', name: 'Leaf', title: 'Leaf', adx_title: 'Leaf' },
    }),
    page(4, 'Legacy', '/legacy/', id(1), { pageTemplateId: id(91) }),
    page(5, 'Plain', '/plain/', id(1), { pageTemplateId: id(92) }),
  ];
  const layoutSource =
    "{% include 'Breadcrumbs' %}{% include 'Top Navigation' %}<section class=\"body\">{% editable page 'adx_copy' type: 'html', liquid: true %}" +
    "{% editable page 'adx_title' type: 'text', escape: true %}{% editable snippets 'Known' type: 'html' %}" +
    "{% editable snippets 'Missing' type: 'html', default: '<em class=\"default\">Default</em>' %}" +
    '<ul class="links">{% for link in weblinks[\'Primary Navigation\'].weblinks %}<li class="link"><a href="{{ link.url }}">{{ link.name }}</a></li>{% endfor %}</ul>' +
    "<div class=\"marker\">{{ sitemarkers['Home'].url }}</div>{{ settings['Invented/Banner'] }}" +
    '{% for crumb in page.breadcrumbs %}<span class="crumb">{{ crumb.title }}</span>{% endfor %}</section>';
  const link = (n, name, pageId, url) => ({
    id: id(n),
    name,
    title: name,
    url,
    pageId,
    parentId: null,
    setId: id(70),
    displayOrder: n,
    weblinks: [],
    metadata: { id: id(n), kind: 'weblink', name },
  });
  const links = [link(71, 'Home link', id(1), '/'), link(72, 'Area link', id(2), '/area/')];
  const set = {
    id: id(70),
    name: 'Primary Navigation',
    title: 'Primary Navigation',
    copy: null,
    metadata: { id: id(70), kind: 'weblinkset', name: 'Primary Navigation' },
    weblinks: links,
  };
  return {
    sourceDir: null,
    website: { id: id(99), name: 'Invented' },
    pages,
    pageTemplates: [
      {
        id: id(90),
        name: 'Invented layout',
        webTemplateId: id(80),
        useHeaderFooter: true,
        rewriteUrl: null,
        metadata: { id: id(90), kind: 'pagetemplate', name: 'Invented layout' },
      },
      {
        id: id(92),
        name: 'Invented copy layout',
        webTemplateId: null,
        useHeaderFooter: true,
        rewriteUrl: null,
        metadata: { id: id(92), kind: 'pagetemplate', name: 'Invented copy layout' },
      },
      {
        id: id(91),
        name: 'Invented rewrite',
        webTemplateId: null,
        useHeaderFooter: true,
        rewriteUrl: '~/Pages/Page.aspx',
        metadata: { id: id(91), kind: 'pagetemplate', name: 'Invented rewrite', rewriteurl: '~/Pages/Page.aspx' },
      },
    ],
    templates: {
      [id(80)]: {
        id: id(80),
        name: 'Invented layout',
        source: layoutSource,
        metadata: { id: id(80), kind: 'webtemplate', name: 'Invented layout' },
      },
    },
    snippets: { Known: '<strong class="known">Known</strong>' },
    settings: { 'Invented/Banner': '<aside class="banner">Banner</aside>' },
    records: [
      ...pages.map((item) => item.metadata),
      { kind: 'contentsnippet', id: id(60), name: 'Known', value: '<strong class="known">Known</strong>' },
      { kind: 'sitesetting', id: id(61), name: 'Invented/Banner', value: '<aside class="banner">Banner</aside>' },
      { kind: 'sitemarker', id: id(62), name: 'Home', pageid: id(1) },
      set.metadata,
      ...links.map((item) => item.metadata),
      { kind: 'pagetemplate', id: id(90), name: 'Invented layout' },
      { kind: 'pagetemplate', id: id(91), name: 'Invented rewrite', rewriteurl: '~/Pages/Page.aspx' },
    ],
    weblinkSets: [set],
    weblinks: { 'Primary Navigation': set },
    sitemarkers: { Home: { id: id(1), url: '/' } },
    webFiles: [
      {
        id: id(50),
        name: 'theme.css',
        url: '/theme.css',
        metadata: { id: id(50), kind: 'webfile', partialurl: 'theme.css', parentpageid: id(1) },
      },
    ],
    websiteLanguages: [],
    shortcuts: [],
  };
}

test('built-in templates, editable wrappers, data records and page fields bind to what generated them', async () => {
  const portal = inventedPortal();
  const renderer = createPortalRenderer(portal, { provenance: true });
  const index = renderer.sourceIndex();
  const rendered = await renderer.renderPage('/area/leaf/');
  const rows = elements(rendered.html, rendered.provenance);
  assert.deepEqual(unbound(rows), [], JSON.stringify(counts(rows)));
  const record = (n) => index.source({ id: `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}` }, '$record').id;
  const layout = index.templates.get('invented layout').id;
  // Built-in templates: every element they write names the template, in the context of the template that included it.
  const crumbs = rows.filter((row) => row.binding?.component?.kind === 'builtin-template');
  assert.ok(crumbs.some((row) => keyOf(row) === 'builtin-template:breadcrumbs' && row.tag === 'ul'));
  assert.ok(crumbs.some((row) => keyOf(row) === 'builtin-template:top_navigation' && row.tag === 'div'));
  for (const row of crumbs) assert.deepEqual(row.binding.contexts?.[0]?.sourceRefId, layout);
  // A breadcrumb link is generated for its page record.
  const areaCrumb = rows.find(
    (row) => keyOf(row) === 'builtin-template:breadcrumbs' && row.tag === 'a' && attribute(row, 'href') === '/area/',
  );
  assert.ok(areaCrumb, 'breadcrumb link');
  // Editable wrappers: the snippet and the page fields they wrap.
  const known = rows.filter((row) => keyOf(row) === `content-snippet:c0de0000-0000-4000-8000-000000000060`);
  assert.deepEqual(
    known.map((row) => row.tag),
    ['div', 'div'],
  );
  assert.deepEqual(known[0].binding.sourceRefIds, [index.snippet('Known').id]);
  const knownValue = rows.find((row) => attribute(row, 'class') === 'known');
  assert.equal(knownValue.binding.mapping, 'literal');
  assert.equal(knownValue.binding.sourceRefId, index.snippet('Known').id);
  const missing = rows.filter((row) => keyOf(row) === 'content-snippet:name:missing');
  assert.equal(missing.length, 2);
  assert.equal(missing[0].binding.component.missing, true);
  // The default value of a missing snippet is the tag's own: derived from the layout region of the editable tag.
  const defaultValue = rows.find((row) => attribute(row, 'class') === 'default');
  assert.equal(defaultValue.binding.mapping, 'derived');
  assert.deepEqual(defaultValue.binding.sourceRefIds, [layout]);
  const title = rows.filter((row) => keyOf(row) === 'webpage:c0de0000-0000-4000-8000-000000000003:title');
  assert.equal(title.length, 2);
  assert.deepEqual(title[0].binding.sourceRefIds, [index.source(portal.pages[2].metadata, 'title').id]);
  const copy = rows.filter((row) => keyOf(row) === 'webpage:c0de0000-0000-4000-8000-000000000003:copy');
  assert.equal(copy.length, 2);
  // A site setting's markup is literal to the setting value.
  const banner = rows.find((row) => attribute(row, 'class') === 'banner');
  assert.equal(banner.binding.mapping, 'literal');
  assert.equal(banner.binding.sourceRefId, index.source({ id: 'c0de0000-0000-4000-8000-000000000061' }, 'value').id);
  // Page custom CSS and JavaScript wrappers name the page fields.
  const style = rows.find((row) => row.tag === 'style');
  assert.equal(keyOf(style), 'webpage:c0de0000-0000-4000-8000-000000000003:customcss');
  assert.deepEqual(style.binding.sourceRefIds, [index.source(portal.pages[2].metadata, 'customcss').id]);
  const script = rows.find(
    (row) => row.tag === 'script' && !attribute(row, 'src') && row.binding?.component?.kind === 'webpage-field',
  );
  assert.equal(keyOf(script), 'webpage:c0de0000-0000-4000-8000-000000000003:customjavascript');
  // The theme stylesheet names its web file.
  assert.equal(
    keyOf(rows.find((row) => attribute(row, 'href') === '/theme.css')),
    'web-file:c0de0000-0000-4000-8000-000000000050',
  );
  // Data records: the fragment intervals name the record each loop item stands for (recordContexts).
  const traced = await renderer.renderStringWithProvenance(
    portal.templates['c0de0000-0000-4000-8000-000000000080'].source,
    renderer.contextForPage(portal.pages[2], '/area/leaf/'),
    index.templates.get('invented layout'),
  );
  const at = (text, from = 0) => traced.fragment.text.indexOf(text, from);
  const recordsAt = (offset) =>
    traced.fragment.intervals
      .filter((span) => span.start <= offset && span.end > offset)
      .flatMap((span) => (span.recordContexts ?? []).map((item) => item.sourceRefId));
  const firstLink = at('<li class="link">');
  assert.deepEqual(new Set(recordsAt(firstLink)), new Set([record(70), record(71)]));
  assert.deepEqual(new Set(recordsAt(at('<li class="link">', firstLink + 1))), new Set([record(70), record(72)]));
  assert.ok(
    recordsAt(at('/', at('<div class="marker">') + 20)).includes(record(62)),
    'site marker output names the marker',
  );
  assert.ok(recordsAt(at('<span class="crumb">')).includes(record(1)), 'breadcrumb loop names the page record');
  // Built-in breadcrumbs: the platform interval of a crumb link names the crumb's page.
  const crumbLink = traced.fragment.intervals.find(
    (span) =>
      span.mapping === 'platform' &&
      span.tag === 'a' &&
      traced.fragment.text.startsWith('<a href="/area/"', span.start),
  );
  assert.ok(crumbLink.recordContexts.some((item) => item.sourceRefId === record(2)));
});

test('a rewrite page layout binds its markup to the page template record', async () => {
  const portal = inventedPortal();
  const renderer = createPortalRenderer(portal, { provenance: true });
  const index = renderer.sourceIndex();
  const rendered = await renderer.renderPage('/legacy/');
  const rows = elements(rendered.html, rendered.provenance);
  assert.deepEqual(unbound(rows), [], JSON.stringify(counts(rows)));
  const template = rows.filter((row) => keyOf(row) === 'page-template:c0de0000-0000-4000-8000-000000000091');
  assert.ok(template.some((row) => attribute(row, 'class') === 'page-heading'));
  assert.deepEqual(template[0].binding.sourceRefIds, [
    index.source({ id: 'c0de0000-0000-4000-8000-000000000091' }, '$record').id,
  ]);
  // The breadcrumb is the layout's own control, not a template: the page template's markup, like the heading around it.
  const crumbs = rows.find((row) => row.tag === 'ul' && attribute(row, 'class') === 'breadcrumb');
  assert.equal(keyOf(crumbs), 'page-template:c0de0000-0000-4000-8000-000000000091');
  assert.ok(!rows.some((row) => keyOf(row) === 'builtin-template:breadcrumbs'));
  // The built-ins of a rewrite layout are rendered in the page template's context.
  const copyHost = rows.find((row) => keyOf(row) === 'builtin-template:page_copy');
  assert.equal(copyHost.binding.contexts?.[0]?.sourceRefId, template[0].binding.sourceRefIds[0]);
  assert.ok(rows.some((row) => row.tag === 'form' && keyOf(row) === 'platform-shell:webforms-form'));
  // A page without a web template: the default main region and the Page Copy built-in.
  const plain = await renderer.renderPage('/plain/');
  const plainRows = elements(plain.html, plain.provenance);
  assert.deepEqual(unbound(plainRows), [], JSON.stringify(counts(plainRows)));
  assert.equal(keyOf(plainRows.find((row) => row.tag === 'main')), 'platform-shell:main-content');
  const copy = plainRows.find((row) => attribute(row, 'class') === 'copy');
  assert.equal(copy.binding.mapping, 'literal');
  assert.equal(copy.binding.sourceRefId, index.source(portal.pages[4].metadata, 'copy').id);
});

/** The example portal with an invented OpenID Connect provider and external sign-in turned on (records and settings). */
async function signInPortal() {
  const portal = await examplePortal();
  const setting = (n, name, value) => ({
    kind: 'sitesetting',
    id: `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    name,
    value,
  });
  const external = portal.records.find((record) => record.name === 'Authentication/Registration/ExternalLoginEnabled');
  portal.records = [
    ...portal.records.filter((record) => record !== external),
    { ...external, value: 'true', adx_value: 'true' },
    setting(201, 'Authentication/OpenIdConnect/Invented/Authority', 'https://login.invented.invalid/'),
    setting(202, 'Authentication/OpenIdConnect/Invented/Caption', 'Invented directory'),
    setting(203, 'Authentication/OpenIdConnect/Other/Authority', 'https://other.invented.invalid/'),
  ];
  portal.settings = {
    ...portal.settings,
    'Authentication/Registration/ExternalLoginEnabled': 'true',
    'Authentication/OpenIdConnect/Invented/Authority': 'https://login.invented.invalid/',
    'Authentication/OpenIdConnect/Invented/Caption': 'Invented directory',
    'Authentication/OpenIdConnect/Other/Authority': 'https://other.invented.invalid/',
  };
  return portal;
}

test('the sign-in page binds each provider tile, local sign-in and account tab to the settings that configure it', async () => {
  const portal = await signInPortal();
  const base = exampleRenderer(portal);
  const index = base.sourceIndex();
  // The exported sign-in page copy (here the Approach page's, which has no Liquid) is embedded literally.
  const exported = portal.pages.find((item) => item.url === '/approach/');
  const page = {
    id: 'paqvilo-mirage-sign-in',
    outsideSitemap: true,
    name: 'Sign in',
    title: 'Sign in',
    url: '/SignIn/',
    parentId: null,
    pageTemplateId: null,
    html: exported.html + MARKER,
    css: '',
    js: '',
    summary: '',
    metadata: { adx_copy: exported.html + MARKER },
  };
  const renderer = createPortalRenderer({ ...portal, pages: [page, ...portal.pages] }, { provenance: false });
  const rendered = await renderer.renderPage('/SignIn/');
  const providers = externalProviders(portal);
  assert.deepEqual(
    providers.map((provider) => provider.key),
    ['Invented', 'Other'],
  );
  const content = (copy) =>
    signInContent({
      copy,
      providers,
      registerTab: true,
      redeemTab: true,
      personas: [{ contactId: 'invented', name: 'Invented persona' }],
    });
  const copySource = index.source(exported.metadata, 'copy');
  const edits = accountPageEdits(rendered.html, content, {
    marker: MARKER,
    contentPlatform: signInPartTags({ portal, index, providers }),
    resourcePlatform: shellTags(portal, index, null),
    copySourceRefId: copySource.id,
    copySource,
  });
  const html = applyMarkupEdits(rendered.html, edits);
  assert.match(html, /Invented persona/);
  const traced = renderer.provenanceForEdited(rendered, edits);
  assert.equal(traced.html.replaceAll(/ data-paqvilo-source="[^"]*"/g, ''), html, 'stamps are the only change');
  const rows = elements(traced.html, traced.provenance);
  assert.deepEqual(unbound(rows), [], JSON.stringify(counts(rows)));
  const refs = new Map(traced.provenance.sourceRefs.map((ref) => [ref.id, ref]));
  const settingsOf = (row) => row.binding.sourceRefIds.map((id) => refs.get(id)?.name).sort();
  const parts = (key) => rows.filter((row) => keyOf(row) === key);
  // A provider tile: that provider's settings and the external sign-in switch, never another provider's.
  const tile = rows.find(
    (row) => row.tag === 'button' && attribute(row, 'value') === 'https://login.invented.invalid/',
  );
  assert.equal(keyOf(tile), 'platform-shell:sign-in#provider:oidc-invented');
  assert.deepEqual(settingsOf(tile), [
    'Authentication/OpenIdConnect/Invented/Authority',
    'Authentication/OpenIdConnect/Invented/Caption',
    'Authentication/Registration/ExternalLoginEnabled',
  ]);
  const other = rows.find(
    (row) => row.tag === 'button' && attribute(row, 'value') === 'https://other.invented.invalid/',
  );
  assert.deepEqual(settingsOf(other), [
    'Authentication/OpenIdConnect/Other/Authority',
    'Authentication/Registration/ExternalLoginEnabled',
  ]);
  // The external sign-in form around the tiles, the local sign-in, registration and invitation parts.
  const form = rows.find((row) => row.tag === 'form' && /ExternalLogin/.test(attribute(row, 'action') ?? ''));
  assert.equal(keyOf(form), 'platform-shell:sign-in#external-login');
  assert.deepEqual(settingsOf(form), ['Authentication/Registration/ExternalLoginEnabled']);
  const local = parts('platform-shell:sign-in#local-sign-in');
  assert.ok(local.some((row) => row.tag === 'button' && attribute(row, 'value') === 'invented'));
  for (const row of local) assert.deepEqual(settingsOf(row), ['Authentication/Registration/LocalLoginEnabled']);
  const register = parts('platform-shell:sign-in#registration');
  assert.deepEqual(
    register.map((row) => row.tag),
    ['li', 'a'],
  );
  assert.deepEqual(settingsOf(register[0]), ['Authentication/Registration/Enabled']);
  const invitation = parts('platform-shell:sign-in#invitation');
  assert.ok(invitation.some((row) => row.tag === 'a' && /^\/Register\?/.test(attribute(row, 'href') ?? '')));
  for (const row of invitation) assert.deepEqual(settingsOf(row), ['Authentication/Registration/Enabled']);
  // The account layout itself, with no setting.
  const container = rows.find((row) => attribute(row, 'id') === 'content-container');
  assert.equal(keyOf(container), 'platform-shell:sign-in');
  assert.deepEqual(container.binding.sourceRefIds, []);
  // The embedded page copy is the exported copy's own text: literal, with its region.
  const kicker = rows.find((row) => attribute(row, 'class') === 'demo-kicker');
  assert.equal(kicker.binding.mapping, 'literal');
  assert.equal(kicker.binding.sourceRefId, copySource.id);
  assert.equal(
    copySource.text.slice(kicker.binding.region.start, kicker.binding.region.end),
    '<p class="demo-kicker">',
  );
  // The exported header and footer keep their template sources.
  const header = index.templates.get(String(portal.website.headerwebtemplateid ?? '').toLowerCase())?.id;
  if (header) assert.ok(rows.some((row) => row.binding?.sourceRefId === header));
});

test('an embedded sign-in page copy with Liquid is derived from the whole exported copy', () => {
  const copySource = { id: 'copy', text: '<p class="x">{{ page.title }}</p>\n' };
  const html = `<!DOCTYPE html><html><head></head><body><main id="mainContent"><div class="xrm-attribute-value"><p class="x">Rendered</p>${MARKER}</div></main></body></html>`;
  const [edit] = accountPageEdits(html, (copy) => `<section>${copy}</section>`, {
    marker: MARKER,
    contentPlatform: { component: { kind: 'platform-shell', key: 'platform-shell:sign-in' } },
    resourcePlatform: { component: { kind: 'platform-shell', key: 'platform-shell:runtime-style' } },
    copySourceRefId: 'copy',
    copySource,
  });
  const copy = edit.intervals.find((span) => span.sourceRefId === 'copy');
  assert.equal(copy.mapping, 'derived');
  assert.deepEqual(copy.sourceSpan, { start: 0, end: copySource.text.length }, 'derived with the copy as its region');
  assert.equal(edit.text.slice(copy.start, copy.end), '<p class="x">Rendered</p>');
});

test('the default search page and other runtime documents are bound to their platform part', async () => {
  const portal = { ...(await examplePortal()) };
  portal.settings = { ...portal.settings, 'Search/Enabled': 'false' };
  const index = buildPortalSourceIndex({ portal });
  const html = await renderPortalSearchPage({ portal, params: new URLSearchParams('q=x') });
  const traced = finalizePortalProvenance({
    fragment: platformDocumentFragment(html, { portal, index, part: 'search-page' }),
    index,
  });
  assert.equal(traced.html.replaceAll(/ data-paqvilo-source="[^"]*"/g, ''), html);
  const rows = elements(traced.html, traced.provenance);
  assert.deepEqual(unbound(rows), []);
  assert.equal(keyOf(rows.find((row) => row.tag === 'form')), 'platform-shell:search-page');
  assert.equal(keyOf(rows.find((row) => row.tag === 'title')), 'platform-shell:title');
});

test('an observed header notification and footer logo keep the exported header and footer bound', async () => {
  registerShellConventions('render-provenance-coverage', {
    footerLogoClass: 'invented-logos',
    headerNotificationQuery: 'Invented notices',
  });
  const origin = 'https://invented.invalid';
  const headerSource =
    '<header class="site"><ul class="nav"><li class="userProfileHolder">Profile</li><li class="after">After</li></ul></header>';
  const footerSource =
    '<footer class="site"><div class="invented-logos"><img src="/old.png" alt="old"></div><p class="tail">Tail</p></footer>';
  const portal = inventedPortal();
  portal.website = { ...portal.website, adx_headerwebtemplateid: 'header', adx_footerwebtemplateid: 'footer' };
  Object.assign(portal.templates, {
    header: {
      id: 'header',
      name: 'Header',
      source: headerSource,
      metadata: { id: 'header', kind: 'webtemplate', name: 'Header' },
    },
    footer: {
      id: 'footer',
      name: 'Footer',
      source: footerSource,
      metadata: { id: 'footer', kind: 'webtemplate', name: 'Footer' },
    },
    'Invented notices': {
      id: 'notices',
      name: 'Invented notices',
      source: '{"notifications":[{"visible":true,"notificationText":"Invented notice","severity":"info"}]}',
      metadata: { id: 'notices', kind: 'webtemplate', name: 'Invented notices' },
    },
  });
  const shellProfile = {
    headerNotifications: observedHeaderNotifications(
      '<li class="userProfileHolder"><a href="#"><svg><path d="M0 0"/></svg><span class="notificationsCount">9</span></a></li>',
      { headerSource, origin },
    ),
    footerLogos: observedFooterLogos(
      '<footer><div class="invented-logos"><img src="/new-a.png" alt="a"><img src="/new-b.png" alt="b"></div></footer>',
      { footerSource, origin },
    ),
  };
  const renderer = createPortalRenderer(portal, { provenance: true, shellProfile, observationOrigin: origin });
  const index = renderer.sourceIndex();
  const rendered = await renderer.renderPage('/area/', { user: { id: 'invented-user', roles: [] } });
  assert.match(rendered.html, /Invented notice/);
  assert.match(rendered.html, /new-b\.png/);
  const rows = elements(rendered.html, rendered.provenance);
  assert.deepEqual(unbound(rows), [], JSON.stringify(counts(rows)));
  const literalTo = (template, predicate) => {
    const row = rows.find(predicate);
    assert.ok(row, 'element present');
    assert.equal(row.binding.mapping, 'literal', row.path);
    assert.equal(row.binding.sourceRefId, index.templates.get(template).id);
  };
  literalTo('header', (row) => row.tag === 'header');
  literalTo('header', (row) => attribute(row, 'class') === 'nav');
  literalTo('header', (row) => attribute(row, 'class') === 'after');
  literalTo('footer', (row) => row.tag === 'footer');
  literalTo('footer', (row) => attribute(row, 'class') === 'invented-logos');
  literalTo('footer', (row) => attribute(row, 'class') === 'tail');
  assert.ok(rows.some((row) => keyOf(row) === 'platform-shell:observed-header-notifications'));
  const logos = rows.filter((row) => /new-[ab]\.png/.test(attribute(row, 'src') ?? ''));
  assert.deepEqual(logos.map(keyOf), ['platform-shell:observed-footer-logos', 'platform-shell:observed-footer-logos']);
});

test('host edits of a rendered header keep every interval outside the edited region', () => {
  // An observed notification inserted before an existing item, and a footer logo replaced: the unchanged markup on
  // both sides keeps its literal spans, and the inserted markup never takes over the start of the next element.
  const span = (text) => ({
    text,
    intervals: [
      {
        start: 0,
        end: text.length,
        sourceRefId: 'header',
        sourceSpan: { start: 0, end: text.length },
        mapping: 'literal',
      },
    ],
  });
  const header = span('<ul class="nav"><li class="dropdown">Me</li></ul>');
  const inserted = header.text.replace('<li class="dropdown">', '<li class="notes"><b>2</b></li><li class="dropdown">');
  const edit = markupEdit(header.text, inserted);
  assert.equal(edit.text, '<li class="notes"><b>2</b></li>');
  const result = applyRenderEdits(header, [edit]);
  assert.equal(result.text, inserted);
  const literal = (tag) => {
    const start = inserted.indexOf(tag);
    return result.intervals.some(
      (item) => item.start <= start && item.end >= start + tag.length && item.mapping === 'literal',
    );
  };
  assert.ok(literal('<ul class="nav">') && literal('<li class="dropdown">'), 'both sides keep their spans');
  assert.equal(literal('<li class="notes">'), false);
  const footer = span('<footer><div class="logos"><img src="/a.png"></div><p>tail</p></footer>');
  const replaced = footer.text.replace('<img src="/a.png">', '<img src="/b.png"><img src="/c.png">');
  const footerEdit = markupEdit(footer.text, replaced);
  assert.equal(footerEdit.text, '<img src="/b.png"><img src="/c.png">');
  const footerResult = applyRenderEdits(footer, [footerEdit]);
  const tail = replaced.indexOf('<p>');
  assert.ok(footerResult.intervals.some((item) => item.start <= tail && item.end >= tail + 3));
  assert.ok(
    footerResult.intervals.some((item) => item.start === 0 && item.end >= '<footer><div class="logos">'.length),
  );
});

test('local compatibility adapters are inserted as precise edits with identical output', () => {
  const html =
    '<!DOCTYPE html><html><head><script src="/jquery-3.7.1.min.js"></script></head><body><footer>f</footer></body></html>';
  const dependencies = { bootstrapPlugins: true, footerSpacing: true };
  const output = injectRuntimeCompatibility(html, dependencies);
  assert.notEqual(output, html);
  assert.match(
    output,
    /jquery-3\.7\.1\.min\.js"><\/script><script src="\/__sim-static\/vendor\/bootstrap-plugins-compat\.js">/,
  );
  assert.match(output, /<script src="\/__sim-static\/vendor\/footer-spacing-compat\.js"><\/script><\/body>/);
});

test('Liquid code that writes markup names its own token, and literal text keeps exact spans after whitespace control', async () => {
  const Main =
    "<p>{{ '<b>lit</b>' }}</p>{% assign h = '<i>x</i>' %}{{ h | replace: 'x', 'y' }}{% for n in (1..2) %}<s class=\"{% cycle 'a','b' %}\">{% increment c %}</s>{% endfor %}" +
    "{{ snippets['Frag'] | liquid }}<q>literal -}} text</q><var>after</var>";
  const portal = {
    sourceDir: null,
    website: {},
    pages: [],
    templates: {
      Main: { id: 'main', name: 'Main', source: Main, metadata: { id: 'main', kind: 'webtemplate', name: 'Main' } },
    },
    snippets: { Frag: '<mark>{{ 1 | plus: 1 }}</mark>' },
    records: [{ kind: 'contentsnippet', id: 'frag', name: 'Frag', value: '<mark>{{ 1 | plus: 1 }}</mark>' }],
  };
  const renderer = createPortalRenderer(portal);
  const index = renderer.sourceIndex();
  const result = await renderer.renderStringWithProvenance(
    Main,
    renderer.contextForPage({ id: 'home', url: '/', metadata: {} }, '/'),
    index.templates.get('main'),
  );
  // DotLiquid's whitespace-control pass rewrites the literal text (output unchanged); the spans stay exact.
  assert.match(result.fragment.text, /<q>literal }}text<\/q><var>after<\/var>$/);
  for (const span of result.fragment.intervals) {
    assert.ok(span.sourceSpan, `interval at ${span.start} names a source span`);
    const sourceText = index.sources.get(span.sourceRefId).text.slice(span.sourceSpan.start, span.sourceSpan.end);
    if (span.mapping === 'literal') assert.equal(sourceText, result.fragment.text.slice(span.start, span.end));
    if (span.mapping === 'derived') assert.match(sourceText, /^\{[{%][\s\S]*[}%]\}$/, 'derived output names its token');
  }
  const bindings = new Map(result.provenance.bindings.map((binding) => [binding.tag, binding]));
  assert.equal(bindings.get('var').mapping, 'literal');
  assert.equal(bindings.get('q').mapping, 'literal');
  // | liquid over a snippet's text renders as that snippet: its markup is literal to the snippet.
  assert.equal(bindings.get('mark').sourceRefId, index.snippet('Frag').id);
});

test('record contexts reach literal markup rendered for a loop item through the engine', async () => {
  const source = '{% for item in items %}<li>{{ item.name }}</li>{% endfor %}';
  const portal = {
    sourceDir: null,
    templates: {
      Main: { id: 'main', name: 'Main', source, metadata: { id: 'main', kind: 'webtemplate', name: 'Main' } },
    },
    records: [],
    pages: [],
    snippets: {},
  };
  const index = buildPortalSourceIndex({ portal });
  const engine = new LiquidEngine({});
  const { setRecordSources } = await import('../lib/render-provenance.mjs');
  const items = [{ name: 'one' }, { name: 'two' }];
  setRecordSources(items[0], [{ sourceRefId: 'record-one' }]);
  const context = new LiquidContext(engine, { environment: { items } });
  context.provenance = createRenderTrace({ sourceRevision: index.sourceRevision });
  const buffer = createRenderBuffer(context);
  await engine.parse(source, index.templates.get('main')).renderInto(context, buffer);
  const fragment = renderFragment(buffer);
  const first = fragment.intervals.filter((span) => span.start < fragment.text.indexOf('</li>'));
  assert.ok(first.every((span) => span.recordContexts?.[0]?.sourceRefId === 'record-one'));
  const second = fragment.intervals.filter((span) => span.start > fragment.text.indexOf('</li>') + 5);
  assert.ok(second.every((span) => !span.recordContexts));
});

test('shortcuts, web roles, ads and polls are data records the output they render names (item D)', async () => {
  const id = (n) => `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const portal = inventedPortal();
  portal.shortcuts = [
    {
      id: id(40),
      name: 'Invented shortcut',
      title: 'Shortcut title',
      url: '/area/',
      parentId: id(1),
      targetPageId: id(2),
      displayOrder: 9,
      metadata: { id: id(40), kind: 'shortcut', name: 'Invented shortcut' },
    },
  ];
  portal.records.push(
    { kind: 'shortcut', id: id(40), name: 'Invented shortcut', webpageid: id(2) },
    { kind: 'webrole', id: id(41), name: 'Invented role', statecode: 0 },
    { kind: 'adplacement', id: id(42), name: 'Invented placement', adx_adplacement_ad: [id(43)] },
    { kind: 'ad', id: id(43), name: 'Invented ad', adx_title: 'Invented ad title', adx_copy: 'Ad copy' },
    { kind: 'poll', id: id(44), name: 'Invented poll', adx_question: 'Invented question?' },
    { kind: 'polloption', id: id(45), name: 'Yes', adx_pollid: id(44), adx_answer: 'Yes' },
  );
  const renderer = createPortalRenderer(portal);
  const index = renderer.sourceIndex();
  const keyOfSource = (sourceRefId) => index.sources.get(sourceRefId)?.componentKey;
  // Each record kind is one source of the index, named by its component key.
  for (const [n, key] of [
    [40, 'shortcut'],
    [41, 'web-role'],
    [42, 'ad-placement'],
    [43, 'ad'],
    [44, 'poll'],
    [45, 'poll-option'],
  ]) {
    const source = index.source({ id: id(n) }, '$record');
    assert.equal(source?.componentKey, `${key}:${id(n)}`);
    assert.equal(source.relationship, 'data-record');
  }
  const source =
    '{% for child in sitemap.root.children %}<li class="child">{{ child.title }}</li>{% endfor %}' +
    '{% for role in user.adx_webrole_contact %}<span class="role">{{ role.adx_name }}</span>{% endfor %}' +
    "{% assign ad_name = 'Invented ad' %}{% mirage_ad %}{% assign poll_name = 'Invented poll' %}{% mirage_poll %}";
  const page = portal.pages[0];
  const result = await renderer.renderStringWithProvenance(
    source,
    renderer.contextForPage(page, '/', { user: { id: 'invented-user', roles: ['Invented role'] } }),
    index.templates.get('invented layout'),
  );
  const text = result.fragment.text;
  const recordsAt = (offset) =>
    result.fragment.intervals
      .filter((span) => span.start <= offset && span.end > offset)
      .flatMap((span) => (span.recordContexts ?? []).map((item) => keyOfSource(item.sourceRefId)));
  assert.ok(recordsAt(text.indexOf('Shortcut title')).includes(`shortcut:${id(40)}`), 'the shortcut child');
  assert.ok(recordsAt(text.indexOf('Shortcut title')).includes(`webpage:${id(2)}`), 'and its target page');
  assert.ok(recordsAt(text.indexOf('Invented role')).includes(`web-role:${id(41)}`), 'the web role');
  // The ad and poll views are the platform's: their elements name the ad and the poll records.
  const contexts = (predicate) =>
    result.provenance.bindings
      .filter(predicate)
      .flatMap((binding) => (binding.contexts ?? []).map((item) => keyOfSource(item.sourceRefId)));
  assert.ok(
    contexts((binding) => binding.component?.key === 'builtin-template:ad').includes(`ad:${id(43)}`),
    'the ad view names the ad',
  );
  assert.ok(
    contexts((binding) => binding.component?.key === 'builtin-template:poll').includes(`poll:${id(44)}`),
    'the poll view names the poll',
  );
});

test('a Head/Bootstrap snippet is linked literally from the snippet, with its markup unchanged', async () => {
  const portal = inventedPortal();
  const markup = '<link rel="stylesheet" href="/invented-bootstrap.css">';
  portal.snippets['Head/Bootstrap'] = markup;
  portal.records.push({
    kind: 'contentsnippet',
    id: 'c0de0000-0000-4000-8000-000000000063',
    name: 'Head/Bootstrap',
    value: markup,
  });
  const renderer = createPortalRenderer(portal, { provenance: true });
  const plain = await createPortalRenderer(portal).renderPage('/area/');
  const rendered = await renderer.renderPage('/area/');
  assert.equal(rendered.html.replaceAll(/ data-paqvilo-source="[^"]*"/g, ''), plain.html, 'stamps are the only change');
  const rows = elements(rendered.html, rendered.provenance);
  assert.deepEqual(unbound(rows), [], JSON.stringify(counts(rows)));
  const link = rows.find((row) => attribute(row, 'href') === '/invented-bootstrap.css');
  assert.equal(link.binding.mapping, 'literal');
  assert.equal(link.binding.sourceRefId, renderer.sourceIndex().snippet('Head/Bootstrap').id);
  assert.deepEqual([link.binding.region.start, link.binding.region.end], [0, markup.length]);
});

test('SVG elements whose names parse5 case-adjusts bind in platform and served regions (item G)', () => {
  const svg =
    '<svg viewBox="0 0 10 10"><foreignObject width="10" height="10"><div class="inside">x</div></foreignObject><linearGradient id="g"></linearGradient></svg>';
  const portal = {
    sourceDir: null,
    records: [{ kind: 'contentsnippet', id: 'svg', name: 'Svg', value: svg }],
    pages: [],
    templates: {},
    snippets: { Svg: svg },
  };
  const index = buildPortalSourceIndex({ portal });
  const shell = (body) => `<!DOCTYPE html><html><head></head><body>${body}</body></html>`;
  // A platform region: every element of the SVG is the platform part that wrote it.
  const platform = finalizePortalProvenance({
    fragment: platformDocumentFragment(shell(svg), { portal, index, part: 'search-page' }),
    index,
  });
  const platformRows = elements(platform.html, platform.provenance);
  assert.deepEqual(unbound(platformRows), []);
  const foreign = platformRows.find((row) => row.tag === 'foreignObject');
  assert.equal(keyOf(foreign), 'platform-shell:search-page');
  assert.equal(keyOf(platformRows.find((row) => row.tag === 'linearGradient')), 'platform-shell:search-page');
  // A served region: the start tags a caller aligned with the snippet (lowercase names, as the tokenizer reads them).
  const html = shell(svg);
  const at = html.indexOf(svg);
  const source = index.source({ id: 'svg' }, 'value');
  const tagBindings = new Map(
    scanStartTags(svg).map((tag) => [
      at + tag.start,
      {
        end: at + tag.end,
        tag: tag.tag,
        mapping: 'aligned',
        sourceRefId: source.id,
        region: { start: tag.start, end: tag.end },
      },
    ]),
  );
  const served = finalizePortalProvenance({
    fragment: { text: html, intervals: [] },
    index,
    channel: 'lense-served',
    tagBindings,
  });
  const servedRows = elements(served.html, served.provenance).filter((row) => /svg|foreign|div|linear/i.test(row.tag));
  assert.equal(servedRows.length, 4);
  for (const row of servedRows) {
    assert.equal(row.binding?.mapping, 'literal', row.path);
    assert.equal(row.binding.sourceRefId, source.id);
  }
  assert.equal(served.html.replaceAll(/ data-paqvilo-source="[^"]*"/g, ''), html);
});
