import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../mirage/lib/browser-launch.mjs';
import {xrayUi} from '../lense/xray-ui.mjs';
import {inspectRenderedPage} from '../lense/source-inspection.mjs';
import {elementSourceHints} from '../lense/element-provenance.mjs';

async function fixture(t){
  const browser=await chromium.launch(browserLaunchOptions({headless:true}));t.after(()=>browser.close());
  const page=await browser.newPage({viewport:{width:1500,height:1100}});
  const form=`<style>body{margin:14px}input,textarea,button{display:block;margin:12px;width:240px;height:43px}</style><div id="EntityFormControl"><input id="title" value="PRIVATE_VALUE"><textarea id="notes">PRIVATE_TEXT</textarea><button id="next" onclick="parent.actions++">Next</button></div>`;
  await page.context().route('**/*',route=>{const u=new URL(route.request().url());return route.fulfill({contentType:'text/html',body:u.pathname==='/nested'?`<iframe id="inner" src="/form?entityformid=B&token=PRIVATE_QUERY" style="width:340px;height:260px;border:7px solid"></iframe>`:u.pathname==='/form'?form:`<style>iframe{width:390px;height:290px;border:6px solid}dialog{position:absolute;left:80px;top:100px;margin:0}#cross{position:absolute;left:850px;top:200px}</style><dialog open><iframe id="first" src="/form?entityformid=A&token=PRIVATE_QUERY"></iframe><iframe id="second" src="/nested"></iframe></dialog><iframe id="cross" src="http://localhost:11112/form?entityformid=X"></iframe><script>window.actions=0</script>`});});
  const data={origin:'http://127.0.0.1:11111',token:'frame-test'};await page.goto(data.origin);
  await page.evaluate(xrayUi,data);
  const report={page:{name:'Invented page',entityFormId:'A'},componentIndex:{forms:[{id:'A',name:'Form A',entity:'fx_a'},{id:'B',name:'Form B',entity:'fx_b'}]},columns:[{entity:'fx_a',name:'title',label:'A title'},{entity:'fx_a',name:'notes',label:'A notes'},{entity:'fx_b',name:'title',label:'B title'}]};
  await page.evaluate(({data,report})=>{const api=document.getElementById('paqvilo-xray').__px;api.update(data,report);api.toggle(true);document.addEventListener('paqvilo-xray',event=>{if(event.detail.action==='selected')window.selected=event.detail;});},{data,report});
  return {page,data,report};
}
async function pick(page,locator){
  const rect=await locator.boundingBox();assert.ok(rect);await page.mouse.click(rect.x+rect.width/2,rect.y+rect.height/2);
  await page.waitForFunction(expected=>{const node=document.getElementById('paqvilo-xray').shadowRoot.querySelector('.mark.selected');if(!node)return false;const r=node.getBoundingClientRect();return Math.abs(r.x-expected.x)<1.1&&Math.abs(r.y-expected.y)<1.1&&Math.abs(r.width-expected.width)<1.1&&Math.abs(r.height-expected.height)<1.1;},rect);
  const actual=await page.evaluate(()=>document.getElementById('paqvilo-xray').shadowRoot.querySelector('.mark.selected').getBoundingClientRect().toJSON());for(const key of ['x','y','width','height'])assert.ok(Math.abs(actual[key]-rect[key])<1.1,`${key}: ${actual[key]} vs ${rect[key]}`);
  return page.evaluate(()=>window.selected);
}

