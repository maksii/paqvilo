# External data packs

Packs, preset bodies and dataset fragments may provide a version 1 `personaCatalog`
for grouped identities, tags, descriptions, reusable local setups and scenarios.
Roles and accounts stay contact-derived. See the [catalogue contract and examples](persona-catalog.md).
`validatePersonaCatalog` and `mergePersonaCatalogs` are public exports from `paqvilo/mirage/packs`.

All project data, personas, generators, backend rules, acceptance fixtures and tests belong to a separate portal project. Mirage contains only generic presets: `empty-local`, `open-sandbox`, `strict-permissions`, and `contact-demo`. No project pack is automatically discovered inside or beside the toolkit.

Register trusted modules explicitly in `sites.<id>.mirage.dataPacks`, `defaults.mirage.dataPacks`, Mirage project `dataPacks`, or direct CLI `--pack-module`. Catalogue modules resolve from the catalogue directory; project modules resolve from the project file. Embedded `createSimulator({ dataPacks })` and `discoverPacks({ explicit })` accept explicit modules as well. Loading a module executes JavaScript.

Packs also support solution-only app/API projects; their matching logic must tolerate an absent portal. In explicit simulation/deep levels, persistence requires declared existing `dataFiles` destinations. A preset alone does not declare file ownership, and unowned business tables remain read-only. Dry run keeps record edits in memory. See the [DATA manifest and transactional write contract](simulation-levels.md) and [standalone setup](standalone-organization.md).

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

Required exports are `id`, `name`, `description`, `matches({ portal })` and `presets({ portal, metadata, options })`. A configuration-only pack that declares `configurationPresets` may omit `presets`; it contributes no data presets. Optional `generators`, `personas`, `plugins`, `expressionOperators`, `endpoints`, `shell`, `parity` and dataset helpers provide project behavior. Pack/preset IDs are validated; duplicate definitions fail. Matching filters a pack per imported portal.

A trusted pack may provide `webApiErrorTemplates: { version: 1, evidence, templates }` for explicitly captured response formatting. Each template contains an evidenced `method` (`POST` or `PATCH`), a value-free `descriptor` (reader `kind`, relevant Edm types or JSON node kinds), exact CRLF `suffix`, `suffixSha256`, `capturedSourceSha256`, and `qualifiedVariationSha256`. The project must verify those captures and fresh variations for the site's source/version and method before exporting the templates. Mirage validates bounded suffix bytes, exact hashes and unique method/descriptor keys. Matching packs cannot define the same key twice; lazy accessors are rejected. An uncaptured method keeps the existing diagnostic.

This capability applies only with site evidence and both `observed.webApiErrorDetails: "odata-wrapper"` and `observed.webApiErrorStacks: "response-template"`. Source `Webapi/error/innererror` must also enable the inner message. Unsupported reader descriptors keep the existing diagnostic. Templates alter the Web API error message only; they do not execute CLR code, qualify native exception generation or permission behavior, alter accepted writes, or appear in SDK/flow errors. Default mode is `diagnostic`. Keep real captured suffixes and all response comparisons in the external project. Entire JSON serialization and current POST/PATCH variation evidence remain separate from suffix equality.

Presets can return bodies or `{ name, description, load() }` descriptors. Body generation is memoized and listing does not generate rows. Stored builtin descriptors resolve using the explicitly supplied portal library. An unavailable project descriptor is reported, never silently replaced. Do not import `data.mjs` or `presets.mjs` at pack module top level if that creates a registry cycle; generators may import runtime utilities lazily.

Applying a portal's business-data preset preserves omitted organization-owned tables,
staff grants, credentials and imported schema. Explicit table or mapping entries
in the preset still replace those targets. Reset remains a separate operation.

Portal data presets can also declare local web-role assignments by exported name:

```js
personaRoles: [{
  contactId: '22222222-2222-4222-8222-222222222222',
  roles: ['Reviewers'],
}],
```

