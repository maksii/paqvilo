import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runAcceptance } from '../acceptance.mjs';

async function navigationFixture(t, { history = 'hash', late = false, completed = false, noCommit = false, noContent = false, resetNavigation=false, documentDelay, redirectHops = 1, noNavigation = false, redirect = false, child = false, writeMs = 0, actionDelay = 0, replacementRead = false, embedded = false, crossOrigin = false, timeout = 4000, navigationCommitReserveMs } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-document-commit-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const historyChange = history === 'none' ? '' : history === 'hash' ? "location.hash='pending'" : "history.pushState({},'', '?pending=1')";
  const writes = `fetch('/slow-one',{method:'PATCH'}).catch(()=>{});fetch('/slow-two',{method:'POST'}).catch(()=>{})`;
  const form = `<form action="/submit" method="${redirect ? 'POST' : 'GET'}"><button id="save">Save</button></form>`;
  const script = `document.querySelector('form').addEventListener('submit',event=>{${actionDelay ? `const end=Date.now()+${actionDelay};while(Date.now()<end){}` : ''}${noNavigation ? 'event.preventDefault();' : ''}${noCommit ? "fetch('/never').catch(()=>{});" : late ? '' : writes};setTimeout(()=>{${historyChange}},50);${late ? `setTimeout(()=>{${writes}},150);` : ''}})`;
  const server = http.createServer((req, res) => {
    req.resume();
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname.startsWith('/__sim/api/')) {
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify(pathname.endsWith('/state') ? { config: {mode: 'local', pageMode: 'local', endpoints: []}, status: { sourceFingerprint: 'fixture', implementationFingerprint: 'fixture' } } : { events: [] }));
    }
    if (pathname.startsWith('/slow-') || pathname === '/never') {
      if (pathname !== '/never' && (completed || writeMs)) {
        const timer = setTimeout(() => res.end('done'), writeMs || 1000);
        res.once('close', () => clearTimeout(timer));
      }
      return;
    }
    res.setHeader('content-type', 'text/html');
    if (pathname === '/submit' || pathname.startsWith('/hop-')) {
      const timer = setTimeout(() => {
        if (resetNavigation)return req.socket.destroy();
        if (noCommit||noContent) { res.statusCode = typeof noContent === 'number' ? noContent : 204; return res.end(); }
        const hop = pathname === '/submit' ? 1 : Number(pathname.slice(5));
        if (redirect && hop <= redirectHops) { res.statusCode = 303; res.setHeader('location', hop < redirectHops ? '/hop-' + (hop + 1) : '/done'); return res.end(); }
        res.end('<p id="done">Saved</p>' + (replacementRead ? "<script>fetch('/never').catch(()=>{})</script>" : ''));
      }, documentDelay ?? (redirect ? 20 : 1500));
      res.once('close', () => clearTimeout(timer));
      return;
    }
    if (pathname === '/done') {
      const timer = setTimeout(() => res.end('<p id="done">Saved</p>' + (replacementRead ? "<script>fetch('/never').catch(()=>{})</script>" : '')), redirectHops > 1 ? documentDelay : 0);
      res.once('close', () => clearTimeout(timer)); return;
    }
    if (embedded && pathname === '/') return res.end(`<iframe id="child" src="${crossOrigin ? `http://localhost:${server.address().port}` : ''}/child"></iframe>`);
    if (child && pathname === '/') return res.end(`<iframe id="child" src="/child"></iframe>${form}<script>document.querySelector('form').addEventListener('submit',()=>{document.querySelector('iframe').contentWindow.startWrites()})</script>`);
    res.end(form + `<script>${child ? `window.startWrites=()=>{${writes}}` : script}</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const result = await runAcceptance({ localUrl: `http://127.0.0.1:${server.address().port}`, outputDir: path.join(root, 'evidence'), timeout, navigationCommitReserveMs,
    flows: [{ name: 'Document boundary', steps: [{ action: 'navigate', path: '/' }, ...(child || embedded ? [{action: 'visible', frame: '#child', selector: '#save'}] : []), { action: 'click', selector: '#save', ...(embedded ? {frame: '#child'} : {}) }, { action: 'settle' }, ...(!noCommit && !noContent && !resetNavigation && !noNavigation ? [{ action: 'visible', selector: '#done', ...(embedded ? {frame: '#child'} : {}) }] : [])] }] });
  return result.flows[0];
}

