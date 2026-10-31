// @test-kind parity: native sdkmessage/sdkmessagefilter catalogue rows (native filter catalogues native-filters.json and native-filters-2.json, platform constants); tests resting on other evidence carry their own tag
// @parity-evidence: audit round 2 (REG-n7): the registration probes exist in one native capture (corpus/native only), the custom API message lifecycle and the Upsert inert rule have no native capture, so those tests are tagged observation or unproven per test; the team, task and systemuser sets follow native-filters-2.json
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
import { createTraceStore } from '../lib/trace-store.mjs';

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

async function fixture(t, extraMappings = {}) {
  const f = await contractModuleFixture(t, {
    mappings: { ...mappings, ...extraMappings },
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

// The registered steps run as handler steps of the invented type; answers the catalogue getter.
function handlerPipeline(f, handlers) {
  const items = () =>
    pluginCatalogue({ plugins: { steps: f.steps() }, handlers }).map((item) => ({ ...item, mode: 'handler' }));
  f.store.setPluginPipeline(
    (context) => runPluginPhase({ ...context, store: f.store, items: items(), handlers }),
    ({ entity, operation }) =>
      items().some((step) => pluginStepMatchesEntity(step, entity) && String(step.message).toLowerCase() === operation),
  );
  return items;
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

// @test-kind parity: native filter catalogue rows (native-filters.json 'none' and table filters with their sdkmessage ids and flags; platform constants), standard SDK messages named by the official Microsoft.Xrm.Sdk / Microsoft.Crm.Sdk.Proxy request classes
// @parity-evidence: native-filters.json none rows ExecuteMultiple, ExecuteTransaction, UpsertMultipleLegacy, RetrieveEntity, SetProcess; native-filters-2.json team AddMembers (no AddMembersTeam filter)
test('the platform message catalogue carries the native ids, flags and none filters', async (t) => {
  const f = await fixture(t);
  const row = (name) => {
    const message = f.message(name);
    return (
      message && [
        message.sdkmessageid,
        message.isprivate,
        message.availability,
        message.autotransact,
        message.workflowsdkstepenabled,
      ]
    );
  };
  assert.deepEqual(row('ExecuteMultiple'), ['d7e702f4-1799-4419-af3f-547339060f39', false, 2, false, false]);
  assert.deepEqual(row('ExecuteTransaction'), ['c714829e-288c-4945-a022-d32c2d907825', false, 2, true, false]);
  assert.deepEqual(row('UpsertMultipleLegacy'), ['9483dd2f-1787-4d63-8ed2-79d33ee9551e', true, 2, true, false]);
  assert.deepEqual(row('RetrieveEntity'), ['71dc1ad4-4594-4326-aed8-dca5022f47ca', false, 2, false, false]);
  assert.deepEqual(row('SetProcess'), ['9eb7119b-d924-4610-a9ce-58a88303e8f6', false, 2, true, true]);
  for (const name of ['ExecuteMultiple', 'ExecuteTransaction', 'RetrieveEntity'])
    assert.deepEqual(
      [f.filter(name, 'none').iscustomprocessingstepallowed, f.filter(name, 'none').availability],
      [false, 2],
      name,
    );
  // A step on a 'none' filter that refuses custom steps is refused with the native code.
  const refused = await f.register('ExecuteMultiple', { table: 'none' });
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.code, '0x80044187');
  // The Web API action AddMembersTeam is the sdkmessage AddMembers: no AddMembersTeam row; AddMembers takes steps.
  const listed = await f.json(
    await f.request('GET', "/sdkmessages?$filter=name eq 'AddMembersTeam' or name eq 'SetParentTeam'&$select=name"),
    200,
  );
  assert.deepEqual(listed.value, []);
  assert.equal(f.message('AddMembers').isprivate, false);
});

// @test-kind observation: native and native-r2 _steps.json carry global Recorder steps on AddMembers (accepted); the team-filtered acceptance follows the native-filters-2.json team AddMembers filter (allowed); the local sdkmessage id of AddMembers is not recorded
test('global and team-filtered AddMembers steps register; an unknown message refuses', async (t) => {
  const f = await fixture(t, { team: { logicalName: 'team', entitySet: 'teams', idColumn: 'teamid', fields: {} } });
  assert.equal((await f.register('AddMembers')).status, 201);
  assert.equal((await f.register('AddMembers', { table: 'team' })).status, 201);
  const unknown = await f.request('POST', '/sdkmessageprocessingsteps', {
    name: 'Probe unknown message',
    stage: 20,
    mode: 0,
    'sdkmessageid@odata.bind': '/sdkmessages(00000000-0000-4000-8000-0000000000aa)',
    'eventhandler_plugintype@odata.bind': `/plugintypes(${TYPE})`,
  });
  assert.equal(unknown.status, 404);
});

// Native filter catalogue round 2: filter sets of contact, task, systemuser and team, and of an elastic, a virtual and an
// N:N intersect table (invented tables of those kinds here).
test('table kinds and further standard tables take their native filter sets', async (t) => {
  const kind = (logicalName, extra = {}) => ({
    logicalName,
    entitySet: `${logicalName}s`,
    idColumn: `${logicalName}id`,
    fields: {},
    ...extra,
  });
  const f = await contractModuleFixture(t, {
    mappings: {
      contact: kind('contact'),
      task: kind('task'),
      systemuser: kind('systemuser'),
      team: kind('team'),
      x_elastic: kind('x_elastic', { tableType: 'Elastic', ownership: 'UserOwned' }),
      x_virtual: kind('x_virtual', { isVirtual: true }),
      x_peer: kind('x_peer', { intersect: true }),
    },
    extension: { name: 'registration-kinds-probe', install: () => {} },
  });
  const names = new Map(f.store.tableRows('sdkmessage').map((row) => [row.sdkmessageid, row.name]));
  const filters = (table) =>
    Object.fromEntries(
      f.store
        .tableRows('sdkmessagefilter')
        .filter((row) => row.primaryobjecttypecode === table)
        .map((row) => [names.get(row.sdkmessageid), [row.iscustomprocessingstepallowed, row.availability]]),
    );
  assert.deepEqual(filters('x_peer'), { RetrieveMultiple: [true, 0] });
  assert.deepEqual(
    Object.keys(filters('x_virtual'))
      .filter((name) => name && !name.startsWith('OnExternal')) // the local external-event filters, see dataverse-plugins.md
      .sort(),
    [
      'Create',
      'CreateMultipleLegacy',
      'Delete',
      'Retrieve',
      'RetrieveEntityChanges',
      'RetrieveMultiple',
      'Update',
      'UpdateMultipleLegacy',
    ],
  );
  const elastic = filters('x_elastic');
  assert.deepEqual(
    [elastic.Upsert, elastic.UpsertMultiple, elastic.RetrieveEntityChanges],
    [
      [true, 0],
      [true, 0],
      [true, 0],
    ],
  );
  for (const name of ['SetState', 'IsValidStateTransition', 'GrantAccess'])
    assert.equal(elastic[name], undefined, name);
  // @parity-evidence: native-filters-2.json elastic table 25 filters incl. UpsertMultipleLegacy (its id from native-filters.json)
  assert.deepEqual(elastic.UpsertMultipleLegacy, [true, 0]);
  assert.equal(Object.keys(elastic).length, 25);
  // contact has 20 native filters; the three adx_ ones are Power Pages solution content (the exported Solution's messages).
  assert.equal(Object.keys(filters('contact')).length, 17);
  assert.equal(filters('contact').Retain, undefined);
  assert.deepEqual(filters('contact').IsValidStateTransition, [true, 0]);
  assert.deepEqual(filters('task').SetState, [true, 2]);
  // @parity-evidence: native-filters-2.json task 17 filters with Handle and Route allowed, availability 2
  assert.equal(Object.keys(filters('task')).length, 17);
  assert.deepEqual(
    [filters('task').Handle, filters('task').Route],
    [
      [true, 2],
      [true, 2],
    ],
  );
  // @parity-evidence: native-filters-2.json systemuser 18 filters (InviteUser, PromoteToAdmin, SetDevErrors private)
  assert.deepEqual(filters('systemuser'), {
    Create: [true, 0],
    Delete: [true, 0],
    InviteUser: [false, 0],
    PromoteToAdmin: [false, 2],
    ReassignObjects: [false, 0],
    RemoveParent: [false, 0],
    Retrieve: [false, 2],
    RetrieveAllChildUsers: [false, 2],
    RetrieveMultiple: [false, 2],
    RetrieveTeams: [false, 2],
    RetrieveUserSettings: [false, 2],
    SetBusiness: [false, 0],
    SetDevErrors: [false, 0],
    SetParent: [false, 0],
    SetState: [true, 0],
    SetStateDynamicEntity: [true, 0],
    Update: [true, 0],
    UpdateUserSettings: [false, 2],
  });
  assert.deepEqual(
    ['InviteUser', 'PromoteToAdmin', 'SetDevErrors', 'SetParent'].map(
      (name) => f.store.tableRows('sdkmessage').find((row) => row.name === name).isprivate,
    ),
    [true, true, true, false],
  );
  // @parity-evidence: native-filters-2.json team 12 filters with AddMembers and RemoveMembers allowed
  assert.deepEqual(filters('team'), {
    AddMembers: [true, 0],
    Archive: [true, 2],
    ConvertOwnerTeamToAccessTeam: [false, 0],
    Create: [true, 0],
    Delete: [true, 0],
    RemoveMembers: [true, 0],
    Retrieve: [true, 2],
    RetrieveMembers: [false, 2],
    RetrieveMultiple: [true, 2],
    SetParent: [false, 0],
    SyncGroupMembersToTeam: [false, 0],
    Update: [true, 0],
  });
});

// @test-kind observation: global steps accepted natively (native and native-r2 _steps.json: Recorder steps on PublishAll, Upsert, RetrieveExchangeRate, RetrieveEntityChanges, SetLocLabels); the refusing 'none' filter answer is one registration-probe capture
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

// @test-kind observation: native registration probes round 2 (corpus/native/_registration-probes-2.json, one capture)
// Native registration round 2 (single capture of deterministic validation): global WhoAmI/RetrieveVersion refused, images
// on SetStateDynamicEntity, GrantAccess and DeleteMultiple accepted, an unknown image attribute refused, a step without a
// stage accepted, a missing message refused, a client deployment on a server-only filter refused, and a plug-in type with a
// step not deleted.
test('registration round 2 rules answer with the native codes and texts', async (t) => {
  const f = await fixture(t);
  const refused = async (response, status, code, pattern) => {
    const { error } = await response.json();
    assert.equal(response.status, status, error?.message);
    assert.equal(error.code, code);
    assert.match(error.message, pattern);
  };
  for (const name of ['WhoAmI', 'RetrieveVersion'])
    await refused(
      await f.register(name),
      400,
      '0x80044187',
      new RegExp(
        `^Custom SdkMessageProcessingStep with Id: '[0-9a-f-]{36}' is not allowed on the message with SdkMessageId: '${f.message(name).sdkmessageid}'\\.$`,
      ),
    );
  const stepOf = async (name, over) => {
    const response = await f.register(name, over);
    assert.equal(response.status, 201, name);
    return (await response.json()).sdkmessageprocessingstepid;
  };
  const image = (stepId, imagetype, messagepropertyname, attributes) =>
    f.request('POST', '/sdkmessageprocessingstepimages', {
      name: 'img',
      entityalias: 'img',
      imagetype,
      messagepropertyname,
      ...(attributes ? { attributes } : {}),
      'sdkmessageprocessingstepid@odata.bind': `/sdkmessageprocessingsteps(${stepId})`,
    });
  for (const [name, type, property] of [
    ['SetStateDynamicEntity', 1, 'EntityMoniker'],
    ['GrantAccess', 0, 'Target'],
    ['DeleteMultiple', 0, 'Targets'],
  ])
    assert.equal(
      (await image(await stepOf(name, { table: 'x_owned', stage: 40 }), type, property)).status,
      201,
      `${name} image`,
    );
  await refused(
    await image(await stepOf('Update', { table: 'x_owned', stage: 40 }), 0, 'Target', 'x_nope'),
    400,
    '0x80081119',
    /^The step image 'img' \(id '[0-9a-f-]{36}'\) references attribute 'x_nope', which does not exist on entity 'x_owned'\. This step image is entity-specific/,
  );
  assert.equal(
    (await f.register('Update', { table: 'x_owned', stage: undefined })).status,
    201,
    'a step without a stage',
  );
  await refused(
    await f.request('POST', '/sdkmessageprocessingsteps', {
      name: 'No message',
      stage: 20,
      'eventhandler_plugintype@odata.bind': `/plugintypes(${TYPE})`,
    }),
    400,
    '0x80040200',
    /^sdkmessageid is missing\.$/,
  );
  await refused(
    await f.register('Update', { table: 'x_owned', supporteddeployment: 1 }),
    400,
    '0x80040203',
    /^Supported deployment does not agree with message availability$/,
  );
  const kept = await stepOf('Update', { table: 'x_owned' });
  await refused(
    await f.request('DELETE', `/plugintypes(${TYPE})`),
    400,
    '0x8004f01f',
    new RegExp(
      `^The PluginType\\(${TYPE}\\) component cannot be deleted because it is referenced by \\d+ other components\\. For a list of referenced components, use the RetrieveDependenciesForDeleteRequest\\.$`,
    ),
  );
  assert.equal((await f.request('GET', `/sdkmessageprocessingsteps(${kept})`)).status, 200, 'the step survives');
});

// @test-kind observation: native registration probes (corpus/native/_registration-probes.json, one capture)
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

// @test-kind unproven: inert global Upsert/UpsertMultiple steps are a local model; the Merge and async Retrieve parts cite mergeAccount and readAsync (native and native-r2)
test('execution admission: globals run on the actual table, Upsert/Merge globals are inert and async Retrieve runs', async (t) => {
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
  for (const message of ['Upsert', 'UpsertMultiple'])
    assert.equal(pluginStepMatchesEntity(of(message), 'x_owned'), false);
  // @parity-evidence: native recorder captures 2026-10-30 mergeAccount (native and native-r2): global Merge steps run 10/20/40 and async on a mergeable table; a table without a Merge filter refuses 0x80040800 before any step (sdkMerge)
  assert.equal(pluginStepMatchesEntity(of('Merge'), 'x_owned'), true);
  // @parity-evidence: native recorder captures 2026-10-30 readAsync (native and native-r2): global and table-filtered asynchronous Retrieve steps run once per GET when the row is kept (round 1 lost them to the row's deletion)
  assert.equal(pluginStepMatchesEntity(of('Retrieve', 1), 'x_owned'), true);
  // An accepted registration the platform never executes is not a runtime refusal.
  const store = { pluginPipeline: { steps: () => items.map((item) => ({ ...item, mode: 'handler' })) } };
  // @parity-evidence: native recorder captures 2026-10-30 mergeAccount (native and native-r2): global Merge steps execute, so Merge is no longer an accepted-but-never-executed registration
  for (const message of ['Upsert', 'UpsertMultiple'])
    assert.doesNotThrow(() => assertPluginMessageAdmission(store, message, {}, 'x_owned'), message);
  // An impersonating step is admitted (UserId is the impersonated user).
  assert.equal(
    pluginCatalogue({
      plugins: { steps: [{ ...f.steps().find((s) => s.message === 'Update'), impersonatingUserId: TYPE }] },
    })[0].unsupported,
    null,
  );
});

// @test-kind parity: native and native-r2 crud (global Create step on the created table) and reads (asynchronous RetrieveMultiple after a collection GET)
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
  const items = handlerPipeline(f, handlers);
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
  // @parity-evidence: native recorder corpus 2026-10-30 reads: a Web API collection GET hands RetrieveMultiple (also its asynchronous step) a FetchExpression of the read table, not a QueryExpression
  assert.match(seen[0].context.InputParameters.Query.query, /<entity name="x_shared">/);
  assert.equal(seen[0].context.OutputParameters.BusinessEntityCollection.length, 1);
});

// @test-kind unproven: the sdkmessage/sdkmessagefilter lifecycle of a runtime custom API (create, delete) is a local model until the NATIVE step-registration-rules capture; native customApi only proves the steps run around it
// Native customApi scenario: custom APIs provisioned over the Web API took steps at stages 10, 20, 40 and asynchronous
// PostOperation; the stage-10 step edited the Text input that later stages saw, and the reply carried the stage-40 output.
test('a custom API created at runtime gets its message and filter, and its registered steps run around it', async (t) => {
  const f = await fixture(t);
  await installCustomApi(f.api).ready; // the custom API extension the host installs
  f.store.traces = createTraceStore({ settings: { level: 'full' } }); // traced steps of an unbound API name no record
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

// @test-kind parity: native and native-r2 filters 'Probe: Update 40 filter modifiedon' and 'filter primary key' registered
// @parity-evidence: native and native-r2 filters Probe: Update 40 filter modifiedon / filter primary key (registered and ran x2)
test('Update 40 steps filtered on modifiedon and the primary key register and run on a PATCH of another column', async (t) => {
  const f = await fixture(t);
  for (const [name, attribute] of [
    ['Probe: Update 40 filter modifiedon', 'modifiedon'],
    ['Probe: Update 40 filter primary key', 'x_ownedid'],
  ])
    assert.equal(
      (await f.register('Update', { table: 'x_owned', stage: 40, name, filteringattributes: attribute })).status,
      201,
      name,
    );
  const seen = [];
  const handlers = pluginHandlers([
    {
      id: 'invented',
      pluginTypes: {
        [TYPE_NAME]: ({ step }) => {
          seen.push(step.name);
        },
      },
    },
  ]);
  handlerPipeline(f, handlers);
  assert.equal((await f.request('POST', '/x_owneds', { x_name: 'one' })).status, 201);
  const id = f.store.tableRows('x_owned')[0].x_ownedid;
  seen.length = 0;
  assert.equal((await f.request('PATCH', `/x_owneds(${id})`, { x_name: 'two' })).status, 200);
  assert.deepEqual(seen.sort(), ['Probe: Update 40 filter modifiedon', 'Probe: Update 40 filter primary key']);
});

// @test-kind parity: native and native-r2 filters 'Probe: Update 40 filter spaced' refused 0x8004f036 with the raw token
// @parity-evidence: native and native-r2 filters Probe: Update 40 filter spaced (refused 0x8004f036 naming the raw token ' PQWP_Integer ')
test('an Update 40 step filtered on a padded attribute name is refused with the raw token', async (t) => {
  const f = await fixture(t);
  const response = await f.register('Update', {
    table: 'x_owned',
    stage: 40,
    name: 'Probe: Update 40 filter spaced',
    filteringattributes: ' X_Name ',
  });
  const body = await response.json();
  assert.equal(response.status, 400, JSON.stringify(body));
  assert.equal(body.error.code, '0x8004f036');
  assert.match(
    body.error.message,
    /^The dependent component Attribute \(Id= X_Name \) does not exist\. {2}Failure trying to associate it with SdkMessageProcessingStep \(Id=[0-9a-f-]{36}\) as a dependency\. Missing dependency lookup type = AttributeNameLookup\.$/,
  );
  assert.equal(
    f.store.tableRows('sdkmessageprocessingstep').some((row) => row.name === 'Probe: Update 40 filter spaced'),
    false,
  );
});

// @test-kind observation: image attributes on platform columns follow the filtering-attribute rule (registration probes, one capture)
test('an image on an Update 40 step takes platform columns and the primary key', async (t) => {
  const f = await fixture(t);
  const stepId = (await (await f.register('Update', { table: 'x_owned', stage: 40 })).json())
    .sdkmessageprocessingstepid;
  const response = await f.request('POST', '/sdkmessageprocessingstepimages', {
    name: 'img',
    entityalias: 'img',
    imagetype: 1,
    messagepropertyname: 'Target',
    attributes: 'modifiedon,x_ownedid',
    'sdkmessageprocessingstepid@odata.bind': `/sdkmessageprocessingsteps(${stepId})`,
  });
  assert.equal(response.status, 201, await response.clone().text());
});

// @test-kind unproven: acceptance of these platform columns is not captured
test('the platform columns createdon, ownerid, statecode and versionnumber register as filtering attributes', async (t) => {
  const f = await fixture(t);
  for (const attribute of ['createdon', 'ownerid', 'statecode', 'versionnumber'])
    assert.equal(
      (
        await f.register('Update', {
          table: 'x_owned',
          stage: 40,
          name: `Probe: filter ${attribute}`,
          filteringattributes: attribute,
        })
      ).status,
      201,
      attribute,
    );
});
