// @test-kind observation: hosted session F3 (two agreeing runs, D:\Repos\paqvilo-developer\hosted-f3 evidence summary-F3.md) captured these page, CMS, cache and PWA answers once per run; invented sites replay them locally.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture, makeTemporaryDirectory, assertTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { observedPageErrorResponse } from '../lib/page-error-presentation.mjs';
import { pwaShellMarkup } from '../lib/platform-manifest.mjs';

// The service worker URL an enabled PWAFeature registers for the website, as its shell markup names it.
const pwaServiceWorkerUrl = (websiteId) =>
  /navigator\.serviceWorker\.register\('([^']+)'/.exec(pwaShellMarkup('{"status":"enable"}', websiteId).body)[1];
// The server log an evidenced error page hands the dev tools (its updateDevToolRuntime event detail).
const devToolServerLog = (options) =>
  JSON.parse(
    /detail: ([\s\S]*?)\r\n\t\t\t\}\)\);/.exec(observedPageErrorResponse({ method: 'GET', ...options }).body)[1],
  );

const EDITOR_ROLE = 'aaaaaaaa-0000-4000-8000-0000000000e1';
const PREVIEW_ROLE = 'aaaaaaaa-0000-4000-8000-0000000000e2';
const DRAFT = 'aaaaaaaa-0000-4000-8000-0000000000d1';
const editor = { id: 'invented-editor', contactId: 'invented-editor', roles: ['Invented Editors'] };
const previewer = { id: 'invented-previewer', contactId: 'invented-previewer', roles: ['Invented Previewers'] };
const visitor = { id: 'invented-visitor', contactId: 'invented-visitor', roles: [] };

function site({ format = 'standard', rewriteUrl = null, header = '', footer = '', settings = {}, pages } = {}) {
  return {
    format,
    website: { id: 'invented-site', adx_headerwebtemplateid: 'header', adx_footerwebtemplateid: 'footer' },
    settings,
    snippets: { 'Invented/Snippet': '<p>snippet html</p>' },
    records: [
      { kind: 'webrole', id: EDITOR_ROLE, name: 'Invented Editors', metadata: {} },
      { kind: 'webrole', id: PREVIEW_ROLE, name: 'Invented Previewers', metadata: {} },
      // The editing right on web pages: a Grant Change rule on the home page (and its children).
      {
        kind: 'webpageaccesscontrolrule',
        id: 'aaaaaaaa-0000-4000-8000-0000000000f1',
        adx_webpageid: 'home',
        adx_right: 1,
        adx_scope: 1,
        adx_webpageaccesscontrolrule_webrole: [EDITOR_ROLE],
      },
      {
        kind: 'contentsnippet',
        id: 'aaaaaaaa-0000-4000-8000-0000000000c1',
        name: 'Invented/Snippet',
        adx_contentsnippetlanguageid: 'aaaaaaaa-0000-4000-8000-0000000000a1',
      },
    ],
    websiteLanguages: [
      { id: 'aaaaaaaa-0000-4000-8000-0000000000a1', code: 'en-US', displayName: 'English', isDefault: true },
    ],
    websiteAccess: [
      { id: 'access', roleIds: [EDITOR_ROLE], manageContentSnippets: true, previewUnpublishedEntities: true },
      { id: 'preview-only', roleIds: [PREVIEW_ROLE], previewUnpublishedEntities: true },
    ],
    publishingStates: [{ id: DRAFT, name: 'Draft', isVisible: false }],
    webFiles: [],
    weblinks: {},
    weblinkSets: [],
    sitemarkers: {},
    pages: pages ?? [
      {
        id: 'home',
        name: 'Home',
        title: 'Home',
        url: '/',
        pageTemplateId: 'layout',
        html: '<p>copy text</p>',
        metadata: {},
      },
      {
        id: 'other',
        parentId: 'home',
        name: 'Other',
        title: 'Other',
        url: '/other/',
        pageTemplateId: 'layout',
        html: '<p>other copy</p>',
        metadata: {},
      },
    ],
    pageTemplates: [
      {
        id: 'layout',
        name: 'Invented layout',
        webTemplateId: rewriteUrl ? null : 'body',
        rewriteUrl,
        metadata: { mspp_type: rewriteUrl ? 756150000 : 756150001 },
      },
    ],
    templates: {
      body: { id: 'body', name: 'Body', source: '{{ page.copy }}', metadata: {} },
      header: { id: 'header', name: 'Header', source: header, metadata: {} },
      footer: { id: 'footer', name: 'Footer', source: footer, metadata: {} },
    },
  };
}

