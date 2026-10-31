// @test-kind unproven: local model of rollup recalculation over many rows; no native capture cited
// The Mass Calculate Rollup Fields job (lib/dataverse-rollup.mjs): a recurring scheduler task recalculates every stale rollup
// column; with a manual scheduler it runs only when the clock passes the interval.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { EXTENSION } from '../lib/dataverse-rollup.mjs';
import { normalizeCapabilityRecord } from '../lib/capability-registry.mjs';
import { createScheduler, fixedClock } from '../testing.mjs';
import { rollupMappings } from './support/parent-child-tables.mjs';

const PARENT = '11111111-1111-4111-8111-111111111191';

test('the hourly mass recalculation computes stale rollup columns on the scheduler', async (t) => {
  const clock = fixedClock(Date.parse('2030-01-01T00:00:00.000Z'));
  const scheduler = createScheduler({ clock, manual: true });
  const state = emptyState();
  Object.assign(state.mappings, rollupMappings());
  state.tables.x_parent = [{ x_parentid: PARENT, x_name: 'Invented parent', x_total_state: 0, x_total_date: null }];
  state.tables.x_child = [
    {
      x_childid: '22222222-2222-4222-8222-222222222291',
      x_name: 'One',
      x_amount: 4,
      x_parentid: { id: PARENT, logical_name: 'x_parent' },
    },
    {
      x_childid: '22222222-2222-4222-8222-222222222292',
      x_name: 'Two',
      x_amount: 6,
      x_parentid: { id: PARENT, logical_name: 'x_parent' },
    },
  ];
  const store = await new DataStore({ state, clock }).init();
  const organization = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({ enabled: false }),
    scheduler,
  });
  t.after(() => organization.close());
  const row = () => store.state.tables.x_parent[0];
  assert.ok(scheduler.pending().some((task) => task.name === 'Mass Calculate Rollup Fields'));

  await scheduler.advance(30 * 60 * 1000);
  assert.equal(row().x_total_state, 0, 'not due before the interval');
  await scheduler.advance(30 * 60 * 1000);
  assert.equal(row().x_total, 10);
  assert.equal(row().x_total_state, 1);
  assert.equal(row().x_total_date, '2030-01-01T01:00:00.000Z');
  assert.ok(
    scheduler.pending().some((task) => task.name === 'Mass Calculate Rollup Fields'),
    'the job re-arms',
  );

  const record = normalizeCapabilityRecord(EXTENSION.describe(organization.api));
  assert.equal(record.operations.find((operation) => operation.name === 'MassRecalculation').level, 'behaviour');
  assert.equal(
    normalizeCapabilityRecord(EXTENSION.describe()).operations.find(
      (operation) => operation.name === 'MassRecalculation',
    ).level,
    'contract',
  );
});
