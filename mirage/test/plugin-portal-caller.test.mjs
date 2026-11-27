// @test-kind observation: hosted F2 session (paqvilo-developer hosted-f2 runs a/b choices and visit, runs e/f steps, every recorder trace of a portal call; the site ran at enhancedauthorization 3 per the session's setup correction): the plug-in context of a portal request reports UserId and InitiatingUserId as the site's host application user, IsPortalsClientCall true and PortalsContactId the signed-in contact
// Invented schema; the portal authorization is a stub of portal-authorization.mjs (readerUser, principalId,
// applicationUserId). `enhanced: true` is the captured state 3; the standard model (state 0) is not captured yet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { clrContext } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { remoteExecutionContext } from '../lib/dataverse-webhooks.mjs';
import { portalRecordWrites } from '../lib/form-service.mjs';
import { portalCallerUserId } from '../lib/plugin-portal-caller.mjs';

const APP_USER = '10000000-0000-0000-0000-0000000000a1',
  DESCRIPTOR_USER = '10000000-0000-0000-0000-000000000001',
  MAPPED_USER = '10000000-0000-0000-0000-0000000000b1',
  CONTACT = '20000000-0000-0000-0000-000000000001';
const visitor = { id: CONTACT, contactId: CONTACT, roles: [] };

function fixture({ enhanced = true } = {}) {
  const store = new DataStore({
    state: {
      version: 1,
      mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid' } },
      tables: {
        widget: [],
        systemuser: [
          { systemuserid: APP_USER, fullname: '# Portals-invented' },
          { systemuserid: MAPPED_USER, fullname: 'Mapped visitor' },
        ],
      },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'permissive' },
    },
  });
  store.portalAuthorization = {
    principalId: () => (enhanced ? MAPPED_USER : null),
    readerUser: () => (enhanced ? { systemuserid: MAPPED_USER } : { systemuserid: APP_USER }),
    applicationUserId: () => APP_USER,
  };
  return store;
}

const step = (stage, message = 'Create') => ({
  id: `30000000-0000-0000-0000-0000000000${stage}`,
  enabled: true,
  entity: 'widget',
  message,
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Recorder',
  assemblyId: 'invented',
});

test("with enhanced authorization a portal request's caller is the site's host application user, not the mapped user", () => {
  assert.equal(portalCallerUserId(fixture(), visitor), APP_USER);
  assert.equal(portalCallerUserId(fixture(), { admin: true }), null);
  assert.equal(portalCallerUserId(new DataStore({ state: { mappings: {}, tables: {} } }), visitor), null);
});

// @test-kind observation: hosted F2 state-0 runs s0n and s0q (paqvilo-developer hosted-f2 callers.json, digest-callers-s0n-s0q.json, enhancedauthorization 0): every stage-10 call of a portal path reports the host application user as caller and initiating user, IsPortalsClientCall true and PortalsContactId the contact, as in state 3
test('in the standard model the caller is the application user portal reads run as', () => {
  assert.equal(portalCallerUserId(fixture({ enhanced: false }), visitor), APP_USER);
});

test('a CLR plug-in context of a portal request reports the application user, the portal flag and the contact', () => {
  const store = fixture();
  const context = clrContext({
    runtime: {
      descriptor: {
        serviceProfile: { userId: DESCRIPTOR_USER, evidence: 'Invented portal caller', grants: [] },
        context: {
          executionUserId: DESCRIPTOR_USER,
          initiatingUserId: DESCRIPTOR_USER,
          organizationId: DESCRIPTOR_USER,
        },
      },
    },
    store,
    step: step(10),
    entity: 'widget',
    operation: 'create',
    stage: 10,
    target: { title: 'From the portal' },
    record: { widgetid: '40000000-0000-0000-0000-000000000001', title: 'From the portal' },
    frame: { portalRequest: true, portalContactId: CONTACT, portalCallerUserId: APP_USER, callerIdentity: visitor },
    depth: 1,
  }).context;
  assert.equal(context.UserId.value ?? context.UserId, APP_USER);
  assert.equal(context.InitiatingUserId.value ?? context.InitiatingUserId, APP_USER);
  assert.equal(context.IsPortalsClientCall, true);
  assert.equal(context.PortalsContactId.value, CONTACT);
  assert.equal(context.Stage, 10);
  assert.equal(context.Depth, 1);
});

