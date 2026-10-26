import test from 'node:test';
import assert from 'node:assert/strict';
import { DataverseClient } from '../lense/dataverse/client.mjs';
import {
  validateCatalogue,
  planData,
  applyData,
  compareData,
  runDataQueries,
  retrieveFetchXml,
} from '../lense/dataverse/data.mjs';
import { loopbackServer } from './fixture.mjs';
const ids = {
  company: '11111111-1111-5111-8111-111111111111',
  one: '22222222-2222-5222-8222-222222222222',
  two: '33333333-3333-5333-8333-333333333333',
  currency: '44444444-4444-5444-8444-444444444444',
  external: '55555555-5555-5555-8555-555555555555',
  foreign: '66666666-6666-5666-8666-666666666666',
};
const fixture = () => ({
  schemaVersion: 1,
  datasetId: 'invented',
  version: 'v1',
  clock: '2026-10-12T09:00:00Z',
  tables: [
    { name: 'tst_currency', entitySet: 'tst_currencies', primaryId: 'tst_currencyid', keys: [] },
    { name: 'tst_company', entitySet: 'tst_companies', primaryId: 'tst_companyid', keys: [['tst_code']] },
    { name: 'tst_member', entitySet: 'tst_members', primaryId: 'tst_memberid', keys: [['tst_code']] },
  ],
  records: [
    {
      key: 'currency',
      id: ids.currency,
      table: 'tst_currency',
      external: { match: { tst_iso: 'XXX' } },
      fields: { tst_iso: 'XXX', tst_rate: 1 },
    },
    {
      key: 'company',
      id: ids.company,
      table: 'tst_company',
      fields: { tst_code: 'FIXTURE', tst_name: 'Invented', tst_date: '2026-10-12', tst_multi: [5, 7] },
      refs: { tst_parentid: 'company' },
      deferredRefs: ['tst_parentid'],
    },
    {
      key: 'one',
      id: ids.one,
      table: 'tst_member',
      fields: { tst_code: 'ONE', tst_name: 'One' },
      refs: { tst_companyid: 'company', tst_currencyid: 'currency', tst_optionalid: null },
    },
    {
      key: 'two',
      id: ids.two,
      table: 'tst_member',
      fields: { tst_code: 'TWO', tst_name: 'Two' },
      refs: { tst_companyid: 'company' },
    },
  ],
  associations: [{ relationship: 'tst_company_members', from: 'company', to: ['one', 'two'] }],
  queries: [
    {
      id: 'paged',
      table: 'tst_member',
      pageSize: 1,
      fetchXml: `<fetch><entity name="tst_member"><attribute name="tst_memberid"/><filter><condition attribute="tst_memberid" operator="in"><value>${ids.one}</value><value>${ids.two}</value></condition></filter><order attribute="tst_memberid"/></entity></fetch>`,
      columns: ['tst_memberid'],
      expected: [{ tst_memberid: '@ref:one' }, { tst_memberid: '@ref:two' }],
    },
  ],
});
async function serverFixture(t) {
  const catalogue = validateCatalogue(fixture()),
    tables = new Map(catalogue.tables.map((t) => [t.name, t])),
    rows = new Map(),
    links = new Set(),
    requests = [];
  rows.set(ids.external, { tst_currencyid: ids.external, tst_iso: 'XXX', tst_rate: 8 });
  rows.set(ids.foreign, { tst_memberid: ids.foreign, tst_code: 'FOREIGN', tst_name: 'Untouched' });
  let failWrite = false,
    duplicatePage = false,
    omitTerminal = false;
  const handle = async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : null,
      url = new URL(req.url, 'http://invented.local'),
      route = decodeURIComponent(url.pathname.slice('/api/data/v9.2/'.length));
    requests.push({ route, method: req.method, headers: req.headers, body });
    const send = (code, value) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(value));
    };
    if (route === 'WhoAmI') return send(200, { OrganizationId: ids.company, UserId: ids.one });
    const metadata = route.match(/^EntityDefinitions\(LogicalName='([^']+)'\)(.*)$/);
    if (metadata) {
      const table = tables.get(metadata[1]),
        tail = metadata[2];
      if (!tail)
        return send(200, {
          LogicalName: table.name,
          EntitySetName: table.entitySet,
          PrimaryIdAttribute: table.primaryId,
        });
      if (tail === '/Keys')
        return send(200, {
          value: table.keys.map((KeyAttributes) => ({ KeyAttributes, EntityKeyIndexStatus: 'Active' })),
        });
      if (tail === '/ManyToOneRelationships')
        return send(200, {
          value:
            table.name === 'tst_company'
              ? [
                  {
                    ReferencingAttribute: 'tst_parentid',
                    ReferencedEntity: 'tst_company',
                    ReferencingEntityNavigationPropertyName: 'ParentNav',
                  },
                ]
              : table.name === 'tst_member'
                ? [
                    {
                      ReferencingAttribute: 'tst_companyid',
                      ReferencedEntity: 'tst_company',
                      ReferencingEntityNavigationPropertyName: 'CompanyNav',
                    },
                    {
                      ReferencingAttribute: 'tst_currencyid',
                      ReferencedEntity: 'tst_currency',
                      ReferencingEntityNavigationPropertyName: 'CurrencyNav',
                    },
                    {
                      ReferencingAttribute: 'tst_optionalid',
                      ReferencedEntity: 'tst_company',
                      ReferencingEntityNavigationPropertyName: 'OptionalNav',
                    },
                  ]
                : [],
        });
    }
    if (route.startsWith('RelationshipDefinitions/'))
      return send(200, {
        value: [
          {
            Entity1LogicalName: 'tst_company',
            Entity2LogicalName: 'tst_member',
            Entity1NavigationPropertyName: 'MembersNav',
          },
        ],
      });
    const record = route.match(/^(tst_\w+)\(([0-9a-f-]+)\)(.*)$/),
      table = [...tables.values()].find((t) => t.entitySet === (record?.[1] ?? route));
    if (req.method === 'GET') {
      if (url.searchParams.has('fetchXml')) {
        const xml = url.searchParams.get('fetchXml'),
          page = Number(xml.match(/page="(\d+)"/)[1]);
        if (page === 2) assert.match(xml, /paging-cookie="&lt;cookie/);
        const selected = [ids.one, duplicatePage ? ids.one : ids.two][page - 1];
        return send(200, {
          value: selected ? [{ tst_memberid: selected }] : [],
          ...(page === 1 || !omitTerminal ? { '@Microsoft.Dynamics.CRM.morerecords': page === 1 } : {}),
          ...(page === 1
            ? {
                '@Microsoft.Dynamics.CRM.fetchxmlpagingcookie': `<cookie pagenumber="2" pagingcookie="${encodeURIComponent(encodeURIComponent('<cookie page="1"><tst_memberid last="' + ids.one + '"/></cookie>'))}" />`,
              }
            : {}),
        });
      }
      if (record?.[3] === '/MembersNav')
        return send(200, { value: [...links].map((tst_memberid) => ({ tst_memberid })) });
      if (record)
        return rows.has(record[2]) ? send(200, { ...rows.get(record[2]), '@odata.etag': 'W/"1"' }) : send(404, {});
      if (table) {
        let found = [...rows.values()].filter((r) => table.primaryId in r);
        const filter = url.searchParams.get('$filter');
        if (filter) {
          const [, field, value] = filter.match(/^(\w+) eq '([^']+)'$/);
          found = found.filter((r) => r[field] === value);
        }
        return send(200, { value: found });
      }
    }
    if (req.method === 'PATCH' && record) {
      if (failWrite) return send(503, { error: { message: 'private fixture failure' } });
      const actual = rows.get(record[2]);
      if (!actual) assert.equal(req.headers['if-none-match'], '*');
      else assert.equal(req.headers['if-match'], 'W/"1"');
      const values = { ...actual, [table.primaryId]: record[2] };
      for (const [field, value] of Object.entries(body)) {
        if (field.endsWith('@odata.bind')) {
          const nav = field.split('@')[0],
            logical = {
              ParentNav: 'tst_parentid',
              CompanyNav: 'tst_companyid',
              CurrencyNav: 'tst_currencyid',
              OptionalNav: 'tst_optionalid',
            }[nav];
          assert.ok(logical, 'live navigation must be derived');
          values[`_${logical}_value`] = value?.match(/\(([^)]+)\)/)?.[1] ?? null;
        } else values[field] = field === 'tst_date' ? value + 'T00:00:00Z' : value;
      }
      rows.set(record[2], values);
      res.writeHead(204);
      return res.end();
    }
    if (req.method === 'POST' && record?.[3] === '/MembersNav/$ref') {
      links.add(body['@odata.id'].match(/\(([^)]+)\)/)[1]);
      res.writeHead(204);
      return res.end();
    }
    send(400, { error: { message: 'unsupported fixture route ' + route } });
  };
  const client = new DataverseClient({
    environmentUrl: await loopbackServer(t, handle),
    allowLoopback: true,
    token: async () => 'invented-token',
  });
  return {
    catalogue,
    client,
    rows,
    links,
    requests,
    setFail: (value) => {
      failWrite = value;
    },
    setDuplicate: (value) => {
      duplicatePage = value;
    },
    setOmitTerminal: (value) => {
      omitTerminal = value;
    },
  };
}
test('data catalogue rejects undeclared references, unmarked cycles, duplicate IDs and business keys', () => {
  const c = fixture();
  c.records[2].refs.tst_companyid = 'missing';
  assert.throws(() => validateCatalogue(c), /unknown lookup/);
  const cycle = fixture();
  cycle.records[1].deferredRefs = [];
  assert.throws(() => validateCatalogue(cycle), /deferred/);
  const dup = fixture();
  dup.records[3].fields.tst_code = 'ONE';
  assert.throws(() => validateCatalogue(dup), /duplicate business/);
  const id = fixture();
  id.records[3].id = ids.one;
  assert.throws(() => validateCatalogue(id), /record identity/);
});
test('data plan is read only; loader resolves external IDs, cycles and navigation, reruns without mutation', async (t) => {
  const s = await serverFixture(t);
  const plan = await planData(s.catalogue, { client: s.client });
  assert.equal(plan.summary.create, 3);
  assert.equal(plan.summary.external, 1);
  assert.ok(s.requests.every((r) => r.method === 'GET'));
  const result = await applyData(s.catalogue, { client: s.client, expectedOrganisationId: ids.company });
  assert.equal(result.state, 'Created');
  assert.equal(s.rows.get(ids.one)._tst_currencyid_value, ids.external);
  assert.equal(s.rows.get(ids.external).tst_rate, 8);
  assert.equal(s.rows.get(ids.company)._tst_parentid_value, ids.company);
  assert.equal(s.rows.get(ids.company).tst_multi, '5,7');
  assert.equal(s.links.size, 2);
  const writes = s.requests.filter((r) => r.method !== 'GET').length;
  await applyData(s.catalogue, { client: s.client });
  assert.equal(s.requests.filter((r) => r.method !== 'GET').length, writes);
  assert.equal((await compareData(s.catalogue, { client: s.client })).passed, true);
  assert.equal(s.rows.get(ids.foreign).tst_name, 'Untouched');
});
test('comparison detects scalar/relationship drift and loading blocks writes rather than repairing foreign data', async (t) => {
  const s = await serverFixture(t);
  await applyData(s.catalogue, { client: s.client });
  s.rows.get(ids.one).tst_name = 'Changed';
  s.links.add(ids.foreign);
  const before = s.requests.filter((r) => r.method !== 'GET').length;
  const report = await compareData(s.catalogue, { client: s.client });
  assert.equal(report.passed, false);
  assert.equal(report.records[0].key, 'one');
  assert.deepEqual(report.associations[0].extra, [ids.foreign]);
  await assert.rejects(applyData(s.catalogue, { client: s.client }), /will not overwrite/);
  assert.equal(s.requests.filter((r) => r.method !== 'GET').length, before);
});
test('paged FetchXML follows double encoded cookies, compares complete rows and detects duplicate pages', async (t) => {
  const s = await serverFixture(t);
  await applyData(s.catalogue, { client: s.client });
  const report = await runDataQueries(s.catalogue, { client: s.client });
  assert.equal(report.passed, true);
  assert.equal(report.results[0].pages.length, 2);
  assert.equal(report.results[0].count, 2);
  s.setDuplicate(true);
  assert.equal((await runDataQueries(s.catalogue, { client: s.client })).passed, false);
  await assert.rejects(
    retrieveFetchXml(s.client, {
      entitySet: 'tst_members',
      fetchXml: s.catalogue.queries[0].fetchXml,
      pageSize: 1,
      maxPages: 1,
    }),
    /bound exceeded/,
  );
});
test('an HTTP mutation failure is not retried and drift on an alternate key prevents ID takeover', async (t) => {
  const s = await serverFixture(t);
  s.rows.get(ids.foreign).tst_code = 'ONE';
  await assert.rejects(applyData(s.catalogue, { client: s.client }), /will not overwrite/);
  assert.ok(s.requests.every((r) => r.method === 'GET'));
  s.rows.get(ids.foreign).tst_code = 'FOREIGN';
  s.setFail(true);
  await assert.rejects(applyData(s.catalogue, { client: s.client }), (e) => e.status === 503);
  assert.equal(s.requests.filter((r) => r.method === 'PATCH').length, 1);
});
test('a full final page without a terminal annotation is proved by reading the following empty page', async (t) => {
  const s = await serverFixture(t);
  s.setOmitTerminal(true);
  const result = await retrieveFetchXml(s.client, {
    entitySet: 'tst_members',
    fetchXml: s.catalogue.queries[0].fetchXml,
    pageSize: 1,
  });
  assert.equal(result.rows.length, 2);
  assert.equal(result.pages.length, 3);
  assert.equal(result.pages[2].count, 0);
});

test('retrieval diffs preserve missing and unexpected duplicate occurrences', async (t) => {
  const s = await serverFixture(t);
  s.setDuplicate(true);
  const c = structuredClone(s.catalogue);
  c.queries[0].expected = [{ tst_memberid: '@ref:one' }];
  const result = (await runDataQueries(c, { client: s.client })).results[0];
  assert.equal(result.status, 'Failed');
  assert.equal(result.missing.length, 0);
  assert.equal(result.unexpected.length, 1);
  c.queries[0].expected = [{ tst_memberid: '@ref:one' }, { tst_memberid: '@ref:one' }, { tst_memberid: '@ref:one' }];
  const missing = (await runDataQueries(c, { client: s.client })).results[0];
  assert.equal(missing.missing.length, 1);
  assert.equal(missing.unexpected.length, 0);
});
