import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser, fileScope } from './shared-browser.mjs';

const chrome = sharedBrowser();
// Tests that only render controls or read records share one simulator; tests that write own theirs.
const scope = fileScope();
let sharedApp;
const readOnlyApp = () => (sharedApp ??= modelDrivenFixture(scope));

test('model-driven choice fields preserve typed values, required validation, keyboard selection and disabled state', async t => {
  const { origin } = await readOnlyApp();
  const page = await chrome.page(t); page.setDefaultTimeout(5000);
  await page.goto(origin + '/main.aspx');
  await page.evaluate(async () => {
    const { renderControl } = await import('/_apps/assets/controls.mjs');
    document.body.replaceChildren(); const form = document.createElement('form'); document.body.append(form);
    window.changes = []; window.fields = {};
    for (const [field, value] of [
      [{ name: 'x_kind', label: 'Kind', type: 'number', required: true, options: [{ value: 3, label: 'Bronze' }, { value: 7, label: 'Gold' }] }, null],
      [{ name: 'x_enabled', label: 'Enabled', type: 'boolean', options: [{ value: 1, label: 'Available' }, { value: 0, label: 'Unavailable' }] }, false],
      [{ name: 'x_tags', label: 'Tags', type: 'text', dataverseType: 'multiselectpicklist', options: [{ value: 2, label: 'Red' }, { value: 5, label: 'Blue' }] }, '2,5'],
    ]) { const control = renderControl(field, value); window.fields[field.name] = control; form.append(control.element); }
    form.addEventListener('change', event => window.changes.push(event.target.name));
  });
  assert.equal(await page.locator('form').evaluate(form => form.checkValidity()), false);
  const kind = page.getByRole('combobox', { name: 'Kind', exact: true });
  await kind.focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await kind.inputValue(), 'Gold');
  assert.equal(await page.evaluate(() => window.fields.x_kind.read()), 7);
  assert.equal(await page.locator('form').evaluate(form => form.checkValidity()), true);
  await page.evaluate(() => window.fields.x_kind.setDisabled(true));
  assert.equal(await kind.isDisabled(), true); assert.equal(await kind.locator('..').locator('.choice-chevron').isVisible(), false);
  assert.equal(await page.evaluate(() => window.fields.x_kind.read()), 7);
  await page.evaluate(() => window.fields.x_kind.setDisabled(false));
  assert.equal(await kind.locator('..').locator('.choice-chevron').isVisible(), true);
  await kind.click(); assert.equal(await page.getByRole('listbox').isVisible(), true); await page.keyboard.press('Escape');
  assert.equal(await page.getByRole('combobox', { name: 'Enabled', exact: true }).inputValue(), 'Unavailable');
  assert.equal(await page.evaluate(() => window.fields.x_enabled.read()), false);
  await page.getByRole('combobox', { name: 'Enabled', exact: true }).click();
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['Unavailable', 'Available'], 'native Boolean choices order false first even when the export serializes TrueOption first');
  await page.keyboard.press('Escape');
  const tags = page.getByRole('combobox', { name: 'Tags', exact: true });
  assert.equal(await tags.inputValue(), 'Red; Blue');
  await tags.click(); await page.getByRole('option', { name: 'Red', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.fields.x_tags.read()), [5]);
  assert.equal(await page.locator('.choice-chip').filter({ hasText: 'Blue' }).isVisible(), true, 'selected chips remain visible above the open search field');
  await page.keyboard.press('Escape');
  assert.deepEqual(await page.locator('.choice-chip>span').allTextContents(), ['Blue']);
  await page.getByRole('button', { name: 'Remove Blue', exact: true }).click();
  assert.equal(await page.evaluate(() => window.fields.x_tags.read()), null);
  assert.equal(await tags.getAttribute('aria-expanded'), 'false', 'removing a collapsed chip must not open the menu');
  await page.evaluate(() => window.fields.x_tags.setValue([5]));
  assert.equal(await tags.getAttribute('aria-expanded'), 'false');
  assert.deepEqual(await page.evaluate(() => window.changes), ['x_kind', 'x_tags', 'x_tags']);
  await page.evaluate(() => { window.fields.x_tags.setValue('2'); window.fields.x_tags.setDisabled(true); });
  assert.equal(await tags.inputValue(), 'Red'); assert.equal(await tags.isDisabled(), true);
  assert.equal(await tags.locator('..').evaluate(node => node.getBoundingClientRect().height), 44);
  assert.equal(await tags.locator('..').evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(240, 240, 240)');
  await page.evaluate(() => window.fields.x_tags.setDisabled(false));
  assert.equal(await tags.locator('..').evaluate(node => node.getBoundingClientRect().height), 32);
  await tags.click(); await tags.fill('Blue');
  assert.equal(await page.getByRole('option', { name: 'Red', exact: true }).count(), 0);
  await page.getByRole('option', { name: 'Select all', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.fields.x_tags.read()), [2, 5]);
  await page.keyboard.press('Escape');
});

