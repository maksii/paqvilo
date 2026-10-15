import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';

// The platform client replaces a bound quick view's server URL after its token request, which
// cancels the frame's first navigation while the server (like a remote portal) has not answered:
// the first document request is aborted and its scripts never load.
test('a bound quick view frame abandons its first navigation and loads the replacement', async t => {
  const compat = await fs.readFile(new URL('../lib/crmentityformview-compat.js', import.meta.url), 'utf8');
  const browser = await chromium.launch(browserLaunchOptions({ headless: true }));
  t.after(() => browser.close());
  const page = await browser.newPage();
  const quick = [];
  const failed = [];
  page.on('requestfailed', request => failed.push(new URL(request.url()).search));
  const scripts = [];
  await page.route('http://portal.test/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><script src="/compat.js"></script><input type="hidden" id="parentid" value="p1"><iframe class="quickform" id="q" data-lookup-element="parentid" data-path="/quick/site" data-formname="Parent" data-controlid="q" src="/quick/site?entityid=p1&amp;entityname=parent&amp;entityprimarykeyname=&amp;formname=Parent&amp;controlid=q&amp;isprofilepage=false&amp;lang=en-US"></iframe></body></html>` });
    if (url.pathname === '/compat.js') return route.fulfill({ contentType: 'text/javascript', body: compat });
    if (url.pathname === '/quick/site' && url.searchParams.has('isprofilepage')) { quick.push(url.search); return; }
    if (url.pathname === '/quick/site') { quick.push(url.search); return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><script src="/inner.js"></script><p id="done">quick</p></body></html>' }); }
    if (url.pathname === '/inner.js') { scripts.push(url.pathname); return route.fulfill({ contentType: 'text/javascript', body: '' }); }
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto('http://portal.test/');
  await page.frameLocator('#q').locator('#done').waitFor();
  assert.deepEqual(quick, ['?entityid=p1&entityname=parent&entityprimarykeyname=&formname=Parent&controlid=q&isprofilepage=false&lang=en-US', '?entityid=p1&entityname=parent&entityprimarykeyname=&formname=Parent&controlid=q']);
  assert.deepEqual(failed, [quick[0]]);
  assert.equal(scripts.length, 1);
});
