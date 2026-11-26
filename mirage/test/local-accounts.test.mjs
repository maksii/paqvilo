// @test-kind security+contract: loopback local account fixtures protect credentials, session renewal after credential changes and one-time challenges.
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { authCookieName } from '../lib/auth-session.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';
import { createLocalAccounts, rememberedBrowserCookieName } from '../lib/local-accounts.mjs';
import { client, formBody, hiddenFields, initialState, simulator } from './support/external-sign-in.mjs';

const SETTINGS = [
  ['Authentication/Registration/RequiresConfirmation', 'true'],
  ['Authentication/Registration/TwoFactorEnabled', 'true'],
  ['Authentication/UserManager/MaxFailedAccessAttemptsBeforeLockout', '2'],
];
const register = '/Account/Login/Register';
const login = '/Account/Login/Login';
const forgot = '/Account/Login/ForgotPassword';
const reset = '/Account/Login/ResetPassword';
const verify = '/Account/Login/VerifyCode';
const change = '/Account/Manage/ChangePassword';
const twoFactor = '/Account/Manage/TwoFactor';
const mailbox = '/_sim/api/local-accounts/messages';
const mailboxPrefix = '/local-accounts/messages';
const statusPath = '/_sim/api/status';
const account = { UserName: 'fixture-user', LastName: 'Fixture Account', Email: 'fixture-user@example.test' };

test('the opt-in browser token pairs with isolated local account forms', async (t) => {
  const { app } = await simulator(t, [], initialState(), {
    identityProvider: { localAccounts: true, pairedBrowserTokens: true },
  });
  const browser = client(app);
  const first = await browser.request(login);
  assert.equal(first.status, 200);
  const token = /name="__RequestVerificationToken" value="([0-9a-f]{64})"/.exec(await first.text())[1];
  assert.ok(token !== app.portalToken);
  const submit = (visitor, value) =>
    visitor.request(
      login,
      formBody({
        UserName: 'invented-missing-account',
        Password: 'Synthetic-Password-71',
        __RequestVerificationToken: value,
      }),
    );
  assert.equal((await submit(browser, app.portalToken)).status, 403);
  assert.equal((await submit(client(app), token)).status, 403);
  assert.equal((await submit(browser, token)).status, 401, 'the verified request reaches the fixture credential check');
});

