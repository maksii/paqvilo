import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { DataStore } from '../lib/data.mjs';
import { FetchRenderCache } from '../lib/fetch-render-cache.mjs';
import { renderSettings } from '../lib/render-settings.mjs';
import { mirageSettings } from '../../lense/config-schema.mjs';
import { resolveMirageConfig } from '../../lense/config.mjs';
import { createSimulator } from '../server.mjs';

const guid = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const portal = { templates: {}, pages: [], snippets: {}, settings: {} };
function fixture() {
  return {
    settings: { permissionMode: 'permissive' },
    mappings: {
      parent: { idColumn: 'parentid' },
      child: { idColumn: 'childid', fields: { parentid: { dataverseType: 'lookup', targets: ['parent'] } } },
      grandchild: { idColumn: 'grandchildid', fields: { childid: { dataverseType: 'lookup', targets: ['child'] } } },
    },
    tables: {
      parent: [{ parentid: guid(1) }],
      child: Array.from({length: 40}, (_, i) => ({ childid: guid(100+i), parentid: {id: guid(1), logical_name: 'parent'} })),
      grandchild: Array.from({length: 480}, (_, i) => ({ grandchildid: guid(1000+i), childid: {id: guid(100+Math.floor(i/12)), logical_name: 'child'} })),
    },
  };
}
const template = `{% fetchxml parents %}<fetch><entity name="parent"><attribute name="parentid"/></entity></fetch>{% endfetchxml %}
{% for parent in parents.results.entities %}
{% fetchxml children %}<fetch><entity name="child"><attribute name="childid"/><filter><condition attribute="parentid" operator="eq" value="{{parent.parentid}}"/></filter></entity></fetch>{% endfetchxml %}
{% for child in children.results.entities %}
{% fetchxml grandchildren %}<fetch><entity name="grandchild"><attribute name="grandchildid"/><filter><condition attribute="childid" operator="eq" value="{{child.childid}}"/></filter></entity></fetch>{% endfetchxml %}
{% for grandchild in grandchildren.results.entities %}[{{grandchild.grandchildid}}]{% endfor %}
{% endfor %}{% endfor %}`;

