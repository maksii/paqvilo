# Test kinds

Every test file declares what kind of truth its assertions encode, so a reader knows whether a failing assertion
means "the code regressed" or "the expectation may be refined". `scripts/check-test-tags.mjs` enforces the tags on
every test file a change adds or modifies. Test files that predate the rule are listed in
`scripts/test-kinds-legacy.json`: the checker skips a listed file while it has no `@test-kind` line at all and checks it
in full once one is added, so tag the whole file when you start. New files are never added to the list.

## Tag syntax

A file-level tag in the first 40 lines applies to every test in the file:

```js
// @test-kind parity: native dev-environment plug-in contexts, recorded and replayed 2026-10-30 (Create stage 20 Target system columns)
```

A tag on the line(s) directly above a `test(`, `it(`, `describe(`, `suite(` or loop that declares tests overrides
the file kind for that test until the next tagged or top-level test:

```js
// @test-kind unproven: local model of service-protection backoff; no native capture yet
test('backoff waits for the retry-after window', ...);
```

Several kinds may be combined with `+` when an assertion set genuinely spans them (`parity+security`). Every tag
needs a reason after the colon; `parity` and `observation` need the evidence source (where and how it was
observed, never secrets, tokens, private record ids or business data).

Node `t.test(...)` subtests, including `await t.test(...)`, also accept a tag immediately above the call.
Their nested proof region ends with the subtest body; the surrounding fixture setup and diagnostic policy
keep their own kind.

## Kinds

| Kind            | The assertions encode                                                                                                                                                                                                                                                  | Required evidence             | Who may change an assertion                                                                                                                                                                                                                                                                                                     |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parity`        | Behaviour reproduced exactly from the real platform: recorded native environment runs that were reproduced (two captures or a deterministic replay), or the observed behaviour of an official Microsoft package (for example executing the Microsoft.Xrm.Sdk assembly) | Evidence source in the tag    | Only with an explicit user request naming the exact change, or new proof of ultra-high guarantee: a fresh native recording/replay or official Microsoft package behaviour. Documentation, memory, forum posts, another tool or a plausible assumption are not proof. Add `// @parity-evidence: <new proof>` next to the change. |
| `observation`   | A single native or live observation not yet reproduced (one capture, possibly environment-specific)                                                                                                                                                                    | Capture source in the tag     | With a newer capture that contradicts it (cite it); promote to `parity` once reproduced.                                                                                                                                                                                                                                        |
| `compatibility` | A published external contract other tools rely on: Microsoft Learn documentation, OData/HTTP/JSON standards, documented SDK wire formats                                                                                                                               | Contract reference in the tag | When the cited contract changes or native evidence proves the documentation wrong (then it becomes `parity`).                                                                                                                                                                                                                   |
| `unproven`      | A local model or best-effort simulation without native or documentary proof                                                                                                                                                                                            | What is assumed               | Freely, when evidence arrives; never cite it as parity.                                                                                                                                                                                                                                                                         |
| `contract`      | Paqvilo's own designed behaviour: CLI, configuration, admin/agent APIs, diagnostics, project boundary                                                                                                                                                                  | The design decision           | By deliberate product changes, with docs updated.                                                                                                                                                                                                                                                                               |
| `security`      | A safety or security guarantee: secrets never logged or stored, loopback-only delivery, path confinement, trust boundaries, privilege checks                                                                                                                           | The guarantee                 | Never weakened without explicit user approval.                                                                                                                                                                                                                                                                                  |
| `tooling`       | Repository tooling: CI scripts, hooks, release, harnesses, generators                                                                                                                                                                                                  | —                             | With the tool.                                                                                                                                                                                                                                                                                                                  |

## Rules

- A failing `parity` or `security` assertion means the code is wrong. Fix the code; do not edit the assertion.
- Do not move an assertion out of a `parity` region, retag a `parity` test to a weaker kind, or loosen it (fewer
  checked fields, broader matchers, skipped cases) without the proof required above.
