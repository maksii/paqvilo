// SOAP Organization service over the record handlers.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { ensureSecurityModel, createPrincipals } from '../lib/dataverse-security.mjs';
import { createRecordHandlers, createRecordHooks } from '../lib/dataverse-records.mjs';
import { install as installDuplicates } from '../lib/dataverse-duplicates.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { NS } from '../lib/dataverse-soap-xml.mjs';
import { runAtomic } from '../lib/dataverse-api.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';
import { DataError } from '../lib/data-error.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const ORG = '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const BASIC_OID = 'aaaaaaaa-0000-4000-8000-000000000002';
const MISSING = '00000000-0000-4000-8000-0000000000ff';
const CLOCK = Date.parse('2026-10-19T10:00:00Z');
const SETTINGS = {
  organizationId: ORG,
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [
    { objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] },
    { objectId: BASIC_OID, upn: 'basic@example.test', displayName: 'Basic', roles: ['Basic User'] },
  ],
};

const text = { dataverseType: 'nvarchar' };
const lookup = { dataverseType: 'lookup' };

// Tables: widget (org-owned, alternate key, a date), gadget (user-owned, lookup to widget), tag, widget_tag.
function fixtureState() {
  const state = emptyState();
  state.mappings.widget = {
    logicalName: 'widget',
    entitySet: 'widgets',
    idColumn: 'widgetid',
    nameColumn: 'name',
    alternateKeys: [{ name: 'widget_code', attributes: ['code'] }],
    relationships: {
      widget_tags: {
        entity: 'tag',
        from: 'widgetid',
        to: 'tagid',
        many: true,
        intersect: { entity: 'widget_tag', from: 'widgetid', to: 'tagid' },
      },
    },
    fields: {
      name: text,
      code: text,
      price: { dataverseType: 'money' },
      closedon: { dataverseType: 'datetime' },
      statecode: { dataverseType: 'int' },
      statuscode: {
        dataverseType: 'picklist',
        options: [
          { value: 1, label: 'Active', state: 0 },
          { value: 2, label: 'Inactive', state: 1 },
        ],
      },
      status: { dataverseType: 'picklist' },
      ownerid: lookup,
      owninguser: lookup,
      owningteam: lookup,
      owningbusinessunit: lookup,
      createdby: lookup,
      createdonbehalfby: lookup,
      modifiedby: lookup,
      modifiedonbehalfby: lookup,
    },
  };
  state.mappings.gadget = {
    logicalName: 'gadget',
    entitySet: 'gadgets',
    idColumn: 'gadgetid',
    nameColumn: 'name',
    ownership: 'UserOwned',
    relationships: { widgetid: { entity: 'widget', from: 'widgetid', to: 'widgetid', many: false } },
    fields: { name: text, widgetid: lookup },
  };
  state.mappings.tag = {
    logicalName: 'tag',
    entitySet: 'tags',
    idColumn: 'tagid',
    nameColumn: 'name',
    fields: { name: text },
  };
  state.mappings.widget_tag = {
    logicalName: 'widget_tag',
    entitySet: 'widget_tags',
    idColumn: 'widget_tagid',
    fields: { widgetid: lookup, tagid: lookup },
  };
  for (const logical of ['widget', 'gadget', 'tag', 'widget_tag']) state.tables[logical] = [];
  return state;
}

async function setup() {
  const store = new DataStore({ state: fixtureState() });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const changes = createChangeLog(store);
  const recordHooks = createRecordHooks();
  const records = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals,
    metadataFields: () => undefined,
    changes,
    hooks: recordHooks,
  });
  const api = {
    store,
    change: (fn) => fn(),
    registry: createOperationRegistry(),
    principals,
    metadata: null,
    metadataFields: () => undefined,
    records,
    recordHooks,
    changes,
    settings: SETTINGS,
    clock: () => CLOCK,
    log: () => {},
  };
  // The real isolated transaction, as dataverse-api.mjs wires it.
  api.runAtomic = (fn) => runAtomic(api, fn);
  const admin = principals.byObjectId(ADMIN_OID);
  const basic = principals.byObjectId(BASIC_OID);
  const send = (xml, { user = admin, headers = {} } = {}) =>
    handleSoap(
      {
        method: 'POST',
        headers,
        bodyText: xml,
        user,
        caller: user,
        identity: { admin: true, id: user.systemuserid, systemUserId: user.systemuserid },
        origin: ORIGIN,
        version: 'v9.2',
        requestId: 'test',
      },
      api,
    );
  return { store, principals, admin, basic, api, send };
}

// ---- Request builders (SOAP 1.1 Execute and body operations) ----
const DECL = Object.entries(NS)
  .map(([p, uri]) => `xmlns:${p}="${uri}"`)
  .join(' ');
const envelope = (body) => `<s:Envelope ${DECL}><s:Body>${body}</s:Body></s:Envelope>`;
const valueEl = (type, inner) => `<b:value i:type="${type}">${inner}</b:value>`;
const pair = (key, valueXml) =>
  `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key>${valueXml}</a:KeyValuePairOfstringanyType>`;
const str = (value) => valueEl('c:string', value);
const int = (value) => valueEl('c:int', value);
const bool = (value) => valueEl('c:boolean', value);
const guidValue = (id) => valueEl('e:guid', id);
const refValue = (logical, id) =>
  valueEl('a:EntityReference', `<a:Id>${id}</a:Id><a:LogicalName>${logical}</a:LogicalName><a:Name i:nil="true"/>`);
const entityValue = (logical, attributes, keys = '') =>
  valueEl(
    'a:Entity',
    `<a:Attributes>${attributes.join('')}</a:Attributes>${keys}<a:LogicalName>${logical}</a:LogicalName>`,
  );
const keyAttributes = (pairs) => `<a:KeyAttributes>${pairs.join('')}</a:KeyAttributes>`;
const execute = (type, name, pairs = []) =>
  envelope(
    `<Execute xmlns="${NS.svc}"><request i:type="a:${type}"><a:Parameters>${pairs.join('')}</a:Parameters><a:RequestName>${name}</a:RequestName></request></Execute>`,
  );
const execOne = (type, name, pairs) => execute(type, name, pairs);
const orgRequest = (type, pairs) =>
  `<a:OrganizationRequest i:type="a:${type}"><a:Parameters>${pairs.join('')}</a:Parameters></a:OrganizationRequest>`;

// ---- Response readers ----
// Fault ErrorCode, or the one inside an ExecuteMultiple item's a:Fault.
const errorCode = (xml) => Number(/<(?:a:)?ErrorCode>(-?\d+)<\/(?:a:)?ErrorCode>/.exec(xml)?.[1]);
const refIdOf = (xml, key) =>
  new RegExp(`<b:key>${key}</b:key><b:value i:type="a:EntityReference"><a:Id>([^<]+)</a:Id>`).exec(xml)?.[1];
const guidOf = (xml, key) =>
  new RegExp(`<b:key>${key}</b:key><b:value i:type="e:guid">([^<]+)</b:value>`).exec(xml)?.[1];
const cookieOf = (xml) => /<a:PagingCookie>([^<]*)<\/a:PagingCookie>/.exec(xml)?.[1];
const rowCount = (xml) => (xml.match(/<a:Entity[ >]/g) ?? []).length;
const attrText = (xml, key) =>
  new RegExp(`<b:key>${key}</b:key><b:value i:type="c:string">([^<]*)</b:value>`).exec(xml)?.[1];

test('SOAP forwards partition and session parameters, typed keys and write session results', async () => {
  const t = await setup();
  const seen = [];
  t.api.records.handle = async (ctx) => {
    seen.push(ctx);
    return {
      status: ctx.method === 'GET' ? 200 : 204,
      body: { widgetid: MISSING, name: 'partitioned' },
      headers: { 'x-ms-session-token': '0:1#local' },
    };
  };
  const target = refValue('widget', MISSING);
  const retrieved = await t.send(
    execOne('RetrieveRequest', 'Retrieve', [
      pair('Target', target),
      pair('partitionId', str('partition-one')),
      pair('SessionToken', str('0:1#read')),
    ]),
  );
  assert.equal(retrieved.status, 200, retrieved.body);
  assert.equal(seen.at(-1).url.searchParams.get('partitionId'), 'partition-one');
  assert.equal(seen.at(-1).headers['mscrm.sessiontoken'], '0:1#read');
  const keyPairs = `<a:KeyValuePairOfstringanyType><b:key>widgetid</b:key>${guidValue(MISSING)}</a:KeyValuePairOfstringanyType><a:KeyValuePairOfstringanyType><b:key>code</b:key>${str('one')}</a:KeyValuePairOfstringanyType>`;
  const keyed = entityValue('widget', [pair('name', str('changed'))], `<a:KeyAttributes>${keyPairs}</a:KeyAttributes>`);
  const updated = await t.send(
    execOne('UpdateRequest', 'Update', [pair('Target', keyed), pair('partitionId', str('ignored-for-writes'))]),
  );
  assert.equal(updated.status, 200, updated.body);
  assert.equal(decodeURIComponent(seen.at(-1).url.pathname), `/api/data/v9.2/widgets(widgetid=${MISSING},code='one')`);
  assert.equal(seen.at(-1).url.searchParams.has('partitionId'), false);
  assert.match(updated.body, /<b:key>x-ms-session-token<\/b:key>/);
  const deleted = await t.send(
    execOne('DeleteRequest', 'Delete', [pair('Target', target), pair('partitionId', str('partition-one'))]),
  );
  assert.equal(deleted.status, 200, deleted.body);
  assert.equal(seen.at(-1).url.searchParams.get('partitionId'), 'partition-one');
  assert.doesNotMatch(deleted.body, /<b:key>x-ms-session-token<\/b:key>/);
  t.api.changes.close();
});

async function createWidget(t, attributes) {
  const xml = execOne('CreateRequest', 'Create', [pair('Target', entityValue('widget', attributes))]);
  const res = await t.send(xml);
  assert.equal(res.status, 200, res.body);
  return guidOf(res.body, 'id');
}

test("WhoAmI answers the caller's ids in the g contract namespace", async () => {
  const t = await setup();
  const res = await t.send(execOne('WhoAmIRequest', 'WhoAmI'));
  assert.equal(res.status, 200);
  assert.equal(res.headers['content-type'], 'text/xml; charset=utf-8');
  assert.match(res.body, /xmlns:r="http:\/\/schemas.microsoft.com\/crm\/2011\/Contracts" i:type="r:WhoAmIResponse"/);
  assert.equal(guidOf(res.body, 'UserId'), t.admin.systemuserid);
  assert.equal(guidOf(res.body, 'OrganizationId'), ORG);
});

test('a body given as raw bytes is decoded as UTF-8 when no bodyText is passed', async () => {
  const t = await setup();
  const xml = execOne('CreateRequest', 'Create', [pair('Target', entityValue('widget', [pair('name', str('Zoë'))]))]);
  const res = await handleSoap(
    {
      method: 'POST',
      headers: {},
      bodyBuffer: Buffer.from(xml, 'utf8'),
      user: t.admin,
      caller: t.admin,
      identity: { admin: true, id: t.admin.systemuserid, systemUserId: t.admin.systemuserid },
      origin: ORIGIN,
      version: 'v9.2',
      requestId: 'test',
    },
    t.api,
  );
  assert.equal(res.status, 200, res.body);
  const id = guidOf(res.body, 'id');
  assert.equal(t.store.tableRows('widget').find((row) => row.widgetid === id)?.name, 'Zoë');
});

test('RetrieveVersion answers the organization version', async () => {
  const t = await setup();
  const res = await t.send(execOne('RetrieveVersionRequest', 'RetrieveVersion'));
  assert.match(
    res.body,
    /xmlns:r="http:\/\/schemas.microsoft.com\/crm\/2011\/Contracts" i:type="r:RetrieveVersionResponse"/,
  );
  assert.match(res.body, /<b:value i:type="c:string">9\.2\.25041\.00000<\/b:value>/);
});

test('Create answers the new id, and a lookup bind is set through its navigation', async () => {
  const t = await setup();
  const widget = await createWidget(t, [pair('name', str('w1'))]);
  const gadgetRes = await t.send(
    execOne('CreateRequest', 'Create', [
      pair('Target', entityValue('gadget', [pair('name', str('g1')), pair('widgetid', refValue('widget', widget))])),
    ]),
  );
  assert.equal(gadgetRes.status, 200, gadgetRes.body);
  const gadget = guidOf(gadgetRes.body, 'id');
  assert.ok(gadget, 'CreateResponse names the new gadget');
  const read = await t.send(execOne('RetrieveRequest', 'Retrieve', [pair('Target', refValue('gadget', gadget))]));
  assert.equal(refIdOf(read.body, 'widgetid'), widget, 'the lookup bind sets the widget reference');
});

