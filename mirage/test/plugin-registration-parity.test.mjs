// @test-kind parity: native registration probes and sdkmessage/sdkmessagefilter rows recorded on a dev environment (catalogue, codes, admission)
// Registration catalogue, validation and execution admission that match native Dataverse (registration probes and
// sdkmessagefilter rows recorded on a dev environment; the data here is invented).
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { overlayRegisteredSteps } from '../lib/dataverse-plugin-registration.mjs';
import { pluginCatalogue, pluginHandlers, pluginStepMatchesEntity, runPluginPhase } from '../lib/exported-plugins.mjs';
import { assertPluginMessageAdmission } from '../lib/plugin-message-admission.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import { install as installCustomApi } from '../lib/dataverse-customapi.mjs';

const ASSEMBLY = '40000000-0000-4000-8000-0000000000a1';
const TYPE = '50000000-0000-4000-8000-0000000000a1';
const TYPE_NAME = 'Invented.Parity.Recorder';
const mappings = {
  x_owned: {
    logicalName: 'x_owned',
    entitySet: 'x_owneds',
    idColumn: 'x_ownedid',
    ownership: 'UserOwned',
    fields: { x_name: { dataverseType: 'nvarchar' }, ownerid: { dataverseType: 'owner' } },
  },
  x_shared: {
    logicalName: 'x_shared',
    entitySet: 'x_shareds',
    idColumn: 'x_sharedid',
    ownership: 'OrganizationOwned',
    fields: { x_name: { dataverseType: 'nvarchar' } },
  },
  // Platform tables (no business data): their native filter sets are platform constants.
  account: { logicalName: 'account', entitySet: 'accounts', idColumn: 'accountid', fields: {} },
  transactioncurrency: {
    logicalName: 'transactioncurrency',
    entitySet: 'transactioncurrencies',
    idColumn: 'transactioncurrencyid',
    fields: {},
  },
};

