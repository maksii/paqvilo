# Testing branch packages before merge

Maintainers can publish a branch build through the
[Release workflow](https://github.com/maksii/paqvilo/blob/main/.github/workflows/release.yml), with the full CI gates,
the `npm` environment and the npm trusted publisher. A colleague then installs that exact version in their project and
runs its tests before the branch is merged.

## Request a preview

From a toolkit checkout with dependencies installed and the GitHub CLI signed in:

```sh
node scripts/preview-release.mjs --branch feature/form-layout             # dry run
node scripts/preview-release.mjs --branch feature/form-layout --publish   # publish to npm
```

`--repo owner/name` selects the repository (default: the current one). The account needs permission to create tags and
dispatch workflows. The helper reads the branch's commit on GitHub (local changes are not included), reads
`package.json` at that commit, creates the preview tag and dispatches `release.yml` on it. The commit must contain the
preview-capable `release.yml`; merge or rebase it into older branches first. The helper prints the version, source SHA,
Git tag, npm tag, dry-run state, workflow URL and install command; the run summary repeats the install command. Follow
the run with `gh run list --workflow release.yml --event workflow_dispatch`.

A dry run builds and tests the package and runs `npm publish --dry-run`; nothing reaches npm, but its `package`
artifact can be installed as a local `.tgz`. To publish a tag that a dry run qualified, rerun the gates on the same tag:

```sh
gh workflow run release.yml --ref <printed-git-tag> -f tag=<printed-git-tag> -f dry_run=false
```

If dispatch fails after the tag was created, the helper prints this retry command; never move the tag. A version
already on npm is skipped on rerun.

## Versions and channels

| Build                 | Git tag                                                      | npm dist-tag             |
| --------------------- | ------------------------------------------------------------ | ------------------------ |
| Stable commit on main | `v0.9.8`, matching `package.json`                            | `latest`                 |
| Main prerelease       | for example `v0.9.8-rc.1`, matching `package.json`           | `next`                   |
| Branch preview        | `v0.9.8-preview.<branch-token>.<timestamp>.g<commit-prefix>` | `preview-<branch-token>` |

The branch token is the lower-cased branch name (at most 32 characters) plus 8 hex characters of its SHA-256, so
`feature/a` and `feature-a` get different channels. The timestamp makes each request a new version; the 12-character
commit prefix binds it to its source. A preview dist-tag points to the latest publication for that branch. Previews
never move `latest` or `next` and create no GitHub release.

The workflow stamps the preview version into `package.json`, `package-lock.json` and `paqvilo-lock.json` in its runner
checkouts only, runs the static checks, Linux and Windows unit and browser lanes and the installed-package smoke on
that version, and publishes the archive those gates built after verifying its metadata. Stable tags keep the
matching-version and `main`-ancestry checks.

## Install in a consumer project

```sh
npm install --save-dev --save-exact paqvilo@<exact-version>
```

Record the exact version, the consumer's `package-lock.json`, Node/npm versions and platform with any acceptance
evidence, and reproduce with `npm ci`: a fresh install of the same toolkit version, including from a local `.tgz`, can
resolve newer compatible transitive dependencies. The package smoke writes `dependency-evidence.json` beside its
archive, comparing the toolkit's and the fresh consumer's dependency layouts. When done, return to a stable version
explicitly (`npm install --save-dev --save-exact paqvilo@latest`) and review the lockfile.

## Preview retention

Clean up locally after publishing previews or a stable release:

```sh
npm run preview:cleanup                 # print the plan; reads registry metadata only
npm login                               # if your login has expired
npm run preview:cleanup -- --apply      # unpublish the candidates
```

- Only versions in the generated preview format are candidates; stable versions, release candidates and other
  prereleases are never removed. At least one stable `latest` must exist.
- A preview whose base version is at or below the newest stable release is removed.
- Of the rest, the newest three by publication time are kept across all branches (`--keep <n>`, 1 to 100). A preview
  that another dist-tag (`latest`, `next`, a custom tag or another branch's channel) points to is kept, counts toward
  the cap and is reported; the cap can then be exceeded.

`--apply` runs `npm unpublish paqvilo@<version>` for each candidate in your terminal, so npm can ask for its normal
two-factor or browser approval. It never uses a range or whole-package unpublish, runs no package scripts, reads no
`.env` and stores no token. Before each removal it re-plans from fresh registry metadata, and afterwards it confirms the
version is gone, because npm can exit 0 after a refused write; a failed removal stops cleanup, and a rerun skips what
is already removed. There is no cleanup workflow or maintenance token: publishing stays on trusted publishing.

Removal is permanent: lockfiles pinned to a removed preview stop installing, and the version number cannot be reused.
npm applies its [unpublish policy](https://docs.npmjs.com/policies/unpublish/) to each request; when it refuses,
deprecation can warn consumers but leaves the version listed. Git tags and commits remain.
