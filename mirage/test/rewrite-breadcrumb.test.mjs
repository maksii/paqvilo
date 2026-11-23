// @test-kind observation: native captures of 2026-11-23 on a Power Pages 9.8.9.29 site (FullPage.aspx, WebForm.aspx and WebFormNoValidation.aspx page templates, both Bootstrap builds), recorded as the page-layout replay cases; these tests type their own invented portal
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { antiXssHtmlEncode } from '../lib/liquid-dotnet.mjs';
import { siteMapPathMarkup } from '../lib/platform-manifest.mjs';
import { resolvePageResources } from '../lib/page-resources.mjs';

const id = (n) => `c0de0000-0000-4000-8000-${String(n).padStart(12, '0')}`;
// A site whose own Breadcrumbs web template is unmistakable, and a page two levels down on a rewrite page template.
function inventedPortal(settings = {}) {
  const page = (n, title, url, parent, template = null) => ({
    id: id(n),
    name: title,
    title,
    url,
    parentId: parent ? id(parent) : null,
    pageTemplateId: template ? id(template) : null,
    html: '<p class="copy">Copy</p>',
    css: '',
    js: '',
    summary: '',
    formId: null,
    advancedFormId: null,
    listId: null,
    metadata: { kind: 'webpage', id: id(n) },
  });
  return {
    templates: {
      Breadcrumbs: {
        id: id(30),
        name: 'Breadcrumbs',
        source:
          '<ol class="invented-site-breadcrumbs">{% for crumb in page.breadcrumbs %}<li>{{ crumb.title }}</li>{% endfor %}</ol>',
        metadata: { kind: 'webtemplate', id: id(30), name: 'Breadcrumbs' },
      },
    },
    snippets: {},
    settings,
    pages: [page(1, 'Home', '/'), page(2, 'Area & <b>more</b>', '/area/', 1), page(3, 'Leaf', '/area/leaf/', 2, 20)],
    webFiles: [],
    records: [],
    weblinks: {},
    sitemarkers: {},
    website: {},
    pageTemplates: [
      {
        id: id(20),
        name: 'Invented Full Page',
        webTemplateId: null,
        useHeaderFooter: true,
        rewriteUrl: '~/Pages/FullPage.aspx',
        metadata: { kind: 'pagetemplate', id: id(20) },
      },
    ],
  };
}

test('a rewrite page layout writes the portal’s own breadcrumb, not the site’s Breadcrumbs web template', async () => {
  for (const [settings, expected] of [
    [
      { 'Site/BootstrapV5Enabled': 'true' },
      '<ul class="breadcrumb"><li class="breadcrumb-item"><a href="/">Home</a></li>\r\n<li class="breadcrumb-item"><a href="/area/">Area &amp; &lt;b&gt;more&lt;/b&gt;</a></li>\r\n<li class="active&#32;breadcrumb-item">Leaf</li>\r\n</ul>',
    ],
    [
      {},
      '<ul class="breadcrumb"><li><a href="/">Home</a></li>\r\n<li><a href="/area/">Area &amp; &lt;b&gt;more&lt;/b&gt;</a></li>\r\n<li class="active">Leaf</li>\r\n</ul>',
    ],
  ]) {
    const rendered = await createPortalRenderer(inventedPortal(settings), {}).renderPage('/area/leaf/', {});
    assert.equal(rendered.status, 200);
    assert.ok(
      rendered.html.includes(`<div class="page-heading"><div class="container">${expected}<div class="page-header">`),
    );
    assert.ok(!rendered.html.includes('invented-site-breadcrumbs'), 'the site template is not rendered');
  }
});

test('the breadcrumb lists every page of the path with its whole title and no title attribute', () => {
  const long = 'A title that is clearly longer than twenty-four characters';
  assert.equal(
    siteMapPathMarkup(
      [
        { url: '/', title: 'Home' },
        { url: '/long/', title: long },
      ],
      '  spaced  ',
      'BootstrapV3',
    ),
    `<ul class="breadcrumb"><li><a href="/">Home</a></li>\r\n<li><a href="/long/">${long}</a></li>\r\n<li class="active">  spaced  </li>\r\n</ul>`,
  );
  // The home page itself: only the active item.
  assert.equal(
    siteMapPathMarkup([], 'Home', 'BootstrapV5'),
    '<ul class="breadcrumb"><li class="active&#32;breadcrumb-item">Home</li>\r\n</ul>',
  );
});

test('titles are written with the AntiXSS encoder: its safe list ends at the combining marks', () => {
  assert.equal(antiXssHtmlEncode(`& < > " '`), '&amp; &lt; &gt; &quot; &#39;');
  // No-break space and soft hyphen are written as references; the Latin-1 letters around them are not.
  assert.equal(antiXssHtmlEncode('A B¡C­Dÿ'), 'A&#160;B¡C&#173;Dÿ');
  // Latin Extended, IPA, modifier letters and combining marks stay; Greek and everything after is a reference.
  assert.equal(antiXssHtmlEncode('ſɏɐͯͰ—'), 'ſɏɐͯ&#880;&#8212;');
  // One reference per code point, also outside the Basic Multilingual Plane.
  assert.equal(antiXssHtmlEncode('\u{1F600}'), '&#128512;');
  assert.equal(antiXssHtmlEncode(null), '');
});

// @test-kind contract: static page inspection reports what the local runtime renders for a route (invented portal)
test('page inspection of a rewrite page does not list the site’s Breadcrumbs web template', () => {
  const report = resolvePageResources(inventedPortal(), '/area/leaf/');
  const includes = report.usages.filter((row) => row.kind === 'include').map((row) => row.reference);
  assert.ok(includes.length > 0, 'the includes of the layout itself are listed');
  assert.ok(!includes.some((name) => /breadcrumbs/i.test(name)), includes.join(', '));
  assert.ok(
    !report.webTemplates.some((row) => /breadcrumbs/i.test(row.name ?? '')),
    JSON.stringify(report.webTemplates),
  );
});
