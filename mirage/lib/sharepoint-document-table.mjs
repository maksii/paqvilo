// The `sharepointdocument` table: the documents of a record's SharePoint location as Dataverse rows.
//
// Hosted session F7 (2026-11-27, runs a and b, SharePoint integration off; dv-reads-s0/-s1/-s1-loc, api-s0, api-s1-loc,
// api-s1-loc-fields, liquid-s0, liquid-s1-loc): the table is a Standard table without a data provider (primary id
// sharepointdocumentid, primary name fullname); a read without a regardingobjectid condition answers no rows and /$count
// -1; a $filter or FetchXML condition on regardingobjectid fails in the platform's RetrieveMultiple plug-in
// (Microsoft.Crm.ObjectModel.SharePointDocumentService) with 400 0x80071017 SharePointS2SIsDisabled "SharePoint S2S and
// MSTeams integration is not enabled for this org"; a keyed read answers 404 0x80040217. Through the portal the same
// failure is 400 9004010D with cdscode 0x80071017, and in Liquid {% fetchxml %} the target-invocation error.
// The columns and their types are the captured EntityDefinitions answer (the Learn table reference has no page for it).
//
// In Mirage the integration is on when the SharePoint storage route is configured (sharepoint-documents.mjs). Then a read
// with a regarding condition lists the folder of each named record's location from that storage, top level only (its
// subfolders and files), as rows; a read without one stays empty. The listed row columns (fullname, isfolder, filesize,
// filetype, modified, relativelocation, locationid, locationname, regardingobjectid and an id derived from the location
// and name) are local: the hosted rows with SharePoint on were not capturable (F7 summary section 8).
import { uuidV5 } from './uuid-v5.mjs';
import { DataError } from './data-error.mjs';
import { expressionPaths, parseODataExpression } from './odata-query.mjs';
import { parseFetchXml } from './data.mjs';
import { portalDocumentAccess } from './permissions.mjs';

