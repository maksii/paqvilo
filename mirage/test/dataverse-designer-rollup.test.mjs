// @test-kind unproven: local calculation of the unfiltered child Count shape from the repository's invented designer export
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { EXTENSION, parseRollupFormula } from '../lib/dataverse-rollup.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const PARENT = 'be000000-0000-4000-8000-000000000001';
const OTHER = 'be000000-0000-4000-8000-000000000002';
const CHILD = 'be000000-0000-4000-8000-000000000003';
const ANOTHER = 'be000000-0000-4000-8000-000000000004';
const DESIGNER_EXPORT = new URL(
  '../../examples/project/baseline/solution/Entities/pqvd_baselineparent/Formulas/pqvd_baselineparent-pqvd_rollup.xaml',
  import.meta.url,
);

async function designerCountFormula() {
  return (await fs.readFile(DESIGNER_EXPORT, 'utf8'))
    .replaceAll('pqvd_baselineparent_baselineitem', 'test_parent_child')
    .replaceAll('pqvd_parentid', 'test_parentid')
    .replaceAll('pqvd_baselineitem', 'test_child');
}

test('a designer-exported one-to-many Count recalculates and goes stale when a child moves', async (t) => {
  const formula = await designerCountFormula();
  assert.deepEqual(parseRollupFormula(formula), {
    child: 'test_child',
    link: 'test_parentid',
    relationship: 'test_parent_child',
    active: false,
    aggregate: 'count',
    attribute: 'test_childid',
    form: 'designer',
    unsupported: null,
  });
  assert.match(parseRollupFormula(formula.replace('>Count</', '>Median</')).unsupported, /Count, Sum, Average/);

  const { api, request, json } = await contractModuleFixture(t, {
    extension: EXTENSION,
    mappings: {
      test_parent: {
        logicalName: 'test_parent',
        entitySet: 'test_parents',
        idColumn: 'test_parentid',
        fields: {
          child_count: { dataverseType: 'int', columnMetadata: { sourceType: 2, formulaDefinition: formula } },
        },
      },
      test_child: {
        logicalName: 'test_child',
        entitySet: 'test_children',
        idColumn: 'test_childid',
        fields: { test_parentid: { dataverseType: 'lookup', targets: ['test_parent'] } },
        relationships: {
          test_parentid: { entity: 'test_parent', from: 'test_parentid', to: 'test_parentid', many: false },
        },
      },
    },
    tables: {
      test_parent: [{ test_parentid: PARENT }, { test_parentid: OTHER }],
      test_child: [
        { test_childid: CHILD, test_parentid: PARENT },
        { test_childid: ANOTHER, test_parentid: OTHER },
      ],
    },
  });
  const stale = () => api.rollups.isStale('test_parent', PARENT, 'child_count');
  const rollup = `/CalculateRollupField(Target=@target,FieldName=@field)?${new URLSearchParams({
    '@target': JSON.stringify({ '@odata.id': `test_parents(${PARENT})` }),
    '@field': "'child_count'",
  })}`;
  assert.equal((await json(await request('GET', rollup), 200)).child_count, 1);
  assert.equal(stale(), false);
  await json(
    await request('PATCH', `/test_children(${CHILD})`, { 'test_parentid@odata.bind': `/test_parents(${OTHER})` }),
    200,
  );
  assert.equal(stale(), true);
  assert.equal((await json(await request('GET', rollup), 200)).child_count, 0);
});

