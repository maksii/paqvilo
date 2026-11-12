// @test-kind unproven: local model of business process flow instances and messages; no native capture cited
// Business process flows (lib/dataverse-bpf.mjs): category-4 inventory, instance rows through createInstance, the existing BPF
// messages and the SetProcess 501 with its pack override.
import test from 'node:test';
import assert from 'node:assert/strict';
import { EXTENSION, createInstance } from '../lib/dataverse-bpf.mjs';
import { addonHandlers } from '../lib/dataverse-addon-common.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { webApiCall } from './support/dataverse-fixtures.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const FLOW_OK = '88888888-8888-4888-8888-888888888801';
const FLOW_BAD = '88888888-8888-4888-8888-888888888802';
const STAGE_ONE = '88888888-8888-4888-8888-888888888811';
const STAGE_TWO = '88888888-8888-4888-8888-888888888812';
const ORDER = '88888888-8888-4888-8888-888888888821';

const ORDER_MAPPING = {
  logicalName: 'x_order',
  entitySet: 'x_orders',
  idColumn: 'x_orderid',
  nameColumn: 'x_name',
  fields: { x_name: { dataverseType: 'nvarchar' } },
};
const INSTANCE_MAPPING = {
  x_orderflow: {
    logicalName: 'x_orderflow',
    entitySet: 'x_orderflows',
    idColumn: 'x_orderflowid',
    fields: { x_orderflowid: { dataverseType: 'uniqueidentifier' }, processid: { dataverseType: 'uniqueidentifier' } },
  },
};
const MAPPINGS = { x_order: ORDER_MAPPING };
const TABLES = {
  x_order: [{ x_orderid: ORDER, x_name: 'Invented order' }],
  workflow: [
    // A parseable flow: the stages come from clientdata JSON; the second stage names no entity, so it takes the primary entity.
    {
      workflowid: FLOW_OK,
      name: 'Invented order flow',
      category: 4,
      type: 1,
      statecode: 1,
      statuscode: 2,
      primaryentity: 'x_order',
      uniquename: 'x_orderflow',
      clientdata: JSON.stringify({
        stages: [
          { stageid: STAGE_ONE, stagename: 'Qualify', entityname: 'x_order' },
          { stageid: STAGE_TWO, stagename: 'Close' },
        ],
      }),
    },
    // An unparsed flow: its XAML stage names no id, so there is no simple stage list.
    {
      workflowid: FLOW_BAD,
      name: 'Invented unparsed flow',
      category: 4,
      type: 1,
      statecode: 1,
      statuscode: 2,
      primaryentity: 'x_order',
      uniquename: 'x_badflow',
      xaml: '<Stages><stage stagename="Only a name"/></Stages>',
    },
    // A classic workflow (category 0) is not a flow.
    {
      workflowid: '88888888-8888-4888-8888-888888888803',
      name: 'Invented classic',
      category: 0,
      type: 1,
      statecode: 1,
      primaryentity: 'x_order',
    },
  ],
};

// The fixture returns the HTTP handle; the internal api that the module installs on is captured here, through a wrapper of install.
async function setup(t, { mappings = MAPPINGS, options = {} } = {}) {
  const diagnostics = [];
  const captured = {};
  const extension = {
    ...EXTENSION,
    install: (api, opts) => {
      captured.api = api;
      return EXTENSION.install(api, opts);
    },
  };
  const { store, request, json } = await contractModuleFixture(t, {
    mappings,
    tables: TABLES,
    extension,
    options: { diagnostic: (entry) => diagnostics.push(entry), ...options },
  });
  return { api: captured.api, store, request, json, diagnostics };
}

