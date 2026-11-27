// @test-kind contract: a web template component include binds every parameter to its evaluated Liquid expression in the caller's context (DotLiquid Include tag, liquid-engine.mjs IncludeTag), so numbers, booleans, objects and arrays reach the component unchanged; Learn power-pages/configure/web-templates-as-components says the design studio passes strings, which the component converts with filters
import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';

const LEARN = 'https://learn.microsoft.com/power-pages/configure/web-templates-as-components';
const MANIFEST =
  '{% manifest %}{"type":"Functional","displayName":"Invented cards","params":[{"id":"title"},{"id":"count"},{"id":"flag"},{"id":"item"},{"id":"list"}]}{% endmanifest %}';

function render(component, source) {
  const renderer = createPortalRenderer({
    templates: { cards: { id: 'cards', name: 'Invented Cards', source: MANIFEST + component } },
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
  return renderer.renderString(source, {});
}

test('numbers, booleans and arrays reach a component as their own types', async () => {
  const html = await render(
    '[{{ title }}|{{ count | plus: 1 }}{% if count == 4 %}n{% endif %}|{% if flag %}on{% else %}off{% endif %}|{{ list | size }}:{{ list | join: "+" }}]',
    "{% assign things = 'lamp,quay' | split: ',' %}" +
      "{% include 'Invented Cards' title: 'Topics' count: 4 flag: false list: things %}",
  );
  assert.equal(html, '[Topics|5n|off|2:lamp+quay]');
});

test('an object parameter exposes its members and a variable parameter its current value', async () => {
  const html = await render(
    '[{{ item.size }}|{{ item.first }}|{{ count | times: 2 }}|{% if flag == true %}yes{% endif %}]',
    "{% assign words = 'one,two,three' | split: ',' %}{% assign n = 21 %}" +
      "{% include 'Invented Cards' item: words count: n flag: true %}",
  );
  assert.equal(html, '[3|one|42|yes]');
});

test('a string parameter still converts with filters, as Learn recommends for studio-set values', async () => {
  const html = await render(
    '[{{ count }}|{{ count | integer | plus: 1 }}|{% if count == 4 %}number{% else %}string{% endif %}]',
    "{% include 'Invented Cards' count: '04' %}",
  );
  assert.equal(html, '[04|5|string]', `${LEARN}: "All parameters are passed as strings"`);
});

test('a parameter binds only inside the component and does not leak to the caller', async () => {
  const html = await render('[{{ count }}]', "{% include 'Invented Cards' count: 7 %}({{ count }})");
  assert.equal(html, '[7]()');
});
