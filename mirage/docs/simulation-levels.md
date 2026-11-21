# Simulation levels and pack DATA files

The simulation level decides where local writes go. It applies to every mutation surface: organization Web API and SOAP
requests, model-driven forms, `/_sim/` administration, Power Pages forms and `/_api`, plug-ins and background work.
Authorization still runs before an operation commits; a level grants no identity extra access. (Fidelity levels such as
`contract` or `behaviour`, which say how much of a platform feature Mirage implements, are a separate concept: see
[capabilities and preflight](capabilities-and-preflight.md).)

Set it in a Mirage project, a catalogue site's `mirage` settings, `/_setup/`, or with `--simulation`:

```yaml
simulation:
  level: dry-run
```

```sh
paqvilo mirage start --project ./mirage.project.yml --simulation dry-run
```

| Level        | Record edits                                  | Schema changes                            | After restart                                                             |
| ------------ | --------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------- |
| `dry-run`    | Kept in memory                                | Refused (`SimulationSchemaDisabled`, 403) | Reloads source and pack DATA; memory edits and local credentials are gone |
| `simulation` | Written to declared, existing pack DATA files | Refused (`SimulationSchemaDisabled`, 403) | Reads the updated pack DATA                                               |
| `deep`       | Written to declared pack DATA files           | Allowed when a `schemaPath` is declared   | Reads the updated DATA and normalized schema                              |

`simulation` takes only `level`; any other key, or another value, fails at startup. Source and bootstrap imports
establish the initial schema at every level. Creating a table, adding a column or importing schema through a running API
is a schema change, including one made by trusted extension code inside the transaction.

A configuration that omits `simulation` keeps the older private local-state persistence: every write goes to the ignored
state file and schema changes are allowed. Administration labels it `local-state`; it is not pack writeback. New guided
configurations select `dry-run`.

## Declare existing writable DATA

A trusted pack declares its writable files in `dataFiles`, an explicit data property (not a getter). Packs load only
when registered through project or catalogue `dataPacks`, `--pack-module` or the embedded pack options; see
[data packs](data-packs.md).

```js
export default {
  id: 'invented-data',
  name: 'Invented data',
  description: 'Project-owned development data',
  matches: () => true,
  presets: () => ({}),
  dataFiles: [
    {
      file: 'data/records.json',
      tables: {
        sample_item: {
          path: ['items'],
          idColumn: 'sample_itemid',
        },
      },
      newTablesPath: ['createdTables'],
      schemaPath: ['schema'],
    },
  ],
};
```

The project supplies an existing `data/records.json`:

```json
{
  "description": "This sibling is preserved",
  "items": [
    {
      "sample_itemid": "11111111-1111-4111-8111-111111111111",
      "sample_name": "Invented item"
    }
  ],
  "createdTables": {},
  "schema": {}
}
```

The `sample_item` table and columns come from a selected Solution, a pack preset or embedded mappings: the DATA
declaration owns storage only, never types, permissions or navigation.

Each entry accepts only `file`, `tables`, `newTablesPath` and `schemaPath`, and must declare at least one location.
`file` is a relative `.json` path from the pack module's directory, without `..`, `.git` or `.paqvilo` segments, and
must resolve (after links) to an existing regular file inside that directory. Each file has one entry. Nothing else is
inferred as a write target; the runtime never rewrites the pack's JavaScript.

`tables` maps each logical table to `{ path, idColumn }`: an existing JSON array (a path of `[]` is the root array) and
its primary key column. Keys must be present, unique and consistent with table metadata. Several tables may share a file
at separate paths, and several files may own separate tables; overlapping locations, unsafe property names (`__proto__`,
`constructor`, `prototype`) and a table with two owners fail before startup.

`newTablesPath` optionally names an existing object for tables created in `deep`; only one file may provide it, and
existing tables still need their own locations. `schemaPath` optionally names an existing object for normalized local
metadata; only one schema owner is allowed, and a `deep` runtime without it allows record edits but refuses schema
changes. Pack schema holds normalized schema only (never secret stores, password hashes or identity settings). Custom
API definitions, request parameters and response properties are schema: changing them needs `deep` and a `schemaPath`.

Create, update and delete modify the DATA arrays directly, keeping record identity, unmodified row properties and
unrelated JSON siblings (whitespace may be reformatted). Pack DATA is authoritative on startup, even when the private
checkpoint was removed: a startup preset (either preset mode) keeps the file's rows for every table a DATA file owns.
Applying a preset through `/_sim/` writes the preset's rows to the file.

