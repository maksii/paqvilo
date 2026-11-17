# Solution customizations in the local app

Mirage imports app navigation, table metadata, forms and views from the selected Solution sources. Running their code
(form scripts, JavaScript commands, PCF controls) needs a separate trust setting:

```yaml
version: 2
runtime:
  kind: model-driven
simulation:
  level: dry-run
modelDriven:
  trustedExtensions: true
solutions:
  - id: app
    path: ./solutions/Example
```

In a toolkit catalogue, put `modelDriven` under the target's `mirage` settings, or use **Project setup → Runtime → Run
trusted Solution extensions**; save and restart. Trust is off by default and a Solution import never grants it. Trusted
code runs in the local app with access to its session: review it like any project dependency.

```sh
paqvilo mirage inspect --project mirage.project.yml --json
paqvilo mirage dev --project mirage.project.yml
```

Pick an imported app, open a view and a record, and choose the identity under test in the staff profile. Dry run
exercises records without persisting them. Keep fixture records, scripts and acceptance tests in the project. For an
optional static check of authored JavaScript, see [web resource lint](model-driven-web-resource-lint.md).

## What runs

| Exported component                          | Local behavior                                                                                                 |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Main form XML                               | Tabs, sections, fields, labels, supported related grids and controls                                           |
| JavaScript web resources                    | Declared local files load in exported form-library order; no remote lookup or expression evaluation            |
| Form events                                 | OnLoad, column OnChange, OnSave; execution context, named functions, constant parameters and save cancellation |
| Classic ribbon and modern AppAction actions | Exported buttons, named handlers and supported parameters and rules                                            |
| Standard field and dataset PCF              | Declared compiled bundle and CSS, manifest properties, lifecycle, outputs and disposal                         |

The supported client API members, event semantics and save results are listed in
[model-driven client API](model-driven-client-api.md). Unsupported calls report their name instead of succeeding.
Scripts reach data through the shell's adapter, so staff roles, row access, field permissions, write capability,
simulation level and optimistic concurrency stay enforced; a script can disable a control but not enable a field the
source or staff policy forbids.

FormXml visibility, disabled-state and label flags, event activation, handler enablement and execution-context flags
accept `true`/`false` and `1`/`0`. Missing layout flags keep their defaults; missing activation or enablement means on,
missing execution context means off, and invalid tokens mean off.

## Web resources and client sources

- Web resource names come from the exported `Name` and `FileName`; a matching file name alone grants nothing. Only
  declared resources get local URLs (`/_apps/resources/`, `/_apps/controls/`), served uncached from the app's
  allowlist. Missing files and malformed definitions appear in the client extension diagnostics of the app catalogue
  (`GET /_apps/api`). Source changes reload through the Solution watcher.
- Unpacked web resource bodies are read only when a declared JavaScript or stylesheet references them. Across the
  selected sources and retained PCF assets, import is bounded to 256 MiB of content, 10,000 entries and 256 layers,
  with 8 MiB per executable file; ZIP archives keep the Solution archive checks. PCF manifests, identity metadata, RESX
  and images count toward the byte budget. Exceeding an aggregate limit disables the whole client catalogue with
  `MODEL_CLIENT_IMPORT_LIMIT`; an earlier layer never runs in its place. A PCF file that disappears during import
  reports a component diagnostic.

`modelDriven.clientSources` selects an ordered list of client-asset directories or Solution ZIP files independently of
the metadata sources:

```yaml
modelDriven:
  trustedExtensions: false
  clientSources:
    - ./client-assets/base
    - ./client-assets/overrides
```

- Each directory uses the exported `WebResources`, `Controls`, `AppActions`, `Entities` and
  `Other/Customizations.xml` layout. Paths resolve from the project or catalogue file (programmatic options from the
  working directory). `solutions`/`solutionRoots` still supply schema, apps, forms and views; client sources replace
  client discovery in those layers, and later declared resources override earlier ones.
- An entry named `<Library>@<version>.js` is a PCF platform library, served under `/_apps/controls/platform/`; a
  misnamed `.js` entry reports `MODEL_PCF_PLATFORM_LIBRARY_INVALID`. A list of only library files imports only those.
- Omitting `clientSources` keeps ordinary Solution discovery; `[]` imports no client extensions. Selecting sources
  grants no trust. A missing source disables the whole client catalogue with `MODEL_CLIENT_SOURCE_INVALID`. Missing or
  escaping dependencies are reported and never served. Watchers include the client sources.
- A named PCF declaration supersedes an earlier one even if it is invalid; the earlier executable never comes back. An
  unreadable PCF identity disables the PCF catalogue with `PCF_IDENTITY_UNRESOLVED`; web resources stay available.
- These settings and budgets govern only the model-driven client catalogue. Power Pages Liquid and native-form PCF use
  their own Solution-backed import, which `clientSources` (even `[]`) does not change and the budget does not cover.

## PCF inputs and limits

