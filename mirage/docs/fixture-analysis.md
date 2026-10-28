# Offline fixture analysis and source authoring

These helpers consume explicit local metadata and data. They do not read a live
organization, infer a business policy, execute imported code or write a project.
Counts, selected tables, saved declarations and assertions belong to the project.

## Population and relationship coverage

```js
import { summarizeDataset } from 'paqvilo/mirage/fixtures';

const report = summarizeDataset({ schema, tables: fragment.tables, existing });
```

`schema` is the imported Solution schema; `tables` selects the tables to inspect.
`existing` supplies additional local lookup targets. Each column partitions the
selected rows into missing/undefined, null, empty string/array and populated.
Boolean `false` and numeric `0` are populated. Choice counts measure rows containing
each metadata option, counting a repeated multiselect member once. Malformed or
closed-set unlisted choices do not count as exercised options. Open option sets
remain explicitly marked; these summaries do not prove a successful native write.

Lookup counts distinguish resolved, dangling, invalid and ambiguous values. A
polymorphic scalar GUID remains ambiguous without its logical target; a single
metadata target can resolve a scalar. Identity counts normalize decorated GUIDs
and identify missing, invalid and duplicate IDs. Unknown column counts do not
silently disappear. The report contains metadata names and option codes, with no
row IDs, text values or sample records. Inputs remain unchanged. Limits are
100,000 selected/existing rows, 10,000 selected metadata columns and two million
column inspections; choice inspection also rejects excessive nesting/work.

## Project-owned TypeScript declarations

```js
import { generateSchemaDeclarations } from 'paqvilo/mirage/fixtures';

const { declarations, diagnostics } = generateSchemaDeclarations(schema, {
  tables: ['sample_item', 'sample_group'],
});
// The project chooses where to save declarations as its own schema.d.ts.
```

The returned declaration text exports `Tables`, `Row`, `FixtureRow`, `Choices`,
`PrimaryIds`, `Lookup` and `ExactNumeric`. Required metadata fields belong to
`Row`; `FixtureRow` permits partial fragment columns while retaining the primary
ID. Choice unions and polymorphic lookup targets come from the selected metadata.
Exact decimal/money/Int64 fixture values can retain the store's tagged digits.
Optional columns accept null. These declarations do not validate runtime strings,
GUID syntax, dates, CSV multiselect tokens or business rules.

Unavailable types use `unknown` with a diagnostic. Missing/open choice sets and
lookup targets have explicit diagnostics rather than fabricated enums or targets.
Metadata labels and business values are not emitted. Selection/field order does
not affect output. Limits are 1,000 selected tables, 10,000 columns, 100,000 option
codes and two MB of declaration text. This emits types only, without generated
runtime clients, SDK dependencies or remote schema requests.

## Local registration comparison

```js
import { comparePluginRegistrations } from 'paqvilo/mirage/fixtures';

const report = comparePluginRegistrations(before.plugins, after.plugins);
```

Pass two parsed `importSolutionPlugins` inventories from explicitly selected
exports. Stable GUIDs identify assemblies, types and steps. Added, removed and
changed facts include numeric execution mode, stage/rank, table/message, filtering
attributes and image alias/type/attribute sets. Attribute-set order and GUID case
are neutral. Duplicate or missing identities remain diagnostics with
`complete: false`; no record is matched by its friendly name. Configuration,
secure configuration and assembly content are never copied into the result.
This compares exported definitions, not deployed organizations or DLL execution.

The same entry exports `parsePluginDocument(xml)` and
`importSolutionPlugins(selectedLayers)` to obtain the existing parsed inventories.
For a single export, `comparePluginRegistrations(parsePluginDocument(beforeXml),
parsePluginDocument(afterXml))` works directly. Selected layers add source-file
provenance and existing message/type/assembly resolution; do not substitute a
runtime catalogue whose `mode` describes its adapter. Full assembly identity and
source message/filter/handler IDs remain comparison facts even when names are
unresolved. Inspection uses a shared work budget, including aliased metadata.

## Permission comparison and identity substitution

[`comparePermissionModels`](permission-model-diff.md) compares two complete
compiled portal grant models; `buildPermissionModel` is exported from the same
fixtures entry. It reports provable set inclusion and explicit indeterminate
cases, without using row populations as proof of a policy change.

`remapDatasetIdentities(fragment, { schema, identities, existing })` returns a
cloned `{ fragment, report }`. `identities` explicitly maps each selected table's
old GUIDs to new GUIDs. Primary IDs, source-declared lookup aliases and N:N
intersect endpoints change together. Ambiguous targets, conflicting annotations
and collisions fail atomically. Opaque business strings are preserved, and
unverified unchanged external references remain count-only findings. Non-row
identity sections require their own project migration. The result still passes
through `mergeDataset`, including its active alternate-key and schema preflight,
before any project saves it.

## Flow expression and trigger preflight

```js
import { inspectFlowExpression, evaluateFlowTriggerConditions } from 'paqvilo/mirage/fixtures';

const syntax = inspectFlowExpression("@equals(triggerBody()?['enabled'], true)");
const matches = evaluateFlowTriggerConditions(definition, { input, parameters });
```

The inspector reports syntax, known function and arity diagnostics without
evaluation. It does not invent types for uncaptured dynamic payloads. Condition
evaluation uses the supplied body and parameters and starts no tracked run or
provider. Runtime source conditions are checked before run creation; false creates
no run history. These APIs preserve normal action `runAfter` failure handling.
See [flow execution](operations.md#execution-boundary) for trigger hosting and
the supported exact UTC timestamp `ticks` contract.

## Named deterministic recreation

```js
import { createFixtureRecipes } from 'paqvilo/mirage/testing';

const recipes = createFixtureRecipes({
  baseline: { state, epochMs: Date.UTC(2026, 0, 1), namespace },
});
const fixture = recipes.create('baseline');
// Pass fixture.state/clock/ids/scheduler to a fresh local runtime.
// Close that runtime and fixture.scheduler when the project test finishes.
```

Recipe definitions are captured as cloneable data. Every `create` supplies fresh
state, a fixed clock, a fresh deterministic ID sequence and an idle manual
scheduler. Mutating one fixture does not change the recipe or another fixture.
At most 100 named definitions are accepted. This incorporates named replay at a
quiescent creation boundary: it does not rewind an active runtime, recover an
advanced identity counter, restore arbitrary provider closures or resurrect
in-flight timers. A project rebuilds its providers for the new fixture and owns
teardown of the old runtime. Runtime callbacks in recipe state are rejected.
Shared-memory buffers and views are rejected because cloning them does not
isolate their bytes; ordinary array buffers are copied. Recipe graph inspection
has a shared work limit.
