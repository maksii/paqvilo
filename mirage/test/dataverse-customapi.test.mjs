// Custom APIs: customapi tables, unpacked solution parsing and registry operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createPrincipals, ensureSecurityModel } from '../lib/dataverse-security.mjs';
import { dataverseError, parseDataverseRoute, parsePrefer } from '../lib/dataverse-odata.mjs';
import { createRecordHandlers, createRecordHooks } from '../lib/dataverse-records.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { customApiHandlers, install, parseCustomApiFiles, readCustomApiSolution } from '../lib/dataverse-customapi.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const VERSION = 'v9.2';
const ADMIN = { systemuserid: 'aaaaaaaa-0000-4000-8000-000000000001' };
const LOGICAL = ['customapi', 'customapirequestparameter', 'customapiresponseproperty'];
const ORG = '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const SETTINGS = {
  organizationId: ORG,
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [{ objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] }],
};

const el = (name, value = '') => `<${name}>${value}</${name}>`;
const label = (name, text) =>
  `<${name} default="${text}"><label description="${text}" languagecode="1033" /></${name}>`;
const apiXml = (uniquename, { bindingtype = 0, entity = '', isfunction = 0, isprivate = 0, privilege = '' }) =>
  `<customapi uniquename="${uniquename}">${el('bindingtype', bindingtype)}${el('boundentitylogicalname', entity)}${label('displayname', uniquename)}${el('executeprivilegename', privilege)}${el('isfunction', isfunction)}${el('isprivate', isprivate)}${el('name', uniquename)}</customapi>`;
const paramXml = (api, uniquename, { type, optional = 0, entity = '' }) =>
  `<customapirequestparameter uniquename="${uniquename}">${label('displayname', uniquename)}${el('isoptional', optional)}${el('logicalentityname', entity)}${el('name', `${api}.${uniquename}`)}${el('type', type)}</customapirequestparameter>`;
const propXml = (api, uniquename, { type, entity = '' }) =>
  `<customapiresponseproperty uniquename="${uniquename}">${label('displayname', uniquename)}${el('logicalentityname', entity)}${el('name', `${api}.${uniquename}`)}${el('type', type)}</customapiresponseproperty>`;

// One custom API as unpacked files: customapi.xml, then its request parameters and response properties.
function apiFiles(uniquename, { params = [], props = [], ...options } = {}) {
  return [
    { path: `${uniquename}/customapi.xml`, text: apiXml(uniquename, options) },
    ...params.map(([name, o]) => ({
      path: `${uniquename}/customapirequestparameters/${name}/customapirequestparameter.xml`,
      text: paramXml(uniquename, name, o),
    })),
    ...props.map(([name, o]) => ({
      path: `${uniquename}/customapiresponseproperties/${name}/customapiresponseproperty.xml`,
      text: propXml(uniquename, name, o),
    })),
  ];
}

// Type codes: Boolean 0, DateTime 1, Entity 3, EntityCollection 4, Integer 7, Guid 12, String 10, StringArray 11.
const FILES = [
  ...apiFiles('sample_Unbound', {
    params: [
      ['Message', { type: 10 }],
      ['Count', { type: 7, optional: 1 }],
    ],
  }),
  ...apiFiles('sample_Bound', {
    bindingtype: 1,
    entity: 'account',
    isfunction: 1,
    params: [['Flag', { type: 0 }]],
    props: [
      ['Score', { type: 7 }],
      ['Labels', { type: 11 }],
      ['Enabled', { type: 0 }],
      ['Stamp', { type: 1 }],
      ['Id', { type: 12 }],
    ],
  }),
  ...apiFiles('sample_Collection', {
    bindingtype: 2,
    entity: 'sample_item',
    isfunction: 1,
    privilege: 'prvSampleRun',
    props: [['Items', { type: 4, entity: 'sample_item' }]],
  }),
  ...apiFiles('sample_Private', { isprivate: 1, props: [['Note', { type: 10 }]] }),
  ...apiFiles('sample_Empty', { isfunction: 1 }),
];

