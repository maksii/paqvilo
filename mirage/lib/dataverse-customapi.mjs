// Simulated Dataverse custom APIs: the customapi tables, unpacked solution parsing, and registry
// operations for unbound, entity-bound and collection-bound functions and actions. No plug-in runs locally,
// so responses carry each response property at its type default.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DataError } from './data-error.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { pluginFailure } from './plugin-fault.mjs';
import { privilegeDeniedError, uuidV5 } from './dataverse-security.mjs';
import { child, childText, parseSolutionXml } from './solution-xml.mjs';

// Dataverse type codes 0-12 (customapirequestparameter.type and customapiresponseproperty.type).
const TYPES = ['Boolean', 'DateTime', 'Decimal', 'Entity', 'EntityCollection', 'EntityReference', 'Float', 'Integer', 'Money', 'Picklist', 'String', 'StringArray', 'Guid'];
const BINDINGS = ['unbound', 'entity', 'collection'];
const EDM = { Boolean: 'Edm.Boolean', DateTime: 'Edm.DateTimeOffset', Decimal: 'Edm.Decimal', Float: 'Edm.Double', Integer: 'Edm.Int32', Money: 'Edm.Decimal', Picklist: 'Edm.Int32', String: 'Edm.String', StringArray: 'Collection(Edm.String)', Guid: 'Edm.Guid' };
// Unhandled response values at the native defaults: strings are null; DateTime and Guid are the zero values.
const DEFAULTS = { Boolean: false, Decimal: 0, Float: 0, Integer: 0, Money: 0, Picklist: 0, DateTime: '0001-01-01T00:00:00Z', Guid: '00000000-0000-0000-0000-000000000000' };
// ponytail: the Dataverse plug-in timeout (2 minutes); install({ timeoutMs }) overrides it for tests.
const TIMEOUT_MS = 120000;
const SINGLE = new Set(['Entity', 'EntityCollection']); // a lone response property of these types is the response itself
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_KINDS = { 'customapi.xml': 'customapi', 'customapirequestparameter.xml': 'customapirequestparameter', 'customapiresponseproperty.xml': 'customapiresponseproperty' };
// Same fixed namespace dataverse-security.mjs uses for its default ids.
const FIXED_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

const key = (value) => String(value ?? '').toLowerCase();
const sameId = (a, b) => key(a) === key(b);
const typeOf = (code) => TYPES[Number(code)];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const int32 = (v) => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
// unverified: the value check for each type is this simulator's reading of the type name.
const CHECKS = {
  Boolean: (v) => typeof v === 'boolean',
  DateTime: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
  Decimal: num, Float: num, Money: num,
  Integer: int32, Picklist: int32,
  String: (v) => typeof v === 'string',
  StringArray: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  Guid: (v) => typeof v === 'string' && GUID_RE.test(v),
  Entity: isObject, EntityReference: isObject, EntityCollection: Array.isArray,
};

const defaultOf = (type) => (type === 'StringArray' || type === 'EntityCollection' ? [] : (DEFAULTS[type] ?? null));
// unverified: the entity type used when logicalentityname is empty.
function edmOf(property) {
  const type = typeOf(property.type);
  if (EDM[type]) return EDM[type];
  const entity = `mscrm.${property.logicalentityname ?? 'crmbaseentity'}`;
  return type === 'EntityCollection' ? `Collection(${entity})` : entity;
}

// Native answers an unregistered (or unanswerable) Custom API with 404 0x80060888 and the segment message.
const notFound = (name) => new DataError(`Resource not found for the segment '${name}'.`, 404, 'UnknownEntity', { httpStatus: 404, innerCode: '0x80060888', route: true });
const apiNamed = (store, name) => store.tableRows('customapi').find((r) => key(r.uniquename) === key(name));
const parametersOf = (store, row) => store.tableRows('customapirequestparameter').filter((p) => sameId(p.customapiid, row.customapiid));
const propertiesOf = (store, row) => store.tableRows('customapiresponseproperty').filter((p) => sameId(p.customapiid, row.customapiid));

/**
 * Parses unpacked custom API files. Each file is { path, text } with a path relative to the customapis folder:
 * <api>/customapi.xml, <api>/customapirequestparameters/<name>/customapirequestparameter.xml and
 * <api>/customapiresponseproperties/<name>/customapiresponseproperty.xml. Returns rows keyed by table.
 */
