// @test-kind unproven: local model of the ASP.NET Identity security stamp validator and private-site admission lifetime; Learn documents Authentication/ApplicationCookie/SecurityStampValidator/ValidateInterval (default 30 minutes) and ExpireTimeSpan (default 24 hours), the hosted validation of persona and external sessions and the admission cookie's lifetime are not captured
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCAL_PROVIDER,
  choose,
  client,
  formBody,
  initialState,
  postBack,
  signInThrough,
  simulator,
} from './support/external-sign-in.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';

const INTERVAL = ['Authentication/ApplicationCookie/SecurityStampValidator/ValidateInterval', '00:01:00'];
const signedInAs = async (browser) => (await (await browser.request('/_sim/api/session')).json()).contactId ?? null;
async function personaSignIn(browser, contactId) {
  const token = /value="([^"]+)"/.exec(await (await browser.request('/_layout/tokenhtml')).text())[1];
  const response = await browser.request(
    '/SignIn',
    formBody({ contactId, ReturnUrl: '/', __RequestVerificationToken: token }),
  );
  assert.equal(response.status, 302, await response.clone().text());
}

// @test-kind security: once the validation interval has passed, a changed security stamp or an inactive contact ends external and persona sessions
test('the security stamp validator ends sessions whose contact changed its stamp or became inactive', async (t) => {
  const clock = fixedClock(Date.parse('2026-04-01T08:00:00.000Z'));
  const settings = [
    ...LOCAL_PROVIDER.filter(([name]) => !name.endsWith('/LocalLoginEnabled')),
    ['Authentication/Registration/LocalLoginEnabled', 'true'],
    INTERVAL,
  ];
  const { app, idp } = await simulator(t, settings, initialState(), { clock });
  const external = client(app);
  await signInThrough(external, idp, { contactId: 'alex' });
  const persona = client(app);
  await personaSignIn(persona, 'blair');
  const unchanged = client(app);
  await personaSignIn(unchanged, 'casey');
  assert.deepEqual(
    [await signedInAs(external), await signedInAs(persona), await signedInAs(unchanged)],
    ['alex', 'blair', 'casey'],
  );
  await app.store.update(
    'contact',
    'alex',
    { adx_identity_securitystamp: 'rotated-after-password-change' },
    { admin: true },
  );
  await app.store.update('contact', 'blair', { statecode: 1 }, { admin: true });
  // Within the interval the changed stamp stands, as the validator has not run yet; an inactive contact never has an
  // identity (the runtime's own contact check), so its session is anonymous at once.
  clock.advance(59_999);
  assert.deepEqual([await signedInAs(external), await signedInAs(persona)], ['alex', null]);
  clock.advance(1);
  assert.deepEqual(
    [await signedInAs(external), await signedInAs(persona), await signedInAs(unchanged)],
    [null, null, 'casey'],
  );
  assert.match(await (await external.request('/')).text(), /id="user">anonymous</);
  // A new sign-in carries the new stamp and stays valid.
  await signInThrough(external, idp, { contactId: 'alex' });
  clock.advance(120_000);
  assert.equal(await signedInAs(external), 'alex');
});

test('the default validation interval is 30 minutes', async (t) => {
  const clock = fixedClock(Date.parse('2026-04-01T08:00:00.000Z'));
  const { app, idp } = await simulator(t, LOCAL_PROVIDER, initialState(), { clock });
  const browser = client(app);
  await signInThrough(browser, idp, { contactId: 'alex' });
  await app.store.update('contact', 'alex', { adx_identity_securitystamp: 'rotated' }, { admin: true });
  clock.advance(30 * 60 * 1000 - 1);
  assert.equal(await signedInAs(browser), 'alex');
  clock.advance(1);
  assert.equal(await signedInAs(browser), null);
});

const ENTRA = [
  ['Authentication/Registration/AzureADLoginEnabled', 'true'],
  ['Authentication/OpenIdConnect/AzureAD/Authority', 'https://login.windows.net/0f0f0f0f-1111-4222-8333-444444444444/'],
];
const observed = { siteVisibility: 'private', evidence: 'Synthetic private-site fixture' };
async function admit(app, idp, browser) {
  const challenge = await browser.request('/', { headers: { accept: 'text/html' } });
  assert.equal(challenge.status, 302);
  const reply = await choose(browser, challenge.headers.get('location'), { contactId: 'alex' });
  const admitted = await postBack(browser, reply, idp.origin);
  assert.equal(admitted.headers.get('x-sim-route'), 'private-site-admission');
}

