# External data packs

A data pack is a trusted JavaScript module that your project registers to supply local data, personas, configuration
presets and handlers that the exports cannot describe. Project data, personas, generators, backend rules, fixtures and
tests belong to the separate project, never to the toolkit. Mirage itself ships only the generic presets `empty-local`,
`open-sandbox`, `strict-permissions` and `contact-demo`.

## Register a pack

Loading a module executes its JavaScript, so packs are never discovered: register each one explicitly in
`sites.<id>.mirage.dataPacks`, `defaults.mirage.dataPacks`, a Mirage project's `dataPacks`, or with `--pack-module`.
Catalogue modules resolve from the catalogue directory and project modules from the project file. Embedded callers pass
modules or loaded packs as described in [public API](../../docs/public-api.md#bind-project-packs-once). The
[project starter](../../examples/project/README.md) contains a complete pack.

```js
export default {
  id: 'customer-demo',
  name: 'Customer demo',
  description: 'Invented local records for this project',
  matches: ({ portal }) => portal?.website?.name === 'Customer portal',
  presets: () => ({
    'customer-demo': {
      name: 'Customer demo',
      description: 'Small deterministic fixture',
      mappings: { sample_item: { entitySet: 'sample_items', idColumn: 'sample_itemid' } },
      tables: { sample_item: [{ sample_itemid: '11111111-1111-4111-8111-111111111111', sample_name: 'Demo' }] },
    },
  }),
  generators: {},
  personas: [],
  plugins: [],
};
```

`validatePack` (from `paqvilo/mirage/packs`) enforces the core shape when a pack loads:

| Key                                               | Rule                                                                                                                                                                              |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                                              | Required; matches `/^[a-z0-9][a-z0-9._-]*$/`. Pack and preset IDs must be unique.                                                                                                 |
| `name`, `description`                             | Required non-empty strings.                                                                                                                                                       |
| `matches({ portal })`                             | Required. The pack is active for a portal only when it returns exactly `true`. Without a portal (standalone runtime) every registered pack is active and `matches` is not called. |
| `presets({ portal, metadata, options })`          | Required, unless the pack declares `configurationPresets` and contributes no data presets.                                                                                        |
| `generators`                                      | Optional object of functions. Mirage validates the shape but never calls them; `data generate` uses `dataset`.                                                                    |
| `personas`, `plugins`                             | Optional arrays: legacy persona list and declarative plug-in rules.                                                                                                               |
| `personaCatalog`                                  | Optional data property; see [persona catalogues](persona-catalog.md).                                                                                                             |
| `dataFiles`                                       | Optional data property: writable DATA files; see [simulation levels](simulation-levels.md).                                                                                       |
| `configurationPresets`                            | Optional; see [pack configuration presets](#pack-configuration-presets).                                                                                                          |
| `webApiErrorTemplates`, `dataverseErrorTemplates` | Optional data properties; see [captured error templates](#captured-error-templates).                                                                                              |
| `dataset`, `profiles`, `parity`                   | Optional: `dataset({ profile, seed, counts })` returns the fragment `data generate` merges; `profiles` (an object) limits accepted `--profile` names; project parity fixtures.    |

Every other key is a [recognized export](#recognized-exports) or produces a `PACK_EXPORT_UNKNOWN` diagnostic. A preset
owns no file: where writes persist depends on the [simulation level](simulation-levels.md) and the pack's `dataFiles`.

## Presets

`presets()` returns an object of preset bodies or descriptors. Listing never generates rows; body generation is
memoized. A stored builtin descriptor resolves through the explicitly supplied portal library, and an unavailable
project descriptor is reported, never replaced. Do not import `data.mjs` or `presets.mjs` at pack module top level if
that creates a registry cycle; generators may import runtime utilities lazily.

| Form                                   | Behaviour                                                                                                        |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Body                                   | `{ name, description, mappings, tables, permissions?, personaRoles?, contactRoles?, configurationPreset?, ... }` |
| `{ name, description, load() }`        | Lazy body, memoized; each use receives a detached copy. Wins when `createOwned` is also present.                 |
| `{ name, description, createOwned() }` | Ownership transfer for large generated presets (see below).                                                      |

`createOwned({ records })` must return synchronously (an `async` factory or a returned promise is rejected as a preset
that did not load an object) and must return a new private plain body on every call; do not keep or reuse its rows,
arrays, mappings or other mutable objects after returning. When a runtime applies the preset, `records` is that
runtime's store and [`records.table()` streams rows](state-storage.md#paged-record-storage) into paged record storage; a
read without a store (a direct `library[id]` preview) gets ordinary arrays. The toolkit then adopts the body without
cloning a second copy. Each application builds a fresh body, so use deterministic IDs and a seed when reapplication must
reproduce the same data. A direct `library[id]` read memoizes a separate preview; editing it does not edit the factory.

```js
presets() {
  return {
    'invented-volume': {
      name: 'Invented volume dataset',
      createOwned: () => buildDataset({ seed: 42 }), // your project's generator
    },
  };
}
```

A project test that constructs a `DataStore` directly owns its record storage: a store with a state file keeps streamed
records in `<state file>.records`, and one without creates a `paqvilo-record-state-*` directory in the operating
system's temporary directory. Call `store.close()` (alias `store.closeRecordStorage()`) when done; it closes every
record session and removes that directory. If a session fails to close, the call throws, keeps the remaining files and
can be retried. `createSimulator()` and the offline `data` commands close their own stores.

Applying a business-data preset to a portal keeps the organization-owned tables, staff grants, credentials and imported
schema it does not mention; explicit table or mapping entries replace their targets.

### Web-role assignments in a preset

```js
personaRoles: [{ contactId: '22222222-2222-4222-8222-222222222222', roles: ['Reviewers'] }],
```

The contact must exist in the resulting data. Role names resolve exactly (case-sensitive) against active web roles of
the selected portal export; a missing or duplicate name rejects the preset. The list replaces the runtime's explicit
contact-role assignments (`[]` clears them; omitting the key keeps them). The lower-level `contactRoles` takes
`{ contactId, roleId }` pairs; `personaRoles` wins when both are present. Assignments still pass through exported table
permissions and the automatic authenticated and anonymous roles, and never change live memberships or a catalogue's role
tags.

## Generate data offline

```sh
paqvilo mirage data scaffold --source ./portal-export --solution-root ./solutions/Core --profile smoke --state .paqvilo/state.json
paqvilo mirage data generate --pack customer-demo --pack-module ./pack/pack.mjs --profile deep --state .paqvilo/state.json
```

`data scaffold` needs no pack: `smoke` (the default) creates minimal rows and `dev` fills writable columns from
metadata, deterministically (IDs and links included); `--rows N` sets the rows per table. Review its `report`: rows per
table, generated memberships and `unresolvedRequiredLookups` (required lookups it could not fill). Tables without
Solution metadata are listed under `referencedWithoutMetadata` and get no rows. The portal and Solution roots resolve as for `mirage serve`: `--source`, a `--project` portal (its own roots),
or the catalogue site (`--site`, else the catalogue's default site); roots come from `--solution-root`, else the site's
`mirage.solutionRoots`, else unpacked Solutions discovered next to the portal.

`data generate` loads packs from `--pack-module`, the `--project` file's `dataPacks` and, with `--config` or `--site`,
the catalogue site's `dataPacks` (`--config` alone selects the default site). It calls the pack's
`dataset({ profile, seed, counts })` (`--profile` is optional and defaults to `deep`; a name outside the pack's
`profiles` fails) and merges the returned fragment into a copy of `--state`, written to `--out` (default: `--state`);
`scaffold` writes its state the same way. Repeatable `--count NAME=N` passes validated non-negative integers as
`counts`, whose names and meaning belong to your pack. `--rows` belongs to `scaffold`; `--pack`, `--pack-module`,
`--count` and `--materialize-persona-memberships` belong to `generate`; a misplaced option fails. A single-value option
given twice fails (`--state may be given only once`).

Additive generation leaves memberships and the configured identity unchanged. A dataset fragment may declare
`personaRoles: [{ contactId, roles }]`; apply them with `data generate --materialize-persona-memberships` (the portal
resolves as for `data scaffold`), or with
`mergeDataset(state, fragment, { materializePersonaMemberships: true, portal })`, where `portal` is an `importPortal()`
result. Roles resolve exactly against active web roles of that export, and each contact must be supplied by the fragment
(or its base preset) and be active in the merged data; otherwise nothing is written. Only the fragment's memberships are
appended, deduplicated by contact and role (`addedMemberships` counts them; repeating adds zero). Base-preset
descriptors are not materialized.

Fragments and base presets are objects with object `mappings`, arrays of row objects per table and an optional array of
permission objects; malformed shapes and extra positional arguments fail before state changes. Primary-key overlap and
lookups use the Dataverse GUID comparison (case and braces ignored); existing rows keep their local values. Membership
resolution uses the configured contact ID column (default `contactid`).

## Endpoints, operators and shell conventions

`endpoints` are pack HTTP routes validated under the local `/__sim/` namespace; they cannot replace live provider
authorization. `expressionOperators` extend declarative backend rules. `shell` declares project banner conventions
(`footerLogoClass`, `headerNotificationQuery`). Operators and shell conventions are registered per runtime, only for the
packs that matched its portal (`discoverPacks` returns them as `packs.registries`; a host scopes lookups with
`runWithPackRegistries(packs.registries, fn)` from `lib/extensions.mjs`). The same footer class, notification query or
operator name from two matched packs is an error.

Direct imports of `registerExpressionOperators` and `registerShellConventions` from `paqvilo/mirage/lib/extensions.mjs`
register process-wide for the life of the process and are visible in every runtime; a pack's own operator wins over such
a registration with the same name, and two such registrations cannot claim one operator. They have no per-runtime
disposal, so use pack exports.

`shell.headerNotificationQuery` names a web template that owns all audience and visibility rules and returns
`{ "notifications": [{ "notificationText": "Local notice", "severity": "info", "visible": true }] }`. Severity is
`success`, `danger`, `warning` or `info`; only visible rows count. Text is bounded plain text, HTML-escaped. Invalid
rows produce `HEADER_NOTIFICATION_QUERY_INVALID` and are omitted. The query renders only for a signed-in visitor and
only when the site's shell profile (from `mirage capture-shell`) observed the header notifications; without a matching
template in the export the page reports `HEADER_NOTIFICATION_QUERY_MISSING`.

### Authenticated local endpoint writes

An endpoint gains write capabilities with a `writes` declaration and mutation methods only:

```js
{
  id: 'update-item',
  methods: ['POST'],
  pattern: /^\/__sim\/update-item$/,
  writes: ({ body }) => [{ entity: 'x_item', operation: 'update', id: body.id, ifMatch: body.etag }],
  handle: ({ body, transaction }) => transaction(async (records) => {
    const row = await records.update('x_item', body.id, { x_name: body.name });
    return { id: row.x_itemid };
  }),
}
```

- The request must come from a signed-in portal visitor with the portal's `__RequestVerificationToken` header; anonymous
  (401 `AuthenticationRequired`), wrong-token (403) and live-provider (409 `LocalRuntimeRequired`) requests are refused
  before the handler. Refusals answer JSON `{ "error": { "code", "message" } }`.
- `writes({ body, match, identity })` returns 1 to 100 targets: `entity`, `operation` (`create`, `update`, `delete`),
  `id` for update and delete, optional `ifMatch` / `ifNoneMatch`, and `values` to preauthorize a scoped create. Every
  target is permission-checked first; undeclared targets are refused. Elastic and virtual tables are refused because
  their commits cannot join this transaction.
- The handler receives `body`, `url`, `match`, `identity`, `read`, `error` and one `transaction(work)` call, and no raw
  response writer. Inside `work`, `records.create(entity, values)`, `update(entity, id, values)`, `remove(entity, id)`
  and the permission-scoped `read(entity, id)` share one transaction that keeps authorization, field security, plug-ins,
  audit stamps, events and concurrency checks. Mutators return only the primary key (`{ x_itemid }`); use `read` for row
  data. Capabilities expire when `work` ends. Any failed operation rolls back the whole unit, even if the handler
  catches it. The JSON result is sent only after commit.
- Limits: 8 MiB payload, 1 MiB result and 1 MiB receipt, 100 CRUD operations per unit.
- An optional `Idempotency-Key` (1 to 128 letters, digits, `_`, `.`, `-`) identifies a request per runtime, pack,
  endpoint and contact. A repeat with the same method, path, query and body returns the committed result after current
  permission checks; different input answers 409 (`Idempotency key was used for another request.`). The latest 128
  receipts persist with local state. Nothing retries a pack mutation automatically.

## Operation providers

These optional exports are explicit trust decisions. Mirage checks the exported operation and its web roles before
calling a handler, and HTTP writes require the portal verification token. [Operations](operations.md) inventories
exported server logic and flows and offers placeholders, JSON mocks and exported-code opt-in without any pack.

```js
serverLogics: {
  'sample-estimate': ({ runExportedServerLogic }) => runExportedServerLogic(),
},
cloudFlows: {
  'Sample request': ({ runExportedCloudFlow }) => runExportedCloudFlow(),
},
```

- `runExportedServerLogic()` runs the trusted exported JavaScript in a worker with time and memory limits, with
  invocation context, site settings, user information and permission-scoped local Dataverse helpers. Writes need a
  verified HTTP write request; Liquid `serverlogic` calls are read-only and return `success`, `status_code`, `data` and
  `raw_result`. External HTTP, connectors and custom APIs need a project handler. The worker limits resources; it is not
  a sandbox for untrusted code.
- `runExportedCloudFlow()` interprets supported request flows and activated Dataverse row triggers. Unsupported
  connectors, expressions and settings need project handlers or per-action mocks; see [operations](operations.md).

Flow identities, connectors and HTTP fixtures ([connections and connectors](operations.md#connections-and-connectors)):

```js
flowIdentities: {
  // Per-flow override keyed by the exported workflow id; wins over a connection principal.
  '77777777-7777-4777-8777-777777777777': { userId: '10000000-0000-4000-8000-000000000001', evidence: 'Invented flow owner', grants: [{ entity: 'x_item', operations: ['read', 'create'] }] },
},
connectionPrincipals: {
  // Same descriptor shape, named for a project connection's principal.
  'flow-service': { userId: '10000000-0000-4000-8000-000000000002', evidence: 'Invented connection owner', grants: [{ entity: 'x_item', operations: ['read'] }] },
},
connectors: {
  // Served by the provider pack:<pack id>; the result is { statusCode, headers?, body, nextLink? }.
  x_inventory: { operations: { ListItems: async (request, context) => ({ statusCode: 200, body: { value: [] } }) } },
},
httpFixtures: [
  // Answers Http actions bound to the fixture provider; no network.
  { id: 'stock', method: 'GET', url: /^https:\/\/api\.example\.test\/stock\/\d+$/, respond: async request => ({ status: 200, body: { url: request.url } }) },
],
```

A backend descriptor needs a GUID `userId`, non-empty `evidence` and explicit `grants` of
`{ entity, operations, predicate? }`, with optional `bulkTables`. A connector function receives
`{ connectorId, operationId, parameters, nextLink? }` and a context with `caller`, `principal`, `correlationId`,
`actionPath`, `settings` and `timeoutMs`. Pack connectors cannot use the `http`, Dataverse or `flow` connector ids
(`flow` is reserved for child flows). Fixture URL patterns are regular expressions without the `g` or `y` flag, matched
after connection rewrites; the first match answers.

`connectorDefinitions: { shared_example: definition }` registers captured Swagger 2.0 documents keyed by connector id
(the last segment of its API id); register the document itself, not its PAC response. Calls resolve by operation ID or,
in the connector runtime API, an exact method and path template. Definitions are snapshotted at startup; duplicate
definitions, duplicate operation IDs and parameters sharing a name across locations are rejected. Local references and
percent-encoded JSON pointers resolve; external references are not fetched. Before a provider runs, calls are checked
for required parameters, types, `enum`, required and additional properties, string length and pattern (lengths in
Unicode characters), numeric bounds, array size and items, object property counts and `allOf`. `oneOf`, `anyOf`, `not`,
`patternProperties`, `dependencies`, `uniqueItems: true`, `multipleOf`, malformed constraints, unresolved references and
unknown operations fail with `OperationUnsupported`; other keywords and response schemas are not validated. Flattened
flow body properties (`body/property`) are accepted, but not mixed with a direct body or overlapping paths. A definition
without an implementation answers 501 `ConnectorNotSimulated` to code apps. Definitions supply no behaviour, credentials
or network access.

### Plug-ins

`pluginSteps: { '<exported-step-id>': synchronousHandler }` models an imported Dataverse plug-in step without running
its assembly. `pluginTypes: { '<Namespace.TypeName>': synchronousHandler }` covers every step of a plug-in type,
including steps registered through the Dataverse API (see
[project extensions](../../docs/project-extensions.md#plug-in-type-handlers)). Both receive the operation's
`sharedVariables` (a `pluginTypes` handler also as `context.SharedVariables`). Create checks the table-level grant
before pack handlers run; stages 10 and 20 run before declarative rules, and row-scoped Create permission is checked
before stage 40, so rules may establish the parent link. See
[plug-in contracts and rollback](dataverse-plugins.md#model-a-write).

Standard PCF controls come from Solution manifests, not packs; see [code components](code-components.md).

## Portal search summary fixture

Register one trusted `portalSearchSummary` function across the packs matched to a local portal. The function stands in
for the AI; the HTTP contract, request filters and sources are the hosted API's (hosted session F3). It serves
`POST /_api/search/v1.0/summary` with an `application/x-www-form-urlencoded` body holding one `userQuery` or a JSON
object `{ "userQuery": "..." }`, and `POST /_api/search/v1.0/summarystream` with `{ "UserQuery": "..." }`. Send
`X-Requested-With: XMLHttpRequest` and the portal request-verification token, as the platform's scripts do: without
`X-Requested-With` a signed-out request answers the platform's 500 error page and a signed-in one 401, and without the
token the answer is 401. Another method answers 404. The local query limit is 1,024 characters and the request body
limit is 16 KiB. An absent provider leaves ordinary route dispatch in effect.

```js
portalSearchSummary: ({ sources: [first] }) => ({
  summary: 'The local search found a matching page.',
  citationIds: [first.id],
}),
```

The provider receives `{ query, sources }` with up to ten web pages and knowledge articles the visitor's portal
search finds, as generative AI search grounds on the content keyword search indexes. A web page needs its web page
access control rules (no table permission) and the publishing-state rule (`observed.searchUnpublishedPages`, which
reports `PORTAL_SEARCH_UNPUBLISHED_PAGES_EXCLUDED` when it leaves a page out); its source holds the page ID, title and
copy as text and is cited by the page URL. A knowledge article needs a `knowledgearticle` read permission, its content
access level and read access to its `content` column; its source holds the article ID, title (when readable) and
indexed content, and is cited by the Knowledge Article page with the article id in `id`. Every citation page must be
readable by the visitor. The provider never runs for an empty source set.

Return plain summary text and a list of distinct IDs from `sources`. The answer has the hosted keys: `Summary` (the
text, then each citation as `[[n]](page url)`), `SummaryTitle` "Summarized by AI", `SearchTitle` "Other results",
`ErrorMessage`, `ResponseStatus { Code, Message }` ("Success"), `Citations` and `CitationTitleMapping` (both map
`[n]` to the page URL) and `Chunks` null. When no page is found the answer is 200 with `ErrorMessage` "I'm sorry, I'm
unable to process your question. Can you rephrase or ask another question?" and the status message "No relevant
chunks found in dataverse."; an empty summary gives "No relevant responses were found."; a request without a query
answers 500 with the same keys. `summarystream` answers `text/event-stream`: `data: <answer>` events, each a
"Partial Message" piece of the summary, the first with the titles. The hosted stream's closing events were not
captured, so the local stream ends after the last piece. An anonymous visitor's JSON answers send
`Cache-Control: private`; a signed-in visitor's send `no-cache, no-store, must-revalidate` with `Expires: -1`, as
every 401 does; `summarystream` is `private` for both. The data summarization answers, its 400 and 404 refusals
included, send the same caching headers.
[Power Pages Search Summary API](https://learn.microsoft.com/en-us/power-pages/configure/search/generative-ai#search-summary-api)

## Captured error templates

These capabilities reproduce an explicitly captured error-message suffix; the project keeps the captures and
comparisons, and verifies them for the site's source, version and method before exporting templates. Defaults stay
diagnostic, and a missing descriptor never falls back to another method or target. Templates change error text only: not
successful writes, permissions, SDK or flow errors.

- `webApiErrorTemplates: { version: 1, evidence, templates }` for the portal Web API. Each template has an evidenced
  `method` (`POST` or `PATCH`), a value-free `descriptor` (reader `kind`, relevant Edm types or JSON node kinds), an
  exact CRLF `suffix`, `suffixSha256`, `capturedSourceSha256` and `qualifiedVariationSha256`. It applies only with site
  evidence, `observed.webApiErrorDetails: "odata-wrapper"`, `observed.webApiErrorStacks: "response-template"` and source
  `Webapi/error/innererror` enabling the inner message.
- `dataverseErrorTemplates` for `/api/data/v9.x/`, with `observed.dataverseErrorStacks: "response-template"`: the same
  fields, a `POST`, `PATCH` or `PUT` method and a descriptor with `target: "record" | "operation"`. Keys cannot contain
  case identifiers, submitted literals, schema names or routes.

Both must be plain data properties; lazy accessors and duplicate method/descriptor keys across matching packs are
rejected.

## Portal data summarization fixture

Register one trusted `portalDataSummary` function across the packs matched to a local portal.
The fixture serves `POST /_api/summarization/data/v1.0/<entitySet>(<key>)` for one record (its primary key or a
declared, active alternate key, resolved as the Web API resolves it) and
`POST /_api/summarization/data/v1.0/<entitySet>` for a collection. The query is a portal Web API read: a record takes
`$select` and `$expand`; a collection also takes `$filter` (lambdas included), `$orderby`, `$top`, `$count` and
`$apply`; and each `$expand` takes its own `$select`, `$filter`, `$orderby`, `$top` and nested `$expand`. Every level
except an `$apply` names an explicit `$select`. A collection summarizes the page a Web API GET of the same query returns:
at most 5,000 rows, `Prefer: odata.maxpagesize` with `$top`, and the `$skiptoken` of an `@odata.nextLink` (bound to the
visitor that read it). FetchXML is not a summary source. Send `X-Requested-With: XMLHttpRequest`, the normal portal
verification token and a JSON object that may name a `Summarization/prompt/<identifier>` site setting as
`InstructionIdentifier`: without one, or naming a setting the site does not have, the summary runs without a prompt
(`instructionIdentifier` and `prompt` are null), as a hosted site answers it. The request filters are the search
summary's. Enable the fixture with `Summarization/Data/Enable=true` and the Web API settings for the root and related
tables. A site without the setting answers 400 `90041003` "Data summarization disabled for this site. Please enable
using site setting." and a missing record 404 `9004010D` "Common Data Service error occurred.".

```js
portalDataSummary: ({ record, records, recommendation }) => ({
  summary: (records ?? [record]).map((row) => row.x_description).join(' '),
  recommendations: recommendation ? [] : ['Which item changed last?'],
}),
```

The provider receives only `{ table, instructionIdentifier, prompt, record }` for a record and
`{ table, instructionIdentifier, prompt, records }` for a collection (each `$apply` row holds its grouped columns and
aggregate aliases), plus `recommendation` on a follow-up. The regular local Web API read checks apply to the visible
projection, including row permissions on expanded records. The fixture removes masked
or unreadable fields, implicit identifiers, annotations and binary attachments from the provider input. In local
mode a signed-out request uses the visitor's anonymous permissions. An empty admitted projection does not call the
handler. Input is capped at 100,000 serialized record characters by default and can be tuned with
`Summarization/Data/ContentSizeLimit` up to the local ceiling of 1,000,000. The request JSON is capped at 16 KiB.

Return a summary string of up to 8,000 characters and, optionally, `recommendations`: up to 10 follow-up prompts of up
to 500 characters each, as strings or `{ text }`. The endpoint sends `Summary` and `Recommendations` as
`[{ Text, Config }]`. `Config` is an opaque value that Mirage signs for the visitor (the signed-in contact and sign-in
session, else the anonymous visitor cookie), the summary route and its exact query options. Pass it back unchanged as
`{ "RecommendationConfig": "<Config>" }`, without `InstructionIdentifier`, to the same URL: the provider then receives
the recommendation text with the prompt of the original `InstructionIdentifier`, and the data is read again with the
visitor's current permissions. A changed, foreign or reused-elsewhere value is refused with 400
`InvalidDataSummaryRequest` before any read, and a value is valid only while the simulator that signed it runs.

Generative AI governance for site users (Copilot hub, at tenant, environment or site level) is not in the export. Record a
site whose governance blocks it as `observed.siteUserGenerativeAi: disabled` with evidence: every summary request then
answers 400 `90041001` `Generative AI features are disabled` before the site switch, any read or the pack. Hosted model
output and the hosted recommendation format are not modelled. Without the pack, normal portal dispatch applies.
[Power Pages Data Summarization API](https://learn.microsoft.com/en-us/power-pages/configure/data-summarization-api)

## OData property order

A table mapping may supply `odataPropertyOrder`: a dense array of 1 to 4096 unique structural property names taken from
that table's independently captured CSDL `EntityType` (lookups by HTTP name, such as `_sample_owner_value`). It orders
generated CSDL properties and projected Web API rows, including expanded entities; annotations precede their property
and navigation links follow their value. It only reorders admitted properties: it cannot add columns, bypass a
projection or change SDK attribute order, and unlisted properties keep the metadata order. Keep its source and hash in
project evidence.

## Recognized exports

`PACK_EXPORTS` in `mirage/lib/pack-exports.mjs` is the one registry. `validatePack` checks every recognized export when
the pack loads and returns a frozen snapshot, so readers see the validated values; a recognized export must be a plain
data property (a getter is refused). Two matched packs with the same normalized key fail with
`Ambiguous <export> registration for <key> in packs <a> and <b>`. `collectPackExport(packs, name)` returns a Map of key
to `{ value, pack }`; `packProvides(packs)` lists `{ pack, export, key }`.

| Export                                                                                                                 | Keys                                                            | Collision               |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------- |
| `serverLogics`, `cloudFlows`                                                                                           | lower-case name                                                 | error                   |
| `flowIdentities`                                                                                                       | flow id or name, braces stripped, lower-case                    | error                   |
| `pluginSteps`, `pluginRuntimes`                                                                                        | canonical GUID                                                  | error                   |
| `pluginTypes`, `dataverseMessages`, `expressionOperators`                                                              | exact name                                                      | error                   |
| `customApis` (a function or `{ handler, pluginType? }`)                                                                | lower-case unique name                                          | error                   |
| `workflows`                                                                                                            | canonical id or lower-case unique name                          | error                   |
| `shell`                                                                                                                | `footerLogoClass:<class>`, `headerNotificationQuery:<template>` | error                   |
| `endpoints`                                                                                                            | endpoint id                                                     | first registration wins |
| `connectors`, `connectorDefinitions`, `connectionPrincipals`, `storageProviders`, `messageProviders`, `outboxHandlers` | exact name                                                      | error                   |
| `httpFixtures`                                                                                                         | fixture id                                                      | error                   |
| `calculatedColumns`, `rollups`, `formulaColumns`                                                                       | lower-case `<table>.<column>`                                   | error                   |
| `businessRules`                                                                                                        | canonical workflow GUID                                         | error                   |
| `virtualTableProviders`                                                                                                | lower-case data source id or table name                         | error                   |
| `virtualTables`                                                                                                        | lower-case table name                                           | error                   |
| `flowActions`                                                                                                          | action type                                                     | error                   |
| `flowTriggers`                                                                                                         | connector id                                                    | error                   |
| `hierarchies`, `transitions`                                                                                           | lower-case table name                                           | error                   |
| `serviceFixtures`                                                                                                      | `<service>.<operation>`                                         | error                   |
| `powerFx`                                                                                                              | `adapter` (one adapter per runtime)                             | error                   |
| `portalSearchSummary`, `portalDataSummary`                                                                             | `provider` (one function per runtime)                           | error                   |
| `capabilities`                                                                                                         | capability name (array) or map key                              | error                   |

Provider exports are validated by their owning modules
(`registerPackExport(name, { check, key?, entries?, collide? })`), which `mirage/lib/provider-modules.mjs` loads on the
configuration path. An export whose owning module has not loaded (a project test that imports only
`paqvilo/mirage/packs`) is shape-checked only and reported as `PACK_EXPORT_PENDING`. `storageProviders` and
`messageProviders` map names to factories ([storage](storage-providers.md#pack-storage-providers),
[messaging](messaging-and-outbox.md)); `outboxHandlers` maps names to functions; `serviceFixtures` see
[service fixtures](service-fixtures.md); `powerFx` see [canvas apps](canvas-apps.md); `portalSearchSummary` and
`portalDataSummary` see the [search summary](#portal-search-summary-fixture) and
[data summarization](#portal-data-summarization-fixture) fixtures; the Dataverse column, rule,
hierarchy, transition and virtual-table exports see [Dataverse contract modules](dataverse-contract-modules.md).
`capabilities` records need `name`, `kind` and a `level` of `inventory`, `contract`, `behaviour` or `native-qualified`
([capabilities](capabilities-and-preflight.md)).

Flow extension exports (both contract level):

- `flowActions`: `{ [actionType]: async ({ type, inputs }, context) => outputs }` (`flow-actions.mjs`). Adds a flow
  action type (it cannot replace a built-in or provider-backed type). Inputs are resolved; the call is journalled like a
  connector action; an `outputs.statusCode` of 400 or above fails the action.
- `flowTriggers`: `{ [connectorId]: { [operationId]: { subscribe(ctx), unsubscribe?(ctx), poll?(ctx) } } }`
  (`flow-triggers.mjs`). Hosts a connector webhook or polling trigger. `ctx` carries `processId`, `operationKey`,
  `connectorId`, `operationId`, the trigger `parameters`, `clock` and `fire(body)`, which starts a tracked run;
  `unsubscribe` and `poll` also receive the `subscription` value `subscribe` returned; `poll` answers an array of
  trigger bodies. See [operations](operations.md#execution-boundary).

`virtualTables` declares tables virtual, optionally with `fallback: 'local'`; see
[Dataverse contract modules](dataverse-contract-modules.md#virtual-providers).

An unknown key (a typo such as `customAPIs`) is a `PACK_EXPORT_UNKNOWN` warning and the pack still loads.
`discoverPacks` returns the diagnostics as `packs.diagnostics`; `validatePackExports(pack, { strict: true })` throws
instead.

## Pack configuration presets

A trusted pack may export a `configurationPresets` array (at most 100 entries):

```js
configurationPresets: [{
  id: 'sample-feature-on', name: 'Feature enabled', description: 'Synthetic variant',
  platformOverrides: { QueryLinkEntityLimit: 30 },
  portalOverrides: { settings: { 'Feature/Enabled': 'True' }, snippets: { Greeting: 'Hello' } },
}],
presets: () => ({ sample: { name: 'Sample data', tables: {}, configurationPreset: 'sample-feature-on' } }),
```

Entries follow the saved-experiment rules ([configuration experiments](configuration-experiments.md)): setting and
snippet values are strings or `null`; roles, access rules and prototype keys are forbidden. An invalid entry or
duplicate ID is a `PACK_CONFIGURATION_PRESET_INVALID` diagnostic. Valid entries are listed beside built-in and saved
presets as read-only, marked with their pack. IDs must be unique across packs, built-ins and saved presets, so use a
pack prefix; when a pack adopts a saved preset's ID the pack entry applies, and the saved copy stays visible with a
collision warning until you delete it.

- Applying a data preset (`POST /__sim/api/presets/<id>/apply`) keeps current overrides unless the body is
  `{ "applyConfiguration": true }`, which applies the linked configuration atomically with the data. At startup
  `--apply-configuration` (catalogue `mirage.presetConfiguration: apply`) does the same; the default applies data only.
- `POST /__sim/api/experiments/<id>/apply` applies a configuration preset alone; `source-defaults` resets overrides.
- Status reports `activeConfigurationPreset` (ID, source and digest), which audit entries and acceptance evidence keep
  without snippet values. A manual override edit clears it.
- Lazy data presets declare `configurationPreset` on the descriptor so listings and preflight stay inexpensive.
- `configurationPresetDiagnostics(packOrPacks, { portal, metadata, options })` from `paqvilo/mirage/packs` checks packs
  in project tests without generating lazy data; diagnostics carry IDs and messages, never override values.

## Schema-directed pack datasets

`paqvilo/mirage/fixtures` offers offline helpers for a project pack's `dataset()` or preset loader. None makes network
calls or changes state, mutates its arguments, runs server rules, infers personas or grants access; counts, rules and
business values belong to the project. A valid result still needs `mergeDataset` checks and the project's own tests.

```js
import { generateDataset, mergeDataset } from 'paqvilo/mirage/fixtures';

const fragment = generateDataset({
  schema, // importSolutionData(...).schema from selected local Solution exports
  seed: 'inventory-demo',
  counts: { sample_group: 3, sample_item: 12 },
  rules: {
    sample_item: {
      sample_name: { kind: 'one-of', values: ['Small', 'Medium', 'Large'] },
      sample_quantity: { kind: 'sequence', start: 1, step: 2 },
      sample_price: { kind: 'range', min: 1.25, max: 9.75 },
      sample_group: { kind: 'lookup', target: 'sample_group', source: 'generated' },
    },
  },
});
const { state: next, report } = mergeDataset(state, fragment);
```

`generateDataset` fills only tables listed in `counts`. Required scalar columns get synthetic values from exported
types, bounds, lengths, choices and defaults; optional columns are omitted unless a rule supplies them. A required owner
with no `systemuser` or `team` rows in `existing` stays unset (Dataverse assigns the caller). Unsupported required types
fail with table and column context.

| Rule `kind` | Inputs                               | Behaviour                                                                             |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| `constant`  | `value`                              | Repeat a typed value.                                                                 |
| `one-of`    | `values`, optional `mode`            | Cycle through values, or select deterministically with `mode: 'random'`.              |
| `sequence`  | optional `start` and `step`          | Numeric sequence; defaults to 1 and 1.                                                |
| `pattern`   | `template`, optional `start`, `step` | Text with `{seq}` or zero-padded `{seq:4}` tokens; no code or field interpolation.    |
| `range`     | `min`, `max`                         | Seeded numeric selection within inclusive bounds; integers stay integral.             |
| `null`      | none                                 | Omit an optional column; required columns reject it.                                  |
| `lookup`    | optional `target`, `source`, `mode`  | Choose an allowed target row; `source` is `generated`, `existing` or `any` (default). |

- `existing: { table: rows }` supplies lookup candidates and alternate-key collision rows without copying them into the
  fragment; constant or one-of lookup values are `{ id, logical_name }` and must resolve. Row identities are reserved
  before columns are filled, so required cycles and self-lookups resolve. Seeded selection does not depend on input
  ordering.
- Active alternate keys are checked across generated and existing rows, and `mergeDataset` checks the final rows against
  the state's keys (base preset rows included). Null or empty key members and inactive keys do not enforce uniqueness.
  Text compares `CI_AI` by default; pass `collation: 'CI_AS'` when the receiving `settings.collation` is
  accent-sensitive. Equivalent datetime and numeric values collide consistently with runtime writes.
- Matching primary keys keep existing rows, so repeating a fragment is idempotent.
- Rules reject unknown, primary, derived and non-creatable columns, and candidate values are checked against metadata
  even when not selected. Multiselect choices accept integer arrays or comma-separated integers.
- Limits: counts 0 to 100,000 per table and 100,000 rows in total; pattern templates up to 65,536 characters, padding up
  to 32 digits.

### Remap identities

`remapDatasetIdentities(fragment, { schema, identities, existing? })` substitutes explicit primary-key GUIDs in a
row-only fragment and rewrites lookups to them, so a project fixture can move between chosen identity sets. It discovers
and transfers nothing.

```js
const { fragment: remapped, report } = remapDatasetIdentities(fragment, {
  schema,
  identities: { sample_group: { '10000000-0000-4000-8000-000000000001': '20000000-0000-4000-8000-000000000001' } },
  existing: { sample_group: destinationRows }, // when a rewritten lookup targets existing local data
});
```

- Primary keys come from `schema.tables`; lookups (typed references, scalar columns, `_column_value` aliases, N:N
  intersect columns) from `schema.targets` and relationship metadata. GUID-looking text is not a relationship. A
  polymorphic lookup must name its target through a typed reference or logical-name annotation.
- Substitutions apply once and simultaneously; keep the original fragment instead of remapping output again.
- Refused before any result: duplicate destinations or source aliases, primary-key collisions, rewritten lookups without
  a destination row, conflicting aliases, and nonempty permissions, persona roles, persona catalogues, configuration or
  plug-in sections (rebuild those against the new identities yourself).
- `report` counts `remappedRows`, `remappedLookups`, `unverifiedLookups` (untouched references the input cannot resolve)
  and `unusedIdentities`; zero unverified does not validate schema, security or keys.
- Limits: 100,000 fragment plus existing rows, 100,000 substitutions and a 1,000,000-unit work budget.

### Population and relationship coverage

`summarizeDataset({ schema, tables, existing })` reports, per column, rows that are missing, null, empty or populated
(`false` and `0` count as populated); choice-option coverage; lookups that resolve, dangle, are invalid or ambiguous (a
polymorphic scalar GUID without a target stays ambiguous); and missing, invalid or duplicate IDs. It contains metadata
names and option codes only, never row values. Coverage does not prove a native write succeeds. Limits: 100,000 selected
plus existing rows, 10,000 columns and two million column inspections.

### Project-owned TypeScript declarations

`generateSchemaDeclarations(schema, { tables })` returns `{ declarations, diagnostics }`: declaration text exporting
`Tables`, `Row`, `FixtureRow`, `Choices`, `PrimaryIds`, `Lookup` and `ExactNumeric`, which the project saves as its own
`schema.d.ts`. Unavailable types become `unknown`, and open choice sets or unknown lookup targets get diagnostics
instead of invented values. The types do not validate GUIDs, dates or business rules. Limits: 1,000 tables, 10,000
columns, 100,000 option codes and 2,000,000 bytes of text.
