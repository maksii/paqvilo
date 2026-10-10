# Dataverse plugin registrations

Mirage discovers plugin assemblies, types and steps from selected Solution sources. **Operations** shows their table, SDK message, stage, execution order, mode and filtering attributes. **Inspect** links applicable steps to exported metadata and explicitly mapped C# sources. Lense uses the same inventory; exported registrations do not prove which steps are active online.

Compiled .NET assemblies are not executed locally. Choose a simulation mode for each step:

| Mode | Local behavior |
| --- | --- |
| Placeholder | CRUD continues; `PLUGIN_STEP_PLACEHOLDER` reports skipped business logic |
| JSON mock | Return a target patch or reject the write |
| Project handler | Run a trusted, explicitly registered synchronous JavaScript model |

Async steps and unsupported messages or registrations retain diagnostics. They do not run as synchronous substitutes. Select **Use source default** to remove a local override.

## Configure source facts

PAC can export an SDK message ID without its name. Supply `observed.sdkMessages` entries with the exact ID, name and evidence from your environment. Mirage does not guess the operation from a step label.

To connect a supplied C# project, map an exact exported type name through `observed.pluginSources`:

Use the site's `mirage.observed` block in a Lense catalogue, or that portal's `observed` block in a Mirage project manifest.

```yaml
observed:
  evidence: Plugin sources and SDK message names verified for this project.
  pluginSources:
    Vendor.Plugins.CustomerRules:
      path: components/Plugins/CustomerRules.cs
      evidence: Type declaration matches the exported PluginType name.
```

Catalogue paths resolve from `sourceRoot`; project-file paths resolve from that project directory. Mappings must point to regular `.cs` files within the trusted root. Exported assembly and type metadata remain available when source code is absent.

## Model a write

A mock response body can change submitted values during stage 10 or 20:

```json
{"target":{"displayname":"Normalized value"}}
```

To test rejection, use:

```json
{"error":{"message":"The supplied value is invalid."}}
```

Project packs register `pluginSteps` handlers by exact step ID. A synchronous handler receives `step`, `entity`, `operation`, `stage`, `target`, `record`, `previous`, `identity`, `changedAttributes` and `reject(message)`. Return `{target:{...}}` to apply a patch. Context records are cloned; editing them alone does not change the store. Async handlers are rejected. Stage 40 and Delete handlers cannot patch the target.

Local Create, Update and Delete run supported stages 10, 20 and 40 in stage/rank/ID order. Update filtering checks submitted column names, including unchanged values. Authorization runs before handlers, and failures roll back the local write across all stages. These are local model semantics: Dataverse has its own security, transaction, impersonation, image and async behavior. See Microsoft's [event framework](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/event-framework) and [registration reference](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/register-plug-in).

The [demo plugin project](../../examples/project/components/DataversePlugins/README.md) includes C# sources, eight exported registrations and matching local models. Use [project tests](data-packs.md) to compare your model with authorized live execution.
