// @test-kind compatibility: documented OData @odata.type binding and SDK wire types (Money, Decimal, Int64, EntityCollection paging, KeyAttributes)
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { exactNumeric } from '../lib/exact-numeric.mjs';
import {
  pluginMessageParameters,
  pluginMessageValues,
  reconcilePluginMessageParameters,
} from '../lib/plugin-message-values.mjs';

const id = '10000000-0000-0000-0000-000000000001';
function fixture() {
  const state = emptyState();
  state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
  state.tables.widget = [];
  return new DataStore({ state });
}

test('custom API Entity transport uses OData annotations to bind types without turning annotations into attributes', () => {
  const store = fixture();
  const parameters = pluginMessageParameters(store, [{ uniquename: 'Item', type: 3 }], {
    Item: {
      '@odata.type': 'Microsoft.Dynamics.CRM.widget',
      widgetid: id,
      title: 'Invented',
      'title@OData.Community.Display.V1.FormattedValue': 'Formatted',
    },
  });
  assert.equal(parameters.values.Item.id, id);
  assert.equal(parameters.values.Item.logicalName, 'widget');
  assert.equal(parameters.values.Item.attributes.title, 'Invented');
  assert.ok(Object.keys(parameters.values.Item.attributes).every((name) => !name.includes('@')));
});

test('changed and reordered JavaScript Entity collections retain projected attributes and SDK paging metadata', () => {
  const store = fixture(),
    other = '10000000-0000-0000-0000-000000000002';
  const prior = {
    $type: 'ParameterCollection',
    values: {
      Items: {
        $type: 'EntityCollection',
        entityName: 'widget',
        moreRecords: true,
        totalRecordCount: 17,
        pagingCookie: '<cookie page="2" />',
        entities: [id, other].map((key, index) => ({
          $type: 'Entity',
          logicalName: 'widget',
          id: key,
          attributes: { title: `Title ${index}` },
          rowVersion: `${index + 11}`,
          formattedValues: { title: `Format ${index}` },
        })),
      },
    },
  };
  const before = pluginMessageValues(prior, store),
    after = structuredClone(before);
  after.Items.reverse();
  after.Items[0].title = 'Changed';
  const specs = [{ uniquename: 'Items', type: 4, logicalentityname: 'widget' }];
  const result = reconcilePluginMessageParameters(store, specs, prior, before, after).values.Items;
  assert.deepEqual(
    result.entities.map((entity) => entity.id),
    [other, id],
  );
  assert.equal(result.entities[0].attributes.title, 'Changed');
  assert.ok(result.entities.every((entity) => !Object.hasOwn(entity.attributes, 'widgetid')));
  assert.equal(result.entities[0].rowVersion, '12');
  assert.equal(result.entities[0].formattedValues.title, 'Format 1');
  assert.equal(result.entityName, 'widget');
  assert.equal(result.moreRecords, true);
  assert.equal(result.totalRecordCount, 17);
  assert.equal(result.pagingCookie, '<cookie page="2" />');
  const replacement = structuredClone(prior.values.Items);
  replacement.moreRecords = false;
  replacement.totalRecordCount = 0;
  replacement.pagingCookie = null;
  const explicit = reconcilePluginMessageParameters(store, specs, prior, before, { Items: replacement }).values.Items;
  assert.equal(explicit.moreRecords, false);
  assert.equal(explicit.totalRecordCount, 0);
  assert.equal(explicit.pagingCookie, null);
});

test('declared and inferred exact numeric parameters emit native Money, Decimal and Int64 wire values', () => {
  const store = fixture();
  const specs = [
    { uniquename: 'Cash', type: 8 },
    { uniquename: 'Amount', type: 2 },
  ];
  const result = pluginMessageParameters(store, specs, {
    Cash: exactNumeric('9007199254740994.25', 'Money'),
    Amount: exactNumeric('9007199254740994.25', 'Decimal'),
  });
  assert.deepEqual(result.values.Cash, { $type: 'Money', value: '9007199254740994.25' });
  assert.deepEqual(result.values.Amount, { $type: 'Decimal', value: '9007199254740994.25' });
  const previous = { $type: 'ParameterCollection', values: { Sequence: { $type: 'Int64', value: '7' } } };
  const changed = reconcilePluginMessageParameters(store, [], previous, { Sequence: 7 }, { Sequence: 8 });
  assert.deepEqual(changed.values.Sequence, { $type: 'Int64', value: '8' });
});

