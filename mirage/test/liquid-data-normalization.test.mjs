import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  DataStore,
  formatMockRecord,
  normalizeMockLiquidRecord,
  normalizeMockLiquidFetchXml,
} from "../lib/data.mjs";
import { createSimulator } from "../server.mjs";
import { createPortalRenderer } from "../lib/liquid.mjs";
import { normalizeLiveRecord } from "../lib/live.mjs";

const definition = {
  dataverseType: "picklist",
  options: [
    { value: 100000000, label: "Draft" },
    { value: 100000001, label: "In progress" },
  ],
};
const mapping = {
  entitySet: "changes",
  idColumn: "changeid",
  fields: {
    sample_status: definition,
    quantity: { dataverseType: "int" },
    enabled: {
      dataverseType: "bit",
      options: [
        { value: 0, label: "No" },
        { value: 1, label: "Yes" },
      ],
    },
  },
};
const initial = () => ({
  mappings: { change: mapping },
  tables: {
    change: [
      {
        changeid: "one",
        sample_status: { value: 100000000, label: "Draft" },
        quantity: 10,
        enabled: true,
      },
    ],
  },
  plugins: [],
  permissions: [
    {
      id: "change",
      entity: "change",
      roles: ["Reader"],
      operations: ["read", "update"],
      scope: "global",
    },
  ],
  settings: { permissionMode: "enforce" },
  simulator: {
    mode: "local",
    pageMode: "local",
    // Identity is not the subject here: page requests use the configured persona.
    identityScope: "configured",
    identity: { id: "person", roles: ["Reader"] },
    live: {},
    endpoints: [],
  },
});
test("authored packaged-product Liquid item.id resolves its permitted physical primary ID without leaking an extra API column", async () => {
  const state = initial();
  state.permissions[0].scope = "contact";
  state.permissions[0].field = "owner";
  state.tables.change[0].owner = "person";
  state.tables.change.push({ changeid: "other", owner: "other" });
  const store = await new DataStore({ state }).init(),
    identity = { contactId: "person", roles: ["Reader"] },
    xml =
      '<fetch><entity name="change"><attribute name="changeid"/></entity></fetch>';
  const normalized = normalizeMockLiquidFetchXml(
    store.fetchXml(xml, identity),
    xml,
    { change: mapping },
  );
  assert.equal(normalized.entities[0].id, "one");
  assert.equal(normalized.entities.length, 1);
  assert.equal(Object.keys(normalized.entities[0]).includes("id"), false);
  assert.deepEqual(formatMockRecord(normalized.entities[0], mapping), {
    changeid: "one",
  });
  assert.equal(JSON.stringify(normalized.entities[0]), '{"changeid":"one"}');
  const renderer = createPortalRenderer(
    {
      records: [],
      pages: [],
      webTemplates: [],
      pageTemplates: [],
      snippets: {},
      settings: {},
    },
    {
      fetchXml: (query) =>
        normalizeMockLiquidFetchXml(store.fetchXml(query, identity), query, {
          change: mapping,
        }),
    },
  );
  assert.equal(
    await renderer.renderString(
      `{% fetchxml rows %}${xml}{% endfetchxml %}{% for item in rows.results.entities %}{"DT_RowId":"{{item.id}}"}{% endfor %}`,
    ),
    '{"DT_RowId":"one"}',
  );
  assert.equal(
    normalizeMockLiquidRecord(store.get("change", "one", identity), mapping).id,
    "one",
  );
  assert.equal(
    Object.hasOwn(store.get("change", "one", identity), "id"),
    false,
  );
  assert.equal(normalizeLiveRecord({ changeid: "one" }, mapping).id, "one");
  assert.equal(
    Object.hasOwn(
      normalizeLiveRecord({ changeid: "one" }, mapping, { aggregate: true }),
      "id",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      normalizeMockLiquidRecord({ changeid: 2 }, mapping, { aggregate: true }),
      "id",
    ),
    false,
  );
  assert.equal(
    normalizeMockLiquidRecord({ sample_status: 1 }, mapping).id,
    undefined,
  );
});
test("numeric API-style updates acquire native Liquid choices without modifying persistence or API numbers", async () => {
  const store = await new DataStore({ state: initial() }).init(),
    identity = { roles: ["Reader"] };
  await store.update("change", "one", { sample_status: 100000001 }, identity);
  const persisted = store.get("change", "one", identity);
  assert.equal(persisted.sample_status, 100000001);
  const normalized = normalizeMockLiquidRecord(persisted, mapping);
  assert.deepEqual(normalized.sample_status, {
    value: 100000001,
    label: "In progress",
  });
  assert.equal(normalized.quantity, 10);
  assert.equal(normalized.enabled, true);
  assert.equal(formatMockRecord(normalized, mapping).sample_status, 100000001);
  assert.equal(
    formatMockRecord(persisted, mapping)[
      "sample_status@OData.Community.Display.V1.FormattedValue"
    ],
    "In progress",
  );
  assert.equal(
    Object.hasOwn(
      formatMockRecord({ sample_status: 42 }, mapping),
      "sample_status@OData.Community.Display.V1.FormattedValue",
    ),
    false,
  );
  const formatted = formatMockRecord(
    { quantity: 1000, unknown: 1000, fraction: 2.5 },
    {
      ...mapping,
      fields: { ...mapping.fields, fraction: { type: "decimal" } },
    },
  );
  assert.equal(formatted.quantity, 1000);
  assert.equal(
    formatted["quantity@OData.Community.Display.V1.FormattedValue"],
    "1,000",
  );
  assert.equal(formatted.unknown, 1000);
  assert.equal(formatted.fraction, 2.5);
  assert.equal(
    Object.hasOwn(
      formatted,
      "unknown@OData.Community.Display.V1.FormattedValue",
    ),
    false,
  );
  assert.equal(
    Object.hasOwn(
      formatted,
      "fraction@OData.Community.Display.V1.FormattedValue",
    ),
    false,
  );
  assert.equal(
    store.query("change", {}, identity).value[0].sample_status,
    100000001,
  );
  assert.equal(store.snapshot().tables.change[0].sample_status, 100000001);
  normalized.sample_status.value = 0;
  assert.equal(store.get("change", "one", identity).sample_status, 100000001);
  const wrapper = {
    sample_status: { value: 100000000, label: "Explicit local label" },
  };
  assert.deepEqual(normalizeMockLiquidRecord(wrapper, mapping), wrapper);
  assert.equal(
    normalizeMockLiquidRecord({ sample_status: 100000001 }, mapping, {
      aggregate: true,
    }).sample_status,
    100000001,
  );
});
test("FetchXML root/link/attribute aliases use each entity metadata while aggregates and ordinary numbers stay numeric", () => {
  const xml =
    '<fetch><entity name="change"><attribute name="sample_status" alias="phase"/><link-entity name="child" from="parent" to="changeid" alias="child"><attribute name="sample_status"/><attribute name="sample_status" alias="childPhase"/></link-entity></entity></fetch>';
  const definitions = {
    change: mapping,
    child: {
      fields: {
        sample_status: {
          ...definition,
          options: [{ value: 100000001, label: "Child progress" }],
        },
      },
    },
  };
  const raw = {
    entities: [
      {
        phase: 100000001,
        "child.sample_status": 100000001,
        childPhase: 100000001,
        quantity: 7,
      },
    ],
    more_records: false,
    total_record_count: 1,
  };
  const normalized = normalizeMockLiquidFetchXml(raw, xml, definitions);
  assert.equal(normalized.entities[0].phase.label, "In progress");
  assert.equal(
    normalized.entities[0]["child.sample_status"].label,
    "Child progress",
  );
  assert.equal(normalized.entities[0].childPhase.label, "Child progress");
  const api = formatMockRecord(normalized.entities[0]);
  assert.equal(api.childPhase, 100000001);
  assert.equal(
    api["childPhase@OData.Community.Display.V1.FormattedValue"],
    "Child progress",
  );
  assert.equal(normalized.entities[0].quantity, 7);
  assert.equal(normalized.total_record_count, 1);
  assert.equal(raw.entities[0].phase, 100000001);
  assert.equal(
    normalizeMockLiquidFetchXml(
      raw,
      xml.replace("<fetch>", '<fetch aggregate="true">'),
      definitions,
    ).entities[0].phase,
    100000001,
  );
});
test("actual HTTP PATCH keeps scalar API values and renders updated Liquid entity plus FetchXML choice value/label", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-liquid-choice-"));
  let app;
  t.after(async () => {
    await app?.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const files = {
    "portal/website.yml": "adx_name: Choices\nadx_websiteid: site",
    "portal/sitesetting.yml":
      "- adx_name: Webapi/change/enabled\n  adx_value: true\n- adx_name: Webapi/change/fields\n  adx_value: '*'",
    "portal/web-pages/Home.webpage.yml":
      "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main",
    "portal/page-templates/Main.pagetemplate.yml":
      "adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
    "portal/web-templates/Main.webtemplate.yml":
      "adx_webtemplateid: main\nadx_name: Main",
    "portal/web-templates/Main.webtemplate.source.html": `<!doctype html><html><body>{% assign record = entities['change']['6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b'] %}<span id="entity">{{record.sample_status.value}}|{{record.sample_status.label}}</span>{% fetchxml rows %}<fetch><entity name="change"><attribute name="sample_status"/></entity></fetch>{% endfetchxml %}<span id="fetch">{{rows.results.entities[0].sample_status.value}}|{{rows.results.entities[0].sample_status.label}}</span></body></html>`,
    "solution/Entities/change/Entity.xml": `<Entity><Name>change</Name><EntityInfo><entity><attributes><attribute PhysicalName="sample_status"><Name>sample_status</Name><LogicalName>sample_status</LogicalName><Type>picklist</Type><optionset><options><option value="100000000"><labels><label description="Draft" languagecode="1033"/></labels></option><option value="100000001"><labels><label description="In progress" languagecode="1033"/></labels></option></options></optionset></attribute></attributes></entity></EntityInfo></Entity>`,
  };
  for (const [file, body] of Object.entries(files)) {
    const target = path.join(dir, file);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }
  app = await createSimulator({
    sourceDir: path.join(dir, "portal"),
    stateFile: path.join(dir, "state.json"),
    solutionRoots: [path.join(dir, "solution")],
    watch: false,
    // The change field list is the wildcard, which hosted sites reject unless exempt.
    observed: { webApiWildcard: "exempt", evidence: "synthetic fixture with a wildcard field list" },
    // entities[table][id] (EntitySetDrop) only loads records addressed by a GUID.
    initial: (() => {
      const seeded = initial();
      seeded.tables.change[0].changeid = "6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
      return seeded;
    })(),
  });
  const state = await (await fetch(app.url + "/__sim/api/state")).json();
  const patched = await fetch(app.url + "/_api/changes(6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b)", {
    method: "PATCH",
    headers: {
      "content-type": "application/json",
      __RequestVerificationToken: state.csrf,
    },
    body: JSON.stringify({ sample_status: 100000001 }),
  });
  assert.equal(patched.status, 204);
  const rendered = await (await fetch(app.url + "/")).text();
  assert.match(rendered, /<span id="entity">100000001\|In progress<\/span>/);
  assert.match(rendered, /<span id="fetch">100000001\|In progress<\/span>/);
  const api = await (await fetch(app.url + "/_api/changes(6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b)")).json();
  assert.equal(api.sample_status, 100000001);
  assert.equal(
    api["sample_status@OData.Community.Display.V1.FormattedValue"],
    "In progress",
  );
  const fetched = await (
    await fetch(
      app.url +
        "/_api/changes?" +
        new URLSearchParams({
          fetchXml:
            '<fetch><entity name="change"><attribute name="sample_status" alias="phase"/></entity></fetch>',
        }),
    )
  ).json();
  assert.equal(fetched.value[0].phase, 100000001);
  assert.equal(
    fetched.value[0]["phase@OData.Community.Display.V1.FormattedValue"],
    "In progress",
  );
  assert.equal(app.store.snapshot().tables.change[0].sample_status, 100000001);
});

test("custom mapping choice metadata remains available without an imported solution", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-custom-choice-"));
  let app;
  t.after(async () => {
    await app?.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const files = {
    "website.yml": "adx_websiteid: custom\nadx_name: Custom",
    "sitesetting.yml":
      "- adx_name: Webapi/change/enabled\n  adx_value: true\n- adx_name: Webapi/change/fields\n  adx_value: '*'",
    "Home.webpage.yml":
      "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main",
    "Main.pagetemplate.yml":
      "adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
    "Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "Main.webtemplate.source.html":
      "<span>{{entities['change']['6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b'].sample_status.label}}</span>",
  };
  for (const [name, body] of Object.entries(files))
    await fs.writeFile(path.join(dir, name), body);
  const state = initial();
  // entities[table][id] (EntitySetDrop) only loads records addressed by a GUID.
  state.tables.change[0].changeid = "6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b";
  state.tables.change[0].sample_status = 100000001;
  app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, "state.json"),
    solutionRoots: [],
    watch: false,
    // The change field list is the wildcard, which hosted sites reject unless exempt.
    observed: { webApiWildcard: "exempt", evidence: "synthetic fixture with a wildcard field list" },
    initial: state,
  });
  const api = await (await fetch(app.url + "/_api/changes(6f1a2b3c-4d5e-4f60-8a7b-9c0d1e2f3a4b)")).json();
  assert.equal(api.sample_status, 100000001);
  assert.equal(
    api["sample_status@OData.Community.Display.V1.FormattedValue"],
    "In progress",
  );
  const rows = await (await fetch(app.url + "/")).text();
  assert.match(rows, /<span>In progress<\/span>/);
});
