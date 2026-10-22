# Runtime loading and responsiveness

Organization composition installs its registrations, security and platform extensions in one private transaction before publishing a listener. Seeders join that transaction, so they do not independently clone and checkpoint the entire business dataset. Failed installation rolls back its state and closes its installed resources; a failed final checkpoint also closes the composed organization. An unchanged, insert-only bootstrap does not publish a checkpoint.

Both portal and standalone hosts decide `presetMode: 'bootstrap'` from whether the state file already exists. Restarting an existing state keeps local records and does not hydrate or reapply that preset. `status.startupPreset` reports the selection and applied/kept decision. This remains separate from explicit `always` mode and manual preset application.

Portal startup without a simulation storage adapter restores the state once, reads its profile pin from that restored graph, and hands the verified storage identity to the store. It rechecks file identity before adopting the graph. `profilePinMs` includes the early read; `statePreloadMs` records the full restore performed there, and `stateRestoreMs` includes that cost plus store initialization. These timings overlap configuration time and must not be added together. Simulation adapters retain their recovery/publication boundary; section-only journal reads checksum discarded fragmented sections without reconstructing their values.

Site-bound contexts retain immutable Solution scan/schema inputs. A runtime rediscovers the complete inventory and checks file stamps, roots, layer order and locale before reusing them; changed portal content also invalidates the bound portal import. Replacement keeps the old graph as rollback input and adopts private detached composition results. Presets avoid copying sections they replace, keep organization-owned rows, and omit the unused full admin-state response during startup. Default public replacement/preset results remain detached.

Security seeding builds temporary ID indexes for existing security rows and user-role pairs inside each seed transaction. It keeps the first matching case-insensitive ID and insert-only grants, including edited depths. The indexes expire on success and failure; extension-added tables are resolved against fresh inputs. Environment-variable source seeding likewise indexes its existing rows once.

On Windows, source watching uses recursive OS notifications per distinct watched directory root, coalesces overlapping/case-equivalent roots, filters events to the requested sources, and waits for changed files to stabilize. Shared nonrecursive ancestor watchers reattach roots when an export or containing directory is replaced; handle count follows source path depth rather than exported directory count. Other platforms and unsupported/missing native roots retain chokidar. Both hosts wait for watcher readiness and close their own handles. `bootstrap.timings.watcher` reports the backend and native handle or chokidar directory count.

The model-driven shell requests `/_apps/api/index` for application/navigation and table identities, followed by `/_apps/api/metadata/<logical-name>` for the selected table. Forms, views, fields and relationships travel only for that table and explicitly requested lookup/subgrid targets. The complete legacy catalogue remains available at `/_apps/api`. Every response evaluates the current staff principal and field security; response bodies are not reused between callers. API-only startup does not construct an unused model-driven catalogue.

Model-driven catalogue field capabilities resolve imported metadata once per table and reuse the staff profile grants within that calculation. They retain record rights, field-security precedence and sharing checks. Catalogue construction and its HTTP projection yield between tables after approximately 8 ms of work, while keeping their serialized read boundary. That projection reuses its immutable metadata inputs within the read epoch. Grid and record reads can also reuse those inputs until a potentially mutating read plug-in captures its rollback snapshot; reuse stops before arbitrary plug-in code runs. Staff grants and field-security results are not cached across requests. Writes wait for the read boundary; unrelated status requests can continue. Disconnecting a consumer stops remaining catalogue work, and completed epochs release their metadata references.

`status.bootstrap.timings` reports source/cache, state restore/composition, preset and organization costs, state-file size/format, and memory snapshots. `startupMs` and `listenerMs` measure the runtime call through initial listener/watcher setup; portal `sourceBootstrapMs` separately measures its earlier source/state composition milestone. A listener is not proof that the browser has loaded its application. Optional embedded `onStartup({ phase, elapsedMs })` observes phase starts and `listener-ready`; synchronous exceptions and rejected promises/thenables do not fail startup. Observer results are not awaited, so a pending observer cannot block listener readiness.

Run the bounded invented-data probe from the toolkit checkout:

```sh
node scripts/runtime-performance.mjs
node scripts/runtime-performance.mjs --standalone
node scripts/runtime-performance.mjs --quick
node scripts/runtime-performance.mjs --large
node scripts/runtime-performance.mjs --large --standalone
```

