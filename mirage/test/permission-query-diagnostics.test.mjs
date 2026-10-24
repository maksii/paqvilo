import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { DataStore } from '../lib/data.mjs';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { platformSettingEntries } from '../lib/platform-settings.mjs';
import { resolveMirageConfig } from '../../lense/config.mjs';
import { mirageSettings } from '../../lense/config-schema.mjs';
import { profileFixture } from './fixtures/deployment-profiles.mjs';
import { bootstrapReport, resolveReportInputs } from '../bootstrap-report.mjs';
import { createMirageContext } from '../lib/mirage-context.mjs';
import { classifyResponse, ciSummary } from '../render-sweep.mjs';

const visitor = { contactId: 'one', roles: ['reader'] };
function state() {
  return {
    mappings: { child: { idColumn: 'childid' }, role: { idColumn: 'roleid' } },
    tables: {
      child: [
        { childid: 'c1', organizationid: 'org' },
        { childid: 'c2', organizationid: 'org' },
      ],
      role: [
        { roleid: 'r1', organizationid: 'org', contactid: 'one' },
        { roleid: 'r2', organizationid: 'org', contactid: 'other' },
      ],
    },
    permissions: [
      {
        id: 'principal',
        entity: 'role',
        scope: 'contact',
        field: 'contactid',
        roles: ['reader'],
        operations: ['read'],
      },
      {
        id: 'branch-one',
        entity: 'child',
        scope: 'parent',
        parentPermissionId: 'principal',
        roles: ['reader'],
        operations: ['read'],
        relationship: { entity: 'role', from: 'organizationid', to: 'organizationid', many: true },
      },
      {
        id: 'branch-two',
        entity: 'child',
        scope: 'parent',
        parentPermissionId: 'principal',
        roles: ['reader'],
        operations: ['read'],
        relationship: { entity: 'role', from: 'organizationid', to: 'organizationid', many: true },
      },
    ],
    settings: { permissionMode: 'enforce' },
  };
}
function store(data = state(), platform) {
  const result = new DataStore({ state: data, platform });
  result.setObserved({
    tablePermissionQueryPipeline: 'native-classic',
    evidence: 'Invented permission join diagnostics',
  });
  return result;
}
const query = (distinct) =>
  `<fetch distinct="${distinct}"><entity name="child"><attribute name="childid"/></entity></fetch>`;
