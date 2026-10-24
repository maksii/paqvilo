import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Local browser sign-in sessions (mirage/docs/sim-administration.md). The session cookie (HttpOnly, SameSite=Lax, Path=/, browser-session
 * lifetime) carries the signed-in contact id, or an explicit anonymous marker after
 * sign-out, signed with a per-process key: restarting the mirage signs every browser
 * out. Optional manual roles make an "override for this browser session". Browsers do
 * not separate cookies by port, so each runtime names its cookie after its listening
 * port (paqvilo-mirage-auth-<port>) and local portals on other ports keep their own sessions.
 */
export const AUTH_COOKIE = 'paqvilo-mirage-auth';

/** The session cookie name of a runtime listening on `port` (paqvilo-mirage-auth without one). */
export const authCookieName = (port) => (port ? `${AUTH_COOKIE}-${port}` : AUTH_COOKIE);

const encode = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
const decode = (value) => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));

/** Cookie header to { name: value } (first occurrence wins). */
export function parseCookies(header = '') {
  const cookies = new Map();
  for (const part of String(header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (name && !cookies.has(name)) cookies.set(name, part.slice(index + 1).trim());
  }
  return Object.fromEntries(cookies);
}

/** `name`: the cookie name, or a function returning it (known once the runtime listens). */
export function createAuthSessions({ secret = randomBytes(32), name = AUTH_COOKIE } = {}) {
  const cookieName = () => (typeof name === 'function' ? name() : name) || AUTH_COOKIE;
  const signature = (payload) => createHmac('sha256', secret).update(payload).digest('base64url');
  const value = (session) => {
    const payload = encode(
      session?.contactId
        ? {
            c: session.contactId,
            ...(Array.isArray(session.roles) ? { r: session.roles.map(String) } : {}),
            // The external identity provider that established the session (sign-out uses it).
            ...(typeof session.provider === 'string' && session.provider ? { p: session.provider } : {}),
          }
        : { c: null },
    );
    return `${payload}.${signature(payload)}`;
  };
  return {
    get name() {
      return cookieName();
    },
    /** Session from a Cookie header: { contactId, roles?, provider? }, { contactId: null } (signed out) or null. */
    read(header) {
      const raw = parseCookies(header)[cookieName()];
      if (!raw) return null;
      const dot = raw.lastIndexOf('.');
      if (dot < 1) return null;
      const payload = raw.slice(0, dot);
      const expected = Buffer.from(signature(payload));
      const actual = Buffer.from(raw.slice(dot + 1));
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
      try {
        const data = decode(payload);
        if (data.c === null) return { contactId: null };
        if (typeof data.c !== 'string' || !data.c) return null;
        return {
          contactId: data.c,
          ...(Array.isArray(data.r) ? { roles: data.r.filter((role) => typeof role === 'string') } : {}),
          ...(typeof data.p === 'string' && data.p ? { provider: data.p } : {}),
        };
      } catch {
        return null;
      }
    },
    value,
    /** Set-Cookie header for a session ({ contactId: null } = signed out). */
    cookie(session) {
      return `${cookieName()}=${value(session)}; Path=/; HttpOnly; SameSite=Lax`;
    },
  };
}

/**
 * A same-origin relative return path: starts with a single "/", no scheme, host,
 * backslash or control characters; anything else becomes the fallback.
 */
export function safeReturnUrl(value, fallback = '/') {
  if (typeof value !== 'string' || !value || value.length > 2048) return fallback;
  // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  let decoded;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  // eslint-disable-next-line no-control-regex -- This parser intentionally recognizes control bytes in untrusted text.
  if (decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)) return fallback;
  try {
    const resolved = new URL(value, 'http://local.invalid');
    if (resolved.origin !== 'http://local.invalid') return fallback;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return fallback;
  }
}

/** The ReturnUrl/returnUrl query parameter (name compared case-insensitively). */
export function returnUrlParameter(searchParams) {
  for (const [name, value] of searchParams) if (name.toLowerCase() === 'returnurl') return value;
  return null;
}

