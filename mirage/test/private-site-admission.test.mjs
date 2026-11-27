// @test-kind security+contract: the local private-site admission gate protects portal surfaces independently of portal web roles and contact sign-in.
import assert from 'node:assert/strict';
import test from 'node:test';
import { choose, client, initialState, postBack, simulator, startSignIn } from './support/external-sign-in.mjs';

const ENTRA_AUTHORITY = 'https://login.windows.net/0f0f0f0f-1111-4222-8333-444444444444/';
const ENTRA = [
  ['Authentication/Registration/AzureADLoginEnabled', 'true'],
  ['Authentication/OpenIdConnect/AzureAD/Authority', ENTRA_AUTHORITY],
];
const observed = { siteVisibility: 'private', evidence: 'Synthetic private-site fixture' };
const navigation = { headers: { accept: 'text/html' } };

test('private-site admission uses a separate local Entra session and only its approved active identities', async (t) => {
  const { app, idp } = await simulator(t, ENTRA, initialState(), {
    observed,
    identityProvider: { privateSiteContactIds: ['alex'] },
  });
  const browser = client(app);
  for (const route of ['/', '/_api/contacts', '/_layout/tokenhtml', '/resource/powerappsportal/img/Lock.png']) {
    const result = await browser.request(route);
    assert.equal(result.status, 401, route);
    assert.equal((await result.json()).error.code, 'PRIVATE_SITE_ACCESS_REQUIRED');
  }
  const contactSession = app.signIn('alex');
  assert.equal((await browser.request('/', { headers: { cookie: contactSession.cookieHeader } })).status, 401);

  const blocked = client(app);
  const blockedChallenge = await blocked.request('/', navigation);
  assert.equal(blockedChallenge.status, 302);
  const blockedReply = await choose(blocked, blockedChallenge.headers.get('location'), { contactId: 'blair' });
  const refusal = await postBack(blocked, blockedReply, idp.origin);
  assert.equal(refusal.status, 403);
  assert.equal((await refusal.json()).error.code, 'PRIVATE_SITE_ACCESS_DENIED');
  assert.equal((await blocked.request('/')).status, 401);

  const challenge = await browser.request('/', navigation);
  assert.equal(challenge.status, 302);
  const location = new URL(challenge.headers.get('location'));
  assert.equal(location.origin, idp.origin);
  assert.equal(location.pathname, '/azuread/oauth2/authorize');
  const reply = await choose(browser, location.href, { contactId: 'alex' });
  const admitted = await postBack(browser, reply, idp.origin);
  assert.equal(admitted.status, 302);
  assert.equal(admitted.headers.get('x-sim-route'), 'private-site-admission');
  assert.equal(admitted.headers.get('location'), '/');
  assert.ok(admitted.headers.getSetCookie().some((value) => /-site-access=/.test(value)));
  const home = await browser.request('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /id="user">anonymous<\/p>/);
  assert.notEqual((await browser.request('/members/')).status, 200, 'page rules still require the portal contact role');
  assert.equal(app.store.tableRows('adx_externalidentity').length, 0, 'admission never provisions portal identities');

  await app.store.update('contact', 'alex', { statecode: 1 }, { admin: true });
  assert.equal((await browser.request('/')).status, 401, 'an inactive fixture contact loses admission');
});

test('first private admission can choose an identity while ordinary portal sign-in keeps a silent prompt', async (t) => {
  const settings = [...ENTRA, ['Authentication/OpenIdConnect/AzureAD/Prompt', 'none']];
  const { app, idp } = await simulator(t, settings, initialState(), {
    observed,
    identityProvider: { privateSiteContactIds: ['alex'] },
  });
  const browser = client(app);
  const challenge = await browser.request('/', navigation);
  assert.equal(challenge.status, 302);
  const authorize = new URL(challenge.headers.get('location'));
  assert.equal(authorize.origin, idp.origin);
  const chooser = await browser.request(authorize.href, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(chooser.status, 200);
  assert.ok((await chooser.text()).includes('data-contact-id="alex"'), 'the first visit must show the local chooser');
  assert.equal(authorize.searchParams.has('prompt'), false);
  const reply = await choose(browser, authorize.href, { contactId: 'alex' });
  const admitted = await postBack(browser, reply, idp.origin);
  assert.equal(admitted.status, 302);
  assert.equal(admitted.headers.get('x-sim-route'), 'private-site-admission');
  assert.equal((await browser.request('/')).status, 200);

  const ordinary = await startSignIn(browser, { provider: ENTRA_AUTHORITY });
  const portalAuthorize = new URL(ordinary.headers.get('location'));
  assert.equal(portalAuthorize.origin, idp.origin);
  assert.equal(portalAuthorize.searchParams.get('prompt'), 'none');
});

test('the private banner alone reports missing local admission configuration', async (t) => {
  const { app } = await simulator(t, ENTRA, initialState(), { observed });
  const browser = client(app);
  const status = await (await browser.request('/_sim/api/status')).json();
  assert.equal(status.diagnostics.byCode.PRIVATE_SITE_ADMISSION_UNCONFIGURED, 1);
  const home = await browser.request('/');
  assert.equal(home.status, 200);
  assert.match(await home.text(), /id="privateModeText"/);
});
