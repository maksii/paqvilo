import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";
import { DataStore } from "../lib/data.mjs";
import { webApiPolicy, webApiFetchPolicy } from "../lib/webapi-policy.mjs";

// HTTP errors carry the documented Power Pages code in the body
// (web-api-http-requests-handle-errors); the simulator's own classification
// travels in the X-Sim-Error-Code header.
const apiError = async (response) => ({
  code: (await response.json()).error.code,
  sim: response.headers.get("x-sim-error-code"),
});

const fixture = () => ({
  version: 1,
  mappings: {
    contact: {
      entitySet: "contacts",
      idColumn: "contactid",
      relationships: {
        company: {
          entity: "account",
          from: "companyid",
          to: "accountid",
          many: false,
        },
      },
    },
    account: { entitySet: "accounts", idColumn: "accountid" },
  },
  tables: {
    contact: [
      {
        contactid: "person",
        fullname: "Visible",
        secret: "Hidden",
        companyid: "company",
      },
    ],
    account: [
      {
        accountid: "company",
        name: "Permitted company",
        secret: "Company secret",
      },
    ],
  },
  settings: { permissionMode: "permissive" },
  simulator: {
    mode: "local",
    pageMode: "local",
    // Requests use the configured persona; session mechanics aren't under test here.
    identityScope: "configured",
    identity: { id: "person", roles: [] },
    live: {},
    endpoints: [],
  },
});
const settings = {
  "Webapi/contact/enabled": "true",
  "Webapi/contact/fields": "fullname,company,companyid",
  "Webapi/account/enabled": "true",
  "Webapi/account/fields": "name",
};

test("Wildcard public API cannot read/query/write private simulator snapshot fields or mapped aliases", () => {
  const state=fixture();
  state.mappings.contact.relationships.privateSnapshot={entity:"account",from:"__simArtifact",to:"accountid",many:false};
  const store=new DataStore({state});
  const portal={settings:{...settings,"Webapi/contact/fields":"*","Webapi/account/fields":"*"},observed:{webApiWildcard:"exempt",evidence:"synthetic fixture with wildcard field lists"}};
  const policy=webApiPolicy(portal,store,"contact");
  const deniedPrivate=error=>error.code==="WebApiPrivateField";
  for(const operation of ["create","update"]){
    assert.throws(()=>policy.prepareWrite({__simArtifact:{checksums:{pdf:"rewritten"}}},operation),deniedPrivate);
    assert.throws(()=>policy.assertWrite({__SIMArtifact:{}},operation),deniedPrivate);
    assert.throws(()=>policy.assertWrite({"privateSnapshot@odata.bind":"/accounts(company)"},operation),deniedPrivate);
    policy.assertWrite({fullname:"Legitimate authored field"},operation);
  }
  for(const query of [{$select:"__simArtifact"},{$filter:"__simArtifact eq null"},{$orderby:"__simArtifact"},{$expand:"privateSnapshot"}])
    assert.throws(()=>policy.assertQuery(new URLSearchParams(query)),deniedPrivate);
  assert.throws(()=>webApiFetchPolicy(portal,store,'<fetch><entity name="contact"><attribute name="__simArtifact"/></entity></fetch>',"contact"),deniedPrivate);
  assert.deepEqual(policy.project({contactid:"person",fullname:"Visible",__simArtifact:{snapshot:{private:true}},__SIMHidden:"hidden"}),{contactid:"person",fullname:"Visible"});
  assert.equal(policy.allowed("__simArtifact"),false);
});