const wrapperSource =
  "{% editable page 'adx_copy' type: 'html' %}|{% editable page 'adx_title' tag: 'h2' %}|" +
  "{% editable snippets 'Invented/Snippet' type: 'html' %}|{% editable snippets 'Invented/Missing' default: 'invented fallback' %}|" +
  "{% editable page 'adx_copy' type: 'html', liquid: true, class: 'invented-class', escape: false %}|" +
  '{{ page.editable }}|{{ snippets.editable }}';

async function wrappers(user) {
  const portal = site();
  portal.templates.body.source = '<x-wrappers>' + wrapperSource + '</x-wrappers>';
  const rendered = await createPortalRenderer(portal).renderPage('/', user ? { user } : {});
  const start = rendered.html.indexOf('<x-wrappers>') + '<x-wrappers>'.length;
  return rendered.html.slice(start, rendered.html.indexOf('</x-wrappers>', start)).split('|');
}

test('PAGE-05b: anonymous editable wrappers carry the lowercase language context and no editor metadata', async () => {
  assert.deepEqual(await wrappers(null), [
    '<div class="xrm-editable-html&#32;xrm-attribute"><div class="xrm-attribute-value"><p>copy text</p></div></div>',
    '<h2 class="xrm-editable-html&#32;xrm-attribute"><h2 class="xrm-attribute-value">Home</h2></h2>',
    '<div class="xrm-editable-html&#32;xrm-attribute" data-languagecontext="English"><div class="xrm-attribute-value"><p>snippet html</p></div></div>',
    '<div class="xrm-editable-html&#32;xrm-attribute"><div class="xrm-attribute-value">invented fallback</div></div>',
    '<div class="xrm-editable-html&#32;xrm-attribute&#32;invented-class"><div class="xrm-attribute-value"><p>copy text</p></div></div>',
    'false',
    'false',
  ]);
});

// @test-kind observation+security: hosted session F3 captured the administrator's wrappers; the editing rights that unlock them (Grant Change, Manage Content Snippets) are the export's, and a preview-only role must not get them.
test('PAGE-05b: a content editor adds only data-encoded, data-liquid and the missing snippet default', async () => {
  const html = await wrappers(editor);
  assert.deepEqual(html, [
    '<div class="xrm-editable-html&#32;xrm-attribute" data-encoded="false" data-liquid="true"><div class="xrm-attribute-value"><p>copy text</p></div></div>',
    '<h2 class="xrm-editable-html&#32;xrm-attribute" data-encoded="false" data-liquid="true"><h2 class="xrm-attribute-value">Home</h2></h2>',
    '<div class="xrm-editable-html&#32;xrm-attribute" data-encoded="false" data-languagecontext="English" data-liquid="true"><div class="xrm-attribute-value"><p>snippet html</p></div></div>',
    '<div class="xrm-editable-html&#32;xrm-attribute" data-default="invented&#32;fallback" data-encoded="false" data-languagecontext="English" data-liquid="true"><div class="xrm-attribute-value">invented fallback</div></div>',
    '<div class="xrm-editable-html&#32;xrm-attribute&#32;invented-class" data-encoded="false" data-liquid="true"><div class="xrm-attribute-value"><p>copy text</p></div></div>',
    'true',
    'true',
  ]);
  assert.doesNotMatch(html.join(''), /data-cms|data-editable-url|data-filebrowser|_services\/portal/);
  // A signed-in visitor without an editing right, or with only Preview Unpublished Entities, edits nothing: the
  // wrappers are the anonymous ones.
  const anonymous = await wrappers(null);
  assert.deepEqual(await wrappers(visitor), anonymous);
  assert.deepEqual(await wrappers(previewer), anonymous);
});