test('SDK Entity and EntityCollection parameters retain identities independent of selected Attributes', () => {
  const store = fixture();
  const entity = { $type: 'Entity', logicalName: 'widget', id, attributes: { title: 'Id is separate' } };
  const parameters = {
    $type: 'ParameterCollection',
    values: { Item: entity, Items: { $type: 'EntityCollection', entities: [entity] } },
  };
  const values = pluginMessageValues(parameters, store);
  assert.equal(values.Item.widgetid, id);
  assert.equal(values.Items[0].widgetid, id);
  const repeated = pluginMessageParameters(
    store,
    [
      { uniquename: 'Item', type: 3 },
      { uniquename: 'Items', type: 4 },
    ],
    values,
  );
  assert.equal(repeated.values.Item.id, id);
  assert.equal(repeated.values.Items.entities[0].id, id);
  assert.equal(repeated.values.Item.attributes.title, 'Id is separate');
});

test('changed SDK arrays and references retain element types, exact values and alternate-key metadata', () => {
  const store = fixture();
  const prior = {
    values: {
      Names: { $type: 'PrimitiveArray', elementType: 'String', values: ['Before'] },
      Sequence: {
        $type: 'PrimitiveArray',
        elementType: 'Int64',
        values: [
          { $type: 'Int64', value: '9007199254740993' },
          { $type: 'Int64', value: '7' },
        ],
      },
      Amounts: {
        $type: 'PrimitiveArray',
        elementType: 'Decimal',
        values: [{ $type: 'Decimal', value: '9007199254740993.25' }],
      },
      Choices: { $type: 'OptionSetValueCollection', values: [{ $type: 'OptionSetValue', value: 1 }] },
      Ref: {
        $type: 'EntityReference',
        logicalName: 'widget',
        id,
        name: 'Before',
        rowVersion: '17',
        keyAttributes: { alternatecode: 'Before', keyid: { $type: 'Guid', value: id } },
      },
    },
  };
  const before = pluginMessageValues(prior, store),
    after = structuredClone(before);
  after.Names[0] = 'After';
  after.Sequence.reverse();
  after.Sequence[0] = 8;
  after.Amounts[0] = exactNumeric('9007199254740994.25', 'Decimal');
  after.Choices.push(2);
  after.Ref.name = 'After';
  after.Ref.keyAttributes.alternatecode = 'After';
  after.Ref.keyAttributes.keyid = '10000000-0000-0000-0000-000000000002';
  const answer = reconcilePluginMessageParameters(store, [], prior, before, after).values;
  assert.deepEqual(answer.Names, { $type: 'PrimitiveArray', elementType: 'String', values: ['After'] });
  assert.deepEqual(answer.Sequence.values, [
    { $type: 'Int64', value: '8' },
    { $type: 'Int64', value: '9007199254740993' },
  ]);
  assert.deepEqual(answer.Amounts.values, [{ $type: 'Decimal', value: '9007199254740994.25' }]);
  assert.deepEqual(answer.Choices, {
    $type: 'OptionSetValueCollection',
    values: [
      { $type: 'OptionSetValue', value: 1 },
      { $type: 'OptionSetValue', value: 2 },
    ],
  });
  assert.equal(answer.Ref.rowVersion, '17');
  assert.equal(answer.Ref.name, 'After');
  assert.deepEqual(answer.Ref.keyAttributes, {
    alternatecode: 'After',
    keyid: { $type: 'Guid', value: after.Ref.keyAttributes.keyid },
  });
});