async function fixture(t) {
  const f = await contractModuleFixture(t, {
    mappings,
    tables: {
      pluginassembly: [{ pluginassemblyid: ASSEMBLY, name: 'Invented.Parity', version: '1.0.0.0' }],
      plugintype: [{ plugintypeid: TYPE, typename: TYPE_NAME, pluginassemblyid: ASSEMBLY }],
    },
    extension: { name: 'registration-parity-probe', install: () => {} },
  });
  const message = (name) => f.store.tableRows('sdkmessage').find((row) => row.name === name);
  const filter = (name, table) =>
    f.store
      .tableRows('sdkmessagefilter')
      .find((row) => row.sdkmessageid === message(name)?.sdkmessageid && row.primaryobjecttypecode === table);
  const register = (name, { table, ...over } = {}) =>
    f.request('POST', '/sdkmessageprocessingsteps', {
      name: `Probe ${name}`,
      stage: 20,
      mode: 0,
      'sdkmessageid@odata.bind': `/sdkmessages(${message(name).sdkmessageid})`,
      ...(table
        ? { 'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${filter(name, table).sdkmessagefilterid})` }
        : {}),
      'eventhandler_plugintype@odata.bind': `/plugintypes(${TYPE})`,
      ...over,
    });
  const steps = () => overlayRegisteredSteps({ assemblies: [], types: [], steps: [] }, f.store).steps;
  return { ...f, message, filter, register, steps };
}

test('per-table filters follow table capability, with the native message ids and flags', async (t) => {
  const f = await fixture(t);
  const messages = (table) =>
    new Set(
      f.store
        .tableRows('sdkmessagefilter')
        .filter((row) => row.primaryobjecttypecode === table)
        .map((row) => f.store.tableRows('sdkmessage').find((m) => m.sdkmessageid === row.sdkmessageid).name),
    );
  const owned = messages('x_owned'),
    shared = messages('x_shared');
  for (const name of [
    'Create',
    'Retrieve',
    'SetStateDynamicEntity',
    'DeleteMultiple',
    'Retain',
    'IsValidStateTransition',
  ])
    assert.ok(owned.has(name) && shared.has(name), name);
  for (const name of ['Assign', 'GrantAccess', 'RetrievePrincipalAccess', 'RetrieveSharedPrincipalsAndAccess'])
    assert.ok(owned.has(name) && !shared.has(name), name);
  for (const name of ['UpsertMultiple', 'Upsert', 'Associate', 'Merge']) assert.ok(!owned.has(name), name);
  assert.equal(f.filter('IsValidStateTransition', 'x_owned').iscustomprocessingstepallowed, false);
  assert.deepEqual(
    Object.fromEntries(
      ['Associate', 'Disassociate', 'Execute', 'Upsert', 'UpsertMultiple', 'Merge'].map((name) => [
        name,
        f.filter(name, 'none').iscustomprocessingstepallowed,
      ]),
    ),
    { Associate: true, Disassociate: true, Execute: true, Upsert: false, UpsertMultiple: false, Merge: false },
  );
  assert.equal(f.message('UpsertMultiple').sdkmessageid, 'a37ff683-98b5-4325-953f-9a338240dbf0');
  assert.equal(f.message('Retrieve').autotransact, false);
  assert.equal(f.message('RetrievePrincipalAccess').autotransact, false);
  assert.equal(f.message('Create').autotransact, true);
  assert.equal(f.message('Archive').isprivate, true);
});

// Native sdkmessagefilter rows of the standard tables account and transactioncurrency, and of the 'none' filters.
test('standard tables take their native filter sets, flags and availability', async (t) => {
  const f = await fixture(t);
  const filters = (table) =>
    Object.fromEntries(
      f.store
        .tableRows('sdkmessagefilter')
        .filter((row) => row.primaryobjecttypecode === table)
        .map((row) => [
          f.store.tableRows('sdkmessage').find((m) => m.sdkmessageid === row.sdkmessageid).name,
          [row.iscustomprocessingstepallowed, row.availability],
        ]),
    );
  assert.deepEqual(filters('transactioncurrency'), {
    Create: [true, 0],
    Delete: [true, 0],
    Retrieve: [false, 2],
    RetrieveExchangeRate: [true, 2],
    RetrieveMultiple: [false, 2],
    SetState: [true, 0],
    SetStateDynamicEntity: [true, 0],
    Update: [true, 0],
  });
  const account = filters('account');
  assert.equal(Object.keys(account).length, 26);
  assert.equal(Object.hasOwn(account, 'DeleteMultiple'), false);
  assert.deepEqual(account.IsValidStateTransition, [true, 0]);
  assert.deepEqual(account.Assign, [true, 0]);
  assert.deepEqual(account.Merge, [true, 0]);
  assert.deepEqual(account.Create, [true, 2]);
  assert.ok(Object.values(account).every(([allowed]) => allowed));
  // Custom tables keep availability 0; the platform 'none' filters carry theirs.
  assert.equal(f.filter('Create', 'x_owned').availability, 0);
  assert.deepEqual(
    ['Associate', 'Upsert', 'Merge', 'WhoAmI', 'PublishAll'].map((name) => [
      f.filter(name, 'none').iscustomprocessingstepallowed,
      f.filter(name, 'none').availability,
    ]),
    [
      [true, 2],
      [false, 2],
      [false, 2],
      [false, 2],
      [true, 0],
    ],
  );
  assert.equal(f.message('PublishAll').sdkmessageid, 'debdbb1b-ea3e-db11-86a7-000a3a5473e8');
  assert.deepEqual([f.message('PublishAll').availability, f.message('PublishAll').autotransact], [0, false]);
  assert.equal(f.message('RetrieveEntityChanges').availability, 2);
  assert.equal((await f.register('IsValidStateTransition', { table: 'account' })).status, 201);
  const refused = await f.register('Retrieve', { table: 'transactioncurrency' });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, '0x80044187');
});

// Native accepted global (no filter) steps on every existing message: PublishAll and RetrieveExchangeRate (no table filter
// in scope), Upsert (its 'none' filter refuses custom steps); a step registered on that refusing 'none' filter is refused.
test('a step without a filter is accepted on any existing message; a refusing filter still refuses', async (t) => {
  const f = await fixture(t);
  for (const name of ['PublishAll', 'Upsert', 'RetrieveExchangeRate', 'RetrieveEntityChanges', 'SetLocLabels'])
    assert.equal((await f.register(name)).status, 201, name);
  const refused = await f.register('Upsert', { table: 'none' });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, '0x80044187');
});

