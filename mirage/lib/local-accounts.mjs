import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createAuthSessions, parseCookies, returnUrlParameter, safeReturnUrl } from './auth-session.mjs';
import { sameToken } from './admin-origin.mjs';
import { authenticationSettings, timeSpanMs } from './external-login.mjs';
import { hashPassword, hashPasswordV2, identityVersion, verifyHashedPassword } from './identity-password-hash.mjs';
import { loginPath, servicePages, siteSetting } from './redirects.mjs';

// The platform's local account pages (hosted session F4 AUTH-04g). POST /SignIn (the site's sign-in path) is the local
// sign-in when it carries PasswordValue; the sign-in page's other posts go back to the host.
const ROUTES = Object.freeze({
  login: '/Account/Login/Login',
  register: '/Account/Login/Register',
  forgot: '/Account/Login/ForgotPassword',
  reset: '/Account/Login/ResetPassword',
  resetDone: '/Account/Login/ResetPasswordConfirmation',
  sendCode: '/Account/Login/SendCode',
  verify: '/Account/Login/VerifyCode',
  confirm: '/Account/Manage/ConfirmEmail',
  confirmRequest: '/Account/Manage/ConfirmEmailRequest',
  postConfirm: '/Account/Manage/PostConfirmEmailRequest',
  change: '/Account/Manage/ChangePassword',
  twoFactor: '/Account/Manage/ChangeTwoFactor',
  enableTwoFactor: '/Account/Manage/EnableTFA',
  disableTwoFactor: '/Account/Manage/DisableTFA',
});
// The ASP.NET Identity columns of the contact (hosted session F4: the account is the contact row).
const COLUMN = Object.freeze({
  username: 'adx_identity_username',
  passwordHash: 'adx_identity_passwordhash',
  securityStamp: 'adx_identity_securitystamp',
  emailConfirmed: 'adx_identity_emailaddress1confirmed',
  twoFactor: 'adx_identity_twofactorenabled',
  lockoutEnabled: 'adx_identity_lockoutenabled',
  lockoutEnd: 'adx_identity_lockoutenddate',
  accessFailed: 'adx_identity_accessfailedcount',
  logonEnabled: 'adx_identity_logonenabled',
});
// The registration page's WebForms control names.
const WEB_FORM = 'ctl00$ctl00$ContentContainer$MainContent$MainContent$';
const DAY = 86_400_000;
const MAX_ACCOUNTS = 2048;
// The registration page's email shape, `^[^\s@]+@[^\s@]+\.[^\s@]+$` checked in linear time: one `@` between a local part
// and a domain without whitespace, the domain holding a `.` that is neither its first nor its last character.
function plausibleEmail(text) {
  if (!/^[^\s@]+@[^\s@]+$/.test(text)) return false;
  const domain = text.slice(text.indexOf('@') + 1),
    dot = domain.indexOf('.', 1);
  return dot > 0 && dot < domain.length - 1;
}
const MAX_THROTTLED_ADDRESSES = 1024;
export const rememberedBrowserCookieName = (authName) => authName + '-remembered-browser';
// The platform's answers, re-rendered with 200 (hosted session F4 AUTH-04g) unless noted.
const MESSAGE = Object.freeze({
  invalidSignIn: 'Invalid sign-in attempt.',
  locked: 'The user account is currently locked. Please try again later.',
  // Answered with 409.
  throttled: 'Too many sign-in attempts. Please wait awhile and then try again.',
  mismatch: 'The password and confirmation password do not match.',
  invalidEmail: 'The Email field doesn’t contain a valid email address.',
  emailRequired: 'The Email field is required.',
  usernameRequired: 'Username is a required field.',
  passwordRequired: 'Password is a required field.',
  classes:
    'Passwords must contain characters from at least three of the following four classes: uppercase, lowercase, digit, and non-alphanumeric (special).',
  recoverySent: 'Please check your email to reset your password.',
  invalidToken: 'Invalid token.',
  resetDone: 'Your password has been reset.',
  invalidCode: 'Invalid code.',
  checkCode: 'Check your email for the security code.',
  confirmRequested: 'Check your email for confirmation instructions.',
  invalidInvitation: 'Invalid invitation code.',
  // ASP.NET Identity 2 resource strings (not observed in F4).
  incorrectPassword: 'Incorrect password.',
  confirmFirst: 'Confirm your email before signing in.',
});
// The platform's messages (Dataverse email activities on hosted sites; this runtime's mailbox here).
const MAIL = Object.freeze({
  confirm: {
    subject: 'Confirm your account',
    body: (link) =>
      `<p>Your account requires confirmation. Please click the following link to complete the registration.</p><p><a href="${escape(link)}">Complete Registration</a></p><p>Or you can copy the following URL and paste it into your web browser.</p><p>${escape(link)}</p>`,
  },
  reset: {
    subject: 'Password Reset',
    body: (link) =>
      `<p>A password reset was requested for your account. Please click the following link to start the password reset process.</p><p><a href="${escape(link)}">Reset Password</a></p><p>Or you can copy the following URL and paste it into your web browser.</p><p>${escape(link)}</p>`,
  },
  mfa: { subject: 'Security Code', body: (code) => `Your security code is: ${code}` },
});
function escape(value) {
  return String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}
const key = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();
const digest = (value) =>
  createHash('sha256')
    .update(String(value ?? ''))
    .digest('base64url');
const challengeToken = () => randomBytes(32).toString('base64url');
// A return URL in a query keeps its slashes, as the platform writes it (/profile/?ReturnUrl=/).
const queryValue = (value) => encodeURIComponent(value).replaceAll('%2F', '/');

