# Toolchain versions and dependency upgrades

The development toolchain of Paqvilo 0.9.8, where each version is pinned, and the constraints to respect when
upgrading. Contributor setup is in [CONTRIBUTING](../CONTRIBUTING.md).

## Pinned versions

| Area                     | Version                                                                       | Pinned in                                                             |
| ------------------------ | ----------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Node.js                  | 26.13.1; consumers need `^26.13.1`                                            | `.node-version`, `package.json` `engines`                             |
| npm                      | 12.2.2; CI installs it before any package command                             | `package.json` `packageManager`, workflows                            |
| .NET SDK                 | 11.0.100, later 11.0.1xx patches allowed                                      | `global.json` (`rollForward: latestPatch`)                            |
| .NET SDK client gates    | `net11.0`, restored with lock files                                           | `mirage/test-sdk/*/Gate/Gate.csproj`                                  |
| Python SDK client        | CPython 3.15, locked with wheel SHA-256 hashes                                | `mirage/test-sdk/python-dataverse/requirements.lock.txt`              |
| CI runners               | `ubuntu-26.04`, `windows-2025`                                                | workflows; `.github/actionlint.yaml` registers the Ubuntu 26.04 label |
| Root compiler and linter | TypeScript 6.0.3, typescript-eslint 8.72.2, ESLint 10.15.0                    | `package.json`                                                        |
| Browser automation       | playwright-core 1.65.1 in the root, Mirage and the example project            | each `package.json`                                                   |
| Code Apps                | Vite 8.3.8 (root), @microsoft/power-apps 1.6.0 (example project)              | `package.json`, `examples/project/package.json`                       |
| PCF examples             | pcf-scripts and pcf-start 1.51.1, TypeScript 5.9.3, ESLint 9.39.5             | `examples/project/components/pcf-*/package.json`                      |
| PCF/solution MSBuild     | Microsoft.PowerApps.MSBuild.Pcf and .Solution 2.15.1                          | `*.pcfproj`, `*.cdsproj`                                              |
| Plug-in examples         | `net462`; Microsoft.CrmSdk.CoreAssemblies 9.0.2.60, ReferenceAssemblies 1.0.3 | `*.csproj`                                                            |
| CodeQL                   | bundle 2.27.4 of the pinned `codeql-action`, verified by archive digest       | `.github/workflows/security.yml`, `scripts/codeql.mjs`                |
| Workflow linters         | actionlint 1.7.12, ShellCheck 0.11.0, verified by archive digest              | `scripts/check-workflows.mjs`                                         |

GitHub Actions are pinned to full commit SHAs (the repository requires it). Dependabot
(`.github/dependabot.yml`) proposes weekly updates for Actions, every npm project (root, Mirage, example projects, the
four PCF controls, the SDK client packages), the NuGet SDK gates and plug-in projects, and the Python requirements.

## When upgrading

- **Root lockfile.** npm 12 neither reads nor packs `npm-shrinkwrap.json`. The package ships `paqvilo-lock.json`, an
  exact copy of `package-lock.json` that the installed-package bootstrap uses to repair dependencies. After changing
  root dependencies, copy `package-lock.json` to `paqvilo-lock.json`; `release:check` fails while they differ.
- **`npm pack --json`.** npm 12 returns a map keyed by package name; the shared packaging reader also accepts the older
  array and rejects several or non-local archives. Release checks, cache preparation and package smoke use it.
- **Audit.** `npm run audit:dependencies` audits the root (`paqvilo-lock.json`), Mirage, the company-operations
  example, the three npm SDK clients and the four PCF controls, and fails on any finding not accepted in
  `scripts/audit-dependencies.mjs`. The one accepted finding is the dev-only minimatch copy that
  eslint-plugin-import-x 4.17.1 needs; it stops matching when that version or its dependents change.
- **PCF peers.** pcf-scripts declares TypeScript 4/5 and ESLint 8/9 peers, which cap the PCF examples' TypeScript and
  ESLint versions. Installs do not bypass peer validation. The PCF projects override `applicationinsights`,
  `@opentelemetry/instrumentation-http` and `minimatch` to remove inherited advisories.
- **TypeScript 7** needs upstream parser support (typescript-eslint) before the root can move; Dependabot ignores
  TypeScript major updates.
- **Portal runtime libraries.** jQuery 3.7.1, Moment 2.31.0 and the Bootstrap compatibility layer reproduce the portal
  runtime surface; Dependabot ignores jQuery and Moment so routine upgrades do not change emulator behavior.
- **Plug-in examples** keep their `net462` deployment target; their compiler advances with the SDK. The solution
  projects package `Unmanaged`, matching their exported metadata.
- **actionlint** 1.7.12 predates the `ubuntu-26.04` label; `.github/actionlint.yaml` adds only that label. Remove it
  when actionlint knows the label.
- **Not tooling pins.** Recorded parity cases, public source-capture commits, API protocol versions and sample assembly
  identities are evidence or compatibility contracts: do not bump them with toolchain upgrades.
- **Windows shells.** CI runs portable commands in Bash so PowerShell does not consume npm's `--` separator; in
  interactive PowerShell use `npm.cmd run <script> -- <arguments>`.

Upstream metadata: [Node releases](https://nodejs.org/dist/index.json),
[.NET releases](https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json),
[pcf-scripts](https://registry.npmjs.org/pcf-scripts/latest),
[typescript-eslint](https://registry.npmjs.org/typescript-eslint/latest) and
[GitHub runner images](https://github.com/actions/runner-images).