test('the inventory lists category-4 flows with their stages and reports the unparsed flow once', async (t) => {
  const { api, diagnostics } = await setup(t);
  const flows = api.businessProcessFlows.list();
  assert.deepEqual(
    flows.map((flow) => flow.workflowid),
    [FLOW_OK, FLOW_BAD],
  );
  assert.deepEqual(flows[0], {
    workflowid: FLOW_OK,
    name: 'Invented order flow',
    uniquename: 'x_orderflow',
    primaryentity: 'x_order',
    stages: [
      { id: STAGE_ONE, name: 'Qualify', entity: 'x_order' },
      { id: STAGE_TWO, name: 'Close', entity: 'x_order' },
    ],
  });
  assert.deepEqual(flows[1].stages, []);
  assert.deepEqual(
    api.businessProcessFlows.for('x_order').map((flow) => flow.workflowid),
    [FLOW_OK, FLOW_BAD],
  );
  assert.deepEqual(api.businessProcessFlows.for('x_other'), []);
  api.businessProcessFlows.list();
  const unparsed = api.businessProcessFlows.diagnostics().filter((entry) => entry.code === 'BPF_DEFINITION_UNPARSED');
  assert.equal(unparsed.length, 1);
  assert.equal(unparsed[0].workflowId, FLOW_BAD);
  assert.equal(diagnostics.filter((entry) => entry.code === 'BPF_DEFINITION_UNPARSED').length, 1);
});

test('createInstance writes the instance at the first stage when the instance table exists, and the existing message lists it', async (t) => {
  const { api, store, request, json } = await setup(t, { mappings: { ...MAPPINGS, ...INSTANCE_MAPPING } });
  const first = await createInstance(api, FLOW_OK, ORDER);
  const second = await createInstance(api, FLOW_OK, ORDER);
  assert.notEqual(first.x_orderflowid, second.x_orderflowid);
  const rows = store.state.tables.x_orderflow;
  assert.equal(rows.length, 2);
  // The instance runs the record pipeline: it carries the audit stamps (SYSTEM, since a flow starts it) and the version.
  const {
    createdon,
    modifiedon,
    createdby,
    modifiedby,
    createdonbehalfby,
    modifiedonbehalfby,
    ownerid,
    owninguser,
    owningteam,
    owningbusinessunit,
    organizationid,
    versionnumber,
    statecode,
    statuscode,
    ...stored
  } = rows[0];
  assert.equal(typeof createdon, 'string', 'the pipeline stamps the row');
  assert.equal(modifiedon, createdon);
  assert.equal(createdby?.name, 'SYSTEM');
  assert.equal(organizationid?.logical_name, 'organization', 'an organization-owned instance records its organization');
  assert.deepEqual(stored, {
    x_orderflowid: first.x_orderflowid,
    businessprocessflowinstanceid: first.x_orderflowid,
    processid: FLOW_OK,
    activestageid: STAGE_ONE,
    traversedpath: STAGE_ONE,
    bpf_x_orderid: ORDER,
  });
  const listed = await json(
    await request('GET', `/RetrieveProcessInstances(EntityId=${ORDER},EntityLogicalName='x_order')`),
    200,
  );
  assert.deepEqual(
    listed.value.map((row) => row.x_orderflowid).sort(),
    [first.x_orderflowid, second.x_orderflowid].sort(),
  );
  assert.equal(listed.value[0].processstageid, STAGE_ONE);
});

test('createInstance without the instance table reports BPF_INSTANCE_TABLE_MISSING once and creates nothing', async (t) => {
  const { api, store, diagnostics } = await setup(t);
  assert.equal(await createInstance(api, FLOW_OK, ORDER), null);
  assert.equal(await createInstance(api, FLOW_OK, ORDER), null);
  assert.equal(store.state.tables.x_orderflow, undefined);
  assert.equal(diagnostics.filter((entry) => entry.code === 'BPF_INSTANCE_TABLE_MISSING').length, 1);
});

