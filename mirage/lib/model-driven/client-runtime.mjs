// A bounded client API for explicitly trusted, locally exported Solution scripts.
// Scripts execute through ordinary same-origin script elements; no expressions are evaluated.
import { ANONYMOUS_STAFF_CONTEXT, staffFormatting } from './pcf-runtime.mjs';

const loadedLibraries = new Map();
export const normalizeClientLibrary = (value) => String(value ?? '').replace(/^\$webresource:/i, '');
const blockedNames = new Set(['__proto__', 'prototype', 'constructor']);
const unsupported = (name) => {
  throw new Error(`Mirage client API does not support ${name}.`);
};
const isSingleValuedRelationship = (candidate, name) => candidate.many === false && candidate.from === name;
const isLookupTarget = (entity, match, relationship, tables) =>
  tables[entity]?.entitySet === match?.[1] && (!relationship?.entity || relationship.entity === entity);
function writeLookupValue(key, value, data, values, table, tables) {
  const navigation = key.slice(0, -11),
    relationship = table?.relationships?.[navigation];
  const name = relationship?.many === false ? relationship.from : navigation;
  const field = table?.fields?.[name];
  if (field?.type !== 'lookup' || relationship?.many === true)
    unsupported(`Xrm.WebApi lookup binding ${navigation}; import its single-valued relationship metadata`);
  if (
    !relationship &&
    Object.values(table?.relationships ?? {}).some((candidate) => isSingleValuedRelationship(candidate, name))
  )
    unsupported(`Xrm.WebApi lookup binding ${navigation}; use its exported navigation-property name`);
  const match =
    value === null
      ? null
      : typeof value === 'string' && /^\/([A-Z]\w*)\(([a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12})\)$/i.exec(value);
  if (value !== null && !match) throw new Error('Xrm.WebApi lookup binding requires a local entity-set record path.');
  const targets = (field.targets ?? []).filter((entity) => isLookupTarget(entity, match, relationship, tables));
  if (value !== null && targets.length !== 1)
    throw new Error(`Xrm.WebApi lookup binding ${navigation} does not resolve an imported target.`);
  if (Object.hasOwn(values, name) || Object.hasOwn(data, name))
    throw new Error(`Xrm.WebApi provides conflicting values for ${name}.`);
  values[name] = value === null ? null : { id: match[2].toLowerCase(), entity: targets[0] };
}
function writeMultiSelectValue(key, value, values) {
  if (!/^\s*[+-]?\d+(?:\s*,\s*[+-]?\d+)*\s*$/.test(value))
    throw new Error(`Xrm.WebApi ${key} requires comma-separated choice values.`);
  values[key] = value.split(',').map(Number);
}
function entityFunctionValue(value, host, recordPath) {
  const entity = value.entityType ?? String(value['@odata.type'] ?? '').replace(/^#?Microsoft\.Dynamics\.CRM\./, '');
  const id = value.id ?? (entity && host.tables?.[entity] ? value[host.tables[entity].idColumn] : undefined);
  return JSON.stringify(entity && id ? { '@odata.id': recordPath({ entityType: entity, id }) } : value);
}
function enumFunctionValue(value, type) {
  const name = typeof value === 'number' ? type.enumProperties?.find((entry) => entry.value === value)?.name : value;
  if (name === undefined) throw executeError(`Xrm.WebApi.execute: ${value} is not a member of ${type.typeName}.`, 400);
  return `${type.typeName}'${name}'`;
}
const matchingClientEvent = (event, name, attribute) =>
  event.active !== false && event.name === name && (name !== 'onchange' || event.attribute === attribute);
const enabledClientHandler = (handler) => handler.enabled !== false;
function* matchingRegisteredHandlers(host, name, attribute) {
  for (const event of host.extensions?.trusted === true ? (host.form.clientEvents ?? []) : [])
    if (matchingClientEvent(event, name, attribute))
      for (const handler of event.handlers ?? []) if (enabledClientHandler(handler)) yield handler;
}
const bounded = (value, path, absent = new Set()) =>
  new Proxy(value, {
    get(target, key) {
      if (typeof key === 'symbol' || key === 'then') return Reflect.get(target, key);
      if (!Object.hasOwn(target, key)) return absent.has(key) ? undefined : unsupported(`${path}.${key}`);
      return target[key];
    },
  });
const collection = (items, matches = (item, key) => item.getName() === key, missing) =>
  bounded(
    {
      get: (key) => {
        if (key === undefined) return items;
        if (typeof key === 'number') return key >= items.length ? null : items[key];
        if (typeof key === 'function') return items.filter(key);
        return items.find((item) => matches(item, key)) ?? missing;
      },
      getLength: () => items.length,
      forEach: (callback) => items.forEach(callback),
    },
    'collection',
  );

export function resolveClientFunction(scope, name) {
  const parts = String(name ?? '').split('.');
  if (!parts.length || parts.some((part) => !/^[A-Za-z_$][\w$]*$/.test(part) || blockedNames.has(part)))
    throw new Error('The exported client function name is invalid.');
  let owner = scope,
    fn;
  for (const [index, part] of parts.entries()) {
    if (owner == null || !Object.hasOwn(owner, part))
      throw new Error(`Exported client function ${name} is unavailable.`);
    fn = owner[part];
    if (index < parts.length - 1) owner = fn;
  }
  if (typeof fn !== 'function') throw new Error(`Exported client function ${name} is unavailable.`);
  return { fn, owner };
}

export function parseHandlerParameters(text = '') {
  if (!text.trim()) return [];
  // Exported parameters are constants, not JavaScript source. JSON primitives and
  // the common single-quoted string notation cover the supported native subset.
  const tokens = String(text).match(/'(?:[^'\\]|\\['\\])*'|"(?:[^"\\]|\\.)*"|[^,]+/g) ?? [];
  if (tokens.join(',').replace(/\s/g, '') !== String(text).replace(/\s/g, ''))
    throw new Error('Unsupported exported event parameters. Use primitive constants.');
  return tokens.map((token) => {
    const value = token.trim();
    if (/^'(?:[^'\\]|\\['\\])*'$/.test(value)) return value.slice(1, -1).replace(/\\(['\\])/g, '$1');
    let parsed;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error('Unsupported exported event parameters. Use primitive constants.');
    }
    if (parsed !== null && !['string', 'number', 'boolean'].includes(typeof parsed))
      throw new Error('Unsupported exported event parameters. Use primitive constants.');
    return parsed;
  });
}

export function loadClientLibrary(
  name,
  extensions,
  { document = globalThis.document, location = globalThis.location } = {},
) {
  if (extensions?.trusted !== true)
    return Promise.reject(
      new Error(
        'Solution client extensions are disabled. Explicitly trust this project in Mirage configuration to run them.',
      ),
    );
  const resource = extensions.resources?.find(
    (resource) => normalizeClientLibrary(resource.name) === normalizeClientLibrary(name) && resource.type === 'script',
  );
  if (!resource)
    return Promise.reject(new Error(`Exported script ${name} is not available in the imported Solution resources.`));
  const url = new URL(resource.url, location.href);
  if (url.origin !== location.origin || !url.pathname.startsWith('/_apps/') || url.search || url.hash)
    return Promise.reject(new Error('Client script URLs must be local imported Solution resources.'));
  if (!loadedLibraries.has(url.href))
    loadedLibraries.set(
      url.href,
      new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = url.href;
        script.async = false;
        const timeout = setTimeout(() => {
          script.remove();
          loadedLibraries.delete(url.href);
          reject(new Error(`Timed out loading exported script ${name}.`));
        }, 15000);
        script.onload = () => {
          clearTimeout(timeout);
          resolve();
        };
        script.onerror = () => {
          clearTimeout(timeout);
          loadedLibraries.delete(url.href);
          script.remove();
          reject(new Error(`Could not load exported script ${name}.`));
        };
        document.head.append(script);
      }),
    );
  return loadedLibraries.get(url.href);
}

