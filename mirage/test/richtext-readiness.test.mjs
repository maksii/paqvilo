import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeRichTextReady} from '../lib/richtext-readiness.mjs';
import {captureThroughRuntime} from '../capture-shell.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AssetCache} from '../lib/asset-cache.mjs';
import {createSimulator} from '../server.mjs';
import {renderComponent} from '../lib/platform.mjs';

const base='/webresources/msdyn_/RichTextEditorControl/libs/ckeditor_latest/';
const origin='https://invented.invalid';
const manifest=paths=>({assets:paths.map(path=>({path,origin}))});
test('partial CKEditor capture selects compatibility; qualified or language-complete captures select native',()=>{
  const core=base+'ckeditor.js',lang=base+'lang/editor-language-resources.js';
  assert.equal(nativeRichTextReady(manifest([core]),{},origin),false);
  assert.equal(nativeRichTextReady(manifest([core,lang]),{},origin),true);
  assert.equal(nativeRichTextReady(manifest([core]),{richTextReadiness:{nativeReady:true,origin}},origin),true);
  assert.equal(nativeRichTextReady(manifest([core,lang]),{richTextReadiness:{nativeReady:false,origin}},origin),false);
  assert.equal(nativeRichTextReady(manifest([core,lang]),{},'https://other.invalid'),false);
});
test('style-only capture passes the opt-out through the runtime and disconnects',async()=>{
  const calls=[],client={liveConnect:async()=>calls.push('connect'),captureShell:async(path,options)=>{assert.equal(path,'/');assert.equal(options.richText,false);calls.push('capture');return {applied:true};},liveDisconnect:async()=>calls.push('disconnect')};
  await captureThroughRuntime(client,'http://127.0.0.1:9222','/',{richText:false});
  assert.deepEqual(calls,['connect','capture','disconnect']);
});
test('compatibility mode excludes an incomplete captured managed RTE definition',async()=>{
  const control='MscrmControls.RichTextEditor.RichTextEditorControl';
  const managedControls={[control]:{manifest:{incomplete:true}}};
  const html=await renderComponent('entityform','form',{}, {portal:{forms:[{id:'form',metadata:{}}],records:[]},store:{resolveMapping:()=>({entitySet:'samples',idColumn:'sampleid',relationships:{}})},schemas:{form:{entity:'sample',fields:[{name:'text',type:'textarea',richText:{name:control}}]}},managedControls,richTextCompatibility:true});
  assert.match(html,/data-sim-richtext-editor/);assert.doesNotMatch(html,/data-pcf-control=/);
  assert.match(html,/"compatibility":true/);assert.ok(managedControls[control],'caller-owned captured definitions stay intact');
});
test('a runtime renders compatibility for a cached core alone and native when its language resource is captured',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-rte-readiness-'));let app;
  t.after(async()=>{await app?.close();await fs.rm(root,{recursive:true,force:true});});
  await fs.writeFile(path.join(root,'website.yml'),'adx_websiteid: site\nadx_name: RTE fixture');
  await fs.writeFile(path.join(root,'Home.webpage.yml'),'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n');
  await fs.writeFile(path.join(root,'Home.webpage.copy.html'),'{% entityform name: "form" %}');
  await fs.writeFile(path.join(root,'Form.basicform.yml'),'adx_entityformid: form\nadx_name: form\nadx_entityname: sample\nadx_mode: 100000000');
  const stateFile=path.join(root,'state.json'),cache=await new AssetCache({directory:path.join(root,'assets'),origin}).init();
  const bridge={origin,request:async()=>({status:200,headers:{'content-type':'application/javascript'},body:Buffer.from('/* invented editor resource */')})};
  const initial={settings:{permissionMode:'permissive'},mappings:{sample:{idColumn:'sampleid'}},tables:{sample:[]},simulator:{mode:'local',pageMode:'local',live:{origin},componentSchemas:{form:{entity:'sample',fields:[{name:'text',type:'textarea',richText:{name:'MscrmControls.RichTextEditor.RichTextEditorControl'}}]}}}};
  await cache.capture([base+'ckeditor.js'],bridge);
  app=await createSimulator({sourceDir:root,stateFile,origin,initial,watch:false});
  assert.match(await fetch(app.url).then(response=>response.text()),/"compatibility":true/);
  await app.close();app=null;
  await cache.capture([base+'lang/editor-language-resources.js'],bridge);
  app=await createSimulator({sourceDir:root,stateFile,origin,initial,watch:false});
  assert.match(await fetch(app.url).then(response=>response.text()),/"compatibility":false/);
});
