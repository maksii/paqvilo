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
(`--origin`; `parity-suite` can take it from the catalogue site instead). `parity-suite`'s anonymous core scenarios
run in the runner's own headless browser, with or without `--cdp` (`--anonymous-browser owned`, the default);
signed-in comparisons come from scenarios that packs or `--scenarios` add, so a catalogue without them lists only core
scenarios. A `--scenarios` file replaces the core set unless `--core` is also given. `parity-suite --list --config
<catalogue> --site <site>` prints each scenario's ID, tags and title, tab-separated; `--only` takes those IDs, and an
unknown ID is refused with exit status 2 before any browser or network work. Argument and path errors (for example
`Missing --out.` with the usage, or `--scenarios file not found: <path>. Pass an existing file.`) print verbatim with
exit status 1.

A scenarios file is a version 1 plan: `scenarios` entries with `id`, `kind` (such as `page-text`, `page-dom`,
`api-json` or `liquid-probe`), `identity` (`signed-in` or `anonymous`), `path`, `tags` and `title`, and an optional
`persona` with a `probe` (`path`, `selector`, default `#userroles`) and `accessChecks` (`path`, `rolesAny`). Signed-in
scenarios need `--cdp` and a local contact: `--persona-contact` or `persona.contactId` names a contact in the local
state, otherwise the run stops with `Persona mirroring needs a local synthetic contact`. With a `persona`, the run reads
the rendered `{{ user.roles }}` value from the probe element, segments it against the exported web-role names, checks
each access path, then signs the local contact in with those roles; the report's `persona` records the roles,
`accessChecks`, `consistent` and the local session (`session: override`).

| Command            | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `parity-suite`     | Route, persona and scenario comparison of a local runtime (`--local`, `--source` or `--site`) with the reference; writes reports under `--out`.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `reference-parity` | `--plan FILE` is a list of read contracts (`id`, `path`, `kind` `json` or `text`, `collection`, `fields`, `unordered`, `expectedStatus` (default 200), `expectedCount`, `prefer` (`odata.maxpagesize=N` only), `statusOnly`); each is fetched with GET from the reference and from `--local` as a local visitor (`--local-contact`, `--local-role`, `--local-configured-persona`). Writes `reference-parity.json` under `--output`; exit 1 when a contract fails.                                                                                            |
| `verify`           | Compares one page (`--path`, default `/`) by semantic DOM and screenshot pixels; writes `report.json`, `live.png`, `local.png`, the DOM files and `difference.png` under `--output` and prints the report; exit 1 unless it passes. A failure is one line in `differences`; a longer message is kept in `error.txt`.                                                                                                                                                                                                                                         |
| `enrich-reference` | `--plan FILE` is a JSON array of 1 to 100 `{ entity, fetchXml, pageSize?, maxPages?, mode? }` reads: non-aggregate FetchXML without `top`, each table once, `pageSize` at most 5000 (default 5000), `maxPages` at most 100 (default 10), `mode` `merge` (default) or `replace`. Rows are read from the reference into the existing `--state` file; the runtime using that state must be stopped. A read that needs more than `maxPages` pages fails with `FetchXML continuation exceeded the bounded page limit.`; filter the FetchXML to the rows you need. |
| `baseline-suite`   | The native component baseline; see its [runbook](baseline/rerun.md).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

Use a signed-in Lense `dev` session started with `--no-overrides` and a free `--debug-port`, and confirm the port in
`agent status`. Without `--no-overrides` Lense also overlays local sources on the tabs the tools open (its log lists
local files for those pages), so the reference is no longer the site as served; `acceptance` navigation steps still
read the document status (HTTP 200) through such a session. Lense repairs the first document of each new tab with one
GET, so a reference page can list aborted requests (`net::ERR_ABORTED`) from that first load. When nothing answers at
`--cdp`, every tool reports `Could not connect to the loopback browser debugging endpoint. Confirm its port and
availability.`: `reference-parity` and `enrich-reference` stop with it, `verify` writes it as its one `differences` line
and `acceptance` as its report's `error`; all exit 1. `acceptance --cdp` accepts only loopback `http:` and `ws:` URLs:
another scheme is refused with `Use a loopback browser debugging endpoint.` and a non-loopback host with `Local
simulator and browser debugging addresses must use loopback without credentials.`; `verify` refuses both with `Browser
debugging endpoint must be loopback without credentials.` A private reference answers the
anonymous core scenarios with its sign-in redirect (HTTP 302) while Mirage renders the page, so they report
runtime-gap deltas, not parity. Plans and route guards reject writes and forbidden actions, but navigating and reading
the environment still needs authorization. `verify` lists refused writes in `live.blockedWrites` (for example a
native telemetry POST) and `acceptance` in `blockedRequests` and `writes`. Direct reads (stylesheets, snippet pages,
`reference-parity` contracts, `enrich-reference` pages and the antiforgery token from `/_layout/tokenhtml`) use the
browser's cookies but no page, so they appear in neither the Lense agent events nor the browser's network log; pages a
tool opens appear in the agent events as new pages. Bearer tokens and credentials are never stored; query values are
redacted in reports.

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
screenshot is not coverage. Cite the project's retained comparison when you claim a behaviour matches live.

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

`webApiInputContractCases()` returns the invented `{ id, field, value }` cases that `captureWebApiInputContract` sends
as PATCH bodies; `webApiScalarReaderCases()` returns invented `[field, literal, expected error text]` tuples for the
OData scalar reader's conversion errors.

- Keep new-form defaults distinct from saved-record baselines. Getter results do not show which columns were
  submitted: qualifying save modes needs a separate authorized disposable-record flow that checks server readbacks and
  backend update targets (including a second save of a clean form), then deletes the owned records and verifies they
  are gone.
- Power Pages probes neither submit forms nor record visitor identity. Capture current native FormXml and form script
  readbacks; a stale export fails qualification. For Liquid, publish only owned fixture templates, read every source
  back, require HTTP 200 and all output markers, repeat the native page load and compare literal fragments; keep
  include-template context and site `observed` settings in local replay. A sign-in response, missing marker or failed
  readback is a failed capture.
- A pure Power Fx evaluator does not establish Canvas player behaviour. SDK runs against an invented bridge prove SDK
  behaviour only; native code app context needs a published-player capture.
- For Web API cases keep portal and Dataverse routes, identity, permissions and pipeline hooks explicit; inspect
  response bodies and independent persistence readbacks, and isolate recording-hook failures before treating them as
  platform behaviour.
- Restore or document owned components, close only the tabs and runtimes the recorder started, and keep raw captures,
  plans, screenshots, environment identities and restoration journals in the project's ignored evidence directory.
  Public fixtures use invented schemas and values. A `parity` tag needs replay cases built from these captures.
