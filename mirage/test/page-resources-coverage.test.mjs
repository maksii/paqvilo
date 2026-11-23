// @test-kind contract: static page inspection reports what the local runtime renders for a route (invented schema and records only).
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPage, resolvePageResources } from '../lib/page-resources.mjs';
import { scanLiquidTokens, findWebTemplate } from '../lib/liquid-source.mjs';
import { effectiveSnippetRecords, snippetLanguageRank } from '../lib/importer.mjs';

const G = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = G(900);
const FR = G(801);

/** One invented site: a page per test is set with `page(html)`; templates, records and sets are shared. */
function site({ html = '', js = '', pageTemplateId = null, metadata = {}, extra = {} } = {}) {
  const pages = [
    {
      id: 'page-main',
      name: 'Main',
      title: 'Main',
      url: '/main/',
      parentId: null,
      pageTemplateId,
      html,
      js,
      css: '',
      formId: metadata.formId ?? null,
      listId: metadata.listId ?? null,
      advancedFormId: metadata.advancedFormId ?? null,
      metadata: { id: 'page-main', _file: 'C:/site/web-pages/main.webpage.yml', ...(metadata.record ?? {}) },
    },
    { id: 'page-search', name: 'Search', title: 'Search', url: '/search/', html: '', metadata: { id: 'page-search' } },
    {
      id: 'page-missing',
      name: 'Not found',
      title: 'Not found',
      url: '/not-found/',
      html: '{{ snippets["Missing/Body"] }}',
      metadata: { id: 'page-missing' },
    },
    { id: 'page-denied', name: 'Denied', title: 'Denied', url: '/denied/', html: '', metadata: { id: 'page-denied' } },
    {
      id: 'page-login',
      name: 'Login',
      title: 'Login',
      url: '/login-copy/',
      html: "{{ snippets['Login/Intro'] }}",
      metadata: { id: 'page-login' },
    },
    { id: 'page-kb', name: 'Articles', title: 'Articles', url: '/kb/', html: '', metadata: { id: 'page-kb' } },
  ];
  const record = (kind, idValue, name, fields = {}) => ({
    kind,
    id: idValue,
    name,
    _file: `C:/site/${kind}/${idValue}.yml`,
    ...fields,
  });
  const links = [
    {
      id: 'link-1',
      name: 'First',
      pageId: 'page-search',
      url: '/search/',
      weblinks: [],
      metadata: { _file: 'C:/site/weblink/1.yml' },
    },
  ];
  return {
    sourceDir: 'C:/site',
    website: { id: SITE, adx_headerwebtemplateid: 'wt-header', adx_footerwebtemplateid: 'wt-footer' },
    settings: { 'Search/Enabled': 'true', Theme: 'dark' },
    snippets: { 'Head/Bootstrap': '', Promo: 'promo', Footer: 'f', Only: 'o', 'Login/Intro': '' },
    pages,
    pageTemplates: [
      { id: 'pt-web', name: 'Web', webTemplateId: 'wt-body', metadata: { id: 'pt-web' } },
      { id: 'pt-copy', name: 'Copy', webTemplateId: 'wt-copy', metadata: { id: 'pt-copy' } },
      {
        id: 'pt-rewrite',
        name: 'Rewrite',
        rewriteUrl: '~/Pages/Page.aspx',
        metadata: { id: 'pt-rewrite', adx_type: 756150000 },
      },
    ],
    templates: {
      'wt-header': {
        id: 'wt-header',
        name: 'Header',
        source: '<header/>',
        metadata: { _file: 'C:/site/wt/header.yml' },
      },
      'wt-footer': {
        id: 'wt-footer',
        name: 'Footer',
        source: '<footer/>',
        metadata: { _file: 'C:/site/wt/footer.yml' },
      },
      'wt-body': {
        id: 'wt-body',
        name: 'Body',
        source: '<main>body</main>',
        metadata: { _file: 'C:/site/wt/body.yml' },
      },
      'wt-copy': {
        id: 'wt-copy',
        name: 'Copy Layout',
        source: '{{ page.adx_copy }}',
        metadata: { _file: 'C:/site/wt/copy.yml' },
      },
      'wt-alpha': { id: 'wt-alpha', name: 'Alpha', source: 'alpha', metadata: { _file: 'C:/site/wt/alpha.yml' } },
      'wt-page-header': {
        id: 'wt-page-header',
        name: 'Page Header',
        source: '',
        metadata: { _file: 'C:/site/wt/ph.yml' },
      },
    },
    forms: [
      {
        id: G(1),
        name: 'Shared',
        entityName: 'sample_item',
        metadata: { id: G(1), kind: 'basicform', _file: 'C:/site/bf/1.yml' },
      },
      {
        id: G(2),
        name: 'Second',
        entityName: 'sample_item',
        metadata: { id: G(2), kind: 'basicform', _file: 'C:/site/bf/2.yml' },
      },
      {
        id: G(3),
        name: 'OnlyBasic',
        entityName: 'sample_item',
        metadata: { id: G(3), kind: 'basicform', _file: 'C:/site/bf/3.yml' },
      },
    ],
    advancedForms: [
      {
        id: G(11),
        name: 'Shared',
        metadata: { id: G(11), kind: 'advancedform', _file: 'C:/site/af/11.yml', adx_startstep: G(21) },
      },
      { id: G(12), name: 'Other', metadata: { id: G(12), kind: 'advancedform', _file: 'C:/site/af/12.yml' } },
    ],
    lists: [
      {
        id: G(31),
        name: 'Items',
        entityName: 'sample_item',
        metadata: { id: G(31), _file: 'C:/site/list/31.yml', adx_view: G(41) },
      },
    ],
    weblinkSets: [
      { id: 'set-main', name: 'Main Nav', weblinks: links, metadata: { _file: 'C:/site/weblinkset/main.yml' } },
      { id: 'set-primary', name: 'Primary Navigation', weblinks: [], metadata: { _file: 'C:/site/weblinkset/p.yml' } },
      { id: 'set-side', name: 'Side', weblinks: [], metadata: { _file: 'C:/site/weblinkset/side.yml' } },
    ],
    siteMarkers: [
      { id: 'sm-search', name: 'Search', pageId: 'page-search' },
      { id: 'sm-404', name: 'Page Not Found', pageId: 'page-missing' },
      { id: 'sm-403', name: 'Access Denied', pageId: 'page-denied' },
      { id: 'sm-login', name: 'Login', pageId: 'page-login' },
      { id: 'sm-kb', name: 'Knowledge Article', pageId: 'page-kb' },
    ],
    websiteLanguages: [{ id: FR, code: 'fr-FR', published: true }],
    webFiles: [
      {
        id: 'wf-1',
        name: 'demo.css',
        url: '/demo.css',
        file: 'C:/site/web-files/demo.css',
        metadata: { _file: 'C:/site/web-files/demo.webfile.yml' },
      },
    ],
    redirects: [
      {
        id: 'redirect-1',
        name: 'Old',
        inboundUrl: 'old-main',
        statusCode: 301,
        webPageId: 'page-main',
        file: 'C:/site/redirect/1.yml',
      },
    ],
    records: [
      record('contentsnippet', 's-head', 'Head/Bootstrap'),
      record('contentsnippet', 's-promo', 'Promo'),
      record('contentsnippet', 's-footer', 'Footer'),
      record('contentsnippet', 's-only', 'Only'),
      record('contentsnippet', 's-login', 'Login/Intro'),
      record('sitesetting', 'set-search-old', 'Search/Enabled', { statecode: 1 }),
      record('sitesetting', 'set-search', 'Search/Enabled'),
      record('sitesetting', 'set-theme', 'Theme'),
      record('sitemarker', 'sm-search', 'Search'),
      record('advancedformstep', G(21), 'Start', {
        adx_webform: G(11),
        adx_nextstep: G(23),
        adx_targetentitylogicalname: 'sample_item',
      }),
      record('advancedformstep', G(22), 'Retired', {
        adx_webform: G(11),
        statecode: 1,
        adx_targetentitylogicalname: 'sample_retired',
      }),
      record('advancedformstep', G(23), 'Borrowed', {
        adx_webform: G(12),
        adx_targetentitylogicalname: 'sample_other',
      }),
      record('poll', 'poll-1', 'Weekly'),
    ],
    ...extra,
  };
}
const metadata = {
  entities: {
    sample_item: { fields: { sample_name: {}, sample_state: {}, sample_ownerid: {} }, sources: ['C:/sol/item.xml'] },
    sample_owner: { fields: { sample_ownerid: {} }, sources: ['C:/sol/owner.xml'] },
  },
  views: [
    { id: G(41), name: 'Active', entity: 'sample_item', fields: [], file: 'C:/sol/views.xml' },
    { id: G(42), name: 'Active', entity: 'sample_owner', fields: [], file: 'C:/sol/views.xml' },
  ],
};
const resources = (input, route = '/main/') => resolvePageResources(input, route, { solutionMetadata: metadata });
const names = (rows) => rows.map((row) => row.name).sort();
const kinds = (report, kind) => report.unresolved.filter((row) => row.kind === kind);

