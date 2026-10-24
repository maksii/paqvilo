# Your portal project, data packs and tests

Maintain a separate repository for your portal and business behavior. Generate the empty layout with
`npx paqvilo init ./my-portal-project --name my-portal-project`. The [scaffold command](project-scaffold.md)
includes `AGENTS.md`, `.env.example`, scripts, editor files, `support/mirage.mjs`, pack tests and per-site
`test-browser/fixtures/<site>/`. One pack uses `pack/`; several explicit `--pack` options use `packs/<id>/`.
A typical structure is:

```text
my-portal-project/
  package.json
  paqvilo.config.yml
  sources/portal-export/
  solutions/
  pack/pack.mjs
  pack/generators/
  pack/fixtures/
  pack/test/pack.test.mjs
  support/mirage.mjs
  test/
  test-browser/
  test-browser/fixtures/portal/
  .vscode/launch.json       # project browser/debugger workflows
  .vscode/tasks.json        # project commands and validation
  .paqvilo/                 # ignored state, screenshots and reference evidence
```

Install Paqvilo as a dependency, register your pack, and run your own tests from this project. The [starter](../examples/project/README.md) is complete and uses invented data. Your test suite can consume the public modules without editing Paqvilo's core:

```js
import { createSimulator, DataStore, discoverPacks, presetLibrary } from 'paqvilo/mirage';
import { signInHeaders, signInContext } from 'paqvilo/mirage/testing';

const packs = await discoverPacks({ explicit: [{ module: './pack/pack.mjs' }] });
const library = presetLibrary({ packs });
const store = new DataStore();
await store.applyPreset('customer-demo', { generatedPresets: library });
const simulator = await createSimulator({
  sourceDir: './sources/portal-export',
  dataPacks: [{ module: './pack/pack.mjs' }],
  initial: store.snapshot(), port: 0, watch: false,
});
// Sign this request/context in explicitly when exercising protected routes.
const headers = signInHeaders(simulator, 'your-synthetic-contact-id');
// Assert your own page/data contracts, then await simulator.close().
```

Use absolute pack/source paths when a test's working directory is not predictable. A Mirage project's `dataPacks` is also supported; it resolves modules relative to that project file. Loading a pack executes trusted JavaScript and is an explicit project decision.

The generated adapter binds all explicitly registered catalogue packs once, without selecting or importing an export:

```js
import { createMirageContext } from 'paqvilo/mirage';
export const mirage = await createMirageContext({ config: new URL('../paqvilo.config.yml', import.meta.url) });
export const { DataStore, createSimulator, initialState, activatePackDeniedRoutes, presetLibrary } = mirage;
```

With `site` omitted, pack unit tests can run before source checkouts exist. Supply `sourceDir` to the bound simulator, or an imported portal to `initialState`. With `site` supplied, the context imports that site's sources/metadata and applies its runtime defaults. Runtime discovery still filters packs against the exported portal; the project binding does not enable a pack whose `matches()` returns false.

Do not depend on a pack being a global builtin. Supply the pack library to `DataStore.applyPreset` and explicit modules to `createSimulator` or a project file. The default preset library contains only `empty-local`, `open-sandbox`, `strict-permissions` and `contact-demo`. Presets from one matching project must never appear in another portal's runtime.

Project scripts can run `node --test test/*.test.mjs` and `node --test test-browser/*.test.mjs`, select local scenarios and collect evidence independently. Preserve core tests for reusable platform semantics. If a business test uncovers a generic bug, add a minimal synthetic regression to Paqvilo and keep the complete business case in your project. Acceptance and parity plans can be project fixtures passed to the runtime tools; running those plans never authorizes live writes.

Project management scripts can import `readPowerPagesSites`, `readPowerPagesSite` and `setPowerPagesSiteVisibility` from `paqvilo/dataverse`. These use the installed PAC `power-pages` management commands with an explicit environment and shell-free arguments. On Windows, configure the actual `pac.exe` path rather than its `pac.cmd` shim. Read APIs return site identity and visibility metadata; credentials, certificates and unknown response fields are withheld. The management site ID differs from the Dataverse website record ID, so verify both and the site URL before a change. The mutation API returns command completion only: the project must own authorization, a durable journal, propagation readback and restoration. Mirage session controls do not grant native site access.

