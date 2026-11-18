# Local simulation administration

`/_sim/` is the loopback administration workspace of a running Mirage runtime. It is served on its own port, printed as
`adminUrl`; `/_sim/` on the portal address redirects there. It manages local tables and records, portal and organization
identities, roles and permissions, presets and scenarios, settings and snippet overrides, the runtime environment,
providers, backend operations and what the runtime did. Every change affects only local state and rendering. `/_sim/`
and [`/_setup/`](../../docs/setup.md) share one shell with an **Areas** switch: `/_sim/` for daily work, `/_setup/` for
project configuration (applied on restart).

`/_sim` and `/__sim` are the same path family. The page calls `/__sim/api/...`; this guide writes `/_sim/api/...`.

## Sign-in and sessions

Portal requests start anonymous. Local sign-in selects an active synthetic contact (or an explicit role override) and
sets a per-runtime `paqvilo-mirage-auth-<port>` cookie. The portal sign-in page, `/_sim/` and Lense **Tweaks** all act
on the browser's own session: signing one browser in does not sign another in, and the saved simulator identity is not a
substitute for a request cookie. Sign-out clears only the local session. Persona selection, grouped pickers and isolated
setups are described in [persona catalogues](persona-catalog.md); `/_sim/#access` selects this browser's persona.

`simulator.identityScope` is `"sessions"` (the default) or `"configured"` (`"all-requests"` is an alias). With
`"configured"`, a portal request without a visitor cookie uses the saved configured identity, with its normal membership
or role-override resolution and permission checks; a valid visitor cookie, including the explicit anonymous cookie
sign-out issues, still wins. It creates no session. Use it only for offline tooling that cannot hold cookies.
Administration requests always use the configured identity. These are local simulation settings, not Power Pages
authentication settings.

