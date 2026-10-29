import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const browser = sharedBrowser();

async function fixture(t) {
  const source = await modelDrivenFixture(t, { defer: true });
  const options =
    '<options><option value="1"><labels><label description="One" languagecode="1033"/></labels></option><option value="2"><labels><label description="Two" languagecode="1033"/></labels></option></options>';
  const entity = path.join(source.solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(
    entity,
    (await fs.readFile(entity, 'utf8')).replace(
      '</attributes>',
      `<attribute PhysicalName="x_choice"><Name>x_choice</Name><Type>picklist</Type><RequiredLevel>required</RequiredLevel><optionset>${options}</optionset></attribute><attribute PhysicalName="x_tags"><Name>x_tags</Name><Type>multiselectpicklist</Type><optionset>${options}</optionset></attribute></attributes>`,
    ),
  );
  const form = path.join(source.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const row = (id, field, label) =>
    `<row><cell><labels><label description="${label}" languagecode="1033"/></labels><control id="${id}" datafieldname="${field}"/></cell></row>`;
  await fs.writeFile(
    form,
    (await fs.readFile(form, 'utf8')).replace(
      '<row><cell><control id="unimplemented"/></cell></row>',
      row('first', 'x_choice', 'First choice') +
        row('second', 'x_choice', 'Second choice') +
        row('tags', 'x_tags', 'Tags'),
    ),
  );
  const sim = await source.start();
  const page = await browser.page(t);
  await page.goto(
    sim.url + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && window.Xrm);
  return page;
}

test('choice options change on one rendered control without changing source metadata, sibling options or requiredness', async (t) => {
  const page = await fixture(t);
  const first = page.getByRole('combobox', { name: 'First choice', exact: true });
  const second = page.getByRole('combobox', { name: 'Second choice', exact: true });
  await page.evaluate(() => {
    const control = window.Xrm.Page.getControl('first');
    control.removeOption(1);
    control.addOption({ text: 'Zero', value: 0 }, 0);
    control.addOption({ text: 'Three', value: 3 });
  });
  assert.deepEqual(
    await page.evaluate(() => [
      window.Xrm.Page.data.getIsDirty(),
      window.Xrm.Page.getAttribute('x_choice').getValue(),
      window.Xrm.Page.getAttribute('x_choice').getOptions(),
    ]),
    [
      false,
      null,
      [
        { text: 'One', value: 1 },
        { text: 'Two', value: 2 },
      ],
    ],
  );
  await first.click();
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['--Select--', 'Zero', 'Two', 'Three']);
  await page.evaluate(() => window.Xrm.Page.getControl('first').clearOptions());
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['--Select--']);
  assert.equal(await first.getAttribute('aria-required'), 'true');
  assert.equal(await page.evaluate(() => window.Xrm.Page.data.entity.isValid()), false);
  await page.evaluate(() => window.Xrm.Page.getControl('first').addOption({ text: '<b>Zero</b>', value: 0 }));
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['--Select--', '<b>Zero</b>']);
  assert.equal(await page.getByRole('option', { name: '<b>Zero</b>', exact: true }).locator('b').count(), 0);
  await first.press('Escape');
  await second.click();
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['--Select--', 'One', 'Two']);
  await second.press('Escape');
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_choice').setValue(0));
  assert.equal(await first.inputValue(), '<b>Zero</b>');
  assert.equal(await page.evaluate(() => window.Xrm.Page.getAttribute('x_choice').getValue()), 0);
});

test('multi-select option updates preserve selected numeric values and survive form tab re-rendering', async (t) => {
  const page = await fixture(t);
  const tags = page.getByRole('combobox', { name: 'Tags', exact: true });
  await page.evaluate(() => {
    const form = window.Xrm.Page;
    form.getControl('tags').clearOptions();
    form.getControl('tags').addOption({ text: 'Tag zero', value: 0 });
    form.getControl('tags').addOption({ text: 'Tag two', value: 2 });
    form.getAttribute('x_tags').setValue([0]);
  });
  await tags.click();
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['Select all2 items', 'Tag zero', 'Tag two']);
  await page.getByRole('option', { name: 'Tag two', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.Xrm.Page.getAttribute('x_tags').getValue()), [0, 2]);
  await tags.press('Escape');
  await page.getByRole('tab', { name: 'Related items', exact: true }).click();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await tags.click();
  assert.deepEqual(await page.getByRole('option').allTextContents(), ['Select all2 items', 'Tag zero', 'Tag two']);
  assert.deepEqual(await page.evaluate(() => window.Xrm.Page.getAttribute('x_tags').getOptions()), [
    { text: 'One', value: 1 },
    { text: 'Two', value: 2 },
  ]);
});
