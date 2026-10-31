import { initializePluginOperation } from './plugin-operation-context.mjs';
import { canonicalTagVariables } from './plugin-request-tag.mjs';
import { dataverseScalarCause } from './dataverse-scalar-reader.mjs';
// Simulated Dataverse custom APIs: the customapi tables, unpacked solution parsing, and registry
// operations for unbound, entity-bound and collection-bound functions and actions. A pack handler answers an API; without
// one, responses carry each response property at its type default.
//
// Power Fx-backed operations (customapi.FxExpressionId):
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
// The fxexpression row carries no stage, so automated plug-ins are assumed to run pre-operation.
// ponytail: automated plug-ins run inside the record write hooks, not as sdkmessageprocessingstep rows of the plug-in
// pipeline; registering them as steps of exported-plugins.mjs is the upgrade path when post-operation timing matters.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DataError } from './data-error.mjs';
import { isExactNumeric } from './exact-numeric.mjs';
import { cloneStateData } from './state-clone.mjs';
import { collectPackExport } from './pack-exports.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { pluginFailure } from './plugin-fault.mjs';
import {
  pluginExecutionLifetime,
  pluginInvocationDepth,
  pluginInvocationSdkParent,
} from './plugin-execution-lifetime.mjs';
import { pluginMessageParameters, pluginMessageValues } from './plugin-message-values.mjs';
import {
  clrContext,
  closeClrHostPool,
  executeClrPlugin,
  pluginExecutionDepth,
  prepareClrRuntime,
  PLUGIN_MAX_DEPTH,
  pluginDepthFault,
} from './plugin-clr.mjs';
import { qualifiedTypeName, recordPluginTrace } from './plugin-trace.mjs';
import { uploadedAssemblyOfType, uploadedClrRuntime } from './plugin-uploaded.mjs';
import { pluginStepBypassed, pluginBypassOwnership } from './plugin-bypass.mjs';
import { denied } from './dataverse-fls.mjs';
import { changedColumns, dataverseHost } from './power-fx-dataverse.mjs';
import { privilegeDeniedError, uuidV5 } from './dataverse-security.mjs';
import { authorizeGrant, validateServiceProfile } from './local-organization-service.mjs';
import { child, childText, parseSolutionXml } from './solution-xml.mjs';

// Dataverse type codes 0-12 (customapirequestparameter.type and customapiresponseproperty.type).
const TYPES = [
  'Boolean',
  'DateTime',
  'Decimal',
  'Entity',
  'EntityCollection',
  'EntityReference',
  'Float',
  'Integer',
  'Money',
  'Picklist',
  'String',
  'StringArray',
  'Guid',
];
const BINDINGS = ['unbound', 'entity', 'collection'];
const EDM = {
  Boolean: 'Edm.Boolean',
  DateTime: 'Edm.DateTimeOffset',
  Decimal: 'Edm.Decimal',
  Float: 'Edm.Double',
  Integer: 'Edm.Int32',
  Money: 'Edm.Decimal',
  Picklist: 'Edm.Int32',
  String: 'Edm.String',
  StringArray: 'Collection(Edm.String)',
  Guid: 'Edm.Guid',
};
// Optional inputs use CLR defaults; missing outputs stay absent until the final response.
const INPUT_DEFAULTS = {
  Boolean: false,
  DateTime: '0001-01-01T00:00:00.0000000',
  Decimal: 0,
  Float: 0,
  Integer: 0,
  Guid: '00000000-0000-0000-0000-000000000000',
};
// ponytail: the Dataverse plug-in timeout (2 minutes); install({ timeoutMs }) overrides it for tests.
const TIMEOUT_MS = 120000;
const executionConfigurations = new WeakMap();
const SINGLE = new Set(['Entity', 'EntityCollection']); // a lone response property of these types is the response itself
const GUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_KINDS = {
  'customapi.xml': 'customapi',
  'customapirequestparameter.xml': 'customapirequestparameter',
  'customapiresponseproperty.xml': 'customapiresponseproperty',
};
// Same fixed namespace dataverse-security.mjs uses for its default ids.
const FIXED_NAMESPACE = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';

const key = (value) => String(value ?? '').toLowerCase();
const sameId = (a, b) => key(a?.id ?? a).replace(/[{}]/g, '') === key(b?.id ?? b).replace(/[{}]/g, '');
const typeOf = (code) => TYPES[Number(code)];
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => typeof v === 'number' && Number.isFinite(v);
const int32 = (v) => Number.isInteger(v) && v >= -2147483648 && v <= 2147483647;
// Assumed: the value check for each type follows the type name; native checks are not known.
const CHECKS = {
  Boolean: (v) => typeof v === 'boolean',
  DateTime: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
  Decimal: (v) => num(v) || isExactNumeric(v),
  Float: num,
  Money: (v) => num(v) || isExactNumeric(v),
  Integer: int32,
  Picklist: int32,
  String: (v) => typeof v === 'string',
  StringArray: (v) => Array.isArray(v) && v.every((x) => typeof x === 'string'),
  Guid: (v) => typeof v === 'string' && GUID_RE.test(v),
  Entity: isObject,
  EntityReference: isObject,
  EntityCollection: Array.isArray,
};

const httpOutputDefault = (type) => (type === 'StringArray' || type === 'EntityCollection' ? [] : null);
// Assumed: crmbaseentity is the entity type when logicalentityname is empty.
function edmOf(property) {
  const type = typeOf(property.type);
  if (EDM[type]) return EDM[type];
  const entity = `mscrm.${property.logicalentityname ?? 'crmbaseentity'}`;
  return type === 'EntityCollection' ? `Collection(${entity})` : entity;
}

// Native answers an unregistered (or unanswerable) Custom API with 404 0x80060888 and the segment message.
const notFound = (name) =>
  new DataError(`Resource not found for the segment '${name}'.`, 404, 'UnknownEntity', {
    httpStatus: 404,
    innerCode: '0x80060888',
    route: true,
  });
const apiNamed = (store, name) => store.tableRows('customapi').find((r) => key(r.uniquename) === key(name));
const parametersOf = (store, row) =>
  store.tableRows('customapirequestparameter').filter((p) => sameId(p.customapiid, row.customapiid));
