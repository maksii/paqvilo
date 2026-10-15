import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {OverlaySession} from '../lense/session.mjs';
import {attachSession} from '../lense/browser.mjs';
import {enablePanel} from '../lense/panel.mjs';
import {SITE} from '../test/fixture.mjs';
import {personaFixture,contactId} from '../mirage/test/fixtures/persona-catalog.mjs';
import {browserLaunchOptions} from '../mirage/lib/browser-launch.mjs';

test('Lense picker searches 500 personas, combines facets and opens a catalogue setup through portal sign-in',{timeout:60000},async t=>{
  const fixture=await personaFixture(t,{count:500,curated:490,groupCount:20});const {app,sourceDir}=fixture;
  const browser=await chromium.launch(browserLaunchOptions({headless:true})),context=await browser.newContext({viewport:{width:1400,height:1000}});
  const session=new OverlaySession({sourceDir,origin:app.url,site:structuredClone(SITE),sourceMaps:false,siteName:'Synthetic catalogue',envName:'local',stateDir:fixture.root,browser:{},mirage:true,mirageSourceRoots:[sourceDir]});
  const detach=await attachSession(context,session),panel=enablePanel(context,session,{open:async()=>null});
  t.after(async()=>{await panel.dispose();await detach();await browser.close();});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>{errors.push(e.message);t.diagnostic(e.message);});await page.goto(app.url);
  const root=page.locator('#paqvilo-panel');await root.locator('.pill').click();await root.locator('[data-act="tab"][data-v="tweaks"]').click();
  await root.locator('[data-panel-persona-count]').filter({hasText:'of 500 personas'}).waitFor();assert.ok(await root.locator('[data-panel-persona-row]').count()<100);
  await root.locator('[data-panel-persona-query]').fill('requester');await root.locator('[data-panel-persona-count]').filter({hasText:'of 1 personas'}).waitFor();await root.locator('[data-panel-persona-facet="roles"]').selectOption('Reviewer');
  await root.locator('[data-act="choosepersona"][data-contact="'+contactId(1)+'"]').first().click();await Promise.all([page.waitForNavigation({waitUntil:'load'}),root.locator('[data-act="signin"]').click()]);await page.waitForURL(app.url+'/');await root.locator('.pill').waitFor({state:'attached'});
  if(await root.locator('.pill').isVisible())await root.locator('.pill').click();await root.locator('[data-act="tab"][data-v="tweaks"]').click();
  await root.locator('select[data-pick="scenario"]').selectOption('@catalogue/review-flow');await root.locator('[data-act="ask"][data-kind="scenario"]').click();await root.locator('[data-act="confirm-yes"]').click();
  await page.waitForURL(url=>url.origin!==app.url&&url.searchParams.get('scenario')==='review');assert.equal(await page.locator('h1').textContent(),'Context greeting');
  const signed=await page.evaluate(()=>fetch('/_sim/api/session').then(r=>r.json()));assert.equal(signed.contactId,contactId(1));assert.deepEqual(errors,[]);
});
