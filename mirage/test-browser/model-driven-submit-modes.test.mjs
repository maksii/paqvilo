// @test-kind observation: two native UCI save flows (2026-11-08) recorded as counts and hashes in fixtures/frontend-parity-evidence.json (suites model-driven-saves, model-driven-restored-saves); raw captures are not committed and the form setup and submit-mode calls are typed here, so it is not a replay case
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { sharedBrowser } from './shared-browser.mjs';
const browser = sharedBrowser();

test('submit modes govern saved columns, refresh suppressed edits and survive the form save', async (t) => {
  const fixture = await modelDrivenFixture(t, { defer: true, modelDriven: { trustedExtensions: true } });
  const entityFile = path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml');
  const formFile = path.join(fixture.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const names = ['x_email', 'x_summary'];
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8')).replace(
      '</attributes>',
      names
        .map(
          (name) =>
            `<attribute PhysicalName="${name}"><Name>${name}</Name><Type>nvarchar</Type><MaxLength>200</MaxLength><displaynames><displayname description="${name}" languagecode="1033"/></displaynames></attribute>`,
        )
        .join('') + '</attributes>',
    ),
  );
  await fs.writeFile(
    formFile,
    (await fs.readFile(formFile, 'utf8')).replace(
      '</rows>',
      names.map((name) => `<row><cell><control id="${name}" datafieldname="${name}"/></cell></row>`).join('') +
        '</rows>',
    ),
  );
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const sim = await fixture.start({
      initial: {
        version: 1,
        mappings: {
          x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name', inferred: false },
          x_child: { entitySet: 'x_children', idColumn: 'x_childid', nameColumn: 'x_name', inferred: false },
        },
        tables: {
          x_item: [
            {
              x_itemid: id,
              x_name: 'Copper',
              x_quantity: 2,
              x_email: 'before@example.invalid',
              x_summary: 'Unchanged value',
            },
          ],
          x_child: [],
        },
      },
    }),
    origin = sim.url;
  const page = await browser.page(t);
  const writes = [];
  page.on('request', (request) => {
    if (request.url().startsWith(origin + '/_apps/api/tables/x_item/') && request.method() === 'PATCH')
      writes.push(request.postDataJSON());
  });
  await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=' + id);
  await page.getByLabel('Quantity', { exact: true }).waitFor();
  await page.evaluate(async () => {
    const form = window.Xrm.Page;
    form.getAttribute('x_email').setValue('after@example.invalid');
    form.getAttribute('x_email').setSubmitMode('never');
    form.getAttribute('x_name').setValue('Submitted');
    form.getAttribute('x_summary').setSubmitMode('always');
    await form.data.save();
  });
  await page.getByText('Record saved locally.', { exact: true }).waitFor();
  assert.equal(
    (await (await fetch(origin + '/_apps/api/tables/x_item/' + id)).json()).row.x_email,
    'before@example.invalid',
  );
  assert.equal(await page.locator('[data-id="x_email"] input').inputValue(), 'before@example.invalid');
  assert.deepEqual(
    await page.evaluate(() => ({
      never: window.Xrm.Page.getAttribute('x_email').getSubmitMode(),
      always: window.Xrm.Page.getAttribute('x_summary').getSubmitMode(),
    })),
    { never: 'never', always: 'always' },
  );
  assert.deepEqual(writes, [{ x_name: 'Submitted', x_summary: 'Unchanged value' }]);
  await page.evaluate(() => window.Xrm.Page.data.save());
  assert.deepEqual(writes, [{ x_name: 'Submitted', x_summary: 'Unchanged value' }]);
});

test('restoring a dirty-mode value omits that column while a real edit and unchanged always column save', async (t) => {
  const fixture = await modelDrivenFixture(t, { defer: true, modelDriven: { trustedExtensions: true } });
  const entityFile = path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml');
  const formFile = path.join(fixture.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
  const names = ['x_email', 'x_summary', 'x_never'];
  await fs.writeFile(
    entityFile,
    (await fs.readFile(entityFile, 'utf8')).replace(
      '</attributes>',
      names
        .map(
          (name) =>
            `<attribute PhysicalName="${name}"><Name>${name}</Name><Type>nvarchar</Type><MaxLength>200</MaxLength></attribute>`,
        )
        .join('') + '</attributes>',
    ),
  );
  await fs.writeFile(
    formFile,
    (await fs.readFile(formFile, 'utf8')).replace(
      '</rows>',
      names.map((name) => `<row><cell><control id="${name}" datafieldname="${name}"/></cell></row>`).join('') +
        '</rows>',
    ),
  );
  const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const simulator = await fixture.start({
    initial: {
      version: 1,
      mappings: {
        x_item: { entitySet: 'x_items', idColumn: 'x_itemid', nameColumn: 'x_name', inferred: false },
        x_child: { entitySet: 'x_children', idColumn: 'x_childid', nameColumn: 'x_name', inferred: false },
      },
      tables: {
        x_item: [
          {
            x_itemid: id,
            x_name: 'Copper',
            x_quantity: 2,
            x_email: 'before@example.invalid',
            x_summary: 'Unchanged value',
            x_never: 'Never baseline',
          },
        ],
        x_child: [],
      },
    },
  });
  const page = await browser.page(t),
    writes = [];
  page.on('request', (request) => {
    if (request.url().startsWith(simulator.url + '/_apps/api/tables/x_item/') && request.method() === 'PATCH')
      writes.push(request.postDataJSON());
  });
  await page.goto(simulator.url + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=' + id);
  await page.getByLabel('Quantity', { exact: true }).waitFor();
  const before = await page.evaluate(async () => {
    const form = window.Xrm.Page,
      email = form.getAttribute('x_email');
    email.setValue('after@example.invalid');
    email.setValue('before@example.invalid');
    form.getAttribute('x_never').setValue('Never edited');
    form.getAttribute('x_never').setSubmitMode('never');
    form.getAttribute('x_summary').setSubmitMode('always');
    form.getAttribute('x_name').setValue('Submitted');
    const result = { attribute: email.getIsDirty(), entity: form.data.entity.getIsDirty() };
    await form.data.save();
    return result;
  });
  assert.deepEqual(before, { attribute: false, entity: true });
  await page.getByText('Record saved locally.', { exact: true }).waitFor();
  assert.deepEqual(writes, [{ x_name: 'Submitted', x_summary: 'Unchanged value' }]);
  const row = (await (await fetch(simulator.url + '/_apps/api/tables/x_item/' + id)).json()).row;
  assert.equal(row.x_email, 'before@example.invalid');
  assert.equal(row.x_never, 'Never baseline');
  assert.deepEqual(
    await page.evaluate(() =>
      ['x_email', 'x_summary', 'x_never'].map((name) => window.Xrm.Page.getAttribute(name).getSubmitMode()),
    ),
    ['dirty', 'always', 'never'],
  );
  await page.evaluate(() => window.Xrm.Page.data.save());
  assert.deepEqual(writes, [{ x_name: 'Submitted', x_summary: 'Unchanged value' }]);
});
