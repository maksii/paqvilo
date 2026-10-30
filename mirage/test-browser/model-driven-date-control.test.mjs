import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser, fileScope } from './shared-browser.mjs';
import { prepareNativeControls } from './native-controls-fixture.mjs';

const chrome = sharedBrowser();
// Control-only tests render into one shared simulator page origin; saved-record tests own theirs.
const scope = fileScope();
let sharedApp;

async function fixture(t, { timezoneId = 'America/New_York' } = {}) {
  const { origin } = await (sharedApp ??= modelDrivenFixture(scope));
  const page = await chrome.page(t, { timezoneId, viewport: { width: 1200, height: 900 } });
  await prepareNativeControls(page, origin);
  await page.evaluate(async () => {
    const renderControl = window.renderFixtureControl;
    document.body.replaceChildren();
    const form = document.createElement('form');
    form.style.width = '900px';
    form.style.margin = '80px 40px';
    window.fields = {};
    window.submits = 0;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      window.submits++;
    });
    for (const [name, label, behavior, value] of [
      ['due', 'Due date', 'DateOnly', '2024-01-31'],
      ['independent', 'Independent', 'TimeZoneIndependent', '2026-06-15T14:30:00Z'],
      ['local', 'Local', 'UserLocal', '2026-06-15T14:30:00Z'],
    ]) {
      const field = { name, label, type: 'date', dateTimeBehavior: behavior, required: name === 'due' };
      const control = renderControl(field, value),
        wrapper = document.createElement('div');
      wrapper.className = 'field';
      wrapper.style.marginBottom = '20px';
      const caption = document.createElement('label');
      caption.htmlFor = `field-${name}`;
      caption.textContent = label;
      wrapper.append(caption, control.element);
      form.append(wrapper);
      window.fields[name] = control;
    }
    const outside = document.createElement('button');
    outside.type = 'button';
    outside.textContent = 'Outside';
    form.append(outside);
    document.body.append(form);
  });
  return page;
}

test('calendar matches the observed two-pane geometry and selects leap days without submitting the form', async (t) => {
  const page = await fixture(t);
  await page.getByRole('button', { name: 'Open calendar for Due date', exact: true }).click();
  const calendar = page.getByRole('dialog', { name: 'Calendar', exact: true });
  const geometry = await calendar.evaluate((element) => {
    const rect = element.getBoundingClientRect(),
      style = getComputedStyle(element);
    return {
      width: rect.width,
      height: rect.height,
      radius: style.borderRadius,
      background: style.backgroundColor,
      shadow: style.boxShadow,
    };
  });
  assert.deepEqual(geometry, {
    width: 442,
    height: 254,
    radius: '4px',
    background: 'rgb(255, 255, 255)',
    shadow: 'rgba(0, 0, 0, 0.12) 0px 0px 2px 0px, rgba(0, 0, 0, 0.14) 0px 8px 16px 0px',
  });
  assert.equal(
    await calendar
      .getByRole('button', { name: 'January', exact: true })
      .evaluate((node) => node.getBoundingClientRect().width),
    40,
  );
  await calendar.getByRole('button', { name: 'Navigate to next month February', exact: true }).click();
  const leap = calendar.getByRole('button', { name: '29, February, 2024', exact: true });
  assert.deepEqual(
    await leap.evaluate((node) => [
      node.getBoundingClientRect().width,
      node.getBoundingClientRect().height,
      getComputedStyle(node).fontSize,
    ]),
    [24, 24, '12px'],
  );
  await leap.click();
  assert.equal(await page.getByRole('combobox', { name: 'Due date', exact: true }).inputValue(), '2/29/2024');
  assert.equal(await page.evaluate(() => window.fields.due.read()), '2024-02-29');
  assert.equal(await page.evaluate(() => window.submits), 0);
  await page.getByRole('button', { name: 'Open calendar for Due date', exact: true }).click();
  await calendar.getByRole('button', { name: 'Navigate to previous year 2023', exact: true }).click();
  await calendar.getByRole('button', { name: 'February', exact: true }).click();
  assert.equal(await calendar.getByRole('button', { name: '29, February, 2023', exact: true }).count(), 0);
  await calendar.getByRole('button', { name: '28, February, 2023', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fields.due.read()), '2023-02-28');
  await page.getByRole('button', { name: 'Open calendar for Due date', exact: true }).click();
  await calendar
    .getByRole('button', { name: 'Month picker for year 2023, select to switch to year picker', exact: true })
    .click();
  await calendar
    .getByRole('button', { name: 'Year picker 2023 - 2034, select to switch to month picker', exact: true })
    .waitFor();
  await calendar.getByRole('button', { name: 'Navigate to next year range 2035 - 2046', exact: true }).click();
  await calendar.getByRole('button', { name: '2036', exact: true }).click();
  await calendar.getByRole('button', { name: 'February', exact: true }).click();
  await calendar.getByRole('button', { name: '29, February, 2036', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fields.due.read()), '2036-02-29');
});