test('C1: a % inside tag arguments does not hide the tag', () => {
  const report = resources(
    site({ html: "{% include 'Alpha' width:'50%' %}{% entityform name:'Second' label:'100%' %}" }),
  );
  assert.ok(report.webTemplates.some((row) => row.name === 'Alpha'));
  assert.ok(report.forms.some((row) => row.name === 'Second'));
  const [token] = scanLiquidTokens("{% include 'A' close:'%}' %}tail");
  assert.equal(token.name, 'include');
  assert.equal(token.text, "{% include 'A' close:'%}' %}");
});

test('C2: web link sets, site markers, entities and the page navigation lookup are extracted', () => {
  const input = site({
    html: "{{ weblinks['Main Nav'].weblinks.size }}{{ sitemarkers['Search'].url }}{% assign r = entities.sample_item[id] %}{{ entities[t] }}{{ weblinks[chosen] }}{{ sitemap['/search/'].title }}",
    metadata: { record: { adx_navigation: 'set-side' } },
    pageTemplateId: 'pt-copy',
  });
  input.pages[0].html += '{% for l in weblinks[page.adx_navigation.id].weblinks %}{% endfor %}';
  const report = resources(input);
  assert.deepEqual(names(report.webLinkSets), ['Main Nav', 'Side']);
  assert.deepEqual(
    report.webLinkSets.find((row) => row.name === 'Main Nav').links.map((link) => link.pageId),
    ['page-search'],
  );
  assert.deepEqual(
    report.siteMarkers.map((row) => [row.name, row.page.url]),
    [['Search', '/search/']],
  );
  assert.ok(report.tables.some((row) => row.logicalName === 'sample_item'));
  assert.equal(kinds(report, 'table').filter((row) => /dynamic/.test(row.reason)).length, 1);
  assert.equal(kinds(report, 'web-link-set').length, 1);
  assert.ok(report.usages.some((row) => row.kind === 'sitemap' && row.page?.id === 'page-search'));
});

