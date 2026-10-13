# Working with {{name}}

This repository owns its catalogue, portal exports, Solution metadata, data packs, personas, generators and acceptance tests. Reusable platform changes belong in Paqvilo. Register trusted pack modules explicitly; importing them executes project JavaScript.

Lense overlays local sources in a dedicated browser on a live portal. Browser actions can change live data. Mirage renders exported sources and simulated data on loopback, with `/_sim/` for administration. Scaffolding and either preview workflow grant no permission to deploy, synchronize sources, run PAC or write live data. Ask for explicit authorization before those operations.

Keep state, browser discoveries and evidence in ignored `.paqvilo/`; keep legacy `.pp-local/` ignored. Discovery files contain bearer tokens: never print, copy, share or commit them. Reference reads require authorization, use the intended signed-in browser, redact query values and never store credentials or tokens. Let the user handle sign-in/MFA challenges.

Derive behavior from exports, Solution metadata and data. Use per-site `observed` settings only for behavior the export cannot reveal, with evidence from this site's own captures. A configured target or a sign-in redirect is not proof of successful navigation. Never infer a deployed commit from local Git.

## Complete this scaffold

1. Run `npx paqvilo init --check` and resolve all `TODO(paqvilo-init)` markers.
2. Point `sourceRoot`, each site's `source` and `solutionRoots` at local exports. Confirm with `npm run mirage -- inspect --site <site>` and `npm run doctor -- --all`.
3. Add real environments. Mark production/real-data targets `caution: true`; their use still requires authorization.
4. Record only evidenced observations. Configuration belongs here; local state and captures stay ignored.
5. If packs were generated, implement their `matches()` against exported website identity, add local scenarios/personas and select `sites.<id>.mirage.preset` in the catalogue. Keep pack tests green.
6. Fill the per-site fixtures under `test-browser/fixtures/`. Turn the placeholder smoke skips into real loopback acceptance coverage.
7. Run `npm run validate`; `npx paqvilo init --check` must exit zero. A save alone is not validation. For Lense changes inspect applied resources, unmatched patches, needsDeploy, requests, errors and screenshots after refresh.

Use `npx paqvilo init --refresh-editor` after changing catalogue source paths or switching checkouts. Edited editor files are preserved; review any generated alternatives. Stop only sessions started for the task and inspect this repository's status before finishing. Commit only the task's own work.
