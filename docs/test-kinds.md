# Test kinds

Every test file declares what kind of truth its assertions encode, so a reader knows whether a failing assertion
means "the code regressed" or "the expectation may be refined". `scripts/check-test-tags.mjs` enforces the tags on
every test file a change adds or modifies. Test files that predate the rule are listed in
`scripts/test-kinds-legacy.json`: the checker skips a listed file while it has no `@test-kind` line at all and checks it
in full once one is added, so tag the whole file when you start. New files are never added to the list.

## Tag syntax

A file-level tag in the first 40 lines applies to every test in the file. The replay runner is tagged this way:

```js
// @test-kind parity: replays recorded oracle cases from mirage/test/parity/cases; every expected value is read from a case file built from two or more captures
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

| Kind            | The assertions encode                                                                                                                                                                                                       | Required evidence                | Who may change an assertion                                                                                                                                                                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parity`        | Behaviour replayed from recorded oracle cases. Every expected value comes from a case file that `scripts/parity-cases.mjs build` produced from two or more captures; nobody types the expected value or the per-case input. | The case file (oracle, captures) | A recorded case changes only with new captures and a `history` entry. A new known gap for a recorded case needs a retirement entry. Anything else changes only with an explicit user request naming the exact change, or new proof of the same guarantee recorded as a replay case. Documentation, memory, another tool, a forum post or an assumption is not proof. |
| `observation`   | Native or official-package evidence that is not expressed as a replay case: a single capture, or facts linked to the assertion by hand (the test types its own inputs or setup).                                            | Capture source in the tag        | With a newer capture that contradicts it (cite it). Promote by recording replay cases from two or more captures.                                                                                                                                                                                                                                                     |
| `compatibility` | A published external contract other tools rely on: Microsoft Learn documentation, OData/HTTP/JSON standards, documented SDK wire formats                                                                                    | Contract reference in the tag    | When the cited contract changes or native evidence proves the documentation wrong (then it becomes `parity`).                                                                                                                                                                                                                                                        |
| `unproven`      | A local model or best-effort simulation without native or documentary proof                                                                                                                                                 | What is assumed                  | Freely, when evidence arrives; never cite it as parity.                                                                                                                                                                                                                                                                                                              |
| `contract`      | Paqvilo's own designed behaviour: CLI, configuration, admin/agent APIs, diagnostics, project boundary                                                                                                                       | The design decision              | By deliberate product changes, with docs updated.                                                                                                                                                                                                                                                                                                                    |
| `security`      | A safety or security guarantee: secrets never logged or stored, loopback-only delivery, path confinement, trust boundaries, privilege checks                                                                                | The guarantee                    | Never weakened without explicit user approval.                                                                                                                                                                                                                                                                                                                       |
| `tooling`       | Repository tooling: CI scripts, hooks, release, harnesses, generators                                                                                                                                                       | —                                | With the tool.                                                                                                                                                                                                                                                                                                                                                       |

## Rules

- A failing `parity` or `security` assertion means the code is wrong. Fix the code; do not edit the assertion.
- A hand-written test cannot be newly tagged `parity`. The checker accepts a new `parity` tag only as the file-level
  tag of a replay runner: a file whose tests are registered only through `replayParityCases` or
  `replayParityDirectory`.
- Existing `parity` tags stay protected. Removing or rewriting a protected line, deleting a file or stripping a
  legacy file's tags needs a `// @parity-evidence: <proof>` line in the same change, or a retirement entry for the file.
- Hand-written tests that were tagged `parity` before replay cases existed keep their tag and its protection; their
  evidence is the source named in the tag. `scripts/parity-tags-legacy.json` lists each such tag line by file. The
  checker accepts a listed tag where a new `parity` tag would otherwise be refused, the list only shrinks, and an entry
  whose test no longer carries the tag fails the check. New parity is recorded as replay cases.
