import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import {once} from 'node:events';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../lib/browser-launch.mjs';
import {ownedFixture} from '../testing/owned-fixture.mjs';

let browser;
before(async()=>{browser=await chromium.launch(browserLaunchOptions({headless:true}));});
after(()=>browser?.close());
const fallback=await fs.readFile(new URL('../lib/platform-chrome.css',import.meta.url),'utf8');
// Bootstrap-like defaults expose the collisions addressed by the structural fallback.
const base=`*{box-sizing:border-box}body{margin:0}.progress{display:flex;height:16px;overflow:hidden;background:#eee}.list-group{display:flex;flex-direction:column;padding:0;list-style:none}.list-group-item{padding:12px;border:1px solid #ccc}.form-control{display:block;width:100%;padding:8px;border:1px solid #777;background:#eee}.section{width:100%}.info label{font-weight:400}`;
const form=`<div class="crmEntityFormView"><div class="entity-form form-readonly"><table class="section"><tbody><tr><td class="cell"><div class="info"><label for="name">Name</label></div><input id="name" class="form-control" readonly value="First"></td><td class="cell"><div class="info"><label for="code">Code</label></div><input id="code" class="form-control" readonly value="Second"></td><td class="cell zero-cell"></td></tr></tbody></table><label for="choice">Choice</label><select id="choice" class="form-control" disabled><option>Selected</option></select><textarea class="form-control" readonly aria-label="Description">A readable description</textarea></div></div>`;
async function fixture(t,html,{bootstrap=5}={}){
  const framework=bootstrap===3?base.replaceAll("display:flex", "display:block"):base;
  const owner=ownedFixture(t);let context;
  const server=http.createServer((req,res)=>res.writeHead(200,{'content-type':req.url==='/fallback.css'?'text/css':'text/html'}).end(req.url==='/fallback.css'?fallback:`<!doctype html><html lang="en"><head><style>${framework}</style><link rel="stylesheet" href="/fallback.css"></head><body>${html}</body></html>`));
  owner.add(()=>context?.close());owner.add(()=>new Promise((resolve,reject)=>server.close(error=>error?reject(error):resolve())));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  context=await browser.newContext();
  const page=await context.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);return page;
}

test('form cells stack through 767px in frames and retain desktop columns',async t=>{
  const page=await fixture(t,form);
  for(const width of [390,600,700,767,768,1000]){
    await page.setViewportSize({width,height:800});
    const facts=await page.evaluate(()=>{const boxes=[...document.querySelectorAll('td.cell:not(.zero-cell)')].map(n=>{const r=n.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,right:r.right}});return{boxes,zero:getComputedStyle(document.querySelector('.zero-cell')).display,overflow:document.documentElement.scrollWidth>innerWidth}});
    assert.equal(facts.zero,'none');assert.equal(facts.overflow,false);
    if(width<=767){assert.equal(facts.boxes[0].x,facts.boxes[1].x);assert.ok(facts.boxes[0].width>=width-2);assert.ok(facts.boxes[1].y>facts.boxes[0].y)}else assert.ok(facts.boxes[1].x>facts.boxes[0].x);
  }
  await page.setViewportSize({width:700,height:800});await page.locator('#name').focus();await page.keyboard.press('Tab');await assert.doesNotReject(()=>page.locator('#code').evaluate(n=>{if(n!==document.activeElement)throw Error('Readonly field lost keyboard focus')}));
});

test('readonly values and labels remain readable without editable borders or select arrows',async t=>{
  const page=await fixture(t,form);
  const facts=await page.evaluate(()=>({labels:[...document.querySelectorAll('.info label')].map(n=>Number(getComputedStyle(n).fontWeight)),controls:[...document.querySelectorAll('.form-control')].map(n=>({border:getComputedStyle(n).borderColor,background:getComputedStyle(n).backgroundColor})),appearance:getComputedStyle(document.querySelector('select')).appearance,resize:getComputedStyle(document.querySelector('textarea')).resize}));
  assert.ok(facts.labels.every(weight=>weight>=600));assert.ok(facts.controls.every(control=>control.border==='rgba(0, 0, 0, 0)'&&control.background==='rgba(0, 0, 0, 0)'));assert.equal(facts.appearance,'none');assert.equal(facts.resize,'none');
  await assert.rejects(()=>page.locator('#name').fill('Changed',{timeout:200}),/not editable/);assert.equal(await page.locator('#name').inputValue(),'First');assert.equal(await page.locator('#choice').isDisabled(),true);
});

