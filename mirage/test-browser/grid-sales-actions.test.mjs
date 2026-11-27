// @test-kind unproven: local model of the legacy Qualify, Activate Quote and Reopen Opportunity links (entity-grid.js row link cases 10, 19 and 25 with their record-state conditions, the qualify dialog of an action with ShowModal 1, entity-form.js confirm-then-post) and of the posted reference; no hosted capture of these actions
import test from 'node:test';
import assert from 'node:assert/strict';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { SALES, startSalesLists } from '../test/support/sales-list-fixture.mjs';
import { openPortalPage, sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser({ headless: true });

async function open(t, actions) {
  const app = await startSalesLists(t, actions);
  const context = await chrome.browser.newContext();
  ownedFixture(t).add(() => context.close());
  await signInContext(context, app, SALES.CONTACT, { roles: ['Agent'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  return { app, page, errors };
}
const row = (app, table, id) => app.store.tableRows(table).find((item) => item[`${table}id`] === id);

test('the lead grid confirms Qualify in its dialog and the quote and deal grids follow the record state', async (t) => {
  const { app, page, errors } = await open(t, {
    lead: [{ Type: 'QualifyLeadAction', ShowModal: 1 }],
    quote: [{ Type: 'ActivateQuoteAction' }],
    opportunity: [{ Type: 'ReopenOpportunityAction' }],
  });
  await openPortalPage(page, `${app.url}/`);
  const lead = page.locator(`.entity-grid tr[data-id="${SALES.LEAD}"]`);
  await lead.waitFor();
  assert.equal(await lead.locator('a.qualify-lead-link').count(), 1);
  assert.equal(await page.locator(`.entity-grid tr[data-id="${SALES.QUALIFIED_LEAD}"] a.qualify-lead-link`).count(), 0);
  await lead.locator('a.qualify-lead-link').evaluate((link) => link.click());
  const modal = page.locator('.entity-grid .modal-qualify');
  await modal.getByText('Are you sure you want to qualify this lead as an opportunity?').waitFor();
  assert.equal(row(app, 'lead', SALES.LEAD).statecode, 0, 'nothing is posted before the dialog is confirmed');
  const posted = page.waitForRequest((request) => request.url().includes('/_services/action-qualify-lead/'));
  const answered = page.waitForResponse((response) => response.url().includes('/_services/action-qualify-lead/'));
  await modal.locator('.modal-footer button.primary').evaluate((button) => button.click());
  assert.deepEqual((await posted).postDataJSON().entityReference, { LogicalName: 'lead', Id: SALES.LEAD });
  assert.equal((await answered).status(), 204);
  assert.deepEqual([row(app, 'lead', SALES.LEAD).statecode, row(app, 'lead', SALES.LEAD).statuscode], [1, 3]);

  await openPortalPage(page, `${app.url}/quotes/`);
  const draft = page.locator(`.entity-grid tr[data-id="${SALES.QUOTE}"]`);
  await draft.waitFor();
  assert.equal(await draft.locator('a.activate-quote-link').count(), 1);
  assert.equal(await page.locator(`.entity-grid tr[data-id="${SALES.ACTIVE_QUOTE}"] a.activate-quote-link`).count(), 0);

  await openPortalPage(page, `${app.url}/deals/`);
  const won = page.locator(`.entity-grid tr[data-id="${SALES.WON_DEAL}"]`);
  await won.waitFor();
  assert.equal(await won.locator('a.reopen-opportunity-link').count(), 1);
  assert.equal(
    await page.locator(`.entity-grid tr[data-id="${SALES.OPEN_DEAL}"] a.reopen-opportunity-link`).count(),
    0,
  );
  const reopened = page.waitForResponse((response) => response.url().includes('/_services/reopen-opportunity/'));
  await won.locator('a.reopen-opportunity-link').evaluate((link) => link.click());
  assert.equal((await reopened).status(), 204);
  assert.deepEqual(
    [row(app, 'opportunity', SALES.WON_DEAL).statecode, row(app, 'opportunity', SALES.WON_DEAL).statuscode],
    [0, 100000003],
  );
  assert.deepEqual(errors, []);
});

test('the form Qualify button with ShowModal confirms in the legacy dialog before it posts', async (t) => {
  const { app, page, errors } = await open(t, { form: [{ Type: 'QualifyLeadAction', ShowModal: 1 }] });
  await openPortalPage(page, `${app.url}/lead/?id=${SALES.LEAD}`);
  const button = page.locator('button.qualify-lead-link');
  await button.waitFor();
  await button.evaluate((element) => element.click());
  const modal = page.locator('.modal-qualify');
  await modal.getByText('Are you sure you want to qualify this lead as an opportunity?').waitFor();
  assert.equal(await modal.locator('.modal-title').innerText(), 'Qualify Lead');
  assert.equal(await modal.locator('.modal-footer button.primary').innerText(), 'Qualify');
  assert.equal(row(app, 'lead', SALES.LEAD).statecode, 0, 'nothing is posted before the dialog is confirmed');
  const answered = page.waitForResponse((response) => response.url().includes('/__sim/forms/entityform/'));
  await modal.locator('.modal-footer button.primary').evaluate((element) => element.click());
  assert.equal((await answered).status(), 200);
  assert.deepEqual([row(app, 'lead', SALES.LEAD).statecode, row(app, 'lead', SALES.LEAD).statuscode], [1, 3]);
  assert.equal(app.store.tableRows('account')[0].name, 'Invented Company');
  assert.deepEqual(errors, []);
});
