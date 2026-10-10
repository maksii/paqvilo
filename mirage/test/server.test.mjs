import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { createSimulator } from "../server.mjs";

async function setup(t, { liveBridge, onShutdown, allowLiveWrites = false } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paqvilo-mirage-server-"));
  const files = {
    "website.yml": "adx_name: Integration\nadx_websiteid: site",
    "sitesetting.yml": [
      "contact",
      "account",
    ]
      .map(
        (entity) =>
          `- adx_name: Webapi/${entity}/enabled\n  adx_value: true\n- adx_name: Webapi/${entity}/fields\n  adx_value: '*'`,
      )
      .join("\n"),
    "web-pages/Home.webpage.yml":
      "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main",
    "page-templates/Main.pagetemplate.yml":
      "adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false",
    "web-templates/Main.webtemplate.yml":
      "adx_webtemplateid: main\nadx_name: Main",
    "web-templates/Main.webtemplate.source.html": `<!doctype html><html><head><title>Integration</title></head><body>{% fetchxml rows %}<fetch><entity name="contact"><attribute name="fullname"/></entity></fetch>{% endfetchxml %}<h1>{{rows.results.entities[0].fullname}}</h1></body></html>`,
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), body);
  }
  const initial = {
    version: 1,
    mappings: { contact: { entitySet: "contacts", idColumn: "contactid" } },
    tables: { contact: [{ contactid: "one", fullname: "Visible member" }] },
    permissions: [
      {
        id: "read",
        entity: "contact",
        roles: ["Reader"],
        operations: ["read"],
        scope: "global",
      },
    ],
    plugins: [],
    presets: {},
    settings: { permissionMode: "enforce" },
    simulator: {
      mode: "local",
      pageMode: "local",
      // Requests use the configured persona; session mechanics aren't under test here.
      identityScope: "configured",
      identity: { id: "person", roles: ["Reader"] },
      live: {},
      endpoints: [],
    },
  };
  const app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, "state.json"),
    port: 0,
    watch: false,
    initial,
    liveBridge,
    // Live writes need the runtime permission (cli --allow-live-writes).
    allowLiveWrites,
    onShutdown,
    // The fixture's Webapi/<table>/fields use the wildcard, which hosted sites reject
    // unless exempt.
    observed: { webApiWildcard: "exempt", evidence: "synthetic fixture with wildcard field lists" },
  });
  t.after(async () => {
    await app.close();
    const resolved = await fs.realpath(dir);
    assert.ok(resolved.startsWith(await fs.realpath(os.tmpdir())));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const state = await (await fetch(`${app.url}/__sim/api/state`)).json();
  const call = (route, method = "GET", body, headers = {}) =>
    fetch(app.url + route, {
      method,
      headers: {
        "content-type": "application/json",
        "x-sim-csrf": state.csrf,
        __RequestVerificationToken: state.csrf,
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { app, call, dir, state };
}
test("HTTP: source application-relative links redirect locally, retaining parameters and access checks", async (t) => {
  const { app } = await setup(t);
  for (const [route, target] of [
    ["/~/", "/"],
    ["/%7E/?id=local&orderId=1", "/?id=local&orderId=1"],
    ["/~//elsewhere.invalid/path", "/elsewhere.invalid/path"],
  ]) {
    const response = await fetch(app.url + route, { redirect: "manual" });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get("location"), target);
    assert.equal(new URL(target, app.url).origin, app.url);
  }
  const followed = await fetch(app.url + "/~/");
  assert.equal(followed.status, 200);
  assert.match(await followed.text(), /Visible member/);
  const unknown = await fetch(app.url + "/~/missing-page/");
  assert.equal(unknown.status, 404);
  const crossOrigin = await fetch(app.url + "/~/", {
    redirect: "manual",
    headers: { origin: "https://elsewhere.invalid" },
  });
  assert.equal(crossOrigin.status, 403);
});

test("HTTP: explicit online frame providers preserve local API/script policy and reject malformed origins atomically", async (t) => {
  const { call } = await setup(t);
  const before = await (await call("/__sim/api/state?summary=1")).json();
  // Portal pages carry only site-setting headers unless confinement is opted in.
  assert.equal((await call("/")).headers.get("content-security-policy"), null);
  assert.equal((await call("/__sim/api/config", "PATCH", { confinePortalPages: true })).status, 200);
  assert.match(
    (await call("/")).headers.get("content-security-policy"),
    /frame-src 'self'$/,
  );
  const allowed = await call("/__sim/api/config", "PATCH", {
    externalFrameOrigins: ["https://app.powerbi.com"],
  });
  assert.equal(allowed.status, 200);
  const state = await allowed.json();
  assert.equal(state.config.mode, "local");
  assert.equal(state.config.pageMode, "local");
  assert.deepEqual(state.config.identity, before.config.identity);
  const policy = (await call("/")).headers.get("content-security-policy");
  assert.match(policy, /frame-src 'self' https:\/\/app\.powerbi\.com$/);
  assert.match(policy, /connect-src 'self';/);
  assert.match(policy, /script-src 'self' 'unsafe-inline' 'unsafe-eval';/);
  for (const value of [
    ["*"],
    ["http://app.powerbi.com"],
    ["https://app.powerbi.com/view"],
    ["https://secret@app.powerbi.com"],
    ["https://app.powerbi.com?key=secret"],
    ["https://app.powerbi.com#fragment"],
    ["https://app.powerbi.com; script-src *"],
    "https://app.powerbi.com",
    Array(21).fill("https://example.com"),
  ]) {
    const rejected = await call("/__sim/api/config", "PATCH", {
      externalFrameOrigins: value,
    });
    assert.equal(rejected.status, 400);
    assert.equal(
      (await rejected.json()).error.code,
      "EXTERNAL_FRAME_ORIGIN_INVALID",
    );
  }
  const after = await (await call("/__sim/api/state?summary=1")).json();
  assert.deepEqual(after.config.externalFrameOrigins, [
    "https://app.powerbi.com",
  ]);
  assert.equal((await call("/_api/contacts")).status, 200);
});

test("HTTP: audit correlates page Liquid and browser API calls, records denial, redacts secrets and protects clearing", async (t) => {
  const { call, app } = await setup(t);
  const page = await call("/?access_token=DO_NOT_RETAIN");
  await page.text();
  const traceId = page.headers.get("x-sim-trace-id");
  assert.match(traceId, /^[\da-f-]{36}$/);
  await (
    await call("/_api/contacts?$select=fullname", "GET", undefined, {
      "X-Sim-Parent-Trace": traceId,
    })
  ).json();
  assert.equal(
    (
      await call("/_api/contacts", "POST", {
        fullname: "WRITE_BODY_MUST_NOT_BE_LOGGED",
      })
    ).status,
    403,
  );
  const report = await (await call("/__sim/api/audit?pageSize=2")).json();
  assert.equal(report.total, 4);
  assert.equal(report.items.length, 2);
  assert.equal(report.pageCount, 2);
  assert.equal(report.summary.denied, 1);
  const all = await (await call("/__sim/api/audit/export")).json();
  const root = all.items.find((item) => item.kind === "page"),
    liquid = all.items.find((item) => item.kind === "liquid-fetchxml"),
    api = all.items.find(
      (item) => item.method === "GET" && item.kind === "api",
    );
  assert.equal(root.id, traceId);
  assert.equal(root.status, 200);
  assert.equal(liquid.parentId, root.id);
  assert.equal(liquid.correlationId, root.correlationId);
  assert.equal(liquid.entity, "contact");
  assert.equal(liquid.rowCount, 1);
  assert.match(liquid.query, /<fetch>/);
  assert.equal(api.parentId, root.id);
  assert.equal(api.correlationId, root.correlationId);
  assert.equal(api.rowCount, 1);
  assert.equal(api.identity.contactId, "person");
  assert.deepEqual(api.identity.roles, ["Reader"]);
  for (const entry of all.items) {
    assert.equal(typeof entry.durationMs, "number");
    assert.equal(entry.provider, "local");
  }
  assert.doesNotMatch(
    JSON.stringify(all),
    /DO_NOT_RETAIN|WRITE_BODY_MUST_NOT_BE_LOGGED/,
  );
  assert.equal(
    (await fetch(app.url + "/__sim/api/audit/clear", { method: "POST" }))
      .status,
    403,
  );
  assert.equal(
    (await (await call("/__sim/api/audit?outcome=denied")).json()).total,
    1,
  );
  assert.equal(
    (await (await call("/__sim/api/audit/clear", "POST")).json()).total,
    0,
  );
});

test("HTTP: summary omits database payloads and record pages preserve CRUD and search", async (t) => {
  const { call } = await setup(t);
  await call("/__sim/api/records/contact", "POST", {
    fullname: "Second member",
    description: "unique matching detail",
  });
  const summary = await (await call("/__sim/api/state?summary=1")).json();
  assert.equal(Object.hasOwn(summary, "data"), false);
  assert.equal(summary.status.tableCounts.contact, 2);
  assert.equal(summary.config.mappings[0].logicalName, "contact");
  const first = await (
    await call("/__sim/api/records/contact?page=1&pageSize=1")
  ).json();
  const second = await (
    await call("/__sim/api/records/contact?page=2&pageSize=1")
  ).json();
  assert.equal(first.total, 2);
  assert.equal(first.pageCount, 2);
  assert.equal(second.items.length, 1);
  assert.notEqual(first.items[0].contactid, second.items[0].contactid);
  const found = await (
    await call("/__sim/api/records/contact?page=99&pageSize=1&search=UNIQUE")
  ).json();
  assert.equal(found.total, 1);
  assert.equal(found.page, 1);
  assert.equal(found.items[0].fullname, "Second member");
  const full = await (await call("/__sim/api/records/contact")).json();
  assert.equal(full.value.length, 2);
});

test("HTTP: Liquid and API share identity/data; admin CRUD is protected and persists", async (t) => {
  const { app, call, dir } = await setup(t);
  let response = await call("/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<h1>Visible member<\/h1>/);
  response = await call("/_api/contacts?$select=fullname&$count=true");
  assert.equal(response.status, 200);
  // Dataverse/Power Pages rows carry their row version and primary key.
  const { value: listed, ...collection } = await response.json();
  assert.deepEqual(collection, {
    "@odata.context": `${app.url}/_api/$metadata#contacts(fullname)`,
    "@odata.count": 1,
    "@Microsoft.Dynamics.CRM.totalrecordcount": 1,
    "@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded": false,
    "@Microsoft.Dynamics.CRM.globalmetadataversion": collection["@Microsoft.Dynamics.CRM.globalmetadataversion"],
  });
  assert.equal(listed.length, 1);
  const { "@odata.etag": etag, ...columns } = listed[0];
  assert.match(etag, /^W\/"\d+"$/);
  assert.deepEqual(columns, { fullname: "Visible member", contactid: "one" });
  assert.equal(
    (await call("/_api/contacts", "POST", { fullname: "No write" })).status,
    403,
  );
  assert.equal(
    (
      await fetch(`${app.url}/__sim/api/config`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{}",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/__sim/api/config", "PATCH", {
        identity: { id: null, roles: [] },
      })
    ).status,
    200,
  );
  assert.equal((await call("/_api/contacts")).status, 403);
  response = await call("/__sim/api/records/contact", "POST", {
    fullname: "Admin-created",
  });
  assert.equal(response.status, 201);
  const row = await response.json();
  assert.equal(
    (
      await call(`/__sim/api/records/contact/${row.contactid}`, "PATCH", {
        fullname: "Updated",
      })
    ).status,
    200,
  );
  const disk = JSON.parse(
    await fs.readFile(path.join(dir, "state.json"), "utf8"),
  );
  assert.equal(
    disk.tables.contact.find((r) => r.contactid === row.contactid).fullname,
    "Updated",
  );
  assert.equal(
    (await call(`/__sim/api/records/contact/${row.contactid}`, "DELETE"))
      .status,
    204,
  );
  assert.equal((await call("/_api/contacts(missing)")).status, 404);
  assert.equal((await call("/_api/contacts(missing)/fullname")).status, 404);
});

test("HTTP: Liquid AJAX POST reads form parameters without mutating records", async (t) => {
  const { app, dir } = await setup(t);
  await fs.writeFile(
    path.join(dir, "web-templates/Main.webtemplate.source.html"),
    "{{request.method}}|{{request.params.filter}}|{{request.params.fixed}}",
  );
  await app.reload();
  const before = app.store.snapshot().tables;
  let response = await fetch(app.url + "/?fixed=query", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "filter=Helios+tablet&fixed=body",
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "POST|Helios tablet|query");
  response = await fetch(app.url + "/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filter: "Medicine", fixed: 12 }),
  });
  assert.equal(await response.text(), "POST|Medicine|12");
  assert.deepEqual(app.store.snapshot().tables, before);
  response = await fetch(app.url + "/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ filter: { nested: true } }),
  });
  assert.equal(response.status, 400);
  // A write without __RequestVerificationToken is a 401 HttpAntiForgeryException
  // (web-api-http-requests-handle-errors: 90040107).
  response = await fetch(app.url + "/_api/contacts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(response.status, 401);
  assert.equal((await response.json()).error.code, "90040107");
});

test("HTTP: origin/host isolation, prototype protection, configuration validation, no silent fallback", async (t) => {
  const { app, call } = await setup(t);
  assert.equal(
    (
      await call("/__sim/api/state", "GET", undefined, {
        Origin: "https://attacker.invalid",
      })
    ).status,
    403,
  );
  assert.equal(
    (
      await call("/__sim/api/mappings", "POST", {
        id: "__proto__",
        entitySet: "unsafe",
        idColumn: "unsafeid",
      })
    ).status,
    400,
  );
  assert.equal(
    (await call("/__sim/api/config", "PATCH", { mode: "typo" })).status,
    400,
  );
  assert.equal(
    (await call("/__sim/api/config", "PATCH", { permissionMode: "typo" }))
      .status,
    400,
  );
  assert.equal(
    (
      await call("/__sim/api/endpoints", "POST", {
        id: "bad",
        path: "/__sim/api/state",
        body: {},
      })
    ).status,
    400,
  );
  for (const invalid of [
    { mode: "liv" },
    { status: "200" },
    { method: {} },
    { path: "/%5f%5fsim/api/state" },
    { path: "/x/../data" },
  ])
    assert.equal(
      (
        await call("/__sim/api/endpoints", "POST", {
          id: "bad-config",
          path: "/custom",
          mode: "local",
          method: "GET",
          ...invalid,
        })
      ).status,
      400,
    );
  assert.equal((await call("/not-exported/")).status, 404);
  assert.equal(
    (await call("/_api/contacts?$apply=aggregate(fullname)")).status,
    400,
  );
  const status = await new Promise((resolve, reject) => {
    const req = http.get(
      app.url,
      { headers: { Host: "evil.invalid" } },
      (res) => {
        res.resume();
        resolve(res.statusCode);
      },
    );
    req.on("error", reject);
  });
  assert.equal(status, 403);
});
test("HTTP: declarative plugins enforce validation and atomic secondary side effects", async (t) => {
  const { call } = await setup(t);
  await call("/__sim/api/permissions", "POST", {
    id: "writer",
    entity: "contact",
    scope: "global",
    operations: ["create", "update", "delete"],
    roles: ["Reader"],
  });
  await call("/__sim/api/mappings", "POST", {
    logicalName: "audit",
    entitySet: "audits",
    idColumn: "auditid",
  });
  const plugin = {
    id: "validate-name",
    entity: "contact",
    operations: ["create", "update"],
    validate: [
      { field: "firstname", required: true, message: "First name required" },
    ],
    set: {
      fullname: {
        op: "concat",
        args: ["$record.firstname", " ", "$record.lastname"],
      },
    },
    secondary: [
      {
        entity: "audit",
        operation: "create",
        set: { name: "$record.fullname" },
      },
    ],
  };
  assert.equal((await call("/__sim/api/plugins", "POST", plugin)).status, 201);
  assert.equal(
    (await call("/_api/contacts", "POST", { lastname: "Rejected" })).status,
    400,
  );
  let response = await call(
    "/_api/contacts",
    "POST",
    { firstname: "Ada", lastname: "Lovelace" },
    { Prefer: "return=representation" },
  );
  assert.equal(response.status, 201);
  let row = await response.json();
  assert.equal(row.fullname, "Ada Lovelace");
  assert.equal(response.headers.get("entityid"), row.contactid);
  response = await call("/__sim/api/records/audit");
  assert.equal((await response.json()).value[0].name, "Ada Lovelace");
});
test("HTTP: explicit local endpoint wins over global live mode", async (t) => {
  let forwarded = 0;
  const liveBridge = {
    configure() {},
    status() {
      return { connected: true };
    },
    async close() {},
    async request() {
      forwarded++;
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from('{"live":true}'),
      };
    },
  };
  const { call } = await setup(t, { liveBridge });
  await call("/__sim/api/endpoints", "POST", {
    id: "local-contact",
    path: "/local-contacts",
    method: "GET",
    mode: "local",
    entity: "contacts",
  });
  await call("/__sim/api/config", "PATCH", { mode: "live" });
  let response = await call("/local-contacts");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).value[0].fullname, "Visible member");
  assert.equal(forwarded, 0);
  response = await call("/_api/contacts");
  assert.equal((await response.json()).live, true);
  assert.equal(forwarded, 1);
});
test("HTTP: an empty Liquid endpoint remains a valid empty response", async (t) => {
  const { app, call, dir } = await setup(t);
  await fs.writeFile(
    path.join(dir, "web-templates/Main.webtemplate.source.html"),
    "{% if false %}not emitted{% endif %}",
  );
  await app.reload();
  const response = await call("/");
  assert.equal(response.status, 200);
  assert.equal(await response.text(), "");
});
test("HTTP: the current Liquid user reflects contact edits and explicit role switches", async (t) => {
  const { app, call, dir } = await setup(t);
  await call("/__sim/api/records/contact/one", "PATCH", {
    emailaddress1: "local.person@example.test",
    parentcustomerid: {
      id: "company-one",
      logical_name: "account",
      name: "Local company",
    },
  });
  await call("/__sim/api/config", "PATCH", {
    identity: { id: "one", roles: ["Reader"] },
  });
  await fs.writeFile(
    path.join(dir, "web-templates/Main.webtemplate.source.html"),
    '<html><body><h1>{{user.fullname}}</h1><p>{{user.emailaddress1}}:{{user.accountId}}</p>{% if user.roles contains "Reader" %}<button>Read workspace</button>{% endif %}</body></html>',
  );
  await app.reload();
  let html = await (await call("/")).text();
  assert.match(html, /Visible member/);
  assert.match(html, /local.person@example.test:company-one/);
  assert.match(html, /<button>Read workspace<\/button>/);
  await call("/__sim/api/records/contact/one", "PATCH", {
    fullname: "Changed current contact",
  });
  html = await (await call("/")).text();
  assert.match(html, /Changed current contact/);
  await call("/__sim/api/config", "PATCH", {
    identity: { id: "one", roles: [] },
  });
  html = await (await call("/")).text();
  assert.match(html, /Changed current contact/);
  assert.doesNotMatch(html, /Read workspace/);
  assert.equal((await call("/_api/contacts")).status, 403);
});
test("HTTP: built-in presets are discoverable and apply to an older persisted state", async (t) => {
  const { call } = await setup(t);
  const state = await (await call("/__sim/api/state")).json();
  assert.ok(
    state.status.availablePresets.some(
      (preset) => preset.id === "open-sandbox" && preset.source === "builtin",
    ),
  );
  const response = await call("/__sim/api/presets/open-sandbox/apply", "POST");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).config.permissionMode, "permissive");
});
test("HTTP: forms, lists, lookups, and Liquid use the selected live data provider", async (t) => {
  const requests = [];
  const liveBridge = {
    configure() {},
    status() {
      return { connected: true };
    },
    async close() {},
    async request(path, options) {
      requests.push({ path, options });
      let value;
      if (path === "/_api/contacts(one)")
        value = {
          contactid: "one",
          fullname: "Live contact",
          _parentcustomerid_value: "live-org",
          "_parentcustomerid_value@OData.Community.Display.V1.FormattedValue":
            "Live organisation",
          "_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname":
            "account",
        };
      else
        return {
          status: 403,
          headers: { "content-type": "application/json" },
          body: Buffer.from('{"error":{"message":"No live access"}}'),
        };
      return {
        status: 200,
        headers: { "content-type": "application/json" },
        body: Buffer.from(JSON.stringify(value)),
      };
    },
    async fetchXml(xml, mapping) {
      requests.push({ xml, mapping });
      return {
        entities: [{ contactid: "one", fullname: "Live FetchXML contact" }],
      };
    },
  };
  const { app, call, dir } = await setup(t, { liveBridge });
  await call("/__sim/api/mappings/contact", "PATCH", {
    relationships: {
      parentcustomerid: {
        entity: "account",
        from: "parentcustomerid",
        to: "accountid",
        many: false,
      },
    },
  });
  await call("/__sim/api/mappings", "POST", {
    logicalName: "account",
    entitySet: "accounts",
    idColumn: "accountid",
    nameColumn: "name",
  });
  await call("/__sim/api/config", "PATCH", {
    mode: "live",
    componentSchemas: {
      "Contact edit": {
        entity: "contact",
        mode: 100000001,
        fields: [
          { name: "fullname" },
          { name: "parentcustomerid", type: "lookup" },
        ],
      },
      Contacts: { entity: "contact", fields: [{ name: "fullname" }] },
    },
  });
  // Native lists are source records; an authored {% entitylist %} only exposes
  // the list and {% entityview %} reads the rows of its default view.
  await fs.mkdir(path.join(dir, "lists"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "lists/Contacts.list.yml"),
    "adx_entitylistid: contacts-list\nadx_name: Contacts\nadx_entityname: contact\n",
  );
  await fs.writeFile(
    path.join(dir, "web-templates/Main.webtemplate.source.html"),
    `<!doctype html><html><body><h1>{{ entities.contact['one'].fullname }}</h1>{% fetchxml rows %}<fetch><entity name="contact"><attribute name="fullname"/></entity></fetch>{% endfetchxml %}<p>{{rows.results.entities[0].fullname}}</p>{% entityform name: "Contact edit" %}{% entitylist name: "Contacts" %}{% entityview %}<table>{% for row in entityview.records %}<tr><td>{{ row.fullname }}</td></tr>{% endfor %}</table>{% endentityview %}{% endentitylist %}</body></html>`,
  );
  await app.reload();
  let response = await call("/?id=one");
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<h1>Live contact<\/h1>/);
  assert.match(html, /Live FetchXML contact/);
  assert.match(html, /value="Live contact"/);
  assert.match(html, /value="Live organisation"/);
  assert.match(html, /<td>Live FetchXML contact<\/td>/);
  assert.doesNotMatch(html, /Visible member/);
  assert.ok(requests.some((r) => r.path === "/_api/contacts(one)"));
  // The {% fetchxml %} tag and the {% entityview %} both read through the live provider.
  assert.equal(
    requests.filter((r) => r.mapping?.entitySet === "contacts").length,
    2,
  );
  // Without a write grant the native Edit form is read-only: the lookup shows the
  // live record's formatted value and never queries the target table.
  assert.ok(!requests.some((r) => r.path?.startsWith("/_api/accounts")));
  assert.ok(!requests.some((r) => r.mapping?.entitySet === "accounts"));
  assert.doesNotMatch(html, /parentcustomerid_lookupmodal/);
  assert.ok(
    requests
      .filter((r) => r.path)
      .every((r) => r.options.prefer === 'odata.include-annotations="*"'),
  );
  assert.equal(
    app.store.snapshot().tables.contact[0].fullname,
    "Visible member",
  );
  response = await call("/?id=denied");
  assert.equal(response.status, 403);
  assert.match(await response.text(), /Live data read returned HTTP 403/);
});

