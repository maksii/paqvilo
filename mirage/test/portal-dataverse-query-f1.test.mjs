// @test-kind observation: hosted session F1 (2026-11-26, summary-F1 DATA-01d/01e/02b/03d), signed-in Power Pages Liquid and Web API reads of a synthetic fixture; single-run or run-dependent facts that the portal-dataverse-query replay suites cannot hold
// Portal Dataverse queries from hosted session F1 that are not replay cases: facts one run recorded, facts whose rows the
// date group reseeded per run, and the plug-in rewrite of a portal query to a virtual table. The fixture and projection
// are the portal-dataverse-query replay adapter's (invented names); the plug-in rewrite has its own small site.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { open } from './parity/adapters/portal-dataverse-query.mjs';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { makeTemporaryDirectory, ownedFixture } from '../testing/owned-fixture.mjs';
import { zoneOffsetFunction } from '../lib/portal-query-time-zone.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';

// The replay suites' observed settings (hosted F1 converter OBSERVED).
const OBSERVED = {
  tablePermissionQueryPipeline: 'native-classic',
  portalFetchXmlAuthoring: 'portal-classic',
  portalFetchIdentityOperators: 'application-user',
  webApiFetchXmlLinkTypes: 'portal-classic',
  liquidFetchXmlLinkTypes: 'portal-classic',
  liquidFetchErrorMessage: 'target-invocation',
  liquidFetchExecution: 'lazy-query-drop',
  webApiCdsErrorMessage: 'Common Data Service error occurred.',
  webApiCdsErrorCode: 'cdscode',
  portalApplicationUserId: 'a1a1a1a1-0000-4000-8000-000000009004',
  evidence: 'Hosted session F1 (2026-11-26), signed-in Power Pages Liquid and Web API reads of a synthetic fixture.',
};
const ITEM_ROWS = ['A child 1', 'A child 2', 'A grandchild', 'A root', 'B root', 'File holder'];
const fetchOf = (body, attrs = '') =>
  `<fetch${attrs}><entity name="qa_item"><attribute name="qa_name"/><attribute name="qa_itemid"/>${body}<order attribute="qa_name"/></entity></fetch>`;
const items = (body, attrs) => fetchOf(body, attrs);
const names = (output) => output.rows.map((row) => row.name ?? row.qa_name);
const itemNames = (output) => names(output).filter((name) => !/^dst /.test(name));
const webApi = (xml) => `/_api/qa_items?fetchXml=${encodeURIComponent(xml)}`;

async function session(t) {
  const runner = await open({ surface: 'portal-dataverse-query', suite: 'observation' });
  ownedFixture(t).add(() => runner.close());
  return runner;
}

test('rowaggregate, datasource and options are dropped from portal FetchXML; the rows are the ordinary ones', async (t) => {
  // Both runs (digest-fetch-liquid-a-b, digest-fetch-webapi-a-b): kids is the item id, datasource bin reads live rows.
  const runner = await session(t);
  const liquid = (xml, observed = OBSERVED) => runner.run({ lane: 'liquid', fetchXml: xml, observed });
  const aggregated = await liquid(
    '<fetch><entity name="qa_item"><attribute name="qa_name"/><attribute name="qa_itemid" rowaggregate="CountChildren" alias="kids"/><order attribute="qa_name"/></entity></fetch>',
  );
  const root = aggregated.rows.find((row) => row.name === 'A root');
  assert.equal(root.kids, 'a1a1a1a1-0000-4000-8000-000000001001');
  assert.deepEqual(itemNames(aggregated), ITEM_ROWS);
  for (const attrs of [' datasource="bin"', ' datasource="retained"', ' options="OptimizeForUnknown"'])
    assert.deepEqual(itemNames(await liquid(items('', attrs))), ITEM_ROWS, attrs);
  const rows = await runner.run({
    lane: 'webapi',
    path: webApi(
      '<fetch><entity name="qa_item"><attribute name="qa_name"/><attribute name="qa_itemid" rowaggregate="CountChildren" alias="kids"/><order attribute="qa_name"/></entity></fetch>',
    ),
    observed: OBSERVED,
  });
  assert.equal(rows.status, 200);
  const webRoot = rows.rows.find((row) => row.qa_name === 'A root');
  assert.equal(webRoot.kids, 'a1a1a1a1-0000-4000-8000-000000001001');
  assert.equal(webRoot['kids@OData.Community.Display.V1.AttributeName'], 'qa_itemid');
  const bin = await runner.run({ lane: 'webapi', path: webApi(items('', ' datasource="bin"')), observed: OBSERVED });
  assert.equal(bin.status, 200);
  assert.deepEqual(itemNames(bin), ITEM_ROWS);
});

