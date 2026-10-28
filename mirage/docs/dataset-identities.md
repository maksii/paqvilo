# Remap an offline dataset's identities

`remapDatasetIdentities` from `paqvilo/mirage/fixtures` substitutes explicit
record identities in a local row fragment. It performs no requests or writes.
Use it to make a project fixture portable between explicitly chosen identity
sets; it does not discover or transfer records from another environment.

```js
import { remapDatasetIdentities, mergeDataset } from 'paqvilo/mirage/fixtures';

const { fragment: remapped, report } = remapDatasetIdentities(fragment, {
  schema, // selected importSolutionData(...).schema
  identities: {
    sample_group: {
      '10000000-0000-4000-8000-000000000001': '20000000-0000-4000-8000-000000000001',
    },
  },
  existing: { sample_group: destinationRows }, // when a rewritten lookup targets existing local data
});
const next = mergeDataset(state, remapped);
```

The result contains a cloned `fragment` and a count-only `report` with
`remappedRows`, `remappedLookups`, `unverifiedLookups` and `unusedIdentities`.
Inputs, mappings, provenance, unmapped IDs and opaque business properties are
preserved. GUID-looking text is not treated as a relationship.

Primary-key columns come from `schema.tables`. Lookup targets come from
`schema.targets` and selected relationship metadata. N:N intersect columns are
derived from that metadata, including self-relations; no core table names or
prefixes are assumed. Typed `{ id, logical_name }` references keep their sibling
properties. Scalar lookup columns and Web API `_column_value` aliases retain
their shape. A polymorphic lookup that needs rewriting must identify its target
through a typed reference or a logical-name annotation. Conflicting aliases or
target annotations fail explicitly.

Substitutions are simultaneous and applied once: a destination that is another
source does not trigger a second replacement in the same call. Repeated calls
with the same original fragment and plan are deterministic. Applying an
overlapping plan again to its already transformed output is a new substitution,
so callers should retain the original fragment rather than repeatedly remap it.

Duplicate destinations, normalized source aliases, primary-key collisions with
retained or supplied existing rows, and rewritten lookups without a destination
row fail before a result is returned. Untouched external references are retained
and counted as unverified when the supplied fragment/existing data cannot resolve
them. A zero unverified count does not validate all schema, security, alternate
keys or business rules; the normal `mergeDataset` checks and project acceptance
tests still apply.

The helper accepts a row-only fragment. Nonempty permissions, persona roles,
persona catalogues, simulator configuration and plug-in sections require their
own explicit identity mapping and are refused when substitutions are requested.
The helper does not guess which IDs in those contracts identify dataset rows.
Supply a separate row fragment, then explicitly rebuild the project's other
sections against the chosen destination identities.

Exact primary-key metadata and GUID identities are required. Combined fragment
and existing rows and substitution pairs are each limited to 100,000, with a
shared 1,000,000-unit work budget. No partial result or state change is published
on a refusal.