function harness(files = FILES, options = {}) {
  const state = emptyState();
  const rows = parseCustomApiFiles(files);
  for (const logical of LOGICAL) state.tables[logical] = rows[logical];
  const store = new DataStore({ state });
  const ops = [];
  const grants = new Map();
  const registry = {
    register: (op) => ops.push(op),
    has: (name) => ops.some((o) => o.name === name),
    find: () => null,
  };
  const api = { store, change: (fn) => fn(), registry, principals: { privileges: () => grants } };
  const { sync } = install(api, options);
  const op = (name) => ops.find((o) => o.name === name);
  const call = (name, { method = 'GET', params = {}, body, user = ADMIN } = {}) =>
    op(name).handle({
      method,
      url: new URL(`/api/data/${VERSION}/${name}`, ORIGIN),
      origin: ORIGIN,
      version: VERSION,
      params,
      body,
      user,
    });
  return { store, ops, grants, sync, op, call };
}

const innerCode = (code) => (error) => error.details?.innerCode === code;

test('install seeds the three tables as dataverse-only mappings and keeps an existing mapping', () => {
  const state = emptyState();
  state.mappings.customapi = { logicalName: 'customapi', entitySet: 'custom', idColumn: 'customapiid', fields: {} };
  const store = new DataStore({ state });
  install({ store, change: (fn) => fn(), registry: { register() {}, has: () => false } });
  assert.equal(store.state.mappings.customapi.entitySet, 'custom');
  assert.equal(store.state.mappings.customapi.dataverseOnly, undefined);
  for (const logical of LOGICAL.slice(1)) {
    const mapping = store.state.mappings[logical];
    assert.equal(mapping.userConfigured, true);
    assert.equal(mapping.dataverseOnly, true);
  }
  assert.equal(store.state.mappings.customapirequestparameter.relationships.CustomAPIId.entity, 'customapi');
});

test('each row registers on its binding: unbound action, entity function, collection function', () => {
  const { op } = harness();
  assert.equal(op('sample_Unbound').kind, 'action');
  assert.equal(op('sample_Unbound').binding, 'unbound');
  assert.equal(op('sample_Unbound').entity, undefined);
  assert.equal(op('sample_Bound').kind, 'function');
  assert.equal(op('sample_Bound').binding, 'entity');
  assert.equal(op('sample_Bound').entity, 'account');
  assert.equal(op('sample_Collection').binding, 'collection');
  assert.equal(op('sample_Collection').entity, 'sample_item');
});

test('an action with no response properties returns 204; optional parameters may be omitted', async () => {
  const { call } = harness();
  assert.equal((await call('sample_Unbound', { method: 'POST', body: { Message: 'hi' } })).status, 204);
  assert.equal((await call('sample_Unbound', { method: 'POST', body: { Message: 'hi', Count: 2 } })).status, 204);
});

test('a missing required action parameter is a 400 0x80040203; a function missing one is a 404 0x80060888; a literal that does not convert is a 400 0x80048d19', async () => {
  const { call } = harness();
  await assert.rejects(call('sample_Unbound', { method: 'POST', body: { Count: 1 } }), innerCode('0x80040203'));
  await assert.rejects(call('sample_Unbound', { method: 'POST', body: { Message: 5 } }), innerCode('0x80048d19'));
  await assert.rejects(
    call('sample_Unbound', { method: 'POST', body: { Message: 'hi', Count: 1.5 } }),
    innerCode('0x80048d19'),
  );
  // A function whose URL omits a required parameter finds no resource (native custom.function-missing: 404 0x80060888).
  await assert.rejects(call('sample_Bound', {}), (e) => e.status === 404 && innerCode('0x80060888')(e));
});

test('a function returns each response property at its type default in a complex response', async () => {
  const { call } = harness();
  const res = await call('sample_Bound', { params: { Flag: true } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    '@odata.context': `${ORIGIN}/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.sample_BoundResponse`,
    Score: 0,
    Labels: [],
    Enabled: false,
    Stamp: '0001-01-01T00:00:00Z',
    Id: '00000000-0000-0000-0000-000000000000',
  });
});

test('functions are GET and actions are POST: another verb is the generic 404', async () => {
  const { call } = harness();
  await assert.rejects(call('sample_Bound', { method: 'POST', params: { Flag: true } }), (e) => e.status === 404);
  await assert.rejects(call('sample_Unbound', { method: 'GET' }), (e) => e.status === 404);
});

