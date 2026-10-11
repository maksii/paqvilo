import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../lib/browser-launch.mjs';
import {clientDateControlsRuntime} from '../lib/date-controls.mjs';

test('browser date fallback preserves low calendar years in native UserLocal hidden values', async t => {
  const server=http.createServer((_request,response)=>{
    response.setHeader('Content-Type','text/html');
    response.end(`<!doctype html><html><body>
      <input id="owned-date" type="hidden" data-behavior="UserLocal">
      <div data-sim-date-target="owned-date" data-sim-date-only="true"><input id="date-display"></div>
      <input id="owned-time" type="hidden" data-behavior="UserLocal">
      <div data-sim-date-target="owned-time" data-sim-date-only="false"><input id="time-display"></div>
    </body></html>`);
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const browser=await chromium.launch(browserLaunchOptions({headless:true}));
  t.after(()=>browser.close());
  const context=await browser.newContext({timezoneId:'UTC'});
  t.after(()=>context.close());
  const page=await context.newPage(),errors=[];
  page.on('pageerror',error=>errors.push(error.message));
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.addScriptTag({content:clientDateControlsRuntime()});
  assert.equal(await page.locator('#date-display').getAttribute('type'),'date');
  assert.equal(await page.locator('#time-display').getAttribute('type'),'datetime-local');
  await page.locator('#date-display').fill('0026-02-28');
  await page.locator('#date-display').dispatchEvent('change');
  await page.locator('#time-display').fill('0099-12-31T12:34');
  await page.locator('#time-display').dispatchEvent('change');
  assert.equal(await page.locator('#owned-date').inputValue(),'0026-02-28T00:00:00.0000000Z');
  assert.equal(await page.locator('#owned-time').inputValue(),'0099-12-31T12:34:00.0000000Z');
  await page.locator('#date-display').fill('0004-02-29');
  await page.locator('#date-display').dispatchEvent('change');
  assert.equal(await page.locator('#owned-date').inputValue(),'0004-02-29T00:00:00.0000000Z');
  assert.deepEqual(errors,[]);
});
