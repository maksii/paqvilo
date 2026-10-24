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
  let tokenRequests = 0;
  let initialRequestObserved;
  const initialRequest = new Promise(resolve => { initialRequestObserved = resolve; });
  const failed = [];
  page.on('requestfailed', request => failed.push(new URL(request.url()).search));
  const scripts = [];
  await page.route('http://127.0.0.1:11111/**', route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/') return route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><body><script>window.shell={getTokenDeferred(){const token=fetch("/token");return {always(callback){void token.then(callback,callback);return this;}};}};</script><script src="/compat.js"></script><input type="hidden" id="parentid" value="p1"><iframe class="quickform" id="q" data-lookup-element="parentid" data-path="/quick/site" data-formname="Parent" data-controlid="q" src="/quick/site?entityid=p1&amp;entityname=parent&amp;entityprimarykeyname=&amp;formname=Parent&amp;controlid=q&amp;isprofilepage=false&amp;lang=en-US"></iframe></body></html>` });
    // Hold the shell token until Chromium dispatches the initial frame request. Without
    // that boundary, an immediate replacement may cancel it before routing observes it.
    if (url.pathname === '/token') { tokenRequests++; return initialRequest.then(() => route.fulfill({ contentType: 'application/json', body: '{}' })); }
    if (url.pathname === '/compat.js') return route.fulfill({ contentType: 'text/javascript', body: compat });
    if (url.pathname === '/quick/site' && url.searchParams.has('isprofilepage')) { quick.push(url.search); initialRequestObserved(); return; }
    if (url.pathname === '/quick/site') { quick.push(url.search); return route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><body><script src="/inner.js"></script><p id="done">quick</p></body></html>' }); }
    if (url.pathname === '/inner.js') { scripts.push(url.pathname); return route.fulfill({ contentType: 'text/javascript', body: '' }); }
    return route.fulfill({ status: 404, body: '' });
  });
  const abandoned = page.waitForEvent('requestfailed', request => new URL(request.url()).searchParams.has('isprofilepage'));
  await page.goto('http://127.0.0.1:11111/');
  await page.frameLocator('#q').locator('#done').waitFor();
  assert.deepEqual(quick, ['?entityid=p1&entityname=parent&entityprimarykeyname=&formname=Parent&controlid=q&isprofilepage=false&lang=en-US', '?entityid=p1&entityname=parent&entityprimarykeyname=&formname=Parent&controlid=q']);
  assert.equal((await abandoned).failure()?.errorText, 'net::ERR_ABORTED');
  assert.deepEqual(failed, [quick[0]]);
  assert.equal(tokenRequests, 1);
  assert.equal(scripts.length, 1);
});
