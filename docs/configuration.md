# Configuration

Keep a shared `paqvilo.config.yml` in your portal project. It connects source exports,
live environments and local runtimes. Start with [project scaffolding](project-scaffold.md),
or run `paqvilo setup --open` to edit an existing or incomplete project in the local
[setup workspace](setup.md).

For model-driven apps or an API without Power Pages, use a version-2 Mirage project with top-level `runtime: { kind: model-driven }` or `{ kind: dataverse-api }`, `solutions` and optional explicit `dataPacks`. It needs no `portals` or reference origin. Configure `runtime.defaultApp` only for a model-driven surface. Select `simulation.level` as `dry-run`, `simulation` or `deep`; omission preserves existing ignored local-state behavior. Set `modelDriven: { trustedExtensions: true }` explicitly to run [supported form scripts, commands and PCF controls](../mirage/docs/model-driven-customizations.md). A catalogue places these keys under `sites.<id>.mirage` or `defaults.mirage`. Runtime/level/listener/trust changes apply on restart. See the [complete standalone example](../mirage/docs/standalone-organization.md) and [pack DATA ownership contract](../mirage/docs/simulation-levels.md).

## Select a catalogue

Pass `--config <file>` when running outside your project. Otherwise Paqvilo uses the working
directory's catalogue, falling back to the bundled example when none exists. The bundled
live URL is an inert placeholder; configure your own environment before using Lense.

```yaml
sourceRoot: ./sources
defaultSite: portal
portals: selected
sites:
  portal:
    source: portal-export
    defaultEnv: dev
    environments:
      dev: https://your-portal.example.test
      production:
        url: https://production.example.test
        caution: true
    mirage:
      port: 8787
      solutionRoots: [../solutions/Core]
      dataPacks:
        - id: sample-data
          module: ./pack/pack.mjs
      preset: sample-data
      presetMode: bootstrap
```

The pack and preset above are project-owned examples; register only modules you trust.

| Path                                              | Resolved from                                      |
| ------------------------------------------------- | -------------------------------------------------- |
| `sourceRoot`                                      | Catalogue directory                                |
| Site `source` and `mirage.solutionRoots`          | Resolved source root                               |
| Pack modules, `mirage.project`, local head assets | Catalogue directory                                |
| `--repo`                                          | Invoking working directory; overrides `sourceRoot` |
| Paths inside a standalone Mirage project          | That project file's directory                      |

Use `--source` for a direct export path. Live Lense Inspect can read the selected Solution
roots without starting Mirage or loading pack code. Missing managed metadata is reported.

A site without `source` and without `environments` whose `mirage.runtime.kind` is
`model-driven` or `dataverse-api` (the setup `model-driven` template) is a Mirage-only site.
`init --check` asks it for neither an environment nor a portal export; `lense list` lists it
("model-driven Mirage site, no portal export needed") and succeeds; `lense doctor` runs only its
Mirage checks ("Lense not applicable"); `mirage dev`/`start`/`stop --site <id>` run it, and
`--portals all` starts and stops it beside the portals (only portals enter the Lense portal
selector). `mirage init` writes no project file for it: its catalogue settings configure it.
Lense commands that need a portal target name it as not a Lense target.

## Personal settings and worktrees

Settings resolve in this order, highest priority first:

1. CLI options.
2. Shell `PAQVILO_*` variables.
3. `.env` beside the selected catalogue.
4. `paqvilo.config.local.yml` beside that catalogue.
5. The shared catalogue.

Ignore personal configuration, `.env` and `.paqvilo/`. Common environment choices include
`PAQVILO_REPO`, `PAQVILO_SITE`, `PAQVILO_ENV`, `PAQVILO_BROWSER`, `PAQVILO_PROFILE`,
`PAQVILO_SCOPE` and `PAQVILO_BASELINE`.