test('Retrieve returns attributes with lookups as references and option sets as OptionSetValue', async () => {
  const t = await setup();
  const id = await createWidget(t, [
    pair('name', str('w1')),
    pair('statuscode', valueEl('a:OptionSetValue', '<a:Value>1</a:Value>')),
  ]);
  const res = await t.send(
    execOne('RetrieveRequest', 'Retrieve', [
      pair('Target', refValue('widget', id)),
      pair('ColumnSet', valueEl('a:ColumnSet', '<a:AllColumns>true</a:AllColumns><a:Columns/>')),
    ]),
  );
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<b:key>name<\/b:key><b:value i:type="c:string">w1<\/b:value>/);
  assert.match(res.body, /<b:key>statuscode<\/b:key><b:value i:type="a:OptionSetValue"><a:Value>1<\/a:Value>/);
});

test('Update writes the named attributes and Retrieve reads them back', async () => {
  const t = await setup();
  const id = await createWidget(t, [pair('name', str('before'))]);
  const update = await t.send(
    execOne('UpdateRequest', 'Update', [
      pair('Target', entityValue('widget', [pair('widgetid', guidValue(id)), pair('name', str('after'))])),
    ]),
  );
  assert.equal(update.status, 200, update.body);
  const read = await t.send(execOne('RetrieveRequest', 'Retrieve', [pair('Target', refValue('widget', id))]));
  assert.equal(attrText(read.body, 'name'), 'after');
});

test('Retrieve of a missing record is a fault with the signed NotFound code', async () => {
  const t = await setup();
  const res = await t.send(execOne('RetrieveRequest', 'Retrieve', [pair('Target', refValue('widget', MISSING))]));
  assert.equal(res.status, 500);
  assert.equal(res.headers['content-type'], 'text/xml; charset=utf-8');
  assert.equal(errorCode(res.body), -2147220969);
  assert.match(res.body, /widget With Id = /);
});

test('Delete removes the record and a later Retrieve faults', async () => {
  const t = await setup();
  const id = await createWidget(t, [pair('name', str('gone'))]);
  const del = await t.send(execOne('DeleteRequest', 'Delete', [pair('Target', refValue('widget', id))]));
  assert.equal(del.status, 200, del.body);
  const read = await t.send(execOne('RetrieveRequest', 'Retrieve', [pair('Target', refValue('widget', id))]));
  assert.equal(errorCode(read.body), -2147220969);
});

test('RetrieveMultiple pages a QueryExpression: the paging cookie round-trips to the next page with a total count', async () => {
  const t = await setup();
  for (const name of ['w1', 'w2', 'w3']) await createWidget(t, [pair('name', str(name))]);
  const query = (pageNumber, cookie) =>
    valueEl(
      'a:QueryExpression',
      `<a:EntityName>widget</a:EntityName>` +
        `<a:ColumnSet i:type="a:ColumnSet"><a:AllColumns>false</a:AllColumns><a:Columns><f:string>name</f:string></a:Columns></a:ColumnSet>` +
        `<a:Criteria><a:FilterOperator>And</a:FilterOperator><a:Conditions/><a:Filters/></a:Criteria>` +
        `<a:Orders><a:OrderExpression><a:AttributeName>name</a:AttributeName><a:OrderType>Ascending</a:OrderType></a:OrderExpression></a:Orders>` +
        `<a:PageInfo><a:Count>2</a:Count><a:PageNumber>${pageNumber}</a:PageNumber>` +
        (cookie ? `<a:PagingCookie>${cookie}</a:PagingCookie>` : `<a:PagingCookie i:nil="true"/>`) +
        `<a:ReturnTotalRecordCount>true</a:ReturnTotalRecordCount></a:PageInfo>`,
    );
  const first = await t.send(execOne('RetrieveMultipleRequest', 'RetrieveMultiple', [pair('Query', query(1))]));
  assert.equal(first.status, 200, first.body);
  assert.equal(rowCount(first.body), 2);
  assert.match(first.body, /<a:MoreRecords>true<\/a:MoreRecords>/);
  assert.match(first.body, /<a:TotalRecordCount>3<\/a:TotalRecordCount>/);
  const cookie = cookieOf(first.body);
  assert.ok(cookie, 'a PagingCookie is returned while more records remain');
  const second = await t.send(
    execOne('RetrieveMultipleRequest', 'RetrieveMultiple', [pair('Query', query(2, cookie))]),
  );
  assert.equal(second.status, 200, second.body);
  assert.equal(rowCount(second.body), 1);
  assert.match(second.body, /<a:MoreRecords>false<\/a:MoreRecords>/);
});

test('RetrieveMultiple translates QueryByAttribute to an equality query', async () => {
  const t = await setup();
  await createWidget(t, [pair('name', str('alpha'))]);
  await createWidget(t, [pair('name', str('beta'))]);
  const query = valueEl(
    'a:QueryByAttribute',
    `<a:EntityName>widget</a:EntityName><a:Attributes><b:string>name</b:string></a:Attributes>` +
      `<a:ColumnSet i:type="a:ColumnSet"><a:AllColumns>true</a:AllColumns><a:Columns/></a:ColumnSet>` +
      `<a:Values>${str('beta')}</a:Values>`,
  );
  const res = await t.send(execOne('RetrieveMultipleRequest', 'RetrieveMultiple', [pair('Query', query)]));
  assert.equal(res.status, 200, res.body);
  assert.equal(rowCount(res.body), 1);
  assert.equal(attrText(res.body, 'name'), 'beta');
});

test('RetrieveMultiple runs a FetchExpression as written', async () => {
  const t = await setup();
  await createWidget(t, [pair('name', str('alpha'))]);
  await createWidget(t, [pair('name', str('beta'))]);
  const fetch = `<fetch><entity name="widget"><attribute name="name"/><filter><condition attribute="name" operator="eq" value="beta"/></filter></entity></fetch>`;
  const query = valueEl(
    'a:FetchExpression',
    `<a:Query>${fetch.replace(/[<>"&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' })[c])}</a:Query>`,
  );
  const res = await t.send(execOne('RetrieveMultipleRequest', 'RetrieveMultiple', [pair('Query', query)]));
  assert.equal(res.status, 200, res.body);
  assert.equal(rowCount(res.body), 1);
  assert.equal(attrText(res.body, 'name'), 'beta');
});

test('Associate and Disassociate write and remove the relationship row', async () => {
  const t = await setup();
  const widget = await createWidget(t, [pair('name', str('w1'))]);
  const tagRes = await t.send(
    execOne('CreateRequest', 'Create', [pair('Target', entityValue('tag', [pair('name', str('t1'))]))]),
  );
  const tag = guidOf(tagRes.body, 'id');
  const related = valueEl(
    'a:EntityReferenceCollection',
    `<a:EntityReference><a:Id>${tag}</a:Id><a:LogicalName>tag</a:LogicalName><a:Name i:nil="true"/></a:EntityReference>`,
  );
  const relationship = valueEl(
    'a:Relationship',
    `<a:PrimaryEntityRole i:nil="true"/><a:SchemaName>widget_tags</a:SchemaName>`,
  );
  const link = await t.send(
    execOne('AssociateRequest', 'Associate', [
      pair('Target', refValue('widget', widget)),
      pair('Relationship', relationship),
      pair('RelatedEntities', related),
    ]),
  );
  assert.equal(link.status, 200, link.body);
  assert.equal(t.store.state.tables.widget_tag.length, 1);
  const unlink = await t.send(
    execOne('DisassociateRequest', 'Disassociate', [
      pair('Target', refValue('widget', widget)),
      pair('Relationship', relationship),
      pair('RelatedEntities', related),
    ]),
  );
  assert.equal(unlink.status, 200, unlink.body);
  assert.equal(t.store.state.tables.widget_tag.length, 0);
});

const associationRequest = (
  message,
  widget,
  relatedIds,
  { schema = 'widget_tags', targetEntity = 'widget', relatedEntity = 'tag', role = null } = {},
) =>
  execOne(`${message}Request`, message, [
    pair('Target', refValue(targetEntity, widget)),
    pair(
      'Relationship',
      valueEl(
        'a:Relationship',
        `${role == null ? '<a:PrimaryEntityRole i:nil="true"/>' : `<a:PrimaryEntityRole>${role}</a:PrimaryEntityRole>`}<a:SchemaName>${schema}</a:SchemaName>`,
      ),
    ),
    pair(
      'RelatedEntities',
      valueEl(
        'a:EntityReferenceCollection',
        relatedIds
          .map(
            (id) =>
              `<a:EntityReference><a:Id>${id}</a:Id><a:LogicalName>${relatedEntity}</a:LogicalName><a:Name i:nil="true"/></a:EntityReference>`,
          )
          .join(''),
      ),
    ),
  ]);

test('SOAP association messages retain the full related collection in one pipeline and one async job', async (t) => {
  const f = await setup(),
    widget = await createWidget(f, [pair('name', str('Parent'))]);
  const tags = ['20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002'];
  f.store.state.tables.tag.push(...tags.map((tagid) => ({ tagid, name: tagid })));
  const seen = [],
    asyncSeen = [],
    steps = [],
    handlers = new Map();
  for (const [index, message] of ['Associate', 'Disassociate'].entries())
    for (const stage of [10, 20, 40, 'async']) {
      const id = `30000000-0000-0000-0000-${String(index * 100 + (stage === 'async' ? 9 : stage)).padStart(12, '0')}`;
      steps.push({
        id,
        enabled: true,
        entity: 'widget',
        message,
        stage: stage === 'async' ? 40 : stage,
        rank: 1,
        mode: stage === 'async' ? 1 : 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.Association',
        assemblyId: 'invented',
      });
      handlers.set(id, (context) => {
        const observation = {
          message: context.operation,
          stage: context.stage,
          ids: context.associationParameters.RelatedEntities.values.map((reference) => reference.id),
        };
        (stage === 'async' ? asyncSeen : seen).push(observation);
      });
    }
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  for (const message of ['Associate', 'Disassociate']) {
    const result = await f.send(associationRequest(message, widget, tags));
    assert.equal(result.status, 200, result.body);
    assert.equal(f.store.state.tables.widget_tag.length, message === 'Associate' ? 2 : 0);
    await backend.settle();
    assert.deepEqual(
      seen.splice(0),
      [10, 20, 40].map((stage) => ({ message: message.toLowerCase(), stage, ids: tags })),
    );
    assert.deepEqual(asyncSeen.splice(0), [{ message: message.toLowerCase(), stage: 40, ids: tags }]);
  }
});

test('SOAP association failures roll back the complete related collection including earlier members', async () => {
  const f = await setup(),
    widget = await createWidget(f, [pair('name', str('Parent'))]);
  const tags = ['20000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000002'];
  f.store.state.tables.tag.push(...tags.map((tagid) => ({ tagid, name: tagid })));
  let reject = true;
  f.store.setPluginPipeline(
    (context) => {
      if (
        reject &&
        context.stage === 40 &&
        context.associationParameters.RelatedEntities.values.some((ref) => ref.id === tags[1])
      )
        throw new DataError('Refused related member', 400, 'PluginValidation', { innerCode: '0x80040265' });
    },
    (context) => ['associate', 'disassociate'].includes(context.operation),
  );
  const failure = await f.send(associationRequest('Associate', widget, tags));
  assert.equal(failure.status, 500, failure.body);
  assert.match(failure.body, /Refused related member/);
  assert.deepEqual(f.store.state.tables.widget_tag, []);
  reject = false;
  assert.equal((await f.send(associationRequest('Associate', widget, tags))).status, 200);
  const before = structuredClone(f.store.state.tables.widget_tag);
  reject = true;
  const unlink = await f.send(associationRequest('Disassociate', widget, tags));
  assert.equal(unlink.status, 500, unlink.body);
  assert.deepEqual(f.store.state.tables.widget_tag, before);
});

