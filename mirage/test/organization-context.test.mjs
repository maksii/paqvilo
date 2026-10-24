import test from 'node:test';
import assert from 'node:assert/strict';
import { organizationRecord } from '../lib/organization-context.mjs';

const first = '11111111-1111-4111-8111-111111111111',
  selected = '22222222-2222-4222-8222-222222222222';
test('all organization services select the configured row regardless of physical row order', () => {
  const state = {
    dataverse: { organizationId: selected.toUpperCase() },
    tables: {
      organization: [
        { organizationid: first, maxuploadfilesize: 1, isauditenabled: false },
        { organizationid: selected, maxuploadfilesize: 4096, isauditenabled: true },
      ],
    },
  };
  const before = structuredClone(state);
  assert.equal(organizationRecord(state), state.tables.organization[1]);
  assert.equal(organizationRecord({ state, tableRows: (name) => state.tables[name] }).isauditenabled, true);
  state.tables.organization.reverse();
  assert.equal(organizationRecord(state).maxuploadfilesize, 4096);
  state.tables.organization.reverse();
  assert.deepEqual(state, before);
  state.dataverse.organizationId = '33333333-3333-4333-8333-333333333333';
  assert.equal(
    organizationRecord(state),
    undefined,
    'a missing configured row must never fall back to a different organization',
  );
});

test('legacy embedded contexts retain a sole organization and refuse ambiguous or invalid UUID namespaces', () => {
  const sole = { organizationid: 'legacy' };
  assert.equal(organizationRecord({ tables: { organization: [sole] } }), sole);
  assert.equal(
    organizationRecord({ tables: { organization: [{ organizationid: 'one' }, { organizationid: selected }] } })
      .organizationid,
    selected,
  );
  assert.equal(
    organizationRecord({ tables: { organization: [{ organizationid: first }, { organizationid: selected }] } }),
    undefined,
  );
  assert.equal(
    organizationRecord({ tables: { organization: [{ organizationid: 'one' }, { organizationid: 'two' }] } }),
    undefined,
  );
});