// @test-kind security: private-site admission ends at its deadline and the next navigation asks for admission again
test('private-site admission ends at the application cookie lifetime, 24 hours by default', async (t) => {
  for (const [settings, lifetime] of [
    [
      [
        ...ENTRA,
        ['Authentication/ApplicationCookie/ExpireTimeSpan', '00:00:10'],
        ['Authentication/ApplicationCookie/SlidingExpiration', 'false'],
      ],
      10_000,
    ],
    [ENTRA, 24 * 60 * 60 * 1000],
  ]) {
    const clock = fixedClock(Date.parse('2026-04-01T08:00:00.000Z'));
    const { app, idp } = await simulator(t, settings, initialState(), {
      clock,
      observed,
      identityProvider: { privateSiteContactIds: ['alex'] },
    });
    const browser = client(app);
    await admit(app, idp, browser);
    clock.advance(lifetime - 1);
    assert.equal((await browser.request('/')).status, 200);
    clock.advance(1);
    const expired = await browser.request('/');
    assert.equal(expired.status, 401);
    assert.equal((await expired.json()).error.code, 'PRIVATE_SITE_ACCESS_REQUIRED');
    assert.equal((await browser.request('/', { headers: { accept: 'text/html' } })).status, 302);
  }
});

const PERSONA = '00000000-0000-4000-8000-0000000000a1';
/** A runtime with a persona catalogue entry for a contact, and the three ways a browser launches it. */
async function personaRuntime(t, settings, clock) {
  const state = initialState();
  state.tables.contact.push({
    contactid: PERSONA,
    fullname: 'Pat Persona',
    firstname: 'Pat',
    lastname: 'Persona',
    statecode: 0,
  });
  state.personaCatalog = {
    version: 1,
    groups: [{ id: 'team', label: 'Team', order: 0, subgroups: [{ id: 'all', label: 'All' }] }],
    personas: [{ key: 'alex-persona', contactId: PERSONA, label: 'Pat', group: 'team', subgroup: 'all' }],
  };
  const { app, csrf } = await simulator(t, settings, state, { clock });
  const launches = {
    'POST /_sim/api/personas/launch': async (browser) =>
      browser.request('/_sim/api/personas/launch', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf },
        body: JSON.stringify({ personaKey: 'alex-persona' }),
      }),
    'the sign-in form personaKey': async (browser) =>
      browser.request(
        '/SignIn',
        formBody({ personaKey: 'alex-persona', ReturnUrl: '/', __RequestVerificationToken: csrf }),
      ),
    'POST /__sim/sign-in': async (browser) =>
      browser.request(
        app.url + '/_sim/sign-in',
        formBody({ personaKey: 'alex-persona', ReturnUrl: '/', __RequestVerificationToken: csrf }),
      ),
  };
  return { app, launches };
}
const PERSONA_SETTINGS = [
  ...LOCAL_PROVIDER.filter(([name]) => !name.endsWith('/LocalLoginEnabled')),
  ['Authentication/Registration/LocalLoginEnabled', 'true'],
];

// @test-kind security: a launched persona is a browser session: a rotated security stamp ends it after the interval, and a site lifetime gives it a deadline
test('persona launches carry the security stamp and the application cookie lifetime', async (t) => {
  for (const name of ['POST /_sim/api/personas/launch', 'the sign-in form personaKey', 'POST /__sim/sign-in']) {
    const clock = fixedClock(Date.parse('2026-04-01T08:00:00.000Z'));
    const { app, launches } = await personaRuntime(t, [...PERSONA_SETTINGS, INTERVAL], clock);
    const browser = client(app);
    const launched = await launches[name](browser);
    assert.ok([200, 302].includes(launched.status), `${name}: ${launched.status} ${await launched.clone().text()}`);
    assert.equal(await signedInAs(browser), PERSONA, name);
    await app.store.update('contact', PERSONA, { adx_identity_securitystamp: `rotated-${name}` }, { admin: true });
    clock.advance(60_000);
    assert.equal(await signedInAs(browser), null, `${name}: the rotated stamp ends the launched session`);

    const sliding = fixedClock(Date.parse('2026-04-01T08:00:00.000Z'));
    const timed = await personaRuntime(
      t,
      [
        ...PERSONA_SETTINGS,
        ['Authentication/ApplicationCookie/ExpireTimeSpan', '00:00:10'],
        ['Authentication/ApplicationCookie/SlidingExpiration', 'true'],
      ],
      sliding,
    );
    const visitor = client(timed.app);
    await timed.launches[name](visitor);
    assert.equal(await signedInAs(visitor), PERSONA);
    sliding.advance(10_000);
    assert.equal(await signedInAs(visitor), null, `${name}: the sliding window gives the launched session a deadline`);
  }
});
