// @test-kind unproven: local model of read observer ordering, serialization, snapshots and rollback; no native capture cited
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore } from '../lib/data.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { clrContext, dispatchSdkCall, prepareClrRuntime, recordToSdkEntity } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const writer = '10000000-0000-0000-0000-000000000002',
  user = '10000000-0000-0000-0000-000000000001',
  contact = '20000000-0000-0000-0000-000000000001';
const profile = {
  userId: user,
  evidence: 'Invented read observer recording contract',
  grants: [
    { entity: 'widget', operations: ['read'] },
    { entity: 'audit', operations: ['read', 'create'] },
  ],
};
const fixture = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid' },
        audit: { entitySet: 'audits', idColumn: 'auditid' },
      },
      tables: { widget: [{ widgetid: contact, title: 'Existing' }], audit: [] },
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'permissive' },
    },
  });
const step = (stage, index = stage) => ({
  id: '30000000-0000-0000-0000-' + String(index).padStart(12, '0'),
  enabled: true,
  entity: 'widget',
  message: 'RetrieveMultiple',
  stage,
  rank: 1,
  mode: 0,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Recorder',
  assemblyId: 'invented',
});

test('Read requests run ordered PreValidation, PreOperation and PostOperation observers', () => {
  const store = fixture(),
    seen = [],
    steps = [step(40), step(10), step(20)],
    handlers = new Map(
      steps.map((s) => [
        s.id,
        (c) => {
          seen.push({ stage: c.stage, query: c.query, collection: c.collection });
        },
      ]),
    );
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  assert.ok(items.every((item) => !item.unsupported));
  store.setPluginPipeline((c) => runPluginPhase({ ...c, store, items, handlers }));
  assert.equal(store.query('widgets', { $select: 'title' }, { admin: true }).value[0].title, 'Existing');
  assert.deepEqual(
    seen.map((c) => c.stage),
    [10, 20, 40],
  );
  assert.equal(seen[0].collection, undefined);
  assert.equal(seen[2].collection.entities.length, 1);
});

test('Serialized read boundaries avoid state writes for pure reads and preserve independent observer writes after rejection', async () => {
  const store = fixture(),
    initial = store.revision;
  await store.readOperation(() => store.query('widgets', {}, { admin: true }));
  assert.equal(store.revision, initial);
  const steps = [step(20), step(40)],
    handlers = new Map([
      [
        steps[0].id,
        () => {
          localOrganizationService(store, profile).create('audit', { title: 'Incoming query recorded' });
        },
      ],
      [steps[1].id, (c) => c.reject('Later observer rejected')],
    ]),
    items = pluginCatalogue({ plugins: { steps }, handlers });
  store.setPluginPipeline((c) => runPluginPhase({ ...c, store, items, handlers }));
  await assert.rejects(
    store.readOperation(() => store.query('widgets', {}, { admin: true })),
    /Later observer rejected/,
  );
  assert.equal(store.snapshot().tables.audit.length, 1);
  assert.equal(store.snapshot().tables.audit[0].title, 'Incoming query recorded');
  assert.equal(store.pluginInTransaction, undefined);
  assert.equal(store.pluginReadOnly, undefined);
});

test('ordinary serialized reads avoid traversing unrelated state and retain queued write ordering', async () => {
  const store = fixture();
  let traversals = 0,
    release,
    entered;
  store.state.tables.unrelated = [{ id: 'unrelated' }];
  Object.defineProperty(store.state.tables.unrelated[0], 'largePayload', {
    enumerable: true,
    get() {
      traversals++;
      return 'unused';
    },
  });
  store.setPluginPipeline(
    () => {
      throw Error('An inactive observer must not run');
    },
    () => false,
  );
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  const write = store.transact(async () => {
    entered();
    await gate;
    store.state.tables.widget[0].title = 'After queued write';
  });
  await started;
  let ran = false;
  const read = store.readOperation(() => {
    ran = true;
    const before = traversals;
    const result = store.query('widgets', { $select: 'title' }, { admin: true });
    assert.equal(traversals, before, 'A pure read must not clone or serialize unrelated rows');
    return result;
  });
  assert.equal(ran, false);
  release();
  await write;
  assert.equal((await read).value[0].title, 'After queued write');
  assert.equal(store.revision, 1);
  const state = store.state;
  await assert.rejects(
    store.readOperation(() => {
      throw Error('Pure read rejected');
    }),
    /Pure read rejected/,
  );
  assert.equal(store.state, state, 'A failed pure read needs no restored state copy');
});

