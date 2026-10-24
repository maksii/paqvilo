import test,{before,after} from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../mirage/lib/browser-launch.mjs';
import {xrayUi} from '../lense/xray-ui.mjs';
import {elementSourceHints,scriptSourceHints} from '../lense/element-provenance.mjs';
import {inspectRenderedPage} from '../lense/source-inspection.mjs';

let browser;
before(async()=>{browser=await chromium.launch(browserLaunchOptions({headless:true}));});
after(()=>browser?.close());

// Each test gets its own context on the shared browser; the root path serves the fixture and any other path a plain frame.
async function fixture(t,html,report={}){
  const context=await browser.newContext({viewport:{width:1440,height:1000}});t.after(()=>context.close());
  const page=await context.newPage();
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:new URL(route.request().url()).pathname==='/'?html:'<!doctype html><p>Frame</p>'}));
  const data={origin:'http://127.0.0.1:11111',token:'invented-xray'};
  await page.goto(data.origin+'/');
  await page.evaluate(xrayUi,data);await page.evaluate(({data,report})=>{const api=document.getElementById('paqvilo-xray').__px;api.update(data,report);api.toggle(true);},{data,report});
  const identify=selector=>page.evaluate(selector=>{const row=document.getElementById('paqvilo-xray').__px.identify(document.querySelector(selector));return {title:row.title,kind:row.kind,sub:row.sub,fields:row.b.fields,forms:row.b.forms,native:row.b.native,lists:row.b.lists,views:row.b.views,matches:row.matches};},selector);
  return {page,identify,data};
}
const hints=(body,name,extra={})=>elementSourceHints(body,{name,kind:'template',sourceFile:`/${name}.html`,ref:`${name}.html`,...extra});

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
  const binding=page.locator('#paqvilo-xray .binding');
  await binding.getByText('item.name',{exact:true}).waitFor();
  await page.locator('[data-formid=B] input').evaluate(node=>node.setAttribute('data-field','other'));
  await binding.getByText('item.other',{exact:true}).waitFor();
  assert.equal(await binding.getByText('item.name',{exact:true}).count(),0);
});

test('transitive static includes keep shared selectors uncertain and weak evidence stays possible',async t=>{
  const elementSources=[...hints('<button class="owned">Go</button>','global'),...hints('<button class="owned">Go</button>','nested').map(item=>({...item,includedBy:['web-template:middle']})),...hints('<input class="form-control">','generic')];
  const report={elementSources,webTemplates:[{id:'main',includedBy:['page-template:main']},{id:'middle',includedBy:['web-template:main']}]};
  const {page,identify}=await fixture(t,'<button class="owned">Go</button><input class="form-control">',report);
  const found = await identify('button'); assert.equal(found.title, 'No reliable source');
  assert.ok(found.matches.every(item => !item.strong)); assert.ok(found.matches.some(item => item.pageChain));
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.select(document.querySelector('input')));
  assert.match(await page.locator('#paqvilo-xray .content').innerText(),/Possible matches/);
});

