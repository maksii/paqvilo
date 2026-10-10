import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { createSimulator } from '../server.mjs';

test('standard PCF host loads only declared local resources and preserves lifecycle, bound output and disabled context', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-pcf-browser-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const id='d0000000-0000-4000-8000-000000000001';
  const portal=path.join(root,'portal'),solution=path.join(root,'solution');
  const files={
    'portal/website.yml':'adx_websiteid: site\nadx_name: Synthetic PCF',
    'portal/Home.webpage.yml':'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml':'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'portal/Main.webtemplate.yml':'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':`<html><body>{% codecomponent name:${id} value:'Initial' disabled:true %}<script>document.addEventListener('paqvilo:pcf-output',e=>window.output=e.detail);</script></body></html>`,
    'solution/Other/Solution.xml':'<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Controls/tst_Synthetic.Editor/ControlManifest.xml':'<manifest><control namespace="Synthetic" constructor="Editor" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><resources><code path="bundle.js"/><css path="style.css"/></resources></control></manifest>',
    'solution/Controls/tst_Synthetic.Editor/ControlManifest.xml.data.xml':'<CustomControl><Name>tst_Synthetic.Editor</Name></CustomControl>',
    'solution/Controls/tst_Synthetic.Editor/style.css':'.synthetic-editor{--pcf-source:declared;}',
    'solution/Controls/tst_Synthetic.Editor/bundle.js':`window.ComponentFramework.registerControl('Synthetic.Editor',class{init(context,notify,state,container){window.lifecycle=['init'];this.input=document.createElement('input');this.input.className='synthetic-editor';this.input.value=context.parameters.value.raw;this.input.disabled=context.mode.isControlDisabled;this.input.addEventListener('input',notify);container.appendChild(this.input);}updateView(context){window.lifecycle.push('update');window.disabled=context.mode.isControlDisabled;}getOutputs(){return{value:this.input.value};}destroy(){window.lifecycle.push('destroy');}});`,
  };
  for(const[name,text]of Object.entries(files)){const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,text);}
  const app=await createSimulator({sourceDir:portal,solutionRoots:[solution],port:0,watch:false,observed:{codeComponents:{[id]:'tst_Synthetic.Editor'},evidence:'Invented fixture manifest and literal tag'}});
  t.after(()=>app.close());
  const browser=await chromium.launch(browserLaunchOptions({headless:true}));t.after(()=>browser.close());
  const page=await browser.newPage(),errors=[],external=[];
  page.on('pageerror',error=>errors.push(error.message));page.on('request',request=>{if(!request.url().startsWith(app.url))external.push(request.url());});
  await page.goto(app.url);await page.locator('[data-pcf-ready=true]').waitFor();
  assert.equal(await page.locator('input').inputValue(),'Initial');assert.ok(await page.locator('input').isDisabled());
  assert.equal(await page.locator('input').evaluate(node=>getComputedStyle(node).getPropertyValue('--pcf-source')),'declared');
  await page.locator('input').evaluate(node=>{node.value='Output';node.dispatchEvent(new Event('input',{bubbles:true}));});
  assert.deepEqual(await page.evaluate(()=>window.output),{value:'Output'});assert.ok((await page.evaluate(()=>window.lifecycle)).includes('update'));
  const catalogPath=await page.locator('script[src*="/__sim-static/pcf/"]').getAttribute('src');
  assert.equal((await fetch(app.url+catalogPath.replace('bundle.js','secret.js'))).status,404);
  assert.deepEqual(errors,[]);assert.deepEqual(external,[]);
});
