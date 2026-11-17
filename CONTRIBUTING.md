# Contributing to Paqvilo

Reproducible bug reports, documentation fixes and reusable platform fixes are welcome. For portal development with
Paqvilo, use the [getting started guide](docs/getting-started.md); this guide covers work on the toolkit checkout.
AI agents also follow [AGENTS.md](AGENTS.md).

## Set up

| Tool          | Version                                                               | Pinned in                                                |
| ------------- | --------------------------------------------------------------------- | -------------------------------------------------------- |
| Node.js       | 26.13.1 (`engines`: `^26.13.1`)                                       | `.node-version`, `package.json`                          |
| npm           | 12.2.2                                                                | `packageManager`                                         |
| .NET SDK      | 11.0.100, or a later 11.0.1xx patch (`rollForward: latestPatch`)      | `global.json`                                            |
| Python        | 3.15 (Mirage TLS tests and the Python SDK gate)                       | `mirage/test-sdk/python-dataverse/requirements.lock.txt` |
| Also required | Git, OpenSSL (Git for Windows' bundled copy is found), Edge or Chrome |                                                          |

```sh
git clone https://github.com/maksii/paqvilo.git
cd paqvilo
npm run setup:repo
```

`setup:repo` installs the locked dependencies of the root, Mirage, the SDK clients and the example projects
(`npm run ci:prepare -- --quality`), primes the offline package-smoke cache (`npm run cache:package`) and sets
`core.hooksPath` to the tracked `.githooks/` in this checkout only (`npm run hooks:install`). `npm run setup` runs only
the dependency bootstrap that the published package also uses. In PowerShell, call
`npm.cmd` when passing script arguments after `--`.

Mirage unit lanes fail when Python or OpenSSL is missing. On Linux, CI installs matching Chromium with
`node node_modules/playwright-core/cli.js install --with-deps chromium`.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/): `<type>[(scope)][!]: <description>`,
  for example `fix(lense): preserve language identity` or `feat(mirage)!: change session contract`. Separate a
  body or footer from the subject with a blank line; mark breaking changes with `!` or a `BREAKING CHANGE:` footer.
- PRs are squash-merged with the PR title as the commit subject, so the title follows the same convention
  (`PR_TITLE="<title>" npm run check:contribution`).
- Never bypass hooks with `--no-verify`; a push that skipped them reaches CI unvalidated.
- Every test you add or change declares its kind: see [test kinds](docs/test-kinds.md).
- A runtime change needs relevant regressions and a passing `npm run validate`. Tests use invented schemas and
  identities; browser tests use synthetic loopback fixtures, never a live portal.
- A documentation-only change needs only the hooks below; check that linked guides and copyable commands still match
  the CLI.
- For a bug report, include the toolkit version, export format, command, expected behavior and redacted diagnostics.
  A minimal invented fixture is more useful than a private portal export.

## Checks

| Command                                     | Runs                                                                                                |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm run format`                            | Prettier, writing each changed file atomically (temporary files under `.paqvilo/format/`)           |
| `npm run quality`                           | `format:check`, `lint` (ESLint, no warnings), `check:workflows`, `review:code`                      |
| `npm run check`                             | `node --check` on every first-party module, then `check:boundary` (`scripts/project-boundary.mjs`)  |
| `npm run check:workflows`                   | actionlint 1.7.12 and ShellCheck 0.11.0 over the workflows and Git hooks                            |
| `npm run review:code`                       | Generated watcher drift, then dead-code and duplication review ([code review](docs/code-review.md)) |
| `npm run check:sonar-rules -- --base <rev>` | Local approximation of the SonarQube rule profile on changed files                                  |
| `npm run check:test-tags -- <files>`        | Test-kind tags ([test kinds](docs/test-kinds.md))                                                   |
| `npm run release:check`                     | Lockfile sync, package allowlist, documentation links and editor tasks                              |
| `npm run audit:dependencies`                | `npm audit` of every lockfile                                                                       |
| `npm test`, `npm run test:browser`          | Lense unit and browser suites; Mirage has its own under `mirage/`                                   |
| `npm run ci:verify`                         | Lanes selected from the diff against `origin/main` (`--base <ref>` to change it)                    |
| `npm run validate`                          | `ci:verify --full`: every lane, fresh                                                               |
| `npm run check:pr -- --pr <n>`              | GitHub's effective merge state of a pushed PR                                                       |

`check:workflows` downloads its pinned tools for Windows x64, Linux x64/arm64 and macOS x64/arm64 from the GitHub
releases API (other platforms stop with a message); `node scripts/check-workflows.mjs --provision` only downloads and
verifies them. When `GITHUB_TOKEN` or `GH_TOKEN` is set, it is sent to `api.github.com` only, and a request refused
with 401 is repeated once without it.

## Git hooks

| Hook         | Runs                                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pre-commit` | In a snapshot of the index: `check-test-tags --staged`, then `quality`, `release:check` and `site:build` as the staged paths require. Unstaged edits cannot make staged code pass. |
| `commit-msg` | `scripts/conventional-commit.mjs`                                                                                                                                                  |
| `pre-push`   | `npm run ci:verify` (`--full` on `main`). Needs a clean worktree and index, and every pushed ref must be the checked-out commit.                                                   |

