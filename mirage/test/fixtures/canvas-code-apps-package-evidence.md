# Canvas and Code Apps package evidence

On 2026-11-08, the official Microsoft PAC 2.13.1 evaluator reproduced all 31 existing numeric
`Text` expressions in `power-fx-text-oracle.test.mjs` twice. Each execution used a new empty
authentication profile. Original expected strings remain unchanged. The test binds the public
expression/result fixture with SHA-256 and verifies each assertion against that fixture.

The existing 193-case language matrix now has 147 exact value cases reproduced twice by the
PAC evaluator, 13 unchanged fixed-clock cases reproduced by the official Microsoft evaluator
libraries through their supported hosting APIs, and one original GUID expression qualified as semantic error kind25.
All 193 expressions remain in the matrix. The original 45-case unproven backlog remains
fully itemized; 13 of those cases are now qualified, leaving 32 unproven checks.
Package captures exposed incorrect exponent
associativity, discarded blank `ForAll` rows, rejected overflowing time-of-day input and
overly permissive GUID formats. Those implementations and former local expectations were
corrected from the repeated results. An additional repeated positive-value corpus binds the
actual time components, blank table row, eight GUID formats and explicit en-US formatting.
Host-culture outputs and CLI compile failures do not qualify Canvas host behavior.

`power-fx-clock-official-evidence.json` binds the exact C# host, project, executed DLL,
unchanged 18-case input and two separate process captures. The host registers the actual
`IClockService`, Pacific `TimeZoneInfo` and en-US `CultureInfo` services without replacement
formula functions. Thirteen original expectations match unchanged. Two no-argument
`TimeZoneOffset` cases read the real system clock in this package, and three UTC-function
cases are unsupported by this interpreter; those five remain unproven. The original test
matrix protects the capsule, producer and original host conditions inside a parity guard.

The official `@microsoft/power-apps` 1.5.0 package also reproduced the four resolved-context
cache checks in two fresh Node processes. The SDK received an authored response through its
bridge injection seam. It reuses the resolved object and its query-parameter object, so caller
mutations remain visible on later reads. The local client previously fetched a new object on
every read; the new parity regression failed on all four checks before the cache fix. Local
configuration changes clear the cache and existing stale-response guards remain in place.

`code-apps-context-cache-parity.test.mjs` binds both the expected fixture bytes and the serialized
`captureCodeAppContextCacheContract` function. The fixture records package integrity, executed
Microsoft source hashes and two raw capture hashes. The public regression uses invented input
and loopback-only transport. Probe mutation is limited to one authored JavaScript query property,
which is restored after the check.

Private repeatable runners and raw receipts live in the developer workbench projects
`canvas-apps-parity/` and `code-apps-parity/`, under ignored `.paqvilo/evidence/2026-11-08/`.
Their offline evidence tests verify capture and probe hashes and replay current local behavior.
These package guarantees do not establish native Canvas controls, visual rendering or connector
behavior. Separate repeated native Code Apps captures qualify13 allowlisted context checks and
the four cache checks in `code-apps-native-context.test.mjs`; they do not qualify optional host
fields or general host transport. Separate repeated native Canvas recordings qualify the11-row
draft input/cancel/retention/reopen flow and the bounded form reset topology, callback, mode and
positive date/time guarantees in `canvas-form-reset-parity.test.mjs`. Native form evidence
distinguishes direct-card inputs from custom inputs inside nested containers; it does not
establish full application or pixel parity.