test('ordered step indicators expose every label and wrap vertically on narrow screens',async t=>{
  const steps=position=>`<ol class="progress list-group ${position}"><li class="list-group-item active"><span class="number">1</span>Identity</li><li class="list-group-item incomplete"><span class="number">2</span>Details with a longer title</li><li class="list-group-item incomplete"><span class="number">3</span>Review</li></ol>`;
  for(const bootstrap of[3,5])await t.test('Bootstrap '+bootstrap,async t=>{
  const page=await fixture(t,steps('top')+steps('bottom')+steps('left'),{bootstrap});
  for(const width of[390,1200]){
    await page.setViewportSize({width,height:900});
    const lists=await page.locator('ol').evaluateAll(nodes=>nodes.map(n=>{const r=n.getBoundingClientRect();return{height:r.height,overflow:getComputedStyle(n).overflow,items:[...n.children].map(c=>{const a=c.getBoundingClientRect();return{x:a.x,y:a.y,height:a.height,bottom:a.bottom}}),bottom:r.bottom}}));
    for(const list of lists){assert.ok(list.height>16);assert.equal(list.overflow,'visible');assert.ok(list.items.every(item=>item.bottom<=list.bottom+1))}
    for(const list of lists.slice(0,2)){if(width<768)assert.ok(list.items[1].y>list.items[0].y);else assert.ok(list.items[1].x>list.items[0].x)}
  }
});
});


test('map search controls remain inline on desktop and keyboard reachable without mobile overflow',async t=>{
  const page=await fixture(t,'<div id="entity-list-map-options" class="form-inline"><label for="place">Location</label> <input class="form-control" id="place"> <label for="radius">Distance</label> <select class="form-control" id="radius"><option>25 km</option></select> <button id="search">Search</button></div>');
  for(const width of[390,1200]){
    await page.setViewportSize({width,height:800});
    const facts=await page.evaluate(()=>{const boxes=['place','radius','search'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return{x:r.x,y:r.y,right:r.right,bottom:r.bottom}});return{boxes,overflow:document.documentElement.scrollWidth>innerWidth}});
    assert.equal(facts.overflow,false);assert.ok(facts.boxes.every(box=>box.right<=width));if(width===1200)assert.ok(Math.abs(facts.boxes[0].y-facts.boxes[1].y)<2);
  }
  await page.locator('#search').evaluate(button=>button.addEventListener('click',()=>(button.dataset.activated='true')));await page.locator('#place').focus();await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Enter');assert.equal(await page.locator('#search').getAttribute('data-activated'),'true');
});


test('form views preserve responsive grid columns beside a side progress indicator',async t=>{
  const page=await fixture(t,'<style>.row{display:flex;flex-wrap:wrap}.row>*{width:100%}@media(min-width:992px){.col-lg-2{width:16.666667%}.col-lg-10{width:83.333333%}}</style><div class="row"><div class="progress left col-lg-2" id="steps">Step 1</div><div class="crmEntityFormView col-lg-10" id="view"><label for="editable">Name</label><input id="editable" class="form-control"></div></div>');
  for(const width of[390,1200]){
    await page.setViewportSize({width,height:800});
    const boxes=await page.evaluate(()=>['steps','view'].map(id=>{const r=document.getElementById(id).getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,right:r.right}}));
    if(width===1200){assert.ok(Math.abs(boxes[0].y-boxes[1].y)<1);assert.ok(boxes[1].x>=boxes[0].right-1);assert.ok(boxes[1].width>900&&boxes[1].width<1100)}else{assert.equal(boxes[1].x,0);assert.ok(boxes[1].y>boxes[0].y);assert.equal(boxes[1].width,width)}
  }
  await page.locator('#editable').fill('Still editable');assert.equal(await page.locator('#editable').inputValue(),'Still editable');
});