test('C3: parameters of built-in templates are resolved', () => {
  const report = resources(
    site({
      html: "{% include 'snippet' snippet_name:'Promo' %}{% include 'Weblink List Group' weblink_set_name:'Side' %}{% include 'poll' poll_name:'Weekly' %}{% include 'snippet' snippet_name: chosen %}",
      pageTemplateId: 'pt-copy',
    }),
  );
  assert.ok(report.snippets.some((row) => row.name === 'Promo'));
  assert.ok(report.webLinkSets.some((row) => row.name === 'Side'));
  assert.ok(report.components.some((row) => row.kind === 'poll' && row.name === 'Weekly'));
  assert.equal(kinds(report, 'content-snippet').length, 1);
  assert.equal(kinds(report, 'web-template').length, 0);
});

test('C3: entity_form is not a runtime template, so an include of it is unresolved rather than silently accepted', () => {
  const report = resources(site({ html: `{% include 'entity_form' key:'${G(1)}' %}`, pageTemplateId: 'pt-copy' }));
  assert.equal(kinds(report, 'web-template').length, 1);
  assert.equal(report.forms.length, 0);
});

test('C4: runtime built-in names and display names resolve, and their bodies are scanned', () => {
  const report = resources(
    site({
      html: "{% include 'page_copy' %}{% include 'Layout 1 Column' %}{% include 'top_navigation' %}{% include 'search' %}{% include 'Page Header' %}",
      pageTemplateId: 'pt-copy',
    }),
  );
  assert.equal(kinds(report, 'web-template').length, 0);
  assert.ok(
    ['page_copy', 'layout_1_column', 'top_navigation', 'search', 'page_header'].every((name) =>
      report.builtinTemplates.some((row) => row.name === name),
    ),
  );
  assert.ok(report.webLinkSets.some((row) => row.name === 'Primary Navigation'));
  assert.ok(report.siteMarkers.some((row) => row.name === 'Search'));
  // settings['search/enabled'] in the built-in search template resolves case-insensitively.
  assert.ok(report.siteSettings.some((row) => row.name === 'Search/Enabled'));
  assert.equal(report.webTemplates.find((row) => row.name === 'Page Header').runtimeSource, 'built-in page_header');
  assert.equal(kinds(report, 'content-snippet').length, 0);
});