export function parseCustomApiFiles(files, { organizationId } = {}) {
  const ns = organizationId ?? FIXED_NAMESPACE;
  const rows = { customapi: [], customapirequestparameter: [], customapiresponseproperty: [] };
  const flag = (node, name) => ['1', 'true'].includes(childText(node, name));
  const numberOf = (node, name) => Number(childText(node, name) || 0);
  const textOf = (node, name) => childText(node, name) || null;
  for (const { path, text } of files) {
    const parts = String(path).split(/[\\/]/);
    const kind = FILE_KINDS[parts.at(-1)];
    if (!kind) continue;
    const root = parseSolutionXml(text);
    const api = parts[0];
    const customapiid = uuidV5(ns, `customapi:${api}`);
    const common = {
      uniquename: root.attrs.uniquename,
      name: textOf(root, 'name'),
      displayname: child(root, 'displayname')?.attrs?.default ?? null,
      description: child(root, 'description')?.attrs?.default ?? null,
    };
    if (kind === 'customapi') {
      rows.customapi.push({
        ...common, customapiid,
        bindingtype: numberOf(root, 'bindingtype'),
        boundentitylogicalname: textOf(root, 'boundentitylogicalname'),
        isfunction: flag(root, 'isfunction'),
        isprivate: flag(root, 'isprivate'),
        allowedcustomprocessingsteptype: numberOf(root, 'allowedcustomprocessingsteptype'),
        executeprivilegename: textOf(root, 'executeprivilegename'),
        workflowsdkstepenabled: flag(root, 'workflowsdkstepenabled'),
      });
    } else if (kind === 'customapirequestparameter') {
      rows.customapirequestparameter.push({
        ...common,
        customapirequestparameterid: uuidV5(ns, `customapirequestparameter:${api}:${parts[2]}`),
        customapiid,
        type: numberOf(root, 'type'),
        logicalentityname: textOf(root, 'logicalentityname'),
        isoptional: flag(root, 'isoptional'),
      });
    } else {
      rows.customapiresponseproperty.push({
        ...common,
        customapiresponsepropertyid: uuidV5(ns, `customapiresponseproperty:${api}:${parts[2]}`),
        customapiid,
        type: numberOf(root, 'type'),
        logicalentityname: textOf(root, 'logicalentityname'),
      });
    }
  }
  return rows;
}

/** Reads an unpacked customapis folder (one folder per custom API) and parses it with parseCustomApiFiles. */
export async function readCustomApiSolution(customApisDir, options) {
  const files = [];
  const walk = async (dir, rel) => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), path);
      else if (FILE_KINDS[entry.name]) files.push({ path, text: await readFile(join(dir, entry.name), 'utf8') });
    }
  };
  await walk(customApisDir, '');
  return parseCustomApiFiles(files, options);
}

const field = (fields) => Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, { dataverseType: type }]));
const TEXT = 'nvarchar', INT = 'int', BOOL = 'bit', GUID = 'uniqueidentifier', LOOKUP = 'lookup';
// Tables seeded by the simulated Dataverse API (dataverseOnly), as in dataverse-security.mjs.
const SEEDED = {
  customapi: {
    set: 'customapis', id: 'customapiid',
    fields: { customapiid: GUID, uniquename: TEXT, name: TEXT, displayname: TEXT, description: TEXT, bindingtype: INT, boundentitylogicalname: TEXT, isfunction: BOOL, isprivate: BOOL, allowedcustomprocessingsteptype: INT, executeprivilegename: TEXT, workflowsdkstepenabled: BOOL },
    // Navigation properties of the documented deep insert (CustomAPIRequestParameters, CustomAPIResponseProperties).
    relationships: {
      CustomAPIRequestParameters: { schemaName: 'customapi_customapirequestparameter', entity: 'customapirequestparameter', from: 'customapiid', to: 'customapiid', many: true },
      CustomAPIResponseProperties: { schemaName: 'customapi_customapiresponseproperty', entity: 'customapiresponseproperty', from: 'customapiid', to: 'customapiid', many: true },
    },
  },
  // unverified: entity set names of the two child tables.
  customapirequestparameter: {
    set: 'customapirequestparameters', id: 'customapirequestparameterid',
    fields: { customapirequestparameterid: GUID, uniquename: TEXT, name: TEXT, displayname: TEXT, description: TEXT, type: INT, logicalentityname: TEXT, isoptional: BOOL, customapiid: LOOKUP },
    relationships: { CustomAPIId: { schemaName: 'customapi_customapirequestparameter', entity: 'customapi', from: 'customapiid', to: 'customapiid', many: false } },
  },
  customapiresponseproperty: {
    set: 'customapiresponseproperties', id: 'customapiresponsepropertyid',
    fields: { customapiresponsepropertyid: GUID, uniquename: TEXT, name: TEXT, displayname: TEXT, description: TEXT, type: INT, logicalentityname: TEXT, customapiid: LOOKUP },
    relationships: { CustomAPIId: { schemaName: 'customapi_customapiresponseproperty', entity: 'customapi', from: 'customapiid', to: 'customapiid', many: false } },
  },
};

