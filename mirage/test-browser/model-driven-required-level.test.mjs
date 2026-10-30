import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const chrome = sharedBrowser();

test('attribute requirement levels retain recommended and update every bound control across tabs', async (t) => {
  const fixture = await modelDrivenFixture(t, { modelDriven: { trustedExtensions: true } });
  await fixture.sim.close();
  const entityFile = path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8')).replace(
      '<Type>int</Type>',
      '<Type>int</Type><RequiredLevel>recommended</RequiredLevel>',
    ),
  );
  const formFile = path.join(fixture.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const duplicate =
    '<row><cell><labels><label description="Second quantity" languagecode="1033"/></labels><control id="second_quantity" datafieldname="x_quantity"/></cell></row>';
  const otherTab =
    '<tab name="other"><labels><label description="Other inputs" languagecode="1033"/></labels><columns><column><sections><section name="other_inputs"><rows><row><cell><labels><label description="Third quantity" languagecode="1033"/></labels><control id="third_quantity" datafieldname="x_quantity"/></cell></row></rows></section></sections></column></columns></tab>';
  const xml = (await fs.readFile(formFile, 'utf8'))
    .replace('</rows>', duplicate + '</rows>')
    .replace('</tabs>', otherTab + '</tabs>');
  await fs.writeFile(formFile, xml);
  const sim = await fixture.start();
  t.after(() => sim.close());
  const page = await chrome.page(t);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(
    sim.url + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.waitForFunction(() => Boolean(window.Xrm?.Page));
  assert.equal(await page.evaluate(() => window.Xrm.Page.getAttribute('x_quantity').getRequiredLevel()), 'recommended');
  assert.equal(await page.getByLabel('Quantity', { exact: true }).getAttribute('required'), null);
  assert.equal(await page.getByLabel('Second quantity', { exact: true }).getAttribute('required'), null);
  const ids = await page
    .locator('.field[data-id="x_quantity"] input, .field[data-id="second_quantity"] input')
    .evaluateAll((nodes) => nodes.map((node) => node.id));
  assert.equal(ids.length, 2);
  assert.equal(new Set(ids).size, 2, 'repeated logical columns need distinct rendered control IDs');
  assert.equal(
    await page
      .locator('.field[data-id="second_quantity"] label')
      .evaluate((label) => label.control === label.parentElement.querySelector('input')),
    true,
    'the second label must associate with its own control',
  );
  for (const level of ['required', 'recommended', 'none']) {
    await page.evaluate((level) => window.Xrm.Page.getAttribute('x_quantity').setRequiredLevel(level), level);
    assert.equal(await page.evaluate(() => window.Xrm.Page.getAttribute('x_quantity').getRequiredLevel()), level);
    for (const label of ['Quantity', 'Second quantity'])
      assert.equal(
        await page.getByLabel(label, { exact: true }).evaluate((node) => node.required),
        level === 'required',
        label,
      );
    await page.getByRole('tab', { name: 'Other inputs', exact: true }).click();
    assert.equal(
      await page.getByLabel('Third quantity', { exact: true }).evaluate((node) => node.required),
      level === 'required',
    );
    assert.equal(await page.evaluate(() => window.Xrm.Page.getAttribute('x_quantity').getRequiredLevel()), level);
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    assert.equal(
      await page.getByLabel('Second quantity', { exact: true }).evaluate((node) => node.required),
      level === 'required',
    );
  }
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_quantity').setRequiredLevel('recommended'));
  await assert.rejects(
    page.evaluate(() => window.Xrm.Page.getAttribute('x_quantity').setRequiredLevel('invalid')),
    /Invalid required level/,
  );
  assert.equal(await page.evaluate(() => window.Xrm.Page.getAttribute('x_quantity').getRequiredLevel()), 'recommended');
  assert.equal(
    await page.evaluate(() => window.Xrm.Page.data.getIsDirty()),
    false,
    'presentation changes must not dirty record values',
  );
  assert.deepEqual(errors, []);
});

test('header-only attributes retain requirement state without claiming a rendered region control', async (t) => {
  const fixture = await modelDrivenFixture(t, { modelDriven: { trustedExtensions: true } });
  await fixture.sim.close();
  const formFile = path.join(fixture.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const xml = (await fs.readFile(formFile, 'utf8'))
    .replace(
      '<row><cell><labels><label description="Quantity" languagecode="1033"/></labels><control datafieldname="x_quantity"/></cell></row>',
      '',
    )
    .replace(
      '<form><tabs>',
      '<form><header><rows><row><cell><control id="header_x_quantity" datafieldname="x_quantity"/></cell></row></rows></header><tabs>',
    );
  await fs.writeFile(formFile, xml);
  const sim = await fixture.start();
  t.after(() => sim.close());
  const page = await chrome.page(t);
  await page.goto(
    sim.url + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.waitForFunction(() => Boolean(window.Xrm?.Page));
  for (const level of ['recommended', 'required', 'none']) {
    const state = await page.evaluate((level) => {
      const attribute = window.Xrm.Page.getAttribute('x_quantity'),
        control = window.Xrm.Page.getControl('header_x_quantity');
      attribute.setRequiredLevel(level);
      return {
        level: attribute.getRequiredLevel(),
        disabled: control.getDisabled(),
        visible: control.getVisible(),
        dirty: window.Xrm.Page.data.getIsDirty(),
      };
    }, level);
    assert.deepEqual(state, { level, disabled: true, visible: true, dirty: false });
    assert.equal(
      await page.locator('[id="field-header_x_quantity"]').count(),
      0,
      'metadata visibility does not claim a rendered header control',
    );
  }
});