// @test-kind contract: without the observed authoring conversion, Mirage's documented Dataverse FetchXML refusals stay
test('without portalFetchXmlAuthoring the portal keeps the Dataverse refusals of rowaggregate and datasource bin', async (t) => {
  const runner = await session(t);
  const { portalFetchXmlAuthoring: _authoring, ...observed } = OBSERVED;
  const answer = await runner.run({
    lane: 'webapi',
    path: webApi(items('', ' datasource="bin"')),
    observed,
  });
  assert.equal(answer.status, 400);
});

test('identity operators of portal FetchXML compare with the site application user', async (t) => {
  // Liquid both runs (eq-userid none, eq-businessid every row); Web API with ownerid and owningbusinessunit enabled,
  // run a only (runs/a/fetch-webapi-owner-columns): eq-userid none, ne-userid and eq-businessid every row,
  // ne-businessid none. The fixture's rows are owned by a seeding user in the application user's business unit.
  const runner = await session(t);
  const condition = (attribute, operator) =>
    `<filter><condition attribute="${attribute}" operator="${operator}"/></filter>`;
  assert.deepEqual(
    names(await runner.run({ lane: 'liquid', fetchXml: items(condition('ownerid', 'eq-userid')), observed: OBSERVED })),
    [],
  );
  assert.deepEqual(
    itemNames(
      await runner.run({
        lane: 'liquid',
        fetchXml: items(condition('owningbusinessunit', 'eq-businessid')),
        observed: OBSERVED,
      }),
    ),
    ITEM_ROWS,
  );
  assert.deepEqual(
    itemNames(
      await runner.run({ lane: 'liquid', fetchXml: items(condition('ownerid', 'ne-userid')), observed: OBSERVED }),
    ),
    ITEM_ROWS,
  );
});

test('a Web API fetchXml condition or attribute outside the Web API fields is refused with 403 90040101', async (t) => {
  // runs/pilot-webapi-noid (primary key absent from the fields): every query naming qa_itemid answered 403 90040101;
  // runs a and b: ownerid and owningbusinessunit outside the fields answered the same for the identity operators.
  const runner = await session(t);
  const answer = await runner.run({
    lane: 'webapi',
    path: webApi(items('<filter><condition attribute="owningbusinessunit" operator="eq-businessid"/></filter>')),
    observed: OBSERVED,
  });
  assert.equal(answer.status, 403);
  assert.deepEqual(answer.error, {
    code: '90040101',
    message: 'Attribute owningbusinessunit in table qa_item is not enabled for Web Api.',
    cdscode: null,
  });
});

test('UserLocal conditions of portal queries evaluate in the observed zone, with daylight saving time', async (t) => {
  // Run b (runs/b/dates, the summer and winter rows exist from run b on): on 2026-06-16 holds 21:30Z of 15 June (UTC+3),
  // on 2026-01-15 holds 21:30Z of 15 January (UTC+2).
  const runner = await session(t);
  const observed = { ...OBSERVED, portalQueryTimeZone: 'Europe/Kiev' };
  const on = async (day, zone = observed) =>
    names(
      await runner.run({
        lane: 'liquid',
        fetchXml: `<fetch><entity name="qa_item"><attribute name="qa_name"/><filter><condition attribute="qa_name" operator="like" value="d%"/><condition attribute="qa_when" operator="on" value="${day}"/></filter><order attribute="qa_name"/></entity></fetch>`,
        observed: zone,
      }),
    );
  assert.deepEqual(await on('2026-06-15'), []);
  assert.deepEqual(await on('2026-06-16'), ['dst summer 0615 21:30Z', 'dst summer 0616 04:30Z']);
  assert.deepEqual(await on('2026-01-15'), ['dst winter 0115 21:30Z']);
  assert.deepEqual(await on('2026-01-16'), ['dst winter 0116 04:30Z']);
  // dates-dataverse-control: directly against Dataverse the same application user (time zone code 92, UTC) evaluates in UTC;
  // a site without the observation keeps the store's own offset (0 here).
  const { portalQueryTimeZone: _zone, ...utc } = observed;
  assert.deepEqual(await on('2026-06-15', utc), ['dst summer 0615 21:30Z']);
  assert.deepEqual(await on('2026-03-29', utc), ['dst eu-start 00:30Z', 'dst eu-start 01:30Z']);
});

