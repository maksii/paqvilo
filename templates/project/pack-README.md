# {{pack}} data pack

This pack owns this project's generators, fixtures, personas and backend rules. Its empty preset contains no business rows or permission overrides. Implement `matches()` from exported website identity before expecting the pack to activate in a portal runtime.

Register the module explicitly in the catalogue. Use the shared `support/mirage.mjs` context in tests. Put reusable helpers in `lib/`, generators in `generators/`, data in `fixtures/`, acceptance plans in `acceptance/`, tools in `tools/`, unit tests in `test/` and browser tests in `test-browser/`.

Read the maintained [pack contract]({{docs}}mirage/docs/data-packs.md) and [project boundaries]({{docs}}docs/project-extensions.md). Consult the installed package's copies when online docs differ from the installed version. Keep private captures and tokens under ignored `.paqvilo/`.
