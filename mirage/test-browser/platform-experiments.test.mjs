import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../lib/browser-launch.mjs';
import {createSimulator} from '../server.mjs';
import {initial,fixture} from '../test/fixtures/platform-experiments.mjs';

test('developer configures platform rules and override presets through two dedicated pages', {timeout:45000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mirage-experiment-ui-'));await fixture(root);let app,browser;
 t.after(async()=>{await browser?.close();await app?.close();await fs.rm(root,{recursive:true,force:true});});
 app=await createSimulator({sourceDir:root,stateFile:path.join(root,'state.json'),initial:initial(),watch:false});browser=await chromium.launch(browserLaunchOptions({headless:true}));const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto(app.url+'/_sim/#platform');await page.getByRole('heading',{name:'Platform rules',exact:true}).waitFor();
 const budget=page.locator('tr').filter({has:page.getByRole('spinbutton',{name:'QueryLinkEntityLimit',exact:true})});
 await budget.getByRole('spinbutton').fill('30');await budget.getByRole('button',{name:'Save override'}).click();await budget.getByText('Instance override',{exact:false}).waitFor();
 const depth=page.locator('tr').filter({has:page.getByRole('spinbutton',{name:'WorkflowSettings.MaxDepth',exact:true})});await depth.getByRole('spinbutton').fill('12');await depth.getByRole('button',{name:'Save override'}).click();await depth.getByText('Instance override',{exact:false}).waitFor();
 await page.getByLabel('Preset name',{exact:true}).fill('Raised joins');await page.getByLabel('Preset ID',{exact:true}).fill('raised-joins');await page.getByRole('button',{name:'Save current overrides'}).click();await page.getByLabel('Configuration preset').selectOption('raised-joins');
 await page.getByRole('link',{name:'Settings & snippet overrides',exact:true}).click();await page.getByRole('heading',{name:'Settings & snippet overrides',exact:true}).waitFor();
 const setting=page.locator('tr').filter({hasText:'Feature/Example'});await setting.getByRole('button',{name:'Set True',exact:true}).click();await setting.getByText('True',{exact:true}).waitFor();
 const snippet=page.locator('tr').filter({hasText:'Greeting'});await snippet.getByRole('button',{name:'Edit',exact:true}).click();await page.locator('#editor-json').fill(JSON.stringify({name:'Greeting',value:'UI override'}));await page.getByRole('button',{name:'Save changes',exact:true}).click();await snippet.getByText('UI override',{exact:true}).waitFor();assert.match(await(await fetch(app.url)).text(),/UI override/);
 await page.getByLabel('Preset name',{exact:true}).fill('Full scenario');await page.getByLabel('Preset ID',{exact:true}).fill('full-scenario');await page.getByRole('button',{name:'Save current overrides'}).click();await page.getByLabel('Configuration preset').selectOption('source-defaults');await page.getByRole('button',{name:'Apply preset'}).click();await snippet.locator('td').nth(1).getByText('Source greeting',{exact:true}).waitFor();assert.match(await(await fetch(app.url)).text(),/Source greeting/);
 await page.getByLabel('Configuration preset').selectOption('full-scenario');await page.getByRole('button',{name:'Apply preset'}).click();await snippet.getByText('UI override',{exact:true}).waitFor();assert.match(await(await fetch(app.url)).text(),/UI override/);
 const before=await fs.readFile(path.join(root,'sitesetting.yml'),'utf8');assert.match(before,/False/);assert.deepEqual(errors,[]);
});

test('a shadowed saved configuration stays exportable and deletable without applying ambiguous overrides',{timeout:30000},async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'mirage-experiment-collision-ui-'));await fixture(root);let app,browser;
 t.after(async()=>{await browser?.close();await app?.close();await fs.rm(root,{recursive:true,force:true});});
 const state=initial();state.simulator.experimentPresets={feature:{id:'feature',name:'Saved feature',portalOverrides:{snippets:{Greeting:'Saved greeting'}}}};
 const pack={id:'user',name:'Synthetic',description:'Invented pack',matches:()=>true,presets:()=>({sample:{name:'Sample data',configurationPreset:'feature'}}),configurationPresets:[{id:'feature',name:'Pack feature',portalOverrides:{snippets:{Greeting:'Pack greeting'}}}]};
 app=await createSimulator({sourceDir:root,initial:state,packs:[pack],watch:false});browser=await chromium.launch(browserLaunchOptions({headless:true}));const page=await browser.newPage();
 await page.goto(app.url+'/_sim/#access');await page.locator('#available-preset option[value="sample"]').waitFor({state:'attached'});assert.match(await page.locator('#available-preset option[value="sample"]').textContent(),/configuration: feature/);
 await page.goto(app.url+'/_sim/#overrides');await page.getByLabel('Configuration preset').selectOption({label:'Saved feature · saved collision (pack takes precedence)'});
 assert.equal(await page.getByRole('button',{name:'Apply preset',exact:true}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Delete saved preset'}).isEnabled(),true);
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export selected JSON'}).click()]);
 assert.equal(download.suggestedFilename(),'feature.json');const exported=JSON.parse(await fs.readFile(await download.path(),'utf8'));
 assert.deepEqual(exported,state.simulator.experimentPresets.feature);
 await page.getByLabel('Configuration preset').selectOption({label:'Saved feature · saved collision (pack takes precedence)'});

 await page.getByRole('button',{name:'Delete saved preset'}).click();await page.locator('#experiment-select option').filter({hasText:'Saved feature'}).waitFor({state:'detached'});
 await page.getByLabel('Configuration preset').selectOption('feature');assert.equal(await page.getByRole('button',{name:'Delete saved preset'}).isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Apply preset',exact:true}).isEnabled(),true);
 await page.getByRole('button',{name:'Apply preset',exact:true}).click();await page.getByText('Active: Pack feature',{exact:true}).waitFor();assert.match(await fetch(app.url).then(response=>response.text()),/Pack greeting/);

});
