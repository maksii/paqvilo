// @test-kind observation: the Power Pages host refuses a Lookup column with its summary entry and keeps the native lookup (capture capture r2 edit-full pqpcf_contact, FailePcfControlsSummary)
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  OTHER_TARGET_ID,
  ROW_ID,
  TARGET_ID,
  metadataFiles,
  openNativePcfSite,
  portalFiles,
  solutionFiles,
  storedRow,
} from './native-pcf-fixture.mjs';

const COLUMNS = [['tst_targetid', 'lookup']];
const files = {
  ...portalFiles('{% entityform name:"Row form" %}'),
  'portal/Row.basicform.yml':
    'adx_entityformid: row-form\nadx_name: Row form\nadx_entityname: tst_row\nadx_formname: Portal row\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: id\nadx_hideformonsuccess: false',
  ...metadataFiles('basicformmetadata', 'row-form', COLUMNS),
  ...solutionFiles(COLUMNS),
};
const targets = [
  { tst_targetid: TARGET_ID, tst_title: 'First target' },
  { tst_targetid: OTHER_TARGET_ID, tst_title: 'Other target' },
];
const row = {
  tst_rowid: ROW_ID,
  tst_title: 'Row',
  tst_targetid: { id: TARGET_ID, logical_name: 'tst_target', name: 'First target' },
};
const reference = (value) => (value && typeof value === 'object' ? String(value.id).toLowerCase() : (value ?? null));

test('lookup columns keep the native lookup and are listed in the form summary of refused code components', async (t) => {
  const { app, page, errors } = await openNativePcfSite(t, files, { rows: [row], targets });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await page.locator('#UpdateButton').waitFor();
  assert.equal(await page.locator('[data-mirage-component=codecomponent]').count(), 0);
  assert.equal(await page.locator('[id^=PcfControl_]').count(), 0);
  assert.equal(await page.locator('#tst_targetid').inputValue(), TARGET_ID);
  assert.equal(await page.locator('#tst_targetid_name').inputValue(), 'First target');
  const summary = page.locator('[id^=FailePcfControlsSummary_]');
  assert.equal(
    (await summary.locator('h2').innerText()).trim(),
    "Couldn't load one or more code components on this form.",
  );
  assert.deepEqual(await summary.locator('li').allInnerTexts(), [
    'Lookup data type used by tst_targetid (tst_targetid) is not supported for use with code components in portals. Learn more',
  ]);
  assert.equal(await summary.locator('li a').getAttribute('href'), 'https://go.microsoft.com/fwlink/?linkid=2155120 ');
  // The refusal is the native form: its lookup still saves.
  await page.locator('#UpdateButton').click();
  await page.locator('#MessageLabel').waitFor();
  assert.equal(reference(storedRow(app).tst_targetid), TARGET_ID);
  assert.ok(
    app
      .state()
      .diagnostics.some((entry) => entry.reason === 'PCF_NATIVE_TYPE_UNSUPPORTED' && entry.field === 'tst_targetid'),
  );
  assert.deepEqual(errors, []);
});