test('snippet dependency chains retain exported usedBy reachability without naming a shared selector owner',async t=>{
  const elementSources=[...hints('<button class="owned">Go</button>','global'),...hints('<button class="owned">Go</button>','nested').map(item=>({...item,usedBy:['content-snippet:Middle']}))];
  const report={elementSources,snippets:[{id:'snippet-main',name:'Main',usedBy:['page']},{id:'snippet-middle',name:'Middle',usedBy:['content-snippet:Main']}]};
  const {identify}=await fixture(t,'<button class="owned">Go</button>',report);
  const found = await identify('button'); assert.equal(found.title, 'No reliable source');
  assert.ok(found.matches.every(item => !item.strong)); assert.ok(found.matches.some(item => item.pageChain));
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
  await page.evaluate(()=>{window.geometryReads=0;const get=Element.prototype.getBoundingClientRect;Element.prototype.getBoundingClientRect=function(){window.geometryReads++;return get.call(this);};});
  // Wait for pending pointer/layout events to settle even when the full suite is busy.
  // A recurring geometry poll cannot pass this quiet window.
  await page.waitForFunction(()=>{const now=performance.now();if(window.lastGeometryReads!==window.geometryReads){window.lastGeometryReads=window.geometryReads;window.geometryQuietSince=now;}return now-window.geometryQuietSince>450;},null,{timeout:5000});
  await page.evaluate(()=>(window.geometryReads=0));
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

test('Web Animations started after enabling X-ray and element resizes move the selection outline, and disabling releases the animate hook',async t=>{
  const {page}=await fixture(t,'<button id="moving" style="position:absolute;left:30px;top:200px;width:90px;height:30px">Move</button>');
  await page.evaluate(()=>{document.getElementById('paqvilo-xray').__px.select(document.getElementById('moving'));window.hookedAnimate=Element.prototype.animate;});
  // Outline geometry is compared inside the page so a missed repaint fails at the bounded wait instead of being slept past.
  const outlineMatches=key=>page.waitForFunction(key=>{const a=document.getElementById('moving').getBoundingClientRect(),m=document.getElementById('paqvilo-xray').shadowRoot.querySelector('.selected')?.getBoundingClientRect();return m&&Math.abs(a[key]-m[key])<2;},key,{timeout:3000});
  await page.evaluate(()=>document.getElementById('moving').animate([{transform:'translateX(0px)'},{transform:'translateX(150px)'}],{duration:350,fill:'forwards'}).finished);
  await outlineMatches('x');
  assert.ok(await page.evaluate(()=>document.getElementById('moving').getBoundingClientRect().x)>170);
  await page.evaluate(()=>(document.getElementById('moving').style.width='170px'));
  await outlineMatches('width');
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.toggle(false));
  assert.equal(await page.evaluate(()=>Element.prototype.animate===window.hookedAnimate),false,'disabling removes the temporary animate wrapper');
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

test('X-ray details expose PCF bindings and Web API context with consistent toggles and Ctrl interaction',async t=>{
  const report={codeComponents:[{schemaName:'fx.Widget',binding:'declared-schema-name',ref:'Widget.xml',resources:[{name:'script',ref:'Widget.js'}],datasets:[{name:'rows',resolved:true,entity:'fx_item',viewName:'Active items',fields:[{name:'title'}],ref:'View.xml'}]}],apiReferences:[{name:'fx_items',entity:'fx_item',ref:'Entity.xml',evidence:'observed-api-request'}]};
  const {page}=await fixture(t,'<div data-pcf-schema="fx.Widget"><button id="action" onclick="window.used=true">Use</button></div>',report);
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.select(document.getElementById('action')));
  const xray=page.locator('#paqvilo-xray'),details=xray.getByRole('button',{name:'Details',exact:true});
  assert.equal(await details.getAttribute('aria-pressed'),'true');
  const text=await xray.locator('.content').innerText();
  for(const expected of ['fx.Widget','declared-schema-name','Widget.js','Active items','1 columns','/_api/fx_items','Observed request','no request-to-element binding'])assert.ok(text.includes(expected),expected);
  await xray.getByRole('combobox',{name:'Highlight layer'}).selectOption('data');
  await xray.locator('.mark[style*="#3975ad"]').first().waitFor();
  await details.click();assert.equal(await details.getAttribute('aria-pressed'),'false');assert.equal(await xray.locator('.card').isVisible(),false);
  await details.click();assert.equal(await details.getAttribute('aria-pressed'),'true');assert.equal(await xray.locator('.card').isVisible(),true);
  await page.keyboard.down('Control');assert.equal(await xray.getByRole('button',{name:'Interact',exact:true}).getAttribute('aria-pressed'),'false');
  await page.locator('#action').click();await page.keyboard.up('Control');assert.equal(await page.evaluate(()=>window.used),true);
  assert.equal(await xray.getByRole('button',{name:'Inspect',exact:true}).getAttribute('aria-pressed'),'true');
});

test('native PCF selection requires a rendered host rather than a configured column alone',async t=>{
  const report={forms:[{id:'F',name:'Form',entity:'item'}],codeComponents:[{name:'fx.Editor',schemaName:'fx.Editor',binding:'native-formxml',formId:'F',field:'title',entity:'item',selectedDesktop:true,enablement:'configured'}]};
  const {page,identify}=await fixture(t,'<form data-formid="F"><input id="title"></form>',report);
  assert.equal((await identify('#title')).kind,'Basic form');
  await page.evaluate(()=>{const input=document.getElementById('title'),host=document.createElement('div');host.dataset.pcfNativeField='title';input.before(host);host.append(input);});
  assert.equal((await identify('#title')).kind,'Code component');
});

test('shared template coverage stays uncertain and contradictory IDs cannot hide a unique class match',async t=>{
  const elementSources=[...hints('<div class="state">x</div>','subset'),...['full1','full2','full3'].flatMap(name=>hints('<div class="state padded">x</div>',name)),...hints('<button id="b" class="btn exit">Close</button>','wrong-id'),...hints('<button id="{{ id }}" class="ui-btn custom">Close</button>','correct-classes')];
  const report={elementSources,elementSourceFrequencies:{'div.state':1,'div.state.padded':3}}, {page,identify,data}=await fixture(t,'<div class="state padded">x</div><button id="b" class="ui-btn custom">Close</button>',report);
  assert.equal((await identify('div')).title,'No reliable source');assert.equal((await identify('button')).title,'correct-classes');
  await page.evaluate(({data,report})=>document.getElementById('paqvilo-xray').__px.update(data,{...report,elementSources:[...report.elementSources,...Array.from({length:90},(_,index)=>({selector:'.unmatched-'+index,kind:'template',name:'Unrelated'}))]}),{data,report});
  assert.equal((await identify('div')).title,'No reliable source');assert.equal((await identify('button')).title,'correct-classes');
});

test('a runtime notification class cannot promote an inactive template over a shared shell', async t => {
  const shell = '<div class="alert alert-info">Notice</div>';
  const inactive = '<div class="alert alert-info notification">Notice</div>';
  const elementSources = [...hints(shell, 'Global shell', { includedBy: ['page-template:layout'] }),
    ...hints(inactive, 'Unrelated application wizard', { includedBy: ['web-template:layout'] }),
    ...hints('<button id="active-next" class="wizard-next">Next</button>', 'Active wizard')];
  const { page, identify } = await fixture(t, shell + '<button id="active-next" class="wizard-next" onclick="window.activated=true">Next</button>', { elementSources,
    webTemplates: [{ id: 'layout', name: 'Invented layout', includedBy: ['page-template:layout'], source: "{% if false %}{% include 'Unrelated application wizard' %}{% endif %}" }] });
  await page.locator('.alert').evaluate(node => node.classList.add('notification'));
  const found = await identify('.notification');
  assert.equal(found.title, 'No reliable source');
  assert.ok(found.matches.filter(item => item.depth === 0).every(item => !item.strong));
  assert.equal((await identify('#active-next')).title, 'Active wizard');
  const rect = await page.locator('.notification').boundingBox();
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.select(document.querySelector('.notification')));
  const highlight = await page.locator('#paqvilo-xray .selected').boundingBox();
  assert.ok(highlight); for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(rect[key] - highlight[key]) <= 2, key);
  const button = await page.locator('#active-next').boundingBox();
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  assert.equal(await page.evaluate(() => window.activated), undefined);
});

