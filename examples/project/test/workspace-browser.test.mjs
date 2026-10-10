import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {createSimulator} from 'paqvilo/mirage/server.mjs';
import {signInContext} from 'paqvilo/mirage/testing/session.mjs';

const project=fileURLToPath(new URL('../',import.meta.url));
test('custom workspaces search and page lookups, retain selections and edit related notes', {timeout:90_000},async t=>{
 const module=path.join(project,'pack/pack.mjs');
 const source=await fs.readFile(path.join(project,'portal/web-pages/pcf-account/PCF-account.webpage.copy.html'),'utf8');
 const id=/codecomponent name:([0-9a-f-]{36})/i.exec(source)[1];
 const sim=await createSimulator({sourceDir:path.join(project,'portal'),solutionRoots:['metadata','code-solution','solution'].map(name=>path.join(project,name)),solutionOrder:'explicit',observed:{codeComponents:{[id]:'exa_ExamplePages.ExampleAccountFields'},evidence:'Sample component tag and manifest'},dataPacks:[{module}],port:0,watch:false});
 t.after(()=>sim.close());await sim.applyPreset('example-demo');
 const browser=await chromium.launch({headless:true,channel:process.env.PAQVILO_BROWSER||(process.platform==='win32'?'msedge':undefined)});t.after(()=>browser.close());
 const context=await browser.newContext({viewport:{width:1440,height:1000}});context.setDefaultTimeout(15_000);await signInContext(context,sim,'a4300000-0000-4000-8000-000000002001');
 const page=await context.newPage(),errors=[];page.on('pageerror',error=>errors.push(error.message));
 const account='a4300000-0000-4000-8000-000000001001';
 const ready=()=>page.waitForFunction(()=>document.querySelector('[data-account-form]')?.dataset.ready==='true').catch(async cause=>{throw new Error('Workspace did not become ready: '+(await page.locator('[data-status]').textContent())+'; browser errors: '+errors.join(', '),{cause});});
 for(const approach of ['web-api','pcf']){
  await page.goto(sim.url+'/approach/'+approach+'/');await page.locator('[data-account-rows] tr').first().waitFor();assert.equal(await page.locator('[data-account-rows] tr').count(),8);
  await page.getByRole('button',{name:'Next',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[data-account-rows] tr').length===2);assert.ok(await page.getByRole('button',{name:'Previous',exact:true}).isEnabled());assert.ok(await page.getByRole('button',{name:'Next',exact:true}).isDisabled());
  await page.goto(sim.url+'/approach/'+approach+'/account/?id='+account+'&mode=edit');await ready();
  await page.getByRole('button',{name:'Choose parent account',exact:true}).click();
  const dialog=page.locator('.demo-lookup-modal');await dialog.locator('[data-lookup-results] tr').first().waitFor();assert.equal(await dialog.locator('[data-lookup-results] tr').count(),6);assert.ok(await dialog.getByRole('button',{name:'Next',exact:true}).isEnabled());
  await dialog.getByRole('button',{name:'Next',exact:true}).click();await page.waitForFunction(()=>document.querySelector('[data-lookup-previous]')?.disabled===false);assert.equal(await dialog.locator('[data-lookup-results] tr').count(),5);
  await dialog.getByRole('button',{name:'Previous',exact:true}).click();await dialog.locator('[name=lookup-search]').fill('Cedar');await dialog.locator('[name=lookup-search]').press('Enter');await dialog.getByText('Cedar Commerce',{exact:true}).waitFor();assert.equal(await dialog.locator('[data-lookup-results] tr').count(),1);
  await dialog.getByRole('button',{name:'Select',exact:true}).focus();await page.keyboard.press('Enter');await dialog.waitFor({state:'hidden'});assert.equal(await page.locator('[data-field=parentaccountid] .demo-lookup-display').inputValue(),'Cedar Commerce');
  await page.getByRole('button',{name:'Save account',exact:true}).click();await page.waitForURL(url=>!url.searchParams.has('mode'));await ready();assert.equal(await page.locator('[data-field=parentaccountid] .demo-lookup-display').inputValue(),'Cedar Commerce');assert.ok(await page.getByRole('button',{name:'Choose parent account',exact:true}).isDisabled());
  await page.locator('[name=contact-search]').fill('Example');await page.locator('[data-contact-query]').getByRole('button',{name:'Search',exact:true}).click();await page.waitForFunction(()=>document.querySelectorAll('[data-contact-rows] tr').length===1);
  await page.locator('[name=contact-search]').fill('No matching person');await page.locator('[data-contact-query]').getByRole('button',{name:'Search',exact:true}).click();await page.locator('[data-contact-empty]').waitFor({state:'visible'});assert.equal(await page.locator('[data-contact-rows] tr').count(),0);
  const note=page.locator('[data-note-list] .demo-note').first();await note.getByRole('button',{name:'Edit',exact:true}).click();const noteDialog=page.locator('[data-note-edit-dialog]');await noteDialog.locator('[name=subject]').fill('Reviewed note');await noteDialog.locator('[name=notetext]').fill('Reviewed text');await noteDialog.getByRole('button',{name:'Save note',exact:true}).click();await page.locator('[data-note-list]').getByText('Reviewed note',{exact:true}).waitFor();
  const downloads=page.locator('[data-note-list] [data-download-note]');assert.equal(await downloads.count(),1,'editing note text preserves its existing attachment');
  await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'mobile workspace must not overflow horizontally');await page.setViewportSize({width:1440,height:1000});
 }
 await page.goto(sim.url+'/approach/out-of-the-box/account/?id='+account+'&mode=edit');await page.locator('#Contacts tbody tr[data-id]').first().waitFor();
 const search=page.locator('#Contacts .view-search input.query');await search.fill('Alex Example*');await search.press('Enter');await page.waitForFunction(()=>document.querySelectorAll('#Contacts tbody tr[data-id]').length===1);
 const geometry=await search.evaluate(node=>({input:node.getBoundingClientRect().width,toolbar:node.closest('.view-search').getBoundingClientRect().width}));assert.ok(geometry.input>100&&geometry.input<geometry.toolbar,'native subgrid search input fits beside its button');
 await page.locator('#parentaccountid_name').locator('..').locator('.launchentitylookup').click();
 const lookup=page.locator('.modal-lookup:visible');await lookup.locator('.view-grid tbody tr[data-id]').first().waitFor();assert.equal(await lookup.locator('.view-error:visible').count(),0,'successful native lookup must not display its fallback error message');
 await lookup.locator('input.query').fill('Fieldstone*');await lookup.getByRole('button',{name:'Search Results',exact:true}).click();await lookup.getByText('Fieldstone Consulting',{exact:true}).waitFor();assert.equal(await lookup.locator('.view-grid tbody tr[data-id]').count(),1);
 await lookup.locator('.view-grid tbody tr[data-id]').click();await lookup.getByRole('button',{name:'Select',exact:true}).click();await lookup.waitFor({state:'hidden'});assert.equal(await page.locator('#parentaccountid_name').inputValue(),'Fieldstone Consulting');
 await page.getByText('New contact',{exact:true}).click();const modal=page.locator('.modal-form-insert:visible');await modal.waitFor();assert.ok(parseFloat(await modal.locator('.modal-title').evaluate(node=>getComputedStyle(node).fontSize))<=22,'native modal title uses compact type');await modal.getByRole('button',{name:'Close',exact:true}).first().click();
 assert.deepEqual(errors,[]);
});
