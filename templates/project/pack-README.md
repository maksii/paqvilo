# {{pack}} data pack

This pack owns this project's generators, fixtures, personas and backend rules. Its empty preset contains no business rows or permission overrides. Implement `matches()` from exported website identity before expecting the pack to activate in a portal runtime.

Generation registers every requested pack on every requested site. Review that matrix
in [configuration]({{project}}/docs/configuration.md).
Test an intended website identity and an unrelated negative fixture; shared packs
should match each intended site explicitly. Registration for source-free unit tests
does not prove runtime ownership or activate this preset on unrelated exports.

Register the module explicitly in the catalogue. Use the shared `support/mirage.mjs` context in tests. Put reusable helpers in `lib/`, generators in `generators/`, data in `fixtures/`, acceptance plans in `acceptance/`, tools in `tools/`, unit tests in `test/` and browser tests in `test-browser/`.

Read the maintained [pack contract]({{docs}}mirage/docs/data-packs.md) and [project boundaries]({{docs}}docs/project-extensions.md). Consult the installed package's copies when online docs differ from the installed version. Keep private captures and tokens under ignored `.paqvilo/`.

Add validated `configurationPresets` for reusable local setting/snippet/platform overrides.
A data preset can link a `configurationPreset`; applying its configuration remains opt-in.
Add a versioned [`personaCatalog`]({{docs}}mirage/docs/persona-catalog.md) for operator groups,
labels, tags and isolated scenarios. Contact IDs must exist in the selected dataset; these
entries describe contacts rather than granting roles. Use `createMirageContext` from
`paqvilo/mirage` to bind the same packs in project generators and tests, and `connectRuntime`
from `paqvilo/mirage/testing` for a runtime already started by the CLI.

Follow the project [state/persona runbook]({{project}}/docs/data-lifecycle.md): bootstrap preserves local edits,
reapply is explicit, scenario states are isolated, visitors start anonymous, and
membership grants differ from persona metadata. Use `readStateFile` for journal-backed
state. Close visitors and owned scenario copies; leave unrelated runtimes running.