test('a lone collection response property is the collection type itself', async () => {
  const { call, grants } = harness();
  grants.set('prvSampleRun', 1);
  const res = await call('sample_Collection');
  assert.deepEqual(res.body, {
    '@odata.context': `${ORIGIN}/api/data/v9.2/$metadata#Collection(mscrm.sample_item)`,
    value: [],
  });
});

test('executeprivilegename is checked: a missing privilege is a 403 0x80040220', async () => {
  const { call, grants } = harness();
  await assert.rejects(call('sample_Collection'), innerCode('0x80040220'));
  grants.set('prvSampleRun', 1);
  assert.equal((await call('sample_Collection')).status, 200);
});

test('a function with no response property is absent: 404 0x80060888 (native custom.no-output-function)', async () => {
  const { call } = harness();
  await assert.rejects(call('sample_Empty'), innerCode('0x80060888'));
});

test('CSDL: entity-bound function, unbound action, collection-bound function; private and empty functions left out', () => {
  const { op } = harness();
  assert.equal(
    op('sample_Bound').csdl,
    '<ComplexType Name="sample_BoundResponse"><Property Name="Score" Type="Edm.Int32" /><Property Name="Labels" Type="Collection(Edm.String)" /><Property Name="Enabled" Type="Edm.Boolean" /><Property Name="Stamp" Type="Edm.DateTimeOffset" /><Property Name="Id" Type="Edm.Guid" /></ComplexType>' +
      '<Function Name="sample_Bound" IsBound="true"><Parameter Name="entity" Type="mscrm.account" /><Parameter Name="Flag" Type="Edm.Boolean" /><ReturnType Type="mscrm.sample_BoundResponse" /></Function>',
  );
  assert.equal(
    op('sample_Unbound').csdl,
    '<Action Name="sample_Unbound"><Parameter Name="Message" Type="Edm.String" /><Parameter Name="Count" Type="Edm.Int32" /></Action>',
  );
  assert.equal(
    op('sample_Collection').csdl,
    '<Function Name="sample_Collection" IsBound="true"><Parameter Name="entityset" Type="Collection(mscrm.sample_item)" /><ReturnType Type="Collection(mscrm.sample_item)" /></Function>',
  );
  assert.equal(op('sample_Private').csdl, '');
  assert.equal(op('sample_Empty').csdl, '');
});

test('sync registers rows added after install once per revision; a deleted row fails at call time', async () => {
  const { store, ops, sync, call, op } = harness();
  const before = ops.length;
  const later = parseCustomApiFiles(apiFiles('sample_Later')).customapi;
  await store.transact(() => store.state.tables.customapi.push(...later));
  sync();
  assert.equal(ops.length, before + 1);
  assert.ok(op('sample_Later'));
  sync();
  assert.equal(ops.length, before + 1);
  await store.transact(() => {
    const rows = store.state.tables.customapi;
    rows.splice(
      rows.findIndex((r) => r.uniquename === 'sample_Later'),
      1,
    );
  });
  await assert.rejects(call('sample_Later', { method: 'POST' }), innerCode('0x80060888'));
});

test('the solution parser links child rows to their API and reads flags, types and labels', () => {
  const rows = parseCustomApiFiles(FILES);
  const bound = rows.customapi.find((r) => r.uniquename === 'sample_Bound');
  assert.equal(bound.bindingtype, 1);
  assert.equal(bound.boundentitylogicalname, 'account');
  assert.equal(bound.isfunction, true);
  assert.equal(bound.isprivate, false);
  assert.equal(bound.displayname, 'sample_Bound');
  const flag = rows.customapirequestparameter.find((p) => p.uniquename === 'Flag');
  assert.equal(flag.customapiid, bound.customapiid);
  assert.equal(flag.type, 0);
  assert.equal(flag.isoptional, false);
  assert.equal(rows.customapirequestparameter.find((p) => p.uniquename === 'Count').isoptional, true);
  assert.equal(rows.customapiresponseproperty.find((p) => p.uniquename === 'Items').logicalentityname, 'sample_item');
  assert.equal(rows.customapi.find((r) => r.uniquename === 'sample_Collection').executeprivilegename, 'prvSampleRun');
  assert.equal(rows.customapi.find((r) => r.uniquename === 'sample_Unbound').boundentitylogicalname, null);
});

