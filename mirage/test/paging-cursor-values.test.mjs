// @test-kind contract: FetchXML paging cookies are Paqvilo's designed runtime behaviour for resuming a page by value
// Value-based paging cursor: the paging cookie carries the order-column values and the primary key of the page's last
// row, so forward paging skips nothing when the cursor row is deleted or updated out of the filter between pages
// (as documented under "Ordering and paging").
import test from 'node:test';
import assert from 'node:assert/strict';
import { keysetPage } from '../lib/data.mjs';
import { decodeSkipToken } from '../lib/dataverse-odata.mjs';
import { executeFetch, parseXmlDocument, planFetch } from '../lib/fetchxml-engine.mjs';
import { readFixture } from './read-projection-fixture.mjs';

const id = (n) => `77777777-7777-4777-8777-${String(n).padStart(12, '0')}`;
const mappings = {
  x_item: {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_rank: { dataverseType: 'int' },
      x_group: { dataverseType: 'int' },
    },
  },
};
const rows = Array.from({ length: 6 }, (_, i) => ({
  x_itemid: id(i + 1),
  x_name: `n${i + 1}`,
  x_rank: i + 1,
  x_group: i % 2,
  statecode: 0,
  statuscode: 1,
}));
const relative = (link) => link.replace(/^.*\/api\/data\/v9\.2/, '');

async function pager(t) {
  const f = await readFixture(t, { mappings, tables: { x_item: rows } });
  const page = async (url) => f.json(await f.request('GET', url, undefined, { prefer: 'odata.maxpagesize=2' }), 200);
  return { f, page };
}

for (const [label, order, expected] of [
  ['default', '', ['n1', 'n2', 'n3', 'n4']],
  ['asc', '&$orderby=x_rank asc', ['n1', 'n2', 'n3', 'n4']],
  ['desc', '&$orderby=x_name desc', ['n6', 'n5', 'n4', 'n3']],
]) {
  test(`deleting the cursor row between pages skips nothing (${label})`, async (t) => {
    const { f, page } = await pager(t);
    const first = await page(`/x_items?$select=x_name${order}`);
    assert.equal((await f.request('DELETE', `/x_items(${first.value.at(-1).x_itemid})`)).status, 204);
    const second = await page(relative(first['@odata.nextLink']));
    assert.deepEqual(
      [...first.value, ...second.value].map((row) => row.x_name),
      expected,
    );
  });
}

test('updating the cursor row out of the filter between pages skips nothing', async (t) => {
  const { f, page } = await pager(t);
  const first = await page('/x_items?$select=x_name&$orderby=x_rank asc&$filter=x_rank lt 100');
  assert.equal((await f.request('PATCH', `/x_items(${first.value.at(-1).x_itemid})`, { x_rank: 500 })).status, 200);
  const second = await page(relative(first['@odata.nextLink']));
  assert.deepEqual(
    second.value.map((row) => row.x_name),
    ['n3', 'n4'],
  );
});

test('cookie carries the order-column values for multi-column $orderby', async (t) => {
  const { page } = await pager(t);
  const first = await page('/x_items?$select=x_name&$orderby=x_group desc,x_rank asc');
  const token = decodeURIComponent(first['@odata.nextLink'].split('$skiptoken=')[1]);
  const cookie = decodeSkipToken(token);
  assert.deepEqual(cookie.orderValues, { x_group: '1', x_rank: '4' });
  assert.equal(cookie.lastId, id(4));
  const second = await page(relative(first['@odata.nextLink']));
  assert.deepEqual(
    [...first.value, ...second.value].map((row) => row.x_name),
    ['n2', 'n4', 'n6', 'n1'],
  );
});

test('keysetPage resumes after saved values when the cursor row is gone', () => {
  const data = [5, 3, 9, 1, 7].map((rank, i) => ({ id: id(i), rank }));
  const options = {
    mapping: { idColumn: 'id' },
    valueOf: (row, path) => row[path[0]],
    definition: () => ({ dataverseType: 'int' }),
  };
  const page = keysetPage(
    data,
    [{ path: ['rank'], descending: false }],
    options,
    { id: id(99), values: { rank: '3' } },
    2,
  );
  assert.deepEqual(
    page.rows.map((row) => row.rank),
    [5, 7],
  );
  assert.equal(page.before, 2);
});

