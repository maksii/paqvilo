# CI round 4: evidence reader and collector security

This review follows CodeQL alert #339 (`js/file-system-race`) on `edae7704` and a new independent collector audit. All controlled inputs are invented files inside owned temporary directories. No real discovery, credential, token, live-reference or private business files were read. No alert, rule, baseline or suppression is dismissed or weakened.

## Descriptor-first navigation evidence

The reader previously checked a pathname before opening it. Three new controlled regressions fail against that implementation: a pathname substitution changes which descriptor is acquired; a file growing after validation is read without a fixed allocation bound; and nonregular descriptor metadata is not rejected. The initial file reports **4 passed / 3 failed / zero skipped** (`.paqvilo/audit/round4-codeql339-before.tap`).

The reader now opens first with `O_NOFOLLOW` and `O_NONBLOCK` where available. Before bytes are read it validates the descriptor's regular-file type, link count and size; the current pathname's type and exact identity; and physical containment. It reads from that same descriptor into at most the existing maximum plus one overflow byte. Nonblocking open avoids waiting on a substituted POSIX FIFO before its type can be rejected. Windows has neither optional flag on the review machine, so the regressions exercise its post-open validation fallback directly.

Independent review found a further identity defect: two distinct 64-bit file IDs can compare equal after conversion to JavaScript Numbers. A controlled collision using `9007199254740992n` and `9007199254740993n` is falsely accepted by the Number candidate (**0/1**), then rejected by exact BigInt observations (`round4-codeql339-precision-before.tap`). Descriptor and pathname observations now use `bigint: true`, including link-count and size checks.

The Mirage peer then challenged parent and output ownership. Ordinary source-directory substitution before open and an output-directory junction fail **0/2** before their fixes; a publication-leaf replacement during writing fails **0/1** before the final leaf check. The publisher now retains exact source/output directory identities, checks confinement around exclusive output open, and validates the opened leaf before and after descriptor writes. The controlled output link receives zero bytes; a foreign replacement leaf is neither overwritten nor removed. Only exact newly created failed leaves are discarded.

The final navigation reader/publisher suite passes **11/11 with zero skips**, retaining the existing filename, PNG, size, link/hardlink, private-field and post-flow final-image checks. Evidence is under ignored `.paqvilo/audit/round1-mirage/publisher-parent-{before,after}.tap` and `publisher-leaf-before.tap`. The independent reviewer checked the final parent/leaf changes against the descriptor-first and bounded-read contract.

## Collector substitution and publication

The independent collector probe replaced an approved source with a hardlink after its pathname check. The unchanged collector copied an invented private marker: `privateBytesCollected: true` with two links (`.paqvilo/audit/round4-collector-substitution-before.log`). The first six collector regressions report **1 passed / 5 failed / zero skipped** against the old implementation (`round4-collector-before.tap`). They cover actual file and ordinary parent substitutions, post-validation growth, an injected output hardlink, and an output-folder junction.

A separate zero-source probe injects `manifest.json` as a private-marker hardlink. The old manifest write overwrites that marker even with no collected source files (`round4-manifest-before.log`). A first collector candidate still failed its growth cleanup expectation; that failed TAP remains as `round4-collector-initial-candidate.tap` rather than being replaced by a passing rerun.

The final collector retains every exact folder/filename allowlist and accepted file's bytes. It captures source-directory identity, opens each candidate first, and validates regular-file type, single-link status, exact BigInt descriptor/path identities and physical confinement. A fixed 64 KiB buffer copies at most the captured descriptor size plus one overflow sentinel. Metadata and parent identity are revalidated after reading. There is no new artifact-size policy that silently excludes existing outputs.

Unvalidated snapshots and tentative publication live in fresh mode-0700 `.paqvilo/.ci-evidence-stage-*` directories. These do not match the workflow's `.paqvilo/ci-evidence-*/` upload glob. Only after every accepted snapshot and the manifest are validated is the complete publication directory renamed into the upload namespace. Artifact leaves and `manifest.json` share the same exclusive mode-0600 descriptor writer, with output directory and leaf checks before and after writes. Pre-existing private hardlinks cannot be overwritten.

Private staging identity is checked before snapshot I/O, publication and recursive cleanup. A replaced staging tree is refused and preserved, with zero snapshot bytes written and no upload-visible output; cleanup never recursively removes that injected replacement. Normal cleanup attempts all independent descriptor closes and private snapshot removal even if one close reports an error. Rejected source bytes remain outside all upload paths.

The final batch passes **28/28 with zero skips**: nine collector security cases, eleven navigation evidence cases and eight existing release-contract cases (`.paqvilo/audit/round4-collector-after.tap`). Formatting, targeted ESLint and diff checks pass. The Mirage peer independently reviewed collector source, swapped parents, private staging, manifest exclusivity and all nine collector cases and reported no further concrete defect. The reader owner independently reviewed the peer's publisher changes.

## Limits and required final qualification

These are controlled local boundary proofs, not an operating-system sandbox or an immutable snapshot against an actor with the same filesystem authority. The code relies on task-owned temporary/output storage, detects the tested identity and metadata changes, and refuses unsafe publication. If staging ownership is lost, it preserves the unknown replacement rather than deleting it. Linux-only no-follow/nonblocking behavior still requires its applicable hosted lane.

CodeQL alert #339 is **not claimed closed** by these local tests or source review. Fresh full validation, the final pushed-head CodeQL configurations and security/CI gates, and effective PR merge readiness must still confirm the result. No functional test assertion, action deadline, required lane, artifact allowlist or review baseline was removed to obtain the focused passes.
