# Your portal project, data packs and tests

Maintain a separate repository for your portal and business behavior. A typical structure is:

```text
my-portal-project/
  package.json
  paqvilo.config.yml
  sources/portal-export/
  solutions/
  pack/pack.mjs
  pack/generators/
  pack/fixtures/
  test/
  test-browser/
  .vscode/launch.json       # project browser/debugger workflows
  .vscode/tasks.json        # project commands and validation
  .paqvilo/                 # ignored state, screenshots and reference evidence
```

Install Paqvilo as a dependency, register your pack, and run your own tests from this project. The [starter](../examples/project/README.md) is complete and uses invented data. Your test suite can consume the public modules without editing Paqvilo's core:

```js
import { createSimulator } from 'paqvilo/mirage/server.mjs';
import { signInHeaders, signInContext } from 'paqvilo/mirage/testing/session.mjs';
import { discoverPacks, presetLibrary } from 'paqvilo/mirage/lib/preset-registry.mjs';
import { DataStore } from 'paqvilo/mirage/lib/data.mjs';

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

Do not depend on a pack being a global builtin. Supply the pack library to `DataStore.applyPreset` and explicit modules to `createSimulator` or a project file. The default preset library contains only `empty-local`, `open-sandbox`, `strict-permissions` and `contact-demo`. Presets from one matching project must never appear in another portal's runtime.

Project scripts can run `node --test test/*.test.mjs` and `node --test test-browser/*.test.mjs`, select local scenarios and collect evidence independently. Preserve core tests for reusable platform semantics. If a business test uncovers a generic bug, add a minimal synthetic regression to Paqvilo and keep the complete business case in your project. Acceptance and parity plans can be project fixtures passed to the runtime tools; running those plans never authorizes live writes.

## Project commands and editor workflows

Own your daily npm shortcuts, `.vscode/launch.json` and `.vscode/tasks.json` in your portal project. Run tasks with that project's working directory and catalogue, invoking the installed `paqvilo` binary. This keeps portal/environment choices, scenario presets, browser profiles and project tests with their owners. The toolkit repository's launches and tasks provide generic defaults for working on Paqvilo.

A project can map `npm run dev` to `paqvilo lense dev` and `npm run mirage:dev` to `paqvilo mirage dev`, adding its own `--config`, site, environment and preset options. `mirage dev` already opens the Lense browser with Inspect/Tweaks. Use `--portals selected` for one target or `--portals all` for a catalogue workflow. If separate live and local browsers run together, give them distinct named profiles and debugger ports. A browser debugger launch should attach to its matching `--debug-port`, and wait for the development task's browser-ready message before attaching.

Keep a project's validation task pointed at its own test scripts. Core validation remains in the toolkit checkout. A workspace file can include the project and its external portal/Solution source folders without moving those sources into Paqvilo.

Packs may contribute deterministic generators, personas, declarative backend rules, expression operators, local endpoints, shell conventions and parity plans. See [the full contract](../mirage/docs/data-packs.md). Do not check live exports, private identifiers or capture files into the public toolkit.
