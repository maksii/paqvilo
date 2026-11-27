// @test-kind security+unproven: hardening of the local accounts beyond what hosted session F4 captured; each test names its evidence or assumption.
import assert from 'node:assert/strict';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import test from 'node:test';
import { fixedClock } from '../lib/runtime-clock.mjs';
import { hashPassword, verifyHashedPassword } from '../lib/identity-password-hash.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { workflowExtension } from '../lib/dataverse-workflows.mjs';
import { settleCommittedWork } from '../lib/committed-work.mjs';
import { client, decode, formBody, initialState, simulator } from './support/external-sign-in.mjs';
import { startAdminApi } from './support/web-api.mjs';

const NO_CAPTCHA = ['Authentication/Registration/CaptchaEnabled', 'false'];
const signIn = '/SignIn';
const register = '/Account/Login/Register';
const forgot = '/Account/Login/ForgotPassword';
const reset = '/Account/Login/ResetPassword';
const change = '/Account/Manage/ChangePassword';
const verify = '/Account/Login/VerifyCode';
const mailbox = '/_sim/api/local-accounts/messages';
const WF = 'ctl00$ctl00$ContentContainer$MainContent$MainContent$';
const LOCKED = 'The user account is currently locked. Please try again later.';
const TOO_MANY = 'Too many sign-in attempts. Please wait awhile and then try again.';
const account = { UserName: 'fixture-user', Email: 'fixture-user@example.test' };
const registration = ({ Email, UserName }, password) => ({
  [WF + 'EmailTextBox']: Email,
  [WF + 'UserNameTextBox']: UserName,
  [WF + 'PasswordTextBox']: password,
  [WF + 'ConfirmPasswordTextBox']: password,
});
const credentialsOf = (Username, PasswordValue) => ({ Username, PasswordValue });
const shows = async (response, message, status = 200) => {
  assert.equal(response.status, status, message);
  assert.ok(decode(await response.text()).includes(message), message);
};
const v2Hash = (password) => {
  const salt = randomBytes(16);
  return Buffer.concat([Buffer.from([0]), salt, pbkdf2Sync(password, salt, 1000, 32, 'sha1')]).toString('base64');
};

async function localSite(t, settings, state = initialState(), options = {}) {
  const { app, csrf } = await simulator(t, settings, state, { identityProvider: { localAccounts: true }, ...options });
  const send = async (owner, target, fields) =>
    owner.request(target, formBody({ __RequestVerificationToken: await owner.token(), ...fields }));
  const messages = async (kind) =>
    (await (await client(app).request(mailbox, { headers: { 'x-sim-csrf': csrf } })).json()).items.filter(
      (item) => item.kind === kind,
    );
  const contact = (id) => app.store.tableRows('contact').find((row) => row.contactid === id);
  const contactOf = (email) => app.store.tableRows('contact').find((row) => row.emailaddress1 === email);
  const session = async (owner) => (await owner.request('/_sim/api/session')).json();
  return { app, send, messages, contact, contactOf, session };
}

// @test-kind security+unproven: F4 captured invitation registration only for invited contacts without credentials; an invited contact that already has a local account is not taken over by an anonymous visitor who holds the code: registration answers "Invalid invitation code." (200) and the owner redeems through "I have an existing account".
test('local registration with an invitation never replaces the invited contact’s existing credentials', async (t) => {
  const ownerPassword = 'Fixture-owner-51';
  const state = initialState({
    tables: {
      adx_invitation: [
        {
          adx_invitationid: 'inv-existing',
          adx_name: 'inv-existing',
          adx_invitationcode: 'Existing-Code-G7',
          adx_type: 756150000,
          adx_expirydate: '2099-12-31',
          adx_invitecontact: { id: 'casey', logical_name: 'contact' },
          statecode: 0,
          statuscode: 756150000,
        },
      ],
    },
    mappings: {
      adx_invitation: { entitySet: 'adx_invitations', idColumn: 'adx_invitationid', nameColumn: 'adx_name' },
    },
  });
  const casey = state.tables.contact.find((row) => row.contactid === 'casey');
  Object.assign(casey, {
    adx_identity_username: 'casey-owner',
    adx_identity_passwordhash: hashPassword(ownerPassword),
    adx_identity_securitystamp: '0f0f0f0f-1111-4222-8333-444444444444',
  });
  const { app, send, contact, session } = await localSite(t, [NO_CAPTCHA], state);
  const before = structuredClone(contact('casey'));
  const attacker = client(app);
  const code = await send(attacker, '/Account/Login/RedeemInvitation', { InvitationCode: 'Existing-Code-G7' });
  assert.equal(code.status, 302);
  await shows(
    await send(
      attacker,
      code.headers.get('location'),
      registration({ Email: 'casey@example.test', UserName: 'attacker' }, 'Fixture-attacker-52'),
    ),
    'Invalid invitation code.',
  );
  assert.equal((await session(attacker)).signedIn, false);
  assert.deepEqual(
    ['adx_identity_username', 'adx_identity_passwordhash', 'adx_identity_securitystamp'].map(
      (name) => contact('casey')[name],
    ),
    ['casey-owner', before.adx_identity_passwordhash, before.adx_identity_securitystamp],
  );
  const invitation = app.store.tableRows('adx_invitation')[0];
  assert.deepEqual([invitation.statuscode, invitation.adx_redemptions ?? null], [756150000, null]);
  // The owner redeems the code by signing in.
  const owner = client(app);
  const redeemed = await send(
    owner,
    '/SignIn?InvitationCode=Existing-Code-G7',
    credentialsOf('casey-owner', ownerPassword),
  );
  assert.equal(redeemed.status, 302);
  assert.equal((await session(owner)).contactId, 'casey');
  assert.equal(app.store.tableRows('adx_invitation')[0].statuscode, 756150001);
});

