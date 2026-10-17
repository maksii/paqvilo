# Lense

![Lense: local source changes previewed in a live portal browser.](assets/lense-visual.png)

Lense provides Power Pages-aware resource overrides for pro-code development. Preview local JavaScript, CSS, images and supported literal HTML edits on a live site; the online backend continues to run Liquid and Dataverse.

If you use Fiddler AutoResponder or browser DevTools Local Overrides, Lense adds export-based mappings, record and field identity, Git baseline comparisons and live reload. See the [workflow comparison](../README.md#beyond-fiddler-and-devtools-overrides).

For installation and a first catalogue, follow [getting started](getting-started.md). The examples here run from your portal project with Paqvilo already installed.

## Your edit-preview loop

```sh
# Check the selected target and source mapping offline:
npx --no-install paqvilo lense doctor --config ./paqvilo.config.yml --site portal --env dev

# Open the configured online environment with local overlays:
npx --no-install paqvilo lense dev --config ./paqvilo.config.yml --site portal --env dev
```

1. Sign in through the portal's own sign-in action with your intended account.
2. Open the panel with **Alt+Shift+P** and check the selected site and environment.
3. Save a supported local change. Relevant pages refresh; CSS can hot-swap.
4. Inspect applied resources, diagnostics and failed requests, then switch **Online / Local** to compare responses.

Close the dedicated browser or use Ctrl+C to end the dev session. Browser interactions use the online backend and can affect live data; use authorized environments and actions.

## What can I preview?

| Change | What to expect |
| --- | --- |
| JavaScript, CSS or an image | Browser response overlays from discovered source mappings |
| Supported literal HTML or inline fields | Baseline patches where the match is unambiguous |
| Liquid logic, server-side settings or Dataverse behavior | Still evaluated by the online portal; use your separate deployment process where needed |
| Exported server-side rendering with local data | Use [Mirage](../mirage/README.md) to explore supported local simulation |

## Commands at a glance

Run `npx --no-install paqvilo lense --help` for the full command/options reference.
`paqvilo lense doctor --all --mirage --json` gates on Lense, Sources and Mirage readiness.
Duplicate exported YAML keys fail the Sources check without changing the Lense verdict.
Without `--mirage` its exit status covers Lense; source diagnostics remain warnings, and each site line names all three states.
Deployment profile lines list each file relative to the catalogue and its parse readiness.
Setup's Git badges scope tracked changes to each source folder and report unavailable or
timed-out status separately from a checkout without commits.

| Command | Purpose |
| --- | --- |
| `list`, `use` | Inspect available targets and remember a personal site/environment |
| `doctor` | Check configuration, source mapping, Solution inputs and baseline offline |
| `map`, `resources` | Discover online-to-local mappings and editable source descriptors |
| `audit --all --strict` | Independently inventory exports and expose blocked or unaccounted code |
| `dev` | Open a dedicated browser, apply local overlays and watch saves |
| `status` | Compare local resources with authenticated online responses |
| `verify` | Edit a disposable copy and check the browser applies supported changes |
| `agent` | Inspect and control a running owned browser through the bounded authenticated API |

## Source mapping and comparison scope

JavaScript, CSS, images and supported inline fields map from discovered export metadata. Literal markup uses baseline patches and rejects ambiguous matches. Lense does not evaluate Liquid locally or apply server-side portal settings. Enhanced XML and code-bearing YAML fields are edited using their discovered field/JSON descriptors; `source-edit.mjs` preserves sibling values and rejects stale identity or paths outside the source extract.

The default scope overlays every local source. `--scope changed` limits overlays to changes since the captured baseline. HEAD is pinned when a target activates; committing later does not erase the baseline. Explicit deployment refs remain explicit. The panel reports Git drift and can pin a fresh HEAD. Shared sources refresh the affected portal's tabs; page sources affect that page; CSS can hot-swap. Pausing reload preserves an unsaved form while saves accumulate.

Create the initial source commit before previewing literal markup. The [setup instructions](getting-started.md#4-preview-live-with-lense) cover a new export; this local baseline does not identify a deployed commit.

The panel's **Online / Local** switch compares the browser's responses. **Alt+Shift+P** opens the panel. **Inspect** is available for live and Mirage sessions. **Tweaks** changes local Mirage identity and scenarios. Independent targets stay isolated by origin, environment and source selection.

In **Inspect**, start with **Page & templates** to open the page copy, JavaScript, CSS and template include chain. **Forms & controls** connects exported forms, lists, views and fields with rendered controls. **Select an element** identifies a control and shows an exact field match when one is available; unmatched elements point you to the page sources. Source rows open files in your configured editor.

Use **◎ Lense X-ray** in Inspect, the panel header, or **Alt+Shift+X** to identify Power Pages sources in place. Hover shows the matching template, page source, form, view or Dataverse column; click keeps its details open. Green highlights identify controls, blue identifies form/view containers, and amber identifies source markup. The layer menu can limit highlights to forms/data, templates/content or the selection. Hold **Alt**, or switch to **Interact**, to use the portal; **Inspect** intercepts pointer activation, including over iframe boundaries. The inspector uses the existing Lense panel theme and does not modify portal styles or submit selected controls.

The movable card prioritizes source paths, markup matches, include context, basic forms and FormXml, selected views, tables and columns. **Open source** opens a source at its matching line; **Select source region** selects the enclosing markup that established the match. **Page context** and **Element & ancestry** are secondary disclosures. Use **↑ Parent / ↓ Child**, or cycle overlapping elements under the pointer with **[ / ]**. **Reveal** scrolls a selection into view; **Details** hides the card when it covers a target. **Escape** releases a selection, then exits X-ray. Refresh rereads sources and newly rendered component bindings. X-ray is temporary to the current document and is removed when the session detaches.

Field identifiers are checked against the selected export and explicit table context; ambiguous matches stay visible as candidates. Source matching uses static IDs, classes and component attributes without relying on positional DOM paths, so moved regions can keep their source identity. Multiple templates and conditional branches can share markup; matching candidates do not establish a deployed source revision. Related script references and page dependencies remain secondary to the selected element's sources. Iframe document contents remain unavailable. Native dialogs, nested overlays, open shadow roots, scrolling and source-driven DOM replacements are handled without silently transferring a removed selection to another element.

X-ray indexes markup hints across all referenced sources; it skips an individual markup source above 1,048,576 UTF-16 code units and reports that omission. Discovery and drawing remain bounded to 800 candidate elements and 250 background outlines. Details show up to 60 source matches with an omission notice. Large pages may show partial background coverage; selection still inspects the element under the pointer. Open shadow roots and slotted controls are supported, while closed roots and iframe contents are boundaries. Outline rectangles approximate complex clipping and rotated shapes. Static Liquid matching cannot prove a rendered branch. JavaScript reference extraction skips balanced template literals and resumes at a statement boundary after ambiguous slash syntax; computed selectors and template contents remain unqualified. It retains 120 unique script hints per source and reports truncation when it finds an additional reference. Missing exports and failed refreshes clear previous identities instead of presenting them as current evidence.

Native grids trace their selected views, relationships, action settings and modal forms. Quick views link to their FormXml. Observed Web API requests identify entity sets without collecting record IDs or query values; Solution metadata resolves their table bindings. Exported language routes select the corresponding page and snippet sources. Relative asset references follow their browser URL.

Native code components connect FormXml properties and bound columns to their manifests and portal attribute settings. Inspect distinguishes the selected desktop control from other form factors and reports explicit portal enablement separately from a model-driven default.

Table rows also expose exported Dataverse plugin registrations: message, stage, rank, filtering columns, type and assembly. Open their registration XML or explicitly mapped C# source. Lense uses the online plugin execution; exported registrations do not establish which assembly is currently deployed. See [plugin source mappings](../mirage/docs/dataverse-plugins.md).

With only a portal export, Inspect resolves portal components, snippets, web files and exported access rules. Add `mirage.solutionRoots` or `mirage.project` to the catalogue to resolve Solution FormXml, views, table fields, PCF manifests/resources and literal dataset bindings. Code components resolve by exported schema name or an explicit observed ID mapping. These shared source settings also work in live Lense without starting Mirage. **Refresh inspection** rereads the selected sources, including Solution changes.

**Tables & access** shows exported permissions, scopes, relationships and web roles. Static references can include conditional branches. Rendered controls and assets are labelled separately. Live role membership and effective record access remain unknown; an exported grant is not proof that the signed-in user can use it.

## Automation and evidence

Projects with a [persona catalogue](../mirage/docs/persona-catalog.md) can search and filter
named personas and scenarios in the panel. In live Lense, selection uses the portal's own
sign-in flow; it does not issue native identity tokens for a synthetic contact. In Mirage,
scenarios can open isolated local setups with their own profile, variables and overrides.
Keep live identity mappings and scenario tests in the project.

Agent discovery files contain bearer tokens and stay under ignored `.paqvilo/agents`. Use `agent sessions` to locate a session; `status`, `pages`, `events`, `state`, `snapshot` and `screenshot` inspect it. Page IDs are different from offline resource IDs. Agent control is origin-confined and has no arbitrary evaluation or proxy endpoint. Consume `nextSequence` and report dropped events.

Inspect applied resources, unmatched markup patches, deployment requirements, errors and failed requests after refresh. Audit coverage reports source classification, not successful navigation or browser application. A sign-in page is not successful target coverage. `verify --signed-in` requires closing the matching dev identity first; headed sign-in can be bounded with `--sign-in-timeout`.

Continue with [configuration](configuration.md), [project extensions](project-extensions.md) or the [documentation index](index.md).

## Agent API reference

Use `paqvilo lense agent <action> --json`. Every page action requires `--session <ignored discovery file> --page-id <numeric ID>`; never print or share discovery contents. The API is confined to its configured portal origin. Attached browsers remain user-owned; stopping an owned target stops its shared owned browser. There is no evaluation, form-action or arbitrary proxy endpoint.

Responses use schemaVersion, command, ok, offline, writesFiles and errors (objects with code/message). Browser inspection has offline=false. Read failures distinguish missing discovery files from invalid JSON. HTTP failures carry stable codes: invalid_argument, invalid_selector, unauthorized, page_not_found, page_busy, session_busy, foreign_origin, origin_changed, unsafe_reload, image_too_large, response_too_large and action_timeout. Messages omit browser stacks, ANSI controls and call logs. The browser navigation deadline is shorter than the CLI HTTP deadline; timed-out navigation is stopped.

### agent sessions

No session is required. Optional --config selects its state folder. Returns sessions with id, site, environment, discoveryFile, reachable, plus invalidFiles and truncated. Does not return bearer tokens. At most 64 files are probed.

### agent status

Returns id, session (without token), readiness, browserScope, access counts, debugger port, baseline, git, overlay, pages and truncation flags. A stopped session's missing discovery file is reported explicitly.

### agent pages

Returns pages with numeric id, document id, sanitized URL and title. Closed or foreign-origin pages are excluded from actionable pages.

### agent events

Options --after (sequence, default 0) and --limit (1–500, default 100). Returns sessionId, events, oldestSequence, latestSequence, nextSequence, dropped, hasMore and cursorAhead. Advance with nextSequence and inspect dropped/hasMore. A cursor ahead of latestSequence sets cursorAhead=true and resets nextSequence to latestSequence; compare sessionId when reusing a cursor. Retention is 500 events or 1 MiB, whichever is reached first.

### agent state

Returns page, overlay, resources, diagnostics, runtime and limits for the current document. Lists are bounded to 200 items; inspect truncation flags. Page IDs differ from offline resource IDs.

### agent snapshot

Options --selector (CSS, at most 1,000 characters), --limit (1–200, default 100), --styles (up to 20 CSS properties). Returns sanitized URL, title, total, truncated and elements with tag, bounded attributes/text, visibility, rect and style. Does not copy field values. Invalid selectors return invalid_selector (400).

### agent screenshot

Requires --output <new.png>; optional --full-page and --include-panel. Returns path and bytes; writesFiles names the created PNG. Existing files are never overwritten: an existing output returns `invalid_argument`, naming the path relative to the project (the filename alone when it is on another volume). Choose a new output filename. PNG output is limited to 8 megapixels, 8,192 pixels per side and 8 MiB.

### agent viewport

Options --width (320–4096, default 1440), --height (240–4096, default 900). Returns page and viewport. Invalid dimensions return invalid_argument.

### agent navigate

Requires --path <portal-path>. Optional --timeout (2000–120000 ms) bounds the client request. Navigate and reload leave a fixed 1000 ms response margin above the browser deadline (whose maximum is 60000 ms). Performs an explicit GET confined to the portal origin and returns page and HTTP status. Foreign origins are rejected; redirects leaving the origin return origin_changed. A browser timeout returns action_timeout (504); transport expiry returns request_timeout.

### agent reload

Optional --timeout. Returns page and status. Only an observed GET document with no pending navigation can reload; unknown, restored-history and POST documents return unsafe_reload (409). Navigation uses an explicit GET to avoid repeating a form post.

### agent stop

Returns stopping=true and shuts down that owned session/browser, removing its discovery file. Other sessions and attached user-owned browsers remain intact.

JSON envelopes carry `schemaVersion`, `command`, `ok`, `offline`, `writesFiles` (an array), and `errors` (objects with `code` and `message`). Agent envelopes also carry `action`. Generic CLI errors use `invalid_argument`, `unsupported_option`, `unknown_command`, `configuration_error`, `command_failed`, or `check_failed`; strict inventory failures use `strict_failed` with blocked/gap counts. Domain diagnostics retain their documented runtime codes.

Agent client errors additionally use `session_not_found` (missing discovery file), `invalid_session`, `session_unavailable`, `request_timeout`, `invalid_response`, and `response_too_large`. Server action codes include `invalid_argument`, `invalid_selector`, `action_timeout`, `action_failed`, `page_busy`, `session_busy`, `page_not_found`, `unsafe_reload`, `foreign_origin`, `origin_changed`, `not_found`, `method_not_allowed`, `content_type`, `invalid_json`, `body_too_large`, `image_too_large`, `response_too_large`, `browser_request`, `unauthorized`, `invalid_url`, and `stopping`. HTTP failures retain their status in the error object.

## Local source debugging

Mirage appends file-backed source maps to served JavaScript/CSS assets, including extensionless payloads with those MIME types. Page, template, list and form custom JavaScript carries its export sourceURL and line-offset source map. Individual inline blocks use stable `?inline=N` debugger URLs, while maps still point to the original export file. In VS Code, attach to the free port reported by `paqvilo mirage dev --debug-port 9223`:

```json
{"type":"msedge","request":"attach","name":"Paqvilo Mirage","port":9223,"resolveSourceMapLocations":["**", "!**/node_modules/**"]}
```

The maps contain absolute file URLs, so exported files served below parent routes need no project-specific pathMapping. Set breakpoints in exported source files. Sidecar files and YAML literal blocks retain their source lines; folded/escaped fields and enhanced XML/JSON receive a sourceURL only because their encodings do not preserve JavaScript lines. Liquid expansions that change line counts can shift subsequent locations; the debugger describes rendered JavaScript, not local Liquid execution.

Target selection commits only with Go or Enter. Nonempty local, remote and caution groups are shown; leaving a local runtime for a live target or opening caution requires an in-panel confirmation. Cancel or a failed switch restores the current target. `portals: all` excludes caution targets unless explicitly selected or `includeCaution: true` is set in the catalogue. UI state is scoped to the browser profile, shared across its target switches; a CDP attachment without a known profile keeps UI state in memory. Automated headless sessions start collapsed.

Interactive dev leaves portal `alert`, `confirm`, `prompt` and before-unload dialogs for the browser user to answer. Owned headless dev dismisses alerts, confirms and prompts, and preserves Playwright's automatic acceptance of before-unload dialogs so navigation can complete. Their type, redacted message and disposition appear in Activity and agent events. Attached browsers retain control of their dialogs. This policy also applies when the panel is disabled. Panel controls use their own confirmation UI.

`map --no-write --json` returns the mapping without writing reports. Otherwise writesFiles reports both mapping paths. Resources distinguish exists, empty and renders for optional enhanced fields. Duplicate active page URLs and every overwritten YAML record are diagnosed offline.

Lense JSON commands return a common envelope with schemaVersion, command, ok, offline, writesFiles (an array) and errors (objects with code/message). `status --json` returns comparisons in results, sets offline=false and fails when a comparison is incomplete. `verify --json` reports its final pass/fail after cleanup and names the evidence files it actually wrote. Resource presence and rendering flags describe indexed export relationships; they do not establish browser coverage.

Lense Mirage management uses the same envelope: init names its generated project file; start names state, discovery, ownership and startup log files; stop names its updated ownership file and reports removed discoveries separately. Started runtimes can continue writing state and derived caches. Status/start/stop use offline=false; `lense mirage inspect` is offline and writes no report. Interactive `mirage dev` rejects --json; use start plus the agent API for structured automation.

X-ray compares class coverage in both directions and uses rarity across the imported export. Common framework classes remain possible matches unless a matching tag occurs only a few times in one source in the page's include chain. Repeated source lines remain available. Unchanged markup hints reuse a content-aware cache across pages and refreshes (up to 512 source records and 12 MiB of source text); script hints have a separate 128-entry, 4 MiB cache. Changed source content invalidates its entry. Background discovery prefers visible elements, rebuilds on scroll, and reports when its 800-candidate budget is reached; drawing remains bounded to 250 outlines. Nodes smaller than four pixels or clipped helper nodes remain selectable but have no background outline. Geometry follows scroll, resize, relevant mutations and running animations; hidden and idle documents do not poll layout.
