# Working with Paqvilo

Follow the user's scope. `paqvilo lense` overlays local sources in a dedicated browser on a live portal; browser actions can affect live data. It does not deploy, upload, run PAC or execute Liquid/Dataverse locally. `paqvilo mirage` serves exported sources and simulated data on loopback, with `/_sim/` for administration. Neither workflow grants permission to change live data, synchronize sources or deploy.

## Project boundary

Keep reusable code in `lense/` and `mirage/`. Keep portal exports, organisation-specific catalogue URLs and observations, business data, personas, generators and acceptance tests in a separate project. Register trusted external pack modules explicitly through `mirage.dataPacks` or project `dataPacks`. Tests in this repository use invented schemas and loopback fixtures only; project tests run in the project's own package. Follow [project extension guidance](docs/project-extensions.md).

Do not hardcode business names, table prefixes or routes in core. Derive behavior from source, Solution metadata, settings and data. Behavior not derivable from an export is a per-site `observed` setting with evidence. Keep local state, browser discoveries and business evidence under ignored `.paqvilo/`; legacy local state must remain ignored. Discovery files contain bearer tokens: never print, copy, share or commit them. Reference reads are read-only, through the intended signed-in browser; redact query values and never store tokens.

## Inspect and validate

Run from the toolkit checkout. Use Node commands for JSON (npm adds a preamble):

```sh
node scripts/ensure-dependencies.mjs --check --json --browser msedge
node bin/paqvilo.mjs lense list --config <catalogue> --json
node bin/paqvilo.mjs lense doctor --config <catalogue> --all --json
node bin/paqvilo.mjs lense resources --config <catalogue> --site <site> --env <env> --page <path> --json
node bin/paqvilo.mjs lense audit --config <catalogue> --all --strict --json
node bin/paqvilo.mjs mirage init --config <catalogue> --site <site>
node bin/paqvilo.mjs mirage dev --config <catalogue> --site <site>
```

Source bootstrap reads local directories; reference reads and cached assets are explicit separate operations. Every local runtime has its own session cookie; portal requests are anonymous until signed in through the local sign-in page, Tweaks, `/_sim/`, `simulator.signIn()` or [testing/session.mjs](mirage/testing/session.mjs).

Select sources with `--repo` or `PAQVILO_REPO`. Configuration/evidence stay outside the portal checkout. Configured coverage is not proof of navigation. `--path` selects only the first tab; HEAD baselines are captured per activated target. Never infer a deployed commit.

Sign-in redirects are intermediate states. When authorized use headed Edge and the intended connected work account; Windows SSO may finish automatically. Inspect the result and let the user handle credential/MFA challenges. Do not copy credentials between identities. REAL DATA targets still require authorization.

The bounded Lense agent API supports sessions, status, pages, events, state, snapshots, screenshots and controlled navigation. Each API is origin-confined; stopping one owned target stops its shared owned browser. Attached browsers remain user-owned. Advance event cursors with `nextSequence` and inspect truncation. For authorized live debugging choose a free `--debug-port`, confirm it in status and connect with Playwright CDP.

## Edits and evidence

Use discovered paths and fields with [lense/source-edit.mjs](lense/source-edit.mjs), preserving sibling JSON/XML/YAML fields and record/language identity. Offline resource IDs differ from browser page IDs. A save alone is not validation. `audit --all --strict` independently checks source coverage; accounted and mapped percentages do not prove browser application. Inspect applied resources, unmatched patches, needsDeploy, errors, requests and screenshots after refresh.

`verify --signed-in` reuses the dev identity: close dev first, use `--headed` when sign-in may be needed and bound the wait with `--sign-in-timeout`. It edits a temporary copy. Inspect passes, coverage, skips, diagnostics, inlineBaseline and cleanup. Do not claim unobserved behavior or a sign-in page as successful coverage.

Runtime changes need relevant regressions. Run `npm run validate`. Do not run a private project's acceptance runners against live references unless authorized. Finish by stopping only sessions started for the task and checking the toolkit and affected project repositories.