test('SOAP association preserves source schema direction and the explicit referencing EntityRole', async () => {
  const f = await setup(),
    widget = await createWidget(f, [pair('name', str('Parent'))]);
  const gadget = '20000000-0000-0000-0000-000000000003';
  f.store.state.tables.gadget.push({ gadgetid: gadget, name: 'Child' });
  Object.assign(f.store.state.mappings.gadget.relationships.widgetid, {
    schemaName: 'widget_gadgets',
    partner: 'gadgets',
  });
  f.store.state.mappings.widget.relationships.gadgets = {
    entity: 'gadget',
    from: 'widgetid',
    to: 'widgetid',
    many: true,
    schemaName: 'widget_gadgets',
    partner: 'widgetid',
  };
  const seen = [];
  f.store.setPluginPipeline(
    (context) => seen.push(structuredClone(context.associationParameters)),
    (context) => ['associate', 'disassociate'].includes(context.operation),
  );
  for (const message of ['Associate', 'Disassociate']) {
    const result = await f.send(
      associationRequest(message, gadget, [widget], {
        schema: 'widget_gadgets',
        targetEntity: 'gadget',
        relatedEntity: 'widget',
        role: 'Referencing',
      }),
    );
    assert.equal(result.status, 200, result.body);
    assert.equal(f.store.state.tables.gadget[0].widgetid, message === 'Associate' ? widget : null);
    assert.equal(seen.length, 3);
    for (const parameters of seen.splice(0)) {
      assert.deepEqual(parameters.Relationship, {
        $type: 'Relationship',
        schemaName: 'widget_gadgets',
        primaryEntityRole: 'Referencing',
      });
      assert.equal(parameters.Target.logicalName, 'gadget');
      assert.equal(parameters.Target.id, gadget);
      assert.equal(parameters.RelatedEntities.values[0].logicalName, 'widget');
    }
  }
});

test('SOAP association Target replacement retains SDK GUID validation even for an existing local row', async () => {
  const f = await setup(),
    widget = await createWidget(f, [pair('name', str('Parent'))]);
  const tag = '20000000-0000-0000-0000-000000000001';
  f.store.state.tables.widget.push({ widgetid: 'local-only', name: 'Local row' });
  f.store.state.tables.tag.push({ tagid: tag, name: 'Tag' });
  f.store.setPluginPipeline(
    (context) => {
      if (context.stage === 20) context.associationParameters.Target.id = 'local-only';
    },
    (context) => context.operation === 'associate',
  );
  const result = await f.send(associationRequest('Associate', widget, [tag]));
  assert.equal(result.status, 500, result.body);
  assert.match(result.body, /Target must remain a typed entity reference with a valid identity/);
  assert.deepEqual(f.store.state.tables.widget_tag, []);
});

test('Upsert creates by alternate key, then updates the same row', async () => {
  const t = await setup();
  const target = (name) => entityValue('widget', [pair('name', str(name))], keyAttributes([pair('code', str('K1'))]));
  const created = await t.send(execOne('UpsertRequest', 'Upsert', [pair('Target', target('first'))]));
  assert.equal(created.status, 200, created.body);
  assert.match(created.body, /<b:key>RecordCreated<\/b:key><b:value i:type="c:boolean">true<\/b:value>/);
  const updated = await t.send(execOne('UpsertRequest', 'Upsert', [pair('Target', target('second'))]));
  assert.match(updated.body, /<b:key>RecordCreated<\/b:key><b:value i:type="c:boolean">false<\/b:value>/);
  assert.equal(t.store.state.tables.widget.length, 1);
  assert.equal(t.store.state.tables.widget[0].name, 'second');
});

test('Assign changes the owner of a user-owned row and SetState changes the state', async () => {
  const t = await setup();
  const widget = await createWidget(t, [pair('name', str('w1'))]);
  const g = await t.send(
    execOne('CreateRequest', 'Create', [pair('Target', entityValue('gadget', [pair('name', str('g1'))]))]),
  );
  const gadget = guidOf(g.body, 'id');
  const assign = await t.send(
    execOne('AssignRequest', 'Assign', [
      pair('Target', refValue('gadget', gadget)),
      pair('Assignee', refValue('systemuser', t.basic.systemuserid)),
    ]),
  );
  assert.equal(assign.status, 200, assign.body);
  assert.match(assign.body, /i:type="r:AssignResponse"/);
  const row = t.store.state.tables.gadget.find((r) => r.gadgetid === gadget);
  assert.equal(String(row.ownerid?.id ?? row.ownerid).toLowerCase(), t.basic.systemuserid.toLowerCase());
  const state = await t.send(
    execOne('SetStateRequest', 'SetState', [
      pair('EntityMoniker', refValue('widget', widget)),
      pair('State', valueEl('a:OptionSetValue', '<a:Value>1</a:Value>')),
      pair('Status', valueEl('a:OptionSetValue', '<a:Value>2</a:Value>')),
    ]),
  );
  assert.equal(state.status, 200, state.body);
  assert.match(state.body, /i:type="r:SetStateResponse"/);
  assert.equal(t.store.state.tables.widget[0].statecode, 1);
  assert.equal(t.store.state.tables.widget[0].statuscode, 2);
});

function specializedRequest(message, logical, id, assignee) {
  return execOne(message + 'Request', message, [
    pair(message === 'Assign' ? 'Target' : 'EntityMoniker', refValue(logical, id)),
    ...(message === 'Assign'
      ? [pair('Assignee', refValue('systemuser', assignee))]
      : [
          pair('State', valueEl('a:OptionSetValue', '<a:Value>1</a:Value>')),
          pair('Status', valueEl('a:OptionSetValue', '<a:Value>2</a:Value>')),
        ]),
  ]);
}

async function specializedFixture(message) {
  const t = await setup();
  const logical = message === 'Assign' ? 'gadget' : 'widget';
  const created = await t.send(
    execOne('CreateRequest', 'Create', [pair('Target', entityValue(logical, [pair('name', str('Original'))]))]),
  );
  assert.equal(created.status, 200, created.body);
  return { ...t, logical, id: guidOf(created.body, 'id') };
}

const namedStep = (message, entity) => [
  {
    id: '11111111-1111-4111-8111-111111111111',
    entity,
    message,
    enabled: true,
    mode: 'handler',
    contract: { mode: 0, supportedDeployment: 0 },
  },
];

for (const message of ['Assign', 'SetState']) {
  test(`SOAP ${message} delegates an explicit Update without claiming the Upsert pipeline`, async () => {
    const t = await specializedFixture(message);
    let updates = 0;
    t.store.setPluginPipeline((context) => {
      if (context.operation === 'update' && context.stage === 20) updates++;
    });
    t.store.pluginPipeline.steps = () => namedStep('Upsert', t.logical);
    const result = await t.send(specializedRequest(message, t.logical, t.id, t.basic.systemuserid));
    assert.equal(result.status, 200, result.body);
    assert.equal(updates, 1);
    const row = t.store.tableRows(t.logical)[0];
    if (message === 'Assign') assert.equal(row.ownerid.id, t.basic.systemuserid);
    else assert.equal(row.statecode, 1);
  });

  test(`SOAP ${message} cannot create a missing target through its delegated Update`, async () => {
    const t = await specializedFixture(message);
    const before = structuredClone(t.store.tableRows(t.logical));
    const result = await t.send(
      specializedRequest(message, t.logical, '22222222-2222-4222-8222-222222222222', t.basic.systemuserid),
    );
    assert.equal(result.status, 500, result.body);
    assert.equal(errorCode(result.body), 0x80040217 | 0);
    assert.deepEqual(t.store.tableRows(t.logical), before);
  });

  test(`SOAP ${message} entity-set aliases cannot bypass a configured named step`, async () => {
    const t = await specializedFixture(message);
    const before = structuredClone(t.store.tableRows(t.logical));
    t.store.setPluginPipeline(() => {});
    t.store.pluginPipeline.steps = () => namedStep(message, t.logical);
    const result = await t.send(
      specializedRequest(message, t.store.resolveMapping(t.logical).entitySet, t.id, t.basic.systemuserid),
    );
    assert.equal(result.status, 500, result.body);
    assert.match(result.body, /plug-in pipeline is not implemented/);
    assert.deepEqual(t.store.tableRows(t.logical), before);
  });
}

test('ExecuteMultiple answers one item per request in order', async () => {
  const t = await setup();
  const settings = valueEl(
    'l:ExecuteMultipleSettings',
    '<a:ContinueOnError>false</a:ContinueOnError><a:ReturnResponses>true</a:ReturnResponses>',
  );
  const requests = valueEl(
    'a:OrganizationRequestCollection',
    [
      orgRequest('CreateRequest', [pair('Target', entityValue('widget', [pair('name', str('m1'))]))]),
      orgRequest('CreateRequest', [pair('Target', entityValue('widget', [pair('name', str('m2'))]))]),
    ].join(''),
  );
  const res = await t.send(
    execOne('ExecuteMultipleRequest', 'ExecuteMultiple', [pair('Requests', requests), pair('Settings', settings)]),
  );
  assert.equal(res.status, 200, res.body);
  // ExecuteMultipleResponseItem is xrm/2012: its RequestIndex member is prefixed l:.
  assert.match(res.body, /<l:RequestIndex>0<\/l:RequestIndex>/);
  assert.match(res.body, /<l:RequestIndex>1<\/l:RequestIndex>/);
  assert.match(res.body, /<b:value i:type="l:OrganizationResponseCollection">/);
  assert.equal(t.store.state.tables.widget.length, 2);
});

test('ExecuteMultiple with ContinueOnError reports the failed item and keeps the rest', async () => {
  const t = await setup();
  const settings = valueEl(
    'l:ExecuteMultipleSettings',
    '<a:ContinueOnError>true</a:ContinueOnError><a:ReturnResponses>true</a:ReturnResponses>',
  );
  const requests = valueEl(
    'a:OrganizationRequestCollection',
    [
      orgRequest('CreateRequest', [pair('Target', entityValue('widget', [pair('name', str('kept'))]))]),
      orgRequest('UpdateRequest', [
        pair('Target', entityValue('widget', [pair('widgetid', guidValue(MISSING)), pair('name', str('x'))])),
      ]),
    ].join(''),
  );
  const res = await t.send(
    execOne('ExecuteMultipleRequest', 'ExecuteMultiple', [pair('Requests', requests), pair('Settings', settings)]),
  );
  assert.equal(res.status, 200, res.body);
  assert.equal(errorCode(res.body), -2147220969);
  assert.equal(t.store.state.tables.widget.length, 1);
});

test('ExecuteTransaction rolls every write back and names the faulted index', async () => {
  const t = await setup();
  await createWidget(t, [pair('name', str('existing'))]);
  const requests = valueEl(
    'a:OrganizationRequestCollection',
    [
      orgRequest('CreateRequest', [pair('Target', entityValue('widget', [pair('name', str('rolled-back'))]))]),
      orgRequest('UpdateRequest', [
        pair('Target', entityValue('widget', [pair('widgetid', guidValue(MISSING)), pair('name', str('x'))])),
      ]),
    ].join(''),
  );
  const res = await t.send(
    execOne('ExecuteTransactionRequest', 'ExecuteTransaction', [
      pair('Requests', requests),
      pair('ReturnResponses', bool('true')),
    ]),
  );
  assert.equal(res.status, 500);
  assert.equal(errorCode(res.body), -2147220969);
  // The detail is an OrganizationServiceFault typed as ExecuteTransactionFault (i:type); FaultedRequestIndex is its member in xrm/7.1.
  assert.match(
    res.body,
    /<OrganizationServiceFault xmlns="http:\/\/schemas.microsoft.com\/xrm\/2011\/Contracts"[^>]* i:type="o:ExecuteTransactionFault">/,
  );
  assert.match(res.body, /<o:FaultedRequestIndex>1<\/o:FaultedRequestIndex>/);
  assert.deepEqual(
    t.store.state.tables.widget.map((row) => row.name),
    ['existing'],
  );
});

test('ExecuteTransaction answers an OrganizationResponseCollection of its item responses in order', async () => {
  const t = await setup();
  const requests = valueEl(
    'a:OrganizationRequestCollection',
    [
      orgRequest('CreateRequest', [pair('Target', entityValue('widget', [pair('name', str('t1'))]))]),
      orgRequest('CreateRequest', [pair('Target', entityValue('widget', [pair('name', str('t2'))]))]),
    ].join(''),
  );
  const res = await t.send(
    execOne('ExecuteTransactionRequest', 'ExecuteTransaction', [
      pair('Requests', requests),
      pair('ReturnResponses', bool('true')),
    ]),
  );
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<b:value i:type="o:OrganizationResponseCollection">/);
  assert.equal([...res.body.matchAll(/<a:OrganizationResponse i:type="a:CreateResponse">/g)].length, 2);
  assert.equal(t.store.state.tables.widget.length, 2);
});