test("HTTP: explicit live page endpoints preserve request bytes, content type, and Prefer", async (t) => {
  const requests = [];
  const liveBridge = {
    configure() {},
    status() {
      return { connected: true };
    },
    async close() {},
    async request(path, options) {
      requests.push({ path, options });
      return {
        status: 201,
        headers: { "content-type": "text/plain" },
        body: Buffer.from("accepted"),
      };
    },
  };
  const { app, call, state } = await setup(t, { liveBridge, allowLiveWrites: true });
  await call("/__sim/api/endpoints", "POST", {
    id: "form",
    path: "/form",
    method: "POST",
    mode: "live",
  });
  const body = "title=R%26D&__RequestVerificationToken=local";
  let response = await fetch(app.url + "/form", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      __RequestVerificationToken: state.csrf,
      prefer: "return=representation",
    },
    body,
  });
  assert.equal(response.status, 201);
  assert.equal(await response.text(), "accepted");
  assert.equal(requests[0].options.body.toString(), body);
  assert.equal(
    requests[0].options.contentType,
    "application/x-www-form-urlencoded",
  );
  assert.equal(requests[0].options.prefer, "return=representation");
  response = await fetch(app.url + "/form", {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: Buffer.alloc(8 * 1024 * 1024 + 1),
  });
  assert.equal(response.status, 413);
  assert.equal(requests.length, 1);
});
test("HTTP: explicit stylesheet observation preserves profile on partial failure and yields immediately to local edits", async (t) => {
  const requests = [];
  const liveBridge = {
    origin: "https://portal.example",
    context: {},
    configure() {},
    status() {
      return { connected: true };
    },
    async close() {},
    async request(url, options) {
      requests.push({ url, method: options.method });
      return {
        status: 200,
        headers: { "content-type": "text/css; charset=utf-8" },
        body: Buffer.from("body{color:#666}"),
      };
    },
  };
  const { app, call, dir } = await setup(t, { liveBridge });
  await fs.mkdir(path.join(dir, "web-files"), { recursive: true });
  await fs.writeFile(
    path.join(dir, "web-files/theme.webfile.yml"),
    "adx_webfileid: theme\nadx_name: theme.css\nadx_partialurl: theme.css\nadx_parentpageid: home\nfilename: theme.css\nmimetype: text/css",
  );
  const file = path.join(dir, "web-files/theme.css");
  await fs.writeFile(file, "body{color:navy}");
  await app.reload();
  assert.equal(
    (
      await fetch(app.url + "/__sim/api/assets/capture-stylesheets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ paths: ["/theme.css"] }),
      })
    ).status,
    403,
  );
  assert.equal(requests.length, 0);
  const captured = await call("/__sim/api/assets/capture-stylesheets", "POST", {
    paths: ["/theme.css"],
  });
  assert.equal(captured.status, 200);
  assert.equal((await captured.json()).applied, true);
  const observed = await call("/theme.css");
  assert.equal(observed.headers.get("content-type"), "text/css; charset=utf-8");
  assert.equal(
    observed.headers.get("x-sim-resource-provider"),
    "observed-stylesheet",
  );
  assert.equal(await observed.text(), "body{color:#666}");
  const profile = app.store.snapshot().simulator.shellProfile;
  const failed = await call("/__sim/api/assets/capture-stylesheets", "POST", {
    paths: ["/theme.css", "/unmapped.css"],
  });
  assert.equal(failed.status, 409);
  assert.equal((await failed.json()).applied, false);
  assert.deepEqual(app.store.snapshot().simulator.shellProfile, profile);
  await fs.writeFile(file, "body{color:green}");
  const edited = await call("/theme.css");
  assert.equal(await edited.text(), "body{color:green}");
  assert.equal(edited.headers.get("x-sim-resource-provider"), null);
  assert.ok(
    requests.every(
      (request) => request.method === "GET" && request.url === "/theme.css",
    ),
  );
});