Each matrix covers 16/32/64 imported tables with 24 custom fields, about 10,000 generated records, and fresh-state, unchanged-state and grown-journal restarts. It measures cold/warm catalogue reads alongside concurrent status heartbeats, records cache hits/misses, state bytes and process memory, and verifies that a local journal edit survives restart. The declared startup threshold is 30,000 ms (checked after startup completes), and status requests have a 1,000 ms deadline. Embedding callers own startup cancellation; this probe does not claim a cancellation deadline for the `createSimulator` call. `--quick` uses one 16-table, 1,000-record case. The ordinary regression suite uses smaller fixtures and a wider heartbeat deadline for shared CI hosts; it separately asserts cooperative response ordering and cancellation.

Reports also include navigation-index/selected-table transferred bytes and explicit JSON parse time for first/repeat transport reads after catalogue construction, plus Node/OS/CPU/memory context. Matrix starts share one process; filesystem warmth is uncontrolled. The first/repeat labels do not claim separate cold-process samples. Portable regressions enforce single-restore/parse-reuse invariants, bounded metadata payloads and linear security ID-read counts on input doubling. Historical elapsed samples below remain observations of their stated implementations and hardware, not hardware-independent budgets for the current changes.

`--large` is an optional source-volume investigation, excluded from default CI and the default matrix. It imports **256 tables × 24 fields × 40 distinct full forms**, totaling **10,498 XML files**, and exactly **20,000 business records**. The portal mode also imports the small invented portal; standalone mode selects the same complete Solution inputs. No forms, roots or records are removed to meet a target. Every successful catalogue is checked for all 40 forms on every table, every startup is checked for the exact record count, and bootstrap presets/local journal edits are checked across restarts. The report distinguishes fixture generation time and source bytes/file counts from the runtime's discovery/import/startup costs.

The large-mode budgets are **30,000 ms for every startup/restart**, 30,000 ms per catalogue response, and **1,000 ms per status heartbeat and first grid/record response**. Large mode continues recording timing misses and request timeouts in `findings`, prints the complete report after cleanup, and exits nonzero when findings exist. Functional loss of required inputs still fails the probe. As with the default probe, startup elapsed budgets are post-completion checks; run the process under a separately bounded supervisor when cancellation guarantees are needed. The 64-table results below do not establish large-source startup performance.

The initial source inspection identified distinct scaling costs for the large-mode investigation: directory discovery and per-file stat checks despite a warm parse cache; both schema and form-parser entries for form files; rebuilding metadata/schema and field projections from cached inputs; repeated source-component row searches; catalogue compilation and per-table form filtering; and repeated field-capability metadata-overlay checks. The final changes below address the repeated searches and metadata checks. These observations do not establish which path explains the consumer's private launch. Do not infer whole-startup savings from cache-hit counts alone.

An earlier sequential Windows measurement on 2026-10-20 compared the prior organization/catalogue implementations with the first performance changes on the same 64-table source and **identical persisted checkpoint bytes**, with a warm filesystem/source cache. This preceded the final read-epoch and source-volume improvements:

| Measurement | Before | After |
| --- | ---: | ---: |
| Standalone restart to listener | 5,250 ms | 1,718 ms |
| Organization composition | 4,349 ms | 888 ms |
| First catalogue | 1,800 ms | 77 ms |
| Warm catalogue | 1,652 ms | 71 ms |
| Maximum concurrent status, first catalogue | 1,779 ms | 21 ms |
| Maximum concurrent status, warm catalogue | 1,627 ms | 28 ms |

Catalogue bytes (3,182,047) and row counts were identical. The full new-implementation portal matrix measured startup 835–1,895 ms, catalogue 37–122 ms and status at most 54 ms. The standalone matrix measured startup 937–1,567 ms, catalogue 39–99 ms and status at most 45 ms. Bootstrap preset bodies were generated once on fresh state and zero times on either restart. These are synthetic single-host samples, not reproductions of the consumer's private organization, guarantees for arbitrary export sizes, or proof of browser page readiness. The process memory snapshots include accumulated VM caches/GC history across sequential runs; they are not isolated peak-memory measurements. Private receipts remain under ignored `.paqvilo/`.

The subsequent 10,498-XML-file portal probe exposed an additional real miss: its first catalogue took 10,547 ms and a concurrent status request timed out at 1,177 ms. Warm catalogue work still took 8,963 ms. CPU profiling attributed most sampled CPU time to repeated metadata row stamps and deep comparisons; cache hits did not remove that work. The final changes reuse metadata within a consistent read epoch, construct catalogues cooperatively, index source component rows and avoid discarded composition snapshots.

The final portal and standalone runs retained all **10,240 forms and 20,000 records**, including the local journal edit, and measured:

| Surface and phase | Startup | Cold catalogue | Warm catalogue | Maximum concurrent status | First populated 50-row grid / record |
| --- | ---: | ---: | ---: | ---: | ---: |
| Portal fresh | 10,810 ms | 2,178 ms | 794 ms | 409 ms | 141 / 26 ms |
| Portal unchanged | 9,931 ms | 2,164 ms | 847 ms | 407 ms | 133 / 27 ms |
| Portal grown journal | 9,702 ms | 2,221 ms | 818 ms | 410 ms | 130 / 26 ms |
| Standalone fresh | 10,243 ms | 888 ms | 802 ms | 416 ms | 146 / 21 ms |
| Standalone unchanged | 10,476 ms | 835 ms | 765 ms | 401 ms | 144 / 21 ms |
| Standalone grown journal | 9,897 ms | 815 ms | 749 ms | 391 ms | 129 / 20 ms |

The final portal receipt was collected under the initial wider startup investigation thresholds (120 s fresh / 90 s restart); its actual elapsed measurements were subsequently independently checked against the tightened **30 s** target, and each passed. The standalone receipt declared 30 s before execution. Both final runs had zero status/request findings at the original **1 s** heartbeat target. Warm Solution imports had 20,738 parser-cache hits and zero misses; forms have both schema and form-parser entries. Preset body generation was again 1/0/0 across fresh/unchanged/grown phases. Portal source input was 19,005,007 bytes, with a 61,031,963-byte initial checkpoint. The portal before/after source-volume runs used identical generated XML/data recipes, independently created fresh state, and different temporary directories; they are not the identical-checkpoint comparison above.

Final post-request RSS snapshots ranged from approximately 1.2 to 2.5 GB across these sequential stress runs, so memory consumption remains material. These snapshots include native buffers, allocator retention and GC history and do not prove a peak-memory bound. The fixtures establish bounded behavior for this declared source volume and preserve input completeness; the private consumer's exact export/persona and browser-ready latency remain unmeasured.

The independent feedback audit repeated both complete large-mode matrices after
the follow-up fixes. Every run again retained 10,498 XML files, 10,240 forms and
20,000 records, preserved the journal edit, generated preset bodies only on fresh
state, and returned no timing/request findings at the declared 30 s startup and
1 s heartbeat/data-read budgets:

| Surface and phase | Startup | Cold / warm catalogue | Maximum status | First grid / record |
| --- | ---: | ---: | ---: | ---: |
| Portal fresh | 11,210 ms | 2,215 / 808 ms | 415 ms | 150 / 28 ms |
| Portal unchanged | 10,158 ms | 2,318 / 849 ms | 402 ms | 154 / 28 ms |
| Portal grown journal | 9,245 ms | 2,270 / 783 ms | 427 ms | 134 / 28 ms |
| Standalone fresh | 10,083 ms | 902 / 813 ms | 421 ms | 158 / 21 ms |
| Standalone unchanged | 10,572 ms | 832 / 851 ms | 418 ms | 170 / 24 ms |
| Standalone grown journal | 10,370 ms | 799 / 752 ms | 387 ms | 126 / 19 ms |

These are further sequential single-host samples, not tighter guarantees. RSS
snapshots again reached about 2.6 GB; the memory and embedded-cancellation limits
above still apply. The separate Power Pages PCF preload is not part of the
model-driven client catalogue's aggregate import budget; see
[client source selection](model-driven-customizations.md).

## 2026-10-21 feedback follow-up

The follow-up also indexes source form/view presence and row overlays. The complete
10,498-file fixture exposed these remaining quadratic scans: its first full-catalogue
request delayed status for about three seconds before indexing. An ID-read-count
regression now guards input doubling for both security seeding and form/view overlays.

Sequential reruns on Windows x64, Node 24.13.1, 20 logical CPUs and approximately
95 GiB RAM retained all 10,240 forms, 20,000 records and the grown-journal local edit:

| Surface / state | Runtime ready | First / repeat full catalogue | Maximum status heartbeat |
| --- | ---: | ---: | ---: |
| Standalone fresh | 4,379 ms | 1,864 / 803 ms | 400 ms |
| Standalone unchanged | 3,470 ms | 1,789 / 773 ms | 411 ms |
| Standalone grown journal | 3,507 ms | 1,795 / 754 ms | 394 ms |
| Portal fresh | 5,264 ms | 1,878 / 808 ms | 426 ms |
| Portal unchanged | 2,689 ms | 1,802 / 802 ms | 403 ms |
| Portal grown journal | 2,731 ms | 1,814 / 756 ms | 404 ms |