test('lazy read snapshots precede direct observer mutations and direct SDK writes', async () => {
  const store = fixture();
  store.setPluginPipeline(
    ({ stage }) => {
      if (stage === 10) {
        store.state.tables.widget[0].title = 'Uncommitted observer mutation';
        throw Error('Observer failed');
      }
    },
    ({ operation }) => operation === 'retrieve',
  );
  await assert.rejects(
    store.readOperation(() => store.get('widget', contact, { admin: true })),
    /Observer failed/,
  );
  assert.equal(store.state.tables.widget[0].title, 'Existing');
  assert.equal(store.revision, 0);
  await store.readOperation(() =>
    localOrganizationService(store, profile).create('audit', { title: 'Direct SDK write' }),
  );
  assert.equal(store.state.tables.audit[0].title, 'Direct SDK write');
  assert.equal(store.revision, 1);
});

test('Unserialized original SDK observer writes still fail before modifying data', () => {
  const store = fixture();
  store.pluginReadOnly = true;
  assert.throws(
    () =>
      dispatchSdkCall({
        store,
        profile,
        message: {
          method: 'Create',
          userId: user,
          arguments: [{ $type: 'Entity', logicalName: 'audit', attributes: { title: 'Unsafe' } }],
        },
      }),
    (error) => error.code === 'LocalPluginReadWriteUnsupported',
  );
  assert.equal(store.snapshot().tables.audit.length, 0);
});

test('Observers receive permission-expanded XML before the main join limit is enforced and backend captures survive failure', async () => {
  const store = fixture();
  store.state.settings.permissionMode = 'enforce';
  store.state.mappings.branch = { entitySet: 'branches', idColumn: 'branchid' };
  store.state.tables.branch = [
    { branchid: 'a', manager: contact },
    { branchid: 'b', manager: user },
  ];
  store.state.tables.widget[0].branchid = 'a';
  store.state.tables.widget.push({ widgetid: user, title: 'Other branch', branchid: 'b' });
  store.state.permissions = [
    {
      id: 'branch-root',
      entity: 'branch',
      scope: 'contact',
      field: 'manager',
      roles: ['Manager'],
      operations: ['read'],
    },
    {
      id: 'widget-child',
      entity: 'widget',
      scope: 'parent',
      parentPermissionId: 'branch-root',
      relationship: { entity: 'branch', from: 'branchid', to: 'branchid' },
      roles: ['Manager'],
      operations: ['read'],
    },
  ];
  const visitor = { contactId: contact, roles: ['Manager'] },
    seen = [];
  store.setPluginPipeline(
    (c) => {
      seen.push({ stage: c.stage, xml: c.query.query });
      if (c.stage === 10)
        localOrganizationService(store, profile).create('audit', { title: 'Query received', query: c.query.query });
    },
    (c) => c.entity === 'widget' && c.operation === 'retrievemultiple',
  );
  const xml =
    '<fetch distinct="true"><entity name="widget"><attribute name="widgetid"/><link-entity name="branch" from="branchid" to="branchid" alias="authored"><attribute name="branchid"/></link-entity></entity></fetch>';
  const result = await store.readOperation(() => store.fetchXml(xml, visitor, { portalRequest: true }));
  assert.deepEqual(
    result.entities.map((row) => row.widgetid),
    [contact],
  );
  assert.deepEqual(
    seen.map((c) => c.stage),
    [10, 20, 40],
  );
  assert.ok(seen.every((c) => c.xml === result.xml));
  assert.match(result.xml, /alias="generated_alias_branch_0"/);
  assert.match(result.xml, /entityname="generated_alias_branch_0" attribute="manager" operator="eq"/);
  assert.equal(result.permissionQuery.permissionLinkCount, 1);
  assert.equal(result.permissionQuery.totalLinkCount, 2);
  store.state.simulator = { ...(store.state.simulator ?? {}), platformOverrides: { QueryLinkEntityLimit: 1 } };
  seen.length = 0;
  await assert.rejects(
    store.readOperation(() => store.fetchXml(xml, visitor, { portalRequest: true })),
    (error) => error.details?.innerCode === '0x8004430d',
  );
  assert.deepEqual(
    seen.map((c) => c.stage),
    [10, 20],
  );
  assert.equal(store.snapshot().tables.audit.length, 2);
  assert.equal(store.snapshot().tables.audit[1].query, result.xml);
  store.state.simulator.platformOverrides = { QueryLinkEntityLimit: 15 };
  store.state.mappings.privateinfo = { entitySet: 'privateinfos', idColumn: 'privateinfoid' };
  store.state.tables.privateinfo = [{ privateinfoid: 'secret', widgetid: contact, title: 'Protected data' }];
  const originalState = store.snapshot();
  store.setPluginPipeline(
    (c) => {
      if (c.stage === 20)
        c.query.query = c.query.query.replace(
          /<attribute name="widgetid"\s*\/>/,
          '<attribute name="widgetid"/><link-entity name="privateinfo" from="widgetid" to="widgetid" alias="ungranted"><attribute name="title"/></link-entity>',
        );
    },
    (c) => c.entity === 'widget' && c.operation === 'retrievemultiple',
  );
  await assert.rejects(
    store.readOperation(() => store.fetchXml(xml, visitor, { portalRequest: true })),
    (error) => error.code === 'LocalPluginQueryUnsupported' && /link structure/.test(error.message),
  );
  assert.deepEqual(store.snapshot(), originalState);
});

