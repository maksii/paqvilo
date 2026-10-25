# 0.9.6.1 findings review and hotfix plan

Review baseline: `main` at `b0420389`, 2026-10-25. Working branch: `codex/0.9.6.1`.
Input: the marketing project's historical toolkit-findings ledger, findings 1–42, and new finding 43
added during the final recheck on 2026-10-25. The ledger now lists open items only; the reviews below
retain the complete historical assessment.
Historical observations and proposed root causes are hypotheses until verified against this baseline.
Evidence below must use reusable code, invented fixtures and loopback tests; no live reference access is required.

## Action list

1. Recheck each historical claim, distinguish existing fixes, current defects, intended behavior and recording-only issues.
2. Audit related paths and failure modes, implement current defects with meaningful regressions, and reconcile misleading documentation.
3. Review source-debugging trailers, proxy-origin boundaries and native loading behavior without relaxing origin or identity protections.
4. Verify demo scaffolding, persona roles, reload continuity, confirmations, deployment diagnostics and source candidate provenance.
5. Verify standalone lifecycle commands, model-driven resource debugging, startup completion/cancellation and editor configuration.
6. Run focused regressions, complete `npm run validate`, package smoke and contributor/security gates; investigate every failure.
7. Prepare consistent package/release metadata (npm does not accept four-part `0.9.6.1`), commit, push, open a PR and resolve failing checks.

## Review allocation

| Findings                 | Owner                         | Deliverable                                                                     |
| ------------------------ | ----------------------------- | ------------------------------------------------------------------------------- |
| 1–6, 8, 15–26, 28–30     | Demo and documentation review | Per-finding evidence; scaffold/content/docs and continuity fixes                |
| 7, 9, 12–14, 38          | Mirage runtime review         | Per-finding evidence; source maps, origin/identity and grid/session regressions |
| 32, 40–43                | Lifecycle and startup review  | Per-finding evidence; lifecycle, readiness, cancellation and editor fixes       |
| 10–11, 27, 31, 33–37, 39 | Integration review            | Per-finding evidence; panel/inspection fixes and recording-only classification  |

The item-by-item evidence and validation are recorded in the
[demo/documentation review](hotfix-0.9.6.1-demo-review.md),
[Mirage runtime review](hotfix-0.9.6.1-runtime-review.md),
[lifecycle review](hotfix-0.9.6.1-lifecycle-review.md) and
[panel/integration review](hotfix-0.9.6.1-integration-review.md).
Previously fixed findings still require source/test evidence. A marketing workaround is not a toolkit regression test.

## Review outcome

Package version: **0.9.7**, selected by the maintainer because npm does not accept the four-part branch label.

- Current defects/gaps addressed: 7, 12, 15, 18, 28–32, 36, 38, 40–43.
- Previously fixed and rechecked: 1, 3–5, 8, 10–11, 13–14, 16–17, 19–27.
- Existing documented Windows Git setup: 2. Historical publication condition resolved: 6.
- Unsupported proxy-origin request: 9. Explicitly disabling source maps removes the original reason for that proxy;
  listener Host and identity-provider reply validation remain enforced.
- Recording environment/profile/autofill issues: 33–34, 37, 39. These do not justify toolkit account/profile changes.
- Candidate ranking observation without demonstrated incorrect attribution: 35. Shared and uncertain source matches
  remain candidates; tests cover specificity, include chains and ambiguous ownership.

Related fixes include native-grid sort direction toggling, consistent debugger metadata for JavaScript/CSS and
inline sources, explicit catalogue scope in stop hints, actual Mirage readiness in paired-panel tests, and
propagation of local simulation resource maps through every selected target.
The final ledger recheck exposed a regression in the new stop hints: POSIX single quotes do not work in CMD.
Windows hints now preserve arguments in both CMD and PowerShell, including expansion-sensitive paths;
POSIX hints retain their own quoting. Shell execution tests verify the copied command's actual arguments.
Integration regressions also cover shared YAML parse bounds, separate local/baseline snapshots, distinct
Lense/Mirage settings scopes and cleanup when a lifecycle assertion fails.

The repository issue search on this date returned no open issues. The unrelated open dependency-major PR
does not establish another runtime defect or require changing the hotfix's dependency policy.

## Completion evidence

Focused regressions are recorded in each review. Required final gates are `npm run validate` (the complete
unit/browser/SDK, quality, dependency/signature, package-smoke and site pipeline), staged contributor hooks,
and the PR's CI, security and Pages checks. The PR validation summary records their final results against its
commit; local logs and synthetic UI screenshots remain in ignored `.paqvilo/`.
No package publication, deployment, live-reference mutation or browser profile cleanup is part of this change.

The first PR run also exposed cold-cache example dependency preparation and Windows short-path test
expectations. Preparation may populate the dependency cache before offline verification; installed-package
checks still run offline. Debugger tests compare canonical file identities, including an explicit Windows
directory-alias run, without relaxing source URI or source-content assertions.
