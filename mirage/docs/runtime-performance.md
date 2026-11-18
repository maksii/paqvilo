# Runtime loading and responsiveness

How Mirage starts, what it reuses between restarts, how to measure startup and catalogue latency on your machine, and
which store indexes keep large writes linear. State file formats and persistence costs are in
[state storage](state-storage.md).

## Startup

- **One composition transaction.** The organization installs its registrations, security and platform extensions in one
  private transaction before its listener opens. A failed installation rolls back and closes what it installed. An
  unchanged, insert-only bootstrap writes no checkpoint.
- **Bootstrap presets.** With `--preset-mode bootstrap` (`presetMode: 'bootstrap'`) a preset applies only when the state
  file does not exist yet, so restarts keep local records. The default, `always`, reapplies it on every start.
  `status.startupPreset` reports the preset, mode and whether it applied.
- **State restore.** The portal host restores the state file once and checks its identity before adopting it.
- **Solution reuse.** A site-bound context keeps its Solution scan and schema inputs; a runtime checks file stamps,
  roots, layer order and locale before reusing them, and changed portal content invalidates the portal import.
- **Source watching.** On Windows, watching uses one recursive OS notification per distinct root, filtered to the
  watched sources and debounced until files settle; each folder above a root is also watched (without subfolders) to
  notice a replaced root. Other platforms use chokidar. The `watcher` timing below names the backend. Keep source roots
  out of folders other programs write to constantly (such as the temporary folder), or start with `--no-watch`
  (`watch: false`).

On the Power Pages host, `status.bootstrap.timings` of `GET /_sim/api/state` (also `simulator.state()`) reports source
and cache, state restore and composition, preset and organization costs, state-file size and format, and memory
snapshots. `startupMs` and `listenerMs` cover the runtime call through listener and watcher setup; the portal's
`sourceBootstrapMs` covers the earlier source and state composition. `profilePinMs`, `statePreloadMs` and
`stateRestoreMs` overlap configuration time: do not add them up.

An embedding caller can pass `onStartup({ phase, elapsedMs })` to observe phase starts and `listener-ready`; the
observer is not awaited and its errors do not fail startup. `createMirageContext({ onStartup })` also reports
`context-configuration`, Solution import and portal preparation, and bound runtimes inherit the observer. Module loading
happens before any event, so measure a cold `import('paqvilo/mirage')` separately. Startup has no built-in deadline;
supervise the process when you need one. A listening runtime does not mean the browser has loaded the application.

## Model-driven catalogue

The model-driven shell requests `/_apps/api/index` (apps, navigation, table identities), then
`/_apps/api/metadata/<logical-name>` for the selected table; forms, views, fields and relationships travel only for that
table and requested lookup or subgrid targets. The complete catalogue at `/_apps/api` streams one table at a time and is
gzip-compressed when accepted (`gzip;q=0` disables it); read it incrementally for Solutions with thousands of tables.
API-only runtimes build no catalogue.

- Grids keep the native 5,000-record count limit for saved views and FetchXML (`5000+`); paging continues past it.
- Staff grants and field security are evaluated per request and never cached across requests. Within one read, imported
  metadata is resolved once per table until a read plug-in that may write takes its rollback snapshot.
- Catalogue construction yields between tables after about 8 ms of work, so status requests stay responsive;
  disconnecting stops the remaining work.

## Measure on your machine

The probe generates invented Solutions and records, starts runtimes on loopback and never contacts a portal. Run it from
a toolkit checkout:

```sh
node scripts/runtime-performance.mjs --help        # options and exit codes
node scripts/runtime-performance.mjs               # portal host, 16/32/64 tables, 10,000 records
node scripts/runtime-performance.mjs --standalone  # the same without a portal
node scripts/runtime-performance.mjs --quick       # one 16-table, 1,000-record case
node scripts/runtime-performance.mjs --large       # 256 tables x 40 forms (10,498 XML files), 20,000 records
node scripts/runtime-performance.mjs --large --standalone
node scripts/runtime-performance.mjs --tables 64 --forms-per-table 40 --records 10000 --startup-budget 60000 --restart-budget 45000 --journal-budget 60000 --catalogue-budget 30000 --heartbeat-budget 1500 --data-budget 1500
```

