# Reference parity evidence

How to compare Mirage with an authorized reference environment, and what such a comparison proves. Test assertions
built from recorded captures follow the [test kinds](../../docs/test-kinds.md): `parity` assertions are replay cases
built by `scripts/parity-cases.mjs` from two or more captures; a single capture or hand-linked evidence is
`observation`; a local model without proof is `unproven` and is never presented as parity. For the native component
baseline (forms, lists, multistep forms), see the [baseline](../../docs/baseline.md).

Reference reads go through the intended signed-in browser of an explicitly selected, authorized environment. They are
separate from source bootstrap and local testing. Keep plans, business routes, expected persona access, fixtures and
raw captures in your portal project under ignored `.paqvilo/`.

## Run a reference comparison

```sh
paqvilo mirage parity-suite --config <catalogue> --site <site> --env <env> --cdp http://127.0.0.1:<debug-port> --out .paqvilo/parity
```

Each reference tool takes the loopback debugging endpoint of the signed-in browser (`--cdp`) and the reference origin
(`--origin`, or the catalogue site):

| Command            | What it does                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parity-suite`     | Route, persona and scenario comparison of a local runtime (`--local`, `--source` or `--site`) with the reference; writes reports under `--out`.                                                                                                                                                                                                           |
| `reference-parity` | `--plan FILE` is a list of read contracts (`id`, `path`, `kind`, `fields`, `expectedStatus`, `expectedCount`, `prefer`, `statusOnly`); each is fetched with GET from the reference and from `--local` as a local visitor (`--local-contact`, `--local-role`, `--local-configured-persona`). Writes `reference-parity.json`; exit 1 when a contract fails. |
| `verify`           | Compares one page (`--path`, default `/`) by semantic DOM and screenshot pixels; writes `report.json`, the DOM files and `difference.png` under `--output`.                                                                                                                                                                                               |
| `enrich-reference` | Reads 1 to 100 paged, non-aggregate FetchXML table queries (`pageSize` at most 5000, `maxPages` at most 100, `mode` `merge` or `replace`, each table once) from the reference into a `--state` file. The runtime using that state must be stopped.                                                                                                        |
| `baseline-suite`   | The native component baseline; see its [runbook](baseline/rerun.md).                                                                                                                                                                                                                                                                                      |

Start the browser with a free debug port and confirm it in the Lense agent status. Plans and route guards reject
writes and forbidden actions, but navigating and reading the environment still needs authorization. Bearer tokens and
credentials are never stored; query values are redacted in reports.

- **Tab control.** While the reference driver holds a tab, every new tab or popup in that browser starts under its
  control until released. Pages opened by its tabs, and their popups, are held read-only; every other tab is released
  at once and not inspected. Control ends when the driver or its last tab closes.
- **Settling.** A page is settled when its own requests and those of its cross-site frames (any depth) finish; frame
  requests still running are listed in `pendingRequests`. Frame writes are always refused.
- **Debugger limits.** A message a cross-site frame posts to its parent within milliseconds of loading can be lost
  while the driver holds a popup of that page, so a widget waiting for it can be captured still loading. If another
  debugging client (DevTools, a Playwright session) resumes a cross-site frame before the driver tracks it, that
  frame's earlier requests are not counted and the capture can be reported settled too early.
- **Browser.** Use a browser with site isolation, such as Edge. Playwright's headless Chromium shell does not isolate
  sites: frames sharing the page's process can stop loading after a popup opens, and a popup's dedicated worker can
  fail to start under load, leaving the page unsettled or missing requests.

## Read a report

Reports separate passes, expected differences, skipped or incomplete observations, source or deployment differences
and runtime gaps, and record persona and session, source baseline, runtime fingerprint, reference context and
diagnostics. A deployed commit is never inferred. A source inventory, a successful import, a sign-in page or a local
screenshot is not coverage. Cite the project's retained comparison when you claim a behavior matches live.

Compare like with like:

- Mirage has its own identity and data: match the observed roles before comparing permission outcomes. Table, column
  and page permissions use different transports and authorization modes; compare each separately.
- Record a redirect's first response separately from the followed navigation. Compare decoded bytes, MIME type,
  disposition, selected headers and error messages independently.
- Lense applies eligible local patches in its live browser, but configuration records can still need deployment:
  check applied resources, unmatched patches and deployment diagnostics after refresh.
- **Queries.** A recorded query comparison needs three observations: the authored request, the XML Liquid produced and
  the query the backend plug-in received. Compare structure and results, keeping duplicate rows and error codes.
  Declare every GUID, timestamp, alias or formatting normalization; a normalized match is not byte equality. A missing
  backend capture on a failed request is incomplete evidence, not an empty query.
- **Permissions.** Role-mask coverage is finite only for an exact permission graph, actor memberships, environment
  settings and platform version. An exhaustive local mask test checks the local evaluator, not native masks you did
  not record. The [company example harness](../../examples/company-operations/portal-harness/README.md) replays private
  captures and reports equal, different and unqualified cases separately.

## Record frontend contracts

`paqvilo/mirage/testing` exports serializable probes that run the same authored plan in a native and a local browser
context. A plan names fixture fields and cases; a missing attribute fails instead of shrinking coverage. Run probes
only against explicitly selected disposable fixtures through an authorized, signed-in browser, wait for the selected
tab and required controls to render, reproduce native results in two independently opened forms and compare every
result exactly.

| Probe                                                 | Captures                                                                                                                                                                                                 |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `captureModelDrivenContract(input, form)`             | Attribute, collection and event results without saving; restores values, required levels and submit modes                                                                                                |
| `captureModelDrivenControlContract(input, form)`      | Control options and invalid draft values; needs a disposable draft closed without saving                                                                                                                 |
| `captureModelDrivenPresentationContract(input, form)` | Labels and notifications on a disposable draft                                                                                                                                                           |
| `captureModelDrivenDirtyContract(input, form)`        | Dirty state after authored value changes on a disposable draft                                                                                                                                           |
| `capturePowerPagesControlContract(input)`             | Selected DOM controls and authored draft feedback on a rendered form                                                                                                                                     |
| `capturePowerPagesClientContract(input)`              | Form metadata through the native client API; `readyTimeoutMs` (positive integer) bounds the wait, else the test timeout does; a missed bound rejects with `Power Pages API readiness deadline exceeded.` |
| `captureCanvasDraftInputContract(adapter, fixture)`   | An authored open/edit/cancel/discard flow through an explicit UI adapter; bind both the installed app source and the native input plan                                                                   |
| `captureCodeAppContextContract(api, input)`           | Selected typed host relationships and authored query fields                                                                                                                                              |
| `captureCodeAppContextCacheContract(api)`             | Identity of the resolved context object; restores its query mutation                                                                                                                                     |
| `captureWebApiInputContract(input)`                   | Typed-input and binding cases sent through a supplied request adapter                                                                                                                                    |

`webApiInputContractCases()` returns the invented `{ id, field, value }` cases that `captureWebApiInputContract` sends as
PATCH bodies; `webApiScalarReaderCases()` returns invented `[field, literal, expected error text]` tuples for the OData
scalar reader's conversion errors.

- Keep new-form defaults distinct from saved-record baselines. Getter results do not show which columns were
  submitted: qualifying save modes needs a separate authorized disposable-record flow that checks server readbacks and
  backend update targets (including a second save of a clean form), then deletes the owned records and verifies they
  are gone.
- Power Pages probes neither submit forms nor record visitor identity. Capture current native FormXml and form script
  readbacks; a stale export fails qualification. For Liquid, publish only owned fixture templates, read every source
  back, require HTTP 200 and all output markers, repeat the native page load and compare literal fragments; keep
  include-template context and site `observed` settings in local replay. A sign-in response, missing marker or failed
  readback is a failed capture.
- A pure Power Fx evaluator does not establish Canvas player behavior. SDK runs against an invented bridge prove SDK
  behavior only; native code app context needs a published-player capture.
- For Web API cases keep portal and Dataverse routes, identity, permissions and pipeline hooks explicit; inspect
  response bodies and independent persistence readbacks, and isolate recording-hook failures before treating them as
  platform behavior.
- Restore or document owned components, close only the tabs and runtimes the recorder started, and keep raw captures,
  plans, screenshots, environment identities and restoration journals in the project's ignored evidence directory.
  Public fixtures use invented schemas and values. A `parity` tag needs replay cases built from these captures.