test("HTTP: explicit snippet composition keeps source gates, preserves profiles on failure and yields to source edits", async (t) => {
  const requests = [];
  let broken = false;
  const parent = '<div class="empty"><p>Use filters</p></div>';
  const child =
    '<button id="create" style="display:none;" title="Create">Create</button>';
  const liveBridge = {
    origin: "https://portal.example",
    context: {},
    configure() {},
    status() {
      return { connected: true };
    },
    async close() {},
    async request(url, options) {
      requests.push({ url, method: options.method });
      return {
        status: 200,
        headers: { "content-type": "text/html" },
        body: `<html><body><div class="empty"><p>${broken ? "Unexpected private content" : "Use filters"}</p>${child.replace(' style="display:none;"', "")}</div></body></html>`,
      };
    },
  };
  const { app, call, dir } = await setup(t, { liveBridge });
  const snippets = path.join(dir, "content-snippets");
  await fs.mkdir(snippets);
  for (const [name, value] of [
    ["Parent", parent],
    ["Child", child],
  ]) {
    await fs.writeFile(
      path.join(snippets, `${name}.contentsnippet.yml`),
      `adx_contentsnippetid: ${name}\nadx_name: ${name}`,
    );
    await fs.writeFile(
      path.join(snippets, `${name}.contentsnippet.value.html`),
      value,
    );
  }
  await fs.writeFile(
    path.join(dir, "web-templates/Main.webtemplate.source.html"),
    "<!doctype html><html><body>{{snippets['Parent']}}</body></html>",
  );
  await app.reload();
  const route = "/__sim/api/assets/capture-snippet-composition";
  const body = { path: "/", parentName: "Parent", childName: "Child" };
  assert.equal(
    (
      await fetch(app.url + route, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    ).status,
    403,
  );
  assert.equal(requests.length, 0);
  const captured = await call(route, "POST", body);
  assert.equal(captured.status, 200);
  assert.equal((await captured.json()).applied, true);
  const profile = app.store.snapshot().simulator.shellProfile;
  assert.doesNotMatch(
    JSON.stringify(profile),
    /<button|<div|Unexpected private content/,
  );
  assert.match(
    await (await call("/")).text(),
    /id="create" style="display:none;"/,
  );
  broken = true;
  assert.equal((await call(route, "POST", body)).status, 422);
  assert.deepEqual(app.store.snapshot().simulator.shellProfile, profile);
  await fs.writeFile(
    path.join(snippets, "Child.contentsnippet.value.html"),
    child.replace("Create</button>", "Edited</button>"),
  );
  await app.reload();
  assert.doesNotMatch(await (await call("/")).text(), /id="create"/);
  assert.ok(
    requests.every(
      (request) => request.url === "/" && request.method === "GET",
    ),
  );
});

test("HTTP: shell capture persists a complete profile and preserves it on capture failure", async (t) => {
  const requests = [];
  let broken = false;
  const liveBridge = {
    origin: "https://portal.example",
    context: {},
    configure() {},
    status() {
      return { connected: true };
    },
    async close() {},
    async request(path, options) {
      requests.push({ path, options });
      if (path === "/workspace/")
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: Buffer.from(
            `<html><head><link rel="stylesheet" media="screen" href="/platform.css"><script src="/jquery.min.js"></script>${broken ? '<link rel="stylesheet" href="/missing.css">' : ""}</head><body><script>const privatePageValue="not persisted";</script></body></html>`,
          ),
        };
      if (path === "/platform.css")
        return {
          status: 200,
          headers: { "content-type": "text/css" },
          body: Buffer.from("body{color:navy}"),
        };
      if (path === "/jquery.min.js")
        return {
          status: 200,
          headers: { "content-type": "application/javascript" },
          body: Buffer.from("window.jQuery = {};"),
        };
      return {
        status: 404,
        headers: { "content-type": "text/html" },
        body: Buffer.from("missing"),
      };
    },
  };
  const { app, call, dir } = await setup(t, { liveBridge });
  let response = await call("/__sim/api/assets/capture-shell", "POST", {
    path: "/workspace/",
  });
  assert.equal(response.status, 200);
  const report = await response.json();
  assert.equal(report.complete, true);
  assert.equal(report.captured.length, 2);
  assert.deepEqual(report.shellProfile, {
    stylesheets: [{ href: "/platform.css", media: "screen" }],
    headScripts: ["/jquery.min.js"],
    bodyScripts: [],
    beforeContentScripts: [],
    afterFooterScripts: [],
  });
  assert.deepEqual(
    app.store.snapshot().simulator.shellProfile,
    report.shellProfile,
  );
  assert.ok(
    requests.every((r) => !r.options?.method || r.options.method === "GET"),
  );
  const saved = await fs.readFile(path.join(dir, "state.json"), "utf8");
  assert.doesNotMatch(saved, /privatePageValue|not persisted/);
  broken = true;
  response = await call("/__sim/api/assets/capture-shell", "POST", {
    path: "/workspace/",
  });
  assert.equal(response.status, 409);
  assert.ok(
    (await response.json()).failures.some((f) => f.path === "/missing.css"),
  );
  assert.deepEqual(
    app.store.snapshot().simulator.shellProfile,
    report.shellProfile,
  );
  response = await call("/__sim/api/assets/capture-shell", "POST", {
    path: "https://other.example/",
  });
  assert.equal(response.status, 400);
});

test("HTTP: shutdown requires CSRF, acknowledges before callback and closes idempotently", async (t) => {
  let fixture;
  let finishShutdown;
  const shutdownDone = new Promise((resolve) => { finishShutdown = resolve; });
  let shutdownCalls = 0;
  fixture = await setup(t, {
    onShutdown: async () => {
      shutdownCalls++;
      await fixture.app.close();
      finishShutdown();
    },
  });
  const state = await (await fetch(fixture.app.url + "/_sim/api/state?summary=1")).json();
  const unauthorized = await fetch(fixture.app.url + "/_sim/api/shutdown", { method: "POST" });
  assert.equal(unauthorized.status, 403);
  const accepted = await fetch(fixture.app.url + "/_sim/api/shutdown", {
    method: "POST",
    headers: { "x-sim-csrf": state.csrf },
  });
  assert.equal(accepted.status, 202);
  assert.deepEqual(await accepted.json(), { accepted: true, message: "Mirage shutdown accepted." });
  await Promise.race([shutdownDone, new Promise((_, reject) => setTimeout(() => reject(new Error("shutdown callback timed out")), 2000))]);
  assert.equal(shutdownCalls, 1);
  await fixture.app.close();
});
