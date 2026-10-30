# Local simulation administration

[Persona catalogues](persona-catalog.md) add grouped, searchable pickers to sign-in
and Identity, browser-local pins/recent choices, catalogue editors and isolated
setups for deployment profiles, variables and snippet/settings overrides. Open
`/_sim/#access` to select a browser persona or manage metadata. Role membership
editing remains separate and explicit. Testing helpers resolve the actual origin
and browser options for a persona or catalogue scenario.

`/_sim/` and [`/_setup/`](../../docs/setup.md) share one shell and an **Areas** switch in the sidebar: `/_sim/` is the simulator workspace for daily work, setup is for administration and initial configuration.

Both share one wordmark, **Paqvilo**, with the area label under it (`PROJECT SETUP`, `SIMULATOR WORKSPACE`).

`/_sim/` is the loopback administration workspace. It exposes local tables/records, identity, roles, permissions, presets/scenarios, settings/snippets, runtime environment, source inspection, providers, platform resources, and what the runtime did (activities, log lines, findings and evidence). Changes here affect local state and rendering. Provider controls distinguish local configuration, optional reference reads and cached platform assets.

**Platform rules** (`#platform`) configures simulated organization/platform controls, including the support-managed link-entity budget and attachment restrictions. **Settings & snippet overrides** (`#overrides`) compares source/effective values without editing exports. Both support portable configuration presets and independent state for concurrent runtimes. Coverage and real administration classifications are explicit; see [configuration experiments](configuration-experiments.md).

