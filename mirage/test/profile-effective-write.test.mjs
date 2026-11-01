// @test-kind security: effective-write authorization is per invocation, never reused, expires on failure and honours grant revocation
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { localOrganizationService } from '../lib/local-organization-service.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { EXTENSION as virtualProviders } from '../lib/dataverse-virtual-providers.mjs';
import { attachClrSteps } from './fixtures/plugin-pipeline.mjs';

const ID = '11111111-1111-4111-8111-111111111111';
const allowed = {
  userId: ID,
  evidence: 'Invented effective-row grant containment',
  grants: [
    { entity: 'widget', operations: ['create', 'update', 'delete'], predicate: (row) => row.title === 'Allowed' },
  ],
};

async function fixture(t, { organization = false, operation = 'create', provider } = {}) {
  const state = emptyState();
  state.mappings.widget = {
    entitySet: 'widgets',
    idColumn: 'widgetid',
    fields: { title: { dataverseType: 'nvarchar' }, memo: { dataverseType: 'nvarchar' } },
  };
  state.tables.widget = operation === 'create' ? [] : [{ widgetid: ID, title: 'Allowed' }];
  const store = await new DataStore({ state }).init();
  if (organization) {
    const extensions = provider
      ? [
          ...EXTENSIONS.filter((extension) => extension.name !== virtualProviders.name),
          {
            ...virtualProviders,
            install: (api) =>
              virtualProviders.install(api, {
                virtualTableProviders: { invented: provider },
                virtualTables: { widget: { dataSourceId: 'invented' } },
              }),
          },
        ]
      : EXTENSIONS;
    const runtime = await createOrganizationRuntime({
      store,
      settings: dataverseSettings({ enabled: true }),
      extensions,
    });
    t.after(() => runtime.close());
  }
  return { store, service: localOrganizationService(store, allowed) };
}

const invoke = (service, operation, asynchronous, values = { title: 'Allowed' }) =>
  service[(operation === 'delete' ? 'remove' : operation) + (asynchronous ? 'Async' : '')](
    'widget',
    ...(operation === 'create' ? [] : [ID]),
    ...(operation === 'delete' ? [] : [values]),
  );

async function denied(run, asynchronous) {
  if (asynchronous) await assert.rejects(run, { status: 403, code: 'LocalBackendPermissionDenied' });
  else assert.throws(run, { status: 403, code: 'LocalBackendPermissionDenied' });
}

for (const organization of [false, true])
  for (const asynchronous of [false, true])
    for (const operation of ['create', 'update'])
      for (const source of ['registered PreOperation', 'declarative rule'])
        test(`${organization ? 'organization' : 'raw'} ${asynchronous ? 'async' : 'sync'} ${operation} contains effective ${source} changes`, async (t) => {
          const { store, service } = await fixture(t, { organization, operation });
          await invoke(service, operation, asynchronous);
          const previous = structuredClone(store.tableRows('widget'));
          if (source === 'declarative rule')
            store.state.plugins.push({ entity: 'widget', operations: [operation], set: { title: 'Denied' } });
          else
            store.setPluginPipeline((context) => {
              if (context.stage === 20) context.target.title = 'Denied';
            });
          await denied(() => invoke(service, operation, asynchronous), asynchronous);
          assert.deepEqual(store.tableRows('widget'), previous, 'the rejected main operation is atomic');
        });

for (const asynchronous of [false, true])
  for (const operation of ['create', 'update'])
    test(`a denied effective ${asynchronous ? 'async' : 'sync'} ${operation} never reaches its external provider`, async (t) => {
      const calls = [];
      const result = (name, row) => {
        calls.push(name);
        return { ...row, widgetid: ID };
      };
      const provider = {
        create: async (row) => result('create', row),
        update: async (_id, row) => result('update', row),
        createSync: (row) => result('createSync', row),
        updateSync: (_id, row) => result('updateSync', row),
      };
      const { store, service } = await fixture(t, { organization: true, operation, provider });
      await invoke(service, operation, asynchronous);
      assert.deepEqual(calls, [operation + (asynchronous ? '' : 'Sync')]);
      const previous = structuredClone(store.tableRows('widget'));
      store.setPluginPipeline((context) => {
        if (context.stage === 20) context.target.title = 'Denied';
      });
      await denied(() => invoke(service, operation, asynchronous), asynchronous);
      assert.equal(calls.length, 1);
      assert.deepEqual(store.tableRows('widget'), previous);
    });

