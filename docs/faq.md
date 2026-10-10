# Frequently asked questions

## Do I need to know npm or clone the repository?

No cloning is required. Install Node.js, which includes npm and npx. npm downloads Paqvilo into your project; npx runs that installed copy. [Getting started](getting-started.md) explains each command and opens a populated demo without a Power Pages account.

## Should I start with Lense or Mirage?

Use **Lense** when you need the real portal backend, live sign-in or online components while editing local frontend sources. Use **Mirage** for a local portal, simulated data and repeatable scenarios. Both provide Inspect source navigation. See the [coverage matrix](coverage.md).

## Can I work without repeating terminal commands?

Yes. Generate the demo with `--scaffold`, open its prepared VS Code workspace and use **F5**. Tasks install dependencies, start the dedicated browser and attach the debugger. Inspect opens the relevant source in your editor. Follow the [editor workflow](demo.md#prefer-vs-code-tasks).

## Do I need .NET or PAC to run the demo?

No. The local demo needs Node.js and a supported browser. Install the .NET SDK to rebuild its C# plugins, and PAC to deploy or export your own online site. The sample includes compiled plugins and deployment archives.

## How is Lense different from Fiddler or DevTools overrides?

Lense derives resource mappings from Power Pages exports, preserves record and field identity, compares Git baselines and connects rendered components to their source files. Its panel combines resource comparison, diagnostics and source navigation. See the [workflow comparison](../README.md#beyond-fiddler-and-devtools-overrides).

## Does saving a file deploy it or change Dataverse?

Saving changes a local file. Lense can preview supported resources in its browser; Mirage can render them locally. Neither action deploys the site. Lense's portal actions still use live Dataverse, so submitting or deleting a record can affect that environment. Mirage actions use local state unless you explicitly configure a live provider.

## Why does my own Mirage portal start empty?

An export contains portal configuration, not your business records. Add generated rows, a project data pack or explicit local records. Local personas are separate from your Microsoft account. Portal requests start anonymous until local sign-in unless your project explicitly configures a shared identity. The [demo](demo.md) includes both data and personas.

## Why add a Solution export?

Portal files identify the basic form or list. Solution metadata identifies the underlying FormXml, selected views, table fields, relationships and exported code components. Add unpacked Solution roots to resolve these links in Inspect and supply native rendering metadata in Mirage. See [configuration](configuration.md).

## Why does Inspect show an unknown or static reference?

Liquid can choose components dynamically, and exports can omit managed metadata or live identity. A static reference may belong to a branch that was not rendered. Inspect does not infer missing bindings or a live user's effective permission. Add the relevant sources, use **Refresh inspection**, and compare the rendered controls with the source evidence.

## Can I deploy the demo to my own environment?

Yes. The installed demo includes portal and Solution exports, unpacked Solution sources, PCF projects and registered C# plugins. Follow its [deployment guide](../examples/project/deployment/README.md), provide your environment's configuration and seed your own demo rows. Deployment is separate from running Mirage.

## What if a component works online but differs locally?

Check diagnostics and the [coverage matrix](coverage.md). Unsupported PCF hosts, flow actions, external services or missing metadata can require a mock or [project extension](project-extensions.md). Verify important scenarios against your authorized online portal before release.

## Does Mirage execute my Dataverse plugin DLL?

No. It imports the assembly, type and step registrations, then offers placeholders, rejection/target-patch mocks and trusted project handlers. Placeholders keep CRUD available and report that the business logic was skipped. The demo includes matching local models for its registered C# plugins. See [plugin simulation](../mirage/docs/dataverse-plugins.md).
