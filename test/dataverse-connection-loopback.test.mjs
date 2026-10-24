import test from 'node:test';
import assert from 'node:assert/strict';
import { tokenProvider } from '../lense/dataverse/connection.mjs';
import { connectedClient, isLoopbackOrigin } from '../lense/dataverse/client.mjs';

const TENANT = '11111111-1111-1111-1111-111111111111';
const CLIENT = '44444444-4444-4444-4444-444444444444';
const LOOPBACK_ENV = 'http://127.0.0.1:9';
const PRODUCTION_ENV = 'https://orgsim.example.test';
process.env.PAQVILO_TEST_LOOPBACK_SECRET = 'invented-test-secret';

const connection = (environmentUrl, extra = {}) => ({
  schemaVersion: 1,
  environmentUrl,
  tenantId: TENANT,
  clientId: CLIENT,
  credentialSource: 'environment',
  secretEnvironmentVariable: 'PAQVILO_TEST_LOOPBACK_SECRET',
  ...extra,
});

function recordingFetch(calls) {
  return async (url, init) => {
    calls.push({ url, scope: String(init.body.get('scope')) });
    return { ok: true, json: async () => ({ access_token: 'x', expires_in: 3600 }) };
  };
}

test('a loopback authorityHost is used only when loopback is allowed', async () => {
  const calls = [];
  const token = tokenProvider(connection(LOOPBACK_ENV, { authorityHost: 'http://127.0.0.1:4010' }), {
    fetchImpl: recordingFetch(calls),
    allowLoopback: true,
  });
  assert.equal(await token(), 'x');
  assert.equal(calls[0].url, `http://127.0.0.1:4010/${TENANT}/oauth2/v2.0/token`);
  assert.equal(calls[0].scope, `${LOOPBACK_ENV}/.default`, 'the scope resource stays the environment origin');
});

test('a loopback authorityHost is ignored, and a loopback environment rejected, without allowLoopback', async () => {
  const calls = [];
  const token = tokenProvider(connection(PRODUCTION_ENV, { authorityHost: 'http://127.0.0.1:4010' }), {
    fetchImpl: recordingFetch(calls),
  });
  await token();
  assert.equal(calls[0].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  assert.throws(
    () => tokenProvider(connection(LOOPBACK_ENV), { fetchImpl: recordingFetch([]) }),
    /Environment must be an HTTPS organisation origin/,
  );
});

test('a non-loopback authorityHost is rejected even when loopback is allowed', () => {
  for (const authorityHost of [
    'https://evil.example',
    'http://localhost.evil.example',
    'https://127.0.0.1:4010/path',
    'not a url',
  ]) {
    assert.throws(
      () =>
        tokenProvider(connection(LOOPBACK_ENV, { authorityHost }), {
          fetchImpl: recordingFetch([]),
          allowLoopback: true,
        }),
      /authorityHost must be a loopback origin/,
      authorityHost,
    );
  }
});

test('the default authority is the Microsoft login host', async () => {
  const calls = [];
  const token = tokenProvider(connection(PRODUCTION_ENV), { fetchImpl: recordingFetch(calls) });
  assert.equal(await token(), 'x');
  assert.equal(calls[0].url, `https://login.microsoftonline.com/${TENANT}/oauth2/v2.0/token`);
  assert.equal(calls[0].scope, `${PRODUCTION_ENV}/.default`);
});

test('connectedClient passes allowLoopback to the client and the token provider', () => {
  assert.equal(connectedClient(connection(LOOPBACK_ENV), { allowLoopback: true }).origin, LOOPBACK_ENV);
  assert.throws(() => connectedClient(connection(LOOPBACK_ENV)), /Environment must be an HTTPS organisation origin/);
  assert.equal(isLoopbackOrigin('http://[::1]:8080'), true);
  assert.equal(isLoopbackOrigin('https://orgsim.example.test'), false);
});
