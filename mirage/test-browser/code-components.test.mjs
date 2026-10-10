import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';
import http from 'node:http';

test('standard PCF host loads only declared local resources and preserves lifecycle, bound output and disabled context', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-pcf-browser-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const id='d0000000-0000-4000-8000-000000000001';
  const portal=path.join(root,'portal'),solution=path.join(root,'solution');
  const files={
    'portal/website.yml':'adx_websiteid: site\nadx_name: Synthetic PCF',
    'portal/Home.webpage.yml':'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml':'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'portal/Main.webtemplate.yml':'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':`<html><body>{% codecomponent name:${id} value:'Initial' disabled:true %}<script>document.addEventListener('paqvilo:pcf-output',e=>window.output=e.detail);</script></body></html>`,
    'solution/Other/Solution.xml':'<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Controls/tst_Synthetic.Editor/ControlManifest.xml':'<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><resources><code path="bundle.js"/><css path="style.css"/></resources></control></manifest>',
    'solution/Controls/tst_Synthetic.Editor/ControlManifest.xml.data.xml':'<CustomControl><Name>tst_Synthetic.Editor</Name></CustomControl>',
    'solution/Controls/tst_Synthetic.Editor/style.css':'.synthetic-editor{--pcf-source:declared;}',
    'solution/Controls/tst_Synthetic.Editor/bundle.js':`window.ComponentFramework.registerControl('Synthetic.Editor',class{init(context,notify,state,container){window.lifecycle=['init'];this.input=document.createElement('input');this.input.className='synthetic-editor';this.input.value=context.parameters.value.raw;this.input.disabled=context.mode.isControlDisabled;this.input.addEventListener('input',notify);container.appendChild(this.input);}updateView(context){window.lifecycle.push('update');window.disabled=context.mode.isControlDisabled;}getOutputs(){return{value:this.input.value};}destroy(){window.lifecycle.push('destroy');}});`,
  };
  for(const[name,text]of Object.entries(files)){const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);}
  const app=await createSimulator({sourceDir:portal,solutionRoots:[solution],port:0,watch:false,observed:{codeComponents:{[id]:'tst_Synthetic.Editor'},evidence:'Invented fixture manifest and literal tag'}});
  t.after(()=>app.close());
  const browser=await chromium.launch(browserLaunchOptions({headless:true}));t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!request.url().startsWith(app.url))external.push(request.url());});
  await page.goto(app.url);await page.locator('[data-pcf-ready=true]').waitFor();
  assert.equal(await page.locator('input').inputValue(),'Initial');assert.ok(await page.locator('input').isDisabled());
  assert.equal(await page.locator('input').evaluate(node=>getComputedStyle(node).getPropertyValue('--pcf-source')),'declared');
  await page.locator('input').evaluate(node=>{node.value='Output';node.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.deepEqual(await page.evaluate(()=>window.output),{value:'Output'});assert.ok((await page.evaluate(()=>window.lifecycle)).includes('update'));
  const catalogPath=await page.locator('script[src*="/__sim-static/pcf/"]').getAttribute('src');
  assert.equal((await fetch(app.url+catalogPath.replace('bundle.js','secret.js'))).status,404);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});

