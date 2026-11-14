// @test-kind security: a page on another origin must not read managed identity tokens, the directory, or sign-in codes and tokens from the Dataverse API listener.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { DataStore, emptyState } from '../lib/data.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { createManagedIdentityEndpoints } from '../lib/dataverse-managed-identity.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';

// A portal page's origin: the Origin a browser sends for a script or form on that page.
const PAGE = 'http://127.0.0.1:5555';
const PUBLIC_APP = '44444444-4444-4444-4444-444444444444';
const MI_CLIENT = '55555555-5555-5555-5555-555555555555';
const ADMIN_OID = '66666666-6666-6666-6666-666666666666';
const CONF_APP = '33333333-3333-3333-3333-333333333333';
const CONF_SECRET_VAR = 'PAQVILO_BROWSER_ORIGIN_SECRET';
const CONF_SECRET = 'archdv-invented-client-secret';
const SPA_APP = '77777777-7777-7777-7777-777777777777';
const SPA_REDIRECT = 'http://localhost:2/callback';
const SPA_ORIGIN = 'http://localhost:2';
const FORM = { 'content-type': 'application/x-www-form-urlencoded' };
process.env[CONF_SECRET_VAR] = CONF_SECRET;

// Headers a browser sends with a cross-origin script request from PAGE.
const fromPage = (extra = {}) => ({
  origin: PAGE,
  'sec-fetch-site': 'same-site',
  'sec-fetch-mode': 'cors',
  'sec-fetch-dest': 'empty',
  ...extra,
});
const corsOf = (res) => res.headers.get('access-control-allow-origin');

async function startApi({ clock } = {}) {
  const store = await new DataStore({ state: emptyState() }).init();
  const settings = dataverseSettings({
    enabled: true,
    applications: [
      {
        appId: PUBLIC_APP,
        displayName: 'Invented public',
        publicClient: true,
        redirectUris: ['http://localhost:1/cb'],
      },
      {
        appId: CONF_APP,
        displayName: 'Invented confidential',
        secretEnvironmentVariable: CONF_SECRET_VAR,
        roles: ['System Administrator'],
      },
      {
        appId: SPA_APP,
        displayName: 'Invented single-page',
        publicClient: true,
        spaRedirectUris: [SPA_REDIRECT],
      },
    ],
    users: [
      {
        domainname: 'admin@example.test',
        fullname: 'Invented Admin',
        objectId: ADMIN_OID,
        roles: ['System Administrator'],
      },
    ],
    managedIdentities: [{ clientId: MI_CLIENT, displayName: 'Invented MI', roles: ['System Administrator'] }],
  });
  let identity;
  const api = await startDataverseApi({
    store,
    settings,
    managedIdentity: (req) => identity?.handle(req) ?? null,
    clock,
    log: () => {},
  });
  identity = createManagedIdentityEndpoints({
    authority: { issueManagedIdentityToken: api.issueManagedIdentityToken },
    settings: { managedIdentities: settings.managedIdentities },
    origin: api.origin,
  });
  return { api, close: () => api.close() };
}

const imdsUrl = (origin) => {
  const url = new URL('/metadata/identity/oauth2/token', origin);
  url.searchParams.set('api-version', '2018-02-01');
  url.searchParams.set('resource', origin);
  url.searchParams.set('client_id', MI_CLIENT);
  return url.href;
};

test('a managed identity token is not readable from a browser origin, through the preflight or the GET', async () => {
  const { api, close } = await startApi();
  try {
    const url = imdsUrl(api.origin);
    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: fromPage({ 'access-control-request-method': 'GET', 'access-control-request-headers': 'metadata' }),
    });
    assert.equal(corsOf(preflight), null);

    const cross = await fetch(url, { headers: fromPage({ metadata: 'true' }) });
    assert.equal(cross.status, 200);
    assert.equal(corsOf(cross), null);

    const programmatic = await fetch(url, { headers: { metadata: 'true' } });
    assert.equal(programmatic.status, 200);
    assert.equal(typeof (await programmatic.json()).access_token, 'string');
  } finally {
    await close();
  }
});

const VERIFIER = 'archdv-invented-verifier-0123456789-abcdefghijklmnop';
const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');
const authorizeUrl = (origin) => {
  const url = new URL('/organizations/oauth2/v2.0/authorize', origin);
  url.search = new URLSearchParams({
    client_id: PUBLIC_APP,
    redirect_uri: 'http://localhost:1/cb',
    response_type: 'code',
    scope: `${origin}/.default`,
    code_challenge: CHALLENGE,
    code_challenge_method: 'S256',
  }).toString();
  return url.href;
};