Select an unpacked Solution with `Controls/<name>/ControlManifest.xml`, its `.data.xml` identity and the compiled
resources the manifest declares; Form XML must contain the exported desktop custom-control binding. TypeScript source is
not a substitute for the bundle. Mirage resolves the declared constructor, registration or exact classic export, never
an unrelated global.

One admission rule, shared with the Power Pages host (`pcfAdmission` in `mirage/lib/code-components.mjs`), classifies a
control as a `standard` field, a `standard` dataset or `virtual`.

- **Dataset controls** bound to a form subgrid (`<data-set>` in the desktop `customControl`) get a DataSet over the
  subgrid view, narrowed to the parent record: `records`, `sortedRecordIds`, `columns`, `getFormattedValue`, paging
  (`setPageSize` up to 100, `loadNextPage`, `loadPreviousPage`, `loadExactPage`, `reset`), one sort column (`sorting`,
  then `refresh()`), one AND group of filter conditions, `linking.addLinkedEntity` with `addColumn(name, alias)`,
  selection and `openDatasetItem`. Other filter shapes, several sort columns and `In` conditions set `error` with a
  reason. Table home grids keep the standard grid. After `context.mode.trackContainerResize(true)` in `init`,
  `allocatedWidth` is the container width from the first `updateView` (height stays `-1`), and width changes call
  `updateView` with `layout` in `updatedProperties`; disabling tracking, destruction or a failed render restores `-1`
  and stops observing, as in the
  [sizing contract](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/mode/trackcontainerresize).
- **Virtual (React) controls** run only when the project supplies every declared platform library plus ReactDOM of
  the declared React version as `clientSources` files (for example `React@16.14.0.js`, `ReactDOM@16.14.0.js`). Mirage
  ships no React or Fluent; without them the control shows `PCF_VIRTUAL_UNSUPPORTED` with the missing files.
- Field and dataset components get the staff context and its formatting, and per-column `security` (`secured` true for
  field-secured columns). Outputs are checked against the bound property and the record pipeline. Components declaring
  required WebAPI use the local staff adapter; other required unimplemented features prevent execution. Unimplemented
  device APIs and property types stay placeholders. Instances are destroyed on form or tab replacement and navigation,
  including one that finishes loading afterwards. Native component namespace classes are kept so exported styles
  apply.

Unavailable commands: Power Fx commands, business process flow UI, arbitrary external URLs, unsupported rule types and
unimplemented platform commands. A disabled command shows its reason.

## Prove a project

For each app, check grid navigation, create/edit/reopen, form load/change/save, validation cancellation, a command
action and a PCF output reaching the saved row. Repeat a denied operation as a restricted staff user. Check the
disabled trust state, missing dependencies, browser errors and navigation cleanup, and compare native and local
screenshots at the same viewport. Importing a component or receiving HTTP 200 does not prove its behavior ran.

## Preview the same code with Lense

Lense's model-driven mode overlays the same Solution project on a live app:

```sh
paqvilo lense model-driven inspect --project mirage.project.yml --url https://example.crm.dynamics.com --json
paqvilo lense model-driven dev --project mirage.project.yml --url https://example.crm.dynamics.com --path "/main.aspx?appname=x_example" --resource-map resource-map.json --output .paqvilo/lense-model-driven.json
```

Lense overlays code in its own browser session; the app still uses its online environment and identity, so Save,
commands and script-triggered record operations change live data. Use an isolated test Solution and records.