test('shape budget does not hide later controls or assets within the bounded document walk',async t=>{
  const browser=await chromium.launch(browserLaunchOptions({headless:true}));t.after(()=>browser.close());
  const page=await browser.newPage();
  const html='<div id="decoration">'+Array.from({length:2100},(_,i)=>`<span class="decorative" id="shape-${i}"></span>`).join('')+'</div><form data-formid="later-form"><input id="later-field" name="later-field"></form><script src="/late-asset.js"></script>';
  await page.route('**/*',route=>route.fulfill({contentType:route.request().url().endsWith('.js')?'text/javascript':'text/html',body:route.request().url().endsWith('.js')?'':html}));
  await page.goto('http://127.0.0.1:11111/');
  const evidence=await page.evaluate(inspectRenderedPage);
  assert.ok(evidence.controls.some(control=>control.id==='later-field'));
  assert.ok(evidence.controls.some(control=>control.formId==='later-form'));
  assert.ok(evidence.assets.some(asset=>asset.kind==='script'));
  assert.ok(evidence.ids.length<=2000);assert.ok(evidence.markupTokens.length<=8000);assert.equal(evidence.truncated,true);
});

test('same-origin modal frame controls retain individual geometry, identity and suppressed activation',async t=>{
  const {page}=await fixture(t),frame=page.frameLocator('#first');
  await page.locator('dialog').evaluate(node=>{node.close();node.showModal();});
  let selected=await pick(page,frame.locator('#title'));assert.equal(selected.element.id,'title');assert.equal(selected.identity.title,'A title');
  selected=await pick(page,frame.locator('#notes'));assert.equal(selected.element.id,'notes');assert.equal(selected.identity.title,'A notes');
  selected=await pick(page,frame.locator('#next'));assert.equal(selected.element.id,'next');assert.equal(selected.identity.title,'Form A');assert.equal(await page.evaluate(()=>window.actions),0);
  // Keyboard events focused inside a frame do not bubble to its parent window.
  await frame.locator('#next').evaluate(node=>node.focus());await page.keyboard.press('Enter');assert.equal(await page.evaluate(()=>window.actions),0);
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.toggle(false));await frame.locator('#next').click();assert.equal(await page.evaluate(()=>window.actions),1);
});

test('nested, dynamic and navigated frames keep their own form context; cross-origin stays a boundary',async t=>{
  const {page}=await fixture(t);
  const inner=page.frameLocator('#second').frameLocator('#inner');
  let selected=await pick(page,inner.locator('#title'));assert.equal(selected.identity.title,'B title');assert.equal(selected.identity.fields[0].entity,'fx_b');
  await page.evaluate(()=>{const f=document.createElement('iframe');f.id='dynamic';f.src='/form?entityformid=B';f.style.cssText='position:absolute;left:100px;top:550px;transform:scale(.8);transform-origin:top left';document.body.append(f);});
  const dynamic=page.frameLocator('#dynamic');await dynamic.locator('#title').waitFor();
  selected=await pick(page,dynamic.locator('#title'));assert.equal(selected.identity.title,'B title');
  await page.locator('#dynamic').evaluate(node=>node.src='/form?entityformid=A');await dynamic.locator('#title').waitFor();
  selected=await pick(page,dynamic.locator('#title'));assert.equal(selected.identity.title,'A title');
  selected=await pick(page,page.locator('#cross'));assert.equal(selected.element.id,'cross');assert.equal(selected.identity.forms.length,0);
  assert.match(await page.locator('#paqvilo-xray .content').innerText(),/cross-origin and sandbox restrictions/);
  const popupPromise=page.waitForEvent('popup');await page.locator('#paqvilo-xray').getByRole('button',{name:'Open frame in new tab'}).click();const popup=await popupPromise;await popup.waitForURL('http://localhost:11112/**');assert.equal(new URL(popup.url()).origin,'http://localhost:11112');await popup.close();
  const evidence=await page.evaluate(inspectRenderedPage);assert.ok(evidence.controls.some(row=>row.id==='title'&&row.formId==='A'));assert.ok(evidence.controls.some(row=>row.id==='title'&&row.formId==='B'));assert.equal(evidence.controls.some(row=>row.formId==='X'),false);
  assert.doesNotMatch(JSON.stringify(evidence),/PRIVATE_VALUE|PRIVATE_TEXT|PRIVATE_QUERY|token=/);
});

