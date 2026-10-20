import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../mirage/lib/browser-launch.mjs';
import {xrayUi} from '../lense/xray-ui.mjs';
import {elementSourceHints,scriptSourceHints} from '../lense/element-provenance.mjs';
import {inspectRenderedPage} from '../lense/source-inspection.mjs';

async function fixture(t,html,report={}){
  const browser=await chromium.launch(browserLaunchOptions({headless:true}));t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1000}});
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:new URL(route.request().url()).pathname==='/'?html:'<!doctype html><p>Frame</p>'}));
  await page.goto('http://127.0.0.1:11111/');
  const data={origin:'http://127.0.0.1:11111',token:'invented-xray',ui:{}};
  await page.evaluate(xrayUi,data);await page.evaluate(({data,report})=>{const api=document.getElementById('paqvilo-xray').__px;api.update(data,report);api.toggle(true);},{data,report});
  const identify=selector=>page.evaluate(selector=>{const result=document.getElementById('paqvilo-xray').__px.identify(document.querySelector(selector));return {title:result.title,kind:result.kind,sub:result.sub,fields:result.b.fields,forms:result.b.forms,native:result.b.native,matches:result.matches};},selector);
  return {page,identify};
}
const hints=(body,name)=>elementSourceHints(body,{name,kind:'template',sourceFile:`/${name}.html`,ref:`${name}.html`});

test('framework classes stay possible matches while distinctive classes, tag-qualified ids and occurrence ancestry rank correctly',async t=>{
  const elementSources=[...hints('<input class="form-control"><button class="close">x</button><input id="a">','one'),...hints('<input class="form-control"><button class="close special" id="a">x</button><div class="panel-x special-y"></div>','two'),...hints('<section id="s1"><h2 class="t">One</h2></section>\n<section id="s2"><h2 class="t">Two</h2></section>\n<section id="s3"><h2 class="t">Three</h2></section>','repeated')];
  const {identify}=await fixture(t,'<input class="form-control"><button class="close special" id="a">x</button><div class="panel-x special-y"></div><section id="s3"><h2 class="t">Three</h2></section>',{elementSources});
  assert.equal((await identify('input')).title,'No reliable source');
  assert.equal((await identify('button')).title,'two');
  assert.equal((await identify('.panel-x')).title,'two');
  const repeat=await identify('h2');assert.equal(repeat.title,'repeated');assert.equal(repeat.matches.find(row=>row.selector==='h2.t').line,3);
});

test('two forms with duplicate ids, composite controls and quick views retain their owning form',async t=>{
  const field='<div class="cell"><label for="name">Name</label><input id="name"></div><div class="cell"><input type="hidden" id="parentid"><input id="parentid_name"></div><div class="cell"><input type="hidden" id="date"><input id="date_datepicker_description"></div><iframe id="Q"></iframe>';
  const forms=['A','B'].map(id=>({id,name:'Form '+id,entity:'item',kind:'basic-form',formXml:{id:'xml-'+id,name:'XML '+id}}));
  const report={forms,columns:['name','parentid','date'].map(name=>({entity:'item',name})),nativeComponents:forms.map(form=>({id:'Q',name:'Quick',kind:'quickform',formId:form.id,owner:form.name+'.Q'}))};
  const {identify}=await fixture(t,`<div data-formid="A">${field}</div><div data-formid="B">${field}</div><input id="foo_name">`,report);
  for(const selector of ['label','input#name','input#parentid_name','input#date_datepicker_description']){
    const result=await identify(`[data-formid=B] ${selector}`);assert.equal(result.forms[0].id,'B');assert.equal(result.fields.length,1);
  }
  const quick=await identify('[data-formid=A] #Q');assert.equal(quick.native.length,1);assert.equal(quick.native[0].formId,'A');
  assert.deepEqual((await identify('#foo_name')).fields,[]);
});

test('selected duplicate labels refresh when their locally associated control binding changes',async t=>{
  const report={forms:[{id:'A',entity:'item',name:'A'},{id:'B',entity:'item',name:'B'}],columns:['name','other'].map(name=>({entity:'item',name}))};
  const {page}=await fixture(t,'<form data-formid="A"><label for="name">First</label><input id="name"></form><form data-formid="B"><label for="name">Second</label><input id="name"></form>',report);
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.select(document.querySelector('[data-formid=B] label')));
  await page.locator('[data-formid=B] input').evaluate(node=>node.setAttribute('data-field','other'));
  await page.locator('#paqvilo-xray .binding').getByText('item.other',{exact:true}).waitFor();
});

