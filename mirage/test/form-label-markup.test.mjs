import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent } from '../lib/platform.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { model, parentId } from './fixtures/subgrid.mjs';
import { DataStore } from '../lib/data.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../../lense/config.mjs';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('authored form labels preserve presentation markup and strip executable content', async () => {
  const { portal, schemas, state } = model();
  const cell = schemas.parent.layout[0].columns[0].sections[0].rows[0][1];
  cell.label = '<span class="x" onclick="evil()">A</span><script>evil()</script>';
  schemas.parent.fields[0].label = '<span class="field">Parent</span>';
  schemas.parent.layout[0].columns[0].sections[0].label = '<span class="section">Details</span><script>evil()</script>';
  schemas.parent.layout[0].columns[0].sections[0].showLabel = true;
  const store = await new DataStore({ state }).init();
  const options = { portal, schemas, store, readProvider: store, renderLiquid: async (source) => source };
  const context = { request: { params: { id: parentId } }, user: { id: 'editor', roles: ['Editor'] } };
  const encoded = await renderComponent('entityform', 'Parent', context, {
    ...options,
    config: { observed: { subgridLabelMarkup: 'encoded' } },
  });
  assert.match(encoded, /&lt;span class=&quot;x&quot;/);
  assert.throws(() => observedConfig({ subgridLabelMarkup: 'sanitized' }), /evidence/);
  assert.throws(() => observedConfig({ subgridLabelMarkup: 'raw', evidence: 'Synthetic' }), /encoded or sanitized/);
  assert.equal(
    observedConfig({
      subgridLabelMarkup: 'sanitized',
      evidence: 'Synthetic fixture for an explicit per-site observation',
    }).subgridLabelMarkup,
    'sanitized',
  );
  const html = await renderComponent('entityform', 'Parent', context, options);
  assert.match(html, /class="field-label"><span class="x">A<\/span><\/label>/);
  assert.match(html, /<h3><span class="section">Details<\/span><\/h3>/);
  assert.match(html, /id="name_label" class="field-label"><span class="field">Parent<\/span><\/label>/);
  assert.doesNotMatch(html, /onclick="evil|<script>evil/);
});

test('catalogue observations reach actual form rendering and runtime status', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-label-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'web-pages'));
  for (const [file, body] of Object.entries({
    'website.yml': 'adx_websiteid: site\nadx_name: Test',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': '{% entityform name: "Parent" %}',
    'Parent.basicform.yml': 'adx_entityformid: parent\nadx_name: Parent\nadx_entityname: parent\nadx_mode: 100000001',
  }))
    await fs.writeFile(path.join(root, file), body);
  for (const mode of ['encoded', 'sanitized', null]) {
    const initial = model().state;
    initial.simulator.componentSchemas.parent.layout[0].columns[0].sections[0].rows[0][1].label =
      '<span class="x">A</span>';
    const observed = mode ? { subgridLabelMarkup: mode, evidence: 'Synthetic label observation' } : undefined;
    const file = path.join(root, 'catalogue.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        sites: {
          fixture: {
            source: root,
            environments: { dev: 'https://invented.example.test' },
            mirage: { solutionRoots: [], observed },
          },
        },
      }),
    );
    const cfg = await loadConfig({ config: file, site: 'fixture' });
    const app = await createSimulator({
      sourceDir: cfg.sourceDir,
      observed: cfg.mirageConfig.observed,
      initial,
      watch: false,
    });
    try {
      const response = await fetch(app.url + '/?id=' + parentId, {
        headers: signInHeaders(app, 'editor', { roles: ['Editor'] }),
      });
      assert.equal(response.status, 200);
      const html = await response.text();
      if (mode === 'encoded') assert.match(html, /&lt;span class=&quot;x&quot;&gt;A/);
      else assert.match(html, /<span class="x">A<\/span>/);
      const status = await (await fetch(app.url + '/_sim/api/status')).json();
      assert.equal(status.observed?.subgridLabelMarkup, mode ?? undefined);
      assert.equal(status.subgridLabelMarkup, mode ?? 'sanitized');
    } finally {
      await app.close();
    }
  }
});