test('local registration, confirmation, lockout, reset, password change and email MFA use only fixture state', async (t) => {
  const { app, csrf } = await simulator(t, SETTINGS, initialState(), { identityProvider: { localAccounts: true } });
  const browser = client(app);
  const send = (owner, target, fields) =>
    owner.request(target, formBody({ __RequestVerificationToken: app.portalToken, ...fields }));
  const message = async (kind) => {
    const response = await browser.request(mailbox, { headers: { 'x-sim-csrf': csrf } });
    assert.equal(response.status, 200);
    return (await response.json()).items.find((item) => item.kind === kind && item.to === account.Email);
  };
  const password = (value) => ({ Password: value, ConfirmPassword: value });
  const first = 'Fixture-first-21',
    second = 'Fixture-reset-22',
    third = 'Fixture-changed-23';
  const credentials = (Password) => ({ UserName: account.UserName, Password });
  const signInPage = await (await browser.request('/signin')).text();
  assert.match(signInPage, /href="\/Account\/Login\/Login\?ReturnUrl=/);
  assert.doesNotMatch(signInPage, /type="password"/);
  assert.match(signInPage, /Choose a local persona/);
  const localLoginPage = await browser.request(login);
  assert.match(await localLoginPage.text(), /type="password"/);
  assert.equal(localLoginPage.headers.get('cache-control'), 'no-store');
  assert.match(localLoginPage.headers.get('content-security-policy'), /default-src 'none'/);
  assert.ok((await (await browser.request(statusPath)).json()).routes.includes(mailboxPrefix));
  assert.equal((await browser.request(mailbox)).status, 403);
  assert.equal((await fetch(app.url + mailbox, { headers: { 'x-sim-csrf': csrf }, redirect: 'manual' })).status, 403);
  assert.equal((await browser.request(register, formBody({ ...account, ...password(first) }))).status, 403);
  assert.equal((await send(browser, register, { ...account, ...password('short') })).status, 400);
  assert.equal((await send(browser, register, { ...account, ...password(first) })).status, 200);
  assert.equal((await send(browser, register, { ...account, ...password(first) })).status, 409);
  assert.equal((await send(browser, login, credentials(first))).status, 403, 'confirmation is required');
  assert.doesNotMatch(JSON.stringify(app.store.snapshot()), /Fixture-first-21/);

  const confirmation = await message('confirm');
  assert.equal((await browser.request(confirmation.url)).status, 200);
  assert.equal((await browser.request(confirmation.url)).status, 403, 'the link is one time');
  assert.equal((await send(browser, login, credentials('invalid-1'))).status, 401);
  assert.equal((await send(browser, login, credentials('invalid-2'))).status, 403);
  assert.equal(
    (await send(browser, login, credentials(first))).status,
    403,
    'the lockout also refuses a correct password',
  );

  assert.equal((await send(browser, forgot, { Email: account.Email })).status, 200);
  const resetMessage = await message('reset');
  const resetUrl = new URL(resetMessage.url, app.url);
  assert.equal((await browser.request(resetMessage.url)).status, 200);
  const token = { Account: resetUrl.searchParams.get('account'), Token: resetUrl.searchParams.get('token') };
  assert.equal((await send(browser, reset, { ...token, ...password(second) })).status, 200);
  assert.equal((await send(browser, reset, { ...token, ...password(first) })).status, 403);
  const stale = client(app);
  assert.equal((await send(stale, login, credentials(second))).status, 302);
  assert.equal((await send(browser, login, credentials(second))).status, 302);
  assert.equal((await send(browser, change, { OldPassword: 'bad', ...password(third) })).status, 403);
  assert.equal((await send(browser, change, { OldPassword: second, ...password(third) })).status, 302);
  assert.match(await (await stale.request('/')).text(), /id="user">anonymous<\/p>/);
  assert.match(await (await browser.request('/')).text(), /id="user">Fixture Account<\/p>/);

  assert.equal((await send(browser, twoFactor, { OldPassword: third, Enabled: 'true' })).status, 302);
  const fresh = client(app);
  const pending = await send(fresh, login, credentials(third));
  assert.equal(pending.status, 302);
  assert.equal(pending.headers.get('location'), verify);
  assert.match(await (await fresh.request('/')).text(), /id="user">anonymous<\/p>/);
  assert.doesNotMatch(await (await fresh.request(verify)).text(), /name="RememberBrowser"/);
  const { code } = await message('mfa');
  assert.equal(
    (await send(client(app), verify, { Code: code })).status,
    403,
    'a different browser cannot use the message',
  );
  assert.equal((await send(fresh, verify, { Code: code === '000000' ? '000001' : '000000' })).status, 403);
  assert.equal((await send(fresh, verify, { Code: code })).status, 302);
  assert.equal((await send(fresh, verify, { Code: code })).status, 403, 'the code is consumed once');
  assert.match(await (await fresh.request('/')).text(), /id="user">Fixture Account<\/p>/);

  assert.equal((await send(browser, forgot, { Email: account.Email })).status, 200);
  const pendingReset = await message('reset');
  const contactId = new URL(pendingReset.url, app.url).searchParams.get('account');
  await app.store.update('contact', contactId, { emailaddress1: 'replacement@example.test' }, { admin: true });
  assert.equal(await message('reset'), undefined);
  assert.equal((await browser.request(pendingReset.url)).status, 403);
  assert.equal((await send(browser, forgot, { Email: account.Email })).status, 200);
  assert.equal(await message('reset'), undefined);
  assert.match(await (await fresh.request('/')).text(), /id="user">anonymous<\/p>/);
});

const REMEMBER = ['Authentication/Registration/RememberMeEnabled', 'true'];
const EXPIRY = ['Authentication/ApplicationCookie/ExpireTimeSpan', '00:00:10'];
const sliding = (value) => ['Authentication/ApplicationCookie/SlidingExpiration', value];
const REMEMBER_PASSWORD = 'Fixture-remember-27';

const appCookie = (app, response) => {
  const name = authCookieName(new URL(app.url).port);
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith(name + '='));
};
const expiryAt = (cookie) => /; Expires=([^;]+)/i.exec(cookie ?? '')?.[1];
const sendLocal = (app, browser, target, fields, csrf = app.portalToken) =>
  browser.request(target, formBody({ __RequestVerificationToken: csrf, ...fields }));

async function authFormToken(browser, target) {
  const page = await browser.request(target);
  assert.equal(page.status, 200);
  return hiddenFields(await page.text()).__RequestVerificationToken;
}

test('remember-me uses explicit local lifetime and an unchecked sign-in choice', async (t) => {
  for (const [settings, mayRemember] of [
    [[REMEMBER, EXPIRY, sliding('false')], true],
    [[['Authentication/Registration/RememberMeEnabled', 'false'], EXPIRY, sliding('false')], false],
    [[REMEMBER], false],
  ]) {
    const clock = fixedClock();
    const { app } = await simulator(t, settings, initialState(), { clock, identityProvider: { localAccounts: true } });
    const browser = client(app);
    const loginPage = await browser.request(login);
    assert.equal(loginPage.status, 200);
    const checkbox = /<input[^>]+name="RememberMe"[^>]*>/.exec(await loginPage.text())?.[0];
    assert.equal(Boolean(checkbox), mayRemember, 'the checkbox requires explicit local persistence settings');
    assert.doesNotMatch(checkbox ?? '', /checked/i);
    const registration = await sendLocal(app, browser, register, {
      ...account,
      Password: REMEMBER_PASSWORD,
      ConfirmPassword: REMEMBER_PASSWORD,
      RememberMe: 'true',
    });
    assert.equal(registration.status, 302);
    assert.equal(expiryAt(appCookie(app, registration)), undefined);
    const fields = { UserName: account.UserName, Password: REMEMBER_PASSWORD };
    const unchecked = await sendLocal(app, client(app), login, fields);
    assert.equal(unchecked.status, 302);
    assert.equal(expiryAt(appCookie(app, unchecked)), undefined);
    const chosen = await sendLocal(app, browser, login, { ...fields, RememberMe: 'true' });
    assert.equal(chosen.status, 302);
    assert.equal(
      expiryAt(appCookie(app, chosen)),
      mayRemember ? new Date(clock.now() + 10_000).toUTCString() : undefined,
    );
    if (!mayRemember) continue;
    clock.advance(5001);
    const fixed = await browser.request('/');
    assert.match(await fixed.text(), /id="user">Fixture Account<\/p>/);
    assert.equal(appCookie(app, fixed), undefined);
    clock.advance(4999);
    assert.match(await (await browser.request('/')).text(), /id="user">anonymous<\/p>/);
  }
});

