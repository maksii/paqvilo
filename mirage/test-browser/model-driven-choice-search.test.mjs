import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser, fileScope } from './shared-browser.mjs';
import { prepareNativeControls } from './native-controls-fixture.mjs';

const chrome = sharedBrowser();
// Tests that only render controls or read records share one simulator; tests that write own theirs.
const scope = fileScope();
let sharedApp;
const readOnlyApp = () => (sharedApp ??= modelDrivenFixture(scope));

test('multiselect search preserves typed terms and keyboard selection cannot toggle hidden choices', async (t) => {
  const { origin } = await readOnlyApp();
  const page = await chrome.page(t);
  await prepareNativeControls(page, origin);
  await page.evaluate(async () => {
    const renderControl = window.renderFixtureControl;
    window.control = renderControl(
      {
        name: 'x_tags',
        label: 'Tags',
        type: 'multiselect',
        options: [
          { value: 1, label: 'Red' },
          { value: 2, label: 'Blue' },
          { value: 3, label: 'Black' },
        ],
      },
      [1],
    );
    document.body.replaceChildren(window.control.element);
  });
  const input = page.getByRole('combobox', { name: 'Tags', exact: true });
  await input.focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('B');
  assert.equal(await input.inputValue(), 'B');
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['Select all3 items', 'Blue', 'Black']);
  await input.fill('Blue');
  const active = await input.getAttribute('aria-activedescendant');
  assert.equal(await page.locator(`[id="${active}"]`).getAttribute('aria-label'), 'Blue');
  await input.press('ArrowDown');
  assert.equal(await input.inputValue(), 'Blue');
  await input.press('Enter');
  assert.deepEqual(
    await page.evaluate(() => window.control.read()),
    [1, 2],
    'keyboard selection must select the visible match while preserving Red',
  );
  assert.equal(await input.inputValue(), 'Blue');
  await input.fill('no matches');
  assert.equal(await input.getAttribute('aria-activedescendant'), null);
  await input.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.control.read()), [1, 2]);
  await input.press('Escape');
  assert.equal(await input.inputValue(), 'Red; Blue');
  assert.equal(await input.getAttribute('aria-activedescendant'), null);
  await input.click();
  await input.fill('Black');
  await page.getByRole('option', { name: 'Black', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.control.read()), [1, 2, 3]);
  await page.evaluate(() => window.control.setDisabled(true));
  assert.equal(await input.getAttribute('aria-expanded'), 'false');
  assert.equal(await input.getAttribute('aria-activedescendant'), null);
  assert.equal(await input.isDisabled(), true);
});

test('choice lists stay inside the form viewport and keyboard navigation scrolls only their options', async (t) => {
  const { origin } = await readOnlyApp();
  const page = await chrome.page(t, { viewport: { width: 1000, height: 700 } });
  await prepareNativeControls(page, origin);
  await page.evaluate(async () => {
    const renderControl = window.renderFixtureControl;
    document.body.replaceChildren();
    const root = document.createElement('div');
    root.className = 'record-content';
    root.style.cssText = 'position:absolute;inset:70px 40px 30px;overflow:auto;display:block';
    const header = document.createElement('div');
    header.className = 'record-card';
    header.style.cssText = 'position:sticky;top:0;height:100px;background:white';
    const filler = document.createElement('div');
    filler.style.height = '370px';
    const field = document.createElement('div');
    field.className = 'field';
    field.style.cssText = 'display:block;margin:0;height:32px';
    window.control = renderControl(
      {
        name: 'x_rank',
        label: 'Rank',
        type: 'number',
        options: Array.from({ length: 40 }, (_, index) => ({ value: index, label: `Choice ${index}` })),
      },
      0,
    );
    field.append(window.control.element);
    root.append(header, filler, field);
    document.body.append(root);
  });
  const input = page.getByRole('combobox', { name: 'Rank', exact: true });
  await input.click();
  const geometry = () =>
    page.evaluate(() => {
      const root = document.querySelector('.record-content'),
        list = document.querySelector('.choice-options'),
        rect = list.getBoundingClientRect();
      return {
        top: rect.top,
        bottom: rect.bottom,
        headerBottom: root.querySelector('.record-card').getBoundingClientRect().bottom,
        boundary: root.getBoundingClientRect().bottom,
        fieldTop: window.control.element.getBoundingClientRect().top,
        scrollTop: root.scrollTop,
        listScroll: list.scrollTop,
      };
    });
  const before = await geometry();
  assert.ok(
    before.top >= before.headerBottom && before.bottom <= before.boundary,
    'popup must avoid the pinned header and remain inside the form',
  );
  assert.equal(await page.locator('.choice-options').evaluate((node) => node.classList.contains('above')), true);
  await input.press('End');
  const after = await geometry();
  assert.equal(after.scrollTop, before.scrollTop);
  assert.equal(after.fieldTop, before.fieldTop);
  assert.ok(after.listScroll > before.listScroll, 'End must reveal the final option inside the bounded list');
  await input.press('Enter');
  assert.equal(await page.evaluate(() => window.control.read()), 39);
  assert.equal(await input.inputValue(), 'Choice 39');
  await input.click();
  await input.press('Home');
  await input.press('Enter');
  assert.equal(
    await page.evaluate(() => window.control.read()),
    null,
    'the empty choice remains keyboard selectable after reopening',
  );
  await input.click();
  await page.setViewportSize({ width: 980, height: 680 });
  await page.waitForFunction(() => window.control.primary.getAttribute('aria-expanded') === 'false');
  assert.equal(
    await input.getAttribute('aria-expanded'),
    'false',
    'viewport changes dismiss the obsolete popup position',
  );
  await input.click();
  await page.locator('.record-content').evaluate((root) => {
    const trailing = document.createElement('div');
    trailing.style.height = '1000px';
    root.append(trailing);
    root.scrollTop = 30;
  });
  await page.waitForFunction(() => window.control.primary.getAttribute('aria-expanded') === 'false');
});