Both runs completed without declared budget findings. The shell index was 164,724
bytes standalone and 177,141 bytes with the portal; the selected table, including
all 40 of its forms, was 329,833 bytes on both. First/repeat index reads took 20–35 ms
and selected-table reads 14–20 ms **after catalogue construction**. These transport
measurements are not cold browser page-ready clocks. Starts within each run share
one process and warm filesystem/module caches; these samples do not reproduce the
consumer's ARM64 datasets or establish p95/cold-process performance. No source
inputs or records were removed. Receipts remain in ignored `.paqvilo/`.

## Write-volume seams

The record store keeps these indexes and caches on its write path. Each is derived from
the row operations (`insertRow`, `writeRow`, `mutateRow`, `removeRow`) or from commits, and
each falls back to the previous scan when it cannot prove its answer.

- **Row indexes.** `rowKeyIndex(rows, name, keyOf)` caches the positions of a row array by a
  derived key. The row operations update every cached index of the array; a removal shifts the
  later positions instead of discarding the index. The primary-key index checks that the row at a
  cached position still carries the key, and rebuilds once if it does not, so an edit made outside
  the row operations cannot return a wrong row. Duplicate primary-key checks, alternate-key
  uniqueness and alternate-key lookups (`findByKey`) use indexes that live for one transaction, so a
  direct edit between transactions is never missed. Alternate-key lookups keep `valuesEqual`
  semantics: only plain non-date strings are bucketed, and other values stay in a list that every
  lookup scans. CreateMultiple, UpsertMultiple by key and imports cost O(1) per row within one request.
- **Reads by id.** Single-record and id-list reads find their rows through the primary-key index
  before the row-security filter, instead of filtering the whole table. Row filters receive the
  stored row without a copy; the security read filter only reads it, and a backend profile
  predicate copies the row itself.
- **Relationship graph.** One delete operation memoises `referencesTo(table)` and the many-to-many
  intersect list for its whole cascade, so a cascade tree walks the mappings once per table instead
  of once per deleted row. The memo lasts one operation because mappings have no revision counter.
- **Per-table revisions.** `store.tablesRevision(tables)` changes when a commit may have changed one
  of the named tables. An incremental row transaction names the tables it wrote (and, defensively, any
  table whose row count changed); every other commit advances all tables. The security index rebuilds
  its principals, roles and privileges only when those tables change, and its shares only when
  `principalobjectaccess` changes. GrantAccess, ModifyAccess and RevokeAccess are journaled row writes.
- **Key-set paging.** A Web API collection page that continues from a cookie this runtime issued
  resumes after the previous page's last row. The paging cookie carries the last and first values of
  every `$orderby` column, then the primary key (Learn page-results: the cookie holds data about the
  first and last record). The next page resumes after that saved tuple with the full sort's order and a
  bounded heap, without sorting the rest of the result, so a cursor row that was deleted, or updated out
  of the filter, between pages skips nothing, and a row inserted before the cursor does not repeat. The
  `@odata.nextLink` shape is unchanged. A secured column's values never travel in the cookie; such a
  page, an order over a navigation path, a multi-select choice, an untyped column or a lookup without
  one N:1 target resumes after the cursor row by id, and uses the offset when that row is gone. A nested
  expansion cookie uses the offset.
- **FetchXML paging cookies.** A FetchXML paging cookie carries the last row's order values and
  primary key, so the next page resumes after that tuple (key-set paging) and a cursor row deleted
  between pages skips nothing. A null order value travels as an empty `last` value, the marker the OData
  skip token uses, and resumes nulls first ascending. Orders on lookup, choice, state and status columns
  sort by name or label, which the cookie does not carry: such a page resumes at its page offset, so a
  cursor row deleted between pages shifts the next page by one row.
- **Computed columns in queries.** Calculated and formula columns register with the store
  (`store.setComputedColumns`). Every query engine reads rows of a table with computed columns as read
  copies whose computed columns compute lazily, once per row per query, so `$filter`, `$orderby`,
  `$apply`, FetchXML conditions, orders and aggregates, the property route and every row projection see
  the computed value. A table without computed columns is read as stored, with no copy.
- **SDK savepoints.** A plug-in SDK call journals its own row writes in a nested row transaction
  instead of copying the whole state first. If a handler that may write arbitrary state runs inside the
  call, the savepoint is promoted to the full copy, as every write is. An independent PreValidation
  commit still copies the state once to advance the caller's rollback point.
