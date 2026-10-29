# Public programmatic API

These package entry points are Paqvilo's supported programmatic API. Exported names, documented options and behavior are covered by semantic versioning: patches fix defects compatibly, minors add exports or optional settings, and removing or incompatibly changing a supported contract requires a major version change, including from 0.x. Tests pin the export contract in `test/fixtures/public-api.json`.

| Import                      | Supported surface                                                                                                                                                                                                                                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `paqvilo/mirage`            | `createSimulator`, `DataStore`, `DataError`, `readStateFile`, `initialState`, `discoverSolutionRoots`, `resolveSolutionRoots`, `importSolutionData`, `applySolutionData`, `migrateScenarioState`, `discoverPacks`, `loadPack`, `presetLibrary`, `createMirageContext`, `loadSourceGraph`, `preflight`                          |
| `paqvilo/mirage/acceptance` | `runAcceptance`, `verifyParity`, `compareReferenceContracts`, browser launch options, source/state fingerprints, request reconciliation and native network/navigation observation classifiers                                                                                                                                  |
| `paqvilo/mirage/packs`      | Pack validation/discovery, lazy descriptors, bootstrap/compaction/list/resolution, read-only parity paths and plan validation, persona catalogue validation/merging, and the pack-export registry (`PACK_EXPORTS`, `validatePackExports`, `collectPackExport`, `packProvides`; see [data packs](../mirage/docs/data-packs.md)) |
| `paqvilo/mirage/fixtures`   | `formatMockRecord`, `mergeDataset`, dangling lookups, schema validation/formatting, offline-state checks, `importPortal`, `createPortalRenderer`                                                                                                                                                                               |
| `paqvilo/mirage/testing`    | `signInHeaders`, `signInContext`, `connectRuntime`, `createPortalSession`, `createPersonaSession`, `createPersonaBrowserContext`, `runSessionMatrix`, `runStorageContract`, `STORAGE_CONTRACT_CASES`, `fixedClock`, `sequentialIds`, `createScheduler`                                                                         |
| `paqvilo/lense`             | `loadCatalogue`, `loadConfig`, `loadDevTargets`, `resolveMirageConfig`, `resolveCatalogue`                                                                                                                                                                                                                                     |
| `paqvilo/dataverse`         | Schema planning/provisioning/export, `readCatalogue`, `validateCatalogue`, `planData`, `applyData`, `compareData`, `runDataQueries`, `retrieveFetchXml`, `connectedClient`, connection helpers; see [Dataverse toolkit](dataverse-provisioning.md)                                                                             |

Wildcard paths such as `paqvilo/mirage/lib/data.mjs` resolve through the package's `./mirage/*` and `./lense/*` exports, but they are not supported entry points: modules outside the table are implementation details. Use the entry points in the table.

## Clock, ids and scheduler

The organization runtime (`createOrganizationRuntime`) accepts `clock` (epoch milliseconds, a function or `{ now() }`), `ids` (`{ uuid() }`) and `scheduler`, and shares them with its `DataStore` (which also takes `clock` and `ids` directly) and its asynchronous jobs. `mirage/lib/runtime-clock.mjs` provides `systemClock`, `systemIds`, `fixedClock(startMs)` (`now`, `advance(ms)`, `set(ms)`), `sequentialIds(namespace)` (valid version 5 GUIDs over a counter) and `createScheduler({ clock, manual, faults })` (`schedule`, `cancel`, `pending`, `runDue`, `advance`, `drain`, `close`, `status`). With a fixed clock and sequential ids, row ids, `createdon`/`modifiedon`, audit rows, plug-in trace logs and web hook payloads repeat byte for byte between runs; a manual scheduler runs the durable asynchronous jobs only when a test calls `runDue()` or `advance(ms)`. `runDue()` (and `advance(ms)`) runs every due task in order, each finishing before the next starts, and returns once the started tasks have settled or are blocked. A task is blocked when it waits on a task it queued on the same scheduler that is not due yet, such as a connector retry pause: `status().blocked` counts it, `status().pending` leaves it out, `drain()` returns without it, and the later `advance(ms)` that makes the queued task due lets it finish. A task that queues a due task and awaits it finishes in the same `runDue()`. The defaults keep wall time, random GUIDs and real timers.

