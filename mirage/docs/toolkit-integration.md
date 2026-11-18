# Mirage in the Lense browser

`paqvilo mirage dev` starts each selected runtime from the catalogue's portal export, dependency-ordered Solution roots,
reference environments and explicit data packs, and opens it in Lense's dedicated browser. Bootstrap reads local
directories only; no reference environment is contacted. `start`, `status` and `stop` manage only the runtimes Paqvilo
started.

```sh
npx --no-install paqvilo mirage dev --config ./paqvilo.config.yml --site portal
```

`paqvilo mirage init` writes the same selection to `.paqvilo/mirage/<site>.project.yml` and prints the `dev` command
that runs it with `--project`; the catalogue form above does not read that file.

## The panel

- **Inspect** shows the current page's template chain, access rules, forms, views, tables, columns, snippets and
  settings. Access rules are reported as the runtime enforces them for the selected persona, so an identity with role
  ids but no contact id is anonymous here too. Permission explanations use this browser's session. Source items open
  their portal or Solution file in the configured editor.
- **Tweaks** signs this browser in or out, selects local enforcement, scenarios and presets, and links to `/_sim/`.
  Identity always comes from this browser's session cookie, never from a saved global persona.

Mirage watches its sources and reloads local rendering when they change. When a source is missing, a Solution cannot
resolve a relationship, a pack does not match or a managed dependency needs enrichment, read the bootstrap and runtime
diagnostics. Lifecycle files and startup logs stay under `.paqvilo/mirage`; runtime state and discovery files under
`.paqvilo/simulator`. An attached browser is detached on shutdown, not closed.

## Several portals

A catalogue or a version-2 Mirage project can declare several portal sources and shared Solution roots. Each portal
selects its own Solution subset, reference, deployment profile, `observed` settings and data model, and gets its own
state file.

- `--portals all` starts one runtime per site, each on its configured port (`sites.<id>.mirage.port`, or `0` for any
  free port). `--site` chooses the first browser tab; the panel selector switches between local portals and configured
  live references, leaving out `caution` environments unless the catalogue sets `includeCaution: true`. Each portal
  opened in the browser gets its own agent discovery file.
- `--portals selected` starts only the selected site. It is the default unless the catalogue sets `portals: all` or
  `PAQVILO_PORTALS`; a run with `--project` and no `--config` always starts only the project's selected `--portal`.
- `--port`, `--state`, `--preset` and `--solution-root` on the command line apply to the selected site; other sites keep
  their catalogue settings.
- Each runtime has its own session cookie (`paqvilo-mirage-auth-<port>`), so signing in to one portal never signs you in
  to another.

## Which runtimes status and stop select

With `--project F`, `status` and `stop` select the runtimes started for F. Otherwise they select the catalogue site
that `--config` and `--site` name (default `./paqvilo.config.yml` and its default site; every site when the catalogue
sets `portals: all` or `PAQVILO_PORTALS=all`), plus the runtimes of the project that site maps with `mirage.project`. A
runtime started with `--project` and no `--config`, for a project no site maps, belongs to its project file only.

A `--runtime model-driven` or `--runtime dataverse-api` start for a catalogue site (`--config`/`--site`, no
`--project`) uses that site's Mirage settings (Solution roots, data packs, port) and belongs to that site, so
`status --site` and `stop --site` find it. A `--runtime` start with none of `--config`, `--site` and `--project` belongs
to the folder it was started in: `status` and `stop` without selectors select it there, so a bare `stop` stops it.
`status` labels each runtime with the site it was started for (`[a]`), also when two sites share a source folder.

`stop` stops exactly what `status` lists; both report other toolkit-owned runtimes recorded in the same state folder
under `others`, each with the `status` command that selects it. A runtime whose `mirage dev` process was killed keeps
running and is still selected by these rules. A runtime started in the foreground (`mirage serve`) has no ownership
record: `status` labels it `foreground`, and `stop` leaves it running and names it with its URL and PID (`foreground` in
`--json`), for example `1 foreground runtime is not stopped by stop: http://127.0.0.1:<port> (pid <n>); press Ctrl+C in
its terminal.` End it with Ctrl+C in its terminal. `status` and `stop` with a `--config` file that has since been
removed still select the runtimes recorded for it; `stop` prints
`Stopped 1 toolkit-owned Mirage session(s) for the removed catalogue <path>.` and one `stopped <url>` line per runtime.

`paqvilo mirage portal-matrix --project <project.yml> --out .paqvilo/matrix` (or `--config <catalogue>`) reports
import, bootstrap and render coverage for every declared portal, each runtime on its own temporary state. A successful
import or configured route is not proof of live navigation or parity. Embedding code binds the same per-site defaults
with `createMirageContext({ config, site, env, repo })`. Project-specific acceptance tests belong in the project's own
package.
