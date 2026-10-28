# Test suite audit record (October 2026)

The [0.9.8 finalization](0.9.8-finalization.md) consolidates the two new review rounds, the additional hosted-failure reviews, their fixes and controlled evidence, retained scope, and required final validation. The partition tables below are historical snapshots of the original audit. The [earlier 0.9.8 follow-up](0.9.8-follow-up.md) retains its commit-specific quality and performance measurements and observations; those results do not qualify later changes.

Every test file in the toolkit was reviewed against the behaviour it claims to cover: Lense unit (`test/`) and browser
(`test-browser/`) suites, Mirage unit (`mirage/test/`) and browser (`mirage/test-browser/`) suites, the example
projects, the SDK client gates (`mirage/test-sdk/`), the volume checks (`mirage/test-volume/`), CI workflows and the
scripts that run them. Each partition file below has one row per test file (or per workflow, script or optimisation)
with the requirement it covers, its findings and their resolution.

| Partition                                                                                     | Scope                                                  |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| [lense-unit-0](lense-unit-0.md), [lense-unit-1](lense-unit-1.md), [lense-gaps](lense-gaps.md) | `test/` and its shared helpers                         |
| [lense-browser-0](lense-browser-0.md), [lense-browser-1](lense-browser-1.md)                  | `test-browser/` and its helpers                        |
| [mirage-unit-0](mirage-unit-0.md) … [mirage-unit-11](mirage-unit-11.md)                       | `mirage/test/` (0 also owns the shared fixtures)       |
| [mirage-browser-0](mirage-browser-0.md), [mirage-browser-1](mirage-browser-1.md)              | `mirage/test-browser/`                                 |
| [examples-sdk](examples-sdk.md)                                                               | example projects, C# probes, SDK gates, volume checks  |
| [ci-infra](ci-infra.md)                                                                       | workflows, `scripts/ci.mjs`, change scope, hooks       |
| [cache-correctness](cache-correctness.md)                                                     | stat-keyed caches in `lense/` and `mirage/lib/`        |
| [perf-lense](perf-lense.md), [perf-mirage](perf-mirage.md)                                    | measured runtime optimisations and rejected candidates |

Recurring finding classes and their resolution:

- Fixed sleeps, polling loops and wall-clock assertions replaced by the real signal (scheduler drain, reload events,
  observed requests, gates, `node:test` mock timers, injected clocks) or by operation counts where the contract is
  about work; remaining bounds are named and derived from documented product budgets.
- `t.after` hooks run in registration order and a failing hook skips later ones: runtimes, servers and browsers now
  close through `ownedFixture` before their directories are removed, and servers drop keep-alive sockets first.
- Hidden environment dependencies: 8.3 short and symlinked temp paths, inherited `GIT_*` and `PAQVILO_*` variables,
  locale, time zone, `python3`, ports in the ephemeral range, and Windows profile files held after browser close.
- Silent skips: CLR tests now skip only off Windows and fail when the prepared SDK fixture is missing; the public
  ecosystem import checks and the previously unrun SDK and volume gates now run in CI.
- Product defects found by the audit were fixed with regressions, including same-tick stale caches, a fingerprint that
  hashed the implementation twice, desktop flows outside the scheduler, and application-user provisioning inside the
  server-logic time limit.
