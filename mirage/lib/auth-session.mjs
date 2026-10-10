import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Local browser sign-in sessions (docs/sim-administration.md, "Sign-in, sign-out and
 * sessions"). The session cookie (HttpOnly, SameSite=Lax, Path=/, browser-session
 * lifetime) carries the signed-in contact id, or an explicit anonymous marker after
 * sign-out, signed with a per-process key: restarting the mirage signs every browser
 * out. Optional manual roles make an "override for this browser session". Browsers do
 * not separate cookies by port, so each runtime names its cookie after its listening
 * port (paqvilo-mirage-auth-<port>) and local portals on other ports keep their own sessions.
 */
export const AUTH_COOKIE = "paqvilo-mirage-auth";

/** The session cookie name of a runtime listening on `port` (paqvilo-mirage-auth without one). */
export const authCookieName = (port) => (port ? `${AUTH_COOKIE}-${port}` : AUTH_COOKIE);

const encode = (value) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
const decode = (value) => JSON.parse(Buffer.from(value, "base64url").toString("utf8"));

/** Cookie header to { name: value } (first occurrence wins). */
export function parseCookies(header = "") {
  const cookies = {};
  for (const part of String(header ?? "").split(";")) {
    const index = part.indexOf("=");
    if (index < 1) continue;
    const name = part.slice(0, index).trim();
    if (name && !Object.hasOwn(cookies, name)) cookies[name] = part.slice(index + 1).trim();
  }
  return cookies;
}

