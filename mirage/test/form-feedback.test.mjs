import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent } from '../lib/platform.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { model, parentId } from './fixtures/subgrid.mjs';
import { DataStore } from '../lib/data.mjs';

test('authored form labels preserve presentation markup and strip executable content', async () => {
  const { portal, schemas, state } = model();
  const cell = schemas.parent.layout[0].columns[0].sections[0].rows[0][1];
  cell.label = '<span class="x" onclick="evil()">A</span><script>evil()</script>';
  schemas.parent.fields[0].label = '<span class="field">Parent</span>';
  schemas.parent.layout[0].columns[0].sections[0].label = '<span class="section">Details</span><script>evil()</script>';
  schemas.parent.layout[0].columns[0].sections[0].showLabel = true;
  const store = await new DataStore({ state }).init();
  const options = { portal, schemas, store, readProvider: store, renderLiquid: async source => source };
  const context = { request: { params: { id: parentId } }, user: { id: 'editor', roles: ['Editor'] } };
  const encoded = await renderComponent('entityform', 'Parent', context, { ...options, config: { observed: { subgridLabelMarkup: 'encoded' } } });
  assert.match(encoded, /&lt;span class=&quot;x&quot;/);
  assert.throws(() => observedConfig({ subgridLabelMarkup: 'sanitized' }), /evidence/);
  assert.throws(() => observedConfig({ subgridLabelMarkup: 'raw', evidence: 'Synthetic' }), /encoded or sanitized/);
  assert.equal(observedConfig({ subgridLabelMarkup: 'sanitized', evidence: 'Synthetic fixture for an explicit per-site observation' }).subgridLabelMarkup, 'sanitized');
  const html = await renderComponent('entityform', 'Parent', context, options);
  assert.match(html, /class="field-label"><span class="x">A<\/span><\/label>/);
  assert.match(html, /<h3><span class="section">Details<\/span><\/h3>/);
  assert.match(html, /id="name_label" class="field-label"><span class="field">Parent<\/span><\/label>/);
  assert.doesNotMatch(html, /onclick="evil|<script>evil/);
});
