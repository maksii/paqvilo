# Contributing to Paqvilo

Help make the Power Pages feedback loop clearer and more reliable. Reproducible bug reports, documentation improvements and reusable platform fixes are welcome. For everyday portal development, use the [project installation guide](docs/getting-started.md); contributions use a toolkit checkout.

## Set up a contribution

Install Node.js 22/24, Git and Edge/Chrome, then clone the repository and run `npm run setup`. Linux CI installs matching Chromium with `node node_modules/playwright-core/cli.js install --with-deps chromium` and selects it using `PAQVILO_BROWSER=chromium`.

```sh
git clone https://github.com/maksii/paqvilo.git
cd paqvilo
npm run setup
```

Setup installs repository-local Git hooks. If you use `npm ci --ignore-scripts` instead, also install Mirage dependencies and run `npm run hooks:install`. Hooks are tracked in `.githooks/` and configured only in this checkout. No consumer package-install lifecycle changes Git configuration.

Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), for example `fix(lense): preserve language identity` or `feat(mirage)!: change session contract`. Separate any body/footer from the subject with a blank line; explain breaking changes with `!` or a `BREAKING CHANGE:` footer. PR titles use the same convention because merges are squashed.

Before each commit, the pre-commit hook exports the staged index into an ignored temporary directory and runs the full `npm run validate` suite using the installed locked dependencies. Unstaged edits cannot make staged code pass. It removes the temporary directory afterward. Browser dependencies must be installed; the tests use synthetic loopback fixtures. `commit-msg` rejects malformed messages. Git hooks are bypassable local safeguards; required GitHub checks remain the enforcement boundary.

When reporting a bug, include the toolkit version, export format, command, expected behavior and relevant redacted diagnostics. A minimal invented fixture is more useful than a private portal export. For a documentation change, check that linked guides and copyable commands still match the CLI.

## Validate and keep the project boundary

Run `npm run validate` before proposing a change. It checks first-party syntax, Lense unit/browser regressions, Mirage unit/browser regressions and the release boundary. Browser tests run only against synthetic loopback fixtures. Runtime changes need relevant regressions; do not use a live portal as a test prerequisite.

Three optional ecosystem import checks skip when public sample checkouts are absent. Set `PAQVILO_ECOSYSTEM_FIXTURES` to a directory containing `microsoft__power-pages-samples`, `microsoft__gov-apptemplates`, and any supported public Solution checkout listed in `mirage/test/short-key-fixtures.test.mjs`. These checks read local exports only; the committed synthetic fixtures always run.

Reusable source-overlay behavior belongs in `lense/`; rendering, platform semantics and simulation belong in `mirage/`. Tests under `test/` and `test-browser/` cover Lense and integration; `mirage/test/` and `mirage/test-browser/` cover Mirage. Use invented schemas and identities. Customer data, portal extracts, environment catalogues, personas, generators, acceptance runners and business evidence belong in a separate project. [Extension guidance](docs/project-extensions.md) describes the supported registration contract.

The release allowlist and `scripts/project-boundary.mjs` protect the distribution and tracked source tree. Add reusable tools to `package.json` and the allowlist together. Never add automatic project-pack discovery or a business-name condition to core. A platform behavior that an export cannot reveal must be a per-site `observed` setting with evidence.

Keep personal configuration and storage ignored. Do not commit session discovery, tokens, browser cookies or live captures. Retain upstream license notices. Contributions to original Paqvilo code use AGPL-3.0-only; third-party assets retain their original terms. The project license permits commercial distribution subject to source and notice obligations.

Use `npm run release:check` and `npm pack --ignore-scripts` to prepare a distribution locally. Publishing a package, pushing a repository or changing the hosting environment is a separate action.

## Continuous integration and releases

[CI](.github/workflows/ci.yml) runs on pushes to `main` and PRs to `main`. Runtime, test, configuration and workflow changes run syntax/boundary checks, dependency audits/signatures, Node 22/24 unit and loopback browser tests, Windows unit tests and an installed-package smoke test. Packaged documentation changes run release/link checks without the test matrix. Site and issue-template changes use lightweight gates. New unclassified paths receive full checks. The required `CI gate` validates both successes and intentional skips; the workflow always starts so secondary-only PRs can merge.

[Security](.github/workflows/security.yml) scans JavaScript/TypeScript, GitHub Actions and the sample C# sources with CodeQL for relevant PR/main changes and weekly. Dependency review rejects newly introduced moderate-or-higher vulnerabilities. `Security gate` is required alongside `CI gate`. [Pages](.github/workflows/pages.yml) builds relevant site changes on PRs and deploys only from `main`. See the [repository admin guide](docs/repository-admin.md) for settings and promotion prerequisites.

[Release](.github/workflows/release.yml) publishes to npm only from a pushed `v<version>` tag that matches `package.json`, after the full CI run. Prerelease versions publish under the `next` dist-tag. It publishes with provenance through npm trusted publishing (configure the `release.yml` workflow and `npm` environment on npmjs.com) or, for the first publish, an `NPM_TOKEN` secret in the `npm` environment. A manual run takes an existing tag and defaults to `npm publish --dry-run`.