test('readCustomApiSolution reads the unpacked folders from disk', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'customapi-'));
  try {
    for (const file of FILES) {
      const path = join(dir, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, file.text);
    }
    const rows = await readCustomApiSolution(dir);
    assert.deepEqual(rows.customapi.map((r) => r.uniquename).sort(), [
      'sample_Bound',
      'sample_Collection',
      'sample_Empty',
      'sample_Private',
      'sample_Unbound',
    ]);
    assert.equal(rows.customapirequestparameter.length, 3);
    assert.equal(rows.customapiresponseproperty.length, 7);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a documented deep insert creates the parameter and property rows under the parent', async () => {
  const state = emptyState();
  const store = new DataStore({ state });
  const recordHooks = createRecordHooks();
  install({ store, change: (fn) => fn(), registry: { register() {}, has: () => false }, recordHooks });
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const records = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals,
    changes: createChangeLog(store),
    hooks: recordHooks,
  });
  const admin = principals.byObjectId(ADMIN_OID);
  const url = new URL(`${ORIGIN}/api/data/${VERSION}/customapis`);
  const body = {
    uniquename: 'sample_Deep',
    name: 'sample_Deep',
    bindingtype: 0,
    isfunction: false,
    isprivate: false,
    CustomAPIRequestParameters: [{ uniquename: 'Message', name: 'sample_Deep.Message', type: 10, isoptional: false }],
    CustomAPIResponseProperties: [{ uniquename: 'Result', name: 'sample_Deep.Result', type: 10 }],
  };
  await records.handle({
    method: 'POST',
    route: parseDataverseRoute(url.pathname),
    url,
    origin: ORIGIN,
    version: VERSION,
    prefer: parsePrefer(undefined),
    headers: {},
    body,
    user: admin,
    caller: admin,
    identity: { admin: true, id: admin.systemuserid, systemUserId: admin.systemuserid },
    requestId: 'test',
  });
  const parent = store.tableRows('customapi').find((r) => r.uniquename === 'sample_Deep');
  assert.ok(parent, 'the custom API row exists');
  const parameters = store.tableRows('customapirequestparameter').filter((r) => r.uniquename === 'Message');
  const properties = store.tableRows('customapiresponseproperty').filter((r) => r.uniquename === 'Result');
  assert.deepEqual([parameters.length, properties.length], [1, 1]);
  assert.equal(
    String(parameters[0].customapiid.id ?? parameters[0].customapiid).toLowerCase(),
    parent.customapiid.toLowerCase(),
  );
  assert.equal(
    String(properties[0].customapiid.id ?? properties[0].customapiid).toLowerCase(),
    parent.customapiid.toLowerCase(),
  );
});

test('the seeded customapi mappings are persisted by the ready transaction', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'customapi-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = join(dir, 'state.json');
  const store = await new DataStore({ file, state: emptyState() }).init();
  const { ready } = install({ store, change: (fn) => fn(), registry: { register() {}, has: () => false } });
  await ready;
  const reloaded = await new DataStore({ file }).init();
  assert.equal(reloaded.state.mappings.customapi?.dataverseOnly, true);
  assert.equal(reloaded.state.mappings.customapiresponseproperty?.dataverseOnly, true);
});

// Parameter conversion, native defaults and trusted pack handlers on an echo action.
const ECHO = apiFiles('sample_Echo', {
  params: [
    ['Text', { type: 10, optional: 1 }],
    ['Count', { type: 7, optional: 1 }],
    ['Flag', { type: 0, optional: 1 }],
    ['Key', { type: 12, optional: 1 }],
    ['Ids', { type: 11, optional: 1 }],
    ['Stamp', { type: 1, optional: 1 }],
  ],
  props: [
    ['Reply', { type: 10 }],
    ['Count', { type: 7 }],
    ['Flag', { type: 0 }],
    ['Note', { type: 10 }],
    ['Stamp', { type: 1 }],
    ['Key', { type: 12 }],
  ],
});
const ECHO_ROW = `${ORIGIN}/api/data/v9.2/$metadata#Microsoft.Dynamics.CRM.sample_EchoResponse`;
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const ZERO_TIME = '0001-01-01T00:00:00Z';
const payloadError = (detail) => (error) =>
  error.status === 400 &&
  error.details?.innerCode === '0x80048d19' &&
  error.message.endsWith(`Microsoft.OData.ODataException: ${detail}`);
