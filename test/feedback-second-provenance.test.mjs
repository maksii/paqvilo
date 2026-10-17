import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {scriptSourceHints,elementSourceHints,elementSourceHintCacheStats} from '../lense/element-provenance.mjs';
import {createSourceInspector} from '../lense/source-inspection.mjs';
import {inspectionFixture} from './source-inspection-fixture.mjs';

test('script selectors continue after balanced nested templates, division statements and long ordinary literals',()=>{
  const body='const text = `outer ${ {nested: `inner ${ $("#inside") }`, pattern: /}/} } tail`;\n'+
    'const ratio = total / divisor;\nconst long = "'+'x'.repeat(500)+'";\n'+
    '\n'.repeat(5)+'$("#after");document.querySelector(".last");';
  assert.deepEqual(scriptSourceHints(body,{sourceFile:'/invented/modern.js'}).map(row=>[row.selector,row.line]),[['#after',9],['.last',9]]);
  const regex='if (ready) /document.querySelector("#fiction")/.test(input);\ndocument.getElementById("actual");';
  assert.deepEqual(scriptSourceHints(regex,{}).map(row=>row.selector),['#actual']);
  assert.deepEqual(scriptSourceHints('const invalid=`unterminated ${ {x:"text"}; document.querySelector("#fiction");',{}),[]);
});

test('script hint limits report only an actual additional unique reference and cached descriptors stay independent',()=>{
  const source={sourceFile:'/invented/script-cap.js',name:'First'},body=Array.from({length:120},(_,index)=>`$("#x${index}");`).join('\n');
  const exact=scriptSourceHints(body,source);assert.equal(exact.length,120);assert.equal(exact.truncated,false);
  const limited=scriptSourceHints(body+'$("#extra");',source);assert.equal(limited.length,120);assert.equal(limited.truncated,true);
  limited[0].name='mutated';const cached=scriptSourceHints(body+'$("#extra");',{...source,name:'Second'});assert.equal(cached[0].name,'Second');assert.equal(cached.truncated,true);
});

test('hint cache returns independent descriptors and invalidates only changed source bodies',()=>{
  const file='/invented/cache-specific.html',body='<section id="cached"><button class="owned">Go</button></section>',source={sourceFile:file,name:'First'};
  const first=elementSourceHints(body,source),before=elementSourceHintCacheStats();first[0].ref='mutated';first[0].locations[0].contexts.push('#unrelated');
  const second=elementSourceHints(body,{...source,name:'Second'}),after=elementSourceHintCacheStats();
  assert.equal(after.parses,before.parses);assert.equal(after.hits,before.hits+1);assert.equal(second[0].name,'Second');assert.equal(second[0].ref,undefined);assert.ok(!second[0].locations[0].contexts.includes('#unrelated'));
  const changed=elementSourceHints(body+'<b id="new"></b>',source);assert.ok(changed.some(row=>row.selector==='#new'));assert.equal(elementSourceHintCacheStats().parses,after.parses+1);
});

test('shared header/footer hints reuse parsing across pages and refresh, with whole-export rarity and form identities',async t=>{
  const fx=inspectionFixture();t.after(fx.cleanup);
  fs.appendFileSync(path.join(fx.portal,'website.yml'),'\nadx_headerwebtemplateid: header\nadx_footerwebtemplateid: footer');
  for(const [name,id]of [['Header','header'],['Footer','footer']]){
    fs.writeFileSync(path.join(fx.portal,`web-templates/${name}.webtemplate.yml`),`adx_webtemplateid: ${id}\nadx_name: ${name}`);
    fs.writeFileSync(path.join(fx.portal,`web-templates/${name}.webtemplate.source.html`),`<aside id="${id}"><b class="shared-banner">Shared</b></aside>`);
  }
  fs.writeFileSync(path.join(fx.portal,'basic-forms/Unreferenced.basicform.yml'),'adx_entityformid: unreferenced\nadx_name: Unreferenced\nadx_entityname: fx_widget');
  fs.writeFileSync(path.join(fx.portal,'Wizard.advancedform.yml'),'adx_webformid: wizard\nadx_name: Unreferenced wizard');
  fs.writeFileSync(path.join(fx.portal,'Items.list.yml'),'adx_entitylistid: inventory-list\nadx_name: Unreferenced list\nadx_entityname: fx_widget');
  const inspector=createSourceInspector({sourceDir:fx.portal}),first=(await inspector.inspect('/')).report,before=elementSourceHintCacheStats();
  const second=(await inspector.inspect('/other/')).report;
  assert.deepEqual(second.elementSourceFrequencies,first.elementSourceFrequencies);assert.equal(first.elementSourceFrequencies['b.shared-banner'],2);assert.equal(elementSourceHintCacheStats().parses,before.parses,'The second page does not parse shared files again');
  assert.ok(!first.forms.some(row=>row.id==='unreferenced'));assert.ok(first.componentIndex.forms.some(row=>row.id==='unreferenced'));
  assert.ok(first.componentIndex.forms.some(row=>row.id==='wizard'&&row.kind==='advanced-form'&&row.pageReferenced===false));assert.ok(first.componentIndex.lists.some(row=>row.id==='inventory-list'&&row.pageReferenced===false));
  inspector.invalidate();await inspector.inspect('/other/');assert.equal(elementSourceHintCacheStats().parses,before.parses,'Unchanged refresh reuses source hints');
  fs.appendFileSync(path.join(fx.portal,'web-templates/Header.webtemplate.source.html'),'<div id="new-header"></div>');inspector.invalidate();
  const changed=(await inspector.inspect('/other/')).report;assert.ok(changed.elementSources.some(row=>row.selector==='#new-header'));assert.equal(elementSourceHintCacheStats().parses,before.parses+1);
});

test('list source links select definition metadata and script truncation is exposed in inspection metadata',async t=>{
  const fx=inspectionFixture();t.after(fx.cleanup);fs.mkdirSync(path.join(fx.portal,'lists'));
  const definition=path.join(fx.portal,'lists/Items.list.yml'),script=path.join(fx.portal,'lists/Items.list.custom_javascript.js');
  fs.writeFileSync(definition,'adx_entitylistid: items\nadx_name: Items\nadx_entityname: fx_widget');fs.writeFileSync(script,'window.listFeature=true;');
  fs.appendFileSync(path.join(fx.portal,'web-pages/home/Home.webpage.copy.html'),'{% entitylist name: "Items" %}');
  fs.writeFileSync(path.join(fx.portal,'web-pages/home/Home.webpage.custom_javascript.js'),Array.from({length:121},(_,index)=>`$("#item${index}");`).join('\n'));
  const {report}=await createSourceInspector({sourceDir:fx.portal}).inspect('/'),list=report.components.find(row=>row.kind==='list');
  assert.equal(list.sourceFile,definition);assert.equal(list.customization.sourceFile,script);assert.equal(report.elementSourceLimits.scriptTruncated,true);assert.equal(report.elementSourceLimits.truncated,true);
});