function writeData(data, table, tables) {
  if (!data || typeof data !== 'object' || Array.isArray(data))
    throw new Error('Xrm.WebApi requires a record values object.');
  const values = {};
  for (const [key, value] of Object.entries(data)) {
    if (blockedNames.has(key)) throw new Error('Xrm.WebApi column name is invalid.');
    if (key.endsWith('@odata.bind')) {
      writeLookupValue(key, value, data, values, table, tables);
    } else if (table?.fields?.[key]?.type === 'multiselect' && typeof value === 'string') {
      writeMultiSelectValue(key, value, values);
    } else values[key] = value;
  }
  return values;
}

/** A trusted, imported HTML web resource for a page destination, else the reason it cannot open. */
export function webResourcePage(clientExtensions, name) {
  const wanted = String(name ?? '').replace(/^\$webresource:/i, '');
  const resource = clientExtensions?.resources?.find(
    (entry) => entry.type === 'page' && entry.name.toLowerCase() === wanted.toLowerCase(),
  );
  if (!resource)
    return {
      reason: `The HTML web resource ${wanted} is not imported from the selected Solution sources (MD_NAV_WEBRESOURCE).`,
    };
  if (clientExtensions.trusted !== true)
    return { reason: 'Trust local Solution client extensions in configuration to open HTML web resource pages.' };
  return { url: resource.url, resource };
}

const API_ROOT = '/api/data/v9.2';
const bareId = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const executeError = (message, status, code) =>
  Object.assign(new Error(message), {
    status,
    ...(code !== undefined ? { code } : {}),
    ...(/^0x[\da-f]+$/i.test(String(code ?? '')) ? { errorCode: Number.parseInt(code, 16) } : {}),
  });
const boundaryOf = (value) => /boundary=("?)([^";\r\n]+)\1/i.exec(String(value ?? ''))?.[2];
function embeddedBatchResponse(response) {
  const status = /^HTTP\/1\.1 (\d{3})([^\r\n]*)/.exec(response);
  if (!status) return null;
  const tail = response.slice(status[0].length);
  const lineEnding = /^\r?\n/.exec(tail);
  if (tail && !lineEnding) return null;
  const remainder = tail.slice(lineEnding?.[0].length ?? 0);
  const separator = /\r?\n\r?\n/.exec(remainder);
  const headers = separator ? remainder.slice(0, separator.index) : remainder;
  return {
    status: Number(status[1]),
    statusText: status[2].trim(),
    headers: Object.fromEntries(
      headers
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => [
          line.slice(0, line.indexOf(':')).trim().toLowerCase(),
          line.slice(line.indexOf(':') + 1).trim(),
        ]),
    ),
    body: separator ? remainder.slice(separator.index + separator[0].length) : '',
  };
}
/** The embedded responses of a $batch answer, split on the declared boundaries only (a nested change set recurses):
 * each is "HTTP/1.1 <status> <text>", its headers, a blank line and its body. */
export function batchResponses(body, boundary) {
  if (!boundary) return [];
  const result = [];
  for (const chunk of body.split(`--${boundary}`).slice(1)) {
    if (chunk.startsWith('--')) break;
    const part = chunk.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
    const blank = /\r?\n\r?\n/.exec(part);
    const head = blank ? part.slice(0, blank.index) : part,
      rest = blank ? part.slice(blank.index + blank[0].length) : '';
    const nested = boundaryOf(/^content-type:([^\r\n]*)/im.exec(head)?.[1]);
    if (nested) {
      result.push(...batchResponses(rest, nested));
      continue;
    }
    const parsed = embeddedBatchResponse(rest);
    if (parsed) result.push(parsed);
  }
  return result;
}

/** Xrm.WebApi.execute/executeMultiple over the organization's Web
 * API through host.webApi({ method, path, headers, body }) → { status, headers, body }: actions (operationType 0) POST,
 * functions (1) GET with parameter aliases, CRUD (2) record requests; a nested array in executeMultiple is one $batch
 * change set (all or nothing). Unknown operations answer the organization's own 404 error. */
