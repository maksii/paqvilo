# Configuration

Use `paqvilo setup --open` to view readiness and edit these settings in the local `/_setup/` workspace, even before a preview can start. Generated projects provide `npm run configure`. Mirage also serves `/_setup/` beside `/_sim/`; Lense prints a separate local URL. Saves apply at the next start. See [the setup workspace](setup.md).

For a new consumer project, use [paqvilo init](project-scaffold.md) to generate the catalogue and its surrounding scripts/tests. Unknown source paths and development URLs carry `TODO(paqvilo-init):` markers. Run `paqvilo init --check` to list markers with file/line, catalogue schema failures, inert placeholder origins, missing pack modules and missing source/Solution folders. The check is read-only and does not execute pack modules. It exits one while any item remains; `lense doctor` adds a nonfatal reminder for unfinished generated projects. Personal settings still follow the precedence below.

## Local project additions (0.9.4)

Configure these in `defaults.mirage` or `sites.<id>.mirage`, including in ignored `paqvilo.config.local.yml`:

```yaml
mirage:
  compat:
    footerSpacing: false
  head:
    stylesheets: [./local/extra.css]
    scripts: [./local/flags.js]
```

Files resolve from the catalogue directory and must exist inside that project, including after resolving symlinks. They are served under `/_sim-local/head/` and injected before platform/authored scripts. Doctor, status and page diagnostics identify these local-only additions. They never modify exports. Supported boolean adapter names: `footerSpacing`, `dateFormat`, `dateTimePicker`, `bootstrapPlugins`, `jqueryUiDialog`, `jqueryUiWidgets`, `blockUi`, `entityGrid`, `platformApp`, `webForms`. Unknown names are errors. Disabling a fallback omits it from standalone scripts and local platform bundles. Authored and captured scripts remain controlled by the site's sources/capture.

Your catalogue connects the toolkit to your sources and environments. Keep it in your portal project so the same configuration works with an installed package or a separate toolkit checkout. If this is your first setup, follow [getting started](getting-started.md).

Pass `--config /path/to/your-project/paqvilo.config.yml`. Without it the toolkit uses the working directory's `paqvilo.config.yml` when present, otherwise its bundled example catalogue. The bundled example URL is an inert placeholder and must be replaced before connecting to a live portal.

CLI choices override shell `PAQVILO_*` variables, then `.env` next to the selected catalogue, then `paqvilo.config.local.yml`, then the shared catalogue. The local catalogue and `.env` must be ignored in your project. Use `paqvilo lense list --settings` for supported settings and their resolved origins. Unknown settings fail rather than silently changing behavior.

```yaml
sourceRoot: ./sources
defaultSite: customer
portals: selected
sites:
  customer:
    source: customer-portal
    defaultEnv: sandbox
    environments:
      sandbox: https://your-portal.example.test
      production: { url: https://production.example.test, caution: true }
    mirage:
      port: 8787
      solutionRoots: [../solutions/Core, ../solutions/Extension]
      dataPacks:
        - { id: customer-demo, module: ./pack/pack.mjs }
      preset: customer-demo
```

`sourceRoot` resolves from the catalogue directory. `source` and `solutionRoots` resolve from that root. `--repo` overrides `sourceRoot` and resolves from the invoking working directory. `mirage.project` and data-pack modules resolve from the catalogue directory. A generated Mirage project records its own relative inputs. Explicit `--source` selects an exported portal directly.

Live Lense **Inspect** also reads `mirage.solutionRoots` or the matching portal's sources in `mirage.project`. No local runtime or data-pack code is started for inspection. Without Solution sources, portal dependencies remain inspectable and missing form/view/field definitions are reported explicitly.

Use `portals: all` to support every configured target in one browser. Origins activate on visit, and `--site` selects the first portal. Each Mirage site has its own port and state; choose distinct ports or `0` for a free one. `--portals selected` limits lifecycle operations to one site. `--port`, `--state`, `--preset` and repeated `--solution-root` overrides apply to the selected site.

Mirage projects use `version: 2`, `primaryPortal`, `portals`, `solutions`, `references` and `dataPacks`. Each portal specifies `{ id, path, origin?, solutions?, reference?, deploymentProfile?, observed?, dataModel? }`; Solutions specify `{ id, path }`; references specify `{ id, origin, default? }`. Paths are project-relative and every portal gets isolated state. References provide explicit selection context and never authorize network reads or writes. Solution sets are layered in dependency order; `solutionOrder: explicit` preserves a deliberately ordered list.

Mirage also supports [mapped deployment profiles](../mirage/docs/deployment-profiles.md):
`mirage.deploymentProfiles` in a catalogue, or `deploymentProfiles` at project/portal level.
Map named profiles to Pages and Solution settings files, choose defaults and required sections,
then select and pin a local profile under `/_sim/` → Environment.

