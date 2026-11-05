# Offline source quality analysis

Paqvilo owns an independent static analysis module for exported Power Pages sources. Doctor includes its findings as advice. Use `analyze` to enforce a quality threshold in a project or CI:

```sh
node bin/paqvilo.mjs lense doctor --config <catalogue> --all --json
node bin/paqvilo.mjs lense analyze --config <catalogue> --all --json
node bin/paqvilo.mjs lense doctor --config <catalogue> --all --fail-on warning
```

For an installed project, replace `node bin/paqvilo.mjs` with `npx --no-install paqvilo`. Existing source/site/environment selection rules apply. Analysis does not launch a browser, request a portal, install or execute a project package, run PAC, modify source, synchronize, upload or deploy.

## Verdicts and evidence

`--fail-on` accepts `none`, `error`, `warning` or `hint`. Doctor defaults to `none`; its existing Lense/Sources/Mirage verdicts remain independent. `analyze` defaults to `error`. A selected threshold fails for findings at that level or above, or for incomplete inventory. `none` leaves analysis advisory even when incomplete; it does not override other Doctor failures. Standalone Mirage runtimes are outside this portal analyzer and fail an explicitly requested Doctor analysis gate.

- **Error:** directly observed invalid or incompatible source configuration. This does not establish deployed behavior or temporary platform exemptions.
- **Warning:** a concrete risk or quality concern requiring review; intentional configurations can be valid.
- **Hint:** an improvement opportunity, unresolved dependency or contextual pattern requiring further evidence.

Every finding contains a stable rule ID, severity, category, confidence, relative file, line/column, optional field and validated metadata record GUID, fixed message, remediation and reference links. No source excerpts, setting values, record names, URLs from source or parser error messages are copied into findings. Source filenames remain visible, so keep reports in the project's ignored state when they identify a private project. Human-readable paths escape terminal controls.

Direct text files and YAML keys have exact locations. Embedded YAML values and enhanced XML JSON fields use an approximate declaration anchor (`exactLocation: false`); content findings additionally expose `contentLine`/`contentColumn` within the decoded field. Finding IDs derive from the rule and location; moving a record can change its finding ID. They are not waiver IDs or proof of unchanged behavior.

`complete` describes the bounded inventory of the stated source kinds. It is not a security, accessibility or runtime pass. Reports separately list skipped inputs, truncated findings, limits, evaluated rules and checks not performed. Environment-backed/ambiguous settings remain unresolved. View-based Web API fields produce a verification hint because published view columns and runtime version are not established locally. `sourceDigest` fingerprints the files actually read, including relative paths; incomplete reports fingerprint only that partial set. It is not a deployment/build receipt.

## Implemented checks

| IDs                               | Source condition                                                                      | Default                                         |
| --------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------- |
| `PAQ-SOURCE-001`                  | Unparsed record YAML or enhanced component content                                    | Error                                           |
| `PP-API-001`                      | Wildcard Web API fields setting                                                       | Error                                           |
| `PP-API-002`                      | Explicitly enabled Web API with no field list or view-based configuration             | Error                                           |
| `PP-API-003`                      | View-based fields need published-view/version verification                            | Hint                                            |
| `PP-API-004`                      | Mixed explicit/wildcard field list                                                    | Warning                                         |
| `PP-CONFIG-001`                   | Duplicate active setting names in one site                                            | Warning; dependent conclusions skipped          |
| `PP-CONFIG-002`                   | Relevant setting depends on external values or cannot be interpreted                  | Hint                                            |
| `PP-SEC-001`–`003`                | Inner errors enabled, default HTML encoding disabled, literal identity-secret setting | Warning                                         |
| `PP-ROLE-001`–`002`               | Multiple distinct active default anonymous/authenticated roles in one site            | Error                                           |
| `PP-PERF-001`                     | Explicit disabled header/footer output caching                                        | Warning; review dynamic content before enabling |
| `content.image-alt`               | Static image lacks `alt`; decorative `alt=""` and dynamic tags excluded               | Hint                                            |
| `content.blocking-head-script`    | External executable script in an explicit head lacks async/defer/module behavior      | Hint                                            |
| `content.fetchxml-all-attributes` | Explicit all-attribute projection                                                     | Warning                                         |
| `content.fetchxml-unbounded`      | Non-aggregate query lacks count/top; dynamic bounds excluded                          | Hint                                            |
| `content.fetchxml-in-loop`        | Query occurs within a Liquid loop                                                     | Hint                                            |
| `content.css-import`              | Runtime CSS import outside comments/strings                                           | Hint                                            |

