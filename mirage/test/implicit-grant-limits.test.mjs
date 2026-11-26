// @test-kind compatibility+contract: the documented token endpoint limits (client_id at most 36 letters, digits and hyphens; state and nonce at most 20 characters) are https://learn.microsoft.com/power-pages/security/oauth-implicit-grant-flow#token-endpoint-details; Learn documents no error id for an over-long state or nonce, so PortalSTS0002 and PortalSTS0005 are Mirage's own.
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
  assert.equal(errorOf(beyond).ErrorId, 'PortalSTS0002');
});

test('nonce is accepted at 20 characters and refused at 21', async () => {
  const atLimit = await call({ nonce: 'n'.repeat(20) });
  assert.equal(atLimit.status, 200);
  assert.equal(claims(atLimit).nonce, 'n'.repeat(20));
  const beyond = await call({ nonce: 'n'.repeat(21) });
  assert.equal(beyond.status, 400);
  const body = errorOf(beyond);
  assert.equal(body.ErrorId, 'PortalSTS0005');
  assert.match(body.ErrorMessage, /at most 20 characters/);
});

test('client_id is accepted at 36 letters, digits and hyphens and refused beyond or with other characters', async () => {
  const id36 = 'a1b2c3d4-0000-4000-8000-00000000abcd';
  const id37 = `${id36}e`;
  const settings = { 'ImplicitGrantFlow/RegisteredClientId': `${id36};${id37};bad_client` };
  const atLimit = await call({ client_id: id36 }, settings);
  assert.equal(atLimit.status, 200);
  assert.deepEqual([claims(atLimit).aud, claims(atLimit).appid], [id36, id36]);
  // Registration does not widen the documented format: 37 characters and an underscore stay refused.
  for (const clientId of [id37, 'bad_client']) {
    const refused = await call({ client_id: clientId }, settings);
    assert.equal(refused.status, 400, clientId);
    assert.equal(errorOf(refused).ErrorId, 'PortalSTS0001');
  }
});