// @test-kind contract: the observed zone setting accepts IANA names and "runtime" only, and its offsets follow the zone's rules
test('portalQueryTimeZone accepts IANA zone names and runtime; offsets change at the daylight saving transition', () => {
  assert.equal(
    observedConfig({ portalQueryTimeZone: 'Europe/Kiev', evidence: 'invented' }).portalQueryTimeZone,
    'Europe/Kiev',
  );
  assert.equal(observedConfig({ portalQueryTimeZone: 'runtime', evidence: 'invented' }).portalQueryTimeZone, 'runtime');
  assert.throws(
    () => observedConfig({ portalQueryTimeZone: 'Invented/Nowhere', evidence: 'invented' }),
    /^Error: observed\.portalQueryTimeZone must be an IANA time zone name or runtime$/,
  );
  const kyiv = zoneOffsetFunction('Europe/Kiev');
  assert.equal(kyiv(Date.parse('2026-03-29T00:30:00Z')), 120);
  assert.equal(kyiv(Date.parse('2026-03-29T01:30:00Z')), 180);
  assert.equal(kyiv(Date.parse('2026-10-25T00:30:00Z')), 180);
  assert.equal(kyiv(Date.parse('2026-10-25T01:30:00Z')), 120);
  assert.equal(zoneOffsetFunction('UTC')(Date.parse('2026-06-15T21:30:00Z')), 0);
});

// @test-kind contract: the observed zone applies only to UserLocal columns of portal requests
test('the portal zone leaves DateOnly and TimeZoneIndependent columns and non-portal queries to the fixed offset', () => {
  const state = emptyState();
  state.settings.permissionMode = 'permissive';
  state.mappings.x_row = {
    logicalName: 'x_row',
    entitySet: 'x_rows',
    idColumn: 'x_rowid',
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_when: { dataverseType: 'datetime' },
      x_tzi: { dataverseType: 'datetime', dateTimeBehavior: 'TimeZoneIndependent' },
    },
  };
  state.tables.x_row = [
    {
      x_rowid: 'a1a1a1a1-0000-4000-8000-000000000001',
      x_name: 'late',
      x_when: '2026-03-28T22:30:00Z',
      x_tzi: '2026-03-28T22:30:00',
    },
  ];
  const store = new DataStore({ state });
  store.setObserved({ portalQueryTimeZone: 'Europe/Kiev', evidence: 'invented' });
  const read = (column, options) =>
    store
      .fetchXml(
        `<fetch><entity name="x_row"><attribute name="x_name"/><filter><condition attribute="${column}" operator="on" value="2026-03-29"/></filter></entity></fetch>`,
        {},
        options,
      )
      .entities.map((row) => row.x_name);
  assert.deepEqual(read('x_when', { portalRequest: true }), ['late']);
  assert.deepEqual(read('x_tzi', { portalRequest: true }), []);
  assert.deepEqual(read('x_when', {}), []);
});

