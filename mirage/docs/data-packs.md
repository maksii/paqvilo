# External data packs

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

Required exports are `id`, `name`, `description`, `matches({ portal })` and `presets({ portal, metadata, options })`. Optional `generators`, `personas`, `plugins`, `expressionOperators`, `endpoints`, `shell`, `parity` and dataset helpers provide project behavior. Pack/preset IDs are validated; duplicate definitions fail. Matching filters a pack per imported portal.

Presets can return bodies or `{ name, description, load() }` descriptors. Body generation is memoized and listing does not generate rows. Stored builtin descriptors resolve using the explicitly supplied portal library. An unavailable project descriptor is reported, never silently replaced. Do not import `data.mjs` or `presets.mjs` at pack module top level if that creates a registry cycle; generators may import runtime utilities lazily.

Expression operators extend declarative local backend rules. Pack endpoints are validated under the local `/__sim/` namespace; they cannot replace live provider authorization. Shell conventions specify project banner/notification rules. Parity fixtures specify project-specific comparison scenarios and denied routes. Keep all these definitions and their tests with the project.

The generic metadata scaffold is available without a pack:

```sh
paqvilo mirage data scaffold --source ./portal-export --solution-root ./solutions/Core --profile smoke --state .paqvilo/state.json
paqvilo mirage data generate --pack customer-demo --pack-module ./pack/pack.mjs --profile deep --state .paqvilo/state.json
```

`smoke` generates minimal rows; `dev` fills writable columns from metadata. Generated data is deterministic, including IDs and relationship links. Review scaffold summaries, schema violations and dangling lookups. Project generators define their own realistic datasets and counts. See [project-owned tests](../../docs/project-extensions.md) and the [starter](../../examples/project/README.md).

Use repeatable `--count NAME=N` options for pack-defined dataset dimensions, for example `--count customers=5 --count orders=20`. Names and meanings belong to your generator; core passes the validated nonnegative integers as `counts` without assuming business entities.

Register local server operations by their exported names:

```js
serverLogics: {
  'sample-estimate': ({ runExportedServerLogic }) => runExportedServerLogic(),
},
cloudFlows: {
  'Sample request': ({ runExportedCloudFlow }) => runExportedCloudFlow(),
},
```

These optional pack properties are explicit trust decisions. Mirage checks the exported operation and its web roles before calling a handler. HTTP writes require the portal verification token. Unregistered operations retain their unsupported response; server logic is never forwarded to a live site.

`runExportedServerLogic()` runs trusted exported JavaScript in a separate worker with a time and memory limit. It supplies invocation context, site settings, user information and permission-scoped **local** Dataverse reads. The adapter supports `RetrieveRecord` and `RetrieveMultipleRecords`; connector writes and external HTTP/flow calls require a project handler. The worker is a resource boundary, not a security sandbox for untrusted code. Liquid `serverlogic` uses the same registration and returns `success`, `status_code`, `data` and `raw_result`.

`runExportedCloudFlow()` reads the selected solution's workflow by exported process ID. It supports one Power Pages Request trigger and one Response action, including `@triggerBody()?['field']`. Other actions and expressions fail explicitly. A custom handler can model those operations using its `input`, local `store` and `identity`; keep its behavior and acceptance tests in the project.

Standard PCF controls use the selected solution's manifests and declared resources. Configure `observed.codeComponents` as a component GUID-to-schema-name map with `observed.evidence` explaining the verified binding. The host provides lifecycle calls, parameters, output events (`paqvilo:pcf-output`), basic context and permission-scoped Web API operations. Dataset and React hosts, framework-specific services and undeclared resources remain unsupported.
