# Fresh validation: Windows loopback allocation

Fresh full validation of `6433d99c` finished with **13/14 steps passed**. Mirage browser tests passed 444/445, with zero skips. The saved UserLocal portal case in `model-driven-date-control.test.mjs` timed out at its unchanged 30,000 ms wait for the `Appointment Time` combobox. The remaining full-validation steps passed; that does not qualify the failed run as green.

## Observed failure and independent review

The retained diagnostic records the actual earlier failure: `/_apps/assets/controls.mjs` fails with `net::ERR_NO_BUFFER_SPACE`. Other listed shell resources return HTTP 200, no metadata request occurs, and the document remains at `Loading application…` with no controls. Field metadata, the organization offset and the date editor have not yet executed. Increasing their waits would not resolve the failed module fetch.

Two independent reviews inspect fixture ownership and the server close path. Every model-driven simulator is registered for cleanup; owned contexts and browsers close, and simulator close drains requests before closing HTTP connections and its listener. No concrete socket-owner leak is found. The later aggregate port/memory snapshots cannot establish occupancy at the original request failure and are not used to rule out that instant's conditions.

Primary upstream evidence identifies a matching Windows allocation class: [Chromium issue 572515601](https://issuetracker.google.com/issues/572515601), [Playwright issue 43545](https://github.com/microsoft/playwright/issues/43545), and [merged Playwright repair 43605](https://github.com/microsoft/playwright/pull/43605). Chromium's Windows connection path sets `SO_RANDOMIZE_PORT` before connecting when `TcpPortRandomizationWin` is enabled. The upstream repair disables that feature in Playwright's existing feature list. The repository's pinned stable Playwright 1.64.1 lacks the repair; npm's latest stable remains 1.64.1 at this review.

## Controlled local comparison

No other task workload runs during these probes. All network traffic uses invented resources on owned loopback listeners. No OS networking setting, private file, live browser or authenticated context is changed.

| Probe                                                                               | First arm                                            | Second arm                                                                                    | Interpretation                                                                                                                            |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Real browser, fresh contexts, one server origin, six real HTTP modules per page     | 1,200/1,200 page loads; 7,200 module fetches; 99.1 s | Feature disabled: 1,200/1,200 page loads; 7,200 module fetches; 114.4 s                       | Both fixed intervals are clean. These observations do not reproduce the intermittent browser failure or measure isolated CPU performance. |
| Native Windows sockets, same owned listener and reset-on-close/nonblocking settings | 60,000/60,000 connections; zero errors; 23.780 s     | `SO_RANDOMIZE_PORT` enabled: first Winsock 10055 at attempt 14,489; 14,488 completed; 6.508 s | The socket option is the controlled difference. The randomized arm stops at its first failure.                                            |

At the native allocation failure, the immediate system snapshot contains **36 TIME_WAIT**, 127 established, 54 CLOSE_WAIT, one FIN_WAIT_2 and one SYN_SENT connection. This reproduces the Windows allocation defect at low occupancy; it is not a generic exhaustion claim.

Both browser arms use fixed 1,200-load/180-second caps and stop at a 10,000 TIME_WAIT safety ceiling or a first failure. Their complete NetLogs parse successfully and contain zero `net_error: -176` or `os_error: 10055` events. The disabled arm retains all 18 pinned Playwright default disabled features in its final merged override. Its experimental command line retains the earlier default switch too; the eventual test shim must remove that redundant original switch and verify exactly one effective merged switch.

The first native invocation completed its workload but failed to serialize an integer-key dictionary in Windows PowerShell. It provides no usable counts and is excluded. The one corrected invocation uses string keys and terminating reporting errors; it produces the native result above. No probe is repeated until a desired pass or failure appears. An initial browser command-line introspection attempt also stops before workload requests because the pinned build requires explicit `--enable-automation`; both actual browser arms include that identical inspection flag.

Ignored evidence is retained under `.paqvilo/audit/round1-mirage/`: `socket-churn-ToCod6/`, `socket-churn-xSiAZF/`, `native-socket-5d9cf6eebb994f7d80bfa15cb95b9ab3.json`, `native-probe-console.log` and the exact probe sources. The failed complete validation is preserved separately in `.paqvilo/audit/finalization-validation-3/`.

## Test-only repair and focused qualification

The controlled native comparison supports a narrowly scoped test-browser backport of the upstream repair. It does not retroactively identify the unrecorded transport cause of the earlier PCF hosted failure.

The repository browser-test commands explicitly activate `test/browser-bootstrap.mjs`. Its lazy hook patches the actual loaded Playwright Chromium singleton through the test-only `browser-backport.mjs`; it covers root, Mirage and copied-project package instances, ordinary launch, persistent launch and browser server launch. Owned test subprocesses inherit the explicit bootstrap. The actual `--version` CLI probe retains its original application file-module graph and loads no Playwright; the explicit bootstrap adds its own test module and built-ins. Production browser-launch defaults remain unchanged.

The backport verifies the pinned package version and complete 18-feature default list before activation. It replaces only the original default disabled-feature switch with that same list plus `TcpPortRandomizationWin`, retaining caller options and intentional overrides exactly as an upstream default change would. Non-Windows launches retain their existing behavior. There is no request retry, module interception, response replacement or action-bound increase.

The bootstrap owner records four passing unit/contracts and a passing actual-CDP case covering 13 real launches across package copies, persistent/browser-server variants and the sanitized shared preload. CDP checks preserve the complete original effective defaults and the unrelated command-line switches; their real HTTP fixture still runs. Independent Lense review also executes the four original filtered-child files with 18/18 passing.

After those browser checks finish, this review executes the **entire unchanged date-control file once per channel** under the explicit bootstrap. Chromium passes **9/9**, including the portal and model-driven saved-record cases, in 4.716 s; Edge passes **9/9** in 5.160 s. Both have zero skips, failures or cancellations. The observed failing operation now reaches the real HTTP shell, renders the control, checks the organization offset independently of the actual browser zone, edits/saves through the actual API, reloads and verifies the persisted time. Every original assertion and the 30,000 ms saved-control wait remain unchanged. No separate repeated attempt is used to obtain these results.

The exact logs are `.paqvilo/audit/round1-mirage/round5-date-chromium.tap` and `round5-date-edge.tap`. Fresh full validation and the final pushed-head hosted CI/security/merge-readiness checks remain required. A clean historical run cannot qualify the repaired head.
