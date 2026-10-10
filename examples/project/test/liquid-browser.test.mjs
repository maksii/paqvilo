import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {createSimulator} from 'paqvilo/mirage/server.mjs';
import {signInContext} from 'paqvilo/mirage/testing/session.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
test('Liquid pages compose bounded previews, exported view columns and permission-scoped results',{timeout:90_000},async t=>{
 const sim=await createSimulator({sourceDir:path.join(project,'portal'),solutionRoots:['metadata','code-solution','solution'].map(name=>path.join(project,name)),solutionOrder:'explicit',dataPacks:[{module:path.join(project,'pack/pack.mjs')}],port:0,watch:false});
 t.after(()=>sim.close());await sim.applyPreset('example-demo');
 const browser=await chromium.launch({headless:true,channel:process.env.PAQVILO_BROWSER||(process.platform==='win32'?'msedge':undefined)});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(15_000);
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 await page.goto(sim.url+'/liquid/');await page.getByRole('heading',{name:'Compose pages with Liquid.'}).waitFor();assert.equal(await page.locator('[data-liquid-guidance]').count(),1);
 await page.goto(sim.url+'/liquid/views/');await page.getByRole('heading',{name:'Sign in to compare account views'}).waitFor();assert.equal(await page.locator('[data-liquid-row]').count(),0);
 await signInContext(context,sim,'a4300000-0000-4000-8000-000000002001');
 await page.goto(sim.url+'/liquid/partials/');const previews=page.locator('[data-liquid-preview]');assert.equal(await previews.count(),2);assert.equal(await previews.nth(0).locator('[data-liquid-card]').count(),2);assert.equal(await previews.nth(1).locator('[data-liquid-card]').count(),4);assert.equal(await page.locator('body').getByText('Functional',{exact:true}).count(),0,'component manifest must not render as page text');
 const manifest=await context.request.get(sim.url+'/liquid-account-preview.manifest.json');assert.equal(manifest.status(),200);assert.deepEqual((await manifest.json()).params.map(param=>param.id),['title','count']);
 await page.goto(sim.url+'/liquid/views/');const custom=page.locator('[data-liquid-custom-view]');assert.equal(await custom.locator('[data-liquid-row]').count(),4);assert.ok(await custom.locator('[data-liquid-column]').count()>=3);assert.equal(await custom.locator('select[name=view] option').count(),3);assert.ok(await page.locator('.entity-grid').count()>0,'native rendering remains alongside the custom view');
 const first=await custom.locator('[data-liquid-row]').first().innerText();await Promise.all([page.waitForURL(url=>url.searchParams.get('p')==='2',{waitUntil:'domcontentloaded'}),custom.getByRole('link',{name:'Next',exact:true}).click()]);assert.equal(await custom.locator('[data-liquid-row]').count(),4);assert.notEqual(await custom.locator('[data-liquid-row]').first().innerText(),first);
 await custom.locator('select[name=view]').selectOption('a4200000-0000-4000-8000-000000000503');await Promise.all([page.waitForURL(url=>url.searchParams.get('view')==='a4200000-0000-4000-8000-000000000503'),custom.getByRole('button',{name:'Apply view'}).click()]);assert.equal(await custom.locator('[data-liquid-row]').count(),2);
 await custom.locator('select[name=view]').selectOption('a4200000-0000-4000-8000-000000000502');await custom.locator('[name=q]').fill('Arcwell');await Promise.all([page.waitForURL(url=>url.searchParams.get('q')==='Arcwell'),custom.getByRole('button',{name:'Apply view'}).click()]);assert.equal(await custom.locator('[data-liquid-row]').count(),1);await custom.getByRole('link',{name:'Arcwell Services'}).click();assert.match(page.url(),/\/approach\/web-api\/account\//);
 await page.goto(sim.url+'/liquid/data/?status=inactive');assert.equal(await page.locator('[data-liquid-card]').count(),2);assert.match(await page.locator('[data-liquid-summary]').innerText(),/2 inactive accounts/);
 await page.goto(sim.url+'/liquid/data/?status=unsupported');assert.equal(await page.locator('[data-liquid-card]').count(),6);assert.match(await page.locator('[data-liquid-summary]').innerText(),/6 active accounts/);
 await signInContext(context,sim,'a4300000-0000-4000-8000-000000002002');await page.goto(sim.url+'/liquid/views/');assert.equal(await custom.locator('[data-liquid-row]').count(),4,'reader retains read access');
 await page.goto('about:blank');await sim.applyPreset('example-empty');await page.goto(sim.url+'/liquid/partials/');assert.equal(await page.locator('[data-liquid-card]').count(),0);assert.equal(await page.getByText('No accounts are available for this persona.',{exact:true}).count(),2);
 await page.goto(sim.url+'/liquid/views/');assert.equal(await page.locator('[data-liquid-row]').count(),0);await custom.getByText('No matching accounts. Change the view or search.').waitFor();
 await page.goto('about:blank');await sim.applyPreset('example-demo');await page.setViewportSize({width:390,height:844});for(const route of ['/liquid/','/liquid/partials/','/liquid/views/','/liquid/data/']){await page.goto(sim.url+route);await page.mouse.move(0,0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),route+' does not overflow on mobile');assert.doesNotMatch(await page.locator('body').innerText(),/Liquid error|Portal rendering failed|Syntax Error/);}
 assert.deepEqual(errors,[]);
 const manifestSource=await fs.readFile(path.join(project,'portal/web-templates/liquid-account-preview/Liquid-account-preview.webtemplate.source.html'),'utf8');assert.match(manifestSource,/{% manifest %}/);
});