test('an invalid Date in a retrieved row is a fault, not a RangeError', async () => {
  const t = await setup();
  const id = await createWidget(t, [pair('name', str('dated'))]);
  t.store.state.tables.widget.find((row) => row.widgetid === id).closedon = new Date(Number.NaN);
  const res = await t.send(execOne('RetrieveRequest', 'Retrieve', [pair('Target', refValue('widget', id))]));
  assert.equal(res.status, 500, res.body);
  assert.equal(errorCode(res.body), -2147220989);
});

test('RetrieveCurrentOrganization returns the organization detail', async () => {
  const t = await setup();
  const res = await t.send(
    execOne('RetrieveCurrentOrganizationRequest', 'RetrieveCurrentOrganization', [pair('AccessType', int('0'))]),
  );
  assert.equal(res.status, 200, res.body);
  assert.match(
    res.body,
    /xmlns:r="http:\/\/schemas.microsoft.com\/crm\/2011\/Contracts" i:type="r:RetrieveCurrentOrganizationResponse"/,
  );
  assert.match(res.body, /<b:key>Detail<\/b:key>/);
  // OrganizationDetail is xrm/2014 (SDK docs): typed and prefixed x14, members in DataContract (alphabetical) order.
  assert.match(res.body, /<b:value i:type="x14:OrganizationDetail">/);
  assert.match(res.body, /<x14:UniqueName>testorg<\/x14:UniqueName>/);
  const members = [...res.body.matchAll(/<x14:([A-Za-z]+)[ >/]/g)].map((m) => m[1]);
  assert.deepEqual(members, [
    'DatacenterId',
    'Endpoints',
    'EnvironmentId',
    'FriendlyName',
    'Geo',
    'OrganizationId',
    'OrganizationType',
    'OrganizationVersion',
    'SchemaType',
    'State',
    'TenantId',
    'UniqueName',
    'UrlName',
  ]);
  // Value-type members (Guid, OrganizationType, OrganizationState) cannot be nil for the SDK's DataContract reader, and
  // CrmServiceClient reads the published endpoints right after connecting.
  assert.match(res.body, /<x14:DatacenterId>00000000-0000-0000-0000-000000000000<\/x14:DatacenterId>/);
  assert.match(res.body, /<x14:OrganizationType>Default<\/x14:OrganizationType>/);
  assert.match(res.body, /<x14:State>Enabled<\/x14:State>/);
  const endpoints = [
    ...res.body.matchAll(
      /<x14:KeyValuePairOfEndpointTypestringyDL0RVHi><b:key>(\w+)<\/b:key><b:value>([^<]+)<\/b:value><\/x14:KeyValuePairOfEndpointTypestringyDL0RVHi>/g,
    ),
  ].map((m) => [m[1], m[2]]);
  assert.deepEqual(endpoints, [
    ['OrganizationService', `${ORIGIN}/XRMServices/2011/Organization.svc`],
    ['OrganizationDataService', `${ORIGIN}/XRMServices/2011/OrganizationData.svc`],
    ['WebApplication', `${ORIGIN}/`],
  ]);
});

test('a body operation (Create without Execute) answers its named result', async () => {
  const t = await setup();
  const xml = envelope(
    `<Create xmlns="${NS.svc}"><entity i:type="a:Entity"><a:Attributes>${pair('name', str('direct'))}</a:Attributes><a:LogicalName>widget</a:LogicalName></entity></Create>`,
  );
  const res = await t.send(xml);
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<svc:CreateResponse><svc:CreateResult i:type="e:guid">[0-9a-f-]{36}<\/svc:CreateResult>/);
  assert.equal(t.store.state.tables.widget.length, 1);
});

test('the SOAP CallerObjectId header impersonates the named user', async () => {
  const t = await setup();
  const xml =
    `<s:Envelope ${DECL}><s:Header><CallerObjectId xmlns="${NS.a}">${BASIC_OID}</CallerObjectId></s:Header>` +
    `<s:Body><Execute xmlns="${NS.svc}"><request i:type="a:WhoAmIRequest"><a:Parameters/><a:RequestName>WhoAmI</a:RequestName></request></Execute></s:Body></s:Envelope>`;
  const res = await t.send(xml);
  assert.equal(res.status, 200, res.body);
  assert.equal(guidOf(res.body, 'UserId'), t.basic.systemuserid);
});

test('a privilege the caller lacks is a fault with the 0x80040220 code', async () => {
  const t = await setup();
  const res = await t.send(
    execOne('CreateRequest', 'Create', [pair('Target', entityValue('tag', [pair('name', str('nope'))]))]),
    { user: t.basic },
  );
  assert.equal(res.status, 500);
  assert.equal(errorCode(res.body), -2147220960);
  assert.match(res.body, /is missing prvCreateTag privilege/);
});

test('a malformed envelope and an invalid date are faults, not exceptions', async () => {
  const t = await setup();
  const malformed = await t.send('<s:Envelope><s:Body>');
  assert.equal(malformed.status, 500);
  assert.equal(errorCode(malformed.body), -2147088248); // 0x80060888, the InvalidRequest default
  const badDate = await t.send(
    execOne('CreateRequest', 'Create', [
      pair('Target', entityValue('widget', [pair('closedon', valueEl('c:dateTime', 'not-a-date'))])),
    ]),
  );
  assert.equal(badDate.status, 500);
  assert.match(badDate.body, /<faultstring/);
  assert.equal(errorCode(badDate.body), -2147220989);
});

test('an operation the service does not simulate is a fault, and a GET is not allowed', async () => {
  const t = await setup();
  const res = await t.send(execOne('GrantAccessRequest', 'GrantAccess', []));
  assert.equal(res.status, 500);
  assert.equal(errorCode(res.body), -2147220970);
  const get = await handleSoap(
    {
      method: 'GET',
      headers: {},
      bodyText: '',
      user: t.admin,
      caller: t.admin,
      identity: {},
      origin: ORIGIN,
      version: 'v9.2',
      requestId: 't',
    },
    t.api,
  );
  assert.equal(get.status, 405);
});

// SDK docs table: six requests, faults at indexes 2 and 4.
test('ExecuteMultiple returns the items the ContinueOnError and ReturnResponses combination lists', async () => {
  const cases = [
    [true, true, 6, 4],
    [false, true, 3, 2],
    [true, false, 2, 4],
    [false, false, 1, 2],
  ];
  for (const [continueOnError, returnResponses, items, rows] of cases) {
    const t = await setup();
    const settings = valueEl(
      'l:ExecuteMultipleSettings',
      `<a:ContinueOnError>${continueOnError}</a:ContinueOnError><a:ReturnResponses>${returnResponses}</a:ReturnResponses>`,
    );
    const requests = valueEl(
      'a:OrganizationRequestCollection',
      [0, 1, 2, 3, 4, 5]
        .map((i) =>
          i === 2 || i === 4
            ? orgRequest('UpdateRequest', [
                pair('Target', entityValue('widget', [pair('widgetid', guidValue(MISSING)), pair('name', str('x'))])),
              ])
            : orgRequest('CreateRequest', [pair('Target', entityValue('widget', [pair('name', str(`m${i}`))]))]),
        )
        .join(''),
    );
    const res = await t.send(
      execOne('ExecuteMultipleRequest', 'ExecuteMultiple', [pair('Requests', requests), pair('Settings', settings)]),
    );
    const label = `ContinueOnError=${continueOnError} ReturnResponses=${returnResponses}`;
    assert.equal(res.status, 200, res.body);
    assert.equal(res.body.match(/<l:ExecuteMultipleResponseItem>/g).length, items, label);
    assert.match(res.body, /<b:key>IsFaulted<\/b:key><b:value i:type="c:boolean">true<\/b:value>/, label);
    // Without ContinueOnError the batch stops at the first fault, so the creates after index 2 never run.
    assert.equal(t.store.state.tables.widget.length, rows, label);
  }
});

test('ExecuteMultiple over 1,000 requests is a fault before any request runs; 1,000 is allowed', async () => {
  const t = await setup();
  const create = orgRequest('CreateRequest', [pair('Target', entityValue('widget', [pair('name', str('first'))]))]);
  const whoAmI = orgRequest('WhoAmIRequest', []);
  const over = valueEl(
    'a:OrganizationRequestCollection',
    [create, ...Array.from({ length: 1000 }, () => whoAmI)].join(''),
  );
  const faulted = await t.send(execOne('ExecuteMultipleRequest', 'ExecuteMultiple', [pair('Requests', over)]));
  assert.equal(faulted.status, 500);
  assert.equal(t.store.state.tables.widget.length, 0);
  const exact = valueEl(
    'a:OrganizationRequestCollection',
    [create, ...Array.from({ length: 999 }, () => whoAmI)].join(''),
  );
  const ok = await t.send(execOne('ExecuteMultipleRequest', 'ExecuteMultiple', [pair('Requests', exact)]));
  assert.equal(ok.status, 200, ok.body);
});

test('an ExecuteMultiple inside an ExecuteMultiple faults its own item, and the batch goes on', async () => {
  const t = await setup();
  const settings = valueEl(
    'l:ExecuteMultipleSettings',
    '<a:ContinueOnError>true</a:ContinueOnError><a:ReturnResponses>false</a:ReturnResponses>',
  );
  const requests = valueEl(
    'a:OrganizationRequestCollection',
    [
      orgRequest('CreateRequest', [pair('Target', entityValue('widget', [pair('name', str('before'))]))]),
      orgRequest('ExecuteMultipleRequest', []),
      orgRequest('CreateRequest', [pair('Target', entityValue('widget', [pair('name', str('after'))]))]),
    ].join(''),
  );
  const res = await t.send(
    execOne('ExecuteMultipleRequest', 'ExecuteMultiple', [pair('Requests', requests), pair('Settings', settings)]),
  );
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<l:RequestIndex>1<\/l:RequestIndex>/);
  assert.equal(res.body.match(/<l:ExecuteMultipleResponseItem>/g).length, 1);
  assert.equal(t.store.state.tables.widget.length, 2);
});

test('a generic OrganizationRequest runs the registered operation its RequestName names', async () => {
  const t = await setup();
  t.api.registry.register({
    name: 'Echo',
    kind: 'action',
    binding: 'unbound',
    handle: (c) => ({ status: 200, body: { '@odata.context': 'x', Target: c.body.Target, Count: 2 } }),
  });
  const id = await createWidget(t, [pair('name', str('w1'))]);
  const res = await t.send(execute('OrganizationRequest', 'Echo', [pair('Target', refValue('widget', id))]));
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /i:type="r:OrganizationResponse"/);
  assert.match(res.body, /<a:ResponseName>Echo<\/a:ResponseName>/);
  assert.equal(refIdOf(res.body, 'Target'), id, 'the entity reference round-trips through the operation');
  assert.match(res.body, /<b:key>Count<\/b:key><b:value i:type="c:int">2<\/b:value>/);
});

test('BypassCustomPluginExecution needs the bypass privilege and reaches the record writes', async () => {
  const t = await setup();
  const bypass = pair('BypassCustomPluginExecution', bool('true'));
  const create = (name, pairs) =>
    execOne('CreateRequest', 'Create', [pair('Target', entityValue('widget', [pair('name', str(name))])), ...pairs]);
  const denied = await t.send(create('denied', [bypass]), { user: t.basic });
  assert.equal(denied.status, 500);
  assert.equal(errorCode(denied.body), -2147220960);
  const seen = [];
  const handle = t.api.records.handle;
  t.api.records.handle = (ctx) => {
    seen.push(ctx.bypassCustomPlugins);
    return handle.call(t.api.records, ctx);
  };
  assert.equal((await t.send(create('bypassed', [bypass]))).status, 200);
  assert.equal((await t.send(create('plain', []))).status, 200);
  assert.deepEqual(seen, [true, false]);
});