test('three nested fetch loops render 40 x 12 records within the budget and reuse permission-filtered row inputs', async () => {
  const state = fixture();
  for (let i=0; i<5000; i++) state.tables.grandchild.push({ grandchildid: guid(10000+i), childid: {id: guid(999), logical_name: 'child'} });
  const store = new DataStore({state});
  const reads = new Map(), original = store.rows.bind(store);
  store.rows = (name, identity) => { reads.set(name, (reads.get(name) ?? 0)+1); return original(name, identity); };
  const renderer = createPortalRenderer(portal, {render: {timeLimitMs: 5000}, fetchXml: (xml, identity, _request, options) => store.fetchXml(xml, identity ?? {}, options)});
  const start = performance.now();
  const html = await renderer.renderString(template);
  assert.equal((html.match(/\[/g) ?? []).length, 480);
  assert.ok(performance.now()-start < 5000);
  assert.deepEqual(Object.fromEntries(reads), {parent: 1, child: 1, grandchild: 1});
});

test('a small budget checks even the final async node and remains a render error', async t => {
  let elapsed = 1000;
  t.mock.method(Date, 'now', () => elapsed);
  let invoked = false;
  const renderer = createPortalRenderer(portal, {render: {timeLimitMs: 20}, fetchXml: async () => {
    invoked = true;
    elapsed += 21;
    return {entities: []};
  }});
  await assert.rejects(renderer.renderString('{% fetchxml x %}<fetch><entity name="parent"/></fetch>{% endfetchxml %}'), error => error.renderLimit === true && /local render time limit of 20 ms exceeded/.test(error.message));
  assert.equal(invoked, true);
});

test('a render cache preserves every RetrieveMultiple plugin invocation', async () => {
  const store = new DataStore({state:fixture()}), cache = new FetchRenderCache();
  let calls=0;
  store.setPluginPipeline(() => {calls++;});
  const query='<fetch><entity name="parent"/></fetch>';
  for (let i=0;i<2;i++) await store.readOperation(()=>store.fetchXml(query,{admin:true},{fetchCache:cache}));
  assert.equal(calls,6);
});

test('render settings validate catalogue defaults and site options and resolve programmatically', () => {
  assert.deepEqual(renderSettings(), {timeLimitMs: 60000});
  for (const label of ['defaults.mirage', 'sites.demo.mirage']) mirageSettings({render: {timeLimitMs: 120000}}, label);
  assert.deepEqual(resolveMirageConfig({render: {timeLimitMs: 120000}}, {configDir: process.cwd(), sourceRoot: process.cwd()}).render, {timeLimitMs: 120000});
  for (const value of [null, [], {unknown: 1}, {timeLimitMs: 0}, {timeLimitMs: Infinity}, {timeLimitMs: 1.5}, {timeLimitMs: '5000'}]) assert.throws(() => renderSettings(value));
});

test('render caches invalidate for mutations and identities, preserve returned totals and do not cache results', async () => {
  const state = fixture();
  state.settings.permissionMode = 'enforce';
  state.permissions = [{entity: 'child', scope: 'contact', field: 'owner', roles: ['reader'], operations: ['read','update']}];
  state.tables.child = [{childid: guid(100), owner: 'one', parentid: guid(1)}, {childid: guid(101), owner: 'two', parentid: guid(1)}];
  const store = new DataStore({state}), cache = new FetchRenderCache();
  const query = '<fetch><entity name="child"><attribute name="childid"/><filter><condition attribute="parentid" operator="eq" value="'+guid(1)+'"/></filter></entity></fetch>';
  const read = identity => store.fetchXml(query, identity, {fetchCache: cache});
  assert.deepEqual(read({contactId:'one', roles:['reader']}).entities.map(row=>row.childid), [guid(100)]);
  assert.deepEqual(read({contactId:'two', roles:['reader']}).entities.map(row=>row.childid), [guid(101)]);
  const result = read({admin:true}); result.entities.length = 0;
  assert.equal(read({admin:true}).entities.length, 2);
  const plans = cache.plans.size;
  read({admin:true});
  assert.equal(cache.plans.size, plans, 'identical compiled XML reuses its plan');
  await store.update('child', guid(100), {parentid: guid(2)}, {admin:true});
  assert.equal(read({admin:true}).entities.length, 1);
  assert.equal(cache.plans.size, plans);
  assert.deepEqual(read({contactId:'two',roles:new Set(['reader'])}).entities.map(row=>row.childid),[guid(101)]);
  assert.deepEqual(read({contactId:'two',roles:new Set(['outsider'])}).entities,[]);
});

test('indexed equality retains GUID decorations, OR predicates, paging totals and invented identifier behavior', () => {
  const state=fixture(), cache=new FetchRenderCache();
  state.tables.child.push({childid:guid(200),parentid:guid(2)});
  const store=new DataStore({state});
  for(const filter of [
    `<filter><condition attribute="parentid" operator="eq" value="{${guid(1)}}"/></filter>`,
    `<filter type="or"><condition attribute="parentid" operator="eq" value="${guid(1)}"/><condition attribute="parentid" operator="eq" value="${guid(2)}"/></filter>`,
    '<filter><condition attribute="parentid" operator="eq" value="invented"/></filter>',
  ]) {
    const xml=`<fetch count="5" returntotalrecordcount="true"><entity name="child"><attribute name="childid"/>${filter}</entity></fetch>`;
    assert.deepEqual(store.fetchXml(xml,{}, {fetchCache:cache}),store.fetchXml(xml));
  }
});

test('runtime answers status after a render has begun and before a long Liquid loop completes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-render-budget-'));
  t.after(() => fs.rm(root, {recursive:true, force:true}));
  const files = {
    'website.yml': 'adx_websiteid: site\nadx_name: Invented render fixture',
    'web-pages/home/Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_isroot: true\nadx_partialurl: /\nadx_pagetemplateid: main',
    'page-templates/Main.pagetemplate.yml': 'adx_pagetemplateid: main\nadx_name: Main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'web-templates/main/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'web-templates/main/Main.webtemplate.source.html': template+'{% for i in (1..75000) %}{{ i }}{% endfor %}',
  };
  for (const [name, body] of Object.entries(files)) { const file=path.join(root,name); await fs.mkdir(path.dirname(file),{recursive:true}); await fs.writeFile(file,body); }
  const app = await createSimulator({sourceDir:root, stateFile:path.join(root,'state.json'), initial:fixture(), watch:false, render:{timeLimitMs:15000}});
  t.after(() => app.close());
  const started = Promise.withResolvers(), original = app.store.fetchXml.bind(app.store);
  app.store.fetchXml = (...args) => { started.resolve(); return original(...args); };
  let complete = false;
  const page = fetch(app.url).then(async response => { const html=await response.text(); complete=true; return {status:response.status,html}; });
  await started.promise;
  const status = await fetch(new URL('/_sim/api/status',app.url));
  assert.equal(status.status, 200);
  assert.equal(complete, false, 'status must respond during the active render');
  assert.deepEqual((await status.json()).render, {timeLimitMs:15000});
  const rendered = await page;
  assert.equal(rendered.status,200);
  assert.match(rendered.html,/75000/);
  const limited = await createSimulator({sourceDir:root, stateFile:path.join(root,'limited.json'), initial:fixture(), watch:false, render:{timeLimitMs:5}});
  t.after(() => limited.close());
  const failed = await fetch(limited.url);
  assert.equal(failed.status,500);
  assert.match(await failed.text(),/local render time limit of 5 ms exceeded/);
});
