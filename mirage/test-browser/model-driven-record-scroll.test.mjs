import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { browserLaunchOptions } from '../lib/browser-launch.mjs';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';

test('record title and tabs stay pinned while long exported sections and their controls scroll', async t => {
  const source = await modelDrivenFixture(t); await source.sim.close();
  const entityFile = path.join(source.solutionDir, 'Entities/x_item/Entity.xml');
  const names = Array.from({ length: 30 }, (_, index) => `x_text${index}`);
  const attributes = names.map(name => `<attribute PhysicalName="${name}"><Name>${name}</Name><Type>nvarchar</Type><displaynames><displayname description="${name}" languagecode="1033"/></displaynames></attribute>`).join('') + '<attribute PhysicalName="x_due"><Name>x_due</Name><Type>datetime</Type><Format>dateonly</Format><DateTimeBehavior>DateOnly</DateTimeBehavior><displaynames><displayname description="Due date" languagecode="1033"/></displaynames></attribute>';
  await fs.writeFile(entityFile, (await fs.readFile(entityFile, 'utf8')).replace('<Type>int</Type>', '<Type>int</Type><Format>duration</Format>').replace('</attributes>', attributes + '</attributes>'));
  const row = name => `<row><cell><control datafieldname="${name}"/></cell></row>`;
  const section = (name, fields) => `<section name="${name}"><labels><label description="${name}" languagecode="1033"/></labels><rows>${fields.map(row).join('')}</rows></section>`;
  await fs.writeFile(path.join(source.solutionDir, 'Entities/x_item/FormXml/main/item.xml'), `<systemform><formid>{item-form}</formid><type>2</type><LocalizedNames><LocalizedName description="Information" languagecode="1033"/></LocalizedNames><form><tabs><tab name="general"><labels><label description="General" languagecode="1033"/></labels><columns><column><sections>${section('Opening section', ['x_name', ...names.slice(0, 12)])}${section('Numbers and dates', ['x_quantity', 'x_due'])}${section('Closing section', names.slice(12))}</sections></column></columns></tab></tabs></form></systemform>`);
  const sim = await source.start(); t.after(() => sim.close()); const origin = sim.origin ?? sim.url;
  const browser = await chromium.launch(browserLaunchOptions()); t.after(() => browser.close());
  for (const viewport of [{ width: 1582, height: 1000 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport });
    await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
    const geometry = () => page.evaluate(() => Object.fromEntries(['.record-header', '.tabs', '#field-x_text0'].map(selector => { const { top, bottom, height } = document.querySelector(selector).getBoundingClientRect(); return [selector, { top, bottom, height }]; })));
    const before = await geometry();
    await page.locator('#content').evaluate(node => { node.scrollTop = 400; });
    const after = await geometry();
    assert.deepEqual(after['.record-header'], before['.record-header'], `record identity must stay pinned at ${viewport.width}px`);
    assert.deepEqual(after['.tabs'], before['.tabs'], `tab strip must stay pinned at ${viewport.width}px`);
    assert.equal(after['#field-x_text0'].top < before['#field-x_text0'].top - 300, true);
    assert.equal(await page.getByRole('tab', { name: 'General', exact: true }).isVisible(), true);
    const duration = page.getByRole('combobox', { name: 'Quantity', exact: true });
    await duration.evaluate(input => { const content = document.querySelector('#content'); content.scrollTop += input.getBoundingClientRect().top - (innerHeight - 170); });
    await duration.click();
    await page.getByRole('option', { name: '1.5 hours', exact: true }).click();
    assert.equal(await duration.inputValue(), '1.5 hours');
    const due = page.getByRole('combobox', { name: 'Due date', exact: true });
    await due.evaluate(input => { const content = document.querySelector('#content'); content.scrollTop += input.getBoundingClientRect().top - (innerHeight - 330); });
    await page.getByRole('button', { name: 'Open calendar for Due date', exact: true }).click();
    const calendar = page.getByRole('dialog', { name: 'Calendar', exact: true });
    await calendar.waitFor();
    const day = calendar.getByRole('button', { name: /15, / }).first();
    await day.click();
    assert.equal(await due.inputValue() !== '', true);
    assert.deepEqual((await geometry())['.tabs'], before['.tabs']);
    await page.close();
  }
});