test('SOAP business logic bypass checks its privilege and reaches records and registered operations', async () => {
  const t = await setup();
  const logic = (value) => pair('BypassBusinessLogicExecution', str(value));
  const create = (value) =>
    execOne('CreateRequest', 'Create', [
      pair('Target', entityValue('widget', [pair('name', str('bypass'))])),
      logic(value),
    ]);
  const denied = await t.send(create('CustomAsync'), { user: t.basic });
  assert.equal(denied.status, 500);
  assert.equal(errorCode(denied.body), -2147220960);
  const seen = [];
  const handle = t.api.records.handle;
  t.api.records.handle = (ctx) => {
    seen.push([ctx.bypassCustomPlugins, ctx.bypassCustomAsync]);
    return handle.call(t.api.records, ctx);
  };
  assert.equal((await t.send(create('CustomAsync'))).status, 200);
  assert.equal((await t.send(create('CustomSync,CustomAsync'))).status, 200);
  assert.deepEqual(seen, [
    [false, true],
    [true, true],
  ]);
  t.api.registry.register({
    name: 'BypassEcho',
    kind: 'action',
    binding: 'unbound',
    handle: (ctx) => {
      assert.deepEqual(ctx.body, { Value: 'payload' });
      assert.equal(ctx.bypassCustomPlugins, true);
      assert.equal(ctx.bypassCustomAsync, true);
      assert.deepEqual(ctx.systemParameters, {
        BypassBusinessLogicExecution: 'CustomSync,CustomAsync',
        BypassCustomPluginExecution: true,
      });
      return { status: 200, body: { Value: ctx.body.Value } };
    },
  });
  const registered = await t.send(
    execute('OrganizationRequest', 'BypassEcho', [
      pair('Value', str('payload')),
      logic('CustomSync,CustomAsync'),
      pair('BypassCustomPluginExecution', bool('true')),
    ]),
  );
  assert.equal(registered.status, 200, registered.body);
  assert.equal(attrText(registered.body, 'Value'), 'payload');
  assert.equal((await t.send(create('Unknown'))).status, 500);
});

test('SOAP Retrieve preserves its exact ColumnSet and Target while keeping response projection independent', async () => {
  const t = await setup(),
    id = await createWidget(t, [pair('name', str('alpha')), pair('code', str('one'))]),
    other = await createWidget(t, [pair('name', str('beta')), pair('code', str('two'))]);
  const seen = [];
  let redirect = false;
  t.store.setPluginPipeline(
    (c) => {
      seen.push({
        stage: c.stage,
        columns: structuredClone(c.columns),
        target: structuredClone(c.holder.target),
        primary: c.record.widgetid,
        mainPrimary: c.stage === 40 ? structuredClone(c.holder.entity.attributes.widgetid) : undefined,
      });
      if (redirect && c.stage === 20) c.holder.target.id = other;
    },
    (c) => c.operation === 'retrieve',
  );
  const reference = (key = false) =>
    valueEl(
      'a:EntityReference',
      `<a:Id>${key ? '00000000-0000-0000-0000-000000000000' : id}</a:Id><a:LogicalName>widget</a:LogicalName><a:Name>Client label</a:Name><a:RowVersion>17</a:RowVersion>` +
        (key ? keyAttributes([pair('code', str('one'))]) : ''),
    );
  for (const [allColumns, columns] of [
    [false, []],
    [false, ['name']],
    [true, []],
    [true, ['name']],
  ]) {
    seen.length = 0;
    const result = await t.send(
      execOne('RetrieveRequest', 'Retrieve', [
        pair('Target', reference()),
        pair(
          'ColumnSet',
          valueEl(
            'a:ColumnSet',
            `<a:AllColumns>${allColumns}</a:AllColumns><a:Columns>${columns.map((name) => `<f:string>${name}</f:string>`).join('')}</a:Columns>`,
          ),
        ),
      ]),
    );
    assert.equal(result.status, 200, result.body);
    assert.equal(attrText(result.body, 'name'), allColumns || columns.includes('name') ? 'alpha' : undefined);
    assert.equal(attrText(result.body, 'code'), allColumns ? 'one' : undefined);
    assert.match(result.body, new RegExp(`<a:Id>${id}</a:Id>`));
    assert.equal(guidOf(result.body, 'widgetid'), id, 'the main response includes the primary Attribute');
    assert.deepEqual(seen.find((observation) => observation.stage === 40).mainPrimary, { $type: 'Guid', value: id });
    assert.deepEqual(
      seen.map((c) => c.stage),
      [10, 20, 40],
    );
    for (const observation of seen) {
      assert.deepEqual(observation.columns, { allColumns, columns });
      assert.deepEqual(observation.target, {
        $type: 'EntityReference',
        logicalName: 'widget',
        id,
        name: 'Client label',
        rowVersion: '17',
        keyAttributes: {},
      });
    }
  }
  seen.length = 0;
  const keyed = await t.send(
    execOne('RetrieveRequest', 'Retrieve', [
      pair('Target', reference(true)),
      pair(
        'ColumnSet',
        valueEl('a:ColumnSet', '<a:AllColumns>false</a:AllColumns><a:Columns><f:string>name</f:string></a:Columns>'),
      ),
    ]),
  );
  assert.equal(keyed.status, 200, keyed.body);
  assert.equal(attrText(keyed.body, 'name'), 'alpha');
  assert.deepEqual(seen[0].target.keyAttributes, { code: 'one' });
  assert.equal(seen[0].target.id, '00000000-0000-0000-0000-000000000000');
  redirect = true;
  const changed = await t.send(
    execOne('RetrieveRequest', 'Retrieve', [
      pair('Target', reference()),
      pair(
        'ColumnSet',
        valueEl('a:ColumnSet', '<a:AllColumns>false</a:AllColumns><a:Columns><f:string>name</f:string></a:Columns>'),
      ),
    ]),
  );
  assert.equal(changed.status, 200, changed.body);
  assert.equal(attrText(changed.body, 'name'), 'beta');
  assert.match(changed.body, new RegExp(`<a:Id>${other}</a:Id>`));
  assert.equal(seen.at(-1).primary, id, 'replacing Target retains original request PrimaryEntityId');
});

test('SOAP Create keeps explicit Entity.Id, generated empty Id and an authored empty primary Attribute distinct', async () => {
  const t = await setup(),
    id = '11111111-1111-4111-8111-111111111111',
    keyed = '22222222-2222-4222-8222-222222222222',
    empty = '00000000-0000-0000-0000-000000000000';
  const create = (entity) => t.send(execOne('CreateRequest', 'Create', [pair('Target', entity)]));
  const explicit = await create(entityValue('widget', [pair('name', str('Explicit'))], `<a:Id>${id}</a:Id>`));
  assert.equal(explicit.status, 200, explicit.body);
  assert.equal(guidOf(explicit.body, 'id'), id);
  assert.equal(t.store.tableRows('widget').find((row) => row.widgetid === id).name, 'Explicit');
  const emptyProperty = await create(entityValue('widget', [pair('name', str('Generated'))], `<a:Id>${empty}</a:Id>`));
  assert.equal(emptyProperty.status, 200, emptyProperty.body);
  assert.notEqual(guidOf(emptyProperty.body, 'id'), empty);
  assert.ok(t.store.tableRows('widget').some((row) => row.widgetid === guidOf(emptyProperty.body, 'id')));
  const attribute = await create(
    entityValue('widget', [pair('widgetid', guidValue(keyed)), pair('name', str('Attribute'))]),
  );
  assert.equal(attribute.status, 200, attribute.body);
  assert.equal(guidOf(attribute.body, 'id'), keyed);
  const seen = [];
  t.store.setPluginPipeline(
    (c) => {
      seen.push({ stage: c.stage, primary: c.record.widgetid, attribute: c.target.widgetid });
    },
    (c) => c.operation === 'create',
  );
  const before = structuredClone(t.store.tableRows('widget'));
  const zero = await create(entityValue('widget', [pair('widgetid', guidValue(empty))]));
  assert.equal(zero.status, 500, zero.body);
  assert.equal(errorCode(zero.body), Number.parseInt('80040203', 16) | 0);
  assert.match(zero.body, /Expected non-empty Guid\./);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].stage, 10);
  assert.notEqual(seen[0].primary, empty);
  assert.equal(seen[0].attribute, empty);
  assert.deepEqual(t.store.tableRows('widget'), before);
});

test('SOAP refuses configured Entity.RelatedEntities before Create or Update can change the parent', async () => {
  const t = await setup(),
    id = await createWidget(t, [pair('name', str('Before'))]);
  const related =
    '<a:RelatedEntities><a:KeyValuePairOfRelationshipEntityCollection>' +
    '<b:key><a:SchemaName>widget_children</a:SchemaName></b:key><b:value><a:Entities><a:Entity><a:Attributes>' +
    pair('name', str('Related requested')) +
    '</a:Attributes><a:LogicalName>widget</a:LogicalName></a:Entity></a:Entities></b:value>' +
    '</a:KeyValuePairOfRelationshipEntityCollection></a:RelatedEntities>';
  const before = structuredClone(t.store.tableRows('widget'));
  for (const message of ['Create', 'Update']) {
    const target = entityValue(
      'widget',
      [pair('name', str('Must not persist'))],
      `${message === 'Update' ? `<a:Id>${id}</a:Id>` : ''}${related}`,
    );
    const result = await t.send(execOne(message + 'Request', message, [pair('Target', target)]));
    assert.equal(result.status, 500, result.body);
    assert.match(result.body, /Entity.RelatedEntities requires a qualified graph-write adapter/);
    assert.deepEqual(t.store.tableRows('widget'), before);
  }
  const empty = await t.send(
    execOne('CreateRequest', 'Create', [
      pair('Target', entityValue('widget', [pair('name', str('Empty collection allowed'))], '<a:RelatedEntities/>')),
    ]),
  );
  assert.equal(empty.status, 200, empty.body);
});

test('SOAP refuses authored SDK concurrency request parameters before Update writes', async () => {
  const t = await setup(),
    id = await createWidget(t, [pair('name', str('Before concurrency'))]);
  const before = structuredClone(t.store.tableRows('widget'));
  for (const member of ['Default', 'IfRowVersionMatches', 'AlwaysOverwrite']) {
    const target = entityValue(
      'widget',
      [pair('name', str('Must not persist'))],
      `<a:Id>${id}</a:Id><a:RowVersion>17</a:RowVersion>`,
    );
    const result = await t.send(
      execOne('UpdateRequest', 'Update', [
        pair('Target', target),
        pair('ConcurrencyBehavior', valueEl('a:ConcurrencyBehavior', member)),
      ]),
    );
    assert.equal(result.status, 500, result.body);
    assert.match(
      result.body,
      /Authored SDK ConcurrencyBehavior requires a qualified optimistic-concurrency execution adapter/,
    );
    assert.deepEqual(t.store.tableRows('widget'), before);
  }
});

