import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { eventLog } from './shared-browser.mjs';

let browser;
before(async () => {
  browser = await chromium.launch(browserLaunchOptions({ headless: true }));
});
after(() => browser?.close());

// A deferred grid with two views (as in a lookup modal) and page
// script that selects a view and sorts with jQuery's .trigger("click"), which dispatches no
// native click on links. The platform bundle binds these controls with jQuery, so the grid
// loads the chosen view; lib/entity-grid-compat.js must do the same.
const layouts = ['First', 'Second'].map((name, index) => ({
  Id: `view-${index + 1}`,
  ViewName: name,
  Configuration: { ViewDisplayName: name },
  Columns: [{ LogicalName: 'name', Name: 'Name', Width: 100, WidthAsPercent: 100 }],
  Base64SecureConfiguration: `secure-${index + 1}`,
  SortExpression: 'name ASC',
}));
const PAGE = `<!doctype html><html lang="en"><head><title>Grid</title></head><body>
<div id="antiforgerytoken"><input type="hidden" name="__RequestVerificationToken" value="token"></div>
<div class="entity-grid" data-get-url="/grid-data" data-defer-loading="true" data-select-mode="Single" data-view-layouts='${JSON.stringify(layouts)}'><div class="view-grid"></div><div class="view-pagination"></div></div>
<script src="/jquery.js"></script><script src="/grid.js"></script>
</body></html>`;

