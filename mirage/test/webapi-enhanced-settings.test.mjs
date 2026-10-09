// Webapi/* site settings drive the local Web API the same way whether the
// portal export uses the standard model (adx_ YAML), mspp_-named YAML or the
// enhanced data model (powerpagecomponent type 9 with JSON content).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";

const SETTINGS = {
  "Webapi/contact/enabled": "true",
  "Webapi/contact/fields": "fullname,emailaddress1",
  "Webapi/error/innererror": "true",
};
const xmlText = (value) =>
  String(value).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const FORMATS = {
  "standard adx_ YAML": {
    "website.yml": "adx_websiteid: site\nadx_name: Standard\n",
    "sitesetting.yml": Object.entries(SETTINGS)
      .map(([name, value]) => `- adx_name: ${name}\n  adx_value: '${value}'`)
      .join("\n"),
  },
  "mspp_-named YAML": {
    "website.yml": "mspp_websiteid: site\nmspp_name: Enhanced YAML\n",
    "sitesetting.yml": Object.entries(SETTINGS)
      .map(([name, value]) => `- mspp_name: ${name}\n  mspp_value: '${value}'`)
      .join("\n"),
  },
  "enhanced powerpagecomponent XML": Object.fromEntries([
    [
      "powerpagecomponents/home/powerpagecomponent.xml",
      `<powerpagecomponent powerpagecomponentid="home"><name>Home</name><powerpagecomponenttype>2</powerpagecomponenttype><content>${xmlText(JSON.stringify({ adx_webpageid: "home", adx_name: "Home", adx_partialurl: "/" }))}</content></powerpagecomponent>`,
    ],
    ...Object.entries(SETTINGS).map(([name, value], index) => [
      `powerpagecomponents/setting-${index}/powerpagecomponent.xml`,
      `<powerpagecomponent powerpagecomponentid="setting-${index}"><content>${xmlText(JSON.stringify({ value, source: 0 }, null, 2))}</content><name>${name}</name><powerpagecomponenttype>9</powerpagecomponenttype><statecode>0</statecode></powerpagecomponent>`,
    ]),
  ]),
};
const state = () => ({
  mappings: {
    contact: {
      entitySet: "contacts",
      idColumn: "contactid",
      fields: {
        fullname: { dataverseType: "nvarchar" },
        emailaddress1: { dataverseType: "nvarchar", maxLength: 5 },
        secret: { dataverseType: "nvarchar" },
      },
    },
    account: { entitySet: "accounts", idColumn: "accountid" },
  },
  tables: {
    contact: [{ contactid: "00000000-0000-0000-0000-000000000001", fullname: "Ada", secret: "hidden" }],
    account: [],
  },
  settings: { permissionMode: "permissive" },
  simulator: { mode: "local", pageMode: "local", identityScope: "configured", identity: { id: "me", roles: [] }, live: {}, endpoints: [] },
});

for (const [format, files] of Object.entries(FORMATS))
  test(`Webapi site settings from ${format} enable tables, columns and innererror`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-webapi-format-"));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    for (const [file, content] of Object.entries(files)) {
      await fs.mkdir(path.dirname(path.join(directory, file)), { recursive: true });
      await fs.writeFile(path.join(directory, file), content);
    }
    const app = await createSimulator({ sourceDir: directory, initial: state(), watch: false });
    t.after(() => app.close());
    for (const [name, value] of Object.entries(SETTINGS)) assert.equal(app.portal.settings[name], value, name);
    const call = (route, options = {}) =>
      fetch(app.url + route, {
        ...options,
        headers: { __RequestVerificationToken: app.state().csrf, "content-type": "application/json", ...(options.headers ?? {}) },
      });
    let response = await call("/_api/contacts?$select=fullname");
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.value[0].fullname, "Ada");
    assert.equal(body["@odata.context"], `${app.url}/_api/$metadata#contacts(fullname)`);
    response = await call("/_api/contacts?$select=secret");
    assert.equal(response.status, 403);
    assert.deepEqual((await response.json()).error, { code: "90040101", message: "Attribute secret in table contact is not enabled for Web Api." });
    response = await call("/_api/contacts(00000000-0000-0000-0000-000000000001)", {
      method: "PATCH",
      body: JSON.stringify({ emailaddress1: "toolong" }),
    });
    assert.equal(response.status, 400);
    const error = (await response.json()).error;
    assert.equal(error.code, "9004010D");
    assert.equal(error.innererror.code, "0x80044331", "Webapi/error/innererror is honoured");
    response = await call("/_api/accounts?$select=accountid");
    assert.equal(response.status, 404);
    assert.deepEqual((await response.json()).error, { code: "9004010C", message: "Resource not found for the segment account." });
  });
