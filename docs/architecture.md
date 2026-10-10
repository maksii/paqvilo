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

## Runtime scope

| Input or behavior | Available support | Boundary |
| --- | --- | --- |
| Standard and enhanced portal exports | Source mapping and local import of pages, templates and configuration | Incomplete or ambiguous exports produce diagnostics. |
| `.powerpages-site` code-site exports | Source import and supported resource handling | SPA application builds and deployment use their own tooling. |
| Liquid, FetchXML, Web API, forms and lists | Local implementations driven by export and Solution metadata | Local behavior is a simulation; use recorded comparisons for parity claims. |
| Dataverse business behavior | Synthetic rows, supported exported operations and registered project extensions | Dataverse plugins, external connectors and complex workflows require explicit project models. |
| Browser automation | Origin-confined session, page, event, snapshot and navigation APIs | Live browser actions still use the portal's backend. |

The [Mirage reference](../mirage/docs/README.md) describes each runtime contract and its evidence. Microsoft's [developer tools](https://learn.microsoft.com/en-us/power-pages/configure/developer-overview) remain part of the source and release workflow.

## Project extensions

The installed preset library contains only generic presets. No adjacent directory is imported automatically. Explicit `dataPacks` entries load trusted JavaScript modules relative to their project file. The same project can register multiple packs; IDs and presets are validated and conflicting IDs fail. A pack's `matches({ portal })` decides whether its data and extensions apply to that imported portal. Built-in platform behavior must never select a rule by an organisation, website name, custom table prefix or customer route.

Standard and enhanced exports provide configuration, page/template relationships and table permissions. Solution metadata provides table identities, columns, relationships, forms and views. Observed behavior that neither source provides is a site setting with evidence. Synthetic datasets and backend business rules are pack extensions; they do not claim to reproduce a particular Dataverse implementation.

Keep the portal project in its own repository. Core CI never discovers or runs its tests. The publication allowlist excludes private packs, exports, state and captures; the project-boundary check scans reusable source, tests, docs and examples for inherited business dependencies. Private business tests consume the public package exports and explicitly registered packs.
