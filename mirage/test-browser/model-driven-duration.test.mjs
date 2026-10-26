import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { sharedBrowser, fileScope } from './shared-browser.mjs';

const chrome = sharedBrowser();
// Tests that only render controls or read records share one simulator; tests that write own theirs.
const scope = fileScope();
let sharedApp;
const readOnlyApp = () => (sharedApp ??= modelDrivenFixture(scope));

test('duration choices and typed units preserve numeric minutes, keyboard focus and validation', async (t) => {
  const { origin } = await readOnlyApp();
  const page = await chrome.page(t, { viewport: { width: 1582, height: 1000 } });
  await page.goto(origin + '/main.aspx');
  await page.evaluate(async () => {
    const { renderControl } = await import('/_apps/assets/controls.mjs');
    const form = document.createElement('form');
    form.innerHTML = '<div class="field"></div><button type="button" id="next">Next</button>';
    document.body.replaceChildren(form);
    window.control = renderControl(
      {
        name: 'x_duration',
        label: 'Duration',
        type: 'number',
        dataverseType: 'int',
        format: 'duration',
        required: true,
        minValue: 15,
        maxValue: 2880,
      },
      90,
    );
    form.querySelector('.field').append(window.control.element);
  });
  const input = page.getByRole('combobox', { name: 'Duration', exact: true });
  assert.equal(await input.inputValue(), '1.5 hours');
  await input.click();
  assert.equal(
    await input.getAttribute('aria-expanded'),
    'true',
    'clicking the field opens the native duration choices',
  );
  await input.press('Escape');
  assert.equal(await input.getAttribute('aria-expanded'), 'false');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  await input.focus();
  assert.equal(await input.getAttribute('aria-expanded'), 'false', 'keyboard focus alone leaves the editor closed');
  await input.focus();
  await input.press('ArrowDown');
  const list = page.getByRole('listbox', { name: 'Duration duration options', exact: true });
  assert.equal(await list.getByRole('option', { name: '1 minute', exact: true }).getAttribute('aria-disabled'), 'true');
  assert.equal(await list.getByRole('option').count(), 22);
  await input.press('ArrowDown');
  await input.press('Enter');
  assert.equal(await input.inputValue(), '2 hours');
  assert.equal(await page.evaluate(() => window.control.read()), 120);
  assert.equal(await input.evaluate((node) => document.activeElement === node), true);
  assert.equal(await input.getAttribute('aria-activedescendant'), null);
  await input.fill('2 days');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  assert.equal(await page.evaluate(() => window.control.read()), 2880);
  assert.equal(await input.inputValue(), '2 days');
  await input.fill('abc');
  await page.getByRole('button', { name: 'Next', exact: true }).click();
  assert.equal(await input.evaluate((node) => node.checkValidity()), false);
  assert.match(await page.getByRole('alert').textContent(), /duration must be entered/);
  await input.fill('5000 minutes');
  assert.equal(await input.evaluate((node) => node.checkValidity()), false);
  assert.match(await input.evaluate((node) => node.validationMessage), /no greater than 2 days/);
  await input.fill('5 minutes');
  assert.match(await input.evaluate((node) => node.validationMessage), /at least 15 minutes/);
  await page.getByRole('button', { name: 'Clear Duration', exact: true }).click();
  assert.equal(await input.inputValue(), '');
  assert.equal(await page.evaluate(() => window.control.read()), null);
  assert.equal(
    await input.evaluate((node) => node.checkValidity()),
    false,
    'clearing a required duration preserves required validation',
  );
  await page.evaluate(() => window.control.setValue(73));
  assert.equal(
    await page.evaluate(() => window.control.read()),
    73,
    'formatting must not round the stored whole minutes',
  );
  await page.getByRole('button', { name: 'Open duration options for Duration', exact: true }).click();
  await page.evaluate(() => window.control.setDisabled(true));
  assert.equal(await input.getAttribute('aria-expanded'), 'false');
  assert.equal(await input.isDisabled(), true);
  assert.equal(await page.locator('.duration-trigger').isDisabled(), true);
  assert.equal(await page.locator('.duration-trigger').isVisible(), false);
  assert.equal(await page.locator('.duration-clear').isVisible(), false);
  assert.equal(await page.evaluate(() => window.control.read()), 73);
  await page.evaluate(() => window.control.setDisabled(false));
  assert.equal(await page.locator('.duration-trigger').isVisible(), true);
  await page.locator('.duration-trigger').click();
  assert.equal(await input.getAttribute('aria-expanded'), 'true');
});

