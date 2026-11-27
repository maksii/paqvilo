// Adapter for the portal-dataverse-query surface: one recorded portal query (a Liquid {% fetchxml %} or a portal Web API
// read) -> the same query through Mirage's portal -> the portal's answer in the recorder's projection.
//
// The recordings (hosted session F1: DATA-01d, DATA-02b, DATA-03d) ran against a synthetic fixture; this adapter holds the same
// fixture under invented names (table prefix qa_, record ids a1a1a1a1-…): seven items (a hierarchy under "A root", one
// item outside the visitor's contact scope), four children with tags, and a virtual table qa_vrow whose provider returns
// three fixed rows and writes the query it received into qa_query, as the recorded custom data provider plug-in did
// (its C# Describe is ported below), and the date group's ten daylight-saving boundary rows. The visitor holds one web role with a contact-scoped item permission, a parent-scoped
// child permission and a Global virtual-row permission; the Web API settings list the recorded columns. Items are owned by
// a seeding user, not the site's application user, in the application user's business unit, as the recorded rows were.
// One simulator serves a case file (`open`).
//
// Input: { lane: 'liquid', fetchXml, observed } renders the recorded case page template with the query; { lane: 'webapi',
// path, observed } sends the GET. `observed` is the site's observed settings, the same constant in every case.
// Projection (shared with the capture converter through projectLiquid/projectWebApi):
//   liquid: { count, more, total, cookie, rows: [{ name, kids, first, n, query? }] } as the template printed them, or
//           { error } with the Liquid error text when the query failed;
//   webapi: { status, error: { code, message, cdscode } | null, count, total, more, rows } with each row's properties
//           except @odata.etag.
// `query` (qa_query) is the provider echo read as { kind, entity, top, page, count, columns, conditions, links, orders,
// user, initiating }: the conditions of the criteria and its nested filters as one list without the recorder's
// attribution marker (a `qa_name NotEqual mk-<case>` condition that matches no row), the users as roles
// ('<application-user>' for the site's application user).
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../../server.mjs';
import { signInHeaders } from '../../../testing/session.mjs';
import { makeTemporaryDirectory, removeFixtureDirectory } from '../../../testing/owned-fixture.mjs';

const id = (n) => `a1a1a1a1-0000-4000-8000-${String(n).padStart(12, '0')}`;
const SITE = id(9001),
  ROLE = id(9002),
  CONTACT = id(9003),
  APPLICATION_USER = id(9004),
  SEED_USER = id(9005),
  BUSINESS_UNIT = id(9006),
  PAGE = id(9007),
  TEMPLATE = id(9008),
  PAGE_TEMPLATE = id(9009),
  OTHER_CONTACT = id(9010);
