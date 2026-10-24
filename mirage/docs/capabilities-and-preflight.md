# Capabilities and preflight

Mirage reports what each local module, provider, operation and source component can do, and what a run of your sources still requires. The capability registry holds the module levels. The preflight report lists the requirements and says whether any of them block.

## Fidelity levels

Every capability record has one of four levels, from lowest to highest:

| Level              | Meaning                                                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inventory`        | The component is listed from source. Nothing runs it locally, or it answers with a placeholder or a documented `501`/diagnostic.                     |
| `contract`         | The request and response shapes are honoured and documented. The answer comes from a fixture, a mock, a declared-only adapter or a reduced rule set. |
| `behaviour`        | The local runtime executes the documented behaviour.                                                                                                 |
| `native-qualified` | `behaviour` that has been compared with a native environment in at least one named scenario.                                                         |

A placeholder or a mock never counts as `behaviour`. `native-qualified` is attached only to records whose `evidence` names a compared scenario (`{ scenario: '<id>' }`). The registry refuses a `native-qualified` record or operation without one.

## Capability records

`mirage/lib/capability-registry.mjs` holds the registry. A record has this shape:

```js
{
  name: 'dataverse-rollup',           // unique; an EXTENSIONS entry uses its own name
  version: '0.9.6',                   // defaults to the package version
  kind: 'organization-module',        // organization-module | host-surface | operation | provider | identity | service | inventory
  level: 'contract',                  // inventory | contract | behaviour | native-qualified
  operations: [{ name: 'Recalculate', level: 'behaviour' }, { name: 'MassRecalculation', level: 'contract' }],
  requires: ['metadata:FormulaDefinition', 'scheduler'],
  principal: 'platform', stateOwner: 'none', lifecycle: 'per-request',
  evidence: [{ scenario: 'compared-scenario-id' }],   // optional; required for native-qualified
}
```

The registry is filled from these sources:

- `fromExtensions(list)` reads `describe()` on each `EXTENSIONS` entry. An entry without `describe()` is recorded at `inventory`.
- `fromOperations(items)` reads operation-catalogue and plug-in-catalogue items and maps each `mode` to a level. `placeholder` and `disabled` map to `inventory`. `mock` maps to `contract`. `exported`, `handler`, `clr` and `webhook` map to `behaviour`. An `unsupported` item stays at `inventory` and keeps its reason.
- `fromProviders(descriptors)` reads storage, messaging, connector and local-service descriptors. The descriptor's own kind is kept as `providerKind`.
- `fromInventory(records)` reads Solution inventory records as `<component>:<name>`.
- `fromServices(registry)` reads service-fixture records.
- `add(record)` and `addAll(records)` add records directly, including the records a data pack declares in its `capabilities` export.

### Normalisation

One normaliser, `normalizeCapabilityRecord`, accepts every shape a module declares:

- `operations` may be strings or `{ name, level, reason? }` objects. A string operation takes the record's `level`.
- `contractOperations: [names]` adds those operations at `contract`.
- `operationLevels: { name: level }` sets the level of individual operations.
- `seams` is kept as given.
- Kind `dataverse-extension` is read as `organization-module`.
- Levels `fixture` and `mock` are read as `contract`. Levels `disabled` and `placeholder` are read as `inventory`.

A record's level is the lowest level among its operations. When a record states a level and no operation is below it, the stated level is kept. A record without operations must state its level. Fields outside the record shape (functions, fidelity notes, settings) are dropped. Duplicate names are refused with the kind of the record already registered.

### Registry API

| Call                                 | Result                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get(name)`, `list({ kind, level })` | Records (copies).                                                                                                                                                                                                                                                                                                                                                 |
| `summary()`                          | The legacy runtime capabilities: `runtimeCapabilities(runtime)` (`powerPages`, `modelDriven`, `organization`), plus one boolean per `host-surface` record, taken from its `enabled` flag (default `true`).                                                                                                                                                        |
| `report({ scenario })`               | `{ modules, missing, unsupported }`. `missing` lists `requires` names without a `kind:` prefix that no record provides. Prefixed prerequisites such as `table:`, `metadata:` and `secret:` are resolved by preflight. `unsupported` lists records and operations below `behaviour`. When a scenario is given, only those matching `scenario.requires` are listed. |
| `assertExecutable(patterns)`         | Returns `true` when every pattern matches a record or an operation (`<record>/<operation>`) at `behaviour` or above. Otherwise it throws `DataError` with code `CapabilityUnavailable` and `details.gaps`.                                                                                                                                                        |

