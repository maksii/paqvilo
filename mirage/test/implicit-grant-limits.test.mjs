// @test-kind compatibility+observation: the documented token endpoint limits (client_id at most 36 letters, digits and hyphens; state and nonce at most 20 characters) are https://learn.microsoft.com/power-pages/security/oauth-implicit-grant-flow#token-endpoint-details; the error ids, texts and their order are hosted session F4 (paqvilo-developer hosted-f4 implicit runs a and b).
import test from 'node:test';
import assert from 'node:assert/strict';
import { handleImplicitGrant } from '../lib/auth-token.mjs';

const CONTACT = 'c3000000-0000-4000-8000-000000000010';
const portal = (settings = {}) => ({ settings });

// A request and response pair for the handler: the query carries the parameters.
async function call(query, settings = {}) {
  const url = new URL(`http://127.0.0.1/_services/auth/token?${new URLSearchParams(query)}`);
  const req = { method: 'POST', headers: {}, async *[Symbol.asyncIterator]() {} };
  const res = {
    writeHead(status, headers) {
      Object.assign(this, { status, headers });
    },
    end(body) {
      this.body = body ?? '';
    },
  };
  const handled = await handleImplicitGrant(req, res, url, {
    portal: portal(settings),
    identity: { contactId: CONTACT },
    contact: { contactid: CONTACT, firstname: 'Invented' },
    origin: 'http://127.0.0.1:9',
  });
  assert.equal(handled, true);
  return res;
}
const pick = ({ ErrorId, ErrorMessage }) => ({ ErrorId, ErrorMessage });
const claims = (res) => JSON.parse(Buffer.from(res.body.split('.')[1], 'base64url').toString('utf8'));
const errorOf = (res) => {
  assert.match(res.headers['content-type'], /^application\/json/);
  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body), ['ErrorId', 'ErrorMessage', 'Timestamp', 'CorrelationId']);
  return body;
};

test('state is accepted at 20 characters and refused at 21', async () => {
  const atLimit = await call({ state: 's'.repeat(20) });
  assert.equal(atLimit.status, 200);
  assert.equal(atLimit.headers.state, 's'.repeat(20));
  const beyond = await call({ state: 's'.repeat(21) });
  assert.equal(beyond.status, 400);
  assert.equal(beyond.headers.state, undefined, 'a refused state is not echoed');
  assert.equal(beyond.headers.expires_in, undefined, 'no token is issued');
  assert.deepEqual(pick(errorOf(beyond)), {
    ErrorId: 'PortalSTS0005',
    ErrorMessage: 'Length of the state parameter exceeds the maximum allowed length of 20 characters',
  });
});

test('nonce is accepted at 20 characters and refused at 21', async () => {
  const atLimit = await call({ nonce: 'n'.repeat(20) });
  assert.equal(atLimit.status, 200);
  assert.equal(claims(atLimit).nonce, 'n'.repeat(20));
  const beyond = await call({ nonce: 'n'.repeat(21) });
  assert.equal(beyond.status, 400);
  assert.deepEqual(pick(errorOf(beyond)), {
    ErrorId: 'PortalSTS0006',
    ErrorMessage: 'Length of the nonce parameter exceeds the maximum allowed length of 20 characters.',
  });
});

test('client_id is accepted at 36 letters, digits and hyphens and refused beyond or with other characters', async () => {
  const id36 = 'a1b2c3d4-0000-4000-8000-00000000abcd';
  const id37 = `${id36}e`;
  const settings = { 'ImplicitGrantFlow/RegisteredClientId': `${id36};${id37};bad_client` };
  const atLimit = await call({ client_id: id36 }, settings);
  assert.equal(atLimit.status, 200);
  assert.deepEqual([claims(atLimit).aud, claims(atLimit).appid], [id36, id36]);
  // Registration does not widen the documented format: 37 characters and an underscore stay refused.
  for (const [clientId, ErrorId] of [
    [id37, 'PortalSTS0010'],
    ['bad_client', 'PortalSTS0001'],
    ['unregistered-client', 'PortalSTS0001'],
  ]) {
    const refused = await call({ client_id: clientId }, settings);
    assert.equal(refused.status, 400, clientId);
    assert.equal(errorOf(refused).ErrorId, ErrorId, clientId);
  }
});

test('the token endpoint checks state, nonce, client_id and response_type in that order', async () => {
  const settings = { 'ImplicitGrantFlow/RegisteredClientId': 'invented-client' };
  const long = 'x'.repeat(21);
  const idOf = async (query) => errorOf(await call(query, settings)).ErrorId;
  assert.equal(
    await idOf({ state: long, nonce: long, client_id: 'c'.repeat(37), response_type: 'code' }),
    'PortalSTS0005',
  );
  assert.equal(await idOf({ nonce: long, client_id: 'c'.repeat(37), response_type: 'code' }), 'PortalSTS0006');
  assert.equal(await idOf({ client_id: 'c'.repeat(37), response_type: 'code' }), 'PortalSTS0010');
  assert.equal(await idOf({ client_id: 'unregistered', response_type: 'code' }), 'PortalSTS0001');
  assert.equal(await idOf({ response_type: 'code' }), 'PortalSTS0007');
  // A state hosted Power Pages passed through to its certificate check, but which cannot be echoed as a header.
  const control = await call({ state: 'ab' }, settings);
  assert.equal(control.status, 400);
  assert.equal(control.headers.state, undefined);
  assert.deepEqual(pick(errorOf(control)), {
    ErrorId: 'PortalSTS0018',
    ErrorMessage: 'The Implicit Grant certificate was not found. Please upload it from the Admin Centre. ',
  });
  const spaced = await call({ state: 'a b' }, settings);
  assert.equal(spaced.status, 200);
  assert.equal(spaced.headers.state, 'a b');
});
