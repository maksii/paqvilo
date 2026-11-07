// @test-kind parity: executes the official Microsoft.Xrm.Sdk DataContractJsonSerializer as oracle for key metadata and numeric bytes
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { serviceEndpointDelivery, remoteExecutionContext } from '../lib/dataverse-webhooks.mjs';
import { createLocalMessageBus, createServiceBusEmulatorBus } from '../lib/message-bus.mjs';
import { decodeMessage } from '../lib/amqp-client.mjs';
import { parseExactJson, stringifyExactJson } from '../lib/exact-numeric.mjs';
import { startFakeBroker } from '../testing/amqp-fake-broker.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const id = '20000000-0000-0000-0000-000000000001';
const name = 'invented_MixedCase';
const values = {
  Row: {
    $type: 'Entity',
    logicalName: 'widget',
    id,
    attributes: {},
    keyAttributes: { code: 'Invented' },
    rowVersion: '19',
  },
  Reference: {
    $type: 'EntityReference',
    logicalName: 'widget',
    id: '00000000-0000-0000-0000-000000000000',
    keyAttributes: { code: 'Invented' },
    name: 'By key',
    rowVersion: '17',
  },
  Price: { $type: 'Money', value: '9007199254740993.25' },
  Amount: { $type: 'Decimal', value: '0.1234567890123456789012345678' },
  Counter: { $type: 'Int64', value: '9007199254740993' },
  ConcurrencyDefault: { $type: 'ConcurrencyBehavior', value: 0 },
  ConcurrencyMatch: { $type: 'ConcurrencyBehavior', value: 1 },
  ConcurrencyOverwrite: { $type: 'ConcurrencyBehavior', value: 2 },
};
const parameterValues = (context) => Object.fromEntries(context.InputParameters.map(({ key, value }) => [key, value]));

