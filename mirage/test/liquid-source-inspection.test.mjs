import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';

test('Liquid capability inspection checks page, snippet and component sources in every imported language', () => {
  const template = { id: 'layout', name: 'Layout', source: '{{ page.title }}' };
  const broken = '{% if %}';
  const portal = {
    templates: { layout: template, Layout: template },
    pages: [
      {
        id: 'home',
        name: 'Home',
        html: '<p>Home</p>',
        js: broken,
        css: 'body {}',
        translations: { en: { html: '<p>Home</p>' }, fr: { html: broken, css: 'body {}' } },
      },
    ],
    snippets: { Greeting: 'Hello', Malformed: broken },
    snippetTranslations: { en: { Greeting: 'Hello' }, fr: { Greeting: broken } },
    forms: [{ id: 'create', name: 'Create', js: broken }],
    lists: [{ id: 'items', name: 'Items', js: broken }],
    records: [
      { kind: 'advancedformstep', id: 'details', name: 'Details', customJavascript: broken },
      { kind: 'advancedformstep', id: 'inactive', adx_statecode: 1, customJavascript: broken },
    ],
  };
  const report = createPortalRenderer(portal).inspectCapabilities();
  assert.equal(report.templateCount, 1, 'template aliases are counted once');
  assert.equal(report.parsePassed, 1, 'the existing template-only counter remains compatible');
  assert.equal(report.sourceCount, 11);
  assert.equal(report.sourceParsePassed, 4);
  assert.equal(report.diagnostics.length, 7);
  assert.deepEqual(
    report.diagnostics.map(({ kind }) => kind),
    ['page', 'page', 'content-snippet', 'content-snippet', 'basic-form', 'list', 'advanced-form-step'],
  );
  assert.equal(report.diagnostics.find(({ language }) => language === 'fr').field, 'html');
  assert.ok(report.diagnostics.every(({ code }) => code === 'source-parse-error'));
  assert.doesNotMatch(JSON.stringify(report), /\{%/, 'the report does not copy source bodies');
});

test('Liquid inspection retains template diagnostics and accepts an empty imported source', () => {
  const renderer = createPortalRenderer({
    templates: {
      bad: { id: 'bad', name: 'Bad', source: '{% unknown_tag %}' },
      empty: { id: 'empty', name: 'Empty', source: '' },
    },
  });
  const report = renderer.inspectCapabilities();
  assert.equal(report.templateCount, 2);
  assert.equal(report.parsePassed, 1);
  assert.equal(report.sourceCount, 1);
  assert.equal(report.sourceParsePassed, 0);
  assert.equal(report.diagnostics[0].code, 'template-parse-error');
  assert.equal(report.diagnostics[0].templateId, 'bad');
});