test('C5: webform resolves advanced forms only and entityform basic forms only', () => {
  const report = resources(
    site({ html: "{% webform name:'Shared' %}{% webform name:'OnlyBasic' %}", pageTemplateId: 'pt-copy' }),
  );
  assert.deepEqual(
    report.forms.map((row) => row.id),
    [G(11)],
  );
  assert.equal(kinds(report, 'form').length, 1);
});

test('C8: sign-in, not-found, modal form, web file, language prefix, redirect and knowledge routes resolve like the runtime', () => {
  const input = site({ pageTemplateId: 'pt-web' });
  const signIn = resources(input, '/signin');
  assert.equal(signIn.route.kind, 'sign-in');
  assert.equal(signIn.page.id, 'page-login');
  assert.ok(signIn.snippets.some((row) => row.name === 'Login/Intro'));
  assert.equal(kinds(signIn, 'page').length, 0);

  const missing = resources(input, '/nowhere/');
  assert.deepEqual([missing.route.kind, missing.route.status, missing.page.id], ['not-found', 404, 'page-missing']);
  assert.ok(missing.webTemplates.some((row) => row.name === 'Header'));

  const modal = resources(input, `/_portal/modal-form-template-path/${SITE}?entityformid=${G(2)}`);
  assert.deepEqual([modal.route.kind, modal.forms.map((row) => row.id)], ['modal-form', [G(2)]]);
  assert.equal(modal.webTemplates.length, 0);

  const file = resources(input, '/demo.css');
  assert.equal(file.route.kind, 'web-file');
  assert.ok(file.components.some((row) => row.kind === 'web-file' && row.sourceFile === 'C:/site/web-files/demo.css'));
  assert.equal(file.webTemplates.length + file.snippets.length, 0);

  const french = resources(input, '/fr-FR/main/?q=private');
  assert.deepEqual([french.route.kind, french.page.id, french.route.language.code], ['page', 'page-main', 'fr-FR']);
  assert.equal(JSON.stringify(french).includes('private'), false);

  const redirect = resources(input, '/old-main');
  assert.equal(redirect.route.kind, 'redirect');
  assert.ok(redirect.components.some((row) => row.kind === 'redirect' && row.recordId === 'redirect-1'));
  assert.equal(redirect.webTemplates.length, 0);

  assert.equal(resources(input, '/kb/123/en-US').page.id, 'page-kb');
  assert.equal(resources(input, '/main').page.id, 'page-main');
});

test('C8: a denied page reports the page the runtime serves instead', () => {
  const report = inspectPage(site(), '/main/', {
    identity: { id: 'c1', contactId: 'c1' },
    access: () => ({ allowed: false, status: 403, code: 'PAGE_ACCESS_DENIED' }),
  });
  assert.deepEqual([report.route.outcome.status, report.route.outcome.page.id], [403, 'page-denied']);
  const input = site();
  input.siteMarkers.push({ id: 'sm-profile', name: 'Profile', pageId: 'page-main' });
  const anonymous = inspectPage(input, '/main/', { identity: {}, access: () => ({ allowed: true, status: 200 }) });
  assert.deepEqual(
    [anonymous.route.outcome.kind, anonymous.route.outcome.status, anonymous.route.outcome.code],
    ['redirect', 302, 'PROFILE_SIGN_IN_REQUIRED'],
  );
});

