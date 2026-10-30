import test from 'node:test';
import { ORDINARY_CLR_TIMEOUT_MS } from './fixtures/clr-budget.mjs';
import { CLR_SKIP, clrSdk, compileClr, retypeClrRuntime } from './fixtures/clr-sdk.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DataStore } from '../lib/data.mjs';
import { dispatchSdkCall, prepareClrRuntime } from '../lib/plugin-clr.mjs';
import { pluginCatalogue, runPluginPhase } from '../lib/exported-plugins.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
const user = '10000000-0000-0000-0000-000000000001',
  rootId = '20000000-0000-0000-0000-000000000001',
  childId = '20000000-0000-0000-0000-000000000002',
  tagId = '20000000-0000-0000-0000-000000000003';
const profile = {
  userId: user,
  evidence: 'Invented relationship backend',
  grants: [
    { entity: 'root', operations: ['associate', 'disassociate'] },
    { entity: 'child', operations: ['associate', 'disassociate', 'update'] },
    { entity: 'tag', operations: ['associate', 'disassociate'] },
    { entity: 'edge', operations: ['create', 'delete'] },
  ],
};
const data = () =>
  new DataStore({
    state: {
      version: 1,
      mappings: {
        widget: { entitySet: 'widgets', idColumn: 'widgetid' },
        root: {
          entitySet: 'roots',
          idColumn: 'rootid',
          relationships: {
            children: {
              schemaName: 'root_child',
              entity: 'child',
              from: 'rootid',
              to: 'parentid',
              many: true,
              partner: 'parent',
            },
            tags: {
              schemaName: 'root_tag',
              entity: 'tag',
              from: 'rootid',
              to: 'tagid',
              many: true,
              intersect: { entity: 'edge', from: 'rootid', to: 'tagid' },
            },
          },
        },
        child: {
          entitySet: 'children',
          idColumn: 'childid',
          relationships: {
            parent: {
              schemaName: 'root_child',
              entity: 'root',
              from: 'parentid',
              to: 'rootid',
              many: false,
              partner: 'children',
            },
          },
        },
        tag: { entitySet: 'tags', idColumn: 'tagid' },
        edge: { entitySet: 'edges', idColumn: 'edgeid' },
      },
      tables: {
        widget: [],
        root: [{ rootid: rootId, title: 'Parent' }],
        child: [{ childid: childId, parentid: null }],
        tag: [{ tagid: tagId }],
        edge: [],
      },
      permissions: [{ entity: 'widget', scope: 'global', roles: ['Editor'], operations: ['create'] }],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
const relationship = (schemaName, primaryEntityRole = null) => ({
  $type: 'Relationship',
  schemaName,
  primaryEntityRole,
});
const refs = (logicalName, id) => ({
  $type: 'EntityReferenceCollection',
  values: [{ $type: 'EntityReference', logicalName, id }],
});
const invoke = (store, method, entity, id, rel, related, p = profile) =>
  dispatchSdkCall({
    store,
    profile: p,
    message: { method, userId: user, arguments: [entity, { $type: 'Guid', value: id }, rel, related] },
  });
test('SDK schema/direction selection and backend row/edge grants precede association with no phantom Retrieve', async () => {
  const store = data(),
    seen = [];
  store.setPluginPipeline(
    (context) => seen.push(context.operation + ':' + context.stage),
    (context) => context.operation === 'retrieve',
  );
  invoke(store, 'Associate', 'root', rootId, relationship('root_child', 'Referenced'), refs('child', childId));
  assert.equal(store.snapshot().tables.child[0].parentid, rootId);
  invoke(store, 'Disassociate', 'child', childId, relationship('root_child', 'Referencing'), refs('root', rootId));
  assert.equal(store.snapshot().tables.child[0].parentid, null);
  assert.deepEqual(seen, []);
  const before = store.snapshot();
  assert.throws(
    () => invoke(store, 'Associate', 'root', rootId, relationship('children'), refs('child', childId)),
    /exact source mapping/,
  );
  assert.throws(
    () =>
      invoke(store, 'Associate', 'root', rootId, relationship('root_tag'), refs('tag', tagId), {
        ...profile,
        grants: profile.grants.filter((g) => g.entity !== 'edge'),
      }),
    /denied create on edge/,
  );
  assert.deepEqual(store.snapshot(), before);
  invoke(store, 'Associate', 'root', rootId, relationship('root_tag'), refs('tag', tagId));
  assert.equal(store.snapshot().tables.edge.length, 1);
  invoke(store, 'Disassociate', 'root', rootId, relationship('root_tag'), refs('tag', tagId));
  assert.equal(store.snapshot().tables.edge.length, 0);
  const childGrant = profile.grants.map((grant) =>
    grant.entity === 'child' ? { ...grant, predicate: (row) => row.parentid === null } : grant,
  );
  assert.throws(
    () =>
      invoke(store, 'Associate', 'root', rootId, relationship('root_child'), refs('child', childId), {
        ...profile,
        grants: childGrant,
      }),
    /denied update/,
  );
  assert.deepEqual(store.snapshot(), before);
  const other = '20000000-0000-0000-0000-000000000004';
  store.state.tables.child.push({ childid: other, parentid: null });
  const multiBefore = store.snapshot();
  const multiple = {
    $type: 'EntityReferenceCollection',
    values: [...refs('child', childId).values, ...refs('child', other).values],
  };
  assert.throws(
    () =>
      invoke(store, 'Associate', 'root', rootId, relationship('root_child'), multiple, {
        ...profile,
        grants: profile.grants.map((grant) =>
          grant.entity === 'child'
            ? { ...grant, predicate: (row) => row.childid === childId || row.parentid === null }
            : grant,
        ),
      }),
    /denied update/,
  );
  assert.deepEqual(store.snapshot(), multiBefore);
  store.state.tables.child.pop();
  const edgeProfile = {
    ...profile,
    grants: profile.grants.map((grant) =>
      grant.entity === 'edge' ? { ...grant, predicate: (row) => !row.edgeid } : grant,
    ),
  };
  assert.throws(
    () => invoke(store, 'Associate', 'root', rootId, relationship('root_tag'), refs('tag', tagId), edgeProfile),
    /denied create/,
  );
  assert.deepEqual(store.snapshot(), before);
  store.setPluginPipeline(
    (context) => {
      if (context.stage === 40) throw new Error('original relationship rejected');
    },
    (context) => context.operation === 'associate',
  );
  await assert.rejects(
    store.transact(() => invoke(store, 'Associate', 'root', rootId, relationship('root_tag'), refs('tag', tagId))),
    /original relationship rejected/,
  );
  assert.deepEqual(store.snapshot(), before);
});
test('Association revalidates current rows after stage20 SDK changes rather than stale grant snapshots', async () => {
  const store = data();
  store.state.tables.root[0].allow = true;
  const before = store.snapshot(),
    restricted = {
      ...profile,
      grants: [
        ...profile.grants.filter((grant) => grant.entity !== 'root'),
        { entity: 'root', operations: ['associate', 'disassociate'], predicate: (row) => row.allow === true },
        { entity: 'root', operations: ['update'] },
      ],
    };
  store.setPluginPipeline(
    (context) => {
      if (context.stage === 20)
        dispatchSdkCall({
          store,
          profile: restricted,
          message: {
            method: 'Update',
            userId: user,
            arguments: [{ $type: 'Entity', logicalName: 'root', id: rootId, attributes: { allow: false } }],
          },
        });
    },
    (context) => context.operation === 'associate',
  );
  await assert.rejects(
    store.transact(() =>
      invoke(store, 'Associate', 'root', rootId, relationship('root_child'), refs('child', childId), restricted),
    ),
    /denied associate on root/,
  );
  assert.deepEqual(store.snapshot(), before);
});
test(
  'Original DLL uses typed relationship calls, named responses and stage-context with rollback',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-sdk-associate-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'AssociationOriginal.cs'),
      assembly = path.join(root, 'AssociationOriginal.dll');
    await fs.writeFile(
      source,
      `using System;using Microsoft.Xrm.Sdk;using Microsoft.Xrm.Sdk.Messages;
namespace Invented {public sealed class Driver:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var s=((IOrganizationServiceFactory)services.GetService(typeof(IOrganizationServiceFactory))).CreateOrganizationService(c.UserId);var related=new EntityReferenceCollection{new EntityReference("child",new Guid("${childId}"))};var r=new Relationship("root_child"){PrimaryEntityRole=EntityRole.Referenced};s.Associate("root",new Guid("${rootId}"),r,related);var gone=(DisassociateResponse)s.Execute(new DisassociateRequest{Target=new EntityReference("root",new Guid("${rootId}")),Relationship=r,RelatedEntities=related});var tags=new EntityReferenceCollection{new EntityReference("tag",new Guid("${tagId}"))};var added=(AssociateResponse)s.Execute(new AssociateRequest{Target=new EntityReference("root",new Guid("${rootId}")),Relationship=new Relationship("root_tag"),RelatedEntities=tags});if(((Entity)c.InputParameters["Target"]).GetAttributeValue<string>("title")=="reject")throw new InvalidPluginExecutionException("Caller rejected association writes");}}
public sealed class Observer:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(EntityReference)c.InputParameters["Target"];var r=(Relationship)c.InputParameters["Relationship"];var rows=(EntityReferenceCollection)c.InputParameters["RelatedEntities"];if(target.LogicalName!="root"||target.Id!=new Guid("${rootId}")||rows.Count!=1||r.SchemaName!="root_child"&&r.SchemaName!="root_tag"||!c.IsInTransaction||c.ParentContext.MessageName!="Create")throw new Exception("Typed association context lost");if(c.Stage==20)c.SharedVariables["role"]=r.PrimaryEntityRole.HasValue?r.PrimaryEntityRole.Value.ToString():"none";else if((string)c.SharedVariables["role"]!=(r.PrimaryEntityRole.HasValue?r.PrimaryEntityRole.Value.ToString():"none"))throw new Exception("Association frame lost");((ITracingService)services.GetService(typeof(ITracingService))).Trace("Original {0} stage {1}",c.MessageName,c.Stage);}}}`,
    );
    compileClr(source, assembly, { references: [sdk] });
    const steps = [],
      runtimes = new Map();
    let number = 0,
      prepared;
    const add = async (type, entity, message, stage) => {
      const id = '30000000-0000-0000-0000-' + String(++number).padStart(12, '0');
      const step = {
        id,
        name: 'Invented ' + type,
        assemblyId: 'invented-association',
        enabled: true,
        entity,
        message,
        stage,
        rank: number,
        mode: 0,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.' + type,
      };
      steps.push(step);
      prepared ??= await prepareClrRuntime({
        trust: 'execute-local-assembly',
        root,
        assembly: path.basename(assembly),
        typeName: step.typeName,
        sdkRoot: path.dirname(sdk),
        sdkAssembly: path.basename(sdk),
        cacheRoot: path.join(root, '.paqvilo/cache'),
        serviceProfile: profile,
        context: {
          initiatingUserId: user,
          organizationId: '50000000-0000-0000-0000-000000000001',
          businessUnitId: '60000000-0000-0000-0000-000000000001',
        },
        timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
      });
      runtimes.set(id, retypeClrRuntime(prepared, { typeName: step.typeName }));
    };
    await add('Driver', 'widget', 'Create', 20);
    for (const operation of ['Associate', 'Disassociate'])
      for (const stage of [20, 40]) await add('Observer', 'root', operation, stage);
    const store = data(),
      notes = [],
      items = pluginCatalogue({
        plugins: { steps },
        runtimes,
        overrides: Object.fromEntries(steps.map((step) => ['plugin-step:' + step.id, { mode: 'clr' }])),
      });
    store.setPluginPipeline(
      (context) => runPluginPhase({ ...context, store, items, runtimes, diagnostic: (note) => notes.push(note) }),
      (context) =>
        steps.some((step) => step.entity === context.entity && step.message.toLowerCase() === context.operation),
    );
    store.file = path.join(root, 'state.json');
    await store.save();
    const before = store.snapshot();
    await assert.rejects(
      store.create('widget', { title: 'reject' }, { roles: ['Editor'] }),
      /Caller rejected association writes/,
    );
    assert.deepEqual(store.snapshot(), before);
    assert.equal(JSON.parse(await fs.readFile(store.file, 'utf8')).tables.edge.length, 0);
    await store.create('widget', { title: 'accept' }, { roles: ['Editor'] });
    assert.equal(store.snapshot().tables.child[0].parentid, null);
    assert.equal(store.snapshot().tables.edge.length, 1);
    assert.equal(notes.filter((note) => note.message === 'Original Associate stage 20').length, 4);
    const stopped = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
    assert.equal(stopped.length, notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STARTED').length);
    assert.ok(stopped.length > 0 && stopped.every((note) => note.absenceVerified));
    if (process.env.PAQ_TEST_CLR_EVIDENCE) {
      const hash = async (file) =>
          createHash('sha256')
            .update(await fs.readFile(file))
            .digest('hex'),
        hosts = notes.filter((note) => note.code === 'PLUGIN_CLR_HOST_STOPPED');
      await fs.writeFile(
        path.resolve(process.env.PAQ_TEST_CLR_EVIDENCE) + '.association.json',
        JSON.stringify(
          {
            schemaVersion: 1,
            generatedAt: new Date().toISOString(),
            scope: 'Actual compiled invented original DLL; no native organization execution',
            originalSourceSha256: await hash(source),
            originalAssemblySha256: await hash(assembly),
            sdkAssemblySha256: await hash(sdk),
            ownedHosts: { stopped: hosts.length, allAbsenceVerified: hosts.every((note) => note.absenceVerified) },
            assertionScopes: [
              'Actual EntityReferenceCollection and Relationship EntityRole',
              'Actual AssociateResponse and DisassociateResponse casts',
              'Bound association stage context and saved-state rollback',
            ],
            nativeQualified: false,
          },
          null,
          2,
        ) + '\n',
        { flag: 'wx' },
      );
    }
  },
);
