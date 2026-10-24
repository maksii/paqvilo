# Mirage in the Lense browser

`paqvilo mirage init` builds a runtime project from the selected catalogue's portal export, dependency-ordered Solution roots, reference environments and explicit data packs. Bootstrap reads local directories only; no reference environment is contacted. `paqvilo mirage dev` starts each selected runtime and opens it in Lense's dedicated browser. `start`, `status` and `stop` manage only the runtimes Paqvilo started.

```sh
npx --no-install paqvilo mirage init --config ./paqvilo.config.yml --site portal
npx --no-install paqvilo mirage dev --config ./paqvilo.config.yml --site portal
```

## The panel

- **Inspect** shows the current page's template chain, access rules, forms, views, tables, columns, snippets and settings. Permission explanations use this browser's session. Source items open their portal or Solution file in the configured editor.
- **Tweaks** signs this browser in or out, selects local enforcement, scenarios and presets, and links to `/_sim/`. Identity always comes from this browser's session cookie, never from a saved global persona.

Mirage watches its sources and reloads local rendering when they change. When a source is missing, a Solution cannot resolve a relationship, a pack does not match or a managed dependency needs enrichment, read the bootstrap and runtime diagnostics. Lifecycle files and logs stay under `.paqvilo/mirage`. An attached browser is detached on shutdown, not closed.

## Several portals

A catalogue or a version-2 Mirage project can declare several portal sources and shared Solution roots. Each portal selects its own Solution subset, reference, deployment profile, `observed` settings and data model, and gets its own state file.

- `--portals all` starts one runtime per site, each on its configured port (`sites.<id>.mirage.port`, or `0` for any free port). `--site` chooses the first browser tab; the panel selector switches between local portals and configured live references.
- `--portals selected` starts only the selected site. Use it with an explicit `--project` or `--portal`.
- Port, state, preset and Solution overrides on the command line apply to the selected site; other sites keep their catalogue settings.
- Each runtime has its own session cookie (`paqvilo-mirage-auth-<port>`), so signing in to one portal never signs you in to another.

`paqvilo mirage portal-matrix --project <project.yml> --out .paqvilo/matrix` (or `--config <catalogue>`) reports import, bootstrap and render coverage for every declared portal, each runtime on its own temporary state. A successful import or configured route is not proof of live navigation or parity. Embedding code binds the same per-site defaults with `createMirageContext({ config, site, env, repo })`. Project-specific acceptance tests belong in the project's own package.
