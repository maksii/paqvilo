// @test-kind compatibility: Learn power-pages/important-changes-deprecations "Portal content editor" (deprecated from June 2022, "This feature will be removed by June 2026"): an export whose authored Liquid still uses the editor's editable output is reported once per page or web template, and the report is information only
import test from 'node:test';
import assert from 'node:assert/strict';
import { platformChangeDiagnostics } from '../lib/platform-changes.mjs';
import { buildSourceGraph } from '../lib/source-graph.mjs';

const LEARN = 'https://learn.microsoft.com/power-pages/important-changes-deprecations#portal-content-editor';
const editor = (input) => platformChangeDiagnostics(input).find((entry) => entry.code === 'CMS_CONTENT_EDITOR_REMOVED');

test('each page or web template that uses the content editor is listed once', () => {
  const found = editor({
    pages: [
      {
        url: '/about/',
        html: "{% editable page 'adx_copy' type: 'html' %}{%- editable snippets 'Invented/Intro' -%}",
        translations: { 1036: { html: "{% editable page 'adx_copy' %}" } },
      },
      { url: '/plain/', html: '<p>{{ page.title }}</p>' },
    ],
    templates: {
      'id-nav': {
        name: 'Invented Navigation',
        source:
          "{% assign set = weblinks['Invented'] %}{% if set.editable %}<b>edit</b>{% endif %}{{ weblinks[x].editable }}",
      },
      // The template map holds each template under its id and its name.
      'Invented Navigation': undefined,
    },
  });
  assert.ok(found, LEARN);
  assert.equal(found.count, 2);
  assert.deepEqual(found.items, [
    'page /about/: 3 editable tag(s)',
    'web template Invented Navigation: 2 .editable check(s)',
  ]);
  assert.equal(found.severity, 'info');
  assert.equal(found.requirement, undefined, 'the local runtime still renders them, so no preflight row');
  assert.match(found.message, /June 2026/);
});

test('the same template held under its id and its name counts once', () => {
  const template = { name: 'Invented Copy', source: "{% editable page 'adx_copy' %}" };
  const found = editor({ templates: { 'id-copy': template, 'Invented Copy': template } });
  assert.deepEqual(found.items, ['web template Invented Copy: 1 editable tag(s)']);
});

test('markup outside Liquid, comments, raw blocks and other names are not editor uses', () => {
  assert.equal(
    editor({
      pages: [
        {
          url: '/styled/',
          html:
            '<style>.editable { color: red }</style><script>node.editable = true;</script><p class="editable">x</p>' +
            "{% comment %}{% editable page 'adx_copy' %}{% endcomment %}{% raw %}{{ set.editable }}{% endraw %}" +
            '{{ page.editable_note }}{% assign noneditable = 1 %}{{ editable }}',
        },
      ],
    }),
    undefined,
  );
  const after = editor({
    pages: [
      {
        url: '/after/',
        html:
          "{% comment %}{% comment %}{% endcomment %}{% editable page 'adx_copy' %}{% endcomment %}" +
          "{% raw %}{% comment %}{% editable page 'adx_copy' %}{% endraw %}{%- editable page 'adx_copy' -%}",
      },
    ],
  });
  assert.deepEqual(after.items, ['page /after/: 1 editable tag(s)'], 'nested comments; parsing resumes after a block');
});

test('the report adds no preflight requirement row', () => {
  const diagnostics = platformChangeDiagnostics({
    pages: [{ url: '/', html: "{% editable page 'adx_copy' %}" }],
  });
  assert.ok(diagnostics.some((entry) => entry.code === 'CMS_CONTENT_EDITOR_REMOVED'));
  assert.ok(!buildSourceGraph({ portal: { diagnostics } }).requirements().length);
});