test("Web API settings are failclosed and system-view columns require exact imported metadata", () => {
  const store = new DataStore({ state: fixture() });
  assert.throws(
    () => webApiPolicy({ settings: {} }, store, "contact"),
    (error) => error.code === "WebApiTableNotEnabled" && error.status === 404,
  );
  assert.throws(
    () =>
      webApiPolicy(
        { settings: { "Webapi/contact/enabled": "true" } },
        store,
        "contact",
      ).assertQuery(new URLSearchParams({ $select: "fullname" })),
    (error) => error.code === "WebApiFieldNotEnabled" && error.details.attribute === "fullname",
  );
  const portal = {
    settings: {
      "Webapi/contact/enabled": "true",
      "Webapi/contact/UseFieldsFromView": "true",
    },
  };
  assert.throws(
    () => webApiPolicy(portal, store, "contact"),
    (error) => error.code === "WebApiColumnsViewUnresolved",
  );
  portal.webApiViews = [
    {
      entity: "contact",
      name: "Power Pages Web API Columns",
      fields: [{ name: "fullname" }, { name: "company.secret" }],
    },
  ];
  const policy = webApiPolicy(portal, store, "contact");
  assert.deepEqual(
    policy.project({
      contactid: "person",
      fullname: "Visible",
      secret: "Hidden",
    }),
    { contactid: "person", fullname: "Visible" },
  );
  assert.throws(
    () => policy.assertWrite({ contactid: "changed" }),
    (error) => error.code === "WebApiFieldNotEnabled",
  );
  const literals = webApiPolicy(
    {
      settings: {
        ...settings,
        "Webapi/contact/fields": "fullname,companyid,createdon,amount",
      },
    },
    store,
    "contact",
  );
  literals.assertQuery(
    new URLSearchParams({
      $filter:
        "companyid eq abcdefab-cdef-abcd-abcd-abcdefabcdef and createdon ge 2026-10-07T12:20:30.123Z and amount gt 1.23e-10 and fullname eq 'O''Brien'",
    }),
  );
  assert.throws(
    () =>
      literals.assertQuery(
        new URLSearchParams({
          $filter: "secret eq abcdefab-cdef-abcd-abcd-abcdefabcdef",
        }),
      ),
    (error) => error.code === "WebApiFieldNotEnabled",
  );
});

test("complete local mapping distinguishes invalid columns from known but disabled columns", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-webapi-schema-complete-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(path.join(directory, "website.yml"), "adx_name: Complete schema\nadx_websiteid: site");
  await fs.writeFile(path.join(directory, "settings.sitesetting.yml"), [
    "- adx_name: Webapi/contact/enabled",
    "  adx_value: true",
    "- adx_name: Webapi/contact/fields",
    "  adx_value: fullname",
  ].join("\n"));
  const initial = fixture();
  initial.mappings.contact.schemaComplete = true;
  initial.mappings.contact.fields = {
    contactid: { type: "text" },
    fullname: { type: "text" },
    secret: { type: "text" },
  };
  const app = await createSimulator({ sourceDir: directory, initial, watch: false });
  t.after(() => app.close());
  const request = (query) => fetch(`${app.url}/_api/contacts?${query}`);
  let response = await request("$select=unknowncolumn");
  assert.equal(response.status, 400);
  assert.deepEqual(await apiError(response), { code: "9004010A", sim: "InvalidAttribute" });
  response = await request("$select=secret");
  assert.equal(response.status, 403);
  assert.deepEqual(await apiError(response), { code: "90040101", sim: "WebApiFieldNotEnabled" });
  response = await request("$select=fullname");
  assert.equal(response.status, 200);
});

test("exported column permission profiles restrict read/create/update by exact memberships independently of row grants", () => {
  const store = new DataStore({ state: fixture() }),
    portal = {
      settings,
      webApiIdentity: { roleSource: "memberships", roleIds: ["reader"] },
      records: [
        {
          id: "profile",
          kind: "columnpermissionprofile",
          adx_tablename: "contact",
          adx_columnpermissionprofile_webrole: ["reader"],
          adx_allcolumnpermissions: [746610001],
        },
        {
          id: "created",
          kind: "columnpermission",
          adx_columnpermissionprofileid: "profile",
          adx_columnname: "companyid",
          adx_permissions: [746610000],
        },
        {
          id: "fullname",
          kind: "columnpermission",
          adx_columnpermissionprofileid: "profile",
          adx_columnname: "fullname",
          adx_permissions: [746610001, 746610002],
        },
      ],
    };
  const policy = webApiPolicy(portal, store, "contact");
  assert.deepEqual(
    policy.project({
      contactid: "person",
      fullname: "Visible",
      companyid: "company",
    }),
    { contactid: "person", fullname: "Visible" },
  );
  policy.assertWrite({ fullname: "Updated" }, "update");
  policy.assertWrite({ companyid: "company" }, "create");
  policy.assertWrite({ "company@odata.bind": "/accounts(company)" }, "create");
  assert.throws(
    () =>
      policy.assertWrite(
        { "company@odata.bind": "/accounts(company)" },
        "update",
      ),
    (error) => error.code === "WebApiColumnPermissionDenied",
  );
  assert.throws(
    () => policy.assertWrite({ companyid: "company" }, "update"),
    (error) => error.code === "WebApiColumnPermissionDenied",
  );
  assert.throws(
    () => policy.assertWrite({ fullname: "Created" }, "create"),
    (error) => error.code === "WebApiColumnPermissionDenied",
  );
  assert.throws(
    () => policy.assertQuery(new URLSearchParams("$select=_companyid_value")),
    (error) => error.code === "WebApiFieldNotEnabled",
  );
  portal.webApiIdentity = {
    roleSource: "memberships",
    roleIds: ["different"],
    roles: ["reader"],
  };
  assert.equal(
    webApiPolicy(portal, store, "contact").project({ companyid: "company" })
      .companyid,
    "company",
  );
});

