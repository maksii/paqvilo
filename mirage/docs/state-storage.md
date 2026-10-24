# Local state storage

Mirage streams JSON state reads and checkpoint writes. The total document never needs
to fit in one JavaScript string or Buffer. As with other in-memory stores, the decoded
rows, active operations and any snapshots requested by callers must fit in available RAM;
one scalar string is still subject to the engine's string limit.

States below 16 MiB remain plain JSON. At or above that size, the same state path holds a
`mirage-state-journal-v1` checkpoint followed by committed row transactions. The file is
self-contained: copying or backing it up includes the checkpoint and every committed edit.

Use the supported reader for both formats:

```js
import { DataStore, readStateFile } from 'paqvilo/mirage';
const state = await readStateFile('./.paqvilo/state.json');
const simulator = await readStateFile('./.paqvilo/state.json', { sections: ['simulator'] });
const store = await new DataStore({ file: './.paqvilo/state.json' }).init();
await store.update('items', 'record-id', { name: 'Updated' });
await store.compact(); // schedule during an idle period, when desired
```

`readStateFile` is also exported by `paqvilo/mirage/fixtures`. Do not `JSON.parse` a state
file yourself: a large state is a journal, not JSON. Section projections avoid retaining unselected checkpoint
rows and skip reconstructing discarded fragmented values, although integrity verification
still reads and checksums every journal byte. Small JSON values use a bounded native parse;
larger documents retain streaming parsing. `snapshot()` intentionally
copies its requested data; select sections/tables when a complete copy is unnecessary.
For optimistic fixture replacement, use `store.snapshotDigest()` and
`replaceState(next, { expectedDigest })`; this hashes bounded chunks without building
an entire snapshot string. Existing `expectedSnapshot` callers remain supported.

File bytes and note bodies can live outside the state file. When a Dataverse runtime has a
storage router (see [storage providers](storage-providers.md#routing)), file entries in
`state.dataverse.files` keep a `key` instead of base64 `data`, and note and attachment rows keep an
internal `__blobkey` instead of the body. The state file format and `readStateFile` do not change:
moving bytes out of an older state is a runtime step when the runtime loads or resets. It puts the
inline bytes into the provider, rewrites the entries and rows in one `DataStore` transaction (written as a
full checkpoint), and reports one `STORAGE_MIGRATED` diagnostic
with counts. A second load finds nothing inline and changes nothing. A state migrated this way needs
the same storage root to read its bytes back; without a router those reads answer `StorageUnavailable`.

Checkpoints are written to an exclusive temporary file, synced, checked for external
changes and atomically renamed. Ordinary core CRUD, deep inserts, associations, cascades
and declarative secondary effects retain undo entries for changed rows. A successful
large-state write appends row operations and a SHA-256 commit marker, then syncs before
acknowledging the write. The persisted digest advances with the appended bytes. Restart
verifies the checksums and ignores an unfinished transaction left by an interrupted write;
the next locked commit removes that unfinished tail. A damaged committed checksum fails
with `StateIntegrity` rather than accepting altered data.

The existing exclusive sibling lock serializes writers. File identity, byte length and
nanosecond modification timestamps are checked before writing. On POSIX the change timestamp
is checked too. Windows excludes ChangeTime: NTFS can update it on an ordinary read when
last-access updates are enabled. Reads, backup copies and first-attempt restarts therefore
retain ownership without weakening inode, size or modification-time checks. The exact-byte digest
is computed at load/checkpoint and advanced incrementally, avoiding a full file hash for
each PATCH. A changed file identity, size or modification timestamp is a `StateConflict`,
including an equal-size edit whose modification timestamp changes.
Two stale runtimes cannot merge independent in-memory snapshots implicitly. Multiple browser
sessions should share one runtime; independent scenarios should use different state paths.
These checks assume a normal local filesystem, not a remote filesystem that fails to report
changes. In particular, Windows cannot detect an in-place edit that keeps the same file
identity and byte length and restores the exact previous modification timestamp. A following
write can be acknowledged: plain JSON checkpoints overwrite that external edit, while a journal
append retains the altered bytes and the next reload rejects their checksum with `StateIntegrity`.
The digest is not re-hashed before each write. Do not edit the active state file with tools that
preserve these metadata values. Stop the runtime before replacing or restoring state, keep backups,
and use the administration API or a `DataStore` transaction for normal record edits.

The HTTP audit ledger includes `saveMs` and `saveMode` (`journal` or `checkpoint`) for
successful persisted writes. `DataStore.lastSave` and `onSave(timing)` expose the same timing
to embedded hosts. The append journal grows with changes; `compact()` queues an atomic
checkpoint without cloning rows. Full state replacement, presets and arbitrary `transact`
callbacks also checkpoint. External trusted plugin handlers that execute retain full state
rollback copies, and their cost can still scale with the state. A plug-in SDK call journals
its own writes in a savepoint. An independent PreValidation commit copies the state once. Journaling does not make all query/filter/relationship operations indexed or
remove the memory cost of complete admin state exports.

An incremental row transaction also names the tables it wrote: the tables of its row operations, tables it
allocated or removed and, defensively, any table whose row count changed. A storage adapter receives that set as
`save(state, { tables })`. Full transactions and promoted ones pass no set. The simulation adapter then hashes only
the named tables to decide which pack DATA files to rewrite, and keeps the earlier hashes for the rest. This saves
a hash of every table per transaction. The write-integrity guarantees are unchanged. Pack files are still verified
against their digests before and during publication. The private runtime file is still written whole in the same
transaction. The schema hash still covers the complete normalized schema, because schema changes are refused below
deep simulation, even in dry run, and sections have no row journal. Like the row journal, the table set relies on
ordinary writes going through the store's row operations. A full transaction falls back to hashing every table.

`DataStore` and `createSimulator` accept `persistence: { journalThresholdBytes: 0 }` to journal every size,
or choose another nonnegative byte threshold. The threshold is checked against the actual
streamed checkpoint size. Invalid or unpersistable replacements fail before the current
checkpoint is replaced; there is no total-document string-size rejection for large presets.

The ordinary suite covers corruption, torn writes, stale/concurrent writers, rollback,
fragmented metadata/rows and legacy JSON. Run the explicit volume check with at least
2 GiB free RAM:

```sh
paqvilo mirage verify-storage --json
```

It saves/reloads 600,000 synthetic rows with a 1 KiB payload, verifies a file larger than
the engine string limit, checks digest/restart consistency and requires 20 sequential
single-row updates to complete in under five seconds. It also performs 20 real Web API
PATCHes against 300,000 rows, exercises concurrent HTTP clients, checks the audit timings
and verifies external conflicts.

Source checkouts can also run
`node --expose-gc --max-old-space-size=4096 mirage/test-volume/state-storage.mjs`.
The published command uses a disposable directory and removes it on completion; it does
not inspect or modify a project's state. Run it on the filesystem used for local states.

Native basic-form insert/edit postbacks, JSON form submissions and multistep saves use incremental row transactions. The record, associations and annotation attachments share one rollback boundary. Trusted handlers or CLR steps that actually execute promote the unit to a full checkpoint; audit saveMode reports the resulting persistence mode. verify-storage includes a native form save with a 5,000 ms bound.
