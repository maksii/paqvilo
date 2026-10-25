# Contributing to Paqvilo

Help make the Power Pages feedback loop clearer and more reliable. Reproducible bug reports, documentation improvements and reusable platform fixes are welcome. For everyday portal development, use the [project installation guide](docs/getting-started.md); contributions use a toolkit checkout.

## Set up a contribution

Install Node.js 24.22.1 LTS with npm 11.19.1, .NET SDK 10.0.113, Git and Edge/Chrome, then clone the repository and run `npm run setup:repo`. Linux CI installs matching Chromium with `node node_modules/playwright-core/cli.js install --with-deps chromium` and selects it using `PAQVILO_BROWSER=chromium`.

```sh
git clone https://github.com/maksii/paqvilo.git
cd paqvilo
npm run setup:repo
```

Repository setup prepares the offline package-smoke cache and installs local Git hooks. If you use `npm ci --ignore-scripts` instead, also install Mirage dependencies and run `npm run cache:package` followed by `npm run hooks:install`. Hooks are tracked in `.githooks/` and configured only in this checkout. `npm run setup` retains the distribution dependency bootstrap; `setup:repo` adds contributor configuration. No consumer package-install lifecycle changes Git configuration.

CI preparation may read registry metadata for the example's exact direct dependency pins: its manifest has no lockfile, and cached toolkit tarballs alone are insufficient. The example verification install and package smoke remain offline after preparation.

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), for example `fix(lense): preserve language identity` or `feat(mirage)!: change session contract`. Separate any body/footer from the subject with a blank line; explain breaking changes with `!` or a `BREAKING CHANGE:` footer. PR titles use the same convention because merges are squashed.

Run `npm run format` to apply Prettier and `npm run quality` to check formatting, ESLint and workflow rules. Formatting uses Prettier's normal discovery, ignores and configuration, then replaces each changed file atomically while preserving its permissions. This avoids Windows truncate failures when another process has mapped a source file. Temporary files stay under ignored `.paqvilo/format/`.

Before each commit, the pre-commit hook checks an isolated staged snapshot with `npm run quality`, release checks for packaged changes and site checks when relevant. Unstaged edits cannot make staged code pass. Before pushing, the pre-push hook runs `npm run ci:verify`, selecting suites with the same dependency-aware classifier as GitHub. Shared configuration, dependency, build and unknown paths select all suites; isolated Lense overlay changes select Lense. A clean source tree already verified with the same runtime and platform can reuse its exact-tree receipt. Run `npm run ci:verify -- --full` to prepare fixtures, run every unit/browser suite, audit all lockfiles, smoke-test the package and build the site. `commit-msg` enforces Conventional Commits. Required GitHub checks remain the enforcement boundary. A full run can qualify an entirely staged tree before splitting logical commits: worktree files must match the index, and no nonignored files may be untracked. The final clean HEAD tree must match that receipt before pre-push can reuse it.

When reporting a bug, include the toolkit version, export format, command, expected behavior and relevant redacted diagnostics. A minimal invented fixture is more useful than a private portal export. For a documentation change, check that linked guides and copyable commands still match the CLI.

## Validate and keep the project boundary

Run the checks selected by the pre-commit hook before proposing a change. Runtime changes require `npm run validate`, which checks first-party syntax, Lense unit/browser regressions, Mirage unit/browser regressions and the release boundary. Add relevant regressions for runtime changes; browser tests use synthetic loopback fixtures, never a live portal as a prerequisite.

Three optional ecosystem import checks skip when public sample checkouts are absent. Set `PAQVILO_ECOSYSTEM_FIXTURES` to a directory containing `microsoft__power-pages-samples`, `microsoft__gov-apptemplates`, and any supported public Solution checkout listed in `mirage/test/short-key-fixtures.test.mjs`. These checks read local exports only; the committed synthetic fixtures always run.

Reusable source-overlay behavior belongs in `lense/`; rendering, platform semantics and simulation belong in `mirage/`. Tests under `test/` and `test-browser/` cover Lense and integration; `mirage/test/` and `mirage/test-browser/` cover Mirage. Use invented schemas and identities. Customer data, portal extracts, environment catalogues, personas, generators, acceptance runners and business evidence belong in a separate project. [Extension guidance](docs/project-extensions.md) describes the supported registration contract.

The release allowlist and `scripts/project-boundary.mjs` protect the distribution and tracked source tree. Add reusable tools to `package.json` and the allowlist together. Never add automatic project-pack discovery or a business-name condition to core. A platform behavior that an export cannot reveal must be a per-site `observed` setting with evidence.

Keep personal configuration and storage ignored. Do not commit session discovery, tokens, browser cookies or live captures. Retain upstream license notices. Contributions to original Paqvilo code use AGPL-3.0-only; third-party assets retain their original terms. The project license permits commercial distribution subject to source and notice obligations.

Use `npm run release:check` and `npm pack --ignore-scripts` to prepare a distribution locally. Publishing a package, pushing a repository or changing the hosting environment is a separate action.

## Continuous integration and releases

`npm run review:code` checks dead-code and duplication drift as part of quality validation.
See [the review lane](docs/code-review.md) for entry maps, synthetic canaries, retained contracts
and the manual baseline policy.

[CI](.github/workflows/ci.yml) runs on pushes to `main` and PRs to `main`. PRs select Lense, Mirage and example suites from changed paths and literal import consumers; shared browser assets and unknown/build/dependency changes expand the selection. Main pushes, manual full runs and release callers run every suite and package smoke. One pinned Node 24 runtime is used on Ubuntu 24.04 and Windows 2025; Mirage/example lanes also install the exact serviced .NET SDK from `global.json`. All changed-source PRs run the shared quality checks, including documentation-only PRs. The required `CI gate` validates both successes and intentional skips; description-only edits report separate metadata without replacing source validation. Use `npm run ci:verify -- --base origin/main` for matching local selection or `--full` before a release.

[Security](.github/workflows/security.yml) scans JavaScript/TypeScript, GitHub Actions and the sample C# sources with CodeQL for relevant PR/main changes and weekly. Dependency review rejects newly introduced moderate-or-higher vulnerabilities. `Security gate` is required alongside `CI gate`. [Pages](.github/workflows/pages.yml) builds relevant site changes on PRs and deploys only from `main`. See the [repository admin guide](docs/repository-admin.md) for settings and promotion prerequisites.

[Release](.github/workflows/release.yml) publishes normal releases only from a `v<version>` tag on main matching `package.json`, after the full CI run. Main prereleases use `next`. On-demand branch packages use immutable generated preview tags and separate `preview-<branch-token>` npm channels; see [testing branch packages](docs/branch-packages.md). Releases use the existing npm trusted publisher with provenance, configured for `maksii/paqvilo`, workflow `release.yml` and environment `npm`. A manual run takes an existing tag, runs on that tag and defaults to `npm publish --dry-run`. Preview tag pushes do not publish automatically.
