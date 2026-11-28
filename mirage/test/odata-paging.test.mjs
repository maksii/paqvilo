// @test-kind contract: the simulator defines its DataStore queue and portal paging-cursor contracts.
import test from 'node:test';
import { createHmac } from 'node:crypto';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
import { DataStore } from '../lib/data.mjs';
import { ownedFixture, ownedClose, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('queued state replacement compares freshness inside transaction and preserves earlier edits', async () => {
  const store = await new DataStore().init();
  const before = JSON.stringify(store.snapshot());
  const edit = store.transact(() => {
    store.state.settings.changed = true;
  });
  const replace = store.replaceState(store.snapshot(), { expectedSnapshot: before });
  await edit;
  await assert.rejects(replace, (error) => error.code === 'StateConflict');
  assert.equal(store.snapshot().settings.changed, true);
});

// @test-kind security+contract: portal cursors bind the request and state and use a key separate from the browser's request token.
test('portal API applies 5000/default and Prefer paging, follows signed cursors, rejects changed persona/data/query and skip', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'odata-pages-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'website.yml'), 'adx_websiteid: site\nadx_name: Paging');
  await fs.writeFile(
    path.join(directory, 'sitesetting.yml'),
    '- adx_name: Webapi/item/enabled\n  adx_value: true\n- adx_name: Webapi/item/fields\n  adx_value: itemid,name,owner',
  );
  const app = ownedClose(
    t,
    await createSimulator({
      sourceDir: directory,
      watch: false,
      initial: {
        mappings: { item: { entitySet: 'items', idColumn: 'itemid' } },
        tables: {
          item: Array.from({ length: 6001 }, (_, index) => ({
            itemid: String(index).padStart(5, '0'),
            name: 'Row ' + index,
            owner: index === 6000 ? 'other' : 'person',
          })),
        },
        permissions: [{ entity: 'item', roles: ['Reader'], scope: 'contact', field: 'owner', operations: ['read'] }],
        simulator: { identityScope: 'configured', identity: { id: 'person', roles: ['Reader'] } },
      },
    }),
  );
  const read = async (url, prefer) => {
    const response = await fetch(new URL(url, app.url), { headers: prefer ? { Prefer: prefer } : {} });
    return {
      status: response.status,
      body: await response.json(),
      preference: response.headers.get('Preference-Applied'),
    };
  };
  const first = await read('/_api/items?$select=itemid,name&$count=true');
  assert.equal(first.status, 200);
  assert.equal(first.body.value.length, 5000);
  assert.equal(first.body['@odata.count'], 5000);
  const continuation = new URL(first.body['@odata.nextLink']);
  const [payload, signature] = continuation.searchParams.get('$skiptoken').split('.');
  const browserTokenDigest = createHmac('sha256', app.portalToken).update(payload).digest('base64url');
  assert.ok(signature !== browserTokenDigest, 'the browser request token must not be the continuation signing key');
  const second = await read(continuation);
  assert.equal(second.body.value.length, 1000);
  assert.equal(second.body['@odata.nextLink'], undefined);
  assert.equal(new Set([...first.body.value, ...second.body.value].map((row) => row.itemid)).size, 6000);
  const top = await read('/_api/items?$select=itemid&$top=1', 'odata.maxpagesize=2');
  assert.equal(top.body.value.length, 1);
  assert.equal(top.body['@odata.nextLink'], undefined);
  // A Contact-scope read is paged by odata.maxpagesize without $top too (hosted session F1 summary-F1 API-02c, two runs);
  // only a Global-scope read without $top ignores it (webapi-hosted-f1-observation.test.mjs).
  const scoped = await read("/_api/items?$select=itemid&$filter=itemid lt '00009'", 'odata.maxpagesize=2');
  assert.equal(scoped.status, 200);
  assert.equal(scoped.body.value.length, 2);
  assert.ok(scoped.body['@odata.nextLink']);
  // $top larger than the row count keeps later pages, whose signed cursor the refusals below follow.
  const small = await read('/_api/items?$select=itemid&$top=6000', 'odata.maxpagesize=2');
  assert.equal(small.body.value.length, 2);
  assert.equal(small.preference, null); // sandbox sends no Preference-Applied header
  assert.equal((await read(small.body['@odata.nextLink'])).body.value.length, 2);
  const bounded = await read('/_api/items?$select=itemid&$top=3', 'odata.maxpagesize=2');
  const boundedNext = await read(bounded.body['@odata.nextLink']);
  assert.equal(boundedNext.body.value.length, 1);
  assert.equal(boundedNext.body['@odata.nextLink'], undefined);
  assert.equal((await read('/_api/items?$top=1')).body.value.length, 1);
  assert.equal((await read('/_api/items?$skip=1')).status, 400);
  const altered = new URL(small.body['@odata.nextLink']);
  altered.searchParams.set('$filter', "name eq 'Row 2'");
  assert.equal((await read(altered.href)).status, 400);
  const state = app.store.snapshot();
  state.simulator.identity.id = 'other';
  await app.store.replaceState(state);
  assert.equal((await read(small.body['@odata.nextLink'])).status, 400);
  state.simulator.identity.id = 'person';
  state.tables.item.push({ itemid: 'new', owner: 'person' });
  await app.store.replaceState(state);
  assert.equal((await read(small.body['@odata.nextLink'])).status, 400);
});

