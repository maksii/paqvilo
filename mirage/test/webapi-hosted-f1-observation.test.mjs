// @test-kind observation: hosted session F1 (paqvilo-developer hosted-f1 summary-F1, runs a and b on one hosted site) and pcf-parity summary-F section 1 (a Global-scope table, runs fa and fb); the requests are restated on the invented replay site of mirage/test/parity/hosted-f1-fixture-site.mjs, not replayed from a case file
// Portal Web API facts of the hosted F1 captures that the portal-webapi/hosted-f1-* replay suites do not state on their
// own: the DisableOdataFilter settings, odata.maxpagesize by permission scope, the native-classic lane serving the read
// shapes the hosted portal served, and the wire headers of every answer.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { makeTemporaryDirectory, ownedFixture, removeFixtureDirectory } from '../testing/owned-fixture.mjs';
import { F1_CONTACT, F1_ROLE, writeHostedF1Site } from './parity/hosted-f1-fixture-site.mjs';

async function site(t, settings = {}, { observed = {}, permissions } = {}) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'webapi-hosted-f1-'));
  ownedFixture(t).remove(() => removeFixtureDirectory(directory));
  const options = await writeHostedF1Site(directory, settings);
  if (permissions) options.initial.permissions = permissions(options.initial.permissions);
  const app = await createSimulator({ ...options, observed: { ...options.observed, ...observed } });
  ownedFixture(t).add(() => app.close());
  const { cookie } = signInHeaders(app, F1_CONTACT, { roles: [F1_ROLE] });
  return async (address, headers = {}) => {
    const response = await fetch(new URL(address, app.url), {
      headers: { accept: 'application/json', cookie, ...headers },
    });
    const text = await response.text();
    const json = /json/i.test(response.headers.get('content-type') ?? '');
    return { status: response.status, headers: response.headers, body: json && text ? JSON.parse(text) : text };
  };
}
const names = (answer) => answer.body.value.map((row) => row.pqf1_name);

test('DisableOdataFilter, site-wide or per table, does not stop $filter (API-01d)', async (t) => {
  for (const settings of [{}, { DisableOdataFilter: 'true' }, { 'Webapi/pqf1_item/disableodatafilter': 'true' }]) {
    const read = await site(t, settings);
    const amount = await read('/_api/pqf1_items?$select=pqf1_name&$filter=pqf1_amount eq 10');
    assert.equal(amount.status, 200);
    assert.deepEqual(names(amount), ['A root'], JSON.stringify(settings));
    const prefix = await read(
      "/_api/pqf1_items?$select=pqf1_name&$filter=startswith(pqf1_name,'A ')&$orderby=pqf1_name",
    );
    assert.deepEqual(names(prefix), ['A child 1', 'A child 2', 'A grandchild', 'A root']);
  }
});

test('odata.maxpagesize pages a permission-filtered read without $top and is ignored for a Global read', async (t) => {
  const contact = await site(t);
  const paged = await contact('/_api/pqf1_items?$select=pqf1_name&$orderby=pqf1_name', {
    Prefer: 'odata.maxpagesize=3',
  });
  assert.deepEqual(names(paged), ['A child 1', 'A child 2', 'A grandchild']);
  assert.ok(paged.body['@odata.nextLink']);
  const global = await site(
    t,
    {},
    {
      permissions: (grants) =>
        grants.map((grant) =>
          grant.entity === 'pqf1_item'
            ? { id: grant.id, entity: 'pqf1_item', scope: 'global', roles: grant.roles, operations: ['read'] }
            : grant,
        ),
    },
  );
  const whole = await global('/_api/pqf1_items?$select=pqf1_name&$orderby=pqf1_name', {
    Prefer: 'odata.maxpagesize=3',
  });
  assert.equal(whole.body.value.length, 26, 'every row, the hidden one included');
  assert.equal(whole.body['@odata.nextLink'], undefined);
  // A Global read has no permission predicate: its continuation is not refused for the unlisted _pqf1_contact_value.
  const top = await global('/_api/pqf1_items?$select=pqf1_name&$orderby=pqf1_name&$top=5', {
    Prefer: 'odata.maxpagesize=2',
  });
  const next = await global(
    new URL(top.body['@odata.nextLink']).pathname + new URL(top.body['@odata.nextLink']).search,
    {
      Prefer: 'odata.maxpagesize=2',
    },
  );
  assert.equal(next.status, 200);
  assert.equal(next.body.value.length, 2);
});

