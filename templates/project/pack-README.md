# {{pack}} data pack

This pack owns this project's generators, fixtures, personas and backend rules. Its empty preset contains no business rows or permission overrides. Implement `matches()` from exported website identity before expecting the pack to activate in a portal runtime.

Register the module explicitly in the catalogue. Use the shared `support/mirage.mjs` context in tests. Put reusable helpers in `lib/`, generators in `generators/`, data in `fixtures/`, acceptance plans in `acceptance/`, tools in `tools/`, unit tests in `test/` and browser tests in `test-browser/`.

After installation, read `node_modules/paqvilo/mirage/docs/data-packs.md` for the pack contract and `node_modules/paqvilo/docs/project-extensions.md` for project boundaries. Keep private captures and tokens under ignored `.paqvilo/`.
