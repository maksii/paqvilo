# Runtime loading and responsiveness

Organization composition installs its registrations, security and platform extensions in one private transaction before publishing a listener. Seeders join that transaction, so they do not independently clone and checkpoint the entire business dataset. Failed installation rolls back its state and closes its installed resources; a failed final checkpoint also closes the composed organization. An unchanged, insert-only bootstrap does not publish a checkpoint.

Both portal and standalone hosts decide `presetMode: 'bootstrap'` from whether the state file already exists. Restarting an existing state keeps local records and does not hydrate or reapply that preset. `status.startupPreset` reports the selection and applied/kept decision. This remains separate from explicit `always` mode and manual preset application.

Model-driven catalogue field capabilities resolve imported metadata once per table and reuse the staff profile grants within that calculation. They retain record rights, field-security precedence and sharing checks. Catalogue construction and its HTTP projection yield between tables after approximately 8 ms of work, while keeping their serialized read boundary. That projection reuses its immutable metadata inputs within the read epoch. Grid and record reads can also reuse those inputs until a potentially mutating read plug-in captures its rollback snapshot; reuse stops before arbitrary plug-in code runs. Staff grants and field-security results are not cached across requests. Writes wait for the read boundary; unrelated status requests can continue. Disconnecting a consumer stops remaining catalogue work, and completed epochs release their metadata references.

`status.bootstrap.timings` reports source/cache, state restore/composition, preset and organization costs, state-file size/format, and memory snapshots. `startupMs` and `listenerMs` measure the runtime call through initial listener/watcher setup; portal `sourceBootstrapMs` separately measures its earlier source/state composition milestone. A listener is not proof that the browser has loaded its application. Optional embedded `onStartup({ phase, elapsedMs })` observes phase starts and `listener-ready`; observer exceptions do not change runtime behavior.

Run the bounded invented-data probe from the toolkit checkout:

```sh
node scripts/runtime-performance.mjs
node scripts/runtime-performance.mjs --standalone
node scripts/runtime-performance.mjs --quick
node scripts/runtime-performance.mjs --large
node scripts/runtime-performance.mjs --large --standalone
```

Each matrix covers 16/32/64 imported tables with 24 custom fields, about 10,000 generated records, and fresh-state, unchanged-state and grown-journal restarts. It measures cold/warm catalogue reads alongside concurrent status heartbeats, records cache hits/misses, state bytes and process memory, and verifies that a local journal edit survives restart. The declared startup threshold is 30,000 ms (checked after startup completes), and status requests have a 1,000 ms deadline. Embedding callers own startup cancellation; this probe does not claim a cancellation deadline for the `createSimulator` call. `--quick` uses one 16-table, 1,000-record case. The ordinary regression suite uses smaller fixtures and a wider heartbeat deadline for shared CI hosts; it separately asserts cooperative response ordering and cancellation.

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
