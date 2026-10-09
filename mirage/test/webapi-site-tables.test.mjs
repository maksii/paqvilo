// Site components and web role memberships through the local Web API:
// the documented N:N powerpagecomponent_mspp_webrole_contact (enhanced) and
// adx_webrole_contact (standard), with rows derived from the export and the
// personas' memberships, and powerpagecomponents under the portal's grants.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";

const ME = "00000000-0000-0000-0000-0000000000aa";
const OTHER = "00000000-0000-0000-0000-0000000000bb";
const PUBLISHER = "11111111-1111-1111-1111-111111111111";
const READER = "22222222-2222-2222-2222-222222222222";
const xmlText = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const component = (id, type, name, content) =>
  `<powerpagecomponent powerpagecomponentid="${id}"><name>${xmlText(name)}</name><powerpagecomponenttype>${type}</powerpagecomponenttype><content>${xmlText(JSON.stringify(content))}</content><statecode>0</statecode></powerpagecomponent>`;
const setting = (index, name, value) => [
  `powerpagecomponents/setting-${index}/powerpagecomponent.xml`,
  component(`00000000-0000-0000-0000-00000000010${index}`, 9, name, { value, source: 0 }),
];

async function start(t, files, { permissions, contactRoles }) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-site-tables-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
    await fs.writeFile(path.join(directory, file), content);
  }
  const app = await createSimulator({
    sourceDir: directory,
    watch: false,
    initial: {
      mappings: { contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" } },
      tables: {
        contact: [
          { contactid: ME, fullname: "Me", statecode: 0 },
          { contactid: OTHER, fullname: "Other", statecode: 0 },
        ],
      },
      permissions,
      settings: { permissionMode: "enforce" },
      simulator: {
        mode: "local",
        pageMode: "local",
        identityScope: "configured",
        // Table grants follow the configured role names; web role memberships come
        // from contactRoles, which also back the site's membership intersect.
        identity: { id: ME, contactId: ME, roles: ["Authenticated Users"] },
        contactRoles,
        live: {},
        endpoints: [],
      },
    },
  });
  t.after(() => app.close());
  const get = async (route) => {
    const response = await fetch(app.url + route);
    return { status: response.status, body: await response.json() };
  };
  return { app, get };
}

const ENHANCED = Object.fromEntries([
  ["powerpagecomponents/home/powerpagecomponent.xml", component("00000000-0000-0000-0000-000000000001", 2, "Home", { adx_webpageid: "00000000-0000-0000-0000-000000000001", adx_name: "Home", adx_partialurl: "/" })],
  ["powerpagecomponents/publisher/powerpagecomponent.xml", component(PUBLISHER, 11, "Publishers", { adx_name: "Publishers" })],
  ["powerpagecomponents/reader/powerpagecomponent.xml", component(READER, 11, "Readers", { adx_name: "Readers" })],
  setting(1, "Webapi/contact/enabled", "true"),
  setting(2, "Webapi/contact/fields", "fullname"),
  setting(3, "Webapi/powerpagecomponent/enabled", "true"),
  setting(4, "Webapi/powerpagecomponent/fields", "name"),
]);
const contactSelf = { id: "self", entity: "contact", scope: "self", roles: ["Authenticated Users"], operations: ["read"] };

test("enhanced model: contacts expand their web roles through powerpagecomponent_mspp_webrole_contact", async (t) => {
  const { get } = await start(t, ENHANCED, {
    permissions: [contactSelf, { id: "components", entity: "powerpagecomponent", scope: "global", roles: ["Authenticated Users"], operations: ["read"] }],
    contactRoles: [{ contactId: ME, roleId: PUBLISHER }, { contactId: OTHER, roleId: READER }],
  });
  // The Example client-side role check (Draft Notification, Review Draft, ...).
  const roles = await get(`/_api/contacts(${ME})?$select=contactid&$expand=powerpagecomponent_mspp_webrole_contact($select=name,powerpagecomponentid)`);
  assert.equal(roles.status, 200);
  assert.deepEqual(
    roles.body.powerpagecomponent_mspp_webrole_contact.map(({ name, powerpagecomponentid }) => ({ name, powerpagecomponentid })),
    [{ name: "Publishers", powerpagecomponentid: PUBLISHER }],
    "only the signed-in contact's own memberships",
  );
  // Imported site components are readable under the portal's grant.
  const components = await get("/_api/powerpagecomponents?$select=name");
  assert.equal(components.status, 200);
  assert.deepEqual(components.body.value.map((row) => row.name).sort(), ["Home", "Publishers", "Readers", "Webapi/contact/enabled", "Webapi/contact/fields", "Webapi/powerpagecomponent/enabled", "Webapi/powerpagecomponent/fields"].sort());
  assert.ok(components.body.value.every((row) => typeof row.powerpagecomponentid === "string"));
  const roleRow = await get(`/_api/powerpagecomponents(${PUBLISHER})?$select=name`);
  assert.equal(roleRow.body.name, "Publishers");
});

