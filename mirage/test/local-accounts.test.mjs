// @test-kind security+contract: loopback local account fixtures protect credentials, session renewal after credential changes and one-time challenges.
import assert from 'node:assert/strict';
import test from 'node:test';
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
