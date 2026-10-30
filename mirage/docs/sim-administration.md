# Local simulation administration

[Persona catalogues](persona-catalog.md) add grouped, searchable pickers to sign-in
and Identity, browser-local pins/recent choices, catalogue editors and isolated
setups for deployment profiles, variables and snippet/settings overrides. Open
`/_sim/#identity` to select a browser persona or manage metadata. Role membership
editing remains separate and explicit. Testing helpers resolve the actual origin
and browser options for a persona or catalogue scenario.

`/_sim/` and [`/_setup/`](../../docs/setup.md) share one shell and an **Areas** switch in the sidebar: `/_sim/` is the simulator workspace for daily work, setup is for administration and initial configuration.

Both share one wordmark, **Paqvilo**, with the area label under it (`PROJECT SETUP`, `SIMULATOR WORKSPACE`).

`/_sim/` is the loopback administration workspace. It exposes local tables/records, identity, roles, permissions, presets/scenarios, settings/snippets, runtime environment, source inspection, providers, platform resources, diagnostics and evidence. Changes here affect local state and rendering. Provider controls distinguish local configuration, optional reference reads and cached platform assets.

**Platform rules** (`#platform`) configures simulated organization/platform controls, including the support-managed link-entity budget and attachment restrictions. **Settings & snippet overrides** (`#overrides`) compares source/effective values without editing exports. Both support portable configuration presets and independent state for concurrent runtimes. Coverage and real administration classifications are explicit; see [configuration experiments](configuration-experiments.md).