**Organization identity & API** (`#dataverse`) manages the local organization, including when its public HTTP listener is off. It shows staff session identity/roles, application registrations with secret hints and certificate thumbprints, interactive users, optional local token credentials, and how many API requests the listener answered recently, with **Activity of the Dataverse API →** and **Failed requests →** links into [Activity](#activity). Select a model-driven staff user or explicitly reset to local administrator. Portal personas and application-token identities are separate. Forms register applications, add local secrets/public certificates/federated credentials, create staff users, edit roles and enable/disable users. A new secret is shown once and never appears in a later read. Enable the HTTP API in Project setup and restart when an external integration client needs it. See [Dataverse API](dataverse-api.md#administration).

**Runtime & persistence** on Runtime state shows the effective surface, simulation level, control-plane persistence and exact declared pack DATA targets. Configuration in `/_setup/` takes effect after restart; it never flushes in-memory edits. Dry run permits memory-only record changes, simulation writes declared existing DATA files, and deep simulation also permits declared schema changes. File-backed tables without owners are read-only. See [simulation levels](simulation-levels.md).

[Standalone app/API profiles](standalone-organization.md) expose only applicable views and links. API-only profiles have no portal/model-driven launch link; standalone profiles have no portal persona, live bridge or rendering controls. The `/_sim/` record editor is explicit local administration; model-driven requests use the selected staff principal and its field/row security.

**Backend operations** lists exported server logic and cloud flows, including unlinked Solution workflows. Select a JSON response mock, keep an unsupported placeholder, explicitly enable trusted exported code or use a registered project handler. **Use source default** removes a local override. Exported role grants still apply; unlinked workflows receive no invented route or grants. See [operation modes and limits](operations.md).

Portal requests start anonymously. Local sign-in selects an active synthetic contact or explicit role override and stores a per-runtime `paqvilo-mirage-auth-<port>` cookie. The portal sign-in page, `_sim` and Lense Tweaks all operate on the browser session. Signing one browser in does not sign another browser in. The saved simulator identity is not a substitute for a request cookie.

Embedded tools call `simulator.signIn(contactId)` and send the returned cookie header. Playwright tests use `signInContext` from `paqvilo/mirage/testing`. Local session administration uses CSRF protection. Sign-out clears only the local session.

`simulator.identityScope` supports `"sessions"` (the default) and `"configured"`.
The legacy `"all-requests"` alias has the same behavior as `"configured"`.
Use `"configured"` only for explicitly chosen offline tooling: cookie-less portal
requests use the saved configured identity, with its normal membership or manual
role-override resolution and permission checks. A valid visitor cookie takes
precedence, including the explicit anonymous cookie issued by sign-out. This
option neither creates a session nor signs a browser in; a cookie-less request
uses the configured identity. Session scope
keeps cookie-less visitors anonymous. Administration requests continue to use the
configured identity. These are local simulation settings, not Power Pages
authentication or production security settings. Prefer session helpers for
independent visitors and permission tests.

`connectRuntime().signIn(null, { configuredPersona: true })` requires a configured
contact (`identity.contactId` or legacy `identity.id`). Missing and role-only
identities fail with `MISSING_PERSONA_CONTACT` before sending a sign-in POST.
An explicit `contactId` is also supported; omit sign-in to stay anonymous.

HTTP tools can use `createPortalSession` or `connectRuntime().createSession` from
`paqvilo/mirage/testing` for independent visitors sharing one runtime. Each owns its
cookie jar and membership-derived identity. `runSessionMatrix` exercises a bounded
visitor/case product concurrently, supports cancellation and serialized recording,
and reports throughput and latency. It sends ordinary portal requests and preserves
permission denials. Use separate write fixtures per visitor; settings, sources and
data are shared within the runtime. For different configuration or CPU workers,
run separate Mirage processes and state files. See [public API](../../docs/public-api.md#test-many-visitors-concurrently).

External identity-provider flows are local simulations for exported provider settings, with a local provider route and explicit redirect handling. They do not copy live credentials or mint genuine environment tokens. Actual live-reference sign-in belongs to the intended signed-in browser and its own identity.

Automated tools can inspect `connectRuntime().audit(filters)`, `exportAudit(filters)`, `diagnostics(filters)` and `logs(filters)`. Correlate a visitor's returned `traceId` (the audit id of the `X-Sim-Trace-Id` response header) with `correlationId`, select the entries of activities with `traceId` (one trace id, a comma list or an array of at most 200), or isolate entries by `contactId`. Each entry also names its browser session, `visitorId` (the anonymous visitor cookie id) and `sessionKey` (`contact:<id>`, `visitor:<id>` or null), and both filter with an id prefix of at least 8 hexadecimal characters (`sessionKey=visitor:ad87d220`). Exclusive `afterSequence` and inclusive `throughSequence` bound a stable request window; responses expose retention loss and the oldest retained sequence. Complete the requests before advancing a checkpoint because sequence numbers are assigned at request start. These reads use the existing sanitized, bounded ledger.

`runtime.witness({tables: ['fixture']})` and `visitor.witness({tables: ['fixture']})`
capture a read-only verification boundary through the existing loopback administration
API. Select one to 32 distinct existing logical fixture tables explicitly. Each
visitor sends its own cookie internally, so its witness uses the same resolved
portal identity and membership roles as its portal requests. Cookie-less requests
are anonymous under the default session scope. The configured persona does not
silently replace the visitor.

The atomic `DataStore.readOperation` hashes effective permissions, mappings,
settings, operation mode, source/runtime fingerprints, actor fields and all stored
columns/multiplicities in the selected tables. It invokes no SDK/plugin retrieval.
The response contains hashes/counts and selection scope rather than row bodies,
setting values or credentials. `compareVerificationWitnesses(before, after)` from
`paqvilo/mirage/testing` reports changed hash categories. Runtime instance and
revision changes are reported separately so an unselected recording-table
write does not masquerade as selected fixture drift. No table is automatically
excluded, and unselected collections receive no coverage credit. Actor fields are
observed independently of that table selection.

Keep the state file outside the export or in ignored `.paqvilo/`, as with normal
runtime configuration. The source fingerprint intentionally observes files in
the export. Original external DLL/SDK bytes need separate verification; a
plugin-definition hash alone does not observe their on-disk bytes.
These witnesses establish local comparison boundaries, not native parity.

Permission enforcement can be set to enforced or permissive for local experiments; this choice is visible in evidence. Live create/update/delete cannot leave the runtime without `--allow-live-writes`, and still require the separate administration switch. Task authorization is required independently of either switch.

## Views and host awareness

The sidebar groups the views: **Workspace** (Home), **Monitor** (Health, Activity), **Data** (Data records, Data packs, Plugins & presets, Entity mappings, Endpoints), **Platform** (Providers & services, Flows & jobs, Capabilities & preflight, Backend operations, Environment, Platform rules, Settings & snippet overrides, Portal configuration), **Identity** (Portal identity & permissions, Organization identity & API, Scenarios) and **Runtime** (Runtime state, Live connection). An empty hash opens Health (`#health`); an unknown one opens Home (`#home`). Old addresses redirect in place (see [Old addresses](#old-addresses)). Opening a view scrolls to its top and focuses its heading; `#<view>?panel=<key>` also opens that panel, scrolls to it and outlines it briefly. The page follows the browser's light or dark colour scheme (`/_sim/` opts in with `data-ui-theme="auto"`); `/_setup/` does not opt in and stays light.

### Page layout

Every view uses the same page chrome:

- **No title block.** The top bar's breadcrumb, `Simulator / <group> / <view>`, names the page, with the current view in the accent colour. The view's heading stays in the page for screen readers and focus. The view's **How this works** is the (i) right after the breadcrumb.
- **One toolbar row** starts the content: a summary such as the result count on the left; the view's actions (such as **Create**) and **Filters** on the right. **Filters** shows the number of active filters (`Filters · 2`) and opens a drawer on the right with the filter form: it overlays the page below 1200 px and pushes the content aside from 1200 px. Applying, Enter, Escape, **Close** or a click outside closes it. The active filters show as chips under the toolbar, each with ×, and **Clear all**.
- **Help is behind (i).** Each section heading has one (i) after it, and field and column explanations are (i) popovers or tooltips; key facts show as two-column definition grids.

Every table uses one shared table: a search box in the bar above it, **Filters · n** beside it when more than one column can be filtered (a drawer with one search box per column, its chips removing one filter or all), a sticky header, row dividers, row actions pinned to the right, and always a bottom bar with the result count, **Rows** (rows per page) and **Previous**/**Next** (disabled on a single page). A page's main list (Flows & jobs runs, Backend operations, Data records and the Activity tabs) puts its search box and Filters in the toolbar row instead, so the first row stays right under it. Every data column sorts from its heading, which is a button: select it to sort ascending, again for descending (`aria-sort` says which). Columns sort by their shown text, with numbers in numeric order and empty cells last; action and control columns do not sort. Activities sorts on the runtime (Time, Duration, Steps, Errors). ↑ and ↓ move to the same control of the previous or next row, and Enter on a focused row opens it.

At phone width (below 760 px) the sidebar folds behind **☰ Menu**, which closes when you choose a view, and the top bar's apps and actions move into one **Apps & actions** menu. Wide tables keep their row actions on screen, and no view scrolls sideways.

### Views

A view is shown only when its host serves the route it needs. The page reads the host's `status.routes` (see [Status payload](#status-payload)); a host that does not publish it is probed once per session with one GET per required route, and only a 404 hides the view. Views of the portal source need the portal `page-resources` route, which only the Power Pages host serves. No view is hidden by a hard-coded host list.

**Home** (`#home`), **Health** (`#health`) and **Activity** (`#activity`) are described in [Monitor](#monitor).

**Providers & services** (`#services`, both hosts) has one collapsed panel per area, Storage open: storage providers and routes with their readiness and counters; messaging entities, endpoints, peek and purge (with confirmation); outbox entries with their filters; connectors, connections (id, provider, principal kind) and pending approvals; secret references (names, bound status, source kind, never values); declared local services with **Probe now** (preflight `?requires=local-service:<id>`); service fixtures; the Power Fx seam; canvas, code apps and PCF inventory; the SharePoint route.

**Flows & jobs** (`#flows`, both hosts) lists flow runs (filters by process and status) with the flow name, the run id, the local start and end time, **Details** (the action journal, collapsed) and **Activity →**, which opens the run's step in Activity (`#activity/<traceId>/<traceSpanId>`) while the trace store retains it; waits and approvals (Approve or Reject with comments; delay and webhook outputs as JSON), background work (durable jobs, scheduler status, asyncoperation rows by state, poisoned rows) and web hook outcomes with the loopback delivery rule. It reads the [flow run routes](#flow-runs-and-waits).

**Backend operations** (`#operations`) gives each row **Recent activity →**: a plug-in step opens `#activity?kind=plugin-step&actorKind=plugin&actorId=<step id>`, a cloud flow `#activity?kind=flow-run&actorKind=flow&actorId=<process id>`, server logic `#activity?kind=server-logic&q=<name>` and a classic workflow `#activity?kind=workflow&q=<name>`. **Data records** (`#records`) has its table switcher, the record search (over every column), **Create** and, with more than 10 tables, **Filters** with a table finder on the toolbar line; it has no column filters, because it pages on the runtime. Every shown column sorts from its heading, and count and paging are in the bottom bar. Each row has **Activity →** (`#activity?table=<logical name>&recordId=<id>`), and **Portal identity & permissions** links the selected persona to its activity (`#activity?who=<contact id>`).

**Capabilities & preflight** (`#capabilities`, both hosts) lists the capability report (module, kind, level, source, operation count), missing prerequisites and the records below behaviour level, and runs preflight with requirement ids or globs and a strict switch; on Power Pages each saved scenario has a **Preflight this scenario** button.

**Data packs** (`#packs`, both hosts) lists the registered packs of [`GET /_sim/api/packs`](#pack-inventory) with a per-pack detail (exports, presets, personas, DATA file ownership, diagnostics, matched status and reason), the data presets with their pack and source, and how to add or change a pack in [`/_setup/#packs`](../../docs/setup.md#journey) followed by a restart.

## Monitor

Everything the runtime reports about itself is in two views of the **Monitor** group: **Health** answers whether the runtime is wired and up, and **Activity** answers what it did. **Home**, in the **Workspace** group, is where a first run starts.

### Words and times

The `_sim` views, their help and these guides use one vocabulary:

| Word                      | Meaning                                                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Activity                  | One trace: a request, a job, a flow run or a startup step.                                                                                                               |
| Step                      | One span of an activity.                                                                                                                                                 |
| Finding                   | A runtime diagnostic, with its code and severity.                                                                                                                        |
| Log line                  | One entry of the runtime log stream.                                                                                                                                     |
| Who                       | The actor and session an activity ran as, such as `Ada Member · contact:1a2b3c4d` or `Visitor accb980f` (ids shortened to 8 characters).                                 |
| Result                    | `ok`, `error`, `denied`, `running` or `cancelled`. The request audit's outcome `success` reads `ok` and `pending` reads `running`; the HTTP status is a separate badge.  |
| Plug-in step, plugin rule | A plug-in step is an exported Dataverse plug-in that Backend operations runs; a plugin rule is a declarative rule of Plugins & presets. Each links to its configuration. |

Activity, Flows & jobs and the last source reload on Runtime state show times as local `HH:MM:SS.mmm`; hover a time for its date and its UTC time. Each list names the zone once: Activity under its table (`Times local (UTC+02:00)`), Flows & jobs in the (i) of its Started column.

### Home

**Home** (`#home`, both hosts) starts with the **First run** checklist: Portal sources loaded, Records to work with, Open the portal, Sign in as a test person and See what happened, each Done or To do from a fact (pages in the export, records, portal requests since start, this browser's sign-in, and whether this browser opened Activity after there was activity) and linked to the view that does it; its counter counts every step (`4 of 5 done`). **How this browser signs in** (this browser's session, the sign-in route and the sign-in default, as a definition grid) and **Where to go next** follow. A standalone runtime shows **Start working** with its app links instead. The runtime and persistence facts and the workspace configuration are on **Runtime state** (`#runtime`).

### Health

**Health** (`#health`, both hosts) renders [`GET /_sim/api/dashboard`](#health-feed) every 5 seconds while the tab is visible and the view is open. Top to bottom:

1. **The hero banner**, on its coloured surface: the runtime kind with a large readiness pill (`OK`; `DEGRADED` when a component reports an error or is missing; `BLOCKED` when preflight reports blocking requirements) beside the live state, chips for the site, the uptime (from `runtime.startedAt`, such as `Uptime under a minute`), record changes, the clock and the source version, the local address, a ring with the component counts, and one strip of key numbers: **Requests**, **Errors** (failed activities, the same count as `#activity?result=error`, not failed steps), **p95**, **Plug-in step runs**, **Flow runs** and **Findings**, each opening the matching activity (errors and p95 come from `GET /_sim/api/trace/stats` where the host serves it).
2. **Key numbers** (since this runtime started), a section card like the System map card: compact tiles with number, label and change since the last refresh. **Expand** in the card's header shows a timeline per tile since the runtime started, about 24 buckets of at least 1 second, read from `GET /_sim/api/trace/stats?…&from=<runtime.startedAt>&to=<now>&bucketMs=` and refreshed with every poll while expanded: Portal requests and Dataverse Web API count root steps of their host, Plug-in step runs and Flow runs their step kind, and Findings come from `GET /_sim/api/diagnostics` by time. The timelines count kept activities. Jobs pending, Messages and Outbox say `No timeline: a current level; the runtime keeps no history of it`, Storage writes says that storage providers count writes that are not activity steps, and a runtime without a start time says `No timeline: the runtime reports no start time`. **Hide graphs** folds them again. The counters' (i) sits next to Expand.
3. **The system map**, open by default in a card you can collapse, with the map legend behind the (i) in its header (columns Clients, Hosts, Organization, Providers and Declared externals; an edge animates when its counter moved since the last poll, except under `prefers-reduced-motion`), with a node drawer (click, Enter or Space) holding the node's facts and a link to the view that manages it.
4. **Blocking**, which runs `GET /_sim/api/preflight` on demand with requirement ids or globs and a strict switch.
5. **Configuration**: runtime, level, state file, packs, Solution layers, settings keys present, ports.

Health reads counters since start, so it works with tracing off. Its numbers count everything since the runtime started, also runs no longer kept, while Activity's Stats counts the kept, filtered activities; either can be higher, and a tile's tooltip says so.

Each tile is a link. **Portal requests** (pages and the portal's `/_api` calls) opens `#activity?host=power-pages`, **Dataverse Web API** (the organization API on its own port, not the portal's `/_api`) `#activity?host=dataverse-api`, **Plug-in step runs** (exported plug-in steps, not plugin rules) `#activity?kind=plugin-step`, **Flow runs** `#activity?kind=flow-run` and **Jobs pending** `#activity?kind=job`; a tile's **N failed** adds `&result=error`. **Findings** opens `#activity?tab=findings`. **Messages**, **Outbox** and **Storage writes** have no activity kind and open their panel of Providers & services. Health does not list recent requests; they are in Activity. The portal request ring behind the feed keeps paths without their query, and a credential route keeps nothing after its first credential segment (a segment naming a password, token, secret, invitation, confirmation or redeem step is followed by `…`), so `/_sim/` feeds never carry a token from a path.

### Activity

**Activity** (`#activity`, both hosts) is one workspace for every activity of the runtime. It reads the [activity and trace routes](#activity-and-trace-routes), the request audit and the runtime log stream. Its toolbar row holds the tabs, the tab's quick filter, **Live**, **Refresh**, the export format with **Export**, **⚙** (tracing settings), the search box and **Filters**; the open tab's table follows directly. The quick filter is **Errors & denied** on Activities and Stats, which sets `result=error,denied` in one click (it shows as the Result chip and the button reads pressed) and clears it on the next, and **Startup** on the Log stream, which sets `type=startup` the same way; Findings and Pages & render have none. The search box (`q`) is labelled for the tab (Search activities, log lines, findings, pages or steps) and applies with Enter or when you leave it. One set of filters, in the Filters drawer, narrows every tab, and the page address is its state:

```text
#activity?range=15m&result=error,denied&who=contact:<id>&table=contact&recordId=<id>&host=power-pages&q=<text>&live=1
```

- **The filters.** **Time** (`range`: `5m`, `15m`, `1h`, `24h`, or all when absent; `from` and `to` make it custom), **Result** (`result`, a comma list), **Who** (`who`: `anonymous`, `visitor:<id>`, `<kind>:<id>` with a kind such as `contact`, `staff`, `app`, `flow` or `plugin`, or a bare id), **Table** (`table`), **Record id** (`recordId`) and **Host** (`host`), with **Search** (`q`) in the toolbar row. **More filters** holds the step filters `kind`, `module`, `operation`, `status` (the result of any step), `hasErrors`, `from`, `to`, `minDurationMs`, `session`, `portal` and `auditId`, and the request audit keys `path`, `provider`, `auditKind` and `httpStatus`. **Table** accepts the logical name or the entity set name (`contact` or `contacts`). **Record id**, **Who** ids and `session` accept a prefix of at least 8 hexadecimal characters (`visitor:ad87d220`), which matches every id that begins with it, so an ambiguous prefix matches every candidate; a shorter value matches exactly. A choice applies at once, with the drawer open and the list behind it updating; text applies with Enter or **Apply**, which closes the drawer. The Log stream's **Log type** (`type`) is in the drawer too.
- **Chips.** Each active filter is a chip under the toolbar with ×, and **Clear all** removes every filter. A chip that does not apply to the open tab is dimmed and says so. A **Who** chip shows the caller's name when the link that set it carried one (`whoName`, a label in the address that is never sent to the runtime).
- **The address.** Every filter, the tab (`tab=log|findings|pages|stats`), the log type (`type`), Live (`live=1`), **Show reads** (`reads=1`), the sort (`sort`, `order`), the open activity and step (`#activity/<traceId>[/<spanId>]`), its detail tab (`detail`), the tree reading (`steps=tree`), the step search (`spanSearch`, `errorsOnly`) and a comparison (`compare=<id1>,<id2>`) are in the address, so a view is a link you can share. `#activity` alone is the unfiltered list: nothing is kept that the address does not say. The older keys `entity`, `search`, `sessionKey`, `actorKind`, `actorId` and `visitorId` are read as `table`, `q`, `session` and `who`.
- **Keyboard.** ↑ and ↓ move between activities, Enter opens one, Escape closes the open step and then the activity, and `/` focuses the search box, unless you are typing in a field.
- **Tables.** Activities, Log stream, Findings, Pages & render and the Stats breakdown are shared tables: sortable headings (Activities on the runtime, the others in the page), the count, **Rows** and paging always in the bottom bar (the Stats breakdown also has its own search box and column Filters), with the tab's own controls (**Compare** and **Show reads** on Activities) and the time zone (`Times local (UTC+02:00)`) at its left. The Result legend is the (i) of the Result heading.
- **Phone.** At 700 px and below the tabs become one **Tab** dropdown; Errors & denied, Startup, Refresh and Export show as ⚠, ⏻, ↻ and ⇩, and the search box takes a row of its own. A log line takes two lines (time and type, then the line across the row, with **Open activity →** under it), and Pages & render rows stack the same way.

The tabs, each shown only when the host serves its route or channel (`status.routes`, `status.eventChannels`):

| Tab            | Shows                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Activities     | One row per activity, newest first: time, result with the HTTP status badge, name, who, duration, steps and errors, and the first error message under the name. The request audit facts of the request (provider, rows returned, reads, portal error code) are on the row. Liquid and FetchXML reads made while a page rendered are folded into the page; **Show reads** lists them. Sort by Time, Duration, Steps or Errors; tick two rows and select **Compare**. |
| Log stream     | A table of the runtime log stream from startup on (Time, Type, Line, and the activity link pinned right), kept by the server (`mirage.logs.retain`, see [configuration](../../docs/configuration.md)), so lines written before the page opened are there. **Live** follows new lines. Each line written during an activity links to it (**Open activity →**). Findings are folded behind a **+N findings** counter; **Log type** narrows to one type.               |
| Findings       | One row per code with its count, its first message and path (`+n other messages` when there are more) and the occurrences behind it. A finding raised during an activity links to it; one raised while loading sources says `startup / outside any request`.                                                                                                                                                                                                        |
| Pages & render | The pages of the portal export with the last activity of each route, its render time, the template files it used (resolved to file path and line) and the saved rendering evidence with its status and screenshots.                                                                                                                                                                                                                                                 |
| Stats          | The filtered activities in numbers: tiles (root p50 and p95, the root p95 against the previous range of the same length), the slowest steps and latest errors, a timeline and breakdowns by kind, module, table, operation and who. A timeline bucket narrows the range to it; **Filter** on a breakdown row narrows to that value.                                                                                                                                 |

From 1200 px wide an open activity sits beside the list. Its detail starts with a **Why** line: the first step that failed or was denied, with its message and **Show this step** (a running activity says so; a clean one names its result, HTTP status and duration). Its tabs are **Steps** (a waterfall or a nested tree; a step opens a drawer with its path from the root, **Parent** and **Root**, attributes, events, capture level, redacted payloads and links; flow run, job and plug-in step ids link to their views), **Log & findings** (the log lines and findings of this activity), **Rendered** (the render, template and Liquid read steps with the source file and line of each template, and the rendering evidence of the route), **Request** (the request audit entry: result and HTTP status, who with roles, provider, table, rows, duration, the error with its portal code, the query and the reads it made) and **JSON** (the whole activity; download or copy it). **Related** opens the same session, the same who and the same record, and the flow run or job it started (**Flow run ↗**, **Job ↗**). **Copy id** and **Copy link** copy the activity id and the address.

**Live** makes the list follow `/_sim/events?channels=trace&events=trace-end`, and an open running activity follow its own steps; a host without the channel turns Live off with a notice. With tracing off, Live follows the request audit through the log channel and says `Following the request audit`; a host without that channel says `Live needs tracing on (⚙ Settings)`. **Export** downloads the format chosen beside it (its (i) explains the formats), and **⚙ Settings** which changes the tracing level, persistence and the retention limits (`traces`, `spansPerTrace`, `payloadBytes`) without a restart, shows a persistence failure such as `NoStateDirectory` and has **Clear activities** (the audit, log lines and findings stay). Export downloads, for the current filters and at most 200 activities:

- **Bundle** (the default): `GET /_sim/api/activity/export?<filters>&format=bundle` as one NDJSON file, `simulator-activity-bundle.ndjson`, holding the activities, their request audit entries, log lines and findings, the saved rendering evidence reference, the runtime revision and fingerprints, the filters and the runtime's time zone (see [the bundle](tracing.md#activity-bundle)).
- **Bundle with OTLP activities**: the same with `traces=otlp`.
- **Activities only**, as NDJSON, JSON or OTLP JSON (`GET /_sim/api/trace/export`).

With nothing recorded, Activities guides the first steps: open the portal, sign in as a test person, and see the activity appear (live with Live on). It also names how many startup findings are under Findings.

**Tracing off.** At level `off` no steps are recorded, but the request audit keeps recording: Activities lists the audit entries, each opening its activity when it has one, under the banner `Tracing is off: showing the request audit only; turn it on in ⚙ Settings to see steps.` The other tabs say `Tracing is off: only the request audit records new requests (Activities lists it).` A request audit key (`path`, `provider`, `auditKind`, `httpStatus`) also makes Activities list the audit.

**Standalone host.** A standalone runtime has no request audit, no log stream and no portal. Activity lists its activities from the trace store, the Log stream tab is replaced by the note `No server log stream on this host.`, Pages & render is not shown, Request shows the facts of the root step and Export offers the activities only. A request audit key shows `This host keeps no request audit, so <filters> cannot filter its activities.`, and at level `off` the view says `Tracing is off and this host keeps no request audit: nothing new is recorded.`

### Old addresses

The addresses of the views that Home, Health and Activity replaced keep working. Each is replaced in place (`history.replaceState`, no extra history entry), so bookmarks and Lense links land on the same filtered content:

| Old address                  | Opens                                                                                                                                                                                                                                                                               |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#dashboard[?…]`             | `#health[?…]`; a `panel` key gets the `dashboard-` prefix.                                                                                                                                                                                                                          |
| `#overview[?…]`              | `#home[?…]`.                                                                                                                                                                                                                                                                        |
| `#identity[?…]`              | `#access[?…]`.                                                                                                                                                                                                                                                                      |
| `#logs`, `#logs?type=<type>` | `#activity?tab=log`, `#activity?tab=log&type=<type>`.                                                                                                                                                                                                                               |
| `#audit?<filters>`           | `#activity?<filters>` with `outcome` as `result` (`success` as `ok`, `pending` as `running`), `entity` as `table`, `search` as `q`, `kind` as `auditKind`, `status` as `httpStatus` and `correlationId` as `auditId`; `path`, `provider` and other keys unchanged; `panel` dropped. |
| `#trace?<filters>`           | `#activity?<filters>`; with `traceId` (and `spanId`), `#activity/<traceId>[/<spanId>]?<other filters>`.                                                                                                                                                                             |
| `#evidence[?…]`              | `#activity?tab=pages`.                                                                                                                                                                                                                                                              |

Lense's request link `#audit?path=/page/` lands on Activities filtered by that path, and its evidence link `#evidence` on Pages & render.

### What stays separate, and why

Activity holds what happened. These keep their own place, and each links into Activity where an activity exists:

| Where                                                         | What it is for                                                                                          | Why it is not in Activity                                                            |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| Health                                                        | Whether each part of the runtime is wired and answers, and how much it did since start.                 | It is graph-shaped readiness with totals since start, and it works with tracing off. |
| Flows & jobs, Backend operations, Organization identity & API | Where you change things: answer a wait, choose an operation's local behaviour, register an application. | They are places to act; each links to the activity of what it ran.                   |
| Runtime state                                                 | Persistence, workspace state export and import, workspace configuration, fingerprints.                  | It is the runtime's state, not something the runtime did.                            |
| Data records                                                  | The local records.                                                                                      | It is the data itself; each record links to its activity.                            |
| Verification evidence                                         | The output of a verification run, bound to source and implementation fingerprints.                      | It is another run's output; Pages & render shows its status and screenshots.         |

The request audit stays a ledger of its own: it records at level `off`, keeps its sequence windows and backs `connectRuntime().audit`. Activities and the Request tab show its entries, and each entry names its activity by `traceId`.

## Status payload

`GET /_sim/api/status` on both hosts carries:

- `routes`: the `/_sim/api` prefixes this host answers, in mounting order and without duplicates. Each shared router publishes its own list (the `routes` export of `sim-dashboard-routes.mjs`, `sim-pack-routes.mjs`, `sim-messaging-routes.mjs`, `sim-flow-routes.mjs`, `sim-trace-routes.mjs` and `sim-environment-routes.mjs`, and `router.routes` of the runtime admin router, which lists only the prefixes whose callbacks the host supplied). The prefixes a host answers itself come from the one `[prefix, handler]` table its dispatcher iterates: standalone `/preflight` and `/operations`; Power Pages `/preflight`, `/session` and the portal administration prefixes such as `/personas`, `/scenarios`, `/state`, `/diagnostics`, `/config`, `/shutdown`, `/experiments`, `/portal-settings` and `/presets`. A prefix outside these tables answers 404, and a standalone runtime never lists a portal prefix. `/__sim/events` is outside `/_sim/api` and is not listed.
- `adminAdjacentRoutes`: the model-driven routes outside `/_sim/api` that act with administration rights, such as `POST /_apps/api/webapi` (see [model-driven apps](model-driven-apps.md#routes)).
- `modelDrivenApps`: the imported model-driven apps of the Solution metadata as `{ id, uniqueName, name }` (an empty array without apps).
- `docs`: the documentation links (see [Security headers](#security-headers)).

On the Power Pages host `GET /_sim/api/state` carries `docs` as status does. Dashboard request timestamps (`activity.requests.recent[].at`, `activity.dataverseRequests.recent[].at`) are ISO 8601 UTC. A standalone runtime has no portal request ring.

## Capabilities and preflight

The runtime status (`GET /_sim/api/state`, `simulator.state()`, standalone `status()`) carries `capabilities`, the legacy summary the administration page reads (`powerPages`, `modelDriven`, `organization`, the host surface booleans and the `canvas` / `codeApps` levels), and `capabilityReport`: every capability record of the running host with its level, plus the prerequisites no record provides.

`GET /_sim/api/preflight` answers the preflight report of the running host: its live operation catalogue (with the operation modes saved in `/_sim/`), packs, capability registry, local-service probes and storage readiness, and the source graph rebuilt with the active deployment profile bindings. `?requires=<id or glob>` (repeatable) scopes it to a scenario, and `?strict=true` makes every unsatisfied requirement in scope blocking. `simulator.preflight({ scenario, strict })` returns the same report on both runtime handles. The report never includes configured values. See [Capabilities and preflight](capabilities-and-preflight.md).

Canvas apps appear as `canvasapp:<name>` capability records with their level and the `canvas-apps` record; preflight lists `canvas:app/<name>` (controls not hosted) and `canvas:rendering`.

## Messages and outbox

- `GET /_sim/api/messages` lists the local message bus entities with their counts and the `providers.messaging.endpoints` mappings; `?entity=<name>` peeks up to `max` (default 100, at most 1000) messages of one entity. Without a bus it answers `configured: false`.
- `DELETE /_sim/api/messages/<entity>` purges one entity and needs the `x-sim-csrf` header.
- `GET /_sim/api/outbox` lists the captured outbox entries; `correlationId`, `channel` and `since` filter them. It is read-only.

Credential-named values (`authvalue`, connection strings, keys, passwords, secrets, tokens) are redacted in every answer. Both hosts mount these routes before the generic administration router. See [Messaging and outbox](messaging-and-outbox.md).

## Flow runs and waits

Both hosts mount the flow run routes next to the messaging routes. They need the organization's flow run store; without it they answer `FlowRunsNotConfigured` (501).

- `GET /_sim/api/flow-runs` lists run summaries, newest first; `processId` and `status` filter them. `GET /_sim/api/flow-runs/<runId>` returns one run with its action journal, never its trigger input or secure outputs.
- `GET /_sim/api/flow-waits` lists the waiting runs and their waits; `?state=overdue` or `?state=pending` compares each `timeoutAt` with the runtime clock.
- `POST /_sim/api/flow-waits/<waitId>` answers a wait and needs the `x-sim-csrf` header: `{ outcome: 'Approve' | 'Reject', responder, comments }` for an approval, `{ outputs }` for a delay or webhook wait. It records the response and schedules the resume of the run (202); the run then replays its journal and continues. A wait that was already answered is no longer listed (`FlowWaitNotFound`, 404); a second resume of the same wait that races the first fails with `FlowRunNotWaiting` (409), reported as a `FLOW_RUN_RESUME_FAILED` diagnostic.

- `POST /_sim/api/flow-runs` starts a tracked run on demand, `POST /_sim/api/flow-triggers/<flowId>` runs an HTTP Request trigger flow and `GET /_sim/api/flow-triggers` lists the trigger hosts; see [operations](operations.md#administration-routes). These run-starting requests and an HTTP Request trigger's signed callback URL are `http` trace roots of module `flows` on the serving host that join the caller's trace headers; the run is their child (see [request tracing](tracing.md#flows-and-connectors)).

Every flow payload passes through the same credential-name redaction as the messaging routes. A mutation is refused when the runtime has no CSRF token. See [flow runs, waits and approvals](operations.md#flow-runs-waits-and-approvals).

## Activity and trace routes

Both hosts mount the trace routes next to the flow run routes and answer them from the one trace store of the organization; without it they answer `TraceNotConfigured` (501). A `/_sim/api` write other than the trace routes and the run-starting flow routes is traced as an `http` root on host `sim` acting as the system actor `simulator`; administration reads open none.

- `GET /_sim/api/trace` lists trace summaries (each with the `auditId` of its root, or `null`), newest first unless `sort` and `order` say otherwise, with the query filters of [request tracing](tracing.md#api), including `result` (the activity's own result, a comma list) and `auditId`; `GET /_sim/api/trace/spans` lists span records and `GET /_sim/api/trace/stats` answers counts, percentiles, the timeline and the slowest and error spans for the same filters. An invalid filter, or a kind, status, sort, order or format outside its list, answers `InvalidTraceFilter` (400) with `parameter` naming it.
- `GET /_sim/api/trace/id/<traceId>` returns one trace as a tree (`TraceNotFound`, 404, when it is no longer retained); `GET /_sim/api/trace/<traceId>` answers the same for a UUID-shaped id. `GET /_sim/api/trace/span/<spanId>` returns one span (`SpanNotFound`, 404).
- `GET /_sim/api/trace/export?format=json|ndjson|otlp&limit=N` streams the matching traces as an attachment, at most `limit` of them (default 200, at most 2000); the `X-Trace-Export-Matched` header gives how many matched. See [Export](tracing.md#export).
- `GET /_sim/api/trace/settings` answers `{ settings, status }`; `PUT /_sim/api/trace/settings` changes the level, retention, payload cap or persistence at run time and needs the `x-sim-csrf` header (`InvalidTraceSettings`, 400, keeps the old value). `POST /_sim/api/trace/clear` drops every trace and `POST /_sim/api/trace/flush` waits until the queued persisted lines and live frames are written; both need the header too and answer the store status.

Both hosts serve the server-sent channel `/_sim/events?channels=trace`, which publishes `event: trace` frames for span starts, span ends and trace ends while a subscriber is connected; `events=trace-end` (or `span-start`, `span-end`, as a comma list) and `traceId=<id>` narrow what one client receives. The frames carry no captured inputs or outputs; every frame is written, and a client that stops reading is disconnected. Captured payloads are redacted when they are recorded; secret values, tokens, cookies and sealed flow outputs never reach the store.

The Power Pages host also serves the reads that join the other facts of an activity to it, and lists `/logs`, `/render-sources` and `/activity` in `status.routes`; the standalone host serves none of these three, nor `/audit`. `GET /_sim/api/diagnostics` answers on both hosts.

- `GET /_sim/api/logs?since=<sequence>&limit=<n>&type=<type,…>&traceId=<id>` answers the retained lines of the runtime log stream (`mirage.logs.retain`, default 2000) as `{ items, latestSequence, oldestSequence, retained, dropped, retain, more }`, oldest first. With `since`, the lines after that sequence; without it, the newest `limit` lines (default 500). A line is `{ sequence, type, time, level, traceId, spanId, … }`, with `traceId` and `spanId` `null` outside any activity; its `type` is `startup` (one per startup step, with `phase`, `elapsedMs` and `message`), `request`, `liquid` or `data` (the finished audit `entry`), `plugin` (one declarative plugin rule evaluated: `entity`, `operation`, `rule`, `result`, `changes`), `diagnostic` (the finding) or `reload` (`revision`, `message`). `limit` is 1 to 50000. A bad `since`, `limit` or `type` answers 400 `InvalidLogFilter` naming its `parameter`. The `/_sim/events?channels=logs` stream carries the same lines; its `connected` frame names the latest retained sequence.
- `GET /_sim/api/diagnostics?traceId=<id>` narrows the findings and the portal request ring to one activity. A finding raised during a request carries `traceId` and `spanId`; a finding raised while loading sources carries neither. Plug-in step and flow trigger completions (`PLUGIN_ASYNC_COMPLETED`, `PLUGIN_ASYNC_FAILED`, `FLOW_TRIGGER_COMPLETED`, `FLOW_TRIGGER_SKIPPED`), connector calls (`CONNECTOR_INVOKE`) and flow actions (`FLOW_ACTION`) also carry `name` (the step, flow, operation or action name), `entity` (the table, when there is one) and, for plug-in steps, `message`; Findings shows that name instead of an id.
- `GET /_sim/api/audit?traceId=<id>[,<id>…]` and `/audit/export` select the audit entries of up to 200 activities (more answers 400 `InvalidAuditFilter`).
- `GET /_sim/api/render-sources?refs=<id>[,<id>…]` resolves the `sourceRefId` of up to 100 render template steps to `{ sourceDir, items: [{ id, path, file, line, column, kind, name, recordId, field, languageId }], missing }`; `line` and `column` are `null` when the file no longer holds the loaded text. Without refs or with more than 100 it answers 400 `InvalidRenderSourceRefs`.
- `GET /_sim/api/activity/export?<trace filters>&format=bundle[&traces=ndjson|otlp][&limit=N]` streams the [activity bundle](tracing.md#activity-bundle).

## Health feed

Both hosts (Power Pages and standalone model-driven or Dataverse API runtimes) answer `GET /_sim/api/dashboard` with one read-only JSON document. It is `no-store` and never carries the administration CSRF token. Every part except `activity` passes through the same credential redaction as `/_sim/api/messages`; `activity` holds numbers only (plus request `at`, `method`, `path`, `traceId` and `spanId`, storage provider `id` and `lastReloadAt`), so a diagnostic code or counter whose name looks like a credential keeps its count. `HEAD` answers like `GET` without a body; any other method answers 405 with `Allow: GET, HEAD`. The route answers 503 `{ "status": "starting" }` only for a host that has not created its organization; both hosts create it before their listener opens, so a running runtime does not answer 503.

Top-level keys:

- `generatedAt`: ISO time from the runtime clock (a fixed clock shows simulated time).
- `runtime`: `startedAt` (ISO time the runtime started, on its clock) and `uptimeMs` (read fresh on every answer), `product`, `kind`, `simulationLevel`, `clock` (`system` or `fixed`), `revision` (the source reload revision on Power Pages, `null` on the standalone host), `storeRevision`, `reloading`, `localOrigin`, `stateFile` (relative to the project root, `null` for dry-run), `projectRoot` (`.`). Power Pages adds `deploymentProfile`.
- `nodes`: `{ id, kind, label, status, level?, detail, link? }`. Ids follow one scheme on both hosts: `client:*`, `host:*`, `org:store`, `org:security` (role, user and team counts), `org:plugins`, `org:workflows`, `org:flows`, `org:jobs`, `org:trace` (the trace store: `level`, `persist` and `persistError`, linking to `#activity`; the map shows it as **Activity** in its **Monitor** group), `org:<module>` for every installed organization module, `provider:storage`, `provider:storage-route:<route>`, `provider:messaging`, `provider:messaging-endpoint:<entity>`, `provider:outbox`, `provider:connectors`, `connection:<id>`, `provider:secrets`, `provider:local-service:<id>`, `provider:service-fixture:<service>`, `provider:powerfx`, `app:canvas`, `app:code`, `external:azurite`, `external:servicebus-emulator`, `external:keyvault`, and one `external:webhook:<hostname>` per web hook target host (`listening` when the delivery rule contacts it: `http` or `https` to `localhost`, `*.localhost`, `127.0.0.0/8` or `[::1]`; `declared` otherwise; its `detail` carries `endpoints` and the same `loopback` flag). Power Pages adds `host:portal` (linking to `#home`), `host:identity-provider`, `app:pcf`, `bridge:live` and one `persona-runtime:<id>` per running persona runtime. Status is one of `listening`, `ready`, `declared`, `disabled`, `placeholder`, `missing`, `error`, `planned`. `link` names the `/_sim/` view that owns the node.
- `edges`: `{ from, to, kind, status, label }` with kind `http`, `bus`, `storage`, `webhook`, `process` or `reads`. Each web hook target node gets a `webhook` edge from `org:plugins`. Edges are the calls the runtime really makes, traced to code. Save hooks run inside the records layer, so `org:store` points at the modules they belong to (business rules, formula and rollup columns, workflows, file storage routing and more). Web API messages and routes are dispatched by the Web API host itself, so `host:dataverse-api` points at each message module; with the listener switched off, `host:model-driven` does, because its in-app Web API runs the same messages. Background work goes through `org:jobs`, and Power Fx, storage routes, the outbox and secret references are reached from the modules that use them. The model-driven shell calls its own in-app Web API on the host origin (`/_apps/api`) in process as the staff user, so `host:model-driven` points at `org:store` and works with the Web API listener switched off. Code components call `/_api` of their portal page, or `Xrm.WebApi` of a model-driven form with trusted extensions. Visitor sign-in (`host:identity-provider`) is reached by the browser and the portal; Web API tokens come from the authority on the Web API listener. The administration reads and writes records and state, probes local services during preflight, triggers HTTP flow triggers and connects the live portal connection; setup reads the administration status views. An edge is sent only when both of its ends are on the runtime, and an edge that touches a `disabled` node is `disabled` itself: the map lists those on the card ("Switched off: would connect to …") instead of drawing them. A node that nothing calls at runtime says why in `detail.note`.
- `activity`: Dataverse API requests (`total` and `failed`: data-plane Web API requests under `/api/data/v*` since start, `$metadata` excluded; `other`: token, discovery, metadata document, SOAP and every other request on the Dataverse listener; TDS has its own listener and is not counted; the last 20 requests of any kind as `at`, `method`, `path`, `status`, `ms`, `traceId` and `spanId`), plug-in executions and failures, flow runs by status and overdue waits, durable jobs (pending, scheduled, running, recent failures, poisoned rows), asyncoperation rows by state, bus messages by state, outbox rows by state and pending byte deletes, web hook outcomes (`delivered`, `failed`, `notContacted`), storage operations per provider (`byProvider: [{ id, writes, deletes, bytesWritten }]`), diagnostics (`total`, `byCode`), the trace store (`trace`: `retained` traces, `spans`, `running`, `dropped`, `droppedSpans` and `latestSequence`; the `org:trace` drawer shows them with the node) and the raw counters. Power Pages adds the portal requests (`total` since start, `retained` ring length, at most 300; `recent` is the last 20, each with its `traceId`), `audit` (`retained`, `sequence`, `dropped`) and `reloads` (`revision`, `lastReloadAt`). Standalone adds `inFlight` (requests in progress other than this one) and reports `reloads: null`.
- `configuration`: pack ids with their module directory relative to the project root, Solution layers (`solution`, `version`, `type`), `settingsKeys` (names of the registered settings authored in the catalogue site, project file or project portal that the CLI or `createMirageContext` started from, never values; `null` for a runtime embedded through `createSimulator`, whose configuration source is not known) and `ports` (`portal`, `dataverseApi`, `dataverseTls`, `tds`, `identityProvider`, each a number or `null`).
- `docs`: the documentation link map (see `status.docs`).

Counters count activity since the organization runtime started; they are not persisted. Storage counters count operations through the storage router, not what the store holds: `writes` (an overwrite is a write), `deletes` and `bytesWritten` only grow. The shared part is rebuilt after a store write, a counter change, or at most every 5 seconds so that message lock and schedule states and overdue waits follow the clock; two reads in the same 5-second window without activity return identical `nodes`. `activity.trace` is read on every request, because each traced request moves it without a store write; `nodes` carry configuration and topology only, so portal requests alone never change them. Safe facts only: service endpoint URLs appear as a hostname, connections as id, provider and principal kind (never `settings`), secrets as a key count. The feed never reads `GET /_sim/api/dataverse`, which shows the managed identity header once. Preflight is not part of the feed; call `GET /_sim/api/preflight` when you need it.

## Pack inventory

Both hosts answer `GET /_sim/api/packs` with every registered pack (project `dataPacks`, explicit catalogue or `--pack-module` entries, and module paths supplied to the API). Each pack carries `id`, `name`, `description`, `module` (relative to the project root), `registration` (`source`: `project` for a pack listed in the project file, `explicit` for a catalogue `mirage.dataPacks` entry or a `--pack-module` path, `api` for a pack passed to `createSimulator({ packs })`; `setupLink`: `/_setup/#packs`), `matched` and `matchReason`, `exports` (count per recognised export), `presets` (`id`, `name`), `configurationPresets`, `personas`, `personaCatalog` counts (`groups`, `personas`, `contexts`, `scenarios`), `dataFiles` (`file`, `tables`, `writable` when the current simulation writes it, `ownedTables`) and its export `diagnostics`. On Power Pages `matched` is the pack's `matches({ portal })` result for the current portal, so packs the portal filtered out are listed with `matched: false`; the standalone host has no portal and reports `matched: null` with `matchReason: "no portal context"`. `library` lists every data preset with its `pack` (or `null`) and `source`; `failed` lists modules that did not load. The route is read-only: `HEAD` answers like `GET` without a body, other methods answer 405 with `Allow: GET, HEAD`. Register or change packs in `/_setup/` and restart.

## Environment administration on both hosts

`GET /_sim/api/environment`, `PUT /_sim/api/environment/variables/<schemaName>` (`{ "value": "text" }`, or `null` to remove the local value) and `DELETE /_sim/api/environment/variables/<schemaName>` are served by both hosts. Writes need the `x-sim-csrf` header. A local value is kept as an override, so a Solution reload keeps it. A Secret definition accepts a Key Vault secret reference only and never shows a value. `PUT /_sim/api/environment/profiles` selects a deployment profile on the Power Pages host. The standalone host loads `deploymentProfiles` too (see [standalone organization](standalone-organization.md#shared-composition)): its `profileSelection` summarises the active profile, or answers `{ "supported": false, "reason": "…" }` when none is configured; its `PUT /environment/profiles` answers 501 with the same summary, and its `live` field says the live bridge belongs to the Power Pages host. The standalone `GET /_sim/api/diagnostics` and `status.diagnostics` carry `byCode`.

## Security headers

Both hosts serve `/_sim/` with `Content-Security-Policy: default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'` and `X-Content-Type-Options: nosniff`. Admin assets are served by pattern: `/_sim/<name>.mjs` or `/_sim/<name>.css` where `<name>` matches `^[a-z0-9-]+$` and the file exists in `mirage/admin/`, plus the shared modules `persona-search.mjs` and `persona-picker-view.mjs` from `mirage/lib/`. The page itself answers only at `/_sim` and `/_sim/`. Modules are `text/javascript`, every asset carries `nosniff`, and any other path answers 404 on both hosts, including `/_sim/index.html`, `..` and encoded separators, backslashes, upper-case names, nested paths, server-side library modules and Windows device names such as `con.mjs`. The page allows no inline script or inline style.

`GET /_sim/api/status` carries `docs`: a map of documentation keys to `{ href, path, label }`, where `path` is the repository path and `href` points at the release tag of the installed version (`main` for a prerelease).
