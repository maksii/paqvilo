# Baseline parity

How the comparison between the live reference portal and Mirage is measured, what it deliberately ignores, and how differences become explained. [Coverage](coverage.md) says which scenarios exist. The [runbook](rerun.md) says how to produce the captures this page compares.

A scenario passes when every delta between its live capture and its Mirage capture is zero, or is explained by a reviewed allowlist entry. The comparison judges behaviour, not intent. Where the live portal and the Power Pages documentation disagree, the live evidence wins, and the difference is recorded in the [reference](reference.md) or the inventories.

## What is measured

`mirage/baseline-compare.mjs` compares the evidence the capture writes for each side:

| Evidence | How it is compared |
| --- | --- |
| Requests (`requests.json`) | Requests are aligned in order by method and path, using the longest common subsequence. A request on one side only is a `presence` delta. For each aligned pair, the compare checks the query, resource type, headers and body. JSON bodies are compared as values and form bodies as sorted parameters. |
| Responses | Status and headers are compared. HTML bodies are compared as DOM, and JSON, form and text bodies as values. When a body is not stored, its byte count and SHA-256 are compared instead. |
| DOM (`dom.html`) | A structural parse5 walk from the first element compares the tag, every attribute and the class token list. It also compares `style` with whitespace normalised, the text of text nodes, child counts, and the contents of JSON `<script>` and `<style>` elements. The final URL and the title are compared too. |
| Element inventory (`elements.json`) | Elements are matched by selector. The compare checks presence, tag, `visible`, `disabled`, `readonly`, `required`, `value`, classes and attributes. |
| Same-origin frames (`frames.json`, frame elements in `elements.json`) | Each same-origin frame's DOM is stored under its URL path (a repeated path gets `#2`, `#3` …). It is walked like the page under the location `frame <path>`, after the same normalisations. A frame on one side only is a `presence` delta. Its elements are inventoried with the selector prefixed by `frame(<path>) ` and compared like the page's. Frames on another origin are not inventoried. |
| Console (`console.json`) | Error and warning entries and page errors, compared as sets. |

The verdict per scenario is one of the following:

- `PASS`: no deltas.
- `ALLOWED`: every delta is allowlisted.
- `FAIL`: at least one delta is unexplained.
- `ERROR`: a side is missing, or its capture status is not `captured`.

`summary.md` groups deltas into signatures, unexplained first. That is the work list.

### What is not measured

- **Pixels.** Both sides save `screenshot.png` for review, but nothing compares them. Layout matters only as far as markup, classes, inline styles and element visibility show it.
- **Non-JSON script elements.** Their elements and inline contents are left out of the DOM walk. Requests for script files and their response bodies are still compared.
- **Cross-origin traffic the capture does not record.** On live, this includes the platform CDN bundles. An allowlist entry covers the resulting presence deltas.
- **Cross-origin iframe contents.** Same-origin frames, such as modal list forms and the lookup create dialog, are inventoried. Captures taken before that change have no `frames.json`.
- **Console `log` and `info` entries.**

### Normalisations and why each is safe

The compare does not hide differences by default. Each normalisation below replaces a generated token, or removes instrumentation that is not rendered behaviour. It never removes the element or request that carries it, so a missing or extra element still shows up as a delta. A normalised match is not byte equality.

| Normalisation | Why it is safe |
| --- | --- |
| `PcfControl_<32 hex>` → `PcfControl_{hex32}` | A per-render GUID of a PCF host. The host element is still compared. |
| `UpdMSPicklistControl<n>` → `{n}` | An instance counter of a hosted bundle. |
| `$ctl<n>` → `$ctl{n}` | An ASP.NET control counter in generated control names. The name prefix stays significant. |
| `data-content-id` GUIDs → `{guid}`, `popoverUpdateButton_<guid>` → `{guid}` | Per-render GUIDs. The attribute's presence is still compared. |
| The id of each `div.addressCompositeControlContainer` → `{address-composite-id-<n>}` (also in CSS-escaped selectors) | The address composite control's hidden popover container gets a fresh GUID per render. Only ids of elements with that class are tokenised, in document order. Other GUID ids, such as record ids, stay significant. |
| The matrix origin and loopback origins → `{origin}` | Each side links to its own origin. The path after the origin is still compared, in DOM, elements, requests and headers. |
| `x-sim-*` request and response headers stripped | Mirage diagnostics, not portal behaviour. |
| Grid data `Records[n].Attributes` matched by `Name` | The live portal lists each record's attributes in storage order, which differs between records of one response. The values are still compared per attribute. |
| `<style data-merge-styles>`, `<style data-load-themed-styles>` and `<style data-fela-type>` removed before the DOM walk | Hosted React/Fluent bundles inject these styles at run time. Without this step they shift every positional head delta. |
| `nonce` attributes ignored, `/__sim/` requests not recorded | Per-response values and the local runtime's own instrumentation. |
| `{token}` placeholders, cookie names only, redacted query values | These are written at capture time on both sides, so secrets never reach the evidence. The same placeholder compares equal. |

