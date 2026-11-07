// Shared invented-client helpers for tests that call a running local Dataverse Web API.

/** JSON request bound to a bearer header; answers `{ status, headers, json }`. */
export function jsonRequester(base, authorization) {
  return async (method, path, body, headers = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { authorization, 'content-type': 'application/json', accept: 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    return { status: response.status, headers: response.headers, json: text ? JSON.parse(text) : null };
  };
}

/** Sign an invented application in with client credentials and return its JSON `request`. */
export async function signedInRequester(server, appId, secret) {
  const token = await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: secret,
      scope: `${server.origin}/.default`,
    }),
  });
  return jsonRequester(`${server.origin}/api/data/v9.2`, `Bearer ${(await token.json()).access_token}`);
}

/** One fetch per call. A JSON body is serialised; `token()` supplies the default bearer token. */
export function bearerCall(origin, token) {
  return (path, { token: explicit = token(), method = 'GET', body } = {}) =>
    fetch(`${origin}${path}`, {
      method,
      headers: {
        ...(explicit ? { authorization: `Bearer ${explicit}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
}

/** Sign an invented application in with client credentials and return `call(method, suffix, body)`. */
export async function clientCredentialsCall(api, appId, secret) {
  const token = await (
    await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: secret,
        scope: `${api.origin}/.default`,
      }),
    })
  ).json();
  return (method, suffix, body) =>
    fetch(`${api.origin}/api/data/v9.2/${suffix}`, {
      method,
      headers: {
        authorization: `Bearer ${token.access_token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
}
