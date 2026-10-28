# Current-head CI: fresh checkout and rendered panel evidence

PR #30 head `0c6d83ca3fc56f92e1b7c228a56c309e8d1b1f1a` fails hosted browser checks despite its historical full local pass. This review owns the new browser-backport fixture's missing local-state parent and the Edge dialog-activity assertion. An adjacent Issues assertion has the same controlled failure class and is repaired too. These results do not qualify that historical head or a later pushed head as green.

## Fresh-checkout workspace

The browser-backport regression creates a temporary directory below the checkout's `.paqvilo/` without first establishing that parent. Hosted Linux and Windows Chromium jobs fail with `ENOENT` at allocation. Local audit storage happened to supply the missing parent.

The original allocation and cleanup are first extracted unchanged into an unshipped test helper. A controlled test copies that actual helper and its ownership dependency into an invented fresh checkout with no `.paqvilo/`. It reproduces the exact allocation failure: **0/1 passed**. The repair captures the physical `os.tmpdir()` parent and creates its owned workspace there. The same test then passes **1/1**, checking physical identity, direct-child containment, actual file I/O, cleanup and continued absence of checkout state. It does not create a shared state parent as a workaround.

Only directory setup changes in the existing CDP case. Its three argument-only references still require zero application HTTP requests; all nine activated API/package variants and the sanitized subprocess retain real HTTP/content checks. The copied package, all three owned launch APIs, exact default-argument comparisons, caller options and proxy assertions remain. The complete thirteen-launch case passes once on Chromium and once on Edge, zero skips or cancellations, with stable owned sources.

Ignored evidence:

- `.paqvilo/audit/round6-browser-workspace-before.tap`: exact missing-parent failure.
- `.paqvilo/audit/round6-browser-workspace-after.tap`: fresh-checkout regression passes.
- `.paqvilo/audit/round6-browser-workspace-cdp-4mPKIV/`: complete Chromium/Edge results and source hashes.

## Coalesced draws and observed panel rendering

The hosted Edge dialog test records one dialog activity row in Node, then receives `Nothing happened yet` from the rendered panel. An explicit `panel.draw()` can join an already running draw whose serialized payload predates the dialog. The runtime schedules a fresh successor; completion of the earlier promise does not prove that the browser has rendered the newer evidence.

A controlled test holds an actual pre-dialog draw payload, dismisses a real browser confirm and verifies the recorded Node activity. It holds the actual successor while allowing the old draw to finish. The original immediate DOM assertion reproduces the exact hosted text mismatch: **0/1 passed**, in 1.114 s. The repaired helper waits for the existing `paqvilo-panel-render` event and the selected Activity DOM containing the expected evidence, under the unchanged 10,000 ms action bound. The successor is released only after that observer enrolls; the test also proves enrollment occurred while the UI was stale. The controlled after case passes **1/1**.

The same sweep finds one adjacent assumption: the HTTP error test waits for Node problems, then immediately reads the Issues DOM. Its controlled stale/successor variant returns `No issues on this page` despite the real recorded HTTP error: **0/1 passed**, in 1.136 s. The shared bounded render helper restores **1/1**, in 1.264 s. The original escaped-error regex and zero-image assertion both remain and run after the expected error is rendered.

All original dialog counts, types, messages, unanswered-interactive behavior, headless dismissals, prompt/alert handling, before-unload behavior, attached-browser ownership, HTTP observation and cleanup assertions remain. The acceptance runtime, panel runtime, action bounds and original timer-based absence check are unchanged. A static AST comparison retains all **38 original assertion-call forms** and adds seven; these are source counts, not executed-assertion totals.

The final complete file passes **10/10 on Chromium** and **10/10 on Edge**, with zero failures, skips or cancellations, one complete attempt per channel and stable source hashes. The earlier nine-case file results remain separate. Independent reviews accept the shared render helper, controlled protocol/enrollment gates, original assertion retention and release-before-cleanup behavior. The controlled class reproduces the hosted observation; the hosted trace does not independently record which earlier snapshot was in flight.

Ignored evidence:

- `.paqvilo/audit/round6-dev-panel-render-before.tap` and `round6-dev-panel-render-after.tap`: dialog comparison; exact probe sources are retained separately.
- `.paqvilo/audit/round6-dev-panel-issues-before.tap` and `round6-dev-panel-issues-after.tap`: adjacent Issues comparison.
- `.paqvilo/audit/round6-dev-panel-final-qoksf8/`: final complete channel results and source hashes.
- `.paqvilo/audit/round6-dev-panel-assertion-retention.json`: all original assertion forms retained.

Fresh complete validation and every required hosted CI, security and effective merge-readiness check must still execute on the eventual final pushed head. None of these focused repairs removes a lane, suppresses a finding, retries an action or increases its bound.
