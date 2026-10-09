// Shared sign-in helpers for tests and tools that request portal routes as a persona.
// Portal routes take their identity from the paqvilo-mirage-auth session cookie only (anonymous
// without it); see docs/sim-administration.md, "Sign-in, sign-out and sessions".

/**
 * Request headers for fetch() calls signed in as a contact (an active local contact),
 * or with `{ roles }` as a manual role override: `{ cookie: "paqvilo-mirage-auth=…" }`.
 */
export function signInHeaders(simulator, contactId, options = {}) {
  return { cookie: simulator.signIn(contactId, options).cookieHeader };
}

/**
 * Sign a Playwright browser context in through the session API. The context's request
 * client shares its cookies, so every page of the context is signed in afterwards.
 * Returns the session description (`{ signedIn, contactId, name, roles, … }`).
 */
export async function signInContext(context, simulator, contactId, options = {}) {
  const response = await context.request.post(`${simulator.url}/_sim/api/session/sign-in`, {
    headers: { "x-sim-csrf": simulator.state().csrf },
    data: { contactId, ...(options.roles ? { roles: options.roles } : {}) },
  });
  if (!response.ok()) throw new Error(`Sign-in as ${contactId} failed with HTTP ${response.status()}: ${await response.text()}`);
  return response.json();
}
