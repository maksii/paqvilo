// Anonymous browser visitors of a local runtime, for state the platform keeps per anonymous
// visitor (advanced form sessions: adx_webformsession of an anonymous user). The cookie
// (HttpOnly, SameSite=Lax, Path=/, browser-session lifetime) holds a random id; like the
// sign-in cookie it is named after the listening port (paqvilo-mirage-visitor-<port>), because
// browsers share cookies across ports. It carries no identity and grants nothing.
import { randomUUID } from "node:crypto";
import { parseCookies } from "./auth-session.mjs";

export const VISITOR_COOKIE = "paqvilo-mirage-visitor";

/** The visitor cookie name of a runtime listening on `port` (paqvilo-mirage-visitor without one). */
export const visitorCookieName = (port) => (port ? `${VISITOR_COOKIE}-${port}` : VISITOR_COOKIE);

const VISITOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The visitor id from a Cookie header, or null when absent or malformed. */
export function readVisitor(header, name = VISITOR_COOKIE) {
  const value = parseCookies(header)[name];
  return VISITOR_ID.test(value ?? "") ? value.toLowerCase() : null;
}

/** A new visitor id and its Set-Cookie header value. */
export function newVisitor(name = VISITOR_COOKIE) {
  const id = randomUUID();
  return { id, cookie: `${name}=${id}; Path=/; HttpOnly; SameSite=Lax` };
}