The token normalisations (the first five rows) are the D11 decision. Before it, the elements' presence was allowlisted. Normalising the token instead keeps the element visible to the compare.

## Allowlist model

The allowlist (`allowlist.json` in the project) lists the differences that are explained and not defects. Each entry has the following fields:

```json
{ "id": "…", "scope": "request|response|dom|element|console", "pattern": "<location regex>", "field": "<field regex>",
  "value": "<optional regex on either side's value>", "reason": "…", "proof": "platform-generated|live-run-variance", "evidence": "<evidence path>" }
```

There are two kinds of proof:

- **`platform-generated`.** The platform produces the value, and Mirage cannot derive it from the exported sources. Examples: hosting and transport headers, request and correlation ids, build hashes, platform runtime script bodies, and platform metadata ids. The entry cites the Learn page or the live evidence that shows it.
- **`live-run-variance`.** The value differs between two independent live captures of the same scenario. Examples: anti-spam field names, per-run instance ids, and creation stamps. When compare runs with `--second-live`, the deltas between the two live captures are classified against the same allowlist; the entries they match are *witnessed* in that scenario (`variance.entries` in its `diff.json`). The proof is per entry within the scenario, not per exact location, because the varying token often sits in an element id, a posted field name or a request index. A live-run-variance entry explains a Mirage delta only in a scenario where it is witnessed. Any other delta it would cover is reported as `unprovenVariance` and stays unexplained. A delta whose exact location and field also differ between the live captures carries `liveVariance`. The report's `variance` section lists, per entry, the paired scenarios it explains a delta in, the scenarios that witnessed it, and the unproven scenarios and deltas. Entries merged before a variance run are pending until that run confirms them.

### Review

- **Proposals.** Agents and contributors write proposals to `allowlist-proposals/<area>.json` and never approve their own.
- **Merge.** The author reviews each proposal against its evidence and merges it. The file's `reviewed` stamp records each merge: the date, the scope, and what was rejected.
- **Rejected list.** A rejected proposal goes to `allowlist-proposals/rejected.json` with `rejectedBecause`. Rejection is the rule when the compare can normalise the difference safely, when the entry is broader than its evidence, or when the capture should not record the traffic at all.
- **No hardcoding.** A value Mirage can derive from the export, the solution, the settings or the data is a Mirage fix, not an allowlist entry. A value Mirage cannot derive becomes an allowlist candidate. It is never hardcoded into Mirage.

## Decisions that shape the comparison

- **Shared site settings stay as they are (D8).** The fixture never changes the reference site's global settings, default roles or shared snippets. Their live values are recorded as observed values. Mirage derives them from the same export, like everything else it renders, so a settings difference is fixed in Mirage, never by changing the shared site.
- **Platform runtime assets (D10).** Live serves the platform's runtime scripts, `WebResource.axd` and the ResourceManager strings. These bodies are absent from the export. Mirage ships local equivalents by design and never copies live bodies. One reviewed entry per asset family explains the body deltas (`platform-runtime-script-bodies`, `resource-manager-body`). The requests themselves, their order and their presence are still compared.
- **Process (D12).**
  - Fix findings as they arrive.
  - Prove each fix with a targeted capture of the scenarios it touches, then verify the evidence.
  - Recapture broadly only the scenarios the verified state changes.
  - Never run a broad recording or compare over an area whose fix is unverified. One unfixed cause repeats across scenarios and forces rerun after rerun.
  - One client owns the live browser bridge at a time.

## Current state

Final comparison of {{date}}:

- Unexplained deltas: {{unexplained}}
- Scenarios with zero deltas: {{zero}}
- Allowlist entries: {{allowlist}}

Read the per-scenario verdicts and signatures in the project's `summary.md`. The reasons for states the reference portal cannot show are in the [reference](reference.md).
