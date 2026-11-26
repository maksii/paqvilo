// @test-kind unproven: local model of classic workflows and ExecuteWorkflow runs; no native capture cited
// Workflows in the Dataverse API: seeded workflow rows from Solution sources, activation on PATCH, ExecuteWorkflow (background
// and real-time, classic and cloud), the documented refusals, and the trusted classic handler contract.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { hashSecret } from '../lib/dataverse-auth.mjs';
import { uuidV5 } from '../lib/dataverse-security.mjs';
import {
  readSolutionWorkflows,
  workflowExtension,
  workflowHandlers,
  workflowsWithActivation,
} from '../lib/dataverse-workflows.mjs';
import { organizationPrincipalContext } from '../lib/dataverse-principal-context.mjs';
import { createSimulator } from '../server.mjs';
import { settleCommittedWork } from '../lib/committed-work.mjs';
import { createTraceStore } from '../lib/trace-store.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { reloadDuringHandler } from './support/source-refresh-gate.mjs';
import { startListWorkflowSimulator } from './support/list-workflow-fixture.mjs';
import { bearerCall } from './support/web-api.mjs';

const APP_ID = '22222222-2222-2222-2222-222222222222';
const PUBLIC_APP_ID = '44444444-4444-4444-4444-444444444444';
const SECRET_VAR = 'PAQVILO_WORKFLOWS_SECRET';
const PASSWORD = 'Pass!23';
const BASIC_OID = '66666666-6666-6666-6666-666666666666';
const NONE_OID = '77777777-7777-7777-7777-777777777777';
const WIDGET = 'aaaaaaaa-0000-0000-0000-000000000011';
const WF = (n) => `bbbbbbbb-0000-0000-0000-0000000001${String(n).padStart(2, '0')}`;
const CRM = 'Microsoft.Dynamics.CRM.';

// Definitions of the cloud flows: an on-demand Dataverse trigger, and a request (powerpages) trigger.
const DATAVERSE_FLOW = {
  triggers: {
    row: {
      type: 'OpenApiConnectionWebhook',
      inputs: {
        host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'SubscribeWebhookTrigger' },
        parameters: {
          'subscriptionRequest/message': 1,
          'subscriptionRequest/entityname': 'contoso_widget',
          'subscriptionRequest/scope': 4,
        },
      },
    },
  },
  actions: {},
};
const REQUEST_FLOW = {
  triggers: { manual: { type: 'Request', kind: 'powerpages', inputs: { schema: { type: 'object', properties: {} } } } },
  actions: {},
};

// A workflow fact as readSolutionWorkflows returns it.
function fact(id, overrides = {}) {
  return {
    id,
    name: `Invented ${id.slice(-2)}`,
    uniquename: null,
    category: 0,
    type: 1,
    mode: 0,
    scope: 4,
    ondemand: true,
    subprocess: false,
    triggeroncreate: false,
    triggerondelete: false,
    triggeronupdateattributelist: null,
    primaryentity: 'contoso_widget',
    state: 1,
    runas: 0,
    istransacted: true,
    asyncautodelete: false,
    syncworkflowlogonfailure: false,
    xaml: '<Activity />',
    clientdata: null,
    ...overrides,
  };
}

const FACTS = [
  fact(WF(1)), // activated, on-demand, handler
  fact(WF(2)), // activated, on-demand, no handler: placeholder
  fact(WF(3), { state: 0, statuscode: 1 }), // draft
  fact(WF(4), { ondemand: false }), // activated, not on-demand, not a child
  fact(WF(5), { mode: 1, uniquename: 'Realtime_Invented' }), // real-time, handler keyed by unique name
  fact(WF(6), { category: 5, xaml: null, clientdata: '{}' }), // cloud flow, on-demand, dataverse trigger
  fact(WF(7), { category: 5, xaml: null, clientdata: '{}', ondemand: false }),
  fact(WF(8), { category: 5, xaml: null, clientdata: '{}' }), // cloud flow, on-demand, request trigger (not valid)
  fact(WF(9), { state: 0, ondemand: false, triggeroncreate: false }), // automatic draft with no trigger: publish refused
  fact(WF(10), { ondemand: true, state: 1 }), // activated, on-demand: toggled off and on by PATCH
  fact(WF(21), { type: 3, state: 0, ondemand: false }), // a workflow template
];
const FLOWS = { [WF(6)]: DATAVERSE_FLOW, [WF(8)]: REQUEST_FLOW, [WF(7)]: DATAVERSE_FLOW };
const DIAGNOSTICS = [];

function fixtureState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: 'contoso_widget',
    entitySet: 'contoso_widgets',
    idColumn: 'contoso_widgetid',
    nameColumn: 'name',
    userConfigured: true,
    fields: { name: { dataverseType: 'nvarchar' }, status: { dataverseType: 'int' } },
    relationships: {},
  };
  state.tables.contoso_widget = [{ contoso_widgetid: WIDGET, name: 'alpha', status: 1 }];
  return state;
}

