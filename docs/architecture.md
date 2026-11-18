# Architecture and project boundaries

Paqvilo owns reusable Power Platform behaviour. Your project owns its sources, configuration, data packs, personas and
acceptance tests, in its own repository.

## Components

| Path                                                       | Responsibility                                                                                                                           |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/paqvilo.mjs`                                          | Top-level dispatch: `lense`, `mirage`, `dataverse`, `analyze`, `init`, `setup`, `doctor`                                                 |
| `lense/`                                                   | Catalogue and settings, export model, URL→file resolution, interception, HTML rewriting, browser sessions, panel and agent API           |
| `lense/commands/`                                          | One module per CLI command, including the Mirage lifecycle (`mirage init/dev/start/status/stop`) and `mirage demo`                       |
| `lense/setup/`                                             | The `/_setup/` configuration workspace                                                                                                   |
| `lense/analysis/`                                          | Offline static analysis (`analyze`, Doctor advice)                                                                                       |
| `lense/dataverse/`                                         | Explicit Dataverse provisioning, comparison, export and Power Pages site management (`paqvilo/dataverse`)                                |
| `lense/project-scaffold.mjs`, `templates/project/`         | `paqvilo init`: the empty consumer project                                                                                               |
| `mirage/server.mjs`, `mirage/lib/`                         | Import, Liquid, FetchXML/Web API, forms/lists, permissions, the organization runtime, app hosts, connectors and providers (flat modules) |
| `mirage/cli.mjs`, `mirage/<tool>.mjs`                      | `mirage serve/inspect/data/preflight/...` and the public Mirage tools                                                                    |
| `mirage/admin/`                                            | The `/_sim/` administration workspace                                                                                                    |
| `mirage/testing/`                                          | Sign-in, session and runtime helpers and contract suites for project-owned tests (`paqvilo/mirage/testing`)                              |
| `examples/project/`                                        | The populated demo copied by `mirage demo`                                                                                               |
| `examples/company-operations/`                             | A separate synthetic regression project for deep permissions and plug-in observations                                                    |
| `docs/`, `mirage/docs/`                                    | Guides and contracts, shipped in the package                                                                                             |
| `test/`, `test-browser/`, `mirage/test-*/`, `mirage/test/` | Synthetic regressions (not shipped)                                                                                                      |
| `scripts/`, `.github/`, `site/`                            | Contributor checks, release tooling, CI and the public website (not shipped, except `scripts/ensure-dependencies.mjs`)                   |

Package entry points are listed in [public API](public-api.md).

## Lense: overlay on a live portal

1. `portal-model.mjs` indexes the export: web files by URL, and inline sources (page/form/list JavaScript and CSS,
   templates, snippets, page copy) by record and field.
2. The dev command launches or attaches to a browser and installs request interception on the DevTools protocol
   (`intercept.mjs`), once per tab. `resolver.mjs` decides, per online URL, which local file answers it.
3. Mapped assets are served from disk with source maps (`source-map.mjs`) so debuggers step through local files.
4. Portal HTML is fetched from the live origin and rewritten (`html-rewriter.mjs`): inline script/style blocks are
   replaced whole; Liquid markup cannot run locally, so the Git-baseline-to-working-copy diff is applied as a literal
   patch, and a change that cannot be patched is reported as needing deployment.
5. A file watcher reloads affected tabs on save. Everything else (Liquid, Dataverse, sign-in, form posts) is the live
   backend.

## Mirage: import, render, simulate

1. **Source graph.** The importers read the portal export and the selected Solution layers once; `source-graph.mjs`
   indexes them with one precedence rule and lists what a run requires.
2. **Organization core.** `DataStore` (`lib/data.mjs`) holds the state. `createOrganizationRuntime` installs the ordered
   Dataverse extensions over it: record pipeline, security, plug-ins, workflows, custom APIs and contract modules.
   Committed work (asynchronous plug-ins, workflows, flow triggers, webhooks) runs as durable `asyncoperation` jobs.
3. **App hosts.** The Power Pages host (`server.mjs`: Liquid rendering, forms, lists, `/_api`) and the Solution-only
   host (`standalone-runtime.mjs`) share one composition, `composeOrganizationHost` in `organization-host.mjs`, which
   owns handler maps, operation catalogues, providers, the flow run store and the close order. Canvas and code apps live
   under `/_apps/`; administration under `/_sim/`.
4. **Connectors.** `connector-runtime.mjs` resolves each flow action through its connection reference to a declared
   connection, principal and provider. The flow interpreter journals runs so waiting runs can resume.
5. **Providers.** The host builds `api.providers` once (storage, messaging, outbox, connectors, secrets, service
   fixtures, Power Fx, local services); an unconfigured provider is `null`.

Cross-cutting rules: one request context per call carries the initiator, principal and correlation id; one clock, id
source and scheduler per runtime drive every timer, so tests can fix time and ids; one settings table
(`MIRAGE_SETTINGS`, `lib/config-keys.mjs`) and one pack-export registry (`PACK_EXPORTS`, `lib/pack-exports.mjs`)
validate configuration and packs; runtime outbound HTTP (webhooks, connectors, flows, local services) goes through
`loopbackFetch`, which refuses non-loopback hosts. Live reference reads and opted-in live writes use the selected
connected browser identity instead.

Each module reports a capability level (`inventory`, `contract`, `behaviour` or `native-qualified`) to the host's
capability registry. Runtime status, `paqvilo mirage preflight` and `GET /_sim/api/preflight` expose these levels and
what blocks a scenario; a placeholder never reports success. See
[capabilities and preflight](../mirage/docs/capabilities-and-preflight.md) and
[platform stack coverage](../mirage/docs/platform-stack.md) for each area's module and level.

Lense and Mirage share the catalogue, source model and browser integration: `paqvilo mirage dev` opens Mirage in the
Lense browser with the same panel, and Lense's lifecycle wrapper starts and stops only processes it owns.

## Project boundary

- Built-in behaviour derives from exports, Solution metadata, settings and data. It never selects a rule by an
  organization, website name, custom table prefix or customer route. Behaviour an export cannot show is a per-site
  `observed` setting with evidence.
- No adjacent directory is imported automatically. Explicit `dataPacks` entries load trusted JavaScript modules relative
  to their catalogue or project file; pack ids must be unique, and a pack's `matches({ portal })` decides whether it
  applies to an imported portal. An unknown pack export is reported as `PACK_EXPORT_UNKNOWN`, not ignored. The built-in
  preset library holds only generic presets.
- Synthetic datasets and business rules are pack extensions; they do not claim to reproduce a particular Dataverse
  implementation.
- Core CI never discovers or runs a project's tests. The publication allowlist excludes private packs, exports, state
  and captures, and the project-boundary check scans reusable source, tests, docs and examples for business
  dependencies. Project tests consume the public package exports and explicitly registered packs; see
  [project extensions](project-extensions.md).