const SIGN_IN_PATHS = /^\/(?:signin|account\/login(?:\/(?:login|externallogin|register))?)\/?$/i;
const SIGN_OUT_PATH = /^\/account\/login\/logoff\/?$/i;

/**
 * Sign-in and sign-out routes: GET /SignIn, the site's LoginPath and /Account/Login[/Login|
 * /ExternalLogin|/Register] render the platform's sign-in page; POST /SignIn (or LoginPath)
 * signs in a local persona; /Account/Login/LogOff signs out. lib/sign-in-flow.mjs answers
 * the external sign-in routes (POST ExternalLogin, the provider's response, the
 * ExternalLoginCallback, RedeemInvitation and LogOff) before these.
 */
export function authRoute(pathname, method, { loginPath = '/signin' } = {}) {
  if (SIGN_OUT_PATH.test(pathname)) return { kind: 'sign-out' };
  // The site's configured LoginPath (Authentication/ApplicationCookie/LoginPath) is a
  // sign-in path as well; paths compare case-insensitively without a trailing "/".
  const trimmed = (value) => {
    const text = String(value);
    let end = text.length;
    while (end > 0 && text.charCodeAt(end - 1) === 47) end--;
    return text.slice(0, end).toLowerCase() || '/';
  };
  const login = trimmed(pathname) === trimmed(loginPath);
  if (!login && !SIGN_IN_PATHS.test(pathname)) return null;
  if (method === 'POST' && (login || /^\/signin\/?$/i.test(pathname))) return { kind: 'sign-in-post' };
  return { kind: 'sign-in-page' };
}

import { renderPersonaPicker } from './persona-picker-view.mjs';

const escapeHtml = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );

/**
 * The account tabs' keyboard behaviour (platform account layout): the active tab is the focusable
 * one (tabindex 0, aria-selected true) and takes focus on ready; arrows, Home and End move the
 * focus between tabs and Space opens the focused tab.
 */
const ACCOUNT_TABS_SCRIPT = `<script type="text/javascript">(function () {
  var keys = { END: 35, HOME: 36, LEFT: 37, RIGHT: 39, SPACE: 32 };
  var tabs = function () { return Array.prototype.slice.call(document.querySelectorAll(".nav.nav-tabs.nav-account > li > a")); };
  var ready = function () {
    tabs().forEach(function (tab) { var active = tab.classList.contains("active"); tab.setAttribute("tabindex", active ? "0" : "-1"); tab.setAttribute("aria-selected", active ? "true" : "false"); if (active) tab.focus(); });
  };
  window.navigation = function (event) {
    var list = tabs(), index = list.indexOf(document.activeElement);
    if (index >= 0 && [keys.END, keys.HOME, keys.LEFT, keys.RIGHT].indexOf(event.keyCode) >= 0) {
      var next = event.keyCode === keys.HOME ? 0 : event.keyCode === keys.END ? list.length - 1 : event.keyCode === keys.LEFT ? (index + list.length - 1) % list.length : (index + 1) % list.length;
      list[next].focus();
    }
    if (event.keyCode === keys.SPACE) { event.preventDefault(); document.activeElement.click(); list.forEach(function (tab) { tab.setAttribute("tabindex", "-1"); tab.setAttribute("aria-selected", "false"); }); }
  };
  if (window.jQuery) window.jQuery(ready); else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready); else ready();
})();</script>`;

/**
 * Content region of the platform's sign-in page (rendered inside the site's header and footer,
 * as the platform account layout). #content-container > #content holds the account
 * tabs (Sign in, Register when open registration is on, Redeem invitation when invitations are
 * on) and #mainContent: the page copy, then the external sign-in form.
 * - External providers: one form (POST /Account/Login/ExternalLogin?ReturnUrl=...,
 *   __RequestVerificationToken) with the login heading, the validation summary and one submit
 *   button named "provider" per provider: value and id the provider's AuthenticationType, text
 *   its Caption. `invitationCode` travels with them after a valid code was redeemed.
 * - Local personas: the simulator's stand-in for local accounts, listed when local sign-in
 *   is enabled or the site configures no external provider; visibly a local simulation.
 */