test('C19: inactive steps and settings are skipped, steps reached through nextstep are followed', () => {
  const report = resources(site({ html: `{% webform id:'${G(11)}' %}`, pageTemplateId: 'pt-copy' }));
  const steps = report.components.filter((row) => row.kind === 'advanced-form-step').map((row) => row.name);
  assert.deepEqual(steps.sort(), ['Borrowed', 'Start']);
  assert.deepEqual(report.forms[0].steps.map((row) => row.name).sort(), ['Borrowed', 'Start']);
  const settings = resources(
    site({ html: "{{ settings['Search/Enabled'] }}", pageTemplateId: 'pt-copy' }),
  ).siteSettings;
  assert.deepEqual(
    settings.map((row) => row.recordId),
    ['set-search'],
  );
});

test('C20: views by name honour the table, and page-lookup lists with an inner entityview resolve', () => {
  const view = resources(
    site({
      html: "{% entityview logical_name:'sample_owner', name:'Active' %}{% endentityview %}",
      pageTemplateId: 'pt-copy',
    }),
  );
  assert.deepEqual(
    view.views.map((row) => row.id),
    [G(42)],
  );
  const list = resources(
    site({
      html: '{% entitylist id: page.adx_entitylist.id %}{% entityview %}{% endentityview %}{% endentitylist %}',
      pageTemplateId: 'pt-copy',
      metadata: { listId: G(31) },
    }),
  );
  assert.deepEqual(list.unresolved, []);
  assert.ok(
    list.components.some((row) => row.kind === 'list' && row.recordId === G(31) && row.certainty === 'declared'),
  );
});

test('C22: usages carry certainty for conditional, unrendered copy, page lookups and later form tags', () => {
  const conditional = resources(
    site({ html: "{% if user %}{{ snippets['Only'] }}{% endif %}", pageTemplateId: 'pt-copy' }),
  );
  const only = conditional.usages.find((row) => row.kind === 'snippet' && row.reference === 'Only');
  assert.deepEqual([only.conditional, only.certainty], [true, 'conditional']);

  const unrendered = resources(
    site({ html: "{{ snippets['Promo'] }}", pageTemplateId: 'pt-web', metadata: { formId: G(1) } }),
  );
  assert.equal(unrendered.usages.find((row) => row.reference === 'Promo').certainty, 'not-rendered');
  assert.equal(unrendered.usages.find((row) => row.pageLookup === 'entityform').certainty, 'not-rendered');

  const lookup = resources(
    site({
      html: '{% entityform id: page.adx_entityform.id %}',
      pageTemplateId: 'pt-copy',
      metadata: { formId: G(1) },
    }),
  );
  assert.equal(lookup.usages.find((row) => row.via === 'page record').certainty, 'declared');

  const two = resources(
    site({ html: `{% entityform id:'${G(1)}' %}{% entityform id:'${G(2)}' %}`, pageTemplateId: 'pt-copy' }),
  );
  const tags = two.usages.filter((row) => row.kind === 'entityform');
  assert.deepEqual(
    tags.map((row) => row.certainty),
    ['declared', 'not-rendered'],
  );
  assert.equal(two.components.find((row) => row.recordId === G(2)).certainty, 'not-rendered');

  const rewrite = resources(site({ html: `{% entityform id:'${G(2)}' %}`, pageTemplateId: 'pt-rewrite' }));
  assert.equal(
    rewrite.usages.find((row) => row.kind === 'entityform' && row.reference === G(2)).certainty,
    'not-rendered',
  );
});

test('C23: optional shell snippets, JavaScript lookalikes, dotted members, setting case and include names', () => {
  const report = resources(
    site({
      html: "{{ snippets.Footer.size }}{{ settings['theme'] }}{% include ' Alpha ' %}",
      js: 'data.snippets.forEach(run); $.ajaxSettings.cache = false; request(settings.url);',
      pageTemplateId: 'pt-copy',
    }),
  );
  assert.deepEqual(report.unresolved, []);
  assert.ok(report.optionalAbsent.some((row) => row.name === 'Browser Title Suffix'));
  assert.ok(report.snippets.some((row) => row.name === 'Head/Bootstrap'));
  assert.ok(report.snippets.some((row) => row.name === 'Footer'));
  assert.ok(report.siteSettings.some((row) => row.name === 'Theme'));
  assert.ok(report.webTemplates.some((row) => row.name === 'Alpha'));
});

