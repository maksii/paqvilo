# Working with the Paqvilo demo

This is an editable sample project with invented data. Keep its portal exports,
Solution sources, personas, generators and acceptance tests here. Reusable runtime
changes belong in the Paqvilo toolkit, not in a copied dependency.

Run commands from this folder. Install the declared dependencies with `npm install`,
then use `npm run dev` for the local Mirage browser, `npm run dev:debug` for browser
debugging on port 9222, and `npm test` for the project's local acceptance tests.
The prepared VS Code tasks use the same commands. `paqvilo mirage demo` restores the
sample dataset on each start; ordinary development keeps its local state.

Inspect `paqvilo.config.yml`, `portal/`, `solution/`, `code-solution/`, `metadata/`
and `pack/` before making changes. `pack/pack.mjs` explicitly registers the sample's
presets, contact role assignments and plugin models. Persona catalogue descriptions
do not grant access. Derive behavior from these sources and metadata; document
site-specific observations with evidence rather than assuming platform behavior.

After an edit, inspect the rendered page, affected resources and diagnostics, then
run the relevant project tests. A save or sign-in redirect is not proof that a
change works. On Windows, set repository-local `git config core.longpaths true`
before adding deep exported sources to Git.

Mirage serves local sources and simulated data on loopback. Lense (`npm run lense`)
overlays local sources on the configured live portal and browser actions can change
live data. Neither command grants permission to access live references, write live
data, synchronize sources, run PAC or deploy. Obtain that scope from the user.
Keep credentials, browser discoveries, captures and local state under ignored
`.paqvilo/`; never print, copy, share or commit tokens or discovery files. Let the
user handle credential and MFA prompts. Stop only sessions started for your task.

See the [demo guide](https://github.com/maksii/paqvilo/blob/main/docs/demo.md) and
[project extension guidance](https://github.com/maksii/paqvilo/blob/main/docs/project-extensions.md).
