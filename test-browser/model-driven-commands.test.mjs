import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { installModelDrivenCommands } from '../lense/model-driven-commands.mjs';
import { verifyModelDrivenIdentity } from '../lense/model-driven-identity.mjs';

test('explicit custom commands await async results, keep values browser-only and retire pending work honestly', async t => {
  const server = http.createServer((_request, response) => response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><div id="paqvilo-model-inspector"></div>'));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage(); await page.goto(origin);
  await page.evaluate(() => { const host = document.getElementById('paqvilo-model-inspector'); host.__paqModelInspector = { token: 'invented' }; host.__paqModelActions = { token: 'invented', receive(id, result) { (window.results ??= {})[id] = result; } }; });
  await page.evaluate(installModelDrivenCommands, { origin, token: 'invented' });
  const ack = await page.evaluate(() => document.getElementById('paqvilo-model-inspector').__paqModelCommands.run({ requestId: 'async', code: 'await Promise.resolve(); return {zero:0, no:false, value:"PRIVATE_RESULT"};' }));
  assert.deepEqual(ack, { accepted: true, requestId: 'async' }); assert.equal(JSON.stringify(ack).includes('PRIVATE_RESULT'), false);
  await page.waitForFunction(() => window.results?.async);
  assert.deepEqual(await page.evaluate(() => JSON.parse(window.results.async.message)), { zero: 0, no: false, value: 'PRIVATE_RESULT' });
  await page.evaluate(() => document.getElementById('paqvilo-model-inspector').__paqModelCommands.run({ requestId: 'timeout', timeoutMs: 10, code: 'await new Promise(r=>setTimeout(r,80)); window.late=true; return "late";' }));
  await page.waitForFunction(() => window.results?.timeout);
  assert.match(await page.evaluate(() => window.results.timeout.message), /may still be running/);
  await page.waitForFunction(() => window.late);
  assert.equal(await page.evaluate(() => window.results.timeout.title), 'Command wait expired');
  await page.evaluate(() => {
    window.currentRecord = 'invented-first'; window.Xrm = { Page: { data: { entity: { getId: () => window.currentRecord } } } };
    document.getElementById('paqvilo-model-inspector').__paqModelCommands.run({ requestId: 'changed', code: 'await new Promise(resolve=>signal.addEventListener("abort",()=>{window.cooperativeAbort=true;resolve();},{once:true})); return "PRIVATE_OLD_TARGET";' });
  });
  await page.evaluate(() => { window.currentRecord = 'invented-second'; });
  await page.waitForFunction(() => window.results?.changed && window.cooperativeAbort);
  assert.equal(await page.evaluate(() => window.results.changed.status), 'cancelled');
  assert.equal(await page.evaluate(() => JSON.stringify(window.results.changed).includes('PRIVATE_OLD_TARGET')), false);
  await page.evaluate(() => { const runtime = document.getElementById('paqvilo-model-inspector').__paqModelCommands; runtime.run({ requestId: 'retired', code: 'await new Promise(r=>setTimeout(r,20)); return "retired-result";' }); runtime.dispose(); });
  await page.waitForTimeout(50); assert.equal(await page.evaluate(() => Boolean(window.results.retired)), false);
});

test('identity preflight requires the exact native privilege and one enabled server user; no roles-name bypass', async t => {
  let reads = 0;
  const objectId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const server = http.createServer((request, response) => {
    if (request.url.startsWith('/api/')) { reads++; assert.match(request.url, /systemusers/); response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ value: [{ azureactivedirectoryobjectid: objectId, fullname: 'Invented delegate' }] })); }
    else response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><div id="paqvilo-model-inspector"></div>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`, browser = await chromium.launch({ channel: process.platform === 'win32' ? 'msedge' : undefined, headless: true });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const page = await browser.newPage(); await page.goto(origin);
  await page.evaluate(() => { const host = document.getElementById('paqvilo-model-inspector'); host.__paqModelActions = { token: 'invented', receive(_id, result) { window.result = result; } }; window.privileges = {}; window.Xrm = { Utility: { getGlobalContext: () => ({ getClientUrl: () => location.origin, getVersion: () => '9.2.1.0', userSettings: { roles: [{ name: 'System Administrator' }], getSecurityRolePrivilegesInfo: async () => window.privileges } }) } }; });
  const input = { origin, token: 'invented', objectId, requestId: 'start' };
  assert.equal(await page.evaluate(verifyModelDrivenIdentity, input), false); assert.equal(reads, 0);
  await page.evaluate(() => { window.privileges.one = { privilegeName: 'prvActOnBehalfOfAnotherUser' }; });
  assert.equal(await page.evaluate(verifyModelDrivenIdentity, input), true); assert.equal(reads, 1);
  assert.equal(await page.evaluate(() => document.getElementById('paqvilo-model-inspector').__paqModelIdentityLabel), 'Invented delegate');
  assert.equal(await page.evaluate(verifyModelDrivenIdentity, { ...input, token: 'retired' }), false); assert.equal(reads, 1);
});
