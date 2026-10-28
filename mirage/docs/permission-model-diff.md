# Compare compiled portal grants

`comparePermissionModels(before, after)` from `paqvilo/mirage/fixtures` compares
two full `buildPermissionModel` results. Load each local source revision with its
own selected metadata, settings and observed profile before compiling it. The
admin permission tree alone is insufficient: it omits resolved relationship
descriptors and some role identities used by the comparison.

```js
import { comparePermissionModels } from 'paqvilo/mirage/fixtures';

const report = comparePermissionModels(beforeModel, afterModel);
if (report.status !== 'unchanged') {
  // The external project decides whether these changes satisfy its policy.
  console.log(report.summary, report.changes, report.diagnostics);
}
```

The versioned JSON report has `domain: 'compiled-portal-table-grants'`, a
`status`, counts by classification, changed grant cells and diagnostics. A cell
is an exact role ID, logical table and operation. Evidence lists contributing
permission IDs, source paths and resolved predicates; display names, record
values and unrelated input properties are omitted. Inputs are never changed.

Comparison ignores ordering, display-label changes, source-file moves and
equivalent splits of the same grants. Parent paths are compared structurally,
including their read requirement and inherited role association. A global grant
covers the same cell's scoped grants. Adding a predicate to a union cannot
reduce that union; removing it cannot expand it. These provable inclusion
directions are reported as `wider` or `narrower`. Independent directions produce
`mixed`. This describes potential grant coverage; no row is read, so the report
does not assert that a newly reachable record actually exists.

Different contact/account/parent predicates are not ranked by a guessed scope
ordering. They produce `indeterminate` unless exact predicate inclusion or a
global grant proves the direction. Missing/ambiguous roles, unknown scopes,
unresolved relationships, disabled compilation errors, cycles and observed
orphan profiles also prevent qualification. Source-mode, association-policy,
default-role, membership and persona/account changes are explicit diagnostics:
the same declared grant can reach different people under those changes.

This is a configuration comparison, not another authorization evaluator. It
does not determine live/deployed access, execute queries, combine page access
rules or Web API enabled-column policy, or reproduce enhanced authorization's
additional Dataverse role checks. Use the existing runtime APIs and project
acceptance fixtures for those layers. A report with `status: 'indeterminate'`
must not be treated as a successful no-widening assertion.

Inputs must be complete compiled models with known source mode, permission,
role, membership, persona and diagnostic arrays and a settings object. The
helper bounds models to 10,000 permissions, arrays/grant cells to 100,000 entries
and parent paths to 64 levels. Both models share a 1,000,000-unit work budget,
precharged for array sorting and nested role lists before expanding grants;
repeated references do not bypass it. Invalid shapes or excess bounds fail explicitly.
Projects own requirements such as which roles may access which tables.