// The plug-in rewrite fixture: a portal item table whose RetrieveMultiple PreOperation step replaces the query with a
// QueryExpression on a provider-backed virtual table (the recorded QueryRewrite plug-in).
async function rewriteSite(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-query-rewrite-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const xml =
    '<fetch><entity name="qa_item"><attribute name="qa_name"/><filter><condition attribute="qa_name" operator="eq" value="rewrite-to-virtual"/></filter></entity></fetch>';
  const files = {
    'website.yml': 'adx_websiteid: a1a1a1a1-0000-4000-8000-000000008001\nadx_name: Invented rewrite site\n',
    'webrole.yml': 'adx_webroleid: a1a1a1a1-0000-4000-8000-000000008002\nadx_name: Reader\n',
    'home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: page\n',
    'home.pagetemplate.yml': 'adx_pagetemplateid: page\nadx_webtemplateid: template\n',
    'home.webtemplate.yml': 'adx_webtemplateid: template\nadx_name: Home\n',
    'home.webtemplate.source.html': `{% fetchxml q %}${xml}{% endfetchxml %}<pre id="out">{{ q.results.entities.size }}</pre>`,
    'sitesetting.yml':
      "- adx_name: Webapi/qa_item/enabled\n  adx_value: 'true'\n- adx_name: Webapi/qa_item/fields\n  adx_value: 'qa_itemid,qa_name'\n",
  };
  await Promise.all(Object.entries(files).map(([name, body]) => fs.writeFile(path.join(directory, name), body)));
  const app = await createSimulator({
    sourceDir: directory,
    watch: false,
    port: 0,
    observed: OBSERVED,
    packs: [
      {
        id: 'rewrite-fixture',
        name: 'Rewrite fixture',
        description: 'Invented provider',
        matches: () => true,
        presets: () => ({}),
        virtualTableProviders: { qa_vrow: { retrieveMultiple: () => [], retrieve: () => null } },
      },
    ],
    initial: {
      version: 1,
      mappings: {
        qa_item: {
          entitySet: 'qa_items',
          idColumn: 'qa_itemid',
          nameColumn: 'qa_name',
          fields: { qa_name: { dataverseType: 'nvarchar' } },
        },
        qa_vrow: {
          entitySet: 'qa_vrows',
          idColumn: 'qa_vrowid',
          nameColumn: 'qa_name',
          isVirtual: true,
          fields: { qa_name: { dataverseType: 'nvarchar' } },
        },
      },
      tables: {
        contact: [{ contactid: 'a1a1a1a1-0000-4000-8000-000000008003', fullname: 'Invented visitor' }],
        qa_item: [],
        qa_vrow: [],
      },
      permissions: [{ id: 'items', entity: 'qa_item', scope: 'global', roles: ['Reader'], operations: ['read'] }],
      settings: { permissionMode: 'enforce' },
      simulator: { mode: 'local', pageMode: 'local', endpoints: [] },
    },
  });
  ownedFixture(t).add(() => app.close());
  // The recorded QueryRewrite step: PreOperation of qa_item RetrieveMultiple, query replaced when it names the marker value.
  app.store.setPluginPipeline(
    (c) => {
      if (c.stage !== 20 || !JSON.stringify(c.query).includes('rewrite-to-virtual')) return;
      for (const key of Object.keys(c.query)) delete c.query[key];
      Object.assign(c.query, {
        $type: 'QueryExpression',
        entityName: 'qa_vrow',
        columnSet: { allColumns: true, columns: [] },
        criteria: { operatorName: 'And', conditions: [], filters: [] },
        orders: [],
        linkEntities: [],
      });
    },
    (c) => c.entity === 'qa_item' && c.operation === 'retrievemultiple',
  );
  const { cookie } = signInHeaders(app, 'a1a1a1a1-0000-4000-8000-000000008003', { roles: ['Reader'] });
  return { app, cookie, xml };
}

test('a PreOperation plug-in that rebinds a portal query to a virtual table fails in SQL: 500 0x80044150, Liquid exception', async (t) => {
  // Both runs (digest-virtual-a-b): Web API fetchXml and OData 500 9004010D cdscode 0x80044150; Liquid "Exception has
  // been thrown by the target of an invocation." in every place the template read the query.
  const { app, cookie, xml } = await rewriteSite(t);
  for (const query of [
    `fetchXml=${encodeURIComponent(xml)}`,
    "$select=qa_name&$filter=qa_name eq 'rewrite-to-virtual'",
  ]) {
    const response = await fetch(`${app.url}/_api/qa_items?${query}`, {
      headers: { cookie, accept: 'application/json' },
    });
    assert.equal(response.status, 500, query);
    assert.deepEqual((await response.json()).error, {
      code: '9004010D',
      message: 'Common Data Service error occurred.',
      cdscode: '0x80044150',
    });
  }
  const page = await (await fetch(app.url + '/', { headers: { cookie } })).text();
  assert.match(page, /<pre id="out">Liquid error: Exception has been thrown by the target of an invocation\.<\/pre>/);
});

