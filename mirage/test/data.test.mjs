import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DataStore,
  DataError,
  compileFilter,
  parseFetchXml,
} from "../lib/data.mjs";
import { initialState } from "../lib/bootstrap.mjs";

const user = { contactId: "c1", accountId: "a1", roles: ["Member"] };
test("Authored cache-refresh FetchXML parenthesized GUIDs identify the same permitted product without changing ordinary text comparisons", () => {
  const id = "33333333-3333-3333-3333-333333333333";
  const store = new DataStore({
    state: {
      mappings: { product: { idColumn: "productid" } },
      tables: {
        product: [
          {
            productid: id,
            name: "Medicinal Product",
            owner: "c1",
            text: "(literal)",
          },
          {
            productid: "44444444-4444-4444-4444-444444444444",
            owner: "c2",
            name: "Other company",
          },
        ],
      },
      permissions: [
        {
          entity: "product",
          roles: ["Member"],
          operations: ["read"],
          scope: "contact",
          field: "owner",
        },
      ],
      settings: { permissionMode: "enforce" },
    },
  });
  for (const value of [id, "(" + id + ")", "{" + id + "}"]) {
    const xml = `<fetch><entity name="product"><attribute name="name"/><filter><condition attribute="productid" operator="in"><value>${value}</value></condition></filter></entity></fetch>`;
    assert.deepEqual(store.fetchXml(xml, user).entities, [
      { productid: id, name: "Medicinal Product" },
    ]);
    assert.equal(store.get("product", value, user).name, "Medicinal Product");
  }
  assert.equal(
    store.query("product", { $filter: "text eq 'literal'" }, user).value.length,
    0,
  );
  assert.equal(
    store.query("product", { $filter: "text eq '(literal)'" }, user).value
      .length,
    1,
  );
  assert.throws(
    () => store.get("product", "(44444444-4444-4444-4444-444444444444)", user),
    (error) => error.status === 403,
  );
});
test("Query-local readable joins respect different identities and immediately changed permission/record state", async () => {
  const store = await new DataStore({
    state: {
      mappings: {
        item: {
          idColumn: "itemid",
          entitySet: "items",
          relationships: {
            group: {
              entity: "group",
              from: "groupid",
              to: "groupid",
              many: false,
            },
          },
        },
        group: { idColumn: "groupid", entitySet: "groups" },
      },
      tables: {
        item: [
          { itemid: "one", groupid: "a" },
          { itemid: "two", groupid: "b" },
        ],
        group: [
          { groupid: "a", contact: "c1", name: "Alpha" },
          { groupid: "b", contact: "c2", name: "Beta" },
        ],
      },
      permissions: [
        { entity: "item", roles: ["Member"], scope: "global" },
        {
          entity: "group",
          roles: ["Member"],
          scope: "contact",
          field: "contact",
        },
      ],
      settings: { permissionMode: "enforce" },
    },
  }).init();
  const xml =
    '<fetch><entity name="item"><attribute name="itemid"/><link-entity name="group" from="groupid" to="groupid"><attribute name="name" alias="name"/></link-entity></entity></fetch>';
  assert.deepEqual(store.fetchXml(xml, user).entities, [
    { itemid: "one", name: "Alpha" },
  ]);
  assert.deepEqual(store.fetchXml(xml, { ...user, contactId: "c2" }).entities, [
    { itemid: "two", name: "Beta" },
  ]);
  assert.deepEqual(
    store
      .query(
        "item",
        { $filter: "group/name eq 'Alpha'", $expand: "group" },
        user,
      )
      .value.map((x) => x.itemid),
    ["one"],
  );
  assert.equal(
    store.query(
      "item",
      { $filter: "group/name eq 'Alpha'" },
      { ...user, contactId: "c2" },
    ).value.length,
    0,
  );
  const changed = store.snapshot();
  changed.tables.group[0].contact = "c2";
  changed.tables.group[0].name = "Changed";
  await store.replaceState(changed);
  assert.equal(store.fetchXml(xml, user).entities.length, 0);
  assert.equal(
    store.query("item", { $filter: "group/name eq 'Alpha'" }, user).value
      .length,
    0,
  );
  assert.deepEqual(store.fetchXml(xml, { ...user, contactId: "c2" }).entities, [
    { itemid: "one", name: "Changed" },
    { itemid: "two", name: "Beta" },
  ]);
  assert.equal(
    store.query(
      "item",
      { $filter: "group/name eq 'Changed'" },
      { ...user, contactId: "c2" },
    ).value[0].itemid,
    "one",
  );
});
test("FetchXML preserves quoted greater-than delimiters and escaped native paging cookies", () => {
  const parsed = parseFetchXml(
    `<fetch paging-cookie="&lt;cookie page='1'>&lt;id last='1'/>&lt;/cookie>"><entity name="item"><filter><condition attribute="name" operator="eq" value="a > b"/></filter></entity></fetch>`,
  );
  assert.equal(
    parsed.attrs["paging-cookie"],
    "<cookie page='1'><id last='1'/></cookie>",
  );
  assert.equal(parsed.children[0].children[0].children[0].attrs.value, "a > b");
});
test("Backend findMany copies only readable matching rows, rejects unbounded expansion and rolls back", async () => {
  const initial = {
    mappings: {
      request: { idColumn: "requestid", entitySet: "requests" },
      source: { idColumn: "sourceid", entitySet: "sources" },
      copy: { idColumn: "copyid", entitySet: "copies" },
    },
    tables: {
      request: [],
      source: [
        { sourceid: "own", contact: "c1", kind: "selected" },
        { sourceid: "foreign", contact: "c2", kind: "selected" },
      ],
      copy: [],
    },
    permissions: [
      {
        entity: "request",
        roles: ["Member"],
        operations: ["create"],
        scope: "global",
      },
      {
        entity: "source",
        roles: ["Member"],
        operations: ["read"],
        scope: "contact",
        field: "contact",
      },
    ],
    plugins: [
      {
        entity: "request",
        operations: ["create"],
        secondary: [
          {
            entity: "copy",
            operation: "create",
            foreach: {
              op: "findMany",
              args: ["source", "sourceid"],
              match: { kind: "selected" },
            },
            set: { source: "$item" },
          },
        ],
      },
    ],
    settings: { permissionMode: "enforce" },
  };
  const store = await new DataStore({ state: initial }).init();
  await store.create("request", {}, user);
  assert.deepEqual(
    store.snapshot().tables.copy.map((row) => row.source),
    ["own"],
  );
  const huge = store.snapshot();
  huge.tables.source = Array.from({ length: 1025 }, (_, index) => ({
    sourceid: `source${index}`,
    contact: "c1",
    kind: "selected",
  }));
  await store.replaceState(huge);
  const before = store.snapshot();
  await assert.rejects(
    store.create("request", {}, user),
    (error) => error.code === "InvalidPlugin",
  );
  assert.deepEqual(store.snapshot(), before);
});
test("FetchXML traverses only declared structural many-to-many edges while both endpoints remain trimmed", async () => {
  const state = {
    mappings: {
      item: {
        idColumn: "itemid",
        entitySet: "items",
        relationships: {
          groups: {
            entity: "group",
            from: "itemid",
            to: "groupid",
            many: true,
            intersect: { entity: "edge", from: "itemid", to: "groupid" },
          },
        },
      },
      group: { idColumn: "groupid", entitySet: "groups" },
      edge: { idColumn: "edgeid", entitySet: "edges" },
    },
    tables: {
      item: [
        { itemid: "own", contact: "c1" },
        { itemid: "foreign", contact: "c2" },
      ],
      group: [
        { groupid: "allowed", contact: "c1" },
        { groupid: "denied", contact: "c2" },
      ],
      edge: [
        { edgeid: "1", itemid: "own", groupid: "allowed", secret: "hidden" },
        { edgeid: "2", itemid: "own", groupid: "denied", secret: "hidden" },
        {
          edgeid: "3",
          itemid: "foreign",
          groupid: "allowed",
          secret: "hidden",
        },
      ],
    },
    permissions: [
      { entity: "item", roles: ["Member"], scope: "contact", field: "contact" },
      {
        entity: "group",
        roles: ["Member"],
        scope: "contact",
        field: "contact",
      },
    ],
    settings: { permissionMode: "enforce" },
  };
  const store = await new DataStore({ state }).init();
  const xml = `<fetch><entity name="item"><attribute name="itemid"/><link-entity name="edge" alias="membership" from="itemid" to="itemid" intersect="true"><link-entity name="group" from="groupid" to="groupid"><attribute name="groupid" alias="group"/></link-entity></link-entity></entity></fetch>`;
  assert.deepEqual(store.fetchXml(xml, user).entities, [
    { itemid: "own", group: "allowed" },
  ]);
  assert.equal(store.rows("edge", user).length, 0);
  assert.throws(
    () => store.get("edge", "1", user),
    (e) => e.code === "PermissionDenied",
  );
  assert.throws(
    () => store.query("edge", {}, user),
    (e) => e.code === "PermissionDenied",
  );
  assert.deepEqual(
    store.fetchXml(xml.replace('intersect="true"', ""), user).entities,
    [{ itemid: "own", group: "allowed" }],
  );
  const leaf = `<fetch><entity name="item"><attribute name="itemid"/><link-entity name="edge" alias="membership" from="itemid" to="itemid"><filter><condition attribute="groupid" operator="eq" value="allowed"/></filter></link-entity></entity></fetch>`;
  assert.deepEqual(store.fetchXml(leaf, user).entities, [{ itemid: "own" }]);
  assert.deepEqual(
    store.fetchXml(leaf.replace('value="allowed"', 'value="denied"'), user)
      .entities,
    [],
  );
  assert.equal(
    store.fetchXml(
      xml.replace(
        '<link-entity name="group"',
        '<attribute name="secret"/><link-entity name="group"',
      ),
      user,
    ).entities.length,
    0,
  );
  assert.throws(
    () =>
      store.fetchXml(
        xml.replace(
          '<link-entity name="group"',
          '<filter><condition attribute="secret" operator="eq" value="hidden"/></filter><link-entity name="group"',
        ),
        user,
      ),
    (e) => e.code === "InvalidIntersectionQuery",
  );
  assert.throws(
    () =>
      store.fetchXml(
        xml.replace(
          '<attribute name="itemid"/>',
          '<attribute name="itemid"/><filter><condition entityname="membership" attribute="secret" operator="eq" value="hidden"/></filter>',
        ),
        user,
      ),
    (e) => e.code === "InvalidIntersectionQuery",
  );
  const denied = store.snapshot();
  denied.permissions = denied.permissions.filter((p) => p.entity !== "group");
  await store.replaceState(denied);
  assert.equal(store.fetchXml(xml, user).entities.length, 0);
});
test("Parent-scoped create stages trusted backend links and rolls back gate, scope and lookup rejection atomically", async () => {
  const initial = {
    mappings: {
      app: {
        idColumn: "appid",
        entitySet: "apps",
        relationships: {
          customer: { entity: "account", from: "customer", to: "accountid" },
        },
      },
      coauthor: { idColumn: "coauthorid", entitySet: "coauthors" },
      userrole: { idColumn: "userroleid", entitySet: "userroles" },
      account: { idColumn: "accountid", entitySet: "accounts" },
    },
    tables: {
      app: [],
      coauthor: [],
      userrole: [
        { userroleid: "own", contact: "c1" },
        { userroleid: "foreign", contact: "c2" },
      ],
      account: [
        { accountid: "a1", contact: "c1" },
        { accountid: "a2", contact: "c2" },
      ],
    },
    permissions: [
      {
        id: "app",
        entity: "app",
        roles: ["Member"],
        operations: ["create", "read", "append"],
        scope: "parent",
        parentPermissionId: "coauthor",
        relationship: {
          entity: "coauthor",
          from: "appid",
          to: "application",
          many: true,
        },
      },
      {
        id: "coauthor",
        entity: "coauthor",
        roles: ["Member"],
        operations: ["read"],
        scope: "parent",
        parentPermissionId: "userrole",
        relationship: {
          entity: "userrole",
          from: "applicant",
          to: "userroleid",
        },
      },
      {
        id: "userrole",
        entity: "userrole",
        roles: ["Member"],
        operations: ["read"],
        scope: "contact",
        field: "contact",
      },
      {
        id: "account",
        entity: "account",
        roles: ["Member"],
        operations: ["read", "appendTo"],
        scope: "contact",
        field: "contact",
      },
    ],
    plugins: [
      {
        entity: "app",
        operations: ["create"],
        secondary: [
          {
            entity: "coauthor",
            operation: "create",
            set: {
              application: { op: "reference", args: ["app", "$record.appid"] },
              applicant: "$record.requestedrole",
            },
          },
        ],
      },
    ],
    settings: { permissionMode: "enforce", associationPermissions: "enforce" },
  };
  const store = await new DataStore({ state: initial }).init();
  const created = await store.create(
    "app",
    { requestedrole: "own", customer: "a1" },
    user,
  );
  assert.equal(store.get("app", created.appid, user).customer, "a1");
  assert.equal(
    store.snapshot().tables.coauthor[0].application.id,
    created.appid,
  );
  const snapshot = store.snapshot();
  await assert.rejects(
    store.create("app", { requestedrole: "foreign", customer: "a1" }, user),
    (e) => e.code === "PermissionDenied",
  );
  assert.deepEqual(store.snapshot(), snapshot);
  await assert.rejects(
    store.create("app", { requestedrole: "own", customer: "a2" }, user),
    (e) => e.code === "PermissionDenied",
  );
  assert.deepEqual(store.snapshot(), snapshot);
  await assert.rejects(
    store.create("app", { requestedrole: "own" }, { ...user, roles: [] }),
    (e) => e.code === "PermissionDenied",
  );
  assert.deepEqual(store.snapshot(), snapshot);
});
test("Membership identities use resolved exported roles without granting implicit literal defaults", async () => {
  const store = await new DataStore({
    state: {
      mappings: { contact: { idColumn: "contactid", entitySet: "contacts" } },
      tables: { contact: [{ contactid: "c1" }] },
      permissions: [
        {
          entity: "contact",
          roles: ["Authenticated Users"],
          scope: "self",
          operations: ["read"],
        },
      ],
      settings: { permissionMode: "enforce" },
    },
  }).init();
  assert.equal(
    store.get("contact", "c1", { contactId: "c1", roles: [] }).contactid,
    "c1",
  );
  assert.throws(
    () =>
      store.get("contact", "c1", {
        contactId: "c1",
        roles: [],
        roleSource: "memberships",
      }),
    (e) => e.code === "PermissionDenied",
  );
  assert.equal(
    store.get("contact", "c1", {
      contactId: "c1",
      roles: ["Authenticated Users"],
      roleSource: "memberships",
    }).contactid,
    "c1",
  );
  const imported = store.snapshot();
  imported.permissions[0].roleIds = ["actual-source-role"];
  await store.replaceState(imported);
  assert.throws(
    () =>
      store.get("contact", "c1", {
        contactId: "c1",
        roles: ["Authenticated Users"],
        roleIds: ["same-name-other-role"],
        roleSource: "memberships",
      }),
    (e) => e.code === "PermissionDenied",
  );
  assert.equal(
    store.get("contact", "c1", {
      contactId: "c1",
      roles: ["Authenticated Users"],
      roleIds: ["actual-source-role"],
      roleSource: "memberships",
    }).contactid,
    "c1",
  );
  const unresolved = store.snapshot();
  unresolved.permissions[0].imported = true;
  unresolved.permissions[0].roleIds = [];
  await store.replaceState(unresolved);
  assert.throws(
    () =>
      store.get("contact", "c1", {
        contactId: "c1",
        roles: ["Authenticated Users"],
        roleSource: "memberships",
      }),
    (e) => e.code === "PermissionDenied",
  );
});
test("Parent grants may revisit a row through distinct source permissions while genuine grant cycles remain rejected", async () => {
  const source = {
    mappings: {
      app: { idColumn: "appid", entitySet: "apps" },
      coauthor: { idColumn: "coauthorid", entitySet: "coauthors" },
      role: { idColumn: "roleid", entitySet: "roles" },
    },
    tables: {
      app: [{ appid: "app" }],
      coauthor: [
        { coauthorid: "author", application: "app", applicant: "own-role" },
      ],
      role: [{ roleid: "own-role", contact: "c1" }],
    },
    permissions: [
      {
        id: "coauthor-root",
        entity: "coauthor",
        roles: ["Member"],
        scope: "parent",
        parentPermissionId: "app-scoped",
        relationship: { entity: "app", from: "application", to: "appid" },
      },
      {
        id: "app-scoped",
        entity: "app",
        roles: ["Member"],
        scope: "parent",
        parentPermissionId: "coauthor-scoped",
        relationship: {
          entity: "coauthor",
          from: "appid",
          to: "application",
          many: true,
        },
      },
      {
        id: "coauthor-scoped",
        entity: "coauthor",
        roles: ["Member"],
        scope: "parent",
        parentPermissionId: "role-scoped",
        relationship: { entity: "role", from: "applicant", to: "roleid" },
      },
      {
        id: "role-scoped",
        entity: "role",
        roles: ["Member"],
        scope: "contact",
        field: "contact",
      },
    ],
    settings: { permissionMode: "enforce" },
  };
  const store = await new DataStore({ state: source }).init();
  assert.equal(store.get("coauthor", "author", user).coauthorid, "author");
  const cyclic = store.snapshot();
  cyclic.permissions.find((p) => p.id === "app-scoped").parentPermissionId =
    "coauthor-root";
  await store.replaceState(cyclic);
  assert.throws(
    () => store.get("coauthor", "author", user),
    (e) => e.code === "InvalidPermission",
  );
});
const state = () => ({
  mappings: {
    contact: {
      entitySet: "contacts",
      idColumn: "contactid",
      relationships: {
        account: {
          entity: "account",
          from: "parentcustomerid",
          to: "accountid",
          many: false,
        },
      },
    },
    account: { entitySet: "accounts", idColumn: "accountid" },
    audit: { entitySet: "audits", idColumn: "auditid" },
  },
  tables: {
    contact: [
      {
        contactid: "c1",
        firstname: "Ada",
        lastname: "Lovelace",
        age: 36,
        parentcustomerid: "a1",
      },
      {
        contactid: "c2",
        firstname: "Grace",
        lastname: "Hopper",
        age: 85,
        parentcustomerid: "a2",
      },
      {
        contactid: "c3",
        firstname: "Alan",
        lastname: "Turing",
        age: 41,
        parentcustomerid: null,
      },
    ],
    account: [
      { accountid: "a1", name: "Analytical Engines" },
      { accountid: "a2", name: "Compilers" },
    ],
    audit: [],
  },
  permissions: [
    {
      entity: "contact",
      operations: ["read", "create", "update", "delete"],
      roles: ["Member"],
      scope: "global",
    },
    {
      entity: "account",
      operations: ["read"],
      roles: ["Member"],
      scope: "global",
    },
  ],
});

