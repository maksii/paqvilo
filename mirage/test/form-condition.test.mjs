import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStepCondition, submitPortalForm, createWebFormSessions } from '../lib/form-service.mjs';
import { exactNumeric, isExactNumeric } from '../lib/exact-numeric.mjs';
import { DataStore } from '../lib/data.mjs';

const text = (value) => (isExactNumeric(value) ? value.value : String(value));

for (const [value, type, boundary] of [
  ['9007199254740993', 'Int64', '9007199254740992'],
  ['1.00000000000000000002', 'Decimal', '1.00000000000000000001'],
  ['99999999999.1234567892', 'Decimal', '99999999999.1234567891'],
])
  test(`${type} condition distinguishes adjacent stored digits at ${boundary}`, () => {
    const record = { n: exactNumeric(value, type, { collapse: false }) };
    const before = structuredClone(record);
    for (const [operator, expected] of [
      ['=', false],
      ['==', false],
      ['!=', true],
      ['>', true],
      ['<', false],
      ['>=', true],
      ['<=', false],
    ])
      assert.equal(evaluateStepCondition(`n ${operator} ${boundary}`, record), expected, operator);
    for (const [operator, expected] of [
      ['=', true],
      ['==', true],
      ['!=', false],
      ['>', false],
      ['<', false],
      ['>=', true],
      ['<=', true],
    ])
      assert.equal(evaluateStepCondition(`n ${operator} ${value}`, record), expected, `equal ${operator}`);
    assert.deepEqual(record, before);
  });

test('negative Int64 bounds and decimal scale compare exactly', () => {
  assert.equal(
    evaluateStepCondition('n < -9223372036854775807', { n: exactNumeric('-9223372036854775808', 'Int64') }),
    true,
  );
  assert.equal(evaluateStepCondition('n = 1.0000', { n: exactNumeric('1.0', 'Decimal', { collapse: false }) }), true);
  assert.equal(evaluateStepCondition('n > 9007199254740992', { n: '9007199254740993' }), true);
});

test('existing numeric-string, null, boolean and quoted-text coercion is preserved', () => {
  const cases = [
    ['n = 1', '01', true],
    ['n = 1', true, true],
    ['n = 0', false, true],
    ['n = 0', null, false],
    ['n = 0', '', false],
    ['n >= 0', null, true],
    ['n >= 0', '', true],
    ['n = 0', ' ', true],
    ['n = 16', '0x10', true],
    ['n > 0', undefined, false],
    ['n = 1', 'invalid', false],
    ['n != 1', 'invalid', true],
    ['n = "1"', '01', false],
    ['n = null', '', true],
    ['n = true', 'true', true],
    ['n = false', false, true],
  ];
  for (const [expression, n, expected] of cases)
    assert.equal(evaluateStepCondition(expression, { n }), expected, `${expression} for ${String(n)}`);
  assert.equal(evaluateStepCondition('n = "9007199254740993"', { n: exactNumeric('9007199254740993', 'Int64') }), true);
  assert.equal(evaluateStepCondition('n', { n: exactNumeric('1', 'Int64', { collapse: false }) }), true);
  assert.equal(evaluateStepCondition('!n', { n: exactNumeric('0', 'Int64', { collapse: false }) }), true);
});

test('documented unquoted multiword values respect logical/group boundaries and wildcards', () => {
  const record = { new_name: 'Jane Doe', new_categorycode: 750101, gendercode: 2, active: false };
  assert.equal(evaluateStepCondition('new_name = Jane Doe', record), true);
  assert.equal(
    evaluateStepCondition('new_name = Jane Doe & (new_categorycode = 750101 | gendercode = 3)', record),
    true,
  );
  assert.equal(evaluateStepCondition('(new_name != Jane Doe | !active) & gendercode = 2', record), true);
  for (const operator of ['=*', '==*', '~='])
    assert.equal(evaluateStepCondition(`new_name ${operator} Jane D*`, record), true);
  assert.equal(evaluateStepCondition('new_name !=* Jane D*', record), false);
  assert.equal(evaluateStepCondition('new_name = "Jane Doe"', record), true);
  assert.equal(evaluateStepCondition('new_name = Jane   Doe', { new_name: 'Jane   Doe' }), true);
});

test('multiword parsing retains malformed-expression guards', () => {
  for (const expression of [
    'n =',
    'n = & active',
    '(n = Jane Doe',
    'n = Jane Doe = Other',
    'n = "Jane" Doe',
    'n = Jane "Doe"',
    'n = (Jane Doe)',
    'n > > 2',
    'n = "Jane Doe',
    'n = \'Jane"',
  ])
    assert.throws(
      () => evaluateStepCondition(expression, { n: 'Jane Doe' }),
      (error) => error.code === 'ADVANCEDFORM_CONDITION_UNSUPPORTED',
      expression,
    );
});

