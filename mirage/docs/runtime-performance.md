# Runtime loading and responsiveness

How Mirage starts, what it reuses between restarts, how to measure startup and catalogue latency on your own machine, and which store indexes keep large writes linear.

## Startup

- **One composition transaction.** The organization installs its registrations, security and platform extensions in one private transaction before its listener opens. A failed installation rolls back and closes what it installed. An unchanged, insert-only bootstrap writes no checkpoint.
- **Bootstrap presets.** With `--preset-mode bootstrap` (`presetMode: 'bootstrap'`, or the catalogue's `presetMode`) a preset is applied only when the state file does not exist yet, so restarting an existing state keeps local records. The default, `always`, reapplies the preset on every start. `status.startupPreset` reports the preset, the mode and whether it was applied.
- **State restore.** The portal host restores the state file once and checks the file identity before adopting it. Journal sections that a restore discards are checksummed without rebuilding their values.
- **Solution reuse.** A site-bound context keeps its Solution scan and schema inputs. A runtime rediscovers the inventory and checks file stamps, roots, layer order and locale before reusing them; changed portal content also invalidates the portal import.
- **Source watching.** On Windows, source watching uses recursive OS notifications per distinct root, filters events to the watched sources and waits for changed files to settle, so the handle count follows path depth rather than the number of exported directories. Other platforms use chokidar. `bootstrap.timings.watcher` reports the backend in use.

`status.bootstrap.timings` reports source and cache, state restore and composition, preset and organization costs, the state-file size and format, and memory snapshots. `startupMs` and `listenerMs` measure the runtime call through listener and watcher setup; the portal's `sourceBootstrapMs` measures the earlier source and state composition. The portal's `profilePinMs`, `statePreloadMs` and `stateRestoreMs` overlap configuration time, so do not add them together. A listening runtime does not mean the browser has loaded the application.

An embedding caller can pass `onStartup({ phase, elapsedMs })` to observe phase starts and `listener-ready`. The observer is not awaited, and its errors do not fail startup. Startup has no built-in cancellation deadline; run the process under your own supervisor when you need one.

## Model-driven catalogue

The model-driven shell requests `/_apps/api/index` for apps, navigation and table identities, then `/_apps/api/metadata/<logical-name>` for the selected table. Forms, views, fields and relationships travel only for that table and for requested lookup or subgrid targets. The complete catalogue is still available at `/_apps/api`. API-only runtimes do not build a model-driven catalogue.

Every response evaluates the current staff principal and field security; staff grants and field-security results are never cached across requests. Within one read, imported metadata is resolved once per table and reused for grid and record reads until a read plug-in that may write captures its rollback snapshot. Catalogue construction yields between tables after about 8 ms of work, so status requests stay responsive while a large catalogue builds. Disconnecting the client stops the remaining work.

## Measure on your machine

Run the probe from a toolkit checkout. It generates invented Solutions and records, starts runtimes on loopback and never contacts a portal:

```sh
node scripts/runtime-performance.mjs               # portal host, 16/32/64 tables, about 10,000 records
node scripts/runtime-performance.mjs --standalone  # the same without a portal
node scripts/runtime-performance.mjs --quick       # one 16-table, 1,000-record case
node scripts/runtime-performance.mjs --large       # 256 tables x 40 forms (10,498 XML files), 20,000 records
node scripts/runtime-performance.mjs --large --standalone
node scripts/runtime-performance.mjs --tables 64 --forms-per-table 40 --records 10000 --startup-budget 60000 --restart-budget 45000 --journal-budget 60000 --catalogue-budget 30000 --heartbeat-budget 1500 --data-budget 1500
```

Each case runs a fresh state, an unchanged restart and a restart after the journal grew. It measures startup, cold and warm catalogue reads with concurrent status heartbeats, the first grid and record reads, state bytes and process memory, and checks that a local journal edit survives the restart. Budgets: 30,000 ms per startup and per catalogue response, 1,000 ms per status heartbeat and first grid or record read. The default matrix stops at the first missed budget; `--large` records misses under `findings`, prints the full report and exits nonzero when there are any. All starts share one process, so filesystem and module caches are warm after the first.

These defaults are declared budgets for invented fixtures, not universal export or hardware guarantees. Set the budgets for the complete selected sources and the intended machine before comparing runs. `--tables` accepts a comma-separated scale series; vary `--forms-per-table` with fixed records to isolate metadata growth, then vary `--records` with fixed tables/forms to isolate data growth. The report names Node, architecture, CPU count and memory, separates the first status response from catalogue heartbeats, and records event-loop delay, RSS snapshots and process peak RSS. Peak RSS is cumulative for the same process, rather than an isolated peak for each phase. No API response establishes that a visible application is usable: measure browser sign-in, first usable controls and refresh separately.

The ordinary test suite uses smaller fixtures and checks invariants instead of elapsed time: a single state restore, bounded metadata payloads, cooperative response ordering, cancellation, bounded metadata inventories per read, detached composition ownership and linear ID reads when input doubles. Unchanged composition omits checkpoint writes; isolated composition uses its committed graph as the rollback copy while keeping a separate working graph.

## Limits

- Large Solutions are memory-heavy. On the `--large` fixture, process RSS reaches roughly 1–2.5 GB, and startup takes several seconds.
- Full checkpoints serialize the runtime state. Journaled row transactions append row changes and changed sections; broad transactions can still require whole-state comparison and serialization. Unchanged startup composition writes neither a checkpoint nor a journal entry.
- Runtime CreateMultiple and UpsertMultiple cost a few milliseconds per row, mostly in the rollup module's write hooks, which read every table's field definitions on each write.
- Single-record Web API GET reads the table's rows once in the response formatter (for the ETag and lookup names): O(rows), without copying them.

## Write-volume seams

The record store keeps these indexes and caches on its write path. Each is derived from
the row operations (`insertRow`, `writeRow`, `mutateRow`, `removeRow`) or from commits, and
each falls back to a scan when it cannot prove its answer.

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
  every `$orderby` column, then the primary key. The next page resumes after that saved tuple with the
  full sort's order and a bounded heap, without sorting the rest of the result, so a cursor row that was
  deleted, or updated out of the filter, between pages skips nothing, and a row inserted before the
  cursor does not repeat. The `@odata.nextLink` shape is unchanged. A secured column's values never
  travel in the cookie; such a page, an order over a navigation path, a multi-select choice, an untyped
  column or a lookup without one N:1 target resumes after the cursor row by id, and uses the offset when
  that row is gone. A nested expansion cookie uses the offset.
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
  committed nothing since. Like the journal itself, this relies on sections changing only inside store
  transactions.
- **Security seeding.** Seeding builds temporary ID indexes for existing security rows and user-role
  pairs inside each seed transaction, so its cost stays linear in the number of rows.
- **Grid rows.** Model-driven row capabilities find the row through the primary-key index, and lookup
  display names build one id map per target table and page.
- **Service protection.** Expired admissions leave the 300-second window as a prefix, without a
  filter per request.

### Write-volume gate

`mirage/test-volume/write-volume.test.mjs` is not part of the ordinary suite. Run it explicitly:

```sh
node --test mirage/test-volume/write-volume.test.mjs
```

It runs each scenario on fresh fixtures at N = 2,500 and 2N = 5,000 rows and asserts the ratio between
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
