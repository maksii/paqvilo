// @test-kind security: Unknown-schema error formatting uses static complete metadata and preserves every known or sensitive field check without row access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rejectedGatewayProperty } from '../lib/webapi-gateway-fields.mjs';
import { createWebApiFormatter } from '../lib/webapi-format.mjs';
const mapping = {
  logicalName: 'probe',
  idColumn: 'probeid',
  schemaComplete: true,
  fields: { title: {}, secret: {}, owner: {} },
  relationships: {
    manager: { from: 'owner', entity: 'other' },
    nested: { from: 'parentid', entity: 'other' },
    privateRef: { from: '__sim_private', entity: 'other' },
  },
};
test('complete static schema identifies only truly absent properties', () => {
  const checked = [];
  const actual = rejectedGatewayProperty(
    { title: 'allowed', unknown: 1 },
    {
      mapping,
      fields: ['configured'],
      metadataFields: [{ exported: {} }],
      operation: 'update',
      assertWrite: (body, operation) => checked.push({ body, operation }),
    },
  );
  assert.equal(actual, 'unknown');
  assert.deepEqual(checked, [{ body: { title: 'allowed' }, operation: 'update' }]);
  for (const name of [
    'probeid',
    'title',
    'TITLE',
    '_owner_value',
    'manager',
    'parentid',
    'configured',
    'exported',
    'manager@odata.bind',
    '@odata.type',
    '__sim_private',
    'privateRef',
    '__proto__',
    'constructor',
    'prototype',
  ]) {
    const body = Object.fromEntries([
      [name, 'checked'],
      ['unknown', 1],
    ]);
    assert.throws(
      () =>
        rejectedGatewayProperty(body, {
          mapping,
          fields: ['configured'],
          metadataFields: [{ exported: {} }],
          assertWrite: (known) => {
            assert.ok(Object.hasOwn(known, name));
            throw Error('normal field guard');
          },
        }),
      /normal field guard/,
    );
  }
  let calls = 0;
  assert.equal(
    rejectedGatewayProperty(
      { unknown: 1 },
      { mapping: { ...mapping, schemaComplete: false }, assertWrite: () => calls++ },
    ),
    null,
  );
  assert.equal(calls, 0);
});

test('primary-key presentation never exposes private identifiers in either response profile', () => {
  const source = { logicalName: 'probe', idColumn: '__sim_private', fields: { title: { dataverseType: 'nvarchar' } } };
  const row = { __sim_private: 'private-owned-fixture', title: 'Visible', __sim_other: 'hidden' };
  const store = {
    primaryKeySubset: () => [row],
    etag: () => 'W/"1"',
    fieldDefinition: (_entity, name) => source.fields[name],
  };
  for (const primaryKeyFirst of [false, true]) {
    const formatter = createWebApiFormatter({ store, formatting: { primaryKeyFirst } });
    const actual = formatter.formatEntity(row, source);
    assert.deepEqual(actual, { '@odata.etag': 'W/"1"', title: 'Visible' });
    assert.doesNotMatch(JSON.stringify(actual), /private-owned-fixture|__sim_/);
  }
});
