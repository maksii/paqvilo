// @test-kind security: platform audit stamps preserve Targets without acquiring visitor association privileges; every binding the caller sends remains checked, while a lookup a PreOperation plug-in sets or changes is not a visitor association (native, portal /_api Create and Update, 2026-11-23: workbench feedback-251-252-parity q2-*/q3-* evidence).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';
import { simulatorFixture } from './fixtures/source-site.mjs';
import { signInHeaders } from '../testing.mjs';

const actor = { contactId: 'visitor', roles: ['Writer'] };
const ref = (id) => ({ id, logical_name: 'systemuser' });
function fixture() {
  const store = new DataStore({
    state: {
      mappings: {
        x_item: {
          entitySet: 'x_items',
          idColumn: 'x_itemid',
          relationships: Object.fromEntries(
            ['createdby', 'modifiedby', 'modifiedonbehalfby', 'x_reviewer'].map((name) => [
              name,
              {
                entity: 'systemuser',
                from: name,
                to: 'systemuserid',
                many: false,
              },
            ]),
          ),
        },
        systemuser: { entitySet: 'systemusers', idColumn: 'systemuserid' },
      },
      tables: {
        x_item: [{ x_itemid: 'item', x_name: 'Before' }],
        systemuser: [{ systemuserid: 'platform' }, { systemuserid: 'other' }],
      },
      permissions: [
        { entity: 'x_item', roles: ['Writer'], scope: 'global', operations: ['read', 'create', 'update', 'appendTo'] },
      ],
      settings: { permissionMode: 'enforce', associationPermissions: 'enforce' },
    },
  });
  const targets = [];
  store.setPluginPipeline(({ target, stage }) => {
    if (stage === 20) targets.push(structuredClone(target));
  });
  return { store, targets };
}
const stamps = { createdby: ref('platform'), modifiedby: ref('platform'), modifiedonbehalfby: null };

test('scalar create and update retain audit stamps in rows and plug-in Targets without systemuser grants', async () => {
  const { store, targets } = fixture();
  const created = await store.transact(() =>
    store.createRecordAsync('x_item', { x_name: 'Created' }, actor, { systemColumns: stamps }),
  );
  await store.transact(() =>
    store.updateRecordAsync('x_item', 'item', { x_name: 'Updated' }, actor, { systemColumns: stamps }),
  );
  assert.equal(store.tableRows('x_item')[0].x_name, 'Updated');
  assert.deepEqual(created.createdby, stamps.createdby);
  assert.deepEqual(store.tableRows('x_item')[0].modifiedby, stamps.modifiedby);
  assert.ok(targets.length >= 2);
  assert.deepEqual(targets.at(-1).modifiedby, stamps.modifiedby);
});

test('caller-sent lookup changes still require Append on the related table and roll back; plug-in-authored ones do not', async () => {
  for (const input of [
    { x_reviewer: ref('other') },
    { 'x_reviewer@odata.bind': '/systemusers(other)' },
    { modifiedby: ref('platform') },
  ]) {
    const { store } = fixture();
    await assert.rejects(
      store.transact(() =>
        store.updateRecordAsync('x_item', 'item', { x_name: 'Denied', ...input }, actor, { systemColumns: stamps }),
      ),
      (e) => e.status === 403,
    );
    assert.equal(store.tableRows('x_item')[0].x_name, 'Before');
  }
  // Native Update through the portal: a PreOperation step that sets or changes a lookup on a table the
  // visitor has no AppendTo on succeeds (204) with the step's value, while the client-sent bind is 403 90040106.
  for (const lookup of ['x_reviewer', 'modifiedby']) {
    const { store } = fixture();
    store.setPluginPipeline(({ target, stage }) => {
      if (stage === 20) target[lookup] = ref('other');
    });
    await store.transact(() =>
      store.updateRecordAsync('x_item', 'item', { x_name: 'Plug-in set' }, actor, { systemColumns: stamps }),
    );
    assert.equal(store.tableRows('x_item')[0].x_name, 'Plug-in set', lookup);
  }
  const { store } = fixture();
  store.setPluginPipeline(({ target, stage }) => {
    if (stage === 20) target.x_reviewer = ref('other');
  });
  await store.transact(() => store.updateRecordAsync('x_item', 'item', { x_name: 'Plug-in set' }, actor));
  assert.equal(store.tableRows('x_item')[0].x_reviewer.id, 'other');
  const allowed = fixture().store;
  allowed.state.permissions.push({
    entity: 'systemuser',
    roles: ['Writer'],
    scope: 'global',
    operations: ['append'],
  });
  await allowed.transact(() =>
    allowed.updateRecordAsync('x_item', 'item', { x_reviewer: ref('other') }, actor, { systemColumns: stamps }),
  );
  assert.equal(allowed.tableRows('x_item')[0].x_reviewer.id, 'other');
});

test('authenticated portal scalar HTTP create/update with complete audit relationships retain pipeline traces and denied bindings', async (t) => {
  const sim = await simulatorFixture(t, {
    prefix: 'paq-audit-bindings-',
    watch: false,
    trace: { level: 'full' },
    files: {
      'website.yml': 'adx_websiteid: invented\nadx_name: Invented audit fixture',
      'settings.sitesetting.yml':
        '- adx_name: Webapi/x_item/enabled\n  adx_value: true\n- adx_name: Webapi/x_item/fields\n  adx_value: x_name,x_reviewer\n- adx_name: Webapi/systemuser/enabled\n  adx_value: true\n- adx_name: Webapi/systemuser/fields\n  adx_value: systemuserid',
    },
    initial: fixture().store.snapshot(),
  });
  const call = (method, suffix, body) =>
    fetch(sim.url + '/_api/x_items' + suffix, {
      method,
      headers: {
        ...signInHeaders(sim, 'visitor', { roles: ['Writer'] }),
        'content-type': 'application/json',
        __RequestVerificationToken: sim.csrf,
        prefer: 'return=representation',
      },
      body: JSON.stringify(body),
    });
  const update = await call('PATCH', '(item)', { x_name: 'HTTP updated' });
  assert.equal(update.status, 200, await update.clone().text());
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'HTTP updated');
  const create = await call('POST', '', { x_name: 'HTTP created' });
  assert.equal(create.status, 201, await create.clone().text());
  assert.equal(sim.store.tableRows('x_item').length, 2);
  assert.ok(sim.store.tableRows('x_item')[0].modifiedby);
  const denied = await call('PATCH', '(item)', { x_name: 'Denied', x_reviewer: ref('other') });
  assert.equal(denied.status, 403, await denied.clone().text());
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'HTTP updated');
  await sim.settle();
  const tree = sim.trace.tree(update.headers.get('x-trace-id'));
  assert.ok(tree.spans.some((span) => span.entity === 'x_item' && span.operation === 'update'));
  assert.ok(tree.spans.some((span) => span.kind === 'http' && span.actor.id === 'visitor'));
});