async function hostFixture(t) {
  const host = await fs.readFile(new URL('../lib/code-components-client.js', import.meta.url), 'utf8');
  const requests = [];
  const server = http.createServer((request, response) => {
    if (request.url === '/host.js') { response.setHeader('Content-Type', 'text/javascript'); response.end(host); return; }
    if (request.url === '/image.bin') { response.end(Buffer.alloc(512 * 1024, 97)); return; }
    if (request.url.startsWith('/_api/')) {
      requests.push({ url: request.url, method: request.method, headers: request.headers });
      response.setHeader('Content-Type', 'application/json');
      if (request.method === 'POST') { response.statusCode = 204; response.setHeader('OData-EntityId', '/_api/tst_rows(d0000000-0000-4000-8000-000000000002)'); response.end(); }
      else if (request.url.includes('denied')) { response.statusCode = 403; response.end(JSON.stringify({ error: { code: 'AccessDenied', message: 'Fixture permission denied' } })); }
      else response.end(JSON.stringify({ value: [{ tst_rowid: 'd0000000-0000-4000-8000-000000000002', tst_title: 'Visible row' }] }));
      return;
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<html><body><script src="/host.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.goto('http://127.0.0.1:' + server.address().port);
  return { page, requests };
}

test('PCF repeated controls have separate instances and state, typed parameters, bounded binary resources and removal cleanup', async t => {
  const { page } = await hostFixture(t);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(async () => {
    window.contexts = []; window.states = []; window.destroyed = []; window.notifications = [];
    document.addEventListener('paqvilo:pcf-output', event => window.notifications.push(event.detail));
    ComponentFramework.registerControl('Synthetic.Types', class {
      init(context, notify, state, container) {
        this.container = container; this.context = context; this.notify = notify;
        contexts.push(context); states.push(state); context.mode.trackContainerResize(true);
        context.mode.setControlState({ owner: container.id });
        container.style.width = '200px'; container.style.height = '40px';
        container.addEventListener('output', notify);
      }
      updateView(context) { this.container.dataset.updates = String(Number(this.container.dataset.updates || '0') + 1); this.container.dataset.updatedProperties = context.updatedProperties.join(','); }
      getOutputs() { return { choice: 4, inputOnly: 'must not propagate' }; }
      destroy() { destroyed.push(this.container.id); }
    });
    const spec = { id: 'same', constructor: 'Synthetic.Types', resources: [{ kind: 'img', url: '/image.bin' }], properties: [
      { name: 'choice', 'of-type': 'OptionSet', usage: 'bound' },
      { name: 'flags', 'of-type': 'MultiSelectOptionSet', usage: 'bound' },
      { name: 'reference', 'of-type': 'Lookup.Simple', usage: 'bound' },
      { name: 'enabled', 'of-type': 'TwoOptions', usage: 'input', 'default-value': '1' },
      { name: 'count', types: ['Whole.None'], usage: 'input', 'default-value': '7' },
      { name: 'grouped', types: ['Whole.None', 'FP', 'Decimal'], usage: 'input', 'default-value': '7.25' },
      { name: 'inputOnly', 'of-type': 'SingleLine.Text', usage: 'input' },
    ], strings: {}, args: { choice: '3', flags: '1,2', reference: { id: 'd0000000-0000-4000-8000-000000000002', entityType: 'tst_row', name: 'Selected' } }, identity: { roles: [] }, mappings: {} };
    for (let index = 0; index < 2; index++) { const target = document.createElement('div'); document.body.append(target); await window.__paqviloPcf.mount(spec, target); }
  });
  assert.equal(await page.locator('[data-pcf-ready]').count(), 2);
  assert.deepEqual(await page.evaluate(() => Array.from(document.querySelectorAll('[data-pcf-ready]'), node => node.id)), ['same-1', 'same-2']);
  assert.deepEqual(await page.evaluate(() => ({ choice: contexts[0].parameters.choice.raw, flags: contexts[0].parameters.flags.raw, reference: contexts[0].parameters.reference.raw, enabled: contexts[0].parameters.enabled.raw, count: contexts[0].parameters.count.raw, grouped: contexts[0].parameters.grouped.raw, groupedType: contexts[0].parameters.grouped.type })), {
    choice: 3, flags: [1, 2], reference: [{ id: 'd0000000-0000-4000-8000-000000000002', entityType: 'tst_row', name: 'Selected' }], enabled: true, count: 7, grouped: 7.25, groupedType: 'Decimal',
  });
  assert.deepEqual(await page.evaluate(() => states), [{}, {}]);
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('paqvilo-pcf:same-1')).owner), 'same-1');
  assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('paqvilo-pcf:same-2')).owner), 'same-2');
  await page.locator('#same-1').evaluate(node => node.dispatchEvent(new Event('output')));
  await page.waitForFunction(() => document.getElementById('same-1').dataset.updatedProperties === 'choice');
  assert.deepEqual(await page.evaluate(() => notifications), [{ choice: 4 }]);
  assert.equal(await page.evaluate(() => new Promise((resolve, reject) => contexts[0].resources.getResource('image.bin', value => resolve(atob(value).length), reject))), 512 * 1024);
  await page.locator('#same-1').evaluate(node => { node.style.width = '250px'; });
  await page.waitForFunction(() => contexts[0].mode.allocatedWidth === 250);
  await page.locator('#same-1').evaluate(node => node.remove());
  await page.waitForFunction(() => destroyed.length === 1);
  assert.deepEqual(await page.evaluate(() => destroyed), ['same-1']);
  assert.equal(await page.locator('[data-pcf-ready]').count(), 1);
  assert.deepEqual(errors, []);
});