test('SOAP returns final typed plug-in results instead of reconstructing them from Web API bodies', async () => {
  const t = await setup(),
    id = await createWidget(t, [pair('name', str('Stored')), pair('code', str('one'))]),
    replacement = '33333333-3333-4333-8333-333333333333';
  let removeId = false,
    conflict = false;
  const native = {
    $type: 'Entity',
    logicalName: 'widget',
    id,
    attributes: {
      name: 'Final typed row',
      cash: { $type: 'Money', value: '9007199254740993.250001' },
      alias: {
        $type: 'AliasedValue',
        entityLogicalName: 'widget',
        attributeLogicalName: 'price',
        value: { $type: 'Money', value: '4.25' },
      },
      reference: {
        $type: 'EntityReference',
        logicalName: 'widget',
        id,
        name: 'Reference label',
        keyAttributes: { code: 'one' },
        rowVersion: '17',
      },
    },
    keyAttributes: { code: 'one' },
    formattedValues: { cash: 'Exact display' },
    rowVersion: '19',
  };
  const steps = ['Create', 'Retrieve', 'RetrieveMultiple', 'Update', 'Delete'].map((message, index) => ({
    id: `55555555-5555-4555-8555-55555555555${index}`,
    message,
    enabled: true,
    entity: 'widget',
    stage: 40,
    mode: 0,
    rank: 1,
    supportedDeployment: 0,
    filteringAttributes: [],
    images: [],
    typeName: 'Invented.SoapReply',
    assemblyId: 'invented',
  }));
  const handlers = new Map([
    [
      'Invented.SoapReply',
      ({ context }) => {
        if (context.MessageName === 'Create') {
          if (removeId) delete context.OutputParameters.id;
          else context.OutputParameters.id = replacement;
        } else if (context.MessageName === 'Retrieve')
          context.OutputParameters.BusinessEntity = structuredClone(native);
        else if (context.MessageName === 'RetrieveMultiple') {
          context.OutputParameters.BusinessEntityCollection = {
            $type: 'EntityCollection',
            entities: [structuredClone(native)],
            entityName: 'widget',
            moreRecords: true,
            totalRecordCount: 7,
            pagingCookie: 'opaque-cookie',
            minActiveRowVersion: '23',
            totalRecordCountLimitExceeded: true,
          };
          if (conflict)
            context.OutputParameters.EntityCollection = structuredClone(
              context.OutputParameters.BusinessEntityCollection,
            );
        }
        context.OutputParameters.CustomGuid = { $type: 'Guid', value: replacement };
        context.OutputParameters.CustomLarge = 5000000000;
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: t.store, items: () => items, handlers });
  try {
    const created = await t.send(
      execOne('CreateRequest', 'Create', [pair('Target', entityValue('widget', [pair('name', str('Created'))]))]),
    );
    assert.equal(created.status, 200, created.body);
    assert.equal(guidOf(created.body, 'id'), replacement);
    assert.ok(
      !t.store.tableRows('widget').some((row) => row.widgetid === replacement),
      'the response id does not change main storage identity',
    );
    assert.equal(guidOf(created.body, 'CustomGuid'), replacement);
    assert.match(created.body, /<b:key>CustomLarge<\/b:key><b:value i:type="c:long">5000000000<\/b:value>/);
    removeId = true;
    const removed = await t.send(
      execOne('CreateRequest', 'Create', [pair('Target', entityValue('widget', [pair('name', str('No result id'))]))]),
    );
    assert.equal(removed.status, 200, removed.body);
    assert.equal(guidOf(removed.body, 'id'), undefined);
    assert.equal(guidOf(removed.body, 'CustomGuid'), replacement);
    const bodyCreate = await t.send(
      envelope(
        `<Create xmlns="${NS.svc}"><entity i:type="a:Entity"><a:Attributes>${pair('name', str('Body no id'))}</a:Attributes><a:LogicalName>widget</a:LogicalName></entity></Create>`,
      ),
    );
    assert.equal(bodyCreate.status, 200, bodyCreate.body);
    assert.match(
      bodyCreate.body,
      /<svc:CreateResult i:type="e:guid">00000000-0000-0000-0000-000000000000<\/svc:CreateResult>/,
    );
    const retrieved = await t.send(
      execOne('RetrieveRequest', 'Retrieve', [
        pair('Target', refValue('widget', id)),
        pair('ColumnSet', valueEl('a:ColumnSet', '<a:AllColumns>true</a:AllColumns><a:Columns/>')),
      ]),
    );
    assert.equal(retrieved.status, 200, retrieved.body);
    assert.equal(attrText(retrieved.body, 'name'), 'Final typed row');
    assert.match(retrieved.body, /<b:key>cash<\/b:key><b:value i:type="a:Money">/);
    assert.ok(retrieved.body.includes('9007199254740993.250001'));
    assert.ok(retrieved.body.includes('Exact display'));
    assert.ok(retrieved.body.includes('<a:RowVersion>19</a:RowVersion>'));
    assert.ok(retrieved.body.includes('<a:RowVersion>17</a:RowVersion>'));
    assert.match(retrieved.body, /<b:key>alias<\/b:key><b:value i:type="a:AliasedValue">/);
    assert.equal(guidOf(retrieved.body, 'CustomGuid'), replacement);
    const query = valueEl(
      'a:QueryExpression',
      '<a:EntityName>widget</a:EntityName><a:ColumnSet i:type="a:ColumnSet"><a:AllColumns>true</a:AllColumns><a:Columns/></a:ColumnSet>',
    );
    const many = await t.send(execOne('RetrieveMultipleRequest', 'RetrieveMultiple', [pair('Query', query)]));
    assert.equal(many.status, 200, many.body);
    assert.equal(rowCount(many.body), 1);
    assert.ok(many.body.includes('<a:TotalRecordCount>7</a:TotalRecordCount>'));
    assert.ok(many.body.includes('<a:MoreRecords>true</a:MoreRecords>'));
    assert.ok(many.body.includes('<a:PagingCookie>opaque-cookie</a:PagingCookie>'));
    assert.ok(many.body.includes('<a:MinActiveRowVersion>23</a:MinActiveRowVersion>'));
    conflict = true;
    const ambiguous = await t.send(execOne('RetrieveMultipleRequest', 'RetrieveMultiple', [pair('Query', query)]));
    assert.equal(ambiguous.status, 500);
    assert.match(ambiguous.body, /conflicting context and SDK response result aliases/);
    const updated = await t.send(
      execOne('UpdateRequest', 'Update', [
        pair('Target', entityValue('widget', [pair('name', str('Updated'))], `<a:Id>${id}</a:Id>`)),
      ]),
    );
    assert.equal(updated.status, 200, updated.body);
    assert.equal(guidOf(updated.body, 'CustomGuid'), replacement);
    const deleted = await t.send(execOne('DeleteRequest', 'Delete', [pair('Target', refValue('widget', id))]));
    assert.equal(deleted.status, 200, deleted.body);
    assert.equal(guidOf(deleted.body, 'CustomGuid'), replacement);
  } finally {
    await backend.close();
  }
});

test('SOAP preserves original read query types and mutations, empty Retrieve columns and read bypass', async () => {
  const t = await setup();
  const id = await createWidget(t, [pair('name', str('alpha'))]);
  await createWidget(t, [pair('name', str('beta'))]);
  const emptyColumns = valueEl('a:ColumnSet', '<a:AllColumns>false</a:AllColumns><a:Columns/>');
  const empty = await t.send(
    execOne('RetrieveRequest', 'Retrieve', [pair('Target', refValue('widget', id)), pair('ColumnSet', emptyColumns)]),
  );
  assert.equal(empty.status, 200, empty.body);
  assert.equal(attrText(empty.body, 'name'), undefined);
  const allColumnsOne = await t.send(
    execOne('RetrieveRequest', 'Retrieve', [
      pair('Target', refValue('widget', id)),
      pair('ColumnSet', valueEl('a:ColumnSet', '<a:AllColumns>1</a:AllColumns><a:Columns/>')),
    ]),
  );
  assert.equal(allColumnsOne.status, 200, allColumnsOne.body);
  assert.equal(attrText(allColumnsOne.body, 'name'), 'alpha');
  const types = [];
  t.store.setPluginPipeline(
    (c) => {
      if (c.stage !== 20) return;
      types.push(c.query.$type);
      if (c.query.$type === 'QueryByAttribute') c.query.values = ['alpha'];
      else {
        assert.equal(c.query.criteria.filterHint, 'union');
        assert.equal(c.query.noLock, true);
        c.query.criteria.conditions.push({ attributeName: 'name', operatorName: 'Equal', values: ['beta'] });
      }
    },
    (c) => c.operation === 'retrievemultiple',
  );
  const qba = valueEl(
    'a:QueryByAttribute',
    '<a:EntityName>widget</a:EntityName><a:Attributes><b:string>name</b:string></a:Attributes>' +
      '<a:ColumnSet i:type="a:ColumnSet"><a:AllColumns>true</a:AllColumns></a:ColumnSet>' +
      `<a:Values>${str('beta')}</a:Values>`,
  );
  const qbaAnswer = await t.send(execOne('RetrieveMultipleRequest', 'RetrieveMultiple', [pair('Query', qba)]));
  assert.equal(qbaAnswer.status, 200, qbaAnswer.body);
  assert.equal(rowCount(qbaAnswer.body), 1);
  assert.equal(attrText(qbaAnswer.body, 'name'), 'alpha');
  const qe = valueEl(
    'a:QueryExpression',
    '<a:EntityName>widget</a:EntityName><a:NoLock>1</a:NoLock><a:ColumnSet i:type="a:ColumnSet"><a:AllColumns>true</a:AllColumns></a:ColumnSet>' +
      '<a:Criteria><a:FilterOperator>And</a:FilterOperator><a:FilterHint>union</a:FilterHint><a:Conditions/></a:Criteria>',
  );
  const qeAnswer = await t.send(execOne('RetrieveMultipleRequest', 'RetrieveMultiple', [pair('Query', qe)]));
  assert.equal(qeAnswer.status, 200, qeAnswer.body);
  assert.equal(rowCount(qeAnswer.body), 1);
  assert.equal(attrText(qeAnswer.body, 'name'), 'beta');
  const bypassed = await t.send(
    execOne('RetrieveMultipleRequest', 'RetrieveMultiple', [
      pair('Query', qe),
      pair('BypassBusinessLogicExecution', str('CustomSync')),
    ]),
  );
  assert.equal(bypassed.status, 200, bypassed.body);
  assert.equal(rowCount(bypassed.body), 2);
  assert.deepEqual(types, ['QueryByAttribute', 'QueryExpression']);
});

test('SOAP selective step bypass checks privilege and keeps system IDs out of registered message inputs', async () => {
  const t = await setup(),
    selected = '30000000-0000-0000-0000-000000000001';
  const create = execOne('CreateRequest', 'Create', [
    pair('Target', entityValue('widget', [pair('name', str('Selected bypass'))])),
    pair('BypassBusinessLogicExecutionStepIds', str(selected)),
  ]);
  assert.equal((await t.send(create, { user: t.basic })).status, 500);
  assert.equal(t.store.tableRows('widget').length, 0);
  const handle = t.api.records.handle;
  t.api.records.handle = (c) => {
    assert.deepEqual(c.bypassStepIds, [selected]);
    return handle(c);
  };
  assert.equal((await t.send(create)).status, 200);
  t.api.registry.register({
    name: 'SelectiveEcho',
    kind: 'action',
    binding: 'unbound',
    handle: (c) => {
      assert.deepEqual(c.body, { Value: 'Declared' });
      assert.deepEqual(c.bypassStepIds, [selected]);
      assert.deepEqual(c.systemParameters, { BypassBusinessLogicExecutionStepIds: selected });
      return { status: 200, body: { Value: c.body.Value } };
    },
  });
  const result = await t.send(
    execute('OrganizationRequest', 'SelectiveEcho', [
      pair('Value', str('Declared')),
      pair('BypassBusinessLogicExecutionStepIds', str(selected)),
    ]),
  );
  assert.equal(result.status, 200, result.body);
  assert.equal(attrText(result.body, 'Value'), 'Declared');
});

test("a metadata request is answered by the metadata handlers with the table's EntityMetadata", async () => {
  const t = await setup();
  const res = await t.send(execOne('RetrieveEntityRequest', 'RetrieveEntity', [pair('LogicalName', str('widget'))]));
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /i:type="r:RetrieveEntityResponse"/);
  assert.match(res.body, /<b:key>EntityMetadata<\/b:key><b:value i:type="m:EntityMetadata"/);
  assert.match(res.body, /<m:LogicalName>widget<\/m:LogicalName>/);
});

// Captured from the real ServiceClient SDK, unmodified.
const CAPTURED_SDK_RETRIEVE = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header><UserType xmlns="http://schemas.microsoft.com/xrm/2011/Contracts">CrmUser</UserType><SdkClientVersion xmlns="http://schemas.microsoft.com/xrm/2011/Contracts">9.2.49.17970</SdkClientVersion><x-ms-client-request-id xmlns="http://schemas.microsoft.com/xrm/2011/Contracts">7f17a6de-aa76-4f28-ad58-f0e5f1ad22c8</x-ms-client-request-id></s:Header><s:Body><Execute xmlns="http://schemas.microsoft.com/xrm/2011/Contracts/Services"><request i:type="a:RetrieveRequest" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><a:Parameters xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic"><a:KeyValuePairOfstringanyType><b:key>Target</b:key><b:value i:type="a:EntityReference"><a:Id>d5b774b6-ced1-41fa-9833-9f3e163e47ab</a:Id><a:KeyAttributes xmlns:c="http://schemas.microsoft.com/xrm/7.1/Contracts"/><a:LogicalName>gadget</a:LogicalName><a:Name i:nil="true"/><a:RowVersion i:nil="true"/></b:value></a:KeyValuePairOfstringanyType><a:KeyValuePairOfstringanyType><b:key>ColumnSet</b:key><b:value i:type="a:ColumnSet"><a:AllColumns>false</a:AllColumns><a:AttributeExpressions/><a:Columns xmlns:c="http://schemas.microsoft.com/2003/10/Serialization/Arrays"><c:string>widgetid</c:string></a:Columns></b:value></a:KeyValuePairOfstringanyType></a:Parameters><a:RequestId>7f17a6de-aa76-4f28-ad58-f0e5f1ad22c8</a:RequestId><a:RequestName>Retrieve</a:RequestName></request></Execute></s:Body></s:Envelope>`;

// Captured from the real ServiceClient SDK, unmodified.
const CAPTURED_SDK_EXECUTE_MULTIPLE = `<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Header><UserType xmlns="http://schemas.microsoft.com/xrm/2011/Contracts">CrmUser</UserType><SdkClientVersion xmlns="http://schemas.microsoft.com/xrm/2011/Contracts">9.2.49.17970</SdkClientVersion></s:Header><s:Body><Execute xmlns="http://schemas.microsoft.com/xrm/2011/Contracts/Services"><request i:type="a:ExecuteMultipleRequest" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><a:Parameters xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic"><a:KeyValuePairOfstringanyType><b:key>Requests</b:key><b:value i:type="c:OrganizationRequestCollection" xmlns:c="http://schemas.microsoft.com/xrm/2012/Contracts"><c:OrganizationRequest i:type="a:CreateRequest"><a:Parameters><a:KeyValuePairOfstringanyType><b:key>Target</b:key><b:value i:type="a:Entity"><a:Attributes><a:KeyValuePairOfstringanyType><b:key>name</b:key><b:value i:type="d:string" xmlns:d="http://www.w3.org/2001/XMLSchema">soap-EM-1</b:value></a:KeyValuePairOfstringanyType></a:Attributes><a:EntityState i:nil="true"/><a:FormattedValues/><a:Id>00000000-0000-0000-0000-000000000000</a:Id><a:KeyAttributes xmlns:d="http://schemas.microsoft.com/xrm/7.1/Contracts"/><a:LogicalName>widget</a:LogicalName><a:RelatedEntities/><a:RowVersion i:nil="true"/></b:value></a:KeyValuePairOfstringanyType></a:Parameters><a:RequestId i:nil="true"/><a:RequestName>Create</a:RequestName></c:OrganizationRequest><c:OrganizationRequest i:type="a:DeleteRequest"><a:Parameters><a:KeyValuePairOfstringanyType><b:key>Target</b:key><b:value i:type="a:EntityReference"><a:Id>8e0a8ce4-0557-4faf-bdb8-96039e5242aa</a:Id><a:KeyAttributes xmlns:d="http://schemas.microsoft.com/xrm/7.1/Contracts"/><a:LogicalName>widget</a:LogicalName><a:Name i:nil="true"/><a:RowVersion i:nil="true"/></b:value></a:KeyValuePairOfstringanyType></a:Parameters><a:RequestId i:nil="true"/><a:RequestName>Delete</a:RequestName></c:OrganizationRequest><c:OrganizationRequest i:type="a:CreateRequest"><a:Parameters><a:KeyValuePairOfstringanyType><b:key>Target</b:key><b:value i:type="a:Entity"><a:Attributes><a:KeyValuePairOfstringanyType><b:key>name</b:key><b:value i:type="d:string" xmlns:d="http://www.w3.org/2001/XMLSchema">soap-EM-3</b:value></a:KeyValuePairOfstringanyType></a:Attributes><a:EntityState i:nil="true"/><a:FormattedValues/><a:Id>00000000-0000-0000-0000-000000000000</a:Id><a:KeyAttributes xmlns:d="http://schemas.microsoft.com/xrm/7.1/Contracts"/><a:LogicalName>widget</a:LogicalName><a:RelatedEntities/><a:RowVersion i:nil="true"/></b:value></a:KeyValuePairOfstringanyType></a:Parameters><a:RequestId i:nil="true"/><a:RequestName>Create</a:RequestName></c:OrganizationRequest></b:value></a:KeyValuePairOfstringanyType><a:KeyValuePairOfstringanyType><b:key>Settings</b:key><b:value i:type="c:ExecuteMultipleSettings" xmlns:c="http://schemas.microsoft.com/xrm/2012/Contracts"><c:ContinueOnError>true</c:ContinueOnError><c:ReturnResponses>true</c:ReturnResponses></b:value></a:KeyValuePairOfstringanyType></a:Parameters><a:RequestId>e3934a15-df20-4d88-9f65-2a90c65f99fc</a:RequestId><a:RequestName>ExecuteMultiple</a:RequestName></request></Execute></s:Body></s:Envelope>`;

// The real SDK sends Requests as OrganizationRequestCollection in xrm/2012 (ExecuteMultiple).
test('the captured SDK ExecuteMultiple runs every request of its xrm/2012 OrganizationRequestCollection', async () => {
  const t = await setup();
  const invalid = await t.send(
    CAPTURED_SDK_EXECUTE_MULTIPLE.replace('e3934a15-df20-4d88-9f65-2a90c65f99fc', 'not-a-guid'),
  );
  assert.equal(invalid.status, 500);
  assert.match(invalid.body, /OrganizationRequest.RequestId requires a GUID/);
  assert.deepEqual(t.store.tableRows('widget'), []);
  const res = await t.send(CAPTURED_SDK_EXECUTE_MULTIPLE);
  assert.equal(res.status, 200, res.body);
  // Creates at indexes 0 and 2 run. The Delete at index 1 names a missing row, so it faults and ContinueOnError carries on.
  assert.deepEqual(
    t.store.state.tables.widget.map((row) => row.name),
    ['soap-EM-1', 'soap-EM-3'],
  );
  assert.equal(res.body.match(/<l:ExecuteMultipleResponseItem>/g).length, 3);
  assert.match(res.body, /<b:key>IsFaulted<\/b:key><b:value i:type="c:boolean">true<\/b:value>/);
  assert.match(res.body, /<l:Fault i:nil="true"\/><l:RequestIndex>0<\/l:RequestIndex>/);
  assert.match(res.body, /<l:RequestIndex>1<\/l:RequestIndex>/);
  assert.match(res.body, /<l:Fault i:nil="true"\/><l:RequestIndex>2<\/l:RequestIndex>/);
  assert.equal(errorCode(res.body), -2147220969);
});

// The Retrieve capture (ColumnSet with an xrm/7.1 KeyAttributes and a Serialization/Arrays Columns list) reaches the record lookup.
test('the captured SDK Retrieve decodes its ColumnSet and reaches the record lookup', async () => {
  const t = await setup();
  const res = await t.send(CAPTURED_SDK_RETRIEVE);
  assert.equal(res.status, 500, res.body);
  assert.equal(errorCode(res.body), -2147220969);
});

// ExecuteMultiple and ExecuteTransaction both read Requests; the SDK's prefix is arbitrary, so each namespace must decode. The a:
// prefix is the one the tests above send.
for (const prefix of ['l', 'o']) {
  for (const [type, name] of [
    ['ExecuteMultipleRequest', 'ExecuteMultiple'],
    ['ExecuteTransactionRequest', 'ExecuteTransaction'],
  ]) {
    test(`${name} decodes a Requests collection in the ${prefix}: and runs every item`, async () => {
      const t = await setup();
      const requests = valueEl(
        `${prefix}:OrganizationRequestCollection`,
        [
          orgRequest('CreateRequest', [pair('Target', entityValue('widget', [pair('name', str('ns-1'))]))]),
          orgRequest('CreateRequest', [pair('Target', entityValue('widget', [pair('name', str('ns-2'))]))]),
        ].join(''),
      );
      const extra =
        name === 'ExecuteMultiple'
          ? [
              pair(
                'Settings',
                valueEl(
                  `${prefix}:ExecuteMultipleSettings`,
                  '<a:ContinueOnError>false</a:ContinueOnError><a:ReturnResponses>true</a:ReturnResponses>',
                ),
              ),
            ]
          : [pair('ReturnResponses', bool('true'))];
      const res = await t.send(execOne(type, name, [pair('Requests', requests), ...extra]));
      assert.equal(res.status, 200, res.body);
      assert.deepEqual(
        t.store.state.tables.widget.map((row) => row.name),
        ['ns-1', 'ns-2'],
      );
      const items =
        name === 'ExecuteMultiple'
          ? /<l:ExecuteMultipleResponseItem>/g
          : /<a:OrganizationResponse i:type="a:CreateResponse">/g;
      assert.equal(res.body.match(items).length, 2);
    });
  }
}

// ---- Registry operations over SOAP: declared response shapes, bound routing and the CSDL that $metadata lists ----
// Operations with the native shape of their named messages (the CSDL below is test-local).
const PARTITION_CSDL = `<ComplexType Name="AuditPartitionDetail">
  <Property Name="PartitionNumber" Type="Edm.Int32" />
  <Property Name="StartDate" Type="Edm.DateTimeOffset" />
  <Property Name="EndDate" Type="Edm.DateTimeOffset" />
  <Property Name="Size" Type="Edm.Int64" />
</ComplexType>
<ComplexType Name="RetrieveAuditPartitionListResponse">
  <Property Name="AuditPartitionDetailCollection" Type="Collection(mscrm.AuditPartitionDetail)" />
</ComplexType>
<Function Name="RetrieveAuditPartitionList">
  <ReturnType Type="mscrm.RetrieveAuditPartitionListResponse" Nullable="false" />
</Function>`;

test('a complex response answers its declared members, typed and in DataContract order, over SOAP', async () => {
  const t = await setup();
  t.api.registry.register({
    name: 'RetrieveAuditPartitionList',
    kind: 'function',
    binding: 'unbound',
    csdl: PARTITION_CSDL,
    handle: () => ({
      status: 200,
      body: {
        '@odata.context': 'x',
        AuditPartitionDetailCollection: [{ PartitionNumber: 1, StartDate: null, EndDate: null, Size: 0 }],
      },
    }),
  });
  const res = await t.send(execute('OrganizationRequest', 'RetrieveAuditPartitionList'));
  assert.equal(res.status, 200, res.body);
  // The response is the SDK's typed class (crm/2011 Contracts), so the client can cast it.
  assert.match(
    res.body,
    /<svc:ExecuteResult xmlns:r="http:\/\/schemas\.microsoft\.com\/crm\/2011\/Contracts" i:type="r:RetrieveAuditPartitionListResponse">/,
  );
  assert.match(
    res.body,
    /<b:key>AuditPartitionDetailCollection<\/b:key><b:value i:type="g:ArrayOfAuditPartitionDetail"/,
  );
  // Members in DataContract order (alphabetical), nil where the value is null.
  const item =
    /<AuditPartitionDetail xmlns="http:\/\/schemas\.microsoft\.com\/crm\/2011\/Contracts">(.*?)<\/AuditPartitionDetail>/.exec(
      res.body,
    )?.[1];
  assert.ok(item, res.body);
  const order = [...item.matchAll(/<(EndDate|PartitionNumber|Size|StartDate)[ >/]/g)].map((m) => m[1]);
  assert.deepEqual(order, ['EndDate', 'PartitionNumber', 'Size', 'StartDate']);
  assert.match(item, /<EndDate i:nil="true"\/>/);
  assert.match(item, /<PartitionNumber>1<\/PartitionNumber>/);
});

test('a complex response with a collection of RolePrivilege answers the crm contract members', async () => {
  const t = await setup();
  const csdl = `<ComplexType Name="RolePrivilege">
  <Property Name="Depth" Type="Edm.String" />
  <Property Name="PrivilegeId" Type="Edm.Guid" />
  <Property Name="PrivilegeName" Type="Edm.String" />
</ComplexType>
<ComplexType Name="RetrieveUsersPrivilegesThroughTeamsResponse">
  <Property Name="RolePrivileges" Type="Collection(mscrm.RolePrivilege)" />
</ComplexType>
<Function Name="RetrieveUsersPrivilegesThroughTeams">
  <ReturnType Type="mscrm.RetrieveUsersPrivilegesThroughTeamsResponse" Nullable="false" />
</Function>`;
  const privilege = 'aaaaaaaa-0000-4000-8000-0000000000c1';
  t.api.registry.register({
    name: 'RetrieveUsersPrivilegesThroughTeams',
    kind: 'function',
    binding: 'unbound',
    csdl,
    handle: () => ({
      status: 200,
      body: { RolePrivileges: [{ Depth: 'Basic', PrivilegeId: privilege, PrivilegeName: 'prvReadWidget' }] },
    }),
  });
  const res = await t.send(execute('OrganizationRequest', 'RetrieveUsersPrivilegesThroughTeams'));
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<b:value i:type="g:ArrayOfRolePrivilege"/);
  const item =
    /<RolePrivilege xmlns="http:\/\/schemas\.microsoft\.com\/crm\/2011\/Contracts">(.*?)<\/RolePrivilege>/.exec(
      res.body,
    )?.[1];
  assert.ok(item, res.body);
  const order = [...item.matchAll(/<(Depth|PrivilegeId|PrivilegeName)>/g)].map((m) => m[1]);
  assert.deepEqual(order, ['Depth', 'PrivilegeId', 'PrivilegeName']);
  assert.match(item, new RegExp(`<PrivilegeId>${privilege}</PrivilegeId>`));
});

