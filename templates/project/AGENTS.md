# Working with {{name}}

Use Paqvilo from this project. Start with [setup and configuration]({{docs}}docs/getting-started.md), [configuration reference]({{docs}}docs/configuration.md) and [project boundaries/data packs]({{docs}}docs/project-extensions.md). For the task at hand, read [Lense and its agent API]({{docs}}docs/lense.md) or [Mirage]({{docs}}mirage/README.md). Use the installed CLI's `--help`; bundled documentation is the version-matched fallback when online docs differ. [Local workflows](docs/workflows.md) lists this project's scripts.

1. On a fresh checkout, run `npm run setup`. Use `npm run configure` (the local `/_setup/` workspace) for sources, environments and settings. Resolve `npx --no-install paqvilo init --check` findings using the guides. Keep personal choices in ignored settings, and mark real-data environments `caution: true`.
2. Inspect configured sources with Mirage `inspect` and Lense `doctor` before development. Derive behavior from exports/metadata; add `observed` settings only with this site's evidence. Complete local fixtures before claiming browser coverage.
3. Run `npm run validate` and the scaffold check before finishing. For previews, inspect applied resources, diagnostics and the affected page; a save or sign-in redirect is not proof. Stop only sessions you started and commit only your task's changes.

Lense browser actions can affect live data. Neither preview workflow authorizes live writes, reference access, source synchronization, PAC or deployment; follow the user's explicit scope. Keep captures/state in ignored `.paqvilo/` (legacy `.pp-local/` stays ignored). Never print, copy, share or commit discovery files, credentials or bearer tokens. Let the user handle credential/MFA challenges.
