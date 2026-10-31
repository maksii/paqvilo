// @test-kind unproven: local model of the SDK/HTTP association pipeline with compiled invented DLLs; explicitly not natively qualified
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
import { pluginCatalogue, runPluginPhase, pluginStepMatchesEntity } from '../lib/exported-plugins.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { createServer } from 'node:http';
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

test('SDK association identities stay GUID-strict when the local store contains fixture string IDs', () => {
  for (const invalid of ['source', 'related']) {
    const store = data();
    if (invalid === 'source') store.tableRows('root')[0].rootid = 'local-root';
    else store.tableRows('child')[0].childid = 'local-child';
    const before = store.snapshot();
    assert.throws(
      () =>
        localOrganizationService(store, profile).associate(
          'root',
          invalid === 'source' ? 'local-root' : rootId,
          relationship('root_child'),
          refs('child', invalid === 'related' ? 'local-child' : childId),
        ),
      { code: 'LocalSdkRelationshipInput' },
    );
    assert.deepEqual(store.snapshot(), before);
  }
});
const invoke = (store, method, entity, id, rel, related, p = profile) =>
  dispatchSdkCall({
    store,
    profile: p,
    message: { method, userId: user, arguments: [entity, { $type: 'Guid', value: id }, rel, related] },
  });