export function createWebApiExecute(host, assertLive = () => {}) {
  const tableOf = (entity) => {
    const table = host.tables?.[entity];
    if (!table?.entitySet) throw executeError(`Xrm.WebApi.execute: table ${entity} is not imported.`, 400);
    return table;
  };
  const recordPath = (reference) => {
    if (!reference?.entityType || !reference.id)
      throw executeError('Xrm.WebApi.execute needs an entity reference with entityType and id.', 400);
    return `${tableOf(reference.entityType).entitySet}(${bareId(reference.id)})`;
  };
  // An { entityType, id } reference becomes the typed entity the Web API expects; other values pass unchanged.
  const actionValue = (value, type) =>
    type?.structuralProperty === 5 && value?.entityType && value.id && !value['@odata.type']
      ? {
          '@odata.type': `Microsoft.Dynamics.CRM.${value.entityType}`,
          [tableOf(value.entityType).idColumn]: bareId(value.id),
        }
      : value;
  const functionValue = (value, type) => {
    if (value === null || value === undefined) return 'null';
    if (type?.structuralProperty === 3) return enumFunctionValue(value, type);
    if (type?.structuralProperty === 5 && typeof value === 'object') {
      return entityFunctionValue(value, host, recordPath);
    }
    if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`;
    if (value instanceof Date) return value.toISOString();
    return typeof value === 'object' ? JSON.stringify(value) : String(value);
  };
  const payloadOf = (request) => {
    if (!request.payload || typeof request.payload !== 'object' || Array.isArray(request.payload))
      throw executeError('Xrm.WebApi.execute Create and Update need a payload object.', 400);
    return request.payload;
  };
  const crudHttp = (request, name, json, retrieveSelect) => {
    if (name === 'Create')
      return { method: 'POST', path: `${API_ROOT}/${tableOf(request.etn).entitySet}`, ...json(payloadOf(request)) };
    if (name === 'Retrieve')
      return {
        method: 'GET',
        path: `${API_ROOT}/${recordPath(request.entityReference)}${retrieveSelect(request)}`,
      };
    if (name === 'Update')
      return {
        method: 'PATCH',
        path: `${API_ROOT}/${recordPath({ entityType: request.etn, id: request.id })}`,
        ...json(payloadOf(request)),
      };
    if (name === 'Delete') return { method: 'DELETE', path: `${API_ROOT}/${recordPath(request.entityReference)}` };
    if (name === 'Associate' || name === 'Disassociate') {
      if (typeof request.relationship !== 'string' || !/^[A-Za-z_]\w*$/.test(request.relationship))
        throw executeError(`Xrm.WebApi.execute ${name} needs a relationship name.`, 400);
      const target = `${API_ROOT}/${recordPath(request.target)}/${request.relationship}`;
      if (name === 'Disassociate')
        return { method: 'DELETE', path: `${target}(${bareId(request.relatedEntityId)})/$ref` };
      if (!Array.isArray(request.relatedEntities) || request.relatedEntities.length !== 1)
        throw executeError(
          'Xrm.WebApi.execute Associate sends one related record per request locally; use executeMultiple for several.',
          400,
        );
      return {
        method: 'POST',
        path: `${target}/$ref`,
        ...json({ '@odata.id': `${API_ROOT}/${recordPath(request.relatedEntities[0])}` }),
      };
    }
    throw executeError(`Xrm.WebApi.execute does not know the CRUD operation ${name}.`, 400);
  };
  const operationHttp = ({ request, name, type, boundParameter, parameterTypes, json, actionValue, functionValue }) => {
    if (!/^[A-Za-z_][\w.]*$/.test(name)) throw executeError('Xrm.WebApi.execute operation name is invalid.', 400);
    let bound;
    if (boundParameter === 'entity') bound = `${recordPath(request.entity)}/Microsoft.Dynamics.CRM.${name}`;
    else if (boundParameter == null) bound = name;
    else bound = null;
    if (!bound)
      throw executeError(
        `Xrm.WebApi.execute bound parameter ${boundParameter} is not supported; use null or entity.`,
        400,
      );
    const parameters = Object.keys(parameterTypes).filter(
      (key) => key !== boundParameter && request[key] !== undefined,
    );
    if (type === 0)
      return {
        method: 'POST',
        path: `${API_ROOT}/${bound}`,
        ...json(Object.fromEntries(parameters.map((key) => [key, actionValue(request[key], parameterTypes[key])]))),
      };
    const aliases = parameters.map((key, index) => [key, `@p${index + 1}`]);
    const query = aliases
      .map(([key, alias]) => `${alias}=${encodeURIComponent(functionValue(request[key], parameterTypes[key]))}`)
      .join('&');
    return {
      method: 'GET',
      path: `${API_ROOT}/${bound}(${aliases.map(([key, alias]) => key + '=' + alias).join(',')})${query ? '?' + query : ''}`,
    };
  };
  function toHttp(request) {
    const meta = typeof request?.getMetadata === 'function' ? request.getMetadata() : null;
    if (
      !meta ||
      typeof meta.operationName !== 'string' ||
      !meta.operationName ||
      ![0, 1, 2].includes(meta.operationType)
    )
      throw executeError(
        'Xrm.WebApi.execute requires a request whose getMetadata() gives operationName and operationType 0, 1 or 2.',
        400,
      );
    const { operationName: name, operationType: type, boundParameter, parameterTypes = {} } = meta;
    const json = (body) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const retrieveSelect = (request) =>
      request.columns?.length ? '?$select=' + request.columns.map(encodeURIComponent).join(',') : '';
    if (type === 2) return crudHttp(request, name, json, retrieveSelect);
    return operationHttp({ request, name, type, boundParameter, parameterTypes, json, actionValue, functionValue });
  }
  const response = (http, result) => {
    let text;
    if (typeof result.body === 'string') text = result.body;
    else if (result.body == null) text = '';
    else text = JSON.stringify(result.body);
    if (result.status >= 400) {
      let error;
      try {
        error = JSON.parse(text).error;
      } catch {
        error = null;
      }
      throw executeError(error?.message ?? `The Web API answered ${result.status}.`, result.status, error?.code);
    }
    return {
      ok: true,
      status: result.status,
      statusText: result.statusText ?? '',
      headers: result.headers ?? {},
      url: http.path,
      type: 'json',
      json: async () => (text ? JSON.parse(text) : null),
      text: async () => text,
    };
  };
  const send = async (http) => {
    assertLive();
    const result = await host.webApi(http);
    assertLive();
    return result;
  };
  async function execute(request) {
    if (typeof host.webApi !== 'function')
      throw executeError('Xrm.WebApi.execute needs the host Web API bridge.', 501, 'WebApiExecuteUnavailable');
    const http = toHttp(request);
    return response(http, await send(http));
  }
  async function changeSet(requests) {
    const http = requests.map(toHttp),
      batch = `batch_${crypto.randomUUID()}`,
      set = `changeset_${crypto.randomUUID()}`;
    const parts = http.map((item, index) =>
      [
        `--${set}`,
        'Content-Type: application/http',
        'Content-Transfer-Encoding: binary',
        `Content-ID: ${index + 1}`,
        '',
        `${item.method} ${item.path} HTTP/1.1`,
        ...Object.entries(item.headers ?? {}).map(([name, value]) => `${name}: ${value}`),
        '',
        item.body ?? '',
      ].join('\r\n'),
    );
    const body = [
      `--${batch}`,
      `Content-Type: multipart/mixed; boundary=${set}`,
      '',
      ...parts,
      `--${set}--`,
      `--${batch}--`,
      '',
    ].join('\r\n');
    const result = await send({
      method: 'POST',
      path: `${API_ROOT}/$batch`,
      headers: { 'content-type': `multipart/mixed; boundary=${batch}` },
      body,
    });
    const contentType = Object.entries(result.headers ?? {}).find(
      ([name]) => name.toLowerCase() === 'content-type',
    )?.[1];
    const responses = batchResponses(
      String(result.body ?? ''),
      boundaryOf(contentType) ?? /^\s*--([^\r\n]+)/.exec(String(result.body ?? ''))?.[1],
    );
    // A failed change set answers the failing request's error (executeMultiple rejects with that error).
    const failed = responses.find((item) => item.status >= 400) ?? (result.status >= 400 ? result : null);
    if (failed) response({ path: `${API_ROOT}/$batch` }, failed);
    return responses.map((item, index) => response(http[index], item));
  }
  async function executeMultiple(requests) {
    if (typeof host.webApi !== 'function')
      throw executeError('Xrm.WebApi.executeMultiple needs the host Web API bridge.', 501, 'WebApiExecuteUnavailable');
    if (!Array.isArray(requests) || !requests.length || requests.length > 1000)
      throw executeError('Xrm.WebApi.executeMultiple requires an array of 1 to 1000 requests.', 400);
    const results = [];
    // ponytail: top-level requests run one after another (native sends one $batch; each is independent there too).
    for (const item of requests) results.push(...(Array.isArray(item) ? await changeSet(item) : [await execute(item)]));
    return results;
  }
  return { execute, executeMultiple, toHttp };
}

/** Validated Xrm.Navigation.navigateTo input. entityrecord, entitylist and
 * webresource pages open inline (target 1) or in a dialog (target 2, position 1 center or 2 side); a custom page
 * (name, optional entityName and recordId, read in the page with Param) opens the headless canvas
 * host of the canvas app with that logical name (the shell checks it exists); a dashboard page opens one of the app's Solution dashboards
 * (`dashboards`, the catalogue app's list; without dashboardId its first, as "the app navigates to the default
 * dashboard") and rejects with DashboardPageUnsupported when the sources hold no such dashboard. */
export function pageRequest(pageInput, navigationOptions = {}, tables = {}, dashboards = []) {
  const type = pageInput?.pageType;
  validateCustomPage(type, pageInput);
  const dashboard =
    type === 'dashboard' &&
    (pageInput.dashboardId
      ? dashboards.find((candidate) => candidate.id === bareId(pageInput.dashboardId))
      : dashboards[0]);
  if (type === 'dashboard' && !dashboard)
    throw Object.assign(
      new Error(`Dashboard ${pageInput.dashboardId || '(default)'} is not in this app's Solution sources.`),
      { code: 'DashboardPageUnsupported' },
    );
  validatePageType(type);
  validatePageTable(type, pageInput, tables);
  validatePageDetails(type, pageInput, tables);
  const options = navigationOptions ?? {};
  if (![undefined, 1, 2].includes(options.target) || ![undefined, 1, 2].includes(options.position))
    throw new Error('navigateTo target must be 1 (inline) or 2 (dialog) and position 1 (center) or 2 (side).');
  const input = pageRequestInput(type, pageInput, dashboard);
  return [
    input,
    {
      target: options.target ?? 1,
      position: options.position ?? 1,
      ...(options.width !== undefined ? { width: options.width } : {}),
      ...(options.height !== undefined ? { height: options.height } : {}),
      ...(options.title ? { title: String(options.title) } : {}),
    },
  ];
}