test('render sweep exposes permission row counts and paths in each persona summary', () => {
  const diagnostic = {
    code: 'PERMISSION_QUERY_ROW_MULTIPLICATION',
    table: 'child',
    path: '/synthetic/',
    returnedRows: 6,
    uniqueRootRows: 2,
    grantPaths: [{ grantId: 'branch-one' }],
  };
  const classified = classifyResponse({
    status: 200,
    contentType: 'text/html',
    body: '<html></html>',
    diagnostics: [diagnostic],
  });
  const summary = ciSummary(
    { portal: 'synthetic' },
    {
      persona: 'reader',
      pages: 1,
      requests: 1,
      byStatus: { 200: 1 },
      liquidErrorPages: [],
      liquidDiagnosticCounts: {},
      injectedNonDocuments: [],
      failures: [],
      permissionQueries: classified.permissionQueries,
    },
  );
  assert.equal(summary.persona, 'reader');
  assert.deepEqual(summary.permissionRowMultiplication, [diagnostic]);
});
test('native scoped reads deduplicate while unqualified raw reads retain multiplicity diagnostics', async () => {
  const data = state();
  // Separate column paths retain both grant alternatives rather than compiling a duplicate path.
  data.tables.child.forEach((row) => (row.secondorganizationid = 'org'));
  data.permissions[2].relationship.from = 'secondorganizationid';
  const s = store(data),
    diagnostics = [];
  const native = s.fetchXml(query(false), visitor, { portalRequest: true });
  assert.equal(native.entities.length, 2);
  assert.equal(native.permissionQuery.permissionLinkCount, 2);
  assert.equal(
    native.permissionQuery.diagnostics.some((d) => d.code === 'PERMISSION_QUERY_ROW_MULTIPLICATION'),
    false,
  );
  s.setObserved(null);
  const result = s.fetchXml(query(false), visitor, {
    portalRequest: true,
    diagnostic: (entry) => diagnostics.push(entry),
  });
  assert.equal(result.entities.length, 6);
  assert.equal(result.permissionQuery.permissionLinkCount, native.permissionQuery.permissionLinkCount);
  assert.equal(diagnostics[0].code, 'PERMISSION_QUERY_ROW_MULTIPLICATION');
  assert.equal(diagnostics[0].uniqueRootRows, 2);
  assert.equal(diagnostics[0].returnedRows, 6);
  const clean = s.fetchXml(query(true), visitor, { portalRequest: true });
  assert.equal(clean.entities.length, 2);
  assert.equal(
    clean.permissionQuery.diagnostics.some((d) => d.code === 'PERMISSION_QUERY_ROW_MULTIPLICATION'),
    false,
  );
  const commented = s.fetchXml('<!-- distinct="false" -->' + query(true), visitor, { portalRequest: true });
  assert.equal(
    commented.permissionQuery.diagnostics.some((d) => d.code === 'PERMISSION_QUERY_ROW_MULTIPLICATION'),
    false,
  );
  const pageDiagnostics = [];
  const renderer = createPortalRenderer(
    { pages: [], templates: {}, settings: {}, snippets: {} },
    { fetchXml: (xml) => s.fetchXml(xml, visitor, { portalRequest: true }) },
  );
  await renderer.renderString(`{% fetchxml rows %}${query(false)}{% endfetchxml %}`, {
    __diagnostics: pageDiagnostics,
    request: { path: '/synthetic/' },
  });
  assert.ok(pageDiagnostics.some((d) => d.code === 'PERMISSION_QUERY_ROW_MULTIPLICATION' && d.path === '/synthetic/'));
});
test('expanded link failures identify generated links, grants and the configured budget', () => {
  const data = state();
  data.permissions = data.permissions.slice(0, 2);
  const s = store(data, { QueryLinkEntityLimit: 1, evidence: 'Invented reduced test budget' });
  const authored =
    '<fetch><entity name="child"><link-entity name="child" from="childid" to="childid" alias="copy"/></entity></fetch>';
  const diagnostics = [];
  assert.throws(
    () => s.fetchXml(authored, visitor, { portalRequest: true, diagnostic: (d) => diagnostics.push(d) }),
    (error) => error.details.permissionDiagnostic.code === 'PERMISSION_LINK_BUDGET_EXCEEDED',
  );
  assert.equal(diagnostics[0].authoredLinks, 1);
  assert.equal(diagnostics[0].generatedLinks, 1);
  assert.equal(diagnostics[0].limit, 1);
  assert.equal(diagnostics[0].grantPaths[0].grantId, 'branch-one');
});
test('catalogue platform defaults reach new stores and local overrides keep precedence', () => {
  const platform = { QueryLinkEntityLimit: 50, evidence: 'Invented support-approved setting' };
  mirageSettings({ platform }, 'sites.synthetic.mirage');
  assert.throws(() => mirageSettings({ platform: { QueryLinkEntityLimit: 50 } }, 'defaults.mirage'), /evidence/);
  const resolved = resolveMirageConfig({ platform }, { configDir: process.cwd(), sourceRoot: process.cwd() });
  const data = state();
  data.simulator = { platformOverrides: { QueryLinkEntityLimit: 25 } };
  const s = store(data, resolved.platform);
  assert.equal(s.querySettings().fetchLimits.links, 25);
  const entry = platformSettingEntries(s.snapshot()).find((row) => row.key === 'QueryLinkEntityLimit');
  assert.equal(entry.sourceValue, 50);
  assert.equal(entry.origin, 'Instance override');
});
test('catalogue platform settings apply to embedded contexts and bootstrap reports', async (t) => {
  const fixture = await profileFixture(t),
    config = path.join(fixture.root, 'paqvilo.config.json');
  const platform = { QueryLinkEntityLimit: 50, evidence: 'Invented approved support ticket' };
  await fs.writeFile(
    config,
    JSON.stringify({
      sourceRoot: fixture.root,
      sites: {
        synthetic: {
          source: 'portal',
          environments: { local: 'http://127.0.0.1:9999' },
          mirage: { solutionRoots: ['solution'], platform },
        },
      },
    }),
  );
  const inputs = await resolveReportInputs({ config, site: 'synthetic' });
  const report = await bootstrapReport(inputs, { noCache: true });
  assert.equal(report.platformSettings.find((row) => row.key === 'QueryLinkEntityLimit').value, 50);
  const context = await createMirageContext({ config, site: 'synthetic' });
  assert.equal(new context.DataStore({ state: state() }).querySettings().fetchLimits.links, 50);
  const app = await context.createSimulator({ watch: false });
  t.after(() => app.close());
  const status = await fetch(app.url + '/_sim/api/status').then((r) => r.json());
  assert.equal(status.platformSettings.find((row) => row.key === 'QueryLinkEntityLimit').origin, 'Catalogue');
});
test('HTTP scoped Web API FetchXML omission deduplicates roots and pages while explicit false keeps multiplicity', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-permission-query-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [file, body] of Object.entries({
    'website.yml': 'adx_websiteid: site\nadx_name: Invented',
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /',
    'Api.sitesetting.yml': 'adx_name: Webapi/item/enabled\nadx_value: True',
    'Fields.sitesetting.yml': 'adx_name: Webapi/item/fields\nadx_value: itemid,title',
  }))
    await fs.writeFile(path.join(root, file), body);
  const app = await createSimulator({
    sourceDir: root,
    watch: false,
    initial: {
      settings: { permissionMode: 'enforce' },
      mappings: {
        item: { entitySet: 'items', idColumn: 'itemid' },
        membership: { idColumn: 'membershipid', entitySet: 'memberships' },
      },
      tables: {
        item: [
          { itemid: 'one', title: 'One' },
          { itemid: 'two', title: 'Two' },
        ],
        membership: ['one', 'two'].flatMap((itemid) =>
          [0, 1, 2].map((index) => ({ membershipid: itemid + index, itemid, contactid: 'person' })),
        ),
      },
      permissions: [
        {
          id: 'membership',
          entity: 'membership',
          scope: 'contact',
          field: 'contactid',
          roles: ['Member'],
          operations: ['read'],
        },
        {
          id: 'item-parent',
          entity: 'item',
          scope: 'parent',
          parentPermissionId: 'membership',
          relationship: { entity: 'membership', from: 'itemid', to: 'itemid' },
          roles: ['Member'],
          operations: ['read'],
        },
      ],
    },
  });
  t.after(() => app.close());
  const headers = signInHeaders(app, 'person', { roles: ['Member'] }),
    fetchXml = async (xml) => {
      const response = await fetch(app.url + '/_api/items?fetchXml=' + encodeURIComponent(xml), { headers });
      assert.equal(response.status, 200, await response.clone().text());
      return response.json();
    };
  const xml = '<fetch><entity name="item"><attribute name="itemid"/><order attribute="itemid"/></entity></fetch>';
  assert.deepEqual(
    (await fetchXml(xml)).value.map((row) => row.itemid),
    ['one', 'two'],
  );
  const first = await fetchXml(xml.replace('<fetch>', '<fetch count="1">'));
  assert.equal(first.value.length, 1);
  const wrapper = first['@Microsoft.Dynamics.CRM.fetchxmlpagingcookie'];
  assert.match(wrapper, /pagingcookie="/);
  const cookie = decodeURIComponent(decodeURIComponent(/pagingcookie="([^"]+)"/.exec(wrapper)[1]))
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  const second = await fetchXml(xml.replace('<fetch>', `<fetch count="1" page="2" paging-cookie="${cookie}">`));
  assert.deepEqual(
    [...first.value, ...second.value].map((row) => row.itemid),
    ['one', 'two'],
  );
  assert.equal((await fetchXml(xml.replace('<fetch>', '<fetch distinct="false">'))).value.length, 6);
});
