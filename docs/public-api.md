# Public programmatic API

The entry points below are Paqvilo's supported programmatic API. Removing or incompatibly changing a
listed export requires a major version change; `test/fixtures/public-api.json` pins the guaranteed
names. Modules reached through the `./mirage/*` and `./lense/*` wildcard exports (for example
`paqvilo/mirage/lib/data.mjs`) are implementation details, with three exceptions that `test/public-api.test.mjs`
keeps working: `paqvilo/mirage/lib/code-apps-client.js` (the same names as `paqvilo/mirage/code-apps/client`),
`createSimulator` from `paqvilo/mirage/server.mjs` and `loadCatalogue` from `paqvilo/lense/config.mjs`.

| Import                            | Exports                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `paqvilo/mirage`                  | `createSimulator`, `DataStore`, `DataError`, `readStateFile`, `initialState`, `discoverSolutionRoots`, `resolveSolutionRoots`, `importSolutionData`, `applySolutionData`, `migrateScenarioState`, `discoverPacks`, `loadPack`, `presetLibrary`, `createMirageContext`, `loadSourceGraph`, `preflight`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `paqvilo/mirage/acceptance`       | `runAcceptance`, `verifyParity`, `compareReferenceContracts`, `simulatorBackgroundRequest`, `observePageLifecycle`, `observeContextLifecycle`; browser launch (`browserChannel`, `browserLaunchOptions`, `captureLaunchOptions`, `windowsLaunchOptions`, `BROWSER_HANG_GUARD_MS`, `CHROMIUM_DISABLED_FEATURES`, `CHROMIUM_DEFAULT_DISABLED_FEATURES`); fingerprints and evidence (`sourceFingerprint`, `cachedSourceFingerprint`, `implementationSourceFingerprint`, `cachedImplementationSourceFingerprint`, `stateFingerprint`, `implementationEvidence`, `observedEvidence`); request and navigation classifiers (`reconcileSupersededRead`, `correlateNetworkConsole`, `classifyNativeNetworkFailures`, `validateNativeNetworkBaseline`, `classifyNavigationObservations`); runner helpers (`AssetCache`, `validateLivePath`, `decodePagingCookie`, `collectFetchXmlPages`, `escapeXmlAttribute`, `auditQuery`); rich text (see [below](#shell-capture-and-rich-text))                                                              |
| `paqvilo/mirage/packs`            | `validatePack`, `loadPack`, `discoverPacks`, `presetLibrary`, `presetDescriptor`, `defineLazyPreset`, `bootstrapPresetLibrary`, `compactBuiltinPresets`, `listPresets`, `resolvePreset`, `configurationPresetDiagnostics`, `assertReadOnlyPath`, `DENIED_ROUTE_PATTERNS`, `validatePlan`, `activatePackDeniedRoutes`, `validatePersonaCatalog`, `mergePersonaCatalogs`, `PACK_EXPORTS`, `validatePackExports`, `collectPackExport`, `packProvides` ([data packs](../mirage/docs/data-packs.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `paqvilo/mirage/fixtures`         | `formatMockRecord`, `mergeDataset`, `findDanglingLookups`, `schemaViolations`, `fieldIndexFromMappings`, `schemaFieldIndex`, `formatViolations`, `assertOfflineState`, `readStateFile`, `stateFileFingerprint`, `importPortal`, `createPortalRenderer`, `generateDataset`, `summarizeDataset`, `generateSchemaDeclarations`, `remapDatasetIdentities`, `comparePluginRegistrations`, `comparePermissionModels`, `buildPermissionModel`, `parsePluginDocument`, `importSolutionPlugins`, `inspectFlowExpression`, `evaluateFlowTriggerConditions`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `paqvilo/mirage/testing`          | `signInHeaders`, `signInContext`, `connectRuntime`, `createPortalSession`, `createPersonaSession`, `createPersonaBrowserContext`, `runSessionMatrix`, `runStorageContract`, `STORAGE_CONTRACT_CASES`, `fixedClock`, `sequentialIds`, `createScheduler`, `replayParityDirectory`, `replayParityCases`, `buildParityCases`, `validateParityCases`, `loadParityCases`, `diffParityOutput`, `compareVerificationWitnesses`, `createFixtureRecipes`, `captureCanvasDraftInputContract`, `captureCodeAppContextContract`, `captureCodeAppContextCacheContract`, `captureModelDrivenContract`, `captureModelDrivenControlContract`, `captureModelDrivenDirtyContract`, `captureModelDrivenPresentationContract`, `capturePowerPagesClientContract`, `capturePowerPagesControlContract`, `captureWebApiInputContract`, `webApiInputContractCases`, `webApiScalarReaderCases` (capture and case exports: [frontend contract recording](../mirage/docs/parity-evidence.md#record-frontend-contracts); [replay cases](test-kinds.md#replay-cases)) |
| `paqvilo/mirage/code-apps`        | `createCodeAppSdkExecutor` ([Code Apps](../mirage/docs/code-apps.md#develop-sdk-apps-with-vite-and-the-workbench))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `paqvilo/mirage/code-apps/vite`   | `codeApps`, `quietDependencySourcemaps`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `paqvilo/mirage/code-apps/client` | `configure`, `getStatus`, `getContext`, `getToken`, `dataClient`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `paqvilo/lense`                   | `loadCatalogue`, `loadConfig`, `loadDevTargets`, `resolveMirageConfig`, `resolveCatalogue`, `analyzeProject`, `analysisRules`, `analysisCapabilities` ([static analysis](static-analysis.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `paqvilo/dataverse`               | `DataverseClient`, `connectedClient`, `loadConnection`, `publicConnection`, `registerApplication`, `connectExistingApplication`, `saveProtectedState`, `loadProtectedState`, `readPowerPagesSites`, `readPowerPagesSite`, `setPowerPagesSiteVisibility`, `readManifest`, `validateManifest`, `compileManifest`, `planManifest`, `applyManifest`, `publishManifest`, `checkKeys`, `exportSolution`, `completeLookupAuditing`, `scopeSolutionRoots`, `readCatalogue`, `validateCatalogue`, `planData`, `applyData`, `compareData`, `runDataQueries`, `retrieveFetchXml` ([Dataverse toolkit](dataverse-provisioning.md))                                                                                                                                                                                                                                                                                                                                                                                                                  |

A listed function or class called without an argument it requires throws (an asynchronous one rejects) with a
`TypeError` that names the call and the argument, such as `TypeError: readStateFile(file) requires a state file path.`
or `TypeError: new DataverseClient({ environmentUrl, token }) requires an options object with environmentUrl and token.`
A `connectRuntime()` handle method does the same and sends no request
(`TypeError: runtime.records(table, query) requires a table logical name.`). Exports whose arguments are all optional
run with their defaults instead. The `capture*Contract` exports of `paqvilo/mirage/testing` are excluded: their source
is pinned evidence, so they do not check their arguments.

`loadCatalogue({ config, cwd })` reads `config`, else `paqvilo.config.yml` in `cwd` (default: the working directory);
when that file does not exist it throws an error with code `CONFIG_NOT_FOUND`. Only a `source` or `project` selection
without `site` runs without a catalogue.

The three Code Apps entry points ship TypeScript declarations; `codeApps(options?)` is the
development-only Vite plugin for a local Mirage workbench, and the client exports are the typed
lower-level APIs for application-owned service adapters.

## Clock, ids and scheduler

`createSimulator` (Power Pages and standalone hosts) accepts `clock` (epoch milliseconds, a function or
`{ now() }`), `ids` (`{ uuid() }`) and `scheduler`, and shares them with its state store, organization
runtime, asynchronous jobs and committed-work backend; `DataStore` also takes `clock` and `ids` directly.
`paqvilo/mirage/testing` exports:

- `fixedClock(startMs)`: `now`, `advance(ms)`, `set(ms)`.
- `sequentialIds(namespace)`: valid version 5 GUIDs over a counter; `namespace` is an optional GUID.
- `createScheduler({ clock, manual, faults })`: `schedule`, `cancel`, `pending`, `runDue`, `advance`,
  `drain`, `close`, `status`.

With a fixed clock and sequential ids, row ids, `createdon`/`modifiedon`, audit rows, plug-in trace logs
and web hook payloads repeat byte for byte. A manual scheduler runs durable jobs only on `runDue()` or
`advance(ms)`, which run due tasks in order, one at a time, and return once started tasks have settled
or are blocked. A task is blocked when it awaits a task it queued that is not yet due (such as a
connector retry pause): `status().blocked` counts it, `status().pending` and `drain()` leave it out, and
the `advance(ms)` that makes the queued task due lets it finish. A task that queues and awaits a due task
finishes in the same `runDue()`. Defaults are wall time, random GUIDs and real timers.

## Named deterministic recreation

```js
import { createFixtureRecipes } from 'paqvilo/mirage/testing';

const recipes = createFixtureRecipes({
  baseline: { state, epochMs: Date.UTC(2026, 0, 1), namespace },
});
const fixture = recipes.create('baseline');
// Pass fixture.state/clock/ids/scheduler to a fresh local runtime.
// Close that runtime and fixture.scheduler when the project test finishes.
```

Definitions (at most 100) are captured as cloneable data. Each `create` returns fresh state, a fixed
clock, a fresh id sequence and an idle manual scheduler; mutating one fixture affects nothing else.
Recreation does not rewind an active runtime, restore provider closures or resurrect timers: the project
rebuilds providers and tears down the old runtime. Runtime callbacks, shared-memory buffers, views and
WebAssembly memory (also nested in an Error `cause`) are rejected; ordinary array buffers are copied.

## Inspect Solution sources

```js
import { loadSourceGraph } from 'paqvilo/mirage';
const graph = await loadSourceGraph({
  solutionRoots: ['./solutions/Core', './solutions/Extension'],
  solutionOrder: 'explicit',
});
graph.resolve('canvasapp', 'x_inventedapp'); // node from the later selected layer, or null
graph.requirements(); // [{ id, kind, source, status: 'satisfied'|'missing'|'placeholder'|'unsupported'|'disabled', reason }]
graph.summary(); // { nodes, levels, kinds: { kind: { level: count } } }
```

`loadSourceGraph({ solutionRoots, solutionOrder = 'derived', sourceDir, lcid = 1033, bindings })` reads
the roots once (and the portal export with `sourceDir`) into a read-only graph. `bindings` takes
deployment-profile values (`{ connectionReferences: [{ logicalName, connectionId }], environmentVariables }`)
that settle requirements. Node ids are `<kind>:<lower-case key>`. `JSON.stringify(graph)` gives
`{ fingerprint, summary, nodes }` without variable values or connection ids. Kinds and statuses:
[Solution inventory](../mirage/docs/bootstrap-and-sources.md#solution-inventory).

## Preflight

```js
import { preflight } from 'paqvilo/mirage';
const report = await preflight({
  runtime: { kind: 'dataverse-api' },
  solutionRoots: ['./solutions/Core'],
  scenario: { id: 'approval', requires: ['cloud-flow:*', 'table:x_item'] },
});
report.summary.blocking; // 0 when nothing in the scenario's scope blocks
```

`preflight(options)` returns the report of `paqvilo mirage preflight --json` without exiting. It takes
the `createSimulator` options `runtime`, `simulation`, `solutionRoots`, `solutionOrder`, `sourceDir`,
`dataPacks`, `environmentVariables`, `deploymentProfiles`, `localServices` and `providers`, plus
`scenario`, `strict` and `env` (where `env:NAME` references resolve; default `process.env`). See
[capabilities and preflight](../mirage/docs/capabilities-and-preflight.md).

A running simulator answers the same report for its live state through `simulator.preflight({ scenario, strict })`
and `GET /_sim/api/preflight`, including operation modes saved in `/_sim/`. `simulator.state()` (standalone:
`status()`) carries the registry as `capabilities` and `capabilityReport`. `simulator.settle()` resolves once
every committed-event job (asynchronous plug-in steps, web hooks, row-triggered flows, due scheduled jobs)
has run and the pack providers have settled; await it rather than the store queue.

`GET /_sim/api/dashboard` is a read-only, redacted topology and activity document
([health feed](../mirage/docs/sim-administration.md#health-feed)). Its counts come from the runtime's
in-memory counters, start at zero and are not persisted.

## Persona catalogues

Version 1 [persona catalogues](../mirage/docs/persona-catalog.md), `validatePersonaCatalog` and
`mergePersonaCatalogs` are public. `connectRuntime` adds catalogue management, context launch and
owned-runtime lifecycle; `createPersonaSession` and `createPersonaBrowserContext` select contact-derived
identities and apply isolated setups for tests.

## Render local pages within a budget

Local Liquid rendering has a 60,000 ms budget: `mirage.render.timeLimitMs` in the catalogue, or
`render: { timeLimitMs }` for `createSimulator` and `createPortalRenderer` (1–3,600,000).
`/_sim/api/status` reports the effective value; an overrun returns HTTP 500 with
`local render time limit of <n> ms exceeded`. Liquid yields between nodes and loop iterations, but a
synchronous FetchXML query is checked only after it returns (it stays subject to the query complexity and
join-row limits). Within one render Mirage reuses planned FetchXML and permission-filtered inputs and
indexes GUID equality lookups; it does not cache results or skip plug-in calls, and data or identity
changes invalidate those inputs.

## Bind project packs once

```js
import { createMirageContext } from 'paqvilo/mirage';
const mirage = await createMirageContext({ config: './paqvilo.config.yml', site: 'my-site', packs: [] });
const store = new mirage.DataStore();
await store.applyPreset('my-project-preset');
const simulator = await mirage.createSimulator({ initial: mirage.initialState(), port: 0, watch: false });
try {
  /* exercise your local portal */
} finally {
  await simulator.close();
}
```

The context reads catalogue and Mirage-project `dataPacks`, imports the selected metadata, filters packs
against the portal and binds one preset library. It supplies `DataStore`, `createSimulator`,
`initialState`, `applySolutionData`, `migrateScenarioState`, `discoverPacks`, `resolvePreset` and
`activatePackDeniedRoutes`, keeping argument order; runtime options can still be overridden. No adjacent
module is discovered implicitly.

- `config` is a path or file URL. Without `site`, it binds the packs of every catalogue site and Mirage
  project (deduplicated) without importing exports or metadata; pass `sourceDir` to `createSimulator`
  or a portal to `initialState`. With `site`, it imports that site and binds its runtime defaults.
  `env` selects the catalogue environment (over a project's default reference); `repo` works like `--repo`.
- `packs` accepts module paths, file URLs or loaded pack objects, as do `discoverPacks({ packs })` and
  `createSimulator({ packs })`. A loaded object with relative parity plan files needs `parity.directory`
  or must come from `loadPack(module)`. `dataPacks`, `explicit`, `generatedPresets` and `presetLibrary`
  options are translated.
- A pack activates only when `matches({ portal })` accepts the export.
- `importSolutionData()` returns `contentFingerprint` (relocation-stable; see
  [sources and bootstrap](../mirage/docs/bootstrap-and-sources.md)) beside the location-bound
  `fingerprint`. Neither identifies deployed state.

`createSimulator({ preset, presetMode: 'bootstrap', stateFile })` applies the preset only when the state
file does not exist (default `always`); status and startup JSON report `startupPreset: { name, mode,
applied }`. `presetConfiguration: 'apply'` also applies the preset's linked configuration (default
`data-only`; CLI `--apply-configuration`). `configurationPresetDiagnostics(pack, { portal, metadata, options })`
returns value-free errors for invalid configuration bodies and links without generating lazy data; put
`configurationPreset` on the descriptor beside `name` and `load`. `platform` works for `initialState`,
`DataStore` and `createSimulator` as in [configuration](configuration.md#settings-table).

## Connect to a running local runtime

```js
import { connectRuntime } from 'paqvilo/mirage/testing';
const sim = await connectRuntime({ config: './paqvilo.config.yml', site: 'my-site' });
const headers = await sim.signIn(null, { configuredPersona: true });
const response = await fetch(`${sim.origin}/`, { headers });
// Playwright: await sim.signIn(context, { contactId: 'synthetic-id' });
await sim.signOut();
```

`connectRuntime` also takes `{ origin: 'http://127.0.0.1:8787' }`. It finds a running runtime that a `paqvilo mirage`
command started for the site (including dynamic ports), else the configured port; an in-process `createSimulator` is not
recorded there, so pass its `url` as `origin`. It checks its source folder, confines every origin to loopback, and
never starts or stops a runtime. When something other than a Mirage runtime answers there (another server on the port,
a portal), it fails with `code` `RuntimeNotMirage`, naming what answered. Writes send CSRF automatically. `timeoutMs`
(default 30000; 0 = none) bounds each admin call and is inherited by `createSession` when it is 0–300000.

| Group         | Methods                                                                                                                                                                                                                                                                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime       | `status()`, `state({ summary })`, `records(table, query)` (administrative read; test permissions through portal routes), `liveConnect(cdp)`, `liveDisconnect()`, `captureShell(path)`, `witness({ tables })` ([verification witness](../mirage/docs/sim-administration.md#verification-witness))                                       |
| Identity      | `signIn(contextOrNull, { contactId, roles, configuredPersona })` (fetch: cookie header; Playwright: context cookies), `signOut(contextOrNull)`, `createSession(options)`                                                                                                                                                               |
| Configuration | `platformSettings()`, `setPlatformSettings(overrides)`, `resetPlatformSetting(key)`, `siteSettings()`, `setSiteSetting(name, value)`, `resetSiteSetting(name)`, `setSnippet(name, value)`, `resetSnippet(name)`, `experiments(id?)`, `saveExperiment(preset)`, `applyExperiment(id)`, `deleteExperiment(id)`, `transportDiagnostics()` |
| Evidence      | `audit(filters)`, `exportAudit(filters)`, `diagnostics(filters)`, `logs(filters)`, `exportBundle(filters)`, `trace.*`                                                                                                                                                                                                                  |

Configuration values follow [configuration experiments](../mirage/docs/configuration-experiments.md);
site and snippet values are strings, `null` removes the effective entry and a reset restores the source.
Overrides affect every visitor of the runtime, so change them between matrix runs or use separate
runtimes. Configuration assignments and resets retry once when the fetch cause chain contains
`ECONNRESET` (snippet/site assignment rereads first, so a lost response reuses the committed entry);
`transportDiagnostics()` returns the last 32 `RUNTIME_CONFIGURATION_RETRY` records without identifiers or
values. Preset application, experiment creation, refresh, record writes and submissions are never replayed.

Evidence reads return sanitized data without headers or row bodies:

- A visitor's `json()` returns `traceId`; `audit({ correlationId: traceId })` lists its nested requests.
  `audit`/`exportAudit({ traceId })` take one id, a comma list or an array of at most 200;
  `diagnostics({ traceId })` narrows findings and the portal request ring.
- Filters: `visitorId`, `sessionKey` (`contact:<id>`, `visitor:<id>`; both accept a hexadecimal prefix of
  at least 8 characters), `contactId`, `afterSequence` (exclusive), `throughSequence` (inclusive), kind,
  path, entity, method, status and outcome. Capture `latestSequence` as the upper bound for stable paging;
  `oldestSequence` and `dropped` disclose retention loss. Sequences mark request starts.
- `logs({ since, limit, type, traceId })` reads `GET /_sim/api/logs` (`mirage.logs.retain` lines):
  `{ items, latestSequence, oldestSequence, retained, dropped, retain, more }`, oldest first, after the
  exclusive `since` or else the newest `limit` (default 500); `type` is one or more of `startup`,
  `request`, `liquid`, `data`, `plugin`, `diagnostic`, `reload`; another `type` is refused with `status: 400`,
  `code` `InvalidLogFilter` and `parameter: 'type'`.
- `exportBundle(filters)` returns the [activity bundle](../mirage/docs/tracing.md#activity-bundle)
  documents in order, each with `kind` (`bundle`, `activity` or `otlp`, `audit`, `log`, `finding`,
  `evidence`, `end`); it takes the trace filters, `traces: 'ndjson' | 'otlp'` and `limit`.
- `trace` has `query`, `spans`, `tree(traceId)`, `span(spanId)`, `ancestry(spanId)`, `stats`, `export`,
  `settings`, `status`, `configure(partial)`, `clear`, `flush` and
  `subscribe(listener, { signal, events, traceId })`. Filters are plain objects (`recordId` matches every
  span that acted on a row; `result`, `auditId`, `hasErrors`, and `traceId` as a full id or a prefix of at least 8
  hexadecimal characters); `sort`, `order`, `format` and `limit` (1–2000) pass through. `tree`/`span` return `null`
  and `ancestry` `[]` for an id no longer retained. `flush()` resolves once persisted lines and live frames are handed
  off. `subscribe` returns `unsubscribe()` with a `closed` promise. Errors: `status: 400` with `code`
  `InvalidTraceFilter` (with the refused `parameter`, such as `limit` or `traceId`) or `InvalidTraceSettings`;
  `RuntimeUnreachable` and `RuntimeConnectionLost` keep the fetch error as `cause`. The in-process `simulator.trace`
  has the same reads synchronously, `flush()` as a promise and `subscribe(listener, { payloads, events, traceId })`;
  instrumentation (`start`, `run`, `wrap`, `link`, …) stays on the organization store
  ([store contract](design/tracing.md#store-contract)). See [request tracing](../mirage/docs/tracing.md#api).

## Administration addresses and tokens

The `createSimulator` handle exposes fields fixed for the runtime's life:

| Field                     | Power Pages host                                                                                      | Standalone host                   |
| ------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------- |
| `url`                     | Portal origin                                                                                         | Origin (also `origin`, `port`)    |
| `adminOrigin`, `adminUrl` | Administration origin on its own ephemeral port; `adminUrl` ends in `/__sim/` (same page as `/_sim/`) | Same; `adminUrl` ends in `/_sim/` |
| `setupUrl`                | `/_setup/` on the administration origin                                                               | Same                              |
| `appsOrigin`, `appsUrl`   | Apps origin on its own ephemeral port, and its root                                                   | Absent                            |
| `csrf`                    | Administration token, sent as `x-sim-csrf`; also in `state()` and status                              | Same                              |
| `portalToken`             | The `__RequestVerificationToken` value portal forms send                                              | Absent                            |
| `appsToken`               | Token the apps pages send                                                                             | Equals the main page token        |

A client that sends neither `Sec-Fetch-Site` nor `Origin` (Node `fetch`, `connectRuntime`) uses `/_sim/api`
on the portal origin with `csrf`; browsers use the separate origins
([administration origin](../mirage/docs/sim-administration.md#administration-origin)).

## Test many visitors concurrently

```js
import { connectRuntime, runSessionMatrix } from 'paqvilo/mirage/testing';
const runtime = await connectRuntime({ origin: 'http://127.0.0.1:8787' });
const visitors = await Promise.all(contactIds.map((contactId) => runtime.createSession({ id: contactId, contactId })));
try {
  const report = await runSessionMatrix({
    sessions: visitors,
    concurrency: 10,
    cases: [
      {
        id: 'visible-records',
        run: async (visitor, { signal }) => visitor.json('/_api/widgets?$select=widgetid', { signal }),
      },
    ],
  });
  // Check actual statuses and rows in report.results before qualifying access.
} finally {
  visitors.forEach((visitor) => visitor.close());
}
```

`createPortalSession({ origin, contactId?, roles?, id?, timeoutMs?, signal? })` and
`runtime.createSession(options)` give each visitor its own cookie jar on the same runtime; omit
`contactId` for an anonymous visitor (membership roles are the default). `timeoutMs` (0–300000, default
30000; 0 = none) bounds each request. Methods: `session()`, `signIn(contactId, { roles })`, `signOut()`,
`setRoles(rolesOrNull)`, `request(path, fetchOptions)`, `json(path, { method, body, headers, signal })`
(returns `{ status, traceId, body }`), `witness({ tables })` and `close()`. Web API writes get the verification header
automatically; identity changes and `close()` refuse while the visitor has pending requests. Requests are
confined to portal paths on loopback, cannot override identity headers and refuse live runtime execution.
Session descriptions omit cookie values.

`runSessionMatrix({ sessions, cases, concurrency, signal, onResult, failFast, maxCells })` runs every
visitor × case cell once. Each case has a unique `id` and `run(visitor, { signal, index, sessionId, caseId })`;
cases run in declared order per visitor, one at a time per visitor. `concurrency` defaults to 10 (at most
64), `maxCells` to 1,000,000. The report keeps case order, durations, values or safe error codes,
completed/failed/cancelled/unstarted counts, peak concurrency, throughput and p50/p95/max latency.
Cancellation drains started work without retries; `onResult` calls are serialized. Visitors share one
data store: use distinct write fixtures, or separate runtimes for independent configuration. A local pass
is not platform parity evidence.

## Resolve editor paths

`await resolveCatalogue({ config }, processEnv)` returns `sourceRoot`, each site's `sourceDir`, effective
Solution roots, Mirage port and state file, and provenance; `paqvilo lense list --json` shows the same
under `resolved`. The demo project's `node editor-workspace.mjs` (`examples/project`) builds
`portal.code-workspace` from it. Worktree setup: [configuration](configuration.md#personal-settings-and-worktrees).

## Reference comparison

`compareReferenceContracts({ localUrl, origin, cdpUrl, contracts, outputDir })` compares explicit read
contracts with the connected reference browser. Local reads use a temporary, cookie-isolated anonymous
visitor (the runtime's session controls are required) that never follows portal redirects. Alternatives,
mutually exclusive:

- `localSession`: a caller-owned `createPortalSession()` visitor at exactly `localUrl`.
- `localVisitor: { contactId, roles? }`: a temporary signed-in visitor; omitted `roles` uses the contact's
  memberships, `roles: []` is an empty override (CLI: `--local-contact ID`, repeatable `--local-role NAME`).
- `localVisitor: { configuredPersona: true }`: the configured contact, failing when none is configured
  (CLI: `--local-configured-persona`).

Nothing changes the runtime's or the reference browser's identity; reports hold only a local identity
fingerprint and sign-in status, and a changed visitor identity fails the comparison. Contract IDs are
unique strings of 1–160 characters; `statusOnly` and `unordered` must be booleans; `collection` and
`fields` match own JSON properties only.

## Acceptance runners

- `runAcceptance({ timeout })` (default 15000 ms) is each step's action deadline; a step's own positive
  `timeout`, larger than `navigationCommitReserveMs`, replaces it for that step.
- `runAcceptance({ navigationCommitReserveMs })` reserves part of the triggering action for
  document/redirect commits. Without it, the reserve is at least 3 s or half the remaining time when that
  is shorter, and at most half the remaining time (15 s → 7.5 s, 4 s → 2 s); an earlier response-header
  timing for the same method and exact URL can raise it to that chain's duration plus 1 s.
  `navigationWaits` records `commitReserveMs`, `commitReservePolicy` (`bounded-write-fallback`,
  `comparable-navigation-chain`, `explicit`), `comparableNavigationMs`, `writeHoldAllowanceMs` and
  `actionRemainingMs`. Redirect hops share one write-wait budget.
- `verifyParity({ timeout, readinessTimeout })`: page loads default to 30000 ms; selector, font and
  network-idle readiness default to the smaller of `timeout` and 5000 ms.
- Owned loopback `/__sim/events` and `/__sim/frame-ready/<uuid>` requests stay in network observations
  but do not hold settling or count as failures; use `simulatorBackgroundRequest(urlOrPath, origin)` for
  the same rule in project listeners.
- Abandoned requests go to `navigationCancelledRequests` (key, method, sanitized URL, reason, time).
  Detached frames and committed document replacements release their pending work; fragment and History
  API changes and a 204/205 document response (listed under `noContentNavigations`) keep the document.
  A cancelled write records browser lifecycle, not whether the server saved it.

`observePageLifecycle(page, { origin, maxRecords: 10000 })` and `observeContextLifecycle(context, options)`
are read-only Chromium observers. Await attachment (for a new page in an observed context,
`observer.ready()`) before navigating. They never intercept, sign in or change identity. A page observer
has `snapshot()`, `settle({ timeout: 5000, quietMs: 100, pollMs: 25 })` and `dispose()`. `settle()` returns
`settled` (no tracked portal work pending after the quiet period), `passed` (settled with no failures),
`waitedMs`, `requests`, `pendingRequests`, `supersededReads`, `failures`, `overflow`, `disposed` and
`closed`; the context version returns per-page reports in `pages` plus aggregate `settled`, `passed`,
`waitedMs` and `pendingAttachments` (pending attachment prevents success). Only a GET/HEAD read pending
when its frame detached or its document was replaced becomes `superseded-read`; a failure seen before that
proof stays a failure (Chromium can report an iframe abort before its detach). Reports omit query values,
headers, cookies and bodies; reaching `maxRecords` sets `overflow` and prevents a successful settle.
`dispose()` removes listeners and CDP sessions without closing pages.

## Shell capture and rich text

`connectRuntime().captureShell(path, { timeoutMs, richText })` returns the full report even for an HTTP
409 incomplete capture: check `applied` and `complete` (CLI success follows `applied`/`ready`;
`--strict` also requires `complete`). It has no deadline unless `timeoutMs` (or CLI `--timeout`) is set;
`SHELL_CAPTURE_TIMEOUT` warns that the server may still be working. Other errors carry `status` and the
parsed `response`. Non-JSON CLI captures print progress every 15 seconds; `--all` keeps each failed
site's message, `status` and `causeCode` and continues. `richText: false` (`--no-rich-text`) skips
editor resources.

Without a qualified capture (or a legacy core plus language resources), rich-text fields use a local
`Compatibility editor`, not CKEditor. It sanitizes with DOMPurify's HTML profile on load, `setData` and
serialization (scripts, event handlers, `javascript:` URLs, frames, objects, SVG and MathML are removed),
keeps paragraphs, tables and preformatted blocks stable across save/reopen, writes nothing for unchanged
content and stays read-only for read-only fields. A captured native editor uses CKEditor's own filtering.

Runner helpers: `richTextBody`, `resolveRichTextMode`, `settleHostModal`, `editRichText` and
`assertRichText`. Read-only observation helpers: `extractManagedRichTextControls(html)` (static control
manifests, resource lists and diagnostics, without instance values or authentication fields),
`findRichTextResource(portal, configUrl)` (one exported web-file descriptor, `undefined` when absent,
error when ambiguous) and `validateRichTextConfiguration(bytes)` (rejects unsupported or
credential-bearing configuration). Browser reads still need an authorized session with non-GET requests
blocked.
