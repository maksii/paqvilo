# Server logic and cloud flows

Mirage inventories exported operations automatically. Open `/_sim/#operations` to review their source, route, access and local behavior. The catalogue includes portal server logic and cloud-flow consumers, matching enhanced site records in selected Solutions, and Solution workflow definitions.

An unlinked workflow remains visible without an invented portal route or role grant. Add the appropriate consumer export to establish that binding.

Solution plugin steps also appear in Operations. They run through supported local CRUD stages, rather than a portal URL. Select a step to review its table, message, stage, filtering columns and source. Configure a target-field mock, validation rejection or trusted project handler. See [Dataverse plugins](dataverse-plugins.md) for the contract and execution limits.

## Choose local behavior

| Mode | Result |
| --- | --- |
| Placeholder | HTTP 501 identifies an operation without a supported local implementation |
| Supported exported flow | A Power Pages Request trigger with one supported Response returns its evaluated local result |
| JSON mock | Set a response body and status for success, empty, validation or failure scenarios |
| Exported server logic | Explicitly enable exported JavaScript against the local data store |
| Project provider | Register a trusted pack handler for business logic or unsupported integrations |

Select an operation, save its local behavior and call its exported route from your portal. **Use source default** removes a local override. Overrides affect simulation state; they do not deploy the source or activate an online flow.

## Execution boundary

Imported routes retain exported web-role checks. Local data access applies the current identity and table permissions. Exported server logic can query and change local records through supported Dataverse helpers. Writes require a verified HTTP write request and native CSRF checks; Liquid helper calls remain read-only.

Workers bound execution time. They do not provide an arbitrary untrusted-code sandbox or Dataverse transaction guarantees. Enable exported code only from sources you trust.

External connectors, custom APIs, complex flow actions and unsupported expressions require a project handler or mock. Mirage does not forward imported workflows to remote Power Automate. A local response proves the selected simulation scenario, not complete cloud execution parity.

Use [data packs](data-packs.md) for reusable project providers, [simulation administration](sim-administration.md) for state and personas, and [coverage](../../docs/coverage.md) for the wider platform boundary.
