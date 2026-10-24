# Platform rules and portal overrides

Mirage exposes two dedicated administration pages:

- `/_sim/#platform`: **Platform rules**, with real administration classification, Microsoft references, source/effective values, instance overrides and explicit simulation coverage.
- `/_sim/#overrides`: **Settings & snippet overrides**, with exported and effective values side by side. Edit, add, remove locally or reset without changing source files. Boolean-looking values have one-click **Set True / Set False** actions. Portal values remain strings, including `False`, `True` and empty strings; `null` removes the local effective value. Snippet name overrides cover all request languages in this instance, and reset restores each source translation.

Changes are held in that runtime's state, survive source reloads and persist when it has a state file. They rebuild local rendering and API policy immediately. They do not configure a connected Dataverse organization. The original Portal configuration page remains available for compatibility and role/page-access administration.

## Settings catalogue

The [versioned source catalogue](../lib/platform-settings.mjs) contains 24 controls. It intentionally distinguishes feature-documented organization settings from writable-but-unsupported columns. Microsoft's [organization settings guidance](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/organization-table) recommends feature-supported controls and the supported tools for OrgDBOrgSettings, rather than writing its XML directly.

| Controls                                                                                                                                                 | Real administration / local coverage                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `QueryLinkEntityLimit`                                                                                                                                   | Default 15. Microsoft Support documents requesting an organization-wide increase; this is **support-managed**, not a normal editable organization column. Mirage applies the instance value to Liquid FetchXML, API validation/execution and the supported SDK QueryExpression adapter. Its independent SDK adapter safety bounds still apply. [Support guidance](https://support.microsoft.com/en-au/topic/timeline-does-not-render-and-shows-records-could-not-be-loaded-4ce9200a-1afe-3ef4-ac11-a74b91f4f40c).                                                                                                                                                                                                                            |
| `MaxUploadFileSize`, `BlockedAttachments`, `BlockedMimeTypes`, `AllowedMimeTypes`                                                                        | Supported organization controls. Mirage enforces these on Annotation and ActivityMimeAttachment creates/attachment-field updates, including SDK and native form/note writes. Size is measured over base64-encoded content in bytes, following the cited file API guidance; file/image columns have separate metadata limits. Extension/MIME lists use semicolons. No blocked-extension list is invented for an unknown environment: supply the organization row or an override. [File size limits](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/attachment-annotation-files#file-size-limits), [file type restrictions](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/files-images-overview). |
| Audit enabled/access/retention/interval, trace-log setting, Quick Find limit, sharing on Assign, subscription/change-tracking retention, external search | Feature-documented Organization settings. **Catalogue only**: values and provenance can be configured, but Mirage does not invent auditing, indexing, native trace retention or these service effects.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `AllowSaveAsDraftAppointment`, `AutoTrackSentFolderItems`                                                                                                | Documented OrgDBOrgSettings-tool options; catalogue only, without Exchange simulation. [Source](https://learn.microsoft.com/en-us/power-platform/admin/orgdborgsettings).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `WorkflowSettings.MaxDepth`                                                                                                                              | Legacy on-premises deployment PowerShell control, catalogue only. It does not increase the local CLR/async host safety bounds or imply a supported cloud control. [Depth documentation](https://learn.microsoft.com/en-us/dotnet/api/microsoft.xrm.sdk.iexecutioncontext.depth).                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `FetchConditionLimit`, `AggregateQueryRecordLimit`                                                                                                       | Documented defaults with **simulator experiment** overrides. No supported cloud administration path is inferred. The aggregate override affects FetchXML, not OData `$apply`; authored `aggregatelimit` keeps its documented lower-limit semantics.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `FetchLinkAndFilterLimit`                                                                                                                                | **Simulator experiment**: combined bound for ordinary joins plus existential filter links (default 27), separate from `QueryLinkEntityLimit`. Not a cloud administration setting.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `FetchLinkDepth`, `FetchJoinRowLimit`                                                                                                                    | **Simulator safety bounds**, not Dataverse organization settings. Exceeding a bound produces an error, not truncated successful data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |

Organization-column controls read one local `organization` row when available, otherwise the catalogue default/not-configured value. Instance overrides take precedence. Support-managed and simulator controls come from explicit overrides/defaults. Changing a budget does not synthesize native Power Pages permission-expansion SQL: Mirage evaluates its supported permission model and query shape. A real site comparison remains separate evidence.

## Presets and concurrent instances

Both pages offer the same configuration presets. Save current overrides, apply a preset, export/import its JSON or delete a saved preset. Presets replace only platform settings and snippet/site-setting overrides; data, identities, web roles, page access rules and backend-operation configuration are preserved. Built-ins are **Source defaults**, **Simulated support increase (30)** and **Disable exported Web API tables**. The latter derives table names from the current export. Applying any preset is a local experiment, not proof that a real support change was approved.

Run independent scenarios against one checkout in separate terminals, with distinct state files and ports:

```sh
npx --no-install paqvilo mirage serve --source ./portal-export --state ./.paqvilo/base.json --port 4311
npx --no-install paqvilo mirage serve --source ./portal-export --state ./.paqvilo/expanded.json --port 4312
```

Each runtime has its own state and authentication cookie. Do not point concurrent runtimes at the same writable state file. Without a state file, embedded runtimes keep independent in-memory overrides that disappear on close. Export a configuration preset when moving an experiment between instances; importing it does not apply it automatically.

## Automation

The loopback API aliases `/_sim/api` and `/__sim/api` expose:

| Route                                        | Operation                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /platform-settings`                     | Catalogue, effective values, origins and coverage                                                            |
| `PATCH /platform-settings`                   | Merge validated named instance overrides                                                                     |
| `DELETE /platform-settings/{key}`            | Restore source/default for one control                                                                       |
| `GET /experiments` / `GET /experiments/{id}` | Portable configuration presets                                                                               |
| `POST /experiments`                          | Save/import `{id,name,platformOverrides,portalOverrides}`; site overrides contain `settings`/`snippets` only |
| `POST /experiments/{id}/apply`               | Apply a preset without replacing business data                                                               |
| `DELETE /experiments/{id}`                   | Delete a saved preset; built-ins are protected                                                               |

Mutations require the existing simulator CSRF header and normal loopback administration checks. Unknown controls, invalid types/ranges, prototype keys and invalid preset imports are rejected before persistence. Individual site values continue to use the existing `portal-settings` and `portal-snippets` APIs; DELETE resets the override while a null PATCH locally removes the effective value.

`connectRuntime` from `paqvilo/mirage/testing` wraps these APIs with automatic CSRF:
`platformSettings`, `setPlatformSettings`, `resetPlatformSetting`, `siteSettings`,
`setSiteSetting`, `resetSiteSetting`, `setSnippet`, `resetSnippet`, `experiments`,
`saveExperiment`, `applyExperiment` and `deleteExperiment`. Combine them with
cookie-isolated visitors and `runSessionMatrix`. Configuration is shared by visitors;
finish a matrix before changing it or connect separate runtimes for parallel experiments.

Example preset:

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
