# Toolchain versions and migrations

These are the supported development toolchains and the compatibility constraints
for Paqvilo 0.9.8. The consolidation PR records the closed Dependabot audit and validation results.

## Toolchains

The PCF and solution MSBuild projects use Microsoft.PowerApps.MSBuild.Pcf/Solution
2.15.1, reference assemblies 1.0.3 and the current MSBuild toolset. Their deployment
target remains the platform's .NET Framework contract.

| Area                     | Version or policy                                                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------------ |
| Node.js                  | 26.13.1, the latest active LTS release; consumers stay on the 26.x line.                               |
| npm                      | 12.2.2; CI installs the exact version before package commands.                                         |
| .NET SDK                 | 11.0.100, with servicing patches within its feature band allowed.                                      |
| .NET SDK clients         | net11.0; restore locks, executable paths and vulnerability checks use the same target.                 |
| Python SDK client        | CPython 3.15; dependencies are resolved with 3.15.2 and locked with published wheel SHA-256 hashes.    |
| Linux CI                 | Ubuntu 26.04, generally available in GitHub Actions.                                                   |
| Windows CI               | Windows 2025, retained as the current server runner generation.                                        |
| PCF build and preview    | pcf-scripts and pcf-start 1.51.1; every example control is built with this toolchain.                  |
| PCF compiler and linter  | TypeScript 5.9.3 and ESLint/@eslint/js 9.39.5, the newest releases within pcf-scripts' declared peers. |
| Root compiler and linter | TypeScript 6.0.3, typescript-eslint 8.72.2 and ESLint 10.15.0.                                         |
| Code Apps                | Vite 8.3.8 and @microsoft/power-apps 1.6.0.                                                            |
| Browser automation       | playwright-core 1.65.1, synchronized across root, Mirage and the example project.                      |
| Local and hosted CodeQL  | Action v4.39.3 and its default bundle 2.27.4, pinned by commit and platform archive digest.            |
| Workflow linters         | actionlint 1.7.12 and ShellCheck 0.11.0, already the latest releases.                                  |

All direct npm dependencies and overrides in tracked manifests were checked against
the npm registry, including the four standalone PCF controls and SDK test packages.
All GitHub Actions were checked against their current release tags; actions remain
pinned to full commit SHAs. NuGet references include the generated custom connector
host, which advances Newtonsoft.Json to 13.0.4 and logging abstractions to 11.0.0.
The npm and Python locks also refresh compatible transitive packages. Dependabot
coverage now includes the example project, its four PCF packages, the example C#
NuGet projects and the Python SDK requirements.

## Migration behavior

- npm 12 returns `npm pack --json` results as a map keyed by package name. The
  shared packaging reader accepts that format and the older array format, and
  rejects multiple or nonlocal archive filenames. Release checks, cache preparation
  and installed-package smoke use the same reader.
- npm 12 no longer reads or packs `npm-shrinkwrap.json`. The repository uses
  `package-lock.json` and ships its synchronized snapshot as `paqvilo-lock.json`
  for dependency inspection and installed-package repair. A repair creates
  a temporary `package-lock.json` from that snapshot for `npm ci`, then removes only
  its unchanged temporary file. An existing or concurrently changed lock is preserved.
  After changing root dependencies with npm 12, copy the updated `package-lock.json`
  to `paqvilo-lock.json` before validation. Bootstrap still accepts the legacy
  snapshot in older installed packages. Cache preparation opts in to fetching
  only its explicitly selected root archive URLs with `--allow-remote=root`.
- Windows CI runs portable commands in Bash so PowerShell does not consume npm's
  script-argument separator. The Windows service operation retains explicit `pwsh`.
  In interactive PowerShell, use `npm.cmd run <script> -- <arguments>` when forwarding arguments through npm.
- Playwright 1.65.1 includes the Windows TCP port randomization fix upstream. The
  old feature-list override is retired. Browser tests retain a reviewed upstream
  default snapshot and exercise launch, persistent contexts and server connections
  across package copies, real loopback HTTP, caller options and explicit timeouts.
  Anonymous capture extends the reviewed upstream feature switch to disable Windows account sign-in,
  while keeping its debugging port as a separate argument.
- actionlint 1.7.12 predates the Ubuntu 26.04 hosted label. Its configuration adds
  only that exact generally available label; workflow and shell checks remain active.
- The four standalone PCF projects lock and audit their complete npm trees. Overrides
  update the legacy telemetry dependency to Application Insights 3.17.1, select HTTP
  instrumentation 0.223.2 within its OpenTelemetry 2 family, and use minimatch 11.0.8.
  These remove the inherited OpenTelemetry and glob denial-of-service advisories.
  The solution projects explicitly package `Unmanaged`, matching their exported
  metadata when the current MSBuild release builds a Release configuration.
- The offline benchmark accepts `--progress` for ordered phase diagnostics on stderr while keeping
  its JSON result on stdout. Its report also identifies whether the Git baseline was available.

## Compatibility constraints

- TypeScript 7 requires upstream parser support before the root can migrate.
- PCF tooling currently declares TypeScript 4/5 and ESLint 8/9 peers. Its own latest
  release therefore constrains those examples even though ESLint 9 is deprecated.
  Installation does not bypass peer dependency validation.
- jQuery 3.7.1, Moment 2.31.0 and the Bootstrap compatibility implementation describe
  a portal runtime surface. Upgrading them as general development tools would alter
  that surface. The existing Dependabot exclusions remain explicit.
- Dataverse plug-in examples retain their net462 deployment target. Their build
  compiler advances with the SDK. Microsoft.CrmSdk.CoreAssemblies 9.0.2.60 and
  Microsoft.NETFramework.ReferenceAssemblies 1.0.3 are already current.
- Recorded parity cases, public source-capture commits, API protocol versions and
  sample assembly identities are evidence or compatibility contracts, not rolling
  tooling pins. They are preserved.

Upstream references: [Node release metadata](https://nodejs.org/dist/index.json),
[.NET release metadata](https://builds.dotnet.microsoft.com/dotnet/release-metadata/releases-index.json),
[Python 3.15.2](https://www.python.org/downloads/release/python-3152/),
[PCF package metadata](https://registry.npmjs.org/pcf-scripts/latest),
[TypeScript parser package metadata](https://registry.npmjs.org/typescript-eslint/latest),
[CodeQL defaults](https://github.com/github/codeql-action/blob/v4.39.3/src/defaults.json)
and [GitHub runner images](https://github.com/actions/runner-images).

Validation results belong in the consolidation PR and its final-head checks. This
inventory alone does not establish passing tests or merge readiness.