test('calendar keyboard month/year navigation clamps dates and Escape restores focus without changes', async (t) => {
  const page = await fixture(t);
  const input = page.getByRole('combobox', { name: 'Due date', exact: true });
  await input.focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('PageDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), '2024-02-29');
  await page.keyboard.press('Shift+PageDown');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), '2025-02-28');
  await page.keyboard.press('Home');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), '2025-02-23');
  await page.keyboard.press('End');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.date), '2025-03-01');
  await page.keyboard.press('Escape');
  assert.equal(await input.evaluate((node) => node === document.activeElement), true);
  assert.equal(await input.getAttribute('aria-expanded'), 'false');
  assert.equal(await page.evaluate(() => window.fields.due.read()), '2024-01-31');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => window.submits), 0);
});

test('calendar validates typed dates, clears optional values and rejects disabled or disposed selections', async (t) => {
  const page = await fixture(t);
  const input = page.getByRole('combobox', { name: 'Due date', exact: true });
  await input.fill('2/29/2023');
  await page.getByRole('button', { name: 'Outside', exact: true }).click();
  assert.equal(await input.evaluate((node) => node.checkValidity()), false);
  for (const value of ['2026-02-28Tgarbage', '2026-02-28T12:30', '4/31/2024']) {
    await input.fill(value);
    await page.getByRole('button', { name: 'Outside', exact: true }).click();
    assert.equal(await input.evaluate((node) => node.checkValidity()), false);
  }
  await input.fill('2024-02-29');
  await page.getByRole('button', { name: 'Outside', exact: true }).click();
  assert.equal(await input.inputValue(), '2/29/2024');
  assert.equal(await input.evaluate((node) => node.checkValidity()), true);
  await page.getByRole('button', { name: 'Open calendar for Due date', exact: true }).click();
  await page.evaluate(() => {
    window.retainedDate = document.querySelector('[data-date="2024-02-28"]');
    window.fields.due.setDisabled(true);
  });
  await page.evaluate(() => window.retainedDate.click());
  assert.equal(await page.evaluate(() => window.fields.due.read()), '2024-02-29');
  assert.equal(await input.isDisabled(), true);
  assert.equal(await input.getAttribute('aria-expanded'), 'false');
  assert.equal(
    await page.locator('.date-input>button').first().isVisible(),
    false,
    'disabled date fields omit the native calendar affordance',
  );
  await page.evaluate(() => {
    window.fields.due.setDisabled(false);
    window.fields.due.destroy();
  });
  await page.getByRole('button', { name: 'Open calendar for Due date', exact: true }).click();
  assert.equal(await input.getAttribute('aria-expanded'), 'false');
  await page.evaluate(() => window.fields.local.setDisabled(true));
  assert.equal(
    await page.locator('.date-time-host>button').last().isVisible(),
    false,
    'disabled date/time fields omit the time affordance',
  );
  await page.evaluate(() => window.fields.local.setDisabled(false));
  assert.equal(
    await page.locator('.date-time-host>button').last().isVisible(),
    true,
    'client unlock restores the supported affordance',
  );
  const local = page.getByRole('combobox', { name: 'Local', exact: true });
  await local.fill('');
  await page.getByRole('button', { name: 'Outside', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fields.local.read()), null);
  assert.equal(await page.getByRole('combobox', { name: 'Local Time', exact: true }).isVisible(), false);
});

