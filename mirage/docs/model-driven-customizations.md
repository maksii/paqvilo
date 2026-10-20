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

| Exported component | Local behavior |
| --- | --- |
| Main form XML | Tabs, sections, fields, labels, supported related grids and controls |
| JavaScript WebResources | Declared local files load in exported form-library order; no remote lookup or expression evaluation |
| Form events | OnLoad, column OnChange, OnSave; execution context, named functions, handler parameters and save cancellation |
| Client API | Bounded form attributes and controls, dirty values, required/visible/disabled states, notifications, local navigation and staff-authorized record operations |
| Classic ribbon and modern AppAction JavaScript actions | Exported buttons, named handlers and supported parameters/rules; the modern baseline supports `PrimaryControl` |
| Standard field PCF | Declared compiled bundle and CSS, manifest properties, initialization, updates, output notification, outputs and disposal |

The runtime follows the documented [form Client API](https://learn.microsoft.com/en-us/power-apps/developer/model-driven-apps/clientapi/reference/),
[ribbon parameters](https://learn.microsoft.com/en-us/dynamics365/customer-engagement/developer/customize-dev/pass-dynamics-365-data-page-parameter-ribbon-actions),
and [StandardControl lifecycle](https://learn.microsoft.com/en-us/power-apps/developer/component-framework/reference/control)
for the implemented subset. `setValue` does not automatically fire OnChange;
scripts use `fireOnChange` when needed. Save handlers run before persistence and
can cancel the save. Unsupported API calls report their name instead of
silently pretending to succeed.

See the [client API capability matrix](model-driven-client-api.md) for supported
methods, event semantics and the remaining limits.

The bounded `Xrm.WebApi` adapter supports scalar CRUD and simple table queries
(`$select`, `$top`, one `$orderby`, and scalar AND filters). Table queries do not
inherit a saved view's filter. Unsupported query expressions, continuation paging
and relationship writes using `@odata.bind` fail explicitly; they do not perform a
partial mutation. Use the organization API for integrations needing its broader
OData surface.

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

## PCF inputs and limits

Select an unpacked Solution containing `Controls/<name>/ControlManifest.xml`, its
`.data.xml` identity and the compiled resources declared by the manifest. Form XML
must contain the exported desktop custom-control binding. Do not substitute
TypeScript source for a compiled bundle. Mirage resolves the declared constructor,
registration or exact classic export; it does not guess from unrelated globals.

The baseline supports scalar standard field controls. Dataset controls, React
virtual controls, platform libraries, unimplemented device APIs and unsupported
property types remain explicit placeholders. A component's output is checked
against its bound property and the normal record pipeline. Instances are destroyed
on form/tab replacement or navigation, including an instance that finishes loading
after navigation. This is a development host, not the complete licensed client.

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
  "resources": [
    { "path": "/observed-controls/Example.Input/bundle.js", "resource": "x_Example.Input/bundle.js" }
  ]
}
```

Keep environment URLs, observed paths and reports in the project. Inspect lists
declared resources and unbound controls offline. During development, the report
records applied responses and unmatched requests with query values omitted.
Saving a selected source reloads the owned app tab. A resource mapping does not
prove it was requested or executed; check the applied count and visible behavior.

### Inspect and debug the live app

Model-driven dev adds a separate **Lense X-ray** inspector to its app tab. Use
**Alt+Shift+X** to toggle inspection. It reports declared resources, exact mapped
paths, current-revision applications, import diagnostics and runtime errors.
Select a rendered field or command to inspect the available Solution binding;
an unresolved native element stays unresolved. The inspector does not read field
values or infer that a delivered bundle's constructor executed. Power Pages
retains its existing source inspector and Liquid provenance.

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
unavailable. Mapping a PCF bundle does not make missing TypeScript sources or
source-map sidecars available. Confirm the debugger port in agent status.
Generated maps are admitted before allocation: at most 16 MiB for a mapped asset
and 64 MiB of generated map bytes per overlay revision. A map that exceeds these
budgets is omitted with `MODEL_SOURCE_MAP_LIMIT`; the original script still runs.
This avoids expanding newline-heavy bundles into very large debug payloads.

Reloads use an explicit GET and never replay the document's POST. Source saves
coalesce to one active import and one pending refresh. `--no-reload` disables the
source watcher; it does not disable initial interception or the inspector.

Native apps can cache WebResources and PCF constructors inside the application.
A browser reload may then make no resource request for Lense to intercept. The
native proof required explicit refresh of declared resources and rebinding a local
form handler; automatic native cache invalidation and replacement of cached PCF
constructors or ribbon callbacks remain unproven. Check the current revision's
applied counts before treating a source edit as active. Mirage loads the selected
local resources directly and does not use the native app's internal cache.

Lense overlays code in its browser session. The app continues to use its online
environment and identity, so Save, commands and script-triggered record operations
can change live data. Use an isolated test Solution and records for that proof.
Mirage remains the local execution path for in-memory testing.
