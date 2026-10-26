# Canvas apps in Mirage

Mirage provides a local canvas player and a headless runtime. The player renders a supported subset of controls from the source and drives the same runtime for formulas, data sources, variables, collections and navigation. Rendering is an approximation, not the Power Apps player; unsupported controls and runtime diagnostics are shown explicitly. The source is the Power Apps YAML source code (`Src/*.pa.yaml`) of an `.msapp` file or an extracted folder, from a Solution or from the project `canvas.sources`. An app saved only in the retired unpacked format (`Src/*.fx.yaml` with `DataSources/*.json`) is read from that format and reports `CANVAS_SOURCE_LEGACY_FXYAML`; when both formats are present, the `.pa.yaml` files are used.

## Source and setup

The baseline follows Microsoft documentation reviewed on October 26, 2026: [source files](https://learn.microsoft.com/power-apps/maker/canvas-apps/power-apps-yaml), [PAC Canvas commands](https://learn.microsoft.com/power-platform/developer/cli/reference/canvas), [Set](https://learn.microsoft.com/power-platform/power-fx/reference/function-set), and [Navigate/Back](https://learn.microsoft.com/power-platform/power-fx/reference/function-navigate). Export an app from Studio, or use `pac canvas list` and `pac canvas download --help` to select its environment and app and download with source extraction (`-d`). You may also unzip an existing `.msapp`; retain its `Src/` folder. The retired `pac canvas pack/unpack` commands do not create the current source format. An older app without `Src/*.pa.yaml` must be re-saved in Studio and downloaded again.

Check dependencies with `node scripts/ensure-dependencies.mjs --check --json --browser msedge` (omit `--check` to install). Keep the app and project configuration outside this checkout. Configure `canvas.sources` below, start Mirage, select a local staff user in `/_sim/` (or a mapped visitor in an enhanced-authorization portal), and explicitly start the app. A cloud sign-in does not sign in to the local runtime.

## What is inventoried

`readCanvasSource({ msapp, dir, name, version })` in `mirage/lib/canvas-source.mjs` reads one app from either an `.msapp` archive in memory or an extracted directory. It reads only the Power Apps YAML source code under `Src/` (`Src/App.pa.yaml`, `Src/<Screen>.pa.yaml` and `Src/Component/<Name>.pa.yaml`). Microsoft documents that only these files are source code. The other JSON files in an `.msapp` are not stable between saves. See [View source code files for canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/power-apps-yaml) and the [pa.yaml v3.0 schema](https://raw.githubusercontent.com/microsoft/PowerApps-Tooling/refs/heads/master/schemas/pa-yaml/v3.0/pa.schema.yaml).

The result lists:

- the app (`name`, `version` and `schemaVersion`), where the Solution supplies the name and version;
- the screens, each with its flattened controls (`name`, `control` type with version, `parent` and optional `variant`/`componentName`);
- the component definitions;
- the data sources: `Table` sources with `table` (the Dataverse logical name) and `Actions` sources with `connectorId`;
- the formulas, one row per property: `{ owner, property, text, source, line }`, for example `{ owner: 'HomeScreen.Gallery1', property: 'Items', text: '=Filter(...)' }`.

Formula rows contain only the formula text; the runtime described below evaluates them.

| Diagnostic                        | Meaning                                                                                                         |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `CANVAS_SOURCE_LEGACY_FXYAML`     | The app was read from retired `.fx.yaml` files (`pac canvas unpack`); next to `Src/*.pa.yaml` they are ignored  |
| `CANVAS_SOURCE_NO_PAYAML`         | No `Src/*.pa.yaml` was found. Re-save the app in Power Apps Studio                                              |
| `CANVAS_SOURCE_SCHEMA_UNKNOWN`    | A `$schema` modeline names an unknown pa.yaml version, or a file uses a top-level key outside the v3.0 schema   |
| `CANVAS_SOURCE_YAML_INVALID`      | A file does not parse. The message gives only the file, line and parser code, never the content                 |
| `CANVAS_SOURCE_ARCHIVE_INVALID`   | The `.msapp` bytes are not a readable ZIP archive                                                               |
| `CANVAS_SOURCE_STRUCTURE_INVALID` | A document, properties, children or definition has the wrong structure, or duplicates a definition in its scope |
| `CANVAS_SOURCE_NAME_COLLISION`    | Names collide in the local runtime's app-wide lookup; native component scoping is not reproduced                |

`canvasInventoryRecord(source, { id, solution, layer, file, format })` turns a result into a Solution inventory record: `component: 'canvasapp'`, `componentType: 300`, `dependencies` derived from the data sources (`table` and `connector`, the inventory component vocabulary), and `level: 'behaviour'` when the source parses; an app without readable source stays at `inventory` with its source diagnostic as the reason.

## Hosted controls

The runtime hosts Screen, Label, Text input, Button, Gallery, Edit form and Display form with their cards, Drop down, Combo box, Check box, Toggle, Date picker, Image (the `Image` property as a URL value) and containers. Every other control type, and every component instance, is listed as unsupported by name and type: its declared formulas still evaluate, but it cannot be selected or given input (`501 CanvasControlUnsupported`). Properties a source leaves out take the defaults in `mirage/lib/canvas-controls.mjs`.

The player draws labels, buttons, text inputs, check boxes, toggles, drop-downs, date pickers, galleries and containers using browser elements. Button and gallery selection run OnSelect; input changes run OnChange. Checkbox/toggle changes then run OnCheck or OnUncheck once; repeated identical Boolean input does not fire callbacks. Native event ordering beyond this sequence is not simulated. Labels are display-only in this player. It approximates coordinates, dimensions, visibility and basic horizontal or vertical auto-layout. Forms and cards are containers rather than a complete native form experience. Other hosted runtime controls may not have a matching visual implementation. Choose a viewport in the player to recompute responsive formulas; browser resizing alone does not change the selected app resolution. The inspector exposes state and source formula locations, but does not provide Power Fx stepping or Power Apps Studio editing. Compare with Microsoft's [responsive layout guidance](https://learn.microsoft.com/power-apps/maker/canvas-apps/create-responsive-layout), [checkbox](https://learn.microsoft.com/power-apps/maker/canvas-apps/controls/control-check-box), and [toggle](https://learn.microsoft.com/power-apps/maker/canvas-apps/controls/control-toggle) references.

## Formulas

Every formula runs on the Power Fx engine. Screens and controls are records whose properties are computed when a formula reads them and remembered until an input they read changes; a behaviour formula clears what is remembered when it completes. A property that depends on itself reads blank and reports `CANVAS_FORMULA_CYCLE` naming the properties of the cycle. Behaviour functions (Set, UpdateContext, Navigate, Back, Notify, Launch, Patch, Collect, ClearCollect, Clear, Remove, SubmitForm, NewForm, EditForm, ViewForm, ResetForm, Reset, Select, Refresh) behave the same at the start of a formula and nested inside If, Switch, IfError or any other expression. Variables, context variables and collections exist from the moment a formula names them in Set, UpdateContext, Navigate or Collect and read blank (a collection: empty) until set. An action that answers an error value (a refused write, also inside ForAll) is recorded and the chain continues; an evaluation failure (an unknown name, an unsupported function) ends the formula and undoes it. An unhandled error runs `App.OnError` when the app declares it. App.OnStart runs before the start screen (App.StartScreen, else the first screen) shows and runs its OnVisible; a Navigate in App.OnStart opens its screen instead, and only that screen's OnVisible runs. Navigate and Back take effect when the behaviour formula completes: OnHidden of the current screen runs, the target screen's context variables take the third argument of Navigate, and the target's OnVisible runs. Back answers false when there is no earlier screen. Select runs the target's OnSelect after the current formula. App.Formulas named formulas are available everywhere.

## Data sources

A Dataverse table data source is read and written as the person running the app, through the same records layer the Web API uses (security roles, row access, column security, business rules and plug-ins). A formula whose filter is delegable (comparisons, And/Or/Not, IsBlank, StartsWith and `in` on columns) runs as a query and returns every matching row; any other formula reads the first 500 rows (the data row limit) and reports the `POWERFX_DELEGATION` warning naming the property. Row columns resolve by logical name and by display name (`ThisItem.'Display Name'`), in reads and in Patch. A write the person's security roles do not allow fails with the platform's 403 (`CreatePermission`, `EditPermissions` or `DeletePermissions` as the error kind) and writes nothing. Connector data sources call the project's connections through the connector runtime as `Source.Operation(...)` where the formula calls it: a call in a branch that is not taken is never made, and a behaviour formula makes each call once and uses its answer, whatever its arguments (Now(), GUID() or an id the formula just created included). A connector-backed property reads blank until its answer arrives. Changes to tracked control, viewport, global variable and screen context dependencies invalidate the answer without repeating unrelated calls. In-place collection mutations and data-source changes can retain cached answers; use the driver `refresh` action to reread them. A call no provider answers is an error value with HTTP status 501 and error kind `NotSupported`. Snapshots and API answers keep every digit of an exact decimal.

## Driving and observing an app

`createCanvasHandler` in `mirage/lib/canvas-http.mjs` serves the reserved `/_apps/canvas/` and `/_apps/api/canvas/` prefixes. Because they sit under `/_apps/`, they cannot shadow a portal page such as `/canvas`. Both hosts mount them before the model-driven handler (`mirage/lib/organization-host.mjs`). The app list is the `canvasapp` records of the Solution inventory (`sources.inventory`) plus the apps of the project `canvas.sources`.

`/_apps/canvas/<app>` opens the player, with a Start button, selectable viewport resolutions, and an inspector for runtime state and diagnostics. Use `?view=inspect` for the inventory and, for a selected staff user or a signed-in portal visitor, the headless app: the current screen and history, every control with its current property values (gallery rows included), variables, context variables, collections, data sources, forms, notifications, launches, errors, diagnostics and recent activity, with forms that select a control, set a control's input, navigate, go back or run a behaviour formula. Unsupported controls are identified in the player and inspector. `GET /_apps/api/canvas/<app>` answers the same snapshot as JSON and `POST /_apps/api/canvas/<app>` takes one action: `{ "action": "select", "control", "item"? }`, `{ "action": "input", "control", "value", "item"? }`, `{ "action": "navigate", "screen" }`, `{ "action": "back" }`, `{ "action": "run", "formula" }`, `{ "action": "evaluate", "formula" }`, `{ "action": "refresh" }`, `{ "action": "start", "viewport": { "width": 390, "height": 844 } }` or `{ "action": "reset" }`. Start/reset accept an optional viewport (integer dimensions 1 to 8192); a new instance uses it during OnStart. `{ "action": "resize", "width": 768, "height": 1024 }` changes the viewport and recomputes dependent formulas without restarting. Reading never starts an app: until a POST starts it (the page's Start form, or any action), the page offers the Start form and the GET answers `{ "started": false }`. The API answers loopback callers with the `x-sim-csrf` header; a refused data write answers its status (403) with the snapshot after it. The app runs as the selected staff user or, on the Power Pages host, as the Dataverse user enhanced authorization maps a signed-in visitor to; an anonymous visitor, or a visitor of a site in the standard authorization model, is refused with `401 CanvasPrincipalRequired`. Each person has an app instance of their own.

| Route                                        | Response                                                                                   |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /_apps/canvas/`                         | List of apps. Returns JSON when the request has `Accept: application/json`, otherwise HTML |
| `GET /_apps/canvas/<uniqueName>`             | The app page described above                                                               |
| `GET /_apps/canvas/api/<uniqueName>`         | The JSON inventory with the app's level                                                    |
| `GET`, `POST /_apps/api/canvas/<uniqueName>` | The snapshot, or one action and the snapshot after it                                      |

An unknown app returns 404 `CanvasAppNotFound`. A page path answers 405 to any method other than GET. Every response sends `cache-control: no-store`, `x-content-type-options: nosniff` and a restrictive `content-security-policy`. The player loads its own same-origin script; source values are inserted as text rather than executable markup.

## Preflight

Partial YAML, malformed structures, name collisions, unknown schemas and invalid data-source declarations block complete app/rendering coverage even when some screens remain playable. Name collisions cannot be run safely with the local app-wide lookup: starting such an app answers 501 `CanvasSourceNameCollision`, while its inventory remains readable. This includes component names that native Power Apps can scope separately. Unreadable apps have an explicit unsupported app requirement. The shared rendering verdict includes both Solution and project apps, so a supported Solution cannot hide an unsupported project source. List and inventory API results expose incomplete-source diagnostics separately from the playable local subset.

A canvas app whose source parses reports level `behaviour`. Its `canvas:app/<name>` requirement (Solution and project `canvas.sources` apps alike) is satisfied when every control is hosted, else `unsupported` with `CANVAS_CONTROL_UNSUPPORTED` naming the controls. `canvas:rendering` is a `contract` requirement with reason `CANVAS_RENDERING_BASELINE`: it is satisfied when each app has readable source and no unsupported controls, and otherwise is unsupported. Rendering admission is narrower than logic hosting: Image, modern controls and component instances remain rendering gaps even when their formulas run. This reports the baseline player, not full Power Apps rendering parity. An app without readable source stays at `inventory` with its source diagnostic as the reason. The `canvas` host surface and the `canvas-apps` capability record are `behaviour`.

## Project configuration

The project `canvas` key (`mirage.canvas` of a catalogue site) takes `{ enabled, sources }`. `enabled: false` turns the surface off: every path under `/_apps/canvas/` answers 404 `CanvasAppsDisabled`, the first refused request reports `CANVAS_DISABLED`, `capabilities.canvas` is `disabled` and the `canvas` capability record has `enabled: false`. `sources` lists project paths, resolved against the project root, each an `.msapp` file or an extracted app folder; `readCanvasSources(sources, { projectRoot })` in `canvas-source.mjs` reads them at host start, and each app joins the inventory (`source` set to the configured path) and the `/_apps/canvas/` list. A missing or unreadable path reports `CANVAS_SOURCE_MISSING` (severity `error`) and a preflight requirement `canvas-source:<path>` with status `missing`. Changing the key restarts the runtime.

For a configured catalogue, run from the toolkit checkout:

```sh
node bin/paqvilo.mjs mirage init --config <catalogue> --site <site>
node bin/paqvilo.mjs mirage dev --config <catalogue> --site <site> --debug-port 9222
```

Set `mirage.canvas.sources` in the site configuration to project-relative extracted app folders or `.msapp` files, then restart the runtime. Open `/_apps/canvas/` on its local origin and choose an app. For a standalone project use `paqvilo mirage serve --project <project-file>`. To attach browser developer tools, choose a free debug port, wait for the browser-ready message, and attach to that port; see [debugging setup](../../docs/lense.md). This uses local simulated data and a local session; it does not deploy or synchronize sources.

## Power Fx

The optional [PAC differential check](power-fx-oracle.md) compares a fixed pure corpus with Microsoft's console evaluator. It established corrections for selected `IfError` replacement coercion and exact numeric `Text` formatting. It does not replace the local interpreter or establish complete host parity.

Mirage includes a Power Fx interpreter (`mirage/lib/power-fx.mjs`): the documented grammar (operators, `;` chaining, `As`, `With`, records, tables, string interpolation, `[@Name]` disambiguation), typed values (number, text, Boolean, date, time and date/time with time zone semantics, GUID, records, tables, blank, error values with the documented `ErrorKind` codes, untyped values from `ParseJSON`) and the function table: every function of the formula-column reference plus the table, behaviour and text functions that Functions, low-code plug-ins and canvas apps use. Unknown functions answer 400 `PowerFxFunctionUnsupported` naming the function; connector functions are not part of the engine. `Now`, `Today` and date parts read in the host's time zone (UTC by default); `UTCNow` and `UTCToday` read in UTC. A numeric overflow, an invalid date text (`DateValue("2023-02-30")`) and a failed element of `ForAll` are error values that `IfError` handles. Adding a number to a date/time adds wall-clock days, as `DateAdd(..., TimeUnit.Days)` does, also across daylight-saving changes. The capability record `power-fx` is at behaviour. The preflight shows no `power-fx:evaluator` requirement while the engine is enabled.

`createPowerFxEvaluator({ adapter, engine })` in `mirage/lib/canvas-power-fx.mjs` is the single Power Fx entry point. Its contract is:

- `check(expression, { symbols })` resolves to `{ ok, diagnostics, returnType? }`;
- `evaluate(expression, { symbols, values, principal })` resolves to `{ value }`;
- `checkSync` and `evaluateSync` take the same arguments and answer synchronously. Formula columns and `api.fxEvaluator` read through them, because record hooks are synchronous;
- `describe()` returns the capability record `power-fx`. Its kind is `provider` and its operations are `evaluate`, `evaluateSync`, `check` and `checkSync`, each with its own level.

The default evaluator is the core engine (`source: 'core'`). `createPowerFxEvaluator({ engine: false })` disables it: `evaluate` and `evaluateSync` answer 501 `PowerFxNotImplemented`, `check` answers `{ ok: false, diagnostics: [{ code: 'POWERFX_NOT_IMPLEMENTED' }] }`, `describe().level` is `contract` and the record requires `adapter:powerFx`.

A trusted data pack can export `powerFx: { evaluate | evaluateSync, check? | checkSync? }`, which replaces the core engine. The adapter needs `evaluate` or `evaluateSync` (at least one); every member present must be a function, and `validatePowerFxAdapter` checks that shape. The synchronous operations are `behaviour` only when the adapter answers synchronously (an `evaluateSync`, or an `evaluate` that is not an async function). On the synchronous path an async-only adapter, or one that returns a promise, is refused with 501 `PowerFxAsyncAdapter`. An adapter that returns no `{ value }` fails with `PowerFxAdapterInvalid`. If the adapter has no `check` or `checkSync`, checking fails with `POWERFX_CHECK_NOT_IMPLEMENTED`; it is not reported as success.

This entry point also backs the Dataverse `ExecuteFxExpression` message (`api.fxEvaluator`), formula columns (see [Dataverse](dataverse-parity.md)), Dataverse Functions and automated low-code plug-ins (see [Dataverse plugins](dataverse-plugins.md)). `describeCustomApis(api)` is the capability record of the Functions and plug-ins (`function:<uniquename>`, `automated:<uniquename>`): `behaviour` while an evaluator answers, `contract` with the engine disabled. `powerFxRequirements(store, powerFx)` returns one preflight row `power-fx:evaluator` per such operation only when the engine is disabled and no adapter is registered, so `--strict` blocks then.

## Reproduce the baseline

From a prepared toolkit checkout:

```sh
node --test mirage/test/canvas-runtime-layout.test.mjs mirage/test/canvas-rendering.test.mjs mirage/test/canvas-player-http.test.mjs
node --test test-browser/canvas-player.test.mjs
npm run validate
```

The browser fixture creates a disposable invented app, loads it through project `canvas.sources` as an extracted directory and a synthetic `.msapp`, signs in locally, filters a collection, opens gallery records, goes back, and checks horizontal/vertical layout at 1366x768, 768x1024 and 390x844. Separate negative coverage exercises source diagnostics, unsupported controls, source-text injection, ordered actions and a protocol-injected refusal response. The runtime tests separately exercise local Dataverse security denials. Screenshots stay under ignored `.paqvilo/canvas-baseline/`. Tests close their own runtime/browser and allocate loopback ports automatically.

## Not done

The player does not reproduce all Power Apps controls, styling, layout, or host behaviour. Combo boxes currently render single selection; there is no searchable or multi-select native parity. Automatic layout within gallery templates, timers, media, custom components, PCF, transitions, app display scaling/lock settings and native modern controls are outside this baseline. Gallery snapshots display the first 50 rows. Source changes require a runtime restart. Validation uses invented source matching the documented schema and a synthetic ZIP archive; it does not establish native Studio round-trip or parity with a deployed app. It does not edit `.pa.yaml` or `.msapp` files, and it does not pack or import apps back into an environment. Microsoft states that the `.pa.yaml` files are read-only and meant for reviewing changes. They are not used when an app loads ([source](https://learn.microsoft.com/power-apps/maker/canvas-apps/power-apps-yaml#source-code-payaml)). External editing and merging are supported only through Power Platform Git integration.
