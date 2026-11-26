// @test-kind unproven: local models of the Power Pages SAML 2.0, WS-Federation and OAuth 2.0 providers built from the Microsoft Learn setup pages and SAML 2.0 FAQ (setting names, persistent NameID, unsigned AuthnRequest, PasswordProtectedTransport, RelayState ReturnUrl) and the OWIN middlewares; the platform's exact requests, claim types and refusal pages are not captured
import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync, inflateRawSync } from 'node:zlib';
import {
  client,
  choose,
  formBody,
  hiddenFields,
  initialState,
  postBack,
  simulator,
  startSignIn,
} from './support/external-sign-in.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';
import { CLAIM_TYPES } from '../lib/identity-federation.mjs';
import { signedAuthorization } from '../lib/identity-oauth1.mjs';

const SAML_IDP = 'urn:invented:partner-idp';
const SAML_SETTINGS = [
  ['Authentication/Registration/ExternalLoginEnabled', 'true'],
  ['Authentication/Registration/LocalLoginEnabled', 'false'],
  ['Authentication/SAML2/Partner/AuthenticationType', SAML_IDP],
  ['Authentication/SAML2/Partner/ServiceProviderRealm', 'urn:invented:portal'],
  ['Authentication/SAML2/Partner/AssertionConsumerServiceUrl', 'https://portal.example.test/signin-saml2'],
  ['Authentication/SAML2/Partner/MetadataAddress', 'https://partner.example.test/federationmetadata.xml'],
  ['Authentication/SAML2/Partner/Caption', 'Partner'],
];
const WS_STS = 'urn:invented:sts';
const WS_SETTINGS = [
  ['Authentication/Registration/ExternalLoginEnabled', 'true'],
  ['Authentication/Registration/LocalLoginEnabled', 'false'],
  ['Authentication/WsFederation/Sts/AuthenticationType', WS_STS],
  ['Authentication/WsFederation/Sts/Wtrealm', 'urn:invented:portal'],
  ['Authentication/WsFederation/Sts/Wreply', 'https://portal.example.test/signin-wsfed'],
  ['Authentication/WsFederation/Sts/Whr', 'urn:invented:home-realm'],
  ['Authentication/WsFederation/Sts/SignOutWreply', 'https://portal.example.test/'],
  ['Authentication/WsFederation/Sts/ExternalLogoutEnabled', 'true'],
];
const OAUTH_SETTINGS = [
  ['Authentication/Registration/ExternalLoginEnabled', 'true'],
  ['Authentication/Registration/LocalLoginEnabled', 'false'],
  ['Authentication/OpenAuth/Google/ClientId', 'invented-google-client'],
  ['Authentication/OpenAuth/Google/ClientSecret', 'invented-google-secret'],
  ['Authentication/OpenAuth/Google/Scope', 'openid,email'],
];

const json = async (browser, path) => (await browser.request(path)).json();
const decodeRedirect = (value) => inflateRawSync(Buffer.from(value, 'base64')).toString('utf8');
const samlOf = (html) => Buffer.from(hiddenFields(html).SAMLResponse, 'base64').toString('utf8');
const withSaml = (html, xml) => {
  const fields = hiddenFields(html);
  const inputs = Object.entries({ ...fields, SAMLResponse: Buffer.from(xml, 'utf8').toString('base64') })
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${name}" value="${value.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">`,
    )
    .join('');
  return html.replace(
    /<form method="post" action="([^"]+)">[\s\S]*?<h1>/,
    `<form method="post" action="$1">${inputs}<h1>`,
  );
};
const diagnosticsOf = async (app, code) =>
  ((await (await fetch(`${app.adminOrigin}/__sim/api/diagnostics`)).json()).diagnostics ?? []).filter(
    (item) => item.code === code,
  );
async function finish(browser, response) {
  assert.equal(response.status, 302, await response.clone().text());
  assert.equal(response.headers.get('x-sim-route'), 'external-login-response');
  return browser.request(response.headers.get('location'));
}
async function samlSignIn(browser, idp, options = {}) {
  const challenge = await startSignIn(browser, { provider: SAML_IDP, ...options });
  const html = await choose(browser, challenge.headers.get('location'), options);
  return { challenge, html, response: await postBack(browser, html, idp.origin) };
}

