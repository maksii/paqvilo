import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {
  clientManagedControlsRuntime,
  validateManagedControlDefinition,
} from "../lib/managed-controls.mjs";
import { renderComponent } from "../lib/platform.mjs";
const name = "MscrmControls.RichTextEditor.RichTextEditorControl";
const manifest = {
  Name: name,
  Properties: [],
  IncludedProperties: [],
  Resources: [],
};

test("captured static PCF definitions generate local native binding contexts without embedding a copied record", async () => {
  const managedControls = {
    [name]: {
      manifest,
      scripts: ["/managed/pcf.js"],
      stylesheets: ["/managed/pcf.css"],
    },
  };
  const html = await renderComponent(
    "entityform",
    "Narrative",
    { request: { params: { id: "local-record" } } },
    {
      portal: {
        forms: [{ id: "edit", name: "Narrative", mode: 100000001 }],
        records: [],
        webFiles: [],
      },
      store: {
        resolveMapping: () => ({ idColumn: "exampleid" }),
        get: async () => ({ narrative: "<p>Local record content</p>" }),
      },
      schemas: {
        edit: {
          entity: "example",
          fields: [{ name: "narrative", richText: { name } }],
        },
      },
      managedControls,
    },
  );
  assert.match(html, /id="PcfControlConfig_narrative"/);
  assert.match(
    html,
    /pcf-controlcontext=".*&quot;UniqueId&quot;:&quot;narrative_ControlView&quot;/,
  );
  assert.match(
    html,
    /&quot;value&quot;:&quot;&lt;p&gt;Local record content&lt;\/p&gt;&quot;/,
  );
  assert.doesNotMatch(html, /id="narrative_editor"/);
  assert.match(html, /loadAllPcfControlsOnPage/);
  assert.throws(
    () =>
      validateManagedControlDefinition(
        { manifest, scripts: ["https://external.invalid/runtime.js"] },
        name,
      ),
    /local absolute path/,
  );
  assert.throws(
    () =>
      validateManagedControlDefinition(
        { manifest, fabricConfig: { fontBaseUrl: "https://external.invalid" } },
        name,
      ),
    /local font\/icon/,
  );
});

test("native PCF bootstrap respects existing proxy mount and captures actual load failures", async () => {
  const definitions = { [name]: { manifest } },
    events = [],
    control = {
      dataset: { field: "narrative", controlView: "narrative_ControlView" },
      dispatchEvent: (event) => events.push(event.type),
    },
    value = { id: "narrative", addEventListener() {} };
  let mounts = 0;
  const context = {
    window: null,
    document: {
      readyState: "complete",
      querySelectorAll: (selector) =>
        selector.includes("data-sim-managed-control") ? [control] : [],
      getElementById: (id) =>
        id === "narrative_ControlView" ? { children: [] } : value,
    },
    setTimeout: (resolve) => resolve(),
    CustomEvent: class {
      constructor(type) {
        this.type = type;
      }
    },
    console,
  };
  context.window = context;
  context.loadAllPcfControlsOnPage = () => mounts++;
  await vm.runInNewContext(clientManagedControlsRuntime(definitions), context);
  await vm.runInNewContext(clientManagedControlsRuntime(definitions), context);
  assert.equal(mounts, 1);
  assert.equal(control.dataset.mounted, "native");
  assert.deepEqual(events, ["sim:richtext-ready"]);
  const failures = [];
  delete context.loadAllPcfControlsOnPage;
  context.console = { error: (error) => failures.push(error.message) };
  control.append = (element) => failures.push(element.textContent);
  context.document.createElement = () => ({ setAttribute() {} });
  await vm.runInNewContext(clientManagedControlsRuntime(definitions), context);
  assert.equal(control.dataset.mounted, "failed");
  assert.match(failures[0], /PCF proxy is unavailable/);
});
