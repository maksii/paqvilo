# Public programmatic API

Paqvilo 0.9.4 introduces supported package entry points. Exported names, documented options and behavior are covered by semantic versioning: patches fix defects compatibly, minors add exports or optional settings, and removing or incompatibly changing a supported contract requires a major version change, including from 0.x. Tests pin the export contract in `test/fixtures/public-api.json`.

| Import | Supported surface |
| --- | --- |
| `paqvilo/mirage` | `createSimulator`, `DataStore`, `DataError`, `readStateFile`, `initialState`, `discoverSolutionRoots`, `resolveSolutionRoots`, `importSolutionData`, `applySolutionData`, `migrateScenarioState`, `discoverPacks`, `loadPack`, `presetLibrary`, `createMirageContext` |
| `paqvilo/mirage/acceptance` | `runAcceptance`, `verifyParity`, `compareReferenceContracts`, browser launch options, source/state fingerprints, request reconciliation and native network/navigation observation classifiers |
| `paqvilo/mirage/packs` | Pack validation/discovery, lazy descriptors, bootstrap/compaction/list/resolution, read-only parity paths and plan validation |
| `paqvilo/mirage/fixtures` | `formatMockRecord`, `mergeDataset`, dangling lookups, schema validation/formatting, offline-state checks, `importPortal`, `createPortalRenderer` |
| `paqvilo/mirage/testing` | `signInHeaders`, `signInContext`, `connectRuntime`, `createPortalSession`, `createPersonaSession`, `createPersonaBrowserContext`, `runSessionMatrix` |
| `paqvilo/lense` | `loadCatalogue`, `loadConfig`, `loadDevTargets`, `resolveMirageConfig`, `resolveCatalogue` |
| `paqvilo/dataverse` | Schema planning/provisioning/export, `readCatalogue`, `validateCatalogue`, `planData`, `applyData`, `compareData`, `runDataQueries`, `retrieveFetchXml`, `connectedClient`, connection helpers; see [Dataverse toolkit](dataverse-provisioning.md) |

Wildcard paths such as `paqvilo/mirage/lib/data.mjs` resolve through the package's `./mirage/*` and `./lense/*` exports, but they are not supported entry points: modules outside the table are implementation details. Use the entry points in the table.

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
try { /* exercise your local portal */ } finally { await simulator.close(); }
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
const visitors = await Promise.all(contactIds.map(contactId =>
  runtime.createSession({ id: contactId, contactId })));
try {
  const report = await runSessionMatrix({ sessions: visitors, concurrency: 10,
    cases: [{ id: 'visible-records', run: async (visitor, { signal }) =>
      visitor.json('/_api/widgets?$select=widgetid', { signal }) }] });
  // Check actual statuses and rows in report.results before qualifying access.
} finally { visitors.forEach(visitor => visitor.close()); }
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

`createMirageContext({ config })` accepts a catalogue path or file URL. Omitting `site` binds packs explicitly registered across every catalogue site and its Mirage project, deduplicating repeated modules without importing portal exports or Solution metadata. Supply `sourceDir` to `createSimulator` or an imported portal to `initialState` in this project-wide binding. Pass `site` to import that site's source/metadata and bind its runtime defaults. Runtime pack activation still requires `matches({ portal })`; registering a pack for tests does not activate it on unrelated exports. See [project scaffold](project-scaffold.md).

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

`paqvilo/mirage/fixtures` exports `formatMockRecord`, `mergeDataset`, `findDanglingLookups`,
`schemaViolations`, `fieldIndexFromMappings`, `schemaFieldIndex`, `formatViolations`,
`assertOfflineState`, `stateFileFingerprint`, `importPortal` and `createPortalRenderer`.
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
`pages` with aggregate `settled` and `passed`. Context attachment errors are thrown by
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
