// Custom connector compilation: a Solution custom connector's OpenAPI 2.0 definition, policy template instances,
// connection parameters and C# script become one JSON-serialisable record that connector-runtime.mjs turns into a provider
// (`custom-connector:<name>`). Data only: every function here is pure.
//
// Parts of a connector: swagger file, API properties (connectionParameters, scriptOperations, policyTemplateInstances) and an
// optional C# script.
// Policy templates run locally in their instance order, per section:
// setheader (Request, Response), setqueryparameter (Request), routerequesttoendpoint (Request, with its optional httpMethod),
// dynamichosturl (Set Host URL), setproperty, convertarraytoobject and convertobjecttoarray (Request or Response body). Their
// values may use @headers('n') / @header('n'), @queryParameters('n'), @connectionParameters('n', 'default'),
// @environmentVariables("n"), and the body templates the paths @body(), @body().a.b and @item().a. Any other template, section or expression, and a body
// whose `consumes` media type is not JSON, application/x-www-form-urlencoded or multipart/form-data, blocks the whole
// connector with a named diagnostic; nothing is approximated.
// A C# script (script.csx) runs for its scriptOperations (all operations when the list is empty) through the
// local .NET SDK (custom-connector-script.mjs); the script replaces the backend request.
// Execution reaches only loopback URLs (connection rewrites) or pack httpFixtures, as the http provider does.
// OAuth: a static token reference, the client credentials flow (OpenAPI 2.0 `flow: application`) or the authorization code
// flow (`flow: accessCode`: signed in through the loopback redirect with PKCE, refreshed with its refresh token;
// connector-runtime.mjs); the implicit and password flows answer 501 OperationUnsupported.
// The managed API id a flow uses for a Solution custom connector is not known, so both the connector name and
// shared_<name with _ encoded as -5f> are accepted.
export const SUPPORTED_POLICIES = Object.freeze(['setheader', 'setqueryparameter', 'routerequesttoendpoint', 'dynamichosturl', 'setproperty', 'convertarraytoobject', 'convertobjecttoarray']);
// The sections each template runs in (the routing templates document none and run on the request).
const SECTIONS = { setheader: ['Request', 'Response'], setqueryparameter: ['Request'], routerequesttoendpoint: ['Request'], dynamichosturl: ['Request'],
  setproperty: ['Request', 'Response'], convertarraytoobject: ['Request', 'Response'], convertobjecttoarray: ['Request', 'Response'] };
const BODY_POLICIES = ['setproperty', 'convertarraytoobject', 'convertobjecttoarray'];
export const OAUTH_FLOWS = Object.freeze(['application', 'accessCode']);
const METHODS = ['get', 'put', 'post', 'patch', 'delete', 'head', 'options'];
const isMap = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const P = 'x-ms-apimTemplateParameter.';

