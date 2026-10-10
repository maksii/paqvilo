# Dataverse simulation

Mirage supports FetchXML, portal Web API and list OData contracts over local state. Queries use imported mappings, relationship metadata, column types and permission scopes. Results support platform-shaped choice/lookup values, paging, counts, expansion and error envelopes. Unsupported constructs and unresolved mappings fail with diagnostics rather than silently querying unrelated tables.

Local identities come from request sessions. Exported table permissions, web roles and parent/contact/account/self relationships control queries and writes when enforcement is enabled. Page access and table access are separate concerns. Metadata/scaffold discovery does not grant a persona permission to business rows.

The local store simulates create/update/delete, validation, bindings, declared backend rules and atomic state-file writes. [Dataverse plugin registrations](dataverse-plugins.md) are imported from selected Solutions; supported write stages use explicit mocks or project handlers. Unconfigured steps report skipped business logic. [Operations](operations.md) inventories exports, executes supported request/response flows, offers JSON mocks and explicitly enables trusted server code against permission-scoped local query/CRUD helpers. Other connectors and flow actions require project handlers or return unsupported diagnostics. New states contain no business records from references.

An exported unsupported server-logic endpoint answers HTTP 501 with the camelCase fields `requestId`, `success`, `serverLogicName`, `data` and `error`. This local fallback is an explicit unsupported result, not a successful execution or a claim about a deployment's wire format.

Use `webapi-inventory`, `bootstrap-report` and `portal-matrix` to find source calls, unresolved table identities and schema gaps. Use a project-owned parity plan for read-only comparisons against an authorized reference browser. Local correctness and live parity are reported separately.