for (const history of ['hash', 'pushState']) test(`same-document ${history} does not consume a pending document replacement`, { timeout: 30000 }, async t => {
  const flow = await navigationFixture(t, { history, late: true });
  assert.equal(flow.passed, true, JSON.stringify(flow));
  assert.equal(flow.navigationCancelledRequests?.length, 2);
  assert.ok(flow.navigationCancelledRequests.every(row => row.reason === 'document-replaced'));
});

test('writes completed before a document commits stay finished across a hash change', { timeout: 30000 }, async t => {
  const flow = await navigationFixture(t, { completed: true, timeout: 8000 });
  assert.equal(flow.passed, true, JSON.stringify(flow));
  assert.equal(flow.navigationCancelledRequests?.length ?? 0, 0);
  assert.equal(flow.resources.filter(row => /slow-/.test(row.url) && row.finished).length, 2);
});

for (const noNavigation of [false, true]) test(`a hash change cannot retire a hanging read (${noNavigation ? 'no navigation' : '204 navigation'})`, { timeout: 30000 }, async t => {
  const flow = await navigationFixture(t, { noCommit: true, noNavigation, timeout: 2500 });
  assert.equal(flow.passed, false);
  assert.match(flow.error, /Portal requests did not settle.*GET.*never/);
  assert.equal(flow.navigationCancelledRequests?.length ?? 0, 0);
});

for (const child of [false, true]) test(`redirect chains share one navigation hold (${child ? 'child' : 'main'} writes)`, { timeout: 30000 }, async t => {
  const flow = await navigationFixture(t, { redirect: true, history: 'none', child, writeMs: 15000 });
  assert.equal(flow.passed, true, JSON.stringify(flow));
  assert.equal(flow.navigationCancelledRequests?.length, 2);
  assert.ok(flow.navigationCancelledRequests.every(row => row.reason === (child ? 'frame-detached' : 'document-replaced')));
  assert.ok(flow.navigationWaits.reduce((sum, row) => sum + row.waitedMs, 0) <= 3300);
});

test('redirect waits allow writes within the navigation budget to finish', { timeout: 30000 }, async t => {
  const flow = await navigationFixture(t, { redirect: true, history: 'none', writeMs: 3000, timeout: 8000 });
  assert.equal(flow.passed, true, JSON.stringify(flow));
  assert.equal(flow.navigationCancelledRequests?.length ?? 0, 0);
  assert.equal(flow.resources.filter(row => /slow-/.test(row.url) && row.finished).length, 2);
});


test('same-document changes in a child frame keep its real replacement observable', { timeout: 30000 }, async t => {
  const flow = await navigationFixture(t, { embedded: true, late: true });
  assert.equal(flow.passed, true, JSON.stringify(flow));
  assert.equal(flow.navigationCancelledRequests?.length, 2);
  assert.ok(flow.navigationCancelledRequests.every(row => row.reason === 'document-replaced'));
});

test('replacement document requests remain pending after retiring its predecessor', { timeout: 30000 }, async t => {
  const flow = await navigationFixture(t, { replacementRead: true, late: true, timeout: 2500 });
  assert.equal(flow.passed, false);
  assert.match(flow.error, /Portal requests did not settle.*GET.*never/);
  assert.equal(flow.navigationCancelledRequests?.length, 2);
  assert.ok(flow.navigationCancelledRequests.every(row => /slow-/.test(row.url)));
});


