// The model-driven shell's mobile offline toggle (model-driven/offline.mjs): going offline downloads the profile, the form
// edits the offline copy and shows the change pending, going online uploads it to the organization.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser();

const PROFILE = '77777777-7777-4777-8777-777777777791',
  COPPER = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

test('the shell goes offline, edits a record in the offline copy, shows it pending and syncs it when back online', async (t) => {
  const initial = await modelDrivenFixture(t, { defer: true });
  const dir = initial.solutionDir;
  await fs.mkdir(path.join(dir, 'MobileOfflineProfiles'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'MobileOfflineProfiles/fx_field.xml'),
    `<MobileOfflineProfile><MobileOfflineProfileId>{${PROFILE}}</MobileOfflineProfileId><Name>fx_field</Name><MobileOfflineProfileItems>` +
      '<MobileOfflineProfileItem><SelectedEntityTypeCode>x_item</SelectedEntityTypeCode><RecordDistributionCriteria>1</RecordDistributionCriteria></MobileOfflineProfileItem></MobileOfflineProfileItems></MobileOfflineProfile>',
  );
  const appFile = path.join(dir, 'AppModules/x_example/AppModule.xml');
  await fs.writeFile(
    appFile,
    (await fs.readFile(appFile, 'utf8')).replace(
      '</AppModuleComponents>',
      `<AppModuleComponent type="161" id="{${PROFILE}}"/></AppModuleComponents>`,
    ),
  );
  const sim = await initial.start();
  const origin = sim.origin ?? sim.url;
  t.after(() => sim.close());
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const serverName = () => sim.store.tableRows('x_item').find((row) => row.x_itemid === COPPER).x_name;
  const toggle = page.locator('#offline-mode');
  const switchMode = async (label) => {
    await toggle.click();
    await page.getByRole('dialog').getByRole('button', { name: label, exact: true }).click();
  };

  await page.goto(origin + `/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=${COPPER}`);
  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  assert.equal(await toggle.textContent(), 'Online');
  await switchMode('Go offline');
  await page.waitForFunction(
    () =>
      document.querySelector('#offline-mode')?.textContent === 'Offline' &&
      document.documentElement.dataset.mirageAppState === 'ready',
  );
  assert.equal(await page.evaluate(() => window.Xrm.Utility.getGlobalContext().client.isOffline()), true);

  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  await page.getByLabel('Name', { exact: true }).fill('Copper offline');
  await page
    .getByRole('toolbar', { name: 'Commands', exact: true })
    .getByRole('button', { name: 'Save', exact: true })
    .click();
  await page.getByRole('heading', { name: 'Copper offline', exact: true }).waitFor();
  await page.waitForFunction(() => document.querySelector('#offline-mode')?.textContent === 'Offline · 1 pending');
  assert.equal(serverName(), 'Copper', 'nothing reaches the organization while offline');
  // Scripts and the shell read the same copy.
  assert.equal(
    await page.evaluate(
      (id) => window.Xrm.WebApi.retrieveRecord('x_item', id, '?$select=x_name').then((row) => row.x_name),
      COPPER,
    ),
    'Copper offline',
  );

  await switchMode('Go online');
  await page.waitForFunction(() => document.querySelector('#offline-mode')?.textContent === 'Online');
  assert.equal(serverName(), 'Copper offline');
  await page.getByRole('heading', { name: 'Copper offline', exact: true }).waitFor();
  const sessions = await (
    await fetch(origin + '/_sim/api/model-driven/offline', { headers: { 'x-sim-csrf': sim.state().csrf } })
  ).json();
  assert.deepEqual(
    sessions.items.map((item) => [item.kind, item.profile, item.mode, item.queue, item.conflicts]),
    [['local-admin', 'fx_field', 'online', 0, 0]],
  );
  assert.deepEqual(errors, []);
});
