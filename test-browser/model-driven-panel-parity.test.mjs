import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../mirage/lib/browser-launch.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
import { startModelDrivenInspector } from '../lense/model-driven-inspector.mjs';
import { createModelDrivenOverlay } from '../lense/model-driven.mjs';
import { interceptOrigin } from '../lense/intercept.mjs';
import { readModelDrivenNativeSource } from '../lense/model-driven-native-comparison.mjs';
import { panelUi } from '../lense/panel-ui.mjs';
import { modelDrivenPanelData } from '../lense/model-driven-panel.mjs';

let browser;
before(async () => { browser = await chromium.launch(browserLaunchOptions()); });
after(() => browser?.close());

async function modelPanelFixture(t, { nativeBody, withGit = true, archive = false } = {}) {
  const owner = ownedFixture(t), root = await fs.mkdtemp(path.join(os.tmpdir(), 'model-panel-parity-'));
  // Async Git reads started by a refresh can still hold the directory briefly on Windows.
  owner.remove(() => fs.rm(root, {recursive:true,force:true,maxRetries:10}));
  const file = path.join(root,'x_script.js'), raw = 'window.sourceRevision="same";';
  await fs.writeFile(file,raw);
  const git = args => execFileSync('git',args,{cwd:root,windowsHide:true,stdio:'pipe'});
  if (withGit) { git(['init','-q']); git(['add','x_script.js']); git(['-c','user.name=Invented','-c','user.email=invented@example.invalid','commit','-qm','Initial']); }
  const nativeHeaders = [], nativeBytes = gzipSync(Buffer.from(nativeBody ?? raw));
  const server = http.createServer((request,response) => {
    if(request.url.toLowerCase().includes('/webresources/')) { nativeHeaders.push(request.headers['x-paqvilo-native-comparison']); return response.writeHead(200,{'content-type':'text/javascript','content-length':nativeBytes.length,'content-encoding':'gzip'}).end(nativeBytes); }
    response.writeHead(200,{'content-type':'text/html'}).end('<!doctype html><title>Invented app</title><h1>Source controls</h1><script src="/%7b2026%7d/webresources/x_script.js"></script>');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  owner.add(()=>{server.closeAllConnections();return new Promise(resolve=>server.close(resolve));});
  const origin=`http://127.0.0.1:${server.address().port}`;
  const context=await browser.newContext(),page=await context.newPage();owner.add(()=>context.close());page.setDefaultTimeout(5000);
  const errors=[];page.on('pageerror',error=>errors.push(error.message));
  const makeImported = data => ({assets:new Map([['x_script.js',{name:'x_script.js',file:archive?undefined:file,mime:'text/javascript',data:Buffer.from(data)}]]),resources:[{name:'x_script.js'}],layers:[{dir:root,documents:[]}],diagnostics:[]});
  const imported=makeImported(raw),overlay=createModelDrivenOverlay({origin,imported,mappings:[{path:'/%7b2026%7d/webresources/x_script.js',resource:'x_script.js'}],ownsRequest:request=>request.frame().page()===page});
  const release=await interceptOrigin(context,origin,route=>overlay.handle(route),{ownsPage:candidate=>candidate===page});owner.add(release);
  let live=false;
  const inspector=await startModelDrivenInspector({context,page,overlay,imported,cfg:{origin,stateDir:path.join(root,'.state'),sourceDir:root},runtime:{liveReload:false,setLive(value){live=value;}}});owner.add(()=>inspector.close());
  await page.goto(origin+'/main.aspx'); await page.locator('#paqvilo-panel').waitFor();
  await page.keyboard.press('Alt+Shift+P');
  return {root,file,page,context,overlay,inspector,origin,errors,makeImported,nativeHeaders,getLive:()=>live};
}

test('canonical model panel executes actual source controls, preserves Actions drafts and shares Power Pages chrome', {timeout:30000}, async t=>{
  const f=await modelPanelFixture(t),{page,inspector,overlay,root}=f,host=page.locator('#paqvilo-panel');
  await host.getByRole('button',{name:'Local',exact:true}).waitFor();
  assert.match(await host.locator('[data-act=live]').getAttribute('title'),/off/);
  await host.locator('[data-act=live]').click();assert.equal(f.getLive(),true);
  await host.getByRole('tab',{name:'Explore',exact:true}).click();
  await host.getByText('x_script.js',{exact:true}).first().waitFor();
  await host.getByRole('tab',{name:'Actions',exact:true}).click();
  await host.locator('.actions-tabs').getByRole('button',{name:'Custom',exact:true}).click();
  const editor=host.getByRole('textbox',{name:'Command JavaScript',exact:true});
  await editor.fill('return "draft retained";');await editor.evaluate(node=>node.setSelectionRange(3,7));
  inspector.refresh();await page.waitForTimeout(150);
  assert.equal(await editor.inputValue(),'return "draft retained";');
  await host.getByRole('tab',{name:/^Overrides/}).click();
  await host.getByRole('tab',{name:'Actions',exact:true}).click();assert.equal(await editor.inputValue(),'return "draft retained";');
  await host.getByRole('tab',{name:/^Overrides/}).click();
  const shots=process.env.PAQVILO_MODEL_PANEL_SCREENSHOTS;
  if(shots){await fs.mkdir(shots,{recursive:true});await page.screenshot({path:path.join(shots,'model-driven-canonical.png')});}
  await host.getByRole('button',{name:'Online',exact:true}).click();await page.waitForFunction(()=>window.sourceRevision==='same');
  await page.locator('#paqvilo-panel').waitFor();await page.keyboard.press('Alt+Shift+P');
  assert.equal(overlay.report().online,true);
  await page.evaluate(()=>fetch('/%7b2026%7d/webresources/x_script.js').then(r=>r.text()));
  await page.waitForTimeout(100);
  const comparison=await page.evaluate(async token=>window.__paqviloModelPanelApi({token,name:'diff',body:{rel:'x_script.js'}}),inspector.snapshot().token);
  assert.equal(comparison.ok,true);assert.equal(comparison.against,'Model-driven');
  assert.equal(comparison.added+comparison.removed,0,'raw local source comparison excludes debugger source-map suffix');
  assert.equal(comparison.rawEqual,true);
  assert.ok(f.nativeHeaders.length>0);assert.ok(f.nativeHeaders.every(value=>value===undefined),'one-use bypass header never reaches native server');
  const denied=await page.evaluate(()=>window.__paqviloModelPanelApi({token:'foreign',name:'mode',body:{online:false}}));assert.equal(denied.ok,false);assert.equal(overlay.report().online,true);
  const frame=await page.evaluateHandle(()=>{const iframe=document.createElement('iframe');iframe.src='/frame';document.body.append(iframe);return iframe;});
  await frame.asElement().contentFrame().then(async inner=>{await inner.waitForLoadState();assert.equal(await inner.evaluate(()=>typeof window.__paqviloModelPanelApi),'undefined','child frames do not receive the owned main-frame transport');});
  if(shots){
    const state=inspector.snapshot(),data=modelDrivenPanelData(state,{cfg:{sourceDir:root},ui:{open:true}});
    await inspector.close();await page.evaluate(panelUi,{...data,modelDriven:false,transport:undefined,token:'pp-visual-fixture',capabilities:{actions:false,targets:false},items:[],unobserved:[]});
    await page.screenshot({path:path.join(shots,'power-pages-canonical.png')});
  }
  assert.deepEqual(f.errors,[]);
});


test('explicit Online comparison streams decoded compressed bytes, cancels oversized sources and preserves Local overlay', {timeout:15000}, async t=>{
  const f=await modelPanelFixture(t,{nativeBody:'/*'+'x'.repeat(3*1024*1024)+'*/'});
  const before=f.overlay.report().applied;
  const result=await f.page.evaluate(token=>window.__paqviloModelPanelApi({token,name:'diff',body:{rel:'x_script.js'}}),f.inspector.snapshot().token);
  assert.equal(result.ok,false);assert.match(result.error,/decoded native source exceeds/);
  assert.equal(f.overlay.report().online,false);assert.equal(f.overlay.report().applied,before);
  assert.deepEqual(f.nativeHeaders,[undefined]);
  await f.page.evaluate(()=>fetch('/%7b2026%7d/webresources/x_script.js').then(r=>r.text()));
  assert.equal(f.overlay.report().applied,before+1,'next ordinary source request still uses Local');
});


test('comparison preserves UTF8 BOM and rejects a stale source revision without accepting late bytes', {timeout:15000}, async t => {
  const f = await modelPanelFixture(t, { nativeBody: '\ufeffwindow.sourceRevision="same";' });
  const token = f.inspector.snapshot().token;
  const call = () => f.page.evaluate(token => window.__paqviloModelPanelApi({ token, name: 'diff', body: { rel: 'x_script.js' } }), token);
  const bom = await call();
  assert.equal(bom.ok, true); assert.equal(bom.rawEqual, false);
  const lease = f.overlay.nativeRead('x_script.js');
  const bytes = await f.page.evaluate(readModelDrivenNativeSource, { origin: f.origin, path: lease.path, token: lease.token }); lease.release();
  assert.equal(bytes.ok, true); assert.equal(bytes.text.charCodeAt(0), 0xfeff);
  assert.equal(Buffer.byteLength(bytes.text), bytes.bytes, 'BOM bytes survive the browser/controller boundary');
  const original = f.page.evaluate.bind(f.page); let release, started;
  const began = new Promise(resolve => { started = resolve; });
  f.page.evaluate = (fn, input) => fn.name === 'readModelDrivenNativeSource' ? new Promise(resolve => { release = resolve; started(); }) : original(fn, input);
  const pending = call(); await began;
  const next = f.makeImported('window.sourceRevision="new";'); f.overlay.replace(next); f.inspector.refresh(next);
  release({ ok: true, text: 'old source', bytes: 10 });
  const result = await pending; assert.equal(result.ok, false); assert.match(result.error, /revision changed/);
  f.page.evaluate = original;
});

test('a paused comparison evaluator releases its lease at the Node deadline and permits a fresh read', {timeout:20000}, async t => {
  const f = await modelPanelFixture(t), original = f.page.evaluate.bind(f.page);
  // The deadline timer is created synchronously after the paused read starts; only that window uses
  // mock timers, and the deadline elapses at once instead of after 13 real seconds.
  let paused = 0, settled = false, settledBeforeDeadline;
  f.page.evaluate = (fn, input) => {
    if (fn.name !== 'readModelDrivenNativeSource') return original(fn, input);
    paused++; t.mock.timers.enable({ apis: ['setTimeout'] });
    queueMicrotask(async () => {
      // A result released early would reach Node within this real 300 ms window (immediates are not mocked).
      t.mock.timers.tick(12_999);
      for (const end = performance.now() + 300; performance.now() < end;) await new Promise(resolve => setImmediate(resolve));
      settledBeforeDeadline = settled;
      t.mock.timers.tick(1); t.mock.timers.reset();
    });
    return new Promise(() => {});
  };
  const token = f.inspector.snapshot().token;
  const result = await original(token => window.__paqviloModelPanelApi({ token, name: 'diff', body: { rel: 'x_script.js' } }), token).finally(() => { settled = true; });
  assert.equal(paused, 1); assert.equal(settledBeforeDeadline, false, 'the paused read is still awaited 1 ms before the deadline');
  assert.equal(result.ok, false); assert.match(result.error, /13 seconds/);
  f.page.evaluate = original;
  const fresh = await original(token => window.__paqviloModelPanelApi({ token, name: 'diff', body: { rel: 'x_script.js' } }), token);
  assert.equal(fresh.ok, true);
});


test('canonical Issues shows source reasons, console warnings and request failures in distinct groups', {timeout:10000}, async t => {
  const f = await modelPanelFixture(t), host = f.page.locator('#paqvilo-panel');
  const next = f.makeImported('window.sourceRevision="same";');
  next.diagnostics = [{code:'INVENTED_MAPPING',message:'An observed native mapping is required.',source:f.file}];
  f.overlay.replace(next); f.inspector.refresh(next);
  await f.page.route('**/failed-asset.js',route=>route.abort('failed'));
  await f.page.evaluate(async()=>{console.warn('Invented native console warning');await fetch('/failed-asset.js').catch(()=>{});});
  await host.getByRole('tab',{name:/^Issues/}).click();
  await host.getByText('INVENTED_MAPPING: An observed native mapping is required.',{exact:true}).waitFor();
  await host.getByText('Invented native console warning',{exact:true}).waitFor();
  await host.getByText('net::ERR_FAILED',{exact:true}).waitFor();
  await host.getByText('Console warnings',{exact:true}).waitFor();
  await host.getByText('Failed requests',{exact:true}).waitFor();
  const text=await host.evaluate(node=>node.shadowRoot.textContent);assert.match(text,/Console warnings/);assert.match(text,/Failed requests/);
  const title=await host.locator('.pill .n.err').getAttribute('title');
  assert.match(title,/1 failed request/);
  assert.equal(await host.locator('.pill .n.warn').textContent(),'2','one source note and one console warning');
});


test('mapped runtime locations open the exact selected source at one-based line and column, while native-only URLs stay display-only', {timeout:10000}, async t => {
  const f=await modelPanelFixture(t), host=f.page.locator('#paqvilo-panel');
  const next=f.makeImported('window.sourceRevision="same";\n\nconsole.error("Invented mapped error");');
  f.overlay.replace(next); f.inspector.refresh(next);
  await f.page.evaluate(()=>new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/%7b2026%7d/webresources/x_script.js';script.onload=resolve;script.onerror=reject;document.body.append(script);}));
  await host.getByRole('tab',{name:/^Issues/}).click();
  const error=host.getByText('Invented mapped error',{exact:true});await error.waitFor();
  const row=error.locator('xpath=ancestor::div[contains(@class,"row")][1]');
  assert.equal(await row.getAttribute('data-rel'),'x_script.js');
  assert.equal(await row.getAttribute('data-line'),'3');assert.equal(await row.getAttribute('data-col'),'9');
  assert.equal(await row.locator('button.main').getAttribute('title'),'Open in the editor at line 3');
  f.overlay.setOnline(true);
  await f.page.route('**/webresources/x_script.js',route=>route.abort('failed'));
  await f.page.evaluate(()=>fetch('/%7b2026%7d/webresources/x_script.js').catch(()=>{}));
  const failed=host.getByText('net::ERR_FAILED',{exact:true});await failed.waitFor();
  assert.equal(await failed.locator('xpath=ancestor::div[contains(@class,"row")][1]').getAttribute('data-rel'),'x_script.js');
});


test('inspector drains shared-panel DOM and listeners even when owned discovery removal fails', {timeout:10000}, async t => {
  const f=await modelPanelFixture(t);
  const discovery=f.inspector.agent.discoveryFile;
  await fs.rm(discovery);await fs.mkdir(discovery);
  await assert.rejects(f.inspector.close(),cause=>['EPERM','EISDIR','ERR_FS_EISDIR'].includes(cause.code));
  await f.page.waitForFunction(()=>!document.getElementById('paqvilo-panel')&&!document.getElementById('paqvilo-xray'));
  assert.equal(f.context.browser().isConnected(),true,'inspector disposal does not close an attached browser');
  assert.equal(await f.page.evaluate(()=>typeof window.__paqviloModelPanelApi),'undefined','retired transport wrapper is removed');
  assert.equal(f.page.listenerCount('console'),0);assert.equal(f.page.listenerCount('response'),0);
});

test('mapped nonGit and archive sources can bootstrap explicit native Diff', {timeout:15000}, async t=>{
 for(const archive of [false,true]){
  await t.test(archive?'archive':'directory',async child=>{
   const f=await modelPanelFixture(child,{withGit:false,archive});
   const button=f.page.locator('#paqvilo-panel [data-rel="x_script.js"] [data-act=diff]');
   await f.page.locator('#paqvilo-panel [data-rel="x_script.js"]').hover();
   await button.click();await f.page.getByText('No difference',{exact:true}).waitFor();
   assert.deepEqual(f.nativeHeaders,[undefined]);
  });
 }
});

test('Power Pages capability restores a visible tab after an Actions-tab UI state', {timeout:10000}, async t=>{
 const f=await modelPanelFixture(t),state=f.inspector.snapshot();await f.inspector.close();
 const data=modelDrivenPanelData(state,{cfg:{},ui:{open:true,tab:'actions'}});
 await f.page.evaluate(panelUi,{...data,token:'invented-pp-state',transport:undefined,modelDriven:false,capabilities:{actions:false,targets:false},items:[],notes:[],inspection:{active:false}});
 assert.equal(await f.page.getByRole('tab',{name:'Actions',exact:true}).count(),0);
 assert.equal(await f.page.getByRole('tab',{name:/^Overrides/}).getAttribute('aria-selected'),'true');
});


test('mapped thrown script errors retain exact source positions and Chromium network console duplicates stay out of JS errors', {timeout:10000}, async t => {
 const f=await modelPanelFixture(t),host=f.page.locator('#paqvilo-panel');
 const next=f.makeImported('window.sourceRevision="same";\n\nthrow new Error("Invented mapped exception");');
 f.overlay.replace(next);f.inspector.refresh(next);
 await f.page.evaluate(()=>new Promise(resolve=>{const script=document.createElement('script');script.src='/%7b2026%7d/webresources/x_script.js';script.onload=resolve;script.onerror=resolve;document.body.append(script);}));
 await host.getByRole('tab',{name:/^Issues/}).click();
 const exception=host.getByText('Invented mapped exception',{exact:true});await exception.waitFor();
 const row=exception.locator('xpath=ancestor::div[contains(@class,"row")][1]');
 assert.equal(await row.getAttribute('data-rel'),'x_script.js');assert.equal(await row.getAttribute('data-line'),'3');
 assert.equal(await row.locator('button.main').getAttribute('title'),'Open in the editor at line 3');
 await f.page.route('**/failed-native.js',route=>route.abort('failed'));
 await f.page.evaluate(()=>fetch('/failed-native.js').catch(()=>{}));
 await host.getByText('net::ERR_FAILED',{exact:true}).waitFor();
 assert.equal(await host.locator('.pill .n.err').getAttribute('title'),'1 JavaScript error, 1 failed request');
 assert.equal(await host.getByText(/^Failed to load resource/).count(),0,'network failures retain one failed-request entry');
});


test('a warning-only shared panel counts one issue without a JavaScript or network error', {timeout:10000}, async t => {
 const f=await modelPanelFixture(t),state=f.inspector.snapshot();await f.inspector.close();
 const data=modelDrivenPanelData({...state,resources:[],diagnostics:[],problems:[{type:'warning',text:'Invented warning only'}]},{cfg:{},ui:{open:true,tab:'issues'}});
 await f.page.evaluate(panelUi,{...data,token:'warning-only-fixture',capabilities:{actions:false,targets:false},inspection:{active:false}});
 const host=f.page.locator('#paqvilo-panel');
 assert.equal(await host.getAttribute('data-issues'),'1');assert.equal(await host.locator('.pill .n.warn').textContent(),'1');
 assert.equal(await host.locator('.pill .n.err').count(),0);await host.getByText('Console warnings',{exact:true}).waitFor();
 await host.getByText('Invented warning only',{exact:true}).waitFor();
});