test('tied source candidates prefer the transitive page include chain and weak evidence stays under possible matches',async t=>{
  const elementSources=[...hints('<button class="owned">Go</button>','global'),...hints('<button class="owned">Go</button>','nested').map(item=>({...item,includedBy:['web-template:middle']})),...hints('<input class="form-control">','generic')];
  const report={elementSources,webTemplates:[{id:'main',includedBy:['page-template:main']},{id:'middle',includedBy:['web-template:main']}]};
  const {page,identify}=await fixture(t,'<button class="owned">Go</button><input class="form-control">',report);
  assert.equal((await identify('button')).title,'nested');
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.select(document.querySelector('input')));
  assert.match(await page.locator('#paqvilo-xray .content').innerText(),/Possible matches/);
});

test('snippet dependency chains use exported usedBy names when resolving tied source evidence',async t=>{
  const elementSources=[...hints('<button class="owned">Go</button>','global'),...hints('<button class="owned">Go</button>','nested').map(item=>({...item,usedBy:['content-snippet:Middle']}))];
  const report={elementSources,snippets:[{id:'snippet-main',name:'Main',usedBy:['page']},{id:'snippet-middle',name:'Middle',usedBy:['content-snippet:Main']}]};
  const {identify}=await fixture(t,'<button class="owned">Go</button>',report);assert.equal((await identify('button')).title,'nested');
});

test('classic lists, fallback basic forms and modal iframe URLs resolve with a visible frame boundary',async t=>{
  const list='10000000-0000-4000-8000-000000000001',form='20000000-0000-4000-8000-000000000001';
  const report={page:{entityFormId:form},forms:[{id:form,name:'Modal form',entity:'item'}],components:[{kind:'list',recordId:list,name:'Classic list',entity:'item'}]};
  const {page,identify}=await fixture(t,`<div id="EntityList${list}"><label>Filter</label></div><div id="EntityFormControl"><p>Access denied</p></div><iframe id="modal" src="/_portal/modal-form-template-path/site?entityformid=${form}"></iframe>`,report);
  assert.equal((await identify('label')).title,'Classic list');assert.equal((await identify('#EntityFormControl p')).forms[0].id,form);
  assert.equal((await identify('#modal')).forms[0].id,form);
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.select(document.getElementById('modal')));
  assert.match(await page.locator('#paqvilo-xray .content').innerText(),/Frame boundary/);
});

test('descent remembers the selected child, native controls are picked without focus or page actions, and idle X-ray does not poll',async t=>{
  const {page}=await fixture(t,'<section id="outer"><div id="middle"><input id="picked"><select id="choice"><option>One</option></select></div></section><script>window.down=0;window.focuses=0;document.addEventListener("mousedown",()=>window.down++);document.addEventListener("focusin",event=>{if(event.target.matches("input,select"))window.focuses++});</script>');
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.select(document.getElementById('picked')));
  await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowUp');await page.keyboard.press('ArrowDown');await page.keyboard.press('ArrowDown');
  assert.equal(await page.locator('#paqvilo-xray .element-label').textContent(),'input#picked');
  const rect=await page.locator('#choice').boundingBox();await page.mouse.click(rect.x+5,rect.y+5);
  assert.equal(await page.evaluate(()=>window.down),0);assert.equal(await page.evaluate(()=>window.focuses),0);
  assert.equal(await page.locator('#paqvilo-xray .element-label').textContent(),'select#choice');
  await page.waitForTimeout(100);
  await page.evaluate(()=>{window.geometryReads=0;const get=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){window.geometryReads++;return get.call(this);};});
  // Wait for pending pointer/layout events to settle even when the full suite is busy.
  // A recurring geometry poll cannot pass this quiet window.
  await page.waitForFunction(()=>{const now=performance.now();if(window.lastGeometryReads!==window.geometryReads){window.lastGeometryReads=window.geometryReads;window.geometryQuietSince=now;}return now-window.geometryQuietSince>450;},null,{timeout:5000});
  await page.evaluate(()=>window.geometryReads=0);
  await page.waitForTimeout(1100);assert.equal(await page.evaluate(()=>window.geometryReads),0);
});

