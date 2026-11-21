# Platform rules and portal overrides

Two administration pages change platform and portal configuration for one runtime, without touching source files:

- `/_sim/#platform` (**Platform rules**): each control's administration classification, Microsoft reference, source and
  effective values, instance override and local coverage.
- `/_sim/#overrides` (**Settings & snippet overrides**): exported and effective site settings and content snippets side
  by side; edit, add, remove or reset. Values stay strings (`False`, `True` and empty included); `null` removes the
  effective value. A snippet override covers every request language, and reset restores each source translation.

Changes are held in the runtime's state (persisted when it has a state file), survive source reloads and rebuild local
rendering and API policy at once. They never configure a Dataverse organization. To set values in configuration instead,
use the `platform` setting ([configuration](../../docs/configuration.md)).

## Settings catalogue

The catalogue (`mirage/lib/platform-setting-definitions.mjs`) holds 25 controls and separates feature-documented
organization settings from columns that are writable but unsupported. Organization-column controls read the local
`organization` row when present, else the catalogue default; an instance override wins. Support-managed and simulator
controls come only from overrides and defaults.

| Controls                                                                                                                                                                      | Classification and local effect                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QueryLinkEntityLimit`                                                                                                                                                        | Default 15. **Support-managed** ([support guidance](https://support.microsoft.com/en-au/topic/timeline-does-not-render-and-shows-records-could-not-be-loaded-4ce9200a-1afe-3ef4-ac11-a74b91f4f40c)), not an editable column. Applied to Liquid FetchXML, API validation and execution and the SDK QueryExpression adapter.                           |
| `BypassBusinessLogicExecutionStepIdsLimit`                                                                                                                                    | Default 3, an OrgDBOrgSettings value ([limit](https://learn.microsoft.com/power-apps/developer/data-platform/bypass-custom-business-logic#limit-on-the-number-of-steps)). Enforced on the step ids one operation may bypass.                                                                                                                         |
| `MaxUploadFileSize`, `BlockedAttachments`, `BlockedMimeTypes`, `AllowedMimeTypes`                                                                                             | Supported organization controls, enforced on note and attachment creates and attachment-field updates (SDK and native form writes). Size is measured over the base64 content ([file size limits](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/attachment-annotation-files#file-size-limits)); lists are semicolon-separated. |
| `AuditSettings`, audit enabled/access/retention/interval, trace-log setting, Quick Find limit, sharing on Assign, subscription and change-tracking retention, external search | Feature-documented organization settings, **catalogue only**: values and provenance are kept, but no auditing, indexing, trace retention or other service effect is simulated.                                                                                                                                                                       |
| `AllowSaveAsDraftAppointment`, `AutoTrackSentFolderItems`                                                                                                                     | OrgDBOrgSettings options ([source](https://learn.microsoft.com/en-us/power-platform/admin/orgdborgsettings)); catalogue only, no Exchange simulation.                                                                                                                                                                                                |
| `WorkflowSettings.MaxDepth`                                                                                                                                                   | Legacy on-premises control, catalogue only; it does not raise the local CLR or async depth bounds.                                                                                                                                                                                                                                                   |
| `FetchConditionLimit` (500), `AggregateQueryRecordLimit` (50,000), `FetchLinkAndFilterLimit` (27)                                                                             | **Simulator experiments** with no supported cloud administration path. The aggregate limit affects FetchXML only, not OData `$apply`; an authored `aggregatelimit` keeps its lower-limit semantics. `FetchLinkAndFilterLimit` bounds ordinary joins plus existential filter links.                                                                   |
| `FetchLinkDepth` (32), `FetchJoinRowLimit` (250,000)                                                                                                                          | **Simulator safety bounds**, not organization settings. Exceeding one is an error, never truncated data.                                                                                                                                                                                                                                             |

No blocked-extension list is invented for an unknown environment: supply the organization row or an override. Raising a
budget changes only what Mirage evaluates with its own permission and query model; it is not evidence about a real site.

## Presets and concurrent instances

Both pages share configuration presets: save the current overrides, apply a preset, export or import its JSON, or delete
a saved one. A configuration preset replaces only platform settings and site setting/snippet overrides; data,
identities, web roles, page access rules and backend-operation choices stay. Built-ins: **Source defaults**
(`source-defaults`, clears every override), **Simulated support increase (30)** (`expanded-query-budget`) and **Disable
exported Web API tables** (`webapi-disabled`, table names derived from the current export). Packs add read-only
configuration presets ([data packs](data-packs.md#pack-configuration-presets)). Applying a preset is a local experiment,
not proof that a support change was approved. Importing a preset does not apply it.

Configuration presets are separate from data presets, which replace business data and follow the simulation level
([data presets](sim-administration.md#data-presets)). A data preset that names a configuration preset applies it too
when started with `--apply-configuration` or applied with `{ "applyConfiguration": true }`.

Run independent experiments as separate runtimes with their own state files and ports (an override on one does not reach
the other); never point two runtimes at one writable state file:

```sh
npx --no-install paqvilo mirage serve --source ./portal-export --state ./.paqvilo/base.json --port 4311
npx --no-install paqvilo mirage serve --source ./portal-export --state ./.paqvilo/expanded.json --port 4312
```

Embedded runtimes without a state file keep their overrides in memory until they close.

## Automation

Under `/_sim/api` (alias `/__sim/api`) on the loopback administration origin:

| Route                                       | Operation                                                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `GET /platform-settings`                    | Catalogue, effective values, origins and coverage                                                                                  |
| `PATCH /platform-settings`                  | Merge validated named instance overrides                                                                                           |
| `DELETE /platform-settings/{key}`           | Restore the source or default value of one control                                                                                 |
| `GET /experiments`, `GET /experiments/{id}` | Configuration presets (404 `Experiment not found.`)                                                                                |
| `POST /experiments`                         | Save or import `{ id, name, description?, platformOverrides, portalOverrides }`; `portalOverrides` holds `settings` and `snippets` |
| `POST /experiments/{id}/apply`              | Apply a preset without replacing business data; answers `{ "applied": "<id>" }`                                                    |
| `DELETE /experiments/{id}`                  | Delete a saved preset; built-in and pack presets are protected (403)                                                               |

Mutations need the administration token in `x-sim-csrf`. Unknown controls, invalid types or ranges and prototype keys
answer 400 `InvalidPlatformSetting`, other keys in an import 400 `InvalidExperimentPreset`, and a site value that is not
a string or `null` 400 `InvalidPortalOverride`, before anything persists. Saving an existing id answers 409; a runtime
holds at most 100 saved presets (413 after that). Individual site values use the `portal-settings` and `portal-snippets`
routes, where `DELETE` resets an override and a `null` PATCH removes the effective value.

`connectRuntime` from `paqvilo/mirage/testing` wraps these routes with the token: `platformSettings`,
`setPlatformSettings`, `resetPlatformSetting`, `siteSettings`, `setSiteSetting`, `resetSiteSetting`, `setSnippet`,
`resetSnippet`, `experiments`, `saveExperiment`, `applyExperiment`, `deleteExperiment`. Configuration is shared by all
visitors of a runtime, so finish a `runSessionMatrix` before changing it.

```json
{
  "id": "expanded-banner",
  "name": "Expanded joins and banner",
  "platformOverrides": { "QueryLinkEntityLimit": 30 },
  "portalOverrides": {
    "settings": { "Feature/Banner": "True" },
    "snippets": { "Banner/Text": "Scenario-specific banner" }
  }
}
```
