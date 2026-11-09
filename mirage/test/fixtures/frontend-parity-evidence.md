# Frontend parity evidence

Native captures collected on 2026-11-08 qualify the specific assertions below. The offline tests use an
invented schema and authored strings. Portal exports, deployment identities, raw responses, screenshots,
ownership journals and signed-in browser state remain in the private developer workbench.

| Surface                                 | Reproduced assertions                                                                     | Offline regression                                                                     |
| --------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Model-driven attributes and collections | 121 results from two independently opened native draft forms                              | `mirage/test/model-driven-native-contract.test.mjs`                                    |
| Model-driven controls and validity      | 19 results from two native forms after the selected controls render                       | `mirage/test/model-driven-native-controls.test.mjs`                                    |
| Model-driven presentation               | 50 results from two native draft forms, including layout identity, mutable labels, notifications, dirty state and setter return values | `mirage/test/model-driven-native-presentation.test.mjs` |
| Model-driven dirty state                | 82 results plus repeated Boolean-first, isolated email/quantity and saved-row read-only diagnostics at synchronous, microtask and animation-frame boundaries | `mirage/test/model-driven-native-dirty.test.mjs` |
| Model-driven saves                      | Two disposable native record flows; suppression, server refresh and retained submit modes | `mirage/test-browser/model-driven-submit-modes.test.mjs`                               |
| Restored dirty-mode submission          | Two further owned native flows; stage-20 Targets omit restored dirty, include unchanged always and exclude never; clean save produces no Update | The second test in `mirage/test-browser/model-driven-submit-modes.test.mjs` |
| Power Pages Liquid filters              | 65 literal response fragments from two independent native page loads                      | `mirage/test/power-pages-native-contract.test.mjs`                                     |
| Power Pages Liquid language             | 20 existing-test source expressions reproduced through native include templates twice     | `mirage/test/power-pages-native-language.test.mjs`                                     |
| Existing whitespace assertions          | All four original source expressions reproduced literally                                 | The individually tagged whitespace test in `mirage/test/liquid-portal-parity.test.mjs` |
| Existing loop, cycle and math assertions | All 16 original expressions reproduced in native include context with recorded observed modes; five model expectations corrected | Three individually tagged tests in `mirage/test/liquid-portal-parity.test.mjs`; original default-mode assertions remain separate diagnostics |
| Existing model-driven type assertions   | Original money, decimal and single-choice type assertions reproduce the native metadata results | The individually tagged type test in `mirage/test/model-driven-client-runtime.test.mjs`; option-by-label lookup remains a contract |
| Power Pages rendered form and client API | All 26 current source columns; 202 DOM/authored-feedback results, 189 client metadata results, 26 positive label/property relationships; each repeated | `mirage/test-browser/power-pages-native-controls.test.mjs` |

The language rows overlap the existing-test promotion; these counts are not summed as distinct platform
features. The evidence manifest alongside this document binds the captures and public fixture bytes.

## What the native results establish

Model-driven captures check attribute types/formats, imported bounds and precision, empty-string clearing,
invalid-number readbacks and validity, valid and invalid choice values, boolean option ordering, multiselect filtering/ordering,
required and submit modes, OnChange delivery/removal, execution-context identities and handler ordinals,
and collection lookups/iteration. Handler ordinals retain removed registration slots; the local recursion
guard tracks nested calls separately. The finite probes in `mirage/testing/model-driven-contract.mjs` run against
the native API, a local browser and the invented offline client fixture. Missing fields fail the probe.

The 121-case producer was reproduced again on 2026-11-09 after extracting synchronous snapshot and
restoration helpers. Two independently opened native draft forms ran the exact refreshed function and
original ordered input. Both raw result arrays are byte-identical to the unchanged public fixture. The
[producer refresh capsule](model-driven-producer-refresh-2026-11-09.json) binds the new function, source
checks and recordings separately from the unchanged historical manifest. Each run restored the touched
values, required levels and submit modes, and its complete post-state matched a fresh original-producer
control, including the native default-field dirty flags. This refresh adds no assertions or case credit.

Out-of-range numeric assignment retains the prior attribute getter snapshot while the form becomes
invalid; it does not clamp the draft into a valid range. Follow-up captures check both lower and upper
bounds, validity and getter results after the controls are visibly ready. They also prove dynamic control
options are selectable while attribute option metadata stays unchanged. Single-choice validation admits
source options and dynamically offered values; multiselect selection follows the offered options.
Control `getOptions()` includes the native empty entry. Existing browser validity, option isolation and
literal-label assertions remain intact.

