# CI revalidation: PCF fixture module transport

This new review follows red checks on PR #30 head `edae77042086b555c54b133b60ccc66123daaf68`. CI run `40747390004` finishes with 24 successful jobs and two failing functional lanes; the derived CI gate also fails. This report owns the Windows Chromium Mirage first-browser-shard failure in job `123024868003`. The Windows Edge X-ray D09 failure and Security gate's CodeQL alert 339 are separately owned findings. All three CodeQL analysis configurations execute successfully; their completion does not override the open finding or failing Security gate.

## Failure evidence and limits

`model-driven-pcf.test.mjs` fails during fixture initialization for `invalid PCF output preserves the column and destroys the failing component`. At line 114, importing `http://127.0.0.1:52000/assets/controls.mjs` rejects with `TypeError: Failed to fetch dynamically imported module` after 140 ms. The original log contains no underlying browser transport code, response MIME/status or server error. It does not establish a socket-reset, cache or discarded-document cause.

The read-only review verifies that all eight actual static module dependencies are allowlisted, top-level cases are serial, each fixture uses a fresh BrowserContext, the import completes before fixture return, and teardown drains context before server. The shared native-control HTML helper is not on this failing setup path. One unchanged, instrumented local Chromium run passes all 14 existing cases; that pass does not causally resolve the hosted failure.

A controlled HTTP reset of `/assets/controls.mjs` reproduces the same initialization failure in **0/1 passed**, 169 ms. Its bounded trace additionally proves the injected condition: unfinished server responses and browser `net::ERR_EMPTY_RESPONSE`. That transport code belongs to the controlled probe, not the uninstrumented hosted failure.

## Narrow fixture isolation

The standalone fixture now preloads the exact eight real framework module files as unchanged Buffers and fulfills only their exact per-origin URLs with the original JavaScript MIME type. This removes an incidental HTTP dependency from framework initialization. The served module graph and PCF implementation remain real.

Compiled control bundles, styles and project React/platform libraries remain on the loopback HTTP server, including existing request-count, resource-cache, error and cancellation assertions. The original final exported-Solution PCF test still uses the actual model-driven shell and server. All 14 original functional cases, assertions and budgets remain.

Playwright routing disables its HTTP cache. The existing remount assertion still requires `scriptCount() === 1`, so the PCF runtime itself must reuse its resources; browser caching cannot mask a duplicate load. The independent reviewer verifies this against the pinned Playwright implementation.

The committed regression has two phases. With the legacy module transport selected and controlled resets enabled, it requires the original dynamic-import rejection and proves that the reset was reached. With the default isolated graph and the same failing HTTP transport, it mounts the real compiled PCF, reads `Initial`, requires one actual HTTP bundle request, requires zero framework-module HTTP hits, and retains the no-page-error assertion. There is no retry, sleep or deadline increase. Bounded request/response/completion/browser-failure diagnostics survive a future initialization error.

## Focused results and remaining qualification

The complete PCF file passes **15/15 on Chromium**, including the new regression. The PCF file plus native-control fixture regression pass **16/16 on Edge**, with zero skips. Targeted formatting and ESLint pass. Dead-code/clone review passes against the unchanged baseline: 394 runtime findings and 102 test clone blocks.

Ignored `.paqvilo/audit/round1-mirage/` retains the exact-head hosted log, `pcf-controlled-reset-before.tap`, `pcf-instrumented-unmodified.tap`, `pcf-isolated-chromium.tap`, `pcf-isolated-edge.tap` and the static review receipt. The historical transport cause remains explicitly unavailable. Fresh full validation and a new pushed head's complete CI/security/merge-readiness checks are required; historical job successes do not qualify the follow-up head.

## Independently owned security repair

Security gate failure is CodeQL alert [339](https://github.com/maksii/paqvilo/security/code-scanning/339), `js/file-system-race`, in the synthetic navigation evidence reader. Its new implementation opens the file descriptor first, validates exact BigInt descriptor/path identity, regular-file type, link count, physical containment and size, then reads through that descriptor with a maximum-plus-one bound. It uses no-follow/nonblocking flags where available and rechecks current identity before accepting bytes. It preserves the private/link/hardlink/foreign-path and final-PNG contracts.

The independent owner's controlled regressions first produce 4 passes / 3 failures against the old reader; a separate precision-collision regression fails 0/1 against a Number-based candidate. Those four new regressions plus four existing retention regressions pass **8/8 with zero skips**. Further independent source-parent/output-boundary review expands the complete publisher suite to **11/11**; the collector and publication findings are recorded in the [security revalidation](ci-round4-security.md). No alert dismissal, suppression or baseline change is used. Fresh hosted CodeQL analysis and the effective Security gate must still confirm the final pushed implementation.