test('remember-me survives bound email MFA and slides the browser expiry without changing its paired owner', async (t) => {
  const clock = fixedClock();
  const { app, csrf } = await simulator(t, [REMEMBER, EXPIRY, sliding('true'), ...SETTINGS], initialState(), {
    clock,
    identityProvider: { localAccounts: true, pairedBrowserTokens: true },
  });
  const registrationBrowser = client(app);
  const mailboxItem = async (kind) => {
    const response = await registrationBrowser.request(mailbox, { headers: { 'x-sim-csrf': csrf } });
    assert.equal(response.status, 200);
    return (await response.json()).items.find((item) => item.kind === kind);
  };
  const send = async (browser, target, fields, tokenTarget = target) =>
    sendLocal(app, browser, target, fields, await authFormToken(browser, tokenTarget));
  const credentials = { UserName: account.UserName, Password: REMEMBER_PASSWORD };
  const registration = await send(registrationBrowser, register, {
    ...account,
    ...credentials,
    ConfirmPassword: REMEMBER_PASSWORD,
  });
  assert.equal(registration.status, 200);
  assert.equal((await registrationBrowser.request((await mailboxItem('confirm')).url)).status, 200);
  assert.equal((await send(registrationBrowser, login, credentials)).status, 302);
  assert.equal(
    (await send(registrationBrowser, twoFactor, { OldPassword: REMEMBER_PASSWORD, Enabled: 'true' })).status,
    302,
  );

  const browser = client(app);
  const pending = await send(browser, login, { ...credentials, RememberMe: 'true' });
  assert.equal(pending.headers.get('location'), verify);
  assert.equal(appCookie(app, pending), undefined);
  clock.advance(2000);
  const verified = await send(browser, verify, { Code: (await mailboxItem('mfa')).code });
  assert.equal(verified.status, 302);
  assert.equal(expiryAt(appCookie(app, verified)), new Date(clock.now() + 10_000).toUTCString());
  const paired = async () => {
    const response = await browser.request('/_layout/tokenhtml');
    assert.equal(response.status, 200);
    const token = /name="__RequestVerificationToken"[^>]*value="([0-9a-f]{64})"/.exec(await response.text())?.[1];
    return { cookie: appCookie(app, response), token };
  };
  const early = await paired();
  assert.equal(early.cookie, undefined);
  assert.ok(early.token && early.token !== app.portalToken);
  clock.advance(5000);
  assert.equal((await paired()).cookie, undefined);
  clock.advance(1000);
  const refreshed = await paired();
  assert.equal(expiryAt(refreshed.cookie), new Date(clock.now() + 10_000).toUTCString());
  assert.ok(refreshed.token === early.token);
  assert.ok((await paired()).token === early.token);
  assert.match(await (await browser.request('/')).text(), /id="user">Fixture Account<\/p>/);
  clock.advance(6000);
  const logout = await browser.request('/Account/Login/LogOff');
  assert.equal(logout.status, 302);
  assert.ok(appCookie(app, logout));
  const applicationCookieName = authCookieName(new URL(app.url).port);
  assert.equal(
    logout.headers.getSetCookie().filter((cookie) => cookie.startsWith(applicationCookieName + '=')).length,
    1,
  );
  assert.equal(expiryAt(appCookie(app, logout)), undefined);
  assert.match(await (await browser.request('/')).text(), /id="user">anonymous<\/p>/);

  const withNoIntent = client(app);
  assert.equal((await send(withNoIntent, login, credentials)).headers.get('location'), verify);
  const postedAtMfa = await send(withNoIntent, verify, { Code: (await mailboxItem('mfa')).code, RememberMe: 'true' });
  assert.equal(postedAtMfa.status, 302);
  assert.equal(expiryAt(appCookie(app, postedAtMfa)), undefined);
});