for (const kind of ['template', 'snippet']) test(`current page markup keeps overlapping ${kind} selectors uncertain after runtime changes`, async t => {
  const shell = '<div class="alert alert-info">Notice</div>';
  const active = '<button id="active-next" class="wizard-next">Next</button>';
  const pageHints = hints(shell, 'Current page', { kind: 'page' });
  const { page, identify, data } = await fixture(t, shell + active.replace('>Next', ' onclick="window.activated=true">Next'), {});
  for (const [label, markup] of [
    ['class', '<div class="alert alert-info notification">Notice</div>'],
    ['id', '<div id="notification" class="alert alert-info">Notice</div>'],
    ['attribute', '<div data-entityname="notification" class="alert alert-info">Notice</div>'],
  ]) {
    const report = { elementSources: [...pageHints, ...hints(markup, 'Inactive source', { kind }), ...hints(active, 'Active wizard')] };
    await page.evaluate(({ data, report, label }) => {
      const node = document.querySelector('.alert'); node.className = 'alert alert-info'; node.removeAttribute('id'); node.removeAttribute('data-entityname');
      if (label === 'class') node.classList.add('notification');
      else if (label === 'id') node.id = 'notification';
      else node.dataset.entityname = 'notification';
      document.getElementById('paqvilo-xray').__px.update(data, report);
    }, { data, report, label });
    const found = await identify('.alert');
    assert.equal(found.title, 'No reliable source', label);
    assert.equal(found.matches.filter(item => item.depth === 0).length, 2, label);
    assert.ok(found.matches.filter(item => item.depth === 0).every(item => !item.strong), label);
    assert.equal((await identify('#active-next')).title, 'Active wizard', label);
    const rect = await page.locator('.alert').boundingBox();
    const highlight = await page.evaluate(() => {
      const host = document.getElementById('paqvilo-xray'); host.__px.select(document.querySelector('.alert'));
      return host.shadowRoot.querySelector('.selected')?.getBoundingClientRect().toJSON();
    });
    assert.ok(highlight); for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(rect[key] - highlight[key]) <= 2, `${label}: ${key}`);
    const text = await page.locator('#paqvilo-xray .content').innerText();
    assert.match(text, /Current page/); assert.match(text, /Inactive source/);
  }
  const button = await page.locator('#active-next').boundingBox();
  await page.mouse.click(button.x + button.width / 2, button.y + button.height / 2);
  assert.equal(await page.evaluate(() => window.activated), undefined);
});

