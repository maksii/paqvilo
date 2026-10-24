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

String paths resolve relative to the catalogue directory, including in personal overrides.
Absolute paths are also accepted. Use `{ source: deployment-profiles/dev.yml }` to resolve
against the selected portal source folder, or `{ sourceRoot: profiles/dev.json }` against
the resolved source root. These references follow `--repo` and worktree selection. For an embedded
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

| Section                | File content                                                              | Local effect                                                                 |
| ---------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pages`                | PAC Pages table-to-record-patch YAML, or the equivalent JSON              | Overlays exported portal records before rendering and permission compilation |
| `environmentVariables` | PAC deployment-settings object containing an `EnvironmentVariables` array | Sets current values of exported Solution variable definitions                |
| `connectionReferences` | PAC deployment-settings object containing a `ConnectionReferences` array  | Seeds local `connectionreference` records with deterministic IDs             |

Both Solution sections can point to the same JSON file or to separate files, and accept
ordered lists of files. Later files replace entries with the same case-insensitive schema
or logical name; other entries remain. Pages accepts one file. For example:

```yaml
dev:
  pages: { source: deployment-profiles/dev.yml }
  environmentVariables:
    - { sourceRoot: settings/shared.json }
    - { sourceRoot: settings/dev.json }
  connectionReferences:
    - { sourceRoot: settings/shared.json }
    - { sourceRoot: settings/dev.json }
```

An individual Solution settings file has this structure:

```json
{
  "EnvironmentVariables": [{ "SchemaName": "sample_ServiceUrl", "Value": "https://service.example.test" }],
  "ConnectionReferences": [
    {
      "LogicalName": "sample_Api",
      "ConnectionId": "synthetic-connection",
      "ConnectorId": "/providers/Microsoft.PowerApps/apis/shared_sample"
    }
  ]
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
Unknown IDs, unsupported fields, duplicate variable/reference names within one file and
malformed active files are rejected. Empty connection IDs represent unset references:
they are skipped and reported as `DEPLOYMENT_PROFILE_CONNECTION_UNSET` with names/counts.
An unset entry does not remove an active reference from an earlier file. Disabled files
are not read. Doctor reports file and parse readiness for each configured profile; YAML
parse errors include a safe filename, parser code and line/column without source excerpts.
An explicitly selected invalid profile fails startup so it cannot silently apply a partial
environment configuration. Repair the file or explicitly select another profile.

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

## Environment variable types, effective values and secrets

Solution environment variables keep their exported type: String (100000000), Number (100000001), Boolean
(100000002), JSON (100000003), Data source (100000004) and Secret (100000005). Values are text. The effective
value of a variable is, lowest first: the definition default → the Solution value → the selected profile →
project `environmentVariables` → the `/_sim/` or persona local value. Solution seeding writes that result into
the `environmentvariablevalue` row, so Web API reads, `RetrieveEnvironmentVariableValue` and
`effectiveEnvironmentVariables(state)` in `mirage/lib/secret-resolver.mjs` all see the same value. Server logic
reads non-secret values through `Server.EnvironmentVariable.get(name)` (names match without case); a Secret variable
answers `null` there and records `SECRET_NOT_EXPOSED_TO_SERVER_LOGIC`, because Power Pages hands secrets to a site
through a site setting bound to the variable. The importer records those bindings as `settingEnvironmentVariables`
(setting name → variable), read from the setting's `environmentvariable` field with `source` 1.

Site settings bound to a Secret variable keep their secret classification (`secretSettingNames`) through local
portal overrides. Page inspection (`/__sim/api/page-resources`, Lense) shows `[secret]` and `secret: true` for every such
setting, its value and its source value, and never the bound value; rendering still receives the resolved value.
`runExportedServerLogic` reads the effective environment variables from the store when its caller passes none, so
`Server.EnvironmentVariable.get` answers the same value in a running site as in tests.

A Secret variable's value is a Key Vault reference, never the secret:

```text
/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.KeyVault/vaults/{vault}/secrets/{name}[/{version}]
https://{vault}.vault.azure.net/secrets/{name}[/{version}]
```

Paqvilo never contacts Key Vault. The project `secrets` config binds `<vault>/<name>` to where the value lives on
this machine when it is read:

```yaml
secrets:
  fx-vault/func-key:
    source: environment # read process.env[variable] at resolve time
    variable: FX_FUNC_KEY
    versions: { current: v2 } # optional: a reference naming another version is missing
    expiresOn: 2026-12-31T00:00:00Z # optional: expired after this instant
    allow: [77777777-7777-4777-8777-777777777777] # principal ids; absent means nobody (fail closed)
    disabled: false
  fx-vault/other:
    source: protected # a Windows DPAPI blob (current user), as lense/dataverse/connection.mjs stores credentials
    protectedValue: '<base64 DPAPI blob>'
```

A `value` key is refused: secret values never live in config, state or profiles. `RetrieveEnvironmentVariableSecretValue`
resolves the reference for the calling user when a `secrets` config exists: resolved 200, a principal not in `allow`
403, an unbound or missing secret 404, an expired or disabled one 400, a definition that is not a Key Vault Secret 400. Without a `secrets` config the message answers 501.
`NotifyEnvironmentVariableSecretChange` only validates its arguments.

What is never revealed: `RetrieveEnvironmentVariables`, OData reads of `environmentvariablevalues` and
`/__sim/api/environment` return the reference only. The environment table omits `value`, `effectiveValue` and
`defaultValue` for secret definitions (Secret type, or `secretstore` 1) and adds `reference` (Key Vault Secrets only)
and `secretStatus` (`bound`, `status`, `version`, `expiresOn`; `not-configured` without a resolver). Resolver
diagnostics (`SECRET_DENIED`, `SECRET_MISSING`, `SECRET_EXPIRED`, `SECRET_DISABLED`, `SECRET_UNBOUND`) name the
`<vault>/<name>` key and the reason, never the value.
