# Consumer feedback qualification for 0.9.8

The review uses invented schemas, native-shaped DOM and loopback fixtures. No
consumer project, live portal, credentials or business data was accessed. The
branch starts at `adf1b72c14e3b7060bc656fe7c479be39923e909` from `origin/0.9.8`.

## 215. Startup, catalogue and record volume

The earlier simple-workload qualification includes 1,000 tables, 1,000,000 rows, 24 columns per table,
8,000 imported forms, 9,006 source files and three complete Solution roots.
Each start runs in a separate server process. The browser exercises the populated
grid, keyword search, record opening and an editable draft before requesting the
complete catalogue. Every table and form remains available through that API;
its response is approximately 302 MB. Small index/selected-table responses avoid
constructing unrelated form bodies. No forms, fields or functional assertions
are removed to obtain the timings.

Local Windows / Node 24.22.1 x64 results on 2026-10-28:

| Distribution / start              | Startup ms | Usable grid after listener ms | Browser search ms | Server peak RSS MiB |
| --------------------------------- | ---------: | ----------------------------: | ----------------: | ------------------: |
| Uniform / fresh                   |      15918 |                           910 |                69 |                3260 |
| Uniform / unchanged               |      15527 |                           895 |                72 |                3268 |
| Uniform / grown journal           |      14951 |                           918 |                66 |                3118 |
| Uniform / changed source          |      15405 |                           876 |                64 |                3120 |
| 900,000 rows in one table / fresh |      16696 |                          2430 |              2321 |                3322 |

These are observations, not hardware-independent budgets. The historical
`startupMs` figures measure `createSimulator` initialization after worker module
imports and fixture setup. They exclude that preceding process work. The probe
now also reports `processStartupMs` from worker launch through listener readiness;
browser launch remains separate. RSS includes the
complete catalogue request and excludes the parent HTTP client and browser;
filesystem warmth is uncontrolled. Status heartbeats during full catalogue reads
remained below the probe's 1,000 ms deadline (worst observed 757 ms). This does
not measure heartbeat latency during record queries. Large single-table searches
still require scanning matching data and are slower than the uniform case.
These earlier timings used the first visible populated-grid action as the
readiness proxy. The extended probe now requires the shell's explicit ready
signal before edits; visibility alone does not establish control readiness.

All four starts verify the exact row count, all roots' imported forms, source
security metadata, and retained local journal edits. Unchanged and subsequent
starts generate no preset rows. Separate regressions exercise staff/FLS masking,
denied writes, source reload with and without watchers, rollback isolation,
failed persistence and integrity checks.

The review removed a redundant full preset graph clone, unnecessary initial
primary-key sorting for flat queries with valid IDs, and off-page FetchXML value
projection. Before the latter fix, a regression observed 1,500 payload copies for
a 25-row page; afterward it observes 25, retaining totals, ordering and cookies.
The skewed fixture's grid improved from 5,554 to 2,430 ms and search from 3,504 to
2,321 ms in sequential local runs. Metadata comparison now uses retained row
stamps. In-place column security/labels, component presence and same-ID asset
changes invalidate the overlay, including integrity revalidation.

Reproduce from the source checkout (the large runs are opt-in):

```sh
node scripts/runtime-qualification.mjs 1000 1000000 --simple
node scripts/runtime-qualification.mjs 1000 1000000 skewed --simple --fresh-only
node scripts/runtime-performance.mjs --large
node --test mirage/test/runtime-performance.test.mjs mirage/test/startup-cost.test.mjs
```

The older `runtime-performance` API probe uses sequential same-process starts;
its cumulative high-water RSS must not be compared with the isolated-process
qualification above. Its `--large` workload now defaults to 1,000 tables,
1,000,000 rows and 12 forms per table.

### Extended wide-table qualification

The extended fixture uses 2,000 tables: 1,000 with 257 fields and 200 real
outgoing relationships each, and 1,000 with 33 fields and one relationship each.
The wide tables hold 80% of the records. One percent of their rows populate all
257 fields; other rows model nullable columns. Rows include typed values,
Unicode, long text, JSON, HTML and populated lookup references. Each table has
eight multi-tab forms, four views (including filters and an outer join), localized
labels and authored script handlers. Wide forms also bind an imported PCF control.
The three Solution roots contain 32,010 source files, including 30,006 XML files,
16,000 forms and 8,000 views (420,128,006 source bytes).

