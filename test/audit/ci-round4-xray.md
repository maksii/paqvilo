# Round 4: bounded large-DOM X-ray fixture setup

The Windows Edge Lense job `123024867951` in CI run `40747390004`, on `edae77042086b555c54b133b60ccc66123daaf68`, failed D09 while `locator('#component').evaluate` waited 2,500 ms. The preceding `#padding` mutation completed; `#component` is its static fixture sibling. The original log has no renderer trace establishing why that lookup exceeded its deadline.

## Controlled dependency proof

The pinned Playwright default CSS engine collects matches and then visits descendant shadow roots. After 9,000 padding nodes are inserted, the fixture's known light-DOM host lookup unnecessarily depends on that traversal. A CDP function-call gate in Playwright's utility world pauses only a padding node's `shadowRoot` traversal. X-ray's application-world code, observers, real DOM and real shadow discovery remain unchanged.

The controlled Edge probe reproduces the exact setup failure while `#component` remains present and all 9,000 nodes remain installed:

| Setup selector         | Controlled result                                                                                                                                  |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default `#component`   | The traversal gate is entered; `locator.evaluate` fails at its unchanged 2,500 ms bound. The completed query visits 9,000 unrelated padding nodes. |
| `css:light=#component` | Zero padding shadow visits, no debugger pause, and successful late shadow attachment under the same bound.                                         |

With the gate added to the real D09 case and the old selector retained, the complete Edge audit records 52 passes and two failures: D09 and its parent aggregate. D09 has the same locator timeout as CI. The known light-DOM host now uses the scoped selector. The normal fixed case never enters an artificial pause; the gate is disabled and its utility-world descriptor restored before the original shadow-piercing pick begins.

This proves a fixture dependency on unrelated shadow traversal. It does not prove that the historical hosted failure involved a debugger pause, identify its scheduler/transport cause, or establish that X-ray's product scan blocked the renderer for 2,500 ms. No runtime scan implementation is changed.

## Ordering and scope retained

D09 keeps separate mutation turns: insert all 9,000 nodes, observe the queued X-ray paints, then attach the late open shadow root. Its original shadow-piercing field pick, `audit_a.audit_first` source identity and four-axis outline geometry checks remain.

D10 preserves startup overlap explicitly. It holds the actual initial application-world animation callbacks before X-ray initialization, performs the padding and shadow edits in separate turns while those paints are still held, releases the real queued callbacks, then executes the same selection/source/geometry assertions. This avoids silently replacing startup mutation coverage with an already-painted-only fixture.

The shared fixture sweep retains ordinary mutation cases and intentional shadow-piercing element selection. D09 is the only original case that creates the 9,000-node padding before its known host lookup. No global readiness delay is inserted. The per-context 2,500 ms bound, 9,000 nodes, case concurrency 4, parent 180,000 ms hang guard and package browser-runner budgets remain. All 61 original literal assertion sites are retained; the candidate has 68, with additional traversal/startup checks. The helper extraction reuses the same original source and geometry assertions in both late and startup cases.

## Fixed-round verification

| Complete file run                    |    Pass | Fail / cancel / skip |
| ------------------------------------ | ------: | -------------------: |
| Five consecutive Windows Edge rounds | 275/275 |            0 / 0 / 0 |
| Pinned Chromium round                |   55/55 |            0 / 0 / 0 |

These are fixed rounds with no retry. The X-ray test SHA-256 remains `75ed0128c206eedb49c7dc4c3ed5d547df6269224ac493b65f2d2cf6ae42952f` before and after each round. Other authorized security/fixture changes were still in progress, so these focused results do not qualify the later complete source tree or replace fresh full validation and final pushed-head CI.

Across the five Edge rounds, D09's observed padding-mutation-to-two-paints interval is 47.9–56.0 ms and the bounded light-host setup is 4.1–20.2 ms. D10's post-release two-paint observation is 7.8–15.9 ms. Chromium records 33.2 ms, 8.4 ms and 31.2 ms respectively. These observations include frame/protocol scheduling and are not isolated scan CPU measurements or a performance A/B claim. Original bounded selection and geometry operations still execute after them.

The Mirage reviewer independently checked the final diff, unchanged bounds and piercing assertions, D10's held startup ordering, source hash and all six complete results, and found no further concrete defect. Formatting, ESLint and diff checks pass without baseline or suppression edits.

## Performance qualification boundary

A read-only comparison against the earlier measured staged tree `45bb9936aaeeeaf3cefe266f1e309ecd647ad886` finds unchanged executable probe/library sources and unchanged actual native-date fixture code/HTML. That alone does **not** qualify the new whole tree: `mirage/server.mjs` also starts an implementation fingerprint over the Mirage directory and `createSimulator` awaits it. The fingerprint excludes Git, dependency/state directories and SDK build products, but includes ordinary Mirage test files as input bytes.

Three later changed files therefore enter the runtime-start and actual date-fixture startup workloads even though they are not imported as executable probe modules:

| Fingerprinted file                              | Earlier bytes | Reviewed candidate bytes |
| ----------------------------------------------- | ------------: | -----------------------: |
| `mirage/test-browser/model-driven-pcf.test.mjs` |        30,851 |                   33,615 |
| `mirage/test/navigation-evidence-fixture.mjs`   |         6,862 |                    7,550 |
| `mirage/test/navigation-evidence.test.mjs`      |         7,059 |                   12,571 |
| Total                                           |        44,772 |                   53,736 |

This intermediate graph-review snapshot precedes the subsequent publisher parent/output fixes. Its increase is 8,964 bytes; both compared representations use LF. No timing effect is inferred from that byte count. The original measurements retain their original tree identity. A fresh paired batch on the final frozen source, after all test jobs stop, is required before claiming final-tree performance results. Changes to collector/release tests, the X-ray audit and audit documents do not enter these measured execution paths or the Mirage implementation fingerprint.

Evidence remains under ignored `.paqvilo/audit/`: `d09-selector-order-OIixsP/results.json`, `round4-d09-edge-before.tap`, and `d09-final-fixed-6LRDs9/` with qualification, each TAP/result file and `complete.json`. The earlier complete candidate result is retained separately as `round4-d09-edge-after-1.tap`; it is not substituted for the final fixed-round set.