// @test-kind security+contract: a remembered MFA marker is bounded, scoped to the same account and requires the current password.
test('remembered MFA browsers keep a separate, account-bound proof across ordinary logoff', async (t) => {
  const clock = fixedClock();
  const { app, csrf } = await simulator(
    t,
    [...SETTINGS, REMEMBER, EXPIRY, sliding('false'), ['Authentication/Registration/RememberBrowserEnabled', 'true']],
    initialState(),
    { clock, identityProvider: { localAccounts: true } },
  );
  const name = rememberedBrowserCookieName(authCookieName(new URL(app.url).port));
  const marker = (response) => response.headers.getSetCookie().find((cookie) => cookie.startsWith(name + '='));
  const send = (browser, target, fields) => sendLocal(app, browser, target, fields);
  const messages = async () => {
    const response = await client(app).request(mailbox, { headers: { 'x-sim-csrf': csrf } });
    assert.equal(response.status, 200);
    return (await response.json()).items;
  };
  const setup = async (profile) => {
    const browser = client(app);
    const credentials = { UserName: profile.UserName, Password: REMEMBER_PASSWORD };
    assert.equal(
      (
        await send(browser, register, {
          ...profile,
          ...credentials,
          ConfirmPassword: REMEMBER_PASSWORD,
        })
      ).status,
      200,
    );
    const confirm = (await messages()).find((message) => message.kind === 'confirm' && message.to === profile.Email);
    assert.equal((await browser.request(confirm.url)).status, 200);
    assert.equal((await send(browser, login, credentials)).status, 302);
    const enrolled = await send(browser, twoFactor, { OldPassword: REMEMBER_PASSWORD, Enabled: 'true' });
    assert.equal(enrolled.status, 302);
    return credentials;
  };
  const first = await setup(account);
  const second = await setup({
    UserName: 'second-mfa-fixture',
    LastName: 'Second fixture',
    Email: 'second-mfa-fixture@example.test',
  });
  const requestCode = async (browser, credentials) => {
    const response = await send(browser, login, credentials);
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), verify);
    assert.equal(appCookie(app, response), undefined);
  };
  const verifyCode = async (browser, email, fields) => {
    const message = (await messages()).find((item) => item.kind === 'mfa' && item.to === email);
    return send(browser, verify, { Code: message.code, ...fields });
  };
  const logout = async (browser) => {
    const response = await browser.request('/Account/Login/LogOff');
    assert.equal(response.status, 302);
    assert.equal(marker(response), undefined);
    assert.match(await (await browser.request('/')).text(), /id="user">anonymous<\/p>/);
  };
  const browser = client(app);
  await requestCode(browser, first);
  const checkbox = /<input[^>]+name="RememberBrowser"[^>]*>/.exec(await (await browser.request(verify)).text())?.[0];
  assert.ok(checkbox, 'the authored setting enables the checkbox on MFA verification');
  assert.doesNotMatch(checkbox, /checked/i);
  const refused = await send(browser, verify, { Code: '', RememberBrowser: 'true' });
  assert.equal(refused.status, 403);
  assert.equal(marker(refused), undefined);
  const verified = await verifyCode(browser, account.Email, { RememberBrowser: 'true' });
  assert.equal(verified.status, 302);
  assert.ok(/; HttpOnly; SameSite=Lax; Max-Age=86400$/.test(marker(verified) ?? ''));
  assert.equal(
    expiryAt(appCookie(app, verified)),
    undefined,
    'the MFA choice does not persist the application session',
  );
  await logout(browser);
  assert.equal((await send(browser, login, { ...first, Password: 'Fixture-incorrect-56' })).status, 401);
  assert.match(await (await browser.request('/')).text(), /id="user">anonymous<\/p>/);

  const otherBrowser = client(app);
  await requestCode(otherBrowser, first);
  const unchecked = await verifyCode(otherBrowser, account.Email, {});
  assert.equal(unchecked.status, 302);
  assert.equal(marker(unchecked), undefined);
  await logout(otherBrowser);
  await requestCode(otherBrowser, first);
  await requestCode(browser, second);

  clock.advance(86_400_000 - 1);
  const remembered = await send(browser, login, first);
  assert.equal(remembered.status, 302);
  assert.equal(remembered.headers.get('location'), '/');
  assert.ok(appCookie(app, remembered));
  assert.equal(marker(remembered), undefined, 'using a marker does not extend its deadline');
  await logout(browser);
  clock.advance(1);
  await requestCode(browser, first);
  assert.ok(marker(await verifyCode(browser, account.Email, { RememberBrowser: 'true' })));

  const changed = await send(browser, change, {
    OldPassword: REMEMBER_PASSWORD,
    Password: 'Fixture-next-81',
    ConfirmPassword: 'Fixture-next-81',
  });
  assert.equal(changed.status, 302);
  await logout(browser);
  await requestCode(browser, { ...first, Password: 'Fixture-next-81' });
});

test('credential routes remain opt-in and honor disabled local sign-in and registration CAPTCHA', async (t) => {
  const { app } = await simulator(t, [['Authentication/Registration/CaptchaEnabled', 'true']], initialState(), {
    identityProvider: { localAccounts: true },
  });
  assert.equal((await client(app).request(register)).status, 403);
  const disabled = await simulator(t, [['Authentication/Registration/LocalLoginEnabled', 'false']], initialState(), {
    identityProvider: { localAccounts: true },
  });
  assert.equal((await client(disabled.app).request(login)).status, 403);
  assert.doesNotMatch(await (await client(disabled.app).request('/signin')).text(), /Sign in with a local account/);
  const legacy = await simulator(t, [], initialState());
  const legacyBrowser = client(legacy.app);
  assert.doesNotMatch(await (await legacyBrowser.request('/signin')).text(), /Sign in with a local account/);
  assert.equal(
    (await (await legacyBrowser.request(statusPath)).json()).routes.includes(mailboxPrefix),
    false,
    'disabled mailbox must not be listed',
  );
  assert.equal((await legacyBrowser.request(mailbox, { headers: { 'x-sim-csrf': legacy.csrf } })).status, 404);
});

const CAPTCHA_SETTINGS = [
  ['Authentication/Registration/CaptchaEnabled', 'true'],
  ['Authentication/Registration/RequiresConfirmation', 'true'],
];
const captchaOptions = {
  identityProvider: { localAccounts: true },
  packs: [
    {
      id: 'registration-captcha',
      name: 'Local registration challenge',
      description: 'Invented challenge for local account tests',
      matches: () => true,
      presets: () => ({}),
      serviceFixtures: {
        captcha: {
          challenge: ({ surface }) =>
            surface === 'registration' ? { prompt: 'What is 2 + 3? <test>', answer: '5' } : null,
        },
      },
    },
  ],
};

