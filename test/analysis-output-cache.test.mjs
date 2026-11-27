// @test-kind compatibility: header and footer output caching and the substitution tag as documented at https://learn.microsoft.com/power-pages/configure/enable-header-footer-output-caching and https://learn.microsoft.com/power-pages/configure/liquid/template-tags#substitution; invented export fixtures.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { tempDirSync } from './fixture.mjs';
import { analyzeProject, analysisRules } from '../lense/analysis/index.mjs';
import { cachedRequestReads } from '../lense/analysis/output-cache-rules.mjs';

const SITE_ID = '11111111-1111-1111-1111-111111111111';
const HEADER_ID = '22222222-2222-2222-2222-222222222222';
const FOOTER_ID = '33333333-3333-3333-3333-333333333333';
const PART_ID = '44444444-4444-4444-4444-444444444444';
const HEADER = 'web-templates/header/Header.webtemplate.source.html';
const FOOTER = 'web-templates/footer/Footer.webtemplate.source.html';
const PART = 'web-templates/part/Invented-Part.webtemplate.source.html';

function project(t, files) {
  const root = tempDirSync('paq-output-cache-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const [file, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
  return root;
}

function classic({ header = '<header></header>', footer = '<footer></footer>', part, headerCache, footerCache }) {
  const settings = [];
  if (headerCache !== undefined)
    settings.push(`- adx_name: Header/OutputCache/Enabled\n  adx_value: '${headerCache}'\n`);
  if (footerCache !== undefined)
    settings.push(`- adx_name: Footer/OutputCache/Enabled\n  adx_value: '${footerCache}'\n`);
  return {
    'website.yml': `adx_name: Invented site\nadx_websiteid: ${SITE_ID}\nadx_headerwebtemplateid: ${HEADER_ID}\nadx_footerwebtemplateid: ${FOOTER_ID}\n`,
    ...(settings.length ? { 'sitesetting.yml': settings.join('') } : {}),
    'web-templates/header/Header.webtemplate.yml': `adx_name: Header\nadx_webtemplateid: ${HEADER_ID}\n`,
    [HEADER]: header,
    'web-templates/footer/Footer.webtemplate.yml': `adx_name: Footer\nadx_webtemplateid: ${FOOTER_ID}\n`,
    [FOOTER]: footer,
    ...(part === undefined
      ? {}
      : {
          'web-templates/part/Invented-Part.webtemplate.yml': `adx_name: Invented Part\nadx_webtemplateid: ${PART_ID}\n`,
          [PART]: part,
        }),
  };
}

function cacheFindings(root) {
  return analyzeProject(root, { failOn: 'none' })
    .findings.filter((finding) => finding.ruleId === 'PP-CACHE-001')
    .map((finding) => ({ file: finding.file.replace(/^source\//, ''), line: finding.line }));
}

const located = (findings) => findings.map(({ file, line }) => `${file.split('/').pop()}:${line}`);

test('the rule is registered in the Power Pages domain with its documentation', () => {
  const rule = analysisRules.find((item) => item.id === 'PP-CACHE-001');
  assert.equal(rule.domain, 'power-pages');
  assert.equal(rule.severity, 'warning');
  assert.deepEqual(rule.references, [
    'https://learn.microsoft.com/power-pages/configure/enable-header-footer-output-caching',
    'https://learn.microsoft.com/power-pages/configure/liquid/template-tags#substitution',
    'https://learn.microsoft.com/power-pages/configure/liquid/liquid-objects',
  ]);
});

test('request, page, params, now and language.url outside substitution are reported when caching is on', (t) => {
  const header = [
    '<a href="/SignIn?returnUrl={{ request.raw_url_encode }}">Sign in</a>',
    '{% if page %}<span>{{ page.title }}</span>{% endif %}',
    '<p>{{ params.id }}</p>',
    '<time>{{ now | date: "yyyy" }}</time>',
    '{% for language in website.languages %}<a href="/{{ language.url }}">{{ language.name }}</a>{% endfor %}',
    '',
  ].join('\n');
  const footer = '<section class="{% unless page.parent %}home-section{% endunless %}"></section>\n';
  const root = project(t, classic({ header, footer, headerCache: 'true', footerCache: 'True' }));
  assert.deepEqual(located(cacheFindings(root)), [
    'Footer.webtemplate.source.html:1',
    'Header.webtemplate.source.html:1',
    'Header.webtemplate.source.html:2',
    'Header.webtemplate.source.html:2',
    'Header.webtemplate.source.html:3',
    'Header.webtemplate.source.html:4',
    'Header.webtemplate.source.html:5',
  ]);
});

// @test-kind observation+compatibility: hosted session F3 (two runs) shared one anonymous header copy whatever the path or query, so the request-built sign-in, sign-out and selected-language URLs show another request's path; their *_substitution forms are the documented cached-safe ones.
test('the request-built website URLs outside substitution are reported; their substitution forms are not', (t) => {
  const header = [
    '<a href="{{ website.sign_in_url }}">Sign in</a>',
    '<a href="{{ website.sign_out_url | escape }}">Sign out</a>',
    '<a href="/{{ website.selected_language.url }}">Language</a>',
    '<a href="{{ website.sign_in_url_substitution }}">{{ website.sign_out_url_substitution }}</a>',
    '{% substitution %}<a href="{{ website.sign_in_url }}">Sign in</a>{% endsubstitution %}',
    '{% assign website = "shadow" %}{{ website.sign_in_url }}',
    '',
  ].join('\n');
  const root = project(t, classic({ header, headerCache: 'true' }));
  assert.deepEqual(located(cacheFindings(root)), [
    'Header.webtemplate.source.html:1',
    'Header.webtemplate.source.html:2',
    'Header.webtemplate.source.html:3',
  ]);
});

// @test-kind contract: the scanner export Mirage uses to report a cached header's request reads (mirage/lib/liquid.mjs).
test('cachedRequestReads lists the reads of a source and the templates it includes', () => {
  assert.deepEqual(
    cachedRequestReads('Header', "<a href='{{ website.sign_in_url }}'></a>{% include 'Part' %}", [
      { name: 'Part', source: '{{ request.path }}{% substitution %}{{ request.query }}{% endsubstitution %}' },
    ]).map(({ template, text }) => [template, text]),
    [
      ['Header', 'website.sign_in_url'],
      ['Part', 'request.path'],
    ],
  );
  assert.deepEqual(cachedRequestReads('Header', '{% substitution %}{{ request.path }}{% endsubstitution %}'), []);
});

test('wrapped references, substitution attributes, user and literals are not reported', (t) => {
  const header = [
    '{% substitution %}{% if page %}<span>{{ page.title }}</span>{% endif %}{% endsubstitution %}',
    '{%- substitution -%}<a href="?r={{ request.url }}">x</a>{%- endsubstitution -%}',
    '<a href="{{ website.sign_in_url_substitution }}">{{ snippets["links/login"] }}</a>',
    '{% if user %}<span>{{ user.fullname }}</span>{% endif %}',
    '{% for language in website.languages %}<a href="/{{ language.url_substitution }}">{{ language.name }}</a>{% endfor %}',
    '<p>{{ "page request now" }}</p>{% assign page_title = "x" %}{{ website.page_size }}',
    '{% comment %}{{ request.url }}{% endcomment %}',
    '',
  ].join('\n');
  const root = project(t, classic({ header, headerCache: 'true' }));
  assert.deepEqual(cacheFindings(root), []);
});

test('no finding when caching is off, absent, unresolved or ambiguous', (t) => {
  const header = '<a href="?r={{ request.url }}">x</a>\n';
  for (const headerCache of ['false', undefined, '${HeaderCache}']) {
    const root = project(t, classic({ header, headerCache }));
    assert.deepEqual(cacheFindings(root), [], `Header/OutputCache/Enabled ${headerCache}`);
  }
  // The footer setting does not enable the header cache.
  assert.deepEqual(cacheFindings(project(t, classic({ header, footerCache: 'true' }))), []);
  const files = classic({ header, headerCache: 'true' });
  files['sitesetting.yml'] += "- adx_name: Header/OutputCache/Enabled\n  adx_value: 'false'\n";
  assert.deepEqual(cacheFindings(project(t, files)), []);
});

test('templates included outside substitution are scanned; included inside it are not', (t) => {
  const part = '<nav>{{ page.title }}</nav>\n{% include "Header" %}\n';
  const unwrapped = project(
    t,
    classic({ header: "<header>{% include 'Invented Part' %}</header>\n", part, headerCache: 'true' }),
  );
  assert.deepEqual(located(cacheFindings(unwrapped)), ['Invented-Part.webtemplate.source.html:1']);
  const wrapped = project(
    t,
    classic({
      header: "{% substitution %}{% include 'invented part ' %}{% endsubstitution %}\n",
      part,
      headerCache: 'true',
    }),
  );
  assert.deepEqual(cacheFindings(wrapped), []);
  // An include parameter that reads a request object is itself reported in the including template.
  const parameter = project(
    t,
    classic({ header: "{% include 'Invented Part' current: page.id %}\n", part: '<i></i>', headerCache: 'true' }),
  );
  assert.deepEqual(located(cacheFindings(parameter)), ['Header.webtemplate.source.html:1']);
});

// @test-kind contract: Paqvilo's static scope model of Liquid variables (assign, capture, loop variables, include parameters); substitution renders apart as Mirage's SubstitutionTag does.
test('variables the template declares shadow request objects only where they are in scope', (t) => {
  const findings = (header, part) => located(cacheFindings(project(t, classic({ header, part, headerCache: 'true' }))));
  // A loop variable lasts until its end tag; the collection expression is still read.
  assert.deepEqual(findings('{% for page in site.pages %}{{ page.title }}{% endfor %}\n'), []);
  assert.deepEqual(findings('{% tablerow page in site.pages %}{{ page.title }}{% endtablerow %}\n'), []);
  assert.deepEqual(findings('{% for page in site.pages %}{% endfor %}\n{{ page.title }}\n'), [
    'Header.webtemplate.source.html:2',
  ]);
  assert.deepEqual(findings('{% for item in page.children %}{{ item.title }}{% endfor %}\n'), [
    'Header.webtemplate.source.html:1',
  ]);
  // assign and capture declare from that point on; the assigned expression is read before the name exists.
  assert.deepEqual(findings('{% assign now = 5 %}{{ now }}\n{% if now %}{% endif %}\n'), []);
  assert.deepEqual(findings('{{ now }}\n{% assign now = 5 %}\n'), ['Header.webtemplate.source.html:1']);
  assert.deepEqual(findings('{% assign page = page.id %}\n{{ page }}\n'), ['Header.webtemplate.source.html:1']);
  assert.deepEqual(findings('{% capture request %}x{% endcapture %}{{ request }}\n'), []);
  // A declaration inside a substitution block does not shadow the cached output outside it.
  assert.deepEqual(findings('{% substitution %}{% assign page = 5 %}{% endsubstitution %}\n{{ page.title }}\n'), [
    'Header.webtemplate.source.html:2',
  ]);
  // A loop over website.languages yields language objects whatever the variable is called; another loop does not.
  assert.deepEqual(findings('{% for lang in website.languages %}<a href="/{{ lang.url }}"></a>{% endfor %}\n'), [
    'Header.webtemplate.source.html:1',
  ]);
  assert.deepEqual(findings('{% for language in site.links %}<a href="{{ language.url }}"></a>{% endfor %}\n'), []);
  assert.deepEqual(findings('{% assign language = site.link %}{{ language.url }}\n'), []);
  assert.deepEqual(
    findings("{% for lang in website.languages %}{% include 'Invented Part' %}{% endfor %}\n", '{{ lang.url }}\n'),
    ['Invented-Part.webtemplate.source.html:1'],
  );
  // Included templates see the names in scope at the include and its parameters; their assigns reach the parent.
  const part = '{{ page.title }}\n';
  assert.deepEqual(findings("{% for page in site.pages %}{% include 'Invented Part' %}{% endfor %}\n", part), []);
  assert.deepEqual(findings("{% include 'Invented Part' page: site.home %}\n", part), []);
  assert.deepEqual(findings("{% include 'Invented Part' %}\n{{ now }}\n", '{% assign now = 1 %}\n'), []);
  assert.deepEqual(findings("{% include 'Invented Part' %}\n", part), ['Invented-Part.webtemplate.source.html:1']);
});

test('an enhanced export reads the site record and component templates', (t) => {
  const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const component = (id, type, content) =>
    `<powerpagecomponent powerpagecomponentid="${id}">\n<powerpagecomponenttype>${type}</powerpagecomponenttype>\n<powerpagesiteid>${SITE_ID}</powerpagesiteid>\n<content>${escape(JSON.stringify(content))}</content>\n</powerpagecomponent>\n`;
  const files = (value) => ({
    'Assets/powerpagesites.xml': `<powerpagesites><powerpagesite powerpagesiteid="${SITE_ID}"><content>${escape(JSON.stringify({ headerwebtemplateid: HEADER_ID }))}</content><name>Invented</name></powerpagesite></powerpagesites>`,
    [`powerpagecomponents/${HEADER_ID}/powerpagecomponent.xml`]: component(HEADER_ID, 8, {
      name: 'Header',
      source: '<header>{{ request.path }}</header>',
    }),
    'powerpagecomponents/55555555-5555-5555-5555-555555555555/powerpagecomponent.xml': component(
      '55555555-5555-5555-5555-555555555555',
      9,
      { name: 'Header/OutputCache/Enabled', value: value },
    ),
  });
  assert.equal(cacheFindings(project(t, files('true'))).length, 1);
  assert.deepEqual(cacheFindings(project(t, files('false'))), []);
});