test("FetchXML may traverse source-mapped internal intersections without publishing an intersect Web API", () => {
  const state = fixture();
  state.mappings.contact.relationships.tags = {
    entity: "account",
    from: "contactid",
    to: "accountid",
    many: true,
    intersect: {
      entity: "contact_account",
      from: "contactid",
      to: "accountid",
    },
  };
  state.mappings.contact_account = {
    entitySet: "contact_accounts",
    idColumn: "contact_accountid",
  };
  state.tables.contact_account = [];
  const store = new DataStore({ state }),
    portal = { settings };
  const xml =
    '<fetch><entity name="contact"><attribute name="fullname"/><link-entity name="contact_account" from="contactid" to="contactid"><link-entity name="account" from="accountid" to="accountid"><attribute name="name"/></link-entity></link-entity></entity></fetch>';
  const project = webApiFetchPolicy(portal, store, xml, "contact");
  assert.deepEqual(
    project({
      fullname: "Visible",
      "account2.name": "Permitted company",
      "contact_account1.accountid": "Internal",
    }),
    { fullname: "Visible", "account2.name": "Permitted company" },
  );
  assert.throws(
    () => webApiPolicy(portal, store, "contact_account"),
    (error) => error.code === "WebApiTableNotEnabled",
  );
  assert.throws(
    () =>
      webApiFetchPolicy(
        portal,
        store,
        xml.replace(
          '<link-entity name="account"',
          '<attribute name="accountid"/><link-entity name="account"',
        ),
        "contact",
      ),
    (error) => error.code === "WebApiTableNotEnabled",
  );
  assert.throws(
    () =>
      webApiFetchPolicy(
        portal,
        store,
        xml.replace(
          'name="contact_account" from="contactid"',
          'name="contact_account" from="secret"',
        ),
        "contact",
      ),
    (error) => error.code === "WebApiTableNotEnabled",
  );
  assert.throws(
    () =>
      webApiFetchPolicy(
        portal,
        store,
        xml.replace(
          'name="contact_account" from="contactid" to="contactid"',
          'name="contact_account" from="accountid" to="companyid"',
        ),
        "contact",
      ),
    (error) => error.code === "WebApiTableNotEnabled",
  );
});

test("plain field lists expose only metadata-proven lookup aliases and empty profiles inherit only unspecified enabled columns", () => {
  const store = new DataStore({ state: fixture() }),
    portal = {
      settings: { ...settings, "Webapi/contact/fields": "fullname,companyid" },
      webApiEntities: {
        contact: { fields: { companyid: { dataverseType: "lookup" } } },
      },
    };
  const policy = webApiPolicy(portal, store, "contact");
  policy.assertQuery(
    new URLSearchParams({
      $select: "_companyid_value",
      $filter: "_companyid_value eq abcdefab-cdef-abcd-abcd-abcdefabcdef",
    }),
  );
  policy.assertWrite({ "company@odata.bind": "/accounts(company)" });
  // A navigation the table doesn't have is an invalid attribute (400,
  // Power Pages 90040100), not a disallowed one (403).
  assert.throws(
    () =>
      policy.assertWrite({
        "unmappedcompany@odata.bind": "/accounts(company)",
      }),
    (error) => error.code === "InvalidAttribute" && error.status === 400,
  );
  assert.deepEqual(
    policy.project({
      contactid: "person",
      _companyid_value: "company",
      _secret_value: "hidden",
    }),
    { contactid: "person", _companyid_value: "company" },
  );
  assert.throws(
    () =>
      policy.assertQuery(new URLSearchParams({ $select: "_fullname_value" })),
    (error) => error.code === "WebApiFieldNotEnabled",
  );
  assert.throws(
    () => policy.assertWrite({ _companyid_value: "company" }),
    (error) => error.code === "WebApiFieldNotEnabled",
  );
  portal.webApiIdentity = { roleSource: "memberships", roleIds: ["reader"] };
  portal.records = [
    {
      id: "profile",
      adx_tablename: "contact",
      adx_columnpermissionprofile_webrole: ["reader"],
    },
    {
      id: "allowed",
      adx_columnpermissionprofileid: "profile",
      adx_columnname: "companyid",
      adx_permissions: [746610001],
    },
  ];
  const restricted = webApiPolicy(portal, store, "contact");
  restricted.assert("_companyid_value");
  restricted.assert("fullname");
  restricted.assertWrite({ fullname: "changed" });
  assert.throws(
    () =>
      restricted.assertWrite({ "company@odata.bind": "/accounts(company)" }),
    (error) => error.code === "WebApiColumnPermissionDenied",
  );
  assert.deepEqual(
    restricted.project({
      contactid: "person",
      fullname: "visible",
      _companyid_value: "company",
      secret: "hidden",
    }),
    { contactid: "person", fullname: "visible", _companyid_value: "company" },
  );
  for (const empty of [null, [], ""]) {
    portal.records[0].adx_allcolumnpermissions = empty;
    const inherited = webApiPolicy(portal, store, "contact");
    inherited.assert("fullname");
    inherited.assertWrite({ fullname: "created" }, "create");
    assert.throws(
      () => inherited.assertWrite({ companyid: "company" }),
      (error) => error.code === "WebApiColumnPermissionDenied",
    );
  }
  portal.records[0].adx_allcolumnpermissions = [746610001];
  assert.throws(
    () =>
      webApiPolicy(portal, store, "contact").assertWrite(
        { fullname: "created" },
        "create",
      ),
    (error) => error.code === "WebApiColumnPermissionDenied",
  );
});

