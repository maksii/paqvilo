# Configuration

A shared `paqvilo.config.yml` (the catalogue) connects source exports, live environments and local runtimes. Create one
with [project scaffolding](project-scaffold.md), or edit it in the [setup workspace](setup.md) with
`paqvilo setup --open`. Unknown catalogue keys are rejected (`Unknown setting sites.portal.bogus`), and a file that is
not valid YAML is refused by position, without its content, for example
`paqvilo.config.yml is not valid YAML (BAD_INDENT at line 3, column 1). Fix the file.`

## Select a catalogue

Commands use `--config <file>`, else `paqvilo.config.yml` in the working directory. Without either, a command refuses
with `No catalogue: <folder>/paqvilo.config.yml does not exist. Run in the folder that holds paqvilo.config.yml, or pass
--config <catalogue>.`, and a `--config` file that does not exist with `--config file not found: <file>. Pass an
existing file.` (only `mirage status` and `stop` still select the runtimes recorded for a removed catalogue). A
`--source <export>` or Mirage `--project <file>` run without `--site` needs no catalogue: it takes the site defaults
of the toolkit's bundled example (whose live URL is an inert placeholder) and keeps `.env`, personal settings and
`.paqvilo/` state in the working directory. `paqvilo setup` has no bundled fallback.

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
      preset: sample-data-empty
      presetMode: bootstrap