The browser qualification verifies scripts and PCF mount, draft editing, search,
all forms and views, all 200 lookup targets on every wide table, actual populated
references, exact record counts, retained journal edits and source security
changes. Its client parses complete table objects incrementally, avoiding one
multi-gigabyte response string. The complete API still returns every table body.

This round reproduced excessive metadata derivation on a wide FetchXML page:
6,200 derivations for 25 rows and 80 selected columns. Request-scoped metadata
reuse reduces the regression's count to at most two, and a subsequent request
still observes changed labels. Target-field derivation also reuses one target
per call. A separate single-record regression observed 1,017 derivations for a
200-field record; synchronous single-record projection now shares the same
request-scoped reuse and observes changes on the next request.
Bulk ordinary-data copies avoid the native serialization buffer while
preserving aliases, cycles and structured-clone fallback behavior. Owned preset
seeding avoids copying rows whose defaults are already satisfied. Bounded flat
record encoding retains checkpoint bytes, digests and chunk limits. Complete
metadata encoding admits one table at a time and stops on disconnect; table
rights are evaluated in the security read, which is released before bodies are
compiled, encoded and sent. Custom complete-value writers retain cooperative
eager preparation. Compiled table bodies are weakly cached and the 16 most
recent are held strongly.
The bulk copier also covers Solution refresh, dataset merging, configuration
presets and simulation persistence. Offline data commands adopt their own
detached output instead of making unused complete input/result copies; their
file locks and digest checks remain in place.

The four-start small complex fixture passes. This does not qualify the larger
workloads. Early 10-million-record attempts exhausted a 32 GiB heap or used
31–50 GiB of process memory and several minutes before readiness. Those are
failed resource outcomes for a 16 GiB laptop. Increasing the heap does not
qualify that workload. The requested 100-million-record escalation remains
conditional on resolving and qualifying the 10-million-record case.

The subsequent constrained controls use four logical CPUs on the workstation,
a 4 GiB heap for the 20,000-record metadata control, and a 6 GiB heap for the
larger runs. This constrains resources; it does not emulate a mobile i5 or test
an actual 16 GiB machine. Filesystem warmth is uncontrolled. The metadata
controls include profiling and explicit collection at startup phase boundaries.

| Same 2,000-table / 20,000-record control | Startup seconds | Retained heap GiB after API reads | Peak process RSS GiB |
| ---------------------------------------- | --------------: | --------------------------------: | -------------------: |
| Initial profile                          |            94.5 |                              3.09 |                 4.36 |
| Streaming cache, before segmented parse  |           116.6 |                              2.69 |                 4.15 |
| Segmented parse and source copy fixes    |            52.6 |                              1.69 |                 4.00 |
| File-local immutable text reuse          |            50.4 |                              1.17 |                 3.58 |

The intermediate slowdown is retained here: reducing allocation alone did not
improve startup. The final two controls scan string segments rather than
allocating a string node for every character. Source cache reading and writing
avoid one complete cache JSON string. Equal immutable XML can share storage;
mutable result objects, source baselines and record edits stay independent.

An unchanged start with the full complex 2,000-table / 1,000,000-record dataset
completed its browser and complete-catalogue audit with a 6 GiB heap and four
logical CPUs: 53.4 seconds to startup, 3,515 ms to a ready grid, 411 ms for search,
996 ms to a ready record, and 5.03 GiB peak server RSS. All 2,000 table bodies,
16,000 forms, 8,000 views and field/relationship assertions were retained. The
4,072,510,195-byte complete response took 121.4 seconds; the worst concurrent
status response was 555 ms. Parent client peak RSS was 373 MiB. Server RSS
excludes the browser and client. This is one unchanged-start receipt, not a
four-start qualification or evidence for 10 or 100 million records.