function validateCustomPage(type, pageInput) {
  if (type !== 'custom') return;
  if (typeof pageInput.name !== 'string' || !pageInput.name.trim())
    throw new Error('navigateTo needs the logical name of the custom page in name.');
  // Documented for custom pages: "The recordId parameter must be a GUID".
  if (
    pageInput.recordId !== undefined &&
    !/^{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}}?$/i.test(String(pageInput.recordId))
  )
    throw new Error('navigateTo: the custom page recordId must be a GUID.');
}

function validatePageType(type) {
  if (!['entityrecord', 'entitylist', 'webresource', 'dashboard', 'custom'].includes(type))
    throw new Error('navigateTo needs pageType entityrecord, entitylist, webresource, dashboard or custom.');
}

function validatePageTable(type, pageInput, tables) {
  if (!['webresource', 'dashboard', 'custom'].includes(type) && !Object.hasOwn(tables, pageInput.entityName ?? ''))
    throw new Error(`navigateTo: table ${pageInput.entityName ?? ''} is not imported.`);
  if (
    type === 'entityrecord' &&
    pageInput.formId &&
    tables[pageInput.entityName]?.metadata !== 'lazy' &&
    Array.isArray(tables[pageInput.entityName]?.forms) &&
    !tables[pageInput.entityName].forms.some((form) => bareId(form.id) === bareId(pageInput.formId))
  )
    throw Object.assign(new Error('The requested form is unavailable in the imported source forms.'), {
      code: 'FormUnavailable',
    });
}

function validatePageDetails(type, pageInput, tables) {
  if (type === 'webresource' && (typeof pageInput.webresourceName !== 'string' || !pageInput.webresourceName))
    throw new Error('navigateTo needs a webresourceName for a web resource page.');
  if (
    type === 'entityrecord' &&
    pageInput.tabName !== undefined &&
    (typeof pageInput.tabName !== 'string' || !pageInput.tabName.trim() || pageInput.tabName.length > 256)
  )
    throw new Error('navigateTo tabName must name an exported form tab.');
  validatePageViews(type, pageInput, tables);
}

function validatePageViews(type, pageInput, tables) {
  if (type === 'entitylist' && pageInput.viewType !== undefined && pageInput.viewType !== 'savedquery')
    throw Object.assign(
      new Error(
        pageInput.viewType === 'userquery'
          ? 'Personal views are not available in the imported model-driven view catalogue.'
          : 'navigateTo viewType must be savedquery or userquery.',
      ),
      { code: pageInput.viewType === 'userquery' ? 'PersonalViewUnsupported' : 'InvalidViewType' },
    );
  if (
    type === 'entitylist' &&
    pageInput.viewId &&
    Array.isArray(tables[pageInput.entityName]?.views) &&
    !tables[pageInput.entityName].views.some((view) => bareId(view.id) === bareId(pageInput.viewId))
  )
    throw Object.assign(new Error('The selected saved view is not imported.'), { code: 'ViewUnavailable' });
}

/* NOSONAR */ function pageRequestInput(type, pageInput, dashboard) {
  let input;
  if (type === 'entityrecord')
    input = {
      pageType: type,
      entityName: pageInput.entityName,
      ...(pageInput.entityId ? { entityId: bareId(pageInput.entityId) } : {}),
      ...(pageInput.formId ? { formId: bareId(pageInput.formId) } : {}),
      ...(pageInput.tabName !== undefined ? { tabName: pageInput.tabName } : {}),
      ...(pageInput.data ? { data: pageInput.data } : {}),
    };
  else if (type === 'entitylist')
    input = {
      pageType: type,
      entityName: pageInput.entityName,
      ...(pageInput.viewId ? { viewId: bareId(pageInput.viewId) } : {}),
      ...(pageInput.viewType !== undefined ? { viewType: pageInput.viewType } : {}),
    };
  else if (type === 'dashboard') input = { pageType: type, dashboardId: dashboard.id };
  else if (type === 'custom')
    input = {
      pageType: type,
      name: pageInput.name.trim(),
      ...(pageInput.entityName ? { entityName: String(pageInput.entityName) } : {}),
      ...(pageInput.recordId !== undefined ? { recordId: bareId(pageInput.recordId) } : {}),
    };
  else
    input = {
      pageType: type,
      webresourceName: pageInput.webresourceName,
      ...(pageInput.data !== undefined ? { data: String(pageInput.data) } : {}),
    };
  return input;
}