test('The scalar portal OData adapter exposes modeled expansion while independent SDK reads keep their original query language', () => {
  const store = fixture();
  store.state.settings.permissionMode = 'enforce';
  store.state.permissions = [
    { id: 'principal', entity: 'widget', scope: 'self', roles: ['Member'], operations: ['read'] },
  ];
  const visitor = { contactId: contact, roles: ['Member'] },
    seen = [];
  store.setPluginPipeline(
    (c) => seen.push(structuredClone(c.query)),
    (c) => c.entity === 'widget' && c.operation === 'retrievemultiple',
  );
  const result = store.query('widgets', { $select: 'widgetid,title', $count: 'true' }, visitor, undefined, {
    portalRequest: true,
  });
  assert.equal(result.value.length, 1);
  assert.equal(result['@odata.count'], 1);
  assert.equal(result.permissionQuery.transport, 'modeled-scalar-odata-adapter');
  assert.ok(seen.every((query) => query.$type === 'FetchExpression'));
  assert.match(seen[0].query, /attribute="widgetid" operator="eq"/);
  seen.length = 0;
  localOrganizationService(store, profile).query('widgets', { $select: 'title' });
  assert.ok(seen.every((query) => query.$type === 'QueryExpression'));
  // Bound single-record reads must retain their options instead of returning
  // the first visible row from an unbound Fetch adapter.
  seen.length = 0;
  assert.deepEqual(
    store.query('widgets', { $select: 'widgetid,title' }, visitor, undefined, { portalRequest: true, id: user }).value,
    [],
  );
  assert.ok(seen.every((query) => query.$type === 'QueryExpression'));
});