test('SAML 2.0: an unsigned AuthnRequest over HTTP-Redirect, a signed response posted to the assertion consumer service, and the contact session', async (t) => {
  const { app, idp } = await simulator(t, SAML_SETTINGS);
  const browser = client(app);
  const { challenge, html, response } = await samlSignIn(browser, idp, { contactId: 'alex', returnUrl: '/members/' });
  const authorize = new URL(challenge.headers.get('location'));
  assert.equal(authorize.origin + authorize.pathname, `${idp.origin}/saml2-partner/saml2`);
  assert.equal(authorize.searchParams.get('Signature'), null, 'Power Pages does not sign the AuthnRequest');
  const request = decodeRedirect(authorize.searchParams.get('SAMLRequest'));
  assert.match(request, /<saml:Issuer>urn:invented:portal<\/saml:Issuer>/);
  assert.match(request, new RegExp(`AssertionConsumerServiceURL="${app.url}/signin-saml2"`));
  assert.match(request, /NameIDPolicy Format="urn:oasis:names:tc:SAML:2.0:nameid-format:persistent"/);
  assert.match(request, /classes:PasswordProtectedTransport</);
  assert.ok(authorize.searchParams.get('RelayState').length <= 80, 'RelayState stays within the binding limit');
  // The identity provider posts a signed response and assertion to the registered reply URL.
  const saml = samlOf(html);
  assert.match(saml, /<samlp:Response [^>]*Destination="[^"]+\/signin-saml2"/);
  assert.equal((saml.match(/<ds:Signature /g) ?? []).length, 2);
  const done = await finish(browser, response);
  assert.equal(done.headers.get('location'), '/members/');
  const session = await json(browser, '/_sim/api/session');
  assert.equal(session.contactId, 'alex');
  const { identities } = await json(browser, '/_sim/api/session/identities');
  assert.deepEqual(
    identities.map((item) => [item.contactId, item.provider]),
    [['alex', SAML_IDP]],
  );
  // The federation metadata names the AuthenticationType as entity ID with the signing key and endpoints.
  const metadata = await (
    await fetch(`${idp.origin}/saml2-partner/federationmetadata/2007-06/federationmetadata.xml`)
  ).text();
  assert.match(metadata, /entityID="urn:invented:partner-idp"/);
  assert.match(metadata, /<ds:RSAKeyValue>/);
});

test('SAML 2.0 registration maps the issued attributes to the contact, by default or with RegistrationClaimsMapping', async (t) => {
  const mapping = `firstname=${CLAIM_TYPES.givenName},lastname=${CLAIM_TYPES.surname},emailaddress1=${CLAIM_TYPES.email},telephone1=${CLAIM_TYPES.mobilePhone}`;
  for (const [settings, expected] of [
    [SAML_SETTINGS, ['Dana', 'New', 'dana@example.test', undefined]],
    [
      [...SAML_SETTINGS, ['Authentication/SAML2/Partner/RegistrationClaimsMapping', mapping]],
      ['Dana', 'New', 'dana@example.test', '+1 555 0100'],
    ],
  ]) {
    const { app, idp } = await simulator(t, settings);
    const browser = client(app);
    const { response } = await samlSignIn(browser, idp, {
      newUser: { given_name: 'Dana', family_name: 'New', email: 'dana@example.test', phone_number: '+1 555 0100' },
    });
    const done = await finish(browser, response);
    assert.equal(done.headers.get('x-sim-route'), 'external-sign-in-registration');
    const session = await json(browser, '/_sim/api/session');
    const contact = app.store
      .snapshot({ tables: ['contact'] })
      .tables.contact.find((row) => row.contactid === session.contactId);
    assert.deepEqual([contact.firstname, contact.lastname, contact.emailaddress1, contact.telephone1], expected);
  }
  // AllowContactMappingWithEmail links the email attribute's contact when registration is off.
  const mapped = [
    ...SAML_SETTINGS,
    ['Authentication/Registration/Enabled', 'false'],
    ['Authentication/SAML2/Partner/AllowContactMappingWithEmail', 'true'],
  ];
  const { app, idp } = await simulator(t, mapped, initialState(), { identityProvider: { newUser: 'always' } });
  const browser = client(app);
  const { response } = await samlSignIn(browser, idp, {
    newUser: { given_name: 'Alex', family_name: 'Elsewhere', email: 'ALEX@example.test' },
  });
  const done = await finish(browser, response);
  assert.equal(done.headers.get('x-sim-route'), 'external-sign-in-email-mapping');
  assert.equal((await json(browser, '/_sim/api/session')).contactId, 'alex');
});

