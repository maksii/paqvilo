import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';

const browser = sharedBrowser();

async function fixture(t) {
  const source = await modelDrivenFixture(t, { defer: true });
  const entity = path.join(source.solutionDir, 'Entities/x_item/Entity.xml');
  await fs.writeFile(
    entity,
    (await fs.readFile(entity, 'utf8'))
      .replace(
        '<Type>int</Type>',
        '<Type>int</Type><MinValue>0</MinValue><MaxValue>10</MaxValue><Accuracy>0</Accuracy>',
      )
      .replace('<Type>nvarchar</Type>', '<Type>nvarchar</Type><MaxLength>80</MaxLength>'),
  );
  const sim = await source.start();
  const page = await browser.page(t);
  await page.goto(
    sim.url + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.mirageAppState === 'ready' && window.Xrm);
  return page;
}

test('form validity checks required values without treating disabled or hidden controls as failures', async (t) => {
  const page = await fixture(t);
  assert.deepEqual(
    await page.evaluate(() => {
      const form = window.Xrm.Page,
        attribute = form.getAttribute('x_name'),
        control = form.getControl('x_name'),
        states = [form.data.entity.isValid(), form.data.getIsDirty()];
      attribute.setValue(null);
      states.push(form.data.entity.isValid(), form.data.isValid());
      control.setDisabled(true);
      states.push(form.data.entity.isValid());
      control.setDisabled(false);
      control.setVisible(false);
      states.push(form.data.entity.isValid());
      control.setVisible(true);
      states.push(form.data.entity.isValid());
      attribute.setRequiredLevel('none');
      states.push(form.data.entity.isValid());
      attribute.setRequiredLevel('required');
      states.push(form.data.entity.isValid());
      attribute.setValue('Invented valid name');
      states.push(form.data.isValid(), form.data.getIsDirty());
      return states;
    }),
    [true, false, false, false, true, true, false, true, false, true, true],
  );
  assert.equal(await page.getByRole('textbox', { name: 'Name', exact: true }).getAttribute('aria-invalid'), 'false');
});

test('form validity honors source number bounds and control notifications without changing dirty state', async (t) => {
  const page = await fixture(t);
  assert.deepEqual(
    await page.evaluate(() => {
      const form = window.Xrm.Page,
        attribute = form.getAttribute('x_quantity'),
        control = form.getControl('x_quantity'),
        states = [];
      attribute.setValue(11);
      states.push(form.data.entity.isValid(), form.data.isValid());
      attribute.setValue(0);
      states.push(form.data.entity.isValid());
      control.setNotification('Invented client validation', 'invented');
      states.push(form.data.entity.isValid());
      control.clearNotification('invented');
      states.push(form.data.isValid(), form.data.getIsDirty());
      return states;
    }),
    [false, false, true, false, true, true],
  );
  assert.equal(await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).getAttribute('min'), '0');
  assert.equal(await page.getByRole('spinbutton', { name: 'Quantity', exact: true }).getAttribute('max'), '10');
  assert.deepEqual(
    await page.evaluate(() => {
      const quantity = window.Xrm.Page.getAttribute('x_quantity');
      return [
        quantity.getMin(),
        quantity.getMax(),
        quantity.getPrecision(),
        window.Xrm.Page.getAttribute('x_name').getMaxLength(),
      ];
    }),
    [0, 10, 0, 80],
  );
});
