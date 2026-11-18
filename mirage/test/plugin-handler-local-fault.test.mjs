// @test-kind unproven: local JavaScript handler rule with no native counterpart: a handler that answers a promise or an unusable result is a faulty handler and answers over the Web API like that handler's own exception
// Invented schema, step ids and handlers only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const APP = '77777777-7777-4777-8777-7777777777d4';
const SECRET = 'PAQVILO_HANDLER_LOCAL_FAULT_SECRET';
const STEP = '61000000-0000-4000-8000-000000000001';

async function apiWith(t, { byStep, typeName, handler }) {
  process.env[SECRET] = 'local-fault-secret';
  const state = emptyState();
  state.mappings.x_item = {
    logicalName: 'x_item',
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    userConfigured: true,
    fields: { x_name: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.tables.x_item = [];
  const store = await new DataStore({ state }).init();
  const api = await startDataverseApi({
    store,
    settings: dataverseSettings({
      enabled: true,
      applications: [
        { appId: APP, displayName: 'Faults', secretEnvironmentVariable: SECRET, roles: ['System Administrator'] },
      ],
    }),
    log: () => {},
  });
  ownedFixture(t).add(async () => {
    await api.close();
    delete process.env[SECRET];
  });
  const handlers = new Map([[byStep ? STEP : typeName, handler]]);
  const items = pluginCatalogue({
    plugins: {
      steps: [
        {
          id: STEP,
          enabled: true,
          name: 'Invented Create pre',
          entity: 'x_item',
          message: 'Create',
          stage: 20,
          mode: 0,
          rank: 1,
          supportedDeployment: 0,
          filteringAttributes: [],
          images: [],
          typeName,
          assemblyId: 'invented',
        },
      ],
    },
    handlers,
  });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  const token = (
    await (
      await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: APP,
          client_secret: process.env[SECRET],
          scope: `${api.origin}/.default`,
        }),
      })
    ).json()
  ).access_token;
  const create = async () => {
    const response = await fetch(`${api.origin}/api/data/v9.2/x_items`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        prefer: 'odata.include-annotations="*"',
      },
      body: JSON.stringify({ x_name: 'invented' }),
    });
    return { status: response.status, body: await response.json() };
  };
  return { store, create };
}

test('a step handler that answers a promise fails like its ordinary exception: 400 0x80040224, rolled back', async (t) => {
  const { store, create } = await apiWith(t, {
    byStep: true,
    typeName: 'Invented.StepPromise',
    handler: () => Promise.resolve({ target: {} }),
  });
  const { status, body } = await create();
  assert.equal(status, 400);
  assert.equal(body.error.code, '0x80040224');
  assert.equal(body.error.message, 'Plugin handlers must return synchronously.');
  assert.equal(store.tableRows('x_item').length, 0);
});

test('a plug-in type handler that answers a promise fails like its exception: 0x80040265 with the SubErrorCode', async (t) => {
  const { store, create } = await apiWith(t, {
    byStep: false,
    typeName: 'Invented.TypePromise',
    handler: () => Promise.resolve({ target: {} }),
  });
  const { status, body } = await create();
  assert.equal(status, 400);
  assert.equal(body.error.code, '0x80040265');
  assert.equal(body.error.message, 'Plugin handlers must return synchronously.');
  assert.equal(body.error['@Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode'], '-2146233088');
  assert.equal(store.tableRows('x_item').length, 0);
});

test('a handler result the pipeline cannot use is that handler fault, not the invalid-request code', async (t) => {
  const { store, create } = await apiWith(t, {
    byStep: true,
    typeName: 'Invented.BadResult',
    handler: () => ({ unknownField: true }),
  });
  const { status, body } = await create();
  assert.equal(status, 400);
  assert.equal(body.error.code, '0x80040224');
  assert.equal(body.error.message, 'Plugin result must contain only supported field/query changes or an error.');
  assert.equal(store.tableRows('x_item').length, 0);
});
