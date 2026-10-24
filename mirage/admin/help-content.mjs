// Guidance text for every `/_sim/` view and panel and every `/_setup/` stage. Keys: `<view>`, `<view>.<panel>`,
// `<view>.<panel>.<field>`, `setup.<stage>` and `setup.<stage>.<field>`. Each entry is
// `{ intro, steps?, example?, doc?, fields? }`; `doc` is a repository path (optionally with an anchor) that the
// docs map resolves. Text states current behaviour from the cited guide. No imports, no DOM access.
const SIM = 'mirage/docs/sim-administration.md';
const OPS = 'mirage/docs/operations.md';
const LEVELS = 'mirage/docs/simulation-levels.md';
const PACKS = 'mirage/docs/data-packs.md';
const PERSONAS = 'mirage/docs/persona-catalog.md';
const CAPS = 'mirage/docs/capabilities-and-preflight.md';
const STORAGE = 'mirage/docs/storage-providers.md';
const MESSAGING = 'mirage/docs/messaging-and-outbox.md';
const FIXTURES = 'mirage/docs/service-fixtures.md';
const PROFILES = 'mirage/docs/deployment-profiles.md';
const EXPERIMENTS = 'mirage/docs/configuration-experiments.md';
const EVIDENCE = 'mirage/docs/runtime-evidence.md';
const DATAVERSE = 'mirage/docs/dataverse-api.md';
const STACK = 'mirage/docs/platform-stack.md';
const SETUP = 'docs/setup.md';
const CONFIG = 'docs/configuration.md';

/** Setup stages of the guided rail, in order; `setup.<id>` keys use these ids. */
export const SETUP_STAGES = Object.freeze([
  'project',
  'runtime',
  'sources',
  'environments',
  'packs',
  'personas',
  'simulation',
  'providers',
  'identity',
  'start',
]);

const OPERATION_MODES = {
  placeholder:
    'placeholder: not run locally. The request answers HTTP 501 (not implemented) and records a diagnostic. Counts as inventory level.',
  exported:
    'exported: runs the exported definition itself: the supported basic flow actions, or exported server-logic JavaScript you explicitly enabled, against local data. Counts as behaviour level.',
  mock: 'mock: answers the status and JSON body you enter, to test success, empty, validation or failure paths. The real logic does not run. Counts as contract level.',
  handler:
    'handler: a trusted JavaScript handler from a data pack supplies the business logic. Counts as behaviour level.',
  clr: 'clr: a plug-in step runs its original exported .NET assembly in a separate local process. Counts as behaviour level.',
  disabled: 'disabled: deliberately skipped; a trace records that choice. Counts as inventory level.',
};

const GRANTS = {
  client_credentials:
    'client_credentials: an application signs in as itself with a secret, certificate or federated assertion.',
  authorization_code:
    'authorization_code: a person signs in through the local sign-in page; public clients must send PKCE.',
  device_code: 'device_code: a person completes sign-in on the local device page.',
  refresh_token: 'refresh_token: trades a refresh token for a new access token.',
  password: 'password (ROPC): signs a user in with a password set in this view; a user without one is refused.',
  on_behalf_of:
    'on_behalf_of (jwt-bearer): a confidential application trades a user token for one of its own. Public clients cannot use it or client_credentials.',
};

const ACCESS_MODES = {
  'read-write': 'Read-Write (0): an ordinary interactive user.',
  administrative: 'Administrative (1): systemuser access mode value 1.',
  read: 'Read (2): systemuser access mode value 2.',
  'support-user': 'Support user (3): systemuser access mode value 3.',
  'non-interactive':
    'Non-interactive (4): application and SYSTEM users. Sign-in pickers list only interactive, enabled users.',
  'delegated-admin': 'Delegated admin (5): systemuser access mode value 5.',
};