for (const asynchronous of [false, true])
  for (const stage of [10, 20])
    test(`effective grant denial preserves ${stage === 10 ? 'independent PreValidation' : 'transactional PreOperation'} child semantics on the ${asynchronous ? 'async' : 'sync'} drive`, async (t) => {
      const { store, service } = await fixture(t);
      const child = localOrganizationService(store, {
        ...allowed,
        grants: [{ entity: 'widget', operations: ['create'] }],
      });
      store.setPluginPipeline((context) => {
        if (context.record.memo === 'child') return;
        if (context.stage === stage) child.create('widget', { title: 'Independent child', memo: 'child' });
        if (context.stage === 20) context.target.title = 'Denied';
      });
      await denied(() => invoke(service, 'create', asynchronous), asynchronous);
      assert.deepEqual(
        store.tableRows('widget').map((row) => row.title),
        stage === 10 ? ['Independent child'] : [],
      );
    });

for (const asynchronous of [false, true])
  test(`post40 Target-only changes do not reauthorize or persist on the ${asynchronous ? 'async' : 'sync'} drive`, async (t) => {
    const { store, service } = await fixture(t, { operation: 'update' });
    store.setPluginPipeline((context) => {
      if (context.stage === 40) context.target.title = 'Context only';
    });
    await invoke(service, 'update', asynchronous);
    assert.equal(store.tableRows('widget')[0].title, 'Allowed');
  });

for (const asynchronous of [false, true])
  test(`post40 Target changes and separately authorized same-row writes remain independent on the ${asynchronous ? 'async' : 'sync'} drive`, async (t) => {
    const { store, service } = await fixture(t, { operation: 'update' });
    const other = localOrganizationService(store, {
      ...allowed,
      grants: [{ entity: 'widget', operations: ['update'] }],
    });
    let nested = false;
    store.setPluginPipeline((context) => {
      if (nested || context.stage !== 40) return;
      context.target.title = 'Context only';
      nested = true;
      try {
        other.update('widget', ID, { title: 'Authorized by another profile' });
      } finally {
        nested = false;
      }
    });
    await invoke(service, 'update', asynchronous);
    assert.equal(store.tableRows('widget')[0].title, 'Authorized by another profile');
  });

test('an Update rechecks the latest saved row even when its own effective Target would restore an allowed value', async (t) => {
  const { store, service } = await fixture(t, { operation: 'update' });
  const other = localOrganizationService(store, {
    ...allowed,
    grants: [{ entity: 'widget', operations: ['update'] }],
  });
  let nested = false;
  store.setPluginPipeline((context) => {
    if (context.stage !== 20 || nested) return;
    nested = true;
    try {
      other.update('widget', ID, { title: 'Denied' });
    } finally {
      nested = false;
    }
  });
  assert.throws(() => service.update('widget', ID, { title: 'Allowed' }), { code: 'LocalBackendPermissionDenied' });
  assert.equal(store.tableRows('widget')[0].title, 'Allowed', 'the transactional child also rolls back');
});

test('recursive child creates never consume their parent effective-write authorization, including the same table', async (t) => {
  const { store } = await fixture(t);
  store.state.mappings.widget.relationships = {
    child: { entity: 'widget', from: 'childid', to: 'widgetid', many: false },
    children: { entity: 'widget', from: 'widgetid', to: 'parentid', many: true },
  };
  const seen = [];
  await store.create(
    'widget',
    { title: 'Parent', child: { title: 'Single' }, children: [{ title: 'Collection' }] },
    { admin: true },
    { authorizeEffectiveWrite: (entity, operation, row) => seen.push([entity, operation, row.title]) },
  );
  assert.deepEqual(seen, [['widget', 'create', 'Parent']]);
  assert.equal(store.tableRows('widget').length, 3);
});

test('a captured effective-write capability cannot authorize a subsequent invocation', async (t) => {
  const { store, service } = await fixture(t);
  const create = store.createRecord.bind(store);
  let captured;
  store.createRecord = (entity, values, identity, options) => {
    captured = options.authorizeEffectiveWrite;
    return create(entity, values, identity, options);
  };
  service.create('widget', { title: 'Allowed' });
  assert.throws(() => captured('widget', 'create', { title: 'Allowed' }), { code: 'LocalBackendPermissionDenied' });
  assert.throws(() => captured.preflight('widget', 'create', { title: 'Allowed' }), {
    code: 'LocalBackendPermissionDenied',
  });
});