describe('dataverse workflows: rows, activation and ExecuteWorkflow over HTTP', () => {
  let api;
  let store;
  let origin;
  let tenantId;
  let organizationId;
  let appToken;
  let noneToken;

  before(async () => {
    process.env[SECRET_VAR] = 'workflows-secret';
    store = await new DataStore({ state: fixtureState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP_ID,
          displayName: 'Workflows app',
          secretEnvironmentVariable: SECRET_VAR,
          roles: ['System Administrator'],
        },
        {
          appId: PUBLIC_APP_ID,
          displayName: 'Public app',
          publicClient: true,
          redirectUris: ['http://localhost:1/cb'],
        },
      ],
      users: [
        { domainname: 'basic@example.test', fullname: 'Basic', objectId: BASIC_OID, roles: ['Basic User'] },
        { domainname: 'none@example.test', fullname: 'None', objectId: NONE_OID, roles: [] },
      ],
    });
    const handlers = workflowHandlers([
      {
        id: 'invented-pack',
        workflows: {
          [WF(1)]: async ({ target, api: runApi, trace }) => {
            trace('handled classic');
            const row = runApi.store.state.tables.contoso_widget.find((r) => r.contoso_widgetid === target.id);
            row.status = 77;
            return { message: 'handled' };
          },
          // A real-time handler: the write is part of the request's transaction.
          Realtime_Invented: async ({ target, api: runApi }) => {
            runApi.store.state.tables.contoso_widget.find((r) => r.contoso_widgetid === target.id).status = 88;
          },
        },
      },
    ]);
    api = await startDataverseApi({
      store,
      settings,
      log: () => {},
      extensions: [
        ...EXTENSIONS,
        workflowExtension({
          facts: FACTS,
          handlers,
          cloudFlow: (id) => (FLOWS[id] ? { definition: FLOWS[id], mode: 'exported' } : null),
          diagnostic: (entry) => DIAGNOSTICS.push(entry),
        }),
      ],
    });
    origin = api.origin;
    tenantId = api.tenantId;
    organizationId = api.organizationId;
    await store.transact(() => {
      store.state.dataverse.passwords ??= {};
      for (const oid of [BASIC_OID, NONE_OID])
        store.state.dataverse.passwords[uuidV5(organizationId, `systemuser:oid:${oid}`)] = hashSecret(PASSWORD);
    });
    appToken = await clientToken();
    noneToken = await userToken('none@example.test');
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  async function clientToken() {
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: APP_ID,
        client_secret: process.env[SECRET_VAR],
        scope: `${origin}/.default`,
      }),
    });
    return (await response.json()).access_token;
  }

  async function userToken(username) {
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: PUBLIC_APP_ID,
        username,
        password: PASSWORD,
        scope: `${origin}/.default`,
      }),
    });
    return (await response.json()).access_token;
  }

  // One request. The default token is the System Administrator application.
  const call = (path, options) => bearerCall(origin, () => appToken)(path, options);
  const webApi = (suffix) => `/api/data/v9.2/${suffix}`;
  const executeOf = (id) => webApi(`workflows(${id})/${CRM}ExecuteWorkflow`);
  const widgetRef = { EntityId: WIDGET };
  const activationOf = (id) => uuidV5(organizationId, `workflow-activation:${id}`);
  const row = async (logical, id) => (await call(webApi(`${logical}(${id})`))).json();

  // An ExecuteWorkflow run is a system job on the store's scheduler (dataverse-async.mjs): settle it, then read its row once.
  async function finished(jobId) {
    await settleCommittedWork(store, []);
    const job = await row('asyncoperations', jobId);
    assert.equal(job.statecode, 3, `job ${jobId} finished`);
    return job;
  }

  async function errorOf(response) {
    assert.ok(response.status >= 400, `expected an error, got ${response.status}`);
    return (await response.json()).error;
  }

  // @test-kind contract: the workflow runner propagates a simulator source conflict unchanged; it is not a workflow failure.
  it('propagates the original source conflict of a real-time run without a log or process session', async () => {
    const realtime = WF(5);
    const definition = () => store.tableRows('workflow').find((row) => row.workflowid === realtime);
    const user = store
      .tableRows('systemuser')
      .find((row) => row.systemuserid === uuidV5(organizationId, 'systemuser:SYSTEM'));
    assert.ok(definition() && user, 'the real-time workflow and the SYSTEM user are seeded');
    await store.transact(() => {
      definition().syncworkflowlogonfailure = true;
    });
    const conflict = Object.assign(new Error('Portal sources changed while resolving this page.'), {
      status: 409,
      code: 'SourceRefreshConflict',
    });
    const counts = () => ({
      status: store.tableRows('contoso_widget').find((row) => row.contoso_widgetid === WIDGET).status,
      logs: store.tableRows('workflowlog').length,
      sessions: store.tableRows('processsession').length,
    });
    const before = counts();
    let checks = 0;
    try {
      await assert.rejects(
        api.organization.api.executePortalListWorkflow({
          workflowId: realtime,
          entity: 'contoso_widget',
          recordId: WIDGET,
          authorize: async () => null,
          principal: async () => organizationPrincipalContext(store, user),
          // The check after the handler ran (attempt's second verify) reports the overlapping publication.
          verify: () => {
            if (++checks === 2) throw conflict;
          },
        }),
        (error) => error === conflict && error.status === 409 && error.code === 'SourceRefreshConflict',
      );
    } finally {
      await store.transact(() => {
        definition().syncworkflowlogonfailure = false;
      });
    }
    assert.equal(checks, 2, 'the handler ran before the conflict');
    assert.deepEqual(counts(), before);
  });

  it('seeds each Solution workflow as a row, and each activated one with its activation row', async () => {
    const definition = await row('workflows', WF(1));
    assert.equal(definition.name, 'Invented 01');
    assert.equal(definition.category, 0);
    assert.equal(definition.type, 1);
    assert.equal(definition.statecode, 1);
    assert.equal(definition.statuscode, 2);
    assert.equal(definition.ondemand, true);
    assert.equal(definition.primaryentity, 'contoso_widget');
    assert.equal(definition._activeworkflowid_value, activationOf(WF(1)));
    const activation = await row('workflows', activationOf(WF(1)));
    assert.equal(activation.type, 2);
    assert.equal(activation._parentworkflowid_value, WF(1));
    const cloud = await row('workflows', WF(6));
    assert.equal(cloud.category, 5);
    assert.equal(cloud.clientdata, '{}');
    const draft = await row('workflows', WF(3));
    assert.equal(draft.statecode, 0);
    assert.equal(draft._activeworkflowid_value, null);
  });

  it('answers an unknown workflow id with the native workflow message', async () => {
    const error = await errorOf(
      await call(executeOf('cccccccc-0000-0000-0000-000000000001'), { method: 'POST', body: widgetRef }),
    );
    assert.equal(error.code, '0x8006040b');
  });

  it('refuses a draft classic workflow, a classic workflow that is not on-demand and a call without EntityId', async () => {
    assert.equal((await errorOf(await call(executeOf(WF(3)), { method: 'POST', body: widgetRef }))).code, '0x80045047');
    assert.equal((await errorOf(await call(executeOf(WF(4)), { method: 'POST', body: widgetRef }))).code, '0x80045046');
    const missing = await errorOf(await call(executeOf(WF(1)), { method: 'POST', body: {} }));
    assert.match(missing.message, /EntityId is required/);
  });

  it('refuses a cloud flow that is not on-demand, and one whose trigger is not a Dataverse trigger, naming the flow', async () => {
    const notOnDemand = await errorOf(await call(executeOf(WF(7)), { method: 'POST', body: widgetRef }));
    assert.equal(notOnDemand.code, '0x80060479');
    assert.ok(notOnDemand.message.includes("'Invented 07'"));
    const request = await errorOf(await call(executeOf(WF(8)), { method: 'POST', body: widgetRef }));
    assert.equal(request.code, '0x80060476');
    assert.ok(request.message.includes('Invented 08'));
  });

  it('answers a call with no namespace prefix with the unresolved-parameters message', async () => {
    const response = await call(webApi(`workflows(${WF(1)})/ExecuteWorkflow`), { method: 'POST', body: widgetRef });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, /unresolved parameters/);
  });

  it('starts a background run of an activated on-demand classic workflow: an asyncoperation of type 10 that a handler completes', async () => {
    const response = await call(executeOf(WF(1)), { method: 'POST', body: widgetRef });
    assert.equal(response.status, 200, await response.clone().text());
    const { asyncoperationid } = await response.json();
    const job = await finished(asyncoperationid);
    assert.equal(job.operationtype, 10);
    assert.equal(job.statuscode, 30);
    assert.equal(job.message, 'handled');
    assert.equal(job._regardingobjectid_value, WIDGET);
    assert.equal(job._workflowactivationid_value, activationOf(WF(1)));
    assert.equal(store.tableRows('contoso_widget')[0].status, 77);
    const logs = store.tableRows('workflowlog').filter((log) => log.asyncoperationid?.id === asyncoperationid);
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 2);
  });

  it('ends a background run of a classic workflow with no handler as Canceled, with the placeholder message', async () => {
    DIAGNOSTICS.length = 0;
    const { asyncoperationid } = await (await call(executeOf(WF(2)), { method: 'POST', body: widgetRef })).json();
    const job = await finished(asyncoperationid);
    assert.equal(job.statuscode, 32);
    assert.match(job.message, /classic workflow XAML is not executed/);
    assert.ok(DIAGNOSTICS.some((entry) => entry.code === 'WORKFLOW_PLACEHOLDER' && entry.workflowId === WF(2)));
  });

  it('runs a real-time classic workflow inside the request, so its write is visible at once', async () => {
    const response = await call(executeOf(WF(5)), { method: 'POST', body: widgetRef });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).asyncoperationid, '00000000-0000-0000-0000-000000000000');
    assert.equal(store.tableRows('contoso_widget')[0].status, 88);
  });

  it('runs an exported cloud flow as a background job that completes; its flow-run span carries the flow name', async () => {
    // A trace store for this run only (data.mjs and the flow runtime read store.traces per call).
    store.traces = createTraceStore();
    try {
      const { asyncoperationid } = await (await call(executeOf(WF(6)), { method: 'POST', body: widgetRef })).json();
      const job = await finished(asyncoperationid);
      assert.equal(job.operationtype, 10);
      assert.equal(job.statuscode, 30);
      const runs = store.traces.spans({ kind: 'flow-run' }).items;
      assert.deepEqual(
        runs.map((span) => [span.name, span.attributes.trigger]),
        [['Invented 06', 'ExecuteWorkflow']],
      );
    } finally {
      delete store.traces;
    }
  });

  // @test-kind unproven+security: local model of the workflow privilege check
  it('refuses a call from a user with no roles on the workflow privilege', async () => {
    const none = await errorOf(await call(executeOf(WF(1)), { method: 'POST', body: widgetRef, token: noneToken }));
    assert.equal(none.code, '0x80040220');
    assert.match(none.message, /missing prvReadWorkflow privilege/);
  });

  it('refuses a PATCH of a published definition, of an activation row, and a DELETE of an activation row', async () => {
    const patchDefinition = await call(webApi(`workflows(${WF(1)})`), { method: 'PATCH', body: { name: 'renamed' } });
    assert.equal((await errorOf(patchDefinition)).code, '0x80045002');
    const patchActivation = await call(webApi(`workflows(${activationOf(WF(1))})`), {
      method: 'PATCH',
      body: { name: 'renamed' },
    });
    assert.equal((await errorOf(patchActivation)).code, '0x80045003');
    const deleteActivation = await call(webApi(`workflows(${activationOf(WF(1))})`), { method: 'DELETE' });
    assert.equal((await errorOf(deleteActivation)).code, '0x80045004');
  });

  it('refuses to publish an automatic classic workflow with no activation parameters', async () => {
    const response = await call(webApi(`workflows(${WF(9)})`), { method: 'PATCH', body: { statecode: 1 } });
    assert.equal((await errorOf(response)).code, '0x80045018');
  });

  it('refuses to publish a definition of a type that cannot be published', async () => {
    store.state.tables.workflow.push({
      workflowid: WF(20),
      name: 'Invented unknown',
      category: 0,
      type: 9,
      mode: 0,
      statecode: 0,
      statuscode: 1,
      primaryentity: 'contoso_widget',
    });
    const response = await call(webApi(`workflows(${WF(20)})`), { method: 'PATCH', body: { statecode: 1 } });
    assert.equal((await errorOf(response)).code, '0x8004500d'); // the error body is lower-cased, as every code is
  });

  // @test-kind observation: hosted session F6, summary-F6 OPS-01d (runs A and B): the Web API creates a category-0 definition whose XAML is designer-shaped and refuses other XAML (every Postpone form included) with 400 0x80045040
  it('creates a classic workflow with designer XAML through the Web API and refuses custom XAML with 0x80045040', async () => {
    const XAML = (body) =>
      `<Activity x:Class="XrmWorkflowInvented" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:mxswa="clr-namespace:Microsoft.Xrm.Sdk.Workflow.Activities;assembly=Microsoft.Xrm.Sdk.Workflow" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><mxswa:Workflow>${body}</mxswa:Workflow></Activity>`;
    const create = (name, xaml) =>
      call(webApi('workflows'), {
        method: 'POST',
        body: { name, category: 0, type: 1, mode: 0, primaryentity: 'contoso_widget', triggeroncreate: true, xaml },
      });
    const accepted = await create('Invented designer', XAML(''));
    assert.equal(accepted.status, 204, await accepted.clone().text());
    assert.equal(
      store.tableRows('workflow').some((item) => item.name === 'Invented designer'),
      true,
    );
    for (const [name, xaml] of [
      [
        'Invented custom',
        '<Activity x:Class="XrmWorkflowInvented" xmlns="http://schemas.microsoft.com/netfx/2009/xaml/activities" xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"><Sequence /></Activity>',
      ],
      ['Invented postpone', XAML('<mxswa:Postpone BlockExecution="True" PostponeUntil="[Until]" />')],
    ]) {
      const response = await create(name, xaml);
      assert.equal(response.status, 400, name);
      assert.deepEqual(await errorOf(response), {
        code: '0x80045040',
        message:
          'This workflow cannot be created, updated or published because it was created outside the Microsoft Dynamics 365 Web application. Your organization does not allow this type of workflow.',
      });
      assert.equal(
        store.tableRows('workflow').some((item) => item.name === name),
        false,
      );
    }
  });

  it('copies a workflow template into a new draft definition, and refuses a definition that is not a template', async () => {
    const response = await call(webApi(`workflows(${WF(21)})/${CRM}CreateWorkflowFromTemplate`), {
      method: 'POST',
      body: { WorkflowName: 'Invented copy' },
    });
    assert.equal(response.status, 200, await response.clone().text());
    const created = await response.json();
    const copy = await row('workflows', created.workflowid);
    assert.equal(copy.name, 'Invented copy');
    assert.equal(copy.type, 1);
    assert.equal(copy.statecode, 0);
    assert.equal(copy.statuscode, 1);
    assert.equal(copy.primaryentity, 'contoso_widget');
    const refused = await errorOf(
      await call(webApi(`workflows(${WF(3)})/${CRM}CreateWorkflowFromTemplate`), {
        method: 'POST',
        body: { WorkflowName: 'Invented refused copy' },
      }),
    );
    assert.equal(refused.message, 'Only a workflow template can be copied.');
    assert.equal(
      store.tableRows('workflow').some((item) => item.name === 'Invented refused copy'),
      false,
    );
  });

  it('deactivates an on-demand definition by PATCH (its activation row goes), then activates it again', async () => {
    const off = await call(webApi(`workflows(${WF(10)})`), { method: 'PATCH', body: { statecode: 0 } });
    assert.equal(off.status, 204, await off.clone().text());
    assert.equal((await call(webApi(`workflows(${activationOf(WF(10))})`))).status, 404);
    assert.equal((await row('workflows', WF(10)))._activeworkflowid_value, null);
    const on = await call(webApi(`workflows(${WF(10)})`), { method: 'PATCH', body: { statecode: 1 } });
    assert.equal(on.status, 204, await on.clone().text());
    assert.equal((await row('workflows', activationOf(WF(10)))).type, 2);
  });

  it('a cloud flow deactivated by PATCH is inactive in the flow map the portal triggers read', async () => {
    const flows = new Map([
      [WF(6), { active: true, processId: WF(6) }],
      [WF(7), { active: false, processId: WF(7) }],
    ]);
    assert.equal(workflowsWithActivation(flows, store).get(WF(6)).active, true);
    const off = await call(webApi(`workflows(${WF(6)})`), { method: 'PATCH', body: { statecode: 0 } });
    assert.equal(off.status, 204, await off.clone().text());
    assert.equal(workflowsWithActivation(flows, store).get(WF(6)).active, false);
    assert.equal(workflowsWithActivation(flows, new DataStore({ state: emptyState() })), flows);
  });
});