const handlersOf = (customApis) => customApiHandlers([{ id: 'sample-pack', customApis }]);

test('an undeclared parameter is a 400 0x80048d19 naming the parameter and the operation', async () => {
  const { call } = harness([...FILES, ...ECHO]);
  await assert.rejects(
    call('sample_Echo', { method: 'POST', body: { Unknown: 1 } }),
    payloadError(
      "The parameter 'Unknown' in the request payload is not a valid parameter for the operation 'sample_Echo'.",
    ),
  );
});

test('a literal that does not convert is a 400 0x80048d19 with the native literal: Boolean, Int32, Guid and string array', async () => {
  const { call } = harness([...FILES, ...ECHO]);
  const cases = [
    [{ Flag: 'yes' }, "Cannot convert the literal 'yes' to the expected type 'Edm.Boolean'."],
    [{ Count: 2147483648 }, "Cannot convert the literal '2147483648' to the expected type 'Edm.Int32'."],
    [{ Count: 'NaN' }, "Cannot convert the literal 'NaN' to the expected type 'Edm.Int32'."],
    [{ Key: 'bad-guid' }, "Cannot convert the literal 'bad-guid' to the expected type 'Edm.Guid'."],
    [{ Ids: [1, null, {}] }, "Cannot convert the literal '1' to the expected type 'Edm.String'."],
  ];
  for (const [body, detail] of cases)
    await assert.rejects(call('sample_Echo', { method: 'POST', body }), payloadError(detail));
});

test('Boolean takes JSON booleans and the strings true and false; the handler receives typed values', async () => {
  const seen = [];
  const { call } = harness([...FILES, ...ECHO], {
    handlers: handlersOf({
      sample_Echo: (ctx) => {
        seen.push(ctx.inputs);
        return { outputs: {} };
      },
    }),
  });
  assert.equal(
    (await call('sample_Echo', { method: 'POST', body: { Flag: 'true', Count: 3, Ids: ['a'] } })).status,
    200,
  );
  await call('sample_Echo', { method: 'POST', body: { Flag: false } });
  assert.equal(seen[0].Flag, true);
  assert.equal(seen[0].Count, 3);
  assert.deepEqual(seen[0].Ids, ['a']);
  assert.equal(seen[0].Text, undefined);
  assert.equal(seen[1].Flag, false);
});

test('without a handler the response is the native defaults: a string is null, DateTime and Guid are their zero values', async () => {
  const { call } = harness([...FILES, ...ECHO]);
  assert.deepEqual((await call('sample_Echo', { method: 'POST', body: {} })).body, {
    '@odata.context': ECHO_ROW,
    Reply: null,
    Count: 0,
    Flag: false,
    Note: null,
    Stamp: ZERO_TIME,
    Key: ZERO_GUID,
  });
});

test('handler outputs fill the response by name; the bound target and caller reach the handler', async () => {
  const seen = [];
  const handlers = handlersOf({
    sample_Bound: (ctx) => {
      seen.push({ target: ctx.target, caller: ctx.caller });
      return { outputs: { Score: 7, Labels: ['x'] } };
    },
    sample_Echo: () => ({ outputs: { Reply: 'hello', Note: 'n' } }),
  });
  const { call, op } = harness([...FILES, ...ECHO], { handlers });
  const bound = await op('sample_Bound').handle({
    method: 'GET',
    url: new URL('/api/data/v9.2/sample_Bound', ORIGIN),
    origin: ORIGIN,
    version: VERSION,
    params: { Flag: true },
    user: ADMIN,
    caller: { systemuserid: ADMIN.systemuserid },
    target: { mapping: { logicalName: 'account' }, id: 'acc-1', row: { accountid: 'acc-1' } },
  });
  assert.equal(bound.body.Score, 7);
  assert.deepEqual(bound.body.Labels, ['x']);
  assert.equal(seen[0].target.logicalName, 'account');
  assert.equal(seen[0].target.id, 'acc-1');
  assert.equal(seen[0].caller.systemuserid, ADMIN.systemuserid);
  assert.deepEqual((await call('sample_Echo', { method: 'POST', body: {} })).body, {
    '@odata.context': ECHO_ROW,
    Reply: 'hello',
    Count: 0,
    Flag: false,
    Note: 'n',
    Stamp: ZERO_TIME,
    Key: ZERO_GUID,
  });
});

