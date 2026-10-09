import test from "node:test";
import assert from "node:assert/strict";
import { createPortalRenderer } from "../lib/liquid.mjs";
import { DataStore } from "../lib/data.mjs";
const portal = {
  templates: {},
  snippets: {},
  settings: {},
  pages: [],
  webFiles: [],
  lists: [],
  entityForms: [],
  advancedForms: [],
};
test("Quoted nested Liquid used by the exported paging-cookie assignment remains executable", async () => {
  const source = `{% assign pagingCookie = ' paging-cookie = "{{ pagingCookie | replace: "amp;","" }}"' | liquid %}{% fetchxml rows %}<fetch {{pagingCookie}} count="2" page="2"><entity name="item" /></fetch>{% endfetchxml %}{{rows.results.entities[0].name}}`;
  const store = await new DataStore({
    state: {
      mappings: { item: { entitySet: "items", idColumn: "itemid" } },
      tables: {
        item: [1, 2, 3, 4].map((n) => ({
          itemid: String(n),
          name: `Item ${n}`,
        })),
      },
      settings: { permissionMode: "permissive" },
    },
  }).init();
  let xml;
  const renderer = createPortalRenderer(portal, {
    fetchXml: (value) => {
      xml = value;
      return store.fetchXml(value);
    },
  });
  assert.equal(
    await renderer.renderString(source, {
      pagingCookie: "&lt;cookie page=&quot;1&quot; /&gt;",
    }),
    "Item 3",
  );
  assert.match(xml, /paging-cookie = "&lt;cookie page=&quot;1&quot; \/&gt;"/);
  // DotLiquid reads tag attribute values with its variable parser, so the braces
  // around an attribute expression are ignored: value resolves user.fullname.
  portal.templates.Template = { name: "Template", source: "[{{ value }}]" };
  assert.equal(
    await renderer.renderString('{% include "Template" value: {{user.fullname}} %}', {
      user: { fullname: "Ada Lovelace" },
    }),
    "[Ada Lovelace]",
  );
  assert.equal(
    await renderer.renderString("{{name}}", { name: "Alex" }),
    "Alex",
  );
});
