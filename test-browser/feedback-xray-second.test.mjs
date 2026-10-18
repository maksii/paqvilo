import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../mirage/lib/browser-launch.mjs';
import {xrayUi} from '../lense/xray-ui.mjs';
import {elementSourceHints} from '../lense/element-provenance.mjs';

const hints=(body,name,extra={})=>elementSourceHints(body,{name,kind:'template',sourceFile:`/${name}.html`,ref:name+'.html',...extra});
async function fixture(t,html,report){
  const browser=await chromium.launch(browserLaunchOptions({headless:true}));t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1440,height:1000}}),data={origin:'http://127.0.0.1:11111',token:'invented-second-xray'};
  await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:html}));await page.goto(data.origin);
  await page.evaluate(xrayUi,data);await page.evaluate(({data,report})=>{const api=document.getElementById('paqvilo-xray').__px;api.update(data,report);api.toggle(true);},{data,report});
  const identify=selector=>page.evaluate(selector=>{const row=document.getElementById('paqvilo-xray').__px.identify(document.querySelector(selector));return {title:row.title,kind:row.kind,sub:row.sub,forms:row.b.forms,fields:row.b.fields,lists:row.b.lists,views:row.b.views,matches:row.matches};},selector);
  return {page,identify,data};
}

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
  if(process.env.PAQVILO_FEEDBACK_SCREENSHOTS)await page.screenshot({path:process.env.PAQVILO_FEEDBACK_SCREENSHOTS});
});

test('native PCF selection requires a rendered host rather than a configured column alone',async t=>{
  const report={forms:[{id:'F',name:'Form',entity:'item'}],codeComponents:[{name:'fx.Editor',schemaName:'fx.Editor',binding:'native-formxml',formId:'F',field:'title',entity:'item',selectedDesktop:true,enablement:'configured'}]};
  const {page,identify}=await fixture(t,'<form data-formid="F"><input id="title"></form>',report);
  assert.equal((await identify('#title')).kind,'Basic form');
  await page.evaluate(()=>{const input=document.getElementById('title'),host=document.createElement('div');host.dataset.pcfNativeField='title';input.before(host);host.append(input);});
  assert.equal((await identify('#title')).kind,'Code component');
});

test('full class coverage outranks rare subsets and IDs with contradictory classes; export rarity survives refresh',async t=>{
  const elementSources=[...hints('<div class="state">x</div>','subset'),...['full1','full2','full3'].flatMap(name=>hints('<div class="state padded">x</div>',name)),...hints('<button id="b" class="btn exit">Close</button>','wrong-id'),...hints('<button id="{{ id }}" class="ui-btn custom">Close</button>','correct-classes')];
  const report={elementSources,elementSourceFrequencies:{'div.state':1,'div.state.padded':3}}, {page,identify,data}=await fixture(t,'<div class="state padded">x</div><button id="b" class="ui-btn custom">Close</button>',report);
  assert.equal((await identify('div')).title,'full1');assert.equal((await identify('button')).title,'correct-classes');
  await page.evaluate(({data,report})=>document.getElementById('paqvilo-xray').__px.update(data,{...report,elementSources:[...report.elementSources,...Array.from({length:90},(_,index)=>({selector:'.unmatched-'+index,kind:'template',name:'Unrelated'}))]}),{data,report});
  assert.equal((await identify('div')).title,'full1');assert.equal((await identify('button')).title,'correct-classes');
});

test('repeated ID branches score the classes and source line of their matching occurrence',async t=>{
  const elementSources=hints('<button id="branch" class="btn exit">One</button>\n<button id="branch" class="ui-btn custom">Two</button>','Branches');
  const {identify}=await fixture(t,'<button id="branch" class="ui-btn custom">Two</button>',{elementSources});
  const row=await identify('button');assert.equal(row.title,'Branches');assert.equal(row.matches[0].line,2);assert.equal(row.matches[0].strong,true);
});

test('framework-only evidence needs a unique small source in the page include chain',async t=>{
  const own=hints('<a class="btn btn-link">Go</a>','Page',{includedBy:['page']}),header=hints('<div class="container">Header</div>','Header');
  const {page,identify,data}=await fixture(t,'<div class="container"><a class="btn btn-link">Go</a></div>',{elementSources:[...header,...own]});
  assert.equal((await identify('a')).title,'Page');
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
  const source=modifier=>`<div class="alert ${modifier}"><div class="message">Notice</div><button class="close">Close</button></div>`;
  const elementSources=['info','warning','danger','success','other'].flatMap(kind=>hints(source('alert-'+kind),kind,{kind:'snippet',usedBy:['page']}));
  const {page,identify,data}=await fixture(t,source('alert-warning'),{elementSources});
  for(const selector of ['.alert','.message','.close'])assert.equal((await identify(selector)).title,'warning',selector);
  await page.evaluate(({data,report})=>document.getElementById('paqvilo-xray').__px.update(data,report),{data,report:{elementSources:elementSources.map(item=>({...item,usedBy:['unrelated']}))}});
  for(const selector of ['.alert','.message','.close'])assert.equal((await identify(selector)).title,'warning',selector);
  await page.locator('.alert').evaluate(node=>node.classList.remove('alert-warning'));
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
  await page.locator('#frame').evaluate(node=>node.src='/f/?entityformid=F&token=not-collected');
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
