import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../mirage/lib/browser-launch.mjs';
import {createFixture,SITE} from '../test/fixture.mjs';
import {OverlaySession} from '../lense/session.mjs';
import {enablePanel} from '../lense/panel.mjs';
import {devDialogs} from '../lense/dev-dialogs.mjs';

async function fixture(t,html='<h1>Invented page</h1>'){
  const fx=createFixture();let browser,panel;
  const server=http.createServer((req,res)=>{
    if(req.url.startsWith('/error')){
      if(req.url==='/error-hanging'){res.writeHead(400,{'content-type':'application/json'});res.write('{"error":');return;}
      const body=JSON.stringify({error:{message:req.url==='/error-large'?'x'.repeat(40000):'<img src=x onerror=alert(1)> Missing parent',innererror:{message:'Internal cause'}}});
      res.writeHead(400,{'content-type':'application/json',...(req.url==='/error-sized'?{'content-length':Buffer.byteLength(body)}:{})});
      res.write(body.slice(0,40));setTimeout(()=>res.end(body.slice(40)),15);return;
    }
    res.writeHead(200,{'content-type':'text/html'}).end('<!doctype html>'+html);
  });
  t.after(async()=>{await panel?.dispose();await browser?.close();server.closeAllConnections();await new Promise(r=>server.close(r));fx.cleanup();});
  server.listen(0,'127.0.0.1');await once(server,'listening');const origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch(browserLaunchOptions({headless:true}));const context=await browser.newContext({viewport:{width:1000,height:700}});context.setDefaultTimeout(10000);
  const session=new OverlaySession({sourceDir:fx.dir,origin,site:structuredClone(SITE),sourceMaps:false,siteName:'invented',envName:'local'});
  panel=enablePanel(context,session);await context.route('**/__paqvilo/api/**',route=>session.api(route,new URL(route.request().url()).pathname.split('/').at(-1)));
  const page=await context.newPage();await page.goto(origin);await panel.ready;await panel.draw(page);
  return {page,context,session,panel,origin};
}

test('chunked and sized JSON failures retain escaped details; oversized bodies keep only HTTP metadata',async t=>{
  const {page,panel}=await fixture(t);
  for(const route of ['/error-small','/error-large','/error-sized']){
    const original=page.waitForResponse(response=>new URL(response.url()).pathname===route);
    await page.evaluate(async route=>{await(await fetch(route)).text();},route);
    if(route==='/error-large')assert.ok((await(await original).body()).length>32768,'bounded observer does not truncate the page or another protocol client');
    else await original;
  }
  const deadline=Date.now()+5000;while(panel.stateFor(page).problems.length<3&&Date.now()<deadline)await new Promise(r=>setTimeout(r,20));
  const rows=panel.stateFor(page).problems;
  assert.equal(rows.length,3);assert.equal(rows.find(row=>row.text.endsWith('/error-large')).where,'');
  for(const route of ['/error-small','/error-sized'])assert.match(rows.find(row=>row.text.endsWith(route)).where,/<img.*Missing parent · Internal cause/);
  await page.evaluate(()=>{window.hangingDone=false;void fetch('/error-hanging').then(response=>response.text()).then(()=>window.hangingDone=true).catch(()=>{});});
  const bodyDeadline=Date.now()+5000;while(!panel.stateFor(page).problems.some(row=>row.text.endsWith('/error-hanging'))&&Date.now()<bodyDeadline)await page.waitForTimeout(20);
  assert.equal(panel.stateFor(page).problems.find(row=>row.text.endsWith('/error-hanging'))?.status,400);
  assert.equal(await page.evaluate(()=>window.hangingDone),false,'observation must not cancel or finish the original stalled response');
  await panel.draw(page);await page.locator('#paqvilo-panel .pill').click();await page.locator('#paqvilo-panel [data-v=issues]').click();
  assert.equal(await page.locator('#paqvilo-panel img').count(),0);
  assert.match(await page.locator('#paqvilo-panel .body').innerText(),/<img src=x onerror=alert\(1\)> Missing parent/);
});