That audit first failed its one-second status deadline. A table-body operation
was rebuilding root resource provenance and reopening every script for each
table. Root references are now computed once; a regression changes 32 unrelated
script opens to zero and compares every table with the eager contract. The
earlier failed and interrupted audit runs do not count as passes.

Additional fixes make unpublished startup composition own its graph instead
of retaining rollback clones, with deferred atomic persistence and discard on
failure; published transactions retain their established isolation. Lazy
index construction avoids normalizing every column/control. Asset traversal
has a separate bounded budget, so thousands of FormXml files no longer exhaust
the actual client-resource budget and remove scripts/PCF from the application.
Checkpoint restore reuses recurring text through bounded, load-local pools;
mutable rows, exact file hashes, journal checksums and recovery remain intact.

The earlier one-million-record timings above must not be presented as evidence
for the larger cases. Constrained 10-million-record restarts first exhausted the
6 GiB heap during source import and then during standard-module initialization.
The latter returned an unused complete-state snapshot from a nested transaction.
Private initialization now skips that copy, journals changed sections/tables,
and reuses a durable comparison receipt across consecutive startup stages.
Regressions retain public detached returns, intervening edits, rollback/discard,
external-file conflicts, reset baselines, checksums and recovery.

A subsequent four-CPU / 6 GiB-heap unchanged restart reached the listener in
269.4 seconds at 6,162 MiB server peak RSS. Scripts, PCF editing and saved-view
queries proceeded, but the complete metadata export failed its unchanged
one-second status deadline (1,010 ms at 22 completed tables). This is a failed
qualification. Sampled server/browser/client working sets summed to roughly
6.2 GiB near the failure; the Windows sum can count shared pages more than once
and sampling does not establish the instantaneous peak or mobile-i5 performance.

Large complete metadata responses compile in a metadata worker thread, which
stays warm for 30 seconds after a response, and transfer one encoded table at a
time. A negotiated gzip body is one gzip stream compressed off the event loop;
identity encoding remains available. Byte comparisons cover the complete metadata, source references,
numeric precision and field permissions, including compact provenance. Errors
and disconnects terminate the worker; the serialized read covers only the
catalogue snapshot and table rights. These
changes passed a 200-table / 20,000-row fresh browser audit (409,708,979 decoded
response bytes in 10.6 seconds). Further regressions reduced a 257-field table's
capability metadata derivations from 258 to two, and removed 102,800 unrelated
label reads while inferring phonetic lookup names for 200 distinct targets.
Subsequent calls still observe edited metadata and field security.

Allocation profiling then identified redundant formula/calculated descriptor
scans, relationship copies in the lightweight index, fixed status report bodies,
and complete privilege-map copies used only to report a count. These reads now
avoid those allocations without omitting their reported fields or capabilities.
Unique row-index positions use scalars; duplicate positions retain ordered lists.
The administration summary counts permitted rows without building a visible-row
array. Public snapshots and dynamic adapter capabilities remain fresh.

Cold 10-million-record runs also exposed independent generation and persistence
copies. The invented generator now builds flat scalar strings, retaining the
same values and schema; a separate one-million-record comparison retained the
same SHA-256 while reducing retained heap from 379 to 280 MiB. This is a fixture
allocation improvement, not a claim about arbitrary consumer generators. Explicit
`createOwned()` factories can transfer a newly generated private graph instead
of retaining a memoized preview and cloning its entire dataset. Existing `load()`
factories retain their established copying and memoization. Startup application
uses unpublished initialization and journals its changes; ordinary published
transactions keep rollback and detached-return semantics. Large journal replay
promotes its bounded entry buffer into a private candidate, verifies the commit
checksum before publication, and discards incomplete tails. Tests cover complete,
corrupt and interrupted transactions and large fragmented entries.

