import { ownedFixture, drainFixture } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { MODEL_DRIVEN_ACTIONS, validateModelDrivenAction } from '../lense/model-driven-actions.mjs';
import { runModelDrivenAction, modelDrivenActionAvailability, disposeModelDrivenActions } from '../lense/model-driven-action-runner.mjs';

const recordId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', formId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', environmentId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', solutionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const html = `<!doctype html><title>Invented native app</title><div data-id="x_name"><input value="PRIVATE_FORM_VALUE"></div><script>
window.nativeFixture={id:'${recordId}',entity:'x_person',dirty:true,idReads:0,valueReads:0,opened:[],saveHandlers:[],gridRefreshes:0,closedPanes:0,privileges:{},refreshes:[],required:'required',visible:false,disabled:true,tabVisible:false,sectionVisible:false};
const f=nativeFixture, collection=items=>({get:()=>items,forEach:callback=>items.forEach(callback)});
const values={x_name:'PRIVATE_FORM_VALUE',x_zero:0,x_false:false,x_empty:'',x_parent:[{id:'{${recordId}}',name:'Parent',entityType:'x_person'}],x_due:new Date('2026-10-21T13:25:00.000Z'),x_choices:[1,3],x_readonly:'DO_NOT_CLONE'};
const attributes=Object.entries(values).map(([name,value])=>({getName:()=>name,getValue:()=>{f.valueReads++;return value},getAttributeType:()=>name==='x_parent'?'lookup':name==='x_due'?'datetime':typeof value,getIsDirty:()=>name==='x_name',getRequiredLevel:()=>f.required,setRequiredLevel:value=>f.required=value,...(name==='x_choices'?{getOptions:()=>[{text:'Planned',value:1},{text:'Complete',value:3}]}:{})}));
const control={getName:()=> 'x_name',getVisible:()=>f.visible,setVisible:value=>f.visible=value,getDisabled:()=>f.disabled,setDisabled:value=>f.disabled=value};
const section={getVisible:()=>f.sectionVisible,setVisible:value=>f.sectionVisible=value};const tab={getVisible:()=>f.tabVisible,setVisible:value=>f.tabVisible=value,sections:collection([section])};
window.Xrm={Utility:{getGlobalContext:()=>({getClientUrl:()=>location.origin,getVersion:()=> '9.2.1234.5',organizationSettings:{bapEnvironmentId:'${environmentId}',organizationId:'${environmentId}',uniqueName:'invented'},userSettings:{userId:'${recordId}',userName:'PRIVATE_USER_NAME',getSecurityRolePrivilegesInfo:async()=>f.privileges,roles:collection([{name:'Invented role'}])}}),getPageContext:()=>({input:{pageType:'entityrecord',entityName:f.entity,entityId:f.id}})},Page:{data:{entity:{getEntityName:()=>f.entity,getId:()=>{f.idReads++;return f.id},getIsDirty:()=>f.dirty,attributes:collection(attributes),addOnSave:handler=>f.saveHandlers.push(handler),removeOnSave:handler=>f.saveHandlers=f.saveHandlers.filter(item=>item!==handler)},refresh:async save=>f.refreshes.push(save)},ui:{getFormType:()=>2,formSelector:{getCurrentItem:()=>({getId:()=> '${formId}'})},controls:collection([control,{getControlType:()=> 'subgrid',refresh:()=>f.gridRefreshes++}]),tabs:collection([tab])}},Navigation:{openUrl:async url=>f.opened.push({url}),openForm:async(options,params)=>f.opened.push({options,params})},App:{sidePanes:{createPane:async options=>({navigate:async page=>f.opened.push({pane:options,page}),close:()=>f.closedPanes++})}}};
const host=document.createElement('div');host.id='paqvilo-model-inspector';document.body.append(host);host.__paqModelActions={token:'invented-owned-session',results:[],receive(requestId,result){this.results.push({requestId,result})}};
</script>`;

async function fixture(t) {
  const requests = [], waits = new Map();
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid'); requests.push({ method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams) });
    const send = body => { if (!response.destroyed) response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body)); };
    if (url.pathname === '/main.aspx') return response.writeHead(200, { 'content-type': 'text/html' }).end(html);
    if (url.pathname.includes('/Attributes')) return send({ value: ['x_name', 'x_zero', 'x_false', 'x_empty', 'x_parent', 'x_due', 'x_choices', 'x_readonly'].map(LogicalName => ({ LogicalName, IsValidForCreate: LogicalName !== 'x_readonly', AttributeType: LogicalName === 'x_parent' ? 'Lookup' : LogicalName === 'x_due' ? 'DateTime' : LogicalName === 'x_choices' ? 'Virtual' : 'String' })) });
    if (url.pathname.includes('/EntityDefinitions(')) return send({ LogicalName: 'x_person', EntitySetName: 'x_people', PrimaryIdAttribute: 'x_personid', PrimaryNameAttribute: 'x_name' });
    if (url.pathname.endsWith('/GetPreferredSolution()')) return send({ solutionid: solutionId });
    if (url.pathname.endsWith('/systemusers')) return send({ value: [{ systemuserid: recordId, fullname: 'Invented active user', domainname: 'invented@example.invalid', azureactivedirectoryobjectid: environmentId }, { systemuserid: formId, fullname: 'No directory identity', domainname: '', azureactivedirectoryobjectid: null }] });
    if (url.pathname.endsWith('/workflows')) return send({ value: [{ workflowid: formId, name: '<unsafe process name>', category: 2 }] });
    if (url.pathname.endsWith('/customapis')) return send({ value: [{ customapiid: environmentId, displayname: 'Invented bound API' }] });
    if (url.pathname.includes('/x_people(')) { const body = { x_name: 'PRIVATE_SERVER_VALUE', x_zero: 0, x_false: false, x_null: null, 'x_name@OData.Community.Display.V1.FormattedValue': 'PRIVATE_FORMATTED_VALUE' }; const blocked = waits.get('record'); if (blocked) { blocked.pending = true; blocked.release = () => send(body); return; } return send(body); }
    response.writeHead(404).end('{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch(browserLaunchOptions());
  ownedFixture(t).add(async () => { await drainFixture([...waits.values()].map(wait => async () => {wait.release?.();})); });
  ownedFixture(t).add(async () => { await browser.close(); });
  ownedFixture(t).add(async () => { server.closeAllConnections(); });
  ownedFixture(t).add(async () => { await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage(); await page.goto(origin + '/main.aspx?appid=invented-app&pagetype=entityrecord&etn=x_person&id=' + recordId);
  let sequence = 0;
  const run = async (action, params = {}, extra = {}) => { const input = validateModelDrivenAction(action, params), requestId = `request-${++sequence}`; const ack = await page.evaluate(runModelDrivenAction, { origin, token: 'invented-owned-session', ...input, requestId, cloud: { maker: 'https://maker.example.invalid', admin: 'https://admin.example.invalid' }, ...extra }); assert.deepEqual(ack, { accepted: true, requestId }); assert.doesNotMatch(JSON.stringify(ack), /PRIVATE_|aaaaaaaa|bbbbbbbb/); return page.evaluate(id => document.getElementById('paqvilo-model-inspector').__paqModelActions.results.find(item => item.requestId === id)?.result, requestId); };
  return { page, origin, requests, waits, run };
}

test('passive action availability never reads record identity or form values; explicit results remain outside acknowledgements', async t => {
  const { page, origin, run, requests } = await fixture(t);
  const availability = await page.evaluate(modelDrivenActionAvailability, { origin, actions: MODEL_DRIVEN_ACTIONS });
  assert.equal(availability.find(item => item.id === 'form:record-id').available, true);
  assert.deepEqual(await page.evaluate(() => [nativeFixture.idReads, nativeFixture.valueReads]), [0, 0]);
  const id = await run('form:record-id'); assert.equal(id.copyText, recordId);
  const dirty = await run('form:changed-fields'); assert.deepEqual(dirty.rows, [['x_name', 'string', 'PRIVATE_FORM_VALUE']]);
  const saved = await run('form:all-fields'); assert.ok(saved.rows.some(row => row[0] === 'x_false' && row[1] === 'false')); assert.ok(saved.rows.some(row => row[1] === 'PRIVATE_SERVER_VALUE')); assert.match(saved.message, /Saved server state/);
  assert.ok(requests.some(request => request.path.includes('/x_people('))); assert.equal(requests.some(request => request.path.includes('/x_persons(')), false); assert.equal(requests.some(request => request.method !== 'GET'), false);
});

test('native reads, copy links, choices, source-safe table processes and navigation use actual app metadata', async t => {
  const { page, origin, run, requests } = await fixture(t);
  const copied = await run('form:record-url'); assert.equal(new URL(copied.copyText).searchParams.get('appid'), 'invented-app'); assert.equal(new URL(copied.copyText).searchParams.get('formid'), formId);
  assert.deepEqual((await run('form:show-optionset-values')).rows, [['x_choices', 'Planned', '1'], ['x_choices', 'Complete', '3']]);
  const processes = await run('form:table-processes');
  assert.equal(processes.rows[0][1], '<unsafe process name>', 'runner returns data; UI must render it as text');
  assert.deepEqual(processes.links.map(link => { const url = new URL(link.url); assert.equal(url.origin, origin); assert.equal(url.searchParams.get('pagetype'), 'entityrecord'); return [url.searchParams.get('etn'), url.searchParams.get('id')]; }), [['workflow', formId], ['customapi', environmentId]]);
  assert.equal((await run('form:open-editor')).status, 'ok');
  await run('form:open-web-api'); await run('navigation:open-record-by-id', { entity: 'x_person', id: recordId }); await run('navigation:new-record', { entity: 'x_person' });
  for (const action of MODEL_DRIVEN_ACTIONS.filter(action => action.id.startsWith('navigation:') && !['navigation:open-record-by-id', 'navigation:new-record', 'navigation:pin-to-side-panel', 'navigation:open-mobile-client'].includes(action.id))) assert.equal((await run(action.id, action.inputs.length ? { entity: 'x_person' } : {})).status, 'ok', action.id);
  await run('navigation:open-mobile-client'); await run('navigation:pin-to-side-panel');
  const opened = await page.evaluate(() => nativeFixture.opened); assert.ok(opened.some(item => item.url?.includes('/s/' + solutionId + '/entity/x_person/form/edit/' + formId))); assert.ok(opened.some(item => item.url?.includes('/x_people('))); assert.ok(opened.some(item => item.pane?.canClose));
  assert.equal(requests.some(request => request.method !== 'GET'), false);
});

test('clone preparation preserves typed zero, false, empty, lookup and date values and performs no writes', async t => {
  const { page, run, requests } = await fixture(t);
  const outcome = await run('form:clone-record'); assert.equal(outcome.status, 'ok');
  const clone = await page.evaluate(() => nativeFixture.opened.at(-1)); assert.equal(clone.options.entityName, 'x_person'); assert.equal(clone.options.entityId, undefined); assert.equal(clone.params.x_zero, 0); assert.equal(clone.params.x_false, false); assert.equal(clone.params.x_empty, ''); assert.equal(clone.params.x_parent, recordId); assert.equal(clone.params.x_parenttype, 'x_person'); assert.equal(clone.params.x_due, '2026-10-21T13:25:00.000Z'); assert.equal(clone.params.x_readonly, undefined); assert.equal(clone.params.x_choices, '1,3');
  assert.equal(requests.some(request => request.method !== 'GET'), false);
});

test('client overrides restore exact states and autosave guard blocks only 70 with owned cleanup', async t => {
  const { page, origin, run } = await fixture(t);
  assert.equal((await run('form:god-mode')).status, 'ok');
  assert.deepEqual(await page.evaluate(() => [nativeFixture.required, nativeFixture.disabled, nativeFixture.visible, nativeFixture.tabVisible, nativeFixture.sectionVisible]), ['none', false, true, true, true]);
  await run('form:restore-overrides'); assert.deepEqual(await page.evaluate(() => [nativeFixture.required, nativeFixture.disabled, nativeFixture.visible, nativeFixture.tabVisible, nativeFixture.sectionVisible]), ['required', true, false, false, false]);
  await run('form:toggle-autosave', { enabled: true });
  assert.deepEqual(await page.evaluate(() => [70, 1, 2].map(mode => { let blocked = false; for (const handler of nativeFixture.saveHandlers) handler({ getEventArgs: () => ({ getSaveMode: () => mode, preventDefault: () => blocked = true }) }); return blocked; })), [true, false, false]);
  await run('form:refresh-subgrids'); assert.equal(await page.evaluate(() => nativeFixture.gridRefreshes), 1);
  page.once('dialog', dialog => dialog.accept()); await run('form:refresh-autosave-off'); assert.deepEqual(await page.evaluate(() => nativeFixture.refreshes), [false]);
  await run('form:show-logical-names'); assert.equal(await page.locator('[data-paq-model-logical-name]').count(), 1);
  await page.evaluate(disposeModelDrivenActions, { origin, token: 'invented-owned-session' }); assert.equal(await page.evaluate(() => nativeFixture.saveHandlers.length), 0); assert.equal(await page.locator('[data-paq-model-logical-name]').count(), 0);
});

test('late server results cancel after record navigation and retired, foreign or unowned sessions cannot execute', async t => {
  const { page, origin, waits } = await fixture(t); const blocked = {}; waits.set('record', blocked);
  const pending = page.evaluate(runModelDrivenAction, { origin, token: 'invented-owned-session', action: 'form:all-fields', params: {}, requestId: 'slow' });
  await page.waitForFunction(() => nativeFixture.idReads > 1); while (!blocked.pending) await new Promise(resolve => setTimeout(resolve, 5));
  await page.evaluate(() => nativeFixture.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'); blocked.release(); assert.deepEqual(await pending, { accepted: true, requestId: 'slow' });
  const outcome = await page.evaluate(() => document.getElementById('paqvilo-model-inspector').__paqModelActions.results.at(-1).result); assert.equal(outcome.status, 'cancelled'); assert.doesNotMatch(JSON.stringify(outcome), /PRIVATE_/);
  for (const extra of [{ token: 'foreign' }, { origin: 'https://foreign.invalid' }]) assert.equal((await page.evaluate(runModelDrivenAction, { origin, token: 'invented-owned-session', action: 'form:record-id', params: {}, requestId: 'denied', ...extra })).accepted, false);
  await page.evaluate(() => window.__paqviloRetiredModelInspectors = ['invented-owned-session']); assert.equal((await page.evaluate(runModelDrivenAction, { origin, token: 'invented-owned-session', action: 'form:record-id', params: {}, requestId: 'retired' })).accepted, false);
});


test('native identity reads use exact privilege names and bounded active-user queries with browser-only choices', async t => {
  const { page, run, requests } = await fixture(t);
  await page.evaluate(() => nativeFixture.privileges = { role: { name: 'System Administrator' } });
  assert.equal((await run('identity:status')).identity.canImpersonate, false);
  await page.evaluate(() => nativeFixture.privileges = { role: { name: 'prvActOnBehalfOfAnotherUser' } });
  assert.equal((await run('identity:status')).identity.canImpersonate, false, 'a name field is not the native privilegeName contract');
  await page.evaluate(() => nativeFixture.privileges = { privilege: { privilegeName: 'prvActOnBehalfOfAnotherUser', depth: 1 } });
  assert.equal((await run('identity:status')).identity.canImpersonate, true);
  const users = await run('identity:users', { query: "O'Neal" }); assert.equal(users.users.length, 1); assert.equal(users.users[0].objectId, environmentId); assert.equal(users.users[0].label, 'Invented active user');
  const read = requests.find(request => request.path.endsWith('/systemusers')); assert.equal(read.query.$top, '100'); assert.match(read.query.$filter, /isdisabled eq false and applicationid eq null/); assert.match(read.query.$filter, /O''Neal/); assert.equal(requests.some(request => request.method !== 'GET'), false);
});

test('owned target lifetime restores fields and guards after SPA navigation while native panes persist until session cleanup', async t => {
  const { page, origin, run } = await fixture(t);
  await run('form:god-mode'); await run('form:toggle-autosave', { enabled: true }); await run('form:show-logical-names'); await run('navigation:pin-to-side-panel');
  await page.evaluate(() => { nativeFixture.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; history.replaceState({}, '', '?pagetype=entityrecord&etn=x_person&id=' + nativeFixture.id); });
  await page.waitForFunction(() => nativeFixture.required === 'required' && nativeFixture.saveHandlers.length === 0 && !document.querySelector('[data-paq-model-logical-name]'));
  assert.equal(await page.evaluate(() => nativeFixture.closedPanes), 0, 'pinning retains the earlier record while navigating the main app');
  assert.equal((await run('form:record-id')).copyText, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', 'a new action can target the new record after automatic cleanup');
  await page.evaluate(disposeModelDrivenActions, { origin, token: 'invented-owned-session' }); assert.equal(await page.evaluate(() => nativeFixture.closedPanes), 1);
});

test('explicit stop waiting cancels pending SDK work without discarding owned form adjustments', async t => {
  const { page, run } = await fixture(t);
  await run('form:god-mode'); await run('form:toggle-autosave', { enabled: true }); await run('form:show-logical-names');
  await page.evaluate(() => { nativeFixture.dirty = false; Xrm.Page.data.refresh = () => new Promise(resolve => { window.releaseNativeRefresh = resolve; }); });
  const pending = run('form:refresh-autosave-off');
  await page.waitForFunction(() => Boolean(window.releaseNativeRefresh));
  await page.evaluate(() => document.getElementById('paqvilo-model-inspector').__paqModelActionState.cancelPending());
  assert.equal(await page.evaluate(() => nativeFixture.required), 'none');
  assert.equal(await page.evaluate(() => nativeFixture.saveHandlers.length), 1);
  assert.equal(await page.locator('[data-paq-model-logical-name]').count(), 1);
  assert.equal((await run('form:record-id')).copyText, recordId);
  await page.evaluate(() => window.releaseNativeRefresh());
  assert.equal((await pending).status, 'cancelled');
});

test('explicit action lifetime clears displayed values after a same-URL record change without cancelling a fresh dispatch', async t => {
  const { page, run } = await fixture(t);
  const originalUrl = page.url();
  await run('form:changed-fields');
  await page.evaluate(() => {
    const actions = document.getElementById('paqvilo-model-inspector').__paqModelActions;
    actions.contextChanged = () => { actions.results = []; window.privateContextChanges = (window.privateContextChanges ?? 0) + 1; };
    nativeFixture.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  });
  await page.waitForFunction(() => window.privateContextChanges === 1);
  assert.equal(page.url(), originalUrl, 'record identity can change without a route change');
  assert.equal(await page.evaluate(() => document.getElementById('paqvilo-model-inspector').__paqModelActions.results.length), 0);
  assert.equal((await run('form:record-id')).copyText, 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee');
  // Exercise a new dispatch before the interval can see the next target. Its
  // own request must survive the synchronous target-state transition.
  await page.evaluate(() => { clearInterval(document.getElementById('paqvilo-model-inspector').__paqModelActionState.timer); nativeFixture.id = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; });
  assert.equal((await run('form:record-id')).copyText, 'ffffffff-ffff-4fff-8fff-ffffffffffff');
  assert.equal(await page.evaluate(() => window.privateContextChanges), 1);
});

test('native main-form requests acknowledge dispatch without waiting for quick-create-only success and keep late errors private', async t => {
  const { page, run } = await fixture(t);
  await page.evaluate(() => {
    window.nativeFormRejects = []; window.nativeFormFollowups = [];
    Xrm.Navigation.openForm = () => new Promise((_resolve, reject) => nativeFormRejects.push(reject));
    document.getElementById('paqvilo-model-inspector').__paqModelActions.followup = (requestId, result) => nativeFormFollowups.push({ requestId, result });
  });
  const record = await run('navigation:open-record-by-id', { entity: 'x_person', id: recordId });
  assert.equal(record.status, 'ok'); assert.match(record.message, /Requested.*do not report opening completion/);
  const clone = await run('form:clone-record'); assert.equal(clone.status, 'ok'); assert.match(clone.message, /No record was created/);
  assert.equal(await page.evaluate(() => nativeFormRejects.length), 2);
  await page.evaluate(() => nativeFormRejects[1](Error('PRIVATE_NATIVE_ERROR')));
  await page.waitForFunction(() => nativeFormFollowups.length === 1);
  assert.equal(await page.evaluate(() => nativeFormFollowups[0].result.message), 'PRIVATE_NATIVE_ERROR');
  await page.evaluate(() => { nativeFixture.id = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'; nativeFormRejects[0](Error('STALE_NATIVE_ERROR')); });
  await page.waitForTimeout(30); assert.equal(await page.evaluate(() => nativeFormFollowups.length), 1);
});

test('maker and admin navigation preserve an actual Default-prefixed environment identity without guessing an organization ID', async t => {
  const { page, run } = await fixture(t), nativeId = 'Default-AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  await page.evaluate(id => { const context = Xrm.Utility.getGlobalContext(); context.organizationSettings.bapEnvironmentId = id; Xrm.Utility.getGlobalContext = () => context; }, nativeId);
  assert.equal((await run('navigation:open-power-platform-admin')).status, 'ok');
  assert.equal((await run('form:open-editor')).status, 'ok');
  const urls = await page.evaluate(() => nativeFixture.opened.map(item => item.url));
  assert.ok(urls.some(url => url.includes(`/environments/environment/${nativeId}/hub`)));
  assert.ok(urls.some(url => url.includes(`/e/${nativeId}/s/`)));
  await page.evaluate(() => { Xrm.Utility.getGlobalContext().organizationSettings.bapEnvironmentId = '../untrusted'; });
  assert.equal((await run('navigation:open-power-platform-admin')).status, 'unsupported');
  assert.equal(await page.evaluate(() => nativeFixture.opened.length), 2);
});


test('native action reads cancel bounded decoded streams before unbounded text allocation', async t => {
  const { page, run } = await fixture(t);
  await page.evaluate(() => {
    const original = window.fetch;
    window.readChunks = 0; window.readCancelled = false;
    window.fetch = (url, options) => String(url).includes('/x_people(') ? Promise.resolve(new Response(new ReadableStream({
      pull(controller) { window.readChunks++; controller.enqueue(new Uint8Array(512 * 1024)); },
      cancel() { window.readCancelled = true; },
    }, { highWaterMark: 0 }), { headers: { 'content-type': 'application/json' } })) : original(url, options);
  });
  const result = await run('form:all-fields');
  assert.equal(result.status, 'error'); assert.match(result.message, /2 MiB read limit/);
  assert.deepEqual(await page.evaluate(() => [window.readChunks, window.readCancelled]), [5, true]);
});
