// @test-kind security+contract: loopback local account fixtures protect credentials, session renewal after credential changes and one-time challenges.
import assert from 'node:assert/strict';
import test from 'node:test';
import { client, formBody, initialState, simulator } from './support/external-sign-in.mjs';

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