const registrationFields = (app, proof = {}, overrides = {}) => ({
  __RequestVerificationToken: app.portalToken,
  ...account,
  Password: 'Fixture-register-19',
  ConfirmPassword: 'Fixture-register-19',
  ...proof,
  ...overrides,
});

async function registrationProof(browser) {
  const response = await browser.request(register);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /What is 2 \+ 3\? &lt;test&gt;/);
  const { CaptchaChallengeToken } = hiddenFields(html);
  assert.match(CaptchaChallengeToken, /^[a-f0-9-]{36}$/);
  return { CaptchaChallengeToken, CaptchaAnswerToken: '5' };
}

test('a local registration proof requires browser ownership, CSRF and one successful challenge', async (t) => {
  const { app } = await simulator(t, CAPTCHA_SETTINGS, initialState(), captchaOptions);
  const browser = client(app),
    foreign = client(app);
  const original = app.store.snapshot().tables.contact.length;
  const head = await browser.request(register, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(head.headers.get('set-cookie'), null);
  const proof = await registrationProof(browser);
  await registrationProof(foreign);
  const send = (owner, provided, overrides) =>
    owner.request(register, formBody(registrationFields(app, provided, overrides)));

  const crossBrowser = await send(foreign, proof);
  assert.equal(crossBrowser.status, 403);
  assert.match(await crossBrowser.text(), /CAPTCHA answer is incorrect or expired/);
  assert.equal((await send(browser, proof, { __RequestVerificationToken: '' })).status, 403);
  assert.equal(app.store.snapshot().tables.contact.length, original);

  const accepted = await send(browser, proof);
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /Confirm your email before signing in/);
  assert.equal(app.store.snapshot().tables.contact.length, original + 1);
  const replay = await send(browser, proof, { UserName: 'other-fixture-account', Email: 'other-fixture@example.test' });
  assert.equal(replay.status, 403);
  assert.match(await replay.text(), /CAPTCHA answer is incorrect or expired/);
  assert.equal(app.store.snapshot().tables.contact.length, original + 1);
});

test('a failed local registration write rolls back and a new challenge can retry the same account', async (t) => {
  const { app } = await simulator(t, CAPTCHA_SETTINGS, initialState(), captchaOptions);
  const browser = client(app);
  const original = app.store.snapshot().tables.contact.length;
  let reachedPostOperation = false;
  app.store.setPluginPipeline(({ entity, stage }) => {
    if (entity === 'contact' && stage === 40) {
      reachedPostOperation = true;
      throw new Error('Synthetic contact registration rollback');
    }
  });
  const submit = (proof) => browser.request(register, formBody(registrationFields(app, proof)));
  const proof = await registrationProof(browser);
  const failed = await submit(proof);
  assert.equal(failed.status, 500);
  await failed.arrayBuffer();
  assert.equal(reachedPostOperation, true);
  assert.equal(app.store.snapshot().tables.contact.length, original);
  app.store.setPluginPipeline(
    () => {},
    () => false,
  );
  assert.equal((await submit(proof)).status, 403);
  const retry = await submit(await registrationProof(browser));
  assert.equal(retry.status, 200);
  assert.match(await retry.text(), /Confirm your email before signing in/);
  assert.equal(app.store.snapshot().tables.contact.length, original + 1);
});

test('a local CAPTCHA fixture does not enable invitation-only registration or run when live writes are authorized', async (t) => {
  const invite = await simulator(
    t,
    [...CAPTCHA_SETTINGS, ['Authentication/Registration/RequiresInvitation', 'true']],
    initialState(),
    captchaOptions,
  );
  const live = await simulator(t, CAPTCHA_SETTINGS, initialState(), { ...captchaOptions, allowLiveWrites: true });
  for (const app of [invite.app, live.app]) {
    const response = await client(app).request(register);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.doesNotMatch(await response.text(), /CaptchaChallengeToken/);
  }
});

test('reserved fixture credential routes never reach the live bridge', async (t) => {
  const forwarded = [];
  const liveBridge = {
    origin: 'https://portal.example.test',
    configure() {},
    status: () => ({ connected: true }),
    async request(path, { method }) {
      forwarded.push([method, path.split('?')[0]]);
      return { status: 200, headers: { 'content-type': 'text/plain' }, body: Buffer.from('fixture bridge') };
    },
    async close() {},
  };
  const state = initialState();
  Object.assign(state.simulator, {
    pageMode: 'live',
    live: { origin: liveBridge.origin, allowWrites: true },
    endpoints: [{ path: login, method: 'POST', mode: 'live' }],
  });
  const { app } = await simulator(t, SETTINGS, state, {
    identityProvider: { localAccounts: true },
    liveBridge,
    allowLiveWrites: true,
  });
  const browser = client(app);
  assert.equal(
    (await browser.request(reset + '?token=fixture-reset-link')).headers.get('x-sim-route'),
    'local-account',
  );
  const credentials = formBody({
    __RequestVerificationToken: app.portalToken,
    UserName: 'fixture-user',
    Password: 'Fixture-password-12',
  });
  assert.equal((await browser.request(login, credentials)).status, 401);
  assert.equal((await browser.request(login, { ...credentials, method: 'PUT' })).status, 405);
  assert.deepEqual(forwarded, []);
  assert.equal(await (await browser.request('/ordinary-live-page')).text(), 'fixture bridge');
  assert.deepEqual(forwarded, [['GET', '/ordinary-live-page']]);
});

