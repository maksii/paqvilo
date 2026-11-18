# Baseline comparison

How `paqvilo mirage baseline-suite compare` measures a scenario's live capture against its Mirage capture, what it
ignores, and how differences become explained. [Coverage](coverage.md) lists the scenarios; the [runbook](rerun.md)
produces the captures. A scenario passes when every delta is zero or explained by a reviewed allowlist entry. The
compare judges behaviour, not intent: where the live portal and the documentation disagree, live evidence wins and the
difference is recorded in the [reference](reference.md) or the inventories. These are recorded comparisons for one
fixture and project; they are not `parity` replay cases in the sense of [test kinds](../../../docs/test-kinds.md).

## What is compared

`mirage/baseline-compare.mjs` compares each side's evidence:

| Evidence                           | Comparison                                                                                                                                                                                                                                                                                                            |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Requests (`requests.json`)         | Aligned in order by method and path (longest common subsequence); a request on one side only is a `presence` delta. Aligned pairs compare query, resource type, headers and body (JSON as values, form bodies as sorted parameters).                                                                                  |
| Responses                          | Status and headers; HTML bodies as DOM, JSON, form and text as values; unstored bodies by byte count and SHA-256.                                                                                                                                                                                                     |
| DOM (`dom.html`)                   | A parse5 walk from the first element: tag, every attribute, class tokens, whitespace-normalized `style`, text nodes, child counts and the contents of JSON `<script>` and `<style>` elements; also the final URL and title.                                                                                           |
| Elements (`elements.json`)         | Matched by selector: presence, tag, `visible`, `disabled`, `readonly`, `required`, `value`, classes and attributes.                                                                                                                                                                                                   |
| Same-origin frames (`frames.json`) | Each frame's DOM is stored under its URL path (repeats get `#2`, `#3`, …) and walked as location `frame <path>`; its elements are inventoried with the selector prefix `frame(<path>) `. A frame on one side only is a `presence` delta. Allowlist entries for elements also match frame elements without the prefix. |
| Console (`console.json`)           | Error and warning entries and page errors, as sets.                                                                                                                                                                                                                                                                   |

Verdicts: `PASS` (no deltas), `ALLOWED` (every delta allowlisted or stale), `FAIL` (an unexplained delta), `ERROR` (a
side is missing or its `meta.json` status is not `captured`). The verdict is written in capitals in `diff.json`, the
progress line, `report.json` and `summary.md`; a lowercase `error` in an older `diff.json` is still read as `ERROR`.
Each side is the capture folder named by its label (`--live`, default `live`; `--mirage`, default `mirage`;
`--second-live`). A capture's `meta.json` keeps `side` as `live` or `mirage` and stores the capture's `--label` in
`label`. `compare` exits 1 when any scenario is `FAIL` or `ERROR`. `summary.md` groups deltas into signatures,
unexplained first: that is the work list.

Not compared: pixels (`screenshot.png` is kept for review only); non-JSON script elements and their inline contents
(script requests and response bodies still are); cross-origin traffic the capture does not record, such as platform CDN
bundles; cross-origin iframe contents; console `log` and `info`.

### Normalizations

No difference is hidden by default. Each normalization replaces a generated token or removes instrumentation, never
the element or request that carries it, so a missing or extra element still shows. A normalized match is not byte
equality.

| Normalization                                                                                                   | Why it is safe                                                                                               |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `PcfControl_<32 hex>` → `PcfControl_{hex32}`                                                                    | Per-render GUID of a PCF host; the host element is still compared                                            |
| `UpdMSPicklistControl<n>` → `UpdMSPicklistControl{n}`                                                           | Instance counter of a hosted bundle                                                                          |
| `$ctl<n>` → `$ctl{n}`                                                                                           | ASP.NET control counter; the name prefix stays significant                                                   |
| `data-content-id` GUIDs and `popoverUpdateButton_<guid>` → `{guid}`                                             | Per-render GUIDs; the attribute's presence is still compared                                                 |
| ID of each `div.addressCompositeControlContainer` → `{address-composite-id-<n>}`, also in CSS-escaped selectors | Fresh GUID per render, tokenized in document order; other GUID IDs, such as record IDs, stay significant     |
| The matrix origin and loopback origins → `{origin}`                                                             | Each side links to its own origin; the path is still compared                                                |
| Multipart bodies compared by part; the `content-type` boundary → `{boundary}`                                   | Random per upload; parts compare by name, file parts by file name, type and length                           |
| `x-sim-*`, `x-paqvilo-*` and `x-trace-id` headers stripped                                                      | Mirage diagnostics, provenance and trace IDs                                                                 |
| `data-paqvilo-*` and `data-sim-*` attributes ignored; elements the toolkit injects not compared                 | Toolkit provenance annotations and runtime markup; the annotated portal element is still compared            |
| Grid data `Records[n].Attributes` matched by `Name`                                                             | The live portal orders attributes by storage, which varies per record; values are still compared             |
| `<style data-merge-styles>`, `<style data-load-themed-styles>` and `<style data-fela-type>` removed             | Injected at run time by hosted React/Fluent bundles; they would shift every positional head delta            |
| `nonce` attributes ignored; `/__sim/` requests not recorded                                                     | Per-response values and local instrumentation                                                                |
| `{token}` placeholders, cookie names only, redacted query values                                                | Written at capture time on both sides, so secrets never reach the evidence; equal placeholders compare equal |

