# Dataverse Web API recorder and parity suite

`mirage/dataverse-parity.mjs` records explicit request plans, replays them against another API, and compares responses. It does not infer server correctness from SDK mocks or turn metadata discovery into tested behavior. Keep real plans, customizations, observations and transcripts in the owning project under ignored `.paqvilo/`.

```sh
node mirage/dataverse-parity.mjs record --plan project-plan.json --base http://127.0.0.1:9000/api/data/v9.2/ --out .paqvilo/reference
node mirage/dataverse-parity.mjs replay --plan project-plan.json --base http://127.0.0.1:9001/api/data/v9.2/ --out .paqvilo/replay --reference .paqvilo/reference/run.json
node mirage/dataverse-parity.mjs diff --reference .paqvilo/reference/run.json --actual .paqvilo/replay/run.json --out .paqvilo/comparison.json
node mirage/dataverse-parity.mjs catalogue --metadata .paqvilo/metadata.xml --out .paqvilo/catalogue.json
node mirage/dataverse-parity.mjs assert --checks project-checks.json --actual .paqvilo/replay/run.json --out .paqvilo/assertions.json
```

Commands return nonzero for response differences, incomplete assertion coverage, or failed execution. A run directory cannot be reused. Remote fetch targets require `--allow-remote` and HTTPS; mutation plans additionally require `--allow-writes`. These switches express tool policy, not authorization to change an environment. Follow the project's live access rules. Authentication can come from `--token-env VARIABLE_NAME`; never put credentials in the plan, arguments or evidence. The token is injected by the transport and remains outside the recorded request.

## Plans and programmatic transports

```js
import { runSuite, createRunWriter, compareRuns, coverageReport } from 'paqvilo/mirage/dataverse-parity.mjs';

const plan = {
  schemaVersion: 1,
  id: 'example-read',
  cases: [{
    id: 'read-items', family: 'query',
    request: { method: 'GET', path: 'example_items?$select=example_name&$top=2' },
    acceptStatus: [200],
    covers: ['entitySet:example_items'],
  }],
};
const writer = await createRunWriter('.paqvilo/new-run');
try {
  const run = await runSuite(plan, {
    // Own the signed-in browser/session and origin confinement in this adapter.
    transport: async request => ({
      status: 200, headers: { 'content-type': 'application/json' },
      bodyBase64: Buffer.from('{"value":[]}').toString('base64'),
    }),
    sink: writer.sink,
  });
} finally { await writer.close(); }
```

The illustrated transport is synthetic. A real adapter must return actual status, normalized headers and response entity bytes as `bodyBase64`; it must not follow redirects or send credentials outside its authorized origin. Return `{ transportError: 'timeout' }` for an unknown outcome. No response is invented for network failure.

Cases require unique IDs and a family. Optional `dependsOn` IDs must precede the case. Accepted-status guards and captures must succeed before dependent cases execute. Unexpected HTTP responses remain evidence, and a missing capture retains its response. Cases without `acceptStatus` discover whatever HTTP behavior occurs; an observed response is not proof that the intended feature succeeded.

Request bodies use exactly one of `body` (JSON), `bodyText`, or `bodyBase64`. This permits malformed JSON, multipart batches and binary requests. `{{variable}}` templates preserve a captured primitive's type when used alone and require scalars when embedded in strings. `capture: { currentEtag: '/headers/etag' }` reads a JSON pointer from the sealed response; `/json/@odata.nextLink` captures a continuation. Captures bind independently in reference and replay runs. Supply target-specific variables such as `base` and actor IDs to `runSuite`; the CLI overrides `base` with its target URL.

The caller owns fixture creation, isolated identities, setup success conditions, cleanup and follow-up readbacks. Save client-generated IDs before writes. Cleanup cases can be independent of failed test cases but must remain confined to journaled owned resources. A failed or interrupted write is never retried automatically. Inspect `journal.jsonl` before reconciliation: its fsynced `intent` precedes each request, and each observed result is durable. No `run.json` means completion has not been attested.

## Comparison and provenance

`compareRuns(reference, actual)` compares completeness, plan hashes, case presence, status, headers, raw entity bytes, JSON field presence/types/array order and nested multipart HTTP parts. JSON numeric spelling and property order remain visible in the byte comparison. Arrays are never sorted; errors are never rewritten into a preferred envelope. The report groups differences by status, headers, bytes, JSON, multipart or execution outcome, and retains total counts when its detail limit is reached. Unknown or blocked cases never match, even against themselves.

New runs embed their validated plan. Comparison reconstructs each executed request from that plan, the run's target variables and its own captured responses. Changed methods, paths, headers or bodies cannot establish parity by copying a response. Legacy runs require `{ plan }` in the API or `diff --plan FILE`; an unavailable plan remains a verification gap. Stored status, raw bytes, hash, length and parsed representations are checked for consistency before comparison or documentation assertions. Coverage also requires the matching plan, unique result IDs and reconstructable requests.

Malformed multipart remains raw evidence with `multipartParseError`; parsing failure does not discard credential-safe response bytes. Credential-bearing MIME remains withheld even when its envelope is malformed.

All response headers are compared, including clocks, request IDs and ETags. Consequently independently generated values usually differ. A project's `rules` file may classify an exact case/path/reference-value/actual-value tuple with a reason. Reviewed differences remain differences and never change `exactMatch` or the strict exit status. No wildcard tolerances or silent normalization apply.

`evaluateAssertions(run, checks)` provides a separate documentation or SDK oracle. Each check requires a unique ID, `caseId`, source kind (`documentation`, `sdk-fixture`, or `native`), source URL and explicit assertions. Operators are `exists`, `absent`, `equals`, `type`, and `includes`; selectors are JSON pointers rooted at the response. Keep unresolved preconditions and prose obligations in `untested`. Passing selected facets does not prove every statement in a document or establish native parity. SDK unit-test stubs are client expectations until measured against Dataverse.

`inspectCsdl(xml)` inventories overload signatures, binding parameters, return types, entity sets and types. `coverageReport(plan, run, catalogue, requiredFamilies)` retains unplanned families, blocked/unrecorded cases, and undispatched inventory entries. Discovered administrative actions require independently authorized, isolated scenarios; cataloguing does not execute them. A signature-level observation still does not exhaust its possible inputs.

Authentication headers/cookies are withheld; credential-shaped bodies are rejected from evidence. Do not run token issuance or credential-management APIs through this recorder. Multipart credential headers are rejected because they would also occur inside raw entity bytes. Keep evidence private even after this filtering. Browser/fetch adapters expose decoded entity bytes and normalized headers, not TLS traffic, compressed wire frames or header casing/order. Credential-bearing headers are outside exact comparison scope.

Declared text/base64 bodies and initially resolvable body variables are inspected before the plan/start journal event. A rejected request therefore cannot leave an encoded credential in the saved plan. Custom transports should return short diagnostic codes for network failures; arbitrary transport-error text is replaced with `transport-failed`.

A finite suite cannot establish every request value, identity, schema, installed extension, concurrency interleaving, licensed feature or future platform behavior. Record the environment and fixture provenance, keep a coverage denominator, and leave unknowns as gaps.