```

The pack and preset are project-owned examples (`paqvilo init --pack sample-data` generates this pack with its empty
preset); register only modules you trust. A preset is found only when its pack's `matches()` accepts the export.

| Path                                              | Resolved from                                      |
| ------------------------------------------------- | -------------------------------------------------- |
| `sourceRoot`                                      | Catalogue directory                                |
| Site `source` and `mirage.solutionRoots`          | Resolved source root                               |
| Pack modules, `mirage.project`, local head assets | Catalogue directory                                |
| `--repo`                                          | Invoking working directory; overrides `sourceRoot` |
| `PAQVILO_REPO`                                    | Catalogue directory; overrides `sourceRoot`        |
| `PAQVILO_<SITE>_SOURCE`                           | Catalogue directory                                |
| Paths inside a standalone Mirage project          | That project file's directory                      |

`--source` selects an export folder directly. Live Lense Inspect reads the selected Solution roots without starting
Mirage or loading pack code; missing managed metadata is reported.

A site with no `source`, no `environments` and a `mirage.runtime.kind` of `model-driven` or `dataverse-api` is a
Mirage-only site. `init --check` asks it for neither an environment nor an export; `lense list` lists it; `lense doctor`
runs only its Mirage checks; `mirage dev|start|stop --site <id>` run it, and `--portals all` starts and stops it beside
the portals without adding it to the Lense selector. `mirage init` writes no project file for it. Lense commands that
need a portal target refuse it (`mirage_only_site`).

## Personal settings and worktrees

Settings resolve in this order, highest first:

1. CLI options.
2. Shell `PAQVILO_*` variables.
3. `.env` beside the selected catalogue.
4. `paqvilo.config.local.yml` beside that catalogue (same format as the catalogue).
5. The shared catalogue.

Keep `paqvilo.config.local.yml`, `.env` and `.paqvilo/` ignored. `paqvilo lense use [site] [env]` writes the selection
to `.env`; `paqvilo lense list --settings` shows every setting and its origin; `paqvilo lense list --json` exposes
resolved paths under `resolved` (programmatic: [`resolveCatalogue`](public-api.md#resolve-editor-paths)).

| Variable                                                | Meaning                                                                                                            |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `PAQVILO_REPO`                                          | Portal checkout/worktree root for shared relative site sources (`--repo`)                                          |
| `PAQVILO_SITE`, `PAQVILO_ENV`                           | Site and its environment                                                                                           |
| `PAQVILO_URL`, `PAQVILO_SOURCE`                         | Site URL or export folder instead of the configured one; ignored when `--site` (or for the URL, `--env`) is passed |
| `PAQVILO_PORTALS`                                       | `selected` or `all`                                                                                                |
| `PAQVILO_SCOPE`, `PAQVILO_BASELINE`                     | `all`/`changed`; Git ref that stands for what is deployed                                                          |
| `PAQVILO_START_PATH`                                    | First tab only                                                                                                     |
| `PAQVILO_BROWSER`, `PAQVILO_HEADLESS`                   | `msedge`, `chrome` or `chromium`; no browser window                                                                |
| `PAQVILO_PROFILE_DIR`, `PAQVILO_PROFILE`                | Folder of toolkit profiles; named profile (1–64 letters, digits, `_`, `-`; case-insensitive)                       |
| `PAQVILO_USER_DATA_DIR`, `PAQVILO_PROFILE_DIRECTORY`    | Existing browser user-data root (relative to the catalogue) and its child profile, e.g. `Default`                  |
| `PAQVILO_CDP_URL`, `PAQVILO_DEBUG_PORT`                 | Attach to a running browser (endpoint, or a channel such as `msedge`); launched browser debugger port (`0` = off)  |
| `PAQVILO_BYPASS_CSP`                                    | `true` bypasses Content-Security-Policy in the dev browser (default `false`)                                       |
| `PAQVILO_AGENT`, `PAQVILO_LIVE_RELOAD`, `PAQVILO_PANEL` | `false` disables the agent API, reload on save, or the page panel                                                  |
| `PAQVILO_EDITOR`                                        | Command run as `<command> -g file:line` from the panel (default `code`)                                            |
| `PAQVILO_SOURCE_MAPS`                                   | `false` serves Lense overlays without debugger metadata                                                            |
| `PAQVILO_<SITE>_SOURCE`, `PAQVILO_<SITE>_ENV_<NAME>`    | Override a site's export folder, or add an environment URL; an undeclared `<SITE>` adds a site                     |

`<SITE>` is the site name in upper case with `-` written as `_`; `<NAME>` becomes a lower-case environment name with `_`
as `-`. An undeclared `<SITE>` adds a site named in lower case (`PAQVILO_MY_SITE_SOURCE` adds `my_site`). Any other
`PAQVILO_*` variable in `.env` or the shell is an error, except the tool variables read directly by scripts (such as
`PAQVILO_DEBUG` and `PAQVILO_KEEP_TEMP`). Boolean values accept `true/false`, `1/0`, `yes/no` and `on/off`.

Linked worktrees do not inherit another checkout's `.env`. Keep the catalogue, its local file and `.env` in a shared
external folder, select it with `--config`, and point `PAQVILO_REPO` (or `--repo`) at the current worktree. Refresh
generated editor paths with `paqvilo init --refresh-editor` after changing checkouts. Sign-in state is never copied
between worktrees.

Browser profiles keep identities separate. `browser.profile` cannot be combined with `browser.userDataDir`;
`browser.profileDirectory` requires `browser.userDataDir` (the profile to launch) or `browser.cdpUrl` (the open profile
of the attached browser to use); `browser.cdpUrl` cannot be combined with `browser.profile` or `browser.userDataDir`.
[Which browser profile](lense.md#which-browser-profile) has the steps for each choice. An attached CDP browser stays
user-owned: clear an inherited `browser.debugPort` with `null`, `PAQVILO_DEBUG_PORT=0` or
`dev --debug-port 0`, and attach your debugger to that browser's own endpoint.

## Lense catalogue settings

Top level:

| Key              | Default             | Meaning                                                                        |
| ---------------- | ------------------- | ------------------------------------------------------------------------------ |
| `sourceRoot`     | catalogue directory | Root for relative site sources                                                 |
| `defaultSite`    | first site          | Site used when none is selected                                                |
| `portals`        | `selected`          | `all` makes every configured target available in one browser                   |
| `includeCaution` | `false`             | Let `portals: all` include `caution` environments                              |
| `sites`          |                     | Sites by identifier                                                            |
| `defaults`       |                     | Site keys applied to every site, except `source`, `defaultEnv`, `environments` |
| `browser`        | see below           | Dev browser                                                                    |
| `agent.enabled`  | `true`              | Authenticated local [agent API](lense.md#agent-api-reference)                  |
| `liveReload`     | `true`              | Reload tabs on save                                                            |
| `panel`          | `true`              | Show the dev panel                                                             |
| `editor`         | `code`              | Command that opens a file from the panel                                       |
| `sourceMaps`     | `true`              | Debugger metadata on Lense overlays (Mirage has its own `mirage.sourceMaps`)   |

`browser`: `channel` (`msedge`), `headless` (`false`), `profileDir` (`.paqvilo/profiles`), `profile`, `userDataDir`,
`profileDirectory`, `cdpUrl` (an `http`, `https`, `ws` or `wss` endpoint, or a channel such as `msedge`), `debugPort`
(0 or `null` = off) and `bypassCSP` (`false`). The last six default to `null`/`false`.

Site keys (also accepted under `defaults` where noted above):

| Key                                    | Default           | Meaning                                                                                                                                                                                                                                             |
| -------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `source`                               |                   | Export folder, relative to the source root                                                                                                                                                                                                          |
| `defaultEnv`                           | first environment | Environment used when none is selected                                                                                                                                                                                                              |
| `environments.<name>`                  |                   | A URL, or `{ url, baseline?, scope?, startPath?, caution? }`; `caution: true` asks for confirmation before switching to it in the panel                                                                                                             |
| `startPath`                            | `/`               | First tab only                                                                                                                                                                                                                                      |
| `scope`                                | `all`             | `changed` overlays only files that differ from the baseline                                                                                                                                                                                         |
| `webFiles.enabled`, `webFiles.exclude` | `true`, `[]`      | Web-file overlays; URL globs to leave online                                                                                                                                                                                                        |
| `inline.enabled`, `inline.kinds`       | `true`, all       | Inline block overlays of kinds `page-js`, `page-css`, `basic-form-js`, `advanced-form-step-js`, `list-js`                                                                                                                                           |
| `inline.minSimilarity`                 | `0.5`             | 0..1 match threshold for an inline block in served HTML                                                                                                                                                                                             |
| `inline.injectMissingPageBlocks`       | `true`            | Inject a page block the served HTML does not contain                                                                                                                                                                                                |
| `markup.enabled`, `markup.kinds`       | `true`, all       | Literal HTML baseline patches of kinds `web-template`, `content-snippet`, `page-copy`, `page-summary`, `metadata-markup`                                                                                                                            |
| `markup.baseline`                      | `HEAD`            | Git ref the markup patches compare against (`--baseline`, `PAQVILO_BASELINE` and an environment `baseline` override it)                                                                                                                             |
| `routes`                               | `[]`              | `{ url, file \| dir \| passthrough: true }`: URL glob (`*` one segment, `**` any depth) to a local file, a folder, or the online site                                                                                                               |
| `analysis.limits`                      | built-in ceilings | Static analysis budget of this site: `{ files, directories, entries, fileBytes, totalBytes, roots }`, each raised or lowered up to its maximum; `--analysis-limit` overrides; [bounded local inventory](static-analysis.md#bounded-local-inventory) |
| `mirage`                               |                   | [Local runtime options](#local-runtime-options)                                                                                                                                                                                                     |

A route that matches but finds no local file falls through to the automatic mapping. Markup patches do not execute
Liquid; inspect applied resources and unmatched patches after refreshing.

## Local runtime options

`defaults.mirage` holds shared Mirage defaults and `sites.<id>.mirage` overrides them. Restart running previews after
changing them.

A model-driven app or an API without Power Pages runs from a version 2 Mirage project with
`runtime: { kind: model-driven }` or `{ kind: dataverse-api }`, `solutions` and optional `dataPacks`; it needs no
`portals` or reference origin. `runtime.defaultApp` applies only to a model-driven surface. `simulation.level` is
`dry-run`, `simulation` or `deep`. `modelDriven: { trustedExtensions: true }` runs
[form scripts, commands and PCF controls](../mirage/docs/model-driven-customizations.md). See the
[standalone example](../mirage/docs/standalone-organization.md) and the
[pack data ownership contract](../mirage/docs/simulation-levels.md).

### Settings table

Every Mirage setting is one row of `MIRAGE_SETTINGS` in `mirage/lib/config-keys.mjs`; the catalogue and project key
lists and every runtime option assembly derive from it. Scopes: `catalogue` (`sites.<id>.mirage`, `defaults.mirage`),
`project` (top level of a Mirage project file) and `portal` (a project portal entry). When several scopes set a key,
portal wins over project, which wins over the catalogue site; `dataPacks` is read from the catalogue alone (project
packs arrive through the project summary), and `platform`, `deploymentProfiles`, `confinePortalPages`, `externalAssets`
and `externalFrameOrigins` put the catalogue site first. A project wins only for keys it sets. A key whose contract
module has not registered its validator is accepted as an object and reported as `CONFIG_KEY_PARSER_PENDING`. A
version 1 project file still loads with an unknown key, which `mirage inspect` and the runtime's startup diagnostics
report as a `PROJECT_CONFIG_KEY_UNKNOWN` warning; a version 2 file is refused.

<!-- settings-table: generated from MIRAGE_SETTINGS (mirage/lib/config-keys.mjs) -->

| Setting                | Scopes                     | Purpose                                                                                                                                                                                                                            |
| ---------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `project`              | catalogue                  | Project file of this site, relative to the catalogue folder.                                                                                                                                                                       |
| `solutionRoots`        | catalogue                  | Solution folders, relative to the portal checkout root.                                                                                                                                                                            |
| `solutionOrder`        | catalogue, project         | `derived` (Solution dependency order, default) or `explicit` (listed order).                                                                                                                                                       |
| `dataPacks`            | catalogue, project         | Trusted pack modules (`{ id, module }` or a path); [data packs](../mirage/docs/data-packs.md).                                                                                                                                     |
| `connectorScripts`     | catalogue, project         | Trusted custom connector C# scripts (`{ connector, sha256 }`); any other `script.csx` is refused.                                                                                                                                  |
| `port`                 | catalogue                  | Local port (default 8787; 0 chooses a free port).                                                                                                                                                                                  |
| `preset`               | catalogue, project         | Startup data preset ID.                                                                                                                                                                                                            |
| `presetMode`           | catalogue, project         | `always` (default) or `bootstrap`. `always` reapplies the preset at startup, resetting local edits; `bootstrap` applies it only when no state file exists.                                                                         |
| `presetConfiguration`  | catalogue, project         | `data-only` (default) or `apply` (also apply the preset's linked configuration when it is seeded).                                                                                                                                 |
| `confinePortalPages`   | catalogue, project, portal | Confine portal pages with a content security policy.                                                                                                                                                                               |
| `externalAssets`       | catalogue, project, portal | Allow external assets in confined pages.                                                                                                                                                                                           |
| `externalFrameOrigins` | catalogue, project, portal | Origins confined pages may frame.                                                                                                                                                                                                  |
| `observed`             | catalogue, portal          | [Observed platform behaviour](#observed-platform-behaviour) with its evidence.                                                                                                                                                     |
| `dataModel`            | catalogue, portal          | Power Pages data model of the export (`standard` or `enhanced`), only when the export does not record it. Unrelated to deployment profiles of the same names.                                                                      |
| `compat`               | catalogue                  | Local compatibility adapters; [below](#local-assets-and-compatibility).                                                                                                                                                            |
| `head`                 | catalogue                  | Local head stylesheets and scripts; [below](#local-assets-and-compatibility).                                                                                                                                                      |
| `render`               | catalogue                  | `timeLimitMs`: Liquid render budget, 1–3,600,000, default 60,000; [render limits](public-api.md#render-local-pages-within-a-budget).                                                                                               |
| `trace`                | catalogue, project         | Request tracing: level (`off`, `summary`, `full`), retained traces, spans per trace, payload bytes, persist; all change at run time in `/_sim/`; [request tracing](../mirage/docs/tracing.md).                                     |
| `logs`                 | catalogue, project         | `retain`: log lines kept for the `/_sim/` log stream and `GET /_sim/api/logs` (0–50,000, default 2,000; 0 keeps none).                                                                                                             |
| `sourceMaps`           | catalogue, project, portal | File-backed debugger metadata on served scripts and styles (default `true`); `false` serves original bytes. Independent of the top-level Lense `sourceMaps`.                                                                       |
| `personaContexts`      | catalogue                  | Persona context runtimes; [isolated contexts](../mirage/docs/persona-catalog.md#isolated-contexts-and-scenarios).                                                                                                                  |
| `identityProvider`     | catalogue                  | Local sign-in chooser text, layout and assets; `newUser: auto \| always \| never` (default `auto` follows the site's registration settings); [pickers](../mirage/docs/persona-catalog.md#identity-provider-and-lense-pickers).     |
| `deploymentProfiles`   | catalogue, project, portal | Deployment profile files; [deployment profiles](../mirage/docs/deployment-profiles.md).                                                                                                                                            |
| `platform`             | catalogue, project, portal | Platform settings with their evidence, e.g. `{ QueryLinkEntityLimit: 50, evidence: '...' }`; [configuration experiments](../mirage/docs/configuration-experiments.md).                                                             |
| `uploadedAssemblies`   | catalogue, project         | `clr` (default) or `placeholder`: the default mode of a registered plug-in step whose type is in an assembly with uploaded content; [uploaded assemblies](../mirage/docs/dataverse-plugins.md#uploaded-assemblies-run-by-default). |
| `dataverse`            | catalogue, project         | Simulated Dataverse Web API on its own loopback origin; [Dataverse API](../mirage/docs/dataverse-api.md).                                                                                                                          |
| `runtime`              | catalogue, project         | `power-pages`, `model-driven` or `dataverse-api`.                                                                                                                                                                                  |
| `simulation`           | catalogue, project         | `dry-run`, `simulation` or `deep`.                                                                                                                                                                                                 |
| `modelDriven`          | catalogue, project         | Model-driven host settings.                                                                                                                                                                                                        |
| `environmentVariables` | project                    | Local environment-variable values by schema name.                                                                                                                                                                                  |
| `implicitGrant`        | project                    | `signingKeys` of `{ privateKeyFile, thumbprint }`: stable PEM RSA keys for implicit grant tokens; [implicit grant tokens](../mirage/docs/sim-administration.md#implicit-grant-tokens).                                             |
| `connections`          | catalogue, project         | Local connections by connection id; [operations](../mirage/docs/operations.md).                                                                                                                                                    |
| `secrets`              | catalogue, project         | Secrets by `<vault>/<secret>`: an environment variable or a DPAPI-protected value, never a literal. Hashed in the runtime identity.                                                                                                |
| `localServices`        | catalogue, project         | Declared local services that are probed, never started.                                                                                                                                                                            |
| `providers`            | catalogue, project         | `storage`, `routes`, `messaging` and `outbox`; [storage providers](../mirage/docs/storage-providers.md), [messaging](../mirage/docs/messaging-and-outbox.md).                                                                      |
| `canvas`               | catalogue, project         | Canvas surface switch (`enabled`) and project canvas sources (`sources`); [canvas apps](../mirage/docs/canvas-apps.md#setup-and-sources).                                                                                          |
| `pcf`                  | catalogue, project         | PCF build outputs (`sources`), byte cap (`maxResourceBytes`, 8 MiB), React/Fluent UI files (`platformLibraries`), Liquid datasets (`liquidDatasetBinding`: `none` default, `view`); [PCF](../mirage/docs/code-components.md).      |
| `codeApps`             | project                    | Code apps served under `/_apps/code/`; [code apps](../mirage/docs/code-apps.md).                                                                                                                                                   |

<!-- /settings-table -->

### Local assets and compatibility

```yaml
mirage:
  compat:
    footerSpacing: false
  head:
    stylesheets: [./local/extra.css]
    scripts: [./local/flags.js]