// @test-kind security: a SAML response completes only once, unaltered, signed by the metadata key, in the browser that started the sign-in, and never redirects off the site
test('SAML 2.0 responses that are unsigned, altered, from another browser, replayed or expired start no session, and return URLs stay on the site', async (t) => {
  const clock = fixedClock(Date.parse('2026-03-01T10:00:00.000Z'));
  const { app, idp } = await simulator(t, SAML_SETTINGS, initialState(), { clock });
  const refusedWith = async (browser, html, code, { anonymous = true } = {}) => {
    const before = (await diagnosticsOf(app, code)).length;
    const response = await postBack(browser, html, idp.origin);
    assert.equal(response.status, 400, `${code}: ${response.status}`);
    if (anonymous) assert.equal((await json(browser, '/_sim/api/session')).contactId ?? null, null);
    assert.equal((await diagnosticsOf(app, code)).length, before + 1, `diagnostic ${code}`);
  };
  // Unsigned and altered responses, each for its own pending sign-in (a refused answer spends it).
  for (const change of [
    (xml) => xml.replace(/<ds:Signature [\s\S]*?<\/ds:Signature>/g, ''),
    (xml) => xml.replace('alex@example.test', 'blair@example.test'),
  ]) {
    const browser = client(app);
    const challenge = await startSignIn(browser, { provider: SAML_IDP });
    const html = await choose(browser, challenge.headers.get('location'), { contactId: 'alex' });
    const forged = change(samlOf(html));
    assert.notEqual(forged, samlOf(html));
    await refusedWith(browser, withSaml(html, forged), 'FEDERATION_SIGNATURE_INVALID');
  }
  // A response for another browser's sign-in, then a replay of a completed one.
  {
    const victim = client(app);
    const challenge = await startSignIn(victim, { provider: SAML_IDP });
    const html = await choose(victim, challenge.headers.get('location'), { contactId: 'alex' });
    await refusedWith(client(app), html, 'FEDERATION_REQUEST_MISMATCH');
    await finish(victim, await postBack(victim, html, idp.origin));
    await refusedWith(victim, html, 'FEDERATION_REQUEST_MISMATCH', { anonymous: false });
  }
  // An identity-provider-initiated response: its RelayState ReturnUrl stays on the site; a replay and an expired one are refused.
  {
    const browser = client(app);
    const start = `${idp.origin}/saml2-partner/saml2/idpinitiated?RelayState=${encodeURIComponent('ReturnUrl=https://evil.example/steal')}`;
    const html = await choose(browser, start, { contactId: 'alex' });
    const done = await finish(browser, await postBack(browser, html, idp.origin));
    assert.equal(done.headers.get('location'), '/', 'an absolute RelayState ReturnUrl falls back to the site root');
    await refusedWith(client(app), html, 'FEDERATION_REPLAY');
    const late = client(app);
    const lateHtml = await choose(
      late,
      `${idp.origin}/saml2-partner/saml2/idpinitiated?RelayState=ReturnUrl%3D%2Fmembers%2F`,
      {
        contactId: 'alex',
      },
    );
    clock.advance(2 * 60 * 60 * 1000);
    await refusedWith(late, lateHtml, 'FEDERATION_ASSERTION_EXPIRED');
  }
  // ExternalLogin's own return URL is confined to the site as well.
  {
    const browser = client(app);
    const { response } = await samlSignIn(browser, idp, { contactId: 'alex', returnUrl: '//evil.example/x' });
    assert.equal((await finish(browser, response)).headers.get('location'), '/');
  }
});

// @test-kind security: the identity provider answers only the registered service provider realm and assertion consumer service URL
test('the local SAML identity provider refuses an AuthnRequest from another realm or for another reply URL', async (t) => {
  const { app } = await simulator(t, SAML_SETTINGS);
  const browser = client(app);
  const challenge = await startSignIn(browser, { provider: SAML_IDP });
  const authorize = new URL(challenge.headers.get('location'));
  const request = decodeRedirect(authorize.searchParams.get('SAMLRequest'));

  for (const [from, to] of [
    ['<saml:Issuer>urn:invented:portal<', '<saml:Issuer>urn:invented:other<'],
    [`AssertionConsumerServiceURL="${app.url}/signin-saml2"`, 'AssertionConsumerServiceURL="https://evil.example/acs"'],
  ]) {
    const forged = new URL(authorize);
    forged.searchParams.set('SAMLRequest', deflateRawSync(Buffer.from(request.replace(from, to))).toString('base64'));
    const answer = await fetch(forged);
    assert.equal(answer.status, 400);
    assert.doesNotMatch(await answer.text(), /name="SAMLResponse"/);
  }
});