test('PCF Web API honors entity mappings, CSRF, page size and native create IDs while rejecting navigation in queries and record IDs', async t => {
  const { page, requests } = await hostFixture(t);
  await page.evaluate(async () => {
    window.shell = { getTokenDeferred: () => ({ done(callback) { callback('fixture-token'); return this; }, fail() { return this; } }) };
    ComponentFramework.registerControl('Synthetic.Api', class { init(context) { window.context = context; } updateView() {} });
    const target = document.createElement('div'); document.body.append(target);
    await __paqviloPcf.mount({ id: 'api', constructor: 'Synthetic.Api', resources: [], properties: [], strings: {}, args: {}, identity: { roles: [] }, mappings: { tst_row: { entitySet: 'tst_rows' } } }, target);
  });
  const result = await page.evaluate(() => context.webAPI.retrieveMultipleRecords('TST_ROW', '?$select=tst_title', 2));
  assert.equal(result.entities[0].tst_title, 'Visible row');
  assert.equal(requests[0].url, '/_api/tst_rows?$select=tst_title');
  assert.equal(requests[0].headers.__requestverificationtoken, 'fixture-token');
  assert.equal(requests[0].headers.prefer, 'odata.maxpagesize=2');
  assert.deepEqual(await page.evaluate(() => context.webAPI.createRecord('tst_row', { tst_title: 'New row' })), { id: 'd0000000-0000-4000-8000-000000000002', entityType: 'tst_row' });
  const before = requests.length;
  const rejected = await page.evaluate(async () => {
    const failures = [];
    for (const operation of [() => context.webAPI.retrieveMultipleRecords('tst_row', 'https://example.invalid/data'), () => context.webAPI.retrieveRecord('tst_row', '../admin'), () => context.webAPI.retrieveMultipleRecords('missing', ''), () => context.webAPI.retrieveMultipleRecords('tst_row', '?x=1#fragment'), () => context.webAPI.retrieveMultipleRecords('tst_row', '', 0)]) {
      try { await operation(); } catch (error) { failures.push(error.message); }
    }
    return failures;
  });
  assert.equal(rejected.length, 5); assert.equal(requests.length, before);
  assert.deepEqual(await page.evaluate(async () => { try { await context.webAPI.retrieveMultipleRecords('tst_row', '?denied=true'); } catch (error) { return { message: error.message, code: error.errorCode }; } }), { message: 'Fixture permission denied', code: 'AccessDenied' });
});
test('PCF native outputs update only the scoped native field and preserve read-only, lookup and choice form inputs', async t => {
  const { page } = await hostFixture(t);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(async () => {
    window.nativeOutputs = {}; window.dirty = 0; window.nativeChanges = 0;
    window.setIsDirty = () => dirty++;
    ComponentFramework.registerControl('Synthetic.Native', class {
      init(context, notify, state, container) { this.container = container; window.nativeContext = context; container.addEventListener('output', notify); }
      updateView() {}
      getOutputs() { return { value: nativeOutputs[this.container.dataset.test] }; }
    });
    const cases = [
      ['text', '<input id="native" value="Before">', 'text', 'SingleLine.Text', 'After', false],
      ['readonly', '<input id="native" readonly value="Before">', 'text', 'SingleLine.Text', 'After', false],
      ['disabled', '<input id="native" value="Before">', 'text', 'SingleLine.Text', 'After', true],
      ['bool', '<input id="native" type="checkbox">', 'boolean', 'TwoOptions', true, false],
      ['radio', '<div id="native"><input type="radio" name="pick" value="1" checked><input type="radio" name="pick" value="2"></div>', 'picklist', 'OptionSet', 2, false],
      ['multi', '<select id="native" multiple><option value="1" selected>One</option><option value="2">Two</option></select>', 'multiselect', 'MultiSelectOptionSet', [2], false],
      ['date', '<input id="native" type="date">', 'datetime', 'DateAndTime.DateOnly', new Date('2026-01-02T00:00:00Z'), false],
      ['lookup', '<input id="native" type="hidden"><input id="native_name" readonly><input id="native_entityname">', 'lookup', 'Lookup.Simple', [{ id: 'd0000000-0000-4000-8000-000000000004', name: 'Selected row', entityType: 'tst_row' }], false],
    ];
    for (const [key, markup, control, type, output, disabled] of cases) {
      const wrapper = document.createElement('section'); wrapper.dataset.pcfNativeField = key; wrapper.innerHTML = markup;
      wrapper.addEventListener('change', () => nativeChanges++); document.body.append(wrapper);
      const target = document.createElement('div'); target.dataset.test = key; wrapper.append(target); nativeOutputs[key] = output;
      await __paqviloPcf.mount({ id: key, constructor: 'Synthetic.Native', resources: [], properties: [{ name: 'value', 'of-type': type, usage: 'bound' }], strings: {}, args: { disabled }, identity: { roles: [] }, mappings: {}, nativeBinding: { id: 'native', control, properties: ['value'] }, language: { code: 'fr-FR', lcid: 1036, isRTL: false } }, target);
      target.dispatchEvent(new Event('output'));
    }
  });
  assert.equal(await page.locator('[data-pcf-native-field="text"] input').inputValue(), 'After');
  assert.equal(await page.locator('[data-pcf-native-field="readonly"] input').inputValue(), 'Before');
  assert.equal(await page.locator('[data-pcf-native-field="disabled"] input').inputValue(), 'Before');
  assert.equal(await page.locator('[data-pcf-native-field="bool"] input').isChecked(), true);
  assert.equal(await page.locator('[data-pcf-native-field="radio"] input[value="2"]').isChecked(), true);
  assert.deepEqual(await page.locator('[data-pcf-native-field="multi"] select').evaluate(node => Array.from(node.selectedOptions, option => option.value)), ['2']);
  assert.equal(await page.locator('[data-pcf-native-field="date"] input').inputValue(), '2026-01-02');
  assert.deepEqual(await page.locator('[data-pcf-native-field="lookup"] input').evaluateAll(nodes => nodes.map(node => node.value)), ['d0000000-0000-4000-8000-000000000004', 'Selected row', 'tst_row']);
  assert.equal(await page.evaluate(() => dirty), 6);
  assert.equal(await page.evaluate(() => nativeChanges), 9);
  assert.equal(await page.evaluate(() => nativeContext.userSettings.languageId), 1036);
  assert.match(await page.evaluate(() => nativeContext.formatting.formatDecimal(1234.5)), /,5$/);
  assert.deepEqual(errors, []);
});
test('native form scripts update PCF context without feedback recursion, removed controls detach and runtime failures restore native fallback', async t => {
  const { page } = await hostFixture(t);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.evaluate(async () => {
    window.syncContexts = {}; window.syncUpdates = {}; window.syncOutputs = 0;
    document.addEventListener('paqvilo:pcf-output', () => syncOutputs++);
    ComponentFramework.registerControl('Synthetic.Sync', class {
      init(context, notify, state, container) { this.key = container.dataset.test; this.notify = notify; syncContexts[this.key] = context; }
      updateView(context) { syncUpdates[this.key] = (syncUpdates[this.key] || 0) + 1; if (context.updatedProperties.length) this.notify(); }
      getOutputs() { return { value: syncContexts[this.key].parameters.value.raw }; }
    });
    for (const [key, type, markup, control, value, disabled] of [
      ['text', 'SingleLine.Text', '<input id="original" value="Initial">', 'text', 'Initial', false],
      ['readonly', 'SingleLine.Text', '<input id="original" readonly value="Initial">', 'text', 'Initial', true],
      ['lookup', 'Lookup.Simple', '<input id="original" type="hidden"><input id="original_name" readonly><input id="original_entityname" type="hidden">', 'lookup', null, false],
      ['date', 'DateAndTime.DateOnly', '<input id="original" type="date" value="2026-01-01">', 'datetime', '2026-01-01', false],
      ['multi', 'MultiSelectOptionSet', '<input id="original" type="hidden" value="1">', 'multiselect', [1], false],
    ]) {
      const wrapper = document.createElement('section'); wrapper.dataset.pcfNativeField = key;
      wrapper.innerHTML = '<div data-pcf-native-input>' + markup + '</div>'; document.body.append(wrapper);
      const target = document.createElement('div'); target.dataset.test = key; wrapper.append(target);
      await __paqviloPcf.mount({ id: key, constructor: 'Synthetic.Sync', resources: [], properties: [{ name: 'value', 'of-type': type, usage: 'bound' }], strings: {}, args: { value, disabled }, identity: { roles: [] }, mappings: {}, nativeBinding: { id: 'original', control, properties: ['value'] } }, target);
    }
  });
  assert.equal(await page.locator('[data-pcf-native-field="text"] [data-pcf-native-input]').isVisible(), false);
  await page.evaluate(() => {
    const write = (key, id, value) => { const node = document.querySelector('[data-pcf-native-field="' + key + '"] #' + id); node.value = value; node.dispatchEvent(new Event('input', { bubbles: true })); node.dispatchEvent(new Event('change', { bubbles: true })); };
    write('text', 'original', 'Changed by native script');
    write('lookup', 'original', 'd0000000-0000-4000-8000-000000000004'); write('lookup', 'original_name', 'Lookup name'); write('lookup', 'original_entityname', 'tst_row');
    write('date', 'original', '2026-02-03'); write('multi', 'original', '2,3');
  });
  await page.waitForFunction(() => syncContexts.text.parameters.value.raw === 'Changed by native script');
  assert.deepEqual(await page.evaluate(() => syncContexts.lookup.parameters.value.raw), [{ id: 'd0000000-0000-4000-8000-000000000004', entityType: 'tst_row', name: 'Lookup name' }]);
  assert.equal(await page.evaluate(() => syncContexts.date.parameters.value.raw.toISOString().slice(0, 10)), '2026-02-03');
  assert.deepEqual(await page.evaluate(() => syncContexts.multi.parameters.value.raw), [2, 3]);
  assert.deepEqual(await page.evaluate(() => syncContexts.text.updatedProperties), ['value']);
  assert.equal(await page.evaluate(() => syncOutputs), 0);
  assert.deepEqual(await page.evaluate(() => syncUpdates), { text: 2, readonly: 1, lookup: 2, date: 2, multi: 2 });
  assert.equal(await page.locator('[data-pcf-native-field="readonly"] #original').inputValue(), 'Initial');
  await page.evaluate(() => {
    window.detachedNative = document.querySelector('[data-pcf-native-field="text"] #original');
    document.querySelector('[data-pcf-native-field="text"]').remove();
  });
  await page.evaluate(() => { detachedNative.value = 'Detached value'; detachedNative.dispatchEvent(new Event('change', { bubbles: true })); });
  assert.equal(await page.evaluate(() => syncContexts.text.parameters.value.raw), 'Changed by native script');
  await page.evaluate(async () => {
    ComponentFramework.registerControl('Synthetic.Broken', class { init() { throw new Error('Fixture runtime failure'); } });
    const wrapper = document.createElement('section'); wrapper.dataset.pcfNativeField = 'failed'; wrapper.innerHTML = '<div data-pcf-native-input hidden><input id="original" value="Fallback"></div>'; document.body.append(wrapper);
    const target = document.createElement('div'); wrapper.append(target);
    await __paqviloPcf.mount({ id: 'failed', constructor: 'Synthetic.Broken', resources: [], properties: [{ name: 'value', 'of-type': 'SingleLine.Text', usage: 'bound' }], strings: {}, args: {}, identity: { roles: [] }, mappings: {}, nativeBinding: { id: 'original', control: 'text', properties: ['value'] } }, target);
  });
  assert.equal(await page.locator('[data-pcf-native-field="failed"] #original').isVisible(), true);
  assert.match(await page.locator('[data-pcf-native-field="failed"] [role=alert]').innerText(), /Fixture runtime failure/);
  assert.deepEqual(errors, []);
});

