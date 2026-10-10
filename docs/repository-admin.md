# Repository administration and promotion

## Readiness decisions

The readiness audit found existing Node 22/24 browser tests, Windows unit tests, locked runtime dependencies, provenance publishing and an explicit package allowlist. Both root and Mirage npm audits reported zero vulnerabilities on 2026-10-10. The 0.9.3 tarball is approximately 5.2 MB compressed / 10.5 MB unpacked, mostly the deliberately shipped demo and runtime assets. Keep that usable offline demo; marketing site sources, CI tooling, tests and local evidence stay outside the tarball. Runtime dependencies are all used and no hook/lint framework is added.

Implemented additions: staged-index commit hooks; Conventional Commit PR titles; conservative change-scoped CI; npm and action Dependabot updates; CodeQL and dependency review; bug/feature issue forms; private-reporting guidance; CODEOWNERS; badges; a two-page static marketing site and Pages workflow. Release checks now validate the selected tag and require it to belong to main.

Repository settings use PR-only, linear main with `CI gate` and `Security gate`, strict up-to-date checks, resolved conversations, admin enforcement, no force pushes/deletions, squash titles from PR titles, deleted merged branches, read-only default workflow tokens, restricted action publishers, Discussions, dependency alerts/fixes, secret scanning/push protection and private vulnerability reporting. Version tags cannot be changed or deleted. Code scanning merge protection blocks high/critical CodeQL security findings and error-level alerts when GitHub supports it.

There is currently one maintainer. Required approving reviews are zero because authors cannot approve their own PRs. Once a second maintainer joins, set required approving reviews to one and enable code-owner review. Keep checks required for admins; do not bypass failed checks to ship.

## Apply or reapply GitHub settings

Install and authenticate `gh` as a repository admin, then run from this checkout:

```sh
gh auth status
node scripts/github-admin.mjs
node scripts/github-admin.mjs --apply
```

The first script invocation previews its plan. Apply uses GitHub APIs through `gh`, updates named rulesets without duplicating them, and preserves unrelated rulesets. It does not commit sources, change visibility, publish npm versions or send messages. Review the returned settings and run URLs. Merge workflow changes before expecting their required check names to appear. Reapply after the first main Security run to enable the checked-in CodeQL merge-protection ruleset; initial setup waits for that baseline.

## Existing npm trusted publisher

The [paqvilo package](https://www.npmjs.com/package/paqvilo) already releases through its configured GitHub Actions trusted publisher: owner `maksii`, repository `paqvilo`, workflow filename `release.yml`, environment `npm`. The maintainer confirmed the existing release process and npm's **Valid** publisher status on 2026-10-10. No publisher setup or token migration is needed for repository readiness. Keep this workflow filename and environment aligned with npm's configuration; trusted publishing provides provenance. GitHub CLI cannot administer npm package access or trusted publishers; future changes to those settings belong on npmjs.com.

The `npm` GitHub environment restricts releases to `v*` tags. Consider a required reviewer once another maintainer can approve; requiring the sole author's review blocks releases. No npm version is published by repository setup.

## Discussions and Pages

Discussions can be enabled with `gh`; creating/reorganizing discussion categories has no supported public API. In **Repository → Discussions → Edit categories**, keep a Q&A category with answer marking, Ideas, Show and tell, and Announcements. No announcement is posted by setup.

Pages uses GitHub Actions and the `github-pages` environment, restricted to `main`. The site is built with `npm run site:build`, without installing extra frontend packages. URL: [maksii.github.io/paqvilo](https://maksii.github.io/paqvilo/). Preview PR builds never deploy. A required `Pages / build` check is intentionally omitted because its workflow is path-filtered; CI/security gates always report.

## Before promotion

1. Run `npm run setup:repo` in each contributor checkout. This activates local hooks; Git cannot distribute local configuration automatically. Run `npm run validate` and `npm run release:smoke` with a supported browser installed.
2. Confirm main and the readiness PR are green across CI, security and Pages; review/dismiss CodeQL alerts only with a documented reason. Do not treat a successful scan job alone as absence of findings.
3. Validate the updated Release gates with `dry_run=true` and a tag containing the updated workflows; create a new matching version tag only when an actual release is intended. The npm trusted publisher is already configured and used for releases.
4. Open the deployed marketing site on mobile and desktop; verify demo commands and coverage against the release. The npm README/homepage update reaches npm on the next version publish.
5. Add another maintainer and required review before expanding write access. Set up a release/support cadence when you can commit to it; avoid promising service levels in the security policy.

References: [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/), [GitHub path filters and pending checks](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow), [CodeQL](https://docs.github.com/en/code-security/concepts/code-scanning/codeql/codeql-code-scanning), [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), [custom Pages workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).
