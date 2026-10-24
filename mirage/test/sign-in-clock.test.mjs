import {
  LOCAL_PROVIDER,
  initialState,
  simulator,
  client,
  startSignIn,
  choose,
  postBack,
  hiddenFields,
  claimsOf,
} from './support/external-sign-in.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixedClock } from '../lib/runtime-clock.mjs';

async function signInChain(t, clock, settings = LOCAL_PROVIDER, beforePostBack = () => {}) {
  const { app, idp } = await simulator(t, settings, initialState(), { clock });
  const browser = client(app);
  const challenge = await startSignIn(browser, { returnUrl: '/' });
  const answer = await choose(browser, challenge.headers.get('location'), { contactId: 'alex' });
  beforePostBack();
  return { claims: claimsOf(hiddenFields(answer).id_token), response: await postBack(browser, answer, idp.origin) };
}

test('the local IdP code flow signs in under a fixed host clock far from wall time', async (t) => {
  for (const start of ['2026-01-01T00:00:00.000Z', '2027-06-01T00:00:00.000Z']) {
    const clock = fixedClock(Date.parse(start));
    const { claims, response } = await signInChain(t, clock);
    assert.equal(claims.iat * 1000, Date.parse(start), 'the identity provider issues on the host clock');
    assert.equal(response.status, 302, await response.clone().text());
    assert.match(response.headers.get('location'), /^\/Account\/Login\/ExternalLoginCallback/);
  }
});

test('advancing the fixed clock past the nonce lifetime rejects the callback', async (t) => {
  const clock = fixedClock(Date.parse('2026-01-01T00:00:00.000Z'));
  const settings = [...LOCAL_PROVIDER, ['Authentication/OpenIdConnect/Local/NonceLifetime', '00:05:00']];
  const { response } = await signInChain(t, clock, settings, () => clock.advance(5 * 60 * 1000 + 1));
  assert.notEqual(response.status, 302);
  assert.match(await response.text(), /nonce has expired/);
});
