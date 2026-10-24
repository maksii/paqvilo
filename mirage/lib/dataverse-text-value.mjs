// Dataverse emits a UTF-8 BOM for primitive /$value and /$count text.
// https://learn.microsoft.com/en-us/power-apps/developer/data-platform/webapi/retrieve-entity-using-web-api
// Keep internal handler values, JSON, errors and binary streams unchanged.
const TEXT_ROUTES = new Set(['value', 'count', 'navigationCount']);
export function encodeDataverseText(route, result) {
  if (!TEXT_ROUTES.has(route?.kind) || result?.status !== 200 || typeof result.body !== 'string') return result;
  let contentType;
  for (const [name, value] of Object.entries(result.headers ?? {}))
    if (name.toLowerCase() === 'content-type' && value != null) contentType = String(value);
  if (contentType && contentType.split(';')[0].trim().toLowerCase() !== 'text/plain') return result;
  return {
    ...result,
    headers: contentType ? result.headers : { ...result.headers, 'content-type': 'text/plain' },
    body: '\uFEFF' + result.body,
  };
}