describe('dataverse workflows: Solution sources and handler packs', () => {
  // @test-kind contract: Paqvilo reads Solution workflow sources
  it('reads classic and cloud workflow data files with their XAML and JSON text', async (t) => {
    const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-workflows-'));
    t.after(() => fs.rm(dir, { recursive: true, force: true }));
    const folder = path.join(dir, 'Workflows');
    await fs.mkdir(folder, { recursive: true });
    const classic = WF(31);
    const cloud = WF(32);
    await fs.writeFile(path.join(folder, 'Invented-classic.xaml'), '<Activity />');
    await fs.writeFile(
      path.join(folder, 'Invented-classic.xaml.data.xml'),
      `<Workflow WorkflowId="{${classic}}" Name="Invented classic" Category="0" Type="1" Mode="0" OnDemand="1" PrimaryEntity="contoso_widget" StateCode="1" XamlFileName="Invented-classic.xaml" />`,
    );
    await fs.writeFile(path.join(folder, 'Invented-flow.json'), '{"properties":{}}');
    await fs.writeFile(
      path.join(folder, 'Invented-flow.json.data.xml'),
      `<Workflow WorkflowId="{${cloud}}" Name="Invented flow" Category="5" OnDemand="1" StateCode="Activated" JsonFileName="Invented-flow.json" />`,
    );
    await fs.writeFile(path.join(folder, 'Broken.data.xml'), '<Workflow WorkflowId="not-a-guid" />');
    const facts = await readSolutionWorkflows([{ dir }]);
    assert.deepEqual(facts.map((item) => item.id).sort(), [classic, cloud].sort());
    const byId = Object.fromEntries(facts.map((item) => [item.id, item]));
    assert.equal(byId[classic].xaml, '<Activity />');
    assert.equal(byId[classic].clientdata, null);
    assert.equal(byId[classic].ondemand, true);
    assert.equal(byId[cloud].category, 5);
    assert.equal(byId[cloud].state, 1);
    assert.equal(byId[cloud].clientdata, '{"properties":{}}');
  });

  // @test-kind contract: Paqvilo's trusted classic handler pack contract
  it('gives each handler one key, and refuses a duplicate across packs or a non-function', () => {
    const handler = () => ({});
    assert.equal(workflowHandlers([{ id: 'a', workflows: { [WF(40)]: handler } }]).get(WF(40)), handler);
    assert.throws(
      () =>
        workflowHandlers([
          { id: 'a', workflows: { Invented: handler } },
          { id: 'b', workflows: { invented: handler } },
        ]),
      /Ambiguous workflows registration/,
    );
    assert.throws(
      () => workflowHandlers([{ id: 'a', workflows: { Invented: 'not a function' } }]),
      /workflows must map workflow ids or unique names to functions/,
    );
  });
});