export function signInContent({
  personas = [],
  personaCatalog = null,
  providers = [],
  showPersonas = true,
  csrf = '',
  defaultContactId = null,
  returnUrl = '/',
  personaReturnUrl = returnUrl,
  anonymousUrl = '/',
  invitationCode = null,
  redeemInvitation = false,
  error = null,
  title = 'Sign in',
  copy = '',
  registerTab = false,
  redeemTab = false,
}) {
  const ordered = [...personas].sort(
    (a, b) =>
      Number(b.contactId === defaultContactId) - Number(a.contactId === defaultContactId) ||
      String(a.name ?? '').localeCompare(String(b.name ?? '')),
  );
  const action = `/Account/Login/ExternalLogin?ReturnUrl=${encodeURIComponent(returnUrl)}`;
  const summary = error
    ? `<div aria-describedby="loginValidationSummary" aria-label="Sign in failed." class="validation-summary-errors listStyleTypeNone alert alert-block alert-danger" data-valmsg-summary="true" id="loginValidationSummary" tabindex="0" role="alert"><ul><li>${escapeHtml(error)}</li></ul></div>`
    : `<div aria-describedby="loginValidationSummary" aria-label="Sign in failed." class="validation-summary-valid listStyleTypeNone alert alert-block alert-danger" data-valmsg-summary="true" id="loginValidationSummary" tabindex="0"><ul><li style="display:none"></li></ul></div>`;
  const external = providers.length
    ? [
        `<form action="${escapeHtml(action)}" method="post"><input name="__RequestVerificationToken" type="hidden" value="${escapeHtml(csrf)}">${invitationCode ? `<input name="InvitationCode" type="hidden" value="${escapeHtml(invitationCode)}">` : ''}<div class="">`,
        `<h2 class="login-heading-section" id="external-login-heading"><span class="xrm-editable-text xrm-attribute"><span class="xrm-attribute-value-encoded xrm-attribute-value">Sign in with an external account</span></span></h2>`,
        summary,
        `<div id="6_ctl00_AzureADRebrandDisclaimer"></div>`,
        ...providers.map((provider) => {
          const caption = provider.caption ?? provider.name;
          return `<button name="provider" type="submit" class="btn btn-primary btn-line" id="${escapeHtml(provider.id)}" title="Sign in with your ${escapeHtml(caption)} account." value="${escapeHtml(provider.id)}">${escapeHtml(caption)}</button>`;
        }),
        `</div></form>`,
      ].join('')
    : '';
  const rows = ordered
    .map((persona) => {
      const roles = (persona.roles ?? []).length ? persona.roles.join(', ') : 'no web roles';
      const organisation = persona.accountName ? ` · ${escapeHtml(persona.accountName)}` : '';
      const marker =
        persona.contactId === defaultContactId ? ' <span class="label label-info">default persona</span>' : '';
      return `<li class="list-group-item paqvilo-mirage-persona" data-contact-id="${escapeHtml(persona.contactId)}"><button type="submit" class="btn btn-primary btn-sm pull-right" name="contactId" value="${escapeHtml(persona.contactId)}">Sign in</button><strong>${escapeHtml(persona.name ?? persona.contactId)}</strong>${organisation}${marker}<br><small>${escapeHtml(roles)}</small></li>`;
    })
    .join('');
  const local = showPersonas
    ? [
        `<div class="paqvilo-mirage-local-accounts">`,
        `<p class="paqvilo-mirage-sign-in-label" style="display:inline-block;padding:2px 8px;border:1px dashed #8a6d3b;border-radius:4px;color:#8a6d3b;font-size:12px">Local sign-in simulation · no credentials are sent anywhere</p>`,
        providers.length
          ? `<p>Local accounts: choose a local persona (a contact in the simulator's data) instead of a username and password.</p>`
          : `<p>This site configures no external identity provider. Choose a local persona (a contact in the simulator's data) to continue as that user, or continue anonymously.</p>`,
        `<form method="post" action="/SignIn"><input type="hidden" name="ReturnUrl" value="${escapeHtml(personaCatalog?.enabled ? (personaReturnUrl ?? '') : returnUrl)}"><input name="__RequestVerificationToken" type="hidden" value="${escapeHtml(csrf)}">`,
        personaCatalog?.enabled
          ? renderPersonaPicker(personaCatalog, { mode: 'signin' })
          : ordered.length
            ? `<ul class="list-group">${rows}</ul>`
            : `<p>No local contacts are available. Create personas under <a href="/_sim/">Identity &amp; permissions</a>.</p>`,
        `</form>`,
        `<p><a class="paqvilo-mirage-continue-anonymously" href="${escapeHtml(anonymousUrl)}">Continue anonymously</a></p>`,
        `</div>`,
      ].join('')
    : '';
  const query = encodeURIComponent(returnUrl);
  // The platform's tab classes: "nav-link active", "nav-link " (Register), "nav-link  " (Redeem invitation).
  const tab = (label, href, active = false, icon = '', suffix = ' ') =>
    `<li role="none" class="nav-item"><a class="nav-link${active ? ' active' : suffix}" role="tab" aria-selected="${active ? 'True' : 'False'}" href="${escapeHtml(href)}" aria-label="${label}" title="${label}">${icon}${label}</a></li>`;
  const tabs = `<ul class="nav nav-tabs nav-account" role="tablist" onkeydown="navigation(event)">${[
    tab('Sign in', 'javascript:void(0)', true, '<span class="fa fa-sign-in" aria-hidden="true"></span> '),
    registerTab ? tab('Register', `/Account/Login/Register?returnUrl=${query}`) : '',
    redeemTab ? tab('Redeem invitation', `/Register?returnUrl=${query}`, false, '', '  ') : '',
  ].join('')}</ul>${ACCOUNT_TABS_SCRIPT}`;
  return [
    personaCatalog?.enabled
      ? '<link rel="stylesheet" href="/__sim/persona-picker.css"><script type="module" src="/__sim/persona-picker.mjs"></script>'
      : '',
    `<div id="content-container" class="container wrapper-body" role="main"><div id="content">${tabs}<div class="page-content" id="mainContent">`,
    `<div class="xrm-editable-html xrm-attribute${copy ? '' : ' no-value'} page-copy"><div class="xrm-attribute-value">${copy}</div></div>`,
    external ? `<div class="row"><div class="col-md-6">${external}</div></div>` : '',
    // On ready the page takes the active tab's text as its title and refreshes the anti-forgery token, as the platform does.
    `<script type="text/javascript">(function () { var run = function () { var active = document.querySelector(".nav-tabs > li > a.active"); document.querySelector("title").textContent = active ? active.textContent : ""; if (window.shell && typeof window.shell.refreshToken === "function") window.shell.refreshToken(); }; if (window.jQuery) window.jQuery(run); else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run); else run(); })();</script>`,
    // The local persona sign-in is the simulator's stand-in for local accounts (visibly marked).
    local
      ? `<section class="paqvilo-mirage-sign-in" aria-label="${escapeHtml(title)}">${error && !external ? `<div class="alert alert-danger" role="alert">${escapeHtml(error)}</div>` : ''}${local}</section>`
      : '',
    redeemInvitation && !redeemTab
      ? `<p><a class="paqvilo-mirage-redeem-invitation" href="/Account/Login/RedeemInvitation?ReturnUrl=${escapeHtml(query)}">Redeem invitation</a></p>`
      : '',
    !external && !local
      ? `<p>No sign-in method is available: external sign-in has no configured provider and local sign-in is turned off.</p>`
      : '',
    `</div></div></div>`,
  ].join('');
}