## Private runtime and identity state

`simulation` and `deep` require a private `stateFile` for transaction recovery; CLI and project startup place it under
ignored `.paqvilo/`. Identity, role, audit and job infrastructure and credential hashes persist there and never become
business DATA. A business write to a table without an owner fails with `SimulationDataTargetRequired` (409); it never
falls back to a sidecar. A schema change in `deep` without a `schemaPath` fails with `SimulationSchemaTargetRequired`
(409).

The control plane is private runtime state at every level, so only business tables need a DATA owner:

- process definitions and their activation rows (`workflow`), environment variable definitions and values, connection
  references, and the Power Pages configuration tables of both data models (including
  `powerpagesite`/`powerpagecomponent`/`mspp_*`);
- the deployment-profile pin and operation choices (`/_sim/api/operations`, including local flow activation);
- run history (`workflowlog`, `processsession`, `asyncoperation`, `plugintracelog`).

Flow activation, a profile switch and a preset apply therefore work at `simulation`. A preset applied through `/_sim/`
needs a DATA owner for each business table it writes (`SimulationDataTargetRequired` otherwise). Its table mappings are
declared schema and are accepted at every level. Any other schema it carries (custom API definitions, request
parameters, response properties, metadata) keeps the level's rule: below `deep` the apply answers 403
`SimulationSchemaDisabled` and nothing of the preset is applied; in `deep` that schema is written, with the preset's
mappings and the rest of the normalized schema, to the declared `schemaPath`, so it is authoritative after a restart
even without the private checkpoint. In `dry-run` the apply changes memory only. Solution definitions seed workflow rows
(with their exported activation state) and the component rows of forms, views, site maps and apps; a `/_sim/` state
replacement keeps them, and a preset that replaces an organization table such as `customapi` wins by id while the
Solution's other rows stay.

`dry-run` neither loads nor saves the checkpoint and disables persistent source, asset, evidence and certificate caches;
record edits, local registrations and password or secret hashes stay in memory, and `start` prints
`State: not persisted (dry-run keeps state in memory)`. Configuration explicitly saved through Setup is still saved.

## Publication, conflicts and recovery

The storage adapter joins the `DataStore` commit: it prepares every changed pack file and the private checkpoint, checks
their loaded digests, then publishes under owned file locks with a recovery journal. A failed publication emits no
committed events; a late failure restores the earlier files and rolls back memory. Operations that commit independently
by design (such as elastic tables) keep their own semantics.

- A pack file changed outside the runtime causes `PackDataConflict` (409). Restart from the updated files before
  retrying; nothing is merged or overwritten.
- If rollback cannot restore a file because it changed again, writes stop with `PersistenceRecoveryRequired` (500). Keep
  the journal and backups while resolving it.
- Each lock records its owner (process, host, toolkit version). A restart after a writer died with a journal
  (`<state file>.pack-transaction.json`) completes or rolls back that publication and removes the locks the journal
  names. Recovery refuses changed physical paths and symlinked companion files.
- Without a journal, a writer that died after taking its locks leaves `<file>.lock` and `<file>.paqvilo-<token>.tmp`/
  `.bak` companions beside each DATA file and the state file, with every file still at its last committed version. A
  lock taken on this host whose owner process has ended is reclaimed, with those companions, at the next start or write
  and reported as a `WRITER_LOCK_RECLAIMED` warning in `/_sim/api/diagnostics`.
- A live owner is never reclaimed: the write answers 409 `PackDataConflict`
  (`A writer owns <file>.lock: process <pid> on this host is still running; retry after it finishes.`). Locks from
  another host and locks without owner identity (an older toolkit's) are not reclaimed either; their message says which
  files to delete once no runtime uses them. Lock age plays no part.

This serializes cooperating runtimes and detects outside edits; separate files do not become visible to unrelated
readers at one instant.

## Inspect and change a level

`GET /_sim/api/simulation` reports the effective level, record persistence, declared file targets, schema capability,
changed-record count and readiness, without row values or credentials.

Save a new level through `/_setup/` and restart. Changing configuration never flushes in-memory edits into pack files,
and a restart always rereads the selected source and DATA files. Runtimes without Power Pages use the same policy; see
[standalone organization](standalone-organization.md).
