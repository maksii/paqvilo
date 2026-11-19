# Lense

![Lense: local source changes previewed in a live portal browser.](assets/lense-visual.png)

Lense lays local JavaScript, CSS, images and supported literal HTML edits from a Power Pages export over a live site in
a dedicated browser. The online backend still runs Liquid and Dataverse; Lense does not deploy, upload or run PAC.
Browser actions use the live site and can affect live data.

For model-driven apps, the
[Solution resource overlay mode](../mirage/docs/model-driven-customizations.md#preview-the-same-code-with-lense) maps
exported JavaScript, PCF bundles and styles to the environment's observed resource paths with the same panel, X-ray,
reload and agent/debugger workflow; its [Actions tab](model-driven-actions.md) adds native inspection and form tools.
Installation and a first catalogue are in [getting started](getting-started.md); settings are in
[configuration](configuration.md).

## Your edit-preview loop

```sh
npx --no-install paqvilo lense doctor --config ./paqvilo.config.yml --site portal --env dev
npx --no-install paqvilo lense dev --config ./paqvilo.config.yml --site portal --env dev
```

1. On the first run, sign in through the portal's own sign-in action with the intended account. The dedicated profile
   keeps that sign-in for later runs ([which browser profile](#which-browser-profile)).
2. Open the panel with **Alt+Shift+P** and check the selected site and environment.
3. Save a supported local change. Affected pages reload; CSS can hot-swap.
4. Check applied resources, **Issues** and failed requests; switch **Online / Local** to compare.

Close the dedicated browser or press Ctrl+C to end the session.

| Change                                                    | What to expect                                                        |
| --------------------------------------------------------- | --------------------------------------------------------------------- |
| JavaScript, CSS or an image                               | Response overlays from discovered source mappings                     |
| Supported literal HTML or inline fields                   | Baseline patches where the match is unambiguous                       |
| Liquid logic, server-side settings or Dataverse behaviour | Still evaluated by the online portal; deploy through your own process |
| Server-side rendering with local data                     | Use [Mirage](../mirage/README.md)                                     |

**Issues** lists changes that need deployment, including a changed source whose inline or markup preview is disabled. A
reload alone does not mean an edit was applied.

### Session behaviour

- The dedicated profile keeps the portal's cookies in `<profile>.session.<hash>.json` beside the profile folder, one
  file per set of portal hosts. Only cookies of those hosts are kept (identity providers on other hosts are not), and
  Mirage staff-selection cookies never are. Removing a profile means deleting its folder and its `.session.*.json`
  files.
- A new tab can load before interception attaches. Lense then repairs a clean initial document with one GET, never
  replaying a form submission. Edited controls or rich-text edits keep the document and raise a reload-needed warning.
  An older repair never replaces a newer navigation.
- Startup reports configuration, source discovery, process ownership, browser/interception setup, document navigation
  and initial requests, with a five-second heartbeat and command-total and per-phase times. A failure names its phase. A
  listening runtime or loaded document does not prove the application is ready: page scripts, sign-in and later requests
  can still be pending. Native model-driven overlays finish startup at document load; Mirage model-driven dev also waits
  for the catalogue, staff identity and initial view.
- `--startup-timeout` (mirage start/dev, model-driven dev; default 120000 ms) is the longest silence without startup
  progress; each progress record and the runtime's discovery file restart it, and 600000 ms is an absolute cap. Source
  discovery and ownership checks run before the runtime starts and count against the same value as a total.
  `mirage start --json` prints its result on stdout and startup events on stderr. Ctrl+C stops pending startup and the
  owned runtime.
- If interception cannot be installed on a newly opened tab, only that owned tab closes (an attached browser shows a
  local failure page). Other tabs, drafts, watchers and agent endpoints keep working; open a fresh tab to retry. Losing
  the shared browser connection ends the session.
- Interactive dev leaves `alert`, `confirm`, `prompt` and before-unload dialogs to the user. Owned headless dev
  dismisses alerts, confirms and prompts and accepts before-unload so navigation completes. Each dialog's type, redacted
  message and disposition appear in Activity and agent events. Attached browsers keep control of their dialogs.
- Target selection in the panel commits only on Go or Enter. Leaving a local runtime for a live target, or opening a
  `caution` environment, needs an in-panel confirmation; Cancel or a failed switch restores the current target. UI state
  is per browser profile (in memory for a CDP attachment without a known profile). Automated headless sessions start
  collapsed.

### Which browser profile

`dev`, `verify --signed-in` and `model-driven dev` choose the browser the same way (catalogue keys in
[configuration](configuration.md)). `lense list --site <site> --env <env>` prints the choice for that selection as
`browser profile:` and `user-data root`; `dev` repeats it on its `browser` line.

| Option                                                 | Browser                                                                                 |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------- |
| none                                                   | The target's toolkit profile, `<profiles>/<site>-<env>`, isolated from your own browser |
| `--profile <name>`                                     | A named toolkit profile, `<profiles>/named/<channel>/<name>`                            |
| `--user-data-dir <root>` + `--profile-directory <dir>` | An existing profile; `<root>` is the parent of the Profile Path in `edge://version`     |
| `--cdp-url <endpoint>`                                 | A browser you started with a debugging endpoint; Lense attaches to it                   |

`<profiles>` is `browser.profileDir`, by default `.paqvilo/profiles` beside the catalogue (Chrome and Chromium use a
`default/<channel>/` subfolder).

- Toolkit and named profiles are persistent. A new one starts anonymous: sign in once in the headed Lense window through
  the portal's own sign-in. Lense keeps the portal's cookies in the session file beside the profile folder, so every
  later `dev` or `verify --signed-in` that resolves to the same profile starts signed in, headless runs included. Only
  one browser can use a profile at a time: stop the running session (Ctrl+C or `agent stop`) before another run.
- The profile folder is resolved from the catalogue's location. A catalogue in another folder, such as a scratch copy
  pointing at other sources, gets a new anonymous profile; to reuse a signed-in one, set `browser.profileDir` to the
  folder that holds it and keep the same site and environment names.
- An existing profile is left entirely to the browser: Lense neither restores nor saves a portal session file for it.
  Pointing `--user-data-dir` at a toolkit profile folder therefore does not carry its portal sign-in, even when the
  identity provider still signs the browser in to a private site.
- With an existing profile Lense launches the browser itself, so nothing else may be running on that user-data root;
  otherwise it stops with "the browser profile ... is in use or could not start". Edge's normal user-data directory is
  refused before anything starts ("Edge cannot be automated through launch flags in its normal user-data directory"),
  so an everyday Edge profile can only be used by attaching. A missing root fails with "Existing browser user-data
  directory not found", a missing child with "Existing browser profile directory not found" (`--profile-directory`
  defaults to `Default`). `lense doctor` does not check these values.
- `--cdp-url` accepts an `http`, `https`, `ws` or `wss` endpoint; one that does not answer fails with "Cannot attach to
  the --cdp-url browser debugging endpoint". An attached browser stays yours: when Lense stops it detaches and leaves
  the browser and its debugging endpoint running. `--debug-port` cannot be combined with `--cdp-url`; attach your
  debugger to the browser's own endpoint.

## Commands

Run `npx --no-install paqvilo lense --help` for every option; [command-line usage](cli.md) covers output streams and
exit status.

| Command                | Purpose                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------ |
| `list`, `use`          | Show targets and settings in effect; remember a site/environment in `.env`                 |
| `doctor`               | Check configuration, source mapping, Solution inputs and baseline offline                  |
| `map`, `resources`     | Online-to-local mappings; editable source descriptors and metadata relationships (offline) |
| `audit --all --strict` | Inventory export code independently and expose blocked or unaccounted resources            |
| `analyze`              | [Offline source analysis](static-analysis.md)                                              |
| `dev`                  | Dedicated browser with local overlays, watching saves                                      |
| `status`               | Compare local web files with what the environment serves to an anonymous request           |
| `verify`               | Edit a disposable copy and check the browser applies supported changes                     |
| `agent`                | Inspect and control a running owned browser ([reference](#agent-api-reference))            |
| `model-driven`         | `inspect` or `dev` (default) of exported Solution web resources and mapped PCF bundles     |
| `mirage`               | `init`, `start`, `dev`, `status`, `inspect`, `stop` of local [Mirage](../mirage/README.md) |

- `doctor --all --mirage --json` gates on Lense, Sources and Mirage readiness. Without `--mirage` the exit status covers
  Lense only and source diagnostics stay warnings; each site line names all three states. Duplicate exported YAML keys
  fail Sources. `--lint-profiles` also scans every exported `deployment-profiles` directory for JSON/YAML syntax errors
  (`profileDiagnostics`: file, parser code, line, column, bound flag); these are warnings.
- `dev --no-overrides` shows the environment as served, for reference captures. `--scope changed` overlays only files
  that differ from the baseline.
- `map --check` and `status` request every mapped web file anonymously, without the dev profile's sign-in (even when
  that profile is signed in) and without following redirects. A private site redirects each one to sign-in
  (`redirect (HTTP 302)`); both commands then report the check as incomplete and exit 1. For a private site, check
  signed-in application in a `dev` session (agent `state` and `events`) or with `verify --signed-in`.
- `map --no-write --json` returns the mapping without writing reports. `resources` distinguishes `exists`, `empty` and
  `renders` for optional enhanced fields; duplicate active page URLs and overwritten YAML records are diagnosed.
  Resource IDs from `resources` differ from agent page IDs.
- `audit` coverage is source classification, not proof of navigation or browser application.
- `verify --signed-in` reuses the dev profile and its sign-in: close that dev session first. When the profile is already
  signed in it also runs headless; add `--headed` when a sign-in may still be needed and bound it with
  `--sign-in-timeout` (1–900000 ms, default 900000). Each check reports `ok` `true`, `false` or `null` (skipped, with
  the reason in `detail`, such as a page without an image web file); a run with skips passes with coverage `partial`.
  The report also names `inlineBaseline`, diagnostics before and after the edits, and `cleanup`
  (`temporarySourceRemoved`). A sign-in page is never counted as target coverage: an anonymous
  run on a private page fails with `<path> needs a sign-in (ended on <sign-in URL>)` and prints the rerun command with
  `--headed --signed-in`, and a missed deadline fails with `Sign-in did not complete within the configured deadline`.
  Both report `errorCode` `VERIFY_FAILED`, coverage `incomplete` and exit status 1 after removing the temporary copy.
  An interrupt (Ctrl+C, SIGINT, SIGTERM) ends the run with `errorCode` `VERIFY_INTERRUPTED` and exit status 1 after
  closing the panel, interception, watcher and browser and removing the temporary copy (kept when `PAQVILO_KEEP_TEMP`
  is set). A second signal is absorbed; a third writes `Forced exit: cleanup did not finish.` and exits 130 (SIGINT) or
  143 (SIGTERM).
- `mirage start` refuses settings that differ from a live runtime owning the same state file, naming its pid and file;
  stop it or pass `--state <other file>`. A runtime recorded on another host (Windows and WSL, or runners sharing a
  checkout) is never listed, selected, pruned or signalled here, and a start on its state file is refused; when that
  host no longer runs it, delete its entry from the ownership file the message names. `mirage stop` exits 2 only for a
  selected runtime of this host it could not verify. `mirage status` and `mirage stop` select runtimes by the
  [scoping rule](../mirage/docs/toolkit-integration.md#which-runtimes-status-and-stop-select). If `mirage dev` is
  killed instead of closed, its browser closes but the runtimes it started keep running: `mirage status` lists them and
  `mirage stop` stops them. Each `mirage` action accepts only the options its `--help` lists; another fails with
  `--<option> is not supported by mirage <action>`. Interactive `mirage dev` rejects `--json`; use `start` plus the
  agent API for automation.

### JSON envelope

Lense `--json` output is `{ schemaVersion, command, ok, offline, writesFiles, errors }`, where `writesFiles` lists files
actually written and `errors` holds `{ code, message }` objects; a failure also carries its primary error as `error`.
Generic codes are `invalid_argument`, `unsupported_option`, `unknown_command`, `configuration_error`, `command_failed`
and `check_failed`; strict inventory failures use `strict_failed` with blocked/gap counts. `status` and Mirage
`status`/`start`/`stop` set `offline: false`; `status --json` fails when a comparison is incomplete. `verify --json`
reports its result after cleanup. `mirage init` names its project file, writes `--solution-root` as its Solution roots
and carries `--state`, `--port`, `--preset` and `--preset-mode` into the `dev` command it prints; `start` names state,
discovery, ownership and startup log files; `stop` names the updated ownership file and reports removed discoveries
separately. `lense mirage inspect` is offline and writes nothing.

## Source mapping and comparison scope

JavaScript, CSS, images and inline fields map from discovered export metadata; literal markup uses baseline patches and
rejects ambiguous matches. Enhanced XML and code-bearing YAML fields are edited through their discovered field/JSON
descriptors: [`lense/source-edit.mjs`](../lense/source-edit.mjs) preserves sibling values and rejects stale identity or
paths outside the export.

HEAD is pinned as the baseline when a target activates, so a later commit does not erase it; an explicit `--baseline`
ref stays explicit. The panel reports Git drift and can pin a fresh HEAD. Create the initial source commit before
previewing literal markup; this local baseline does not identify the deployed commit. Shared sources reload the affected
portal's tabs, page sources that page. Pausing reload preserves an unsaved form while saves accumulate.

Panel keys: **Alt+Shift+P** panel, **Alt+Shift+L** hide/show, **Alt+Shift+O** Online/Local, **Alt+Shift+X** X-ray.
**Inspect** works for live and Mirage sessions; **Tweaks** changes local Mirage identity and scenarios. Targets stay
isolated by origin, environment and source selection.

In **Inspect**, **Page & templates** covers page copy, scripts, styles and template dependencies; **Forms & controls**
joins exported forms, lists, views and fields to rendered controls; **Select an element** picks a node without
activating it. **Tables & access** shows exported permissions, scopes, relationships and web roles; an exported grant
does not prove the signed-in user can use it.

With only a portal export, Inspect resolves portal components, snippets, web files and access rules. Add
`mirage.solutionRoots` or `mirage.project` to resolve Solution FormXml, views, table fields, PCF manifests/resources and
literal dataset bindings (live Lense reads them without starting Mirage). Table rows also show exported plug-in
registrations (message, stage, rank, filtering columns, type, assembly) and open their XML or
[mapped C# source](../mirage/docs/dataverse-plugins.md); they do not establish which assembly is deployed. **Refresh
inspection** rereads the sources.

### Selection evidence

The panel and X-ray show one evidence summary. **Owner** is the component established for the selected node; **Local
source** is the admitted source reference. Each has its own state: **Exact**, **Candidate**, **Conflicting**,
**Unavailable** or **Stale**. An exact owner can have an unavailable or stale source, and local matching never
establishes the deployed revision. **Enclosing components** shows containment, **Context** observed facts,
**Alternatives** other possible matches, and **Limits & freshness** incomplete searches. A declared dependency, matching
selector or top-ranked candidate does not prove ownership; **Served**, **Execution observed** and **Mount observed** are
separate for assets.

Rules that decide attribution:

- **Power Pages fields** read **column → Solution form (FormXml) → table → basic form → host webpage**; each level keeps
  its own state, the host page is context only, and a missing definition stays unavailable rather than borrowed from
  another form or table with the same field name.
- **Native list/subgrid modals** with an all-zero layout form ID resolve through the same-origin `data-page` frame,
  modal action class, an independently identified opener (a rendered list or subgrid ID, or a referenced list whose view
  matches the grid) and its exported action form. Only a unique consistent join sets the form; otherwise the rendered
  table and the declared action forms on it stay candidates. An all-zero form ID never identifies a form by itself; a
  unique verified basic-form wrapper can.
- **Script-created elements** link to local code through an observed callsite, labelled **creation**, **clone** or
  **attachment**, only when the acknowledged response bytes and the parsed script version agree. Anonymous evaluation,
  custom stack formatting and ambiguous versions stay unavailable.
- **Custom grids** declare bindings with `data-paqvilo-table="logical_table"` on the table and
  `data-paqvilo-column="logical_column"` on cells or headers; DataTables column `name` (`sName`) is read without running
  renderers. A scroll-head clone can point at its grid with `data-paqvilo-grid="original-table-id"` and
  `data-dt-column`. A unique declared pair joined to an exported column gives its **definition** source, not the
  renderer or record. Nothing is inferred from API requests, cell contents, neighbouring grids or the containing form.
- **Frames**: accessible same-origin frames (nested, inserted or navigated later) and modal iframes are inspected with
  their own form and table context. Native quick-view iframes join a verified parent form and that control's QuickForms
  target. Rich-text editor frames inherit a field binding from attribute-scoped hosts (`<logical_column>_ControlView`,
  `<logical_column>_Container`) joined to a verified form, up to 16 frame levels or 256 ancestors. Cross-origin and
  sandboxed frames and closed shadow roots are boundaries; URL parameters are context, never proof.
- **Code components** link FormXml properties and bound columns to manifests and portal settings, distinguish the
  desktop control from other form factors, and report portal enablement separately. Constructor and mount details appear
  only when observed.
- Field identifiers are checked against the selected export and table context; ambiguous matches stay candidates.
  Matching uses static IDs, classes and component attributes, not positional DOM paths. Classes are weighted by rarity,
  so common framework classes stay candidates. Static Liquid matching cannot prove which branch rendered.

**Open source** and **Open candidate** recheck the selected node, source identity and revisions before opening; stale,
conflicting and unavailable actions are disabled. Saving the file while the browser check is pending makes the action
stale: refresh inspection and select again. **Copy reference** copies the displayed reference; **Search export markup**
and **Browse file** are suggestions, not attribution. The inspector never reads input values or page text, and
notifications use opaque document, frame and anchor identifiers.

The picker keeps the selected node while X-ray is hidden; if the node is replaced, its frame navigates or its shadow
host disappears, the selection clears instead of moving to another element. **Clear selection** removes it explicitly.

#### X-ray

Toggle **◎ Lense X-ray** from Inspect, the panel header or **Alt+Shift+X** (also from inside an accessible same-origin
frame). Green outlines mark controls, blue form/view containers, amber source markup; colors identify layers, not
certainty. While Inspect mode is on, keyboard and pointer activation is intercepted in the page, accessible same-origin
frames and open shadow roots; hold **Ctrl** or switch to **Interact** to use the portal. When focus moves into a
cross-origin or sandboxed frame, X-ray reclaims it one task later, so one keystroke can reach that frame.

The details card opens beside the picked element (right of it, else left, below or above), inside the window and
above the legend, and follows it on scroll and resize; it covers the element only when no side has room. **⇄** or
dragging its header keeps it where you put it until the next pick. Card controls: **↑ Parent / ↓ Child**, **[ / ]** to
cycle overlapping elements, **Reveal**, **Details**, **Tab / Shift+Tab**, **Escape** (release, then exit). Context and
permission lists page eight entries at a time. X-ray is removed when the session detaches.

Limits: a markup source above 1,048,576 UTF-16 code units is skipped and reported; discovery and drawing stop at 800
candidate elements and 250 background outlines; details show up to 60 source matches. Selection still inspects the
element under the pointer. **Limits & freshness** reports omissions, and the agent API reports them in
`elementSourceLimits`. Inspection reports are cached until sources change; a refresh rescans source stamps and reimports
a changed export, so its time grows with export size.

## Automation and evidence

Projects with a [persona catalogue](../mirage/docs/persona-catalog.md) can search personas and scenarios in the panel.
Live Lense selection uses the portal's own sign-in flow; it never issues native tokens for a synthetic contact. In
Mirage, scenarios open isolated local setups. **Apply scenario** asks for confirmation in the panel. Keep live identity
mappings and scenario tests in the project.

Agent discovery files contain bearer tokens and stay under ignored `.paqvilo/agents`; never print or share them. A
session removes its file when it stops or its process ends on SIGINT, SIGTERM or SIGHUP. A file left by a killed process
names its owner process: agent commands reject it as `session_stale` without contacting its endpoint, `agent sessions`
lists it as unreachable, and the next session start in that state folder removes it.

After a refresh, inspect applied resources, unmatched markup patches, deployment requirements, errors and failed
requests. Contributors can measure X-ray latency on synthetic exports with
`node scripts/benchmark-xray.mjs --samples 3 --strict --json` in a toolkit checkout.

## Agent API reference

`paqvilo lense agent <action> --json` (the action defaults to `sessions`; output is always JSON). Every action except
`sessions` needs `--session <discovery file>`; `state`, `snapshot`, `screenshot`, `viewport`, `navigate` and `reload`
also need `--page-id` from `agent pages`. The API is confined to the session's portal origin and has no evaluation,
form-action or proxy endpoint. Agent envelopes add `action` to the [JSON envelope](#json-envelope).

`--timeout` (2000–120000 ms, default 35000) is the action deadline sent to the server; the client waits 30000 ms longer
before reporting `request_timeout`. The server bounds snapshot, screenshot and viewport by the same value (default 60000
ms when absent, at most 120000 ms) and navigate and reload at most 60000 ms (default 30000 ms); a timed-out navigation
is stopped.

### agent sessions

Optional `--config` selects the state folder (`.paqvilo` beside the catalogue, else `.paqvilo` in the working directory)
and lists its `agents/` discovery files. Probes at most 64 discovery files, four at a time, each within `--timeout`.
Returns `sessions` (`id`, `pid`, `site`, `environment`, `startedAt`, `portalOrigin`, `sourceDir`, `discoveryFile`,
`reachable`, `error`), `invalidFiles` and `truncated`; never tokens.

### agent status

Returns the session (without token), readiness, browser scope, access counts, debugger port, baseline, Git state,
overlay, pages and truncation flags. While the tab is away from the portal origin (for example on the sign-in page)
`pages` is empty, `access.externalTabCount` counts the tab and page routes for it answer `404 page_not_found`. A
[model-driven](model-driven-actions.md#targets-and-agent-sessions) session instead reports `inspection.suspended: true`
and answers `409 session_suspended`. A model-driven status has no access counts, baseline or Git state; it reports
`kind`, `browserScope`, `overlay` (revision, applied counts and resources) and `inspection`.

### agent pages

Returns pages with `id` (a numeric string, passed as `--page-id`), `documentId`, sanitized URL, viewport,
`reloadAllowed` and `documentMethod`. Closed and foreign-origin pages are excluded.

### agent events

`--after` (sequence, default 0) and `--limit` (1–500, default 100). Returns `sessionId`, `events`, `oldestSequence`,
`latestSequence`, `nextSequence`, `dropped`, `hasMore` and `cursorAhead`. Continue from `nextSequence` and check
`dropped`/`hasMore`; a cursor ahead of `latestSequence` sets `cursorAhead` and resets `nextSequence`. Compare
`sessionId` before reusing a cursor. The server keeps 500 events or 1 MiB, whichever is reached first.

### agent state

Returns page, overlay, resources, diagnostics, runtime (the document's last 100 page errors, console messages and failed
requests, with event retention) and limits for the current document. Lists stop at 200 items with truncation flags. A
model-driven session returns the overlay revision, applied counts, resources, diagnostics, problems, the exported form
catalogue, native context and runtime instead of the `overlay` and `limits` objects.

### agent snapshot

`--selector` (CSS, at most 1,000 characters), `--limit` (1–200, default 100), `--styles` (comma list, at most 20
computed properties). Returns sanitized URL, title, total, truncated and elements with tag, bounded attributes/text,
visibility, rect and style. Field values are never copied. An invalid selector returns `invalid_selector` (400).

### agent screenshot

`--output <new.png>` (required), `--full-page`, `--include-panel`. Returns `path` and `bytes`; `writesFiles` names the
PNG. Paths are forward-slash and relative to the catalogue directory (or working directory without `--config`), keeping
`../` segments outside it and only the file name on another volume. An existing file is never overwritten
(`invalid_argument`). Images are limited to 8 megapixels, 8,192 pixels per side and 8 MiB (`image_too_large`).

### agent viewport

`--width` (320–4096, default 1440), `--height` (240–4096, default 900). Returns page and viewport.

### agent navigate

`--path <portal path>` (required). Performs a GET on the portal origin and returns page and HTTP status. Other origins
return `foreign_origin`; a redirect off the origin returns `origin_changed`; a browser timeout returns `action_timeout`
(504).

### agent reload

Returns page and status. Only an observed GET document with no pending navigation can reload; unknown, restored-history
and POST documents return `unsafe_reload` (409). Reload issues an explicit GET so a form post is never repeated.

### agent stop

Returns `stopping: true`. Targets that share one toolkit-owned browser stop together: the browser closes and every
associated discovery file is removed. Other sessions and attached user-owned browsers are not touched.

### Agent error codes

Client: `session_not_found` (no discovery file), `session_stale` (owner process gone), `invalid_session`,
`session_unavailable`, `request_timeout`, `invalid_response`, `response_too_large`, plus the generic CLI codes. Server:
`invalid_argument`, `invalid_selector`, `invalid_json`, `invalid_url`, `body_too_large`, `content_type`, `unauthorized`,
`browser_request`, `foreign_origin`, `origin_changed`, `not_found`, `page_not_found`, `method_not_allowed`, `page_busy`,
`session_busy`, `session_suspended`, `unsafe_reload`, `image_too_large`, `response_too_large`, `action_timeout`,
`action_failed` and `stopping`. HTTP failures keep their status in the error object; messages omit browser stacks, ANSI
controls and call logs.

## Local source debugging

Mirage appends file-backed source maps to served JavaScript and CSS (including extensionless payloads of those types and
model-driven Solution client resources). Page, template, list and form custom JavaScript carries its export `sourceURL`
and a line-offset map; inline blocks get stable `?inline=N` URLs whose maps point at the export file. Attach VS Code to
the port of `paqvilo mirage dev --debug-port 9222`:

```json
{
  "type": "msedge",
  "request": "attach",
  "name": "Paqvilo Mirage",
  "port": 9222,
  "resolveSourceMapLocations": ["**", "!**/node_modules/**"]
}
```

The maps contain absolute file URLs, so no `pathMapping` is needed; set breakpoints in the export files. Sidecar files
and YAML literal blocks keep their lines; folded or escaped fields and enhanced XML/JSON get a `sourceURL` only. Liquid
that changes line counts shifts later locations: the debugger shows rendered JavaScript, not Liquid execution.

For byte-for-byte asset comparisons set `mirage.sourceMaps: false` (or `sourceMaps: false` in a Mirage project) and
restart. The top-level `sourceMaps` and `PAQVILO_SOURCE_MAPS` control Lense overlays separately. For a panel attached to
a standalone local app see
[model-driven debugging](../mirage/docs/model-driven-customizations.md#pair-the-panel-with-a-standalone-local-app).