// ---- Classic triggers on Dataverse writes

const TRIGGER_APP_ID = '55555555-5555-5555-5555-555555555555';
const TRIGGER_SECRET_VAR = 'PAQVILO_WORKFLOW_TRIGGERS_SECRET';
const REFUSAL = 'Invented refusal';
// Each definition names one trigger. Names are "Invented <last two digits>", so jobs are told apart by name.
const TRIGGER_FACTS = [
  fact(WF(41), { triggeroncreate: true, ondemand: false }), // background create: handler
  fact(WF(42), { triggeronupdateattributelist: 'name', ondemand: false }), // background update of name: placeholder
  fact(WF(43), { triggerondelete: true, ondemand: false }), // background delete: placeholder
  fact(WF(44), { triggeroncreate: true, mode: 1, ondemand: false }), // real-time create: handler sets status
  fact(WF(45), { triggeronupdateattributelist: 'note', mode: 1, ondemand: false, uniquename: 'Realtime_Refuse' }), // refuses
  fact(WF(46), { triggeroncreate: true, scope: 1, ondemand: false }), // background create, user scope
  fact(WF(47), { triggeronupdateattributelist: 'name', mode: 1, ondemand: false }), // real-time update of name: mock in one test
];
const TRIGGER_HANDLERS = workflowHandlers([
  {
    id: 'invented-trigger-pack',
    workflows: {
      [WF(41)]: async () => ({ message: 'handled create' }),
      [WF(44)]: async ({ target, api: runApi }) => {
        runApi.store.state.tables.contoso_widget.find((row) => row.contoso_widgetid === target.id).status = 88;
      },
      Realtime_Refuse: async () => {
        throw new Error(REFUSAL);
      },
    },
  },
]);

