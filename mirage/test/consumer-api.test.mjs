import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createSimulator, createMirageContext, discoverPacks, presetLibrary, initialState } from '../api.mjs';
import { connectRuntime } from '../testing.mjs';
import { resolveLocalOverrides } from '../lib/local-overrides.mjs';
import { injectRuntimeCompatibility } from '../lib/source-dependencies.mjs';
import { platformStylesStatus, formStyleDiagnostics } from '../lib/platform-styles.mjs';
import { captureCdpUrl, captureThroughRuntime, captureShell, captureSummary, captureExitCode } from '../capture-shell.mjs';

async function project(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-consumer-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'portal/web-pages'), { recursive: true });
  await fs.writeFile(path.join(root, 'portal/website.yml'), 'adx_name: Invented\nadx_websiteid: invented\n');
  await fs.writeFile(path.join(root, 'portal/web-pages/home.webpage.yml'), 'adx_name: Home\nadx_webpageid: home\nadx_partialurl: /\nadx_copy: <div>Home</div>\n');
  await fs.writeFile(path.join(root, 'paqvilo.config.yml'), 'sourceRoot: .\nsites:\n  invented:\n    source: portal\n    environments:\n      dev: https://invented.example.test\n');
  return root;
}

test('capture client preserves incomplete reports and other errors preserve the server message', async () => {
  const report = { shellProfile: {}, captured: [], failures: [{ code: 'ASSET_HTTP', path: '/missing.css' }], complete: false, applied: false };
  const client = await connectRuntime({ origin: 'http://127.0.0.1:9999', fetchImpl: async url => url.endsWith('/status') ? Response.json({}) : url.includes('/state?') ? Response.json({ csrf: 'synthetic' }) : url.endsWith('/assets/capture-shell') ? Response.json(report, { status: 409 }) : Response.json({ error: { message: 'Synthetic conflict' } }, { status: 409 }) });
  assert.deepEqual(await client.captureShell('/'), report);
  await assert.rejects(client.liveDisconnect(), /409.*Synthetic conflict/);
  const empty = await connectRuntime({ origin: 'http://127.0.0.1:9999', fetchImpl: async url => url.endsWith('/status') ? Response.json({}) : url.includes('/state?') ? Response.json({ csrf: 'synthetic' }) : new Response('', { status: 409 }) });
  await assert.rejects(empty.captureShell('/'), /Local runtime request failed \(409\)/);
});

test('capture all chooses one safe environment per configured site and reports caution skips', async t => {
  const root = await project(t), config = path.join(root, 'paqvilo.config.yml');
  await fs.writeFile(config, 'sourceRoot: .\nsites:\n  first:\n    source: portal\n    mirage: { port: 0 }\n    environments:\n      dev: https://invented.example.test\n      production: { url: https://production.example.test, caution: true }\n  second:\n    source: portal\n    mirage: { port: 0 }\n    environments:\n      dev: https://invented.example.test\n      production: { url: https://production.example.test, caution: true }\n');
  const starts = [];
  const report = await captureShell({ config, all: true, cdp: 'http://127.0.0.1:9222', createLocalSimulator: options => {
    starts.push(options.stateFile);
    const bridge = { origin: options.origin, connected: false, configure(value) { this.origin = value.origin; }, status() { return { connected: this.connected }; }, async connect() { this.connected = true; this.context = {}; return this.status(); }, async close() { this.connected = false; this.context = null; }, async request(route) { return { status: 200, headers: { 'content-type': route === '/' ? 'text/html' : route.endsWith('.css') ? 'text/css' : 'text/javascript' }, body: Buffer.from(route === '/' ? '<link rel="stylesheet" href="/theme.css"><script src="/jquery.js"></script>' : route.endsWith('.css') ? 'body{}' : 'window.jQuery={};') }; } };
    return createSimulator({ ...options, liveBridge: bridge }).then(async app => {
      if (starts.length === 1) {
        const state = app.store.snapshot();
        state.simulator.componentSchemas = { large: { fields: Array.from({ length: 25000 }, () => ({ name: 'synthetic' })) } };
        await app.store.replaceState(state);
      }
      return app;
    });
  } });
  assert.equal(report.complete, false);
  assert.equal(captureExitCode(report), 0);
  assert.equal(captureExitCode(report, { strict: true }), 1);
  assert.equal(report.reports[0].applied, true);
  assert.equal(report.reports[0].shellProfile.platformStyles.mode, 'captured');
  assert.equal(report.reports[0].richText.failures[0].code, 'RICHTEXT_SCHEMA_TRUNCATED');
  assert.equal(report.reports[1].complete, true);
  assert.deepEqual(report.reports.map(item => [item.site, item.env]), [['first', 'dev'], ['second', 'dev']]);
  assert.equal(new Set(starts).size, 2);
  assert.deepEqual(report.skipped.map(item => [item.site, item.env]), [['first', 'production'], ['second', 'production']]);
});

