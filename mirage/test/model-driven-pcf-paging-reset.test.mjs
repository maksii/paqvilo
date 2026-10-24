import test from 'node:test';
import assert from 'node:assert/strict';
import { createDatasetHost } from '../lib/model-driven/pcf-runtime.mjs';

// paging.reset: "Reload the results from the server, and reset to page 1."
test('PCF dataset paging.reset reloads page one through the dataset lifecycle', async () => {
  const rows = Array.from({ length: 5 }, (_, index) => ({
    x_itemid: `77777777-7777-4777-8777-77777777770${index}`,
    x_name: `Item ${index}`,
  }));
  const pages = [];
  const table = { entity: 'x_item', idColumn: 'x_itemid', nameColumn: 'x_name', fields: { x_name: { type: 'text' } } };
  const { dataset, load } = createDatasetHost({
    table,
    columns: [{ name: 'x_name' }],
    query: async ({ page, pageSize }) => {
      pages.push(page);
      return { rows: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
    },
  });
  const names = () => dataset.sortedRecordIds.map((id) => dataset.records[id].getValue('x_name'));
  dataset.paging.setPageSize(2);
  await load();
  await dataset.paging.loadNextPage();
  assert.deepEqual(names(), ['Item 2', 'Item 3']);
  assert.equal(dataset.paging.hasPreviousPage, true);
  rows.splice(0, 5, { x_itemid: '77777777-7777-4777-8777-777777777799', x_name: 'Fresh' });
  const result = dataset.paging.reset();
  assert.ok(result instanceof Promise);
  await result;
  assert.deepEqual(pages, [1, 2, 1]);
  assert.deepEqual(names(), ['Fresh']);
  assert.equal(dataset.paging.hasPreviousPage, false);
  assert.equal(dataset.loading, false);
});
