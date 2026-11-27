// @test-kind observation: the portal Web API reads a pcf-entity-logical-name request's segment as a table logical name only, live captures paqvilo-developer pcf-parity summary-F section 1 (runs fa and fb, wa-field-ny direct reads logical.pcfheader, logical.plain, set.pcfheader and set.plain, paqvilo3 2026-11-26) and summary-A3 Q-R1 (entity set name with the header 400 9004010A), replayed on an invented loopback portal
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { ownedFixture, ownedClose, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const ROW = 'e0000000-0000-4000-8000-000000000001';

async function portal(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'webapi-pcf-segment-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'website.yml'), 'adx_websiteid: site\nadx_name: Segments');
  await fs.writeFile(
    path.join(directory, 'sitesetting.yml'),
    '- adx_name: Webapi/tst_item/enabled\n  adx_value: true\n- adx_name: Webapi/tst_item/fields\n  adx_value: tst_itemid,tst_name',
  );
  return ownedClose(
    t,
    await createSimulator({
      sourceDir: directory,
      watch: false,
      initial: {
        mappings: {
          tst_item: { entitySet: 'tst_items', idColumn: 'tst_itemid' },
          tst_hidden: { entitySet: 'tst_hiddens', idColumn: 'tst_hiddenid' },
        },
        tables: {
          tst_item: [{ tst_itemid: ROW, tst_name: 'Invented item' }],
          tst_hidden: [{ tst_hiddenid: ROW }],
        },
        settings: { permissionMode: 'permissive' },
      },
    }),
  );
}

test('a pcf-entity-logical-name request resolves a logical name only; without the header only the entity set name resolves', async (t) => {
  const app = await portal(t);
  const read = async (segment, header) => {
    const response = await fetch(`${app.url}/_api/${segment}?$select=tst_name`, {
      headers: { accept: '*/*', ...(header ? { 'pcf-entity-logical-name': header } : {}) },
    });
    const body = await response.json();
    return [response.status, body.error?.code ?? body.tst_name];
  };
  assert.deepEqual(await read(`tst_item(${ROW})`, 'tst_item'), [200, 'Invented item']);
  assert.deepEqual(await read(`tst_items(${ROW})`), [200, 'Invented item']);
  assert.deepEqual(await read(`tst_item(${ROW})`), [400, '9004010A']);
  assert.deepEqual(await read(`tst_items(${ROW})`, 'tst_item'), [400, '9004010A']);
  // An unknown table with the header answers 400 9004010A, a known table without Web API settings 404 9004010C.
  assert.deepEqual(await read('tst_nosuchtable', 'tst_nosuchtable'), [400, '9004010A']);
  assert.deepEqual(await read('tst_hidden', 'tst_hidden'), [404, '9004010C']);
});
