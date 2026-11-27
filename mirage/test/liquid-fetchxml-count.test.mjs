import assert from 'node:assert/strict';
import test from 'node:test';
import { drainFixture } from '../testing/owned-fixture.mjs';
import { monitorPortal, monitorState, startMonitorRuntime } from './support/monitor-runtime.mjs';
import { endedTree } from './support/trace-scenario.mjs';

const fetchXml = (attributes) =>
  `<fetch${attributes}><entity name="x_item"><attribute name="x_itemid" /><order attribute="x_itemid" /></entity></fetch>`;
const variants = {
  zero: 'count="0"',
  one: 'count="1"',
  second: 'count="0" page="2"',
  zeroTotal: 'count="0" returntotalrecordcount="true"',
  omittedTotal: 'returntotalrecordcount="true"',
  zeroTop: 'count="0" top="1"',
  omittedTop: 'top="1"',
  invalidTop: 'count="0" top="abc"',
  outOfRangeTop: 'count="0" top="5001"',
  negative: 'count="-1"',
  malformed: 'count="abc"',
};
const id = (n) => `11111111-1111-4111-8111-${String(n).padStart(12, '0')}`;

async function startInventory(t, { count = 3, deny = false, observed } = {}) {
  const closers = [];
  t.after(() => drainFixture(closers));
  const cases = Object.entries(variants)
    .map(([variant, attrs]) => `{% when '${variant}' %} ${attrs}`)
    .join('');
  const attributes = `{% capture attributes %}{% case request.params.variant %}${cases}{% endcase %}{% endcapture %}`;
  const continuation = `{% if request.params.cookie %} paging-cookie="{{ request.params.cookie | escape }}" page="2"{% endif %}`;
  const result = `{"totalCount":{{ widgets.results.entities.size | json }},"moreRecords":{{ widgets.results.more_records | json }},"totalRecordCount":{{ widgets.results.total_record_count | json }},"limitExceeded":{{ widgets.results.total_record_count_limit_exceeded | json }},"cookie":"{{ widgets.results.paging_cookie | url_encode }}","firstId":{{ widgets.results.entities.first.x_itemid | json }},"hasZeroCount":{% if widgets.xml contains 'count="0"' %}true{% else %}false{% endif %},"hasTop":{% if widgets.xml contains 'top=' %}true{% else %}false{% endif %},"granted":{{ widgets.permission_granted | json }}}`;
  const source = `${attributes}{% fetchxml widgets %}${fetchXml(`{{ attributes }}${continuation}`)}{% endfetchxml %}{% if request.params.mode == 'preview' %}"{{ widgets.xml | url_encode }}"{% else %}${result}{% endif %}`;
  const files = monitorPortal({ name: 'Inventory', fields: 'x_itemid', source });
  files['Main.pagetemplate.yml'] += '\nadx_usewebsiteheaderandfooter: false';
  files['Main.webtemplate.yml'] += '\nadx_mimetype: application/json';
  const state = monitorState({ rows: Array.from({ length: count }, (_, n) => ({ x_itemid: id(n + 1) })) });
  state.settings.permissionMode = 'enforce';
  if (!deny)
    state.permissions.push({
      id: 'read-inventory',
      entity: 'x_item',
      scope: 'global',
      operations: ['read'],
      roleIds: ['anonymous'],
    });
  const { sim } = await startMonitorRuntime(closers, {
    prefix: 'liquid-fetchxml-count-',
    files,
    state,
    observed,
  });
  return sim;
}

async function liquidBody(origin, variant, cookie) {
  const params = new URLSearchParams({ variant, ...(cookie ? { cookie } : {}) });
  const response = await fetch(`${origin}/?${params}`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /^application\/json(?:;|$)/);
  return response.text();
}

// @test-kind observation: consumer report 255 and two signed-in Power Pages developer fixture captures compare omitted and zero count over the same three rows.
test('Liquid FetchXML count zero uses the default page size for readable records', async (t) => {
  const { url: origin } = await startInventory(t);
  const omitted = JSON.parse(await liquidBody(origin, 'omitted'));
  const one = JSON.parse(await liquidBody(origin, 'one'));
  const zero = JSON.parse(await liquidBody(origin, 'zero'));
  const second = JSON.parse(await liquidBody(origin, 'second'));
  assert.deepEqual([omitted.totalCount, omitted.moreRecords], [3, false]);
  assert.deepEqual([one.totalCount, one.moreRecords], [1, true]);
  assert.deepEqual([zero.totalCount, zero.moreRecords], [3, false]);
  assert.equal(zero.hasZeroCount, true);
  assert.deepEqual([second.totalCount, second.moreRecords], [0, false]);
});

const lazyNative = {
  liquidFetchExecution: 'lazy-query-drop',
  tablePermissionQueryPipeline: 'native-classic',
  evidence: 'Synthetic test exercises the optional deferred Liquid execution and classic permission pipeline.',
};