test("FetchXML resolves forward-declared link aliases without skipping their column policy", () => {
  const store = new DataStore({ state: fixture() }),
    portal = { settings };
  const xml =
    '<fetch><entity name="contact"><attribute name="fullname"/><filter><condition entityname="employer" attribute="name" operator="eq" value="Permitted company"/></filter><link-entity name="account" alias="employer" from="accountid" to="companyid"><attribute name="name"/></link-entity></entity></fetch>';
  const project = webApiFetchPolicy(portal, store, xml, "contact");
  assert.deepEqual(
    project({ fullname: "Visible", "employer.name": "Permitted company" }),
    { fullname: "Visible", "employer.name": "Permitted company" },
  );
  assert.throws(
    () =>
      webApiFetchPolicy(
        portal,
        store,
        xml.replace(
          'entityname="employer" attribute="name"',
          'entityname="employer" attribute="secret"',
        ),
        "contact",
      ),
    (error) => error.code === "WebApiFieldNotEnabled",
  );
  assert.throws(
    () =>
      webApiFetchPolicy(
        portal,
        store,
        xml.replace('entityname="employer"', 'entityname="missing"'),
        "contact",
      ),
    // Dataverse QueryBuilderAlias_Does_Not_Exist (0x8004110a): malformed, not denied.
    (error) => error.code === "InvalidFetchXml" && error.status === 400 && error.details.innerCode === "0x8004110a",
  );
  const collidingAttribute = xml
    .replace(
      '<attribute name="fullname"/>',
      '<attribute name="fullname" alias="employer"/>',
    )
    .replace(
      'entityname="employer" attribute="name"',
      'entityname="employer" attribute="secret"',
    );
  assert.throws(
    () => webApiFetchPolicy(portal, store, collidingAttribute, "contact"),
    (error) => error.code === "WebApiFieldNotEnabled",
  );
  assert.throws(
    () =>
      webApiFetchPolicy(
        portal,
        store,
        xml.replace(
          "</entity>",
          '<link-entity name="account" alias="employer" from="accountid" to="companyid"/></entity>',
        ),
        "contact",
      ),
    // Dataverse QueryBuilderDuplicateAlias: a malformed query, not a column denial.
    (error) => error.code === "InvalidFetchXml" && error.status === 400 && /not a unique alias/.test(error.message),
  );
});