const HELP = {
  // ---- Monitor
  dashboard: {
    intro:
      'A live map of what this local runtime runs and how busy each part is. It reads local state only and changes nothing.',
    steps: [
      'Read the status of each part: listening, ready, declared (configured, not started by Paqvilo), disabled, placeholder (answers 501), missing, error or planned.',
      'Select a part to see its facts and open the view that manages it.',
      'A moving connection means its counters changed since the previous refresh (every 5 seconds while the page is visible).',
      'Under Blocking, run preflight to see what your sources still need from this runtime.',
    ],
    doc: `${STACK}#scope-boundary`,
  },
  'dashboard.topology': {
    intro:
      'Columns read left to right: clients, hosts, the organization, providers and declared outside services. Paqvilo never starts outside processes; it declares them and probes them on loopback.',
    doc: `${STACK}#external-but-reachable`,
  },
  'dashboard.tiles': {
    intro:
      'Counters since this runtime started: portal and Dataverse requests, plug-in and flow runs, pending jobs, queued messages, captured outbox entries and diagnostics. The outbox never sends anything.',
    doc: `${MESSAGING}#outbox`,
  },
  'dashboard.activity': {
    intro:
      'The newest portal and Dataverse API requests, then diagnostics grouped by code. Request audit has filters and correlation.',
    doc: SIM,
  },
  'dashboard.blocking': {
    intro:
      'Preflight checks what your sources need from this runtime and which needs block. It probes declared local services, so it runs only when you ask; Strict makes every unmet requirement in scope blocking.',
    doc: `${CAPS}#preflight`,
  },
  'dashboard.configuration': {
    intro:
      'What this runtime was started with: runtime kind, simulation level, state file, data packs, Solution layers, configured settings and ports. Change them in /_setup/ and restart.',
    doc: `${SETUP}#during-a-preview`,
  },
  'dashboard.drawer': {
    intro:
      'Facts about the selected part: names, counts and status only. Secrets, connection strings and URL queries are never shown.',
    doc: STACK,
  },

  overview: {
    intro:
      'What this local runtime serves, where your changes are kept and where to go next. Nothing here changes a live environment.',
    steps: [
      'Check Runtime & persistence: it says whether record changes are kept and where.',
      'Open Data records or Scenarios to shape the local data.',
      'Change startup configuration in /_setup/ and restart the preview.',
    ],
    doc: SIM,
  },
  'overview.runtime': {
    intro:
      'Where this runtime keeps your changes. The simulation level decides it: dry run keeps record changes in memory only, simulation writes declared pack DATA files, deep simulation also allows new tables and columns. Change the level in /_setup/; it takes effect after a restart and never discards edits already made in memory.',
    doc: LEVELS,
  },
  'overview.metrics': {
    intro:
      'Counts from this runtime; select a card to open its view. Portal pages are routes found in the export. Plugin rules are the declarative rules of Plugins & presets, not exported plug-in steps (those are under Backend operations). Diagnostics are findings to review. Counting pages does not prove they render like the live portal.',
    doc: EVIDENCE,
  },
  'overview.workspace': {
    intro:
      'How this runtime answers requests: who renders pages, where data comes from and who this browser is signed in as. Startup choices (sources, state file, routing) come from the configuration file; edit it in /_setup/ and restart.',
    doc: `${SETUP}#configure-through-the-page`,
  },
  'overview.customize': { intro: 'Common next steps. Each changes local state of this runtime only.', doc: SIM },

  logs: {
    intro:
      'What this runtime does as it happens: requests, Liquid and data reads, plug-in rule evaluations, diagnostics and reloads. The stream runs only while this view is open; the page keeps the newest 500 entries and shows 20 per page by default.',
    fields: {
      request: 'request: a portal or API request with method, path, status and duration.',
      liquid: 'liquid: a Liquid or FetchXML read made while rendering a page.',
      data: 'data: a local data read or write.',
      plugin: 'plugin: the declarative plugin rules checked for a table operation.',
      diagnostic: 'diagnostic: a runtime finding with its code.',
      reload: 'reload: sources or configuration reloaded, so the runtime revision went up.',
      connected: 'connected: the log stream (re)connected at the shown revision.',
    },
    doc: SIM,
  },
  'logs.list': {
    intro: 'Filter by type or text. Pause holds new entries back so the list stops moving while you read.',
    fields: {
      type: 'Only entries of this type; Log types above explains each type.',
      search: 'Only entries whose path, table, code or message contains this text.',
    },
  },

  audit: {
    intro:
      'Every request this runtime answered, with who made it and how it ended. Request bodies, credentials, cookies and tokens are never stored. The ledger keeps the newest 1000 entries; the dropped count shows how many older ones fell off.',
    fields: {
      api: 'api: a portal Web API request.',
      'liquid-fetchxml': 'liquid-fetchxml: a FetchXML query issued from Liquid.',
      form: 'form: a basic or advanced form submission.',
      page: 'page: a rendered portal page.',
      'entity-read': 'entity-read: a read of one record.',
      'entity-query': 'entity-query: a query over a table.',
      outcome: 'Outcome: success, error, denied (a permission decision) or pending (still running).',
    },
    doc: SIM,
  },
  'audit.filters': {
    intro:
      'Narrow the list with any combination of filters. A correlation filter (from Inspect request) isolates the requests of one visitor action.',
    fields: {
      kind: 'Kind: the request type, such as api, liquid-fetchxml, form, page, entity-read or entity-query.',
      provider:
        'Provider: local requests answered by this runtime, or live requests passed to the connected environment.',
      outcome: 'Outcome: success, error, denied by a permission decision, or pending.',
      status: 'Status: the HTTP status class of the answer, or pending while running.',
      path: 'Path: requests whose path contains this text.',
      entity: 'Table: requests for this table logical name.',
      search: 'Search: free text over contact, table, path and error.',
    },
  },
  'audit.table': {
    intro: 'One row per request, newest first. Export filtered JSON keeps the rows you see as evidence.',
  },

  evidence: {
    intro:
      'What went wrong or was checked: runtime diagnostics, rendering evidence and the pages found in your export. Local evidence shows local behaviour on these sources; it does not prove the live site looks the same.',
    doc: EVIDENCE,
  },
  'evidence.diagnostics': {
    intro:
      'Findings grouped by code; open a group to see each one and where it happened. The guide of each area explains its codes, for example PROVIDER_* in storage providers, SERVICE_ENDPOINT_* in messaging, FLOW_* in operations, SECRET_* in deployment profiles and PACK_EXPORT_* in data packs.',
    doc: STACK,
  },
  'evidence.rendering': {
    intro:
      'Screenshots and comparisons captured for this runtime. A pass covers only the compared route, data, person and window size; report coverage and skipped cases with it.',
    doc: EVIDENCE,
  },
  'evidence.pages': {
    intro: 'Pages found in the portal export. Being listed here does not prove a page works; open it to exercise it.',
  },

  // ---- Data
  records: {
    intro:
      'The local records your portal pages, lists, forms and Web API calls read. Saving here follows the simulation level: dry run keeps changes in memory only, simulation writes declared pack DATA files and deep simulation also allows new tables and columns. A table without a pack DATA file is read-only, so its Create, Edit and Delete are switched off.',
    steps: [
      'Pick a table under Entity.',
      'Search or page through its records.',
      'Create, Edit or Delete opens a JSON editor; saving applies the change to local data at once. Backend plugin rules run; portal table permissions do not.',
    ],
    doc: `${LEVELS}#declare-existing-writable-data`,
  },
  'records.table': {
    intro: 'The records of the selected table. The search matches any column value.',
    fields: {
      entity: 'The table whose local records are listed below (its logical name).',
      search: 'Lists the records whose column values contain this text.',
    },
  },
  'records.editor': {
    intro: 'Edit the record as JSON with logical column names. Authorization still runs before a write commits.',
    example: '{\n  "x_name": "Invented item",\n  "statecode": 0\n}',
  },

  packs: {
    intro:
      'Data packs are trusted JavaScript modules of your project (pack/<id>.mjs) that add presets, test people, handlers, providers and DATA files. A registered pack is in use only when it matches this portal; one that matches nothing contributes nothing.',
    steps: [
      'Write pack/<id>.mjs in your project (see the example).',
      'Register it in /_setup/ (Data packs) or under dataPacks in the configuration file.',
      'Restart the preview: packs load at startup only.',
      'Check it here: Matched, exports, presets and diagnostics.',
    ],
    example:
      "export default {\n  id: 'invented-data',\n  name: 'Invented data',\n  description: 'Project-owned development data',\n  matches: () => true,\n  presets: () => ({}),\n};",
    doc: PACKS,
  },
  'packs.registered': {
    intro:
      'One row per registered pack: whether it matched this portal and what it adds. Details lists its exports, presets, persona catalogue counts, DATA files and PACK_EXPORT_* diagnostics.',
    doc: `${PACKS}#recognised-exports`,
  },
  'packs.presets': {
    intro:
      'Every data preset this runtime can apply, with where it comes from: a pack, a built-in generic preset (empty-local, open-sandbox, strict-permissions, contact-demo) or one saved in this runtime. Apply them under Plugins & presets; applying changes local data.',
    doc: PACKS,
  },
  'packs.lifecycle': {
    intro:
      'Packs change in Project setup, never here. Loading a pack runs its JavaScript, so register only modules you trust; setup checks that the file exists and never runs it.',
    steps: ['write', 'register', 'restart', 'verify'],
    doc: PACKS,
  },
  'packs.configuration-presets': {
    intro:
      'A pack may export configurationPresets (at most 100). They are listed beside built-in and saved presets, marked with their pack, and cannot be edited or deleted here.',
    doc: `${PACKS}#pack-configuration-presets`,
  },
  'packs.diagnostics': {
    intro:
      'Problems found in this pack’s exports. PACK_EXPORT_UNKNOWN flags an unrecognised export name (often a typo); the pack still loads. PACK_EXPORT_PENDING flags an export whose owning module has not loaded, so only its shape was checked.',
    doc: `${PACKS}#recognised-exports`,
  },

  plugins: {
    intro:
      'Simple backend rules and data presets for this runtime. A plugin rule checks or fills fields when records of a table are created, updated or deleted through this runtime; a preset loads a repeatable set of records and rules in one step. Exported Solution plug-in steps are under Backend operations.',
    doc: SIM,
  },
  'plugins.plugins': {
    intro:
      'Each rule names a table, the operations it runs on and what it does: validate (require or check fields), defaults (fill empty fields), set (always set fields) and secondary (follow-up changes).',
    example:
      '{\n  "name": "Require item name",\n  "entity": "x_item",\n  "enabled": true,\n  "operations": ["create", "update"],\n  "validate": [{ "field": "x_name", "required": true, "message": "Name is required." }],\n  "defaults": {},\n  "set": {},\n  "secondary": []\n}',
  },
  'plugins.presets': {
    intro:
      'A preset (also called a data preset) is a named set of records and rules you can apply again and again. It seeds tables and can set mappings, permissions, plugin rules and settings. Presets come from packs, the generic built-ins or this runtime; Data packs shows where each comes from.',
    example:
      '{\n  "name": "Invented item",\n  "tables": { "x_item": [{ "x_itemid": "11111111-1111-4111-8111-111111111111", "x_name": "Demo" }] },\n  "mappings": { "x_item": { "entitySet": "x_items", "idColumn": "x_itemid" } }\n}',
    doc: PACKS,
  },
  'plugins.apply': {
    intro:
      'Applying a preset replaces the records and rules it supplies in local data. A portal business-data preset keeps the organization-owned tables it omits, staff grants, credentials and imported schema. Its linked configuration preset is applied only when you tick the box.',
    doc: `${PACKS}#pack-configuration-presets`,
    fields: {
      preset: 'The data preset to apply: it replaces the records and rules it supplies in local data.',
      configuration:
        'Also applies the configuration preset the data preset links to, which replaces platform rules and setting/snippet overrides.',
    },
  },

  mappings: {
    intro:
      'How each table is reached through the Web API: its entity set name, its primary ID column and its relationships. Imported Solution metadata supplies many of them; add a mapping for a table it misses, using the names from your export.',
    doc: SIM,
  },
  'mappings.table': {
    intro: 'One mapping per table; its ID is the table logical name. Relationships let linked queries resolve.',
    example:
      '{\n  "logicalName": "x_item",\n  "entitySet": "x_items",\n  "idColumn": "x_itemid",\n  "relationships": {}\n}',
  },
  'mappings.solution-metadata': {
    intro:
      'What the selected Solution folders supplied: forms, views, tables, relationships and unresolved references. These counts show available metadata, not that layouts match the live app. Restart with repeatable --solution-root PATH arguments to change the folders.',
    doc: 'mirage/docs/bootstrap-and-sources.md',
  },
  'mappings.schema-overrides': {
    intro:
      'Your own form and list definitions for components the imported Solutions do not resolve. They change local rendering only.',
  },
  'mappings.rich-text': {
    intro:
      'Rich-text editor settings captured from the reference portal and used while the mapped source file is unchanged.',
  },
  'mappings.stylesheets': {
    intro:
      'Stylesheet versions captured (observed) from the reference portal and used while the mapped source is unchanged.',
  },
  'mappings.snippet-compositions': {
    intro:
      'Snippet combinations captured (observed) from the reference portal. Observing checks that a native empty state is an existing local snippet plus an existing exported action; both source hashes and the portal origin bind it, and local edits win. Capturing reads the intended signed-in reference browser and stores no tokens.',
  },

  endpoints: {
    intro:
      'Your own answers for chosen request paths. A local endpoint answers with the status and body you enter; a live endpoint sends that request to the connected environment, and writes there still need explicit permission.',
    doc: SIM,
  },
  'endpoints.table': {
    intro: 'Each endpoint matches one request path and HTTP method.',
    example:
      '{\n  "path": "/api/example",\n  "method": "GET",\n  "mode": "local",\n  "status": 200,\n  "body": { "value": [] }\n}',
  },

  // ---- Platform
  services: {
    intro:
      'The outside services your organization uses and their local stand-ins: storage, the local message bus, the outbox, connections, secret references, local services you run yourself and service fixtures. Only names, counts and status are shown; secrets and connection strings never are.',
    steps: [
      'Check each provider is ready or declared as expected.',
      'Probe declared local services with preflight (Infrastructure, Blocking).',
      'Change providers in /_setup/ (Providers & services) and restart.',
    ],
    doc: STACK,
  },
  'services.storage': {
    intro:
      'Where file bytes go: Dataverse files and images, notes and attachments, portal web files, cloud attachments and SharePoint documents. Without a state directory bytes stay in memory and are lost on restart; with one they are kept on local disk under it. Azurite is used through its Blob REST API once its connection string is set; Paqvilo never starts it.',
    doc: `${STORAGE}#routes`,
  },
  'services.messaging': {
    intro:
      'The local message bus: first in, first out per queue, a 60 second lock while a message is read, retries and dead-lettering. Service endpoints (contracts 2, 5 and 6) send to the queue mapped under providers.messaging.endpoints; an unmapped endpoint records SERVICE_ENDPOINT_UNMAPPED. Purging a queue cannot be undone.',
    doc: `${MESSAGING}#local-message-bus`,
  },
  'services.outbox': {
    intro:
      'Email, Teams and Outlook messages your flows and pages would send, captured here for inspection; the outbox never sends anything. Filter by correlation id, channel or time; only the newest entries are kept (1000 by default).',
    doc: `${MESSAGING}#outbox`,
    fields: {
      channel:
        'Only entries captured for this channel: email, teams, outlook or portal-email. Any channel lists all of them.',
    },
  },
  'services.connectors': {
    intro:
      'The connector providers flow actions can use (dataverse, http, fixture, pack:<id>, memory-queue, approvals) and the project connections they resolve to. An action resolves connection reference, then connection id, then connections entry, then provider; any missing link is a coded error, never a silent success.',
    doc: `${OPS}#connections-and-connectors`,
  },
  'services.secrets': {
    intro:
      'Secret references by name, whether each is bound, and where its value comes from (an environment variable or a Windows DPAPI-protected value). Paqvilo never contacts Key Vault and never shows a secret value.',
    doc: `${PROFILES}#environment-variable-types-effective-values-and-secrets`,
  },
  'services.local-services': {
    intro:
      'Services you run yourself on this computer, such as Azure Functions, Azurite or the Service Bus emulator. Paqvilo declares and probes them and never starts them; a probe is one GET with a 2 second timeout and no redirects.',
    example:
      'localServices:\n  functions: { kind: http, baseUrl: "http://localhost:7071", probe: "/admin/host/status", required: false }',
    doc: `${OPS}#local-services`,
  },
  'services.service-fixtures': {
    intro:
      'Power BI, AI Builder, Copilot and Dynamics apps are never run here. Each operation answers a trusted pack fixture (canned answer) or the ServiceDisabled error; the first disabled answer records SERVICE_FIXTURE_DISABLED.',
    doc: `${FIXTURES}#disabled-by-default-services`,
  },
  'services.powerfx': {
    intro: 'Power Fx formulas answer at contract level until a pack registers an adapter (powerFx export).',
    doc: 'mirage/docs/canvas-apps.md',
  },
  'services.apps': {
    intro: 'Canvas apps are listed from your sources; code apps answer at contract level.',
    doc: STACK,
  },
  'services.sharepoint': {
    intro:
      'SharePoint document locations store their files through the sharepointDocuments storage route; the SharePoint and Graph REST API is served only for a declared connection.',
    doc: 'mirage/docs/sharepoint.md',
  },

  flows: {
    intro:
      'Power Automate flow runs, the runs waiting for an approval, delay or webhook, and background jobs. Answering a wait resumes its run.',
    doc: `${OPS}#flow-runs-waits-and-approvals`,
  },
  'flows.runs': {
    intro:
      'Flow runs, newest first, filtered by flow (process id) and status. Details shows the run’s action journal (each action with status and outputs), never its trigger input or secure outputs. The newest 200 runs are kept, with the journals of the newest 50 finished runs.',
    doc: `${OPS}#flow-runs-waits-and-approvals`,
    fields: { status: 'Only runs in this status. Any status lists every run that is kept.' },
  },
  'flows.journal': {
    intro:
      'The actions this run executed, with status and outputs. Secure outputs show as secure only. Trigger input is dropped when the run ends; the newest 200 runs and the journals of the newest 50 finished runs are kept.',
    doc: `${OPS}#flow-runs-waits-and-approvals`,
  },
  'flows.waits': {
    intro:
      'Runs paused on an approval, a delay or a webhook. Answer an approval with Approve or Reject, or a delay or webhook wait with outputs JSON; the run is then scheduled to resume (202). Overdue compares each timeout with the runtime clock.',
    example: '{ "outcome": "Approve", "responder": "reviewer@example.test", "comments": "Looks right" }',
    doc: `${SIM}#flow-runs-and-waits`,
    fields: {
      state:
        'Pending lists waits whose timeout has not passed; Overdue lists waits past their timeout on the runtime clock.',
      comments: 'Optional text returned with the approval outcome as the responder comments.',
    },
  },
  'flows.background': {
    intro:
      'Work that runs after a save is committed: asynchronous plug-in steps and flow trigger runs, one after another in order. A job error does not change the answer the original request already got. Ready runs saved in the state file resume once after a restart.',
    doc: `${OPS}#execution-boundary`,
  },
  'flows.webhooks': {
    intro:
      'Webhook service endpoints (contract 8) are called only when their host is on this computer (loopback); other hosts are never contacted. Hosts are shown by name only, never with a URL query or auth value.',
    doc: `${MESSAGING}#service-endpoint-delivery`,
  },

  capabilities: {
    intro:
      'How far this runtime really runs each part of your sources, and what your sources still need. Each part has a level, from lowest to highest: inventory (listed only), contract (right answer shape from a fixture or mock), behaviour (runs the real logic) and native-qualified (also compared with a real environment). A placeholder or a mock never counts as behaviour.',
    fields: {
      inventory:
        'inventory: listed from source; nothing runs it, or it answers a placeholder or a documented 501 or diagnostic.',
      contract:
        'contract: request and response shapes are right, but the answer comes from a fixture, a mock, a declared-only adapter or a reduced rule set.',
      behaviour: 'behaviour: this runtime runs the documented behaviour.',
      'native-qualified':
        'native-qualified: behaviour, also compared with a native environment in at least one named scenario.',
    },
    doc: `${CAPS}#fidelity-levels`,
  },
  'capabilities.report': {
    intro:
      'Every capability record of this runtime with its kind, level and source. Backend operation modes map to levels: placeholder and disabled to inventory, mock to contract, exported, handler, clr and webhook to behaviour.',
    doc: `${CAPS}#capability-records`,
    fields: { level: 'Only records at this level: inventory, contract, behaviour or native-qualified.' },
  },
  'capabilities.missing': { intro: 'Prerequisites that no registered record provides.', doc: `${CAPS}#registry-api` },
  'capabilities.inventory': {
    intro:
      'Solution components Paqvilo reads but does not host (canvas apps, custom controls, custom connectors and others), counted by component kind with the level each reports.',
    doc: 'mirage/docs/bootstrap-and-sources.md#solution-inventory',
  },
  'capabilities.offline': {
    intro:
      'Staff sessions that used mobile offline in a model-driven app: mode, last sync, downloaded tables, pending changes, conflicts and errors. Switch the mode and synchronize from the Online/Offline button in the app header.',
    doc: 'mirage/docs/model-driven-apps.md#routes',
  },
  'capabilities.unsupported': {
    intro:
      'Records and operations below behaviour level, so this runtime does not run their real logic. A record keeps the reason it states.',
    doc: `${CAPS}#registry-api`,
  },
  'capabilities.preflight': {
    intro:
      'Preflight checks which requirements of your sources this runtime meets and which block. Limit it with requirement ids or patterns (for example cloud-flow:*, table:x_item); Strict makes every unmet requirement in scope blocking. The report never includes configured values.',
    example: '{ "id": "approval-flow", "requires": ["cloud-flow:*", "table:x_item"] }',
    doc: `${CAPS}#preflight`,
  },

  operations: {
    intro:
      'The server-side logic of your sources and how this runtime answers each one: exported server logic, cloud flows, Solution workflows and plug-in steps. A local choice changes this runtime only; it never deploys the source or switches on an online flow. Use source default removes your local choice.',
    fields: OPERATION_MODES,
    doc: `${OPS}#choose-local-behavior`,
  },
  'operations.list': {
    intro:
      'One row per operation; Edit opens its local behaviour below. Imported routes keep their exported web-role checks, also when the answer is mocked, and a workflow without a portal link gets no invented route or grant. Unknown outside flow actions need an explicit mock or disabled choice; portal roles and backend identities are separate.',
    doc: `${OPS}#execution-boundary`,
  },
  'operations.mode': {
    intro: 'Choose how this operation answers locally.',
    fields: OPERATION_MODES,
    doc: `${OPS}#choose-local-behavior`,
  },
  'operations.mode.mock': {
    intro: 'Set the response status and body.',
    example: '{ "status": 200, "body": { "value": [] } }',
  },
  'operations.mode.exported': {
    intro:
      'Exported code runs with time limits, not in a sandbox for untrusted code. Enable it only for sources you trust.',
    doc: `${OPS}#local-services`,
  },

  environment: {
    intro:
      'The environment this runtime pretends to be: reference environments to read from, the deployment profile, environment variables and reference enrichment. Profiles map files you already have; Paqvilo does not run PAC, upload, deploy or synchronize.',
    doc: PROFILES,
  },
  'environment.references': {
    intro:
      'Reference environments come from the configuration file. Selecting one sets the address used for live routing and enrichment; it never connects by itself, and reads are read-only through the intended signed-in browser.',
  },
  'environment.profile': {
    intro:
      'A deployment profile swaps in the per-environment pages, variables and connection references your project maps, pinned in this portal’s local state. Configure profiles under mirage.deploymentProfiles; profiles apply locally and do not identify a deployed commit.',
    doc: PROFILES,
  },
  'environment.variables': {
    intro:
      'Solution environment variables and the value each one has here. Effective values, lowest first: definition default, Solution value, selected profile, project environmentVariables, then the local value you set here or a persona sets; the local value wins for this runtime until you reset it.',
    fields: {
      secret:
        'Secret (100000005): the value is a Key Vault reference, never the secret. Server logic reads null and records SECRET_NOT_EXPOSED_TO_SERVER_LOGIC; the project secrets map binds the reference to an environment variable or a DPAPI-protected value.',
    },
    doc: `${PROFILES}#environment-variable-types-effective-values-and-secrets`,
  },
  'environment.enrichment': {
    intro:
      'Copies selected records from the reference environment into local data. A plan lists FetchXML reads (entity, fetchXml, optional pageSize, maxPages and mode merge or replace); Validate checks it without reading the reference, and Run copies complete pages through the connected browser identity in one change.',
  },
  'environment.project': { intro: 'The project files this runtime resolved. Edit them through /_setup/.' },

  platform: {
    intro:
      'Organization and platform limits this runtime enforces, such as the link-entity (join) budget and attachment restrictions, which you can change for an experiment. Each row says who changes it in a real environment (a support request, an organization setting, the catalogue only, a simulator experiment or a safety bound); changes stay in this runtime’s state and never reach a connected organization.',
    doc: `${EXPERIMENTS}#settings-catalogue`,
  },
  'platform.presets': {
    intro:
      'A configuration preset sets platform rules and setting/snippet overrides in one step. Data, identities, web roles, page access rules and backend operation choices stay as they are; built-in and pack presets cannot be edited or deleted. Applying one is a local experiment, not proof that a real support change was approved.',
    doc: `${EXPERIMENTS}#presets-and-concurrent-instances`,
    fields: {
      select:
        'The configuration preset to apply, export or delete; built-in and pack presets can be applied but not deleted.',
      name: 'Display name of the new preset saved from the current overrides.',
      id: 'Identifier of the new preset: up to 80 letters, digits, hyphens or underscores, starting with a letter or digit.',
      import: 'A preset as JSON, for example one exported from another runtime; importing saves it in this runtime.',
    },
  },
  'platform.settings': {
    intro:
      'Each limit with its source and effective value. A local override wins over the organization row and the catalogue default for this runtime; it does not configure a connected Dataverse organization.',
    doc: EXPERIMENTS,
  },

  overrides: {
    intro:
      'Site settings and content snippets: the exported value next to the value pages use now. Edit, add or remove a value locally, or reset it, without changing your source files. Values stay text, as on the portal; a null value removes the local effective value.',
    doc: EXPERIMENTS,
  },
  'overrides.presets': {
    intro:
      'The same configuration presets as Platform rules. Run independent experiments in separate runtimes with their own state files and ports; do not share a writable state file.',
    doc: `${EXPERIMENTS}#presets-and-concurrent-instances`,
  },
  'overrides.settings': {
    intro: 'Site settings that pages and Liquid read; true/false values have a one-click Set True or Set False.',
  },
  'overrides.snippets': {
    intro:
      'Content snippets that pages show. A local value for a snippet name covers every language; Reset restores each source translation.',
  },

  portal: {
    intro:
      'The local portal’s site settings, content snippets, web roles and page access rules. Changes stay in this runtime and portal pages pick them up; Platform rules and Settings & snippet overrides cover the same values for experiments, and this page adds roles and page access.',
    doc: EXPERIMENTS,
  },
  'portal.settings': { intro: 'Site settings that pages and Liquid read, held in local state.' },
  'portal.snippets': { intro: 'Content snippets that pages show, held in local state.' },
  'portal.roles': {
    intro: 'Web roles of the local portal. Assign roles to contacts under Portal identity & permissions.',
  },
  'portal.access-rules': { intro: 'Rules that restrict or grant pages to web roles.' },

  // ---- Identity
  access: {
    intro:
      'Who you are on the portal while testing: sign this browser in as a test person (a persona: a local contact with its web roles) and see what that person may read and change. Portal requests start anonymous; a sign-in sets a cookie for this browser and this runtime only. Portal table permissions never apply to the Dataverse API.',
    doc: SIM,
  },
  'access.session': {
    intro:
      'Portal pages opened in this browser use this sign-in. Other browsers, including the toolkit browser, keep their own, and the sign-in page default below does not change it.',
    doc: SIM,
  },
  'access.personas': {
    intro:
      'Pick a contact and save its web-role memberships; the account comes from that contact’s parent customer. The sign-in page default is the person the local sign-in page offers first; catalogue metadata describes people but never creates records or grants permissions.',
    doc: PERSONAS,
  },
  'access.catalogue': {
    intro:
      'The persona catalogue groups test people and describes why each exists. State entries win; among packs the first registered definition wins. A preset that supplies a catalogue replaces state metadata. Import replaces state metadata, Export writes the effective catalogue and Reset removes only state metadata.',
    fields: {
      runtimes:
        'Isolated runtimes: a context (a persona setup with its own preset, profile or overrides) or a scenario with a preset starts a copy with its own cookie, state and loopback address. At most four copies by default (personaContexts.maxInstances, 0 to 32; 0 turns launches off). Copies share the Node process and stop with their parent.',
    },
    doc: `${PERSONAS}#storage-and-precedence`,
  },
  'access.external-identities': {
    intro:
      'The external sign-in record each contact uses with the exported identity provider, simulated locally. Nothing copies live credentials or issues real environment tokens.',
    doc: SIM,
  },
  'access.create-persona': {
    intro:
      'Creates a new invented contact in local data with the web roles you tick. Backend plugin rules apply to the contact record.',
  },
  'access.session-override': {
    intro:
      'Replaces the web roles of this browser’s sign-in with role names you type, for quick role tests. It needs a real sign-in first and ends when you sign out or in again.',
  },
  'access.manual-identity': {
    intro:
      'The identity scripts and tests use when they send no browser cookie, and the default person the sign-in page offers. Saving it overrides contact memberships with the role names entered here for that identity.',
    doc: SIM,
  },
  'access.permissions': {
    intro:
      'What the signed-in person can reach, grant by grant: table, scope, operations, roles and how many local records each grant opens. A child grant needs an accessible parent record; unresolved relationships, parent cycles and missing roles stay disabled. Apply grant source also switches enforcement on.',
    fields: {
      source:
        'Which table permission grants count: your local rules, the grants imported from the portal export, or imported grants plus local additions.',
    },
  },
  'access.raw-permissions': {
    intro: 'Table permissions as JSON: table, operations, roles and scope.',
    example:
      '{\n  "entity": "x_item",\n  "operations": ["read"],\n  "roles": ["Authenticated Users"],\n  "scope": "global"\n}',
  },
  'access.presets': { intro: 'Apply a data preset; it changes local data.', doc: PACKS },

  dataverse: {
    intro:
      'The local organization behind model-driven apps and the Dataverse Web API: who staff are, which applications may get tokens, and the requests they made. Staff administration works with the HTTP API off; switch the listener on in /_setup/ and restart when an outside client needs it. Security roles never apply to the portal.',
    doc: `${DATAVERSE}#administration`,
  },
  'dataverse.staff-session': {
    intro:
      'Choose which staff user model-driven pages in this browser run as, or the local administrator. Reads, lookups and writes then use that user’s security roles and field security. Portal personas and API application tokens are separate identities, and the local administrator is an explicit development bypass. An invalid, disabled or expired choice fails without giving more access.',
    doc: `${DATAVERSE}#administration`,
    fields: {
      user: 'The staff user that model-driven pages opened in this browser use; only eligible interactive users are listed.',
    },
  },
  'dataverse.secret': {
    intro:
      'A new secret is shown once. Dismissing it, leaving the view or reloading drops it; listings show only its first characters afterwards.',
  },
  'dataverse.applications': {
    intro:
      'Applications that may ask this local organization for tokens, with their secret hints, certificate thumbprints and allowed sign-in methods (grant types). Removing a registration removes its application user.',
    fields: GRANTS,
    doc: `${DATAVERSE}#token-behaviour`,
  },
  'dataverse.applications.grants': {
    intro: 'Grant types an application may redeem.',
    fields: GRANTS,
    doc: `${DATAVERSE}#token-behaviour`,
  },
  'dataverse.users': {
    intro:
      'People and applications known to the local organization, with their security roles. Privilege depth (Basic, Local, Deep, Global) decides which rows a caller reaches; sharing adds rights but never opens a table the roles do not grant. A password is 8 to 256 characters, stored hashed and never returned.',
    fields: ACCESS_MODES,
    doc: `${DATAVERSE}#users-roles-and-privileges`,
  },
  'dataverse.users.accessmode': { intro: 'The systemuser access mode.', fields: ACCESS_MODES },
  'dataverse.workflows': {
    intro: 'Classic Solution workflows and how each runs locally.',
    doc: `${DATAVERSE}#workflows`,
  },
  'dataverse.environment': { intro: 'Organization settings that take effect on the next request, without a restart.' },
  'dataverse.register': {
    intro:
      'Register an application that will ask for tokens. A public client uses only the authorization code, device code, refresh token and password grants; redirect URIs must be http(s) URLs.',
    doc: `${DATAVERSE}#endpoints`,
  },
  'dataverse.certificates': {
    intro:
      'Add an X.509 certificate PEM or a bare public key for an application. Its SHA-1 and SHA-256 fingerprints become x5t and x5t#S256 for client assertions.',
    doc: `${DATAVERSE}#endpoints`,
  },
  'dataverse.federated': {
    intro:
      'Let tokens from an outside issuer sign in as an application (workload identity federation). A client assertion must match issuer, subject and audience and is checked against the issuer’s keys; a duplicate issuer and subject is refused.',
    doc: `${DATAVERSE}#managed-identity-and-federated-credentials`,
  },
  'dataverse.managed-identities': {
    intro:
      'Azure-style managed identities that get tokens from this runtime’s managed identity endpoint; each is an application user. managedIdentity.mode picks the endpoint shape: appservice, imds or arc.',
    doc: `${DATAVERSE}#managed-identity-and-federated-credentials`,
  },
  'dataverse.requests': {
    intro: 'The most recent Web API requests, newest first. Tokens, secrets and bodies are never recorded.',
  },
  'dataverse.reset': {
    intro:
      'Restores the imported defaults: registrations and user passwords are kept, the security tables are seeded again, so users created here are removed.',
    doc: `${DATAVERSE}#endpoints`,
  },
  'dataverse.connect': {
    intro:
      'Addresses for SDK clients and tools: organization URL, token endpoint, scope and, when on, the TDS (SQL) endpoint.',
    doc: `${DATAVERSE}#connect-an-sdk`,
  },
  'dataverse.status': {
    intro: 'Whether the organization and its HTTP API are available, with the addresses and IDs clients need.',
  },

  scenarios: {
    intro:
      'A scenario switches several choices at once. Three different things are called scenarios: saved scenarios here bundle a data preset, a test person and permission enforcement into one local change; catalogue scenarios (from the persona catalogue) sign a persona in and may start an isolated copy; preflight scenario files ({ id, requires }) limit a capability check run from the command line.',
    doc: `${PERSONAS}#isolated-contexts-and-scenarios`,
  },
  'scenarios.saved': {
    intro:
      'Scenarios saved in this runtime; Apply switches to one in a single local change. They survive reset and import and live in local state, not in configuration files.',
    example:
      '{\n  "id": "example-scenario",\n  "name": "Example",\n  "preset": null,\n  "persona": { "contactId": "11111111-1111-4111-8111-111111111111" },\n  "permissionMode": "enforce",\n  "permissionSource": "combined"\n}',
  },
  'scenarios.catalogue': {
    intro:
      'Named persona and setup pairs from the persona catalogue. The context comes from the scenario, else its persona; the preset from the scenario, else its context. A scenario with a preset or context starts or reuses an isolated copy.',
    doc: `${PERSONAS}#isolated-contexts-and-scenarios`,
  },
  'scenarios.preflight': {
    intro:
      'A preflight scenario file lists requirement ids or patterns; run it with paqvilo mirage preflight --scenario FILE.',
    doc: `${CAPS}#scenario-file`,
  },
  'scenarios.save': {
    intro:
      'Choose what the scenario changes; parts left on keep stay as they are when it is applied. Applying runs the preset first (it replaces the tables it defines), so the person must exist afterwards. In JSON, permissionMode is enforce or permissive, permissionSource is configured, exported or combined, and persona null means an anonymous visitor.',
  },
  'scenarios.reset': {
    intro:
      'Restores the imported records, configuration, identity and permissions of this workspace. Saved scenarios are kept.',
  },

  // ---- Runtime
  runtime: {
    intro:
      'The state of this runtime: where changes are kept, which code and sources are loaded, and copies of the local state. Export, import and reset act on local state only; import replaces the whole local state (saved scenarios are kept).',
    doc: LEVELS,
  },
  'runtime.persistence': {
    intro:
      'Where this runtime keeps your changes. Dry run keeps record edits, local registrations and password or secret hashes in memory; persistent levels need a private state file under the ignored .paqvilo/ folder, and writes to undeclared business tables fail with SimulationDataTargetRequired.',
    doc: `${LEVELS}#private-runtime-and-identity-state`,
  },
  'runtime.fingerprints': {
    intro:
      'Fingerprints of the loaded sources and runtime code. Restart to load edited runtime code; never read a deployed commit from them.',
  },
  'runtime.state': {
    intro:
      'Copy, replace or reset the local state of this runtime. Nothing here touches your source files or a live environment.',
  },

  connection: {
    intro:
      'Whether requests stay local or go to a live reference environment, which signed-in browser reads it, and captures of its page shell and static files. Live creates, updates and deletes cannot leave this runtime without --allow-live-writes and the switch below.',
    doc: SIM,
  },
  'connection.routing': {
    intro: 'Choose which requests this runtime answers and which go to the reference. Saved routing is runtime state.',
  },
  'connection.browser': {
    intro:
      'The signed-in browser used for reference reads. Credentials and MFA stay with you; tokens are never stored.',
  },
  'connection.shell': {
    intro:
      'Captures the page shell (stylesheets and scripts around your templates) from one live page for local rendering. A complete capture replaces the current shell stylesheet and script order; a failed capture leaves it unchanged. It copies no business data and does not prove rendering parity.',
  },
  'connection.assets': {
    intro:
      'Copies chosen static portal files (styles, scripts, images or fonts) into the ignored local asset cache. Portal files come through the connected browser; approved public platform CDN files are fetched anonymously. Enter one portal-relative path per line.',
  },
  'connection.shell-resources': {
    intro:
      'The stylesheet and script order placed around local page templates, as captured (observed) from the reference.',
  },
  'connection.baselines': {
    intro: 'Rich-text and stylesheet baselines and snippet combinations captured from the reference.',
  },

  // ---- Setup stages
  setup: {
    intro:
      'The local setup workspace edits configuration files only. It never deploys, synchronizes, runs PAC, reads live references, imports packs or authorizes live writes. Saves apply on the next preview start.',
    doc: SETUP,
  },
  'setup.project': {
    intro:
      'Paqvilo keeps your choices in one settings file in this folder (paqvilo.config.yml, or a project file). It can hold several projects; each runs as its own preview.',
    steps: [
      'Create the settings file, or open the existing one.',
      'Items marked next step (example addresses, folders still to choose) are what to do next, not errors.',
    ],
    doc: `${SETUP}#configure-through-the-page`,
  },
  'setup.project.templates': {
    intro:
      'Example setups with invented names and example.test origins: Power Pages portal, Model-driven app project, Dataverse API only, and Full stack sample (storage routes, memory messaging, outbox, a fixture connection, secret references, a declared local service, persona contexts and deployment profiles). paqvilo mirage demo copies the shipped example project.',
  },
  'setup.project.layers': {
    intro:
      'Settings resolve, highest first: CLI options, shell PAQVILO_* variables, .env beside the catalogue, paqvilo.config.local.yml (personal layer), the shared catalogue. Use the shared layer for team configuration and the personal layer for local overrides; deleting a personal override reveals the shared value.',
    doc: `${CONFIG}#personal-settings-and-worktrees`,
  },
  'setup.runtime': {
    intro:
      'Tick everything you want: your Power Pages website, model-driven apps, canvas apps and the Dataverse Web API. Apps are built from your exported Solutions; the website from your website export.',
    doc: 'mirage/docs/standalone-organization.md',
  },
  'setup.runtime.kind': { intro: 'power-pages, model-driven or dataverse-api.' },
  'setup.runtime.defaultApp': { intro: 'The default application GUID for a model-driven surface only.' },
  'setup.runtime.trustedExtensions': {
    intro:
      'modelDriven.trustedExtensions: true runs supported form scripts, commands and PCF controls. Enable it only for sources you trust.',
  },
  'setup.sources': {
    intro:
      'The website export is the folder you downloaded your site into (pac pages download); a Solution folder is an exported and unpacked Solution (pac solution unpack). Paths are relative to the project folder; absolute paths work too. Paqvilo never changes these files.',
    doc: `${CONFIG}#select-a-catalogue`,
  },
  'setup.environments': {
    intro:
      'Live environments are optional: only Lense uses them, to show your local files on your live website. Enter the start of the website address only. Mark environments with real customer data.',
    doc: `${CONFIG}#select-a-catalogue`,
  },
  'setup.packs': {
    intro:
      'A sample data module is a file of your project (pack.mjs) that fills tables with example records and can add test people. Add only files you trust: their code runs when the preview starts. Setup only checks that the file exists.',
    steps: [
      'Add the module (found ones are offered in Sample data).',
      'Restart the preview.',
      'Once it runs, choose its starting data under Sample data.',
      'Check it in the simulator (Data packs): loaded, matched and problems.',
    ],
    example: 'dataPacks:\n  - id: invented-data\n    module: ./pack/pack.mjs',
    doc: PACKS,
  },
  'setup.packs.module': {
    intro: 'Catalogue modules resolve from the catalogue directory; project modules resolve from the project file.',
  },
  'setup.packs.preset': {
    intro:
      'Startup data preset: the data preset seeded at startup. presetMode bootstrap keeps an existing state; always reapplies it at startup. presetConfiguration apply also applies its linked configuration.',
    doc: `${CONFIG}#local-runtime-options`,
  },
  'setup.personas': {
    intro:
      'Test people (personas) are the contacts in your data; a sample data module can group them. Several can be signed in at once, each in its own browser session (4 by default, up to 32).',
    doc: PERSONAS,
  },
  'setup.personas.maxInstances': {
    intro: 'Maximum isolated runtime copies; 0 disables launches.',
    doc: `${PERSONAS}#isolated-contexts-and-scenarios`,
  },
  'setup.simulation': {
    intro:
      'Keep changes only while it runs: records reset when the preview restarts and your files never change. Save into the project data files: changes are written to the data files of your sample data module. Data and table changes: also new tables and columns. Not set: an older behaviour that keeps changes in a separate local state file.',
    doc: LEVELS,
  },
  'setup.simulation.level': {
    intro:
      'dry-run, simulation or deep. Changing the level never flushes in-memory edits; restart rereads source and DATA files.',
    doc: `${LEVELS}#inspect-and-change-a-level`,
  },
  'setup.providers': {
    intro:
      'Providers and services: storage routes, the message bus, the outbox, connections, secret references and local services. Credential-looking keys must reference env:NAME or variable:NAME; literal secrets are refused.',
    example:
      'providers:\n  storage:\n    local: { kind: local-disk, root: blobs }\n  messaging:\n    local: { kind: local-queue }\nconnections:\n  http: { connector: http, provider: http }\nsecrets:\n  fx-vault/func-key: { source: environment, variable: FX_FUNC_KEY }',
    doc: STACK,
  },
  'setup.providers.storage': {
    intro: 'storage.<id>.kind is local-disk, azurite or pack:<packId>/<name>; connectionString accepts env:NAME only.',
    doc: `${STORAGE}#configuration-keys`,
  },
  'setup.providers.messaging': {
    intro:
      'messaging.<id>.kind is local-queue, servicebus-emulator or pack:<packId>/<name>; endpoints map service endpoints to <provider>/<entity>.',
    doc: `${MESSAGING}#configuration-keys`,
  },
  'setup.providers.connections': {
    intro: 'connections.<id> names connector, provider, principal and settings; entries never hold credentials.',
    doc: `${OPS}#connections-and-connectors`,
  },
  'setup.providers.secrets': {
    intro:
      'secrets bind <vault>/<name> to an environment variable or a DPAPI-protected value; a value key is refused. The YAML editor shows the document as saved; protectedValue is machine-bound ciphertext.',
    doc: `${PROFILES}#environment-variable-types-effective-values-and-secrets`,
  },
  'setup.providers.localServices': {
    intro:
      'Declared loopback services, probed and never started; name a connection string variable instead of a connectionString.',
    doc: `${OPS}#local-services`,
  },
  'setup.providers.serviceFixtures': {
    intro: 'Power BI, AI Builder, Copilot and Dynamics answer a pack fixture or ServiceDisabled.',
    doc: FIXTURES,
  },
  'setup.identity': {
    intro:
      'For programs that call the Web API: a secure (https) address, the tenant, app registrations and users. An app registration names the environment variable that holds its secret, never the secret itself.',
    example:
      'dataverse:\n  enabled: true\n  port: 0\n  applications:\n    - appId: 22222222-2222-2222-2222-222222222222\n      displayName: Integration client\n      secretEnvironmentVariable: PAQVILO_SIM_CLIENT_SECRET',
    doc: `${DATAVERSE}#enable-it`,
  },
  'setup.start': {
    intro:
      'Start runs your project on this computer. Saved changes apply when the preview restarts; saving never changes the records of a running preview.',
    steps: [
      'Start the preview here.',
      'Open your website and apps.',
      'Check the simulator (Infrastructure) and what the project needs.',
    ],
    doc: `${SETUP}#during-a-preview`,
  },
  'setup.start.restart': {
    intro:
      'Restart is required when the saved configuration differs from the one the runtime started with. Restart rereads sources and pack DATA; dry-run memory edits disappear.',
    doc: `${SETUP}#during-a-preview`,
  },
  'setup.system': {
    intro:
      'The system map from configuration (planned) or from the running preview (live), with readiness and the next step.',
    doc: STACK,
  },
};

const freeze = (value) => {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
};
freeze(HELP);
export { HELP };

const EMPTY = Object.freeze({ intro: '' });
/** The entry for a key, or a neutral `{ intro: '' }`. */
export const helpFor = (key) => (Object.hasOwn(HELP, key) ? HELP[key] : EMPTY);