export function createFormClientRuntime(host) {
  let live = true,
    depth = 0,
    saving = false;
  const activeEvents = new Map();
  const assertLive = () => {
    if (!live) throw new Error('This form context has been disposed.');
  };
  const client = (value, path, absent) =>
    bounded(
      Object.fromEntries(
        Object.entries(value).map(([key, entry]) => [
          key,
          typeof entry === 'function'
            ? (...args) => {
                assertLive();
                return entry(...args);
              }
            : entry,
        ]),
      ),
      path,
      absent,
    );
  const events = new Map(),
    eventOrdinals = new Map(),
    notifications = new Set(),
    submitModes = new Map(),
    invalidNumberReads = new Map(),
    initial = structuredClone(host.initialRecord ?? host.record);
  const add = (key, callback) => {
    if (typeof callback !== 'function') throw new Error('Client event handler must be a function.');
    const handlers = events.get(key) ?? [];
    const ordinal = eventOrdinals.get(key) ?? 0;
    handlers.push({ callback, ordinal });
    eventOrdinals.set(key, ordinal + 1);
    events.set(key, handlers);
  };
  const remove = (key, callback) =>
    events.set(
      key,
      (events.get(key) ?? []).filter((handler) => handler.callback !== callback),
    );
  const saveForm = (close) => {
    assertLive();
    if (activeEvents.size)
      throw new Error(
        `Saving from an active ${[...activeEvents.keys()].at(-1)} handler is not supported. Finish the event before saving.`,
      );
    return host.save(close);
  };
  const formIsValid = (report) => {
    if (typeof host.isValid !== 'function') unsupported('form validity without a host validator');
    return Boolean(host.isValid(report));
  };
  const fieldValue = (name) => {
    assertLive();
    return host.read(name);
  };
  const attributeValue = (name) => {
    // Native UCI retains the previous getter snapshot for an out-of-range assignment while the draft is invalid.
    const value = fieldValue(name),
      invalid = invalidNumberReads.get(name);
    if (invalid && Object.is(value, invalid.input)) return invalid.previous;
    invalidNumberReads.delete(name);
    return value;
  };
  const choiceOptions = new Map();
  const choiceBlank = new Map();
  const controlOptions = (name, fieldName) =>
    host.controlState?.(name, 'options') ??
    choiceOptions.get(fieldName) ??
    (host.table.fields[fieldName]?.options ?? []).map((option) => ({ text: option.label, value: option.value }));
  const hasChoiceBlank = (name, fieldName) =>
    host.controlState?.(name, 'optionPlaceholder') ?? choiceBlank.get(fieldName) ?? true;
  const setControlOptions = (name, fieldName, options, blank = hasChoiceBlank(name, fieldName)) => {
    host.controlState(name, 'options', options);
    choiceOptions.set(fieldName, options);
    choiceBlank.set(fieldName, blank);
    host.syncChoiceOptions?.(name, fieldName, options, blank);
  };
  const layoutLabels = new Map();
  const layoutLabel = (item) => layoutLabels.get(item) ?? host.layoutLabel?.(item) ?? item.label;
  const setLayoutLabel = (item, value) => {
    const label = String(value);
    layoutLabels.set(item, label);
    host.setLayoutLabel?.(item, label);
  };
  const clientValue = (name, value, source = host.record) => {
    if (value == null) return null;
    const field = host.table.fields[name];
    if (field.type === 'date') return new Date(value);
    if (field.type === 'multiselect')
      return Array.isArray(value)
        ? [...value]
        : String(value)
            .split(',')
            .filter((part) => part.trim())
            .map(Number);
    if (field.type === 'lookup')
      return [
        {
          id: `{${String(value.id ?? value).replace(/[{}]/g, '')}}`,
          name: value.name ?? '',
          entityType:
            value.entity ??
            value.logicalName ??
            source?.[`${name}@Microsoft.Dynamics.CRM.lookuplogicalname`] ??
            field.targets?.[0],
        },
      ];
    return value;
  };
  const sameAttributeValue = (name, left, right) => {
    const a = clientValue(name, left),
      b = clientValue(name, right, initial);
    if (host.table.fields[name].type === 'lookup') {
      const identity = (value) =>
        value?.map(({ id, entityType }) => [bareId(id), String(entityType ?? '').toLowerCase()]) ?? null;
      return JSON.stringify(identity(a)) === JSON.stringify(identity(b));
    }
    return (
      a === b ||
      (a !== null &&
        b !== null &&
        typeof a === 'object' &&
        typeof b === 'object' &&
        JSON.stringify(a) === JSON.stringify(b))
    );
  };
  const multiselectAssignment = (name, value) => {
    const primary = host.controlNames(name)[0];
    const next = controlOptions(primary, name)
      .filter((option) => value.includes(option.value))
      .map((option) => option.value)
      .sort((a, b) => a - b);
    return next.length ? next : null;
  };
  const validateChoiceAssignment = (field, name, value) => {
    const offered = host.controlNames(name).flatMap((control) => controlOptions(control, name));
    if (!field.options.some((option) => option.value === value) && !offered.some((option) => option.value === value)) {
      const error = new Error(`Invalid value ${value} for OptionSetValue`);
      error.name = 'UciError';
      throw error;
    }
  };
  const assignedValue = (field, name, value) => {
    if (field.type === 'date' && value instanceof Date) return value.toISOString();
    if (field.type === 'lookup' && Array.isArray(value))
      return value.length
        ? { id: String(value[0].id).replace(/[{}]/g, ''), entity: value[0].entityType, name: value[0].name }
        : null;
    if (['text', 'textarea'].includes(field.type) && value === '') return null;
    if (field.type === 'multiselect' && Array.isArray(value)) return multiselectAssignment(name, value);
    if (field.type === 'number' && Array.isArray(field.options) && value !== null)
      validateChoiceAssignment(field, name, value);
    return value;
  };
  const unavailableAttributeMethods = (field) => {
    if (['text', 'textarea'].includes(field.type)) return new Set(['getMin', 'getMax', 'getPrecision']);
    if (
      field.type === 'number' &&
      !Array.isArray(field.options) &&
      ['int', 'integer', 'decimal'].includes(field.dataverseType)
    )
      return new Set(['getMaxLength']);
    return new Set();
  };
  // formContext.data.entity.attributes: only columns added to the form are available. The form's bindings
  // (body, header, footer) are host.form.attributes; a form without them exposes its controls' columns.
  const formNames = host.form?.attributes ?? [
    ...new Set(
      host
        .controlNames()
        .map((name) => host.controlField(name))
        .filter(Boolean),
    ),
  ];
  const attributes = formNames
    .map((name) => host.table.fields[name])
    .filter(Boolean)
    .map((field) => {
      const name = field.name;
      const metadataNumber = (property, method) => {
        if (property === 'precision' && ['int', 'integer', 'bigint'].includes(field.dataverseType)) return 0;
        const value = field[property];
        if (typeof value !== 'number' || !Number.isFinite(value))
          unsupported(`attribute(${name}).${method} without imported numeric ${property} metadata`);
        return value;
      };
      return client(
        {
          getName: () => name,
          getValue: () => clientValue(name, attributeValue(name)),
          getInitialValue: () =>
            field.type === 'boolean' && initial[name] != null
              ? Number(initial[name])
              : clientValue(name, initial[name]),
          setValue: (value) => {
            assertLive();
            const previous = fieldValue(name),
              next = assignedValue(field, name, value);
            host.write(name, next, { changed: !sameAttributeValue(name, previous, next) });
            if (
              field.type === 'number' &&
              !Array.isArray(field.options) &&
              typeof next === 'number' &&
              (next < field.minValue || next > field.maxValue)
            )
              invalidNumberReads.set(name, { input: next, previous });
            else invalidNumberReads.delete(name);
          },
          getFormat: () => {
            if (field.format) return String(field.format).toLowerCase();
            if (field.type === 'textarea') return 'textarea';
            if (field.type === 'text') return 'text';
            if (
              field.type === 'lookup' ||
              (field.type === 'number' &&
                !Array.isArray(field.options) &&
                !['decimal', 'double', 'float', 'money'].includes(field.dataverseType))
            )
              return 'none';
            if (field.type === 'date') return 'datetime';
            return null;
          },
          getIsDirty: () => {
            // Native new forms activate an untouched false default after another
            // column changes. A real edit to this Boolean settles that default;
            // restoring its value then clears only its attribute dirty flag.
            const pendingFalseDefault =
              !initial[host.table.idColumn] &&
              field.type === 'boolean' &&
              field.defaultValue === false &&
              initial[name] === false &&
              host.isDirty() &&
              !host.isDirty(name);
            return pendingFalseDefault || !sameAttributeValue(name, fieldValue(name), initial[name]);
          },
          ...(field.type === 'number' && !Array.isArray(field.options)
            ? {
                getMin: () => metadataNumber('minValue', 'getMin'),
                getMax: () => metadataNumber('maxValue', 'getMax'),
                getPrecision: () => metadataNumber('precision', 'getPrecision'),
              }
            : {}),
          ...(['text', 'textarea'].includes(field.type)
            ? { getMaxLength: () => metadataNumber('maxLength', 'getMaxLength') }
            : {}),
          getAttributeType: () =>
            ({
              text: 'string',
              textarea: 'memo',
              number: Array.isArray(field.options)
                ? 'optionset'
                : ({ decimal: 'decimal', money: 'money', double: 'double', float: 'double' }[field.dataverseType] ??
                  'integer'),
              date: 'datetime',
              multiselect: 'multiselectoptionset',
            })[field.type] ?? field.type,
          getOptions: () =>
            (field.type === 'boolean'
              ? [...(field.options ?? [])].sort((a, b) => a.value - b.value)
              : (field.options ?? [])
            ).map((option) => ({ text: option.label, value: option.value })),
          getOption: (value) => {
            const option = (field.options ?? []).find((option) =>
              typeof value === 'number' ? option.value === value : option.label === value,
            );
            return option ? { text: option.label, value: option.value } : null;
          },
          getText: () =>
            field.type === 'multiselect'
              ? (clientValue(name, fieldValue(name))
                  ?.map((value) => field.options?.find((option) => option.value === value)?.label)
                  .filter((value) => value !== undefined) ?? null)
              : (field.options?.find((option) => option.value === fieldValue(name))?.label ?? null),
          getRequiredLevel: () => {
            const level = host.required?.(name);
            if (typeof level === 'string') return level;
            if (level) return 'required';
            return 'none';
          },
          setRequiredLevel: (value) => {
            if (!['none', 'required', 'recommended'].includes(value)) throw new Error('Invalid required level.');
            host.required?.(name, value);
          },
          getSubmitMode: () => submitModes.get(name) ?? 'dirty',
          setSubmitMode: (mode) => {
            if (!['dirty', 'always', 'never'].includes(mode)) throw new Error('Invalid submit mode.');
            submitModes.set(name, mode);
          },
          addOnChange: (callback) => add(`onchange:${name}`, callback),
          removeOnChange: (callback) => remove(`onchange:${name}`, callback),
          fireOnChange: () => dispatch('onchange', name),
          controls: collection(host.controlNames(name).map((controlName) => makeControl(controlName, name))),
        },
        `attribute(${name})`,
        unavailableAttributeMethods(field),
      );
    });
  function makeControl(name, fieldName = host.controlField(name)) {
    const field = host.table.fields[fieldName];
    const options = () => controlOptions(name, fieldName);
    return client(
      {
        getName: () => name,
        getAttribute: () => attributes.find((attribute) => attribute.getName() === fieldName) ?? null,
        getControlType: () => {
          if (field?.type === 'multiselect') return 'multiselectoptionset';
          if (field?.type === 'lookup') return 'lookup';
          if (field?.type === 'number' && Array.isArray(field.options)) return 'optionset';
          return 'standard';
        },
        getParent: () => {
          for (const tab of host.form?.tabs ?? []) {
            const index = (tab.sections ?? []).findIndex((section) =>
              (section.fields ?? []).some((cell) => (cell.sourceControl?.id ?? cell.name) === name),
            );
            if (index !== -1) return formContext.ui.tabs.get(tab.id).sections.get(index);
          }
          return null;
        },
        getDisabled: () => host.controlState(name, 'disabled'),
        setDisabled: (value) => {
          host.controlState(name, 'disabled', Boolean(value));
        },
        getVisible: () => !host.controlState(name, 'hidden'),
        setVisible: (value) => {
          host.controlState(name, 'hidden', !value);
        },
        getLabel: () => host.controlState(name, 'label'),
        setLabel: (value) => {
          host.controlState(name, 'label', String(value));
        },
        setFocus: () => host.controlState(name, 'focus', true),
        setNotification: (message, id = 'default') => {
          host.controlState(name, `notification:${id}`, String(message));
          return true;
        },
        clearNotification: (id = 'default') => {
          const present = host.controlState(name, `notification:${id}`) != null;
          host.controlState(name, `notification:${id}`, null);
          return present;
        },
        ...(field?.type === 'multiselect' || (field?.type === 'number' && Array.isArray(field.options))
          ? {
              getOptions: () => [
                ...(hasChoiceBlank(name, fieldName) ? [{ text: '', value: Number.NaN }] : []),
                ...options().map((option) => ({ ...option })),
              ],
              addOption: (option, index) => {
                if (!option || typeof option.text !== 'string')
                  throw new Error('addOption requires text and a numeric option value.');
                if (typeof option.value !== 'number') {
                  const error = new Error('Value should be of type: number: Parameter Name: optionSetItem.value');
                  error.name = 'UciError';
                  throw error;
                }
                const next = options().map((entry) => ({ ...entry }));
                const numericIndex = Number(index);
                const at =
                  index === undefined || !Number.isInteger(numericIndex) ? next.length : Math.max(0, numericIndex - 1);
                next.splice(at, 0, { text: option.text, value: option.value });
                setControlOptions(name, fieldName, next, host.isPcfControl?.(name) ? undefined : true);
              },
              removeOption: (value) => {
                const next = options().slice();
                const index = next.findIndex((option) => option.value === value);
                if (index !== -1) next.splice(index, 1);
                const blank = host.isPcfControl?.(name) && index !== -1 && !next.length ? false : undefined;
                setControlOptions(name, fieldName, next, blank);
              },
              clearOptions: () => setControlOptions(name, fieldName, [], !host.isPcfControl?.(name)),
            }
          : {}),
      },
      `control(${name})`,
    );
  }
  const controls = host.controlNames().map((name) => makeControl(name));
  const formItem = client(
    {
      getId: () => {
        const id = host.form?.id;
        if (!id) return null;
        const text = String(id),
          candidate = text.startsWith('{') && text.endsWith('}') ? text.slice(1, -1) : text;
        return /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(candidate)
          ? candidate.toLowerCase()
          : `{${text.replace(/[{}]/g, '')}}`;
      },
      getLabel: () => host.form?.name ?? '',
      navigate: () => unsupported('formSelector item.navigate'),
    },
    'formContext.ui.formSelector.item',
  );
  const formContext = client(
    {
      getAttribute: (name) =>
        name === undefined ? attributes : (attributes.find((attribute) => attribute.getName() === name) ?? null),
      getControl: (name) =>
        name === undefined ? controls : (controls.find((control) => control.getName() === name) ?? null),
      data: client(
        {
          entity: client(
            {
              getId: () => (host.record[host.table.idColumn] ? `{${host.record[host.table.idColumn]}}` : ''),
              getEntityName: () => host.table.entity,
              getPrimaryAttributeValue: () => host.read(host.table.nameColumn),
              getIsDirty: () => host.isDirty(),
              isValid: () => formIsValid(false),
              attributes: collection(attributes),
              addOnSave: (callback) => add('onsave', callback),
              removeOnSave: (callback) => remove('onsave', callback),
              save: (mode) => saveForm(mode === 'saveandclose'),
            },
            'formContext.data.entity',
          ),
          getIsDirty: () => host.isDirty(),
          isValid: () => formIsValid(true),
          save: () => saveForm(false),
          refresh: (save) => (save ? saveForm(false) : host.refresh()),
          addOnLoad: (callback) => add('onload', callback),
          removeOnLoad: (callback) => remove('onload', callback),
        },
        'formContext.data',
      ),
      ui: client(
        {
          controls: collection(controls),
          getFormType: () => host.getFormType?.() ?? (host.record[host.table.idColumn] ? 2 : 1),
          // formContext.ui.formSelector: the open form; switching forms from a script is not supported locally.
          formSelector: client(
            {
              getCurrentItem: () => formItem,
              items: collection(host.form?.id ? [formItem] : [], (item, key) => item.getId() === key, null),
            },
            'formContext.ui.formSelector',
          ),
          // formContext.ui.tabs and tab.sections: names, labels and visibility of the exported form layout.
          tabs: collection(
            (host.form?.tabs ?? []).map((tab) =>
              client(
                {
                  getName: () => tab.id,
                  getLabel: () => layoutLabel(tab),
                  setLabel: (value) => setLayoutLabel(tab, value),
                  getVisible: () => host.layoutVisible?.(tab) ?? tab.visible !== false,
                  setVisible: (visible) => {
                    host.setLayoutVisible(tab, Boolean(visible));
                  },
                  sections: collection(
                    (tab.sections ?? []).map((section) =>
                      client(
                        {
                          getName: () => section.name ?? null,
                          getLabel: () => layoutLabel(section),
                          setLabel: (value) => setLayoutLabel(section, value),
                          getParent: () => formContext.ui.tabs.get(tab.id),
                          getVisible: () => host.layoutVisible?.(section) ?? section.visible !== false,
                          setVisible: (visible) => {
                            host.setLayoutVisible(section, Boolean(visible));
                          },
                        },
                        'formContext.ui.tab.section',
                      ),
                    ),
                  ),
                },
                'formContext.ui.tab',
              ),
            ),
          ),
          setFormNotification: (message, level, id = 'default') => {
            notifications.add(id);
            host.notification(String(message), level, id);
            return true;
          },
          clearFormNotification: (id = 'default') => {
            const present = notifications.delete(id);
            host.notification(null, null, id);
            return present;
          },
          close: () => host.close(),
        },
        'formContext.ui',
      ),
    },
    'formContext',
  );
  const call = async (handler, args) => {
    assertLive();
    if (++depth > 10) {
      depth--;
      throw new Error('Client event recursion exceeded 10 calls.');
    }
    try {
      let callback = handler;
      if (typeof handler !== 'function') {
        await loadClientLibrary(handler.library, host.extensions, host.environment);
        const resolved = resolveClientFunction(host.scope ?? globalThis, handler.functionName);
        callback = resolved.fn.bind(resolved.owner);
      }
      assertLive();
      return await callback(...args);
    } finally {
      depth--;
    }
  };
  async function dispatch(name, attribute, saveMode = 1) {
    assertLive();
    if (name === 'onsave' && saving) throw new Error('Recursive save from an OnSave handler is not supported.');
    if (name === 'onsave') saving = true;
    activeEvents.set(name, (activeEvents.get(name) ?? 0) + 1);
    let prevented = false;
    const eventArgs = client(
      {
        getSaveMode: () => saveMode,
        preventDefault: () => {
          if (name !== 'onsave') unsupported(`${name}.preventDefault`);
          prevented = true;
        },
        isDefaultPrevented: () => prevented,
      },
      'eventArgs',
    );
    const context = (ordinal) =>
      client(
        {
          getFormContext: () => formContext,
          getEventSource: () => (attribute ? formContext.getAttribute(attribute) : formContext.data.entity),
          getEventArgs: () => eventArgs,
          getDepth: () => ordinal,
        },
        'executionContext',
      );
    try {
      let ordinal = 0;
      for (const handler of matchingRegisteredHandlers(host, name, attribute)) {
        await call(handler, [
          ...(handler.passExecutionContext ? [context(ordinal)] : []),
          ...parseHandlerParameters(handler.parameters),
        ]);
        ordinal++;
      }
      /* NOSONAR */ for (const handler of [...(events.get(name === 'onchange' ? `onchange:${attribute}` : name) ?? [])])
        await call(handler.callback, [context(ordinal + handler.ordinal)]);
      return { prevented };
    } finally {
      const count = activeEvents.get(name) - 1;
      if (count) activeEvents.set(name, count);
      else activeEvents.delete(name);
      if (name === 'onsave') saving = false;
    }
  }
  // Recheck after each asynchronous boundary: a form or staff identity may have
  // changed while a read was in flight. In particular, never send a follow-up
  // PATCH/DELETE from a context revoked during its ETag preflight.
  const prepareTable = async (entity) => {
    await host.metadata(entity);
    assertLive();
  };
  const request = async (...args) => {
    assertLive();
    if (host.metadata) await prepareTable(args[0]);
    const result = await host.request(...args);
    assertLive();
    return result;
  };
  const onlineWebApi = client(
    {
      retrieveRecord: async (entity, id, options = '') => {
        if (typeof options !== 'string' || (options && !options.startsWith('?')))
          throw new Error('Xrm.WebApi query options must start with ?.');
        return request(entity, id, { query: { scope: 'odata', options } });
      },
      retrieveMultipleRecords: async (entity, options = '', maxPageSize) => {
        if (maxPageSize !== undefined && (!Number.isInteger(maxPageSize) || maxPageSize < 1 || maxPageSize > 5000))
          throw new Error('Xrm.WebApi maxPageSize must be between 1 and 5000.');
        if (typeof options !== 'string') throw new Error('Xrm.WebApi query options must be text.');
        if (options && !options.startsWith('?')) {
          const location = host.environment?.location ?? globalThis.location,
            next = new URL(options, location.href);
          if (
            next.origin !== location.origin ||
            next.pathname !== `/api/data/v9.2/${host.tables[entity]?.entitySet}` ||
            next.hash
          )
            throw new Error('Xrm.WebApi continuation must target this local imported table.');
          options = next.search;
        }
        return request(entity, undefined, {
          query: { scope: 'odata', options, ...(maxPageSize === undefined ? {} : { pageSize: maxPageSize }) },
        });
      },
      createRecord: async (entity, data) => {
        if (host.metadata) await prepareTable(entity);
        const values = writeData(data, host.tables[entity], host.tables);
        const result = await request(entity, undefined, { method: 'POST', data: values });
        return { id: result.row[host.tables[entity].idColumn], entityType: entity };
      },
      updateRecord: async (entity, id, data) => {
        if (host.metadata) await prepareTable(entity);
        const values = writeData(data, host.tables[entity], host.tables);
        const current = await request(entity, id);
        await request(entity, id, { method: 'PATCH', data: values, etag: current.etag });
        return { id, entityType: entity };
      },
      deleteRecord: async (entity, id) => {
        const current = await request(entity, id);
        await request(entity, id, { method: 'DELETE', etag: current.etag });
        return { id, entityType: entity };
      },
    },
    'Xrm.WebApi',
  );
  const operations = createWebApiExecute(host, assertLive);
  const online = client(
    {
      ...Object.fromEntries(Object.keys(onlineWebApi).map((key) => [key, onlineWebApi[key]])),
      execute: operations.execute,
      executeMultiple: operations.executeMultiple,
    },
    'Xrm.WebApi',
  );
  // Xrm.WebApi.offline reads and writes the session's offline copy through host.offline
  // ({ isOffline(), tables(), request(body) }, the shell's /_apps/api/offline); the server refuses its CRUD while online.
  // In offline mode Xrm.WebApi's own CRUD uses the offline store ("the source is the offline data store").
  const isOffline = () => Boolean(host.offline?.isOffline());
  const offlineCall = async (action, body) => {
    assertLive();
    if (!host.offline)
      throw executeError('Xrm.WebApi.offline needs the host offline store.', 501, 'OfflineSyncUnavailable');
    const result = await host.offline.request({ action, ...body });
    assertLive();
    return result;
  };
  const isAvailableOffline = (entity) => (host.offline?.tables() ?? []).includes(entity);
  const offline = client(
    {
      retrieveRecord: async (entity, id, options = '') => offlineCall('retrieve', { entity, id: bareId(id), options }),
      // ponytail: maxPageSize is not applied offline (the offline nextLink is deprecated); the whole result returns.
      retrieveMultipleRecords: async (entity, options = '') => offlineCall('retrieveMultiple', { entity, options }),
      createRecord: async (entity, data) => offlineCall('create', { entity, data }),
      updateRecord: async (entity, id, data) => offlineCall('update', { entity, id: bareId(id), data }),
      deleteRecord: async (entity, id) => offlineCall('delete', { entity, id: bareId(id) }),
      isAvailableOffline,
    },
    'Xrm.WebApi.offline',
  );
  const routed = Object.fromEntries(
    ['retrieveRecord', 'retrieveMultipleRecords', 'createRecord', 'updateRecord', 'deleteRecord'].map((name) => [
      name,
      (...args) => (isOffline() ? offline : online)[name](...args),
    ]),
  );
  const webApi = client(
    {
      ...Object.fromEntries(Object.keys(online).map((key) => [key, online[key]])),
      ...routed,
      isAvailableOffline,
      online,
      offline,
    },
    'Xrm.WebApi',
  );
  const staff =
    host.staffContext ??
    (host.user
      ? {
          ...ANONYMOUS_STAFF_CONTEXT,
          anonymous: false,
          userId: host.user.userId ?? host.user.principalId ?? host.user.id ?? '',
          userName: host.user.userName ?? host.user.name ?? '',
        }
      : ANONYMOUS_STAFF_CONTEXT);
  const roles = staff.roles.map((role) => ({ ...role, getName: () => role.name }));
  const Xrm = client(
    {
      Page: formContext,
      WebApi: webApi,
      Navigation: client(
        {
          openAlertDialog: (options) => host.alert(options.text ?? '', options.title ?? 'Message'),
          // Xrm.Navigation.openUrl: opens the address in a new window; only http(s) addresses are opened.
          openUrl: (url) => {
            const target = new URL(String(url), (host.environment?.location ?? globalThis.location).href);
            if (!['http:', 'https:'].includes(target.protocol))
              throw new Error('Xrm.Navigation.openUrl opens http(s) addresses only.');
            (host.environment?.open ?? globalThis.open)?.(target.href, '_blank', 'noopener');
          },
          openConfirmDialog: (options) =>
            host.confirm(options.text ?? '', options.title ?? 'Confirm').then((confirmed) => ({ confirmed })),
          openForm: (options) => host.openForm(options),
          navigateTo: (pageInput, navigationOptions) => {
            try {
              return host.openPage(...pageRequest(pageInput, navigationOptions, host.tables, host.dashboards));
            } catch (error) {
              return Promise.reject(error);
            }
          },
        },
        'Xrm.Navigation',
      ),
      ...(host.sidePanes ? { App: client({ sidePanes: host.sidePanes }, 'Xrm.App') } : {}),
      // Xrm.Utility.getPageContext: the page the app shows (entityrecord or entitylist), from the shell's route.
      Utility: client(
        {
          getPageContext: () => ({
            input: {
              ...(host.pageContext?.() ?? {
                pageType: 'entityrecord',
                entityName: host.table.entity,
                entityId: host.record[host.table.idColumn] ?? null,
                formId: host.form?.id ?? null,
              }),
            },
          }),
          getGlobalContext: () =>
            client(
              {
                getClientUrl: () => (host.environment?.location ?? globalThis.location).origin,
                // getGlobalContext.getVersion: the Web API version this organization serves.
                getVersion: () => host.version ?? '9.2.0.0', // NOSONAR: version string or loopback address, not a network target
                // getGlobalContext.userSettings: the server-built staff context, the same one the PCF context reads.
                userSettings: client(
                  {
                    userId: staff.userId,
                    userName: staff.userName,
                    languageId: staff.languageId,
                    isRTL: staff.isRTL,
                    securityRoles: [...staff.securityRoles],
                    roles: collection(roles),
                    transactionCurrency: staff.transactionCurrency
                      ? {
                          id: staff.transactionCurrency.id,
                          entityType: 'transactioncurrency',
                          name: staff.transactionCurrency.name,
                        }
                      : null,
                    transactionCurrencyId: staff.transactionCurrency?.id ?? null,
                    dateFormattingInfo: staff.dateFormattingInfo,
                    getTimeZoneOffsetMinutes: () => staffFormatting(staff).getTimeZoneOffsetMinutes(),
                  },
                  'globalContext.userSettings',
                ),
                // getGlobalContext.client: the Offline state belongs to the mobile app (the simulated device while offline).
                client: client(
                  {
                    getClient: () => (isOffline() ? 'Mobile' : 'Web'),
                    getClientState: () => (isOffline() ? 'Offline' : 'Online'),
                    isOffline,
                  },
                  'globalContext.client',
                ),
              },
              'globalContext',
            ),
        },
        'Xrm.Utility',
      ),
    },
    'Xrm',
  );
  return {
    formContext,
    Xrm,
    dispatch,
    async prepare() {
      if (host.extensions?.trusted === true)
        for (const library of host.form.libraries ?? []) {
          assertLive();
          await loadClientLibrary(library, host.extensions, host.environment);
        }
    },
    async command(command, selection = []) {
      assertLive();
      if (!command.supported) throw new Error(command.reason ?? 'Unsupported exported ribbon command.');
      for (const action of command.actions) {
        const args = action.parameters.map((parameter) => {
          if (parameter.kind === 'crm') {
            if (parameter.value === 'PrimaryControl') return formContext;
            if (parameter.value === 'SelectedControlSelectedItemIds') return selection;
            return host.table.entity;
          }
          if (parameter.kind === 'number') return Number(parameter.value);
          if (parameter.kind === 'boolean') return parameter.value === 'true';
          return parameter.value;
        });
        await call(action, args);
      }
    },
    destroy() {
      live = false;
      events.clear();
      eventOrdinals.clear();
      invalidNumberReads.clear();
      layoutLabels.clear();
      for (const id of notifications) host.notification(null, null, id);
    },
  };
}

export function evaluateRibbonRules(
  rules = [],
  { mode, entity, selection = [], read = () => null, existing = false, formType } = {},
) {
  return rules.every((rule) =>
    rule.clauses.every((clause) => {
      let value;
      if (clause.type === 'FormStateRule')
        value =
          clause.State ===
          ({ 1: 'Create', 2: 'Existing', 3: 'ReadOnly', 4: 'Disabled', 6: 'BulkEdit' }[formType] ??
            (existing ? 'Existing' : 'Create'));
      else if (clause.type === 'EntityRule')
        value = clause.EntityName === entity && (!clause.AppliesTo || clause.AppliesTo === 'PrimaryEntity');
      else if (clause.type === 'ValueRule') value = String(read(clause.Field) ?? '') === String(clause.Value ?? '');
      else if (clause.type === 'SelectionCountRule')
        value =
          mode === 'grid' &&
          selection.length >= Number(clause.Minimum ?? 0) &&
          selection.length <= Number(clause.Maximum ?? Infinity);
      else return false;
      return clause.InvertResult === 'true' ? !value : value;
    }),
  );
}
