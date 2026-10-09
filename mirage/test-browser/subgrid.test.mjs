import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../lib/browser-launch.mjs';
import {simulatorFixture,parentId,pendingId,acceptedId} from '../test/fixtures/subgrid.mjs';
import {signInContext} from '../testing/session.mjs';

test('native grid form dialogs save, retain parent edits and refresh authored handlers; Delete requires confirmation',async t=>{
  const app=await simulatorFixture(t),browser=await chromium.launch(browserLaunchOptions({headless:true}));
  t.after(()=>browser.close());
  // Portal requests are signed in explicitly as the fixture's Editor persona.
  const context=await browser.newContext();
  await signInContext(context,app,'editor',{roles:['Editor']});
  const page=await context.newPage(),errors=[],failures=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('response',r=>{if(r.status()>=400)failures.push({url:r.url(),status:r.status()});});
  page.on('request',r=>{if(r.method()==='POST'&&(r.url().includes('/__sim/forms/')||r.url().includes('/_services/')))requests.push({path:new URL(r.url()).pathname,body:r.postDataJSON()});});
  await page.goto(app.url+'/?id='+parentId);
  await page.getByLabel('Parent name',{exact:true}).fill('Unsaved parent edit');
  // Native subgrid: rows load from the subgrid data service after the shell renders.
  const row=id=>page.locator('#Children .view-grid tr[data-id="'+id+'"]');
  await row(pendingId).waitFor();
  assert.equal(await page.evaluate(()=>window.gridLoads),1);
  assert.equal(await row(acceptedId).locator('.edit-link').count(),0);
  assert.equal(await row(acceptedId).locator('.delete-link').count(),0);
  await row(pendingId).locator('a.edit-link.launch-modal').click();
  const modal=page.locator('#Children section.modal-form-edit'),frame=page.frameLocator('#Children section.modal-form-edit iframe');
  await frame.getByLabel('Message',{exact:true}).fill('New notification message');
  await frame.locator('#UpdateButton').click();
  // The frame posts back, Form.aspx posts "Success" and the grid closes the dialog and refreshes.
  await page.waitForFunction(()=>window.gridLoads>=2);
  assert.equal(app.store.snapshot().tables.child.find(entry=>entry.childkey===pendingId).message,'New notification message');
  await modal.waitFor({state:'hidden'});
  assert.equal(await page.getByLabel('Parent name',{exact:true}).inputValue(),'Unsaved parent edit');
  const deleteModal=page.locator('#Children section.modal-delete');
  await row(pendingId).locator('a.delete-link').click();
  await deleteModal.waitFor({state:'visible'});
  assert.equal(app.store.snapshot().tables.child.length,3);
  await deleteModal.getByRole('button',{name:'Cancel'}).click();
  await deleteModal.waitFor({state:'hidden'});
  assert.equal(app.store.snapshot().tables.child.length,3);
  await row(pendingId).locator('a.delete-link').click();
  await deleteModal.getByRole('button',{name:'Delete'}).click();
  await page.waitForFunction(()=>window.gridLoads>=3);
  assert.equal(await row(pendingId).count(),0);
  assert.equal(app.store.snapshot().tables.child.length,2);
  assert.equal(await page.getByLabel('Parent name',{exact:true}).inputValue(),'Unsaved parent edit');
  const saves=requests.filter(entry=>entry.path.startsWith('/__sim/forms/'));
  assert.equal(saves.length,1);
  assert.equal(saves[0].body.recordId,pendingId);
  const deletes=requests.filter(entry=>entry.path==='/_services/entity-grid-delete/site');
  assert.equal(deletes.length,1);
  assert.deepEqual([deletes[0].body.LogicalName,deletes[0].body.Id],['child',pendingId]);
  assert.equal(typeof deletes[0].body.base64SecureConfiguration,'string');
  assert.ok(requests.filter(entry=>entry.path==='/_services/entity-subgrid-data.json/site').length>=3);
  assert.deepEqual(errors,[]);
  assert.deepEqual(failures,[]);
});