- When a test mixes kinds, split it or tag each test; do not tag a whole file `parity` because one test is.
- The [frontend](https://github.com/maksii/paqvilo/blob/main/mirage/test/fixtures/frontend-parity-evidence.md),
  [platform](https://github.com/maksii/paqvilo/blob/main/mirage/test/fixtures/platform-parity-evidence.md) and
  [Canvas and Code Apps](https://github.com/maksii/paqvilo/blob/main/mirage/test/fixtures/canvas-code-apps-package-evidence.md) evidence maps name the
  observations behind each area. A filename containing `parity`, an invented browser fixture or an upstream
  compatibility model does not establish native parity.

## Replay cases

Replay cases are how `parity` is asserted. A recorded oracle run becomes a case file, and one runner replays every
case into Mirage and compares the whole output. The expected value is never typed by hand.

### Where things live

| Path                                              | Role                                                                                         |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `mirage/testing/parity-cases.mjs`                 | Validation, building, diffing and the replay runner (exported from `paqvilo/mirage/testing`) |
| `scripts/parity-cases.mjs`                        | CLI: `build`, `check`, `report`                                                              |
| `mirage/test/parity-replay.test.mjs`              | The runner that registers the cases of every surface                                         |
| `mirage/test/parity/cases/<surface>/<suite>.json` | Case files (data only)                                                                       |
| `mirage/test/parity/adapters/<surface>.mjs`       | One adapter per surface: recorded input to Mirage to output in the oracle's shape            |
| `mirage/test/parity/known-gaps/<surface>.json`    | Declared differences between Mirage and the recording                                        |
| `scripts/parity-retirements.json`                 | Ledger of retirements that the checker accepts                                               |
| `scripts/parity-tags-legacy.json`                 | Hand-written parity tags that predate replay cases (shrink-only)                             |

### Case files

A case file is data, and its surface and suite must match its path. Example, with the capture hashes elided:

```json
{
  "schema": "paqvilo.parity-cases/1",
  "surface": "power-fx",
  "suite": "root-official",
  "oracle": {
    "kind": "official-package",
    "name": "Microsoft.PowerFx.Interpreter",
    "version": "1.4.0",
    "scope": "What it establishes."
  },
  "captures": [
    { "id": "run-1", "sha256": "<64 lowercase hex characters>", "capturedAt": "2026-11-08" },
    { "id": "run-2", "sha256": "<64 lowercase hex characters>", "capturedAt": "2026-11-08" }
  ],
  "cases": [
    {
      "id": "abs-negative",
      "input": { "expression": "Abs(-7)" },
      "output": { "kind": "number", "value": 7 },
      "volatile": []
    }
  ],
  "history": []
}
```

`validateParityCases` enforces these rules:

- Only the keys `schema`, `surface`, `suite`, `oracle`, `captures`, `cases` and `history` are allowed. Every value is
  JSON.
- `schema` is `paqvilo.parity-cases/1`. `surface` and `suite` match `[a-z0-9-]+` and equal the names in the path.
- `oracle.kind` is `native`, `official-package` or `reference-engine`. `oracle.name`, `oracle.version` and
  `oracle.scope` are non-empty strings.
- `captures` lists at least two captures with unique ids, a 64-character lowercase `sha256` and a `capturedAt` date.
- `cases` is non-empty. Each case has a unique non-empty `id`, an `input` and an `output`, and a `volatile` array of
  JSON Pointers (RFC 6901; the empty pointer is not allowed). Each volatile pointer must resolve inside `output` and
  hold the placeholder string `"<volatile>"`.
- `history` is an array of `{ "date": "YYYY-MM-DD", "change": "...", "evidence": "..." }` entries.

`input` holds everything the adapter needs to drive Mirage, including host context used by the oracle run, such as
culture, time zone or a fixed clock. `output` is the recorded result in a portable shape. `volatile` lists the
pointers whose values differed between captures (ids, timestamps, etags); they are stored as `"<volatile>"` and the
replay checks only that such a value is present.

Oracle kinds:

- `native`: the hosted platform itself, for example a Dataverse environment, a Power Pages site or the Canvas player.
- `official-package`: an executed official Microsoft package or assembly, for example Microsoft.Xrm.Sdk or PAC.
- `reference-engine`: a Microsoft engine that the platform builds on but is not the platform, for example SQL Server
  behind the Dataverse TDS endpoint.

A case establishes behaviour only for the oracle kind and scope recorded in its file. `report` counts the three kinds
separately.

### Recording

A recorder emits a raw capture:

```json
{
  "capture": { "id": "run-1", "capturedAt": "2026-11-08" },
  "results": [{ "id": "abs-negative", "input": {}, "output": {} }]
}
```

`capture.sha256` is optional: when present (64 lowercase hex characters) it is the hash of the raw record the results
came from; when absent, `build` hashes the capture file's bytes.

`build` writes a case file. Run it from the root of the tree that holds `mirage/test/parity/cases`: without `--out`,
the file goes to `mirage/test/parity/cases/<surface>/<suite>.json` under the current directory. The example uses an
invented corpus:

```sh
node scripts/parity-cases.mjs build --surface docs-demo --suite accounts --oracle-kind official-package --oracle-name "Demo oracle" --oracle-version 1.0.0 --oracle-scope "Invented documentation corpus." --capture run-1.json --capture run-2.json
```

`build` checks the captures before it writes:

- It needs at least two captures. Each lists the same case ids in the same order with equal `input`; otherwise the
  first mismatching id is named.
- `output` comes from the first capture. `volatile` lists the most specific pointers at which any other capture
  differs from the first (a differing array length or key set is reported at the container pointer). Those values
  are stored as `"<volatile>"`.
- A case whose output differs at the root pointer is rejected as not reproducible.
- The result must pass `validateParityCases` before it is written.

When the output path already holds a case file, `build` keeps every existing case and history entry, appends new case
ids and captures, and keeps the recorded oracle unless new oracle options differ from it. A capture id already
recorded with a different `sha256` is refused. A changed existing case or a changed oracle is refused unless
`--revise-change` and `--revise-evidence` are both given, and the revision then appends one `history` entry dated
today:

```sh
node scripts/parity-cases.mjs build --surface docs-demo --suite accounts --capture run-5.json --capture run-6.json --revise-change "abs-negative corrected to 8" --revise-evidence "run-5 and run-6 captured 2026-11-11"
```

### Adapters

An adapter is the one reviewed projection between Mirage values and oracle values for its surface. It exports either a
default `run(input, context)` (stateless), or `open(context)` resolving to `{ run(input, context), close() }`. With
`open`, one session serves one case file: the first case opens it, cases run in file order, and `close` runs after the
file. When both are exported, `open` is used. `liquid-render` is stateless; `dataverse-webapi` opens one
invented-schema session per case file.

`context` is the frozen object `{ surface, suite }`. The adapter never receives the case id or the recorded output.

- Drive Mirage only from `input`. Never branch on the case id, and never read the recorded output.
- Return the output in the recorded oracle shape. Never drop, rewrite or special-case a field to make a case pass.
- A real difference goes to the known-gap file with a precise reason, pointer-scoped where possible.
- Conversions that hold for every case of a surface belong in the adapter, with a comment saying why.
- Simulator `observed` settings are the one authored input. A suite that needs them puts the same constant object in
  every case's `input.observed`; a suite whose cases need different settings is split into one suite per settings
  object. Sources, expressions, requests, schema and data still come from the recorded input.

### Known gaps

`mirage/test/parity/known-gaps/<surface>.json` is an object whose keys are `<suite>#<case id>`. Each value is either:

- a reason string: the whole case is a declared gap. The test passes only while the case still differs (or `run`
  throws); when the case matches, it fails with `known gap closed: remove <suite>#<id>`;
- an object of JSON Pointer to reason: only those pointers are declared gaps. Everything else must match, and each
  declared pointer must still differ, otherwise the test fails with `known gap closed: remove <suite>#<id> <pointer>`.

```json
{ "accounts#account-read": { "/body/name": "The recorded display name differs from the stored name." } }
```

A key must name a recorded case in the same suite; otherwise the test `<surface>/<suite> known gaps name recorded
cases` fails. A recorded case cannot receive a new gap unless the retirement ledger names this known-gap file. A
`run` that throws fails its case, except under a whole-case gap.

### Verifying and reporting

```sh
node --test mirage/test/parity-replay.test.mjs
node scripts/parity-cases.mjs check
node scripts/parity-cases.mjs report
```

The runner names each test `<surface>/<suite>#<id>`. `check` validates every case file and known-gap file. `report`
prints, per oracle kind, the suites, cases and declared gaps (whole-case and pointer). Run it for current numbers,
because they change with each recording.

### Retirements

`scripts/parity-retirements.json` lists each retirement:

```json
{
  "version": 1,
  "retirements": [
    {
      "file": "mirage/test/parity/known-gaps/power-fx.json",
      "reason": "At least 20 characters naming the change.",
      "authority": "Who approved it."
    }
  ]
}
```

- `file` is a repository-relative POSIX path. `reason` has at least 20 characters and `authority` at least 10,
  naming who approved the change.
- Only entries that the change adds count. An entry exempts its file from the removal check on protected parity
  lines, from the deletion check of a case file, and from the new-gap check of a known-gap file.
- An entry does not permit editing recorded cases; a recorded case changes only with a `history` entry.

### Using the lane in a project

Projects import the lane from `paqvilo/mirage/testing`: `replayParityDirectory`, `replayParityCases`,
`buildParityCases`, `validateParityCases`, `loadParityCases` and `diffParityOutput`. A project keeps its own case,
adapter and known-gap directories in the same layout and registers them from a test file run with `node --test`:

```js
import { replayParityDirectory } from 'paqvilo/mirage/testing';

await replayParityDirectory({
  cases: new URL('./parity/cases/', import.meta.url),
  adapters: new URL('./parity/adapters/', import.meta.url),
  knownGaps: new URL('./parity/known-gaps/', import.meta.url),
});
```

Captures that contain private data (exports, identities, raw records) stay in the project and are not committed to
this repository. The CLI's `check` and `report` commands take a case directory as their argument.