// @test-kind parity+contract: native dev-environment recorded contexts (SecondaryEntityName none, nested calls not portal calls); transport flag is local design
test('Context2 portal identity requires an explicit transport flag and clears on nested SDK context', () => {
  const store = fixture(),
    frame = { portalRequest: true, portalContactId: contact },
    args = {
      runtime: {
        descriptor: {
          serviceProfile: profile,
          context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
        },
      },
      store,
      step: step(20),
      entity: 'widget',
      operation: 'retrievemultiple',
      stage: 20,
      record: { widgetid: contact },
      frame,
      depth: 1,
    };
  const first = clrContext(args).context;
  assert.equal(first.IsPortalsClientCall, true);
  assert.equal(first.PortalsContactId.value, contact);
  // Native reports 'none' for every message, reads included (recorded dev-environment contexts).
  assert.equal(first.SecondaryEntityName, 'none');
  assert.equal(clrContext(args).context.RequestId.value, first.RequestId.value);
  store.pluginParentContext = { $type: 'ExecutionContext', values: first };
  const nested = clrContext({ ...args, frame: { ...frame } }).context;
  assert.equal(nested.IsPortalsClientCall, false);
  assert.equal(nested.PortalsContactId.value, '00000000-0000-0000-0000-000000000000');
  assert.equal(nested.Depth, 2);
  delete store.pluginParentContext;
  assert.equal(clrContext({ ...args, frame: {} }).context.IsPortalsClientCall, false);
});

test('SDK frames retain independently computed cookies and RowVersion metadata without changing selected attributes', () => {
  const store = fixture();
  store.state.mappings.widget.sdkRowVersionColumn = 'revision';
  store.state.tables.widget[0].revision = '123456789';
  const frame = {
      query: { $type: 'FetchExpression', query: '<fetch/>' },
      collection: { $type: 'EntityCollection', entities: [], pagingCookie: '' },
    },
    args = {
      runtime: {
        descriptor: {
          serviceProfile: profile,
          context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
        },
      },
      store,
      step: step(40),
      entity: 'widget',
      operation: 'retrievemultiple',
      stage: 40,
      record: { widgetid: contact },
      frame,
      depth: 1,
    };
  assert.equal(clrContext(args).outputParameters.values.BusinessEntityCollection.pagingCookie, '');
  frame.collection.pagingCookie = null;
  assert.equal(clrContext(args).outputParameters.values.BusinessEntityCollection.pagingCookie, null);
  const projected = recordToSdkEntity(
    store,
    'widget',
    { widgetid: contact, title: 'Existing' },
    { columns: ['title'] },
  );
  assert.equal(projected.rowVersion, '123456789');
  assert.deepEqual(projected.attributes, { title: 'Existing' });
});

