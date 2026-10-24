import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';

const chrome = sharedBrowser();

test('grid Refresh reloads selected-table form metadata before opening New', async (t) => {
  const { origin, sim, solutionDir } = await modelDrivenFixture(t);
  const page = await chrome.page(t),
    requests = [];
  page.on('request', (request) => requests.push(new URL(request.url()).pathname));
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  const source = path.join(solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  await fs.writeFile(
    source,
    (await fs.readFile(source, 'utf8')).replace('description="Name"', 'description="Renamed field"'),
  );
  await sim.reload();
  requests.length = 0;
  let releaseMetadata, metadataRequested;
  const metadataGate = new Promise((resolve) => {
    releaseMetadata = resolve;
  });
  const pendingMetadata = new Promise((resolve) => {
    metadataRequested = resolve;
  });
  t.after(() => releaseMetadata());
  await page.route('**/_apps/api/metadata/x_item', async (route) => {
    metadataRequested();
    await metadataGate;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await pendingMetadata;
  assert.equal(
    await page.getByRole('button', { name: 'New', exact: true }).count(),
    0,
    'New cannot open a form from metadata being refreshed.',
  );
  const refreshedMetadata = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/_apps/api/metadata/x_item',
  );
  releaseMetadata();
  await (await refreshedMetadata).finished();
  await page.unroute('**/_apps/api/metadata/x_item');
  await page.locator('#app-loading').waitFor({ state: 'detached' });
  assert.ok(requests.includes('/_apps/api/metadata/x_item'));
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Renamed field', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).count(), 0);
  await page.getByLabel('Renamed field', { exact: true }).fill('Unsaved draft survives');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await page
    .getByRole('dialog', { name: 'Unsaved changes' })
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  assert.equal(await page.getByLabel('Renamed field', { exact: true }).inputValue(), 'Unsaved draft survives');
});

test('new record URL defaults accept rendered columns and ignore arbitrary property names', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  const name = '<script>window.urlDefaultExecuted = true</script>';
  const defaults = new URLSearchParams([
    ['x_name', name],
    ['x_quantity', '7'],
    ['x_quantity', '9'],
    ['x_itemid', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'],
    ['__proto__', '{"polluted":true}'],
    ['constructor', 'untrusted'],
    ['x_unknown', 'untrusted'],
  ]);
  const query = new URLSearchParams({
    appname: 'x_example',
    pagetype: 'entityrecord',
    etn: 'x_item',
    extraqs: defaults.toString(),
  });
  await page.goto(`${origin}/main.aspx?${query}`);
  await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
  assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), name);
  assert.equal(await page.getByLabel('Quantity', { exact: true }).inputValue(), '9');
  assert.equal(await page.evaluate(() => window.urlDefaultExecuted), undefined);
  const submitted = page.waitForRequest(
    (request) => request.method() === 'POST' && new URL(request.url()).pathname === '/_apps/api/tables/x_item',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const payload = (await submitted).postDataJSON();
  assert.equal(payload.x_name, name);
  assert.equal(payload.x_quantity, 9);
  for (const key of ['x_itemid', '__proto__', 'constructor', 'x_unknown'])
    assert.equal(Object.hasOwn(payload, key), false);
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
});

test(
  'slow model-driven reads and saves show feedback, prevent duplicate writes and recover with retry',
  { timeout: 30000 },
  async (t) => {
    const { origin } = await modelDrivenFixture(t);
    const page = await chrome.page(t, { reducedMotion: 'reduce' });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    let startupFailed = false;
    await page.route('**/_apps/api/index', (route) => {
      if (startupFailed) return route.continue();
      startupFailed = true;
      return route.fulfill({ status: 503, json: { error: { message: 'Invented startup failure' } } });
    });
    await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
    await page.getByRole('status').filter({ hasText: 'Invented startup failure' }).waitFor();
    assert.equal(await page.locator('#content').getAttribute('aria-busy'), 'false');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
    let release,
      rejectRead = false;
    await page.route('**/_apps/api/tables/x_item?*', async (route) => {
      if (rejectRead)
        return route.fulfill({ status: 503, json: { error: { message: 'Invented temporary read failure' } } });
      await new Promise((resolve) => {
        release = resolve;
      });
      await route.continue();
    });
    t.after(() => release?.());
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.locator('#app-loading').filter({ hasText: 'Loading records' }).waitFor();
    assert.equal(await page.locator('#content').getAttribute('aria-busy'), 'true');
    assert.equal(await page.locator('#content').evaluate((node) => node.inert), true);
    assert.equal(
      await page.getByRole('button', { name: 'Copper', exact: true }).count(),
      1,
      'previous data remains visible during refresh',
    );
    while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
    release();
    await page.locator('#app-loading').waitFor({ state: 'detached' });
    rejectRead = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Invented temporary read failure' }).waitFor();
    assert.equal(await page.locator('#content').getAttribute('aria-busy'), 'false');
    await page.unroute('**/_apps/api/tables/x_item?*');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.route('**/_apps/api/tables/x_item/*', (route) =>
      route.fulfill({ status: 503, json: { error: { message: 'Invented record failure' } } }),
    );
    await page.getByRole('button', { name: 'Copper', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'Invented record failure' }).waitFor();
    assert.equal(await page.locator('#content').getAttribute('aria-busy'), 'false');
    await page.unroute('**/_apps/api/tables/x_item/*');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByLabel('Name', { exact: true }).fill('Delayed save');
    let writes = 0;
    release = undefined;
    await page.route('**/_apps/api/tables/x_item/*', async (route) => {
      if (route.request().method() !== 'PATCH') return route.continue();
      writes++;
      await new Promise((resolve) => {
        release = resolve;
      });
      await route.continue();
    });
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.locator('#save-status').filter({ hasText: 'Saving…' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Save', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('#record-form').evaluate((node) => node.inert), true);
    await page.evaluate(() =>
      document.querySelector('#record-form').dispatchEvent(new Event('submit', { cancelable: true })),
    );
    while (!release) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(writes, 1);
    release();
    await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
    assert.equal(await page.locator('#record-form').evaluate((node) => node.inert), false);
    assert.equal(await page.getByLabel('Name', { exact: true }).inputValue(), 'Delayed save');
    assert.deepEqual(errors, []);
  },
);

test('navigation cancels a pending grid search and repeated dialogs release listeners', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  await page.clock.install();
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  const cdp = await page.context().newCDPSession(page);
  t.after(() => cdp.detach().catch(() => {}));
  const cancelListeners = async () => {
    const { result } = await cdp.send('Runtime.evaluate', {
      expression: 'document.querySelector("#dialog")',
      objectGroup: 'dialog-audit',
    });
    try {
      return (await cdp.send('DOMDebugger.getEventListeners', { objectId: result.objectId })).listeners.filter(
        (listener) => listener.type === 'cancel',
      ).length;
    } finally {
      await cdp.send('Runtime.releaseObjectGroup', { objectGroup: 'dialog-audit' });
    }
  };
  const baseline = await cancelListeners();
  for (let index = 0; index < 15; index++) {
    await page.getByRole('button', { name: 'Edit columns' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  }
  assert.equal(await cancelListeners(), baseline, 'closed dialog listeners must not accumulate');
  await page.getByRole('searchbox', { name: 'Filter by keyword' }).fill('unmatched stale search');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByRole('textbox', { name: 'Name', exact: true }).waitFor();
  await page.clock.runFor(1000);
  assert.equal(
    await page.locator('#record-form').count(),
    1,
    'old search must not replace the opened record with a grid',
  );
  await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Unsaved');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await cancelListeners(), baseline);
  assert.equal(await page.locator('#record-form').count(), 1, 'Escape must keep the unsaved record');
});

test('completion of a save cannot clear pending feedback on a newer form route', { timeout: 30000 }, async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  await page.goto(
    origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.getByLabel('Name', { exact: true }).fill('Save before navigation');
  let releaseSave, releaseForm;
  t.after(() => {
    releaseSave?.();
    releaseForm?.();
  });
  await page.route('**/_apps/api/tables/x_item/*', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    await new Promise((resolve) => {
      releaseSave = resolve;
    });
    await route.continue();
  });
  await page.route('**/_apps/api/tables/x_child/*', async (route) => {
    await new Promise((resolve) => {
      releaseForm = resolve;
    });
    await route.continue();
  });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  while (!releaseSave) await new Promise((resolve) => setTimeout(resolve, 10));
  await page.evaluate(() => {
    void window.Xrm.Navigation.openForm({ entityName: 'x_child', entityId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' });
  });
  await page.getByRole('button', { name: 'Discard changes', exact: true }).click();
  while (!releaseForm) await new Promise((resolve) => setTimeout(resolve, 10));
  releaseSave();
  await page.waitForFunction(() => !document.querySelector('#commands button[aria-busy=true]'));
  assert.equal(
    await page.locator('#commands').getAttribute('aria-busy'),
    'true',
    'the previous save must leave newer loading feedback intact',
  );
  assert.equal(await page.locator('#content').evaluate((node) => node.inert), true);
  await page.locator('#app-loading').filter({ hasText: 'Loading record' }).waitFor();
  releaseForm();
  await page.getByRole('heading', { name: 'Copper child', exact: true }).waitFor();
  assert.equal(await page.locator('#commands').getAttribute('aria-busy'), 'false');
});

test('model-driven shell supports solution navigation, editable grids and local record lifecycle', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t, { viewport: { width: 1582, height: 1000 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  const geometry = await page.evaluate(() =>
    Object.fromEntries(
      ['aside', '.commands', '#content', 'thead', 'tbody tr', '.grid-footer'].map((selector) => {
        const { x, y, width, height } = document.querySelector(selector).getBoundingClientRect();
        return [selector, { x, y, width, height }];
      }),
    ),
  );
  assert.equal(geometry.aside.width, 200);
  assert.deepEqual(geometry['.commands'], { x: 207, y: 104, width: 1360, height: 46 });
  assert.equal(geometry['#content'].y, 155);
  assert.equal(geometry.thead.height, 42);
  assert.equal(geometry['tbody tr'].height, 42);
  assert.equal(geometry['.grid-footer'].y, 938);
  assert.equal((await page.locator('#navigation button svg').count()) > 0, true);
  assert.equal(await page.getByRole('button', { name: 'Flow', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'Advanced Find', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: 'external', exact: true }).isDisabled(), true);
  await page.getByRole('searchbox', { name: 'Filter by keyword' }).fill('Silver');
  await page.getByRole('button', { name: 'Silver', exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector('tbody')?.textContent.includes('Copper'));
  await page.getByRole('searchbox', { name: 'Filter by keyword' }).fill('');
  await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Edit columns' }).click();
  await page.getByRole('button', { name: 'Quantity column options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove', exact: true }).click();
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('thead')?.textContent.includes('Quantity'));
  await page.getByRole('button', { name: 'Edit filters' }).click();
  await page.getByRole('button', { name: 'Add condition' }).click();
  await page.getByRole('button', { name: 'Filter 1 column', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Quantity', exact: true }).click();
  await page.getByRole('button', { name: 'Filter 1 operator', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Greater than or equal', exact: true }).click();
  await page.getByLabel('Filter 1 value').fill('5');
  await page.getByRole('button', { name: 'Apply', exact: true }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('tbody')?.textContent.includes('Silver') &&
      !document.querySelector('tbody')?.textContent.includes('Copper'),
  );
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.getByRole('button', { name: 'New', exact: true }).click();
  await page.getByLabel('Name', { exact: true }).fill('Bronze');
  await page.getByLabel('Quantity', { exact: true }).fill('7');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('heading', { name: 'Bronze', exact: true }).waitFor();
  assert.match(page.url(), /pagetype=entityrecord/);
  assert.match(page.url(), /id=/);
  await page.getByLabel('Quantity', { exact: true }).fill('9');
  await page.getByRole('button', { name: 'Save & Close', exact: true }).click();
  await page.getByRole('button', { name: 'Bronze', exact: true }).last().waitFor();
  await page.getByRole('button', { name: 'Bronze', exact: true }).last().click();
  assert.equal(await page.getByLabel('Quantity', { exact: true }).inputValue(), '9');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Copper', exact: true }).last().waitFor();
  assert.equal(await page.locator('tbody').getByRole('button', { name: 'Bronze', exact: true }).count(), 0);
  assert.deepEqual(errors, []);
});

test('default management app edits portal customization and exposes working setup/admin links', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t, { viewport: { width: 1582, height: 1000 } });
  await page.goto(origin + '/main.aspx');
  await page.getByRole('button', { name: 'Invented portal', exact: true }).waitFor();
  await page.getByRole('button', { name: 'Content Snippets', exact: true }).click();
  await page.locator('tbody').getByRole('button', { name: 'Welcome', exact: true }).click();
  await page.getByLabel('Value', { exact: true }).fill('Hello from management');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  const portal = await chrome.page(t);
  await portal.goto(origin + '/');
  assert.match(await portal.locator('body').innerText(), /Hello from management/);
  await page.goto(origin + '/_sim/');
  assert.equal(
    await page.getByRole('link', { name: 'Model-driven apps', exact: true }).getAttribute('href'),
    '/main.aspx',
  );
});

test('exported related subgrid filters by the current record and binds related creates', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  await page.goto(
    origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.getByRole('button', { name: 'Copper child', exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Silver child', exact: true }).count(), 0);
  await page.locator('[data-action=new-related]').click();
  await page.getByLabel('Name', { exact: true }).fill('New related child');
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  const [createdResponse] = await Promise.all([
    page.waitForResponse(
      (response) => response.url().includes('/_apps/api/tables/x_child') && response.request().method() === 'POST',
    ),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  assert.equal(createdResponse.status(), 201, await createdResponse.text());
  await page.getByRole('heading', { name: 'New related child', exact: true }).waitFor();
  const response = await fetch(origin + '/_apps/api/tables/x_child');
  const result = await response.json();
  const created = result.rows.find((row) => row.x_name === 'New related child');
  const record = await (await fetch(origin + '/_apps/api/tables/x_child/' + created.x_childid)).json();
  assert.equal(record.row.x_parentid, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await page.goto(
    origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Select New related child', exact: true }).check();
  await page.locator('.related-grid').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Delete', exact: true }).click();
  await page.waitForFunction(
    () => !document.querySelector('.related-grid tbody')?.textContent.includes('New related child'),
  );
  assert.equal((await fetch(origin + '/_apps/api/tables/x_child/' + created.x_childid)).status, 404);
});