test('registration validation answers with the native codes and texts', async (t) => {
  const f = await fixture(t);
  const refused = async (response, code, pattern) => {
    const body = await response.json();
    assert.equal(response.status, 400, JSON.stringify(body));
    assert.equal(body.error.code, code);
    assert.match(body.error.message, pattern);
  };
  const id = '60000000-0000-4000-8000-0000000000a1';
  await refused(
    await f.register('Update', { table: 'x_owned', sdkmessageprocessingstepid: id, name: 'Async early', mode: 1 }),
    '0x80040203',
    new RegExp(
      `^Asynchronous steps are only supported in AfterMainOperationInsideTransaction stages and AfterMainOperationOutsideTransaction stage\\. SdkMessageProcessingStep name 'Async early', id '${id}'\\.$`,
    ),
  );
  await refused(
    await f.register('IsValidStateTransition', { table: 'x_owned', sdkmessageprocessingstepid: id }),
    '0x80044187',
    new RegExp(
      `SdkMessageProcessingStepId: '${id}', SdkMessageFilterId: '${f.filter('IsValidStateTransition', 'x_owned').sdkmessagefilterid}'\\.$`,
    ),
  );
  await refused(
    await f.register('Update', { table: 'x_owned', sdkmessageprocessingstepid: id, filteringattributes: 'x_nope' }),
    '0x8004f036',
    /^The dependent component Attribute \(Id=x_nope\) does not exist\./,
  );
  for (const [name, over] of [
    ['Update', { table: 'x_owned', rank: -1 }],
    ['Retrieve', { table: 'x_owned', stage: 40, mode: 1 }],
    ['RetrieveMultiple', { table: 'x_owned', stage: 40, mode: 1 }],
    ['Assign', { table: 'x_owned', stage: 40, mode: 1 }],
    ['RetrievePrincipalAccess', { table: 'x_owned', stage: 40, mode: 1 }],
    ['DeleteMultiple', { table: 'x_owned' }],
    ['Upsert', {}],
    ['Merge', {}],
    ['UpsertMultiple', {}],
    ['Create', { stage: 40, mode: 1 }],
    ['Associate', { stage: 40, mode: 1 }],
  ])
    assert.equal((await f.register(name, over)).status, 201, name);
  // Images: the type is checked before the property; Retrieve takes a post-image on Target.
  const step = async (name, over) => (await (await f.register(name, over)).json()).sdkmessageprocessingstepid;
  const image = (stepId, imagetype, messagepropertyname = 'Target') =>
    f.request('POST', '/sdkmessageprocessingstepimages', {
      name: 'img',
      entityalias: 'img',
      imagetype,
      messagepropertyname,
      'sdkmessageprocessingstepid@odata.bind': `/sdkmessageprocessingsteps(${stepId})`,
    });
  await refused(
    await image(await step('Create', { table: 'x_owned' }), 0),
    '0x8004416d',
    /^Message Create does not support this image type\.$/,
  );
  assert.equal((await image(await step('Retrieve', { table: 'x_owned', stage: 40 }), 1)).status, 201);
  assert.equal((await image(await step('Update', { stage: 40 }), 0)).status, 201, 'image on a global Update');
});

