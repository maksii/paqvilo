# Testing branch packages before merge

Maintainers can publish a branch build through the existing [Release workflow](../.github/workflows/release.yml). It uses the configured npm trusted publisher, full CI gates and the `npm` environment. A colleague can install the exact preview version in their own project and run that project's tests before the branch is merged.

From an updated toolkit checkout with dependencies installed and GitHub CLI signed in, request a dry run:

```sh
node scripts/preview-release.mjs --branch feature/form-layout
```

To generate and publish a new testing package instead:

```sh
node scripts/preview-release.mjs --branch feature/form-layout --publish
```

Use any existing branch in this repository. `--repo owner/name` can select the repository explicitly. The account needs permission to create version tags and dispatch workflows. Local uncommitted changes are not included: the helper reads the remote branch's commit once and reads package metadata at that exact SHA. The selected commit must include this preview workflow and its scripts; older branches must merge or rebase those changes first. This works before merging to `main` because `release.yml` already exists on the default branch and the run is dispatched on the new tag.

The helper prints the version, source SHA, Git tag, npm tag, dry-run state and exact install command. Follow the run from its workflow URL or `gh run list --workflow release.yml --event workflow_dispatch`. The run summary repeats the install command. A dry run builds and tests the package and runs `npm publish --dry-run`; it does not make that version available on npm. Its `package` artifact can also be downloaded and installed as a local `.tgz` for testing.

After publishing completes, send the printed install command to the colleague. It uses `npm install --save-dev --save-exact paqvilo@<exact-version>` so their lockfile records the tested build. Run the consumer project's own tests there. The toolkit workflow runs invented fixtures and loopback tests only.

| Build | Git tag | npm channel |
| --- | --- | --- |
| Stable commit on main | `v0.9.4`, matching source metadata | `latest` |
| Main prerelease | For example `v0.9.4-rc.1`, matching source metadata | `next` |
| Branch preview | `v0.9.4-preview.<branch-token>.<timestamp>.g<commit-prefix>` | `preview-<branch-token>` |

The branch token is a readable, bounded branch name plus a hash of the full name. Branches such as `feature/a` and `feature-a` get different channels. The timestamp makes each request a new npm version; the commit prefix binds it to the source. Git tags are created once and never moved by the helper. The branch channel points to the most recently completed publication for that branch; use the exact version for reproducible acceptance evidence. Preview builds never update `latest` or `next` and do not create stable GitHub releases.

The workflow resolves the tag to an immutable SHA, stamps the preview version into `package.json`, `package-lock.json` and `npm-shrinkwrap.json` in runner checkouts, and validates that version through static checks, Node 22/24 Linux tests, Windows/CLR tests and the installed-package smoke test. Publishing downloads the resulting gated archive and verifies its metadata; it does not repack the source. Source versions and working checkouts stay unchanged. Normal stable releases retain the main-ancestry and matching-version checks.

To publish a tag already qualified by a dry run, rerun the workflow on that same tag with publishing enabled:

```sh
gh workflow run release.yml --ref <printed-git-tag> -f tag=<printed-git-tag> -f dry_run=false
```

This reruns all gates on the same immutable source/version. If dispatch failed after tag creation, the helper prints the exact retry command; do not move the tag. An already-published version is skipped on rerun because npm versions are immutable. When finished testing, restore the intended stable dependency explicitly, for example `npm install --save-dev --save-exact paqvilo@latest`, and review the consumer lockfile.

The existing trusted publisher must continue to name workflow `release.yml` and environment `npm`. Preview tags fit the existing `v*` environment policy; no branch-wide publishing permission or additional token is needed. See [GitHub manual workflow runs](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow) and [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/). A dry run does not prove permission for an actual registry write.

## Preview retention

Run cleanup locally after publishing previews or a stable release. All stable releases remain
available. The default policy keeps at most **three unreleased previews total**, across all
branches, by actual npm publication time. Once a stable version is published, its previews
and previews with older base versions become candidates regardless of the cap. Publishing
`0.9.6`, for example, makes every `0.9.6-preview.*` and older generated preview a candidate.
Only the exact version format generated by our branch publisher is eligible; release candidates,
other prereleases and the legacy staging version are preserved.

Preview the exact candidate versions, then apply cleanup interactively with your npm login:

```sh
npm run preview:cleanup
npm login
npm run preview:cleanup -- --apply
```

Skip `npm login` if your existing login works. The script inherits your terminal so npm can
request its normal two-factor/browser approval for each deletion. It neither loads `.env`
nor stores tokens or approval codes. Publishing continues through the existing OIDC trusted
publisher; cleanup has no GitHub workflow, maintenance secret or scheduled monitor. This avoids
depending on the [deprecated sensitive uses of 2FA-bypass tokens](https://github.blog/changelog/2026-07-08-npm-install-time-security-and-gat-bypass2fa-deprecation/).

Use `--keep <count>` to override the default three for an individual run. Without `--apply`,
the command only reads registry metadata. It prints exact candidates/reasons, re-reads state
before each deletion and verifies removal. It invokes no package scripts and never uses a
version range or whole-package unpublish. Stable versions and previews referenced by `latest`,
`next` or a custom tag are protected; protected previews can exceed the cap and are reported.
The matching generated branch tag is removed by npm when its target is unpublished. Git tags
and source commits remain. Verification catches npm CLI's silent handling of HTTP 404 writes:
an exit code of zero alone is not proof of removal. A refusal or failed verification stops
cleanup. Previously removed versions stay removed; re-running safely skips them.

Removal is permanent and existing lockfiles pinned to retired previews will no longer install.
Deleted version numbers cannot be reused. npm enforces its [unpublish policy](https://docs.npmjs.com/policies/unpublish/)
on the individual requests; the script does not infer eligibility from aggregate download
counts. If npm refuses removal, deprecation can warn consumers but cannot remove the entries
from npm's versions list.