test('literal jQuery selectors contribute evidence while pseudo-only and bare tags do not',()=>{
  const rows=scriptSourceHints("$('#x');jQuery('.owned');document.querySelector(':enabled');document.querySelectorAll('input');",{sourceFile:'/script.js'});
  assert.deepEqual(rows.map(row=>row.selector),['#x','.owned']);
});

test('composite controls require local evidence, handle WebForms names, and never crash in a plain control wrapper',async t=>{
  const report={forms:[{id:'A',name:'Form A',entity:'item'}],columns:['choice','parentid','date'].map(name=>({entity:'item',name}))};
  const {identify}=await fixture(t,'<form data-formid="A"><div class="control"><input id="parentid_name"></div><div class="cell"><span id="choice"><input id="choice_1" type="radio" name="ctl00$ContentContainer$choice"></span></div><div class="cell"><input type="hidden" id="date"><input id="date_timepicker_description"></div></form><div class="cell"><input id="parentid_name_unrelated"></div>',report);
  assert.deepEqual((await identify('.control input')).fields,[]);
  assert.equal((await identify('#choice_1')).fields[0].name,'choice');
  assert.equal((await identify('#date_timepicker_description')).fields[0].name,'date');
  assert.deepEqual((await identify('#parentid_name_unrelated')).fields,[]);
});

test('grid table boundaries retain the native control owner and lookup modal metadata identifies its field',async t=>{
  const forms=['A','B'].map(id=>({id,name:'Form '+id,entity:'parent'}));
  const report={forms,views:[{id:'view',name:'Children',entity:'child'}],columns:[{entity:'parent',name:'lookup'}],nativeComponents:forms.flatMap(form=>[{id:'Q',name:'Grid',kind:'subgrid',formId:form.id,viewId:'view'},{id:'lookup',name:'Lookup',kind:'lookup',formId:form.id}])};
  const markup=id=>`<div data-formid="${id}"><div id="Q"><div data-selected-view="view"><div role="dialog"><h2>Child modal</h2></div></div></div><div class="lookup-modal"><div data-lookup-datafieldname="lookup"><div role="dialog"><h3>Find record</h3></div></div></div></div>`;
  const {page,identify}=await fixture(t,markup('A')+markup('B'),report);
  const grid=await identify('[data-formid=B] h2');assert.equal(grid.native.length,1);assert.equal(grid.native[0].formId,'B');assert.deepEqual(grid.forms,[]);
  const lookup=await identify('[data-formid=B] h3');assert.equal(lookup.fields[0].name,'lookup');assert.equal(lookup.native.length,1);assert.equal(lookup.native[0].formId,'B');
  await page.locator('[data-formid=B]').evaluate(node=>{node.id='layout-form';node.removeAttribute('data-formid');node.setAttribute('data-form-layout',JSON.stringify({Id:'B',EntityName:'parent'}));});
  assert.equal((await identify('#layout-form h2')).native[0].formId,'B');
});

test('strong ancestor IDs beat shallow class guesses and duplicate IDs retain matching tag occurrences',async t=>{
  const elementSources=[...hints('<section id="owned"><span></span></section>','owner'),...hints('<span class="unrelated">x</span>','guess'),...hints('<input id="branch">\n<button id="branch">Go</button>','branch')];
  const {page,identify}=await fixture(t,'<section id="owned"><span class="unrelated">Runtime</span></section><button id="branch">Go</button>',{elementSources});
  const row=await identify('span');assert.equal(row.title,'owner');assert.ok(row.matches.some(item=>item.name==='guess'));
  const repeated=await identify('button');assert.equal(repeated.title,'branch');assert.equal(repeated.matches[0].line,2);
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.select(document.querySelector('span')));
  assert.match(await page.locator('#paqvilo-xray .content').innerText(),/owner/);
});

test('details retain deeper unique evidence even when the same source has a nearer class match',async t=>{
  const source='<section id="region"><div><div><button class="distinctive">Go</button></div></div></section>';
  const {page}=await fixture(t,source,{elementSources:hints(source,'Owner')});
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.select(document.querySelector('button')));
  const content=await page.locator('#paqvilo-xray .content').innerText();assert.match(content,/#region/);assert.match(content,/button.distinctive/);
});