// @test-kind parity: native dev-environment recorder corpus (pipelineEffects): nested Create parent is its stage-30 main operation, caller one level up
test(
  'Original CLR read recorder sees portal context in all three stages and records through SDK with nested identity cleared',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-read-observation-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      assembly = path.join(root, 'Recorder.dll'),
      source = path.join(root, 'Recorder.cs');
    // @parity-evidence: native dev-environment recorder corpus readNested (two captures): a nested Create from a read step has InitiatingUserId = the SDK service user, not the read caller
    // Native (parity corpus pipelineEffects): a nested Create PreOperation's parent is its own Create main operation (in the transaction, not a portal call); the caller is one level up.
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Query;namespace Invented {
 public sealed class Recorder:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext7)services.GetService(typeof(IPluginExecutionContext7));if(c.EnvironmentId!="observed-local-environment"||c.TenantId!=new Guid("${user}")||!c.IsApplicationUser||c.InitiatingUserAgent==null||c.PreEntityImagesCollection.Length!=0||c.PostEntityImagesCollection.Length!=0)throw new InvalidPluginExecutionException("Context7 observations mismatch");if(!(c.InputParameters["AppModuleId"] is Guid)||(bool)c.InputParameters["IsAppModuleContext"])throw new InvalidPluginExecutionException("Observed input flags mismatch");if(c.Stage==40&&((EntityCollection)c.OutputParameters["BusinessEntityCollection"]).Entities[0].RowVersion!="12345")throw new InvalidPluginExecutionException("Source RowVersion lost");if(!c.IsPortalsClientCall||c.PortalsContactId!=new Guid("${contact}")||c.IsInTransaction||c.Depth!=1)throw new InvalidPluginExecutionException("Root read context mismatch");var service=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(new Guid("${writer}"));if(c.Stage==10)c.SharedVariables["observed"]="all stages";if((string)c.SharedVariables["observed"]!="all stages")throw new InvalidPluginExecutionException("Read shared values lost");var audit=new Entity("audit");audit["title"]=c.Stage.ToString();service.Create(audit);if(c.Stage==40&&((FetchExpression)c.InputParameters["Query"]).Query.Contains("fail"))throw new InvalidPluginExecutionException("Later observer rejected");}}
 public sealed class Audit:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext2)services.GetService(typeof(IPluginExecutionContext2));var main=(IPluginExecutionContext2)c.ParentContext;if(main.MessageName!="Create"||main.Stage!=30||!main.IsInTransaction||main.IsPortalsClientCall)throw new InvalidPluginExecutionException("Nested main operation mismatch");var parent=(IPluginExecutionContext2)main.ParentContext;if(c.UserId!=new Guid("${writer}")||c.InitiatingUserId!=new Guid("${writer}")||c.IsPortalsClientCall||c.PortalsContactId!=Guid.Empty||c.Depth!=2||!c.IsInTransaction||parent.IsInTransaction||!parent.IsPortalsClientCall||parent.PortalsContactId!=new Guid("${contact}")||c.CorrelationId!=parent.CorrelationId)throw new InvalidPluginExecutionException("Nested recording context mismatch");((Entity)c.InputParameters["Target"])["note"]="nested SDK identity cleared";}}
 }`,
    );
    compileClr(source, assembly, { references: [sdk, 'System.Runtime.Serialization.dll'] });
    const descriptor = {
      trust: 'execute-local-assembly',
      root,
      assembly: 'Recorder.dll',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(root, 'cache'),
      serviceProfile: profile,
      sdkCallerProfiles: [{ ...profile, userId: writer }],
      context: {
        initiatingUserId: user,
        organizationId: user,
        businessUnitId: user,
        interfaceVersion: 7,
        environmentId: 'observed-local-environment',
        tenantId: user,
        isApplicationUser: true,
        initiatingUserAgentPresent: true,
        portalInputParameters: { AppModuleId: { $type: 'Guid', value: user }, IsAppModuleContext: false },
      },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    };
    const recorder = await prepareClrRuntime({ ...descriptor, typeName: 'Invented.Recorder' }),
      audit = await prepareClrRuntime({ ...descriptor, typeName: 'Invented.Audit' }),
      steps = [
        ...[10, 20, 40].map((stage) => step(stage)),
        { ...step(20, 100), entity: 'audit', message: 'Create', typeName: 'Invented.Audit' },
      ],
      runtimes = new Map(steps.map((s) => [s.id, s.entity === 'audit' ? audit : recorder])),
      items = pluginCatalogue({
        plugins: { steps },
        runtimes,
        overrides: Object.fromEntries(steps.map((s) => ['plugin-step:' + s.id, { mode: 'clr' }])),
      }),
      notes = [],
      store = fixture();
    store.state.mappings.widget.sdkRowVersionColumn = 'revision';
    store.state.tables.widget[0].revision = '12345';
    store.setPluginPipeline((c) =>
      runPluginPhase({ ...c, store, items, runtimes, diagnostic: (note) => notes.push(note) }),
    );
    const fetch = '<fetch><entity name="widget"><attribute name="title"/></entity></fetch>';
    const answer = await store.readOperation(() =>
      store.fetchXml(fetch, { contactId: contact }, { portalRequest: true }),
    );
    assert.equal(answer.entities.length, 1);
    assert.deepEqual(
      store.snapshot().tables.audit.map((row) => row.title),
      ['10', '20', '40'],
    );
    assert.ok(store.snapshot().tables.audit.every((row) => row.note === 'nested SDK identity cleared'));
    await assert.rejects(
      store.readOperation(() =>
        store.fetchXml(
          fetch.replace(
            '</entity>',
            '<filter><condition attribute="title" operator="ne" value="fail"/></filter></entity>',
          ),
          { contactId: contact },
          { portalRequest: true },
        ),
      ),
      /Later observer rejected/,
    );
    assert.equal(store.snapshot().tables.audit.length, 6);
    assert.ok(notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED').every((note) => note.absenceVerified));
  },
);
