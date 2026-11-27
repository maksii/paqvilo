// @test-kind contract: Mirage hosts form-bound PCF date and number columns west of UTC and in a comma-decimal language and saves their outputs on a loopback portal; invented schema, no native capture
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

const site = (columns, german = false) => ({
  ...portalFiles('{% entityform name:"Row form" %}', { german }),
  'portal/Row.basicform.yml':
    'adx_entityformid: row-form\nadx_name: Row form\nadx_entityname: tst_row\nadx_formname: Portal row\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: id\nadx_hideformonsuccess: false',
  ...metadataFiles('basicformmetadata', 'row-form', columns),
  ...solutionFiles(columns),
});
const save = async (page) => {
  await page.locator('#UpdateButton').click();
  await page.locator('#MessageLabel').waitFor();
};
const instant = (value) => new Date(value).toISOString();

test('a date-only component west of UTC reads and saves the calendar date', async (t) => {
  const columns = [['tst_day', 'dateonly']];
  const { app, page } = await openNativePcfSite(t, site(columns), {
    rows: [{ tst_rowid: ROW_ID, tst_title: 'Row', tst_day: '2026-11-26' }],
    timezoneId: 'America/New_York',
  });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, 1);
  const day = await probe(page, 'tst_day');
  assert.equal(day.type, 'DateAndTime.DateOnly');
  assert.equal(
    await page.evaluate(() => {
      const raw = window.nativePcf.tst_day.initRaw;
      return `${raw.getFullYear()}-${String(raw.getMonth() + 1).padStart(2, '0')}-${String(raw.getDate()).padStart(2, '0')}`;
    }),
    '2026-11-26',
  );
  await page.evaluate(() => window.nativePcf.tst_day.emit(new Date(2026, 11, 1)));
  await save(page);
  assert.match(String(storedRow(app).tst_day), /^2026-12-01/);
});

test('a date and time component west of UTC reads and saves the instant', async (t) => {
  const columns = [['tst_when', 'datetime']];
  const { app, page, errors } = await openNativePcfSite(t, site(columns), {
    rows: [{ tst_rowid: ROW_ID, tst_title: 'Row', tst_when: '2026-11-26T15:30:00Z' }],
    timezoneId: 'America/New_York',
  });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, 1);
  const when = await probe(page, 'tst_when');
  assert.equal(when.type, 'DateAndTime.DateAndTime');
  assert.equal(when.initRaw.toISOString(), '2026-11-26T15:30:00.000Z');
  await emit(page, 'tst_when', new Date('2026-12-01T18:45:00Z'));
  await save(page);
  assert.equal(instant(storedRow(app).tst_when), '2026-12-01T18:45:00.000Z');
  assert.deepEqual(errors, []);
});

test('a whole-number component in a comma-decimal language reads and saves the number', async (t) => {
  const columns = [['tst_count', 'whole']];
  const { app, page, errors } = await openNativePcfSite(t, site(columns, true), {
    rows: [{ tst_rowid: ROW_ID, tst_title: 'Row', tst_count: 1234 }],
  });
  await page.goto(`${app.url}/?id=${ROW_ID}`);
  await probesReady(page, app, 1);
  assert.equal((await probe(page, 'tst_count')).initRaw, 1234);
  await emit(page, 'tst_count', 4321);
  await save(page);
  assert.equal(Number(storedRow(app).tst_count), 4321);
  assert.deepEqual(errors, []);
});

for (const transport of ['postback', 'json'])
  for (const [kind, column] of [
    ['decimal', 'tst_decimal'],
    ['float', 'tst_float'],
    ['money', 'tst_money'],
  ])
    test(`a ${kind} component in a comma-decimal language reads and saves a fraction (${transport} transport)`, async (t) => {
      const { app, page, errors } = await openNativePcfSite(t, site([[column, kind]], true), {
        rows: [{ tst_rowid: ROW_ID, tst_title: 'Row', [column]: 1.5 }],
        ...(transport === 'json'
          ? { observed: { nativeFormTransport: 'json', evidence: 'invented loopback transport' } }
          : {}),
      });
      await page.goto(`${app.url}/?id=${ROW_ID}`);
      await probesReady(page, app, 1);
      const mounted = await probe(page, column);
      assert.equal(mounted.initRaw, 1.5);
      assert.equal(
        mounted.updates.some((raw) => Number.isNaN(raw)),
        false,
      );
      await emit(page, column, 1234.5);
      await save(page);
      assert.equal(Number(storedRow(app)[column]), 1234.5);
      assert.deepEqual(errors, []);
    });
