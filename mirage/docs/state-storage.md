# Local state storage

A Mirage runtime keeps its records, settings and simulator state in one state file (normally under `.paqvilo/`) and,
when a preset streams generated records, a paged record folder beside it. File bytes and note bodies live in a storage
provider instead; see [storage providers](storage-providers.md#routing).

## Formats

- A state below 16 MiB is plain JSON.
- At or above 16 MiB the same path holds a `mirage-state-journal-v1` checkpoint (`-v2` when it references
  [paged records](#paged-record-storage)) followed by committed row transactions. The file is self-contained: a copy
  includes the checkpoint and every committed edit. A file named `.json` may therefore hold a journal. Plain JSON and
  journal files without paged records keep their format until a preset streams records.
- `persistence: { journalThresholdBytes }` on `DataStore` or `createSimulator` changes the threshold (a non-negative
  safe integer; `0` journals every size). It is compared with the actual streamed checkpoint size.

Reads and checkpoint writes stream, so the document never has to fit in one JavaScript string or Buffer. The decoded
rows, running operations and requested snapshots must still fit in memory, and one scalar string is still subject to the
engine's string limit.

## Read and change state

```js
import { DataStore, readStateFile } from 'paqvilo/mirage';
const state = await readStateFile('./.paqvilo/state.json');
const simulator = await readStateFile('./.paqvilo/state.json', { sections: ['simulator'] });
const store = await new DataStore({ file: './.paqvilo/state.json' }).init();
await store.update('x_item', 'record-id', { x_name: 'Updated' }, { admin: true });
await store.compact(); // optional, during an idle period
```

- The fourth `update` argument is the identity: without `{ admin: true }` the portal table permissions of an anonymous
  visitor apply and the write can fail with 403 `PermissionDenied`.
- `readStateFile` (also exported by `paqvilo/mirage/fixtures`) reads both formats. Never `JSON.parse` a state file
  yourself. A `sections` projection does not keep unselected rows, but integrity verification still reads and checksums
  every journal byte.
- `snapshot()` copies what it returns; select sections or tables when a complete copy is not needed. Use the streamed
  administration state export for a complete JSON file.
- For optimistic replacement, take `store.snapshotDigest()` and pass it as `replaceState(next, { expectedDigest })`
  (`expectedSnapshot` is still accepted). A stale digest fails with 409 `StateConflict` and applies nothing.
- To change a running runtime, use the administration API or a `DataStore` transaction in that process. Stop the runtime
  before replacing, restoring or migrating its state file.

## Write integrity

- **Checkpoints** are written to an exclusive temporary file, synced, checked for external changes and renamed into
  place. Invalid or unpersistable replacements fail before the current checkpoint is replaced.
- **Journal commits** append the row operations and a SHA-256 commit marker, then sync before the write is acknowledged.
  Restart verifies the checksums and ignores a transaction left unfinished by an interrupted write; the next locked
  commit removes that tail. A damaged committed checksum fails with `StateIntegrity`.
- **Writers** are serialized by an exclusive sibling lock. Before writing, the store compares the file identity, byte
  length and nanosecond modification time with what it loaded (plus the change time on POSIX; Windows excludes it
  because NTFS can update it on a plain read). Any difference is a `StateConflict`, even for an equal-size edit. Two
  stale runtimes never merge their in-memory state: share one runtime between browser sessions and give independent
  scenarios separate state paths.
- **Stale locks**: each lock records its owner (process, host, toolkit version). A writer killed during a checkpoint
  leaves `<state file>.lock` and possibly `<state file>.paqvilo-<token>.tmp`; the state file keeps its last committed
  content. A lock taken on this host whose owner process has ended is reclaimed, with its unpublished temporary file, at
  the next start or write and reported as a `WRITER_LOCK_RECLAIMED` warning in `/_sim/api/diagnostics`. A live owner is
  never reclaimed: writes answer 409 `StateConflict`
  (`A writer owns <state file>.lock: process <pid> on this host is still running; retry after it finishes.`). A lock
  from another host, or one without owner identity (an older toolkit's lock), is never reclaimed either; its 409 message
  names the files to delete once no runtime uses the state. Lock age plays no part.
- **Offline commands** (`mirage data generate`, `data scaffold`) refuse a state that a running Mirage uses ("Stop the
  Mirage using this state (<file>) before scaffolding data.", or the other command's operation; exit 1), and write
  through the same lock, digest and atomic-replace protocol. Temporary files and locks are removed on success or
  failure.

Known limit: the checks assume a local filesystem that reports changes. Windows cannot detect an in-place edit that
keeps the file identity and length and restores the exact modification time; the next write then overwrites it (plain
JSON) or the next reload rejects its checksum (journal). Do not edit the active state file with such tools, and keep
backups.

State, lock and record-owner files stay private under ignored `.paqvilo/`. The protocol protects local integrity; it
grants no permission to read or write a reference environment.

### What journals and what checkpoints

| Write                                                                                                           | Persistence                                          |
| --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Core CRUD, deep inserts, associations, cascades, declarative secondary effects, native form and multistep saves | journaled row transaction with undo entries          |
| A plug-in SDK call                                                                                              | its own savepoint inside the caller's journal        |
| Full state replacement, presets, arbitrary `transact` callbacks                                                 | full checkpoint                                      |
| A trusted handler or CLR step that actually executes                                                            | promotes its unit to a full rollback copy/checkpoint |
| An independent PreValidation commit                                                                             | copies the state once                                |

`compact()` queues an atomic checkpoint without cloning rows; the journal otherwise grows with changes. Journaling does
not index every query and does not remove the memory cost of a complete state export. The HTTP audit ledger records
`saveMs` and `saveMode` (`journal` or `checkpoint`) for persisted writes; embedded hosts read the same values from
`DataStore.lastSave` and `onSave(timing)`.

An incremental transaction also passes the tables it wrote to the storage adapter as `save(state, { tables })`, so the
simulation adapter rehashes only those tables to decide which pack DATA files to rewrite; a full transaction passes no
set and every table is rehashed.

## Paged record storage

An owned preset can stream generated records into paged storage through its runtime context. The schema, forms,
permissions, field security, calculated columns and record APIs still come from the selected Solution definitions.

```js
createOwned({ records }) {
  function* items() {
    for (let index = 0; index < 100000; index++) {
      yield { x_itemid: inventedId(index), x_name: `Invented ${index}` };
    }
  }
  return {
    mappings: { x_item: { idColumn: 'x_itemid', nameColumn: 'x_name' } },
    tables: { x_item: records.table(items(), { primaryKey: 'x_itemid' }) },
  };
}
```

- The input is a synchronous iterable; each yielded row is serialized independently, so a source object can be reused.
  Schema defaults and deterministic autonumbers apply before storage. `primaryKey` builds a persistent string-key index
  with the store's GUID and text comparison; other key shapes use the ordinary query path.
- Runtime table arrays behave as ordinary mutable arrays of JSON rows. Snapshots and record results are detached
  ordinary data; a complete snapshot materializes every requested record. Presets that return ordinary arrays keep their
  existing ownership and copying.
- Pages live in `<state-file>.records`; a record page holds up to 64 KiB of JSON and every read verifies its payload
  digest. The journal references immutable page files by digest, and each runtime writes its own page file.
- The state file and its `.records` folder belong together. The folder's `.record-owner.json` holds an owner key the
  journal also records, so the pair loads together after a move or restore, and another state cannot adopt the folder. A
  missing referenced page file fails start with `StateIntegrity` and leaves the state file unchanged. Back up both; the
  administration JSON export is self-contained.
- `DataStore.compact()` also rewrites live record versions and collects unreferenced files, protected by file leases of
  active readers. A folder with files but no owner marker is used unowned, reported as `unverified-directory`, and
  nothing in it is collected. Close the runtime to release its handles and leases.
- Offline `data generate` and `data scaffold` keep paged input; a separate `--out` copies referenced pages into its own
  record folder. `mergeDataset()` returns ordinary detached arrays.

## Volume check

```sh
paqvilo mirage verify-storage --json
```

It uses a disposable directory (about 2 GiB free memory and 1 GiB temporary disk) and never touches a project's state:
it saves and reloads 600,000 synthetic rows with 1 KiB payloads, checks digest and restart consistency, runs single-row
updates, Web API PATCHes against 300,000 rows, concurrent HTTP clients and a native form save with their time limits,
checks the audit `saveMode` and verifies external-conflict detection. Run it on the filesystem that holds your local
states. From a source checkout, `node --expose-gc --max-old-space-size=4096 mirage/test-volume/state-storage.mjs` runs
the same check without the time limits.
