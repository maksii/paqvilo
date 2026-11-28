// @test-kind contract: invented loopback fixtures exercise qualified portal FetchXML conditions and authored N:N joins
import assert from 'node:assert/strict';
import test from 'node:test';
import { executeBatch } from '../lib/dataverse-tds-sql-eval.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { simulatorFixture, sourceFixture } from './fixtures/source-site.mjs';
import { monitorPortal, monitorState } from './support/monitor-runtime.mjs';

const id = (n) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`;
const ownContact = id(1);
const foreignContact = id(2);
const noRoleContact = id(3);
const nativeClassic = {
  tablePermissionQueryPipeline: 'native-classic',
  evidence: 'Invented classic permission fixture',
};
const nullableText = {
  portalFetchTextInequality: 'include-explicit-null',
  evidence: 'Invented explicit-null text inequality fixture',
};

function readPage(queries, idColumn, labelColumn) {
  const cases = Object.entries(queries)
    .map(([variant, query]) => `{% when '${variant}' %}${query}`)
    .join('');
  const idOutput = `{{ row.${idColumn} | json }}`;
  const labelOutput = labelColumn ? `,"label":{{ row['${labelColumn}'] | default: '' | json }}` : '';
  return (
    `{% fetchxml records %}{% case request.params.variant %}${cases}{% endcase %}{% endfetchxml %}` +
    `[{% for row in records.results.entities %}{"id":${idOutput}${labelOutput}}{% unless forloop.last %},{% endunless %}{% endfor %}]`
  );
}

async function startSite(t, { state, observed, source, extra, solution }) {
  const files = monitorPortal({ name: 'Sample portal', source, fields: 'x_itemid,x_name,x_ownerid,x_count', extra });
  files['Main.pagetemplate.yml'] += '\nadx_usewebsiteheaderandfooter: false';
  files['Main.webtemplate.yml'] += '\nadx_mimetype: application/json';
  files['webrole.yml'] += '\n- adx_webroleid: reader\n  adx_name: Reader';
  state.settings.permissionMode = 'enforce';
  state.tables.contact = [
    { contactid: ownContact, fullname: 'First reader', statecode: 0 },
    { contactid: foreignContact, fullname: 'Second reader', statecode: 0 },
    { contactid: noRoleContact, fullname: 'Guest', statecode: 0 },
  ];
  const sim = await simulatorFixture(t, {
    prefix: 'portal-fetchxml-qualification-',
    files,
    initial: state,
    port: 0,
    watch: false,
    observed,
    ...(solution ? { solutionRoots: [solution], solutionOrder: 'explicit' } : {}),
  });
  const signed = sim.signIn(ownContact, { roles: ['Reader'] });
  const request = (route, session = signed) =>
    fetch(sim.url + route, { headers: { cookie: session.cookieHeader, __RequestVerificationToken: sim.csrf } });
  return { sim, signed, request };
}

async function page(site, variant, session) {
  const response = await site.request('/?variant=' + variant, session);
  assert.equal(response.status, 200);
  return response.json();
}

function api(site, set, xml) {
  return site.request(`/_api/${set}?fetchXml=${encodeURIComponent(xml)}`);
}

const teamId = id(4);
const otherTeamId = id(5);
const teamFilter = '<filter><condition attribute="x_name" operator="eq" value="Sample team"/></filter>';
function teamQuery({
  edge = 'x_membership',
  from = 'contactid',
  projection = '',
  endpointFilter = teamFilter,
  edgeFilter = '',
  endpoint = true,
  rootFilter = '',
} = {}) {
  const target = endpoint
    ? `<link-entity name="x_team" from="x_teamid" to="x_teamid" alias="team">${projection}${endpointFilter}</link-entity>`
    : '<attribute name="x_teamid"/>';
  return (
    '<fetch><entity name="contact"><attribute name="contactid"/>' +
    `<link-entity name="${edge}" from="${from}" to="contactid" intersect="true" alias="membership">${target}${edgeFilter}</link-entity>` +
    `${rootFilter}</entity></fetch>`
  );
}

async function staffSite(t, observed, teamRead = false) {
  const queries = {
    self: teamQuery(),
    foreign: teamQuery({
      rootFilter: `<filter><condition attribute="contactid" operator="eq" value="${foreignContact}"/></filter>`,
    }),
    projection: teamQuery({ projection: '<attribute name="x_name"/>' }),
    filterMismatch: teamQuery({
      endpointFilter: teamFilter.replace('Sample team', 'Other team'),
      projection: '<attribute name="x_name"/>',
    }),
    unattributed: teamQuery({ endpoint: false }),
    invalid: teamQuery({ from: 'x_teamid' }),
    unrelated: teamQuery({ edge: 'x_unrelated', endpoint: false }),
  };
  const state = monitorState();
  state.mappings = {
    x_team: { entitySet: 'x_teams', idColumn: 'x_teamid', nameColumn: 'x_name' },
    x_unrelated: { entitySet: 'x_unrelateds', idColumn: 'x_unrelatedid' },
  };
  state.tables = {
    x_team: [
      { x_teamid: teamId, x_name: 'Sample team', x_ownerid: foreignContact },
      { x_teamid: otherTeamId, x_name: 'Other team' },
    ],
    x_membership: [
      { x_membershipid: id(6), contactid: ownContact, x_teamid: teamId, x_hidden: 'private' },
      { x_membershipid: id(7), contactid: foreignContact, x_teamid: teamId },
      { x_membershipid: id(8), contactid: foreignContact, x_teamid: otherTeamId },
      { x_membershipid: id(9), contactid: noRoleContact, x_teamid: teamId },
    ],
    x_unrelated: [{ x_unrelatedid: id(10), contactid: foreignContact, x_teamid: otherTeamId }],
  };
  state.permissions = [{ id: 'own', entity: 'contact', scope: 'self', operations: ['read'], roles: ['Reader'] }];
  if (teamRead)
    state.permissions.push({
      id: 'own-team',
      entity: 'x_team',
      scope: 'contact',
      field: 'x_ownerid',
      operations: ['read'],
      roles: ['Reader'],
    });
  const settings = [
    ['contact', 'contactid'],
    ['x_team', 'x_teamid,x_name'],
    ['x_membership', 'contactid,x_teamid'],
  ].flatMap(([table, fields]) => [
    { adx_name: `Webapi/${table}/enabled`, adx_value: 'true' },
    { adx_name: `Webapi/${table}/fields`, adx_value: fields },
  ]);
  const { sourceDir: solution } = await sourceFixture(t, {
    prefix: 'portal-fetchxml-relationship-',
    files: {
      'Other/Relationships.xml': `
        <EntityRelationships>
          <EntityRelationship Name="x_teams">
            <EntityRelationshipType>ManyToMany</EntityRelationshipType>
            <FirstEntityName>contact</FirstEntityName>
            <SecondEntityName>x_team</SecondEntityName>
            <IntersectEntityName>x_membership</IntersectEntityName>
            <Entity1IntersectAttribute>contactid</Entity1IntersectAttribute>
            <Entity2IntersectAttribute>x_teamid</Entity2IntersectAttribute>
          </EntityRelationship>
        </EntityRelationships>`,
    },
  });
  return startSite(t, {
    state,
    observed,
    solution,
    source: readPage(queries, 'contactid', 'team.x_name'),
    extra: { 'sitesetting.yml': JSON.stringify(settings) },
  });
}

test('classic authored Liquid can traverse the mapped N:N edge for its authorized root', async (t) => {
  const site = await staffSite(t, nativeClassic);
  assert.equal(site.sim.store.resolveMapping('contact').relationships.x_teams.schemaName, 'x_teams');
  assert.deepEqual(await page(site, 'self'), [{ id: ownContact, label: '' }]);
  assert.deepEqual(await page(site, 'projection'), [{ id: ownContact, label: 'Sample team' }]);
  for (const variant of ['foreign', 'filterMismatch', 'unattributed', 'invalid', 'unrelated'])
    assert.deepEqual(await page(site, variant), [], variant);
  const unrelatedFilter = teamQuery({ edgeFilter: inequality('x_hidden', 'other') });
  assert.throws(
    () =>
      site.sim.store.fetchXml(unrelatedFilter, site.signed.identity, {
        portalRequest: true,
        liquidTag: true,
      }),
    { code: 'InvalidIntersectionQuery' },
  );
  const unprivileged = site.sim.signIn(noRoleContact, { roles: [] });
  assert.deepEqual(await page(site, 'self', unprivileged), []);
  const denied = await api(site, 'contacts', teamQuery());
  assert.equal(denied.status, 403, await denied.text());
});

test('ordinary row-filtered Liquid still requires a readable N:N endpoint', async (t) => {
  const site = await staffSite(t);
  assert.deepEqual(await page(site, 'self'), []);
  assert.deepEqual(await page(site, 'projection'), []);
  const denied = await api(site, 'contacts', teamQuery());
  assert.equal(denied.status, 403, await denied.text());
});

test('classic portal Web API still checks the row grant on the mapped N:N endpoint', async (t) => {
  const site = await staffSite(t, nativeClassic, true);
  assert.deepEqual(await page(site, 'projection'), [{ id: ownContact, label: 'Sample team' }]);
  const xml = teamQuery({ projection: '<attribute name="x_name"/>' });
  const filtered = await api(site, 'contacts', xml);
  assert.equal(filtered.status, 200);
  assert.deepEqual((await filtered.json()).value, []);
  await site.sim.store.transact(() => {
    site.sim.store.state.tables.x_team[0].x_ownerid = ownContact;
  });
  const allowed = await api(site, 'contacts', xml);
  assert.equal(allowed.status, 200);
  const [{ contactid, 'team.x_name': name }] = (await allowed.json()).value;
  assert.deepEqual({ contactid, name }, { contactid: ownContact, name: 'Sample team' });
});

const marker = '2030-01-01T00:00:00Z';
const nullTextId = id(11);
const distinctId = id(12);
const markerId = id(13);
const emptyId = id(14);
const missingId = id(15);
const foreignId = id(16);
const draftQuery = (condition = '') =>
  `<fetch><entity name="x_item"><attribute name="x_itemid"/><order attribute="x_itemid"/>${condition}</entity></fetch>`;
const inequality = (attribute, value, operator = 'ne') =>
  `<filter><condition attribute="${attribute}" operator="${operator}" value="${value}"/></filter>`;
const explicitNullKey = `<filter><condition attribute="x_itemid" operator="eq" value="${nullTextId}"/></filter>`;
const draftQueries = {
  all: draftQuery(),
  text: draftQuery(inequality('x_name', marker)),
  textAlias: draftQuery(inequality('x_name', marker, 'neq')),
  keyed: draftQuery(explicitNullKey),
  keyedText: draftQuery(explicitNullKey + inequality('x_name', marker)),
  count: draftQuery(inequality('x_count', 1)),
};

async function draftSite(t, observed, secured = false) {
  const state = monitorState({
    rows: [
      { x_itemid: nullTextId, x_name: null, x_ownerid: ownContact, x_count: null },
      { x_itemid: distinctId, x_name: 'A different title', x_ownerid: ownContact, x_count: 2 },
      { x_itemid: markerId, x_name: marker, x_ownerid: ownContact, x_count: 1 },
      { x_itemid: emptyId, x_name: '', x_ownerid: ownContact },
      { x_itemid: missingId, x_ownerid: ownContact },
      { x_itemid: foreignId, x_name: null, x_ownerid: foreignContact, x_count: null },
    ],
  });
  state.mappings.x_item.fields = {
    x_name: { dataverseType: 'nvarchar', ...(secured ? { columnMetadata: { isSecured: true } } : {}) },
    x_ownerid: { dataverseType: 'lookup', target: 'contact' },
    x_count: { dataverseType: 'int' },
  };
  if (secured) {
    state.mappings.x_item.nameColumn = 'x_title';
    state.mappings.x_item.fields.x_title = { dataverseType: 'nvarchar' };
  }
  state.permissions = [
    {
      id: 'owned-drafts',
      entity: 'x_item',
      scope: 'contact',
      field: 'x_ownerid',
      operations: ['read'],
      roles: ['Reader'],
    },
  ];
  return startSite(t, {
    state,
    observed,
    source: readPage(draftQueries, 'x_itemid'),
    ...(secured
      ? { extra: { 'website.yml': 'adx_websiteid: site\nadx_name: Invented\nadx_enhancedauthorization: 3' } }
      : {}),
  });
}

async function verifyBoundaries(site, expectedText) {
  const direct = await site.request(`/_api/x_items(${nullTextId})?$select=x_name`);
  assert.equal(direct.status, 200);
  assert.equal((await direct.json()).x_name, null);
  const all = [nullTextId, distinctId, markerId, emptyId, missingId];
  for (const [variant, expected] of [
    ['all', all],
    ['text', expectedText],
    ['textAlias', expectedText],
    ['keyed', [nullTextId]],
    ['keyedText', expectedText.filter((id) => id === nullTextId)],
    ['count', [distinctId]],
  ])
    await expectDraftIds(site, variant, expected);
}

async function expectDraftIds(site, variant, expected) {
  assert.deepEqual(
    (await page(site, variant)).map((row) => row.id),
    expected,
  );
  const response = await api(site, 'x_items', draftQueries[variant]);
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).value.map((row) => row.x_itemid),
    expected,
  );
}

test('qualified portal FetchXML text inequality includes only an explicit admitted null and a different text', async (t) => {
  const site = await draftSite(t, { ...nativeClassic, ...nullableText });
  await verifyBoundaries(site, [nullTextId, distinctId]);
  const { store } = site.sim;
  assert.deepEqual(store.fetchXml(draftQueries.text, site.signed.identity).entities, [{ x_itemid: distinctId }]);
  assert.deepEqual(store.fetchXml(draftQueries.text, site.signed.identity, { portalRequest: true }).entities, [
    { x_itemid: distinctId },
  ]);
  assert.deepEqual(store.fetchXml(draftQueries.text, { admin: true }, { sdkResult: true }).entities, [
    { x_itemid: distinctId },
  ]);
  const table = {
    logicalName: 'x_item',
    columns: [{ name: 'x_name', sqlType: 'nvarchar', nullable: true }],
  };
  const sql = await executeBatch(`SELECT x_name FROM x_item WHERE x_name <> '${marker}'`, {
    catalog: { tables: new Map([['x_item', table]]) },
    scan: () => [{ x_name: null }, { x_name: marker }, { x_name: 'A different title' }],
  });
  assert.deepEqual(sql.resultSets[0].rows, [['A different title']]);
});

test('a computed text null does not count as an explicit stored value for portal FetchXML', async (t) => {
  const site = await draftSite(t, nullableText);
  site.sim.store.setComputedColumns('calculated-name', {
    columnsOf: (logical) => (logical === 'x_item' ? ['x_name'] : []),
    compute: () => null,
  });
  const direct = await site.request(`/_api/x_items(${distinctId})?$select=x_name`);
  assert.equal(direct.status, 200);
  assert.equal((await direct.json()).x_name, null);
  await expectDraftIds(site, 'text', []);
});

test('unqualified portal FetchXML keeps ordinary text inequality and qualification requires evidence', async (t) => {
  assert.throws(() => observedConfig({ portalFetchTextInequality: 'include-explicit-null' }), /evidence/);
  const site = await draftSite(t, nativeClassic);
  await verifyBoundaries(site, [distinctId]);
});

test('the native scalar OData adapter retains its own text inequality when portal FetchXML opts in', async (t) => {
  const site = await draftSite(t, {
    ...nativeClassic,
    ...nullableText,
    odataPermissionQueryPipeline: 'native-classic',
  });
  await expectDraftIds(site, 'text', [nullTextId, distinctId]);
  const params = new URLSearchParams({ $select: 'x_itemid', $filter: `x_name ne '${marker}'` });
  const response = await site.request(`/_api/x_items?${params}`);
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await response.json()).value.map((row) => row.x_itemid),
    [distinctId],
  );
});

// @test-kind security: a null introduced by Dataverse field security cannot qualify the observed text inequality
test('unreadable text columns do not match as explicit nulls in Liquid or the portal Web API', async (t) => {
  const site = await draftSite(t, nullableText, true);
  const unfiltered = await page(site, 'all');
  assert.deepEqual(
    unfiltered.map((row) => row.id),
    [nullTextId, distinctId, markerId, emptyId, missingId],
  );
  const direct = await site.request(`/_api/x_items(${distinctId})?$select=x_name`);
  assert.equal(direct.status, 200);
  assert.equal((await direct.json()).x_name, null);
  await expectDraftIds(site, 'text', []);
});
