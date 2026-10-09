# Mirage migration

See [the Paqvilo migration guide](../docs/migration.md) for product commands, configuration keys, environment variables, external project packs and private local state.

Existing simulation JSON keeps its business tables, IDs and schema. Select it explicitly with `--state` and register its original packs so stored preset descriptors can resolve. Missing builtin descriptors are reported as unavailable rather than substituted with unrelated data. Browser sessions are fresh per runtime and do not inherit global saved identity.
