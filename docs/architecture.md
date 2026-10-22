# Architecture and project boundaries

Paqvilo owns reusable Power Pages behavior. Your portal project owns its sources, configuration, datasets and acceptance criteria.

| Directory | Responsibility |
| --- | --- |
| `bin/` | Public setup, Lense, Mirage and Dataverse command routing |
| `lense/` | Source models, mapping, editing, overlays, browser sessions, panel and agent API |
| `mirage/lib/`, `mirage/server.mjs` | Importing, Liquid, FetchXML/Web API, forms/lists, permissions, platform compatibility and simulation; the organization runtime, app hosts, connectors and providers as flat modules |
| `mirage/admin/` | Local `/_sim/` administration |
| `mirage/testing/` | Reusable local sign-in, session and runtime helpers and the storage provider contract suite for project-owned tests |
| `lense/dataverse/` | Explicit project-owned Dataverse provisioning, comparison and export APIs |
| `test/`, `test-browser/` | Synthetic Lense and integration regressions |
| `mirage/test/`, `mirage/test-browser/`, `mirage/test-volume/` | Synthetic Mirage regressions; the write-volume gate runs explicitly |
| `templates/project/` | Empty consumer scaffold used by `paqvilo init` |
| `examples/project/` | Populated standalone demo, external pack and native component fixture |
| `examples/company-operations/` | Separate synthetic regression project for deep permissions and plugin observations |
| `docs/`, `mirage/docs/` | Reusable contracts, configuration and workflow guidance |
| `scripts/`, `.github/` | Contributor checks, package validation, repository maintenance and CI |
| `site/` | Public website sources; `dist/` contains ignored generated output |

The two products share the catalogue, source model and browser integration. Lense's Mirage lifecycle wrapper starts and stops only owned processes. Mirage imports Lense's source/configuration utilities; it does not require a live portal for local rendering.

The empty scaffold and populated demo serve different purposes: use `paqvilo init` for a new project and `paqvilo mirage demo` to explore working sample pages. The Company Operations [reference designs](design/company-operations-demo.md) describe its own synthetic model and qualification contracts. They do not add business behavior to the toolkit or certify a live environment.

## Runtime scope

| Input or behavior | Available support | Boundary |
| --- | --- | --- |
| Standard and enhanced portal exports | Source mapping and local import of pages, templates and configuration | Incomplete or ambiguous exports produce diagnostics. |
| `.powerpages-site` code-site exports | Source import and supported resource handling | SPA application builds and deployment use their own tooling. |
| Liquid, FetchXML, Web API, forms and lists | Local implementations driven by export and Solution metadata | Local behavior is a simulation; use recorded comparisons for parity claims. |
| Dataverse business behavior | Synthetic rows, supported exported operations, trusted handlers, explicitly configured original CLR plugins and contract modules for calculated, rollup, formula and business-rule logic | Unsupported SDK services and modules below `behaviour` report their level and diagnostics; project packs supply the missing models. |
| Cloud flows and connectors | A bounded flow interpreter with tracked runs, waits, approvals, retries and child flows; a connector runtime that resolves connection references to declared connections and providers | Connectors without a provider need a pack connector, an HTTP fixture or a per-action mock. Outbound calls reach loopback services only. |
| Files, messages and external services | Storage routes for file, note and portal bytes, a local message bus, an outbox, declared loopback services (Functions, Azurite, the Service Bus emulator), and core transports to Azurite (Blob REST) and the Service Bus emulator (AMQP 1.0) | Paqvilo probes external services but never starts them; cloud endpoints are refused. |
| Canvas and code apps | Headless canvas app runtime on the core Power Fx engine, and code app context, token and Dataverse proxy under `/_apps/` | No canvas app is rendered. |
| Browser automation | Origin-confined session, page, event, snapshot and navigation APIs | Live browser actions still use the portal's backend. |

The [Mirage reference](../mirage/docs/README.md) describes each runtime contract and its evidence. [Platform stack coverage](../mirage/docs/platform-stack.md) maps each Dataverse and Power Platform area to its module and capability level, and states what is external or out of scope. Microsoft's [developer tools](https://learn.microsoft.com/en-us/power-pages/configure/developer-overview) remain part of the source and release workflow.

## Runtime layers

Mirage runs one organization per runtime, in five layers:

1. **Source graph.** The importers read the portal export and the selected Solution layers once. `source-graph.mjs` indexes them with one precedence rule and lists the requirements a run needs.
2. **Organization core.** `DataStore` holds the state. `createOrganizationRuntime` installs the ordered Dataverse extensions over it: record pipeline, security, plug-ins, workflows, custom APIs and contract modules. Committed work (asynchronous plug-ins, workflows, flow triggers, web hooks) runs as durable `asyncoperation` jobs.
3. **App hosts.** The Power Pages host (`server.mjs`) and the Solution-only host (`standalone-runtime.mjs`) share one composition, `composeOrganizationHost` in `organization-host.mjs`. It owns the handler maps, memoised operation catalogues, providers, flow run store, backend, Dataverse API, settle and the one close order. Canvas and code app surfaces live under the reserved `/_apps/` prefix; administration under `/_sim/api/`.
4. **Connections and connectors.** `connector-runtime.mjs` resolves each flow action through its connection reference to a declared connection, principal and provider. The flow interpreter journals runs so waiting runs can resume.
5. **Providers.** The host builds `api.providers` once: storage, messaging, outbox, connectors, secrets, service fixtures, Power Fx and local services. An unconfigured provider is `null`.

Cross-cutting seams keep these layers consistent. One request context per call carries the initiator, principal and correlation id. One clock, id source and scheduler per runtime drive every timer, so tests can fix time and ids. One settings table (`MIRAGE_SETTINGS`) and one pack-export registry (`PACK_EXPORTS`) validate configuration and packs. All outbound HTTP goes through `loopbackFetch`.

Each module reports a capability level (`inventory`, `contract`, `behaviour` or `native-qualified`) to the host's capability registry. Runtime status, `paqvilo mirage preflight` and `GET /_sim/api/preflight` expose these levels and say what blocks a scenario. A placeholder never reports success. See [Capabilities and preflight](../mirage/docs/capabilities-and-preflight.md).

## Project extensions

The installed preset library contains only generic presets. No adjacent directory is imported automatically. Explicit `dataPacks` entries load trusted JavaScript modules relative to their project file. The same project can register multiple packs; IDs and presets are validated and conflicting IDs fail. A pack's `matches({ portal })` decides whether its data and extensions apply to that imported portal. Built-in platform behavior must never select a rule by an organisation, website name, custom table prefix or customer route.

Standard and enhanced exports provide configuration, page/template relationships and table permissions. Solution metadata provides table identities, columns, relationships, forms and views. Observed behavior that neither source provides is a site setting with evidence. Synthetic datasets and backend business rules are pack extensions; they do not claim to reproduce a particular Dataverse implementation. Pack exports are recognised through one registry; an unknown export is reported as `PACK_EXPORT_UNKNOWN` rather than ignored.

Keep the portal project in its own repository. Core CI never discovers or runs its tests. The publication allowlist excludes private packs, exports, state and captures; the project-boundary check scans reusable source, tests, docs and examples for inherited business dependencies. Private business tests consume the public package exports and explicitly registered packs.
