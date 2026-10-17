# External data packs

Packs, preset bodies and dataset fragments may provide a version 1 `personaCatalog`
for grouped identities, tags, descriptions, reusable local setups and scenarios.
Roles and accounts stay contact-derived. See the [catalogue contract and examples](persona-catalog.md).
`validatePersonaCatalog` and `mergePersonaCatalogs` are public exports from `paqvilo/mirage/packs`.

All project data, personas, generators, backend rules, acceptance fixtures and tests belong to a separate portal project. Mirage contains only generic presets: `empty-local`, `open-sandbox`, `strict-permissions`, and `contact-demo`. No project pack is automatically discovered inside or beside the toolkit.

Register trusted modules explicitly in `sites.<id>.mirage.dataPacks`, `defaults.mirage.dataPacks`, Mirage project `dataPacks`, or direct CLI `--pack-module`. Catalogue modules resolve from the catalogue directory; project modules resolve from the project file. Embedded `createSimulator({ dataPacks })` and `discoverPacks({ explicit })` accept explicit modules as well. Loading a module executes JavaScript.

```js
export default {
  id: 'customer-demo',
  name: 'Customer demo',
  description: 'Invented local records for this project',
  matches: ({ portal }) => portal?.website?.name === 'Customer portal',
  presets: () => ({
    'customer-demo': {
      name: 'Customer demo', description: 'Small deterministic fixture',
      mappings: { sample_item: { entitySet: 'sample_items', idColumn: 'sample_itemid' } },
      tables: { sample_item: [{ sample_itemid: '11111111-1111-4111-8111-111111111111', sample_name: 'Demo' }] },
    },
  }),
  generators: {}, personas: [], plugins: [],
};
```

Required exports are `id`, `name`, `description`, `matches({ portal })` and `presets({ portal, metadata, options })`. A configuration-only pack that declares `configurationPresets` may omit `presets`; it contributes no data presets. Optional `generators`, `personas`, `plugins`, `expressionOperators`, `endpoints`, `shell`, `parity` and dataset helpers provide project behavior. Pack/preset IDs are validated; duplicate definitions fail. Matching filters a pack per imported portal.

A trusted pack may provide `webApiErrorTemplates: { version: 1, evidence, templates }` for explicitly captured response formatting. Each template contains an evidenced `method` (`POST` or `PATCH`), a value-free `descriptor` (reader `kind`, relevant Edm types or JSON node kinds), exact CRLF `suffix`, `suffixSha256`, `capturedSourceSha256`, and `qualifiedVariationSha256`. The project must verify those captures and fresh variations for the site's source/version and method before exporting the templates. Mirage validates bounded suffix bytes, exact hashes and unique method/descriptor keys. Matching packs cannot define the same key twice; lazy accessors are rejected. An uncaptured method keeps the existing diagnostic.

This capability applies only with site evidence and both `observed.webApiErrorDetails: "odata-wrapper"` and `observed.webApiErrorStacks: "response-template"`. Source `Webapi/error/innererror` must also enable the inner message. Unsupported reader descriptors keep the existing diagnostic. Templates alter the Web API error message only; they do not execute CLR code, qualify native exception generation or permission behavior, alter accepted writes, or appear in SDK/flow errors. Default mode is `diagnostic`. Keep real captured suffixes and all response comparisons in the external project. Entire JSON serialization and current POST/PATCH variation evidence remain separate from suffix equality.

Presets can return bodies or `{ name, description, load() }` descriptors. Body generation is memoized and listing does not generate rows. Stored builtin descriptors resolve using the explicitly supplied portal library. An unavailable project descriptor is reported, never silently replaced. Do not import `data.mjs` or `presets.mjs` at pack module top level if that creates a registry cycle; generators may import runtime utilities lazily.

Expression operators extend declarative local backend rules. Pack endpoints are validated under the local `/__sim/` namespace; they cannot replace live provider authorization. Shell conventions specify project banner/notification rules. Parity fixtures specify project-specific comparison scenarios and denied routes. Keep all these definitions and their tests with the project.

The generic metadata scaffold is available without a pack:

```sh
paqvilo mirage data scaffold --source ./portal-export --solution-root ./solutions/Core --profile smoke --state .paqvilo/state.json
paqvilo mirage data generate --pack customer-demo --pack-module ./pack/pack.mjs --profile deep --state .paqvilo/state.json
```

`smoke` generates minimal rows; `dev` fills writable columns from metadata. Generated data is deterministic, including IDs and relationship links. Review scaffold summaries, schema violations and dangling lookups. Project generators define their own realistic datasets and counts. See [project-owned tests](../../docs/project-extensions.md) and the [starter](../../examples/project/README.md).

Use repeatable `--count NAME=N` options for pack-defined dataset dimensions, for example `--count customers=5 --count orders=20`. Names and meanings belong to your generator; core passes the validated nonnegative integers as `counts` without assuming business entities.

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

Standard PCF controls use selected Solution manifests and declared resources. Tags can use an exact exported schema name; GUID references require `observed.codeComponents` with evidence. The host provides lifecycle calls, parameters, output events (`paqvilo:pcf-output`) and permission-scoped Web API operations. Explicitly bound exported datasets and enabled native single-field bindings have dedicated adapters. React/virtual hosts, platform libraries and unsupported SDK services remain outside this host. See [code components](code-components.md).

For imported Dataverse plugin steps, expose `pluginSteps: { '<exported-step-id>': synchronousHandler }` on your pack. Handlers explicitly model local validation or target-field changes; they do not execute the assembly. See [plugin contracts and rollback](dataverse-plugins.md#model-a-write).

A pack can name a `shell.headerNotificationQuery` web template for an explicitly captured header presentation. The template owns all audience and visibility rules and returns `{ "notifications": [{ "notificationText": "Local notice", "severity": "info", "visible": true }] }`. Severity accepts `success`, `danger`, `warning` or `info`. The count includes visible rows only. Text is bounded plain text and displayed literally with HTML escaping; the runtime does not decode project field formats or infer visibility from custom audience values. Invalid rows produce `HEADER_NOTIFICATION_QUERY_INVALID` and are omitted.

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

New runtime states can be seeded with catalogue `mirage.confinePortalPages`, `mirage.externalAssets` and `mirage.externalFrameOrigins` (also accepted at the Mirage project root and per portal). Existing state retains its routing choices. The panel identifies project defaults versus runtime state; /_sim Connection can change the saved setting.
