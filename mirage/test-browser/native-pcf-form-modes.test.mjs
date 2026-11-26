// @test-kind contract: Mirage mounts form-bound PCF on native edit, read-only, multistep and modal forms and saves through the native form on a loopback portal; invented schema, no native capture
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROW_ID,
  emit,
  metadataFiles,
  openNativePcfSite,
  portalFiles,
  probe,
  probesReady,
  solutionFiles,
  storedRow,
} from './native-pcf-fixture.mjs';

const COLUMNS = [
  ['tst_name', 'text'],
  ['tst_count', 'whole'],
];
const ROW = { tst_rowid: ROW_ID, tst_title: 'Existing row', tst_name: 'Before', tst_count: 4 };
const basicForm = (mode) =>
  `adx_entityformid: row-form\nadx_name: Row form\nadx_entityname: tst_row\nadx_formname: Portal row\nadx_mode: ${mode}\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: id\nadx_hideformonsuccess: false`;
const basicSite = (mode) => ({
  ...portalFiles('{% entityform name:"Row form" %}'),
  'portal/Row.basicform.yml': basicForm(mode),
  ...metadataFiles('basicformmetadata', 'row-form', COLUMNS),
  ...solutionFiles(COLUMNS),
});

test('an edit form mounts the record values in its components and saves their outputs', async (t) => {
  const { app, page, errors } = await openNativePcfSite(t, basicSite(100000001), { rows: [ROW] });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, 2);
  assert.equal((await probe(page, 'tst_name')).initRaw, 'Before');
  assert.equal((await probe(page, 'tst_count')).initRaw, 4);
  assert.equal((await probe(page, 'tst_name')).disabled, false);
  await emit(page, 'tst_name', 'After');
  await emit(page, 'tst_count', 7);
  assert.equal(await page.locator('#tst_name').inputValue(), '"After"');
  await page.locator('#UpdateButton').click();
  await page.locator('#MessageLabel').waitFor();
  assert.deepEqual({ name: storedRow(app).tst_name, count: storedRow(app).tst_count }, { name: 'After', count: 7 });
  assert.deepEqual(errors, []);
});

test('a read-only form mounts disabled components and offers no save', async (t) => {
  const { app, page, errors } = await openNativePcfSite(t, basicSite(100000002), { rows: [ROW] });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, 2);
  const name = await probe(page, 'tst_name');
  assert.equal(name.initRaw, 'Before');
  assert.equal(name.disabled, true);
  assert.equal((await probe(page, 'tst_count')).disabled, true);
  assert.equal(await page.locator('#UpdateButton, #InsertButton').count(), 0);
  assert.deepEqual(errors, []);
});

test('multistep steps mount the components their step metadata enables and save each step', async (t) => {
  const files = {
    ...portalFiles('{% webform name:"Row wizard" %}'),
    'portal/Wizard.advancedform.yml':
      'adx_webformid: wizard\nadx_name: Row wizard\nadx_startstep: step-one\nadx_multiplerecordsperuserpermitted: true',
    'portal/One.advancedformstep.yml':
      'adx_webformstepid: step-one\nadx_name: One\nadx_webform: wizard\nadx_type: 100000001\nadx_targetentitylogicalname: tst_row\nadx_formname: Portal row\nadx_mode: 100000000\nadx_nextstep: step-two',
    'portal/Two.advancedformstep.yml':
      'adx_webformstepid: step-two\nadx_name: Two\nadx_webform: wizard\nadx_type: 100000001\nadx_targetentitylogicalname: tst_row\nadx_formname: Portal row\nadx_mode: 100000001\nadx_entitysourcetype: 100000003\nadx_entitysourcestep: step-one\nadx_hideformonsuccess: false',
    // Step one enables the component on the name, step two on the count.
    ...metadataFiles('advancedformmetadata', 'step-one', [COLUMNS[0]]),
    ...metadataFiles('advancedformmetadata', 'step-two', [COLUMNS[1]]),
    ...solutionFiles(COLUMNS),
  };
  const { app, page, errors } = await openNativePcfSite(t, files);
  await page.goto(app.url);
  await probesReady(page, app, 1);
  assert.equal(await page.locator('[id^=PcfControl_]').count(), 1);
  assert.equal(await page.locator('#tst_name_ControlView [data-pcf-ready=true]').count(), 1);
  await emit(page, 'tst_name', 'From step one');
  await page.locator('#NextButton').click();
  await page.locator('#tst_count_ControlView [data-pcf-ready=true]').waitFor();
  assert.equal(await page.locator('#tst_name_ControlView').count(), 0);
  const created = app.store.snapshot().tables.tst_row;
  assert.equal(created.length, 1);
  assert.equal(created[0].tst_name, 'From step one');
  // The second step edits the record the first step saved.
  assert.equal(await page.locator('#tst_name').inputValue(), 'From step one');
  await emit(page, 'tst_count', 12);
  await page.locator('#NextButton').click();
  await page.getByText('Submission completed successfully.').waitFor();
  assert.equal(app.store.snapshot().tables.tst_row[0].tst_count, 12);
  assert.deepEqual(errors, []);
});

test('modal create and edit forms mount their components and save through the modal form', async (t) => {
  const createFiles = {
    ...basicSite(100000000),
    'portal/Row.basicform.yml': basicForm(100000000),
  };
  const { app, page, errors } = await openNativePcfSite(t, createFiles, { rows: [ROW] });
  await page.goto(`${app.url}/_portal/modal-form-template-path/site?entityformid=row-form`);
  await probesReady(page, app, 2);
  // An empty text column is "" on the field host (captured, digest-fields-r2-insert-ny.json).
  assert.equal((await probe(page, 'tst_name')).initRaw, '');
  await emit(page, 'tst_name', 'Created in modal');
  await emit(page, 'tst_count', 3);
  await page.locator('#InsertButton').click();
  await page.waitForFunction(() => document.querySelector('#MessagePanel, #MessageLabel'));
  const created = app.store.snapshot().tables.tst_row.find((row) => row.tst_name === 'Created in modal');
  assert.ok(created, JSON.stringify(app.store.snapshot().tables.tst_row));
  assert.equal(created.tst_count, 3);

  const edit = await openNativePcfSite(t, basicSite(100000001), { rows: [ROW] });
  await edit.page.goto(`${edit.app.url}/_portal/modal-form-template-path/site?entityformid=row-form&id=${ROW_ID}`);
  await probesReady(edit.page, edit.app, 2);
  assert.equal((await probe(edit.page, 'tst_name')).initRaw, 'Before');
  await emit(edit.page, 'tst_name', 'Edited in modal');
  await edit.page.locator('#UpdateButton').click();
  await edit.page.waitForFunction(() => document.querySelector('#MessagePanel, #MessageLabel'));
  assert.equal(storedRow(edit.app).tst_name, 'Edited in modal');
  assert.deepEqual([...errors, ...edit.errors], []);
});