test('jQuery-triggered clicks on grid view and sort links reach the grid', async (t) => {
  const jquery = await fs.readFile(new URL('../node_modules/jquery/dist/jquery.min.js', import.meta.url));
  const grid = await fs.readFile(new URL('../lib/entity-grid-compat.js', import.meta.url));
  const posts = [];
  const server = http.createServer((req, res) => {
    if (req.url === '/page') return res.end(PAGE);
    if (req.url === '/jquery.js' || req.url === '/grid.js') {
      res.setHeader('content-type', 'text/javascript');
      return res.end(req.url === '/jquery.js' ? jquery : grid);
    }
    if (req.url === '/grid-data' && req.method === 'POST') {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        posts.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({ Records: [], ItemCount: 0, PageNumber: 1, PageSize: 10, PageCount: 1, MoreRecords: false }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    // A preconnected socket that never sent a request would hold server.close open.
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // Await the response to the expected grid request. Browser events arrive in order, so a duplicate
  // request sent by the same click has been observed before that response, and the count is exact.
  const sent = [],
    answered = eventLog({ message: 'The grid request was not answered' });
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/grid-data') sent.push(request);
  });
  page.on('response', (response) => {
    if (new URL(response.url()).pathname === '/grid-data') answered.push(response);
  });
  const postsReach = async (count) => {
    await answered.until(() => answered.length >= count);
    assert.equal(sent.length, count, 'one grid request per action');
  };
  await page.goto(`http://127.0.0.1:${server.address().port}/page`);
  await page.locator(".view-select [aria-label='Second']").waitFor({ state: 'attached' });
  // A deferred grid does not load until asked to.
  assert.deepEqual(posts, []);
  await page.evaluate(() => window.jQuery(".view-select [aria-label='Second']").trigger('click'));
  await page.waitForFunction(
    () => document.querySelector('.entity-grid').getAttribute('data-selected-view') === 'view-2',
  );
  await postsReach(1);
  assert.equal(posts.length, 1);
  assert.equal(posts[0].base64SecureConfiguration, 'secure-2');
  await page.evaluate(() => window.jQuery('.view-grid table thead th a').first().trigger('click'));
  await page.locator('.view-grid table').first().waitFor({ state: 'attached' });
  await postsReach(2);
  assert.equal(posts.length, 2);
  assert.equal(posts[1].sortExpression, 'name DESC');
  await page.evaluate(() => window.jQuery('.view-grid table thead th a').first().trigger('click'));
  await postsReach(3);
  assert.equal(posts[2].sortExpression, 'name ASC');
  await page.evaluate(() => window.jQuery('.view-grid table thead th a').first().trigger('click'));
  await postsReach(4);
  assert.equal(posts[3].sortExpression, 'name DESC');
  assert.deepEqual(errors, []);
});

// Bootstrap 3 modal semantics that matter here: show/hide events and the "in" class, with no
// aria-hidden changes (the cached platform bootstrap bundle has none in its modal plugin).
const BOOTSTRAP3_MODAL = `(function ($) {
  $.fn.modal = function (option) {
    return this.each(function () {
      var $el = $(this);
      if (option === "hide") {
        if (!$el.hasClass("in")) return;
        $el.trigger($.Event("hide.bs.modal"));
        $el.removeClass("in").hide();
        $el.trigger("hidden.bs.modal");
        return;
      }
      var show = $.Event("show.bs.modal");
      $el.trigger(show);
      if (show.isDefaultPrevented()) return;
      $el.show().addClass("in");
      $el.trigger("shown.bs.modal");
    });
  };
  $(document).on("click", "[data-dismiss=modal]", function () { $(this).closest(".modal").modal("hide"); });
})(jQuery);`;

test('create-form loading announcements end on load, cancellation and failed navigation', async (t) => {
  const jquery = await fs.readFile(new URL('../node_modules/jquery/dist/jquery.min.js', import.meta.url));
  const grid = await fs.readFile(new URL('../lib/entity-grid-compat.js', import.meta.url));
  const layout = {
    ...layouts[0],
    Configuration: {
      ViewDisplayName: 'First',
      ViewActionLinks: [{ Type: 3, Enabled: true, Label: 'Create item', Target: 0, EntityForm: { Id: 'create' } }],
    },
  };
  const markup = `<!doctype html><html><body>
<div class="entity-grid" data-defer-loading="true" data-enable-actions="true" data-view-layouts='${JSON.stringify([layout])}'><div class="view-toolbar"></div><div class="view-grid"></div>
<section class="modal modal-form modal-form-insert" aria-hidden="true" style="display:none"><div class="form-loading">Loading form</div><iframe data-page="/form"></iframe><button data-dismiss="modal">Cancel</button></section></div>
<script src="/jquery.js"></script><script src="/bootstrap-modal.js"></script><script src="/grid.js"></script></body></html>`;
  const server = http.createServer((req, res) => {
    const scripts = { '/jquery.js': jquery, '/bootstrap-modal.js': BOOTSTRAP3_MODAL, '/grid.js': grid };
    if (scripts[req.url]) {
      res.setHeader('content-type', 'text/javascript');
      return res.end(scripts[req.url]);
    }
    res.setHeader('content-type', 'text/html');
    res.end(markup);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();
  const errors = [],
    foreignRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('request', (request) => {
    if (new URL(request.url()).origin !== `http://127.0.0.1:${server.address().port}`)
      foreignRequests.push(request.url());
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/page`);
  const notice = page.locator('.view-toolbar #notificationDiv');
  const modal = page.locator('.modal-form-insert');
  for (const outcome of ['load', 'cancel', 'failure']) {
    let release, requested;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const started = new Promise((resolve) => {
      requested = resolve;
    });
    await page.route('**/form?**', async (route) => {
      requested();
      await gate;
      if (outcome === 'failure')
        await route.fulfill({ status: 500, contentType: 'text/html', body: '<p>Form unavailable</p>' });
      else
        await route.fulfill({
          contentType: 'text/html',
          body: '<form id="EntityFormControl"><input aria-label="Name"></form>',
        });
    });
    await page.getByRole('button', { name: 'Create item' }).click();
    await started;
    assert.equal(await notice.innerText(), 'Loading');
    if (outcome === 'cancel') {
      await modal.getByRole('button', { name: 'Cancel' }).click();
      assert.equal(await notice.count(), 0);
    }
    release();
    await notice.waitFor({ state: 'detached' });
    if (outcome !== 'cancel') await modal.getByRole('button', { name: 'Cancel' }).click();
    await page.unroute('**/form?**');
  }
  // Authored scripts may replace the native modal markup. Invalid destinations
  // must neither navigate away nor leave an announcement for work that never began.
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(page.url()).origin ? route.continue() : route.abort(),
  );
  for (const source of [
    'https://other.example.invalid/form',
    'http://[',
    'javascript:alert(1)',
    null,
    'missing-frame',
  ]) {
    await modal.evaluate((element, source) => {
      element.querySelector('iframe')?.remove();
      if (source === 'missing-frame') return;
      const frame = document.createElement('iframe');
      if (source !== null) frame.setAttribute('data-page', source);
      element.prepend(frame);
    }, source);
    await page.getByRole('button', { name: 'Create item' }).click();
    assert.equal(await notice.count(), 0, String(source));
    assert.equal(await modal.getAttribute('aria-hidden'), 'true');
  }
  const refused = await page.evaluate(() => {
    const element = document.querySelector('.entity-grid'),
      grid = element.__ppEntityGrid;
    for (const [type, className] of [
      [1, 'modal-form-details'],
      [2, 'modal-form-edit'],
    ]) {
      const modal = document.createElement('section');
      modal.className = 'modal ' + className;
      element.append(modal);
      grid.runAction({ Type: type, EntityForm: { Id: 'form' } }, { Id: 'record' }, element);
      modal.remove();
    }
    const lookup = document.createElement('div');
    lookup.className = 'entity-lookup';
    lookup.setAttribute('data-lookup-datafieldname', 'invented');
    lookup.innerHTML =
      '<section class="modal-lookup"><div class="entity-grid" data-defer-loading="true" data-view-layouts="[]"><div class="view-grid"></div></div><div class="modal-footer"><button class="new-value">Create lookup</button></div></section><section class="modal-lookup-create-form" aria-hidden="true"></section>';
    document.body.append(lookup);
    window.__portalSimulation.nativeGrid.initialise(lookup.parentElement);
    lookup.querySelector('.new-value').click();
    if (lookup.querySelector('.modal-lookup-create-form').getAttribute('aria-hidden') !== 'true')
      throw new Error('A lookup with no create iframe must stay closed.');
    lookup.remove();
    return grid.openFormModal(element.querySelector('.modal-form-insert'), '/form');
  });
  assert.equal(refused, false, 'a missing iframe also fails closed at the direct modal boundary');
  assert.deepEqual(foreignRequests, []);
  assert.deepEqual(errors, []);
});

test('a grid confirmation dialog is exposed to assistive technology while shown, as on the platform', async (t) => {
  const jquery = await fs.readFile(new URL('../node_modules/jquery/dist/jquery.min.js', import.meta.url));
  const grid = await fs.readFile(new URL('../lib/entity-grid-compat.js', import.meta.url));
  const layout = {
    Id: 'view-1',
    ViewName: 'Contacts',
    Configuration: {
      ViewDisplayName: 'Contacts',
      ItemActionLinks: [{ Type: 4, Enabled: true, Label: 'Remove', Tooltip: 'Remove' }],
    },
    Columns: [
      { LogicalName: 'name', Name: 'Name', Width: 90, WidthAsPercent: 90 },
      { LogicalName: '', Name: '', Type: 2, Width: 10, WidthAsPercent: 10 },
    ],
    Base64SecureConfiguration: 'secure-1',
  };
  const page = `<!doctype html><html lang="en"><head><title>Grid</title></head><body>
<div id="antiforgerytoken"><input type="hidden" name="__RequestVerificationToken" value="token"></div>
<div class="entity-grid" data-get-url="/grid-data" data-enable-actions="true" data-view-layouts='${JSON.stringify([layout])}'><div class="view-grid"></div><div class="view-pagination"></div>
<section aria-hidden="true" aria-label="Delete" class="modal fade modal-delete" data-backdrop="static" role="dialog" tabindex="-1" style="display:none"><div class="modal-dialog"><div class="modal-content"><div class="modal-header"><h1 class="modal-title">Delete</h1></div><div class="modal-body">Are you sure you want to delete this record?</div><div class="modal-footer"><button type="button" class="primary btn btn-primary">Delete</button><button type="button" class="cancel btn btn-default" data-dismiss="modal">Cancel</button></div></div></div></section>
</div>
<script src="/jquery.js"></script><script src="/bootstrap-modal.js"></script><script src="/grid.js"></script>
</body></html>`;
  const server = http.createServer((req, res) => {
    if (req.url === '/page') return res.end(page);
    const scripts = { '/jquery.js': jquery, '/bootstrap-modal.js': BOOTSTRAP3_MODAL, '/grid.js': grid };
    if (scripts[req.url]) {
      res.setHeader('content-type', 'text/javascript');
      return res.end(scripts[req.url]);
    }
    if (req.url === '/grid-data' && req.method === 'POST') {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            Records: [
              {
                Id: 'r0000000-0000-4000-8000-000000000001',
                EntityName: 'contact',
                CanDelete: true,
                Attributes: [{ Name: 'name', Value: 'Blair', DisplayValue: 'Blair' }],
              },
            ],
            ItemCount: 1,
            PageNumber: 1,
            PageSize: 10,
            PageCount: 1,
            MoreRecords: false,
          }),
        );
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    // A preconnected socket that never sent a request would hold server.close open.
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  const context = await browser.newContext();
  t.after(() => context.close());
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.goto(`http://127.0.0.1:${server.address().port}/page`);
  await tab.locator("tr[data-id] button[data-toggle='dropdown']").click();
  await tab.locator('tr[data-id] a.delete-link').click();
  const confirm = tab.getByRole('dialog').getByRole('button', { name: 'Delete' });
  await confirm.waitFor({ timeout: 5000 });
  assert.equal(await tab.locator('.modal-delete').getAttribute('aria-hidden'), 'false');
  await tab.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click();
  await tab.waitForFunction(() => document.querySelector('.modal-delete').getAttribute('aria-hidden') === 'true');
  assert.equal(await tab.getByRole('dialog').count(), 0);
  assert.deepEqual(errors, []);
});
