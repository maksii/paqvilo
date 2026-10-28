# Round 6: Inspect application identity and startup settlement

The `0c6d83ca` stability run retained two failures: regular round 5 waited 12 seconds for the live Inspect API evidence row; concurrency-16 startup coverage received a 200 ms `page.goto` timeout instead of the expected current-resource settlement failure. Neither failure is discarded or accepted as a passing outcome.

## Live Inspect waits for owned interception

The fixture previously enabled interception on an empty context and subsequently created its page. Later pages attach in the background, so a native document can finish its API request before interception repairs it with a new document. A Resource Timing observation from that first document does not establish that the locally applied document has made the same request.

A controlled real-CDP setup reproduced the exact 12-second observed-API-row failure. `Fetch.enable` was held while the native document completed its API request, then released to permit an actual local document replacement. Its current API response was held, and the real inspection sampler observed no API entry. The retained trace records different `performance.timeOrigin` values for the native API observation and the locally applied document, alongside actual frame commits and sampler output. The historical log did not record document identities, so this proves a matching failure mechanism rather than the unique cause of that historical occurrence.

The fixture now creates the owned page before awaiting `attachSession`, whose initial-page setup is awaited. Its navigation therefore starts after actual interception setup. The original 12-second API-row wait, 90-second test bound, source opening, privacy, native-control and navigation assertions remain intact. The fixture does not warm inspection, refresh until it passes, or substitute a static API reference.

- Controlled original full test: **0/1**, exact observed-request locator timeout; fixed full file under the same control: **2/2**. Traces: `.paqvilo/audit/round6-live-inspect-late-before.tap` and `round6-live-inspect-late-after.tap`.
- A tracked regression holds real `Fetch.enable` and requires the fixture's preparation promise to remain pending. The extracted original ordering fails **0/1** by publishing readiness while setup is held; the fixed ordering passes and verifies execution of the selected local script and its real API request. The failing receipt is `round6-live-inspect-readiness-before.tap`.

## The 200 ms assertion measures the held current resource

The negative startup case previously spent its 200 ms resource-settlement budget navigating a fresh document. A controlled route hold reproduced its exact incorrect `page.goto` timeout. The fixed fixture prepares the real document first, then starts the unchanged startup operation against that already-loaded response. After the operation installs its real request observers, its test-only navigation acknowledgment starts a fresh current-document fetch. Actual Playwright request enrollment and HTTP response headers prove that the server received it; its body never finishes.

The unchanged `/did not settle/` assertion still uses **200 ms**. Additional checks preserve the document's `timeOrigin` and prove the held request belongs to it. The positive first-to-second real navigation and current essential-data checks retain their **3,000 ms** bound. Production startup code was not changed.

- Same controlled navigation hold: original **0/1**, fixed **1/1**; `.paqvilo/audit/round6-startup-before.tap` and `round6-startup-after.tap`.
- Both complete affected files pass at package concurrency 2 on Chromium **6/6** and Edge **6/6**, with zero skips or cancellations: `round6-inspect-startup-chromium-final.tap` and `round6-inspect-startup-edge-final.tap`.
- Independent review accepted both the startup resource boundary and final Inspect attachment barrier, including their controlled regressions, cleanup ownership, and retention of the original functional assertions. Formatting and targeted lint pass.

## Shared server ownership after the required code review

The required code review exposed duplicated server shutdown/listen mechanics. They now live in `test-browser/helpers/owned-server.mjs`, reused by both Inspect cases and the page-route identity and panel-reload fixtures. The helper registers separate connection-close and listener-close callbacks before listening on `127.0.0.1:0`, and waits for the actual `listening` event. Each caller retains its panel, interception and browser cleanup before the server callbacks; directory removal follows resource draining. Request handlers, launch options, assertions and functional deadlines were retained.

The two failed review receipts remain at `.paqvilo/audit/round6-review-code.log` and `round6-review-code-after-helper.log`. Fresh review passes with 97 test clone blocks and no baseline or suppression changes: `round6-review-code-owned-server.log`. Both independent source reviewers accepted the final extraction.

After the extraction, all three complete affected files pass **4/4 on Chromium** and **4/4 on Edge** at package concurrency 2, with zero skips or cancellations: `round6-owned-server-chromium.tap` and `round6-owned-server-edge.tap`. These are the final shared-helper receipts; the earlier six-case receipts above separately retain the startup-file qualification.

These are local receipts; final-head full validation, stability runs and hosted gates remain separate qualification steps.
