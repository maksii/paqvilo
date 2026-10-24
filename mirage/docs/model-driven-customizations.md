# Solution customizations in the local app

Mirage imports app navigation, table metadata, forms and views from selected
Solution sources. Executable customizations require a separate trust setting:

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

For a toolkit catalogue, place `modelDriven` under the target's `mirage` settings.
The same setting is available in **Project setup → Runtime → Run trusted Solution
extensions**. Save and restart. Trust is off by default. A Solution import alone
never grants permission to run its code. Trusted code executes in the local app
with access to its session; review it as you would any project dependency.

Run `paqvilo mirage inspect --project mirage.project.yml --json`, then
`paqvilo mirage dev --project mirage.project.yml`. Select an imported app from the
app picker, open a view and a record, and use the staff profile to select the
identity under test. Dry run lets you exercise records without persisting them.
Keep fixture records, script sources and their acceptance tests in the project.

## Supported baseline

| Exported component                                     | Local behavior                                                                                                                                               |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Main form XML                                          | Tabs, sections, fields, labels, supported related grids and controls                                                                                         |
| JavaScript WebResources                                | Declared local files load in exported form-library order; no remote lookup or expression evaluation                                                          |
| Form events                                            | OnLoad, column OnChange, OnSave; execution context, named functions, handler parameters and save cancellation                                                |
| Client API                                             | Bounded form attributes and controls, dirty values, required/visible/disabled states, notifications, local navigation and staff-authorized record operations |
| Classic ribbon and modern AppAction JavaScript actions | Exported buttons, named handlers and supported parameters/rules; the modern baseline supports `PrimaryControl`                                               |
| Standard field PCF                                     | Declared compiled bundle and CSS, manifest properties, initialization, updates, output notification, outputs and disposal                                    |

