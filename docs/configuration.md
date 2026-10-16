# Configuration

Keep a shared `paqvilo.config.yml` in your portal project. It connects source exports,
live environments and local runtimes. Start with [project scaffolding](project-scaffold.md),
or run `paqvilo setup --open` to edit an existing or incomplete project in the local
[setup workspace](setup.md).

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

| Path | Resolved from |
| --- | --- |
| `sourceRoot` | Catalogue directory |
| Site `source` and `mirage.solutionRoots` | Resolved source root |
| Pack modules, `mirage.project`, local head assets | Catalogue directory |
| `--repo` | Invoking working directory; overrides `sourceRoot` |
| Paths inside a standalone Mirage project | That project file's directory |

Use `--source` for a direct export path. Live Lense Inspect can read the selected Solution
roots without starting Mirage or loading pack code. Missing managed metadata is reported.

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
See [Lense](lense.md) for the edit/preview workflow.

## Local runtime options

Use `defaults.mirage` for shared defaults and `sites.<id>.mirage` for site overrides.
Unknown settings are rejected. The setup workspace's YAML editor supports these settings.
Restart running previews after configuration changes.

| Setting | Purpose and reference |
| --- | --- |
| `dataPacks`, `preset` | Explicit project modules and seed data; [data packs](../mirage/docs/data-packs.md) |
| `presetMode` | `bootstrap` keeps an existing state; `always` reapplies the selected preset at startup. Status reports the decision. |
| `render.timeLimitMs` | Local Liquid budget, default 60,000 ms; [render limits](public-api.md#render-local-pages-within-a-budget) |
| `deploymentProfiles` | Select exported environment settings; [deployment profiles](../mirage/docs/deployment-profiles.md) |
| `personaContexts` | Bound isolated scenario copies; [persona setups](../mirage/docs/persona-catalog.md#isolated-contexts-and-scenarios) |
| `identityProvider` | Local chooser text, layout and project assets; [picker configuration](../mirage/docs/persona-catalog.md#identity-provider-and-lense-pickers) |
| `platform` | Explicit simulated platform controls; [configuration experiments](../mirage/docs/configuration-experiments.md) |
| `compat`, `head` | Local adapters and assets, described below |
| `observed` | Evidenced platform conventions absent from exports, described below |

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

| Convention | Settings and scope |
| --- | --- |
| Sign-in and site visibility | `loginPath` supplies a site-relative fallback when the export omits the login setting. `siteVisibility: private` displays the private-site banner. |
| Microsoft Entra authority | `azureAdAuthority` names one evidenced tenant authority when the exported AzureAD setting is absent. Shared tenant aliases and placeholders are rejected. |
| Portal-created row identity | `portalApplicationUser` and `portalApplicationUserId` identify the application's display name and systemuser GUID; exports do not supply them. |
| List OData feeds | `listODataFeeds: removed` is the default; use `served` only with evidence that the site still serves them. |
| Web API dates | `webApiDateParsing: month-first` and optional `webApiTwoDigitYearMax`; see [date input contracts](../mirage/docs/dataverse-parity.md#observed-portal-culture-parsed-dates). |
| Web API errors | `webApiErrorDetails: odata-wrapper` selects supported stable reader messages. `webApiErrorStacks: response-template` additionally needs exact trusted pack templates and visible source inner errors; see [data packs](../mirage/docs/data-packs.md). |
| Page-query validation | `requestValidation: aspnet-query` rejects supported dangerous decoded GET query values before Liquid. It does not scan API JSON, form bodies or cookies. |
| Page error presentation | `pageErrorPresentation: generic-error` selects the supported generic GET-query error page. It does not reproduce full hosted HTML or unrelated errors. |
| Exported SDK facts | `sdkMessages` maps exact exported message GUIDs to `{ name, evidence }`; `pluginSources` maps exact C# type names to `{ path, evidence }`. Paths stay inside the selected source/project root. |

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

Multiple visitors can share one runtime with independent cookies; configuration and records
remain shared. Independent scenarios need separate state files or persona contexts.
See [concurrent testing](public-api.md#test-many-visitors-concurrently) and
[state storage](../mirage/docs/state-storage.md).

## Standalone Mirage projects

Version 2 Mirage project files contain `primaryPortal`, `portals`, `solutions`, `references`
and `dataPacks`. Portals specify `{ id, path, origin?, solutions?, reference?, deploymentProfile?,
observed?, dataModel? }`; Solutions specify `{ id, path }`; references specify
`{ id, origin, default? }`. Paths are project-relative and each portal has isolated state.
References select context without authorizing network reads or writes. Solutions are layered
in dependency order; `solutionOrder: explicit` preserves an explicitly ordered list.

Use the catalogue workflow for ordinary project development. The standalone form is useful
for embedded tools and repeatable runtime inputs; see [bootstrap and sources](../mirage/docs/bootstrap-and-sources.md).