const SHAREPOINT_DOCUMENT = 'sharepointdocument';
const LOCATION = 'sharepointdocumentlocation';
const NAMESPACE = '0d8a6b52-7c4e-5f3e-9a61-5f7a3c2b1e90';
const REGARDING = 'regardingobjectid';
const MENTIONS_TABLE = /["']sharepointdocument["']/i;

// The captured EntityDefinitions Attributes (both runs identical, dv-reads-s0 documents-metadata), as column types.
const COLUMNS = {
  absoluteurl: 'nvarchar',
  appcreatedby: 'nvarchar',
  appmodifiedby: 'nvarchar',
  author: 'nvarchar',
  businessunitid: 'lookup',
  businessunitidname: 'nvarchar',
  checkedoutto: 'nvarchar',
  checkincomment: 'nvarchar',
  childfoldercount: 'int',
  childitemcount: 'int',
  contenttype: 'nvarchar',
  contenttypeid: 'int',
  copysource: 'nvarchar',
  createdby: 'lookup',
  createdbyname: 'nvarchar',
  createdbyyominame: 'nvarchar',
  createdon: 'datetime',
  createdonbehalfby: 'lookup',
  createdonbehalfbyname: 'nvarchar',
  createdonbehalfbyyominame: 'nvarchar',
  documentid: 'int',
  documentlocationtype: 'picklist',
  documentlocationtypename: 'virtual',
  edit: 'nvarchar',
  editurl: 'nvarchar',
  exchangerate: 'decimal',
  filesize: 'int',
  filetype: 'nvarchar',
  fullname: 'nvarchar',
  iconclassname: 'nvarchar',
  ischeckedout: 'bit',
  isfolder: 'bit',
  isrecursivefetch: 'bit',
  locationid: 'nvarchar',
  locationname: 'nvarchar',
  modified: 'datetime',
  modifiedby: 'lookup',
  modifiedbyname: 'nvarchar',
  modifiedbyyominame: 'nvarchar',
  modifiedon: 'datetime',
  modifiedonbehalfby: 'lookup',
  modifiedonbehalfbyname: 'nvarchar',
  modifiedonbehalfbyyominame: 'nvarchar',
  organizationid: 'lookup',
  organizationidname: 'nvarchar',
  ownerid: 'owner',
  owneridname: 'nvarchar',
  owneridtype: 'entityname',
  owneridyominame: 'nvarchar',
  owningbusinessunit: 'lookup',
  owningbusinessunitname: 'nvarchar',
  owningteam: 'lookup',
  owninguser: 'lookup',
  readurl: 'nvarchar',
  regardingobjectid: 'lookup',
  regardingobjectidname: 'nvarchar',
  regardingobjectidyominame: 'nvarchar',
  regardingobjecttypecode: 'entityname',
  relativelocation: 'nvarchar',
  servicetype: 'picklist',
  servicetypename: 'virtual',
  sharepointcreatedon: 'datetime',
  sharepointdocumentid: 'primarykey',
  sharepointmodifiedby: 'nvarchar',
  title: 'nvarchar',
  transactioncurrencyid: 'lookup',
  transactioncurrencyidname: 'nvarchar',
  version: 'nvarchar',
};

// The table's mapping. A Solution that enables document management already names the table through its
// <table>_SharePointDocuments relationship (solution-schema.mjs); that mapping keeps its own facts and gains the
// captured primary name and columns it lacks.
function seed(store) {
  store.state.mappings ??= {};
  store.state.tables ??= {};
  const mapping = (store.state.mappings[SHAREPOINT_DOCUMENT] ??= {
    logicalName: SHAREPOINT_DOCUMENT,
    entitySet: 'sharepointdocuments',
    idColumn: 'sharepointdocumentid',
    userConfigured: true,
    dataverseOnly: true,
    relationships: {},
  });
  mapping.logicalName ??= SHAREPOINT_DOCUMENT;
  mapping.nameColumn ??= 'fullname';
  mapping.tableType ??= 'Standard';
  // Its RetrieveMultiple and Retrieve are the platform's SharePointDocumentService (dataverse-records.mjs, dataverse-odata.mjs).
  mapping.serviceCollectionAnswer = true;
  // Its columns are exactly the captured ones: no system or generated companion columns (dataverse-metadata.mjs).
  mapping.metadataAttributes = 'declared';
  mapping.fields ??= {};
  for (const [column, type] of Object.entries(COLUMNS)) mapping.fields[column] ??= { dataverseType: type };
  // The rows are a per-read answer (request-local, data.mjs requestRowTables and portalReadRowSources): none is stored, and
  // a listing an earlier version stored is dropped.
  store.state.tables[SHAREPOINT_DOCUMENT] = [];
}

const lower = (value) => String(value ?? '').toLowerCase();
const bare = (value) => lower(value).replace(/^\{|\}$/g, '');

// The record ids a FetchXML root names in regardingobjectid conditions (eq and in), and whether it names the column at
// all. Conditions under link-entity elements belong to the linked table.
function fetchRegarding(root) {
  const ids = [];
  let named = false;
  const visit = (node) => {
    for (const child of node.children ?? []) {
      if (child.name === 'filter') visit(child);
      else if (child.name === 'condition' && lower(child.attrs.attribute) === REGARDING) {
        named = true;
        if (child.attrs.value != null) ids.push(bare(child.attrs.value));
        for (const value of child.children ?? []) if (value.name === 'value') ids.push(bare(value.text));
      }
    }
  };
  visit(root);
  return { named, ids };
}

// The same for an OData $filter: any path through _regardingobjectid_value or regardingobjectid names the regarding
// record; the ids are the GUID literals compared with it.
function odataRegarding(filter) {
  if (filter == null || String(filter).trim() === '') return { named: false, ids: [] };
  let paths;
  try {
    paths = expressionPaths(parseODataExpression(String(filter), { dialect: 'dataverse' }));
  } catch {
    return { named: false, ids: [] };
  }
  const named = paths.some(([head]) => [`_${REGARDING}_value`, REGARDING].includes(lower(head)));
  const ids = named
    ? [...String(filter).matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map((m) =>
        bare(m[0]),
      )
    : [];
  return { named, ids };
}

const disabled = () =>
  new DataError('SharePoint S2S and MSTeams integration is not enabled for this org', 400, 'SharePointS2SIsDisabled', {
    innerCode: '0x80071017',
  });

// The integration is on with the storage route, unless the site is observed with it off (observed.sharePointIntegration
// "off": the environment's SharePoint integration setting, which no export carries).
const integrationOn = (api) =>
  api.store.observed?.sharePointIntegration !== 'off' && api.sharepoint?.describe?.().level === 'behaviour';

// The regarding record of a location: { logical, mapping, row } or null.
function regardingRecord(store, location) {
  const logical = lower(location.regardingobjectid?.logical_name);
  if (!logical || !store.state.mappings?.[logical]) return null;
  const mapping = store.resolveMapping(logical);
  const id = bare(location.regardingobjectid?.id);
  const row = store.tableRows(mapping.logicalName).find((item) => bare(item[mapping.idColumn]) === id);
  return row ? { logical: mapping.logicalName, mapping, row } : null;
}

// Who may see a location's documents. The portal: the document control's list rule (parent Read and Append To, Document
// Location Read; permissions.mjs portalDocumentAccess). The organization: Read on the regarding record and on the location.
// Anything else sees none (fail closed).
const portalAccess = (store, identity) => (location, target) =>
  portalDocumentAccess(store, { entity: target.logical, row: target.row, location }, identity ?? {}).list;
const organizationAccess = (api, user) => (location, target) => {
  if (!user) return false;
  try {
    for (const [entity, row, mapping] of [
      [target.logical, target.row, target.mapping],
      [LOCATION, location, api.store.resolveMapping(LOCATION)],
    ])
      api.principals.authorize({ user, entity, operation: 'read', row, mapping });
    return true;
  } catch (error) {
    if (error instanceof DataError && error.status === 403) return false;
    throw error;
  }
};

// A listed entry of a location's folder as a sharepointdocument row.
function documentRow(location, entry) {
  const regarding = location.regardingobjectid;
  const extension = !entry.folder && entry.name.includes('.') ? entry.name.split('.').pop().toLowerCase() : null;
  return {
    sharepointdocumentid: uuidV5(NAMESPACE, `${lower(location.sharepointdocumentlocationid)}/${entry.name}`),
    fullname: entry.name,
    title: entry.name,
    isfolder: entry.folder === true,
    filesize: entry.folder ? null : (entry.size ?? null),
    filetype: extension,
    modified: entry.lastModified ?? null,
    relativelocation: entry.name,
    locationid: lower(location.sharepointdocumentlocationid),
    locationname: location.name ?? null,
    regardingobjectid: {
      id: regarding.id,
      logical_name: regarding.logical_name,
      ...(regarding.name != null ? { name: regarding.name } : {}),
    },
    regardingobjecttypecode: regarding.logical_name,
  };
}

// The top level of a location's folder; a location whose folder was never created holds no documents.
async function locationEntries(api, location) {
  try {
    return await api.sharepoint.listDocuments(location.sharepointdocumentlocationid, { admin: true });
  } catch (error) {
    if (error?.code === 'NotFound') return [];
    throw error;
  }
}

// The documents of the records `ids` names that `allowed(location, target)` admits, as rows: the top level of each active
// record location's folder.
async function listedRows(api, ids, allowed) {
  const rows = [];
  const store = api.store;
  const wanted = new Set(ids);
  const locations = store
    .tableRows(LOCATION)
    .filter((row) => row.statecode !== 1 && wanted.has(bare(row.regardingobjectid?.id)));
  for (const location of locations) {
    const target = regardingRecord(store, location);
    if (!target || !allowed(location, target)) continue;
    for (const entry of await locationEntries(api, location)) rows.push(documentRow(location, entry));
  }
  return rows;
}

// The rows a read of the table sees: the listing of the records its regarding condition names, else none.
async function readRows(api, regarding, allowed) {
  if (!integrationOn(api) || !regarding.named) return [];
  return listedRows(api, regarding.ids, allowed);
}

function regardingOf({ fetchXml = null, params = null, filter = null } = {}) {
  if (fetchXml != null) {
    const root = parseFetchXml(fetchXml).children.find((node) => node.name === 'entity');
    return lower(root?.attrs.name) === SHAREPOINT_DOCUMENT ? fetchRegarding(root) : null;
  }
  const value = filter ?? (params instanceof URLSearchParams ? params.get('$filter') : params?.$filter);
  return odataRegarding(value);
}

function install(api) {
  const { store } = api;
  // The RetrieveMultiple check every query engine makes for this table (data.mjs queryCore and fetchXmlCore): a regarding
  // condition without the integration fails as the platform's plug-in does.
  store.tableReadGuards ??= new Map();
  store.tableReadGuards.set(SHAREPOINT_DOCUMENT, ({ fetchRoot = null, filter = null } = {}) => {
    const regarding = fetchRoot ? fetchRegarding(fetchRoot) : odataRegarding(filter);
    if (regarding.named && !integrationOn(api)) throw disabled();
  });
  // Portal reads (Web API and Liquid) see the listed rows in their request-local read scope (data.mjs).
  store.portalReadRowSources ??= new Map();
  store.portalReadRowSources.set(SHAREPOINT_DOCUMENT, async ({ table, fetchXml, params }, identity) => {
    if (!integrationOn(api)) return null;
    let regarding;
    // Every portal FetchXML read asks; only one naming this table is parsed again.
    if (fetchXml != null) regarding = MENTIONS_TABLE.test(fetchXml) ? regardingOf({ fetchXml }) : null;
    else if (lower(table) === SHAREPOINT_DOCUMENT || lower(table) === 'sharepointdocuments')
      regarding = regardingOf({ params });
    else return null;
    if (!regarding) return null;
    return readRows(api, regarding, portalAccess(store, identity));
  });
  // An organization Web API read of the table lists its rows into the request's own row scope (data.mjs setRequestRows):
  // never stored, so another record's read, a saved state or a concurrent request never sees them.
  store.requestRowTables ??= new Set();
  store.requestRowTables.add(SHAREPOINT_DOCUMENT);
  api.recordHooks.add(
    'source',
    async (c, mapping) => {
      if (mapping.logicalName !== SHAREPOINT_DOCUMENT || !integrationOn(api)) return;
      const search = c?.url?.searchParams;
      const xml = search?.get('fetchXml') ?? search?.get('fetchxml');
      const regarding = xml != null ? regardingOf({ fetchXml: xml }) : regardingOf({ filter: search?.get('$filter') });
      const rows = await readRows(api, regarding ?? { named: false, ids: [] }, organizationAccess(api, c?.user));
      store.setRequestRows(SHAREPOINT_DOCUMENT, rows);
    },
    'sharepoint-document-table',
  );
  // /$count without a filter answers -1 (hosted F7, dv-reads documents-count, every phase).
  api.recordHooks.add(
    'count',
    (c, mapping) =>
      mapping.logicalName === SHAREPOINT_DOCUMENT && !c.url.searchParams.has('$filter')
        ? { status: 200, body: '-1' }
        : undefined,
    'sharepoint-document-table',
  );
  return store.transact(() => seed(store));
}

function reset(api) {
  return api.store.transact(() => seed(api.store));
}

function describe(api) {
  return {
    name: 'sharepoint-document-table',
    version: 1,
    kind: 'dataverse-extension',
    level: api && integrationOn(api) ? 'behaviour' : 'contract',
    operations: [
      { name: 'integrationOffReads', level: 'behaviour' },
      { name: 'storageListedRows', level: 'contract' },
    ],
    requires: [`table:${SHAREPOINT_DOCUMENT}`, `table:${LOCATION}`],
    principal: 'caller',
    stateOwner: 'store',
    lifecycle: 'per-request',
  };
}

export const EXTENSION = { name: 'sharepoint-document-table', install, reset, describe };