test('capture exit status follows usable shells, with strict completeness available explicitly', () => {
  const report = { complete: false, reports: [{ applied: true, ready: true, complete: false, failures: [{ code: 'SHELL_RESOURCE_ORIGIN', blocking: false }], richText: { complete: false, failures: [{ code: 'RICHTEXT_SCHEMA_TRUNCATED' }], diagnostics: [{ code: 'RICHTEXT_NATIVE_NOT_READY', message: 'Editor unavailable anonymously.' }] } }] };
  assert.equal(captureExitCode(report), 0);
  assert.equal(captureExitCode(report, { strict: true }), 1);
  assert.match(captureSummary(report), /RICHTEXT_SCHEMA_TRUNCATED/);
  assert.match(captureSummary(report), /RICHTEXT_NATIVE_NOT_READY/);
  report.reports[0].failures.push({ blocking: true });
  assert.equal(captureExitCode(report), 1);
  assert.equal(captureExitCode({ reports: [] }), 1);
});

test('installed CLI accepts applied partial shells and strict mode rejects their incompleteness', async t => {
  const root = await project(t), config = path.join(root, 'paqvilo.config.yml');
  const bridge = { origin: 'https://invented.example.test', connected: false, configure() {}, status() { return { connected: this.connected }; }, async connect() { this.connected = true; this.context = {}; }, async close() { this.connected = false; this.context = null; },
    async request(route) { return { status: 200, headers: { 'content-type': route === '/' ? 'text/html' : route.endsWith('.css') ? 'text/css' : 'text/javascript' }, body: Buffer.from(route === '/' ? '<link rel="stylesheet" href="/theme.css"><script src="/jquery.js"></script><link rel="stylesheet" href="https://third-party.example.test/theme.css">' : route.endsWith('.css') ? 'body{}' : 'window.jQuery={};') }; } };
  const app = await createSimulator({ sourceDir: path.join(root, 'portal'), origin: bridge.origin, stateFile: path.join(root, '.paqvilo/simulator/invented/state.json'), liveBridge: bridge, watch: false });
  t.after(() => app.close());
  await fs.appendFile(config, `    mirage: { port: ${new URL(app.url).port} }\n`);
  for (const strict of [false, true]) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url)), 'mirage', 'capture-shell', '--config', config, '--site', 'invented', '--cdp', 'http://127.0.0.1:9222', ...(strict ? ['--strict'] : [])], { windowsHide: true });
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    assert.equal(code, strict ? 1 : 0, errors);
    assert.equal(JSON.parse(output).reports[0].applied, true);
    assert.match(errors, /observed SHELL_RESOURCE_ORIGIN/);
    assert.equal(bridge.connected, false);
  }
});

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
    assert.ok(app.store.snapshot().tables.widget.some(row => row.widgetid === 'local'));
  } finally { await app.close(); }
  app = await createSimulator({ ...options, presetMode: 'always' });
  try { assert.deepEqual(app.store.snapshot().tables.widget.map(row => row.widgetid), ['seed']); }
  finally { await app.close(); }
});