test('execution admission: globals run on the actual table, Upsert/Merge globals and async Retrieve are inert', async (t) => {
  const f = await fixture(t);
  for (const [name, over] of [
    ['Create', {}],
    ['Upsert', {}],
    ['UpsertMultiple', {}],
    ['Merge', {}],
    ['Retrieve', { table: 'x_owned', stage: 40, mode: 1 }],
    ['RetrieveMultiple', { stage: 40, mode: 1 }],
    ['Update', { table: 'x_owned' }],
  ])
    assert.equal((await f.register(name, over)).status, 201, name);
  const items = pluginCatalogue({
    plugins: { steps: f.steps() },
    handlers: pluginHandlers([{ id: 'invented', pluginTypes: { [TYPE_NAME]: () => {} } }]),
  });
  for (const item of items) assert.equal(item.unsupported, null, item.message);
  const of = (message, mode = 0) => items.find((item) => item.message === message && item.contract.mode === mode);
  assert.equal(pluginStepMatchesEntity(of('Create'), 'x_shared'), true);
  assert.equal(pluginStepMatchesEntity(of('RetrieveMultiple', 1), 'x_owned'), true);
  for (const message of ['Upsert', 'UpsertMultiple', 'Merge'])
    assert.equal(pluginStepMatchesEntity(of(message), 'x_owned'), false);
  assert.equal(pluginStepMatchesEntity(of('Retrieve', 1), 'x_owned'), false);
  // An accepted registration the platform never executes is not a runtime refusal.
  const store = { pluginPipeline: { steps: () => items.map((item) => ({ ...item, mode: 'handler' })) } };
  for (const message of ['Upsert', 'UpsertMultiple', 'Merge'])
    assert.doesNotThrow(() => assertPluginMessageAdmission(store, message, {}, 'x_owned'), message);
  // An impersonating step is admitted (UserId is the impersonated user).
  assert.equal(
    pluginCatalogue({
      plugins: { steps: [{ ...f.steps().find((s) => s.message === 'Update'), impersonatingUserId: TYPE }] },
    })[0].unsupported,
    null,
  );
});

test('a global Create runs for the table it fires on, and an asynchronous RetrieveMultiple runs after the read', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.register('Create', { name: 'Global create' })).status, 201);
  assert.equal((await f.register('RetrieveMultiple', { name: 'Async read', stage: 40, mode: 1 })).status, 201);
  const seen = [];
  const handlers = pluginHandlers([
    {
      id: 'invented',
      pluginTypes: {
        [TYPE_NAME]: ({ step, context, operation }) => {
          seen.push({ name: step.name, entity: context.PrimaryEntityName, operation, mode: context.Mode, context });
        },
      },
    },
  ]);
  const items = () =>
    pluginCatalogue({ plugins: { steps: f.steps() }, handlers }).map((item) => ({ ...item, mode: 'handler' }));
  f.store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store: f.store, items: items(), handlers }),
    ({ entity, operation }) =>
      items().some((step) => pluginStepMatchesEntity(step, entity) && String(step.message).toLowerCase() === operation),
  );
  const runner = createAsyncPluginRunner({ store: f.store, items, handlers });
  t.after(() => runner.close());
  const created = await f.request('POST', '/x_shareds', { x_name: 'one' });
  assert.equal(created.status, 201, await created.clone().text());
  assert.deepEqual(
    seen.map(({ name, entity }) => [name, entity]),
    [['Global create', 'x_shared']],
  );
  seen.length = 0;
  assert.equal((await f.request('GET', '/x_shareds?$select=x_name')).status, 200);
  await f.store.transact(() => {}); // the read stages its event in its own queued transaction
  await runner.drain();
  assert.deepEqual(
    seen.map(({ name, entity, mode }) => [name, entity, mode]),
    [['Async read', 'x_shared', 1]],
  );
  assert.equal(seen[0].context.InputParameters.Query.entityName, 'x_shared');
  assert.equal(seen[0].context.OutputParameters.BusinessEntityCollection.length, 1);
});