for (const kind of ['Int64', 'Decimal'])
  for (const operation of ['create', 'update'])
    for (const above of [false, true])
      test(`${operation} ${kind} saved adjacent value routes ${above ? 'true' : 'false'} without changing digits`, async () => {
        const base = kind === 'Int64' ? '9007199254740992' : '99999999999.1234567891';
        const adjacent = kind === 'Int64' ? '9007199254740993' : '99999999999.1234567892';
        const value = exactNumeric(above ? adjacent : base, kind, { collapse: false });
        const dataverseType = kind === 'Int64' ? 'bigint' : 'decimal';
        const field = { name: 'n', dataverseType, ...(kind === 'Decimal' ? { precision: 10 } : {}) };
        const store = await new DataStore({
          state: {
            mappings: {
              precisionrow: {
                entitySet: 'precisionrows',
                idColumn: 'precisionrowid',
                fields: {
                  n: {
                    ...field,
                    ...(kind === 'Decimal' ? { minValue: '-100000000000', maxValue: '100000000000' } : {}),
                  },
                  label: { dataverseType: 'nvarchar' },
                },
              },
            },
            tables: {
              precisionrow:
                operation === 'update'
                  ? [{ precisionrowid: 'existing', n: exactNumeric(base, kind, { collapse: false }) }]
                  : [],
            },
            settings: { permissionMode: 'enforce' },
            permissions: [
              { entity: 'precisionrow', scope: 'global', roles: ['Editor'], operations: ['read', 'create', 'update'] },
            ],
          },
        }).init();
        const schemas = {
          wizard: {
            initialStepId: 'entry',
            steps: [
              {
                stepId: 'entry',
                entity: 'precisionrow',
                mode: operation === 'create' ? 100000000 : 100000001,
                fields: [field, { name: 'label', dataverseType: 'nvarchar' }],
                nextStepId: 'check',
              },
              {
                stepId: 'check',
                type: 'condition',
                condition: `n > ${base} & label = Jane Doe`,
                nextStepId: 'yes',
                conditionDefaultNextStepId: 'no',
              },
              { stepId: 'yes', type: 'redirect', redirectUrl: '/above/' },
              { stepId: 'no', type: 'redirect', redirectUrl: '/same/' },
            ],
          },
        };
        const sessions = createWebFormSessions();
        const portal = { forms: [], advancedForms: [{ id: 'wizard', metadata: {} }], records: [], pages: [] };
        const result = await submitPortalForm(
          'webform',
          'wizard',
          { values: { n: value, label: 'Jane Doe' }, ...(operation === 'update' ? { recordId: 'existing' } : {}) },
          {
            portal,
            store,
            schemas,
            sessions,
            identity: { contactId: 'editor', roles: ['Editor'] },
            owner: 'contact:editor',
            requestUrl: 'http://localhost/form/',
            nativePostback: true,
          },
        );
        assert.equal(result.outcome.type, 'redirect');
        assert.equal(result.outcome.url, above ? '/above/' : '/same/');
        const row = store.snapshot().tables.precisionrow[0];
        assert.equal(text(row.n), above ? adjacent : base);
        assert.equal(row.label, 'Jane Doe');
        assert.equal(store.snapshot().tables.precisionrow.length, 1);
        const session = sessions.list('wizard', 'contact:editor')[0];
        assert.equal(session.completed, true);
        assert.deepEqual(
          session.history.map((entry) => [entry.stepId, entry.recordId]),
          [['entry', result.recordId]],
        );
      });

test('condition uses exact provider-saved digits rather than the earlier submitted value', async () => {
  const below = exactNumeric('9007199254740992', 'Int64', { collapse: false });
  const above = exactNumeric('9007199254740993', 'Int64', { collapse: false });
  const store = await new DataStore({
    state: {
      mappings: {
        precisionrow: {
          entitySet: 'precisionrows',
          idColumn: 'precisionrowid',
          fields: { n: { dataverseType: 'bigint' } },
        },
      },
      tables: { precisionrow: [] },
      settings: { permissionMode: 'permissive' },
    },
  }).init();
  const schemas = {
    wizard: {
      initialStepId: 'entry',
      steps: [
        {
          stepId: 'entry',
          entity: 'precisionrow',
          mode: 100000000,
          fields: [{ name: 'n', dataverseType: 'bigint' }],
          nextStepId: 'check',
        },
        {
          stepId: 'check',
          type: 'condition',
          condition: 'n > 9007199254740992',
          nextStepId: 'yes',
          conditionDefaultNextStepId: 'no',
        },
        { stepId: 'yes', type: 'redirect', redirectUrl: '/saved-above/' },
        { stepId: 'no', type: 'redirect', redirectUrl: '/submitted-equal/' },
      ],
    },
  };
  const provider = {
    transaction: (callback) =>
      store.transact(() =>
        callback({
          create: (entity, values, identity) => store.createRecord(entity, { ...values, n: above }, identity),
        }),
      ),
  };
  const sessions = createWebFormSessions();
  const result = await submitPortalForm(
    'webform',
    'wizard',
    { values: { n: below } },
    {
      portal: { advancedForms: [{ id: 'wizard', metadata: {} }], records: [], pages: [] },
      store,
      schemas,
      writeProvider: provider,
      sessions,
      owner: 'visitor',
      requestUrl: 'http://localhost/form/',
      nativePostback: true,
    },
  );
  assert.equal(result.outcome.url, '/saved-above/');
  assert.equal(text(store.snapshot().tables.precisionrow[0].n), '9007199254740993');
  assert.equal(sessions.list('wizard', 'visitor')[0].completed, true);
  assert.equal(text(below), '9007199254740992');
});
