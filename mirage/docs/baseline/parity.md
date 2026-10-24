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
| Same-origin frames (`frames.json`, frame elements in `elements.json`) | Each same-origin frame's DOM is stored under its URL path (a repeated path gets `#2`, `#3` …). It is walked like the page under the location `frame <path>`, after the same normalisations. A frame on one side only is a `presence` delta. Its elements are inventoried with the selector prefixed by `frame(<path>) ` and compared like the page's. Frames on another origin are not inventoried. Allowlist entries for elements also match a frame element's selector without its `frame(<path>) ` prefix, so platform values on the page, such as CDN links, are explained the same way inside frames. The quick view frame's form action carries the platform's hosting telemetry parameters (msCorrelationId, instanceId, tenantId and others), which no export supplies. It is allowlisted (`quickview-form-action-telemetry`, `-element`), not normalised, so a different action path still shows. |
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
| Multipart request bodies compared by part, and the boundary token in `content-type` → `{boundary}` | The browser picks a random boundary for each upload postback. Parts are compared by name, like urlencoded fields. A file part compares as its file name, type and byte length. |
| `x-sim-*` request and response headers stripped | Mirage diagnostics, not portal behaviour. |
| Grid data `Records[n].Attributes` matched by `Name` | The live portal lists each record's attributes in storage order, which differs between records of one response. The values are still compared per attribute. |
| `<style data-merge-styles>`, `<style data-load-themed-styles>` and `<style data-fela-type>` removed before the DOM walk | Hosted React/Fluent bundles inject these styles at run time. Without this step they shift every positional head delta. |
| `nonce` attributes ignored, `/__sim/` requests not recorded | Per-response values and the local runtime's own instrumentation. |
| `{token}` placeholders, cookie names only, redacted query values | These are written at capture time on both sides, so secrets never reach the evidence. The same placeholder compares equal. |

The token normalisations (the first five rows) replace only the token, not the element, so the element stays visible to the compare instead of needing an allowlist entry.

### Capture harness integrity

- **Each live run carries its own nonce.** The bridge runner posts its evidence to the suite's loopback receiver together with the nonce of its run.
  - A bridge call the client abandoned after a timeout keeps running in the bridge. Its late post is refused (409) and reported in the side's diagnostics, so it cannot fill the next scenario's wait or land in another scenario's folder.
- **writeCapture checks the scenario id.** It refuses a result whose scenario id differs from the folder's scenario.
- **Harness-only steps** (`harness: true`) leave no evidence: they record no requests, console entries or URL.

## Allowlist model

The allowlist (`allowlist.json` in the project) lists the differences that are explained and not defects. Each entry has the following fields:

```json
{ "id": "…", "scope": "request|response|dom|element|console", "pattern": "<location regex>", "field": "<field regex>",
  "value": "<optional regex on either side's value>", "reason": "…", "proof": "platform-generated|live-run-variance", "evidence": "<evidence path>" }
```

There are two kinds of allowlist proof (a third explanation, evidence age, follows below):

- **`platform-generated`.** The platform produces the value, and Mirage cannot derive it from the exported sources. Examples: hosting and transport headers, request and correlation ids, build hashes, platform runtime script bodies, and platform metadata ids. The entry cites the Learn page or the live evidence that shows it.
- **`live-run-variance`.** The value differs between two independent live captures of the same scenario. Examples: anti-spam field names, per-run instance ids, and creation stamps. When compare runs with `--second-live` and a scenario has a captured second live folder (a *paired* scenario), the deltas between the two live captures are classified against the same allowlist; the entries they match are *witnessed* in that scenario (`variance.entries` in its `diff.json`). The live-vs-live comparison covers requests, DOM, frames and elements; console entries are excluded. The proof is per entry within the scenario, not per exact location, because the varying token often sits in an element id, a posted field name or a request index. In a paired scenario, a live-run-variance entry explains a Mirage delta only when it is witnessed there; any other delta it would cover is reported as `unprovenVariance` and stays unexplained. In an unpaired scenario, and in every scenario of a run without `--second-live`, the entry explains its deltas unconditionally, on the strength of the variance evidence from the paired scenarios. Nothing marks an entry pending: the report's `variance` section is the proof to read. It lists, per entry, the paired scenarios it explains a delta in, the scenarios that witnessed it, and the unproven scenarios and deltas. An entry that no paired scenario witnesses has no proof yet; the variance subset exists to pair it. A delta whose exact location and field also differ between the live captures carries `liveVariance`.

### Evidence age (third kind)

