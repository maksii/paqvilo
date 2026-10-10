# Dataverse simulation

Mirage supports FetchXML, portal Web API and list OData contracts over local state. Queries use imported mappings, relationship metadata, column types and permission scopes. Results support platform-shaped choice/lookup values, paging, counts, expansion and error envelopes. Unsupported constructs and unresolved mappings fail with diagnostics rather than silently querying unrelated tables.

Local identities come from request sessions. Exported table permissions, web roles and parent/contact/account/self relationships control queries and writes when enforcement is enabled. Page access and table access are separate concerns. Metadata/scaffold discovery does not grant a persona permission to business rows.

The local store simulates create/update/delete, validation, bindings, declared backend rules and atomic state writes. Dataverse plugins require project models. Explicitly registered server logic can run exported JavaScript with local Dataverse reads; registered request/response flows can evaluate their exported definition. Other connectors and flow actions require project handlers or return unsupported diagnostics. See [data packs](data-packs.md). New states contain no business records from references.

An exported unsupported server-logic endpoint answers HTTP 501 with the camelCase fields `requestId`, `success`, `serverLogicName`, `data` and `error`. This local fallback is an explicit unsupported result, not a successful execution or a claim about a deployment's wire format.

Use `webapi-inventory`, `bootstrap-report` and `portal-matrix` to find source calls, unresolved table identities and schema gaps. Use a project-owned parity plan for read-only comparisons against an authorized reference browser. Local correctness and live parity are reported separately.