test("HTTP optional profile default inherits table grants while explicit sensitive columns and denied updates remain restricted", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pp-profile-default-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, "Home.webpage.yml"),
    "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n",
  );
  await fs.writeFile(
    path.join(directory, "sitesetting.yml"),
    "- adx_name: Webapi/contact/enabled\n  adx_value: true\n- adx_name: Webapi/contact/fields\n  adx_value: fullname,secret\n",
  );
  await fs.writeFile(
    path.join(directory, "Role.webrole.yml"),
    "adx_webroleid: reader\nadx_name: Reader\n",
  );
  await fs.writeFile(
    path.join(directory, "Profile.columnpermissionprofile.yml"),
    "adx_columnpermissionprofileid: profile\nadx_tablename: contact\nadx_columnpermissionprofile_webrole:\n- reader\n",
  );
  await fs.writeFile(
    path.join(directory, "Sensitive.columnpermission.yml"),
    "adx_columnpermissionid: sensitive\nadx_columnpermissionprofileid: profile\nadx_columnname: secret\nadx_permissions:\n- 746610000\n",
  );
  const initial = fixture();
  initial.settings = { permissionMode: "enforce" };
  initial.simulator.identity = { id: "person", roles: ["Reader"] };
  initial.permissions = [
    {
      id: "contacts",
      entity: "contact",
      roles: ["Reader"],
      scope: "global",
      operations: ["read", "create"],
    },
  ];
  const app = await createSimulator({
    sourceDir: directory,
    initial,
    watch: false,
  });
  t.after(() => app.close());
  const request = (route, method = "GET", body) =>
    fetch(app.url + route, {
      method,
      headers: {
        "content-type": "application/json",
        __RequestVerificationToken: app.state().csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let response = await request("/_api/contacts(person)?$select=fullname");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).fullname, "Visible");
  response = await request("/_api/contacts");
  assert.equal(response.status, 403);
  // Property-name order puts the lookup _companyid_value first.
  assert.deepEqual((await response.json()).error, { code: "90040101", message: "Attribute _companyid_value in table contact is not enabled for Web Api." });
  response = await request("/_api/contacts?$select=contactid,fullname");
  assert.equal(response.status, 200);
  assert.equal((await response.json()).value[0].secret, undefined);
  response = await request("/_api/contacts(person)?$select=secret");
  assert.equal(response.status, 403);
  response = await request("/_api/contacts", "POST", {
    fullname: "Default-inherited create",
    secret: "Explicit create permitted",
  });
  assert.equal(response.status, 204);
  assert.ok(
    app.store
      .snapshot()
      .tables.contact.some(
        (row) => row.fullname === "Default-inherited create",
      ),
  );
  response = await request("/_api/contacts(person)", "PATCH", {
    fullname: "Denied table update",
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await apiError(response), { code: "90040102", sim: "PermissionDenied" });
  response = await request("/_api/contacts(person)", "PATCH", {
    secret: "Denied column update",
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await apiError(response), {
    code: "90040101",
    sim: "WebApiColumnPermissionDenied",
  });
  assert.equal(
    app.store
      .snapshot()
      .tables.contact.find((row) => row.contactid === "person").fullname,
    "Visible",
  );
});

test("native lookup bindings do not publish target endpoints and enforce source append, target appendTo and source column writes", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pp-webapi-bind-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, "Home.webpage.yml"),
    "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n",
  );
  await fs.writeFile(
    path.join(directory, "sitesetting.yml"),
    "- adx_name: Webapi/contact/enabled\n  adx_value: true\n- adx_name: Webapi/contact/fields\n  adx_value: fullname,company,accounts\n",
  );
  await fs.writeFile(
    path.join(directory, "Role.webrole.yml"),
    "adx_webroleid: reader\nadx_name: Reader\n",
  );
  await fs.writeFile(
    path.join(directory, "Profile.columnpermissionprofile.yml"),
    "adx_columnpermissionprofileid: profile\nadx_tablename: contact\nadx_columnpermissionprofile_webrole:\n- reader\nadx_allcolumnpermissions:\n- 746610000\n- 746610001\n- 746610002\n",
  );
  const initial = fixture();
  initial.settings = {
    permissionMode: "enforce",
    associationPermissions: "enforce",
  };
  initial.simulator.identity = { id: "person", roles: ["Reader"] };
  initial.mappings.contact.relationships.accounts = {
    entity: "account",
    from: "contactid",
    to: "ownerid",
    many: true,
  };
  initial.permissions = [
    {
      id: "source",
      entity: "contact",
      scope: "global",
      roles: ["Reader"],
      operations: ["read", "create", "update", "append"],
    },
    {
      id: "target",
      entity: "account",
      scope: "global",
      roles: ["Reader"],
      operations: ["read", "update", "appendTo"],
    },
  ];
  const app = await createSimulator({
    sourceDir: directory,
    initial,
    watch: false,
  });
  t.after(() => app.close());
  const call = (route, method = "GET", body) =>
    fetch(app.url + route, {
      method,
      headers: {
        __RequestVerificationToken: app.state().csrf,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal((await call("/_api/accounts")).status, 404);
  assert.equal((await call("/_api/accounts", "HEAD")).status, 404);
  let response = await call("/_api/contacts", "POST", {
    fullname: "Native bound row",
    "company@odata.bind": "/accounts(company)",
  });
  assert.equal(response.status, 204);
  assert.equal(
    app.store
      .snapshot()
      .tables.contact.find((row) => row.fullname === "Native bound row")
      .companyid.id,
    "company",
  );
  response = await call("/_api/contacts", "POST", {
    fullname: "Deep insert requires a public target API",
    company: { name: "New account" },
  });
  assert.equal(response.status, 404);
  assert.deepEqual(await apiError(response), { code: "9004010C", sim: "WebApiTableNotEnabled" });
  const targetGrant = app.store
    .snapshot()
    .permissions.find((rule) => rule.id === "target");
  // Binding needs Append on the source and AppendTo on the target, not read
  // on the target record (90040105/90040106). ExampleApp grants global AppendTo-only
  // contact permissions so co-authors from other organisations can be bound.
  for (const [operations, expected] of [
    [["appendTo"], null],
    [["read"], { code: "90040106", sim: "PermissionDenied" }],
  ]) {
    const state = app.store.snapshot();
    state.permissions.find((rule) => rule.id === "target").operations =
      operations;
    await app.store.replaceState(state);
    const fullname = `Binding with ${operations.join(",")}`;
    response = await call("/_api/contacts", "POST", {
      fullname,
      "company@odata.bind": "/accounts(company)",
    });
    assert.equal(response.status, expected ? 403 : 204, fullname);
    if (expected) assert.deepEqual(await apiError(response), expected);
    assert.equal(
      app.store
        .snapshot()
        .tables.contact.some((row) => row.fullname === fullname),
      !expected,
    );
  }
  const state = app.store.snapshot();
  state.permissions.find((rule) => rule.id === "target").operations =
    targetGrant.operations;
  await app.store.replaceState(state);
  response = await call("/_api/contacts(person)/accounts/$ref", "POST", {
    "@odata.id": app.url + "/_api/accounts(company)",
  });
  assert.equal(response.status, 204);
  await fs.writeFile(
    path.join(directory, "Column.columnpermission.yml"),
    "adx_columnpermissionid: no-update\nadx_columnpermissionprofileid: profile\nadx_columnname: contactid\nadx_permissions:\n- 746610001\n",
  );
  await app.reload();
  response = await call("/_api/contacts(person)/accounts/$ref", "DELETE", {
    "@odata.id": app.url + "/_api/accounts(company)",
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await apiError(response), {
    code: "90040101",
    sim: "WebApiColumnPermissionDenied",
  });
});

test("HTTP Web API field gates cover projection, selects, filters, expands, FetchXML joins and all writes; Liquid remains table-scoped", async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "pp-webapi-policy-"),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(directory, "Home.webpage.yml"),
    "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\n",
  );
  await fs.writeFile(
    path.join(directory, "Home.webpage.copy.html"),
    '{% fetchxml records %}<fetch><entity name="contact"><attribute name="secret"/></entity></fetch>{% endfetchxml %}<p>{{records.results.entities[0].secret}}</p>',
  );
  await fs.writeFile(
    path.join(directory, "sitesetting.yml"),
    Object.entries(settings)
      .map(([name, value]) => `- adx_name: ${name}\n  adx_value: '${value}'`)
      .join("\n"),
  );
  const app = await createSimulator({
    sourceDir: directory,
    initial: fixture(),
    watch: false,
  });
  t.after(() => app.close());
  const request = (route, method = "GET", body) =>
    fetch(app.url + route, {
      method,
      headers: {
        __RequestVerificationToken: app.state().csrf,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  let response = await request("/_api/contacts");
  assert.equal(response.status, 403, "select-less collection reads name the first column outside the list");
  response = await request("/_api/contacts?$select=contactid,fullname");
  assert.equal(response.status, 200);
  const row = (await response.json()).value[0];
  assert.equal(row.contactid, "person");
  assert.equal(row.fullname, "Visible");
  assert.equal(row.secret, undefined);
  for (const query of [
    "$select=secret",
    "$filter=secret eq 'Hidden'",
    "$orderby=secret",
    "$expand=company($select=secret)",
  ]) {
    response = await request("/_api/contacts?" + query);
    assert.equal(response.status, 403);
    assert.deepEqual(await apiError(response), { code: "90040101", sim: "WebApiFieldNotEnabled" });
  }
  response = await request("/_api/contacts?$select=fullname&$expand=company($select=name)");
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).value[0].company.name,
    "Permitted company",
  );
  for (const [method, route, body] of [
    ["PATCH", "/_api/contacts(person)", { secret: "Changed" }],
    ["POST", "/_api/contacts", { secret: "Created" }],
    ["PUT", "/_api/contacts(person)/secret", { value: "Changed" }],
    ["DELETE", "/_api/contacts(person)/secret", undefined],
  ]) {
    response = await request(route, method, body);
    assert.equal(response.status, 403);
    assert.deepEqual(await apiError(response), { code: "90040101", sim: "WebApiFieldNotEnabled" });
  }
  assert.equal(app.store.snapshot().tables.contact[0].secret, "Hidden");
  response = await request("/_api/contacts(person)", "PATCH", {
    fullname: "Updated",
  });
  assert.equal(response.status, 204);
  const deniedXml =
    '<fetch><entity name="contact"><attribute name="fullname"/><filter><condition attribute="secret" operator="eq" value="Hidden"/></filter></entity></fetch>';
  response = await request(
    "/_api/contacts?fetchXml=" + encodeURIComponent(deniedXml),
  );
  assert.equal(response.status, 403);
  const aliasXml =
    '<fetch><entity name="contact"><attribute name="fullname" alias="publicname"/></entity></fetch>';
  response = await request(
    "/_api/contacts?fetchXml=" + encodeURIComponent(aliasXml),
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).value[0].publicname, "Updated");
  const implicitAliasXml =
    '<fetch><entity name="contact"><attribute name="fullname"/><link-entity name="account" from="accountid" to="companyid"><attribute name="name"/></link-entity></entity></fetch>';
  response = await request(
    "/_api/contacts?fetchXml=" + encodeURIComponent(implicitAliasXml),
  );
  assert.equal(response.status, 200);
  assert.equal(
    (await response.json()).value[0]["account1.name"],
    "Permitted company",
  );
  assert.throws(
    () =>
      webApiFetchPolicy(
        { settings },
        app.store,
        '<fetch><entity name="contact"><link-entity name="account" from="accountid" to="companyid"><attribute name="secret"/></link-entity></entity></fetch>',
        "contact",
      ),
    (error) => error.code === "WebApiFieldNotEnabled",
  );
  response = await request("/");
  assert.equal(response.status, 200);
  assert.match(await response.text(), /<p>Hidden<\/p>/);
});

