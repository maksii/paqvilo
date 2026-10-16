import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';

test('quick views and related-form frames keep DOM values in query components and reject unsafe targets', async t => {
  const scripts = new Map(await Promise.all(['crmentityformview', 'platform-app'].map(async name =>
    [`/${name}.js`, await fs.readFile(new URL(`../lib/${name}-compat.js`, import.meta.url))])));
  const requests = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    if (scripts.has(url.pathname)) return response.writeHead(200, { 'content-type': 'text/javascript' }).end(scripts.get(url.pathname));
    response.setHeader('content-type', 'text/html');
    if (url.pathname === '/quick' || url.pathname === '/modal') {
      requests.push(url);
      return response.end('<!doctype html><p id="frame-ready">Native <em>frame</em> content</p>');
    }
    response.end('<!doctype html><html><body><input id="parentid" type="hidden"><input id="parentid_entityname" type="hidden"><input id="badid" type="hidden"><div id="quick-views"></div><div id="EntityFormControl_fixture"><input id="fixture_EntityFormView_EntityID" type="hidden"><span data-form-layout></span><div class="form-custom-actions"><button type="button" class="create-related-record-link" data-filtercriteriaid="related">Create</button></div></div><section class="modal-form-createrecord" data-filtercriteriaid="related"><h2 class="modal-title">New <em>related</em> record</h2><div class="form-loading"></div><iframe data-page="/modal" src="about:blank"></iframe></section><script src="/crmentityformview.js"></script><script src="/platform-app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); });
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  const origin = `http://127.0.0.1:${server.address().port}`;
  const errors = [], external = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    if (new URL(route.request().url()).origin !== origin) { external.push(route.request().url()); return route.abort(); }
    return route.continue();
  });
  const payload = '<img src=x onerror="window.injected=1">&other=bad#fragment';
  await page.addInitScript(value => {
    document.addEventListener('DOMContentLoaded', () => {
      if (!document.getElementById('parentid')) return;
      window.bootstrap = { Modal: { getOrCreateInstance: () => ({ show() { window.modalShows = (window.modalShows || 0) + 1; } }) } };
      document.getElementById('parentid').value = value;
      document.getElementById('parentid_entityname').value = 'parent&entityid=other#fragment';
      document.getElementById('badid').value = '\ud800';
      const paths = ['javascript:window.injected=1', 'data:text/html,<script>parent.injected=1</script>', 'https://external.invalid/quick', location.origin + '//external.invalid/quick', 'http://[', '/quick/%zz', '/quick/%E0%A4%A', '', '/quick', '/quick'];
      paths.forEach((path, index) => {
        const frame = document.createElement('iframe');
        frame.className = 'quickform'; frame.id = index === paths.length - 1 ? 'quick-good' : 'quick-' + index;
        frame.src = 'about:blank'; frame.dataset.lookupElement = index === paths.length - 2 ? 'badid' : 'parentid';
        frame.dataset.path = path; frame.dataset.formname = 'Parent Quick View & details'; frame.dataset.controlid = 'q&other=bad';
        document.getElementById('quick-views').append(frame);
      });
      document.querySelector('input[id$="_EntityFormView_EntityID"]').value = value;
      document.querySelector('[data-form-layout]').setAttribute('data-form-layout', JSON.stringify({ CreateRelatedRecordActionLink: { EntityForm: { Id: value } }, LanguageCode: '1033&other=bad#fragment' }));
    }, { once: true });
  }, payload);
  await page.goto(origin + '/page');
  await page.frameLocator('#quick-good').locator('#frame-ready').waitFor();
  assert.equal(requests.filter(url => url.pathname === '/quick').length, 1, 'invalid earlier frames do not stop the valid final frame');
  const quick = requests.find(url => url.pathname === '/quick');
  assert.equal(quick.searchParams.get('entityid'), payload);
  assert.equal(quick.searchParams.get('entityname'), 'parent&entityid=other#fragment');
  assert.equal(quick.searchParams.get('formname'), 'Parent Quick View & details');
  assert.equal(quick.searchParams.get('controlid'), 'q&other=bad');
  assert.equal(quick.searchParams.has('other'), false);
  assert.equal(quick.hash, '');
  assert.match(await page.locator('#quick-good').getAttribute('src'), /formname=Parent Quick View %26 details/);
  for (let index = 0; index < 9; index++) assert.equal(await page.locator('#quick-' + index).getAttribute('src'), 'about:blank');
  const modal = page.locator('section.modal-form-createrecord');
  const optionName = '<img src=x onerror="parent.injected=1">';
  const optionValue = '<svg onload="parent.injected=1">&other=option#fragment';
  const targetOptions = new URLSearchParams({ mode: 'compact', [optionName]: optionValue, id: 'wrong', entityformid: 'wrong', languagecode: 'wrong' });
  const fragment = '#tab=one&details=%3Cimg%20src=x%20onerror=parent.injected=1%3E';
  await modal.locator('iframe').evaluate((frame, target) => { frame.dataset.page = target; }, `/modal?${targetOptions}${fragment}`);
  await page.locator('button.create-related-record-link').click();
  await modal.locator('iframe').contentFrame().locator('#frame-ready em').waitFor();
  const related = requests.find(url => url.pathname === '/modal');
  assert.deepEqual(related.searchParams.getAll('id'), [payload]);
  assert.deepEqual(related.searchParams.getAll('entityformid'), [payload]);
  assert.deepEqual(related.searchParams.getAll('languagecode'), ['1033&other=bad#fragment']);
  assert.equal(related.searchParams.get('mode'), 'compact');
  assert.equal(related.searchParams.get(optionName), optionValue, 'target option names and values remain URL data');
  assert.equal(related.searchParams.has('other'), false);
  assert.equal(await modal.locator('.modal-title em').textContent(), 'related', 'authored heading markup remains markup');
  assert.equal(await modal.getAttribute('aria-label'), 'New related record');
  const safeSrc = await modal.locator('iframe').getAttribute('src');
  assert.equal(new URL(safeSrc, origin).origin, origin);
  assert.ok(safeSrc.endsWith(fragment), 'custom fragment syntax is preserved without becoming document markup');
  assert.equal(await modal.locator('iframe').contentFrame().locator('img,svg').count(), 0);
  for (const target of ['javascript:window.injected=1', 'data:text/html,test', 'https://external.invalid/modal', origin + '//external.invalid/modal', 'http://[', '/modal/%zz', '/modal/%E0%A4%A', '']) {
    await modal.locator('iframe').evaluate((frame, target) => { frame.dataset.page = target; }, target);
    await page.locator('button.create-related-record-link').click();
    assert.equal(await modal.locator('iframe').getAttribute('src'), safeSrc);
  }
  assert.equal(await page.evaluate(() => window.modalShows), 1);
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});