Field dirty state returns to false when a value is restored, while entity/data dirty state stays latched
after a real edit. A new-form exported false-default Boolean has a pending default state activated by an
unrelated email or numeric edit; assigning false idempotently retains that state and true-to-false clears
it. Its initial value is numeric 0. The source-bound isolation found no active native business rules and
the native form script matched its export, registering only a title change handler. These observations
qualify the enumerated false-default cases; no default-true claim is inferred.

Native save runs create only owned invented records, inspect saved values independently and delete each
record with a not-found readback. Changing a `never` attribute does not submit that value, saving refreshes
it from the server, and `never`/`always` modes remain selected after a save. Local save regressions also
inspect the emitted payload so a mode getter alone cannot satisfy the test. Stage-20 backend Target
recordings confirm that an unchanged `always` column is included with another edited column, while a
second save of the clean form causes no additional Update. The recorder read uses an explicit per-run
event cursor and the exact owned record identity.

Power Pages captures independently read back every owned source component and require all literal response
markers plus HTTP 200. Two page loads must agree byte-for-byte on every captured fragment. A missing marker,
sign-in response, unavailable record or source mismatch fails qualification. Language cases retain their
include-template context: a direct top-level parse failure has a different envelope and cannot stand in for
a native include failure.

All 85 literal fragments also replay through complete local HTTP source import and rendering with source
debugging enabled. This exposed and fixed annotation of quoted script markup inside Liquid tokens: those
strings remain data while executable inline scripts retain their original-source debugger maps. This is
server-rendering integration proof; it does not establish rendered basic-form or visitor-context parity.

The separate rendered-form captures bind the current native FormXml and authored basic-form script.
The retained demo export was stale by three source columns; that attempt was rejected and preserved.
An owned private overlay replays the current source without changing the baseline export. Missing standard
reference facts for source-admitted controls now fill below explicit exported metadata. Warm-cache replay
checks that cached raw FormXml still receives that enrichment, without admitting unbound columns.

The rendered-control producer was reproduced twice on 2026-11-09 after a synchronous helper extraction.
Both native 202-result arrays match the unchanged public fixture exactly. The
[rendered-control producer refresh capsule](power-pages-controls-producer-refresh-2026-11-09.json) binds
the new function and ordered input to the current source, rendered component, authored feedback and
restoration checks. The historical manifest and the separate 189-case client and 26-property evidence
remain unchanged. Visitor identity, submission and arbitrary handler absence remain outside this scope.

Client control names positively match their rendered source labels; comparing only against a logical name
would not establish this guarantee. Memo names use their source aria-label. Native type strings are
`EmailString`, `UrlString` and `TickerSymbolString`. Type-specific read-only properties preserve native
spelling and absence, including `readOnly` for Money and `isReadonly` for Lookup. A composite address has a
read-only trigger while its source-enabled component editor remains editable; calculated-column writes
and unbound fields remain refused by the backend. Authored input feedback updates and restores from
actual control events. These captures do not claim visitor authentication, every form variant or submission.

The selected site requires explicit existing `observed` settings: `liquidHtmlVoidSerialization: html` and
`liquidPathAndQueryFragment: query`, plus `liquidRuntimeCompatibility: observed` and
`liquidFilterErrors: observed` for the language cases. These settings are part of the test input, with
evidence, rather than inferred global platform defaults. Native integer-plus-string failure now follows
the recorded parameter-count error under the selected filter-error mode.

## Evidence and replay

The private `frontend-contract-parity/` project contains the plans, publisher readbacks, two captures per
suite, local replay outputs, differences and disposable-record cleanup receipts under `.paqvilo/evidence/`.
Its README records the live commands and the selected reference context. Live writes require explicit task
authorization; the public tests never connect to an online environment. Browser tabs and runtimes started
by the runners are closed in cleanup; attached user browsers remain open.

Public fixture SHA-256 checks live inside the parity tests. Updating a fixture requires updating its protected
checksum with new evidence. Model-driven tests also bind both shared probe function sources to the exact
hashes recorded in the native plans, so a helper edit cannot silently change the exercised guarantee.
The tag checker also rejects parity deletion and stripping a legacy parity tag.

Upstream DotLiquid/Adxstudio compatibility expectations and invented portal contexts in older tests are
distinct from the recorded native include behavior. The mixed Liquid file uses `unproven` as its default
and promotes only the reproduced region. Local lifecycle, metadata admission and unsupported-API policy
remain toolkit contracts. No file-wide native claim is inferred from a matching subset.
