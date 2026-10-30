import { isDeepStrictEqual } from 'node:util';
import { organizationRecord } from './organization-context.mjs';
// Plug-in registration through the Dataverse API. Seeds sdkmessage and
// sdkmessagefilter, mirrors the Solution's registrations into rows, and checks writes to the registration tables with
// the documented errors. A row runs nothing by itself: overlayRegisteredSteps decides which steps join the pipeline. Seeding is insert-or-replace
// by id, so reseeding is idempotent and the Solution's rows win on reseed.
import { DataError } from './data-error.mjs';
import { ownershipTypeName, privilegeDeniedError, uuidV5 } from './dataverse-security.mjs';
import { standardTableDef } from './dataverse-standard.mjs';
import { SDK_MESSAGES, pluginUnsupported } from './exported-plugins.mjs';
import { InvalidAssembly, inspectAssembly, inspectSigningCertificate } from './clr-assembly-reader.mjs';
import { isLoopbackUrl, loopbackFetch, messagingOf, serviceEndpointTarget } from './dataverse-webhooks.mjs';
import { tracedFetch } from './trace-hosts.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { stepConstructorSettings, copyStepConstructorSettings } from './plugin-constructor-configuration.mjs';

const NAMESPACE = uuidV5('6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'paqvilo-dataverse'); // same as dataverse-api.mjs DATAVERSE_NAMESPACE
const SIXTEEN_MB = 16 * 1024 * 1024;
// Platform SDK messages with their native sdkmessage ids (the same in every organization) and row flags: private,
// server-only availability (0, else 2) and read (autotransact false). Recorded from native sdkmessage rows.
const PLATFORM_MESSAGES = Object.fromEntries(
  [
    ['Archive', 'd1b4b049-36f7-4788-93e1-21fa36b3a544', 'private'],
    ['Assign', '8cbdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server'],
    ['Associate', '16e7c888-3b24-448b-b7da-ebfe9b681762'],
    ['BulkArchive', '87a84fbd-5d5c-42a0-a270-bddebee1f9f5', 'private'],
    ['BulkRetain', '3c4af4bf-858c-4bbf-a730-7a4f05d4a1aa'],
    ['Create', '9ebdbb1b-ea3e-db11-86a7-000a3a5473e8'],
    ['CreateMultiple', 'eb9990f6-feff-497f-974c-eb457ee0d072'],
    ['CreateMultipleLegacy', '9473dd2f-1787-4d63-8ed2-79d33ee9550e', 'private'],
    ['Delete', 'a1bdbb1b-ea3e-db11-86a7-000a3a5473e8'],
    ['DeleteMultiple', '3a2f175d-d34f-41ca-94f2-8ec927d1c9e9'],
    ['Disassociate', 'bdfc191d-fc56-493a-a6b1-cb0c47a22ecc'],
    ['Execute', 'a6bdbb1b-ea3e-db11-86a7-000a3a5473e8', 'read'],
    ['GrantAccess', 'c5bdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server'],
    ['IsValidStateTransition', 'cebdbb1b-ea3e-db11-86a7-000a3a5473e8'],
    ['Merge', 'dbbdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server'],
    ['ModifyAccess', 'dcbdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server'],
    ['PurgeArchivedContent', '49648deb-0127-4175-8003-44a9755e15f1', 'private'],
    ['PurgeRetainedContent', 'b7398baf-088d-4a42-8f14-1fdae647dc39'],
    ['Retain', '96db29d8-db5f-4b63-ae1d-2e9a9f222261'],
    ['Retrieve', 'f2bdbb1b-ea3e-db11-86a7-000a3a5473e8', 'read'],
    ['RetrieveExchangeRate', '126075c5-c77f-44fd-bb7d-3457a9168cee'],
    ['RetrieveMultiple', '03bebb1b-ea3e-db11-86a7-000a3a5473e8', 'read'],
    ['RetrievePrincipalAccess', '04bebb1b-ea3e-db11-86a7-000a3a5473e8', 'read'],
    ['RetrieveSharedPrincipalsAndAccess', '10bebb1b-ea3e-db11-86a7-000a3a5473e8', 'read'],
    ['RetrieveVersion', '31bebb1b-ea3e-db11-86a7-000a3a5473e8'],
    ['RevokeAccess', '11bebb1b-ea3e-db11-86a7-000a3a5473e8', 'server'],
    ['RollbackRetain', '9d8b5bbb-f49b-4d3b-8628-0b01f259ef75'],
    ['SetState', '1cbebb1b-ea3e-db11-86a7-000a3a5473e8'],
    ['SetStateDynamicEntity', '1dbebb1b-ea3e-db11-86a7-000a3a5473e8'],
    ['Update', '20bebb1b-ea3e-db11-86a7-000a3a5473e8'],
    ['UpdateMultiple', 'e2ac2e19-aea0-47a3-b024-f7a7015b4d60'],
    ['UpdateMultipleLegacy', '9483dd2f-1787-4d63-8ed2-79d33ee9550e', 'private'],
    ['Upsert', '437b4608-8fc1-472a-968d-3a3f55180fba', 'read'],
    ['UpsertMultiple', 'a37ff683-98b5-4325-953f-9a338240dbf0'],
    ['ValidateArchiveConfig', '8a60138c-3079-473b-ae9b-6d245b4ac3f1', 'private'],
    ['ValidateRetentionConfig', 'd3181841-c5be-4b19-b09b-a20a75ab49ff'],
    ['WhoAmI', '26bebb1b-ea3e-db11-86a7-000a3a5473e8', 'read'],
  ].map(([name, id, flag]) => [name, { id, flag }]),
);
// Native per-table filters follow the table's capabilities. Every table: data, state, retention and archive messages
// (IsValidStateTransition takes no custom step). Custom tables add DeleteMultiple and the legacy bulk messages (a standard
// table such as account has neither). User- or team-owned tables add the ownership and sharing messages; the mergeable
// standard tables add Merge; transactioncurrency adds RetrieveExchangeRate.
const TABLE_MESSAGES = [
  'Create',
  'CreateMultiple',
  'Delete',
  'Retrieve',
  'RetrieveMultiple',
  'Update',
  'UpdateMultiple',
  'SetState',
  'SetStateDynamicEntity',
  'Retain',
  'BulkRetain',
  'PurgeRetainedContent',
  'RollbackRetain',
  'ValidateRetentionConfig',
  'IsValidStateTransition',
  'Archive',
  'BulkArchive',
  'PurgeArchivedContent',
  'ValidateArchiveConfig',
];
const CUSTOM_TABLE_MESSAGES = ['DeleteMultiple', 'CreateMultipleLegacy', 'UpdateMultipleLegacy'];
const OWNED_TABLE_MESSAGES = [
  'Assign',
  'GrantAccess',
  'ModifyAccess',
  'RevokeAccess',
  'RetrievePrincipalAccess',
  'RetrieveSharedPrincipalsAndAccess',
];
const MERGEABLE = new Set(['account', 'contact', 'lead', 'incident']);
const NO_CUSTOM_STEP_MESSAGES = new Set(['IsValidStateTransition']);
// Messages with only the 'none' filter, and whether it allows a custom step. Upsert, UpsertMultiple and Merge allow none
// there; a step registered with no filter is still accepted (and never executed).
const UNFILTERED_MESSAGES = {
  Associate: true,
  Disassociate: true,
  Execute: true,
  Upsert: false,
  UpsertMultiple: false,
  Merge: false,
};
const EXTERNAL_MESSAGES = ['OnExternalCreated', 'OnExternalUpdated', 'OnExternalDeleted'];
const STAGE_NAME = { 10: 'PreValidation', 20: 'PreOperation', 40: 'PostOperation' };
// Mirage's own system tables and intersect tables take no custom processing step.
const NO_CUSTOM_STEP = new Set(['organization', 'privilege', 'roleprivileges']);
// Read-only from the API: only Retrieve, RetrieveMultiple, Associate and Disassociate are documented for these tables.
const READ_ONLY = new Set(['sdkmessage', 'sdkmessagefilter']);
const VERB = { create: 'Create', update: 'Update', delete: 'Delete' };
// The message property each image reads; Create uses its native response Id.
const IMAGE_PROPERTIES = {
  Assign: ['Target'],
  Create: ['Id'],
  CreateMultiple: ['Targets'],
  Delete: ['Target'],
  DeliverIncoming: ['EmailId'],
  DeliverPromote: ['EmailId'],
  Merge: ['Target', 'SubordinateId'],
  Retrieve: ['Target'],
  Route: ['Target'],
  Send: ['FaxId', 'EmailId', 'TemplateId'],
  SetState: ['EntityMoniker'],
  Update: ['Target'],
  UpdateMultiple: ['Targets'],
};
const ADMIN_ROLES = new Set(['System Administrator', 'System Customizer']);
const IMPERSONATE = 'prvSetImpersonatingUserIdOnSdkMessageProcessingStep';
const STAGE_TEXT =
  'Invalid plug-in registration stage. Steps can only be modified in stages BeforeMainOperationOutsideTransaction, BeforeMainOperationInsideTransaction, AfterMainOperationInsideTransaction and AfterMainOperationOutsideTransaction.';
const KNOWN_MESSAGE_IDS = new Map(Object.entries(SDK_MESSAGES).map(([id, name]) => [name, id]));

const messageId = (name) =>
  PLATFORM_MESSAGES[name]?.id ?? KNOWN_MESSAGE_IDS.get(name) ?? uuidV5(NAMESPACE, `sdkmessage:${name}`); // the id of a non-platform message is a guess
const filterId = (org, message, table) => uuidV5(org, `sdkmessagefilter:${message}:${table}`);
// A lookup is stored as its id (Solution rows) or as { id, logical_name, name } (rows the API wrote).
const idOfValue = (value) => (value !== null && typeof value === 'object' ? value.id : value);
const same = (a, b) => {
  const [x, y] = [idOfValue(a), idOfValue(b)];
  return x != null && y != null && String(x).toLowerCase() === String(y).toLowerCase();
};
const fail = (message, innerCode) => new DataError(message, 400, 'InvalidRequest', { innerCode });
// Records do not check required columns; the 0x80040203 invalid-argument default is a guess.
const required = (column) => fail(`The '${column}' attribute is required.`, '0x80040203');
const notFound = (logical, id) =>
  new DataError(`Entity '${logical}' With Id = ${id} Does Not Exist`, 404, 'NotFound', { innerCode: '0x80040217' });
// ponytail: a linear scan per lookup; index the registration tables by id if their row counts grow.
const rowById = (store, logical, column, id) =>
  id == null ? null : (store.tableRows(logical).find((row) => same(row[column], id)) ?? null);
const organizationOf = (store) => String(organizationRecord(store)?.organizationid ?? '').toLowerCase();
const idOf = (bind) =>
  String(bind)
    .match(/\(([^()]*)\)\s*$/)?.[1]
    .replace(/[{}]/g, '')
    .toLowerCase() ?? null;

// A lookup's id: the nav@odata.bind the write carries, else the column (data first, then the existing row).
function ref(data, existing, column, nav = column) {
  const bind = data[`${nav}@odata.bind`];
  if (bind !== undefined) return bind === null ? null : idOf(bind);
  return idOfValue(data[column] !== undefined ? data[column] : (existing?.[column] ?? null));
}
// A column's value after the write: the payload, else the existing row.
const valueOf = (data, existing, column) => (data[column] !== undefined ? data[column] : (existing?.[column] ?? null));

// The step's handler: the polymorphic eventhandler navigation the write names, else the eventhandler or plugintypeid column.
function handlerOf(data, existing) {
  for (const table of ['plugintype', 'serviceendpoint']) {
    const bind = data[`eventhandler_${table}@odata.bind`];
    if (bind) return { id: idOf(bind), table };
  }
  return { id: ref(data, existing, 'eventhandler') ?? ref(data, existing, 'plugintypeid'), table: null };
}

const columnsOf = (store, table) =>
  new Set([
    ...Object.keys(standardTableDef(table)?.attributes ?? {}),
    ...Object.keys(store.state.mappings?.[table]?.fields ?? {}),
  ]);

// Assembly facts without the content: the major and minor from version, the culture and public key token from FullName.
const versionParts = (version) => {
  const [major, minor] = String(version ?? '').split('.');
  return [
    Number.isInteger(Number(major)) && major !== '' ? Number(major) : null,
    Number.isInteger(Number(minor)) && minor !== '' ? Number(minor) : null,
  ];
};
function assemblyFacts(assembly) {
  const [major, minor] = versionParts(assembly.version);
  return {
    major,
    minor,
    culture: /(?:^|,)\s*Culture=([^,]+)/i.exec(assembly.fullName ?? '')?.[1].trim() ?? 'neutral',
    publickeytoken: /PublicKeyToken=([^,\s]+)/i.exec(assembly.fullName ?? '')?.[1] ?? null,
  };
}

// The message rows: the platform messages, every registered name and every custom API (private ones flagged).
function messageRows(store, org, names, availability) {
  const apis = store.state.tables.customapi ?? [];
  const privateApis = new Set(apis.filter((api) => api.isprivate === true).map((api) => api.uniquename));
  const all = new Set([
    ...Object.keys(PLATFORM_MESSAGES),
    ...names,
    ...apis.map((api) => api.uniquename).filter(Boolean),
  ]);
  return [...all].map((name) => {
    const platform = PLATFORM_MESSAGES[name];
    return {
      sdkmessageid: messageId(name),
      name,
      availability: availability[name.toLowerCase()]?.message ?? (platform && platform.flag !== 'server' ? 2 : 0),
      isactive: true,
      isprivate: privateApis.has(name) || platform?.flag === 'private',
      workflowsdkstepenabled: false,
      autotransact: platform?.flag !== 'read',
      organizationid: org,
    };
  });
}

// The messages a table's filters cover (see TABLE_MESSAGES).
function tableMessages(logical, mapping) {
  const owned = ['UserOwned', 'TeamOwned'].includes(ownershipTypeName(logical, null, mapping));
  return [
    ...TABLE_MESSAGES,
    ...(standardTableDef(logical) ? [] : CUSTOM_TABLE_MESSAGES),
    ...(owned ? OWNED_TABLE_MESSAGES : []),
    ...(MERGEABLE.has(logical) ? ['Merge'] : []),
    ...(logical === 'transactioncurrency' ? ['RetrieveExchangeRate'] : []),
    ...(mapping.isVirtual || mapping.dataSourceId ? EXTERNAL_MESSAGES : []),
  ];
}

// The filter rows: one per (message, table) for every mapping (tableMessages), one 'none' filter per unfiltered message,
// and one per custom API (its bound table, or none).
function filterRows(store, org, availability) {
  const rows = [];
  const filter = (message, logical, allowed) => ({
    sdkmessagefilterid: filterId(org, message, logical),
    sdkmessageid: messageId(message),
    primaryobjecttypecode: logical,
    secondaryobjecttypecode: 'none',
    iscustomprocessingstepallowed: allowed,
    isvisible: true,
    availability: availability[message.toLowerCase()]?.filters?.[logical] ?? 0,
    organizationid: org,
  });
  for (const [logical, mapping] of Object.entries(store.state.mappings ?? {}))
    for (const message of tableMessages(logical, mapping))
      rows.push(
        filter(
          message,
          logical,
          !mapping.intersect && !NO_CUSTOM_STEP.has(logical) && !NO_CUSTOM_STEP_MESSAGES.has(message),
        ),
      );
  for (const [message, allowed] of Object.entries(UNFILTERED_MESSAGES)) rows.push(filter(message, 'none', allowed));
  for (const api of store.state.tables.customapi ?? []) {
    const table = api.boundentitylogicalname || 'none';
    rows.push({
      sdkmessagefilterid: filterId(org, api.uniquename, table),
      sdkmessageid: messageId(api.uniquename),
      primaryobjecttypecode: table,
      secondaryobjecttypecode: 'none',
      iscustomprocessingstepallowed: Number(api.allowedcustomprocessingsteptype ?? 0) !== 0,
      isvisible: true,
      availability: 0,
      organizationid: org,
    });
  }
  return rows;
}

function sourceAvailability(plugins) {
  const metadata = Object.create(null);
  const add = (name) => (metadata[String(name).toLowerCase()] ??= { filters: Object.create(null) });
  const messages = new Map((plugins.messages ?? []).map((message) => [String(message.id).toLowerCase(), message.name]));
  for (const message of plugins.messages ?? []) {
    const record = add(message.name);
    if ([0, 1, 2].includes(message.availability)) record.message = message.availability;
    Object.assign(record.filters, message.filterAvailability ?? {});
  }
  for (const filter of plugins.messageFilters ?? []) {
    const name =
      messages.get(String(filter.messageId).toLowerCase()) ?? SDK_MESSAGES[String(filter.messageId).toLowerCase()];
    if (name && [0, 1, 2].includes(filter.availability)) add(name).filters[filter.entity] = filter.availability;
  }
  for (const step of plugins.steps ?? [])
    if (step.message) {
      const record = add(step.message);
      if ([0, 1, 2].includes(step.messageAvailability)) record.message = step.messageAvailability;
      if ([0, 1, 2].includes(step.filterAvailability)) record.filters[step.entity ?? 'none'] = step.filterAvailability;
    }
  return Object.fromEntries(
    Object.entries(metadata).map(([name, record]) => [
      name,
      { ...record, filters: Object.fromEntries(Object.entries(record.filters)) },
    ]),
  );
}

/**
 * The Solution's registrations as rows (solution-metadata plugins, from importSolutionPlugins). Keyed by table; the
 * content is never read. Steps keep their facts even when unsupported: overlayRegisteredSteps decides what runs.
 */
export function solutionPluginRows(plugins, { organizationId } = {}) {
  const org = organizationId;
  const assemblies = plugins?.assemblies ?? [];
  const assemblyById = new Map(assemblies.map((assembly) => [assembly.id, assembly]));
  const rows = { pluginassembly: [], plugintype: [], sdkmessageprocessingstep: [], sdkmessageprocessingstepimage: [] };
  for (const assembly of assemblies) {
    const facts = assemblyFacts(assembly);
    rows.pluginassembly.push({
      pluginassemblyid: assembly.id,
      name: assembly.name,
      version: assembly.version ?? null,
      ...facts,
      isolationmode: assembly.isolationMode ?? 2,
      sourcetype: assembly.sourceType ?? 0,
      organizationid: org,
    });
  }
  for (const type of plugins?.types ?? []) {
    const assembly = assemblyById.get(type.assemblyId);
    const facts = assembly ? assemblyFacts(assembly) : {};
    rows.plugintype.push({
      plugintypeid: type.id,
      typename: type.name,
      name: type.name,
      friendlyname: type.friendlyName ?? type.name,
      pluginassemblyid: type.assemblyId ?? null,
      assemblyname: assembly?.name ?? null,
      version: assembly?.version ?? null,
      culture: facts.culture ?? null,
      publickeytoken: facts.publickeytoken ?? null,
      organizationid: org,
    });
  }
  for (const step of plugins?.steps ?? []) {
    const message = step.message ? messageId(step.message) : null;
    const entity = step.entity && step.entity !== 'none' ? step.entity : null;
    rows.sdkmessageprocessingstep.push({
      sdkmessageprocessingstepid: step.id,
      name: step.name ?? step.id,
      stage: step.stage ?? null,
      mode: step.mode ?? 0,
      rank: step.rank ?? 1,
      supporteddeployment: step.supportedDeployment ?? 0,
      ...(Object.hasOwn(stepConstructorSettings(step), 'unsecureConfiguration')
        ? { configuration: stepConstructorSettings(step).unsecureConfiguration }
        : {}),
      ...(step.secureConfigurationId ? { sdkmessageprocessingstepsecureconfigid: step.secureConfigurationId } : {}),
      ...(step.customizationLevel != null ? { customizationlevel: step.customizationLevel } : {}),
      filteringattributes: (step.filteringAttributes ?? []).join(',') || null,
      statecode: step.enabled === false ? 1 : 0,
      statuscode: step.enabled === false ? 2 : 1,
      sdkmessageid: message,
      sdkmessagefilterid: entity && message ? filterId(org, step.message, entity) : null,
      eventhandler: step.typeId ?? step.serviceEndpointId ?? step.eventHandlerId ?? null,
      plugintypeid: step.typeId ?? null,
      impersonatinguserid: step.impersonatingUserId ?? null,
      organizationid: org,
    });
    for (const image of step.images ?? []) {
      rows.sdkmessageprocessingstepimage.push({
        sdkmessageprocessingstepimageid: uuidV5(
          org,
          `sdkmessageprocessingstepimage:${step.id}:${image.alias || image.name}`,
        ),
        sdkmessageprocessingstepid: step.id,
        name: image.name || image.alias,
        entityalias: image.alias || image.name,
        imagetype: image.type ?? 0,
        attributes: (image.attributes ?? []).join(',') || null,
        // Native Create post-image registration reads its response Id property.
        messagepropertyname: step.message === 'Create' && (image.type ?? 0) !== 0 ? 'Id' : 'Target',
        organizationid: org,
      });
    }
  }
  return rows;
}

// The mutable step fields a row carries. Stored values are read back in the form solutionPluginRows writes them.
const lowerList = (value) =>
  String(value ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
function mutableOf(row, images) {
  return {
    enabled: Number(row.statecode ?? 0) === 0,
    stage: Number(row.stage),
    mode: Number(row.mode ?? 0),
    rank: Number(row.rank),
    supportedDeployment: Number(row.supporteddeployment ?? 0),
    ...(row.customizationlevel != null ? { customizationLevel: Number(row.customizationlevel) } : {}),
    filteringAttributes: lowerList(row.filteringattributes),
    impersonatingUserId: idOfValue(row.impersonatinguserid)
      ? String(idOfValue(row.impersonatinguserid)).toLowerCase()
      : null,
    images: images.map((image) => ({
      name: image.name ?? '',
      alias: image.entityalias ?? '',
      type: Number(image.imagetype ?? 0),
      attributes: lowerList(image.attributes),
    })),
  };
}

// A step the Dataverse API registered, shaped like importSolutionPlugins' steps. A web hook step (eventhandler is a service endpoint)
// has no plug-in type and carries serviceEndpointId instead.
function stepFromRow(store, row, images) {
  const id = String(row.sdkmessageprocessingstepid).toLowerCase();
  const message = rowById(store, 'sdkmessage', 'sdkmessageid', row.sdkmessageid);
  const filter = rowById(store, 'sdkmessagefilter', 'sdkmessagefilterid', row.sdkmessagefilterid);
  const type = rowById(store, 'plugintype', 'plugintypeid', row.plugintypeid ?? row.eventhandler);
  // A web hook step's eventhandler is its service endpoint. The endpoint's secrets stay in the row; the step carries only its id.
  const endpoint = type ? null : rowById(store, 'serviceendpoint', 'serviceendpointid', row.eventhandler);
  const assembly = rowById(store, 'pluginassembly', 'pluginassemblyid', type?.pluginassemblyid);
  const entity = filter && filter.primaryobjecttypecode !== 'none' ? filter.primaryobjecttypecode : null;
  const step = {
    id,
    name: row.name ?? id,
    typeId: type?.plugintypeid ?? null,
    typeName: type?.typename ?? null,
    origin: 'dataverse-api',
    sourceFile: null,
    messageId: message ? String(message.sdkmessageid).toLowerCase() : null,
    message: message?.name ?? null,
    messageEvidence: 'dataverse-row',
    messageSourceFile: null,
    messageObservation: null,
    entity,
    ...(store.observed?.businessLogicOwnership?.[id]
      ? { bypassOwnership: store.observed.businessLogicOwnership[id] }
      : {}),
    // A step on a 'none' filter is unfiltered, like one registered with no filter.
    messageFilterId: entity ? String(filter.sdkmessagefilterid).toLowerCase() : null,
    unfiltered: entity === null,
    typeSourceFile: null,
    assemblyId: assembly?.pluginassemblyid ?? null,
    assemblyName: assembly?.name ?? null,
    assemblySourceFile: null,
    serviceEndpointId: endpoint ? String(endpoint.serviceendpointid).toLowerCase() : null,
    stageName: STAGE_NAME[Number(row.stage)] ?? `Stage ${row.stage ?? 'unknown'}`,
    ...mutableOf(row, images),
    ...customApiContract(store, message?.name),
  };
  return { ...step, unsupported: pluginUnsupported(step) };
}

// The API's extension policy belongs to its message, including an unbound API.
function customApiContract(store, name) {
  const api = store
    .tableRows('customapi')
    .find((row) => String(row.uniquename).toLowerCase() === String(name).toLowerCase());
  return api
    ? {
        customApi: {
          name: api.uniquename,
          bindingType: Number(api.bindingtype ?? 0),
          allowedCustomProcessingStepType: Number(api.allowedcustomprocessingsteptype ?? 0),
          isFunction: api.isfunction === true,
        },
      }
    : {};
}

/**
 * The plug-in steps the pipeline runs when the Dataverse API is on. Rows are the source of truth:
 * - a Solution step whose row matches the seeded row (and its images) keeps its Solution object unchanged, so zero API writes
 *   gives the Solution's own list;
 * - a Solution step whose row changed takes the row's mutable fields (enabled, stage, mode, rank, filtering attributes,
 *   images, supported deployment, impersonation);
 * - a Solution step whose row was deleted is dropped;
 * - a row with no Solution step is a registered step (stepFromRow).
 * ponytail: recomputed on every call; memoise on store.dataRevision() if step counts grow (it does not bump inside a transaction).
 */
export function overlayRegisteredSteps(plugins, store) {
  const org = organizationOf(store);
  const stepRows = store.tableRows('sdkmessageprocessingstep');
  const imageRows = store.tableRows('sdkmessageprocessingstepimage');
  const rowOf = (id) => stepRows.find((row) => same(row.sdkmessageprocessingstepid, id)) ?? null;
  const imagesOf = (id) => imageRows.filter((row) => same(row.sdkmessageprocessingstepid, id));
  const seeded = solutionPluginRows(plugins, { organizationId: org });
  const seededStep = new Map(
    seeded.sdkmessageprocessingstep.map((row) => [String(row.sdkmessageprocessingstepid).toLowerCase(), row]),
  );
  const norm = (value) => (value == null ? '' : String(value).toLowerCase());
  const sameFields = (row, expected) =>
    Object.keys(expected).every((key) =>
      key === 'configuration' ? row[key] === expected[key] : norm(row[key]) === norm(expected[key]),
    );
  // A Solution step whose bare EventHandler named no exported plug-in type (eventHandlerId) resolves against the organization's
  // rows: a serviceendpoint row makes it a service endpoint step, a plugintype row of a registered assembly a plug-in step;
  // with neither it stays unsupported (handler unresolved).
  const resolved = (step) => {
    if (!step.eventHandlerId || step.serviceEndpointId || step.assemblyId) return step;
    const endpoint = rowById(store, 'serviceendpoint', 'serviceendpointid', step.eventHandlerId);
    const type = endpoint ? null : rowById(store, 'plugintype', 'plugintypeid', step.eventHandlerId);
    const assembly = rowById(store, 'pluginassembly', 'pluginassemblyid', type?.pluginassemblyid);
    if (!endpoint && !assembly) return step;
    const next = endpoint
      ? { ...step, serviceEndpointId: String(endpoint.serviceendpointid).toLowerCase() }
      : {
          ...step,
          typeId: String(type.plugintypeid).toLowerCase(),
          typeName: type.typename ?? null,
          assemblyId: String(assembly.pluginassemblyid).toLowerCase(),
          assemblyName: assembly.name ?? null,
        };
    return copyStepConstructorSettings(step, { ...next, unsupported: pluginUnsupported(next) });
  };
  const steps = [],
    solutionIds = new Set();
  for (const source of plugins?.steps ?? []) {
    const step = copyStepConstructorSettings(source, {
        ...resolved(source),
        ...customApiContract(store, source.message),
      }),
      id = String(step.id).toLowerCase();
    solutionIds.add(id);
    const row = rowOf(id);
    if (!row) continue;
    const images = imagesOf(id),
      expectedImages = seeded.sdkmessageprocessingstepimage.filter((image) =>
        same(image.sdkmessageprocessingstepid, id),
      );
    const unchanged =
      sameFields(row, seededStep.get(id)) &&
      images.length === expectedImages.length &&
      expectedImages.every((expected) => {
        const actual = images.find((image) =>
          same(image.sdkmessageprocessingstepimageid, expected.sdkmessageprocessingstepimageid),
        );
        return actual && sameFields(actual, expected);
      });
    if (unchanged) {
      steps.push(step);
      continue;
    }
    const next = { ...step, ...mutableOf(row, images) };
    steps.push({ ...next, unsupported: pluginUnsupported(next) });
  }
  for (const row of stepRows) {
    const id = String(row.sdkmessageprocessingstepid).toLowerCase();
    if (!solutionIds.has(id)) steps.push(stepFromRow(store, row, imagesOf(id)));
  }
  return { ...plugins, steps };
}

// Insert-or-replace by id: a row with the same id is removed first, so the seeded rows match the Solution on every reseed.
// Rows built here for the call (fresh) are stored as they are; others are copied.
function upsert(store, logical, idColumn, rows, { fresh = false } = {}) {
  store.state.tables[logical] ??= [];
  const table = store.state.tables[logical];
  const ids = new Set(rows.map((row) => String(row[idColumn]).toLowerCase()));
  for (let i = table.length - 1; i >= 0; i--)
    if (ids.has(String(table[i][idColumn]).toLowerCase())) store.removeRow(logical, table, i);
  for (const row of rows) store.insertRow(logical, table, fresh ? row : structuredClone(row));
}

// Seeds sdkmessage and sdkmessagefilter, then the Solution rows when given. Runs inside a store transaction.
function seed(api, plugins = null) {
  const { store } = api;
  const org = organizationOf(store) || String(api.settings?.organizationId ?? '').toLowerCase(); // reset runs before the organization row is re-seeded
  const stepMessages = (plugins?.steps ?? []).map((step) => step.message).filter(Boolean);
  const names = [...(api.registry?.names?.() ?? []), ...stepMessages];
  const availability = plugins ? sourceAvailability(plugins) : (store.state.dataverse?.pluginSourceAvailability ?? {});
  if (plugins) (store.state.dataverse ??= {}).pluginSourceAvailability = availability;
  upsert(store, 'sdkmessage', 'sdkmessageid', messageRows(store, org, names, availability), { fresh: true });
  upsert(store, 'sdkmessagefilter', 'sdkmessagefilterid', filterRows(store, org, availability), { fresh: true });
  if (plugins)
    for (const [logical, rows] of Object.entries(solutionPluginRows(plugins, { organizationId: org })))
      upsert(store, logical, `${logical}id`, rows);
}

// Cascade (the documented restrict behavior is not followed): removing an assembly removes its types' steps, and a type
// removes its steps, before the store's own cascade runs. The store then removes the steps' images and the types.
function removeDependents(store, c, logical, existing) {
  const types =
    logical === 'pluginassembly'
      ? store.tableRows('plugintype').filter((type) => same(type.pluginassemblyid, existing.pluginassemblyid))
      : logical === 'plugintype'
        ? [existing]
        : [];
  for (const type of types) {
    const steps = store
      .tableRows('sdkmessageprocessingstep')
      .filter((step) => same(step.eventhandler, type.plugintypeid) || same(step.plugintypeid, type.plugintypeid))
      .map((step) => step.sdkmessageprocessingstepid);
    for (const id of steps)
      if (rowById(store, 'sdkmessageprocessingstep', 'sdkmessageprocessingstepid', id))
        store.removeRecord('sdkmessageprocessingstep', id, c.identity, {});
  }
}

// The content's identity. The bytes are read, never loaded. Content that is not an assembly, or declares no plug-in and
// no workflow activity, is refused.
function assemblyContent(content) {
  let facts = null;
  try {
    facts = inspectAssembly(Buffer.from(content, 'base64'));
  } catch (error) {
    if (!(error instanceof InvalidAssembly)) throw error;
  }
  // The code and text follow the documented error table. ponytail: the TypeDef scan is re-run per plugintype write; cache per assembly id if it shows up.
  if (!facts?.types.some((type) => type.isPlugin || type.isWorkflowActivity))
    throw fail(
      'Plug-in assembly does not contain the required types or assembly content cannot be updated.',
      '0x8004418b',
    );
  return facts;
}

function validateAssembly({ store, data, existing }) {
  const val = (column) => valueOf(data, existing, column);
  // The text and code of the size error are not documented; both are guesses.
  if (typeof val('content') === 'string') {
    const content = val('content');
    const bytes = Math.floor((content.length * 3) / 4) - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0);
    if (bytes > SIXTEEN_MB) throw fail('Plug-in assembly content is larger than 16 MB.', '0x80040203');
  }
  // Supplied content sets the identity, so a content-only create works. Strong-name signing is required unless a package owns it.
  if (typeof data.content === 'string' && data.content !== '') {
    const facts = assemblyContent(data.content);
    Object.assign(data, {
      name: facts.name,
      version: facts.version,
      culture: facts.culture,
      publickeytoken: facts.publicKeyToken,
      major: facts.major,
      minor: facts.minor,
    });
    if (!facts.strongNamed && ref(data, existing, 'packageid') == null)
      throw fail('Plug-in assembly is not strong name signed.', '0x80081114');
  }
  for (const column of ['name', 'version']) if (val(column) == null || val(column) === '') throw required(column);
  const keyOf = (row) => {
    const [major, minor] = versionParts(row.version);
    return [
      String(row.name ?? '').toLowerCase(),
      String(row.culture ?? 'neutral').toLowerCase(),
      String(row.publickeytoken ?? '').toLowerCase(),
      `${row.major ?? major}.${row.minor ?? minor}`,
    ].join('|');
  };
  const key = keyOf({ ...existing, ...data });
  const self = existing?.pluginassemblyid;
  if (store.tableRows('pluginassembly').some((row) => !same(row.pluginassemblyid, self) && keyOf(row) === key))
    throw fail(
      'Plug-in assembly fullnames must be unique (ignoring the version build and revision number).',
      '0x8004417B',
    );
}

function validateType({ store, data, existing }) {
  if (!valueOf(data, existing, 'typename')) throw required('typename');
  const friendlyName = valueOf(data, existing, 'friendlyname');
  if (
    typeof friendlyName === 'string' &&
    friendlyName &&
    store
      .tableRows('plugintype')
      .some(
        (row) =>
          !same(row.plugintypeid, existing?.plugintypeid) &&
          String(row.friendlyname ?? '').toLowerCase() === friendlyName.toLowerCase(),
      )
  )
    throw new DataError('A record with matching key values already exists.', 412, 'DuplicateRecord', {
      innerCode: '0x80040237',
    });
  // The read-only columns come from the assembly (isworkflowactivity needs the content).
  const assembly = rowById(store, 'pluginassembly', 'pluginassemblyid', ref(data, existing, 'pluginassemblyid'));
  if (assembly)
    Object.assign(data, {
      assemblyname: assembly.name,
      version: assembly.version,
      culture: assembly.culture,
      publickeytoken: assembly.publickeytoken,
    });
  // With content, the type must be declared in the assembly (a TypeDef), and isworkflowactivity comes from it.
  if (assembly && typeof assembly.content === 'string' && assembly.content !== '') {
    const typename = valueOf(data, existing, 'typename');
    const type = assemblyContent(assembly.content).types.find((candidate) => candidate.fullName === typename);
    // The code 0x8004418c is documented; the message is a guess.
    if (!type)
      throw fail(`The plug-in type '${typename}' is not declared in assembly '${assembly.name}'.`, '0x8004418c');
    data.isworkflowactivity = type.isWorkflowActivity;
  }
}

function validateImage({ store, data, existing }) {
  const val = (column) => valueOf(data, existing, column);
  const stepId = ref(data, existing, 'sdkmessageprocessingstepid');
  if (!stepId) throw required('sdkmessageprocessingstepid');
  for (const column of ['imagetype', 'messagepropertyname', 'entityalias'])
    if (val(column) == null || val(column) === '') throw required(column);
  const step = rowById(store, 'sdkmessageprocessingstep', 'sdkmessageprocessingstepid', stepId);
  if (!step) throw notFound('sdkmessageprocessingstep', stepId);
  const name = rowById(store, 'sdkmessage', 'sdkmessageid', step.sdkmessageid)?.name ?? '';
  const properties = IMAGE_PROPERTIES[name];
  if (!properties) throw fail(`Message '${name}' does not support image registration.`, '0x80044189');
  const type = Number(val('imagetype')),
    property = String(val('messagepropertyname'));
  const post = type === 1 || type === 2,
    pre = type === 0 || type === 2;
  // Native checks the image type before the property: a Create pre-image on Target is refused for its type.
  if ((['Create', 'CreateMultiple'].includes(name) && pre) || (name === 'Delete' && post))
    throw fail(`Message ${name} does not support this image type.`, '0x8004416d');
  if (!properties.includes(property))
    throw fail(`Message property name '${property}' is not valid on message ${name}.`, '0x8004416b');
  if (post && [10, 20].includes(Number(step.stage)))
    throw fail('PreEvent step registration does not support Post Image.', '0x8004416e');
}

function validateStep({ store, principals, c, data, existing, operation }) {
  const val = (column) => valueOf(data, existing, column);
  // Bounded local managed-base edit contract, not publisher/ownership evidence.
  if (operation === 'update' && existing?.ismanaged === true && Number(existing.customizationlevel) === 0)
    throw fail(
      'A managed base SDK message processing step cannot be modified by this local edit contract.',
      '0x8004419a',
    );
  const messageRefId = ref(data, existing, 'sdkmessageid');
  const filterRefId = ref(data, existing, 'sdkmessagefilterid');
  // Native error texts name the step; a create without a supplied id gets the id its row would take.
  const stepId = () =>
    String(
      existing?.sdkmessageprocessingstepid ?? (data.sdkmessageprocessingstepid ??= store.ids.uuid()),
    ).toLowerCase();
  const handler = handlerOf(data, existing);
  if (operation === 'create' && data.rank === undefined) data.rank = 1; // the Plug-in Registration Tool sends rank; the default is 1
  for (const [column, present] of [
    ['sdkmessageid', messageRefId],
    ['stage', val('stage')],
    ['eventhandler', handler.id],
  ])
    if (present == null || present === '') throw required(column);
  const stage = Number(val('stage')),
    mode = Number(val('mode') ?? 0),
    rank = Number(val('rank'));
  for (const [column, value, accepted] of [
    ['mode', mode, [0, 1]],
    ['supporteddeployment', Number(val('supporteddeployment') ?? 0), [0, 1, 2]],
  ])
    if (!accepted.includes(value))
      throw fail(
        `A validation error occurred. The value ${value} of '${column}' on record of type 'sdkmessageprocessingstep' is outside the valid range. Accepted Values: ${accepted.join(',')}`,
        '0x8004431a',
      );
  const messageName = rowById(store, 'sdkmessage', 'sdkmessageid', messageRefId)?.name;
  const customApi = store.tableRows('customapi').find((row) => row.uniquename === messageName);
  if (customApi) {
    const policy = Number(customApi.allowedcustomprocessingsteptype ?? 0);
    if (policy === 0) throw fail('Custom Sdkmessageprocessingsteps are not allowed for this message.', '0x80090307');
    if (policy === 1 && mode !== 1)
      throw fail('Synchronous mode Sdkmessageprocessingsteps are not allowed on this message.', '0x80090306');
  }
  if (EXTERNAL_MESSAGES.includes(messageName) && (stage !== 40 || mode !== 1)) {
    throw fail('External virtual table events support only asynchronous PostOperation steps.', '0x80090303');
  }
  // Native accepts any whole rank, a negative one included.
  if (!Number.isInteger(rank)) throw fail('The rank must be a whole number.', '0x80040203');
  if (![10, 20, 40].includes(stage)) throw fail(STAGE_TEXT, '0x80044184');
  if (mode === 1 && stage !== 40)
    throw fail(
      `Asynchronous steps are only supported in AfterMainOperationInsideTransaction stages and AfterMainOperationOutsideTransaction stage. SdkMessageProcessingStep name '${val('name') ?? ''}', id '${stepId()}'.`,
      '0x80040203',
    );
  const filter = rowById(store, 'sdkmessagefilter', 'sdkmessagefilterid', filterRefId);
  if (filterRefId) {
    if (!filter || !same(filter.sdkmessageid, messageRefId) || filter.iscustomprocessingstepallowed !== true)
      throw fail(
        `Custom SdkMessageProcessingStep is not allowed on the specified message and entity. SdkMessageProcessingStepId: '${stepId()}', SdkMessageFilterId: '${filterRefId}'.`,
        '0x80044187',
      );
  } else if (messageRefId && !store.tableRows('sdkmessagefilter').some((row) => same(row.sdkmessageid, messageRefId))) {
    throw fail('Custom Sdkmessageprocessingsteps are not allowed for this message.', '0x80090307');
  }
  const availability = store.state.dataverse?.pluginSourceAvailability?.[String(messageName).toLowerCase()];
  const deployment = Number(val('supporteddeployment') ?? 0);
  const knownAvailability = [availability?.message, availability?.filters?.[filter?.primaryobjecttypecode ?? 'none']];
  if ((deployment !== 0 && knownAvailability.includes(0)) || (deployment !== 1 && knownAvailability.includes(1)))
    throw fail('Supported deployment does not agree with message availability', '0x80040203');
  // The attributes must be columns of the filter's table (a missing dependency natively); any message is accepted.
  const table = filter?.primaryobjecttypecode;
  if (table && table !== 'none') {
    const columns = columnsOf(store, table);
    for (const attribute of String(val('filteringattributes') ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean))
      if (!columns.has(attribute))
        throw fail(
          `The dependent component Attribute (Id=${attribute}) does not exist.  Failure trying to associate it with SdkMessageProcessingStep (Id=${stepId()}) as a dependency. Missing dependency lookup type = AttributeNameLookup.`,
          '0x8004f036',
        );
  }
  if (ref(data, existing, 'sdkmessageprocessingstepsecureconfigid') && Number(val('supporteddeployment') ?? 0) !== 0)
    throw fail(
      'Only SdkMessageProcessingStep with ServerOnly supported deployment can have secure configuration.',
      '0x80044185',
    );
  const impersonates =
    ['impersonatinguserid', 'impersonatinguserid@odata.bind'].some((key) => key in data) &&
    ref(data, existing, 'impersonatinguserid');
  if (impersonates && c.user) {
    const allowed =
      principals.roles(c.user).some((role) => ADMIN_ROLES.has(role.name)) ||
      principals.privileges(c.user).has(IMPERSONATE);
    if (!allowed) throw privilegeDeniedError(c.user, IMPERSONATE, 'sdkmessageprocessingstep');
  }
  // A web hook step takes no configuration (documented); the text and code are guesses.
  if (handler.table === 'serviceendpoint' || rowById(store, 'serviceendpoint', 'serviceendpointid', handler.id)) {
    if (val('configuration')) throw fail('A web hook step cannot have a configuration.', '0x80040203');
  }
}

// A web hook (contract 8) needs its endpoint URL and one of its three authentication types: WebhookKey (4),
// HttpHeader (5) or HttpQueryString (6). The codes and texts of these two errors are guesses.
const WEBHOOK_AUTH = new Set([4, 5, 6]);
function validateEndpoint({ data, existing }) {
  const val = (column) => valueOf(data, existing, column);
  if (Number(val('contract')) !== 8) return;
  if (val('url') == null || val('url') === '') throw required('url');
  if (val('authtype') == null) throw required('authtype');
  if (!WEBHOOK_AUTH.has(Number(val('authtype'))))
    throw fail(
      'The authentication type of a web hook must be WebhookKey, HttpHeader or HttpQueryString.',
      '0x80040203',
    );
}

const VALIDATORS = {
  pluginassembly: validateAssembly,
  plugintype: validateType,
  sdkmessageprocessingstep: validateStep,
  sdkmessageprocessingstepimage: validateImage,
  serviceendpoint: validateEndpoint,
};

function registrationWrite(api) {
  const { store, principals } = api;
  return (c, mapping, { operation, data = {}, existing = null }) => {
    const logical = mapping.logicalName;
    if (operation !== 'create' && operation !== 'update' && operation !== 'delete') return;
    if (READ_ONLY.has(logical))
      throw fail(
        `The '${VERB[operation]}' method does not support entities of type '${logical}'. MessageProcessorCache returned MessageProcessor.Empty. `,
        '0x80040800',
      );
    if (operation === 'delete') return removeDependents(store, c, logical, existing);
    VALIDATORS[logical]?.({ store, principals, c, data, existing, operation });
  };
}

// Registered by dataverse-extensions.mjs. Seeds the messages and filters; the hooks validate the seven registration tables.
export function install(api) {
  api.recordHooks.add('beforeWrite', registrationWrite(api));
  api.registry?.register?.(triggerServiceEndpointCheck(api));
  api.registry?.register?.({
    name: 'GetPluginCertificateInfo',
    kind: 'function',
    binding: 'unbound',
    signature: {
      params: [
        ['ComponentName', 'Edm.String'],
        ['ComponentId', 'Edm.Guid'],
      ],
      response: [
        ['SubjectDN', 'Edm.String'],
        ['CertificateHash', 'Edm.String'],
        ['IssuerDN', 'Edm.String'],
        ['IsSelfSigned', 'Edm.Boolean'],
        ['CertificateSegment', 'Edm.String'],
        ['EncodedSubject', 'Edm.String'],
        ['EncodedIssuer', 'Edm.String'],
        ['CertificateSegmentV2', 'Edm.String'],
      ],
    },
    handle(c) {
      // Platform CSDL defines the response. An unsigned component has no signing certificate; strong-name keys are unrelated.
      // Native DN formatting, segment representation and errors are guesses. Inspection never executes the image or
      // asserts certificate/image trust; it identifies the CMS signer by issuer+serial, not the first certificate in its chain.
      const logical = String(c.params?.ComponentName ?? '').toLowerCase();
      if (!['pluginassembly', 'pluginpackage'].includes(logical))
        throw fail('ComponentName must be pluginassembly or pluginpackage.', '0x80040203');
      const mapping = api.store.resolveMapping(logical);
      const row = rowById(api.store, logical, mapping.idColumn, c.params?.ComponentId);
      if (!row) throw notFound(logical, c.params?.ComponentId);
      api.principals.authorize({ user: c.user, entity: logical, operation: 'read', row, mapping });
      const bytes = typeof row.content === 'string' ? Buffer.from(row.content, 'base64') : null;
      let certificate = null;
      try {
        if (bytes?.length) certificate = inspectSigningCertificate(bytes, { package: logical === 'pluginpackage' });
      } catch (error) {
        if (!(error instanceof InvalidAssembly)) throw error;
        throw fail(error.message, '0x80040203');
      }
      return {
        status: 200,
        body: {
          '@odata.context': contextUrl(c.origin, c.version, 'Microsoft.Dynamics.CRM.GetPluginCertificateInfoResponse'),
          SubjectDN: certificate?.subject ?? null,
          CertificateHash: certificate?.hash ?? null,
          IssuerDN: certificate?.issuer ?? null,
          IsSelfSigned: certificate?.selfSigned ?? null,
          CertificateSegment: certificate?.certificate ?? null,
          EncodedSubject: certificate?.encodedSubject ?? null,
          EncodedIssuer: certificate?.encodedIssuer ?? null,
          CertificateSegmentV2: certificate?.certificate ?? null,
        },
      };
    },
  });
  return api.store.transact(() => seed(api));
}

// TriggerServiceEndpointCheck: probes a web hook endpoint. Only a contract 8 (webhook) endpoint on a loopback URL is contacted
// (the guard is shared with the webhook delivery in dataverse-webhooks.mjs); the probe is a POST answered with any 2xx.
// Queue (2), Topic (5) and Queue Persistent (6) endpoints pass when a messaging provider (api.providers.messaging) maps them to
// a bus entity; nothing is sent. The probe body, headers and error texts are guesses; the 2/5/6 answer reuses
// the web hook's success shape (204).
const WEBHOOK_CONTRACT = 8;
const BUS_CONTRACTS = new Set([2, 5, 6]);
const triggerServiceEndpointCheck = (api) => ({
  name: 'TriggerServiceEndpointCheck',
  kind: 'action',
  binding: 'entity',
  entity: 'serviceendpoint',
  async handle(ctx) {
    const row = ctx.target?.row;
    if (!row) throw fail('The web service endpoint was not found.', '0x80040217');
    const messaging = BUS_CONTRACTS.has(Number(row.contract)) ? messagingOf(api.providers?.messaging ?? null) : null;
    if (messaging) {
      if (!serviceEndpointTarget(messaging, row))
        throw fail('The service endpoint has no providers.messaging.endpoints mapping in the simulator.', '0x80040203');
      return { status: 204 };
    }
    if (Number(row.contract) !== WEBHOOK_CONTRACT)
      throw fail('The endpoint check supports only web hook (contract 8) endpoints.', '0x80040203');
    if (!isLoopbackUrl(row.url))
      throw fail('The endpoint check reaches only loopback URLs in the simulator.', '0x80040203');
    const url = new URL(String(row.url));
    // The probe is an http-out span (the endpoint's answer, or the network failure, on it).
    const response = await tracedFetch(api.store.traces, {
      module: 'webhooks',
      operation: 'check',
      url,
      fetch: loopbackFetch,
      attributes: { serviceEndpointId: row.serviceendpointid ?? null, contract: WEBHOOK_CONTRACT },
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ms-dynamics-request-name': 'TriggerServiceEndpointCheck' },
        body: JSON.stringify({ MessageName: 'TriggerServiceEndpointCheck' }),
        signal: AbortSignal.timeout(60_000),
      },
    }).catch(() => null);
    if (!response?.ok) throw fail('Endpoint unavailable', '0x80040265');
    return { status: 204 };
  },
});