test("a function returning a table's rows answers one EntityCollection of Entity elements", async () => {
  const t = await setup();
  const gadget = 'aaaaaaaa-0000-4000-8000-0000000000d1';
  t.api.registry.register({
    name: 'RetrieveGadgets',
    kind: 'function',
    binding: 'unbound',
    csdl: `<Function Name="RetrieveGadgets"><ReturnType Type="Collection(mscrm.gadget)" Nullable="false" /></Function>`,
    handle: () => ({ status: 200, body: { value: [{ gadgetid: gadget, name: 'g1' }] } }),
  });
  const res = await t.send(execute('OrganizationRequest', 'RetrieveGadgets'));
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<b:key>EntityCollection<\/b:key><b:value i:type="a:EntityCollection">/);
  assert.match(res.body, /<a:Entities><a:Entity>.*<a:LogicalName>gadget<\/a:LogicalName>/);
  assert.match(res.body, new RegExp(`<a:Id>${gadget}</a:Id>`));
  assert.match(res.body, /<b:key>name<\/b:key><b:value i:type="c:string">g1<\/b:value>/);
});

test('an open-entity result preserves its SDK result name and typed expando attributes', async () => {
  const t = await setup();
  t.api.registry.register({
    name: 'InventedDynamicQuery',
    kind: 'function',
    binding: 'unbound',
    soapResult: 'Result',
    csdl: '<Function Name="InventedDynamicQuery"><ReturnType Type="mscrm.crmbaseentity" Nullable="false" /></Function>',
    handle: () => ({
      status: 200,
      body: {
        '@odata.type': '#Microsoft.Dynamics.CRM.expando',
        HasMore: false,
        PagingCookie: null,
        Result: '[{"value":42}]',
      },
    }),
  });
  const response = await t.send(execute('OrganizationRequest', 'InventedDynamicQuery'));
  assert.equal(response.status, 200, response.body);
  assert.match(response.body, /<b:key>Result<\/b:key><b:value i:type="a:Entity">/);
  assert.match(response.body, /<a:LogicalName>expando<\/a:LogicalName>/);
  assert.match(response.body, /<b:key>HasMore<\/b:key><b:value i:type="c:boolean">false<\/b:value>/);
  assert.match(response.body, /<b:key>PagingCookie<\/b:key><b:value i:nil="true"\/>/);
  t.api.changes.close();
});