function seed(store) {
  for (const [logical, def] of Object.entries(SEEDED)) {
    // An existing mapping is kept as it is, so a mapping without dataverseOnly is never flipped or overwritten.
    store.state.mappings[logical] ??= { logicalName: logical, entitySet: def.set, idColumn: def.id, nameColumn: 'name', userConfigured: true, dataverseOnly: true, fields: field(def.fields), relationships: def.relationships ?? {} };
    store.state.tables[logical] ??= [];
  }
}

// The OData payload reader's failure (0x80048d19, Entity ''). Its stack trace is not reproduced.
const payloadError = (detail) => new DataError(`Error identified in Payload provided by the user for Entity :'', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : Microsoft.OData.ODataException: ${detail}`, 400, 'InvalidRequest', { innerCode: '0x80048d19' });
const literal = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));

// The typed value of a literal, or undefined when it does not convert. The strings 'true' and 'false' convert to Boolean.
function typedValue(type, value) {
  if (type === 'Boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return CHECKS[type]?.(value) ? value : undefined;
}

// Native names the first element of a string array that is not a string.
function conversionFailure(type, value) {
  const array = type === 'StringArray' && Array.isArray(value);
  const shown = array ? value.find((item) => !CHECKS.String(item)) : value;
  return `Cannot convert the literal '${literal(shown)}' to the expected type '${array ? 'Edm.String' : EDM[type]}'.`;
}

// Parameter values come from the URL for functions and the JSON body for actions. Returns the typed values by name.
function checkParameters(store, row, c) {
  const input = c.method === 'POST' ? (c.body ?? {}) : (c.params ?? {});
  const params = parametersOf(store, row);
  for (const name of Object.keys(input))
    if (!params.some((p) => p.uniquename === name)) throw payloadError(`The parameter '${name}' in the request payload is not a valid parameter for the operation '${row.uniquename}'.`);
  const typed = {};
  for (const p of params) {
    const type = typeOf(p.type), value = input[p.uniquename];
    if (value === undefined || value === null) {
      // A function's URL must name every required parameter; without one native finds no resource (404 0x80060888).
      if (!p.isoptional && row.isfunction) throw notFound(row.uniquename);
      // unverified: message text of the missing-parameter error.
      if (!p.isoptional) throw new DataError(`Required parameter '${p.uniquename}' is missing.`, 400, 'InvalidRequest', { innerCode: '0x80040203' });
      typed[p.uniquename] = value;
      continue;
    }
    const converted = typedValue(type, value);
    if (converted === undefined) throw payloadError(conversionFailure(type, value));
    typed[p.uniquename] = converted;
  }
  return typed;
}

// Response values come from the handler's outputs; an output it leaves out is the native default.
function responseBody(c, row, properties, outputs = {}) {
  const single = properties.length === 1 && SINGLE.has(typeOf(properties[0].type)) ? properties[0] : null;
  if (single) {
    // unverified: @odata.context and body of a lone Entity or EntityCollection response.
    const body = { '@odata.context': contextUrl(c.origin, c.version, edmOf(single)) };
    const value = outputs[single.uniquename];
    if (typeOf(single.type) === 'EntityCollection') return { ...body, value: Array.isArray(value) ? value : [] };
    return isObject(value) ? { ...body, ...value } : body;
  }
  return {
    '@odata.context': contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${row.uniquename}Response`),
    ...Object.fromEntries(properties.map((p) => [p.uniquename, outputs[p.uniquename] !== undefined ? outputs[p.uniquename] : defaultOf(typeOf(p.type))])),
  };
}


// Runs the trusted handler as one store transaction in the change slot: a throw or a timeout rolls its writes back.
// ponytail: a timed-out handler keeps running after the rollback; cancelling it through a signal is the upgrade path.
async function runHandler(api, handler, ctx, plugin, timeoutMs) {
  const atomic = api.runAtomic ?? ((fn) => api.store.transact(fn));
  const bounded = () => {
    let timer;
    const limit = new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { timedOut: true })), timeoutMs); });
    return Promise.race([Promise.resolve().then(() => handler(ctx)), limit]).finally(() => clearTimeout(timer));
  };
  try {
    return await api.change(() => atomic(bounded));
  } catch (error) {
    throw pluginFailure(error, plugin, timeoutMs);
  }
}

// P4: a custom API whose plugintypeid names a plug-in type with a pluginTypes handler runs that handler as its main operation.
// A customApis entry for the API wins. The plug-in's name for messages is the type's typename.
function typeRegistration(store, row, pluginTypes) {
  const typeId = row.plugintypeid?.id ?? row.plugintypeid;
  if (!typeId) return undefined;
  const type = store.tableRows('plugintype').find((item) => key(item.plugintypeid) === key(typeId));
  const handler = type && pluginTypes.get(type.typename);
  return handler ? { handler, pluginType: type.typename } : undefined;
}

async function invoke(api, name, c, { handlers, pluginTypes = new Map(), timeoutMs: limit }) {
  const { store } = api;
  // The limit may be a function, read per call: the admin Environment settings change it while the simulator runs.
  const timeoutMs = typeof limit === "function" ? limit() : limit;
  const row = apiNamed(store, name);
  if (!row) throw notFound(name);
  // Functions are GET and actions are POST; another verb gets the generic 404 envelope.
  if (c.method !== (row.isfunction ? 'GET' : 'POST')) throw new DataError(`No HTTP resource was found that matches the request URI '${c.url}'.`, 404, 'NotFound', { innerCode: '' });
  if (row.executeprivilegename && !api.principals.privileges(c.user).has(row.executeprivilegename))
    throw privilegeDeniedError(c.user, row.executeprivilegename, row.boundentitylogicalname ?? row.uniquename);
  const inputs = checkParameters(store, row, c);
  const properties = propertiesOf(store, row);
  // unverified: a function must have a response property, so without one it is absent and its plug-in never runs.
  if (!properties.length && row.isfunction) throw notFound(name);
  const registration = handlers.get(key(name)) ?? typeRegistration(store, row, pluginTypes);
  // The plug-in's type (the custom API name when the pack names none) and the trace lines its handler writes.
  const plugin = { name: row.uniquename, id: row.customapiid, type: registration?.pluginType ?? row.uniquename, traces: [] };
  // Typed inputs, the bound target (entity or collection) and the caller. Without a pack handler the outputs are the defaults.
  const ctx = {
    name: row.uniquename, inputs, api, origin: c.origin, version: c.version, caller: c.caller,
    target: c.target && { logicalName: c.target.mapping?.logicalName, id: c.target.id, row: c.target.row },
    trace: (text) => plugin.traces.push(String(text)),
  };
  const outputs = registration ? (await runHandler(api, registration.handler, ctx, plugin, timeoutMs))?.outputs ?? {} : {};
  // unverified: an action with no response properties returns 204.
  if (!properties.length) return { status: 204 };
  return { status: 200, body: responseBody(c, row, properties, outputs) };
}

// CSDL for one API; '' when it is left out (private, or a function with no response, which is invalid CSDL).
// unverified: private APIs are left out of CSDL.
function csdlOf(store, name) {
  const row = apiNamed(store, name);
  if (!row || row.isprivate) return '';
  const properties = propertiesOf(store, row);
  if (row.isfunction && !properties.length) return '';
  const single = properties.length === 1 && SINGLE.has(typeOf(properties[0].type)) ? properties[0] : null;
  const complex = properties.length > 0 && !single;
  const returns = single ? edmOf(single) : complex ? `mscrm.${row.uniquename}Response` : null;
  const L = row.boundentitylogicalname;
  const bound = row.bindingtype === 1 ? `<Parameter Name="entity" Type="mscrm.${L}" />` : row.bindingtype === 2 ? `<Parameter Name="entityset" Type="Collection(mscrm.${L})" />` : '';
  const params = parametersOf(store, row).map((p) => `<Parameter Name="${p.uniquename}" Type="${edmOf(p)}" />`).join('');
  const complexType = complex ? `<ComplexType Name="${row.uniquename}Response">${properties.map((p) => `<Property Name="${p.uniquename}" Type="${edmOf(p)}" />`).join('')}</ComplexType>` : '';
  const element = row.isfunction ? 'Function' : 'Action';
  const attr = row.bindingtype ? ' IsBound="true"' : '';
  return `${complexType}<${element} Name="${row.uniquename}"${attr}>${bound}${params}${returns ? `<ReturnType Type="${returns}" />` : ''}</${element}>`;
}

function operationOf(api, row, options) {
  const name = row.uniquename;
  return {
    name,
    kind: row.isfunction ? 'function' : 'action',
    binding: BINDINGS[row.bindingtype],
    entity: row.bindingtype ? row.boundentitylogicalname : undefined,
    handle: (c) => invoke(api, name, c, options),
    // A getter, so the CSDL follows response properties and parameters added after registration.
    get csdl() { return csdlOf(api.store, name); },
  };
}

/**
 * Trusted pack handlers: a pack's `customApis` maps a custom API's unique name to `async (ctx) => ({ outputs })`, or to
 * { handler, pluginType } where pluginType is the full name of the provisioned plug-in type (named in plug-in messages;
 * the custom API name stands in when it is absent). ctx has name, inputs (typed by parameter, undefined when absent),
 * target ({ logicalName, id, row } when bound), caller, origin, version, api and trace(text), which records a plug-in
 * trace line. Throw { pluginFault: 'InvalidPluginExecutionException', message, errorCode? } for a plug-in fault; any
 * other throw is unhandled. Returns Map(lowercase unique name -> { handler, pluginType }).
 */
export function customApiHandlers(packs = []) {
  const result = new Map();
  for (const pack of packs) {
    if (pack.customApis === undefined) continue;
    const entries = pack.customApis;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new Error(`Data pack ${pack.id}: customApis must map custom API unique names to functions`);
    for (const [name, entry] of Object.entries(entries)) {
      const bare = typeof entry === 'function';
      const handler = bare ? entry : entry?.handler;
      const pluginType = bare ? undefined : entry?.pluginType;
      if (!name.trim() || typeof handler !== 'function') throw new Error(`Data pack ${pack.id}: invalid customApis handler for ${name}`);
      if (pluginType !== undefined && (typeof pluginType !== 'string' || !pluginType.trim())) throw new Error(`Data pack ${pack.id}: customApis pluginType for ${name} must be non-empty text`);
      if (result.has(key(name))) throw new Error(`Ambiguous customApis registration for ${name}`);
      result.set(key(name), { handler, pluginType: pluginType ?? null });
    }
  }
  return result;
}

/**
 * Seeds the customapi tables and registers every custom API row. Binding and kind are fixed after a row is
 * saved, so a registered name is never re-registered; deleted rows fail at call time with 0x8006088a.
 * Returns { sync, ready }: call sync when store.dataRevision() may have changed to register rows added since; await ready to persist the seed.
 * options: handlers (from customApiHandlers), pluginTypes (the pack pluginTypes handlers keyed by typename, P4) and timeoutMs (the plug-in limit, default 2 minutes).
 */
// seed runs now, so the mappings are in memory for the caller; ready persists them in a store transaction.
export function install(api, options = {}) {
  const { store, registry } = api;
  const resolved = { handlers: options.handlers ?? new Map(), pluginTypes: options.pluginTypes ?? new Map(), timeoutMs: options.timeoutMs ?? TIMEOUT_MS };
  seed(store);
  const ready = api.change(() => store.transact(() => seed(store)));
  let seen = null;
  const sync = () => {
    const revision = store.dataRevision();
    if (revision === seen) return;
    seen = revision;
    for (const row of store.tableRows('customapi')) if (!registry.has(row.uniquename)) registry.register(operationOf(api, row, resolved));
  };
  sync();
  return { sync, ready };
}