`paqvilo lense list --settings` shows available settings and their origins.
`paqvilo lense list --json` exposes resolved site/source paths; programmatic integrations
can use [`resolveCatalogue`](public-api.md#resolve-editor-paths).

Linked worktrees do not automatically inherit another checkout's `.env`. Use an external
shared project catalogue with personal overrides beside it, or set explicit shell values.
Refresh generated editor paths with `paqvilo init --refresh-editor` after changing checkouts.

Browser profiles keep identities separate. Attaching to an existing profile requires its
explicit user-data root and child directory; attached CDP browsers remain user-owned.
`--debug-port` configures a toolkit-launched browser. When attaching with `--cdp-url`,
clear any inherited `browser.debugPort` with `null`, `PAQVILO_DEBUG_PORT=0` or
`dev --debug-port 0`, then attach your debugger to the existing browser's CDP endpoint.
See [Lense](lense.md) for the edit/preview workflow.

## Local runtime options

Use `defaults.mirage` for shared defaults and `sites.<id>.mirage` for site overrides.
Unknown settings are rejected. The setup workspace's YAML editor supports these settings.
Restart running previews after configuration changes.

| Setting               | Purpose and reference                                                                                                                                                                                                                                                                                             |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dataPacks`, `preset` | Explicit project modules and seed data; [data packs](../mirage/docs/data-packs.md)                                                                                                                                                                                                                                |
| `presetConfiguration` | `data-only` (default) leaves configuration overrides intact. `apply` also applies the selected data preset’s linked configuration when it is seeded.                                                                                                                                                              |
| `presetMode`          | `bootstrap` keeps an existing state; `always` reapplies the selected preset at startup. Status reports the decision.                                                                                                                                                                                              |
| `render.timeLimitMs`  | Local Liquid budget, default 60,000 ms; [render limits](public-api.md#render-local-pages-within-a-budget)                                                                                                                                                                                                         |
| `deploymentProfiles`  | Select exported environment settings; [deployment profiles](../mirage/docs/deployment-profiles.md)                                                                                                                                                                                                                |
| `personaContexts`     | Bound isolated scenario copies; [persona setups](../mirage/docs/persona-catalog.md#isolated-contexts-and-scenarios)                                                                                                                                                                                               |
| `identityProvider`    | Local chooser text, layout and project assets; `newUser: auto \| always \| never` controls registration choices. `auto` follows site registration, open-registration/invitation and provider registration settings; [picker configuration](../mirage/docs/persona-catalog.md#identity-provider-and-lense-pickers) |
| `dataverse`           | Simulated Dataverse Web API on its own loopback origin, with OAuth applications and users; [Dataverse API](../mirage/docs/dataverse-api.md)                                                                                                                                                                       |
| `platform`            | Explicit simulated platform controls; [configuration experiments](../mirage/docs/configuration-experiments.md)                                                                                                                                                                                                    |
| `compat`, `head`      | Local adapters and assets, described below                                                                                                                                                                                                                                                                        |
| `observed`            | Evidenced platform conventions absent from exports, described below                                                                                                                                                                                                                                               |

### Settings table

Every Mirage setting is one row of `MIRAGE_SETTINGS` in `mirage/lib/config-keys.mjs`. The catalogue
key list, the project key list and every runtime option assembly derive from that table. Scopes
name where a key may appear: `catalogue` (`sites.<id>.mirage` and `defaults.mirage`),
`project` (top level of a Mirage project file) and `portal` (a project portal entry). When
several scopes set a key, a project portal wins over the project, which wins over the catalogue
site; `platform`, `deploymentProfiles` and the three content-policy keys keep the catalogue site
first. A project file wins only for keys it sets: a project without `simulation`, `modelDriven`,
`platform` or `dataverse` keeps the catalogue site value, and the default applies when neither sets it.
A key whose contract module has not registered its validator is accepted as an object and
reported as `CONFIG_KEY_PARSER_PENDING`. Version 1 project files report unknown keys as
`PROJECT_CONFIG_KEY_UNKNOWN` diagnostics; version 2 files reject them.

<!-- settings-table: generated from MIRAGE_SETTINGS (mirage/lib/config-keys.mjs) -->

| Setting                | Scopes                     | Purpose                                                                                                                                                                                           |
| ---------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`              | catalogue                  | Project file of this site, relative to the catalogue folder.                                                                                                                                      |
| `solutionRoots`        | catalogue                  | Solution folders, relative to the portal checkout root.                                                                                                                                           |
| `solutionOrder`        | catalogue, project         | derived (Solution dependency order, default) or explicit (listed order).                                                                                                                          |
| `dataPacks`            | catalogue, project         | Trusted pack modules ({ id, module } or a path). Project packs reach the runtime through the project summary.                                                                                     |
| `connectorScripts`     | catalogue, project         | Trusted custom connector C# scripts ({ connector, sha256 }); any other script.csx is refused.                                                                                                     |
| `port`                 | catalogue                  | Local port (0 chooses a free port).                                                                                                                                                               |
| `preset`               | catalogue                  | Startup data preset ID.                                                                                                                                                                           |
| `presetMode`           | catalogue                  | bootstrap or always.                                                                                                                                                                              |
| `presetConfiguration`  | catalogue                  | data-only or apply.                                                                                                                                                                               |
| `confinePortalPages`   | catalogue, project, portal | Confine portal pages with a content security policy.                                                                                                                                              |
| `externalAssets`       | catalogue, project, portal | Allow external assets in confined pages.                                                                                                                                                          |
| `externalFrameOrigins` | catalogue, project, portal | Origins confined pages may frame.                                                                                                                                                                 |
| `observed`             | catalogue, portal          | Observed platform behaviour with its evidence (validated by observedConfig).                                                                                                                      |
| `dataModel`            | catalogue, portal          | The Power Pages data model of the website export (standard or enhanced), only when the export does not record it. Unrelated to deployment profiles that share these names.                        |
| `compat`               | catalogue                  | Local compatibility adapters.                                                                                                                                                                     |
| `head`                 | catalogue                  | Local head stylesheets and scripts.                                                                                                                                                               |
| `render`               | catalogue                  | Liquid render limits.                                                                                                                                                                             |
| `trace`                | catalogue, project         | Local request tracing: level (off, summary or full), retained traces, spans per trace, payload bytes, persist; [request tracing](../mirage/docs/tracing.md)                                       |
| `sourceMaps`           | catalogue, project, portal | Append file-backed debugger metadata to local scripts/styles (default true); false serves original asset bytes.                                                                                   |
| `personaContexts`      | catalogue                  | Persona context runtimes.                                                                                                                                                                         |
| `identityProvider`     | catalogue                  | Local external identity provider.                                                                                                                                                                 |
| `deploymentProfiles`   | catalogue, project, portal | Deployment profile files.                                                                                                                                                                         |
| `platform`             | catalogue, project, portal | Platform settings with their evidence.                                                                                                                                                            |
| `dataverse`            | catalogue, project         | Simulated Dataverse API.                                                                                                                                                                          |
| `runtime`              | catalogue, project         | power-pages, model-driven or dataverse-api.                                                                                                                                                       |
| `simulation`           | catalogue, project         | dry-run, simulation or deep.                                                                                                                                                                      |
| `modelDriven`          | catalogue, project         | Model-driven host settings.                                                                                                                                                                       |
| `environmentVariables` | project                    | Local environment-variable values by schema name.                                                                                                                                                 |
| `connections`          | catalogue, project         | Local connections by connection id. Contract: see [operations.md](../mirage/docs/operations.md).                                                                                                  |
| `secrets`              | catalogue, project         | Secrets by `<vault>/<secret>`: an environment variable or a DPAPI-protected value, never a literal. Validated by `secret-resolver.mjs`. Hashed in the runtime identity.                           |
| `localServices`        | catalogue, project         | Declared local services that are probed, never started. Validated by `local-services.mjs`.                                                                                                        |
| `providers`            | catalogue, project         | Storage routes, messaging providers and the outbox. Contract: see [storage-providers.md](../mirage/docs/storage-providers.md), [messaging-and-outbox.md](../mirage/docs/messaging-and-outbox.md). |
| `canvas`               | project                    | Canvas surface switch (`enabled`) and project canvas app sources (`sources`). Contract: see [canvas-apps.md](../mirage/docs/canvas-apps.md#project-configuration).                                |
| `codeApps`             | project                    | Code apps served under /_apps/code/. Contract: see [code-apps.md](../mirage/docs/code-apps.md).                                                                                                   |

<!-- /settings-table -->

Mirage's `sourceMaps` setting belongs under `sites.<id>.mirage` or `defaults.mirage`
in a catalogue, and at project or portal level in a Mirage project. Set it to
`false` and restart to omit generated debugger trailers for asset comparisons.
The catalogue's top-level `sourceMaps` and `PAQVILO_SOURCE_MAPS` control Lense
overlays independently; they do not disable Mirage's debugger metadata.

### Local assets and compatibility

```yaml
mirage:
  compat:
    footerSpacing: false
  head:
    stylesheets: [./local/extra.css]
    scripts: [./local/flags.js]
```

These project files must exist inside the catalogue directory, including after resolving
symlinks. They are served under `/_sim-local/head/` before platform/authored scripts.
Doctor, status and page diagnostics identify them as local-only; exports are never edited.

Boolean adapter switches are `footerSpacing`, `dateFormat`, `dateTimePicker`,
`bootstrapPlugins`, `jqueryUiDialog`, `jqueryUiWidgets`, `blockUi`, `entityGrid`,
`platformApp` and `webForms`. Disabling a fallback removes it from toolkit injection and
local platform bundles. Authored and captured scripts retain their own behavior.
See [platform resources](../mirage/docs/platform-resources.md) for explicit shell capture.

## Observed platform behavior

An `observed` mapping records behavior unavailable from exports. Every observation needs
an `evidence` reference from the site being modeled. Do not copy another site's observations
merely because both use Power Pages. Omitted settings retain their defaults.

| Convention                  | Settings and scope                                                                                                                                                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign-in and site visibility | `loginPath` supplies a site-relative fallback when the export omits the login setting. `siteVisibility: private` displays the private-site banner.                                                                                                    |
| Microsoft Entra authority   | `azureAdAuthority` names one evidenced tenant authority when the exported AzureAD setting is absent. Shared tenant aliases and placeholders are rejected.                                                                                             |
| Portal-created row identity | `portalApplicationUser` and `portalApplicationUserId` identify the application's display name and systemuser GUID; exports do not supply them.                                                                                                        |
| List OData feeds            | `listODataFeeds: removed` is the default; use `served` only with evidence that the site still serves them.                                                                                                                                            |
| Web API dates               | `webApiDateParsing: month-first` and optional `webApiTwoDigitYearMax`; see [date input contracts](../mirage/docs/dataverse-parity.md#observed-portal-culture-parsed-dates).                                                                           |
| Web API errors              | `webApiErrorDetails: odata-wrapper` selects supported stable reader messages. `webApiErrorStacks: response-template` additionally needs exact trusted pack templates and visible source inner errors; see [data packs](../mirage/docs/data-packs.md). |
| Page-query validation       | `requestValidation: aspnet-query` rejects supported dangerous decoded GET query values before Liquid. It does not scan API JSON, form bodies or cookies.                                                                                              |
| Page error presentation     | `pageErrorPresentation: generic-error` selects the supported generic GET-query error page. It does not reproduce full hosted HTML or unrelated errors.                                                                                                |
| Exported SDK facts          | `sdkMessages` maps exact exported message GUIDs to `{ name, evidence }`; `pluginSources` maps exact C# type names to `{ path, evidence }`. Paths stay inside the selected source/project root.                                                        |

The table highlights common options rather than every adapter convention. Detailed form,
Liquid, query and plugin contracts live in the [Mirage reference](../mirage/docs/README.md).
Observations do not grant access, execute CLR assemblies or prove whole-response parity.

## State and several sites

`portals: all` makes configured targets available in one browser. Origins activate on visit;
`--site` selects the first portal. Use `--portals selected` to limit lifecycle operations.
Each Mirage site has its own port, state and session cookie. Choose distinct fixed ports
or `0` for a free port. Port/state/preset/Solution CLI overrides apply to the selected site.

Runtime discovery, logs and generated projects live under `.paqvilo/` beside the catalogue.
A standalone `--project` uses its own directory. Use the same scope for `mirage status`
and `mirage stop`, especially when running from another directory. Direct Mirage commands
also accept `--state-dir` for explicit discovery/state storage.

For a background runtime, copy the stop command printed by `mirage start`. It
preserves the selected catalogue/project and runtime overrides, including the
port and state selectors used for projectless standalone sessions.

Multiple visitors can share one runtime with independent cookies; configuration and records
remain shared. Independent scenarios need separate state files or persona contexts.
See [concurrent testing](public-api.md#test-many-visitors-concurrently) and
[state storage](../mirage/docs/state-storage.md).

## Standalone Mirage projects

Version 2 Mirage project files contain `defaultPortal`, `portals`, `solutions`, `references`
and `dataPacks`. Portals specify `{ id, path, origin?, solutions?, reference?, deploymentProfile?,
observed?, dataModel? }`; Solutions specify `{ id, path }`; references specify
`{ id, origin, default? }`. Paths are project-relative and each portal has isolated state.
References select context without authorizing network reads or writes. Solutions are layered
in dependency order; `solutionOrder: explicit` preserves an explicitly ordered list.

Use the catalogue workflow for ordinary project development. The standalone form is useful
for embedded tools and repeatable runtime inputs; see [bootstrap and sources](../mirage/docs/bootstrap-and-sources.md).

### Markup overlays

A site’s `markup` setting controls literal HTML baseline overlays in Lense:

```yaml
sites:
  portal:
    markup:
      enabled: true
      baseline: HEAD
      kinds: [web-template, content-snippet, page-copy, page-summary, metadata-markup]
```

Set `enabled: false` to disable these patches. `baseline` selects the Git reference used for comparison; `kinds` limits eligible exported markup. These settings do not execute Liquid or deploy source changes. Inspect applied resources and unmatched patches after refreshing.
