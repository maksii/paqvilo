// @test-kind compatibility: Microsoft.Crm.Sdk.Messages requests share their name and parameters with the Web API action or function (LocalTimeFromUtcTimeRequest TimeZoneCode/UtcTime -> LocalTime DateTime, RetrieveExchangeRateRequest TransactionCurrencyId -> ExchangeRate decimal); a plug-in's SDK Execute runs the message pipeline one level below the caller
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSdkCall } from '../lib/plugin-clr.mjs';
import { contractModuleFixture } from './contract-module-fixture.mjs';

const currency = '10000000-0000-4000-8000-0000000000f1';

async function organization(t) {
  return contractModuleFixture(t, {
    tables: {
      transactioncurrency: [
        { transactioncurrencyid: currency, isocurrencycode: 'XIN', currencyname: 'Invented', exchangerate: 2.5 },
      ],
    },
    extension: {
      name: 'invented-operations',
      install(api) {
        api.registry.register({
          name: 'invented_Echo',
          kind: 'action',
          binding: 'unbound',
          signature: { params: [['Text', 'Edm.String']], response: [['Reply', 'Edm.String']] },
          handle: (c) => ({
            status: 200,
            body: { '@odata.context': 'x', Reply: `${c.body.Text} from ${c.user.systemuserid}` },
          }),
        });
        api.registry.register({
          name: 'invented_Later',
          kind: 'action',
          binding: 'unbound',
          handle: async () => ({ status: 204 }),
        });
      },
    },
  });
}
const execute = (f, requestName, values) => {
  const userId = f.store.tableRows('systemuser').find((row) => row.applicationid).systemuserid;
  return dispatchSdkCall({
    store: f.store,
    profile: { userId, evidence: 'Invented SDK operation caller', grants: [] },
    message: {
      method: 'Execute',
      userId,
      arguments: [{ $type: 'OrganizationRequest', requestName, parameters: { $type: 'ParameterCollection', values } }],
    },
  });
};

test('SDK Execute of a registered action runs its message pipeline around the handler with the run-as user', async (t) => {
  const f = await organization(t);
  const seen = [];
  f.store.setPluginPipeline(
    (context) => {
      seen.push(`${context.customApi?.name}/${context.stage}`);
      if (context.stage === 40) context.messageParameters.outputParameters.values.Reply += ' (post)';
    },
    (context) => context.operation === 'invented_echo',
  );
  const userId = f.store.tableRows('systemuser').find((row) => row.applicationid).systemuserid;
  const response = execute(f, 'invented_Echo', { Text: 'hello' });
  assert.deepEqual(seen, ['invented_Echo/10', 'invented_Echo/20', 'invented_Echo/40']);
  assert.equal(response.responseName, 'invented_Echo');
  assert.equal(response.results.Reply, `hello from ${userId} (post)`, 'the response carries the PostOperation outputs');
  assert.throws(
    () => execute(f, 'invented_Later', {}),
    (error) => error.status === 501 && /asynchronous/.test(error.message),
  );
});

test('SDK LocalTimeFromUtcTime and RetrieveExchangeRate answer typed Results from their Web API operations', async (t) => {
  const f = await organization(t);
  const local = execute(f, 'LocalTimeFromUtcTime', {
    TimeZoneCode: 85,
    UtcTime: { $type: 'DateTime', value: '2026-01-15T12:00:00.0000000Z' },
  });
  assert.equal(local.results.LocalTime.$type, 'DateTime');
  const rate = execute(f, 'RetrieveExchangeRate', { TransactionCurrencyId: { $type: 'Guid', value: currency } });
  assert.deepEqual(rate.results.ExchangeRate, { $type: 'Decimal', value: '2.5' });
});
