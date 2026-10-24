import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';
// Response ordering and history navigation.
import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../mirage/lib/browser-launch.mjs';
import {createFixture,SITE} from '../test/fixture.mjs';
import {fakeBrowser} from '../test/fake-browser.mjs';
import {OverlaySession} from '../lense/session.mjs';
import {enablePanel} from '../lense/panel.mjs';
import {panelUi} from '../lense/panel-ui.mjs';
import {xrayUi} from '../lense/xray-ui.mjs';

const origin='http://127.0.0.1:11111';
let browser;
before(async()=>{browser=await chromium.launch(browserLaunchOptions({headless:true}));});
after(()=>browser?.close());
const report=name=>({page:null,webTemplates:[],forms:[],views:[],columns:[],components:[],tables:[],unresolved:[],elementSources:[{name,selector:'#picked',tag:'button',kind:'template',matchKind:'id',ref:name+'.html'}]});
async function fixture(t){
  const source=createFixture(),fake=fakeBrowser(),fakeTab=fake.openTab(origin+'/');
  const session=new OverlaySession({origin,sourceDir:source.dir,site:structuredClone(SITE),siteName:'Invented',envName:'loopback',stateDir:source.dir});
  const controller=enablePanel(fake.context,session),state=controller.stateFor(fakeTab.page);
  const context=await browser.newContext({viewport:{width:1440,height:1000}});
  ownedFixture(t).add(async () => { await controller.dispose(); });
  ownedFixture(t).add(async () => { await context.close(); });
  ownedFixture(t).remove(async () => { source.cleanup(); });
  const page=await context.newPage(),pending=[];
  page.setDefaultTimeout(5000);
  await page.route('**/*',route=>{
    if(new URL(route.request().url()).pathname==='/__paqvilo/api/inspect'){pending.push({route,body:route.request().postDataJSON()});return;}
    if(route.request().resourceType()==='document')return route.fulfill({contentType:'text/html',body:'<!doctype html><button id="picked" style="margin-top:180px">Invented control</button>'});
    return route.fulfill({json:{ok:true}});
  });
  await page.goto(origin);
  state.ui={open:true,tab:'runtime'};state.inspection={active:true,version:1,path:'/',mode:'live-sources',counts:{}};
  await page.evaluate(xrayUi,state);await page.evaluate(panelUi,state);
  const waitForRequest=async count=>{const end=Date.now()+5000;while(pending.length<count&&Date.now()<end)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(pending.length,count);return pending[count-1];};
  const answer=async(index,version,name)=>{await pending[index].route.fulfill({json:{ok:true,version,report:report(name)}});};
  await waitForRequest(1);await answer(0,1,'Old source');
  await page.waitForFunction(()=>document.getElementById('paqvilo-xray').__px.identify(document.getElementById('picked')).title==='Old source');
  await page.evaluate(()=>{const api=document.getElementById('paqvilo-xray').__px;api.toggle(true);api.select(document.getElementById('picked'));});
  const identity=()=>page.evaluate(()=>document.getElementById('paqvilo-xray').__px.identify(document.getElementById('picked')).title);
  const update=async(version,path)=>{state.inspection={...state.inspection,version,path};await page.evaluate(path=>history.pushState(null,'',path),path);await page.evaluate(panelUi,state);};
  return {page,pending,waitForRequest,answer,identity,update};
}

test('X-ray clears an older report immediately during a delayed history navigation inspection',async t=>{
  const {page,waitForRequest,answer,identity,update}=await fixture(t);
  await update(2,'/next/');await waitForRequest(2);
  assert.equal(await identity(),'No reliable source','old source ownership cannot remain visible while a newer page report is pending');
  assert.doesNotMatch(await page.locator('#paqvilo-xray .card').innerText(),/Old source/);
  await answer(1,2,'Current source');
  await page.waitForFunction(()=>document.getElementById('paqvilo-xray').__px.identify(document.getElementById('picked')).title==='Current source');
});

test('a delayed manual refresh clears its old report and cannot overwrite a newer navigation response',async t=>{
  const {page,waitForRequest,answer,identity,update}=await fixture(t);
  await page.locator('#paqvilo-xray [data-action=refresh]').click();
  const refresh=await waitForRequest(2);assert.equal(refresh.body.refresh,true);
  assert.equal(await identity(),'No reliable source','manual refresh also invalidates the old identity immediately');
  await update(3,'/latest/');await waitForRequest(3);await answer(2,3,'Latest source');
  await page.waitForFunction(()=>document.getElementById('paqvilo-xray').__px.identify(document.getElementById('picked')).title==='Latest source');
  await answer(1,2,'Obsolete refresh');
  await page.waitForTimeout(100);assert.equal(await identity(),'Latest source');
  assert.doesNotMatch(await page.locator('#paqvilo-xray .card').innerText(),/Old source|Obsolete refresh/);
});
