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
import { InvalidAssembly, inspectAssembly, inspectPackage, inspectSigningCertificate } from './clr-assembly-reader.mjs';
import { isLoopbackUrl, loopbackFetch, messagingOf, serviceEndpointTarget } from './dataverse-webhooks.mjs';
import { tracedFetch } from './trace-hosts.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { stepConstructorSettings, copyStepConstructorSettings } from './plugin-constructor-configuration.mjs';

const NAMESPACE = uuidV5('6ba7b811-9dad-11d1-80b4-00c04fd430c8', 'paqvilo-dataverse'); // same as dataverse-api.mjs DATAVERSE_NAMESPACE
const SIXTEEN_MB = 16 * 1024 * 1024;
// Platform SDK messages with their native sdkmessage ids (the same in every organization) and row flags (space separated):
// private, server-only availability (0, else 2) and read (autotransact false). Recorded from native sdkmessage rows. Only
// standard SDK messages belong here; messages a Microsoft solution installs (msdyn_, adx_, AI..., search...) are environment
// content, not platform constants.
const PLATFORM_MESSAGES = Object.fromEntries(
  [
    ['ApplyRecordCreationAndUpdateRule', 'b8c5bc44-f2cb-4a1a-99b0-f35802de0a6a', 'server read'],
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
    ['Export', 'a9bdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server read'],
    ['ExportAll', 'aabdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server read'],
    ['ExportCompressed', 'f822e36d-ff93-42ad-b833-45697966f484', 'server read'],
    ['ExportCompressedAll', '343f7101-2166-40ea-ae81-9b183909592e', 'server read'],
    ['GrantAccess', 'c5bdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server'],
    ['Import', 'c7bdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server read'],
    ['ImportAll', 'c8bdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server read'],
    ['ImportCompressedAll', 'ae6eb9c2-3c62-41f5-a1fe-f19f3709c75b', 'server read'],
    ['ImportCompressedWithProgress', '0468d3d7-836b-4bb8-84cf-ca587cc30c68', 'server read'],
    ['ImportWithProgress', '0368d3d7-836b-4bb8-84cf-ca587cc30c68', 'server read'],
    ['IsValidStateTransition', 'cebdbb1b-ea3e-db11-86a7-000a3a5473e8'],
    ['Merge', 'dbbdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server'],
    ['ModifyAccess', 'dcbdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server'],
    ['Publish', 'b2bdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server read'],
    ['PublishAll', 'debdbb1b-ea3e-db11-86a7-000a3a5473e8', 'server read'],
    ['PurgeArchivedContent', '49648deb-0127-4175-8003-44a9755e15f1', 'private'],
    ['PurgeRetainedContent', 'b7398baf-088d-4a42-8f14-1fdae647dc39'],
    ['Retain', '96db29d8-db5f-4b63-ae1d-2e9a9f222261'],
    ['Retrieve', 'f2bdbb1b-ea3e-db11-86a7-000a3a5473e8', 'read'],
    ['ReplicateAssociate', 'b8a2d3e4-5f6a-4b7c-8d9e-0f1a2b3c4d5e'],
    ['ReplicateDisassociate', '4b5c6d7e-8f9a-4b0c-1d2e-3f4a5b6c7d8e'],
    ['RetrieveEntityChanges', 'ffe4e36f-d366-4c5f-8f20-47910c912cad', 'read'],
    ['RetrieveExchangeRate', '126075c5-c77f-44fd-bb7d-3457a9168cee'],
    ['RetrieveMultiple', '03bebb1b-ea3e-db11-86a7-000a3a5473e8', 'read'],
    ['RetrievePersonalWall', 'df5b3fb2-79db-11e0-a0f5-1cc1de634cfe', 'server'],
    ['RetrievePrincipalAccess', '04bebb1b-ea3e-db11-86a7-000a3a5473e8', 'read'],
    ['RetrieveRecordWall', 'f03e8105-79da-11e0-a0f5-1cc1de634cfe', 'server'],
    ['RetrieveSharedPrincipalsAndAccess', '10bebb1b-ea3e-db11-86a7-000a3a5473e8', 'read'],
    ['RetrieveVersion', '31bebb1b-ea3e-db11-86a7-000a3a5473e8'],
    ['RevokeAccess', '11bebb1b-ea3e-db11-86a7-000a3a5473e8', 'server'],
    ['RollbackRetain', '9d8b5bbb-f49b-4d3b-8628-0b01f259ef75'],
    ['SetLocLabels', '939dd666-7914-490e-adf9-4fb093dee8b7', 'server'],
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
  ].map(([name, id, flags = '']) => [name, { id, flags: flags.split(' ') }]),
);
// Native per-table filters of a custom table (proven for a user-owned and an organization-owned one) follow its
// capabilities. Every table: data, state, retention and archive messages (IsValidStateTransition takes no custom step on
// a custom table). Custom tables add DeleteMultiple and the legacy bulk messages. User- or team-owned tables add the
// ownership and sharing messages. Standard tables whose native filters were recorded use STANDARD_TABLE_FILTERS instead;
// other standard tables reuse this template (mergeable ones add Merge), which is not proven for them.
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
// Native filter sets of standard tables, as [message, iscustomprocessingstepallowed, availability] (native sdkmessagefilter
// rows): account has the template's messages with every one allowed (IsValidStateTransition included) and server-only
// ownership, sharing, IsValidStateTransition and Merge filters; transactioncurrency has eight filters and refuses
// Retrieve/RetrieveMultiple steps.
const ACCOUNT_SERVER_FILTERS = new Set([
  'Assign',
  'GrantAccess',
  'ModifyAccess',
  'RevokeAccess',
  'IsValidStateTransition',
  'Merge',
]);
const STANDARD_TABLE_FILTERS = {
  account: [
    'Archive',
    'Assign',
    'BulkArchive',
    'BulkRetain',
    'Create',
    'CreateMultiple',
    'Delete',
    'GrantAccess',
    'IsValidStateTransition',
    'Merge',
    'ModifyAccess',
    'PurgeArchivedContent',
    'PurgeRetainedContent',
    'Retain',
    'Retrieve',
    'RetrieveMultiple',
    'RetrievePrincipalAccess',
    'RetrieveSharedPrincipalsAndAccess',
    'RevokeAccess',
    'RollbackRetain',
    'SetState',
    'SetStateDynamicEntity',
    'Update',
    'UpdateMultiple',
    'ValidateArchiveConfig',
    'ValidateRetentionConfig',
  ].map((message) => [message, true, ACCOUNT_SERVER_FILTERS.has(message) ? 0 : 2]),
  // Native filter catalogue round 2 (native-filters-2). Messages whose native sdkmessageid is not recorded are left out:
  // Handle and Route (task), AddMembers and RemoveMembers (team), and the systemuser and team messages that refuse
  // custom steps (InviteUser, PromoteToAdmin, SetParent, RetrieveMembers, ...).
  contact: [
    ['Assign', true, 0],
    ['Create', true, 2],
    ['CreateMultiple', true, 2],
    ['Delete', true, 2],
    ['GrantAccess', true, 0],
    ['IsValidStateTransition', true, 0],
    ['Merge', true, 0],
    ['ModifyAccess', true, 0],
    ['Retrieve', true, 2],
    ['RetrieveMultiple', true, 2],
    ['RetrievePrincipalAccess', true, 2],
    ['RetrieveSharedPrincipalsAndAccess', true, 2],
    ['RevokeAccess', true, 0],
    ['SetState', true, 2],
    ['SetStateDynamicEntity', true, 2],
    ['Update', true, 2],
    ['UpdateMultiple', true, 2],
  ],
  task: [
    ['Assign', true, 0],
    ['Create', true, 2],
    ['CreateMultiple', true, 2],
    ['Delete', true, 2],
    ['GrantAccess', true, 0],
    ['ModifyAccess', true, 0],
    ['Retrieve', true, 2],
    ['RetrieveMultiple', true, 2],
    ['RetrievePrincipalAccess', true, 2],
    ['RetrieveSharedPrincipalsAndAccess', true, 2],
    ['RevokeAccess', true, 0],
    ['SetState', true, 2],
    ['SetStateDynamicEntity', true, 2],
    ['Update', true, 2],
    ['UpdateMultiple', true, 2],
  ],
  systemuser: [
    ['Create', true, 0],
    ['Delete', true, 0],
    ['Retrieve', false, 2],
    ['RetrieveMultiple', false, 2],
    ['SetState', true, 0],
    ['SetStateDynamicEntity', true, 0],
    ['Update', true, 0],
  ],
  team: [
    ['Archive', true, 2],
    ['Create', true, 0],
    ['Delete', true, 0],
    ['Retrieve', true, 2],
    ['RetrieveMultiple', true, 2],
    ['Update', true, 0],
  ],
  transactioncurrency: [
    ['Create', true, 0],
    ['Delete', true, 0],
    ['Retrieve', false, 2],
    ['RetrieveExchangeRate', true, 2],
    ['RetrieveMultiple', false, 2],
    ['SetState', true, 0],
    ['SetStateDynamicEntity', true, 0],
    ['Update', true, 0],
  ],
};
// Native filter sets of table kinds (native filter catalogue round 2): an N:N intersect table takes custom steps on
// RetrieveMultiple only; an elastic table has data, bulk, Upsert, change-tracking, retention and archive filters (no state or
// sharing messages; Assign and RetrievePrincipalAccess when owned); a virtual table has its data filters. All allow custom
// steps with server-only availability. (UpsertMultipleLegacy, whose native id is not recorded, is left out.)
const INTERSECT_MESSAGES = ['RetrieveMultiple'];
const ELASTIC_MESSAGES = [
  'Archive',
  'BulkArchive',
  'BulkRetain',
  'Create',
  'CreateMultiple',
  'CreateMultipleLegacy',
  'Delete',
  'DeleteMultiple',
  'PurgeArchivedContent',
  'PurgeRetainedContent',
  'Retain',
  'Retrieve',
  'RetrieveEntityChanges',
  'RetrieveMultiple',
  'RollbackRetain',
  'Update',
  'UpdateMultiple',
  'UpdateMultipleLegacy',
  'Upsert',
  'UpsertMultiple',
  'ValidateArchiveConfig',
  'ValidateRetentionConfig',
];
const VIRTUAL_MESSAGES = [
  'Create',
  'CreateMultipleLegacy',
  'Delete',
  'Retrieve',
  'RetrieveEntityChanges',
  'RetrieveMultiple',
  'Update',
  'UpdateMultipleLegacy',
];
// The 'none' (no table) filters native has for platform messages, as message: [iscustomprocessingstepallowed, availability,
// unfiltered]. The allowed flag governs a step registered on that filter. A step registered with no filter is accepted on any
// existing message (Upsert, Merge and RetrieveEntityChanges included, whose 'none' filters refuse custom steps) except where
// unfiltered is false: native refuses a global WhoAmI or RetrieveVersion step (0x80044187).
const NONE_FILTERS = {
  ApplyRecordCreationAndUpdateRule: [true, 0],
  Associate: [true, 2],
  Disassociate: [true, 2],
  Execute: [true, 2],
  Export: [true, 0],
  ExportAll: [true, 0],
  ExportCompressed: [true, 0],
  ExportCompressedAll: [true, 0],
  Import: [true, 0],
  ImportAll: [true, 0],
  ImportCompressedAll: [true, 0],
  ImportCompressedWithProgress: [true, 0],
  ImportWithProgress: [true, 0],
  Merge: [false, 2],
  Publish: [true, 0],
  PublishAll: [true, 0],
  ReplicateAssociate: [true, 2],
  ReplicateDisassociate: [true, 2],
  RetrieveEntityChanges: [false, 2],
  RetrievePersonalWall: [true, 0],
  RetrieveRecordWall: [true, 0],
  RetrieveVersion: [false, 2, false],
  SetLocLabels: [true, 0],
  Upsert: [false, 2],
  UpsertMultiple: [false, 2],
  WhoAmI: [false, 2, false],
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
  DeleteMultiple: ['Targets'],
  DeliverIncoming: ['EmailId'],
  GrantAccess: ['Target'],
  DeliverPromote: ['EmailId'],
  Merge: ['Target', 'SubordinateId'],
  Retrieve: ['Target'],
  Route: ['Target'],
  Send: ['FaxId', 'EmailId', 'TemplateId'],
  SetState: ['EntityMoniker'],
  SetStateDynamicEntity: ['EntityMoniker'],
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
// Records do not check required columns; the 0x80040203 invalid-argument default is a guess. A step without a message or
// handler answers native's 0x80040200 "<column> is missing." (registration round 2).
const required = (column) => fail(`The '${column}' attribute is required.`, '0x80040203');
const missing = (column) => fail(`${column} is missing.`, '0x80040200');
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
      availability:
        availability[name.toLowerCase()]?.message ?? (platform && !platform.flags.includes('server') ? 2 : 0),
      isactive: true,
      isprivate: privateApis.has(name) || platform?.flags.includes('private') === true,
      workflowsdkstepenabled: false,
      autotransact: !platform?.flags.includes('read'),
      organizationid: org,
    };
  });
}