test('capture CLI prints failed resources, exits one and disconnects the running runtime', async t => {
  const root = await project(t), sourceDir = path.join(root, 'portal');
  const bridge = { origin: 'https://invented.example.test', connected: false,
    configure() {}, status() { return { connected: this.connected }; },
    async connect() { this.connected = true; this.context = {}; return this.status(); },
    async close() { this.connected = false; this.context = null; },
    async request(route) { return route === '/' ? { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<link rel="stylesheet" href="/missing.css"><script src="/jquery.js"></script>') } : { status: 404, headers: { 'content-type': 'text/plain' }, body: Buffer.from('missing') }; },
  };
  const app = await createSimulator({ sourceDir, origin: bridge.origin, stateFile: path.join(root, '.paqvilo/simulator/invented/state.json'), watch: false, liveBridge: bridge });
  t.after(() => app.close());
  const config = path.join(root, 'paqvilo.config.yml');
  await fs.appendFile(config, `    mirage: { port: ${new URL(app.url).port} }\n`);
  const child = spawn(process.execPath, [fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url)), 'mirage', 'capture-shell', '--config', config, '--site', 'invented', '--cdp', 'http://127.0.0.1:9222', '--json'], { windowsHide: true });
  let output = '', errors = '';
  child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(code, 1, errors);
  const report = JSON.parse(output);
  assert.equal(report.reports[0].applied, false);
  assert.ok(report.reports[0].failures.some(item => item.code === 'NATIVE_ASSET_HTTP' && item.path === '/missing.css' && !item.blocking));
  assert.ok(report.reports[0].failures.some(item => item.code === 'SHELL_JQUERY_MISSING' && item.blocking));
  assert.equal(bridge.connected, false);
  const summary = captureSummary(report);
  assert.ok(summary.indexOf('BLOCKING SHELL_JQUERY_MISSING') < summary.indexOf('observed NATIVE_ASSET_HTTP'));
});

