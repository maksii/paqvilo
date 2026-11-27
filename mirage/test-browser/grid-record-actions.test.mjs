// @test-kind unproven: local model of the legacy grid record action links (entity-grid.js: the row link class, its record-state condition, the resolve dialog and the posted reference); no hosted capture of these list actions
import test from 'node:test';
import assert from 'node:assert/strict';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { CASES, startCaseList } from '../test/support/case-list-fixture.mjs';
import { openPortalPage, sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser({ headless: true });

test('grid record actions follow the record state, ask for the resolution and post to their action service', async (t) => {
  const app = await startCaseList(t, {
    ItemActions: [{ Type: 'ResolveCaseAction' }, { Type: 'ReopenCaseAction', ActionIndex: 2 }],
  });
  const context = await chrome.browser.newContext();
  ownedFixture(t).add(() => context.close());
  await signInContext(context, app, CASES.CONTACT, { roles: ['Agent'] });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await openPortalPage(page, `${app.url}/`);
  const row = page.locator(`.entity-grid tr[data-id="${CASES.OPEN}"]`);
  await row.waitFor();
  // An open case offers Resolve Case, not Reopen Case.
  assert.equal(await row.locator('a.resolve-case-link').count(), 1);
  assert.equal(await row.locator('a.reopen-case-link').count(), 0);
  await row.locator('a.resolve-case-link').evaluate((link) => link.click());
  const modal = page.locator('.entity-grid .modal-resolvecase');
  await modal.locator('.resolution-input').fill('Fixed');
  await modal.locator('.resolution-description-input').fill('Replaced the part');
  const posted = page.waitForRequest((request) => request.url().includes('/_services/action-resolve-case/'));
  const answered = page.waitForResponse((response) => response.url().includes('/_services/action-resolve-case/'));
  await modal.locator('.modal-footer button.primary').evaluate((button) => button.click());
  assert.deepEqual((await posted).postDataJSON(), {
    entityReference: { LogicalName: 'incident', Id: CASES.OPEN },
    resolutionSubject: 'Fixed',
    resolutionDescription: 'Replaced the part',
  });
  assert.equal((await answered).status(), 204);
  const resolved = app.store.tableRows('incident').find((item) => item.incidentid === CASES.OPEN);
  assert.deepEqual([resolved.statecode, resolved.statuscode], [1, 5]);
  // After the refresh the resolved case offers Reopen Case.
  await row.locator('a.reopen-case-link').waitFor({ state: 'attached' });
  assert.equal(await row.locator('a.resolve-case-link').count(), 0);
  assert.deepEqual(errors, []);
});