test('the account pickers are not readable from a browser origin and still render for top-level navigation', async () => {
  const { api, close } = await startApi();
  try {
    const pickers = [`${api.origin}/common/oauth2/deviceauth`, authorizeUrl(api.origin)];
    for (const url of pickers) {
      const cross = await fetch(url, { headers: fromPage() });
      assert.equal(cross.status, 200);
      assert.equal(corsOf(cross), null);
      assert.match(await cross.text(), /name="oid"/);
    }
    const device = await fetch(pickers[0]);
    assert.match(await device.text(), /Invented Admin/);
  } finally {
    await close();
  }
});

const FORM_OF = (fields) => new URLSearchParams(fields);
const pickAccount = (origin, headers) =>
  fetch(`${origin}/organizations/oauth2/v2.0/authorize`, {
    method: 'POST',
    headers: { ...FORM, ...headers },
    body: FORM_OF({
      client_id: PUBLIC_APP,
      redirect_uri: 'http://localhost:1/cb',
      response_type: 'code',
      response_mode: 'form_post',
      scope: `${origin}/.default`,
      code_challenge: CHALLENGE,
      code_challenge_method: 'S256',
      oid: ADMIN_OID,
    }),
  });
const startDevice = async (origin) => {
  const res = await fetch(`${origin}/organizations/oauth2/v2.0/devicecode`, {
    method: 'POST',
    headers: FORM,
    body: FORM_OF({ client_id: PUBLIC_APP, scope: `${origin}/.default` }),
  });
  return res.json();
};
const approveDevice = (origin, headers, userCode) =>
  fetch(`${origin}/common/oauth2/deviceauth`, {
    method: 'POST',
    headers: { ...FORM, ...headers },
    body: FORM_OF({ otc: userCode, oid: ADMIN_OID }),
  });