Each case runs a fresh state, an unchanged restart and a restart after the journal grew. It measures startup, cold and
warm catalogue reads under concurrent status heartbeats, the first grid and record reads, state bytes and process
memory, and checks that a journal edit survives the restart.

| Option               | Default (ms) | Bounds                             |
| -------------------- | ------------ | ---------------------------------- |
| `--startup-budget`   | 30000        | a fresh start                      |
| `--restart-budget`   | 30000        | the unchanged restart              |
| `--journal-budget`   | 30000        | the restart after the journal grew |
| `--catalogue-budget` | 30000        | each catalogue response            |
| `--heartbeat-budget` | 1000         | each status heartbeat              |
| `--data-budget`      | heartbeat    | the first grid and record reads    |

`--tables` takes a comma-separated scale series; vary `--forms-per-table` with fixed records to isolate metadata growth,
and `--records` with fixed tables to isolate data growth. The default matrix aborts a request at its budget and stops at
the first miss with one line on standard error, such as `Stopped: startup exceeded declared 30000 ms budget.`, and no
report; `--large` measures every request to its end, records misses under `findings`, prints the full report and exits
nonzero when there are any. The report is JSON on standard output; progress events go to standard error. Exit codes: `0` every budget met, `1` a budget missed, `2` an
invalid invocation (the message names the option). The budgets are declared for these invented fixtures, not guarantees
for any export or machine: set them for your selected sources and target machine before comparing runs. All cases share
one process, so caches are warm after the first and peak RSS is cumulative. No API response proves the visible
application is usable: measure browser sign-in, first usable controls and refresh separately.

The ordinary test suite checks invariants, never elapsed time: a single state restore, bounded metadata payloads,
cooperative response ordering, cancellation and linear id reads when input doubles.

## Large writes and paging

The record store keeps primary-key, alternate-key and per-table revision indexes on its write path, so single-record
reads, multiple-record creates and upserts, cascades and security reads stay linear in row count; an index that cannot
prove its answer falls back to a scan. Paging behaviour you can observe:

- **Web API paging.** A page continuing from a cookie this runtime issued resumes after the previous page's last
  `$orderby` tuple and primary key, so a deleted or filtered-out cursor row skips nothing and an inserted row does not
  repeat; `@odata.nextLink` keeps its shape. Secured columns never travel in the cookie: such pages, orders over
  navigation paths, multi-select choices, untyped columns and lookups without one N:1 target resume after the cursor row
  by id, or by offset when it is gone; nested expansion cookies use the offset.
- **FetchXML paging cookies** carry the last row's order values and primary key (a null sorts first ascending). Orders
  on lookup, choice, state and status columns sort by label, which the cookie does not carry: those pages resume at
  their offset, so a cursor row deleted between pages shifts the next page by one.
- **Computed columns** (calculated and formula) evaluate lazily once per row per query.

Known cost: a table is an ordered array, so deleting k rows from a table of n rows moves up to k·n references (one
native block move per row), and a single-record Web API GET reads the table once in the response formatter.

### Write-volume gate

`node --test mirage/test-volume/write-volume.test.mjs` runs after the ordinary suite in every Mirage unit lane. It runs
CreateMultiple, UpsertMultiple by alternate key, single-record reads, paging with an insert before the cursor, cascade
deletes and a shared-record read at N = 2,500 and 2N = 5,000 rows, and asserts counted work (store scans and index
lookups, array elements visited, elements moved in place), never time: work at 2N may be at most twice the work at N
plus 1,000, and a single-record read must do the same work at both sizes.
