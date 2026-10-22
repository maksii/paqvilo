// Guidance text for every `/_sim/` view and panel and every `/_setup/` stage. Keys: `<view>`, `<view>.<panel>`,
// `<view>.<panel>.<field>`, `setup.<stage>` and `setup.<stage>.<field>`. Each entry is
// `{ intro, steps?, example?, doc?, fields? }`; `doc` is a repository path (optionally with an anchor) that the
// D9 docs map resolves. Text states current behaviour from the cited guide. No imports, no DOM access.
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

/** Setup stages of the guided rail, in order (D15); `setup.<id>` keys use these ids. */
export const SETUP_STAGES = Object.freeze(['project', 'runtime', 'sources', 'environments', 'packs', 'personas', 'simulation', 'providers', 'identity', 'start']);

const OPERATION_MODES = {
  placeholder: 'Placeholder: HTTP 501 identifies an operation without a supported local implementation. Recorded at inventory level.',
  exported: 'Supported exported flow or exported server logic: runs imported basic flow actions, or exported JavaScript you explicitly enabled against the local data store. Recorded at behaviour level.',
  mock: 'JSON mock: answers a configured response body and status for success, empty, validation or failure scenarios. Recorded at contract level.',
  handler: 'Project provider: a trusted pack handler supplies business logic or an unsupported integration. Recorded at behaviour level.',
  clr: 'CLR: a plug-in step runs its exported assembly in the local CLR host. Recorded at behaviour level.',
  disabled: 'Disabled: deliberately skips the flow or exact action and keeps a trace of that choice. Recorded at inventory level.',
};

const GRANTS = {
  client_credentials: 'client_credentials: a confidential application signs in as itself with a secret, certificate or federated assertion.',
  authorization_code: 'authorization_code: an interactive user signs in through the local picker page; public clients must send PKCE.',
  device_code: 'device_code: a user completes sign-in on the local device page.',
  refresh_token: 'refresh_token: redeems a refresh token for a new access token.',
  password: 'password (ROPC): needs a password set for the user through this view; a user without one is refused.',
  on_behalf_of: 'on_behalf_of (jwt-bearer): a confidential application exchanges a user token. Public clients cannot use it or client_credentials.',
};

const ACCESS_MODES = {
  'read-write': 'Read-Write (0): the systemuser access mode of an ordinary interactive user.',
  administrative: 'Administrative (1): systemuser access mode value 1.',
  read: 'Read (2): systemuser access mode value 2.',
  'support-user': 'Support user (3): systemuser access mode value 3.',
  'non-interactive': 'Non-interactive (4): application and SYSTEM users. Sign-in pickers list only interactive, enabled users.',
  'delegated-admin': 'Delegated admin (5): systemuser access mode value 5.',
};

