// Standard table runtime: insert-only seeding of stand-in mappings, Solution mappings left alone,
// idempotence, activity flags and the field merge.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import {
  mergeFields,
  relationshipsOf,
  seed,
  standardFields,
  standardGlobalOptionSets,
  standardRelationshipsFor,
  standardSchema,
  standardTableDef,
} from '../lib/dataverse-standard.mjs';

test('seeding an empty state creates the account stand-in with its defaults', () => {
  const store = { state: emptyState() };
  seed(store);
  const mapping = store.state.mappings.account;
  assert.equal(mapping.entitySet, 'accounts');
  assert.equal(mapping.idColumn, 'accountid');
  assert.equal(mapping.nameColumn, 'name');
  assert.equal(mapping.dataverseOnly, true);
  assert.equal(mapping.standardTable, true);
  assert.equal(mapping.recordDefaults.donotemail, false);
  assert.equal(mapping.recordDefaults.statecode, 0);
  assert.equal(mapping.recordDefaults.statuscode, 1);
  assert.deepEqual(store.state.tables.account, []);
  assert.equal(mapping.fields.name.dataverseType, 'nvarchar');
  assert.equal(mapping.relationships.parentaccountid.entity, 'account');
});

test('an existing Solution mapping for account is left exactly as it was', () => {
  const solutionAccount = {
    logicalName: 'account',
    entitySet: 'invented_accounts',
    idColumn: 'accountid',
    nameColumn: 'name',
    fields: { x_tier: { dataverseType: 'nvarchar' } },
    relationships: {},
    schemaComplete: true,
  };
  const store = { state: { ...emptyState(), mappings: { account: structuredClone(solutionAccount) } } };
  seed(store);
  assert.deepEqual(store.state.mappings.account, solutionAccount);
  assert.notEqual(store.state.mappings.systemuser, undefined);
  assert.equal(store.state.mappings.systemuser.standardTable, true);
});

test('seeding twice gives an identical state', () => {
  const store = { state: emptyState() };
  seed(store);
  const first = structuredClone(store.state);
  seed(store);
  assert.deepEqual(store.state, first);
});

test('activity tables are flagged from the activityid primary id', () => {
  assert.equal(standardTableDef('task').isActivity, true);
  assert.equal(standardTableDef('activitypointer').isActivity, true);
  assert.equal(standardTableDef('account').isActivity, false);
  assert.equal(standardTableDef('activityparty').isActivity, false);
  // chat has activityid as its primary id, so it joins the nine activity tables.
  assert.equal(Object.values(standardSchema().tables).filter((t) => t.isActivity).length, 10);
  assert.equal(standardTableDef('no_such_table'), null);
});

test('Solution fields win over standard fields and the standard columns fill the rest', () => {
  const standard = standardFields('account');
  assert.equal(standard.name.maxLength, 160);
  assert.ok(standard.industrycode.options.length > 0);
  const merged = mergeFields(standard, { name: { name: 'name', maxLength: 200 }, x_tier: { name: 'x_tier' } });
  assert.equal(merged.name.maxLength, 200);
  assert.equal(merged.x_tier.name, 'x_tier');
  assert.deepEqual(merged.industrycode, standard.industrycode);
});

test('global option sets are keyed by Name with labelled options', () => {
  const sets = standardGlobalOptionSets();
  const priority = sets.activitypointer_deliveryprioritycode;
  assert.equal(priority.type, 'picklist');
  assert.deepEqual(
    priority.options.map((o) => o.label),
    ['Low', 'Normal', 'High'],
  );
  assert.equal(sets._organization_enableipbasedstorageaccesssignaturerule.type, 'boolean');
});

test('relationships of a table are returned in mapping shape, only for existing tables', () => {
  const all = standardRelationshipsFor('task', () => true);
  assert.equal(all.regardingobjectid_account_task.entity, 'account');
  assert.equal(all.regardingobjectid_account_task.type, 'many-to-one');
  assert.equal(all.regardingobjectid_account_task.many, false);
  const none = standardRelationshipsFor('task', (name) => name === 'task');
  assert.equal(none.regardingobjectid_account_task, undefined);
});

test('hierarchy-enabled standard self relationships (account and user parents) carry hierarchical on both sides only', () => {
  const account = standardRelationshipsFor('account', () => true);
  assert.equal(account.parentaccountid.entity, 'account');
  assert.equal(account.parentaccountid.hierarchical, true, 'the many-to-one side');
  assert.equal(account.account_parent_account.hierarchical, true, 'the one-to-many side');
  const user = standardRelationshipsFor('systemuser', () => true);
  assert.equal(user.parentsystemuserid.hierarchical, true);
  assert.equal(user.user_parent_user.hierarchical, true);
  // contact_master_contact is a self relationship too, but not hierarchy-enabled: no flag, not even false.
  const contact = Object.values(standardRelationshipsFor('contact', () => true)).find(
    (r) => r.schemaName === 'contact_master_contact',
  );
  assert.equal(contact.entity, 'contact');
  assert.equal(Object.hasOwn(contact, 'hierarchical'), false);
  assert.equal(
    Object.hasOwn(standardRelationshipsFor('task', () => true).regardingobjectid_account_task, 'hierarchical'),
    false,
  );
});

test('relationshipsOf: a Dataverse read adds the standard navigations a mapping lacks; own wins; portal reads stay unchanged', async () => {
  const state = emptyState();
  seed({ state });
  const nav = 'regardingobjectid_account_task';
  // A Solution mapping of task that carries none of its standard navigations.
  state.mappings.task.relationships = {};
  const store = await new DataStore({ state }).init();
  const expected = standardRelationshipsFor('task', (name) => Boolean(state.mappings[name]))[nav];
  assert.equal(store.relationshipsFor(store.resolveMapping('task'), { dataverse: {} })[nav].entity, expected.entity);
  assert.equal(
    store.relationshipsFor(store.resolveMapping('task'), {})[nav],
    undefined,
    "a portal caller keeps the mapping's own relationships",
  );
  assert.equal(relationshipsOf(store, 'task', {}, false)[nav], undefined);
  const own = { [nav]: { entity: 'marker', many: false } };
  assert.equal(relationshipsOf(store, 'task', own, true)[nav].entity, 'marker', "the mapping's own navigation wins");
  assert.equal(own[nav].entity, 'marker', 'the mapping is not written');
  const plain = {};
  assert.equal(
    relationshipsOf(store, 'widget', plain, true),
    plain,
    'a table without standard navigations reads its own object',
  );
});

test('plug-in and process tables carry the relationships their registration uses', () => {
  const schema = standardSchema();
  const rel = (name) => schema.relationships[name];
  assert.equal(rel('plugintype_customapi').referencedEntity, 'plugintype');
  assert.equal(rel('pluginassembly_plugintype').cascade.delete, 'Cascade');
  assert.equal(rel('plugintype_sdkmessageprocessingstep').referencingAttribute, 'eventhandler');
  assert.equal(rel('sdkmessageprocessingstepid_sdkmessageprocessingstepimage').cascade.delete, 'Cascade');
  assert.deepEqual(schema.targets['customapi/plugintypeid'], ['plugintype']);
  // The documented column table names sdkmessagefilter for plugintypeid; the relationship names plugintype, and targets follow relationships.
  assert.deepEqual(schema.targets['sdkmessageprocessingstep/plugintypeid'], ['plugintype']);
  assert.deepEqual(schema.targets['asyncoperation/workflowactivationid'], ['workflow']);
});