test('createInstance refuses an unparsed, inactive or unknown flow with its diagnostic and creates nothing', async (t) => {
  const { api, store, diagnostics } = await setup(t, { mappings: { ...MAPPINGS, ...INSTANCE_MAPPING } });
  assert.equal(await createInstance(api, FLOW_BAD, ORDER), null);
  store.state.tables.workflow.find((row) => row.workflowid === FLOW_OK).statecode = 0;
  assert.equal(await createInstance(api, FLOW_OK, ORDER), null);
  assert.equal(await createInstance(api, '88888888-8888-4888-8888-888888888899', ORDER), null);
  assert.equal(store.state.tables.x_orderflow, undefined);
  for (const code of ['BPF_DEFINITION_UNPARSED', 'BPF_DEFINITION_NOT_ACTIVE', 'BPF_DEFINITION_MISSING']) {
    assert.equal(diagnostics.filter((entry) => entry.code === code).length, 1, code);
  }
  await assert.rejects(createInstance(api, FLOW_OK, 'not-a-guid'), /GUID/);
});

test('SetProcess, which no BPF module here registers, answers 501 0x80040216; a pack dataverseMessages handler replaces it', async (t) => {
  const { api, request, json } = await setup(t);
  const response = await request('POST', '/SetProcess', {});
  assert.equal(response.status, 501);
  assert.match(await response.text(), /0x80040216/);
  api.addonHandlers = addonHandlers([
    { id: 'invented-pack', dataverseMessages: { SetProcess: async () => ({ Replaced: true }) } },
  ]);
  const replaced = await json(await request('POST', '/SetProcess', {}), 200);
  assert.equal(replaced.Replaced, true);
});

test('describe is contract with the two operations and their levels; the module registers no message', async (t) => {
  const { api } = await setup(t);
  const record = EXTENSION.describe();
  assert.equal(record.level, 'contract');
  assert.deepEqual(record.operations, ['BusinessProcessFlowInventory', 'BusinessProcessFlowInstance']);
  assert.deepEqual(record.operationLevels, {
    BusinessProcessFlowInventory: 'inventory',
    BusinessProcessFlowInstance: 'contract',
  });
  assert.deepEqual(record.requires, ['workflow:category=4']);
  assert.equal(api.registry.has('BusinessProcessFlowInventory'), false);
});

test('createInstance awaited inside an open store transaction joins it and rolls back when the outer write throws', async (t) => {
  const { api, store } = await setup(t, { mappings: { ...MAPPINGS, ...INSTANCE_MAPPING } });
  let created = null;
  await assert.rejects(
    store.transact(async () => {
      created = await createInstance(api, FLOW_OK, ORDER);
      assert.equal(store.state.tables.x_orderflow.length, 1, 'the row is visible inside the transaction');
      throw new Error('Invented outer failure');
    }),
    /Invented outer failure/,
  );
  assert.equal(created.processid, FLOW_OK);
  assert.equal(store.state.tables.x_orderflow?.length ?? 0, 0);
});

// @test-kind unproven: local stage-move model; assumes 0x80040203 and a comma-separated traversedpath, no native capture
test('a PATCH moves an instance only to a stage of its process, and each move keeps traversedpath', async (t) => {
  const instanceFields = {
    ...INSTANCE_MAPPING.x_orderflow.fields,
    activestageid: { dataverseType: 'uniqueidentifier' },
    traversedpath: { dataverseType: 'nvarchar' },
  };
  const mappings = { ...MAPPINGS, x_orderflow: { ...INSTANCE_MAPPING.x_orderflow, fields: instanceFields } };
  const { api, store, request } = await setup(t, { mappings });
  const OTHER_FLOW = '88888888-8888-4888-8888-888888888804';
  const OTHER_STAGE = '88888888-8888-4888-8888-888888888813';
  store.state.tables.workflow.push({
    workflowid: OTHER_FLOW,
    name: 'Invented other flow',
    category: 4,
    type: 1,
    statecode: 1,
    statuscode: 2,
    primaryentity: 'x_order',
    uniquename: 'x_otherflow',
    clientdata: JSON.stringify({ stages: [{ stageid: OTHER_STAGE, stagename: 'Elsewhere' }] }),
  });
  const instance = await createInstance(api, FLOW_OK, ORDER);
  const path = `/x_orderflows(${instance.x_orderflowid})`;
  const stored = () => store.state.tables.x_orderflow.find((row) => row.x_orderflowid === instance.x_orderflowid);
  for (const stage of [OTHER_STAGE, '88888888-8888-4888-8888-888888888899']) {
    const refused = await request('PATCH', path, { activestageid: stage });
    const text = await refused.text();
    assert.equal(refused.status, 400, text);
    assert.match(text, /0x80040203/);
  }
  assert.equal(stored().activestageid, STAGE_ONE);
  assert.equal(stored().traversedpath, STAGE_ONE);
  assert.ok((await request('PATCH', path, { activestageid: STAGE_TWO })).ok);
  assert.equal(stored().activestageid, STAGE_TWO);
  assert.equal(stored().traversedpath, `${STAGE_ONE},${STAGE_TWO}`);
  assert.ok((await request('PATCH', path, { activestageid: STAGE_ONE })).ok);
  assert.equal(stored().activestageid, STAGE_ONE);
  assert.equal(stored().traversedpath, STAGE_ONE);
});

