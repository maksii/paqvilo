// Client-credentials and Web API call helpers shared by Mirage tests that call a running local Dataverse API as invented applications.

/** Access token for an application whose secret is read from the named environment variable. */
export async function tokenFor(api, appId, secretVar) {
  const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: process.env[secretVar],
      scope: `${api.origin}/.default`,
    }),
  });
  return (await response.json()).access_token;
}

/** One Web API call with the given headers; answers the status, the headers, the body text and its parsed JSON. */
export async function webApiCall(origin, version, method, path, headers, body) {
  const response = await fetch(`${origin}/api/data/${version}/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text, json: text ? JSON.parse(text) : null };
}
