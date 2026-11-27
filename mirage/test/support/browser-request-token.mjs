// The request token a browser's pages carry, for the suites that post portal APIs as a browser does.

// The request token a browser's pages carry for these cookies, with the binding cookie it pairs with (browser request
// tokens are paired by default): { token, cookie } where cookie also holds the given cookies.
export async function browserToken(sim, headers = {}) {
  const response = await fetch(`${sim.url}/_layout/tokenhtml`, {
    headers: { origin: sim.url, ...(headers.cookie ? { cookie: headers.cookie } : {}) },
  });
  const token = /value="([^"]+)"/.exec(await response.text())[1];
  const binding = response.headers
    .getSetCookie()
    .find((line) => line.includes('-request-binding-'))
    .split(';')[0];
  return { token, cookie: [headers.cookie, binding].filter(Boolean).join('; ') };
}
