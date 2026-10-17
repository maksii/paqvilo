import test from "node:test";
import assert from "node:assert/strict";
import { renderComponent } from "../lib/platform.mjs";

// Synthetic dropdown lookup without a DefaultViewId: the choices come from the target table's
// default lookup view (querytype 64), so its filter applies.
test("dropdown lookup without a view reads the target's default lookup view", async () => {
  const ID = "e0000000-0000-4000-8000-000000000001";
  const fetched = [];
  const store = {
    resolveMapping: (entity) => (entity === "owner" ? { entitySet: "owners", idColumn: "ownerid", nameColumn: "name" } : { entitySet: "things", idColumn: "thingid", relationships: { thing_owner: { from: "ownerref", entity: "owner", many: false } } }),
    get: async () => ({ thingid: ID, ownerref: null }),
    query: async () => ({ value: [{ ownerid: "o1", name: "Active owner" }, { ownerid: "o2", name: "Inactive owner" }] }),
    fetchXml: async (xml) => (fetched.push(xml), { entities: [{ ownerid: "o1", name: "Active owner" }] }),
  };
  const views = [
    { entity: "owner", id: "v-quickfind", queryType: 4, isDefault: true, fetchXml: '<fetch><entity name="owner"/></fetch>', fields: [] },
    { entity: "owner", id: "v-lookup", queryType: 64, isDefault: true, fetchXml: '<fetch><entity name="owner"><attribute name="name"/><filter><condition attribute="statecode" operator="eq" value="0"/></filter></entity></fetch>', fields: [{ name: "name" }] },
  ];
  const fields = [{ name: "ownerref", label: "Owner", dataverseType: "lookup", lookupTargets: ["owner"] }];
  const portal = {
    forms: [{ id: "form", name: "Thing", mode: 100000001 }],
    records: [{ kind: "basicformmetadata", adx_entityform: "form", adx_type: 100000000, adx_attributelogicalname: "ownerref", adx_controlstyle: 756150000 }],
    website: { id: "site" }, pages: [],
  };
  const schemas = { form: { entity: "thing", title: "Thing", fields, layout: [{ name: "t", columns: [{ sections: [{ name: "s", rows: [[{ name: "ownerref" }]] }] }] }] } };
  const html = await renderComponent("entityform", "form", { user: { id: "current" }, request: { params: { id: ID } } }, { portal, store, schemas, metadata: { views } });
  assert.equal(fetched.length, 1);
  assert.match(fetched[0], /statecode/);
  assert.match(html, /<option value="o1">Active owner<\/option>/);
  assert.doesNotMatch(html, /Inactive owner/);
});