**Event registration inventory.** The offline `inspect` report has `clientEvents`: per exported form, the entity, form
identity and name, event and handler order, `handlerUniqueId`, attribute, activation flags, library and function names,
context flag and source references, from the exported
[FormXml event declarations](https://learn.microsoft.com/en-us/dynamics365/customerengagement/on-premises/developer/customize-dev/form-xml-schema?view=op-9-1).
An available script does not prove its function exists or ran; connected-organization registrations are not read.

- Pages hold at most 100 entries within 128 KiB, with `complete`, `truncated`, diagnostics and `nextCursorToken`.
  Continue with `--event-cursor '<clientEvents.nextCursorToken>'` on the same command; the cursor is bound to the
  inventory revision and filters, so changed forms, resources, language or parameter inclusion need a restart.
  Oversized rows are omitted with `truncated: true`; a page can be empty with a continuation. Follow every continuation
  before calling the inventory complete.
- Parameter literals are omitted unless `--include-event-parameters` is given on every page; keep that output private.
- The library API `createModelDrivenMetadataIndex(imported).eventRegistrations(request)` in
  `paqvilo/lense/model-driven-metadata.mjs` also accepts exact `library`, `entity` and `formId` filters,
  `includeParameters`, `cursor: page.nextCursor` and `budget: { items, bytes }` (1–512 entries, 2048–524288 bytes).
  Entity and form filters normalize GUID braces and case; library names keep their exported spelling, with a
  case-insensitive `$webresource:` prefix removed.

**Resource maps.** Direct `/WebResources/<exported-name>` requests map automatically. Native cache prefixes and PCF
bundle paths vary, so bind the paths you observe:

```json
{
  "version": 1,
  "resources": [{ "path": "/observed-controls/Example.Input/bundle.js", "resource": "x_Example.Input/bundle.js" }]
}
```

Inspect lists declared resources and unbound controls offline; dev records applied responses and unmatched requests
(query values omitted). Saving a selected source reloads the owned app tab. Native apps cache web resources and PCF
constructors, so a reload may make no request to intercept: confirm current-revision application and the actual
handler, constructor or ribbon behavior after a save. Mirage loads local resources directly and has no such cache.

### Inspect and debug the live app

Model-driven dev uses the Lense panel and **Lense X-ray** picker (**Alt+Shift+X**) as for Power Pages, with an extra
**Actions** tab for [native developer tools](../../docs/model-driven-actions.md). It reports declared resources, mapped
paths, current-revision applications, import diagnostics and runtime errors; select a field or command to see its
Solution binding. Passive inspection reads no field values and does not prove a bundle's constructor ran.

Owned browsers expose the loopback [agent API](../../docs/lense.md#agent-api-reference). The command prints the
discovery path; keep its contents private:

```sh
paqvilo lense agent pages --session .paqvilo/agents/SESSION.json --json
paqvilo lense agent state --session .paqvilo/agents/SESSION.json --page-id 1 --json
paqvilo lense agent events --session .paqvilo/agents/SESSION.json --after 0 --limit 100 --json
paqvilo lense agent snapshot --session .paqvilo/agents/SESSION.json --page-id 1 --selector "[data-id]" --limit 30 --json
```

Use page IDs from `pages` and advance event cursors with `nextSequence`. An attached user-owned browser gets no agent
server. Other tabs, native popups and separate record windows are outside the session.

**Debugger and source maps.** Start dev with a free `--debug-port 9222` and confirm it in agent status. Local JavaScript
without a source map gets a file-backed identity map; existing maps are kept; ZIP-only resources have no file map. A
resource map can admit a physical source-map sidecar:

```json
{
  "version": 1,
  "resources": [
    {
      "path": "/WebResources/demo_bundle.js",
      "resource": "demo_bundle.js",
      "sourceMap": { "path": "/WebResources/demo_bundle.js.map", "file": "bundle.js.map" }
    }
  ]
}
```

`sourceMap.file` is relative to the script's directory and must stay inside it after resolving symlinks; map and source
names are simple relative paths. Only the sidecar URL is served, never original sources: embed `sourcesContent` in a
version 3 map to debug them. Indexed maps and a nonempty `sourceRoot` are refused. Invalid maps report
`MODEL_SOURCE_MAP_INVALID` and the bundle still runs; generated maps over 16 MiB per asset or 64 MiB per overlay revision
are omitted with `MODEL_SOURCE_MAP_LIMIT`. Each script has at most one sidecar, and sidecar requests do not count as
resource applications. Confirm the served map and a bound breakpoint before claiming original-source debugging.

Mirage itself adds file-backed maps to the scripts, styles and PCF bundles it serves; set the project setting
`sourceMaps: false` to turn that off.

**Start-up.** `model-driven dev --startup-timeout <ms>` (1,000–600,000, default 120,000) is the longest silence without
progress (a phase change, completed step, page request or navigation, including a sign-in redirect); an absolute cap of
600,000 ms also applies. Both run until the native document's load event; sign-in and native app readiness stay
unverified. A failure names the guard, the last phase and the duration. Ctrl+C cancels start-up. `--timeout` limits the
session after start-up. `--no-reload` starts with automatic reload paused (the panel's Live control resumes it);
reloads use GET and never replay a POST, and source saves coalesce to one import and one pending refresh.

Source links use `PAQVILO_EDITOR` (shell or the catalogue's `.env`), then the catalogue's `editor`, then `code`. The
catalogue defaults to `paqvilo.config.yml` beside the project; `--config <catalogue>` selects another.

### Pair the panel with a standalone local app

Keep a standalone Mirage running and open a separate panel browser on it:

```sh
paqvilo mirage start --project ./project.yml --port 8787
paqvilo lense model-driven dev --project ./project.yml --url http://127.0.0.1:8787 --local-simulation --debug-port 9222
```

The project must enable `modelDriven.trustedExtensions`. The panel shows **Local simulation**, accepts only that
loopback target and offers the same Actions, Inspect, X-ray and debugger tools; APIs the simulator lacks (such as a
native environment ID or effective privilege inspection) show their reason. Lense observes Mirage's declared
`/_apps/resources/` and `/_apps/controls/` URLs as well as `/WebResources/`, and Mirage's readiness marker also gates
start-up. Stopping the overlay closes its owned browser or tab and leaves Mirage running. Plain `mirage dev` opens the
app without the panel; a debugger port alone does not add it.

See also [standalone configuration](standalone-organization.md), [simulation levels](simulation-levels.md) and
[model-driven apps](model-driven-apps.md).
