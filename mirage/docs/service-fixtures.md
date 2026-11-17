# Service fixtures

Paqvilo never executes Power BI, AI Builder, Copilot or Dynamics app services. Each operation of such a service
answers either a trusted pack's fixture or a disabled error. Nothing is rendered, inferred or orchestrated.

## Disabled-by-default services

Each host resolves a service and operation to one answer, in this order:

| Level       | Source                                                 | Answer                                                               |
| ----------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| `fixture`   | a trusted pack's `serviceFixtures[service][operation]` | whatever the fixture returns (for example `{ html }` or `{ error }`) |
| `behaviour` | a handler registered in code (packs cannot)            | the handler's answer                                                 |
| `disabled`  | the default fallback                                   | `{ error: { code: 'ServiceDisabled', service, operation } }`         |

Built-in operations are `powerBi.embed`, `aiBuilder.predict` and `copilot.ask`, each with the fallback only; `dynamics`
and any other service exist only through packs. The first fallback answer for an operation reports
`SERVICE_FIXTURE_DISABLED` (warning) once. `ServiceDisabled` and the diagnostic codes are local names, not Power
Platform codes.

The Dataverse AI Builder, AI function and Copilot messages (`Predict` and others) are separate Web API messages: they
answer 403 `0x80048d06` unless a trusted pack's `dataverseMessages` handler replaces them ([data packs](data-packs.md)).

Each service is a capability record `service:<name>` (kind `provider`, at the lowest level of its operations), so it
appears in the [capability registry and preflight](capabilities-and-preflight.md).

## Pack fixtures

Export `serviceFixtures` as `{ <service>: { <operation>: (ctx) => result } }`. Mirage requires objects and synchronous functions (an `async` function is refused); unknown service names are allowed. Two packs that
register the same `service.operation` fail with
`Ambiguous serviceFixtures registration for <service>.<operation> in packs <a> and <b>`. See
[data packs](data-packs.md) for the export contract and trust rules.

## Power BI in Liquid

`{% powerbi %}` resolves `powerBi.embed` with `{ args, context, portal }`, where `args` holds the evaluated tag inputs.
No remote report request is made.

- A synchronous `{ html: string }` answer (an empty string included) is trusted local markup; fixture HTML is
  executable authored content under the pack trust contract. An answer without `html` reports
  `LIQUID_POWERBI_FIXTURE_UNAVAILABLE` and uses the placeholder; other types and promises fail explicitly.
- Without a fixture the tag renders a labelled placeholder and reports `LIQUID_POWERBI_PLACEHOLDER`.
- A site whose native output was captured empty can set
  `observed: { powerBiOutput: empty, evidence: <path to capture> }` to render nothing
  (`LIQUID_POWERBI_OBSERVED_EMPTY`). A trusted fixture takes precedence over the observation.