// @test-kind security: generated cursor predicates retain row enforcement without admitting undeclared client operands.
test('an exempt wildcard cursor can continue a server-scoped read with a field absent from the Solution', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'odata-scope-cursor-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, 'website.yml'), 'adx_websiteid: site\nadx_name: Paging');
  await fs.writeFile(
    path.join(directory, 'sitesetting.yml'),
    '- adx_name: Webapi/item/enabled\n  adx_value: true\n- adx_name: Webapi/item/fields\n  adx_value: "*"',
  );
  const app = ownedClose(
    t,
    await createSimulator({
      sourceDir: directory,
      watch: false,
      observed: { webApiWildcard: 'exempt', evidence: 'Invented scoped cursor fixture' },
      initial: {
        mappings: {
          item: {
            entitySet: 'items',
            idColumn: 'itemid',
            schemaComplete: true,
            fields: { name: { dataverseType: 'nvarchar' } },
          },
        },
        tables: {
          item: [
            { itemid: 'a', name: 'Alpha', memberid: 'person' },
            { itemid: 'b', name: 'Beta', memberid: 'person' },
            { itemid: 'c', name: 'Gamma', memberid: 'other' },
          ],
        },
        permissions: [{ entity: 'item', roles: ['Reader'], scope: 'contact', field: 'memberid', operations: ['read'] }],
        simulator: { identityScope: 'configured', identity: { id: 'person', roles: ['Reader'] } },
      },
    }),
  );
  const request = (url) => fetch(new URL(url, app.url), { headers: { Prefer: 'odata.maxpagesize=1' } });
  const route = '/_api/items?$select=itemid,name&$orderby=name';
  const first = await request(route);
  assert.equal(first.status, 200);
  const firstPage = await first.json();
  assert.deepEqual(
    firstPage.value.map((row) => row.name),
    ['Alpha'],
  );
  const next = await request(firstPage['@odata.nextLink']);
  assert.equal(next.status, 200, await next.clone().text());
  const finalPage = await next.json();
  assert.deepEqual(
    finalPage.value.map((row) => row.name),
    ['Beta'],
  );
  assert.equal(finalPage['@odata.nextLink'], undefined);
  const altered = new URL(firstPage['@odata.nextLink']);
  altered.searchParams.set('$filter', "memberid eq 'person'");
  const namedWithCursor = await request(altered);
  assert.equal(namedWithCursor.status, 400);
  assert.equal(namedWithCursor.headers.get('X-Sim-Error-Code'), 'InvalidAttribute');
  altered.searchParams.delete('$filter');
  const [claim, signature] = altered.searchParams.get('$skiptoken').split('.');
  const otherFirstCharacter = signature[0] === 'A' ? 'B' : 'A';
  altered.searchParams.set('$skiptoken', [claim, otherFirstCharacter + signature.slice(1)].join('.'));
  const tampered = await request(altered);
  assert.equal(tampered.status, 400);
  assert.equal(tampered.headers.get('X-Sim-Error-Code'), 'InvalidPagingToken');
  const named = await request(route + "&$filter=memberid eq 'person'");
  assert.equal(named.status, 400);
  assert.equal(named.headers.get('X-Sim-Error-Code'), 'InvalidAttribute');
});
