# Service fixtures

Paqvilo never executes Power BI, AI Builder, Copilot or Dynamics app services. Each operation of such a service answers
a trusted pack's fixture, else a disabled answer (for Power BI in Liquid, a placeholder). Nothing is rendered, inferred
or orchestrated.

## Disabled-by-default services

Each host resolves a service and operation to one answer, in this order:

| Level       | Source                                                 | Answer                                                               |
| ----------- | ------------------------------------------------------ | -------------------------------------------------------------------- |
| `fixture`   | a trusted pack's `serviceFixtures[service][operation]` | whatever the fixture returns (for example `{ html }` or `{ error }`) |
| `behaviour` | a handler registered in code (packs cannot)            | the handler's answer                                                 |
| `disabled`  | the default fallback                                   | `{ error: { code: 'ServiceDisabled', service, operation } }`         |

Built-in operations are `powerBi.embed`, `aiBuilder.predict` and `copilot.ask`, each with the fallback only; `dynamics`
and any other service exist only through packs. The first fallback answer for an operation reports
`SERVICE_FIXTURE_DISABLED` (warning) once. Only `{% powerbi %}` resolves an operation today, and without a fixture it
renders its placeholder instead of the fallback; `aiBuilder.predict` and `copilot.ask` are listed but no host calls
them. `ServiceDisabled` and the diagnostic codes are local names, not Power Platform codes.

The Dataverse AI Builder, AI function and Copilot messages (`Predict` and others) are separate Web API messages. Unless
a trusted pack's `dataverseMessages` handler replaces them ([data packs](data-packs.md)), a call answers 403
`0x80048d06` (the documented `Predict` error, assumed for the others), capability probes such as `IsPaiEnabled` answer
fixed "not enabled" values, and `AIModelPublish` answers 501 `0x80040216` as internal only.

Each service is a capability record `service:<name>` (kind `service`; level `inventory` while it has only the fallback),
so it appears in the [capability registry and preflight](capabilities-and-preflight.md).

## Pack fixtures

Export `serviceFixtures` as `{ <service>: { <operation>: (ctx) => result } }`. Mirage requires objects and synchronous
functions (an `async` function is refused); unknown service names are allowed. Two packs that register the same
`service.operation` fail with `Ambiguous serviceFixtures registration for <service>.<operation> in packs <a> and <b>`.
See [data packs](data-packs.md) for the export contract and trust rules.

## Power BI in Liquid

`{% powerbi %}` resolves `powerBi.embed` with `{ args, context, portal }`, where `args` holds the evaluated tag inputs.
No remote report request is made.

- A synchronous `{ html: string }` answer (an empty string included) is trusted local markup; fixture HTML is
  executable authored content under the pack trust contract. An answer without `html` reports
  `LIQUID_POWERBI_FIXTURE_UNAVAILABLE` and falls back to the observation below or the placeholder; a non-string `html`
  or a promise renders the Liquid error "powerBi.embed must synchronously return { html: string } or { error }." in
  place of the tag.
- Without a fixture the tag renders a labelled placeholder (its inputs as `data-powerbi-*` attributes, URL query values
  redacted) and reports `LIQUID_POWERBI_PLACEHOLDER`.
- A site whose native output was captured empty can set
  `observed: { powerBiOutput: empty, evidence: <path to capture> }` to render nothing
  (`LIQUID_POWERBI_OBSERVED_EMPTY`). A trusted fixture that answers `html` takes precedence over the observation.