- New behaviour backed by a fresh native recording is `parity` only after it was reproduced; until then it is
  `observation`.
- When a test mixes kinds, split it or tag each test; do not tag a whole file `parity` because one test is.
- The checker rejects a change that removes or rewrites lines inside a `parity` region unless the same change
  adds a `// @parity-evidence:` line in that file stating the proof (or the user's explicit request).
  This includes deleted files and legacy-listed files whose tags were stripped. Retain the file with the
  evidence explanation when retiring a parity test; deletion cannot carry an evidence line in that file.
- For parity expectations stored in fixture files, bind their bytes with a SHA-256 assertion inside the
  parity region. This keeps an expectation-file edit from bypassing the protected test diff. Native evidence
  and the derived public fixtures have separate hashes; formatting a fixture does not change a native capture.
- [Frontend parity evidence](../mirage/test/fixtures/frontend-parity-evidence.md) records the reproduced Power Pages and model-driven
  probes. A filename containing `parity`, an invented browser fixture or an upstream compatibility model
  does not establish native parity.
- The [platform evidence map](../mirage/test/fixtures/platform-parity-evidence.md) separates frontend, Canvas,
  Code Apps, portal/Dataverse HTTP and plugin guarantees. Capture counts are not tagged-test counts.

### Partially qualified assertion regions

Qualifier writes use exclusive creation for pending findings and publish each
source file atomically. A batch of several files is not one filesystem
transaction. If a later write fails, the error reports `publishedPaths` for
files already published; inspect those files before retrying. The qualifier
does not restore or remove them by pathname, which could overwrite another
writer's replacement. Preflight failures still publish no source changes.

`scripts/qualify-parity.mjs` can bind a reviewed subset of an existing test without promoting the parent.
In a normal version 1 manifest, replace a test's `assertions` with ordered `regions`, each containing an
`assertions` array of `{ sha256, factIds }`. Each region must uniquely identify contiguous direct sibling
assertion expression statements in source order. The existing complete `caseUniverse`, source bindings,
independent proof receipts, facts and semantic review remain mandatory. Partial cases and whole and partial
targets in the same file are rejected. Existing parent kinds and unselected assertions remain unchanged;
partial regions add no test definitions or whole-definition/case credit. The author must review equivalence
of each fact and context; successful tooling is not evidence of platform parity.

The generated lexical block calls a synchronous proof guard immediately before the unchanged statements.
It introduces no callback or extra promise continuation, so existing `await` expressions remain in their
original async test. Original nested callback arguments are retained when they contain no nested assertions,
test registrations or skip controls; generator callbacks, direct eval and yield are rejected. Assertions
inside an inner branch or loop whose case universe is not bound by this format also fail closed. A concise
arrow callback with a direct assertion is transformed to a block with an explicit return of the original
expression, preserving its result and sync or async behavior. A module-level
source guard verifies the exact region set, original body, proof and generator bindings even if a test
registration loop produces no cases. The test-kind checker protects the generated block, its import and
source guard as parity lines; the parent and unmatched lines keep their existing kind. Edits to protected
lines require the same new-evidence rule as any parity assertion. Exact source and capsule pins make stale
manifests fail closed. The format does not authorize changing a baseline assertion or resolving ambiguous
source bindings by assumption.

Each manifest file supplies `importRoles` for every original non-`node:` static import or re-export:
`{ source, role, reviewedBy, reason }`. The role is either `implementation-under-test` or `test-input`;
the reviewer explains the role. Test-input modules must be local, statically imported, and unchanged from
the baseline; their recursive local import closure is hashed in the generated guard. Dynamic imports,
`require`, and `eval` are not supported in the test module or an input closure. This automated check cannot
infer every filesystem, network, environment, or other runtime input: reviewers must establish and preserve
those separately. Built-in imports and the runtime version are part of the reviewed execution context.

A generated registration matrix additionally needs exact `caseUniverse.caseBindings` in execution order
and `caseFacts` entries `{ caseIndex, assertionIndex, factIds }` for every case/assertion pair. Currently
only literal arrays or unshared top-level `const` literal arrays in simple `for...of` loops and statically
resolvable titles are accepted. The declared case names, values, and evidence links must all match; unknown
or potentially mutated generators fail closed. The entire original module AST is checked at preflight and by
the generated runtime guard, excluding recognized generated qualification scaffolding. This can reject an
unrelated semantic change in the same module until its impact is reviewed and requalified.

Whole-test qualification can also describe a direct assertion loop over an inline literal array with
`assertionLoops`: bind the loop AST, its exact `caseBindings` and hash, and a `caseFacts` entry for each
outer case, loop case, and assertion. Only unconditional direct assertions in the loop body are supported;
partial regions inside such loops and dynamic or early-exit loops remain pending.

For a partially proven registration matrix, a single partial region may instead use
`caseSelection: { selected: [{ caseIndex, factIds }] }` with zero-based, strictly increasing indices.
The manifest still supplies the complete original ordered `caseUniverse.caseBindings`; each selected case
needs its own evidence facts. The current supported form is one synchronous concise callback containing one
direct assertion, in one simple `for...of` over a top-level literal array. Its generated synchronous guard
checks its exact source marker, proof and complete ordered bindings; every case runs the original assertion.
Only selected cases appear in `qualifiedOriginalCases`, while the parent stays unproven and receives no
whole-definition credit. Selected and unmatched array entries must occupy distinct source lines for the
line-based checker. A cumulative manifest may add cases and proofs only while retaining every prior selected
index, exact fact mapping, proof object, source binding, and complete universe. An identical rerun makes no
change; `newQualifiedOriginalCases` counts only added cases. Reviewed literal matrix corrections described
below bind both baseline and current case values. Async callbacks, assertion-type changes, and nested regions
are currently unsupported and fail closed.

The SDK SOAP value-loop migration is a separate bounded form. Its source certificate
binds the complete 27-value typed universe, the selected 21 values, both assertion
sites and two literal tail inputs. A synchronous check runs on every iteration,
including held values, and a completion check verifies the full loop ran. The original
assertions and their order remain in place. The source guard pins the complete
instrumented module, helper and repeated SDK evidence; the checker protects the
selected inputs and shared assertion sites while retaining the file's existing
compatibility kind elsewhere. The 44 mapped assertion instances are partial
coverage and confer no whole-test credit.

The bounded query-reader matrix supports selected proven cases in an unchanged
63-case async subtest loop. Its literal spread/map inputs are evaluated from
source, and each awaited child checks its original binding and ordered index.
A synchronous completion check requires all 63 children to run. The existing
request and three assertions stay in place; only selected cases receive case
credit, while the remaining cases and parent stay unproven. A cumulative
manifest may add cases and evidence only while preserving every previous
case-to-fact mapping and prior proof object in order.

For an input-relative query-message bridge, the private manifest supplies a
`queryBridgeWitness` with an authority-index path and SHA-256, and qualification
requires an explicit `--evidence-root`. The preflight independently checks both
original and adapted SDK processes, their official archive and executed DLL
bytes, the frozen source/coordinate mapping, typed CSDL roles, and both raw
native responses. A reproduced-native wrapper alone cannot establish SDK
authority. The generated public guard carries only the authority hash and
portable proof bindings; private witness paths remain outside the source file.

The SDK metadata test has a separately analyzed later TypeScript tooling test.
Its process-launch and URL imports are allowed only when their lexical references
stay inside that later direct test registration. The selected callback and all
registration bodies and ordering remain source-bound. The tooling test keeps
its existing kind and gains no SDK parity credit.

For npm official-package evidence, `package` has `ecosystem: "npm"`, a scoped `@microsoft/` name, an exact
version, canonical registry tarball URL, tarball SHA-256, canonical SHA-512 integrity, and a nonempty,
unique `executedSourceClosure` of package-relative paths and SHA-256 hashes. The entire object must match
`packagePointer` in the capsule. Independent run receipts must have distinct capture roots, and each fact
must be replicated directly under each corresponding root. Package provenance and hashes support review;
they do not themselves establish that a particular test assertion matches the executed behavior.

The initial runtime-input support is intentionally narrow. `runtimeInputs` entries identify the original
`baselineId`, a `kind`, `role: "source-derived"`, the producer RHS `producerAstSha256`, reviewer, and reason.
The supported network producer is a direct assignment in the selected callback after a restricted setup and
optional recognized `t.after` restoration; conditional, unrecognized, or later replacement is rejected.
Unsupported clock, environment, randomness, network modules, dynamic reads, and dynamic fixture paths remain
pending except for the source-certified loopback routing and exact API router snapshots described below.
Literal repository fixture reads using `readFile` or `readFileSync` with `new URL(..., import.meta.url)`
are automatically baseline and runtime hash-bound. This is a conservative static check, not a general
JavaScript taint analyzer; the reviewer is responsible for the recorded execution context and guarantee.

A narrowly recognized temporary-fixture family can isolate filesystem reads in a separate test when its
dependency slice proves that the selected test cannot share the other test's root or effects. This does not
establish the safety or contents of the other test's reads. Unless the separately reviewed source-only slice
below applies, the original and current complete registration sets must match. Ordered current call and
callback ASTs are additionally bound at runtime; changing any of them invalidates the isolation proof.
The helper's allocator and literal fixture inputs remain pinned.
For the separately inferred source-only renderer slice, exact reviewed unselected callback changes, added
test bodies, and isolated function or `node:crypto` declarations may be recorded in `moduleReview`; they
receive no credit for the selected original. Both baseline and current slices must independently prove
isolation, and the entire current registration set and module remain runtime-bound. A literal dynamic
import in a later top-level test needs a `lateImports` entry with its baseline registration ID, import AST
hash, source, reviewer, reason, and `role: "post-selected-isolated"`. Both registration orders must place it
after every selected test under the inferred sequential, no-hook context. This describes execution order;
it does not assert that the imported module or its evaluation is pure.

The loopback routing slice accepts only independently verified original and current suite hooks, literal
state and paths, and requests derived from the owned listener. It binds the complete current module and all
registrations, including hooks and unrelated callbacks. A separately reviewed API router snapshot permits
only its exact baseline and current programs; any source change requires a new review. Neither slice proves
arbitrary network inputs or substitutes for the assertion's native evidence. A certified literal request
loop also binds its complete ordered case values and each assertion's per-case facts.

The bounded records fixture migration checks its source-derived literal inputs synchronously immediately
before setup, including own keys, data descriptors and plain object/array prototypes. Its existing assertions
and proof objects remain bound, and the complete current module and registrations are protected. The exact
reviewed records-parent corrections require a caller-supplied private review receipt; generated guards keep
only its hash. This migration does not establish arbitrary SUT isolation or add credit for reviewed parents.

Existing partial blocks can be extended by a cumulative manifest that includes every prior definition,
region, assertion-to-fact map, and unchanged descriptor binding. The tool rechecks the prior runtime guards
and proof before regenerating, and refuses an omitted region or altered prior proof. A repeated identical
manifest makes no change. Runtime guards also require the cumulative module descriptors to match every
inline region descriptor, including when the original test is filtered out.

When an unrelated original assertion's expected value was explicitly corrected, `moduleReview.corrections`
can map unique `oldAstSha256` and `currentAstSha256` assertion calls, with `sameGuarantee: true`,
`guaranteeId`, `factIds`, `reviewedBy`, and `reason`. The initial supported form changes only a literal
expected argument in a two-argument assertion; the assertion function and actual-value expression must be
identical. Facts must belong to a separately validated guarantee. `moduleReview` itself carries a reviewer
and reason. It may list added top-level tests using their title and body AST hashes, reviewer and reason,
`zeroOriginalCredit: true`, and `interactionReviewed: true`. Unreviewed module differences, new setup,
extra imports, corrections to the selected assertion statements, dynamic expected values, and added tests with ambient
runtime inputs are still rejected. The entire reviewed current module remains bound by the runtime guard.
The one supported nonliteral correction is the exact owner-scoped `RandBetween(3,2)` error-kind correction
from `ErrorKind.InvalidArgument` to `ErrorKind.Numeric`, backed by repeated official results. Its generated
module-entry check binds the actual imported `ErrorKind.Numeric` value to 24. An optional `baselineId` scopes
an assertion hash to its original test when the same assertion occurs in more than one test.
For a reviewed typed-null correction, the prior expected expression may also be an immutable lexical
binding or unshadowed `undefined`; the assertion operation, input and optional message remain exact, and
the repeated fact must explicitly contain a typed null. A private reviewed candidate can be supplied with
`--reviewed-candidate-file`; existing guards are validated against the unchanged public file before the
candidate is checked and atomically written. Prior protected regions and proof objects remain required.

For a corrected literal registration matrix, `moduleReview.fixtureCorrections` identifies the array
binding and entry index, exact old and current tuple AST hashes, `sameGuarantee`, `guaranteeId`, `factIds`,
reviewer, and reason. The tuple's input must remain identical and only its literal expected value may
change. The manifest supplies both the original `caseBindings` and exact `currentCaseBindings` with its
hash; every original case still needs its own fact mapping. Security corrections remain prohibited, and
existing parity requires a fresh adjacent evidence comment naming the guarantee.

A preexisting baseline hash assertion remains part of the original body and module binding; it cannot be
removed under partial qualification. Added synchronous file-hash guards and their Node imports are treated
as scaffolding only when their exact recognized shape is verified and every use of those imports occurs
inside such a guard. An added awaited hash guard is not transparent because it introduces a scheduling
boundary. Legacy descriptors lacking the original-guard list fail at runtime until requalified; partial
migration is supported only when the exact baseline proves that list was empty and all prior bindings survive.

Module correction review alone never authorizes changing an existing security assertion. The default is to
reject a security correction, including security inherited from the file or any ancestor. An exact direct
human approval may be supplied separately by the trusted caller through `--security-approval-file` and
`--security-approval-sha256`; manifest fields cannot supply approval. The private receipt must bind exact
baseline and current source, test and assertion hashes, the unchanged operation and input, and the two
unchanged neighboring security assertions. The changed guarantee also needs repeated official-package facts.
Generated descriptors retain only the receipt digest and exact scope, not the private receipt or path.
Added-test comparison exclusion is currently limited to plain literal-title, zero-parameter,
synchronous tests containing only recognized assertions over literal values, so review alone cannot hide
registration-time or callback mutations of original inputs.

A reviewed Microsoft CDN distribution may use `ecosystem: "microsoft-cdn"` when its versioned first-party
manifest and executed immutable assets pass `parity-official-artifacts.mjs`. Qualification requires an
explicit `--evidence-root` and a `privateEvidence` specification whose bundle, publisher/run/source-capture
witnesses, complete script inventory, context bytes, and statically resolved JavaScript producer closure
are confined to that root. Each source capture binds its run's invocation ID, producer hash, complete
input, input hash, and result excluding the capture's own hash; private facts under each run's `result.behaviorFacts` must match the public derived
facts. Public capsules use `/package`, `/captures/{0,1}/receiptSha256`, and per-fact
`/captures/{0,1}/behaviorFacts/<id>` paths; unknown package and fact fields are rejected. Unsupported dynamic or bare producer imports fail closed. The tool atomically emits a hash-only
public receipt at `portableReceiptPath`; generated runtime guards use only that receipt and the public
capsule, without private paths, scripts, context, or raw records. A receipt alone cannot qualify a new test.
Those structural checks do not authenticate a fabricated capture: the reviewer must verify the genuine
publisher reads and source-bound execution, and must not infer equivalence to an unobserved deployed bundle
or treat host readiness as original-test parity.
