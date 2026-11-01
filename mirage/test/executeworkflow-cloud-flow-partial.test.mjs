// ExecuteWorkflow on an exported cloud flow: each connector write is its own boundary, so a later failed action fails the
// job but keeps the earlier completed write (mirage/docs/operations.md; the HTTP and trigger paths behave the same).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { workflowExtension } from '../lib/dataverse-workflows.mjs';
import { clientCredentialsCall } from './support/web-api.mjs';

const APP_ID = '77777777-7777-4777-8777-777777777741';
const SECRET_VAR = 'PAQVILO_EXECUTE_CLOUD_FLOW_SECRET';
const WIDGET = '77777777-7777-4777-8777-777777777742';
const FLOW = '77777777-7777-4777-8777-777777777743';
const PROFILE = {
  userId: '77777777-7777-4777-8777-777777777744',
  evidence: 'Invented flow owner',
  grants: [{ entity: 'x_note', operations: ['read', 'create'] }],
};
const DEFINITION = {
  triggers: {
    row: {
      type: 'OpenApiConnectionWebhook',
      inputs: {
        host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'SubscribeWebhookTrigger' },
        parameters: {
          'subscriptionRequest/message': 1,
          'subscriptionRequest/entityname': 'x_widget',
          'subscriptionRequest/scope': 4,
        },
      },
    },
  },
  actions: {
    create: {
      type: 'OpenApiConnection',
      inputs: {
        host: { apiId: '/apis/shared_commondataserviceforapps', operationId: 'CreateRecord' },
        parameters: { entityName: 'x_notes', 'item/x_name': "@triggerOutputs()['body/name']" },
      },
    },
    failure: {
      type: 'Terminate',
      runAfter: { create: ['Succeeded'] },
      inputs: { runStatus: 'Failed', runError: { message: 'Invented later failure' } },
    },
  },
};
const FACT = {
  id: FLOW,
  name: 'Invented cloud flow',
  uniquename: null,
  category: 5,
  type: 1,
  mode: 0,
  scope: 4,
  ondemand: true,
  subprocess: false,
  triggeroncreate: false,
  triggerondelete: false,
  triggeronupdateattributelist: null,
  primaryentity: 'x_widget',
  state: 1,
  runas: 0,
  istransacted: true,
  asyncautodelete: false,
  syncworkflowlogonfailure: false,
  xaml: null,
  clientdata: '{}',
};

function state() {
  const value = emptyState();
  const text = { dataverseType: 'nvarchar' };
  value.mappings.x_widget = {
    logicalName: 'x_widget',
    entitySet: 'x_widgets',
    idColumn: 'x_widgetid',
    nameColumn: 'name',
    userConfigured: true,
    fields: { name: text },
    relationships: {},
  };
  value.mappings.x_note = {
    logicalName: 'x_note',
    entitySet: 'x_notes',
    idColumn: 'x_noteid',
    nameColumn: 'x_name',
    userConfigured: true,
    fields: { x_name: text },
    relationships: {},
  };
  value.tables.x_widget = [{ x_widgetid: WIDGET, name: 'Invented widget' }];
  value.tables.x_note = [];
  return value;
}

test("ExecuteWorkflow on a cloud flow whose second action fails keeps the first action's write and fails the job", async (t) => {
  process.env[SECRET_VAR] = 'execute-cloud-flow-secret';
  t.after(() => {
    delete process.env[SECRET_VAR];
  });
  const store = await new DataStore({ state: state() }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [
      {
        appId: APP_ID,
        displayName: 'Flow app',
        secretEnvironmentVariable: SECRET_VAR,
        roles: ['System Administrator'],
      },
    ],
  });
  const api = await startDataverseApi({
    store,
    settings,
    log: () => {},
    extensions: [
      ...EXTENSIONS,
      workflowExtension({
        facts: [FACT],
        cloudFlow: (id) => (id === FLOW ? { definition: DEFINITION, mode: 'exported', serviceProfile: PROFILE } : null),
        diagnostic: () => {},
      }),
    ],
  });
  t.after(() => api.close());
  const call = await clientCredentialsCall(api, APP_ID, process.env[SECRET_VAR]);

  const started = await call('POST', `workflows(${FLOW})/Microsoft.Dynamics.CRM.ExecuteWorkflow`, { EntityId: WIDGET });
  assert.equal(started.status, 200, await started.clone().text());
  const { asyncoperationid } = await started.json();
  // The job runs on the store's scheduler (dataverse-async.mjs): drain it, then read the job once.
  await store.scheduler.drain();
  const job = await (await call('GET', `asyncoperations(${asyncoperationid})`)).json();
  assert.equal(job.statecode, 3, 'the job finished');
  assert.equal(job.statuscode, 31, 'the later action failed the job');
  assert.match(job.message ?? '', /Invented later failure/);
  assert.deepEqual(
    store.tableRows('x_note').map((row) => row.x_name),
    ['Invented widget'],
    "the first action's create is kept",
  );
});
