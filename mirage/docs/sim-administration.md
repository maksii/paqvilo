# Local simulation administration

[Persona catalogues](persona-catalog.md) add grouped, searchable pickers to sign-in
and Identity, browser-local pins/recent choices, catalogue editors and isolated
setups for deployment profiles, variables and snippet/settings overrides. Open
`/_sim/#identity` to select a browser persona or manage metadata. Role membership
editing remains separate and explicit. Testing helpers resolve the actual origin
and browser options for a persona or catalogue scenario.

`/_sim/` is the loopback administration workspace. It exposes local tables/records, identity, roles, permissions, presets/scenarios, settings/snippets, runtime environment, source inspection, providers, platform resources, diagnostics and evidence. Changes here affect local state and rendering. Provider controls distinguish local configuration, optional reference reads and cached platform assets.

**Platform rules** (`#platform`) configures simulated organization/platform controls, including the support-managed link-entity budget and attachment restrictions. **Settings & snippet overrides** (`#overrides`) compares source/effective values without editing exports. Both support portable configuration presets and independent state for concurrent runtimes. Coverage and real administration classifications are explicit; see [configuration experiments](configuration-experiments.md).

**Organization identity & API** (`#dataverse`) manages the local organization, including when its public HTTP listener is off. It shows staff session identity/roles, application registrations with secret hints and certificate thumbprints, interactive users, optional local token credentials and recent API requests. Select a model-driven staff user or explicitly reset to local administrator. Portal personas and application-token identities are separate. Forms register applications, add local secrets/public certificates/federated credentials, create staff users, edit roles and enable/disable users. A new secret is shown once and never appears in a later read. Enable the HTTP API in Project setup and restart when an external integration client needs it. See [Dataverse API](dataverse-api.md#administration).

**Runtime & persistence** on Overview/Runtime state shows the effective surface, simulation level, control-plane persistence and exact declared pack DATA targets. Configuration in `/_setup/` takes effect after restart; it never flushes in-memory edits. Dry run permits memory-only record changes, simulation writes declared existing DATA files, and deep simulation also permits declared schema changes. File-backed tables without owners are read-only. See [simulation levels](simulation-levels.md).

[Standalone app/API profiles](standalone-organization.md) expose only applicable views and links. API-only profiles have no portal/model-driven launch link; standalone profiles have no portal persona, live bridge or rendering controls. The `/_sim/` record editor is explicit local administration; model-driven requests use the selected staff principal and its field/row security.

**Backend operations** lists exported server logic and cloud flows, including unlinked Solution workflows. Select a JSON response mock, keep an unsupported placeholder, explicitly enable trusted exported code or use a registered project handler. **Use source default** removes a local override. Exported role grants still apply; unlinked workflows receive no invented route or grants. See [operation modes and limits](operations.md).

Portal requests start anonymously. Local sign-in selects an active synthetic contact or explicit role override and stores a per-runtime `paqvilo-mirage-auth-<port>` cookie. The portal sign-in page, `_sim` and Lense Tweaks all operate on the browser session. Signing one browser in does not sign another browser in. The saved simulator identity is not a substitute for a request cookie.

Embedded tools call `simulator.signIn(contactId)` and send the returned cookie header. Playwright tests use `signInContext` from `paqvilo/mirage/testing`. Local session administration uses CSRF protection. Sign-out clears only the local session.

`simulator.identityScope` supports `"sessions"` (the default) and `"configured"`.
The legacy `"all-requests"` alias has the same behavior as `"configured"`.
Use `"configured"` only for explicitly chosen offline tooling: cookie-less portal
requests use the saved configured identity, with its normal membership or manual
role-override resolution and permission checks. A valid visitor cookie takes
precedence, including the explicit anonymous cookie issued by sign-out. This
option neither creates a session nor signs a browser in; a cookie-less request
uses the configured identity. Session scope
keeps cookie-less visitors anonymous. Administration requests continue to use the
configured identity. These are local simulation settings, not Power Pages
authentication or production security settings. Prefer session helpers for
independent visitors and permission tests.

`connectRuntime().signIn(null, { configuredPersona: true })` requires a configured
contact (`identity.contactId` or legacy `identity.id`). Missing and role-only
identities fail with `MISSING_PERSONA_CONTACT` before sending a sign-in POST.
An explicit `contactId` is also supported; omit sign-in to stay anonymous.

HTTP tools can use `createPortalSession` or `connectRuntime().createSession` from
`paqvilo/mirage/testing` for independent visitors sharing one runtime. Each owns its
cookie jar and membership-derived identity. `runSessionMatrix` exercises a bounded
visitor/case product concurrently, supports cancellation and serialized recording,
and reports throughput and latency. It sends ordinary portal requests and preserves
permission denials. Use separate write fixtures per visitor; settings, sources and
data are shared within the runtime. For different configuration or CPU workers,
run separate Mirage processes and state files. See [public API](../../docs/public-api.md#test-many-visitors-concurrently).

External identity-provider flows are local simulations for exported provider settings, with a local provider route and explicit redirect handling. They do not copy live credentials or mint genuine environment tokens. Actual live-reference sign-in belongs to the intended signed-in browser and its own identity.

Automated tools can inspect `connectRuntime().audit(filters)`, `exportAudit(filters)` and `diagnostics()`. Correlate a visitor's returned `traceId` with `correlationId`, or isolate entries by `contactId`. Exclusive `afterSequence` and inclusive `throughSequence` bound a stable request window; responses expose retention loss and the oldest retained sequence. Complete the requests before advancing a checkpoint because sequence numbers are assigned at request start. These reads use the existing sanitized, bounded ledger.

`runtime.witness({tables: ['fixture']})` and `visitor.witness({tables: ['fixture']})`
capture a read-only verification boundary through the existing loopback administration
API. Select one to 32 distinct existing logical fixture tables explicitly. Each
visitor sends its own cookie internally, so its witness uses the same resolved
portal identity and membership roles as its portal requests. Cookie-less requests
are anonymous under the default session scope. The configured persona does not
silently replace the visitor.

The atomic `DataStore.readOperation` hashes effective permissions, mappings,
settings, operation mode, source/runtime fingerprints, actor fields and all stored
columns/multiplicities in the selected tables. It invokes no SDK/plugin retrieval.
The response contains hashes/counts and selection scope rather than row bodies,
setting values or credentials. `compareVerificationWitnesses(before, after)` from
`paqvilo/mirage/testing` reports changed hash categories. Runtime instance and
revision changes are reported separately so an unselected recording-table
write does not masquerade as selected fixture drift. No table is automatically
excluded, and unselected collections receive no coverage credit. Actor fields are
observed independently of that table selection.

Keep the state file outside the export or in ignored `.paqvilo/`, as with normal
runtime configuration. The source fingerprint intentionally observes files in
the export. Original external DLL/SDK bytes need separate verification; a
plugin-definition hash alone does not observe their on-disk bytes.
These witnesses establish local comparison boundaries, not native parity.

Permission enforcement can be set to enforced or permissive for local experiments; this choice is visible in evidence. Live create/update/delete cannot leave the runtime without `--allow-live-writes`, and still require the separate administration switch. Task authorization is required independently of either switch.
