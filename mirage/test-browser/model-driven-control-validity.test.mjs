import test from 'node:test';
import assert from 'node:assert/strict';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser, fileScope } from './shared-browser.mjs';

// Every test renders controls into a blank page, so one simulator serves the file.
const chrome = sharedBrowser(), scope = fileScope();
let sharedApp;

async function fixture(t) {
  const { origin } = await (sharedApp ??= modelDrivenFixture(scope));
  const page = await chrome.page(t); await page.goto(origin + '/main.aspx');
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready');
  await page.evaluate(async () => { window.render = (await import('/_apps/assets/controls.mjs')).renderControl; document.body.replaceChildren(); });
  return page;
}

test('choice required validation follows selections while searching and honors later source requirements and notifications', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(() => {
    const control = window.render({ name: 'tags', type: 'multiselect', required: true, options: [{ value: 1, label: 'Red' }, { value: 2, label: 'Blue' }] }, [1]); document.body.append(control.element);
    control.primary.click(); const open = control.primary.checkValidity();
    control.primary.value = 'unmatched'; control.primary.dispatchEvent(new Event('input', { bubbles: true })); const searching = control.primary.checkValidity();
    control.setValue(null); const empty = control.primary.checkValidity();
    control.primary.required = false; const optional = control.primary.checkValidity(); control.primary.required = true;
    control.primary.setCustomValidity('Form notification'); control.setValue([2]); const notification = control.primary.validationMessage;
    control.setDisabled(true); control.setValue([1]); control.setDisabled(false); const restoredNotification = control.primary.validationMessage;
    control.primary.setCustomValidity(''); const valid = control.primary.checkValidity();
    const scalar = window.render({ name: 'kind', type: 'number', required: true, options: [{ value: 1, label: 'One' }] }, null); document.body.append(scalar.element);
    scalar.primary.value = 'fabricated'; const scalarEmpty = scalar.primary.checkValidity(); scalar.setValue(1); const scalarSelected = scalar.primary.checkValidity();
    const boolean = window.render({ name: 'approved', type: 'boolean', required: true }, false); const falseSelected = boolean.primary.checkValidity();
    return { open, searching, empty, optional, notification, restoredNotification, valid, required: control.primary.required, scalarEmpty, scalarSelected, falseSelected };
  });
  assert.deepEqual(result, { open: true, searching: true, empty: false, optional: true, notification: 'Form notification', restoredNotification: 'Form notification', valid: true, required: true, scalarEmpty: false, scalarSelected: true, falseSelected: true });
});

test('date and duration validation recover after disabled value updates without clearing form notifications', async t => {
  const page = await fixture(t);
  const results = await page.evaluate(() => [['date', { type: 'date', dateTimeBehavior: 'DateOnly' }, '2024-02-29'], ['duration', { type: 'number', format: 'duration' }, 60]].map(([name, field, validValue]) => {
    const control = window.render({ name, label: name, ...field }, null); document.body.append(control.element);
    control.primary.value = 'invalid'; control.primary.dispatchEvent(new Event('input')); const invalid = control.primary.checkValidity();
    control.setDisabled(true); control.setValue(validValue); control.setDisabled(false); const recovered = control.primary.checkValidity();
    control.primary.setCustomValidity('Retain notification'); control.setDisabled(true); control.setValue(validValue); control.setDisabled(false); const message = control.primary.validationMessage;
    control.primary.setCustomValidity(''); const cleared = control.primary.checkValidity();
    control.primary.value = 'invalid'; control.primary.dispatchEvent(new Event('input')); control.primary.setCustomValidity('External'); control.primary.setCustomValidity(''); const parserStillInvalid = control.primary.checkValidity();
    return { name, invalid, recovered, message, cleared, parserStillInvalid };
  }));
  assert.deepEqual(results, ['date', 'duration'].map(name => ({ name, invalid: false, recovered: true, message: 'Retain notification', cleared: true, parserStillInvalid: false })));
});

test('disposed choices cannot reopen or select and disposed lookup actions cannot launch another dialog', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(async () => {
    const choice = window.render({ name: 'kind', type: 'number', options: [{ value: 1, label: 'One' }, { value: 2, label: 'Two' }] }, 1); document.body.append(choice.element);
    const option = [...choice.element.querySelectorAll('[role=option]')].find(node => node.getAttribute('aria-label') === 'Two'); choice.destroy(); choice.element.remove(); choice.primary.click(); option.click();
    let launches = 0;
    const lookup = window.render({ name: 'parent', label: 'Parent', type: 'lookup', targets: ['x_item'] }, { id: 'original', entity: 'x_item', name: 'Original' }, { tables: { x_item: {} }, lookup: async () => { launches++; return null; } }); document.body.append(lookup.element);
    lookup.destroy(); lookup.element.remove(); lookup.element.querySelector('[aria-label="Advanced"]').click(); lookup.element.querySelector('[aria-label="Look up Parent"]').click(); lookup.element.querySelector('[aria-label="Clear Parent"]').click(); await Promise.resolve();
    return { choice: choice.read(), expanded: choice.primary.getAttribute('aria-expanded'), launches, lookup: lookup.read() };
  });
  assert.deepEqual(result, { choice: 1, expanded: 'false', launches: 0, lookup: { id: 'original', entity: 'x_item', name: 'Original' } });
});

test('source-authored read-only state text displays its choice label without changing the raw value', async t => {
  const page = await fixture(t);
  const result = await page.evaluate(() => {
    const field = { name: 'statecode', label: 'Status', type: 'number', dataverseType: 'state', options: [{ value: 0, label: 'Active' }, { value: 1, label: 'Inactive' }] };
    const control = window.render(field, 0, { readOnlyText: true }); document.body.append(control.element); const first = { text: control.element.value, value: control.read(), disabled: control.element.disabled };
    control.setValue(1); control.setDisabled(false);
    const pcf = window.render(field, 0, { readOnlyText: true, pcf: { name: 'Untrusted.Sample' } });
    return { first, second: { text: control.element.value, value: control.read(), disabled: control.element.disabled }, comboboxes: control.element.querySelectorAll('[role=combobox]').length, pcf: pcf.element.classList.contains('model-driven-pcf') };
  });
  assert.deepEqual(result, { first: { text: 'Active', value: 0, disabled: true }, second: { text: 'Inactive', value: 1, disabled: true }, comboboxes: 0, pcf: true });
});