// @test-kind contract: deferred Liquid reads keep a bounded default page and the permission compiler gates access.
test('deferred Liquid count zero obeys the default cap and continues on page two using its generated cookie', async (t) => {
  const { url: origin } = await startInventory(t, { count: 5001, observed: lazyNative });
  const omitted = JSON.parse(await liquidBody(origin, 'omittedTotal'));
  const zero = JSON.parse(await liquidBody(origin, 'zeroTotal'));
  assert.deepEqual(zero, { ...omitted, hasZeroCount: true });
  assert.deepEqual(
    [zero.totalCount, zero.moreRecords, zero.totalRecordCount, zero.limitExceeded],
    [5000, true, 5000, true],
  );
  assert.equal(zero.granted, true);
  assert.equal(zero.firstId, id(1));
  const cookie = decodeURIComponent(zero.cookie.replaceAll('+', ' '));
  assert.match(cookie, /<cookie /);
  const second = JSON.parse(await liquidBody(origin, 'zeroTotal', cookie));
  assert.deepEqual([second.totalCount, second.moreRecords, second.firstId], [1, false, id(5001)]);
});

// @test-kind contract: deferred Liquid count zero grants no access beyond the role's table permissions.
test('deferred Liquid count zero leaves a denied query empty and retains its authored XML', async (t) => {
  const { url: origin } = await startInventory(t, { deny: true, observed: lazyNative });
  const zero = JSON.parse(await liquidBody(origin, 'zero'));
  assert.deepEqual([zero.totalCount, zero.moreRecords, zero.granted, zero.hasZeroCount], [0, false, false, true]);
});

// @test-kind contract: a deferred Liquid query compiles its XML without reading rows and reuses its first result.
test('deferred count zero preview does not execute a read and repeated result lookups execute once', async (t) => {
  const sim = await startInventory(t, { observed: lazyNative });
  const preview = await fetch(`${sim.url}/?variant=zero&mode=preview`);
  assert.match(decodeURIComponent((await preview.json()).replaceAll('+', ' ')), /count="0"/);
  const previewTrace = await endedTree(sim.trace, preview.headers.get('x-trace-id'));
  assert.equal(previewTrace.spans.filter((span) => span.kind === 'read').length, 0);
  const response = await fetch(`${sim.url}/?variant=zero`);
  const result = await response.json();
  assert.deepEqual([result.totalCount, result.firstId, result.moreRecords], [3, id(1), false]);
  const resultTrace = await endedTree(sim.trace, response.headers.get('x-trace-id'));
  assert.equal(resultTrace.spans.filter((span) => span.kind === 'read').length, 1);
});

// @test-kind observation: two Power Pages developer fixture captures omit a positive authored top with count zero and with count omitted.
test('observed Liquid top conversion drops the authored limit in eager and deferred queries', async (t) => {
  for (const liquidFetchExecution of ['eager', 'lazy-query-drop']) {
    const { url: origin } = await startInventory(t, {
      observed: { ...lazyNative, liquidFetchExecution, liquidFetchTop: 'drop-valid' },
    });
    for (const [variant, hasZeroCount] of [
      ['omittedTop', false],
      ['zeroTop', true],
    ]) {
      const result = JSON.parse(await liquidBody(origin, variant));
      assert.deepEqual(
        [result.totalCount, result.totalRecordCount, result.moreRecords, result.hasTop, result.hasZeroCount],
        [3, -1, false, false, hasZeroCount],
      );
    }
    if (liquidFetchExecution === 'lazy-query-drop') {
      const reply = await fetch(`${origin}/?variant=zeroTop&mode=preview`);
      const xml = decodeURIComponent((await reply.json()).replaceAll('+', ' '));
      assert.match(xml, /count="0"/);
      assert.doesNotMatch(xml, /\btop=/);
    }
  }
});

// @test-kind contract: opt-in Liquid top conversion retains invalid-attribute diagnostics and leaves Web API top applied.
test('observed Liquid top conversion preserves invalid inputs and leaves Web API and positive counts independent', async (t) => {
  const { url: origin } = await startInventory(t, { observed: { ...lazyNative, liquidFetchTop: 'drop-valid' } });
  const one = JSON.parse(await liquidBody(origin, 'one'));
  assert.deepEqual([one.totalCount, one.moreRecords], [1, true]);
  assert.match(
    await liquidBody(origin, 'invalidTop'),
    /Liquid error: The 'top' attribute value 'abc' is not a valid integer/,
  );
  assert.match(await liquidBody(origin, 'outOfRangeTop'), /Liquid error: The 'top' attribute can't exceed 5000/);
  const api = await fetch(`${origin}/_api/x_items?fetchXml=${encodeURIComponent(fetchXml(' top="1"'))}`);
  assert.equal(api.status, 200);
  assert.equal((await api.json()).value.length, 1);
});

// @test-kind contract: accepting count zero in Liquid preserves separate query validation on other inputs and surfaces.
test('negative and malformed Liquid counts and the portal Web API zero still fail validation', async (t) => {
  const { url: origin } = await startInventory(t);
  const omittedTop = JSON.parse(await liquidBody(origin, 'omittedTop'));
  assert.deepEqual([omittedTop.totalCount, omittedTop.totalRecordCount, omittedTop.hasTop], [1, -1, true]);
  assert.match(await liquidBody(origin, 'zeroTop'), /Liquid error: The FetchXML top attribute can't be combined/);
  assert.match(
    await liquidBody(origin, 'negative'),
    /Liquid error: The 'count' attribute value '-1' is not a valid integer/,
  );
  assert.match(
    await liquidBody(origin, 'malformed'),
    /Liquid error: The 'count' attribute value 'abc' is not a valid integer/,
  );
  const api = await fetch(`${origin}/_api/x_items?fetchXml=${encodeURIComponent(fetchXml(' count="0"'))}`);
  assert.equal(api.status, 400);
  assert.equal((await api.json()).error.code, '9004010D');
});
