// @test-kind contract: Mirage writes form-bound PCF choice, two-option and multiselect outputs to the field host hidden input on each control style and saves them on a loopback portal; invented schema
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DROPDOWN_CLASS,
  RADIO_CLASS,
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

const site = (columns) => ({
  ...portalFiles('{% entityform name:"Row form" %}'),
  'portal/Row.basicform.yml':
    'adx_entityformid: row-form\nadx_name: Row form\nadx_entityname: tst_row\nadx_formname: Portal row\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: id\nadx_hideformonsuccess: false',
  ...metadataFiles('basicformmetadata', 'row-form', columns),
  ...solutionFiles(columns),
});

async function editAndSave(t, columns, row, change) {
  const { app, page, errors } = await openNativePcfSite(t, site(columns), {
    rows: [{ tst_rowid: ROW_ID, tst_title: 'Row', ...row }],
  });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, columns.length);
  await change(page);
  await page.locator('#UpdateButton').click();
  await page.locator('#MessageLabel').waitFor();
  // The save reloads the page: its code components mount again before the probe is read.
  await probesReady(page, app, columns.length);
  return { app, page, errors, stored: storedRow(app) };
}

test('a choice component reads the selected option and saves the option it emits', async (t) => {
  const { stored, errors } = await editAndSave(t, [['tst_choice', 'choice']], { tst_choice: 2 }, async (page) => {
    assert.equal((await probe(page, 'tst_choice')).initRaw, 2);
    assert.equal((await probe(page, 'tst_choice')).type, 'OptionSet');
    await emit(page, 'tst_choice', 3);
    // The hidden input holds the option object (captured, capture r2 notify-save pqpcf_choice).
    assert.equal(JSON.parse(await page.locator('#tst_choice').inputValue()).Value, 3);
  });
  assert.equal(Number(stored.tst_choice), 3);
  assert.deepEqual(errors, []);
});

test('a two-options component on the default checkbox writes and saves true', async (t) => {
  const { stored, errors } = await editAndSave(t, [['tst_flag', 'flag']], { tst_flag: false }, async (page) => {
    assert.equal((await probe(page, 'tst_flag')).initRaw, false);
    await emit(page, 'tst_flag', true);
    assert.equal(await page.locator('#tst_flag').inputValue(), 'true');
  });
  assert.equal(stored.tst_flag, true);
  assert.deepEqual(errors, []);
});

for (const [style, classid] of [
  ['radio', RADIO_CLASS],
  ['dropdown', DROPDOWN_CLASS],
])
  test(`a two-options component on the ${style} style writes and saves true`, async (t) => {
    const { stored, page } = await editAndSave(
      t,
      [['tst_flag', 'flag', classid]],
      { tst_flag: false },
      async (current) => {
        assert.equal((await probe(current, 'tst_flag')).initRaw, false);
        await emit(current, 'tst_flag', true);
      },
    );
    assert.equal(stored.tst_flag, true);
    assert.equal((await probe(page, 'tst_flag')).raw, true);
  });

test('a multiselect component reads the selected options and saves the options it emits', async (t) => {
  const { stored, errors } = await editAndSave(
    t,
    [['tst_choices', 'choices']],
    { tst_choices: '1,3' },
    async (page) => {
      assert.deepEqual((await probe(page, 'tst_choices')).initRaw, [1, 3]);
      await emit(page, 'tst_choices', [2]);
    },
  );
  assert.deepEqual(String(stored.tst_choices).split(',').map(Number), [2]);
  assert.deepEqual(errors, []);
});