const THROTTLING = [
  ['Authentication/LoginThrottling/MaxInvaildAttemptsFromIPAddress', '5'],
  ['Authentication/LoginThrottling/MaxAttemptsTimeLimitTimeSpan', '00:05:00'],
  ['Authentication/LoginThrottling/IpAddressTimeoutTimeSpan', '00:15:00'],
];

// @test-kind security+observation: the address throttle lets through no more than MaxInvaildAttemptsFromIPAddress invalid attempts however many arrive at once; the 409 refusal is the one in the raw captures accounts-a-cookies+lockout-1795759644048.json and accounts-b-lockout-1795764219201.json of hosted session F4 (steps wrong-password-6 onwards, hosted-f4 evidence folder).
test('parallel wrong passwords from one address cannot pass the throttle', async (t) => {
  const { app, send } = await localSite(t, [NO_CAPTCHA, ...THROTTLING]);
  assert.equal((await send(client(app), register, registration(account, 'Fixture-first-21'))).status, 302);
  const answers = await Promise.all(
    Array.from({ length: 40 }, () => send(client(app), signIn, credentialsOf('fixture-unknown', 'Fixture-wrong-1'))),
  );
  const statuses = answers.map((response) => response.status);
  await Promise.all(answers.map((response) => response.arrayBuffer()));
  assert.equal(statuses.filter((status) => status === 200).length, 5, statuses.join(','));
  assert.equal(statuses.filter((status) => status === 409).length, 35);
  await shows(await send(client(app), signIn, credentialsOf(account.UserName, 'Fixture-first-21')), TOO_MANY, 409);
});

// @test-kind unproven: F4 did not wait out the throttle windows: failures older than MaxAttemptsTimeLimitTimeSpan do not count, valid sign-ins do not count, and an address is refused for IpAddressTimeoutTimeSpan and then admitted again.
test('the address throttle forgets old failures and ends after its timeout', async (t) => {
  const clock = fixedClock();
  const { app, send } = await localSite(t, [NO_CAPTCHA, ...THROTTLING], initialState(), { clock });
  assert.equal((await send(client(app), register, registration(account, 'Fixture-first-21'))).status, 302);
  // Failures use an unknown name, so the account's own lockout plays no part.
  const attempt = (password) =>
    send(
      client(app),
      signIn,
      credentialsOf(password === 'Fixture-first-21' ? account.UserName : 'fixture-unknown', password),
    );
  for (let index = 0; index < 6; index++) assert.equal((await attempt('Fixture-first-21')).status, 302);
  for (let index = 0; index < 4; index++) await attempt('Fixture-wrong-2');
  clock.advance(5 * 60_000);
  await attempt('Fixture-wrong-2');
  assert.equal((await attempt('Fixture-first-21')).status, 302, 'the four older failures left the window');
  for (let index = 0; index < 4; index++) await attempt('Fixture-wrong-2');
  await shows(await attempt('Fixture-first-21'), TOO_MANY, 409);
  clock.advance(15 * 60_000 - 1);
  await shows(await attempt('Fixture-first-21'), TOO_MANY, 409);
  clock.advance(1);
  assert.equal((await attempt('Fixture-first-21')).status, 302);
});