test("enabled OData lookup aliases authorize only metadata-equivalent read and expand columns", () => {
  const store = new DataStore({ state: fixture() }),
    portal = {
      settings: {
        ...settings,
        "Webapi/contact/fields": "_companyid_value,_unproven_value",
      },
    };
  const policy = webApiPolicy(portal, store, "contact");
  policy.assertQuery(
    new URLSearchParams({
      $select: "_companyid_value",
      $expand: "company($select=name)",
    }),
  );
  assert.equal(
    policy.project({ companyid: "company", unproven: "hidden" }).companyid,
    "company",
  );
  assert.throws(
    () => policy.assertQuery(new URLSearchParams({ $select: "unproven" })),
    (e) => e.code === "WebApiFieldNotEnabled",
  );
  assert.throws(
    () => policy.assertWrite({ "company@odata.bind": "/accounts(company)" }),
    (e) => e.code === "WebApiFieldNotEnabled",
  );
  portal.webApiIdentity = { roleSource: "memberships", roleIds: ["reader"] };
  portal.records = [
    {
      id: "profile",
      kind: "columnpermissionprofile",
      adx_tablename: "contact",
      adx_columnpermissionprofile_webrole: ["reader"],
    },
    {
      id: "restricted",
      kind: "columnpermission",
      adx_columnpermissionprofileid: "profile",
      adx_columnname: "companyid",
      adx_permissions: [746610000],
    },
  ];
  assert.throws(
    () =>
      webApiPolicy(portal, store, "contact").assertQuery(
        new URLSearchParams({ $expand: "company($select=name)" }),
      ),
    (e) => e.code === "WebApiFieldNotEnabled",
  );
});