// The messages a table's filters cover (see TABLE_MESSAGES).
function tableMessages(logical, mapping) {
  const owned = ['UserOwned', 'TeamOwned'].includes(ownershipTypeName(logical, null, mapping));
  const external = mapping.isVirtual || mapping.dataSourceId ? EXTERNAL_MESSAGES : [];
  if (mapping.intersect) return INTERSECT_MESSAGES;
  if (mapping.tableType === 'Elastic')
    return [...ELASTIC_MESSAGES, ...(owned ? ['Assign', 'RetrievePrincipalAccess'] : [])];
  if (mapping.isVirtual || mapping.dataSourceId) return [...VIRTUAL_MESSAGES, ...external];
  return [
    ...TABLE_MESSAGES,
    ...(standardTableDef(logical) ? [] : CUSTOM_TABLE_MESSAGES),
    ...(owned ? OWNED_TABLE_MESSAGES : []),
    ...(MERGEABLE.has(logical) ? ['Merge'] : []),
    ...(logical === 'transactioncurrency' ? ['RetrieveExchangeRate'] : []),
  ];
}

// The filter rows: one per (message, table) for every mapping (STANDARD_TABLE_FILTERS, else tableMessages), the native
// 'none' filters (NONE_FILTERS), and one per custom API (customApiFilterRow).
function filterRows(store, org, availability) {
  const rows = [];
  const filter = (message, logical, allowed, defaultAvailability = 0) => ({
    sdkmessagefilterid: filterId(org, message, logical),
    sdkmessageid: messageId(message),
    primaryobjecttypecode: logical,
    secondaryobjecttypecode: 'none',
    iscustomprocessingstepallowed: allowed,
    isvisible: true,
    availability: availability[message.toLowerCase()]?.filters?.[logical] ?? defaultAvailability,
    organizationid: org,
  });
  for (const [logical, mapping] of Object.entries(store.state.mappings ?? {})) {
    const standard = STANDARD_TABLE_FILTERS[logical];
    if (standard) {
      for (const [message, allowed, available] of standard) rows.push(filter(message, logical, allowed, available));
      continue;
    }
    for (const message of tableMessages(logical, mapping))
      rows.push(
        filter(
          message,
          logical,
          !NO_CUSTOM_STEP.has(logical) &&
            (mapping.intersect || mapping.tableType === 'Elastic' || !NO_CUSTOM_STEP_MESSAGES.has(message)),
        ),
      );
  }
  for (const [message, [allowed, available]] of Object.entries(NONE_FILTERS))
    rows.push(filter(message, 'none', allowed, available));
  for (const api of store.state.tables.customapi ?? []) rows.push(customApiFilterRow(org, api));
  return rows;
}

