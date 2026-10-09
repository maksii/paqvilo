import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
import { DataStore } from '../lib/data.mjs';

test('queued state replacement compares freshness inside transaction and preserves earlier edits', async () => {
  const store = await new DataStore().init();
  const before = JSON.stringify(store.snapshot());
  const edit = store.transact(() => { store.state.settings.changed = true; });
  const replace = store.replaceState(store.snapshot(), { expectedSnapshot: before });
  await edit; await assert.rejects(replace, error => error.code === 'StateConflict');
  assert.equal(store.snapshot().settings.changed, true);
});

test('portal API applies 5000/default and Prefer paging, follows signed cursors, rejects changed persona/data/query and skip', { timeout: 30000 }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'odata-pages-')); let app;
  t.after(async () => { await app?.close(); await fs.rm(directory, { recursive: true, force: true }); });
  await fs.writeFile(path.join(directory, 'website.yml'), 'adx_websiteid: site\nadx_name: Paging');
  await fs.writeFile(path.join(directory, 'sitesetting.yml'), '- adx_name: Webapi/item/enabled\n  adx_value: true\n- adx_name: Webapi/item/fields\n  adx_value: itemid,name,owner');
  app = await createSimulator({ sourceDir: directory, watch: false, initial: {
    mappings: { item: { entitySet: 'items', idColumn: 'itemid' } },
    tables: { item: Array.from({ length: 6001 }, (_, index) => ({ itemid: String(index).padStart(5, '0'), name: 'Row ' + index, owner: index === 6000 ? 'other' : 'person' })) },
    permissions: [{ entity: 'item', roles: ['Reader'], scope: 'contact', field: 'owner', operations: ['read'] }],
    simulator: { identityScope: 'configured', identity: { id: 'person', roles: ['Reader'] } },
  } });
  const read = async (url, prefer) => { const response = await fetch(new URL(url, app.url), { headers: prefer ? { Prefer: prefer } : {} }); return { status: response.status, body: await response.json(), preference: response.headers.get('Preference-Applied') }; };
  const first = await read('/_api/items?$select=itemid,name&$count=true');
  assert.equal(first.status, 200); assert.equal(first.body.value.length, 5000); assert.equal(first.body['@odata.count'], 5000);
  const second = await read(first.body['@odata.nextLink']); assert.equal(second.body.value.length, 1000); assert.equal(second.body['@odata.nextLink'], undefined);
  assert.equal(new Set([...first.body.value, ...second.body.value].map(row => row.itemid)).size, 6000);
  const top = await read('/_api/items?$select=itemid&$top=1', 'odata.maxpagesize=2'); assert.equal(top.body.value.length, 1); assert.equal(top.body['@odata.nextLink'], undefined);
  const small = await read('/_api/items?$select=itemid', 'odata.maxpagesize=2'); assert.equal(small.body.value.length, 2); assert.equal(small.preference, null); // sandbox sends no Preference-Applied header
  assert.equal((await read(small.body['@odata.nextLink'])).body.value.length, 2);
  const bounded = await read('/_api/items?$select=itemid&$top=3', 'odata.maxpagesize=2');
  const boundedNext = await read(bounded.body['@odata.nextLink']);
  assert.equal(boundedNext.body.value.length, 1); assert.equal(boundedNext.body['@odata.nextLink'], undefined);
  assert.equal((await read('/_api/items?$top=1')).body.value.length, 1);
  assert.equal((await read('/_api/items?$skip=1')).status, 400);
  const altered = new URL(small.body['@odata.nextLink']); altered.searchParams.set('$filter', "name eq 'Row 2'"); assert.equal((await read(altered.href)).status, 400);
  const state = app.store.snapshot(); state.simulator.identity.id = 'other'; await app.store.replaceState(state);
  assert.equal((await read(small.body['@odata.nextLink'])).status, 400);
  state.simulator.identity.id = 'person'; state.tables.item.push({ itemid: 'new', owner: 'person' }); await app.store.replaceState(state);
  assert.equal((await read(small.body['@odata.nextLink'])).status, 400);
});