test('selection outlines exist before notification and retain their node across observer and animation paints', async t => {
  const { page } = await fixture(t, '<button id="moving" style="margin:100px" onclick="window.activated=true">Move</button>', {});
  const result = await page.evaluate(async () => {
    const host = document.getElementById('paqvilo-xray'), node = document.getElementById('moving');
    let notifiedWithOutline = false;
    host.addEventListener('paqvilo-xray', event => { if (event.detail.action === 'selected') notifiedWithOutline = Boolean(host.shadowRoot.querySelector('.selected')); });
    host.__px.select(node);
    const outline = host.shadowRoot.querySelector('.selected');
    if (!outline) return { notifiedWithOutline, stable: false };
    node.classList.add('changed');
    const animation = node.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(100px)' }], { duration: 100, fill: 'forwards' });
    let stable = true;
    for (let frame = 0; frame < 8; frame++) {
      await new Promise(requestAnimationFrame);
      stable &&= outline.isConnected && host.shadowRoot.querySelector('.selected') === outline;
    }
    await animation.finished;
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    return { notifiedWithOutline, stable, target: node.getBoundingClientRect().toJSON(), outline: outline.getBoundingClientRect().toJSON() };
  });
  assert.equal(result.notifiedWithOutline, true); assert.equal(result.stable, true);
  for (const key of ['x', 'y', 'width', 'height']) assert.ok(Math.abs(result.target[key] - result.outline[key]) <= 2, key);
  const target = result.target; await page.mouse.click(target.x + target.width / 2, target.y + target.height / 2);
  assert.equal(await page.evaluate(() => window.activated), undefined);
});

test('repeated ID branches score the classes and source line of their matching occurrence',async t=>{
  const elementSources=hints('<button id="branch" class="btn exit">One</button>\n<button id="branch" class="ui-btn custom">Two</button>','Branches');
  const {identify}=await fixture(t,'<button id="branch" class="ui-btn custom">Two</button>',{elementSources});
  const row=await identify('button');assert.equal(row.title,'Branches');assert.equal(row.matches[0].line,2);assert.equal(row.matches[0].strong,true);
});

test('shared selectors in separate records of one enhanced source retain both uncertain identities', async t => {
  const sources = ['one', 'two'].flatMap(recordId => hints('<div class="shared-notice">Notice</div>', recordId,
    { recordId, ref: 'shared.powerpagecomponent.xml', sourceFile: '/shared.powerpagecomponent.xml' }));
  const { page, identify } = await fixture(t, '<div class="shared-notice">Notice</div>', { elementSources: sources });
  const found = await identify('.shared-notice'); assert.equal(found.title, 'No reliable source');
  assert.deepEqual(found.matches.map(item => item.recordId).sort(), ['one', 'two']); assert.ok(found.matches.every(item => !item.strong));
  await page.evaluate(() => document.getElementById('paqvilo-xray').__px.select(document.querySelector('.shared-notice')));
  const text = await page.locator('#paqvilo-xray .content').innerText(); assert.match(text, /Possible matches \(2\)/);
});