test('calendar clamps its actual responsive width into the viewport in either form column', async (t) => {
  const page = await fixture(t);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => {
    const form = document.querySelector('form');
    form.style.width = '350px';
    form.style.margin = '20px';
    const wrappers = [...form.querySelectorAll('.field')];
    for (const wrapper of wrappers) {
      wrapper.style.display = 'block';
      wrapper.style.width = '140px';
    }
    wrappers[1].style.marginLeft = '210px';
  });
  for (const name of ['Due date', 'Independent']) {
    await page.getByRole('button', { name: `Open calendar for ${name}`, exact: true }).click();
    const rect = await page.getByRole('dialog', { name: 'Calendar', exact: true }).evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, width: rect.width };
    });
    assert.equal(rect.width, 222);
    assert.ok(rect.left >= 8 && rect.right <= 382, JSON.stringify(rect));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 390);
    await page.keyboard.press('Escape');
  }
});

test('date-time controls preserve independent wall time, convert user-local values, validate time edits and keep date-only calendar dates', async (t) => {
  const page = await fixture(t);
  assert.equal(await page.getByRole('combobox', { name: 'Independent Time', exact: true }).inputValue(), '2:30 PM');
  assert.equal(await page.getByRole('combobox', { name: 'Local Time', exact: true }).inputValue(), '10:30 AM');
  assert.deepEqual(await page.evaluate(() => [window.fields.independent.read(), window.fields.local.read()]), [
    '2026-06-15T14:30:00.000Z',
    '2026-06-15T14:30:00.000Z',
  ]);
  const local = page.getByRole('combobox', { name: 'Local', exact: true }),
    time = page.getByRole('combobox', { name: 'Local Time', exact: true });
  await local.fill('2/29/2024');
  await time.fill('23:45');
  await time.press('Enter');
  assert.equal(await time.inputValue(), '11:45 PM');
  assert.equal(await page.evaluate(() => window.fields.local.read()), '2024-03-01T04:45:00.000Z');
  await time.fill('24:00');
  await time.press('Tab');
  assert.equal(await time.evaluate((node) => node.checkValidity()), false);
  await time.fill('12:00 AM');
  await time.press('Enter');
  assert.equal(await page.evaluate(() => window.fields.local.read()), '2024-02-29T05:00:00.000Z');
  await page.evaluate(() => window.fields.independent.setValue('2024-02-29T23:45:00Z'));
  assert.equal(await page.getByRole('combobox', { name: 'Independent', exact: true }).inputValue(), '2/29/2024');
  assert.equal(await page.evaluate(() => window.fields.independent.read()), '2024-02-29T23:45:00.000Z');
  assert.equal(await page.evaluate(() => window.submits), 0);
  const dateOnly = await page.evaluate(async () => {
    const renderControl = window.renderFixtureControl;
    const control = renderControl(
      { name: 'x_date', type: 'date', dateTimeBehavior: 'DateOnly' },
      '2026-06-15T14:30:00Z',
    );
    return {
      input: control.primary.value,
      time: control.element.querySelector('.date-time-input')?.value,
      value: control.read(),
    };
  });
  assert.deepEqual(
    dateOnly,
    { input: '6/15/2026', time: undefined, value: '2026-06-15' },
    'a date-only control keeps the stored calendar date of a timestamp',
  );
});

