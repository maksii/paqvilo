// App surfaces in both hosts (lib/organization-host.mjs): /_apps/canvas/ lists the Solution inventory's canvas apps and
// /_apps/code/<app>/ serves the configured code app, both before the model-driven handler; /main.aspx keeps its answer.
// runtime state reports inventory counts, provider descriptors and service fixtures. Invented sources, loopback only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';

const solutionFiles = {
  'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedApps</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'solution/Entities/x_item/Entity.xml': '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
  'solution/CanvasApps/x_inventedapp_1a2b3.meta.xml': '<CanvasApp><Name>x_inventedapp_1a2b3</Name><DisplayName>Invented canvas</DisplayName></CanvasApp>',
  'app/power.config.json': JSON.stringify({ appId: '77777777-7777-4777-8777-0000000000d1', localAppUrl: 'http://127.0.0.1:5199/' }),
};
const portalFiles = {
  'portal/website.yml': 'adx_name: Invented Site\nadx_websiteid: site\nadx_defaultlanguage: lang-en\nadx_website_language: 1033',
  'portal/websitelanguage.yml': '- adx_websitelanguageid: lang-en\n  adx_name: English',
  'portal/web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
  'portal/page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main',
  'portal/web-templates/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
  'portal/web-templates/Main.webtemplate.source.html': '<p>Invented</p>',
};

async function write(root, files) {
  for (const [name, body] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true }); await fs.writeFile(path.join(root, name), body); }
}

async function hosts(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'host-app-surfaces-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await write(root, { ...solutionFiles, ...portalFiles });
  const common = { solutionRoots: [path.join(root, 'solution')], projectRoot: root, port: 0, watch: false, codeApps: [{ name: 'invented-app', dir: 'app' }] };
  const standalone = await createSimulator({ ...common, runtime: { kind: 'dataverse-api' }, simulation: { level: 'dry-run' }, dataverse: { enabled: true, tls: false, tds: { enabled: false } } });
  t.after(() => standalone.close());
  const portal = await createSimulator({ ...common, sourceDir: path.join(root, 'portal'), stateFile: path.join(root, 'state.json'),
    initial: { version: 1, mappings: {}, tables: {}, permissions: [], simulator: { mode: 'local', pageMode: 'local', permissionSource: 'configured', live: { allowWrites: false }, endpoints: [] } } });
  t.after(() => portal.close());
  return { standalone, portal };
}

test('both hosts serve /_apps/canvas/ and /_apps/code/<app>/ before the model-driven handler', async (t) => {
  const { standalone, portal } = await hosts(t);
  for (const [name, sim] of [['standalone', standalone], ['portal', portal]]) {
    const canvas = await fetch(`${sim.url}/_apps/canvas/`, { headers: { accept: 'application/json' } });
    assert.equal(canvas.status, 200, name);
    const listed = await canvas.json();
    // The host runs canvas apps headlessly (canvas-runtime.mjs); this app has no readable source, so it stays inventory.
    assert.equal(listed.level, 'behaviour', name);
    assert.equal(listed.apps[0].level, 'inventory', name);
    assert.deepEqual(listed.apps.map((app) => app.uniqueName), ['x_inventedapp_1a2b3'], name);
    // The code app answers its own contract: a staff session is required before the context is shown.
    const context = await fetch(`${sim.url}/_apps/code/invented-app/context`);
    assert.equal(context.status, 401, name);
    assert.equal((await context.json()).error.code, 'StaffSessionRequired', name);
    const missing = await fetch(`${sim.url}/_apps/code/unknown-app/context`);
    assert.equal((await missing.json()).error.code, 'CodeAppNotFound', name);
  }
  // The portal host's model-driven shell keeps answering /main.aspx.
  const shell = await fetch(`${portal.url}/main.aspx`, { redirect: 'manual' });
  assert.notEqual(shell.status, 404);
  assert.equal(shell.headers.get('content-type')?.includes('application/json') && (await shell.json()).error?.code === 'CanvasAppNotFound', false);
});

test('runtime state reports inventory counts, provider descriptors and service fixtures in both hosts', async (t) => {
  const { standalone, portal } = await hosts(t);
  for (const [name, state] of [['standalone', standalone.status()], ['portal', portal.state()]]) {
    assert.equal(state.inventory.components.canvasapp.count, 1, name);
    assert.equal(state.inventory.components.canvasapp.levels.inventory, 1, name);
    assert.ok(Array.isArray(state.providers.connectors) && state.providers.connectors.some((provider) => provider.id === 'http'), name);
    assert.ok(state.providers.storage && state.providers.outbox, name);
    assert.equal(state.providers.secrets, null, `${name}: no secrets config, no resolver`);
    assert.ok(Array.isArray(state.services), name);
    assert.equal(state.capabilities.canvas, 'behaviour', name);
    assert.equal(state.capabilities.codeApps, 'contract', name);
  }
});