// @test-kind security: each editable object reads its own editing right and fails closed without it (inferred from the classic portal's permissions; F3 observed an administrator holding both).
test('PAGE-05b: page and snippet editing rights are separate', async () => {
  const pageOnly = site();
  pageOnly.websiteAccess[0].manageContentSnippets = false;
  pageOnly.templates.body.source = '[{{ page.editable }}|{{ snippets.editable }}]';
  assert.match((await createPortalRenderer(pageOnly).renderPage('/', { user: editor })).html, /\[true\|false\]/);
  const snippetsOnly = site();
  snippetsOnly.records = snippetsOnly.records.filter((record) => record.kind !== 'webpageaccesscontrolrule');
  snippetsOnly.templates.body.source = '[{{ page.editable }}|{{ snippets.editable }}]';
  assert.match((await createPortalRenderer(snippetsOnly).renderPage('/', { user: editor })).html, /\[false\|true\]/);
  // A snippet named editable keeps its value (F3 has no such snippet).
  const named = site();
  named.snippets.editable = 'authored value';
  named.templates.body.source = '[{{ snippets.editable }}]';
  assert.match((await createPortalRenderer(named).renderPage('/', { user: editor })).html, /\[authored value\]/);
});

test('renderString without a snippets object reads the snippets of the context language', async () => {
  const portal = site();
  portal.snippetTranslations = { 'aaaaaaaa-0000-4000-8000-0000000000a2': { 'Invented/Snippet': 'texte français' } };
  const renderer = createPortalRenderer(portal);
  assert.equal(await renderer.renderString("{{ snippets['Invented/Snippet'] }}"), '<p>snippet html</p>');
  assert.equal(
    await renderer.renderString("{{ snippets['Invented/Snippet'] }}", {
      __language: { id: 'aaaaaaaa-0000-4000-8000-0000000000a2' },
    }),
    'texte français',
  );
});

test('PAGE-05b: {% editable %} of a web link set writes nothing, also for a content editor', async () => {
  const portal = site();
  portal.websiteAccess[0].manageWebLinkSets = true;
  portal.weblinkSets = [{ id: 'aaaaaaaa-0000-4000-8000-0000000000b1', name: 'Default', weblinks: [], metadata: {} }];
  portal.templates.body.source = "{% assign nav = weblinks['Default'] %}[{% editable nav %}|{{ nav.editable }}]";
  const renderer = createPortalRenderer(portal);
  assert.match((await renderer.renderPage('/')).html, /\[\|false\]/);
  assert.match((await renderer.renderPage('/', { user: editor })).html, /\[\|true\]/);
});

test('AUTH-07e: page.parent passes the access check: empty for anonymous under a draft parent, set for an editor', async () => {
  const portal = site();
  portal.pages[0].metadata = { adx_publishingstateid: DRAFT };
  portal.templates.body.source = '[{{ page.parent.title }}]';
  const renderer = createPortalRenderer(portal);
  assert.match((await renderer.renderPage('/other/')).html, /\[\]/);
  assert.match((await renderer.renderPage('/other/', { user: editor })).html, /\[Home\]/);
  portal.pages[0].metadata = {};
  assert.match((await createPortalRenderer(portal).renderPage('/other/')).html, /\[Home\]/);
});

// @test-kind unproven+security: page.breadcrumbs is not captured; it fails closed with the access check page.parent uses.
test('page.breadcrumbs leaves out an ancestor the visitor may not read', async () => {
  const portal = site();
  portal.pages[0].metadata = { adx_publishingstateid: DRAFT };
  portal.templates.body.source = '[{% for crumb in page.breadcrumbs %}{{ crumb.title }};{% endfor %}]';
  const renderer = createPortalRenderer(portal);
  assert.match((await renderer.renderPage('/other/')).html, /\[\]/);
  assert.match((await renderer.renderPage('/other/', { user: previewer })).html, /\[Home;\]/);
});