**Organization identity & API** (`#dataverse`) manages the local organization, including when its public HTTP listener is off. It shows staff session identity/roles, application registrations with secret hints and certificate thumbprints, interactive users, optional local token credentials and recent API requests. Select a model-driven staff user or explicitly reset to local administrator. Portal personas and application-token identities are separate. Forms register applications, add local secrets/public certificates/federated credentials, create staff users, edit roles and enable/disable users. A new secret is shown once and never appears in a later read. Enable the HTTP API in Project setup and restart when an external integration client needs it. See [Dataverse API](dataverse-api.md#administration).

**Runtime & persistence** on Overview/Runtime state shows the effective surface, simulation level, control-plane persistence and exact declared pack DATA targets. Configuration in `/_setup/` takes effect after restart; it never flushes in-memory edits. Dry run permits memory-only record changes, simulation writes declared existing DATA files, and deep simulation also permits declared schema changes. File-backed tables without owners are read-only. See [simulation levels](simulation-levels.md).

[Standalone app/API profiles](standalone-organization.md) expose only applicable views and links. API-only profiles have no portal/model-driven launch link; standalone profiles have no portal persona, live bridge or rendering controls. The `/_sim/` record editor is explicit local administration; model-driven requests use the selected staff principal and its field/row security.

**Backend operations** lists exported server logic and cloud flows, including unlinked Solution workflows. Select a JSON response mock, keep an unsupported placeholder, explicitly enable trusted exported code or use a registered project handler. **Use source default** removes a local override. Exported role grants still apply; unlinked workflows receive no invented route or grants. See [operation modes and limits](operations.md).

Portal requests start anonymously. Local sign-in selects an active synthetic contact or explicit role override and stores a per-runtime `paqvilo-mirage-auth-<port>` cookie. The portal sign-in page, `_sim` and Lense Tweaks all operate on the browser session. Signing one browser in does not sign another browser in. The saved simulator identity is not a substitute for a request cookie.

Embedded tools call `simulator.signIn(contactId)` and send the returned cookie header. Playwright tests use `signInContext` from `paqvilo/mirage/testing`. Local session administration uses CSRF protection. Sign-out clears only the local session.

`simulator.identityScope` supports `"sessions"` (the default) and `"configured"`.
The legacy `"all-requests"` alias has the same behavior as `"configured"`.
Use `"configured"` only for explicitly chosen offline tooling: cookie-less portal
requests use the saved configured identity, with its normal membership or manual
role-override resolution and permission checks. A valid visitor cookie takes
precedence, including the explicit anonymous cookie issued by sign-out. This
option neither creates a session nor signs a browser in; a cookie-less request
uses the configured identity. Session scope
keeps cookie-less visitors anonymous. Administration requests continue to use the
configured identity. These are local simulation settings, not Power Pages
authentication or production security settings. Prefer session helpers for
independent visitors and permission tests.

`connectRuntime().signIn(null, { configuredPersona: true })` requires a configured
contact (`identity.contactId` or legacy `identity.id`). Missing and role-only
identities fail with `MISSING_PERSONA_CONTACT` before sending a sign-in POST.
An explicit `contactId` is also supported; omit sign-in to stay anonymous.

HTTP tools can use `createPortalSession` or `connectRuntime().createSession` from
`paqvilo/mirage/testing` for independent visitors sharing one runtime. Each owns its
cookie jar and membership-derived identity. `runSessionMatrix` exercises a bounded
visitor/case product concurrently, supports cancellation and serialized recording,
and reports throughput and latency. It sends ordinary portal requests and preserves
permission denials. Use separate write fixtures per visitor; settings, sources and
data are shared within the runtime. For different configuration or CPU workers,
run separate Mirage processes and state files. See [public API](../../docs/public-api.md#test-many-visitors-concurrently).

External identity-provider flows are local simulations for exported provider settings, with a local provider route and explicit redirect handling. They do not copy live credentials or mint genuine environment tokens. Actual live-reference sign-in belongs to the intended signed-in browser and its own identity.

Automated tools can inspect `connectRuntime().audit(filters)`, `exportAudit(filters)` and `diagnostics()`. Correlate a visitor's returned `traceId` with `correlationId`, or isolate entries by `contactId`. Exclusive `afterSequence` and inclusive `throughSequence` bound a stable request window; responses expose retention loss and the oldest retained sequence. Complete the requests before advancing a checkpoint because sequence numbers are assigned at request start. These reads use the existing sanitized, bounded ledger.

`runtime.witness({tables: ['fixture']})` and `visitor.witness({tables: ['fixture']})`
capture a read-only verification boundary through the existing loopback administration
API. Select one to 32 distinct existing logical fixture tables explicitly. Each
visitor sends its own cookie internally, so its witness uses the same resolved
portal identity and membership roles as its portal requests. Cookie-less requests
are anonymous under the default session scope. The configured persona does not
silently replace the visitor.

The atomic `DataStore.readOperation` hashes effective permissions, mappings,
settings, operation mode, source/runtime fingerprints, actor fields and all stored
columns/multiplicities in the selected tables. It invokes no SDK/plugin retrieval.
The response contains hashes/counts and selection scope rather than row bodies,
setting values or credentials. `compareVerificationWitnesses(before, after)` from
`paqvilo/mirage/testing` reports changed hash categories. Runtime instance and
revision changes are reported separately so an unselected recording-table
write does not masquerade as selected fixture drift. No table is automatically
excluded, and unselected collections receive no coverage credit. Actor fields are
observed independently of that table selection.

Keep the state file outside the export or in ignored `.paqvilo/`, as with normal
runtime configuration. The source fingerprint intentionally observes files in
the export. Original external DLL/SDK bytes need separate verification; a
plugin-definition hash alone does not observe their on-disk bytes.
These witnesses establish local comparison boundaries, not native parity.

Permission enforcement can be set to enforced or permissive for local experiments; this choice is visible in evidence. Live create/update/delete cannot leave the runtime without `--allow-live-writes`, and still require the separate administration switch. Task authorization is required independently of either switch.

## Views and host awareness

The sidebar groups the views: **Monitor** (Infrastructure, Overview, Live logs, Request audit, Traces, Render & diagnostics), **Data** (Data records, Data packs, Plugins & presets, Entity mappings, Endpoints), **Platform** (Providers & services, Flows & jobs, Capabilities & preflight, Backend operations, Environment, Platform rules, Settings & snippet overrides, Portal configuration), **Identity** (Portal identity & permissions, Organization identity & API, Scenarios) and **Runtime** (Runtime state, Live connection). An empty hash opens Infrastructure (`#dashboard`); an unknown one opens Overview. Each view's heading is its sidebar label, and the breadcrumb names its group. Opening a view scrolls to its top and focuses the heading; `#<view>?panel=<key>` also opens that panel, scrolls to it and outlines it briefly. Panel help shows one plain sentence, with the details behind an (i) button; column headers with an (i) explain their values.

A view is shown only when its host serves the route it needs. The page reads the host's `status.routes` (see [Status payload](#status-payload)); a host that does not publish it is probed once per session with one GET per required route, and only a 404 hides the view. Views of the portal source need the portal `page-resources` route, which only the Power Pages host serves. No view is hidden by a hard-coded host list.

**Infrastructure** (`#dashboard`, both hosts) renders [`GET /_sim/api/dashboard`](#infrastructure-feed) every 5 seconds while the tab is visible and the view is open. It shows the runtime header, KPI tiles (requests, Dataverse requests, plug-in runs, flow runs, pending jobs, messages, storage writes, outbox, diagnostics), the system map (columns Clients, Hosts, Organization, Providers and Declared externals; an edge animates when its counter moved since the last poll, except under `prefers-reduced-motion`), the **What is happening** feed of recent requests and diagnostics, a node drawer (click, Enter or Space) with the node's facts and a link to the view that manages it, a **Blocking** panel that runs `GET /_sim/api/preflight` on demand with requirement ids or globs and a strict switch, and a configuration summary (runtime, level, state file, packs, Solution layers, settings keys present, ports). The portal request ring behind the feed keeps paths without their query, and a credential route keeps nothing after its first credential segment (a segment naming a password, token, secret, invitation, confirmation or redeem step is followed by `…`), so `/_sim/` feeds never carry a token from a path.

**Providers & services** (`#services`, both hosts) has one collapsed panel per area, Storage open: storage providers and routes with their readiness and counters; messaging entities, endpoints, peek and purge (with confirmation); outbox entries with their filters; connectors, connections (id, provider, principal kind) and pending approvals; secret references (names, bound status, source kind, never values); declared local services with **Probe now** (preflight `?requires=local-service:<id>`); service fixtures; the Power Fx seam; canvas, code apps and PCF inventory; the SharePoint route.

**Flows & jobs** (`#flows`, both hosts) lists flow runs (filters by process and status; a run opens its action journal, collapsed), waits and approvals (Approve or Reject with comments; delay and webhook outputs as JSON), background work (durable jobs, scheduler status, asyncoperation rows by state, poisoned rows) and web hook outcomes with the loopback delivery rule. It reads the [flow run routes](#flow-runs-and-waits).

**Traces** (`#trace`, both hosts) lists the traces of the [trace routes](#traces) with filters, removable filter chips, KPI tiles (including the root p95 against the previous range of the same length), a timeline in local time and a breakdown by kind, module, entity, operation and actor. The list sorts by start, duration, span count or errors. A trace opens as a waterfall, a nested span tree and a **JSON** tab with the whole trace (download or copy it), with a span search and an errors-only toggle; **Copy id** and **Copy link** copy the trace id and the view's address. A span opens its attributes, events, redacted payloads, links and pivots to related traces. Tick two rows and select **Compare** (or open `#trace?compare=<id1>,<id2>`) to see both trees side by side with the duration delta of each matched span. **Export filtered traces** downloads the matching traces as NDJSON, JSON or OTLP JSON. **Live** follows the `trace` event channel on both hosts (a runtime without the channel turns Live off with a notice), and the collapsed **Settings** panel changes the level without a restart and shows a persistence failure such as `NoStateDirectory`. Request audit rows and flow run details link to their trace. See [request tracing](tracing.md#reading-a-trace).

**Capabilities & preflight** (`#capabilities`, both hosts) lists the capability report (module, kind, level, source, operation count), missing prerequisites and the records below behaviour level, and runs preflight with requirement ids or globs and a strict switch; on Power Pages each saved scenario has a **Preflight this scenario** button.

**Data packs** (`#packs`, both hosts) lists the registered packs of [`GET /_sim/api/packs`](#pack-inventory) with a per-pack detail (exports, presets, personas, DATA file ownership, diagnostics, matched status and reason), the data presets with their pack and source, and how to add or change a pack in [`/_setup/#packs`](../../docs/setup.md#journey) followed by a restart.

## Status payload

`GET /_sim/api/status` on both hosts carries:

- `routes`: the `/_sim/api` prefixes this host answers, in mounting order and without duplicates. Each shared router publishes its own list (the `routes` export of `sim-dashboard-routes.mjs`, `sim-pack-routes.mjs`, `sim-messaging-routes.mjs`, `sim-flow-routes.mjs`, `sim-trace-routes.mjs` and `sim-environment-routes.mjs`, and `router.routes` of the runtime admin router, which lists only the prefixes whose callbacks the host supplied). The prefixes a host answers itself come from the one `[prefix, handler]` table its dispatcher iterates: standalone `/preflight` and `/operations`; Power Pages `/preflight`, `/session` and the portal administration prefixes such as `/personas`, `/scenarios`, `/state`, `/diagnostics`, `/config`, `/shutdown`, `/experiments`, `/portal-settings` and `/presets`. A prefix outside these tables answers 404, and a standalone runtime never lists a portal prefix. `/__sim/events` is outside `/_sim/api` and is not listed.
- `adminAdjacentRoutes`: the model-driven routes outside `/_sim/api` that act with administration rights, such as `POST /_apps/api/webapi` (see [model-driven apps](model-driven-apps.md#routes)).
- `modelDrivenApps`: the imported model-driven apps of the Solution metadata as `{ id, uniqueName, name }` (an empty array without apps).
- `docs`: the documentation links (see [Security headers](#security-headers)).

On the Power Pages host `GET /_sim/api/state` carries `docs` as status does. Dashboard request timestamps (`activity.requests.recent[].at`, `activity.dataverseRequests.recent[].at`) are ISO 8601 UTC. A standalone runtime has no portal request ring.

## Capabilities and preflight

The runtime status (`GET /_sim/api/state`, `simulator.state()`, standalone `status()`) carries `capabilities`, the legacy summary the administration page reads (`powerPages`, `modelDriven`, `organization`, the host surface booleans and the `canvas` / `codeApps` levels), and `capabilityReport`: every capability record of the running host with its level, plus the prerequisites no record provides.

`GET /_sim/api/preflight` answers the preflight report of the running host: its live operation catalogue (with the operation modes saved in `/_sim/`), packs, capability registry, local-service probes and storage readiness, and the source graph rebuilt with the active deployment profile bindings. `?requires=<id or glob>` (repeatable) scopes it to a scenario, and `?strict=true` makes every unsatisfied requirement in scope blocking. `simulator.preflight({ scenario, strict })` returns the same report on both runtime handles. The report never includes configured values. See [Capabilities and preflight](capabilities-and-preflight.md).

Canvas apps appear as `canvasapp:<name>` capability records with their level and the `canvas-apps` record; preflight lists `canvas:app/<name>` (controls not hosted) and `canvas:rendering`.

## Messages and outbox

- `GET /_sim/api/messages` lists the local message bus entities with their counts and the `providers.messaging.endpoints` mappings; `?entity=<name>` peeks up to `max` (default 100, at most 1000) messages of one entity. Without a bus it answers `configured: false`.
- `DELETE /_sim/api/messages/<entity>` purges one entity and needs the `x-sim-csrf` header.
- `GET /_sim/api/outbox` lists the captured outbox entries; `correlationId`, `channel` and `since` filter them. It is read-only.

Credential-named values (`authvalue`, connection strings, keys, passwords, secrets, tokens) are redacted in every answer. Both hosts mount these routes before the generic administration router. See [Messaging and outbox](messaging-and-outbox.md).

## Flow runs and waits

Both hosts mount the flow run routes next to the messaging routes. They need the organization's flow run store; without it they answer `FlowRunsNotConfigured` (501).

- `GET /_sim/api/flow-runs` lists run summaries, newest first; `processId` and `status` filter them. `GET /_sim/api/flow-runs/<runId>` returns one run with its action journal, never its trigger input or secure outputs.
- `GET /_sim/api/flow-waits` lists the waiting runs and their waits; `?state=overdue` or `?state=pending` compares each `timeoutAt` with the runtime clock.
- `POST /_sim/api/flow-waits/<waitId>` answers a wait and needs the `x-sim-csrf` header: `{ outcome: 'Approve' | 'Reject', responder, comments }` for an approval, `{ outputs }` for a delay or webhook wait. It records the response and schedules the resume of the run (202); the run then replays its journal and continues. A wait that was already answered is no longer listed (`FlowWaitNotFound`, 404); a second resume of the same wait that races the first fails with `FlowRunNotWaiting` (409), reported as a `FLOW_RUN_RESUME_FAILED` diagnostic.

- `POST /_sim/api/flow-runs` starts a tracked run on demand, `POST /_sim/api/flow-triggers/<flowId>` runs an HTTP Request trigger flow and `GET /_sim/api/flow-triggers` lists the trigger hosts; see [operations](operations.md#administration-routes).

Every flow payload passes through the same credential-name redaction as the messaging routes. A mutation is refused when the runtime has no CSRF token. See [flow runs, waits and approvals](operations.md#flow-runs-waits-and-approvals).

## Traces

Both hosts mount the trace routes next to the flow run routes and answer them from the one trace store of the organization; without it they answer `TraceNotConfigured` (501).

- `GET /_sim/api/trace` lists trace summaries, newest first unless `sort` and `order` say otherwise, with the query filters of [request tracing](tracing.md#api); `GET /_sim/api/trace/spans` lists span records and `GET /_sim/api/trace/stats` answers counts, percentiles, the timeline and the slowest and error spans for the same filters. An invalid filter answers `InvalidTraceFilter` (400).
- `GET /_sim/api/trace/id/<traceId>` returns one trace as a tree (`TraceNotFound`, 404, when it is no longer retained); `GET /_sim/api/trace/<traceId>` answers the same for a UUID-shaped id. `GET /_sim/api/trace/span/<spanId>` returns one span (`SpanNotFound`, 404).
- `GET /_sim/api/trace/export?format=json|ndjson|otlp&limit=N` streams the matching traces as an attachment, at most `limit` of them (default 200, at most 2000); the `X-Trace-Export-Matched` header gives how many matched. See [Export](tracing.md#export).
- `GET /_sim/api/trace/settings` answers `{ settings, status }`; `PUT /_sim/api/trace/settings` changes the level, retention, payload cap or persistence at run time and needs the `x-sim-csrf` header (`InvalidTraceSettings`, 400, keeps the old value). `POST /_sim/api/trace/clear` drops every trace and needs the header too.

Both hosts serve the server-sent channel `/_sim/events?channels=trace`, which publishes `event: trace` frames for span starts, span ends and trace ends while a subscriber is connected. The frames carry no captured inputs or outputs, and a client that stops reading is disconnected. Captured payloads are redacted when they are recorded; secret values, tokens, cookies and sealed flow outputs never reach the store.

## Infrastructure feed

Both hosts (Power Pages and standalone model-driven or Dataverse API runtimes) answer `GET /_sim/api/dashboard` with one read-only JSON document. It is `no-store` and never carries the administration CSRF token. Every part except `activity` passes through the same credential redaction as `/_sim/api/messages`; `activity` holds numbers only (plus request `at`, `method` and `path`, storage provider `id` and `lastReloadAt`), so a diagnostic code or counter whose name looks like a credential keeps its count. `HEAD` answers like `GET` without a body; any other method answers 405 with `Allow: GET, HEAD`. The route answers 503 `{ "status": "starting" }` only for a host that has not created its organization; both hosts create it before their listener opens, so a running runtime does not answer 503.

Top-level keys:

- `generatedAt`: ISO time from the runtime clock (a fixed clock shows simulated time).
- `runtime`: `product`, `kind`, `simulationLevel`, `clock` (`system` or `fixed`), `revision` (the source reload revision on Power Pages, `null` on the standalone host), `storeRevision`, `reloading`, `localOrigin`, `stateFile` (relative to the project root, `null` for dry-run), `projectRoot` (`.`). Power Pages adds `deploymentProfile`.
- `nodes`: `{ id, kind, label, status, level?, detail, link? }`. Ids follow one scheme on both hosts: `client:*`, `host:*`, `org:store`, `org:security` (role, user and team counts), `org:plugins`, `org:workflows`, `org:flows`, `org:jobs`, `org:trace` (the trace store: `level`, `persist` and `persistError`, linking to `#trace`), `org:<module>` for every installed organization module, `provider:storage`, `provider:storage-route:<route>`, `provider:messaging`, `provider:messaging-endpoint:<entity>`, `provider:outbox`, `provider:connectors`, `connection:<id>`, `provider:secrets`, `provider:local-service:<id>`, `provider:service-fixture:<service>`, `provider:powerfx`, `app:canvas`, `app:code`, `external:azurite`, `external:servicebus-emulator`, `external:keyvault`, and one `external:webhook:<hostname>` per web hook target host (`listening` when the delivery rule contacts it: `http` or `https` to `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`; `declared` otherwise; its `detail` carries `endpoints` and the same `loopback` flag). Power Pages adds `host:portal`, `host:identity-provider`, `app:pcf`, `bridge:live` and one `persona-runtime:<id>` per running persona runtime. Status is one of `listening`, `ready`, `declared`, `disabled`, `placeholder`, `missing`, `error`, `planned`. `link` names the `/_sim/` view that owns the node.
- `edges`: `{ from, to, kind, status, label }` with kind `http`, `bus`, `storage`, `webhook`, `process` or `reads`. Each web hook target node gets a `webhook` edge from `org:plugins`. Edges are the calls the runtime really makes, traced to code. Save hooks run inside the records layer, so `org:store` points at the modules they belong to (business rules, formula and rollup columns, workflows, file storage routing and more). Web API messages and routes are dispatched by the Web API host itself, so `host:dataverse-api` points at each message module; with the listener switched off, `host:model-driven` does, because its in-app Web API runs the same messages. Background work goes through `org:jobs`, and Power Fx, storage routes, the outbox and secret references are reached from the modules that use them. The model-driven shell calls its own in-app Web API on the host origin (`/_apps/api`) in process as the staff user, so `host:model-driven` points at `org:store` and works with the Web API listener switched off. Code components call `/_api` of their portal page, or `Xrm.WebApi` of a model-driven form with trusted extensions. Visitor sign-in (`host:identity-provider`) is reached by the browser and the portal; Web API tokens come from the authority on the Web API listener. The administration reads and writes records and state, probes local services during preflight, triggers HTTP flow triggers and connects the live portal connection; setup reads the administration status views. An edge is sent only when both of its ends are on the runtime, and an edge that touches a `disabled` node is `disabled` itself: the map lists those on the card ("Switched off: would connect to …") instead of drawing them. A node that nothing calls at runtime says why in `detail.note`.
- `activity`: Dataverse API requests (`total` and `failed`: data-plane Web API requests under `/api/data/v*` since start, `$metadata` excluded; `other`: token, discovery, metadata document, SOAP and every other request on the Dataverse listener; TDS has its own listener and is not counted; the last 20 requests of any kind as `at`, `method`, `path`, `status`, `ms`), plug-in executions and failures, flow runs by status and overdue waits, durable jobs (pending, scheduled, running, recent failures, poisoned rows), asyncoperation rows by state, bus messages by state, outbox rows by state and pending byte deletes, web hook outcomes (`delivered`, `failed`, `notContacted`), storage operations per provider (`byProvider: [{ id, writes, deletes, bytesWritten }]`), diagnostics (`total`, `byCode`), the trace store (`trace`: `retained` traces, `spans`, `running`, `dropped`, `droppedSpans` and `latestSequence`; the `org:trace` drawer shows them with the node) and the raw counters. Power Pages adds the portal requests (`total` since start, `retained` ring length, at most 300; `recent` is the last 20), `audit` (`retained`, `sequence`, `dropped`) and `reloads` (`revision`, `lastReloadAt`). Standalone adds `inFlight` (requests in progress other than this one) and reports `reloads: null`.
- `configuration`: pack ids with their module directory relative to the project root, Solution layers (`solution`, `version`, `type`), `settingsKeys` (names of the registered settings authored in the catalogue site, project file or project portal that the CLI or `createMirageContext` started from, never values; `null` for a runtime embedded through `createSimulator`, whose configuration source is not known) and `ports` (`portal`, `dataverseApi`, `dataverseTls`, `tds`, `identityProvider`, each a number or `null`).
- `docs`: the documentation link map (see `status.docs`).

Counters count activity since the organization runtime started; they are not persisted. Storage counters count operations through the storage router, not what the store holds: `writes` (an overwrite is a write), `deletes` and `bytesWritten` only grow. The shared part is rebuilt after a store write, a counter change, or at most every 5 seconds so that message lock and schedule states and overdue waits follow the clock; two reads in the same 5-second window without activity return identical `nodes`. `activity.trace` is read on every request, because each traced request moves it without a store write; `nodes` carry configuration and topology only, so portal requests alone never change them. Safe facts only: service endpoint URLs appear as a hostname, connections as id, provider and principal kind (never `settings`), secrets as a key count. The feed never reads `GET /_sim/api/dataverse`, which shows the managed identity header once. Preflight is not part of the feed; call `GET /_sim/api/preflight` when you need it.

## Pack inventory

Both hosts answer `GET /_sim/api/packs` with every registered pack (project `dataPacks`, explicit catalogue or `--pack-module` entries, and module paths supplied to the API). Each pack carries `id`, `name`, `description`, `module` (relative to the project root), `registration` (`source`: `project` for a pack listed in the project file, `explicit` for a catalogue `mirage.dataPacks` entry or a `--pack-module` path, `api` for a pack passed to `createSimulator({ packs })`; `setupLink`: `/_setup/#packs`), `matched` and `matchReason`, `exports` (count per recognised export), `presets` (`id`, `name`), `configurationPresets`, `personas`, `personaCatalog` counts (`groups`, `personas`, `contexts`, `scenarios`), `dataFiles` (`file`, `tables`, `writable` when the current simulation writes it, `ownedTables`) and its export `diagnostics`. On Power Pages `matched` is the pack's `matches({ portal })` result for the current portal, so packs the portal filtered out are listed with `matched: false`; the standalone host has no portal and reports `matched: null` with `matchReason: "no portal context"`. `library` lists every data preset with its `pack` (or `null`) and `source`; `failed` lists modules that did not load. The route is read-only: `HEAD` answers like `GET` without a body, other methods answer 405 with `Allow: GET, HEAD`. Register or change packs in `/_setup/` and restart.

## Environment administration on both hosts

`GET /_sim/api/environment`, `PUT /_sim/api/environment/variables/<schemaName>` (`{ "value": "text" }`, or `null` to remove the local value) and `DELETE /_sim/api/environment/variables/<schemaName>` are served by both hosts. Writes need the `x-sim-csrf` header. A local value is kept as an override, so a Solution reload keeps it. A Secret definition accepts a Key Vault secret reference only and never shows a value. `PUT /_sim/api/environment/profiles` selects a deployment profile on the Power Pages host. The standalone host loads `deploymentProfiles` too (see [standalone organization](standalone-organization.md#shared-composition)): its `profileSelection` summarises the active profile, or answers `{ "supported": false, "reason": "…" }` when none is configured; its `PUT /environment/profiles` answers 501 with the same summary, and its `live` field says the live bridge belongs to the Power Pages host. The standalone `GET /_sim/api/diagnostics` and `status.diagnostics` carry `byCode`.

## Security headers

Both hosts serve `/_sim/` with `Content-Security-Policy: default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`. Admin assets are served by pattern: `/_sim/<name>.mjs` or `/_sim/<name>.css` where `<name>` matches `^[a-z0-9-]+$` and the file exists in `mirage/admin/`, plus the shared modules `persona-search.mjs` and `persona-picker-view.mjs` from `mirage/lib/`. The page itself answers only at `/_sim` and `/_sim/`. Modules are `text/javascript`, every asset carries `nosniff`, and any other path answers 404 on both hosts, including `/_sim/index.html`, `..` and encoded separators, backslashes, upper-case names, nested paths, server-side library modules and Windows device names such as `con.mjs`. The page allows no inline script or inline style.

`GET /_sim/api/status` carries `docs`: a map of documentation keys to `{ href, path, label }`, where `path` is the repository path and `href` points at the release tag of the installed version (`main` for a prerelease).