### Capture integrity

- Each live run carries its own nonce when the bridge runner posts evidence to the suite's loopback receiver. A late
  post from a call abandoned after a timeout is refused (409) and reported, so it cannot satisfy another scenario.
- `writeCapture` refuses a result whose scenario ID differs from its folder's.
- Steps marked `harness: true` (such as clearing the portal cache between a save and a reload) record no requests,
  console entries or URL.

## Allowlist

The project's allowlist (`--allowlist FILE`) lists explained differences that are not defects:

```json
{
  "id": "…",
  "scope": "request|response|dom|element|console",
  "pattern": "<location regex>",
  "field": "<field regex>",
  "value": "<optional regex on either side's value>",
  "reason": "…",
  "proof": "platform-generated|live-run-variance",
  "evidence": "<evidence path>"
}
```

- **`platform-generated`.** The platform produces the value and Mirage cannot derive it from the export: hosting and
  transport headers, request and correlation IDs, build hashes, platform runtime script bodies and metadata IDs. The
  entry cites the documentation or live evidence. Mirage ships its own equivalents of platform runtime assets
  (`WebResource.axd`, ResourceManager strings) and never copies live bodies; one entry per asset family explains the
  body deltas while requests, order and presence are still compared.
- **`live-run-variance`.** The value differs between two independent live captures of the same scenario (anti-spam field
  names, per-run instance IDs, creation stamps). With `compare --second-live <label>`, a scenario that has a second live
  capture is _paired_: deltas between its two live captures (requests, DOM, frames, elements; not console) are
  classified against the allowlist, and the entries they match are _witnessed_ there (`variance.entries` in its
  `diff.json`). In a paired scenario such an entry explains a Mirage delta only if witnessed there; otherwise the delta
  is `unprovenVariance` and stays unexplained. In unpaired scenarios, and in runs without `--second-live`, the entry
  explains its deltas on the strength of the paired evidence. The report's `variance` section lists, per entry, the
  scenarios it explains, the witnesses and the unproven deltas; an entry no scenario witnesses has no proof yet. A delta
  whose location and field also differ between live captures carries `liveVariance`.

A value Mirage can derive from the export, Solution, settings or data is a Mirage fix, never an allowlist entry; a
value it cannot derive is an allowlist candidate and is never hardcoded into Mirage. Reject an entry broader than its
evidence, or one the compare could normalize safely, or traffic the capture should not record. Contributors and agents
propose entries; they never approve their own.

## Evidence changes

A live change made after some captures (a fixture upload, a role change, new rows) is captured once on representative
scenarios and recorded in a project file, not recaptured everywhere. `compare --evidence-changes FILE` reads:

```json
{
  "version": 1,
  "changes": [
    {
      "id": "…",
      "since": "<ISO instant of the live change>",
      "staleBefore": "<optional ISO instant, not earlier than since>",
      "affects": "<scenario id regex>",
      "signatures": [
        {
          "scope": "dom",
          "field": "<regex>",
          "location": "<regex>",
          "live": "<optional regex>",
          "mirage": "<optional regex>"
        }
      ],
      "proof": ["<representative scenario id>"],
      "reason": "…"
    }
  ]
}
```

A delta that is not allowlisted is marked `staleEvidence: <id>` and counted as `stale` (neither allowed nor
unexplained) when the scenario's live capture is older than `since` (or `staleBefore`, for changes that reach pages
later through the portal's output cache), the scenario matches `affects`, and the delta matches a signature. After all
scenarios are compared, the change is accepted only if every proof scenario has a live capture after `since` whose
compare shows none of the signatures unexplained; otherwise it is rejected and its deltas count as unexplained again.
The report's `evidenceChanges` section and `summary.md` list each change's status, proofs and stale counts. Stale deltas
are not explained behaviour: they go away when the affected scenarios are recaptured.

## Working rules

- The fixture never changes the reference site's shared settings, default roles or shared snippets. Their live values
  are recorded as observed values, and Mirage derives them from the same export.
- Fix findings as they arrive, prove each fix with a targeted capture of the scenarios it touches, and recapture only
  scenarios the verified state changes. Never run a broad capture over an area whose fix is unverified.
- Every live run uses a reviewed scenario list derived from the evidence. The second live run captures the fewest
  scenarios that witness each live-run-variance entry in two paired scenarios.
- One client owns the live browser bridge at a time.

## Reading results

Results belong to the tested project and revision; generate a fresh `summary.md`. Read the `PASS`, `ALLOWED`, `FAIL`
and `ERROR` totals, then the unexplained signatures, unproven variance and stale evidence. `ALLOWED` is not identical
output, an accepted evidence change is not observed equality, and unreachable states keep their not-observed reasons.