test('parity browser settling preserves pending requests across same-document changes', { timeout: 30000 }, async t => {
  const { openOwnedBrowser } = await import('../parity-suite.mjs');
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://fixture').pathname;
    if (pathname.startsWith('/never')) return;
    res.setHeader('content-type', 'text/html');
    if (pathname === '/done') return res.end('<p>Replacement</p>');
    if (pathname === '/new') return res.end("<p>Replacement</p><script>fetch('/never-new')</script>");
    const change = pathname === '/hash' ? "location.hash='pending'" : pathname === '/history' ? "history.replaceState({},'', '?pending=1')" : `location.href='${pathname === '/replace' ? '/done' : '/new'}'`;
    res.end(`<p>Original</p><script>fetch('/never-old');setTimeout(()=>{${change}},100)</script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const browser = await openOwnedBrowser();
  t.after(() => browser.close());
  const driver = browser.pageDriver(`http://127.0.0.1:${server.address().port}`, 'anonymous');
  for (const pathname of ['/hash', '/history', '/replace', '/replace-new']) await t.test(pathname, async () => {
    const observation = await driver.page(pathname, { settleTimeout: 1500 });
    assert.equal(observation.settled, pathname === '/replace', JSON.stringify(observation));
    if (pathname !== '/replace') assert.ok(observation.pendingRequests.some(value => value.includes(pathname === '/replace-new' ? '/never-new' : '/never-old')));
    if (pathname === '/replace-new') assert.ok(!observation.pendingRequests.some(value => value.includes('/never-old')));
  });
});


test('a delayed form submission keeps its hold inside the triggering click deadline', { timeout: 30000 }, async t => {
  const flow = await navigationFixture(t, { redirect: true, history: 'none', writeMs: 15000, actionDelay: 1800 });
  assert.equal(flow.passed, true, JSON.stringify(flow));
  assert.equal(flow.navigationCancelledRequests?.length, 2);
  assert.ok(flow.navigationWaits.reduce((sum, row) => sum + row.waitedMs, 0) < 1800);
});

test('cross-origin child document commits retire only their predecessor requests',{timeout:30000},async t=>{
 const flow=await navigationFixture(t,{embedded:true,crossOrigin:true,late:true});
 assert.equal(flow.passed,true,JSON.stringify(flow));assert.equal(flow.navigationCancelledRequests?.length,2);
 assert.ok(flow.navigationCancelledRequests.every(row=>row.reason==='document-replaced'));assert.deepEqual(flow.blockedRequests,[]);
});


test('acceptance distinguishes failed loopback writes from external proxy refusals', {timeout:30000}, async t=>{
 const directory=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-acceptance-local-boundary-'));t.after(()=>fs.rm(directory,{recursive:true,force:true}));
 const server=http.createServer((req,res)=>{
  req.resume();const url=new URL(req.url,'http://fixture');
  if(url.pathname.startsWith('/__sim/api/')){res.setHeader('content-type','application/json');return res.end(JSON.stringify(url.pathname.endsWith('/state')?{config:{mode:'local',pageMode:'local',endpoints:[]},status:{sourceFingerprint:'fixture',implementationFingerprint:'fixture'}}:{events:[]}));}
  if(url.pathname==='/aborted-write')return;
  if(url.pathname==='/failed-write')return req.socket.destroy();
  res.setHeader('content-type','text/html');
  if(url.pathname==='/child'){
   const action=url.searchParams.get('case')==='abort'?"const controller=new AbortController();fetch('/aborted-write',{method:'PATCH',signal:controller.signal}).catch(()=>{});setTimeout(()=>controller.abort(),200)":url.searchParams.get('case')==='fail'?"fetch('/failed-write',{method:'POST'}).catch(()=>{})":"fetch('https://outside.invalid/blocked-write',{method:'POST',mode:'no-cors',body:'invented fixture'}).catch(()=>{})";
   return res.end(`<button id="send" onclick="${action}">Send</button>`);
  }
  res.end(`<iframe id="child" src="http://localhost:${server.address().port}/child?case=${url.pathname.slice(1)}"></iframe>`);
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 for(const kind of ['abort','fail','external'])await t.test(kind,async()=>{
  const result=await runAcceptance({localUrl:`http://127.0.0.1:${server.address().port}`,outputDir:path.join(directory,kind),timeout:3000,flows:[{name:kind,steps:[{action:'navigate',path:'/'+kind},{action:'click',frame:'#child',selector:'#send'},{action:'settle'}]}]});
  const flow=result.flows[0];assert.equal(flow.passed,false,JSON.stringify(flow));
  assert.ok(flow.failedRequests.some(request=>request.method===(kind==='abort'?'PATCH':'POST')),JSON.stringify(flow));
  assert.equal(flow.navigationCancelledRequests?.length??0,0);
  if(kind==='external'){assert.ok(flow.blockedRequests.some(request=>request.method==='POST'&&request.url==='https://outside.invalid/blocked-write'),JSON.stringify(flow));assert.match(flow.error,/blockedRequests/);}
  else{assert.deepEqual(flow.blockedRequests,[],JSON.stringify(flow));assert.match(flow.error,/failedRequests/);}
 });
});

for(const redirect of [false,true])test(`a slow ${redirect?'POST redirect':'GET document'} retains a fallback reserve for its commit`,{timeout:30000},async t=>{
 const flow=await navigationFixture(t,{redirect,history:'none',writeMs:15000,documentDelay:1500,timeout:4000});
 assert.equal(flow.passed,true,JSON.stringify(flow));assert.equal(flow.navigationCancelledRequests.length,2);assert.ok(flow.navigationWaits.every(wait=>wait.commitReserveMs>1000&&wait.commitReserveMs<=2000&&wait.commitReservePolicy==='bounded-write-fallback'));
});

test('the fallback reserve leaves time for a 2.5 s document with writes exceeding a 15 s action',{timeout:30000},async t=>{
 const flow=await navigationFixture(t,{history:'none',writeMs:30000,documentDelay:2500,timeout:15000});
 assert.equal(flow.passed,true,JSON.stringify(flow));assert.equal(flow.navigationCancelledRequests.length,2);
 assert.ok(flow.navigationCancelledRequests.every(row=>row.reason==='document-replaced'));
 assert.ok(flow.navigationWaits.every(wait=>wait.commitReservePolicy==='bounded-write-fallback'&&wait.commitReserveMs>=9000));
});
test('a short action retains its half-budget bound when a 2.5 s replacement cannot fit',{timeout:15000},async t=>{
 const flow=await navigationFixture(t,{history:'none',writeMs:30000,documentDelay:2500,timeout:4000});
 assert.equal(flow.passed,false);assert.match(flow.error,/Timeout 4000ms/);
 assert.ok(flow.navigationWaits.some(wait=>wait.commitReservePolicy==='bounded-write-fallback'&&wait.commitReserveMs>1000&&wait.commitReserveMs<=2000));
});
test('4 s writes settle before an immediate redirect within an 8 s action in three successive runs',{timeout:45000},async t=>{
 for(let run=0;run<3;run++){
  const flow=await navigationFixture(t,{redirect:true,history:'none',writeMs:4000,documentDelay:0,timeout:8000});
  assert.equal(flow.passed,true,JSON.stringify(flow));assert.equal(flow.navigationCancelledRequests?.length??0,0);assert.equal(flow.resources.filter(row=>/slow-/.test(row.url)&&row.finished).length,2);
  assert.ok(flow.navigationWaits.some(wait=>wait.commitReservePolicy==='bounded-write-fallback'&&wait.commitReserveMs===3000));
 }
});
test('an explicit navigation commit reserve overrides the default half-time budget',{timeout:15000},async t=>{
 const flow=await navigationFixture(t,{history:'none',writeMs:30000,documentDelay:2500,timeout:4000,navigationCommitReserveMs:3000});
 assert.equal(flow.passed,true,JSON.stringify(flow));assert.equal(flow.navigationCancelledRequests.length,2);
 assert.ok(flow.navigationWaits.every(wait=>wait.commitReservePolicy==='explicit'&&wait.commitReserveMs===3000));
});
for(const status of [204,205])test(`a ${status} no-content navigation keeps both completed writes and is separate from failed requests`,{timeout:30000},async t=>{
 const flow=await navigationFixture(t,{noContent:status,completed:true,writeMs:1000,documentDelay:300,timeout:8000});
 assert.equal(flow.passed,true,JSON.stringify(flow));assert.deepEqual(flow.failedRequests,[]);assert.equal(flow.noContentNavigations[0].status,status);assert.equal(flow.resources.filter(row=>/slow-/.test(row.url)&&row.finished).length,2);
});
test('a fast initial page cannot shrink the fallback reserve for a new 5 s document', {timeout:30000}, async t => {
 const flow = await navigationFixture(t, {history:'none',writeMs:30000,documentDelay:5000,timeout:15000});
 assert.equal(flow.passed,true,JSON.stringify(flow));
 assert.ok(flow.navigationWaits.every(wait=>wait.commitReservePolicy==='bounded-write-fallback'&&wait.comparableNavigationMs===null&&wait.commitReserveMs>=9000));
 assert.ok(flow.navigationWaits.every(wait=>wait.actionRemainingMs-wait.commitReserveMs<200));
});
test('a new POST to 303 to 303 to GET chain reserves all three slow response hops', {timeout:30000}, async t => {
 const flow = await navigationFixture(t, {redirect:true,redirectHops:2,history:'none',writeMs:30000,documentDelay:2500,timeout:15000});
 assert.equal(flow.passed,true,JSON.stringify(flow));
 assert.ok(flow.navigationWaits.every(wait=>wait.commitReservePolicy==='bounded-write-fallback'&&wait.commitReserveMs>=9000));
 assert.ok(flow.navigationWaits.reduce((sum,wait)=>sum+wait.waitedMs,0)<5500);
});
test('a reset navigation without an HTTP response remains a failed request',{timeout:30000},async t=>{
 const flow=await navigationFixture(t,{resetNavigation:true,completed:true,writeMs:100,documentDelay:300});
 assert.equal(flow.passed,false);assert.ok(flow.failedRequests.length>0);
});

test('a previously completed comparable redirect chain extends the next commit reserve', { timeout: 30000 }, async t => {
 const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-comparable-chain-'));
 t.after(() => fs.rm(directory, { recursive: true, force: true }));
 const markup = writes => `<p id="done">Invented page</p><form action="/save" method="POST"><button id="save">Save</button></form>${writes ? `<script>document.querySelector('form').addEventListener('submit',()=>{fetch('/slow-one',{method:'PATCH'}).catch(()=>{});fetch('/slow-two',{method:'POST'}).catch(()=>{});})</script>` : ''}`;
 const server = http.createServer((req, res) => {
  req.resume(); const pathname = new URL(req.url, 'http://fixture').pathname;
  if (pathname.startsWith('/__sim/api/')) { res.setHeader('content-type','application/json'); return res.end(JSON.stringify(pathname.endsWith('/state') ? { config:{mode:'local',pageMode:'local',endpoints:[]},status:{sourceFingerprint:'fixture',implementationFingerprint:'fixture'} } : {items:[]})); }
  if (pathname.startsWith('/slow-')) return;
  res.setHeader('content-type','text/html');
  if (['/save','/hop','/done'].includes(pathname)) {
   const timer = setTimeout(() => { if (pathname !== '/done') { res.statusCode=303; res.setHeader('location',pathname === '/save' ? '/hop' : '/done'); res.end(); } else res.end(markup(true)); },800);
   res.once('close',()=>clearTimeout(timer)); return;
  }
  res.end(markup(false));
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
 const result = await runAcceptance({localUrl:`http://127.0.0.1:${server.address().port}`,outputDir:path.join(directory,'evidence'),timeout:5000,flows:[{name:'Comparable chain',steps:[{action:'navigate',path:'/'},{action:'click',selector:'#save'},{action:'visible',selector:'#done'},{action:'click',selector:'#save'},{action:'settle'},{action:'visible',selector:'#done'}]}]});
 const flow=result.flows[0]; assert.equal(flow.passed,true,JSON.stringify(flow));
 assert.ok(flow.navigationWaits.length>0);
 assert.ok(flow.navigationWaits.every(wait=>wait.commitReservePolicy==='comparable-navigation-chain'&&wait.comparableNavigationMs>=2300&&wait.commitReserveMs>=3300),JSON.stringify(flow.navigationWaits));
 assert.equal(flow.navigationCancelledRequests.length,2,'browser cancellations remain recorded without claiming those writes committed');
 t.diagnostic(JSON.stringify({navigationWaits:flow.navigationWaits.map(({commitReservePolicy,comparableNavigationMs,commitReserveMs,waitedMs,settled})=>({commitReservePolicy,comparableNavigationMs,commitReserveMs,waitedMs,settled}))}));
});