test("site components are read-only locally", async (t) => {
  const { app } = await start(t, ENHANCED, {
    permissions: [contactSelf, { id: "components", entity: "powerpagecomponent", scope: "global", roles: ["Authenticated Users"], operations: ["read", "update"] }],
    contactRoles: [],
  });
  const response = await fetch(`${app.url}/_api/powerpagecomponents(${PUBLISHER})`, {
    method: "PATCH",
    headers: { "content-type": "application/json", __RequestVerificationToken: app.state().csrf },
    body: JSON.stringify({ name: "Renamed" }),
  });
  assert.equal(response.status, 501);
  assert.equal(response.headers.get("x-sim-error-code"), "NotImplemented");
});

test("enhanced model: without a grant on powerpagecomponent the components are denied", async (t) => {
  const { get } = await start(t, ENHANCED, { permissions: [contactSelf], contactRoles: [{ contactId: ME, roleId: PUBLISHER }] });
  const components = await get("/_api/powerpagecomponents?$select=name");
  assert.equal(components.status, 403);
  assert.deepEqual(components.body.error, { code: "90040120", message: "You don't have permission to read the powerpagecomponent table." });
});

test("standard model: contacts expand their web roles through adx_webrole_contact", async (t) => {
  const { get } = await start(
    t,
    {
      "website.yml": "adx_websiteid: site\nadx_name: Standard\n",
      "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n",
      "webrole.yml": `- adx_webroleid: ${PUBLISHER}\n  adx_name: Publishers\n- adx_webroleid: ${READER}\n  adx_name: Readers\n`,
      "sitesetting.yml": [
        ["Webapi/contact/enabled", "true"],
        ["Webapi/contact/fields", "fullname"],
        ["Webapi/adx_webrole/enabled", "true"],
        ["Webapi/adx_webrole/fields", "adx_name"],
      ]
        .map(([name, value]) => `- adx_name: ${name}\n  adx_value: '${value}'`)
        .join("\n"),
    },
    {
      permissions: [contactSelf, { id: "roles", entity: "adx_webrole", scope: "global", roles: ["Authenticated Users"], operations: ["read"] }],
      contactRoles: [{ contactId: ME, roleId: READER }],
    },
  );
  const roles = await get(`/_api/contacts(${ME})?$select=contactid&$expand=adx_webrole_contact($select=adx_name)`);
  assert.equal(roles.status, 200);
  assert.deepEqual(roles.body.adx_webrole_contact.map((row) => row.adx_name), ["Readers"]);
});

test("Liquid FetchXML reads the site tables before any Web API request", async (t) => {
  const liquid = `{% fetchxml roles %}<fetch><entity name="powerpagecomponent"><attribute name="name"/><order attribute="name"/><link-entity name="powerpagecomponent_mspp_webrole_contact" from="powerpagecomponentid" to="powerpagecomponentid" intersect="true"><filter><condition attribute="contactid" operator="eq" value="${ME}"/></filter></link-entity></entity></fetch>{% endfetchxml %}<p id="roles">{% for row in roles.results.entities %}[{{ row.name }}]{% endfor %}</p>`;
  const files = {
    ...ENHANCED,
    "powerpagecomponents/home/powerpagecomponent.xml": component("00000000-0000-0000-0000-000000000001", 2, "Home", {
      adx_webpageid: "00000000-0000-0000-0000-000000000001",
      adx_name: "Home",
      adx_partialurl: "/",
      adx_copy: liquid,
    }),
  };
  const { app } = await start(t, files, {
    permissions: [contactSelf, { id: "components", entity: "powerpagecomponent", scope: "global", roles: ["Authenticated Users"], operations: ["read"] }],
    contactRoles: [{ contactId: ME, roleId: PUBLISHER }, { contactId: OTHER, roleId: READER }],
  });
  // The first request of the simulator is the page render.
  const html = await (await fetch(app.url + "/")).text();
  assert.match(html, /<p id="roles">\[Publishers\]<\/p>/);
});