test('calendar stays inside a scrolled record body below its pinned header and dismisses before scrolling under it', async (t) => {
  const page = await fixture(t);
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => {
    const form = document.querySelector('form'),
      scroll = document.createElement('div'),
      header = document.createElement('div');
    scroll.id = 'record-test';
    scroll.className = 'record-content';
    Object.assign(scroll.style, {
      height: '560px',
      width: '1100px',
      overflow: 'auto',
      marginTop: '160px',
      padding: '0',
    });
    header.className = 'record-card';
    header.style.height = '120px';
    header.textContent = 'Pinned record header';
    form.style.margin = '0';
    form.style.width = '100%';
    form.querySelector('.field').style.paddingTop = '170px';
    const spacer = document.createElement('div');
    spacer.style.height = '1000px';
    scroll.append(header, form, spacer);
    document.body.replaceChildren(scroll);
  });
  await page.getByRole('button', { name: 'Open calendar for Due date', exact: true }).click();
  const calendar = page.getByRole('dialog', { name: 'Calendar', exact: true });
  const bounds = await calendar.evaluate((node) => {
    const root = document.querySelector('#record-test'),
      header = root.querySelector('.record-card'),
      popup = node.getBoundingClientRect();
    return {
      top: popup.top,
      bottom: popup.bottom,
      header: header.getBoundingClientRect().bottom,
      content: root.getBoundingClientRect().bottom,
      scroll: root.scrollTop,
    };
  });
  assert.ok(bounds.top >= bounds.header && bounds.bottom <= bounds.content, JSON.stringify(bounds));
  assert.ok(bounds.scroll > 0, 'opening at the midpoint scrolls enough to fit a whole calendar');
  await page.evaluate(() => {
    document.querySelector('#record-test').scrollTop += 300;
  });
  await calendar.waitFor({ state: 'hidden' });
  assert.equal(
    await page.getByRole('combobox', { name: 'Due date', exact: true }).getAttribute('aria-expanded'),
    'false',
  );
});

test('time choices use the observed half-hour list while retaining arbitrary typed times and calendar focus lifecycle', async (t) => {
  const page = await fixture(t),
    time = page.getByRole('combobox', { name: 'Local Time', exact: true });
  const before = await page.evaluate(() => window.fields.local.read());
  await page.getByRole('button', { name: 'Open time options for Local', exact: true }).click();
  const options = page.getByRole('listbox', { name: 'Time options for Local', exact: true });
  assert.equal(await options.getByRole('option').count(), 48);
  assert.equal(
    await options.getByRole('option', { name: '10:30 AM', exact: true }).getAttribute('aria-selected'),
    'true',
  );
  const geometry = await options.evaluate((node) => {
    const rect = node.getBoundingClientRect(),
      row = node.firstElementChild;
    return {
      top: rect.top,
      bottom: rect.bottom,
      width: rect.width,
      host: document.querySelector('[aria-label="Local Time"]').parentElement.getBoundingClientRect().width,
      row: row.getBoundingClientRect().height,
      padding: getComputedStyle(row).padding,
      font: getComputedStyle(row).fontSize,
    };
  });
  assert.ok(geometry.top >= 0 && geometry.bottom <= 900, JSON.stringify(geometry));
  assert.equal(geometry.width, geometry.host);
  assert.equal(geometry.row, 32);
  assert.equal(geometry.font, '14px');
  await time.press('End');
  await time.press('Enter');
  assert.equal(await time.inputValue(), '11:30 PM');
  assert.equal(await page.evaluate(() => window.fields.local.read()), '2026-06-16T03:30:00.000Z');
  assert.equal(await options.count(), 0);
  assert.equal(await time.evaluate((node) => node === document.activeElement), true);
  await time.fill('11:47 PM');
  await time.press('Enter');
  assert.equal(
    await page.evaluate(() => window.fields.local.read()),
    '2026-06-16T03:47:00.000Z',
    'typed minute precision is independent of the half-hour options',
  );
  await time.press('ArrowDown');
  await time.press('Escape');
  assert.equal(await page.evaluate(() => window.fields.local.read()), '2026-06-16T03:47:00.000Z');
  await time.press('ArrowDown');
  await page.getByRole('button', { name: 'Open calendar for Local', exact: true }).click();
  assert.equal(await options.count(), 0);
  await page.keyboard.press('Escape');
  await time.press('ArrowDown');
  await page.evaluate(() => window.fields.local.setDisabled(true));
  assert.equal(await options.count(), 0);
  await page.evaluate(() => {
    window.fields.local.setDisabled(false);
    window.fields.local.setValue('2026-06-15T14:30:00Z');
  });
  assert.equal(await page.evaluate(() => window.fields.local.read()), before);
  await time.press('ArrowDown');
  await page.evaluate(() => {
    window.oldTimeOption = document.querySelector('.date-time-options [role=option]');
    window.fields.local.destroy();
    window.oldTimeOption.click();
  });
  assert.equal(await options.count(), 0);
  assert.equal(await page.evaluate(() => window.fields.local.read()), before);
  assert.equal(await page.evaluate(() => window.submits), 0);
});