function settingsFor(portal) {
  const value = (name) => siteSetting(portal, `Authentication/${name}`);
  const flag = (name, fallback = false) => {
    const text = key(value(name));
    return text === 'true' || (text !== 'false' && fallback);
  };
  const registration = (name, fallback) => flag(`Registration/${name}`, fallback);
  const policy = (name, fallback) => flag(`UserManager/PasswordValidator/${name}`, fallback);
  const integer = (name, fallback, max) => {
    const n = Number(value(name));
    return Number.isSafeInteger(n) && n > 0 ? Math.min(n, max) : fallback;
  };
  const auth = authenticationSettings(portal);
  // Address throttling (hosted session F4: a new site ships these settings, the attempt key misspelled as shown).
  const throttleAttempts = integer('LoginThrottling/MaxInvaildAttemptsFromIPAddress', null, 10_000);
  return {
    localLogin: auth.localLogin,
    registrationEnabled: auth.registration,
    registration:
      auth.registration && registration('OpenRegistrationEnabled', true) && !registration('RequiresInvitation'),
    invitation: auth.registration && auth.invitation,
    confirmation: registration('RequiresConfirmation'),
    // Hosted session F4: registration shows a CAPTCHA, remember me and remember browser are offered without the settings.
    captcha: registration('CaptchaEnabled', true),
    uniqueEmail: auth.requireUniqueEmail,
    emailLogin: registration('LocalLoginByEmail'),
    rememberMe: registration('RememberMeEnabled', true),
    rememberBrowser: registration('RememberBrowserEnabled', true),
    profileRedirect: registration('ProfileRedirectEnabled', true),
    reset: registration('ResetPasswordEnabled', true),
    resetConfirmed: registration('ResetPasswordRequiresConfirmedEmail'),
    twoFactor: registration('TwoFactorEnabled'),
    lockoutByDefault: flag('UserManager/UserLockoutEnabledByDefault', true),
    lockout:
      registration('TriggerLockoutOnFailedPassword', true) && flag('UserManager/UserLockoutEnabledByDefault', true),
    lockAfter: integer('UserManager/MaxFailedAccessAttemptsBeforeLockout', 5, 100),
    lockMs: timeSpanMs(value('UserManager/DefaultAccountLockoutTimeSpan')) ?? DAY,
    throttle: throttleAttempts && {
      attempts: throttleAttempts,
      windowMs: timeSpanMs(value('LoginThrottling/MaxAttemptsTimeLimitTimeSpan')) ?? 300_000,
      timeoutMs: timeSpanMs(value('LoginThrottling/IpAddressTimeoutTimeSpan')) ?? 900_000,
    },
    twoFactorMs: Math.min(timeSpanMs(value('TwoFactorCookie/ExpireTimeSpan')) ?? 300_000, 360_000),
    minimumLength: integer('UserManager/PasswordValidator/RequiredLength', 8, 256),
    defaultPolicy: policy('EnforcePasswordPolicy', true),
    upper: policy('RequireUppercase'),
    lower: policy('RequireLowercase'),
    digit: policy('RequireDigit'),
    special: policy('RequireNonLetterOrDigit'),
    alphaUser: flag('UserManager/UserValidator/AllowOnlyAlphanumericUserNames'),
    // Hosted behaviour more permissive than Mirage's defaults, reproduced only with an observation (hosted session F4
    // AUTH-04g): registration names a taken user name or address, and a confirmation link can be used again.
    namedDuplicates: portal?.observed?.registrationDuplicateMessages === 'named',
    reusableConfirmation: portal?.observed?.confirmationLinkReuse === 'reusable',
  };
}

// A registration refusal: the message the form shows again, with the response status.
const refused = (message, status = 200) => ({ message, status });

function registrationProblems(read, flags) {
  const email = read(WEB_FORM + 'EmailTextBox').trim(),
    username = read(WEB_FORM + 'UserNameTextBox').trim(),
    password = read(WEB_FORM + 'PasswordTextBox');
  const required = [
    !email && MESSAGE.emailRequired,
    !username && MESSAGE.usernameRequired,
    !password && MESSAGE.passwordRequired,
  ].filter(Boolean);
  if (required.length) return required;
  return [
    (email.length > 250 || !plausibleEmail(email)) && MESSAGE.invalidEmail,
    password !== read(WEB_FORM + 'ConfirmPasswordTextBox') && MESSAGE.mismatch,
    !(flags.alphaUser ? /^[a-z0-9]{1,128}$/i : /^[a-z0-9_.@+-]{1,128}$/i).test(username) &&
      `User name ${username} is invalid, can only contain letters or digits.`,
  ].filter(Boolean);
}

/** The password validator's messages, in the platform's order (empty when the password passes). */
function passwordProblems(password, settings) {
  if (password.length > 256) return ['Passwords must be at most 256 characters.'];
  const upper = /\p{Lu}/u.test(password),
    lower = /\p{Ll}/u.test(password),
    digit = /\d/.test(password),
    special = /[^\p{L}\p{N}]/u.test(password);
  return [
    password.length < settings.minimumLength && `Passwords must be at least ${settings.minimumLength} characters.`,
    settings.defaultPolicy && [upper, lower, digit, special].filter(Boolean).length < 3 && MESSAGE.classes,
    settings.special && !special && 'Passwords must have at least one non letter or digit character.',
    settings.digit && !digit && "Passwords must have at least one digit ('0'-'9').",
    settings.lower && !lower && "Passwords must have at least one lowercase ('a'-'z').",
    settings.upper && !upper && "Passwords must have at least one uppercase ('A'-'Z').",
  ].filter(Boolean);
}