async function localSite(t, settings, options = {}) {
  const { app, csrf } = await simulator(t, settings, initialState(), {
    identityProvider: { localAccounts: true },
    ...options,
  });
  const browser = client(app);
  const send = (owner, target, fields) =>
    owner.request(target, formBody({ __RequestVerificationToken: app.portalToken, ...fields }));
  const messages = async (kind) => {
    const response = await browser.request(mailbox, { headers: { 'x-sim-csrf': csrf } });
    assert.equal(response.status, 200);
    return (await response.json()).items.filter((item) => item.kind === kind);
  };
  const contactId = (email) => app.store.tableRows('contact').find((row) => row.emailaddress1 === email).contactid;
  const setEmail = (id, emailaddress1) => app.store.update('contact', id, { emailaddress1 }, { admin: true });
  const linkFields = (message) => {
    const url = new URL(message.url, app.url);
    return { Account: url.searchParams.get('account'), Token: url.searchParams.get('token') };
  };
  return { app, browser, send, messages, contactId, setEmail, linkFields };
}
const passwords = (value) => ({ Password: value, ConfirmPassword: value });
const signedInAs = async (browser, name) =>
  assert.match(await (await browser.request('/')).text(), new RegExp(`id="user">${name}</p>`));

// @test-kind unproven+security: an edit of emailaddress1 is modelled on Identity's SetEmail (the credential stamp rotates, ending sessions and pending messages) while the account keeps its password; recovery uses the contact's current address. No native capture.
test('an edit of the contact email ends sessions and pending links but keeps the account and recovery on the new address', async (t) => {
  const { app, browser, send, messages, contactId, setEmail, linkFields } = await localSite(t, []);
  const first = 'Fixture-first-21';
  assert.equal((await send(browser, register, { ...account, ...passwords(first) })).status, 302);
  await signedInAs(browser, 'Fixture Account');
  assert.equal((await send(browser, forgot, { Email: account.Email })).status, 200);
  const [pendingReset] = await messages('reset');
  await setEmail(contactId(account.Email), 'Renamed@Example.test');
  await signedInAs(browser, 'anonymous');
  assert.deepEqual(await messages('reset'), [], 'the pending message ends with the old address');
  assert.equal((await browser.request(pendingReset.url)).status, 403);
  const again = client(app);
  assert.equal((await send(again, login, { UserName: account.UserName, Password: first })).status, 302);
  await signedInAs(again, 'Fixture Account');
  await signedInAs(browser, 'anonymous');
  assert.equal((await send(browser, forgot, { Email: account.Email })).status, 200);
  assert.deepEqual(await messages('reset'), [], 'the previous address receives nothing');
  assert.equal((await send(browser, forgot, { Email: 'renamed@example.test' })).status, 200);
  const [resetMessage] = await messages('reset');
  assert.equal(resetMessage.to, 'renamed@example.test');
  const resetFields = { ...linkFields(resetMessage), ...passwords('Fixture-reset-22') };
  assert.equal((await send(browser, reset, resetFields)).status, 200);
  assert.equal((await send(client(app), login, { UserName: account.UserName, Password: first })).status, 401);
  const renewed = { UserName: account.UserName, Password: 'Fixture-reset-22' };
  assert.equal((await send(client(app), login, renewed)).status, 302);
});

// @test-kind unproven+security: under LocalLoginByEmail the sign-in and recovery address is the contact's current email; an address two accounts share identifies neither.
test('email sign-in follows the current contact email and refuses an address shared by two accounts', async (t) => {
  const { app, browser, send, messages, contactId, setEmail } = await localSite(t, [
    ['Authentication/Registration/LocalLoginByEmail', 'true'],
  ]);
  const second = { UserName: 'fixture-other', LastName: 'Other Account', Email: 'fixture-other@example.test' };
  assert.equal((await send(browser, register, { ...account, ...passwords('Fixture-first-21') })).status, 302);
  assert.equal((await send(client(app), register, { ...second, ...passwords('Fixture-other-24') })).status, 302);
  const firstId = contactId(account.Email),
    secondId = contactId(second.Email);
  const signIn = (UserName, Password) => send(client(app), login, { UserName, Password });
  await setEmail(firstId, 'moved@example.test');
  await signedInAs(browser, 'anonymous');
  assert.equal((await signIn(account.Email, 'Fixture-first-21')).status, 401);
  assert.equal((await signIn('moved@example.test', 'Fixture-first-21')).status, 302);

  await setEmail(secondId, 'moved@example.test');
  assert.equal((await signIn('moved@example.test', 'Fixture-first-21')).status, 401);
  assert.equal((await signIn('moved@example.test', 'Fixture-other-24')).status, 401);
  assert.equal((await send(browser, forgot, { Email: 'moved@example.test' })).status, 200);
  assert.deepEqual(await messages('reset'), [], 'an ambiguous address issues no reset');

  await setEmail(secondId, second.Email);
  assert.equal((await signIn('moved@example.test', 'Fixture-first-21')).status, 302);
  assert.equal((await send(browser, forgot, { Email: 'moved@example.test' })).status, 200);
  assert.deepEqual(
    (await messages('reset')).map((item) => item.to),
    ['moved@example.test'],
  );
});