test('FetchXML paging cookie survives cursor-row delete', async (t) => {
  const { f } = await pager(t);
  const fetch = (cookie, pageNumber) =>
    `<fetch count="2" page="${pageNumber}"${cookie ? ` paging-cookie="${cookie.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')}"` : ''}><entity name="x_item"><attribute name="x_name"/><order attribute="x_rank"/></entity></fetch>`;
  const read = async (xml) =>
    f.json(
      await f.request('GET', `/x_items?fetchXml=${encodeURIComponent(xml)}`, undefined, {
        prefer: 'odata.include-annotations="*"',
      }),
      200,
    );
  const first = await read(fetch(null, 1));
  const wrapper = first['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie'];
  const cookie = decodeURIComponent(decodeURIComponent(/pagingcookie="([^"]*)"/.exec(wrapper)[1]));
  assert.equal((await f.request('DELETE', `/x_items(${first.value.at(-1).x_itemid})`)).status, 204);
  const second = await read(fetch(cookie, 2));
  assert.deepEqual(
    [...first.value, ...second.value].map((row) => row.x_name),
    ['n1', 'n2', 'n3', 'n4'],
  );
});

// A null order value travels as the empty marker the OData skip token uses and resumes nulls first ascending: every row is
// paged once, with and without the page-1 cursor row deleted.
test('FetchXML paging cookie with a null order value pages every row once', async (t) => {
  const nullable = [null, 2, null, 1, null, 3].map((x_rank, i) => ({
    x_itemid: id(i + 1),
    x_name: 'abcdef'[i],
    x_rank,
    statecode: 0,
    statuscode: 1,
  }));
  for (const removeCursor of [false, true]) {
    const f = await readFixture(t, { mappings, tables: { x_item: structuredClone(nullable) } });
    const escape = (text) =>
      text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const xml = (cookie, n) =>
      `<fetch count="2" page="${n}"${cookie ? ` paging-cookie="${escape(cookie)}"` : ''}><entity name="x_item"><attribute name="x_name"/><order attribute="x_rank"/></entity></fetch>`;
    const read = async (text) =>
      f.json(
        await f.request('GET', `/x_items?fetchXml=${encodeURIComponent(text)}`, undefined, {
          prefer: 'odata.include-annotations="*"',
        }),
        200,
      );
    let page = await read(xml(null, 1));
    const seen = page.value.map((row) => row.x_name);
    if (removeCursor) assert.equal((await f.request('DELETE', `/x_items(${page.value.at(-1).x_itemid})`)).status, 204);
    for (let n = 2; page['@Microsoft.Dynamics.CRM.morerecords'] && n < 6; n++) {
      const cookie = decodeURIComponent(
        decodeURIComponent(/pagingcookie="([^"]*)"/.exec(page['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie'])[1]),
      );
      page = await read(xml(cookie, n));
      seen.push(...page.value.map((row) => row.x_name));
    }
    // Nulls first ascending (a, c, e), then 1, 2, 3 (d, b, f).
    assert.deepEqual(seen, ['a', 'c', 'e', 'd', 'b', 'f'], removeCursor ? 'cursor row deleted' : 'control');
  }
});

// Engine level: the cookie holds every value as text, so page 2 resumed from page 1's cookie must match page 2 by offset
// for each order column type.
const cookieRows = Array.from({ length: 6 }, (_, i) => ({
  x_itemid: id(i + 1),
  x_name: `n${i + 1}`,
  x_rank: i + 1,
  flag: i % 2 === 0,
  created: `2024-03-0${i + 1}T10:00:00Z`,
}));
const escapeAttribute = (text) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function enginePage({ order, definitions = {}, page, cookie = null, rows = cookieRows, settings = {}, count = 2 }) {
  const xml = `<fetch count="${count}" page="${page}"${cookie ? ` paging-cookie="${escapeAttribute(cookie)}"` : ''}><entity name="x_item"><attribute name="x_name"/>${order}</entity></fetch>`;
  const plan = planFetch(parseXmlDocument(xml, { root: 'fetch' }), { profile: 'webapi' });
  return executeFetch(plan, {
    mapping: () => ({ logicalName: 'x_item', idColumn: 'x_itemid', relationships: {} }),
    readableRows: () => structuredClone(rows),
    tableRows: () => structuredClone(rows),
    definition: (logical, attribute) => definitions[logical]?.[attribute],
    identity: {},
    settings,
  });
}
const names = (result) => result.entities.map((entity) => entity.x_name);
const bitColumn = { x_item: { flag: { dataverseType: 'bit' } } };

test('FetchXML paging cookie text is unchanged for an integer order column', () => {
  const first = enginePage({ order: '<order attribute="x_rank"/>', page: 1 });
  assert.equal(
    first.paging_cookie,
    '<cookie page="1"><x_rank last="2" first="1" /><x_itemid last="{77777777-7777-4777-8777-000000000002}" first="{77777777-7777-4777-8777-000000000001}" /></cookie>',
  );
});