test('PAGE-03c: enhanced Page.aspx and Listing.aspx fail on the missing adx_webpage table; other ASPX pages have no handler', async () => {
  for (const rewriteUrl of ['~/Pages/Page.aspx', '~/Pages/Listing.aspx']) {
    const rendered = await createPortalRenderer(site({ format: 'enhanced', rewriteUrl })).renderPage('/');
    assert.equal(rendered.status, 500);
    assert.equal(rendered.failure.code, 'REWRITE_LAYOUT_TABLE_MISSING');
    assert.equal(rendered.failure.dataverse, true);
    assert.match(
      rendered.failure.message,
      /'adx_webpage' with namemapping = 'Logical' was not found in the MetadataCache/,
    );
    // The standard model keeps the layout (only the enhanced model was captured).
    assert.equal((await createPortalRenderer(site({ rewriteUrl })).renderPage('/')).status, 200);
  }
  for (const rewriteUrl of ['~/Pages/Home.aspx', '~/Pages/InventedMissing.aspx', '~/invented.html']) {
    const rendered = await createPortalRenderer(site({ format: 'enhanced', rewriteUrl })).renderPage('/');
    assert.equal(rendered.status, 500);
    assert.equal(rendered.failure.code, 'INVALID_REWRITE_HANDLER');
    assert.equal(rendered.failure.dataverse, false);
  }
  for (const rewriteUrl of ['~/Pages/FullPage.aspx', '~/Pages/WebForm.aspx', '~/Pages/Blank.aspx'])
    assert.equal(
      (await createPortalRenderer(site({ format: 'enhanced', rewriteUrl })).renderPage('/')).status,
      200,
      rewriteUrl,
    );
});

// The Search.aspx content region of hosted session F3 (runs/a/cs-rewrite-full.json and runs/b/cs-rewrite-full.json,
// identical bodies), with the captured nonce attribute removed: the response nonce takes its place.
const CAPTURED_SEARCH_REGION =
  '<div id="content-container" class="container wrapper-body" role="main">\r\n\t\t\t<div id="content">\r\n\t\t\t\t\n\n' +
  '\t<div id="pp-native-controls-react-root"></div>\n' +
  "\t<script type=\"text/javascript\">\r\n\t\tdocument.querySelector('body > section.page_section').style.display = 'none'\r\n\t</script>\n" +
  '\t<div style="padding:32px">\r\n\t\t<pages-native-container>\r\n' +
  '\t\t\t<pages-search-summary show-search-suggestions=\'{ "raw": "false" }\' enable-streaming=\'{ "raw": "true" }\'></pages-search-summary>\r\n' +
  '\t\t</pages-native-container>\r\n\t</div>\n\n' +
  '\t<div id="searchErrorMessage">\n\t\t<h2></h2>\n\t</div>\n\r\n\t\t\t</div>\r\n\t\t</div>';

// @test-kind observation: hosted session F3 Customer Self-Service site, runs/a/cs-rewrite-full.json and runs/b/cs-rewrite-full.json (identical Search.aspx bodies).
test('PAGE-03c: enhanced Search.aspx renders the captured content region between the header and footer', async () => {
  const renderer = createPortalRenderer(
    site({ format: 'enhanced', rewriteUrl: '~/Pages/Search.aspx', header: '<i>HEAD</i>', footer: '<i>FOOT</i>' }),
  );
  const rendered = await renderer.renderPage('/');
  assert.equal(rendered.status, 200);
  assert.ok(rendered.html.includes(CAPTURED_SEARCH_REGION), rendered.html);
  const head = rendered.html.indexOf('<i>HEAD</i>'),
    region = rendered.html.indexOf(CAPTURED_SEARCH_REGION),
    foot = rendered.html.indexOf('<i>FOOT</i>');
  assert.ok(head < region && region < foot);
  assert.doesNotMatch(rendered.html, /id="mainContent"|class="page-heading"|id="content_form"|copy text/);
  assert.deepEqual(
    rendered.diagnostics.filter((entry) => /^REWRITE_LAYOUT/.test(entry.code)),
    [],
  );
  // The hide script is a platform script: under a nonce policy it gets the response nonce.
  const nonced = renderer.scriptNoncesFor(rendered, { nonce: 'invented-nonce', pending: 'data-invented-pending' });
  assert.match(
    nonced.html,
    /<script nonce="invented-nonce" type="text\/javascript">\r\n\t\tdocument\.querySelector\('body > section\.page_section'\)/,
  );
});

const CACHED = { 'Header/OutputCache/Enabled': 'True', 'Footer/OutputCache/Enabled': 'true' };
const marker =
  '<b id="h" data-path="{{ request.path }}" data-query="{{ request.query }}" data-user="{{ user.id }}" data-now="{{ now | date: \'HH:mm:ss\' }}"></b>' +
  '{% substitution %}<b id="s" data-path="{{ request.path }}" data-user="{{ user.id }}"></b>{% endsubstitution %}';