The contact must be present in the resulting local data. Applying such a preset
resolves exact, case-sensitive names against active web roles in the selected
portal export; missing or duplicate role names reject the application. It replaces
the runtime's explicit local contact-role assignments and uses membership-derived
identity. An empty `personaRoles: []` clears those assignments; omission preserves
them. These grants still pass through exported table permissions and automatic
authenticated/anonymous roles. They do not create live memberships or change a
persona catalogue's descriptive role tags. The lower-level `contactRoles` field
accepts `{ contactId, roleId }` assignments directly; when both fields are present,
`personaRoles` takes precedence. This full-preset replacement differs from additive
generation's explicit materialization option below.

Expression operators extend declarative local backend rules. Pack endpoints are validated under the local `/__sim/` namespace; they cannot replace live provider authorization. Shell conventions specify project banner/notification rules. Parity fixtures specify project-specific comparison scenarios and denied routes. Keep all these definitions and their tests with the project.

For compatibility, direct imports of `registerExpressionOperators` and
`registerShellConventions` from `paqvilo/mirage/lib/extensions.mjs` retain
process-wide registrations for the lifetime of that process. Those registrations
are visible in every runtime; a scoped pack's operator takes precedence over a
legacy operator with the same name. Two legacy packs cannot claim the same
operator. Use explicit pack exports for new integrations so each runtime sees
only its matched packs; direct registration has no per-runtime disposal contract.

The generic metadata scaffold is available without a pack:

```sh
paqvilo mirage data scaffold --source ./portal-export --solution-root ./solutions/Core --profile smoke --state .paqvilo/state.json
paqvilo mirage data generate --pack customer-demo --pack-module ./pack/pack.mjs --profile deep --state .paqvilo/state.json
```

`smoke` generates minimal rows; `dev` fills writable columns from metadata. Generated data is deterministic, including IDs and relationship links. Review scaffold summaries, schema violations and dangling lookups. Project generators define their own realistic datasets and counts. See [project-owned tests](../../docs/project-extensions.md) and the [starter](../../examples/project/README.md).

Use repeatable `--count NAME=N` options for pack-defined dataset dimensions, for example `--count customers=5 --count orders=20`. Names and meanings belong to your generator; core passes the validated nonnegative integers as `counts` without assuming business entities.

Additive generation leaves contact memberships and the configured identity unchanged by
default. A dataset fragment can separately declare `personaRoles: [{ contactId,
roles: ['Reviewer'] }]`. Opt in with `data generate --materialize-persona-memberships`
and select the portal export using `--source`, `--site` or `--project` (plus `--portal`
when needed). The public equivalent is `mergeDataset(state, fragment, {
materializePersonaMemberships: true, portal })`, where `portal` is the selected
`importPortal()` result.