After these fixes, an instrumented unchanged restart completed all 2,000 tables
and 10,000,000 actual rows with four logical CPUs and a 6 GiB heap: 153.0 seconds
to startup, 4,600 ms to a ready grid, 159 ms search, 904 ms to a ready record,
114.0 seconds for the 4,072,510,195-byte complete response, 444 ms worst concurrent
status response, and 6.56 GiB peak server RSS. Allocation sampling was enabled
after startup; this is a diagnostic receipt, not the complete qualification.
A subsequent non-instrumented fresh run completed initialization in 186.4 seconds,
a ready grid in 1,974 ms, search in 158 ms and record opening in 902 ms. Its complete
metadata response took 105.4 seconds, worst concurrent status response was 58 ms,
and peak server RSS was 6.15 GiB. Private complete-response field-rights projections
reuse immutable boolean combinations; independently mutable public results and
fresh authorization remain intact. The subsequent non-instrumented audit completed all four starts below the
unchanged one-second heartbeat deadline and 8 GiB server RSS budget. Each full
metadata response retains 4,072,510,195 decoded bytes. Subsequent starts generate
no preset rows; journal replay and source change retain the local edits.

| Complex 2,000 tables / 10,000,000 records | Initialization seconds | Ready grid ms | Search ms | Record ms | Worst status ms | Server peak RSS GiB |
| ----------------------------------------- | ---------------------: | ------------: | --------: | --------: | --------------: | ------------------: |
| fresh                                     |                  186.4 |          1974 |       158 |       902 |              58 |                6.15 |
| unchanged                                 |                  156.9 |          3492 |       304 |      1647 |             336 |                6.53 |
| journal-grown                             |                  157.3 |          4570 |       160 |      1947 |             341 |                6.01 |
| source-changed                            |                  171.9 |          4557 |       168 |       908 |             361 |                5.98 |

These preceding passes do not establish repeatable qualification. The final
fresh repeat failed its one-second status deadline at table 473 (1,014 ms), with
a 1,138 ms event-loop pause and 6.61 GiB peak server RSS. The 10-million-record
case therefore remains unqualified. Whole-process startup is now measured
separately, but changing the timer did not alter the responsiveness assertion.
The process-tree working-set samples during the prior last three phases peaked
around 7.0 GiB; Windows shared-page accounting and sampling prevent treating this
as an instantaneous or physical-machine peak. Retained-allocation profiling
attributes about 3.2 GiB to restored records and 570 MiB to parsed source-cache
data, with roughly 4.23 GiB total live heap after collection. Bounded record
storage is the next implementation under investigation. The conditional
100-million-record audit has not started and is not qualified.

The saved-view audit also exposed a missing total-count-limit flag. The service
retains the native 5,000-record count cap and now displays `5000+`, with next-page
navigation and exact smaller filtered counts tested against the real backend.
The worker still asserts the exact generated dataset size independently.

```sh
node --max-old-space-size=6144 scripts/runtime-qualification.mjs 2000 1000000 --complex
node --max-old-space-size=6144 scripts/runtime-qualification.mjs 2000 10000000 --complex
```

The qualification fails above 8,192 MiB server peak RSS by default. An explicit
`PAQVILO_QUALIFICATION_MAX_RSS_MIB` changes the diagnostic budget and is recorded
in the result; raising it does not establish laptop suitability. The 100-million
run must use the same resource assessment after the preceding workload passes.

### Paged records and the current constrained audit

Owned preset factories can now stream JSON records into checksummed immutable
pages, with bounded read caches, persistent primary-key indexes and shared private
transaction copies. Public snapshots retain their ordinary detached-array
contract; complete JSON exports stream records. Existing array-based loaders
retain their behavior. See [record storage](../mirage/docs/record-storage.md).
Offline generation and scaffolding retain existing paged tables and copy pages
for a separate output file. Success and failure regressions check reader leases,
preserved local edits and independent output restoration. Session shutdown drains
later owners after a close failure and retains owners for retry.

A 16-table / 1,000,000-record fresh control passed continuous status monitoring
through browser interaction, complete metadata and record-integrity checks on
four logical CPUs with a 2 GiB heap limit. Initialization took 5.6 seconds; ready
grid, search and record opening took 931, 611 and 917 ms. Peak server RSS was
801 MiB. This control has eight wide tables and does not qualify 2,000 tables.