function triggerState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: 'contoso_widget',
    entitySet: 'contoso_widgets',
    idColumn: 'contoso_widgetid',
    nameColumn: 'name',
    userConfigured: true,
    fields: {
      name: { dataverseType: 'nvarchar' },
      status: { dataverseType: 'int' },
      note: { dataverseType: 'nvarchar' },
    },
    relationships: {},
  };
  state.tables.contoso_widget = [];
  return state;
}

describe('dataverse workflows: classic triggers on Dataverse writes', () => {
  let api;
  let store;
  let origin;
  let tenantId;
  let appToken;

  before(async () => {
    process.env[TRIGGER_SECRET_VAR] = 'triggers-secret';
    store = await new DataStore({ state: triggerState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: TRIGGER_APP_ID,
          displayName: 'Triggers app',
          secretEnvironmentVariable: TRIGGER_SECRET_VAR,
          roles: ['System Administrator'],
        },
      ],
    });
    api = await startDataverseApi({
      store,
      settings,
      log: () => {},
      extensions: [
        ...EXTENSIONS,
        workflowExtension({
          facts: TRIGGER_FACTS,
          handlers: TRIGGER_HANDLERS,
          overrides: () => store.state.dataverse?.workflowOverrides ?? {},
          diagnostic: () => {},
        }),
      ],
    });
    origin = api.origin;
    tenantId = api.tenantId;
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: TRIGGER_APP_ID,
        client_secret: process.env[TRIGGER_SECRET_VAR],
        scope: `${origin}/.default`,
      }),
    });
    appToken = (await response.json()).access_token;
  });

  after(async () => {
    delete process.env[TRIGGER_SECRET_VAR];
    await api?.close();
  });

  const call = (path, { method = 'GET', body } = {}) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${appToken}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const webApi = (suffix) => `/api/data/v9.2/${suffix}`;
  const widgetRow = (id) => store.tableRows('contoso_widget').find((row) => row.contoso_widgetid === id);
  const jobsFor = (name, regarding) =>
    store
      .tableRows('asyncoperation')
      .filter(
        (job) =>
          job.operationtype === 10 &&
          job.name === name &&
          (regarding === undefined || job.regardingobjectid?.id === regarding),
      );
  const finishedJob = (name, regarding) => jobsFor(name, regarding).find((job) => job.statecode === 3);
  // A background trigger's Ready row commits with the write and the store's committed-job runner runs it later
  // (dataverse-workflows.mjs stageBackgroundRuns) on the store's scheduler: once settled, every job a write started has
  // its final state.
  const settled = () => settleCommittedWork(store, []);

  async function create(body) {
    const response = await call(webApi('contoso_widgets'), { method: 'POST', body });
    assert.equal(response.status, 204, await response.clone().text());
    return response.headers.get('OData-EntityId').match(/\(([^)]+)\)$/)[1];
  }

  it("a background create trigger starts one job on the new row, and its handler's result is the job's message", async () => {
    const id = await create({ name: 'alpha' });
    await settled();
    const job = finishedJob('Invented 41', id);
    assert.ok(job, 'the create job finished');
    assert.equal(job.statuscode, 30);
    assert.equal(job.message, 'handled create');
    assert.equal(jobsFor('Invented 41').length, 1);
  });

  it('an update trigger starts a job only when a listed attribute is submitted', async () => {
    const id = await create({ name: 'beta' });
    const statusOnly = await call(webApi(`contoso_widgets(${id})`), { method: 'PATCH', body: { status: 2 } });
    assert.equal(statusOnly.status, 204, await statusOnly.clone().text());
    await settled();
    assert.equal(jobsFor('Invented 42', id).length, 0);
    const named = await call(webApi(`contoso_widgets(${id})`), { method: 'PATCH', body: { name: 'beta 2' } });
    assert.equal(named.status, 204, await named.clone().text());
    await settled();
    const job = finishedJob('Invented 42', id);
    assert.ok(job, 'the update job finished');
    assert.equal(job.statuscode, 32);
    assert.match(job.message, /classic workflow XAML is not executed/);
  });

  it('a delete trigger starts a job on the deleted row', async () => {
    const id = await create({ name: 'gamma' });
    const response = await call(webApi(`contoso_widgets(${id})`), { method: 'DELETE' });
    assert.equal(response.status, 204, await response.clone().text());
    await settled();
    assert.equal(finishedJob('Invented 43', id)?.statuscode, 32);
  });

  it('a real-time create trigger runs inside the request, so the row it writes is there when the create answers', async () => {
    const id = await create({ name: 'delta' });
    assert.equal(widgetRow(id).status, 88);
    await settled();
    assert.equal(jobsFor('Invented 44').length, 0, 'a real-time run starts no job');
  });

  it('a real-time refusal rejects the write with its code and rolls the write back', async () => {
    const id = await create({ name: 'epsilon', note: 'kept' });
    const response = await call(webApi(`contoso_widgets(${id})`), { method: 'PATCH', body: { note: 'changed' } });
    const error = (await response.json()).error;
    assert.equal(response.status, 400);
    assert.equal(error.code, '0x80040265');
    assert.equal(error.message, REFUSAL);
    assert.equal(widgetRow(id).note, 'kept');
  });

  // @test-kind contract: Paqvilo's real-time failure log writes the failure text to the processsession column the Web API has
  it('a real-time run that fails and asks for its log keeps the text in processsession comments, readable over the Web API', async () => {
    const id = await create({ name: 'iota', note: 'kept' });
    const definition = store.tableRows('workflow').find((row) => row.workflowid === WF(45));
    assert.ok(definition, 'the real-time refusal workflow is seeded');
    store.transact(() => {
      Object.assign(definition, { ondemand: true, syncworkflowlogonfailure: true });
    });
    try {
      const response = await call(webApi(`workflows(${WF(45)})/${CRM}ExecuteWorkflow`), {
        method: 'POST',
        body: { EntityId: id },
      });
      assert.equal(response.ok, false, 'the failed run is an error response');
      const sessions = store.tableRows('processsession').filter((row) => row.comments === REFUSAL);
      assert.equal(sessions.length, 1, 'one processsession row carries the failure text');
      assert.equal('errortext' in sessions[0], false, 'no column the processsession table does not have');
      const listed = await call(webApi('processsessions?$select=comments'));
      assert.equal(listed.status, 200, await listed.clone().text());
      assert.ok((await listed.json()).value.some((row) => row.comments === REFUSAL));
    } finally {
      store.transact(() => {
        Object.assign(definition, { ondemand: false, syncworkflowlogonfailure: false });
      });
    }
  });

  it("a real-time trigger runs its mock inside the Web API write, and the write's log says so", async () => {
    const id = await create({ name: 'theta' });
    store.transact(() => {
      store.state.dataverse.workflowOverrides = {
        [WF(47)]: { mode: 'mock', status: 30, message: 'Invented real-time mock' },
      };
    });
    const response = await call(webApi(`contoso_widgets(${id})`), { method: 'PATCH', body: { name: 'theta 2' } });
    assert.equal(response.status, 204, await response.clone().text());
    assert.equal(
      store
        .tableRows('workflowlog')
        .filter((log) => log.message === 'Invented real-time mock' && log.regardingobjectid?.id === id).length,
      1,
    );
    store.transact(() => {
      delete store.state.dataverse.workflowOverrides[WF(47)];
    });
  });

  it('a mocked real-time failure answers the real-time failure code, as a failing handler does', async () => {
    const id = await create({ name: 'lambda', note: 'kept' });
    const definition = store.tableRows('workflow').find((row) => row.workflowid === WF(45));
    store.transact(() => {
      definition.ondemand = true;
      store.state.dataverse.workflowOverrides = { [WF(45)]: { mode: 'mock', status: 31, message: 'rt fail' } };
    });
    try {
      const response = await call(webApi(`workflows(${WF(45)})/${CRM}ExecuteWorkflow`), {
        method: 'POST',
        body: { EntityId: id },
      });
      assert.equal(response.status, 400);
      const { error } = await response.json();
      assert.deepEqual([error.code, error.message], ['0x80040265', 'rt fail']);
    } finally {
      store.transact(() => {
        definition.ondemand = false;
        delete store.state.dataverse.workflowOverrides[WF(45)];
      });
    }
  });

  // The trigger looks the written row up through the table's primary-key index. A linear search per write made every
  // PATCH on a 300k-row table cost a full pass even with no trigger firing (the storage volume gate's HTTP PATCHes).
  it('a real-time trigger finds the written row by key, without reading the whole table', async () => {
    const filler = 5000;
    const rows = store.state.tables.contoso_widget;
    const before = rows.length;
    store.transact(() => {
      for (let n = 0; n < filler; n++)
        rows.push({ contoso_widgetid: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, name: `filler ${n}` });
    });
    // Written last, so a search from the start passes every filler row.
    const id = await create({ name: 'kappa' });
    let reads = 0;
    // The index cache is keyed by the row array, so the counting proxy stays in place from before the warm-up write.
    store.state.tables.contoso_widget = new Proxy(rows, {
      get(target, key, receiver) {
        if (typeof key === 'string' && /^(0|[1-9]\d*)$/.test(key)) reads++;
        return Reflect.get(target, key, receiver);
      },
    });
    try {
      const patch = async (status) => {
        const response = await call(webApi(`contoso_widgets(${id})`), { method: 'PATCH', body: { status } });
        assert.equal(response.status, 204, await response.clone().text());
      };
      await patch(1);
      reads = 0;
      await patch(2);
      assert.ok(reads < filler / 10, `${reads} row reads for one PATCH of a ${filler + 1}-row table`);
      assert.equal(widgetRow(id).status, 2);
    } finally {
      store.state.tables.contoso_widget = rows;
      store.transact(() => {
        rows.splice(before, filler);
      });
    }
  });

  it("a user-scoped trigger starts jobs only for rows the definition's owner owns", async () => {
    const who = await (await call(webApi('WhoAmI'))).json();
    const definition = () => store.tableRows('workflow').find((row) => row.workflowid === WF(46));
    store.transact(() => {
      definition().owninguser = { id: '99999999-9999-4999-8999-999999999999', logical_name: 'systemuser' };
    });
    const other = await create({ name: 'zeta' });
    await settled();
    assert.equal(jobsFor('Invented 46', other).length, 0);
    store.transact(() => {
      definition().owninguser = { id: who.UserId, logical_name: 'systemuser' };
    });
    const own = await create({ name: 'eta' });
    await settled();
    assert.equal(finishedJob('Invented 46', own)?.statuscode, 32, 'the owner-scoped job ran its placeholder');
  });
});

