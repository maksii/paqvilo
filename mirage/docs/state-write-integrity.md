# State-write integrity

State mutations use locks, content digests and atomic checkpoints or durable row-journal
commits so one writer cannot silently overwrite another process's changes. Offline
migration/scaffold/generator commands validate state and detect active runtime ownership
before replacing it. Temporary files and locks are cleaned up on success or failure.

Use the public `DataStore` and `readStateFile` APIs for either persistence format. Ordinary
large-state CRUD commits changed rows; full replacements use streamed atomic checkpoints.
For optimistic replacement, obtain `snapshotDigest()` and supply `expectedDigest` to
`replaceState`. A stale digest or active owner is an explicit failure. Do not write directly
to a running runtime's state file. Use the administration API for running local changes
and stop an owned runtime before offline migration.

See [state storage](state-storage.md) for integrity checks, recovery, concurrent writers,
memory costs and compaction. Files may contain a journal even when their extension is `.json`.

State and ownership files remain private under `.paqvilo/`. The protocol protects local integrity; it does not grant permission to read or write a reference environment.