// A custom API's one filter: its bound table, or none. Steps are allowed unless the API's policy is 0.
function customApiFilterRow(org, api) {
  const table = api.boundentitylogicalname || 'none';
  return {
    sdkmessagefilterid: filterId(org, api.uniquename, table),
    sdkmessageid: messageId(api.uniquename),
    primaryobjecttypecode: table,
    secondaryobjecttypecode: 'none',
    iscustomprocessingstepallowed: Number(api.allowedcustomprocessingsteptype ?? 0) !== 0,
    isvisible: true,
    availability: 0,
    organizationid: org,
  };
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
        // The exported MessagePropertyName; without it, Create images read the response Id property and others Target.
        messagepropertyname:
          image.messagePropertyName ?? (step.message === 'Create' && (image.type ?? 0) !== 0 ? 'Id' : 'Target'),
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
  // A step whose plug-in type lives in an assembly with uploaded content carries that assembly's id: the pipeline runs the
  // stored bytes (plugin-uploaded.mjs). A Solution step without uploaded content is unchanged.
  const uploaded = (step) => {
    const type = rowById(store, 'plugintype', 'plugintypeid', step.typeId);
    const assembly = rowById(store, 'pluginassembly', 'pluginassemblyid', type?.pluginassemblyid ?? step.assemblyId);
    return typeof assembly?.content === 'string' && assembly.content !== '' && step.typeName && !step.serviceEndpointId
      ? copyStepConstructorSettings(step, {
          ...step,
          uploadedAssemblyId: String(idOfValue(assembly.pluginassemblyid)).toLowerCase(),
        })
      : step;
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
  return { ...plugins, steps: steps.map(uploaded) };
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
  (store.state.dataverse ??= {}).customApiMessages = store.tableRows('customapi').map((api) => api.uniquename);
  if (plugins)
    for (const [logical, rows] of Object.entries(solutionPluginRows(plugins, { organizationId: org })))
      upsert(store, logical, `${logical}id`, rows);
}

const typesOfAssembly = (store, assemblyId) =>
  store.tableRows('plugintype').filter((type) => same(type.pluginassemblyid, assemblyId));
const assembliesOfPackage = (store, packageId) =>
  store.tableRows('pluginassembly').filter((assembly) => same(assembly.packageid, packageId));
const stepsOfType = (store, typeId) =>
  store
    .tableRows('sdkmessageprocessingstep')
    .filter((step) => same(step.eventhandler, typeId) || same(step.plugintypeid, typeId));
// A component that steps reference is not deleted (native registration round 2: deleting a plug-in type with a step answers
// 0x8004f01f and the step survives; Learn: no assembly or package is unregistered while steps depend on it). The assembly
// and package refusals reuse the type's native form.
const SCHEMA = { pluginpackage: 'PluginPackage', pluginassembly: 'PluginAssembly', plugintype: 'PluginType' };
const dependentSteps = (logical, id, count) =>
  fail(
    `The ${SCHEMA[logical]}(${String(id).toLowerCase()}) component cannot be deleted because it is referenced by ${count} other components. For a list of referenced components, use the RetrieveDependenciesForDeleteRequest.`,
    '0x8004f01f',
  );

// A plug-in type or assembly with steps is not deleted; a package-owned assembly is deleted only with its package
// (0x80081117). The store's cascade then removes the types of a deleted assembly. A package removes its assemblies and
// their types itself (they are platform rows of the package).
function guardDelete(store, logical, existing) {
  if (logical === 'pluginassembly' && ref({}, existing, 'packageid') != null)
    throw fail('Unable to delete plug-in assembly as it is part of plugin package.', '0x80081117');
  const types =
    logical === 'pluginpackage'
      ? assembliesOfPackage(store, existing.pluginpackageid).flatMap((assembly) =>
          typesOfAssembly(store, assembly.pluginassemblyid),
        )
      : logical === 'pluginassembly'
        ? typesOfAssembly(store, existing.pluginassemblyid)
        : logical === 'plugintype'
          ? [existing]
          : [];
  const steps = types.reduce((count, type) => count + stepsOfType(store, type.plugintypeid).length, 0);
  if (steps) throw dependentSteps(logical, existing[`${logical}id`], steps);
  if (logical === 'pluginpackage') removePackageRows(store, existing.pluginpackageid, () => true);
}

// Removes the package's assembly and type rows that drop(assembly | type) selects, without the record pipeline.
function removePackageRows(store, packageId, drop) {
  for (const assembly of assembliesOfPackage(store, packageId)) {
    const gone = drop(assembly);
    const types = store.state.tables.plugintype ?? [];
    for (let i = types.length - 1; i >= 0; i--)
      if (same(types[i].pluginassemblyid, assembly.pluginassemblyid) && (gone || drop(types[i])))
        store.removeRow('plugintype', types, i);
    if (!gone) continue;
    const assemblies = store.state.tables.pluginassembly;
    store.removeRow('pluginassembly', assemblies, assemblies.indexOf(assembly));
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

const base64Bytes = (content) =>
  Math.floor((content.length * 3) / 4) - (content.endsWith('==') ? 2 : content.endsWith('=') ? 1 : 0);

function validateAssembly({ store, data, existing }) {
  const val = (column) => valueOf(data, existing, column);
  // Codes and texts follow the documented error table (PluginAssemblyContentSizeExceeded, InvalidAssemblySourceType,
  // InvalidPluginRegistrationConfiguration for an isolation mode other than Sandbox, the only mode online).
  if (typeof val('content') === 'string') {
    const bytes = base64Bytes(val('content'));
    if (bytes > SIXTEEN_MB)
      throw fail(
        `The assembly content size '${bytes} bytes' has exceeded the maximum value allowed for isolated plug-ins '${SIXTEEN_MB} bytes'.`,
        '0x8004418f',
      );
  }
  if (data.sourcetype !== undefined && data.sourcetype !== null && Number(data.sourcetype) !== 0)
    throw fail('The given plugin assembly source type is not supported for isolated plugin assemblies.', '0x8004417D');
  if (data.isolationmode !== undefined && data.isolationmode !== null && Number(data.isolationmode) !== 2)
    throw fail('The plug-in assembly registration configuration is invalid.', '0x80044170');
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

// A plug-in package (dependent assemblies, Microsoft Learn): the content is a NuGet package; each lib/ assembly that declares
// an IPlugin type is registered as a pluginassembly row of the package (packageid, no strong name needed) with a plugintype row
// per plug-in type (workflow activities are not supported in packages). Registration inspects the bytes; a registered step
// runs them (plugin-uploaded.mjs, with the package's other lib/ assemblies as dependencies). Name and version can be changed
// (native trial captures n3-package, reproduced: PATCH 204, though Microsoft Learn says they are fixed); a package-owned
// assembly has sourcetype 4. An update that drops an assembly or type that steps use is refused, and the rows it drops
// otherwise are removed; 0x8004418b is the documented "required types / content cannot be updated" error.
function validatePackage({ store, data, existing, operation }) {
  const val = (column) => valueOf(data, existing, column);
  const content = typeof data.content === 'string' && data.content !== '' ? data.content : null;
  let facts = null;
  if (content)
    try {
      facts = inspectPackage(Buffer.from(content, 'base64'));
    } catch (error) {
      if (!(error instanceof InvalidAssembly)) throw error;
    }
  const contentError = () =>
    fail('Plug-in assembly does not contain the required types or assembly content cannot be updated.', '0x8004418b');
  const plugins = facts?.assemblies.filter((assembly) => assembly.types.some((type) => type.isPlugin)) ?? [];
  if (content && !plugins.length) throw contentError();
  if (operation === 'create' && facts) {
    if (val('name') == null || val('name') === '') data.name = facts.id;
    if (val('version') == null || val('version') === '') data.version = facts.version;
  }
  for (const column of ['name', 'version']) if (val(column) == null || val(column) === '') throw required(column);
  if (!facts) return;
  const packageId = String(existing?.pluginpackageid ?? (data.pluginpackageid ??= store.ids.uuid())).toLowerCase();
  const org = organizationOf(store);
  const next = new Map(plugins.map((assembly) => [assembly.name.toLowerCase(), assembly]));
  const pluginTypes = (assembly) => assembly.types.filter((type) => type.isPlugin).map((type) => type.fullName);
  const dropped = new Set();
  for (const assembly of assembliesOfPackage(store, packageId)) {
    const kept = next.get(String(assembly.name).toLowerCase());
    if (!kept) dropped.add(assembly);
    for (const type of typesOfAssembly(store, assembly.pluginassemblyid))
      if (!kept || !pluginTypes(kept).includes(type.typename)) {
        if (stepsOfType(store, type.plugintypeid).length) throw contentError();
        dropped.add(type);
      }
  }
  removePackageRows(store, packageId, (row) => dropped.has(row));
  for (const assembly of plugins) {
    const current = assembliesOfPackage(store, packageId).find(
      (row) => String(row.name).toLowerCase() === assembly.name.toLowerCase(),
    );
    const assemblyId = String(current?.pluginassemblyid ?? store.ids.uuid()).toLowerCase();
    const identity = {
      version: assembly.version,
      culture: assembly.culture,
      publickeytoken: assembly.publicKeyToken,
    };
    upsert(store, 'pluginassembly', 'pluginassemblyid', [
      {
        ...current,
        pluginassemblyid: assemblyId,
        name: assembly.name,
        ...identity,
        major: assembly.major,
        minor: assembly.minor,
        isolationmode: 2,
        sourcetype: 4,
        content: assembly.bytes.toString('base64'),
        packageid: packageId,
        organizationid: org,
      },
    ]);
    const types = typesOfAssembly(store, assemblyId);
    upsert(
      store,
      'plugintype',
      'plugintypeid',
      pluginTypes(assembly).map((typename) => {
        const type = types.find((row) => row.typename === typename);
        return {
          ...type,
          plugintypeid: String(type?.plugintypeid ?? store.ids.uuid()).toLowerCase(),
          typename,
          name: type?.name ?? typename,
          friendlyname: type?.friendlyname ?? typename,
          pluginassemblyid: assemblyId,
          assemblyname: assembly.name,
          ...identity,
          isworkflowactivity: false,
          organizationid: org,
        };
      }),
    );
  }
}

function validateType({ store, data, existing }) {
  const typename = valueOf(data, existing, 'typename');
  if (!typename) throw required('typename');
  const assemblyId = ref(data, existing, 'pluginassemblyid');
  if (
    assemblyId &&
    store
      .tableRows('plugintype')
      .some(
        (row) =>
          !same(row.plugintypeid, existing?.plugintypeid) &&
          same(row.pluginassemblyid, assemblyId) &&
          row.typename === typename,
      )
  )
    throw fail(
      'Multiple plug-in types from the same assembly and with the same typename are not allowed.',
      '0x8004417C',
    );
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
  const assembly = rowById(store, 'pluginassembly', 'pluginassemblyid', assemblyId);
  if (assembly)
    Object.assign(data, {
      assemblyname: assembly.name,
      version: assembly.version,
      culture: assembly.culture,
      publickeytoken: assembly.publickeytoken,
    });
  // With content, the type must be one of the assembly's plug-in or workflow activity types (native registration round 2:
  // a type that does not implement IPlugin is "not found" among them), and isworkflowactivity comes from it.
  if (assembly && typeof assembly.content === 'string' && assembly.content !== '') {
    const types = assemblyContent(assembly.content).types.filter((type) => type.isPlugin || type.isWorkflowActivity);
    const type = types.find((candidate) => candidate.fullName === typename);
    if (!type)
      throw fail(
        `PluginType [${typename}] not found in PluginAssembly [${assembly.name}, Version=${assembly.version}, Culture=${assembly.culture ?? 'neutral'}, PublicKeyToken=${assembly.publickeytoken ?? 'null'}] which has a total of [${types.length}] plugin/workflow activity types.`,
        '0x8004418b',
      );
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
  // The selected attributes must be columns of the step's table (native registration round 2).
  const table = rowById(
    store,
    'sdkmessagefilter',
    'sdkmessagefilterid',
    step.sdkmessagefilterid,
  )?.primaryobjecttypecode;
  if (table && table !== 'none') {
    const columns = columnsOf(store, table);
    const unknown = String(val('attributes') ?? '')
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .find((attribute) => attribute && !columns.has(attribute));
    if (unknown) {
      const imageId = String(
        existing?.sdkmessageprocessingstepimageid ?? (data.sdkmessageprocessingstepimageid ??= store.ids.uuid()),
      ).toLowerCase();
      throw fail(
        `The step image '${val('entityalias')}' (id '${imageId}') references attribute '${unknown}', which does not exist on entity '${table}'. This step image is entity-specific, so a required solution dependency is likely missing or incomplete. Verify that all dependent solutions are installed and that the attribute exists on the entity.`,
        '0x80081119',
      );
    }
  }
}

function validateStep({ store, principals, c, data, existing, operation }) {
  const val = (column) => valueOf(data, existing, column);
  // A managed level-zero (Microsoft registered) step is read-only (documented 0x8004419a); a local reading of the row's
  // flags, not publisher or ownership evidence.
  if (operation === 'update' && existing?.ismanaged === true && Number(existing.customizationlevel) === 0)
    throw fail('A Microsoft registered SDK message processing step cannot be modified.', '0x8004419a');
  const messageRefId = ref(data, existing, 'sdkmessageid');
  const filterRefId = ref(data, existing, 'sdkmessagefilterid');
  // Native error texts name the step; a create without a supplied id gets the id its row would take.
  const stepId = () =>
    String(
      existing?.sdkmessageprocessingstepid ?? (data.sdkmessageprocessingstepid ??= store.ids.uuid()),
    ).toLowerCase();
  const handler = handlerOf(data, existing);
  if (operation === 'create' && data.rank === undefined) data.rank = 1; // the Plug-in Registration Tool sends rank; the default is 1
  // Native accepts a step without a stage (registration round 2); when such a step runs is not captured.
  for (const [column, present] of [
    ['sdkmessageid', messageRefId],
    ['plugintypeid', handler.id],
  ])
    if (present == null || present === '') throw missing(column);
  const staged = val('stage') != null && val('stage') !== '';
  const stage = Number(val('stage')),
    mode = Number(val('mode') ?? 0),
    rank = Number(val('rank'));
  // A whole-number column: native's OData payload reader refuses a fractional rank before any rule runs.
  if (!Number.isInteger(rank))
    throw fail(
      `Error identified in Payload provided by the user for Entity :'sdkmessageprocessingsteps', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : Microsoft.OData.ODataException: Cannot convert the literal '${val('rank')}' to the expected type 'Edm.Int32'.`,
      '0x80048d19',
    );
  for (const [column, value, accepted] of [
    ['mode', mode, [0, 1]],
    ['supporteddeployment', Number(val('supporteddeployment') ?? 0), [0, 1, 2]],
  ])
    if (!accepted.includes(value))
      throw fail(
        `A validation error occurred. The value ${value} of '${column}' on record of type 'sdkmessageprocessingstep' is outside the valid range. Accepted Values: ${accepted.join(',')}`,
        '0x8004431a',
      );
  const message = rowById(store, 'sdkmessage', 'sdkmessageid', messageRefId);
  if (!message) throw notFound('sdkmessage', messageRefId);
  const messageName = message.name;
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
  if (staged && ![10, 20, 40].includes(stage)) throw fail(STAGE_TEXT, '0x80044184');
  if (mode === 1 && stage !== 40)
    throw fail(
      `Asynchronous steps are only supported in AfterMainOperationInsideTransaction stages and AfterMainOperationOutsideTransaction stage. SdkMessageProcessingStep name '${val('name') ?? ''}', id '${stepId()}'.`,
      '0x80040203',
    );
  // A filtered step needs an existing filter that allows custom steps (an unknown filter is 404); native does not check
  // that the filter belongs to the step's message (a Merge step on an Update filter is accepted). A step with no filter is
  // accepted on any existing message except those whose 'none' filter refuses unfiltered steps (NONE_FILTERS).
  const filter = rowById(store, 'sdkmessagefilter', 'sdkmessagefilterid', filterRefId);
  if (filterRefId && !filter) throw notFound('sdkmessagefilter', filterRefId);
  if (filter && filter.iscustomprocessingstepallowed !== true)
    throw fail(
      `Custom SdkMessageProcessingStep is not allowed on the specified message and entity. SdkMessageProcessingStepId: '${stepId()}', SdkMessageFilterId: '${filterRefId}'.`,
      '0x80044187',
    );
  if (!filter && NONE_FILTERS[messageName]?.[2] === false)
    throw fail(
      `Custom SdkMessageProcessingStep with Id: '${stepId()}' is not allowed on the message with SdkMessageId: '${String(message.sdkmessageid).toLowerCase()}'.`,
      '0x80044187',
    );
  // The supported deployment must agree with the availability of the step's filter (else its message): server-only (0)
  // takes deployment 0, client-only (1) deployment 1, both (2) any. A Solution's recorded availability wins. Checked before
  // the secure-configuration rule (native registration round 2 answers this error with secure configuration supplied).
  const sourced = store.state.dataverse?.pluginSourceAvailability?.[String(messageName).toLowerCase()];
  const availability = [
    sourced?.filters?.[filter?.primaryobjecttypecode ?? 'none'] ?? (filter ? filter.availability : undefined),
    sourced?.message ?? (filter ? undefined : message.availability),
  ];
  const deployment = Number(val('supporteddeployment') ?? 0);
  if ((deployment !== 0 && availability.includes(0)) || (deployment !== 1 && availability.includes(1)))
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
  pluginpackage: validatePackage,
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
    if (operation === 'delete') return guardDelete(store, logical, existing);
    VALIDATORS[logical]?.({ store, principals, c, data, existing, operation });
  };
}

// A custom API is a message: creating one (Web API, SOAP, the Plug-in Registration Tool) gives it its sdkmessage row and
// its filter, so steps can be registered on it; renaming, rebinding or deleting it replaces or removes them. The rows of the
// API's previous and current names are dropped, then the catalogue is reseeded (insert-or-replace by id).
function syncCustomApiMessages(api) {
  const { store } = api;
  const current = new Set(
    store
      .tableRows('customapi')
      .map((row) => row.uniquename)
      .filter(Boolean),
  );
  const previous = (store.state.dataverse?.customApiMessages ?? []).filter(Boolean);
  const registered = new Set(api.registry?.names?.() ?? []);
  const gone = new Set(
    previous.filter((name) => !current.has(name) && !PLATFORM_MESSAGES[name] && !registered.has(name)).map(messageId),
  );
  const touched = new Set([...previous, ...current].map(messageId));
  for (const [logical, idColumn, drop] of [
    ['sdkmessagefilter', 'sdkmessageid', touched],
    ['sdkmessage', 'sdkmessageid', gone],
  ]) {
    const table = store.state.tables[logical] ?? [];
    for (let i = table.length - 1; i >= 0; i--)
      if (drop.has(String(idOfValue(table[i][idColumn])).toLowerCase())) store.removeRow(logical, table, i);
  }
  seed(api);
}

// Registered by dataverse-extensions.mjs. Seeds the messages and filters; the hooks validate the seven registration tables.
export function install(api) {
  api.recordHooks.add('beforeWrite', registrationWrite(api));
  api.recordHooks.add('afterWrite', (_c, mapping) => {
    if (mapping.logicalName === 'customapi') syncCustomApiMessages(api);
  });
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