### Runtime status

Each host builds one registry (`organization-host.mjs`), rebuilt with its operation catalogues when the store revision, the sources or the operation overrides change. It holds:

- the host surfaces as `host-surface` records under their status keys: `dataverseApi`, `setup`, `records`, `staff`, `personas`, `liveBridge`, `portalRendering` (with `enabled`), and the app surfaces `canvas` (`inventory`) and `codeApps` (`contract`);
- the installed organization modules: `describe(api)` receives the runtime's api, so a module reports what this runtime wired (the hierarchy query operators and the rollup mass recalculation report `behaviour` once wired or scheduled);
- the operation catalogue (with the modes saved in `/_sim/`), the connector providers, the storage providers (`provider:storage/<id>`), the message bus, the outbox, the Power Fx seam, local services, service fixtures, the flow run store when present, the Solution inventory and the pack `capabilities` records. A name used twice is kept once, first wins; an invalid record is skipped with `CAPABILITY_RECORD_INVALID`.

The status payload (`simulator.state()`, `GET /_sim/api/state`, standalone `status()`) carries `capabilities`, which is `summary()` with `canvas` and `codeApps` set to their record levels (the keys the administration page reads), and `capabilityReport`, which is `report()`.

## Preflight

```sh
paqvilo mirage preflight (--project FILE [--portal ID] | --config FILE --site ID [--env ID] | --source DIR [--solution-root DIR ...])
                         [--runtime power-pages|model-driven|dataverse-api] [--preset ID] [--scenario FILE] [--strict] [--json]
```