test('framework-only evidence remains uncertain despite unique static include reachability',async t=>{
  const own=hints('<a class="btn btn-link">Go</a>','Page',{includedBy:['page']}),header=hints('<div class="container">Header</div>','Header');
  const {page,identify,data}=await fixture(t,'<div class="container"><a class="btn btn-link">Go</a></div>',{elementSources:[...header,...own]});
  assert.equal((await identify('a')).title,'No reliable source');
  assert.ok((await identify('a')).matches.every(item=>!item.strong));
  await page.evaluate(({data,report})=>document.getElementById('paqvilo-xray').__px.update(data,report),{data,report:{elementSources:[...own,...hints('<a class="btn btn-link">Go</a>','Other',{includedBy:['page']})]}});
  assert.equal((await identify('a')).title,'No reliable source');
});

test('framework-only matches count sibling sources, reject class subsets and do not headline enclosing regions',async t=>{
  const sources=Array.from({length:5},(_,i)=>hints('<button class="close">Close</button>','Close'+i,{includedBy:['page']})).flat();
  const {page,identify,data}=await fixture(t,'<button class="close">Close</button><button class="btn btn-default">Generated</button><div class="title"><span>Generated</span></div>',{elementSources:sources});
  assert.equal((await identify('button.close')).title,'No reliable source');
  const elementSources=[...hints('<button class="btn">A</button><button class="btn">B</button>','Subset',{includedBy:['page']}),...['Full1','Full2'].flatMap(name=>hints('<button class="btn btn-default">Go</button>',name,{includedBy:['page']})),...Array.from({length:25},(_,i)=>hints('<div class="title">Title</div>','Title'+i,{includedBy:['page']})).flat()];
  await page.evaluate(({data,report})=>document.getElementById('paqvilo-xray').__px.update(data,report),{data,report:{elementSources}});
  assert.equal((await identify('.btn')).title,'No reliable source');assert.equal((await identify('span')).title,'No reliable source');
});

test('snippet modifier classes on the nearest container resolve shared descendants independently of page chains',async t=>{
  const source=modifier=>`<div class="alert ${modifier} notice-${modifier}"><div class="message">Notice</div><button class="close">Close</button></div>`;
  const elementSources=['info','warning','danger','success','other'].flatMap(kind=>hints(source('alert-'+kind),kind,{kind:'snippet',usedBy:['page']}));
  const {page,identify,data}=await fixture(t,source('alert-warning'),{elementSources});
  for(const selector of ['.alert','.message','.close'])assert.equal((await identify(selector)).title,'warning',selector);
  await page.evaluate(({data,report})=>document.getElementById('paqvilo-xray').__px.update(data,report),{data,report:{elementSources:elementSources.map(item=>({...item,usedBy:['unrelated']}))}});
  for(const selector of ['.alert','.message','.close'])assert.equal((await identify(selector)).title,'warning',selector);
  await page.locator('.alert').evaluate(node=>node.classList.remove('alert-warning','notice-alert-warning'));
  for(const selector of ['.alert','.message','.close']){const row=await identify(selector);assert.equal(row.title,'No reliable source',selector);assert.ok(row.matches.length>0);assert.ok(row.matches.every(item=>!item.strong));}
});

test('date labels use their data-entity container even without an identified form',async t=>{
  const {identify}=await fixture(t,'<div data-entityname="item"><div class="cell"><div><label id="c_label" for="c">Date</label></div><input type="hidden" class="datetime" id="c"><input id="c_datepicker_description"></div></div>',{columns:[{entity:'item',name:'c'},{entity:'other',name:'c'}]});
  for(const selector of ['label','#c_datepicker_description'])assert.equal((await identify(selector)).sub,'item.c');
});

test('date display controls and labels resolve only with a same-cell base input and form context',async t=>{
  const {identify}=await fixture(t,'<form data-formid="F"><div class="cell"><label for="c_datepicker_description">Date</label><input type="text" class="datetime" id="c" style="display:none"><input id="c_datepicker_description"></div></form><input id="foo_datepicker_description">',{forms:[{id:'F',name:'Form',entity:'item'}],columns:[{entity:'item',name:'c'},{entity:'other',name:'c'}]});
  for(const selector of ['label','#c_datepicker_description'])assert.deepEqual((await identify(selector)).fields.map(row=>row.entity+'.'+row.name),['item.c']);
  assert.deepEqual((await identify('#foo_datepicker_description')).fields,[]);
});

