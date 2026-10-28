# Current-head CI: no-content navigation fixture ordering

PR #30 head `0c6d83ca3fc56f92e1b7c228a56c309e8d1b1f1a` finishes CI run `40767207900` with 22 successful jobs, four failing functional jobs and the derived failing CI gate. This report owns the Windows Edge Mirage first-browser-shard failure in job `123094656549`. The missing fresh-checkout parent in the new browser-launch regression, the panel activity-render race and the SDK dependency audit are separately owned findings.

## Exact failure and evidence limits

The original negative case `a hash change cannot retire a hanging read (204 navigation)` expects `Portal requests did not settle` naming `GET /never`. Instead its assertion receives `locator.click: Timeout 2500ms exceeded`. Playwright's call log establishes that `#save` is visible, enabled and stable, the real click completes, and it then waits for scheduled navigation. The shard finishes 213/214 passed, with zero skips. No original assertion is relaxed to accept the wrong failure phase.

The job's narrow synthetic collector artifact retains the original Save form, `GET /never`, the actual `GET /submit` HTTP 204 response, and zero navigation cancellations. Its pending-request snapshot records `/submit` elapsed 1,388 ms, while the later resource record completes at 1,515 ms. That eventual completion does **not** prove the response had finished before the click timeout. The initial interpretation of an already-completed response leaving a leaked navigation barrier is therefore withdrawn. The hosted evidence does not establish a Playwright barrier defect.

The fixture previously guessed history ordering with a 50 ms browser timer and document response timing with a 1,500 ms server timer inside a 2,500 ms click action. Browser actionability and dispatch also consume that action budget. The negative case needs an outstanding read, a real no-content navigation and a same-document history change; those arbitrary timer delays are not its subject.

## Controlled proof and repair

A separate owned-loopback Edge probe first orders actual `/submit` receipt, history release, an observed same-document protocol event and the HTTP 204 response. With the unchanged acceptance runtime, click succeeds and settle reports precisely the hanging `GET /never`. This demonstrates the intended path without changing `noWaitAfter`, actionability, navigation observation or the timeout.

The new committed regression makes both old fixture clocks unavailable. Its invented browser page does not run authored timer callbacks; protocol, promises and the native action deadline continue. Its document scheduler queues the legacy response callback until the actual native `Locator.click` resolves or rejects, allowing bounded error capture and cleanup. The real click and its original options remain untouched.

Against the timer-dependent fixture this reproduces the hosted **2,500 ms click timeout while waiting for scheduled navigation: 0/1 passed**, in 4.249 s. Against the repaired fixture it passes **1/1** and explicitly requires successful navigate/click, failure at settle, one actual HTTP 204 navigation, only `GET /never` pending, zero retired requests, and observed request/history/helper ordering. It does not retry an action or increase a deadline.

Both original `noCommit` variants now use the same observable protocol gates. The hanging read must reach the server and Playwright's request observation. In the 204 variant, actual `/submit` receipt is also required before releasing the history helper. The document response waits for the actual same-document history event and completed helper read. The no-navigation variant still prevents submission and retains its pending read. Other deliberately delayed response, redirect, write-budget and commit-reserve cases keep their existing behavior and bounds.

The acceptance runtime is unchanged. The evidence publisher changes only its fixed invented-event allowlist so failures retain the new gate legs; descriptor, read/write, privacy and size guards remain intact. AST comparison retains all **75 original assertion calls** and adds ten, for 85 current calls.

## Transparent controls and qualification

The first diagnostic harness held the response forever and reached the existing 60-second hang guard during pending-navigation capture/cleanup; its zero-pass, one-cancelled result is retained. The corrected response-only control then passed 1/1 before the repair because the local hash event released click waiting. That negative evidence is retained too. The final combined clock control supplies the failure reproduction above; these harness/control observations are not substituted for successful final validation.

Ignored `.paqvilo/audit/round1-mirage/` retains the exact hosted log and allowlisted JSON/PNG artifact, `no-content-handoff-zH2iX9/result.json`, `round6-no-content-before.tap`, `round6-no-content-before-corrected.tap`, `round6-no-content-before-both-timers.tap`, `round6-no-content-after.tap` and the assertion-retention receipt.

The complete repaired navigation file passes **35/35 on Chromium** in 36.658 s and **35/35 on Edge** in 41.780 s, with zero skips, failures or cancellations and one complete attempt per channel. Logs are `round6-acceptance-chromium.tap` and `round6-acceptance-edge.tap`. Independent Lense peer review passes: actual native navigation/read/history semantics, clock-control cleanup, original bounds/assertions and the narrow evidence projection remain intact. This source is frozen with no active browser or test process. Fresh full validation and every required hosted CI/security/merge-readiness check on the eventual pushed head remain necessary; this red head is not green.