// @test-kind unproven+security: a credential-stamp change or an expired link must not strand an unconfirmed account; a reissued link replaces only a stale one.
test('an unconfirmed account receives a new confirmation after a reset and after its link expires', async (t) => {
  const clock = fixedClock();
  const { browser, send, messages, linkFields } = await localSite(
    t,
    [['Authentication/Registration/RequiresConfirmation', 'true']],
    { clock },
  );
  assert.equal((await send(browser, register, { ...account, ...passwords('Fixture-first-21') })).status, 200);
  const [original] = await messages('confirm');
  assert.equal((await send(browser, forgot, { Email: account.Email })).status, 200);
  const [resetMessage] = await messages('reset');
  const resetFields = { ...linkFields(resetMessage), ...passwords('Fixture-reset-22') };
  assert.equal((await send(browser, reset, resetFields)).status, 200);
  assert.equal((await browser.request(original.url)).status, 403, 'the stamp change invalidates the first link');
  const [reissued] = await messages('confirm');
  assert.notEqual(reissued.url, original.url);
  assert.equal((await browser.request(reissued.url)).status, 200);
  assert.equal((await send(browser, login, { UserName: account.UserName, Password: 'Fixture-reset-22' })).status, 302);

  const other = { UserName: 'fixture-late', LastName: 'Late Account', Email: 'fixture-late@example.test' };
  assert.equal((await send(browser, register, { ...other, ...passwords('Fixture-late-25') })).status, 200);
  const lateLink = (await messages('confirm')).find((item) => item.to === other.Email);
  const credentials = { UserName: other.UserName, Password: 'Fixture-late-25' };
  assert.equal((await send(browser, login, credentials)).status, 403);
  assert.equal(
    (await messages('confirm')).find((item) => item.to === other.Email).url,
    lateLink.url,
    'a live link is not replaced',
  );
  clock.advance(86_400_001);
  assert.equal((await browser.request(lateLink.url)).status, 403);
  assert.deepEqual(await messages('confirm'), []);
  assert.equal((await send(browser, login, { ...credentials, Password: 'Fixture-wrong-26' })).status, 401);
  assert.deepEqual(await messages('confirm'), [], 'a wrong password issues nothing');
  assert.equal((await send(browser, login, credentials)).status, 403);
  const [fresh] = await messages('confirm');
  assert.equal(fresh.to, other.Email);
  assert.equal((await browser.request(fresh.url)).status, 200);
  assert.equal((await send(browser, login, credentials)).status, 302);
});

// @test-kind security: wrong second-factor codes count toward the configured lockout like wrong passwords (Identity AccessFailed), and a lock refuses a pending code.
test('wrong email MFA codes share the password lockout and a lock refuses a pending code', async (t) => {
  const clock = fixedClock();
  const { app, browser, send, messages } = await localSite(t, SETTINGS, { clock });
  const credentials = { UserName: account.UserName, Password: 'Fixture-first-21' };
  assert.equal((await send(browser, register, { ...account, ...passwords(credentials.Password) })).status, 200);
  assert.equal((await browser.request((await messages('confirm'))[0].url)).status, 200);
  assert.equal((await send(browser, login, credentials)).status, 302);
  assert.equal((await send(browser, twoFactor, { OldPassword: credentials.Password, Enabled: 'true' })).status, 302);
  const code = async () => (await messages('mfa'))[0].code;
  const wrong = (value) => (value === '000000' ? '000001' : '000000');
  const pastLockout = 86_400_001;

  const attacker = client(app);
  assert.equal((await send(attacker, login, credentials)).status, 302);
  const firstGuess = await send(attacker, verify, { Code: wrong(await code()) });
  assert.equal(firstGuess.status, 403);
  assert.match(await firstGuess.text(), /security code is incorrect/);
  assert.equal((await send(attacker, login, credentials)).status, 302, 'the password step keeps the failure');
  const pendingCode = await code();
  const secondGuess = await send(attacker, verify, { Code: wrong(pendingCode) });
  assert.equal(secondGuess.status, 403);
  assert.match(await secondGuess.text(), /temporarily locked/);
  assert.equal((await send(attacker, verify, { Code: pendingCode })).status, 403, 'the lock ends the challenge');
  assert.equal((await send(client(app), login, credentials)).status, 403, 'the lock refuses the correct password');

  clock.advance(pastLockout);
  const pending = client(app);
  assert.equal((await send(pending, login, credentials)).status, 302);
  const heldCode = await code();
  for (const Password of ['Fixture-wrong-1', 'Fixture-wrong-2'])
    await send(client(app), login, { UserName: account.UserName, Password });
  const refused = await send(pending, verify, { Code: heldCode });
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /temporarily locked/);
  await signedInAs(pending, 'anonymous');

  clock.advance(pastLockout);
  assert.equal((await send(client(app), login, { ...credentials, Password: 'Fixture-wrong-3' })).status, 401);
  const owner = client(app);
  assert.equal((await send(owner, login, credentials)).status, 302);
  assert.equal((await send(owner, verify, { Code: await code() })).status, 302);
  await signedInAs(owner, 'Fixture Account');
  assert.equal(
    (await send(client(app), login, { ...credentials, Password: 'Fixture-wrong-4' })).status,
    401,
    'a completed second factor resets the failures',
  );
});

