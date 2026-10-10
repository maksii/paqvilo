# Dataverse plugins

Two small C# plugins demonstrate synchronous Create and Update behavior for accounts and contacts. The solution contains the assembly and eight registered steps. See [registrations.json](registrations.json) for exact IDs, stages and Update filtering attributes.

| Plugin | PreValidation, stage 10 | PreOperation, stage 20 |
| --- | --- | --- |
| AccountRules | Supplied account names require at least three characters after trimming. | Trim the name, lowercase and trim the email, and derive a ticker from the first ten ASCII letters or digits in a supplied name. |
| ContactRules | Supplied contact last names require at least two characters after trimming. | Trim supplied first and last names, and lowercase and trim the email. |

Both stages run synchronously on Create and Update with rank 10. Update steps filter on the relevant input fields. A rejected write leaves the record unchanged.

The demo intentionally enables `Webapi/error/innererror` so the Web API and PCF pages show the plugin's validation message. Their controller renders this message as text. Review this setting before deploying a production portal: [Microsoft's Web API settings](https://learn.microsoft.com/en-us/power-pages/configure/web-api-overview) default to hiding inner errors.

## Build and deploy

Install the .NET SDK, then run from this directory:

```sh
dotnet build DataversePlugins.csproj --configuration Release -p:RestoreLockedMode=true
```

The project targets .NET Framework 4.6.2 and restores pinned SDK packages. The output is `bin/Release/net462/Paqvilo.Demo.Plugins.dll`.

The prepared workspace provides **demo: Build Dataverse plugins**. To include a rebuilt assembly in a new solution archive, replace `solution/PluginAssemblies/PaqviloDemoPlugins-B4700000-0000-4000-8000-370000000001/PaqviloDemoPlugins.dll` with that output, then run the solution pack command in the [deployment guide](../../deployment/README.md).

Import the sample solution to deploy the assembly and all eight steps together. For an assembly-only update after changing this source, use the assembly ID in `registrations.json`:

```sh
pac plugin push --pluginId b4700000-0000-4000-8000-370000000001 --pluginFile ./bin/Release/net462/Paqvilo.Demo.Plugins.dll --type Assembly
```

`PublicDemo.snk` is an intentionally public development key that preserves this sample's assembly identity when rebuilt. Production assemblies should use their own protected signing key.

## Local simulation

[The project pack](../../pack/dataverse-plugins.mjs) explicitly models the same demo rules for Mirage and maps each handler to its exported step ID. Mirage discovers the registrations and runs these trusted JavaScript handlers; it does not execute the compiled .NET assembly. The project regression tests cover validation, normalization, derived ticker values, Update filtering and rollback.

PAC exports SDK message IDs without names. The project records the corresponding Dataverse SDK message reads in `mirage.observed.sdkMessages` in its catalogue. This identifies the message without deriving it from a step label.

Microsoft references: [plugin registration](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/register-plug-in), [event framework](https://learn.microsoft.com/en-us/power-apps/developer/data-platform/event-framework).