// ---- Row checks of the process messages (DV3b-4), through the Web API as an admin application and as a Basic User application.

const ADMIN_APP = '11111111-1111-4111-8111-111111111111';
const BASIC_APP = '12121212-1212-4121-8121-121212121212';
const ADMIN_SECRET = 'PAQVILO_BPF_ADMIN_SECRET';
const BASIC_SECRET = 'PAQVILO_BPF_BASIC_SECRET';
const ACCOUNT_FLOW = '88888888-8888-4888-8888-888888888831';
const ACCOUNT_STAGE = '88888888-8888-4888-8888-888888888841';
const ACCOUNT_INSTANCE = '77777777-7777-4777-8777-777777777731';
const BASIC_INSTANCE = '77777777-7777-4777-8777-777777777732';
// An ownerid column makes the instance table user-owned, so a Basic User reads its own instance rows only.
const ACCOUNT_FLOW_MAPPINGS = {
  x_acctflow: {
    logicalName: 'x_acctflow',
    entitySet: 'x_acctflows',
    idColumn: 'x_acctflowid',
    fields: {
      x_acctflowid: { dataverseType: 'uniqueidentifier' },
      ownerid: { dataverseType: 'uniqueidentifier' },
      processid: { dataverseType: 'uniqueidentifier' },
      activestageid: { dataverseType: 'uniqueidentifier' },
      traversedpath: { dataverseType: 'nvarchar' },
      bpf_accountid: { dataverseType: 'uniqueidentifier' },
    },
  },
};
const ACCOUNT_FLOW_TABLES = {
  workflow: [
    {
      workflowid: ACCOUNT_FLOW,
      name: 'Invented account flow',
      category: 4,
      type: 1,
      statecode: 1,
      statuscode: 2,
      primaryentity: 'account',
      uniquename: 'x_acctflow',
    },
  ],
  processstage: [{ processstageid: ACCOUNT_STAGE, processid: ACCOUNT_FLOW, stagename: 'Qualify' }],
};

async function bearer(server, appId, secret) {
  const response = await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: secret,
      scope: `${server.origin}/.default`,
    }),
  });
  return (await response.json()).access_token;
}