// MVC check boxes post their checked true first and a hidden false after it: the first value is the answer.
const CHECK_BOXES = new Set(['rememberme', 'rememberbrowser']);
async function readForm(req) {
  if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] ?? ''))
    throw Object.assign(new Error('Use a URL-encoded local account form.'), { status: 415 });
  const chunks = [];
  let size = 0;
  // Credential request bodies deliberately never enter the host's request capture.
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 8192) throw Object.assign(new Error('The local account form is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  const values = new Map();
  const fields = {};
  for (const [name, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
    const normalized = name.toLowerCase();
    if (values.has(normalized)) {
      if (CHECK_BOXES.has(normalized)) continue;
      throw Object.assign(new Error('Duplicate local account form control.'), { status: 400 });
    }
    values.set(normalized, value);
    fields[name] = value;
  }
  const read = (name) => values.get(name.toLowerCase()) ?? '';
  read.has = (name) => values.has(name.toLowerCase());
  read.fields = fields;
  return read;
}

const input = (name, caption, type = 'text', value = '', extra = '') => {
  const valueAttribute = value ? ` value="${escape(value)}"` : '';
  return `<label>${caption} <input name="${escape(name)}" id="${escape(name.split('$').pop())}" type="${type}"${valueAttribute}${extra} required></label>`;
};
const checkBox = (name, caption) =>
  `<label><input name="${name}" id="${name}" type="checkbox" value="true"> ${caption}</label><input name="${name}" type="hidden" value="false">`;

/**
 * Loopback-only local accounts. The account is the contact: its ASP.NET Identity columns hold the user name, the password
 * hash (version 3 written, versions 2 and 3 verified), the security stamp, the confirmed, two-factor and lockout state (hosted session F4 AUTH-04g). One-time
 * challenges, the mailbox and the address throttle end with this runtime.
 */
export function createLocalAccounts({
  enabled,
  captcha = null,
  portal,
  origin = () => null,
  store,
  requestTokens,
  authCookieName,
  renderPage,
  signedSession,
  canRememberSession,
  canRememberBrowser,
  signIn,
  // The platform sign-in page's posts that carry no local password (personas, providers): (req, res, url, fields).
  signInPost = null,
  // lib/sign-in-flow.mjs invitations: find(code) and redeem({ code, contactId, subject, contactFields }).
  invitations = null,
  // (password, hash) => whether the password matches the stored hash.
  verifyPassword = (password, hash) => verifyHashedPassword(hash, password),
  // Records a runtime diagnostic: ({ code, severity, path, message }).
  diagnostic = null,
}) {
  const reported = new Set();
  // A warning that names hosted behaviour Mirage does not reproduce by default, once per runtime.
  const reportHosted = (code, path, message) => {
    if (reported.has(code) || typeof diagnostic !== 'function') return;
    reported.add(code);
    diagnostic({ code, severity: 'warning', path, message });
  };
  const reservations = new Set();
  const challenges = new Map(),
    mailbox = new Map();
  // Contact id -> the address this runtime last saw; a different address is unconfirmed until confirmed again.
  const seenEmails = new Map(),
    changedEmails = new Set();
  const addresses = new Map();
  const locks = new Map();
  // Contact id -> the digest of its last used confirmation code (observed.confirmationLinkReuse one-time).
  const usedConfirmations = new Map();
  const now = () => store.clock.now();
  const mfaCookie = () => `${authCookieName()}-mfa`;
  const clearMfa = () => `${mfaCookie()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  // A separate signer ensures that a remembered browser marker can never be read as an application session.
  const rememberedBrowsers = createAuthSessions({
    name: () => rememberedBrowserCookieName(authCookieName()),
    clock: now,
  });
  // An unknown name pays the same password hash as a known one, so the response time does not reveal accounts.
  const unknownAccountVerifier = enabled ? hashPassword(challengeToken()) : null;
  const balanceVerifier = enabled ? hashPasswordV2(challengeToken()) : null;
  // Every password check costs one version 3 and one version 2 derivation, whichever format the account stores (a
  // hosted version 2 hash, a version 3 hash, or none for an unknown name), so the time does not tell them apart.
  const checkPassword = (password, hash) => {
    const matched = verifyPassword(password, hash ?? unknownAccountVerifier);
    verifyHashedPassword(identityVersion(hash) === 2 ? unknownAccountVerifier : balanceVerifier, password);
    return Boolean(hash) && matched;
  };
  const signInPath = () => loginPath(portal());
  const profileUrl = () => servicePages(portal()).profile?.url ?? null;

  // ---- the account: the contact row ----
  const mapping = () => store.resolveMapping('contact');
  const idOf = (row) => String(row?.[mapping().idColumn] ?? '');
  const contactRow = (contactId) => {
    if (!contactId) return null;
    const id = mapping().idColumn;
    return store.tableRows('contact').find((row) => String(row[id]) === contactId) ?? null;
  };
  const activeContact = (contact) => Number(contact.statecode?.value ?? contact.statecode ?? 0) === 0;
  const toAccount = (row) => {
    const hash = row?.[COLUMN.passwordHash];
    if (!row || typeof hash !== 'string' || !hash || !String(row[COLUMN.username] ?? '').trim()) return null;
    const end = Date.parse(row[COLUMN.lockoutEnd] ?? '');
    return {
      contactId: idOf(row),
      username: String(row[COLUMN.username]).trim(),
      email: key(row.emailaddress1),
      hash,
      stamp: String(row[COLUMN.securityStamp] ?? ''),
      confirmed: row[COLUMN.emailConfirmed] === true,
      twoFactor: row[COLUMN.twoFactor] === true,
      failures: Number(row[COLUMN.accessFailed] ?? 0) || 0,
      lockedUntil: Number.isFinite(end) ? end : 0,
    };
  };
  const accountById = (contactId) => toAccount(contactRow(contactId));
  const accountsByName = (name) =>
    name ? store.tableRows('contact').filter((row) => key(row[COLUMN.username]) === name) : [];
  // An account is usable while its contact is active. An address other than the one this runtime last saw (an edit of
  // emailaddress1) ends sessions and pending messages and is unconfirmed until confirmed (Identity's SetEmail).
  const activeAccount = (account) => {
    const contact = account && contactRow(account.contactId);
    if (!contact || !activeContact(contact)) return false;
    const seen = seenEmails.get(account.contactId);
    if (seen === undefined) seenEmails.set(account.contactId, account.email);
    else if (seen !== account.email) {
      seenEmails.set(account.contactId, account.email);
      changedEmails.add(account.contactId);
    }
    if (changedEmails.has(account.contactId)) account.confirmed = false;
    return true;
  };
  // The session and remembered-browser proof: the stamp and the address the account had when it was issued.
  const credentialOf = (account) => digest(`${account.stamp}\n${account.email}`);
  // Email sign-in and recovery use the contact's current address; an address shared by several accounts matches none.
  const accountsByEmail = (email) =>
    email
      ? store
          .tableRows('contact')
          .filter((row) => key(row.emailaddress1) === email && activeContact(row))
          .map(toAccount)
          .filter((account) => account && activeAccount(account))
      : [];
  const accountForSession = (session) => {
    const account = session?.credentialStamp ? accountById(session.contactId) : null;
    return account && activeAccount(account) && sameToken(session.credentialStamp, credentialOf(account))
      ? account
      : null;
  };
  const writeContact = (contactId, fields) => store.update(mapping().logicalName, contactId, fields, { admin: true });
  // One account's credential writes run one at a time, so concurrent failures cannot lose a count.
  const exclusive = (contactId, work) => {
    if (!contactId) return work();
    const previous = locks.get(contactId) ?? Promise.resolve();
    const next = previous.then(work, work);
    const settled = next.catch(() => {});
    locks.set(contactId, settled);
    settled.then(() => locks.get(contactId) === settled && locks.delete(contactId));
    return next;
  };
  // A changed address is persisted as unconfirmed at the next account request.
  const settleEmail = async (account, flags) => {
    if (!account || !activeAccount(account) || !changedEmails.has(account.contactId)) return account;
    if (contactRow(account.contactId)?.[COLUMN.emailConfirmed] !== false)
      await writeContact(account.contactId, { [COLUMN.emailConfirmed]: false });
    changedEmails.delete(account.contactId);
    const current = accountById(account.contactId);
    if (current && flags.confirmation) reissueConfirmation(current);
    return current;
  };
  // New credentials keep the account's failure count and lockout: a reset or a change does not unlock it.
  const credentials = (password) => ({
    [COLUMN.passwordHash]: hashPassword(password),
    [COLUMN.securityStamp]: randomUUID(),
  });

  // ---- pages ----
  const redirect = (res, location, cookies = []) => {
    res.writeHead(302, { location, 'cache-control': 'no-store', ...(cookies.length && { 'set-cookie': cookies }) });
    res.end();
  };
  const page = (req, res, url, title, content = '', status = 200) =>
    renderPage(req, res, url, {
      status,
      content: `<section class="paqvilo-mirage-local-account"><h1>${escape(title)}</h1>${content}</section>`,
      route: 'local-account',
    });
  const note = (text) => (text ? `<div class="alert alert-block alert-danger" role="alert">${escape(text)}</div>` : '');
  const info = (text) => `<p role="status">${escape(text)}</p>`;
  const form = (req, res, action, body, button) =>
    `<form method="post" action="${escape(action)}"><input type="hidden" name="__RequestVerificationToken" value="${escape(requestTokens.issue(req, res))}">${body}<button type="submit">${escape(button)}</button></form>`;
  const signInTarget = (url) => {
    const requested = returnUrlParameter(url.searchParams);
    return requested ? safeReturnUrl(requested) : null;
  };
  // After a sign-in without a return URL, and after registration, the platform opens the profile page.
  const afterSignIn = (returnUrl, flags) => returnUrl ?? ((flags.profileRedirect && profileUrl()) || '/');
  const afterRegistration = (returnUrl, flags) => {
    const profile = flags.profileRedirect && profileUrl();
    if (!profile) return returnUrl ?? '/';
    return returnUrl ? `${profile}?ReturnUrl=${queryValue(returnUrl)}` : profile;
  };
  const signInAction = (returnUrl, invitationCode) => {
    const query = [
      returnUrl ? `ReturnUrl=${queryValue(returnUrl)}` : '',
      invitationCode ? `InvitationCode=${encodeURIComponent(invitationCode)}` : '',
    ].filter(Boolean);
    return signInPath() + (query.length ? `?${query.join('&')}` : '');
  };
  const signInForm = (req, res, flags, { returnUrl = null, invitationCode = null } = {}) => {
    if (!flags.localLogin) return '';
    const label = flags.emailLogin ? 'Email' : 'Username';
    const remember = flags.rememberMe ? checkBox('RememberMe', 'Remember me?') : '';
    const resetLink = flags.reset ? `<p><a href="${ROUTES.forgot}">Forgot your password?</a></p>` : '';
    return (
      `<h2>Sign in with a local account</h2>` +
      form(
        req,
        res,
        signInAction(returnUrl, invitationCode),
        input('Username', label) + input('PasswordValue', 'Password', 'password') + remember,
        'Sign in',
      ) +
      resetLink
    );
  };
  const signInPageContent = (req, res, flags, options, message = '') =>
    (options.invitationCode ? info(`Redeeming code: ${options.invitationCode}`) : '') +
    note(message) +
    signInForm(req, res, flags, options);
  const signInRedirect = (res, url) =>
    redirect(res, `${signInPath()}?ReturnUrl=${queryValue(url.pathname + url.search)}`);

  // ---- one-time challenges and the mailbox ----
  const challengeKey = (account, kind) => `${account.contactId}:${kind}`;
  const linkFor = (kind, account, token) =>
    `${ROUTES[kind]}?userId=${encodeURIComponent(account.contactId)}&code=${encodeURIComponent(token)}`;
  const deliver = (account, kind, record, content) => {
    const id = challengeKey(account, kind);
    const mail = MAIL[kind];
    const link = content.url ? new URL(content.url, origin() ?? 'http://127.0.0.1').href : null;
    mailbox.set(id, {
      accountId: account.contactId,
      to: record.to,
      kind,
      subject: mail.subject,
      body: mail.body(link ?? content.code),
      ...content,
      expiresAt: record.expiresAt,
    });
  };
  const issueChallenge = (
    account,
    kind,
    { returnUrl = '/', lifetime = DAY, persistent = false, invitationCode } = {},
  ) => {
    const token = challengeToken();
    const record = {
      stamp: credentialOf(account),
      to: account.email,
      token: digest(token),
      code: null,
      expiresAt: now() + lifetime,
      attempts: 0,
      returnUrl,
      persistent,
      invitationCode: invitationCode ?? null,
    };
    challenges.set(challengeKey(account, kind), record);
    if (kind !== 'mfa') deliver(account, kind, record, { url: linkFor(kind, account, token) });
    return token;
  };
  // A second-factor code is sent when the browser opens SendCode, as the platform does.
  const sendCode = (account, record) => {
    const code = String(randomInt(1_000_000)).padStart(6, '0');
    record.code = digest(code);
    deliver(account, 'mfa', record, { code });
  };
  const liveRecord = (account, kind) => {
    if (!account || !activeAccount(account)) return null;
    const record = challenges.get(challengeKey(account, kind));
    return record && record.stamp === credentialOf(account) && record.to === account.email && now() < record.expiresAt
      ? record
      : null;
  };
  const challengeFor = (account, kind, token) => {
    const record = liveRecord(account, kind);
    return record && sameToken(record.token, digest(token)) ? record : null;
  };
  const consume = (account, kind) => {
    const id = challengeKey(account, kind);
    challenges.delete(id);
    mailbox.delete(id);
  };
  // Sites that require a confirmed address send a confirmation when there is none pending; other sites send one only
  // when the profile's "Confirm Email" asks for it (hosted session F4: registration sends no email).
  const reissueConfirmation = (account) => {
    if (!account.confirmed && account.email && !liveRecord(account, 'confirm')) issueChallenge(account, 'confirm');
  };
  // Failed passwords and failed second-factor codes share one counter, as Identity's AccessFailed does. Writes the
  // contact's count (or its lockout end) and answers whether the account is now locked.
  const accessFailed = async (account, flags) => {
    if (!flags.lockout) return false;
    const failures = account.failures + 1;
    if (failures < flags.lockAfter) {
      await writeContact(account.contactId, { [COLUMN.accessFailed]: failures });
      return false;
    }
    await writeContact(account.contactId, {
      [COLUMN.accessFailed]: 0,
      [COLUMN.lockoutEnd]: new Date(now() + flags.lockMs).toISOString(),
    });
    return true;
  };
  const resetFailures = async (account) => {
    if (account.failures) await writeContact(account.contactId, { [COLUMN.accessFailed]: 0 });
  };
  const locked = (account, flags) => flags.lockout && account.lockedUntil > now();

  // ---- the address throttle (Authentication/LoginThrottling) ----
  const addressOf = (req) => String(req.socket?.remoteAddress ?? '');
  // Reserves one attempt of an address synchronously, before the password check awaits anything, so parallel attempts
  // cannot all pass the check: null when the address is throttled, else a reservation whose release() takes back an
  // attempt that turned out valid. The reservation counts as an invalid attempt until then.
  const reserveAttempt = (address, policy) => {
    const entry = addresses.get(address) ?? { failures: [], blockedUntil: 0 };
    addresses.delete(address);
    addresses.set(address, entry);
    if (addresses.size > MAX_THROTTLED_ADDRESSES) addresses.delete(addresses.keys().next().value);
    if (entry.blockedUntil > now()) return null;
    entry.failures = entry.failures.filter((item) => now() - item.at < policy.windowMs);
    if (entry.failures.length >= policy.attempts) {
      entry.failures = [];
      entry.blockedUntil = now() + policy.timeoutMs;
      return null;
    }
    const attempt = { at: now() };
    entry.failures.push(attempt);
    return {
      release: () => {
        entry.failures = entry.failures.filter((item) => item !== attempt);
      },
    };
  };

  // ---- registration ----
  const registrationUnavailable = 'Local registration is unavailable.';
  const captchaReady = (flags) => !flags.captcha || Boolean(captcha?.available());
  const registrationAllowed = (flags) => flags.localLogin && flags.registration && captchaReady(flags);
  const invitationRegistrationAllowed = (flags) =>
    flags.localLogin && flags.invitation && Boolean(invitations) && captchaReady(flags);

  function registrationPage(req, res, url, flags, { banner = '', message = '', email = '', status = 200 } = {}) {
    const title = 'Register';
    if (req.method === 'HEAD') return page(req, res, url, title, '', status);
    const challenge = flags.captcha ? captcha?.issue(req, res) : null;
    if (flags.captcha && !challenge) return page(req, res, url, title, note(registrationUnavailable), 403);
    const controls =
      input(WEB_FORM + 'EmailTextBox', 'Email', 'text', email) +
      input(WEB_FORM + 'UserNameTextBox', 'Username') +
      input(WEB_FORM + 'PasswordTextBox', 'Password', 'password', '', ' autocomplete="new-password"') +
      input(WEB_FORM + 'ConfirmPasswordTextBox', 'Confirm password', 'password', '', ' autocomplete="off"');
    const challengeFields = challenge
      ? `<input type="hidden" name="CaptchaChallengeToken" value="${escape(challenge.id)}"><label>${escape(challenge.prompt)} <input name="CaptchaAnswerToken" type="text" maxlength="80" autocomplete="off" required></label>`
      : '';
    return page(
      req,
      res,
      url,
      title,
      banner +
        note(message) +
        `<h2>Register for a new local account</h2>` +
        form(req, res, ROUTES.register + url.search, controls + challengeFields, 'Register'),
      status,
    );
  }

  // The user name and address the platform's user validator reports as taken (they reveal accounts: hosted behaviour,
  // answered only with observed.registrationDuplicateMessages "named").
  function takenIdentities(username, email, flags, invited) {
    return [
      (reservations.has(`name:${key(username)}`) || accountsByName(key(username)).length > 0) &&
        `The username "${username}" is already taken.`,
      flags.uniqueEmail &&
        (reservations.has(`email:${email}`) ||
          store.tableRows('contact').some((row) => key(row.emailaddress1) === email && idOf(row) !== invited)) &&
        `The email "${email}" is already taken.`,
    ].filter(Boolean);
  }

  // By default a taken user name or address answers one refusal that names neither, so registration does not tell
  // which accounts exist.
  const duplicateRefusal = (url) => {
    reportHosted(
      'LOCAL_ACCOUNT_DUPLICATE_HOSTED_MESSAGES',
      url.pathname,
      'A hosted site answers a registration with a taken user name or address with 200 and `The username "<name>" is already taken.` or `The email "<address>" is already taken.`, which tells visitors which accounts exist (hosted session F4 AUTH-04g). Mirage answers 409 "These details cannot be used for local registration." and names neither; set observed.registrationDuplicateMessages to named, with evidence, to reproduce the hosted messages.',
    );
    return { message: 'These details cannot be used for local registration.', status: 409 };
  };

  // Why a registration post is refused, as the { message, status } the form shows again, or null when it registers.
  function registrationRefusal(req, url, read, flags, { code, invitation, email, username, password }) {
    const problems = registrationProblems(read, flags);
    if (problems.length) return refused(problems.join(' '));
    if (
      flags.captcha &&
      !captcha?.redeem(req, { challengeId: read('CaptchaChallengeToken'), answer: read('CaptchaAnswerToken') })
    )
      return refused('The CAPTCHA answer is incorrect or expired. Try a new challenge.');
    // Hosted session F4: a group invitation passes the code step and is refused here, the invitation unchanged.
    if (code && invitation?.type !== 'single') return refused(MESSAGE.invalidInvitation);
    // An invited contact that already has a local account redeems the code by signing in ("I have an existing account");
    // registering would replace its credentials (F4 captured invited contacts without credentials only).
    if (invitation?.invited && toAccount(contactRow(invitation.invited))) return refused(MESSAGE.invalidInvitation);
    const policy = passwordProblems(password, flags);
    if (policy.length) return refused(policy.join(' '));
    const taken = takenIdentities(username, email, flags, invitation?.invited ?? null);
    if (taken.length) return flags.namedDuplicates ? refused(taken.join(' ')) : duplicateRefusal(url);
    const accountCount = store.tableRows('contact').filter((row) => row[COLUMN.username]).length;
    if (accountCount + reservations.size >= MAX_ACCOUNTS) return refused(registrationUnavailable);
    return null;
  }

  // Creates the account while its user name and address are reserved: the invited contact becomes the account, or a new
  // contact is created. Returns the account's contact id, or null when the invitation can no longer be redeemed.
  async function createAccount(flags, { code, invited, username, password, email }) {
    const reserved = [`name:${key(username)}`, `email:${email}`];
    for (const item of reserved) reservations.add(item);
    try {
      const fields = {
        [COLUMN.username]: username,
        ...credentials(password),
        [COLUMN.accessFailed]: 0,
        [COLUMN.lockoutEnd]: null,
        [COLUMN.emailConfirmed]: false,
        [COLUMN.twoFactor]: false,
        [COLUMN.lockoutEnabled]: flags.lockoutByDefault,
        [COLUMN.logonEnabled]: true,
        emailaddress1: email,
      };
      if (invited) {
        // The invited contact becomes the account; no contact is created (hosted session F4 AUTH-05d). Its invitation was
        // found through `invitations` (register); without that service it cannot be redeemed.
        if (!invitations) return null;
        try {
          await invitations.redeem({ code, contactId: invited, subject: username, contactFields: fields });
        } catch (error) {
          if (error?.code === 'INVITATION_INVALID') return null;
          throw error;
        }
        return invited;
      }
      const contactId = randomUUID();
      const contact = mapping();
      await store.create(contact.logicalName, { [contact.idColumn]: contactId, ...fields }, { admin: true });
      return contactId;
    } finally {
      for (const item of reserved) reservations.delete(item);
    }
  }

  async function register(req, res, url, read, flags) {
    const code = url.searchParams.get('invitationCode') || url.searchParams.get('InvitationCode') || null;
    if (!(code ? invitationRegistrationAllowed(flags) : registrationAllowed(flags)))
      return page(req, res, url, 'Register', note(registrationUnavailable), 403);
    const invitation = code ? invitations?.find(code) : null;
    const banner = code ? info(`Redeeming code: ${code}`) : '';
    const prefill = invitation?.type === 'single' ? (invitation.invitedEmail ?? '') : '';
    const again = (message, email = prefill, status = 200) =>
      registrationPage(req, res, url, flags, { banner, message, email, status });
    if (!read) return again(code && !invitation ? MESSAGE.invalidInvitation : '');
    const email = key(read(WEB_FORM + 'EmailTextBox'));
    const username = read(WEB_FORM + 'UserNameTextBox').trim();
    const password = read(WEB_FORM + 'PasswordTextBox');
    const refusal = registrationRefusal(req, url, read, flags, { code, invitation, email, username, password });
    if (refusal) return again(refusal.message, email, refusal.status);
    const invited = invitation?.invited ?? null;
    const contactId = await createAccount(flags, { code, invited, username, password, email });
    if (contactId === null) return again(MESSAGE.invalidInvitation, email);
    const account = accountById(contactId);
    seenEmails.set(contactId, account.email);
    if (flags.confirmation) {
      issueChallenge(account, 'confirm');
      return page(req, res, url, 'Register', info(MESSAGE.confirmFirst));
    }
    return signIn(res, sessionAccount(account), afterRegistration(signInTarget(url), flags));
  }
  const sessionAccount = (account) => ({ contactId: account.contactId, stamp: credentialOf(account) });

  // ---- sign-in ----
  // Why a password sign-in of `account` is refused, as { message, failed }, or null when the password signs in. `failed`
  // counts toward the address throttle.
  async function passwordRejection(contactId, password, flags) {
    const account = contactId ? await settleEmail(accountById(contactId), flags) : null;
    if (!password || password.length > 256) return { message: MESSAGE.invalidSignIn, failed: true };
    if (!account || !activeAccount(account)) {
      checkPassword(password, null);
      return { message: MESSAGE.invalidSignIn, failed: true };
    }
    if (locked(account, flags)) return { message: MESSAGE.locked, failed: true };
    if (!checkPassword(password, account.hash))
      return { message: (await accessFailed(account, flags)) ? MESSAGE.locked : MESSAGE.invalidSignIn, failed: true };
    // A hosted version 2 hash is replaced by a version 3 one once its password signs in; the stamp stays.
    if (identityVersion(account.hash) === 2)
      await writeContact(account.contactId, { [COLUMN.passwordHash]: hashPassword(password) });
    if (flags.confirmation && !account.confirmed) {
      if (!flags.twoFactor || !account.twoFactor) await resetFailures(account);
      reissueConfirmation(account);
      return { message: MESSAGE.confirmFirst, failed: false };
    }
    return null;
  }

  // Completes a sign-in: redeems a pending invitation code for the account, then issues the session.
  async function completeSignIn(
    req,
    res,
    url,
    account,
    flags,
    { returnUrl, cookies = [], persistent, invitationCode },
  ) {
    if (invitationCode) {
      try {
        // A code without the invitation service is refused as an invalid invitation (the sign-in page refuses it first).
        if (!invitations)
          throw Object.assign(new Error('Invitations are not available.'), { code: 'INVITATION_INVALID' });
        await invitations.redeem({ code: invitationCode, contactId: account.contactId, subject: account.username });
      } catch (error) {
        if (error?.code !== 'INVITATION_INVALID') throw error;
        return page(
          req,
          res,
          url,
          'Sign in',
          signInPageContent(req, res, flags, { returnUrl, invitationCode }, MESSAGE.invalidInvitation),
        );
      }
    }
    return signIn(res, sessionAccount(accountById(account.contactId)), afterSignIn(returnUrl, flags), cookies, {
      persistent,
    });
  }

  async function confirmedPasswordSignIn(req, res, url, account, flags, options) {
    // A sign-in completed without a pending code clears the failures; a pending code keeps them until it succeeds.
    if (!flags.twoFactor || !account.twoFactor) {
      await resetFailures(account);
      return completeSignIn(req, res, url, account, flags, options);
    }
    if (flags.rememberBrowser && browserRemembered(req, account)) {
      await resetFailures(account);
      return completeSignIn(req, res, url, account, flags, { ...options, cookies: [clearMfa()] });
    }
    const token = issueChallenge(account, 'mfa', {
      returnUrl: options.returnUrl,
      lifetime: flags.twoFactorMs,
      persistent: options.persistent,
      invitationCode: options.invitationCode,
    });
    return redirect(res, `${ROUTES.sendCode}?RememberMe=${options.persistent ? 'True' : 'False'}`, [
      `${mfaCookie()}=${encodeURIComponent(account.contactId)}.${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.ceil(flags.twoFactorMs / 1000)}`,
    ]);
  }
  const browserRemembered = (req, account) => {
    const marker = rememberedBrowsers.read(req.headers.cookie);
    return marker?.contactId === account.contactId && sameToken(marker.credentialStamp, digest(credentialOf(account)));
  };
  const rememberBrowser = (account) =>
    rememberedBrowsers.cookie({
      contactId: account.contactId,
      credentialStamp: digest(credentialOf(account)),
      expiresAt: now() + DAY,
    }) +
    '; Max-Age=' +
    DAY / 1000;

  function signInPage(req, res, url, flags, options = {}) {
    if (!flags.localLogin) return page(req, res, url, 'Sign in', note('Local account sign-in is disabled.'), 403);
    return page(req, res, url, 'Sign in', signInPageContent(req, res, flags, options));
  }

  async function login(req, res, url, read, flags) {
    const returnUrl = signInTarget(url);
    const invitationCode = url.searchParams.get('InvitationCode') || null;
    if (!flags.localLogin || !read) return signInPage(req, res, url, flags, { returnUrl, invitationCode });
    const refuse = (message, status = 200) =>
      page(
        req,
        res,
        url,
        'Sign in',
        signInPageContent(req, res, flags, { returnUrl, invitationCode }, message),
        status,
      );
    const attempt = flags.throttle ? reserveAttempt(addressOf(req), flags.throttle) : { release() {} };
    if (!attempt) return refuse(MESSAGE.throttled, 409);
    const name = key(read('Username'));
    const matches = flags.emailLogin ? accountsByEmail(name) : accountsByName(name).map(toAccount).filter(Boolean);
    const contactId = matches.length === 1 ? matches[0].contactId : null;
    const rejection = await exclusive(contactId, () => passwordRejection(contactId, read('PasswordValue'), flags));
    if (!rejection?.failed) attempt.release();
    if (rejection) return refuse(rejection.message);
    if (invitationCode && invitations?.find(invitationCode)?.type !== 'single')
      return refuse(MESSAGE.invalidInvitation);
    return confirmedPasswordSignIn(req, res, url, accountById(contactId), flags, {
      returnUrl,
      persistent: flags.rememberMe && read('RememberMe') === 'true',
      invitationCode,
    });
  }

  // ---- the second factor ----
  const pendingSecondFactor = (req, flags) => {
    const [id, token] = String(parseCookies(req.headers.cookie)[mfaCookie()] ?? '').split('.');
    let contactId;
    try {
      contactId = decodeURIComponent(id ?? '');
    } catch {
      return null;
    }
    const account = flags.localLogin && flags.twoFactor ? accountById(contactId) : null;
    const record = account ? challengeFor(account, 'mfa', token) : null;
    return record ? { account, record } : null;
  };
  // Without a pending sign-in the platform answers SendCode and VerifyCode with its error page.
  const noContext = (req, res, url) => page(req, res, url, "We're sorry, but something went wrong (500)", '', 500);

  function sendCodeRoute(req, res, url, _read, flags) {
    const pending = pendingSecondFactor(req, flags);
    if (!pending) return noContext(req, res, url);
    if (req.method !== 'HEAD') sendCode(pending.account, pending.record);
    return redirect(
      res,
      `${ROUTES.verify}?Provider=EmailCode&RememberMe=${pending.record.persistent ? 'True' : 'False'}`,
    );
  }

  async function verify(req, res, url, read, flags) {
    const title = 'Enter security code';
    const pending = pendingSecondFactor(req, flags);
    if (!pending?.record.code) return noContext(req, res, url);
    const { record } = pending;
    const account = await settleEmail(pending.account, flags);
    const remember = flags.rememberBrowser ? checkBox('RememberBrowser', 'Remember this browser?') : '';
    const controls = (message = '') =>
      note(message) +
      form(
        req,
        res,
        ROUTES.verify,
        `<input type="hidden" name="provider" value="EmailCode"><input type="hidden" name="rememberMe" value="${record.persistent ? 'True' : 'False'}">` +
          input('Code', 'Code') +
          info(MESSAGE.checkCode) +
          remember,
        'Verify',
      );
    if (locked(account, flags)) {
      consume(account, 'mfa');
      return page(req, res, url, title, note(MESSAGE.locked));
    }
    if (!read) return page(req, res, url, title, controls());
    if (!sameToken(record.code, digest(read('Code')))) {
      const nowLocked = await exclusive(account.contactId, async () =>
        accessFailed(accountById(account.contactId), flags),
      );
      if (nowLocked) {
        consume(account, 'mfa');
        return page(req, res, url, title, note(MESSAGE.locked));
      }
      if (++record.attempts >= 5) consume(account, 'mfa');
      return page(req, res, url, title, controls(MESSAGE.invalidCode));
    }
    consume(account, 'mfa');
    await exclusive(account.contactId, () => resetFailures(accountById(account.contactId)));
    const cookies = [clearMfa()];
    if (flags.rememberBrowser && read('RememberBrowser') === 'true') cookies.push(rememberBrowser(account));
    return completeSignIn(req, res, url, account, flags, {
      returnUrl: record.returnUrl,
      cookies,
      persistent: flags.rememberMe && record.persistent,
      invitationCode: record.invitationCode,
    });
  }

  // ---- recovery and confirmation ----
  async function forgot(req, res, url, read, flags) {
    const title = 'Forgot your password?';
    if (!flags.localLogin || !flags.reset)
      return page(req, res, url, title, note('Password recovery is disabled.'), 403);
    if (!read)
      return page(
        req,
        res,
        url,
        title,
        form(req, res, ROUTES.forgot, input('Email', 'Email'), 'Send') +
          info('Enter your email address to request a password reset.'),
      );
    // The same answer for known and unknown addresses.
    const matches = accountsByEmail(key(read('Email')));
    if (matches.length === 1) {
      const account = await settleEmail(matches[0], flags);
      if (account && (!flags.resetConfirmed || account.confirmed)) issueChallenge(account, 'reset');
    }
    return page(req, res, url, title, info(MESSAGE.recoverySent));
  }

  async function reset(req, res, url, read, flags) {
    const title = 'Reset password';
    if (!flags.localLogin || !flags.reset)
      return page(req, res, url, title, note('Password recovery is disabled.'), 403);
    const userId = read ? read('UserId') : (url.searchParams.get('userId') ?? '');
    const code = read ? read('Code') : (url.searchParams.get('code') ?? '');
    const controls = (message = '') =>
      note(message) +
      form(
        req,
        res,
        ROUTES.reset,
        `<input type="hidden" name="UserId" value="${escape(userId)}"><input type="hidden" name="Code" value="${escape(code)}">${input('Password', 'New password', 'password')}${input('ConfirmPassword', 'Confirm new password', 'password')}`,
        'Reset',
      );
    if (!read) return page(req, res, url, title, controls());
    const password = read('Password');
    if (!password) return page(req, res, url, title, controls(MESSAGE.passwordRequired));
    if (password !== read('ConfirmPassword')) return page(req, res, url, title, controls(MESSAGE.mismatch));
    return exclusive(userId, async () => {
      const account = accountById(userId);
      if (!challengeFor(account, 'reset', code)) return page(req, res, url, title, controls(MESSAGE.invalidToken));
      const policy = passwordProblems(password, flags);
      if (policy.length) return page(req, res, url, title, controls(policy.join(' ')));
      await writeContact(account.contactId, credentials(password));
      consume(account, 'reset');
      const current = accountById(account.contactId);
      if (flags.confirmation) reissueConfirmation(current);
      return redirect(res, ROUTES.resetDone);
    });
  }

  function resetDone(req, res, url) {
    return page(
      req,
      res,
      url,
      'Reset password',
      info(MESSAGE.resetDone) + `<p><a href="${escape(signInPath())}">Sign in</a></p>`,
    );
  }

  // A confirmation link is used once: a link already used answers 403. A hosted site lets it be used again until the
  // account's stamp or address changes (hosted session F4 AUTH-04g), reproduced with observed.confirmationLinkReuse.
  async function confirm(req, res, url, _read, flags) {
    const account = accountById(url.searchParams.get('userId') ?? '');
    const code = url.searchParams.get('code') ?? '';
    if (!challengeFor(account, 'confirm', code)) {
      const used = account && usedConfirmations.get(account.contactId);
      const refusedReuse = used && sameToken(used, digest(code));
      return page(req, res, url, 'Confirm Email', note(MESSAGE.invalidToken), refusedReuse ? 403 : 200);
    }
    if (req.method !== 'HEAD') {
      changedEmails.delete(account.contactId);
      if (contactRow(account.contactId)?.[COLUMN.emailConfirmed] !== true)
        await writeContact(account.contactId, { [COLUMN.emailConfirmed]: true });
      if (!flags.reusableConfirmation) {
        consume(account, 'confirm');
        usedConfirmations.set(account.contactId, digest(code));
        reportHosted(
          'LOCAL_ACCOUNT_CONFIRMATION_HOSTED_REUSE',
          url.pathname,
          'A hosted site lets a local account confirmation link be used again until the account changes (hosted session F4 AUTH-04g). Mirage uses it once and answers 403 to a second use; set observed.confirmationLinkReuse to reusable, with evidence, to reproduce the hosted behaviour.',
        );
      }
    }
    return redirect(res, `${profileUrl() ?? '/'}?Message=ConfirmEmailSuccess`);
  }

  // ---- account management ----
  // The signed-in local account, or an answer: anonymous visitors go to the sign-in page.
  async function managedAccount(req, res, url, flags, { title, twoFactor = false }) {
    const session = signedSession(req);
    const account = await settleEmail(accountForSession(session), flags);
    if (account && flags.localLogin && (!twoFactor || (flags.twoFactor && account.confirmed))) return account;
    if (!session?.contactId) signInRedirect(res, url);
    else await page(req, res, url, title, note('An eligible local account session is required.'), 403);
    return null;
  }
  const profileMessage = (message) => `${profileUrl() ?? '/'}?Message=${message}`;

  async function confirmRequest(req, res, url, _read, flags) {
    const title = 'Confirm Email';
    if (!(await managedAccount(req, res, url, flags, { title }))) return;
    return page(req, res, url, title, info(MESSAGE.confirmRequested));
  }

  async function postConfirm(req, res, url, _read, flags) {
    const account = await managedAccount(req, res, url, flags, { title: 'Confirm Email' });
    if (!account) return;
    if (!account.confirmed && account.email) issueChallenge(account, 'confirm');
    res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end();
  }

  async function changePassword(req, res, url, read, flags) {
    const title = 'Change password';
    const account = await managedAccount(req, res, url, flags, { title });
    if (!account) return;
    const controls = (message = '') =>
      note(message) +
      form(
        req,
        res,
        ROUTES.change,
        input('Username', 'Username', 'text', account.username, ' readonly') +
          input('OldPassword', 'Old password', 'password') +
          input('NewPassword', 'New password', 'password') +
          input('ConfirmPassword', 'Confirm password', 'password'),
        'Change password',
      );
    if (!read) return page(req, res, url, title, controls());
    const password = read('NewPassword');
    if (!password) return page(req, res, url, title, controls(MESSAGE.passwordRequired));
    if (password !== read('ConfirmPassword')) return page(req, res, url, title, controls(MESSAGE.mismatch));
    const old = read('OldPassword');
    if (!old || old.length > 256 || !checkPassword(old, account.hash))
      return page(req, res, url, title, controls(MESSAGE.incorrectPassword));
    const policy = passwordProblems(password, flags);
    if (policy.length) return page(req, res, url, title, controls(policy.join(' ')));
    await exclusive(account.contactId, () => writeContact(account.contactId, credentials(password)));
    const current = accountById(account.contactId);
    if (flags.confirmation) reissueConfirmation(current);
    return signIn(res, sessionAccount(current), profileMessage('ChangePasswordSuccess'));
  }

  async function twoFactorPage(req, res, url, _read, flags) {
    const title = 'Change Two-Factor authentication';
    const account = await managedAccount(req, res, url, flags, { title, twoFactor: true });
    if (!account) return;
    const [state, action, button] = account.twoFactor
      ? ['Disable Two-factor authentication is currently enabled.', ROUTES.disableTwoFactor, 'Disable']
      : ['Enable Two-factor authentication is currently disabled.', ROUTES.enableTwoFactor, 'Enable'];
    return page(req, res, url, title, info(state) + form(req, res, action, '', button));
  }

  // EnableTFA posts only the form token (hosted session F4); DisableTFA is its counterpart.
  async function setTwoFactor(req, res, url, flags, enabled) {
    const account = await managedAccount(req, res, url, flags, {
      title: 'Change Two-Factor authentication',
      twoFactor: true,
    });
    if (!account) return;
    await writeContact(account.contactId, { [COLUMN.twoFactor]: enabled, [COLUMN.securityStamp]: randomUUID() });
    return signIn(
      res,
      sessionAccount(accountById(account.contactId)),
      profileMessage(enabled ? 'EnableTwoFactorSuccess' : 'DisableTwoFactorSuccess'),
    );
  }

  const GET = ['GET', 'HEAD'],
    ALL = ['GET', 'HEAD', 'POST'];
  const handlers = new Map([
    [key(ROUTES.login), [ALL, login]],
    [key(ROUTES.register), [ALL, register]],
    [key(ROUTES.forgot), [ALL, forgot]],
    [key(ROUTES.reset), [ALL, reset]],
    [key(ROUTES.resetDone), [GET, resetDone]],
    [key(ROUTES.sendCode), [GET, sendCodeRoute]],
    [key(ROUTES.verify), [ALL, verify]],
    [key(ROUTES.confirm), [GET, confirm]],
    [key(ROUTES.confirmRequest), [GET, confirmRequest]],
    [key(ROUTES.postConfirm), [['POST'], postConfirm]],
    [key(ROUTES.change), [ALL, changePassword]],
    [key(ROUTES.twoFactor), [GET, twoFactorPage]],
    [
      key(ROUTES.enableTwoFactor),
      [['POST'], (req, res, url, _read, flags) => setTwoFactor(req, res, url, flags, true)],
    ],
    [
      key(ROUTES.disableTwoFactor),
      [['POST'], (req, res, url, _read, flags) => setTwoFactor(req, res, url, flags, false)],
    ],
  ]);
  const currentFlags = () => {
    const flags = settingsFor(portal());
    flags.rememberMe &&= canRememberSession();
    flags.rememberBrowser &&= canRememberBrowser();
    return flags;
  };
  const refuseToken = (req, res, url) =>
    page(req, res, url, 'Local account request refused', note('The form token is missing or invalid.'), 403);
  const urlEncoded = (req) => /^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] ?? '');

  // The site's sign-in path posted URL-encoded: a post with PasswordValue is the local sign-in, any other is the site's.
  // Returns false when the post is not handled here.
  async function routeSignInPost(req, res, url) {
    if (!urlEncoded(req)) return false;
    const read = await readForm(req);
    if (!read.has('PasswordValue')) {
      if (!signInPost) return false;
      await signInPost(req, res, url, read.fields);
      return true;
    }
    const token = read('__RequestVerificationToken');
    if (!sameToken(token, requestTokens.expected(req, token))) await refuseToken(req, res, url);
    else await login(req, res, url, read, currentFlags());
    return true;
  }

  // Serves one of the local account routes: refuses another method and a post without a valid request token.
  async function routeHandler(req, res, url, methods, handler) {
    if (!methods.includes(req.method)) {
      res.writeHead(405, { allow: methods.join(', '), 'cache-control': 'no-store' });
      res.end();
      return;
    }
    // The profile's "Confirm Email" posts without a body: its token travels in the request header.
    const headerOnly = handler === postConfirm && !urlEncoded(req);
    const read = req.method === 'POST' && !headerOnly ? await readForm(req) : null;
    const token = headerOnly ? req.headers.__requestverificationtoken : read?.('__RequestVerificationToken');
    if (req.method === 'POST' && !sameToken(token, requestTokens.expected(req, token))) {
      await refuseToken(req, res, url);
      return;
    }
    await handler(req, res, url, read, currentFlags());
  }

  return {
    enabled,
    messages: () =>
      [...mailbox].flatMap(([id, { accountId, ...message }]) => {
        const account = accountById(accountId);
        const challenge = challenges.get(id);
        return account &&
          activeAccount(account) &&
          challenge?.stamp === credentialOf(account) &&
          message.to === account.email &&
          message.expiresAt > now()
          ? [message]
          : [];
      }),
    clear() {
      challenges.clear();
      mailbox.clear();
      seenEmails.clear();
      changedEmails.clear();
      addresses.clear();
      usedConfirmations.clear();
    },
    validSession: (session) => Boolean(accountForSession(session)),
    signInLink: (returnUrl) =>
      enabled && settingsFor(portal()).localLogin
        ? `<p><a href="${ROUTES.login}?ReturnUrl=${encodeURIComponent(returnUrl)}">Sign in with a local account</a></p>`
        : '',
    registrationAvailable: () => enabled && registrationAllowed(settingsFor(portal())),
    invitationRegistrationAvailable: () => enabled && invitationRegistrationAllowed(settingsFor(portal())),
    /** The local sign-in page that redeems an invitation code for the contact who signs in. */
    signInPage: (req, res, url, { returnUrl = null, invitationCode = null } = {}) =>
      signInPage(req, res, url, currentFlags(), {
        returnUrl: returnUrl && returnUrl !== '/' ? returnUrl : null,
        invitationCode,
      }),
    async route(req, res, url) {
      if (!enabled) return false;
      const path = key(url.pathname).replace(/\/$/, '');
      // The site's sign-in path: a URL-encoded post with PasswordValue is the local sign-in.
      if (path === key(signInPath()).replace(/\/$/, '') && req.method === 'POST') return routeSignInPost(req, res, url);
      const [methods, handler] = handlers.get(path) ?? [];
      if (!handler) return false;
      await routeHandler(req, res, url, methods, handler);
      return true;
    },
  };
}
