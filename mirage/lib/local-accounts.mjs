import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { createAuthSessions, parseCookies, returnUrlParameter, safeReturnUrl } from './auth-session.mjs';
import { sameToken } from './admin-origin.mjs';
import { hashSecret, verifySecret } from './dataverse-auth.mjs';
import { authenticationSettings, timeSpanMs } from './external-login.mjs';
import { siteSetting } from './redirects.mjs';

const ROUTES = Object.freeze({
  login: '/Account/Login/Login',
  register: '/Account/Login/Register',
  forgot: '/Account/Login/ForgotPassword',
  reset: '/Account/Login/ResetPassword',
  confirm: '/Account/Login/ConfirmEmail',
  verify: '/Account/Login/VerifyCode',
  change: '/Account/Manage/ChangePassword',
  twoFactor: '/Account/Manage/TwoFactor',
});
const DAY = 86_400_000;
const MAX_ACCOUNTS = 2048;
export const rememberedBrowserCookieName = (authName) => authName + '-remembered-browser';
const INVALID_SIGN_IN = 'The username or password is incorrect.';
const RECOVERY_SENT = 'A reset message is available if an eligible local account has that address.';
const escape = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
const key = (value) =>
  String(value ?? '')
    .trim()
    .toLowerCase();
const digest = (value) =>
  createHash('sha256')
    .update(String(value ?? ''))
    .digest('base64url');
const challengeToken = () => randomBytes(32).toString('base64url');

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
  return {
    localLogin: auth.localLogin,
    registration:
      auth.registration && registration('OpenRegistrationEnabled', true) && !registration('RequiresInvitation'),
    confirmation: registration('RequiresConfirmation'),
    captcha: registration('CaptchaEnabled'),
    uniqueEmail: auth.requireUniqueEmail,
    emailLogin: registration('LocalLoginByEmail'),
    rememberMe: registration('RememberMeEnabled'),
    rememberBrowser: registration('RememberBrowserEnabled'),
    reset: registration('ResetPasswordEnabled', true),
    resetConfirmed: registration('ResetPasswordRequiresConfirmedEmail'),
    twoFactor: registration('TwoFactorEnabled'),
    lockout:
      registration('TriggerLockoutOnFailedPassword', true) && flag('UserManager/UserLockoutEnabledByDefault', true),
    lockAfter: integer('UserManager/MaxFailedAccessAttemptsBeforeLockout', 5, 100),
    lockMs: timeSpanMs(value('UserManager/DefaultAccountLockoutTimeSpan')) ?? DAY,
    twoFactorMs: Math.min(timeSpanMs(value('TwoFactorCookie/ExpireTimeSpan')) ?? 300_000, 360_000),
    minimumLength: integer('UserManager/PasswordValidator/RequiredLength', 8, 256),
    defaultPolicy: policy('EnforcePasswordPolicy', true),
    upper: policy('RequireUppercase'),
    lower: policy('RequireLowercase'),
    digit: policy('RequireDigit'),
    special: policy('RequireNonLetterOrDigit'),
    alphaUser: flag('UserManager/UserValidator/AllowOnlyAlphanumericUserNames'),
  };
}

function validPassword(password, settings) {
  if (typeof password !== 'string' || password.length < settings.minimumLength || password.length > 256) return false;
  const upper = /\p{Lu}/u.test(password),
    lower = /\p{Ll}/u.test(password),
    digit = /\d/.test(password),
    special = /[^\p{L}\p{N}]/u.test(password);
  return (
    (!settings.defaultPolicy || [upper, lower, digit, special].filter(Boolean).length >= 3) &&
    (!settings.upper || upper) &&
    (!settings.lower || lower) &&
    (!settings.digit || digit) &&
    (!settings.special || special)
  );
}

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
  for (const [name, value] of new URLSearchParams(Buffer.concat(chunks).toString('utf8'))) {
    const normalized = name.toLowerCase();
    if (values.has(normalized))
      throw Object.assign(new Error('Duplicate local account form control.'), { status: 400 });
    values.set(normalized, value);
  }
  return (name) => values.get(name.toLowerCase()) ?? '';
}

const input = (name, caption, type = 'text') =>
  `<label>${caption} <input name="${name}" type="${type}" required></label>`;
const passwordInput = input('Password', 'Password', 'password');
const confirmInput = input('ConfirmPassword', 'Confirm password', 'password');
const emailInput = input('Email', 'Email address', 'email');

