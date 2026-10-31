// @test-kind parity: native-r2 faults 5479/5481, pipelineEffects and native asyncRetry: Web API startswith reaches the plug-in Query as like 'p%'; the PagingCookie lists each order column then the primary key
// Invented x_item table only. The plug-in RetrieveMultiple query of a Web API startswith read, and the paging cookie a page carries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { odataToSdkQuery, readPagingCookie } from '../lib/plugin-query.mjs';

const step = (n, message, stage) => ({
  id: `30000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`,
  enabled: true,
  entity: 'x_item',
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.LikeRecorder',
  assemblyId: 'invented',
});

async function fixture(t, seen) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
    },
    tables: { x_item: [] },
    extension: { name: 'like-probe', install: () => {} },
  });
  const steps = [step(1, 'RetrieveMultiple', 20), step(2, 'RetrieveMultiple', 40)];
  const handlers = new Map([
    [
      steps[0].typeName,
      ({ context }) => {
        seen.push({
          message: context.MessageName,
          stage: context.Stage,
          query: context.InputParameters.Query ?? null,
        });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, backend };
}

test('a Web API startswith reaches the plug-in query as a like prefix, and the read keeps the prefix rows', async (t) => {
  const seen = [];
  const f = await fixture(t, seen);
  for (const name of ['Abacus', 'Abbey', 'Bab']) {
    const created = await f.request('POST', '/x_items', { x_name: name });
    assert(created.status < 300, await created.text());
  }
  seen.length = 0;
  const response = await f.request('GET', "/x_items?$select=x_name&$filter=startswith(x_name,'Ab')");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual((await response.json()).value.map((row) => row.x_name).sort(), ['Abacus', 'Abbey']);
  const read = seen.find((entry) => entry.message === 'RetrieveMultiple' && entry.stage === 20);
  assert(read, 'the RetrieveMultiple step ran');
  assert.match(read.query.query, /<condition attribute="x_name" operator="like" value="Ab%" \/>/);
  // The SDK form of the same OData filter carries the Like prefix, not BeginsWith.
  const sdk = odataToSdkQuery('x_item', { $select: 'x_name', $filter: "startswith(x_name,'Ab')" });
  assert.deepEqual(sdk.criteria.conditions, [{ attributeName: 'x_name', operatorName: 'Like', values: ['Ab%'] }]);
});

test('a plug-in paging cookie lists each $orderby column before the primary key, with the last and first row values', () => {
  const query = { $type: 'FetchExpression', query: '<fetch page="1" count="5000"><entity name="x_item" /></fetch>' };
  const ids = ['20000000-0000-0000-0000-0000000000b1', '20000000-0000-0000-0000-0000000000b2'];
  const order = [{ name: 'x_name', first: 'A&<"1', last: 'Abbey' }];
  assert.equal(
    readPagingCookie(query, 'x_itemid', ids, order),
    '<cookie page="1"><x_name last="Abbey" first="A&amp;&lt;&quot;1" /><x_itemid last="{20000000-0000-0000-0000-0000000000B2}" first="{20000000-0000-0000-0000-0000000000B1}" /></cookie>',
  );
  // Without $orderby the cookie keeps the primary key alone.
  assert.equal(
    readPagingCookie(query, 'x_itemid', ids),
    '<cookie page="1"><x_itemid last="{20000000-0000-0000-0000-0000000000B2}" first="{20000000-0000-0000-0000-0000000000B1}" /></cookie>',
  );
});

test('a Web API read ordered by a column hands its PostOperation step a paging cookie with that column first', async (t) => {
  const seen = [];
  const f = await fixture(t, seen);
  // The PostOperation collection as the pipeline hands it to steps (a handler sees only its entities).
  const cookies = [],
    pipeline = f.store.pluginPipeline;
  f.store.pluginPipeline = (context) => {
    if (context.stage === 40 && context.collection) cookies.push(context.collection.pagingCookie);
    return pipeline(context);
  };
  for (const name of ['Abbey', 'Abacus', 'Bab']) {
    const created = await f.request('POST', '/x_items', { x_name: name });
    assert(created.status < 300, await created.text());
  }
  const ids = Object.fromEntries(f.store.tableRows('x_item').map((row) => [row.x_name, row.x_itemid.toUpperCase()]));
  seen.length = 0;
  const response = await f.request('GET', "/x_items?$select=x_name&$filter=startswith(x_name,'Ab')&$orderby=x_name");
  assert.equal(response.status, 200, await response.clone().text());
  assert.deepEqual(cookies, [
    `<cookie page="1"><x_name last="Abbey" first="Abacus" /><x_itemid last="{${ids.Abbey}}" first="{${ids.Abacus}}" /></cookie>`,
  ]);
});