// @test-kind security+observation: attempts 1 to 4 answer "Invalid sign-in attempt."; the fifth locks the account for a day (failure count back to 0) and the correct password is refused while locked (hosted session F4 AUTH-04g, two agreeing runs: accounts-a-cookies+lockout-1795759644048.json, accounts-b-lockout-1795764219201.json, hosted-f4 evidence folder).
test('five wrong passwords lock the account for a day', async (t) => {
  const clock = fixedClock();
  const { app, send, contactOf } = await localSite(t, [NO_CAPTCHA], initialState(), { clock });
  assert.equal((await send(client(app), register, registration(account, 'Fixture-first-21'))).status, 302);
  for (let attempt = 1; attempt <= 4; attempt++) {
    await shows(
      await send(client(app), signIn, credentialsOf(account.UserName, 'Fixture-wrong-1')),
      'Invalid sign-in attempt.',
    );
    assert.equal(contactOf(account.Email).adx_identity_accessfailedcount, attempt);
  }
  await shows(await send(client(app), signIn, credentialsOf(account.UserName, 'Fixture-wrong-1')), LOCKED);
  const locked = contactOf(account.Email);
  assert.equal(locked.adx_identity_accessfailedcount, 0);
  assert.equal(Date.parse(locked.adx_identity_lockoutenddate), clock.now() + 86_400_000);
  await shows(await send(client(app), signIn, credentialsOf(account.UserName, 'Fixture-first-21')), LOCKED);
});

// @test-kind security+unproven: F4 did not capture a reset or a password change during a lockout; Mirage fails closed: neither clears the lockout end or the failure count, and the new password signs in once the lockout has passed.
test('a password reset or change does not unlock a locked account', async (t) => {
  const clock = fixedClock();
  const { app, send, messages, contactOf } = await localSite(t, [NO_CAPTCHA], initialState(), { clock });
  const signedIn = client(app);
  assert.equal((await send(signedIn, register, registration(account, 'Fixture-first-21'))).status, 302);
  for (let attempt = 0; attempt < 5; attempt++)
    await send(client(app), signIn, credentialsOf(account.UserName, 'Fixture-wrong-1'));
  const lockedUntil = contactOf(account.Email).adx_identity_lockoutenddate;
  assert.ok(lockedUntil);

  const changed = await send(signedIn, change, {
    OldPassword: 'Fixture-first-21',
    NewPassword: 'Fixture-changed-23',
    ConfirmPassword: 'Fixture-changed-23',
  });
  assert.equal(changed.status, 302);
  assert.equal(contactOf(account.Email).adx_identity_lockoutenddate, lockedUntil);
  await shows(await send(client(app), signIn, credentialsOf(account.UserName, 'Fixture-changed-23')), LOCKED);

  await send(client(app), forgot, { Email: account.Email });
  const url = new URL((await messages('reset'))[0].url, app.url);
  const done = await send(client(app), reset, {
    UserId: url.searchParams.get('userId'),
    Code: url.searchParams.get('code'),
    Password: 'Fixture-reset-22',
    ConfirmPassword: 'Fixture-reset-22',
  });
  assert.equal(done.status, 302);
  assert.equal(contactOf(account.Email).adx_identity_lockoutenddate, lockedUntil);
  await shows(await send(client(app), signIn, credentialsOf(account.UserName, 'Fixture-reset-22')), LOCKED);
  clock.advance(86_400_001);
  assert.equal((await send(client(app), signIn, credentialsOf(account.UserName, 'Fixture-reset-22'))).status, 302);
});

// @test-kind security+unproven: a hosted ASP.NET Identity version 2 hash (68 characters, hosted session F4 accounts-{a,b}-register) signs in and is replaced by a version 3 hash without changing the security stamp, so the session stays valid and later checks pay the version 3 cost (the rehash on sign-in is ASP.NET Identity's SuccessRehashNeeded behaviour, not captured).
test('an imported version 2 hash is rehashed to version 3 on a successful sign-in', async (t) => {
  const state = initialState();
  const alex = state.tables.contact.find((row) => row.contactid === 'alex');
  const stamp = '1e1e1e1e-2222-4333-8444-555555555555';
  Object.assign(alex, {
    adx_identity_username: 'alex-imported',
    adx_identity_passwordhash: v2Hash('Fixture-imported-61'),
    adx_identity_securitystamp: stamp,
  });
  const { app, send, contact, session } = await localSite(t, [NO_CAPTCHA], state);
  await shows(
    await send(client(app), signIn, credentialsOf('alex-imported', 'Fixture-wrong-62')),
    'Invalid sign-in attempt.',
  );
  assert.equal(
    Buffer.from(contact('alex').adx_identity_passwordhash, 'base64')[0],
    0,
    'a failed sign-in keeps the hash',
  );
  const browser = client(app);
  assert.equal((await send(browser, signIn, credentialsOf('alex-imported', 'Fixture-imported-61'))).status, 302);
  const raw = Buffer.from(contact('alex').adx_identity_passwordhash, 'base64');
  assert.deepEqual([raw.length, raw[0], raw.readUInt32BE(5)], [61, 1, 100_000]);
  assert.ok(verifyHashedPassword(contact('alex').adx_identity_passwordhash, 'Fixture-imported-61'));
  assert.equal(contact('alex').adx_identity_securitystamp, stamp);
  assert.equal((await session(browser)).contactId, 'alex', 'the session stays valid');
  assert.equal((await send(client(app), signIn, credentialsOf('alex-imported', 'Fixture-imported-61'))).status, 302);
});