// @test-kind contract: the supported designer Count follows a direct declared relationship and typed Dataverse lookups
test('a designer child Count uses the named relationship and distinguishes lookup targets with the same GUID', async (t) => {
  const formula = await designerCountFormula();
  const foreign = 'be000000-0000-4000-8000-000000000005';
  const ambiguous = 'be000000-0000-4000-8000-000000000006';
  const rollupField = (formulaDefinition) => ({
    dataverseType: 'int',
    columnMetadata: { sourceType: 2, formulaDefinition },
  });
  const lookup = (entity, to, schemaName) => ({
    entity,
    to,
    schemaName,
    from: 'test_parentid',
    many: false,
  });
  const { request, json, api } = await contractModuleFixture(t, {
    extension: EXTENSION,
    mappings: {
      test_parent: {
        logicalName: 'test_parent',
        entitySet: 'test_parents',
        idColumn: 'test_parentid',
        fields: {
          child_count: rollupField(formula),
          wrong_count: rollupField(formula.replaceAll('test_parent_child', 'test_nonexistent_relationship')),
        },
      },
      test_alternate: {
        logicalName: 'test_alternate',
        entitySet: 'test_alternates',
        idColumn: 'test_alternateid',
      },
      test_child: {
        logicalName: 'test_child',
        entitySet: 'test_children',
        idColumn: 'test_childid',
        fields: {
          name: { dataverseType: 'nvarchar' },
          test_parentid: { dataverseType: 'lookup', targets: ['test_parent', 'test_alternate'] },
        },
        relationships: {
          test_parentid_parent: lookup('test_parent', 'test_parentid', 'test_parent_child'),
          test_parentid_alternate: lookup('test_alternate', 'test_alternateid', 'test_alternate_child'),
        },
      },
    },
    tables: {
      test_parent: [{ test_parentid: PARENT }, { test_parentid: OTHER }],
      test_alternate: [{ test_alternateid: PARENT }],
      test_child: [
        { test_childid: CHILD, test_parentid: { id: PARENT, logical_name: 'test_parent' } },
        { test_childid: foreign, test_parentid: { id: PARENT, logical_name: 'test_alternate' } },
        { test_childid: ambiguous, test_parentid: PARENT },
      ],
    },
  });
  const recalculate = async (column) =>
    json(
      await request(
        'GET',
        `/CalculateRollupField(Target=@target,FieldName=@field)?${new URLSearchParams({
          '@target': JSON.stringify({ '@odata.id': `test_parents(${PARENT})` }),
          '@field': `'${column}'`,
        })}`,
      ),
      200,
    );

  await t.test('a well-formed definition with an unresolved relationship reports unsupported', async () => {
    const result = await recalculate('wrong_count');
    assert.equal(Object.hasOwn(result, 'wrong_count'), false, 'a null value is absent');
    assert.equal(result.wrong_count_state, 2);
    assert.ok(
      api.rollups
        .diagnostics()
        .some((diagnostic) => diagnostic.column === 'wrong_count' && /direct child lookup/.test(diagnostic.message)),
    );
  });

  await t.test('only the typed matching child contributes or makes the rollup stale', async () => {
    assert.equal((await recalculate('child_count')).child_count, 1);
    assert.equal(api.rollups.isStale('test_parent', PARENT, 'child_count'), false);
    await json(await request('PATCH', `/test_children(${foreign})`, { name: 'Updated other relationship' }), 200);
    assert.equal(api.rollups.isStale('test_parent', PARENT, 'child_count'), false);
    await json(
      await request('PATCH', `/test_children(${CHILD})`, {
        'test_parentid_parent@odata.bind': `/test_parents(${OTHER})`,
      }),
      200,
    );
    assert.equal(api.rollups.isStale('test_parent', PARENT, 'child_count'), true);
    assert.equal((await recalculate('child_count')).child_count, 0);
  });
});