```

Head files must stay inside the catalogue directory after resolving symlinks. They are served under `/_sim-local/head/`
before platform and authored scripts, and doctor, status and page diagnostics mark them local-only; exports are never
edited.

`compat` booleans: `footerSpacing`, `dateFormat`, `dateTimePicker`, `bootstrapPlugins`, `jqueryUiDialog`,
`jqueryUiWidgets`, `blockUi`, `entityGrid`, `platformApp` and `webForms`. `false` removes that fallback from toolkit
injection and local platform bundles; authored and captured scripts keep their own behaviour. See
[platform resources](../mirage/docs/platform-resources.md) for shell capture.

## Observed platform behaviour

`observed` records behaviour an export does not contain. Every observation needs an `evidence` reference from the site
being modelled; do not copy another site's observations. Omitted settings keep their defaults. Observations do not grant
access, execute CLR assemblies or prove whole-response parity. The table lists common keys; the full set is validated in
`mirage/lib/project-config.mjs`, and the form, Liquid, query and plug-in contracts live in the
[Mirage reference](../mirage/docs/README.md).

| Convention                               | Settings                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sign-in and site visibility              | `loginPath`: site-relative fallback when the export omits the login setting. `siteVisibility: private` shows the private-site banner.                                                                                                                                                                                                                  |
| Generative AI governance                 | `siteUserGenerativeAi: disabled` (default `enabled`): the Copilot hub blocks AI for site users, and the Data Summarization API answers 400 `90041001`; [data packs](../mirage/docs/data-packs.md#portal-data-summarization-fixture).                                                                                                                   |
| Microsoft Entra authority                | `azureAdAuthority`: one tenant's authority when the exported AzureAD setting is absent; shared aliases and placeholders are rejected.                                                                                                                                                                                                                  |
| Portal-created row identity              | `portalApplicationUser`, `portalApplicationUserId`: the application's display name and systemuser GUID.                                                                                                                                                                                                                                                |
| List OData feeds                         | `listODataFeeds: removed` (default) or `served`.                                                                                                                                                                                                                                                                                                       |
| Web API dates                            | `webApiDateParsing: month-first` and optional `webApiTwoDigitYearMax`; [date input contracts](../mirage/docs/dataverse-parity.md#observed-portal-culture-parsed-dates).                                                                                                                                                                                |
| Web API errors                           | `webApiErrorDetails: odata-wrapper` selects stable reader messages. `webApiErrorStacks: response-template` also needs exact trusted pack templates; [data packs](../mirage/docs/data-packs.md).                                                                                                                                                        |
| Dataverse HTTP reader errors             | `dataverseErrorStacks: response-template` (default `diagnostic`) needs separately registered pack `dataverseErrorTemplates`; [data packs](../mirage/docs/data-packs.md).                                                                                                                                                                               |
| Dataverse FetchXML attribute diagnostics | `dataverseAttributeErrorContexts`: entity logical name to `{ organizationIndex, metadataId? }`. An exported `MetadataId` wins over `metadataId`. Only genuine missing-attribute errors use it.                                                                                                                                                         |
| Captured metadata epoch                  | `webApiGlobalMetadataVersion`: numeric epoch shared by CSDL ETags and record annotations while source metadata is unchanged; a local metadata change switches to one synthesized epoch, row edits do not.                                                                                                                                              |
| Portal write responses                   | `webApiWriteResponse: portal-classic`: POST/PATCH entity identifiers on the portal origin and `/api/data/v9.1/`, no Content-Type on 204. Default `local`.                                                                                                                                                                                              |
| Portal record JSON                       | `webApiReadResponse: jsonnet-indented`: successful record GETs indented by two spaces with CRLF and primary identifiers first. Default `local`.                                                                                                                                                                                                        |
| Portal file downloads                    | `webApiFileDownload: portal-range` omits ETag and Accept-Ranges on file-column GETs and treats `bytes=-N` as `bytes=0-N`. The default partial response includes a file validator.                                                                                                                                                                      |
| Web API request bodies                   | `webApiRequestBody: portal-classic`: single-layer decoding of a JSON object string. Default `strict` rejects primitive roots. Table, row, field and private-property guards always apply; the native forbidden-field transport bypass is not emulated.                                                                                                 |
| Page-query validation                    | `requestValidation: aspnet-query`: rejects dangerous decoded GET query values before Liquid; does not scan API JSON, form bodies or cookies.                                                                                                                                                                                                           |
| Page error presentation                  | `pageErrorPresentation: generic-error`: the generic GET-query error page only.                                                                                                                                                                                                                                                                         |
| Form submission errors                   | `formSubmissionErrorMarkup: paragraph` when the host reads `#MessagePanel p`; default `inline`. Message text stays escaped in JSON and postback errors.                                                                                                                                                                                                |
| HTTP transport and policies              | `strictTransportSecurity`: the HSTS header the site sends, sent on http loopback only. `defaultContentSecurityPolicy: platform`: the documented default policy of sites created after November 10, 2025. `corsPages` (with `siteVisibility: public`): authored pages shared across origins; [HTTP transport and CORS](../mirage/docs/http-headers.md). |
| Power BI                                 | `powerBiOutput: empty`: a site whose `{% powerbi %}` output was captured empty (integration off); [service fixtures](../mirage/docs/service-fixtures.md#power-bi-in-liquid).                                                                                                                                                                           |
| Exported SDK facts                       | `sdkMessages`: exported message GUID to `{ name, evidence }`; `pluginSources`: C# type name to `{ path, evidence, root? }`; a relative `root` resolves against the project file's folder, in catalogue settings against `sourceRoot` (the default root).                                                                                               |

## State and several sites

`portals: all` makes every configured target available in one browser; origins activate on visit and `--site` selects
the first. It cannot be combined with `--url`, `--source`, `PAQVILO_URL` or `PAQVILO_SOURCE`, two targets may not share
an origin, and `caution` environments are left out unless selected or `includeCaution: true`. `--portals selected`
limits lifecycle operations to one site.

Each Mirage site has its own port, state file and session cookie; use distinct fixed ports or `0`. Port, state, preset
and Solution CLI overrides apply to the selected site.

Runtime discovery, logs and generated projects live under `.paqvilo/` beside the catalogue; a standalone `--project`
uses its own directory, and `mirage serve`, `render`, `capture-stylesheets` and `capture-snippet-composition` accept
`--state-dir`. For a background runtime, run the stop command `mirage start` prints; which runtimes `mirage status` and
`mirage stop` select is described in [Mirage in the Lense browser](../mirage/docs/toolkit-integration.md).

Visitors of one runtime have independent cookies but share configuration and records. Independent scenarios need
separate state files or persona contexts; see [concurrent testing](public-api.md#test-many-visitors-concurrently) and
[state storage](../mirage/docs/state-storage.md).

## Standalone Mirage projects

A version 2 Mirage project file contains `defaultPortal`, `portals`, `solutions`, `references` and `dataPacks`, plus the
project-scope settings above. Portals are
`{ id, path, origin?, solutions?, reference?, deploymentProfile?, observed?, dataModel? }`, Solutions `{ id, path }`,
references `{ id, origin, default? }`. Paths are project-relative and each portal has its own state. References select
context; they authorize no network reads or writes. Solutions layer in dependency order unless
`solutionOrder: explicit`.

The startup preset comes from `--preset`, else the project, else the catalogue site, and applies when the runtime is
served (`mirage serve`, `mirage dev`); other commands apply a preset only when `--preset` is passed. `mirage dev` and
`mirage start` with `--project` take catalogue-only site settings such as `personaContexts` from the site `--site`
selects, else from the site whose `mirage.project` is that file; `--config` alone selects no site
([persona contexts](../mirage/docs/persona-catalog.md#isolated-contexts-and-scenarios)).

Use the catalogue for ordinary project development; the standalone form suits embedded tools and repeatable runtime
inputs. See [bootstrap and sources](../mirage/docs/bootstrap-and-sources.md).