const ITEM = { aRoot: id(1001), aChild1: id(1002), aChild2: id(1003), aGrand: id(1004), bRoot: id(1005) };
const ITEMS = [
  { qa_itemid: ITEM.aRoot, qa_name: 'A root', qa_amount: 10, qa_contact: CONTACT },
  { qa_itemid: ITEM.aChild1, qa_name: 'A child 1', qa_amount: 20, qa_parentitem: ITEM.aRoot, qa_contact: CONTACT },
  { qa_itemid: ITEM.aChild2, qa_name: 'A child 2', qa_amount: 30, qa_parentitem: ITEM.aRoot, qa_contact: CONTACT },
  { qa_itemid: ITEM.aGrand, qa_name: 'A grandchild', qa_amount: 40, qa_parentitem: ITEM.aChild1, qa_contact: CONTACT },
  { qa_itemid: ITEM.bRoot, qa_name: 'B root', qa_amount: 50, qa_contact: CONTACT },
  { qa_itemid: id(1006), qa_name: 'Hidden other', qa_amount: 60, qa_parentitem: ITEM.aRoot, qa_contact: OTHER_CONTACT },
  { qa_itemid: id(1007), qa_name: 'File holder', qa_amount: 70, qa_contact: CONTACT },
  // The date group's fixed daylight-saving boundary rows (UTC instants): UserLocal qa_when, the same wall time in the
  // TimeZoneIndependent qa_tzi and its UTC date in the DateOnly qa_day, as the recording seeded them.
  ...[
    [1401, 'dst us-start 06:30Z', '2026-03-08T06:30:00Z'],
    [1402, 'dst us-start 07:30Z', '2026-03-08T07:30:00Z'],
    [1403, 'dst eu-start 00:30Z', '2026-03-29T00:30:00Z'],
    [1404, 'dst eu-start 01:30Z', '2026-03-29T01:30:00Z'],
    [1405, 'dst eu-start 22:30Z prev', '2026-03-28T22:30:00Z'],
    [1406, 'dst eu-start 23:30Z prev', '2026-03-28T23:30:00Z'],
    [1407, 'dst summer 0615 21:30Z', '2026-06-15T21:30:00Z'],
    [1408, 'dst summer 0616 04:30Z', '2026-06-16T04:30:00Z'],
    [1409, 'dst winter 0115 21:30Z', '2026-01-15T21:30:00Z'],
    [1410, 'dst winter 0116 04:30Z', '2026-01-16T04:30:00Z'],
  ].map(([n, name, when]) => ({
    qa_itemid: id(n),
    qa_name: name,
    qa_when: when,
    qa_tzi: when.slice(0, 19),
    qa_day: when.slice(0, 10),
    qa_contact: CONTACT,
  })),
].map((row) => ({ ...row, ownerid: SEED_USER, owningbusinessunit: BUSINESS_UNIT }));
const CHILDREN = [
  { qa_childid: id(1101), qa_name: 'C1 of A root', qa_tag: 'x', qa_amount: 1, qa_item: ITEM.aRoot },
  { qa_childid: id(1102), qa_name: 'C2 of A root', qa_tag: 'y', qa_amount: 2, qa_item: ITEM.aRoot },
  { qa_childid: id(1103), qa_name: 'C3 of A child 1', qa_tag: 'x', qa_amount: 3, qa_item: ITEM.aChild1 },
  { qa_childid: id(1104), qa_name: 'C4 of Hidden other', qa_tag: 'x', qa_amount: 4, qa_item: id(1006) },
];
const VIRTUAL_ROWS = [
  [id(3001), 'virtual one', 1],
  [id(3002), 'virtual two', 2],
  [id(3003), 'virtual three', 3],
];

// The recorded provider plug-in's Describe(QueryExpression), ported: what the provider received.
const conditionText = (condition) =>
  `${condition.attributeName} ${condition.operatorName} ${(condition.values ?? [])
    .map((value) => (value && typeof value === 'object' ? value.value : value))
    .join('|')}`;
function describe(query) {
  if (!query) return 'null';
  const criteria = query.criteria ?? { conditions: [], filters: [] };
  return (
    `qe:${query.entityName} top=${query.topCount ?? ''} page=${query.pageInfo?.pageNumber ?? ''}/${query.pageInfo?.count ?? ''}` +
    ` cols=${query.columnSet?.allColumns ? '*' : (query.columnSet?.columns ?? []).join(',')}` +
    ` where=${(criteria.conditions ?? []).map(conditionText).join(';')}` +
    ` nested=${(criteria.filters ?? [])
      .flatMap((filter) => filter.conditions ?? [])
      .map(conditionText)
      .join(';')}` +
    ` links=${(query.linkEntities ?? [])
      .map(
        (link) =>
          `${link.linkToEntityName}.${link.linkToAttributeName}=${link.linkFromAttributeName} ${link.joinOperator}`,
      )
      .join(';')}` +
    ` order=${(query.orders ?? []).map((order) => `${order.attributeName} ${order.descending ? 'Descending' : 'Ascending'}`).join(';')}`
  );
}
const providerRow = ([rowId, name, amount], query) => ({
  qa_vrowid: rowId,
  qa_name: name,
  qa_amount: amount,
  qa_query: query.length > 3900 ? query.slice(0, 3900) : query,
});
const echoProvider = {
  retrieveMultiple: (request, ctx) => {
    const text = `${describe(request?.query)} user=${ctx.userId} initiating=${ctx.initiatingUserId}`;
    return VIRTUAL_ROWS.map((row) => providerRow(row, text));
  },
  retrieve: (rowId, ctx) => {
    const row = VIRTUAL_ROWS.find(([candidate]) => candidate === String(rowId).toLowerCase());
    if (!row) throw new Error('qa_vrow row not found');
    return providerRow(row, `retrieve user=${ctx.userId}`);
  },
};

