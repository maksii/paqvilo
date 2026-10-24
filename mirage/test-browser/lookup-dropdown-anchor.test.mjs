import test from 'node:test';
import assert from 'node:assert/strict';
import { renderComponent } from '../lib/platform.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser();

test('dropdown lookup exposes the native prefixed entityname anchor, including an empty selection', async t => {
  const html=await renderComponent('entityform','form',{}, {
    portal:{forms:[{id:'form',metadata:{}}],records:[]},
    schemas:{form:{entity:'child',fields:[{name:'parentid',type:'lookup',lookupStyle:'dropdown',label:'Parent'}]}},
    store:{resolveMapping:name=>name==='child'?{entitySet:'children',idColumn:'childid',relationships:{parent:{entity:'parent',from:'parentid',to:'parentid',many:false}}}:{entitySet:'parents',idColumn:'parentid',nameColumn:'name'},query:async()=>({value:[{parentid:'p1',name:'Parent one'}]})},
  });
  const page=await chrome.page(t);
  await page.setContent(html);
  const select=page.locator('#parentid'), anchor=page.locator('#parentid_entityname');
  assert.equal(await anchor.getAttribute('type'),'hidden');
  assert.equal(await anchor.inputValue(),'parent');
  assert.equal(await anchor.getAttribute('name'),(await select.getAttribute('name'))+'_entityname');
  assert.equal(await select.inputValue(),'');
});

test('a polymorphic dropdown updates its hidden target instead of submitting the previous table', async t => {
  const html=await renderComponent('entityform','form',{request:{params:{id:'record'}}}, {
    portal:{forms:[{id:'form',mode:100000001,metadata:{}}],records:[]},
    schemas:{form:{entity:'child',fields:[{name:'parentid',type:'lookup',lookupStyle:'dropdown',label:'Parent'}]}},
    store:{resolveMapping:name=>name==='child'?{entitySet:'children',idColumn:'childid',relationships:{account:{entity:'account',from:'parentid',to:'accountid',many:false},contact:{entity:'contact',from:'parentid',to:'contactid',many:false}}}:{entitySet:name+'s',idColumn:name+'id',nameColumn:'name'},
      get:async()=>({childid:'record',parentid:{id:'a1',logical_name:'account',name:'Account one'}}),
      query:async name=>({value:[{[name+'id']:name==='account'?'a1':'c1',name:name+' one'}]})},
  });
  const page=await chrome.page(t); await page.setContent(html);
  await page.evaluate(()=>{window.setIsDirty=()=>{};});
  const anchor=page.locator('#parentid_entityname');
  assert.equal(await anchor.inputValue(),'account');
  await page.locator('#parentid').selectOption('c1');
  assert.equal(await anchor.inputValue(),'contact');
  const posted=await page.evaluate(()=>{
    const form=document.querySelector('form') ?? document.body.appendChild(document.createElement('form'));
    form.append(document.querySelector('#parentid'),document.querySelector('#parentid_entityname'));
    return Object.fromEntries(new FormData(form));
  });
  assert.ok(Object.entries(posted).some(([name,value])=>name.endsWith('$parentid_entityname')&&value==='contact'));
  await page.locator('#parentid').selectOption('');
  assert.equal(await anchor.inputValue(),'');
});
