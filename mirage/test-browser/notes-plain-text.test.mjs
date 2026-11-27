// @test-kind security: default Bootstrap 5 notes treat stored textbox content as text and preserve its paragraph breaks.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loopbackServer, sharedBrowser } from './shared-browser.mjs';

const browser = sharedBrowser({ headless: true });

test('Bootstrap 5 notes display punctuation literally and preserve line breaks', async (t) => {
  const source = await fs.readFile(new URL('../lib/entity-grid-compat.js', import.meta.url));
  const text = 'Draft <review> & approval\nSecond line';
  const { origin } = await loopbackServer(t, (req, res) => {
    if (req.url === '/grid.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(source);
    if (req.url === '/notes')
      return res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          Records: [
            { Id: 'note', UnformattedText: text, Text: '<p>Draft &lt;review&gt; &amp; approval<br />Second line</p>' },
          ],
          PageCount: 1,
        }),
      );
    return res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html>
      <div id="antiforgerytoken"><input name="__RequestVerificationToken" value="loopback-token" type="hidden"></div>
      <div class="entity-notes" data-bs-target='{"Id":"sample","LogicalName":"item"}' data-url-get="/notes" data-rte-enabled="False">
        <div class="notes"></div><div class="notes-empty"></div><div class="notes-loading"></div>
      </div><script src="/grid.js"></script>`);
  });
  const page = await browser.page(t);
  await page.goto(origin);
  const content = page.locator('.note .text');
  await content.waitFor({ timeout: 3000 });
  assert.equal(await content.locator('review').count(), 0);
  assert.equal(await content.locator('br').count(), 1);
  assert.equal(await content.innerText(), text);
  assert.equal(await page.locator('.note').getAttribute('data-unformattedtext'), text);
});