const SUBERROR = 'Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode';
const PLUGIN_TYPE = 'Sample.Plugins.Echo';

test('a plug-in fault is a 400 0x80040265 with its message; a named errorCode is the SubErrorCode, not the top-level code', async () => {
  const handlers = handlersOf({
    sample_Echo: (ctx) => {
      if (ctx.inputs.Text === 'fault')
        throw { pluginFault: 'InvalidPluginExecutionException', message: 'Sample refusal' };
      if (ctx.inputs.Text === 'coded')
        throw { pluginFault: 'InvalidPluginExecutionException', message: 'Sample coded', errorCode: '0x8004F001' };
      return { outputs: {} };
    },
  });
  const { call } = harness([...FILES, ...ECHO], { handlers });
  await assert.rejects(
    call('sample_Echo', { method: 'POST', body: { Text: 'fault' } }),
    (e) =>
      e.status === 400 &&
      e.message === 'Sample refusal' &&
      e.details.innerCode === '0x80040265' &&
      e.details.cdsAnnotations[SUBERROR] === '-2146233088',
  );
  await assert.rejects(
    call('sample_Echo', { method: 'POST', body: { Text: 'coded' } }),
    (e) =>
      e.message === 'Sample coded' &&
      e.details.innerCode === '0x80040265' &&
      e.details.cdsAnnotations[SUBERROR] === '-2147160063',
  );
});

test('a plug-in fault answers the native body: plug-in annotations and the trace, only when Prefer asks for annotations', async () => {
  const handlers = handlersOf({
    sample_Echo: {
      pluginType: PLUGIN_TYPE,
      handler: (ctx) => {
        ctx.trace('Sample trace: coded');
        throw { pluginFault: 'InvalidPluginExecutionException', message: 'Sample coded', errorCode: '0x8004F001' };
      },
    },
  });
  const { call } = harness([...FILES, ...ECHO], { handlers });
  const error = await call('sample_Echo', { method: 'POST', body: {} }).catch((e) => e);
  const annotated = dataverseError(error, { prefer: parsePrefer('odata.include-annotations="*"') }).body.error;
  const { '@Microsoft.PowerApps.CDS.TraceText': traceText, ...rest } = annotated;
  assert.match(
    traceText,
    /^\r\n\[Sample\.Plugins: Sample\.Plugins\.Echo\]\r\n\[[0-9a-f-]{36}: CustomApi 'sample_Echo' implementation\]\r\n\r\n\t\r\n\tSample trace: coded\r\n\t\r\n$/,
  );
  assert.deepEqual(rest, {
    code: '0x80040265',
    message: 'Sample coded',
    '@Microsoft.PowerApps.CDS.ErrorDetails.OperationStatus': '0',
    '@Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode': '-2147160063',
    '@Microsoft.PowerApps.CDS.ErrorDetails.Plugin.ExceptionFromPluginExecute': PLUGIN_TYPE,
    '@Microsoft.PowerApps.CDS.ErrorDetails.Plugin.ExceptionRetriable': 'False',
    '@Microsoft.PowerApps.CDS.ErrorDetails.Plugin.ExceptionSource': 'PluginExecution',
    '@Microsoft.PowerApps.CDS.ErrorDetails.Plugin.OriginalException': 'PluginExecution',
    '@Microsoft.PowerApps.CDS.ErrorDetails.Plugin.PluginTrace': 'Sample trace: coded',
    '@Microsoft.PowerApps.CDS.HelpLink':
      'http://go.microsoft.com/fwlink/?LinkID=398563&error=Microsoft.Crm.CrmException%3a80040265&client=platform',
    '@Microsoft.PowerApps.CDS.InnerError.Message': 'Sample coded',
  });
  // Without Prefer the body carries no annotations.
  assert.deepEqual(dataverseError(error, {}).body.error, { code: '0x80040265', message: 'Sample coded' });
});