## Local validation

`ci:verify` selects suites with the same classifier as GitHub (`.github/scripts/change-scope.mjs`): shared
configuration, dependency, build and unknown paths select every suite; isolated Lense overlay changes select Lense.
`--full` prepares every fixture, runs every unit and browser lane, audits all lockfiles and registry signatures,
smoke-tests the package and builds the site. Hosted CI runs the same `ci.mjs verify --suite <suite> --unit|--browser`
process per job.

**Parallelism.** Local validation prepares once, then runs its independent steps (each lane, each quality script,
`check`, `release:check`, package smoke, site build) concurrently, each to its end, so one pass reports every
failure. By default one step runs per four CPUs and per 4 GiB of memory. Set `git config paqvilo.ci.jobs <n>` or
`PAQ_CI_JOBS=<n>`; `1` gives serial streamed output. Each step logs to `.paqvilo/ci/runs/<run>/logs/<step>.log`, and a
failed step's log tail is printed. Hosted CI runs one step at a time.

**Receipts.** A successful run writes a receipt for the source tree, toolchain and platform. A later scoped pre-push of
the same clean tree reuses it after refreshing dependency audits and signatures. `--full` always runs fresh, and
starting any validation revokes the previous receipt, so a failed rerun never leaves a qualifying pass. A `--full`
run can qualify a fully staged tree before you split it into commits: worktree files must match the index and no
non-ignored file may be untracked; the final clean `HEAD` tree must then match the receipt. A local pass qualifies
that tree on that platform only; confirm hosted checks on the final pushed commit separately.

**Workspace lease.** Validation and dependency preparation hold an exclusive lease (`.paqvilo/ci/workspace.lock`);
a second independent run in the same checkout fails before changing dependencies. A lease left by a killed run is
taken over once neither its owner nor any of its worker processes runs; while a worker still runs it is refused, so
stop those processes before deleting the lock by hand. A new run also ends lane process trees that an earlier run of
the checkout left running and names each one. CI state must be physical directories inside the checkout. Do not edit
tracked files while a push validates: a changed tree fails the run.

**What local validation adds to the hosted lanes:**

- **CodeQL.** `scripts/codeql.mjs` runs the Security workflow's `security-extended` analysis for every language with
  the bundle pinned by the workflow's `codeql-action`, downloaded once (digest-verified) into the main checkout's
  `.paqvilo/tools/`. It needs the GitHub CLI signed in. Results are matched by fingerprint against alerts dismissed on
  `main` and open PRs; any other result fails, as `Security gate` would. Runs are kept under
  `.paqvilo/ci/codeql-runs/<run>/`. It runs alone before the other steps because it uses every CPU.
- **SonarQube rules.** `scripts/sonar-rules.mjs` runs the eslint-plugin-sonarjs recommended rules on changed source
  and test files (untracked included), each rule only on the scope (`Main` or `Tests`) its SonarJS metadata declares,
  plus the unicorn and typed rules that matched server findings on sources. It fails only on findings the change
  adds (a moved line is not new). Data-flow rules stay server-only; the hosted gate is authoritative. The rule that
  requires an assertion in every test follows a helper only when it is a function declaration in the same file.
  Justify a deliberate finding with `// NOSONAR: <reason>` on its line.
- **Test kinds** against the default branch (`check-test-tags.mjs --base origin/main`).
- **Browser channels.** On Windows every browser lane runs in Chromium and Edge, as the hosted Windows matrix does.
- **Runner environment.** Windows lanes see `TEMP` through an 8.3 short alias, as hosted runners do
  (`C:\Users\RUNNER~1\…`); compare physical paths. The package smoke starts from an empty npm cache, so every offline
  install must be primed by `cache:package`. Tests may not assume ignored folders such as `.paqvilo/` exist. Unit
  lanes run under `NODE_V8_COVERAGE`, as the hosted SonarQube lanes do, writing to a directory under
  `.paqvilo/ci/runs/<run>/` that is removed when the command ends (allow about 2 GB of free disk).
