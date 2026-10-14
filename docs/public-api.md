# Public programmatic API

Paqvilo 0.9.4 introduces supported package entry points. Exported names, documented options and behavior are covered by semantic versioning: patches fix defects compatibly, minors add exports or optional settings, and removing or incompatibly changing a supported contract requires a major version change, including from 0.x. Tests pin the export contract in `test/fixtures/public-api.json`.

| Import | Supported surface |
| --- | --- |
| `paqvilo/mirage` | `createSimulator`, `DataStore`, `DataError`, `initialState`, `discoverSolutionRoots`, `resolveSolutionRoots`, `importSolutionData`, `applySolutionData`, `migrateScenarioState`, `discoverPacks`, `loadPack`, `presetLibrary`, `createMirageContext` |
| `paqvilo/mirage/acceptance` | `runAcceptance`, `verifyParity`, `compareReferenceContracts`, browser launch options, source/state fingerprints, request reconciliation and native network/navigation observation classifiers |
| `paqvilo/mirage/packs` | Pack validation/discovery, lazy descriptors, bootstrap/compaction/list/resolution, read-only parity paths and plan validation |
| `paqvilo/mirage/fixtures` | `formatMockRecord`, `mergeDataset`, dangling lookups, schema validation/formatting, offline-state checks, `importPortal`, `createPortalRenderer` |
| `paqvilo/mirage/testing` | `signInHeaders`, `signInContext`, `connectRuntime`, `createPortalSession`, `runSessionMatrix` |
| `paqvilo/lense` | `loadCatalogue`, `loadConfig`, `loadDevTargets`, `resolveMirageConfig`, `resolveCatalogue` |
| `paqvilo/dataverse` | Schema planning/provisioning/export, `readCatalogue`, `validateCatalogue`, `planData`, `applyData`, `compareData`, `runDataQueries`, `retrieveFetchXml`, `connectedClient`, connection helpers; see [Dataverse toolkit](dataverse-provisioning.md) |

Existing wildcard paths such as `paqvilo/mirage/lib/data.mjs` continue working. Deep imports are deprecated for new integrations and remain available through 0.10.x, providing a complete minor release for migration. Outside the supported entry points, modules are implementation details after that notice period. Existing options remain accepted in 0.9.4.

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

`paqvilo/mirage/fixtures` exports `formatMockRecord`, `mergeDataset`, `findDanglingLookups`,
`schemaViolations`, `fieldIndexFromMappings`, `schemaFieldIndex`, `formatViolations`,
`assertOfflineState`, `stateFileFingerprint`, `importPortal` and `createPortalRenderer`.
The acceptance entry point also exports `AssetCache`, `validateLivePath`, `decodePagingCookie`,
`collectFetchXmlPages`, `escapeXmlAttribute`, `auditQuery`, `richTextBody`, `resolveRichTextMode`,
`settleHostModal`, `editRichText` and `assertRichText`. These rich-text actions are the supported
runner surface; source configuration parsing and editor-host implementation modules remain internal.

`connectRuntime().captureShell(path)` returns the full report even for HTTP 409 incomplete
captures. Check `applied` and `complete`; default command success follows `applied`/`ready`,
including usable captures with nonblocking gaps. `--strict` requires `complete` as well.
Other API errors carry `status` and the parsed `response`, and include the server message.

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

Set evidenced `observed.formSubmissionErrorMarkup: paragraph` when a site's recorded host
contract reads `#MessagePanel p`. The default remains `inline`; both JSON and native
postback errors retain escaped message text. This is a site observation, not an assertion
that every hosted form uses paragraph markup.

`createSimulator({ preset, presetMode: 'bootstrap', stateFile })` applies the preset only when
the state file does not exist. The default mode is `always`. Runtime status and startup JSON
include `startupPreset: { name, mode, applied }`. Existing state is never silently reseeded in
bootstrap mode; a requested manual preset application remains an explicit reset.