const read = (html, id) => {
  const element = new RegExp(`<b id="${id}" ([^>]*)>`).exec(html)?.[1] ?? '';
  return Object.fromEntries([...element.matchAll(/data-(\w+)="([^"]*)"/g)].map((m) => [m[1], m[2]]));
};

function clockAt(start) {
  let now = start;
  return { now: () => now, advance: (ms) => (now += ms) };
}

test('PAGE-06d2: one anonymous header copy for every path and query, fixed 5 minutes, substitution per request', async () => {
  const clock = clockAt(Date.UTC(2026, 0, 1, 8, 0, 0));
  const renderer = createPortalRenderer(site({ header: marker, settings: CACHED }), { clock });
  const first = (await renderer.renderPage('/')).html;
  assert.deepEqual(read(first, 'h'), { path: '/', query: '', user: '', now: '08:00:00' });
  clock.advance(299_999);
  const later = (await renderer.renderPage('/other/?x=1')).html;
  assert.deepEqual(read(later, 'h'), { path: '/', query: '', user: '', now: '08:00:00' });
  assert.deepEqual(read(later, 's'), { path: '/other/', user: '' });
  // Requests did not extend the copy: it expires 5:00 after the render that filled it.
  clock.advance(1);
  assert.deepEqual(read((await renderer.renderPage('/other/')).html, 'h').path, '/other/');
});

test('PAGE-06d2: a cached copy that shows request values of another request is reported', async () => {
  const clock = clockAt(Date.UTC(2026, 0, 1, 8, 0, 0));
  const header =
    '<a href="{{ website.sign_in_url }}">Sign in</a>{% substitution %}{{ request.path }}{% endsubstitution %}';
  const renderer = createPortalRenderer(site({ header, settings: CACHED }), { clock });
  const first = await renderer.renderPage('/?token=invented');
  assert.equal(
    first.diagnostics.some((entry) => entry.code === 'OUTPUT_CACHE_REQUEST_VALUE'),
    false,
  );
  const later = await renderer.renderPage('/other/');
  // Hosted behaviour: the shared copy keeps the filling request's returnUrl.
  assert.match(later.html, /returnUrl=%2F%3Ftoken%3Dinvented/);
  const warning = later.diagnostics.find((entry) => entry.code === 'OUTPUT_CACHE_REQUEST_VALUE');
  assert.equal(warning.severity, 'warning');
  assert.equal(warning.part, 'Header');
  assert.deepEqual(
    warning.reads.map((entry) => entry.text),
    ['website.sign_in_url'],
  );
  // Values read only inside substitution blocks are not reported.
  const safe = createPortalRenderer(
    site({ header: '{% substitution %}{{ website.sign_in_url }}{% endsubstitution %}', settings: CACHED }),
    { clock },
  );
  await safe.renderPage('/');
  assert.equal(
    (await safe.renderPage('/other/')).diagnostics.some((entry) => entry.code === 'OUTPUT_CACHE_REQUEST_VALUE'),
    false,
  );
});

// @test-kind observation+security: hosted session F3 captured per-contact copies; one contact's header must never be served to another visitor.
test('PAGE-06d2: a signed-in contact has its own copy; a role change or a template write renders afresh', async () => {
  const clock = clockAt(Date.UTC(2026, 0, 1, 8, 0, 0));
  const portal = site({ header: marker, settings: CACHED });
  const renderer = createPortalRenderer(portal, { clock });
  await renderer.renderPage('/');
  await renderer.renderPage('/', { user: visitor });
  const signed = (await renderer.renderPage('/other/', { user: visitor })).html;
  assert.deepEqual(read(signed, 'h'), { path: '/', query: '', user: 'invented-visitor', now: '08:00:00' });
  assert.equal(read((await renderer.renderPage('/other/', { user: editor })).html, 'h').path, '/other/');
  assert.equal(
    read((await renderer.renderPage('/other/', { user: { ...visitor, roles: ['Invented Editors'] } })).html, 'h').path,
    '/other/',
  );
  portal.templates.header.source = marker.replace('id="h"', 'id="h" data-rev="2"');
  assert.deepEqual(read((await renderer.renderPage('/other/')).html, 'h'), {
    rev: '2',
    path: '/other/',
    query: '',
    user: '',
    now: '08:00:00',
  });
});

test('PAGE-06d2: the settings off render every request; a Liquid error stays in the cached copy', async () => {
  const clock = clockAt(Date.UTC(2026, 0, 1, 8, 0, 0));
  const off = createPortalRenderer(site({ header: marker, settings: { 'Header/OutputCache/Enabled': 'false' } }), {
    clock,
  });
  await off.renderPage('/');
  assert.equal(read((await off.renderPage('/other/')).html, 'h').path, '/other/');
  const failing = createPortalRenderer(
    site({
      header: '{% if request.path == \'/\' %}{{ 1 | divided_by: 0 }}{% endif %}<b id="h"></b>',
      settings: CACHED,
    }),
    { clock },
  );
  const first = (await failing.renderPage('/')).html;
  const error = /Liquid error:[^<]*/.exec(first)?.[0];
  assert.ok(error, first);
  assert.equal((await failing.renderPage('/other/')).html.includes(error), true);
});

test('PAGE-06e: PWAFeature enabled adds the manifest link and registration; disabled unregisters; absent adds nothing', async () => {
  const enabled = pwaShellMarkup('{"status":"enable"}', 'invented-site');
  assert.equal(enabled.head, '<link rel="manifest" href="/PWAManifest.json">');
  assert.match(
    pwaServiceWorkerUrl('invented-site'),
    /^\/js\/sw\.js\?languageCode=\/&version=v[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/,
  );
  assert.equal(pwaServiceWorkerUrl('INVENTED-SITE'), pwaServiceWorkerUrl('invented-site'));
  assert.ok(
    enabled.body.includes(
      `navigator.serviceWorker.register('${pwaServiceWorkerUrl('invented-site')}', { scope: '/', updateViaCache: 'all' })`,
    ),
  );
  const disabled = pwaShellMarkup({ value: '{"status":"disable"}' }, 'invented-site');
  assert.equal(disabled.head, '');
  assert.match(disabled.body, /getRegistrations\(\)[\s\S]*registration\.unregister\(\)/);
  for (const value of [undefined, '', 'true', '{"status":"other"}'])
    assert.deepEqual(pwaShellMarkup(value), { head: '', body: '' });
  const html = (await createPortalRenderer(site({ settings: { PWAFeature: '{"status":"enable"}' } })).renderPage('/'))
    .html;
  assert.ok(html.indexOf(enabled.head) < html.indexOf('</head>'));
  assert.ok(html.includes(enabled.body));
  assert.ok(html.indexOf('navigator.serviceWorker.register(') > html.indexOf('<body'));
});

test('PAGE-03c: the generic error page carries the dialog and the DevTools server log for every server exception', () => {
  const now = Date.UTC(2026, 10, 27, 5, 51, 17, 83);
  const portal = { website: { id: 'invented-site' }, settings: {} };
  const observed = { pageErrorPresentation: 'generic-error', evidence: 'invented/f3.json' };
  const error = {
    status: 500,
    code: 'REWRITE_LAYOUT_TABLE_MISSING',
    message: 'invented table message',
    dataverse: true,
  };
  const page = observedPageErrorResponse({ method: 'GET', error, observed, portal, requestPath: '/invented/', now });
  assert.equal(page.status, 500);
  assert.match(page.body, /<title>We&#39;re sorry, but something went wrong \(500\)<\/title>/);
  assert.match(
    page.body,
    /<div class='dialog' role='main'><h1>We&#39;re sorry, but something went wrong\. Please try again, and if this persists, contact the website administrator\.<\/h1><h1>Error ID # \[[0-9a-f-]{36}\]<\/h1><p><small>11\/27\/2026 5:51:17 AM&nbsp;UTC<\/small><\/p><\/div>/,
  );
  assert.ok(page.body.indexOf('updateDevToolRuntime') < page.body.indexOf("<div class='dialog'"));
  assert.equal(page.body.includes('invented table message'), true, 'RTDV01 names the Dataverse error');
  const log = devToolServerLog({ error, observed, portal, requestPath: '/invented/', now });
  assert.deepEqual(
    log.map((entry) => [entry.Level, entry.MessageCode, entry.Message]),
    [
      ['Warning', 'RTSS09', 'HTTP/X-Content-Type-Options site setting is missing or misconfigured.'],
      ['Error', 'RTDV01', 'Error Message from Dataverse: invented table message'],
      ['Error', 'RTGE01', 'Error occurred : '],
    ],
  );
  assert.deepEqual(
    { ...log[0], Mitigation: undefined },
    {
      Timestamp: '2026-11-27T05:51:17.0830000+00:00',
      PortalID: 'invented-site',
      Source: 'Server',
      Level: 'Warning',
      RequestPath: '/invented/',
      MessageCode: 'RTSS09',
      Message: 'HTTP/X-Content-Type-Options site setting is missing or misconfigured.',
      Mitigation: undefined,
    },
  );
  // nosniff removes RTSS09; disabled custom errors add the exception message to RTGE01; a non-Dataverse error has no RTDV01.
  const quiet = devToolServerLog({
    error: { status: 500, message: 'invented route message' },
    observed: { ...observed, customErrors: 'disabled' },
    portal: { ...portal, settings: { 'HTTP/X-Content-Type-Options': 'nosniff' } },
    now,
  });
  assert.deepEqual(
    quiet.map((entry) => [entry.MessageCode, entry.Message]),
    [['RTGE01', 'Error occurred : invented route message']],
  );
  assert.equal(observedPageErrorResponse({ method: 'POST', error, observed, portal, now }), null);
  assert.equal(
    observedPageErrorResponse({ method: 'GET', error: { ...error, status: 404 }, observed, portal, now }),
    null,
  );
  // An exported Portal Generic Error snippet replaces the heading inside the same dialog, after the same log.
  const snippetSite = {
    ...portal,
    records: [{ kind: 'contentsnippet', id: 'invented-error', name: 'Portal Generic Error', adx_type: 756150001 }],
    snippets: { 'Portal Generic Error': '<h2>Invented error snippet</h2>' },
  };
  const custom = observedPageErrorResponse({ method: 'GET', error, observed, portal: snippetSite, now });
  assert.equal(custom.custom, true);
  assert.match(
    custom.body,
    /<script type = 'text\/javascript'>[\s\S]*updateDevToolRuntime[\s\S]*<\/script><div class='dialog' role='main'><h2>Invented error snippet<\/h2><h1>Error ID # \[[0-9a-f-]{36}\]<\/h1><p><small>11\/27\/2026 5:51:17 AM&nbsp;UTC<\/small><\/p><\/div>/,
  );
});

// @test-kind security: a request path written into the server log script cannot end the script element.
test('PAGE-03c: script-breaking text in the request path stays inside the server log JSON', () => {
  const hostile = observedPageErrorResponse({
    method: 'GET',
    error: { status: 500, message: '</script><i>' },
    observed: { pageErrorPresentation: 'generic-error', customErrors: 'disabled', evidence: 'invented/f3.json' },
    portal: { website: { id: 'invented-site' }, settings: {} },
    requestPath: '/</script><b>',
    now: Date.UTC(2026, 0, 1),
  });
  assert.equal(hostile.body.includes('</script><b>'), false);
  assert.equal(hostile.body.includes('</script><i>'), false);
  assert.equal(hostile.body.match(/<\/script>/g).length, 1);
});

async function simulator(t, { settings = '', observed, files: extraFiles = {} } = {}) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-hosted-f3-'));
  ownedFixture(t).remove(async () => {
    const physical = await assertTemporaryDirectory(directory, { directChild: true });
    await fs.rm(physical, { recursive: true, force: true });
  });
  const files = {
    'website.yml': 'adx_websiteid: invented-f3-site\nadx_name: Invented F3 site',
    'web-pages/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'page-templates/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/Main.webtemplate.source.html': '<p>Ordinary page</p>',
    ...(settings ? { 'sitesetting.yml': settings } : {}),
    ...extraFiles,
  };
  for (const [name, source] of Object.entries(files)) {
    const destination = path.join(directory, name);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, source);
  }
  const app = await createSimulator({
    sourceDir: directory,
    stateFile: path.join(directory, 'state.json'),
    port: 0,
    watch: false,
    ...(observed ? { observed } : {}),
  });
  ownedFixture(t).add(() => app.close());
  return app;
}

test('PAGE-03b: a private site without an authored robots.txt answers the platform body; sitemap.xml stays 404', async (t) => {
  const app = await simulator(t, { observed: { siteVisibility: 'private', evidence: 'invented/f3-robots.json' } });
  for (const target of ['/robots.txt', '/ROBOTS.TXT', '/robots.txt?invented=1']) {
    const response = await fetch(app.url + target);
    assert.equal(response.status, 200, target);
    assert.equal(response.headers.get('content-type'), 'text/plain');
    assert.equal(response.headers.get('cache-control'), 'private, max-age=3600');
    assert.equal(response.headers.get('content-disposition'), "inline;filename*=UTF-8''robots.txt");
    const body = Buffer.from(await response.arrayBuffer());
    assert.equal(body.toString('utf8'), 'User-agent: *\r\nDisallow: /');
    assert.equal(body.byteLength, 26);
  }
  assert.equal((await fetch(app.url + '/sitemap.xml', { redirect: 'manual' })).status, 404);
  // Only the private-site body was captured: a site without the observation keeps Page Not Found.
  const other = await simulator(t);
  assert.equal((await fetch(other.url + '/robots.txt', { redirect: 'manual' })).status, 404);
});

test('PAGE-03b: an authored redirect at /robots.txt wins over the platform body', async (t) => {
  const app = await simulator(t, { observed: { siteVisibility: 'private', evidence: 'invented/f3-robots.json' } });
  app.portal.redirects.push({ id: 'invented-redirect', inboundUrl: 'robots.txt', redirectUrl: '/', statusCode: 302 });
  const response = await fetch(app.url + '/robots.txt', { redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.equal(new URL(response.headers.get('location'), app.url).pathname, '/');
});

const PWA_ENABLED = '- adx_sitesettingid: pwa\n  adx_name: PWAFeature\n  adx_value: \'{"status":"enable"}\'';
const PWA_DISABLED = '- adx_sitesettingid: pwa\n  adx_name: PWAFeature\n  adx_value: \'{"status":"disable"}\'';

test('PAGE-06e: an enabled PWAFeature serves /js/sw.js with the captured headers; disabled it does not', async (t) => {
  const enabled = await simulator(t, { settings: PWA_ENABLED });
  const response = await fetch(enabled.url + pwaServiceWorkerUrl('invented-f3-site'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'application/x-javascript');
  assert.equal(response.headers.get('service-worker-allowed'), '/');
  const disabled = await simulator(t, { settings: PWA_DISABLED });
  const missing = await fetch(disabled.url + '/js/sw.js', { redirect: 'manual' });
  assert.notEqual(missing.headers.get('service-worker-allowed'), '/');
});

// @test-kind unproven: the hosted worker is Microsoft's Workbox build; the local stand-in body is a local model that handles no request.
test('PAGE-06e: the local service worker body handles no request', async (t) => {
  const enabled = await simulator(t, { settings: PWA_ENABLED });
  const body = await (await fetch(enabled.url + '/js/sw.js')).text();
  assert.match(body, /handles no requests/);
  assert.doesNotMatch(body, /addEventListener|importScripts/);
});

test('PAGE-06e: an exported web file at /js/sw.js answers instead of the local worker', async (t) => {
  const app = await simulator(t, {
    settings: PWA_ENABLED,
    files: {
      'web-pages/Js.webpage.yml':
        'adx_webpageid: js\nadx_name: Js\nadx_partialurl: js\nadx_parentpageid: home\nadx_pagetemplateid: main',
      'web-files/sw.js.webfile.yml':
        'adx_webfileid: invented-sw\nadx_name: sw.js\nadx_partialurl: sw.js\nadx_parentpageid: js\nfilename: sw.js\nmimetype: application/javascript',
      'web-files/sw.js': '// invented authored worker',
    },
  });
  const response = await fetch(app.url + '/js/sw.js');
  assert.equal(response.status, 200);
  // The authored file answers (Mirage appends its debug source map comment to exported scripts).
  assert.match(await response.text(), /^\/\/ invented authored worker/);
  assert.equal(response.headers.get('service-worker-allowed'), null);
});
