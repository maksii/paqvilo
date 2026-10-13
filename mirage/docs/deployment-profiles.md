# Local deployment profiles

Mirage can map named environment profiles to existing files, apply configured defaults,
and pin a selection in each portal's local state. Sources can live beside the portal
export or in another repository. Register file paths explicitly; Mirage does not discover
adjacent repositories or run PAC, upload, deploy, synchronize or connect to a service.

In a toolkit catalogue, configure a site's `mirage.deploymentProfiles` (also supported in
`defaults.mirage` and a personal `paqvilo.config.local.yml` override):

```yaml
sites:
  sample:
    source: sources/portal
    mirage:
      deploymentProfiles:
        default: dev
        required: [pages]
        enabled:
          connectionReferences: false
        profiles:
          dev:
            pages: sources/portal/deployment-profiles/dev.deployment.yml
            environmentVariables: ../solution-project/profiles/dev.json
            connectionReferences: ../solution-project/profiles/dev.json
          test:
            pages: sources/portal/deployment-profiles/test.deployment.yml
            environmentVariables: ../solution-project/profiles/test.json
            connectionReferences: ../solution-project/profiles/test.json
```

Paths resolve relative to the catalogue directory, including in personal overrides,
and never relative to `sourceRoot`. Absolute paths are also accepted. For an embedded
`createSimulator({ deploymentProfiles, projectRoot })`, relative paths resolve against
`projectRoot` (the current directory by default).

A Mirage project accepts the same `deploymentProfiles` object at the top level or in an
individual `portals` entry. A portal-specific object replaces the project's whole profile
configuration, so `{}` clears inherited profiles. Paths resolve relative to the project
file. Portal state remains isolated even when portals share profile files.
`mirage init` copies catalogue mappings into the generated project, rebasing their paths.
When the toolkit launches the catalogue's configured `mirage.project`, catalogue profile
configuration takes precedence, so personal catalogue overrides still apply. An explicitly
selected independent project uses its own mappings. Configuration changes prevent reuse of
a toolkit session with different profile settings.

The three sections are independently mapped and enabled:

| Section | File content | Local effect |
| --- | --- | --- |
| `pages` | PAC Pages table-to-record-patch YAML, or the equivalent JSON | Overlays exported portal records before rendering and permission compilation |
| `environmentVariables` | PAC deployment-settings object containing an `EnvironmentVariables` array | Sets current values of exported Solution variable definitions |
| `connectionReferences` | PAC deployment-settings object containing a `ConnectionReferences` array | Seeds local `connectionreference` records with deterministic IDs |

Both Solution sections can point to the same JSON file or to separate files. For example:

```json
{
  "EnvironmentVariables": [{ "SchemaName": "sample_ServiceUrl", "Value": "https://service.example.test" }],
  "ConnectionReferences": [{
    "LogicalName": "sample_Api",
    "ConnectionId": "synthetic-connection",
    "ConnectorId": "/providers/Microsoft.PowerApps/apis/shared_sample"
  }]
}
```

Mirage accepts JSON or YAML for all mapped files. Pages patches use the existing importer:
record IDs take precedence over names, language/record identity is retained, and unresolved
targets remain visible as `DEPLOYMENT_PROFILE_TARGET_UNRESOLVED` diagnostics. Environment
variable settings require exported Solution definitions; they do not invent variable types
or definitions. Connection references represent local configuration only; they do not
authorize or execute Power Automate connections or validate their live ownership.

Mapped sections are enabled by default. `enabled` overrides those defaults, and `required`
lists sections that must remain enabled with a file mapping. Omitting `default` applies no
profile until one is pinned; required sections therefore require a valid configured default.
Required means a section and its file are required, not that every patch target exists.
Unknown IDs, unsupported fields, duplicate variable/reference names, malformed active files
and empty connection IDs are rejected. Disabled files are not read.

In `/_sim/` → **Environment**, select a registered profile, choose its optional sections,
and click **Apply and pin locally**. This recompiles the portal and seeded data immediately
and stores `{ profile, enabled }` under `simulator.deploymentProfilePin` in local state.
Restarting reuses the pin. **Use configured defaults** removes it. With no required sections,
**No profile** pins the source defaults. Pins never write back to the catalogue or exports.
A pin that no longer matches the config fails startup with an actionable validation error.

The local administration API supports:

```text
GET /__sim/api/environment                 # profileSelection: mappings, active flags and counts
PUT /__sim/api/environment/profiles        # {"profile":"test","enabled":{"connectionReferences":false}}
PUT /__sim/api/environment/profiles        # null removes the pin and reapplies configured defaults
```

Mutations use the existing local `x-sim-csrf` protection. API clients can submit only registered
profile IDs and section flags, never arbitrary file paths. Environment status includes paths
and counts, not file values. State exports still contain local simulated data; keep them under
ignored `.paqvilo/`, and avoid storing production secrets in local deployment profiles.

Precedence is exported source → selected profile → project `environmentVariables` → manual
local overrides. Variable names merge case-insensitively. Manual site settings/snippets and
variable overrides survive switching profiles; resetting a manual override reveals the
selected profile again. Old profile-seeded reference/value rows are removed when their section
is disabled or their profile changes, while unrelated rows are preserved.

Active profile contents contribute to the source fingerprint. Watched mapped files reload
even outside portal/Solution roots. A failed switch or reload keeps the last working portal,
state and fingerprint. Config mapping edits require a runtime restart. Read-only bootstrap,
inspection and project bootstrap use configured defaults; they do not read a runtime's local pin.
Existing `deploymentProfile` / `--deployment-profile NAME` behavior remains available for
exported Pages profiles; configure either that option or mapped `deploymentProfiles`, avoiding
ambiguous combinations.

Formats follow Microsoft's [Pages deployment-profile tutorial](https://learn.microsoft.com/en-us/power-pages/configure/power-platform-cli-tutorial#upload-the-changes-using-deployment-profile)
and [Solution deployment settings](https://learn.microsoft.com/en-us/power-platform/alm/conn-ref-env-variables-build-tools).