test('inactive framework templates never acquire Close, Next or shared notification ownership',async t=>{
  const {page,data,report}=await fixture(t);
  const generic='<button class="close">Close</button><button class="btn btn-primary">Next</button><div class="alert alert-warning"><span class="message">Notice</span></div>';
  const elementSources=elementSourceHints(generic,{kind:'template',name:'Inactive branch',sourceFile:'/inactive.html',ref:'inactive.html',includedBy:['page']});
  await page.evaluate(({data,report,generic,elementSources})=>{const box=document.createElement('section');box.id='generic';box.innerHTML=generic;box.style.cssText='position:absolute;left:100px;top:900px';document.body.append(box);document.getElementById('paqvilo-xray').__px.update(data,{...report,elementSources});},{data,report,generic,elementSources});
  for(const selector of ['.close','.btn','.message']){
    const selected=await pick(page,page.locator('#generic '+selector));assert.equal(selected.identity.title,'No reliable source');assert.deepEqual(selected.identity.sources,[]);
    const text=await page.locator('#paqvilo-xray .content').innerText();assert.match(text,/Possible matches/);assert.match(text,/Statically referenced by/);assert.doesNotMatch(text,/Element source candidates/);
  }
});


test('inherited-origin srcdoc controls work while sandboxed frames remain inaccessible',async t=>{
  const {page}=await fixture(t);
  await page.evaluate(()=>{for(const [id,sandbox] of [['srcdoc',false],['sandbox',true]]){const f=document.createElement('iframe');f.id=id;if(sandbox)f.setAttribute('sandbox','');f.srcdoc='<form data-formid="A"><input id="title"></form>';f.style.cssText='position:absolute;left:100px;top:'+ (sandbox?850:550)+'px;height:180px';document.body.append(f);}});
  await page.frameLocator('#srcdoc').locator('#title').waitFor();const selected=await pick(page,page.frameLocator('#srcdoc').locator('#title'));assert.equal(selected.identity.title,'A title');
  const boundary=await pick(page,page.locator('#sandbox'));assert.equal(boundary.element.id,'sandbox');assert.equal(boundary.identity.forms.length,0);
});

test('frame scrolling follows controls and clips highlights to the visible embedded viewport',async t=>{
  const {page}=await fixture(t),inner=page.frameLocator('#first');
  await inner.locator('body').evaluate(node=>{node.style.height='1000px';window.scrollTo(0,50);});
  const selected=await pick(page,inner.locator('#notes'));assert.equal(selected.element.id,'notes');
  await inner.locator('#notes').evaluate(node=>node.style.width='1000px');
  const outer=await page.locator('#first').boundingBox();
  await page.waitForFunction(outer=>{const node=document.getElementById('paqvilo-xray').shadowRoot.querySelector('.mark.selected');if(!node)return false;const r=node.getBoundingClientRect();return r.width>250&&r.right<=outer.x+outer.width;},outer);
  assert.equal(await page.evaluate(()=>window.actions),0);
});

