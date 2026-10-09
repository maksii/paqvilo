# Contributing to Paqvilo

Install Node.js 22/24, Git and Edge/Chrome, then run `npm run setup`. Linux CI installs matching Chromium with `node node_modules/playwright-core/cli.js install --with-deps chromium` and selects it using `PAQVILO_BROWSER=chromium`.

Run `npm run validate` before proposing a change. It checks first-party syntax, Lense unit/browser regressions, Mirage unit/browser regressions and the release boundary. Browser tests run only against synthetic loopback fixtures. Runtime changes need relevant regressions; do not use a live portal as a test prerequisite.

Three optional ecosystem import checks skip when public sample checkouts are absent. Set `PAQVILO_ECOSYSTEM_FIXTURES` to a directory containing `microsoft__power-pages-samples`, `microsoft__gov-apptemplates`, and any supported public Solution checkout listed in `mirage/test/short-key-fixtures.test.mjs`. These checks read local exports only; the committed synthetic fixtures always run.

Reusable source-overlay behavior belongs in `lense/`; rendering, platform semantics and simulation belong in `mirage/`. Tests under `test/` and `test-browser/` cover Lense and integration; `mirage/test/` and `mirage/test-browser/` cover Mirage. Use invented schemas and identities. Customer data, portal extracts, environment catalogues, personas, generators, acceptance runners and business evidence belong in a separate project. [Extension guidance](docs/project-extensions.md) describes the supported registration contract.

The release allowlist and `scripts/project-boundary.mjs` protect the distribution and tracked source tree. Add reusable tools to `package.json` and the allowlist together. Never add automatic project-pack discovery or a business-name condition to core. A platform behavior that an export cannot reveal must be a per-site `observed` setting with evidence.

Keep personal configuration and storage ignored. Do not commit session discovery, tokens, browser cookies or live captures. Retain upstream license notices. Contributions to original Paqvilo code use AGPL-3.0-only; third-party assets retain their original terms. The project license permits commercial distribution subject to source and notice obligations.

Use `npm run release:check` and `npm pack --ignore-scripts` to prepare a distribution locally. Publishing a package, pushing a repository or changing the hosting environment is a separate action.

## Continuous integration and releases

[CI](.github/workflows/ci.yml) runs on pushes to `main` and on pull requests: syntax and boundary checks, release check, dependency audit, Lense and Mirage unit and loopback browser tests on Node 22/24 (Chromium), unit tests on Windows, and an installed-package smoke test. Require the `CI gate` check in branch protection; it fails if any job fails.

[Release](.github/workflows/release.yml) publishes to npm only from a pushed `v<version>` tag that matches `package.json`, after the full CI run. Prerelease versions publish under the `next` dist-tag. It publishes with provenance through npm trusted publishing (configure the `release.yml` workflow and `npm` environment on npmjs.com) or, for the first publish, an `NPM_TOKEN` secret in the `npm` environment. A manual run takes an existing tag and defaults to `npm publish --dry-run`.