test('SAML 2.0 sign-out with ExternalLogoutCertThumbprint sends a signed LogoutRequest and accepts the signed LogoutResponse', async (t) => {
  const settings = [
    ...SAML_SETTINGS,
    ['Authentication/SAML2/Partner/ExternalLogoutCertThumbprint', '0123456789ABCDEF0123456789ABCDEF01234567'],
  ];
  const { app, idp } = await simulator(t, settings);
  const browser = client(app);
  await finish(browser, (await samlSignIn(browser, idp, { contactId: 'alex' })).response);
  const logoff = await browser.request('/Account/Login/LogOff?returnUrl=%2Fmembers%2F');
  assert.equal(logoff.status, 302);
  assert.equal(logoff.headers.get('x-sim-route'), 'sign-out-external');
  const logout = new URL(logoff.headers.get('location'));
  assert.equal(logout.origin + logout.pathname, `${idp.origin}/saml2-partner/saml2/logout`);
  assert.ok(logout.searchParams.get('Signature') && logout.searchParams.get('SigAlg'));
  assert.match(
    decodeRedirect(logout.searchParams.get('SAMLRequest')),
    /<samlp:LogoutRequest [\s\S]*<saml:NameID [^>]*>[^<]+</,
  );
  assert.equal((await json(browser, '/_sim/api/session')).contactId ?? null, null, 'the site session ends first');
  const back = await browser.request(logout.href);
  assert.equal(back.status, 302);
  const reply = new URL(back.headers.get('location'));
  assert.equal(reply.origin + reply.pathname, `${app.url}/signin-saml2`);
  const done = await browser.request(reply.pathname + reply.search);
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('x-sim-route'), 'sign-out-external-complete');
  assert.equal(done.headers.get('location'), '/members/');
});

// @test-kind security: the identity provider ends a session only for a LogoutRequest signed with the registered logout certificate
test('a LogoutRequest with a broken signature or without a registered certificate is refused', async (t) => {
  const settings = [
    ...SAML_SETTINGS,
    ['Authentication/SAML2/Partner/ExternalLogoutCertThumbprint', '0123456789ABCDEF0123456789ABCDEF01234567'],
  ];
  const { app, idp } = await simulator(t, settings);
  const browser = client(app);
  await finish(browser, (await samlSignIn(browser, idp, { contactId: 'alex' })).response);
  const logout = new URL((await browser.request('/Account/Login/LogOff')).headers.get('location'));
  const signature = Buffer.from(logout.searchParams.get('Signature'), 'base64');
  signature[0] ^= 0xff;
  logout.searchParams.set('Signature', signature.toString('base64'));
  const refused = await fetch(logout);
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /signature is not valid/);
  // The portal refuses a LogoutResponse whose query signature does not verify, and ends no pending sign-out with it.
  await finish(browser, (await samlSignIn(browser, idp, { contactId: 'alex' })).response);
  const again = (await browser.request('/Account/Login/LogOff')).headers.get('location');
  const reply = new URL((await browser.request(again)).headers.get('location'));
  const replySignature = Buffer.from(reply.searchParams.get('Signature'), 'base64');
  replySignature[0] ^= 0xff;
  reply.searchParams.set('Signature', replySignature.toString('base64'));
  const forged = await browser.request(reply.pathname + reply.search);
  assert.equal(forged.status, 400);
  assert.ok((await diagnosticsOf(app, 'FEDERATION_SIGNATURE_INVALID')).length > 0);
  // Without the thumbprint the site signs out locally only.
  const local = await simulator(t, SAML_SETTINGS);
  const other = client(local.app);
  await finish(other, (await samlSignIn(other, local.idp, { contactId: 'alex' })).response);
  const plain = await other.request('/Account/Login/LogOff');
  assert.equal(plain.headers.get('x-sim-route'), 'sign-out');
});

