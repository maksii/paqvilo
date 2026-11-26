import { createHmac, randomBytes } from 'node:crypto';
import { sameToken } from './admin-origin.mjs';
import { AUTH_COOKIE, parseCookies } from './auth-session.mjs';

const BINDING_ID = /^[0-9a-f]{32}$/;
const BINDING_COOKIE = /^(?:-\d+)?-request-binding(?:-\d+)?$/;
const BINDING_SLOTS = 4;
const BINDING_LIFETIME_SECONDS = 24 * 60 * 60;

export const isPortalBindingCookie = (name) =>
  name.startsWith(AUTH_COOKIE) && BINDING_COOKIE.test(name.slice(AUTH_COOKIE.length));

/** A runtime-specific browser cookie binds request tokens without changing the trusted tool token. */
export function createPortalRequestTokens({ enabled, toolToken, browser, cookieName, session, clock = Date.now }) {
  if (!enabled) {
    const token = () => toolToken;
    return { expected: token, issue: token };
  }
  const secret = randomBytes(32);
  const requests = new WeakMap();
  let nextSlot = 0;
  const now = () => Math.floor(clock() / 1000);
  const sign = (purpose, value) =>
    createHmac('sha256', secret).update(purpose).update('\0').update(value).digest('hex');
  const formToken = (browserId, owner) => sign('portal request', JSON.stringify([browserId, owner]));
  const bindingProof = (slot, browserId, expiry) => sign('browser binding', JSON.stringify([slot, browserId, expiry]));
  const slotName = (slot) => cookieName() + '-' + slot;

  function bindingId(value, slot) {
    const [id, expiry, proof, extra] = String(value ?? '').split('.');
    if (!BINDING_ID.test(id) || !/^\d{1,13}$/.test(expiry ?? '') || Number(expiry) <= now() || extra !== undefined)
      return null;
    return sameToken(proof, bindingProof(slot, id, expiry)) ? id : null;
  }

  function requestState(req) {
    if (!browser(req)) return null;
    const cached = requests.get(req);
    if (cached) return cached;
    const selected = session(req);
    const owner = selected?.sessionId ?? [selected?.contactId ?? null, selected?.credentialStamp ?? null];
    const cookies = parseCookies(req.headers.cookie);
    const tokens = [];
    for (let slot = 0; slot < BINDING_SLOTS; slot++) {
      const id = bindingId(cookies[slotName(slot)], slot);
      if (id) tokens.push(formToken(id, owner));
    }
    const state = { owner, tokens, issued: null };
    requests.set(req, state);
    return state;
  }

  return {
    expected(req, supplied) {
      const state = requestState(req);
      if (!state) return toolToken;
      return state.tokens.find((token) => sameToken(supplied, token)) ?? null;
    },
    issue(req, res) {
      const state = requestState(req);
      if (!state) return toolToken;
      if (state.tokens.length) return state.tokens[0];
      if (req.method === 'HEAD') return '';
      if (!state.issued) {
        const slot = nextSlot;
        nextSlot = (nextSlot + 1) % BINDING_SLOTS;
        const browserId = randomBytes(16).toString('hex');
        const expiry = String(now() + BINDING_LIFETIME_SECONDS);
        const proof = bindingProof(slot, browserId, expiry);
        res.appendHeader(
          'set-cookie',
          slotName(slot) +
            '=' +
            browserId +
            '.' +
            expiry +
            '.' +
            proof +
            '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' +
            BINDING_LIFETIME_SECONDS,
        );
        state.issued = formToken(browserId, state.owner);
      }
      return state.issued;
    },
  };
}