## Project commands and editor workflows

Own your daily npm shortcuts, `.vscode/launch.json` and `.vscode/tasks.json` in your portal project. Run tasks with that project's working directory and catalogue, invoking the installed `paqvilo` binary. This keeps portal/environment choices, scenario presets, browser profiles and project tests with their owners. The toolkit repository's launches and tasks provide generic defaults for working on Paqvilo.

A project can map `npm run dev` to `paqvilo lense dev` and `npm run mirage:dev` to `paqvilo mirage dev`, adding its own `--config`, site, environment and preset options. `mirage dev` already opens the Lense browser with Inspect/Tweaks. Use `--portals selected` for one target or `--portals all` for a catalogue workflow. If separate live and local browsers run together, give them distinct named profiles and debugger ports. A browser debugger launch should attach to its matching `--debug-port`, and wait for the development task's browser-ready message before attaching.

Keep a project's validation task pointed at its own test scripts. Core validation remains in the toolkit checkout. A workspace file can include the project and its external portal/Solution source folders without moving those sources into Paqvilo.

Packs may contribute deterministic generators, personas, declarative backend rules, expression operators, local endpoints, shell conventions and parity plans. See [the full contract](../mirage/docs/data-packs.md). Do not check live exports, private identifiers or capture files into the public toolkit.

## Classic workflow handlers

A trusted pack can run a classic (XAML) workflow. Export `workflows: { '<workflowid or uniquename>': async (ctx) => ({ message }) }`. The key is matched case-insensitively against the workflow id, then its unique name. Mirage never interprets the XAML; without a handler the run is a placeholder that ends Canceled. `ctx` has `workflow` (a copy of the row), `target` (`{ logicalName, id, row }`), `caller`, `inputs` (the `InputArguments` as an object), `api` and `trace(text)`. The handler runs in one store transaction: a throw fails the job (or rejects a real-time request) and rolls its writes back. Duplicate keys across packs are an error.

## Custom API handlers

A trusted pack can implement its Dataverse custom APIs. Export `customApis: { '<uniquename>': async (ctx) => ({ outputs }) }`, or `{ '<uniquename>': { handler, pluginType } }`; the key is the custom API's unique name. `pluginType` is the full name of the provisioned plug-in type (for example `Contoso.Plugins.Echo`). Plug-in messages name it: the timeout message and the `Plugin.ExceptionFromPluginExecute` and trace annotations. Without it, the custom API name stands in.

`ctx` has `name`, `inputs` (typed by parameter, `undefined` when absent), `target` (`{ logicalName, id, row }` for a bound call), `caller`, `origin`, `version`, `api` and `trace(text)`, which records a plug-in trace line (as `ITracingService.Trace` does). The handler runs after parameter checks, as one store transaction. Its `outputs` fill the response properties by name; an output left out is the native default.

- Throw `{ pluginFault: 'InvalidPluginExecutionException', message, errorCode? }` for a plug-in fault: 400 `0x80040265` with its message. A named `errorCode` such as `0x8004F001` is not the top-level code: native carries it in `@Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode` as a signed decimal (`-2147160063`). Without one the SubErrorCode is `-2146233088`.
- Any other throw is unhandled: 400 `0x80040224` with the thrown message.
- A handler still running after `pluginTimeoutSeconds` (a simulator Dataverse setting, default `120`, the 2-minute sandbox limit) is a timeout: 400 `0x80040224`, with the message naming the plug-in type. Its writes roll back.

A custom API with no `customApis` entry runs a `pluginTypes` handler (see "Plug-in type handlers") when its `plugintypeid` names a plug-in type whose `typename` has one. That handler is the API's main operation and receives the same `ctx`. A `customApis` entry for the API always wins over the type handler. The plug-in's name in messages is the type's `typename`.

