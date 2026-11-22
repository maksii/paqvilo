# Frequently asked questions

## Should I start with Lense or Mirage?

Use **Lense** when you need the real portal backend, live sign-in or online components while editing local frontend
sources. Use **Mirage** for a local portal with simulated data and repeatable scenarios. The
[coverage matrix](coverage.md) compares them area by area.

## How is Lense different from Fiddler or DevTools overrides?

| Existing workflow                                                                                                                                                                                                                                                           | What it provides                                                 | What Paqvilo adds                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [Fiddler Classic AutoResponder](https://www.telerik.com/fiddler/fiddler-classic/documentation/knowledge-base/autoresponder) / [Fiddler Everywhere rules](https://www.telerik.com/fiddler/fiddler-everywhere/documentation/rules-presets/modify-traffic/modify-reponse-body) | Request matching, local file responses and response modification | Power Pages export mapping, Git baseline comparisons and refresh on source saves                  |
| [Chrome DevTools Local Overrides](https://developer.chrome.com/docs/devtools/overrides) / [Edge Overrides](https://learn.microsoft.com/en-us/microsoft-edge/devtools-guide-chromium/javascript/overrides)                                                                   | Replace browser resources with local copies                      | Portal record and field identity, supported inline edits and integrated Online / Local comparison |
| [Power Platform CLI and VS Code](https://learn.microsoft.com/en-us/power-pages/configure/developer-overview)                                                                                                                                                                | Source editing and portal download/upload                        | A local Liquid and Dataverse simulation for independent development and repeatable tests          |

DevTools and Fiddler remain useful for general browser and HTTP debugging.

## Do I need .NET or PAC to run the demo?

No. The demo needs Node.js and Edge or Chrome; it ships compiled plug-ins and deployment archives. Install the .NET SDK
only to rebuild its C# plug-ins, and PAC only to deploy or export a site.

## Does saving a file deploy it or change Dataverse?

No. Saving changes a local file, which Lense previews in its browser and Mirage renders locally. Lense's portal actions
still use live Dataverse, so submitting or deleting a record affects that environment. Mirage actions use local state
unless you explicitly configure a live provider or pass `--allow-live-writes`.

## Why does my own Mirage portal start empty?

An export contains portal configuration, not business records. Add generated rows (`mirage data scaffold`), a
[data pack](../mirage/docs/data-packs.md) or local records. Portal requests are anonymous until you sign in as a local
persona; local personas are separate from your Microsoft account.

## Why add a Solution export?

Portal files name the basic form or list. Unpacked Solution metadata supplies the FormXml, views, table fields,
relationships and code components behind them, which Inspect links to and Mirage renders from. See
[configuration](configuration.md).

## Why does Inspect show an unknown or static reference?

Liquid can choose components dynamically, exports can omit managed metadata, and a static reference may belong to a
branch that did not render. Inspect does not infer missing bindings, a deployed revision or a live user's effective
permission. Add the missing sources, use **Refresh inspection**, and read the
[selection evidence](lense.md#selection-evidence) states.

## What if a component works online but differs locally?

Check diagnostics and the [coverage matrix](coverage.md). Unsupported PCF hosts, flow actions, external services or
missing metadata can need a mock or a [project extension](project-extensions.md).

## Does Mirage execute my Dataverse plug-in DLL?

It depends on where the assembly comes from. A Power Pages export carries registrations without the DLL, so those steps
run trusted project handlers, mocks or visible placeholders that report the skipped logic, unless a trusted
`pluginRuntimes` descriptor names your build. A step whose assembly has content (read from a Solution export's
`.dll`, or uploaded to the local organization) runs it by default when no handler or mock is registered for it.
Original assemblies run on Windows x64 only, and since 0.9.8 you can debug them in VS Code. See
[plug-in simulation](../mirage/docs/dataverse-plugins.md).
