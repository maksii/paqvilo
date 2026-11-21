# Mirage reference

Each guide describes what Mirage does today, how to configure it and where it stops. Start with
[getting started](../../docs/getting-started.md) and the [Mirage overview](../README.md); every command and flag is in
the [CLI reference](../../docs/cli.md). Organization-specific observations, datasets and parity results belong to the
separate project, with evidence under ignored `.paqvilo/`.

## Run and administer

- [Toolkit integration](toolkit-integration.md): Mirage in the Lense browser, the panel,
  [several portals](toolkit-integration.md#several-portals).
- [Simulation administration](sim-administration.md): `/_sim/` routes and views, sign-in, administration origins,
  [health feed](sim-administration.md#health-feed), [Monitor](sim-administration.md#monitor),
  [views](sim-administration.md#views-and-host-awareness).
- [Request tracing](tracing.md): activities and steps, levels, `/_sim/api/trace`, `paqvilo mirage trace`.
- [Standalone organization](standalone-organization.md): model-driven apps and the Dataverse API without a Power Pages
  export.
- [Capabilities and preflight](capabilities-and-preflight.md): fidelity levels, the capability registry,
  `mirage preflight`.
- [Platform stack coverage](platform-stack.md): scope, levels, module map and seams.

## Sources, data and identities

- [Bootstrap and sources](bootstrap-and-sources.md): portal and Solution imports, content fingerprints,
  [Solution inventory](bootstrap-and-sources.md#solution-inventory).
- [Simulation levels](simulation-levels.md): `dry-run`, `simulation`, `deep` and pack DATA files.
- [Data packs](data-packs.md): the pack contract, presets, endpoints, providers,
  [recognized exports](data-packs.md#recognized-exports),
  [schema-directed datasets](data-packs.md#schema-directed-pack-datasets).
- [Persona catalogues](persona-catalog.md): grouped personas, sign-in pickers, isolated contexts and scenarios.
- [Deployment profiles](deployment-profiles.md): exported environment settings and profile selection.
- [Configuration experiments](configuration-experiments.md): platform rules, site overrides, configuration presets.
- [State storage](state-storage.md), [runtime performance](runtime-performance.md): large datasets, journals, concurrent
  writers, startup.
- [Storage providers](storage-providers.md): file bytes, storage routes, provider contract suite.

## Power Pages

- [Liquid and portal rendering](liquid-parity.md): Liquid, configuration records, `observed` response settings, search,
  error pages and [golden-liquid conformance](liquid-parity.md#golden-liquid-conformance).
- [Forms and lists](forms-lists-parity.md): native forms, lists and client behaviour.
- [Platform resources](platform-resources.md): fallback platform styles, `mirage capture-shell` and single stylesheet or
  snippet observations.
- [Code components](code-components.md): standard PCF field and dataset controls.
- [SharePoint documents](sharepoint.md): document integration and Graph fixtures.

## Dataverse and Power Platform

- [Dataverse API](dataverse-api.md): Web API, `$batch`, SOAP, TDS, messages, tokens and application users;
  [record and compare Web API responses](dataverse-api.md#record-and-compare-web-api-responses).
- [Dataverse parity](dataverse-parity.md): queries, Web API and permissions,
  [grant comparison](dataverse-parity.md#compare-compiled-portal-grants).
- [Dataverse plug-ins](dataverse-plugins.md): registered steps, local write models,
  [registration comparison](dataverse-plugins.md#local-registration-comparison),
  [execution boundaries](dataverse-plugins.md#execution-boundaries).
- [Dataverse contract modules](dataverse-contract-modules.md): calculated, rollup and formula columns, business rules,
  hierarchy, transitions, cascades, virtual providers, business process flows.
- [Operations](operations.md): exported server logic, cloud flow triggers and actions, connectors and local mocks.
- [Messaging and outbox](messaging-and-outbox.md): local queues, dead-letter, email and Teams outbox.
- [Service fixtures](service-fixtures.md): disabled-by-default services (Power BI, AI Builder, Copilot, Dynamics).
- [Model-driven apps](model-driven-apps.md), [client API](model-driven-client-api.md),
  [customizations](model-driven-customizations.md), [web resource lint](model-driven-web-resource-lint.md).
- [Canvas apps](canvas-apps.md), [Power Fx differential checks](power-fx-oracle.md), [code apps](code-apps.md).

## Evidence

- [Runtime evidence](runtime-evidence.md) and [parity evidence](parity-evidence.md): what local checks prove;
  `parity-suite`, `reference-parity`, `verify` and `enrich-reference` against an authorized reference;
  [frontend contract probes](parity-evidence.md#record-frontend-contracts).
- Native baseline: [Dataverse inventory](baseline/dataverse-inventory.md),
  [Power Pages inventory](baseline/power-pages-inventory.md), [coverage](baseline/coverage.md),
  [parity](baseline/parity.md), [reference](baseline/reference.md), [runbook](baseline/rerun.md).
- [Public API](../../docs/public-api.md): embedded runtimes, automated visitors and
  [named fixture recreation](../../docs/public-api.md#named-deterministic-recreation).

Return to the [Paqvilo documentation index](../../docs/index.md) for Lense, shared configuration and contribution
guidance.
