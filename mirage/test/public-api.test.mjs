import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator, createMirageContext, discoverPacks, presetLibrary, initialState } from '../api.mjs';
import { connectRuntime } from '../testing.mjs';
import { resolveLocalOverrides } from '../lib/local-overrides.mjs';
import { injectRuntimeCompatibility } from '../lib/source-dependencies.mjs';
import { platformStylesStatus, formStyleDiagnostics } from '../lib/platform-styles.mjs';

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-public-api-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'portal/web-pages'), { recursive: true });
  await fs.writeFile(path.join(root, 'portal/website.yml'), 'adx_name: Invented\nadx_websiteid: invented\n');
  await fs.writeFile(path.join(root, 'portal/web-pages/home.webpage.yml'), 'adx_name: Home\nadx_webpageid: home\nadx_partialurl: /\nadx_copy: <div>Home</div>\n');
  await fs.writeFile(path.join(root, 'paqvilo.config.yml'), 'sourceRoot: .\nsites:\n  invented:\n    source: portal\n    environments:\n      dev: https://invented.example.test\n');
  return root;
}

test('bootstrap preset mode preserves records on restart and always mode resets them', async t => {
  const root = await project(t), stateFile = path.join(root, 'state.json');
  const pack = { id: 'tiny', name: 'Tiny', description: 'Synthetic', matches: () => true, presets: () => ({ tiny: { name: 'Tiny', tables: { widget: [{ widgetid: 'seed', name: 'Seed' }] }, mappings: { widget: { idColumn: 'widgetid', entitySet: 'widgets' } }, settings: { permissionMode: 'permissive' } } }) };
  const options = { sourceDir: path.join(root, 'portal'), stateFile, packs: [pack], preset: 'tiny', presetMode: 'bootstrap', watch: false };
  let app = await createSimulator(options);
  try {
    assert.equal(app.state().status.startupPreset.applied, true);
    await app.store.create('widget', { widgetid: 'local', name: 'Local' }, {});
  } finally { await app.close(); }
  app = await createSimulator(options);
  try {
    assert.equal(app.state().status.startupPreset.applied, false);
    assert.deepEqual(app.store.snapshot().tables.widget.map(row => row.widgetid).sort(), ['local', 'seed']);
  } finally { await app.close(); }
  app = await createSimulator({ ...options, presetMode: 'always' });
  try { assert.deepEqual(app.store.snapshot().tables.widget.map(row => row.widgetid), ['seed']); }
  finally { await app.close(); }
});

test('local overrides confine files, preserve head order and disable bundled footer code', async t => {
  const root = await project(t);
  await fs.writeFile(path.join(root, 'extra.css'), 'body{color:purple}');
  await fs.writeFile(path.join(root, 'flags.js'), 'window.localFlag=true;');
  const localOverrides = resolveLocalOverrides({ compat: { footerSpacing: false }, head: { stylesheets: ['./extra.css'], scripts: ['./flags.js'] } }, root);
  assert.throws(() => resolveLocalOverrides({ compat: { typo: false } }, root), /Unknown adapter/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-head-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'outside.css'), 'body{}');
  assert.throws(() => resolveLocalOverrides({ head: { stylesheets: [path.join(outside, 'outside.css')] } }, root), /must stay inside the project/);
  assert.throws(() => resolveLocalOverrides({ head: { scripts: ['./extra.css'] } }, root), /Local scripts must be \.js files/);
  const simulator = await createSimulator({ sourceDir: path.join(root, 'portal'), localOverrides, watch: false });
  try {
    const html = await (await fetch(simulator.url)).text();
    assert.ok(html.includes('data-sim-local-only="head"'));
    assert.match(html, /\/_sim-local\/head\/1\.js[\s\S]*\/resource\/powerappsportal\//);
    assert.equal(await (await fetch(simulator.url + '/_sim-local/head/0.css')).text(), 'body{color:purple}');
    const app = await (await fetch(simulator.url + '/resource/powerappsportal/dist/app.bundle-123abc.js')).text();
    assert.ok(!app.includes('Local footer overlap repair'));
    assert.ok(app.includes('entity-grid'));
    const status = await (await fetch(simulator.url + '/_sim/api/status')).json();
    assert.equal(status.localOverrides.compat.footerSpacing, false);
    assert.equal(status.platformStyles.mode, 'placeholder');
    assert.ok(!injectRuntimeCompatibility('<html><body><footer>Footer</footer></body></html>', { compat: { footerSpacing: false } }).includes('footer-spacing-compat.js'));
  } finally { await simulator.close(); }
  const profile = { platformStyles: { mode: 'captured', capturedAt: '2026-10-12', origin: 'https://invented.example.test' } };
  assert.equal(platformStylesStatus(profile).mode, 'captured');
  assert.equal(formStyleDiagnostics('<div class="crmEntityFormView">', null)[0].code, 'PLATFORM_STYLES_PLACEHOLDER');
  assert.deepEqual(formStyleDiagnostics('<div class="crmEntityFormView">', profile), []);
});

