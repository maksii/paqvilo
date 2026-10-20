# Simulation levels and pack DATA files

Select a level in Setup, a Mirage project, a catalogue site's `mirage` settings,
or the CLI. The same policy applies to organization Web API/SOAP requests,
model-driven forms, local administration, Power Pages forms/API, plug-ins and
background work. Authorization still runs before an operation can commit.

```yaml
simulation:
  level: dry-run
```

```sh
paqvilo mirage start --project ./mirage.project.yml --simulation dry-run
```

| Level | Record edits | Schema changes | Restart |
| --- | --- | --- | --- |
| `dry-run` | Allowed in memory | Refused | Reloads source and pack DATA; memory edits and local credentials disappear |
| `simulation` | Writes existing, explicitly declared pack DATA files | Refused | Reads updated pack DATA |
| `deep` | Writes declared pack DATA | Allowed with a declared schema location | Reads updated DATA and normalized schema |

Source/bootstrap imports establish the runtime's initial schema in every level.
Creating a table, adding a column or importing schema through a running API is a
schema mutation and requires `deep`. This policy also covers schema changes made
by trusted extension code inside the transaction.

Existing configurations that omit `simulation` retain their previous private
local-state persistence. Administration labels that mode `local-state`; it is not
presented as pack writeback. Guided creation defaults to `dry-run`.

## Declare existing writable DATA

A registered trusted pack may declare `dataFiles`. Modules still execute only
when explicitly registered through project/catalogue `dataPacks`, CLI
`--pack-module`, or the embedded pack options. See [external packs](data-packs.md).

For example, a project's pack module can contain:

```js
export default {
  id: 'invented-data',
  name: 'Invented data',
  description: 'Project-owned development data',
  matches: () => true,
  presets: () => ({}),
  dataFiles: [{
    file: 'data/records.json',
    tables: {
      sample_item: {
        path: ['items'],
        idColumn: 'sample_itemid',
      },
    },
    newTablesPath: ['createdTables'],
    schemaPath: ['schema'],
  }],
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

Supply the `sample_item` table and columns through a selected Solution, a pack
preset, or embedded initial mappings. The DATA declaration owns storage; it does
not guess column types, grant permissions or declare application navigation.

`file` is relative to the registered pack module. It must resolve to a regular
existing JSON file inside that pack directory, including after resolving links.
Executable modules, discovery files, `.paqvilo` state, portal exports and Solution
files are not inferred as write targets. The runtime never rewrites the pack's
JavaScript to save a record.

`tables` assigns each logical table one owner and an existing JSON array path.
Primary keys must be present, unique and consistent with table metadata. A path
of `[]` owns a root array. Multiple tables may occupy separate paths in one file;
multiple files may own separate tables. Overlapping locations and duplicate
ownership fail before startup.

`newTablesPath` optionally names an existing object for tables created in deep
simulation. Only one file may provide this default owner. Existing tables still
need their own declared locations. `schemaPath` optionally names an existing
object for normalized local metadata; only one schema owner is allowed. A deep
runtime without that owner allows record edits but refuses schema mutations.

Create, update and delete modify these DATA arrays directly. They retain record
identity, unmodified row properties and unrelated JSON siblings. JSON whitespace
may be reformatted. Pack DATA is authoritative on startup, even when the private
runtime checkpoint has been removed.

## Private runtime and identity state

Persistent levels require a private `stateFile`; CLI/project startup places it
under ignored `.paqvilo/`. Platform identity, role, audit and job infrastructure
and credential hashes persist there. They do not become business DATA merely
because a table has no declared pack owner. Undeclared business writes fail with
`SimulationDataTargetRequired`; they never silently fall back to a sidecar.

Dry run does not load or save that checkpoint and disables persistent source,
asset, evidence and certificate caches. Record edits, local registrations and
password/secret hashes stay in memory. Configuration edits explicitly saved
through Setup remain configuration edits.

Pack schema contains only normalized schema sections. Application secret stores,
password hashes and simulator identity settings are excluded. Ordinary record
audit lookups may retain their non-secret user IDs and display names.
Custom API definitions, request parameters and response properties also belong
to schema: their rows define public operation signatures. Changing them requires
deep simulation and a declared `schemaPath`; that DATA location preserves them
across restarts independently of the private checkpoint.

Portal visitors continue to use contact identity and table permissions.
Organization users and application registrations continue to use Dataverse
roles, ownership and field security. Selecting a simulation level grants neither
identity additional access.

## Publication, conflicts and recovery

The storage adapter participates in the DataStore commit boundary. It prepares
every changed pack file and the private checkpoint, checks their loaded digests,
then publishes under owned file locks with a recovery journal. An unsuccessful
publication does not emit committed events. A late publication failure restores the earlier
file contents and rolls back memory; it is not a successful partial write.
Dataverse operations that deliberately commit independently, such as elastic
main operations, retain their separate transaction semantics.

External changes cause `PackDataConflict`. Restart from the updated files before
retrying; the runtime does not silently merge or overwrite them. If rollback
cannot safely restore a file because its contents changed again, writes stop with
`PersistenceRecoveryRequired`. Preserve the journal and backups while resolving
the conflict. Recovery reclaims a lock only when a validated transaction journal
names its exact owner token and allowed paths, the recorded process is proven
absent, and the on-disk token still matches. Active, foreign, legacy and
unverifiable locks remain untouched. Recovery refuses changed physical paths or
symlinked companion files rather than restoring through them.

These guarantees serialize cooperating runtimes and detect outside edits. They
do not claim that separate files become atomically visible to unrelated readers
at one filesystem instant.

## Inspect and change a level

`GET /_sim/api/simulation` reports the effective level, business and control-plane
persistence, exact declared file targets, schema capability, changed-record count
and readiness. It returns no row values or credentials. Model-driven commands and
administration record actions combine these capabilities with their own supported
controls and applicable authorization.

Save a new level through Setup and restart the instance. Changing configuration
never flushes in-memory edits into pack files. Restart always rereads the selected
source and DATA files. For runtimes without Power Pages, use the same policy with
the [standalone runtime configuration](../../docs/setup.md).
