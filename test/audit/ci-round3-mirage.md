# CI revalidation: Mirage paths, ordering and retained failure evidence

This review follows the red CI run `40734723279` on PR #30 at `85ffd9f739fa8ea5b9051d055f349f0eda7b4f81`. The earlier local validation is not reused as evidence that this head was green. All probes use invented loopback fixtures and task-owned temporary storage. No functional assertion, lane, skip policy, action budget or review baseline is removed or relaxed.

## Physical cleanup guards

The Windows Mirage unit failures and both Windows second browser shards compare canonical created directories with the logical short-name spelling returned by `os.tmpdir()`. Their product assertions can finish successfully while cleanup fails and leaves scratch directories. The same mismatch is reproduced with a real directory junction: the unchanged navigation, imported-view and capture-output files report **2 passed / 19 failed / zero skipped**. The same files after the guard fix report **21/21 passed**.

The complete explicit-guard class in this Mirage surface has 14 sites in 13 files:

| File under `mirage/`                          | Guard retained                                                |
| --------------------------------------------- | ------------------------------------------------------------- |
| `test/baseline-admin-cleanup.test.mjs`        | Strict descendant                                             |
| `test/baseline-hook-uncertainty.test.mjs`     | Strict descendant                                             |
| `test/baseline-control-redaction.test.mjs`    | Strict descendant                                             |
| `test/baseline-output-boundary.test.mjs`      | Strict descendant                                             |
| `test/baseline-output-hardlinks.test.mjs`     | Strict descendant                                             |
| `test/navigation-objects.test.mjs`            | Strict descendant                                             |
| `test/page-query-validation.test.mjs`         | Direct child                                                  |
| `test/page-error-presentation.test.mjs`       | Direct child                                                  |
| `test/webapi-view-import.test.mjs`            | Direct child                                                  |
| `test-browser/baseline-capture-exit.test.mjs` | Strict descendant                                             |
| `test/server.test.mjs`                        | Strict descendant; prefix boundary strengthened               |
| `test/webapi-policy.test.mjs`                 | Two strict descendant sites; one prefix boundary strengthened |
| `test-browser/content-policy.test.mjs`        | Strict descendant; prefix boundary strengthened               |

Each site uses `assertTemporaryDirectory` in the existing ownership helper. It resolves both parent and target physically, requires a nonempty separator-aware relative descendant, optionally requires a direct child, and returns the checked physical deletion target. It rejects the parent itself, a prefix sibling, traversal outside the parent and a child link redirected outside. Windows drive-letter case is handled by the platform's relative-path comparison. The pre-delete assertions remain active. The content-policy fixture also drains its independent browser/application closers before deletion instead of skipping application shutdown after a browser-close error.

All 13 affected files run fresh with an actual junction for `os.tmpdir()`: **127 passed, zero failed/cancelled/skipped** in 16.81 seconds. The helper's two tests pass, including a verified actual Windows 8.3 parent and changed drive-letter case. The independent example reviewer additionally exercises real guarded deletion and preservation of an outside sentinel. The final source scan finds no remaining explicit Mirage ancestry assertions comparing a physical target directly with `os.tmpdir()`.

The audit also examines nearby filesystem comparisons and deletion paths: capture destinations, native transaction recovery, CLR cache creation, local disk/state storage, persona-runtime directories, managed-identity challenge files, flow-key temporaries and runtime discovery cleanup. Capture and transaction code already distinguish physical aliases from forbidden linked descendants. The other reviewed deletion targets are owned generated paths under their configured root, rather than physical/logical temporary-parent comparisons. No additional runtime change is justified by this review.

## Child navigation ordering

The Edge first-browser-shard failure is in `acceptance-navigation.test.mjs`: the cross-origin child flow sees `GET /submit` status 200 but never observes `#done` within the existing 4-second action budget. The main target's frame tree omits the OOPIF; that observation alone does not establish causality. A direct repeat passes locally. The exact hosted timeout remains uncaused until a fresh hosted run supplies evidence; it is not explained away by a passing rerun.

