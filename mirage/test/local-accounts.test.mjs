// @test-kind security+contract: loopback local account fixtures protect credentials, session renewal after credential changes and one-time challenges.
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import { authCookieName } from '../lib/auth-session.mjs';
import { fixedClock } from '../lib/runtime-clock.mjs';
import { hashPassword, verifyHashedPassword } from '../lib/identity-password-hash.mjs';
import { createLocalAccounts, rememberedBrowserCookieName } from '../lib/local-accounts.mjs';
import { client, decode, formBody, hiddenFields, initialState, simulator } from './support/external-sign-in.mjs';

// Hosted session F4 (AUTH-04g, AUTH-05d, VERIFY-04b): two agreeing runs, raw captures in the hosted-f4 evidence folder.
const NO_CAPTCHA = ['Authentication/Registration/CaptchaEnabled', 'false'];
const SETTINGS = [
  NO_CAPTCHA,
  ['Authentication/Registration/RequiresConfirmation', 'true'],
  ['Authentication/Registration/TwoFactorEnabled', 'true'],
  ['Authentication/UserManager/MaxFailedAccessAttemptsBeforeLockout', '2'],
];
const signIn = '/SignIn';
const login = '/Account/Login/Login';
const register = '/Account/Login/Register';
const forgot = '/Account/Login/ForgotPassword';
const reset = '/Account/Login/ResetPassword';
const sendCode = '/Account/Login/SendCode';
const verify = '/Account/Login/VerifyCode';
const change = '/Account/Manage/ChangePassword';
const twoFactor = '/Account/Manage/ChangeTwoFactor';
const enableTwoFactor = '/Account/Manage/EnableTFA';
const confirmRequest = '/Account/Manage/ConfirmEmailRequest';
const postConfirm = '/Account/Manage/PostConfirmEmailRequest';
const mailbox = '/_sim/api/local-accounts/messages';
const mailboxPrefix = '/local-accounts/messages';
const statusPath = '/_sim/api/status';
const WF = 'ctl00$ctl00$ContentContainer$MainContent$MainContent$';
const account = { UserName: 'fixture-user', Email: 'fixture-user@example.test' };
const registration = ({ Email, UserName }, password, confirm = password) => ({
  [WF + 'EmailTextBox']: Email,
  [WF + 'UserNameTextBox']: UserName,
  [WF + 'PasswordTextBox']: password,
  [WF + 'ConfirmPasswordTextBox']: confirm,
});
const credentialsOf = (Username, PasswordValue) => ({ Username, PasswordValue });
const shows = async (response, message, status = 200) => {
  assert.equal(response.status, status, message);
  assert.ok(decode(await response.text()).includes(message), message);
};
const PROFILE_FILES = {
  'web-pages/profile/Profile.webpage.yml':
    'adx_webpageid: profile\nadx_name: Profile\nadx_partialurl: profile\nadx_parentpageid: home\nadx_pagetemplateid: main',
  'sitemarker.yml':
    '- adx_sitemarkerid: m-home\n  adx_name: Home\n  adx_pageid: home\n- adx_sitemarkerid: m-profile\n  adx_name: Profile\n  adx_pageid: profile',
};

async function localSite(t, settings, options = {}) {
  const { app, csrf } = await simulator(t, settings, initialState(), {
    identityProvider: { localAccounts: true },
    ...options,
  });
  const browser = client(app);
  const send = async (owner, target, fields) =>
    owner.request(target, formBody({ __RequestVerificationToken: await owner.token(), ...fields }));
  const messages = async (kind) => {
    const response = await client(app).request(mailbox, { headers: { 'x-sim-csrf': csrf } });
    assert.equal(response.status, 200);
    return (await response.json()).items.filter((item) => item.kind === kind);
  };
  const contactOf = (email) => app.store.tableRows('contact').find((row) => row.emailaddress1 === email);
  const setEmail = (id, emailaddress1) => app.store.update('contact', id, { emailaddress1 }, { admin: true });
  const linkFields = (message) => {
    const url = new URL(message.url, app.url);
    return { UserId: url.searchParams.get('userId'), Code: url.searchParams.get('code') };
  };
  const session = async (owner) => (await owner.request('/_sim/api/session')).json();
  return { app, csrf, browser, send, messages, contactOf, setEmail, linkFields, session };
}
const passwords = (value) => ({ Password: value, ConfirmPassword: value });
// The ASP.NET Identity version 3 header Mirage writes: 0x01, PRF 1 (HMAC-SHA256), 100,000 rounds, a 16-byte salt.
const assertIdentityV3 = (hash) => {
  const raw = Buffer.from(hash, 'base64');
  assert.equal(hash, raw.toString('base64'));
  assert.deepEqual(
    [raw.length, raw[0], raw.readUInt32BE(1), raw.readUInt32BE(5), raw.readUInt32BE(9)],
    [61, 1, 1, 100_000, 16],
  );
};
const signedInAs = async (owner, site, contactId) =>
  assert.equal((await site.session(owner)).contactId ?? null, contactId);

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
      signIn,
      formBody({
        ...credentialsOf('invented-missing-account', 'Synthetic-Password-71'),
        __RequestVerificationToken: value,
      }),
    );
  assert.equal((await submit(browser, app.portalToken)).status, 403);
  assert.equal((await submit(client(app), token)).status, 403);
  await shows(await submit(browser, token), 'Invalid sign-in attempt.');
});

