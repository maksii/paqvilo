# Platform stack coverage

This page answers one question: how does Paqvilo cover the Dataverse and Power Platform stack? It names the module that owns each area, the capability level it reports, and the per-area guide that holds the contract. The four levels are defined in [Capabilities and preflight](capabilities-and-preflight.md#fidelity-levels): `inventory`, `contract`, `behaviour` and `native-qualified`. No module is `native-qualified` unless its record names a compared scenario.

## Scope boundary

Paqvilo runs one loopback organization per runtime. An area is **ours** when its behaviour or contract lives in this repository. An area is **external but reachable** when Paqvilo declares, probes and routes to a service another tool runs. An area is **out of scope** when Paqvilo only lists it, answers a documented placeholder, or leaves it to the platform.

### Ours

| Area | Module (`mirage/lib/`) | Level | Guide |
| --- | --- | --- | --- |
| Record pipeline, Web API, SOAP, TDS, metadata | `dataverse-records.mjs`, `dataverse-api.mjs`, `dataverse-soap.mjs`, `dataverse-tds.mjs`, `dataverse-metadata.mjs` | behaviour | [Dataverse API](dataverse-api.md) |
| Security model, principals, field security | `dataverse-security.mjs`, `dataverse-principal-context.mjs`, `dataverse-fls.mjs` | behaviour | [Dataverse](dataverse-parity.md) |
| Plug-ins (JavaScript handlers, CLR host), custom APIs, classic workflows | `exported-plugins.mjs`, `plugin-clr.mjs`, `dataverse-customapi.mjs`, `dataverse-workflows.mjs` | behaviour | [Dataverse plugins](dataverse-plugins.md) |
| Local identity (token issuer, application users, staff, contacts) | `dataverse-auth.mjs`, `identity-provider.mjs`, `staff-session.mjs` | behaviour | [Dataverse API](dataverse-api.md) |
| Currency, cascades (Assign), state transitions, rollups, record hierarchy | `dataverse-currency.mjs`, `dataverse-cascade.mjs`, `dataverse-state-transitions.mjs`, `dataverse-rollup.mjs`, `dataverse-hierarchy.mjs` | behaviour, with the operations each section lists at contract | [Dataverse contract modules](dataverse-contract-modules.md) |
| Calculated columns, business rules, formula columns, business process flows | `dataverse-calculated.mjs`, `dataverse-business-rules.mjs`, `dataverse-formula.mjs`, `dataverse-bpf.mjs` | contract (behaviour when pack overrides or an evaluator cover every column or rule) | [Dataverse contract modules](dataverse-contract-modules.md) |
| Virtual tables | `dataverse-virtual-providers.mjs` | behaviour for reads and writes a registered provider implements; contract (501 `VirtualProviderMissing`) without a provider unless `fallback: 'local'` is declared; external events contract | [Dataverse contract modules](dataverse-contract-modules.md) |
| Power Pages host and model-driven host | `../server.mjs`, `dataverse-model-driven.mjs`, `model-driven/` | behaviour | [Model-driven apps](model-driven-apps.md) |
| Connector runtime (`dataverse`, `http`, `fixture`, `pack:<id>`, `memory-queue`, `approvals`) | `connector-runtime.mjs` | behaviour; native outcome shapes of queues and approvals at contract | [Operations](operations.md#connections-and-connectors) |
| Cloud flow interpreter, runs, waits, retries, child flows | `flow-runtime.mjs`, `flow-runs.mjs`, `flow-triggers.mjs` | behaviour (bounded); approval outcome shape and run-history parity at contract. Recurrence triggers and on-demand HTTP Request triggers are behaviour; pack `flowTriggers` connector triggers and pack `flowActions` action types are contract | [Operations](operations.md#flow-runs-waits-and-approvals) |
| Environment variables and Secret references (Key Vault reference semantics) | `secret-resolver.mjs` | behaviour; no registry record, `describe(reference)` reports status only | [Deployment profiles](deployment-profiles.md) |
| Storage provider contract, local-disk and in-memory providers, routing of Dataverse files, notes and portal files | `storage-provider.mjs`, `storage-local-disk.mjs`, `storage-memory.mjs`, `dataverse-storage-routing.mjs` | behaviour | [Storage providers](storage-providers.md) |
| Local message bus, service endpoint contracts 2, 5 and 6, outbox capture | `message-bus.mjs`, `dataverse-webhooks.mjs`, `outbox.mjs` | behaviour | [Messaging and outbox](messaging-and-outbox.md) |
| SharePoint document integration rows | `sharepoint-documents.mjs` | the level of its storage route; Power Pages document control at contract (documented operations and permissions over a local route and markup) | [SharePoint documents](sharepoint.md) |
| SharePoint and Graph REST | `sharepoint-contract.mjs` | contract (mounted only by a declared connection) | [SharePoint documents](sharepoint.md) |
| Canvas apps | `canvas-source.mjs`, `canvas-runtime.mjs`, `canvas-controls.mjs`, `canvas-http.mjs` | behaviour (logic), inventory (rendering). Screens, controls, formulas, Dataverse and connector data sources, behaviour functions and navigation run headlessly at `/_apps/canvas/<app>` and `POST /_apps/api/canvas/<app>` as the staff user or mapped portal user; apps are not rendered (`canvas:rendering`) | [Canvas apps](canvas-apps.md) |
| Power Fx engine | `power-fx.mjs`, `power-fx-functions.mjs`, `power-fx-dataverse.mjs`, `canvas-power-fx.mjs` | behaviour. Formula columns, Dataverse Functions, automated low-code plug-ins and canvas apps evaluate on it; a pack `powerFx` adapter replaces it, and with the engine disabled the Functions and plug-ins answer 501 `PowerFxEvaluatorMissing` | [Canvas apps](canvas-apps.md#power-fx) |
| Power Pages enhanced authorization | `portal-authorization.mjs` | behaviour. Mapped Dataverse users and security roles, privilege-checked table permissions, column security profiles; scope depth mapping not documented (fidelity note on `portal:enhanced-authorization`) | [Dataverse](dataverse-parity.md) |
| Mobile offline (simulated device) | `model-driven/offline.mjs`, `model-driven/client-runtime.mjs` (`model-driven:offline`) | behaviour. An app with a Solution mobile offline profile goes offline per staff session; `Xrm.WebApi.offline` reads and writes the downloaded copy and going online replays the queued writes through the Web API. Profile filters the simulator cannot evaluate keep a `model-driven:offline/<profile>` requirement row; the Power Apps mobile client is not run | [Model-driven client API](model-driven-client-api.md) |
| Code apps | `code-apps-config.mjs`, `code-apps-http.mjs`, `code-apps-client.js` | contract | [Code apps](code-apps.md) |
| Custom connector OpenAPI definitions | `solution-inventory.mjs` (listing), `custom-connector.mjs` (compiler), `connector-runtime.mjs` (provider) | contract: OpenAPI 2.0 operations with JSON, urlencoded and multipart bodies, API key/basic/static OAuth, OAuth client credentials and authorization code auth, the policy templates listed in [Operations](operations.md#connections-and-connectors) and C# custom code through the local .NET SDK run against loopback services or pack `httpFixtures`; other policies, other body media types and other OAuth flows are refused. A connector listing rises to contract when its definition compiles without diagnostics; a blocking compilation diagnostic makes its preflight row unsupported with that code | [Operations](operations.md#connections-and-connectors) |
| Other Solution components | `solution-inventory.mjs` | inventory | [Bootstrap and sources](bootstrap-and-sources.md#solution-inventory) |

### External but reachable

| Area | Module (`mirage/lib/`) | Level | How |
| --- | --- | --- | --- |
| Azure Functions, API Management | `connector-runtime.mjs` (`http` provider), `local-services.mjs` | contract (`local-service:<id>`) | A connection's `settings.rewrites` maps the cloud URL prefix to a loopback service; `localServices` declares and probes it. Run Functions with Core Tools outside Paqvilo. Pack `httpFixtures` answer without a process. |
| Azurite | `storage-azurite.mjs` | behaviour (contract without a usable connection string) | Core Blob REST transport with Shared Key authorization over native `fetch`, loopback endpoints only. `providers.storage` with `kind: azurite` is instantiated by core; preflight sends an authorized List Containers. An unset, invalid or non-loopback connection string answers `Unavailable` with its reason. Qualified by the shared storage contract suite against a loopback fake with real signature verification. |
| Service Bus emulator | `message-bus.mjs` (`message-bus:servicebus-emulator`), `amqp-client.mjs` | behaviour | Core AMQP 1.0 client over loopback TCP with SASL PLAIN: send to queues and topics, peek-lock and receive-and-delete receive from queues, subscriptions and dead-letter queues, complete, abandon and dead-letter. Preflight connects and attaches a link to each mapped entity within 2 seconds. No AMQP WebSockets, JMS, partitioned entities, sessions, peek or lock renewal. Mirage never starts the emulator; a real-emulator run is a manual check. |
| Key Vault | `secret-resolver.mjs` | behaviour for reference resolution | A Secret environment variable's Key Vault reference resolves through the project `secrets` map to an environment variable or a Windows DPAPI-protected value. No vault is contacted. |

Paqvilo never starts these processes. Every outbound call goes through `loopbackFetch`, so a cloud host is refused rather than reached. See [Operations](operations.md#local-services).

### Out of scope

| Area | Module (`mirage/lib/`) | Level | Boundary |
| --- | --- | --- | --- |
| Power BI rendering | `service-fixtures.mjs`, `platform.mjs` (`powerbi` Liquid placeholder) | inventory when disabled, contract with a pack fixture | The embed is a placeholder or a project fixture, never a report. |
| AI Builder and model inference | `service-fixtures.mjs`, `dataverse-addon-ai.mjs` | inventory when disabled, contract with a pack fixture | No model runs. The Dataverse AI messages answer a documented error unless a pack `dataverseMessages` handler replaces them. |
| Copilot and agent orchestration | `service-fixtures.mjs`, `dataverse-addon-pva.mjs` | inventory when disabled, contract with a pack fixture | No orchestration runs. The Copilot Studio Dataverse messages answer a documented error or the not-simulated default unless a pack handler replaces them. |
| Tenant administration, MFA, Conditional Access, PAC deployment, Fabric and DAX, desktop flow runtime | none | — | Use the platform and its own tools. |
| Custom pages (canvas app pages in model-driven apps) | `model-driven/catalogue.mjs` (`model-driven:custom-page`), `model-driven/solution.mjs` (`MD_NAV_CUSTOM_PAGE`) | inventory | Needs the canvas app player. SiteMap entries stay disabled and `navigateTo` rejects with `CustomPageUnsupported`. |

[Service fixtures](service-fixtures.md) describes the disabled-by-default mechanism.

## Fidelity ladder

Each module states its level through a capability record. The same records reach every consumer:

1. **`describe()`**: an `EXTENSIONS` entry, provider or run store returns its record. `describe(api)` receives the runtime's api, so a module reports what this runtime wired. A calculated-column module covered by pack functions reports `behaviour`; the same module without them reports `contract`.
2. **Capability registry** (`capability-registry.mjs`): each host builds one registry in `organization-host.mjs` from the host surfaces, the installed modules, the operation catalogue (with the modes saved in `/_sim/`), the connector, storage, messaging, outbox, Power Fx and local-service providers, service fixtures, the flow run store, the Solution inventory and pack `capabilities` records. Operation modes map to levels: `placeholder` and `disabled` to `inventory`, `mock` to `contract`, `exported`, `handler`, `clr` and `webhook` to `behaviour`.
3. **Runtime status**: `GET /_sim/api/status`, `simulator.state()` and the standalone `status()` carry `capabilities` (the legacy summary) and `capabilityReport` (every record with its level).
4. **Preflight**: `paqvilo mirage preflight`, `preflight()` from `paqvilo/mirage`, `GET /_sim/api/preflight` and `simulator.preflight()` combine the registry with the source graph requirements and say what blocks a scenario. Strict acceptance (`--requires`, `--strict`) fails the run before any browser starts when a required capability is missing or below `behaviour`.

A placeholder never reports success. It answers a documented `501` or diagnostic and is recorded at `inventory` or `contract`.

## Module map

Runtime modules are flat files in `mirage/lib/`; `model-driven/` holds the model-driven client assets. The layers below run from sources to providers.

### Source graph

| File | Role |
| --- | --- |
| `importer.mjs` | Reads standard, enhanced and code-site portal exports. |
| `solution-roots.mjs`, `solution-schema.mjs`, `solution-metadata.mjs`, `solution-data.mjs` | Select Solution layers (folders or ZIP) and read tables, metadata and data. |
| `solution-inventory.mjs` | Lists components Paqvilo reads but does not host (canvas apps, custom connectors, and others). |
| `source-graph.mjs` | Read-only index over the loaded sources with one `resolve()` precedence rule and `requirements()` for preflight. |
| `deployment-profiles.mjs` | Exported environment variable values and connection reference bindings. |
| `solution-runtime-source.mjs`, `solution-cache.mjs` | Load Solution sources for a runtime and cache them per fingerprint. |

### Organization core

| File | Role |
| --- | --- |
| `data.mjs` | `DataStore`: tables, transactions, revisions, persistence. |
| `dataverse-organization.mjs` | `createOrganizationRuntime`: the organization api, principals, settings, `api.providers` and `api.packExport`. |
| `dataverse-extensions.mjs` | The ordered `EXTENSIONS` list installed into every organization. |
| `dataverse-records.mjs`, `dataverse-security.mjs`, `dataverse-metadata.mjs` | Record pipeline, security checks and metadata. |
| `dataverse-calculated.mjs` … `dataverse-bpf.mjs` | Contract modules ([Dataverse contract modules](dataverse-contract-modules.md)). |
| `exported-plugins.mjs`, `plugin-clr.mjs`, `plugin-async.mjs` | Plug-in steps (shared execution depth), the CLR host and asynchronous steps. |
| `dataverse-workflows.mjs`, `dataverse-customapi.mjs`, `dataverse-async.mjs` | Classic workflows, custom APIs and system jobs. |
| `organization-backend.mjs`, `committed-work.mjs` | Post-commit work: plug-in, workflow, flow trigger and web hook jobs. |

### App hosts

| File | Role |
| --- | --- |
| `../server.mjs` | Power Pages host: Liquid, portal Web API, forms and lists, `/_sim/`. |
| `standalone-runtime.mjs` | Solution-only host: model-driven and API-only runtimes. |
| `organization-host.mjs` | `composeOrganizationHost`, used by both hosts. |
| `dataverse-api.mjs` | The Dataverse HTTP listener (Web API, SOAP, token service, discovery). |
| `dataverse-model-driven.mjs` | Model-driven app host. |
| `canvas-http.mjs`, `code-apps-http.mjs` | Placeholder and contract surfaces under the reserved `/_apps/canvas/` and `/_apps/code/` prefixes. |
| `runtime-admin.mjs`, `sim-flow-routes.mjs`, `sim-messaging-routes.mjs` | `/_sim/api/*` administration shared by both hosts. |
| `pages-client-api.js` | The `$pages` client API and the modern list and document grid adapters, loaded right after the page runtime script (inline on pages that load the platform bundles). |
| `portal-search.mjs` | Power Pages global search: the `searchindex` tag and the default `/search/` page. |

### Administration and dashboard

| File | Role |
| --- | --- |
| `runtime-counters.mjs` | `createCounters()`: O(1) named activity counters with `snapshot()` and a `tick` that moves on every change. The organization runtime attaches one set as `store.counters`; the Dataverse listener (`dataverseRequests`, `dataverseRequests.failed`, `dataverseRequests.other`), web hook delivery (`webhooks.*`), plug-in steps (`plugins.*`) and the storage router (`storage.<id>.writes`, `.deletes`, `.bytesWritten`) increment it. Counts start at zero with the runtime and only grow. |
| `organization-host.mjs` `topology()` | The shared dashboard topology of both hosts: nodes, edges, activity and the configuration summary from the capability registry, providers, configured connections (id, provider, principal kind), the Dataverse listener and single passes over the bus, outbox, flow run and asyncoperation tables. Built by named builders (listener, organization, providers, externals, configuration, activity); web hook targets become `external:webhook:<hostname>` nodes through the delivery rule `isLoopbackUrl`. Memoised on the store revision, the counters tick and a 5-second time bucket. |
| `sim-dashboard-routes.mjs` | `GET /_sim/api/dashboard`: the topology plus host extras, `no-store`, without the CSRF token; everything but `activity` is redacted and `activity` is reduced to numbers (`activityFacts`); 503 `starting` only for a host without an organization. See [Simulation administration](sim-administration.md#infrastructure-feed). |
| `sim-pack-routes.mjs` | `GET /_sim/api/packs` (`GET`/`HEAD`): registered packs with registration source (`project`, `explicit`, `api`), exports, presets, personas, DATA file ownership, diagnostics and portal match. |
| `sim-environment-routes.mjs` | Environment variable table, local overrides and the deployment profile selection shared by both hosts; a piece a host cannot serve answers `{ supported: false, reason }`. |
| `docs-links.mjs` | `docsLinks(version, repositoryUrl)`: documentation keys mapped to `{ href, path, label }` for `/_sim/` and `/_setup/`. |
| `runtime-admin.mjs` `ADMIN_CSP`, `adminAssetFile()`, `SHARED_ADMIN_MODULES`, `diagnosticsByCode()` | The `/_sim/` Content-Security-Policy, the pattern-based admin asset lookup with its set of shared `mirage/lib/` modules, and the per-code diagnostic count both hosts use. |
| `config-keys.mjs` `configuredSettingKeys()` | Names of the registered settings authored in the resolved catalogue site, project and project portal; the CLI and `createMirageContext` pass them as `configuredSettings` for the dashboard `settingsKeys`. |

### Connections and connectors

| File | Role |
| --- | --- |
| `operation-catalogue.mjs`, `exported-operations.mjs` | Server logic and cloud flow inventory, modes and portal-triggered runs. |
| `connector-runtime.mjs` | Resolves a connection reference to a connection, principal and provider, then invokes it (with retries). |
| `flow-runtime.mjs`, `flow-runs.mjs`, `flow-triggers.mjs` | The flow interpreter, tracked runs and row triggers. |
| `secret-resolver.mjs`, `local-services.mjs` | Secret references and declared loopback services. |

### Providers

| File | Role |
| --- | --- |
| `storage-provider.mjs`, `storage-local-disk.mjs`, `storage-memory.mjs`, `storage-azurite.mjs` | Storage contract, router and providers. |
| `dataverse-storage-routing.mjs`, `dataverse-files.mjs` | Route file, image and note bytes to storage. |
| `message-bus.mjs`, `outbox.mjs` | Local queues and topics, the outbox. |
| `sharepoint-documents.mjs`, `sharepoint-contract.mjs` | SharePoint document rows and the Graph contract fixture. |
| `service-fixtures.mjs`, `canvas-power-fx.mjs` | Disabled-by-default services and the Power Fx entry point. |

## Cross-cutting seams

| Seam | File | Contract |
| --- | --- | --- |
| Request context | `request-context.mjs` | `createRequestContext` builds one context per inbound call and per run it starts (`initiator`, `principal`, `correlationId`, `parentId`, `depth`, `mode`, `clock`, `ids`, `child()`). `runWithRequest` stores it in the organization AsyncLocalStorage; `currentRequest()` reads it. `x-ms-correlation-request-id` becomes the correlation id of the committed events. |
| Clock, ids, scheduler | `runtime-clock.mjs` | `systemClock`, `systemIds`, `fixedClock`, `sequentialIds`, `createScheduler({ clock, manual, faults })` and `storeScheduler(store)`. Every timer of a runtime runs on its one scheduler. See [Public API](../../docs/public-api.md#clock-ids-and-scheduler). |
| Durable committed jobs | `committed-work.mjs` | `committedJobs(store)` runs plug-in, workflow, flow trigger and web hook jobs as `asyncoperation` rows, FIFO. `resume()` recovers rows left Locked by a crash (`COMMITTED_JOB_RECOVERED`, at-least-once); a job whose transaction rolls back three times ends Failed (`COMMITTED_JOB_POISONED`). Every committed-event consumer (asynchronous plug-in steps and web hooks, row-triggered flows, classic background workflows) stages its jobs through one helper, `stageCommittedJobs`, inside the triggering transaction (a `DataStore.addCommitStager` stager calling `committedJobs(store).stage(entries)`), so a commit carries its jobs; per-chain counts, diagnostics and the runner start apply only after that commit. Jobs are only staged inside a transaction; there is no out-of-transaction enqueue. A classic workflow's background run (mode 0 trigger on create, update or delete) is a committed job of kind `workflow`: its Ready asyncoperation row is written inside the triggering transaction, so a rolled-back write starts nothing, and the store's job runner claims it (Locked, In Progress), runs it like any classic run and completes it Succeeded, Failed or Canceled. The row carries `operationtype` 10 (Workflow) from staging to completion. Ready rows resume after a restart. |
| Settings | `config-keys.mjs` | `MIRAGE_SETTINGS` is the one settings table; `runtimeOptions()` assembles runtime options and `runtimeIdentity()` decides reuse. See [Configuration](../../docs/configuration.md#settings-table). |
| Pack exports | `pack-exports.mjs` | `PACK_EXPORTS`, `registerPackExport`, `validatePackExports` (`PACK_EXPORT_UNKNOWN`) and `collectPackExport`. See [Data packs](data-packs.md). |
| Providers object | `organization-host.mjs` (`composeProviders`) | `api.providers` is frozen with `storage`, `messaging`, `outbox`, `connectors`, `secrets`, `serviceFixtures`, `powerFx` and `localServices`; an unconfigured provider is `null`. Modules read it in `install(api)` when no explicit option is given. `messaging` carries `bus` (the local bus) and `buses` (every declared provider by id: `local-queue` ids share the local table, a `servicebus-emulator` id is the core AMQP bus unless a pack exports a `servicebus-emulator` factory, pack kinds come from pack factories). Pack factories are called once per host. `composeProviders` and `composeOrganizationHost` return promises; a composition failure settles and closes the providers it created first. `closeProviders`/`settleProviders` run their `settle()`/`close()` with the host, every provider attempted; failures aggregate into `PROVIDER_CLOSE_FAILED`/`PROVIDER_SETTLE_FAILED` and the next `closeProviders` or host `close()` retries only the providers whose close failed, without settling them again. |
| Host composition | `organization-host.mjs` (`composeOrganizationHost`) | Handler maps, memoised catalogues, providers, flow run store, extensions, backend, Dataverse API, operation-mode selection, `settle()`, `close()` (backend, flow run timers, organization, API, managed identity, then the instantiated providers), `capabilities()`, `preflight()`, `loadExtensions()`, `loadCanvas()`, `refreshSources()` (reload re-registers the Solution source modules), `simulationReport()` (adds the blob directory target) and `topology()`. `composeHostDescription()` is the listener-free composition the offline preflight uses; `hostSurfaces()`, `graphBindings()` and `providerRequirements()` are shared by both hosts and the description. |
| Outbound HTTP | `dataverse-webhooks.mjs` (`loopbackFetch`) | Loopback hosts only (a name must resolve only to loopback addresses), no redirects. Used by web hooks, the `http` provider and local-service probes. |

## Extend the stack

**A new provider.** A storage provider implements the operations in `STORAGE_OPERATIONS` (`put`, `commit`, `get`, `head`, `delete`, `list`, `sas`) and passes `runStorageContract` from `paqvilo/mirage/testing`. A project registers it through the pack `storageProviders` export and selects it with `providers.storage.<id>.kind: 'pack:<packId>/<name>'`; `composeProviders` calls `factory({ id, kind, settings, stateDirectory, clock, ids })` once per host, checks the provider shape and that `descriptor.id` equals the id, and closes it with the host. Message providers use `messageProviders` the same way (`factory({ id, kind, settings, store, clock, ids, organizationUri })` returning a bus with `send()`, reachable through `providers.messaging.endpoints`); outbox observers use `outboxHandlers` with `providers.outbox.kind: 'pack:<packId>'`. A factory that throws fails host start with `PROVIDER_FACTORY_FAILED` naming the pack, after the providers created before it are closed. Each factory input also carries `own(resource)`: a factory registers a resource it opened (an object with optional `settle()` and `close()`), and a failed composition settles and closes it with the instances created before the failure and the rejected instance; a rejected instance is never returned. Connector providers use `connectors` with a `pack:<id>` connection. Each provider returns a descriptor with its level, so the registry and preflight list it. See [Storage providers](storage-providers.md) and [Messaging and outbox](messaging-and-outbox.md).

**A new contract module.** Add a flat `mirage/lib/dataverse-<area>.mjs` with an `EXTENSIONS` entry `{ name, install(api), reset?(api), close?(api), describe(api) }`, and place it in `dataverse-extensions.mjs`. Follow these rules:

- State the honest level in `describe(api)`. Report `behaviour` only for what this runtime executes, and list the rest as operations at `contract`.
- Mark native behaviour you have not confirmed with a `// unverified:` comment and a documented assumption.
- A placeholder or unsupported path answers a documented `501` or diagnostic. It never succeeds.
- Read pack overrides with `packOverrides(api, name)` and report repeated diagnostics once with `onceReporter` (`dataverse-addon-common.mjs`).
- Register the setting parser or pack export when the module loads, and import the module from `provider-modules.mjs`.

**A new pack export.** Call `registerPackExport(name, { check, key?, entries?, collide? })` in the owning module. Until the module loads, the export is checked only for shape and reported as `PACK_EXPORT_PENDING`. Add any new public export to `test/fixtures/public-api.json`.

## Tests

- Unit and integration tests are `mirage/test/<area>.test.mjs` on the Node test runner. They use invented schemas and `x_` prefixes, port 0, temporary directories and loopback fixtures only.
- Contract modules share `mirage/test/contract-module-fixture.mjs`, which starts a loopback Dataverse API with the module installed.
- Storage providers run the shared contract suite (`runStorageContract`, `STORAGE_CONTRACT_CASES`); `mirage/test/storage-provider-contract.test.mjs` runs it against the core providers.
- The write-volume gate `mirage/test-volume/write-volume.test.mjs` is outside the ordinary suite; see [Runtime performance](runtime-performance.md).
- `test/public-api.test.mjs` pins the public exports listed in `test/fixtures/public-api.json`.
