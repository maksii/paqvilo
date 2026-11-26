# Capabilities and preflight

Mirage reports what each local module, provider, operation and source component can do (the capability registry), and
what a run of your sources still needs (the preflight report).

## Fidelity levels

| Level              | Meaning                                                                                                                     |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `inventory`        | Listed from source. Nothing runs it locally, or it answers a placeholder or a documented `501`/diagnostic.                  |
| `contract`         | Request and response shapes are honoured; the answer comes from a fixture, mock, declared-only adapter or reduced rule set. |
| `behaviour`        | The local runtime executes the documented behaviour.                                                                        |
| `native-qualified` | `behaviour` compared with a native environment in at least one named scenario.                                              |

A placeholder or mock never counts as `behaviour`, and a placeholder never reports success. The registry refuses a
`native-qualified` record or operation whose `evidence` does not name a compared scenario (`{ scenario: '<id>' }`).

## Capability records

`mirage/lib/capability-registry.mjs` holds the registry. A record:

```js
{
  name: 'x-invented-rollup',          // unique; an EXTENSIONS entry uses its own name
  kind: 'organization-module',        // organization-module | host-surface | operation | provider | identity | service | inventory
  level: 'contract',
  operations: [{ name: 'Recalculate', level: 'behaviour' }, { name: 'MassRecalculation', level: 'contract' }],
  requires: ['metadata:FormulaDefinition', 'scheduler'],
  principal: 'platform', stateOwner: 'none', lifecycle: 'per-request',
  evidence: [{ scenario: 'compared-scenario-id' }],   // required for native-qualified
  // version defaults to the package version
}
```