The command resolves its inputs the same way as `serve`. It loads the sources once and starts no listeners. It then composes the host the way a running host of that configuration does, without listeners or files: `composeHostDescription()` in `organization-host.mjs` runs the shared host composition over an in-memory store (no backend, no listener) and installs the organization modules exactly as a running host does. The host surfaces, organization modules, operations, connectors, storage, messaging and outbox providers (pack factories included), service fixtures, inventory (with project `canvas.sources`) and storage readiness are therefore the records `GET /_sim/api/preflight` of a running host with the same configuration reports; the one difference is the operation modes (source defaults, no `/_sim/` overrides). The startup preset (`--preset`, else the catalogue site's `mirage.preset`) is applied to that store as a fresh host applies it, so rows it seeds, such as the service endpoints a bare step `EventHandler` names, resolve as on that host. It probes the declared `localServices` on loopback only. Each instantiated storage and messaging provider is `satisfied` only when its `preflight()` answers ready within 2 seconds (the core Azurite provider sends an authorized List Containers; the core Service Bus emulator bus opens a SASL connection and attaches a link to each mapped entity); one without `preflight()` is declared (status `placeholder`, resolution `declared`), never satisfied; a declared provider that is not instantiated is missing. It binds the source graph with the active deployment profile. `preflight(options)` from `paqvilo/mirage` returns the same report without exiting the process. It takes the `createSimulator` option names (including `connections`, `secrets`, `canvas`, `dataverse` and `projectRoot`), plus `scenario`, `strict`, `env` and `preset`. `preflight({ packs })` takes pack module paths as `createSimulator` does; already discovered packs go in `loadedPacks`.

The CLI reports each operation's mode from the sources. Mode overrides saved in `/_sim/` state are not read. A host started over a source that fails to load still starts, and the same failure is listed in its status diagnostics and as the same `solution-source` row in `GET /_sim/api/preflight`.

A running simulator answers the same report at `GET /_sim/api/preflight` (`?requires=` repeatable, `?strict=true`) and through `simulator.preflight({ scenario, strict })` on both runtime handles. It uses the host's live registry and operation catalogue (with the saved modes), probes the declared `localServices`, reports each storage and messaging provider's readiness as `provider:storage/<id>` and `provider:messaging/<id>` (the same rows the offline report has), and rebuilds the source graph with the active deployment profile bindings. A provider with `preflight()` is probed within 2 seconds; one without it is `placeholder` (see [storage providers](storage-providers.md#contract)).

The `portalRendering` and `staff` host-surface records stay at `behaviour` and list no operations: what a surface detects but does not run is a requirement row carrying `surface` (see [Report shape](#report-shape)), and a scenario that names the surface is satisfied only when none of its rows is unsatisfied.

### Strict acceptance

`runAcceptance({ ..., requires, strict })` (`mirage/acceptance.mjs`; CLI `--requires <id>` repeatable and `--strict`) reads `GET /_sim/api/preflight` of the local simulator before any browser starts. With `strict` and `requires`, it rebuilds a registry from the report's `modules` (`addAll`) and calls `assertExecutable(requires)`: a required capability that is not registered, or that is below `behaviour`, fails the run with `CapabilityUnavailable` and its gaps.

### Scenario file

```json
{ "id": "approval-flow", "requires": ["cloud-flow:*", "table:x_item", "dataverse-rollup/Recalculate"] }
```

Each entry is a requirement id or a pattern. `*` matches any run of characters, and matching ignores case. Ids are `<kind>:<key>`: source-graph ids (`table:x_item`, `environmentvariable:x_apibase`, `connectionreference:x_shared`, `webpage:<id>`) and operation keys (`cloud-flow:<guid>`, `server-logic:<id>`, `plugin-step:<guid>`). A pattern that matches no requirement is checked in this order:

1. Against the source-graph components, where a component at `behaviour` is satisfied.
2. Against the registry records and operations, where `behaviour` or above is satisfied and anything lower is `unsupported`.
3. If nothing matches, it is reported `missing`.

### Report shape

```jsonc
{
  "schemaVersion": 1,
  "kind": "paqvilo.mirage.preflight",
  "runtime": {
    "kind": "power-pages",
    "simulation": "dry-run",
    "capabilities": {
      "powerPages": true,
      "modelDriven": true,
      "organization": true,
      "canvas": "behaviour",
      "codeApps": "contract",
    },
  },
  "scope": {
    "scenario": { "id": "approval-flow", "file": "scenarios/approval.json" },
    "requires": ["cloud-flow:*"],
    "strict": false,
  },
  "sources": {
    "graphFingerprint": "…",
    "portal": { "sourceDir": "…", "layout": "standard-yaml", "dataModel": "standard" },
    "layers": [{ "index": 0, "solution": "InventedCore", "version": "1.0.0.0", "type": "xml", "input": "…" }],
  },
  "modules": [/* registry.list() records */],
  "requirements": [
    {
      "id": "cloud-flow:2222…",
      "kind": "cloud-flow",
      "source": { "file": "…" },
      "status": "placeholder",
      "reason": null,
      "resolution": { "by": null, "mode": "placeholder" },
      "message": "…",
      "inScope": true,
      "blocking": true,
    },
  ],
  "summary": {
    "total": 1,
    "satisfied": 0,
    "missing": 0,
    "placeholder": 1,
    "unsupported": 0,
    "disabled": 0,
    "secret": 0,
    "blocking": 1,
  },
  "diagnostics": [{ "code": "PACK_EXPORT_UNKNOWN", "pack": "invented-pack", "key": "customAPIs" }],
}
```

`status` is one of the following:

- `satisfied`
- `missing`: an unbound connection reference, a required environment variable without a value (`isRequired` false makes it optional), a missing Solution dependency, an inventory dependency that resolves to nothing (`INVENTORY_DEPENDENCY_UNRESOLVED`, with `message` naming the dependent component), a root component whose source files are absent (`SOLUTION_COMPONENT_SOURCE_MISSING`), an unreachable local service or provider, or an unmatched scenario entry. A source that could not be loaded is a `solution-source:<hash>` row with the loader code as `reason`: `SOLUTION_ROOT_READ_FAILED` (missing or unreadable root), `SOLUTION_ROOT_UNSUPPORTED` (an input that is not a directory, XML file or ZIP), `SOLUTION_FOLDER_READ_FAILED`, `SOLUTION_XML_READ_FAILED`, `SOLUTION_XML_TOO_LARGE`, `SOLUTION_XML_INVALID` (including a corrupt ZIP), `SOLUTION_ENVVAR_INVALID`, `SOLUTION_INVENTORY_READ_FAILED`, `SOLUTION_YAML_INVALID`, `SOLUTION_YAML_EMPTY` (a YAML solution whose folders load nothing) and `SOLUTION_ROOT_EMPTY` (a directory without `Other/Solution.xml` or `solutions/*/solution.yml` that yields no metadata file, or holds only a ZIP that is not a Solution). The hash is of the path and code, never of file contents; the matching diagnostic is listed in `diagnostics`. A missing Solution dependency named only by component id (GUID) is satisfied when a selected layer provides a component with that id.
- `placeholder`: a placeholder or mock operation, canvas rendering (`canvas:rendering`, `CANVAS_NOT_RENDERED`), or an instantiated provider without `preflight()` (`resolution: { by: 'declared' }`).
- `unsupported`: an inventory-level component, an unsupported plug-in step, or an inventory record with an error diagnostic (the code is the `reason`). It also covers what a host detects but does not run, with `resolution.level`: `portal:modern-list` (`MODERN_LIST_RENDERED_CLASSIC`, a modern list include the local adapter cannot serve: map, calendar and code component lists render classic; `contract`), `portal:modern-list/<list>` (`MODERN_LIST_FEATURES_UNSERVED`, a served modern list that configures actions other than details, edit, create, delete and download; the local modern list is local markup over the classic grid engine with views, search, filters, sort and those actions; `contract`), `portal:sharepoint-documents` (`PORTAL_SHAREPOINT_DOCUMENTS_LOCAL`, a basic form or advanced form step whose Solution form has a Document Locations subgrid; `contract`), `model-driven:custom-page/<app>/<subarea>` (`MD_NAV_CUSTOM_PAGE`; `inventory`), `model-driven:pcf/<control>` (`PCF_VIRTUAL_UNSUPPORTED`, a virtual component whose platform libraries the project does not supply; `contract`), `portal:pcf/<control>` (the same refusal for a Solution code component under a portal source: the Power Pages host supplies no platform libraries), `model-driven:offline/<profile>` (`MD_OFFLINE_FILTER_UNSUPPORTED` naming the profile items whose filter the simulator cannot evaluate, `contract`; `MD_OFFLINE_PROFILE_MISSING` for an app that names a profile the sources do not hold, keyed by the app, `inventory`), a YAML component file the adapter cannot read (`SOLUTION_YAML_COMPONENT_NOT_IMPORTED`), a custom connector whose compilation has a blocking diagnostic (`connector:<name>`, that code as reason) and an unread Solution role or field security profile (`ROLE_NOT_IMPORTED`, `FIELD_SECURITY_NOT_IMPORTED`). The `model-driven:offline` capability is at `behaviour`, and `portal:enhanced-authorization` (`ENHANCED_AUTHORIZATION`, site states 1 Migration in progress, 2 Migration Failed and 3 Enabled) is `satisfied` at `behaviour`.

Every `portal:` row carries `surface: 'portalRendering'` and every `model-driven:` row `surface: 'staff'`. A scenario names gaps in either form: by row id or pattern (`portal:*`, `model-driven:offline/*`), or by host surface (`portalRendering`, `staff`, or `portalRendering/<row id>`). A surface pattern brings all of that surface's rows into scope and adds a `host-surface` row for the surface, which is `satisfied` only when none of those rows is unsatisfied; otherwise it is `unsupported` and its message lists them.

- `disabled`: an inactive workflow or a disabled operation.
- `secret`: a Secret environment variable (`ENVIRONMENT_VARIABLE_SECRET`); the secret resolver (`resolution.by`: `secret-resolver`) must satisfy it at run time, so preflight neither reads nor reports its value.

A requirement is `blocking` only when all three of these hold:

- It is in scope.
- It is not satisfied.
- A scenario or `--strict` asks for blocking.

Without a scenario every requirement is in scope. With a scenario, unused unsupported features do not block. The diagnostics include pack export diagnostics, `CAPABILITY_REQUIRES_UNREGISTERED`, deployment-profile diagnostics, the loader failures behind `solution-source` rows and the portal findings behind `portal:` rows.

The report never contains configured values. Secrets, connection strings and connection ids are reported only as present or absent. A probe message names the environment variable or the loopback origin, never its value.

### Exit codes

| Code | Meaning                                                                                                                |
| ---- | ---------------------------------------------------------------------------------------------------------------------- |
| `0`  | No blocking requirement in scope.                                                                                      |
| `1`  | At least one blocking requirement.                                                                                     |
| `2`  | Invocation or configuration error, such as an unknown option, an unreadable or invalid scenario, or an invalid source. |

`preflightExitCode(report)` from `mirage/lib/capability-report.mjs` returns the same codes.
