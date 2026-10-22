# Service fixtures

Service fixtures are the generic mechanism for services that Paqvilo never executes: Power BI, AI Builder, Copilot and Dynamics apps. Each service operation answers in one of two ways: a trusted pack supplies a fixture, or the registry answers a disabled error. Paqvilo does not render, infer or orchestrate anything for these services.

## Disabled-by-default services

Module: `mirage/lib/service-fixtures.mjs`, created with `createServiceFixtureRegistry({ packs, diagnostic })`. Each service has a capability record `service:<name>` with kind `provider`, principal `none`, state owner `none` and lifecycle `in-process`. The service's level is the lowest level among its operations. Built-in operations are level `disabled`.

**Behaviour.** The registry resolves a service and operation pair to one answer. Resolution order matches `registerAddon`: a trusted pack's `serviceFixtures[service][operation]` (level `fixture`, source `pack:<id>`) wins; else a registered handler (level `behaviour`, source `core`); else the default fallback (level `disabled`, source `core`). Operations never registered resolve to the default fallback. Packs and the host call `resolve(service, operation).run(ctx)`. Paqvilo executes nothing for a disabled service.

| Level | Meaning |
| --- | --- |
| `disabled` | Not executed. The default answer is `{ error: { code: "ServiceDisabled", service, operation } }`. |
| `fixture` | A trusted pack supplies the answer. The fixture decides its own result shape (for example `{ html }` or `{ error }`). |
| `behaviour` | A registered deterministic handler answers. Only registered by code, not by packs. |

**Built-in services.** The built-in catalogue holds three operations, each with the default fallback only. Every other service is added by packs.

| Service | Built-in operations | Answer without a pack fixture |
| --- | --- | --- |
| `powerBi` | `embed` | `ServiceDisabled` |
| `aiBuilder` | `predict` | `ServiceDisabled` |
| `copilot` | `ask` | `ServiceDisabled` |
| `dynamics` | none; a pack adds its operations | `ServiceDisabled` |

**Out of scope.** Power BI and Fabric rendering, AI Builder model inference and Copilot orchestration are not implemented. The registry answers them with a pack fixture or the disabled error only.

**Pack override.** Export name `serviceFixtures`, shape `{ <service>: { <operation>: (ctx) => result } }`. Validated by `validateServiceFixtures(map)`: a non-object or an array throws a `TypeError`; each service must be an object; each operation must be a synchronous function (an `async` function is refused). Unknown service names are allowed. Two packs that register the same `service.operation` fail with `Ambiguous serviceFixtures registration for <service>.<operation> in packs <a> and <b>`. A pack entry that fails validation throws `Data pack <id>: ...`.

**Diagnostics.** `SERVICE_FIXTURE_DISABLED` (warning, with `service` and `operation`), emitted once per service and operation, the first time the default fallback answers.

**Capability report.** Each service record is read into the capability registry (`fromServices`), so every service and its level appear in the preflight report. See [capabilities and preflight](capabilities-and-preflight.md).

**Unverified.** None. The error code `ServiceDisabled` and the diagnostic code are local names, not native Power Platform codes.

Related guides: [data packs](data-packs.md) for the pack export contract and trust rules.
