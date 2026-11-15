// Request cases of a live capture's write decision, shared by the page guard tests and the browser-net decision tests.
// Each case states the request in terms both harnesses take; `block` is the expected outcome on either side. A case with
// `pageGuard: false` cannot be replayed through the page guard as written (see its name).
const origin = 'https://portal.invalid';
const identityReferer = 'https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize';
const at = (path) => `${origin}${path}`;
const request = (method, url, { navigation = false, headers = {} } = {}) => ({ method, url, navigation, headers });

export const captureDecisionCases = [
  // Reads, and requests to other origins, continue.
  {
    name: 'a GET of the captured origin continues',
    options: {},
    request: request('GET', at('/_api/accounts')),
    block: false,
  },
  { name: 'a HEAD of the captured origin continues', options: {}, request: request('HEAD', at('/')), block: false },
  {
    name: 'an OPTIONS of the captured origin continues',
    options: {},
    request: request('OPTIONS', at('/_api/accounts')),
    block: false,
  },
  {
    name: 'a write to another host continues',
    options: {},
    request: request('POST', 'https://login.example.test/common/x'),
    block: false,
  },
  {
    name: 'a fetch POST to an identity host continues',
    options: {},
    request: request('POST', 'https://login.microsoftonline.com/tenant/oauth2/token'),
    block: false,
  },
  {
    name: 'a top-level navigation POST to an identity host continues',
    options: {},
    request: request('POST', 'https://login.microsoftonline.com/tenant/login', { navigation: true }),
    block: false,
  },
  {
    name: 'a top-level navigation POST to a B2C host continues',
    options: {},
    request: request('POST', 'https://tenant.b2clogin.com/tenant/login', { navigation: true }),
    block: false,
  },
  // A plain write to the captured origin is blocked unless the run allows it.
  {
    name: 'a write to the captured origin is blocked',
    options: {},
    request: request('POST', at('/_api/accounts')),
    block: true,
  },
  {
    name: 'a runtime path on the captured origin is blocked',
    options: {},
    request: request('POST', at('/__sim/events')),
    block: true,
  },
  {
    name: 'allowed paths alone do not allow a write',
    options: { allowPaths: [String.raw`^/Account/Save\.aspx$`] },
    request: request('POST', at('/Account/Save.aspx')),
    block: true,
  },
  {
    name: 'an allowed path of a run with writes continues',
    options: { allowWrites: true, allowPaths: [String.raw`^/Account/Save\.aspx$`] },
    request: request('POST', at('/Account/Save.aspx')),
    block: false,
  },
  {
    name: 'an entity set of a run with writes continues',
    options: { allowWrites: true, allowEntitySets: ['accounts'] },
    request: request('POST', at('/_api/accounts')),
    block: false,
  },
  {
    name: 'another entity set of a run with writes is blocked',
    options: { allowWrites: true, allowEntitySets: ['accounts'] },
    request: request('POST', at('/_api/contacts')),
    block: true,
  },
  {
    name: 'an entity set of a run without writes is blocked',
    options: { allowEntitySets: ['accounts'] },
    request: request('POST', at('/_api/accounts')),
    block: true,
  },
  // Portal list, grid and note data is fetched with POST and reads only.
  {
    name: 'a grid data POST is a read and continues',
    options: {},
    request: request('POST', at('/_services/entity-grid-data.json')),
    block: false,
  },
  {
    name: 'a note read POST is a read and continues',
    options: {},
    request: request('POST', at('/_services/entity-notes/note-1')),
    block: false,
  },
  {
    name: 'a grid data POST is blocked when the run names other read paths',
    options: { readPosts: ['^/_services/other$'] },
    request: request('POST', at('/_services/entity-grid-data.json')),
    block: true,
  },
  // Sign-in navigations continue; the same request as a fetch is a write.
  {
    name: 'a login-page POST is blocked',
    options: {},
    request: request('POST', at('/Account/Login/Login.aspx'), { navigation: true }),
    block: true,
  },
  {
    name: 'a login-page POST continues only in a run that allows its path',
    options: { allowWrites: true, allowPaths: [String.raw`^/Account/Login/Login\.aspx$`] },
    request: request('POST', at('/Account/Login/Login.aspx'), { navigation: true }),
    block: false,
  },
  {
    name: 'a provider callback with an identity referer continues',
    options: {},
    request: request('POST', at('/callback'), { navigation: true, headers: { referer: identityReferer } }),
    block: false,
  },
  {
    name: 'the identity referer is read whatever the header name case',
    options: {},
    request: request('POST', at('/callback'), { navigation: true, headers: { Referer: identityReferer } }),
    block: false,
    // Playwright delivers header names in lower case, so the page guard reads only `referer`.
    pageGuard: false,
  },
  {
    name: 'an identity origin header continues',
    options: {},
    request: request('POST', at('/callback'), { navigation: true, headers: { origin: 'https://login.live.com' } }),
    block: false,
  },
  {
    name: 'a same-origin document with a B2C referer continues',
    options: {},
    request: request('POST', at('/callback'), {
      navigation: true,
      headers: { referer: 'https://tenant.b2clogin.com/tenant/oauth2/authorize' },
    }),
    block: false,
  },
  {
    name: 'a lookalike identity referer does not continue',
    options: {},
    request: request('POST', at('/callback'), {
      navigation: true,
      headers: { referer: 'https://login.microsoftonline.com.lookalike.invalid/authorize' },
    }),
    block: true,
  },
  {
    name: 'the external sign-in challenge continues',
    options: {},
    request: request('POST', at('/Account/Login/ExternalLogin'), { navigation: true }),
    block: false,
  },
  {
    name: 'a fetch to the external sign-in challenge is blocked',
    options: {},
    request: request('POST', at('/Account/Login/ExternalLogin')),
    block: true,
  },
  {
    name: 'a sign-in path navigation continues',
    options: {},
    request: request('POST', at('/signin-aad'), { navigation: true }),
    block: false,
  },
  {
    name: 'a fetch to a sign-in path is a write and is blocked',
    options: {},
    request: request('POST', at('/signin-aad')),
    block: true,
  },
  {
    name: 'a fetch with an identity referer is a write and is blocked',
    options: {},
    request: request('POST', at('/_api/accounts'), { headers: { referer: identityReferer } }),
    block: true,
  },
  // A local runtime's instrumentation endpoint is read on loopback only.
  {
    name: 'a loopback runtime event post continues',
    options: { origin: 'http://localhost:8080' },
    request: request('POST', 'http://localhost:8080/__sim/events'),
    block: false,
  },
  {
    name: 'a loopback write outside the runtime path is blocked',
    options: { origin: 'http://localhost:8080' },
    request: request('POST', 'http://localhost:8080/_api/accounts'),
    block: true,
  },
];
