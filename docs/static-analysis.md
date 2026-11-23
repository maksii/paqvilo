# Offline Power Platform source analysis

`paqvilo analyze` (also `paqvilo lense analyze`) reviews local Power Platform sources read-only. It
never executes project modules, Liquid, Power Fx, build scripts, scanners, PAC, browsers, flows,
connectors or tenant requests.

```sh
npx --no-install paqvilo analyze --source <folder> --json
npx --no-install paqvilo analyze --project <project.yml> --fail-on warning --json
npx --no-install paqvilo analyze --config <catalogue> --all --json
npx --no-install paqvilo lense doctor --config <catalogue> --all --json
```

`--source` and `--project` need no portal, environment or catalogue. With `--config` (and `--site` or
`--all`), analysis follows each site's portal source, declared Solution roots, project metadata, Code
Apps and Canvas sources, including standalone Dataverse/model-driven runtimes; `--source` then overrides
the portal source. Configuration selects inputs without importing packs or providers. Run
`paqvilo analyze --help` for every option.

## Findings and gates

`--fail-on` is `none`, `error`, `warning` or `hint`; `analyze` defaults to `error` and `doctor` to `none`,
so doctor's operational verdict stays independent of source advice. A threshold fails on findings at that
level or above, and on incomplete inspection of supported sources.

Each result has a `verdict`: `ready` (complete, no finding at the threshold), `incomplete` (inspection did
not finish, whatever the threshold) or `error` (a finding reached the threshold). Text output uses it as
the report heading; a report that fails before analysis, such as a configuration error, is headed ERROR.
The separate `ready` field is the gate result, so `--fail-on none` gives `ready: true` even when the
verdict is `incomplete`; it certifies nothing.

- **Error:** a proven invalid local source contract.
- **Warning:** a concrete risk or inconsistency to review; intended configurations may be valid.
- **Hint:** a possible improvement, missing context or unresolved dependency.

Findings carry a stable rule ID, severity, category, confidence, source-relative location, explanation,
remediation and references. Messages omit source excerpts, setting values, action names, source URLs and
parser error text; paths and validated metadata GUIDs remain, so keep private reports under the project's
ignored `.paqvilo/`. Text output prints file paths relative to the working directory (terminal links) with
terminal controls escaped; `--json` keeps root-relative labels.

`PAQ-SOURCE-001` marks syntax that cannot be parsed, including malformed XML or embedded JSON. A readable
enhanced component envelope with absent, empty or unsupported record content gets `PAQ-SOURCE-002` and
incomplete coverage instead. An explicitly empty or null setting in a supported record is valid.

Locations are exact where text/YAML positions exist. In a JSON or YAML document read as data (flows,
connectors, MCP registrations, Code Apps, package and mobile configuration, Dataverse deployment settings
and specs) a finding points at the value its `field` names, or the object that lacks it; YAML aliases and
merge keys resolve to the anchor's position. Content decoded from an embedded string (such as a flow's
`clientdata`) uses an approximate declaration anchor (`exactLocation: false`). A Dataverse XML finding
points, approximately, at the child element its `field` names, else at the owning element. Finding
IDs depend on rule and location: they are not waivers and change when source moves.

## Source domains

Rules follow each source contract rather than assuming every file belongs to Power Pages. Reports show
recognition and limitations per domain.

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
| MCP apps                            | Recognized tool schemas, annotations and implementation pairing; annotations do not prove behaviour                                  |
| Native mobile and extensions        | Source/package declarations and transferable project-quality guidance; native build/dispatcher/host/device evidence remains separate |
| Governance and process intelligence | Explicit evidence-required capabilities; application exports cannot establish tenant policy, health or business process metrics      |

`coverage.domains` distinguishes reviewed, partially inspected and absent inputs. `capabilities` lists
what build, package, query, connector test, deployment, host/device, tenant and process operations would
need; these are requirements, not executed checks, and missing PAC/.NET is never a source-review error.
Package declarations do not establish installed versions.

Some advice needs context: public access may be deliberate, view-based Web API fields need actual view
evidence, dynamic query builders cannot be inferred from literals, and project routes or server-managed
field allowlists are not universal contracts.

## Bounded local inventory

Default ceilings, shared by all roots: 128 roots; 10,000 files, directories, records, content units and
findings; 100,000 directory entries; 2 MiB per file; 64 MiB processed in total. API callers may lower
them. Reads are descriptor-based and confined to their roots.

With several roots, a file is labelled relative to the roots' common folder (a project file does not
count); a root nested in another is read as its own root; a root outside that folder, or roots without
one, use a `<root id>/` prefix.

Solution ZIP, Canvas `.msapp` and mobile-extension packages are inspected in memory, never extracted:
member paths, CRCs, counts and inflated sizes are checked, compressed and inflated bytes share the
budget, and nesting stops at three archive levels. Larger or unsupported packages are incomplete; supply
unpacked sources. When an unpacked Canvas source (`Src/*.pa.yaml`) has the same unique name as a
Solution's packed app (the folder name, case-insensitive; see [Canvas apps](../mirage/docs/canvas-apps.md)),
the packed copy is listed under the Canvas domain's `superseded` instead of being inspected.

Hidden state, discovery files, dependencies, deployment-profile directories and build outputs are
excluded; `.powerpages-site` is the export-source exception. Dependencies are `node_modules` and
restored NuGet packages (a folder that holds a `.nupkg`, as `packages.config` restores and the
global packages folder keep one); an authored folder named `packages` is inventoried. Build outputs
are `bin`, `obj`, `dist`, `build`, `out`, `coverage`, `artifacts`, `logs`, `metrics` and `tmp`,
except under exported portal content folders. Links/junctions, unreadable or unsupported
sources, parse failures, unknown source-only inputs and exhausted budgets are explicit gaps. Ribbon
definitions, formula definitions, web resource content, Custom API request parameters and response
properties, and table chart definitions are recognized without rules: they are listed as limitations
and do not make inspection incomplete. Deployment-profile syntax is checked separately by
`lense doctor --lint-profiles`.

`complete` means bounded supported-source inspection finished, not that every compiler, security,
accessibility or runtime check passed. `sourceDigest` fingerprints the paths and bytes actually
processed; partial input gives a partial fingerprint, never a deployment receipt.

## API

```js
import { analyzeProject, analysisRules, analysisCapabilities } from 'paqvilo/lense';

const report = analyzeProject('/absolute/project', {
  failOn: 'warning',
  limits: { fileBytes: 1024 * 1024 },
  sourceRoots: [{ id: 'solution-1', path: '/absolute/solution', kind: 'solution' }],
});
```

`sourceRoots` adds separately declared sources; root IDs must be unique.

## Extending coverage

Keep inventory, pure domain rules, diagnostics, presentation and operation evidence separate. A rule
needs an actual source contract, positive cases, valid negative controls, malformed/partial input and
redaction tests; native or official-package proof is required before claiming parity. Project policy owns
intended public access, routes, exceptions and business expectations. External results (SARIF, compiler
or Solution Checker output, runtime/accessibility evidence) must keep their original severities, errors,
skips and tool/input versions. `pac solution check` uploads a solution, so it stays a separate explicit
operation.

The [provenance catalogue](../lense/analysis/sources.mjs) identifies upstream inputs. Task-specific
reviews and evidence belong under ignored `.paqvilo/`.
