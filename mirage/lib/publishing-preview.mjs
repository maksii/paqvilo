import { canPreviewUnpublished } from './page-access.mjs';
import { parseCookies } from './auth-session.mjs';

/*
 * The classic publishing preview toggle, issued locally. Classic PreviewPermission reads the Boolean
 * adxPreviewUnpublishedEntities cookie and, for a visitor with the website's Preview Unpublished Entities right, sets it to
 * "true" (Enable) or "false" (Disable) as a script-readable cookie; without the cookie preview is on. Mirage reads the same
 * cookie on every portal request (server.mjs requestPublishingPreview).
 * https://github.com/Adoxio/xRM-Portals-Community-Edition/blob/868decd55a6f/Framework/Adxstudio.Xrm/Web/Security/PreviewPermission.cs#L35-L94
 * https://learn.microsoft.com/power-pages/security/website-access-permission
 *
 * GET  /_sim/api/session/preview  this browser's eligibility, cookie value and effective preview state.
 * POST /_sim/api/session/preview  { enabled: true | false | null } sets the cookie to true or false, or clears it (null).
 * Only a signed-in session whose roles hold the right may set it; everyone else is refused and no cookie is written.
 */
const PREVIEW_COOKIE = 'adxPreviewUnpublishedEntities';

const refusal = (message, status, code) => Object.assign(new Error(message), { status, code });

// The cookie value as the request carries it, or null; an invalid present value disables preview (requestPublishingPreview).
function cookieValue(req) {
  const value = parseCookies(req.headers.cookie)[PREVIEW_COOKIE];
  return value == null ? null : value;
}

function describe(portal, identity, value) {
  const signedIn = Boolean(identity?.contactId ?? identity?.id);
  const eligible = signedIn && canPreviewUnpublished(portal, identity, true);
  const preference = value == null ? undefined : value.toLowerCase() === 'true';
  return {
    cookie: { name: PREVIEW_COOKIE, value },
    signedIn,
    eligible,
    enabled: eligible && canPreviewUnpublished(portal, identity, preference),
  };
}

function cookieHeader(enabled) {
  if (enabled === null) return `${PREVIEW_COOKIE}=; Path=/; Max-Age=0; SameSite=Lax`;
  return `${PREVIEW_COOKIE}=${enabled ? 'true' : 'false'}; Path=/; SameSite=Lax`;
}

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

/**
 * Answers GET and POST /__sim/api/session/preview. `identity` is this browser's session identity (anonymous without a
 * session), `csrf` whether the request carries the administration CSRF token and `body()` reads the JSON body.
 * Refusals are thrown as { status, code } errors for the administration error envelope.
 */
export async function handlePublishingPreview(req, res, { portal, identity, csrf, body }) {
  if (req.method === 'GET' || req.method === 'HEAD')
    return send(res, 200, describe(portal, identity, cookieValue(req)));
  if (req.method !== 'POST') throw refusal('Use GET or POST.', 405, 'METHOD_NOT_ALLOWED');
  if (!csrf) throw refusal('Missing simulator CSRF token.', 403, 'INVALID_REQUEST');
  const request = await body();
  const enabled = request?.enabled;
  if (enabled !== true && enabled !== false && enabled !== null)
    throw refusal('enabled must be true, false or null (clear the cookie).', 400, 'INVALID_REQUEST');
  const current = describe(portal, identity, cookieValue(req));
  if (!current.signedIn) throw refusal('Sign this browser in through the portal first.', 409, 'SESSION_NOT_SIGNED_IN');
  if (!current.eligible)
    throw refusal(
      'The signed-in contact has no web role with the Preview Unpublished Entities website access permission.',
      403,
      'PREVIEW_NOT_PERMITTED',
    );
  const value = enabled === null ? null : String(enabled);
  return send(res, 200, describe(portal, identity, value), { 'set-cookie': cookieHeader(enabled) });
}