test('local head assets remain confined when a directory is replaced after startup', async t => {
  const root = await project(t), outside = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-head-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'local'));
  await fs.writeFile(path.join(root, 'local/extra.css'), 'body{color:purple}');
  await fs.writeFile(path.join(outside, 'extra.css'), 'OUTSIDE_SOURCE_MUST_NOT_BE_SERVED');
  const localOverrides = resolveLocalOverrides({ head: { stylesheets: ['./local/extra.css'] } }, root);
  const simulator = await createSimulator({ sourceDir: path.join(root, 'portal'), localOverrides, watch: false });
  try {
    await fs.rename(path.join(root, 'local'), path.join(root, 'original-local'));
    await fs.symlink(outside, path.join(root, 'local'), process.platform === 'win32' ? 'junction' : 'dir');
    const response = await fetch(simulator.url + '/_sim-local/head/0.css');
    assert.equal(response.status, 500);
    assert.ok(!(await response.text()).includes('OUTSIDE_SOURCE_MUST_NOT_BE_SERVED'));
  } finally { await simulator.close(); }
});

test('bound context generates project presets consistently without global leakage', async t => {
  const root = await project(t);
  const pack = { id: 'invented', name: 'Invented', description: 'Synthetic pack', matches: () => true, presets: () => ({ 'invented-data': { name: 'Invented data', tables: { widget: [{ widgetid: 'one' }] }, mappings: { widget: { idColumn: 'widgetid' } } } }) };
  const context = await createMirageContext({ packs: [pack] });
  assert.deepEqual(await context.discoverPacks(), await discoverPacks({ packs: [pack] }));
  const store = new context.DataStore(); await store.applyPreset('invented-data');
  assert.equal(store.snapshot().tables.widget[0].widgetid, 'one');
  assert.deepEqual(context.resolvePreset('invented-data'), presetLibrary({ packs: [pack] })['invented-data']);
  const simulator = await context.createSimulator({ sourceDir: path.join(root, 'portal'), watch: false });
  try { await simulator.applyPreset('invented-data'); assert.equal((await (await fetch(simulator.url + '/_sim/api/records/widget')).json()).value[0].widgetid, 'one'); } finally { await simulator.close(); }
  assert.ok(!(await createMirageContext()).presetLibrary['invented-data']);
});