// Preserve evidence when a saved-record page fails to boot or render its date control.
function savedPageDiagnostics(page) {
  const events = [],
    metadata = [];
  page.on('pageerror', (error) => events.push({ type: 'pageerror', message: error.message }));
  page.on('console', (message) => {
    if (message.type() === 'error') events.push({ type: 'console', message: message.text() });
  });
  page.on('requestfailed', (request) =>
    events.push({
      type: 'requestfailed',
      path: new URL(request.url()).pathname,
      failure: request.failure()?.errorText,
    }),
  );
  page.on('response', (response) => {
    const pathname = new URL(response.url()).pathname;
    if (!pathname.startsWith('/_apps/') && !['/_sim/api/dataverse/session', '/_sim/api/status'].includes(pathname))
      return;
    events.push({ type: 'response', path: pathname, status: response.status() });
    if (pathname === '/_apps/api/metadata/x_item')
      response
        .text()
        .then((body) => metadata.push(body.slice(0, 12000)))
        .catch((error) => events.push({ type: 'metadata-read', message: error.message }));
  });
  return async () => ({
    events,
    metadata,
    page: await page
      .evaluate(() => ({
        state: document.documentElement.dataset.mirageAppState,
        notice: document.querySelector('#notice')?.textContent,
        body: document.body?.innerText.slice(0, 4000),
        controls: [...document.querySelectorAll('[role=combobox]')].map((element) => ({
          label: element.getAttribute('aria-label'),
          value: element.value,
          hidden: element.hidden,
        })),
      }))
      .catch((error) => ({ error: error.message })),
  });
}

for (const kind of ['portal', 'model-driven'])
  test(`saved UserLocal controls honor an explicit organization offset independently of the PCF browser zone in ${kind}`, async (t) => {
    const { sim, origin, solutionDir } = await modelDrivenFixture(
      t,
      kind === 'model-driven' ? { runtime: { kind }, sourceDir: undefined } : {},
    );
    const entityFile = path.join(solutionDir, 'Entities/x_item/Entity.xml'),
      formFile = path.join(solutionDir, 'Entities/x_item/FormXml/main/item.xml');
    await fs.writeFile(
      entityFile,
      (await fs.readFile(entityFile, 'utf8')).replace(
        '</attributes>',
        '<attribute PhysicalName="x_appointment"><Name>x_appointment</Name><Type>datetime</Type><Format>datetime</Format><Behavior>1</Behavior><displaynames><displayname description="Appointment" languagecode="1033"/></displaynames></attribute></attributes>',
      ),
    );
    await fs.writeFile(
      formFile,
      (await fs.readFile(formFile, 'utf8')).replace(
        '<control id="unimplemented"/>',
        '<control datafieldname="x_appointment"/>',
      ),
    );
    await sim.reload();
    await sim.store.transact(() => {
      sim.store.state.settings.timeZoneOffsetMinutes = 0;
      sim.store.state.tables.x_item[0].x_appointment = '2026-10-22T09:30:00Z';
    });
    const page = await chrome.page(t, { timezoneId: 'Europe/Kyiv' });
    const evidence = savedPageDiagnostics(page);
    try {
      await page.goto(
        origin +
          '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      const time = page.getByRole('combobox', { name: 'Appointment Time', exact: true });
      await time.waitFor();
      assert.equal(
        await time.inputValue(),
        '9:30 AM',
        'the configured staff offset takes precedence over browser Kyiv time',
      );
      assert.equal(
        await page.evaluate(() => new Date('2026-10-22T09:30:00Z').getHours()),
        12,
        'source PCFs still receive their actual browser environment',
      );
      await time.fill('10:47 AM');
      await time.press('Enter');
      await page.getByRole('button', { name: 'Save', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
      const saved = await (
        await fetch(origin + '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
      ).json();
      assert.equal(new Date(saved.row.x_appointment).toISOString(), '2026-10-22T10:47:00.000Z');
      await page.reload();
      await time.waitFor();
      assert.equal(await time.inputValue(), '10:47 AM');
    } catch (error) {
      t.diagnostic(`Saved-record page evidence (${kind}): ${JSON.stringify(await evidence())}`);
      throw error;
    }
  });