const propertiesOf = (store, row) =>
  store.tableRows('customapiresponseproperty').filter((p) => sameId(p.customapiid, row.customapiid));

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
  // for a plug-in type. The exported element layout of this lookup is assumed.
  const fxReference = (root) => {
    const node = child(root, 'fxexpressionid');
    if (!node) return undefined;
    const id = bareId(childText(node, 'fxexpressionid') || (node.children.length ? '' : node.text));
    const name = childText(node, 'uniquename');
    const found =
      id ||
      fxexpressions.find((row) => key(row.uniquename) === key(name))?.fxexpressionid ||
      (name && fxExpressionIdOf(ns, name));
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
        ...common,
        customapiid,
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
 * with the fxexpression columns as child elements. Returns { fxexpression: rows }.
 * The exported folder and file layout is assumed to follow the customapis layout.
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
      uniquename,
      name: textOf('name') ?? uniquename,
      expression: textOf('expression'),
      context: textOf('context'),
      parameters: textOf('parameters'),
      messagename: textOf('messagename'),
      entitylogicalname: textOf('entitylogicalname'),
      statecode: Number(textOf('statecode') ?? 0),
      statuscode: Number(textOf('statuscode') ?? 1),
      customizationlevel: textOf('customizationlevel') == null ? null : Number(textOf('customizationlevel')),
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

const field = (fields) =>
  Object.fromEntries(Object.entries(fields).map(([name, type]) => [name, { dataverseType: type }]));
const TEXT = 'nvarchar',
  INT = 'int',
  BOOL = 'bit',
  GUID = 'uniqueidentifier',
  LOOKUP = 'lookup';
// Tables seeded by the simulated Dataverse API (dataverseOnly), as in dataverse-security.mjs.
const SEEDED = {
  customapi: {
    set: 'customapis',
    id: 'customapiid',
    fields: {
      customapiid: GUID,
      uniquename: TEXT,
      name: TEXT,
      displayname: TEXT,
      description: TEXT,
      bindingtype: INT,
      boundentitylogicalname: TEXT,
      isfunction: BOOL,
      isprivate: BOOL,
      allowedcustomprocessingsteptype: INT,
      executeprivilegename: TEXT,
      workflowsdkstepenabled: BOOL,
      fxexpressionid: LOOKUP,
    },
    // Navigation properties of the documented deep insert (CustomAPIRequestParameters, CustomAPIResponseProperties), and the
    // fxexpression lookup of a Dataverse Function (fxexpression_customapi, navigation fxexpression).
    relationships: {
      fxexpression: {
        schemaName: 'fxexpression_customapi',
        entity: 'fxexpression',
        from: 'fxexpressionid',
        to: 'fxexpressionid',
        many: false,
      },
      CustomAPIRequestParameters: {
        schemaName: 'customapi_customapirequestparameter',
        entity: 'customapirequestparameter',
        from: 'customapiid',
        to: 'customapiid',
        many: true,
      },
      CustomAPIResponseProperties: {
        schemaName: 'customapi_customapiresponseproperty',
        entity: 'customapiresponseproperty',
        from: 'customapiid',
        to: 'customapiid',
        many: true,
      },
    },
  },
  // Assumed: entity set names of the two child tables.
  customapirequestparameter: {
    set: 'customapirequestparameters',
    id: 'customapirequestparameterid',
    fields: {
      customapirequestparameterid: GUID,
      uniquename: TEXT,
      name: TEXT,
      displayname: TEXT,
      description: TEXT,
      type: INT,
      logicalentityname: TEXT,
      isoptional: BOOL,
      customapiid: LOOKUP,
    },
    relationships: {
      CustomAPIId: {
        schemaName: 'customapi_customapirequestparameter',
        entity: 'customapi',
        from: 'customapiid',
        to: 'customapiid',
        many: false,
      },
    },
  },
  customapiresponseproperty: {
    set: 'customapiresponseproperties',
    id: 'customapiresponsepropertyid',
    fields: {
      customapiresponsepropertyid: GUID,
      uniquename: TEXT,
      name: TEXT,
      displayname: TEXT,
      description: TEXT,
      type: INT,
      logicalentityname: TEXT,
      customapiid: LOOKUP,
    },
    relationships: {
      CustomAPIId: {
        schemaName: 'customapi_customapiresponseproperty',
        entity: 'customapi',
        from: 'customapiid',
        to: 'customapiid',
        many: false,
      },
    },
  },
};

function seed(store) {
  for (const [logical, def] of Object.entries(SEEDED)) {
    // An existing mapping is kept as it is, so a mapping without dataverseOnly is never flipped or overwritten.
    store.state.mappings[logical] ??= {
      logicalName: logical,
      entitySet: def.set,
      idColumn: def.id,
      nameColumn: 'name',
      userConfigured: true,
      dataverseOnly: true,
      fields: field(def.fields),
      relationships: def.relationships ?? {},
    };
    store.state.tables[logical] ??= [];
  }
}

// The OData payload reader's failure (0x80048d19, Entity ''). Its stack trace is not reproduced.
const payloadError = (detail) =>
  new DataError(
    `Error identified in Payload provided by the user for Entity :'', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : Microsoft.OData.ODataException: ${detail}`,
    400,
    'InvalidRequest',
    { innerCode: '0x80048d19' },
  );
const literal = (value) => (value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value));

// The typed value of a literal, or undefined when it does not convert. The strings 'true' and 'false' convert to Boolean.
function typedValue(type, value) {
  if (type === 'Boolean' && (value === 'true' || value === 'false')) return value === 'true';
  return CHECKS[type]?.(value) ? value : undefined;
}

// Native names the first element of a string array that is not a string.
function conversionFailure(type, value, context, property) {
  const array = type === 'StringArray' && Array.isArray(value);
  const shown = array ? value.find((item) => !CHECKS.String(item)) : value;
  const expected = array ? 'Edm.String' : EDM[type];
  if (context.method === 'POST' && context.dataverseHttpReader?.hasJsonBody === true) {
    const key = array ? String(value.findIndex((item) => !CHECKS.String(item))) : property;
    const cause = dataverseScalarCause(shown, expected, {
      ieee754Compatible: context.dataverseHttpReader.ieee754Compatible,
      numericLexeme: context.dataverseHttpReader.numberLexemeFor?.(key, shown),
    });
    if (cause) return cause;
  }
  return `Cannot convert the literal '${literal(shown)}' to the expected type '${expected}'.`;
}

// Parameter values come from the URL for functions and the JSON body for actions. Returns the typed values by name.
function checkParameters(store, row, c) {
  const input = c.method === 'POST' ? (c.body ?? {}) : (c.params ?? {});
  const params = parametersOf(store, row);
  for (const name of Object.keys(input))
    if (!params.some((p) => p.uniquename === name))
      throw payloadError(
        `The parameter '${name}' in the request payload is not a valid parameter for the operation '${row.uniquename}'.`,
      );
  const typed = {};
  for (const p of params) {
    const type = typeOf(p.type),
      value = input[p.uniquename];
    if (value === undefined || value === null) {
      // A function's URL must name every required parameter; without one native finds no resource (404 0x80060888).
      if (!p.isoptional && row.isfunction) throw notFound(row.uniquename);
      if (!p.isoptional && type === 'String' && c.method === 'POST' && c.dataverseHttpReader?.hasJsonBody === true)
        throw payloadError(
          value === undefined
            ? `One or more parameters of the operation '${row.uniquename}' are missing from the request payload. The missing parameters are: ${p.uniquename}.`
            : `A null value was found for property named '${p.uniquename}', expected type 'Edm.String[Nullable=False]' does not allow null values.`,
        );
      // Native message text of the missing-parameter error not known.
      if (!p.isoptional)
        throw new DataError(`Required parameter '${p.uniquename}' is missing.`, 400, 'InvalidRequest', {
          innerCode: '0x80040203',
        });
      // Optional arguments are always present. Native value types receive
      // their CLR default; reference-based SDK types receive null. Input
      // DateTime.MinValue has Unspecified Kind, independent of response defaults.
      typed[p.uniquename] = INPUT_DEFAULTS[type] ?? null;
      continue;
    }
    const converted = typedValue(type, value);
    if (converted === undefined) throw payloadError(conversionFailure(type, value, c, p.uniquename));
    typed[p.uniquename] = converted;
  }
  return typed;
}