test('runtime client signs in configured persona, carries CSRF and resolves catalogue port', async t => {
  const root = await project(t);
  const simulator = await createSimulator({ sourceDir: path.join(root, 'portal'), watch: false, initial: { mappings: { contact: { idColumn: 'contactid', entitySet: 'contacts' } }, tables: { contact: [{ contactid: 'synthetic', fullname: 'Synthetic' }] }, simulator: { identity: { contactId: 'synthetic', roles: ['Tester'], roleSource: 'override' } } } });
  try {
    await fs.appendFile(path.join(root, 'paqvilo.config.yml'), `    mirage:\n      port: ${new URL(simulator.url).port}\n`);
    // Import canonicalizes the source; catalogues may retain a junction/alias spelling.
    await fs.symlink(path.join(root, 'portal'), path.join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir');
    await fs.writeFile(path.join(root, 'paqvilo.config.local.yml'), 'sites:\n  invented:\n    source: alias\n');
    const client = await connectRuntime({ config: path.join(root, 'paqvilo.config.yml'), site: 'invented' });
    assert.equal(client.origin, simulator.url);
    const headers = await client.signIn(null, { configuredPersona: true });
    const session = await (await fetch(simulator.url + '/_sim/api/session', { headers })).json();
    assert.equal(session.contactId, 'synthetic'); assert.deepEqual(session.roles, ['Tester']);
    assert.equal((await fetch(simulator.url + '/_sim/api/session/sign-in', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"contactId":"synthetic"}' })).status, 403);
    await client.setSnippet('Synthetic snippet', 'Local text');
    assert.equal((await client.state()).config.portalOverrides.snippets['Synthetic snippet'], 'Local text');
    await client.signOut();
  } finally { await simulator.close(); }
});

test('context reads the same explicitly configured project packs as the catalogue runtime', async t => {
  const root = await project(t);
  await fs.writeFile(path.join(root, 'pack.mjs'), `export default { id:'configured', name:'Configured', description:'Synthetic', matches:()=>true, presets:()=>({ 'configured-data': {name:'Configured', tables:{widget:[{widgetid:'configured'}]},mappings:{widget:{idColumn:'widgetid'}}}}) };`);
  await fs.appendFile(path.join(root, 'paqvilo.config.yml'), '    mirage:\n      dataPacks: [./pack.mjs]\n');
  const context = await createMirageContext({ config: path.join(root, 'paqvilo.config.yml'), site: 'invented' });
  const imported = await (await import('../lib/importer.mjs')).importPortal(path.join(root, 'portal'));
  const expected = initialState(imported, { origin: 'https://invented.example.test', packs: await discoverPacks({ explicit: [{ module: path.join(root, 'pack.mjs') }] }) });
  assert.deepEqual(context.initialState().presets['configured-data'], expected.presets['configured-data']);
  const store = new context.DataStore(); await store.applyPreset('configured-data');
  assert.equal(store.snapshot().tables.widget[0].widgetid, 'configured');
  await fs.writeFile(path.join(root, 'mirage.project.json'), JSON.stringify({ version: 2, portals: [{ id: 'invented', path: './portal' }], dataPacks: [{ id: 'configured', module: './pack.mjs' }], solutionOrder: 'explicit' }));
  await fs.appendFile(path.join(root, 'paqvilo.config.yml'), '      project: ./mirage.project.json\n');
  const projectContext = await createMirageContext({ config: path.join(root, 'paqvilo.config.yml'), site: 'invented' });
  assert.equal(projectContext.packs.length, 1, 'The same catalogue/project pack is bound once');
  const simulator = await projectContext.createSimulator({ watch: false });
  try {
    assert.equal(simulator.state().status.bootstrap.solutionOrder, 'explicit');
    await simulator.applyPreset('configured-data');
    assert.equal((await (await fetch(simulator.url + '/_sim/api/records/widget')).json()).value[0].widgetid, 'configured');
  } finally { await simulator.close(); }
});

test('local-only catalogue contexts start without inventing a live reference', async t => {
  const root = await project(t);
  await fs.writeFile(path.join(root, 'paqvilo.config.local.yml'), 'sites:\n  invented:\n    environments:\n      dev: http://127.0.0.1:8787\n');
  const context = await createMirageContext({ config: path.join(root, 'paqvilo.config.yml'), site: 'invented' });
  const simulator = await context.createSimulator({ watch: false });
  try { assert.equal(simulator.state().config.live.origin, null); }
  finally { await simulator.close(); }
});

test('a site-bound context reuses its portal import and exposes effective Solution roots',async t=>{
  const root=await project(t),portalDir=path.join(root,'portal');
  const config=path.join(root,'catalogue.yml');await fs.writeFile(config,'sourceRoot: .\nsites:\n  sample:\n    source: portal\n    mirage:\n      solutionRoots: [./solution]\n    environments:\n      local: http://127.0.0.1:8787\n');
  await fs.mkdir(path.join(root,'solution'));
  // importPortal resolves aliases such as Windows RUNNER~1 before reading. Count
  // its real file identity instead of the temporary directory's original spelling.
  const website=path.join(await fs.realpath(portalDir),'website.yml'),read=fs.readFile;let imports=0;
  t.mock.method(fs,'readFile',(file,...args)=>{if(path.relative(website,String(file))===''&&args[0]==='utf8')imports++;return read(file,...args);});
  const context=await createMirageContext({config,site:'sample'}),app=await context.createSimulator({watch:false});t.after(()=>app.close());
  assert.equal(imports,1);
  const status=await (await fetch(app.url+'/__sim/api/status')).json();assert.deepEqual(status.solutionRoots,[path.join(await fs.realpath(root),'solution')]);assert.deepEqual(app.state().status.solutionRoots,status.solutionRoots);
  const override=await context.createSimulator({sourceDir:portalDir,watch:false});t.after(()=>override.close());assert.equal(imports,2);
});