function reset(api) {
  return api.store.transact(() => seed(api));
}

// Server-side extension that mirrors the Solution's plug-in registrations. Registered after the custom API extension, so the
// custom API messages exist when the rows are written. plugins is solution-metadata's plugins (importSolutionPlugins output).
// plugins may be a getter over the current sources (source-organization-extensions.mjs refresh). sync(api) reseeds inside the
// caller's transaction and removes the Solution rows an earlier seed wrote (state.dataverse.sourceSeeded) whose registration
// is gone from the sources; it returns { table: { added, changed, removed } }.
export function solutionPluginExtension(plugins) {
  const pluginsOf = () => (typeof plugins === 'function' ? plugins() : plugins);
  const sync = (api) => {
    const { store } = api,
      current = pluginsOf();
    const seeded = ((store.state.dataverse ??= {}).sourceSeeded ??= {});
    const org = organizationOf(store) || String(api.settings?.organizationId ?? '').toLowerCase();
    const rows = current ? solutionPluginRows(current, { organizationId: org }) : {};
    const changes = {};
    // Images before steps before types before assemblies, so no removed row is left pointing at a removed parent.
    for (const logical of [
      'sdkmessageprocessingstepimage',
      'sdkmessageprocessingstep',
      'plugintype',
      'pluginassembly',
    ]) {
      const idColumn = `${logical}id`,
        key = `plugin:${logical}`,
        next = new Set((rows[logical] ?? []).map((row) => String(row[idColumn]).toLowerCase()));
      const table = store.state.tables[logical] ?? [],
        present = new Map(table.map((row) => [String(row[idColumn]).toLowerCase(), row]));
      const counts = { added: 0, changed: 0, removed: 0 };
      for (let i = table.length - 1; i >= 0; i--) {
        const id = String(table[i][idColumn]).toLowerCase();
        if ((seeded[key] ?? []).includes(id) && !next.has(id)) {
          store.removeRow(logical, table, i);
          counts.removed += 1;
        }
      }
      for (const row of rows[logical] ?? []) {
        const existing = present.get(String(row[idColumn]).toLowerCase());
        if (!existing) counts.added += 1;
        else if (!isDeepStrictEqual(existing, row)) counts.changed += 1;
      }
      seeded[key] = [...next];
      changes[logical] = counts;
    }
    seed(api, current ?? null);
    return changes;
  };
  const seedSolution = (api) =>
    api.store.transact(() => {
      sync(api);
    });
  return { name: 'dataverse-plugin-registration-solution', install: seedSolution, reset: seedSolution, sync };
}

export const EXTENSION = { name: 'dataverse-plugin-registration', install, reset };