/** The compiled OpenAPI part: { version, title, baseUrl, auth, operations, diagnostics }. */
export function compileOpenApi(document) {
  const diagnostics = [];
  if (!isMap(document) || String(document.swagger ?? '') !== '2.0') {
    diagnostics.push({ code: 'CONNECTOR_OPENAPI_VERSION_UNSUPPORTED', message: 'Only OpenAPI (swagger) 2.0 custom connector definitions are compiled.' });
    return { version: String(document?.swagger ?? document?.openapi ?? ''), title: document?.info?.title ?? null, baseUrl: null, auth: { type: 'none' }, operations: {}, diagnostics };
  }
  const scheme = (document.schemes ?? []).includes('https') ? 'https' : document.schemes?.[0] ?? 'https';
  const baseUrl = document.host ? `${scheme}://${document.host}${String(document.basePath ?? '').replace(/\/$/, '')}` : null;
  const security = Object.values(document.securityDefinitions ?? {}).find(isMap);
  const auth = !security ? { type: 'none' } : security.type === 'apiKey' ? { type: 'apiKey', in: security.in === 'query' ? 'query' : 'header', name: String(security.name ?? '') }
    : security.type === 'basic' ? { type: 'basic' } : security.type === 'oauth2' ? { type: 'oauth', flow: String(security.flow ?? ''), tokenUrl: security.tokenUrl ?? null,
      authorizationUrl: security.authorizationUrl ?? null, scopes: Object.keys(security.scopes ?? {}) } : { type: 'unsupported', kind: String(security.type) };
  if (auth.type === 'unsupported') diagnostics.push({ code: 'CONNECTOR_AUTH_UNSUPPORTED', message: `Security definition type ${auth.kind} is not compiled.` });
  const shared = document.parameters ?? {};
  const operations = {};
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    if (!isMap(item)) continue;
    for (const method of METHODS) {
      const operation = item[method];
      if (!isMap(operation) || !operation.operationId) continue;
      const parameters = [...(item.parameters ?? []), ...(operation.parameters ?? [])].map(p => (isMap(p) && typeof p.$ref === 'string' ? shared[p.$ref.split('/').pop()] : p)).filter(isMap)
        .map(p => ({ name: String(p.name), in: String(p.in), required: p.required === true, ...(p.default !== undefined ? { default: p.default } : {}), visibility: p['x-ms-visibility'] ?? null }));
      operations[operation.operationId] = { method: method.toUpperCase(), pathTemplate: path, parameters, consumes: operation.consumes ?? document.consumes ?? ['application/json'],
        responses: Object.keys(operation.responses ?? {}) };
    }
  }
  return { version: '2.0', title: document.info?.title ?? null, baseUrl, auth, operations, diagnostics };
}

/** Policy template instances, in order, as [{ templateId, supported, section, operations, parameters, reason? }]. */
export function compilePolicies(instances) {
  return (Array.isArray(instances) ? instances : []).filter(isMap).map(policy => {
    const parameters = isMap(policy.parameters) ? policy.parameters : {}, templateId = String(policy.templateId ?? '');
    const section = parameters['x-ms-apimTemplate-policySection'] ?? 'Request';
    const operations = Array.isArray(parameters['x-ms-apimTemplate-operationName']) ? parameters['x-ms-apimTemplate-operationName'].map(String) : [];
    const values = Object.fromEntries(Object.entries(parameters).filter(([key]) => key.startsWith(P)).map(([key, value]) => [key.slice(P.length), value]));
    const unsupportedExpression = Object.values(values).some(value => typeof value === 'string' && expressions(value).some(e => !e.supported));
    const reason = !SUPPORTED_POLICIES.includes(templateId) ? 'template' : !SECTIONS[templateId].includes(section) ? 'section'
      : templateId === 'routerequesttoendpoint' && values.httpMethod != null && !/^[A-Za-z]+$/.test(String(values.httpMethod)) ? 'httpMethod' : unsupportedExpression ? 'expression' : null;
    return { templateId, supported: !reason, section, operations, parameters: values, ...(reason ? { reason } : {}) };
  });
}