// @test-kind security+unproven: without the lockout (TriggerLockoutOnFailedPassword false) a pending email code still ends after five wrong codes, so the code cannot be guessed without a new password sign-in; not captured in F4.
test('a pending second factor ends after five wrong codes when the lockout is off', async (t) => {
  const { app, send, messages, contactOf, session } = await localSite(t, [
    NO_CAPTCHA,
    ['Authentication/Registration/TwoFactorEnabled', 'true'],
    ['Authentication/Registration/TriggerLockoutOnFailedPassword', 'false'],
  ]);
  const owner = client(app);
  assert.equal((await send(owner, register, registration(account, 'Fixture-first-21'))).status, 302);
  await owner.request('/Account/Manage/PostConfirmEmailRequest', {
    method: 'POST',
    headers: { __RequestVerificationToken: await owner.token() },
  });
  assert.equal((await owner.request((await messages('confirm'))[0].url)).status, 302);
  assert.equal((await send(owner, '/Account/Manage/EnableTFA', {})).status, 302);
  const browser = client(app);
  const pending = await send(browser, signIn, credentialsOf(account.UserName, 'Fixture-first-21'));
  assert.equal((await browser.request(pending.headers.get('location'))).status, 302);
  const [{ code }] = await messages('mfa');
  const wrong = code === '000000' ? '000001' : '000000';
  for (let attempt = 0; attempt < 5; attempt++)
    await shows(await send(browser, verify, { Code: wrong }), 'Invalid code.');
  assert.equal((await send(browser, verify, { Code: code })).status, 500, 'the pending sign-in has ended');
  assert.equal((await session(browser)).signedIn, false);
  assert.equal(contactOf(account.Email).adx_identity_accessfailedcount, 0, 'no lockout counting');
});

// @test-kind unproven: F4 saw a Send Invitation ExecuteWorkflow job owned by its caller and created by SYSTEM (invitation-send-{a,b}-single); Mirage applies the same to every on-demand background classic workflow, inferred from that one workflow.
test('an ExecuteWorkflow job of another background workflow is created by SYSTEM and owned by its caller', async (t) => {
  const WORKFLOW = '7b000000-0000-4000-8000-000000000001';
  const ROW = '7b000000-0000-4000-8000-000000000002';
  const state = emptyState();
  state.mappings.x_thing = {
    logicalName: 'x_thing',
    entitySet: 'x_things',
    idColumn: 'x_thingid',
    nameColumn: 'x_name',
    userConfigured: true,
    fields: { x_name: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.tables.x_thing = [{ x_thingid: ROW, x_name: 'Invented' }];
  const store = await new DataStore({ state }).init();
  const facts = [
    {
      id: WORKFLOW,
      name: 'Invented background',
      uniquename: null,
      category: 0,
      type: 1,
      mode: 0,
      scope: 4,
      ondemand: true,
      subprocess: false,
      triggeroncreate: false,
      triggerondelete: false,
      triggeronupdateattributelist: null,
      primaryentity: 'x_thing',
      state: 1,
      runas: 1,
      istransacted: true,
      asyncautodelete: false,
      syncworkflowlogonfailure: false,
      xaml: null,
      clientdata: null,
    },
  ];
  const handlers = new Map([[WORKFLOW, async () => ({ message: 'Invented run' })]]);
  const { request } = await startAdminApi(t, store, {
    extensions: [...EXTENSIONS, workflowExtension({ facts, handlers })],
  });
  const caller = (await request('GET', '/WhoAmI')).json.UserId;
  const started = await request('POST', `/workflows(${WORKFLOW})/Microsoft.Dynamics.CRM.ExecuteWorkflow`, {
    EntityId: ROW,
  });
  assert.equal(started.status, 200, JSON.stringify(started.json));
  await settleCommittedWork(store, []);
  const job = store.tableRows('asyncoperation').find((row) => row.asyncoperationid === started.json.asyncoperationid);
  const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM').systemuserid;
  assert.deepEqual([job.ownerid?.id, job.createdby?.id, job.statuscode], [caller, system, 30]);
});