- **Section copies.** A journaled commit already compares every non-table section with the copy its
  row transaction took. When that copy is equal, the next row transaction reuses it if the store has
  committed nothing since. Mappings are nearly all of those bytes. Like the journal itself, this relies
  on sections changing only inside store transactions.
- **Grid rows.** Model-driven row capabilities find the row through the primary-key index, and lookup
  display names build one id map per target table and page.
- **Service protection.** Expired admissions leave the 300-second window as a prefix, without a
  filter per request. A user whose clock moved backwards keeps the filter.

Single-record Web API GET still reads each table's rows once per request in the response formatter
(`webapi-format.mjs` `storedRow`, for the ETag and lookup names). This step is O(rows) without copying
them.

### Measurements

These are sequential scratch measurements on Windows x64 with Node 24.13.1, on the same host before
and after the change. "Handler" runs the Web API record handlers in process with the standard tables
seeded (3,746 relationships) and no extensions. "Runtime" is a complete local organization over HTTP.
"Old" switches the seam back in the same process. They are observations, not budgets.

| Seam | Scenario | Before | After |
| --- | --- | ---: | ---: |
| Row indexes | Handler CreateMultiple, 2,500 / 5,000 rows | 1,052 / 3,744 ms | 151 / 278 ms |
| Row indexes | Handler UpsertMultiple by alternate key, 2,500 / 5,000 rows | 1,922 / 7,289 ms | 147 / 268 ms |
| Reads by id | Handler: 500 single-record GETs over 5,000 rows | 6,039 ms | 776 ms |
| Reads by id | Runtime: 200 single-record GETs over 1,000 / 2,000 rows | 956 / 1,504 ms | 497 / 555 ms |
| Relationship graph | Handler: cascade delete of 1,000 children (5,000 parents) | 468 ms | 45 ms |
| Relationship graph | Handler: cascade delete of 2,000 children (10,000 parents) | 3,014 ms | 80 ms |
| Relationship graph | Runtime: cascade delete of 200 / 400 children | 422 / 349 ms | 77 / 90 ms |
| Key-set paging | Handler: 5,000 rows, 500 per page, one insert before the cursor | 288 ms, 5,001 rows, one repeated | 165 ms, 5,000 distinct rows |
| Key-set paging | Handler: the same with 10,000 rows | 592 ms | 482 ms |
| Security index | 300 × (row write + authorize), 2,000 users, 20,000 shares (old: rebuild per commit) | 3,519 ms | 2,361 ms |
| SDK savepoints | 100 creates, each with 10 joined SDK creates, 20,000 rows (old: two full copies per call) | 32,419 ms | 12,164 ms |
| Section copies | Runtime: 300 single-record PATCHes, journaled state | 6,605 ms | 4,681 ms |
| Dirty-set hashing | Simulation: 50 runtime-table writes, 20,000 rows elsewhere (old: hash every table) | 15,205 ms | 12,291 ms |
| Grid rows | 250 row capabilities over 20,000 rows (old: linear find) | 87 ms | 8 ms |
| Service protection | 20,000 admissions inside one window (old: filter per request) | 3,462 ms | 117 ms |

The runtime CreateMultiple and UpsertMultiple costs stayed about 5 ms per row. That cost scales
linearly, and most of it is the rollup module's write hooks, which read the field definitions of every
table on each write (`dataverse-rollup.mjs` `rollupsSourcedFrom`). The simulation write still serializes
the complete runtime file on each transaction.

### Write-volume gate

`mirage/test-volume/write-volume.test.mjs` is not part of the ordinary suite. Run it explicitly:

```sh
node --test mirage/test-volume/write-volume.test.mjs
```

It runs each scenario on fresh fixtures at N = 2,500 and 2N = 5,000 rows. It asserts the ratio between
the two times, never absolute milliseconds. Linear work stays near 2×, and a per-row table scan reaches
about 4×. The bound is 3×, or 1.6× for single-record reads, which should not grow. A scenario passes
when any of three attempts stays under its bound. The scenarios are:

- CreateMultiple.
- UpsertMultiple by alternate key.
- 2,000 single-record reads through `store.query` with the row-security filter.
- Paging through every row at 500 per page with an insert before the cursor. Every row must appear
  exactly once; the gate times the cost per page.
- A cascade delete of 1,000 and 2,000 children.
- A Basic-depth reader paging a deep share graph of 12 teams, where every second row is shared.

With the row indexes switched off, the gate failed. CreateMultiple measured 963 → 3,228 ms,
UpsertMultiple 2,258 → 9,401 ms and the single-record reads 644 → 1,217 ms.