// Native customApi scenario: custom APIs provisioned over the Web API took steps at stages 10, 20, 40 and asynchronous
// PostOperation; the stage-10 step edited the Text input that later stages saw, and the reply carried the stage-40 output.
test('a custom API created at runtime gets its message and filter, and its registered steps run around it', async (t) => {
  const f = await fixture(t);
  await installCustomApi(f.api).ready; // the custom API extension the host installs
  const api = '41000000-0000-4000-8000-0000000000a1';
  const created = await f.request('POST', '/customapis', {
    customapiid: api,
    uniquename: 'x_Ping',
    name: 'x_Ping',
    displayname: 'Invented ping',
    description: 'Invented runtime custom API',
    bindingtype: 0,
    isfunction: false,
    allowedcustomprocessingsteptype: 2,
    CustomAPIRequestParameters: [{ uniquename: 'Text', name: 'Text', displayname: 'Text', description: 'x', type: 10 }],
    CustomAPIResponseProperties: [
      { uniquename: 'Reply', name: 'Reply', displayname: 'Reply', description: 'x', type: 10 },
    ],
  });
  assert.equal(created.status, 201, await created.clone().text());
  const listed = await f.json(
    await f.request('GET', "/sdkmessages?$filter=name eq 'x_Ping'&$select=sdkmessageid"),
    200,
  );
  assert.equal(listed.value.length, 1);
  assert.equal(f.filter('x_Ping', 'none').iscustomprocessingstepallowed, true);
  for (const [stage, mode] of [
    [10, 0],
    [20, 0],
    [40, 0],
  ])
    assert.equal((await f.register('x_Ping', { name: `Ping ${stage}`, stage, mode })).status, 201, `stage ${stage}`);
  // The registered steps run the invented type's handler: stage 10 edits the input, stage 40 sets the reply.
  const seen = [];
  const ping = ({ context }) => {
    seen.push([context.Stage, context.InputParameters.Text]);
    if (context.Stage === 10) context.InputParameters.Text = 'edited at 10';
    if (context.Stage === 40) context.OutputParameters.Reply = `post ${context.InputParameters.Text}`;
  };
  const handlers = pluginHandlers([{ id: 'invented', pluginTypes: { [TYPE_NAME]: ping } }]);
  const running = () =>
    pluginCatalogue({ plugins: { steps: f.steps() }, handlers })
      .filter((item) => item.message === 'x_Ping')
      .map((item) => Object.assign(item, { mode: 'handler' }));
  f.store.setPluginPipeline(
    (phase) => runPluginPhase({ ...phase, store: f.store, items: running(), handlers }),
    ({ operation }) => operation === 'x_ping' && running().length > 0,
  );
  const reply = await f.json(await f.request('POST', '/x_Ping', { Text: 'hello' }), 200);
  assert.equal(reply.Reply, 'post edited at 10');
  assert.deepEqual(seen, [
    [10, 'hello'],
    [20, 'edited at 10'],
    [40, 'edited at 10'],
  ]);
  for (const step of f.store.tableRows('sdkmessageprocessingstep'))
    assert.equal(
      (await f.request('DELETE', `/sdkmessageprocessingsteps(${step.sdkmessageprocessingstepid})`)).status,
      204,
    );
  assert.equal((await f.request('DELETE', `/customapis(${api})`)).status, 204);
  assert.equal(f.message('x_Ping'), undefined, 'deleting the API removes its message');
  assert.equal(
    f.store.tableRows('sdkmessagefilter').some((row) => row.sdkmessageid === listed.value[0].sdkmessageid),
    false,
  );
});

// A global Create runs PreValidation for every create; its Target round trip carries SDK values (an option array for a
// choices column, a DateTime for a DateOnly column), which must not be refused as Web API wire input.
// @test-kind unproven: local re-coercion of SDK Target values into Web API storage; not itself a native capture
test('a PreValidation Target with SDK choices and DateOnly values is stored like the Web API values', async (t) => {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_pick: {
        logicalName: 'x_pick',
        entitySet: 'x_picks',
        idColumn: 'x_pickid',
        fields: {
          x_day: { dataverseType: 'datetime', format: 'dateonly', behavior: 'DateOnly' },
          x_choices: {
            dataverseType: 'multiselectpicklist',
            options: [
              { value: 1, label: 'One' },
              { value: 2, label: 'Two' },
            ],
          },
        },
      },
    },
    extension: { name: 'registration-parity-choices', install: () => {} },
  });
  f.store.setPluginPipeline(
    ({ stage, target }) => {
      if (stage === 10) Object.assign(target, { x_choices: [1, 2], x_day: '2026-10-30T00:00:00.0000000' });
    },
    ({ operation }) => operation === 'create',
  );
  const created = await f.request('POST', '/x_picks', { x_choices: '1', x_day: '2026-10-29' });
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal(f.store.tableRows('x_pick')[0].x_choices, '1,2');
  assert.equal(f.store.tableRows('x_pick')[0].x_day, '2026-10-30');
});