const HELP = {
  // ---- Monitor -------------------------------------------------------------------------------------------
  dashboard: {
    intro: 'A live map of this local runtime: the clients and hosts that serve requests, the organization modules, providers and declared external services, with their status and recent activity. It reads local state only and changes nothing.',
    steps: [
      'Read the status of each component: listening, ready, declared, disabled, placeholder, missing, error or planned.',
      'Select a component to see its facts and open the view that manages it.',
      'A moving connection means its counters changed since the previous refresh (every 5 seconds while the page is visible).',
      'Run preflight under Blocking to see what a scenario still needs.',
    ],
    doc: `${STACK}#scope-boundary`,
  },
  'dashboard.topology': { intro: 'Columns read left to right: clients, hosts, the organization, providers and declared externals. Paqvilo never starts the external processes; it declares and probes them on loopback.', doc: `${STACK}#external-but-reachable` },
  'dashboard.tiles': { intro: 'Counters since this runtime started: portal and Dataverse requests, plug-in and flow runs, pending jobs, queued messages, captured outbox entries and diagnostics. The outbox never sends anything.', doc: `${MESSAGING}#outbox` },
  'dashboard.activity': { intro: 'The newest requests from the portal and the Dataverse API, followed by diagnostics grouped by code. Open Request audit for filters and correlation.', doc: SIM },
  'dashboard.blocking': { intro: 'Preflight lists the requirements of your sources and whether any of them block. It probes declared local services and rebuilds the source graph, so it runs on demand, not on every refresh. Strict makes every unsatisfied requirement in scope blocking.', doc: `${CAPS}#preflight` },
  'dashboard.configuration': { intro: 'What this runtime was started with: runtime kind, simulation level, state file, data packs, Solution layers, configured settings and ports. Change them in /_setup/ and restart.', doc: `${SETUP}#during-a-preview` },
  'dashboard.drawer': { intro: 'Facts for the selected component. Values are names, counts and status only; secrets, connection strings and URL queries are never shown.', doc: STACK },

  overview: {
    intro: 'Your local portal workspace: what this runtime serves, how it persists changes and where to go next. Nothing here changes a live environment.',
    steps: ['Check Runtime & persistence for the simulation level and pack DATA targets.', 'Open Data records or Scenarios to shape the local data.', 'Change startup configuration in /_setup/ and restart the preview.'],
    doc: SIM,
  },
  'overview.runtime': { intro: 'Shows the effective surface, simulation level, control-plane persistence and the exact declared pack DATA targets. Configuration in /_setup/ takes effect after restart; it never flushes in-memory edits.', doc: LEVELS },
  'overview.metrics': { intro: 'Discovered pages are routes found in the export. Active plugins are the declarative rules of this workspace, not exported plug-in steps (see Backend operations). Diagnostics count recorded findings. Source coverage is not rendering parity.', doc: EVIDENCE },
  'overview.workspace': { intro: 'The configuration this runtime loaded: sources, state file, identity scope and routing. Edit the configuration file through /_setup/ and restart to change it.', doc: `${SETUP}#configure-through-the-page` },
  'overview.customize': { intro: 'Shape the simulation with presets, personas, scenarios, platform rules and overrides. These change local state only.', doc: SIM },

  logs: {
    intro: 'Requests, Liquid and data reads, plug-in evaluations, diagnostics and reloads as they happen. The stream runs only while this view is open; the page keeps the newest 500 entries and shows them one page at a time (20 by default) with a type filter.',
    fields: {
      request: 'request: a portal or API request with method, path, status and duration.',
      liquid: 'liquid: a Liquid or FetchXML read made while rendering.',
      data: 'data: a local data read or write.',
      plugin: 'plugin: declarative plugin rules evaluated for a table operation.',
      diagnostic: 'diagnostic: a runtime finding with its code.',
      reload: 'reload: the runtime revision changed after a source or configuration reload.',
      connected: 'connected: the log stream (re)connected at the shown revision.',
    },
    doc: SIM,
  },
  'logs.list': { intro: 'Filter by type or text. Pause keeps new entries waiting so the list stops moving while you read.', fields: { type: 'Only entries of this type; the legend above explains each type.', search: 'Only entries whose path, table, code or message contains this text.' } },

  audit: {
    intro: 'A sanitized, bounded ledger of requests in this runtime. Request bodies, credentials, cookies and tokens are excluded. The ledger keeps the newest 1000 entries; the dropped count shows retention loss.',
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
  'audit.filters': { intro: 'Combine kind, provider (local or live), outcome, status class, path, table and free text. A correlation filter isolates one visitor request.', fields: { kind: 'Kind: the request type, such as api, liquid-fetchxml, form, page, entity-read or entity-query.', provider: 'Provider: local requests answered by this runtime or live requests passed to the connected reference.', outcome: 'Outcome: success, error, denied by a permission decision, or pending.', status: 'Status: the HTTP status class of the answer, or pending while running.', path: 'Path: requests whose path contains this text.', entity: 'Table: requests for this table logical name.', search: 'Search: free text over contact, table, path and error.' } },
  'audit.table': { intro: 'Each row is one request. Sequence numbers are assigned at request start; export the filtered JSON for evidence.' },

  evidence: {
    intro: 'Runtime diagnostics, rendering evidence and discovered pages. Each diagnostic has a code; the guide that owns the code explains it. Local evidence establishes local behaviour on these fixtures, not parity with a live site.',
    doc: EVIDENCE,
  },
  'evidence.diagnostics': { intro: 'Diagnostics are grouped by code. Look a code up in the guide of its area (for example PROVIDER_* in storage providers, SERVICE_ENDPOINT_* in messaging, FLOW_* in operations, SECRET_* in deployment profiles, PACK_EXPORT_* in data packs).', doc: STACK },
  'evidence.rendering': { intro: 'Screenshots and rendering checks captured by this runtime. Report coverage and skipped cases alongside passes.', doc: EVIDENCE },
  'evidence.pages': { intro: 'Pages discovered from the export. Configured coverage is not proof of navigation; open a page to exercise it.' },

  // ---- Data ----------------------------------------------------------------------------------------------
  records: {
    intro: 'Local tables and records. Writes follow the simulation level: dry run keeps record edits in memory, simulation writes declared existing pack DATA files, and deep simulation also permits declared schema changes. File-backed tables without a pack DATA owner are read-only, so their write actions are disabled.',
    steps: ['Pick a table.', 'Search, page or open a record.', 'Add, edit or delete through the JSON editor; the change applies to local state immediately.'],
    doc: `${LEVELS}#declare-existing-writable-data`,
  },
  'records.table': { intro: 'Rows of the selected table. Search matches any column value.', fields: { entity: 'The table whose local records are listed below.', search: 'Lists records whose column values contain this text.' } },
  'records.editor': { intro: 'Edit the record as JSON with logical column names. Authorization still runs before a write commits.', example: '{\n  "x_name": "Invented item",\n  "statecode": 0\n}' },

  packs: {
    intro: 'Registered data packs: trusted project modules that provide presets, personas, handlers, providers and DATA files. Registration is availability; matching is activation. A pack that matches nothing contributes nothing.',
    steps: ['Write pack/<id>.mjs in your project (see the example).', 'Register it in /_setup/ (Data packs) or under dataPacks in the configuration file.', 'Restart the preview: packs load at startup only.', 'Verify here: matched status, exports, presets and diagnostics.'],
    example: "export default {\n  id: 'invented-data',\n  name: 'Invented data',\n  description: 'Project-owned development data',\n  matches: () => true,\n  presets: () => ({}),\n};",
    doc: PACKS,
  },
  'packs.registered': { intro: 'One row per registered pack with its module path, matched status and reason. Expand a pack for its exports, presets, persona catalogue counts, DATA files and PACK_EXPORT_* diagnostics.', doc: `${PACKS}#recognised-exports` },
  'packs.presets': { intro: 'Data presets with their source: a pack, a built-in generic preset (empty-local, open-sandbox, strict-permissions, contact-demo) or a preset saved in this workspace. Applying a preset changes local state.', doc: PACKS },
  'packs.lifecycle': { intro: 'Loading a pack module executes JavaScript, so register only modules you trust. Setup checks that the path exists and never imports the pack; this view shows what the runtime loaded.', steps: ['write', 'register', 'restart', 'verify'], doc: PACKS },
  'packs.configuration-presets': { intro: 'A pack may export configurationPresets (at most 100). They are listed beside built-in and saved presets, marked with their pack, and cannot be edited or deleted here.', doc: `${PACKS}#pack-configuration-presets` },
  'packs.diagnostics': { intro: 'PACK_EXPORT_UNKNOWN flags an unrecognised export key (often a typo); the pack still loads. PACK_EXPORT_PENDING flags an export whose owning module has not loaded, so only its shape was checked.', doc: `${PACKS}#recognised-exports` },

  plugins: {
    intro: 'Declarative plugin rules and simulation presets for this workspace. Rules validate inputs and set or default fields on the configured operations. Exported Solution plug-in steps are under Backend operations.',
    doc: SIM,
  },
  'plugins.plugins': { intro: 'Each rule names a table, operations and validate/defaults/set/secondary actions.', example: '{\n  "name": "Require item name",\n  "entity": "x_item",\n  "enabled": true,\n  "operations": ["create", "update"],\n  "validate": [{ "field": "x_name", "required": true, "message": "Name is required." }],\n  "defaults": {},\n  "set": {},\n  "secondary": []\n}' },
  'plugins.presets': { intro: 'A preset seeds tables and can configure mappings, permissions, plugins and settings for a repeatable scenario. Presets come from packs, the generic built-ins or this workspace; the Pack and Source columns show which.', example: '{\n  "name": "Invented item",\n  "tables": { "x_item": [{ "x_itemid": "11111111-1111-4111-8111-111111111111", "x_name": "Demo" }] },\n  "mappings": { "x_item": { "entitySet": "x_items", "idColumn": "x_itemid" } }\n}', doc: PACKS },
  'plugins.apply': { intro: 'Applying a preset changes simulator state. Applying a portal business-data preset preserves omitted organization-owned tables, staff grants, credentials and imported schema. Linked configuration is applied only when you opt in.', doc: `${PACKS}#pack-configuration-presets`, fields: { preset: 'The data preset to apply: it replaces the records and rules it supplies in local state.', configuration: 'Also applies the configuration preset the data preset links to, which replaces platform and setting/snippet overrides.' } },

  mappings: { intro: 'Entity mappings connect logical names to Web API entity sets, primary IDs and relationships. Use the same logical names and ID columns as your export.', doc: SIM },
  'mappings.table': { intro: 'The mapping ID equals its logical name. Relationships resolve linked queries.', example: '{\n  "logicalName": "x_item",\n  "entitySet": "x_items",\n  "idColumn": "x_itemid",\n  "relationships": {}\n}' },
  'mappings.solution-metadata': { intro: 'Counts of imported Solution metadata and unresolved references from the selected Solution roots.', doc: 'mirage/docs/bootstrap-and-sources.md' },
  'mappings.schema-overrides': { intro: 'Local form and view schema overrides saved in configuration. They change local rendering only.' },
  'mappings.rich-text': { intro: 'Captured rich-text configurations used as local baselines.' },
  'mappings.stylesheets': { intro: 'Observed stylesheet baselines captured from the connected reference.' },
  'mappings.snippet-compositions': { intro: 'Captured snippet compositions. Capturing reads the intended signed-in reference and stores no tokens.' },

  endpoints: { intro: 'Custom responses for request paths. A local endpoint answers the configured status and body; a live endpoint uses the connected environment and still needs explicit permission for writes.', doc: SIM },
  'endpoints.table': { intro: 'Match a request path and HTTP method.', example: '{\n  "path": "/api/example",\n  "method": "GET",\n  "mode": "local",\n  "status": 200,\n  "body": { "value": [] }\n}' },

  // ---- Platform ------------------------------------------------------------------------------------------
  services: {
    intro: 'Providers and services the organization uses: storage, the local message bus, the outbox, connectors and connections, secret references, declared local services and service fixtures. Values such as secrets and connection strings are never shown; names, counts and status are.',
    steps: ['Check each provider is ready or declared as expected.', 'Probe declared local services through preflight.', 'Change providers in the project configuration (/_setup/ Providers & services) and restart.'],
    doc: STACK,
  },
  'services.storage': { intro: 'Storage providers and routes for Dataverse files and images, notes and attachments, portal web files, cloud attachments and SharePoint documents. A runtime without a state directory keeps bytes in memory (lost on restart); with one, bytes live on local disk under the state directory. Azurite is served by the core Blob REST transport (Shared Key) once its connection string is set; without one it is declared only. Paqvilo never starts it.', doc: `${STORAGE}#routes` },
  'services.messaging': { intro: 'The local message bus: FIFO per entity, peek-lock with a 60 second default lock, retries and dead-lettering. Service endpoints (contracts 2, 5 and 6) send to the entity mapped under providers.messaging.endpoints; an unmapped endpoint raises SERVICE_ENDPOINT_UNMAPPED. Purging an entity cannot be undone.', doc: `${MESSAGING}#local-message-bus` },
  'services.outbox': { intro: 'Captured email, Teams and Outlook messages for inspection. The outbox never sends anything. Filter by correlation id, channel or time. Only the newest entries are kept (1000 by default).', doc: `${MESSAGING}#outbox`, fields: { channel: 'Only entries captured for this channel: email, teams, outlook or portal-email. Any channel lists all of them.' } },
  'services.connectors': { intro: 'Connector providers (dataverse, http, fixture, pack:<id>, memory-queue, approvals) and the project connections they resolve to. An action resolves connection reference → connection id → connections entry → provider; every failed hop is a coded error, never an implicit success.', doc: `${OPS}#connections-and-connectors` },
  'services.secrets': { intro: 'Secret references by name with their bound status and source kind (environment variable or a Windows DPAPI-protected value). Paqvilo never contacts Key Vault and never shows a secret value.', doc: `${PROFILES}#environment-variable-types-effective-values-and-secrets` },
  'services.local-services': { intro: 'Azure Functions, Azurite, the Service Bus emulator and other loopback HTTP services you run yourself. Paqvilo declares and probes them, never starts them. A probe is one GET with a 2 second timeout and no redirects.', example: 'localServices:\n  functions: { kind: http, baseUrl: "http://localhost:7071", probe: "/admin/host/status", required: false }', doc: `${OPS}#local-services` },
  'services.service-fixtures': { intro: 'Power BI, AI Builder, Copilot and Dynamics apps are never executed. Each operation answers a trusted pack fixture or the ServiceDisabled error, and the first disabled answer records SERVICE_FIXTURE_DISABLED.', doc: `${FIXTURES}#disabled-by-default-services` },
  'services.powerfx': { intro: 'The Power Fx seam stays at contract level until a pack registers an adapter (powerFx export).', doc: 'mirage/docs/canvas-apps.md' },
  'services.apps': { intro: 'Canvas apps are inventoried from source; code apps answer at contract level.', doc: STACK },
  'services.sharepoint': { intro: 'SharePoint document integration rows use the sharepointDocuments storage route; the SharePoint and Graph REST contract is mounted only by a declared connection.', doc: 'mirage/docs/sharepoint.md' },

  flows: {
    intro: 'Cloud flow runs, waits and approvals, and the background work of the organization: durable jobs, the scheduler and asynchronous operations. Answering a wait resumes its run by replaying the journal.',
    doc: `${OPS}#flow-runs-waits-and-approvals`,
  },
  'flows.runs': { intro: 'Run summaries, newest first, filtered by process id and status (Running, Waiting, Succeeded, Failed, Cancelled, TimedOut). A run detail shows its action journal, never its trigger input or secure outputs. The store keeps the newest 200 runs and the journals of the newest 50 finished runs.', doc: `${OPS}#flow-runs-waits-and-approvals`, fields: { status: 'Only runs in this status. Any status lists every run the store keeps.' } },
  'flows.journal': { intro: 'The journal lists the executed connector actions of one run with status and outputs. Secure outputs are journalled as secure only. Trigger input is dropped when the run ends; the store keeps the newest 200 runs and the journals of the newest 50 finished runs.', doc: `${OPS}#flow-runs-waits-and-approvals` },
  'flows.waits': { intro: 'Waiting runs: delays, approvals and webhook waits. Overdue compares each timeout with the runtime clock. Answer an approval with Approve or Reject, or a delay or webhook wait with outputs JSON; the run is scheduled to resume (202).', example: '{ "outcome": "Approve", "responder": "reviewer@example.test", "comments": "Looks right" }', doc: `${SIM}#flow-runs-and-waits`, fields: { state: 'Pending lists waits whose timeout has not passed; Overdue lists waits past their timeout on the runtime clock.', comments: 'Optional text returned with the approval outcome as the responder comments.' } },
  'flows.background': { intro: 'Committed asynchronous work runs FIFO on the store’s durable job runner: asynchronous plug-in steps and flow trigger runs. Job errors are separate from the original committed response. Ready runs saved in the state file resume once after a restart.', doc: `${OPS}#execution-boundary` },
  'flows.webhooks': { intro: 'Webhook (contract 8) endpoints are posted only on loopback; other hosts are not contacted. Endpoint hosts are shown by name only, never with a URL query or authvalue.', doc: `${MESSAGING}#service-endpoint-delivery` },

  capabilities: {
    intro: 'What each local module, provider, operation and source component can do, and what your scenario still requires. Levels from lowest to highest: inventory, contract, behaviour, native-qualified. A placeholder or a mock never counts as behaviour.',
    fields: {
      inventory: 'inventory: listed from source; nothing runs it, or it answers a placeholder or a documented 501/diagnostic.',
      contract: 'contract: request and response shapes are honoured; the answer comes from a fixture, a mock, a declared-only adapter or a reduced rule set.',
      behaviour: 'behaviour: the local runtime executes the documented behaviour.',
      'native-qualified': 'native-qualified: behaviour compared with a native environment in at least one named scenario.',
    },
    doc: `${CAPS}#fidelity-levels`,
  },
  'capabilities.report': { intro: 'Every capability record of the running host with its kind, level and source. Operation modes map to levels: placeholder and disabled to inventory, mock to contract, exported, handler, clr and webhook to behaviour.', doc: `${CAPS}#capability-records`, fields: { level: 'Only capability records at this level: inventory, contract, behaviour or native-qualified.' } },
  'capabilities.missing': { intro: 'Prerequisites that no record provides.', doc: `${CAPS}#registry-api` },
  'capabilities.inventory': { intro: 'Solution components Paqvilo reads but does not host (canvas apps, custom connectors and others), counted by component kind with the level each reports.', doc: 'mirage/docs/bootstrap-and-sources.md#solution-inventory' },
  'capabilities.offline': { intro: 'Each staff session that used mobile offline in a model-driven app: its mode, last sync, downloaded tables, pending changes, sync conflicts and sync errors. Switch the mode and synchronize from the Online/Offline button in the app header.', doc: 'mirage/docs/model-driven-apps.md#routes' },
  'capabilities.unsupported': { intro: 'Records and operations below behaviour. A record without operations keeps the reason it states.', doc: `${CAPS}#registry-api` },
  'capabilities.preflight': { intro: 'Preflight scopes the report with requirement ids or globs (for example cloud-flow:*, table:x_item). Strict makes every unsatisfied requirement in scope blocking. The report never includes configured values.', example: '{ "id": "approval-flow", "requires": ["cloud-flow:*", "table:x_item"] }', doc: `${CAPS}#preflight` },

  operations: {
    intro: 'Exported server logic, cloud flows, Solution workflows and plug-in steps with their source, route, access and local behaviour. Overrides change simulation state only; they do not deploy the source or activate an online flow. Use source default removes a local override.',
    fields: OPERATION_MODES,
    doc: `${OPS}#choose-local-behavior`,
  },
  'operations.list': { intro: 'One row per operation. Imported routes keep their exported web-role checks, also when the response is mocked. An unlinked workflow gets no invented route or grant.', doc: `${OPS}#execution-boundary` },
  'operations.mode': { intro: 'Choose how this operation answers locally.', fields: OPERATION_MODES, doc: `${OPS}#choose-local-behavior` },
  'operations.mode.mock': { intro: 'Set the response status and body.', example: '{ "status": 200, "body": { "value": [] } }' },
  'operations.mode.exported': { intro: 'Exported code runs with bounded time budgets, not an untrusted-code sandbox. Enable it only for sources you trust.', doc: `${OPS}#local-services` },

  environment: {
    intro: 'Reference environments, the active deployment profile, environment variables and reference enrichment. Profiles map existing files; Paqvilo does not run PAC, upload, deploy or synchronize.',
    doc: PROFILES,
  },
  'environment.references': { intro: 'Reference environments come from the configuration file. Reads are read-only through the intended signed-in browser.' },
  'environment.profile': { intro: 'Select the deployment profile pinned in this portal’s local state. Configure profiles under mirage.deploymentProfiles.', doc: PROFILES },
  'environment.variables': {
    intro: 'Effective values, lowest first: definition default → Solution value → selected profile → project environmentVariables → the /_sim/ or persona local value. A local value here overrides the rest for this runtime.',
    fields: { secret: 'Secret (100000005): the value is a Key Vault reference, never the secret. Server logic reads null and records SECRET_NOT_EXPOSED_TO_SERVER_LOGIC; the project secrets map binds the reference to an environment variable or a DPAPI-protected value.' },
    doc: `${PROFILES}#environment-variable-types-effective-values-and-secrets`,
  },
  'environment.enrichment': { intro: 'Reference enrichment reads selected metadata from the intended signed-in reference browser. Validate before saving.' },
  'environment.project': { intro: 'The project files this runtime resolved. Edit them through /_setup/.' },

  platform: { intro: 'Simulated organization and platform controls such as the link-entity budget and attachment restrictions. Each control shows its real administration classification (support-managed, catalogue only, simulator experiment or safety bound). Changes are held in this runtime’s state.', doc: `${EXPERIMENTS}#settings-catalogue` },
  'platform.presets': { intro: 'Configuration presets replace only platform settings and snippet/site-setting overrides; data, identities, web roles, page access rules and backend-operation configuration are preserved. Built-ins and pack presets cannot be edited or deleted. Applying a preset is a local experiment, not proof that a real support change was approved.', doc: `${EXPERIMENTS}#presets-and-concurrent-instances`, fields: { select: 'The configuration preset to apply, export or delete; built-in and pack presets can be applied but not deleted.', name: 'Display name of the new preset saved from the current overrides.', id: 'Identifier of the new preset: up to 80 letters, digits, hyphens or underscores, starting with a letter or digit.', import: 'A preset as JSON, for example one exported from another runtime; importing saves it in this runtime.' } },
  'platform.settings': { intro: 'Instance overrides take precedence over the organization row and catalogue defaults. They do not configure a connected Dataverse organization.', doc: EXPERIMENTS },

  overrides: { intro: 'Exported and effective site settings and content snippets side by side. Edit, add, remove locally or reset without changing source files. Portal values stay strings; null removes the local effective value.', doc: EXPERIMENTS },
  'overrides.presets': { intro: 'The same configuration presets as Platform rules. Run independent experiments in separate runtimes with distinct state files and ports; do not share a writable state file.', doc: `${EXPERIMENTS}#presets-and-concurrent-instances` },
  'overrides.settings': { intro: 'Boolean-looking values have one-click Set True / Set False actions.' },
  'overrides.snippets': { intro: 'A snippet name override covers all request languages in this instance; reset restores each source translation.' },

  portal: { intro: 'Site settings, content snippets, web roles and page access rules of the local portal. The pages Platform rules and Settings & snippet overrides cover experiments; this page keeps role and page-access administration.', doc: EXPERIMENTS },
  'portal.settings': { intro: 'Site settings held in local state.' },
  'portal.snippets': { intro: 'Content snippets held in local state.' },
  'portal.roles': { intro: 'Web roles of the local portal. Role membership editing stays separate and explicit.' },
  'portal.access-rules': { intro: 'Page access rules that restrict or grant pages to web roles.' },

  // ---- Identity ------------------------------------------------------------------------------------------
  access: {
    intro: 'Portal visitors, contact personas, web roles and the effective permission hierarchy. Portal requests start anonymous; local sign-in stores a per-runtime cookie for this browser only. Portal table permissions never apply to the Dataverse API.',
    doc: SIM,
  },
  'access.session': { intro: 'The identity of this browser. Signing one browser in does not sign another browser in; the saved simulator identity is not a substitute for a request cookie.', doc: SIM },
  'access.personas': { intro: 'Contact personas: a catalogue describes which contact to test and why. Contacts, parent accounts and web-role memberships stay the identity source; catalogue metadata never creates records or grants permissions.', doc: PERSONAS },
  'access.catalogue': {
    intro: 'Persona catalogue precedence: state entries win; among packs the first registered definition wins. A preset that supplies a catalogue replaces state metadata. Import replaces state metadata, Export writes the effective catalogue, Reset removes only state metadata.',
    fields: { runtimes: 'Isolated runtimes: a context or a scenario with a preset starts a copy with its own cookie, state and loopback origin. Default maximum four copies (personaContexts.maxInstances, 0 to 32; 0 disables launches). Copies share the Node process and do not survive a parent restart.' },
    doc: `${PERSONAS}#storage-and-precedence`,
  },
  'access.external-identities': { intro: 'External identity-provider flows are local simulations of exported provider settings. They do not copy live credentials or mint genuine environment tokens.', doc: SIM },
  'access.create-persona': { intro: 'Create a synthetic contact in local data.' },
  'access.session-override': { intro: 'Override roles for this browser session only.' },
  'access.manual-identity': { intro: 'Configure the saved identity used by administration requests and by cookie-less portal requests when identity scope is configured.', doc: SIM },
  'access.permissions': { intro: 'The effective permission hierarchy for the current identity. Permission enforcement can be enforced or permissive for local experiments; the choice is visible in evidence.', fields: { source: 'Which table permission grants apply: configured local rules, the grants imported from the portal export, or imported grants plus local additions.' } },
  'access.raw-permissions': { intro: 'Table permissions as JSON: entity, operations, roles and scope.', example: '{\n  "entity": "x_item",\n  "operations": ["read"],\n  "roles": ["Authenticated Users"],\n  "scope": "global"\n}' },
  'access.presets': { intro: 'Apply a data preset; it changes local state.', doc: PACKS },

  dataverse: {
    intro: 'The local organization: staff session, application registrations, interactive users, workflows and recent API requests. Staff administration works with the HTTP API off; enable the listener in /_setup/ and restart when an external client needs it. Security roles never apply to the portal.',
    doc: `${DATAVERSE}#administration`,
  },
  'dataverse.staff-session': { intro: 'Select a model-driven staff user for this browser or reset to local administrator. Invalid, disabled or expired selections fail without escalating.', doc: `${DATAVERSE}#administration`, fields: { user: 'The staff user that model-driven pages opened in this browser use; only eligible interactive users are listed.' } },
  'dataverse.secret': { intro: 'A new secret is shown once. Dismissing it, leaving the view or reloading drops it; subsequent reads return only a hint.' },
  'dataverse.applications': {
    intro: 'Application registrations with secret hints, certificate thumbprints and allowed grants. Removing a registration removes its application user.',
    fields: GRANTS,
    doc: `${DATAVERSE}#token-behaviour`,
  },
  'dataverse.applications.grants': { intro: 'Grant types an application may redeem.', fields: GRANTS, doc: `${DATAVERSE}#token-behaviour` },
  'dataverse.users': {
    intro: 'Interactive users and their roles. Privilege depth (Basic, Local, Deep, Global) decides which rows a caller reaches; sharing adds rights but never opens a table the roles do not grant. A password is 8 to 256 characters, stored hashed and never returned.',
    fields: ACCESS_MODES,
    doc: `${DATAVERSE}#users-roles-and-privileges`,
  },
  'dataverse.users.accessmode': { intro: 'The systemuser access mode.', fields: ACCESS_MODES },
  'dataverse.workflows': { intro: 'Classic Solution workflows and their local activation.', doc: `${DATAVERSE}#workflows` },
  'dataverse.environment': { intro: 'Organization environment settings held in local state.' },
  'dataverse.register': { intro: 'Register an application or create a user. A public client uses only the authorization code, device code, refresh token and password grants. Redirect URIs must be http(s) URLs.', doc: `${DATAVERSE}#endpoints` },
  'dataverse.certificates': { intro: 'Add an X.509 certificate PEM or a bare public key. Its SHA-1 and SHA-256 fingerprints become x5t and x5t#S256 for client assertions.', doc: `${DATAVERSE}#endpoints` },
  'dataverse.federated': { intro: 'Federated credentials match a client assertion by issuer, subject and audience and verify it against the issuer’s keys. A duplicate issuer and subject is refused.', doc: `${DATAVERSE}#managed-identity-and-federated-credentials` },
  'dataverse.managed-identities': { intro: 'Managed identities are application users. managedIdentity.mode picks the endpoint shape: appservice, imds or arc.', doc: `${DATAVERSE}#managed-identity-and-federated-credentials` },
  'dataverse.requests': { intro: 'A ring buffer of recent Web API requests. The request log never contains tokens.' },
  'dataverse.reset': { intro: 'Reset keeps registrations and re-seeds the security tables.', doc: `${DATAVERSE}#endpoints` },
  'dataverse.connect': { intro: 'Connection details for SDK clients: authority, tenant and origin of the local API.', doc: `${DATAVERSE}#connect-an-sdk` },
  'dataverse.status': { intro: 'Organization availability, shown separately from HTTP listeners.' },

  scenarios: {
    intro: 'Three different things are called scenarios. State scenarios here bundle a preset, a persona and permission settings into one local state change. Persona-catalogue scenarios launch isolated runtime copies. Preflight scenario files ({ id, requires }) scope a capability check from the command line.',
    steps: ['Save the current setup as a state scenario.', 'Apply it to restore that setup in one change; omitted parts keep the current setup.', 'Use catalogue scenarios for isolated copies, and preflight scenario files for capability checks.'],
    doc: `${PERSONAS}#isolated-contexts-and-scenarios`,
  },
  'scenarios.saved': { intro: 'State scenarios survive reset and import. They live in local state, not in configuration files.', example: '{\n  "id": "example-scenario",\n  "name": "Example",\n  "preset": null,\n  "persona": { "contactId": "11111111-1111-4111-8111-111111111111" },\n  "permissionMode": "enforce",\n  "permissionSource": "combined"\n}' },
  'scenarios.catalogue': { intro: 'Catalogue scenarios resolve context from scenario → persona and preset from scenario → context; each launch starts or reuses an isolated copy.', doc: `${PERSONAS}#isolated-contexts-and-scenarios` },
  'scenarios.preflight': { intro: 'A preflight scenario file lists requirement ids or globs; run it with paqvilo mirage preflight --scenario FILE.', doc: `${CAPS}#scenario-file` },
  'scenarios.save': { intro: 'permissionMode is enforce or permissive; permissionSource is configured, exported or combined; persona is null for an anonymous visitor.' },
  'scenarios.reset': { intro: 'Reset restores the imported defaults of the workspace. Saved scenarios are kept.' },

  // ---- Runtime -------------------------------------------------------------------------------------------
  runtime: { intro: 'Runtime & persistence, fingerprints and workspace state. Export, import and reset act on local state only; import replaces the whole local state (saved scenarios are kept).', doc: LEVELS },
  'runtime.persistence': { intro: 'Dry run keeps record edits, local registrations and password/secret hashes in memory. Persistent levels need a private state file under ignored .paqvilo/; undeclared business writes fail with SimulationDataTargetRequired.', doc: `${LEVELS}#private-runtime-and-identity-state` },
  'runtime.fingerprints': { intro: 'Source and implementation fingerprints. Restart to load edited runtime code. Never infer a deployed commit from them.' },
  'runtime.state': { intro: 'Export saves records, mappings, presets, rules and configuration as JSON. Import replaces the local state and reloads open portal pages. Reset restores the imported defaults.' },

  connection: { intro: 'Request routing to the connected live reference, the authenticated browser and captures of the page shell and static assets. Live create/update/delete cannot leave the runtime without --allow-live-writes and the separate administration switch.', doc: SIM },
  'connection.routing': { intro: 'Choose which requests stay local and which go to the reference. Saved routing is runtime state.' },
  'connection.browser': { intro: 'The intended signed-in browser for reference reads. Credentials and MFA stay with you; tokens are never stored.' },
  'connection.shell': { intro: 'Capture the page shell from the reference for local rendering.' },
  'connection.assets': { intro: 'Capture static portal assets into the local cache.' },
  'connection.shell-resources': { intro: 'Resources referenced by the captured shell.' },
  'connection.baselines': { intro: 'Rich-text and stylesheet baselines and snippet compositions captured from the reference.' },

  // ---- Setup stages --------------------------------------------------------------------------------------
  setup: { intro: 'The local setup workspace edits configuration files only. It never deploys, synchronizes, runs PAC, reads live references, imports packs or authorizes live writes. Saves apply on the next preview start.', doc: SETUP },
  'setup.project': {
    intro: 'Choose the project kind. A shared catalogue (paqvilo.config.yml) holds Power Pages sites and environments; a standalone Mirage project holds a model-driven or API-only runtime with Solutions and optional packs.',
    steps: ['Create the configuration from a template, or open the existing file.', 'Expect placeholder findings (example origins, missing folders): they are the next steps, not errors.'],
    doc: `${SETUP}#configure-through-the-page`,
  },
  'setup.project.templates': {
    intro: 'Example setups with invented names and example.test origins: Power Pages portal, Model-driven app project, Dataverse API only, and Full stack sample (storage routes, memory messaging, outbox, a fixture connection, secret references, a declared local service, persona contexts and deployment profiles). paqvilo mirage demo copies the shipped example project.',
  },
  'setup.project.layers': {
    intro: 'Settings resolve, highest first: CLI options, shell PAQVILO_* variables, .env beside the catalogue, paqvilo.config.local.yml (personal layer), the shared catalogue. Use the shared layer for team configuration and the personal layer for local overrides; deleting a personal override reveals the shared value.',
    doc: `${CONFIG}#personal-settings-and-worktrees`,
  },
  'setup.runtime': { intro: 'Choose the runtime surface: Power Pages, model-driven apps, or an organization API only. Model-driven and API projects use exported Solutions and optional trusted packs without a portal source or environment URL.', doc: 'mirage/docs/standalone-organization.md' },
  'setup.runtime.kind': { intro: 'power-pages, model-driven or dataverse-api.' },
  'setup.runtime.defaultApp': { intro: 'The default application GUID for a model-driven surface only.' },
  'setup.runtime.trustedExtensions': { intro: 'modelDriven.trustedExtensions: true runs supported form scripts, commands and PCF controls. Enable it only for sources you trust.' },
  'setup.sources': { intro: 'Portal export and Solution folders. Sources and Solution roots resolve below the source root; the source root resolves from the catalogue directory. Absolute paths work for separate Git checkouts. Source files remain unchanged.', doc: `${CONFIG}#select-a-catalogue` },
  'setup.environments': { intro: 'Reference environments are HTTP(S) origins without credentials, paths or query strings. Mark real-data environments with caution. Placeholder origins are readiness findings until you set your own.', doc: `${CONFIG}#select-a-catalogue` },
  'setup.packs': {
    intro: 'Register trusted pack modules explicitly; loading one executes JavaScript. Setup checks the path and never imports the module.',
    steps: ['Write pack/<id>.mjs.', 'Register it here (dataPacks).', 'Restart the preview.', 'Verify in /_sim/#packs: matched status, exports and diagnostics.'],
    example: 'dataPacks:\n  - id: invented-data\n    module: ./pack/pack.mjs',
    doc: PACKS,
  },
  'setup.packs.module': { intro: 'Catalogue modules resolve from the catalogue directory; project modules resolve from the project file.' },
  'setup.packs.preset': { intro: 'Startup data preset: the data preset seeded at startup. presetMode bootstrap keeps an existing state; always reapplies it at startup. presetConfiguration apply also applies its linked configuration.', doc: `${CONFIG}#local-runtime-options` },
  'setup.personas': {
    intro: 'Personas come from contacts in the data; a persona catalogue (from a pack or /_sim/) groups them and defines contexts and scenarios. personaContexts.maxInstances bounds isolated copies (default 4, range 0 to 32).',
    doc: PERSONAS,
  },
  'setup.personas.maxInstances': { intro: 'Maximum isolated runtime copies; 0 disables launches.', doc: `${PERSONAS}#isolated-contexts-and-scenarios` },
  'setup.simulation': {
    intro: 'Simulation level: dry run keeps record edits in memory and refuses schema changes; simulation writes existing declared pack DATA files; deep also permits declared schema changes. Omitting the level keeps legacy local-state persistence.',
    doc: LEVELS,
  },
  'setup.simulation.level': { intro: 'dry-run, simulation or deep. Changing the level never flushes in-memory edits; restart rereads source and DATA files.', doc: `${LEVELS}#inspect-and-change-a-level` },
  'setup.providers': {
    intro: 'Providers and services: storage routes, the message bus, the outbox, connections, secret references and local services. Credential-looking keys must reference env:NAME or variable:NAME; literal secrets are refused.',
    example: 'providers:\n  storage:\n    local: { kind: local-disk, root: blobs }\n  messaging:\n    local: { kind: local-queue }\nconnections:\n  http: { connector: http, provider: http }\nsecrets:\n  fx-vault/func-key: { source: environment, variable: FX_FUNC_KEY }',
    doc: STACK,
  },
  'setup.providers.storage': { intro: 'storage.<id>.kind is local-disk, azurite or pack:<packId>/<name>; connectionString accepts env:NAME only.', doc: `${STORAGE}#configuration-keys` },
  'setup.providers.messaging': { intro: 'messaging.<id>.kind is local-queue, servicebus-emulator or pack:<packId>/<name>; endpoints map service endpoints to <provider>/<entity>.', doc: `${MESSAGING}#configuration-keys` },
  'setup.providers.connections': { intro: 'connections.<id> names connector, provider, principal and settings; entries never hold credentials.', doc: `${OPS}#connections-and-connectors` },
  'setup.providers.secrets': { intro: 'secrets bind <vault>/<name> to an environment variable or a DPAPI-protected value; a value key is refused. The YAML editor shows the document as saved; protectedValue is machine-bound ciphertext.', doc: `${PROFILES}#environment-variable-types-effective-values-and-secrets` },
  'setup.providers.localServices': { intro: 'Declared loopback services, probed and never started; name a connection string variable instead of a connectionString.', doc: `${OPS}#local-services` },
  'setup.providers.serviceFixtures': { intro: 'Power BI, AI Builder, Copilot and Dynamics answer a pack fixture or ServiceDisabled.', doc: FIXTURES },
  'setup.identity': { intro: 'The Dataverse API listener, its port and TLS, tenant, applications and users. Applications name a secretEnvironmentVariable rather than a secret.', example: 'dataverse:\n  enabled: true\n  port: 0\n  applications:\n    - appId: 22222222-2222-2222-2222-222222222222\n      displayName: Integration client\n      secretEnvironmentVariable: PAQVILO_SIM_CLIENT_SECRET', doc: `${DATAVERSE}#enable-it` },
  'setup.start': {
    intro: 'Start the preview and verify it in /_sim/. Saves apply on the next start; saving cannot redirect a running browser, reset simulator data or change source watchers.',
    steps: ['Start the preview with the command shown for this project.', 'Open /_sim/#dashboard and check every component.', 'Run preflight for the scenarios you need.'],
    doc: `${SETUP}#during-a-preview`,
  },
  'setup.start.restart': { intro: 'Restart is required when the saved configuration differs from the one the runtime started with. Restart rereads sources and pack DATA; dry-run memory edits disappear.', doc: `${SETUP}#during-a-preview` },
  'setup.system': { intro: 'The system map from configuration (planned) or from the running preview (live), with readiness and the next step.', doc: STACK },
};

const freeze = value => {
  if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); }
  return value;
};
freeze(HELP);
export { HELP };

const EMPTY = Object.freeze({ intro: '' });
/** The entry for a key, or a neutral `{ intro: '' }`. */
export const helpFor = key => (Object.hasOwn(HELP, key) ? HELP[key] : EMPTY);
