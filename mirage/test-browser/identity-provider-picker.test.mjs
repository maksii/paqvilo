import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../lib/browser-launch.mjs';
import {startIdentityProvider} from '../lib/identity-provider.mjs';
import {identityChooserFixture} from '../test/fixtures/identity-chooser.mjs';
import {identityProviderSettings,identityProviderAssets} from '../lib/identity-provider-settings.mjs';

test('identity chooser works without JS, enhances search/pins/recent, and supports project appearance', {timeout:60000},async t=>{
  const callback=http.createServer((req,res)=>res.end('<h1>Signed in</h1>'));await new Promise(resolve=>callback.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>callback.close(resolve)));
  const root=await fs.mkdtemp(join(tmpdir(),'idp-appearance-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  await fs.writeFile(join(root,'custom.css'),'.chooser-header{background:rgb(240,230,255)}');await fs.writeFile(join(root,'custom.js'),'document.documentElement.dataset.projectIdentity="ready";');
  const settings=identityProviderSettings({presentation:'dialog',title:'Choose your test operator',head:{stylesheets:['custom.css'],scripts:['custom.js']}});
  const {users,report,provider,params}=identityChooserFixture();provider.redirectUri=`http://127.0.0.1:${callback.address().port}/callback`;params.redirect_uri=provider.redirectUri;
  let registration=false;
  const idp=await startIdentityProvider({providers:()=>[provider],users:()=>users,personaCatalog:()=>report,registration:()=>({registration}),settings,assets:identityProviderAssets(settings,root)});t.after(()=>idp.close());
  const url=idp.authority(provider)+'oauth2/authorize?'+new URLSearchParams(params);
  const browser=await chromium.launch(browserLaunchOptions({headless:true}));t.after(()=>browser.close());
  const noJS=await browser.newContext({javaScriptEnabled:false});const plain=await noJS.newPage();await plain.goto(url);await plain.getByRole('searchbox').fill('orsted unique');await plain.getByRole('button',{name:'Search',exact:true}).click();assert.match(await plain.locator('.chooser-count').textContent(),/of 1 matching/);await plain.getByRole('button',{name:'Continue as Ørsted Unique',exact:true}).click();await plain.waitForURL('**/callback?**');assert.ok(new URL(plain.url()).searchParams.get('code'));await noJS.close();
  const context=await browser.newContext(),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.goto(url);
  assert.equal(await page.locator('h1').textContent(),'Choose your test operator');assert.equal(await page.locator('.chooser-header').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(240, 230, 255)');assert.equal(await page.locator('html').getAttribute('data-project-identity'),'ready');
  assert.equal(await page.locator('.chooser-filter-disclosure').getAttribute('open'),null);await page.locator('.chooser-filter-disclosure>summary').click();
  await page.getByRole('searchbox').fill('orsted unique');await page.locator('.chooser-count').filter({hasText:'of 1 matching'}).waitFor();assert.ok(new URL(page.url()).searchParams.has('q'));await page.locator('[data-chooser-pin="person-49"]').click();await page.locator('[data-chooser-shortcut="pin"]:not([hidden])').waitFor();
  await page.getByRole('listbox',{name:'Web role',exact:true}).selectOption('Writer');await page.locator('.chooser-count').filter({hasText:'of 0 matching'}).waitFor();assert.equal(await page.locator('.chooser-filter-disclosure>summary').textContent(),'Filters · 1 active');await page.getByRole('listbox',{name:'Web role',exact:true}).selectOption('Reviewer');await page.locator('.chooser-count').filter({hasText:'of 1 matching'}).waitFor();
  await page.getByRole('button',{name:'Use full page',exact:true}).click();assert.equal(await page.locator('[data-persona-chooser]').getAttribute('data-presentation'),'page');
  await page.getByRole('button',{name:'Open as dialog',exact:true}).click();await page.getByRole('button',{name:'Use full page',exact:true}).press('Escape');await page.locator('dialog').waitFor({state:'detached'});
  await page.setViewportSize({width:360,height:760});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,'The picker fits a narrow viewport');
  await page.setViewportSize({width:1280,height:900});
  await page.getByRole('button',{name:'Continue as Ørsted Unique',exact:true}).first().click();await page.waitForURL('**/callback?**');await page.goto(url);await page.locator('[data-chooser-shortcut="recent"]:not([hidden])').waitFor();assert.deepEqual(errors,[]);
  if(process.env.PAQVILO_EVIDENCE_DIR){await fs.mkdir(process.env.PAQVILO_EVIDENCE_DIR,{recursive:true});await page.screenshot({path:join(process.env.PAQVILO_EVIDENCE_DIR,'identity-provider-picker.png'),fullPage:true});}
  registration=true;await page.goto(url);await page.locator('[name="email"]').fill('unfinished-email');
  await page.getByRole('button',{name:'Continue as Persona 0',exact:true}).first().click();await page.waitForURL('**/callback?**');
  await context.close();
  for(const javaScriptEnabled of [false,true]){
    const keyboardContext=await browser.newContext({javaScriptEnabled}),keyboardPage=await keyboardContext.newPage();
    await keyboardPage.goto(url);
    await keyboardPage.locator('[name="given_name"]').fill('New');await keyboardPage.locator('[name="family_name"]').fill('Operator');await keyboardPage.locator('[name="email"]').fill('new.operator@example.test');
    const submitted=keyboardPage.waitForRequest(request=>request.method()==='POST'&&request.url().includes('/oauth2/authorize'));
    await keyboardPage.locator('[name="email"]').press('Enter');
    assert.equal(new URLSearchParams((await submitted).postData()).get('subject'),'new',`Enter in registration must create the entered identity (JavaScript ${javaScriptEnabled})`);
    await keyboardPage.waitForURL('**/callback?**');await keyboardContext.close();
  }
});