test('any other throw is unhandled: a 400 0x80040224 with the error message', async () => {
  const { call } = harness([...FILES, ...ECHO], {
    handlers: handlersOf({
      sample_Echo: () => {
        throw new Error('Sample crash');
      },
    }),
  });
  await assert.rejects(
    call('sample_Echo', { method: 'POST', body: {} }),
    (e) => e.status === 400 && e.message === 'Sample crash' && e.details.innerCode === '0x80040224',
  );
});

test('a handler past the plug-in limit is a 400 0x80040224 timeout naming the plug-in type, and its writes roll back', async () => {
  const handlers = handlersOf({
    sample_Echo: {
      pluginType: PLUGIN_TYPE,
      handler: async (ctx) => {
        const rows = ctx.api.store.state.tables.customapiresponseproperty;
        await ctx.api.store.transact(() => rows.push({ customapiresponsepropertyid: 'sample-slow-row' }));
        return new Promise(() => {}); // never settles: the limit ends it
      },
    },
  });
  const { call, store } = harness([...FILES, ...ECHO], { handlers, timeoutMs: 20 });
  const before = store.state.tables.customapiresponseproperty.length;
  await assert.rejects(
    call('sample_Echo', { method: 'POST', body: {} }),
    (e) =>
      e.status === 400 &&
      e.details.innerCode === '0x80040224' &&
      e.message.includes(
        `${PLUGIN_TYPE}: System.TimeoutException: Couldn’t complete execution of the ${PLUGIN_TYPE} plug-in within the 0.02-second limit`,
      ),
  );
  assert.equal(store.state.tables.customapiresponseproperty.length, before);
});

test('a timeout names the custom API when the pack names no plug-in type', async () => {
  const { call } = harness([...FILES, ...ECHO], {
    handlers: handlersOf({ sample_Echo: () => new Promise(() => {}) }),
    timeoutMs: 20,
  });
  await assert.rejects(call('sample_Echo', { method: 'POST', body: {} }), (e) =>
    e.message.includes('sample_Echo: System.TimeoutException'),
  );
});

test('customApiHandlers keys handlers by lowercase unique name, takes a bare function or { handler, pluginType }, and rejects a bad entry or a duplicate', () => {
  const handlers = customApiHandlers([
    {
      id: 'a',
      customApis: { Sample_Echo: () => ({}), Sample_Other: { handler: () => ({}), pluginType: PLUGIN_TYPE } },
    },
    { id: 'b' },
  ]);
  assert.equal(handlers.size, 2);
  assert.equal(typeof handlers.get('sample_echo').handler, 'function');
  assert.equal(handlers.get('sample_echo').pluginType, null);
  assert.equal(handlers.get('sample_other').pluginType, PLUGIN_TYPE);
  assert.throws(() => customApiHandlers([{ id: 'a', customApis: { x_Echo: 1 } }]), /invalid customApis handler/);
  assert.throws(
    () => customApiHandlers([{ id: 'a', customApis: { x_Echo: { handler: () => ({}), pluginType: ' ' } } }]),
    /pluginType for x_Echo/,
  );
  assert.throws(
    () =>
      customApiHandlers([
        { id: 'a', customApis: { sample_Echo: () => ({}) } },
        { id: 'b', customApis: { SAMPLE_ECHO: () => ({}) } },
      ]),
    /Ambiguous/,
  );
});

test('the plug-in limit is read per call: a limit raised while the simulator runs lets a slow handler finish', async () => {
  let limit = 20;
  const handlers = handlersOf({ sample_Echo: () => new Promise((resolve) => setTimeout(() => resolve({}), 60)) });
  const { call } = harness([...FILES, ...ECHO], { handlers, timeoutMs: () => limit });
  await assert.rejects(call('sample_Echo', { method: 'POST', body: {} }), (e) =>
    e.message.includes('sample_Echo: System.TimeoutException'),
  );
  limit = 1000;
  await assert.doesNotReject(call('sample_Echo', { method: 'POST', body: {} }));
});