test('exported duration formats create the duration control and save whole minutes through the staff API', async (t) => {
  const source = await modelDrivenFixture(t);
  await source.sim.close();
  const file = path.join(source.solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(
    file,
    (await fs.readFile(file, 'utf8')).replace(
      '<Type>int</Type>',
      '<Type>int</Type><Format>duration</Format><MinValue>0</MinValue><MaxValue>20160</MaxValue>',
    ),
  );
  const sim = await source.start();
  ownedFixture(t).add(() => sim.close());
  const origin = sim.origin ?? sim.url;
  const page = await chrome.page(t);
  await page.goto(
    origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  const duration = page.getByRole('combobox', { name: 'Quantity', exact: true });
  await duration.waitFor();
  assert.equal(await duration.inputValue(), '2 minutes');
  await duration.fill('3 minutes');
  await page.getByLabel('Name', { exact: true }).focus();
  await duration.fill('1.5 minutes');
  await page.getByLabel('Name', { exact: true }).focus();
  assert.equal(
    await duration.inputValue(),
    '2 minutes',
    'fractional minutes round to whole minutes like the native control',
  );
  await duration.fill('123 minutes');
  await page.getByLabel('Name', { exact: true }).focus();
  assert.equal(await duration.inputValue(), '2.05 hours');
  await page.getByRole('button', { name: 'Open duration options for Quantity', exact: true }).click();
  await page.getByRole('option', { name: '1.5 hours', exact: true }).click();
  await duration.fill('90');
  await page.getByLabel('Name', { exact: true }).focus();
  assert.equal(
    await duration.inputValue(),
    '90',
    'a no-op minute entry retains its typed text like the native control',
  );
  await duration.fill('90 minutes');
  await page.getByLabel('Name', { exact: true }).focus();
  assert.equal(await duration.inputValue(), '90 minutes');
  await duration.fill('1.5 hours');
  const submitted = page.waitForRequest(
    (request) =>
      request.method() === 'PATCH' &&
      new URL(request.url()).pathname === '/_apps/api/tables/x_item/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await submitted).postDataJSON().x_quantity, 90);
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  await page.reload();
  await duration.waitFor();
  assert.equal(await duration.inputValue(), '1.5 hours');
});

test('opening duration below a sticky form header restores the field and full popup while keyboard scrolling stays inside the list', async (t) => {
  const { origin } = await readOnlyApp();
  const page = await chrome.page(t, { viewport: { width: 1582, height: 1000 } });
  await page.goto(origin + '/main.aspx');
  await page.evaluate(async () => {
    const { renderControl } = await import('/_apps/assets/controls.mjs');
    document.body.replaceChildren();
    const root = document.createElement('div');
    root.className = 'record-content';
    root.style.cssText = 'position:absolute;inset:70px 40px 30px;overflow:auto;display:block';
    const header = document.createElement('div');
    header.className = 'record-card';
    header.style.cssText = 'position:sticky;top:0;height:140px;background:white;z-index:20';
    const filler = document.createElement('div');
    filler.style.height = '500px';
    const field = document.createElement('div');
    field.className = 'field';
    field.style.cssText = 'display:block;margin:0';
    window.control = renderControl(
      { name: 'x_duration', label: 'Duration', type: 'number', dataverseType: 'int', format: 'duration' },
      90,
    );
    field.append(window.control.element);
    const trailing = document.createElement('div');
    trailing.style.height = '1000px';
    root.append(header, filler, field, trailing);
    document.body.append(root);
    root.scrollTop = 550;
    window.control.primary.focus({ preventScroll: true });
  });
  const input = page.getByRole('combobox', { name: 'Duration', exact: true });
  await input.press('ArrowDown');
  const geometry = () =>
    page.evaluate(() => {
      const root = document.querySelector('.record-content'),
        field = window.control.element.getBoundingClientRect(),
        popup = document.querySelector('.duration-options').getBoundingClientRect();
      return {
        top: field.top,
        bottom: field.bottom,
        popupTop: popup.top,
        popupBottom: popup.bottom,
        popupHeight: popup.height,
        headerBottom: root.querySelector('.record-card').getBoundingClientRect().bottom,
        boundary: root.getBoundingClientRect().bottom,
        scrollTop: root.scrollTop,
        listScroll: document.querySelector('.duration-options').scrollTop,
      };
    });
  await page.waitForFunction(() => window.control.primary.getAttribute('aria-expanded') === 'true');
  const opened = await geometry();
  assert.ok(
    opened.top >= opened.headerBottom + 7 && opened.popupTop >= opened.bottom,
    'field and options belong below the sticky header',
  );
  assert.equal(opened.popupHeight, 450);
  assert.ok(opened.popupBottom <= opened.boundary);
  await input.press('End');
  const end = await geometry();
  assert.equal(end.scrollTop, opened.scrollTop);
  assert.equal(end.top, opened.top);
  assert.ok(end.listScroll > opened.listScroll);
  await input.press('Enter');
  assert.equal(await page.evaluate(() => window.control.read()), 4320);
  await input.click();
  await page.getByRole('listbox', { name: 'Duration duration options', exact: true }).waitFor();
  assert.equal(await input.getAttribute('aria-expanded'), 'true', 'mouse opening survives queued focus scrolling');
});