/** The provider echo as one object (see the header); `roles` maps a user id to its role name. */
export function readEcho(text, roles = {}) {
  if (typeof text !== 'string' || text === '') return text ?? null;
  const role = (value) => roles[String(value).toLowerCase()] ?? value;
  const single = /^retrieve user=(\S*)$/.exec(text);
  if (single) return { kind: 'retrieve', user: role(single[1]) };
  const match =
    /^qe:(\S+) top=(\S*) page=(\S*)\/(\S*) cols=(\S*) where=(.*?) nested=(.*?) links=(.*?) order=(.*?) user=(\S*) initiating=(\S*)$/.exec(
      text,
    );
  if (!match) return { kind: 'other', text };
  const list = (value) => value.split(';').filter(Boolean);
  return {
    kind: 'qe',
    entity: match[1],
    top: match[2],
    page: match[3],
    count: match[4],
    columns: list(match[5].replaceAll(',', ';')),
    conditions: [...list(match[6]), ...list(match[7])].filter((condition) => !/^\S+ NotEqual mk-/.test(condition)),
    links: list(match[8]),
    orders: list(match[9]),
    user: role(match[10]),
    initiating: role(match[11]),
  };
}

const LIQUID_ERROR = /Liquid error: [^"\]]+/;
/** The Liquid case page's printed result (see the header). */
export function projectLiquid(printed, roles) {
  let data;
  try {
    data = JSON.parse(printed);
  } catch {
    return { error: LIQUID_ERROR.exec(printed)?.[0] ?? printed };
  }
  return {
    count: data.count,
    more: data.more,
    total: data.total,
    cookie: data.cookie,
    rows: (data.rows ?? []).map(({ name, kids, first, n, q }) => ({
      name,
      kids,
      first,
      n,
      ...(q ? { query: readEcho(q, roles) } : {}),
    })),
  };
}
/** A portal Web API answer (see the header). */
export function projectWebApi(status, body, roles) {
  const error = body?.error
    ? { code: body.error.code ?? null, message: body.error.message ?? null, cdscode: body.error.cdscode ?? null }
    : null;
  return {
    status,
    error,
    count: body?.['@odata.count'] ?? null,
    total: body?.['@Microsoft.Dynamics.CRM.totalrecordcount'] ?? null,
    more: body?.['@Microsoft.Dynamics.CRM.morerecords'] ?? false,
    rows: Array.isArray(body?.value)
      ? body.value.map((row) => {
          const out = {};
          for (const [key, value] of Object.entries(row))
            if (key !== '@odata.etag') out[key] = key === 'qa_query' ? readEcho(value, roles) : value;
          return out;
        })
      : body && !body.error && typeof body === 'object'
        ? [
            Object.fromEntries(
              Object.entries(body)
                .filter(([key]) => key !== '@odata.etag' && key !== '@odata.context')
                .map(([key, value]) => [key, key === 'qa_query' ? readEcho(value, roles) : value]),
            ),
          ]
        : [],
  };
}

const ROWS_TEMPLATE =
  '[{% for e in q.results.entities %}{"name":"{{ e.qa_name | escape }}","kids":"{{ e.kids }}","first":"{{ e[\'first.qa_name\'] | escape }}","n":"{{ e.n }}","q":"{{ e.qa_query | escape }}"}{% unless forloop.last %},{% endunless %}{% endfor %}]';
// The recorded case page template around one query (request parameters are HTML-encoded on output, so the query is
// written into the template source and the site reloaded, as the recorded page held each query literally).
const caseTemplate = (fetchXml) =>
  `{% fetchxml q %}${fetchXml}{% endfetchxml %}<pre id="out">{"count":"{{ q.results.entities.size }}","more":"{{ q.results.more_records }}","total":"{{ q.results.total_record_count }}","cookie":"{{ q.results.paging_cookie | escape }}","rows":` +
  ROWS_TEMPLATE +
  '}</pre>';
const TEMPLATE_FILE = 'cases.webtemplate.source.html';

const settings = {
  'Webapi/qa_item/enabled': 'true',
  'Webapi/qa_item/fields':
    'qa_itemid,qa_name,qa_amount,qa_when,qa_day,qa_tzi,qa_file,qa_image,qa_thumb,qa_contact,qa_account,qa_parentitem',
  'Webapi/qa_child/enabled': 'true',
  'Webapi/qa_child/fields': 'qa_name,qa_amount,qa_tag,qa_item',
  'Webapi/qa_vrow/enabled': 'true',
  'Webapi/qa_vrow/fields': 'qa_vrowid,qa_name,qa_amount,qa_query',
};

const initial = {
  version: 1,
  mappings: {
    qa_item: {
      logicalName: 'qa_item',
      entitySet: 'qa_items',
      idColumn: 'qa_itemid',
      nameColumn: 'qa_name',
      fields: {
        qa_name: { dataverseType: 'nvarchar' },
        qa_amount: { dataverseType: 'int' },
        qa_contact: { dataverseType: 'lookup' },
        qa_parentitem: { dataverseType: 'lookup' },
        qa_when: { dataverseType: 'datetime', dateTimeBehavior: 'UserLocal' },
        qa_day: { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly', format: 'DateOnly' },
        qa_tzi: { dataverseType: 'datetime', dateTimeBehavior: 'TimeZoneIndependent' },
        ownerid: { dataverseType: 'lookup' },
        owningbusinessunit: { dataverseType: 'lookup' },
      },
      relationships: {
        qa_parentitem: { entity: 'qa_item', from: 'qa_parentitem', to: 'qa_itemid', many: false, hierarchical: true },
        qa_children: { entity: 'qa_child', from: 'qa_itemid', to: 'qa_item', many: true },
      },
    },
    qa_child: {
      logicalName: 'qa_child',
      entitySet: 'qa_children',
      idColumn: 'qa_childid',
      nameColumn: 'qa_name',
      fields: {
        qa_name: { dataverseType: 'nvarchar' },
        qa_tag: { dataverseType: 'nvarchar' },
        qa_amount: { dataverseType: 'int' },
        qa_item: { dataverseType: 'lookup' },
      },
      relationships: { qa_item: { entity: 'qa_item', from: 'qa_item', to: 'qa_itemid', many: false } },
    },
    qa_vrow: {
      logicalName: 'qa_vrow',
      entitySet: 'qa_vrows',
      idColumn: 'qa_vrowid',
      nameColumn: 'qa_name',
      isVirtual: true,
      fields: {
        qa_name: { dataverseType: 'nvarchar' },
        qa_amount: { dataverseType: 'int' },
        qa_query: { dataverseType: 'ntext' },
      },
    },
  },
  tables: {
    contact: [
      { contactid: CONTACT, fullname: 'Invented visitor' },
      { contactid: OTHER_CONTACT, fullname: 'Invented other visitor' },
    ],
    businessunit: [{ businessunitid: BUSINESS_UNIT, name: 'Invented root unit' }],
    systemuser: [
      { systemuserid: APPLICATION_USER, fullname: '# Portals-invented', businessunitid: BUSINESS_UNIT },
      { systemuserid: SEED_USER, fullname: 'Invented seeding user', businessunitid: BUSINESS_UNIT },
    ],
    qa_item: ITEMS,
    qa_child: CHILDREN,
    qa_vrow: [],
  },
  permissions: [
    {
      id: 'item-contact',
      entity: 'qa_item',
      scope: 'contact',
      field: 'qa_contact',
      roles: ['Invented role'],
      operations: ['read', 'update', 'create', 'append', 'appendTo'],
    },
    {
      id: 'child-parent',
      entity: 'qa_child',
      scope: 'parent',
      parentPermissionId: 'item-contact',
      relationship: { entity: 'qa_item', from: 'qa_item', to: 'qa_itemid' },
      roles: ['Invented role'],
      operations: ['read'],
    },
    { id: 'vrow-global', entity: 'qa_vrow', scope: 'global', roles: ['Invented role'], operations: ['read'] },
  ],
  settings: { permissionMode: 'enforce' },
  simulator: { mode: 'local', pageMode: 'local', endpoints: [] },
};

async function writeSite(directory) {
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Invented query site\n`,
    'webrole.yml': `adx_webroleid: ${ROLE}\nadx_name: Invented role\n`,
    'cases.webpage.yml': `adx_webpageid: ${PAGE}\nadx_name: Cases\nadx_partialurl: cases\nadx_pagetemplateid: ${PAGE_TEMPLATE}\n`,
    'cases.pagetemplate.yml': `adx_pagetemplateid: ${PAGE_TEMPLATE}\nadx_webtemplateid: ${TEMPLATE}\n`,
    'cases.webtemplate.yml': `adx_webtemplateid: ${TEMPLATE}\nadx_name: Cases\n`,
    [TEMPLATE_FILE]: caseTemplate('<fetch><entity name="qa_item"><attribute name="qa_name"/></entity></fetch>'),
    'sitesetting.yml': Object.entries(settings)
      .map(([name, value]) => `- adx_name: ${name}\n  adx_value: '${value}'\n`)
      .join(''),
  };
  await Promise.all(Object.entries(files).map(([name, body]) => fs.writeFile(path.join(directory, name), body)));
}

const ROLES = { [APPLICATION_USER]: '<application-user>' };

export async function open() {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-replay-portal-query-'));
  let app = null,
    observed = null,
    cookie = null;
  const start = async (wanted) => {
    await app?.close();
    app = await createSimulator({
      sourceDir: directory,
      initial,
      observed: wanted,
      watch: false,
      port: 0,
      packs: [
        {
          id: 'portal-query-fixture',
          name: 'Portal query fixture',
          description: 'Invented hosted F1 query fixture',
          matches: () => true,
          presets: () => ({}),
          virtualTableProviders: { qa_vrow: echoProvider },
        },
      ],
    });
    observed = JSON.stringify(wanted);
    ({ cookie } = signInHeaders(app, CONTACT, { roles: ['Invented role'] }));
  };
  try {
    await writeSite(directory);
  } catch (error) {
    await removeFixtureDirectory(directory);
    throw error;
  }
  return {
    async run(input) {
      if (observed !== JSON.stringify(input.observed)) await start(input.observed);
      if (input.lane === 'liquid') {
        await fs.writeFile(path.join(directory, TEMPLATE_FILE), caseTemplate(input.fetchXml));
        await app.reload();
        const response = await fetch(`${app.url}/cases/`, { headers: { cookie, accept: 'text/html' } });
        const html = await response.text();
        const printed = /<pre id="out">([\s\S]*?)<\/pre>/.exec(html)?.[1] ?? html;
        return projectLiquid(printed, ROLES);
      }
      const response = await fetch(app.url + input.path, { headers: { cookie, accept: 'application/json' } });
      const text = await response.text();
      let body;
      try {
        body = JSON.parse(text);
      } catch {
        // A body that is not JSON projects as no body.
        body = null;
      }
      return projectWebApi(response.status, body, ROLES);
    },
    async close() {
      await app?.close();
      await removeFixtureDirectory(directory);
    },
  };
}
