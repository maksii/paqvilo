# Local deployment profiles

Mirage maps named environment profiles to deployment-settings files you already have, applies a configured default,
and lets you pin a selection per portal in local state. Register file paths explicitly: Mirage does not discover
adjacent repositories, and it never runs PAC, uploads, deploys, synchronizes or connects to a service.

## Configure profiles

In a catalogue, set a site's `mirage.deploymentProfiles` (also accepted in `defaults.mirage` and the personal
`paqvilo.config.local.yml`):

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

| Section                | File content                                                              | Local effect                                                                 |
| ---------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `pages`                | PAC Pages table-to-record-patch YAML, or the equivalent JSON              | Overlays exported portal records before rendering and permission compilation |
| `environmentVariables` | PAC deployment-settings object containing an `EnvironmentVariables` array | Sets current values of exported Solution variable definitions                |
| `connectionReferences` | PAC deployment-settings object containing a `ConnectionReferences` array  | Seeds local `connectionreference` records with deterministic ids             |

Formats follow the
[Pages deployment-profile tutorial](https://learn.microsoft.com/en-us/power-pages/configure/power-platform-cli-tutorial#upload-the-changes-using-deployment-profile)
and [Solution deployment settings](https://learn.microsoft.com/en-us/power-platform/alm/conn-ref-env-variables-build-tools);
every mapped file may be JSON or YAML.

**Paths.** A string resolves against the catalogue directory (also in personal overrides); absolute paths are accepted.
`{ source: <path> }` resolves against the selected portal source folder and `{ sourceRoot: <path> }` against the
resolved source root, so both follow `--repo` and worktrees. In a Mirage project, `deploymentProfiles` may sit at the
top level or in a `portals` entry (which replaces the project's whole object; `{}` clears it) and paths resolve against
the project file. For `createSimulator({ deploymentProfiles, projectRoot })` they resolve against `projectRoot`
(default the current directory). `mirage init` copies catalogue mappings into the project with rebased paths; when the
toolkit launches the catalogue's own `mirage.project`, the catalogue mapping wins so personal overrides still apply.

**Several files.** Both Solution sections accept an ordered list; a later file replaces entries with the same
case-insensitive schema or logical name and keeps the rest. `pages` takes one file.

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

## Validation rules

- Mapped sections are enabled by default; `enabled` overrides that, and `required` lists sections that must stay
  enabled with a file. Without `default` no profile applies until one is pinned, so required sections need a valid
  default. Required means the file must exist, not that every patch target exists.
- Pages patches use the importer: record ids win over names, language and record identity are kept, and an unresolved
  target is a `DEPLOYMENT_PROFILE_TARGET_UNRESOLVED` diagnostic.
- Environment variable settings need exported Solution definitions; types and definitions are never invented.
- Connection references are local configuration only: they do not authorize or run Power Automate connections. An
  empty `ConnectionId` is an unset reference, skipped and reported as `DEPLOYMENT_PROFILE_CONNECTION_UNSET`; it does
  not remove a reference set by an earlier file.
- Unknown ids, unsupported fields, duplicate names within one file and malformed active files are rejected; disabled
  files are not read. Doctor reports file and parse readiness per profile, with YAML errors as file, parser code and
  line/column, never source excerpts.
- An explicitly selected invalid profile, or a pin that no longer matches the configuration, fails startup rather than
  apply part of an environment.
- Use either the legacy exported Pages `deploymentProfile` / `--deployment-profile NAME` or mapped `deploymentProfiles`,
  not both.

## Select a profile locally

In `/_sim/` → **Environment**, choose a registered profile and its sections, then **Apply and pin locally**. The portal
and seeded data recompile immediately and `{ profile, enabled }` is stored as `simulator.deploymentProfilePin` in local
state; restarts reuse it. **Use configured defaults** removes the pin; with no required sections, **No profile** pins
the source defaults. Pins never write back to the catalogue or exports.

```text
GET /_sim/api/environment             # profileSelection: mappings, active flags and counts
PUT /_sim/api/environment/profiles    # {"profile":"test","enabled":{"connectionReferences":false}}
PUT /_sim/api/environment/profiles    # null removes the pin and reapplies the configured default
```

Mutations need the administration token in `x-sim-csrf` (`csrf` of `/_sim/api/status`, or `simulator.csrf`). Clients
submit only registered profile ids and section flags, never paths; the status shows paths and counts, never file values.

- Precedence: exported source → selected profile → project `environmentVariables` → manual local overrides. Manual
  overrides survive a profile switch; rows seeded by a disabled or replaced profile section are removed.
- Active profile contents are part of the source fingerprint, and mapped files are watched even outside the source
  roots. A failed switch or reload keeps the last working portal, state and fingerprint. Changing the mapping itself
  needs a restart.
- Bootstrap, inspection and project bootstrap read the configured default, never a runtime's pin.

## Environment variable types, effective values and secrets

Solution environment variables keep their exported type: String (100000000), Number (100000001), Boolean (100000002),
JSON (100000003), Data source (100000004) and Secret (100000005); values are text. The effective value is, lowest
first: definition default → Solution value → selected profile → project `environmentVariables` → `/_sim/` or persona
local value. Seeding writes it into the `environmentvariablevalue` row, so Web API reads,
`RetrieveEnvironmentVariableValue` and `effectiveEnvironmentVariables(state)` (`mirage/lib/secret-resolver.mjs`) agree.

Server logic reads non-secret values with `Server.EnvironmentVariable.get(name)` (case-insensitive);
`runExportedServerLogic` reads them from the store when its caller passes none. A Secret variable answers `null` there
and records `SECRET_NOT_EXPOSED_TO_SERVER_LOGIC`, because Power Pages hands secrets to a site through a site setting
bound to the variable (`environmentvariable` with `source` 1, recorded as `settingEnvironmentVariables`). Such settings
stay classified secret through local overrides: page inspection (`/_sim/api/page-resources`, Lense) shows `[secret]`
and never the value, while rendering still receives it.

A Secret variable's value is a Key Vault reference, never the secret:

```text
/subscriptions/{sub}/resourceGroups/{rg}/providers/Microsoft.KeyVault/vaults/{vault}/secrets/{name}[/{version}]
https://{vault}.vault.azure.net/secrets/{name}[/{version}]
```

Paqvilo never contacts Key Vault. The project `secrets` map binds `<vault>/<name>` to where the value lives on this
machine at resolve time:

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
    source: protected # a Windows DPAPI blob for the current user
    protectedValue: '<base64 DPAPI blob>'
```

- A `value` key is refused: secret values never live in configuration, state or profiles.
- `RetrieveEnvironmentVariableSecretValue` resolves the reference for the caller when a `secrets` map exists: 200
  resolved, 403 principal not in `allow`, 404 unbound or missing, 400 expired, disabled or not a Key Vault Secret; 501
  without a `secrets` map. These refusal statuses are local choices, not captured native responses. `NotifyEnvironmentVariableSecretChange` only validates its arguments.
- `RetrieveEnvironmentVariables`, OData reads of `environmentvariablevalues` and `/_sim/api/environment` return the
  reference only. The environment table omits `value`, `effectiveValue` and `defaultValue` for secret definitions and
  adds `reference` and `secretStatus` (`bound`, `status`, `version`, `expiresOn`; `not-configured` without a resolver).
- Resolver diagnostics (`SECRET_DENIED`, `SECRET_MISSING`, `SECRET_EXPIRED`, `SECRET_DISABLED`, `SECRET_UNBOUND`) name
  the `<vault>/<name>` key and the reason, never the value.
