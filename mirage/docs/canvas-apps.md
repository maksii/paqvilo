# Canvas apps in Mirage

Mirage renders supported exported Canvas app sources and runs their Power Fx formulas against simulated state and
caller-secured local data. It approximates the Power Apps player; unsupported contracts and rendering approximations
stay visible in the inspector and preflight. It does not edit, pack, import or deploy Canvas apps.

## Setup and sources

Configure `canvas` (catalogue `mirage.canvas`) as `{ enabled, sources, codeComponents }`:

- `sources` lists project-relative `.msapp` files or extracted app folders. Solution Canvas apps join the same
  inventory automatically.
- `enabled: false` disables the surface. `codeComponents: true` admits PCF ([Components and PCF](#components-and-pcf)).
- Changes to these settings need a restart. Missing paths report `CANVAS_SOURCE_MISSING`.

```sh
node bin/paqvilo.mjs mirage init --config <catalogue> --site <site>
node bin/paqvilo.mjs mirage dev --config <catalogue> --site <site> --debug-port <free-port>
```

Or `paqvilo mirage serve --project <project-file>`. Then select a staff user in `/_sim/` on the administration address
(`adminUrl`), open `/_apps/canvas/` on the apps address (`appsUrl`), choose an app and press **Start the app**. The
app list and player use the administration shell and the browser's colour scheme; the app stage keeps the app's own
colours. The Source column and the player's origin line name each app's source.

- **Identity.** The app runs as the selected staff user. On a Power Pages host an enhanced-authorization visitor must
  map to a Dataverse user; anonymous and standard-authorization visitors get `401 CanvasPrincipalRequired`. A cloud
  sign-in does not sign in to the local session. After a runtime restart, a tab that kept the earlier staff selection
  gets `401 StaffPrincipalUnavailable` until a staff user or the local administrator is chosen again in `/_sim/` (see
  [staff identity](model-driven-apps.md#staff-identity-and-permissions)).
- **Source formats.** The reader prefers current `Src/*.pa.yaml`. It also accepts retired `Src/*.fx.yaml` with
  `DataSources/*.json` and reports `CANVAS_SOURCE_LEGACY_FXYAML`. Get current source from Studio or
  `pac canvas download` with source extraction (`-d`). Microsoft documents this source as review material, not an
  editing or packing contract ([source code](https://learn.microsoft.com/power-apps/maker/canvas-apps/power-apps-yaml)).
  PAC is optional and Mirage never runs it.
- **Reload.** Both hosts watch the configured source folders. With source watching on, an edit reloads the inventory
  and invalidates running instances; an open player shows `Source updated. Start the app again.` and never reruns
  OnStart by itself. Revision polling pauses in hidden tabs. Media bytes and exported enums are part of the revision.
- **Overrides.** A `canvas.sources` folder or `.msapp` whose unique name equals a Solution Canvas app's unique name
  (case-insensitive) replaces that app and keeps the Solution's display name. A folder's unique name is its last path
  segment; an `.msapp` file's is its file name without `.msapp`. Of two sources with the same unique name, the first
  listed is served and the other reports `CANVAS_SOURCE_DUPLICATE`.

## Supported local behaviour

| Area             | Coverage                                                                                                                                                                  | Limits                                                                                                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Controls         | Labels, text input, buttons, drop-downs, searchable multi-select ComboBox, check boxes, toggles, date picker, slider, radio, number input, progress/spinner, shapes/icons | Modern and version-specific properties and theme defaults are approximations                                    |
| Galleries/layout | Row scope, selection, `AllItemsCount`, paging beyond the first 50 rows, auto-layout in gallery templates, horizontal/vertical containers, fill/align/padding/gap          | `AllItems` materializes the bounded source; no native virtualization; wrapped auto-layout sizing is approximate |
| State/navigation | Global and screen state, collections, `Navigate`/`Back`, history, screen context and lifecycle, `Reset`; approximate Fade/Cover/UnCover with reduced-motion support       | Not every native event order or timing                                                                          |
| Forms            | Edit/display forms and cards, binding, validation, submit and reset                                                                                                       | Presentation approximates native forms                                                                          |
| Timers           | Start, AutoStart, Reset, Repeat, AutoPause, `Value`/`Running`, start/end events, deterministic `tick` actions                                                             | Web Locks elect one visible tab's clock; not a real-time scheduler                                              |
| Media            | Exported images, audio and video, media state and events; playback survives redraw where the browser has `Element.moveBefore`                                             | Browser codecs and autoplay rules                                                                               |
| Add picture      | PNG/JPEG/GIF/WebP up to 1 MiB with MIME and signature checks, `Media`, OnChange/Reset; local `FileName` output                                                            | No generic attachments, cloud upload, camera or device APIs; `FileName` is not a documented native contract     |
| HTML/icons       | Allowlisted markup, typography and local images; text glyph icons                                                                                                         | Links inert; scripts, iframes and external media removed; no arbitrary HTML/CSS                                 |

- OnSelect runs on buttons, gallery rows and selectable labels, images and icons. Input runs OnChange; Boolean
  changes also run OnCheck/OnUncheck once. ComboBox supports `SearchText`, `SelectedItems` and authored display labels.
  Invalid or disabled interactions are refused. Unknown control types are `CanvasControlUnsupported` gaps. Omitted
  properties use the local catalogue's defaults.
- **Text input timing** follows `TriggerOutput`. By default (classic `DelayOutput` false, modern `Keypress`) each
  keystroke updates `Text`. `Delayed` (or `DelayOutput` true) sends the value 500 ms after the last keystroke;
  `FocusOut` sends nothing while typing. A commit (Enter or leaving the field) sends the value and runs OnChange once
  for the typing since the previous commit. Keystrokes use the `text` action, which does not run OnChange.
- **Accessible names.** A control's name is its `AccessibleLabel`; without one, a button uses its text and a check box
  or toggle its `Text` (or `Label`). An image, icon or shape with an empty `AccessibleLabel` is hidden from assistive
  technology unless it has an enabled OnSelect. Containers, galleries, forms and cards carry no name. The source name
  stays in `data-control`.
- **Display.** Screen size, scale to fit, lock aspect ratio, lock orientation and orientation come from the `.msapp`'s
  `Properties.json` (or the retired `CanvasManifest.json`). Where the source lacks them, set
  `observed.canvasDisplay.<appUniqueName>` with `designWidth`, `designHeight` (1–8192), `scaleToFit`,
  `lockAspectRatio`, `lockOrientation` and `orientation` (`Portrait`/`Landscape`) plus `observed.evidence`; an observed
  field overrides the source. Scale-to-fit needs both design dimensions. Scaling, letterboxing and orientation lock are
  local approximations shown in the inspector.
- **Resolution and zoom.** The Resolution list opens at the running instance's size, else the size chosen earlier in
  this tab for the app, else the app's screen size, else 1366 × 768; browser-responsive sizing is also offered. The
  player's Zoom (Fit to window, the default, or 100%) only scales the view, never above 100%; `App.Width`,
  `App.Height` and formulas keep the chosen resolution. Zoom is not the app's `scaleToFit`.

## Components and PCF

Canvas component definitions expand per instance with qualified child names, `Self`/`Parent`/`ThisComponent`
bindings, data input/output properties, local state and `AccessAppScope` restrictions. Enhanced function, action and
event properties keep typed arguments, optional defaults and behaviour scope. `Reset(component)` runs OnReset;
exported `RaiseOnReset` inputs trigger it after a settled action, with bounded feedback detection. Exact intra-chain
event order is not reproduced. Missing, recursive or excessive expansions and unsupported contracts are diagnosed;
unknown legacy directions are warned about.

PCF requires `canvas.codeComponents: true` and the exact exported Solution manifest and resources. Admitted scalar
standard controls get `init`/`updateView`/`getOutputs`/`destroy`, typed property bindings, outputs and declared events.
A virtual control also needs its platform libraries as `<Library>@<version>.js` files in `modelDriven.clientSources`
(see [PCF inputs and limits](model-driven-customizations.md#pcf-inputs-and-limits)); there is no CDN fallback. Refusals
use `CANVAS_PCF_*` codes: `CANVAS_PCF_TRUST_REQUIRED`, `CANVAS_PCF_MANIFEST_UNAVAILABLE`,
`CANVAS_PCF_DATASET_UNSUPPORTED` (dataset controls and the Canvas WebAPI are not available),
`CANVAS_PCF_FEATURE_UNSUPPORTED`, `CANVAS_PCF_PROPERTY_UNSUPPORTED`, `CANVAS_PCF_DEFAULT_UNSUPPORTED`,
`CANVAS_PCF_RESOURCE_UNAVAILABLE` and `CANVAS_PCF_EVENT_UNSUPPORTED`. A manifest `pfx-default-value` applies only
without an authored binding; unresolved Studio `%...%` placeholders refuse. Localization and binary resource services
are incomplete. Admission runs code you chose to trust; it does not prove native package equivalence.

## Formulas and data

- Properties evaluate lazily with dependency invalidation; cycles report `CANVAS_FORMULA_CYCLE`. Behaviour formulas run
  through one serialized action queue. Component functions share its journal, so connector replay does not repeat
  local side effects or random calls. `RGBA`, `ColorValue` and `ColorFade` return CSS colour values. Blank or
  comment-only formulas evaluate blank; invalid formulas error.
- Table sources bind only to configured local providers under the caller's permissions. A declared but unavailable
  table reports `CANVAS_DATASOURCE_UNAVAILABLE`; no provider is invented. Collections from legacy source stay local.
- `UpdateIf` changes collections or caller-secured tables. `Errors(source[, record])` lists the caller's tracked write
  failures; a successful write or `Refresh` clears them, and providers without error tracking refuse.
- Exported logical-to-display field aliases work in formulas and writes. Exact exported option-set roots and labels
  become enums (ambiguous mappings are omitted with a diagnostic); enum `Choices` keep typed numeric values and labels,
  reject cross-enum comparisons and serialize as `{Value: number, Label: text}`. Column `Choices` from direct exported
  columns are a local `{Value: label, Id: number}` approximation. `DataSourceInfo` reads exported metadata and the
  caller's permissions.
- Delegable Dataverse queries push down; other queries read up to 500 rows with a delegation warning. This is not
  native delegation behaviour. Connector actions need a configured local implementation; cloud connectors never run. One
  behaviour formula may wait for at most 50 connector answers.

## Debugging and routes

The inspector shows evaluated properties with source file and line, variables, context, collections, screens and
history, data sources, forms, errors, notifications, launches, diagnostics and recent activity. `?view=inspect` gives
headless action forms. There is no Power Fx step debugger or Studio editor; use browser developer tools, or attach
Playwright/CDP to the debug port. A failed action can return a snapshot with earlier effects: check its errors and HTTP
status, not only the screen.

| Route                          | Behaviour                                                                            |
| ------------------------------ | ------------------------------------------------------------------------------------ |
| `GET /_apps/canvas/`           | App list; JSON with `Accept: application/json`                                       |
| `GET /_apps/canvas/<app>`      | Player; `?view=inspect` for headless inspection                                      |
| `GET /_apps/canvas/api/<app>`  | Source inventory, admission and diagnostics; `?revision=1` returns only the revision |
| `GET /_apps/api/canvas/<app>`  | Current snapshot; never starts the app                                               |
| `POST /_apps/api/canvas/<app>` | One serialized action; returns result, errors and snapshot                           |

`POST` needs a principal and the apps token in `x-sim-csrf` (or a form's `_csrf` field); the administration token is
also accepted. Actions: `start`, `reset` (optional parameters and viewport), `select`, `input`, `text`, `navigate`,
`back`, `run`, `evaluate`, `refresh`, `resize`, `search` (a ComboBox's `SearchText`), `gallery-window`, `tick`, `media`,
`add-media`, `codecomponent` and `codecomponent-event`; fields are validated in `mirage/lib/canvas-http.mjs` and
`canvas-runtime.mjs`. An unknown action answers `400 CanvasActionInvalid`, whose message lists every accepted action.
Use `tick` to advance time instead of waiting. Bodies are limited to 64 KiB, except `add-media` (1 MiB decoded image).
Responses are `no-store`, same-origin assets are bounded, SVG assets are sandboxed and source HTML never becomes
executable markup.

A trusted pointer or key press in the player starts its own trace activity, linked to the page load; see
[request tracing](tracing.md#what-joins-and-what-starts-a-new-trace).

**Preflight.** `canvas:app/<name>` covers hosted behaviour. Incomplete YAML or schema, unresolved name collisions and
missing component contracts block complete coverage even when some screens play. Live preflight uses prepared
component and PCF admission; static inventory cannot prove PCF admission. `canvas:rendering` stays at contract level
and lists visual approximations. A satisfied verdict covers the local contract, not native fidelity.

## Power Fx

Mirage's interpreter (`mirage/lib/power-fx.mjs`, functions in `power-fx-functions.mjs`) implements the grammar listed
in its header comment (operators, `;` chaining, `As`,
`With`, records, tables, string interpolation, `[@Name]` disambiguation), typed values (number, text, Boolean, date,
time and date/time with time zones, GUID, records, tables, blank, error values with `ErrorKind` codes, untyped values
from `ParseJSON`) and the functions of the formula-column reference plus the table, behaviour and text functions that
Functions, low-code plug-ins and Canvas apps use.

- An unknown function answers 400 `PowerFxFunctionUnsupported`; connector functions are not part of the engine.
- `Now`, `Today` and date parts use the host time zone (UTC by default); `UTCNow` and `UTCToday` use UTC. Adding a
  number to a date/time adds wall-clock days, as `DateAdd(..., TimeUnit.Days)` does, across daylight-saving changes.
- Numeric overflow, an invalid date (`DateValue("2023-02-30")`) and a failed `ForAll` element are error values that
  `IfError` handles.

`createPowerFxEvaluator({ adapter, engine })` in `mirage/lib/canvas-power-fx.mjs` is the single entry point:

| Member                                                 | Result                                                                                                           |
| ------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `check(expression, { symbols })`                       | Resolves to `{ ok, diagnostics, returnType? }`                                                                   |
| `evaluate(expression, { symbols, values, principal })` | Resolves to `{ value }`                                                                                          |
| `checkSync`, `evaluateSync`                            | Same arguments, synchronous; formula columns and `api.fxEvaluator` use them because record hooks are synchronous |
| `describe()`                                           | Capability record `power-fx`, kind `provider`, with a level per operation                                        |

- The default is the core engine (`source: 'core'`, level `behaviour`); preflight then shows no `power-fx:evaluator`
  row. With `engine: false`, `evaluate` and `evaluateSync` answer 501 `PowerFxNotImplemented`, `check` answers
  `{ ok: false, diagnostics: [{ code: 'POWERFX_NOT_IMPLEMENTED' }] }`, the level is `contract` and the record requires
  `adapter:powerFx`.
- A trusted data pack can export `powerFx: { evaluate | evaluateSync, check? | checkSync? }` to replace the engine;
  `validatePowerFxAdapter` checks that at least one evaluate member exists and every member present is a function. The
  synchronous operations are `behaviour` only when the adapter answers synchronously; otherwise the synchronous path
  refuses with 501 `PowerFxAsyncAdapter`. A result without `{ value }` fails with `PowerFxAdapterInvalid`. Without
  `check`/`checkSync`, checking fails with `POWERFX_CHECK_NOT_IMPLEMENTED`.
- The same entry point backs `ExecuteFxExpression` (`api.fxEvaluator`), formula columns
  ([Dataverse](dataverse-parity.md)), Dataverse Functions and automated low-code plug-ins
  ([Dataverse plug-ins](dataverse-plugins.md)). `describeCustomApis(api)` describes those as `function:<uniquename>` and
  `automated:<uniquename>`: `behaviour` while an evaluator answers, `contract` with the engine disabled.
  `powerFxRequirements(store, powerFx)` adds a `power-fx:evaluator` preflight row per such operation only when the
  engine is disabled and no adapter is registered, so `--strict` blocks.

The optional [PAC differential check](power-fx-oracle.md) compares a fixed corpus with Microsoft's console evaluator.

## Validation and limits

```sh
node --test mirage/test/canvas*.test.mjs mirage/test/power-fx*.test.mjs
node --test --import=./test/browser-bootstrap.mjs --test-concurrency=1 test-browser/canvas*.test.mjs mirage/test-browser/canvas*.test.mjs
npm run validate
```

Toolkit fixtures use invented schemas and ephemeral ports; browser tests run at 1366×768, 768×1024 and 390×844. They do
not establish cloud or native parity. Creator Kit bundles that report PCF checksum warnings are not run as trusted
components.

Not reproduced: native pixel, theme and version fidelity; hardware and device controls; arbitrary attachments; full
HTML/CSS; every enhanced component and legacy metadata contract; complete PCF resources and context; native delegation
and connector semantics; a Studio round trip. Unknown features stay diagnostics or refusals.