test('C24: a dynamic settings key is unresolved', () => {
  const report = resources(site({ html: '{{ settings[name] }}', pageTemplateId: 'pt-copy' }));
  assert.equal(kinds(report, 'site-setting').length, 1);
});

test('C25: FetchXML columns come from conditions, orders and link keys; a Liquid table name is dynamic', () => {
  const report = resources(
    site({
      html: '<fetch><entity name="sample_item"><order attribute="sample_name"/><filter><condition attribute="sample_state" operator="eq" value="1"/></filter><link-entity name="sample_owner" from="sample_ownerid" to="sample_ownerid"/></entity></fetch><fetch><entity name="{{ t }}"/></fetch>',
      pageTemplateId: 'pt-copy',
    }),
  );
  const columns = report.columns.map((row) => `${row.entity}.${row.name}`).sort();
  assert.deepEqual(columns, [
    'sample_item.sample_name',
    'sample_item.sample_ownerid',
    'sample_item.sample_state',
    'sample_owner.sample_ownerid',
  ]);
  assert.equal(
    report.tables.some((row) => row.logicalName.includes('{{')),
    false,
  );
  assert.equal(kinds(report, 'fetchxml-table').length, 1);
});

test('C26: chart, powerbi, searchindex, redirect and rating tags are reported', () => {
  const report = resources(
    site({
      html: `{% chart id:'${G(51)}' viewid:'${G(41)}' %}{% powerbi path:'https://example.invalid/report' %}{% searchindex query: q, logical_names:'sample_owner' %}{% endsearchindex %}{% redirect sitemarker:'Search' %}{% rating id:'r1' %}`,
      pageTemplateId: 'pt-copy',
    }),
  );
  assert.ok(report.views.some((row) => row.id === G(41)));
  assert.ok(report.tables.some((row) => row.logicalName === 'sample_owner'));
  assert.ok(report.siteMarkers.some((row) => row.name === 'Search'));
  assert.deepEqual(
    ['chart', 'powerbi', 'searchindex', 'redirect', 'rating'].map((kind) =>
      report.usages.some((row) => row.kind === kind),
    ),
    [true, true, true, true, true],
  );
});

test('C29: a duplicate web template name selects the record the runtime selects', () => {
  const first = { id: 'd1', name: 'Dup', source: "{{ snippets['Promo'] }}", metadata: { _file: 'C:/site/wt/d1.yml' } };
  const second = { id: 'd2', name: 'Dup', source: "{{ snippets['Only'] }}", metadata: { _file: 'C:/site/wt/d2.yml' } };
  const lower = { id: 'd0', name: 'dup', source: '', metadata: {} };
  const input = site({ html: "{% include 'Dup' %}", pageTemplateId: 'pt-copy' });
  // Importer order: id key, name key (overwritten by the last record of that name), id key.
  input.templates = { ...input.templates, d0: lower, dup: lower, d1: first, Dup: second, d2: second };
  const report = resources(input);
  assert.equal(findWebTemplate(input, 'Dup').id, 'd1');
  assert.deepEqual(
    report.webTemplates.filter((row) => /^d\d$/.test(row.id)).map((row) => row.id),
    ['d1'],
  );
  assert.ok(report.snippets.some((row) => row.name === 'Promo'));
});

// @test-kind unproven: snippet language preference is a deterministic local model; Microsoft Learn documents the language column but no fallback order.
test('C30: snippet language preference is selected, then language-neutral, then the site default', () => {
  const english = G(701),
    german = G(702);
  const row = (identifier, language) => ({
    kind: 'contentsnippet',
    id: identifier,
    name: 'Greeting',
    adx_contentsnippetlanguageid: language,
  });
  const records = [row('neutral', null), row('german', german), row('default', english)];
  assert.equal(effectiveSnippetRecords(records, FR, english).resolve('Greeting').id, 'neutral');
  assert.equal(
    effectiveSnippetRecords(
      [row('german', german), row('default', english), row('other', german)],
      FR,
      english,
    ).resolve('Greeting').id,
    'default',
  );
  assert.equal(effectiveSnippetRecords([...records, row('french', FR)], FR, english).resolve('Greeting').id, 'french');
  const rank = snippetLanguageRank(FR, english);
  assert.deepEqual(records.map(rank), [2, 0, 1]);
});