// The Web API of one organization with two applications: the admin (System Administrator) and a Basic User.
async function secureApi(t, { mappings = {}, tables = {} } = {}) {
  process.env[ADMIN_SECRET] = 'bpf-admin-secret';
  process.env[BASIC_SECRET] = 'bpf-basic-secret';
  t.after(() => {
    delete process.env[ADMIN_SECRET];
    delete process.env[BASIC_SECRET];
  });
  const state = emptyState();
  Object.assign(state.mappings, structuredClone(mappings));
  for (const [logical, rows] of Object.entries(tables)) state.tables[logical] = structuredClone(rows);
  const store = await new DataStore({ state }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [
      {
        appId: ADMIN_APP,
        displayName: 'BPF admin app',
        secretEnvironmentVariable: ADMIN_SECRET,
        roles: ['System Administrator'],
      },
      {
        appId: BASIC_APP,
        displayName: 'BPF basic app',
        secretEnvironmentVariable: BASIC_SECRET,
        roles: ['Basic User'],
      },
    ],
  });
  const server = await startDataverseApi({ store, settings, log: () => {} });
  t.after(() => server.close());
  const tokens = {
    admin: await bearer(server, ADMIN_APP, 'bpf-admin-secret'),
    basic: await bearer(server, BASIC_APP, 'bpf-basic-secret'),
  };
  const request = async (who, method, path, body) => {
    const headers = {
      authorization: `Bearer ${tokens[who]}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json', prefer: 'return=representation' }),
    };
    return webApiCall(server.origin, 'v9.2', method, path, headers, body);
  };
  return { store, request };
}

// Creates a row as the given application and returns the row it answers with; the status must be a creation.
async function created(request, who, path, body) {
  const response = await request(who, 'POST', path, body);
  assert.equal(response.status, 201, response.text);
  return response.json;
}

// @test-kind security: DV3b-4 RetrieveProcessInstances refuses an account the caller cannot read, with the Web API 403 of that account
test('RetrieveProcessInstances refuses an admin-owned account to a Basic User, as the Web API does', async (t) => {
  const { request } = await secureApi(t, { mappings: ACCOUNT_FLOW_MAPPINGS, tables: ACCOUNT_FLOW_TABLES });
  const accountId = (await created(request, 'admin', 'accounts', { name: 'Admin account' })).accountid;
  const instanceId = ACCOUNT_INSTANCE;
  await created(request, 'admin', 'x_acctflows', {
    x_acctflowid: instanceId,
    processid: ACCOUNT_FLOW,
    activestageid: ACCOUNT_STAGE,
    traversedpath: ACCOUNT_STAGE,
    bpf_accountid: accountId,
  });
  const direct = await request('basic', 'GET', `accounts(${accountId})?$select=name`);
  assert.equal(direct.status, 403, direct.text);
  const refused = await request(
    'basic',
    'GET',
    `RetrieveProcessInstances(EntityId=${accountId},EntityLogicalName='account')`,
  );
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json.error.code, direct.json.error.code);
  assert.doesNotMatch(refused.text, new RegExp(instanceId));
});

// @test-kind security: DV3b-4 RetrieveProcessInstances answers an admin with the instances of an account and their stage
test('RetrieveProcessInstances answers an admin with the instance rows and the stage of each', async (t) => {
  const { request } = await secureApi(t, { mappings: ACCOUNT_FLOW_MAPPINGS, tables: ACCOUNT_FLOW_TABLES });
  const accountId = (await created(request, 'admin', 'accounts', { name: 'Admin account' })).accountid;
  const instanceId = ACCOUNT_INSTANCE;
  await created(request, 'admin', 'x_acctflows', {
    x_acctflowid: instanceId,
    processid: ACCOUNT_FLOW,
    activestageid: ACCOUNT_STAGE,
    traversedpath: ACCOUNT_STAGE,
    bpf_accountid: accountId,
  });
  const listed = await request(
    'admin',
    'GET',
    `RetrieveProcessInstances(EntityId=${accountId},EntityLogicalName='account')`,
  );
  assert.equal(listed.status, 200, listed.text);
  assert.equal(listed.json.value.length, 1);
  assert.equal(listed.json.value[0].x_acctflowid, instanceId);
  assert.equal(listed.json.value[0].processstageid, ACCOUNT_STAGE);
});

// @test-kind security: DV3b-4 RetrieveProcessInstances on the caller's own account returns only the instance rows the read filter passes
test('RetrieveProcessInstances on the caller own account omits an instance row that the caller cannot read', async (t) => {
  const { request } = await secureApi(t, { mappings: ACCOUNT_FLOW_MAPPINGS, tables: ACCOUNT_FLOW_TABLES });
  const ownAccount = (await created(request, 'basic', 'accounts', { name: 'Basic account' })).accountid;
  await created(request, 'admin', 'x_acctflows', {
    x_acctflowid: ACCOUNT_INSTANCE,
    processid: ACCOUNT_FLOW,
    activestageid: ACCOUNT_STAGE,
    traversedpath: ACCOUNT_STAGE,
    bpf_accountid: ownAccount,
  });
  await created(request, 'basic', 'x_acctflows', {
    x_acctflowid: BASIC_INSTANCE,
    processid: ACCOUNT_FLOW,
    activestageid: ACCOUNT_STAGE,
    traversedpath: ACCOUNT_STAGE,
    bpf_accountid: ownAccount,
  });
  const listed = await request(
    'basic',
    'GET',
    `RetrieveProcessInstances(EntityId=${ownAccount},EntityLogicalName='account')`,
  );
  assert.equal(listed.status, 200, listed.text);
  assert.deepEqual(
    listed.json.value.map((row) => row.x_acctflowid),
    [BASIC_INSTANCE],
  );
  assert.doesNotMatch(listed.text, new RegExp(ACCOUNT_INSTANCE));
});

// @test-kind security: DV3b-4 RetrieveActivePath refuses an instance the caller cannot read, with the Web API 403 of that instance
test('RetrieveActivePath refuses an admin-owned instance to a Basic User, as the Web API does', async (t) => {
  const { request } = await secureApi(t, { mappings: ACCOUNT_FLOW_MAPPINGS, tables: ACCOUNT_FLOW_TABLES });
  const accountId = (await created(request, 'admin', 'accounts', { name: 'Admin account' })).accountid;
  const instanceId = ACCOUNT_INSTANCE;
  await created(request, 'admin', 'x_acctflows', {
    x_acctflowid: instanceId,
    processid: ACCOUNT_FLOW,
    activestageid: ACCOUNT_STAGE,
    traversedpath: ACCOUNT_STAGE,
    bpf_accountid: accountId,
  });
  const direct = await request('basic', 'GET', `x_acctflows(${instanceId})?$select=activestageid`);
  assert.equal(direct.status, 403, direct.text);
  const refused = await request('basic', 'GET', `RetrieveActivePath(ProcessInstanceId=${instanceId})`);
  assert.equal(refused.status, 403, refused.text);
  assert.equal(refused.json.error.code, direct.json.error.code);
  assert.doesNotMatch(refused.text, /Qualify/);
});

// @test-kind security: DV3b-4 RetrieveActivePath answers an admin with the stages of the instance's flow
test('RetrieveActivePath answers an admin with the stages of the flow', async (t) => {
  const { request } = await secureApi(t, { mappings: ACCOUNT_FLOW_MAPPINGS, tables: ACCOUNT_FLOW_TABLES });
  const accountId = (await created(request, 'admin', 'accounts', { name: 'Admin account' })).accountid;
  const instanceId = ACCOUNT_INSTANCE;
  await created(request, 'admin', 'x_acctflows', {
    x_acctflowid: instanceId,
    processid: ACCOUNT_FLOW,
    activestageid: ACCOUNT_STAGE,
    traversedpath: ACCOUNT_STAGE,
    bpf_accountid: accountId,
  });
  const path = await request('admin', 'GET', `RetrieveActivePath(ProcessInstanceId=${instanceId})`);
  assert.equal(path.status, 200, path.text);
  assert.equal(path.json.value[0].processstageid, ACCOUNT_STAGE);
  assert.equal(path.json.value[0].stagename, 'Qualify');
});

test('a stage XAML nested deeper than 64 elements is unparsed, not a stack overflow', async (t) => {
  const deep = `${'<Step>'.repeat(10000)}<stage stageid="${STAGE_ONE}" stagename="Deep"/>${'</Step>'.repeat(10000)}`;
  const { api, diagnostics } = await setup(t);
  api.store.state.tables.workflow.find((row) => row.workflowid === FLOW_BAD).xaml = deep;
  assert.deepEqual(api.businessProcessFlows.list().find((flow) => flow.workflowid === FLOW_BAD).stages, []);
  assert.equal(
    diagnostics.filter((entry) => entry.code === 'BPF_DEFINITION_UNPARSED' && entry.workflowId === FLOW_BAD).length,
    1,
  );
});