This operation resolves exact, case-sensitive role names against active web roles
in that export and requires an existing active contact in the merged local data,
also supplied in this fragment's or its base preset's contact rows.
Missing/ambiguous roles and absent/inactive contacts fail before writing. It appends
only the fragment's requested memberships, deduplicated by contact/role ID, retaining
existing assignments, contact edits and configured identity. Base-preset descriptors
are not materialized. `addedMemberships` reports the number added; repeated application
adds zero. Catalogue metadata alone never grants access. Explicit memberships still
use the normal exported permissions and automatic authenticated/anonymous roles;
see [Power Pages web-role assignment](https://learn.microsoft.com/en-us/power-pages/security/create-web-roles).

Dataset fragments and base presets must be objects, with object mappings, arrays of
row objects per table, and an optional array of permission objects. Malformed shapes
and extra positional arguments fail before replacing state. Primary-key overlap and
lookup validation use the shared Dataverse GUID comparison, including case and
optional braces/parentheses; existing rows retain their local values. Non-GUID keys
keep their existing case-insensitive comparison. Explicit mappings provide the ID
columns and entity-set names; membership persona resolution uses the configured
contact ID column (default `contactid`). These are local mapping contracts and do
not change the actual platform's exported contact schema.
`--rows` belongs to `data scaffold`; pack selection, `--count`, and membership
materialization belong to `data generate`. Misplaced options fail instead of being ignored.

Register project providers by their exported operation names when the default simulation is insufficient:

```js
serverLogics: {
  'sample-estimate': ({ runExportedServerLogic }) => runExportedServerLogic(),
},
cloudFlows: {
  'Sample request': ({ runExportedCloudFlow }) => runExportedCloudFlow(),
},
```

These optional pack properties are explicit trust decisions. Mirage checks the exported operation and its web roles before calling a handler. HTTP writes require the portal verification token. [Operations](operations.md) automatically inventories exports, executes supported request/response flows and offers placeholders, JSON mocks and explicit exported-code opt-in. Server logic and imported workflows are not forwarded to remote services.

`runExportedServerLogic()` runs trusted exported JavaScript in a worker with time and memory limits. It supplies invocation context, site settings, user information and permission-scoped local Dataverse query/CRUD helpers. Writes require a verified HTTP write request; Liquid helper calls remain read-only. External HTTP, connectors and custom APIs require a project handler. The worker provides resource limits, not an untrusted-code sandbox or Dataverse transaction guarantees. Liquid `serverlogic` returns `success`, `status_code`, `data` and `raw_result`.

`runExportedCloudFlow()` interprets supported exported request flows and activated Dataverse row triggers. Supported actions include variables, conditions, scopes, sequential loops and basic local Dataverse CRUD. Unsupported connectors, expressions and execution settings require explicit project handlers or per-action mocks. See [operations](operations.md) for the current action, identity and transaction boundaries.

Flow identities and connectors are further optional pack exports ([connections and connectors](operations.md#connections-and-connectors)):

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

A backend descriptor needs `userId` (GUID), non-empty `evidence` and explicit `grants` of `{ entity, operations, predicate? }`, with optional `bulkTables`. A connector function receives `{ connectorId, operationId, parameters, nextLink? }` and a context with `caller`, `principal`, `correlationId`, `actionPath`, `settings` and `timeoutMs`. Pack connectors cannot reuse the `http`, Dataverse or `flow` connector ids; `flow` is reserved for child flows. Fixture URL patterns are regular expressions without the `g` or `y` flags, matched against the URL after connection rewrites; the first matching fixture answers.

A trusted pack can register captured Swagger 2.0 documents as `connectorDefinitions: { shared_example: definition }`, keyed by the connector id (the last segment of its API id). A project can import the captured JSON in its own pack; only register the Swagger document itself, not its surrounding PAC response. Mirage resolves calls by operation ID or, in the connector runtime API, an exact HTTP method/path template. Duplicate connector definitions or operation IDs are rejected. For registered definitions, calls validate declared required parameters and the supported schema constraints before a provider runs. Local JSON references, types, enum, required properties, additional properties, string length and pattern, numeric bounds, array sizes and items, object property counts, and `allOf` are checked. Selected unsupported constraints (`oneOf`, `anyOf`, `not`, `patternProperties`, `dependencies`, `uniqueItems: true` and `multipleOf`) and external references fail with `OperationUnsupported`; other schema keywords and response schemas are not validated. Flattened flow body properties (`body/property`) are accepted; mixing them with a direct body value or overlapping parent/child paths is rejected without changing caller values. String lengths count Unicode characters, and object enums ignore member order. Malformed supported constraints and unresolved local references fail with `OperationUnsupported`; `uniqueItems: false` imposes no uniqueness constraint. An unknown operation fails with `OperationUnsupported`; a valid definition without an implementation still answers 501 `ConnectorNotSimulated` to code apps. Definitions do not provide behaviour, credentials, or network access. Flow inspection continues to require a provider or an explicit mock.

Standard PCF controls use selected Solution manifests and declared resources. Tags can use an exact exported schema name; GUID references require `observed.codeComponents` with evidence. The host provides lifecycle calls, parameters, output events (`paqvilo:pcf-output`) and permission-scoped Web API operations. Explicitly bound exported datasets and enabled native single-field bindings have dedicated adapters. React/virtual hosts, platform libraries and unsupported SDK services remain outside this host. See [code components](code-components.md).

For imported Dataverse plugin steps, expose `pluginSteps: { '<exported-step-id>': synchronousHandler }` on your pack. Handlers explicitly model local validation or target-field changes; they do not execute the assembly. To run every step of a plug-in type, including steps registered through the Dataverse API, expose `pluginTypes: { '<Namespace.TypeName>': synchronousHandler }` (see [project extensions](../../docs/project-extensions.md#plug-in-type-handlers)). See [plugin contracts and rollback](dataverse-plugins.md#model-a-write).

A pack can name a `shell.headerNotificationQuery` web template for an explicitly captured header presentation. The template owns all audience and visibility rules and returns `{ "notifications": [{ "notificationText": "Local notice", "severity": "info", "visible": true }] }`. Severity accepts `success`, `danger`, `warning` or `info`. The count includes visible rows only. Text is bounded plain text and displayed literally with HTML escaping; the runtime does not decode project field formats or infer visibility from custom audience values. Invalid rows produce `HEADER_NOTIFICATION_QUERY_INVALID` and are omitted.

## Recognised exports

`mirage/lib/pack-exports.mjs` holds `PACK_EXPORTS`, the one registry of pack exports. Each row has a kind (`map` of key to value, or `value`), a key normaliser, a `check` that throws on an invalid value, and a collision rule. `validatePack` runs every check when a pack loads. It returns a frozen snapshot of the pack's own exports (a getter or Proxy-backed recognised export is refused), so every reader sees the values that were validated. Two packs registering the same normalised key fail with `Ambiguous <export> registration for <key> in packs <a> and <b>`. `collectPackExport(packs, name)` returns that Map of key to `{ value, pack }`, and `packProvides(packs)` lists `{ pack, export, key }` for every pack.

| Export                                                                                                                 | Keys                                                            | Collision               |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- | ----------------------- |
| `serverLogics`, `cloudFlows`                                                                                           | lower-case name                                                 | error                   |
| `flowIdentities`, `pluginSteps`, `pluginRuntimes`                                                                      | canonical GUID                                                  | error                   |
| `pluginTypes`, `dataverseMessages`, `expressionOperators`                                                              | exact name                                                      | error                   |
| `customApis`                                                                                                           | lower-case unique name                                          | error                   |
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
| `capabilities`                                                                                                         | capability name (array) or map key                              | error                   |

Each provider export is checked by its owning module, which calls `registerPackExport(name, { check, key?, entries?, collide? })` when it loads: `connector-runtime.mjs` (`connectors`, `connectorDefinitions`, `httpFixtures`, `connectionPrincipals`), `storage-provider.mjs` (`storageProviders`: names to factory functions), `message-bus.mjs` (`messageProviders`: names to factory functions), `outbox.mjs` (`outboxHandlers`: names to functions), `service-fixtures.mjs`, `canvas-power-fx.mjs` (`powerFx`), and the Dataverse contract modules for `calculatedColumns`, `businessRules`, `rollups`, `formulaColumns`, `virtualTableProviders`, `hierarchies` and `transitions`. `capabilities` records need at least `name`, `kind` and a `level` of `inventory`, `contract`, `behaviour` or `native-qualified`. `mirage/lib/provider-modules.mjs` loads every owning module and `project-config.mjs` imports it. An export whose module has not loaded is checked only for shape (an object of functions or objects; `httpFixtures` an array of objects) and reported as `PACK_EXPORT_PENDING`. The core keys `id`, `name`, `description`, `matches`, `presets`, `configurationPresets`, `personaCatalog`, `dataFiles`, `webApiErrorTemplates`, `dataset`, `profiles`, `parity`, `generators`, `personas` and `plugins` are not registry exports.

Flow extension exports (both contract level):

- `flowActions`: `{ [actionType]: async ({ type, inputs }, context) => outputs }` (`flow-actions.mjs`). Adds a flow action type (it cannot replace a built-in or provider-backed type). Inputs are resolved; the call is journalled like a connector action; an `outputs.statusCode` of 400 or above fails the action.
- `flowTriggers`: `{ [connectorId]: { [operationId]: { subscribe(ctx), unsubscribe?(ctx), poll?(ctx) } } }` (`flow-triggers.mjs`). Hosts a connector webhook or polling trigger. `ctx` carries `processId`, `operationKey`, `connectorId`, `operationId`, the trigger `parameters`, `clock` and `fire(body)`, which starts a tracked run; `unsubscribe` and `poll` also receive the `subscription` value `subscribe` returned; `poll` answers an array of trigger bodies. See [operations](operations.md#execution-boundary).

`virtualTables` (`dataverse-virtual-providers.mjs`) declares tables virtual, optionally with `fallback: 'local'`; see [Dataverse contract modules](dataverse-contract-modules.md#virtual-providers).

Any other key is reported as a `PACK_EXPORT_UNKNOWN` diagnostic, so a typo such as `customAPIs` is visible instead of silently disabling a handler. The pack still loads. `discoverPacks` returns those diagnostics as `packs.diagnostics`. `validatePackExports(pack, { strict: true })` throws on unknown keys instead.

Expression operators and shell conventions are registered per runtime, only for the packs that matched its portal: `discoverPacks` returns them as `packs.registries`. A footer class, notification query or operator name declared by two matched packs is an error. A host isolates its runtime's lookups with `runWithPackRegistries(packs.registries, fn)` from `lib/extensions.mjs`; outside such a scope the lookups see every activated runtime.

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

These use the saved-experiment validation rules: plain setting/snippet values are strings
or null; roles, access rules and prototype keys are forbidden. Invalid entries and duplicate
IDs produce pack diagnostics. Valid entries are listed beside built-in/local experiments,
marked with their pack source, and cannot be edited or deleted. IDs must be unique across
packs, built-ins and saved experiments. Use a pack prefix.

`POST /__sim/api/presets/sample/apply` keeps current overrides by default. Send
`{ "applyConfiguration": true }` to apply its linked configuration atomically with data.
The administration UI offers an unchecked opt-in. Directly applying a pack configuration
uses `POST /__sim/api/experiments/sample-feature-on/apply`; applying `source-defaults`
resets its overrides. Status exposes `activeConfigurationPreset` (ID, source and digest);
portal audit entries and acceptance evidence retain that identity without copying snippet
values into the ledger. Manual override edits clear the active-preset designation.

Run `configurationPresetDiagnostics(pack, { portal, metadata })` from
`paqvilo/mirage/packs` in project tests before launching a runtime. Diagnostics contain IDs
and validation messages, never override values. Lazy data presets declare their
`configurationPreset` on the descriptor so listings and preflight remain inexpensive.
At startup, `--apply-configuration` (catalogue `mirage.presetConfiguration: apply`) opts into
applying the linked configuration with the data preset. The default applies data only.

When a pack adopts a saved local preset ID, the pack takes precedence for application.
The saved preset stays visible with a collision warning and can be exported or deleted in
the administration UI. Deleting it removes only the saved copy; the pack entry remains.

Create checks for a table-level grant before invoking pack handlers. Stages 10 and 20 run before declarative rules and secondary effects; row-scoped Create permission is then checked before stage 40. Rules may establish the parent link. A scoped denial reports the permission and relationship and rolls back the request, including independent PreValidation SDK writes. Other top-level PreValidation rejection boundaries retain the documented independent SDK commits.

New runtime states can be seeded with catalogue `mirage.confinePortalPages`, `mirage.externalAssets` and `mirage.externalFrameOrigins` (also accepted at the Mirage project root and per portal). Existing state retains its routing choices. The panel identifies project defaults versus runtime state; /_sim **Live connection** can change the saved setting.
