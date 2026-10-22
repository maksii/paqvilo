// Simulated Dataverse custom APIs: the customapi tables, unpacked solution parsing, and registry
// operations for unbound, entity-bound and collection-bound functions and actions. A pack handler answers an API; without
// one, responses carry each response property at its type default.
//
// Power Fx-backed operations (Learn: functions-overview, low-code-plug-ins; customapi.FxExpressionId):
// - a custom API whose fxexpressionid names an fxexpression row (a Dataverse Function, formerly an instant low-code
//   plug-in) and has no pack handler evaluates that expression through api.providers.powerFx (the core Power Fx engine of
//   power-fx.mjs, or a pack adapter) with the typed inputs as values and the caller's Dataverse tables as data sources
//   (power-fx-dataverse.mjs); the { value } record maps onto the response properties (a lone property may take a scalar);
// - an automated low-code plug-in (an active fxexpression row with messagename Create, Update or Delete and an
//   entitylogicalname, not named by any custom API) runs as a pre-operation record step of that table and message:
//   ThisRecord is the row as written; Set on its columns changes the target (create and update); Error() refuses the write;
// - a Power Fx error value answers the plug-in fault envelope (400 0x80040265 with the error's message);
// - with the engine explicitly disabled a Function answers 501 PowerFxEvaluatorMissing (never default outputs), and an
//   automated plug-in reports POWERFX_AUTOMATED_NOT_EVALUATED once per expression and the write answers the same 501.
// describeCustomApis(api) is their capability record (behaviour while an evaluator answers) and
// powerFxRequirements(store, powerFx) their preflight rows (power-fx:evaluator only while the engine is disabled).
// unverified: the automated plug-in stage. The row carries no stage (the Accelerator registers a step); pre-operation is assumed.
// ponytail: automated plug-ins run inside the record write hooks, not as sdkmessageprocessingstep rows of the plug-in
// pipeline; registering them as steps of exported-plugins.mjs is the upgrade path when post-operation timing matters.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DataError } from './data-error.mjs';
import { isExactNumeric } from './exact-numeric.mjs';
import { collectPackExport } from './pack-exports.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { pluginFailure } from './plugin-fault.mjs';
import { denied } from './dataverse-fls.mjs';
import { changedColumns, dataverseHost } from './power-fx-dataverse.mjs';
import { privilegeDeniedError, uuidV5 } from './dataverse-security.mjs';
import { authorizeGrant, validateServiceProfile } from './local-organization-service.mjs';
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
const sameId = (a, b) => key(a?.id ?? a).replace(/[{}]/g, '') === key(b?.id ?? b).replace(/[{}]/g, '');
const typeOf = (code) => TYPES[Number(code)];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const int32 = (v) => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
// unverified: the value check for each type is this simulator's reading of the type name.
const CHECKS = {
  Boolean: (v) => typeof v === 'boolean',
  DateTime: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
  Decimal: (v) => num(v) || isExactNumeric(v), Float: num, Money: (v) => num(v) || isExactNumeric(v),
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
export function parseCustomApiFiles(files, { organizationId, fxexpressions = [] } = {}) {
  const ns = organizationId ?? FIXED_NAMESPACE;
  const rows = { customapi: [], customapirequestparameter: [], customapiresponseproperty: [] };
  const flag = (node, name) => ['1', 'true'].includes(childText(node, name));
  const numberOf = (node, name) => Number(childText(node, name) || 0);
  const textOf = (node, name) => childText(node, name) || null;
  // customapi.FxExpressionId (a Dataverse Function): <fxexpressionid> holds the id, or a nested <fxexpressionid> id or
  // <uniquename> of an fxexpression of the same Solution (fxexpressions/, parseFxExpressionFiles), as <plugintypeid> does
  // for a plug-in type (Learn: create-custom-api-solution). unverified: the exported element layout of this lookup.
  const fxReference = (root) => {
    const node = child(root, 'fxexpressionid');
    if (!node) return undefined;
    const id = bareId(childText(node, 'fxexpressionid') || (node.children.length ? '' : node.text));
    const name = childText(node, 'uniquename');
    const found = id || fxexpressions.find((row) => key(row.uniquename) === key(name))?.fxexpressionid || (name && fxExpressionIdOf(ns, name));
    return found ? { id: found, logical_name: 'fxexpression' } : undefined;
  };
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
        ...(fxReference(root) ? { fxexpressionid: fxReference(root) } : {}),
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

const bareId = (value) => key(value).replace(/[{}]/g, '').trim();
const fxExpressionIdOf = (ns, name) => uuidV5(ns, `fxexpression:${key(name)}`);

/**
 * Parses the Solution's fxexpression components (the Power Fx of a Dataverse Function or an automated low-code plug-in).
 * Each file is { path, text } relative to the fxexpressions folder: <name>/fxexpression.xml, root <fxexpression uniquename>
 * with the fxexpression columns as child elements (Learn: fxexpression table reference). Returns { fxexpression: rows }.
 * unverified: the exported folder and file layout; nothing was captured live, so it follows the customapis layout.
 */
export function parseFxExpressionFiles(files, { organizationId } = {}) {
  const ns = organizationId ?? FIXED_NAMESPACE;
  const fxexpression = [];
  for (const { path, text } of files) {
    if (String(path).split(/[\\/]/).at(-1).toLowerCase() !== 'fxexpression.xml') continue;
    const root = parseSolutionXml(text);
    const uniquename = root.attrs.uniquename ?? childText(root, 'uniquename') ?? String(path).split(/[\\/]/)[0];
    const textOf = (name) => childText(root, name) || null;
    fxexpression.push({
      fxexpressionid: bareId(textOf('fxexpressionid')) || fxExpressionIdOf(ns, uniquename),
      uniquename, name: textOf('name') ?? uniquename,
      expression: textOf('expression'), context: textOf('context'), parameters: textOf('parameters'),
      messagename: textOf('messagename'), entitylogicalname: textOf('entitylogicalname'),
      statecode: Number(textOf('statecode') ?? 0), statuscode: Number(textOf('statuscode') ?? 1),
    });
  }
  return { fxexpression };
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
    fields: { customapiid: GUID, uniquename: TEXT, name: TEXT, displayname: TEXT, description: TEXT, bindingtype: INT, boundentitylogicalname: TEXT, isfunction: BOOL, isprivate: BOOL, allowedcustomprocessingsteptype: INT, executeprivilegename: TEXT, workflowsdkstepenabled: BOOL, fxexpressionid: LOOKUP },
    // Navigation properties of the documented deep insert (CustomAPIRequestParameters, CustomAPIResponseProperties), and the
    // fxexpression lookup of a Dataverse Function (Learn, customapi: fxexpression_customapi, navigation fxexpression).
    relationships: {
      fxexpression: { schemaName: 'fxexpression_customapi', entity: 'fxexpression', from: 'fxexpressionid', to: 'fxexpressionid', many: false },
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
    // Called inside an open transaction (a flow run's Dataverse action, a changeset): the handler joins it instead of
    // queueing a transaction behind its own caller. ponytail: a throw then leaves its partial writes to the caller's
    // rollback; a savepoint in DataStore would roll back just the handler.
    if (api.store.inTransaction?.()) return await bounded();
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
  // A Function (fxexpressionid, no pack handler) evaluates its Power Fx expression; without an evaluator it answers 501.
  // Neither a handler nor an fxexpression: the platform still runs the API and answers each response property's default
  // (Learn, https://learn.microsoft.com/power-apps/developer/data-platform/custom-api#use-a-plug-in-to-include-logic-in-your-custom-api).
  const outputs = registration ? (await runHandler(api, registration.handler, ctx, plugin, timeoutMs))?.outputs ?? {}
    : fxIdOf(row) ? await fxOutputs(api, row, inputs, properties, c) : {};
  // "When an action is performed" (https://learn.microsoft.com/power-automate/dataverse/action-trigger) is a business event of
  // the committed action: a committed event (operation 'action') that the flow-trigger commit stager (flow-triggers.mjs) turns
  // into a durable job, so an action inside a changeset that rolls back never starts a flow. Outside a transaction the event
  // commits in its own one, which saves nothing unless a job was staged.
  const performed = () => store.recordCommittedEvent('', 'action', {}, [], { message: row.uniquename, table: row.bindingtype ? row.boundentitylogicalname : null, inputs, outputs });
  if (store.inTransaction?.()) performed();
  else await api.change(() => store.transact(performed, { skipSaveIfUnchanged: true, cloneResult: false, lazyReadSnapshot: true }));
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

// The fxexpression row a custom API names (customapi.fxexpressionid), or null.
const fxIdOf = (row) => row?.fxexpressionid?.id ?? row?.fxexpressionid ?? null;
const fxExpressionOf = (store, id) => store.tableRows('fxexpression').find((r) => sameId(r.fxexpressionid, id)) ?? null;
const evaluatorMissing = (what) => new DataError(`${what} is a Power Fx expression and the Power Fx engine is disabled; enable it or register a pack powerFx adapter.`, 501, 'PowerFxEvaluatorMissing');
// An evaluator answers: the core engine or a pack adapter (canvas-power-fx.mjs available); only the disabled engine does not.
const fxAvailable = (powerFx) => Boolean(powerFx && (powerFx.available ?? powerFx.registered));
const fxSynchronous = (powerFx) => powerFx.describe?.().operations?.some((item) => item.name === 'evaluateSync' && item.level === 'behaviour') === true;
// A Power Fx error value (Error(), division by zero...) answers the plug-in fault envelope with its message. A refused
// data-source write (a privilege or validation refusal behind the error value) answers that refusal itself: power-fx.mjs
// runtimeError returns the data source's DataError, the same envelope the Web API gives.
// unverified: native answers a Function's or plug-in's Power Fx error as an InvalidPluginExecutionException (0x80040265).
const fxFailure = (error, plugin) => (error?.code === 'PowerFxError'
  ? pluginFailure({ pluginFault: 'InvalidPluginExecutionException', message: error.message }, plugin, TIMEOUT_MS)
  : error);

// A Function's outputs: the expression evaluated with the typed inputs, its { value } record mapped onto the response
// properties. Learn ("Supported functions" for functions in Dataverse): the function reads and writes tables (Collect,
// Patch, Filter, LookUp) as the caller, in the transaction context: a synchronous evaluation runs as one atomic unit
// (api.runAtomic), so an error value after a write leaves no row behind. An entity-bound function's target is ThisRecord.
async function fxOutputs(api, row, inputs, properties, c) {
  const powerFx = api.providers?.powerFx;
  if (!fxAvailable(powerFx)) throw evaluatorMissing(`Custom API '${row.uniquename}'`);
  const expression = fxExpressionOf(api.store, fxIdOf(row));
  if (!expression?.expression) throw new DataError(`The fxexpression of custom API '${row.uniquename}' does not exist or has no expression.`, 404, 'PowerFxExpressionMissing');
  const plugin = { name: row.uniquename, id: row.customapiid, type: row.uniquename, traces: [] };
  const host = { ...dataverseHost(api, { c }), trace: (text) => plugin.traces.push(String(text)) };
  if (c.target?.row && c.target.mapping) host.scope = host.record(c.target.mapping.logicalName, c.target.row);
  const options = { values: { ...inputs }, principal: c.user?.systemuserid ?? null, host };
  let value;
  try {
    ({ value } = fxSynchronous(powerFx)
      ? await (api.runAtomic ?? ((fn) => fn()))(() => powerFx.evaluateSync(expression.expression, options))
      : await powerFx.evaluate(expression.expression, options));
  } catch (error) {
    throw fxFailure(error, plugin);
  }
  if (isObject(value)) return value;
  // unverified: a scalar result fills a lone response property.
  return properties.length === 1 ? { [properties[0].uniquename]: value } : {};
}

// The plug-in runs as the calling user, so its changes to the target pass the caller's column security; a secured column
// the caller may not write fails the write with the column-security refusal.
// unverified: Learn ("Supported functions" for functions in Dataverse) says the expression's operations "run directly
// against the function's IOrganizationService" in the transaction context; that the target changes are checked against the
// caller's column security is this simulator's reading of that execution context.
function assertColumnWrites(api, c, mapping, operation, existing, columns) {
  const fls = api.fieldSecurity;
  const user = c.user ?? (c.userId != null ? api.principals.byId?.(c.userId) : null);
  if (!fls?.canWrite || !user) return;
  const recordId = existing?.[mapping.idColumn];
  for (const column of columns) {
    if (fls.canWrite(user, mapping.logicalName, column, operation, recordId)) continue;
    throw denied(operation, user, column, mapping.logicalName);
  }
}

// Automated low-code plug-ins: active fxexpression rows with a message and a table, not the expression of a custom API.
const AUTOMATED = new Set(['create', 'update', 'delete']);
function automatedOf(store) {
  const functions = new Set(store.tableRows('customapi').map((row) => key(fxIdOf(row)).replace(/[{}]/g, '')).filter(Boolean));
  return store.tableRows('fxexpression').filter((row) => AUTOMATED.has(key(row.messagename)) && row.entitylogicalname
    && Number(row.statecode ?? 0) === 0 && !functions.has(key(row.fxexpressionid).replace(/[{}]/g, '')));
}

// beforeWrite: each automated plug-in of this table and message, in uniquename order. Synchronous (no promise) when the
// table has none, when no evaluator is registered (the write is refused) and when the adapter evaluates synchronously
// (evaluateSync at behaviour), so a synchronous SDK write runs the plug-ins inline; only an async-only adapter answers a
// promise, which a synchronous SDK write refuses (dataverse-records.mjs drive: SdkAsyncPreOperationUnsupported).
function runAutomated(api, reported, c, mapping, { operation, data, existing }) {
  const message = operation === 'upsert' ? (existing ? 'update' : 'create') : operation;
  if (!AUTOMATED.has(message) || !api.store.tableRows('fxexpression').length) return undefined;
  const steps = automatedOf(api.store).filter((row) => key(row.messagename) === message && key(row.entitylogicalname) === key(mapping.logicalName))
    .sort((a, b) => String(a.uniquename ?? a.name).localeCompare(String(b.uniquename ?? b.name)));
  if (!steps.length) return undefined;
  const powerFx = api.providers?.powerFx;
  if (!fxAvailable(powerFx)) {
    // The write would store a row the plug-in changes natively: refused, never stored unchanged.
    const name = steps[0].uniquename ?? steps[0].name ?? steps[0].fxexpressionid;
    if (!reported.has(key(name))) {
      reported.add(key(name));
      api.diagnostic?.({ code: 'POWERFX_AUTOMATED_NOT_EVALUATED', severity: 'warning', table: mapping.logicalName, operation: message, expression: name,
        message: `Automated low-code plug-in '${name}' (${message} of ${mapping.logicalName}) was not evaluated: the Power Fx engine is disabled; the write answers 501 PowerFxEvaluatorMissing.` });
    }
    throw evaluatorMissing(`Automated low-code plug-in '${name}'`);
  }
  const principal = c.user?.systemuserid ?? null;
  // ThisRecord is the row as written; Learn (low-code plug-ins): Set on its columns changes the target ("columns are treated
  // as global variables"), an Error() refuses the write with its message. A pack adapter's { value } record also changes
  // the target columns (the adapter contract).
  const host = dataverseHost(api, { c });
  const run = (step, evaluated) => {
    const plugin = { name: step.uniquename ?? step.name, id: step.fxexpressionid, type: step.uniquename ?? step.name, traces: [] };
    // Every column of the target is in ThisRecord (blank when unset), so Set reaches a column the payload does not name.
    const blank = Object.fromEntries(host.columns(mapping.logicalName).map((column) => [column, null]));
    const before = { ...blank, ...(existing ?? {}), ...(data ?? {}) };
    const scope = host.record(mapping.logicalName, before);
    const options = { values: { ThisRecord: before }, principal, host: { ...host, scope, trace: (text) => plugin.traces.push(String(text)) } };
    const finish = (result) => {
      if (message === 'delete' || !data) return;
      const changes = changedColumns(host, mapping.logicalName, host.record(mapping.logicalName, before), scope);
      assertColumnWrites(api, c, mapping, message, existing, Object.keys(changes));
      Object.assign(data, changes);
      if (powerFx.registered && isObject(result.value)) Object.assign(data, result.value);
    };
    try {
      const result = evaluated(step.expression, options);
      if (typeof result?.then !== 'function') return finish(result);
      return result.then(finish, (error) => { throw fxFailure(error, plugin); });
    } catch (error) {
      throw fxFailure(error, plugin);
    }
  };
  if (fxSynchronous(powerFx)) {
    for (const step of steps) run(step, (text, options) => powerFx.evaluateSync(text, options));
    return undefined;
  }
  return (async () => {
    for (const step of steps) await run(step, (text, options) => powerFx.evaluate(text, options));
  })();
}

/**
 * Capability record of the Power Fx-backed operations this store holds: one operation per Function (custom API with an
 * fxexpressionid) and per automated low-code plug-in, at behaviour when an evaluator answers (the core engine or a pack
 * adapter), else (the engine disabled) contract.
 */
export function describeCustomApis(api) {
  const store = api?.store;
  const registered = fxAvailable(api?.providers?.powerFx);
  const level = registered ? 'behaviour' : 'contract';
  const functions = store ? store.tableRows('customapi').filter((row) => fxIdOf(row)).map((row) => ({ name: `function:${row.uniquename}`, level })) : [];
  const automated = store ? automatedOf(store).map((row) => ({ name: `automated:${row.uniquename ?? row.name}`, level })) : [];
  return { name: 'dataverse-customapi', version: 1, kind: 'dataverse-extension', level: registered || !(functions.length + automated.length) ? 'behaviour' : 'contract',
    operations: [{ name: 'customApi', level: 'behaviour' }, ...functions, ...automated], requires: ['provider:powerFx'], principal: 'caller', stateOwner: 'store', lifecycle: 'per-request' };
}

/**
 * Preflight provider rows (capability-report.mjs buildPreflightReport providers): none while an evaluator answers (the core
 * engine or a pack adapter); with the engine disabled, power-fx:evaluator missing once per Power Fx-backed operation.
 */
export function powerFxRequirements(store, powerFx) {
  if (fxAvailable(powerFx)) return [];
  const of = (what) => ({ id: 'power-fx:evaluator', reachable: false, message: `Required by ${what}; the Power Fx engine is disabled.` });
  return [...store.tableRows('customapi').filter((row) => fxIdOf(row)).map((row) => of(`Function (custom API) ${row.uniquename}`)),
    ...automatedOf(store).map((row) => of(`automated low-code plug-in ${row.uniquename ?? row.name}`))];
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
 * The message entry for callers outside the Web API (the flow Dataverse connector's PerformBoundAction and
 * PerformUnboundAction): store.recordPipeline.executeMessageInternal({ principal, name, target: { entity, id } | null,
 * parameters }) -> { statusCode, body }. Runs the registered operation (a custom API, a Function, a built-in or pack
 * message) exactly as its Web API route: an action takes parameters as its body, a function (when no action has the name)
 * as its parameters. principal is an explicit local backend profile: it needs an execute grant naming the message
 * ({ message, operations: ['execute'] }, else 403 LocalBackendPermissionDenied) and a bound call its read grant on the
 * target row; the operation then runs as the profile's systemuser (never SYSTEM: a profile whose userId has no systemuser
 * answers 403 LocalBackendIdentityRequired), so execute privileges and the
 * writes inside it follow that user. The body drops its @odata.context. Unknown names answer 404 0x80060888.
 */
async function executeMessageInternal(api, { principal, name, target = null, parameters = {} } = {}) {
  validateServiceProfile(principal);
  if (!principal.grants.some((grant) => grant.message === name && grant.operations.includes('execute')))
    throw new DataError(`Local backend profile denied execute on ${name}.`, 403, 'LocalBackendPermissionDenied');
  const { store, registry } = api;
  let binding = 'unbound', entity, row = null, mapping = null;
  if (target) {
    mapping = store.resolveMapping(target.entity);
    entity = mapping.logicalName;
    if (target.id == null) binding = 'collection';
    else {
      binding = 'entity';
      row = store.tableRows(entity).find((item) => sameId(item[mapping.idColumn], target.id)) ?? null;
      if (!row) throw new DataError(`${entity} With Id = ${target.id} Does Not Exist`, 404, 'NotFound');
      authorizeGrant(store, principal, entity, 'read', row);
    }
  }
  const op = registry.find({ name, kind: 'action', binding, entity }) ?? registry.find({ name, kind: 'function', binding, entity });
  if (!op) throw notFound(name);
  const user = api.principals?.byId?.(principal.userId) ?? null;
  if (!user) throw new DataError('The flow profile names no systemuser; bound and unbound actions run as that user, never as SYSTEM.', 403, 'LocalBackendIdentityRequired');
  const action = op.kind === 'action', origin = 'http://localhost';
  const url = new URL(`${origin}/api/data/v9.2/${name}`);
  const result = await op.handle({
    method: action ? 'POST' : 'GET', url, origin, version: 'v9.2', prefer: {}, headers: {}, body: action ? { ...parameters } : undefined,
    params: action ? {} : { ...parameters }, user, caller: null, identity: { id: principal.userId, admin: true }, requestId: null, api,
    target: binding === 'entity' ? { mapping, id: row[mapping.idColumn], row } : binding === 'collection' ? { mapping } : undefined,
  });
  if (!result) return { statusCode: 204, body: {} };
  const body = result.body !== null && typeof result.body === 'object' && !Buffer.isBuffer(result.body)
    ? Object.fromEntries(Object.entries(result.body).filter(([key]) => key !== '@odata.context')) : (result.body ?? {});
  return { statusCode: result.status ?? 200, body };
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
  return new Map([...collectPackExport(packs, 'customApis')].map(([name, { value }]) => [name,
    typeof value === 'function' ? { handler: value, pluginType: null } : { handler: value.handler, pluginType: value.pluginType ?? null }]));
}

/**
 * Seeds the customapi tables and supplies their current operation definitions to
 * the canonical registry. Row edits, signatures and deletions are visible on its
 * next read. Small embedded registries can retain the legacy sync-on-revision adapter.
 * Returns { sync, ready }; await ready to persist the seed.
 * options: handlers (from customApiHandlers), pluginTypes (the pack pluginTypes handlers keyed by typename, P4) and timeoutMs (the plug-in limit, default 2 minutes).
 */
// seed runs now, so the mappings are in memory for the caller; ready persists them in a store transaction.
const automatedHooks = new WeakSet();
export function install(api, options = {}) {
  const { store, registry } = api;
  const resolved = { handlers: options.handlers ?? new Map(), pluginTypes: options.pluginTypes ?? new Map(), timeoutMs: options.timeoutMs ?? TIMEOUT_MS };
  seed(store);
  const ready = api.change(() => store.transact(() => seed(store)));
  if (api.records) api.records.executeMessageInternal = (request) => executeMessageInternal(api, request);
  // Automated low-code plug-ins: one beforeWrite hook per hook list (install runs again on reset).
  if (api.recordHooks && !automatedHooks.has(api.recordHooks)) {
    automatedHooks.add(api.recordHooks);
    const reported = new Set();
    api.recordHooks.add('beforeWrite', (c, mapping, info) => runAutomated(api, reported, c, mapping, info), 'dataverse-customapi (automated low-code plug-ins)');
  }
  if (registry.setProvider) {
    registry.setProvider('dataverse-customapi', () => store.tableRows('customapi').map(row => operationOf(api, row, resolved)));
    return { sync: () => {}, ready };
  }
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
