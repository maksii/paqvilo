// @test-kind contract: Paqvilo's own model-driven requirement-level presentation and local form validation feedback.
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

const requiredMessage = 'Please make sure all the field requirements are met.';

/** Opens the Copper record with Name made business-required and cleared, so the next save is refused. */
async function requiredNameRecord(t) {
  const { origin } = await modelDrivenFixture(t, { modelDriven: { trustedExtensions: true } });
  const page = await chrome.page(t);
  await page.goto(
    `${origin}/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa`,
  );
  await page.waitForFunction(() => Boolean(window.Xrm?.Page));
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_name').setRequiredLevel('required'));
  await page.getByLabel('Name', { exact: true }).fill('');
  return page;
}

// @test-kind observation: native model-driven main form observed 2026-11-12 on a developer environment (single console probe): a save with an empty business-required field is rejected with the requirement text.
test('an empty business-required field on save shows the native requirement text in the form and beside the field', async (t) => {
  const page = await requiredNameRecord(t);
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('#form-notifications p.error').waitFor();
  assert.equal(await page.locator('#form-notifications p.error').textContent(), requiredMessage);
  assert.equal(await page.locator('.field-message').textContent(), requiredMessage);
});

test('a refused required-field save marks the empty control, focuses it and clears the marks once it has a value', async (t) => {
  const page = await requiredNameRecord(t);
  const name = page.getByLabel('Name', { exact: true });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('#form-notifications p.error').waitFor();
  assert.equal(await name.getAttribute('aria-invalid'), 'true');
  const messageId = await name.getAttribute('aria-describedby');
  assert.ok(messageId, 'the control names its message');
  assert.equal(
    await name.evaluate(
      (input, id) => document.getElementById(id)?.closest('.field') === input.closest('.field'),
      messageId,
    ),
    true,
    'the message sits in the same field as its control',
  );
  assert.equal(await name.evaluate((input) => document.activeElement === input), true, 'focus moves to the control');
  await name.fill('Named again');
  await page.locator('.field-message').waitFor({ state: 'detached' });
  assert.equal(await name.getAttribute('aria-invalid'), null);
  assert.equal(await name.getAttribute('aria-describedby'), null);
  assert.equal(await page.locator('#form-notifications p').count(), 0);
});

test('a refused save with a business-required duration keeps the duration error attached beside the required message', async (t) => {
  const fixture = await modelDrivenFixture(t, { modelDriven: { trustedExtensions: true } });
  await fixture.sim.close();
  const entityFile = path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8')).replace(
      '<Type>int</Type>',
      '<Type>int</Type><Format>duration</Format><MinValue>0</MinValue><MaxValue>20160</MaxValue>',
    ),
  );
  const sim = await fixture.start();
  t.after(() => sim.close());
  const page = await chrome.page(t);
  await page.goto(
    sim.url + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.waitForFunction(() => Boolean(window.Xrm?.Page));
  await page.evaluate(() => window.Xrm.Page.getAttribute('x_quantity').setRequiredLevel('required'));
  const duration = page.getByRole('combobox', { name: 'Quantity', exact: true });
  await duration.fill('');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.locator('#form-notifications p.error').waitFor();
  const referenced = () =>
    duration.evaluate((input) =>
      input
        .getAttribute('aria-describedby')
        .split(' ')
        .map((id) => document.getElementById(id)?.className ?? null),
    );
  assert.deepEqual(
    await referenced(),
    ['duration-error', 'field-message'],
    'the duration error stays attached and referenced beside the required message',
  );
  assert.equal(await page.locator('.duration-error').count(), 1);
  await duration.fill('2 hours');
  await page.locator('.field-message').waitFor({ state: 'detached' });
  assert.deepEqual(await referenced(), ['duration-error'], 'correcting the value removes only the required message');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Record saved locally.' }).waitFor();
  assert.deepEqual(await referenced(), ['duration-error']);
});
