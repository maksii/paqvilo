# Discovery keyword and first-page search index

Reviewed **2026-10-28** from the actual public modules, CLI, capability guides and developer tooling.

**95 capability buckets; 127 GitHub queries; 1255 returned GitHub entries; 984 unique repository names.**

Every primary query below was executed with page 1 and a page size of 10. All returned names are recorded in rank order, including forks, archived projects, unrelated results and Paqvilo itself. Narrower follow-ups are additional pages, not replacements for noisy results. Search rankings are a dated observation, not a claim of exhaustive GitHub coverage.

Module paths were checked on disk. Related internals are grouped by public capability rather than one row per file. A second inventory review added fiscal/state/hierarchy/duplicate, virtual/elastic, localization, command, auth, safety, connector, offline, ALM, currency, business-process/rule, throttling and queue coverage.

This is **first-page metadata screening**. It does not mean every returned repository had its implementation, tests, license or maintainers reviewed. The 23 cloned behavioral reviews and independent implementations are recorded in [kudos](kudos.md) and the [research report](feature-discovery.md). Harvard/IQSS Dataverse, general AI repositories and other similarly named results are not assumed to concern Microsoft Dataverse.

The npm phase followed GitHub coverage and the kudos index. **95/95 primary npm searches plus 10 targeted follow-ups** are recorded below: 815 unique package/version pairs, 57 without a declared repository and 10 with declared repositories outside GitHub. Missing repository metadata is not proof that source is unavailable. No package was installed into Paqvilo or added as a dependency. See [npm findings](npm-discovery.md).

Raw structured receipts remain in ignored `.paqvilo/research/search-receipts.json`.

## Capability coverage

| Capability                                                                                                                                      | Primary GitHub keywords                                                | GitHub first page | npm keywords                                 | npm first page |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- | ----------------- | -------------------------------------------- | -------------- |
| [CLI routing, argument validation and structured JSON output](#lense-lense-cli)                                                                 | `node cli json in:name,description,readme`                             | 10 results        | `cli argument parser`                        | 10 results     |
| [Multi-site and environment catalogues, settings and YAML diagnostics](#lense-lense-catalogue)                                                  | `yaml environment configuration in:name,description,readme`            | 10 results        | `yaml config validation`                     | 10 results     |
| [Consumer project scaffolding, readiness and VS Code workflows](#lense-lense-project-scaffold)                                                  | `project scaffold vscode in:name,description,readme`                   | 10 results        | `project scaffold`                           | 10 results     |
| [Browser-based local configuration workspace and dependency readiness](#lense-lense-setup-workspace)                                            | `local configuration editor in:name,description,readme`                | 10 results        | `configuration wizard`                       | 10 results     |
| [Portal export discovery, file identity and resource route resolution](#lense-lense-source-discovery)                                           | `powerpages development in:name,description,readme`                    | 10 results        | `powerpages`                                 | 10 results     |
| [HTTP response overlays, inline scripts/styles and literal HTML patches](#lense-lense-response-overlay)                                         | `browser response overrides in:name,description,readme`                | 10 results        | `http response override`                     | 10 results     |
| [Source watching, multi-target reload and interception readiness](#lense-lense-watch-reload)                                                    | `browser live reload in:name,description,readme`                       | 10 results        | `live reload watcher`                        | 10 results     |
| [Persistent browser profiles, signed-in sessions, CDP and owned cleanup](#lense-lense-browser-sessions)                                         | `playwright persistent profiles in:name,description,readme`            | 10 results        | `playwright browser profile`                 | 10 results     |
| [Startup deadlines, progress and supervised local runtime lifecycle](#lense-lense-startup-lifecycle)                                            | `dev server lifecycle in:name,description,readme`                      | 10 results        | `dev server shutdown`                        | 10 results     |
| [Git baselines, temporary-copy browser verification and Online/Local comparison](#lense-lense-baseline-verification)                            | `browser visual comparison in:name,description,readme`                 | 10 results        | `visual regression comparison`               | 10 results     |
| [Resource inventory, mapping coverage, strict audits and diagnostics](#lense-lense-resource-audit)                                              | `powerpages resource audit in:name,description,readme`                 | 10 results        | `website resource audit`                     | 10 results     |
| [DOM and Xray inspection, element ownership and evidence confidence](#lense-lense-dom-inspection)                                               | `dom source inspector in:name,description,readme`                      | 10 results        | `dom inspector`                              | 10 results     |
| [Structured source editing, sibling and record/language preservation, editor links](#lense-lense-source-editing)                                | `yaml xml editing in:name,description,readme`                          | 10 results        | `yaml edit`                                  | 10 results     |
| [JavaScript source maps, console locations and applied-script evidence](#lense-lense-source-debugging)                                          | `javascript source maps in:name,description,readme`                    | 10 results        | `source map`                                 | 10 results     |
| [Bounded browser agent HTTP API, event cursors, snapshots, screenshots and navigation](#lense-lense-agent-api)                                  | `playwright browser agent in:name,description,readme`                  | 10 results        | `playwright agent`                           | 10 results     |
| [Inspect and Tweaks panel, scenarios and identity workflows](#lense-lense-panel-workflows)                                                      | `powerpages developer extension in:name,description,readme`            | 10 results        | `powerapps developer tools`                  | 10 results     |
| [Model-driven WebResource overlays and Solution source mapping](#lense-lense-model-driven-overlay)                                              | `dynamics webresource development in:name,description,readme`          | 10 results        | `dataverse webresource`                      | 10 results     |
| [Model-driven contextual actions, draft tools, diagnostics, impersonation and custom commands](#lense-lense-model-driven-actions)               | `dynamics devtools in:name,description,readme`                         | 10 results        | `xrm developer tools`                        | 10 results     |
| [Model-driven native observation, inspector evidence and comparison](#lense-lense-model-driven-evidence)                                        | `model driven testing in:name,description,readme`                      | 10 results        | `xrm testing`                                | 10 results     |
| [Code Apps dev-server subprocess orchestration and app-target coordination](#lense-lense-code-app-orchestration)                                | `powerapps code apps in:name,description,readme`                       | 10 results        | `powerapps vite`                             | 10 results     |
| [Dataverse app registration, authentication, credential recovery and DPAPI state](#lense-lense-dataverse-auth)                                  | `dataverse authentication node in:name,description,readme`             | 10 results        | `dataverse authentication`                   | 10 results     |
| [Reusable Dataverse HTTP client, continuations, bounded requests and unknown write outcomes](#lense-lense-dataverse-client)                     | `dataverse javascript client in:name,description,readme`               | 10 results        | `dataverse web api`                          | 10 results     |
| [Schema manifests, additive provisioning, drift plans, solution membership and export/unpack](#lense-lense-dataverse-provisioning)              | `dataverse schema provisioning in:name,description,readme`             | 10 results        | `dataverse metadata`                         | 10 results     |
| [Reproducible data plans, comparison, FetchXML retrieval and Power Pages site management](#lense-lense-dataverse-data-sites)                    | `dataverse data migration in:name,description,readme`                  | 10 results        | `dataverse data migration`                   | 10 results     |
| [Baseline coverage matrices and redacted offline reference evidence](#lense-scripts-baseline-evidence)                                          | `browser differential testing in:name,description,readme`              | 10 results        | `differential testing`                       | 10 results     |
| [SDK interoperability, consumer compatibility and Power Fx differential qualification](#lense-scripts-sdk-oracle)                               | `powerplatform sdk testing in:name,description,readme`                 | 10 results        | `powerfx`                                    | 6 results      |
| [Startup, dataset and DOM performance budgets and benchmarks](#lense-scripts-performance)                                                       | `node performance benchmark in:name,description,readme`                | 10 results        | `performance benchmark`                      | 10 results     |
| [Static quality, compatibility watchers and project boundary enforcement](#lense-scripts-static-quality)                                        | `javascript architecture checks in:name,description,readme`            | 10 results        | `architecture lint`                          | 10 results     |
| [CI orchestration, workflow security and effective PR merge readiness](#lense-scripts-ci-readiness)                                             | `github codeql checks in:name,description,readme`                      | 10 results        | `github actions validation`                  | 10 results     |
| [Dependency provenance, verified downloads, offline package cache and consumer smoke](#lense-scripts-package-integrity)                         | `npm supply chain verification in:name,description,readme`             | 10 results        | `package provenance`                         | 10 results     |
| [Release/version checks, preview release publication and retention](#lense-scripts-release-retention)                                           | `npm preview releases in:name,description,readme`                      | 10 results        | `release automation`                         | 10 results     |
| [Documentation site generation and executable demo workflows](#lense-scripts-docs-demo)                                                         | `documentation interactive examples in:name,description,readme`        | 10 results        | `documentation generator`                    | 10 results     |
| [Dataverse Web API, OData queries and navigation expansion](#mirage-dataverse-odata)                                                            | `Dataverse OData parser in:name,description,readme`                    | 10 results        | `dataverse odata parser`                     | 10 results     |
| [FetchXML joins, filters, aggregates and paging](#mirage-fetchxml)                                                                              | `FetchXML query engine in:name,description,readme`                     | 10 results        | `fetchxml parser query`                      | 10 results     |
| [TDS SQL parser, evaluation and wire protocol](#mirage-tds-sql)                                                                                 | `TDS SQL parser in:name,description,readme`                            | 10 results        | `tds sql parser`                             | 10 results     |
| [SOAP Organization Service and SDK query contracts](#mirage-organization-service)                                                               | `Dataverse OrganizationService mock in:name,description,readme`        | 3 results         | `dataverse organization service mock`        | 10 results     |
| [Exact numeric types, decimal arithmetic and lossless JSON](#mirage-exact-numerics)                                                             | `lossless JSON decimal in:name,description,readme`                     | 10 results        | `lossless json decimal bigint`               | 10 results     |
| [Dataverse GUIDs, typed comparison, collation and formatting](#mirage-typed-values)                                                             | `Dataverse formatted values in:name,description,readme`                | 10 results        | `dataverse formatted values`                 | 10 results     |
| [Calendar dates, time zones, fiscal periods and recurrence](#mirage-calendar-time)                                                              | `Windows IANA recurrence in:name,description,readme`                   | 10 results        | `windows iana timezone recurrence`           | 10 results     |
| [Solution XML/YAML import, component inventory and source graphs](#mirage-solution-import)                                                      | `"Power Platform" solution parser in:name,description,readme`          | 10 results        | `power platform solution parser`             | 10 results     |
| [Dataverse metadata API, CSDL and customization messages](#mirage-metadata-api)                                                                 | `Dataverse metadata CSDL in:name,description,readme`                   | 10 results        | `dataverse metadata csdl`                    | 10 results     |
| [Record validation, alternate keys, relationships and cascading operations](#mirage-record-validation)                                          | `Dataverse validation cascade in:name,description,readme`              | 10 results        | `dataverse schema validation`                | 10 results     |
| [Atomic transactions, batch changesets and committed event work](#mirage-atomic-transactions)                                                   | `OData batch changeset in:name,description,readme`                     | 10 results        | `odata batch changeset transaction`          | 10 results     |
| [Organization roles, teams, ownership and impersonation](#mirage-organization-security)                                                         | `Dataverse security impersonation in:name,description,readme`          | 10 results        | `dataverse security permissions`             | 10 results     |
| [Field-level security and portal table/page authorization](#mirage-portal-authorization)                                                        | `"Power Pages" permissions in:name,description,readme`                 | 10 results        | `power pages authorization permissions`      | 10 results     |
| [Local OAuth/OIDC identity provider and token authentication](#mirage-local-identity)                                                           | `OIDC identity emulator in:name,description,readme`                    | 10 results        | `oidc oauth mock identity`                   | 10 results     |
| [Isolated visitor/staff sessions and persona scenarios](#mirage-personas-sessions)                                                              | `testing persona isolation in:name,description,readme`                 | 10 results        | `test persona session isolation`             | 10 results     |
| [Liquid execution and Power Pages objects/filters](#mirage-liquid)                                                                              | `"Power Pages" Liquid in:name,description,readme`                      | 10 results        | `liquid template power pages`                | 10 results     |
| [Portal forms, multistep forms, lists and native postbacks](#mirage-portal-forms)                                                               | `"Power Pages" forms in:name,description,readme`                       | 10 results        | `power pages forms multistep`                | 10 results     |
| [Portal resources, localization, navigation and source reload](#mirage-portal-sources)                                                          | `"Power Pages" development in:name,description,readme`                 | 10 results        | `power pages local development`              | 10 results     |
| [Plugin pipeline, SDK calls and trusted CLR execution](#mirage-plugin-runtime)                                                                  | `Dataverse plugin testing in:name,description,readme`                  | 10 results        | `dataverse plugin testing mock`              | 10 results     |
| [Custom APIs, organization messages and server logic](#mirage-custom-api)                                                                       | `Dataverse custom API in:name,description,readme`                      | 10 results        | `dataverse custom api mock`                  | 10 results     |
| [Classic workflows, business process flows and business rules](#mirage-classic-workflows)                                                       | `Dataverse workflow simulator in:name,description,readme`              | 10 results        | `dataverse workflow business rules`          | 10 results     |
| [Power Automate WDL expressions and action execution](#mirage-flow-expressions)                                                                 | `"Power Automate" expression evaluator in:name,description,readme`     | 10 results        | `power automate expression evaluator`        | 10 results     |
| [Flow triggers, durable runs, waits, retries and cancellation](#mirage-durable-flows)                                                           | `durable workflow scheduler in:name,description,readme`                | 10 results        | `durable workflow scheduler retries`         | 10 results     |
| [Connector fixtures, connection references and secrets](#mirage-connectors-fixtures)                                                            | `"Power Automate" connector mock in:name,description,readme`           | 10 results        | `power automate connector mock`              | 10 results     |
| [Calculated columns, rollups, formulas and currency](#mirage-computed-columns)                                                                  | `Dataverse calculated rollup in:name,description,readme`               | 10 results        | `dataverse calculated rollup formula`        | 10 results     |
| [Schema-directed synthetic data, IDs and lookup population](#mirage-synthetic-data)                                                             | `Dataverse data generator in:name,description,readme`                  | 10 results        | `schema synthetic data relationships`        | 10 results     |
| [Explicit data packs, presets and configuration experiments](#mirage-packs-presets)                                                             | `test scenario presets in:name,description,readme`                     | 10 results        | `test data scenario presets`                 | 10 results     |
| [Model-driven shell, Xrm API, controls and side panes](#mirage-model-driven-host)                                                               | `Xrm model-driven mock in:name,description,readme`                     | 10 results        | `xrm mock model driven`                      | 10 results     |
| [PCF field/dataset hosting and lifecycle](#mirage-pcf-host)                                                                                     | `PCF test harness in:name,description,readme`                          | 10 results        | `pcf component test harness`                 | 10 results     |
| [Canvas import/player and Power Fx interpretation](#mirage-canvas-power-fx)                                                                     | `"Power Fx" interpreter in:name,description,readme`                    | 10 results        | `power fx interpreter canvas`                | 10 results     |
| [Code Apps local host and SDK compatibility](#mirage-code-apps)                                                                                 | `"Power Apps" "code apps" in:name,description,readme`                  | 10 results        | `power apps code apps sdk`                   | 10 results     |
| [Virtual table providers and elastic/Cosmos queries](#mirage-virtual-elastic)                                                                   | `Dataverse virtual elastic in:name,description,readme`                 | 10 results        | `dataverse virtual table cosmos`             | 10 results     |
| [Dataverse/portal search, duplicate detection and hierarchy](#mirage-search-duplicates)                                                         | `Dataverse search duplicates in:name,description,readme`               | 10 results        | `dataverse search duplicate detection`       | 10 results     |
| [File/image columns, attachments and block/range transfers](#mirage-files-images)                                                               | `Dataverse file upload in:name,description,readme`                     | 10 results        | `dataverse file block upload`                | 10 results     |
| [Blob providers, signed access and Azurite compatibility](#mirage-blob-storage)                                                                 | `Blob emulator SAS in:name,description,readme`                         | 10 results        | `azure blob emulator sas`                    | 10 results     |
| [SharePoint document locations and operations](#mirage-sharepoint-documents)                                                                    | `Dataverse SharePoint documents in:name,description,readme`            | 10 results        | `sharepoint document management mock`        | 10 results     |
| [Durable state, streamed checkpoints, journals and migrations](#mirage-state-persistence)                                                       | `JSON checkpoint journal in:name,description,readme`                   | 10 results        | `json database checkpoint journal`           | 10 results     |
| [Message bus, transactional outbox and webhook delivery](#mirage-messaging-outbox)                                                              | `transactional outbox webhook in:name,description,readme`              | 10 results        | `transactional outbox webhook queue`         | 10 results     |
| [Change tracking, audit history and local live updates](#mirage-change-audit-live)                                                              | `Dataverse change tracking in:name,description,readme`                 | 10 results        | `dataverse change tracking audit`            | 10 results     |
| [Deterministic clocks, IDs and test scheduling](#mirage-deterministic-testing)                                                                  | `deterministic clock scheduler in:name,description,readme`             | 10 results        | `deterministic clock scheduler testing`      | 10 results     |
| [Capability preflight, fidelity contracts and parity evidence](#mirage-capability-evidence)                                                     | `emulator conformance testing in:name,description,readme`              | 10 results        | `compatibility conformance contract testing` | 10 results     |
| [Real SDK compatibility and protocol regression harnesses](#mirage-sdk-compatibility)                                                           | `Dataverse SDK testing in:name,description,readme`                     | 10 results        | `dataverse sdk mock server`                  | 10 results     |
| [Standalone/multi-surface runtime composition and lifecycle isolation](#mirage-runtime-composition)                                             | `emulator lifecycle isolation in:name,description,readme`              | 10 results        | `local emulator runtime lifecycle`           | 10 results     |
| [Organization fiscal-year boundaries, period types, fiscal query operators and grouping](#extra-fiscal-calendar)                                | `fiscal calendar in:name,description,readme`                           | 10 results        | `fiscal calendar`                            | 10 results     |
| [Metadata-backed state/status transitions and allowed transition validation](#extra-state-status-transitions)                                   | `Dataverse status transitions in:name,description,readme`              | 10 results        | `dataverse status transitions`               | 10 results     |
| [Hierarchical relationship operators, ancestor/descendant traversal and cycle/depth handling](#extra-record-hierarchy)                          | `Dataverse hierarchy in:name,description,readme`                       | 10 results        | `dataverse hierarchy`                        | 10 results     |
| [Duplicate-rule conditions, publish/unpublish and create/update detection](#extra-duplicate-detection)                                          | `Dataverse duplicate detection in:name,description,readme`             | 10 results        | `dataverse duplicate detection`              | 10 results     |
| [Explicit virtual-table providers and externally backed table contracts](#extra-virtual-table-providers)                                        | `Dataverse virtual tables in:name,description,readme`                  | 10 results        | `dataverse virtual table`                    | 10 results     |
| [Elastic-table semantics, partitioning and Cosmos query interpretation](#extra-elastic-cosmos-tables)                                           | `Dataverse elastic Cosmos in:name,description,readme`                  | 10 results        | `cosmos query parser`                        | 10 results     |
| [PCF RESX localization, language selection, resource fallback and diagnostics](#extra-pcf-localization)                                         | `PCF localization RESX in:name,description,readme`                     | 10 results        | `resx localization`                          | 10 results     |
| [Exported ribbon/modern commands, enable/display rules and command execution](#extra-model-driven-command-rules)                                | `Dynamics ribbon commands in:name,description,readme`                  | 10 results        | `xrm ribbon rules`                           | 10 results     |
| [Certificate/JWT client assertions, thumbprints, TLS and replay/lifetime validation](#extra-certificate-client-auth)                            | `Dataverse certificate authentication in:name,description,readme`      | 10 results        | `dataverse certificate authentication`       | 10 results     |
| [Explicit service fixtures and bounded Power BI, AI Builder, Copilot, desktop-flow and platform addon messages](#extra-optional-service-addons) | `(PowerBI OR Copilot OR "AI Builder") mock in:name,description,readme` | 10 results        | `powerbi copilot mock`                       | 10 results     |
| [External asset/network allowlists, redirects, response policies and CSP boundaries](#extra-external-resource-policy)                           | `SSRF asset proxy in:name,description,readme`                          | 10 results        | `ssrf proxy protection`                      | 10 results     |
| [Local resource admission, path confinement, symlink checks and safe source reads](#extra-file-resource-confinement)                            | `node symlink security in:name,description,readme`                     | 10 results        | `safe file path`                             | 10 results     |
| [OpenAPI custom-connector schema, parameter validation and trusted C# script execution](#extra-custom-connector-definitions)                    | `PowerPlatform custom connectors in:name,description,readme`           | 10 results        | `openapi connector`                          | 10 results     |
| [Mobile offline profiles, local writes, replay, synchronization and conflict behavior](#extra-mobile-offline-sync)                              | `Dataverse offline sync in:name,description,readme`                    | 10 results        | `dataverse offline sync`                     | 10 results     |
| [Solution archives, dependencies, patches/upgrades, component membership and managed layers](#extra-solution-alm-lifecycle)                     | `Dataverse solution lifecycle in:name,description,readme`              | 10 results        | `dataverse solution`                         | 10 results     |
| [Transaction/base currency conversion, exchange rates and precision source semantics](#extra-currency-exchange-precision)                       | `Dataverse currency precision in:name,description,readme`              | 10 results        | `currency precision decimal`                 | 10 results     |
| [Business process flow stages, instance state, stage transitions and navigation](#extra-business-process-flow)                                  | `business process flow in:name,description,readme`                     | 10 results        | `business process flow`                      | 10 results     |
| [Source-backed business-rule conditions and field validation/actions](#extra-business-rule-evaluation)                                          | `PowerApps business rules in:name,description,readme`                  | 10 results        | `business rules engine`                      | 10 results     |
| [Dataverse request limits, rate/concurrency throttling and retry contracts](#extra-service-protection)                                          | `Dataverse throttling in:name,description,readme`                      | 10 results        | `dataverse retry throttling`                 | 10 results     |
| [Store-backed work queues, dequeue/SLA/history and native calendar/activity scheduling contracts](#extra-workqueues-activity-scheduling)        | `Dataverse work queues in:name,description,readme`                     | 10 results        | `work queue scheduling`                      | 10 results     |

## First-page receipts

<a id="lense-lense-cli"></a>

### CLI routing, argument validation and structured JSON output

Sources: [bin/paqvilo.mjs](../bin/paqvilo.mjs), [lense/cli.mjs](../lense/cli.mjs), [lense/command-payload.mjs](../lense/command-payload.mjs).

GitHub: `node cli json in:name,description,readme` — page 1, up to 10 results.

1. [googleworkspace/cli](https://github.com/googleworkspace/cli)
2. [larksuite/cli](https://github.com/larksuite/cli)
3. [devcontainers/cli](https://github.com/devcontainers/cli)
4. [inkonchain/node](https://github.com/inkonchain/node)
5. [trentm/json](https://github.com/trentm/json)
6. [MiniMax-AI/cli](https://github.com/MiniMax-AI/cli)
7. [acode/cli](https://github.com/acode/cli)
8. [node-js-libs/cli](https://github.com/node-js-libs/cli)
9. [brightdata/cli](https://github.com/brightdata/cli)
10. [dapr/cli](https://github.com/dapr/cli)

npm: `cli argument parser` — first registry result list, up to 10 packages.

1. [arg 5.0.2](https://www.npmjs.com/package/arg) — Unopinionated, no-frills CLI argument parser; source: [declared repository](https://github.com/vercel/arg.git).
2. [cli-args-parser 1.0.6](https://www.npmjs.com/package/cli-args-parser) — Expressive CLI argument parser with schema validation; source: [declared repository](https://github.com/forattini-dev/cli-args-parser.git).
3. [argus 0.0.3](https://www.npmjs.com/package/argus) — Complex CLI argument parser; source: a repository is declared in registry metadata.
4. [@boneskull/bargs 4.1.0](https://www.npmjs.com/package/@boneskull/bargs) — A TypeScript-first CLI argument parser wrapping util.parseArgs() with full type inference; source: [declared repository](https://github.com/boneskull/bargs.git).
5. [argvex 0.0.6](https://www.npmjs.com/package/argvex) — Lightweight and unopinionated CLI argument parser — just a parsing tool, not a framework; source: [declared repository](https://github.com/mzpkdev/argvex.git).
6. [@staticbolt/args-parser 1.0.0-beta.0](https://www.npmjs.com/package/@staticbolt/args-parser) — A TypeScript-first CLI argument parser with schema-based validation.; source: no repository declared in search metadata.
7. [slurm 0.5.10](https://www.npmjs.com/package/slurm) — Typescript-ready CLI argument parser; source: [declared repository](https://github.com/aleclarson/slurm.git).
8. [@alcyone-labs/arg-parser 3.0.1](https://www.npmjs.com/package/@alcyone-labs/arg-parser) — A robust, type-safe CLI argument parser with plugin support; source: a repository is declared in registry metadata.
9. [@hypernym/args 0.3.7](https://www.npmjs.com/package/@hypernym/args) — A fast and ultra lightweight CLI argument parser.; source: [declared repository](https://github.com/hypernym-studio/args.git).
10. [madlad 1.5.0](https://www.npmjs.com/package/madlad) — A CLI argument parser for Node.js. Handles commands, subcommand groups, options, positional arguments, type validation, shell completion, and help text generation.; source: no repository declared in search metadata.

<a id="lense-lense-catalogue"></a>

### Multi-site and environment catalogues, settings and YAML diagnostics

Sources: [lense/config.mjs](../lense/config.mjs), [lense/config-schema.mjs](../lense/config-schema.mjs), [lense/resolved-catalogue.mjs](../lense/resolved-catalogue.mjs), [lense/yaml-diagnostics.mjs](../lense/yaml-diagnostics.mjs).

GitHub: `yaml environment configuration in:name,description,readme` — page 1, up to 10 results.

1. [spf13/viper](https://github.com/spf13/viper)
2. [jenkinsci/configuration-as-code-plugin](https://github.com/jenkinsci/configuration-as-code-plugin)
3. [SteeltoeOSS/Configuration](https://github.com/SteeltoeOSS/Configuration) — archived
4. [jinzhu/configor](https://github.com/jinzhu/configor)
5. [tomzo/gocd-yaml-config-plugin](https://github.com/tomzo/gocd-yaml-config-plugin)
6. [dynaconf/dynaconf](https://github.com/dynaconf/dynaconf)
7. [markshust/docker-magento](https://github.com/markshust/docker-magento)
8. [ilyakaznacheev/cleanenv](https://github.com/ilyakaznacheev/cleanenv)
9. [carvel-dev/ytt](https://github.com/carvel-dev/ytt)
10. [dennyzhang/kubernetes-yaml-templates](https://github.com/dennyzhang/kubernetes-yaml-templates)

npm: `yaml config validation` — first registry result list, up to 10 packages.

1. [yaml-language-server 2.0.0](https://www.npmjs.com/package/yaml-language-server) — YAML language server; source: [declared repository](https://github.com/redhat-developer/yaml-language-server.git).
2. [yaml 2.9.1](https://www.npmjs.com/package/yaml) — JavaScript parser and stringifier for YAML; source: [declared repository](https://github.com/eemeli/yaml.git).
3. [js-yaml 5.5.0](https://www.npmjs.com/package/js-yaml) — YAML 1.2 parser and serializer; source: [declared repository](https://github.com/nodeca/js-yaml.git).
4. [monaco-yaml 5.5.1](https://www.npmjs.com/package/monaco-yaml) — YAML plugin for the Monaco Editor; source: [declared repository](https://github.com/remcohaszing/monaco-yaml.git).
5. [cosmiconfig 10.0.1](https://www.npmjs.com/package/cosmiconfig) — Find and load configuration from a package.json property, rc file, TypeScript module, and more&#33;; source: [declared repository](https://github.com/cosmiconfig/cosmiconfig.git).
6. [zod-validation-error 5.0.0](https://www.npmjs.com/package/zod-validation-error) — Wrap zod validation errors in user-friendly readable messages; source: a repository is declared in registry metadata.
7. [@roadiehq/backstage-entity-validator 0.7.0](https://www.npmjs.com/package/@roadiehq/backstage-entity-validator) — Backstage entity validator; source: [declared repository](https://github.com/RoadieHQ/backstage-entity-validator.git).
8. [@codemirror/lang-yaml 6.1.3](https://www.npmjs.com/package/@codemirror/lang-yaml) — YAML language support for the CodeMirror code editor; source: [declared repository](https://github.com/codemirror/lang-yaml.git).
9. [@percy/config 1.32.12](https://www.npmjs.com/package/@percy/config) — Handles loading and adding options to Percy configuration files. Uses &#91;cosmiconfig&#93;(https://github.com/davidtheclark/cosmiconfig) to load configuration files and &#91;JSON schema&#93;(https://json-schema.org/) with &#91;AJV&#93;(https://github.com/epoberezkin/ajv) to val; source: [declared repository](https://github.com/percy/cli.git).
10. [@zkochan/js-yaml 0.0.11](https://www.npmjs.com/package/@zkochan/js-yaml) — YAML 1.2 parser and serializer; source: [declared repository](https://github.com/nodeca/js-yaml.git).

<a id="lense-lense-project-scaffold"></a>

### Consumer project scaffolding, readiness and VS Code workflows

Sources: [lense/project-scaffold.mjs](../lense/project-scaffold.mjs), [lense/project-editor.mjs](../lense/project-editor.mjs), [lense/project-check.mjs](../lense/project-check.mjs), [lense/project-workflows.mjs](../lense/project-workflows.mjs).

GitHub: `project scaffold vscode in:name,description,readme` — page 1, up to 10 results.

1. [youzan/vant](https://github.com/youzan/vant)
2. [ElementUI/awesome-element](https://github.com/ElementUI/awesome-element)
3. [microsoft/Web-Dev-For-Beginners](https://github.com/microsoft/Web-Dev-For-Beginners)
4. [microsoft-foundry/Foundry_Toolkit_for_VSCode_Lab](https://github.com/microsoft-foundry/Foundry_Toolkit_for_VSCode_Lab)
5. [educ8s/Raylib-CPP-Starter-Template-for-VSCODE-V2](https://github.com/educ8s/Raylib-CPP-Starter-Template-for-VSCODE-V2)
6. [alex8088/electron-vite](https://github.com/alex8088/electron-vite)
7. [r5n-labs/vscode-react-javascript-snippets](https://github.com/r5n-labs/vscode-react-javascript-snippets)
8. [educ8s/Raylib-CPP-Starter-Template-for-VSCODE](https://github.com/educ8s/Raylib-CPP-Starter-Template-for-VSCODE)
9. [Kaggle/kaggle-cli](https://github.com/Kaggle/kaggle-cli)
10. [WordPress/agent-skills](https://github.com/WordPress/agent-skills)

npm: `project scaffold` — first registry result list, up to 10 packages.

1. [@tangle-network/starter-foundry 1.0.0](https://www.npmjs.com/package/@tangle-network/starter-foundry) — Deterministic project scaffold engine for AI coding platforms; source: [declared repository](https://github.com/tangle-network/starter-foundry.git).
2. [lineman 0.39.0](https://www.npmjs.com/package/lineman) — A grunt-based project scaffold for HTML/CSS/JS apps; source: [declared repository](https://github.com/linemanjs/lineman.git).
3. [storm-scaffold 1.7.1](https://www.npmjs.com/package/storm-scaffold) — Project scaffold; source: [declared repository](https://github.com/stormid/storm-scaffold.git).
4. [generator-barephp 1.0.1](https://www.npmjs.com/package/generator-barephp) — PHP project scaffold with lots of integrations; source: a repository is declared in registry metadata.
5. [nyg-jam3 5.0.2](https://www.npmjs.com/package/nyg-jam3) — Jam3 project scaffold generator based on nyg; source: [declared repository](https://github.com/Jam3/nyg-jam3.git).
6. [@napplet/boilerplate 0.4.1](https://www.npmjs.com/package/@napplet/boilerplate) — Project scaffold generator for the napplet boilerplate template; source: [declared repository](https://github.com/napplet/napplet.git).
7. [@bear1210/create-rn-template 0.1.4](https://www.npmjs.com/package/@bear1210/create-rn-template) — Business-free React Native 0.81.6 project scaffold CLI; source: [declared repository](https://github.com/TonyChan-hub/AppSetup.git).
8. [lavas-scaffold 2.0.0-alpha](https://www.npmjs.com/package/lavas-scaffold) — PWA project scaffold solution; source: [declared repository](https://github.com/lavas-project/lavas-scaffold.git).
9. [yz-cli 0.6.11](https://www.npmjs.com/package/yz-cli) — yazuo web project scaffold; source: [declared repository](https://github.com/MingNeo/ya-cli.git).
10. [@deppon/create-deppon-app 2.5.105](https://www.npmjs.com/package/@deppon/create-deppon-app) — Vue 3 project scaffold CLI tool; source: no repository declared in search metadata.

<a id="lense-lense-setup-workspace"></a>

### Browser-based local configuration workspace and dependency readiness

Sources: [lense/commands/setup.mjs](../lense/commands/setup.mjs), [lense/setup/server.mjs](../lense/setup/server.mjs), [scripts/ensure-dependencies.mjs](../scripts/ensure-dependencies.mjs).

GitHub: `local configuration editor in:name,description,readme` — page 1, up to 10 results.

1. [nuxt-ui-templates/editor](https://github.com/nuxt-ui-templates/editor)
2. [opencast/editor](https://github.com/opencast/editor)
3. [edit4i/editor](https://github.com/edit4i/editor)
4. [blakeblackshear/frigate](https://github.com/blakeblackshear/frigate)
5. [abhigyanpatwari/GitNexus](https://github.com/abhigyanpatwari/GitNexus)
6. [gpakosz/.tmux](https://github.com/gpakosz/.tmux)
7. [blokkli/editor](https://github.com/blokkli/editor)
8. [z-song/laravel-admin](https://github.com/z-song/laravel-admin)
9. [shuzijun/leetcode-editor](https://github.com/shuzijun/leetcode-editor)
10. [PatrickJS/awesome-cursorrules](https://github.com/PatrickJS/awesome-cursorrules)

Refinement: `"configuration editor" schema in:name,description` — page 1, up to 10 results.

1. [harc-lang/gpui-schema](https://github.com/harc-lang/gpui-schema)
2. [wertasy/json-schema-editor](https://github.com/wertasy/json-schema-editor) — archived
3. [homeIoTDev/jsonsui](https://github.com/homeIoTDev/jsonsui)
4. [Kaan-YASSIBAS/ai-config-tool](https://github.com/Kaan-YASSIBAS/ai-config-tool)
5. [liutian11451-png/dsh-plugin-model-config](https://github.com/liutian11451-png/dsh-plugin-model-config)
6. [yana-arch/opencode-config-editor](https://github.com/yana-arch/opencode-config-editor)
7. [sebastianrothbucher/config-yaml](https://github.com/sebastianrothbucher/config-yaml)

npm: `configuration wizard` — first registry result list, up to 10 packages.

1. [react-use-wizard 2.3.0](https://www.npmjs.com/package/react-use-wizard) — React wizard (stepper) builder without the hassle, powered by hooks.; source: [declared repository](https://github.com/devrnt/react-use-wizard).
2. [smartwizard 7.2.0](https://www.npmjs.com/package/smartwizard) — A modern and accessible step wizard plugin for jQuery; source: [declared repository](https://github.com/techlab/jquery-smartwizard.git).
3. [@sentry/wizard 9.0.0](https://www.npmjs.com/package/@sentry/wizard) — Sentry wizard helping you to configure your project; source: [declared repository](https://github.com/getsentry/sentry-wizard.git).
4. [react-step-wizard 5.3.11](https://www.npmjs.com/package/react-step-wizard) — A modern flexible step wizard component built for React; source: [declared repository](https://github.com/jcmcneal/react-step-wizard.git).
5. [@tensorflow/tfjs-converter 4.22.0](https://www.npmjs.com/package/@tensorflow/tfjs-converter) — Tensorflow model converter for javascript; source: [declared repository](https://github.com/tensorflow/tfjs.git).
6. [@antfu/eslint-config 10.0.0](https://www.npmjs.com/package/@antfu/eslint-config) — Anthony's ESLint config; source: [declared repository](https://github.com/antfu/eslint-config.git).
7. [@sap/generator-fiori 1.34.0](https://www.npmjs.com/package/@sap/generator-fiori) — Create an SAPUI5 application using SAP Fiori elements or a freestyle approach; source: no repository declared in search metadata.
8. [use-wizard 4.0.6](https://www.npmjs.com/package/use-wizard) — A dead-easy-to-use light-weight react hook to handle multi-paths wizards (and simple wizards too) and navigate into them. ; source: [declared repository](https://github.com/use-wizard/use-wizard.git).
9. [vue-form-wizard 0.8.4](https://www.npmjs.com/package/vue-form-wizard) — A vue based tab/form wizard; source: [declared repository](https://github.com/cristijora/vue-form-wizard.git).
10. [@kaizentech/wizard-sdk 1.0.41](https://www.npmjs.com/package/@kaizentech/wizard-sdk) — KLP Wizard SDK - CDN üzerinden embed edilebilir frontend script; source: no repository declared in search metadata.

<a id="lense-lense-source-discovery"></a>

### Portal export discovery, file identity and resource route resolution

Sources: [lense/resolver.mjs](../lense/resolver.mjs), [lense/portal-model.mjs](../lense/portal-model.mjs), [lense/directory-files.mjs](../lense/directory-files.mjs), [lense/file-identity.mjs](../lense/file-identity.mjs), [lense/definition-query.mjs](../lense/definition-query.mjs).

GitHub: `powerpages development in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/powerplatform-vscode](https://github.com/microsoft/powerplatform-vscode)
2. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
3. [casualwriter/powerpage](https://github.com/casualwriter/powerpage)
4. [clerkio/clerk-magento](https://github.com/clerkio/clerk-magento)
5. [melamriD365/powerpages-spa-bot-starter](https://github.com/melamriD365/powerpages-spa-bot-starter)
6. [casualwriter/powerpage-md-document](https://github.com/casualwriter/powerpage-md-document)
7. [maksii/paqvilo](https://github.com/maksii/paqvilo) — this repository; excluded as a candidate
8. [DynamicSadFun/PowerPages](https://github.com/DynamicSadFun/PowerPages)
9. [GodChosen/powerpages](https://github.com/GodChosen/powerpages)
10. [Kunter-Bunt/PowerPagesClientAPI](https://github.com/Kunter-Bunt/PowerPagesClientAPI) — archived

npm: `powerpages` — first registry result list, up to 10 packages.

1. [@microsoft/generator-powerpages 1.39.3](https://www.npmjs.com/package/@microsoft/generator-powerpages) — Yeoman Generator for Power Pages.; source: no repository declared in search metadata.
2. [@schemastore/powerpages-web-template-manifest 1.0.2](https://www.npmjs.com/package/@schemastore/powerpages-web-template-manifest) — TypeScript definitions for powerpages-web-template-manifest.; source: [declared repository](https://github.com/ffflorian/schemastore-updater.git).
3. [powerpagestoolkit 3.27.0](https://www.npmjs.com/package/powerpagestoolkit) — Reference, manipulate, and engage with Power Pages sites through the nodes in the DOM; use a variety of custom methods that allow customizing your power pages site quicker and easier. ; source: [declared repository](https://github.com/Keaton-Brewster/PowerPagesToolKit.git).
4. [pageslens 0.10.0](https://www.npmjs.com/package/pageslens) — Offline lint, policy tests and docs for Power Pages site configuration in source control; source: [declared repository](https://github.com/OOlashyn/pageslens.git).
5. [webcollage-powerpages 1.0.0](https://www.npmjs.com/package/webcollage-powerpages) — Implement Webcollage; source: no repository declared in search metadata.
6. [@iflow-mcp/mwhesse-dataverse-mcp 0.2.8](https://www.npmjs.com/package/@iflow-mcp/mwhesse-dataverse-mcp) — MCP server for Dataverse schema operations; source: no repository declared in search metadata.
7. [@beaker73/dataverse.api 0.4.0](https://www.npmjs.com/package/@beaker73/dataverse.api) — Beaker Dataverse API for Client apps; source: [declared repository](https://github.com/Beaker73/Beaker.Dataverse.git#master).
8. [powpow-cli 0.6.0](https://www.npmjs.com/package/powpow-cli) — Pro-code development tool for Power Pages with TypeScript transpilation and local development server features.; source: [declared repository](https://github.com/itera-fredrikstad/powpow-cli.git).
9. [@schemastore/powerpages.config 1.0.2](https://www.npmjs.com/package/@schemastore/powerpages.config) — TypeScript definitions for powerpages.config.; source: [declared repository](https://github.com/ffflorian/schemastore-updater.git).
10. [create-ec-app 1.16.3](https://www.npmjs.com/package/create-ec-app) — Unified CLI tool to create different types of EC applications: Webresource, Portal, Power Pages, Power Apps Code Apps; source: [declared repository](https://github.com/Enterprisecloud-Pty-Ltd/create-ec-app.git).

<a id="lense-lense-response-overlay"></a>

### HTTP response overlays, inline scripts/styles and literal HTML patches

Sources: [lense/intercept.mjs](../lense/intercept.mjs), [lense/html-rewriter.mjs](../lense/html-rewriter.mjs), [lense/navigation.mjs](../lense/navigation.mjs).

GitHub: `browser response overrides in:name,description,readme` — page 1, up to 10 results.

1. [axios/axios](https://github.com/axios/axios)
2. [vercel-labs/agent-browser](https://github.com/vercel-labs/agent-browser)
3. [steel-dev/steel-browser](https://github.com/steel-dev/steel-browser)
4. [daijro/camoufox](https://github.com/daijro/camoufox)
5. [h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)
6. [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill)
7. [Alishahryar1/free-claude-code](https://github.com/Alishahryar1/free-claude-code)
8. [D4Vinci/Scrapling](https://github.com/D4Vinci/Scrapling)
9. [typicode/json-server](https://github.com/typicode/json-server)
10. [koush/AndroidAsync](https://github.com/koush/AndroidAsync)

npm: `http response override` — first registry result list, up to 10 packages.

1. [decompress-response 10.0.0](https://www.npmjs.com/package/decompress-response) — Decompress a HTTP response if needed; source: [declared repository](https://github.com/sindresorhus/decompress-response.git).
2. [responselike 4.0.2](https://www.npmjs.com/package/responselike) — A response-like object for mocking a Node.js HTTP response stream; source: [declared repository](https://github.com/sindresorhus/responselike.git).
3. [clone-response 2.0.0](https://www.npmjs.com/package/clone-response) — Clone a Node.js HTTP response stream; source: [declared repository](https://github.com/sindresorhus/clone-response.git).
4. [@szmarczak/http-timer 5.0.1](https://www.npmjs.com/package/@szmarczak/http-timer) — Timings for HTTP requests; source: [declared repository](https://github.com/szmarczak/http-timer.git).
5. [@cypress/request 4.0.1](https://www.npmjs.com/package/@cypress/request) — Cypress's fork of a simplified HTTP request client.; source: [declared repository](https://github.com/cypress-io/request.git).
6. [http-response-object 3.0.2](https://www.npmjs.com/package/http-response-object) — A simple object to represent an http response; source: [declared repository](https://github.com/ForbesLindesay/http-response-object.git).
7. [@npmcli/agent 5.0.2](https://www.npmjs.com/package/@npmcli/agent) — the http/https agent used by the npm cli; source: [declared repository](https://github.com/npm/agent.git).
8. [mimic-response 4.0.0](https://www.npmjs.com/package/mimic-response) — Mimic a Node.js HTTP response stream; source: [declared repository](https://github.com/sindresorhus/mimic-response.git).
9. [needle 3.5.0](https://www.npmjs.com/package/needle) — The leanest and most handsome HTTP client in the Nodelands.; source: [declared repository](https://github.com/tomas/needle.git).
10. [fresh 0.5.2](https://www.npmjs.com/package/fresh) — HTTP response freshness testing; source: [declared repository](https://github.com/jshttp/fresh.git).

<a id="lense-lense-watch-reload"></a>

### Source watching, multi-target reload and interception readiness

Sources: [lense/commands/dev.mjs](../lense/commands/dev.mjs), [lense/file-cache.mjs](../lense/file-cache.mjs), [lense/response-proof-queue.mjs](../lense/response-proof-queue.mjs), [lense/dev-sessions.mjs](../lense/dev-sessions.mjs).

GitHub: `browser live reload in:name,description,readme` — page 1, up to 10 results.

1. [air-verse/air](https://github.com/air-verse/air)
2. [ritwickdey/vscode-live-server](https://github.com/ritwickdey/vscode-live-server)
3. [tapio/live-server](https://github.com/tapio/live-server)
4. [guard/guard-livereload](https://github.com/guard/guard-livereload)
5. [MoSync/Reload](https://github.com/MoSync/Reload)
6. [ritwickdey/vscode-live-sass-compiler](https://github.com/ritwickdey/vscode-live-sass-compiler) — archived
7. [livereload/livereload-js](https://github.com/livereload/livereload-js)
8. [gruntjs/grunt-contrib-livereload](https://github.com/gruntjs/grunt-contrib-livereload)
9. [ritwickdey/live-server-web-extension](https://github.com/ritwickdey/live-server-web-extension)
10. [phoenixframework/phoenix_live_reload](https://github.com/phoenixframework/phoenix_live_reload)

npm: `live reload watcher` — first registry result list, up to 10 packages.

1. [@parcel/watcher-linux-x64-glibc 2.6.0](https://www.npmjs.com/package/@parcel/watcher-linux-x64-glibc) — A native C++ Node module for querying and subscribing to filesystem events. Used by Parcel 2.; source: [declared repository](https://github.com/parcel-bundler/watcher.git).
2. [@parcel/watcher-linux-x64-musl 2.6.0](https://www.npmjs.com/package/@parcel/watcher-linux-x64-musl) — A native C++ Node module for querying and subscribing to filesystem events. Used by Parcel 2.; source: [declared repository](https://github.com/parcel-bundler/watcher.git).
3. [vite-plugin-live-reload 4.0.0](https://www.npmjs.com/package/vite-plugin-live-reload) — A simple live reloading plugin for vite.; source: [declared repository](https://github.com/arnoson/vite-plugin-live-reload.git).
4. [create-serve 1.0.1](https://www.npmjs.com/package/create-serve) — 🍛 Ultralight http server with live reload. &#91;CLI + API&#93;; source: [declared repository](https://github.com/nativew/serve.git).
5. [@deepseek-ai/dsh-settings-file 0.0.1-rc.3](https://www.npmjs.com/package/@deepseek-ai/dsh-settings-file) — File-backed settings provider (settings.yaml) for the DeepSeek Harness; source: [declared repository](https://github.com/deepseek-ai/deepseek-harness.git).
6. [@parcel/watcher-linux-arm64-musl 2.6.0](https://www.npmjs.com/package/@parcel/watcher-linux-arm64-musl) — A native C++ Node module for querying and subscribing to filesystem events. Used by Parcel 2.; source: [declared repository](https://github.com/parcel-bundler/watcher.git).
7. [@parcel/watcher 2.6.0](https://www.npmjs.com/package/@parcel/watcher) — A native C++ Node module for querying and subscribing to filesystem events. Used by Parcel 2.; source: [declared repository](https://github.com/parcel-bundler/watcher.git).
8. [@parcel/watcher-linux-arm64-glibc 2.6.0](https://www.npmjs.com/package/@parcel/watcher-linux-arm64-glibc) — A native C++ Node module for querying and subscribing to filesystem events. Used by Parcel 2.; source: [declared repository](https://github.com/parcel-bundler/watcher.git).
9. [@parcel/watcher-win32-ia32 2.5.6](https://www.npmjs.com/package/@parcel/watcher-win32-ia32) — A native C++ Node module for querying and subscribing to filesystem events. Used by Parcel 2.; source: [declared repository](https://github.com/parcel-bundler/watcher.git).
10. [@parcel/watcher-android-arm64 2.6.0](https://www.npmjs.com/package/@parcel/watcher-android-arm64) — A native C++ Node module for querying and subscribing to filesystem events. Used by Parcel 2.; source: [declared repository](https://github.com/parcel-bundler/watcher.git).

<a id="lense-lense-browser-sessions"></a>

### Persistent browser profiles, signed-in sessions, CDP and owned cleanup

Sources: [lense/browser.mjs](../lense/browser.mjs), [lense/browser-profile.mjs](../lense/browser-profile.mjs), [lense/session.mjs](../lense/session.mjs), [lense/owned-page-binding.mjs](../lense/owned-page-binding.mjs), [lense/stop-command.mjs](../lense/stop-command.mjs).

GitHub: `playwright persistent profiles in:name,description,readme` — page 1, up to 10 results.

1. [CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser)
2. [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)
3. [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli)
4. [CopilotKit/openmuse](https://github.com/CopilotKit/openmuse)
5. [remorses/playwriter](https://github.com/remorses/playwriter)
6. [teng-lin/notebooklm-py](https://github.com/teng-lin/notebooklm-py)
7. [coll3879xx-cyber/dola-render-gateway](https://github.com/coll3879xx-cyber/dola-render-gateway)
8. [Kaliiiiiiiiii-Vinyzu/patchright](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)
9. [lexmount/moli](https://github.com/lexmount/moli)
10. [Aas-ee/open-webSearch](https://github.com/Aas-ee/open-webSearch)

npm: `playwright browser profile` — first registry result list, up to 10 packages.

1. [playwright-core 1.64.1](https://www.npmjs.com/package/playwright-core) — A high-level API to automate web browsers; source: [declared repository](https://github.com/microsoft/playwright.git).
2. [@vitest/browser-playwright 5.0.5](https://www.npmjs.com/package/@vitest/browser-playwright) — Browser running for Vitest using playwright; source: [declared repository](https://github.com/vitest-dev/vitest.git).
3. [@vitest/browser 5.0.5](https://www.npmjs.com/package/@vitest/browser) — Browser running for Vitest; source: [declared repository](https://github.com/vitest-dev/vitest.git).
4. [playwright 1.64.1](https://www.npmjs.com/package/playwright) — A high-level API to automate web browsers; source: [declared repository](https://github.com/microsoft/playwright.git).
5. [@playwright/test 1.64.1](https://www.npmjs.com/package/@playwright/test) — A high-level API to automate web browsers; source: [declared repository](https://github.com/microsoft/playwright.git).
6. [@axe-core/playwright 4.14.0](https://www.npmjs.com/package/@axe-core/playwright) — Provides a method to inject and analyze web pages using axe; source: [declared repository](https://github.com/dequelabs/axe-core-npm.git).
7. [@vitest/browser-preview 5.0.5](https://www.npmjs.com/package/@vitest/browser-preview) — Browser running for Vitest using your browser of choice; source: [declared repository](https://github.com/vitest-dev/vitest.git).
8. [@playwright/browser-chromium 1.64.1](https://www.npmjs.com/package/@playwright/browser-chromium) — Playwright package that automatically installs Chromium; source: [declared repository](https://github.com/microsoft/playwright.git).
9. [@playwright/mcp 0.0.83](https://www.npmjs.com/package/@playwright/mcp) — Playwright Tools for MCP; source: [declared repository](https://github.com/microsoft/playwright-mcp.git).
10. [playwright-bdd 9.2.1](https://www.npmjs.com/package/playwright-bdd) — BDD Testing with Playwright runner; source: [declared repository](https://github.com/vitalets/playwright-bdd.git).

<a id="lense-lense-startup-lifecycle"></a>

### Startup deadlines, progress and supervised local runtime lifecycle

Sources: [lense/startup-deadline.mjs](../lense/startup-deadline.mjs), [lense/startup-progress.mjs](../lense/startup-progress.mjs), [lense/standalone-mirage.mjs](../lense/standalone-mirage.mjs).

GitHub: `dev server lifecycle in:name,description,readme` — page 1, up to 10 results.

1. [theforeman/foreman](https://github.com/theforeman/foreman)
2. [agones-dev/agones](https://github.com/agones-dev/agones)
3. [FAForever/server](https://github.com/FAForever/server)
4. [milanm/DevOps-Roadmap](https://github.com/milanm/DevOps-Roadmap)
5. [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
6. [bregman-arie/devops-exercises](https://github.com/bregman-arie/devops-exercises)
7. [serverless/serverless](https://github.com/serverless/serverless)
8. [dherault/serverless-offline](https://github.com/dherault/serverless-offline)
9. [LondheShubham153/terraform-for-devops](https://github.com/LondheShubham153/terraform-for-devops)
10. [iampawan/FlutterExampleApps](https://github.com/iampawan/FlutterExampleApps)

Refinement: `"graceful shutdown" node in:name,description` — page 1, up to 10 results.

1. [RisingStack/kubernetes-graceful-shutdown-example](https://github.com/RisingStack/kubernetes-graceful-shutdown-example)
2. [godaddy/terminus](https://github.com/godaddy/terminus)
3. [sebhildebrandt/http-graceful-shutdown](https://github.com/sebhildebrandt/http-graceful-shutdown)
4. [the-moebius/http-graceful-shutdown](https://github.com/the-moebius/http-graceful-shutdown)
5. [gajus/lightship](https://github.com/gajus/lightship)
6. [nikitaeverywhere/node-graceful-shutdown](https://github.com/nikitaeverywhere/node-graceful-shutdown)
7. [ZoolWay/akka-net-cluster-graceful-shutdown-samples](https://github.com/ZoolWay/akka-net-cluster-graceful-shutdown-samples)
8. [gitterHQ/shutdown](https://github.com/gitterHQ/shutdown) — archived
9. [josiasmontag/node-server-graceful-shutdown](https://github.com/josiasmontag/node-server-graceful-shutdown)
10. [simonecorsi/fine](https://github.com/simonecorsi/fine) — archived

npm: `dev server shutdown` — first registry result list, up to 10 packages.

1. [http-shutdown 1.2.2](https://www.npmjs.com/package/http-shutdown) — Gracefully shutdown a running HTTP server.; source: [declared repository](https://github.com/thedillonb/http-shutdown.git).
2. [http-graceful-shutdown 4.0.0](https://www.npmjs.com/package/http-graceful-shutdown) — gracefully shuts downs http server; source: [declared repository](https://github.com/sebhildebrandt/http-graceful-shutdown.git).
3. [listhen 1.10.1](https://www.npmjs.com/package/listhen) — 👂 Elegant HTTP Listener; source: a repository is declared in registry metadata.
4. [nestjs-graceful-shutdown 2.0.0](https://www.npmjs.com/package/nestjs-graceful-shutdown) — A powerful package for gracefully shutting down NestJS applications; source: [declared repository](https://github.com/hienngm/nestjs-graceful-shutdown.git).
5. [@deepseek-ai/dsh-sdk-jsonrpc-server 0.0.1-rc.5](https://www.npmjs.com/package/@deepseek-ai/dsh-sdk-jsonrpc-server) — Stdio JSON-RPC server plugin for out-of-process DeepSeek Harness SDK clients; source: [declared repository](https://github.com/deepseek-ai/deepseek-harness.git).
6. [@moebius/http-graceful-shutdown 1.1.0](https://www.npmjs.com/package/@moebius/http-graceful-shutdown) — Gracefully terminates HTTP servers in Node.js; source: no repository declared in search metadata.
7. [@vinxi/listhen 1.5.6](https://www.npmjs.com/package/@vinxi/listhen) — 👂 Elegant HTTP Listener; source: [declared repository](https://github.com/unjs/listhen.git).
8. [http-proxy 1.18.1](https://www.npmjs.com/package/http-proxy) — HTTP proxying for the masses; source: [declared repository](https://github.com/http-party/node-http-proxy.git).
9. [node-graceful-shutdown 1.1.6](https://www.npmjs.com/package/node-graceful-shutdown) — Gracefully shutdown your modular NodeJS application; source: [declared repository](https://github.com/ZitRos/node-graceful-shutdown.git).
10. [@deepseek-ai/dsh-sdk-app 0.1.2-alpha.2](https://www.npmjs.com/package/@deepseek-ai/dsh-sdk-app) — The dsh SDK profile bundle: stdio JSON-RPC serving and process lifecycle over dsh-base; source: [declared repository](https://github.com/deepseek-ai/deepseek-harness.git).

<a id="lense-lense-baseline-verification"></a>

### Git baselines, temporary-copy browser verification and Online/Local comparison

Sources: [lense/git.mjs](../lense/git.mjs), [lense/line-diff.mjs](../lense/line-diff.mjs), [lense/commands/verify.mjs](../lense/commands/verify.mjs), [lense/online.mjs](../lense/online.mjs).

GitHub: `browser visual comparison in:name,description,readme` — page 1, up to 10 results.

1. [browser-use/video-use](https://github.com/browser-use/video-use)
2. [mdn/browser-compat-data](https://github.com/mdn/browser-compat-data)
3. [cmdcolin/awesome-genome-visualization](https://github.com/cmdcolin/awesome-genome-visualization)
4. [WinMerge/winmerge](https://github.com/WinMerge/winmerge)
5. [hangwin/mcp-chrome](https://github.com/hangwin/mcp-chrome)
6. [PaddlePaddle/VisualDL](https://github.com/PaddlePaddle/VisualDL)
7. [npmx-dev/npmx.dev](https://github.com/npmx-dev/npmx.dev)
8. [lexmount/moli](https://github.com/lexmount/moli)
9. [mojoaxel/awesome-regression-testing](https://github.com/mojoaxel/awesome-regression-testing)
10. [webdriverio/visual-testing](https://github.com/webdriverio/visual-testing)

Refinement: `"visual regression" browser in:name,description language:TypeScript` — page 1, up to 10 results.

1. [jflagarde/website-visual-testing](https://github.com/jflagarde/website-visual-testing)
2. [hassan-alnator/vibe-eyes](https://github.com/hassan-alnator/vibe-eyes)
3. [jvdieten/visual-check-testcafe](https://github.com/jvdieten/visual-check-testcafe)
4. [TokhirjonYuldoshev/pomidorqa-tests](https://github.com/TokhirjonYuldoshev/pomidorqa-tests)
5. [k35o/storybook-addon-vrt](https://github.com/k35o/storybook-addon-vrt)
6. [votoznotna/playwright-cursor-demo](https://github.com/votoznotna/playwright-cursor-demo)
7. [flammenmensch/vite-app-template](https://github.com/flammenmensch/vite-app-template)
8. [ZeeshanMustafaJumabhoy/Browserstack_Automate_Playwright](https://github.com/ZeeshanMustafaJumabhoy/Browserstack_Automate_Playwright)
9. [ZapataMejia/visual-regression-testing](https://github.com/ZapataMejia/visual-regression-testing)
10. [daniel-raj-s/visual-regression](https://github.com/daniel-raj-s/visual-regression)

npm: `visual regression comparison` — first registry result list, up to 10 packages.

1. [@luhanxin/visual 3.0.0](https://www.npmjs.com/package/@luhanxin/visual) — PNG screenshot capture and visual regression comparison utilities; source: [declared repository](https://github.com/lhx-space/luhanxin-automation.git).
2. [@wdio/visual-service 11.0.0](https://www.npmjs.com/package/@wdio/visual-service) — Image comparison / visual regression testing for WebdriverIO; source: [declared repository](https://github.com/webdriverio/visual-testing.git).
3. [cypress-visual-regression 6.0.1](https://www.npmjs.com/package/cypress-visual-regression) — Module for adding visual regression testing to Cypress; source: [declared repository](https://github.com/cypress-visual-regression/cypress-visual-regression.git).
4. [reg-suit 0.14.5](https://www.npmjs.com/package/reg-suit) — &#33;&#91;reg-suit&#93;(./images/reg-suit.jpg); source: [declared repository](https://github.com/reg-viz/reg-suit.git).
5. [@visual-regression-tracker/agent-playwright 5.3.2](https://www.npmjs.com/package/@visual-regression-tracker/agent-playwright) — Native integration for Playwright with Visual Regression Tracker; source: [declared repository](https://github.com/Visual-Regression-Tracker/agent-playwright.git).
6. [@web/test-runner-visual-regression 1.0.1](https://www.npmjs.com/package/@web/test-runner-visual-regression) — Web test runner visual regression; source: [declared repository](https://github.com/modernweb-dev/web.git).
7. [pdf-visual-diff 0.16.0](https://www.npmjs.com/package/pdf-visual-diff) — Visual Regression Testing for PDFs in JavaScript; source: [declared repository](https://github.com/moshensky/pdf-visual-diff.git).
8. [vega-regression 2.1.3](https://www.npmjs.com/package/vega-regression) — Regression transform for Vega dataflows.; source: [declared repository](https://github.com/vega/vega.git).
9. [@storycap-testrun/browser 3.1.3](https://www.npmjs.com/package/@storycap-testrun/browser) — Screenshot capture for Storybook addon-vitest - Provides stable visual testing functionality and Vitest plugin for Storybook stories running in browser environments; source: [declared repository](https://github.com/reg-viz/storycap-testrun.git).
10. [@digital-commons-official/codeceptjs-visual-helper 2.0.13](https://www.npmjs.com/package/@digital-commons-official/codeceptjs-visual-helper) — Visual regression testing helper for CodeceptJS with Playwright, Puppeteer, WebDriver, Appium &#38; TestCafe support; source: [declared repository](https://gitlab.com/digital-commons/software/libraries/npm/codeceptjs-visual-helper.git).

<a id="lense-lense-resource-audit"></a>

### Resource inventory, mapping coverage, strict audits and diagnostics

Sources: [lense/resource-audit.mjs](../lense/resource-audit.mjs), [lense/audit-json.mjs](../lense/audit-json.mjs), [lense/commands/audit.mjs](../lense/commands/audit.mjs), [lense/commands/doctor.mjs](../lense/commands/doctor.mjs), [lense/commands/resources.mjs](../lense/commands/resources.mjs), [lense/commands/map.mjs](../lense/commands/map.mjs).

GitHub: `powerpages resource audit in:name,description,readme` — page 1, up to 10 results.

1. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
2. [roygitongax/powerplatform-mcp](https://github.com/roygitongax/powerplatform-mcp)
3. [PowerBIPro-eu/ddsol-dataverse-mcp](https://github.com/PowerBIPro-eu/ddsol-dataverse-mcp)
4. [AEL-GROUP/powerplatform-mcp](https://github.com/AEL-GROUP/powerplatform-mcp)
5. [Unigalactix/powerplatform-mcp-docs](https://github.com/Unigalactix/powerplatform-mcp-docs)
6. [Sparsh-mckccn/PowerAutomate-Sparsh](https://github.com/Sparsh-mckccn/PowerAutomate-Sparsh)
7. [helloxtech/EnterpriseServiceIntake](https://github.com/helloxtech/EnterpriseServiceIntake)
8. [microsoft/TechLab-Sales-and-Service-MDX-Set-Up](https://github.com/microsoft/TechLab-Sales-and-Service-MDX-Set-Up)
9. [sect0r-cybersec/microsoft-app-ids](https://github.com/sect0r-cybersec/microsoft-app-ids)
10. [DAnuraag/b](https://github.com/DAnuraag/b)

Refinement: `"Power Pages" "source" audit in:readme` — page 1, up to 10 results.

1. [microsoft/contoso-real-estate-power-platform](https://github.com/microsoft/contoso-real-estate-power-platform)
2. [scottdurow/magical-mystery-tour](https://github.com/scottdurow/magical-mystery-tour) — archived
3. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
4. [hashgraph-online/awesome-ai-plugins](https://github.com/hashgraph-online/awesome-ai-plugins)
5. [scottdurow/power-platform-full-stack-skills](https://github.com/scottdurow/power-platform-full-stack-skills)
6. [microsoft/ABS-CSA-Assets](https://github.com/microsoft/ABS-CSA-Assets)
7. [microsoft/power-cat-skills](https://github.com/microsoft/power-cat-skills)
8. [DFE-Digital/power-pages-security-utils](https://github.com/DFE-Digital/power-pages-security-utils)
9. [jnPiyush/AgentX](https://github.com/jnPiyush/AgentX)
10. [TheLobbi/Claude-m](https://github.com/TheLobbi/Claude-m)

npm: `website resource audit` — first registry result list, up to 10 packages.

1. [@babel/plugin-transform-explicit-resource-management 8.0.5](https://www.npmjs.com/package/@babel/plugin-transform-explicit-resource-management) — Compile &#96;using&#96; and &#96;await using&#96; declarations to ES2015; source: [declared repository](https://github.com/babel/babel.git).
2. [third-party-capital 3.0.0](https://www.npmjs.com/package/third-party-capital) — &#60;img alt="Third Party Capital Logo" title="Third Party Capital Logo" src="https://user-images.githubusercontent.com/12476932/229881508-&#42;&#42;&#42;.png" width="150"&#62;; source: [declared repository](https://github.com/housseindjirdeh/third-party-capital.git).
3. [@strapi/provider-audit-logs-local 4.25.23](https://www.npmjs.com/package/@strapi/provider-audit-logs-local) — Local provider for strapi audit logs; source: a repository is declared in registry metadata.
4. [audit-ci 7.1.0](https://www.npmjs.com/package/audit-ci) — Audits NPM, Yarn, and PNPM projects in CI environments; source: a repository is declared in registry metadata.
5. [@babel/plugin-syntax-explicit-resource-management 7.29.7](https://www.npmjs.com/package/@babel/plugin-syntax-explicit-resource-management) — Allow parsing of the using declarations; source: [declared repository](https://github.com/babel/babel.git).
6. [npm-audit-report 8.0.0](https://www.npmjs.com/package/npm-audit-report) — Given a response from the npm security api, render it into a variety of security reports; source: [declared repository](https://github.com/npm/npm-audit-report.git).
7. [@google-cloud/resource-manager 7.2.0](https://www.npmjs.com/package/@google-cloud/resource-manager) — Cloud Resource Manager Client Library for Node.js; source: [declared repository](https://github.com/googleapis/google-cloud-node.git).
8. [better-npm-audit 3.11.0](https://www.npmjs.com/package/better-npm-audit) — Reshape into a better npm audit for the community and encourage more people to include security audit into their process.; source: [declared repository](https://github.com/jeemok/better-npm-audit.git).
9. [@opentelemetry/resource-detector-azure 0.32.0](https://www.npmjs.com/package/@opentelemetry/resource-detector-azure) — OpenTelemetry SDK resource detector for Azure; source: [declared repository](https://github.com/open-telemetry/opentelemetry-js-contrib.git).
10. [@medusajs/payment 2.22.1](https://www.npmjs.com/package/@medusajs/payment) — Medusa Payment module; source: [declared repository](https://github.com/medusajs/medusa.git).

<a id="lense-lense-dom-inspection"></a>

### DOM and Xray inspection, element ownership and evidence confidence

Sources: [lense/dom-provenance.mjs](../lense/dom-provenance.mjs), [lense/element-provenance.mjs](../lense/element-provenance.mjs), [lense/inspection-evidence.mjs](../lense/inspection-evidence.mjs), [lense/source-inspection.mjs](../lense/source-inspection.mjs), [lense/xray-ui.mjs](../lense/xray-ui.mjs).

GitHub: `dom source inspector in:name,description,readme` — page 1, up to 10 results.

1. [zh-lx/code-inspector](https://github.com/zh-lx/code-inspector)
2. [webfansplz/vite-plugin-vue-inspector](https://github.com/webfansplz/vite-plugin-vue-inspector)
3. [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
4. [lahmatiy/component-inspector](https://github.com/lahmatiy/component-inspector)
5. [philipwalton/html-inspector](https://github.com/philipwalton/html-inspector) — archived
6. [JetBrains/android](https://github.com/JetBrains/android)
7. [MCP-UI-Org/mcp-ui](https://github.com/MCP-UI-Org/mcp-ui)
8. [konvajs/konva](https://github.com/konvajs/konva)
9. [gavinkwoe/BeeFramework](https://github.com/gavinkwoe/BeeFramework)
10. [daltonmenezes/electron-app](https://github.com/daltonmenezes/electron-app)

npm: `dom inspector` — first registry result list, up to 10 packages.

1. [component-inspector 1.6.0](https://www.npmjs.com/package/component-inspector) — Component DOM inspector; source: [declared repository](https://github.com/lahmatiy/component-inspector.git).
2. [dom-inspector-mcp 0.1.52](https://www.npmjs.com/package/dom-inspector-mcp) — Universal DOM inspector plugin for React/Vue - inspect component sources and API calls in any bundler; source: no repository declared in search metadata.
3. [@devtools-ds/dom-inspector 1.2.1](https://www.npmjs.com/package/@devtools-ds/dom-inspector) — An emulation of the Chrome and Firefox DOM inspector, built on the &#96;@devtools-ds/tree&#96; component.; source: [declared repository](https://github.com/intuit/devtools-ds.git).
4. [dom-inspector-pro 1.0.3](https://www.npmjs.com/package/dom-inspector-pro) — dom-inspector-pro --------------------------------; source: no repository declared in search metadata.
5. [dom-inspector 1.2.5](https://www.npmjs.com/package/dom-inspector) — dom inspect like chrom dev tools.; source: [declared repository](https://github.com/luoye-fe/dom-inspector.git).
6. [creatr-devtools 0.1.38](https://www.npmjs.com/package/creatr-devtools) — Mini-Sentry + DOM Inspector toolkit for any React/Next app; source: [declared repository](https://github.com/creatr-ai/creatr-devtools.git).
7. [@iampava-devtools-ds/dom-inspector 1.2.5](https://www.npmjs.com/package/@iampava-devtools-ds/dom-inspector) — An emulation of the Chrome and Firefox DOM inspector, built on the &#96;@iampava-devtools-ds/tree&#96; component.; source: [declared repository](https://github.com/intuit/devtools-ds.git).
8. [editorjs-inspector 1.2.3](https://www.npmjs.com/package/editorjs-inspector) — DOM inspector feature for Editor.js; source: [declared repository](https://github.com/hata6502/editorjs-inspector.git).
9. [vite-plugin-vue-inspector 7.0.0](https://www.npmjs.com/package/vite-plugin-vue-inspector) — Jump to local IDE source code when clicking Vue elements in the browser.; source: [declared repository](https://github.com/webfansplz/vite-plugin-vue-inspector.git).
10. [devpilot-plugin-dom-inspector 0.0.22](https://www.npmjs.com/package/devpilot-plugin-dom-inspector) — Description.; source: [declared repository](https://github.com/zcf0508/unplugin-devpilot.git).

<a id="lense-lense-source-editing"></a>

### Structured source editing, sibling and record/language preservation, editor links

Sources: [lense/source-edit.mjs](../lense/source-edit.mjs), [lense/inspection-source-open.mjs](../lense/inspection-source-open.mjs), [lense/runtime-sources.mjs](../lense/runtime-sources.mjs).

GitHub: `yaml xml editing in:name,description,readme` — page 1, up to 10 results.

1. [BIT-DataLab/Edit-Banana](https://github.com/BIT-DataLab/Edit-Banana)
2. [kislyuk/yq](https://github.com/kislyuk/yq)
3. [AykutSarac/jsoncrack.com](https://github.com/AykutSarac/jsoncrack.com)
4. [dbohdan/structured-text-tools](https://github.com/dbohdan/structured-text-tools)
5. [EsotericSoftware/yamlbeans](https://github.com/EsotericSoftware/yamlbeans)
6. [dr5hn/countries-states-cities-database](https://github.com/dr5hn/countries-states-cities-database)
7. [helm-unittest/helm-unittest](https://github.com/helm-unittest/helm-unittest)
8. [babel/babel-sublime](https://github.com/babel/babel-sublime)
9. [yamldb/yaml_db](https://github.com/yamldb/yaml_db)
10. [humiaozuzu/dot-vimrc](https://github.com/humiaozuzu/dot-vimrc) — archived

Refinement: `"round trip" yaml in:readme language:JavaScript` — page 1, up to 10 results.

1. [koosoli/ESPHomeDesigner](https://github.com/koosoli/ESPHomeDesigner)
2. [bloomberg/goldpinger](https://github.com/bloomberg/goldpinger)
3. [pnpm/benchmarks](https://github.com/pnpm/benchmarks)
4. [silships/figma-cli](https://github.com/silships/figma-cli)
5. [seomihyeons/HA_smartblock](https://github.com/seomihyeons/HA_smartblock)
6. [visivo-io/visivo](https://github.com/visivo-io/visivo)
7. [slash9494/ai-config-sync-manager](https://github.com/slash9494/ai-config-sync-manager)
8. [dubzzz/fast-check-examples](https://github.com/dubzzz/fast-check-examples)
9. [bluzir/claude-code-design](https://github.com/bluzir/claude-code-design)
10. [chrisr2195/ubuntuyamlinstall](https://github.com/chrisr2195/ubuntuyamlinstall)

npm: `yaml edit` — first registry result list, up to 10 packages.

1. [yaml-edit 0.1.3](https://www.npmjs.com/package/yaml-edit) — Library for editing yaml files; source: [declared repository](https://github.com/mpuittinen/yaml-edit.git).
2. [js-yaml 5.5.0](https://www.npmjs.com/package/js-yaml) — YAML 1.2 parser and serializer; source: [declared repository](https://github.com/nodeca/js-yaml.git).
3. [yaml 2.9.1](https://www.npmjs.com/package/yaml) — JavaScript parser and stringifier for YAML; source: [declared repository](https://github.com/eemeli/yaml.git).
4. [@zkochan/js-yaml 0.0.11](https://www.npmjs.com/package/@zkochan/js-yaml) — YAML 1.2 parser and serializer; source: [declared repository](https://github.com/nodeca/js-yaml.git).
5. [yaml-language-server 2.0.0](https://www.npmjs.com/package/yaml-language-server) — YAML language server; source: [declared repository](https://github.com/redhat-developer/yaml-language-server.git).
6. [read-yaml-file 3.0.0](https://www.npmjs.com/package/read-yaml-file) — Read and parse a YAML file; source: [declared repository](https://github.com/zkochan/packages/tree/main/read-yaml-file).
7. [@stoplight/yaml 4.3.0](https://www.npmjs.com/package/@stoplight/yaml) — Useful functions when working with YAML.; source: [declared repository](https://github.com/stoplightio/yaml.git).
8. [yaml-eslint-parser 2.1.0](https://www.npmjs.com/package/yaml-eslint-parser) — A YAML parser that produces output compatible with ESLint; source: [declared repository](https://github.com/ota-meshi/yaml-eslint-parser.git).
9. [front-matter 4.0.2](https://www.npmjs.com/package/front-matter) — Extract YAML front matter from a string; source: a repository is declared in registry metadata.
10. [@stoplight/yaml-ast-parser 0.0.50](https://www.npmjs.com/package/@stoplight/yaml-ast-parser) — &#91;&#33;&#91;Build Status&#93;(https://travis-ci.org/mulesoft-labs/yaml-ast-parser.svg?branch=master)&#93;(https://travis-ci.org/mulesoft-labs/yaml-ast-parser); source: [declared repository](https://github.com/stoplightio/yaml-ast-parser.git).

npm refinement: `yaml-edit` — first result list, up to 10 packages.

1. [yaml-edit 0.1.3](https://www.npmjs.com/package/yaml-edit) — Library for editing yaml files; source: [declared repository](https://github.com/mpuittinen/yaml-edit.git).
2. [js-yaml 5.5.0](https://www.npmjs.com/package/js-yaml) — YAML 1.2 parser and serializer; source: [declared repository](https://github.com/nodeca/js-yaml.git).
3. [yaml 2.9.1](https://www.npmjs.com/package/yaml) — JavaScript parser and stringifier for YAML; source: [declared repository](https://github.com/eemeli/yaml.git).
4. [@zkochan/js-yaml 0.0.11](https://www.npmjs.com/package/@zkochan/js-yaml) — YAML 1.2 parser and serializer; source: [declared repository](https://github.com/nodeca/js-yaml.git).
5. [@types/js-yaml 4.0.9](https://www.npmjs.com/package/@types/js-yaml) — TypeScript definitions for js-yaml; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
6. [yaml-language-server 2.0.0](https://www.npmjs.com/package/yaml-language-server) — YAML language server; source: [declared repository](https://github.com/redhat-developer/yaml-language-server.git).
7. [@codemirror/lang-yaml 6.1.3](https://www.npmjs.com/package/@codemirror/lang-yaml) — YAML language support for the CodeMirror code editor; source: [declared repository](https://github.com/codemirror/lang-yaml.git).
8. [string-env-interpolation 1.0.1](https://www.npmjs.com/package/string-env-interpolation) — Use Environment Variables in String; source: [declared repository](https://github.com/kamilkisiela/string-env-interpolation.git).
9. [read-yaml-file 3.0.0](https://www.npmjs.com/package/read-yaml-file) — Read and parse a YAML file; source: [declared repository](https://github.com/zkochan/packages/tree/main/read-yaml-file).
10. [@stoplight/yaml 4.3.0](https://www.npmjs.com/package/@stoplight/yaml) — Useful functions when working with YAML.; source: [declared repository](https://github.com/stoplightio/yaml.git).

<a id="lense-lense-source-debugging"></a>

### JavaScript source maps, console locations and applied-script evidence

Sources: [lense/source-map.mjs](../lense/source-map.mjs), [lense/script-source-evidence.mjs](../lense/script-source-evidence.mjs), [lense/console-location.mjs](../lense/console-location.mjs).

GitHub: `javascript source maps in:name,description,readme` — page 1, up to 10 results.

1. [airbnb/javascript](https://github.com/airbnb/javascript)
2. [flutter-mapbox-gl/maps](https://github.com/flutter-mapbox-gl/maps)
3. [Leaflet/Leaflet](https://github.com/Leaflet/Leaflet)
4. [mozilla/source-map](https://github.com/mozilla/source-map)
5. [CesiumGS/cesium](https://github.com/CesiumGS/cesium)
6. [leereilly/games](https://github.com/leereilly/games) — archived
7. [rarecoil/unwebpack-sourcemap](https://github.com/rarecoil/unwebpack-sourcemap) — archived
8. [angular-ui/angular-google-maps](https://github.com/angular-ui/angular-google-maps) — archived
9. [serhii-londar/open-source-mac-os-apps](https://github.com/serhii-londar/open-source-mac-os-apps)
10. [twbs/bootstrap](https://github.com/twbs/bootstrap)

Refinement: `"source-map" in:name language:JavaScript` — page 1, up to 10 results.

1. [mozilla/source-map](https://github.com/mozilla/source-map)
2. [ryanseddon/source-map](https://github.com/ryanseddon/source-map)
3. [parcel-bundler/source-map](https://github.com/parcel-bundler/source-map)
4. [evanw/node-source-map-support](https://github.com/evanw/node-source-map-support)
5. [sokra/source-map-visualization](https://github.com/sokra/source-map-visualization)
6. [webpack-contrib/source-map-loader](https://github.com/webpack-contrib/source-map-loader) — archived
7. [evanw/source-map-visualization](https://github.com/evanw/source-map-visualization)
8. [thlorenz/convert-source-map](https://github.com/thlorenz/convert-source-map)
9. [pavloko/source-map-unpack](https://github.com/pavloko/source-map-unpack)
10. [lydell/source-map-resolve](https://github.com/lydell/source-map-resolve) — archived

npm: `source map` — first registry result list, up to 10 packages.

1. [convert-source-map 2.0.0](https://www.npmjs.com/package/convert-source-map) — Converts a source-map from/to different formats and allows adding/changing properties.; source: a repository is declared in registry metadata.
2. [metro-source-map 0.87.2](https://www.npmjs.com/package/metro-source-map) — 🚇 Source map generator for Metro.; source: [declared repository](https://github.com/react/metro.git).
3. [merge-source-map 1.1.0](https://www.npmjs.com/package/merge-source-map) — Merge old source map and new source map in multi-transform flow; source: [declared repository](https://github.com/keik/merge-source-map.git).
4. [source-map-loader 5.0.0](https://www.npmjs.com/package/source-map-loader) — extracts inlined source map and offers it to webpack; source: [declared repository](https://github.com/webpack-contrib/source-map-loader.git).
5. [@jridgewell/source-map 0.3.11](https://www.npmjs.com/package/@jridgewell/source-map) — Packages @jridgewell/trace-mapping and @jridgewell/gen-mapping into the familiar source-map API; source: [declared repository](https://github.com/jridgewell/sourcemaps.git).
6. [@types/source-map-support 0.5.10](https://www.npmjs.com/package/@types/source-map-support) — TypeScript definitions for source-map-support; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
7. [@jridgewell/trace-mapping 0.3.31](https://www.npmjs.com/package/@jridgewell/trace-mapping) — Trace the original position through a source map; source: [declared repository](https://github.com/jridgewell/sourcemaps.git).
8. [inline-source-map-comment 1.0.5](https://www.npmjs.com/package/inline-source-map-comment) — Create an inline source map comment from a source map; source: [declared repository](https://github.com/shinnn/inline-source-map-comment).
9. [@types/convert-source-map 2.0.3](https://www.npmjs.com/package/@types/convert-source-map) — TypeScript definitions for convert-source-map; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
10. [json-source-map 0.6.1](https://www.npmjs.com/package/json-source-map) — Parse/stringify JSON and provide source-map for JSON-pointers to all nodes; source: [declared repository](https://github.com/epoberezkin/json-source-map.git).

<a id="lense-lense-agent-api"></a>

### Bounded browser agent HTTP API, event cursors, snapshots, screenshots and navigation

Sources: [lense/agent-server.mjs](../lense/agent-server.mjs), [lense/commands/agent.mjs](../lense/commands/agent.mjs).

GitHub: `playwright browser agent in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/playwright](https://github.com/microsoft/playwright)
2. [lightpanda-io/browser](https://github.com/lightpanda-io/browser)
3. [browser-use/browser-harness](https://github.com/browser-use/browser-harness)
4. [Skyvern-AI/skyvern](https://github.com/Skyvern-AI/skyvern)
5. [browser-use/web-ui](https://github.com/browser-use/web-ui)
6. [CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser)
7. [browseros-ai/BrowserOS](https://github.com/browseros-ai/BrowserOS)
8. [h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)
9. [MetaMask/metamask-extension](https://github.com/MetaMask/metamask-extension)
10. [microsoft/playwright-mcp](https://github.com/microsoft/playwright-mcp)

npm: `playwright agent` — first registry result list, up to 10 packages.

1. [wico-playwright-agent-skills 2.5.0](https://www.npmjs.com/package/wico-playwright-agent-skills) — wico — Playwright Agent Skills for AI-assisted E2E testing; source: [declared repository](https://github.com/willcoliveira/qualiow-playwright-skills.git).
2. [planwright-e2e 0.1.0](https://www.npmjs.com/package/planwright-e2e) — Gherkin → Playwright agent that plans once with an LLM, replays deterministically, and re-plans only the steps that drift.; source: [declared repository](https://github.com/YoavAlro/planwright.git).
3. [@reportportal/agent-js-playwright 5.5.0](https://www.npmjs.com/package/@reportportal/agent-js-playwright) — Agent to integrate Playwright with ReportPortal.; source: [declared repository](https://github.com/reportportal/agent-js-playwright.git).
4. [playwright-bdd 9.2.1](https://www.npmjs.com/package/playwright-bdd) — BDD Testing with Playwright runner; source: [declared repository](https://github.com/vitalets/playwright-bdd.git).
5. [playwright-core 1.64.1](https://www.npmjs.com/package/playwright-core) — A high-level API to automate web browsers; source: [declared repository](https://github.com/microsoft/playwright.git).
6. [@playwright/mcp 0.0.83](https://www.npmjs.com/package/@playwright/mcp) — Playwright Tools for MCP; source: [declared repository](https://github.com/microsoft/playwright-mcp.git).
7. [@playwright/cli 0.1.22](https://www.npmjs.com/package/@playwright/cli) — Playwright CLI; source: [declared repository](https://github.com/microsoft/playwright-cli.git).
8. [playwright 1.64.1](https://www.npmjs.com/package/playwright) — A high-level API to automate web browsers; source: [declared repository](https://github.com/microsoft/playwright.git).
9. [@axe-core/playwright 4.14.0](https://www.npmjs.com/package/@axe-core/playwright) — Provides a method to inject and analyze web pages using axe; source: [declared repository](https://github.com/dequelabs/axe-core-npm.git).
10. [@playwright/test 1.64.1](https://www.npmjs.com/package/@playwright/test) — A high-level API to automate web browsers; source: [declared repository](https://github.com/microsoft/playwright.git).

<a id="lense-lense-panel-workflows"></a>

### Inspect and Tweaks panel, scenarios and identity workflows

Sources: [lense/panel.mjs](../lense/panel.mjs), [lense/panel-ui.mjs](../lense/panel-ui.mjs), [lense/portal-element-provider.mjs](../lense/portal-element-provider.mjs), [lense/dev-dialogs.mjs](../lense/dev-dialogs.mjs).

GitHub: `powerpages developer extension in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/powerplatform-vscode](https://github.com/microsoft/powerplatform-vscode)
2. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
3. [maksii/paqvilo](https://github.com/maksii/paqvilo) — this repository; excluded as a candidate
4. [WizspDemo/dataverse-mcp3](https://github.com/WizspDemo/dataverse-mcp3)
5. [WizspDemo/dataverse-mcp2](https://github.com/WizspDemo/dataverse-mcp2)
6. [Cloudstrucc/PowerPages-Template-Engine](https://github.com/Cloudstrucc/PowerPages-Template-Engine)
7. [KarolFilipKozlowski/PowerPlatformEnvironmentColoredBanner](https://github.com/KarolFilipKozlowski/PowerPlatformEnvironmentColoredBanner)
8. [linxinyu-ext/dataverse-mcp](https://github.com/linxinyu-ext/dataverse-mcp)
9. [danfiedler-msft/powerplatform-vscode](https://github.com/danfiedler-msft/powerplatform-vscode)
10. [blub007/dataverse-mcp](https://github.com/blub007/dataverse-mcp)

npm: `powerapps developer tools` — first registry result list, up to 10 packages.

1. [pcf-start 1.51.1](https://www.npmjs.com/package/pcf-start) — This package contains a module for locally hosting PowerApps Component Framework (PCF) controls. See project homepage how to install.; source: no repository declared in search metadata.
2. [@types/powerapps-component-framework 1.3.18](https://www.npmjs.com/package/@types/powerapps-component-framework) — TypeScript definitions for powerapps-component-framework; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
3. [pcf-scripts 1.51.1](https://www.npmjs.com/package/pcf-scripts) — This package contains a module for building PowerApps Component Framework (PCF) controls. See project homepage how to install.; source: no repository declared in search metadata.
4. [postcss 8.5.32](https://www.npmjs.com/package/postcss) — Tool for transforming styles with JS plugins; source: [declared repository](https://github.com/postcss/postcss.git).
5. [@microsoft/eslint-plugin-power-apps 0.6.0](https://www.npmjs.com/package/@microsoft/eslint-plugin-power-apps) — Power Apps checker ESLint plug-in containing the rules for Microsoft Power Apps; source: no repository declared in search metadata.
6. [node-gyp 13.1.0](https://www.npmjs.com/package/node-gyp) — Node.js native addon build tool; source: a repository is declared in registry metadata.
7. [@coinbase/cdp-sdk 1.60.0](https://www.npmjs.com/package/@coinbase/cdp-sdk) — SDK for interacting with the Coinbase Developer Platform Wallet API; source: [declared repository](https://github.com/coinbase/cdp-sdk.git).
8. [expo-dev-client 58.0.16](https://www.npmjs.com/package/expo-dev-client) — Expo Development Client; source: [declared repository](https://github.com/expo/expo.git).
9. [hermes-profile-transformer 0.0.9](https://www.npmjs.com/package/hermes-profile-transformer) — The Hermes runtime, used by React Native for Android, is able to output &#91;Chrome Trace Events&#93;(https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview) in JSON Object Format.; source: [declared repository](https://github.com/react-native-community/hermes-profile-transformer).
10. [@microsoft/power-apps-vite 1.0.13](https://www.npmjs.com/package/@microsoft/power-apps-vite) — Vite plugin for Power Apps; source: no repository declared in search metadata.

<a id="lense-lense-model-driven-overlay"></a>

### Model-driven WebResource overlays and Solution source mapping

Sources: [lense/model-driven.mjs](../lense/model-driven.mjs), [lense/model-driven-targets.mjs](../lense/model-driven-targets.mjs), [lense/model-driven-metadata.mjs](../lense/model-driven-metadata.mjs), [lense/model-driven-inspection.mjs](../lense/model-driven-inspection.mjs).

GitHub: `dynamics webresource development in:name,description,readme` — page 1, up to 10 results.

1. [kip-dk/angular-xrm-webresource](https://github.com/kip-dk/angular-xrm-webresource)
2. [phuocle/Dynamics-Crm-DevKit](https://github.com/phuocle/Dynamics-Crm-DevKit)
3. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)
4. [context-and-oss/XrmBedrock](https://github.com/context-and-oss/XrmBedrock)
5. [delegateas/XrmFramework](https://github.com/delegateas/XrmFramework)
6. [davidyack/gulp-webresource](https://github.com/davidyack/gulp-webresource)
7. [hso-nn/crm-sdk](https://github.com/hso-nn/crm-sdk)
8. [Dimsi-BS/XrmFramework](https://github.com/Dimsi-BS/XrmFramework)
9. [XrmServiceToolkit/XrmServiceToolkit](https://github.com/XrmServiceToolkit/XrmServiceToolkit) — archived
10. [pederwagner/XrmSdkWebAPI](https://github.com/pederwagner/XrmSdkWebAPI)

npm: `dataverse webresource` — first registry result list, up to 10 packages.

1. [@_neronotte/cra-template-dataverse-webresource 1.0.15](https://www.npmjs.com/package/@_neronotte/cra-template-dataverse-webresource) — A template to create Dataverse Web Resource projects with Create-React-App; source: no repository declared in search metadata.
2. [@delegateas/create-dataverse-webresource 1.0.12](https://www.npmjs.com/package/@delegateas/create-dataverse-webresource) — Scaffold a single-file HTML Dataverse web resource, deployed with XrmSync; source: [declared repository](https://github.com/delegateas/DataverseHtml.git).
3. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
4. [dataverse-utils 5.2.1](https://www.npmjs.com/package/dataverse-utils) — Utilities for interacting with Dataverse environments; source: [declared repository](https://github.com/derekfinlinson/powerapps-tools.git).
5. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
6. [@_neronotte/cra-template-dataverse-webresource-form 1.0.4](https://www.npmjs.com/package/@_neronotte/cra-template-dataverse-webresource-form) — A Create-React-App template to create Dataverse Web Resources that can be embedded within Model Driven App forms.; source: no repository declared in search metadata.
7. [@balena/pinejs-webresource-s3 2.2.0](https://www.npmjs.com/package/@balena/pinejs-webresource-s3) — A PineJS WebResource handler for storing &#38; serving files on S3; source: [declared repository](https://github.com/balena-io-modules/pinejs-webresource-s3.git).
8. [@balena/pinejs-webresource-cloudfront 2.0.33](https://www.npmjs.com/package/@balena/pinejs-webresource-cloudfront) — A PineJS WebResource handler for storing files on S3 and serving via AWS Cloudfront; source: [declared repository](https://github.com/balena-io-modules/pinejs-webresource-cloudfront.git).
9. [@tekstack/client-data-model 1.0.101](https://www.npmjs.com/package/@tekstack/client-data-model) — TekStack client-side Dataverse data model for TypeScript projects.; source: no repository declared in search metadata.
10. [create-ec-app 1.16.3](https://www.npmjs.com/package/create-ec-app) — Unified CLI tool to create different types of EC applications: Webresource, Portal, Power Pages, Power Apps Code Apps; source: [declared repository](https://github.com/Enterprisecloud-Pty-Ltd/create-ec-app.git).

<a id="lense-lense-model-driven-actions"></a>

### Model-driven contextual actions, draft tools, diagnostics, impersonation and custom commands

Sources: [lense/model-driven-action-runner.mjs](../lense/model-driven-action-runner.mjs), [lense/model-driven-actions.mjs](../lense/model-driven-actions.mjs), [lense/model-driven-identity.mjs](../lense/model-driven-identity.mjs), [lense/model-driven-commands.mjs](../lense/model-driven-commands.mjs).

GitHub: `dynamics devtools in:name,description,readme` — page 1, up to 10 results.

1. [TrudAX/XppTools](https://github.com/TrudAX/XppTools)
2. [Coolgenome/iTALK](https://github.com/Coolgenome/iTALK)
3. [Yuan-ManX/ai-game-devtools](https://github.com/Yuan-ManX/ai-game-devtools)
4. [dosorio/Peptides](https://github.com/dosorio/Peptides)
5. [BDI-pathogens/OpenABM-Covid19](https://github.com/BDI-pathogens/OpenABM-Covid19)
6. [wuba/Fair](https://github.com/wuba/Fair)
7. [functionaldata/tPACE](https://github.com/functionaldata/tPACE)
8. [Vivianstats/scImpute](https://github.com/Vivianstats/scImpute)
9. [PredictiveEcology/LandR](https://github.com/PredictiveEcology/LandR)
10. [James-Thorson-NOAA/VAST](https://github.com/James-Thorson-NOAA/VAST)

Refinement: `"Dynamics 365" devtools in:readme` — page 1, up to 10 results.

1. [TrudAX/XppTools](https://github.com/TrudAX/XppTools)
2. [Power-Maverick/DataverseDevTools-VSCode](https://github.com/Power-Maverick/DataverseDevTools-VSCode)
3. [Power-Maverick/PowerPlatform-VSCode-ExtensionPack](https://github.com/Power-Maverick/PowerPlatform-VSCode-ExtensionPack)
4. [glincker/thesvg](https://github.com/glincker/thesvg)
5. [osvaldokalvaitir/awesome](https://github.com/osvaldokalvaitir/awesome)
6. [nickmeron/Dataverse-Web-Devtools](https://github.com/nickmeron/Dataverse-Web-Devtools)
7. [abordage/awesome-mcp](https://github.com/abordage/awesome-mcp)
8. [microsoft/agent365-skills](https://github.com/microsoft/agent365-skills)
9. [ALCops/azure-devops-extension](https://github.com/ALCops/azure-devops-extension)
10. [PVHewson/snips](https://github.com/PVHewson/snips)

npm: `xrm developer tools` — first registry result list, up to 10 packages.

1. [@types/xrm 9.0.97](https://www.npmjs.com/package/@types/xrm) — TypeScript definitions for xrm; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
2. [xrm-mock 3.6.2](https://www.npmjs.com/package/xrm-mock) — A fake implementation of the Xrm object model. Used for testing Dynamics 365 client-side scripts.; source: [declared repository](https://github.com/camelCaseDave/xrm-mock.git).
3. [postcss 8.5.32](https://www.npmjs.com/package/postcss) — Tool for transforming styles with JS plugins; source: [declared repository](https://github.com/postcss/postcss.git).
4. [node-gyp 13.1.0](https://www.npmjs.com/package/node-gyp) — Node.js native addon build tool; source: a repository is declared in registry metadata.
5. [@coinbase/cdp-sdk 1.60.0](https://www.npmjs.com/package/@coinbase/cdp-sdk) — SDK for interacting with the Coinbase Developer Platform Wallet API; source: [declared repository](https://github.com/coinbase/cdp-sdk.git).
6. [expo-dev-client 58.0.16](https://www.npmjs.com/package/expo-dev-client) — Expo Development Client; source: [declared repository](https://github.com/expo/expo.git).
7. [hermes-profile-transformer 0.0.9](https://www.npmjs.com/package/hermes-profile-transformer) — The Hermes runtime, used by React Native for Android, is able to output &#91;Chrome Trace Events&#93;(https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU/preview) in JSON Object Format.; source: [declared repository](https://github.com/react-native-community/hermes-profile-transformer).
8. [postcss-safe-parser 7.1.0](https://www.npmjs.com/package/postcss-safe-parser) — Fault-tolerant CSS parser for PostCSS; source: [declared repository](https://github.com/postcss/postcss-safe-parser.git).
9. [browserslist 4.29.5](https://www.npmjs.com/package/browserslist) — Share target browsers between different front-end tools, like Autoprefixer, Stylelint and babel-env-preset; source: [declared repository](https://github.com/browserslist/browserslist.git).
10. [@sitecore-jss/sitecore-jss-dev-tools 23.0.0](https://www.npmjs.com/package/@sitecore-jss/sitecore-jss-dev-tools) — Utilities to assist in the development and deployment of Sitecore JSS apps.; source: no repository declared in search metadata.

<a id="lense-lense-model-driven-evidence"></a>

### Model-driven native observation, inspector evidence and comparison

Sources: [lense/model-driven-observation.mjs](../lense/model-driven-observation.mjs), [lense/model-driven-native-comparison.mjs](../lense/model-driven-native-comparison.mjs), [lense/model-driven-inspector.mjs](../lense/model-driven-inspector.mjs).

GitHub: `model driven testing in:name,description,readme` — page 1, up to 10 results.

1. [hanami/model](https://github.com/hanami/model) — archived
2. [curran/model](https://github.com/curran/model)
3. [Sairyss/domain-driven-hexagon](https://github.com/Sairyss/domain-driven-hexagon)
4. [microsoft/playwright](https://github.com/microsoft/playwright)
5. [kgrzybek/modular-monolith-with-ddd](https://github.com/kgrzybek/modular-monolith-with-ddd)
6. [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
7. [heynickc/awesome-ddd](https://github.com/heynickc/awesome-ddd)
8. [multica-ai/andrej-karpathy-skills](https://github.com/multica-ai/andrej-karpathy-skills)
9. [ddd-crew/ddd-starter-modelling-process](https://github.com/ddd-crew/ddd-starter-modelling-process)
10. [brooklynDev/airborne](https://github.com/brooklynDev/airborne)

Refinement: `"model-driven" testing in:name,description,readme` — page 1, up to 10 results.

1. [teaql/teaql-agent-kit](https://github.com/teaql/teaql-agent-kit)
2. [CiscoDevNet/ydk-gen](https://github.com/CiscoDevNet/ydk-gen)
3. [TheJambo/awesome-testing](https://github.com/TheJambo/awesome-testing)
4. [ARM-DOE/pyart](https://github.com/ARM-DOE/pyart)
5. [model-driven-devops/mdd](https://github.com/model-driven-devops/mdd)
6. [strands-agents/sdk-typescript](https://github.com/strands-agents/sdk-typescript) — archived
7. [rapiddweller/rapiddweller-benerator-ce](https://github.com/rapiddweller/rapiddweller-benerator-ce)
8. [nocobase/nocobase](https://github.com/nocobase/nocobase)
9. [ollama/ollama](https://github.com/ollama/ollama)
10. [strands-agents/harness-sdk](https://github.com/strands-agents/harness-sdk)

Refinement: `"Dynamics 365" "testing" in:name,description` — page 1, up to 10 results.

1. [microsoft/EasyRepro](https://github.com/microsoft/EasyRepro) — archived
2. [PacktPublishing/Automated-Testing-in-Microsoft-Dynamics-365-Business-Central](https://github.com/PacktPublishing/Automated-Testing-in-Microsoft-Dynamics-365-Business-Central)
3. [AshV/Dynamics365ConsoleCaller](https://github.com/AshV/Dynamics365ConsoleCaller)
4. [PacktPublishing/Automated-Testing-in-Microsoft-Dynamics-365-Business-Central-Second-Edition](https://github.com/PacktPublishing/Automated-Testing-in-Microsoft-Dynamics-365-Business-Central-Second-Edition)
5. [fedejousset/Dynamics365WebApiPostmanCollection](https://github.com/fedejousset/Dynamics365WebApiPostmanCollection)
6. [jordimontana82/fake-xrm-easy](https://github.com/jordimontana82/fake-xrm-easy) — archived
7. [XRM-OSS/D365-UI-Test](https://github.com/XRM-OSS/D365-UI-Test)
8. [fluxxus-nl/Test-Automation-Examples](https://github.com/fluxxus-nl/Test-Automation-Examples)
9. [davidjbclark/xrm-mock-generator](https://github.com/davidjbclark/xrm-mock-generator) — archived
10. [mVermaat/Crm.Specflow](https://github.com/mVermaat/Crm.Specflow)

npm: `xrm testing` — first registry result list, up to 10 packages.

1. [xrm-mock 3.6.2](https://www.npmjs.com/package/xrm-mock) — A fake implementation of the Xrm object model. Used for testing Dynamics 365 client-side scripts.; source: [declared repository](https://github.com/camelCaseDave/xrm-mock.git).
2. [@types/xrm 9.0.97](https://www.npmjs.com/package/@types/xrm) — TypeScript definitions for xrm; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
3. [@testing-library/dom 10.4.2](https://www.npmjs.com/package/@testing-library/dom) — Simple and complete DOM testing utilities that encourage good testing practices.; source: [declared repository](https://github.com/testing-library/dom-testing-library.git).
4. [@testing-library/react 16.3.3](https://www.npmjs.com/package/@testing-library/react) — Simple and complete React DOM testing utilities that encourage good testing practices.; source: [declared repository](https://github.com/testing-library/react-testing-library.git).
5. [@testing-library/jest-dom 7.0.1](https://www.npmjs.com/package/@testing-library/jest-dom) — Custom jest matchers to test the state of the DOM; source: [declared repository](https://github.com/testing-library/jest-dom.git).
6. [@testing-library/user-event 14.6.8](https://www.npmjs.com/package/@testing-library/user-event) — Fire events the same way the user does; source: [declared repository](https://github.com/testing-library/user-event.git).
7. [jest-cli 30.5.2](https://www.npmjs.com/package/jest-cli) — Delightful JavaScript Testing.; source: [declared repository](https://github.com/jestjs/jest.git).
8. [jest 30.5.2](https://www.npmjs.com/package/jest) — Delightful JavaScript Testing.; source: [declared repository](https://github.com/jestjs/jest.git).
9. [eslint-plugin-testing-library 7.16.2](https://www.npmjs.com/package/eslint-plugin-testing-library) — ESLint plugin to follow best practices and anticipate common mistakes when writing tests with Testing Library; source: [declared repository](https://github.com/testing-library/eslint-plugin-testing-library.git).
10. [react-test-renderer 19.3.1](https://www.npmjs.com/package/react-test-renderer) — React package for snapshot testing.; source: [declared repository](https://github.com/react/react.git).

<a id="lense-lense-code-app-orchestration"></a>

### Code Apps dev-server subprocess orchestration and app-target coordination

Sources: [lense/code-app-dev-servers.mjs](../lense/code-app-dev-servers.mjs), [lense/code-app-dev-wrapper.mjs](../lense/code-app-dev-wrapper.mjs), [lense/code-app-dev-stop.mjs](../lense/code-app-dev-stop.mjs), [lense/commands/mirage.mjs](../lense/commands/mirage.mjs).

GitHub: `powerapps code apps in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/PowerApps-Samples](https://github.com/microsoft/PowerApps-Samples)
2. [e-gallis/PowerApps](https://github.com/e-gallis/PowerApps)
3. [microsoft/Dynamics365-Apps-Samples](https://github.com/microsoft/Dynamics365-Apps-Samples)
4. [microsoft/PowerAppsCodeApps](https://github.com/microsoft/PowerAppsCodeApps)
5. [microsoft/PowerApps-Tooling](https://github.com/microsoft/PowerApps-Tooling)
6. [MicrosoftDocs/powerapps-docs](https://github.com/MicrosoftDocs/powerapps-docs)
7. [modery/PowerDocu](https://github.com/modery/PowerDocu)
8. [pnp/powerapps-samples](https://github.com/pnp/powerapps-samples) — archived
9. [zenitysec/awesome-low-code](https://github.com/zenitysec/awesome-low-code)
10. [MscrmTools/XrmToolBox](https://github.com/MscrmTools/XrmToolBox)

npm: `powerapps vite` — first registry result list, up to 10 packages.

1. [pcf-start 1.51.1](https://www.npmjs.com/package/pcf-start) — This package contains a module for locally hosting PowerApps Component Framework (PCF) controls. See project homepage how to install.; source: no repository declared in search metadata.
2. [@microsoft/power-apps-vite 1.0.13](https://www.npmjs.com/package/@microsoft/power-apps-vite) — Vite plugin for Power Apps; source: no repository declared in search metadata.
3. [@types/powerapps-component-framework 1.3.18](https://www.npmjs.com/package/@types/powerapps-component-framework) — TypeScript definitions for powerapps-component-framework; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
4. [vite 8.3.5](https://www.npmjs.com/package/vite) — Native-ESM powered web dev build tool; source: [declared repository](https://github.com/vitejs/vite.git).
5. [@microsoft/eslint-plugin-power-apps 0.6.0](https://www.npmjs.com/package/@microsoft/eslint-plugin-power-apps) — Power Apps checker ESLint plug-in containing the rules for Microsoft Power Apps; source: no repository declared in search metadata.
6. [@storybook/builder-vite 10.6.5](https://www.npmjs.com/package/@storybook/builder-vite) — A Storybook builder to dev and build with Vite; source: [declared repository](https://github.com/storybookjs/storybook.git).
7. [lovable-tagger 1.3.5](https://www.npmjs.com/package/lovable-tagger) — Vite plugins for component tagging and Tailwind config extraction; source: [declared repository](https://github.com/lovablelabs/lovable.git).
8. [vite-tsconfig-paths 6.1.1](https://www.npmjs.com/package/vite-tsconfig-paths) — Vite resolver for TypeScript compilerOptions.paths; source: [declared repository](https://github.com/aleclarson/vite-tsconfig-paths.git).
9. [@storybook/react-vite 10.6.5](https://www.npmjs.com/package/@storybook/react-vite) — Storybook for React and Vite: Develop, document, and test UI components in isolation; source: [declared repository](https://github.com/storybookjs/storybook.git).
10. [vite-plugin-svgr 5.2.0](https://www.npmjs.com/package/vite-plugin-svgr) — Vite plugin to transform SVGs into React components; source: [declared repository](https://github.com/pd4d10/vite-plugin-svgr.git).

<a id="lense-lense-dataverse-auth"></a>

### Dataverse app registration, authentication, credential recovery and DPAPI state

Sources: [lense/dataverse/connection.mjs](../lense/dataverse/connection.mjs), [lense/dataverse/protected-state.mjs](../lense/dataverse/protected-state.mjs).

GitHub: `dataverse authentication node in:name,description,readme` — page 1, up to 10 results.

1. [IQSS/dataverse-frontend](https://github.com/IQSS/dataverse-frontend)
2. [gdcc/dataverse-ansible](https://github.com/gdcc/dataverse-ansible)
3. [primno/dataverse](https://github.com/primno/dataverse)
4. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
5. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
6. [context-and-oss/XrmBedrock](https://github.com/context-and-oss/XrmBedrock)
7. [scottdurow/dataverse-auth](https://github.com/scottdurow/dataverse-auth)
8. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)
9. [bcgov/jag-lcrb-carla-public](https://github.com/bcgov/jag-lcrb-carla-public)
10. [Azure/dataverse-to-sql](https://github.com/Azure/dataverse-to-sql) — archived

npm: `dataverse authentication` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
3. [@octokit/auth-app 8.3.1](https://www.npmjs.com/package/@octokit/auth-app) — GitHub App authentication for JavaScript; source: [declared repository](https://github.com/octokit/auth-app.js.git).
4. [dataverse-gen 1.0.16](https://www.npmjs.com/package/dataverse-gen) — Earlybound types generator for dataverse-ify; source: no repository declared in search metadata.
5. [@octokit/auth-token 6.0.0](https://www.npmjs.com/package/@octokit/auth-token) — GitHub API token authentication for browsers and Node.js; source: [declared repository](https://github.com/octokit/auth-token.js.git).
6. [@octokit/auth-oauth-app 9.0.5](https://www.npmjs.com/package/@octokit/auth-oauth-app) — GitHub OAuth App authentication for JavaScript; source: [declared repository](https://github.com/octokit/auth-oauth-app.js.git).
7. [@tekstack/client-data-model 1.0.101](https://www.npmjs.com/package/@tekstack/client-data-model) — TekStack client-side Dataverse data model for TypeScript projects.; source: no repository declared in search metadata.
8. [@azure/core-auth 1.11.0](https://www.npmjs.com/package/@azure/core-auth) — Provides low-level interfaces and helper methods for authentication in Azure SDK; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
9. [@theatre/dataverse 0.7.2](https://www.npmjs.com/package/@theatre/dataverse) — No description; source: [declared repository](https://github.com/AriaMinaei/theatre).
10. [@azure/identity 4.14.0](https://www.npmjs.com/package/@azure/identity) — Provides credential implementations for Azure SDK libraries that can authenticate with Microsoft Entra ID; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).

<a id="lense-lense-dataverse-client"></a>

### Reusable Dataverse HTTP client, continuations, bounded requests and unknown write outcomes

Sources: [lense/dataverse/client.mjs](../lense/dataverse/client.mjs), [lense/dataverse/index.mjs](../lense/dataverse/index.mjs).

GitHub: `dataverse javascript client in:name,description,readme` — page 1, up to 10 results.

1. [IQSS/dataverse-client-javascript](https://github.com/IQSS/dataverse-client-javascript)
2. [phuocle/Dynamics-Crm-DevKit](https://github.com/phuocle/Dynamics-Crm-DevKit)
3. [microsoft/power-pages-samples](https://github.com/microsoft/power-pages-samples)
4. [context-and-oss/XrmBedrock](https://github.com/context-and-oss/XrmBedrock)
5. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
6. [rwilson504/PCFControls](https://github.com/rwilson504/PCFControls)
7. [gdcc/dataverse-recipes](https://github.com/gdcc/dataverse-recipes)
8. [sshuair/awesome-gis](https://github.com/sshuair/awesome-gis)
9. [happyrabbit/Awesome-Data-Science-Materials](https://github.com/happyrabbit/Awesome-Data-Science-Materials)
10. [TALXIS/tools-devkit-templates](https://github.com/TALXIS/tools-devkit-templates)

Refinement: `"Dataverse" "WebAPI" client in:name,description,readme` — page 1, up to 10 results.

1. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
2. [phuocle/Dynamics-Crm-DevKit](https://github.com/phuocle/Dynamics-Crm-DevKit)
3. [rajyraman/Dataverse-LINQPad-Driver](https://github.com/rajyraman/Dataverse-LINQPad-Driver)
4. [primno/dataverse](https://github.com/primno/dataverse)
5. [rwilson504/PCFControls](https://github.com/rwilson504/PCFControls)
6. [AshV/FetchXmlTester](https://github.com/AshV/FetchXmlTester)
7. [allandecastro/dataverse-erd-visualizer](https://github.com/allandecastro/dataverse-erd-visualizer)
8. [junterpfe/Dataverse-HTML-Tools](https://github.com/junterpfe/Dataverse-HTML-Tools)
9. [jaduplesms/PCF-Workbench](https://github.com/jaduplesms/PCF-Workbench)
10. [mohsinonxrm/pptb-mxrm-fetchxml-studio](https://github.com/mohsinonxrm/pptb-mxrm-fetchxml-studio)

npm: `dataverse web api` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [dataverse-webapi 3.3.0](https://www.npmjs.com/package/dataverse-webapi) — Dataverse Web Api TypeScript Module; source: [declared repository](https://github.com/derekfinlinson/powerapps-tools.git).
3. [@mohsinonxrm/pptb-dataverse-request-studio 1.1.4](https://www.npmjs.com/package/@mohsinonxrm/pptb-dataverse-request-studio) — Compose, preview, and execute Microsoft Dataverse Web API requests — a metadata-driven studio for OData queries, record writes, associations, action/function/workflow invocation, and file/image/attachment operations. Embeds in Power Platform ToolBox.; source: [declared repository](https://github.com/mohsinonxrm/pptb-mxrm-dataverse-request-studio.git).
4. [@delegateas/xrmquery 7.0.0-preview.1](https://www.npmjs.com/package/@delegateas/xrmquery) — Type-safe Dataverse Web API query library. The XrmQuery runtime, modernized as an npm package — pairs with typings generated by XrmDefinitelyTyped.; source: [declared repository](https://github.com/delegateas/XrmDefinitelyTyped.git).
5. [dataverse-local-mcp 1.3.1](https://www.npmjs.com/package/dataverse-local-mcp) — MCP server for the Dataverse Web API with MSAL interactive auth (no @microsoft/dataverse CLI); source: [declared repository](https://github.com/BusinessNone/PowerPreflight.git).
6. [@powerpreflight/dataverse 1.3.1](https://www.npmjs.com/package/@powerpreflight/dataverse) — Dataverse Web API client. Depends on core, takes an ITokenProvider and an injected fetch — no ambient network, fully testable against recorded responses (spec §2, §4).; source: [declared repository](https://github.com/BusinessNone/PowerPreflight.git).
7. [@xrmforge/dataverse-core 0.1.0](https://www.npmjs.com/package/@xrmforge/dataverse-core) — Runtime-neutral Dataverse Web API core: transport interface, resilient runner, and OData sanitizers; source: [declared repository](https://github.com/juergenbeck/XrmForge.git).
8. [dataverse-api 0.0.20](https://www.npmjs.com/package/dataverse-api) — Super-boundary for interacting with the Microsoft Dataverse Web API using the Xrm.WebApi definition, or a wrapper around the Fetch API when Xrm.WebApi does not suffice.; source: [declared repository](https://github.com/melody-universe/dataverse-api.git).
9. [@xrmforge/dataverse-client 0.1.0](https://www.npmjs.com/package/@xrmforge/dataverse-client) — Browser-first Dataverse Web API client: cookie-based fetch transport and retrieveAll paging; source: [declared repository](https://github.com/juergenbeck/XrmForge.git).
10. [webidl-conversions 8.0.1](https://www.npmjs.com/package/webidl-conversions) — Implements the WebIDL algorithms for converting to and from JavaScript values; source: [declared repository](https://github.com/jsdom/webidl-conversions.git).

<a id="lense-lense-dataverse-provisioning"></a>

### Schema manifests, additive provisioning, drift plans, solution membership and export/unpack

Sources: [lense/dataverse/manifest.mjs](../lense/dataverse/manifest.mjs), [lense/dataverse/provision.mjs](../lense/dataverse/provision.mjs), [lense/dataverse/cli.mjs](../lense/dataverse/cli.mjs).

GitHub: `dataverse schema provisioning in:name,description,readme` — page 1, up to 10 results.

1. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
2. [Azure/dataverse-to-sql](https://github.com/Azure/dataverse-to-sql) — archived
3. [slavatrofimov/Sync-Dataverse-data-from-Synapse-Serverless-to-Azure-SQL-DB](https://github.com/slavatrofimov/Sync-Dataverse-data-from-Synapse-Serverless-to-Azure-SQL-DB)
4. [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
5. [TheLobbi/Claude-m](https://github.com/TheLobbi/Claude-m)
6. [ArashAghajani/powerplatform-migrator](https://github.com/ArashAghajani/powerplatform-migrator)
7. [mscottsewell/DataverseToPowerBI](https://github.com/mscottsewell/DataverseToPowerBI)
8. [matthidinger/powerapps-timetracker-copilot-sample](https://github.com/matthidinger/powerapps-timetracker-copilot-sample)
9. [rcb0727/powerplatform-mcp-server](https://github.com/rcb0727/powerplatform-mcp-server)
10. [ALM4Dataverse/ALM4Dataverse](https://github.com/ALM4Dataverse/ALM4Dataverse)

npm: `dataverse metadata` — first registry result list, up to 10 packages.

1. [@linked365/pptb-metadata-browser 0.6.0](https://www.npmjs.com/package/@linked365/pptb-metadata-browser) — Dataverse Metadata browser; source: [declared repository](https://github.com/LinkeD365/Metadata-Browser.git).
2. [arbentia-dataverse-mcp 1.0.12](https://www.npmjs.com/package/arbentia-dataverse-mcp) — Model Context Protocol (MCP) server for Microsoft Dataverse Metadata; source: [declared repository](https://github.com/arbentia-dev/arbentia-dataverse-mcp.git).
3. [powerplatform-cli 2.5.0](https://www.npmjs.com/package/powerplatform-cli) — PowerPlatform CLI — query Dataverse metadata with cached file output; source: [declared repository](https://github.com/michsob/powerplatform-mcp.git).
4. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
5. [gcp-metadata 9.2.2](https://www.npmjs.com/package/gcp-metadata) — Get the metadata from a Google Cloud Platform environment; source: [declared repository](https://github.com/googleapis/google-cloud-node.git).
6. [ppai-mcp 0.2.1](https://www.npmjs.com/package/ppai-mcp) — MCP stdio server that generates Power Pages artifacts (Liquid web templates, definitions, table permissions) from live Dataverse metadata.; source: [declared repository](https://github.com/miraculesx/Ppai.git).
7. [reflect-metadata 0.2.2](https://www.npmjs.com/package/reflect-metadata) — Polyfill for Metadata Reflection API; source: [declared repository](https://github.com/rbuckton/reflect-metadata.git).
8. [d365-troubleshooter-mcp 1.0.6](https://www.npmjs.com/package/d365-troubleshooter-mcp) — Give your coding agent direct access to Dynamics 365 / Dataverse metadata and web resources through a Model Context Protocol (MCP) server.; source: [declared repository](https://github.com/kishanmundha/d365-troubleshooter-mcp.git).
9. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
10. [babel-plugin-transform-typescript-metadata 0.4.0](https://www.npmjs.com/package/babel-plugin-transform-typescript-metadata) — Babel plugin to emit decorator metadata like typescript compiler; source: [declared repository](https://github.com/leonardfactory/babel-plugin-transform-typescript-metadata.git).

<a id="lense-lense-dataverse-data-sites"></a>

### Reproducible data plans, comparison, FetchXML retrieval and Power Pages site management

Sources: [lense/dataverse/data.mjs](../lense/dataverse/data.mjs), [lense/dataverse/power-pages.mjs](../lense/dataverse/power-pages.mjs).

GitHub: `dataverse data migration in:name,description,readme` — page 1, up to 10 results.

1. [MicrosoftDocs/dynamics365smb-devitpro-pb](https://github.com/MicrosoftDocs/dynamics365smb-devitpro-pb)
2. [microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills)
3. [microsoft/Dynamics-365-FastTrack-Implementation-Assets](https://github.com/microsoft/Dynamics-365-FastTrack-Implementation-Assets)
4. [Power-Maverick/DataverseDevTools-VSCode](https://github.com/Power-Maverick/DataverseDevTools-VSCode)
5. [microsoft/power-cat-skills](https://github.com/microsoft/power-cat-skills)
6. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
7. [amervitz/xRM-Portals-Community-Edition](https://github.com/amervitz/xRM-Portals-Community-Edition)
8. [microsoft/power-pages-samples](https://github.com/microsoft/power-pages-samples)
9. [scottdurow/dataverse-auth](https://github.com/scottdurow/dataverse-auth)
10. [microsoft/Federal-Business-Applications](https://github.com/microsoft/Federal-Business-Applications)

npm: `dataverse data migration` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [jsonwebtoken 9.0.3](https://www.npmjs.com/package/jsonwebtoken) — JSON Web Token implementation (symmetric and asymmetric); source: [declared repository](https://github.com/auth0/node-jsonwebtoken.git).
3. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
4. [contentful-migration 5.1.1](https://www.npmjs.com/package/contentful-migration) — Migration tooling for contentful; source: [declared repository](https://github.com/contentful/contentful-migration.git).
5. [@tekstack/client-data-model 1.0.101](https://www.npmjs.com/package/@tekstack/client-data-model) — TekStack client-side Dataverse data model for TypeScript projects.; source: no repository declared in search metadata.
6. [umzug 3.8.3](https://www.npmjs.com/package/umzug) — Framework-agnostic migration tool for Node; source: [declared repository](https://github.com/sequelize/umzug.git).
7. [@otplib/preset-v11 13.5.0](https://www.npmjs.com/package/@otplib/preset-v11) — v11 compatibility preset for otplib; source: [declared repository](https://github.com/yeojz/otplib.git).
8. [@theatre/dataverse 0.7.2](https://www.npmjs.com/package/@theatre/dataverse) — No description; source: [declared repository](https://github.com/AriaMinaei/theatre).
9. [auth0 7.6.0](https://www.npmjs.com/package/auth0) — Auth0 Node.js SDK for the Management API v2.; source: [declared repository](https://github.com/auth0/node-auth0.git).
10. [dbmate 2.37.0](https://www.npmjs.com/package/dbmate) — A lightweight, framework-agnostic database migration tool; source: [declared repository](https://github.com/amacneil/dbmate.git).

<a id="lense-scripts-baseline-evidence"></a>

### Baseline coverage matrices and redacted offline reference evidence

Sources: [scripts/baseline-inventory.mjs](../scripts/baseline-inventory.mjs), [scripts/baseline-matrix.mjs](../scripts/baseline-matrix.mjs), [scripts/baseline-reference.mjs](../scripts/baseline-reference.mjs), [scripts/collect-evidence.mjs](../scripts/collect-evidence.mjs).

GitHub: `browser differential testing in:name,description,readme` — page 1, up to 10 results.

1. [rossant/awesome-math](https://github.com/rossant/awesome-math)
2. [browserslist/browserslist](https://github.com/browserslist/browserslist)
3. [namastedev/namaste-react](https://github.com/namastedev/namaste-react)
4. [crazyhottommy/RNA-seq-analysis](https://github.com/crazyhottommy/RNA-seq-analysis)
5. [1ove9/antenna-forge](https://github.com/1ove9/antenna-forge)
6. [cpuu/awesome-fuzzing](https://github.com/cpuu/awesome-fuzzing)
7. [whwangovo/pyre-code](https://github.com/whwangovo/pyre-code)
8. [FreedomIntelligence/OpenClaw-Medical-Skills](https://github.com/FreedomIntelligence/OpenClaw-Medical-Skills)
9. [trailofbits/skills](https://github.com/trailofbits/skills)
10. [Arachni/arachni](https://github.com/Arachni/arachni) — archived

Refinement: `"differential testing" browser in:readme language:TypeScript` — page 1, up to 10 results.

1. [Novage/wt-tracker](https://github.com/Novage/wt-tracker)
2. [simpleledger/slp-validate.js](https://github.com/simpleledger/slp-validate.js)
3. [shadcn-ui/cn](https://github.com/shadcn-ui/cn)
4. [karagozemin/OverSync](https://github.com/karagozemin/OverSync)
5. [be-thomas/OpenPineScript](https://github.com/be-thomas/OpenPineScript)
6. [nrjdalal/gitpick](https://github.com/nrjdalal/gitpick)
7. [vijaypemmaraju/rondocode](https://github.com/vijaypemmaraju/rondocode)
8. [pokepc/koffing](https://github.com/pokepc/koffing)
9. [Gryd-lock/grydlock-oracle-adapter](https://github.com/Gryd-lock/grydlock-oracle-adapter)
10. [productdevbook/etiket](https://github.com/productdevbook/etiket)

npm: `differential testing` — first registry result list, up to 10 packages.

1. [@tanstack/db-ivm 0.2.0](https://www.npmjs.com/package/@tanstack/db-ivm) — Incremental View Maintenance for TanStack DB based on Differential Dataflow; source: [declared repository](https://github.com/TanStack/db.git).
2. [@testing-library/dom 10.4.2](https://www.npmjs.com/package/@testing-library/dom) — Simple and complete DOM testing utilities that encourage good testing practices.; source: [declared repository](https://github.com/testing-library/dom-testing-library.git).
3. [@testing-library/react 16.3.3](https://www.npmjs.com/package/@testing-library/react) — Simple and complete React DOM testing utilities that encourage good testing practices.; source: [declared repository](https://github.com/testing-library/react-testing-library.git).
4. [@testing-library/jest-dom 7.0.1](https://www.npmjs.com/package/@testing-library/jest-dom) — Custom jest matchers to test the state of the DOM; source: [declared repository](https://github.com/testing-library/jest-dom.git).
5. [@earendil-works/pi-tui 1.4.0](https://www.npmjs.com/package/@earendil-works/pi-tui) — Terminal User Interface library with differential rendering for efficient text-based applications; source: [declared repository](https://github.com/earendil-works/pi.git).
6. [@testing-library/user-event 14.6.8](https://www.npmjs.com/package/@testing-library/user-event) — Fire events the same way the user does; source: [declared repository](https://github.com/testing-library/user-event.git).
7. [jest-cli 30.5.2](https://www.npmjs.com/package/jest-cli) — Delightful JavaScript Testing.; source: [declared repository](https://github.com/jestjs/jest.git).
8. [jest 30.5.2](https://www.npmjs.com/package/jest) — Delightful JavaScript Testing.; source: [declared repository](https://github.com/jestjs/jest.git).
9. [eslint-plugin-testing-library 7.16.2](https://www.npmjs.com/package/eslint-plugin-testing-library) — ESLint plugin to follow best practices and anticipate common mistakes when writing tests with Testing Library; source: [declared repository](https://github.com/testing-library/eslint-plugin-testing-library.git).
10. [react-test-renderer 19.3.1](https://www.npmjs.com/package/react-test-renderer) — React package for snapshot testing.; source: [declared repository](https://github.com/react/react.git).

<a id="lense-scripts-sdk-oracle"></a>

### SDK interoperability, consumer compatibility and Power Fx differential qualification

Sources: [scripts/consumer-tool-smoke.mjs](../scripts/consumer-tool-smoke.mjs), [scripts/power-fx-oracle.mjs](../scripts/power-fx-oracle.mjs), [scripts/ci.mjs](../scripts/ci.mjs).

GitHub: `powerplatform sdk testing in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/PowerApps-Tooling](https://github.com/microsoft/PowerApps-Tooling)
2. [michsob/powerplatform-mcp](https://github.com/michsob/powerplatform-mcp)
3. [seanmcne/OrgDbOrgSettings](https://github.com/seanmcne/OrgDbOrgSettings)
4. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
5. [seanmcne/Microsoft.Xrm.Data.PowerShell](https://github.com/seanmcne/Microsoft.Xrm.Data.PowerShell)
6. [NicolasPrats/DvBrowser](https://github.com/NicolasPrats/DvBrowser)
7. [dylanhaskins/Microsoft.PowerPlatform.DevOps.Documentation](https://github.com/dylanhaskins/Microsoft.PowerPlatform.DevOps.Documentation)
8. [ArashAghajani/powerplatform-migrator](https://github.com/ArashAghajani/powerplatform-migrator)
9. [hac01/azure-pentesting-suite](https://github.com/hac01/azure-pentesting-suite)
10. [satriotsubasa/PowerPlatform-Core](https://github.com/satriotsubasa/PowerPlatform-Core)

npm: `powerfx` — first registry result list, up to 10 packages.

1. [@microsoft/power-fx-formulabar 6.0.10](https://www.npmjs.com/package/@microsoft/power-fx-formulabar) — PowerFx Formula bar; source: no repository declared in search metadata.
2. [@toy-box/powerfx-editor 1.0.3-alpha.12](https://www.npmjs.com/package/@toy-box/powerfx-editor) — ### Install; source: no repository declared in search metadata.
3. [@toy-box/meta-powerfx 2.0.35](https://www.npmjs.com/package/@toy-box/meta-powerfx) — No description; source: no repository declared in search metadata.
4. [@toy-box/powerfx-worker 1.0.3-alpha.12](https://www.npmjs.com/package/@toy-box/powerfx-worker) — ### Install; source: no repository declared in search metadata.
5. [@toy-box/powerfx-core 1.0.3-alpha.12](https://www.npmjs.com/package/@toy-box/powerfx-core) — ### Install; source: no repository declared in search metadata.
6. [wt-powerfx 1.0.1](https://www.npmjs.com/package/wt-powerfx) — Enhanced effects for Windows Terminal – keystroke sounds, particle overlay, window shake; source: no repository declared in search metadata.

<a id="lense-scripts-performance"></a>

### Startup, dataset and DOM performance budgets and benchmarks

Sources: [scripts/benchmark.mjs](../scripts/benchmark.mjs), [scripts/benchmark-xray.mjs](../scripts/benchmark-xray.mjs), [scripts/runtime-performance.mjs](../scripts/runtime-performance.mjs).

GitHub: `node performance benchmark in:name,description,readme` — page 1, up to 10 results.

1. [base/benchmark](https://github.com/base/benchmark)
2. [krausest/js-framework-benchmark](https://github.com/krausest/js-framework-benchmark)
3. [fastify/fastify](https://github.com/fastify/fastify)
4. [deepseek-ai/DeepSeek-V3](https://github.com/deepseek-ai/DeepSeek-V3)
5. [sindresorhus/awesome-nodejs](https://github.com/sindresorhus/awesome-nodejs)
6. [clinicjs/node-clinic](https://github.com/clinicjs/node-clinic)
7. [RRZE-HPC/likwid](https://github.com/RRZE-HPC/likwid)
8. [wg/wrk](https://github.com/wg/wrk)
9. [oxc-project/oxc](https://github.com/oxc-project/oxc)
10. [linux-rdma/perftest](https://github.com/linux-rdma/perftest)

Refinement: `"node" "benchmark" in:name,description` — page 1, up to 10 results.

1. [mcollina/autocannon](https://github.com/mcollina/autocannon)
2. [cr0hn/vulnerable-node](https://github.com/cr0hn/vulnerable-node)
3. [nodejs/benchmarking](https://github.com/nodejs/benchmarking) — archived
4. [shchur/gnn-benchmark](https://github.com/shchur/gnn-benchmark) — archived
5. [ebdrup/json-schema-benchmark](https://github.com/ebdrup/json-schema-benchmark)
6. [matteofigus/api-benchmark](https://github.com/matteofigus/api-benchmark)
7. [geerlingguy/top500-benchmark](https://github.com/geerlingguy/top500-benchmark)
8. [GoalSmashers/css-minification-benchmark](https://github.com/GoalSmashers/css-minification-benchmark)
9. [benawad/node-graphql-benchmarks](https://github.com/benawad/node-graphql-benchmarks)
10. [hbakhtiyor/node-frameworks-benchmark](https://github.com/hbakhtiyor/node-frameworks-benchmark)

npm: `performance benchmark` — first registry result list, up to 10 packages.

1. [@nestia/benchmark 14.1.0](https://www.npmjs.com/package/@nestia/benchmark) — NestJS Performance Benchmark Program; source: [declared repository](https://github.com/samchon/nestia.git).
2. [overtake 2.1.1](https://www.npmjs.com/package/overtake) — NodeJS performance benchmark; source: [declared repository](https://github.com/3axap4eHko/overtake.git).
3. [gulp-bench 1.1.0](https://www.npmjs.com/package/gulp-bench) — Run performance benchmark tests; source: [declared repository](https://github.com/hiddentao/gulp-bench.git).
4. [falcon-benchmark 0.1.1-0](https://www.npmjs.com/package/falcon-benchmark) — Javascript performance benchmark library; source: a repository is declared in registry metadata.
5. [@hyperledger/caliper-cli 0.7.1](https://www.npmjs.com/package/@hyperledger/caliper-cli) — Hyperledger Caliper CLI, for convenience running of a performance benchmark to test blockchain technologies; source: [declared repository](https://github.com/hyperledger-caliper/caliper.git).
6. [@durable-streams/benchmarks 0.2.7](https://www.npmjs.com/package/@durable-streams/benchmarks) — Performance benchmark suite for Durable Streams server implementations; source: [declared repository](https://github.com/durable-streams/durable-streams.git).
7. [@formatjs/intl-localematcher 0.9.0](https://www.npmjs.com/package/@formatjs/intl-localematcher) — Intl.LocaleMatcher ponyfill; source: a repository is declared in registry metadata.
8. [js-md5 0.9.2](https://www.npmjs.com/package/js-md5) — A simple MD5 hash function for JavaScript supports UTF-8 encoding.; source: [declared repository](https://github.com/emn178/js-md5.git).
9. [useragent 2.3.0](https://www.npmjs.com/package/useragent) — Fastest, most accurate &#38; effecient user agent string parser, uses Browserscope's research for parsing; source: a repository is declared in registry metadata.
10. [node-html-parser 9.0.5](https://www.npmjs.com/package/node-html-parser) — A very fast HTML parser, generating a simplified DOM, with basic element query support.; source: [declared repository](https://github.com/taoqf/node-fast-html-parser.git).

<a id="lense-scripts-static-quality"></a>

### Static quality, compatibility watchers and project boundary enforcement

Sources: [scripts/code-review.mjs](../scripts/code-review.mjs), [scripts/generate-compat-watchers.mjs](../scripts/generate-compat-watchers.mjs), [scripts/project-boundary.mjs](../scripts/project-boundary.mjs), [scripts/check.mjs](../scripts/check.mjs).

GitHub: `javascript architecture checks in:name,description,readme` — page 1, up to 10 results.

1. [evancz/elm-architecture-tutorial](https://github.com/evancz/elm-architecture-tutorial)
2. [atulmy/fullstack-javascript-architecture](https://github.com/atulmy/fullstack-javascript-architecture) — archived
3. [angular/angular](https://github.com/angular/angular)
4. [nestjs/nest](https://github.com/nestjs/nest)
5. [stemmlerjs/software-design-and-architecture-roadmap](https://github.com/stemmlerjs/software-design-and-architecture-roadmap)
6. [DevCaress/guia-entrevistas-de-programacion](https://github.com/DevCaress/guia-entrevistas-de-programacion)
7. [nodeshift/nodejs-reference-architecture](https://github.com/nodeshift/nodejs-reference-architecture)
8. [architecture-decision-record/architecture-decision-record](https://github.com/architecture-decision-record/architecture-decision-record)
9. [ryanmcdermott/clean-code-javascript](https://github.com/ryanmcdermott/clean-code-javascript)
10. [swc-project/swc](https://github.com/swc-project/swc)

Refinement: `"dependency" architecture lint in:name,description` — page 1, up to 10 results.

1. [ynishi/arch-lint](https://github.com/ynishi/arch-lint)
2. [lulumeimei/flutter_boilerplate](https://github.com/lulumeimei/flutter_boilerplate)
3. [BartoszCiesla/crawk](https://github.com/BartoszCiesla/crawk)
4. [leofmarciano/arch-contract](https://github.com/leofmarciano/arch-contract)
5. [tornikegomareli/tca-graph](https://github.com/tornikegomareli/tca-graph)
6. [qiuethan/archctl](https://github.com/qiuethan/archctl)
7. [Jing-command/openai-harness-linter](https://github.com/Jing-command/openai-harness-linter)
8. [ThomasLeMontagner/archi](https://github.com/ThomasLeMontagner/archi)
9. [denismaciel/lint-it](https://github.com/denismaciel/lint-it)
10. [mao2009/ArchLintCpp](https://github.com/mao2009/ArchLintCpp)

npm: `architecture lint` — first registry result list, up to 10 packages.

1. [@archrad/deterministic 0.7.1](https://www.npmjs.com/package/@archrad/deterministic) — A deterministic compiler and linter for system architecture. Validate your architecture before you write code. OSS: structural validation + basic architecture lint (rule-based); FastAPI/Express export; OpenAPI document-shape; golden Docker/Makefile — no L; source: [declared repository](https://github.com/archradhq/arch-deterministic.git).
2. [system-architecture 1.0.0](https://www.npmjs.com/package/system-architecture) — Get the operating system CPU architecture; source: [declared repository](https://github.com/sindresorhus/system-architecture.git).
3. [lint-staged 17.6.0](https://www.npmjs.com/package/lint-staged) — Lint files staged by git; source: [declared repository](https://github.com/lint-staged/lint-staged.git).
4. [arch 3.0.0](https://www.npmjs.com/package/arch) — Better &#96;os.arch()&#96; for node and the browser -- detect OS architecture; source: a repository is declared in registry metadata.
5. [is64bit 2.0.0](https://www.npmjs.com/package/is64bit) — Check whether operating system CPU architecture is 64-bit or 32-bit (Supports browsers); source: [declared repository](https://github.com/sindresorhus/is64bit.git).
6. [@mapbox/jsonlint-lines-primitives 2.0.3](https://www.npmjs.com/package/@mapbox/jsonlint-lines-primitives) — Validate JSON; source: a repository is declared in registry metadata.
7. [@shadcn/lint 0.2.3](https://www.npmjs.com/package/@shadcn/lint) — A programmable agent-first linter for Tailwind design systems.; source: [declared repository](https://github.com/shadcn-ui/lint.git).
8. [@toptal/davinci-syntax 25.0.0](https://www.npmjs.com/package/@toptal/davinci-syntax) — Lint and prettier support; source: [declared repository](https://github.com/toptal/davinci.git).
9. [unified-lint-rule 3.0.1](https://www.npmjs.com/package/unified-lint-rule) — unified plugin to make it a bit easier to create linting rules; source: [declared repository](https://github.com/remarkjs/remark-lint.git#main).
10. [lockfile-lint 5.1.0](https://www.npmjs.com/package/lockfile-lint) — A CLI to lint a lockfile for security policies; source: [declared repository](https://github.com/lirantal/lockfile-lint.git).

<a id="lense-scripts-ci-readiness"></a>

### CI orchestration, workflow security and effective PR merge readiness

Sources: [scripts/ci.mjs](../scripts/ci.mjs), [scripts/check-workflows.mjs](../scripts/check-workflows.mjs), [scripts/pr-readiness.mjs](../scripts/pr-readiness.mjs), [scripts/github-admin.mjs](../scripts/github-admin.mjs).

GitHub: `github codeql checks in:name,description,readme` — page 1, up to 10 results.

1. [github/codeql](https://github.com/github/codeql)
2. [github/code-scanning-javascript-demo](https://github.com/github/code-scanning-javascript-demo) — archived
3. [gadievron/raptor](https://github.com/gadievron/raptor)
4. [nasa/openmct](https://github.com/nasa/openmct)
5. [github/semantic](https://github.com/github/semantic) — archived
6. [github/codeql-coding-standards](https://github.com/github/codeql-coding-standards)
7. [Firebasky/CodeqlLearn](https://github.com/Firebasky/CodeqlLearn)
8. [advanced-security-demo/demo-python](https://github.com/advanced-security-demo/demo-python)
9. [dec0dOS/amazing-github-template](https://github.com/dec0dOS/amazing-github-template)
10. [advanced-security-demo/demo-java](https://github.com/advanced-security-demo/demo-java)

npm: `github actions validation` — first registry result list, up to 10 packages.

1. [zod 4.6.7](https://www.npmjs.com/package/zod) — TypeScript-first schema declaration and validation library with static type inference; source: [declared repository](https://github.com/colinhacks/zod.git).
2. [css-tree 3.2.1](https://www.npmjs.com/package/css-tree) — A tool set for CSS: fast detailed parser (CSS → AST), walker (AST traversal), generator (AST → CSS) and lexer (validation and matching) based on specs and browser implementations; source: [declared repository](https://github.com/csstree/csstree.git).
3. [zod-validation-error 5.0.0](https://www.npmjs.com/package/zod-validation-error) — Wrap zod validation errors in user-friendly readable messages; source: a repository is declared in registry metadata.
4. [@vinejs/vine 4.4.0](https://www.npmjs.com/package/@vinejs/vine) — Form data validation library for Node.js; source: [declared repository](https://github.com/vinejs/vine.git).
5. [npm-user-validate 5.0.0](https://www.npmjs.com/package/npm-user-validate) — User validations for npm; source: [declared repository](https://github.com/npm/npm-user-validate.git).
6. [valibot 1.5.0](https://www.npmjs.com/package/valibot) — The modular and type safe schema library for validating structural data; source: [declared repository](https://github.com/open-circle/valibot.git).
7. [ip-address 10.7.5](https://www.npmjs.com/package/ip-address) — A library for parsing IPv4 and IPv6 IP addresses in node and the browser.; source: [declared repository](https://github.com/beaugunderson/ip-address.git).
8. [jquery-validation 1.22.1](https://www.npmjs.com/package/jquery-validation) — Client-side form validation made easy; source: a repository is declared in registry metadata.
9. [react-native-reanimated 4.7.1](https://www.npmjs.com/package/react-native-reanimated) — More powerful alternative to Animated library for React Native.; source: [declared repository](https://github.com/software-mansion/react-native-reanimated.git).
10. [@asamuzakjp/generational-cache 3.0.1](https://www.npmjs.com/package/@asamuzakjp/generational-cache) — A generational cache with strict entry-count limits and payload validation.; source: [declared repository](https://github.com/asamuzaK/generationalCache.git).

<a id="lense-scripts-package-integrity"></a>

### Dependency provenance, verified downloads, offline package cache and consumer smoke

Sources: [scripts/audit-dependencies.mjs](../scripts/audit-dependencies.mjs), [scripts/verified-download.mjs](../scripts/verified-download.mjs), [scripts/prime-package-cache.mjs](../scripts/prime-package-cache.mjs), [scripts/package-smoke.mjs](../scripts/package-smoke.mjs), [scripts/smoke-npm.mjs](../scripts/smoke-npm.mjs), [scripts/package-dependency-evidence.mjs](../scripts/package-dependency-evidence.mjs).

GitHub: `npm supply chain verification in:name,description,readme` — page 1, up to 10 results.

1. [compound-finance/compound-protocol](https://github.com/compound-finance/compound-protocol)
2. [DataDog/guarddog](https://github.com/DataDog/guarddog)
3. [bureado/awesome-software-supply-chain-security](https://github.com/bureado/awesome-software-supply-chain-security)
4. [DataDog/supply-chain-firewall](https://github.com/DataDog/supply-chain-firewall)
5. [lirantal/awesome-nodejs-security](https://github.com/lirantal/awesome-nodejs-security)
6. [elastic/supply-chain-monitor](https://github.com/elastic/supply-chain-monitor)
7. [lirantal/npm-security-best-practices](https://github.com/lirantal/npm-security-best-practices)
8. [VenusProtocol/venus-protocol](https://github.com/VenusProtocol/venus-protocol)
9. [unpkg/unpkg](https://github.com/unpkg/unpkg)
10. [Cobenian/shai-hulud-detect](https://github.com/Cobenian/shai-hulud-detect)

npm: `package provenance` — first registry result list, up to 10 packages.

1. [@exactjs/package-provenance 0.7.0](https://www.npmjs.com/package/@exactjs/package-provenance) — Shared Node package provenance and public-export resolution for eXact tooling; source: [declared repository](https://github.com/techjoshua/exact.git).
2. [jscpd-linux-x64-gnu 5.4.2](https://www.npmjs.com/package/jscpd-linux-x64-gnu) — Prebuilt Linux x64 GNU binaries for jscpd; source: [declared repository](https://github.com/kucherenko/jscpd.git).
3. [jscpd-linux-x64-musl 5.4.2](https://www.npmjs.com/package/jscpd-linux-x64-musl) — Prebuilt Linux x64 musl binaries for jscpd; source: [declared repository](https://github.com/kucherenko/jscpd.git).
4. [mongodb 7.7.0](https://www.npmjs.com/package/mongodb) — The official MongoDB driver for Node.js; source: a repository is declared in registry metadata.
5. [bson 7.3.3](https://www.npmjs.com/package/bson) — A bson parser for node.js and the browser; source: [declared repository](https://github.com/mongodb/js-bson.git).
6. [cpd-linux-x64-gnu 5.0.11](https://www.npmjs.com/package/cpd-linux-x64-gnu) — Prebuilt Linux x64 GNU binaries for cpd; source: [declared repository](https://github.com/kucherenko/jscpd.git).
7. [@launchdarkly/js-sdk-common 2.32.0](https://www.npmjs.com/package/@launchdarkly/js-sdk-common) — LaunchDarkly SDK for JavaScript - common code; source: [declared repository](https://github.com/launchdarkly/js-core.git).
8. [@launchdarkly/js-server-sdk-common 2.26.0](https://www.npmjs.com/package/@launchdarkly/js-server-sdk-common) — LaunchDarkly Server SDK for JavaScript - common code; source: [declared repository](https://github.com/launchdarkly/js-core.git).
9. [@launchdarkly/openfeature-js-server-common 2.2.1](https://www.npmjs.com/package/@launchdarkly/openfeature-js-server-common) — LaunchDarkly OpenFeature common provider for server-side JavaScript SDKs; source: [declared repository](https://github.com/launchdarkly/js-core.git).
10. [node-releases 2.0.60](https://www.npmjs.com/package/node-releases) — Node.js releases data; source: [declared repository](https://github.com/chicoxyzzy/node-releases.git).

<a id="lense-scripts-release-retention"></a>

### Release/version checks, preview release publication and retention

Sources: [scripts/release-check.mjs](../scripts/release-check.mjs), [scripts/release-version.mjs](../scripts/release-version.mjs), [scripts/preview-release.mjs](../scripts/preview-release.mjs), [scripts/preview-retention.mjs](../scripts/preview-retention.mjs).

GitHub: `npm preview releases in:name,description,readme` — page 1, up to 10 results.

1. [PanJiaChen/vue-element-admin](https://github.com/PanJiaChen/vue-element-admin)
2. [stackblitz-labs/pkg.pr.new](https://github.com/stackblitz-labs/pkg.pr.new)
3. [google-gemini/gemini-cli](https://github.com/google-gemini/gemini-cli)
4. [PanJiaChen/vue-admin-template](https://github.com/PanJiaChen/vue-admin-template)
5. [twbs/bootstrap](https://github.com/twbs/bootstrap)
6. [sindresorhus/np](https://github.com/sindresorhus/np)
7. [StartBootstrap/startbootstrap-sb-admin-2](https://github.com/StartBootstrap/startbootstrap-sb-admin-2)
8. [ant-design/ant-design-pro](https://github.com/ant-design/ant-design-pro)
9. [StartBootstrap/startbootstrap-resume](https://github.com/StartBootstrap/startbootstrap-resume)
10. [StartBootstrap/startbootstrap-creative](https://github.com/StartBootstrap/startbootstrap-creative)

npm: `release automation` — first registry result list, up to 10 packages.

1. [@ossjs/release 0.11.2](https://www.npmjs.com/package/@ossjs/release) — Minimalistic, opinionated, and predictable release automation tool.; source: [declared repository](https://github.com/ossjs/release.git).
2. [code-foundry 1.48.8](https://www.npmjs.com/package/code-foundry) — A fast, language-aware repository factory for agent-ready workflows, testing, security, and release automation.; source: [declared repository](https://github.com/0xPlayerOne/code-foundry.git).
3. [versions 15.5.2](https://www.npmjs.com/package/versions) — Release automation: bump the version, commit, tag, push and create a GitHub or Gitea release; source: [declared repository](https://github.com/silverwind/versions.git).
4. [@hesxo/viro-cli 4.0.5](https://www.npmjs.com/package/@hesxo/viro-cli) — AI-powered Git Release &#38; Automation Tool; source: no repository declared in search metadata.
5. [project-auto-wizard 1.0.3](https://www.npmjs.com/package/project-auto-wizard) — One command DevOps: npx wizard that installs GitHub-native Release Automation (optional GitHub Copilot AI summaries) into any project; source: [declared repository](https://github.com/Twin-Fang/project-auto-wizard.git).
6. [@tj-smith47/anodizer-darwin-x64 0.30.0](https://www.npmjs.com/package/@tj-smith47/anodizer-darwin-x64) — A Rust-native release automation tool; source: [declared repository](https://github.com/tj-smith47/anodizer.git).
7. [node-publisher 3.7.0](https://www.npmjs.com/package/node-publisher) — A configurable release automation tool inspired by create-react-app and Travis CI.; source: a repository is declared in registry metadata.
8. [@tj-smith47/anodizer-linux-x64-glibc 0.30.0](https://www.npmjs.com/package/@tj-smith47/anodizer-linux-x64-glibc) — A Rust-native release automation tool; source: [declared repository](https://github.com/tj-smith47/anodizer.git).
9. [@tj-smith47/anodizer-linux-arm64-glibc 0.30.0](https://www.npmjs.com/package/@tj-smith47/anodizer-linux-arm64-glibc) — A Rust-native release automation tool; source: [declared repository](https://github.com/tj-smith47/anodizer.git).
10. [@tj-smith47/anodizer-linux-x64-musl 0.30.0](https://www.npmjs.com/package/@tj-smith47/anodizer-linux-x64-musl) — A Rust-native release automation tool; source: [declared repository](https://github.com/tj-smith47/anodizer.git).

<a id="lense-scripts-docs-demo"></a>

### Documentation site generation and executable demo workflows

Sources: [scripts/build-site.mjs](../scripts/build-site.mjs), [scripts/demo.mjs](../scripts/demo.mjs), [lense/commands/demo.mjs](../lense/commands/demo.mjs).

GitHub: `documentation interactive examples in:name,description,readme` — page 1, up to 10 results.

1. [nextcloud/documentation](https://github.com/nextcloud/documentation)
2. [serverless/examples](https://github.com/serverless/examples)
3. [confluentinc/examples](https://github.com/confluentinc/examples)
4. [pulumi/examples](https://github.com/pulumi/examples)
5. [purescript/documentation](https://github.com/purescript/documentation)
6. [smartcontractkit/documentation](https://github.com/smartcontractkit/documentation)
7. [BabylonJS/Documentation](https://github.com/BabylonJS/Documentation)
8. [awsdocs/aws-doc-sdk-examples](https://github.com/awsdocs/aws-doc-sdk-examples)
9. [mashery/iodocs](https://github.com/mashery/iodocs)
10. [Qiskit/documentation](https://github.com/Qiskit/documentation)

Refinement: `"interactive documentation" in:name,description` — page 1, up to 10 results.

1. [trailofbits/zkdocs](https://github.com/trailofbits/zkdocs)
2. [ericandrewlewis/wp-media-javascript-guide](https://github.com/ericandrewlewis/wp-media-javascript-guide)
3. [a-chacon/oas_rails](https://github.com/a-chacon/oas_rails)
4. [ovac/idoc](https://github.com/ovac/idoc)
5. [jalopezsuarez/apidox](https://github.com/jalopezsuarez/apidox)
6. [Haruhiko-Joe/ACCEED](https://github.com/Haruhiko-Joe/ACCEED)
7. [tobieapb/claude-interactive-documentation-workflow](https://github.com/tobieapb/claude-interactive-documentation-workflow)
8. [MetaMask/docusaurus-openrpc](https://github.com/MetaMask/docusaurus-openrpc)
9. [apilayer/currencylayer-API](https://github.com/apilayer/currencylayer-API) — archived
10. [fhightower/ioc-finder](https://github.com/fhightower/ioc-finder)

npm: `documentation generator` — first registry result list, up to 10 packages.

1. [jsdoc 4.0.5](https://www.npmjs.com/package/jsdoc) — An API documentation generator for JavaScript.; source: [declared repository](https://github.com/jsdoc/jsdoc.git).
2. [documentation 14.0.3](https://www.npmjs.com/package/documentation) — a documentation generator; source: a repository is declared in registry metadata.
3. [docsify 5.0.0](https://www.npmjs.com/package/docsify) — A magical documentation generator.; source: [declared repository](https://github.com/docsifyjs/docsify.git).
4. [docsify-cli 5.0.0](https://www.npmjs.com/package/docsify-cli) — A magical documentation generator.; source: [declared repository](https://github.com/docsifyjs/docsify-cli.git).
5. [apidoc 1.2.0](https://www.npmjs.com/package/apidoc) — RESTful web API Documentation Generator; source: [declared repository](https://github.com/apidoc/apidoc.git).
6. [esdoc 1.1.0](https://www.npmjs.com/package/esdoc) — Good Documentation Generator For JavaScript; source: [declared repository](https://github.com/esdoc/esdoc.git).
7. [eslint-doc-generator 3.7.1](https://www.npmjs.com/package/eslint-doc-generator) — Automatic documentation generator for ESLint plugins and rules.; source: [declared repository](https://github.com/eslint-community/eslint-doc-generator.git).
8. [dox 1.0.0](https://www.npmjs.com/package/dox) — Markdown / JSdoc documentation generator; source: a repository is declared in registry metadata.
9. [@forsakringskassan/docs-generator 3.22.2](https://www.npmjs.com/package/@forsakringskassan/docs-generator) — Documentation generator; source: [declared repository](https://github.com/Forsakringskassan/docs-generator.git).
10. [@ankhorage/paradox 0.3.5](https://www.npmjs.com/package/@ankhorage/paradox) — Deterministic documentation generator for TypeScript packages.; source: [declared repository](https://github.com/ankhorage/paradox.git).

<a id="mirage-dataverse-odata"></a>

### Dataverse Web API, OData queries and navigation expansion

Sources: [mirage/lib/dataverse-api.mjs](../mirage/lib/dataverse-api.mjs), [mirage/lib/dataverse-odata.mjs](../mirage/lib/dataverse-odata.mjs), [mirage/lib/odata-query.mjs](../mirage/lib/odata-query.mjs), [mirage/lib/dataverse-expand.mjs](../mirage/lib/dataverse-expand.mjs).

GitHub: `Dataverse OData parser in:name,description,readme` — page 1, up to 10 results.

1. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)
2. [bcgov/jag-lcrb-carla-public](https://github.com/bcgov/jag-lcrb-carla-public)
3. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
4. [DataZooDE/erpl-odata](https://github.com/DataZooDE/erpl-odata)
5. [mohsinonxrm/pptb-mxrm-fetchxml-studio](https://github.com/mohsinonxrm/pptb-mxrm-fetchxml-studio)
6. [mgwojciech/mgwdev-m365-helpers](https://github.com/mgwojciech/mgwdev-m365-helpers)
7. [AshV/FetchXmlTester](https://github.com/AshV/FetchXmlTester)
8. [Roelzz/mcs-agent-analyser](https://github.com/Roelzz/mcs-agent-analyser)
9. [jaduplesms/PCF-Workbench](https://github.com/jaduplesms/PCF-Workbench)
10. [michsob/powerplatform-mcp](https://github.com/michsob/powerplatform-mcp)

npm: `dataverse odata parser` — first registry result list, up to 10 packages.

1. [@odata/parser 0.2.14](https://www.npmjs.com/package/@odata/parser) — OData(V4) Parser; source: [declared repository](https://github.com/Soontao/odata-v4-parser.git).
2. [@balena/odata-parser 4.4.1](https://www.npmjs.com/package/@balena/odata-parser) — An OData parser written in OMeta; source: [declared repository](https://github.com/balena-io-modules/odata-parser.git).
3. [odata-v4-parser 0.1.29](https://www.npmjs.com/package/odata-v4-parser) — OData v4 Parser; source: a repository is declared in registry metadata.
4. [odata-parser 1.4.1](https://www.npmjs.com/package/odata-parser) — OData query string parser; source: [declared repository](https://github.com/auth0/node-odata-parser.git).
5. [@steedos/odata-v4-parser 3.0.14](https://www.npmjs.com/package/@steedos/odata-v4-parser) — OData v4 Parser; source: a repository is declared in registry metadata.
6. [json-edm-parser 0.1.2](https://www.npmjs.com/package/json-edm-parser) — This is a JSON streaming parser for node.js. It will handle the Entity Data Model (EDM) types to be compatitable with odata.; source: [declared repository](https://github.com/yaxia/json-edm-parser.git).
7. [@babel/parser 8.0.8](https://www.npmjs.com/package/@babel/parser) — A JavaScript parser; source: [declared repository](https://github.com/babel/babel.git).
8. [yargs-parser 22.0.0](https://www.npmjs.com/package/yargs-parser) — the mighty option parser used by yargs; source: [declared repository](https://github.com/yargs/yargs-parser.git).
9. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
10. [@typescript-eslint/parser 8.72.1](https://www.npmjs.com/package/@typescript-eslint/parser) — An ESLint custom parser which leverages TypeScript ESTree; source: [declared repository](https://github.com/typescript-eslint/typescript-eslint.git).

<a id="mirage-fetchxml"></a>

### FetchXML joins, filters, aggregates and paging

Sources: [mirage/lib/fetchxml-engine.mjs](../mirage/lib/fetchxml-engine.mjs), [mirage/lib/portal-fetchxml.mjs](../mirage/lib/portal-fetchxml.mjs), [mirage/lib/permission-query.mjs](../mirage/lib/permission-query.mjs).

GitHub: `FetchXML query engine in:name,description,readme` — page 1, up to 10 results.

1. [MarkMpn/Sql4Cds](https://github.com/MarkMpn/Sql4Cds)
2. [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
3. [mohsinonxrm/pptb-mxrm-fetchxml-studio](https://github.com/mohsinonxrm/pptb-mxrm-fetchxml-studio)
4. [TALXIS/tools-cli](https://github.com/TALXIS/tools-cli)
5. [imranakram/Innofactor.Crm.CI](https://github.com/imranakram/Innofactor.Crm.CI)
6. [miseeger/Dataverse.Sql](https://github.com/miseeger/Dataverse.Sql)
7. [joshsmithxrm/power-platform-developer-suite](https://github.com/joshsmithxrm/power-platform-developer-suite)
8. [thygesteffensen/PAMU_CDS](https://github.com/thygesteffensen/PAMU_CDS)
9. [johnyenter-briars/queryverse](https://github.com/johnyenter-briars/queryverse)
10. [moazambadane/pcf-workbench](https://github.com/moazambadane/pcf-workbench)

npm: `fetchxml parser query` — first registry result list, up to 10 packages.

1. [@csstools/media-query-list-parser 5.0.2](https://www.npmjs.com/package/@csstools/media-query-list-parser) — Parse CSS media query lists.; source: [declared repository](https://github.com/csstools/postcss-plugins.git).
2. [@npmcli/query 6.0.0](https://www.npmjs.com/package/@npmcli/query) — npm query parser and tools; source: [declared repository](https://github.com/npm/query.git).
3. [media-query-parser 3.0.2](https://www.npmjs.com/package/media-query-parser) — Parse CSS media queries (spec-compliant); source: [declared repository](https://github.com/tbjgolden/media-query-parser.git).
4. [postcss-media-query-parser 0.2.3](https://www.npmjs.com/package/postcss-media-query-parser) — A tool for parsing media query lists.; source: [declared repository](https://github.com/dryoma/postcss-media-query-parser.git).
5. [error-stack-parser 2.1.4](https://www.npmjs.com/package/error-stack-parser) — Extract meaning from JS Errors; source: a repository is declared in registry metadata.
6. [@csstools/css-parser-algorithms 4.0.2](https://www.npmjs.com/package/@csstools/css-parser-algorithms) — Algorithms to help you parse CSS from an array of tokens.; source: [declared repository](https://github.com/csstools/postcss-plugins.git).
7. [@csstools/css-color-parser 4.2.6](https://www.npmjs.com/package/@csstools/css-color-parser) — Parse CSS color values; source: [declared repository](https://github.com/csstools/postcss-plugins.git).
8. [yaml-eslint-parser 2.1.0](https://www.npmjs.com/package/yaml-eslint-parser) — A YAML parser that produces output compatible with ESLint; source: [declared repository](https://github.com/ota-meshi/yaml-eslint-parser.git).
9. [svelte-eslint-parser 1.10.0](https://www.npmjs.com/package/svelte-eslint-parser) — Svelte parser for ESLint; source: [declared repository](https://github.com/sveltejs/svelte-eslint-parser.git).
10. [jsdoc-type-pratt-parser 9.4.0](https://www.npmjs.com/package/jsdoc-type-pratt-parser) — &#91;&#33;&#91;Npm Package&#93;(https://badgen.net/npm/v/jsdoc-type-pratt-parser)&#93;(https://www.npmjs.com/package/jsdoc-type-pratt-parser) &#91;&#33;&#91;Test Status&#93;(https://github.com/jsdoc-type-pratt-parser/jsdoc-type-pratt-parser/actions/workflows/test.yml/badge.svg?branch=main)&#93;; source: [declared repository](https://github.com/jsdoc-type-pratt-parser/jsdoc-type-pratt-parser.git).

npm refinement: `fetchxml` — first result list, up to 10 packages.

1. [@mohsinonxrm/pptb-fetchxml-studio 1.4.4](https://www.npmjs.com/package/@mohsinonxrm/pptb-fetchxml-studio) — A powerful, modern FetchXML query builder and data explorer for Microsoft Dataverse and Dynamics 365.; source: [declared repository](https://github.com/mohsinonxrm/pptb-mxrm-fetchxml-studio.git).
2. [pptb-forge-sql 1.1.1](https://www.npmjs.com/package/pptb-forge-sql) — Write and execute SQL against Dataverse — SELECT, INSERT, UPDATE, and DELETE. Translates to FetchXML and Web API calls.; source: [declared repository](https://github.com/broediger/pptb-forge-sql.git).
3. [@dataverse-kit/runtime 1.0.1](https://www.npmjs.com/package/@dataverse-kit/runtime) — Framework-agnostic runtime helpers for Dynamics 365 / Dataverse: FetchXML parser+builder+OData converter, ConditionEvaluator (business-rule AND/OR groups with 18 operators), and DirtyTracker (baseline dirty tracking with type coercion).; source: no repository declared in search metadata.
4. [fetchxml4js 1.0.5](https://www.npmjs.com/package/fetchxml4js) — A declarative JavaScript library for creating Dataverse fetchxml queries; source: [declared repository](https://github.com/kofrimpong/fetchxml4js.git).
5. [mcp-dataverse 0.7.10](https://www.npmjs.com/package/mcp-dataverse) — The most complete MCP server for Microsoft Dataverse. 81 production-ready tools for AI agents: OData &#38; FetchXML queries, CRUD, metadata, solutions, audit, batch operations, schema write, record access and more. Device code, client credentials, and managed; source: [declared repository](https://github.com/codeurali/mcp-dataverse.git).
6. [flayground 1.0.10](https://www.npmjs.com/package/flayground) — Flayground is a tool that allows for simple testing of fetchXml requests. It can be used by installing it with &#96;npm install flayground -g&#96; or by using &#96;npx flayground&#96;.; source: no repository declared in search metadata.
7. [fetchai 1.0.1](https://www.npmjs.com/package/fetchai) — AI fetchxml generator; source: no repository declared in search metadata.
8. [crmfetchkit 3.3.2](https://www.npmjs.com/package/crmfetchkit) — Library for Dynamics CRM that allows the execution of fetchxml-queries via JavaScript; source: a repository is declared in registry metadata.
9. [iconfont-parser 1.0.0](https://www.npmjs.com/package/iconfont-parser) — Transform iconfont symbol url to object data; source: a repository is declared in registry metadata.
10. [@dataverse-kit/portal-api-service 0.2.0](https://www.npmjs.com/package/@dataverse-kit/portal-api-service) — Power Pages portal (/&#95;api/) adapters for the workspace's Dataverse seams — PortalApiService (canonical IReadWriteApiService: CRUD + FetchXML + @odata.bind + $ref) and PortalSeamService (the create-app 6-method seam), sharing one hardened transport (anti-f; source: no repository declared in search metadata.

<a id="mirage-tds-sql"></a>

### TDS SQL parser, evaluation and wire protocol

Sources: [mirage/lib/dataverse-tds.mjs](../mirage/lib/dataverse-tds.mjs), [mirage/lib/dataverse-tds-sql-parser.mjs](../mirage/lib/dataverse-tds-sql-parser.mjs), [mirage/lib/dataverse-tds-sql-eval.mjs](../mirage/lib/dataverse-tds-sql-eval.mjs), [mirage/lib/dataverse-tds-protocol.mjs](../mirage/lib/dataverse-tds-protocol.mjs).

GitHub: `TDS SQL parser in:name,description,readme` — page 1, up to 10 results.

1. [denisenkom/go-mssqldb](https://github.com/denisenkom/go-mssqldb)
2. [MindFlavor/TDSBridge](https://github.com/MindFlavor/TDSBridge) — archived
3. [lgandx/PCredz](https://github.com/lgandx/PCredz)
4. [skahwah/SQLRecon](https://github.com/skahwah/SQLRecon)
5. [gridex/gridex](https://github.com/gridex/gridex)
6. [veloxbase/veloxdb](https://github.com/veloxbase/veloxdb)
7. [tediousjs/node-mssql](https://github.com/tediousjs/node-mssql)
8. [unruledboy/DatabaseStack](https://github.com/unruledboy/DatabaseStack)
9. [r2dbc/r2dbc-mssql](https://github.com/r2dbc/r2dbc-mssql)
10. [defragmentator/mitmsqlproxy](https://github.com/defragmentator/mitmsqlproxy)

npm: `tds sql parser` — first registry result list, up to 10 packages.

1. [tedious 20.3.8](https://www.npmjs.com/package/tedious) — A TDS driver, for connecting to MS SQLServer databases.; source: [declared repository](https://github.com/tediousjs/tedious.git).
2. [node-sql-parser 5.4.0](https://www.npmjs.com/package/node-sql-parser) — simple node sql parser; source: [declared repository](https://github.com/taozhi8833998/node-sql-parser.git).
3. [mssql 12.7.13](https://www.npmjs.com/package/mssql) — Microsoft SQL Server client for Node.js.; source: [declared repository](https://github.com/tediousjs/node-mssql.git).
4. [pgsql-ast-parser 12.0.2](https://www.npmjs.com/package/pgsql-ast-parser) — Yet another simple Postgres SQL parser/modifier; source: [declared repository](https://github.com/oguimbal/pgsql-ast-parser.git).
5. [is-unsafe 2.0.2](https://www.npmjs.com/package/is-unsafe) — Zero-dependency, DOM-free, pure predicate for detecting unsafe strings across HTML, XML, SVG, SQL, SHELL, and REGEX contexts; source: [declared repository](https://github.com/NaturalIntelligence/is-unsafe.git).
6. [@statsig/tedious 0.1.0](https://www.npmjs.com/package/@statsig/tedious) — A fork of tedious that supports Fabric OBO auth user impersonation; source: [declared repository](https://github.com/statsig-io/tedious.git).
7. [pgsql-parser 18.3.1](https://www.npmjs.com/package/pgsql-parser) — The real PostgreSQL query parser; source: [declared repository](https://github.com/constructive-io/pgsql-parser.git).
8. [pgsql-deparser 18.4.1](https://www.npmjs.com/package/pgsql-deparser) — PostgreSQL AST Deparser; source: [declared repository](https://github.com/constructive-io/pgsql-parser.git).
9. [plpgsql-parser 18.6.1](https://www.npmjs.com/package/plpgsql-parser) — Combined SQL + PL/pgSQL parser with hydrated ASTs and transform API; source: [declared repository](https://github.com/constructive-io/pgsql-parser.git).
10. [prettier-plugin-sql 0.20.0](https://www.npmjs.com/package/prettier-plugin-sql) — An opinionated sql formatter plugin for Prettier; source: [declared repository](https://github.com/un-ts/prettier.git).

<a id="mirage-organization-service"></a>

### SOAP Organization Service and SDK query contracts

Sources: [mirage/lib/dataverse-soap.mjs](../mirage/lib/dataverse-soap.mjs), [mirage/lib/dataverse-soap-query.mjs](../mirage/lib/dataverse-soap-query.mjs), [mirage/lib/local-organization-service.mjs](../mirage/lib/local-organization-service.mjs), [mirage/lib/plugin-sdk-query.mjs](../mirage/lib/plugin-sdk-query.mjs).

GitHub: `Dataverse OrganizationService mock in:name,description,readme` — page 1, up to 10 results.

1. [cloud-awesome/dataverse-simulate](https://github.com/cloud-awesome/dataverse-simulate)
2. [mohsinonxrm/dataverse-sdk-typescript](https://github.com/mohsinonxrm/dataverse-sdk-typescript)
3. [nzkelvin/fake-dataverse-easy](https://github.com/nzkelvin/fake-dataverse-easy)

npm: `dataverse organization service mock` — first registry result list, up to 10 packages.

1. [msw 3.0.3](https://www.npmjs.com/package/msw) — The industry standard for API mocking in JavaScript.; source: [declared repository](https://github.com/mswjs/msw.git).
2. [kinesis-local 0.6.2](https://www.npmjs.com/package/kinesis-local) — A Mock API for AWS Kinesis; source: [declared repository](https://github.com/etspaceman/kinesis-mock.git).
3. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
4. [jest-canvas-mock 2.5.8](https://www.npmjs.com/package/jest-canvas-mock) — Mock a canvas in your jest tests.; source: [declared repository](https://github.com/hustcc/jest-canvas-mock.git).
5. [aws-sdk-client-mock 4.1.0](https://www.npmjs.com/package/aws-sdk-client-mock) — Easy and powerful mocking of AWS SDK v3 Clients; source: [declared repository](https://github.com/m-radzikowski/aws-sdk-client-mock.git).
6. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
7. [axios-mock-adapter 2.1.0](https://www.npmjs.com/package/axios-mock-adapter) — Axios adapter that allows to easily mock requests; source: [declared repository](https://github.com/ctimmerm/axios-mock-adapter.git).
8. [oci-osuborganizationsubscription 2.144.0](https://www.npmjs.com/package/oci-osuborganizationsubscription) — OCI NodeJS client for Osub Organization Subscription Service; source: [declared repository](https://github.com/oracle/oci-typescript-sdk.git).
9. [vitest-websocket-mock 0.8.0](https://www.npmjs.com/package/vitest-websocket-mock) — Mock websockets and assert complex websocket interactions with Vitest; source: [declared repository](https://github.com/akiomik/vitest-websocket-mock.git).
10. [@medplum/mock 5.2.9](https://www.npmjs.com/package/@medplum/mock) — Medplum Mock Client; source: [declared repository](https://github.com/medplum/medplum.git).

<a id="mirage-exact-numerics"></a>

### Exact numeric types, decimal arithmetic and lossless JSON

Sources: [mirage/lib/exact-numeric.mjs](../mirage/lib/exact-numeric.mjs), [mirage/lib/dataverse-decimal-input.mjs](../mirage/lib/dataverse-decimal-input.mjs), [mirage/lib/dataverse-scalar-reader.mjs](../mirage/lib/dataverse-scalar-reader.mjs).

GitHub: `lossless JSON decimal in:name,description,readme` — page 1, up to 10 results.

1. [abodelot/jquery.json-viewer](https://github.com/abodelot/jquery.json-viewer)
2. [josdejong/lossless-json](https://github.com/josdejong/lossless-json)
3. [mapbox/geobuf](https://github.com/mapbox/geobuf)
4. [simdjson/simdjson](https://github.com/simdjson/simdjson)
5. [lantanagroup/FHIR.js](https://github.com/lantanagroup/FHIR.js)
6. [pygeobuf/pygeobuf](https://github.com/pygeobuf/pygeobuf)
7. [exasol/database-migration](https://github.com/exasol/database-migration)
8. [toon-format/toon-python](https://github.com/toon-format/toon-python)
9. [HL7/fhirpath.js](https://github.com/HL7/fhirpath.js)
10. [kdl-org/kdl](https://github.com/kdl-org/kdl)

npm: `lossless json decimal bigint` — first registry result list, up to 10 packages.

1. [lossless-json 4.3.3](https://www.npmjs.com/package/lossless-json) — Parse JSON without risk of losing numeric information; source: [declared repository](https://github.com/josdejong/lossless-json.git).
2. [json-bigint 1.0.0](https://www.npmjs.com/package/json-bigint) — JSON.parse with bigints support; source: a repository is declared in registry metadata.
3. [json-with-bigint 3.5.12](https://www.npmjs.com/package/json-with-bigint) — JS library that allows you to easily serialize and deserialize data with BigInt values; source: [declared repository](https://github.com/Ivan-Korolenko/json-with-bigint.git).
4. [safe-stable-stringify 3.0.0](https://www.npmjs.com/package/safe-stable-stringify) — Deterministic and safely JSON.stringify to quickly serialize JavaScript objects; source: [declared repository](https://github.com/BridgeAR/safe-stable-stringify.git).
5. [@apimatic/json-bigint 1.2.0](https://www.npmjs.com/package/@apimatic/json-bigint) — JSON.parse with bigints support; source: a repository is declared in registry metadata.
6. [is-bigint 1.1.0](https://www.npmjs.com/package/is-bigint) — Is this value an ES BigInt?; source: [declared repository](https://github.com/inspect-js/is-bigint.git).
7. [json-stable-stringify-without-jsonify 1.0.1](https://www.npmjs.com/package/json-stable-stringify-without-jsonify) — deterministic JSON.stringify() with custom sorting to get deterministic hashes from stringified results, with no public domain dependencies; source: a repository is declared in registry metadata.
8. [fast-json-stable-stringify 2.1.0](https://www.npmjs.com/package/fast-json-stable-stringify) — deterministic &#96;JSON.stringify()&#96; - a faster version of substack's json-stable-strigify without jsonify; source: a repository is declared in registry metadata.
9. [fraction.js 5.3.4](https://www.npmjs.com/package/fraction.js) — The RAW rational numbers library; source: a repository is declared in registry metadata.
10. [json-bigint-patch 0.0.9](https://www.npmjs.com/package/json-bigint-patch) — JSON.parse with bigints support; source: a repository is declared in registry metadata.

<a id="mirage-typed-values"></a>

### Dataverse GUIDs, typed comparison, collation and formatting

Sources: [mirage/lib/dataverse-values.mjs](../mirage/lib/dataverse-values.mjs), [mirage/lib/dataverse-text-value.mjs](../mirage/lib/dataverse-text-value.mjs), [mirage/lib/webapi-format.mjs](../mirage/lib/webapi-format.mjs).

GitHub: `Dataverse formatted values in:name,description,readme` — page 1, up to 10 results.

1. [UpstageAI/dataverse](https://github.com/UpstageAI/dataverse) — archived
2. [mims-harvard/PrimeKG](https://github.com/mims-harvard/PrimeKG)
3. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)
4. [IQSS/dataverse-client-r](https://github.com/IQSS/dataverse-client-r)
5. [microsoft/PowerPlatform-DataverseClient-Python](https://github.com/microsoft/PowerPlatform-DataverseClient-Python)
6. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
7. [gdcc/easyDataverse](https://github.com/gdcc/easyDataverse)
8. [rkneela0912/SmartBrief](https://github.com/rkneela0912/SmartBrief)
9. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
10. [mims-harvard/ClinVec](https://github.com/mims-harvard/ClinVec)

Refinement: `"Dataverse" "formatted values" in:readme` — page 1, up to 10 results.

1. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)
2. [mohsinonxrm/pptb-mxrm-fetchxml-studio](https://github.com/mohsinonxrm/pptb-mxrm-fetchxml-studio)
3. [microsoft/cat-agent-skills](https://github.com/microsoft/cat-agent-skills)
4. [rsousa88/DataMigrationTool](https://github.com/rsousa88/DataMigrationTool)
5. [jaduplesms/PCF-Workbench](https://github.com/jaduplesms/PCF-Workbench)
6. [AMSoftwareNL/DataversePowershell](https://github.com/AMSoftwareNL/DataversePowershell)
7. [Mosh-K/XrmTypeScript](https://github.com/Mosh-K/XrmTypeScript)
8. [brunsdon/dataverse-query-examples](https://github.com/brunsdon/dataverse-query-examples)
9. [sbroenne/dvq](https://github.com/sbroenne/dvq)
10. [emerbrito/dataverse-extensions-data](https://github.com/emerbrito/dataverse-extensions-data)

npm: `dataverse formatted values` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [vega-format 2.1.3](https://www.npmjs.com/package/vega-format) — JavaScript string formatting utilities for Vega.; source: [declared repository](https://github.com/vega/vega.git).
3. [concordance 5.0.4](https://www.npmjs.com/package/concordance) — Compare, format, diff and serialize any JavaScript value; source: [declared repository](https://github.com/concordancejs/concordance.git).
4. [json-with-bigint 3.5.12](https://www.npmjs.com/package/json-with-bigint) — JS library that allows you to easily serialize and deserialize data with BigInt values; source: [declared repository](https://github.com/Ivan-Korolenko/json-with-bigint.git).
5. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
6. [@npmcli/config 11.2.0](https://www.npmjs.com/package/@npmcli/config) — Configuration management for the npm cli; source: [declared repository](https://github.com/npm/cli.git).
7. [@tekstack/client-data-model 1.0.101](https://www.npmjs.com/package/@tekstack/client-data-model) — TekStack client-side Dataverse data model for TypeScript projects.; source: no repository declared in search metadata.
8. [@theatre/dataverse 0.7.2](https://www.npmjs.com/package/@theatre/dataverse) — No description; source: [declared repository](https://github.com/AriaMinaei/theatre).
9. [fault 2.0.1](https://www.npmjs.com/package/fault) — Functional errors with formatted output; source: [declared repository](https://github.com/wooorm/fault.git).
10. [has-values 2.0.1](https://www.npmjs.com/package/has-values) — Returns true if any values exist, false if empty. Works for booleans, functions, numbers, strings, nulls, objects and arrays. ; source: [declared repository](https://github.com/jonschlinkert/has-values.git).

<a id="mirage-calendar-time"></a>

### Calendar dates, time zones, fiscal periods and recurrence

Sources: [mirage/lib/dataverse-values.mjs](../mirage/lib/dataverse-values.mjs), [mirage/lib/formatted-time-zone.mjs](../mirage/lib/formatted-time-zone.mjs), [mirage/lib/windows-time-zones.mjs](../mirage/lib/windows-time-zones.mjs), [mirage/lib/flow-triggers.mjs](../mirage/lib/flow-triggers.mjs).

GitHub: `Windows IANA recurrence in:name,description,readme` — page 1, up to 10 results.

1. [u01jmg3/ics-parser](https://github.com/u01jmg3/ics-parser)
2. [jens-maus/node-ical](https://github.com/jens-maus/node-ical)
3. [aluxnimm/outlookcaldavsynchronizer](https://github.com/aluxnimm/outlookcaldavsynchronizer)
4. [jfversluis/Plugin.Maui.CalendarStore](https://github.com/jfversluis/Plugin.Maui.CalendarStore)
5. [pedrofuentes/stream-deck-ical](https://github.com/pedrofuentes/stream-deck-ical)
6. [FradSer/event](https://github.com/FradSer/event)
7. [aldinokemal/go-whatsapp-web-multidevice](https://github.com/aldinokemal/go-whatsapp-web-multidevice)
8. [jperelli/Redmine-Periodic-Task](https://github.com/jperelli/Redmine-Periodic-Task)
9. [titanwings/dsh-automation](https://github.com/titanwings/dsh-automation)
10. [Kloudless/meeting-scheduler](https://github.com/Kloudless/meeting-scheduler) — archived

Refinement: `"timezone" "recurrence" in:name,description` — page 1, up to 10 results.

1. [CodeLeom/simple-ics-calendar](https://github.com/CodeLeom/simple-ics-calendar)
2. [aamirtechs/calwright](https://github.com/aamirtechs/calwright)
3. [huangjie666777-ux/recurrence-scheduler-016](https://github.com/huangjie666777-ux/recurrence-scheduler-016)
4. [william-coulter/ical4j-timezone-recurrence-bug](https://github.com/william-coulter/ical4j-timezone-recurrence-bug)
5. [gritse/TickTickSharp](https://github.com/gritse/TickTickSharp)
6. [yannallain/rrule-kmp](https://github.com/yannallain/rrule-kmp)
7. [target/create-meeting-issue](https://github.com/target/create-meeting-issue)
8. [mcdougald/remind.me.at](https://github.com/mcdougald/remind.me.at)
9. [linked-cm/calendar](https://github.com/linked-cm/calendar)
10. [Doryski/quickurrence](https://github.com/Doryski/quickurrence)

npm: `windows iana timezone recurrence` — first registry result list, up to 10 packages.

1. [moment-timezone 0.6.5](https://www.npmjs.com/package/moment-timezone) — Parse and display moments in any timezone.; source: [declared repository](https://github.com/moment/moment-timezone.git).
2. [timezone-soft 1.7.0](https://www.npmjs.com/package/timezone-soft) — informal timezone lookup; source: a repository is declared in registry metadata.
3. [@vvo/tzdb 6.201.1](https://www.npmjs.com/package/@vvo/tzdb) — Always up to date list of IANA time zones for time zone pickers, with major cities, current offsets, DST abbreviations and the country of any time zone; source: [declared repository](https://github.com/vvo/tzdb.git).
4. [@js-joda/timezone 3.1.0](https://www.npmjs.com/package/@js-joda/timezone) — iana tzdb timezone bindings for js-joda; source: [declared repository](https://github.com/js-joda/js-joda.git).
5. [windows-iana 5.1.0](https://www.npmjs.com/package/windows-iana) — A small tool to convert between Windows time zones and IANA; source: [declared repository](https://github.com/rubenillodo/windows-iana.git).
6. [language-subtag-registry 0.4.2](https://www.npmjs.com/package/language-subtag-registry) — Full BCP 47 language subtag data from the official IANA repository, in JSON format with multiple indices.; source: [declared repository](https://github.com/mattcg/language-subtag-registry.git).
7. [dayjs-timezone-iana-plugin 0.2.0](https://www.npmjs.com/package/dayjs-timezone-iana-plugin) — DayJS timezone plugin alternative to manage DST correctly; source: [declared repository](https://github.com/carboneio/dayjs-timezone-iana-plugin.git).
8. [language-tags 2.1.0](https://www.npmjs.com/package/language-tags) — Work with IANA language tags.; source: a repository is declared in registry metadata.
9. [iana-tz-data 2019.1.0](https://www.npmjs.com/package/iana-tz-data) — Npm module for IANA unofficial JSON data; source: a repository is declared in registry metadata.
10. [rails-timezone 1.2.0](https://www.npmjs.com/package/rails-timezone) — Convert between Rails ActiveSupport TimeZone names and the IANA Time Zone Database format for node.js and the browser; source: a repository is declared in registry metadata.

<a id="mirage-solution-import"></a>

### Solution XML/YAML import, component inventory and source graphs

Sources: [mirage/lib/solution-schema.mjs](../mirage/lib/solution-schema.mjs), [mirage/lib/solution-inventory.mjs](../mirage/lib/solution-inventory.mjs), [mirage/lib/solution-yaml.mjs](../mirage/lib/solution-yaml.mjs), [mirage/lib/source-graph.mjs](../mirage/lib/source-graph.mjs).

GitHub: `"Power Platform" solution parser in:name,description,readme` — page 1, up to 10 results.

1. [demianrasko/Dynamics-365-Workflow-Tools](https://github.com/demianrasko/Dynamics-365-Workflow-Tools)
2. [microsoft/agent-for-rfp-response-solution-accelerator](https://github.com/microsoft/agent-for-rfp-response-solution-accelerator) — archived
3. [PowerAppsDarren/PowerFxSnippets](https://github.com/PowerAppsDarren/PowerFxSnippets)
4. [mathyousee/power-platform-chatGPT](https://github.com/mathyousee/power-platform-chatGPT)
5. [Laskewitz/Power-Platform-Control-Hub](https://github.com/Laskewitz/Power-Platform-Control-Hub)
6. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
7. [sabrish/power-platform-solution-blueprint](https://github.com/sabrish/power-platform-solution-blueprint)
8. [microsoft/copilot-studio-gallery](https://github.com/microsoft/copilot-studio-gallery)
9. [phuocle/Dynamics-Crm-DevKit](https://github.com/phuocle/Dynamics-Crm-DevKit)
10. [microsoft/knowledge-extraction-recipes-forms](https://github.com/microsoft/knowledge-extraction-recipes-forms) — archived

npm: `power platform solution parser` — first registry result list, up to 10 packages.

1. [cssom 0.5.0](https://www.npmjs.com/package/cssom) — CSS Object Model implementation and CSS parser; source: [declared repository](https://github.com/NV/CSSOM.git).
2. [@hey-api/json-schema-ref-parser 1.4.4](https://www.npmjs.com/package/@hey-api/json-schema-ref-parser) — Parse, Resolve, and Dereference JSON Schema $ref pointers; source: [declared repository](https://github.com/hey-api/hey-api.git).
3. [url-parse 1.5.10](https://www.npmjs.com/package/url-parse) — Small footprint URL parser that works seamlessly across Node.js and browser environments; source: [declared repository](https://github.com/unshiftio/url-parse.git).
4. [rrweb-cssom 0.8.0](https://www.npmjs.com/package/rrweb-cssom) — CSS Object Model implementation and CSS parser; source: [declared repository](https://github.com/rrweb-io/CSSOM.git).
5. [@acemir/cssom 0.9.32](https://www.npmjs.com/package/@acemir/cssom) — CSS Object Model implementation and CSS parser; source: [declared repository](https://github.com/acemir/CSSOM.git).
6. [cross-env 10.1.0](https://www.npmjs.com/package/cross-env) — Run scripts that set and use environment variables across platforms; source: [declared repository](https://github.com/kentcdodds/cross-env.git).
7. [@babel/parser 8.0.8](https://www.npmjs.com/package/@babel/parser) — A JavaScript parser; source: [declared repository](https://github.com/babel/babel.git).
8. [yargs-parser 22.0.0](https://www.npmjs.com/package/yargs-parser) — the mighty option parser used by yargs; source: [declared repository](https://github.com/yargs/yargs-parser.git).
9. [@typescript-eslint/parser 8.72.1](https://www.npmjs.com/package/@typescript-eslint/parser) — An ESLint custom parser which leverages TypeScript ESTree; source: [declared repository](https://github.com/typescript-eslint/typescript-eslint.git).
10. [libpg-query 18.2.1](https://www.npmjs.com/package/libpg-query) — The real PostgreSQL query parser; source: a repository is declared in registry metadata.

<a id="mirage-metadata-api"></a>

### Dataverse metadata API, CSDL and customization messages

Sources: [mirage/lib/dataverse-metadata.mjs](../mirage/lib/dataverse-metadata.mjs), [mirage/lib/dataverse-metadata-messages.mjs](../mirage/lib/dataverse-metadata-messages.mjs), [mirage/lib/dataverse-customization-messages.mjs](../mirage/lib/dataverse-customization-messages.mjs).

GitHub: `Dataverse metadata CSDL in:name,description,readme` — page 1, up to 10 results.

1. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)
2. [mohsinonxrm/pptb-mxrm-dataverse-request-studio](https://github.com/mohsinonxrm/pptb-mxrm-dataverse-request-studio)
3. [marefati110/n8n-nodes-dynamics365](https://github.com/marefati110/n8n-nodes-dynamics365)
4. [jhonsferg/traverse](https://github.com/jhonsferg/traverse)
5. [zuhdil/igh-data-sync](https://github.com/zuhdil/igh-data-sync)
6. [akvo/igh-data-sync](https://github.com/akvo/igh-data-sync)
7. [jobin-varghese-sydney/pptb-mxrm-dataverse-request-studio](https://github.com/jobin-varghese-sydney/pptb-mxrm-dataverse-request-studio)
8. [epikur-io/traverse](https://github.com/epikur-io/traverse)
9. [snykgit009/dynamics-web-api](https://github.com/snykgit009/dynamics-web-api)
10. [djwmobley/dataverse-linter](https://github.com/djwmobley/dataverse-linter)

npm: `dataverse metadata csdl` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [@odata/metadata 0.2.8](https://www.npmjs.com/package/@odata/metadata) — OData(V4) Metadata Utilities; source: [declared repository](https://github.com/Soontao/odata-v4-metadata.git).
3. [gcp-metadata 9.2.2](https://www.npmjs.com/package/gcp-metadata) — Get the metadata from a Google Cloud Platform environment; source: [declared repository](https://github.com/googleapis/google-cloud-node.git).
4. [reflect-metadata 0.2.2](https://www.npmjs.com/package/reflect-metadata) — Polyfill for Metadata Reflection API; source: [declared repository](https://github.com/rbuckton/reflect-metadata.git).
5. [odata-csdl 0.11.2](https://www.npmjs.com/package/odata-csdl) — Convert CSDL XML to CSDL JSON; source: [declared repository](https://github.com/oasis-tcs/odata-csdl-schemas.git).
6. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
7. [@reso-standards/reso-metadata-utils 0.1.4](https://www.npmjs.com/package/@reso-standards/reso-metadata-utils) — RESO OData metadata processing utilities — CSDL parse, validate (CSDL/XSD), serialize (EDMX → report), and metadata fetching. The deps-requiring side of the RESO metadata split; sibling to reso-common's zero-dep model.; source: [declared repository](https://github.com/RESOStandards/reso-tools.git).
8. [babel-plugin-transform-typescript-metadata 0.4.0](https://www.npmjs.com/package/babel-plugin-transform-typescript-metadata) — Babel plugin to emit decorator metadata like typescript compiler; source: [declared repository](https://github.com/leonardfactory/babel-plugin-transform-typescript-metadata.git).
9. [@inversifyjs/reflect-metadata-utils 1.5.0](https://www.npmjs.com/package/@inversifyjs/reflect-metadata-utils) — Reflect metadata utils; source: [declared repository](https://github.com/inversify/monorepo.git).
10. [@pptb/types 1.2.7](https://www.npmjs.com/package/@pptb/types) — Type definitions for Power Platform ToolBox APIs and validity checks for tool packages; source: [declared repository](https://github.com/PowerPlatformToolBox/desktop-app.git).

<a id="mirage-record-validation"></a>

### Record validation, alternate keys, relationships and cascading operations

Sources: [mirage/lib/dataverse-records.mjs](../mirage/lib/dataverse-records.mjs), [mirage/lib/schema-validation.mjs](../mirage/lib/schema-validation.mjs), [mirage/lib/dataverse-cascade.mjs](../mirage/lib/dataverse-cascade.mjs), [mirage/lib/dataverse-record-messages.mjs](../mirage/lib/dataverse-record-messages.mjs).

GitHub: `Dataverse validation cascade in:name,description,readme` — page 1, up to 10 results.

1. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
2. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
3. [fernandoartalf/AL-Copilot-Skills-Collection](https://github.com/fernandoartalf/AL-Copilot-Skills-Collection)
4. [smartin98/Global_DL_SSH](https://github.com/smartin98/Global_DL_SSH)
5. [Power-Maverick/PPTB-Tools](https://github.com/Power-Maverick/PPTB-Tools)
6. [mscottsewell/CascadeFields](https://github.com/mscottsewell/CascadeFields)
7. [ai-boost/awesome-harness-engineering](https://github.com/ai-boost/awesome-harness-engineering)
8. [TALXIS/platform-metadata](https://github.com/TALXIS/platform-metadata)
9. [TarogStar/DataverseFakes](https://github.com/TarogStar/DataverseFakes)
10. [qcase-lab/sbom-attack-chain-prediction](https://github.com/qcase-lab/sbom-attack-chain-prediction)

npm: `dataverse schema validation` — first registry result list, up to 10 packages.

1. [@hookform/resolvers 6.0.2](https://www.npmjs.com/package/@hookform/resolvers) — React Hook Form validation resolvers: Yup, Joi, Superstruct, Zod, Vest, Class Validator, io-ts, Nope, computed-types, TypeBox, arktype, Typanion, Effect-TS and VineJS; source: [declared repository](https://github.com/react-hook-form/resolvers.git).
2. [@eslint/object-schema 3.0.5](https://www.npmjs.com/package/@eslint/object-schema) — An object schema merger/validator; source: [declared repository](https://github.com/eslint/rewrite.git).
3. [json-schema-typed 9.0.0](https://www.npmjs.com/package/json-schema-typed) — JSON Schema TypeScript definitions with complete inline documentation.; source: [declared repository](https://github.com/RemyRylan/json-schema-typed.git).
4. [@valibot/to-json-schema 1.8.0](https://www.npmjs.com/package/@valibot/to-json-schema) — The official JSON schema converter for Valibot; source: [declared repository](https://github.com/open-circle/valibot.git).
5. [tv4 1.3.0](https://www.npmjs.com/package/tv4) — A public domain JSON Schema validator for JavaScript; source: [declared repository](https://github.com/geraintluff/tv4.git).
6. [zod-validation-error 5.0.0](https://www.npmjs.com/package/zod-validation-error) — Wrap zod validation errors in user-friendly readable messages; source: a repository is declared in registry metadata.
7. [@standard-community/standard-json 0.3.7](https://www.npmjs.com/package/@standard-community/standard-json) — &#91;&#33;&#91;npm version&#93;(https://img.shields.io/npm/v/@standard-community/standard-json.svg)&#93;(https://npmjs.org/package/@standard-community/standard-json "View this project on NPM") &#91;&#33;&#91;npm downloads&#93;(https://img.shields.io/npm/dm/@standard-community/standard-json); source: [declared repository](https://github.com/standard-community/standard-json.git).
8. [zod 4.6.7](https://www.npmjs.com/package/zod) — TypeScript-first schema declaration and validation library with static type inference; source: [declared repository](https://github.com/colinhacks/zod.git).
9. [@standard-schema/utils 0.3.0](https://www.npmjs.com/package/@standard-schema/utils) — The official runtime utils for Standard Schema; source: [declared repository](https://github.com/standard-schema/standard-schema.git).
10. [@expo/schema-utils 58.0.2](https://www.npmjs.com/package/@expo/schema-utils) — Reusable JSON Schema (Draft 04) validation library for Expo; source: [declared repository](https://github.com/expo/expo.git).

<a id="mirage-atomic-transactions"></a>

### Atomic transactions, batch changesets and committed event work

Sources: [mirage/lib/row-transaction.mjs](../mirage/lib/row-transaction.mjs), [mirage/lib/dataverse-batch.mjs](../mirage/lib/dataverse-batch.mjs), [mirage/lib/dataverse-transaction-context.mjs](../mirage/lib/dataverse-transaction-context.mjs), [mirage/lib/committed-work.mjs](../mirage/lib/committed-work.mjs).

GitHub: `OData batch changeset in:name,description,readme` — page 1, up to 10 results.

1. [saintsystems/odata-client-php](https://github.com/saintsystems/odata-client-php)
2. [andrewconnell/sp-o365-rest](https://github.com/andrewconnell/sp-o365-rest)
3. [SAP-archive/C4CODATAAPIDEVGUIDE](https://github.com/SAP-archive/C4CODATAAPIDEVGUIDE) — archived
4. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)
5. [XRM-OSS/Xrm-WebApi-Client](https://github.com/XRM-OSS/Xrm-WebApi-Client)
6. [cap-js-community/odata-v2-adapter](https://github.com/cap-js-community/odata-v2-adapter)
7. [microsoft/PowerPlatform-DataverseClient-Python](https://github.com/microsoft/PowerPlatform-DataverseClient-Python)
8. [TALXIS/tools-cli](https://github.com/TALXIS/tools-cli)
9. [panoramicdata/PanoramicData.OData.Client](https://github.com/panoramicdata/PanoramicData.OData.Client)
10. [fsans/fms-odata-js](https://github.com/fsans/fms-odata-js)

npm: `odata batch changeset transaction` — first registry result list, up to 10 packages.

1. [prosemirror-changeset 2.4.4](https://www.npmjs.com/package/prosemirror-changeset) — Distills a series of editing steps into deleted and added ranges; source: [declared repository](https://code.haverbeke.berlin/prosemirror/prosemirror-changeset.git).
2. [odata-batch 3.1.0](https://www.npmjs.com/package/odata-batch) — Build and parse OData V2 $batch multipart requests: multiple changesets, per-response error detection and typed results; source: [declared repository](https://github.com/chiptime/odata-batch.git).
3. [@sap/xsodata 8.4.2](https://www.npmjs.com/package/@sap/xsodata) — Expose data from a HANA database as OData V2 service with help of .xsodata files.; source: no repository declared in search metadata.
4. [@changesets/parse 1.0.0](https://www.npmjs.com/package/@changesets/parse) — Parse a changeset file's contents into a usable json object; source: [declared repository](https://github.com/changesets/changesets.git).
5. [simple-odata-server 1.2.2](https://www.npmjs.com/package/simple-odata-server) — OData server with adapter for mongodb and nedb; source: [declared repository](https://github.com/pofider/node-simple-odata-server.git).
6. [odata-v4-inmemory 0.1.7](https://www.npmjs.com/package/odata-v4-inmemory) — Service OData requests from an inmemory data store; source: [declared repository](https://github.com/jaystack/odata-v4-inmemory.git).
7. [@odata2ts/http-client-api 0.7.1](https://www.npmjs.com/package/@odata2ts/http-client-api) — Specifies the contract between HTTP clients and odata2ts; source: a repository is declared in registry metadata.
8. [@odata/parser 0.2.14](https://www.npmjs.com/package/@odata/parser) — OData(V4) Parser; source: [declared repository](https://github.com/Soontao/odata-v4-parser.git).
9. [@odata2ts/http-client-base 0.7.1](https://www.npmjs.com/package/@odata2ts/http-client-base) — Core functionality for odata2ts HTTP clients; source: a repository is declared in registry metadata.
10. [@odata/metadata 0.2.8](https://www.npmjs.com/package/@odata/metadata) — OData(V4) Metadata Utilities; source: [declared repository](https://github.com/Soontao/odata-v4-metadata.git).

<a id="mirage-organization-security"></a>

### Organization roles, teams, ownership and impersonation

Sources: [mirage/lib/dataverse-security.mjs](../mirage/lib/dataverse-security.mjs), [mirage/lib/dataverse-principal-context.mjs](../mirage/lib/dataverse-principal-context.mjs), [mirage/lib/dataverse-security-messages.mjs](../mirage/lib/dataverse-security-messages.mjs).

GitHub: `Dataverse security impersonation in:name,description,readme` — page 1, up to 10 results.

1. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
2. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
3. [o365soa/soa](https://github.com/o365soa/soa)
4. [Roelzz/mcs-agent-analyser](https://github.com/Roelzz/mcs-agent-analyser)
5. [TALXIS/tools-devkit-templates](https://github.com/TALXIS/tools-devkit-templates)
6. [Power-Platform-DevOps/Power-Platform-ALM-Starter-Kit](https://github.com/Power-Platform-DevOps/Power-Platform-ALM-Starter-Kit) — archived
7. [qmatteoq/copilotstudio-feedback](https://github.com/qmatteoq/copilotstudio-feedback)
8. [SweetsNSavories/VerseOps](https://github.com/SweetsNSavories/VerseOps)
9. [mohsinonxrm/pptb-mxrm-fetchxml-studio](https://github.com/mohsinonxrm/pptb-mxrm-fetchxml-studio)
10. [VincentChuWaiChow/vanguard-frontier-agentic](https://github.com/VincentChuWaiChow/vanguard-frontier-agentic)

npm: `dataverse security permissions` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [@quarterzip.ai/sdk 1.1.2](https://www.npmjs.com/package/@quarterzip.ai/sdk) — Quarterzip embeddable conversational agent SDK.; source: no repository declared in search metadata.
3. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
4. [dataverse-auth 1.0.9](https://www.npmjs.com/package/dataverse-auth) — Performs on-behalf-of auth against a Microsoft Dataverse envrionment. Stores the token a local token for use in other NodeJS applications.; source: no repository declared in search metadata.
5. [mgwdev-m365-components 0.1.3](https://www.npmjs.com/package/mgwdev-m365-components) — React components and helpers for building SharePoint, Microsoft Graph, and Dataverse experiences in Microsoft 365 apps.; source: [declared repository](https://github.com/mgwojciech/mgwdev-m365-components.git).
6. [paqvilo 0.9.7](https://www.npmjs.com/package/paqvilo) — Local-first, pro-code tools for Microsoft Power Pages: live source previews with Lense, Liquid and Dataverse simulation with Mirage.; source: [declared repository](https://github.com/maksii/paqvilo.git); this package, excluded as a candidate.
7. [@backstage/plugin-permission-common 0.9.12](https://www.npmjs.com/package/@backstage/plugin-permission-common) — Isomorphic types and client for Backstage permissions and authorization; source: [declared repository](https://github.com/backstage/backstage).
8. [@aws-sdk/client-iam 3.1158.0](https://www.npmjs.com/package/@aws-sdk/client-iam) — AWS SDK for JavaScript Iam Client for Node.js, Browser and React Native; source: [declared repository](https://github.com/aws/aws-sdk-js-v3.git).
9. [@tekstack/client-data-model 1.0.101](https://www.npmjs.com/package/@tekstack/client-data-model) — TekStack client-side Dataverse data model for TypeScript projects.; source: no repository declared in search metadata.
10. [helmet 8.3.0](https://www.npmjs.com/package/helmet) — help secure Express/Connect apps with various HTTP headers; source: a repository is declared in registry metadata.

<a id="mirage-portal-authorization"></a>

### Field-level security and portal table/page authorization

Sources: [mirage/lib/dataverse-fls.mjs](../mirage/lib/dataverse-fls.mjs), [mirage/lib/permissions.mjs](../mirage/lib/permissions.mjs), [mirage/lib/portal-authorization.mjs](../mirage/lib/portal-authorization.mjs), [mirage/lib/page-access.mjs](../mirage/lib/page-access.mjs).

GitHub: `"Power Pages" permissions in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills)
2. [mbrg/power-pwn](https://github.com/mbrg/power-pwn)
3. [amervitz/xRM-Portals-Community-Edition](https://github.com/amervitz/xRM-Portals-Community-Edition)
4. [microsoft/PowerBI-Icons](https://github.com/microsoft/PowerBI-Icons) — archived
5. [microsoft/contoso-real-estate-power-platform](https://github.com/microsoft/contoso-real-estate-power-platform)
6. [OOlashyn/PowerAppsPortalSiteSettingsAndSnippets](https://github.com/OOlashyn/PowerAppsPortalSiteSettingsAndSnippets)
7. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
8. [Giats2498/giats-portfolio](https://github.com/Giats2498/giats-portfolio)
9. [microsoft/Power-Platform-For-Beginners](https://github.com/microsoft/Power-Platform-For-Beginners) — archived
10. [jarbon/coTestPilot](https://github.com/jarbon/coTestPilot)

npm: `power pages authorization permissions` — first registry result list, up to 10 packages.

1. [@backstage/plugin-permission-common 0.9.12](https://www.npmjs.com/package/@backstage/plugin-permission-common) — Isomorphic types and client for Backstage permissions and authorization; source: [declared repository](https://github.com/backstage/backstage).
2. [@backstage/plugin-permission-node 0.11.5](https://www.npmjs.com/package/@backstage/plugin-permission-node) — Common permission and authorization utilities for backend plugins; source: [declared repository](https://github.com/backstage/backstage).
3. [@octokit/oauth-authorization-url 8.0.0](https://www.npmjs.com/package/@octokit/oauth-authorization-url) — Universal library to retrieve GitHubâ^@^Ys identity URL for the OAuth web flow; source: [declared repository](https://github.com/octokit/oauth-authorization-url.js.git).
4. [@backstage/plugin-permission-backend 0.7.17](https://www.npmjs.com/package/@backstage/plugin-permission-backend) — No description; source: [declared repository](https://github.com/backstage/backstage).
5. [oso-cloud 2.7.0](https://www.npmjs.com/package/oso-cloud) — Oso Cloud Node.js Client SDK; source: no repository declared in search metadata.
6. [openid-client 6.8.8](https://www.npmjs.com/package/openid-client) — OAuth 2 / OpenID Connect Client API for JavaScript Runtimes; source: [declared repository](https://github.com/panva/openid-client.git).
7. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
8. [oauth4webapi 3.8.8](https://www.npmjs.com/package/oauth4webapi) — Low-Level OAuth 2 / OpenID Connect Client API for JavaScript Runtimes; source: [declared repository](https://github.com/panva/oauth4webapi.git).
9. [@aws-sdk/client-verifiedpermissions 3.1158.0](https://www.npmjs.com/package/@aws-sdk/client-verifiedpermissions) — AWS SDK for JavaScript Verifiedpermissions Client for Node.js, Browser and React Native; source: [declared repository](https://github.com/aws/aws-sdk-js-v3.git).
10. [@forge/auth 1.0.0](https://www.npmjs.com/package/@forge/auth) — Supports authorization for product REST API calls; source: no repository declared in search metadata.

<a id="mirage-local-identity"></a>

### Local OAuth/OIDC identity provider and token authentication

Sources: [mirage/lib/identity-provider.mjs](../mirage/lib/identity-provider.mjs), [mirage/lib/auth-token.mjs](../mirage/lib/auth-token.mjs), [mirage/lib/dataverse-auth.mjs](../mirage/lib/dataverse-auth.mjs), [mirage/lib/dataverse-managed-identity.mjs](../mirage/lib/dataverse-managed-identity.mjs).

GitHub: `OIDC identity emulator in:name,description,readme` — page 1, up to 10 results.

1. [floci-io/floci](https://github.com/floci-io/floci)
2. [france-connect/identity-provider-example](https://github.com/france-connect/identity-provider-example)
3. [wealthfolio/wealthfolio](https://github.com/wealthfolio/wealthfolio)
4. [vercel-labs/emulate](https://github.com/vercel-labs/emulate)
5. [floci-io/floci-az](https://github.com/floci-io/floci-az)
6. [ministackorg/ministack](https://github.com/ministackorg/ministack)
7. [openclaw/gogcli](https://github.com/openclaw/gogcli)
8. [cloudposse/atmos](https://github.com/cloudposse/atmos)
9. [okta/okta-react-native](https://github.com/okta/okta-react-native)
10. [salrashid123/gce_metadata_server](https://github.com/salrashid123/gce_metadata_server)

npm: `oidc oauth mock identity` — first registry result list, up to 10 packages.

1. [@aws-sdk/client-sso-oidc 3.1158.0](https://www.npmjs.com/package/@aws-sdk/client-sso-oidc) — AWS SDK for JavaScript Sso Oidc Client for Node.js, Browser and React Native; source: [declared repository](https://github.com/aws/aws-sdk-js-v3.git).
2. [oidc-provider 9.13.2](https://www.npmjs.com/package/oidc-provider) — OAuth 2.0 Authorization Server implementation for Node.js with OpenID Connect; source: [declared repository](https://github.com/panva/node-oidc-provider.git).
3. [oidc-client-ts 3.5.0](https://www.npmjs.com/package/oidc-client-ts) — OpenID Connect (OIDC) &#38; OAuth2 client library; source: [declared repository](https://github.com/authts/oidc-client-ts.git).
4. [oauth2-mock-server 9.3.0](https://www.npmjs.com/package/oauth2-mock-server) — OAuth2 and OpenID Connect mock server for automated testing and development. Issues cryptographically signed JWTs via JWK key pairs. OIDC-conformant, exposes discovery, JWKS, authorization, token, userinfo, introspection, revocation, and end-session endpo; source: [declared repository](https://github.com/axa-group/oauth2-mock-server.git).
5. [@mongodb-js/oidc-mock-provider 0.13.20](https://www.npmjs.com/package/@mongodb-js/oidc-mock-provider) — A small, test-only mock OIDC authorization server; source: [declared repository](https://github.com/mongodb-js/devtools-shared.git).
6. [angular-oauth2-oidc 22.0.2](https://www.npmjs.com/package/angular-oauth2-oidc) — Support for OAuth 2(.1) and OpenId Connect (OIDC) in Angular; source: [declared repository](https://github.com/manfredsteyer/angular-oauth2-oidc.git).
7. [react-linkedin-login-oauth2 3.0.0](https://www.npmjs.com/package/react-linkedin-login-oauth2) — React components for Sign in with LinkedIn using OpenID Connect; source: [declared repository](https://github.com/nvh95/react-linkedin-login-oauth2.git).
8. [angular-auth-oidc-client 22.0.2](https://www.npmjs.com/package/angular-auth-oidc-client) — Angular Lib for OpenID Connect &#38; OAuth2; source: [declared repository](https://github.com/damienbod/angular-auth-oidc-client.git).
9. [@replit/oidc-provider 8.8.0](https://www.npmjs.com/package/@replit/oidc-provider) — OAuth 2.0 Authorization Server implementation for Node.js with OpenID Connect; source: [declared repository](https://github.com/panva/node-oidc-provider.git).
10. [@octokit/oauth-authorization-url 8.0.0](https://www.npmjs.com/package/@octokit/oauth-authorization-url) — Universal library to retrieve GitHubâ^@^Ys identity URL for the OAuth web flow; source: [declared repository](https://github.com/octokit/oauth-authorization-url.js.git).

npm refinement: `oauth2-mock-server` — first result list, up to 10 packages.

1. [oauth2-mock-server 9.3.0](https://www.npmjs.com/package/oauth2-mock-server) — OAuth2 and OpenID Connect mock server for automated testing and development. Issues cryptographically signed JWTs via JWK key pairs. OIDC-conformant, exposes discovery, JWKS, authorization, token, userinfo, introspection, revocation, and end-session endpo; source: [declared repository](https://github.com/axa-group/oauth2-mock-server.git).
2. [oauth2-server 3.1.1](https://www.npmjs.com/package/oauth2-server) — Complete, framework-agnostic, compliant and well tested module for implementing an OAuth2 Server in node.js; source: [declared repository](https://github.com/oauthjs/node-oauth2-server.git).
3. [@node-oauth/oauth2-server 5.3.1](https://www.npmjs.com/package/@node-oauth/oauth2-server) — Complete, framework-agnostic, compliant and well tested module for implementing an OAuth2 Server in node.js; source: [declared repository](https://github.com/node-oauth/node-oauth2-server.git).
4. [@types/oauth2-server 3.0.18](https://www.npmjs.com/package/@types/oauth2-server) — TypeScript definitions for oauth2-server; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
5. [ioredis-mock 8.13.1](https://www.npmjs.com/package/ioredis-mock) — This library emulates ioredis by performing all operations in-memory.; source: [declared repository](https://github.com/stipsan/ioredis-mock.git).
6. [msw 3.0.3](https://www.npmjs.com/package/msw) — The industry standard for API mocking in JavaScript.; source: [declared repository](https://github.com/mswjs/msw.git).
7. [google-auth-library 11.3.1](https://www.npmjs.com/package/google-auth-library) — Google APIs Authentication Client Library for Node.js; source: [declared repository](https://github.com/googleapis/google-cloud-node.git).
8. [@badgateway/oauth2-client 3.3.1](https://www.npmjs.com/package/@badgateway/oauth2-client) — OAuth2 client for browsers and Node.js. Tiny footprint, PKCE support; source: a repository is declared in registry metadata.
9. [jest-websocket-mock 2.5.0](https://www.npmjs.com/package/jest-websocket-mock) — Mock websockets and assert complex websocket interactions with Jest; source: [declared repository](https://github.com/romgain/jest-websocket-mock.git).
10. [@node-oauth/formats 1.1.0](https://www.npmjs.com/package/@node-oauth/formats) — Validate ascii and unicode values.; source: [declared repository](https://github.com/node-oauth/formats.git).

<a id="mirage-personas-sessions"></a>

### Isolated visitor/staff sessions and persona scenarios

Sources: [mirage/lib/visitor-session.mjs](../mirage/lib/visitor-session.mjs), [mirage/lib/staff-session.mjs](../mirage/lib/staff-session.mjs), [mirage/lib/auth-session.mjs](../mirage/lib/auth-session.mjs), [mirage/lib/persona-catalog.mjs](../mirage/lib/persona-catalog.mjs).

GitHub: `testing persona isolation in:name,description,readme` — page 1, up to 10 results.

1. [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills)
2. [datascale-ai/opentalking](https://github.com/datascale-ai/opentalking)
3. [openakita/openakita](https://github.com/openakita/openakita)
4. [Zero6992/chatGPT-discord-bot](https://github.com/Zero6992/chatGPT-discord-bot)
5. [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
6. [snarktank/antfarm](https://github.com/snarktank/antfarm)
7. [uditgoenka/autoresearch](https://github.com/uditgoenka/autoresearch)
8. [ddxfish/sapphire](https://github.com/ddxfish/sapphire)
9. [tiliondev/fortress](https://github.com/tiliondev/fortress)
10. [qhkm/zeptoclaw](https://github.com/qhkm/zeptoclaw)

Refinement: `playwright storageState in:name,description` — page 1, up to 10 results.

1. [neonwatty/playwright-profiles](https://github.com/neonwatty/playwright-profiles)
2. [dazy250/playwright-api-storageState](https://github.com/dazy250/playwright-api-storageState)
3. [AnushaChalawadi/storageState_playwright](https://github.com/AnushaChalawadi/storageState_playwright)
4. [nintu-varughese/storageState_Playwright](https://github.com/nintu-varughese/storageState_Playwright)
5. [hrutik7/Playwright-StorageState](https://github.com/hrutik7/Playwright-StorageState)
6. [prashanthreddy6/Playwright-storageState](https://github.com/prashanthreddy6/Playwright-storageState)
7. [dazy250/playwright-storageState](https://github.com/dazy250/playwright-storageState)
8. [abdul2605/storageState.playwright](https://github.com/abdul2605/storageState.playwright)
9. [Zahid-Automate/Playwright-StorageState](https://github.com/Zahid-Automate/Playwright-StorageState)
10. [SurajitKSen/Playwright_StorageStateDemo](https://github.com/SurajitKSen/Playwright_StorageStateDemo)

Refinement: `"playwright" personas in:readme` — page 1, up to 10 results.

1. [alirezarezvani/claude-skills](https://github.com/alirezarezvani/claude-skills)
2. [CloakHQ/CloakBrowser](https://github.com/CloakHQ/CloakBrowser)
3. [nottelabs/notte](https://github.com/nottelabs/notte)
4. [openshift/console](https://github.com/openshift/console)
5. [feder-cr/invisible_playwright](https://github.com/feder-cr/invisible_playwright)
6. [MatrAIx-ai/MatrAIx-Persona-8B](https://github.com/MatrAIx-ai/MatrAIx-Persona-8B)
7. [ShadowHackrs/Gmail-infinity](https://github.com/ShadowHackrs/Gmail-infinity)
8. [teng-lin/notebooklm-py](https://github.com/teng-lin/notebooklm-py)
9. [tiliondev/fortress](https://github.com/tiliondev/fortress)
10. [Code-and-Sorts/awesome-copilot-agents](https://github.com/Code-and-Sorts/awesome-copilot-agents)

npm: `test persona session isolation` — first registry result list, up to 10 packages.

1. [ava 8.2.0](https://www.npmjs.com/package/ava) — Node.js test runner that lets you develop with confidence.; source: [declared repository](https://github.com/avajs/ava.git).
2. [playwright-persona 0.3.0](https://www.npmjs.com/package/playwright-persona) — Authentication in Playwright using personas.; source: [declared repository](https://github.com/kettanaito/playwright-persona.git).
3. [io.appium.settings 8.4.5](https://www.npmjs.com/package/io.appium.settings) — App for dealing with Android settings; source: [declared repository](https://github.com/appium/appium-android.git).
4. [@storybook/react-vite 10.6.5](https://www.npmjs.com/package/@storybook/react-vite) — Storybook for React and Vite: Develop, document, and test UI components in isolation; source: [declared repository](https://github.com/storybookjs/storybook.git).
5. [@deepseek-ai/dsh-subagent-spawn-in-process 0.0.1-rc.3](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-spawn-in-process) — In-process spawn subagent backend: runs a fresh child agent on ctx.agents; source: [declared repository](https://github.com/deepseek-ai/deepseek-harness.git).
6. [@wdio/local-runner 10.1.0](https://www.npmjs.com/package/@wdio/local-runner) — A WebdriverIO runner to run tests locally; source: [declared repository](https://github.com/webdriverio/webdriverio.git).
7. [playwright 1.64.1](https://www.npmjs.com/package/playwright) — A high-level API to automate web browsers; source: [declared repository](https://github.com/microsoft/playwright.git).
8. [@fluentui/react-persona 9.7.11](https://www.npmjs.com/package/@fluentui/react-persona) — React components for building web experiences; source: [declared repository](https://github.com/microsoft/fluentui.git).
9. [@storybook/react-webpack5 10.6.5](https://www.npmjs.com/package/@storybook/react-webpack5) — Storybook for React and Webpack: Develop, document, and test UI components in isolation; source: [declared repository](https://github.com/storybookjs/storybook.git).
10. [@storybook/vue3 10.6.5](https://www.npmjs.com/package/@storybook/vue3) — Storybook Vue 3 renderer: Develop, document, and test UI components in isolation; source: [declared repository](https://github.com/storybookjs/storybook.git).

<a id="mirage-liquid"></a>

### Liquid execution and Power Pages objects/filters

Sources: [mirage/lib/liquid-engine.mjs](../mirage/lib/liquid-engine.mjs), [mirage/lib/liquid-filters.mjs](../mirage/lib/liquid-filters.mjs), [mirage/lib/liquid-builtins.mjs](../mirage/lib/liquid-builtins.mjs), [mirage/lib/liquid-dotnet.mjs](../mirage/lib/liquid-dotnet.mjs).

GitHub: `"Power Pages" Liquid in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/powerplatform-vscode](https://github.com/microsoft/powerplatform-vscode)
2. [microsoft/power-pages-samples](https://github.com/microsoft/power-pages-samples)
3. [brunsdon/dynamics365-developer-cheat-sheet](https://github.com/brunsdon/dynamics365-developer-cheat-sheet)
4. [PacktPublishing/Microsoft-Power-Pages-In-Action](https://github.com/PacktPublishing/Microsoft-Power-Pages-In-Action)
5. [maksii/paqvilo](https://github.com/maksii/paqvilo) — this repository; excluded as a candidate
6. [icpmtech/BookMastering-the-Microsoft-Power-Pages-A-Comprehensive-Guide](https://github.com/icpmtech/BookMastering-the-Microsoft-Power-Pages-A-Comprehensive-Guide)
7. [ulinycoin/clientpdf-pro](https://github.com/ulinycoin/clientpdf-pro)
8. [SweetsNSavories/PowerPagesScanFileUpload](https://github.com/SweetsNSavories/PowerPagesScanFileUpload)
9. [sahu-neha/sahu-neha](https://github.com/sahu-neha/sahu-neha)
10. [srirambalajigit/PowerPlatformAIAssistantsToolbox](https://github.com/srirambalajigit/PowerPlatformAIAssistantsToolbox)

npm: `liquid template power pages` — first registry result list, up to 10 packages.

1. [liquidjs 10.30.0](https://www.npmjs.com/package/liquidjs) — A simple, expressive, extensible Liquid template engine for JavaScript — Shopify, Jekyll and GitHub Pages compatible, for Node.js, browsers, and the CLI, with TypeScript support.; source: [declared repository](https://github.com/harttle/liquidjs.git).
2. [@codemirror/lang-liquid 6.3.3](https://www.npmjs.com/package/@codemirror/lang-liquid) — Liquid template support for the CodeMirror code editor; source: [declared repository](https://code.haverbeke.berlin/codemirror/lang-liquid.git).
3. [@fluid-app/fluid-cli-pages 0.1.230](https://www.npmjs.com/package/@fluid-app/fluid-cli-pages) — Fluid CLI plugin for storefront Pages — create a Page with its own theme template, then list, update, publish, and delete Pages; source: no repository declared in search metadata.
4. [@shopify/prettier-plugin-liquid 1.11.3](https://www.npmjs.com/package/@shopify/prettier-plugin-liquid) — Prettier Liquid/HTML plugin by Shopify; source: [declared repository](https://github.com/Shopify/theme-tools.git).
5. [handlebars 4.7.10](https://www.npmjs.com/package/handlebars) — Handlebars provides the power necessary to let you build semantic templates effectively with no frustration; source: [declared repository](https://github.com/handlebars-lang/handlebars.js.git).
6. [paqvilo 0.9.7](https://www.npmjs.com/package/paqvilo) — Local-first, pro-code tools for Microsoft Power Pages: live source previews with Lense, Liquid and Dataverse simulation with Mirage.; source: [declared repository](https://github.com/maksii/paqvilo.git); this package, excluded as a candidate.
7. [liquid-wormhole 6.0.0](https://www.npmjs.com/package/liquid-wormhole) — Wormholes with the power of Liquid Fire; source: [declared repository](https://github.com/pzuraq/liquid-wormhole.git).
8. [@shopify/liquid-html-parser 2.11.0](https://www.npmjs.com/package/@shopify/liquid-html-parser) — Liquid HTML parser by Shopify; source: [declared repository](https://github.com/Shopify/theme-tools.git).
9. [liquid-gooey 0.2.2](https://www.npmjs.com/package/liquid-gooey) — Liquid UI effects for React: Morph (gooey merge, jelly shape change, contact dissolve), Move (liquid-rubber trails), Melt (two images running molten into each other) and Bend (bodies that bow with velocity). SVG-filter silhouette layer + crisp content lay; source: [declared repository](https://github.com/Jakubantalik/Libraries.dev.git).
10. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).

<a id="mirage-portal-forms"></a>

### Portal forms, multistep forms, lists and native postbacks

Sources: [mirage/lib/form-service.mjs](../mirage/lib/form-service.mjs), [mirage/lib/advanced-form-graph.mjs](../mirage/lib/advanced-form-graph.mjs), [mirage/lib/list-views.mjs](../mirage/lib/list-views.mjs), [mirage/lib/native-postback.mjs](../mirage/lib/native-postback.mjs).

GitHub: `"Power Pages" forms in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills)
2. [kitze/unclutter](https://github.com/kitze/unclutter)
3. [microsoft/powerplatform-vscode](https://github.com/microsoft/powerplatform-vscode)
4. [microsoft/power-pages-samples](https://github.com/microsoft/power-pages-samples)
5. [rwilson504/PCFControls](https://github.com/rwilson504/PCFControls)
6. [microsoft/Powerful-Devs-Hack-Together](https://github.com/microsoft/Powerful-Devs-Hack-Together)
7. [Skyvern-AI/skyvern](https://github.com/Skyvern-AI/skyvern)
8. [microsoft/Power-Platform-For-Beginners](https://github.com/microsoft/Power-Platform-For-Beginners) — archived
9. [OOlashyn/PowerAppsPortalSiteSettingsAndSnippets](https://github.com/OOlashyn/PowerAppsPortalSiteSettingsAndSnippets)
10. [daffl/jquery.dform](https://github.com/daffl/jquery.dform) — archived

npm: `power pages forms multistep` — first registry result list, up to 10 packages.

1. [@cloudflare/component-multistep-modal 6.0.43](https://www.npmjs.com/package/@cloudflare/component-multistep-modal) — Multistep modal with a progress bar; source: no repository declared in search metadata.
2. [pdf-lib 1.17.1](https://www.npmjs.com/package/pdf-lib) — Create and modify PDF files with JavaScript; source: [declared repository](https://github.com/Hopding/pdf-lib.git).
3. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
4. [@department-of-veterans-affairs/va-forms-system-core 1.6.2](https://www.npmjs.com/package/@department-of-veterans-affairs/va-forms-system-core) — Department of Veterans Affairs Forms System Core.; source: no repository declared in search metadata.
5. [@jsonforms/core 3.8.0](https://www.npmjs.com/package/@jsonforms/core) — Core module of JSON Forms; source: [declared repository](https://github.com/eclipsesource/jsonforms.git).
6. [power-assert 1.6.1](https://www.npmjs.com/package/power-assert) — Power Assert in JavaScript; source: [declared repository](https://github.com/power-assert-js/power-assert.git).
7. [paqvilo 0.9.7](https://www.npmjs.com/package/paqvilo) — Local-first, pro-code tools for Microsoft Power Pages: live source previews with Lense, Liquid and Dataverse simulation with Mirage.; source: [declared repository](https://github.com/maksii/paqvilo.git); this package, excluded as a candidate.
8. [empower-core 1.2.0](https://www.npmjs.com/package/empower-core) — Power Assert feature enhancer for assert function/object; source: [declared repository](https://github.com/twada/power-assert-runtime.git).
9. [power-assert-formatter 1.4.1](https://www.npmjs.com/package/power-assert-formatter) — Power Assert output formatter; source: [declared repository](https://github.com/power-assert-js/power-assert-formatter.git).
10. [react-multistep 7.0.0](https://www.npmjs.com/package/react-multistep) — Responsive ReactJS multistep form component; source: [declared repository](https://github.com/srdjan/react-multistep.git).

<a id="mirage-portal-sources"></a>

### Portal resources, localization, navigation and source reload

Sources: [mirage/lib/importer.mjs](../mirage/lib/importer.mjs), [mirage/lib/page-resources.mjs](../mirage/lib/page-resources.mjs), [mirage/lib/portal-languages.mjs](../mirage/lib/portal-languages.mjs), [mirage/lib/source-watcher.mjs](../mirage/lib/source-watcher.mjs).

GitHub: `"Power Pages" development in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills)
2. [mbrg/power-pwn](https://github.com/mbrg/power-pwn)
3. [microsoft/powerplatform-vscode](https://github.com/microsoft/powerplatform-vscode)
4. [github/copilot-plugins](https://github.com/github/copilot-plugins)
5. [kitze/unclutter](https://github.com/kitze/unclutter)
6. [amervitz/xRM-Portals-Community-Edition](https://github.com/amervitz/xRM-Portals-Community-Edition)
7. [ubuntu-flutter-community/settings](https://github.com/ubuntu-flutter-community/settings)
8. [microsoft/contoso-real-estate-power-platform](https://github.com/microsoft/contoso-real-estate-power-platform)
9. [microsoft/PowerBI-Icons](https://github.com/microsoft/PowerBI-Icons) — archived
10. [csansoon/ai-web-designer](https://github.com/csansoon/ai-web-designer)

npm: `power pages local development` — first registry result list, up to 10 packages.

1. [paqvilo 0.9.7](https://www.npmjs.com/package/paqvilo) — Local-first, pro-code tools for Microsoft Power Pages: live source previews with Lense, Liquid and Dataverse simulation with Mirage.; source: [declared repository](https://github.com/maksii/paqvilo.git); this package, excluded as a candidate.
2. [@yext/pages 1.3.4](https://www.npmjs.com/package/@yext/pages) — The default React development toolchain provided by Yext; source: [declared repository](https://github.com/yext/pages.git).
3. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
4. [@firebase/data-connect 0.7.4](https://www.npmjs.com/package/@firebase/data-connect) — Check &#96;test/dataconnect.yaml&#96; to ensure that the correct values are filled in.; source: [declared repository](https://github.com/firebase/firebase-js-sdk.git).
5. [@microsoft/powerbi-modeling-mcp 1.0.0](https://www.npmjs.com/package/@microsoft/powerbi-modeling-mcp) — Power BI Authoring MCP Server - Node.js client packaging to author Power BI semantic models in Power BI Desktop, Microsoft Fabric workspaces, and local PBIP and TMDL files.; source: [declared repository](https://github.com/microsoft/powerbi-modeling-mcp.git).
6. [vinext 1.3.1](https://www.npmjs.com/package/vinext) — Run Next.js apps on Vite. Drop-in replacement for the next CLI.; source: [declared repository](https://github.com/cloudflare/vinext.git).
7. [baseline-browser-mapping 2.11.34](https://www.npmjs.com/package/baseline-browser-mapping) — A library for obtaining browser versions with their maximum supported Baseline feature set and Widely Available status.; source: [declared repository](https://github.com/web-platform-dx/baseline-browser-mapping.git).
8. [powerbi-visuals-utils-dataviewutils 7.0.0](https://www.npmjs.com/package/powerbi-visuals-utils-dataviewutils) — dataviewutils; source: [declared repository](https://github.com/Microsoft/powerbi-visuals-utils-dataviewutils.git).
9. [power-assert 1.6.1](https://www.npmjs.com/package/power-assert) — Power Assert in JavaScript; source: [declared repository](https://github.com/power-assert-js/power-assert.git).
10. [@alwaysmeticulous/backend-recorder-workerd 2.350.0](https://www.npmjs.com/package/@alwaysmeticulous/backend-recorder-workerd) — Meticulous backend recorder shim for Cloudflare Workers (workerd). Reports inbound and outbound HTTP capture events to a local Meticulous recorder sidecar during development recording.; source: [declared repository](https://github.com/alwaysmeticulous/meticulous-sdk.git).

<a id="mirage-plugin-runtime"></a>

### Plugin pipeline, SDK calls and trusted CLR execution

Sources: [mirage/lib/plugin-clr.mjs](../mirage/lib/plugin-clr.mjs), [mirage/lib/plugin-clr-host.cs](../mirage/lib/plugin-clr-host.cs), [mirage/lib/plugin-query.mjs](../mirage/lib/plugin-query.mjs), [mirage/lib/dataverse-plugin-registration.mjs](../mirage/lib/dataverse-plugin-registration.mjs).

GitHub: `Dataverse plugin testing in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills)
2. [microsoft/PowerAppsCodeApps](https://github.com/microsoft/PowerAppsCodeApps)
3. [daryllabar/DLaB.Xrm.XrmToolBoxTools](https://github.com/daryllabar/DLaB.Xrm.XrmToolBoxTools)
4. [microsoft/mcp](https://github.com/microsoft/mcp)
5. [Power-Maverick/DataverseDevTools-VSCode](https://github.com/Power-Maverick/DataverseDevTools-VSCode)
6. [DanielKerridge/claude-code-power-platform-skills](https://github.com/DanielKerridge/claude-code-power-platform-skills)
7. [phuocle/Dynamics-Crm-DevKit](https://github.com/phuocle/Dynamics-Crm-DevKit)
8. [IQSS/dataverse-docker](https://github.com/IQSS/dataverse-docker)
9. [context-and-oss/XrmBedrock](https://github.com/context-and-oss/XrmBedrock)
10. [microsoft/power-cat-skills](https://github.com/microsoft/power-cat-skills)

npm: `dataverse plugin testing mock` — first registry result list, up to 10 packages.

1. [msw 3.0.3](https://www.npmjs.com/package/msw) — The industry standard for API mocking in JavaScript.; source: [declared repository](https://github.com/mswjs/msw.git).
2. [@contract-case/case-core-plugin-function 0.31.4](https://www.npmjs.com/package/@contract-case/case-core-plugin-function) — ContractCase core function plugin, allowing validation of arbitrary functions; source: a repository is declared in registry metadata.
3. [@contract-case/case-core-plugin-function-dsl 0.31.4](https://www.npmjs.com/package/@contract-case/case-core-plugin-function-dsl) — ContractCase core function plugin DSL; source: a repository is declared in registry metadata.
4. [ioredis-mock 8.13.1](https://www.npmjs.com/package/ioredis-mock) — This library emulates ioredis by performing all operations in-memory.; source: [declared repository](https://github.com/stipsan/ioredis-mock.git).
5. [kinesis-local 0.6.2](https://www.npmjs.com/package/kinesis-local) — A Mock API for AWS Kinesis; source: [declared repository](https://github.com/etspaceman/kinesis-mock.git).
6. [jest-canvas-mock 2.5.8](https://www.npmjs.com/package/jest-canvas-mock) — Mock a canvas in your jest tests.; source: [declared repository](https://github.com/hustcc/jest-canvas-mock.git).
7. [mockttp 4.6.5](https://www.npmjs.com/package/mockttp) — Mock HTTP server for testing HTTP clients and stubbing webservices; source: [declared repository](https://github.com/httptoolkit/mockttp.git).
8. [eslint-plugin-testing-library 7.16.2](https://www.npmjs.com/package/eslint-plugin-testing-library) — ESLint plugin to follow best practices and anticipate common mistakes when writing tests with Testing Library; source: [declared repository](https://github.com/testing-library/eslint-plugin-testing-library.git).
9. [next-router-mock 1.0.5](https://www.npmjs.com/package/next-router-mock) — Mock implementation of the Next.js Router; source: [declared repository](https://github.com/scottrippey/next-router-mock.git).
10. [jest-websocket-mock 2.5.0](https://www.npmjs.com/package/jest-websocket-mock) — Mock websockets and assert complex websocket interactions with Jest; source: [declared repository](https://github.com/romgain/jest-websocket-mock.git).

<a id="mirage-custom-api"></a>

### Custom APIs, organization messages and server logic

Sources: [mirage/lib/dataverse-customapi.mjs](../mirage/lib/dataverse-customapi.mjs), [mirage/lib/server-logic.mjs](../mirage/lib/server-logic.mjs), [mirage/lib/dataverse-operation-contracts.mjs](../mirage/lib/dataverse-operation-contracts.mjs).

GitHub: `Dataverse custom API in:name,description,readme` — page 1, up to 10 results.

1. [UpstageAI/dataverse](https://github.com/UpstageAI/dataverse) — archived
2. [microsoft/PowerAppsCodeApps](https://github.com/microsoft/PowerAppsCodeApps)
3. [microsoft/Dataverse-skills](https://github.com/microsoft/Dataverse-skills)
4. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)
5. [microsoft/Power-BI-Embedded-Contoso-Sales-Demo](https://github.com/microsoft/Power-BI-Embedded-Contoso-Sales-Demo)
6. [microsoft/mcp](https://github.com/microsoft/mcp)
7. [phuocle/Dynamics-Crm-DevKit](https://github.com/phuocle/Dynamics-Crm-DevKit)
8. [GlobalDataverseCommunityConsortium/dataverse-previewers](https://github.com/GlobalDataverseCommunityConsortium/dataverse-previewers)
9. [drivardxrm/Dataverse-CustomApis](https://github.com/drivardxrm/Dataverse-CustomApis)
10. [gdcc/dataverse-ansible](https://github.com/gdcc/dataverse-ansible)

npm: `dataverse custom api mock` — first registry result list, up to 10 packages.

1. [msw 3.0.3](https://www.npmjs.com/package/msw) — The industry standard for API mocking in JavaScript.; source: [declared repository](https://github.com/mswjs/msw.git).
2. [aws-sdk-client-mock 4.1.0](https://www.npmjs.com/package/aws-sdk-client-mock) — Easy and powerful mocking of AWS SDK v3 Clients; source: [declared repository](https://github.com/m-radzikowski/aws-sdk-client-mock.git).
3. [fetch-mock 12.6.0](https://www.npmjs.com/package/fetch-mock) — Mock http requests made using fetch; source: [declared repository](https://github.com/wheresrhys/fetch-mock.git).
4. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
5. [jest-mock 30.5.2](https://www.npmjs.com/package/jest-mock) — &#42;&#42;Note:&#42;&#42; More details on user side API can be found in &#91;Jest documentation&#93;(https://jestjs.io/docs/mock-function-api).; source: [declared repository](https://github.com/jestjs/jest.git).
6. [@vitest/spy 5.0.5](https://www.npmjs.com/package/@vitest/spy) — Lightweight Jest compatible spy implementation; source: [declared repository](https://github.com/vitest-dev/vitest.git).
7. [aws-sdk-client-mock-jest 4.1.0](https://www.npmjs.com/package/aws-sdk-client-mock-jest) — Custom Jest matchers for AWS SDK v3 Client mock; source: [declared repository](https://github.com/m-radzikowski/aws-sdk-client-mock.git).
8. [jest-fetch-mock 4.2.0](https://www.npmjs.com/package/jest-fetch-mock) — fetch mock for jest; source: [declared repository](https://github.com/jefflau/jest-fetch-mock.git).
9. [kinesis-local 0.6.2](https://www.npmjs.com/package/kinesis-local) — A Mock API for AWS Kinesis; source: [declared repository](https://github.com/etspaceman/kinesis-mock.git).
10. [vitest-fetch-mock 0.4.5](https://www.npmjs.com/package/vitest-fetch-mock) — fetch mock for vitest; source: [declared repository](https://github.com/IanVS/vitest-fetch-mock.git).

<a id="mirage-classic-workflows"></a>

### Classic workflows, business process flows and business rules

Sources: [mirage/lib/dataverse-workflows.mjs](../mirage/lib/dataverse-workflows.mjs), [mirage/lib/dataverse-bpf.mjs](../mirage/lib/dataverse-bpf.mjs), [mirage/lib/dataverse-business-rules.mjs](../mirage/lib/dataverse-business-rules.mjs).

GitHub: `Dataverse workflow simulator in:name,description,readme` — page 1, up to 10 results.

1. [maimemo/SSP-MMC](https://github.com/maimemo/SSP-MMC)
2. [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
3. [mzazon/cloud-projects](https://github.com/mzazon/cloud-projects)
4. [toolsdk-ai/toolsdk-mcp-registry](https://github.com/toolsdk-ai/toolsdk-mcp-registry)
5. [ever-works/awesome-mcp-servers](https://github.com/ever-works/awesome-mcp-servers)
6. [openlists/ElectrophysiologyData](https://github.com/openlists/ElectrophysiologyData)
7. [mctrinh/awesome-mcp-servers](https://github.com/mctrinh/awesome-mcp-servers)
8. [Mintahandrews/Low-Code-No-Code-Platforms](https://github.com/Mintahandrews/Low-Code-No-Code-Platforms)
9. [sshuair/awesome-gis](https://github.com/sshuair/awesome-gis)
10. [SoymilkWinsAgain/LM_Voting_Simulator](https://github.com/SoymilkWinsAgain/LM_Voting_Simulator)

Refinement: `"Dynamics" "workflow" in:name,description` — page 1, up to 10 results.

1. [demianrasko/Dynamics-365-Workflow-Tools](https://github.com/demianrasko/Dynamics-365-Workflow-Tools)
2. [mkuiper/MD_workflow](https://github.com/mkuiper/MD_workflow)
3. [mkuiper/MD_workflow_py](https://github.com/mkuiper/MD_workflow_py)
4. [ramontebar/dynamics-custom-emails](https://github.com/ramontebar/dynamics-custom-emails)
5. [cmelab/flowerMD](https://github.com/cmelab/flowerMD)
6. [csml-rpi/Foam-Agent](https://github.com/csml-rpi/Foam-Agent)
7. [steveplatz/CRM-DateTime-Workflow-Utilities](https://github.com/steveplatz/CRM-DateTime-Workflow-Utilities)
8. [NCEAS/commdyn](https://github.com/NCEAS/commdyn)
9. [juanribes/CRM-String-Workflow-Utilities](https://github.com/juanribes/CRM-String-Workflow-Utilities)
10. [juanribes/CRM-Email-Workflow-Utilities](https://github.com/juanribes/CRM-Email-Workflow-Utilities)

npm: `dataverse workflow business rules` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [@gorules/zen-engine 2.1.9](https://www.npmjs.com/package/@gorules/zen-engine) — Open-source Business Rules Engine for Node.js, powered by Rust; source: [declared repository](https://github.com/gorules/zen.git).
3. [stylelint-scss 7.4.0](https://www.npmjs.com/package/stylelint-scss) — A collection of SCSS-specific rules for Stylelint; source: [declared repository](https://github.com/stylelint-scss/stylelint-scss.git).
4. [eslint-plugin-vue 10.12.0](https://www.npmjs.com/package/eslint-plugin-vue) — Official ESLint plugin for Vue.js; source: [declared repository](https://github.com/vuejs/eslint-plugin-vue.git).
5. [@hart365/pp-md-pptb-edition 1.2.2](https://www.npmjs.com/package/@hart365/pp-md-pptb-edition) — Generate Power Platform documentation from either Solution ZIP files or direct Dataverse connection; source: [declared repository](https://github.com/Hart365/pp-md-pptb-edition.git).
6. [hyperformula 3.5.0](https://www.npmjs.com/package/hyperformula) — HyperFormula is a JavaScript engine for efficient processing of spreadsheet-like data and formulas; source: [declared repository](https://github.com/handsontable/hyperformula.git).
7. [facebook-nodejs-business-sdk 24.0.1](https://www.npmjs.com/package/facebook-nodejs-business-sdk) — SDK for the Facebook Marketing API in Javascript and Node.js; source: a repository is declared in registry metadata.
8. [@dataverse-kit/export-engine 1.38.18](https://www.npmjs.com/package/@dataverse-kit/export-engine) — Code generator that emits self-contained PCF, Static Web App, and Web Resource projects (React + Fluent UI v8) from a Dynamics 365 form-builder design — including a live Dataverse data-access layer and vendored grid-kit subgrids.; source: no repository declared in search metadata.
9. [stylelint-config-recommended-scss 17.0.1](https://www.npmjs.com/package/stylelint-config-recommended-scss) — The recommended shareable SCSS config for Stylelint; source: [declared repository](https://github.com/stylelint-scss/stylelint-config-recommended-scss.git).
10. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).

<a id="mirage-flow-expressions"></a>

### Power Automate WDL expressions and action execution

Sources: [mirage/lib/flow-runtime.mjs](../mirage/lib/flow-runtime.mjs), [mirage/lib/flow-actions.mjs](../mirage/lib/flow-actions.mjs), [mirage/lib/flow-yaml.mjs](../mirage/lib/flow-yaml.mjs).

GitHub: `"Power Automate" expression evaluator in:name,description,readme` — page 1, up to 10 results.

1. [rkneela0912/SmartBrief](https://github.com/rkneela0912/SmartBrief)
2. [ninihen1/power-automate-mcp-skills](https://github.com/ninihen1/power-automate-mcp-skills)
3. [delegateas/ExpressionEngine](https://github.com/delegateas/ExpressionEngine)
4. [PowerAppsDarren/PowerFxSnippets](https://github.com/PowerAppsDarren/PowerFxSnippets)
5. [russrimm/AADAppSecretsnCertsExpirationNotification](https://github.com/russrimm/AADAppSecretsnCertsExpirationNotification)
6. [rritec/POWERBI](https://github.com/rritec/POWERBI)
7. [shahednasser/awesome-resources](https://github.com/shahednasser/awesome-resources)
8. [ANative-Lab/Awesome-Self-Evolving-Agents](https://github.com/ANative-Lab/Awesome-Self-Evolving-Agents)
9. [HKUST-KnowComp/Awesome-LLM-Scientific-Discovery](https://github.com/HKUST-KnowComp/Awesome-LLM-Scientific-Discovery)
10. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)

Refinement: `"Power Automate" expression in:name,description` — page 1, up to 10 results.

1. [delegateas/ExpressionEngine](https://github.com/delegateas/ExpressionEngine)
2. [gncnpk/power-automate-expressions](https://github.com/gncnpk/power-automate-expressions)
3. [vikrantyadav11/PowerAutomate](https://github.com/vikrantyadav11/PowerAutomate)
4. [sjcrawfordjenni/Power-Automate-Expressions](https://github.com/sjcrawfordjenni/Power-Automate-Expressions)
5. [Hemanthavasanth/RegularExpression_CustomConnector_PowerAutomateCloud](https://github.com/Hemanthavasanth/RegularExpression_CustomConnector_PowerAutomateCloud)
6. [Sorruss66/Power-Automate-Expression](https://github.com/Sorruss66/Power-Automate-Expression)
7. [trikitlekkaeo/Power-Automate](https://github.com/trikitlekkaeo/Power-Automate)
8. [pranamg/powerautomate](https://github.com/pranamg/powerautomate)
9. [omezquita/PowerAutomate](https://github.com/omezquita/PowerAutomate)
10. [skoolguy/power-automate-expression-formatter](https://github.com/skoolguy/power-automate-expression-formatter)

npm: `power automate expression evaluator` — first registry result list, up to 10 packages.

1. [math-expression-evaluator 2.0.7](https://www.npmjs.com/package/math-expression-evaluator) — A flexible math expression evaluator; source: [declared repository](https://github.com/redhivesoftware/math-expression-evaluator.git).
2. [expr-eval-fork 3.0.3](https://www.npmjs.com/package/expr-eval-fork) — Mathematical expression evaluator fork with exports map, prototype pollution and code injection security fixes; source: [declared repository](https://github.com/jorenbroekema/expr-eval.git).
3. [@comunica/utils-expression-evaluator 5.4.0](https://www.npmjs.com/package/@comunica/utils-expression-evaluator) — A simple SPARQL expression evaluator; source: [declared repository](https://github.com/comunica/comunica.git).
4. [@comunica/actor-expression-evaluator-factory-default 5.4.0](https://www.npmjs.com/package/@comunica/actor-expression-evaluator-factory-default) — A default expression-evaluator-factory actor; source: [declared repository](https://github.com/comunica/comunica.git).
5. [expr-eval 2.0.2](https://www.npmjs.com/package/expr-eval) — Mathematical expression evaluator; source: [declared repository](https://github.com/silentmatt/expr-eval.git).
6. [@comunica/bus-expression-evaluator-factory 5.4.0](https://www.npmjs.com/package/@comunica/bus-expression-evaluator-factory) — A comunica bus for expression-evaluator-factory events.; source: [declared repository](https://github.com/comunica/comunica.git).
7. [@emmetio/math-expression 1.0.5](https://www.npmjs.com/package/@emmetio/math-expression) — Parse and evaluate simple math expressions; source: [declared repository](https://github.com/emmetio/math-expression.git).
8. [ts-evaluator 2.0.0](https://www.npmjs.com/package/ts-evaluator) — An interpreter for Typescript that can evaluate an arbitrary Node within a Typescript AST; source: [declared repository](https://github.com/wessberg/ts-evaluator.git).
9. [@comunica/actor-term-comparator-factory-expression-evaluator 5.4.0](https://www.npmjs.com/package/@comunica/actor-term-comparator-factory-expression-evaluator) — A expression-evaluator term-comparator-factory actor; source: [declared repository](https://github.com/comunica/comunica.git).
10. [@bufbuild/cel 0.6.1](https://www.npmjs.com/package/@bufbuild/cel) — A CEL evaluator for ECMAScript; source: [declared repository](https://github.com/bufbuild/cel-es.git).

<a id="mirage-durable-flows"></a>

### Flow triggers, durable runs, waits, retries and cancellation

Sources: [mirage/lib/flow-triggers.mjs](../mirage/lib/flow-triggers.mjs), [mirage/lib/flow-runs.mjs](../mirage/lib/flow-runs.mjs), [mirage/lib/dataverse-async.mjs](../mirage/lib/dataverse-async.mjs).

GitHub: `durable workflow scheduler in:name,description,readme` — page 1, up to 10 results.

1. [durable-workflow/workflow](https://github.com/durable-workflow/workflow)
2. [meirwah/awesome-workflow-engines](https://github.com/meirwah/awesome-workflow-engines)
3. [agno-agi/agno](https://github.com/agno-agi/agno)
4. [Azure/durabletask](https://github.com/Azure/durabletask)
5. [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev)
6. [hatchet-dev/hatchet](https://github.com/hatchet-dev/hatchet)
7. [dapr/dapr](https://github.com/dapr/dapr)
8. [dbos-inc/dbos-transact-py](https://github.com/dbos-inc/dbos-transact-py)
9. [dbos-inc/dbos-transact-ts](https://github.com/dbos-inc/dbos-transact-ts)
10. [PrimeIntellect-ai/prime-agent](https://github.com/PrimeIntellect-ai/prime-agent)

npm: `durable workflow scheduler retries` — first registry result list, up to 10 packages.

1. [@n8n/scheduler 1.14.2](https://www.npmjs.com/package/@n8n/scheduler) — A durable, cluster-safe scheduler. You give it rules like "run this every Monday at 09:00" or "run this once at midnight on New Year's Eve", and it makes sure the work actually runs, at the right time, and (as close as a distributed system can get) exactl; source: [declared repository](https://github.com/n8n-io/n8n.git).
2. [@hatchet-dev/typescript-sdk 1.44.2](https://www.npmjs.com/package/@hatchet-dev/typescript-sdk) — Background task orchestration &#38; visibility for developers; source: [declared repository](https://github.com/hatchet-dev/hatchet.git).
3. [workflow 5.2.3](https://www.npmjs.com/package/workflow) — Workflow SDK - Build durable, resilient, and observable workflows; source: [declared repository](https://github.com/vercel/workflow.git).
4. [scheduler 0.28.0](https://www.npmjs.com/package/scheduler) — Cooperative scheduler for the browser environment.; source: [declared repository](https://github.com/react/react.git).
5. [@nevware21/ts-async 0.6.1](https://www.npmjs.com/package/@nevware21/ts-async) — support for asynchronous development with a Promise based task Scheduler, several different Promise implementations (synchronous, idle, asynchronous and native runtime wrappers), await helpers, and aliases all built and tested using TypeScript.; source: [declared repository](https://github.com/nevware21/ts-async.git).
6. [@dbos-inc/dbos-sdk 5.3.0](https://www.npmjs.com/package/@dbos-inc/dbos-sdk) — Lightweight durable workflows built on Postgres; source: [declared repository](https://github.com/dbos-inc/dbos-transact-ts.git).
7. [@aws/durable-execution-sdk-js 3.0.0](https://www.npmjs.com/package/@aws/durable-execution-sdk-js) — AWS Durable Execution Language SDK for TypeScript; source: a repository is declared in registry metadata.
8. [node-schedule 2.1.2](https://www.npmjs.com/package/node-schedule) — A cron-like and not-cron-like job scheduler for Node.; source: [declared repository](https://github.com/node-schedule/node-schedule.git).
9. [@upstash/workflow 1.5.0](https://www.npmjs.com/package/@upstash/workflow) — Durable, Reliable and Performant Serverless Functions; source: a repository is declared in registry metadata.
10. [smithers-orchestrator 0.32.0](https://www.npmjs.com/package/smithers-orchestrator) — Multi-agent workflows with full observability and time travel: watch every step live, rewind, fork, and replay any run. Claude Code, Codex, Gemini, any model or harness.; source: [declared repository](https://github.com/smithersai/smithers.git).

<a id="mirage-connectors-fixtures"></a>

### Connector fixtures, connection references and secrets

Sources: [mirage/lib/connector-runtime.mjs](../mirage/lib/connector-runtime.mjs), [mirage/lib/service-fixtures.mjs](../mirage/lib/service-fixtures.mjs), [mirage/lib/secret-resolver.mjs](../mirage/lib/secret-resolver.mjs), [mirage/lib/flow-vault.mjs](../mirage/lib/flow-vault.mjs).

GitHub: `"Power Automate" connector mock in:name,description,readme` — page 1, up to 10 results.

1. [ryaker/outlook-mcp](https://github.com/ryaker/outlook-mcp)
2. [TestSprite/testsprite-cli](https://github.com/TestSprite/testsprite-cli)
3. [rpabotsworld/awesome-rpa](https://github.com/rpabotsworld/awesome-rpa)
4. [thygesteffensen/PowerAutomateMockUp](https://github.com/thygesteffensen/PowerAutomateMockUp)
5. [SQL-Server-projects/Reporting-Services-examples](https://github.com/SQL-Server-projects/Reporting-Services-examples)
6. [XS-MLVP/UCAgent](https://github.com/XS-MLVP/UCAgent)
7. [stn1slv/awesome-integration](https://github.com/stn1slv/awesome-integration)
8. [Wals-pro/claude-power-automate](https://github.com/Wals-pro/claude-power-automate)
9. [hashgraph-online/awesome-codex-plugins](https://github.com/hashgraph-online/awesome-codex-plugins)
10. [microsoft/dstoolkit-pva-audiocodes-cc](https://github.com/microsoft/dstoolkit-pva-audiocodes-cc) — archived

npm: `power automate connector mock` — first registry result list, up to 10 packages.

1. [playwright-msteams-reporter 0.0.14](https://www.npmjs.com/package/playwright-msteams-reporter) — Microsoft Teams reporter for Playwright which allows you to send notifications about the status of your E2E tests.; source: [declared repository](https://github.com/estruyf/playwright-msteams-reporter.git).
2. [mockttp 4.6.5](https://www.npmjs.com/package/mockttp) — Mock HTTP server for testing HTTP clients and stubbing webservices; source: [declared repository](https://github.com/httptoolkit/mockttp.git).
3. [msw 3.0.3](https://www.npmjs.com/package/msw) — The industry standard for API mocking in JavaScript.; source: [declared repository](https://github.com/mswjs/msw.git).
4. [@google-cloud/cloud-sql-connector 1.12.1](https://www.npmjs.com/package/@google-cloud/cloud-sql-connector) — A JavaScript library for connecting securely to your Cloud SQL instances; source: [declared repository](https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector.git).
5. [jest-canvas-mock 2.5.8](https://www.npmjs.com/package/jest-canvas-mock) — Mock a canvas in your jest tests.; source: [declared repository](https://github.com/hustcc/jest-canvas-mock.git).
6. [aws-sdk-client-mock 4.1.0](https://www.npmjs.com/package/aws-sdk-client-mock) — Easy and powerful mocking of AWS SDK v3 Clients; source: [declared repository](https://github.com/m-radzikowski/aws-sdk-client-mock.git).
7. [@contract-case/case-core-plugin-function 0.31.4](https://www.npmjs.com/package/@contract-case/case-core-plugin-function) — ContractCase core function plugin, allowing validation of arbitrary functions; source: a repository is declared in registry metadata.
8. [kinesis-local 0.6.2](https://www.npmjs.com/package/kinesis-local) — A Mock API for AWS Kinesis; source: [declared repository](https://github.com/etspaceman/kinesis-mock.git).
9. [axios-mock-adapter 2.1.0](https://www.npmjs.com/package/axios-mock-adapter) — Axios adapter that allows to easily mock requests; source: [declared repository](https://github.com/ctimmerm/axios-mock-adapter.git).
10. [jest-fetch-mock 4.2.0](https://www.npmjs.com/package/jest-fetch-mock) — fetch mock for jest; source: [declared repository](https://github.com/jefflau/jest-fetch-mock.git).

<a id="mirage-computed-columns"></a>

### Calculated columns, rollups, formulas and currency

Sources: [mirage/lib/dataverse-calculated.mjs](../mirage/lib/dataverse-calculated.mjs), [mirage/lib/dataverse-rollup.mjs](../mirage/lib/dataverse-rollup.mjs), [mirage/lib/dataverse-formula.mjs](../mirage/lib/dataverse-formula.mjs), [mirage/lib/dataverse-currency.mjs](../mirage/lib/dataverse-currency.mjs).

GitHub: `Dataverse calculated rollup in:name,description,readme` — page 1, up to 10 results.

1. [demianrasko/Dynamics-365-Workflow-Tools](https://github.com/demianrasko/Dynamics-365-Workflow-Tools)
2. [allandecastro/dataverse-erd-visualizer](https://github.com/allandecastro/dataverse-erd-visualizer)
3. [mohsinonxrm/pptb-mxrm-fetchxml-studio](https://github.com/mohsinonxrm/pptb-mxrm-fetchxml-studio)
4. [codegenius2/dataverse](https://github.com/codegenius2/dataverse)
5. [sunshineluyao/uniswap](https://github.com/sunshineluyao/uniswap)
6. [ALM4Dataverse/Fake4Dataverse](https://github.com/ALM4Dataverse/Fake4Dataverse)
7. [miberr/Dataverse-Plugin-Calculate-Rollup](https://github.com/miberr/Dataverse-Plugin-Calculate-Rollup)
8. [markus-tobler/dataverse-metadata-mcp](https://github.com/markus-tobler/dataverse-metadata-mcp)
9. [sudheervarma24/Dynamics-365-CRM-Developer-Portfolio](https://github.com/sudheervarma24/Dynamics-365-CRM-Developer-Portfolio)
10. [MariaVolovich/InvestmentDemo](https://github.com/MariaVolovich/InvestmentDemo)

npm: `dataverse calculated rollup formula` — first registry result list, up to 10 packages.

1. [@sideway/formula 3.0.1](https://www.npmjs.com/package/@sideway/formula) — Math and string formula parser.; source: a repository is declared in registry metadata.
2. [@hapi/formula 4.0.0](https://www.npmjs.com/package/@hapi/formula) — Math and string formula parser.; source: a repository is declared in registry metadata.
3. [@rollup/pluginutils 5.5.1](https://www.npmjs.com/package/@rollup/pluginutils) — A set of utility functions commonly used by Rollup plugins; source: [declared repository](https://github.com/rollup/plugins.git).
4. [rolldown 1.2.15](https://www.npmjs.com/package/rolldown) — Fast JavaScript/TypeScript bundler in Rust with Rollup-compatible API.; source: [declared repository](https://github.com/rolldown/rolldown.git).
5. [@rollup/plugin-commonjs 29.0.3](https://www.npmjs.com/package/@rollup/plugin-commonjs) — Convert CommonJS modules to ES2015; source: [declared repository](https://github.com/rollup/plugins.git).
6. [@univerjs/sheets-formula-ui 1.2.0](https://www.npmjs.com/package/@univerjs/sheets-formula-ui) — Formula editing UI for Univer Sheets.; source: [declared repository](https://github.com/dream-num/univer).
7. [@univerjs/sheets-formula 1.2.0](https://www.npmjs.com/package/@univerjs/sheets-formula) — Sheet formula services and calculation integration for Univer Sheets.; source: [declared repository](https://github.com/dream-num/univer).
8. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
9. [nth-check 3.0.1](https://www.npmjs.com/package/nth-check) — Parses and compiles CSS nth-checks to highly optimized functions.; source: [declared repository](https://github.com/fb55/nth-check.git).
10. [@rollup/plugin-babel 7.1.0](https://www.npmjs.com/package/@rollup/plugin-babel) — Seamless integration between Rollup and Babel.; source: [declared repository](https://github.com/rollup/plugins.git).

<a id="mirage-synthetic-data"></a>

### Schema-directed synthetic data, IDs and lookup population

Sources: [mirage/lib/dataset-generator.mjs](../mirage/lib/dataset-generator.mjs), [mirage/lib/scaffold-data.mjs](../mirage/lib/scaffold-data.mjs), [mirage/fixtures.mjs](../mirage/fixtures.mjs).

GitHub: `Dataverse data generator in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills)
2. [scottdurow/dataverse-gen](https://github.com/scottdurow/dataverse-gen)
3. [Data8/DataverseClient](https://github.com/Data8/DataverseClient)
4. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
5. [phuocle/Dynamics-Crm-DevKit](https://github.com/phuocle/Dynamics-Crm-DevKit)
6. [mims-harvard/GraphXAI](https://github.com/mims-harvard/GraphXAI)
7. [rajyraman/Dataverse-LINQPad-Driver](https://github.com/rajyraman/Dataverse-LINQPad-Driver)
8. [microsoft/power-cat-skills](https://github.com/microsoft/power-cat-skills)
9. [context-and-oss/XrmBedrock](https://github.com/context-and-oss/XrmBedrock)
10. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)

npm: `schema synthetic data relationships` — first registry result list, up to 10 packages.

1. [json-schema-traverse 1.0.0](https://www.npmjs.com/package/json-schema-traverse) — Traverse JSON Schema passing each schema object to callback; source: [declared repository](https://github.com/epoberezkin/json-schema-traverse.git).
2. [json-schema-typed 9.0.0](https://www.npmjs.com/package/json-schema-typed) — JSON Schema TypeScript definitions with complete inline documentation.; source: [declared repository](https://github.com/RemyRylan/json-schema-typed.git).
3. [ajv 8.20.0](https://www.npmjs.com/package/ajv) — Another JSON Schema Validator; source: [declared repository](https://github.com/ajv-validator/ajv.git).
4. [synthetic-dom 1.4.0](https://www.npmjs.com/package/synthetic-dom) — Synthetic HTML DOM for use with parsing within React-RTE; source: [declared repository](https://github.com/sstur/draft-js-utils/tree/master/packages/synthetic-dom).
5. [@standard-schema/utils 0.3.0](https://www.npmjs.com/package/@standard-schema/utils) — The official runtime utils for Standard Schema; source: [declared repository](https://github.com/standard-schema/standard-schema.git).
6. [zod-to-json-schema 3.25.2](https://www.npmjs.com/package/zod-to-json-schema) — Converts Zod schemas to Json Schemas; source: [declared repository](https://github.com/StefanTerdell/zod-to-json-schema.git).
7. [@apidevtools/json-schema-ref-parser 16.0.5](https://www.npmjs.com/package/@apidevtools/json-schema-ref-parser) — Parse, Resolve, and Dereference JSON Schema $ref pointers; source: [declared repository](https://github.com/APIDevTools/json-schema-ref-parser.git).
8. [@finos/calm-schema 1.3.0](https://www.npmjs.com/package/@finos/calm-schema) — The CALM (Common Architecture Language Model) Meta Schema; source: [declared repository](https://github.com/finos/calm-schema.git).
9. [@snaplet/seed 0.98.0](https://www.npmjs.com/package/@snaplet/seed) — An auto-generated ORM-like library for generating seed data tailored to your own database; source: no repository declared in search metadata.
10. [@standard-schema/spec 1.1.0](https://www.npmjs.com/package/@standard-schema/spec) — A family of specs for interoperable TypeScript; source: [declared repository](https://github.com/standard-schema/standard-schema.git).

npm refinement: `ajv` — first result list, up to 10 packages.

1. [ajv 8.20.0](https://www.npmjs.com/package/ajv) — Another JSON Schema Validator; source: [declared repository](https://github.com/ajv-validator/ajv.git).
2. [ajv-formats 3.0.1](https://www.npmjs.com/package/ajv-formats) — Format validation for Ajv v7+; source: [declared repository](https://github.com/ajv-validator/ajv-formats.git).
3. [ajv-keywords 5.1.0](https://www.npmjs.com/package/ajv-keywords) — Additional JSON-Schema keywords for Ajv JSON validator; source: [declared repository](https://github.com/epoberezkin/ajv-keywords.git).
4. [ajv-draft-04 1.0.0](https://www.npmjs.com/package/ajv-draft-04) — Ajv class for JSON Schema draft-04; source: [declared repository](https://github.com/ajv-validator/ajv-draft-04.git).
5. [ajv-errors 3.0.0](https://www.npmjs.com/package/ajv-errors) — Custom error messages in JSON Schemas for Ajv validator; source: [declared repository](https://github.com/epoberezkin/ajv-errors.git).
6. [ajv-i18n 4.2.0](https://www.npmjs.com/package/ajv-i18n) — Internationalised error messages for Ajv JSON validator; source: [declared repository](https://github.com/epoberezkin/ajv-i18n.git).
7. [@fastify/ajv-compiler 4.0.7](https://www.npmjs.com/package/@fastify/ajv-compiler) — Build and manage the AJV instances for the fastify framework; source: [declared repository](https://github.com/fastify/ajv-compiler.git).
8. [ajv-cli 5.0.0](https://www.npmjs.com/package/ajv-cli) — Command line interface for Ajv JSON schema validator; source: [declared repository](https://github.com/ajv-validator/ajv-cli.git).
9. [awesome-ajv-errors 5.1.0](https://www.npmjs.com/package/awesome-ajv-errors) — Prettified AJV errors; source: [declared repository](https://github.com/grantila/awesome-ajv-errors.git).
10. [@segment/ajv-human-errors 2.16.0](https://www.npmjs.com/package/@segment/ajv-human-errors) — Human-readable error messages for Ajv (Another JSON Schema Validator).; source: [declared repository](https://github.com/segmentio/action-destinations).

<a id="mirage-packs-presets"></a>

### Explicit data packs, presets and configuration experiments

Sources: [mirage/lib/preset-registry.mjs](../mirage/lib/preset-registry.mjs), [mirage/lib/pack-exports.mjs](../mirage/lib/pack-exports.mjs), [mirage/lib/experiment-presets.mjs](../mirage/lib/experiment-presets.mjs), [mirage/lib/organization-presets.mjs](../mirage/lib/organization-presets.mjs).

GitHub: `test scenario presets in:name,description,readme` — page 1, up to 10 results.

1. [Purple-CSGO/CSGO-Config-Presets](https://github.com/Purple-CSGO/CSGO-Config-Presets)
2. [imzyb/MiSub](https://github.com/imzyb/MiSub)
3. [larksuite/lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp)
4. [scenario-labs/skills](https://github.com/scenario-labs/skills)
5. [microsoft/STL](https://github.com/microsoft/STL)
6. [s-panferov/awesome-typescript-loader](https://github.com/s-panferov/awesome-typescript-loader) — archived
7. [nexu-io/open-design](https://github.com/nexu-io/open-design)
8. [jd-opensource/OxyGent](https://github.com/jd-opensource/OxyGent)
9. [andyzeng/visual-pushing-grasping](https://github.com/andyzeng/visual-pushing-grasping)
10. [Forethought-Technologies/AutoChain](https://github.com/Forethought-Technologies/AutoChain)

Refinement: `"test fixtures" data in:name,description language:TypeScript` — page 1, up to 10 results.

1. [divya-bharathi-24/playwright-poc](https://github.com/divya-bharathi-24/playwright-poc)
2. [lordbaldwin1/automation](https://github.com/lordbaldwin1/automation)
3. [KurtWeston/fixture-gen](https://github.com/KurtWeston/fixture-gen)
4. [RavelloH/edge-random-api](https://github.com/RavelloH/edge-random-api)
5. [binsar17/playwright-qa-automation](https://github.com/binsar17/playwright-qa-automation)
6. [ShreeRanjiniM/Playwright-Automation-Framework](https://github.com/ShreeRanjiniM/Playwright-Automation-Framework)
7. [4vyrez/vallit-readiness-remaining30-public](https://github.com/4vyrez/vallit-readiness-remaining30-public)
8. [titleshr/testtree](https://github.com/titleshr/testtree)
9. [jerry2-hobbes/db-seeding-testing-ai-rticle-backend](https://github.com/jerry2-hobbes/db-seeding-testing-ai-rticle-backend)
10. [jerry2-hobbes/db-seeding-testing-fastify-prisma-rest-api](https://github.com/jerry2-hobbes/db-seeding-testing-fastify-prisma-rest-api)

npm: `test data scenario presets` — first registry result list, up to 10 packages.

1. [scenario-mock-server 1.2.0](https://www.npmjs.com/package/scenario-mock-server) — Mock server powered by scenarios; source: [declared repository](https://github.com/kenneth-gray/scenario-mock-server.git).
2. [@smithy/types 4.19.0](https://www.npmjs.com/package/@smithy/types) — &#91;&#33;&#91;NPM version&#93;(https://img.shields.io/npm/v/@smithy/types/latest.svg)&#93;(https://www.npmjs.com/package/@smithy/types) &#91;&#33;&#91;NPM downloads&#93;(https://img.shields.io/npm/dm/@smithy/types.svg)&#93;(https://www.npmjs.com/package/@smithy/types); source: [declared repository](https://github.com/smithy-lang/smithy-typescript.git).
3. [ember-try 4.0.0](https://www.npmjs.com/package/ember-try) — An ember-cli addon to test against multiple dependencies, such as ember and ember-data.; source: [declared repository](https://github.com/ember-cli/ember-try.git).
4. [structured-data-testing-tool 4.5.0](https://www.npmjs.com/package/structured-data-testing-tool) — A library and command line tool to help test for Structured Data.; source: [declared repository](https://github.com/glitchdigital/structured-data-testing-tool.git).
5. [gherkin-lint 4.2.4](https://www.npmjs.com/package/gherkin-lint) — A Gherkin linter/validator written in javascript; source: [declared repository](https://github.com/vsiakka/gherkin-lint.git).
6. [@amiceli/vitest-cucumber 8.0.0](https://www.npmjs.com/package/@amiceli/vitest-cucumber) — vitest tools to use Gherkin feature in unit tests; source: [declared repository](https://github.com/amiceli/vitest-cucumber.git).
7. [unenv 1.10.0](https://www.npmjs.com/package/unenv) — &#96;unenv&#96; is a framework-agnostic system that allows converting JavaScript code to be platform agnostic and work in any environment including Browsers, Workers, Node.js, or JavaScript runtime.; source: [declared repository](https://github.com/unjs/unenv.git).
8. [typeson-registry 15.2.0](https://www.npmjs.com/package/typeson-registry) — The type registry for typeson; source: [declared repository](https://github.com/dfahlander/typeson-registry.git).
9. [jest-cucumber 4.5.0](https://www.npmjs.com/package/jest-cucumber) — Execute Gherkin scenarios in Jest; source: [declared repository](https://github.com/bencompton/jest-cucumber.git).
10. [@jsamr/counter-style 2.0.2](https://www.npmjs.com/package/@jsamr/counter-style) — CSS Counter Styles Level 3 and presets; source: a repository is declared in registry metadata.

<a id="mirage-model-driven-host"></a>

### Model-driven shell, Xrm API, controls and side panes

Sources: [mirage/lib/model-driven/app.mjs](../mirage/lib/model-driven/app.mjs), [mirage/lib/model-driven/client-runtime.mjs](../mirage/lib/model-driven/client-runtime.mjs), [mirage/lib/model-driven/controls.mjs](../mirage/lib/model-driven/controls.mjs).

GitHub: `Xrm model-driven mock in:name,description,readme` — page 1, up to 10 results.

1. [TALXIS/tools-devkit-templates](https://github.com/TALXIS/tools-devkit-templates)
2. [pete-mc/dataverse-powertools](https://github.com/pete-mc/dataverse-powertools)
3. [allandecastro/dataverse-erd-visualizer](https://github.com/allandecastro/dataverse-erd-visualizer)
4. [temmyraharjo/Niam.Xrm.Client](https://github.com/temmyraharjo/Niam.Xrm.Client)
5. [nickmeron/Dataverse-Web-Devtools](https://github.com/nickmeron/Dataverse-Web-Devtools)
6. [hollandcloud/powerplatform-cicd](https://github.com/hollandcloud/powerplatform-cicd)
7. [vitalmasterr/xrm-fast-dev](https://github.com/vitalmasterr/xrm-fast-dev)
8. [dataverse-ts-utils/dataverse-ts-utils](https://github.com/dataverse-ts-utils/dataverse-ts-utils)
9. [victorsolaya/bizzsummit2022](https://github.com/victorsolaya/bizzsummit2022)
10. [blakeZTL/dataverse-policy-engine](https://github.com/blakeZTL/dataverse-policy-engine)

Refinement: `xrm-mock in:name,description` — page 1, up to 10 results.

1. [davidjbclark/xrm-mock](https://github.com/davidjbclark/xrm-mock)
2. [context-and-oss/XrmMockup](https://github.com/context-and-oss/XrmMockup)
3. [davidjbclark/xrm-mock-generator](https://github.com/davidjbclark/xrm-mock-generator) — archived
4. [ambek/XrmPage-Mock](https://github.com/ambek/XrmPage-Mock)
5. [chnichol/mock-xrm](https://github.com/chnichol/mock-xrm)
6. [yagasoft/DynamicsCrm-xrm-mock-Generator](https://github.com/yagasoft/DynamicsCrm-xrm-mock-Generator) — archived
7. [Chorus/XrmMockup](https://github.com/Chorus/XrmMockup)
8. [charliechen179/xrm-mock](https://github.com/charliechen179/xrm-mock)
9. [skfd/xrm-mock](https://github.com/skfd/xrm-mock)
10. [primanator/xrm-mock](https://github.com/primanator/xrm-mock)

npm: `xrm mock model driven` — first registry result list, up to 10 packages.

1. [xrm-mock 3.6.2](https://www.npmjs.com/package/xrm-mock) — A fake implementation of the Xrm object model. Used for testing Dynamics 365 client-side scripts.; source: [declared repository](https://github.com/camelCaseDave/xrm-mock.git).
2. [@types/xrm 9.0.97](https://www.npmjs.com/package/@types/xrm) — TypeScript definitions for xrm; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
3. [msw 3.0.3](https://www.npmjs.com/package/msw) — The industry standard for API mocking in JavaScript.; source: [declared repository](https://github.com/mswjs/msw.git).
4. [jest-canvas-mock 2.5.8](https://www.npmjs.com/package/jest-canvas-mock) — Mock a canvas in your jest tests.; source: [declared repository](https://github.com/hustcc/jest-canvas-mock.git).
5. [aws-sdk-client-mock 4.1.0](https://www.npmjs.com/package/aws-sdk-client-mock) — Easy and powerful mocking of AWS SDK v3 Clients; source: [declared repository](https://github.com/m-radzikowski/aws-sdk-client-mock.git).
6. [kinesis-local 0.6.2](https://www.npmjs.com/package/kinesis-local) — A Mock API for AWS Kinesis; source: [declared repository](https://github.com/etspaceman/kinesis-mock.git).
7. [axios-mock-adapter 2.1.0](https://www.npmjs.com/package/axios-mock-adapter) — Axios adapter that allows to easily mock requests; source: [declared repository](https://github.com/ctimmerm/axios-mock-adapter.git).
8. [jest-fetch-mock 4.2.0](https://www.npmjs.com/package/jest-fetch-mock) — fetch mock for jest; source: [declared repository](https://github.com/jefflau/jest-fetch-mock.git).
9. [@vitest/spy 5.0.5](https://www.npmjs.com/package/@vitest/spy) — Lightweight Jest compatible spy implementation; source: [declared repository](https://github.com/vitest-dev/vitest.git).
10. [@strands-agents/sdk 1.22.0](https://www.npmjs.com/package/@strands-agents/sdk) — TypeScript SDK for Strands Agents framework; source: [declared repository](https://github.com/strands-agents/harness-sdk.git).

npm refinement: `xrm-mock` — first result list, up to 10 packages.

1. [xrm-mock 3.6.2](https://www.npmjs.com/package/xrm-mock) — A fake implementation of the Xrm object model. Used for testing Dynamics 365 client-side scripts.; source: [declared repository](https://github.com/camelCaseDave/xrm-mock.git).
2. [xrm-mock-generator 1.0.6](https://www.npmjs.com/package/xrm-mock-generator) — Generates a mock Xrm.Page object. Commonly used by xrm-mock to test Dynamics 365 client-side customisations.; source: [declared repository](https://github.com/camelCaseDave/xrm-mock-generator.git).
3. [@types/xrm 9.0.97](https://www.npmjs.com/package/@types/xrm) — TypeScript definitions for xrm; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
4. [@wycliffeassociates/xrm-mock 0.0.1](https://www.npmjs.com/package/@wycliffeassociates/xrm-mock) — A mock implementation of the Xrm object model. Used for testing Dynamics 365 client-side scripts.; source: [declared repository](https://github.com/WycliffeAssociates/xrm-mock.git).
5. [jest-mock 30.5.2](https://www.npmjs.com/package/jest-mock) — &#42;&#42;Note:&#42;&#42; More details on user side API can be found in &#91;Jest documentation&#93;(https://jestjs.io/docs/mock-function-api).; source: [declared repository](https://github.com/jestjs/jest.git).
6. [@wycliffeassociates/xrm-mock-generator 0.0.1](https://www.npmjs.com/package/@wycliffeassociates/xrm-mock-generator) — Generates a mock Xrm.Page object. Commonly used by xrm-mock to test Dynamics 365 client-side customisations.; source: [declared repository](https://github.com/WycliffeAssociates/xrm-mock-generator.git).
7. [msw 3.0.3](https://www.npmjs.com/package/msw) — The industry standard for API mocking in JavaScript.; source: [declared repository](https://github.com/mswjs/msw.git).
8. [node-mock-http 1.0.5](https://www.npmjs.com/package/node-mock-http) — &#60;&#33;-- automd:badges color=yellow --&#62;; source: [declared repository](https://github.com/unjs/node-mock-http.git).
9. [jest-canvas-mock 2.5.8](https://www.npmjs.com/package/jest-canvas-mock) — Mock a canvas in your jest tests.; source: [declared repository](https://github.com/hustcc/jest-canvas-mock.git).
10. [aws-sdk-client-mock 4.1.0](https://www.npmjs.com/package/aws-sdk-client-mock) — Easy and powerful mocking of AWS SDK v3 Clients; source: [declared repository](https://github.com/m-radzikowski/aws-sdk-client-mock.git).

<a id="mirage-pcf-host"></a>

### PCF field/dataset hosting and lifecycle

Sources: [mirage/lib/model-driven/pcf-runtime.mjs](../mirage/lib/model-driven/pcf-runtime.mjs), [mirage/lib/canvas-pcf.mjs](../mirage/lib/canvas-pcf.mjs), [mirage/docs/code-components.md](../mirage/docs/code-components.md).

GitHub: `PCF test harness in:name,description,readme` — page 1, up to 10 results.

1. [ot4i/perf-harness](https://github.com/ot4i/perf-harness)
2. [microsoft/powercat-code-components](https://github.com/microsoft/powercat-code-components)
3. [khoait/DCE.PCF](https://github.com/khoait/DCE.PCF)
4. [Power-Maverick/PCF-Builder-VSCode](https://github.com/Power-Maverick/PCF-Builder-VSCode)
5. [365lyf/PCFControls](https://github.com/365lyf/PCFControls)
6. [BenLBartle/PCF-AttachmentsGrid](https://github.com/BenLBartle/PCF-AttachmentsGrid)
7. [ilia-sokolov/PCF-SPFileExplorer](https://github.com/ilia-sokolov/PCF-SPFileExplorer)
8. [jaduplesms/PCF-Workbench](https://github.com/jaduplesms/PCF-Workbench)
9. [okbob/plpgsql_check](https://github.com/okbob/plpgsql_check)
10. [PacktPublishing/Extending-Microsoft-Power-Apps-with-Power-Apps-Component-Framework](https://github.com/PacktPublishing/Extending-Microsoft-Power-Apps-with-Power-Apps-Component-Framework)

npm: `pcf component test harness` — first registry result list, up to 10 packages.

1. [pcf-start 1.51.1](https://www.npmjs.com/package/pcf-start) — This package contains a module for locally hosting PowerApps Component Framework (PCF) controls. See project homepage how to install.; source: no repository declared in search metadata.
2. [@badisi/wdio-harness 5.0.0](https://www.npmjs.com/package/@badisi/wdio-harness) — WebdriverIO support for Angular component test harnesses.; source: [declared repository](https://github.com/Badisi/wdio-harness.git).
3. [pcf-scripts 1.51.1](https://www.npmjs.com/package/pcf-scripts) — This package contains a module for building PowerApps Component Framework (PCF) controls. See project homepage how to install.; source: no repository declared in search metadata.
4. [lovable-tagger 1.3.5](https://www.npmjs.com/package/lovable-tagger) — Vite plugins for component tagging and Tailwind config extraction; source: [declared repository](https://github.com/lovablelabs/lovable.git).
5. [@metaharness/darwin 0.12.1](https://www.npmjs.com/package/@metaharness/darwin) — Freeze the model, evolve the harness. Two measured applications: (1) SWE-bench code-repair — conformant GLM-&#62;Opus empty-patch cascade resolves 51.3% Lite (n=300) and 55.6% Verified (278/500, Wilson 95% CI &#91;51.2, 59.9&#93;, official swebench gold eval, no gold; source: [declared repository](https://github.com/ruvnet/metaharness.git).
6. [agentic-flow 2.1.5](https://www.npmjs.com/package/agentic-flow) — The agentic meta-harness — freeze the model, evolve the harness. An open runtime that routes each query to the cost-optimal model, evolves its own harness (planner/context/reviewer/retry/tool/memory/score policy) and autonomously repairs code, then orches; source: [declared repository](https://github.com/ruvnet/agentic-flow.git).
7. [@react-native-harness/runtime 1.6.0](https://www.npmjs.com/package/@react-native-harness/runtime) — The core test runtime that executes on React Native devices, providing Jest-compatible APIs (describe, it, expect) and managing test collection, execution, and result reporting in native environments.; source: [declared repository](https://github.com/callstackincubator/react-native-harness.git).
8. [@react-native-harness/babel-preset 1.6.0](https://www.npmjs.com/package/@react-native-harness/babel-preset) — &#33;&#91;harness-banner&#93;(https://react-native-harness.dev/harness-banner.jpg); source: no repository declared in search metadata.
9. [@jscutlery/cypress-harness 0.8.17](https://www.npmjs.com/package/@jscutlery/cypress-harness) — Both unit-testing and e2e testing can get tricky when it comes to interacting with the DOM. In fact, &#42;&#42;tests have to be decoupled from the implementation details of the code they test&#42;&#42;. Especially if you are interacting with same components of an app in ; source: [declared repository](https://github.com/jscutlery/devkit).
10. [fast-decode-uri-component 1.0.1](https://www.npmjs.com/package/fast-decode-uri-component) — Fast and safe decodeURIComponent; source: [declared repository](https://github.com/delvedor/fast-decode-uri-component.git).

npm refinement: `componentframework-mock` — first result list, up to 10 packages.

1. [@shko.online/componentframework-mock-cli 0.1.0](https://www.npmjs.com/package/@shko.online/componentframework-mock-cli) — Command line interface for @shko.online/componentframework-mock; source: no repository declared in search metadata.
2. [@shko.online/componentframework-mock 0.11.2](https://www.npmjs.com/package/@shko.online/componentframework-mock) — Mocking library to help with testing PowerApps Component Framework Components; source: [declared repository](https://github.com/Shko-Online/ComponentFramework-Mock.git).
3. [jest-mock 30.5.2](https://www.npmjs.com/package/jest-mock) — &#42;&#42;Note:&#42;&#42; More details on user side API can be found in &#91;Jest documentation&#93;(https://jestjs.io/docs/mock-function-api).; source: [declared repository](https://github.com/jestjs/jest.git).
4. [msw 3.0.3](https://www.npmjs.com/package/msw) — The industry standard for API mocking in JavaScript.; source: [declared repository](https://github.com/mswjs/msw.git).
5. [node-mock-http 1.0.5](https://www.npmjs.com/package/node-mock-http) — &#60;&#33;-- automd:badges color=yellow --&#62;; source: [declared repository](https://github.com/unjs/node-mock-http.git).
6. [jest-canvas-mock 2.5.8](https://www.npmjs.com/package/jest-canvas-mock) — Mock a canvas in your jest tests.; source: [declared repository](https://github.com/hustcc/jest-canvas-mock.git).
7. [aws-sdk-client-mock 4.1.0](https://www.npmjs.com/package/aws-sdk-client-mock) — Easy and powerful mocking of AWS SDK v3 Clients; source: [declared repository](https://github.com/m-radzikowski/aws-sdk-client-mock.git).
8. [kinesis-local 0.6.2](https://www.npmjs.com/package/kinesis-local) — A Mock API for AWS Kinesis; source: [declared repository](https://github.com/etspaceman/kinesis-mock.git).
9. [jest-mock-extended 4.0.2](https://www.npmjs.com/package/jest-mock-extended) — Type safe mocking extensions for jest; source: [declared repository](https://github.com/marchaos/jest-mock-extended.git).
10. [axios-mock-adapter 2.1.0](https://www.npmjs.com/package/axios-mock-adapter) — Axios adapter that allows to easily mock requests; source: [declared repository](https://github.com/ctimmerm/axios-mock-adapter.git).

<a id="mirage-canvas-power-fx"></a>

### Canvas import/player and Power Fx interpretation

Sources: [mirage/lib/canvas-source.mjs](../mirage/lib/canvas-source.mjs), [mirage/lib/canvas-runtime.mjs](../mirage/lib/canvas-runtime.mjs), [mirage/lib/canvas-player.mjs](../mirage/lib/canvas-player.mjs), [mirage/lib/power-fx.mjs](../mirage/lib/power-fx.mjs).

GitHub: `"Power Fx" interpreter in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/Power-Fx](https://github.com/microsoft/Power-Fx)
2. [ascoders/weekly](https://github.com/ascoders/weekly)
3. [linsa-io/programming-languages](https://github.com/linsa-io/programming-languages)
4. [ChessMax/awesome-programming-languages](https://github.com/ChessMax/awesome-programming-languages)
5. [scalable-dynamics/PowerNote](https://github.com/scalable-dynamics/PowerNote)
6. [microsoft/Rexl](https://github.com/microsoft/Rexl)
7. [danielgerlag/powerfx-rust](https://github.com/danielgerlag/powerfx-rust)
8. [Pi-0r-Tau/PowerFXFormulaChecker](https://github.com/Pi-0r-Tau/PowerFXFormulaChecker)
9. [LellaSriHarsha/power-platform-hub](https://github.com/LellaSriHarsha/power-platform-hub)
10. [iamdroppy/PowerFxLinq](https://github.com/iamdroppy/PowerFxLinq)

npm: `power fx interpreter canvas` — first registry result list, up to 10 packages.

1. [vega-interpreter 2.3.2](https://www.npmjs.com/package/vega-interpreter) — CSP-compliant interpreter for Vega expressions.; source: [declared repository](https://github.com/vega/vega.git).
2. [@e2b/code-interpreter 2.9.0](https://www.npmjs.com/package/@e2b/code-interpreter) — E2B Code Interpreter - Stateful code execution; source: [declared repository](https://github.com/e2b-dev/e2b.git).
3. [@napi-rs/canvas 1.0.13](https://www.npmjs.com/package/@napi-rs/canvas) — Canvas for Node.js with skia backend; source: [declared repository](https://github.com/Brooooooklyn/canvas.git).
4. [fx 40.0.1](https://www.npmjs.com/package/fx) — Command-line JSON viewer; source: [declared repository](https://github.com/antonmedv/fx.git).
5. [fx-runner 1.7.0](https://www.npmjs.com/package/fx-runner) — A node cli to control Firefox; source: a repository is declared in registry metadata.
6. [@napi-rs/canvas-linux-x64-gnu 1.0.13](https://www.npmjs.com/package/@napi-rs/canvas-linux-x64-gnu) — Canvas for Node.js with skia backend; source: [declared repository](https://github.com/Brooooooklyn/canvas.git).
7. [canvas-confetti 1.9.4](https://www.npmjs.com/package/canvas-confetti) — performant confetti animation in the browser; source: [declared repository](https://github.com/catdad/canvas-confetti.git).
8. [canvas 3.2.3](https://www.npmjs.com/package/canvas) — Canvas graphics API backed by Cairo; source: a repository is declared in registry metadata.
9. [@napi-rs/canvas-linux-x64-musl 1.0.13](https://www.npmjs.com/package/@napi-rs/canvas-linux-x64-musl) — Canvas for Node.js with skia backend; source: [declared repository](https://github.com/Brooooooklyn/canvas.git).
10. [jest-canvas-mock 2.5.8](https://www.npmjs.com/package/jest-canvas-mock) — Mock a canvas in your jest tests.; source: [declared repository](https://github.com/hustcc/jest-canvas-mock.git).

npm refinement: `powerfx` — first result list, up to 10 packages.

1. [@microsoft/power-fx-formulabar 6.0.10](https://www.npmjs.com/package/@microsoft/power-fx-formulabar) — PowerFx Formula bar; source: no repository declared in search metadata.
2. [@toy-box/powerfx-editor 1.0.3-alpha.12](https://www.npmjs.com/package/@toy-box/powerfx-editor) — ### Install; source: no repository declared in search metadata.
3. [@toy-box/meta-powerfx 2.0.35](https://www.npmjs.com/package/@toy-box/meta-powerfx) — No description; source: no repository declared in search metadata.
4. [@toy-box/powerfx-worker 1.0.3-alpha.12](https://www.npmjs.com/package/@toy-box/powerfx-worker) — ### Install; source: no repository declared in search metadata.
5. [@toy-box/powerfx-core 1.0.3-alpha.12](https://www.npmjs.com/package/@toy-box/powerfx-core) — ### Install; source: no repository declared in search metadata.
6. [wt-powerfx 1.0.1](https://www.npmjs.com/package/wt-powerfx) — Enhanced effects for Windows Terminal – keystroke sounds, particle overlay, window shake; source: no repository declared in search metadata.

<a id="mirage-code-apps"></a>

### Code Apps local host and SDK compatibility

Sources: [mirage/lib/code-apps-http.mjs](../mirage/lib/code-apps-http.mjs), [mirage/lib/code-apps-vite.mjs](../mirage/lib/code-apps-vite.mjs), [mirage/lib/code-apps-sdk.js](../mirage/lib/code-apps-sdk.js), [mirage/lib/code-apps-client.js](../mirage/lib/code-apps-client.js).

GitHub: `"Power Apps" "code apps" in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/PowerAppsCodeApps](https://github.com/microsoft/PowerAppsCodeApps)
2. [microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills)
3. [scottdurow/PowerAppsCodeAppsDemos](https://github.com/scottdurow/PowerAppsCodeAppsDemos)
4. [microsoft/workshop-library](https://github.com/microsoft/workshop-library) — archived
5. [DanielKerridge/claude-code-power-platform-skills](https://github.com/DanielKerridge/claude-code-power-platform-skills)
6. [steedos/awesome-low-code](https://github.com/steedos/awesome-low-code)
7. [nunosubtil/paca-modern-web-app-sample](https://github.com/nunosubtil/paca-modern-web-app-sample)
8. [geekfujiwara/CodeAppsDevelopmentStandard](https://github.com/geekfujiwara/CodeAppsDevelopmentStandard)
9. [microsoft/power-cat-skills](https://github.com/microsoft/power-cat-skills)
10. [microsoft/hack-workshop-power-apps](https://github.com/microsoft/hack-workshop-power-apps) — archived

npm: `power apps code apps sdk` — first registry result list, up to 10 packages.

1. [@base44/sdk 0.8.57](https://www.npmjs.com/package/@base44/sdk) — JavaScript SDK for Base44 API; source: [declared repository](https://github.com/base44/javascript-sdk.git).
2. [@anthropic-ai/claude-agent-sdk 0.3.312](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) — SDK for building AI agents with Claude Code's capabilities. Programmatically interact with Claude to build autonomous agents that can understand codebases, edit files, and execute workflows.; source: [declared repository](https://github.com/anthropics/claude-agent-sdk-typescript.git).
3. [@microsoft/power-apps 1.5.0](https://www.npmjs.com/package/@microsoft/power-apps) — Power Apps SDK; source: no repository declared in search metadata.
4. [@safe-global/safe-apps-sdk 9.1.0](https://www.npmjs.com/package/@safe-global/safe-apps-sdk) — SDK developed to integrate third-party apps with Safe app.; source: [declared repository](https://github.com/safe-global/safe-apps-sdk.git).
5. [@microsoft/power-apps-vite 1.0.13](https://www.npmjs.com/package/@microsoft/power-apps-vite) — Vite plugin for Power Apps; source: no repository declared in search metadata.
6. [@hubspot/api-client 14.1.2](https://www.npmjs.com/package/@hubspot/api-client) — NodeJS v3 &#91;HubSpot API&#93;(https://developers.hubspot.com/docs/api/overview) SDK(Client) files; source: [declared repository](https://github.com/HubSpot/hubspot-api-nodejs.git).
7. [@modelcontextprotocol/ext-apps 2.0.4](https://www.npmjs.com/package/@modelcontextprotocol/ext-apps) — MCP Apps SDK — Enable MCP servers to display interactive user interfaces in conversational clients.; source: [declared repository](https://github.com/modelcontextprotocol/ext-apps.git).
8. [@slack/oauth 4.0.0](https://www.npmjs.com/package/@slack/oauth) — Official library for interacting with Slack's Oauth endpoints; source: [declared repository](https://github.com/slackapi/node-slack-sdk.git).
9. [@openai/apps-sdk-ui 0.2.2](https://www.npmjs.com/package/@openai/apps-sdk-ui) — Design system for building apps for ChatGPT with Apps SDK; source: [declared repository](https://github.com/openai/apps-sdk-ui.git).
10. [@telegram-apps/sdk 3.11.8](https://www.npmjs.com/package/@telegram-apps/sdk) — TypeScript Source Development Kit for Telegram Mini Apps client application.; source: a repository is declared in registry metadata.

<a id="mirage-virtual-elastic"></a>

### Virtual table providers and elastic/Cosmos queries

Sources: [mirage/lib/dataverse-virtual-providers.mjs](../mirage/lib/dataverse-virtual-providers.mjs), [mirage/lib/dataverse-elastic.mjs](../mirage/lib/dataverse-elastic.mjs), [mirage/lib/dataverse-cosmos-query.mjs](../mirage/lib/dataverse-cosmos-query.mjs).

GitHub: `Dataverse virtual elastic in:name,description,readme` — page 1, up to 10 results.

1. [CenterForOpenScience/scrapi](https://github.com/CenterForOpenScience/scrapi)
2. [telekom-security/tpotce](https://github.com/telekom-security/tpotce)
3. [mzazon/cloud-projects](https://github.com/mzazon/cloud-projects)
4. [CoronaWhy/coronawhy-infrastructure](https://github.com/CoronaWhy/coronawhy-infrastructure)
5. [4tikhonov/covid-19-infrastructure](https://github.com/4tikhonov/covid-19-infrastructure)
6. [bhakthan/awesome-microsoft-fabric](https://github.com/bhakthan/awesome-microsoft-fabric)
7. [BU-NU-CLOUD-F19/A_Kubernetes_based_on-demand_research_computing_environment_on_the_MOC](https://github.com/BU-NU-CLOUD-F19/A_Kubernetes_based_on-demand_research_computing_environment_on_the_MOC)
8. [UCLALibrary/central-search-tools](https://github.com/UCLALibrary/central-search-tools)
9. [JosephUrciuoli/serverless-nlp](https://github.com/JosephUrciuoli/serverless-nlp)
10. [mango91/myppjourney](https://github.com/mango91/myppjourney)

Refinement: `"Dataverse" "elastic tables" in:readme` — page 1, up to 10 results.

1. [TALXIS/tools-devkit-templates](https://github.com/TALXIS/tools-devkit-templates)
2. [AymericM78/Xrm.DataManager.Framework](https://github.com/AymericM78/Xrm.DataManager.Framework)
3. [TarogStar/DataverseFakes](https://github.com/TarogStar/DataverseFakes)
4. [guess-sush/4sDynamics](https://github.com/guess-sush/4sDynamics)
5. [fooshen/Excel2DataverseSample](https://github.com/fooshen/Excel2DataverseSample)
6. [alexander-you/D365-CIJ-Meta-Integration](https://github.com/alexander-you/D365-CIJ-Meta-Integration)
7. [mango91/myppjourney](https://github.com/mango91/myppjourney)
8. [filcole/DataverseFakes](https://github.com/filcole/DataverseFakes)
9. [zmissoum/colvio](https://github.com/zmissoum/colvio)
10. [sss-dclemente/dataverse-mcp-pro](https://github.com/sss-dclemente/dataverse-mcp-pro)

npm: `dataverse virtual table cosmos` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [webpack-virtual-modules 0.6.2](https://www.npmjs.com/package/webpack-virtual-modules) — Webpack Virtual Modules; source: [declared repository](https://github.com/sysgears/webpack-virtual-modules.git).
3. [@azure/cosmos 4.10.1](https://www.npmjs.com/package/@azure/cosmos) — Microsoft Azure Cosmos DB Service Node.js SDK for NOSQL API; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
4. [@cosmjs/stargate 0.39.0](https://www.npmjs.com/package/@cosmjs/stargate) — Utilities for Cosmos SDK 0.40; source: [declared repository](https://github.com/cosmos/cosmjs/tree/main/packages/stargate).
5. [ng-table-virtual-scroll 1.6.1](https://www.npmjs.com/package/ng-table-virtual-scroll) — Virtual scroll for for Angular Material Table; source: a repository is declared in registry metadata.
6. [@zondax/ledger-cosmos-js 4.2.0](https://www.npmjs.com/package/@zondax/ledger-cosmos-js) — Node API for Cosmos App (Ledger Nano S/S+/X); source: [declared repository](https://github.com/Zondax/ledger-cosmos-js.git).
7. [rc-virtual-list 3.19.2](https://www.npmjs.com/package/rc-virtual-list) — React Virtual List Component; source: [declared repository](https://github.com/react-component/virtual-list.git).
8. [react-virtual 2.10.4](https://www.npmjs.com/package/react-virtual) — Hooks for virtualizing scrollable elements in React; source: [declared repository](https://github.com/tannerlinsley/react-virtual.git).
9. [@rc-component/virtual-list 1.6.0](https://www.npmjs.com/package/@rc-component/virtual-list) — Virtual scrolling list component for React.; source: [declared repository](https://github.com/react-component/virtual-list.git).
10. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).

<a id="mirage-search-duplicates"></a>

### Dataverse/portal search, duplicate detection and hierarchy

Sources: [mirage/lib/dataverse-search.mjs](../mirage/lib/dataverse-search.mjs), [mirage/lib/portal-search.mjs](../mirage/lib/portal-search.mjs), [mirage/lib/dataverse-duplicates.mjs](../mirage/lib/dataverse-duplicates.mjs), [mirage/lib/dataverse-hierarchy.mjs](../mirage/lib/dataverse-hierarchy.mjs).

GitHub: `Dataverse search duplicates in:name,description,readme` — page 1, up to 10 results.

1. [meagmohit/EEG-Datasets](https://github.com/meagmohit/EEG-Datasets)
2. [microsoft/mcp](https://github.com/microsoft/mcp)
3. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)
4. [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
5. [microsoft/Agent-for-Contract-Processing-Solution-Accelerator](https://github.com/microsoft/Agent-for-Contract-Processing-Solution-Accelerator) — archived
6. [context-and-oss/XrmBedrock](https://github.com/context-and-oss/XrmBedrock)
7. [Roelzz/mcs-agent-analyser](https://github.com/Roelzz/mcs-agent-analyser)
8. [Power-Maverick/PPTB-Tools](https://github.com/Power-Maverick/PPTB-Tools)
9. [codeurali/mcp-dataverse](https://github.com/codeurali/mcp-dataverse)
10. [mohsinonxrm/pptb-mxrm-fetchxml-studio](https://github.com/mohsinonxrm/pptb-mxrm-fetchxml-studio)

npm: `dataverse search duplicate detection` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [@babel/plugin-transform-duplicate-named-capturing-groups-regex 8.0.1](https://www.npmjs.com/package/@babel/plugin-transform-duplicate-named-capturing-groups-regex) — Compile regular expressions using duplicate named groups to index-based groups.; source: [declared repository](https://github.com/babel/babel.git).
3. [@babel/plugin-transform-duplicate-keys 8.0.1](https://www.npmjs.com/package/@babel/plugin-transform-duplicate-keys) — Compile objects with duplicate keys to valid strict ES5; source: [declared repository](https://github.com/babel/babel.git).
4. [issue-parser 7.0.2](https://www.npmjs.com/package/issue-parser) — Parser for Github, GitLab and Bitbucket issues actions, references and mentions; source: [declared repository](https://github.com/semantic-release/issue-parser.git).
5. [wink-bm25-text-search 3.1.2](https://www.npmjs.com/package/wink-bm25-text-search) — Configurable BM25 Text Search Engine with simple semantic search support; source: [declared repository](https://github.com/winkjs/wink-bm25-text-search.git).
6. [optimize-css-assets-webpack-plugin 6.0.1](https://www.npmjs.com/package/optimize-css-assets-webpack-plugin) — A Webpack plugin to optimize \ minimize CSS assets.; source: a repository is declared in registry metadata.
7. [@aws-sdk/middleware-recursion-detection 3.972.53](https://www.npmjs.com/package/@aws-sdk/middleware-recursion-detection) — &#91;&#33;&#91;NPM version&#93;(https://img.shields.io/npm/v/@aws-sdk/middleware-recursion-detection/latest.svg)&#93;(https://www.npmjs.com/package/@aws-sdk/middleware-recursion-detection) &#91;&#33;&#91;NPM downloads&#93;(https://img.shields.io/npm/dm/@aws-sdk/middleware-recursion-detectio; source: [declared repository](https://github.com/aws/aws-sdk-js-v3.git).
8. [@angular-eslint/eslint-plugin-template 22.6.0](https://www.npmjs.com/package/@angular-eslint/eslint-plugin-template) — ESLint plugin for Angular Templates; source: [declared repository](https://github.com/angular-eslint/angular-eslint.git).
9. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
10. [std-env 4.3.0](https://www.npmjs.com/package/std-env) — Runtime agnostic JS utils; source: a repository is declared in registry metadata.

<a id="mirage-files-images"></a>

### File/image columns, attachments and block/range transfers

Sources: [mirage/lib/dataverse-files.mjs](../mirage/lib/dataverse-files.mjs), [mirage/lib/dataverse-storage-routing.mjs](../mirage/lib/dataverse-storage-routing.mjs), [mirage/lib/storage-provider.mjs](../mirage/lib/storage-provider.mjs).

GitHub: `Dataverse file upload in:name,description,readme` — page 1, up to 10 results.

1. [gdcc/pyDataverse](https://github.com/gdcc/pyDataverse)
2. [IQSS/dataverse-docker](https://github.com/IQSS/dataverse-docker)
3. [Power-Maverick/DataverseDevTools-VSCode](https://github.com/Power-Maverick/DataverseDevTools-VSCode)
4. [IQSS/dataverse-uploader](https://github.com/IQSS/dataverse-uploader)
5. [GlobalDataverseCommunityConsortium/dataverse-uploader](https://github.com/GlobalDataverseCommunityConsortium/dataverse-uploader)
6. [seanmcne/OrgDbOrgSettings](https://github.com/seanmcne/OrgDbOrgSettings)
7. [microsoft/PowerPlatform-DataverseClient-Python](https://github.com/microsoft/PowerPlatform-DataverseClient-Python)
8. [IQSS/dataverse-client-r](https://github.com/IQSS/dataverse-client-r)
9. [phuocle/Dynamics-Crm-DevKit](https://github.com/phuocle/Dynamics-Crm-DevKit)
10. [microsoft/power-pages-samples](https://github.com/microsoft/power-pages-samples)

Refinement: `"Dataverse" "block upload" in:readme` — page 1, up to 10 results.

1. [ramarao9/AttachmentUploader](https://github.com/ramarao9/AttachmentUploader)
2. [kinosker/Power-Automate-Copilot-DevKit](https://github.com/kinosker/Power-Automate-Copilot-DevKit)
3. [zbcevik/BulkLoadData_bash](https://github.com/zbcevik/BulkLoadData_bash)
4. [ritza-co/bryntum-power-apps-pcf-demo-all-products](https://github.com/ritza-co/bryntum-power-apps-pcf-demo-all-products)
5. [MSLavoieRT/Power-Automate-Copilot-DevKit](https://github.com/MSLavoieRT/Power-Automate-Copilot-DevKit)

npm: `dataverse file block upload` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [@zag-js/file-upload 1.47.0](https://www.npmjs.com/package/@zag-js/file-upload) — Core logic for the file-upload widget implemented as a state machine; source: [declared repository](https://github.com/chakra-ui/zag/tree/main/packages/file-upload).
3. [cypress-file-upload 5.0.8](https://www.npmjs.com/package/cypress-file-upload) — A Cypress command for file upload; source: [declared repository](https://github.com/abramenal/cypress-file-upload.git).
4. [@flmngr/flmngr-react 2.0.13](https://www.npmjs.com/package/@flmngr/flmngr-react) — Flmngr file manager UI component for React; source: no repository declared in search metadata.
5. [graphql-upload 18.0.1](https://www.npmjs.com/package/graphql-upload) — Middleware and a scalar Upload to add support for GraphQL multipart requests (file uploads via queries and mutations) to various Node.js GraphQL servers.; source: [declared repository](https://github.com/jaydenseric/graphql-upload.git).
6. [filepond-plugin-file-validate-size 2.2.8](https://www.npmjs.com/package/filepond-plugin-file-validate-size) — File Size Validation Plugin for FilePond; source: [declared repository](https://github.com/pqina/filepond-plugin-file-validate-size.git).
7. [apollo-upload-client 20.0.0](https://www.npmjs.com/package/apollo-upload-client) — A terminating Apollo Link for Apollo Client that fetches a GraphQL multipart request if the GraphQL variables contain files (by default FileList, File, or Blob instances), or else fetches a regular GraphQL POST or GET request (depending on the config and ; source: [declared repository](https://github.com/jaydenseric/apollo-upload-client.git).
8. [ng-file-upload 12.2.13](https://www.npmjs.com/package/ng-file-upload) — An AngularJS directive for file upload using HTML5 with FileAPI polyfill for unsupported browsers; source: [declared repository](https://github.com/danialfarid/ng-file-upload.git).
9. [ng2-file-upload 12.0.0](https://www.npmjs.com/package/ng2-file-upload) — Angular file uploader; source: a repository is declared in registry metadata.
10. [blueimp-file-upload 10.32.0](https://www.npmjs.com/package/blueimp-file-upload) — File Upload widget with multiple file selection, drag&#38;drop support, progress bar, validation and preview images, audio and video for jQuery. Supports cross-domain, chunked and resumable file uploads. Works with any server-side platform (Google App Engine,; source: a repository is declared in registry metadata.

<a id="mirage-blob-storage"></a>

### Blob providers, signed access and Azurite compatibility

Sources: [mirage/lib/storage-local-disk.mjs](../mirage/lib/storage-local-disk.mjs), [mirage/lib/storage-memory.mjs](../mirage/lib/storage-memory.mjs), [mirage/lib/storage-azurite.mjs](../mirage/lib/storage-azurite.mjs).

GitHub: `Blob emulator SAS in:name,description,readme` — page 1, up to 10 results.

1. [Azure/Azurite](https://github.com/Azure/Azurite)
2. [floci-io/floci-az](https://github.com/floci-io/floci-az)
3. [jakeFeldman/strapi-provider-upload-azure-storage](https://github.com/jakeFeldman/strapi-provider-upload-azure-storage)
4. [Azure/azure-sdk-for-php](https://github.com/Azure/azure-sdk-for-php) — archived
5. [arafato/azurite](https://github.com/arafato/azurite) — archived
6. [Azure-Samples/storage-dotnet-sas-getting-started](https://github.com/Azure-Samples/storage-dotnet-sas-getting-started) — archived
7. [samuelm2/vid2scene](https://github.com/samuelm2/vid2scene)
8. [gopala-kr/ai-learning-roadmap](https://github.com/gopala-kr/ai-learning-roadmap)
9. [microsoft/CollectServiceFabricData](https://github.com/microsoft/CollectServiceFabricData)
10. [csimplestring/delta-go](https://github.com/csimplestring/delta-go)

npm: `azure blob emulator sas` — first registry result list, up to 10 packages.

1. [@azure/storage-blob 12.34.0](https://www.npmjs.com/package/@azure/storage-blob) — Microsoft Azure Storage SDK for JavaScript - Blob; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
2. [@azure/data-tables 13.3.2](https://www.npmjs.com/package/@azure/data-tables) — An isomorphic client library for the Azure Tables service.; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
3. [@azure/storage-queue 12.32.0](https://www.npmjs.com/package/@azure/storage-queue) — Microsoft Azure Storage SDK for JavaScript - Queue; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
4. [@azure/identity 4.14.0](https://www.npmjs.com/package/@azure/identity) — Provides credential implementations for Azure SDK libraries that can authenticate with Microsoft Entra ID; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
5. [@azure/keyvault-common 2.1.0](https://www.npmjs.com/package/@azure/keyvault-common) — Common internal functionality for all of the Azure Key Vault clients in the Azure SDK for JavaScript; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
6. [@azure/storage-file-datalake 12.31.0](https://www.npmjs.com/package/@azure/storage-file-datalake) — Microsoft Azure Storage SDK for JavaScript - DataLake; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
7. [@azure/core-util 1.14.0](https://www.npmjs.com/package/@azure/core-util) — Core library for shared utility methods; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
8. [@azure/core-xml 1.6.0](https://www.npmjs.com/package/@azure/core-xml) — Core library for interacting with XML payloads; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
9. [@azure/core-tracing 1.4.0](https://www.npmjs.com/package/@azure/core-tracing) — Provides low-level interfaces and helper methods for tracing in Azure SDK; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
10. [@azure-rest/core-client 2.9.0](https://www.npmjs.com/package/@azure-rest/core-client) — Core library for interfacing with Azure Rest Clients; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).

npm refinement: `azurite` — first result list, up to 10 packages.

1. [azurite 3.37.0](https://www.npmjs.com/package/azurite) — An open source Azure Storage API compatible server; source: [declared repository](https://github.com/azure/azurite.git).
2. [@testcontainers/azurite 12.2.1](https://www.npmjs.com/package/@testcontainers/azurite) — Azurite module for Testcontainers; source: [declared repository](https://github.com/testcontainers/testcontainers-node.git).
3. [@keleshteri/azurite-monitor 1.3.1](https://www.npmjs.com/package/@keleshteri/azurite-monitor) — Monitor Azurite blob storage for changes and send events.; source: no repository declared in search metadata.
4. [@nir.arad/unified-blob-storage 1.4.1](https://www.npmjs.com/package/@nir.arad/unified-blob-storage) — Unified blob storage interface supporting Vercel Blob, Azure Blob Storage, and Azurite; source: [declared repository](https://github.com/nirarad/unified-blob-storage.git).
5. [@pagopa/io-functions-commons 32.1.0](https://www.npmjs.com/package/@pagopa/io-functions-commons) — Common code for Azure functions; source: [declared repository](https://github.com/pagopa/io-functions-commons.git).
6. [@defra/bng-geoprocessing-service 1.173.0](https://www.npmjs.com/package/@defra/bng-geoprocessing-service) — Geoprocessing service for Biodiversity Net Gain; source: [declared repository](https://github.com/DEFRA/biodiversity-net-gain-service).
7. [gg-team-azurite-smelly 1.0.0](https://www.npmjs.com/package/gg-team-azurite-smelly) — Paket dibuat oleh Bot GG Team AI; source: [declared repository](https://github.com/zoonai/zona-a.git).
8. [@defra/bng-azure-storage-test-utils 1.195.0](https://www.npmjs.com/package/@defra/bng-azure-storage-test-utils) — Azure storage related test utilities for Biodiversity Net Gain; source: [declared repository](https://github.com/DEFRA/biodiversity-net-gain-service/azure-storage-test-utils).
9. [@osva-ai/adapter-artifact-azure 0.1.0](https://www.npmjs.com/package/@osva-ai/adapter-artifact-azure) — Azure Blob Storage ArtifactBlobStore adapter for OSVA (operator-configured credentials); source: [declared repository](https://github.com/Osva-AI/osva-adapters.git).
10. [@mayurajs/filestorage-azure-blob 1.2.0](https://www.npmjs.com/package/@mayurajs/filestorage-azure-blob) — Azure Blob Storage for Mayura's file stores, over the Blob REST API.; source: [declared repository](https://github.com/KartikeyAI/mayura.git).

<a id="mirage-sharepoint-documents"></a>

### SharePoint document locations and operations

Sources: [mirage/lib/sharepoint-contract.mjs](../mirage/lib/sharepoint-contract.mjs), [mirage/lib/sharepoint-documents.mjs](../mirage/lib/sharepoint-documents.mjs), [mirage/docs/sharepoint.md](../mirage/docs/sharepoint.md).

GitHub: `Dataverse SharePoint documents in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/mcp](https://github.com/microsoft/mcp)
2. [microsoft/mcs-labs](https://github.com/microsoft/mcs-labs)
3. [microsoft/Agent-for-Contract-Processing-Solution-Accelerator](https://github.com/microsoft/Agent-for-Contract-Processing-Solution-Accelerator) — archived
4. [microsoft/power-pages-samples](https://github.com/microsoft/power-pages-samples)
5. [bcgov/jag-lcrb-carla-public](https://github.com/bcgov/jag-lcrb-carla-public)
6. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
7. [ilia-sokolov/PCF-SPFileExplorer](https://github.com/ilia-sokolov/PCF-SPFileExplorer)
8. [troystaylor/SharingIsCaring](https://github.com/troystaylor/SharingIsCaring)
9. [microsoft/agent-for-hr-service-solution-accelerator](https://github.com/microsoft/agent-for-hr-service-solution-accelerator) — archived
10. [microsoft/ai-agent-runbooks](https://github.com/microsoft/ai-agent-runbooks)

npm: `sharepoint document management mock` — first registry result list, up to 10 packages.

1. [storybook-addon-module-mock 1.6.3](https://www.npmjs.com/package/storybook-addon-module-mock) — &#91;&#33;&#91;&#93;(https://img.shields.io/npm/l/storybook-addon-module-mock)&#93;(https://www.npmjs.com/package/storybook-addon-module-mock) &#91;&#33;&#91;&#93;(https://img.shields.io/npm/v/storybook-addon-module-mock)&#93;(https://www.npmjs.com/package/storybook-addon-module-mock) &#91;&#33;&#91;&#93;(http; source: [declared repository](https://github.com/ReactLibraries/storybook-addon-module-mock).
2. [jest-mock-axios 4.9.1](https://www.npmjs.com/package/jest-mock-axios) — Axios mock for Jest; source: [declared repository](https://github.com/knee-cola/jest-mock-axios.git).
3. [msw 3.0.3](https://www.npmjs.com/package/msw) — The industry standard for API mocking in JavaScript.; source: [declared repository](https://github.com/mswjs/msw.git).
4. [@open-rpc/mock-server 1.7.8](https://www.npmjs.com/package/@open-rpc/mock-server) — Provides a mock JSON-RPC API given an OpenRPC Document; source: [declared repository](https://github.com/open-rpc/mock-server.git).
5. [jest-canvas-mock 2.5.8](https://www.npmjs.com/package/jest-canvas-mock) — Mock a canvas in your jest tests.; source: [declared repository](https://github.com/hustcc/jest-canvas-mock.git).
6. [aws-sdk-client-mock 4.1.0](https://www.npmjs.com/package/aws-sdk-client-mock) — Easy and powerful mocking of AWS SDK v3 Clients; source: [declared repository](https://github.com/m-radzikowski/aws-sdk-client-mock.git).
7. [@fetch-mock/vitest 0.2.18](https://www.npmjs.com/package/@fetch-mock/vitest) — Vitest wrapper for fetch-mock; source: [declared repository](https://github.com/wheresrhys/fetch-mock.git).
8. [kinesis-local 0.6.2](https://www.npmjs.com/package/kinesis-local) — A Mock API for AWS Kinesis; source: [declared repository](https://github.com/etspaceman/kinesis-mock.git).
9. [axios-mock-adapter 2.1.0](https://www.npmjs.com/package/axios-mock-adapter) — Axios adapter that allows to easily mock requests; source: [declared repository](https://github.com/ctimmerm/axios-mock-adapter.git).
10. [@fetch-mock/jest 0.2.20](https://www.npmjs.com/package/@fetch-mock/jest) — jest wrapper for fetch-mock; source: [declared repository](https://github.com/wheresrhys/fetch-mock.git).

<a id="mirage-state-persistence"></a>

### Durable state, streamed checkpoints, journals and migrations

Sources: [mirage/lib/state-storage.mjs](../mirage/lib/state-storage.mjs), [mirage/lib/state-stream.mjs](../mirage/lib/state-stream.mjs), [mirage/lib/state-migration.mjs](../mirage/lib/state-migration.mjs), [mirage/lib/transactional-files.mjs](../mirage/lib/transactional-files.mjs).

GitHub: `JSON checkpoint journal in:name,description,readme` — page 1, up to 10 results.

1. [facebookresearch/segment-anything](https://github.com/facebookresearch/segment-anything)
2. [google-research/bert](https://github.com/google-research/bert) — archived
3. [lucas-maes/le-wm](https://github.com/lucas-maes/le-wm)
4. [HuangJunJie2017/BEVDet](https://github.com/HuangJunJie2017/BEVDet)
5. [thtrieu/darkflow](https://github.com/thtrieu/darkflow)
6. [smthemex/ComfyUI_Sonic](https://github.com/smthemex/ComfyUI_Sonic)
7. [deepmodeling/deepmd-kit](https://github.com/deepmodeling/deepmd-kit)
8. [foolwood/SiamMask](https://github.com/foolwood/SiamMask)
9. [xinyu1205/recognize-anything](https://github.com/xinyu1205/recognize-anything)
10. [ruotianluo/ImageCaptioning.pytorch](https://github.com/ruotianluo/ImageCaptioning.pytorch)

Refinement: `"append-only" json in:readme language:JavaScript` — page 1, up to 10 results.

1. [draftbit/avatar-generator](https://github.com/draftbit/avatar-generator)
2. [orbitdb/orbitdb](https://github.com/orbitdb/orbitdb)
3. [felixge/node-dirty](https://github.com/felixge/node-dirty)
4. [kunchenguid/kun](https://github.com/kunchenguid/kun)
5. [phungkaizen/maintainer-autopilot](https://github.com/phungkaizen/maintainer-autopilot)
6. [ssbc/ssb-server](https://github.com/ssbc/ssb-server)
7. [sciencefair-land/sciencefair](https://github.com/sciencefair-land/sciencefair)
8. [mafintosh/append-tree](https://github.com/mafintosh/append-tree)
9. [mafintosh/flat-file-db](https://github.com/mafintosh/flat-file-db)
10. [Forward-Future/loopy](https://github.com/Forward-Future/loopy)

npm: `json database checkpoint journal` — first registry result list, up to 10 packages.

1. [mime-db 1.54.0](https://www.npmjs.com/package/mime-db) — Media Type Database; source: [declared repository](https://github.com/jshttp/mime-db.git).
2. [@langchain/langgraph-checkpoint 1.2.1](https://www.npmjs.com/package/@langchain/langgraph-checkpoint) — Library with base interfaces for LangGraph checkpoint savers.; source: a repository is declared in registry metadata.
3. [checkpoint-stream 0.1.2](https://www.npmjs.com/package/checkpoint-stream) — Queue data from a stream until a checkpoint is hit; source: no repository declared in search metadata.
4. [@deepseek-ai/dsh-chunked-list 0.1.5-alpha.2](https://www.npmjs.com/package/@deepseek-ai/dsh-chunked-list) — Persistent append-only chunked lists with bounded copying and JSON checkpoint validation; source: [declared repository](https://github.com/deepseek-ai/deepseek-harness.git).
5. [checkpoint-client 1.1.33](https://www.npmjs.com/package/checkpoint-client) — javascript checkpoint client; source: no repository declared in search metadata.
6. [parse-database-url 0.3.0](https://www.npmjs.com/package/parse-database-url) — Database configuration URL parser for node.js; source: [declared repository](https://github.com/pwnall/node-parse-database-url.git).
7. [@deepseek-ai/dsh-session-checkpoint-policy 0.0.1-rc.1](https://www.npmjs.com/package/@deepseek-ai/dsh-session-checkpoint-policy) — Semantic session durability checkpoints before model requests and tool side effects; source: [declared repository](https://github.com/deepseek-ai/deepseek-harness.git).
8. [@deepseek-ai/dsh-goal-round-driver 0.0.1-rc.3](https://www.npmjs.com/package/@deepseek-ai/dsh-goal-round-driver) — Race-fenced same-session goal-round driver; source: [declared repository](https://github.com/deepseek-ai/deepseek-harness.git).
9. [@langchain/langgraph-checkpoint-redis 1.1.0](https://www.npmjs.com/package/@langchain/langgraph-checkpoint-redis) — Redis checkpoint and store implementation for LangGraph; source: a repository is declared in registry metadata.
10. [stream-json 3.7.0](https://www.npmjs.com/package/stream-json) — A micro-library of stream components for building custom JSON and JSONC processing pipelines with a minimal memory footprint — parse, filter, and transform JSON far larger than available memory with a SAX-inspired token API, on Node.js or Web Streams.; source: [declared repository](https://github.com/uhop/stream-json.git).

npm refinement: `stream-json` — first result list, up to 10 packages.

1. [stream-json 3.7.0](https://www.npmjs.com/package/stream-json) — A micro-library of stream components for building custom JSON and JSONC processing pipelines with a minimal memory footprint — parse, filter, and transform JSON far larger than available memory with a SAX-inspired token API, on Node.js or Web Streams.; source: [declared repository](https://github.com/uhop/stream-json.git).
2. [@types/stream-json 1.7.8](https://www.npmjs.com/package/@types/stream-json) — TypeScript definitions for stream-json; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
3. [@claudexor/harness-claude 4.8.1](https://www.npmjs.com/package/@claudexor/harness-claude) — Claude Code adapter (claude -p --output-format stream-json).; source: [declared repository](https://github.com/razzant/claudexor.git).
4. [@claudexor/harness-cursor 4.8.1](https://www.npmjs.com/package/@claudexor/harness-cursor) — Cursor CLI adapter (cursor-agent -p --output-format stream-json).; source: [declared repository](https://github.com/razzant/claudexor.git).
5. [@claudexor/harness-agy 4.8.1](https://www.npmjs.com/package/@claudexor/harness-agy) — Google Antigravity CLI adapter (agy -p --output-format stream-json).; source: [declared repository](https://github.com/razzant/claudexor.git).
6. [@flighthq/shape-formats 0.4.0](https://www.npmjs.com/package/@flighthq/shape-formats) — Tree-shakable shape serialization codecs for @flighthq/shape (native command-stream JSON); source: [declared repository](https://github.com/flighthq/flight.git).
7. [react-json-stream 1.0.9](https://www.npmjs.com/package/react-json-stream) — react &#62; stream &#62; json; source: a repository is declared in registry metadata.
8. [stream-total 1.0.3](https://www.npmjs.com/package/stream-total) — total for stream json object; source: [declared repository](https://github.com/bonashen/stream-total.git).
9. [@ladbabynpm/picc-claude-shim 0.1.11](https://www.npmjs.com/package/@ladbabynpm/picc-claude-shim) — Drop-in replacement for Claude Code CLI. Speaks Claude Code's NDJSON protocol (--output-format stream-json / --input-format stream-json / --permission-prompt-tool stdio) so that third-party tools like hapi can drive pi instead of Claude Code. Internally c; source: no repository declared in search metadata.
10. [json-anystream 2.0.1](https://www.npmjs.com/package/json-anystream) — Stream JSON objects no matter what the source is.; source: [declared repository](https://github.com/gbv/json-anystream.git).

<a id="mirage-messaging-outbox"></a>

### Message bus, transactional outbox and webhook delivery

Sources: [mirage/lib/message-bus.mjs](../mirage/lib/message-bus.mjs), [mirage/lib/outbox.mjs](../mirage/lib/outbox.mjs), [mirage/lib/dataverse-webhooks.mjs](../mirage/lib/dataverse-webhooks.mjs), [mirage/lib/plugin-async.mjs](../mirage/lib/plugin-async.mjs).

GitHub: `transactional outbox webhook in:name,description,readme` — page 1, up to 10 results.

1. [yetone/cumora](https://github.com/yetone/cumora)
2. [daohainam/microservice-patterns](https://github.com/daohainam/microservice-patterns)
3. [Fluxora-Org/Fluxora-Backend](https://github.com/Fluxora-Org/Fluxora-Backend)
4. [The-Vibe-Company/quivr](https://github.com/The-Vibe-Company/quivr)
5. [trustflow-protocol/trustflow-backend](https://github.com/trustflow-protocol/trustflow-backend)
6. [luno/workflow](https://github.com/luno/workflow)
7. [baranacikgoz/modular-monolith-ddd-vsa-webapi](https://github.com/baranacikgoz/modular-monolith-ddd-vsa-webapi)
8. [AngelOneWealth/openreversefeed](https://github.com/AngelOneWealth/openreversefeed)
9. [Bogdanp/django_dramatiq](https://github.com/Bogdanp/django_dramatiq)
10. [qianshuixia/shrimpreel](https://github.com/qianshuixia/shrimpreel)

Refinement: `outbox in:name,description language:TypeScript` — page 1, up to 10 results.

1. [nestjs/outbox](https://github.com/nestjs/outbox)
2. [nostr-dev-kit/ndk](https://github.com/nostr-dev-kit/ndk)
3. [kyhsa93/nestjs-rest-cqrs-example](https://github.com/kyhsa93/nestjs-rest-cqrs-example)
4. [agentscope-ai-java/pg-outbox](https://github.com/agentscope-ai-java/pg-outbox)
5. [Zehelein/pg-transactional-outbox](https://github.com/Zehelein/pg-transactional-outbox)
6. [Nestixis/nestjs-inbox-outbox](https://github.com/Nestixis/nestjs-inbox-outbox)
7. [khalvai/outbox](https://github.com/khalvai/outbox)
8. [nebarf/nodejs-outbox](https://github.com/nebarf/nodejs-outbox)
9. [yornaath/service-outbox](https://github.com/yornaath/service-outbox)
10. [mbrookson/nestjs-ddd](https://github.com/mbrookson/nestjs-ddd)

npm: `transactional outbox webhook queue` — first registry result list, up to 10 packages.

1. [@crowdsource.you/core 3.1.0](https://www.npmjs.com/package/@crowdsource.you/core) — The CrowdSource integration: the API client at the root, and the Express webhook receiver, the transactional outbox and the test sandbox behind subpaths; source: [declared repository](https://github.com/OxyHQ/CrowdSource.git).
2. [pg-transactional-outbox 0.6.7](https://www.npmjs.com/package/pg-transactional-outbox) — A PostgreSQL based transactional outbox and inbox pattern implementation to support exactly once message processing (with at least once message delivery).; source: [declared repository](https://github.com/Zehelein/pg-transactional-outbox.git).
3. [yocto-queue 1.2.2](https://www.npmjs.com/package/yocto-queue) — Tiny queue data structure; source: [declared repository](https://github.com/sindresorhus/yocto-queue.git).
4. [@globalart/nestjs-typeorm-outbox 4.3.0](https://www.npmjs.com/package/@globalart/nestjs-typeorm-outbox) — TypeORM Outbox integration for NestJS; source: [declared repository](https://github.com/GlobalArtInc/ecosystem.git#main).
5. [@nestjs-modules/mailer 4.0.0](https://www.npmjs.com/package/@nestjs-modules/mailer) — NestJS - a mailer module (@mailer); source: [declared repository](https://github.com/nest-modules/mailer.git).
6. [queue-microtask 1.2.3](https://www.npmjs.com/package/queue-microtask) — fast, tiny &#96;queueMicrotask&#96; shim for modern engines; source: a repository is declared in registry metadata.
7. [@axinom/mosaic-transactional-inbox-outbox 0.34.1](https://www.npmjs.com/package/@axinom/mosaic-transactional-inbox-outbox) — This library encapsulates the Mosaic based transactional inbox and outbox pattern; source: [declared repository](https://github.com/Axinom/Navy.git).
8. [nestjs-cls 7.0.2](https://www.npmjs.com/package/nestjs-cls) — A continuation-local storage module compatible with NestJS's dependency injection.; source: [declared repository](https://github.com/Papooch/nestjs-cls.git).
9. [p-queue 10.0.0](https://www.npmjs.com/package/p-queue) — Promise queue with concurrency control; source: [declared repository](https://github.com/sindresorhus/p-queue.git).
10. [@volontariapp/outbox 0.10.18](https://www.npmjs.com/package/@volontariapp/outbox) — No description; source: [declared repository](https://github.com/Volontariapp/npm-packages.git).

<a id="mirage-change-audit-live"></a>

### Change tracking, audit history and local live updates

Sources: [mirage/lib/dataverse-changes.mjs](../mirage/lib/dataverse-changes.mjs), [mirage/lib/dataverse-audit.mjs](../mirage/lib/dataverse-audit.mjs), [mirage/lib/live.mjs](../mirage/lib/live.mjs).

GitHub: `Dataverse change tracking in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/Power-BI-Embedded-Contoso-Sales-Demo](https://github.com/microsoft/Power-BI-Embedded-Contoso-Sales-Demo)
2. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)
3. [microsoft/Power-CAT-Copilot-Studio-Kit](https://github.com/microsoft/Power-CAT-Copilot-Studio-Kit)
4. [amervitz/xRM-Portals-Community-Edition](https://github.com/amervitz/xRM-Portals-Community-Edition)
5. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
6. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
7. [microsoft/Dataverse](https://github.com/microsoft/Dataverse)
8. [IQSS/dataverse-installations](https://github.com/IQSS/dataverse-installations)
9. [microsoft/mcs-labs](https://github.com/microsoft/mcs-labs)
10. [Azure/dataverse-to-sql](https://github.com/Azure/dataverse-to-sql) — archived

npm: `dataverse change tracking audit` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [prosemirror-changeset 2.4.4](https://www.npmjs.com/package/prosemirror-changeset) — Distills a series of editing steps into deleted and added ranges; source: [declared repository](https://code.haverbeke.berlin/prosemirror/prosemirror-changeset.git).
3. [@sap/audit-logging 7.0.2](https://www.npmjs.com/package/@sap/audit-logging) — Provides audit logging functionalities for Node.js applications; source: no repository declared in search metadata.
4. [universal-analytics 0.5.4](https://www.npmjs.com/package/universal-analytics) — A node module for Google's Universal Analytics tracking; source: a repository is declared in registry metadata.
5. [audit-ci 7.1.0](https://www.npmjs.com/package/audit-ci) — Audits NPM, Yarn, and PNPM projects in CI environments; source: a repository is declared in registry metadata.
6. [@supabase/realtime-js 2.118.0](https://www.npmjs.com/package/@supabase/realtime-js) — Listen to realtime updates to your PostgreSQL database; source: [declared repository](https://github.com/supabase/supabase-js.git).
7. [@bemi-io/drizzle 0.1.0](https://www.npmjs.com/package/@bemi-io/drizzle) — Automatic database change tracking for Drizzle.; source: a repository is declared in registry metadata.
8. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
9. [@bemi-db/supabase-js 0.1.0](https://www.npmjs.com/package/@bemi-db/supabase-js) — Automatic data change tracking for Supabase JS; source: a repository is declared in registry metadata.
10. [strapi-plugin-enterprise-audit 1.1.3](https://www.npmjs.com/package/strapi-plugin-enterprise-audit) — Enterprise-grade audit logging platform for Strapi v4 and v5 with PBAC, tamper-resistant integrity chains, before/after change tracking, PII protection, configurable retention, and SIEM-ready architecture.; source: no repository declared in search metadata.

<a id="mirage-deterministic-testing"></a>

### Deterministic clocks, IDs and test scheduling

Sources: [mirage/lib/runtime-clock.mjs](../mirage/lib/runtime-clock.mjs), [mirage/testing.mjs](../mirage/testing.mjs), [mirage/lib/request-context.mjs](../mirage/lib/request-context.mjs).

GitHub: `deterministic clock scheduler in:name,description,readme` — page 1, up to 10 results.

1. [copper-project/copper-rs](https://github.com/copper-project/copper-rs)
2. [ETLCPP/etl](https://github.com/ETLCPP/etl)
3. [ApolloAuto/apollo-kernel](https://github.com/ApolloAuto/apollo-kernel)
4. [f9micro/f9-kernel](https://github.com/f9micro/f9-kernel)
5. [The-Vibe-Company/companion](https://github.com/The-Vibe-Company/companion)
6. [webrtc-rs/webrtc](https://github.com/webrtc-rs/webrtc)
7. [Crosstalk-Solutions/project-nomad](https://github.com/Crosstalk-Solutions/project-nomad)
8. [theEmbeddedGeorge/theEmbeddedNewTestament.github.io](https://github.com/theEmbeddedGeorge/theEmbeddedNewTestament.github.io)
9. [pointfreeco/swift-dependencies](https://github.com/pointfreeco/swift-dependencies)
10. [dart-archive/fake_async](https://github.com/dart-archive/fake_async) — archived

Refinement: `"fake timers" in:name,description language:JavaScript` — page 1, up to 10 results.

1. [sinonjs/fake-timers](https://github.com/sinonjs/fake-timers)
2. [FormidableLabs/mock-raf](https://github.com/FormidableLabs/mock-raf) — archived
3. [tlewowski/zurvan](https://github.com/tlewowski/zurvan)
4. [kuy/testdouble-timers](https://github.com/kuy/testdouble-timers)
5. [pmndrs/mock-raf](https://github.com/pmndrs/mock-raf)
6. [mattdean-digicatapult/usefaketimers-bug-reproduction](https://github.com/mattdean-digicatapult/usefaketimers-bug-reproduction)
7. [kentcdodds/testing-library-fake-timers](https://github.com/kentcdodds/testing-library-fake-timers)
8. [kentcdodds/react-query-fake-timers](https://github.com/kentcdodds/react-query-fake-timers)
9. [slightlytyler/wait-for-expect-fake-timers](https://github.com/slightlytyler/wait-for-expect-fake-timers)
10. [lukastaegert/mock-raf](https://github.com/lukastaegert/mock-raf)

npm: `deterministic clock scheduler testing` — first registry result list, up to 10 packages.

1. [scheduler 0.28.0](https://www.npmjs.com/package/scheduler) — Cooperative scheduler for the browser environment.; source: [declared repository](https://github.com/react/react.git).
2. [@sveltesentio/testing 0.4.2](https://www.npmjs.com/package/@sveltesentio/testing) — Test helpers: deterministic testClock, a11y lane harness, Superforms + TanStack Query fixtures; source: [declared repository](https://github.com/golusoris/sveltesentio.git).
3. [most-virtual-scheduler 1.0.0](https://www.npmjs.com/package/most-virtual-scheduler) — A virtual scheduler for @most/core; source: [declared repository](https://github.com/mostjs-community/virtual-scheduler.git).
4. [@enormora/clock 0.0.3](https://www.npmjs.com/package/@enormora/clock) — Explicit time and timer access for TypeScript applications; source: a repository is declared in registry metadata.
5. [@sinonjs/fake-timers 15.4.0](https://www.npmjs.com/package/@sinonjs/fake-timers) — Fake JavaScript timers; source: [declared repository](https://github.com/sinonjs/fake-timers.git).
6. [jest-plugin-clock 2.9.0](https://www.npmjs.com/package/jest-plugin-clock) — Jest plugin to mock dates, times, and datetimes.; source: [declared repository](https://github.com/negativetwelve/jest-plugins/tree/master/packages/jest-plugin-clock).
7. [react-clock 6.0.0](https://www.npmjs.com/package/react-clock) — An analog clock for your React app.; source: [declared repository](https://github.com/wojtekmaj/react-clock.git).
8. [@aws-sdk/client-scheduler 3.1158.0](https://www.npmjs.com/package/@aws-sdk/client-scheduler) — AWS SDK for JavaScript Scheduler Client for Node.js, Browser and React Native; source: [declared repository](https://github.com/aws/aws-sdk-js-v3.git).
9. [@claudewerk/bun-scheduler 0.2.0](https://www.npmjs.com/package/@claudewerk/bun-scheduler) — One injectable Clock/Scheduler for every timer in the substrate stack: host timers, a deterministic FakeClock, Durable Object alarms, and cron expressions on any clock. Zero required runtime deps.; source: [declared repository](https://github.com/GATE-software-space/claudewerk-packages.git).
10. [async-scheduler 1.4.4](https://www.npmjs.com/package/async-scheduler) — &#33;&#91;CI&#93;(https://github.com/kremi151/async-scheduler/workflows/CI/badge.svg) &#33;&#91;NPM&#93;(https://img.shields.io/npm/v/async-scheduler?color=green); source: [declared repository](https://github.com/kremi151/async-scheduler.git).

<a id="mirage-capability-evidence"></a>

### Capability preflight, fidelity contracts and parity evidence

Sources: [mirage/lib/capability-registry.mjs](../mirage/lib/capability-registry.mjs), [mirage/lib/capability-report.mjs](../mirage/lib/capability-report.mjs), [mirage/lib/evidence.mjs](../mirage/lib/evidence.mjs), [mirage/lib/request-evidence.mjs](../mirage/lib/request-evidence.mjs).

GitHub: `emulator conformance testing in:name,description,readme` — page 1, up to 10 results.

1. [MCPJam/inspector](https://github.com/MCPJam/inspector)
2. [ghostty-org/ghostty](https://github.com/ghostty-org/ghostty)
3. [bfirsh/jsnes](https://github.com/bfirsh/jsnes)
4. [floci-io/floci](https://github.com/floci-io/floci)
5. [bfirsh/jsnes-web](https://github.com/bfirsh/jsnes-web) — archived
6. [gnunn1/tilix](https://github.com/gnunn1/tilix)
7. [goccy/bigquery-emulator](https://github.com/goccy/bigquery-emulator)
8. [skylersaleh/SkyEmu](https://github.com/skylersaleh/SkyEmu)
9. [faiscadev/fakecloud](https://github.com/faiscadev/fakecloud)
10. [TheJambo/awesome-testing](https://github.com/TheJambo/awesome-testing)

npm: `compatibility conformance contract testing` — first registry result list, up to 10 packages.

1. [bidi-js 1.1.0](https://www.npmjs.com/package/bidi-js) — A JavaScript implementation of the Unicode Bidirectional Algorithm; source: [declared repository](https://github.com/lojjic/bidi-js.git).
2. [@contract-case/contract-case-jest 0.31.4](https://www.npmjs.com/package/@contract-case/contract-case-jest) — ContractCase contract testing suite for Jest; source: a repository is declared in registry metadata.
3. [@contract-case/cli 0.31.4](https://www.npmjs.com/package/@contract-case/cli) — Command-line interface for ContractCase, allowing interactions with the Contract / Pact Broker; source: a repository is declared in registry metadata.
4. [@contract-case/case-core 0.31.4](https://www.npmjs.com/package/@contract-case/case-core) — Core functionality for the ContractCase contract testing suite; source: a repository is declared in registry metadata.
5. [json-custom-numbers 3.1.1](https://www.npmjs.com/package/json-custom-numbers) — JSON parser and stringifier for custom numbers (e.g. BigInt); source: [declared repository](https://github.com/jawj/json-custom-numbers.git).
6. [@contract-case/case-core-plugin-http 0.31.4](https://www.npmjs.com/package/@contract-case/case-core-plugin-http) — ContractCase core HTTP plugin, providing HTTP matchers and mocks; source: a repository is declared in registry metadata.
7. [@contract-case/case-plugin-base 0.31.4](https://www.npmjs.com/package/@contract-case/case-plugin-base) — Plugin framework for writing plugins for the ContractCase test framework; source: a repository is declared in registry metadata.
8. [@contract-case/case-core-plugin-http-dsl 0.31.4](https://www.npmjs.com/package/@contract-case/case-core-plugin-http-dsl) — ContractCase HTTP plugin CaseExample definition DSL; source: a repository is declared in registry metadata.
9. [@contract-case/case-entities-internal 0.31.4](https://www.npmjs.com/package/@contract-case/case-entities-internal) — Shared types for ContractCase modules; source: a repository is declared in registry metadata.
10. [@contract-case/case-plugin-dsl-types 0.31.4](https://www.npmjs.com/package/@contract-case/case-plugin-dsl-types) — Types for writing the definition DSL for plugins for the ContractCase test framework; source: a repository is declared in registry metadata.

<a id="mirage-sdk-compatibility"></a>

### Real SDK compatibility and protocol regression harnesses

Sources: [mirage/test-sdk/dynamics-web-api](../mirage/test-sdk/dynamics-web-api), [mirage/test-sdk/serviceclient](../mirage/test-sdk/serviceclient), [mirage/test-sdk/python-dataverse](../mirage/test-sdk/python-dataverse), [mirage/test-sdk/tds](../mirage/test-sdk/tds), [mirage/test-sdk/cert-auth](../mirage/test-sdk/cert-auth).

GitHub: `Dataverse SDK testing in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/PowerAppsCodeApps](https://github.com/microsoft/PowerAppsCodeApps)
2. [microsoft/power-platform-skills](https://github.com/microsoft/power-platform-skills)
3. [scottdurow/dataverse-ify](https://github.com/scottdurow/dataverse-ify)
4. [seanmcne/OrgDbOrgSettings](https://github.com/seanmcne/OrgDbOrgSettings)
5. [DanielKerridge/claude-code-power-platform-skills](https://github.com/DanielKerridge/claude-code-power-platform-skills)
6. [microsoft/mcp](https://github.com/microsoft/mcp)
7. [microsoft/Powerful-Devs-Hack-Together](https://github.com/microsoft/Powerful-Devs-Hack-Together)
8. [context-and-oss/XrmBedrock](https://github.com/context-and-oss/XrmBedrock)
9. [NicolasPrats/DvBrowser](https://github.com/NicolasPrats/DvBrowser)
10. [microsoft/power-cat-skills](https://github.com/microsoft/power-cat-skills)

npm: `dataverse sdk mock server` — first registry result list, up to 10 packages.

1. [aws-sdk-client-mock 4.1.0](https://www.npmjs.com/package/aws-sdk-client-mock) — Easy and powerful mocking of AWS SDK v3 Clients; source: [declared repository](https://github.com/m-radzikowski/aws-sdk-client-mock.git).
2. [kinesis-local 0.6.2](https://www.npmjs.com/package/kinesis-local) — A Mock API for AWS Kinesis; source: [declared repository](https://github.com/etspaceman/kinesis-mock.git).
3. [aws-sdk-client-mock-jest 4.1.0](https://www.npmjs.com/package/aws-sdk-client-mock-jest) — Custom Jest matchers for AWS SDK v3 Client mock; source: [declared repository](https://github.com/m-radzikowski/aws-sdk-client-mock.git).
4. [aws-sdk-mock 6.2.2](https://www.npmjs.com/package/aws-sdk-mock) — Functions to mock the JavaScript aws-sdk; source: [declared repository](https://github.com/dwyl/aws-sdk-mock.git).
5. [msw 3.0.3](https://www.npmjs.com/package/msw) — The industry standard for API mocking in JavaScript.; source: [declared repository](https://github.com/mswjs/msw.git).
6. [ioredis-mock 8.13.1](https://www.npmjs.com/package/ioredis-mock) — This library emulates ioredis by performing all operations in-memory.; source: [declared repository](https://github.com/stipsan/ioredis-mock.git).
7. [aws-sdk-client-mock-vitest 8.0.0](https://www.npmjs.com/package/aws-sdk-client-mock-vitest) — Custom matchers for AWS SDK Client mock to be used in vitest; source: [declared repository](https://github.com/stschulte/aws-sdk-client-mock-vitest.git).
8. [jest-websocket-mock 2.5.0](https://www.npmjs.com/package/jest-websocket-mock) — Mock websockets and assert complex websocket interactions with Jest; source: [declared repository](https://github.com/romgain/jest-websocket-mock.git).
9. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
10. [oauth2-mock-server 9.3.0](https://www.npmjs.com/package/oauth2-mock-server) — OAuth2 and OpenID Connect mock server for automated testing and development. Issues cryptographically signed JWTs via JWK key pairs. OIDC-conformant, exposes discovery, JWKS, authorization, token, userinfo, introspection, revocation, and end-session endpo; source: [declared repository](https://github.com/axa-group/oauth2-mock-server.git).

<a id="mirage-runtime-composition"></a>

### Standalone/multi-surface runtime composition and lifecycle isolation

Sources: [mirage/lib/organization-host.mjs](../mirage/lib/organization-host.mjs), [mirage/lib/standalone-runtime.mjs](../mirage/lib/standalone-runtime.mjs), [mirage/lib/runtime-shutdown.mjs](../mirage/lib/runtime-shutdown.mjs), [mirage/lib/runtime-port.mjs](../mirage/lib/runtime-port.mjs).

GitHub: `emulator lifecycle isolation in:name,description,readme` — page 1, up to 10 results.

1. [floci-io/floci](https://github.com/floci-io/floci)
2. [libkrun/libkrun](https://github.com/libkrun/libkrun)
3. [cloudflare/security-audit-skill](https://github.com/cloudflare/security-audit-skill)
4. [podman-container-tools/podman](https://github.com/podman-container-tools/podman)
5. [iam-veeramalla/Docker-Zero-to-Hero](https://github.com/iam-veeramalla/Docker-Zero-to-Hero)
6. [open-gitagent/clawless](https://github.com/open-gitagent/clawless)
7. [floci-io/floci-gcp](https://github.com/floci-io/floci-gcp)
8. [floci-io/floci-az](https://github.com/floci-io/floci-az)
9. [ministackorg/ministack](https://github.com/ministackorg/ministack)
10. [openclaudecode/openclaudecode](https://github.com/openclaudecode/openclaudecode)

npm: `local emulator runtime lifecycle` — first registry result list, up to 10 packages.

1. [@firebase/auth 1.13.8](https://www.npmjs.com/package/@firebase/auth) — The Firebase Authenticaton component of the Firebase JS SDK.; source: [declared repository](https://github.com/firebase/firebase-js-sdk.git).
2. [@you-agent-factory/factory-emulator 0.0.7](https://www.npmjs.com/package/@you-agent-factory/factory-emulator) — Deterministic Factory emulator contracts and caller-owned event sinks.; source: [declared repository](https://github.com/portpowered/you-agent-factory.git).
3. [@oh-my-pi/pi-coding-agent 18.13.3](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) — Coding agent CLI with read, bash, edit, write tools and session management; source: [declared repository](https://github.com/can1357/oh-my-pi.git).
4. [@firebase/rules-unit-testing 6.0.0](https://www.npmjs.com/package/@firebase/rules-unit-testing) — A set of utilities useful for testing Security Rules with the Realtime Database or Cloud Firestore emulators.; source: [declared repository](https://github.com/firebase/firebase-js-sdk.git).
5. [vite-plus 1.4.0](https://www.npmjs.com/package/vite-plus) — The Unified Toolchain for the Web; source: [declared repository](https://github.com/voidzero-dev/vite-plus.git).
6. [ghostty-web 0.4.0](https://www.npmjs.com/package/ghostty-web) — Web-based terminal emulator using Ghostty's VT100 parser via WebAssembly; source: [declared repository](https://github.com/coder/ghostty-web.git).
7. [@you-agent-factory/factory-visualizers 0.0.6](https://www.npmjs.com/package/@you-agent-factory/factory-visualizers) — Controlled React hosts for the canonical Factory semantic graph.; source: [declared repository](https://github.com/portpowered/you-agent-factory.git).
8. [lifecycle-utils 4.5.2](https://www.npmjs.com/package/lifecycle-utils) — A set of general utilities for the lifecycle of a JS/TS project/library; source: [declared repository](https://github.com/giladgd/lifecycle-utils.git).
9. [@deepseek-ai/dsh-jobs-local 0.0.1-rc.3](https://www.npmjs.com/package/@deepseek-ai/dsh-jobs-local) — Process-local implementation of the DeepSeek Harness background job registry seam; source: [declared repository](https://github.com/deepseek-ai/deepseek-harness.git).
10. [@vellumai/cli 0.12.6](https://www.npmjs.com/package/@vellumai/cli) — CLI tools for vellum-assistant; source: no repository declared in search metadata.

<a id="extra-fiscal-calendar"></a>

### Organization fiscal-year boundaries, period types, fiscal query operators and grouping

Sources: [mirage/lib/fiscal-calendar.mjs](../mirage/lib/fiscal-calendar.mjs), [mirage/lib/dataverse-conditions.mjs](../mirage/lib/dataverse-conditions.mjs).

GitHub: `fiscal calendar in:name,description,readme` — page 1, up to 10 results.

1. [OCA/l10n-brazil](https://github.com/OCA/l10n-brazil)
2. [Giannoudis/TimePeriodLibrary](https://github.com/Giannoudis/TimePeriodLibrary)
3. [adamjstewart/fiscalyear](https://github.com/adamjstewart/fiscalyear)
4. [omz/AppSales-Mobile](https://github.com/omz/AppSales-Mobile)
5. [berlinbra/alpha-vantage-mcp](https://github.com/berlinbra/alpha-vantage-mcp)
6. [OCA/purchase-workflow](https://github.com/OCA/purchase-workflow)
7. [deepentropy/tvscreener](https://github.com/deepentropy/tvscreener)
8. [calogica/dbt-date](https://github.com/calogica/dbt-date)
9. [BloomTech-Labs/asylum-rg-fe-starter](https://github.com/BloomTech-Labs/asylum-rg-fe-starter)
10. [Arcenox-co/TickerQ](https://github.com/Arcenox-co/TickerQ)

npm: `fiscal calendar` — first registry result list, up to 10 packages.

1. [@eristack/fiscal-calendar 0.1.2](https://www.npmjs.com/package/@eristack/fiscal-calendar) — Fiscal years and periods with open/closed flags — wall-date boundaries on @eristack/timestamp; source: [declared repository](https://github.com/eristack/business-libs.git).
2. [aeat-mcp 1.1.1](https://www.npmjs.com/package/aeat-mcp) — MCP server for Spanish AEAT tax reference data — IRPF brackets, VAT rates, fiscal calendar, tax form catalog, and more. 100% official sources (BOE, AEAT).; source: [declared repository](https://github.com/iMark21/aeat-mcp.git).
3. [react-calendar 6.0.1](https://www.npmjs.com/package/react-calendar) — Ultimate calendar for your React app.; source: [declared repository](https://github.com/wojtekmaj/react-calendar.git).
4. [react-big-calendar 1.20.0](https://www.npmjs.com/package/react-big-calendar) — Calendar&#33; with events; source: [declared repository](https://github.com/bigcalendar/react-big-calendar.git).
5. [fiscal 1.0.0](https://www.npmjs.com/package/fiscal) — Computes fiscal quarter and year date ranges; source: [declared repository](https://github.com/MarkHerhold/fiscal.git).
6. [@fullcalendar/core 7.1.3](https://www.npmjs.com/package/@fullcalendar/core) — FullCalendar core types package; source: [declared repository](https://github.com/fullcalendar/fullcalendar.git).
7. [@fullcalendar/interaction 6.1.22](https://www.npmjs.com/package/@fullcalendar/interaction) — FullCalendar v6 only (in v7, this plugin is built into each framework package, e.g. @fullcalendar/react/interaction). Calendar functionality for event drag-n-drop, event resizing, date clicking, and date selecting; source: [declared repository](https://github.com/fullcalendar/fullcalendar.git).
8. [@fullcalendar/daygrid 6.1.22](https://www.npmjs.com/package/@fullcalendar/daygrid) — FullCalendar v6 only (in v7, this plugin is built into each framework package, e.g. @fullcalendar/react/daygrid). Display events on a month view or "day grid" view; source: [declared repository](https://github.com/fullcalendar/fullcalendar.git).
9. [@fullcalendar/timegrid 6.1.22](https://www.npmjs.com/package/@fullcalendar/timegrid) — FullCalendar v6 only (in v7, this plugin is built into each framework package, e.g. @fullcalendar/react/timegrid). Display events on time slots; source: [declared repository](https://github.com/fullcalendar/fullcalendar.git).
10. [@internationalized/date 3.12.4](https://www.npmjs.com/package/@internationalized/date) — Internationalized calendar, date, and time manipulation utilities; source: [declared repository](https://github.com/adobe/react-spectrum/tree/main/packages/@internationalized/date).

<a id="extra-state-status-transitions"></a>

### Metadata-backed state/status transitions and allowed transition validation

Sources: [mirage/lib/dataverse-state-transitions.mjs](../mirage/lib/dataverse-state-transitions.mjs), [mirage/lib/dataverse-record-messages.mjs](../mirage/lib/dataverse-record-messages.mjs).

GitHub: `Dataverse status transitions in:name,description,readme` — page 1, up to 10 results.

1. [mims-harvard/TDC](https://github.com/mims-harvard/TDC)
2. [scottdurow/power-platform-full-stack-skills](https://github.com/scottdurow/power-platform-full-stack-skills)
3. [ewingjm/development-hub](https://github.com/ewingjm/development-hub)
4. [mohsinonxrm/pptb-mxrm-fetchxml-studio](https://github.com/mohsinonxrm/pptb-mxrm-fetchxml-studio)
5. [sabrish/power-platform-solution-blueprint](https://github.com/sabrish/power-platform-solution-blueprint)
6. [Sahib-Sawhney-WH/Live-Markdown-Editor-PCF](https://github.com/Sahib-Sawhney-WH/Live-Markdown-Editor-PCF)
7. [xmarquez/democracyData](https://github.com/xmarquez/democracyData)
8. [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
9. [jnPiyush/AgentX](https://github.com/jnPiyush/AgentX)
10. [bhakthan/awesome-microsoft-fabric](https://github.com/bhakthan/awesome-microsoft-fabric)

Refinement: `"Dataverse" "statuscode" transitions in:readme` — page 1, up to 10 results.

1. [mohsinonxrm/pptb-mxrm-fetchxml-studio](https://github.com/mohsinonxrm/pptb-mxrm-fetchxml-studio)
2. [imranakram/Innofactor.Crm.CI](https://github.com/imranakram/Innofactor.Crm.CI)
3. [gruby4000/BRLocker](https://github.com/gruby4000/BRLocker)
4. [wtyeung/dataverse-governance-plugins](https://github.com/wtyeung/dataverse-governance-plugins)
5. [cnmnzo/cloud-data-engineering-roadmap](https://github.com/cnmnzo/cloud-data-engineering-roadmap)
6. [TiagoSoaresSTC/ecites-dynamics](https://github.com/TiagoSoaresSTC/ecites-dynamics)
7. [aidevme/advanced-audit-history](https://github.com/aidevme/advanced-audit-history)
8. [Chrono-Divide/PowerPlatformSolutionExporter](https://github.com/Chrono-Divide/PowerPlatformSolutionExporter)
9. [PowerBIPro-eu/ddsol-dataverse-mcp](https://github.com/PowerBIPro-eu/ddsol-dataverse-mcp)
10. [phecke/PowerPlatform-DataverseClient-Python](https://github.com/phecke/PowerPlatform-DataverseClient-Python)

npm: `dataverse status transitions` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [@remotion/transitions 4.0.539](https://www.npmjs.com/package/@remotion/transitions) — Library for creating transitions in Remotion; source: [declared repository](https://github.com/remotion-dev/remotion/tree/main/packages/transitions).
3. [next-view-transitions 0.3.5](https://www.npmjs.com/package/next-view-transitions) — View Transitions API for Next.js App Router; source: no repository declared in search metadata.
4. [react-native-screen-transitions 4.0.0](https://www.npmjs.com/package/react-native-screen-transitions) — Easy screen transitions for React Native and Expo; source: [declared repository](https://github.com/eds2002/react-native-screen-transitions.git).
5. [@xstate/fsm 2.1.0](https://www.npmjs.com/package/@xstate/fsm) — XState for finite state machines; source: a repository is declared in registry metadata.
6. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
7. [@aws-sdk/client-codepipeline 3.1158.0](https://www.npmjs.com/package/@aws-sdk/client-codepipeline) — AWS SDK for JavaScript Codepipeline Client for Node.js, Browser and React Native; source: [declared repository](https://github.com/aws/aws-sdk-js-v3.git).
8. [@gluestack-ui/transitions 0.1.11](https://www.npmjs.com/package/@gluestack-ui/transitions) — Transitions animations for React Native, Next.js &#38; React; source: [declared repository](https://github.com/gluestack/gluestack-ui.git).
9. [@tekstack/client-data-model 1.0.101](https://www.npmjs.com/package/@tekstack/client-data-model) — TekStack client-side Dataverse data model for TypeScript projects.; source: no repository declared in search metadata.
10. [@theatre/dataverse 0.7.2](https://www.npmjs.com/package/@theatre/dataverse) — No description; source: [declared repository](https://github.com/AriaMinaei/theatre).

<a id="extra-record-hierarchy"></a>

### Hierarchical relationship operators, ancestor/descendant traversal and cycle/depth handling

Sources: [mirage/lib/dataverse-hierarchy.mjs](../mirage/lib/dataverse-hierarchy.mjs).

GitHub: `Dataverse hierarchy in:name,description,readme` — page 1, up to 10 results.

1. [mims-harvard/TDC](https://github.com/mims-harvard/TDC)
2. [microsoft/PowerBI-Icons](https://github.com/microsoft/PowerBI-Icons) — archived
3. [microsoft/PowerPlatform-DataverseClient-Python](https://github.com/microsoft/PowerPlatform-DataverseClient-Python)
4. [IQSS/dataverse-frontend](https://github.com/IQSS/dataverse-frontend)
5. [DynamicSadFun/DataverseSQL](https://github.com/DynamicSadFun/DataverseSQL)
6. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
7. [troystaylor/SharingIsCaring](https://github.com/troystaylor/SharingIsCaring)
8. [dTsitsigkos/Amnesia](https://github.com/dTsitsigkos/Amnesia)
9. [microsoft/Policy-Weaver](https://github.com/microsoft/Policy-Weaver)
10. [microsoft/mcs-labs](https://github.com/microsoft/mcs-labs)

npm: `dataverse hierarchy` — first registry result list, up to 10 packages.

1. [d3-hierarchy 3.1.2](https://www.npmjs.com/package/d3-hierarchy) — Layout algorithms for visualizing hierarchical data.; source: [declared repository](https://github.com/d3/d3-hierarchy.git).
2. [vega-hierarchy 5.1.3](https://www.npmjs.com/package/vega-hierarchy) — Hierarchical layout transforms for Vega dataflows.; source: [declared repository](https://github.com/vega/vega.git).
3. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
4. [@types/d3-hierarchy 3.1.7](https://www.npmjs.com/package/@types/d3-hierarchy) — TypeScript definitions for d3-hierarchy; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
5. [@antv/hierarchy 0.7.1](https://www.npmjs.com/package/@antv/hierarchy) — layout algorithms for visualizing hierarchical data; source: a repository is declared in registry metadata.
6. [@visx/hierarchy 4.0.0](https://www.npmjs.com/package/@visx/hierarchy) — visx tree; source: [declared repository](https://github.com/airbnb/visx.git).
7. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
8. [@storybook/codemod 10.6.5](https://www.npmjs.com/package/@storybook/codemod) — A collection of codemod scripts written with JSCodeshift; source: [declared repository](https://github.com/storybookjs/storybook.git).
9. [@tekstack/client-data-model 1.0.101](https://www.npmjs.com/package/@tekstack/client-data-model) — TekStack client-side Dataverse data model for TypeScript projects.; source: no repository declared in search metadata.
10. [@theatre/dataverse 0.7.2](https://www.npmjs.com/package/@theatre/dataverse) — No description; source: [declared repository](https://github.com/AriaMinaei/theatre).

<a id="extra-duplicate-detection"></a>

### Duplicate-rule conditions, publish/unpublish and create/update detection

Sources: [mirage/lib/dataverse-duplicates.mjs](../mirage/lib/dataverse-duplicates.mjs).

GitHub: `Dataverse duplicate detection in:name,description,readme` — page 1, up to 10 results.

1. [meagmohit/EEG-Datasets](https://github.com/meagmohit/EEG-Datasets)
2. [context-and-oss/XrmBedrock](https://github.com/context-and-oss/XrmBedrock)
3. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)
4. [microsoft/Agent-for-Contract-Processing-Solution-Accelerator](https://github.com/microsoft/Agent-for-Contract-Processing-Solution-Accelerator) — archived
5. [LuiseFreese/mermaid](https://github.com/LuiseFreese/mermaid)
6. [TALXIS/tools-cli](https://github.com/TALXIS/tools-cli)
7. [Roelzz/mcs-agent-analyser](https://github.com/Roelzz/mcs-agent-analyser)
8. [Power-Maverick/PPTB-Tools](https://github.com/Power-Maverick/PPTB-Tools)
9. [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)
10. [ALM4Dataverse/Rnwood.Dataverse.Data.PowerShell](https://github.com/ALM4Dataverse/Rnwood.Dataverse.Data.PowerShell)

npm: `dataverse duplicate detection` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [@babel/plugin-transform-duplicate-named-capturing-groups-regex 8.0.1](https://www.npmjs.com/package/@babel/plugin-transform-duplicate-named-capturing-groups-regex) — Compile regular expressions using duplicate named groups to index-based groups.; source: [declared repository](https://github.com/babel/babel.git).
3. [@babel/plugin-transform-duplicate-keys 8.0.1](https://www.npmjs.com/package/@babel/plugin-transform-duplicate-keys) — Compile objects with duplicate keys to valid strict ES5; source: [declared repository](https://github.com/babel/babel.git).
4. [issue-parser 7.0.2](https://www.npmjs.com/package/issue-parser) — Parser for Github, GitLab and Bitbucket issues actions, references and mentions; source: [declared repository](https://github.com/semantic-release/issue-parser.git).
5. [@aws-sdk/middleware-recursion-detection 3.972.53](https://www.npmjs.com/package/@aws-sdk/middleware-recursion-detection) — &#91;&#33;&#91;NPM version&#93;(https://img.shields.io/npm/v/@aws-sdk/middleware-recursion-detection/latest.svg)&#93;(https://www.npmjs.com/package/@aws-sdk/middleware-recursion-detection) &#91;&#33;&#91;NPM downloads&#93;(https://img.shields.io/npm/dm/@aws-sdk/middleware-recursion-detectio; source: [declared repository](https://github.com/aws/aws-sdk-js-v3.git).
6. [@angular-eslint/eslint-plugin-template 22.6.0](https://www.npmjs.com/package/@angular-eslint/eslint-plugin-template) — ESLint plugin for Angular Templates; source: [declared repository](https://github.com/angular-eslint/angular-eslint.git).
7. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
8. [std-env 4.3.0](https://www.npmjs.com/package/std-env) — Runtime agnostic JS utils; source: a repository is declared in registry metadata.
9. [remark-lint-no-duplicate-headings 4.0.1](https://www.npmjs.com/package/remark-lint-no-duplicate-headings) — remark-lint rule to warn on duplicate headings; source: [declared repository](https://github.com/remarkjs/remark-lint.git#main).
10. [remark-lint-no-duplicate-definitions 4.0.1](https://www.npmjs.com/package/remark-lint-no-duplicate-definitions) — remark-lint rule to warn on duplicate definitions; source: [declared repository](https://github.com/remarkjs/remark-lint.git#main).

<a id="extra-virtual-table-providers"></a>

### Explicit virtual-table providers and externally backed table contracts

Sources: [mirage/lib/dataverse-virtual-providers.mjs](../mirage/lib/dataverse-virtual-providers.mjs).

GitHub: `Dataverse virtual tables in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/PowerBI-Icons](https://github.com/microsoft/PowerBI-Icons) — archived
2. [DanielKerridge/claude-code-power-platform-skills](https://github.com/DanielKerridge/claude-code-power-platform-skills)
3. [phuocle/Dynamics-Crm-DevKit](https://github.com/phuocle/Dynamics-Crm-DevKit)
4. [microsoft/power-pages-samples](https://github.com/microsoft/power-pages-samples)
5. [microsoft/d365bcdv](https://github.com/microsoft/d365bcdv)
6. [Azure/dataverse-to-sql](https://github.com/Azure/dataverse-to-sql) — archived
7. [allandecastro/dataverse-erd-visualizer](https://github.com/allandecastro/dataverse-erd-visualizer)
8. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
9. [MarcusRisanger/Dataverse-API](https://github.com/MarcusRisanger/Dataverse-API)
10. [bhakthan/awesome-microsoft-fabric](https://github.com/bhakthan/awesome-microsoft-fabric)

npm: `dataverse virtual table` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [webpack-virtual-modules 0.6.2](https://www.npmjs.com/package/webpack-virtual-modules) — Webpack Virtual Modules; source: [declared repository](https://github.com/sysgears/webpack-virtual-modules.git).
3. [ng-table-virtual-scroll 1.6.1](https://www.npmjs.com/package/ng-table-virtual-scroll) — Virtual scroll for for Angular Material Table; source: a repository is declared in registry metadata.
4. [rc-virtual-list 3.19.2](https://www.npmjs.com/package/rc-virtual-list) — React Virtual List Component; source: [declared repository](https://github.com/react-component/virtual-list.git).
5. [react-virtual 2.10.4](https://www.npmjs.com/package/react-virtual) — Hooks for virtualizing scrollable elements in React; source: [declared repository](https://github.com/tannerlinsley/react-virtual.git).
6. [@rc-component/virtual-list 1.6.0](https://www.npmjs.com/package/@rc-component/virtual-list) — Virtual scrolling list component for React.; source: [declared repository](https://github.com/react-component/virtual-list.git).
7. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
8. [vue-virtual-scroll-list 2.3.5](https://www.npmjs.com/package/vue-virtual-scroll-list) — A vue component support big amount data list with high scroll performance.; source: [declared repository](https://github.com/tangbc/vue-virtual-scroll-list.git).
9. [@rollup/plugin-virtual 3.0.3](https://www.npmjs.com/package/@rollup/plugin-virtual) — Load virtual modules from memory; source: [declared repository](https://github.com/rollup/plugins.git).
10. [preact 11.1.0](https://www.npmjs.com/package/preact) — Fast 4kb React-compatible Virtual DOM library.; source: [declared repository](https://github.com/preactjs/preact.git).

<a id="extra-elastic-cosmos-tables"></a>

### Elastic-table semantics, partitioning and Cosmos query interpretation

Sources: [mirage/lib/dataverse-elastic.mjs](../mirage/lib/dataverse-elastic.mjs), [mirage/lib/dataverse-cosmos-query.mjs](../mirage/lib/dataverse-cosmos-query.mjs).

GitHub: `Dataverse elastic Cosmos in:name,description,readme` — page 1, up to 10 results.

1. [mzazon/cloud-projects](https://github.com/mzazon/cloud-projects)
2. [bhakthan/awesome-microsoft-fabric](https://github.com/bhakthan/awesome-microsoft-fabric)
3. [ccamel/awesome-ccamel](https://github.com/ccamel/awesome-ccamel)
4. [ever-works/awesome-mcp-servers](https://github.com/ever-works/awesome-mcp-servers)
5. [DinhCongTac221/awesome-ccamel](https://github.com/DinhCongTac221/awesome-ccamel)
6. [uhub/awesome-c-sharp](https://github.com/uhub/awesome-c-sharp)
7. [burrows99/rag-template](https://github.com/burrows99/rag-template)
8. [tomz/agent-skills](https://github.com/tomz/agent-skills)
9. [0xmasoud/awesome-ccamel](https://github.com/0xmasoud/awesome-ccamel)
10. [0xmusah/awesome-ccamel](https://github.com/0xmusah/awesome-ccamel)

Refinement: `"Cosmos" "SQL parser" in:readme` — page 1, up to 10 results.

1. [vercel/cosmosdb-query](https://github.com/vercel/cosmosdb-query)
2. [drylikov/Cosmosdb-Query](https://github.com/drylikov/Cosmosdb-Query)
3. [libredb/libredb-studio](https://github.com/libredb/libredb-studio)
4. [timabell/FakeCosmosDb](https://github.com/timabell/FakeCosmosDb)
5. [anylineorg/anyline](https://github.com/anylineorg/anyline)
6. [Hiflylabs/awesome-dbt](https://github.com/Hiflylabs/awesome-dbt)
7. [ishandutta2007/Awesome-SQL-Lineage-Platform](https://github.com/ishandutta2007/Awesome-SQL-Lineage-Platform)
8. [rafeeque1/cosmosdb-parser](https://github.com/rafeeque1/cosmosdb-parser)
9. [microtema/cosmos-db-repositories](https://github.com/microtema/cosmos-db-repositories)
10. [hitesharma92/DataQueryExplorer](https://github.com/hitesharma92/DataQueryExplorer)

npm: `cosmos query parser` — first registry result list, up to 10 packages.

1. [@csstools/media-query-list-parser 5.0.2](https://www.npmjs.com/package/@csstools/media-query-list-parser) — Parse CSS media query lists.; source: [declared repository](https://github.com/csstools/postcss-plugins.git).
2. [@npmcli/query 6.0.0](https://www.npmjs.com/package/@npmcli/query) — npm query parser and tools; source: [declared repository](https://github.com/npm/query.git).
3. [media-query-parser 3.0.2](https://www.npmjs.com/package/media-query-parser) — Parse CSS media queries (spec-compliant); source: [declared repository](https://github.com/tbjgolden/media-query-parser.git).
4. [@azure/cosmos 4.10.1](https://www.npmjs.com/package/@azure/cosmos) — Microsoft Azure Cosmos DB Service Node.js SDK for NOSQL API; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
5. [postcss-media-query-parser 0.2.3](https://www.npmjs.com/package/postcss-media-query-parser) — A tool for parsing media query lists.; source: [declared repository](https://github.com/dryoma/postcss-media-query-parser.git).
6. [error-stack-parser 2.1.4](https://www.npmjs.com/package/error-stack-parser) — Extract meaning from JS Errors; source: a repository is declared in registry metadata.
7. [@csstools/css-parser-algorithms 4.0.2](https://www.npmjs.com/package/@csstools/css-parser-algorithms) — Algorithms to help you parse CSS from an array of tokens.; source: [declared repository](https://github.com/csstools/postcss-plugins.git).
8. [@csstools/css-color-parser 4.2.6](https://www.npmjs.com/package/@csstools/css-color-parser) — Parse CSS color values; source: [declared repository](https://github.com/csstools/postcss-plugins.git).
9. [yaml-eslint-parser 2.1.0](https://www.npmjs.com/package/yaml-eslint-parser) — A YAML parser that produces output compatible with ESLint; source: [declared repository](https://github.com/ota-meshi/yaml-eslint-parser.git).
10. [svelte-eslint-parser 1.10.0](https://www.npmjs.com/package/svelte-eslint-parser) — Svelte parser for ESLint; source: [declared repository](https://github.com/sveltejs/svelte-eslint-parser.git).

npm refinement: `cosmosdb-query` — first result list, up to 10 packages.

1. [@zeit/cosmosdb-query 0.7.2](https://www.npmjs.com/package/@zeit/cosmosdb-query) — A SQL parser and executer for Cosmos DB; source: [declared repository](https://github.com/zeit/cosmosdb-query.git).
2. [@niroboo/cosmonaut 0.3.5](https://www.npmjs.com/package/@niroboo/cosmonaut) — A CosmosDB query builder library for Node; source: [declared repository](https://github.com/niroboo/cosmonaut.git).
3. [@azure/arm-cosmosdb 17.0.0](https://www.npmjs.com/package/@azure/arm-cosmosdb) — A generated SDK for CosmosDBManagementClient.; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
4. [@heivo/cosmonaut 0.3.2](https://www.npmjs.com/package/@heivo/cosmonaut) — A CosmosDB query builder library for Node; source: [declared repository](https://github.com/heivo/cosmonaut.git).
5. [@vercel/cosmosdb-server 1.0.1](https://www.npmjs.com/package/@vercel/cosmosdb-server) — A Cosmos DB server implementation; source: [declared repository](https://github.com/vercel/cosmosdb-server.git).
6. [@azure/data-tables 13.3.2](https://www.npmjs.com/package/@azure/data-tables) — An isomorphic client library for the Azure Tables service.; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
7. [cosmosdb-query-builder 0.0.5](https://www.npmjs.com/package/cosmosdb-query-builder) — Yet another CosmosDB(DocumentDB) query builder.; source: [declared repository](https://github.com/ar-tama/cosmosdb-query-builder.git).
8. [@azure/cosmos 4.10.1](https://www.npmjs.com/package/@azure/cosmos) — Microsoft Azure Cosmos DB Service Node.js SDK for NOSQL API; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
9. [node-cosmos 0.1.10](https://www.npmjs.com/package/node-cosmos) — A light weight azure cosmosdb client aiming at ease of use for creating REST API. Supports json filter, sort and offset/limit; source: [declared repository](https://github.com/thunderz99/node-cosmos.git).
10. [@tanstack/react-query 5.105.0](https://www.npmjs.com/package/@tanstack/react-query) — Hooks for managing, caching and syncing asynchronous and remote data in React; source: [declared repository](https://github.com/TanStack/query.git).

<a id="extra-pcf-localization"></a>

### PCF RESX localization, language selection, resource fallback and diagnostics

Sources: [mirage/lib/code-components.mjs](../mirage/lib/code-components.mjs), [mirage/lib/liquid-resx.mjs](../mirage/lib/liquid-resx.mjs), [mirage/docs/code-components.md](../mirage/docs/code-components.md).

GitHub: `PCF localization RESX in:name,description,readme` — page 1, up to 10 results.

1. [Power-Maverick/PCF-Builder-VSCode](https://github.com/Power-Maverick/PCF-Builder-VSCode)
2. [Power-Maverick/PCF-CustomControlBuilder](https://github.com/Power-Maverick/PCF-CustomControlBuilder)
3. [novalogica/pcf-audit-history](https://github.com/novalogica/pcf-audit-history)
4. [jaduplesms/PCF-Workbench](https://github.com/jaduplesms/PCF-Workbench)
5. [microsoft/scmsamples-EnterpriseAssetManagement](https://github.com/microsoft/scmsamples-EnterpriseAssetManagement)
6. [microsoft/scmsamples-InventoryOnHand](https://github.com/microsoft/scmsamples-InventoryOnHand)
7. [danieag/KPI_PCFcontrols](https://github.com/danieag/KPI_PCFcontrols)
8. [aidevme/dependent-choice](https://github.com/aidevme/dependent-choice)
9. [hansanawijethunga/Birthday-Picker-PCF](https://github.com/hansanawijethunga/Birthday-Picker-PCF)
10. [mferdev/PCF_NotificationsD365](https://github.com/mferdev/PCF_NotificationsD365)

npm: `resx localization` — first registry result list, up to 10 packages.

1. [@rushstack/webpack5-localization-plugin 0.16.32](https://www.npmjs.com/package/@rushstack/webpack5-localization-plugin) — This plugin facilitates localization with Webpack.; source: [declared repository](https://github.com/microsoft/rushstack.git).
2. [@rushstack/webpack4-localization-plugin 0.20.32](https://www.npmjs.com/package/@rushstack/webpack4-localization-plugin) — This plugin facilitates localization with Webpack.; source: [declared repository](https://github.com/microsoft/rushstack.git).
3. [resx 2.0.4](https://www.npmjs.com/package/resx) — resx2js and js2resx converter resx resource utils; source: [declared repository](https://github.com/locize/resx.git).
4. [expo-localization 58.0.5](https://www.npmjs.com/package/expo-localization) — Provides an interface for native user localization information.; source: [declared repository](https://github.com/expo/expo.git).
5. [react-day-picker 10.0.2](https://www.npmjs.com/package/react-day-picker) — Customizable Date Picker for React; source: [declared repository](https://github.com/gpbl/react-day-picker.git).
6. [resx-json-typescript-converter 1.0.4](https://www.npmjs.com/package/resx-json-typescript-converter) — Converts resx files to json and optionaly generates a TypeScript resourceManager.; source: [declared repository](https://github.com/blueasysoft/resx-json-typescript-converter.git).
7. [pseudo-localization 3.1.3](https://www.npmjs.com/package/pseudo-localization) — pseudo-localization for internationalization testing; source: [declared repository](https://github.com/tryggvigy/pseudo-localization.git).
8. [pcf-scripts 1.51.1](https://www.npmjs.com/package/pcf-scripts) — This package contains a module for building PowerApps Component Framework (PCF) controls. See project homepage how to install.; source: no repository declared in search metadata.
9. [monaco-editor 0.57.0](https://www.npmjs.com/package/monaco-editor) — A browser based code editor; source: [declared repository](https://github.com/microsoft/monaco-editor.git).
10. [@daypicker/react 10.0.2](https://www.npmjs.com/package/@daypicker/react) — React package for DayPicker; source: [declared repository](https://github.com/gpbl/react-day-picker.git).

<a id="extra-model-driven-command-rules"></a>

### Exported ribbon/modern commands, enable/display rules and command execution

Sources: [mirage/lib/model-driven/solution.mjs](../mirage/lib/model-driven/solution.mjs), [mirage/lib/model-driven/client-runtime.mjs](../mirage/lib/model-driven/client-runtime.mjs), [lense/model-driven-commands.mjs](../lense/model-driven-commands.mjs).

GitHub: `Dynamics ribbon commands in:name,description,readme` — page 1, up to 10 results.

1. [sqshq/piggymetrics](https://github.com/sqshq/piggymetrics)
2. [rajyraman/Levelup-for-Dynamics-CRM](https://github.com/rajyraman/Levelup-for-Dynamics-CRM)
3. [phuocle/Dynamics-Crm-DevKit](https://github.com/phuocle/Dynamics-Crm-DevKit)
4. [seanmcne/OrgDbOrgSettings](https://github.com/seanmcne/OrgDbOrgSettings)
5. [gotdibbs/Dynamics-365-Toolkit](https://github.com/gotdibbs/Dynamics-365-Toolkit)
6. [RameshMF/PiggyMetrics](https://github.com/RameshMF/PiggyMetrics)
7. [boscoh/pdbremix](https://github.com/boscoh/pdbremix)
8. [PaulNieuwelaar/processjs](https://github.com/PaulNieuwelaar/processjs)
9. [eleanorlutz/asteroids_atlas_of_space](https://github.com/eleanorlutz/asteroids_atlas_of_space)
10. [Dimsi-BS/XrmFramework](https://github.com/Dimsi-BS/XrmFramework)

npm: `xrm ribbon rules` — first registry result list, up to 10 packages.

1. [@syncfusion/ej2-ribbon 35.1.37](https://www.npmjs.com/package/@syncfusion/ej2-ribbon) — Essential JS 2 Component; source: [declared repository](https://github.com/syncfusion/ej2-ribbon-component.git).
2. [xrm-mock 3.6.2](https://www.npmjs.com/package/xrm-mock) — A fake implementation of the Xrm object model. Used for testing Dynamics 365 client-side scripts.; source: [declared repository](https://github.com/camelCaseDave/xrm-mock.git).
3. [@types/xrm 9.0.97](https://www.npmjs.com/package/@types/xrm) — TypeScript definitions for xrm; source: [declared repository](https://github.com/DefinitelyTyped/DefinitelyTyped.git).
4. [@mescius/spread-sheets-designer 19.2.4](https://www.npmjs.com/package/@mescius/spread-sheets-designer) — SpreadJS Designer Component present as a control that could be embedded into your web application easily, and also provided flexible, customizable configuration to achieve your business logic.; source: no repository declared in search metadata.
5. [@ribbon-studios/js-utils 3.3.2](https://www.npmjs.com/package/@ribbon-studios/js-utils) — Collection of generic javascript utilities curated by the Ribbon Studios Team~; source: [declared repository](https://codeberg.org/ribbon-studios/js-utils.git).
6. [xrm-webapi-client 4.1.6](https://www.npmjs.com/package/xrm-webapi-client) — Dynamics CRM WebApi Client; source: [declared repository](https://github.com/XRM-OSS/Xrm-WebApi-Client.git).
7. [@ribbon-studios/semantic-release-forgejo 0.1.3](https://www.npmjs.com/package/@ribbon-studios/semantic-release-forgejo) — semantic-release plugin to publish a Forgejo release; source: [declared repository](https://codeberg.org/ribbon-studios/semantic-release-forgejo.git).
8. [github-fork-ribbon-css 0.2.3](https://www.npmjs.com/package/github-fork-ribbon-css) — "Fork me on GitHub" CSS ribbon; source: [declared repository](https://github.com/simonwhitaker/github-fork-ribbon-css.git).
9. [@syncfusion/ej2-react-ribbon 35.1.37](https://www.npmjs.com/package/@syncfusion/ej2-react-ribbon) — Essential JS 2 Component for React; source: [declared repository](https://github.com/syncfusion/ej2-react-ui-components.git).
10. [@react-native/eslint-plugin 0.88.1](https://www.npmjs.com/package/@react-native/eslint-plugin) — ESLint rules for @react-native/eslint-config; source: [declared repository](https://github.com/react/react-native.git).

<a id="extra-certificate-client-auth"></a>

### Certificate/JWT client assertions, thumbprints, TLS and replay/lifetime validation

Sources: [mirage/lib/dataverse-auth.mjs](../mirage/lib/dataverse-auth.mjs), [mirage/lib/identity-provider.mjs](../mirage/lib/identity-provider.mjs), [mirage/lib/dataverse-tls.mjs](../mirage/lib/dataverse-tls.mjs).

GitHub: `Dataverse certificate authentication in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/Power-BI-Embedded-Contoso-Sales-Demo](https://github.com/microsoft/Power-BI-Embedded-Contoso-Sales-Demo)
2. [IQSS/dataverse-docker](https://github.com/IQSS/dataverse-docker)
3. [gdcc/dataverse-ansible](https://github.com/gdcc/dataverse-ansible)
4. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
5. [rajyraman/Dataverse-LINQPad-Driver](https://github.com/rajyraman/Dataverse-LINQPad-Driver)
6. [microsoft/Dataverse](https://github.com/microsoft/Dataverse)
7. [context-and-oss/XrmBedrock](https://github.com/context-and-oss/XrmBedrock)
8. [microsoft/Policy-Weaver](https://github.com/microsoft/Policy-Weaver)
9. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
10. [rezanid/PSDataverse](https://github.com/rezanid/PSDataverse)

npm: `dataverse certificate authentication` — first registry result list, up to 10 packages.

1. [@expo/devcert 1.2.2](https://www.npmjs.com/package/@expo/devcert) — Generate trusted local SSL/TLS certificates for local SSL development; source: [declared repository](https://github.com/expo/devcert.git).
2. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
3. [@peculiar/x509 3.1.0](https://www.npmjs.com/package/@peculiar/x509) — @peculiar/x509 is an easy to use TypeScript/Javascript library based on @peculiar/asn1-schema that makes generating X.509 Certificates and Certificate Requests as well as validating certificate chains easy; source: [declared repository](https://github.com/PeculiarVentures/x509.git).
4. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
5. [@google-cloud/security-private-ca 8.2.0](https://www.npmjs.com/package/@google-cloud/security-private-ca) — Privateca client for Node.js; source: [declared repository](https://github.com/googleapis/google-cloud-node.git).
6. [@google-cloud/certificate-manager 3.3.0](https://www.npmjs.com/package/@google-cloud/certificate-manager) — certificatemanager client for Node.js; source: [declared repository](https://github.com/googleapis/google-cloud-node.git).
7. [mkcert 3.2.0](https://www.npmjs.com/package/mkcert) — Create Self Signed Development Certificates; source: [declared repository](https://github.com/Subash/mkcert.git).
8. [@peculiar/asn1-x509 3.0.0](https://www.npmjs.com/package/@peculiar/asn1-x509) — ASN.1 schema for X.509 certificates, certificate revocation lists, and related profile structures defined in RFC 5280.; source: [declared repository](https://github.com/PeculiarVentures/asn1-schema.git).
9. [@expo/pkcs12 0.7.2](https://www.npmjs.com/package/@expo/pkcs12) — PKCS#12 Utilities for Node.js; source: [declared repository](https://github.com/expo/expo.git).
10. [@fidm/x509 1.2.1](https://www.npmjs.com/package/@fidm/x509) — Pure JavaScript X509 certificate tools for Node.js; source: a repository is declared in registry metadata.

<a id="extra-optional-service-addons"></a>

### Explicit service fixtures and bounded Power BI, AI Builder, Copilot, desktop-flow and platform addon messages

Sources: [mirage/lib/service-fixtures.mjs](../mirage/lib/service-fixtures.mjs), [mirage/lib/dataverse-addon-ai.mjs](../mirage/lib/dataverse-addon-ai.mjs), [mirage/lib/dataverse-addon-pva.mjs](../mirage/lib/dataverse-addon-pva.mjs), [mirage/lib/dataverse-addon-flows.mjs](../mirage/lib/dataverse-addon-flows.mjs), [mirage/lib/dataverse-addon-d365.mjs](../mirage/lib/dataverse-addon-d365.mjs), [mirage/lib/dataverse-addon-featurecontrol.mjs](../mirage/lib/dataverse-addon-featurecontrol.mjs), [mirage/lib/dataverse-addon-git.mjs](../mirage/lib/dataverse-addon-git.mjs).

GitHub: `(PowerBI OR Copilot OR "AI Builder") mock in:name,description,readme` — page 1, up to 10 results.

1. [addyosmani/agent-skills](https://github.com/addyosmani/agent-skills)
2. [github-copilot-resources/copilot-metrics-viewer](https://github.com/github-copilot-resources/copilot-metrics-viewer)
3. [google/googletest](https://github.com/google/googletest)
4. [microsoft/skills](https://github.com/microsoft/skills)
5. [Azure-Samples/AI-Gateway](https://github.com/Azure-Samples/AI-Gateway)
6. [openMF/web-app](https://github.com/openMF/web-app)
7. [sulaiman013/powerbi-mcp](https://github.com/sulaiman013/powerbi-mcp)
8. [pbakaus/impeccable](https://github.com/pbakaus/impeccable)
9. [microsoft/waza](https://github.com/microsoft/waza)
10. [johnfercher/maroto](https://github.com/johnfercher/maroto)

Refinement: `"Power BI" embed mock in:readme` — page 1, up to 10 results.

1. [microsoft/ReportingServicesTools](https://github.com/microsoft/ReportingServicesTools)
2. [sulaiman013/powerbi-mcp](https://github.com/sulaiman013/powerbi-mcp)
3. [Rulikkk/awesome-power-bi](https://github.com/Rulikkk/awesome-power-bi)
4. [microsoft/awesome-rayfin](https://github.com/microsoft/awesome-rayfin)
5. [Himanshuu-Gupta/WolfTrack](https://github.com/Himanshuu-Gupta/WolfTrack)
6. [RunaCapital/awesome-oss-alternatives](https://github.com/RunaCapital/awesome-oss-alternatives)
7. [tomweinandy/form_recognizer_demo](https://github.com/tomweinandy/form_recognizer_demo)
8. [ripienaar/free-for-dev](https://github.com/ripienaar/free-for-dev)
9. [Litishkumar/AnalyticaX](https://github.com/Litishkumar/AnalyticaX)
10. [MohammadWasiq0786/iNeuron-Full-Stack-Data-Science-BootCamp-Live-Classes-and-Tasks](https://github.com/MohammadWasiq0786/iNeuron-Full-Stack-Data-Science-BootCamp-Live-Classes-and-Tasks)

Refinement: `"AI Builder" mock in:readme` — page 1, up to 10 results.

1. [codu-code/codu](https://github.com/codu-code/codu)
2. [KodyKendall/LlamaBot](https://github.com/KodyKendall/LlamaBot)
3. [Littlesheepxy/zhigeng](https://github.com/Littlesheepxy/zhigeng)
4. [ai-builders-id/mdown-collection](https://github.com/ai-builders-id/mdown-collection)
5. [hades217/awesome-ai](https://github.com/hades217/awesome-ai)
6. [calderbuild/MeetSpot](https://github.com/calderbuild/MeetSpot)
7. [karthikrshet/Career-Agents](https://github.com/karthikrshet/Career-Agents)
8. [Cigano-agi/tycoonclaws](https://github.com/Cigano-agi/tycoonclaws)
9. [acvnace/awesome-vibe-coding-resources](https://github.com/acvnace/awesome-vibe-coding-resources)
10. [dsx-ai-factory/nv-config-manager](https://github.com/dsx-ai-factory/nv-config-manager)

Refinement: `"Copilot Studio" mock in:readme` — page 1, up to 10 results.

1. [microsoft/skills](https://github.com/microsoft/skills)
2. [AgentEvalHQ/AgentEval](https://github.com/AgentEvalHQ/AgentEval)
3. [arc-mcp/arc-1](https://github.com/arc-mcp/arc-1)
4. [leandrodantelab2dev/lab2-mcp-cap](https://github.com/leandrodantelab2dev/lab2-mcp-cap)
5. [microsoft/azure-agents-control-plane](https://github.com/microsoft/azure-agents-control-plane)
6. [NuGuardAI/nuguard](https://github.com/NuGuardAI/nuguard)
7. [toxy4ny/kevlar-benchmark](https://github.com/toxy4ny/kevlar-benchmark)
8. [aiappsgbb/kratos-agent](https://github.com/aiappsgbb/kratos-agent)
9. [VoltAgent/awesome-agent-skills](https://github.com/VoltAgent/awesome-agent-skills)
10. [microsoft/thinkingbox](https://github.com/microsoft/thinkingbox)

npm: `powerbi copilot mock` — first registry result list, up to 10 packages.

1. [powerbi-client 2.25.0](https://www.npmjs.com/package/powerbi-client) — JavaScript library for embedding Power BI into your apps. Provides service which makes it easy to embed different types of components and an object model which allows easy interaction with these components such as changing pages, applying filters, and res; source: [declared repository](https://github.com/Microsoft/PowerBI-JavaScript.git).
2. [powerbi-models 2.2.0](https://www.npmjs.com/package/powerbi-models) — Contains JavaScript &#38;amp; TypeScript object models for Microsoft Power BI JavaScript SDK. For each model there is a TypeScript interface, and a validation function to ensure and object is valid.; source: [declared repository](https://github.com/Microsoft/powerbi-models.git).
3. [powerbi-router 0.1.5](https://www.npmjs.com/package/powerbi-router) — Router for Microsoft Power BI. Given an http method and url pattern call the matching handler with the request and response object. Syntax matches common libraries such as express and restify.; source: [declared repository](https://github.com/Microsoft/powerbi-router.git).
4. [powerbi-visuals-api 5.11.1](https://www.npmjs.com/package/powerbi-visuals-api) — Power BI Custom Visuals API type definitions for typescript; source: [declared repository](https://github.com/microsoft/powerbi-visuals-api.git).
5. [powerbi-visuals-utils-dataviewutils 7.0.0](https://www.npmjs.com/package/powerbi-visuals-utils-dataviewutils) — dataviewutils; source: [declared repository](https://github.com/Microsoft/powerbi-visuals-utils-dataviewutils.git).
6. [powerbi-report-authoring 3.0.0](https://www.npmjs.com/package/powerbi-report-authoring) — A library for authoring Power BI reports while embedded into your apps. Provides service which makes it easy to change report and visual elements in session. It gives APIs such as creating visual, changing visual properties, etc ...; source: [declared repository](https://github.com/microsoft/powerbi-report-authoring.git).
7. [powerbi-visuals-webpack-plugin 5.0.3](https://www.npmjs.com/package/powerbi-visuals-webpack-plugin) — PowerBI Custom Visuals webpack plugin; source: [declared repository](https://github.com/microsoft/powerbi-visuals-webpack-plugin.git).
8. [powerbi-visuals-utils-formattingutils 7.0.0](https://www.npmjs.com/package/powerbi-visuals-utils-formattingutils) — FormattingUtils; source: [declared repository](https://github.com/Microsoft/powerbi-visuals-utils-formattingutils.git).
9. [powerbi-visuals-utils-typeutils 7.0.0](https://www.npmjs.com/package/powerbi-visuals-utils-typeutils) — TypeUtils; source: [declared repository](https://github.com/Microsoft/powerbi-visuals-utils-typeutils.git).
10. [powerbi-client-angular 6.0.3](https://www.npmjs.com/package/powerbi-client-angular) — Angular wrapper for powerbi-client library; source: [declared repository](https://github.com/microsoft/powerbi-client-angular.git).

<a id="extra-external-resource-policy"></a>

### External asset/network allowlists, redirects, response policies and CSP boundaries

Sources: [mirage/lib/content-policy.mjs](../mirage/lib/content-policy.mjs), [mirage/lib/content-policy-defaults.mjs](../mirage/lib/content-policy-defaults.mjs), [mirage/lib/asset-cache.mjs](../mirage/lib/asset-cache.mjs), [mirage/lib/response-headers.mjs](../mirage/lib/response-headers.mjs), [mirage/lib/local-self-origin.mjs](../mirage/lib/local-self-origin.mjs).

GitHub: `SSRF asset proxy in:name,description,readme` — page 1, up to 10 results.

1. [nexu-io/open-design](https://github.com/nexu-io/open-design)
2. [vavkamil/awesome-bugbounty-tools](https://github.com/vavkamil/awesome-bugbounty-tools)
3. [hahwul/WebHackersWeapons](https://github.com/hahwul/WebHackersWeapons)
4. [assetnote/blind-ssrf-chains](https://github.com/assetnote/blind-ssrf-chains)
5. [DEEIX-AI/DEEIX-Chat](https://github.com/DEEIX-AI/DEEIX-Chat)
6. [gotr00t0day/spyhunt](https://github.com/gotr00t0day/spyhunt)
7. [cr0hn/vulnerable-node](https://github.com/cr0hn/vulnerable-node)
8. [KeygraphHQ/shannon](https://github.com/KeygraphHQ/shannon)
9. [h4ckf0r0day/obscura](https://github.com/h4ckf0r0day/obscura)
10. [agentic-community/mcp-gateway-registry](https://github.com/agentic-community/mcp-gateway-registry)

npm: `ssrf proxy protection` — first registry result list, up to 10 packages.

1. [request-filtering-agent 3.2.1](https://www.npmjs.com/package/request-filtering-agent) — An http(s).Agent implementation that block request Private IP address.; source: [declared repository](https://github.com/azu/request-filtering-agent.git).
2. [ssrf-req-filter 1.1.1](https://www.npmjs.com/package/ssrf-req-filter) — Module to prevent SSRF when making requests; source: [declared repository](https://github.com/y-mehta/ssrf-req-filter.git).
3. [http-proxy-agent 9.1.0](https://www.npmjs.com/package/http-proxy-agent) — An HTTP(s) proxy &#96;http.Agent&#96; implementation for HTTP; source: [declared repository](https://github.com/TooTallNate/proxy-agents.git).
4. [proxy-from-env 2.1.0](https://www.npmjs.com/package/proxy-from-env) — Offers getProxyForUrl to get the proxy URL for a URL, respecting the &#42;&#95;PROXY (e.g. HTTP&#95;PROXY) and NO&#95;PROXY environment variables.; source: [declared repository](https://github.com/Rob--W/proxy-from-env.git).
5. [proxy-agent 8.0.2](https://www.npmjs.com/package/proxy-agent) — Maps proxy protocols to &#96;http.Agent&#96; implementations; source: [declared repository](https://github.com/TooTallNate/proxy-agents.git).
6. [https-proxy-agent 9.1.0](https://www.npmjs.com/package/https-proxy-agent) — An HTTP(s) proxy &#96;http.Agent&#96; implementation for HTTPS; source: [declared repository](https://github.com/TooTallNate/proxy-agents.git).
7. [proxy-addr 2.0.8](https://www.npmjs.com/package/proxy-addr) — Determine address of proxied request; source: [declared repository](https://github.com/jshttp/proxy-addr.git).
8. [http-proxy-middleware 4.2.1](https://www.npmjs.com/package/http-proxy-middleware) — The one-liner node.js proxy middleware for connect, express, next.js and more; source: [declared repository](https://github.com/chimurai/http-proxy-middleware.git).
9. [got-ssrf 3.0.0](https://www.npmjs.com/package/got-ssrf) — Protect Got requests from SSRF; source: [declared repository](https://github.com/hanover-computing/got-ssrf.git).
10. [socks-proxy-agent 10.1.0](https://www.npmjs.com/package/socks-proxy-agent) — A SOCKS proxy &#96;http.Agent&#96; implementation for HTTP and HTTPS; source: [declared repository](https://github.com/TooTallNate/proxy-agents.git).

<a id="extra-file-resource-confinement"></a>

### Local resource admission, path confinement, symlink checks and safe source reads

Sources: [lense/local-file.mjs](../lense/local-file.mjs), [mirage/lib/model-driven-resources.mjs](../mirage/lib/model-driven-resources.mjs), [mirage/lib/code-components.mjs](../mirage/lib/code-components.mjs), [mirage/lib/transactional-files.mjs](../mirage/lib/transactional-files.mjs).

GitHub: `node symlink security in:name,description,readme` — page 1, up to 10 results.

1. [lirantal/awesome-nodejs-security](https://github.com/lirantal/awesome-nodejs-security)
2. [jgraph/drawio-desktop](https://github.com/jgraph/drawio-desktop)
3. [tech-leads-club/agent-skills](https://github.com/tech-leads-club/agent-skills)
4. [shelljs/shelljs](https://github.com/shelljs/shelljs)
5. [OpenZWave/node-openzwave-shared](https://github.com/OpenZWave/node-openzwave-shared)
6. [yarnpkg/yarn](https://github.com/yarnpkg/yarn)
7. [ehmicky/cross-platform-node-guide](https://github.com/ehmicky/cross-platform-node-guide)
8. [PlamenTSV/plamen](https://github.com/PlamenTSV/plamen)
9. [FR0ZON3/notion-mcp](https://github.com/FR0ZON3/notion-mcp)
10. [runkids/skillshare](https://github.com/runkids/skillshare)

npm: `safe file path` — first registry result list, up to 10 packages.

1. [safe-buffer 5.2.1](https://www.npmjs.com/package/safe-buffer) — Safer Node.js Buffer API; source: a repository is declared in registry metadata.
2. [jsc-safe-url 0.2.4](https://www.npmjs.com/package/jsc-safe-url) — Utility functions for converting to and from URLs that encode query string data into URL paths; source: [declared repository](https://github.com/robhogan/jsc-safe-url.git).
3. [uid-safe 2.1.5](https://www.npmjs.com/package/uid-safe) — URL and cookie safe UIDs; source: [declared repository](https://github.com/crypto-utils/uid-safe.git).
4. [safe-regex 2.1.1](https://www.npmjs.com/package/safe-regex) — detect possibly catastrophic, exponential-time regular expressions; source: a repository is declared in registry metadata.
5. [atomically 2.1.1](https://www.npmjs.com/package/atomically) — Read and write files atomically and reliably.; source: [declared repository](https://github.com/fabiospampinato/atomically.git).
6. [safer-buffer 2.1.2](https://www.npmjs.com/package/safer-buffer) — Modern Buffer API polyfill without footguns; source: [declared repository](https://github.com/ChALkeR/safer-buffer.git).
7. [json-stringify-safe 5.0.1](https://www.npmjs.com/package/json-stringify-safe) — Like JSON.stringify, but doesn't blow up on circular refs.; source: a repository is declared in registry metadata.
8. [safe-array-concat 1.1.4](https://www.npmjs.com/package/safe-array-concat) — &#96;Array.prototype.concat&#96;, but made safe by ignoring Symbol.isConcatSpreadable; source: [declared repository](https://github.com/ljharb/safe-array-concat.git).
9. [upath 3.0.8](https://www.npmjs.com/package/upath) — A drop-in replacement / proxy to Node.js path, replacing \\ with / for all results &#38; adding file extension functions.; source: [declared repository](https://github.com/anodynos/upath.git).
10. [safe-push-apply 1.0.0](https://www.npmjs.com/package/safe-push-apply) — Push an array of items into an array, while being robust against prototype modification; source: [declared repository](https://github.com/ljharb/safe-push-apply.git).

<a id="extra-custom-connector-definitions"></a>

### OpenAPI custom-connector schema, parameter validation and trusted C# script execution

Sources: [mirage/lib/connector-definition.mjs](../mirage/lib/connector-definition.mjs), [mirage/lib/custom-connector.mjs](../mirage/lib/custom-connector.mjs), [mirage/lib/custom-connector-script.mjs](../mirage/lib/custom-connector-script.mjs).

GitHub: `PowerPlatform custom connectors in:name,description,readme` — page 1, up to 10 results.

1. [microsoft/PowerPlatformConnectors](https://github.com/microsoft/PowerPlatformConnectors)
2. [microsoft/powerplatform-vscode](https://github.com/microsoft/powerplatform-vscode)
3. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
4. [microsoft/FHIRPower](https://github.com/microsoft/FHIRPower) — archived
5. [troystaylor/PowerPlatformConnectors](https://github.com/troystaylor/PowerPlatformConnectors)
6. [kalibin96/PowerPlatformConnectors](https://github.com/kalibin96/PowerPlatformConnectors)
7. [microsoft/powerplatform-qualtrics-api](https://github.com/microsoft/powerplatform-qualtrics-api) — archived
8. [Power-Maverick/PowerPlatform-VSCode-ExtensionPack](https://github.com/Power-Maverick/PowerPlatform-VSCode-ExtensionPack)
9. [pauldatta/meetGPT](https://github.com/pauldatta/meetGPT)
10. [rcb0727/powerplatform-mcp-server](https://github.com/rcb0727/powerplatform-mcp-server)

npm: `openapi connector` — first registry result list, up to 10 packages.

1. [fastify-openapi-connector-generator 2.0.0](https://www.npmjs.com/package/fastify-openapi-connector-generator) — Complimentary CLI tool for fastify-openapi-connector package. It generates prefabricates for handlers from OpenAPI specification.; source: [declared repository](https://github.com/martinek-stepan/fastify-openapi-connector.git).
2. [@mcpolyglot/connector-openapi 0.1.2](https://www.npmjs.com/package/@mcpolyglot/connector-openapi) — OpenAPI connector for mcpolyglot. Calls only operations in the spec, with a method allow-list and the host pinned to the configured base URL.; source: [declared repository](https://github.com/ishay60/mcpolyglot.git).
3. [fastify-openapi-connector 4.1.0](https://www.npmjs.com/package/fastify-openapi-connector) — Fastify plugin that will set-up routes with security &#38; json validation based on OpenAPI specification; source: [declared repository](https://github.com/martinek-stepan/fastify-openapi-connector.git).
4. [@apidevtools/openapi-schemas 2.1.0](https://www.npmjs.com/package/@apidevtools/openapi-schemas) — JSON Schemas for every version of the OpenAPI Specification; source: [declared repository](https://github.com/APIDevTools/openapi-schemas.git).
5. [@scalar/openapi-types 0.9.8](https://www.npmjs.com/package/@scalar/openapi-types) — Modern OpenAPI types; source: [declared repository](https://github.com/scalar/scalar.git).
6. [@google-cloud/cloud-sql-connector 1.12.1](https://www.npmjs.com/package/@google-cloud/cloud-sql-connector) — A JavaScript library for connecting securely to your Cloud SQL instances; source: [declared repository](https://github.com/GoogleCloudPlatform/cloud-sql-nodejs-connector.git).
7. [openapi-typescript 7.13.0](https://www.npmjs.com/package/openapi-typescript) — Convert OpenAPI 3.0 &#38; 3.1 schemas to TypeScript; source: [declared repository](https://github.com/openapi-ts/openapi-typescript.git).
8. [openapi-fetch 0.17.0](https://www.npmjs.com/package/openapi-fetch) — Fast, type-safe fetch client for your OpenAPI schema. Only 6 kb (min). Works with React, Vue, Svelte, or vanilla JS.; source: [declared repository](https://github.com/openapi-ts/openapi-typescript.git).
9. [@hey-api/openapi-ts 0.99.0](https://www.npmjs.com/package/@hey-api/openapi-ts) — 🌀 OpenAPI to TypeScript code generator. Production-grade SDKs, Zod schemas, TanStack Query hooks, and 20+ plugins. Used by Vercel, OpenCode, and PayPal.; source: [declared repository](https://github.com/hey-api/hey-api.git).
10. [@scalar/openapi-upgrader 0.4.6](https://www.npmjs.com/package/@scalar/openapi-upgrader) — Upgrade OpenAPI documents to the latest and greatest version; source: [declared repository](https://github.com/scalar/scalar.git).

<a id="extra-mobile-offline-sync"></a>

### Mobile offline profiles, local writes, replay, synchronization and conflict behavior

Sources: [mirage/lib/model-driven/offline.mjs](../mirage/lib/model-driven/offline.mjs), [mirage/lib/model-driven/client-runtime.mjs](../mirage/lib/model-driven/client-runtime.mjs).

GitHub: `Dataverse offline sync in:name,description,readme` — page 1, up to 10 results.

1. [context-and-oss/XrmBedrock](https://github.com/context-and-oss/XrmBedrock)
2. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
3. [microsoft/Power-CAT-Copilot-Studio-Kit](https://github.com/microsoft/Power-CAT-Copilot-Studio-Kit)
4. [hac01/azure-pentesting-suite](https://github.com/hac01/azure-pentesting-suite)
5. [singer-io/tap-ms-dynamics](https://github.com/singer-io/tap-ms-dynamics)
6. [lightspeed-core/lightspeed-to-dataverse-exporter](https://github.com/lightspeed-core/lightspeed-to-dataverse-exporter)
7. [Roelzz/mcs-agent-analyser](https://github.com/Roelzz/mcs-agent-analyser)
8. [ASSERT-KTH/awesome-open-science-software](https://github.com/ASSERT-KTH/awesome-open-science-software)
9. [mscottsewell/DataverseToPowerBI](https://github.com/mscottsewell/DataverseToPowerBI)
10. [punkpeye/awesome-mcp-servers](https://github.com/punkpeye/awesome-mcp-servers)

npm: `dataverse offline sync` — first registry result list, up to 10 packages.

1. [@microsoft/power-apps-native-offline 0.1.32](https://www.npmjs.com/package/@microsoft/power-apps-native-offline) — React Native SDK for Dataverse offline sync — extracted from PowerApps HostingSDK; source: no repository declared in search metadata.
2. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
3. [cacheable 2.5.0](https://www.npmjs.com/package/cacheable) — High Performance Layer 1 / Layer 2 Caching with Keyv Storage; source: [declared repository](https://github.com/jaredwray/cacheable.git).
4. [@scalar/helpers 0.16.4](https://www.npmjs.com/package/@scalar/helpers) — A collection of dependency free helpers; source: [declared repository](https://github.com/scalar/scalar.git).
5. [@scalar/schemas 0.15.0](https://www.npmjs.com/package/@scalar/schemas) — Schemas for Scalar packages; source: [declared repository](https://github.com/scalar/scalar.git).
6. [@scalar/types 0.25.0](https://www.npmjs.com/package/@scalar/types) — Types to work with Scalar packages; source: [declared repository](https://github.com/scalar/scalar.git).
7. [@tekstack/client-data-model 1.0.101](https://www.npmjs.com/package/@tekstack/client-data-model) — TekStack client-side Dataverse data model for TypeScript projects.; source: no repository declared in search metadata.
8. [sync-fetch 0.7.1](https://www.npmjs.com/package/sync-fetch) — Synchronous version of the Fetch API; source: [declared repository](https://github.com/larsgw/sync-fetch.git).
9. [@scalar/code-highlight 0.4.11](https://www.npmjs.com/package/@scalar/code-highlight) — Central methods and themes for code highlighting in Scalar projects; source: [declared repository](https://github.com/scalar/scalar.git).
10. [quansync 1.0.0](https://www.npmjs.com/package/quansync) — Create sync/async APIs with usable logic; source: [declared repository](https://github.com/quansync-dev/quansync.git).

<a id="extra-solution-alm-lifecycle"></a>

### Solution archives, dependencies, patches/upgrades, component membership and managed layers

Sources: [mirage/lib/dataverse-solutions.mjs](../mirage/lib/dataverse-solutions.mjs), [mirage/lib/dataverse-solution-messages.mjs](../mirage/lib/dataverse-solution-messages.mjs), [mirage/lib/dataverse-solution-components.mjs](../mirage/lib/dataverse-solution-components.mjs), [mirage/lib/dataverse-solution-assets.mjs](../mirage/lib/dataverse-solution-assets.mjs).

GitHub: `Dataverse solution lifecycle in:name,description,readme` — page 1, up to 10 results.

1. [github/copilot-plugins](https://github.com/github/copilot-plugins)
2. [microsoft/Dataverse-skills](https://github.com/microsoft/Dataverse-skills)
3. [microsoft/mcs-labs](https://github.com/microsoft/mcs-labs)
4. [scottdurow/power-platform-full-stack-skills](https://github.com/scottdurow/power-platform-full-stack-skills)
5. [microsoft/Power-CAT-Copilot-Studio-Kit](https://github.com/microsoft/Power-CAT-Copilot-Studio-Kit)
6. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
7. [microsoft/ai-agent-runbooks](https://github.com/microsoft/ai-agent-runbooks)
8. [PacktPublishing/Application-Lifecycle-Management-on-Microsoft-Power-Platform](https://github.com/PacktPublishing/Application-Lifecycle-Management-on-Microsoft-Power-Platform)
9. [PowerAppsDarren/PowerFxSnippets](https://github.com/PowerAppsDarren/PowerFxSnippets)
10. [Nachimak28/awesome-list-of-awesomes](https://github.com/Nachimak28/awesome-list-of-awesomes)

npm: `dataverse solution` — first registry result list, up to 10 packages.

1. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
2. [dataverse-ify 1.0.13](https://www.npmjs.com/package/dataverse-ify) — Easily call the Microsoft Dataverse WebApi using SDK style types. Works with 'dataverse-gen' to create early bound classes.; source: no repository declared in search metadata.
3. [@hart365/pp-md-pptb-edition 1.2.2](https://www.npmjs.com/package/@hart365/pp-md-pptb-edition) — Generate Power Platform documentation from either Solution ZIP files or direct Dataverse connection; source: [declared repository](https://github.com/Hart365/pp-md-pptb-edition.git).
4. [dataverse-gen 1.0.16](https://www.npmjs.com/package/dataverse-gen) — Earlybound types generator for dataverse-ify; source: no repository declared in search metadata.
5. [@microsoft/dataverse 1.0.82](https://www.npmjs.com/package/@microsoft/dataverse) — CLI tool for Dataverse, including stdio MCP server. Preview.; source: [declared repository](https://dev.azure.com/dynamicscrm/OneCRM/_git/DataverseCLI).
6. [pageslens 0.10.0](https://www.npmjs.com/package/pageslens) — Offline lint, policy tests and docs for Power Pages site configuration in source control; source: [declared repository](https://github.com/OOlashyn/pageslens.git).
7. [@tekstack/client-data-model 1.0.101](https://www.npmjs.com/package/@tekstack/client-data-model) — TekStack client-side Dataverse data model for TypeScript projects.; source: no repository declared in search metadata.
8. [@theatre/dataverse 0.7.2](https://www.npmjs.com/package/@theatre/dataverse) — No description; source: [declared repository](https://github.com/AriaMinaei/theatre).
9. [@rededis/dataverse-mcp-server 0.9.0](https://www.npmjs.com/package/@rededis/dataverse-mcp-server) — MCP server for Microsoft Dataverse API; source: [declared repository](https://github.com/rededis/dataverse-mcp-server.git).
10. [dataverse-plugins-native 0.1.0](https://www.npmjs.com/package/dataverse-plugins-native) — Build and deploy Dataverse low-code plug-ins (instant Functions and automated plug-ins) from a CLI, an agent, or a local UI. Self-contained: no Power Platform CLI or app registration needed.; source: [declared repository](https://github.com/wyattdave/LowCode-Plugins.git).

<a id="extra-currency-exchange-precision"></a>

### Transaction/base currency conversion, exchange rates and precision source semantics

Sources: [mirage/lib/dataverse-currency.mjs](../mirage/lib/dataverse-currency.mjs), [mirage/lib/attribute-metadata.mjs](../mirage/lib/attribute-metadata.mjs).

GitHub: `Dataverse currency precision in:name,description,readme` — page 1, up to 10 results.

1. [mwhesse/dataverse-mcp](https://github.com/mwhesse/dataverse-mcp)
2. [markus-tobler/dataverse-metadata-mcp](https://github.com/markus-tobler/dataverse-metadata-mcp)
3. [wtyeung/dataverse-diagram](https://github.com/wtyeung/dataverse-diagram)
4. [wtyeung/n8n-nodes-ms-dataverse](https://github.com/wtyeung/n8n-nodes-ms-dataverse)
5. [nicolaetarla/ONE-PCF-GroupedTotalsGrid](https://github.com/nicolaetarla/ONE-PCF-GroupedTotalsGrid)
6. [codata/croissant-toolkit](https://github.com/codata/croissant-toolkit)
7. [kellycason/Access-To-Power](https://github.com/kellycason/Access-To-Power)
8. [guySteve/Tinkerbellshit](https://github.com/guySteve/Tinkerbellshit)
9. [HurleySk/NewDataverseSchemaCreatorAndDetector](https://github.com/HurleySk/NewDataverseSchemaCreatorAndDetector)
10. [robertacasu90/databridge](https://github.com/robertacasu90/databridge)

npm: `currency precision decimal` — first registry result list, up to 10 packages.

1. [fraction.js 5.3.4](https://www.npmjs.com/package/fraction.js) — The RAW rational numbers library; source: a repository is declared in registry metadata.
2. [decimal.js 10.6.0](https://www.npmjs.com/package/decimal.js) — An arbitrary-precision Decimal type for JavaScript.; source: [declared repository](https://github.com/MikeMcl/decimal.js.git).
3. [decimal.js-light 2.5.1](https://www.npmjs.com/package/decimal.js-light) — An arbitrary-precision Decimal type for JavaScript.; source: [declared repository](https://github.com/MikeMcl/decimal.js-light.git).
4. [react-currency-input-field 4.0.14](https://www.npmjs.com/package/react-currency-input-field) — React &#60;input/&#62; component for formatting currency and numbers.; source: [declared repository](https://github.com/cchanxzy/react-currency-input-field.git).
5. [locale-currency 1.1.0](https://www.npmjs.com/package/locale-currency) — A map of locale codes to ISO 4217 currency codes, plus currency decimal-place (minor unit) data. Supports BCP 47, i18n, and ISO 3166-1 alpha-2 formats.; source: [declared repository](https://github.com/tadeegan/locale-currency.git).
6. [js-big-decimal 2.2.0](https://www.npmjs.com/package/js-big-decimal) — Work with large numbers on the client side. Round them off to any required precision.; source: [declared repository](https://github.com/royNiladri/js-big-decimal.git).
7. [@woocommerce/currency 6.0.0](https://www.npmjs.com/package/@woocommerce/currency) — WooCommerce currency utilities.; source: [declared repository](https://github.com/woocommerce/woocommerce.git).
8. [node-int64 0.4.0](https://www.npmjs.com/package/node-int64) — Support for representing 64-bit integers in JavaScript; source: [declared repository](https://github.com/broofa/node-int64).
9. [bignumber.js 11.1.5](https://www.npmjs.com/package/bignumber.js) — A library for arbitrary-precision decimal and non-decimal arithmetic; source: [declared repository](https://github.com/MikeMcl/bignumber.js.git).
10. [extsprintf 1.4.1](https://www.npmjs.com/package/extsprintf) — extended POSIX-style sprintf; source: [declared repository](https://github.com/davepacheco/node-extsprintf.git).

<a id="extra-business-process-flow"></a>

### Business process flow stages, instance state, stage transitions and navigation

Sources: [mirage/lib/dataverse-bpf.mjs](../mirage/lib/dataverse-bpf.mjs).

GitHub: `business process flow in:name,description,readme` — page 1, up to 10 results.

1. [flowable/flowable-engine](https://github.com/flowable/flowable-engine)
2. [ddd-crew/ddd-starter-modelling-process](https://github.com/ddd-crew/ddd-starter-modelling-process)
3. [crewAIInc/crewAI](https://github.com/crewAIInc/crewAI)
4. [kestra-io/kestra](https://github.com/kestra-io/kestra)
5. [crewAIInc/crewAI-examples](https://github.com/crewAIInc/crewAI-examples) — archived
6. [bytedance/deer-flow](https://github.com/bytedance/deer-flow)
7. [meirwah/awesome-workflow-engines](https://github.com/meirwah/awesome-workflow-engines)
8. [rafaelfgx/Architecture](https://github.com/rafaelfgx/Architecture)
9. [chatwoot/chatwoot](https://github.com/chatwoot/chatwoot)
10. [berndruecker/flowing-retail](https://github.com/berndruecker/flowing-retail)

npm: `business process flow` — first registry result list, up to 10 packages.

1. [@babel/preset-flow 8.0.1](https://www.npmjs.com/package/@babel/preset-flow) — Babel preset for all Flow plugins.; source: [declared repository](https://github.com/babel/babel.git).
2. [ast-types-flow 0.0.8](https://www.npmjs.com/package/ast-types-flow) — Flow types for the Javascript AST; source: [declared repository](https://github.com/kyldvs/ast-types-flow.git).
3. [@solid-primitives/keyed 1.5.3](https://www.npmjs.com/package/@solid-primitives/keyed) — Control Flow primitives and components that require specifying explicit keys to identify or rerender elements.; source: [declared repository](https://github.com/solidjs-community/solid-primitives.git).
4. [fbjs 3.0.5](https://www.npmjs.com/package/fbjs) — A collection of utility libraries used by other Facebook JS projects; source: [declared repository](https://github.com/facebook/fbjs.git).
5. [@xyflow/react 12.12.0](https://www.npmjs.com/package/@xyflow/react) — React Flow - A highly customizable React library for building node-based editors and interactive flow charts.; source: [declared repository](https://github.com/xyflow/xyflow.git).
6. [polished 4.3.1](https://www.npmjs.com/package/polished) — A lightweight toolset for writing styles in Javascript.; source: [declared repository](https://github.com/styled-components/polished.git).
7. [hermes-parser 0.37.0](https://www.npmjs.com/package/hermes-parser) — A JavaScript parser built from the Hermes engine; source: [declared repository](https://github.com/facebook/hermes.git).
8. [mitra-interactions-sdk 1.0.72](https://www.npmjs.com/package/mitra-interactions-sdk) — SDK agnóstico para interações com a plataforma Mitra; source: no repository declared in search metadata.
9. [eslint-plugin-ft-flow 3.0.11](https://www.npmjs.com/package/eslint-plugin-ft-flow) — Flowtype linting rules for ESLint by flow-typed; source: [declared repository](https://github.com/flow-typed/eslint-plugin-ft-flow.git).
10. [@babel/plugin-syntax-flow 8.0.1](https://www.npmjs.com/package/@babel/plugin-syntax-flow) — Allow parsing of the flow syntax; source: [declared repository](https://github.com/babel/babel.git).

<a id="extra-business-rule-evaluation"></a>

### Source-backed business-rule conditions and field validation/actions

Sources: [mirage/lib/dataverse-business-rules.mjs](../mirage/lib/dataverse-business-rules.mjs), [mirage/lib/dataverse-workflows.mjs](../mirage/lib/dataverse-workflows.mjs).

GitHub: `PowerApps business rules in:name,description,readme` — page 1, up to 10 results.

1. [rwilson504/PCFControls](https://github.com/rwilson504/PCFControls)
2. [zenitysec/awesome-low-code](https://github.com/zenitysec/awesome-low-code)
3. [DanielKerridge/claude-code-power-platform-skills](https://github.com/DanielKerridge/claude-code-power-platform-skills)
4. [microsoft/companynewspcfcontrol](https://github.com/microsoft/companynewspcfcontrol) — archived
5. [amplifyit/powerux](https://github.com/amplifyit/powerux) — archived
6. [Ditectrev/Microsoft-Azure-AZ-900-Microsoft-Azure-Fundamentals-Practice-Tests-Exams-Questions-Answers](https://github.com/Ditectrev/Microsoft-Azure-AZ-900-Microsoft-Azure-Fundamentals-Practice-Tests-Exams-Questions-Answers)
7. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
8. [sreedharande/IngestOffice365AuditLogs](https://github.com/sreedharande/IngestOffice365AuditLogs)
9. [olafwrieden/azure-data-archiving-practices](https://github.com/olafwrieden/azure-data-archiving-practices)
10. [MartinPankraz/PowerApp-SCP-BizzRules-Prototype](https://github.com/MartinPankraz/PowerApp-SCP-BizzRules-Prototype)

npm: `business rules engine` — first registry result list, up to 10 packages.

1. [@gorules/zen-engine 2.1.9](https://www.npmjs.com/package/@gorules/zen-engine) — Open-source Business Rules Engine for Node.js, powered by Rust; source: [declared repository](https://github.com/gorules/zen.git).
2. [@gorules/zen-engine-linux-x64-gnu 2.1.9](https://www.npmjs.com/package/@gorules/zen-engine-linux-x64-gnu) — Open-source Business Rules Engine for Node.js, powered by Rust; source: [declared repository](https://github.com/gorules/zen.git).
3. [@gorules/zen-engine-linux-x64-musl 2.1.9](https://www.npmjs.com/package/@gorules/zen-engine-linux-x64-musl) — Open-source Business Rules Engine for Node.js, powered by Rust; source: [declared repository](https://github.com/gorules/zen.git).
4. [@gorules/zen-engine-linux-arm64-gnu 2.1.9](https://www.npmjs.com/package/@gorules/zen-engine-linux-arm64-gnu) — Open-source Business Rules Engine for Node.js, powered by Rust; source: [declared repository](https://github.com/gorules/zen.git).
5. [node-rules 9.2.0](https://www.npmjs.com/package/node-rules) — Business Rules Engine for JavaScript; source: [declared repository](https://github.com/mithunsatheesh/node-rules.git).
6. [@gorules/zen-engine-linux-arm64-musl 2.1.9](https://www.npmjs.com/package/@gorules/zen-engine-linux-arm64-musl) — Open-source Business Rules Engine for Node.js, powered by Rust; source: [declared repository](https://github.com/gorules/zen.git).
7. [@gorules/zen-engine-darwin-arm64 2.1.9](https://www.npmjs.com/package/@gorules/zen-engine-darwin-arm64) — Open-source Business Rules Engine for Node.js, powered by Rust; source: [declared repository](https://github.com/gorules/zen.git).
8. [@gorules/zen-engine-darwin-x64 2.1.9](https://www.npmjs.com/package/@gorules/zen-engine-darwin-x64) — Open-source Business Rules Engine for Node.js, powered by Rust; source: [declared repository](https://github.com/gorules/zen.git).
9. [@gorules/zen-engine-win32-x64-msvc 2.1.9](https://www.npmjs.com/package/@gorules/zen-engine-win32-x64-msvc) — Open-source Business Rules Engine for Node.js, powered by Rust; source: [declared repository](https://github.com/gorules/zen.git).
10. [@gorules/zen-engine-wasm32-wasi 2.1.4](https://www.npmjs.com/package/@gorules/zen-engine-wasm32-wasi) — Open-source Business Rules Engine for Node.js, powered by Rust; source: [declared repository](https://github.com/gorules/zen.git).

<a id="extra-service-protection"></a>

### Dataverse request limits, rate/concurrency throttling and retry contracts

Sources: [mirage/lib/dataverse-limits.mjs](../mirage/lib/dataverse-limits.mjs), [mirage/lib/connector-runtime.mjs](../mirage/lib/connector-runtime.mjs).

GitHub: `Dataverse throttling in:name,description,readme` — page 1, up to 10 results.

1. [troystaylor/SharingIsCaring](https://github.com/troystaylor/SharingIsCaring)
2. [microsoft/PowerPlatform-DataverseClient-Python](https://github.com/microsoft/PowerPlatform-DataverseClient-Python)
3. [allandecastro/dataverse-erd-visualizer](https://github.com/allandecastro/dataverse-erd-visualizer)
4. [rezanid/PSDataverse](https://github.com/rezanid/PSDataverse)
5. [mgwojciech/mgwdev-m365-helpers](https://github.com/mgwojciech/mgwdev-m365-helpers)
6. [bhakthan/awesome-microsoft-fabric](https://github.com/bhakthan/awesome-microsoft-fabric)
7. [mohsinonxrm/pptb-mxrm-fetchxml-studio](https://github.com/mohsinonxrm/pptb-mxrm-fetchxml-studio)
8. [TheLobbi/Claude-m](https://github.com/TheLobbi/Claude-m)
9. [rededis/dataverse-mcp-server](https://github.com/rededis/dataverse-mcp-server)
10. [hac01/azure-pentesting-suite](https://github.com/hac01/azure-pentesting-suite)

npm: `dataverse retry throttling` — first registry result list, up to 10 packages.

1. [@octokit/plugin-throttling 11.0.5](https://www.npmjs.com/package/@octokit/plugin-throttling) — Octokit plugin for GitHub's recommended request throttling; source: [declared repository](https://github.com/octokit/plugin-throttling.js.git).
2. [@humanwhocodes/retry 0.4.3](https://www.npmjs.com/package/@humanwhocodes/retry) — A utility to retry failed async methods.; source: [declared repository](https://github.com/humanwhocodes/retry.git).
3. [dynamics-web-api 2.5.1](https://www.npmjs.com/package/dynamics-web-api) — DynamicsWebApi is a Microsoft Dataverse Web API helper library; source: [declared repository](https://github.com/AleksandrRogov/DynamicsWebApi.git).
4. [promise-retry 2.0.1](https://www.npmjs.com/package/promise-retry) — Retries a function that returns a promise, leveraging the power of the retry module.; source: a repository is declared in registry metadata.
5. [@gar/promise-retry 1.0.3](https://www.npmjs.com/package/@gar/promise-retry) — Retries a function that returns a promise, leveraging the power of the retry module.; source: a repository is declared in registry metadata.
6. [p-retry 8.0.1](https://www.npmjs.com/package/p-retry) — Retry a promise-returning or async function; source: [declared repository](https://github.com/sindresorhus/p-retry.git).
7. [is-retry-allowed 3.0.0](https://www.npmjs.com/package/is-retry-allowed) — Check whether a request can be retried based on the &#96;error.code&#96;; source: [declared repository](https://github.com/sindresorhus/is-retry-allowed.git).
8. [@convex-dev/workpool 0.4.14](https://www.npmjs.com/package/@convex-dev/workpool) — Convex component for queued background jobs with configurable concurrency, action retries, backoff, and completion callbacks.; source: [declared repository](https://github.com/get-convex/workpool.git).
9. [@urql/exchange-retry 2.0.0](https://www.npmjs.com/package/@urql/exchange-retry) — An exchange for operation retry support in urql; source: [declared repository](https://github.com/urql-graphql/urql.git).
10. [fetch-retry 6.0.0](https://www.npmjs.com/package/fetch-retry) — Extend any fetch library with retry functionality; source: [declared repository](https://github.com/jonbern/fetch-retry.git).

<a id="extra-workqueues-activity-scheduling"></a>

### Store-backed work queues, dequeue/SLA/history and native calendar/activity scheduling contracts

Sources: [mirage/lib/dataverse-addon-workqueues.mjs](../mirage/lib/dataverse-addon-workqueues.mjs), [mirage/lib/dataverse-calendar-messages.mjs](../mirage/lib/dataverse-calendar-messages.mjs), [mirage/lib/dataverse-activity-messages.mjs](../mirage/lib/dataverse-activity-messages.mjs).

GitHub: `Dataverse work queues in:name,description,readme` — page 1, up to 10 results.

1. [demianrasko/Dynamics-365-Workflow-Tools](https://github.com/demianrasko/Dynamics-365-Workflow-Tools)
2. [rcb0727/powerplatform-mcp-docs](https://github.com/rcb0727/powerplatform-mcp-docs)
3. [context-and-oss/XrmBedrock](https://github.com/context-and-oss/XrmBedrock)
4. [AleksandrRogov/DynamicsWebApi](https://github.com/AleksandrRogov/DynamicsWebApi)
5. [IQSS/dataverse-metrics](https://github.com/IQSS/dataverse-metrics)
6. [ewingjm/development-hub](https://github.com/ewingjm/development-hub)
7. [EvilFlowersCatalog/EvilFlowersCatalog](https://github.com/EvilFlowersCatalog/EvilFlowersCatalog)
8. [jhd3197/Faro](https://github.com/jhd3197/Faro)
9. [hac01/azure-pentesting-suite](https://github.com/hac01/azure-pentesting-suite)
10. [rcb0727/powerplatform-mcp-server](https://github.com/rcb0727/powerplatform-mcp-server)

npm: `work queue scheduling` — first registry result list, up to 10 packages.

1. [queue-microtask 1.2.3](https://www.npmjs.com/package/queue-microtask) — fast, tiny &#96;queueMicrotask&#96; shim for modern engines; source: a repository is declared in registry metadata.
2. [setimmediate 1.0.5](https://www.npmjs.com/package/setimmediate) — A shim for the setImmediate efficient script yielding API; source: [declared repository](https://github.com/yuzujs/setImmediate.git).
3. [yocto-queue 1.2.2](https://www.npmjs.com/package/yocto-queue) — Tiny queue data structure; source: [declared repository](https://github.com/sindresorhus/yocto-queue.git).
4. [p-queue 10.0.0](https://www.npmjs.com/package/p-queue) — Promise queue with concurrency control; source: [declared repository](https://github.com/sindresorhus/p-queue.git).
5. [fastq 1.20.3](https://www.npmjs.com/package/fastq) — Fast, in memory work queue; source: [declared repository](https://github.com/mcollina/fastq.git).
6. [main-thread-scheduling 14.3.0](https://www.npmjs.com/package/main-thread-scheduling) — Fast and consistently responsive apps using a single function call; source: [declared repository](https://github.com/astoilkov/main-thread-scheduling.git).
7. [@convex-dev/batch-worker 0.3.6](https://www.npmjs.com/package/@convex-dev/batch-worker) — A batch worker component for Convex.; source: [declared repository](https://github.com/get-convex/batch-worker.git).
8. [tinyqueue 3.0.0](https://www.npmjs.com/package/tinyqueue) — The smallest and simplest JavaScript priority queue; source: [declared repository](https://github.com/mourner/tinyqueue.git).
9. [@azure/storage-queue 12.32.0](https://www.npmjs.com/package/@azure/storage-queue) — Microsoft Azure Storage SDK for JavaScript - Queue; source: [declared repository](https://github.com/Azure/azure-sdk-for-js.git).
10. [backburner.js 2.8.0](https://www.npmjs.com/package/backburner.js) — Backburner.js is a simple run loop-esque library for coalescing actions; source: [declared repository](https://github.com/BackburnerJS/backburner.js.git).
