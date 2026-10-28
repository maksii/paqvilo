import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';
import { prepareNativeControls } from './native-controls-fixture.mjs';

const chrome = sharedBrowser();

test('control-only fixture focus never starts requests from a discarded application shell', async (t) => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t);
  page.setDefaultTimeout(5000);
  await prepareNativeControls(page, origin);
  const requested = await page.evaluate(() => {
    const requested = [],
      original = window.fetch;
    window.fetch = (input, ...args) => {
      requested.push(new URL(input instanceof Request ? input.url : String(input), location.href).pathname);
      return original.call(window, input, ...args);
    };
    const date = window.renderFixtureControl(
      { name: 'due', label: 'Due date', type: 'date', dateTimeBehavior: 'DateOnly' },
      '2024-01-31',
    );
    const duration = window.renderFixtureControl(
      { name: 'duration', label: 'Duration', type: 'number', dataverseType: 'int', format: 'duration' },
      90,
    );
    document.body.replaceChildren(date.element, duration.element);
    window.dispatchEvent(new Event('focus'));
    return requested;
  });
  assert.deepEqual(requested, [], 'standalone controls must not retain the removed shell focus handler');
  await page.getByRole('button', { name: 'Open calendar for Due date', exact: true }).click();
  await page.getByRole('dialog', { name: 'Calendar', exact: true }).waitFor();
  await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('combobox', { name: 'Due date', exact: true }).inputValue(), '1/31/2024');
  const duration = page.getByRole('combobox', { name: 'Duration', exact: true });
  assert.equal(await duration.inputValue(), '1.5 hours');
  await duration.press('ArrowDown');
  await page.getByRole('listbox', { name: 'Duration duration options', exact: true }).waitFor();
});