The plug-in annotations (`Prefer: odata.include-annotations`) follow the native bodies: `ErrorDetails.*`, `HelpLink`, `TraceText` and `InnerError.Message` for a plug-in fault, and the same without `ErrorDetails` for an unhandled or timed-out call. Without a handler, the custom API returns its defaults.

## Plug-in type handlers

A trusted pack can run the plug-in steps that a Dataverse client registered through the API, and every step of one plug-in type. Export `pluginTypes: { '<Namespace.TypeName>': handler }`. The key is the exact CLR type name of the registered type (`plugintype.typename`), matched case-sensitively; the handler is synchronous (an async function is refused). A type name claimed by two packs is an error.

A step whose type has a handler runs it at its stage, mode and rank, when its message, table and filtering attributes match. A step on a type with no handler is stored and skipped (`PLUGIN_STEP_PLACEHOLDER`). A handler keyed by the exported step id (`pluginSteps`) takes precedence over a type handler for that step.

The handler receives the arguments of a `pluginSteps` handler (`step`, `entity`, `operation`, `stage`, `target`, `record`, `previous`, `preImage`, `postImage`, `identity`, `changedAttributes`, `reject`) and also `context`, an IPluginExecutionContext-like object:

- `MessageName`, `PrimaryEntityName`, `PrimaryEntityId`, `Stage`, `Mode` (0 or 1), `Depth` (1 at the top, one more for each nested handler write) and `InitiatingUserId`.
- `UserId`: the step's impersonated user when it names one, else the initiating user.
- `InputParameters`: `Target` for Create, Update and Delete; `Targets` for bulk messages.
- `OutputParameters`: `id` for a PostOperation Create.
- `PreEntityImages` and `PostEntityImages`: the registered images, keyed by alias, limited to their attributes.

`context` is a copy: changing it does not change the write. Return `{ target }` to change a PreOperation Create or Update, or throw.

- A thrown error is the plug-in fault: 400 `0x80040265` with its message. Its `SubErrorCode` annotation is `-2146233088`. The write rolls back.
- An asynchronous (mode 1) step runs after commit through the same queue as the exported ones. While the Dataverse API is on, each run also writes an asyncoperation system job (operation type System Event): Completed with status Succeeded, or Failed with the handler's message. A succeeded job is removed when its step has `asyncautodelete`. The job is written in the run's own transaction, so the portal response does not change.
- `trace(text)` on a plug-in handler's arguments (and `context.trace` for a `pluginTypes` handler) records a trace line. With `organization.plugintracelogsetting` 2 every handler or CLR run writes a plugintracelog row with its trace lines (`messageblock`), type, message, depth and duration; 1 writes only failed runs, with `exceptiondetails`; 0 writes none. The row rolls back with a rolled-back write (native keeps it; the simulator does not).

## Dataverse message handlers

A trusted pack can answer a Dataverse message that the simulator registers, including the add-on messages. Export `dataverseMessages: { '<MessageName>': async (ctx) => body }`. The key is the exact message name, matched case-sensitively. A handler replaces the simulator's own behaviour for that message. Without one, the message runs its simulated behaviour where it has one; otherwise it answers its documented default error.

`ctx` has `name`, `args` (the request body merged with the URL parameters), `target` (`{ logicalName, id, row }` for a bound call, `null` otherwise), `caller`, `user`, `origin`, `version` and `api`. Return an object to set the response body (the `@odata.context` is added); return `undefined` for 204 No Content. Two packs naming the same message is an error. A key that no simulated message registers fails the start: `Data pack <id>: dataverseMessages names unknown message <Name>`.

Some messages are marked "For internal use only" in Microsoft Learn. The simulator registers them with their native signature, so they appear in `$metadata`. Without a pack handler they answer 501 `NotImplemented` with inner code `0x80040216` and the message `<Name> is for internal use only and is not simulated.` Live Dataverse may answer these messages differently.
