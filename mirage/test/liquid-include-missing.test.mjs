// @test-kind security: a missing include renders its name as encoded literal text, so a name is never evaluated as Liquid or emitted as markup.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';

function plainRender() {
  const renderer = createPortalRenderer({
    templates: {},
    snippets: {},
    settings: {},
    pages: [],
    webFiles: [],
    records: [],
    weblinks: {},
    sitemarkers: {},
    website: {},
    pageTemplates: [],
  });
  return (source) => renderer.renderString(source, {});
}

// @test-kind observation: native portal render captured 2026-11-12 on a developer environment (single capture): a missing include renders Template "name" not found. and the name is never evaluated.
test('a missing include with a plain name renders the platform text', async () => {
  const render = plainRender();
  assert.equal(
    await render("{% include 'paqvilo-no-such-template' %}"),
    'Template "paqvilo-no-such-template" not found.',
  );
});

// @test-kind security: a missing include name is inserted as encoded literal text, never evaluated as Liquid or emitted as markup.
test('a missing include whose name holds Liquid and markup inserts the name as encoded text', async () => {
  const render = plainRender();
  const html = await render("{% assign t = '{{ 7 | times: 6 }}<b>x</b>' %}{% include t %}");
  assert.equal(html, 'Template "&#123;&#123; 7 | times: 6 }}&lt;b&gt;x&lt;/b&gt;" not found.');
  assert.doesNotMatch(html, /42/);
  assert.doesNotMatch(html, /<b>/);
});
