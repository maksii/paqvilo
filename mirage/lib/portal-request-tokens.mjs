import { createHmac, randomBytes } from 'node:crypto';
import { sameToken } from './admin-origin.mjs';
import { AUTH_COOKIE, parseCookies } from './auth-session.mjs';

const BINDING_ID = /^[0-9a-f]{32}$/;
const BINDING_COOKIE = /^(?:-\d+)?-request-binding(?:-\d+)?$/;
const BINDING_SLOTS = 4;
const BINDING_LIFETIME_SECONDS = 24 * 60 * 60;
// A browser request token: the browser's tag (8 bytes), its owner's tag (8 bytes) and their signature (16 bytes), hex.
const FORM_TOKEN = /^([0-9a-f]{16})([0-9a-f]{16})([0-9a-f]{32})$/;

// The token refusals: why a request token is refused, in the order the platform's anti-forgery validation reports it
// (hosted session F4, paqvilo-developer hosted-f4 swap runs a and b): `missing` (no token), `undecryptable` (not a
// token this runtime issued), `mismatch` (issued to another browser) and `user` (issued to this browser for another
// sign-in).

export const isPortalBindingCookie = (name) =>
  name.startsWith(AUTH_COOKIE) && BINDING_COOKIE.test(name.slice(AUTH_COOKIE.length));

/** A runtime-specific browser cookie binds request tokens without changing the trusted tool token. */
export function createPortalRequestTokens({ enabled, toolToken, browser, cookieName, session, clock = Date.now }) {
  if (!enabled) {
    const token = () => toolToken;
    const refusal = (_req, supplied) => {
      if (supplied == null || supplied === '') return 'missing';
      return sameToken(supplied, toolToken) ? null : 'undecryptable';
    };
    return { expected: token, issue: token, refusal };
  }
  const secret = randomBytes(32);
  const requests = new WeakMap();
  let nextSlot = 0;
  const now = () => Math.floor(clock() / 1000);
  const sign = (purpose, value) =>
    createHmac('sha256', secret).update(purpose).update('\0').update(value).digest('hex');
  const browserTag = (browserId) => sign('browser tag', browserId).slice(0, 16);
  const ownerTag = (owner) => sign('owner tag', JSON.stringify(owner)).slice(0, 16);
  const tokenOf = (browser, owner) => browser + owner + sign('portal request', browser + owner).slice(0, 32);
  const bindingProof = (slot, browserId, expiry) => sign('browser binding', JSON.stringify([slot, browserId, expiry]));
  const slotName = (slot) => cookieName() + '-' + slot;

  function bindingId(value, slot) {
    const parts = String(value ?? '').split('.');
    if (parts.length !== 3) return null;
    const [id, expiry, proof] = parts;
    if (!BINDING_ID.test(id) || !/^\d{1,13}$/.test(expiry) || Number(expiry) <= now()) return null;
    return sameToken(proof, bindingProof(slot, id, expiry)) ? id : null;
  }

  function requestState(req) {
    if (!browser(req)) return null;
    const cached = requests.get(req);
    if (cached) return cached;
    const selected = session(req);
    const owner = selected?.sessionId ?? [selected?.contactId ?? null, selected?.credentialStamp ?? null];
    const cookies = parseCookies(req.headers.cookie);
    const browsers = [];
    for (let slot = 0; slot < BINDING_SLOTS; slot++) {
      const id = bindingId(cookies[slotName(slot)], slot);
      if (id) browsers.push(browserTag(id));
    }
    const state = { owner: ownerTag(owner), browsers, issued: null };
    requests.set(req, state);
    return state;
  }

  /** The refusal of a token in a browser request, or null when it names this browser and its current sign-in. */
  function browserRefusal(state, supplied) {
    if (supplied == null || supplied === '') return 'missing';
    const parts = FORM_TOKEN.exec(String(supplied));
    if (!parts || !sameToken(supplied, tokenOf(parts[1], parts[2]))) return 'undecryptable';
    if (!state.browsers.includes(parts[1])) return 'mismatch';
    return parts[2] === state.owner ? null : 'user';
  }

  return {
    expected(req, supplied) {
      const state = requestState(req);
      if (!state) return toolToken;
      return browserRefusal(state, supplied) === null ? String(supplied) : null;
    },
    /** Why `supplied` is refused for this request (a token refusal), or null when it is accepted. */
    refusal(req, supplied) {
      const state = requestState(req);
      if (state) return browserRefusal(state, supplied);
      if (supplied == null || supplied === '') return 'missing';
      return sameToken(supplied, toolToken) ? null : 'undecryptable';
    },
    issue(req, res) {
      const state = requestState(req);
      if (!state) return toolToken;
      if (state.browsers.length) return tokenOf(state.browsers[0], state.owner);
      if (req.method === 'HEAD') return '';
      if (!state.issued) {
        const slot = nextSlot;
        nextSlot = (nextSlot + 1) % BINDING_SLOTS;
        const browserId = randomBytes(16).toString('hex');
        const expiry = String(now() + BINDING_LIFETIME_SECONDS);
        const proof = bindingProof(slot, browserId, expiry);
        // A browser-session cookie, as the platform's anti-forgery cookie (hosted session F4: session, HttpOnly,
        // SameSite=Lax); the signed expiry still ends the binding after 24 hours.
        res.appendHeader(
          'set-cookie',
          slotName(slot) + '=' + browserId + '.' + expiry + '.' + proof + '; Path=/; HttpOnly; SameSite=Lax',
        );
        state.issued = tokenOf(browserTag(browserId), state.owner);
      }
      return state.issued;
    },
  };
}
