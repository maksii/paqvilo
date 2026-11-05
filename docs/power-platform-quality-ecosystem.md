# Power Platform quality ecosystem review

Reviewed on 2026-11-05. This is a source review, not a native-platform recording or a claim of parity. No package was installed, no external script executed, and no live site or Dataverse environment inspected. The two Microsoft skill repositories are covered in their companion reviews; this document records the additional GitHub search and official-source cross-check.

## Search and provenance

GitHub repository searches included Power Pages lint/checker, Dataverse analyzer/checker, Power Platform static analysis/quality, recently created Power Pages repositories, and Microsoft PAC/tooling repositories. Results were filtered by actual relevance, then READMEs, rule catalogs, action manifests and licenses were read. Creation and main-branch commit dates below were checked through GitHub's repository and commit APIs. A recent date alone does not establish maturity.

| Repository                                                                                                                      | Reviewed commit and date   | Created    | License and maturity                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------- |
| [OOlashyn/pageslens](https://github.com/OOlashyn/pageslens/tree/7e0cb81890b0)                                                   | `7e0cb81890b0`, 2026-11-01 | 2026-10-23 | MIT. Explicitly early; enhanced code/classic site exports tested, standard data model not verified against a real site.         |
| [DFE-Digital/power-pages-security-utils](https://github.com/DFE-Digital/power-pages-security-utils/tree/a50240b58081)           | `a50240b58081`, 2026-08-04 | 2026-07-29 | No license detected in repository metadata. Treat as research, not a code donor.                                                |
| [djwmobley/dataverse-linter](https://github.com/djwmobley/dataverse-linter/tree/5403f81011b0)                                   | `5403f81011b0`, 2026-09-24 | 2026-05-04 | MIT. Small community PowerShell/PAC/API analyzer; heuristics need independent validation.                                       |
| [Microsoft Power Platform Playwright Samples](https://github.com/microsoft/power-platform-playwright-samples/tree/3233f3e73e30) | `3233f3e73e30`, 2026-10-28 | 2026-03-13 | MIT, confirmed from LICENSE (GitHub metadata reports NOASSERTION). Official samples, not proof of every runtime claim in prose. |
| [microsoft/powerplatform-actions](https://github.com/microsoft/powerplatform-actions/tree/6e91314a9c6e)                         | `6e91314a9c6e`, 2026-09-29 | 2020-08-06 | MIT. Established PAC-backed GitHub Actions; check current manifests rather than old README setup examples.                      |
| [microsoft/powerplatform-cli-wrapper](https://github.com/microsoft/powerplatform-cli-wrapper/tree/961514655ca3)                 | `961514655ca3`, 2026-10-06 | 2021-03-11 | MIT. Intermediate layer for PAC, Actions and Azure DevOps Build Tools.                                                          |
| [microsoft/PowerApps-Tooling](https://github.com/microsoft/PowerApps-Tooling/tree/27c396b37f2f)                                 | `27c396b37f2f`, 2026-10-28 | 2020-06-30 | MIT. Current repository warns that legacy PASopa is unsupported.                                                                |

## Useful tools and their boundaries

### pageslens

[The README](https://github.com/OOlashyn/pageslens/blob/7e0cb81890b0/README.md) describes deterministic offline analysis of PAC downloads and unpacked solutions. Its commands cover lint, project policy tests, access changes between revisions, download/solution alignment, and generated access documentation:

```sh
npx pageslens@0.13.0 lint path/to/site --format json
npx pageslens@0.13.0 test path/to/site --format json
npx pageslens@0.13.0 diff origin/main HEAD --site path/to/site --format json
npx pageslens@0.13.0 align path/to/site path/to/solution --format json
npx pageslens@0.13.0 docs path/to/site --out docs/site
```

These are reference examples, not dependencies or commands run by Paqvilo. `npx` may download code. A project's package version and CI should agree before someone explicitly chooses to use it.

[The rule catalog](https://github.com/OOlashyn/pageslens/blob/7e0cb81890b0/rules/README.md) has 19 rules covering Web API fields/permissions/errors, secret settings, role assignments, broad default-role write grants, permission parent chains and relationships, and classic page-access graphs. The [lint contract](https://github.com/OOlashyn/pageslens/blob/7e0cb81890b0/docs/lint.md) provides stable rule IDs, versioned JSON, severity configuration, GUID-based ignores, counts of ignored findings and stale-ignore reporting. [SARIF guidance](https://github.com/OOlashyn/pageslens/blob/7e0cb81890b0/docs/ci.md) preserves record locations and distinct analysis categories.

Its [policy model](https://github.com/OOlashyn/pageslens/blob/7e0cb81890b0/docs/policy.md) separates reusable mistakes from business requirements. Unresolved environment-variable values remain unknown. Its [agent guidance](https://github.com/OOlashyn/pageslens/blob/7e0cb81890b0/docs/agents.md) emphasizes reading machine output, using record identity, reviewing changes to access, and rechecking edits. These are useful review principles; they do not authorize changing project permissions or connecting to a tenant.

### Security utility scripts

[DFE-Digital's README](https://github.com/DFE-Digital/power-pages-security-utils/blob/a50240b58081/README.md) separates three very different operations:

- `analyze_table_perms.py` reads exported local records and emits a CSV report.
- `export_power_pages_inventory.py` connects to tenant/environment APIs.
- `powerpages_scanner.py` probes live sites for anonymous or under-authorized read/write exposure.

Only the first is offline. None is a Paqvilo doctor dependency. The analyzer distinguishes anonymous read from create-only grants, Web API enablement from Liquid rendering, and inactive records from current configuration. Those distinctions are useful, but its comments about Self/Parent scope and reachable data require independent official or native evidence. Absence of a matching setting is not proof of a deployed site's exposure.

### Dataverse PowerShell linter

[The README](https://github.com/djwmobley/dataverse-linter/blob/5403f81011b0/README.md) and [registry](https://github.com/djwmobley/dataverse-linter/blob/5403f81011b0/rules/registry.json) separate extraction from rule evaluation and cover JSON metadata payloads, CLI parameters, script hygiene and ALM ordering. Adversarial regression fixtures cover comments, quoting and false positives. This is a useful design pattern.

Its all-ERROR severity policy is unsuitable for Paqvilo. For example, requiring `--publish-changes` on every import, or a particular null-check pattern around every HTTP write, assumes workflow intent. The regex catalog cannot prove all relevant control flow. Reuse the idea of stable, explainable rules and explicit runtime-failure evidence; do not inherit blanket conclusions.

### Microsoft checker, CLI wrappers and browser tests

The [official PAC solution reference](https://learn.microsoft.com/en-us/power-platform/developer/cli/reference/solution#pac-solution-check) states that `pac solution check` uploads a solution to the Power Apps Checker service:

```sh
pac solution check --path Solution.zip --outputDirectory checker-results --geo Europe
```

This is an explicitly chosen external analysis step, not an offline check. `--saveResults` stores analysis in the environment; `--clearCache` changes enforcement cache. [Managed Environment enforcement guidance](https://learn.microsoft.com/en-us/troubleshoot/power-platform/dataverse/working-with-solutions/solution-checker-enforcement-import-issues) says exclusions/overrides are not equivalent to the enforced checker ruleset. Imported checker evidence must retain tool version, ruleset, input identity, exclusions and result status.

[The check-solution action manifest](https://github.com/microsoft/powerplatform-actions/blob/6e91314a9c6e/check-solution/action.yml) exposes credentials, geography, result artifacts and failure-on-analysis-error controls. [The wrapper README](https://github.com/microsoft/powerplatform-cli-wrapper/blob/961514655ca3/README.md) describes version coordination across PAC, Actions and Build Tools. Neither tool should run implicitly from doctor.

[Power Platform Playwright Samples](https://github.com/microsoft/power-platform-playwright-samples/blob/3233f3e73e30/README.md) uses readiness sentinels, page objects and Canvas-specific event/virtualization helpers. Those ideas support explicit readiness rather than sleeps. The samples require a live solution, authentication and cached storage state; they are not offline validation or permission to automate the user's tenant. Their Canvas/MDA semantics cannot establish Power Pages parity.

[PowerApps-Tooling's current warning](https://github.com/microsoft/PowerApps-Tooling/blob/27c396b37f2f/README.md) identifies PASopa as unsupported and `pac solution --processCanvasApps` as heading for deprecation. Older skill examples must not turn these into fresh recommendations.

## Official-source cross-check and rule candidates

| Candidate                                           | Appropriate conclusion                                     | Evidence and limitation                                                                                                                                                                                                                                                |
| --------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enabled Web API with literal wildcard fields        | Known invalid/deprecated configuration; error              | [Current Web API overview](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview#site-settings-for-the-web-api), updated 2026-10-09, says wildcard requests fail. This does not identify a deployed site's version.                                 |
| Enabled Web API without explicit fields             | Warn or error only after resolving the alternate view path | The same source permits `UseFieldsFromView=True` with eligible columns from the Power Pages Web API Columns view, available in 9.8.8.x+. Missing view metadata is unknown coverage.                                                                                    |
| `Webapi/error/innererror=true`                      | Warning to review diagnostic exposure                      | Same source documents false as the default. Absence should not fire.                                                                                                                                                                                                   |
| Inline secret-bearing setting                       | Security warning/error with value redacted                 | [Environment variables for site settings](https://learn.microsoft.com/en-us/power-pages/configure/environment-variables-for-site-settings). Distinguish local values from environment-backed settings. A local file alone does not prove a secret entered Git history. |
| Explicit default HTML encoding disablement          | Warning                                                    | [Liquid objects](https://learn.microsoft.com/en-us/power-pages/configure/liquid/liquid-objects) documents default user/request escaping since 9.3.8.x. Rendering context still matters.                                                                                |
| Broad default-role table grants                     | Warning requiring intent review                            | [Security best practices](https://learn.microsoft.com/en-us/power-pages/security/security-best-practices) favors relationship-based permissions and treats anonymous grants as public access. Public create-only forms can be deliberate.                              |
| Disabled validation, unsafe rendering or broad CORS | Explicit setting warnings; code heuristics as hints        | Same security guidance covers sanitization, authorization, CSRF, CAPTCHA, CSP and CORS. A snippet alone cannot establish exploitability or the absence of a wrapper.                                                                                                   |
| Image without `alt`                                 | Accessibility warning                                      | [Accessibility guidance](https://learn.microsoft.com/en-us/power-pages/admin/accessibility). Empty alt is valid for decorative images. Static HTML cannot certify WCAG or replace keyboard/screen-reader checks.                                                       |
| Explicit Header/Footer output-cache disablement     | Performance hint with personalization caveat               | [Site Checker performance](https://learn.microsoft.com/en-gb/power-pages/admin/site-checker-performance). Older tracking checks are retired/version-sensitive and should not be copied blindly.                                                                        |

Microsoft's [Site Checker](https://learn.microsoft.com/en-us/power-pages/admin/site-checker) can inspect runtime/service state that exports cannot contain. [The admin security dashboard guidance](https://learn.microsoft.com/en-us/power-pages/admin/admin-center-security) explicitly recognizes that warnings can reflect intentional business requirements. Paqvilo should preserve that distinction.

Even official examples need cross-checking: an older preview Site Checker security table recommends false or removal for the credentials header, while the [HTTP-header configuration reference](https://learn.microsoft.com/en-us/power-pages/configure/cors-support) says its only valid value is lowercase `true`, and that an unnecessary header should be omitted rather than set to false. Prefer the specific header contract; do not generate a false-valued header as a fix. The same reference distinguishes `HTTP/Content-Security-Policy-Report-Only` from enforced CSP. Configured settings are still not observed response headers.

## Paqvilo model and deferred roadmap

The owned analyzer should keep deterministic local inventory, normalized records and pure rules separate from CLI presentation. Each finding needs a stable rule ID, severity, evidence/confidence, canonical source location and record identity, explanation, remediation and reference. Redacted diagnostics must never contain source excerpts that reveal secrets. Report analyzed/skipped/unsupported inputs and limits; an empty finding list is not a full security assessment.

Implement deterministic source checks first. Keep business expectations, target routes, intended public data and accepted exceptions in the external project. Future stages can add reasoned suppressions with stale-entry reporting, project policy requirements, SARIF, access-change reviews, richer solution/permission graph checks and imported external checker evidence. Native or official-package regressions are required before labeling modeled runtime behavior parity.

Accessibility browser checks, actual response headers, identity-specific effective permissions, authorization probes, tenant inventory, scanner runs, PAC checker uploads, synchronization and deployment remain explicit separate workflows. No static-analysis result grants permission for them.

This review summarizes facts and independently proposed checks. It does not vendor external code or substantial source text. Preserve applicable license notices if a future implementation copies such material.