const tokenFor = (origin, fields, headers = {}) =>
  fetch(`${origin}/organizations/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { ...FORM, ...headers },
    body: FORM_OF(fields),
  });
const tokenBody = async (pending) => {
  const response = await pending;
  return { status: response.status, body: await response.json() };
};
const pollDevice = async (origin, deviceCode) =>
  (
    await tokenFor(origin, {
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      client_id: PUBLIC_APP,
      device_code: deviceCode,
    })
  ).json();

test('a picker POST from a browser origin issues no code and approves no device', async () => {
  const { api, close } = await startApi();
  try {
    const refused = await pickAccount(api.origin, fromPage());
    const html = await refused.text();
    assert.equal(refused.status, 403);
    assert.doesNotMatch(html, /name="code"/);
    const printed = html.match(/name="code" value="([^"]+)"/)?.[1];
    const redeemed = await (
      await tokenFor(api.origin, {
        grant_type: 'authorization_code',
        client_id: PUBLIC_APP,
        code: printed ?? '',
        redirect_uri: 'http://localhost:1/cb',
        code_verifier: VERIFIER,
      })
    ).json();
    assert.equal(redeemed.access_token, undefined);

    const device = await startDevice(api.origin);
    const approval = await approveDevice(api.origin, fromPage({ 'sec-fetch-mode': 'navigate' }), device.user_code);
    assert.equal(approval.status, 403);
    assert.equal((await pollDevice(api.origin, device.device_code)).error, 'authorization_pending');
  } finally {
    await close();
  }
});

test('a picker POST from the listener own page, or a programmatic one, still issues a code and approves a device', async () => {
  const { api, close } = await startApi();
  try {
    const own = { origin: api.origin, 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' };
    const issued = await pickAccount(api.origin, own);
    assert.equal(issued.status, 200);
    assert.match(await issued.text(), /name="code" value="[^"]+"/);

    const programmatic = await pickAccount(api.origin, {});
    assert.equal(programmatic.status, 200);
    assert.match(await programmatic.text(), /name="code" value="[^"]+"/);

    const device = await startDevice(api.origin);
    const approval = await approveDevice(api.origin, own, device.user_code);
    assert.equal(approval.status, 200);
    assert.match(await approval.text(), /Device connected/);
    assert.equal(typeof (await pollDevice(api.origin, device.device_code)).access_token, 'string');
  } finally {
    await close();
  }
});

test('the account pickers cannot be framed', async () => {
  const { api, close } = await startApi();
  try {
    const picker = await fetch(authorizeUrl(api.origin));
    assert.equal(picker.headers.get('x-frame-options'), 'DENY');
    assert.equal(picker.headers.get('content-security-policy'), "frame-ancestors 'none'");
    const device = await fetch(`${api.origin}/common/oauth2/deviceauth`);
    assert.equal(device.headers.get('x-frame-options'), 'DENY');
  } finally {
    await close();
  }
});

// Programmatic (no Origin) picker POST: the code the sign-in page would print.
const issueCode = async (origin) => {
  const html = await (await pickAccount(origin, {})).text();
  const code = html.match(/name="code" value="([^"]+)"/)?.[1];
  assert.ok(code, 'a programmatic picker POST issues a code');
  return code;
};
const redeemCode = (origin, code, headers) =>
  tokenBody(
    tokenFor(
      origin,
      {
        grant_type: 'authorization_code',
        client_id: PUBLIC_APP,
        code,
        redirect_uri: 'http://localhost:1/cb',
        code_verifier: VERIFIER,
      },
      headers,
    ),
  );

test('a code or refresh token redeemed from a browser origin is refused as AADSTS9002326; the same calls without Origin succeed', async () => {
  const { api, close } = await startApi();
  try {
    const fromBrowser = await redeemCode(api.origin, await issueCode(api.origin), fromPage());
    assert.equal(fromBrowser.status, 400);
    assert.deepEqual(fromBrowser.body.error_codes, [9002326]);
    assert.equal(fromBrowser.body.access_token, undefined);

    const programmatic = await redeemCode(api.origin, await issueCode(api.origin), {});
    assert.equal(programmatic.status, 200);
    assert.equal(typeof programmatic.body.access_token, 'string');

    const refreshFromBrowser = await tokenBody(
      tokenFor(
        api.origin,
        { grant_type: 'refresh_token', client_id: PUBLIC_APP, refresh_token: programmatic.body.refresh_token },
        fromPage(),
      ),
    );
    assert.equal(refreshFromBrowser.status, 400);
    assert.deepEqual(refreshFromBrowser.body.error_codes, [9002326]);
    const refreshed = await tokenBody(
      tokenFor(api.origin, {
        grant_type: 'refresh_token',
        client_id: PUBLIC_APP,
        refresh_token: programmatic.body.refresh_token,
      }),
    );
    assert.equal(refreshed.status, 200);
  } finally {
    await close();
  }
});

test('a client secret presented from a browser origin is refused with AADSTS9002326, the code this simulator chose because Learn names none; without Origin it is accepted', async () => {
  const { api, close } = await startApi();
  try {
    const fields = {
      grant_type: 'client_credentials',
      client_id: CONF_APP,
      client_secret: CONF_SECRET,
      scope: `${api.origin}/.default`,
    };
    const fromBrowser = await tokenBody(tokenFor(api.origin, fields, fromPage()));
    assert.equal(fromBrowser.status, 400);
    assert.deepEqual(fromBrowser.body.error_codes, [9002326]);
    assert.equal(fromBrowser.body.access_token, undefined);

    const programmatic = await tokenBody(tokenFor(api.origin, fields));
    assert.equal(programmatic.status, 200);
    assert.equal(typeof programmatic.body.access_token, 'string');
  } finally {
    await close();
  }
});

// A single-page application's browser page: the origin of its SPA redirect URI.
const fromSpa = (extra = {}) => fromPage({ origin: SPA_ORIGIN, ...extra });
// The programmatic account choice for the single-page application. A null challenge or method leaves that field out.
const spaAuthorize = (origin, { challenge = CHALLENGE, method = 'S256' } = {}) => {
  const fields = {
    client_id: SPA_APP,
    redirect_uri: SPA_REDIRECT,
    response_type: 'code',
    response_mode: 'form_post',
    scope: `${origin}/.default`,
    oid: ADMIN_OID,
  };
  if (challenge !== null) fields.code_challenge = challenge;
  if (method !== null) fields.code_challenge_method = method;
  return fetch(`${origin}/organizations/oauth2/v2.0/authorize`, {
    method: 'POST',
    headers: FORM,
    body: FORM_OF(fields),
  });
};
const spaCode = async (origin) => {
  const html = await (await spaAuthorize(origin)).text();
  const code = html.match(/name="code" value="([^"]+)"/)?.[1];
  assert.ok(code, 'a PKCE authorization to the single-page redirect issues a code');
  return code;
};
const spaRedeem = (origin, code, headers = fromSpa(), verifier = VERIFIER) =>
  tokenFor(
    origin,
    {
      grant_type: 'authorization_code',
      client_id: SPA_APP,
      code,
      redirect_uri: SPA_REDIRECT,
      code_verifier: verifier,
    },
    headers,
  );
const refreshWith = (origin, refreshToken, headers = fromSpa()) =>
  tokenFor(origin, { grant_type: 'refresh_token', client_id: SPA_APP, refresh_token: refreshToken }, headers);

// @test-kind compatibility: Learn "Microsoft identity platform and OAuth 2.0 authorization code flow": a redirect URI of the SPA type may redeem its PKCE code cross-origin.
test('a single-page application redeems its PKCE code from its redirect origin, and the response names that origin with Vary: Origin', async () => {
  const { api, close } = await startApi();
  try {
    // Identity encoding keeps the reply ungzipped: a gzipped reply sets Vary to Accept-Encoding (send in dataverse-api.mjs).
    const res = await spaRedeem(api.origin, await spaCode(api.origin), fromSpa({ 'accept-encoding': 'identity' }));
    const body = await res.json();
    assert.equal(res.status, 200);
    assert.equal(typeof body.access_token, 'string');
    assert.equal(typeof body.refresh_token, 'string');
    assert.equal(corsOf(res), SPA_ORIGIN);
    assert.equal(res.headers.get('vary'), 'Origin');
  } finally {
    await close();
  }
});

// @test-kind contract: a gzipped single-page redemption keeps the Origin Vary token and adds Accept-Encoding beside it, never overwriting it.
test('a single-page redemption that accepts gzip keeps Origin in Vary beside Accept-Encoding and still names the single-page origin', async () => {
  const { api, close } = await startApi();
  try {
    const res = await spaRedeem(api.origin, await spaCode(api.origin), fromSpa({ 'accept-encoding': 'gzip' }));
    const tokens = String(res.headers.get('vary'))
      .split(',')
      .map((token) => token.trim().toLowerCase());
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.equal(corsOf(res), SPA_ORIGIN);
    assert.deepEqual(tokens.toSorted(), ['accept-encoding', 'origin']);
  } finally {
    await close();
  }
});

// @test-kind contract: Paqvilo's header rule for token responses: a grant that is not a single-page redemption keeps the wildcard.
test('a device-code token polled from a browser origin keeps the wildcard CORS header and no Origin Vary', async () => {
  const { api, close } = await startApi();
  try {
    const device = await startDevice(api.origin);
    const approval = await approveDevice(
      api.origin,
      { origin: api.origin, 'sec-fetch-site': 'same-origin' },
      device.user_code,
    );
    assert.equal(approval.status, 200);
    const polled = await tokenFor(
      api.origin,
      {
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        client_id: PUBLIC_APP,
        device_code: device.device_code,
      },
      fromPage(),
    );
    assert.equal(polled.status, 200);
    assert.equal(corsOf(polled), '*');
    assert.doesNotMatch(String(polled.headers.get('vary')), /Origin/);
  } finally {
    await close();
  }
});

// @test-kind compatibility: Learn "Microsoft identity platform and OAuth 2.0 authorization code flow": PKCE is mandatory for the SPA type, and the S256 method is the one that protects the code.
test('a single-page redirect refuses an authorization request without an S256 code challenge with AADSTS9002325', async () => {
  const { api, close } = await startApi();
  try {
    for (const [challenge, method] of [
      [null, null],
      [CHALLENGE, 'plain'],
    ]) {
      const res = await spaAuthorize(api.origin, { challenge, method });
      assert.equal(res.status, 400);
      assert.match(await res.text(), /AADSTS9002325/);
    }
  } finally {
    await close();
  }
});

// @test-kind compatibility: Learn "Microsoft identity platform and OAuth 2.0 authorization code flow": cross-origin redemption is permitted only for the SPA client type, so another origin gets AADSTS9002326.
test('a single-page code redeemed from another origin is refused as AADSTS9002326, and the refusal leaves the code for its own origin', async () => {
  const { api, close } = await startApi();
  try {
    const code = await spaCode(api.origin);
    const other = await tokenBody(spaRedeem(api.origin, code, fromPage()));
    assert.equal(other.status, 400);
    assert.deepEqual(other.body.error_codes, [9002326]);
    assert.equal(other.body.access_token, undefined);

    const own = await tokenBody(spaRedeem(api.origin, code));
    assert.equal(own.status, 200);
  } finally {
    await close();
  }
});

// @test-kind compatibility: Learn "Microsoft identity platform and OAuth 2.0 authorization code flow": a SPA redemption still verifies the PKCE code_verifier.
test('a single-page code redeemed from its origin with the wrong code_verifier fails the PKCE check as AADSTS9002313', async () => {
  const { api, close } = await startApi();
  try {
    const wrong = 'archdv-invented-wrong-verifier-0123456789-abcdefgh';
    const res = await tokenBody(spaRedeem(api.origin, await spaCode(api.origin), fromSpa(), wrong));
    assert.equal(res.status, 400);
    assert.deepEqual(res.body.error_codes, [9002313]);
  } finally {
    await close();
  }
});

// @test-kind compatibility: Learn "Microsoft identity platform and OAuth 2.0 authorization code flow": a client secret is a credential, and the SPA exception covers the public exchange only.
test('a single-page application that presents a client secret from its origin is refused as AADSTS9002326', async () => {
  const { api, close } = await startApi();
  try {
    const code = await spaCode(api.origin);
    const withSecret = await tokenBody(
      tokenFor(
        api.origin,
        {
          grant_type: 'authorization_code',
          client_id: SPA_APP,
          client_secret: CONF_SECRET,
          code,
          redirect_uri: SPA_REDIRECT,
          code_verifier: VERIFIER,
        },
        fromSpa(),
      ),
    );
    assert.equal(withSecret.status, 400);
    assert.deepEqual(withSecret.body.error_codes, [9002326]);
    assert.equal(withSecret.body.access_token, undefined);
  } finally {
    await close();
  }
});

// @test-kind compatibility: Learn "Refresh tokens in the Microsoft identity platform" and "Microsoft identity platform and OAuth 2.0 authorization code flow": a refresh token from a spa redirect URI expires 24 hours after sign-in and rotations keep that expiry.
test('a single-page refresh token redeems only from its origin, and its rotations keep the 24-hour expiry of the sign-in', async () => {
  let nowMs = Date.now();
  const { api, close } = await startApi({ clock: () => nowMs });
  try {
    const signIn = await tokenBody(spaRedeem(api.origin, await spaCode(api.origin)));
    assert.equal(signIn.status, 200);

    nowMs += 23 * 60 * 60 * 1000;
    const other = await tokenBody(refreshWith(api.origin, signIn.body.refresh_token, fromPage()));
    assert.equal(other.status, 400);
    assert.deepEqual(other.body.error_codes, [9002326]);

    const rotated = await tokenBody(refreshWith(api.origin, signIn.body.refresh_token));
    assert.equal(rotated.status, 200);
    assert.equal(typeof rotated.body.refresh_token, 'string');

    nowMs += 60 * 60 * 1000 + 1;
    const expired = await tokenBody(refreshWith(api.origin, rotated.body.refresh_token));
    assert.equal(expired.status, 400);
    assert.deepEqual(expired.body.error_codes, [700082]);
  } finally {
    await close();
  }
});

test('a picker POST from an opaque frame or a sibling port of the listener host issues no code', async () => {
  const { api, close } = await startApi();
  try {
    const sibling = api.origin.replace(/:\d+$/, ':1');
    for (const headers of [
      { origin: 'null', 'sec-fetch-site': 'cross-site' },
      { origin: sibling, 'sec-fetch-site': 'same-site' },
    ]) {
      const refused = await pickAccount(api.origin, headers);
      assert.equal(refused.status, 403);
      assert.doesNotMatch(await refused.text(), /name="code"/);
    }
  } finally {
    await close();
  }
});

test('a picker POST that carries Sec-Fetch-Site but no Origin is refused, since a browser sends Origin on every POST', async () => {
  const { api, close } = await startApi();
  try {
    const refused = await pickAccount(api.origin, { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' });
    assert.equal(refused.status, 403);
    assert.doesNotMatch(await refused.text(), /name="code"/);
  } finally {
    await close();
  }
});

test('a device approval POST with neither Origin nor Sec-Fetch-Site, from a program, is accepted', async () => {
  const { api, close } = await startApi();
  try {
    const device = await startDevice(api.origin);
    const approval = await approveDevice(api.origin, {}, device.user_code);
    assert.equal(approval.status, 200);
    assert.match(await approval.text(), /Device connected/);
  } finally {
    await close();
  }
});

test('the preflight of the App Service and IMDS token endpoints carries no CORS header, and an ordinary preflight does', async () => {
  const { api, close } = await startApi();
  try {
    const preflight = (path) =>
      fetch(`${api.origin}${path}`, {
        method: 'OPTIONS',
        headers: fromPage({ 'access-control-request-method': 'GET', 'access-control-request-headers': 'metadata' }),
      });
    for (const path of ['/msi/token', '/metadata/identity/oauth2/token']) {
      const answered = await preflight(path);
      assert.equal(answered.status, 204);
      assert.equal(corsOf(answered), null);
    }
    // The same preflight on an ordinary path carries the header, so the absence above is the endpoint rule.
    const ordinary = await preflight('/common/discovery/instance');
    assert.equal(ordinary.status, 204);
    assert.equal(corsOf(ordinary), '*');
  } finally {
    await close();
  }
});