test('SDK and HTTP association messages queue one durable async snapshot after commit and honor CustomAsync', async (t) => {
  for (const transport of ['sdk', 'http'])
    await t.test(transport, async (t) => {
      const state = data().snapshot();
      const f = await contractModuleFixture(t, {
        mappings: state.mappings,
        tables: state.tables,
        extension: { name: 'association-async-probe', install: () => {} },
      });
      const seen = [];
      const steps = ['Associate', 'Disassociate'].map((message, index) => ({
        id: `30000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
        enabled: true,
        entity: null,
        unfiltered: true,
        messageFilterId: null,
        message,
        stage: 40,
        rank: 1,
        mode: 1,
        supportedDeployment: 0,
        filteringAttributes: [],
        images: [],
        typeName: 'Invented.AssociationAsync',
        assemblyId: 'invented',
      }));
      const handlers = new Map([
        [
          'Invented.AssociationAsync',
          (context) => {
            assert.equal(f.store.pluginInTransaction, false);
            assert.equal(context.context.PrimaryEntityName, 'none');
            assert.equal(context.context.PrimaryEntityId, '00000000-0000-0000-0000-000000000000');
            assert.equal(context.context.InputParameters.Target.id, rootId);
            assert.equal(context.context.InputParameters.Relationship.schemaName, 'root_child');
            assert.equal(context.context.InputParameters.RelatedEntities.values[0].id, childId);
            seen.push([context.operation, context.associationParameters]);
          },
        ],
      ]);
      const items = pluginCatalogue({ plugins: { steps }, handlers });
      const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
      t.after(() => backend.close());
      const mutations = [];
      f.store.addMutationObserver((event) => mutations.push(event.operation));
      if (transport === 'sdk') {
        await f.store.transact(() =>
          invoke(f.store, 'Associate', 'root', rootId, relationship('root_child'), refs('child', childId)),
        );
        await f.store.transact(() =>
          invoke(f.store, 'Disassociate', 'root', rootId, relationship('root_child'), refs('child', childId)),
        );
      } else {
        await f.json(
          await f.request('POST', `/roots(${rootId})/children/$ref`, {
            '@odata.id': `${f.server.origin}/api/data/v9.2/children(${childId})`,
          }),
          204,
        );
        await f.json(await f.request('DELETE', `/roots(${rootId})/children(${childId})/$ref`), 204);
      }
      await backend.settle();
      assert.deepEqual(
        seen.map(([operation]) => operation),
        ['associate', 'disassociate'],
      );
      for (const [, parameters] of seen) {
        assert.equal(parameters.Target.id, rootId);
        assert.equal(parameters.Relationship.schemaName, 'root_child');
        assert.equal(parameters.RelatedEntities.values[0].id, childId);
      }
      assert.equal(f.store.tableRows('asyncoperation').length, 2);
      assert(f.store.tableRows('asyncoperation').every((job) => job.statuscode === 30));
      assert.deepEqual(mutations, ['update', 'update']);
      if (transport === 'http') {
        await f.json(
          await f.request(
            'POST',
            `/roots(${rootId})/children/$ref`,
            { '@odata.id': `${f.server.origin}/api/data/v9.2/children(${childId})` },
            { 'MSCRM.BypassBusinessLogicExecution': 'CustomAsync' },
          ),
          204,
        );
        await backend.settle();
        assert.equal(seen.length, 2);
      }
    });
});
test('association pre-operation Target and RelatedEntities replacement rebinds the main write on HTTP and SDK', async (t) => {
  for (const transport of ['http', 'sdk'])
    for (const associate of [true, false])
      for (const replacement of ['target', 'related'])
        await t.test(`${transport}/${associate ? 'associate' : 'disassociate'}/${replacement}`, async (t) => {
          const otherRoot = '20000000-0000-0000-0000-000000000091',
            otherChild = '20000000-0000-0000-0000-000000000092';
          const state = data().snapshot();
          state.tables.root.push({ rootid: otherRoot, title: 'Replacement parent' });
          state.tables.child.push({ childid: otherChild, parentid: associate ? null : rootId });
          if (!associate) state.tables.child[0].parentid = replacement === 'target' ? otherRoot : rootId;
          const afterWrites = [];
          const f = await contractModuleFixture(t, {
            mappings: state.mappings,
            tables: state.tables,
            extension: {
              name: 'association-rebind-probe',
              install: (api) => {
                api.recordHooks.add('afterWrite', (_context, _mapping, info) => {
                  if (['associate', 'disassociate'].includes(info.operation))
                    afterWrites.push([info.id, info.relatedId]);
                });
              },
            },
          });
          const step = {
            id: '30000000-0000-0000-0000-000000000091',
            enabled: true,
            entity: null,
            unfiltered: true,
            messageFilterId: null,
            message: associate ? 'Associate' : 'Disassociate',
            stage: 20,
            rank: 1,
            mode: 0,
            supportedDeployment: 0,
            filteringAttributes: [],
            images: [],
            typeName: 'Invented.Rebind',
            assemblyId: 'invented',
          };
          const handlers = new Map([
            [
              step.typeName,
              ({ context }) => {
                if (replacement === 'target') context.InputParameters.Target.id = otherRoot;
                else context.InputParameters.RelatedEntities.values[0].id = otherChild;
              },
            ],
          ]);
          const items = pluginCatalogue({ plugins: { steps: [step] }, handlers });
          const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
          t.after(() => backend.close());
          if (transport === 'sdk')
            await f.store.transact(() =>
              invoke(
                f.store,
                associate ? 'Associate' : 'Disassociate',
                'root',
                rootId,
                relationship('root_child'),
                refs('child', childId),
              ),
            );
          else
            await f.json(
              await f.request(
                associate ? 'POST' : 'DELETE',
                associate ? `/roots(${rootId})/children/$ref` : `/roots(${rootId})/children(${childId})/$ref`,
                associate ? { '@odata.id': `${f.server.origin}/api/data/v9.2/children(${childId})` } : undefined,
              ),
              204,
            );
          const rows = f.store.tableRows('child'),
            original = rows.find((row) => row.childid === childId),
            other = rows.find((row) => row.childid === otherChild);
          assert.equal(
            original.parentid,
            replacement === 'target' ? (associate ? otherRoot : null) : associate ? null : rootId,
          );
          assert.equal(
            other.parentid,
            replacement === 'related' ? (associate ? rootId : null) : associate ? null : rootId,
          );
          assert.deepEqual(afterWrites, [
            [replacement === 'target' ? otherRoot : rootId, replacement === 'related' ? otherChild : childId],
          ]);
        });
});

// @test-kind security: privilege check: a mutated association target must pass the effective backend grant before any edge changes
test('a mutated association target must pass the effective backend grant before any edge is changed', async (t) => {
  const store = data(),
    other = '20000000-0000-0000-0000-000000000091';
  store.state.tables.root.push({ rootid: other, title: 'Not granted' });
  const step = {
    id: '30000000-0000-0000-0000-000000000091',
    enabled: true,
    entity: null,
    unfiltered: true,
    message: 'Associate',
    stage: 20,
    rank: 1,
    mode: 0,
    supportedDeployment: 0,
    filteringAttributes: [],
    images: [],
    typeName: 'Invented.DeniedRebind',
    assemblyId: 'invented',
  };
  const handlers = new Map([
    [
      step.typeName,
      ({ context }) => {
        context.InputParameters.Target.id = other;
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps: [step] }, handlers });
  const backend = await createOrganizationBackend({ store, items: () => items, handlers });
  t.after(() => backend.close());
  const restricted = {
    ...profile,
    grants: profile.grants.map((grant) =>
      grant.entity === 'root' ? { ...grant, predicate: (row) => row.rootid === rootId } : grant,
    ),
  };
  await assert.rejects(
    store.transact(() =>
      invoke(store, 'Associate', 'root', rootId, relationship('root_child'), refs('child', childId), restricted),
    ),
    /denied associate on root/,
  );
  assert.equal(store.tableRows('child')[0].parentid, null);
});

test(
  'an original CLR association step rebinds both Target and RelatedEntities before the HTTP main operation',
  { skip: CLR_SKIP },
  async (t) => {
    const temporary = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-association-rebind-'));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const otherRoot = '20000000-0000-0000-0000-000000000091',
      otherChild = '20000000-0000-0000-0000-000000000092';
    const sdk = clrSdk(),
      source = path.join(temporary, 'Rebind.cs'),
      assemblyFile = path.join(temporary, 'Rebind.dll');
    await fs.writeFile(
      source,
      `using System; using Microsoft.Xrm.Sdk; namespace Invented { public sealed class Rebind:IPlugin { public void Execute(IServiceProvider provider) { var context=(IPluginExecutionContext)provider.GetService(typeof(IPluginExecutionContext)); context.InputParameters["Target"]=new EntityReference("root",new Guid("${otherRoot}")); context.InputParameters["RelatedEntities"]=new EntityReferenceCollection {new EntityReference("child",new Guid("${otherChild}"))}; } } }`,
    );
    compileClr(source, assemblyFile, { references: [sdk] });
    const runtime = await prepareClrRuntime({
      trust: 'execute-local-assembly',
      root: temporary,
      assembly: 'Rebind.dll',
      typeName: 'Invented.Rebind',
      sdkRoot: path.dirname(sdk),
      sdkAssembly: path.basename(sdk),
      cacheRoot: path.join(temporary, 'cache'),
      serviceProfile: profile,
      context: { initiatingUserId: user, organizationId: user, businessUnitId: user },
      timeoutMs: ORDINARY_CLR_TIMEOUT_MS,
    });
    const state = data().snapshot();
    state.tables.root.push({ rootid: otherRoot });
    state.tables.child.push({ childid: otherChild, parentid: null });
    const f = await contractModuleFixture(t, {
      mappings: state.mappings,
      tables: state.tables,
      extension: { name: 'original-association-rebind', install: () => {} },
    });
    const step = {
      id: '30000000-0000-0000-0000-000000000091',
      enabled: true,
      entity: null,
      unfiltered: true,
      messageFilterId: null,
      message: 'Associate',
      stage: 20,
      rank: 1,
      mode: 0,
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
      typeName: 'Invented.Rebind',
      assemblyId: 'invented',
      assemblyName: 'Rebind',
    };
    const runtimes = new Map([[step.id, runtime]]);
    const items = pluginCatalogue({
      plugins: { steps: [step] },
      runtimes,
      overrides: { [`plugin-step:${step.id}`]: { mode: 'clr' } },
    });
    const backend = await createOrganizationBackend({
      store: f.store,
      items: () => items,
      runtimes,
      descriptors: new Map([[step.id, runtime.descriptor]]),
    });
    t.after(() => backend.close());
    await f.json(
      await f.request('POST', `/roots(${rootId})/children/$ref`, {
        '@odata.id': `${f.server.origin}/api/data/v9.2/children(${childId})`,
      }),
      204,
    );
    assert.equal(f.store.tableRows('child').find((row) => row.childid === childId).parentid, null);
    assert.equal(f.store.tableRows('child').find((row) => row.childid === otherChild).parentid, otherRoot);
  },
);

test('1001 N:N related references reach a loopback step and a later refusal rolls every edge back atomically', async (t) => {
  const store = data(),
    endpoint = '40000000-0000-0000-0000-000000000001';
  const references = Array.from({ length: 1001 }, (_, index) => ({
    $type: 'EntityReference',
    logicalName: 'tag',
    id: `70000000-0000-0000-0000-${String(index + 1).padStart(12, '0')}`,
    name: null,
  }));
  store.state.tables.tag = references.map((reference) => ({ tagid: reference.id }));
  let refuse = false,
    received = 0;
  const server = createServer((request, response) => {
    request.resume();
    request.on('end', () => {
      received++;
      assert.equal(store.tableRows('edge').length, refuse ? 0 : 1001);
      response.writeHead(refuse ? 500 : 200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
      }),
  );
  store.state.tables.serviceendpoint = [
    { serviceendpointid: endpoint, contract: 8, authtype: 5, url: `http://127.0.0.1:${server.address().port}/hook` },
  ];
  const steps = ['Associate', 'Disassociate'].flatMap((message, index) => [
    {
      id: `30000000-0000-0000-0000-00000000000${index + 1}`,
      enabled: true,
      entity: null,
      unfiltered: true,
      message,
      stage: 20,
      rank: 1,
      mode: 0,
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
      typeName: 'Invented.Count',
      assemblyId: 'invented',
    },
    {
      id: `30000000-0000-0000-0000-00000000000${index + 3}`,
      enabled: true,
      entity: null,
      unfiltered: true,
      message,
      stage: 40,
      rank: 1,
      mode: 0,
      supportedDeployment: 0,
      filteringAttributes: [],
      images: [],
      serviceEndpointId: endpoint,
    },
  ]);
  const seen = [];
  const handlers = new Map([
    [
      'Invented.Count',
      (context) => {
        seen.push(context.associationParameters.RelatedEntities.values.length);
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store, items: () => items, handlers, systemJobs: () => false });
  t.after(() => backend.close());
  const service = localOrganizationService(store, profile),
    related = { $type: 'EntityReferenceCollection', values: references };
  await store.transact(() => service.associateAsync('root', rootId, relationship('root_tag'), related));
  assert.equal(store.tableRows('edge').length, 1001);
  refuse = true;
  await assert.rejects(
    store.transact(() => service.disassociateAsync('root', rootId, relationship('root_tag'), related)),
    /Endpoint unavailable/,
  );
  assert.equal(store.tableRows('edge').length, 1001);
  assert.deepEqual(seen, [1001, 1001]);
  assert.equal(received, 2);
});

test('HTTP and SDK association handlers roll back arbitrary trusted-handler mutations with the rejected request', async (t) => {
  const state = data().snapshot();
  const f = await contractModuleFixture(t, {
    mappings: state.mappings,
    tables: state.tables,
    extension: { name: 'association-checkpoint-probe', install: () => {} },
  });
  const step = {
    id: '30000000-0000-0000-0000-000000000099',
    enabled: true,
    entity: 'root',
    message: 'Associate',
    stage: 40,
    rank: 1,
    mode: 0,
    supportedDeployment: 0,
    filteringAttributes: [],
    images: [],
    typeName: 'Invented.AssociationGuard',
    assemblyId: 'invented',
  };
  const handlers = new Map([
    [
      step.id,
      (context) => {
        f.store.state.tables.root[0].title = 'Uncommitted unrelated mutation';
        context.reject('Association rejected');
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps: [step] }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  await assert.rejects(
    f.store.transact(
      () => invoke(f.store, 'Associate', 'root', rootId, relationship('root_child'), refs('child', childId)),
      { incremental: true },
    ),
    /Association rejected/,
  );
  assert.equal(f.store.tableRows('root')[0].title, 'Parent');
  assert.equal(f.store.tableRows('child')[0].parentid, null);
  await f.json(
    await f.request('POST', `/roots(${rootId})/children/$ref`, {
      '@odata.id': `${f.server.origin}/api/data/v9.2/children(${childId})`,
    }),
    400,
  );
  assert.equal(f.store.tableRows('root')[0].title, 'Parent');
  assert.equal(f.store.tableRows('child')[0].parentid, null);
});

// @test-kind security: privilege check: backend row and edge grants precede association, with no phantom Retrieve
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
// @test-kind security: privilege check: association revalidates current rows after stage-20 changes, not stale grant snapshots
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
public sealed class Observer:IPlugin {public void Execute(IServiceProvider services){var c=(IPluginExecutionContext)services.GetService(typeof(IPluginExecutionContext));var target=(EntityReference)c.InputParameters["Target"];var r=(Relationship)c.InputParameters["Relationship"];var rows=(EntityReferenceCollection)c.InputParameters["RelatedEntities"];if(c.PrimaryEntityName!="none"||c.PrimaryEntityId!=Guid.Empty||target.LogicalName!="root"||target.Id!=new Guid("${rootId}")||rows.Count!=1||r.SchemaName!="root_child"&&r.SchemaName!="root_tag"||!c.IsInTransaction||c.ParentContext.MessageName!="Create")throw new Exception("Typed association context lost");if(c.Stage==20)c.SharedVariables["role"]=r.PrimaryEntityRole.HasValue?r.PrimaryEntityRole.Value.ToString():"none";else if((string)c.SharedVariables["role"]!=(r.PrimaryEntityRole.HasValue?r.PrimaryEntityRole.Value.ToString():"none"))throw new Exception("Association frame lost");((ITracingService)services.GetService(typeof(ITracingService))).Trace("Original {0} stage {1}",c.MessageName,c.Stage);}}}`,
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
        unfiltered: entity === null,
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
      for (const stage of [20, 40]) await add('Observer', null, operation, stage);
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
        steps.some(
          (step) => pluginStepMatchesEntity(step, context.entity) && step.message.toLowerCase() === context.operation,
        ),
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