test('exported dataset PCF renders real local rows with paging, sorting, filtering, selection and explicit unsupported-filter errors', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-pcf-dataset-'));
  const viewId = 'd0000000-0000-4000-8000-000000000003';
  const portal = path.join(root, 'portal'), solution = path.join(root, 'solution');
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Synthetic dataset',
    'portal/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': `<html><body>{% codecomponent name:'tst_Synthetic.Grid' rows:'${viewId}' %}</body></html>`,
    'portal/sitesetting.yml': '- adx_sitesettingid: api1\n  adx_name: Webapi/tst_row/enabled\n  adx_value: true\n- adx_sitesettingid: api2\n  adx_name: Webapi/tst_row/fields\n  adx_value: tst_rowid,tst_title,tst_when',
    'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/tst_row/Entity.xml': '<Entity><Name>tst_row</Name><EntityInfo><entity Name="tst_row"><EntitySetName>tst_rows</EntitySetName><attributes><attribute PhysicalName="tst_rowid"><Name>tst_rowid</Name><LogicalName>tst_rowid</LogicalName><Type>primarykey</Type></attribute><attribute PhysicalName="tst_title"><Name>tst_title</Name><LogicalName>tst_title</LogicalName><Type>nvarchar</Type><DisplayMask>PrimaryName|ValidForForm</DisplayMask></attribute><attribute PhysicalName="tst_when"><Name>tst_when</Name><LogicalName>tst_when</LogicalName><Type>datetime</Type></attribute></attributes></entity></EntityInfo></Entity>',
    [`solution/Entities/tst_row/SavedQueries/${viewId}.xml`]: `<savedquery><savedqueryid>${viewId}</savedqueryid><LocalizedNames><LocalizedName description="Visible Rows" languagecode="1033"/></LocalizedNames><fetchxml><fetch><entity name="tst_row"><attribute name="tst_rowid"/><attribute name="tst_title"/><order attribute="tst_title"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="tst_title" width="200"/></row></grid></layoutxml></savedquery>`,
    'solution/Controls/tst_Synthetic.Grid/ControlManifest.xml': '<manifest><control namespace="Synthetic" constructor="Grid" control-type="standard"><data-set name="rows"/><resources><code path="bundle.js"/></resources></control></manifest>',
    'solution/Controls/tst_Synthetic.Grid/ControlManifest.xml.data.xml': '<CustomControl><Name>tst_Synthetic.Grid</Name></CustomControl>',
    'solution/Controls/tst_Synthetic.Grid/bundle.js': `ComponentFramework.registerControl('Synthetic.Grid',class{init(context,notify,state,container){window.dataset=context.parameters.rows;this.container=container;dataset.paging.setPageSize(2);}updateView(context){const ds=context.parameters.rows;this.container.dataset.loading=String(ds.loading);this.container.innerHTML='<p class="grid-title"></p><p class="grid-rows"></p><p class="grid-error"></p>';this.container.querySelector('.grid-title').textContent=ds.getTitle();this.container.querySelector('.grid-rows').textContent=ds.sortedRecordIds.map(id=>ds.records[id].getFormattedValue('tst_title')).join(',');this.container.querySelector('.grid-error').textContent=ds.errorMessage;}destroy(){}});`,
  };
  for (const [name, text] of Object.entries(files)) { const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, text); }
  const app = await createSimulator({ sourceDir: portal, solutionRoots: [solution], port: 0, watch: false, initial: {
    tables: { tst_row: ['Alpha', 'Beta', 'Delta', 'Gamma', 'Omega'].map((tst_title, index) => ({ tst_rowid: 'd1000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'), tst_title, tst_when: '2026-01-02T00:00:00Z' })) },
    mappings: { tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid', nameColumn: 'tst_title' } }, permissions: [], settings: { permissionMode: 'permissive' },
  } });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(async () => { await browser.close(); await app.close(); await fs.rm(root, { recursive: true, force: true }); });
  const page = await browser.newPage(), errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => { if (!request.url().startsWith(app.url)) external.push(request.url()); });
  await page.goto(app.url);
  await page.locator('[data-pcf-ready=true]').waitFor();
  assert.equal(await page.locator('.grid-title').textContent(), 'Visible Rows');
  assert.equal(await page.locator('.grid-rows').textContent(), 'Alpha,Beta');
  assert.equal(await page.evaluate(() => dataset.paging.totalResultCount), 5);
  await page.evaluate(() => dataset.paging.loadNextPage());
  assert.equal(await page.locator('.grid-rows').textContent(), 'Delta,Gamma');
  assert.equal(await page.evaluate(() => dataset.paging.hasPreviousPage), true);
  await page.evaluate(() => dataset.paging.loadPreviousPage());
  assert.equal(await page.locator('.grid-rows').textContent(), 'Alpha,Beta');
  await page.evaluate(() => { dataset.sorting = [{ name: 'tst_title', sortDirection: 1 }]; return dataset.refresh(); });
  assert.equal(await page.locator('.grid-rows').textContent(), 'Omega,Gamma');
  await page.evaluate(() => { dataset.filtering.setFilter({ filterOperator: 0, conditions: [{ attributeName: 'tst_title', conditionOperator: 6, value: 'B%' }], filters: [] }); return dataset.refresh(); });
  assert.equal(await page.locator('.grid-rows').textContent(), 'Beta');
  assert.equal(await page.evaluate(() => dataset.paging.hasNextPage), false);
  const selected = await page.evaluate(() => { dataset.setSelectedRecordIds([dataset.sortedRecordIds[0]]); return { ids: dataset.getSelectedRecordIds(), value: dataset.records[dataset.sortedRecordIds[0]].getValue('tst_title'), reference: dataset.records[dataset.sortedRecordIds[0]].getNamedReference() }; });
  assert.equal(selected.ids.length, 1); assert.equal(selected.value, 'Beta'); assert.equal(selected.reference.etn, 'tst_row'); assert.equal(selected.reference.id.guid, selected.ids[0]);
  await page.evaluate(() => { dataset.filtering.setFilter({ filterOperator: 0, conditions: [{ attributeName: 'tst_title', conditionOperator: 999, value: 'unsupported' }], filters: [] }); return dataset.refresh(); });
  assert.match(await page.locator('.grid-error').textContent(), /unsupported/);
  assert.equal(await page.evaluate(() => dataset.error), true);
  await page.evaluate(() => { dataset.filtering.clearFilter(); dataset.clearSelectedRecordIds(); return dataset.refresh(); });
  assert.equal(await page.locator('.grid-rows').textContent(), 'Omega,Gamma');
  assert.equal(await page.evaluate(() => dataset.error), false);
  assert.deepEqual(await page.evaluate(() => dataset.getSelectedRecordIds()), []);
  await page.evaluate(() => { dataset.addColumn('tst_when'); return dataset.refresh(); });
  assert.equal(await page.evaluate(() => dataset.columns.find(column => column.name === 'tst_when').dataType), 'DateAndTime.DateAndTime');
  assert.equal(await page.evaluate(() => dataset.records[dataset.sortedRecordIds[0]].getValue('tst_when') instanceof Date), true);
  const denied = app.store.snapshot(); denied.settings.permissionMode = 'enforce'; denied.permissions = [];
  await app.store.replaceState(denied);
  await page.evaluate(() => dataset.refresh());
  assert.equal(await page.evaluate(() => dataset.error), true);
  assert.match(await page.locator('.grid-error').textContent(), /permission|access/i);
  assert.equal(await page.locator('.grid-rows').textContent(), '');
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
});