test(
  'webhook and Service Bus preserve public SDK key metadata and exact numeric payload bytes',
  { skip: CLR_SKIP },
  async (t) => {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paq-webhook-exact-'));
    t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
    const sdk = clrSdk(),
      source = path.join(root, 'Serializer.cs'),
      executable = path.join(root, 'Serializer.exe');
    await fs.copyFile(sdk, path.join(root, 'Microsoft.Xrm.Sdk.dll'));
    await fs.writeFile(
      source,
      `using System;using System.IO;using System.Text;using System.Runtime.Serialization.Json;using Microsoft.Xrm.Sdk;
class Serializer {static void Main(){var c=new RemoteExecutionContext();c.OperationCreatedOn=DateTime.UtcNow;var row=new Entity("widget",new Guid("${id}")){RowVersion="19"};row.KeyAttributes["code"]="Invented";c.InputParameters["Row"]=row;
var reference=new EntityReference("widget","code","Invented"){Name="By key",RowVersion="17"};c.InputParameters["Reference"]=reference;
c.InputParameters["ConcurrencyDefault"]=ConcurrencyBehavior.Default;c.InputParameters["ConcurrencyMatch"]=ConcurrencyBehavior.IfRowVersionMatches;c.InputParameters["ConcurrencyOverwrite"]=ConcurrencyBehavior.AlwaysOverwrite;
c.InputParameters["Price"]=new Money(9007199254740993.25m);c.InputParameters["Amount"]=0.1234567890123456789012345678m;c.InputParameters["Counter"]=9007199254740993L;
c.PreEntityImages["Null"]=new Entity("widget",new Guid("${id}"));
var serializer=new DataContractJsonSerializer(typeof(RemoteExecutionContext));using(var stream=new MemoryStream()){serializer.WriteObject(stream,c);Console.Write(Encoding.UTF8.GetString(stream.ToArray()));}}}`,
    );
    compileClr(source, executable, { target: 'exe', references: [sdk, 'System.Runtime.Serialization.dll'] });
    const oracle = spawnSync(executable, [], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(oracle.status, 0, oracle.stderr);
    const oracleContext = parseExactJson(oracle.stdout);
    const expected = parameterValues(oracleContext);
    const assertBody = (body) => {
      assert.deepEqual(parameterValues(parseExactJson(body)), expected);
      for (const lexeme of ['9007199254740993.25', '0.1234567890123456789012345678', '9007199254740993']) {
        assert.ok(oracle.stdout.includes(lexeme), 'The public SDK oracle must carry the exact numeric lexeme');
        assert.ok(body.includes(lexeme), `The delivered bytes must retain ${lexeme}`);
      }
      assert.ok(!body.includes('DataverseNumeric'), 'Internal numeric markers must never escape on the wire');
    };
    const state = emptyState();
    state.mappings.widget = { entitySet: 'widgets', idColumn: 'widgetid' };
    state.tables.widget = [];
    const store = new DataStore({ state });
    const received = [];
    const receiver = createServer((request, response) => {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        received.push({ body: Buffer.concat(chunks).toString('utf8'), headers: request.headers });
        response.writeHead(200).end();
      });
    });
    await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve));
    t.after(
      () =>
        new Promise((resolve) => {
          receiver.close(resolve);
          receiver.closeAllConnections();
        }),
    );
    store.state.tables.serviceendpoint = [
      { serviceendpointid: id, contract: 8, url: `http://127.0.0.1:${receiver.address().port}/hook` },
    ];
    const facts = {
      item: { id, serviceEndpointId: id, images: [] },
      entity: 'none',
      operation: name.toLowerCase(),
      customApi: { name },
      stage: 20,
      record: {},
      identity: { id },
      depth: 1,
      correlationId: id,
      messageParameters: {
        inputParameters: { $type: 'ParameterCollection', values },
        outputParameters: { $type: 'ParameterCollection', values: {} },
      },
    };
    await serviceEndpointDelivery(store).send(facts);
    for (const value of [3, -1, '0'])
      assert.throws(
        () =>
          remoteExecutionContext(store, {
            ...facts,
            messageParameters: {
              ...facts.messageParameters,
              inputParameters: {
                $type: 'ParameterCollection',
                values: { Invalid: { $type: 'ConcurrencyBehavior', value } },
              },
            },
          }),
        { code: 'LocalWebhookContextUnsupported' },
      );
    assertBody(received[0].body);
    assert.equal(received[0].headers['x-ms-dynamics-request-name'], name);

    await serviceEndpointDelivery(store).send({
      ...facts,
      item: { ...facts.item, images: [{ alias: 'Null', type: 0, attributes: ['title'] }] },
      customApi: undefined,
      messageParameters: undefined,
      entity: 'widget',
      operation: 'update',
      record: { widgetid: id, title: null },
      previous: { widgetid: id, title: null },
      target: { title: null },
    });
    const imagePayload = parseExactJson(received[1].body);
    assert.deepEqual(imagePayload.PreEntityImages, oracleContext.PreEntityImages);
    assert.equal(
      parameterValues(imagePayload).Target.Attributes.find((entry) => entry.key === 'title').value,
      null,
      'image omission must not remove an authored Target null',
    );

    const broker = await startFakeBroker({ key: 'invented-exact-key', queues: ['exact-queue'] });
    const bus = createServiceBusEmulatorBus({
      id: 'emulator',
      settings: { connectionString: 'env:FX_EXACT_BUS', amqpPort: broker.port },
      env: {
        FX_EXACT_BUS:
          'Endpoint=sb://127.0.0.1;SharedAccessKeyName=RootManageSharedAccessKey;SharedAccessKey=invented-exact-key;UseDevelopmentEmulator=true;',
      },
    });
    t.after(async () => {
      await bus.close();
      await broker.close();
    });
    store.tableRows('serviceendpoint')[0].contract = 2;
    await serviceEndpointDelivery(store, {
      messaging: { bus, settings: { endpoints: { [id]: 'emulator/exact-queue' } } },
    }).send(facts);
    assert.equal(broker.payloads.length, 1);
    assertBody(decodeMessage(broker.payloads[0]).body.toString('utf8'));
    const [message] = await bus.receive('exact-queue', { mode: 'receiveAndDelete' });
    assert.deepEqual(parameterValues(message.body), expected, 'The receive boundary must parse exact JSON values');
    assert.equal(message.properties.requestName, name);

    const local = createLocalMessageBus({ store });
    await serviceEndpointDelivery(store, {
      messaging: { bus: local, settings: { endpoints: { [id]: 'local/exact-queue' } } },
    }).send(facts);
    const [localMessage] = await local.receive('exact-queue', { mode: 'receiveAndDelete' });
    assertBody(stringifyExactJson(localMessage.body));
  },
);