test("Dataverse immutable values are ignored after portal permissions, including lookup bindings and operation-specific flags", () => {
  const state = fixture();
  state.mappings.contact.fields = {
    createdon: { validForCreate: false, validForUpdate: false },
    companyid: { validForCreate: true, validForUpdate: false },
    createonly: { validForCreate: true, validForUpdate: false },
  };
  const store = new DataStore({ state });
  const portal = { settings: { ...settings, "Webapi/contact/fields": "*" }, observed:{webApiWildcard:"exempt",evidence:"synthetic fixture with wildcard field lists"} };
  const policy = webApiPolicy(portal, store, "contact");
  const body = {
    fullname: "Updated",
    createdon: "forged",
    createonly: "unchangeable",
    "company@odata.bind": "/accounts(company)",
  };
  assert.deepEqual(policy.prepareWrite(body), { fullname: "Updated" });
  assert.deepEqual(policy.prepareWrite(body, "create"), {
    fullname: "Updated",
    createonly: "unchangeable",
    "company@odata.bind": "/accounts(company)",
  });
  assert.equal(body.createdon, "forged");
  assert.deepEqual(
    policy.prepareWrite({ CreatedOn: "forged", _companyid_value: "forged" }),
    {},
  );
  portal.settings["Webapi/contact/fields"] = "fullname";
  assert.throws(
    () =>
      webApiPolicy(portal, store, "contact").prepareWrite({
        createdon: "forged",
      }),
    (e) => e.code === "WebApiFieldNotEnabled",
  );
});

