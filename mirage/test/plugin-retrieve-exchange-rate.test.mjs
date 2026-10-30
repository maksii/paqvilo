// @test-kind parity: native dev-environment plug-in recorder corpus 2026-10-30, crud scenario: a Create carrying a money value runs RetrieveExchangeRate/transactioncurrency PreOperation, PostOperation and asynchronous steps (not its registered PreValidation step) under Create/25 (MultiCurrencyPlugin) < Create/30, as SYSTEM for the caller, input TransactionCurrencyId, output ExchangeRate already at PreOperation; Creates without a money value run none
// @parity-evidence: native recorder captures 2026-10-30 currency (native and native-r2): a money PATCH runs RetrieveExchangeRate under Update/25; the fixture gains an Update step so the Update frame exists
import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';
import { pluginCatalogue } from '../lib/exported-plugins.mjs';

const priced = '20000000-0000-0000-0000-0000000000b1';
const plain = '20000000-0000-0000-0000-0000000000b2';
const step = (n, message, stage, mode = 0) => ({
  id: `30000000-0000-0000-0000-0000000000${String(n).padStart(2, '0')}`,
  name: `Invented ${message} ${stage}/${mode}`,
  enabled: true,
  ...(message === 'RetrieveExchangeRate' ? { unfiltered: true } : { entity: 'x_order' }),
  message,
  stage,
  rank: 1,
  mode,
  supportedDeployment: 0,
  filteringAttributes: [],
  images: [],
  typeName: 'Invented.Recorder',
  assemblyId: 'invented',
});

async function fixture(t) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_order: {
        logicalName: 'x_order',
        entitySet: 'x_orders',
        idColumn: 'x_orderid',
        fields: { x_name: { dataverseType: 'nvarchar' }, x_total: { dataverseType: 'money', precision: 2 } },
      },
    },
    tables: { x_order: [] },
    extension: { name: 'retrieve-exchange-rate-probe', install: () => {} },
  });
  const seen = [];
  const steps = [
    step(1, 'Create', 20),
    step(2, 'Create', 40),
    step(7, 'Update', 20),
    step(3, 'RetrieveExchangeRate', 10),
    step(4, 'RetrieveExchangeRate', 20),
    step(5, 'RetrieveExchangeRate', 40),
    step(6, 'RetrieveExchangeRate', 40, 1),
  ];
  const handlers = new Map([
    [
      'Invented.Recorder',
      ({ context }) => {
        const parent = context.ParentContext;
        seen.push({
          at: `${context.MessageName}/${context.Stage}/${context.Mode}`,
          entity: context.PrimaryEntityName,
          depth: context.Depth,
          inTransaction: context.IsInTransaction,
          user: context.UserId,
          initiating: context.InitiatingUserId,
          inputs: structuredClone(context.InputParameters),
          outputs: structuredClone(context.OutputParameters),
          chain: [parent, parent?.ParentContext].map((level) =>
            level ? `${level.MessageName}/${level.Stage}/${level.UserId}` : null,
          ),
        });
      },
    ],
  ]);
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  const backend = await createOrganizationBackend({ store: f.store, items: () => items, handlers });
  t.after(() => backend.close());
  return { ...f, seen, backend };
}

test('a Create with a money value runs RetrieveExchangeRate at internal stage 25 as SYSTEM', async (t) => {
  const f = await fixture(t);
  const created = await f.request('POST', '/x_orders', { x_orderid: priced, x_name: 'Priced', x_total: 3.5 });
  assert(created.status < 300, await created.text());
  await f.backend.settle();
  const system = f.store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM').systemuserid;
  const currency = f.store.tableRows('x_order')[0].transactioncurrencyid;
  const currencyId = String(currency?.id ?? currency);
  const order = f.seen.map((entry) => entry.at);
  // No PreValidation; PreOperation and PostOperation between the Create's PreOperation and PostOperation steps.
  assert.deepEqual(order.slice(0, 4), [
    'Create/20/0',
    'RetrieveExchangeRate/20/0',
    'RetrieveExchangeRate/40/0',
    'Create/40/0',
  ]);
  assert.equal(order.filter((at) => at.startsWith('RetrieveExchangeRate')).length, 3);
  assert(order.includes('RetrieveExchangeRate/40/1'), 'the asynchronous step runs after commit');
  const caller = f.seen.find((entry) => entry.at === 'Create/20/0').user;
  for (const entry of f.seen.filter((item) => item.at.startsWith('RetrieveExchangeRate'))) {
    assert.equal(entry.entity, 'transactioncurrency');
    assert.equal(entry.depth, 1);
    assert.equal(entry.user, system);
    assert.equal(entry.initiating, caller);
    assert.deepEqual(Object.keys(entry.inputs), ['TransactionCurrencyId']);
    assert.equal(String(entry.inputs.TransactionCurrencyId).toLowerCase(), currencyId.toLowerCase());
    assert.equal(Number(entry.outputs.ExchangeRate), 1);
  }
  const pre = f.seen.find((entry) => entry.at === 'RetrieveExchangeRate/20/0');
  assert.equal(pre.inTransaction, true);
  assert.deepEqual(pre.chain, [`Create/25/${system}`, `Create/30/${system}`]);
  assert.equal(f.store.tableRows('x_order')[0].x_total_base, 3.5);
});

test('a Create without a money value runs no RetrieveExchangeRate', async (t) => {
  const f = await fixture(t);
  const created = await f.request('POST', '/x_orders', { x_orderid: plain, x_name: 'Plain' });
  assert(created.status < 300, await created.text());
  await f.backend.settle();
  assert.deepEqual(
    f.seen.filter((entry) => entry.at.startsWith('RetrieveExchangeRate')),
    [],
  );
});

// @test-kind parity: native recorder captures 2026-10-30 currency (native and native-r2): a PATCH writing a money value runs RetrieveExchangeRate under Update/25 < Update/30; a PATCH without one runs none
test('an Update that writes a money value runs RetrieveExchangeRate under Update/25', async (t) => {
  const f = await fixture(t);
  assert((await f.request('POST', '/x_orders', { x_orderid: priced, x_name: 'Priced' })).status < 300);
  await f.backend.settle();
  f.seen.length = 0;
  const renamed = await f.request('PATCH', `/x_orders(${priced})`, { x_name: 'Renamed' });
  assert(renamed.status < 300, await renamed.text());
  assert.deepEqual(
    f.seen.filter((entry) => entry.at.startsWith('RetrieveExchangeRate')),
    [],
  );
  const repriced = await f.request('PATCH', `/x_orders(${priced})`, { x_total: 4.5 });
  assert(repriced.status < 300, await repriced.text());
  await f.backend.settle();
  const system = f.store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM').systemuserid;
  const pre = f.seen.find((entry) => entry.at === 'RetrieveExchangeRate/20/0');
  assert.deepEqual(pre.chain, [`Update/25/${system}`, `Update/30/${system}`]);
  assert.equal(f.seen.filter((entry) => entry.at.startsWith('RetrieveExchangeRate')).length, 3);
  assert.equal(f.store.tableRows('x_order')[0].x_total_base, 4.5);
});