test('WS-Federation: wsignin1.0 with wtrealm, wreply, wctx and whr, the posted token response, and wsignout1.0 with the sign-out reply', async (t) => {
  const { app, idp } = await simulator(t, WS_SETTINGS);
  const browser = client(app);
  const challenge = await startSignIn(browser, { provider: WS_STS, returnUrl: '/members/' });
  const passive = new URL(challenge.headers.get('location'));
  assert.equal(passive.origin + passive.pathname, `${idp.origin}/wsfederation-sts/wsfed`);
  assert.deepEqual(
    ['wa', 'wtrealm', 'wreply', 'whr'].map((name) => passive.searchParams.get(name)),
    ['wsignin1.0', 'urn:invented:portal', `${app.url}/signin-wsfed`, 'urn:invented:home-realm'],
  );
  assert.ok(passive.searchParams.get('wctx'));
  const html = await choose(browser, passive.href, { contactId: 'alex' });
  assert.match(hiddenFields(html).wresult, /^<t:RequestSecurityTokenResponse [\s\S]*<saml:Assertion /);
  const done = await finish(browser, await postBack(browser, html, idp.origin));
  assert.equal(done.headers.get('location'), '/members/');
  assert.equal((await json(browser, '/_sim/api/session')).contactId, 'alex');
  const logoff = await browser.request('/Account/Login/LogOff');
  const signOut = new URL(logoff.headers.get('location'));
  assert.deepEqual(
    [signOut.pathname, signOut.searchParams.get('wa'), signOut.searchParams.get('wreply')],
    ['/wsfederation-sts/wsfed', 'wsignout1.0', `${app.url}/`],
  );
  const back = await browser.request(signOut.href);
  assert.equal(back.status, 302);
  assert.equal(back.headers.get('location'), `${app.url}/`);
});

// @test-kind security: a WS-Federation token completes only in the browser that started the sign-in, once, unaltered; foreign reply URLs are never followed
test('WS-Federation results from another browser, altered or replayed are refused; the provider refuses foreign wreply values', async (t) => {
  const { app, idp } = await simulator(t, WS_SETTINGS);
  const victim = client(app);
  const passive = (await startSignIn(victim, { provider: WS_STS })).headers.get('location');
  const html = await choose(victim, passive, { contactId: 'alex' });
  const other = client(app);
  const foreign = await postBack(other, html, idp.origin);
  assert.equal(foreign.status, 400);
  assert.equal((await diagnosticsOf(app, 'EXTERNAL_LOGIN_STATE_INVALID')).length, 1);
  const fields = hiddenFields(html);
  const altered = await victim.request(new URL(`${app.url}/signin-wsfed`).pathname, {
    ...formBody({ ...fields, wresult: fields.wresult.replace('alex@example.test', 'blair@example.test') }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: idp.origin, 'sec-fetch-site': 'same-site' },
  });
  assert.equal(altered.status, 400);
  assert.equal((await diagnosticsOf(app, 'FEDERATION_SIGNATURE_INVALID')).length, 1);
  assert.equal((await json(victim, '/_sim/api/session')).contactId ?? null, null);
  // A refused answer spends the pending sign-in; a new sign-in completes once.
  const victimPassive = (await startSignIn(victim, { provider: WS_STS })).headers.get('location');
  const fresh = await choose(victim, victimPassive, { contactId: 'alex' });
  await finish(victim, await postBack(victim, fresh, idp.origin));
  // The same token under a new sign-in's wctx is a replay.
  const again = new URL((await startSignIn(other, { provider: WS_STS })).headers.get('location')).searchParams.get(
    'wctx',
  );
  const replayed = await other.request('/signin-wsfed', {
    ...formBody({ ...hiddenFields(fresh), wctx: again }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: idp.origin, 'sec-fetch-site': 'same-site' },
  });
  assert.equal(replayed.status, 400);
  assert.equal((await diagnosticsOf(app, 'FEDERATION_REPLAY')).length, 1);
  const evil = new URL(passive);
  evil.searchParams.set('wreply', 'https://evil.example/');
  assert.equal((await fetch(evil)).status, 400);
  const signOut = await fetch(
    `${idp.origin}/wsfederation-sts/wsfed?wa=wsignout1.0&wreply=${encodeURIComponent('https://evil.example/')}`,
    {
      redirect: 'manual',
    },
  );
  assert.equal(signOut.status, 200);
  assert.match(await signOut.text(), /was not followed/);
});

/** An OAuth 2.0 sign-in: the chooser's answer is a redirect with the code on the query string. */
async function oauthSignIn(browser, { contactId = null, newUser = null } = {}) {
  const challenge = await startSignIn(browser, { provider: 'Google' });
  const authorize = new URL(challenge.headers.get('location'));
  const chooser = await (await browser.request(authorize.href, { headers: { 'sec-fetch-site': 'cross-site' } })).text();
  const subject = contactId
    ? new RegExp(`data-subject="([^"]+)" data-contact-id="${contactId}"`).exec(chooser)[1]
    : 'new';
  const answer = await browser.request(
    authorize.origin + authorize.pathname,
    formBody({ ...Object.fromEntries(authorize.searchParams), subject, ...(newUser ?? {}) }),
  );
  assert.equal(answer.status, 302, await answer.clone().text());
  return { authorize, callback: new URL(answer.headers.get('location')) };
}