An `observed` mapping records only behavior not available from exports. Supported fields include login-path, Web API and response-header conventions; validation requires an evidence reference. Use your site's own captured evidence. Never copy another organisation's observations merely because both sites use Power Pages.

`observed.webApiErrorDetails: odata-wrapper` selects evidenced stable OData reader exception messages for supported JSON root and primitive conversion failures. `diagnostic` is the default. The setting preserves HTTP status, rejection and write atomicity; inner messages remain gated by `Webapi/error/innererror`. It adds no CLR stack, source path or generated runtime exception details and does not change SDK or flow errors. Unsupported reader grammar retains its existing diagnostic. Record native message evidence for the site before enabling it; full hosted stack and response-body equality remain separate checks.

`observed.webApiErrorStacks: response-template` separately enables exact error suffixes supplied by an explicitly registered matching trusted pack's `webApiErrorTemplates`. The default is `diagnostic`; this option also requires `odata-wrapper`, site evidence and source inner-error visibility. Packs bind value-free reader descriptors to bounded CRLF suffixes with captured-source, fresh-variation and suffix hashes. The project verifies these receipts before exporting templates. This emulates captured response formatting and does not execute CLR code or establish whole JSON/body equality. See [the pack contract](../mirage/docs/data-packs.md).

`observed.requestValidation: aspnet-query` rejects dangerous decoded GET page-query values before Liquid renders, using the string scanner from [Microsoft's .NET reference source](https://github.com/microsoft/referencesource/blob/main/System.Web/CrossSiteScriptingValidation.cs). It returns a fixed HTTP 500 diagnostic without echoing input. The default `diagnostic` mode retains existing handling. This option does not scan other request methods, Web API JSON, form bodies, or cookies, and does not reproduce a hosted .NET stack or full error page. Record native GET query rejection evidence for the site before enabling it; broader native grammar and method coverage remain separate validation tasks.

`observed.pageErrorPresentation: generic-error` with `observed.evidence` selects the captured generic title, heading, local Error ID and fixed visible rejection message for GET page-query validation errors with HTTP 500. Its default is `diagnostic`. It does not change validation or apply to other exceptions, methods or API routes. Full hosted error HTML, styles, scripts and custom error snippets remain separate parity obligations.

Core knows the platform-wide ids of the Create, Update, Delete, Retrieve and RetrieveMultiple SDK messages; for other exported message ids, `observed.sdkMessages` maps exact message GUIDs to `{ name, evidence }`. `observed.pluginSources` maps an exported full C# type name to `{ path, evidence }`. Paths resolve inside the catalogue source root or Mirage project folder; use a relative regular `.cs` file. These mappings provide source navigation and documented message identity, not .NET execution. See the [plugin reference](../mirage/docs/dataverse-plugins.md#configure-source-facts).

`observed.siteVisibility: private` renders the platform's private-site banner first in the layout body; site visibility is set in the admin center and is not exported. The default `public` renders none.

`observed.loginPath` is the site-relative sign-in path the platform redirects to when the export sets no `Authentication/ApplicationCookie/LoginPath`, such as `/SignIn`.

`observed.azureAdAuthority` is the authority the built-in Microsoft Entra provider posts when the export carries no `Authentication/OpenIdConnect/AzureAD/Authority`. It must name one tenant (`https://login.windows.net/<tenant>/`); placeholders, `common` and `organizations` are rejected.

`observed.portalApplicationUser` and `observed.portalApplicationUserId` are the display name and systemuser GUID of the site's application user. The platform records that user as the creator of notes and records the portal creates, and no export holds it.

`observed.listODataFeeds` is `removed` (the platform default since list OData feeds were retired: the feed URL answers the Page Not Found page) or `served`, for a site observed still serving them.

`PAQVILO_REPO`, `PAQVILO_SITE`, `PAQVILO_ENV`, `PAQVILO_BROWSER`, `PAQVILO_PROFILE`, `PAQVILO_SCOPE` and `PAQVILO_BASELINE` cover common personal choices. A named browser profile is a separate toolkit identity. Existing profiles require explicit user-data root and child directory; attached CDP browsers remain user-owned. Toolkit-managed state is under `.paqvilo/`, with `--state`, `--output` and profile settings for explicit locations.

The default catalogue is the working directory's `paqvilo.config.yml` when present. State, runtime discovery, logs and generated Mirage project files live in `.paqvilo/` beside that catalogue. A standalone `--project` uses its own directory. `mirage status` and `mirage stop` use the same project scope; supply `--config` or `--project` when running from another directory. The installed toolkit contains reusable code only. Direct Mirage commands also support `--state-dir` to select the state/discovery directory explicitly.