The subsequent 2,000-table / 10,000,000-record fresh attempt used four logical
CPUs and a 3 GiB heap. Initialization took 101.4 seconds, or 102.6 seconds from
worker launch. The grid took 2,523 ms, search 184 ms and record opening 968 ms;
peak server RSS was 2.86 GiB. It failed the unchanged one-second status deadline
at 320 complete catalogue tables, alongside a 1,037 ms event-loop pause and a
large heap collection. This is a failed qualification, despite lower memory use.

Allocation sampling isolated excessive descriptor transitions while constructing
wide maps with different primary-key names. Dictionary storage with the ordinary
Object prototype preserves descriptors, symbols, enumeration, guarded keys and
JSON. On the same 512-table diagnostic, sampled server allocation fell from
approximately 3.9 to 2.1 GiB, with 3,722 and 5,655 status polls respectively.
Polling and elapsed time vary; these samples are diagnostic evidence. Complete
metadata and field-security assertions remain intact. Status classification also
avoids configuration copies for synchronous reads and skipped portal preparation.

The stronger monitor remains active throughout post-startup work, rather than
only catalogue streaming. The four start modes and a fresh repeat still require
qualification after these changes. The 100-million-record run has not started.
Four constrained workstation CPUs do not emulate a mobile i5; server RSS excludes
the browser and parent client. Fresh full local validation and final hosted gates
remain required.

## 232, 234 and 237. X-ray cards and ownership

The browser matrix covers 1,000 secondary API/permission contexts with eight
rendered rows per page, source-first ordering, retained disclosures and paging,
unknown columns, moved/replaced controls and clipped/shadow geometry. Selection
and source inspection do not invoke business getters or activate portal controls.

Native generic modals join a unique rendered list/subgrid, exported action and
form, and matching table. Create/edit/details, view contradictions, missing or
ambiguous exports, subgrids on the grid element itself, navigation, and stale URL
hints are covered. URL hints only veto structural evidence. Unknown ownership
retains candidates and table context rather than claiming an exact column.

Rich-text host tests include repeated editor IDs, empty/disabled fields, nested
frames, advanced-form step changes, 900 background candidates and source changes.
An observed advanced-form layout joins only a configured step definition with a
consistent table; an empty layout ID cannot choose a configured system form.
Oversized sources and scan limits remain visible without fabricating attribution.

## 238. Owned-browser timeout isolation

The real disposable Edge/CDP fault-injection regression covers tab and popup
initialization deadlines, cancellation, healthy unsaved drafts, watcher/agent
continuity, retry and shared transport loss. See the shipped
[owned-browser receipt](owned-target-timeout.md) for the executable source command,
loopback confinement and tested ownership boundary.

## 239. Rich-text postback and readiness

Both compatibility and captured-editor adapters suppress unchanged hidden-value
attribute writes and change dispatch. This prevents authored mutation observers
from feeding unchanged HTML back indefinitely. Compatibility serialization keeps
paragraphs, tables and preformatted blocks stable across repeated save/reopen,
and read-only bodies and formatting remain disabled. A controlled real-browser
blank-frame load cannot establish readiness before the replacement srcdoc loads.

Regressions exercise native-style JSON hidden controls, authored jQuery observers,
quoted/nonempty/plain/empty HTML, validation, quick views, postback, stored values,
DOMContentLoaded and editor readiness. They preserve caller error reporting.

The consumer's exact jQuery selector exception and 120-second navigation sequence
remain unverified without their authored code or a reproducer. The fixes establish
the tested feedback-loop and readiness contracts; they do not establish that
unseen consumer failure's root cause, native parity, or absence of future bugs.

## 240. Managed stylesheet capture and atomic publication

Observed GUID-addressed extensionless styles require CSS MIME verification while
retaining origin, credential, query, path and size bounds. Duplicate fetches,
media/cascade order, non-CSS responses, 404s, dependencies and origin collisions
are covered. Distinct origins colliding at one local path produce an explicit
failure instead of silently substituting bytes.

Shell refreshes stage bytes and entries before publication. Failed capture,
manifest persistence or state publication retains the previous manifest and
active bytes, including valid siblings from a failed refresh. Queued captures
remain serialized. Failed transactions remove staging and newly copied orphan
blobs; tests reopen the cache to verify durable rollback.
