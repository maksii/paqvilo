// @test-kind contract: local Bootstrap 3 and Bootstrap 5 notes use the service pagination metadata and retain the streams' selected record.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { loopbackServer, sharedBrowser } from './shared-browser.mjs';

const browser = sharedBrowser({ headless: true });
const responseJson = (res, value) =>
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(value));

test('note and attachment pages can be advanced and a deleted final page returns to the last available page', async (t) => {
  for (const variant of ['Bootstrap 3', 'Bootstrap 5']) {
    await t.test(variant, async (sub) => {
      const js = await fs.readFile(new URL('../lib/entity-grid-compat.js', import.meta.url));
      const bs5 = variant === 'Bootstrap 5';
      const notes = ['first', 'second', 'third'].map((id) => ({
        Id: id,
        UnformattedText: id,
        Text: `<p>${id}</p>`,
        HasAttachment: true,
        AttachmentUrl: `/attachment/${id}`,
        AttachmentFileName: `${id}.txt`,
        AttachmentSizeDisplay: '1 bytes',
        DisplayToolbar: true,
        CanDelete: true,
      }));
      const requested = [];
      const { origin } = await loopbackServer(sub, (req, res) => {
        if (req.url === '/grid.js') return res.writeHead(200, { 'content-type': 'text/javascript' }).end(js);
        if (req.method === 'POST') {
          let body = '';
          req.setEncoding('utf8');
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            const input = JSON.parse(body);
            if (req.url === '/delete') {
              const index = notes.findIndex(({ Id }) => Id === input.id);
              if (index < 0) return res.writeHead(404).end();
              notes.splice(index, 1);
              return responseJson(res, { Id: input.id });
            }
            requested.push([input.page, input.pageSize]);
            const page = notes[input.page - 1];
            responseJson(res, { Records: page ? [page] : [], PageNumber: input.page, PageCount: notes.length });
          });
          return;
        }
        return res.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html>
          <div id="antiforgerytoken"><input name="__RequestVerificationToken" value="loopback-token" type="hidden"></div>
          <div class="entity-notes" ${bs5 ? 'data-bs-target' : 'data-target'}='{"Id":"sample","LogicalName":"item"}' data-url-get="/notes" data-url-delete="/delete" data-pagesize="1">
            <div class="notes"></div><div class="notes-empty"></div><div class="notes-loading"></div><div class="notes-pagination" data-pages="1" data-current-page="1"></div>
          </div><script src="/grid.js"></script>`);
      });
      const page = await browser.page(sub);
      await page.goto(origin);
      await page.locator('.note[data-id="first"]').waitFor({ timeout: 3000 });
      const pager = page.locator('.notes-pagination');
      const previous = pager.getByRole('button', { name: 'Previous page' });
      const next = pager.getByRole('button', { name: 'Next page' });
      assert.equal(await previous.count(), 1);
      assert.equal(await previous.isDisabled(), true);
      assert.equal(await pager.getAttribute('data-pages'), '3');
      await next.click();
      await page.locator('.note[data-id="second"]').waitFor({ timeout: 3000 });
      assert.match(await page.locator('.note .attachment a').getAttribute('href'), /\/attachment\/second\?/);
      assert.equal(await pager.getAttribute('data-current-page'), '2');
      await next.click();
      await page.locator('.note[data-id="third"]').waitFor({ timeout: 3000 });
      assert.equal(await next.isDisabled(), true);
      await page.locator('.note .delete-link').evaluate((link) => link.click());
      await page.locator('.note[data-id="second"]').waitFor({ timeout: 3000 });
      assert.equal(await pager.getAttribute('data-pages'), '2');
      assert.equal(await next.isDisabled(), true);
      await previous.click();
      await page.locator('.note[data-id="first"]').waitFor({ timeout: 3000 });
      assert.deepEqual(requested, [
        [1, 1],
        [2, 1],
        [3, 1],
        [3, 1],
        [2, 1],
        [1, 1],
      ]);
    });
  }
});