Programmatic sign-in: `simulator.signIn(contactId)` returns a cookie header; Playwright tests use `signInContext`, and
HTTP tools `createPortalSession`, `connectRuntime().createSession` and `runSessionMatrix` from `paqvilo/mirage/testing`.
`connectRuntime().signIn(null, { configuredPersona: true })` needs a configured contact (`identity.contactId`, or legacy
`identity.id`) and otherwise fails with `MISSING_PERSONA_CONTACT` before any request. Visitors sharing a runtime share
its settings, sources and data, so give each its own write fixtures; run separate processes and state files for
different configuration. The helpers, the audit, diagnostics and log readers and their filters are documented in the
[public API](../../docs/public-api.md#connect-to-a-running-local-runtime) and
[test many visitors concurrently](../../docs/public-api.md#test-many-visitors-concurrently).

The local external identity provider simulates exported provider settings with a local route and explicit redirect
handling. It never copies live credentials or mints environment tokens; live-reference sign-in belongs to the intended
signed-in browser. Permission enforcement can be set to enforced or permissive for local experiments, and evidence
records the choice. Live create, update and delete need both `--allow-live-writes` and the `/_sim/` live writes switch;
neither authorizes a business operation.

### Verification witness

`runtime.witness({ tables: ['fixture'] })` and `visitor.witness({ tables: ['fixture'] })` (from `connectRuntime` and
`createPortalSession`) read `GET /_sim/api/verification-witness?tables=<a,b>`: a read-only hash of one to 32 distinct,
existing logical tables, taken in one atomic `DataStore.readOperation`. It hashes effective permissions, mappings,
settings, operation mode, source and runtime fingerprints, actor fields and every stored column of the selected tables,
without calling SDK or plug-in retrieval, and returns hashes and counts, never row bodies, setting values or
credentials. A visitor's witness uses its own cookie, so it resolves the same portal identity as its requests.
`compareVerificationWitnesses(before, after)` reports the changed hash categories; runtime instance and revision changes
are reported separately, so a write to an unselected table is not mistaken for fixture drift. Unselected tables get no
coverage. Keep the state file outside the export (the source fingerprint observes files in the export), and verify
external plug-in DLL bytes separately: a definition hash does not cover them. A witness is a local comparison boundary,
not native parity.

## Routes

`GET /_sim/api/status` lists the prefixes a host answers in `routes`; anything else under `/_sim/api` answers 404
`Admin endpoint not found.`. Writes (any method other than GET, HEAD and OPTIONS) need the administration token in
`x-sim-csrf` ([tokens](#tokens)); without it they answer 403 `Missing simulator CSRF token.`. Both hosts answer HEAD on
every GET route like the GET, without a body and without side effects: a HEAD never reveals or spends the one-time
managed identity header of `GET /_sim/api/dataverse`.

Errors are `{ "error": { "code", "message", "parameter"? } }`. An administration 400 for a refused query parameter or
body field names it in `parameter` (for example `/logs`, `/audit`, `/render-sources`, `/activity/export`,
`/verification-witness` without `tables`, and a non-boolean `applyConfiguration` of a preset apply). The boolean query
parameters `?strict` (`/preflight`) and `?summary` (`/state`) take `true` or `1` and `false` or `0` (empty or absent is
false); any other value answers 400 `InvalidQueryParameter`. On the portal address, refusals of `/__sim/api`, native
form posts, pack endpoints and any request whose `Accept` names JSON but not HTML use this envelope; a missing
`/_sim/<asset>` answers plain text, and other portal paths an HTML page.

| Prefix                                                                          | Host        | Purpose                                                                                                              |
| ------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------- |
| `/status`                                                                       | both        | [Status payload](#status-payload)                                                                                    |
| `/state`, `/simulation`, `/diagnostics`                                         | both        | Runtime state; [simulation level](simulation-levels.md#inspect-and-change-a-level) report; findings                  |
| `/config`                                                                       | both        | Power Pages: `PATCH` only. Standalone: `GET`, and `PATCH` of `operations` (else 409 `RuntimeRestartRequired`)        |
| `/platform-settings`                                                            | both        | Platform rules: `GET`, `PATCH`, `DELETE /platform-settings/<key>` ([experiments](configuration-experiments.md))      |
| `/dataverse`                                                                    | both        | Organization identity and API, one shape on both hosts ([Dataverse API](dataverse-api.md#administration))            |
| `/records/<table>[/<id>]`                                                       | both        | Local record administration                                                                                          |
| `/preflight`                                                                    | both        | [Capabilities and preflight](#capabilities-and-preflight)                                                            |
| `/operations`                                                                   | both        | Backend operation inventory ([operations](operations.md))                                                            |
| `/model-driven/offline`                                                         | both        | Mobile offline summary of every staff session                                                                        |
| `/dashboard`                                                                    | both        | [Health feed](#health-feed)                                                                                          |
| `/packs`                                                                        | both        | [Pack inventory](#pack-inventory)                                                                                    |
| `/environment`                                                                  | both        | [Environment administration](#environment-administration-on-both-hosts)                                              |
| `/messages`, `/outbox`                                                          | both        | [Messages and outbox](#messages-and-outbox)                                                                          |
| `/flow-runs`, `/flow-waits`, `/flow-triggers`, `/connections`                   | both        | [Flow runs and waits](#flow-runs-and-waits); connection sign-in (`/connections/<id>/authorize`, `/authorization`)    |
| `/trace`                                                                        | both        | [Request tracing API](tracing.md#api)                                                                                |
| `/activity`                                                                     | both        | `/activity/export`, the [activity bundle](tracing.md#activity-bundle)                                                |
| `/session`                                                                      | Power Pages | `GET /session`; `POST /session/sign-in`, `/sign-out`, `/roles`, `/portal-ticket` ([ticket sign-in](#ticket-sign-in)) |
| `/personas`, `/persona-catalog`, `/persona-runtimes`, `/scenarios`              | Power Pages | [Persona catalogues](persona-catalog.md#api-and-testing) and scenarios                                               |
| `/presets`, `/experiments`                                                      | Power Pages | [Data presets](#data-presets) and [configuration presets](configuration-experiments.md#automation)                   |
| `/portal-settings`, `/portal-snippets`, `/portal-roles`, `/portal-access-rules` | Power Pages | Portal configuration and overrides                                                                                   |
| `/mappings`, `/plugins`, `/permissions`, `/endpoints`                           | Power Pages | Entity mappings, declarative plug-in rules, permissions, pack endpoints                                              |
| `/page-resources`, `/page-provenance`, `/verification-witness`                  | Power Pages | Source inspection and the [verification witness](#verification-witness)                                              |
| `/audit`, `/logs`, `/render-sources`                                            | Power Pages | [Activity reads](#activity-and-trace-routes)                                                                         |
| `/reference`, `/assets`, `/live`                                                | Power Pages | Reference enrichment, asset capture, live connection (`/live/connect`, `/live/disconnect`)                           |
| `/reset`, `/reload`                                                             | Power Pages | `POST`: reset state, reload sources                                                                                  |
| `/shutdown`                                                                     | both        | `POST`: stop the runtime (202)                                                                                       |

Outside `/_sim/api`: `/_sim/events` (server-sent `logs` and `trace` channels), `/__sim/sign-in`,
`/__sim/session-token/<ticket>` and the other portal paths in the [allow-list](#portal-address-allow-list).

### Data presets

`GET /_sim/api/presets` lists the runtime's data presets (built-in, pack and saved); `GET /presets/<id>` answers one,
`POST`, `PATCH` and `DELETE` manage saved ones. `POST /presets/<id>/apply` takes `{ "applyConfiguration": true }`
(optional boolean; also apply the preset's linked [configuration preset](configuration-experiments.md)) and answers the
runtime state. An apply of an unknown id answers 404
`Preset '<id>' not found; GET /_sim/api/presets lists this runtime's presets and paqvilo mirage --help the registry presets.`;
`GET`, `PATCH` and `DELETE` of an unknown id answer 404 `Configuration item not found.`.

A preset replaces each business section it carries (`mappings`, `tables`, `permissions`, `plugins`, `settings`) and
keeps the rest. Its table mappings are declared schema and are accepted at every
[simulation level](simulation-levels.md#private-runtime-and-identity-state); any other schema it carries (custom API
definitions, request parameters, response properties) is refused below `deep` (403 `SimulationSchemaDisabled`, nothing
applied). `POST /_sim/api/mappings` at `dry-run` or `simulation` is still a schema change (403
`SimulationSchemaDisabled`). Its rows follow the level:

- `dry-run`: the rows replace memory only; no file is written.
- `simulation` and `deep`: an apply through `/_sim/` writes the preset's rows to the pack DATA files. Every business
  table the preset writes needs a DATA owner; otherwise the apply answers 409 `SimulationDataTargetRequired` (naming the
  first table without an owner) and nothing changes.
- A startup preset (`--preset`, `mirage.preset`) keeps the rows of every table a pack DATA file owns, in `bootstrap` and
  `always` mode and when the private checkpoint was removed; tables without an owner take the preset's rows.

## Administration origin

The Power Pages host has three loopback listeners on one host literal, each on its own port: the portal (`url`), the
administration (`adminOrigin`, an ephemeral port) and the apps (`appsOrigin`, an ephemeral port, Power Pages host only).
The standalone host has a main listener, which serves its apps and API and has no portal, and the administration
listener. Every listener refuses a `Host` header that is not its own address.

| Listener                                | Serves                                                                                                                                                                               | Token         |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------- |
| Portal (`url`)                          | The portal. Browsers reach administration and apps paths only through the [allow-list](#portal-address-allow-list) or a redirect; programmatic clients reach all of `/_sim/api` here | `portalToken` |
| Administration (`adminUrl`, `setupUrl`) | `/_sim/` (page, assets, `/_sim/api`, `/_sim/events`, evidence) and `/_setup/`                                                                                                        | `csrf`        |
| Apps (`appsUrl`, Power Pages host only) | `/main.aspx`, `/_apps` and `/_apps/*` except `/_apps/portal-documents/*`, `/api/data/v9.*`, and `/__sim/api/dataverse/session`                                                       | `appsToken`   |

On the standalone host the main listener carries `appsToken`, which is also its page token, and the administration
listener carries `csrf`. The standalone host has no `portalToken`.

### Browser and programmatic requests

A browser request carries `Sec-Fetch-Site` or `Origin`. Scripts cannot remove either header, and a script cannot forge
`Origin`. A request with neither header is programmatic: Node `fetch`, Playwright `context.request`, the CLI, curl and
the Lense node process. Only browser requests are gated. Programmatic requests get the complete behaviour of the portal
address: all of `/_sim/api`, `csrf` in status and state, writes with the administration token, and the apps paths.

### Portal address

- A top-level navigation (GET or HEAD with `Sec-Fetch-Mode: navigate`) to an administration path is answered with a 302
  to the administration origin, with the same path and query; the browser keeps the fragment. A navigation to an apps
  path is answered with a 302 to the apps origin.
- Any other browser request to an administration path is answered 403 `AdminOriginRequired`, and to an apps path 403
  `AppsOriginRequired`, unless it is on the allow-list.
- Paths outside both families are served to browsers on the portal address.

### Administration and apps addresses

- A `Host` header that is not the listener's address is answered 403 `Invalid Host header.`.
- An `Origin` other than the listener's own is answered 403 `CrossOriginAdminRequest` (`CrossOriginAppsRequest` on the
  apps address).
- A `Sec-Fetch-Site` other than `same-origin` or `none` is answered 403 `CrossSiteAdminRequest`
  (`CrossSiteAppsRequest`), unless the request is a navigation.
- A write (any method other than GET, HEAD or OPTIONS) that carries `Sec-Fetch-Site` but no `Origin` is answered 403
  `CrossOriginAdminRequest` (`CrossOriginAppsRequest`).
- A navigation to a served document is served from any site. The administration page keeps `frame-ancestors 'none'`;
  Canvas and Code Apps pages send `x-frame-options: SAMEORIGIN`.
- A GET or HEAD for a path the listener does not serve is redirected to the portal address with the same path and query.
  Any other method is answered 404 `PortalOriginRequired`.

### Portal address allow-list

Browser requests to these paths are served on the portal address, with any `Sec-Fetch-Site`. Every other administration
and apps path is refused to browsers as described above.

| Method          | Path                                                                                                                    | Purpose                                                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET, HEAD       | `/__sim/events`, unless `channels` names `logs` or `trace`                                                              | The reload stream; it carries revision numbers only                                                                                                       |
| POST            | `/__sim/forms/(entityform\|webform)/<id>/submit`                                                                        | Native form submission; needs the portal token and the visitor's identity                                                                                 |
| GET, HEAD, POST | `/__sim/sign-in`                                                                                                        | `GET ?persona=<key>` shows one catalogue persona (400 without it); POST needs the portal token and sets only this browser's session                       |
| GET, HEAD, POST | `/__sim/frame-ready/<id>`                                                                                               | Frame ordering: the image is held until the page's POST reports that the DOM or jQuery is ready                                                           |
| GET, HEAD       | `/__sim/persona-picker.css`, `/__sim/persona-picker.mjs`, `/__sim/persona-search.mjs`, `/__sim/persona-picker-view.mjs` | Static code of the sign-in page's picker                                                                                                                  |
| GET, HEAD       | `/__sim/api/personas` (exact path)                                                                                      | The persona catalogue the sign-in page shows; the writes of this catalogue are administration-only                                                        |
| any             | `/__sim/api/flow-triggers/<id>/triggers/<name>/paths/invoke`                                                            | Authenticated by the signed callback URL, as on the platform                                                                                              |
| any             | Registered pack endpoint paths                                                                                          | Trusted pack routes for visitors; the handler requires sign-in and the portal token for writes                                                            |
| GET, HEAD       | `/__sim/session-token/<ticket>`                                                                                         | Ticket consumption; a browser GET that is not a navigation is refused with `TicketInvalid` and a HEAD answers 405 `Allow: GET`; neither spends the ticket |

The table is the `PORTAL_ROUTES` list of `mirage/lib/admin-origin.mjs`, with the pack endpoints checked by the runtime.
Two administration paths are not on the list: `/__sim/api/dataverse/session` is served on the apps and administration
addresses, and `/__sim/api/session/portal-ticket` is answered on the administration address to browsers, while
programmatic clients on the portal address reach it with the administration token.

### Ticket sign-in

The administration signs a browser in through the portal with a single-use ticket. The console calls
`POST /_sim/api/session/portal-ticket` with `{ action: 'sign-in' | 'sign-out', contactId?, provider?, returnHash? }` and
the administration token. The answer is `{ url, expiresAt }`, where `url` is `<portal>/__sim/session-token/<ticket>`,
and it sets the binding cookie `paqvilo-mirage-ticket-<portal port>` (`HttpOnly`, `SameSite=Strict`,
`Path=/__sim/session-token`, `Max-Age=60`). The console then navigates the tab to `url`.

- The ticket is 256 random bits. The server keeps its SHA-256 digest and the binding's digest in memory only, at most 16
  tickets, and drops the oldest when a seventeenth is minted.
- A ticket is valid for 60 seconds on the store clock.
- The first navigation (or programmatic GET) that presents a ticket deletes it. A HEAD answers 405 `Allow: GET` and a
  browser request that is not a navigation answers `TicketInvalid`; neither spends it. Any further attempt, an expired
  ticket, or a ticket presented without the matching binding cookie is refused with the same 403 `TicketInvalid` answer,
  so no answer tells a guessed value from a spent one.
- A navigation that spends a valid ticket is answered with a redirect into the administration. A local persona sets the
  portal session cookie and returns to `/_sim/<returnHash>` (default `#access`). A provider starts external sign-in with
  the contact as login hint. A sign-out ends a signed-in session through the portal's log-off, and otherwise returns to
  the administration.
- Minting refuses an inactive or unknown contact (404 `PERSONA_CONTACT_UNAVAILABLE`), an unknown `action` or provider or
  a malformed `returnHash` (400 `InvalidTicketRequest`), and local sign-in while it is turned off and providers exist
  (409 `LocalSignInDisabled`). A mint with the portal token (403 `Missing simulator CSRF token.`), or a browser-shaped
  mint from the portal address (403 `AdminOriginRequired`), is refused.
- The ticket and its binding are not logged or traced.

### Tokens

Each token is 32 random bytes, fixed for the life of the runtime.

- `csrf`, the administration token: on the handle, and in `csrf` of status and state. It is accepted in `x-sim-csrf` on
  the administration writes under `/_sim/api`, and in the body-token fields of the sign-in and persona forms. On any
  other path the gate replaces it with the page token or the apps token before a route sees it, so it is accepted
  wherever those tokens are, and no page carries it.
- `portalToken`, the portal's anti-forgery token: the value the portal's markup and `/_layout/tokenhtml` carry as
  `__RequestVerificationToken`. The portal's form posts, pack endpoint writes and native view state check it.
- `appsToken`, the apps token: on the handle (on the standalone host it is the page token). The app pages send it: the
  model-driven shell in `meta[name="mirage-csrf"]`, the Canvas player in `data-csrf` and the `_csrf` field of its form
  posts, and the Code Apps `GET context` response in `x-sim-csrf`. It is accepted in `x-sim-csrf` by the apps Web API,
  the Canvas actions, the Code Apps routes and `/__sim/api/dataverse/session`.

### Residual

Isolation relies on the Fetch Metadata request headers browsers send: Chromium 76+, Firefox 90+, Safari 16.4+. A request
without `Sec-Fetch-Site` and `Origin` is served as a programmatic client, so page scripts in an older browser are not
isolated.

## Views and host awareness

A view is shown only when its host serves the route it needs. The page reads `status.routes` and `status.eventChannels`
(see [Status payload](#status-payload)); without them it probes each required route once per session, and only a 404
hides the view. Views of the portal source need `page-resources`, which only the Power Pages host serves, so a
[standalone profile](standalone-organization.md) has no portal personas, live bridge or rendering controls. An empty
hash opens `#health`, an unknown one `#home`; `#<view>?panel=<key>` scrolls to a panel. `/_sim/` follows the browser's
colour scheme; `/_setup/` stays light.

| View (hash)                                                    | Hosts       | Purpose                                                                                                                                                                               |
| -------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#home`, `#health`, `#activity`                                | both        | [Monitor](#monitor)                                                                                                                                                                   |
| `#records`                                                     | both        | Local records, paged and sorted on the runtime; each row links to `#activity?table=<logical name>&recordId=<id>`                                                                      |
| `#packs`                                                       | both        | [Pack inventory](#pack-inventory); add packs in [`/_setup/#packs`](../../docs/setup.md#journey) and restart                                                                           |
| `#plugins`, `#mappings`, `#endpoints`, `#portal`, `#overrides` | Power Pages | Declarative plug-in rules and presets, entity mappings, pack endpoints, portal configuration, settings and snippet overrides ([experiments](configuration-experiments.md))            |
| `#services`                                                    | both        | Storage, messaging, outbox, connectors and connections, secret references (names only), local services with **Probe now**, service fixtures, Power Fx, app inventories, SharePoint    |
| `#flows`                                                       | both        | Flow runs and their journal, waits and approvals, durable jobs, scheduler, asyncoperation rows, poisoned rows, web hook outcomes ([routes](#flow-runs-and-waits))                     |
| `#capabilities`                                                | both        | Capability report and preflight ([below](#capabilities-and-preflight)); on Power Pages, **Preflight this scenario** per saved scenario                                                |
| `#operations`                                                  | both        | Backend operation modes ([operations](operations.md#choose-local-behaviour)), each row linking to its recent activity                                                                 |
| `#environment`, `#platform`                                    | both        | [Environment administration](#environment-administration-on-both-hosts); platform rules such as the link-entity budget                                                                |
| `#access`, `#scenarios`                                        | Power Pages | This browser's persona ([persona catalogues](persona-catalog.md)), linking to `#activity?who=<contact id>`; scenarios                                                                 |
| `#dataverse`                                                   | both        | Organization identity: staff users and roles, application registrations, secrets (shown once), certificates, federated credentials ([Dataverse API](dataverse-api.md#administration)) |
| `#runtime`; `#connection`                                      | both; PP    | Surface, simulation level, persistence, workspace export and import, fingerprints; the live connection                                                                                |

The `/_sim/` record editor is explicit local administration; model-driven requests use the selected staff principal with
its row and field security. Backend operation rows link to
`#activity?kind=plugin-step&actorKind=plugin&actorId=<step id>`,
`#activity?kind=flow-run&actorKind=flow&actorId=<process id>`, `#activity?kind=server-logic&q=<name>` or
`#activity?kind=workflow&q=<name>`.

## Monitor

**Health** answers whether the runtime is wired and up, **Activity** what it did. **Home** (`#home`) holds a **First
run** checklist derived from runtime facts (a standalone runtime shows **Start working** with its app links). Times show
as local `HH:MM:SS.mmm`, with date and UTC on hover. A **Who** value reads like `Ada Member · contact:1a2b3c4d` or
`Visitor accb980f`; a **plug-in step** is an exported Dataverse plug-in step, a **plugin rule** a declarative rule of
Plugins & presets.

### Health

`#health` renders [`GET /_sim/api/dashboard`](#health-feed) every 5 seconds while visible: a banner with a readiness
pill (`OK`; `DEGRADED` when a component reports an error or is missing; `BLOCKED` when preflight reports blocking
requirements), key-number tiles with an **Expand** timeline (from `GET /_sim/api/trace/stats?from=<runtime.startedAt>`;
Findings from `/diagnostics`), the system map of `nodes` and `edges`, an on-demand preflight and the configuration.
Health counts everything since start and works with tracing off; Activity's Stats counts only the kept, filtered
activities, so either can be higher.

Each tile links into Activity: **Portal requests** (pages and the portal's `/_api`) `#activity?host=power-pages`,
**Dataverse Web API** (the organization listener, not the portal's `/_api`) `#activity?host=dataverse-api`, **Plug-in
step runs** `#activity?kind=plugin-step`, **Flow runs** `#activity?kind=flow-run`, **Jobs pending**
`#activity?kind=job`, **Failed** `#activity?hasErrors=true` and **Findings** `#activity?tab=findings`; a tile's **N
failed** adds `&status=error`. Messages, Outbox and Storage writes are levels or provider counters and open their
Providers & services panel.

### Activity

`#activity` lists every activity (trace) with its request audit entry, log lines and findings. Results, failed
activities, browser probes and what joins a trace are defined in [request tracing](tracing.md#reading-a-trace). The
address is the whole view state, so a view is a shareable link:

```text
#activity?range=15m&result=error,denied&who=contact:<id>&table=contact&recordId=<id>&host=power-pages&q=<text>&live=1
```

- **Filters:** `range` (`5m`, `15m`, `1h`, `24h`; or `from` and `to`), `result` (comma list), `who` (`anonymous`,
  `visitor:<id>`, `<kind>:<id>` or a bare id), `table` (logical or entity set name), `recordId`, `host` (any letter
  case), `q`; under
  **More filters** the [trace filters](tracing.md#filters) `kind`, `module`, `operation`, `status`, `hasErrors`,
  `minDurationMs`, `session`, `portal`, `auditId`, and the request audit keys `path`, `provider`, `auditKind`,
  `httpStatus`. Ids accept a prefix of at least 8 hexadecimal characters; an ambiguous prefix matches every candidate. A
  `whoName` label is shown on the chip and never sent to the runtime.
- **State keys:** `tab=log|findings|pages|stats`, `type` (log type), `reads=1`, `sort`, `order`,
  `#activity/<traceId>[/<spanId>]`, `detail`, `steps=tree`, `spanSearch`, `errorsOnly`, `compare=<id1>,<id2>`. The older
  keys `entity`, `search`, `sessionKey`, `actorKind`, `actorId` and `visitorId` are read as `table`, `q`, `session` and
  `who`.
- **Tabs:** Activities (Liquid and FetchXML reads made during a render fold into the page; **Show reads** lists them),
  Log stream (retained server-side, `mirage.logs.retain`), Findings (one row per code), Pages & render (route, render
  time, template files and lines, rendering evidence) and Stats. Each tab is shown only when the host serves its route
  or channel.
- **Live** follows `/_sim/events?channels=trace&events=trace-end`, or the audit through the `logs` channel when tracing
  is off. **⚙ Settings** changes the trace level, persistence and retention without a restart and has **Clear
  activities** (audit, log lines and findings stay). **Export** (current filters, at most 200 activities) downloads the
  [activity bundle](tracing.md#activity-bundle), optionally with `traces=otlp`, or the activities alone from
  `/trace/export`.
- **Tracing off:** the request audit keeps recording and Activities lists it; any audit key (`path`, `provider`,
  `auditKind`, `httpStatus`) also lists the audit. A standalone host has no request audit, log stream or portal: no Log
  stream or Pages & render tab, and Export offers activities only.

The request audit stays its own ledger: it records at level `off`, keeps its sequence windows and backs
`connectRuntime().audit`; each entry names its activity by `traceId`.

### Old addresses

Earlier hashes are replaced in place (`history.replaceState`), so bookmarks and Lense links still land:

| Old address                  | Opens                                                                                                                                                                                                                 |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `#dashboard[?…]`             | `#health[?…]`; a `panel` key gets the `dashboard-` prefix.                                                                                                                                                            |
| `#overview[?…]`              | `#home[?…]`.                                                                                                                                                                                                          |
| `#identity[?…]`              | `#access[?…]`.                                                                                                                                                                                                        |
| `#logs`, `#logs?type=<type>` | `#activity?tab=log`, `#activity?tab=log&type=<type>`.                                                                                                                                                                 |
| `#audit?<filters>`           | `#activity?<filters>` with `outcome` as `result` (`success` as `ok`, `pending` as `running`), `entity` as `table`, `search` as `q`, `kind` as `auditKind`, `status` as `httpStatus` and `correlationId` as `auditId`. |
| `#trace?<filters>`           | `#activity?<filters>`; with `traceId` (and `spanId`), `#activity/<traceId>[/<spanId>]?<other filters>`.                                                                                                               |
| `#evidence[?…]`              | `#activity?tab=pages`.                                                                                                                                                                                                |

## Status payload

`GET /_sim/api/status` on both hosts carries, among the runtime facts:

- `routes`: the `/_sim/api` prefixes this host answers (see [Routes](#routes)); anything else answers 404, and a
  standalone runtime never lists a portal prefix. `/_sim/events` is outside `/_sim/api` and is not listed.
- `eventChannels`: the `/_sim/events` channels this host serves (`logs` and `trace` on Power Pages, `trace` on the
  standalone host).
- `adminAdjacentRoutes`: model-driven routes outside `/_sim/api` that act with administration rights
  (`/_apps/api/webapi` and `/_apps/api/offline`; see [model-driven apps](model-driven-apps.md#routes)), listed only when
  the model-driven surface is enabled (empty on an API-only runtime).
- `traceHosts`: the values the trace `host` filter accepts; the Activity view's host filter lists them.
- `links`: `administration`, `setup`, and the `modelDriven`, `canvas`, `powerPages`, `dataverseApi` and
  `dataverseAuthority` addresses, each `null` when the runtime does not serve it.
- `modelDrivenApps`: the imported model-driven apps as `{ id, uniqueName, name }`.
- `docs`: documentation keys mapped to `{ href, path, label }`; `href` points at the release tag of the installed
  version (`main` for a prerelease). The Power Pages `GET /_sim/api/state` carries it too.
- `csrf` (see [tokens](#tokens)), `adminUrl` (`<adminOrigin>/_sim/`) and, on the Power Pages host only, `appsUrl`.

## Capabilities and preflight

The runtime state (`GET /_sim/api/state`, `simulator.state()`, standalone `status()`) carries `capabilities` and
`capabilityReport`; `GET /_sim/api/preflight` (`?requires=<id or glob>` repeatable, `?strict=true`) and
`simulator.preflight({ scenario, strict })` answer the live preflight report with the operation modes saved in `/_sim/`.
Both are described in [capabilities and preflight](capabilities-and-preflight.md).

## Messages and outbox

`GET /_sim/api/messages`, `DELETE /_sim/api/messages/<entity>` and the read-only `GET /_sim/api/outbox` are described in
[messaging and outbox](messaging-and-outbox.md). Credential-named values are redacted in every answer.

## Flow runs and waits

Both hosts serve `/_sim/api/flow-runs`, `/flow-waits` and `/flow-triggers`; without a flow run store they answer 501
`FlowRunsNotConfigured`. Routes, approval outcomes and resume errors are in
[flow runs, waits and approvals](operations.md#flow-runs-waits-and-approvals); a wait that was already answered is no
longer listed and answers 404 `FlowWaitNotFound`. Flow payloads get the same credential-name redaction, a run's trigger
input and secure outputs are never returned, and the run-starting requests are `http` trace roots that join the caller's
headers ([request tracing](tracing.md#flows-and-connectors)).

## Activity and trace routes

The trace routes (`/_sim/api/trace...`), the `/_sim/events?channels=trace` channel and the activity bundle are
documented in [request tracing](tracing.md#api); without a trace store they answer 501 `TraceNotConfigured`. A
`/_sim/api` write other than the trace routes and the run-starting flow routes is traced as an `http` root on host `sim`
acting as the system actor `simulator`; administration reads open no trace.

The Power Pages host also serves the reads that join other facts to an activity. The standalone host serves none of
`/logs`, `/render-sources` and `/audit`; its `/activity/export` answers the bundle without audit or log documents.
`GET /_sim/api/diagnostics` answers on both hosts.

- `GET /_sim/api/logs?since=<sequence>&limit=<n>&type=<type,…>&traceId=<id>` answers the retained lines of the runtime
  log stream (`mirage.logs.retain`, default 2000) as
  `{ items, latestSequence, oldestSequence, retained, dropped, retain, more }`, oldest first. With `since`, the lines
  after that sequence; without it, the newest `limit` lines (default 500, 1 to 50000). A line is
  `{ sequence, type, time, level, traceId, spanId, … }`, with `traceId` and `spanId` `null` outside any activity; its
  `type` is `startup` (one per startup step, with `phase`, `elapsedMs` and `message`), `request`, `liquid` or `data`
  (the finished audit `entry`), `plugin` (one declarative plug-in rule evaluated: `entity`, `operation`, `rule`,
  `result`, `changes`), `diagnostic` (the finding) or `reload` (`revision`, `message`). A malformed `since`, `limit`
  outside 1 to 50000, or a `type` other than these seven answers 400 `InvalidLogFilter` with `parameter`
  (`type must be one of startup, request, liquid, data, plugin, diagnostic, reload (got "bogus").`). The
  `/_sim/events?channels=logs` stream carries the same lines; its `connected` frame names the latest retained sequence.
- `GET /_sim/api/diagnostics?traceId=<id>` narrows the findings and the portal request ring to one activity. A finding
  raised during a request carries `traceId` and `spanId`; one raised while loading sources carries neither. Plug-in step
  and flow trigger completions (`PLUGIN_ASYNC_COMPLETED`, `PLUGIN_ASYNC_FAILED`, `FLOW_TRIGGER_COMPLETED`,
  `FLOW_TRIGGER_SKIPPED`), connector calls (`CONNECTOR_INVOKE`) and flow actions (`FLOW_ACTION`) also carry `name`,
  `entity` (when there is one) and, for plug-in steps, `message`.
- `GET /_sim/api/audit?traceId=<id>[,<id>…]` and `/audit/export` select the audit entries of up to 200 activities (more
  answers 400 `InvalidAuditFilter`).
- `GET /_sim/api/render-sources?refs=<id>[,<id>…]` resolves the `sourceRefId` of up to 100 render template steps to
  `{ sourceDir, items: [{ id, path, file, line, column, kind, name, recordId, field, languageId }], missing }`; `line`
  and `column` are `null` when the file no longer holds the loaded text; unresolved ids are listed in `missing`. Without
  refs or with more than 100 it answers 400 `InvalidRenderSourceRefs`.

## Health feed

Both hosts (Power Pages and standalone model-driven or Dataverse API runtimes) answer `GET /_sim/api/dashboard` with one
read-only JSON document. It is `no-store` and never carries the administration CSRF token. Every part except `activity`
passes through the same credential redaction as `/_sim/api/messages`; `activity` holds numbers only (plus request `at`,
`method`, `path`, `traceId` and `spanId`, storage provider `id` and `lastReloadAt`), so a diagnostic code or counter
whose name looks like a credential keeps its count. `HEAD` answers like `GET` without a body; any other method answers
405 with `Allow: GET, HEAD`. The route answers 503 `{ "status": "starting" }` only for a host that has not created its
organization; both hosts create it before their listener opens, so a running runtime does not answer 503.

Top-level keys:

- `generatedAt`: ISO time from the runtime clock (a fixed clock shows simulated time).
- `runtime`: `startedAt` (ISO time the runtime started, on its clock) and `uptimeMs` (read fresh on every answer),
  `product`, `kind`, `simulationLevel`, `clock` (`system` or `fixed`), `revision` (the source reload revision on Power
  Pages, `null` on the standalone host), `storeRevision`, `reloading`, `localOrigin`, `stateFile` (relative to the
  project root, `null` for dry-run), `projectRoot` (`.`). Power Pages adds `deploymentProfile`.
- `nodes`: `{ id, kind, label, status, level?, detail, link? }`. Ids follow one scheme on both hosts: `client:*`,
  `host:*`, `org:store`, `org:security` (role, user and team counts), `org:plugins`, `org:workflows`, `org:flows`,
  `org:jobs`, `org:trace` (the trace store: `level`, `persist` and `persistError`, linking to `#activity`; the map shows
  it as **Activity** in its **Monitor** group), `org:<module>` for every installed organization module,
  `provider:storage`, `provider:storage-route:<route>`, `provider:messaging`, `provider:messaging-endpoint:<entity>`,
  `provider:outbox`, `provider:connectors`, `connection:<id>`, `provider:secrets`, `provider:local-service:<id>`,
  `provider:service-fixture:<service>`, `provider:powerfx`, `app:canvas`, `app:code`, `external:azurite`,
  `external:servicebus-emulator`, `external:keyvault`, and one `external:webhook:<hostname>` per web hook target host
  (`listening` when the delivery rule contacts it: `http` or `https` to `localhost`, `*.localhost`, `127.0.0.0/8` or
  `[::1]`; `declared` otherwise; its `detail` carries `endpoints` and the same `loopback` flag). Power Pages adds
  `host:portal` (linking to `#home`), `host:identity-provider`, `app:pcf`, `bridge:live` and one `persona-runtime:<id>`
  per running persona runtime. Status is one of `listening`, `ready`, `declared`, `disabled`, `placeholder`, `missing`,
  `error`, `planned`. `link` names the `/_sim/` view that owns the node.
- `edges`: `{ from, to, kind, status, label }` with kind `http`, `bus`, `storage`, `webhook`, `process` or `reads`. Each
  web hook target node gets a `webhook` edge from `org:plugins`. Edges are the calls the runtime really makes: save
  hooks hang off `org:store`, Web API messages off `host:dataverse-api` (off `host:model-driven` when the listener is
  switched off, since its in-app Web API runs the same messages), background work off `org:jobs`. An edge is sent only
  when both ends are on the runtime; an edge touching a `disabled` node is `disabled` and listed on the card instead of
  drawn. A node that nothing calls says why in `detail.note`.
- `activity`: Dataverse API requests (`total` and `failed`: data-plane Web API requests under `/api/data/v*` since
  start, `$metadata` excluded; `other`: token, discovery, metadata document, SOAP and every other request on the
  Dataverse listener; TDS has its own listener and is not counted; the last 20 requests of any kind as `at`, `method`,
  `path`, `status`, `ms`, `traceId` and `spanId`), plug-in executions and failures, flow runs by status and overdue
  waits, durable jobs (pending, scheduled, running, recent failures, poisoned rows), asyncoperation rows by state, bus
  messages by state, outbox rows by state and pending byte deletes, web hook outcomes (`delivered`, `failed`,
  `notContacted`), storage operations per provider (`byProvider: [{ id, writes, deletes, bytesWritten }]`), diagnostics
  (`total`, `byCode`), the trace store (`trace`: `retained` traces, `spans`, `running`, `dropped`, `droppedSpans` and
  `latestSequence`; the `org:trace` drawer shows them with the node) and the raw counters. Power Pages adds the portal
  requests (`total` since start, `retained` ring length, at most 300; `recent` is the last 20, each with its `traceId`),
  `audit` (`retained`, `sequence`, `dropped`) and `reloads` (`revision`, `lastReloadAt`). Standalone adds `inFlight`
  (requests in progress other than this one) and reports `reloads: null`.
- `configuration`: pack ids with their module directory relative to the project root, Solution layers (`solution`,
  `version`, `type`), `settingsKeys` (names of the registered settings authored in the catalogue site, project file or
  project portal that the CLI or `createMirageContext` started from, never values; `null` for a runtime embedded through
  `createSimulator`, whose configuration source is not known) and `ports` (`portal`, `dataverseApi`, `dataverseTls`,
  `tds`, `identityProvider`, each a number or `null`).
- `docs`: the documentation link map (see `status.docs`).

Counters count activity since the organization runtime started; they are not persisted. Storage counters count
operations through the storage router, not what the store holds: `writes` (an overwrite is a write), `deletes` and
`bytesWritten` only grow. The shared part is rebuilt after a store write, a counter change, or at most every 5 seconds
so that message lock and schedule states and overdue waits follow the clock; two reads in the same 5-second window
without activity return identical `nodes`. `activity.trace` is read on every request, because each traced request moves
it without a store write; `nodes` carry configuration and topology only, so portal requests alone never change them.
Safe facts only: service endpoint URLs appear as a hostname, connections as id, provider and principal kind (never
`settings`), secrets as a key count. The feed never reads `GET /_sim/api/dataverse`, which shows the managed identity
header once. Preflight is not part of the feed; call `GET /_sim/api/preflight` when you need it.

## Pack inventory

Both hosts answer `GET /_sim/api/packs` with every registered pack (project `dataPacks`, explicit catalogue or
`--pack-module` entries, and module paths supplied to the API). Each pack carries `id`, `name`, `description`, `module`
(relative to the project root), `registration` (`source`: `project` for a pack listed in the project file, `explicit`
for a catalogue `mirage.dataPacks` entry or a `--pack-module` path, `api` for a pack passed to
`createSimulator({ packs })`; `setupLink`: `/_setup/#packs`), `matched` and `matchReason`, `exports` (count per
recognized export), `presets` (`id`, `name`), `configurationPresets`, `personas`, `personaCatalog` counts (`groups`,
`personas`, `contexts`, `scenarios`), `dataFiles` (`file`, `tables`, `writable` when the current simulation writes it,
`ownedTables`) and its export `diagnostics`. On Power Pages `matched` is the pack's `matches({ portal })` result for the
current portal, so packs the portal filtered out are listed with `matched: false`; the standalone host has no portal and
reports `matched: null` with `matchReason: "no portal context"`. `library` lists every data preset with its `pack` (or
`null`) and `source`; `failed` lists modules that did not load. The route is read-only: `HEAD` answers like `GET`
without a body, other methods answer 405 with `Allow: GET, HEAD`. Register or change packs in `/_setup/` and restart.

## Environment administration on both hosts

`GET /_sim/api/environment`, `PUT /_sim/api/environment/variables/<schemaName>` (`{ "value": "text" }`, or `null` to
remove the local value) and `DELETE /_sim/api/environment/variables/<schemaName>` are served by both hosts. Writes need
the administration token in `x-sim-csrf` (`csrf` of `/_sim/api/status`, or `simulator.csrf`). A local value is kept as
an override, so a Solution reload keeps it. A Secret definition accepts a Key Vault secret reference only and never
shows a value. `PUT /_sim/api/environment/profiles` selects a deployment profile on the Power Pages host. The standalone
host loads `deploymentProfiles` too (see [standalone organization](standalone-organization.md#shared-composition)): its
`profileSelection` summarizes the active profile, or answers `{ "supported": false, "reason": "…" }` when none is
configured; its `PUT /environment/profiles` answers 501 `{ "supported": false, "reason": "…" }`. With profiles
configured the reason names where to set the default profile (the catalogue site's `mirage.deploymentProfiles.default`,
or the project file's `deploymentProfiles.default`) before a restart; without them it is
`No deploymentProfiles are configured for this runtime.`. Its `live` field says the live bridge belongs to the Power
Pages host. The standalone `GET /_sim/api/diagnostics` and `status.diagnostics` carry `byCode`.

## Security headers

Both hosts serve `/_sim/` with
`Content-Security-Policy: default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`
and `X-Content-Type-Options: nosniff`. Admin assets are served by pattern: `/_sim/<name>.mjs`, `.js` or `.css` where
`<name>` matches `^[a-z0-9-]+$` and the file exists in `mirage/admin/`, plus the shared modules `persona-search.mjs` and
`persona-picker-view.mjs` from `mirage/lib/`. The page itself answers only at `/_sim` and `/_sim/`. The administration
page is served by the administration listener to browsers: a navigation to `/_sim/` on the portal address redirects
there (see [Administration origin](#administration-origin)). A programmatic request without `Sec-Fetch-Site` or `Origin`
is still answered on the portal address. Modules are `text/javascript`, every asset carries `nosniff`, and any other
path answers 404 on both hosts, including `/_sim/index.html`, `..` and encoded separators, backslashes, upper-case
names, nested paths, server-side library modules and Windows device names such as `con.mjs`. The page allows no inline
script or inline style.
