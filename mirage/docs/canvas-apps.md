# Canvas apps in Mirage

Mirage hosts the logic of a canvas app without rendering it. Screens, controls and their property formulas, data sources, variables, collections, behaviour formulas and navigation state run headlessly; nothing is drawn as the app would look. The source is the Power Apps YAML source code (`Src/*.pa.yaml`) of an `.msapp` file or an extracted folder, from a Solution or from the project `canvas.sources`. An app saved only in the retired unpacked format (`Src/*.fx.yaml` with `DataSources/*.json`) is read from that format and reports `CANVAS_SOURCE_LEGACY_FXYAML`; when both formats are present, the `.pa.yaml` files are used.

## What is inventoried

`readCanvasSource({ msapp, dir, name, version })` in `mirage/lib/canvas-source.mjs` reads one app from either an `.msapp` archive in memory or an extracted directory. It reads only the Power Apps YAML source code under `Src/` (`Src/App.pa.yaml`, `Src/<Screen>.pa.yaml` and `Src/Component/<Name>.pa.yaml`). Microsoft documents that only these files are source code. The other JSON files in an `.msapp` are not stable between saves. See [View source code files for canvas apps](https://learn.microsoft.com/power-apps/maker/canvas-apps/power-apps-yaml) and the [pa.yaml v3.0 schema](https://raw.githubusercontent.com/microsoft/PowerApps-Tooling/refs/heads/master/schemas/pa-yaml/v3.0/pa.schema.yaml).

The result lists:

- the app (`name`, `version` and `schemaVersion`), where the Solution supplies the name and version;
- the screens, each with its flattened controls (`name`, `control` type with version, `parent` and optional `variant`/`componentName`);
- the component definitions;
- the data sources: `Table` sources with `table` (the Dataverse logical name) and `Actions` sources with `connectorId`;
- the formulas, one row per property: `{ owner, property, text, source, line }`, for example `{ owner: 'HomeScreen.Gallery1', property: 'Items', text: '=Filter(...)' }`.

Formula rows contain only the formula text; the runtime described below evaluates them.

| Diagnostic | Meaning |
| --- | --- |
| `CANVAS_SOURCE_LEGACY_FXYAML` | The app was read from retired `.fx.yaml` files (`pac canvas unpack`); next to `Src/*.pa.yaml` they are ignored |
| `CANVAS_SOURCE_NO_PAYAML` | No `Src/*.pa.yaml` was found. Re-save the app in Power Apps Studio |
| `CANVAS_SOURCE_SCHEMA_UNKNOWN` | A `$schema` modeline names an unknown pa.yaml version, or a file uses a top-level key outside the v3.0 schema |
| `CANVAS_SOURCE_YAML_INVALID` | A file does not parse. The message gives only the file, line and parser code, never the content |
| `CANVAS_SOURCE_ARCHIVE_INVALID` | The `.msapp` bytes are not a readable ZIP archive |

`canvasInventoryRecord(source, { id, solution, layer, file, format })` turns a result into a Solution inventory record: `component: 'canvasapp'`, `componentType: 300`, `dependencies` derived from the data sources (`table` and `connector`, the inventory component vocabulary), and `level: 'behaviour'` when the source parses; an app without readable source stays at `inventory` with its source diagnostic as the reason.

## Hosted controls

The runtime hosts Screen, Label, Text input, Button, Gallery, Edit form and Display form with their cards, Drop down, Combo box, Check box, Toggle, Date picker, Image (the `Image` property as a URL value) and containers. Every other control type, and every component instance, is listed as unsupported by name and type: its declared formulas still evaluate, but it cannot be selected or given input (`501 CanvasControlUnsupported`). Properties a source leaves out take the defaults in `mirage/lib/canvas-controls.mjs`.

## Formulas

Every formula runs on the Power Fx engine. Screens and controls are records whose properties are computed when a formula reads them and remembered until an input they read changes; a behaviour formula clears what is remembered when it completes. A property that depends on itself reads blank and reports `CANVAS_FORMULA_CYCLE` naming the properties of the cycle. Behaviour functions (Set, UpdateContext, Navigate, Back, Notify, Launch, Patch, Collect, ClearCollect, Clear, Remove, SubmitForm, NewForm, EditForm, ViewForm, ResetForm, Reset, Select, Refresh) behave the same at the start of a formula and nested inside If, Switch, IfError or any other expression. Variables, context variables and collections exist from the moment a formula names them in Set, UpdateContext, Navigate or Collect and read blank (a collection: empty) until set. An action that answers an error value (a refused write, also inside ForAll) is recorded and the chain continues; an evaluation failure (an unknown name, an unsupported function) ends the formula and undoes it. An unhandled error runs `App.OnError` when the app declares it. App.OnStart runs before the start screen (App.StartScreen, else the first screen) shows and runs its OnVisible; a Navigate in App.OnStart opens its screen instead, and only that screen's OnVisible runs. Navigate and Back take effect when the behaviour formula completes: OnHidden of the current screen runs, the target screen's context variables take the third argument of Navigate, and the target's OnVisible runs. Back answers false when there is no earlier screen. Select runs the target's OnSelect after the current formula. App.Formulas named formulas are available everywhere.

## Data sources

A Dataverse table data source is read and written as the person running the app, through the same records layer the Web API uses (security roles, row access, column security, business rules and plug-ins). A formula whose filter is delegable (comparisons, And/Or/Not, IsBlank, StartsWith and `in` on columns) runs as a query and returns every matching row; any other formula reads the first 500 rows (the data row limit) and reports the `POWERFX_DELEGATION` warning naming the property. Row columns resolve by logical name and by display name (`ThisItem.'Display Name'`), in reads and in Patch. A write the person's security roles do not allow fails with the platform's 403 (`CreatePermission`, `EditPermissions` or `DeletePermissions` as the error kind) and writes nothing. Connector data sources call the project's connections through the connector runtime as `Source.Operation(...)` where the formula calls it: a call in a branch that is not taken is never made, and a behaviour formula makes each call once and uses its answer, whatever its arguments (Now(), GUID() or an id the formula just created included). A property formula reads blank until its connector answer arrives and keeps the answer until `refresh`. A call no provider answers is an error value with HTTP status 501 and error kind `NotSupported`. Snapshots and API answers keep every digit of an exact decimal.

## Driving and observing an app

`createCanvasHandler` in `mirage/lib/canvas-http.mjs` serves the reserved `/_apps/canvas/` and `/_apps/api/canvas/` prefixes. Because they sit under `/_apps/`, they cannot shadow a portal page such as `/canvas`. Both hosts mount them before the model-driven handler (`mirage/lib/organization-host.mjs`). The app list is the `canvasapp` records of the Solution inventory (`sources.inventory`) plus the apps of the project `canvas.sources`.

`/_apps/canvas/<app>` shows the app's inventory and, for a selected staff user or a signed-in portal visitor, the headless app: the current screen and history, every control with its current property values (gallery rows included), variables, context variables, collections, data sources, forms, notifications, launches, errors, diagnostics and recent activity, with forms that select a control, set a control's input, navigate, go back or run a behaviour formula. The page states that the app is not rendered and lists the controls that are not hosted. `GET /_apps/api/canvas/<app>` answers the same snapshot as JSON and `POST /_apps/api/canvas/<app>` takes one action: `{ "action": "select", "control", "item"? }`, `{ "action": "input", "control", "value", "item"? }`, `{ "action": "navigate", "screen" }`, `{ "action": "back" }`, `{ "action": "run", "formula" }`, `{ "action": "evaluate", "formula" }`, `{ "action": "refresh" }`, `{ "action": "start" }` or `{ "action": "reset" }`. Reading never starts an app: until a POST starts it (the page's Start form, or any action), the page offers the Start form and the GET answers `{ "started": false }`. The API answers loopback callers with the `x-sim-csrf` header; a refused data write answers its status (403) with the snapshot after it. The app runs as the selected staff user or, on the Power Pages host, as the Dataverse user enhanced authorization maps a signed-in visitor to; an anonymous visitor, or a visitor of a site in the standard authorization model, is refused with `401 CanvasPrincipalRequired`. Each person has an app instance of their own.

| Route | Response |
| --- | --- |
| `GET /_apps/canvas/` | List of apps. Returns JSON when the request has `Accept: application/json`, otherwise HTML |
| `GET /_apps/canvas/<uniqueName>` | The app page described above |
| `GET /_apps/canvas/api/<uniqueName>` | The JSON inventory with the app's level |
| `GET`, `POST /_apps/api/canvas/<uniqueName>` | The snapshot, or one action and the snapshot after it |

An unknown app returns 404 `CanvasAppNotFound`. A page path answers 405 to any method other than GET. Every response sends `cache-control: no-store`, `x-content-type-options: nosniff` and a `content-security-policy` that allows no scripts. Every value on a page is HTML-escaped.

## Preflight

A canvas app whose source parses reports level `behaviour`. Its `canvas:app/<name>` requirement (Solution and project `canvas.sources` apps alike) is satisfied when every control is hosted, else `unsupported` with `CANVAS_CONTROL_UNSUPPORTED` naming the controls. `canvas:rendering` is a `placeholder` requirement at `inventory` while there is a canvas app: rendering is the documented boundary. An app without readable source stays at `inventory` with its source diagnostic as the reason. The `canvas` host surface and the `canvas-apps` capability record are `behaviour`.

## Project configuration

The project `canvas` key takes `{ enabled, sources }`. `enabled: false` turns the surface off: every path under `/_apps/canvas/` answers 404 `CanvasAppsDisabled`, the first refused request reports `CANVAS_DISABLED`, `capabilities.canvas` is `disabled` and the `canvas` capability record has `enabled: false`. `sources` lists project paths, resolved against the project root, each an `.msapp` file or an extracted app folder; `readCanvasSources(sources, { projectRoot })` in `canvas-source.mjs` reads them at host start, and each app joins the inventory (`source` set to the configured path) and the `/_apps/canvas/` list. A missing or unreadable path reports `CANVAS_SOURCE_MISSING` (severity `error`) and a preflight requirement `canvas-source:<path>` with status `missing`. Changing the key restarts the runtime.

## Power Fx

Mirage includes a Power Fx interpreter (`mirage/lib/power-fx.mjs`): the Learn grammar (operators, `;` chaining, `As`, `With`, records, tables, string interpolation, `[@Name]` disambiguation), typed values (number, text, Boolean, date, time and date/time with time zone semantics, GUID, records, tables, blank, error values with the Learn `ErrorKind` codes, untyped values from `ParseJSON`) and the function table: every function of the Learn formula-column reference plus the table, behaviour and text functions that Functions, low-code plug-ins and canvas apps use. Unknown functions answer 400 `PowerFxFunctionUnsupported` naming the function; connector functions are not part of the engine. `Now`, `Today` and date parts read in the host's time zone (UTC by default); `UTCNow` and `UTCToday` read in UTC. A numeric overflow, an invalid date text (`DateValue("2023-02-30")`) and a failed element of `ForAll` are error values that `IfError` handles. Adding a number to a date/time adds wall-clock days, as `DateAdd(..., TimeUnit.Days)` does, also across daylight-saving changes. The capability record `power-fx` is at behaviour. The preflight shows no `power-fx:evaluator` requirement while the engine is enabled.

`createPowerFxEvaluator({ adapter, engine })` in `mirage/lib/canvas-power-fx.mjs` is the single Power Fx entry point. Its contract is:

- `check(expression, { symbols })` resolves to `{ ok, diagnostics, returnType? }`;
- `evaluate(expression, { symbols, values, principal })` resolves to `{ value }`;
- `checkSync` and `evaluateSync` take the same arguments and answer synchronously. Formula columns and `api.fxEvaluator` read through them, because record hooks are synchronous;
- `describe()` returns the capability record `power-fx`. Its kind is `provider` and its operations are `evaluate`, `evaluateSync`, `check` and `checkSync`, each with its own level.

The default evaluator is the core engine (`source: 'core'`). `createPowerFxEvaluator({ engine: false })` disables it: `evaluate` and `evaluateSync` answer 501 `PowerFxNotImplemented`, `check` answers `{ ok: false, diagnostics: [{ code: 'POWERFX_NOT_IMPLEMENTED' }] }`, `describe().level` is `contract` and the record requires `adapter:powerFx`.

A trusted data pack can export `powerFx: { evaluate | evaluateSync, check? | checkSync? }`, which replaces the core engine. The adapter needs `evaluate` or `evaluateSync` (at least one); every member present must be a function, and `validatePowerFxAdapter` checks that shape. The synchronous operations are `behaviour` only when the adapter answers synchronously (an `evaluateSync`, or an `evaluate` that is not an async function). On the synchronous path an async-only adapter, or one that returns a promise, is refused with 501 `PowerFxAsyncAdapter`. An adapter that returns no `{ value }` fails with `PowerFxAdapterInvalid`. If the adapter has no `check` or `checkSync`, checking fails with `POWERFX_CHECK_NOT_IMPLEMENTED`; it is not reported as success.

This entry point also backs the Dataverse `ExecuteFxExpression` message (`api.fxEvaluator`), formula columns (see [Dataverse](dataverse-parity.md)), Dataverse Functions and automated low-code plug-ins (see [Dataverse plugins](dataverse-plugins.md)). `describeCustomApis(api)` is the capability record of the Functions and plug-ins (`function:<uniquename>`, `automated:<uniquename>`): `behaviour` while an evaluator answers, `contract` with the engine disabled. `powerFxRequirements(store, powerFx)` returns one preflight row `power-fx:evaluator` per such operation only when the engine is disabled and no adapter is registered, so `--strict` blocks then.

## Not done

Mirage does not render canvas screens or controls (`canvas:rendering`). It does not edit `.pa.yaml` or `.msapp` files, and it does not pack or import apps back into an environment. Microsoft states that the `.pa.yaml` files are read-only and meant for reviewing changes. They are not used when an app loads ([source](https://learn.microsoft.com/power-apps/maker/canvas-apps/power-apps-yaml#source-code-payaml)). External editing and merging are supported only through Power Platform Git integration.