for (const asynchronous of [false, true])
  test(`an unused effective-write capability expires when its ${asynchronous ? 'async' : 'sync'} invocation fails`, async (t) => {
    const { store, service } = await fixture(t);
    let captured;
    store['createRecord' + (asynchronous ? 'Async' : '')] = (_entity, _values, _identity, options) => {
      captured = options.authorizeEffectiveWrite;
      throw Object.assign(new Error('Invented failure before the main operation'), { code: 'InventedWriteFailure' });
    };
    const run = () => invoke(service, 'create', asynchronous);
    if (asynchronous) await assert.rejects(run, { code: 'InventedWriteFailure' });
    else assert.throws(run, { code: 'InventedWriteFailure' });
    assert.throws(() => captured('widget', 'create', { title: 'Allowed' }), { code: 'LocalBackendPermissionDenied' });
    assert.throws(() => captured.preflight('widget', 'create', { title: 'Allowed' }), {
      code: 'LocalBackendPermissionDenied',
    });
    assert.equal(store.tableRows('widget').length, 0);
  });

const CHILD = '22222222-2222-4222-8222-222222222222';
function cascadeChild(store) {
  store.state.mappings.widget.relationships = {
    children: { entity: 'widget', from: 'widgetid', to: 'parentid', many: true, cascade: { delete: 'Cascade' } },
  };
  store.state.tables.widget.push({ widgetid: CHILD, title: 'Denied', parentid: ID });
}

for (const organization of [false, true])
  for (const asynchronous of [false, true])
    for (const stage of [10, 20])
      test(`${organization ? 'organization' : 'raw'} ${asynchronous ? 'async' : 'sync'} Delete authorizes the latest root after stage${stage}, before any cascade`, async (t) => {
        const { store, service } = await fixture(t, { organization, operation: 'delete' });
        cascadeChild(store);
        const other = localOrganizationService(store, {
          ...allowed,
          grants: [{ entity: 'widget', operations: ['update'] }],
        });
        const snapshots = [];
        store.setPluginPipeline((context) => {
          if (context.operation !== 'delete' || context.record.widgetid !== ID) return;
          snapshots.push([context.stage, context.record.title, context.previous.title]);
          if (context.stage === stage) other.update('widget', ID, { title: 'Denied' });
        });
        await denied(() => invoke(service, 'delete', asynchronous), asynchronous);
        assert.deepEqual(
          store.tableRows('widget').map((row) => [row.widgetid, row.title]),
          [
            [ID, stage === 10 ? 'Denied' : 'Allowed'],
            [CHILD, 'Denied'],
          ],
          'PreValidation remains independent, PreOperation rolls back, and the cascade never starts',
        );
        assert.deepEqual(snapshots, [
          [10, 'Allowed', 'Allowed'],
          [20, 'Allowed', 'Allowed'],
        ]);
      });

for (const organization of [false, true])
  for (const asynchronous of [false, true])
    test(`${organization ? 'organization' : 'raw'} ${asynchronous ? 'async' : 'sync'} Delete does not pass the parent grant to implicit same-table cascade children`, async (t) => {
      const { store, service } = await fixture(t, { organization, operation: 'delete' });
      cascadeChild(store);
      await invoke(service, 'delete', asynchronous);
      assert.deepEqual(store.tableRows('widget'), []);
    });

for (const organization of [false, true])
  for (const asynchronous of [false, true])
    for (const stage of [20, 40])
      test(`${organization ? 'organization' : 'raw'} ${asynchronous ? 'async' : 'sync'} Delete rechecks its root after cascaded child stage${stage} effects`, async (t) => {
        const { store, service } = await fixture(t, { organization, operation: 'delete' });
        cascadeChild(store);
        const other = localOrganizationService(store, {
          ...allowed,
          grants: [{ entity: 'widget', operations: ['update'] }],
        });
        store.setPluginPipeline((context) => {
          if (context.operation === 'delete' && context.stage === stage && context.record.widgetid === CHILD)
            other.update('widget', ID, { title: 'Denied' });
        });
        await denied(() => invoke(service, 'delete', asynchronous), asynchronous);
        assert.deepEqual(
          store.tableRows('widget').map((row) => [row.widgetid, row.title]),
          [
            [ID, 'Allowed'],
            [CHILD, 'Denied'],
          ],
        );
      });