for (const [label, order, definitions, expected] of [
  ['two-options ascending', '<order attribute="flag"/>', bitColumn, ['n6', 'n1']],
  ['two-options descending', '<order attribute="flag" descending="true"/>', bitColumn, ['n5', 'n2']],
  ['integer without metadata ascending', '<order attribute="x_rank"/>', {}, ['n3', 'n4']],
  ['integer without metadata descending', '<order attribute="x_rank" descending="true"/>', {}, ['n4', 'n3']],
  ['text ascending', '<order attribute="x_name"/>', {}, ['n3', 'n4']],
  [
    'datetime ascending',
    '<order attribute="created"/>',
    { x_item: { created: { dataverseType: 'datetime' } } },
    ['n3', 'n4'],
  ],
]) {
  test(`FetchXML paging cookie page 2 equals page 2 by offset: ${label}`, () => {
    const first = enginePage({ order, definitions, page: 1 });
    const byCookie = enginePage({ order, definitions, page: 2, cookie: first.paging_cookie });
    const byOffset = enginePage({ order, definitions, page: 2 });
    assert.deepEqual(names(byOffset), expected, 'offset page 2');
    assert.deepEqual(names(byCookie), names(byOffset), 'cookie page 2');
  });
}

// Local datetimes without a zone designator, one hour apart. With a 300-minute offset every row key sits five rows away
// from where the same stored text would sit at offset 0, so the cookie's cursor must use the same offset as the rows.
const zonedRows = Array.from({ length: 8 }, (_, i) => ({
  x_itemid: id(i + 1),
  x_name: `m${i + 1}`,
  x_rank: i + 1,
  created: `2024-03-01T${String(i).padStart(2, '0')}:30:00`,
}));
const zonedDefinitions = { x_item: { created: { dataverseType: 'datetime' } } };
const zonedSettings = { timeZoneOffsetMinutes: 300 };
for (const [label, order, expected] of [
  ['ascending', '<order attribute="created"/>', zonedRows.map((row) => row.x_name)],
  ['descending', '<order attribute="created" descending="true"/>', zonedRows.map((row) => row.x_name).toReversed()],
]) {
  test(`FetchXML datetime paging cookie with a time zone offset pages every row once: ${label}`, () => {
    const options = { order, definitions: zonedDefinitions, settings: zonedSettings, rows: zonedRows };
    const byOffset = [1, 2, 3, 4].map((page) => names(enginePage({ ...options, page })));
    const byCookie = [];
    let cookie = null;
    for (let page = 1; page <= 4; page++) {
      const result = enginePage({ ...options, page, cookie });
      byCookie.push(names(result));
      cookie = result.paging_cookie;
    }
    assert.deepEqual(byCookie, byOffset, 'cookie pages equal offset pages');
    assert.deepEqual(byCookie.flat(), expected, 'no row skipped or repeated');
  });
}

// Date-only values (no time, no zone) on four consecutive days: three rows on each of the first three days and two on
// the fourth. Rows on one date tie and are ordered by the primary key, which is not in list order. With page size 2 the
// page boundaries fall inside a date (after the 2nd and 4th rows) and between two adjacent dates (after the 6th row).
const dateOnlyDays = ['2024-03-01', '2024-03-02', '2024-03-03', '2024-03-04'];
const dateOnlyRows = dateOnlyDays.flatMap((day, dayIndex) =>
  Array.from({ length: dayIndex === 3 ? 2 : 3 }, (_, k) => {
    const index = dayIndex * 3 + k; // 0..10
    return {
      x_itemid: id(((index * 5) % 11) + 1),
      x_name: `d${dayIndex + 1}r${k + 1}`,
      created: day,
    };
  }),
);
const dateOnlyDefinitions = { x_item: { created: { dataverseType: 'datetime', dateTimeBehavior: 'dateonly' } } };
for (const offset of [840, -720, 300]) {
  for (const [label, order] of [
    ['ascending', '<order attribute="created"/>'],
    ['descending', '<order attribute="created" descending="true"/>'],
  ]) {
    test(`FetchXML date-only paging cookie with a ${offset}-minute offset pages every row once: ${label}`, () => {
      const options = {
        order,
        definitions: dateOnlyDefinitions,
        settings: { timeZoneOffsetMinutes: offset },
        rows: dateOnlyRows,
      };
      const reference = names(enginePage({ ...options, page: 1, count: 100 }));
      assert.equal(reference.length, dateOnlyRows.length);
      const byOffset = [1, 2, 3, 4, 5, 6].map((page) => names(enginePage({ ...options, page })));
      const byCookie = [];
      let cookie = null;
      for (let page = 1; page <= 6; page++) {
        const result = enginePage({ ...options, page, cookie });
        byCookie.push(names(result));
        cookie = result.paging_cookie;
      }
      assert.deepEqual(byCookie, byOffset, 'cookie pages equal offset pages');
      assert.deepEqual(byCookie.flat(), reference, 'no row skipped or repeated');
    });
  }
}