test('local overrides confine files, preserve head order and disable bundled footer code', async t => {
  const root = await project(t);
  await fs.writeFile(path.join(root, 'extra.css'), 'body{color:purple}');
  await fs.writeFile(path.join(root, 'flags.js'), 'window.localFlag=true;');
  const localOverrides = resolveLocalOverrides({ compat: { footerSpacing: false }, head: { stylesheets: ['./extra.css'], scripts: ['./flags.js'] } }, root);
  assert.throws(() => resolveLocalOverrides({ compat: { typo: false } }, root), /Unknown adapter/);
  assert.throws(() => resolveLocalOverrides({ head: { stylesheets: [path.join(root, '..', 'outside.css')] } }, root));
  const simulator = await createSimulator({ sourceDir: path.join(root, 'portal'), localOverrides, watch: false });
  try {
    const html = await (await fetch(simulator.url)).text();
    assert.ok(html.includes('data-sim-local-only="head"'));
    assert.ok(html.indexOf('/_sim-local/head/1.js') < html.indexOf('/resource/powerappsportal/'));
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

test('capture disconnects on failure and rejects untrusted targets before launch', async t => {
  const calls = [], client = { liveConnect: async () => calls.push('connect'), captureShell: async () => { calls.push('capture'); throw new Error('Synthetic failure'); }, liveDisconnect: async () => calls.push('disconnect') };
  await assert.rejects(captureThroughRuntime(client, 'http://127.0.0.1:9222', '/'), /Synthetic/);
  assert.deepEqual(calls, ['connect', 'capture', 'disconnect']);
  assert.throws(() => captureCdpUrl('http://external.example.test:9222'), /loopback/);
  const root = await project(t);
  await fs.writeFile(path.join(root, 'paqvilo.config.local.yml'), 'sites:\n  invented:\n    environments:\n      dev:\n        caution: true\n');
  await assert.rejects(captureShell({ config: path.join(root, 'paqvilo.config.yml'), site: 'invented', launchBrowser: () => { throw new Error('Browser should not launch'); } }), /caution/);
  await assert.rejects(captureShell({ config: path.join(root, 'paqvilo.config.yml'), path: 'https://external.example.test/' }), /relative/);
});

test('offline shell capture writes state and matching runtime capture uses its API exclusively', async t => {
  const root = await project(t), calls = [];
  const bridge = {
    origin: 'https://invented.example.test', connected: false,
    configure(value) { this.origin = value.origin; },
    status() { return { connected: this.connected, origin: this.origin }; },
    async connect() { this.connected = true; this.context = {}; calls.push('connect'); return this.status(); },
    async close() { this.connected = false; this.context = null; calls.push('disconnect'); },
    async request(route) {
      calls.push(route);
      return route === '/' ? { status: 200, headers: { 'content-type': 'text/html' }, body: Buffer.from('<html><head><link rel="stylesheet" href="/theme.css"><script src="/jquery.min.js"></script></head><body>Invented</body></html>') }
        : { status: 200, headers: { 'content-type': route.endsWith('.css') ? 'text/css' : 'text/javascript' }, body: Buffer.from(route.endsWith('.css') ? 'body{color:blue}' : 'window.jQuery={};') };
    },
  };
  const config = path.join(root, 'paqvilo.config.yml');
  const report = await captureShell({ config, site: 'invented', cdp: 'http://127.0.0.1:9222', createLocalSimulator: options => createSimulator({ ...options, liveBridge: bridge }) });
  assert.equal(report.complete, true);
  const stateFile = path.join(root, '.paqvilo/simulator/invented/state.json');
  const state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.equal(state.simulator.shellProfile.platformStyles.mode, 'captured');
  assert.equal(bridge.connected, false);
  assert.ok(calls.includes('connect') && calls.includes('/theme.css'));
  const simulator = await createSimulator({ sourceDir: path.join(root, 'portal'), stateFile, origin: bridge.origin, liveBridge: bridge, watch: false });
  try {
    await fs.appendFile(config, `    mirage:\n      port: ${new URL(simulator.url).port}\n`);
    const result = await captureShell({ config, site: 'invented', cdp: 'http://127.0.0.1:9222', createLocalSimulator: () => { throw new Error('Must use running runtime'); } });
    assert.equal(result.complete, true);
    assert.equal(bridge.connected, false);
    assert.equal(simulator.state().status.platformStyles.mode, 'captured');
    const missing = await connectRuntime({ origin: simulator.url });
    assert.deepEqual((await missing.status()).platformStyles.missingHeadStylesheets, []);
    await fs.writeFile(config, `sourceRoot: .\nsites:\n  invented:\n    source: portal\n    defaultEnv: other\n    mirage: { port: ${new URL(simulator.url).port} }\n    environments:\n      other: https://other.example.test\n      dev: https://invented.example.test\n      production: { url: https://production.example.test, caution: true }\n`);
    const all = await captureShell({ config, all: true, cdp: 'http://127.0.0.1:9222', createLocalSimulator: () => { throw new Error('Must use running runtime'); } });
    assert.equal(all.complete, true);
    assert.equal(all.reports[0].env, 'dev');
    assert.ok(all.skipped.some(item => item.env === 'other' && item.reason.includes('running runtime')));
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

test('runtime applies a bundled-jQuery shell despite verified native stylesheet defects', async t => {
  const root=await project(t), bundle='/resource/powerappsportal/dist/preform.BootstrapV5.moment_2_29_4.bundle-abcdef.js';
  const bridge={origin:'https://invented.example.test',connected:false,configure(){},status(){return{connected:this.connected}},async connect(){this.connected=true;this.context={};return this.status()},async close(){this.connected=false;this.context=null},async request(route){
    const assets={
      '/': ['text/html',`<link rel="stylesheet" href="/bad.css"><link rel="stylesheet" href="/style.css"><script src="${bundle}"></script>`],
      '/bad.css':['text/html','<html>Not CSS</html>'], '/style.css':['text/css','a{background:url(%22images%2Fmissing.png%22)}'], [bundle]:['application/javascript','window.jQuery=window.$={fn:{jquery:"3.6.2"}};'],
    };
    const entry=assets[route];return{status:entry?200:404,headers:{'content-type':entry?.[0]??'text/plain'},body:Buffer.from(entry?.[1]??'Not found')};
  }};
  const app=await createSimulator({sourceDir:path.join(root,'portal'),origin:bridge.origin,stateFile:path.join(root,'state.json'),watch:false,liveBridge:bridge});t.after(()=>app.close());
  const client=await connectRuntime({origin:app.url});const report=await captureThroughRuntime(client,'http://127.0.0.1:9222','/');
  assert.equal(report.applied,true);assert.equal(report.complete,true);assert.ok(report.failures.every(f=>f.nativeOriginFailed&&!f.blocking));
  assert.equal(app.state().config.shellProfile.jquery.source,bundle);assert.equal((await client.status()).platformStyles.mode,'captured');assert.equal(bridge.connected,false);
});
