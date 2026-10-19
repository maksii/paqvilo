// Simulated Dataverse custom APIs: the customapi tables, unpacked solution parsing, and registry
// operations for unbound, entity-bound and collection-bound functions and actions. No plug-in runs locally,
// so responses carry each response property at its type default.
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { DataError } from './data-error.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { privilegeDeniedError, uuidV5 } from './dataverse-security.mjs';
import { child, childText, parseSolutionXml } from './solution-xml.mjs';

// Dataverse type codes 0-12 (customapirequestparameter.type and customapiresponseproperty.type).
const TYPES = ['Boolean', 'DateTime', 'Decimal', 'Entity', 'EntityCollection', 'EntityReference', 'Float', 'Integer', 'Money', 'Picklist', 'String', 'StringArray', 'Guid'];
const BINDINGS = ['unbound', 'entity', 'collection'];
const EDM = { Boolean: 'Edm.Boolean', DateTime: 'Edm.DateTimeOffset', Decimal: 'Edm.Decimal', Float: 'Edm.Double', Integer: 'Edm.Int32', Money: 'Edm.Decimal', Picklist: 'Edm.Int32', String: 'Edm.String', StringArray: 'Collection(Edm.String)', Guid: 'Edm.Guid' };
const DEFAULTS = { Boolean: false, Decimal: 0, Float: 0, Integer: 0, Money: 0, Picklist: 0, String: '' };
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
// unverified: the value check for each type is this simulator's reading of the type name.
const CHECKS = {
  Boolean: (v) => typeof v === 'boolean',
  DateTime: (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)),
  Decimal: num, Float: num, Money: num,
  Integer: Number.isInteger, Picklist: Number.isInteger,
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

const notFound = (name) => new DataError(`Resource not found for the segment '${name}'.`, 404, 'UnknownEntity', { innerCode: '0x8006088a' });
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
// Seeded tables for the Dataverse API only (dataverseOnly), as in dataverse-security.mjs.
const SEEDED = {
  customapi: {
    set: 'customapis', id: 'customapiid',
    fields: { customapiid: GUID, uniquename: TEXT, name: TEXT, displayname: TEXT, description: TEXT, bindingtype: INT, boundentitylogicalname: TEXT, isfunction: BOOL, isprivate: BOOL, allowedcustomprocessingsteptype: INT, executeprivilegename: TEXT, workflowsdkstepenabled: BOOL },
    // unverified: navigation property names used for deep insert.
    relationships: {
      customapi_customapirequestparameter: { entity: 'customapirequestparameter', from: 'customapiid', to: 'customapiid', many: true },
      customapi_customapiresponseproperty: { entity: 'customapiresponseproperty', from: 'customapiid', to: 'customapiid', many: true },
    },
  },
  // unverified: entity set names of the two child tables.
  customapirequestparameter: {
    set: 'customapirequestparameters', id: 'customapirequestparameterid',
    fields: { customapirequestparameterid: GUID, uniquename: TEXT, name: TEXT, displayname: TEXT, description: TEXT, type: INT, logicalentityname: TEXT, isoptional: BOOL, customapiid: LOOKUP },
    relationships: { customapiid: { entity: 'customapi', from: 'customapiid', to: 'customapiid', many: false } },
  },
  customapiresponseproperty: {
    set: 'customapiresponseproperties', id: 'customapiresponsepropertyid',
    fields: { customapiresponsepropertyid: GUID, uniquename: TEXT, name: TEXT, displayname: TEXT, description: TEXT, type: INT, logicalentityname: TEXT, customapiid: LOOKUP },
    relationships: { customapiid: { entity: 'customapi', from: 'customapiid', to: 'customapiid', many: false } },
  },
};

function seed(store) {
  for (const [logical, def] of Object.entries(SEEDED)) {
    // An existing mapping is kept as it is, so a mapping without dataverseOnly is never flipped or overwritten.
    store.state.mappings[logical] ??= { logicalName: logical, entitySet: def.set, idColumn: def.id, nameColumn: 'name', userConfigured: true, dataverseOnly: true, fields: field(def.fields), relationships: def.relationships ?? {} };
    store.state.tables[logical] ??= [];
  }
}

// Parameter values come from the URL for functions and the JSON body for actions.
function checkParameters(store, row, c) {
  const input = c.method === 'POST' ? (c.body ?? {}) : (c.params ?? {});
  for (const p of parametersOf(store, row)) {
    const type = typeOf(p.type), value = input[p.uniquename];
    if (value === undefined || value === null) {
      // unverified: message text of the missing-parameter error.
      if (!p.isoptional) throw new DataError(`Required parameter '${p.uniquename}' is missing.`, 400, 'InvalidRequest', { innerCode: '0x80040203' });
      continue;
    }
    if (!CHECKS[type]?.(value)) throw new DataError(`The value of parameter '${p.uniquename}' is not a valid ${type}.`, 400, 'InvalidRequest', { innerCode: '0x80040203' }); // unverified: message text
  }
}

function responseBody(c, row, properties) {
  const single = properties.length === 1 && SINGLE.has(typeOf(properties[0].type)) ? properties[0] : null;
  if (single) {
    // unverified: @odata.context and body of a lone Entity or EntityCollection response.
    const body = { '@odata.context': contextUrl(c.origin, c.version, edmOf(single)) };
    return typeOf(single.type) === 'EntityCollection' ? { ...body, value: [] } : body;
  }
  return {
    '@odata.context': contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${row.uniquename}Response`),
    ...Object.fromEntries(properties.map((p) => [p.uniquename, defaultOf(typeOf(p.type))])),
  };
}

async function invoke(api, name, c) {
  const { store } = api;
  const row = apiNamed(store, name);
  if (!row) throw notFound(name);
  // Functions are GET and actions are POST; another verb gets the generic 404 envelope.
  if (c.method !== (row.isfunction ? 'GET' : 'POST')) throw new DataError(`No HTTP resource was found that matches the request URI '${c.url}'.`, 404, 'NotFound');
  if (row.executeprivilegename && !api.principals.privileges(c.user).has(row.executeprivilegename))
    throw privilegeDeniedError(c.user, row.executeprivilegename, row.boundentitylogicalname ?? row.uniquename);
  checkParameters(store, row, c);
  const properties = propertiesOf(store, row);
  if (!properties.length) {
    // unverified: an action with no response properties returns 204. A function must have one, so it is absent.
    if (row.isfunction) throw notFound(name);
    return { status: 204 };
  }
  return { status: 200, body: responseBody(c, row, properties) };
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

function operationOf(api, row) {
  const name = row.uniquename;
  return {
    name,
    kind: row.isfunction ? 'function' : 'action',
    binding: BINDINGS[row.bindingtype],
    entity: row.bindingtype ? row.boundentitylogicalname : undefined,
    handle: (c) => invoke(api, name, c),
    // A getter, so the CSDL follows response properties and parameters added after registration.
    get csdl() { return csdlOf(api.store, name); },
  };
}

/**
 * Seeds the customapi tables and registers every custom API row. Binding and kind are fixed after a row is
 * saved, so a registered name is never re-registered; deleted rows fail at call time with 0x8006088a.
 * Returns { sync }: call it when store.dataRevision() may have changed to register rows added since.
 */
export function install(api) {
  const { store, registry } = api;
  api.change(() => seed(store));
  let seen = null;
  const sync = () => {
    const revision = store.dataRevision();
    if (revision === seen) return;
    seen = revision;
    for (const row of store.tableRows('customapi')) if (!registry.has(row.uniquename)) registry.register(operationOf(api, row));
  };
  sync();
  return { sync };
}
