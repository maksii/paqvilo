# Test kinds

Every test file declares what kind of truth its assertions encode, so a reader knows whether a failing assertion
means "the code regressed" or "the expectation may be refined". `scripts/check-test-tags.mjs` enforces the tags on
every test file a change adds or modifies.

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
