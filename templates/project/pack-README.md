# {{pack}} data pack

This pack owns this project's generators, fixtures, personas and backend rules. Its empty preset contains no business rows or permission overrides. Implement `matches()` from exported website identity before expecting the pack to activate in a portal runtime.

Register the module explicitly in the catalogue. Use the shared `support/mirage.mjs` context in tests. Put reusable helpers in `lib/`, generators in `generators/`, data in `fixtures/`, acceptance plans in `acceptance/`, tools in `tools/`, unit tests in `test/` and browser tests in `test-browser/`.

Read the maintained [pack contract]({{docs}}mirage/docs/data-packs.md) and [project boundaries]({{docs}}docs/project-extensions.md). Consult the installed package's copies when online docs differ from the installed version. Keep private captures and tokens under ignored `.paqvilo/`.

Add validated `configurationPresets` for reusable local setting/snippet/platform overrides.
A data preset can link a `configurationPreset`; applying its configuration remains opt-in.
Add a versioned [`personaCatalog`]({{docs}}mirage/docs/persona-catalog.md) for operator groups,
labels, tags and isolated scenarios. Contact IDs must exist in the selected dataset; these
entries describe contacts rather than granting roles. Use `createMirageContext` from
`paqvilo/mirage` to bind the same packs in project generators and tests, and `connectRuntime`
from `paqvilo/mirage/testing` for a runtime already started by the CLI.