// Response values come from the handler's outputs; an output it leaves out is the native default.
function responseBody(c, row, properties, outputs = {}) {
  const single = properties.length === 1 && SINGLE.has(typeOf(properties[0].type)) ? properties[0] : null;
  if (single) {
    // Assumed: @odata.context and body of a lone Entity or EntityCollection response.
    const body = { '@odata.context': contextUrl(c.origin, c.version, edmOf(single)) };
    const value = outputs[single.uniquename];
    if (typeOf(single.type) === 'EntityCollection') return { ...body, value: Array.isArray(value) ? value : [] };
    return isObject(value) ? { ...body, ...value } : body;
  }
  return {
    '@odata.context': contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${row.uniquename}Response`),
    ...Object.fromEntries(
      properties.map((p) => [
        p.uniquename,
        outputs[p.uniquename] !== undefined ? outputs[p.uniquename] : httpOutputDefault(typeOf(p.type)),
      ]),
    ),
  };
}

// Runs the trusted handler as one store transaction in the change slot: a throw or a timeout rolls its writes back.
// The invocation lifetime fences late SDK/API continuations after completion or
// timeout. JavaScript cannot preempt arbitrary trusted code or external I/O.
function mainInvocationContext(execution, api, ctx) {
  return {
    ...ctx,
    api: execution.exposed(api),
    caller: cloneStateData(ctx.caller),
    ...(ctx.target ? { target: { ...ctx.target, row: cloneStateData(ctx.target.row) } } : {}),
  };
}
async function runHandler(api, handler, ctx, plugin, timeoutMs, contextOf) {
  api.store.ensureReadSnapshot();
  const depth = mainPluginDepth(api.store);
  const started = performance.now(),
    startedAt = new Date(api.store.clock.now()).toISOString();
  let failure;
  const atomic = api.runAtomic ?? ((fn) => api.store.transact(fn));
  const bounded = () => {
    const execution = pluginExecutionLifetime(api.store, depth, contextOf ? () => contextOf(depth) : undefined);
    let timer;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { timedOut: true })), timeoutMs);
    });
    return Promise.race([
      Promise.resolve().then(() =>
        execution.run(() =>
          Promise.resolve(handler(mainInvocationContext(execution, api, ctx))).then((value) =>
            execution.snapshot(value),
          ),
        ),
      ),
      limit,
    ]).finally(() => {
      execution.close();
      clearTimeout(timer);
    });
  };
  try {
    // Called inside an open transaction (a flow run's Dataverse action, a changeset): the handler joins it instead of
    // queueing a transaction behind its own caller. ponytail: a throw then leaves its partial writes to the caller's
    // rollback; a savepoint in DataStore would roll back just the handler.
    if (api.store.inTransaction?.()) return await bounded();
    return await api.change(() => atomic(bounded));
  } catch (error) {
    failure = error.code === 'LocalPluginDepth' ? error : pluginFailure(error, plugin, timeoutMs);
    throw failure;
  } finally {
    recordPluginTrace(api.store, {
      typeName: qualifiedTypeName(api.store, { typeName: plugin.type, assemblyId: plugin.assemblyId }),
      messageName: plugin.name,
      entity: ctx.target?.logicalName ?? 'none',
      depth,
      traces: plugin.traces,
      started,
      startedAt,
      error: failure,
      ...plugin.traceIds?.(),
    });
  }
}

// A custom API whose plugintypeid names a plug-in type with a pluginTypes handler runs that handler as its main operation.
// A customApis entry for the API wins. The plug-in's name for messages is the type's typename.
function typeRegistration(store, row, pluginTypes) {
  const typeId = row.plugintypeid?.id ?? row.plugintypeid;
  if (!typeId) return undefined;
  const type = store.tableRows('plugintype').find((item) => key(item.plugintypeid) === key(typeId));
  const handler = type && pluginTypes.get(type.typename);
  return handler ? { handler, pluginType: type.typename } : undefined;
}

// The assembly of the plug-in type a custom API names: the trace row's typename is assembly-qualified (qualifiedTypeName).
function typeAssemblyId(store, row) {
  const typeId = row.plugintypeid?.id ?? row.plugintypeid;
  const type = typeId ? store.tableRows('plugintype').find((item) => key(item.plugintypeid) === key(typeId)) : null;
  return type?.pluginassemblyid?.id ?? type?.pluginassemblyid ?? null;
}

// Without a descriptor, a plug-in type in an assembly with uploaded content runs those bytes, as a registered step does
// (plugin-uploaded.mjs, user decision C08).
function clrRegistration(store, row, options) {
  const id = key(row.customapiid).replace(/[{}]/g, '');
  const descriptor = options.pluginRuntimes?.get(id);
  const typeId = row.plugintypeid?.id ?? row.plugintypeid;
  const uploaded = !descriptor && typeId ? uploadedAssemblyOfType(store, typeId) : null;
  if (!descriptor && !uploaded) return null;
  const type = store.tableRows('plugintype').find((entry) => key(entry.plugintypeid) === key(typeId));
  if (!uploaded && (!type || descriptor.typeName !== type.typename))
    return { id, reason: 'The trusted main-operation runtime does not match the exported plug-in type.' };
  const messageIds = new Set(
    store
      .tableRows('sdkmessage')
      .filter((entry) => entry.name === row.uniquename)
      .map((entry) => key(entry.sdkmessageid)),
  );
  const steps = store
    .tableRows('sdkmessageprocessingstep')
    .filter(
      (entry) =>
        Number(entry.stage) === 30 &&
        messageIds.has(key(entry.sdkmessageid?.id ?? entry.sdkmessageid)) &&
        key(entry.plugintypeid?.id ?? entry.plugintypeid ?? entry.eventhandler?.id ?? entry.eventhandler) ===
          key(typeId),
    );
  if (uploaded)
    return {
      id,
      type,
      uploaded: {
        id,
        uploadedAssemblyId: key(uploaded.pluginassemblyid),
        typeName: type.typename,
        assemblyName: uploaded.name,
      },
      // The platform creates the main operation's step; without that row the local step id derives from the API id.
      step:
        steps.length === 1
          ? steps[0]
          : {
              sdkmessageprocessingstepid: uuidV5(id, 'customapi:main-operation'),
              name: `CustomApi '${row.uniquename}' implementation`,
            },
    };
  const context = descriptor.context;
  const witnessed =
    /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(context?.mainOperationStepId ?? '') &&
    typeof context.mainOperationStepEvidence === 'string' &&
    context.mainOperationStepEvidence.trim() &&
    context.mainOperationStepEvidence.length <= 2048;
  const step =
    steps.length === 1
      ? steps[0]
      : witnessed
        ? {
            sdkmessageprocessingstepid: context.mainOperationStepId,
            name: `CustomApi '${row.uniquename}' implementation`,
          }
        : null;
  return {
    id,
    descriptor,
    type,
    step,
    ...(!step
      ? {
          reason:
            'The original main-operation context requires its exported internal step or an evidence-qualified mainOperationStepId.',
        }
      : {}),
  };
}

function runHandlerSync(api, handler, ctx, plugin, contextOf) {
  api.store.ensureReadSnapshot();
  const depth = mainPluginDepth(api.store);
  const execution = pluginExecutionLifetime(api.store, depth, contextOf ? () => contextOf(depth) : undefined);
  const started = performance.now(),
    startedAt = new Date(api.store.clock.now()).toISOString();
  let failure;
  try {
    const answer = execution.run(() => handler(mainInvocationContext(execution, api, ctx)));
    if (answer?.then) {
      Promise.resolve(answer).catch(() => {});
      throw new DataError(
        'A synchronous SDK custom API requires a synchronous main-operation handler.',
        501,
        'SdkAsyncPreOperationUnsupported',
      );
    }
    return execution.snapshot(answer);
  } catch (error) {
    failure = ['SdkAsyncPreOperationUnsupported', 'LocalPluginDepth'].includes(error.code)
      ? error
      : pluginFailure(error, plugin, 0);
    throw failure;
  } finally {
    execution.close();
    recordPluginTrace(api.store, {
      typeName: qualifiedTypeName(api.store, { typeName: plugin.type, assemblyId: plugin.assemblyId }),
      messageName: plugin.name,
      entity: ctx.target?.logicalName ?? 'none',
      depth,
      traces: plugin.traces,
      started,
      startedAt,
      error: failure,
      ...plugin.traceIds?.(),
    });
  }
}

function mainPluginDepth(store) {
  const depth =
    Math.max(
      pluginExecutionDepth(),
      pluginInvocationDepth(store),
      Number((store.pluginParentContext ?? pluginInvocationSdkParent(store))?.values?.Depth ?? 0),
    ) + 1;
  if (depth > PLUGIN_MAX_DEPTH) throw pluginDepthFault();
  return depth;
}

function driveMessageSync(iterator) {
  let next = iterator.next();
  while (!next.done) {
    if (next.value?.then) {
      Promise.resolve(next.value).catch(() => {});
      next = iterator.throw(
        new DataError(
          'A synchronous SDK custom API encountered an asynchronous provider.',
          501,
          'SdkAsyncPreOperationUnsupported',
        ),
      );
    } else next = iterator.next(next.value);
  }
  return next.value;
}

async function driveMessageAsync(iterator) {
  let next = iterator.next();
  while (!next.done) {
    let answer;
    try {
      answer = await next.value;
    } catch (error) {
      next = iterator.throw(error);
      continue;
    }
    next = iterator.next(answer);
  }
  return next.value;
}

// One custom-api span per invocation (docs/design/tracing.md): the handler's trace lines are its events, and its writes nest
// under it; the inputs and outputs are captured only at level full.
function tracedInvocation(api, name, c, run) {
  const traces = api.store.traces;
  if (!traces?.enabled) return run(null);
  return traces.wrap(
    {
      kind: 'custom-api',
      name,
      module: 'customapi',
      operation: 'action',
      entity: c.target?.mapping?.logicalName ?? null,
      recordId: c.target?.id == null ? null : String(c.target.id),
    },
    run,
  );
}

function invoke(api, name, c, options) {
  return tracedInvocation(api, name, c, (span) => {
    const execute = () => driveMessageAsync(invokeSteps(api, name, c, options, false, span));
    if (api.store.inTransaction?.()) return execute();
    const atomic = api.runAtomic ?? ((fn) => api.store.transact(fn));
    return api.change(() => atomic(execute));
  });
}

function* invokeSteps(api, name, c, options, synchronous = false, span = null) {
  const { handlers, pluginTypes = new Map(), timeoutMs: limit } = options;
  const { store } = api;
  // The limit may be a function, read per call: the admin Environment settings change it while the simulator runs.
  const timeoutMs = typeof limit === 'function' ? limit() : limit;
  const row = apiNamed(store, name);
  if (!row) throw notFound(name);
  // Functions are GET and actions are POST; another verb gets the generic 404 envelope.
  if (c.method !== (row.isfunction ? 'GET' : 'POST'))
    throw new DataError(`No HTTP resource was found that matches the request URI '${c.url}'.`, 404, 'NotFound', {
      innerCode: '',
    });
  if (row.executeprivilegename && !api.principals.privileges(c.user).has(row.executeprivilegename))
    throw privilegeDeniedError(c.user, row.executeprivilegename, row.boundentitylogicalname ?? row.uniquename);
  const inputs = checkParameters(store, row, c);
  const properties = propertiesOf(store, row);
  // Assumed: a function must have a response property, so without one it is absent and its plug-in never runs.
  if (!properties.length && row.isfunction) throw notFound(name);
  const registration = handlers.get(key(name)) ?? typeRegistration(store, row, pluginTypes);
  const original = !registration && !fxIdOf(row) ? clrRegistration(store, row, options) : null;
  if (row.plugintypeid && !registration && !fxIdOf(row) && !original?.descriptor && !original?.uploaded)
    throw new DataError(
      `Custom API '${row.uniquename}' names an original main-operation plug-in with no trusted local implementation.`,
      501,
      'LocalPluginMainOperationUnavailable',
    );
  if (original?.descriptor && !original.step)
    throw new DataError(original.reason, 501, 'LocalPluginMainContextUnavailable');
  span?.set({
    isFunction: row.isfunction === true,
    bindingType: Number(row.bindingtype ?? 0),
    handler: registration
      ? 'handler'
      : fxIdOf(row)
        ? 'powerfx'
        : original?.descriptor || original?.uploaded
          ? 'clr'
          : 'none',
  });
  // The plug-in's type (the custom API name when the pack names none) and the trace lines its handler writes; it runs as
  // the main operation (stage 30) at the main operation's depth (its fault identity, D-R3-19).
  const plugin = {
    name: row.uniquename,
    id: row.customapiid,
    type: registration?.pluginType ?? original?.type?.typename ?? row.uniquename,
    assemblyId: typeAssemblyId(store, row),
    traces: [],
    stage: 30,
    depth: pluginExecutionDepth() + 1,
    // The request identity the main operation's context carries (read when its trace row is written).
    traceIds: () => ({ requestId: frame?.requestId, correlationId: frame?.correlationId }),
  };
  // Typed inputs, the bound target (entity or collection) and the caller. Without a pack handler the outputs are the defaults.
  const ctx = {
    name: row.uniquename,
    inputs,
    api,
    origin: c.origin,
    version: c.version,
    caller: c.caller,
    target: c.target && { logicalName: c.target.mapping?.logicalName, id: c.target.id, row: c.target.row },
    trace: (text) => {
      plugin.traces.push(String(text));
      span?.event('trace', { message: String(text) });
    },
  };
  const entity = row.bindingtype ? row.boundentitylogicalname : 'none',
    operation = row.uniquename.toLowerCase(),
    customApi = {
      name: row.uniquename,
      bindingType: row.bindingtype ?? 0,
      allowedCustomProcessingStepType: row.allowedcustomprocessingsteptype ?? 0,
      isFunction: row.isfunction === true,
      parameters: parametersOf(store, row),
      properties,
    },
    record = c.target?.row ? structuredClone(c.target.row) : {},
    identity = c.identity ?? { id: c.user?.systemuserid ?? null, admin: true },
    messageParameters = {
      inputParameters: pluginMessageParameters(store, customApi.parameters, inputs),
      outputParameters: { $type: 'ParameterCollection', values: {} },
    };
  if (row.bindingtype === 1 && c.target)
    messageParameters.inputParameters.values.Target = {
      $type: 'EntityReference',
      logicalName: entity,
      id: c.target.id,
      name: null,
      // A row addressed by its alternate key keeps it (recorded native webApiNamed).
      ...(c.target.keyAttributes ? { keyAttributes: structuredClone(c.target.keyAttributes) } : {}),
    };
  if (c.sdkFromSandbox) messageParameters.inputParameters.values.FromSandbox = true;
  Object.assign(messageParameters.inputParameters.values, structuredClone(c.systemParameters ?? {}));
  const inherited = store.pluginInTransaction;
  const requestTag = store.pluginSdkTag;
  if (requestTag !== undefined) messageParameters.inputParameters.values.tag = requestTag;
  const acceptLanguage = c.headers?.get?.('accept-language') ?? c.headers?.['accept-language'] ?? '';
  let frame = {
      requestTag,
      operationDepth: mainPluginDepth(store),
      suppliedRequestId: store.pluginRequestId,
      sharedVariables: {
        $type: 'ParameterCollection',
        values: {
          AcceptLang: String(acceptLanguage),
          IsAutoTransact: true,
          ...(requestTag === undefined ? {} : { tag: requestTag }),
        },
      },
    },
    mainFrame = false;
  plugin.depth = frame.operationDepth;
  const parentContext = store.pluginParentContext ?? pluginInvocationSdkParent(store);
  const contextOf = (depth) => {
    frame ??= {};
    const executionUser = c.user?.systemuserid ?? identity.systemUserId ?? identity.id;
    const primary = entity === 'none' ? null : store.resolveMapping(entity).idColumn;
    frame.correlationId ??= parentContext?.values?.CorrelationId?.value ?? store.ids.uuid();
    initializePluginOperation(frame, store, parentContext, { requestId: c.requestId });
    return {
      $type: 'ExecutionContext',
      values: {
        MessageName: row.uniquename,
        PrimaryEntityName: entity,
        ...(entity === 'none' ? { SecondaryEntityName: 'none' } : {}),
        PrimaryEntityId: {
          $type: 'Guid',
          value: primary
            ? (record[primary] ?? '00000000-0000-0000-0000-000000000000')
            : '00000000-0000-0000-0000-000000000000',
        },
        Stage: 30,
        Mode: 0,
        Depth: depth,
        IsInTransaction: store.pluginInTransaction === true,
        IsolationMode: 2,
        UserId: { $type: 'Guid', value: executionUser },
        InitiatingUserId: parentContext?.values?.InitiatingUserId ?? { $type: 'Guid', value: executionUser },
        CorrelationId: { $type: 'Guid', value: frame.correlationId },
        OperationId: { $type: 'Guid', value: frame.operationId },
        RequestId: { $type: 'Guid', value: frame.requestId },
        OperationCreatedOn: structuredClone(frame.createdOnWire),
        InputParameters: messageParameters.inputParameters,
        OutputParameters: messageParameters.outputParameters,
        SharedVariables: frame.sharedVariables,
        ParentContext: parentContext,
        PreEntityImages: { $type: 'EntityImageCollection', values: {} },
        PostEntityImages: { $type: 'EntityImageCollection', values: {} },
        ...(store.state.dataverse?.organizationId
          ? { OrganizationId: { $type: 'Guid', value: store.state.dataverse.organizationId } }
          : {}),
      },
    };
  };
  const phase = function* (stage) {
    if (stage !== 10) store.pluginInTransaction = true;
    if (
      store.pluginPipeline &&
      store.pluginPipelineActive({
        entity,
        operation,
        bypassCustomPlugins: c.bypassCustomPlugins,
        bypassStepIds: c.bypassStepIds,
      })
    )
      frame = yield store.pluginPipeline({
        store,
        entity,
        operation,
        stage,
        record,
        identity,
        changedAttributes: [],
        bypassStepIds: c.bypassStepIds,
        bypassCustomPlugins: c.bypassCustomPlugins === true,
        customApi,
        messageParameters,
        ...((stage === 10 && frame) || (mainFrame && stage === 40) ? { initialFrame: frame } : {}),
        awaitIo: !synchronous,
      });
  };
  try {
    yield* phase(10);
    yield* phase(20);
    const current = pluginMessageValues(messageParameters.inputParameters, store);
    ctx.inputs = Object.fromEntries(customApi.parameters.map((spec) => [spec.uniquename, current[spec.uniquename]]));
    if (row.bindingtype === 1) {
      const reference = messageParameters.inputParameters.values.Target;
      if (
        reference?.$type !== 'EntityReference' ||
        reference.logicalName !== entity ||
        !GUID_RE.test(reference.id ?? '')
      )
        throw new DataError(
          'A bound custom API must retain a valid Target reference to its declared table.',
          400,
          'InvalidRequest',
          { innerCode: '0x80040203' },
        );
      if (!sameId(reference.id, c.target?.id)) {
        const mapping = store.resolveMapping(entity);
        const targetRow = store.get(entity, reference.id, identity, { skipPluginRead: true });
        if (!targetRow)
          throw new DataError(`${entity} With Id = ${reference.id} Does Not Exist`, 404, 'NotFound', {
            innerCode: '0x80040217',
          });
        if (c.backendPrincipal) authorizeGrant(store, c.backendPrincipal, entity, 'read', targetRow);
        else api.principals.authorize?.({ user: c.user, entity, operation: 'read', row: targetRow, mapping });
        c.target = { mapping, id: reference.id, row: targetRow };
        ctx.target = { logicalName: entity, id: reference.id, row: targetRow };
      }
    }
    const originalOutputs = function* () {
      let runtime = options.runtimes.get(original.id);
      if (original.uploaded)
        runtime = uploadedClrRuntime({
          store,
          item: original.uploaded,
          runtimes: options.runtimes,
          uploads: store.pluginPipeline?.clrUploads,
          diagnostic: api.diagnostic,
        });
      else if (runtime?.descriptor !== original.descriptor) {
        if (synchronous)
          throw new DataError(
            'The explicitly trusted custom API main-operation runtime must be prepared before a synchronous SDK call.',
            501,
            'LocalPluginClrUnavailable',
          );
        const previous = runtime;
        runtime = yield (options.prepareRuntime ?? prepareClrRuntime)(original.descriptor);
        if (previous) yield closeClrHostPool({ runtime: previous, diagnostic: api.diagnostic });
        options.runtimes.set(original.id, runtime);
        options.mainRuntimeIds.add(original.id);
      }
      frame ??= {};
      frame.customApi = customApi;
      // The main operation reports its request's caller facts, such as the user agent (native customApi stage 30).
      frame.callerIdentity ??= identity;
      frame.inputParameters = messageParameters.inputParameters;
      frame.outputParameters = messageParameters.outputParameters;
      const assemblyId = original.type.pluginassemblyid?.id ?? original.type.pluginassemblyid;
      const assembly = store
        .tableRows('pluginassembly')
        .find((entry) => key(entry.pluginassemblyid) === key(assemblyId));
      const step = {
        id: original.step.sdkmessageprocessingstepid,
        name: original.step.name ?? `CustomApi '${row.uniquename}' implementation`,
        typeName: original.type.typename,
        assemblyName: assembly?.name,
        contract: { mode: 0 },
        images: [],
      };
      const depth = mainPluginDepth(store),
        started = performance.now(),
        startedAt = new Date(store.clock.now()).toISOString();
      let answer, failure;
      try {
        answer = executeClrPlugin(
          runtime,
          clrContext({ runtime, store, step, entity, operation, stage: 30, target: {}, record, frame, depth }),
          {
            store,
            diagnostic: (entry) => {
              if (entry.code === 'PLUGIN_CLR_TRACE') plugin.traces.push(String(entry.message));
              api.diagnostic?.(entry);
            },
          },
        );
      } catch (error) {
        const source = error.details?.sourceException;
        failure =
          source?.type?.startsWith('System.ServiceModel.FaultException') && error.details?.innerCode
            ? error
            : pluginFailure(
                {
                  message: error.message,
                  ...(source?.type === 'Microsoft.Xrm.Sdk.InvalidPluginExecutionException'
                    ? { pluginFault: 'InvalidPluginExecutionException', errorCode: source.errorCode }
                    : {}),
                  ...(error.code === 'LocalPluginTimeout' ? { timedOut: true } : {}),
                },
                plugin,
                timeoutMs,
              );
        throw failure;
      } finally {
        // The main operation is constructed with null configuration (native), so the trace row carries none.
        recordPluginTrace(store, {
          typeName: qualifiedTypeName(store, { typeName: plugin.type, assemblyId: plugin.assemblyId }),
          stepId: step.id,
          messageName: plugin.name,
          entity,
          depth,
          traces: plugin.traces,
          started,
          startedAt,
          error: failure,
          ...plugin.traceIds(),
        });
      }
      frame.inputParameters = messageParameters.inputParameters = answer.inputParameters;
      frame.outputParameters = messageParameters.outputParameters = answer.outputParameters;
      frame.sharedVariables = canonicalTagVariables(answer.sharedVariables, frame.requestTag);
      mainFrame = true;
      return pluginMessageValues(answer.outputParameters, store);
    };
    const mainOutputs = registration
      ? ((synchronous
          ? runHandlerSync(api, registration.handler, ctx, plugin, contextOf)
          : yield runHandler(api, registration.handler, ctx, plugin, timeoutMs, contextOf)
        )?.outputs ?? {})
      : fxIdOf(row)
        ? synchronous
          ? fxOutputsSync(api, row, ctx.inputs, properties, c, contextOf)
          : yield fxOutputs(api, row, ctx.inputs, properties, c, contextOf, timeoutMs)
        : original?.descriptor || original?.uploaded
          ? yield* originalOutputs()
          : {};
    // Native MainOperation and synchronous PostOperation contain only authored
    // outputs. Missing declared properties are materialized by the response
    // boundary after all synchronous handlers, never inside the pipeline.
    if (!mainFrame)
      messageParameters.outputParameters = {
        $type: 'ParameterCollection',
        values: {
          ...messageParameters.outputParameters.values,
          ...pluginMessageParameters(store, properties, mainOutputs).values,
        },
      };
    yield* phase(40);
    const outputs = pluginMessageValues(messageParameters.outputParameters, store);
    const sdkOutputs = {
      $type: 'ParameterCollection',
      values: {
        ...Object.fromEntries(properties.map((spec) => [spec.uniquename, null])),
        ...messageParameters.outputParameters.values,
      },
    };
    if (frame) {
      store.pluginFrames ??= new WeakMap();
      store.pluginFrames.set(record, frame);
    }
    store.recordCommittedEvent(entity, operation, record, [], {
      customApi,
      target: {},
      identity,
      messageEvent: true,
      bypassCustomAsync: c.bypassCustomAsync === true,
      bypassStepIds: c.bypassStepIds,
    });
    // The flow trigger "When an action is performed" is a business event of
    // the committed action: a committed event (operation 'action') that the flow-trigger commit stager (flow-triggers.mjs) turns
    // into a durable job, so an action inside a changeset that rolls back never starts a flow. Outside a transaction the event
    // commits in its own one, which saves nothing unless a job was staged.
    if (!row.isfunction)
      store.recordCommittedEvent('', 'action', {}, [], {
        message: row.uniquename,
        table: row.bindingtype ? row.boundentitylogicalname : null,
        inputs: ctx.inputs,
        outputs,
      });
    span?.output(() => ({ inputs: ctx.inputs, outputs }));
    // Assumed: an action with no response properties returns 204.
    const response = properties.length
      ? { status: 200, body: responseBody(c, row, properties, outputs) }
      : { status: 204 };
    Object.defineProperty(response, 'sdkOutputs', { value: sdkOutputs });
    return response;
  } catch (error) {
    store.markPluginTransactionFailure?.(error);
    throw error;
  } finally {
    store.pluginInTransaction = inherited;
  }
}

// CSDL for one API; '' when it is left out (private, or a function with no response, which is invalid CSDL).
// Assumed: private APIs are left out of CSDL.
function csdlOf(store, name) {
  const row = apiNamed(store, name);
  if (!row || row.isprivate) return '';
  const properties = propertiesOf(store, row);
  if (row.isfunction && !properties.length) return '';
  const single = properties.length === 1 && SINGLE.has(typeOf(properties[0].type)) ? properties[0] : null;
  const complex = properties.length > 0 && !single;
  const returns = single ? edmOf(single) : complex ? `mscrm.${row.uniquename}Response` : null;
  const L = row.boundentitylogicalname;
  const bound =
    row.bindingtype === 1
      ? `<Parameter Name="entity" Type="mscrm.${L}" />`
      : row.bindingtype === 2
        ? `<Parameter Name="entityset" Type="Collection(mscrm.${L})" />`
        : '';
  const params = parametersOf(store, row)
    .map((p) => `<Parameter Name="${p.uniquename}" Type="${edmOf(p)}" />`)
    .join('');
  const complexType = complex
    ? `<ComplexType Name="${row.uniquename}Response">${properties.map((p) => `<Property Name="${p.uniquename}" Type="${edmOf(p)}" />`).join('')}</ComplexType>`
    : '';
  const element = row.isfunction ? 'Function' : 'Action';
  const attr = row.bindingtype ? ' IsBound="true"' : '';
  return `${complexType}<${element} Name="${row.uniquename}"${attr}>${bound}${params}${returns ? `<ReturnType Type="${returns}" />` : ''}</${element}>`;
}

// The fxexpression row a custom API names (customapi.fxexpressionid), or null.
const fxIdOf = (row) => row?.fxexpressionid?.id ?? row?.fxexpressionid ?? null;
const fxExpressionOf = (store, id) => store.tableRows('fxexpression').find((r) => sameId(r.fxexpressionid, id)) ?? null;
const evaluatorMissing = (what) =>
  new DataError(
    `${what} is a Power Fx expression and the Power Fx engine is disabled; enable it or register a pack powerFx adapter.`,
    501,
    'PowerFxEvaluatorMissing',
  );
// An evaluator answers: the core engine or a pack adapter (canvas-power-fx.mjs available); only the disabled engine does not.
const fxAvailable = (powerFx) => Boolean(powerFx && (powerFx.available ?? powerFx.registered));
const fxSynchronous = (powerFx) =>
  powerFx.describe?.().operations?.some((item) => item.name === 'evaluateSync' && item.level === 'behaviour') === true;
// A Power Fx error value (Error(), division by zero...) answers the plug-in fault envelope with its message. A refused
// data-source write (a privilege or validation refusal behind the error value) answers that refusal itself: power-fx.mjs
// runtimeError returns the data source's DataError, the same envelope the Web API gives.
// Assumed: native answers a Function's or plug-in's Power Fx error as an InvalidPluginExecutionException (0x80040265).
const fxFailure = (error, plugin) =>
  error?.code === 'PowerFxError'
    ? pluginFailure({ pluginFault: 'InvalidPluginExecutionException', message: error.message }, plugin, TIMEOUT_MS)
    : error;

// The public caller description is informational. Authorization keeps using
// dataverseHost's original caller closure, while its principal and bound-row
// views must not alias a committed graph captured before an isolated operation.
function exposeFxCaller(execution, host, { scopedPrincipal = false } = {}) {
  const caller = host.caller;
  if (!caller) return;
  const seen = new WeakMap();
  // The request context is data except for its organization API and callable
  // services (including nonenumerable hierarchy functions). Copy data with
  // descriptors so none of those services disappear or escape their lifetime.
  const information = (value) => {
    if (typeof value === 'function') return execution.exposed(value);
    if (!value || typeof value !== 'object') return value;
    if (value === caller.api) return execution.exposed(value);
    if (seen.has(value)) return seen.get(value);
    if (value instanceof URL) return new URL(value);
    const prototype = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return cloneStateData(value);
    const copy = Array.isArray(value) ? new Array(value.length) : Object.create(prototype);
    seen.set(value, copy);
    for (const key of Reflect.ownKeys(value)) {
      if (Array.isArray(value) && key === 'length') continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (Object.hasOwn(descriptor, 'value')) {
        descriptor.value =
          typeof descriptor.value === 'function'
            ? execution.exposed(descriptor.value.bind(value))
            : information(descriptor.value);
      } else {
        if (descriptor.get) descriptor.get = execution.exposed(descriptor.get.bind(value));
        if (descriptor.set) descriptor.set = execution.exposed(descriptor.set.bind(value));
      }
      Object.defineProperty(copy, key, descriptor);
    }
    return copy;
  };
  host.caller = information(caller);
  // Automated record-hook adapters already expose principal rows as scoped
  // handles, unlike a custom API's passive caller information.
  if (scopedPrincipal)
    for (const key of ['user', 'caller']) if (host.caller[key]) host.caller[key] = execution.exposed(host.caller[key]);
  // Bound Fx rows retain their existing scoped-handle contract, but the
  // guarded row itself must first be detached from the request's graph.
  if (host.caller.target?.row) host.caller.target.row = execution.exposed(host.caller.target.row);
}

// A Function's outputs: the expression evaluated with the typed inputs, its { value } record mapped onto the response
// properties. The function reads and writes tables (Collect,
// Patch, Filter, LookUp) as the caller, in the transaction context: a synchronous evaluation runs as one atomic unit
// (api.runAtomic), so an error value after a write leaves no row behind. An entity-bound function's target is ThisRecord.
function fxInvocation(api, row, inputs, c, contextOf, synchronous = false) {
  const powerFx = api.providers?.powerFx;
  if (!fxAvailable(powerFx)) throw evaluatorMissing(`Custom API '${row.uniquename}'`);
  if (synchronous && !fxSynchronous(powerFx))
    throw new DataError(
      'A synchronous SDK custom API requires a synchronous Power Fx evaluator.',
      501,
      'SdkAsyncPreOperationUnsupported',
    );
  const expression = fxExpressionOf(api.store, fxIdOf(row));
  if (!expression?.expression)
    throw new DataError(
      `The fxexpression of custom API '${row.uniquename}' does not exist or has no expression.`,
      404,
      'PowerFxExpressionMissing',
    );
  const plugin = { name: row.uniquename, id: row.customapiid, type: row.uniquename, traces: [] };
  const depth = mainPluginDepth(api.store),
    execution = pluginExecutionLifetime(api.store, depth, contextOf ? () => contextOf(depth) : undefined);
  const host = {
    ...dataverseHost(api, { c, assertActive: execution.assertActive }),
    trace: (text) => plugin.traces.push(String(text)),
  };
  exposeFxCaller(execution, host);
  if (c.target?.row && c.target.mapping) host.scope = host.record(c.target.mapping.logicalName, c.target.row);
  const options = { values: { ...inputs }, principal: c.user?.systemuserid ?? null, host };
  return { powerFx, expression, plugin, options, execution };
}
async function fxOutputs(api, row, inputs, properties, c, contextOf, timeoutMs) {
  const { powerFx, expression, plugin, options, execution } = fxInvocation(api, row, inputs, c, contextOf);
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('timeout'), { timedOut: true })), timeoutMs);
  });
  let value;
  try {
    ({ value } = await Promise.race([
      execution.run(() =>
        fxSynchronous(powerFx)
          ? (api.runAtomic ?? ((fn) => fn()))(() => powerFx.evaluateSync(expression.expression, options))
          : powerFx.evaluate(expression.expression, options),
      ),
      limit,
    ]));
  } catch (error) {
    throw error?.timedOut ? pluginFailure(error, plugin, timeoutMs) : fxFailure(error, plugin);
  } finally {
    clearTimeout(timer);
    execution.close();
  }
  if (isObject(value)) return value;
  // Assumed: a scalar result fills a lone response property.
  return properties.length === 1 ? { [properties[0].uniquename]: value } : {};
}

function fxOutputsSync(api, row, inputs, properties, c, contextOf) {
  const { powerFx, expression, plugin, options, execution } = fxInvocation(api, row, inputs, c, contextOf, true);
  try {
    const result = execution.run(() => powerFx.evaluateSync(expression.expression, options));
    if (result?.then) {
      Promise.resolve(result).catch(() => {});
      throw new DataError(
        'The synchronous Power Fx provider returned a promise.',
        501,
        'SdkAsyncPreOperationUnsupported',
      );
    }
    return isObject(result.value)
      ? result.value
      : properties.length === 1
        ? { [properties[0].uniquename]: result.value }
        : {};
  } catch (error) {
    throw fxFailure(error, plugin);
  } finally {
    execution.close();
  }
}

// The plug-in runs as the calling user, so its changes to the target pass the caller's column security; a secured column
// the caller may not write fails the write with the column-security refusal.
// Assumed: the expression runs through the caller's organization service, so column security applies to the target changes.
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
function fxLogic(store, row) {
  return {
    ...row,
    id: row.sdkmessageprocessingstepid,
    bypassOwnership: store.observed?.businessLogicOwnership?.[key(row.fxexpressionid)] ?? row.bypassOwnership,
  };
}
function automatedOf(store) {
  const functions = new Set(
    store
      .tableRows('customapi')
      .map((row) => key(fxIdOf(row)).replace(/[{}]/g, ''))
      .filter(Boolean),
  );
  return store
    .tableRows('fxexpression')
    .filter(
      (row) =>
        AUTOMATED.has(key(row.messagename)) &&
        row.entitylogicalname &&
        Number(row.statecode ?? 0) === 0 &&
        !functions.has(key(row.fxexpressionid).replace(/[{}]/g, '')),
    );
}

// beforeWrite: each automated plug-in of this table and message, in uniquename order. Synchronous (no promise) when the
// table has none, when no evaluator is registered (the write is refused) and when the adapter evaluates synchronously
// (evaluateSync at behaviour), so a synchronous SDK write runs the plug-ins inline; only an async-only adapter answers a
// promise, which a synchronous SDK write refuses (dataverse-records.mjs drive: SdkAsyncPreOperationUnsupported).
function runAutomated(api, reported, c, mapping, { operation, data, existing }) {
  const message = operation === 'upsert' ? (existing ? 'update' : 'create') : operation;
  if (!AUTOMATED.has(message) || !api.store.tableRows('fxexpression').length) return undefined;
  const steps = automatedOf(api.store)
    .filter((row) => key(row.messagename) === message && key(row.entitylogicalname) === key(mapping.logicalName))
    .filter((row) => !pluginStepBypassed(fxLogic(api.store, row), c, api.diagnostic))
    .sort((a, b) => String(a.uniquename ?? a.name).localeCompare(String(b.uniquename ?? b.name)));
  if (!steps.length) return undefined;
  const powerFx = api.providers?.powerFx;
  if (!fxAvailable(powerFx)) {
    // The write would store a row the plug-in changes natively: refused, never stored unchanged.
    const name = steps[0].uniquename ?? steps[0].name ?? steps[0].fxexpressionid;
    if (!reported.has(key(name))) {
      reported.add(key(name));
      api.diagnostic?.({
        code: 'POWERFX_AUTOMATED_NOT_EVALUATED',
        severity: 'warning',
        table: mapping.logicalName,
        operation: message,
        expression: name,
        message: `Automated low-code plug-in '${name}' (${message} of ${mapping.logicalName}) was not evaluated: the Power Fx engine is disabled; the write answers 501 PowerFxEvaluatorMissing.`,
      });
    }
    throw evaluatorMissing(`Automated low-code plug-in '${name}'`);
  }
  const principal = c.user?.systemuserid ?? null;
  // ThisRecord is the row as written; Set on its columns changes the target (columns act as global variables), an Error()
  // refuses the write with its message. A pack adapter's { value } record also changes
  // the target columns (the adapter contract).
  const run = (step, evaluated) => {
    const execution = pluginExecutionLifetime(api.store, pluginInvocationDepth(api.store), undefined, {
      recordHook: true,
    });
    const host = dataverseHost(api, { c, assertActive: execution.assertActive });
    exposeFxCaller(execution, host, { scopedPrincipal: true });
    const plugin = {
      name: step.uniquename ?? step.name,
      id: step.fxexpressionid,
      type: step.uniquename ?? step.name,
      traces: [],
    };
    // Every column of the target is in ThisRecord (blank when unset), so Set reaches a column the payload does not name.
    const blank = Object.fromEntries(host.columns(mapping.logicalName).map((column) => [column, null]));
    const before = cloneStateData({ ...blank, ...(existing ?? {}), ...(data ?? {}) });
    const scope = host.record(mapping.logicalName, before);
    const options = {
      values: { ThisRecord: before },
      principal,
      host: { ...host, scope, trace: (text) => plugin.traces.push(String(text)) },
    };
    const finish = (result) => {
      if (message === 'delete' || !data) return;
      const changes = changedColumns(host, mapping.logicalName, host.record(mapping.logicalName, before), scope);
      assertColumnWrites(api, c, mapping, message, existing, Object.keys(changes));
      Object.assign(data, changes);
      if (powerFx.registered && isObject(result.value)) Object.assign(data, execution.snapshot(result.value));
    };
    const complete = (answer) => {
      try {
        return execution.run(() => {
          execution.assertActive();
          return finish(answer);
        });
      } finally {
        execution.close();
      }
    };
    try {
      const result = execution.run(() => evaluated(step.expression, options));
      if (typeof result?.then !== 'function') return complete(result);
      return result.then(complete, (error) => {
        execution.close('refused');
        throw fxFailure(error, plugin);
      });
    } catch (error) {
      execution.close('refused');
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
  const functions = store
    ? store
        .tableRows('customapi')
        .filter((row) => fxIdOf(row))
        .map((row) => ({ name: `function:${row.uniquename}`, level }))
    : [];
  const automated = store
    ? automatedOf(store).map((row) => ({
        name: `automated:${row.uniquename ?? row.name}`,
        level,
        bypassOwnership: pluginBypassOwnership(fxLogic(store, row)),
      }))
    : [];
  const configured = store && executionConfigurations.get(store);
  const messages = store
    ? store
        .tableRows('customapi')
        .filter((row) => !fxIdOf(row))
        .map((row) => {
          const runtime = configured && clrRegistration(store, row, configured);
          const available =
            !row.plugintypeid ||
            Boolean(
              configured?.handlers.get(key(row.uniquename)) ??
              typeRegistration(store, row, configured?.pluginTypes ?? new Map()),
            ) ||
            Boolean(runtime?.uploaded) ||
            Boolean(
              runtime?.descriptor &&
              runtime.step &&
              configured.runtimes.get(runtime.id)?.descriptor === runtime.descriptor,
            );
          return {
            name: `customapi:${row.uniquename}`,
            level: available ? 'behaviour' : 'contract',
            ...(available
              ? {}
              : {
                  reason:
                    runtime?.reason ??
                    (runtime?.descriptor
                      ? 'The explicitly trusted original main-operation runtime awaits local verification.'
                      : 'The exported main-operation plug-in has no trusted local implementation.'),
                }),
            extensionSteps: Number(row.allowedcustomprocessingsteptype ?? 0),
          };
        })
    : [];
  return {
    name: 'dataverse-customapi',
    version: 1,
    kind: 'dataverse-extension',
    level:
      messages.some((entry) => entry.level !== 'behaviour') || (!registered && functions.length + automated.length)
        ? 'contract'
        : 'behaviour',
    operations: [{ name: 'customApi', level: 'behaviour' }, ...messages, ...functions, ...automated],
    requires: ['provider:powerFx'],
    principal: 'caller',
    stateOwner: 'store',
    lifecycle: 'per-request',
    seams: {
      bypassOwnership: automated.map(({ name, bypassOwnership: { kind, qualification, reason } }) => ({
        name,
        kind,
        qualification,
        ...(reason ? { reason } : {}),
      })),
    },
  };
}

/**
 * Preflight provider rows (capability-report.mjs buildPreflightReport providers): none while an evaluator answers (the core
 * engine or a pack adapter); with the engine disabled, power-fx:evaluator missing once per Power Fx-backed operation.
 */
export function powerFxRequirements(store, powerFx) {
  const configured = executionConfigurations.get(store);
  const missing = store.tableRows('customapi').flatMap((row) => {
    if (
      !row.plugintypeid ||
      fxIdOf(row) ||
      configured?.handlers.get(key(row.uniquename)) ||
      typeRegistration(store, row, configured?.pluginTypes ?? new Map())
    )
      return [];
    const runtime = clrRegistration(store, row, configured ?? {});
    if (runtime?.uploaded) return [];
    if (runtime?.step && runtime.descriptor && configured?.runtimes.get(runtime.id)?.descriptor === runtime.descriptor)
      return [];
    return [
      {
        id: `custom-api:main:${row.uniquename}`,
        reachable: false,
        message:
          runtime?.reason ??
          `Custom API '${row.uniquename}' requires a verified trusted local implementation of its exported main-operation plug-in.`,
      },
    ];
  });
  if (fxAvailable(powerFx)) return missing;
  const of = (what) => ({
    id: 'power-fx:evaluator',
    reachable: false,
    message: `Required by ${what}; the Power Fx engine is disabled.`,
  });
  return [
    ...missing,
    ...store
      .tableRows('customapi')
      .filter((row) => fxIdOf(row))
      .map((row) => of(`Function (custom API) ${row.uniquename}`)),
    ...automatedOf(store).map((row) => of(`automated low-code plug-in ${row.uniquename ?? row.name}`)),
  ];
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
    get csdl() {
      return csdlOf(api.store, name);
    },
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
function internalMessageContext(api, { principal, name, target = null, parameters = {} } = {}) {
  validateServiceProfile(principal);
  if (!principal.grants.some((grant) => grant.message === name && grant.operations.includes('execute')))
    throw new DataError(`Local backend profile denied execute on ${name}.`, 403, 'LocalBackendPermissionDenied');
  const { store, registry } = api;
  let binding = 'unbound',
    entity,
    row = null,
    mapping = null;
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
  const op =
    registry.find({ name, kind: 'action', binding, entity }) ??
    registry.find({ name, kind: 'function', binding, entity });
  if (!op) throw notFound(name);
  const user = api.principals?.byId?.(principal.userId) ?? null;
  if (!user)
    throw new DataError(
      'The flow profile names no systemuser; bound and unbound actions run as that user, never as SYSTEM.',
      403,
      'LocalBackendIdentityRequired',
    );
  const action = op.kind === 'action',
    origin = 'http://localhost';
  const url = new URL(`${origin}/api/data/v9.2/${name}`);
  const context = {
    method: action ? 'POST' : 'GET',
    url,
    origin,
    version: 'v9.2',
    prefer: {},
    headers: {},
    body: action ? { ...parameters } : undefined,
    params: action ? {} : { ...parameters },
    user,
    caller: null,
    identity: { id: principal.userId, admin: true },
    requestId: null,
    api,
    backendPrincipal: principal,
    target:
      binding === 'entity'
        ? { mapping, id: row[mapping.idColumn], row }
        : binding === 'collection'
          ? { mapping }
          : undefined,
  };
  // The message is one span named by it (D-R3-8, as a Web API message call): the bound record, the systemuser it runs as
  // (the actor stays the caller's, a flow for a flow action), the parameters and the answer at level full. A custom API's own
  // span and the writes it makes nest under it.
  const span = {
    kind: action ? 'action' : 'function',
    name: entity ? `${name} ${entity}` : name,
    module: 'dataverse',
    operation: name,
    entity: entity ?? null,
    recordId: row ? String(row[mapping.idColumn]) : null,
    attributes: { message: name, binding, caller: 'internal', systemUserId: user.systemuserid ?? null },
    input: () => ({ parameters }),
  };
  return { op, context, span };
}

function tracedMessage(api, spec, run) {
  const traces = api.store.traces;
  if (!traces?.enabled) return run();
  return traces.wrap(spec, (span) => {
    const done = (answer) => {
      span.set({ statusCode: answer?.status ?? 204 });
      span.output(() => answer?.body ?? null);
      return answer;
    };
    const answer = run();
    return typeof answer?.then === 'function' ? answer.then(done) : done(answer);
  });
}

async function executeMessageInternal(api, request) {
  const { op, context, span } = internalMessageContext(api, request);
  context.bypassStepIds = request.bypassStepIds;
  context.bypassCustomPlugins = request.bypassCustomPlugins === true;
  context.bypassCustomAsync = request.bypassCustomAsync === true;
  context.systemParameters = request.systemParameters;
  const result = await tracedMessage(api, span, () => op.handle(context));
  if (!result) return { statusCode: 204, body: {} };
  const body =
    result.body !== null && typeof result.body === 'object' && !Buffer.isBuffer(result.body)
      ? Object.fromEntries(Object.entries(result.body).filter(([key]) => key !== '@odata.context'))
      : (result.body ?? {});
  return { statusCode: result.status ?? 200, body };
}

function executeMessageSyncInternal(api, request, options) {
  const parameters =
    request.parameters?.$type === 'ParameterCollection'
      ? pluginMessageValues(request.parameters, api.store)
      : request.parameters;
  const { op, context, span } = internalMessageContext(api, { ...request, parameters });
  context.bypassCustomPlugins = request.bypassCustomPlugins === true;
  context.bypassCustomAsync = request.bypassCustomAsync === true;
  context.bypassStepIds = request.bypassStepIds;
  context.systemParameters = request.systemParameters;
  context.sdkFromSandbox = request.sdkFromSandbox === true;
  if (!apiNamed(api.store, op.name))
    throw new DataError('This message has no synchronous SDK execution adapter.', 501, 'LocalPluginSdkUnsupported');
  const result = tracedMessage(api, span, () =>
    tracedInvocation(api, op.name, context, (invocation) =>
      driveMessageSync(invokeSteps(api, op.name, context, options, true, invocation)),
    ),
  );
  return { statusCode: result.status, body: result.body ?? {}, outputs: result.sdkOutputs };
}

export async function prepareCustomApiRuntimes(api, { refresh = false } = {}) {
  const options = executionConfigurations.get(api.store);
  if (!options) return;
  const active = new Map();
  for (const row of api.store.tableRows('customapi')) {
    if (
      options.handlers.has(key(row.uniquename)) ||
      typeRegistration(api.store, row, options.pluginTypes) ||
      fxIdOf(row)
    )
      continue;
    const original = clrRegistration(api.store, row, options);
    if (original?.descriptor && original.step) active.set(original.id, { ...original, name: row.uniquename });
  }
  for (const id of options.mainRuntimeIds) {
    if (active.has(id)) continue;
    const runtime = options.runtimes.get(id);
    if (runtime) await closeClrHostPool({ runtime, diagnostic: api.diagnostic });
    options.runtimes.delete(id);
    options.mainRuntimeIds.delete(id);
  }
  for (const original of active.values()) {
    options.mainRuntimeIds.add(original.id);
    if (!refresh && options.runtimes.get(original.id)?.descriptor === original.descriptor) continue;
    try {
      const previous = options.runtimes.get(original.id);
      if (previous) await closeClrHostPool({ runtime: previous, diagnostic: api.diagnostic });
      options.runtimes.delete(original.id);
      options.runtimes.set(original.id, await (options.prepareRuntime ?? prepareClrRuntime)(original.descriptor));
    } catch (error) {
      api.diagnostic?.({ code: 'PLUGIN_CLR_PREPARATION_FAILED', customApi: original.name, message: error.message });
    }
  }
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
  return new Map(
    [...collectPackExport(packs, 'customApis')].map(([name, { value }]) => [
      name,
      typeof value === 'function'
        ? { handler: value, pluginType: null }
        : { handler: value.handler, pluginType: value.pluginType ?? null },
    ]),
  );
}

const automatedHooks = new WeakSet();
/**
 * Seeds the customapi tables and supplies their current operation definitions to
 * the canonical registry. Row edits, signatures and deletions are visible on its
 * next read. A registry without setProvider is instead synced on each data revision.
 * Returns { sync, ready }; await ready to persist the seed.
 * options: handlers (from customApiHandlers), pluginTypes (the pack pluginTypes handlers keyed by typename) and timeoutMs (the plug-in limit, default 2 minutes).
 */
// seed runs now, so the mappings are in memory for the caller; ready persists them in a store transaction.
export function install(api, options = {}) {
  const { store, registry } = api;
  const previous = executionConfigurations.get(store);
  const resolved = {
    handlers: options.handlers ?? new Map(),
    pluginTypes: options.pluginTypes ?? new Map(),
    timeoutMs: options.timeoutMs ?? TIMEOUT_MS,
    pluginRuntimes: options.pluginRuntimes ?? new Map(),
    runtimes: options.runtimes ?? previous?.runtimes ?? new Map(),
    mainRuntimeIds: previous?.mainRuntimeIds ?? new Set(),
    prepareRuntime: options.prepareRuntime,
  };
  executionConfigurations.set(store, resolved);
  seed(store);
  const ready = api
    .change(() => store.transact(() => seed(store)))
    .then(async () => {
      if (previous && previous.runtimes !== resolved.runtimes) {
        for (const id of [...previous.mainRuntimeIds]) {
          const runtime = previous.runtimes.get(id);
          if (runtime) await closeClrHostPool({ runtime, diagnostic: api.diagnostic });
          previous.runtimes.delete(id);
        }
        resolved.mainRuntimeIds.clear();
      }
      await prepareCustomApiRuntimes(api);
    });
  if (api.records) {
    api.records.executeMessageInternal = (request) => executeMessageInternal(api, request);
    api.records.executeMessageSyncInternal = (request) => executeMessageSyncInternal(api, request, resolved);
  }
  // Automated low-code plug-ins: one beforeWrite hook per hook list (install runs again on reset).
  if (api.recordHooks && !automatedHooks.has(api.recordHooks)) {
    automatedHooks.add(api.recordHooks);
    const reported = new Set();
    api.recordHooks.add(
      'beforeWrite',
      (_context, mapping, info) => {
        const creating = info.operation === 'create' || (info.operation === 'upsert' && !info.existing);
        const candidate = { ...info.existing, ...info.data };
        if (mapping.logicalName === 'customapirequestparameter') {
          if (
            (creating ||
              Object.hasOwn(info.data ?? {}, 'logicalentityname') ||
              Object.hasOwn(info.data ?? {}, 'type')) &&
            candidate.logicalentityname &&
            ![3, 5].includes(Number(candidate.type))
          )
            throw new DataError(
              'EntityLogicalName is valid only for Entity or EntityReference types',
              400,
              'InvalidRequest',
              {
                innerCode: '0x80040265',
              },
            );
          return;
        }
        if (mapping.logicalName !== 'customapi') return;
        if (
          (creating || Object.hasOwn(info.data ?? {}, 'uniquename')) &&
          !/^[a-z][a-z0-9_.{}!]*$/i.test(candidate.uniquename ?? '')
        )
          throw new DataError(
            'Export key attribute {0} for component {1} must begin with a letter and only consist of alpha-numeric and _.{}! characters.\r\nData[0] = "uniquename"\r\nData[1] = "CustomAPI"',
            400,
            'InvalidRequest',
            { innerCode: '0x800608ab' },
          );
        if (
          (creating ||
            Object.hasOwn(info.data ?? {}, 'bindingtype') ||
            Object.hasOwn(info.data ?? {}, 'boundentitylogicalname')) &&
          Number(candidate.bindingtype ?? 0) !== 0 &&
          !candidate.boundentitylogicalname
        )
          throw new DataError('BoundEntityLogicalName is required.', 400, 'InvalidRequest', {
            innerCode: '0x80040265',
          });
        if (creating && info.data?.description == null)
          throw new DataError(
            "Attribute 'description' cannot be NULL. Source: RequiredFieldValidator.ValidateForCreate, Context: Field is null during Create operation",
            400,
            'InvalidRequest',
            {
              innerCode: '0x80040200',
              cdsAnnotations: {
                'Microsoft.PowerApps.CDS.ErrorDetails.ApiExceptionMessageName': 'RequiredFieldMissing',
                'Microsoft.PowerApps.CDS.ErrorDetails.ApiExceptionCategory': 'ClientError',
              },
            },
          );
      },
      'dataverse-customapi (required metadata)',
    );
    api.recordHooks.add(
      'beforeWrite',
      (c, mapping, info) => runAutomated(api, reported, c, mapping, info),
      'dataverse-customapi (automated low-code plug-ins)',
    );
  }
  if (registry.setProvider) {
    registry.setProvider('dataverse-customapi', () =>
      store.tableRows('customapi').map((row) => operationOf(api, row, resolved)),
    );
    return { sync: () => {}, ready };
  }
  let seen = null;
  const sync = () => {
    const revision = store.dataRevision();
    if (revision === seen) return;
    seen = revision;
    for (const row of store.tableRows('customapi'))
      if (!registry.has(row.uniquename)) registry.register(operationOf(api, row, resolved));
  };
  sync();
  return { sync, ready };
}
