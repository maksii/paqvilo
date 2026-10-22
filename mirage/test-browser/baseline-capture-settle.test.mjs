import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../lib/browser-launch.mjs';
import {pageRunner} from '../baseline-capture.mjs';
test('capture distinguishes persistent progress from loading and surfaces readiness timeouts',async t=>{
 const browser=await chromium.launch(browserLaunchOptions({headless:true}));t.after(()=>browser.close());
 const context=await browser.newContext();const page=await context.newPage();let markup='';
 await page.context().route('http://127.0.0.1:15151/**',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><link rel="icon" href="data:,"><body>'+markup}));
 const run=(timeout=300)=>pageRunner(page,{origin:'http://127.0.0.1:15151',scenario:{id:'progress',steps:[{goto:'/'}]},settle:{quietMs:10,timeout}});
 for(const html of ['<div role="progressbar" aria-valuenow="0" aria-valuemin="0" aria-valuemax="100">Step one</div>','<div role="progressbar" aria-busy="false">Position</div>','<div role="progressbar" style="display:none">Loading</div>']){
  markup=html;const result=await run();assert.equal(result.summary.status,'captured',result.summary.problems.join(';'));assert.ok(result.summary.settlements.every(row=>row.settled));
 }
 markup='<div id="busy" role="progressbar">Loading</div><script>setTimeout(()=>{document.getElementById("busy").remove();document.body.insertAdjacentHTML("beforeend","<p id=ready>Ready</p>");},350)</script>';
 const delayed=await run(1500);assert.equal(delayed.summary.status,'captured');assert.match(delayed.raw.dom,/id="ready"/);assert.ok(delayed.summary.settlements.every(row=>row.settled));
 for(const html of ['<div role="progressbar">Loading</div>','<div role="progressbar" aria-valuenow="50" aria-busy="true">Loading</div>','<div class="loader">Loading</div>']){
  markup=html;const result=await run();assert.equal(result.summary.status,'failed');assert.ok(result.summary.problems.some(problem=>problem.includes('did not settle')));assert.ok(result.summary.settlements.every(row=>!row.settled&&row.loading));
 }
});
