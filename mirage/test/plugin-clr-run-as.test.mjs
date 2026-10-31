// @test-kind security: plug-in SDK calls run as the CreateOrganizationService user (null SYSTEM, Guid.Empty the step's user, else that user) and are authorized by that user's Dataverse security roles; a user without the privilege is refused with the native privilege fault
// @parity-evidence: user explicitly approved C16 on 2026-10-30 (native run-as roles replace the grant profile); factory semantics from Microsoft Learn IOrganizationServiceFactory.CreateOrganizationService
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { sdkFault } from '../lib/plugin-sdk-messages.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';

const EMPTY = '00000000-0000-0000-0000-000000000000';

async function organization(t, extraUsers = []) {
  const state = emptyState();
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid' };
  state.tables.x_item = [];
  const store = await new DataStore({ state }).init();
  const runtime = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({
      enabled: true,
      users: [
        {
          objectId: '77000000-0000-0000-0000-000000000001',
          domainname: 'admin@invented.test',
          fullname: 'Invented admin',
          roles: ['System Administrator'],
        },
        {
          objectId: '77000000-0000-0000-0000-000000000002',
          domainname: 'plain@invented.test',
          fullname: 'Invented plain',
          roles: [],
        },
        ...extraUsers,
      ],
    }),
  });
  t.after(() => runtime.close());
  const id = (name) => store.tableRows('systemuser').find((row) => row.fullname === name).systemuserid;
  // The descriptor profile grants nothing: authorization comes from the run-as user's roles.
  const profile = { userId: id('Invented admin'), evidence: 'Invented run-as step', grants: [] };
  const create = (userId, name, extra = {}, sdkParentContext) =>
    store.withOperationContext(() =>
      dispatchSdkCall({
        store,
        profile,
        invokingUserId: id('Invented admin'),
        initiatingUserId: id('Invented admin'),
        sdkParentContext,
        message: {
          method: 'Execute',
          userId,
          arguments: [
            {
              $type: 'OrganizationRequest',
              requestName: 'Create',
              parameters: {
                $type: 'ParameterCollection',
                values: {
                  Target: { $type: 'Entity', logicalName: 'x_item', id: EMPTY, attributes: { x_name: name } },
                  ...extra,
                },
              },
            },
          ],
        },
      }),
    );
  const createdBy = (name) => {
    const row = store.tableRows('x_item').find((item) => item.x_name === name);
    return row.createdby?.id ?? row.createdby;
  };
  return { store, id, create, createdBy };
}

test('CreateOrganizationService(null) runs as SYSTEM and Guid.Empty as the step user', async (t) => {
  const { store, id, create, createdBy } = await organization(t);
  const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM').systemuserid;
  create(null, 'as system');
  assert.equal(createdBy('as system'), system);
  create(EMPTY, 'as step user');
  assert.equal(createdBy('as step user'), id('Invented admin'));
  create(id('Invented admin'), 'as named user');
  assert.equal(createdBy('as named user'), id('Invented admin'));
});

test('a run-as user without the privilege is refused with the native privilege fault', async (t) => {
  const { store, id, create } = await organization(t);
  let failure;
  try {
    create(id('Invented plain'), 'denied');
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 'PrivilegeDenied');
  assert.equal(sdkFault(failure).errorCode, 0x80040220 | 0);
  assert.match(failure.message, /missing prvCreate/);
  assert.equal(store.tableRows('x_item').length, 0);
  // A bypass option needs its privilege too: System Administrator holds it, a user without roles does not.
  create(id('Invented admin'), 'bypassed', { BypassCustomPluginExecution: true });
  assert.throws(
    () => create(id('Invented plain'), 'not bypassed', { BypassCustomPluginExecution: true }),
    (error) => error.code === 'PrivilegeDenied' && /prvBypassCustomPlugins/.test(error.message),
  );
  // An id that names no systemuser cannot run anything.
  assert.throws(
    () => create('77000000-0000-0000-0000-000000000099', 'nobody'),
    (error) => error.details?.innerCode === '0x80040217',
  );
});

test('the nested operation of a plug-in SDK call is initiated by the service user', async (t) => {
  // Recorded native sdkSurface and readNested: UserId and InitiatingUserId of the nested contexts are the run-as user.
  const { store, id, create } = await organization(t);
  const seen = [];
  const step = {
    id: '77000000-0000-0000-0000-0000000000a1',
    name: 'Invented nested observer',
    entity: 'x_item',
    message: 'Create',
    enabled: true,
    stage: 20,
    rank: 1,
    mode: 0,
    assemblyId: 'invented-run-as',
    supportedDeployment: 0,
    filteringAttributes: [],
    images: [],
    typeName: 'Invented.Observer',
  };
  const handlers = new Map([
    [
      'Invented.Observer',
      ({ context }) => {
        seen.push([context.UserId, context.InitiatingUserId].map((v) => v?.value ?? v));
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps: [step] }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM').systemuserid;
  // The calling step's context: the plain user initiated the outer operation.
  const caller = {
    $type: 'ExecutionContext',
    values: {
      MessageName: 'Update',
      Stage: 40,
      Depth: 1,
      UserId: { $type: 'Guid', value: id('Invented plain') },
      InitiatingUserId: { $type: 'Guid', value: id('Invented plain') },
    },
  };
  create(null, 'as system', {}, caller);
  create(id('Invented admin'), 'as admin', {}, caller);
  assert.deepEqual(seen, [
    [system, system],
    [id('Invented admin'), id('Invented admin')],
  ]);
});

// @test-kind parity: native-r2 sdkSurface Create/20 as SYSTEM (62) and as another user (68), readNested nested Create as SYSTEM: createdonbehalfby and modifiedonbehalfby are the initiating user; as the context user neither
test('an SDK create as SYSTEM or another user stamps the initiating user on behalf of, the context user stamps none', async (t) => {
  const { store, id, create } = await organization(t, [
    {
      objectId: '77000000-0000-0000-0000-000000000003',
      domainname: 'second@invented.test',
      fullname: 'Invented second admin',
      roles: ['System Administrator'],
    },
  ]);
  const admin = id('Invented admin');
  const step = {
    id: '77000000-0000-0000-0000-0000000000a2',
    name: 'Invented create observer',
    entity: 'x_item',
    message: 'Create',
    enabled: true,
    stage: 20,
    rank: 1,
    mode: 0,
    assemblyId: 'invented-run-as',
    supportedDeployment: 0,
    filteringAttributes: [],
    images: [],
    typeName: 'Invented.CreateObserver',
  };
  // The PreOperation Target of each create: its on-behalf-of references as the plug-in sees them.
  const targets = new Map();
  const handlers = new Map([
    ['Invented.CreateObserver', ({ target }) => targets.set(target.x_name, target.createdonbehalfby?.id ?? null)],
  ]);
  const items = pluginCatalogue({ plugins: { steps: [step] }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  const onBehalf = (name) => {
    const row = store.tableRows('x_item').find((item) => item.x_name === name);
    return [row.createdonbehalfby, row.modifiedonbehalfby].map((ref) => ref?.id ?? ref ?? null);
  };
  create(null, 'as system');
  create(id('Invented second admin'), 'as another user');
  create(EMPTY, 'as context user');
  assert.deepEqual(onBehalf('as system'), [admin, admin]);
  assert.deepEqual(onBehalf('as another user'), [admin, admin]);
  assert.deepEqual(onBehalf('as context user'), [null, null]);
  assert.equal(targets.get('as system'), admin);
  assert.equal(targets.get('as another user'), admin);
  assert.equal(targets.get('as context user'), null);
});
