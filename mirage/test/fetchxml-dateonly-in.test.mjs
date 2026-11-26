// @test-kind contract: portal FetchXML refuses the Q-096 numeric DateOnly list operand and keeps valid operators and permission admission
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore } from '../lib/data.mjs';

const query = (attribute, ...values) =>
  `<fetch><entity name="test_entry"><attribute name="test_entryid"/><filter><condition attribute="${attribute}" operator="in">${values
    .map((value) => `<value>${value}</value>`)
    .join('')}</condition></filter></entity></fetch>`;
const portal = { portalRequest: true };
const visitor = { contactId: 'person', roles: ['Reader'] };
const row = {
  test_entryid: 'entry',
  test_day: '2026-06-15',
  test_time: '2026-06-15T12:00:00Z',
  test_choice: 970840000,
};
function fixture({ rows = [row], allowed = true } = {}) {
  const store = new DataStore({
    state: {
      mappings: {
        test_entry: {
          entitySet: 'test_entries',
          idColumn: 'test_entryid',
          fields: {
            test_day: { dataverseType: 'datetime', dateTimeBehavior: 'DateOnly' },
            test_time: { dataverseType: 'datetime', dateTimeBehavior: 'UserLocal', format: 'DateOnly' },
            test_choice: { dataverseType: 'picklist' },
          },
        },
      },
      tables: { test_entry: rows },
      permissions: allowed
        ? [{ id: 'list-reader', entity: 'test_entry', roles: ['Reader'], scope: 'global', operations: ['read'] }]
        : [],
      settings: { permissionMode: 'enforce' },
    },
  });
  store.setObserved({ tablePermissionQueryPipeline: 'native-classic', evidence: 'Invented local admission fixture' });
  return store;
}

test('a portal DateOnly IN rejects the numeric choice operand before matching any rows', () => {
  for (const [rows, values] of [
    [[row], ['970840000']],
    [[row], ['2026-06-15', '970840000']],
    [[], ['970840000']],
  ]) {
    const store = fixture({ rows });
    assert.throws(() => store.fetchXml(query('test_day', ...values), visitor, portal), {
      code: 'InvalidDateTime',
      message: 'The date-time format for 970840000 is invalid, or value is outside the supported range.',
    });
  }
});

test('ordinary DateOnly, offset datetime and numeric choice IN operands still match', () => {
  const store = fixture();
  for (const [name, value] of [
    ['test_day', '2026-06-15'],
    ['test_day', '2026-06-15T00:00:00Z'],
    ['test_time', '2026-06-15T14:00:00+02:00'],
    ['test_choice', '970840000'],
  ])
    assert.deepEqual(store.fetchXml(query(name, value), visitor, portal).entities, [{ test_entryid: 'entry' }]);
});

test('a denied portal read skips backend date validation and returns its empty result', () => {
  const result = fixture({ allowed: false }).fetchXml(query('test_day', '970840000'), visitor, portal);
  assert.deepEqual(result.entities, []);
  assert.equal(result.backendAdmission, 'denied-before-dataverse');
});
