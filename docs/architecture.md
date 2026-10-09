# Architecture and project boundaries

Paqvilo owns reusable Power Pages behavior. Your portal project owns its sources, configuration, datasets and acceptance criteria.

| Directory | Responsibility |
| --- | --- |
| `bin/` | Public `paqvilo lense` and `paqvilo mirage` command routing |
| `lense/` | Source models, mapping, editing, overlays, browser sessions, panel and agent API |
| `mirage/lib/`, `mirage/server.mjs` | Importing, Liquid, FetchXML/Web API, forms/lists, permissions, platform compatibility and simulation |
| `mirage/admin/` | Local `/_sim/` administration |
| `mirage/testing/` | Reusable local sign-in helpers for project-owned tests |
| `test/`, `test-browser/` | Synthetic Lense and integration regressions |
| `mirage/test/`, `mirage/test-browser/` | Synthetic Mirage regressions |
| `examples/project/` | Invented standalone portal, external pack and acceptance test starter |
| `docs/`, `mirage/docs/` | Reusable contracts, configuration and workflow guidance |

The two products share the catalogue, source model and browser integration. Lense's Mirage lifecycle wrapper starts and stops only owned processes. Mirage imports Lense's source/configuration utilities; it does not require a live portal for local rendering.

The installed preset library contains only generic presets. No adjacent directory is imported automatically. Explicit `dataPacks` entries load trusted JavaScript modules relative to their project file. The same project can register multiple packs; IDs and presets are validated and conflicting IDs fail. A pack's `matches({ portal })` decides whether its data and extensions apply to that imported portal. Built-in platform behavior must never select a rule by an organisation, website name, custom table prefix or customer route.

Standard and enhanced exports provide configuration, page/template relationships and table permissions. Solution metadata provides table identities, columns, relationships, forms and views. Observed behavior that neither source provides is a site setting with evidence. Synthetic datasets and backend business rules are pack extensions; they do not claim to reproduce a particular Dataverse implementation.

Keep the portal project in its own repository. Core CI never discovers or runs its tests. The publication allowlist excludes private packs, exports, state and captures; the project-boundary check scans reusable source, tests, docs and examples for inherited business dependencies. Private business tests consume the public package exports and explicitly registered packs.

The current tracked tree and npm artifact are separate publication boundaries. Removing private content from the current tree does not remove it from older Git commits. Create a clean public repository from the reviewed tree if the existing repository history contains private exports or captures; do not publish that history accidentally.
