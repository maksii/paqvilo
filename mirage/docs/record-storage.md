# Generated record storage

An owned preset can stream JSON records into paged storage through its runtime
context. The schema, imported forms, permissions, field security, calculated
columns and record APIs still use the selected Solution definitions.

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

Keep generators and schemas in the consumer project. Each yielded row is
serialized as an independent JSON record. Source objects can be reused between
yields. Schema defaults and deterministic autonumbers are applied before storage.
The input is a synchronous iterable; the factory returns an object. The primary
key option enables a persistent string-key index with the store's GUID and text
comparison rules. Other key shapes retain the ordinary query fallback.

Existing `load()` presets, saved custom presets and owned factories returning
ordinary arrays keep their established ownership and copying behavior. Public
preview reads of a streamed preset produce ordinary arrays. Runtime snapshots and
record results provide detached ordinary data; requesting a complete snapshot
materializes every requested record. Use the streamed administration state export
for a complete JSON file and select tables/sections for smaller snapshots.

Runtime table arrays provide ordinary reads, insertion, deletion, reordering and
mutable JSON rows. Their elements are writable enumerable configurable data
properties. Apply JavaScript property descriptors to a detached snapshot.
`sort`, `reverse`, `shift`, `unshift`, `fill` and `copyWithin` keep their Array
results while rearranging stored record versions, without rewriting records or
key pages. An insert or delete copies only the position chunk it changes.

Persistent pages live beside the state file in `<state-file>.records`. The journal
references immutable file prefixes by a digest of their page headers. Each page
header carries its payload digest, which every read verifies, so a restart reads
page headers rather than every stored byte. Restored files remain read-only. A
new runtime writes its own file and starts another before one runs out of page
numbers. Record pages hold up to 64 KiB of JSON.

The directory's `.record-owner.json` holds a random owner key, which the journal
also records. A state file and its directory therefore load together after they
are moved, copied or restored to another folder or drive. A different state
cannot load the directory, and a new state adopts an existing directory only at
the location recorded for its owner. Keep this directory with a raw journal
backup. Directories and journals written before owner keys load, and their marker
is rewritten in the current form. The administration JSON export is
self-contained. Legacy JSON and v1 journal files remain readable and retain their
existing file format until paged records are selected.

Offline `data generate` and `data scaffold` keep paged input while merging their
generated arrays. A separate output copies referenced pages into its own record
directory. Public `mergeDataset()` results remain ordinary detached arrays.
Commands release their readers on success and failure.

Read caches and open handles are bounded independently of record count; the key
index cache keeps internal nodes before leaves. Table positions use typed
buffers, and a transaction takes one private copy of each table it writes, which
shares immutable pages until a write. Key sorting uses bounded runs and temporary
files. Public exports stream record values with backpressure instead of retaining
one proxy per row. A commit compares its metadata sections in bounded steps and
yields to the event loop between them.

`DataStore.compact()` queues a checkpoint and rewrites live record versions. It
preserves held rows, ordering, aliases and active private snapshots. A table
written while the compacted checkpoint is saved keeps its live versions, which
are saved again. File leases protect active readers; collection checks the state
publication lock and directory ownership, and removes key-sort runs, lease and
owner temporaries left by exited processes. A directory that holds files but no
owner marker is used unowned and reported as `unverified-directory`; nothing in
it is collected. Close the runtime to release its handles and leases.