test('a request whose Target is a widget reference runs the operation bound to widget, with the row', async () => {
  const t = await setup();
  const seen = [];
  t.api.registry.register({
    name: 'Touch',
    kind: 'action',
    binding: 'entity',
    entity: 'widget',
    handle: (c) => {
      seen.push({ id: c.target.id, name: c.target.row.name, url: c.url.pathname });
      return { status: 200, body: { '@odata.context': 'x', Name: c.target.row.name } };
    },
  });
  const id = await createWidget(t, [pair('name', str('w1'))]);
  const res = await t.send(execute('OrganizationRequest', 'Touch', [pair('Target', refValue('widget', id))]));
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(seen, [{ id, name: 'w1', url: `/api/data/v9.2/widgets(${id})/Microsoft.Dynamics.CRM.Touch` }]);
  assert.match(res.body, /<b:key>Name<\/b:key><b:value i:type="c:string">w1<\/b:value>/);
});

test('a bound request for a missing row is a NotFound fault; an unbound operation still takes a table reference', async () => {
  const t = await setup();
  t.api.registry.register({
    name: 'Touch',
    kind: 'action',
    binding: 'entity',
    entity: 'widget',
    handle: () => ({ status: 200, body: {} }),
  });
  const res = await t.send(execute('OrganizationRequest', 'Touch', [pair('Target', refValue('widget', MISSING))]));
  assert.equal(res.status, 500);
  assert.match(res.body, /Does Not Exist/);
  t.api.registry.register({
    name: 'Echo',
    kind: 'action',
    binding: 'unbound',
    handle: (c) => ({ status: 200, body: { Count: c.body.Target ? 1 : 0 } }),
  });
  const unbound = await t.send(execute('OrganizationRequest', 'Echo', [pair('Target', refValue('widget', MISSING))]));
  assert.equal(unbound.status, 200, unbound.body);
  assert.match(unbound.body, /<b:key>Count<\/b:key><b:value i:type="c:int">1<\/b:value>/);
});

test('a collection-bound request names its table through the reference collection', async () => {
  const t = await setup();
  let table = null;
  t.api.registry.register({
    name: 'Batch',
    kind: 'action',
    binding: 'collection',
    entity: 'widget',
    handle: (c) => {
      table = c.target.mapping.logicalName;
      return { status: 200, body: { Count: 2 } };
    },
  });
  const refs = `<a:EntityReference><a:Id>${MISSING}</a:Id><a:LogicalName>widget</a:LogicalName></a:EntityReference>`;
  const res = await t.send(
    execute('OrganizationRequest', 'Batch', [pair('Target', valueEl('a:EntityReferenceCollection', refs + refs))]),
  );
  assert.equal(res.status, 200, res.body);
  assert.equal(table, 'widget');
  assert.match(res.body, /<b:key>Count<\/b:key><b:value i:type="c:int">2<\/b:value>/);
});

test('an EntityCollection and a string array in the request reach the operation as plain rows and values', async () => {
  const t = await setup();
  let seen = null;
  t.api.registry.register({
    name: 'Measure',
    kind: 'action',
    binding: 'unbound',
    handle: (c) => {
      seen = { rows: c.params.Items.value.map((row) => row.name), names: c.params.Names };
      return { status: 200, body: { Count: c.params.Items.value.length } };
    },
  });
  const collection = valueEl(
    'a:EntityCollection',
    `<a:Entities><a:Entity><a:Attributes>${pair('name', str('first'))}</a:Attributes><a:LogicalName>widget</a:LogicalName></a:Entity></a:Entities><a:MoreRecords>false</a:MoreRecords>`,
  );
  const names = valueEl('f:ArrayOfstring', '<f:string>a</f:string><f:string>b</f:string>');
  const res = await t.send(
    execute('OrganizationRequest', 'Measure', [pair('Items', collection), pair('Names', names)]),
  );
  assert.equal(res.status, 200, res.body);
  assert.deepEqual(seen, { rows: ['first'], names: ['a', 'b'] });
  assert.match(res.body, /<b:key>Count<\/b:key><b:value i:type="c:int">1<\/b:value>/);
});

test('$metadata lists every registered operation: bound ones with IsBound, and no-CSDL ones declared from their signature', async () => {
  const t = await setup();
  const registry = t.api.registry;
  const noop = () => ({ status: 200, body: {} });
  registry.register({ name: 'Plain', kind: 'action', binding: 'unbound', handle: noop });
  registry.register({
    name: 'Shaped',
    kind: 'function',
    binding: 'unbound',
    signature: { params: [['Key', 'Edm.String']], response: [['Value', 'Edm.Int32']] },
    handle: noop,
  });
  registry.register({ name: 'Touch', kind: 'action', binding: 'entity', entity: 'widget', handle: noop });
  registry.register({ name: 'Batch', kind: 'action', binding: 'collection', entity: 'widget', handle: noop });
  registry.register({
    name: 'Declared',
    kind: 'function',
    binding: 'unbound',
    csdl: '<Function Name="Declared" />',
    handle: noop,
  });
  const csdl = registry.csdlFragments();
  for (const name of registry.names())
    assert.match(csdl, new RegExp(`<(Action|Function) Name="${name}"`), `${name} is listed`);
  assert.match(
    csdl,
    /<Action Name="Touch" IsBound="true">\s*<Parameter Name="entity" Type="mscrm\.widget" Nullable="false" \/>/,
  );
  assert.match(
    csdl,
    /<Action Name="Batch" IsBound="true">\s*<Parameter Name="entity" Type="Collection\(mscrm\.widget\)" Nullable="false" \/>/,
  );
  assert.match(
    csdl,
    /<Function Name="Shaped">\s*<Parameter Name="Key" Type="Edm\.String" \/>\s*<ReturnType Type="mscrm\.ShapedResponse" Nullable="false" \/>/,
  );
  assert.match(csdl, /<ComplexType Name="ShapedResponse"><Property Name="Value" Type="Edm\.Int32" \/><\/ComplexType>/);
});

test('OptionSetValue and Money members of a complex response are typed as the xrm contract values', async () => {
  const t = await setup();
  const csdl = `<ComplexType Name="PriceStatusResponse">
  <Property Name="Price" Type="mscrm.Money" />
  <Property Name="Status" Type="mscrm.OptionSetValue" />
</ComplexType>
<Function Name="PriceStatus">
  <ReturnType Type="mscrm.PriceStatusResponse" Nullable="false" />
</Function>`;
  t.api.registry.register({
    name: 'PriceStatus',
    kind: 'function',
    binding: 'unbound',
    csdl,
    handle: () => ({ status: 200, body: { Status: { Value: 2 }, Price: '12.5' } }),
  });
  const res = await t.send(execute('OrganizationRequest', 'PriceStatus'));
  assert.equal(res.status, 200, res.body);
  assert.match(res.body, /<b:key>Status<\/b:key><b:value i:type="a:OptionSetValue"><a:Value>2<\/a:Value><\/b:value>/);
  assert.match(
    res.body,
    /<b:key>Price<\/b:key><b:value i:type="a:Money"><a:Value i:type="c:decimal">12\.5000<\/a:Value><\/b:value>/,
  );
});

test('a reference without an Id does not bind: the unbound operation of that name runs', async () => {
  const t = await setup();
  let ran = false;
  t.api.registry.register({
    name: 'Keyed',
    kind: 'action',
    binding: 'entity',
    entity: 'widget',
    handle: () => {
      throw new Error('bound handler must not run');
    },
  });
  t.api.registry.register({
    name: 'Keyed',
    kind: 'action',
    binding: 'unbound',
    handle: () => {
      ran = true;
      return { status: 200, body: { Count: 0 } };
    },
  });
  const keyless = valueEl('a:EntityReference', `<a:LogicalName>widget</a:LogicalName><a:Name i:nil="true"/>`);
  const res = await t.send(execute('OrganizationRequest', 'Keyed', [pair('Target', keyless)]));
  assert.equal(res.status, 200, res.body);
  assert.equal(ran, true);
});

test('SOAP exact Boolean duplicate detection controls reach the real create and update rule hooks', async () => {
  const t = await setup();
  await installDuplicates(t.api);
  const rule = '10000000-0000-4000-8000-000000000091';
  t.store.state.tables.duplicaterule.push({
    duplicateruleid: rule,
    name: 'Invented name match',
    baseentityname: 'widget',
    matchingentityname: 'widget',
    statecode: 1,
    statuscode: 2,
  });
  t.store.state.tables.duplicaterulecondition.push({
    duplicateruleconditionid: '10000000-0000-4000-8000-000000000092',
    regardingobjectid: rule,
    baseattributename: 'name',
    matchingattributename: 'name',
    operatorcode: 'ExactMatch',
  });
  await createWidget(t, [pair('name', str('Duplicate'))]);
  const create = (extra) =>
    t.send(
      execOne('CreateRequest', 'Create', [
        pair('Target', entityValue('widget', [pair('name', str('Duplicate'))])),
        ...extra,
      ]),
    );
  const refused = await create([pair('SuppressDuplicateDetection', bool(false))]);
  assert.equal(refused.status, 500, refused.body);
  assert.equal(errorCode(refused.body), Number.parseInt('80040333', 16) | 0);
  assert.equal(t.store.tableRows('widget').length, 1);
  assert.equal((await create([pair('SuppressDuplicateDetection', bool(true))])).status, 200);
  assert.equal((await create([])).status, 200, 'A previous false flag cannot leak into an omitted default');
  assert.equal(t.store.tableRows('widget').length, 3);
  const different = await createWidget(t, [pair('name', str('Different'))]);
  const target = entityValue('widget', [pair('widgetid', guidValue(different)), pair('name', str('Duplicate'))]);
  const update = (flag) =>
    t.send(execOne('UpdateRequest', 'Update', [pair('Target', target), pair('SuppressDuplicateDetection', flag)]));
  const denied = await update(bool(false));
  assert.equal(denied.status, 500);
  assert.equal(errorCode(denied.body), Number.parseInt('80040333', 16) | 0);
  assert.equal(t.store.tableRows('widget').find((row) => row.widgetid === different).name, 'Different');
  assert.equal((await update(bool(true))).status, 200);
  const before = structuredClone(t.store.tableRows('widget'));
  assert.equal((await create([pair('SuppressDuplicateDetection', str('false'))])).status, 500);
  assert.deepEqual(t.store.tableRows('widget'), before);
  const unsupported = await create([pair('InventedOptional', bool(true))]);
  assert.equal(unsupported.status, 500);
  assert.match(unsupported.body, /Unsupported SOAP Create request parameter: InventedOptional/);
  assert.deepEqual(t.store.tableRows('widget'), before, 'Configured unknown controls must fail before record effects');
});