The runtime follows the documented [form Client API](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/),
[ribbon parameters](https://learn.microsoft.com/en-us/dynamics365/customer-engagement/developer/customize-dev/pass-dynamics-365-data-page-parameter-ribbon-actions),
and [StandardControl lifecycle](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control)
for the implemented subset. `setValue` does not automatically fire OnChange;
scripts use `fireOnChange` when needed. Save handlers run before persistence and
can cancel the save. Unsupported API calls report their name instead of
silently pretending to succeed.

See the [client API capability matrix](model-driven-client-api.md) for supported
methods, event semantics and the remaining limits.

The `Xrm.WebApi` adapter supports scalar CRUD, multiselect writes and imported
single-valued lookup bindings using `@odata.bind`. Reads use the shared
organization engine for supported OData expressions, lookup expansion, FetchXML
and continuation paging. Table queries do not inherit a saved view's filter.
Unknown relationships and external binding or continuation URLs fail before a
record request. Many-to-many writes and deep inserts remain unsupported.

Scripts use the local organization through the shell's data adapter. Staff roles,
row access, field permissions, write capability, simulation level and optimistic
concurrency remain enforced by the shared backend. Form scripts can further
disable controls but cannot enable a field forbidden by the source or staff
policy. Portal visitor identity and table permissions remain separate.

WebResource names resolve from the exported `Name` and `FileName`; a matching
filesystem name alone does not grant execution. Only declared resources receive
local app URLs. Missing files and malformed definitions appear in client extension
diagnostics in the app catalogue (`GET /_apps/api`). Resource responses are local,
uncached and confined to the app's allowlist. Source changes trigger reload through
the selected Solution watcher.

Client asset import reads unpacked WebResource bodies only when a declared
JavaScript or stylesheet references them. Across selected sources and retained
PCF assets, admission is bounded by 256 MiB of content, 10,000 visited entries and
256 layers, with an 8 MiB limit per executable file. ZIP archives also retain the
shared Solution archive size and expansion checks. Exceeding an aggregate limit
disables the client extension catalogue and reports `MODEL_CLIENT_IMPORT_LIMIT`;
it never silently executes an earlier layer. A PCF file that disappears during
import reports a component diagnostic without taking down the organization host.
PCF manifests, identity metadata, localized RESX and image bytes count toward the
same byte budget, even when only the declared JavaScript/CSS is served by the app.

For large metadata compositions, `modelDriven.clientSources` can independently
select an ordered list of local client-asset directories or Solution ZIP files:

```yaml
modelDriven:
  trustedExtensions: false
  clientSources:
    - ./client-assets/base
    - ./client-assets/overrides
```

Each directory uses the exported `WebResources`, `Controls`, `AppActions`,
`Entities` and `Other/Customizations.xml` layout. Relative paths resolve from the
project or catalogue file; programmatic options resolve from the working directory.
The complete `solutions` / `solutionRoots` selection still supplies schema, apps,
forms and views. Client sources are an explicit replacement for client discovery
in those metadata layers, and later declared resources override earlier ones.

An entry named `<Library>@<version>.js` is a PCF platform library file, not a Solution
layer; it is served under `/_apps/controls/platform/`. A list with only library files
imports only those files. A misnamed `.js` entry
reports `MODEL_PCF_PLATFORM_LIBRARY_INVALID`.
Omitting `clientSources` preserves ordinary Solution discovery; `[]` imports no
client extensions. Selection grants no execution trust. Imported WebResources
retain their file provenance, and missing sources disable the complete client
catalogue with `MODEL_CLIENT_SOURCE_INVALID`. All selected sources share the same
aggregate limits above; exceeding them disables the complete catalogue, including
earlier layers. Missing or escaped declared dependencies are reported and never
served. Local watchers include the selected client sources.

A named PCF declaration supersedes an earlier control even if its new manifest or
dependencies are invalid; that failure cannot reactivate the earlier executable.
A later valid declaration can replace it. An unreadable exported PCF identity
disables the PCF catalogue with `PCF_IDENTITY_UNRESOLVED`, since its override target
cannot be established safely; independent WebResources remain available.

These selections and aggregate budgets govern the model-driven client catalogue.
Power Pages Liquid and native-form PCF use their separate Solution-backed import;
`modelDriven.clientSources`, including `[]`, does not remove those portal controls.
That portal import still reads its declared PCF resources during startup and is
not covered by the model-driven catalogue's aggregate budget.

## PCF inputs and limits

Select an unpacked Solution containing `Controls/<name>/ControlManifest.xml`, its
`.data.xml` identity and the compiled resources declared by the manifest. Form XML
must contain the exported desktop custom-control binding. Do not substitute
TypeScript source for a compiled bundle. Mirage resolves the declared constructor,
registration or exact classic export; it does not guess from unrelated globals.

Field controls and dataset controls are hosted. One admission rule, shared with the
Power Pages host (`pcfAdmission`, exported by `code-components.mjs`), decides the kind:
`standard` field, `standard` dataset or `virtual`. A dataset control bound to a form subgrid
(`<data-set>` in its desktop `customControl`) receives a DataSet over the subgrid view,
narrowed to the parent record: `records`, `sortedRecordIds`, `columns`, `getFormattedValue`,
paging (`setPageSize` up to 100, `loadNextPage`, `loadPreviousPage`, `loadExactPage`,
`reset`), one sort column (`sorting` then `refresh()`), one AND group of filter
conditions, `linking.addLinkedEntity` with `addColumn(name, alias)`, selection, and
`openDatasetItem`, which opens the record. Other filter shapes, several sort columns and
In conditions set `error` with a reason. Table home grids keep the standard grid.
A virtual (React) control is hosted only when the project supplies every declared platform
library, plus ReactDOM of the declared React version, as files in
`modelDriven.clientSources` named `<Library>@<version>.js` (for example
`React@16.14.0.js`, `ReactDOM@16.14.0.js`). Mirage ships no React or Fluent. Without them
the control shows `PCF_VIRTUAL_UNSUPPORTED` with its name and the missing files. Field and
dataset components get the staff context, its formatting, and per-column `security`
(`secured` true for field-level secured columns). Unimplemented device APIs and
unsupported property types remain explicit placeholders. A component's output is checked
against its bound property and the normal record pipeline. Instances are destroyed
on form/tab replacement or navigation, including an instance that finishes loading
after navigation. This is a development host, not the complete licensed client.
The host preserves the native component namespace classes so exported component
styles apply without Mirage's field styles overriding them. Components declaring
required WebAPI access can use the configured local staff adapter; required
unimplemented host features still prevent the component from executing.

Command support is similarly bounded. Power Fx commands, dashboards, business
process flow UI, arbitrary external URLs, unsupported rule types and unimplemented
platform commands remain unavailable. A disabled command includes a reason. Saving
recursively from an active lifecycle event is unsupported; cancel and finish the
handler before initiating another save.

## Prove a project

For each app, verify grid navigation, create/edit/reopen, form load/change/save,
validation cancellation, a command action and a PCF output reaching the saved row.
Repeat a denied operation under a restricted staff identity. Check the disabled
trust state, missing dependencies, browser errors and navigation cleanup. Compare
native and local screenshots at the same viewport, and record intentional gaps.
Importing a component or receiving HTTP 200 is not proof that its behavior ran.

See [standalone configuration](standalone-organization.md),
[simulation persistence](simulation-levels.md) and [model-driven rendering](model-driven-apps.md).

## Preview the same code with Lense

Use the explicit model-driven overlay mode with the same Solution project:

```sh
paqvilo lense model-driven inspect --project mirage.project.yml --url https://example.crm.dynamics.com --json
paqvilo lense model-driven dev --project mirage.project.yml --url https://example.crm.dynamics.com --path "/main.aspx?appname=x_example" --resource-map resource-map.json --output .paqvilo/lense-model-driven.json
```

Direct `/WebResources/<exported-name>` requests map automatically. Native cache
prefixes and PCF bundle paths vary; bind paths actually observed in the app:

```json
{
  "version": 1,
  "resources": [{ "path": "/observed-controls/Example.Input/bundle.js", "resource": "x_Example.Input/bundle.js" }]
}
```

Keep environment URLs, observed paths and reports in the project. Inspect lists
declared resources and unbound controls offline. During development, the report
records applied responses and unmatched requests with query values omitted.
Saving a selected source reloads the owned app tab. A resource mapping does not
prove it was requested or executed; check the applied count and visible behavior.

### Inspect and debug the live app

Model-driven dev uses the same Lense panel and **Lense X-ray** picker as Power
Pages. **Overrides**, **Inspect**, **Issues**, **Activity** and **Explore** retain
that shell and its source controls; model-driven apps add an **Actions** tab for
[native developer tools](../../docs/model-driven-actions.md). Use **Alt+Shift+X**
to toggle inspection. It reports declared resources, exact mapped paths,
current-revision applications, import diagnostics and runtime errors. Select a
rendered field or command to inspect its available Solution binding. An unresolved
native element stays unresolved. Passive inspection does not read field values or
prove that a delivered bundle's constructor executed. Power Pages retains its
portal-specific source and Liquid provenance inside the shared panel.

Inspection shows its pending state before reading app context, including a
reduced-motion-aware scan when X-ray is active. Refresh keeps previous results
labelled while loading and reports failures with an available Refresh action.
Closing the inspector or leaving selection mode remains available during a read.

Owned browsers also expose the existing authenticated, loopback
[agent API](../../docs/lense.md#agent-api-reference). The command prints the
discovery **path**; keep its contents private. Use that path with:

```sh
paqvilo lense agent pages --session .paqvilo/agents/SESSION.json --json
paqvilo lense agent state --session .paqvilo/agents/SESSION.json --page-id 1 --json
paqvilo lense agent events --session .paqvilo/agents/SESSION.json --after 0 --limit 100 --json
paqvilo lense agent snapshot --session .paqvilo/agents/SESSION.json --page-id 1 --selector "[data-id]" --limit 30 --json
```

Use page IDs returned by `pages`, and advance event cursors with `nextSequence`.
Screenshots and bounded DOM inspection use the same commands as Power Pages.
An attached user-owned browser receives no agent server. Other tabs are excluded
from model-driven interception and inspection. Native popups and separate record
windows are outside this dedicated-tab session.

Start dev with a free `--debug-port 9222` to attach DevTools or VS Code. Local
JavaScript without an existing source map receives a file-backed identity map;
existing compiled maps are preserved. ZIP-only resources have no physical local
file map. Breakpoints can be set in the served bundle when its original map is
unavailable. A resource map can explicitly admit a physical source-map sidecar:

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

`sourceMap.file` is relative to the declared script's physical directory and must
stay inside it after resolving symlinks. Map/source names use simple relative
paths without traversal, URL schemes, percent escapes or whitespace. Only the
explicit sidecar URL is served; original source files are never exposed. Embed
`sourcesContent` in a valid version 3 map to debug original files without another
server. Indexed maps and nonempty `sourceRoot` are refused. Missing, malformed or
oversized maps report `MODEL_SOURCE_MAP_INVALID` while the bundle keeps running;
an overlay budget refusal reports `MODEL_SOURCE_MAP_LIMIT`. Existing inline maps
remain unchanged. Each script has at most one sidecar. Sidecar requests are
reported separately and do not count as executable-resource applications.
Confirm both the served map and a bound breakpoint before claiming original-source
debugging. Confirm the debugger port in agent status.
Generated maps are admitted before allocation: at most 16 MiB for a mapped asset
and 64 MiB of generated map bytes per overlay revision. A map that exceeds these
budgets is omitted with `MODEL_SOURCE_MAP_LIMIT`; the original script still runs.
This avoids expanding newline-heavy bundles into very large debug payloads.

`model-driven dev --startup-timeout 120000` sets a separate 1,000–600,000 ms
startup budget, starting before project/source loading and ending after the
initial document and assets settle. It covers browser attachment, interception,
watcher setup and initial assets; failures name the active phase. Async waits
are interrupted at the deadline; synchronous filesystem/parsing work observes
it when control returns to an async boundary. It is not a process watchdog for
blocked native code. Late browser acquisitions are disposed, only the owned app
tab is closed in an attached browser, and the attached browser remains running.
Ctrl+C cancels pending startup. Cleanup drains owned resources separately from
the startup budget. `--timeout` starts after startup and limits session lifetime.

### Pair the panel with a standalone local app

Keep the standalone Mirage process running, then open a separate panel browser:

```sh
paqvilo mirage start --project ./project.yml --port 8787
paqvilo lense model-driven dev --project ./project.yml --url http://127.0.0.1:8787 --local-simulation --debug-port 9222
```

The project must explicitly enable `modelDriven.trustedExtensions`. The panel
shows **Local simulation**, exposes only that loopback target and uses the same
Actions, Inspect, X-ray and debugger tools. APIs the simulator does not expose,
such as a native environment ID or native effective privilege inspection, remain
unavailable with their reasons. Source saves retain the normal trust and reload
rules. Stopping this overlay closes its owned browser or tab and leaves the
independently started Mirage runtime running. Plain standalone `mirage dev`
continues to open the app directly; a debugger port alone does not enable the panel.

Reloads use an explicit GET and never replay the document's POST. Source saves
coalesce to one active import and one pending refresh. `--no-reload` starts with
automatic reload paused. Sources are still watched and imported, and initial
interception and inspection remain active. The panel Live control enables or
pauses later automatic reloads.

Native apps can cache WebResources and PCF constructors inside the application.
A browser reload may make no resource request for Lense to intercept. Exact
observed mappings must follow the native request's current path/version. Confirm
both current-revision application and actual handler/constructor/ribbon behavior
after a source save; applied-resource counts alone do not prove the cache was
replaced. Mirage loads selected local resources directly and has no such cache.

Lense overlays code in its browser session. The app continues to use its online
environment and identity, so Save, commands and script-triggered record operations
can change live data. Use an isolated test Solution and records for that proof.
Mirage remains the local execution path for in-memory testing.