test("persistent CRUD with atomic rollback and declarative plugin secondary effects", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pp-mirage-data-"));
  try {
    const initial = state();
    initial.plugins = [
      {
        id: "contact-compute",
        entity: "contact",
        operations: ["create", "update"],
        defaults: { statuscode: 1 },
        set: {
          fullname: {
            op: "concat",
            args: ["$record.firstname", " ", "$record.lastname"],
          },
        },
        validate: [
          { field: "lastname", required: true },
          { field: "firstname", unique: true },
        ],
        secondary: [
          {
            entity: "audit",
            operation: "create",
            set: { subject: "$record.fullname" },
          },
        ],
      },
    ];
    const store = await new DataStore({
      file: join(dir, "state.json"),
      state: initial,
    }).init();
    await assert.rejects(
      store.create("contacts", { firstname: "New" }, user),
      (e) => e.code === "PluginValidation",
    );
    assert.equal(store.snapshot().tables.audit.length, 0);
    const row = await store.create(
      "contacts",
      { firstname: "Katherine", lastname: "Johnson" },
      user,
    );
    assert.equal(row.fullname, "Katherine Johnson");
    assert.equal(row.statuscode, 1);
    assert.equal(store.snapshot().tables.audit[0].subject, row.fullname);
    const restored = await new DataStore({
      file: join(dir, "state.json"),
    }).init();
    assert.equal(
      restored.get("contacts", row.contactid, user).fullname,
      row.fullname,
    );
    await assert.rejects(
      store.update("contacts", row.contactid, { firstname: "Ada" }, user),
      (e) => e.code === "PluginValidation",
    );
    assert.equal(
      store.get("contacts", row.contactid, user).firstname,
      "Katherine",
    );
    await store.update("contacts", row.contactid, { lastname: "J" }, user);
    await store.remove("contacts", row.contactid, user);
    assert.equal(store.get("contacts", row.contactid, user), null);
    assert.equal(
      JSON.parse(await readFile(join(dir, "state.json"), "utf8")).tables.contact
        .length,
      3,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("OData nested filters, projection, ordering, count, paging and mapped expand", () => {
  const store = new DataStore({ state: state() });
  const result = store.query(
    "contacts",
    new URLSearchParams({
      $filter:
        "(age ge 40 and startswith(tolower(firstname),'g')) or firstname eq 'Ada'",
      $orderby: "age desc",
      $select: "firstname,age",
      $expand: "account($select=name)",
      $top: "1",
      $count: "true",
    }),
    user,
  );
  assert.equal(result["@odata.count"], 2);
  assert.deepEqual(result.value, [
    { firstname: "Grace", age: 85, account: { name: "Compilers" } },
  ]);
  assert.equal(
    store.query(
      "contacts",
      { $filter: "firstname in ('Ada','Alan')", $skip: "1", $top: "1" },
      user,
    ).value[0].firstname,
    "Alan",
  );
  assert.throws(
    () => store.query("contacts", { $apply: "aggregate(age with sum)" }, user),
    (e) => e.code === "UnsupportedQuery",
  );
  assert.throws(() => compileFilter("name eq eval(1)"), DataError);
  assert.equal(
    compileFilter("contactid eq 11111111-1111-1111-1111-111111111111")({
      contactid: "11111111-1111-1111-1111-111111111111",
    }),
    true,
  );
  assert.equal(
    compileFilter("createdon ge 2026-01-01T00:00:00Z")({
      createdon: "2026-02-01T00:00:00Z",
    }),
    true,
  );
});

test("permission trimming applies equally to FetchXML and OData and prevents ownership reassignment", async () => {
  const initial = state();
  initial.permissions = [
    {
      entity: "contact",
      operations: ["read", "update", "create"],
      roles: ["Member"],
      scope: "self",
    },
    {
      entity: "account",
      operations: ["read"],
      roles: ["Member"],
      scope: "account",
      field: "accountid",
    },
  ];
  const store = new DataStore({ state: initial });
  assert.equal(store.query("contacts", {}, user).value.length, 1);
  assert.equal(
    store.fetchXml(
      '<fetch><entity name="contact"><all-attributes /></entity></fetch>',
      user,
    ).entities.length,
    1,
  );
  assert.throws(
    () => store.get("contact", "c2", user),
    (e) => e.status === 403,
  );
  await assert.rejects(
    store.remove("contact", "c1", user),
    (e) => e.status === 403,
  );
  assert.throws(
    () => store.query("audit", {}, user),
    (e) => e.status === 403,
  );
  assert.deepEqual(
    store.fetchXml('<fetch><entity name="audit" /></fetch>', user).entities,
    [],
  );
  assert.equal(store.query("contacts", {}, { admin: true }).value.length, 3);
});

test("FetchXML inner and outer joins, alias filters, distinct, paging and aggregates", () => {
  const store = new DataStore({ state: state() });
  const result = store.fetchXml(
    `<fetch count="1" page="1" returntotalrecordcount="true"><entity name="contact"><attribute name="firstname"/><link-entity name="account" from="accountid" to="parentcustomerid" alias="org" link-type="outer"><attribute name="name"/></link-entity><filter type="or"><condition entityname="org" attribute="name" operator="like" value="%Engine%"/><condition attribute="parentcustomerid" operator="null"/></filter><order attribute="firstname"/></entity></fetch>`,
    user,
  );
  assert.equal(result.total_record_count, 2);
  assert.equal(result.more_records, true);
  assert.equal(result.entities[0].firstname, "Ada");
  assert.equal(result.entities[0]["org.name"], "Analytical Engines");
  const aggregate = store.fetchXml(
    '<fetch aggregate="true"><entity name="contact"><attribute name="age" alias="sum" aggregate="sum"/><attribute name="contactid" alias="count" aggregate="count"/><attribute name="age" alias="avg" aggregate="avg"/></entity></fetch>',
    user,
  );
  assert.deepEqual(aggregate.entities, [{ sum: 162, count: 3, avg: 54 }]);
  const grouped = store.fetchXml(
    '<fetch aggregate="true"><entity name="contact"><attribute name="parentcustomerid" alias="org" groupby="true"/><attribute name="age" alias="total" aggregate="sum"/></entity></fetch>',
    user,
  );
  assert.equal(grouped.entities.length, 3);
});

test("FetchXML nested links and existential link types preserve multiplicity correctly", () => {
  const initial = state();
  initial.mappings.audit = { entitySet: "audits", idColumn: "auditid" };
  initial.tables.audit = [
    { auditid: "l1", contactid: "c1", subject: "A" },
    { auditid: "l2", contactid: "c1", subject: "B" },
  ];
  initial.permissions.push({
    entity: "audit",
    operations: ["read"],
    roles: ["Member"],
    scope: "global",
  });
  const store = new DataStore({ state: initial });
  const link = (type) =>
    `<fetch><entity name="contact"><attribute name="firstname"/><link-entity name="audit" from="contactid" to="contactid" link-type="${type}" alias="log"><attribute name="subject"/></link-entity></entity></fetch>`;
  assert.equal(store.fetchXml(link("inner"), user).entities.length, 2);
  assert.equal(store.fetchXml(link("exists"), user).entities.length, 1);
  assert.equal(store.fetchXml(link("not any"), user).entities.length, 2);
  initial.tables.audit.push({ auditid: "l3", contactid: null });
  initial.tables.contact.push({
    contactid: "c4",
    firstname: "Nobody",
    parentcustomerid: null,
  });
  const nulls = new DataStore({ state: initial });
  assert.equal(
    nulls.fetchXml(
      '<fetch><entity name="contact"><attribute name="firstname"/><link-entity name="audit" from="contactid" to="parentcustomerid" link-type="inner"/></entity></fetch>',
      user,
    ).entities.length,
    0,
  );
});

test("malformed and unsupported queries fail without arbitrary evaluation or entity resolution", () => {
  const store = new DataStore({ state: state() });
  assert.throws(
    () => parseFetchXml('<!DOCTYPE fetch SYSTEM "file:///secret"><fetch/>'),
    DataError,
  );
  assert.throws(() => parseFetchXml("<fetch><entity></fetch>"), DataError);
  assert.throws(
    () =>
      store.fetchXml(
        '<fetch><entity name="contact"><filter><condition attribute="age" operator="nonsense"/></filter></entity></fetch>',
        user,
      ),
    (e) => e.code === "UnsupportedQuery",
  );
  assert.throws(() => store.query("__proto__", {}, user), DataError);
  assert.throws(() => store.query("contacts", { $top: "-1" }, user), DataError);
});

test("lookup bindings resolve explicit entity mappings and presets are persistent", async () => {
  const store = new DataStore({ state: state() });
  const created = await store.create(
    "contacts",
    {
      firstname: "X",
      lastname: "Y",
      "parentcustomerid@odata.bind": "/accounts(a1)",
    },
    user,
  );
  assert.deepEqual(created.parentcustomerid, {
    id: "a1",
    logical_name: "account",
    name: "Analytical Engines",
  });
  assert.equal(
    store.query(
      "contacts",
      { $filter: "_parentcustomerid_value eq 'a1'" },
      user,
    ).value.length,
    2,
  );
  await store.applyPreset("strict-permissions");
  assert.equal(store.snapshot().settings.permissionMode, "enforce");
  await store.applyPreset("open-sandbox");
  assert.equal(store.query("audits").value.length, 0);
});

test("native navigation bindings populate physical lookup columns, validate targets and clear with null", async () => {
  const data = state();
  data.mappings.contact.relationships.customer = {
    entity: "account",
    from: "parentcustomerid",
    to: "accountid",
    many: false,
  };
  const store = new DataStore({ state: data });
  const created = await store.create(
    "contacts",
    { firstname: "Synthetic", "customer@odata.bind": "/accounts(a1)" },
    user,
  );
  assert.deepEqual(created.parentcustomerid, {
    id: "a1",
    logical_name: "account",
    name: "Analytical Engines",
  });
  assert.equal(Object.hasOwn(created, "customer"), false);
  assert.equal(Object.hasOwn(created, "customer@odata.bind"), false);
  await store.update(
    "contacts",
    created.contactid,
    { "customer@odata.bind": null },
    user,
  );
  assert.equal(
    store.get("contact", created.contactid, user).parentcustomerid,
    null,
  );
  await assert.rejects(
    store.update(
      "contacts",
      created.contactid,
      { "customer@odata.bind": "/contacts(c1)" },
      user,
    ),
    (e) => e.code === "InvalidLookup",
  );
  await assert.rejects(
    store.update(
      "contacts",
      created.contactid,
      { parentcustomerid: "a1", "customer@odata.bind": "/accounts(a2)" },
      user,
    ),
    (e) => e.code === "InvalidLookup",
  );
  assert.equal(
    store.get("contact", created.contactid, user).parentcustomerid,
    null,
  );
});


test("invalid config rejected atomically and unsupported FetchXML fails on empty table", async () => {
  const store = new DataStore({ state: state() });
  const before = store.snapshot();
  await assert.rejects(
    store.replaceState({
      ...state(),
      plugins: [{ entity: "contact", set: { x: { op: "eval" } } }],
    }),
    DataError,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.throws(
    () =>
      store.fetchXml(
        '<fetch><entity name="audit"><filter><condition attribute="x" operator="unknown"/></filter></entity></fetch>',
        { admin: true },
      ),
    (e) => e.code === "UnsupportedQuery",
  );
});

test("imported unresolved permissions stay disabled with actionable diagnostics and simulator config survives persistence", async () => {
  const portal = {
    records: [
      { kind: "webrole", id: "role1", name: "Member" },
      {
        kind: "tablepermission",
        id: "global",
        adx_entitylogicalname: "account",
        adx_scope: 756150000,
        adx_read: true,
        adx_entitypermission_webrole: ["role1"],
      },
      {
        kind: "tablepermission",
        id: "contact",
        adx_entitylogicalname: "contact",
        adx_scope: 756150001,
        adx_read: true,
        adx_contactrelationship: "account_primary_contact",
        adx_entitypermission_webrole: ["role1"],
      },
      {
        kind: "tablepermission",
        id: "parent",
        adx_entitylogicalname: "child",
        adx_scope: 756150003,
        adx_read: true,
        adx_entitypermission_webrole: ["role1"],
      },
      {
        kind: "tablepermission",
        id: "unknown",
        adx_entitylogicalname: "unknown",
        adx_scope: 999,
        adx_read: true,
        adx_entitypermission_webrole: ["role1"],
      },
      {
        kind: "tablepermission",
        id: "no-role",
        adx_entitylogicalname: "norole",
        adx_scope: 756150000,
        adx_read: true,
      },
    ],
    templates: {},
    forms: [],
    lists: [],
  };
  const imported = initialState(portal, {
    origin: "https://example.powerappsportals.com",
  });
  const store = await new DataStore({ state: imported }).init();
  assert.equal(
    imported.permissions.find((p) => p.id === "global").enabled,
    true,
  );
  assert.equal(
    imported.permissions.filter((p) => p.enabled === false).length,
    4,
  );
  assert.equal(imported.simulator.importDiagnostics.length, 4);
  assert.equal(
    store.snapshot().simulator.live.origin,
    "https://example.powerappsportals.com",
  );
  assert.deepEqual(
    store.query("accounts", {}, { roles: ["Member"] }).value,
    [],
  );
  assert.throws(
    () => store.query("contacts", {}, { roles: ["Member"] }),
    (e) => e.status === 403,
  );
  const broken = store.snapshot();
  broken.permissions.find((p) => p.id === "parent").enabled = true;
  await assert.rejects(store.replaceState(broken), DataError);
});