// A provider-backed virtual table behind a contact-scoped permission (the recording's virtual table had a Global one).
async function scopedVirtualSite(t, seen) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'portal-query-scoped-'));
  ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
  const visitor = 'a1a1a1a1-0000-4000-8000-000000007003',
    other = 'a1a1a1a1-0000-4000-8000-000000007004';
  const files = {
    'website.yml': 'adx_websiteid: a1a1a1a1-0000-4000-8000-000000007001\nadx_name: Invented scoped site\n',
    'webrole.yml': 'adx_webroleid: a1a1a1a1-0000-4000-8000-000000007002\nadx_name: Reader\n',
    'sitesetting.yml':
      "- adx_name: Webapi/qa_vrow/enabled\n  adx_value: 'true'\n- adx_name: Webapi/qa_vrow/fields\n  adx_value: 'qa_vrowid,qa_name,qa_person'\n",
  };
  await Promise.all(Object.entries(files).map(([name, body]) => fs.writeFile(path.join(directory, name), body)));
  const rows = [
    { qa_vrowid: 'a1a1a1a1-0000-4000-8000-000000007101', qa_name: 'mine', qa_person: visitor },
    { qa_vrowid: 'a1a1a1a1-0000-4000-8000-000000007102', qa_name: 'someone else', qa_person: other },
  ];
  const app = await createSimulator({
    sourceDir: directory,
    watch: false,
    port: 0,
    packs: [
      {
        id: 'scoped-provider',
        name: 'Scoped provider',
        description: 'Invented provider that ignores every predicate',
        matches: () => true,
        presets: () => ({}),
        virtualTableProviders: {
          qa_vrow: {
            retrieveMultiple: (request) => {
              seen.push(request);
              return rows;
            },
          },
        },
      },
    ],
    initial: {
      version: 1,
      mappings: {
        qa_vrow: {
          entitySet: 'qa_vrows',
          idColumn: 'qa_vrowid',
          nameColumn: 'qa_name',
          isVirtual: true,
          fields: { qa_name: { dataverseType: 'nvarchar' }, qa_person: { dataverseType: 'lookup' } },
        },
      },
      tables: {
        contact: [
          { contactid: visitor, fullname: 'Invented visitor' },
          { contactid: other, fullname: 'Invented other visitor' },
        ],
        qa_vrow: [],
      },
      permissions: [
        {
          id: 'mine',
          entity: 'qa_vrow',
          scope: 'contact',
          field: 'qa_person',
          roles: ['Reader'],
          operations: ['read'],
        },
      ],
      settings: { permissionMode: 'enforce' },
      simulator: { mode: 'local', pageMode: 'local', endpoints: [] },
    },
  });
  ownedFixture(t).add(() => app.close());
  const { cookie } = signInHeaders(app, visitor, { roles: ['Reader'] });
  return { app, cookie, visitor };
}

// @test-kind security: a provider that ignores the translated permission predicate never widens a scoped grant
test('provider rows of a scoped portal read still pass the table permission; the provider sees the scope predicate', async (t) => {
  const seen = [];
  const { app, cookie, visitor } = await scopedVirtualSite(t, seen);
  for (const query of [
    '$select=qa_name',
    `fetchXml=${encodeURIComponent('<fetch><entity name="qa_vrow"><attribute name="qa_name"/></entity></fetch>')}`,
  ]) {
    seen.length = 0;
    const response = await fetch(`${app.url}/_api/qa_vrows?${query}`, {
      headers: { cookie, accept: 'application/json' },
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.deepEqual(
      (await response.json()).value.map((row) => row.qa_name),
      ['mine'],
      query,
    );
    // Unproven (the recording's virtual table had a Global permission): the translated query carries the contact predicate
    // the recorder saw in the portal's queries of ordinary tables.
    assert.match(JSON.stringify(seen.at(-1)?.query ?? null), new RegExp(visitor), query);
  }
  const denied = await fetch(`${app.url}/_api/qa_vrows?$select=qa_name`, { headers: { accept: 'application/json' } });
  assert.equal(denied.status, 403);
});