test('interactive dialogs await an answer and headless dismissals produce one panel activity event',async t=>{
  const {page,context,session,panel,origin}=await fixture(t);
  const config={origin,browser:{headless:false}};const stop=devDialogs(context,{configs:new Map([[origin,config]]),sessionFor:()=>session});t.after(stop);
  let settled=false;const dialogEvent=page.waitForEvent('dialog');const result=page.evaluate(()=>confirm('Publish invented item?')).then(value=>{settled=true;return value;});
  const dialog=await dialogEvent;await new Promise(r=>setTimeout(r,75));assert.equal(settled,false);await dialog.accept();assert.equal(await result,true);
  config.browser.headless=true;const events=[];session.on('dialog',event=>events.push(event));
  assert.equal(await page.evaluate(()=>confirm('Automated invented item?')),false);
  const deadline=Date.now()+1000;while(events.length<1&&Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
  assert.equal(events.length,1);assert.equal(events[0].type,'confirm');assert.equal(events[0].message,'Automated invented item?');
  assert.equal(panel.stateFor(page).activity.filter(row=>row.type==='dialog').length,1);
  assert.equal(await page.evaluate(()=>prompt('Invented prompt')),null);await page.evaluate(()=>alert('Invented alert'));
  await new Promise(r=>setTimeout(r,30));assert.deepEqual(events.map(row=>row.type),['confirm','prompt','alert']);
  await page.evaluate(()=>addEventListener('beforeunload',event=>{event.preventDefault();event.returnValue='';}));
  await page.locator('h1').click();await page.goto(origin+'/after');
  assert.equal(events.at(-1).type,'beforeunload');assert.equal(events.at(-1).disposition,'accepted','headless navigation preserves Playwright before-unload behavior');
  stop();const detachPolicy=devDialogs(context,{configs:new Map([[origin,config]]),sessionFor:()=>session,attached:true});t.after(detachPolicy);
  const attachedOpened=page.waitForEvent('dialog'),attachedResult=page.evaluate(()=>confirm('User-owned attached browser'));
  const attachedDialog=await attachedOpened;await attachedDialog.accept();assert.equal(await attachedResult,true,'configuration cannot auto-answer dialogs in a user-owned attached browser');
});

test('collapsed pill relocates after scroll/resize and selects the least obstructed corner',async t=>{
  const {page}=await fixture(t,'<style>body{height:2200px;margin:0}a{position:absolute;left:12px;top:1000px;width:280px;height:40px;background:red}</style><a id="moving" href="#clicked">Moving link</a>');
  const pill=page.locator('#paqvilo-panel .pill');
  const overlaps=()=>page.evaluate(()=>{const a=document.querySelector('#moving').getBoundingClientRect(),b=document.querySelector('#paqvilo-panel').shadowRoot.querySelector('.pill').getBoundingClientRect();return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top;});
  await page.evaluate(()=>scrollTo(0,350));await page.waitForTimeout(200);assert.equal(await overlaps(),false);
  await page.setViewportSize({width:1000,height:500});await page.evaluate(()=>scrollTo(0,550));await page.waitForTimeout(200);assert.equal(await overlaps(),false);
  await page.evaluate(()=>{document.querySelector('#moving').remove();for(const [corner,count]of [['lt',3],['rt',2],['lb',2],['rb',1]])for(let i=0;i<count;i++){const a=document.createElement('button');a.textContent=corner+i;a.style.cssText='position:fixed;width:240px;height:40px;'+(corner[0]==='l'?'left:12px;':'right:12px;')+(corner[1]==='t'?'top:12px;':'bottom:12px;');document.body.append(a);}dispatchEvent(new Event('resize'));});
  await page.waitForTimeout(200);const box=await pill.boundingBox();assert.ok(box.x>500&&box.y>250,'the corner with one control wins over corners with two or three');
  await page.keyboard.press('Alt+Shift+L');const notice=page.locator('#paqvilo-panel .float');assert.equal(await notice.getAttribute('role'),'status');assert.match(await notice.ariaSnapshot(),/status.*paqvilo is hidden/);
});
