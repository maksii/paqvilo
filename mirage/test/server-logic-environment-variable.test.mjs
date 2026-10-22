// Server.EnvironmentVariable.get in the exported server-logic worker: non-secret effective values, case-insensitive
// names, and null plus SECRET_NOT_EXPOSED_TO_SERVER_LOGIC for Secret types. The payload comes from
// environmentVariablePayload (secret-resolver.mjs). Invented schema and values only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { environmentVariablePayload } from '../lib/secret-resolver.mjs';

const state = {
  tables: {
    environmentvariabledefinition: [
      { environmentvariabledefinitionid: 'def-url', schemaname: 'fx_ApiUrl', type: 100000000, defaultvalue: 'https://default.example.test' },
      { environmentvariabledefinitionid: 'def-key', schemaname: 'fx_Key', type: 100000005, secretstore: 0 },
    ],
    environmentvariablevalue: [
      { environmentvariablevalueid: 'v1', environmentvariabledefinitionid: 'def-url', value: 'http://127.0.0.1:7071' },
      { environmentvariablevalueid: 'v2', environmentvariabledefinitionid: 'def-key', value: 'https://fx-vault.vault.azure.net/secrets/func-key' },
    ],
  },
};

function run(code, environmentVariables) {
  const worker = new Worker(new URL('../lib/exported-operation-worker.mjs', import.meta.url), {
    workerData: { code, operation: 'get', context: {}, user: null, website: {}, settings: {}, environmentVariables, timeout: 2000 },
  });
  const messages = [];
  return new Promise((resolve, reject) => {
    worker.on('message', (message) => {
      messages.push(message);
      if (message.kind === 'result' || message.kind === 'failure') { worker.terminate(); resolve(messages); }
    });
    worker.on('error', reject);
  });
}

test('Server.EnvironmentVariable.get returns the effective value of a String variable, by any case', async () => {
  const messages = await run("function get() { return [Server.EnvironmentVariable.get('fx_ApiUrl'), Server.EnvironmentVariable.get('FX_APIURL'), Server.EnvironmentVariable.get('fx_None')]; }", environmentVariablePayload(state));
  assert.deepEqual(JSON.parse(messages.at(-1).raw), ['http://127.0.0.1:7071', 'http://127.0.0.1:7071', null]);
});

test('a Secret variable answers null with a SECRET_NOT_EXPOSED_TO_SERVER_LOGIC diagnostic', async () => {
  const messages = await run("function get() { return Server.EnvironmentVariable.get('fx_Key'); }", environmentVariablePayload(state));
  assert.equal(messages.at(-1).raw, 'null');
  assert.deepEqual(messages.filter((m) => m.kind === 'diagnostic').map((m) => m.code), ['SECRET_NOT_EXPOSED_TO_SERVER_LOGIC']);
  assert.equal(JSON.stringify(messages).includes('vault.azure.net'), false);
});

test('without a payload every variable is null', async () => {
  const messages = await run("function get() { return Server.EnvironmentVariable.get('fx_ApiUrl'); }", undefined);
  assert.equal(messages.at(-1).raw, 'null');
});

test('inherited object properties are not environment variables', async () => {
  const messages = await run("function get() { return [Server.EnvironmentVariable.get('constructor'), Server.EnvironmentVariable.get('__proto__')]; }", environmentVariablePayload(state));
  assert.equal(messages.at(-1).raw, '[null,null]');
  assert.deepEqual(messages.filter((m) => m.kind === 'diagnostic'), []);
});

test('inherited object properties are not site settings', async () => {
  const messages = await run("function get() { return [Server.SiteSetting.Get('constructor'), Server.SiteSetting.Get('__proto__'), Server.SiteSetting.Get('toString')]; }", undefined);
  assert.equal(messages.at(-1).raw, '[null,null,null]');
});