test('Delete preflight and final admission both permit an authorized root after cascaded child writes', async (t) => {
  const { store, service } = await fixture(t, { operation: 'delete' });
  cascadeChild(store);
  const other = localOrganizationService(store, { ...allowed, grants: [{ entity: 'widget', operations: ['update'] }] });
  store.setPluginPipeline((context) => {
    if (context.operation === 'delete' && context.stage === 20 && context.record.widgetid === CHILD)
      other.update('widget', ID, { memo: 'Allowed cascade effect' });
  });
  service.remove('widget', ID);
  assert.deepEqual(store.tableRows('widget'), []);
});

for (const trigger of [ID, CHILD])
  for (const asynchronous of [false, true])
    test(`Delete refuses a root removed during ${trigger === ID ? 'its own PreOperation' : 'a child cascade'} on the ${asynchronous ? 'async' : 'sync'} drive`, async (t) => {
      const { store, service } = await fixture(t, { operation: 'delete' });
      cascadeChild(store);
      const other = localOrganizationService(store, {
        ...allowed,
        grants: [{ entity: 'widget', operations: ['delete'] }],
      });
      let nested = false;
      store.setPluginPipeline((context) => {
        if (nested || context.operation !== 'delete' || context.stage !== 20 || context.record.widgetid !== trigger)
          return;
        nested = true;
        try {
          other.remove('widget', ID);
        } finally {
          nested = false;
        }
      });
      const run = () => invoke(service, 'delete', asynchronous);
      if (asynchronous) await assert.rejects(run, { code: 'NotFound' });
      else assert.throws(run, { code: 'NotFound' });
      assert.deepEqual(
        store.tableRows('widget').map((row) => row.widgetid),
        [ID, CHILD],
      );
    });

for (const asynchronous of [false, true])
  test(`Delete keeps a separately authorized post40 recreation on the ${asynchronous ? 'async' : 'sync'} drive`, async (t) => {
    const { store, service } = await fixture(t, { operation: 'delete' });
    const other = localOrganizationService(store, {
      ...allowed,
      grants: [{ entity: 'widget', operations: ['create'] }],
    });
    store.setPluginPipeline((context) => {
      if (context.operation === 'delete' && context.stage === 40)
        other.create('widget', { widgetid: ID, title: 'Authorized recreation' });
    });
    await invoke(service, 'delete', asynchronous);
    assert.equal(store.tableRows('widget')[0].title, 'Authorized recreation');
  });

test('Delete authorization reads the latest row without changing the selected preimage snapshot', async (t) => {
  const { store, service } = await fixture(t, { operation: 'delete' });
  const other = localOrganizationService(store, { ...allowed, grants: [{ entity: 'widget', operations: ['update'] }] });
  let image;
  const steps = ['Change', 'Observe'].map((name, index) => ({
    id: `30000000-0000-4000-8000-00000000000${index}`,
    enabled: true,
    entity: 'widget',
    message: 'Delete',
    stage: 20,
    rank: index + 1,
    mode: 0,
    supportedDeployment: 0,
    typeName: 'Invented.' + name,
    assemblyId: 'invented',
    filteringAttributes: [],
    images: index ? [{ type: 0, alias: 'Before', attributes: ['title'] }] : [],
  }));
  await attachClrSteps(t, {
    store,
    steps,
    runtime: () => null,
    handlers: new Map([
      [
        'Invented.Change',
        () => {
          other.update('widget', ID, { title: 'Denied' });
        },
      ],
      [
        'Invented.Observe',
        ({ context }) => {
          image = structuredClone(context.PreEntityImages.Before);
        },
      ],
    ]),
  });
  assert.throws(() => service.remove('widget', ID), { code: 'LocalBackendPermissionDenied' });
  assert.equal(image.title, 'Allowed');
  assert.equal(store.tableRows('widget')[0].title, 'Allowed');
});

for (const asynchronous of [false, true])
  test(`Delete grant revocation prevents an external provider call on the ${asynchronous ? 'async' : 'sync'} drive`, async (t) => {
    const calls = [];
    const { store } = await fixture(t, {
      organization: true,
      operation: 'delete',
      provider: {
        delete: async () => {
          calls.push('delete');
        },
        deleteSync: () => {
          calls.push('deleteSync');
        },
      },
    });
    let permitted = true;
    const service = localOrganizationService(store, {
      ...allowed,
      grants: [{ entity: 'widget', operations: ['delete'], predicate: (row) => permitted && row.title === 'Allowed' }],
    });
    store.setPluginPipeline((context) => {
      if (context.stage === 20) permitted = false;
    });
    await denied(() => invoke(service, 'delete', asynchronous), asynchronous);
    assert.deepEqual(calls, []);
    assert.equal(store.tableRows('widget')[0].title, 'Allowed');
  });
