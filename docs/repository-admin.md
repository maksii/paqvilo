# Repository maintenance

This guide is for maintainers of the Paqvilo repository. Portal developers should start
with [getting started](getting-started.md); contributors should use [CONTRIBUTING](../CONTRIBUTING.md).

## Repository settings

`scripts/github-admin.mjs` describes the repository settings. Preview its plan before
applying it with an authenticated repository administrator account:

```sh
gh auth status
node scripts/github-admin.mjs
node scripts/github-admin.mjs --apply
```

The script updates named rulesets and preserves unrelated ones. It does not publish a
package, commit source or post announcements. Review its output against the repository's
actual settings after applying it.

Main uses pull requests, squash merges, resolved conversations and the required `CI gate`
and `Security gate` checks. Version tags are immutable. Review requirements should reflect
the active maintainer team: a sole author cannot approve their own pull request. Keep
security checks required for administrators.

## Validation and security

CI runs the pinned Node 24 toolchain on Ubuntu 24.04 and Windows 2025. Mirage and
example lanes install .NET SDK 10.0.113 from `global.json`; roll-forward is disabled
so the hosted image cannot silently select a different compiler. Ordinary PRs
select Lense, Mirage and example suites conservatively using changed paths and literal
import consumers. Shared assets, dependency/build/workflow changes and unknown paths
expand the selection. Full Windows runs also require the locked TDS, DynamicsWebApi and certificate/MSAL.NET client gates. Python and ServiceClient retain their explicit opt-in prerequisites.
Main pushes, manual full runs and releases run all unit/browser
suites, Windows/CLR regressions and package smoke. Documentation-only PRs retain quality
and release checks. Local `npm run ci:verify -- --full` prepares the same mandatory
fixtures and writes an ignored receipt for the verified clean source tree, toolchain
and platform; pre-push can reuse that exact result. The security workflow performs dependency review and CodeQL
analysis. After successful analysis/processing, `Security gate` checks the analyzed
ref for open CodeQL findings and fails when any remain or the alert API cannot be
read. It uses read-only security permissions and does not check out or execute PR
sources with that token. The first alert is enough to fail; pagination cannot hide
additional findings. Inspect findings as well as job conclusions; a successful scan
alone can report alerts.

Report vulnerabilities through [private reporting](../SECURITY.md). Alert triage decisions
are recorded in [`.github/security/codeql-triage.json`](../.github/security/codeql-triage.json). A triage entry
must record the actual source-to-sink constraint, a focused regression where applicable,
and validation on the affected revision. Do not dismiss an alert merely because code
runs locally or appears in a test.

## Packages

The [Release workflow](../.github/workflows/release.yml) resolves an immutable tag, runs
all release gates and publishes the tested archive. Stable tags must match package
metadata and belong to main. Use [branch previews](branch-packages.md) for pre-merge tests.

The npm trusted publisher must match the repository, workflow `release.yml` and GitHub
environment `npm`. The environment's tag policy must admit the intended release tags.
Review these settings on GitHub and npm before changing the workflow identity. A dry run
checks packaging but does not prove permission for a registry write.

Before publishing, inspect CI/security findings, install the packed package into a separate
project, and check the release notes and upgrade instructions. After publication, verify
the exact npm version and channel. Preview builds must leave `latest` unchanged.

Run the [local preview cleanup](branch-packages.md#preview-retention) after publishing previews
or a stable release. It preserves primary releases, keeps the latest three unreleased previews
globally, and retires previews covered by a stable release. Apply cleanup interactively with
your npm login and npm's manual two-factor approval. Publishing stays on trusted publishing;
there is no GitHub cleanup workflow or maintenance token.

## Website

`npm run site:build` builds the static website and checks its local links. Pages builds
pull requests without deployment; deployment uses main and the `github-pages` environment.
Check the demo instructions and coverage links on desktop and narrow screens when changing
the site. Discussion categories and npm access settings are maintained in their respective UIs.

## Review CodeQL results

The extended suite includes review queries for intentional flows, such as pinned archive downloads, deterministic identifiers and owned loopback protocols. The security gate requires zero open alerts after fixes or individual review; it does not mean the analyzer produced zero results. Preserve compatibility behavior when a diagnostic is not a security sanitizer.

Before dismissing an exact false positive, verify the current source, sink, caller authority, destination constraints and relevant regressions. Record the evidence in `.github/security/` and in the GitHub alert disposition. Formatting can change fingerprints and reopen an earlier finding: a historical rule/path match is a review aid, not permission to dismiss it automatically. Do not disable a query, exclude all tests or reuse an old decision without checking current behavior.