/** Loopback-only account fixtures. Credentials, one-time challenges and messages end with this runtime. */
export function createLocalAccounts({
  enabled,
  captcha = null,
  portal,
  store,
  requestTokens,
  authCookieName,
  renderPage,
  signedSession,
  canRememberSession,
  canRememberBrowser,
  signIn,
  verifyPassword = verifySecret,
}) {
  const accounts = new Map(),
    usernames = new Map(),
    reservations = new Set();
  const challenges = new Map(),
    mailbox = new Map();
  const now = () => store.clock.now();
  const mfaCookie = () => `${authCookieName()}-mfa`;
  const clearMfa = () => `${mfaCookie()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
  // A separate signer ensures that a remembered browser marker can never be read as an application session.
  const rememberedBrowsers = createAuthSessions({
    name: () => rememberedBrowserCookieName(authCookieName()),
    clock: now,
  });
  const browserRemembered = (req, account) => {
    const marker = rememberedBrowsers.read(req.headers.cookie);
    return marker?.contactId === account.contactId && sameToken(marker.credentialStamp, digest(account.stamp));
  };
  const rememberBrowser = (account) =>
    rememberedBrowsers.cookie({
      contactId: account.contactId,
      credentialStamp: digest(account.stamp),
      expiresAt: now() + DAY,
    }) +
    '; Max-Age=' +
    DAY / 1000;
  // An unknown name pays the same password hash as a known one, so the response time does not reveal accounts.
  const unknownAccountVerifier = enabled ? hashSecret(challengeToken()) : null;
  const contactRow = (contactId) => {
    const mapping = store.resolveMapping('contact');
    return store.tableRows('contact').find((row) => row[mapping.idColumn] === contactId);
  };
  const activeContact = (contact) => Number(contact.statecode?.value ?? contact.statecode ?? 0) === 0;
  // The account is the contact. A changed emailaddress1 is handled once, when first observed, as Identity's SetEmail
  // does: the address becomes unconfirmed and the credential stamp rotates, so sessions, remembered browsers and pending
  // messages end and a confirmation goes to the new address. The account and its password stay.
  const activeAccount = (account) => {
    const contact = account && contactRow(account.contactId);
    if (!contact || !activeContact(contact)) return false;
    const email = key(contact.emailaddress1);
    if (email !== account.email) {
      account.email = email;
      account.confirmed = false;
      account.stamp = challengeToken();
      reissueConfirmation(account);
    }
    return true;
  };
  const contactEmail = (account) => key(contactRow(account.contactId)?.emailaddress1);
  // Email sign-in and recovery use the contact's current address; an address shared by several accounts matches none.
  const accountsByEmail = (email) => {
    if (!email) return [];
    const mapping = store.resolveMapping('contact');
    return store
      .tableRows('contact')
      .filter((row) => key(row.emailaddress1) === email && activeContact(row))
      .flatMap((row) => accounts.get(row[mapping.idColumn]) ?? [])
      .filter(activeAccount);
  };
  const accountForSession = (session) => {
    const account = session?.credentialStamp && accounts.get(session.contactId);
    return account && activeAccount(account) && sameToken(session.credentialStamp, account.stamp) ? account : null;
  };
  const updatePassword = (account, password) => {
    account.verifier = hashSecret(password);
    account.stamp = challengeToken();
    account.failures = 0;
    account.lockedUntil = 0;
  };
  const redirect = (res, location, cookies = []) => {
    res.writeHead(302, { location, 'cache-control': 'no-store', ...(cookies.length && { 'set-cookie': cookies }) });
    res.end();
  };
  const page = (req, res, url, title, content = '', status = 200) =>
    renderPage(req, res, url, {
      status,
      content: `<section class="paqvilo-mirage-local-account"><h1>${title}</h1>${content}</section>`,
      route: 'local-account',
    });
  const note = (text) => `<p role="status">${escape(text)}</p>`;
  const form = (req, res, action, body, button) =>
    `<form method="post" action="${escape(action)}"><input type="hidden" name="__RequestVerificationToken" value="${escape(requestTokens.issue(req, res))}">${body}<button type="submit">${button}</button></form>`;
  const destination = (url, read) => safeReturnUrl(read?.('ReturnUrl') || returnUrlParameter(url.searchParams));
  const signInForm = (req, res, returnUrl, flags) => {
    if (!flags.localLogin) return '';
    const label = flags.emailLogin ? 'Email address' : 'Username';
    const remember = flags.rememberMe
      ? '<label><input name="RememberMe" type="checkbox" value="true"> Remember me?</label>'
      : '';
    const resetLink = flags.reset ? `<p><a href="${ROUTES.forgot}">Forgot your password?</a></p>` : '';
    return (
      form(
        req,
        res,
        ROUTES.login,
        `<input type="hidden" name="ReturnUrl" value="${escape(returnUrl)}">${input('UserName', label)}${passwordInput}${remember}`,
        'Sign in with a local account',
      ) + resetLink
    );
  };
  const challengeKey = (account, kind) => `${account.contactId}:${kind}`;
  const issueChallenge = (account, kind, { returnUrl = '/', lifetime = DAY, persistent = false } = {}) => {
    const token = challengeToken();
    const code = kind === 'mfa' ? String(randomInt(1_000_000)).padStart(6, '0') : token;
    const id = challengeKey(account, kind);
    const expiresAt = now() + lifetime;
    const to = contactEmail(account);
    challenges.set(id, {
      stamp: account.stamp,
      to,
      token: digest(token),
      code: digest(code),
      expiresAt,
      attempts: 0,
      returnUrl,
      persistent,
    });
    mailbox.set(id, {
      accountId: account.contactId,
      to,
      kind,
      ...(kind === 'mfa'
        ? { code }
        : {
            url: `${ROUTES[kind]}?account=${encodeURIComponent(account.contactId)}&token=${encodeURIComponent(code)}`,
          }),
      expiresAt,
    });
    return token;
  };
  const challengeFor = (account, kind, token) => {
    if (!activeAccount(account)) return null;
    const record = challenges.get(challengeKey(account, kind));
    return record &&
      record.stamp === account.stamp &&
      record.to === contactEmail(account) &&
      now() < record.expiresAt &&
      sameToken(record.token, digest(token))
      ? record
      : null;
  };
  const consume = (account, kind) => {
    const id = challengeKey(account, kind);
    challenges.delete(id);
    mailbox.delete(id);
  };
  const liveChallenge = (account, kind) => {
    const record = challenges.get(challengeKey(account, kind));
    return Boolean(
      record && record.stamp === account.stamp && record.to === contactEmail(account) && now() < record.expiresAt,
    );
  };
  // A rotated stamp or an expired link would otherwise leave an unconfirmed account without a usable confirmation.
  const reissueConfirmation = (account) => {
    if (!account.confirmed && contactEmail(account) && !liveChallenge(account, 'confirm'))
      issueChallenge(account, 'confirm');
  };
  // Failed passwords and failed second-factor codes share one counter, as Identity's AccessFailed does.
  const accessFailed = (account, flags) => {
    if (!flags.lockout || ++account.failures < flags.lockAfter) return false;
    account.failures = 0;
    account.lockedUntil = now() + flags.lockMs;
    return true;
  };
  const LOCKED = 'The local account is temporarily locked.';
  const contactEmailMatches = (email) => store.tableRows('contact').some((row) => key(row.emailaddress1) === email);

  const registrationTitle = 'Register a local account';
  const registrationUnavailable = 'Local open registration is unavailable.';
  const registrationAllowed = (flags) =>
    flags.localLogin && flags.registration && (!flags.captcha || Boolean(captcha?.available()));

  function registrationPage(req, res, url, requireCaptcha, message = '') {
    if (req.method === 'HEAD') return page(req, res, url, registrationTitle);
    const challenge = requireCaptcha ? captcha.issue(req, res) : null;
    if (requireCaptcha && !challenge)
      return page(req, res, url, registrationTitle, note(message || registrationUnavailable), 403);
    const controls =
      input('UserName', 'Username') + input('LastName', 'Last name') + emailInput + passwordInput + confirmInput;
    const challengeFields = challenge
      ? `<input type="hidden" name="CaptchaChallengeToken" value="${escape(challenge.id)}"><label>${escape(challenge.prompt)} <input name="CaptchaAnswerToken" type="text" maxlength="80" autocomplete="off" required></label>`
      : '';
    return page(
      req,
      res,
      url,
      registrationTitle,
      (message ? note(message) : '') + form(req, res, ROUTES.register, controls + challengeFields, 'Register'),
      message ? 403 : 200,
    );
  }

  async function register(req, res, url, read, flags) {
    const title = registrationTitle;
    if (!registrationAllowed(flags)) return page(req, res, url, title, note(registrationUnavailable), 403);
    if (!read) return registrationPage(req, res, url, flags.captcha);
    const username = key(read('UserName')),
      email = key(read('Email')),
      lastname = read('LastName').trim();
    const password = read('Password');
    if (
      !(flags.alphaUser ? /^[a-z0-9]{1,128}$/i : /^[a-z0-9_.@+-]{1,128}$/i).test(username) ||
      !email.includes('@') ||
      /\s/.test(email) ||
      email.length > 250 ||
      !lastname ||
      lastname.length > 100 ||
      !validPassword(password, flags) ||
      password !== read('ConfirmPassword')
    )
      return page(
        req,
        res,
        url,
        title,
        note('Enter valid local account details and a matching password that meets the site policy.'),
        400,
      );
    if (
      flags.captcha &&
      !captcha.redeem(req, { challengeId: read('CaptchaChallengeToken'), answer: read('CaptchaAnswerToken') })
    )
      return registrationPage(req, res, url, true, 'The CAPTCHA answer is incorrect or expired. Try a new challenge.');
    const reserved = [`name:${username}`, ...(flags.uniqueEmail || flags.emailLogin ? [`email:${email}`] : [])];
    if (
      accounts.size + reservations.size >= MAX_ACCOUNTS ||
      usernames.has(username) ||
      reserved.some((item) => reservations.has(item)) ||
      ((flags.uniqueEmail || flags.emailLogin) && contactEmailMatches(email))
    )
      return page(req, res, url, title, note('These details cannot be used for local registration.'), 409);
    for (const item of reserved) reservations.add(item);
    try {
      const account = { contactId: randomUUID(), email, confirmed: false, twoFactor: false };
      updatePassword(account, password);
      const mapping = store.resolveMapping('contact');
      await store.create(
        mapping.logicalName,
        { [mapping.idColumn]: account.contactId, lastname, fullname: lastname, emailaddress1: email },
        { admin: true },
      );
      accounts.set(account.contactId, account);
      usernames.set(username, account);
      issueChallenge(account, 'confirm');
      if (flags.confirmation) return page(req, res, url, title, note('Confirm your email before signing in.'));
      return signIn(res, account, destination(url, read));
    } finally {
      for (const item of reserved) reservations.delete(item);
    }
  }

  function confirmedPasswordSignIn(req, res, account, returnUrl, flags, persistent) {
    // A sign-in completed without a pending code clears the failures; a pending code keeps them until it succeeds.
    if (!flags.twoFactor || !account.twoFactor) {
      account.failures = 0;
      return signIn(res, account, returnUrl, [], { persistent });
    }
    if (flags.rememberBrowser && browserRemembered(req, account)) {
      account.failures = 0;
      return signIn(res, account, returnUrl, [clearMfa()], { persistent });
    }
    const token = issueChallenge(account, 'mfa', { returnUrl, lifetime: flags.twoFactorMs, persistent });
    return redirect(res, ROUTES.verify, [
      `${mfaCookie()}=${encodeURIComponent(account.contactId)}.${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.ceil(flags.twoFactorMs / 1000)}`,
    ]);
  }

  // Why a password sign-in of `account` is refused, as [message, status], or null when the password signs in.
  function passwordRejection(account, password, flags) {
    if (!password || password.length > 256) return [INVALID_SIGN_IN, 401];
    if (!activeAccount(account)) {
      verifyPassword(password, unknownAccountVerifier);
      return [INVALID_SIGN_IN, 401];
    }
    if (flags.lockout && account.lockedUntil > now()) return [LOCKED, 403];
    if (!verifyPassword(password, account.verifier))
      return accessFailed(account, flags) ? [LOCKED, 403] : [INVALID_SIGN_IN, 401];
    if (flags.confirmation && !account.confirmed) {
      if (!flags.twoFactor || !account.twoFactor) account.failures = 0;
      reissueConfirmation(account);
      return ['Confirm your email before signing in.', 403];
    }
    return null;
  }

  function login(req, res, url, read, flags) {
    const title = 'Local account sign-in';
    if (!flags.localLogin) return page(req, res, url, title, note('Local account sign-in is disabled.'), 403);
    const returnUrl = destination(url, read);
    if (!read) return page(req, res, url, title, signInForm(req, res, returnUrl, flags));
    const name = key(read('UserName')),
      password = read('Password');
    const matches = flags.emailLogin ? accountsByEmail(name) : [usernames.get(name) ?? []].flat();
    const account = matches.length === 1 ? matches[0] : undefined;
    const rejection = passwordRejection(account, password, flags);
    if (rejection)
      return page(req, res, url, title, note(rejection[0]) + signInForm(req, res, returnUrl, flags), rejection[1]);
    const persistent = flags.rememberMe && read('RememberMe') === 'true';
    return confirmedPasswordSignIn(req, res, account, returnUrl, flags, persistent);
  }

  function verify(req, res, url, read, flags) {
    const title = 'Verify your local account';
    const [id, token] = String(parseCookies(req.headers.cookie)[mfaCookie()] ?? '').split('.');
    const account = accounts.get(id);
    const pending = flags.localLogin && flags.twoFactor && challengeFor(account, 'mfa', token);
    if (!pending) return page(req, res, url, title, note('Start a new local sign-in to receive a code.'), 403);
    if (flags.lockout && account.lockedUntil > now()) {
      consume(account, 'mfa');
      return page(req, res, url, title, note(LOCKED), 403);
    }
    const remember = flags.rememberBrowser
      ? '<label><input name="RememberBrowser" type="checkbox" value="true"> Remember browser?</label>'
      : '';
    const controls = () => form(req, res, ROUTES.verify, input('Code', 'Security code') + remember, 'Verify');
    if (!read) return page(req, res, url, title, controls());
    if (!sameToken(pending.code, digest(read('Code')))) {
      if (accessFailed(account, flags)) {
        consume(account, 'mfa');
        return page(req, res, url, title, note(LOCKED), 403);
      }
      if (++pending.attempts >= 5) consume(account, 'mfa');
      return page(req, res, url, title, note('The security code is incorrect.') + controls(), 403);
    }
    consume(account, 'mfa');
    account.failures = 0;
    const cookies = [clearMfa()];
    if (flags.rememberBrowser && read('RememberBrowser') === 'true') cookies.push(rememberBrowser(account));
    return signIn(res, account, pending.returnUrl, cookies, {
      persistent: flags.rememberMe && pending.persistent,
    });
  }

  function forgot(req, res, url, read, flags) {
    const title = 'Reset your local password';
    if (!flags.localLogin || !flags.reset)
      return page(req, res, url, title, note('Password recovery is disabled.'), 403);
    if (!read) return page(req, res, url, title, form(req, res, ROUTES.forgot, emailInput, 'Send reset message'));
    const matches = accountsByEmail(key(read('Email')));
    if (matches.length === 1 && (!flags.resetConfirmed || matches[0].confirmed)) issueChallenge(matches[0], 'reset');
    return page(req, res, url, title, note(RECOVERY_SENT));
  }

  function reset(req, res, url, read, flags) {
    const title = 'Reset your local password';
    const account = accounts.get(read?.('Account') || url.searchParams.get('account'));
    const token = read?.('Token') || url.searchParams.get('token');
    if (!flags.localLogin || !flags.reset || !challengeFor(account, 'reset', token))
      return page(req, res, url, title, note('This reset link is invalid or expired.'), 403);
    if (!read)
      return page(
        req,
        res,
        url,
        title,
        form(
          req,
          res,
          ROUTES.reset,
          `<input type="hidden" name="Account" value="${escape(account.contactId)}"><input type="hidden" name="Token" value="${escape(token)}">${passwordInput}${confirmInput}`,
          'Reset password',
        ),
      );
    if (!validPassword(read('Password'), flags) || read('Password') !== read('ConfirmPassword'))
      return page(req, res, url, title, note('The new passwords must match and meet the site policy.'), 400);
    updatePassword(account, read('Password'));
    consume(account, 'reset');
    reissueConfirmation(account);
    return page(req, res, url, title, note('Your local password has been reset.'));
  }

  function confirm(req, res, url) {
    const title = 'Confirm your email address';
    const account = accounts.get(url.searchParams.get('account'));
    if (!challengeFor(account, 'confirm', url.searchParams.get('token')))
      return page(req, res, url, title, note('This confirmation link is invalid or expired.'), 403);
    account.confirmed = true;
    consume(account, 'confirm');
    return page(req, res, url, title, note('Your email address is confirmed.'));
  }

  function accountManagementForm(req, res, isPassword, account) {
    const old = input('OldPassword', 'Current password', 'password');
    if (isPassword) return form(req, res, ROUTES.change, old + passwordInput + confirmInput, 'Change password');
    const button = account.twoFactor ? 'Disable two-factor authentication' : 'Enable two-factor authentication';
    return form(
      req,
      res,
      ROUTES.twoFactor,
      old + `<input type="hidden" name="Enabled" value="${!account.twoFactor}">`,
      button,
    );
  }

  function manage(req, res, url, read, flags, kind) {
    const isPassword = kind === 'change',
      title = isPassword ? 'Change your local password' : 'Local two-factor authentication';
    const account = accountForSession(signedSession(req));
    if (!account || !flags.localLogin || (!isPassword && (!flags.twoFactor || !account.confirmed)))
      return page(req, res, url, title, note('An eligible local account session is required.'), 403);
    if (!read) return page(req, res, url, title, accountManagementForm(req, res, isPassword, account));
    const password = read('OldPassword');
    if (!password || password.length > 256 || !verifyPassword(password, account.verifier))
      return page(req, res, url, title, note(INVALID_SIGN_IN), 403);
    if (isPassword) {
      if (!validPassword(read('Password'), flags) || read('Password') !== read('ConfirmPassword'))
        return page(req, res, url, title, note('The new passwords must match and meet the site policy.'), 400);
      updatePassword(account, read('Password'));
      reissueConfirmation(account);
      return signIn(res, account, '/');
    }
    if (!['true', 'false'].includes(read('Enabled')))
      return page(req, res, url, title, note('Select whether to require a second factor.'), 400);
    account.twoFactor = read('Enabled') === 'true';
    account.stamp = challengeToken();
    return signIn(res, account, '/');
  }

  const handlers = new Map([
    [key(ROUTES.login), login],
    [key(ROUTES.register), register],
    [key(ROUTES.forgot), forgot],
    [key(ROUTES.reset), reset],
    [key(ROUTES.confirm), confirm],
    [key(ROUTES.verify), verify],
    [key(ROUTES.change), (req, res, url, read, flags) => manage(req, res, url, read, flags, 'change')],
    [key(ROUTES.twoFactor), (req, res, url, read, flags) => manage(req, res, url, read, flags, 'twoFactor')],
  ]);
  return {
    enabled,
    messages: () =>
      [...mailbox].flatMap(([id, { accountId, ...message }]) => {
        const account = accounts.get(accountId);
        const challenge = challenges.get(id);
        return activeAccount(account) &&
          challenge?.stamp === account.stamp &&
          message.to === contactEmail(account) &&
          message.expiresAt > now()
          ? [message]
          : [];
      }),
    clear() {
      accounts.clear();
      usernames.clear();
      challenges.clear();
      mailbox.clear();
    },
    validSession: (session) => Boolean(accountForSession(session)),
    signInLink: (returnUrl) =>
      enabled && settingsFor(portal()).localLogin
        ? `<p><a href="${ROUTES.login}?ReturnUrl=${encodeURIComponent(returnUrl)}">Sign in with a local account</a></p>`
        : '',
    registrationAvailable: () => enabled && registrationAllowed(settingsFor(portal())),
    async route(req, res, url) {
      if (!enabled) return false;
      const path = key(url.pathname).replace(/\/$/, '');
      const handler = handlers.get(path);
      if (!handler) return false;
      const methods = handler === confirm ? ['GET'] : ['GET', 'HEAD', 'POST'];
      if (!methods.includes(req.method)) {
        res.writeHead(405, { allow: methods.join(', '), 'cache-control': 'no-store' });
        res.end();
        return true;
      }
      const read = req.method === 'POST' ? await readForm(req) : null;
      const token = read?.('__RequestVerificationToken');
      if (read && !sameToken(token, requestTokens.expected(req, token))) {
        await page(req, res, url, 'Local account request refused', note('The form token is missing or invalid.'), 403);
        return true;
      }
      const flags = settingsFor(portal());
      flags.rememberMe &&= canRememberSession();
      flags.rememberBrowser &&= canRememberBrowser();
      await handler(req, res, url, read, flags);
      return true;
    },
  };
}