A separate deterministic probe establishes a real fixture defect: making the replacement response immediate destroys the old document before its 150 ms late-write timer executes. Both existing child-retirement cases fail their exact two-retirements assertion (**0/2 passed**). A subsequent complete concurrent Edge run exposes an additional request-enrollment race: the server receives both writes, yet the page records neither before the replacement response destroys the old target. The flow itself passes, but the outer exact-two-retirements assertion fails; the full run is **38/39**, and its retained diagnostic records both server receipts with zero page write records. This is the cross-origin child case, not the replacement-read case (an early status message misread its line number). The raw failed cycle is retained and is not replaced by a passing rerun.

Every non-budget `late: true` variant now uses the same observed gate: both hash/pushState cases, both child cases and the replacement-read case. They gate the intended ordering through observed events:

1. The server observes the natural form navigation to `/submit`.
2. The old document's `/late-writes-ready` response is released.
3. The old document retains its hash change and issues both actual writes.
4. Both server write receipts, both actual Playwright request enrollments, and the helper read's browser completion are observed.
5. Only then does the replacement document response finish.

The existing same-origin and cross-origin cases retain their 4-second budget, exact two retirements, `document-replaced` reasons and empty blocked-request assertions. The replacement-read case retains its authored `/never` read and 2500 ms boundary; hash/pushState changes remain present. New event assertions prove the ordering; the helper read is completed before replacement so it cannot become a third cancellation. Other deliberate latency, redirect, reserve and slow-write budget cases remain unchanged. No runtime implementation or wait budget changes.

The same immediate-response probe passes **2/2** after gating. Following the additional enrollment fix, complete navigation and document-observer coverage runs fresh concurrently and passes **39/39 on Edge** (42.75 seconds) and **39/39 on Chromium** (36.95 seconds), without skips. These timings are validation receipts, not a qualified speed comparison. Separate observer tests retain both identity-channel arrival orders, early request labeling, delayed OOPIF baselines and actual ready-token checks before authored browser reads; button visibility is not claimed as observer readiness.

## Failure diagnostics survive cleanup

The red run's six Mirage browser artifacts are only 217-byte empty manifests. The original failure screenshot and network JSON lived under the owned temporary directory and were removed before collection. Consequently they cannot establish the historical timeout's cause.

Unexpected failures in this one invented navigation fixture now preserve its explicitly named flow-failure PNG (or the explicitly named final PNG when an outer assertion fails after a successful flow) and a diagnostic projection of at most 64 KiB before deleting scratch storage. The projection excludes headers, bodies, report/state trees, discovery data and arbitrary error text. Request URLs lose credentials, queries and fragments; external URLs become a fixed marker. Steps, requests, frame events and fixture events are bounded. Only ordinary bounded source files are read; links, hardlinks, foreign screenshot paths and linked publication directories are refused.

Publication uses fresh UUID filenames in `.paqvilo/synthetic-navigation/`. The collector accepts only that folder's UUID diagnostic JSON and failure PNG patterns, and rejects hard-linked files. It never copies the temporary directory or the complete state directory. Four committed regressions prove collection after source cleanup, exclusion of private fields/files, rejection of foreign/linked inputs and retention of a final screenshot after a post-flow assertion failure. The JSON labels the image stage as `flow-failure` or `final`. An additional actual browser probe deliberately withholds `#done`: the child fails as expected, its owned root is removed, and the collector still receives **one diagnostic JSON and one failure PNG** identifying a locator timeout. A second actual browser probe forces an outer assertion after its flow passes: it also exits 1, removes its source root, and retains both artifacts with `imageStage: final`. Expected-negative flow tests pass 2/2 without publishing any artifacts.

## Evidence and remaining qualification

Ignored `.paqvilo/audit/round1-mirage/` retains `red-alias-{before,after}.tap`, `red-all-guards-after.tap`, child immediate-response probes, the failed pre-enrollment full Edge cycle, final `post-enrollment-{msedge,chromium}.tap` results, `navigation-evidence-final.tap`, and the actual failure-retention proof. Formatting and targeted ESLint pass. The other Windows Lense fixture and example packaging failures are independently owned and recorded in their review reports. Root must still execute fresh full validation, push the final head, and require all hosted CI/security gates and effective merge readiness before completion.
