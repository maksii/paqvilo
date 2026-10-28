# Schema-directed pack datasets

`generateDataset` from `paqvilo/mirage/fixtures` builds a local dataset fragment
from an imported Solution schema. Use it inside an explicitly registered project
pack's `dataset()` or preset loader. Counts, rules and realistic business values
belong to that project. The helper performs no network calls and changes no state.

```js
import { generateDataset, mergeDataset } from 'paqvilo/mirage/fixtures';

const fragment = generateDataset({
  schema, // importSolutionData(...).schema from selected local Solution exports
  seed: 'inventory-demo',
  counts: { sample_group: 3, sample_item: 12 },
  rules: {
    sample_item: {
      sample_name: { kind: 'one-of', values: ['Small', 'Medium', 'Large'] },
      sample_quantity: { kind: 'sequence', start: 1, step: 2 },
      sample_price: { kind: 'range', min: 1.25, max: 9.75 },
      sample_group: { kind: 'lookup', target: 'sample_group', source: 'generated' },
    },
  },
});
const { state: next, report } = mergeDataset(state, fragment);
```

Only tables listed in `counts` receive generated rows. Required scalar columns
receive simple synthetic values using exported types, numeric bounds, lengths,
choice values and defaults. Optional columns are omitted unless a rule supplies
them. Unsupported required types fail with table/column context. This is a data
construction helper; it does not run server rules, infer personas or grant access.

| Rule `kind` | Inputs                               | Behavior                                                                              |
| ----------- | ------------------------------------ | ------------------------------------------------------------------------------------- |
| `constant`  | `value`                              | Repeat a typed value.                                                                 |
| `one-of`    | `values`, optional `mode`            | Cycle through values, or select deterministically with `mode: 'random'`.              |
| `sequence`  | optional `start` and `step`          | Numeric sequence; defaults to 1 and 1.                                                |
| `pattern`   | `template`, optional `start`, `step` | Text with `{seq}` or zero-padded `{seq:4}` tokens; defaults to sequence 1, step 1.    |
| `range`     | `min`, `max`                         | Seeded numeric selection within inclusive bounds; integers stay integral.             |
| `null`      | none                                 | Omit an optional column; required columns reject it.                                  |
| `lookup`    | optional `target`, `source`, `mode`  | Choose an allowed target row; `source` is `generated`, `existing` or `any` (default). |

`existing: { table: rows }` supplies local lookup candidates and alternate-key collision checks without copying those
rows into the fragment. Their identities must exist in the state that receives the
fragment. Constant/one-of lookup values use `{ id, logical_name }` and must resolve
in generated or supplied existing rows. GUID primary keys and exported lookup
targets are checked. There are no implicit remote reads or unresolved references.

All selected row identities are reserved before columns are populated. Required
cycles and self-lookups can therefore resolve within the completed offline
fragment. Table selection and existing-row input ordering do not affect seeded
selection; changing metadata, rules, seed, counts or candidate identities can
change values. The helper never mutates its arguments.

Active alternate keys from imported metadata are checked across generated and
supplied existing rows. `mergeDataset` also checks the final additive rows against
the selected state's mapping keys, including base preset rows. Matching primary
keys keep existing rows, so repeating a fragment remains idempotent. Null, omitted
or empty key members do not enforce uniqueness; inactive index definitions do not
either. Text uses `CI_AI` by default. Pass `collation: 'CI_AS'` to generation when
the receiving state's `settings.collation` is accent-sensitive. These checks are
offline and fail before any state save; they do not create remote indexes.
Known column metadata also governs key values: equivalent datetime instants and
numeric representations collide consistently across generation, merge, index
activation and runtime writes. Date-shaped text remains text. Columns without
type metadata retain the store's existing scalar coercion rules.

Patterns allow only the explicit sequence tokens, with padding from 1 to 32 digits,
safe integer sequence values, and templates of at most 65,536 characters. Expanded
text still follows the column's metadata length. They do not evaluate code or
interpolate fields. Multiselect choices accept integer arrays or comma-separated
integers; empty selection omits an optional column and rejects a required column.
Missing tokens within a nonempty comma-separated value are rejected.

Counts accept integers from 0 to 100,000, with at most 100,000 rows in total.
Rules reject unknown, primary, derived and non-creatable columns. Candidate values
are checked against exported types, choices, lengths and numeric bounds, including
one-of values not selected in a small sample. A valid fragment still needs the
normal `mergeDataset` schema/reference checks and the project's own scenario tests.
