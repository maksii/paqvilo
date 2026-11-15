// @test-kind contract: a page renders only its first entityform or webform tag, as the platform does (Learn, dataverse-liquid-tags: "entityform or webform tags after the first will not be rendered"); each later tag renders nothing and reports a diagnostic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';

const PAGE = { id: 'p1', url: '/', name: 'Home', title: 'Home', metadata: {} };

test('only the first entityform or webform tag of a page renders, and each later one reports a diagnostic', async () => {
  const calls = [];
  const renderer = createPortalRenderer(
    {
      pages: [PAGE],
      templates: {},
      pageTemplates: [],
      settings: {},
      snippets: {},
      webFiles: [],
    },
    {
      renderComponent: async (tag, args) => {
        calls.push(`${tag}:${args.name}`);
        return `<form data-form="${args.name}"></form>`;
      },
    },
  );
  const context = renderer.contextForPage(PAGE, '/');
  const output = await renderer.renderString(
    "{% entityform name: 'First' %}{% webform name: 'Second' %}{% entityform name: 'Third' %}",
    context,
  );
  assert.equal(output, '<form data-form="First"></form>');
  assert.deepEqual(calls, ['entityform:First']);
  const ignored = context.__diagnostics.filter((diagnostic) => diagnostic.code === 'liquid-form-tag-ignored');
  assert.deepEqual(
    ignored.map(({ tag, name }) => ({ tag, name })),
    [
      { tag: 'webform', name: 'Second' },
      { tag: 'entityform', name: 'Third' },
    ],
  );
});

test('each ignored form tag of the same kind reports its own diagnostic naming its form', async () => {
  const renderer = createPortalRenderer(
    { pages: [PAGE], templates: {}, pageTemplates: [], settings: {}, snippets: {}, webFiles: [] },
    { renderComponent: async (tag, args) => `<form data-form="${args.name}"></form>` },
  );
  const context = renderer.contextForPage(PAGE, '/');
  await renderer.renderString(
    "{% entityform name: 'First' %}{% entityform name: 'Second' %}{% entityform name: 'Third' %}",
    context,
  );
  const ignored = context.__diagnostics.filter((diagnostic) => diagnostic.code === 'liquid-form-tag-ignored');
  assert.equal(ignored.length, 2);
  assert.ok(ignored[0].message.includes('entityform tag (Second)'), ignored[0].message);
  assert.ok(ignored[1].message.includes('entityform tag (Third)'), ignored[1].message);
});

test('the form tag limit does not apply to entitylist tags', async () => {
  const calls = [];
  const renderer = createPortalRenderer(
    {
      pages: [PAGE],
      templates: {},
      pageTemplates: [],
      settings: {},
      snippets: {},
      webFiles: [],
    },
    {
      renderComponent: async (tag, args) => {
        calls.push(`${tag}:${args.name}`);
        return '';
      },
    },
  );
  await renderer.renderString(
    "{% entityform name: 'First' %}{% entitylist name: 'Listing' %}{% endentitylist %}{% entityform name: 'Second' %}",
    renderer.contextForPage(PAGE, '/'),
  );
  assert.deepEqual(calls, ['entityform:First', 'entitylist:Listing']);
});

// @test-kind compatibility: Microsoft Learn (Dataverse Liquid tags): entityform and webform tags are available only in web template-based page templates; a Rewrite-based page renders no Liquid form tag, and the page's attached form is a page control.
test('a rewrite-based page renders no Liquid entityform or webform tag and reports each one, but keeps its attached form', async () => {
  const calls = [];
  const renderer = createPortalRenderer(
    {
      pages: [PAGE],
      templates: {},
      pageTemplates: [],
      settings: {},
      snippets: {},
      webFiles: [],
    },
    {
      renderComponent: async (tag, args) => {
        calls.push(`${tag}:${args.name ?? args.id}`);
        return `<form data-form="${args.name ?? args.id}"></form>`;
      },
    },
  );
  const context = renderer.contextForPage(PAGE, '/', { formTags: 'rewrite' });
  const output = await renderer.renderString(
    "{% entityform name: 'First' %}{% webform name: 'Second' %}{% entityform id: 'attached', pp_page_control: true %}",
    context,
  );
  assert.equal(output, '<form data-form="attached"></form>');
  assert.deepEqual(calls, ['entityform:attached']);
  const ignored = context.__diagnostics.filter((diagnostic) => diagnostic.code === 'liquid-form-tag-ignored');
  assert.deepEqual(
    ignored.map(({ tag, name }) => ({ tag, name })),
    [
      { tag: 'entityform', name: 'First' },
      { tag: 'webform', name: 'Second' },
    ],
  );
  assert.match(ignored[0].message, /rewrite-based page template/);
});

test('an ignored form tag name is carried verbatim in its diagnostic, so the diagnostic renderers must escape it', async () => {
  const hostile = '<img src=x onerror=1>';
  const renderer = createPortalRenderer(
    { pages: [PAGE], templates: {}, pageTemplates: [], settings: {}, snippets: {}, webFiles: [] },
    { renderComponent: async (tag, args) => `<form data-form="${args.name}"></form>` },
  );
  const context = renderer.contextForPage(PAGE, '/');
  await renderer.renderString(`{% entityform name: 'First' %}{% entityform name: '${hostile}' %}`, context);
  const [ignored] = context.__diagnostics.filter((diagnostic) => diagnostic.code === 'liquid-form-tag-ignored');
  assert.ok(ignored.message.includes(`entityform tag (${hostile})`), ignored.message);
});