// @test-kind security+observation: registration posts the WebForms controls, re-renders the platform's messages with 200, signs in at once without an email and keeps the credentials only as an ASP.NET Identity hash in the contact's Identity columns (Mirage writes version 3 where the hosted site writes version 2); confirmation is sent only by PostConfirmEmailRequest (hosted session F4 AUTH-04g, two agreeing runs: accounts-{a,b}-register, accounts-a-confirm, accounts-b-confirm+cookies+reset+mfaenable+mfa, digest-F4.json in hosted-f4). Security defaults stricter than hosted: a taken user name or address answers 409 without naming either, and the confirmation link is one time, each with a warning diagnostic naming the hosted behaviour.
test('local registration and email confirmation follow the platform pages', async (t) => {
  const site = await localSite(t, [NO_CAPTCHA], { files: PROFILE_FILES });
  const { app, browser, send, messages, contactOf } = site;
  const first = 'Fixture-first-21';
  const signInPage = await (await browser.request('/signin')).text();
  assert.match(signInPage, /href="\/Account\/Login\/Login\?ReturnUrl=/);
  assert.doesNotMatch(signInPage, /type="password"/, 'the shared sign-in page never carries a password field');
  const localPage = await browser.request(login);
  const localHtml = await localPage.text();
  // The site's sign-in path (Mirage's default casing; an observed LoginPath gives the hosted /SignIn).
  assert.match(localHtml, /<form method="post" action="\/signin">/);
  assert.match(localHtml, /name="Username"/);
  assert.match(localHtml, /name="PasswordValue" id="PasswordValue" type="password"/);
  assert.equal(localPage.headers.get('cache-control'), 'no-store');
  // A browser posts these forms with its Origin (no-referrer would make it null); only the origin leaves as a referrer.
  assert.equal(localPage.headers.get('referrer-policy'), 'strict-origin');
  assert.match(localPage.headers.get('content-security-policy'), /default-src 'none'/);
  const page = await (await browser.request(register)).text();
  for (const control of ['EmailTextBox', 'UserNameTextBox', 'PasswordTextBox', 'ConfirmPasswordTextBox'])
    assert.ok(page.includes(`name="${WF}${control}"`), control);
  assert.doesNotMatch(page, /LastName/);

  const before = app.store.tableRows('contact').length;
  for (const [fields, message] of [
    [
      registration({ Email: '', UserName: '' }, ''),
      'The Email field is required. Username is a required field. Password is a required field.',
    ],
    [registration(account, first, 'Fixture-other-22'), 'The password and confirmation password do not match.'],
    [
      registration(account, 'short'),
      'Passwords must be at least 8 characters. Passwords must contain characters from at least three of the following four classes: uppercase, lowercase, digit, and non-alphanumeric (special).',
    ],
    [
      registration(account, 'lowercase'),
      'Passwords must contain characters from at least three of the following four classes: uppercase, lowercase, digit, and non-alphanumeric (special).',
    ],
    [
      registration({ ...account, Email: 'not-an-address' }, first),
      'The Email field doesn’t contain a valid email address.',
    ],
  ])
    await shows(await send(browser, register, fields), message);
  assert.equal(app.store.tableRows('contact').length, before);

  const registered = await send(browser, register, registration(account, first));
  assert.equal(registered.status, 302);
  assert.equal(registered.headers.get('location'), '/profile/');
  const row = contactOf(account.Email);
  await signedInAs(browser, site, row.contactid);
  assert.deepEqual(await messages('confirm'), [], 'registration sends no email');
  assert.equal(row.adx_identity_username, account.UserName);
  assertIdentityV3(row.adx_identity_passwordhash);
  assert.match(row.adx_identity_securitystamp, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(
    [
      row.adx_identity_emailaddress1confirmed,
      row.adx_identity_twofactorenabled,
      row.adx_identity_lockoutenabled,
      row.adx_identity_accessfailedcount,
      row.adx_identity_logonenabled,
    ],
    [false, false, true, 0, true],
  );
  assert.equal(row.lastname ?? null, null);
  assert.ok(verifyHashedPassword(row.adx_identity_passwordhash, first));
  assert.doesNotMatch(JSON.stringify(app.store.snapshot()), /Fixture-first-21/);

  await browser.request('/Account/Login/LogOff');
  const visitor = client(app);
  // By default a taken user name or address gets one answer that names neither (hosted names them: see below).
  for (const taken of [
    registration({ ...account, Email: 'other@example.test' }, first),
    registration({ ...account, UserName: 'other-user' }, first),
  ]) {
    const refused = await send(visitor, register, taken);
    const text = decode(await refused.text());
    assert.equal(refused.status, 409);
    assert.ok(text.includes('These details cannot be used for local registration.'));
    assert.doesNotMatch(text, /already taken|"fixture-user"/);
  }
  assert.equal(app.store.tableRows('contact').length, before + 1);

  // Signing in without a return URL opens the profile page.
  const signedIn = await send(browser, signIn, credentialsOf(account.UserName, first));
  assert.equal(signedIn.status, 302);
  assert.equal(signedIn.headers.get('location'), '/profile/');
  await shows(await browser.request(confirmRequest), 'Check your email for confirmation instructions.');
  assert.deepEqual(await messages('confirm'), [], 'the request page sends nothing');
  const requested = await browser.request(postConfirm, {
    method: 'POST',
    headers: { __RequestVerificationToken: await browser.token() },
  });
  assert.equal(requested.status, 200);
  const [confirmation] = await messages('confirm');
  assert.equal(confirmation.subject, 'Confirm your account');
  assert.equal(confirmation.to, account.Email);
  assert.match(confirmation.url, new RegExp(`^/Account/Manage/ConfirmEmail\\?userId=${row.contactid}&code=[\\w%-]+$`));
  assert.ok(confirmation.body.includes(new URL(confirmation.url, app.url).href.replaceAll('&', '&amp;')));
  const opened = await client(app).request(confirmation.url);
  assert.equal(opened.status, 302);
  assert.equal(opened.headers.get('location'), '/profile/?Message=ConfirmEmailSuccess');
  assert.equal(contactOf(account.Email).adx_identity_emailaddress1confirmed, true);
  // By default the link is one time (hosted reuses it: see below); the mailbox no longer holds it.
  assert.equal((await client(app).request(confirmation.url)).status, 403, 'the link is one time');
  assert.deepEqual(await messages('confirm'), []);
  const { diagnostics } = await (
    await client(app).request('/_sim/api/diagnostics', { headers: { 'x-sim-csrf': site.csrf } })
  ).json();
  for (const code of ['LOCAL_ACCOUNT_DUPLICATE_HOSTED_MESSAGES', 'LOCAL_ACCOUNT_CONFIRMATION_HOSTED_REUSE'])
    assert.equal(diagnostics.filter((item) => item.code === code && item.severity === 'warning').length, 1, code);
  const anonymousManage = await client(app).request(change);
  assert.equal(anonymousManage.status, 302);
  assert.equal(anonymousManage.headers.get('location'), '/signin?ReturnUrl=/Account/Manage/ChangePassword');
});

// @test-kind security+observation: hosted session F4 AUTH-04g (two agreeing runs: accounts-{a,b}-register, accounts-a-confirm, accounts-b-confirm+cookies+reset+mfaenable+mfa, digest-F4.json in hosted-f4): duplicate registration answers 200 `The username "x" is already taken.` and `The email "x" is already taken.`, and the confirmation link is reusable; Mirage reproduces both only with observed.registrationDuplicateMessages named and observed.confirmationLinkReuse reusable, and then reports neither warning.
test('observed settings reproduce the hosted duplicate messages and the reusable confirmation link', async (t) => {
  const site = await localSite(t, [NO_CAPTCHA], {
    files: PROFILE_FILES,
    observed: {
      registrationDuplicateMessages: 'named',
      confirmationLinkReuse: 'reusable',
      evidence: 'Invented loopback observation',
    },
  });
  const { app, browser, send, messages, contactOf } = site;
  const password = 'Fixture-first-21';
  assert.equal((await send(browser, register, registration(account, password))).status, 302);
  const before = app.store.tableRows('contact').length;
  await browser.request('/Account/Login/LogOff');
  const visitor = client(app);
  await shows(
    await send(visitor, register, registration({ ...account, Email: 'other@example.test' }, password)),
    'The username "fixture-user" is already taken.',
  );
  await shows(
    await send(visitor, register, registration({ ...account, UserName: 'other-user' }, password)),
    'The email "fixture-user@example.test" is already taken.',
  );
  assert.equal(app.store.tableRows('contact').length, before);
  assert.equal((await send(browser, signIn, credentialsOf(account.UserName, password))).status, 302);
  await browser.request(postConfirm, {
    method: 'POST',
    headers: { __RequestVerificationToken: await browser.token() },
  });
  const [confirmation] = await messages('confirm');
  for (const attempt of ['first', 'again']) {
    const opened = await client(app).request(confirmation.url);
    assert.equal(opened.status, 302, attempt);
    assert.equal(opened.headers.get('location'), '/profile/?Message=ConfirmEmailSuccess');
  }
  assert.equal(contactOf(account.Email).adx_identity_emailaddress1confirmed, true);
  const { diagnostics } = await (
    await client(app).request('/_sim/api/diagnostics', { headers: { 'x-sim-csrf': site.csrf } })
  ).json();
  assert.ok(!diagnostics.some((item) => /^LOCAL_ACCOUNT_(DUPLICATE|CONFIRMATION)_HOSTED/.test(item.code)));
});

// @test-kind security+contract: the registration email shape stays `^[^\s@]+@[^\s@]+\.[^\s@]+$` checked in linear time,
// up to the 250-character limit: the adversarial dot runs (that pattern backtracked over them) answer as before
test('the registration email shape refuses and admits the same addresses, dot runs included', async (t) => {
  const { browser, send, app } = await localSite(t, [NO_CAPTCHA]);
  const before = app.store.tableRows('contact').length;
  const invalid = 'The Email field doesn’t contain a valid email address.';
  const dots = '.'.repeat(240);
  const page = async (Email) =>
    decode(
      await (await send(browser, register, registration({ ...account, Email }, 'Fixture-21x', 'Other-22x'))).text(),
    );
  for (const Email of ['a@b', 'a@b.', 'a@.b', '@b.c', 'a@b@c.d', 'a b@c.d', `a@${dots}@`, `a@b.${'c'.repeat(247)}`])
    assert.ok((await page(Email)).includes(invalid), Email.slice(0, 24));
  // The password mismatch answers these: the address itself is admitted.
  for (const Email of ['a@b.c', 'a@.b.c', 'a@b..', `a@${dots}`, `a@b${dots}c`])
    assert.ok(!(await page(Email)).includes(invalid), Email.slice(0, 24));
  assert.equal(app.store.tableRows('contact').length, before);
});

// @test-kind security+observation: recovery answers the same for known and unknown addresses; the reset link is single use; a password change re-signs the browser and ends the account's other sessions (hosted session F4 AUTH-04g and VERIFY-04b, two agreeing runs: accounts-{a,b}-*lockout*, accounts-a-reset, accounts-{a,b}-changepassword, digest-F4.json in hosted-f4).
test('lockout, password recovery and password change answer the platform messages', async (t) => {
  const clock = fixedClock();
  const site = await localSite(t, [NO_CAPTCHA], { clock });
  const { app, browser, send, messages, contactOf, linkFields } = site;
  const first = 'Fixture-first-21',
    second = 'Fixture-reset-22',
    third = 'Fixture-changed-23';
  assert.equal((await send(browser, register, registration(account, first))).status, 302);
  const id = contactOf(account.Email).contactid;

  const recovery = await browser.request(forgot);
  assert.ok(hiddenFields(await recovery.text()).__RequestVerificationToken);
  await shows(
    await send(client(app), forgot, { Email: 'nobody@example.test' }),
    'Please check your email to reset your password.',
  );
  assert.deepEqual(await messages('reset'), []);
  await shows(
    await send(client(app), forgot, { Email: account.Email }),
    'Please check your email to reset your password.',
  );
  const [resetMessage] = await messages('reset');
  assert.equal(resetMessage.subject, 'Password Reset');
  assert.match(resetMessage.url, new RegExp(`^/Account/Login/ResetPassword\\?userId=${id}&code=[\\w%-]+$`));
  const resetPage = await browser.request(resetMessage.url);
  assert.deepEqual(Object.keys(hiddenFields(await resetPage.text())).sort(), [
    'Code',
    'UserId',
    '__RequestVerificationToken',
  ]);
  const fields = linkFields(resetMessage);
  await shows(
    await send(browser, reset, { ...fields, Password: second, ConfirmPassword: first }),
    'The password and confirmation password do not match.',
  );
  const done = await send(browser, reset, { ...fields, ...passwords(second) });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/Account/Login/ResetPasswordConfirmation');
  await shows(await browser.request(done.headers.get('location')), 'Your password has been reset.');
  await shows(await send(browser, reset, { ...fields, ...passwords(first) }), 'Invalid token.');
  await signedInAs(browser, site, null);
  await shows(await send(browser, signIn, credentialsOf(account.UserName, first)), 'Invalid sign-in attempt.');

  const other = client(app);
  assert.equal((await send(other, signIn, credentialsOf(account.UserName, second))).status, 302);
  assert.equal((await send(browser, signIn, credentialsOf(account.UserName, second))).status, 302);
  const form = await (await browser.request(change)).text();
  assert.match(form, /name="Username" id="Username" type="text" value="fixture-user" readonly/);
  for (const name of ['OldPassword', 'NewPassword', 'ConfirmPassword'])
    assert.match(form, new RegExp(`name="${name}"`));
  const changed = await send(browser, change, { OldPassword: second, NewPassword: third, ConfirmPassword: third });
  assert.equal(changed.status, 302);
  assert.equal(changed.headers.get('location'), '/?Message=ChangePasswordSuccess');
  await signedInAs(browser, site, id);
  await signedInAs(other, site, null);
});

// @test-kind unproven+security: F4 did not capture a wrong current password on Change password; Mirage answers ASP.NET Identity's "Incorrect password." on the page and keeps the password. DisableTFA, the counterpart of the captured EnableTFA, turns two-factor sign-in off and re-signs the browser; F4 did not capture it.
test('a wrong current password and DisableTFA answer as the uncaptured local model', async (t) => {
  const site = await localSite(t, [NO_CAPTCHA, ['Authentication/Registration/TwoFactorEnabled', 'true']]);
  const { app, browser, send, messages, contactOf } = site;
  const password = 'Fixture-first-21';
  assert.equal((await send(browser, register, registration(account, password))).status, 302);
  await shows(
    await send(browser, change, {
      OldPassword: 'Fixture-bad-1',
      NewPassword: 'Fixture-next-22',
      ConfirmPassword: 'Fixture-next-22',
    }),
    'Incorrect password.',
  );
  assert.ok(verifyHashedPassword(contactOf(account.Email).adx_identity_passwordhash, password));
  await browser.request(postConfirm, {
    method: 'POST',
    headers: { __RequestVerificationToken: await browser.token() },
  });
  assert.equal((await browser.request((await messages('confirm'))[0].url)).status, 302);
  assert.equal((await send(browser, enableTwoFactor, {})).status, 302);
  assert.match(await (await browser.request(twoFactor)).text(), /action="\/Account\/Manage\/DisableTFA"/);
  const disabled = await send(browser, '/Account/Manage/DisableTFA', {});
  assert.equal(disabled.status, 302);
  assert.equal(disabled.headers.get('location'), '/?Message=DisableTwoFactorSuccess');
  assert.equal(contactOf(account.Email).adx_identity_twofactorenabled, false);
  await signedInAs(browser, site, contactOf(account.Email).contactid);
  const again = await send(client(app), signIn, credentialsOf(account.UserName, password));
  assert.equal(again.headers.get('location'), '/', 'no second factor after DisableTFA');
});

// @test-kind security+observation: with TwoFactorEnabled and a confirmed address, EnableTFA turns on email codes; the sign-in goes through SendCode to VerifyCode, the "Security Code" message carries six digits, a wrong code answers "Invalid code." and counts toward the lockout, and RememberBrowser lets the next sign-in skip the code (hosted session F4 AUTH-04g, two agreeing runs: accounts-a-mfaenable+mfa, accounts-b-confirm+cookies+reset+mfaenable+mfa, pages-{a,b} for SendCode/VerifyCode without context, digest-F4.json in hosted-f4).
test('email two-factor sign-in follows SendCode and VerifyCode with a remembered browser', async (t) => {
  const site = await localSite(t, [NO_CAPTCHA, ['Authentication/Registration/TwoFactorEnabled', 'true']]);
  const { app, browser, send, messages, contactOf } = site;
  const password = 'Fixture-first-21';
  assert.equal((await send(browser, register, registration(account, password))).status, 302);
  const id = contactOf(account.Email).contactid;
  await shows(await browser.request(twoFactor), 'An eligible local account session is required.', 403);
  await browser.request(postConfirm, {
    method: 'POST',
    headers: { __RequestVerificationToken: await browser.token() },
  });
  assert.equal((await browser.request((await messages('confirm'))[0].url)).status, 302);
  const twoFactorPage = await browser.request(twoFactor);
  const pageHtml = await twoFactorPage.text();
  assert.match(pageHtml, /Enable Two-factor authentication is currently disabled\./);
  assert.match(pageHtml, /action="\/Account\/Manage\/EnableTFA"/);
  const enabled = await send(browser, enableTwoFactor, {});
  assert.equal(enabled.status, 302);
  assert.equal(enabled.headers.get('location'), '/?Message=EnableTwoFactorSuccess');
  assert.equal(contactOf(account.Email).adx_identity_twofactorenabled, true);
  await signedInAs(browser, site, id);

  for (const target of [sendCode, verify]) assert.equal((await client(app).request(target)).status, 500, target);
  const fresh = client(app);
  const pending = await send(fresh, signIn, credentialsOf(account.UserName, password));
  assert.equal(pending.status, 302);
  assert.equal(pending.headers.get('location'), '/Account/Login/SendCode?RememberMe=False');
  await signedInAs(fresh, site, null);
  assert.deepEqual(await messages('mfa'), [], 'the code is sent by SendCode');
  const sent = await fresh.request(pending.headers.get('location'));
  assert.equal(sent.status, 302);
  assert.equal(sent.headers.get('location'), '/Account/Login/VerifyCode?Provider=EmailCode&RememberMe=False');
  const [message] = await messages('mfa');
  assert.equal(message.subject, 'Security Code');
  assert.match(message.code, /^\d{6}$/);
  assert.ok(message.body.includes(message.code));
  const verifyPage = await (await fresh.request(sent.headers.get('location'))).text();
  assert.match(verifyPage, /name="Code"/);
  assert.match(verifyPage, /name="RememberBrowser" id="RememberBrowser" type="checkbox"/);
  assert.equal((await send(client(app), verify, { Code: message.code })).status, 500, 'another browser has no context');
  await shows(await send(fresh, verify, { Code: message.code === '000000' ? '000001' : '000000' }), 'Invalid code.');
  assert.equal(contactOf(account.Email).adx_identity_accessfailedcount, 1, 'a wrong code counts toward the lockout');
  const verified = await send(fresh, verify, { Code: message.code, RememberBrowser: 'true' });
  assert.equal(verified.status, 302);
  await signedInAs(fresh, site, id);
  assert.equal(contactOf(account.Email).adx_identity_accessfailedcount, 0);
  assert.equal((await send(fresh, verify, { Code: message.code })).status, 500, 'the code is consumed once');
  await fresh.request('/Account/Login/LogOff');
  const remembered = await send(fresh, signIn, credentialsOf(account.UserName, password));
  assert.equal(remembered.status, 302);
  assert.equal(remembered.headers.get('location'), '/', 'the remembered browser skips the code');
  await signedInAs(fresh, site, id);
});

// @test-kind security+observation: Authentication/LoginThrottling refuses every sign-in from an address with 409 once it made MaxInvaildAttemptsFromIPAddress invalid attempts within MaxAttemptsTimeLimitTimeSpan, for IpAddressTimeoutTimeSpan and for any account, and clearing an account's lockout does not lift it (hosted session F4 AUTH-04g, two agreeing runs; the 409 status is in the raw captures accounts-a-cookies+lockout-1795759644048.json and accounts-b-lockout-1795764219201.json, steps wrong-password-6 to right-password-after-unlock, in the hosted-f4 evidence folder; summary-F4.md omits it).
test('sign-in throttling by address follows the shipped LoginThrottling settings', async (t) => {
  const clock = fixedClock();
  const throttling = [
    ['Authentication/LoginThrottling/MaxInvaildAttemptsFromIPAddress', '5'],
    ['Authentication/LoginThrottling/MaxAttemptsTimeLimitTimeSpan', '00:05:00'],
    ['Authentication/LoginThrottling/IpAddressTimeoutTimeSpan', '00:15:00'],
  ];
  const site = await localSite(t, [NO_CAPTCHA, ...throttling], { clock });
  const { app, send, contactOf } = site;
  const other = { UserName: 'fixture-other', Email: 'fixture-other@example.test' };
  assert.equal((await send(client(app), register, registration(account, 'Fixture-first-21'))).status, 302);
  assert.equal((await send(client(app), register, registration(other, 'Fixture-other-24'))).status, 302);
  const attempt = (name, password) => send(client(app), signIn, credentialsOf(name, password));
  for (let index = 1; index <= 4; index++)
    await shows(await attempt(account.UserName, 'Fixture-wrong-1'), 'Invalid sign-in attempt.');
  await shows(
    await attempt(account.UserName, 'Fixture-wrong-1'),
    'The user account is currently locked. Please try again later.',
  );
  const tooMany = 'Too many sign-in attempts. Please wait awhile and then try again.';
  await shows(await attempt(account.UserName, 'Fixture-wrong-1'), tooMany, 409);
  await shows(await attempt(other.UserName, 'Fixture-other-24'), tooMany, 409);
  await shows(await attempt('fixture-unknown', 'Fixture-other-24'), tooMany, 409);
  const id = contactOf(account.Email).contactid;
  await app.store.update(
    'contact',
    id,
    { adx_identity_lockoutenddate: null, adx_identity_accessfailedcount: 0 },
    { admin: true },
  );
  await shows(await attempt(account.UserName, 'Fixture-first-21'), tooMany, 409);
  clock.advance(15 * 60_000);
  assert.equal((await attempt(other.UserName, 'Fixture-other-24')).status, 302);

  const unthrottled = await localSite(t, [NO_CAPTCHA]);
  assert.equal(
    (await unthrottled.send(client(unthrottled.app), register, registration(account, 'Fixture-first-21'))).status,
    302,
  );
  for (let index = 0; index < 7; index++)
    await shows(
      await unthrottled.send(client(unthrottled.app), signIn, credentialsOf('fixture-unknown', 'Fixture-wrong-3')),
      'Invalid sign-in attempt.',
    );
  assert.equal(
    (await unthrottled.send(client(unthrottled.app), signIn, credentialsOf(account.UserName, 'Fixture-first-21')))
      .status,
    302,
    'without the setting no address is throttled',
  );
});

// @test-kind observation: /register/?invitation= prefills the code, a valid code opens the local registration page that redeems it into the invited contact (no new contact, adx_inviteredemption with the user name), codes match case-insensitively, refused codes answer "Invalid invitation code." with 200, a group code is refused at local registration and "I have an existing account" redeems for the contact who signs in (hosted session F4 AUTH-05d, two agreeing runs: redeem-{a,b}-{lower,group,group0,groupnomax,expired,inactive,single,bylogin}-*, invitation-send-{a,b}-single, digest-F4.json in hosted-f4).
test('invitation codes redeem through local registration and local sign-in', async (t) => {
  const invitation = (id, code, extra = {}) => ({
    adx_invitationid: id,
    adx_name: id,
    adx_invitationcode: code,
    adx_type: 756150000,
    adx_expirydate: '2099-12-31',
    statecode: 0,
    statuscode: 756150000,
    ...extra,
  });
  const invitations = [
    invitation('inv-single', 'Welcome-Code-A1', { adx_invitecontact: { id: 'casey', logical_name: 'contact' } }),
    invitation('inv-by-login', 'By-Login-B2', { adx_invitecontact: { id: 'blair', logical_name: 'contact' } }),
    invitation('inv-expired', 'Expired-C3', {
      adx_invitecontact: { id: 'blair', logical_name: 'contact' },
      adx_expirydate: '2020-01-01',
    }),
    invitation('inv-inactive', 'Inactive-D4', {
      adx_invitecontact: { id: 'blair', logical_name: 'contact' },
      statecode: 1,
      statuscode: 2,
    }),
    invitation('inv-group', 'Team-E5', { adx_type: 756150001, adx_maximumredemptions: 2, statuscode: 1 }),
  ];
  const state = initialState({
    tables: { adx_invitation: invitations },
    mappings: {
      adx_invitation: { entitySet: 'adx_invitations', idColumn: 'adx_invitationid', nameColumn: 'adx_name' },
    },
  });
  const { app, csrf } = await simulator(t, [NO_CAPTCHA], state, { identityProvider: { localAccounts: true } });
  const send = async (owner, target, fields) =>
    owner.request(target, formBody({ __RequestVerificationToken: await owner.token(), ...fields }));
  const row = (id) => app.store.tableRows('adx_invitation').find((item) => item.adx_invitationid === id);
  const contact = (id) => app.store.tableRows('contact').find((item) => item.contactid === id);
  const redemptions = () =>
    app.store.tableRows('adx_inviteredemption').map((item) => [item.subject, item.regardingobjectid?.id]);
  const session = async (owner) => (await owner.request('/_sim/api/session')).json();
  const contacts = app.store.tableRows('contact').length;
  const browser = client(app);
  const opened = await browser.request('/register/?returnurl=/&invitation=Welcome-Code-A1');
  assert.equal(opened.status, 200);
  const openedHtml = await opened.text();
  assert.match(openedHtml, /name="InvitationCode" type="text" value="Welcome-Code-A1"/);
  assert.match(openedHtml, /name="RedeemByLogin" type="checkbox" value="true"> I have an existing account/);
  const code = await send(browser, '/Account/Login/RedeemInvitation?ReturnUrl=%2F', {
    InvitationCode: 'welcome-code-a1',
  });
  assert.equal(code.status, 302);
  assert.equal(code.headers.get('location'), '/Account/Login/Register?returnUrl=/&invitationCode=welcome-code-a1');
  const registerPage = await browser.request(code.headers.get('location'));
  const registerHtml = await registerPage.text();
  assert.match(registerHtml, /Redeeming code: welcome-code-a1/);
  assert.match(
    registerHtml,
    new RegExp(`name="${WF.replaceAll('$', '\\$')}EmailTextBox"[^>]+value="casey@example.test"`),
  );
  const redeemed = await send(
    browser,
    code.headers.get('location'),
    registration({ Email: 'casey@example.test', UserName: 'casey-local' }, 'Fixture-casey-31'),
  );
  assert.equal(redeemed.status, 302);
  assert.equal((await session(browser)).contactId, 'casey');
  assert.equal(app.store.tableRows('contact').length, contacts, 'the invited contact becomes the account');
  assert.equal(contact('casey').adx_identity_username, 'casey-local');
  assert.deepEqual(
    [row('inv-single').statuscode, row('inv-single').adx_redemptions, row('inv-single').adx_redeemedcontact?.id],
    [756150001, 1, 'casey'],
  );
  assert.deepEqual(redemptions(), [['casey-local', 'inv-single']]);

  for (const refused of ['Welcome-Code-A1', 'Expired-C3', 'Inactive-D4', 'No-Such-Code']) {
    const answer = await send(client(app), '/Account/Login/RedeemInvitation', { InvitationCode: refused });
    await shows(answer, 'Invalid invitation code.');
  }

  const groupBrowser = client(app);
  const group = await send(groupBrowser, '/Account/Login/RedeemInvitation', { InvitationCode: 'Team-E5' });
  assert.equal(group.status, 302);
  const groupAnswer = await send(
    groupBrowser,
    group.headers.get('location'),
    registration({ Email: 'team-member@example.test', UserName: 'team-member' }, 'Fixture-team-32'),
  );
  assert.equal(groupAnswer.status, 200);
  const groupText = await groupAnswer.text();
  assert.match(groupText, /Redeeming code: Team-E5/);
  assert.match(groupText, /Invalid invitation code\./);
  assert.deepEqual([row('inv-group').statuscode, row('inv-group').adx_redemptions ?? null], [1, null]);
  assert.equal(app.store.tableRows('contact').length, contacts, 'a refused group code creates no contact');
  assert.equal((await session(groupBrowser)).signedIn, false);

  // "I have an existing account": the local sign-in redeems the code for the contact who signs in.
  const existing = client(app);
  const byLogin = await existing.request(
    '/Account/Login/RedeemInvitation',
    formBody(
      new URLSearchParams([
        ['__RequestVerificationToken', await existing.token()],
        ['InvitationCode', 'By-Login-B2'],
        ['RedeemByLogin', 'true'],
        ['RedeemByLogin', 'false'],
      ]),
    ),
  );
  assert.equal(byLogin.status, 200);
  const byLoginHtml = await byLogin.text();
  assert.match(byLoginHtml, /Redeeming code: By-Login-B2/);
  assert.match(byLoginHtml, /<form method="post" action="\/signin\?InvitationCode=By-Login-B2">/);
  const signedIn = await send(
    existing,
    '/SignIn?InvitationCode=By-Login-B2',
    credentialsOf('casey-local', 'Fixture-casey-31'),
  );
  assert.equal(signedIn.status, 302);
  assert.equal((await session(existing)).contactId, 'casey');
  assert.deepEqual([row('inv-by-login').statuscode, row('inv-by-login').adx_redeemedcontact?.id], [756150001, 'casey']);
  assert.deepEqual(redemptions(), [
    ['casey-local', 'inv-single'],
    ['casey-local', 'inv-by-login'],
  ]);
  const { diagnostics } = await (
    await client(app).request('/_sim/api/diagnostics', { headers: { 'x-sim-csrf': csrf } })
  ).json();
  assert.ok(diagnostics.some((item) => item.code === 'INVITATION_INVALID' && /expired/.test(item.message)));
});

// @test-kind unproven: F4 captured the group refusal at local registration only; Mirage also refuses a group code on the "I have an existing account" sign-in, without signing in or changing the invitation.
test('a group invitation code is refused on the local sign-in that redeems codes', async (t) => {
  const group = {
    adx_invitationid: 'inv-group-login',
    adx_name: 'inv-group-login',
    adx_invitationcode: 'Team-Login-F6',
    adx_type: 756150001,
    adx_maximumredemptions: 2,
    adx_expirydate: '2099-12-31',
    statecode: 0,
    statuscode: 1,
  };
  const state = initialState({
    tables: { adx_invitation: [group] },
    mappings: {
      adx_invitation: { entitySet: 'adx_invitations', idColumn: 'adx_invitationid', nameColumn: 'adx_name' },
    },
  });
  const { app } = await simulator(t, [NO_CAPTCHA], state, { identityProvider: { localAccounts: true } });
  const send = async (owner, target, fields) =>
    owner.request(target, formBody({ __RequestVerificationToken: await owner.token(), ...fields }));
  assert.equal((await send(client(app), register, registration(account, 'Fixture-first-21'))).status, 302);
  const browser = client(app);
  await shows(
    await send(browser, '/SignIn?InvitationCode=Team-Login-F6', credentialsOf(account.UserName, 'Fixture-first-21')),
    'Invalid invitation code.',
  );
  assert.equal((await (await browser.request('/_sim/api/session')).json()).signedIn, false);
  const row = app.store.tableRows('adx_invitation')[0];
  assert.deepEqual([row.statuscode, row.adx_redemptions ?? null], [1, null]);
});

// @test-kind security+compatibility: passwords are written only in the ASP.NET Identity version 3 format (0x01, PRF HMAC-SHA256, 100,000 rounds, 16-byte salt, 32-byte subkey), and the version 2 format a hosted site writes to adx_identity_passwordhash (hosted session F4 accounts-{a,b}-register: 68 characters; 0x00, 16-byte salt, PBKDF2-HMAC-SHA1 1000 rounds, 32-byte subkey) and other version 3 hashes verify.
test('password hashes are written in ASP.NET Identity version 3 and hosted version 2 hashes verify', () => {
  const hash = hashPassword('Fixture-hash-41');
  assertIdentityV3(hash);
  assert.notEqual(hashPassword('Fixture-hash-41'), hash, 'every hash has its own salt');
  assert.equal(verifyHashedPassword(hash, 'Fixture-hash-41'), true);
  assert.equal(verifyHashedPassword(hash, 'Fixture-hash-42'), false);
  const v2Salt = randomBytes(16);
  const v2 = Buffer.concat([
    Buffer.from([0]),
    v2Salt,
    pbkdf2Sync('Fixture-hash-41', v2Salt, 1000, 32, 'sha1'),
  ]).toString('base64');
  assert.equal(v2.length, 68, "the hosted site's 68-character format");
  assert.equal(verifyHashedPassword(v2, 'Fixture-hash-41'), true);
  assert.equal(verifyHashedPassword(v2, 'Fixture-hash-42'), false);
  const salt = randomBytes(16);
  const header = Buffer.alloc(13);
  header[0] = 1;
  header.writeUInt32BE(1, 1);
  header.writeUInt32BE(10_000, 5);
  header.writeUInt32BE(16, 9);
  const v3 = Buffer.concat([header, salt, pbkdf2Sync('Fixture-hash-41', salt, 10_000, 32, 'sha256')]).toString(
    'base64',
  );
  assert.equal(verifyHashedPassword(v3, 'Fixture-hash-41'), true);
  assert.equal(verifyHashedPassword(v3, 'Fixture-hash-42'), false);
  for (const invalid of ['', 'not-a-hash', null, Buffer.alloc(49, 2).toString('base64')])
    assert.equal(verifyHashedPassword(invalid, 'Fixture-hash-41'), false);
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
const sendLocal = async (app, browser, target, fields, csrf) =>
  browser.request(target, formBody({ __RequestVerificationToken: csrf ?? (await browser.token()), ...fields }));

async function authFormToken(browser, target) {
  const page = await browser.request(target);
  assert.equal(page.status, 200);
  return hiddenFields(await page.text()).__RequestVerificationToken;
}
const userOf = async (app, browser) => (await (await browser.request('/_sim/api/session')).json()).contactId;
// The pending second factor: the sign-in's SendCode step, after which the code is in the mailbox.
async function requestCode(browser, response) {
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /^\/Account\/Login\/SendCode\?RememberMe=(True|False)$/);
  const sent = await browser.request(response.headers.get('location'));
  assert.equal(sent.status, 302);
  return sent;
}

// @test-kind observation+security: hosted session F4 (paqvilo-developer hosted-f4 accounts cookies runs a and b) issued a remembered sign-in one persistent cookie expiring 24 hours later without ExpireTimeSpan; only a checked RememberMe of an enabled site persists a cookie.
test('remember-me uses the application cookie lifetime and an unchecked sign-in choice', async (t) => {
  for (const [settings, lifetime] of [
    [[NO_CAPTCHA, REMEMBER, EXPIRY, sliding('false')], 10_000],
    [[NO_CAPTCHA, ['Authentication/Registration/RememberMeEnabled', 'false'], EXPIRY, sliding('false')], null],
    [[NO_CAPTCHA, REMEMBER], 24 * 60 * 60 * 1000],
  ]) {
    const mayRemember = lifetime !== null;
    const clock = fixedClock();
    const { app } = await simulator(t, settings, initialState(), { clock, identityProvider: { localAccounts: true } });
    const browser = client(app);
    const loginPage = await browser.request(login);
    assert.equal(loginPage.status, 200);
    const checkbox = /<input[^>]+name="RememberMe"[^>]+type="checkbox"[^>]*>/.exec(await loginPage.text())?.[0];
    assert.equal(Boolean(checkbox), mayRemember, 'the checkbox follows RememberMeEnabled');
    assert.doesNotMatch(checkbox ?? '', /checked/i);
    const registered = await sendLocal(app, browser, register, {
      ...registration(account, REMEMBER_PASSWORD),
      RememberMe: 'true',
    });
    assert.equal(registered.status, 302);
    assert.equal(expiryAt(appCookie(app, registered)), undefined);
    const fields = credentialsOf(account.UserName, REMEMBER_PASSWORD);
    const unchecked = await sendLocal(app, client(app), signIn, fields);
    assert.equal(unchecked.status, 302);
    assert.equal(expiryAt(appCookie(app, unchecked)), undefined);
    // The platform's check box posts its true first and the hidden false after it.
    const chosen = await browser.request(
      signIn,
      formBody(
        new URLSearchParams([
          ['__RequestVerificationToken', await browser.token()],
          ['Username', fields.Username],
          ['PasswordValue', fields.PasswordValue],
          ['RememberMe', 'true'],
          ['RememberMe', 'false'],
        ]),
      ),
    );
    assert.equal(chosen.status, 302);
    assert.equal(
      expiryAt(appCookie(app, chosen)),
      mayRemember ? new Date(clock.now() + lifetime).toUTCString() : undefined,
    );
    if (lifetime !== 10_000) continue;
    const id = await userOf(app, browser);
    clock.advance(5001);
    const fixed = await browser.request('/');
    assert.equal(appCookie(app, fixed), undefined);
    assert.equal(await userOf(app, browser), id);
    clock.advance(4999);
    assert.equal(await userOf(app, browser), null);
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
  const credentials = credentialsOf(account.UserName, REMEMBER_PASSWORD);
  const registered = await send(registrationBrowser, register, registration(account, REMEMBER_PASSWORD));
  assert.equal(registered.status, 200);
  assert.equal((await registrationBrowser.request((await mailboxItem('confirm')).url)).status, 302);
  assert.equal((await send(registrationBrowser, signIn, credentials, login)).status, 302);
  assert.equal((await send(registrationBrowser, enableTwoFactor, {}, twoFactor)).status, 302);

  const browser = client(app);
  const pending = await send(browser, signIn, { ...credentials, RememberMe: 'true' }, login);
  assert.equal(pending.headers.get('location'), sendCode + '?RememberMe=True');
  assert.equal(appCookie(app, pending), undefined);
  const sent = await requestCode(browser, pending);
  clock.advance(2000);
  const verified = await send(browser, verify, { Code: (await mailboxItem('mfa')).code }, sent.headers.get('location'));
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
  assert.ok(await userOf(app, browser));
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
  assert.equal(await userOf(app, browser), null);

  const withNoIntent = client(app);
  const noIntent = await requestCode(withNoIntent, await send(withNoIntent, signIn, credentials, login));
  const postedAtMfa = await send(
    withNoIntent,
    verify,
    { Code: (await mailboxItem('mfa')).code, RememberMe: 'true' },
    noIntent.headers.get('location'),
  );
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
    const credentials = credentialsOf(profile.UserName, REMEMBER_PASSWORD);
    assert.equal((await send(browser, register, registration(profile, REMEMBER_PASSWORD))).status, 200);
    const confirm = (await messages()).find((message) => message.kind === 'confirm' && message.to === profile.Email);
    assert.equal((await browser.request(confirm.url)).status, 302);
    assert.equal((await send(browser, signIn, credentials)).status, 302);
    assert.equal((await send(browser, enableTwoFactor, {})).status, 302);
    return credentials;
  };
  const first = await setup(account);
  const second = await setup({ UserName: 'second-mfa-fixture', Email: 'second-mfa-fixture@example.test' });
  const startCode = async (browser, credentials) => {
    const response = await send(browser, signIn, credentials);
    assert.equal(appCookie(app, response), undefined);
    return requestCode(browser, response);
  };
  const verifyCode = async (browser, email, fields) => {
    const message = (await messages()).find((item) => item.kind === 'mfa' && item.to === email);
    return send(browser, verify, { Code: message.code, ...fields });
  };
  const logout = async (browser) => {
    const response = await browser.request('/Account/Login/LogOff');
    assert.equal(response.status, 302);
    assert.equal(marker(response), undefined);
    assert.equal(await userOf(app, browser), null);
  };
  const browser = client(app);
  await startCode(browser, first);
  const checkbox = /<input[^>]+name="RememberBrowser"[^>]+type="checkbox"[^>]*>/.exec(
    await (await browser.request(verify)).text(),
  )?.[0];
  assert.ok(checkbox, 'the authored setting enables the checkbox on MFA verification');
  assert.doesNotMatch(checkbox, /checked/i);
  const refused = await send(browser, verify, { Code: '', RememberBrowser: 'true' });
  assert.equal(refused.status, 200);
  assert.match(await refused.text(), /Invalid code\./);
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
  await shows(
    await send(browser, signIn, { ...first, PasswordValue: 'Fixture-incorrect-56' }),
    'Invalid sign-in attempt.',
  );
  assert.equal(await userOf(app, browser), null);

  const otherBrowser = client(app);
  await startCode(otherBrowser, first);
  const unchecked = await verifyCode(otherBrowser, account.Email, {});
  assert.equal(unchecked.status, 302);
  assert.equal(marker(unchecked), undefined);
  await logout(otherBrowser);
  await startCode(otherBrowser, first);
  await startCode(browser, second);

  clock.advance(86_400_000 - 1);
  const remembered = await send(browser, signIn, first);
  assert.equal(remembered.status, 302);
  assert.equal(remembered.headers.get('location'), '/');
  assert.ok(appCookie(app, remembered));
  assert.equal(marker(remembered), undefined, 'using a marker does not extend its deadline');
  await logout(browser);
  clock.advance(1);
  await startCode(browser, first);
  assert.ok(marker(await verifyCode(browser, account.Email, { RememberBrowser: 'true' })));

  const changed = await send(browser, change, {
    OldPassword: REMEMBER_PASSWORD,
    NewPassword: 'Fixture-next-81',
    ConfirmPassword: 'Fixture-next-81',
  });
  assert.equal(changed.status, 302);
  await logout(browser);
  await startCode(browser, { ...first, PasswordValue: 'Fixture-next-81' });
});

// @test-kind security+observation: credential routes stay opt-in; registration needs a CAPTCHA when CaptchaEnabled is absent (hosted session F4 AUTH-04g: pages-{a,b} show the image CAPTCHA on a new site), so without a local CAPTCHA fixture it is unavailable.
test('credential routes remain opt-in and honor disabled local sign-in and registration CAPTCHA', async (t) => {
  for (const settings of [[], [['Authentication/Registration/CaptchaEnabled', 'true']]]) {
    const { app } = await simulator(t, settings, initialState(), { identityProvider: { localAccounts: true } });
    assert.equal((await client(app).request(register)).status, 403);
  }
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

const registrationFields = (token, proof = {}, profile = account) => ({
  __RequestVerificationToken: token,
  ...registration(profile, 'Fixture-register-19'),
  ...proof,
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

// @test-kind unproven+security: the CAPTCHA proof is the local fixture's design; with RequiresConfirmation, registration waits for the confirmation ("Confirm your email before signing in."), which F4 did not capture.
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
  const send = async (owner, provided, profile) =>
    owner.request(register, formBody(registrationFields(await owner.token(), provided, profile)));

  const crossBrowser = await send(foreign, proof);
  assert.equal(crossBrowser.status, 200);
  assert.match(await crossBrowser.text(), /CAPTCHA answer is incorrect or expired/);
  assert.equal((await send(browser, { ...proof, __RequestVerificationToken: '' })).status, 403);
  assert.equal(app.store.snapshot().tables.contact.length, original);

  const accepted = await send(browser, proof);
  assert.equal(accepted.status, 200);
  assert.match(await accepted.text(), /Confirm your email before signing in/);
  assert.equal(app.store.snapshot().tables.contact.length, original + 1);
  const replay = await send(browser, proof, { UserName: 'other-fixture-account', Email: 'other-fixture@example.test' });
  assert.equal(replay.status, 200);
  assert.match(await replay.text(), /CAPTCHA answer is incorrect or expired/);
  assert.equal(app.store.snapshot().tables.contact.length, original + 1);
});

// @test-kind unproven+security: a failed registration write rolls back; the confirm-before-sign-in answer with RequiresConfirmation is not captured in F4.
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
  const submit = async (proof) => browser.request(register, formBody(registrationFields(await browser.token(), proof)));
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
  assert.match(await (await submit(proof)).text(), /CAPTCHA answer is incorrect or expired/);
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
    endpoints: [
      { path: login, method: 'POST', mode: 'live' },
      { path: signIn, method: 'POST', mode: 'live' },
    ],
  });
  const { app } = await simulator(t, SETTINGS, state, {
    identityProvider: { localAccounts: true },
    liveBridge,
    allowLiveWrites: true,
  });
  const browser = client(app);
  assert.equal(
    (await browser.request(reset + '?userId=fixture&code=fixture-reset-link')).headers.get('x-sim-route'),
    'local-account',
  );
  const credentials = formBody({
    __RequestVerificationToken: await browser.token(),
    ...credentialsOf('fixture-user', 'Fixture-password-12'),
  });
  await shows(await browser.request(signIn, credentials), 'Invalid sign-in attempt.');
  await shows(await browser.request(login, credentials), 'Invalid sign-in attempt.');
  assert.equal((await browser.request(login, { ...credentials, method: 'PUT' })).status, 405);
  assert.deepEqual(forwarded, []);
  assert.equal(await (await browser.request('/ordinary-live-page')).text(), 'fixture bridge');
  assert.deepEqual(forwarded, [['GET', '/ordinary-live-page']]);
});

// @test-kind unproven+security: an edit of emailaddress1 ends sessions and pending messages (they are bound to the address they were issued for) while the account keeps its password; recovery uses the contact's current address. No native capture.
test('an edit of the contact email ends sessions and pending links but keeps the account and recovery on the new address', async (t) => {
  const site = await localSite(t, [NO_CAPTCHA]);
  const { app, browser, send, messages, contactOf, setEmail, linkFields } = site;
  const first = 'Fixture-first-21';
  assert.equal((await send(browser, register, registration(account, first))).status, 302);
  const id = contactOf(account.Email).contactid;
  await signedInAs(browser, site, id);
  await shows(await send(browser, forgot, { Email: account.Email }), 'Please check your email to reset your password.');
  const [pendingReset] = await messages('reset');
  await setEmail(id, 'Renamed@Example.test');
  await signedInAs(browser, site, null);
  assert.deepEqual(await messages('reset'), [], 'the pending message ends with the old address');
  await shows(
    await send(browser, reset, { ...linkFields(pendingReset), ...passwords('Fixture-reset-22') }),
    'Invalid token.',
  );
  const again = client(app);
  assert.equal((await send(again, signIn, credentialsOf(account.UserName, first))).status, 302);
  await signedInAs(again, site, id);
  await signedInAs(browser, site, null);
  await send(browser, forgot, { Email: account.Email });
  assert.deepEqual(await messages('reset'), [], 'the previous address receives nothing');
  await send(browser, forgot, { Email: 'renamed@example.test' });
  const [resetMessage] = await messages('reset');
  assert.equal(resetMessage.to, 'renamed@example.test');
  const resetFields = { ...linkFields(resetMessage), ...passwords('Fixture-reset-22') };
  assert.equal((await send(browser, reset, resetFields)).status, 302);
  await shows(await send(client(app), signIn, credentialsOf(account.UserName, first)), 'Invalid sign-in attempt.');
  assert.equal((await send(client(app), signIn, credentialsOf(account.UserName, 'Fixture-reset-22'))).status, 302);
});

// @test-kind unproven+security: under LocalLoginByEmail the sign-in and recovery address is the contact's current email; an address two accounts share identifies neither.
test('email sign-in follows the current contact email and refuses an address shared by two accounts', async (t) => {
  const site = await localSite(t, [NO_CAPTCHA, ['Authentication/Registration/LocalLoginByEmail', 'true']]);
  const { app, browser, send, messages, contactOf, setEmail } = site;
  const second = { UserName: 'fixture-other', Email: 'fixture-other@example.test' };
  assert.equal((await send(browser, register, registration(account, 'Fixture-first-21'))).status, 302);
  assert.equal((await send(client(app), register, registration(second, 'Fixture-other-24'))).status, 302);
  const firstId = contactOf(account.Email).contactid,
    secondId = contactOf(second.Email).contactid;
  const login = (name, password) => send(client(app), signIn, credentialsOf(name, password));
  await setEmail(firstId, 'moved@example.test');
  await signedInAs(browser, site, null);
  await shows(await login(account.Email, 'Fixture-first-21'), 'Invalid sign-in attempt.');
  assert.equal((await login('moved@example.test', 'Fixture-first-21')).status, 302);

  await setEmail(secondId, 'moved@example.test');
  await shows(await login('moved@example.test', 'Fixture-first-21'), 'Invalid sign-in attempt.');
  await shows(await login('moved@example.test', 'Fixture-other-24'), 'Invalid sign-in attempt.');
  await shows(
    await send(browser, forgot, { Email: 'moved@example.test' }),
    'Please check your email to reset your password.',
  );
  assert.deepEqual(await messages('reset'), [], 'an ambiguous address issues no reset');

  await setEmail(secondId, second.Email);
  assert.equal((await login('moved@example.test', 'Fixture-first-21')).status, 302);
  await send(browser, forgot, { Email: 'moved@example.test' });
  assert.deepEqual(
    (await messages('reset')).map((item) => item.to),
    ['moved@example.test'],
  );
});

// @test-kind unproven+security: with RequiresConfirmation (confirm-before-sign-in, not captured in F4) a credential-stamp change or an expired link must not strand an unconfirmed account; a reissued link replaces only a stale one.
test('an unconfirmed account receives a new confirmation after a reset and after its link expires', async (t) => {
  const clock = fixedClock();
  const site = await localSite(t, [NO_CAPTCHA, ['Authentication/Registration/RequiresConfirmation', 'true']], {
    clock,
  });
  const { browser, send, messages, linkFields } = site;
  await shows(
    await send(browser, register, registration(account, 'Fixture-first-21')),
    'Confirm your email before signing in.',
  );
  const [original] = await messages('confirm');
  await send(browser, forgot, { Email: account.Email });
  const [resetMessage] = await messages('reset');
  const resetFields = { ...linkFields(resetMessage), ...passwords('Fixture-reset-22') };
  assert.equal((await send(browser, reset, resetFields)).status, 302);
  await shows(await browser.request(original.url), 'Invalid token.');
  const [reissued] = await messages('confirm');
  assert.notEqual(reissued.url, original.url);
  assert.equal((await browser.request(reissued.url)).status, 302);
  assert.equal((await send(browser, signIn, credentialsOf(account.UserName, 'Fixture-reset-22'))).status, 302);

  const other = { UserName: 'fixture-late', Email: 'fixture-late@example.test' };
  await shows(
    await send(client(site.app), register, registration(other, 'Fixture-late-25')),
    'Confirm your email before signing in.',
  );
  const lateLink = (await messages('confirm')).find((item) => item.to === other.Email);
  const credentials = credentialsOf(other.UserName, 'Fixture-late-25');
  await shows(await send(client(site.app), signIn, credentials), 'Confirm your email before signing in.');
  assert.equal(
    (await messages('confirm')).find((item) => item.to === other.Email).url,
    lateLink.url,
    'a live link is not replaced',
  );
  clock.advance(86_400_001);
  await shows(await browser.request(lateLink.url), 'Invalid token.');
  assert.deepEqual(await messages('confirm'), []);
  await shows(
    await send(client(site.app), signIn, { ...credentials, PasswordValue: 'Fixture-wrong-26' }),
    'Invalid sign-in attempt.',
  );
  assert.deepEqual(await messages('confirm'), [], 'a wrong password issues nothing');
  await shows(await send(client(site.app), signIn, credentials), 'Confirm your email before signing in.');
  const [fresh] = await messages('confirm');
  assert.equal(fresh.to, other.Email);
  assert.equal((await browser.request(fresh.url)).status, 302);
  assert.equal((await send(client(site.app), signIn, credentials)).status, 302);
});

// @test-kind security: wrong second-factor codes count toward the configured lockout like wrong passwords (Identity AccessFailed), and a lock refuses a pending code.
test('wrong email MFA codes share the password lockout and a lock refuses a pending code', async (t) => {
  const clock = fixedClock();
  const site = await localSite(t, SETTINGS, { clock });
  const { app, browser, send, messages } = site;
  const credentials = credentialsOf(account.UserName, 'Fixture-first-21');
  assert.equal((await send(browser, register, registration(account, credentials.PasswordValue))).status, 200);
  assert.equal((await browser.request((await messages('confirm'))[0].url)).status, 302);
  assert.equal((await send(browser, signIn, credentials)).status, 302);
  assert.equal((await send(browser, enableTwoFactor, {})).status, 302);
  const id = await userOf(app, browser);
  const code = async () => (await messages('mfa'))[0].code;
  const wrong = (value) => (value === '000000' ? '000001' : '000000');
  const pastLockout = 86_400_001;
  const startCode = async (owner) => requestCode(owner, await send(owner, signIn, credentials));

  const attacker = client(app);
  await startCode(attacker);
  await shows(await send(attacker, verify, { Code: wrong(await code()) }), 'Invalid code.');
  await startCode(attacker);
  const pendingCode = await code();
  await shows(
    await send(attacker, verify, { Code: wrong(pendingCode) }),
    'The user account is currently locked. Please try again later.',
  );
  assert.equal((await send(attacker, verify, { Code: pendingCode })).status, 500, 'the lock ends the challenge');
  await shows(
    await send(client(app), signIn, credentials),
    'The user account is currently locked. Please try again later.',
  );

  clock.advance(pastLockout);
  const pending = client(app);
  await startCode(pending);
  const heldCode = await code();
  for (const password of ['Fixture-wrong-1', 'Fixture-wrong-2'])
    await send(client(app), signIn, { ...credentials, PasswordValue: password });
  await shows(
    await send(pending, verify, { Code: heldCode }),
    'The user account is currently locked. Please try again later.',
  );
  assert.equal(await userOf(app, pending), null);

  clock.advance(pastLockout);
  await shows(
    await send(client(app), signIn, { ...credentials, PasswordValue: 'Fixture-wrong-3' }),
    'Invalid sign-in attempt.',
  );
  const owner = client(app);
  await startCode(owner);
  assert.equal((await send(owner, verify, { Code: await code() })).status, 302);
  assert.equal(await userOf(app, owner), id);
  await shows(
    await send(client(app), signIn, { ...credentials, PasswordValue: 'Fixture-wrong-4' }),
    'Invalid sign-in attempt.',
    200,
  );
});

// @test-kind security: an unknown or ambiguous sign-in name runs the same password verification as a known one, so the work done does not reveal which names exist.
test('a local sign-in for an unknown name verifies the password against a fixed Identity hash of the written cost', async () => {
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
  const fields = { __RequestVerificationToken: 'fixture-token', ...credentialsOf('missing-user', 'Fixture-wrong-9') };
  assert.equal(await accounts.route(post(fields), {}, new URL('http://127.0.0.1' + signIn)), true);
  assert.equal(await accounts.route(post(fields), {}, new URL('http://127.0.0.1' + login)), true);
  assert.deepEqual(rendered, [200, 200]);
  assert.equal(verified.length, 2);
  for (const [password, verifier] of verified) {
    assert.equal(password, 'Fixture-wrong-9');
    assertIdentityV3(verifier);
  }
  assert.equal(verified[0][1], verified[1][1], 'one verifier per runtime');
  assert.doesNotMatch(JSON.stringify(verified.map(([, verifier]) => verifier)), /Fixture-wrong-9/);
});

// @test-kind security: a sign-in completed by a remembered browser clears earlier failures, so other visitors' wrong passwords cannot accumulate across the owner's successful sign-ins into a lockout.
test('a remembered-browser sign-in clears failures between wrong passwords from other visitors', async (t) => {
  const site = await localSite(t, [
    ...SETTINGS.filter(([name]) => !name.endsWith('MaxFailedAccessAttemptsBeforeLockout')),
    ['Authentication/Registration/RememberBrowserEnabled', 'true'],
    ['Authentication/UserManager/MaxFailedAccessAttemptsBeforeLockout', '3'],
  ]);
  const { app, browser, send, messages } = site;
  const credentials = credentialsOf(account.UserName, 'Fixture-remember-27');
  assert.equal((await send(browser, register, registration(account, credentials.PasswordValue))).status, 200);
  assert.equal((await browser.request((await messages('confirm'))[0].url)).status, 302);
  assert.equal((await send(browser, signIn, credentials)).status, 302);
  assert.equal((await send(browser, enableTwoFactor, {})).status, 302);
  await browser.request('/Account/Login/LogOff');
  await requestCode(browser, await send(browser, signIn, credentials));
  const [{ code }] = await messages('mfa');
  assert.equal((await send(browser, verify, { Code: code, RememberBrowser: 'true' })).status, 302);
  await browser.request('/Account/Login/LogOff');
  const outcomes = [];
  for (let round = 0; round < 4; round++) {
    const wrong = await send(client(app), signIn, { ...credentials, PasswordValue: 'Fixture-wrong-28' });
    outcomes.push(decode(await wrong.text()).includes('Invalid sign-in attempt.') ? 'invalid' : 'other');
    const owner = await send(browser, signIn, credentials);
    outcomes.push(owner.status);
    assert.notEqual(
      owner.headers.get('location'),
      sendCode + '?RememberMe=False',
      'the remembered browser skips the code',
    );
    await browser.request('/Account/Login/LogOff');
  }
  assert.deepEqual(outcomes, ['invalid', 302, 'invalid', 302, 'invalid', 302, 'invalid', 302]);
});

// @test-kind unproven+security: an edit of emailaddress1 is modelled on Identity's SetEmail, which also clears the confirmed state; with RequiresConfirmation the account signs in again only after confirming the new address. No native capture.
test('an edit of a confirmed contact email requires confirming the new address before signing in', async (t) => {
  const site = await localSite(t, [NO_CAPTCHA, ['Authentication/Registration/RequiresConfirmation', 'true']]);
  const { app, browser, send, messages, contactOf, setEmail } = site;
  const credentials = credentialsOf(account.UserName, 'Fixture-first-21');
  assert.equal((await send(browser, register, registration(account, credentials.PasswordValue))).status, 200);
  const [first] = await messages('confirm');
  assert.equal((await browser.request(first.url)).status, 302);
  assert.equal((await send(browser, signIn, credentials)).status, 302);
  const id = contactOf(account.Email).contactid;
  await signedInAs(browser, site, id);
  assert.deepEqual(await messages('confirm'), [], 'a confirmed account receives no new link; the used one is gone');
  await setEmail(id, 'renamed@example.test');
  await signedInAs(browser, site, null);
  await shows(await send(client(app), signIn, credentials), 'Confirm your email before signing in.');
  assert.equal(contactOf('renamed@example.test').adx_identity_emailaddress1confirmed, false);
  const [confirmation] = await messages('confirm');
  assert.equal(confirmation.to, 'renamed@example.test');
  await shows(await send(client(app), signIn, credentials), 'Confirm your email before signing in.');
  assert.equal((await messages('confirm'))[0].url, confirmation.url, 'a refused sign-in keeps the live link');
  assert.equal((await browser.request(confirmation.url)).status, 302);
  assert.equal((await send(browser, signIn, credentials)).status, 302);
  await signedInAs(browser, site, id);
});