test('OAuth 2.0: the authorization code is redeemed with the client secret and the user profile claims map to the contact', async (t) => {
  const mapping = `firstname=${CLAIM_TYPES.givenName},lastname=${CLAIM_TYPES.surname},emailaddress1=${CLAIM_TYPES.email},nickname=${CLAIM_TYPES.name}`;
  const settings = [...OAUTH_SETTINGS, ['Authentication/OpenAuth/Google/RegistrationClaimsMapping', mapping]];
  const { app } = await simulator(t, settings);
  const browser = client(app);
  const { authorize, callback } = await oauthSignIn(browser, {
    newUser: { given_name: 'Olu', family_name: 'Auth', email: 'olu@example.test' },
  });
  assert.deepEqual(
    ['client_id', 'redirect_uri', 'response_type', 'scope', 'nonce'].map((name) => authorize.searchParams.get(name)),
    ['invented-google-client', `${app.url}/signin-google`, 'code', 'openid email', null],
  );
  assert.equal(callback.pathname, '/signin-google');
  assert.ok(callback.searchParams.get('code'));
  const done = await finish(browser, await browser.request(callback.pathname + callback.search));
  assert.equal(done.headers.get('x-sim-route'), 'external-sign-in-registration');
  const session = await json(browser, '/_sim/api/session');
  const contact = app.store
    .snapshot({ tables: ['contact'] })
    .tables.contact.find((row) => row.contactid === session.contactId);
  assert.deepEqual(
    [contact.firstname, contact.lastname, contact.emailaddress1, contact.nickname],
    ['Olu', 'Auth', 'olu@example.test', 'Olu Auth'],
  );
  const { identities } = await json(browser, '/_sim/api/session/identities');
  assert.equal(identities.find((item) => item.contactId === session.contactId).provider, 'Google');
});

test('OAuth 2.0 LoginClaimsMapping updates a mapped contact on sign-in', async (t) => {
  const settings = [
    ...OAUTH_SETTINGS,
    ['Authentication/OpenAuth/Google/LoginClaimsMapping', `nickname=${CLAIM_TYPES.name}`],
  ];
  const { app } = await simulator(t, settings);
  const browser = client(app);
  const { callback } = await oauthSignIn(browser, { contactId: 'alex' });
  await finish(browser, await browser.request(callback.pathname + callback.search));
  const contact = app.store.snapshot({ tables: ['contact'] }).tables.contact.find((row) => row.contactid === 'alex');
  assert.equal(contact.nickname, 'Alex Local');
});

// @test-kind security: an OAuth 2.0 answer completes only in the browser that started it, once, and only with the registered client secret
test('OAuth 2.0 answers from another browser, a reused code and a missing client secret start no session', async (t) => {
  const { app } = await simulator(t, OAUTH_SETTINGS);
  const victim = client(app);
  const { callback } = await oauthSignIn(victim, { contactId: 'alex' });
  const attacker = client(app);
  const foreign = await attacker.request(callback.pathname + callback.search);
  assert.equal(foreign.status, 400);
  assert.equal((await json(attacker, '/_sim/api/session')).contactId ?? null, null);
  await finish(victim, await victim.request(callback.pathname + callback.search));
  const reused = await victim.request(callback.pathname + callback.search);
  assert.equal(reused.status, 400, 'the pending sign-in is spent');
  const noSecret = await simulator(
    t,
    OAUTH_SETTINGS.filter(([name]) => !name.endsWith('/ClientSecret')),
  );
  assert.ok((await diagnosticsOf(noSecret.app, 'EXTERNAL_LOGIN_SETTING_INVALID')).length > 0);
  const browser = client(noSecret.app);
  const answer = await oauthSignIn(browser, { contactId: 'alex' });
  const refused = await browser.request(answer.callback.pathname + answer.callback.search);
  assert.equal(refused.status, 502);
  assert.match(await refused.text(), /refused the authorization code/);
  assert.equal((await json(browser, '/_sim/api/session')).contactId ?? null, null);
});