test('classic compact and idless list wrappers resolve only exported page or record identities',async t=>{
  const id='10000000-0000-4000-8000-000000000001',report={page:{listId:id},components:[{kind:'list',recordId:id,name:'Classic list',entity:'item',viewIds:['view']}],views:[{id:'view',name:'Item view',entity:'item'}]};
  const {page,identify}=await fixture(t,`<div id="EntityListControl_${id.replaceAll('-','')}"><label>Filter</label></div><div id="EntityListControl"><table><tr><th>Header</th></tr></table></div><div id="EntityListUnrelated"><p>Unknown</p></div>`,report);
  assert.equal((await identify('label')).title,'Classic list');assert.equal((await identify('th')).title,'Classic list');assert.equal((await identify('p')).title,'No reliable source');
  assert.ok((await page.evaluate(inspectRenderedPage)).controls.some(row=>row.listId===id.replaceAll('-','')));
});

test('a thousand indexed sources retain late snippets, expose truncation and identify selected web files',async t=>{
  const elementSources=Array.from({length:1000},(_,index)=>hints(`<div id="snippet-${index}"></div>`,'snippet-'+index)).flat();
  const {page,identify}=await fixture(t,'<div id="snippet-900"></div><img id="asset" src="/logo.svg?ignored=value">',{elementSources,elementSourceLimits:{truncated:true},assets:[{url:'/logo.svg',name:'Logo',ref:'logo.svg'}]});
  assert.equal((await identify('#snippet-900')).title,'snippet-900');
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.select(document.getElementById('asset')));
  const content=await page.locator('#paqvilo-xray .content').innerText();assert.match(content,/Web file/);assert.match(content,/logo.svg/);assert.match(content,/hint index truncated/);assert.doesNotMatch(content,/ignored=value/);
});

test('Web Animations started after enabling X-ray and element resizes update selection without polling idle pages',async t=>{
  const {page}=await fixture(t,'<button id="moving" style="position:absolute;left:30px;top:200px;width:90px;height:30px">Move</button>');
  await page.evaluate(()=>{document.getElementById('paqvilo-xray').__px.select(document.getElementById('moving'));window.originalAnimate=Element.prototype.animate;});
  await page.evaluate(()=>{document.getElementById('moving').animate([{transform:'translateX(0px)'},{transform:'translateX(150px)'}],{duration:350,fill:'forwards'});});
  await page.waitForTimeout(500);
  let actual=await page.locator('#moving').boundingBox(),mark=await page.locator('#paqvilo-xray .selected').boundingBox();assert.ok(Math.abs(actual.x-mark.x)<2);
  await page.evaluate(()=>document.getElementById('moving').style.width='170px');
  await page.waitForTimeout(100);actual=await page.locator('#moving').boundingBox();mark=await page.locator('#paqvilo-xray .selected').boundingBox();assert.ok(Math.abs(actual.width-mark.width)<2);
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.toggle(false));
  assert.equal(await page.evaluate(()=>Element.prototype.animate===window.originalAnimate),false,'the owned temporary wrapper was removed');
});

test('background outlines exclude descendants of clipped ancestors while manual selection remains available',async t=>{
  const {page}=await fixture(t,'<div style="position:absolute;clip:rect(0,0,0,0)"><input id="clipped" style="width:100px;height:30px"></div><input id="visible" style="position:absolute;left:200px;top:200px;width:100px;height:30px">');
  const background=page.locator('#paqvilo-xray .mark:not(.hover):not(.selected)');
  await background.waitFor();
  // Initial pointer events may legitimately outline the document separately from background candidates.
  await page.mouse.move(0,0);await page.locator('#paqvilo-xray .hover').waitFor();
  assert.equal(await background.count(),1);
  assert.deepEqual(await background.boundingBox(),await page.locator('#visible').boundingBox());
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.select(document.getElementById('clipped')));
  await page.locator('#paqvilo-xray .selected').waitFor();
});

test('source candidate display caps expose omitted matches instead of silently losing evidence',async t=>{
  const elementSources=Array.from({length:75},(_,index)=>hints('<button id="same">Go</button>','source-'+index)).flat();
  const {page}=await fixture(t,'<button id="same">Go</button>',{elementSources});
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.select(document.getElementById('same')));
  assert.match(await page.locator('#paqvilo-xray .content').innerText(),/Showing 60 source matches; 15 additional candidates/);
});