`createSimulator` accepts the same `clock`, `ids` and `scheduler` options for the Power Pages and the standalone host, and passes them to its state store, organization runtime and committed-work backend. `paqvilo/mirage/testing` exports `fixedClock`, `sequentialIds` and `createScheduler` for project acceptance tests.

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

Recipe definitions are captured as cloneable data. Every `create` supplies fresh
state, a fixed clock, a fresh deterministic ID sequence and an idle manual
scheduler. Mutating one fixture does not change the recipe or another fixture.
At most 100 named definitions are accepted. Recreation starts from the captured
definition; it does not rewind an active runtime, recover an
advanced identity counter, restore arbitrary provider closures or resurrect
in-flight timers. A project rebuilds its providers for the new fixture and owns
teardown of the old runtime. Runtime callbacks in recipe state are rejected.
Shared-memory buffers, views and WebAssembly memory are rejected, including when
nested inside an Error cause, because cloning them does not isolate their bytes;
ordinary array buffers are copied. Recipe graph inspection
has a shared work limit.

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

`loadSourceGraph({ solutionRoots, solutionOrder = 'derived', sourceDir, lcid = 1033, bindings })` reads the selected Solution roots once and returns a read-only graph. With `sourceDir`, it also reads that portal export. `bindings` takes deployment-profile values, `{ connectionReferences: [{ logicalName, connectionId }], environmentVariables: { name: value } }`, which settle requirements. Node ids are `<kind>:<lower-case key>`. `JSON.stringify(graph)` gives `{ fingerprint, summary, nodes }`, without environment variable values or connection ids. Inventory kinds and statuses are described in [Sources and bootstrap](../mirage/docs/bootstrap-and-sources.md#solution-inventory).

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

`preflight(options)` returns the same report as `paqvilo mirage preflight --json`, without exiting the process. It takes the `createSimulator` option names (`runtime`, `simulation`, `solutionRoots`, `solutionOrder`, `sourceDir`, `dataPacks`, `environmentVariables`, `deploymentProfiles`, `localServices`, `providers`), plus `scenario`, `strict` and `env`. `env` is where `env:NAME` references resolve, `process.env` by default. The report shape, the four fidelity levels, scenario patterns and exit codes are described in [Capabilities and preflight](../mirage/docs/capabilities-and-preflight.md).

A running simulator answers the same report for its live state: `simulator.preflight({ scenario, strict })` on the handle `createSimulator` returns (Power Pages and standalone hosts alike), and `GET /_sim/api/preflight` over HTTP. It reads the host's own capability registry and operation catalogue, including the operation modes saved in `/_sim/`. The runtime status (`simulator.state()`, standalone `status()`) carries the same registry as `capabilities` (the legacy summary) and `capabilityReport`. `simulator.settle()` on either handle resolves once every committed-event job (asynchronous plug-in steps, web hooks, row-triggered flows and due scheduled jobs) has run; tests await it instead of the store queue, because durable jobs run on the runtime scheduler. It then settles the instantiated pack providers: pending outbox observer calls and each provider's own `settle()`.

Both hosts also answer `GET /_sim/api/dashboard`, a read-only, redacted topology and activity document for monitoring tools (see [simulation administration](../mirage/docs/sim-administration.md#infrastructure-feed)). Its activity numbers come from the organization runtime's counters, `store.counters` (`createCounters()` in `mirage/lib/runtime-counters.mjs`): `snapshot()` returns the named counts and `tick` moves on every change. Counts start at zero with the runtime and are not persisted.

## Persona catalogues

Version 1 [persona catalogues](../mirage/docs/persona-catalog.md) and the
`validatePersonaCatalog` / `mergePersonaCatalogs` exports on `paqvilo/mirage/packs`
are semver-covered. `connectRuntime` adds catalogue management, context launch and
owned-runtime lifecycle methods. `createPersonaSession` and
`createPersonaBrowserContext` select contact-derived identities and apply reusable
isolated setups for automated tests; legacy session helpers stay compatible.

## Render local pages within a budget

Local Liquid rendering uses a 60,000 ms budget. Set `sites.<id>.mirage.render.timeLimitMs`
(or `defaults.mirage.render.timeLimitMs`) to an integer from 1 to 3,600,000. Embedded
runtimes and renderers accept `render: { timeLimitMs: 120000 }` through `createSimulator`
and `createPortalRenderer`. Restart a running runtime after changing the catalogue;
`/_sim/api/status` reports the effective `render` settings. Exceeding the budget returns
HTTP 500 with `local render time limit of <n> ms exceeded`.

Liquid yields to the event loop between nodes and loop iterations. Individual synchronous
FetchXML queries remain subject to the existing query complexity and join-row limits;
the render budget detects an overrun after that query returns. Within one render, Mirage
reuses planned FetchXML and permission-filtered inputs, and indexes GUID equality lookups.
It does not cache query results or suppress plugin calls. Data mutations and identity
changes invalidate read inputs.

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

The context reads catalogue and selected Mirage-project `dataPacks`, imports selected metadata, filters packs against the portal and binds one preset library. It supplies `DataStore`, `createSimulator`, `initialState`, `applySolutionData`, `migrateScenarioState`, `discoverPacks`, `resolvePreset` and `activatePackDeniedRoutes`. Bound functions retain original argument order; ordinary runtime options can still be overridden. No adjacent project modules are discovered implicitly.

The asynchronous factory accepts `packs` containing module paths, file URLs or loaded pack objects; it resolves them before binding synchronous functions. `discoverPacks({ packs })` and `createSimulator({ packs })` accept the same input shape. Loaded objects with relative parity plan files need `parity.directory`, or must originate from `loadPack(module)` so their directory is known. Legacy `dataPacks`, `explicit`, `generatedPresets` and `presetLibrary` options remain compatible; the context translates them.

## Connect to a running local runtime

```js
import { connectRuntime } from 'paqvilo/mirage/testing';
const sim = await connectRuntime({ config: './paqvilo.config.yml', site: 'my-site' });
const headers = await sim.signIn(null, { configuredPersona: true });
const response = await fetch(`${sim.origin}/`, { headers });
// Playwright: await sim.signIn(context, { contactId: 'synthetic-id' });
await sim.signOut();
```

Alternatively pass `{ origin: 'http://127.0.0.1:8787' }`. The client resolves an owned running runtime (including dynamic ports), otherwise the configured port, and checks its source folder. All origins are confined to loopback. Methods: `status()`, `state({ summary })`, `signIn(contextOrNull, { contactId, roles, configuredPersona })`, `signOut(contextOrNull)`, `records(table, query)`, `setSnippet(name, value)`, `liveConnect(cdp)`, `liveDisconnect()` and `captureShell(path)`. Writes fetch/send CSRF automatically. Fetch sign-in returns a cookie header; Playwright uses its context request cookies. The client starts and stops no runtime.

`records` is an administrative local read. Test portal permissions through portal/Web API routes with sign-in headers. Configured-persona sign-in preserves membership roles or explicit role overrides.

Scenario controls wrap the existing validated administration APIs with automatic CSRF:
`platformSettings()`, `setPlatformSettings(overrides)`, `resetPlatformSetting(key)`,
`siteSettings()`, `setSiteSetting(name, value)`, `resetSiteSetting(name)`,
`setSnippet(name, value)`, `resetSnippet(name)`, `experiments(id?)`,
`saveExperiment(preset)`, `applyExperiment(id)` and `deleteExperiment(id)`.
Values and presets follow [configuration experiments](../mirage/docs/configuration-experiments.md).
Site/snippet values stay strings; a null value removes the effective entry and a reset
restores its source. Overrides affect every visitor on that runtime. Apply configuration
between completed matrix runs, or use separate runtime origins for simultaneous settings.

`audit(filters)`, `exportAudit(filters)` and `diagnostics()` read the existing runtime's sanitized evidence. A visitor's `json()` response supplies `traceId`; use `audit({correlationId: traceId})` to inspect its nested request entries. Filters also support `contactId`, `afterSequence` (exclusive), `throughSequence` (inclusive), kind, path, entity, method, status and outcome. Capture `latestSequence` as the upper bound for stable pagination during concurrent traffic. `oldestSequence` and `dropped` disclose bounded retention loss. Sequences identify request starts; wait for the tested requests to complete before advancing a completion checkpoint. Exported entries retain sanitized queries and outcomes, without HTTP headers or row bodies.

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
`runtime.createSession(options)` connect independent cookie jars to the same local
runtime. Omit `contactId` for an anonymous visitor; membership roles are the default.
Methods are `session()`, `signIn(contactId, { roles })`, `signOut()`, `setRoles(rolesOrNull)`,
`request(path, fetchOptions)`, `json(path, { method, body, headers, signal })` and `close()`.
The JSON method returns `{ status, traceId, body }`; `traceId` links to the runtime's
request evidence, and requests preserve HTTP permission denials.
Web API writes obtain the local verification header automatically. Identity changes
and closing refuse while that visitor's requests are pending. Cookies stay private;
session descriptions omit cookie values. Visitor/form cookies retain their path and
expiry scope alongside authentication cookies. Requests are confined to portal paths on
loopback, cannot override the visitor's identity headers, and refuse live runtime
execution even if its mode changes after connecting. Administration remains separate.

`runSessionMatrix({ sessions, cases, concurrency, signal, onResult, failFast, maxCells })`
runs the full visitor/case product once, distributing visitors across the first wave.
Cases run in their declared order for each visitor, with at most one case active
per visitor; different visitors can advance independently.
Each case has a unique `id` and `run(visitor, { signal, index, sessionId, caseId })`.
Concurrency defaults to 10 and is bounded to 64; the default maximum is 1,000,000 cells.
Results retain case order, duration, returned values or safe error codes. The report
includes completed/failed/cancelled/unstarted counts, peak concurrency, throughput and
p50/p95/max latency. Cancellation drains started work without retries. `onResult` is
serialized for a caller-owned durable journal. Visitors share one data store: use
distinct disposable write fixtures, or separate runtime processes for independent
configuration and CPU isolation. Local parallel passes still require native evidence
before they can qualify platform parity.

## Resolve editor paths

`await resolveCatalogue({ config }, processEnv)` returns `sourceRoot`, site `sourceDir`, effective Solution roots, Mirage port/state file and provenance. `paqvilo lense list --json` exposes this under `resolved`. The starter's `node editor-workspace.mjs` generates `portal.code-workspace` from these paths.

For linked worktrees, keep the catalogue, ignored `paqvilo.config.local.yml` and `.env` in a shared external project folder. Select that catalogue explicitly and set `PAQVILO_REPO` to the current portal worktree, or pass `--repo`. Each worktree then reads the same project settings. Paqvilo does not copy sign-in state or automatically inherit another worktree's `.env`.

## Pack authors and project test runners

`createMirageContext({ config })` accepts a catalogue path or file URL. Omitting `site` binds packs explicitly registered across every catalogue site and its Mirage project, deduplicating repeated modules without importing portal exports or Solution metadata. Supply `sourceDir` to `createSimulator` or an imported portal to `initialState` in this project-wide binding. Pass `site` to import that site's source/metadata and bind its runtime defaults. Optional `env` selects that site's catalogue environment and origin, taking precedence over an associated project's default reference. Without `env`, existing project-reference precedence is retained. Optional `repo` selects the portal checkout root using the same rules as CLI `--repo`. Runtime pack activation still requires `matches({ portal })`; registering a pack for tests does not activate it on unrelated exports. See [project scaffold](project-scaffold.md).

`importSolutionData()` returns `contentFingerprint` alongside the existing location-bound `fingerprint`. Use the former for relocation-stable derived-fixture checks; its logical layer, relative path, byte and locale contract is described in [sources and bootstrap](../mirage/docs/bootstrap-and-sources.md). Neither fingerprint identifies deployed state.

Use `paqvilo/mirage/packs` for `validatePack`, `presetDescriptor`, `defineLazyPreset`,
`bootstrapPresetLibrary`, `compactBuiltinPresets`, `listPresets` and
`resolvePreset(state, name, library)`. Pass your context's library to use the same explicitly
registered packs as your runtime. `assertReadOnlyPath`, `DENIED_ROUTE_PATTERNS`, `validatePlan`
and `activatePackDeniedRoutes` support project-owned parity plans.

`compareReferenceContracts({ localUrl, origin, cdpUrl, contracts, outputDir })` compares
explicit read contracts with the connected reference browser. Local reads are anonymous
by default, using a temporary cookie-isolated visitor with an explicit anonymous
session. This requires the local runtime's session controls even for anonymous reads;
the visitor owns local-only enforcement and never follows portal redirects.
Supply `localSession: visitor` from `createPortalSession()` to reuse an open
visitor at exactly `localUrl`, or `localVisitor: { contactId, roles? }` to create a temporary
authenticated visitor. Omit `roles` to resolve normal contact memberships; an explicit
array overrides roles only for that visitor. `localVisitor: { configuredPersona: true }`
uses the configured contact and preserves its membership/override choice, failing clearly
when no contact is configured. These options are mutually exclusive. The CLI equivalents
are `--local-contact ID`, optional repeatable `--local-role NAME`, and
`--local-configured-persona`. To specify an empty override use the API's `roles: []`.
Supplied sessions remain caller-owned; temporary visitors are closed after comparison.
No option changes the configured runtime identity, creates grants or changes reference
browser identity. Reports include only a local identity fingerprint and sign-in status;
cookies/CSRF values are never persisted. A changed visitor identity makes comparison fail.
Contract IDs are unique strings of 1–160 characters. `statusOnly` and `unordered`
accept booleans; string values such as `"false"` fail validation before reads.
`collection` and `fields` select own JSON properties; absent fields and inherited
prototype properties cannot count as matching response data.

`paqvilo/mirage/fixtures` exports `formatMockRecord`, `mergeDataset`, `findDanglingLookups`,
`schemaViolations`, `fieldIndexFromMappings`, `schemaFieldIndex`, `formatViolations`,
`assertOfflineState`, `stateFileFingerprint`, `importPortal` and `createPortalRenderer`.
It also exports `generateDataset`, `summarizeDataset`, `generateSchemaDeclarations`,
`comparePluginRegistrations` and `comparePermissionModels`. The testing entry
exports `createFixtureRecipes`. See [data packs](../mirage/docs/data-packs.md#schema-directed-pack-datasets),
[registration comparison](../mirage/docs/dataverse-plugins.md#local-registration-comparison),
[grant comparison](../mirage/docs/dataverse-parity.md#compare-compiled-portal-grants)
and [named fixture recreation](#named-deterministic-recreation) for their
project-owned inputs, bounded reports and compatibility limits.
`buildPermissionModel`, `parsePluginDocument` and `importSolutionPlugins` expose
the existing compilers for those offline reports. `remapDatasetIdentities`
performs explicit metadata-backed row identity substitution. `inspectFlowExpression`
and `evaluateFlowTriggerConditions` support project-owned preflight/scenario
assertions without starting a flow or invoking providers.
The acceptance entry point also exports `AssetCache`, `validateLivePath`, `decodePagingCookie`,
`collectFetchXmlPages`, `escapeXmlAttribute`, `auditQuery`, `richTextBody`, `resolveRichTextMode`,
`settleHostModal`, `editRichText` and `assertRichText`. These rich-text actions are the supported
runner surface; the three observation helpers documented below are also public. Other
source configuration parsing and editor-host implementation modules remain internal.

`connectRuntime().captureShell(path)` returns the full report even for HTTP 409 incomplete
captures. Check `applied` and `complete`; default command success follows `applied`/`ready`,
including usable captures with nonblocking gaps. `--strict` requires `complete` as well.
Other API errors carry `status` and the parsed `response`, and include the server message.
Shell capture has no client deadline by default; ordinary admin calls retain their 30-second
deadline. Set `captureShell(path, { timeoutMs: 120000 })` or CLI `--timeout 120000` to bound
waiting in milliseconds (`0` disables this deadline). `SHELL_CAPTURE_TIMEOUT` names the
option and warns that the server may still be working. Non-JSON CLI captures print progress
to stderr every 15 seconds. `--all` preserves each failed site's sanitized message, HTTP
`status` and `causeCode`, continues other sites, and attempts disconnect even on failure.

`paqvilo mirage capture-shell --no-rich-text` captures the shell/styles without discovering
editor resources. The equivalent client call is `captureShell(path, { richText: false })`.
An incomplete cached editor uses the compatibility control, including when a partial
managed-control definition was captured. Native editing requires a qualified capture or a
legacy core plus language resources; merely caching `ckeditor.js` is insufficient.

The compatibility control is a local stand-in, labelled `Compatibility editor`, not the native
CKEditor. It sanitizes content with DOMPurify's HTML profile when it loads the stored value, on
`setData` and whenever it serializes the editor body into the hidden field. Scripts, event-handler
attributes, `javascript:` URLs, embedded frames and objects, and SVG or MathML markup are removed;
ordinary formatting, lists, links, images and tables remain. Its output wraps inline-only content
in a paragraph and keeps paragraphs, tables and preformatted blocks stable across repeated
save/reopen. Unchanged content writes neither the hidden value nor a change event, and read-only
fields keep the editor body read-only and its formatting buttons disabled. A captured native editor uses
CKEditor's own content filtering instead and does not run DOMPurify.

Evidenced platform defaults are accepted in catalogue `defaults.mirage.platform` and
`sites.<id>.mirage.platform`, or a Mirage project's root/portal `platform` object:
`{ QueryLinkEntityLimit: 50, evidence: 'Recorded sandbox organization setting' }`.
The same `platform` option works with `initialState`, `DataStore` and `createSimulator`;
catalogue contexts, bootstrap reports and render sweeps use the resolved configuration.
Existing setting validation applies. Manual local overrides take precedence; runtime status
reports the effective value and its `Catalogue` origin and evidence.

Owned loopback `/__sim/events` and `/__sim/frame-ready/<uuid>` requests remain in network
observations but do not hold acceptance settling or count as navigation failures.
Import `simulatorBackgroundRequest(urlOrPath, origin)` from `paqvilo/mirage/acceptance`
for project request listeners; supply the runtime origin to keep the rule origin-confined.
`runAcceptance` records abandoned requests in `navigationCancelledRequests` with request
key, method, sanitized URL, cancellation reason and time. Detached frames and committed
document replacements release their pending work; unrelated failures remain failures.
Fragment and History API changes leave the current document's requests pending. A 204
navigation response also preserves its document. Requests started by a replacement document
remain subject to settling. Local document navigation shares one bounded write-wait budget
across its redirect hops, reserving time within the triggering action's timeout for commit;
`navigationWaits` records the observed waits and whether the writes completed.
A cancelled write is an observation of browser lifecycle, not proof that the server saved it.

Set evidenced `observed.formSubmissionErrorMarkup: paragraph` when a site's recorded host
contract reads `#MessagePanel p`. The default remains `inline`; both JSON and native
postback errors retain escaped message text. This is a site observation, not an assertion
that every hosted form uses paragraph markup.

`createSimulator({ preset, presetMode: 'bootstrap', stateFile })` applies the preset only when
the state file does not exist. The default mode is `always`. Runtime status and startup JSON
include `startupPreset: { name, mode, applied }`. Existing state is never silently reseeded in
bootstrap mode; a requested manual preset application remains an explicit reset.

Use `createSimulator({ preset, presetConfiguration: 'apply' })` to apply the data preset's
linked configuration in the same state replacement. The default is `data-only`; bootstrap
mode keeps both data and configuration when state already exists. The catalogue equivalent is
`mirage.presetConfiguration: apply`, or pass `--apply-configuration` to `mirage start/dev`.
`configurationPresetDiagnostics(pack, { portal, metadata, options })`, exported from
`paqvilo/mirage/packs`, returns value-free errors for invalid configuration bodies and
unknown or malformed links. It inspects lazy descriptors without generating their data;
put `configurationPreset` on the descriptor alongside `name` and `load`.

The acceptance surface also exports three read-only observation building blocks:

- `extractManagedRichTextControls(html)` extracts static managed control manifests, resource lists and diagnostics from HTML. It excludes instance values and authentication fields; it performs no browser or network action.
- `findRichTextResource(portal, configUrl)` resolves one exported web-file descriptor by configuration resource name, returns undefined when absent, and rejects ambiguous mappings.
- `validateRichTextConfiguration(bytes)` accepts Buffer/string static configuration JSON, returns its validated object and rejects unsupported or credential-bearing content.

Project observation tools can use these public exports instead of deep imports. Browser reads still require an authorised session and a guard blocking all non-GET requests.

`runAcceptance({ timeout })` (default 15000 ms) is each step's action deadline. A step's own `timeout` replaces it for that step only, covering its waits, navigation commit reserve and settlement; the step records it as `timeout`. It must be a positive finite number larger than `navigationCommitReserveMs`. Use it to give one step a short deadline without shortening page loads.
`verifyParity({ timeout, readinessTimeout })` bounds each page load by `timeout` (default 30000 ms) and the required-selector, font and network-idle readiness waits that follow by `readinessTimeout` (default the smaller of `timeout` and 5000 ms).

`runAcceptance({ navigationCommitReserveMs })` reserves that many milliseconds of the triggering action for document/redirect commits. Without an override, a navigation allows at most 5 s for pending writes, reserving the remainder for the document and redirect chain. Its minimum reserve is 3 s, capped at half the remaining action time for short actions. Earlier successful response-header timings for the same initial method and exact URL (including query) can increase the reserve to the measured chain duration plus 1 s. An unrelated fast initial page cannot shrink the fallback. Timing excludes intercepted hold time; redirects share the first hop's hold budget and reserve. An unexpectedly slow navigation can still exceed the action timeout. `navigationWaits` records `commitReserveMs`, `commitReservePolicy` (`bounded-write-fallback`, `comparable-navigation-chain`, or `explicit`), `comparableNavigationMs` (null without comparable evidence), `writeHoldAllowanceMs` and `actionRemainingMs`. A document navigation answered 204 or 205 and ending with net::ERR_ABORTED is listed under noContentNavigations (method, sanitized URL, status); it preserves its document and is not a failed request. Pending reads/writes still have to settle; response-less aborts and other network failures remain failures.

`observePageLifecycle(page, { origin, maxRecords: 10000 })` and
`observeContextLifecycle(context, options)` are public read-only Chromium observers for
project-owned Playwright runners. Await attachment before navigation; for a new page in an
observed context, await `observer.ready()` before navigating it. They do not intercept requests,
change identities, sign in, or grant live-reference access. The supplied origin confines the
owned-background exclusion; requests to other origins remain observed.

A page observer exposes `snapshot()`, `settle({ timeout: 5000, quietMs: 100, pollMs: 25 })`
and async `dispose()`. `settle()` returns `settled`, `passed`, `waitedMs`, `requests`,
`pendingRequests`, `supersededReads`, `failures`, `overflow`, `disposed` and `closed`.
`settled` means tracked portal work is no longer pending and the quiet period elapsed;
`passed` additionally requires no failures. Context `settle()` returns per-page reports in
`pages` with aggregate `settled` and `passed`, `waitedMs` and `pendingAttachments`.
Pages created while settling join the same observation, and attachment and page work
share the requested timeout. Page reports are refreshed after waiting so activity on
an earlier quiet page cannot be hidden by its old result. Pending attachment prevents
success. Context attachment errors are thrown by
`ready()`/`settle()`. Dispose removes observer listeners and CDP sessions without closing pages
or the context. Stop using a disposed observer; it cannot report successful settling.

Only GET/HEAD reads pending when a frame detach or a committed document replacement is
observed can become `superseded-read`; this reports document lifecycle and never claims
browser consumption or server completion. An aborted read can also qualify if its frame is
already detached at failure time. A failure observed before that lifecycle proof stays failed,
even if a later navigation or detach follows. Chromium can emit an iframe abort before its
detach event; that ordering deliberately remains a failure. Fragment/history changes do not
replace documents. HTTP errors, failed writes and cancelled writes remain in `failures`.
The observer has no server-side write reconciliation contract. Read requests to the exact
owned background paths documented above remain recorded but do not hold settling or fail it;
writes to those paths are ordinary tracked work. Other event streams remain pending.

Reports contain method, resource type, sanitized origin/path URL, status, timing, outcome and
available lifecycle evidence; they omit query values, headers, cookies and bodies. Reaching
`maxRecords` sets `overflow` and prevents a successful settle rather than silently dropping
coverage. This is a bounded observation report, not proof of Power Pages behavior or a saved
record. Keep project-specific assertions and acceptance fixtures in the project package.

## Code Apps development integration

`paqvilo/mirage/code-apps/vite` exports `codeApps(options?)`, the development-only Vite plugin for a local Mirage workbench. `paqvilo/mirage/code-apps` exports `createCodeAppSdkExecutor(options?)` for applications that explicitly register the SDK data executor. Both ship TypeScript declarations. See [Code Apps](../mirage/docs/code-apps.md#develop-sdk-apps-with-vite-and-the-workbench) for project configuration, lifecycle and the boundary with Microsoft's native host.

`paqvilo/mirage/code-apps/client` exports the typed lower-level `configure`, `getStatus`, `getContext`, `getToken` and `dataClient` APIs for application-owned service adapters.
