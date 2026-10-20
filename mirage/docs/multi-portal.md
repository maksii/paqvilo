# Multi-portal projects

A catalogue or version-2 Mirage project can declare several portal sources and shared Solution roots. Each portal selects its own Solution subset, reference, deployment profile, observed behavior and data model. Generated state names are project/portal scoped. Environments are references, not data providers enabled by default.

`paqvilo mirage dev --config <catalogue> --portals all` starts every selected site's runtime on its configured port. `--site` chooses the first browser tab; the panel selector switches local portals and configured live references. Use `--portals selected` when limiting work to one site. Identity uses one cookie name per runtime port, preventing accidental cross-portal sign-in.

`paqvilo mirage portal-matrix --project <project.yml> --out .paqvilo/matrix` reports import/bootstrap/render coverage for the declared project. A successful import or configured route is not a live navigation or parity result. Project-specific acceptance tests belong in that project's package.

Catalogue matrix runtime and scaffold runtime stages bind through `createMirageContext({ config, site, env, repo })`, retaining the selected site's environment/origin, platform settings, observations, registered packs and deployment profiles. Each runtime uses independent temporary state. Project matrix runtimes retain the selected portal's equivalent defaults and project packs. Import/bootstrap/inventory and source sweeps remain source diagnostics; they are not claims that a site's configured runtime, personas or production permissions are ready.
