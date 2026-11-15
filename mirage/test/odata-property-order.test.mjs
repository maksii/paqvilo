// @test-kind contract: explicit source order reorders projected entity keys without adding fields or changing values; metadata and HTTP consume the same structural order.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mappedODataPropertyOrder,
  orderODataProperties,
  validateODataPropertyOrder,
} from '../lib/odata-property-order.mjs';
import { createMetadataService } from '../lib/dataverse-metadata.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

test('property groups preserve values, unknown annotations and navigation continuation placement', () => {
  const input = {
    '@odata.etag': 'W/"1"',
    alpha: 'A',
    'owner@Microsoft.Dynamics.CRM.lookuplogicalname': 'sample',
    owner: 'owner-id',
    'owner@OData.Community.Display.V1.FormattedValue': 'Owner',
    'owner@Microsoft.Dynamics.CRM.associatednavigationproperty': 'sample_owner',
    'children@odata.nextLink': '/next',
    children: [{ name: 'Child' }],
    'alpha@custom.after': { value: 1 },
    'zulu@custom.before': 'Before',
    zulu: 'Z',
  };
  const before = structuredClone(input);
  const result = orderODataProperties(input, ['zulu', 'owner', 'missing', 'alpha']);
  assert.deepEqual(Object.keys(result), [
    '@odata.etag',
    'zulu@custom.before',
    'zulu',
    'owner@OData.Community.Display.V1.FormattedValue',
    'owner@Microsoft.Dynamics.CRM.associatednavigationproperty',
    'owner@Microsoft.Dynamics.CRM.lookuplogicalname',
    'owner',
    'alpha',
    'alpha@custom.after',
    'children',
    'children@odata.nextLink',
  ]);
  assert.deepEqual(result, before);
  assert.deepEqual(input, before);
  assert.equal(result.children, input.children, 'nested objects are not recursively interpreted as entities');
  assert.equal(Object.hasOwn(result, 'missing'), false);
  assert.equal(orderODataProperties(input, undefined), input);
});

// @test-kind security: source-order metadata must not execute accessors, accept sparse or inherited slots, or introduce reserved property names.
test('source-order admission rejects nondata and oversized inputs without invoking callbacks', () => {
  let calls = 0;
  const accessor = Object.defineProperty([], '0', {
    get() {
      calls++;
      return 'name';
    },
  });
  const iterator = ['name'];
  iterator[Symbol.iterator] = () => {
    calls++;
    return [][Symbol.iterator]();
  };
  for (const value of [
    [],
    ['name', 'name'],
    ['__proto__'],
    ['Constructor'],
    ['@odata.context'],
    ['name@x'],
    ['a'.repeat(129)],
    [1],
    new Array(2),
    accessor,
    iterator,
    Array(4097).fill('name'),
  ])
    assert.throws(() => validateODataPropertyOrder(value));
  const mapping = Object.defineProperty({}, 'odataPropertyOrder', {
    get() {
      calls++;
      return ['name'];
    },
  });
  assert.throws(() => mappedODataPropertyOrder(mapping));
  assert.equal(calls, 0);
  assert.equal(mappedODataPropertyOrder(Object.create({ odataPropertyOrder: ['name'] })), undefined);
  const original = ['zulu', 'sampleid'];
  const snapshot = mappedODataPropertyOrder({ odataPropertyOrder: original });
  original[0] = 'changed';
  assert.deepEqual(snapshot, ['zulu', 'sampleid']);
});

test('CSDL source order does not change SDK attribute registration or expose unselected columns', async (t) => {
  const mapping = {
    logicalName: 'sample',
    entitySet: 'samples',
    idColumn: 'sampleid',
    odataPropertyOrder: ['zulu', 'sampleid', 'alpha', 'never_admitted'],
    fields: { alpha: { dataverseType: 'nvarchar' }, zulu: { dataverseType: 'nvarchar' } },
  };
  const metadata = createMetadataService({ mappings: { sample: mapping } });
  const before = metadata.attributes('sample').map((attribute) => attribute.LogicalName);
  const names = [...metadata.csdl().matchAll(/<Property Name="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(names.indexOf('zulu') < names.indexOf('sampleid'));
  assert.ok(names.indexOf('sampleid') < names.indexOf('alpha'));
  assert.equal(names.includes('never_admitted'), false);
  assert.deepEqual(
    metadata.attributes('sample').map((attribute) => attribute.LogicalName),
    before,
  );
  const id = 'd0000000-0000-4000-8000-000000000001';
  const f = await contractModuleFixture(t, {
    mappings: { sample: mapping },
    tables: { sample: [{ sampleid: id, alpha: 'A', zulu: 'Z' }] },
    extension: { name: 'ordering-fixture', install: () => ({}) },
  });
  const row = await f.json(await f.request('GET', `/samples(${id})?$select=alpha,zulu`), 200);
  assert.deepEqual(
    Object.keys(row).filter((key) => ['alpha', 'sampleid', 'zulu'].includes(key)),
    ['zulu', 'sampleid', 'alpha'],
  );
  assert.equal(row.alpha, 'A');
  assert.equal(row.zulu, 'Z');
  assert.equal(Object.hasOwn(row, 'never_admitted'), false);
  const selected = await f.json(await f.request('GET', `/samples(${id})?$select=alpha`), 200);
  assert.equal(Object.hasOwn(selected, 'zulu'), false);
});