// One policy expression: @name('a'[, 'b']) (single or double quotes) with an optional property path (@body().a.b).
const EXPRESSION = /@(\w+)\(\s*(?:(['"])(.*?)\2\s*(?:,\s*(['"])(.*?)\4\s*)?)?\)((?:\.[A-Za-z_$][\w$-]*)*)/g;
const KNOWN = new Set(['headers', 'header', 'queryParameters', 'connectionParameters', 'environmentVariables', 'body', 'item']);
function expressions(value) {
  const found = [...value.matchAll(EXPRESSION)].map(m => ({ name: m[1], arg: m[3], fallback: m[5], path: m[6], supported: KNOWN.has(m[1]) && (['body', 'item'].includes(m[1]) ? m[3] === undefined : m[3] !== undefined) }));
  const stray = value.replace(EXPRESSION, '').includes('@');
  return stray ? [...found, { supported: false }] : found;
}

/**
 * One compiled connector from a merged inventory record (solution-inventory.mjs connector facts):
 * { name, connectorIds, title, baseUrl, auth, operations, policies, connectionParameters, script, blocked, diagnostics }.
 * script: { text, operations } (operations empty: every operation) or null. blocked is the first blocking diagnostic or null.
 */
export function compileConnector(record) {
  const openapi = record.compiled ?? compileOpenApi(null), diagnostics = [...openapi.diagnostics];
  const policies = compilePolicies(record.policyInstances);
  for (const policy of policies.filter(p => !p.supported))
    diagnostics.push({ code: 'CONNECTOR_POLICY_UNSUPPORTED', message: `Policy template ${policy.templateId} (${policy.reason}) is not run locally.` });
  for (const policy of policies.filter(p => p.supported))
    for (const operation of policy.operations) if (!Object.hasOwn(openapi.operations, operation)) diagnostics.push({ code: 'CONNECTOR_POLICY_OPERATION_UNKNOWN', message: `Policy ${policy.templateId} names unknown operation ${operation}.` });
  if (openapi.auth.type === 'oauth' && !OAUTH_FLOWS.includes(openapi.auth.flow))
    diagnostics.push({ code: 'CONNECTOR_AUTH_UNSUPPORTED', message: `The OAuth ${openapi.auth.flow || 'unspecified'} flow is not run locally; the client credentials (application) and authorization code (accessCode) flows are.` });
  const scriptText = typeof record.scriptText === 'string' ? record.scriptText : null;
  if ((record.script || Array.isArray(record.scriptOperations) && record.scriptOperations.length) && scriptText === null)
    diagnostics.push({ code: 'CONNECTOR_SCRIPT_MISSING', message: 'The connector declares custom code but its script.csx text is not in the sources.' });
  for (const id of record.scriptOperations ?? []) if (!Object.hasOwn(openapi.operations, id))
    diagnostics.push({ code: 'CONNECTOR_SCRIPT_OPERATION_UNKNOWN', message: `The script names unknown operation ${id}.` });
  for (const [id, operation] of Object.entries(openapi.operations))
    if (operation.parameters.some(p => p.in === 'body' || p.in === 'formData') && !mediaType(operation))
      diagnostics.push({ code: 'CONNECTOR_MEDIA_TYPE_UNSUPPORTED', message: `Operation ${id} consumes ${operation.consumes.join(', ')}; only JSON, application/x-www-form-urlencoded and multipart/form-data bodies are sent locally.` });
  const name = String(record.name ?? '');
  const blocking = ['CONNECTOR_OPENAPI_VERSION_UNSUPPORTED', 'CONNECTOR_AUTH_UNSUPPORTED', 'CONNECTOR_POLICY_UNSUPPORTED', 'CONNECTOR_SCRIPT_MISSING', 'CONNECTOR_SCRIPT_OPERATION_UNKNOWN',
    'CONNECTOR_POLICY_OPERATION_UNKNOWN', 'CONNECTOR_MEDIA_TYPE_UNSUPPORTED'];
  return { name, connectorIds: [...new Set([name, 'shared_' + name.replace(/_/g, '-5f')])], title: openapi.title, baseUrl: openapi.baseUrl, auth: openapi.auth,
    operations: openapi.operations, policies, connectionParameters: record.connectionParameters ?? {},
    script: scriptText === null ? null : { text: scriptText, operations: (record.scriptOperations ?? []).map(String) },
    blocked: diagnostics.find(d => blocking.includes(d.code)) ?? null, diagnostics };
}
/** Whether an operation of a compiled connector runs its C# script (scriptOperations empty: every operation). */
export const scriptRuns = (connector, operationId) => Boolean(connector.script) && (!connector.script.operations.length || connector.script.operations.includes(operationId));

const compiledCache = new WeakMap();
/** Compiled connectors of the inventory records that carry an OpenAPI definition. */
export function customConnectorsOf(records = []) {
  return records.filter(record => record?.component === 'connector' && record.compiled).map(record => {
    if (!compiledCache.has(record)) compiledCache.set(record, compileConnector(record));
    return compiledCache.get(record);
  });
}

/**
 * The HTTP request of one operation: { method, url, headers, body } before connection rewrites. parameters are the flow
 * action parameters (a body parameter by name, or its properties as `<bodyName>/<property>`); connection: { parameters,
 * credentials, environment? (name => value) } with references already resolved. Throws an Error with .code on a missing
 * required parameter.
 */
export function buildRequest(connector, operationId, parameters = {}, connection = {}) {
  return build(connector, operationId, parameters, connection).request;
}
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
// The request plus the header and query keys its authentication and Request policies set (buildContinuation reapplies them).
function build(connector, operationId, parameters, connection) {
  const operation = connector.operations[operationId];
  if (!operation) fail('OperationUnsupported', 'The custom connector has no such operation.');
  const value = p => Object.hasOwn(parameters, p.name) ? parameters[p.name] : p.default;
  const headers = {}, query = {};
  let path = operation.pathTemplate, body, method = operation.method, base = connector.baseUrl;
  for (const p of operation.parameters) {
    let v = value(p);
    if (p.in === 'body') {
      const nested = Object.entries(parameters).filter(([key]) => key.startsWith(p.name + '/'));
      if (v === undefined && nested.length) { v = {}; for (const [key, item] of nested) setPath(v, key.slice(p.name.length + 1).split('/'), item); }
    }
    if (v === undefined || v === null) { if (p.required) fail('ProviderFailed', `The custom connector parameter ${p.name} is required.`); continue; }
    if (p.in === 'path') path = path.replaceAll(`{${p.name}}`, encodeURIComponent(String(v)));
    else if (p.in === 'query') query[p.name] = String(v);
    else if (p.in === 'header') headers[p.name] = String(v);
    else if (p.in === 'body') body = structuredClone(v);
    else if (p.in === 'formData') (body ??= {})[p.name] = v;
  }
  const set = { headers: new Set(), query: new Set(), auth: new Set() };
  // Request policies in instance order: each sees the headers, query and body the earlier ones left.
  for (const policy of policiesOf(connector, operationId, 'Request')) {
    const p = policy.parameters, evaluate = evaluator(connection, query, headers, body);
    if (policy.templateId === 'routerequesttoendpoint') {
      path = evaluate(p.newPath).replace(/\{(\w+)\}/g, (m, name) => {
        const declared = operation.parameters.find(item => item.in === 'path' && item.name === name);
        return declared && value(declared) != null ? encodeURIComponent(String(value(declared))) : m;
      });
      if (p.httpMethod) method = String(p.httpMethod).toUpperCase();
    } else if (policy.templateId === 'dynamichosturl') {
      // Assumed: the evaluated URL replaces the definition's host and base path; the operation path follows it.
      base = evaluate(p.urlTemplate).replace(/\/$/, '');
      try { new URL(base); } catch { fail('ProviderFailed', 'The Set Host URL policy produced no absolute URL.'); }
    } else if (BODY_POLICIES.includes(policy.templateId)) body = transformBody(policy, body, connection);
    else {
      const header = policy.templateId === 'setheader', key = applyPolicy(header ? headers : query, policy, evaluate(p.value ?? ''), header);
      if (key != null) set[header ? 'headers' : 'query'].add(key);
    }
  }
  if (!base) fail('ProviderFailed', 'The custom connector definition has no host.');
  const auth = connector.auth, credentials = connection.credentials ?? {};
  if (auth.type === 'apiKey') {
    if (credentials.apiKey == null) fail('ConnectionUnauthorized', 'The custom connector connection has no apiKey reference.');
    (auth.in === 'query' ? query : headers)[auth.name] = credentials.apiKey;
    (auth.in === 'query' ? set.auth : set.headers).add(auth.name);
  } else if (auth.type === 'basic') {
    if (credentials.username == null || credentials.password == null) fail('ConnectionUnauthorized', 'The custom connector connection has no username/password references.');
    headers.Authorization = 'Basic ' + Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64');
    set.headers.add('Authorization');
  } else if (auth.type === 'oauth') {
    if (credentials.token == null && !OAUTH_FLOWS.includes(auth.flow))
      fail('OperationUnsupported', `The OAuth ${auth.flow || 'unspecified'} flow is not run locally; declare a static token reference, the client credentials (application) or the authorization code (accessCode) flow.`);
    if (credentials.token == null) fail('ConnectionUnauthorized', auth.flow === 'accessCode'
      ? 'The custom connector connection is not signed in; authorize it (POST /_sim/api/connections/<connection id>/authorize).'
      : 'The custom connector connection acquired no OAuth client credentials token.');
    headers.Authorization = 'Bearer ' + credentials.token;
    set.headers.add('Authorization');
  }
  const url = new URL(base + (path.startsWith('/') ? path : '/' + path));
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  // The body is serialised by the operation's first supported `consumes` media type (compileConnector blocks the others);
  // multipart answers a native FormData, which the provider turns into bytes and a boundary content type.
  const media = mediaType(operation) ?? 'application/json', typed = Object.keys(headers).some(k => k.toLowerCase() === 'content-type');
  const text = v => typeof v === 'object' && v !== null ? JSON.stringify(v) : String(v);
  let payload = body;
  if (body !== undefined && typeof body !== 'string') {
    if (media === 'application/x-www-form-urlencoded') payload = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, text(v)])).toString();
    else if (media === 'multipart/form-data') {
      payload = new FormData();
      for (const [k, v] of Object.entries(body)) isMap(v) && typeof v.$content === 'string'
        ? payload.append(k, new Blob([Buffer.from(v.$content, 'base64')], { type: v['$content-type'] ?? 'application/octet-stream' }), k) : payload.append(k, text(v));
    } else payload = JSON.stringify(body);
    if (!typed && media !== 'multipart/form-data') headers['content-type'] = media === 'application/x-www-form-urlencoded' ? media : 'application/json';
  }
  return { request: { method, url: url.href, headers, body: payload }, set };
}

/**
 * The GET request for a later page (`nextLink`) or an asynchronous operation's status URL (Location) of an operation:
 * refused (403 PermissionDenied) when the link's origin is neither the operation's host nor the origin the connection rewrites
 * map that host to, so credentials never reach another host. Authentication and the Request setheader policies are
 * reapplied; a setqueryparameter policy only when the link lacks the parameter.
 */
// Which policies the native gateway reapplies to a nextLink or status request is a guess.
export function buildContinuation(connector, operationId, nextLink, parameters = {}, connection = {}, rewrites = {}) {
  const { request, set } = build(connector, operationId, parameters, connection);
  const url = assertContinuationOrigin(nextLink, request.url, rewrites), first = new URL(request.url);
  for (const key of set.auth) url.searchParams.set(key, first.searchParams.get(key));
  for (const key of set.query) if (!url.searchParams.has(key)) url.searchParams.set(key, first.searchParams.get(key));
  return { method: 'GET', url: url.href, headers: Object.fromEntries([...set.headers].map(key => [key, request.headers[key]])), body: undefined };
}

/**
 * The one continuation rule (custom connector pages and the Http action): the nextLink, resolved against operationHost (the
 * first request's URL before rewrites), as a URL, when its origin is operationHost's origin or the origin `rewrites` map
 * operationHost to; otherwise an Error with code PermissionDenied (403), so a later page never carries credentials elsewhere.
 */
export function assertContinuationOrigin(nextLink, operationHost, rewrites = {}) {
  let url;
  try { url = new URL(nextLink, operationHost); } catch { fail('ProviderFailed', 'The nextLink is not a URL.'); }
  if (![new URL(operationHost).origin, new URL(rewrite(operationHost, rewrites)).origin].includes(url.origin))
    fail('PermissionDenied', 'The nextLink names another host than the operation; it is not followed.');
  return url;
}
/** URL rewrites: the longest matching prefix wins (connections, the Http action and the server-logic HttpClient bridge). */
export function rewrite(url, rewrites = {}) {
  const from = Object.keys(rewrites ?? {}).filter(prefix => url.startsWith(prefix)).sort((a, b) => b.length - a.length)[0];
  return from === undefined ? url : rewrites[from] + url.slice(from.length);
}

/** The answer after the operation's Response policies in order: setheader on the headers (`@headers('n')` reads the response
 * headers) and the body templates on a JSON body. */
export function applyResponsePolicies(connector, operationId, answer, connection = {}) {
  const headers = { ...(answer.headers ?? {}) };
  let body = answer.body;
  for (const policy of policiesOf(connector, operationId, 'Response')) {
    if (BODY_POLICIES.includes(policy.templateId)) { if (body && typeof body === 'object') body = transformBody(policy, body, connection); }
    else applyPolicy(headers, policy, evaluator(connection, {}, headers, body)(policy.parameters.value ?? ''), true);
  }
  return { ...answer, headers, body };
}
/** The response headers after the operation's Response-section setheader policies. */
export const responseHeaders = (connector, operationId, headers = {}, connection = {}) => applyResponsePolicies(connector, operationId, { headers, body: null }, connection).headers;

const MEDIA = /json|^application\/x-www-form-urlencoded$|^multipart\/form-data$/;
const mediaType = operation => (operation.consumes ?? []).map(m => String(m).split(';')[0].trim().toLowerCase()).find(m => MEDIA.test(m));
const policiesOf = (connector, operationId, section) => connector.policies.filter(policy => policy.supported && policy.section === section
  && (!policy.operations.length || policy.operations.includes(operationId)));
// The value of one expression: request headers, query and connection parameters, environment variables, body paths.
function expressionValue(source, { name, arg, fallback, path }, item) {
  const found = name === 'connectionParameters' ? source.connection.parameters?.[arg] : name === 'queryParameters' ? source.query[arg]
    : name === 'environmentVariables' ? source.connection.environment?.(arg) : name === 'headers' || name === 'header' ? headerLookup(source.headers)(arg)
      : walk(name === 'item' ? item : source.body, path ? path.slice(1).split('.') : []);
  return found ?? fallback ?? null;
}
// An expression match as text: only @body() and @item() take a property path; after any other expression the dotted text is
// literal (e.g. http://@headers('subdomain').azure.net).
const render = (source, m, item) => {
  const value = expressionValue(source, { name: m[1], arg: m[3], fallback: m[5], path: m[6] }, item);
  const text = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  return ['body', 'item'].includes(m[1]) ? text : text + (m[6] ?? '');
};
const evaluator = (connection, query, headers, body) => template => String(template).replace(EXPRESSION, (...m) => render({ connection, query, headers, body }, m));
// A setheader / setqueryparameter policy on a header or query map (existsAction override|skip|append); the key it set, or null.
function applyPolicy(target, policy, next, header) {
  const name = String(policy.parameters.name ?? ''), exists = policy.parameters.existsAction ?? 'override';
  const key = header ? Object.keys(target).find(k => k.toLowerCase() === name.toLowerCase()) ?? name : name;
  if (Object.hasOwn(target, key) && exists === 'skip') return null;
  target[key] = Object.hasOwn(target, key) && exists === 'append' ? target[key] + ',' + next : next;
  return key;
}
const headerLookup = headers => name => headers[Object.keys(headers).find(k => k.toLowerCase() === String(name).toLowerCase())];
const unsafe = part => ['__proto__', 'constructor', 'prototype'].includes(part);
const walk = (node, parts) => { for (const part of parts) { if (node == null || typeof node !== 'object' || unsafe(part)) return undefined; node = node[part]; } return node; };
function setPath(target, parts, value) {
  let node = target;
  for (const part of parts.slice(0, -1)) { if (unsafe(part)) return; node = node[part] = isMap(node[part]) ? node[part] : {}; }
  const last = parts.at(-1);
  if (!unsafe(last)) node[last] = value;
}

// ---- body templates (setproperty, convertarraytoobject, convertobjecttoarray)
// A path parameter: @body()[.a.b] (from the body), @item()[.a] (from the current element of the parent collection) or a plain
// a.b relative to that element (e.g. peopleObject, @body().peopleArray, @item().people).
function pathOf(value) {
  const text = String(value ?? '').trim(), m = /^@(body|item)\(\)((?:\.[A-Za-z_$][\w$-]*)*)$/.exec(text);
  if (m) return { root: m[1], parts: m[2] ? m[2].slice(1).split('.') : [] };
  if (!/^[A-Za-z_$][\w$-]*(?:\.[A-Za-z_$][\w$-]*)*$/.test(text)) fail('ProviderFailed', 'A policy path must be @body(), @item() or a property path.');
  return { root: 'item', parts: text.split('.') };
}
// The parent elements a body template works on: the parent path's value, each element when it is a collection.
function parents(body, parentPath) {
  const parent = pathOf(parentPath), value = parent.root === 'body' ? walk(body, parent.parts) : undefined;
  if (parent.root !== 'body') fail('ProviderFailed', 'A policy parent path must start at @body().');
  return Array.isArray(value) ? value : value != null ? [value] : [];
}
// Writes a template's result: an @body() path is absolute, @item() and a plain path are relative to the element.
function writeAt(body, element, target, value) {
  const at = pathOf(target);
  if (!at.parts.length) fail('ProviderFailed', 'A policy target path needs a property.');
  setPath(at.root === 'body' ? body : element, at.parts, value);
}
function transformBody(policy, input, connection) {
  if (!input || typeof input !== 'object') return input;
  const body = structuredClone(input), p = policy.parameters, source = { connection, query: {}, headers: {}, body };
  if (policy.templateId === 'setproperty') {
    // setproperty: the value is a constant, a path, or a template with {path} parts; on a collection it applies to each element.
    for (const element of parents(body, p.newPropertyParentPathTemplate)) {
      const template = String(p.propertyValuePathTemplate ?? ''), whole = [...template.matchAll(EXPRESSION)];
      const value = whole.length === 1 && whole[0][0] === template.trim() && ['body', 'item'].includes(whole[0][1])
        ? expressionValue(source, { name: whole[0][1], path: whole[0][6] }, element)
        : template.replace(/\{\s*(@[^{}]*?)\s*\}/g, '$1').replace(EXPRESSION, (...m) => render(source, m, element));
      writeAt(body, element, String(p.newPropertySubPathTemplate ?? ''), value);
    }
    return body;
  }
  // convertarraytoobject and convertobjecttoarray: per parent element, the subpath's array (object) becomes an object keyed by
  // each item's key (an array of { keyName, valueName }) written to the new property path. retainKey defaults to true.
  // The key and value property names convertobjecttoarray uses when keyName or valueName is empty ('key', 'value') are a guess.
  const sub = p.propertySubPath ? String(p.propertySubPath).split('.') : [];
  for (const element of parents(body, p.propertyParentPath)) {
    const value = walk(element, sub);
    if (policy.templateId === 'convertarraytoobject') {
      if (!Array.isArray(value)) continue;
      const keyPath = String(p.keyWithinCollectionPath ?? '').split('.'), retain = String(p.retainKey ?? 'true') !== 'false', result = {};
      for (const item of value) {
        const key = walk(item, keyPath);
        if (key == null || unsafe(String(key))) continue;
        const copy = isMap(item) ? { ...item } : item;
        if (!retain && isMap(copy)) delete copy[keyPath[0]];
        result[String(key)] = copy;
      }
      writeAt(body, element, p.newPropertyPath, result);
    } else {
      if (!isMap(value)) continue;
      writeAt(body, element, p.newPropertyPath, Object.entries(value).map(([key, item]) => ({ [p.keyName || 'key']: key, [p.valueName || 'value']: item })));
    }
  }
  return body;
}
