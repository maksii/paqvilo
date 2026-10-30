// @test-kind security: plug-in SDK calls run as the CreateOrganizationService user (null SYSTEM, Guid.Empty the step's user, else that user) and are authorized by that user's Dataverse security roles; a user without the privilege is refused with the native privilege fault
// @parity-evidence: user explicitly approved C16 on 2026-10-30 (native run-as roles replace the grant profile); factory semantics from Microsoft Learn IOrganizationServiceFactory.CreateOrganizationService
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { sdkFault } from '../lib/plugin-sdk-messages.mjs';

const EMPTY = '00000000-0000-0000-0000-000000000000';

async function organization(t) {
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
      ],
    }),
  });
  t.after(() => runtime.close());
  const id = (name) => store.tableRows('systemuser').find((row) => row.fullname === name).systemuserid;
  // The descriptor profile grants nothing: authorization comes from the run-as user's roles.
  const profile = { userId: id('Invented admin'), evidence: 'Invented run-as step', grants: [] };
  const create = (userId, name, extra = {}) =>
    store.withOperationContext(() =>
      dispatchSdkCall({
        store,
        profile,
        invokingUserId: id('Invented admin'),
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