test('idless list grids retain the sole referenced list and view; shared views stay ambiguous',async t=>{
  const list={kind:'list',recordId:'L',name:'List',entity:'item',viewIds:['V']},report={components:[list],views:[{id:'V',name:'View',entity:'item'}]};
  const {page,identify,data}=await fixture(t,'<div class="entitylist entity-grid" data-selected-view="V"><label>Filter</label><table><tr><th>Header</th></tr></table></div>',report);
  for(const selector of ['div','label','th']){const row=await identify(selector);assert.equal(row.title,'List');assert.equal(row.views[0].id,'V');assert.equal(row.kind,'Power Pages list · candidate');}
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.select(document.querySelector('th')));
  assert.match(await page.locator('#paqvilo-xray .content').innerText(),/Candidate list from page references and rendered view/);
  await page.locator('.entitylist').evaluate(node=>node.setAttribute('data-listid','L'));
  assert.equal((await identify('th')).kind,'Power Pages list');
  await page.waitForFunction(()=>document.getElementById('paqvilo-xray').shadowRoot.querySelector('.content').textContent.includes('Rendered list ID matched to the selected export'));
  await page.locator('.entitylist').evaluate(node=>node.removeAttribute('data-listid'));
  await page.evaluate(({data,report})=>document.getElementById('paqvilo-xray').__px.update(data,report),{data,report:{...report,components:[list,{...list,recordId:'L2',name:'Second list'}]}});
  assert.deepEqual((await identify('th')).lists,[]);
});

test('script-set frame form IDs resolve the whole export and selection emits shared identity in one-shot mode',async t=>{
  const report={forms:[],componentIndex:{forms:[{id:'F',name:'Exported form',entity:'item',pageReferenced:false}]}};
  const {page,identify}=await fixture(t,'<iframe id="frame"></iframe>',report);
  await page.locator('#frame').evaluate(node=>(node.src='/f/?entityformid=F&token=not-collected'));
  assert.equal((await identify('#frame')).title,'Exported form');
  await page.evaluate(()=>{const api=document.getElementById('paqvilo-xray').__px;api.toggle(false);document.addEventListener('paqvilo-xray',event=>{if(event.detail.action==='selected')window.selectedIdentity=event.detail;});api.pickOnce();api.select(document.getElementById('frame'));});
  const result=await page.evaluate(()=>({identity:window.selectedIdentity.identity,once:window.selectedIdentity.oneShot,enabled:document.getElementById('paqvilo-xray').__px.enabled}));
  assert.equal(result.identity.title,'Exported form');assert.equal(result.once,true);assert.equal(result.enabled,false);assert.doesNotMatch(JSON.stringify(result),/not-collected/);
});

test('explicit advanced-form and list IDs use export inventory without adding page-list inference',async t=>{
  const componentIndex={forms:[{id:'Wizard',name:'Wizard',kind:'advanced-form',pageReferenced:false}],lists:[{id:'L',kind:'list',name:'Exported list',entity:'item',pageReferenced:false}]};
  const {identify}=await fixture(t,'<div id="WebFormControl_wizard"><h2>Wizard</h2></div><div data-listid="L"><label>List filter</label></div><div class="entitylist"><p>Unrelated grid</p></div>',{componentIndex});
  assert.equal((await identify('h2')).title,'Wizard');assert.equal((await identify('label')).title,'Exported list');assert.deepEqual((await identify('p')).lists,[]);
});

test('viewport candidates survive early offscreen matches and limit notes appear only when reached',async t=>{
  const html='<style>.off{position:absolute;top:2000px;width:10px;height:10px}.visible{display:inline-block;width:20px;height:20px;margin:3px}</style>'+ '<i class="off"></i>'.repeat(1000)+'<i class="off" style="top:20px;visibility:hidden"></i>'.repeat(1000)+'<div>'+ '<b class="visible"></b>'.repeat(20)+'</div>';
  const {page}=await fixture(t,html,{elementSources:[...hints('<i class="off"></i>','Off'),...hints('<b class="visible"></b>','Visible')]});
  await page.waitForFunction(()=>document.getElementById('paqvilo-xray').shadowRoot.querySelectorAll('.mark').length===20);
  assert.match(await page.locator('#paqvilo-xray .legend').innerText(),/Candidate limit reached/);
  await page.locator('.off').evaluateAll(nodes=>nodes.forEach(node=>node.remove()));
  await page.waitForFunction(()=>!document.getElementById('paqvilo-xray').shadowRoot.querySelector('.legend').textContent.includes('Candidate limit reached'));
  assert.equal(await page.locator('#paqvilo-xray .mark').count(),20);
});