test('disabled lookup presentation hides search and clear while preserving typed references and restoring native editing', async t => {
  const { origin } = await readOnlyApp();
  const page = await chrome.page(t); await page.goto(origin + '/main.aspx');
  await page.evaluate(async () => {
    const { renderControl } = await import('/_apps/assets/controls.mjs'); document.body.replaceChildren(); window.readonlyLookups = [];
    for (const [name, value] of [['Empty', null], ['Selected', { id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', entity:'x_item', name:'Copper' }]]) {
      const control = renderControl({ name, label:name, type:'lookup', targets:['x_item'] }, value, { disabled:true, tables:{ x_item:{ label:'Items' } }, lookupSuggestions:async () => [{ id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', entity:'x_item', name:'Silver' }] });
      const wrapper = document.createElement('div'); wrapper.className = 'field'; wrapper.append(control.element); document.body.append(wrapper); window.readonlyLookups.push(control);
    }
  });
  assert.equal(await page.getByRole('combobox', { name:'Empty', exact:true }).getAttribute('placeholder'), '');
  assert.equal(await page.getByRole('button', { name:/Look up|Clear/ }).count(), 0);
  assert.deepEqual(await page.evaluate(() => window.readonlyLookups[1].read()), { id:'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', entity:'x_item', name:'Copper' });
  await page.evaluate(() => window.readonlyLookups.forEach(control => control.setDisabled(false)));
  assert.equal(await page.getByRole('combobox', { name:'Empty', exact:true }).getAttribute('placeholder'), '---');
  await page.getByRole('button', { name:'Clear Selected', exact:true }).click(); assert.equal(await page.evaluate(() => window.readonlyLookups[1].read()), null);
  await page.getByRole('button', { name:'Look up Empty', exact:true }).click(); await page.getByRole('option', { name:'Silver', exact:true }).click();
  assert.deepEqual(await page.evaluate(() => window.readonlyLookups[0].read()), { id:'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', entity:'x_item', name:'Silver' });
});

test('numeric controls show exported precision and currency without changing raw values, validation or editing', async t => {
  const { origin } = await readOnlyApp();
  const page = await chrome.page(t);
  await page.goto(origin + '/main.aspx');
  await page.evaluate(async () => {
    const { renderControl } = await import('/_apps/assets/controls.mjs'); document.body.replaceChildren(); window.numbers = {};
    for (const [name, dataverseType, precision, value, formatted] of [['Ratio', 'decimal', 2, 12.5, '12.50'], ['Measurement', 'float', 3, 25.125, '25.125'], ['Amount', 'money', 2, 2500, '¤2,500.00']]) {
      const field = document.createElement('div'); field.className = 'field';
      const control = renderControl({ name, label: name, type: 'number', dataverseType, precision, minValue: 0, maxValue: 10000 }, value, { formatted });
      window.numbers[name] = control; field.append(control.element); document.body.append(field);
    }
    const next = document.createElement('button'); next.textContent = 'Next'; document.body.append(next);
  });
  assert.deepEqual(await page.locator('.number-formatted').allTextContents(), ['12.50', '25.125', '¤2,500.00']);
  const ratio = page.getByLabel('Ratio', { exact: true }); await ratio.focus();
  assert.equal(await ratio.inputValue(), '12.5');
  assert.equal(await page.locator('.number-formatted').first().evaluate(node => getComputedStyle(node).visibility), 'hidden');
  await ratio.fill('14.25'); await page.getByRole('button', { name: 'Next', exact: true }).click();
  assert.equal(await page.locator('.number-formatted').first().textContent(), '14.25');
  assert.equal(await page.evaluate(() => window.numbers.Ratio.read()), 14.25);
  const amount = page.getByLabel('Amount', { exact: true }); await amount.fill('1234.5'); await page.getByRole('button', { name: 'Next', exact: true }).click();
  assert.equal(await page.locator('.number-formatted').last().textContent(), '¤1,234.50');
  assert.equal(await page.evaluate(() => window.numbers.Amount.read()), 1234.5);
  await amount.fill('-1'); assert.equal(await amount.evaluate(node => node.checkValidity()), false, 'native numeric bounds remain enforced');
  await page.evaluate(() => window.numbers.Amount.setValue(73.5));
  assert.equal(await page.locator('.number-formatted').last().textContent(), '¤73.50');
  assert.equal(await amount.evaluate(node => node.checkValidity()), true);
  await amount.fill(''); assert.equal(await page.evaluate(() => window.numbers.Amount.read()), null);
  assert.equal(await page.locator('.number-formatted').last().textContent(), '');
});

test('source text formats retain native scalar action glyphs and input semantics with external actions explicitly disabled', async t => {
  const { origin } = await readOnlyApp();
  const page = await chrome.page(t); await page.goto(origin + '/main.aspx');
  await page.evaluate(async () => {
    const { renderControl } = await import('/_apps/assets/controls.mjs'); document.body.replaceChildren(); window.textFields = {};
    for (const [format, value] of [['email', 'person@example.invalid'], ['phone', '+1 555 0100'], ['url', 'https://example.invalid/'], ['tickersymbol', 'SAMPLE'], ['text', 'Plain']]) {
      const wrapper = document.createElement('div'); wrapper.className = 'field';
      const control = renderControl({ name: format, label: format, type: 'text', format, required: true, maxLength: 80 }, value); window.textFields[format] = control; wrapper.append(control.element); document.body.append(wrapper);
    }
  });
  assert.deepEqual(await page.locator('.text-field-action').evaluateAll(nodes => nodes.map(node => ({ disabled: node.disabled, reason: node.title, width: node.getBoundingClientRect().width, height: node.getBoundingClientRect().height }))), Array.from({ length: 4 }, () => ({ disabled: true, reason: 'External field actions are not supported locally.', width: 32, height: 32 })));
  assert.deepEqual(await page.locator('input').evaluateAll(nodes => nodes.map(node => node.type)), ['email', 'tel', 'url', 'text', 'text']);
  const email = page.getByLabel('email', { exact: true }); await email.fill('invalid'); assert.equal(await email.evaluate(node => node.checkValidity()), false);
  await page.evaluate(() => window.textFields.email.setValue('updated@example.invalid'));
  assert.equal(await email.evaluate(node => node.checkValidity()), true); assert.equal(await page.evaluate(() => window.textFields.email.read()), 'updated@example.invalid');
  await page.evaluate(() => window.textFields.url.setDisabled(true)); assert.equal(await page.getByLabel('url', { exact: true }).isDisabled(), true);
  await page.evaluate(() => window.textFields.url.setDisabled(false)); assert.equal(await page.getByLabel('url', { exact: true }).isDisabled(), false);
  assert.equal(await page.getByRole('button', { name: 'Open website for url', exact: true }).isDisabled(), true);
  assert.equal(await page.locator('.text-field-action .icon-mail').count(), 1); assert.equal(await page.locator('.text-field-action .icon-phone').count(), 1);
  assert.equal(await page.locator('.text-field-action .icon-globe').count(), 1); assert.equal(await page.locator('.text-field-action .icon-ticker').count(), 1);
});

test('standard memo controls use the compact native height while declared rows and source editors retain their size', async t => {
  const { origin } = await readOnlyApp();
  const page = await chrome.page(t); await page.goto(origin + '/main.aspx');
  const dimensions = await page.evaluate(async () => {
    const { renderControl } = await import('/_apps/assets/controls.mjs'); document.body.replaceChildren();
    return [[{ name: 'x_description' }, {}], [{ name: 'x_source' }, {}], [{ name: 'x_notes' }, { rows: 3 }], [{ name: 'x_expanded' }, { rows: 5 }], [{ name: 'x_editor', editorRows: 12 }, {}]].map(([field, context]) => {
      const wrapper = document.createElement('div'); wrapper.className = 'field'; const control = renderControl({ ...field, type: 'textarea', maxLength: 100 }, 'First line\nSecond line', context); wrapper.append(control.element); document.body.append(wrapper);
      return { rows: control.element.rows, height: control.element.getBoundingClientRect().height, value: control.read(), maxLength: control.element.maxLength };
    });
  });
  assert.deepEqual(dimensions.map(item => item.rows), [2, 2, 3, 5, 12], 'ordinary field names cannot fabricate a code editor');
  assert.deepEqual(dimensions.slice(0, 4).map(item => item.height), [56, 56, 76, 116], 'source row spans use the native twenty-pixel line height');
  assert.ok(dimensions[4].height > dimensions[3].height);
  assert.equal(dimensions.every(item => item.value === 'First line\nSecond line' && item.maxLength === 100), true);
});

test('saved state and status remain editable with legacy text class IDs while new-record state honors source create restrictions', async t => {
  const source = await modelDrivenFixture(t); await source.sim.close();
  const entityFile = path.join(source.solutionDir, 'Entities/x_item/Entity.xml');
  const fields = '<attribute PhysicalName="statecode"><Name>statecode</Name><Type>state</Type><ValidForCreateApi>0</ValidForCreateApi><ValidForUpdateApi>1</ValidForUpdateApi><displaynames><displayname description="Record state" languagecode="1033"/></displaynames><optionset><states><state value="0" defaultstatus="1" invariantname="Active"><labels><label description="Open" languagecode="1033"/></labels></state><state value="1" defaultstatus="2" invariantname="Inactive"><labels><label description="Closed" languagecode="1033"/></labels></state></states></optionset></attribute><attribute PhysicalName="statuscode"><Name>statuscode</Name><Type>status</Type><displaynames><displayname description="Record reason" languagecode="1033"/></displaynames><optionset><statuses><status value="1" state="0"><labels><label description="Pending" languagecode="1033"/></labels></status><status value="2" state="1"><labels><label description="Finished" languagecode="1033"/></labels></status></statuses></optionset></attribute>';
  await fs.writeFile(entityFile, (await fs.readFile(entityFile, 'utf8')).replace('</attributes>', fields + '</attributes>'));
  const formFile = path.join(source.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const cells = '<row><cell><control datafieldname="statecode" classid="{4273EDBD-AC1D-40D3-9FB2-095C621B552D}"/></cell></row><row><cell><control datafieldname="statuscode" classid="{4273EDBD-AC1D-40D3-9FB2-095C621B552D}"/></cell></row>';
  await fs.writeFile(formFile, (await fs.readFile(formFile, 'utf8')).replace('</rows>', cells + '</rows>'));
  const sim = await source.start(); t.after(() => sim.close()); const origin = sim.origin ?? sim.url;
  const page = await chrome.page(t);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item');
  const state = page.getByRole('combobox', { name: 'Record state', exact: true }), reason = page.getByRole('combobox', { name: 'Record reason', exact: true });
  await state.waitFor(); assert.equal(await state.isDisabled(), true);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
  await state.waitFor(); assert.equal(await state.isDisabled(), false);
  await state.click(); await page.getByRole('option', { name: 'Closed', exact: true }).click();
  await reason.click(); await page.getByRole('option', { name: 'Finished', exact: true }).click();
  const saved = page.waitForRequest(request => request.method() === 'PATCH' && request.url().includes('/_apps/api/tables/x_item/'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const values = (await saved).postDataJSON(); assert.equal(values.statecode, 1); assert.equal(values.statuscode, 2);
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  await page.reload(); await state.waitFor();
  assert.equal(await state.inputValue(), 'Closed'); assert.equal(await reason.inputValue(), 'Finished');
});

test('advanced lookup uses staged Done, preserves a cancelled value, queries exported views and saves a typed reference', async t => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t); page.setDefaultTimeout(5000);
  const id = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
  await page.goto(`${origin}/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_child&id=${id}`);
  await page.getByLabel('Parent', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Choose .* for Parent$/ });
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).waitFor();
  const footerGap = await dialog.evaluate(node => node.getBoundingClientRect().bottom - node.querySelector('.dialog-actions .primary').getBoundingClientRect().bottom);
  assert.ok(footerGap >= 35 && footerGap <= 38, `Lookup footer must follow the modal bottom; gap was ${footerGap}px.`);
  assert.equal(await dialog.getByRole('button', { name: 'Done', exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole('button', { name: 'Lookup view', exact: true }).textContent(), 'Stocked items (default)');
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  assert.equal(await dialog.isVisible(), true);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Copper');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Silver');
  const submitted = page.waitForRequest(request => request.method() === 'PATCH' && request.url().includes('/_apps/api/tables/x_child/'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert.deepEqual((await submitted).postDataJSON().x_parentid, { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', entity: 'x_item', name: 'Silver' });
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
});

test('inline lookup applies its exported lookup view and keeps lookup-only views outside the application view picker', async t => {
  const fixture = await modelDrivenFixture(t); await fixture.sim.close();
  const file = path.join(fixture.solutionDir, 'Entities/x_item/SavedQueries/items.xml');
  const lookupView = (await fs.readFile(file, 'utf8')).replace('{items-view}', '{qualified-lookup}').replace('<querytype>0</querytype>', '<querytype>64</querytype>').replace('Stocked items', 'Qualified lookup').replace('value="1"', 'value="8"');
  await fs.writeFile(path.join(path.dirname(file), 'lookup.xml'), lookupView);
  const sim = await fixture.start(); t.after(() => sim.close()); const origin = sim.origin ?? sim.url;
  const catalogue = await (await fetch(origin + '/_apps/api')).json();
  assert.equal(catalogue.tables.x_item.lookupViews[0].id, 'qualified-lookup');
  assert.equal(catalogue.tables.x_item.views.some(view => view.id === 'qualified-lookup'), false);
  const page = await chrome.page(t); page.setDefaultTimeout(5000);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_child&id=dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('option', { name: 'Silver', exact: true }).waitFor();
  assert.equal(await page.locator('.lookup-suggestion-text small').textContent(), '8', 'lookup view secondary columns retain their formatted value');
  assert.equal(await page.getByRole('button', { name: 'Recent records', exact: true }).isDisabled(), true, 'unimplemented recent history is explicit');
  assert.equal(await page.getByRole('option', { name: 'Copper', exact: true }).count(), 0);
  assert.equal(await page.locator('#dialog').isVisible(), false);
  await page.getByRole('option', { name: 'Silver', exact: true }).click();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Silver');
  assert.equal(await page.getByLabel('Parent', { exact: true }).getAttribute('aria-expanded'), 'false');
});

test('advanced lookup preserves all exported columns and their widths instead of truncating after five', async t => {
  const source = await modelDrivenFixture(t); await source.sim.close();
  const names = Array.from({ length: 6 }, (_, index) => `x_detail${index + 1}`);
  const entityFile = path.join(source.solutionDir, 'Entities/x_item/Entity.xml');
  const attributes = names.map((name, index) => `<attribute PhysicalName="${name}"><Name>${name}</Name><Type>nvarchar</Type><displaynames><displayname description="Detail ${index + 1}" languagecode="1033"/></displaynames></attribute>`).join('');
  await fs.writeFile(entityFile, (await fs.readFile(entityFile, 'utf8')).replace('</attributes>', attributes + '</attributes>'));
  const queryFile = path.join(source.solutionDir, 'Entities/x_item/SavedQueries/items.xml');
  const lookup = (await fs.readFile(queryFile, 'utf8')).replace('{items-view}', '{wide-lookup}').replace('<querytype>0</querytype>', '<querytype>64</querytype>').replace('<cell name="x_quantity" width="100"/>', names.map((name, index) => `<cell name="${name}" width="${80 + index * 10}"/>`).join(''));
  await fs.writeFile(path.join(path.dirname(queryFile), 'wide.xml'), lookup);
  const sim = await source.start(); t.after(() => sim.close()); const origin = sim.origin ?? sim.url;
  const page = await chrome.page(t);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_child&id=dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Choose .* for Parent$/ });
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).waitFor();
  assert.deepEqual(await dialog.getByRole('columnheader').allTextContents(), ['', 'Name', 'Detail 1', 'Detail 2', 'Detail 3', 'Detail 4', 'Detail 5', 'Detail 6']);
  assert.deepEqual(await dialog.locator('th').evaluateAll(nodes => nodes.slice(2).map(node => node.style.width)), ['80px', '90px', '100px', '110px', '120px', '130px']);
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Silver');
});

test('advanced lookup renders the native empty state, then recovers to selectable results without changing the field', async t => {
  const { origin } = await readOnlyApp();
  const page = await chrome.page(t); page.setDefaultTimeout(5000);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_child&id=dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Choose .* for Parent$/ });
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  const search = dialog.getByRole('searchbox', { name: 'Search lookup records' });
  await search.fill('No matching invented record');
  await dialog.getByRole('heading', { name: 'We don’t have any data for this view', exact: true }).waitFor();
  assert.equal(await dialog.getByText('Please try switching to another view', { exact: true }).isVisible(), true);
  assert.equal(await dialog.getByRole('table').count(), 0);
  assert.equal(await dialog.getByRole('button', { name: 'Done', exact: true }).isDisabled(), true);
  const center = await dialog.locator('.lookup-browser-empty').evaluate(node => {
    const bounds = node.getBoundingClientRect(), title = node.querySelector('h3').getBoundingClientRect();
    return { expected: (bounds.top + bounds.bottom) / 2, actual: (title.top + title.bottom) / 2 };
  });
  assert.ok(Math.abs(center.actual - center.expected) < 35, 'empty message belongs near the center of the results area');
  await search.fill('Copper');
  await dialog.getByRole('radio', { name: 'Select Copper', exact: true }).waitFor();
  assert.equal(await dialog.locator('.lookup-browser-empty').count(), 0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Copper');
});

test('lookup invalidates selection during search, ignores stale responses and settles Escape', async t => {
  const { origin } = await readOnlyApp();
  const page = await chrome.page(t); page.setDefaultTimeout(5000);
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_child&id=dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Choose .* for Parent$/ });
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  let release, waiting;
  const requestStarted = new Promise(resolve => { waiting = resolve; });
  await page.route('**/_apps/api/tables/x_item?*', async route => {
    const query = JSON.parse(new URL(route.request().url()).searchParams.get('query'));
    if (query.search !== 'Copper') return route.continue();
    waiting(); await new Promise(resolve => { release = resolve; }); await route.continue();
  });
  t.after(() => release?.());
  await dialog.getByRole('searchbox', { name: 'Search lookup records' }).fill('Copper');
  assert.equal(await dialog.getByRole('button', { name: 'Done', exact: true }).isDisabled(), true);
  await requestStarted;
  await dialog.getByRole('searchbox', { name: 'Search lookup records' }).fill('Silver');
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).waitFor();
  release();
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  assert.equal(await dialog.getByRole('radio', { name: 'Select Copper', exact: true }).count(), 0);
  await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'hidden' });
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Copper');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  await dialog.getByRole('radio', { name: 'Select Copper', exact: true }).waitFor();
});

test('lookup target picker clears selection and preserves polymorphic target identity', async t => {
  const { origin } = await modelDrivenFixture(t);
  const page = await chrome.page(t); page.setDefaultTimeout(5000);
  let targetLabel;
  await page.route('**/_apps/api/metadata/x_child', async route => {
    const response = await route.fetch(), table = await response.json();
    table.fields.x_parentid.targets = ['x_item', 'x_child'];
    targetLabel = table.label;
    await route.fulfill({ response, json: table });
  });
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_child&id=dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  await page.getByRole('button', { name: 'Look up Parent', exact: true }).click();
  await page.getByRole('button', { name: 'Advanced', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /^Choose .* for Parent$/ });
  await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).check();
  await dialog.getByRole('button', { name: 'Lookup table', exact: true }).click();
  await page.getByRole('menuitemradio', { name: targetLabel, exact: true }).click();
  await dialog.getByRole('radio', { name: 'Select Silver child', exact: true }).waitFor();
  assert.equal(await dialog.getByRole('button', { name: 'Done', exact: true }).isDisabled(), true);
  assert.equal(await dialog.getByRole('radio', { name: 'Select Silver', exact: true }).count(), 0);
  await dialog.getByRole('radio', { name: 'Select Silver child', exact: true }).check();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  assert.equal(await page.getByLabel('Parent', { exact: true }).inputValue(), 'Silver child');
  const submitted = page.waitForRequest(request => request.method() === 'PATCH' && request.url().includes('/_apps/api/tables/x_child/'));
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await submitted).postDataJSON().x_parentid.entity, 'x_child');
});