A change is captured once, not on every page it touches. A live change made after some live captures were taken (a fixture provisioning, a role removal, new rows, a site upload) is recorded in a project file, not recaptured everywhere.

`compare --evidence-changes FILE` reads a list of recorded changes:

```json
{ "version": 1, "changes": [{ "id": "…", "since": "<ISO instant of the live change>", "affects": "<scenario id regex>",
  "signatures": [{ "scope": "dom", "field": "<regex>", "location": "<regex>", "live": "<regex, optional>", "mirage": "<regex, optional>" }],
  "proof": ["<representative scenario id>"], "reason": "…" }] }
```

A delta that is not allowlisted is marked `staleEvidence: <id>` when all of the following hold:

- the scenario's live capture is older than `since`;
- the scenario matches `affects`;
- the delta matches one of the signatures.

Such a delta is counted as `stale`, neither allowed nor unexplained.

A change that reaches pages through the portal's per-page output cache lands on each page later than its write. An optional `staleBefore` (not earlier than `since`) then extends the stale window to captures taken before that instant. The proof scenarios still need captures after `since` that show none of the signatures. A scenario whose remaining deltas are all allowed or stale is `ALLOWED`.

The change is only accepted after every scenario is compared. Each proof scenario must have a live capture taken after `since`, and its compare must show no unexplained delta of the change's signatures. Otherwise the change is rejected and its deltas count as unexplained again. A proof scenario that is missing, older than `since`, not comparable, or still showing the signature all reject the change.

The report's `evidenceChanges` section and `summary.md` list each change with its status, its proof states and its stale counts. Stale deltas are not explained behaviour: they disappear once the affected scenarios are recaptured live.

### Review

- **Proposals.** Agents and contributors write proposals to `allowlist-proposals/<area>.json` and never approve their own.
- **Merge.** The author reviews each proposal against its evidence and merges it. The file's `reviewed` stamp records each merge: the date, the scope, and what was rejected.
- **Rejected list.** A rejected proposal goes to `allowlist-proposals/rejected.json` with `rejectedBecause`. Rejection is the rule when the compare can normalise the difference safely, when the entry is broader than its evidence, or when the capture should not record the traffic at all.
- **No hardcoding.** A value Mirage can derive from the export, the solution, the settings or the data is a Mirage fix, not an allowlist entry. A value Mirage cannot derive becomes an allowlist candidate. It is never hardcoded into Mirage.

## Rules for the comparison

- **Shared site settings stay as they are.** The fixture never changes the reference site's global settings, default roles or shared snippets. Their live values are recorded as observed values. Mirage derives them from the same export, like everything else it renders, so a settings difference is fixed in Mirage, never by changing the shared site.
- **Platform runtime assets.** Live serves the platform's runtime scripts, `WebResource.axd` and the ResourceManager strings. These bodies are absent from the export. Mirage ships local equivalents by design and never copies live bodies. One reviewed entry per asset family explains the body deltas (`platform-runtime-script-bodies`, `resource-manager-body`). The requests themselves, their order and their presence are still compared.
- **Process.**
  - Fix findings as they arrive.
  - Prove each fix with a targeted capture of the scenarios it touches, then verify the evidence.
  - Recapture broadly only the scenarios the verified state changes.
  - Never run a broad recording or compare over an area whose fix is unverified. One unfixed cause repeats across scenarios and forces rerun after rerun.
  - One client owns the live browser bridge at a time.
- **A change is captured once.** A live change, such as a fixture upload, a role change or new rows, is captured on one representative scenario per affected component, not on every page it touches. The change and its proof scenarios are recorded for the evidence-age explanation above.
- **No blanket recaptures.** Every live run works from a reviewed list derived from the evidence. The variance proof follows the same rule: the second live run captures the fewest scenarios such that each live-run-variance entry is witnessed in two paired scenarios, chosen from the current `diff.json` files and recorded as an entry-to-scenario map in the project.

## Reading project results

Comparison results belong to the tested project and revision. Generate a fresh `summary.md`
for your run rather than treating this guide or the bundled offline reference as a release
qualification. Native and local captures can contain genuine rendering differences as well
as stale evidence; inspect both before deciding whether a fix is needed.

Read the totals for `PASS`, `ALLOWED`, `FAIL` and `ERROR`, then inspect unexplained signatures,
unproven variance and stale evidence. An allowlisted scenario is not identical output, and
accepted evidence-age explanations are not observed parity. Unreachable states retain their
not-observed reasons. These tools do not currently compare screenshots for pixel equality.