- **Changed tests.** Scoped validation reruns changed Lense and Mirage test files from unpushed commits twice more
  after their unit and Chromium browser lanes pass (not example tests or Edge lanes, and not with `--full`). Set
  `git config paqvilo.ci.repeat <n>` or `PAQ_CI_REPEAT=<n>`; `0` turns it off.

**Downloaded fixtures.** `ci:prepare` for Mirage unit tests downloads public MIT-licensed ecosystem exports from
GitHub archives at pinned commits, verifies each SHA-256 and extracts only the needed subtrees into ignored
`.paqvilo/ci/ecosystem/`; `ci:verify` sets `PAQ_TEST_ECOSYSTEM_FIXTURES` for `mirage/test/short-key-fixtures.test.mjs`.
A direct `npm --prefix mirage test` without it skips those checks. CI preparation may read registry metadata for the
example project's exact dependency pins (it has no lockfile); the example install and package smoke stay offline.
`npm run ci:sdk:prepare` prepares the SDK client fixtures and `npm run ci:sdk` runs them; the ServiceClient gate needs
loopback port 80 free.

## Project boundary

- Reusable source-overlay behavior belongs in `lense/`; rendering, platform semantics and simulation in `mirage/`.
  `test/` and `test-browser/` cover Lense and integration; `mirage/test/` and `mirage/test-browser/` cover Mirage.
- Customer data, portal extracts, environment catalogues, personas, generators, acceptance runners and business
  evidence belong in a separate project; see [project extensions](docs/project-extensions.md).
- The release allowlist (`scripts/release-check.mjs`) and `scripts/project-boundary.mjs` protect the package and the
  tracked tree. Add reusable tools to `package.json` and the allowlist together. Never add automatic project-pack
  discovery or a business-name condition to core. Platform behavior an export cannot reveal is a per-site `observed`
  setting with evidence.
- Do not commit personal configuration, session discovery, tokens, browser cookies or live captures.
- Original Paqvilo code is AGPL-3.0-only; third-party assets keep their own terms and notices.

## Continuous integration

| Workflow                                                                                 | Runs on                                              | Required gate   |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------- |
| [CI](https://github.com/maksii/paqvilo/blob/main/.github/workflows/ci.yml)               | Pushes to `main`; PRs to `main` and `0.9.8`; release | `CI gate`       |
| [Security](https://github.com/maksii/paqvilo/blob/main/.github/workflows/security.yml)   | Same pushes and PRs; weekly                          | `Security gate` |
| [SonarQube](https://github.com/maksii/paqvilo/blob/main/.github/workflows/sonarqube.yml) | Pushes to `main` and `0.9.8`; PRs to them            | none            |
| [Pages](https://github.com/maksii/paqvilo/blob/main/.github/workflows/pages.yml)         | Site changes; deploys only from `main`               | none            |
| [Release](https://github.com/maksii/paqvilo/blob/main/.github/workflows/release.yml)     | `v*` tags except previews; manual dispatch           | none            |

- PR runs select Lense, Mirage and example suites from the complete base-to-head diff and literal import consumers.
  Pushes to `main`, manual runs and release calls run every suite and the package smoke.
- Lanes: Ubuntu 26.04 and Windows 2025 unit lanes, browser lanes on Linux Chromium, Windows Chromium and Windows Edge
  (`PAQ_CI_BROWSER`), the SDK client gates on both platforms when Mirage or shared code changes, and the package
  smoke. Long suites are split into `--shard <index>/<total>` jobs; the gate requires every shard. Mirage and example
  lanes install the .NET SDK from `global.json`.
- A documentation-only PR skips the runtime matrices but keeps quality and applicable release checks. Editing a PR's
  title, base or description reruns CI; the required `CI gate` name never changes and accepts only successes or
  intended skips. Never use CI skip tokens to bypass required gates.
- Security runs CodeQL (`security-extended`) for `actions`, `csharp` and `javascript-typescript` on every PR, including
  documentation-only ones, and dependency review (moderate or higher fails) when dependencies change.
- When a SonarQube quality gate fails, the job's last step prints the failed conditions, new-code issues and hotspots.
- Before reporting a PR green, run `npm run check:pr -- --pr <number>` with the GitHub CLI signed in. It requires the PR
  head to equal your checked-out `HEAD`, both gates successful, no pending or failed checks, and merge state `CLEAN`;
  `BLOCKED` or `UNKNOWN` is not ready. A matrix job cancelled by an edit right after a push counts as replaced once a
  newer run of that workflow reports on the head.

Repository settings, CodeQL triage and publishing: [repository maintenance](docs/repository-admin.md). Pre-merge
packages: [branch packages](docs/branch-packages.md). Toolchain pins: [toolchain versions](docs/dependency-upgrades.md).