test('inline lookup rejects stale keyboard choices during debounce and after an adapter ignores cancellation', async t => {
  const { origin } = await readOnlyApp();
  const page = await chrome.page(t); page.setDefaultTimeout(5000);
  await page.goto(origin + '/main.aspx');
  await page.evaluate(async () => {
    const { renderControl } = await import('/_apps/assets/controls.mjs'); document.body.replaceChildren();
    window.requests = [];
    window.lookup = renderControl({ name: 'x_lookup', label: 'Related', type: 'lookup', targets: ['x_item'] }, null, { tables: { x_item: {} }, lookupSuggestions: () => new Promise(resolve => window.requests.push(resolve)) });
    document.body.append(window.lookup.element);
  });
  const input = page.getByRole('combobox', { name: 'Related', exact: true });
  await page.getByRole('button', { name: 'Look up Related', exact: true }).click();
  await page.evaluate(() => window.requests[0]([{ id: 'a', entity: 'x_item', name: 'Old result' }]));
  await page.getByRole('option', { name: 'Old result', exact: true }).waitFor();
  await input.fill('Second'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.equal(await input.inputValue(), 'Second');
  assert.equal(await page.getByRole('option', { name: 'Old result', exact: true }).count(), 0);
  await page.waitForFunction(() => window.requests.length === 2);
  await input.fill('Latest'); await page.waitForFunction(() => window.requests.length === 3);
  await page.evaluate(() => window.requests[2]([{ id: 'c', entity: 'x_item', name: 'Latest result' }]));
  await page.getByRole('option', { name: 'Latest result', exact: true }).waitFor();
  await page.evaluate(() => window.requests[1]([{ id: 'b', entity: 'x_item', name: 'Stale result' }]));
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  assert.deepEqual(await page.evaluate(() => window.lookup.read()), { id: 'c', entity: 'x_item', name: 'Latest result' });
  await page.getByRole('button', { name: 'Look up Related', exact: true }).click();
  await page.evaluate(() => window.lookup.setDisabled(true));
  assert.equal(await input.getAttribute('aria-expanded'), 'false');
  await page.evaluate(() => window.requests[3]([{ id: 'd', entity: 'x_item', name: 'Denied late result' }]));
  assert.deepEqual(await page.evaluate(() => window.lookup.read()), { id: 'c', entity: 'x_item', name: 'Latest result' });
});