const TWITTER_SETTINGS = [
  ['Authentication/Registration/ExternalLoginEnabled', 'true'],
  ['Authentication/Registration/LocalLoginEnabled', 'false'],
  ['Authentication/OpenAuth/Twitter/ConsumerKey', 'invented-consumer-key'],
  ['Authentication/OpenAuth/Twitter/ConsumerSecret', 'invented-consumer-secret'],
];
/** A Twitter sign-in up to the provider's redirect to the callback with oauth_token and oauth_verifier. */
async function twitterSignIn(browser, { contactId = null, newUser = null } = {}) {
  const challenge = await startSignIn(browser, { provider: 'Twitter' });
  const authenticate = new URL(challenge.headers.get('location'));
  const chooser = await (
    await browser.request(authenticate.href, { headers: { 'sec-fetch-site': 'cross-site' } })
  ).text();
  const subject = contactId
    ? new RegExp(`data-subject="([^"]+)" data-contact-id="${contactId}"`).exec(chooser)[1]
    : 'new';
  const answer = await browser.request(
    authenticate.origin + authenticate.pathname,
    formBody({ ...Object.fromEntries(authenticate.searchParams), subject, ...(newUser ?? {}) }),
  );
  assert.equal(answer.status, 302, await answer.clone().text());
  return { authenticate, callback: new URL(answer.headers.get('location')) };
}

test('Twitter signs in with OAuth 1.0a: a request token, the user authorization and the access token for the verifier', async (t) => {
  const { app, idp } = await simulator(t, TWITTER_SETTINGS);
  const browser = client(app);
  const { authenticate, callback } = await twitterSignIn(browser, {
    newUser: { given_name: 'Tess', family_name: 'Tweet', email: 'tess@example.test' },
  });
  assert.equal(authenticate.origin + authenticate.pathname, `${idp.origin}/oauth-twitter/oauth/authenticate`);
  assert.deepEqual([...authenticate.searchParams.keys()], ['oauth_token']);
  assert.equal(callback.pathname, '/signin-twitter');
  assert.deepEqual([...callback.searchParams.keys()], ['oauth_token', 'oauth_verifier']);
  const done = await finish(browser, await browser.request(callback.pathname + callback.search));
  assert.equal(done.headers.get('x-sim-route'), 'external-sign-in-registration');
  const session = await json(browser, '/_sim/api/session');
  const contact = app.store
    .snapshot({ tables: ['contact'] })
    .tables.contact.find((row) => row.contactid === session.contactId);
  // The OWIN Twitter middleware issues the user ID and screen name only (no email).
  assert.deepEqual([contact.lastname, contact.emailaddress1], ['tess', undefined]);
  const { identities } = await json(browser, '/_sim/api/session/identities');
  assert.equal(identities.find((item) => item.contactId === session.contactId).provider, 'Twitter');
  const status = (await json(browser, '/_sim/api/session')).identityProvider.providers.find(
    (item) => item.name === 'Twitter',
  );
  assert.deepEqual([status.protocol, status.flow], ['oauth1', 'oauth1-request-token']);
});

// @test-kind security: the OAuth 1.0a endpoints accept only requests signed with the registered consumer secret, with a fresh timestamp, an unused nonce and the registered callback; request tokens and verifiers are single-use and browser-bound
test('OAuth 1.0a requests with a tampered signature, a wrong secret, a reused nonce, a stale timestamp or another callback are refused', async (t) => {
  const clock = fixedClock(Date.parse('2026-05-01T12:00:00.000Z'));
  const { app, idp } = await simulator(t, TWITTER_SETTINGS, initialState(), { clock });
  const url = `${idp.origin}/oauth-twitter/oauth/request_token`;
  const callback = `${app.url}/signin-twitter`;
  const ask = (authorization) =>
    fetch(url, { method: 'POST', headers: { authorization, 'content-type': 'application/x-www-form-urlencoded' } });
  const header = (extra = {}) =>
    signedAuthorization({
      method: 'POST',
      url,
      consumerKey: 'invented-consumer-key',
      consumerSecret: 'invented-consumer-secret',
      oauth: { oauth_callback: callback },
      now: clock.now(),
      ...extra,
    });
  const valid = header();
  assert.equal((await ask(valid)).status, 200);
  assert.equal((await ask(valid)).status, 401, 'a nonce is used once');
  const tampered = header().replace(
    /oauth_signature="([^"]+)"/,
    (match, value) => `oauth_signature="${value.slice(1)}A"`,
  );
  assert.equal((await ask(tampered)).status, 401);
  assert.equal((await ask(header({ consumerSecret: 'other-secret' }))).status, 401);
  assert.equal((await ask(header({ now: clock.now() - 301_000 }))).status, 401);
  assert.equal((await ask(header({ consumerKey: 'other-key' }))).status, 401);
  const changedCallback = header().replace(encodeURIComponent(callback), encodeURIComponent('https://evil.example/cb'));
  assert.equal((await ask(changedCallback)).status, 401, 'a changed parameter breaks the signature');
  assert.equal((await ask(header({ oauth: { oauth_callback: 'https://evil.example/cb' } }))).status, 403);
  // The access token needs the request token's secret and verifier, once.
  const victim = client(app);
  const { callback: reply } = await twitterSignIn(victim, { contactId: 'alex' });
  const attacker = client(app);
  const foreign = await attacker.request(reply.pathname + reply.search);
  assert.equal(foreign.status, 400, 'the callback completes only in the browser that asked for the request token');
  const forged = new URL(reply);
  forged.searchParams.set('oauth_verifier', 'forged-verifier-value');
  assert.equal((await victim.request(forged.pathname + forged.search)).status, 502);
  assert.equal((await json(victim, '/_sim/api/session')).contactId ?? null, null);
  const access = `${idp.origin}/oauth-twitter/oauth/access_token`;
  const reuse = await fetch(access, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: signedAuthorization({
        method: 'POST',
        url: access,
        consumerKey: 'invented-consumer-key',
        consumerSecret: 'invented-consumer-secret',
        token: reply.searchParams.get('oauth_token'),
        body: { oauth_verifier: reply.searchParams.get('oauth_verifier') },
        now: clock.now(),
      }),
    },
    body: new URLSearchParams({ oauth_verifier: reply.searchParams.get('oauth_verifier') }),
  });
  assert.equal(reuse.status, 401, 'a spent request token and one signed without its secret are refused');
});