// @test-kind observation: hosted F2 state-0 runs s0a and s0b (workflow.json execute:realtime, attach.json form saves): a real-time workflow's operation inside a portal call is a nested context (depth 2) that keeps IsPortalsClientCall true and PortalsContactId the contact, with the host application user as caller; a plug-in's own SDK call clears both (plugin-read-observation.test.mjs)
test("a real-time workflow's operation in a portal call keeps the portal facts at depth 2", () => {
  const store = fixture();
  const args = {
    runtime: {
      descriptor: {
        serviceProfile: { userId: DESCRIPTOR_USER, evidence: 'Invented portal caller', grants: [] },
        context: {
          executionUserId: DESCRIPTOR_USER,
          initiatingUserId: DESCRIPTOR_USER,
          organizationId: DESCRIPTOR_USER,
        },
      },
    },
    store,
    step: step(10, 'Update'),
    entity: 'widget',
    operation: 'update',
    stage: 10,
    target: { title: 'By the workflow' },
    record: { widgetid: '40000000-0000-0000-0000-000000000002', title: 'By the workflow' },
    depth: 2,
  };
  store.pluginParentContext = { $type: 'ExecutionContext', values: { Depth: 1 } };
  try {
    const inherited = clrContext({
      ...args,
      frame: { portalRequest: true, portalContactId: CONTACT, portalCallerUserId: APP_USER, portalInherited: true },
    }).context;
    assert.equal(inherited.IsPortalsClientCall, true);
    assert.equal(inherited.PortalsContactId.value, CONTACT);
    assert.equal(inherited.UserId.value ?? inherited.UserId, APP_USER);
    const sdkCall = clrContext({ ...args, frame: { portalRequest: true, portalContactId: CONTACT } }).context;
    assert.equal(sdkCall.IsPortalsClientCall, false);
    assert.equal(sdkCall.PortalsContactId.value, '00000000-0000-0000-0000-000000000000');
  } finally {
    delete store.pluginParentContext;
  }
});

test('a plug-in type handler of a portal form write runs as the application user', async () => {
  const store = fixture();
  const seen = [];
  const handlers = new Map([['Invented.Recorder', ({ context }) => void seen.push(context)]]);
  const items = pluginCatalogue({ plugins: { steps: [step(10)] }, handlers });
  store.setPluginPipeline((c) => runPluginPhase({ ...c, store, items, handlers }));
  await store.transact(() =>
    portalRecordWrites(store, { portalRequest: true }).create('widget', { title: 'From the portal' }, visitor),
  );
  assert.equal(seen.length, 1);
  assert.equal(seen[0].MessageName, 'Create');
  assert.equal(seen[0].UserId, APP_USER);
  assert.equal(seen[0].InitiatingUserId, APP_USER);
});

test('a web hook context of a portal write reports the application user, synchronous or after commit', async () => {
  const store = fixture();
  const frames = [];
  const items = pluginCatalogue({
    plugins: { steps: [step(10)] },
    handlers: new Map([['Invented.Recorder', () => {}]]),
  });
  store.setPluginPipeline((c) => {
    const frame = runPluginPhase({ ...c, store, items, handlers: new Map([['Invented.Recorder', () => {}]]) });
    if (c.stage === 10) frames.push(store.pluginFrames?.get(c.record) ?? null);
    return frame;
  });
  await store.transact(() =>
    portalRecordWrites(store, { portalRequest: true }).create('widget', { title: 'Hooked' }, visitor),
  );
  const row = store.tableRows('widget')[0];
  // The operation's frame carries the caller; the after-commit delivery hands it to the context (plugin-async.mjs).
  const portalCaller = store.pluginFrames.get(row)?.portalCallerUserId;
  assert.equal(portalCaller, APP_USER);
  const payload = remoteExecutionContext(store, {
    item: { id: '30000000-0000-0000-0000-0000000000f1', contract: { mode: 0 }, images: [] },
    entity: 'widget',
    operation: 'create',
    stage: 40,
    target: { title: 'Hooked' },
    record: row,
    previous: null,
    identity: visitor,
    portalCaller,
    depth: 1,
    correlationId: '30000000-0000-0000-0000-0000000000f2',
  });
  assert.equal(payload.InitiatingUserId, APP_USER);
  assert.equal(payload.UserId, APP_USER);
});