// @test-kind contract: designer Count shares standard relationship metadata and local polymorphic lookup resolution
test('a designer Count resolves standard relationship metadata and only counts uniquely held bare lookups', async (t) => {
  const formula = (await designerCountFormula())
    .replaceAll('test_parent_child', 'contact_customer_accounts')
    .replaceAll('test_parentid', 'parentcustomerid')
    .replaceAll('test_childid', 'contactid')
    .replaceAll('test_child', 'contact');
  const foreign = 'be000000-0000-4000-8000-000000000007';
  const ambiguous = 'be000000-0000-4000-8000-000000000008';
  const unique = 'be000000-0000-4000-8000-000000000009';
  const { api, request, json, store } = await contractModuleFixture(t, {
    extension: EXTENSION,
    mappings: {
      account: {
        logicalName: 'account',
        entitySet: 'accounts',
        idColumn: 'accountid',
        fields: {
          test_contact_count: { dataverseType: 'int', columnMetadata: { sourceType: 2, formulaDefinition: formula } },
        },
        relationships: {},
      },
      contact: {
        logicalName: 'contact',
        entitySet: 'contacts',
        idColumn: 'contactid',
        relationships: {},
      },
    },
    tables: {
      account: [{ accountid: PARENT }, { accountid: OTHER }],
      contact: [
        { contactid: PARENT },
        { contactid: CHILD, parentcustomerid: { id: PARENT, logical_name: 'account' } },
        { contactid: foreign, parentcustomerid: { id: PARENT, logical_name: 'contact' } },
        { contactid: ambiguous, parentcustomerid: PARENT },
        { contactid: unique, parentcustomerid: OTHER },
      ],
    },
  });
  assert.deepEqual(store.state.mappings.contact.relationships, {});
  const relationship = await json(
    await request(
      'GET',
      "/RelationshipDefinitions(SchemaName='contact_customer_accounts')/Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata",
    ),
    200,
  );
  assert.equal(relationship.ReferencedEntity, 'account');
  assert.equal(relationship.ReferencingEntity, 'contact');
  assert.equal(relationship.ReferencingAttribute, 'parentcustomerid');

  const recalculate = async (id = PARENT) =>
    json(
      await request(
        'GET',
        `/CalculateRollupField(Target=@target,FieldName=@field)?${new URLSearchParams({
          '@target': JSON.stringify({ '@odata.id': `accounts(${id})` }),
          '@field': "'test_contact_count'",
        })}`,
      ),
      200,
    );
  assert.equal((await recalculate()).test_contact_count, 1);
  assert.equal((await recalculate(OTHER)).test_contact_count, 1);
  assert.equal(api.rollups.isStale('account', PARENT, 'test_contact_count'), false);
  assert.equal(api.rollups.isStale('account', OTHER, 'test_contact_count'), false);
  // A write of a column the Count reads (the state; a write of another column marks nothing, summary-F6 DATA-04c2).
  await json(await request('PATCH', `/contacts(${unique})`, { firstname: 'Updated bare account target' }), 200);
  assert.equal(api.rollups.isStale('account', OTHER, 'test_contact_count'), false);
  await json(await request('PATCH', `/contacts(${unique})`, { statecode: 0 }), 200);
  assert.equal(api.rollups.isStale('account', OTHER, 'test_contact_count'), true);
  assert.equal((await recalculate(OTHER)).test_contact_count, 1);
  await json(await request('PATCH', `/contacts(${foreign})`, { statecode: 0 }), 200);
  await json(await request('PATCH', `/contacts(${ambiguous})`, { statecode: 0 }), 200);
  assert.equal(api.rollups.isStale('account', PARENT, 'test_contact_count'), false);
  await json(
    await request('PATCH', `/contacts(${CHILD})`, {
      'parentcustomerid_account@odata.bind': `/accounts(${OTHER})`,
    }),
    200,
  );
  assert.equal(api.rollups.isStale('account', PARENT, 'test_contact_count'), true);
  assert.equal((await recalculate()).test_contact_count, 0);
  assert.equal((await recalculate(OTHER)).test_contact_count, 2);

  // An authored navigation with this key displaces the inferred standard entry.
  await store.transact(() => {
    store.state.mappings.contact.relationships.parentcustomerid_account = {
      entity: 'account',
      from: 'parentcustomerid',
      to: 'accountid',
      many: false,
      schemaName: 'test_authored_relation',
    };
  });
  const unresolved = await recalculate();
  assert.equal(Object.hasOwn(unresolved, 'test_contact_count'), false, 'a null value is absent');
  assert.equal(unresolved.test_contact_count_state, 2);
});
