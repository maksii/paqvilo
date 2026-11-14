import test from 'node:test';
import assert from 'node:assert/strict';
import { remapDatasetIdentities } from '../fixtures.mjs';

const id = (index) => `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
function fixture() {
  const table = (name, attributes) => ({ primaryIdAttribute: `${name}id`, attributes });
  return {
    schema: {
      tables: {
        x_item: table('x_item', { x_parent: { type: 'lookup' }, x_customer: { type: 'customer' } }),
        x_group: table('x_group', {}),
        x_edge: table('x_edge', { x_item: { type: 'uniqueidentifier' }, x_group: { type: 'uniqueidentifier' } }),
      },
      targets: { 'x_item/x_parent': ['x_group'], 'x_item/x_customer': ['x_group', 'x_item'] },
      relationships: {
        item_parent: {
          type: 'one-to-many',
          referencingEntity: 'x_item',
          referencingAttribute: 'x_parent',
          referencedEntity: 'x_group',
        },
        item_groups: {
          type: 'many-to-many',
          entity1: 'x_item',
          entity2: 'x_group',
          intersectEntity: 'x_edge',
          attribute1: 'x_item',
          attribute2: 'x_group',
        },
      },
    },
    fragment: {
      tables: {
        x_item: [
          { x_itemid: id(1), x_parent: { id: id(2), logical_name: 'x_group', name: 'Synthetic group' }, x_note: id(1) },
        ],
        x_group: [{ x_groupid: id(2) }],
        x_edge: [{ x_edgeid: id(3), x_item: id(1), x_group: id(2) }],
      },
      provenance: { purpose: 'invented reference graph' },
    },
    identities: { x_item: { [id(1)]: id(11) }, x_group: { [id(2)]: id(12) } },
  };
}

test('explicit IDs, typed references and source-derived N:N edge columns remap together without changing business text', () => {
  const input = fixture(),
    untouched = structuredClone(input);
  const result = remapDatasetIdentities(input.fragment, input);
  assert.equal(result.fragment.tables.x_item[0].x_itemid, id(11));
  assert.deepEqual(result.fragment.tables.x_item[0].x_parent, {
    id: id(12),
    logical_name: 'x_group',
    name: 'Synthetic group',
  });
  assert.equal(result.fragment.tables.x_item[0].x_note, id(1));
  assert.deepEqual(result.fragment.tables.x_edge[0], { x_edgeid: id(3), x_item: id(11), x_group: id(12) });
  assert.deepEqual(result.report, { remappedRows: 2, remappedLookups: 3, unverifiedLookups: 0, unusedIdentities: 0 });
  assert.deepEqual(input, untouched);
  assert.deepEqual(remapDatasetIdentities(input.fragment, input), result);
});

test('aliased table arrays and rows keep substitutions within each table metadata boundary', () => {
  for (const sharedArray of [false, true]) {
    const opaque = { labels: ['Synthetic value'] };
    const row = { x_aid: id(1), x_bid: id(2), opaque };
    const rows = [row];
    const input = {
      tables: { x_a: rows, x_b: sharedArray ? rows : [row] },
    };
    const schema = {
      tables: {
        x_a: {
          primaryIdAttribute: 'x_aid',
          attributes: { x_aid: { type: 'primarykey' }, x_bid: { type: 'nvarchar' } },
        },
        x_b: {
          primaryIdAttribute: 'x_bid',
          attributes: { x_bid: { type: 'primarykey' }, x_aid: { type: 'nvarchar' } },
        },
      },
    };
    const before = structuredClone(input);
    const { fragment, report } = remapDatasetIdentities(input, {
      schema,
      identities: { x_a: { [id(1)]: id(11) }, x_b: { [id(2)]: id(12) } },
    });
    assert.deepEqual(fragment.tables.x_a[0], { ...row, x_aid: id(11) });
    assert.deepEqual(fragment.tables.x_b[0], { ...row, x_bid: id(12) });
    assert.notEqual(fragment.tables.x_a, fragment.tables.x_b);
    assert.notEqual(fragment.tables.x_a[0], fragment.tables.x_b[0]);
    assert.notEqual(fragment.tables.x_a[0].opaque, opaque);
    assert.equal(fragment.tables.x_a[0].opaque, fragment.tables.x_b[0].opaque);
    assert.deepEqual(report, { remappedRows: 2, remappedLookups: 0, unverifiedLookups: 0, unusedIdentities: 0 });
    assert.deepEqual(input, before);
  }
});

test('a lookup object aliased to its row uses the original identity exactly once', () => {
  const row = { id: id(1), logical_name: 'x_item' };
  row.x_parent = row;
  const input = { tables: { x_item: [row, { id: id(11) }] } };
  const before = structuredClone(input);
  const { fragment, report } = remapDatasetIdentities(input, {
    schema: {
      tables: {
        x_item: { primaryIdAttribute: 'id', attributes: { id: { type: 'primarykey' }, x_parent: { type: 'lookup' } } },
      },
      targets: { 'x_item/x_parent': ['x_item'] },
    },
    identities: { x_item: { [id(1)]: id(11), [id(11)]: id(21) } },
  });
  assert.equal(fragment.tables.x_item[0].id, id(11));
  assert.equal(fragment.tables.x_item[0].x_parent.id, id(11));
  assert.equal(fragment.tables.x_item[1].id, id(21));
  assert.equal(report.remappedLookups, 1);
  assert.deepEqual(input, before);
});

test('self-reference cycles use simultaneous substitutions rather than chaining destinations', () => {
  const input = fixture();
  input.schema.targets['x_item/x_parent'] = ['x_item'];
  delete input.schema.relationships.item_parent;
  input.fragment.tables = {
    x_item: [
      { x_itemid: id(1), x_parent: { id: id(2), logical_name: 'x_item' } },
      { x_itemid: id(2), x_parent: { id: id(1), logical_name: 'x_item' } },
    ],
  };
  input.identities = { x_item: { [id(1)]: id(2), [id(2)]: id(1) } };
  const { fragment } = remapDatasetIdentities(input.fragment, input);
  assert.deepEqual(
    fragment.tables.x_item.map((row) => [row.x_itemid, row.x_parent.id]),
    [
      [id(2), id(1)],
      [id(1), id(2)],
    ],
  );
});

test('owner abstraction uses existing source field semantics instead of treating owner as a concrete target table', () => {
  const input = fixture();
  input.schema.tables.x_item.attributes.ownerid = { name: 'ownerid', type: 'owner' };
  input.schema.tables.systemuser = { primaryIdAttribute: 'systemuserid', attributes: {} };
  input.schema.targets['x_item/ownerid'] = ['owner'];
  input.fragment.tables.systemuser = [{ systemuserid: id(4) }];
  input.fragment.tables.x_item[0].ownerid = { id: id(4), logical_name: 'systemuser' };
  input.identities.systemuser = { [id(4)]: id(14) };
  assert.equal(remapDatasetIdentities(input.fragment, input).fragment.tables.x_item[0].ownerid.id, id(14));
});

test('polymorphic raw lookups require a target while typed and Web API annotated references preserve their shape', () => {
  const input = fixture();
  input.fragment.tables.x_item[0].x_customer = id(2);
  assert.throws(() => remapDatasetIdentities(input.fragment, input), /explicit logical target/);
  input.fragment.tables.x_item[0]['x_customer@Microsoft.Dynamics.CRM.lookuplogicalname'] = 'x_group';
  const result = remapDatasetIdentities(input.fragment, input).fragment;
  assert.equal(result.tables.x_item[0].x_customer, id(12));
  assert.equal(result.tables.x_item[0]['x_customer@Microsoft.Dynamics.CRM.lookuplogicalname'], 'x_group');
  input.fragment.tables.x_item[0].x_customer = { id: id(2), logical_name: 'x_item' };
  assert.throws(() => remapDatasetIdentities(input.fragment, input), /disagree/);
});

test('logical and Web API lookup aliases stay consistent and conflicting source representations are refused', () => {
  const input = fixture();
  input.fragment.tables.x_item[0]._x_parent_value = id(2);
  const output = remapDatasetIdentities(input.fragment, input).fragment.tables.x_item[0];
  assert.equal(output._x_parent_value, id(12));
  assert.equal(output.x_parent.id, id(12));
  input.fragment.tables.x_item[0]._x_parent_value = id(3);
  assert.throws(() => remapDatasetIdentities(input.fragment, input), /representations disagree/);
});

test('a shared GUID cannot hide contradictory polymorphic targets across logical and wire aliases', () => {
  const input = fixture();
  input.fragment.tables.x_item.push({ x_itemid: id(2) });
  input.identities.x_item[id(2)] = id(22);
  Object.assign(input.fragment.tables.x_item[0], {
    x_customer: { id: id(2), logical_name: 'x_group' },
    _x_customer_value: id(2),
    'x_customer@Microsoft.Dynamics.CRM.lookuplogicalname': 'x_group',
    '_x_customer_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'x_item',
  });
  const before = structuredClone(input);
  assert.throws(() => remapDatasetIdentities(input.fragment, input), /targets disagree/);
  assert.deepEqual(input, before);
});

test('rewritten external targets must be explicitly supplied and untouched external references are reported unverified', () => {
  const input = fixture();
  delete input.fragment.tables.x_group;
  delete input.fragment.tables.x_edge;
  assert.throws(() => remapDatasetIdentities(input.fragment, input), /absent from fragment/);
  const existing = { x_group: [{ x_groupid: id(12) }] };
  assert.equal(
    remapDatasetIdentities(input.fragment, { ...input, existing }).fragment.tables.x_item[0].x_parent.id,
    id(12),
  );
  input.identities = {};
  const result = remapDatasetIdentities(input.fragment, input);
  assert.equal(result.fragment.tables.x_item[0].x_parent.id, id(2));
  assert.equal(result.report.unverifiedLookups, 1);
});

test('destination collisions, aliases, invalid metadata and unresolved non-row sections fail before any input changes', () => {
  for (const change of [
    (input) => {
      input.identities.x_item[id(9)] = id(11);
    },
    (input) => {
      input.fragment.tables.x_item.push({ x_itemid: id(11) });
    },
    (input) => {
      input.existing = { x_item: [{ x_itemid: id(11) }] };
    },
    (input) => {
      input.identities.x_item[`{${id(1).toUpperCase()}}`] = id(15);
    },
    (input) => {
      input.schema.tables.x_item.primaryIdAttribute = undefined;
    },
    (input) => {
      input.fragment.personaRoles = [{ contactId: id(1), roles: ['Synthetic'] }];
    },
  ]) {
    const input = fixture();
    change(input);
    const before = structuredClone(input);
    assert.throws(() => remapDatasetIdentities(input.fragment, input), /Dataset identity/);
    assert.deepEqual(input, before);
  }
});

test('GUID-looking opaque properties and unmapped identities are preserved including metadata and provenance', () => {
  const input = fixture();
  input.fragment.tables.x_item[0].x_json = { id: id(2), logical_name: 'x_group' };
  input.identities = {};
  const output = remapDatasetIdentities(input.fragment, input);
  assert.deepEqual(output.fragment, input.fragment);
  assert.notEqual(output.fragment.tables.x_item[0], input.fragment.tables.x_item[0]);
  assert.equal(output.report.remappedRows, 0);
});

test('row and work limits reject oversized aliases without processing unbounded graph products', () => {
  const input = fixture();
  input.fragment.tables.x_item = Array(100_001).fill(input.fragment.tables.x_item[0]);
  assert.throws(() => remapDatasetIdentities(input.fragment, input), /100000/);
  input.fragment.tables.x_item = [fixture().fragment.tables.x_item[0]];
  input.schema.targets['x_item/x_parent'] = Array(1_000_001).fill('x_group');
  assert.throws(() => remapDatasetIdentities(input.fragment, input), /work-unit budget/);
});

test('a shared polymorphic target set is charged for every raw lookup before candidate expansion', () => {
  const input = fixture(),
    targets = [];
  input.identities = {};
  input.schema.relationships = {};
  for (let index = 0; index < 1000; index++) {
    const name = `x_target${index}`;
    targets.push(name);
    input.schema.tables[name] = { primaryIdAttribute: `${name}id`, attributes: {} };
  }
  input.schema.targets = { 'x_item/x_customer': targets };
  input.fragment.tables = {
    x_item: Array.from({ length: 1000 }, (_, index) => ({ x_itemid: id(index + 1), x_customer: id(5000) })),
  };
  assert.throws(() => remapDatasetIdentities(input.fragment, input), /work-unit budget/);
});