Sources: `fromExtensions(list)` (each `EXTENSIONS` entry's `describe()`; none means `inventory`),
`fromOperations(items)` (operation and plug-in catalogue modes: `placeholder`, `disabled` and `unsupported` →
`inventory`; `mock` → `contract`; `exported`, `handler`, `clr`, `webhook` → `behaviour`), `fromProviders(descriptors)`
(the descriptor's kind kept as `providerKind`), `fromInventory(records)` (`<component>:<name>`),
`fromServices(registry)` and `add`/`addAll` (including a pack's `capabilities` export).

`normalizeCapabilityRecord` accepts every declared shape: string operations take the record level;
`contractOperations: [names]` and `operationLevels: { name: level }` set operation levels; kind `dataverse-extension`
reads as `organization-module`; levels `fixture`/`mock` read as `contract` and `disabled`/`placeholder` as `inventory`.
A record's level is the lowest of its operations (a stated level is kept when no operation is lower); a record without
operations must state one. Unknown fields are dropped and duplicate names refused.

### Registry API

| Call                                 | Result                                                                                                                                                                                                                                                                                       |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get(name)`, `list({ kind, level })` | Record copies.                                                                                                                                                                                                                                                                               |
| `summary()`                          | The legacy runtime capabilities (`powerPages`, `modelDriven`, `organization`) plus one boolean per `host-surface` record (its `enabled`, default `true`).                                                                                                                                    |
| `report({ scenario })`               | `{ modules, missing, unsupported }`. `missing` lists unprefixed `requires` that no record provides (prefixed ones such as `table:` or `secret:` are resolved by preflight); `unsupported` lists records and operations below `behaviour` (with a scenario, only those its `requires` match). |
| `assertExecutable(patterns)`         | `true` when every pattern matches a record or `<record>/<operation>` at `behaviour` or above; otherwise throws `DataError` `CapabilityUnavailable` with `details.gaps`.                                                                                                                      |

### Runtime registry

Each host builds one registry in `organization-host.mjs` and rebuilds it when the store revision, sources or operation
overrides change. It holds the host surfaces (`dataverseApi`, `setup`, `records`, `staff`, `personas`, `liveBridge`,
`portalRendering`, `canvas-apps`, `model-driven:offline`, `model-driven:custom-page` and `model-driven:dashboard`, plus
`canvas` at `behaviour` for headless logic, `codeApps` and `serverLogic` at `contract`), the installed organization
modules (`describe(api)` reports what this runtime wired), the shared facilities `store`, `scheduler`,
`loopback-network` and `providers.messaging`, the operation catalogue with the modes saved in `/_sim/`, connector,
storage (`provider:storage/<id>`), messaging, outbox, Power Fx and local-service providers, service fixtures, the flow
run store, the Solution inventory and pack `capabilities` records. A name used twice keeps the first; an invalid record
is skipped with `CAPABILITY_RECORD_INVALID`.

The runtime status (`GET /_sim/api/status`, `simulator.state()`, standalone `status()`) carries `capabilities`
(`summary()` with `canvas` and `codeApps` set to their levels) and `capabilityReport` (`report()`). The preflight
report's `runtime.capabilities` is `summary()` itself, so every entry there is a boolean.

## Preflight

```sh
paqvilo mirage preflight (--project FILE [--portal ID] | --config FILE --site ID [--env ID] | --source DIR [--solution-root DIR ...])
                         [--runtime power-pages|model-driven|dataverse-api] [--preset ID] [--scenario FILE] [--strict] [--json]
```

The command resolves inputs like `serve`, loads the sources once and starts no listener. `composeHostDescription()`
composes the host over an in-memory store exactly as a running host of that configuration does, so its records match
`GET /_sim/api/preflight` of that host. Differences: operation modes are the source defaults (no `/_sim/` overrides).
The startup preset (`--preset`, else the site's `mirage.preset`) is applied first, so rows it seeds resolve as on a
fresh host. Declared `localServices` are probed on loopback; each instantiated storage and messaging provider is probed
through its `preflight()` (see [storage providers](storage-providers.md#contract)); the source graph is bound with the
active deployment profile.

`preflight(options)` from `paqvilo/mirage` returns the same report without exiting. It takes the `createSimulator`
options (including `connections`, `secrets`, `canvas`, `dataverse`, `projectRoot` and `packs`; already loaded packs go
in `loadedPacks`) plus `scenario`, `strict`, `env` and `preset`, and needs `sourceDir` or a non-empty `solutionRoots`.
Without either it throws `TypeError`: `preflight(options) requires sourceDir (the exported portal directory) or
solutionRoots; got <the keys passed>.`

A running simulator answers the same report at `GET /_sim/api/preflight` and through
`simulator.preflight({ scenario, strict })`, using its live registry and saved operation modes. The route takes
`?requires=` (repeatable; forms a scenario named by `?scenario=`, default `request`) and `?strict` (`true` or `1`;
`false`, `0`, empty or absent is false; any other value answers 400 `InvalidQueryParameter` with `parameter: "strict"`).
A host whose source fails to load still starts and lists the failure as a `solution-source` row.

### Strict acceptance

`runAcceptance({ ..., requires, strict })` (CLI `paqvilo mirage acceptance --requires <id> ... --strict`) reads
`GET /_sim/api/preflight` before any browser starts and calls `assertExecutable(requires)` on the reported modules: a
required capability that is missing or below `behaviour` fails the run with `CapabilityUnavailable`.

### Scenario file

```json
{ "id": "approval-flow", "requires": ["cloud-flow:*", "table:x_item", "dataverse-rollup/Recalculate"] }
```

Entries are requirement ids or patterns (`*` matches any run of characters, case-insensitive). Ids are `<kind>:<key>`:
source-graph ids (`table:x_item`, `environmentvariable:x_apibase`, `connectionreference:x_shared`, `webpage:<id>`) and
operation keys (`cloud-flow:<guid>`, `server-logic:<id>`, `plugin-step:<guid>`). A pattern that matches no requirement
is checked against source-graph components (satisfied at `behaviour`), then registry records and operations (satisfied
at `behaviour` or above, else `unsupported`), else reported `missing`. A scenario may also name a host surface
(`portalRendering`, `staff`, or `portalRendering/<row id>`): that brings all of the surface's rows into scope and adds a
`host-surface` row that is satisfied only when none of them is unsatisfied.

### Report shape

```jsonc
{
  "schemaVersion": 1,
  "kind": "paqvilo.mirage.preflight",
  "runtime": {
    "kind": "power-pages",
    "simulation": null, // the configured simulation level, or null
    // summary(): the runtime kind's three flags, then one flag per host-surface record
    "capabilities": {
      "powerPages": true,
      "modelDriven": true,
      "organization": true,
      "dataverseApi": false,
      "setup": true,
      "records": true,
      "staff": true,
      "personas": true,
      "liveBridge": true,
      "portalRendering": true,
      "canvas": true,
      "codeApps": true,
      "canvas-apps": true,
      "model-driven:offline": true,
      "model-driven:custom-page": true,
      "model-driven:dashboard": true,
      "serverLogic": true,
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
  "modules": [/* registry.list() records; an inventory record takes its source-graph node's level and reason */],
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

A Solution component's `modules` entry and its requirement row agree: a dashboard an app hosts is `behaviour` when every
component renders, else its entry `dashboard:<Name>` keeps `inventory` with `MD_DASHBOARD_COMPONENT_UNSUPPORTED`
([model-driven apps](model-driven-apps.md#sitemap-pages-and-dashboards)).

| `status`      | Meaning                                                                                                                                                                                                                                                                                                                                                                     |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `satisfied`   | Resolved at `behaviour`.                                                                                                                                                                                                                                                                                                                                                    |
| `missing`     | An unbound connection reference, a required environment variable without a value, a missing Solution dependency (`INVENTORY_DEPENDENCY_UNRESOLVED`), absent component source files (`SOLUTION_COMPONENT_SOURCE_MISSING`), an unreachable local service or provider, a declared provider that was not created, an unmatched scenario entry, or a source that failed to load. |
| `placeholder` | A placeholder or mock operation, a canvas app listed at inventory level, a model-driven custom page (`CANVAS_NOT_RENDERED`), or a provider without `preflight()` (`resolution.by: 'declared'`).                                                                                                                                                                             |
| `unsupported` | An inventory-level component, an unsupported plug-in step, an inventory record with an error diagnostic, a registry record or operation below `behaviour` that a scenario names, or something a host detects but does not run (table below).                                                                                                                                |
| `disabled`    | An inactive workflow or a disabled operation.                                                                                                                                                                                                                                                                                                                               |
| `secret`      | A Secret environment variable (`ENVIRONMENT_VARIABLE_SECRET`); the [secret resolver](deployment-profiles.md#environment-variable-types-effective-values-and-secrets) satisfies it at run time and preflight never reads its value.                                                                                                                                          |
| `unknown`     | A provider probe ended by the idle guard (`PROVIDER_PREFLIGHT_TIMEOUT`).                                                                                                                                                                                                                                                                                                    |

A source that could not be loaded is a `solution-source:<hash>` row (hash of path and code, never of contents) whose
`reason` is the loader code: `SOLUTION_ROOT_READ_FAILED`, `SOLUTION_ROOT_UNSUPPORTED`, `SOLUTION_FOLDER_READ_FAILED`,
`SOLUTION_XML_READ_FAILED`, `SOLUTION_XML_TOO_LARGE`, `SOLUTION_XML_INVALID` (including a corrupt ZIP),
`SOLUTION_ENVVAR_INVALID`, `SOLUTION_INVENTORY_READ_FAILED`, `SOLUTION_YAML_INVALID`, `SOLUTION_YAML_EMPTY` or
`SOLUTION_ROOT_EMPTY`. A Solution dependency named only by component id is satisfied when a selected layer provides that
id.

Rows for what a host detects but does not run (`resolution.level` in brackets). Every `portal:` row carries
`surface: 'portalRendering'` and every `model-driven:` row `surface: 'staff'`:

| Row                                        | Reason                                                                                                                                        |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `portal:modern-list`                       | `MODERN_LIST_RENDERED_CLASSIC`: a map, calendar or code component list renders classic (`contract`)                                           |
| `portal:modern-list/<list>`                | `MODERN_LIST_FEATURES_UNSERVED`: actions other than details, edit, create, delete and download (`contract`)                                   |
| `portal:sharepoint-documents`              | `PORTAL_SHAREPOINT_DOCUMENTS_LOCAL`: a form with a Document Locations subgrid (`contract`)                                                    |
| `portal:pcf/<control>`                     | every reason the Power Pages host refuses a Solution control, then `PCF_DEPENDENCY_NOT_LOADED` (`contract`)                                   |
| `model-driven:pcf/<control>`               | `PCF_VIRTUAL_UNSUPPORTED`: a virtual component whose platform libraries the project does not supply (`contract`)                              |
| `model-driven:custom-page/<app>/<subarea>` | `CANVAS_NOT_RENDERED` (`behaviour`, `placeholder`: the canvas app runs headless); `MD_NAV_CUSTOM_PAGE` (`inventory`) when it does not resolve |
| `model-driven:offline/<profile>`           | `MD_OFFLINE_FILTER_UNSUPPORTED` (`contract`), or `MD_OFFLINE_PROFILE_MISSING` keyed by the app (`inventory`)                                  |
| `connector:<name>`                         | a custom connector with a blocking compilation diagnostic (that code)                                                                         |
| other                                      | `SOLUTION_YAML_COMPONENT_NOT_IMPORTED`, `ROLE_NOT_IMPORTED`, `FIELD_SECURITY_NOT_IMPORTED`                                                    |

`portal:enhanced-authorization` (`ENHANCED_AUTHORIZATION`, site states 1, 2 and 3) is `satisfied` at `behaviour`. Each
canvas app is a `canvas:app/<name>` row, `satisfied` at `behaviour` or `unsupported` (`CANVAS_CONTROL_UNSUPPORTED`, or
the source diagnostic); `canvas:rendering` (`CANVAS_RENDERING_BASELINE`, level `contract`) is `satisfied` only when
every app is readable and every control renders locally.

An unreachable local service declared `required: true` is `blocking` in every mode, even outside a scenario's scope.
Any other requirement is `blocking` only when it is in scope, not satisfied, and a scenario or `--strict` asks for
blocking. Without a scenario every requirement is in scope; with one, unused unsupported features do not block.
`diagnostics` holds pack export diagnostics, `CAPABILITY_REQUIRES_UNREGISTERED`, deployment-profile diagnostics, the
loader failures behind `solution-source` rows and the findings behind `portal:` rows.

The report never contains configured values: secrets, connection strings and connection ids appear only as present or
absent, and a probe message names the variable or loopback origin, never its value.

### Exit codes

| Code | Meaning                                                                                                  |
| ---- | -------------------------------------------------------------------------------------------------------- |
| `0`  | No blocking requirement in scope.                                                                        |
| `1`  | At least one blocking requirement.                                                                       |
| `2`  | Invocation or configuration error (unknown option, unreadable or invalid scenario, invalid source, ...). |

An invalid scenario file is reported as `--scenario file <path> is not a valid scenario: <reason>.`, a file that is not
JSON as `--scenario file <path> is not valid JSON (line <n>, column <n>).` and a missing one as
`--scenario file not found: <path>. Pass an existing file.`

`preflightExitCode(report)` from `mirage/lib/capability-report.mjs` returns the same codes.