test('the local SAML identity provider answers IsPassive without a page and ForceAuthn with a fresh choice', async (t) => {
  const { app, idp } = await simulator(t, SAML_SETTINGS);
  const browser = client(app);
  /** A started sign-in whose AuthnRequest carries `attributes`, sent to the identity provider. */
  const send = async (attributes) => {
    const challenge = await startSignIn(browser, { provider: SAML_IDP });
    const authorize = new URL(challenge.headers.get('location'));
    const request = decodeRedirect(authorize.searchParams.get('SAMLRequest')).replace(
      '<samlp:AuthnRequest ',
      `<samlp:AuthnRequest ${attributes} `,
    );
    authorize.searchParams.set('SAMLRequest', deflateRawSync(Buffer.from(request)).toString('base64'));
    return browser.request(authorize.href, { headers: { 'sec-fetch-site': 'cross-site' } });
  };
  // No provider session in this browser: IsPassive answers Responder/NoPassive, which the portal reports.
  const refused = await send('IsPassive="true"');
  const refusedHtml = await refused.text();
  assert.match(
    samlOf(refusedHtml),
    /status:Responder"><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:NoPassive"/,
  );
  assert.doesNotMatch(samlOf(refusedHtml), /<saml:Assertion /);
  const reported = await postBack(browser, refusedHtml, idp.origin);
  assert.equal(reported.status, 400);
  assert.match(await reported.text(), /NoPassive/);
  // After a sign-in the provider session answers IsPassive silently, unless ForceAuthn asks for a fresh authentication.
  await finish(browser, (await samlSignIn(browser, idp, { contactId: 'alex' })).response);
  const silent = await send('IsPassive="true"');
  await finish(browser, await postBack(browser, await silent.text(), idp.origin));
  assert.equal((await json(browser, '/_sim/api/session')).contactId, 'alex');
  const forced = await send('IsPassive="true" ForceAuthn="true"');
  assert.match(samlOf(await forced.text()), /status:NoPassive/);
  const chooser = await (await send('ForceAuthn="true"')).text();
  assert.match(chooser, /data-name="ForceAuthn"[^>]*>true</);
  assert.match(chooser, /data-contact-id="alex"/);
});

// @test-kind security: an anonymous post of an oversized-scope XML document to the reply URL is refused and the runtime keeps serving
test('a namespace bomb posted to the SAML reply URL is refused without a session', async (t) => {
  const { app, idp } = await simulator(t, SAML_SETTINGS);
  const prefixes = Array.from({ length: 6000 }, (_, index) => ` xmlns:p${index}="urn:p${index}"`).join('');
  const bomb = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"${prefixes}>${'<c/>'.repeat(19_000)}</samlp:Response>`;
  const browser = client(app);
  const refused = await browser.request('/signin-saml2', {
    ...formBody({ SAMLResponse: Buffer.from(bomb).toString('base64'), RelayState: 'unknown-relay-state-0001' }),
    headers: { 'content-type': 'application/x-www-form-urlencoded', origin: idp.origin, 'sec-fetch-site': 'same-site' },
  });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /too many (?:namespaces|attributes)/);
  assert.equal((await json(browser, '/_sim/api/session')).contactId ?? null, null);
  assert.equal((await browser.request('/')).status, 200);
});
