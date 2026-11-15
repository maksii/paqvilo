// @test-kind contract: metafilters parses an entitylist's metadata filter definition into its filter groups, each option checked by the mf query, and raises a LiquidError for a definition that is not JSON.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPortalRenderer, metafilterGroupsFor } from '../lib/liquid.mjs';

const LIST = '9a4d1c2e-0000-4000-8000-0000000000e1';
const PAGE = { id: 'p1', url: '/', name: 'Home', title: 'Home', metadata: {} };
// An attribute option set (id 0: Red, Blue) and a text filter (id 3), as an entitylist filter_definition holds them.
const DEFINITION = JSON.stringify({
  entity: {
    filters: [
      {
        'adx.id': '0',
        'adx.uiname': 'Colour',
        'adx.filtertype': 'attributefilterset',
        'adx.uiorder': '1',
        conditions: [
          { 'adx.id': '1', 'adx.uiname': 'Red', attribute: 'color', operator: 'eq', value: '1' },
          { 'adx.id': '2', 'adx.uiname': 'Blue', attribute: 'color', operator: 'eq', value: '2' },
        ],
      },
      {
        'adx.id': '3',
        'adx.uiname': 'Name',
        'adx.filtertype': 'textfilter',
        'adx.attribute': 'name',
        'adx.uiorder': '2',
      },
    ],
  },
});
// Each group as "id selection_mode" and each option as "id:type:checked:text".
const LISTING =
  '{% for g in groups %}{{ g.id }} {{ g.selection_mode }} {% for o in g.options %}{{ o.id }}:{{ o.type }}:{% if o.checked %}1{% else %}0{% endif %}:{{ o.text }} {% endfor %}|{% endfor %}';
const EXPECTED = '0 Multiple 1:option:1: 2:option:0: |3 Text 3:text:1:Contoso |';

function rendererWith(options = {}) {
  const portal = {
    pages: [PAGE],
    templates: {},
    pageTemplates: [],
    settings: {},
    snippets: {},
    webFiles: [],
  };
  const renderer = createPortalRenderer(portal, options);
  return (source, extra = {}) => renderer.renderString(source, renderer.contextForPage(PAGE, '/', extra));
}

test('metafilters returns the groups of a JSON definition, with the options the mf query selects checked', async () => {
  const render = rendererWith();
  assert.equal(
    await render(`{% assign groups = definition | metafilters: '0=1&3=Contoso' %}${LISTING}`, {
      definition: DEFINITION,
    }),
    EXPECTED,
  );
});

test('metafilters reads the filter definition of an entitylist record', async () => {
  const render = rendererWith({
    entity: async (table, id) =>
      table === 'adx_entitylist' && id === LIST
        ? { adx_entitylistid: LIST, adx_name: 'Listing', adx_filter_definition: DEFINITION }
        : null,
  });
  assert.equal(
    await render(`{% assign groups = entities.adx_entitylist['${LIST}'] | metafilters: '0=1&3=Contoso' %}${LISTING}`),
    EXPECTED,
  );
});

test('metafilters renders a LiquidError for a definition that is not JSON', async () => {
  const render = rendererWith();
  assert.equal(
    await render("{{ broken | metafilters: '' }}", { broken: 'not json' }),
    'Liquid error: Invalid filter definition provided to metafilters',
  );
});

test('metafilters keeps the grid settings error as the cause of a malformed definition', () => {
  assert.throws(
    () => metafilterGroupsFor('not json', ''),
    (error) =>
      error.message === 'Invalid filter definition provided to metafilters' &&
      error.cause?.code === 'GRID_SETTINGS_INVALID',
  );
});

test('metafilterGroupsFor rethrows an error that is not a DataError as the same object', () => {
  const failure = new TypeError('definition reader failed');
  const source = {
    get adx_filter_definition() {
      throw failure;
    },
  };
  assert.throws(
    () => metafilterGroupsFor(source, ''),
    (error) => error === failure,
  );
});

// Static import and export-from specifiers, read as canvas-asset-graph.test.mjs reads them. A dynamic import(...) has no whitespace before its parenthesis, so it is not matched.
const STATIC_SPECIFIER = /\b(?:import|export)\s+(?:[\w$*{},\s]+?\s+from\s+)?['"]([^'"]+)['"]/g;
const MIRAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every module file reachable from an entry through relative static imports. */
async function staticImportGraph(entry) {
  const seen = new Set();
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    for (const [, specifier] of (await readFile(file, 'utf8')).matchAll(STATIC_SPECIFIER))
      if (specifier.startsWith('./') || specifier.startsWith('../'))
        pending.push(path.resolve(path.dirname(file), specifier));
  }
  return seen;
}

// @test-kind contract: liquid.mjs reaches the native services and the server through no static import, so every Liquid render and test does not load them.
test('liquid.mjs reaches no native services or server module through its static imports', async () => {
  const graph = await staticImportGraph(path.join(MIRAGE, 'lib', 'liquid.mjs'));
  assert.equal(graph.has(path.join(MIRAGE, 'lib', 'liquid-filters.mjs')), true, 'the walk reaches liquid-filters.mjs');
  for (const file of [path.join(MIRAGE, 'lib', 'native-services.mjs'), path.join(MIRAGE, 'server.mjs')])
    assert.equal(graph.has(file), false, `liquid.mjs reaches ${file}`);
});
