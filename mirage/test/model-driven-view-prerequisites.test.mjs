import test from 'node:test';
import assert from 'node:assert/strict';
import { viewColumnPrerequisites } from '../lib/model-driven/view-prerequisites.mjs';
import { buildSourceGraph } from '../lib/source-graph.mjs';
import { buildPreflightReport } from '../lib/capability-report.mjs';

test('view preflight names missing projected, filtered, ordered and joined fields with app and source', () => {
  const metadata = {
    entities: {
      x_item: { fields: { x_id: {}, x_name: {}, x_parent: {} } },
      x_parent: { fields: { x_id: {}, x_name: {} } },
    },
    modelDrivenApps: [{ id: 'app', uniqueName: 'x_app', components: [{ type: 1, entity: 'x_item' }] }],
    views: [
      {
        id: 'view',
        entity: 'x_item',
        name: 'Items',
        file: 'solution/Items.xml',
        queryType: 0,
        fetchXml:
          '<fetch><entity name="x_item"><attribute name="x_name" alias="display"/><attribute name="x_missing"/><order attribute="x_sort"/><filter><condition attribute="x_filter" operator="eq" value="1"/></filter><link-entity name="x_parent" alias="p" from="x_id" to="x_parent"><attribute name="x_name" alias="parentname"/><filter><condition attribute="x_unknown" operator="eq" value="1"/></filter></link-entity><order alias="display"/></entity></fetch>',
        fields: [{ name: 'display' }, { name: 'p.x_name' }, { name: 'parentname' }],
      },
    ],
  };
  const missing = viewColumnPrerequisites({ metadata });
  assert.deepEqual(missing.map((gap) => `${gap.entity}.${gap.column}`).sort(), [
    'x_item.x_filter',
    'x_item.x_missing',
    'x_item.x_sort',
    'x_parent.x_unknown',
  ]);
  assert.ok(
    missing.every(
      (gap) =>
        gap.app === 'x_app' && gap.table === 'x_item' && gap.view === 'view' && gap.source === 'solution/Items.xml',
    ),
  );
  const rows = buildSourceGraph({ metadata })
    .requirements()
    .filter((row) => row.reason === 'MD_VIEW_COLUMN_MISSING');
  assert.equal(rows.length, 4);
  assert.ok(rows.every((row) => row.status === 'missing' && row.surface === 'staff'));
  const report = buildPreflightReport({ graph: buildSourceGraph({ metadata }), strict: true });
  const prerequisite = report.requirements.find((row) => row.reason === 'MD_VIEW_COLUMN_MISSING');
  assert.equal(prerequisite.details.app, 'x_app');
  assert.equal(prerequisite.details.view, 'view');
  assert.equal(prerequisite.details.source, 'solution/Items.xml');
  assert.ok(prerequisite.blocking);
  for (const gap of missing) metadata.entities[gap.entity].fields[gap.column] = {};
  assert.deepEqual(viewColumnPrerequisites({ metadata }), []);
});

test('nondefault view prerequisites follow app view selection and matching fallback', () => {
  const metadata = {
    entities: { x_item: { fields: { x_id: {} } } },
    modelDrivenApps: [
      {
        id: 'one',
        components: [
          { type: 1, entity: 'x_item' },
          { type: 26, id: '{VIEW-ONE}' },
        ],
      },
      {
        id: 'two',
        components: [
          { type: 1, entity: 'x_item' },
          { type: 26, id: 'not-in-this-table' },
        ],
      },
    ],
    views: ['view-one', 'view-two'].map((id) => ({
      id,
      entity: 'x_item',
      queryType: 0,
      isDefault: id === 'view-one',
      fields: [{ name: 'x_absent' }],
    })),
  };
  assert.deepEqual(
    viewColumnPrerequisites({ metadata }).map(({ app, view }) => [app, view]),
    [
      ['one', 'view-one'],
      ['two', 'view-one'],
      ['two', 'view-two'],
    ],
  );
});

test('declared standard fields, runtime mapping fields and aggregate aliases are valid without inventing unknown columns', () => {
  const metadata = {
    entities: { account: { fields: {} } },
    modelDrivenApps: [{ id: 'app', components: [{ type: 1, entity: 'account' }] }],
    views: [
      {
        id: 'aggregate',
        entity: 'account',
        fetchXml:
          '<fetch aggregate="true"><entity name="account"><attribute name="accountid" alias="total" aggregate="count"/><order alias="total"/><filter><condition attribute="x_runtime" operator="not-null"/></filter></entity></fetch>',
        fields: [{ name: 'total' }, { name: 'name' }],
      },
    ],
  };
  assert.deepEqual(
    viewColumnPrerequisites({ metadata, mappings: { account: { fields: { x_runtime: 'nvarchar' } } } }),
    [],
  );
  metadata.views[0].fields.push({ name: 'x_undeclared' });
  assert.equal(
    viewColumnPrerequisites({ metadata, mappings: { account: { fields: { x_runtime: 'nvarchar' } } } })[0].column,
    'x_undeclared',
  );
});