/** `name`: the cookie name, or a function returning it (known once the runtime listens). */
export function createAuthSessions({ secret = randomBytes(32), name = AUTH_COOKIE } = {}) {
  const cookieName = () => (typeof name === "function" ? name() : name) || AUTH_COOKIE;
  const signature = (payload) => createHmac("sha256", secret).update(payload).digest("base64url");
  const value = (session) => {
    const payload = encode(
      session?.contactId
        ? {
            c: session.contactId,
            ...(Array.isArray(session.roles) ? { r: session.roles.map(String) } : {}),
            // The external identity provider that established the session (sign-out uses it).
            ...(typeof session.provider === "string" && session.provider ? { p: session.provider } : {}),
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
      const dot = raw.lastIndexOf(".");
      if (dot < 1) return null;
      const payload = raw.slice(0, dot);
      const expected = Buffer.from(signature(payload));
      const actual = Buffer.from(raw.slice(dot + 1));
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
      try {
        const data = decode(payload);
        if (data.c === null) return { contactId: null };
        if (typeof data.c !== "string" || !data.c) return null;
        return {
          contactId: data.c,
          ...(Array.isArray(data.r) ? { roles: data.r.filter((role) => typeof role === "string") } : {}),
          ...(typeof data.p === "string" && data.p ? { provider: data.p } : {}),
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
export function safeReturnUrl(value, fallback = "/") {
  if (typeof value !== "string" || !value || value.length > 2048) return fallback;
  if (!value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return fallback;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return fallback;
  }
  if (decoded.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(decoded)) return fallback;
  try {
    const resolved = new URL(value, "http://local.invalid");
    if (resolved.origin !== "http://local.invalid") return fallback;
    return resolved.pathname + resolved.search + resolved.hash;
  } catch {
    return fallback;
  }
}

/** The ReturnUrl/returnUrl query parameter (name compared case-insensitively). */
export function returnUrlParameter(searchParams) {
  for (const [name, value] of searchParams) if (name.toLowerCase() === "returnurl") return value;
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
export function authRoute(pathname, method, { loginPath = "/signin" } = {}) {
  if (SIGN_OUT_PATH.test(pathname)) return { kind: "sign-out" };
  // The site's configured LoginPath (Authentication/ApplicationCookie/LoginPath) is a
  // sign-in path as well; paths compare case-insensitively without a trailing "/".
  const trimmed = (value) => String(value).replace(/\/+$/, "").toLowerCase() || "/";
  const login = trimmed(pathname) === trimmed(loginPath);
  if (!login && !SIGN_IN_PATHS.test(pathname)) return null;
  if (method === "POST" && (login || /^\/signin\/?$/i.test(pathname))) return { kind: "sign-in-post" };
  return { kind: "sign-in-page" };
}

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * Content of the platform's sign-in page (rendered inside the site's header and footer).
 * - External providers: one form per provider, as the platform's /SignIn renders it (POST
 *   /Account/Login/ExternalLogin?ReturnUrl=..., __RequestVerificationToken, a submit
 *   button named "provider" whose value is the provider's AuthenticationType and whose
 *   text is its Caption; capture: docs/runtime-evidence.md).
 *   `invitationCode` travels with them after a valid code was redeemed.
 * - Local personas: the simulator's stand-in for local accounts, listed when local sign-in
 *   is enabled or the site configures no external provider; visibly a local simulation.
 */
export function signInContent({
  personas = [],
  providers = [],
  showPersonas = true,
  csrf = "",
  defaultContactId = null,
  returnUrl = "/",
  anonymousUrl = "/",
  invitationCode = null,
  redeemInvitation = false,
  error = null,
  title = "Sign in",
}) {
  const ordered = [...personas].sort(
    (a, b) => Number(b.contactId === defaultContactId) - Number(a.contactId === defaultContactId) || String(a.name ?? "").localeCompare(String(b.name ?? "")),
  );
  const action = `/Account/Login/ExternalLogin?ReturnUrl=${encodeURIComponent(returnUrl)}`;
  const external = providers.length
    ? [
        `<div class="paqvilo-mirage-external-providers">`,
        `<h2 class="h4">Sign in with an external account</h2>`,
        ...providers.map(
          (provider) =>
            `<form action="${escapeHtml(action)}" method="post" class="paqvilo-mirage-provider"><input name="__RequestVerificationToken" type="hidden" value="${escapeHtml(csrf)}">${invitationCode ? `<input name="InvitationCode" type="hidden" value="${escapeHtml(invitationCode)}">` : ""}<button name="provider" type="submit" class="btn btn-primary" value="${escapeHtml(provider.id)}" title="${escapeHtml(provider.caption ?? provider.name)}">${escapeHtml(provider.caption ?? provider.name)}</button></form>`,
        ),
        `</div>`,
      ].join("")
    : "";
  const rows = ordered
    .map((persona) => {
      const roles = (persona.roles ?? []).length ? persona.roles.join(", ") : "no web roles";
      const organisation = persona.accountName ? ` · ${escapeHtml(persona.accountName)}` : "";
      const marker = persona.contactId === defaultContactId ? ' <span class="label label-info">default persona</span>' : "";
      return `<li class="list-group-item paqvilo-mirage-persona" data-contact-id="${escapeHtml(persona.contactId)}"><button type="submit" class="btn btn-primary btn-sm pull-right" name="contactId" value="${escapeHtml(persona.contactId)}">Sign in</button><strong>${escapeHtml(persona.name ?? persona.contactId)}</strong>${organisation}${marker}<br><small>${escapeHtml(roles)}</small></li>`;
    })
    .join("");
  const local = showPersonas
    ? [
        `<div class="paqvilo-mirage-local-accounts">`,
        `<p class="paqvilo-mirage-sign-in-label" style="display:inline-block;padding:2px 8px;border:1px dashed #8a6d3b;border-radius:4px;color:#8a6d3b;font-size:12px">Local sign-in simulation · no credentials are sent anywhere</p>`,
        providers.length
          ? `<p>Local accounts: choose a local persona (a contact in the simulator's data) instead of a username and password.</p>`
          : `<p>This site configures no external identity provider. Choose a local persona (a contact in the simulator's data) to continue as that user, or continue anonymously.</p>`,
        `<form method="post" action="/SignIn"><input type="hidden" name="ReturnUrl" value="${escapeHtml(returnUrl)}"><input name="__RequestVerificationToken" type="hidden" value="${escapeHtml(csrf)}">`,
        ordered.length ? `<ul class="list-group">${rows}</ul>` : `<p>No local contacts are available. Create personas under <a href="/_sim/">Identity &amp; permissions</a>.</p>`,
        `</form>`,
        `<p><a class="paqvilo-mirage-continue-anonymously" href="${escapeHtml(anonymousUrl)}">Continue anonymously</a></p>`,
        `</div>`,
      ].join("")
    : "";
  return [
    `<section class="container paqvilo-mirage-sign-in" aria-labelledby="paqvilo-mirage-sign-in-title" style="margin:24px auto;max-width:760px">`,
    `<h1 id="paqvilo-mirage-sign-in-title">${escapeHtml(title)}</h1>`,
    error ? `<div class="alert alert-danger" role="alert">${escapeHtml(error)}</div>` : "",
    external,
    local,
    redeemInvitation ? `<p><a class="paqvilo-mirage-redeem-invitation" href="/Account/Login/RedeemInvitation?ReturnUrl=${escapeHtml(encodeURIComponent(returnUrl))}">Redeem invitation</a></p>` : "",
    !external && !local ? `<p>No sign-in method is available: external sign-in has no configured provider and local sign-in is turned off.</p>` : "",
    `</section>`,
  ].join("");
}