describe('dataverse workflows: a portal write is unchanged by a background trigger on its table', () => {
  // @test-kind contract: a background trigger leaves Paqvilo's portal output unchanged
  it('answers the same status, headers and bytes with and without an activated background trigger', async (t) => {
    const source = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-workflows-portal-'));
    t.after(() => fs.rm(source, { recursive: true, force: true }));
    await fs.writeFile(path.join(source, 'website.yml'), 'adx_websiteid: site\nadx_name: Workflow portal\n');
    await fs.writeFile(
      path.join(source, 'sitesetting.yml'),
      '- adx_name: Webapi/contoso_widget/enabled\n  adx_value: true\n- adx_name: Webapi/contoso_widget/fields\n  adx_value: name,status\n',
    );
    const widget = 'aaaaaaaa-0000-0000-0000-000000000099';
    const base = {
      settings: { permissionMode: 'permissive' },
      mappings: triggerState().mappings,
      tables: { contoso_widget: [{ contoso_widgetid: widget, name: 'alpha', status: 1 }] },
    };
    // An activated background definition on contoso_widget that starts on a change of name (no handler: a placeholder).
    const trigger = {
      workflowid: WF(51),
      name: 'Invented 51',
      uniquename: null,
      category: 0,
      type: 1,
      mode: 0,
      scope: 4,
      ondemand: false,
      subprocess: false,
      triggeroncreate: false,
      triggerondelete: false,
      triggeronupdateattributelist: 'name',
      primaryentity: 'contoso_widget',
      statecode: 1,
      statuscode: 2,
      runas: 0,
      istransacted: true,
      asyncautodelete: false,
      syncworkflowlogonfailure: false,
    };
    // A real-time definition on the same table, with a mock run: a portal write is a Dataverse write, so it runs inside the
    // write as it does for a Web API write (its log shows) and, succeeding, leaves the response unchanged.
    const realtime = {
      ...trigger,
      workflowid: WF(52),
      name: 'Invented real-time',
      mode: 1,
      triggeronupdateattributelist: 'name',
    };
    const exchange = async (workflow, overrides = {}) => {
      const app = await createSimulator({
        sourceDir: source,
        port: 0,
        watch: false,
        dataverse: { enabled: true },
        initial: { ...base, tables: { ...base.tables, workflow } },
      });
      try {
        app.store.transact(() => {
          app.store.state.dataverse.workflowOverrides = overrides;
        });
        const headers = { 'content-type': 'application/json', __RequestVerificationToken: app.csrf };
        const response = await fetch(`${app.url}/_api/contoso_widgets(${widget})`, {
          method: 'PATCH',
          headers,
          body: JSON.stringify({ name: 'renamed' }),
        });
        const bytes = Buffer.from(await response.arrayBuffer());
        // Every job the write started has finished once the simulator's committed work is settled.
        await app.settle();
        const started = app.store.tableRows('asyncoperation').some((job) => job.operationtype === 10);
        // Per-run values only: the Date, the audit and trace ids and this run's origin (the port differs between the two runs).
        return {
          status: response.status,
          headers: [...response.headers]
            .filter(([key]) => !['date', 'x-sim-trace-id', 'x-sim-span-id', 'x-trace-id'].includes(key))
            .map(([key, value]) => [key, value.replaceAll(app.url, '<origin>')])
            .sort(),
          body: bytes.toString('base64'),
          started,
          jobs: app.store
            .tableRows('asyncoperation')
            .filter((job) => job.operationtype === 10)
            .map((job) => ({ name: job.name, statuscode: job.statuscode, regarding: job.regardingobjectid?.id })),
          logs: app.store.tableRows('workflowlog').map((log) => log.message),
        };
      } finally {
        await app.close();
      }
    };
    const without = await exchange([]);
    const withTrigger = await exchange([trigger, realtime], {
      [WF(52)]: { mode: 'mock', status: 30, message: 'Invented real-time mock' },
    });
    assert.equal(without.started, false);
    assert.equal(withTrigger.started, true, 'the trigger ran');
    assert.equal(withTrigger.status, without.status);
    assert.deepEqual(withTrigger.headers, without.headers);
    assert.equal(withTrigger.body, without.body);
    assert.deepEqual(without.jobs, []);
    assert.deepEqual(withTrigger.jobs, [{ name: 'Invented 51', statuscode: 32, regarding: widget }]);
    assert.deepEqual(withTrigger.logs, ['Invented real-time mock'], 'the real-time mock ran inside the portal write');
  });
});