test('the native-classic lane serves keyed reads, $top, $expand, pages and navigation filters instead of 501 (API-02b)', async (t) => {
  const read = await site(
    t,
    {},
    {
      observed: { odataPermissionQueryPipeline: 'native-classic', evidence: 'native-classic lane under test' },
    },
  );
  // Navigation and lambda filters answer the rows the Contact- and Parent-scope permissions allow: "Hidden other" (not
  // the contact's, under A root, with a child tagged x) is left out (runs/a and runs/b odata-shapes filter-navigation,
  // filter-navigation-2-levels, filter-lambda-any, filter-lambda-all).
  for (const [filter, expected] of [
    ["pqf1_parentitem/pqf1_name eq 'A root'", ['A child 1', 'A child 2']],
    ["pqf1_parentitem/pqf1_parentitem/pqf1_name eq 'A root'", ['A grandchild']],
    ["pqf1_item_pqf1_item_pqf1_child/any(c:c/pqf1_tag eq 'x')", ['A child 1', 'A root']],
    ["pqf1_item_pqf1_item_pqf1_child/all(c:c/pqf1_tag eq 'x')", ['A child 1']],
  ]) {
    const answer = await read(
      `/_api/pqf1_items?$select=pqf1_name&$orderby=pqf1_name&$filter=${encodeURIComponent(filter)}`,
    );
    assert.equal(answer.status, 200, filter);
    assert.deepEqual(names(answer), expected, filter);
  }
  const keyed = await read('/_api/pqf1_items(f1f1f1f1-0000-4000-8000-000000001001)?$select=pqf1_name&$top=1');
  assert.equal(keyed.status, 200);
  assert.equal(keyed.body.pqf1_name, 'A root');
  const top = await read('/_api/pqf1_items?$select=pqf1_name&$orderby=pqf1_name&$top=2');
  assert.deepEqual(names(top), ['A child 1', 'A child 2']);
  const expanded = await read(
    "/_api/pqf1_items?$select=pqf1_name&$filter=startswith(pqf1_name,'A ')&$orderby=pqf1_name&$expand=pqf1_parentitem($select=pqf1_name)",
  );
  assert.equal(expanded.status, 200);
  assert.deepEqual(
    expanded.body.value.map((row) => [row.pqf1_name, row.pqf1_parentitem?.pqf1_name ?? null]),
    [
      ['A child 1', 'A root'],
      ['A child 2', 'A root'],
      ['A grandchild', 'A child 1'],
      ['A root', null],
    ],
  );
  const paged = await read('/_api/pqf1_items?$select=pqf1_name&$orderby=pqf1_name', { Prefer: 'odata.maxpagesize=3' });
  assert.equal(paged.status, 200);
  assert.equal(paged.body.value.length, 3);
});

test('every answer carries x-ms-request-id and a JSON answer a Server-Timing correlation id, never OData-Version', async (t) => {
  const read = await site(t);
  for (const [address, status] of [
    ['/_api/pqf1_items?$select=pqf1_name', 200],
    ['/_api/pqf1_items?$select=pqf1_secret', 403],
    ['/_api/pqf1_items?$select=pqf1_name&$skip=1', 400],
    ['/_api/pqf1_items(f1f1f1f1-0000-4000-8000-000000009999)?$select=pqf1_name', 404],
  ]) {
    const answer = await read(address);
    assert.equal(answer.status, status, address);
    const id = answer.headers.get('x-ms-request-id');
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, address);
    assert.equal(answer.headers.get('server-timing'), `response-code; desc=${status}, correlationId; desc=${id}`);
    assert.equal(answer.headers.get('odata-version'), null, address);
  }
});

// Hosted session F1 follow-up 2026-11-27 (runs/a and runs/b nav-followup glob:*): on a Global-scope table whose list names
// the lookup by its logical name only, the refusals are the Contact-scope ones; scope plays no part.
test('a Global-scope table refuses select-less reads, /$count, $apply and _x_value as a Contact-scope one does', async (t) => {
  const read = await site(
    t,
    {},
    {
      permissions: (grants) =>
        grants.map((grant) =>
          grant.entity === 'pqf1_item'
            ? { id: grant.id, entity: 'pqf1_item', scope: 'global', roles: grant.roles, operations: ['read'] }
            : grant,
        ),
    },
  );
  const lookup = {
    code: '90040101',
    message: 'Attribute _pqf1_contact_value in table pqf1_item is not enabled for Web Api.',
  };
  const key = '(f1f1f1f1-0000-4000-8000-000000001001)';
  for (const address of [
    '/_api/pqf1_items/$count',
    '/_api/pqf1_items?$apply=groupby((pqf1_name))',
    '/_api/pqf1_items?$apply=aggregate($count as c)',
    '/_api/pqf1_items',
    `/_api/pqf1_items${key}`,
    '/_api/pqf1_items?$select=pqf1_name,_pqf1_contact_value',
  ]) {
    const answer = await read(address);
    assert.equal(answer.status, 403, address);
    assert.deepEqual(answer.body.error, lookup, address);
  }
  assert.deepEqual((await read(`/_api/pqf1_items${key}/pqf1_name`)).body.error, {
    code: '90040101',
    message: 'Attribute All Columns in table pqf1_item is not enabled for Web Api.',
  });
  assert.equal((await read(`/_api/pqf1_items${key}/pqf1_name/$value`)).status, 200);
  assert.equal((await read('/_api/pqf1_items?$select=pqf1_name')).status, 200);
});