test("HTTP public wildcard API preserves private backend snapshots across denied PATCH/PUT/DELETE and queries", async t => {
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),"pp-private-api-"));
  await fs.writeFile(path.join(dir,"website.yml"),"adx_name: Private API\nadx_websiteid: site");
  await fs.writeFile(path.join(dir,"settings.sitesetting.yml"),"- adx_name: Webapi/contact/enabled\n  adx_value: true\n- adx_name: Webapi/contact/fields\n  adx_value: '*'");
  const state=fixture(),privateSnapshot={checksums:{pdf:"immutable"},snapshot:{application:"original"}};
  state.tables.contact[0].__simArtifact=privateSnapshot;
  const app=await createSimulator({sourceDir:dir,stateFile:path.join(dir,"state.json"),initial:state,watch:false,observed:{webApiWildcard:"exempt",evidence:"synthetic fixture with wildcard field lists"}});
  t.after(async()=>{await app.close();const resolved=await fs.realpath(dir);assert.ok(resolved.startsWith((await fs.realpath(os.tmpdir()))+path.sep));await fs.rm(resolved,{recursive:true,force:true});});
  const config=await(await fetch(app.url+"/__sim/api/state")).json();
  for(const [suffix,method,body] of [["","PATCH",{__simArtifact:{checksums:{pdf:"forged"}}}],["/__simArtifact","PUT",{value:{}}],["/__simArtifact","DELETE"],["?$select=__simArtifact","GET"],["?$filter=__simArtifact%20eq%20null","GET"]]){
    const response=await fetch(app.url+"/_api/contacts(person)"+suffix,{method,headers:{"content-type":"application/json",__RequestVerificationToken:config.csrf},...(body===undefined?{}:{body:JSON.stringify(body)})});
    assert.equal(response.status,403);
    assert.deepEqual(await apiError(response),{code:"90040101",sim:"WebApiPrivateField"});
    assert.deepEqual(app.store.snapshot().tables.contact[0].__simArtifact,privateSnapshot);
  }
  const read=await(await fetch(app.url+"/_api/contacts(person)")).json();
  assert.equal(read.__simArtifact,undefined);
  const admin=await fetch(app.url+"/__sim/api/records/contact/person",{method:"PATCH",headers:{"content-type":"application/json","X-Sim-CSRF":config.csrf},body:JSON.stringify({__simArtifact:{snapshot:{application:"explicit admin edit"}}})});
  assert.equal(admin.status,200,"The explicit local admin remains editable.");
  assert.equal(app.store.snapshot().tables.contact[0].__simArtifact.snapshot.application,"explicit admin edit");
});

test("HTTP PATCH/PUT/DELETE cannot change immutable metadata columns while permitted fields still save", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pp-immutable-api-"));
  await fs.writeFile(
    path.join(dir, "website.yml"),
    "adx_name: Immutable API\nadx_websiteid: site",
  );
  await fs.writeFile(
    path.join(dir, "settings.sitesetting.yml"),
    "- adx_name: Webapi/contact/enabled\n  adx_value: true\n- adx_name: Webapi/contact/fields\n  adx_value: '*'",
  );
  const state = fixture();
  state.mappings.contact.fields = {
    createdon: { validForCreate: false, validForUpdate: false },
  };
  state.tables.contact[0].createdon = "2026-01-01T00:00:00Z";
  const app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, "state.json"),
    initial: state,
    watch: false,
    observed: { webApiWildcard: "exempt", evidence: "synthetic fixture with a wildcard field list" },
  });
  t.after(async () => {
    await app.close();
    const resolved = await fs.realpath(dir);
    assert.ok(resolved.startsWith(await fs.realpath(os.tmpdir())));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  const config = await (await fetch(app.url + "/__sim/api/state")).json();
  const call = (suffix, method, body) =>
    fetch(app.url + "/_api/contacts(person)" + suffix, {
      method,
      headers: {
        "content-type": "application/json",
        __RequestVerificationToken: config.csrf,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  assert.equal(
    (await call("", "PATCH", { fullname: "Updated", createdon: "forged" }))
      .status,
    204,
  );
  assert.equal(
    (await call("/createdon", "PUT", { value: "forged" })).status,
    204,
  );
  assert.equal((await call("/createdon", "DELETE")).status, 204);
  const saved = app.store.snapshot().tables.contact[0];
  assert.equal(saved.fullname, "Updated");
  assert.equal(saved.createdon, "2026-01-01T00:00:00Z");
});