Web API rules follow the [current Microsoft contract](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview): explicit fields and `UseFieldsFromView` can combine columns; view support needs site 9.8.8.x or later. Analysis does not guess logical names, EntitySetName, relationship names, required columns or an unused-field replacement.

## Inventory boundary and API

The inventory reads known portal record YAML (standard `adx_`, short keys and normalized `mspp_` fields), enhanced `powerpagecomponent.xml` content and envelope metadata, HTML/HTM/Liquid, CSS and JavaScript text. It supports aggregate YAML records and prefers existing markup sidecars over duplicated embedded values. Record normalization preserves source locations and does not resolve YAML aliases. JavaScript is inventoried; there are **no JavaScript dataflow, XSS or CSRF rules** in this first version. Generic text review also works on partial folders; it does not certify a complete portal export.

Dependencies, deployment profiles, hidden state (including discovery files), build/dist/out, coverage and local artifacts are excluded. `.powerpages-site` remains included. Links/junctions, unreadable/unsupported records, unknown enhanced component types, empty input and exhausted budgets are explicit incomplete results. Deployment-profile syntax remains the separate Doctor `--lint-profiles` check.

Default hard budgets are 10,000 files/directories/records/content units/findings, 100,000 directory entries, 2 MiB per file and 64 MiB total bytes. Reads use the existing confined descriptor-based local-file reader. Directory traversal is iterative and checked at open boundaries; no project code is imported. The API can lower budgets but cannot raise them beyond these ceilings:

```js
import { analyzeProject, analysisRules } from 'paqvilo/lense';

const report = analyzeProject('/absolute/export', {
  failOn: 'warning',
  limits: { fileBytes: 1024 * 1024 },
});
```

New rules need positive cases, negative controls, malformed/incomplete input cases and secret-redaction checks. Guidance is documentary evidence, not native behavior; these tests are tagged as Paqvilo contracts/security guarantees.

## Research and improvement plan

The design follows a deep review of [power-cat-skills](power-cat-quality-review.md) and [power-platform-skills](power-platform-quality-review.md), plus an [ecosystem comparison](power-platform-quality-ecosystem.md). Those notes pin commits, cover broader product areas, inventory CLI/packages/scripts, identify stale or contradictory advice and separate applicable logic from deferred work. No external skill, analyzer implementation or prompt is installed or executed.

Guide links use abbreviated upstream commit IDs. The [public source catalogue](../lense/analysis/sources.mjs) and each report's `sources` array retain the complete immutable commit IDs, review dates, licenses and transfer decisions. These identify public research inputs, not local test receipts.

| Stage                        | Implementation/model                                                                                                                 | Acceptance evidence                                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Delivered                    | Owned inventory, pure rule registry, redacted/versioned findings, Doctor advice, independent CLI gate and three research inventories | Invented fixtures, negative controls, controlled filesystem race regressions, offline CLI checks and full toolkit validation |
| Next: source graph           | Cross-file role/permission/page/parent graphs; explicit partial exports and unknown relationships; optional Solution metadata joins  | Invented schemas plus documentary compatibility tests; native recordings required before parity claims                       |
| Next: project policy         | Project-owned thresholds and intentional exceptions with reasons/expiry; stale-exception reporting; access-policy assertions         | Consumer-project tests; no organisation names or business requirements in core                                               |
| Next: reporting              | SARIF adapter, source-revision comparison and review UI preserving unknown/skipped states                                            | Schema validation, deterministic locations, bounded/redacted artifacts                                                       |
| Later: host adapters         | PCF manifests/host requirements, Solution metadata and exported flows using separate host-specific rules                             | Actual parser coverage and official package/recording evidence; avoid applying PCF restrictions to arbitrary site JS         |
| Authorized external evidence | Optional supplied Site Checker, accessibility/browser, dependency/secret scanner and Solution Checker results                        | Tool/version/input provenance and separate execution failures; never substitute external success for local/runtime evidence  |

`pac solution check` uploads a solution to Power Apps Checker. Site Checker, live security scanners, browser accessibility review, authentication and reference capture require separate authorized workflows. Offline Doctor never runs them or fails because they are not installed. Preserve operation-specific requirements and expected/observed/unknown evidence rather than treating every recommendation as an error.
