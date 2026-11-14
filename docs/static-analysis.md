# Offline Power Platform source analysis

Paqvilo owns a read-only analysis engine for local Power Platform projects. Review a folder, a Mirage project, or all sources declared by a catalogue:

```sh
node bin/paqvilo.mjs analyze --source <folder> --json
node bin/paqvilo.mjs analyze --project <project.yml> --fail-on warning --json
node bin/paqvilo.mjs analyze --config <catalogue> --all --json
node bin/paqvilo.mjs lense doctor --config <catalogue> --all --json
```

For installed projects, use `npx --no-install paqvilo`. The `lense analyze` spelling remains supported. Direct `--source` or `--project` selection does not require a portal, environment or catalogue. Catalogue analysis follows the selected site's portal sources, declared Solution roots, project metadata, Code Apps and Canvas sources. Standalone Dataverse/model-driven runtimes use their declared sources too. Configuration selects inputs without importing packs or providers.

## Findings and gates

`--fail-on` accepts `none`, `error`, `warning` or `hint`. Doctor defaults to `none`, keeping its existing operational verdict independent from source advice. `analyze` defaults to `error`. A selected threshold fails for findings at that level or above, or incomplete supported-source inspection. `none` remains advisory and does not certify incomplete input.

- **Error:** a proven invalid local source contract.
- **Warning:** a concrete risk or inconsistency requiring review; intended configurations may be valid.
- **Hint:** a possible improvement, missing contextual evidence or unresolved dependency.

Findings carry a stable rule ID, severity, category, confidence, source-relative location, explanation, remediation and references. Messages omit source excerpts, setting values, action names, source URLs and parser error text. Validated metadata GUIDs can identify portal records. Paths remain visible; keep private-project reports under the project's ignored `.paqvilo/`. Human-readable paths escape terminal controls.

`PAQ-SOURCE-001` identifies syntax that cannot be parsed, including malformed XML or embedded JSON. A readable
enhanced component envelope with absent, empty or unsupported record content receives `PAQ-SOURCE-002` and
incomplete coverage instead. Optional or withheld settings do not require disclosing secret values; an explicitly
empty/null setting inside a supported record payload is valid input.

Locations are exact where direct text/YAML positions are available. Decoded content uses an approximate declaration anchor (`exactLocation: false`) and optional decoded-content coordinates. IDs depend on rule and location; they are not waivers and can change when source moves.

## Source domains

The registry separates portal/web-content checks from Dataverse/Solution/model-driven, PCF/Canvas/Code Apps, and flow/connector/MCP adapters. Reports expose individual domain recognition and limitations; rules follow actual source contracts rather than assuming every file belongs to Power Pages.

| Source domain                       | Inspection boundary                                                                                                                  |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Power Pages and web content         | Standard/enhanced records, settings and roles; parsed HTML, CSS and Liquid/FetchXML patterns                                         |
| Dataverse and ALM                   | Solution metadata, declared dependencies, schema/registrations and environment/connection configuration; literal query contracts     |
| Model-driven apps                   | Exported forms, event/resource bindings and metadata associations; published/runtime state remains separate                          |
| PCF                                 | Control manifests, properties/resources/features and package/build contracts; requirements stay host-specific                        |
| Canvas                              | Supported PA YAML/legacy source and formula structure/patterns; formulas are not evaluated                                           |
| Code Apps                           | Explicit app/SDK/CLI/configuration, build/dependency/lock contracts and initialization patterns                                      |
| Power Automate                      | Exported flow structures, action/dependency graphs, connection bindings and source safety/performance hints                          |
| Custom connectors                   | Recognized OpenAPI operations, local references, parameters and security declarations; endpoints are not contacted                   |
| MCP apps                            | Recognized tool schemas, annotations and implementation pairing; annotations do not prove behavior                                   |
| Native mobile and extensions        | Source/package declarations and transferable project-quality guidance; native build/dispatcher/host/device evidence remains separate |
| Governance and process intelligence | Explicit evidence-required capabilities; application exports cannot establish tenant policy, health or business process metrics      |

`coverage.domains` distinguishes recognized source review, partial inspection and absent inputs. `capabilities` describes operation-specific tools and evidence for build, package, query, connector test, deployment, host/device, tenant and process operations. These are requirements, not executed checks or installed-tool proof. Missing PAC/.NET for deployment must not become an offline source-review error. Package declarations do not establish installed versions.

Some recommendations need context. Public access may be deliberate; view-based Web API fields need actual view/version evidence; dynamic query builders cannot be inferred from literals; project-specific routes and server-managed-field allowlists are not universal contracts. Unsupported source remains explicit rather than becoming a clean certification.

## Bounded local inventory

All roots share hard ceilings: 128 roots, 10,000 files/directories/records/content units/findings, 100,000 directory entries, 2 MiB per file and 64 MiB total processed bytes. API callers may lower them. Descriptor-based confined readers and directory-open checks protect filesystem boundaries. Overlapping files are not read twice; root labels disambiguate relative locations.

Solution ZIP, Canvas `.msapp` and mobile-extension packages are inspected in memory, never extracted. Member paths, CRCs, counts and inflated sizes are checked. Compressed and selected inflated bytes share the budget, including nested packages up to three archive levels. Larger/unsupported packages are incomplete; supply unpacked sources when appropriate.

Hidden state, discovery files, dependencies, deployment-profile directories and build outputs remain excluded. `.powerpages-site` is the export-source exception. Links/junctions, unreadable/unsupported sources, parse failures, unknown source-only inputs and exhausted budgets are explicit gaps. Ribbon definitions, formula definitions and web resource content in an unpacked solution are recognized without rules: they are listed as a limitation and do not make the inspection incomplete. Doctor `--lint-profiles` remains the separate deployment-profile syntax check.

`complete` describes bounded supported-source inspection. It does not mean every compiler, security, accessibility or runtime check passed. `sourceDigest` fingerprints paths and original bytes actually processed; partial input yields a partial fingerprint, not a deployment receipt. Reports preserve skips, rule execution, domain limitations and operations not performed.

```js
import { analyzeProject, analysisRules, analysisCapabilities } from 'paqvilo/lense';

const report = analyzeProject('/absolute/project', {
  failOn: 'warning',
  limits: { fileBytes: 1024 * 1024 },
});
```

For separate declared sources, API callers may pass `sourceRoots: [{ id: 'solution-1', path: '/absolute/solution', kind: 'solution' }]`. Root IDs must be unique. Analysis never executes project modules, Liquid, Power Fx, build scripts, scanners, PAC, browsers, flows, connectors or tenant requests.

## Extending quality coverage

Keep inventory, pure domain rules, diagnostics, presentation and operation evidence separate. Rules need an actual source contract, positive cases, valid negative controls, malformed/partial input and redaction tests. Native or official-package proof is required for parity claims; owned analyzer tests are contracts/security checks.

Project policy owns intended public access, routes, native targets, exceptions and business expectations. Additional adapters can import revision-bound SARIF, compiler/Solution Checker results and authorized runtime/accessibility evidence while preserving original severities, execution errors, skips and tool/input versions. `pac solution check` uploads a solution; builds, scanners, authentication, live tests and deployment remain separate explicit operations.

The [public provenance catalogue](../lense/analysis/sources.mjs) identifies upstream inputs. Rule references and capabilities identify applicable product contracts. Task-specific reviews, source inventories and audit evidence belong under ignored `.paqvilo/`, outside published documentation and packages.