// @test-kind security: an unknown or ambiguous sign-in name runs the same password verification as a known one, so the work done does not reveal which names exist.
test('a local sign-in for an unknown name verifies the password against a fixed scrypt verifier', async () => {
  const verified = [];
  const rendered = [];
  const accounts = createLocalAccounts({
    enabled: true,
    portal: () => ({ settings: {} }),
    store: {
      clock: { now: () => 0 },
      resolveMapping: () => ({ logicalName: 'contact', idColumn: 'contactid' }),
      tableRows: () => [],
    },
    requestTokens: { issue: () => 'fixture-token', expected: () => 'fixture-token' },
    authCookieName: () => 'fixture-auth',
    renderPage: (_req, _res, _url, { status }) => rendered.push(status),
    signedSession: () => null,
    canRememberSession: () => false,
    canRememberBrowser: () => false,
    signIn: () => assert.fail('an unknown account never signs in'),
    verifyPassword: (password, verifier) => (verified.push([password, verifier]), false),
  });
  const post = (fields) =>
    Object.assign(Readable.from([Buffer.from(new URLSearchParams(fields).toString())]), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
  const fields = { __RequestVerificationToken: 'fixture-token', UserName: 'missing-user', Password: 'Fixture-wrong-9' };
  assert.equal(await accounts.route(post(fields), {}, new URL('http://127.0.0.1' + login)), true);
  assert.equal(await accounts.route(post(fields), {}, new URL('http://127.0.0.1' + login)), true);
  assert.deepEqual(rendered, [401, 401]);
  assert.equal(verified.length, 2);
  for (const [password, verifier] of verified) {
    assert.equal(password, 'Fixture-wrong-9');
    assert.match(verifier.hash, /^scrypt\$[A-Za-z0-9_-]{43}$/);
  }
  assert.equal(verified[0][1], verified[1][1], 'one verifier per runtime');
  assert.doesNotMatch(JSON.stringify(verified.map(([, verifier]) => verifier)), /Fixture-wrong-9/);
});

// @test-kind security: a sign-in completed by a remembered browser clears earlier failures, so other visitors' wrong passwords cannot accumulate across the owner's successful sign-ins into a lockout.
test('a remembered-browser sign-in clears failures between wrong passwords from other visitors', async (t) => {
  const { app, browser, send, messages } = await localSite(t, [
    ...SETTINGS.filter(([name]) => !name.endsWith('MaxFailedAccessAttemptsBeforeLockout')),
    ['Authentication/Registration/RememberBrowserEnabled', 'true'],
    ['Authentication/UserManager/MaxFailedAccessAttemptsBeforeLockout', '3'],
  ]);
  const credentials = { UserName: account.UserName, Password: 'Fixture-remember-27' };
  assert.equal((await send(browser, register, { ...account, ...passwords(credentials.Password) })).status, 200);
  assert.equal((await browser.request((await messages('confirm'))[0].url)).status, 200);
  assert.equal((await send(browser, login, credentials)).status, 302);
  assert.equal((await send(browser, twoFactor, { OldPassword: credentials.Password, Enabled: 'true' })).status, 302);
  await browser.request('/Account/Login/LogOff');
  assert.equal((await send(browser, login, credentials)).status, 302);
  const [{ code }] = await messages('mfa');
  assert.equal((await send(browser, verify, { Code: code, RememberBrowser: 'true' })).status, 302);
  await browser.request('/Account/Login/LogOff');
  const statuses = [];
  for (let round = 0; round < 4; round++) {
    statuses.push((await send(client(app), login, { ...credentials, Password: 'Fixture-wrong-28' })).status);
    const owner = await send(browser, login, credentials);
    statuses.push(owner.status);
    assert.notEqual(owner.headers.get('location'), verify, 'the remembered browser skips the code');
    await browser.request('/Account/Login/LogOff');
  }
  assert.deepEqual(statuses, [401, 302, 401, 302, 401, 302, 401, 302]);
});

// @test-kind unproven+security: an edit of emailaddress1 is modelled on Identity's SetEmail, which also clears the confirmed state; with RequiresConfirmation the account signs in again only after confirming the new address. No native capture.
test('an edit of a confirmed contact email requires confirming the new address before signing in', async (t) => {
  const { app, browser, send, messages, contactId, setEmail } = await localSite(t, [
    ['Authentication/Registration/RequiresConfirmation', 'true'],
  ]);
  const credentials = { UserName: account.UserName, Password: 'Fixture-first-21' };
  assert.equal((await send(browser, register, { ...account, ...passwords(credentials.Password) })).status, 200);
  assert.equal((await browser.request((await messages('confirm'))[0].url)).status, 200);
  assert.equal((await send(browser, login, credentials)).status, 302);
  await signedInAs(browser, 'Fixture Account');
  assert.deepEqual(await messages('confirm'), []);
  await setEmail(contactId(account.Email), 'renamed@example.test');
  await signedInAs(browser, 'anonymous');
  const [confirmation] = await messages('confirm');
  assert.equal(confirmation.to, 'renamed@example.test');
  const refused = await send(client(app), login, credentials);
  assert.equal(refused.status, 403);
  assert.match(await refused.text(), /Confirm your email before signing in/);
  assert.equal((await messages('confirm'))[0].url, confirmation.url, 'a refused sign-in keeps the live link');
  assert.equal((await browser.request(confirmation.url)).status, 200);
  assert.equal((await send(browser, login, credentials)).status, 302);
  await signedInAs(browser, 'Fixture Account');
});