async function portalListWorkflowFixture(t, { settings = null } = {}) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-workflow-list-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const id = WF(61);
  const unlisted = WF(62);
  const withoutHandler = WF(63);
  const selected = 'aaaaaaaa-0000-4000-8000-000000000091';
  const filtered = 'aaaaaaaa-0000-4000-8000-000000000092';
  const site = 'aaaaaaaa-0000-4000-8000-000000000093';
  const list = 'aaaaaaaa-0000-4000-8000-000000000094';
  const contact = 'aaaaaaaa-0000-4000-8000-000000000095';
  const pack = path.join(dir, 'pack.mjs');
  const action = {
    Type: 'CrmEntityFormView-WorkflowAction',
    WorkflowId: id,
    FilterCriteria:
      '<fetch><entity name="contoso_widget"><attribute name="contoso_widgetid"/><filter><condition attribute="name" operator="eq" value="alpha"/></filter></entity></fetch>',
  };
  const files = {
    'website.yml': `adx_websiteid: ${site}\nadx_name: Workflow list\n`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': "{% include 'entity_list' key: 'Widgets' %}",
    'Widgets.list.yml': [
      `adx_entitylistid: ${list}`,
      'adx_name: Widgets',
      'adx_entityname: contoso_widget',
      'adx_settings: |-',
      `  ${JSON.stringify(settings?.({ action, withoutHandler, id, unlisted }) ?? { ItemActions: [action, { ...action, WorkflowId: undefined, Workflow: { Id: withoutHandler } }] })}`,
    ].join('\n'),
    'pack.mjs': `
      export default {
        id: 'workflow-list-fixture', name: 'Workflow list fixture', description: 'Invented list handlers',
        matches: () => true, presets: () => ({}),
        workflows: {
          '${id}': async ({ api, target }) => {
            await api.store.updateRecordAsync('contoso_widget', target.id, { status: target.row.status + 10 }, { admin: true });
            return { message: 'Portal list handler ran' };
          },
          '${unlisted}': () => { throw new Error('The unavailable action ran.'); },
        },
      };
    `,
  };
  for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(dir, name), content);
  const state = triggerState();
  state.settings.permissionMode = 'enforce';
  state.permissions = [
    { id: 'list-reader', entity: 'contoso_widget', scope: 'global', roles: ['Reader', 'Editor'], operations: ['read'] },
    { id: 'list-editor', entity: 'contoso_widget', scope: 'global', roles: ['Editor'], operations: ['update'] },
  ];
  state.tables.contact = [{ contactid: contact, fullname: 'Invented visitor' }];
  state.tables.contoso_widget = [
    { contoso_widgetid: selected, name: 'alpha', status: 1 },
    { contoso_widgetid: filtered, name: 'beta', status: 1 },
  ];
  const app = await startListWorkflowSimulator({ dir, state, workflowIds: [id, unlisted, withoutHandler], pack });
  t.after(() => app.close());
  const editor = signInHeaders(app, contact, { roles: ['Editor'] });
  const reader = signInHeaders(app, contact, { roles: ['Reader'] });
  const html = await (await fetch(app.url, { headers: editor })).text();
  const encoded = /data-view-layouts="([^"]+)"/.exec(html)?.[1];
  assert.ok(encoded, 'list rendered its protected grid view');
  const [layout] = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'));
  const post = ({
    workflowId = id,
    recordId = selected,
    secure = layout.Base64SecureConfiguration,
    session = editor,
  } = {}) =>
    fetch(`${app.url}/_services/execute-workflow/${site}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf, ...session },
      body: JSON.stringify({
        workflow: { Id: workflowId, LogicalName: 'workflow' },
        entity: { Id: recordId, LogicalName: 'contoso_widget' },
        base64SecureConfiguration: secure,
      }),
    });
  const listFile = 'Widgets.list.yml';
  return {
    app,
    html,
    layout,
    post,
    id,
    unlisted,
    withoutHandler,
    selected,
    filtered,
    reader,
    listPath: path.join(dir, listFile),
    listSource: files[listFile],
  };
}

// @test-kind security: the local list workflow bridge binds trusted execution to an exported action and an authorized row
it('runs a trusted real-time workflow only for its authorized native list action', async (t) => {
  const { app, layout, post, id, unlisted, withoutHandler, selected, filtered, reader } =
    await portalListWorkflowFixture(t);
  const originalTransact = app.store.transact;
  const transactBetweenAdmissionAndRun = async (change) => {
    const entered = Promise.withResolvers();
    const resume = Promise.withResolvers();
    app.store.transact = function holdWorkflowTransaction(work, options) {
      if (!options?.isolated || !options.pluginVisible) return originalTransact.call(this, work, options);
      this.transact = originalTransact;
      entered.resolve();
      return resume.promise.then(() => originalTransact.call(this, work, options));
    };
    const answer = post();
    try {
      // On the unpatched branch the stub replies before attempting a transaction.
      await Promise.race([entered.promise, answer]);
      await originalTransact.call(app.store, change);
    } finally {
      app.store.transact = originalTransact;
      resume.resolve();
      await answer;
    }
    return answer;
  };
  const answer = await transactBetweenAdmissionAndRun(() => {
    app.store.tableRows('contoso_widget').find((row) => row.contoso_widgetid === selected).status = 7;
  });
  assert.equal(answer.status, 204, await answer.text());
  assert.deepEqual(layout.Configuration.ItemActionLinks[0].Workflow, { Id: id, LogicalName: 'workflow' });
  assert.equal((await post({ session: reader })).status, 403);
  assert.equal((await post({ session: {} })).status, 403);
  assert.equal((await post({ workflowId: unlisted })).status, 403);
  assert.equal((await post({ recordId: filtered })).status, 403);
  assert.equal((await post({ secure: 'tampered' })).status, 403);
  assert.equal((await post({ workflowId: withoutHandler })).status, 501);
  assert.equal(app.store.tableRows('contoso_widget')[0].status, 17);
  const deactivated = await transactBetweenAdmissionAndRun(() => {
    app.store.tableRows('workflow').find((row) => row.workflowid === id).statecode = 0;
  });
  assert.equal(deactivated.status, 400);
  assert.equal(app.store.tableRows('contoso_widget')[0].status, 17);
  assert.deepEqual(
    app.store.tableRows('workflowlog').map((row) => row.message),
    ['Portal list handler ran'],
  );
});

// @test-kind contract: a source refresh overlapping a trusted classic list workflow rolls back its local records before the new configuration takes effect.
it('rolls back a classic list workflow if the list source changes during its handler', async (t) => {
  const { app, id, post, selected, filtered, listPath, listSource } = await portalListWorkflowFixture(t);
  // A failed real-time run of this workflow also records a process session; the refused run must not.
  await app.store.transact(() => {
    app.store.tableRows('workflow').find((row) => row.workflowid === id).syncworkflowlogonfailure = true;
  });
  const refused = await reloadDuringHandler(t, {
    app,
    sourcePath: listPath,
    start: () => post(),
    beforeReload: async () => {
      const updatedSource = listSource.replaceAll('alpha', 'beta');
      assert.notEqual(updatedSource, listSource);
      await fs.writeFile(listPath, updatedSource);
    },
    label: 'list',
  });
  const status = (id) => app.store.tableRows('contoso_widget').find((row) => row.contoso_widgetid === id).status;
  assert.deepEqual(
    {
      response: refused.status,
      selectedStatus: status(selected),
      logs: app.store.tableRows('workflowlog').length,
      sessions: app.store.tableRows('processsession').length,
    },
    { response: 409, selectedStatus: 1, logs: 0, sessions: 0 },
  );
  assert.equal((await refused.json()).InnerError.Code, 'SourceRefreshConflict');
  assert.equal((await post()).status, 403);
  assert.equal((await post({ recordId: filtered })).status, 204);
  assert.equal(status(filtered), 11);
  assert.deepEqual(
    app.store.tableRows('workflowlog').map((row) => [row.status, row.message]),
    [[2, 'Portal list handler ran']],
  );
});

// @test-kind unproven: local model of the legacy list source (Adxstudio ViewConfiguration.GetActions merges ItemActions and ExtendedItemActions by ActionIndex; WorkflowActionLink takes the grid WorkflowDialog and the action's dialog texts); no hosted capture of a configured workflow action
it('runs an ExtendedItemActions workflow in ActionIndex order with its own dialog texts', async (t) => {
  const label = (value) => [{ LCID: 1033, Value: value }];
  const { app, html, layout, post, id, unlisted, selected } = await portalListWorkflowFixture(t, {
    settings: ({ action, unlisted: other }) => ({
      ItemActions: [
        { Type: 'CrmEntityFormView-DeleteAction', ActionIndex: 2 },
        { ...action, WorkflowId: other, FilterCriteria: undefined, ActionIndex: 1, ButtonLabel: label('Second') },
      ],
      ExtendedItemActions: [
        {
          ...action,
          ActionIndex: 1,
          ButtonLabel: label('Extended run'),
          WorkflowDialogTitle: label('Confirm the extended run'),
          WorkflowDialogPrimaryButtonText: label('Start'),
        },
      ],
      WorkflowDialog: {
        Title: label('Grid run'),
        PrimaryButtonText: label('Go'),
        CloseButtonText: label('Back'),
        DismissButtonSrText: label(''),
        Size: 2,
        CssClass: 'grid-run',
        TitleCssClass: '',
        PrimaryButtonCssClass: '',
        CloseButtonCssClass: '',
      },
    }),
  });
  const links = layout.Configuration.ItemActionLinks;
  // Equal indexes keep ItemActions before ExtendedItemActions; the delete action (index 2) follows.
  assert.deepEqual(
    links.map((link) => [link.Type, link.Label]),
    [
      [7, 'Second'],
      [7, 'Extended run'],
      [4, "<span class='fa fa-trash-o' aria-hidden='true'></span> Delete"],
    ],
  );
  assert.deepEqual(
    links
      .slice(0, 2)
      .map((link) => [
        link.Workflow.Id,
        link.CustomizeModal,
        link.Modal.Title,
        link.Modal.PrimaryButtonText,
        link.Modal.CloseButtonText,
        link.Modal.Size,
        link.Modal.CssClass,
      ]),
    [
      [unlisted, false, 'Grid run', 'Go', 'Back', 2, 'grid-run'],
      [id, true, 'Confirm the extended run', 'Start', 'Back', 2, 'grid-run'],
    ],
  );
  // The Bootstrap 3 list's one workflow dialog carries the grid WorkflowDialog.
  const modal = /<section[^>]*modal-run-workflow[^>]*>[\s\S]*?<\/section>/.exec(html)?.[0] ?? '';
  assert.match(modal, /class="modal fade modal-run-workflow grid-run"/);
  assert.match(modal, /<div class="modal-sm modal-dialog">/);
  assert.match(modal, /<h1 class="modal-title" title="Grid run">Grid run<\/h1>/);
  assert.match(modal, /<button class="primary btn btn-primary" type="button">Go<\/button>/);
  assert.match(modal, /<button class="cancel btn btn-default" data-dismiss="modal" type="button">Back<\/button>/);
  // The extended action is the list's own action: it runs on its authorized row.
  const answer = await post({ workflowId: id, recordId: selected });
  assert.equal(answer.status, 204, await answer.text());
  assert.equal(app.store.tableRows('contoso_widget').find((row) => row.contoso_widgetid === selected).status, 11);
});
