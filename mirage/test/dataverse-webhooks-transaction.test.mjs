// @test-kind unproven: local model of synchronous web hook steps inside the write transaction; no native capture cited
// Webhook RemoteExecutionContext transaction flags (dataverse-webhooks.mjs remoteExecutionContext): IsInTransaction comes from
// the pipeline's transaction state, Mode from the delivery. A PreValidation step outside an existing transaction does not
// participate, PreOperation and PostOperation steps participate, asynchronous steps never do. An asynchronous PostOperation
// step has Mode 1; RemoteExecutionContext.IsExecutingOffline is true only for the offline Outlook client.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { webhookDelivery } from '../lib/dataverse-webhooks.mjs';
import { widgetApi, wireRegisteredSteps } from './support/service-endpoint-pipeline.mjs';

const WIDGET = 'bbbbbbbb-0000-4000-8000-000000000073';
const ENDPOINT = 'cccccccc-0000-4000-8000-000000000073';
const STEPS = [
  [10, 0, 'dddddddd-0000-4000-8000-000000000710'],
  [20, 0, 'dddddddd-0000-4000-8000-000000000720'],
  [40, 0, 'dddddddd-0000-4000-8000-000000000740'],
  [40, 1, 'dddddddd-0000-4000-8000-000000000741'],
];

test('IsInTransaction and Mode follow the pipeline stage, its transaction and the delivery mode', async (t) => {
  const received = [];
  const receiver = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      res.writeHead(200);
      res.end();
    });
  });
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  // after hooks run in registration order, so this one runs while the API may still hold keep-alive sockets to it.
  t.after(
    () =>
      new Promise((resolve) => {
        receiver.close(resolve);
        receiver.closeAllConnections();
      }),
  );

  const { store, api, messageId, filterId } = await widgetApi('x');
  await store.create(
    'serviceendpoint',
    {
      serviceendpointid: ENDPOINT,
      name: 'Invented hook',
      url: `http://127.0.0.1:${receiver.address().port}/hook`,
      authtype: 5,
      contract: 8,
      authvalue: '',
    },
    { admin: true },
  );
  for (const [stage, mode, id] of STEPS) {
    await store.create(
      'sdkmessageprocessingstep',
      {
        sdkmessageprocessingstepid: id,
        name: `Invented step ${stage}/${mode}`,
        sdkmessageid: messageId,
        sdkmessagefilterid: filterId,
        eventhandler: { id: ENDPOINT, logical_name: 'serviceendpoint' },
        stage,
        mode,
        rank: 1,
        statecode: 0,
        supporteddeployment: 0,
      },
      { admin: true },
    );
  }
  const webhooks = webhookDelivery(store);
  const runner = wireRegisteredSteps(store, webhooks);
  t.after(async () => {
    await runner.close();
    await api.close();
  });

  await store.create('x_widget', { x_widgetid: WIDGET, x_name: 'Invented' }, { admin: true });
  await runner.drain();
  const flags = Object.fromEntries(
    received.map((body) => [`${body.Stage}/${body.Mode}`, [body.IsInTransaction, body.IsExecutingOffline]]),
  );
  assert.deepEqual(flags, {
    '10/0': [false, false], // PreValidation, no transaction yet
    '20/0': [true, false], // synchronous PreOperation, inside the transaction
    '40/0': [true, false], // synchronous PostOperation, inside the transaction
    '40/1': [false, false], // asynchronous, after commit
  });
});
