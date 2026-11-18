# Repository maintenance

For maintainers of the Paqvilo repository. Portal developers start with [getting started](getting-started.md);
contributors use [CONTRIBUTING](../CONTRIBUTING.md), which owns the CI lanes, hooks and `check:pr`.

## Repository settings

`scripts/github-admin.mjs` declares the repository settings (`--help` lists its options). Without arguments it prints
the plan as JSON and contacts nothing; `--apply` applies it with the signed-in GitHub CLI and needs repository admin
permission on the public repository:

```sh
gh auth status
node scripts/github-admin.mjs
node scripts/github-admin.mjs --apply
```

| Area         | Applied state                                                                                                                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Merging      | Squash only (PR title and body), auto-merge allowed, branches deleted on merge                                                                                          |
| `main`       | Strict required checks `CI gate` and `Security gate`, enforced for admins; linear history; resolved conversations; stale reviews dismissed; no force pushes or deletion |
| Release tags | Ruleset "Immutable release tags": `refs/tags/v*` cannot be updated or deleted                                                                                           |
| CodeQL       | Ruleset from `.github/code-scanning-ruleset.json` (error alerts, high/critical security alerts), applied once `main` has a CodeQL analysis                              |
| Actions      | Read-only workflow tokens; only GitHub-owned actions and `SonarSource/sonarqube-scan-action`; full-SHA pins required                                                    |
| Security     | Secret scanning and push protection, Dependabot alerts and security fixes, private vulnerability reporting                                                              |
| Environments | `github-pages` deploys from `main`; `npm` admits `v*` tags; Pages is built by Actions with HTTPS enforced                                                               |
| Metadata     | Description, homepage, topics, Discussions and the `bug`, `enhancement` and `skip-changelog` labels                                                                     |

The script updates its named rulesets and leaves others alone. It does not publish packages, commit or post
announcements. Re-run `--apply` after the first Pages deployment (HTTPS certificate) and after the first `main` Security
run (CodeQL ruleset). It saves the resulting settings to ignored `.paqvilo/admin/setup.json`; compare them with GitHub.
The script requires no approving reviews; set review requirements to match the active maintainer team (an author cannot
approve their own PR).

A self-hosted runner needs Git, Node and npm at the pinned versions, HTTPS access to the npm registry, NuGet, the .NET
installer and GitHub archives, free loopback port 80 (the ServiceClient gate), and on Linux passwordless `sudo` or
Chromium's system libraries (`sudo node node_modules/playwright-core/cli.js install-deps chromium`). CI turns off Git
auto-maintenance for the runner account and reinstalls dependencies on every run.

## Security alerts

`Security gate` fails when an applicable job did not succeed (change scope, CodeQL when the change scope requires it,
and on pull requests that change dependencies the dependency review, which fails on moderate or higher advisories),
while the analyzed ref has any open CodeQL alert, or when the alert API cannot be read. It uses read-only security
permissions and never checks out PR sources with that token. A successful scan can still report alerts, so inspect
findings as well as job conclusions. Every PR must report the same CodeQL configurations as `main` (`actions`, `csharp`,
`javascript-typescript`); a missing one leaves CodeQL unable to compare the PR with `main` and can block merging even
when `Security gate` passes.

Triage decisions are recorded in
[`.github/security/codeql-triage.json`](https://github.com/maksii/paqvilo/blob/main/.github/security/codeql-triage.json)
and in the GitHub alert disposition. Before dismissing an exact false positive, verify the current source, sink, caller
authority, destination constraints and relevant regressions, and record that constraint, a focused regression where
applicable, and validation on the affected revision. Do not dismiss an alert because code runs locally or appears in a
test. Formatting can change fingerprints and reopen an earlier finding: a historical rule/path match is a review aid,
not permission to dismiss automatically. Do not disable a query, exclude all tests or reuse an old decision without
checking current behaviour. The `security-extended` suite includes review queries for intentional flows (pinned archive
downloads, deterministic identifiers, owned loopback protocols); preserve compatibility behaviour when a diagnostic is
not a security sanitizer.

Vulnerability reports go through [private reporting](https://github.com/maksii/paqvilo/blob/main/SECURITY.md).

## Packages

The [Release workflow](https://github.com/maksii/paqvilo/blob/main/.github/workflows/release.yml) resolves an immutable
tag, runs the full CI gates on it and publishes the archive those gates built and tested:

| Tag                                     | Condition                                                      | npm dist-tag             | GitHub release |
| --------------------------------------- | -------------------------------------------------------------- | ------------------------ | -------------- |
| `v<version>`                            | Equals `package.json` version; commit is an ancestor of `main` | `latest`                 | yes            |
| `v<version>-<pre>` (not `-preview.`)    | Same                                                           | `next`                   | prerelease     |
| `v<base>-preview.<token>.<time>.g<sha>` | Created by [the preview helper](branch-packages.md)            | `preview-<branch-token>` | no             |

Pushing a stable or prerelease tag publishes it; pushing a preview tag starts nothing, the helper dispatches its run. A
manual run takes an existing tag as both ref and input (`gh workflow run release.yml --ref <tag> -f tag=<tag>`; the
plan step refuses a ref that differs from the input) and defaults to `npm publish --dry-run`. A
version already on npm is skipped. Publishing uses npm provenance through the trusted publisher configured for
`maksii/paqvilo`, workflow `release.yml` and environment `npm`; keep these in step when changing the workflow identity.
A dry run does not prove permission to write to the registry.

Before publishing, inspect CI and security findings, install the packed package into a separate project, and check the
[release notes](release-notes.md). Afterwards, verify the exact npm version and dist-tag, then run the
[preview cleanup](branch-packages.md#preview-retention).

## Website

`npm run site:build` builds the static site and checks its local links. The Pages workflow builds pull requests that
change the site and deploys from `main` through the `github-pages` environment. Check the demo instructions and coverage
links at desktop and narrow widths when changing the site. Discussion categories and npm access settings are maintained
in their own UIs.