test('frame highlights follow existing and newly started Web Animations and restore animation hooks',async t=>{
  const {page}=await fixture(t),inner=page.frameLocator('#first');
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.toggle(false));
  await inner.locator('#title').evaluate(node=>{
    window.originalAnimate=Element.prototype.animate;
    window.movement=node.animate([{transform:'translateX(0)'},{transform:'translateX(120px)'}],{duration:2000,iterations:Infinity,direction:'alternate'});
  });
  await page.evaluate(()=>{
    const api=document.getElementById('paqvilo-xray').__px;api.toggle(true);
    api.select(document.querySelector('#first').contentDocument.querySelector('#title'));
  });
  const follows=async()=>{
    for(let sample=0;sample<2;sample++){
      const start=await inner.locator('#title').evaluate(node=>node.getBoundingClientRect().x);
      await page.waitForFunction(start=>{
        const frame=document.querySelector('#first'),node=frame.contentDocument.querySelector('#title');
        const mark=document.getElementById('paqvilo-xray').shadowRoot.querySelector('.mark.selected');if(!mark)return false;
        const local=node.getBoundingClientRect(),outer=frame.getBoundingClientRect(),actual=mark.getBoundingClientRect();
        return Math.abs(local.x-start)>20&&Math.abs(actual.x-(outer.x+frame.clientLeft+local.x))<3;
      },start);
    }
  };
  await follows();
  await inner.locator('#title').evaluate(node=>{window.movement.cancel();node.style.transform='translateX(0)';});
  await page.waitForFunction(()=>{
    const frame=document.querySelector('#first'),node=frame.contentDocument.querySelector('#title');
    const mark=document.getElementById('paqvilo-xray').shadowRoot.querySelector('.mark.selected');
    return Math.abs(mark.getBoundingClientRect().x-(frame.getBoundingClientRect().x+frame.clientLeft+node.getBoundingClientRect().x))<3;
  });
  // A later Web Animation has no CSS animationstart/transitionrun event.
  await inner.locator('#title').evaluate(node=>{window.movement=node.animate([{transform:'translateX(0)'},{transform:'translateX(120px)'}],{duration:2000,iterations:Infinity,direction:'alternate'});});
  await follows();
  await page.evaluate(()=>document.getElementById('paqvilo-xray').__px.toggle(false));
  assert.equal(await inner.locator('body').evaluate(()=>Element.prototype.animate===window.originalAnimate),true);
  assert.equal(await page.evaluate(()=>window.actions),0);
});

test('source-card refresh restores a nonzero existing content scroll position',async t=>{
  const {page,data,report}=await fixture(t);
  const elementSources=Array.from({length:16},(_,index)=>({selector:'#title',matchKind:'id',kind:'template',name:'Invented source '+index,ref:'sources/'+index+'.html',sourceFile:'/sources/'+index+'.html'}));
  await page.evaluate(({data,report,elementSources})=>document.getElementById('paqvilo-xray').__px.update(data,{...report,elementSources}),{data,report,elementSources});
  await pick(page,page.frameLocator('#first').locator('#title'));
  assert.match(await page.locator('#paqvilo-xray .card .content').innerText(), /Possible matches \(16\)/);
  const scroll=await page.locator('#paqvilo-xray .card .content').evaluate(node=>{node.scrollTop=120;return node.scrollTop;});
  assert.equal(scroll,120);
  await page.evaluate(({data,report,elementSources})=>document.getElementById('paqvilo-xray').__px.update(data,{...report,elementSources}),{data,report,elementSources});
  assert.equal(await page.locator('#paqvilo-xray .card .content').evaluate(node=>node.scrollTop),120);
});


test('selected frame assets resolve relative URLs against the embedded document base',async t=>{
  const {page,data,report}=await fixture(t);
  await page.context().route('**/embedded/assets/icon.svg',route=>route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="24"><rect width="64" height="24" fill="blue"/></svg>'}));
  await page.frameLocator('#first').locator('body').evaluate(node=>{
    const base=document.createElement('base');base.href='/embedded/assets/';document.head.append(base);
    const image=document.createElement('img');image.id='frame-image';image.src='icon.svg';image.style.cssText='display:block;width:64px;height:24px;margin:12px';node.append(image);
  });
  await page.evaluate(({data,report})=>document.getElementById('paqvilo-xray').__px.update(data,{...report,assets:[
    {url:'/embedded/assets/icon.svg',name:'Embedded image',ref:'web-files/frame.svg'},
    {url:'/icon.svg',name:'Unrelated host image',ref:'web-files/host.svg'},
  ]}),{data,report});
  const selected=await pick(page,page.frameLocator('#first').locator('#frame-image'));assert.equal(selected.element.id,'frame-image');
  const text=await page.locator('#paqvilo-xray .content').innerText();assert.match(text,/Web file/);assert.match(text,/Embedded image/);assert.doesNotMatch(text,/Unrelated host image/);
  const evidence=await page.evaluate(inspectRenderedPage);assert.ok(evidence.assets.some(asset=>asset.path==='/embedded/assets/icon.svg'));
});
