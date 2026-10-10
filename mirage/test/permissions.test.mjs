import test from "node:test";
import assert from "node:assert/strict";
import {
  buildPermissionModel,
  resolvePortalIdentity,
  membershipsForRoles,
} from "../lib/permissions.mjs";
import { DataStore } from "../lib/data.mjs";

function fixture() {
  const names = [
    "Authenticated Users",
    "Anonymous Users",
    "Review Manager",
    "Review Coordinator",
    "Review Contributor",
    "Forms Competent Authority User",
  ];
  const roles = names.map((name, index) => ({
    kind: "webrole",
    id: "role-" + index,
    name,
    adx_authenticatedusersrole: index === 0,
    adx_anonymoususersrole: index === 1,
  }));
  const permission = (id, entity, scope, roleIds, extra = {}) => ({
    kind: "tablepermission",
    id,
    name: id,
    adx_entitylogicalname: entity,
    adx_scope: scope,
    adx_entitypermission_webrole: roleIds,
    adx_read: true,
    ...extra,
  });
  const records = [
    ...roles,
    permission(
      "company-own",
      "account",
      756150002,
      ["role-2", "role-3", "role-4"],
      { adx_accountrelationship: "account_identity", adx_appendto: true },
    ),
    permission("application-own", "application", 756150003, [], {
      adx_parententitypermission: "company-own",
      adx_parentrelationship: "application_company",
    }),
    permission(
      "application-edit",
      "application",
      756150003,
      ["role-2", "role-3"],
      {
        adx_parententitypermission: "company-own",
        adx_parentrelationship: "application_company",
        adx_create: true,
        adx_write: true,
        adx_delete: true,
        adx_append: true,
        adx_appendto: true,
      },
    ),
    permission("products-own", "product", 756150003, [], {
      adx_parententitypermission: "application-own",
      adx_parentrelationship: "product_application",
      adx_create: true,
      adx_write: true,
    }),
    permission("authority-app", "application", 756150000, ["role-5"]),
    permission("self-contact", "contact", 756150004, ["role-0"]),
  ];
  const state = {
    version: 1,
    mappings: Object.fromEntries(
      ["account", "contact", "application", "product"].map((entity) => [
        entity,
        { entitySet: entity + "s", idColumn: entity + "id", relationships: {} },
      ]),
    ),
    tables: {
      account: [
        { accountid: "helios", name: "Helios" },
        { accountid: "boreal", name: "Boreal" },
      ],
      contact: [
        {
          contactid: "alex",
          fullname: "Alex",
          parentcustomerid: { id: "helios", logical_name: "account" },
        },
        {
          contactid: "sam",
          fullname: "Sam",
          parentcustomerid: { id: "helios", logical_name: "account" },
        },
        {
          contactid: "blair",
          fullname: "Blair",
          parentcustomerid: { id: "boreal", logical_name: "account" },
        },
        {
          contactid: "casey",
          fullname: "Casey",
          parentcustomerid: { id: "authority", logical_name: "account" },
        },
      ],
      application: [
        { applicationid: "app-a", companyid: "helios", name: "Helios draft" },
        { applicationid: "app-b", companyid: "boreal", name: "Boreal draft" },
      ],
      product: [
        { productid: "p-a", applicationid: "app-a", name: "Helios product" },
        { productid: "p-b", applicationid: "app-b", name: "Boreal product" },
      ],
    },
    permissions: [],
    simulator: {
      identity: { contactId: "alex", roleSource: "memberships" },
      contactRoles: [
        { contactId: "alex", roleId: "role-2" },
        { contactId: "sam", roleId: "role-4" },
        { contactId: "blair", roleId: "role-3" },
        { contactId: "casey", roleId: "role-5" },
      ],
    },
    settings: { permissionMode: "enforce" },
  };
  const relationships = {
    account_identity: {
      type: "one-to-many",
      referencingEntity: "account",
      referencedEntity: "account",
      referencingAttribute: "accountid",
      referencedAttribute: "accountid",
    },
    application_company: {
      type: "one-to-many",
      referencingEntity: "application",
      referencedEntity: "account",
      referencingAttribute: "companyid",
      referencedAttribute: "accountid",
    },
    product_application: {
      type: "one-to-many",
      referencingEntity: "product",
      referencedEntity: "application",
      referencingAttribute: "applicationid",
      referencedAttribute: "applicationid",
    },
  };
  return { portal: { records }, state, relationships };
}

test("contact memberships use exported IDs/default flags and derive each company rather than old identity account", () => {
  const { portal, state } = fixture();
  state.simulator.identity.accountId = "wrong-company";
  const alex = resolvePortalIdentity(portal, state);
  assert.equal(alex.accountId, "helios");
  assert.deepEqual(alex.roles, [
    "Authenticated Users",
    "Review Manager",
  ]);
  const blair = resolvePortalIdentity(portal, state, {
    contactId: "blair",
    roleSource: "memberships",
    accountId: "helios",
  });
  assert.equal(blair.accountId, "boreal");
  assert.deepEqual(blair.roles, [
    "Authenticated Users",
    "Review Coordinator",
  ]);
  state.simulator.contactRoles.push({
    contactId: "blair",
    roleId: "missing-role",
  });
  assert.match(
    resolvePortalIdentity(portal, state, {
      contactId: "blair",
      roleSource: "memberships",
    }).diagnostics[0].message,
    /web role/,
  );
  assert.deepEqual(
    resolvePortalIdentity(portal, state, {
      contactId: "missing",
      roleSource: "memberships",
      roles: ["Review Manager"],
    }).roles,
    ["Anonymous Users"],
  );
  assert.deepEqual(
    resolvePortalIdentity(portal, state, {
      contactId: "alex",
      roleSource: "override",
      roles: ["Manual test role"],
    }).roles,
    ["Manual test role"],
  );
  assert.deepEqual(
    membershipsForRoles(portal, [
      { contactId: "alex", roles: ["Review Manager"] },
    ]),
    [{ contactId: "alex", roleId: "role-2" }],
  );
  assert.throws(
    () =>
      membershipsForRoles(portal, [
        { contactId: "alex", roles: ["Not exported"] },
      ]),
    /absent/,
  );
  const manual = resolvePortalIdentity(portal, state, {
    id: "alex",
    roleSource: "override",
    roles: ["Review Contributor"],
    roleIds: ["role-2"],
    admin: true,
  });
  assert.deepEqual(manual.roleIds, ["role-4"]);
  assert.equal(manual.admin, undefined);
  state.tables.contact[0].parentcustomerid = undefined;
  state.tables.contact[0]._parentcustomerid_value = "boreal";
  assert.equal(resolvePortalIdentity(portal, state).accountId, "boreal");
  state.tables.contact[0][
    "_parentcustomerid_value@Microsoft.Dynamics.CRM.lookuplogicalname"
  ] = "contact";
  assert.equal(resolvePortalIdentity(portal, state).accountId, null);
});

test("exported hierarchy compiles inherited role grants, scope metadata, append privileges and provenance", () => {
  const { portal, state, relationships } = fixture(),
    model = buildPermissionModel(portal, state, {
      relationships,
      source: "exported",
    });
  // The only observation: application-edit's own role links differ from its parent's.
  assert.deepEqual(
    model.diagnostics.map((d) => [d.code, d.id]),
    [["PERMISSION_CHILD_ROLES_INHERITED", "application-edit"]],
  );
  const products = model.permissions.find((rule) => rule.id === "products-own");
  assert.deepEqual(products.roles, [
    "Review Manager",
    "Review Coordinator",
    "Review Contributor",
  ]);
  assert.equal(products.inheritedRoles, true);
  assert.deepEqual(products.relationship, {
    entity: "application",
    from: "applicationid",
    to: "applicationid",
  });
  assert.deepEqual(
    model.permissions.find((rule) => rule.id === "application-edit").operations,
    ["read", "create", "update", "delete", "append", "appendTo"],
  );
  assert.equal(model.settings.associationPermissions, "enforce");
  assert.equal(
    model.tree.find((rule) => rule.id === "products-own").parentId,
    "application-own",
  );
  assert.equal(model.tree[0].provenance.type, "portal-export");
  assert.equal(model.personas.length, 4);
});

test("legacy imported bootstrap permissions without role IDs normalize from unambiguous exported roles", () => {
  const { portal, state, relationships } = fixture();
  // Evaluate the child's own links (opt-in) so role-name normalization stays observable.
  state.settings.childPermissionRoles = "intersect";
  state.permissions = buildPermissionModel(portal, state, {
    relationships,
    source: "exported",
  }).permissions;
  for (const rule of state.permissions) delete rule.roleIds;
  const model = buildPermissionModel(portal, state, {
    relationships,
    source: "configured",
  });
  assert.deepEqual(
    model.permissions.find((rule) => rule.id === "application-edit").roleIds,
    ["role-2", "role-3"],
  );
  assert.equal(
    model.permissions.find((rule) => rule.id === "application-edit").enabled,
    true,
  );
});

test("ambiguous legacy imported role names cannot fall back to name-based native grants", () => {
  const { portal, state, relationships } = fixture();
  portal.records.push({
    kind: "webrole",
    id: "other-manager",
    name: "Review Manager",
  });
  state.permissions = [
    {
      id: "legacy",
      entity: "application",
      scope: "global",
      operations: ["read"],
      roles: ["Review Manager"],
      imported: true,
    },
  ];
  const model = buildPermissionModel(portal, state, { relationships });
  assert.equal(model.permissions[0].enabled, false);
  assert.ok(
    model.diagnostics.some(
      (diagnostic) => diagnostic.code === "PERMISSION_ROLE_ID_UNRESOLVED",
    ),
  );
  const store = new DataStore({
    state: { ...state, permissions: model.permissions },
  });
  assert.equal(
    store.allowed(
      "application",
      "read",
      state.tables.application[1],
      resolvePortalIdentity(portal, state),
    ),
    false,
  );
  const malformed = new DataStore({
    state: {
      ...state,
      permissions: [
        {
          id: "raw-legacy",
          entity: "application",
          scope: "global",
          operations: ["read"],
          roles: ["Review Manager"],
          imported: true,
        },
      ],
    },
  });
  assert.equal(
    malformed.allowed(
      "application",
      "read",
      state.tables.application[1],
      resolvePortalIdentity(portal, state),
    ),
    false,
  );
});

test("missing alternative source role IDs do not revoke exact active associations", () => {
  const { portal, state, relationships } = fixture();
  portal.records.push({
    kind: "tablepermission",
    id: "category-mixed",
    name: "Category global",
    adx_entitylogicalname: "category",
    adx_scope: 756150000,
    adx_read: true,
    adx_entitypermission_webrole: ["role-2", "missing-role"],
  }, {
    kind: "tablepermission",
    id: "category-missing",
    adx_entitylogicalname: "category",
    adx_scope: 756150000,
    adx_read: true,
    adx_entitypermission_webrole: ["missing-role"],
  });
  state.tables.category = [{ categoryid: "public-help" }];
  state.mappings.category = { entitySet: "categories", idColumn: "categoryid" };
  const model = buildPermissionModel(portal, state, {
    relationships,
    source: "exported",
  });
  const mixed = model.permissions.find((rule) => rule.id === "category-mixed");
  assert.equal(mixed.enabled, true);
  assert.deepEqual(mixed.roleIds, ["role-2"]);
  assert.deepEqual(mixed.roles, ["Review Manager"]);
  assert.deepEqual(mixed.unresolvedRoleIds, ["missing-role"]);
  assert.equal(model.permissions.find((rule) => rule.id === "category-missing").enabled, false);
  assert.ok(model.diagnostics.some((entry) =>
    entry.id === mixed.id && entry.roleIds?.includes("missing-role")));
  const store = new DataStore({ state: { ...state, permissions: model.permissions } });
  assert.equal(store.allowed("category", "read", state.tables.category[0], resolvePortalIdentity(portal, state)), true);
  assert.equal(store.allowed("category", "read", state.tables.category[0], { roleSource: "memberships", roleIds: ["missing-role"], roles: ["Review Manager"] }), false);
  assert.equal(store.allowed("category", "read", state.tables.category[0], resolvePortalIdentity(portal, state, {contactId:"sam",roleSource:"memberships"})), false);
  const recompiled = buildPermissionModel(portal, {
    ...state,
    permissions: model.permissions.map(rule => rule.id === mixed.id ? {...rule, enabled:false, disabledReason:"Previous unresolved role association"} : rule),
  }, {relationships, source:"exported"});
  assert.equal(recompiled.permissions.find(rule => rule.id === mixed.id).enabled, true);
  assert.equal(recompiled.tree.find(rule => rule.id === mixed.id).disabledReason, undefined);
});

test("optional empty column profile defaults report inherited table operations in the applied source ledger", () => {
  const { portal, state, relationships } = fixture();
  portal.records.push({
    id: "profile",
    mspp_tablename: "application",
    mspp_columnpermissionprofile_webrole: ["role-2"],
    _file: "profile.yml",
  });
  const model = buildPermissionModel(portal, state, {
    relationships,
    source: "exported",
  });
  assert.deepEqual(
    model.diagnostics
      .filter(
        (diagnostic) =>
          diagnostic.code === "COLUMN_PERMISSION_DEFAULT_INHERITED",
      )
      .map(({ id, entity, file }) => ({ id, entity, file })),
    [{ id: "profile", entity: "application", file: "profile.yml" }],
  );
  portal.records.at(-1).mspp_allcolumnpermissions = [];
  assert.equal(
    buildPermissionModel(portal, state, {
      relationships,
      source: "exported",
    }).diagnostics.some(
      (diagnostic) => diagnostic.code === "COLUMN_PERMISSION_DEFAULT_INHERITED",
    ),
    false,
  );
});

test("child permissions inherit parent roles by default and their own links narrow access only when intersect is selected", async () => {
  const { portal, state, relationships } = fixture();
  const identity = (contactId) =>
    resolvePortalIdentity(portal, state, { contactId, roleSource: "memberships" });
  const compiled = () => {
    const model = buildPermissionModel(portal, state, { relationships, source: "exported" });
    state.permissions = model.permissions;
    return { model, store: new DataStore({ state: structuredClone(state) }) };
  };
  // Documented default: "Roles … are inherited from the parent table permission".
  let { model, store } = compiled();
  const edit = model.permissions.find((rule) => rule.id === "application-edit");
  assert.deepEqual(edit.roleIds, ["role-2", "role-3", "role-4"]);
  assert.deepEqual(edit.ownRoleIds, ["role-2", "role-3"]);
  assert.equal(edit.inheritedRoles, true);
  assert.equal(store.allowed("application", "update", state.tables.application[0], identity("sam")), true);
  // Opt-in alternative: only roles shared with the parent apply.
  state.settings.childPermissionRoles = "intersect";
  ({ model, store } = compiled());
  assert.deepEqual(model.permissions.find((rule) => rule.id === "application-edit").roleIds, ["role-2", "role-3"]);
  assert.equal(store.allowed("application", "update", state.tables.application[0], identity("sam")), false);
  assert.equal(store.allowed("application", "update", state.tables.application[0], identity("alex")), true);
  // A child role that is not on the parent never grants through it.
  portal.records.find((record) => record.id === "application-edit").adx_entitypermission_webrole = ["role-5"];
  ({ model } = compiled());
  const isolated = model.permissions.find((rule) => rule.id === "application-edit");
  assert.equal(isolated.enabled, false);
  assert.equal(isolated.disabledCode, "PERMISSION_CHILD_ROLES_UNAVAILABLE");
  assert.ok(model.diagnostics.some((d) => d.code === "PERMISSION_CHILD_ROLE_NOT_ON_PARENT" && d.id === "application-edit"));
});

test("manager/coordinator/contributor/authority scope rows consistently through API and joined Liquid FetchXML", async () => {
  const { portal, state, relationships } = fixture();
  // Per-role child grants (manager/coordinator edit) are evaluated with the opt-in mode.
  state.settings.childPermissionRoles = "intersect";
  const model = buildPermissionModel(portal, state, {
      relationships,
      source: "exported",
    });
  state.permissions = model.permissions;
  const store = new DataStore({ state });
  await store.ready;
  const identity = (contactId) =>
    resolvePortalIdentity(portal, state, {
      contactId,
      roleSource: "memberships",
    });
  for (const [person, app] of [
    ["alex", "app-a"],
    ["sam", "app-a"],
    ["blair", "app-b"],
  ]) {
    const query = await store.query(
      "application",
      new URLSearchParams(),
      identity(person),
    );
    assert.deepEqual(
      query.value.map((record) => record.applicationid),
      [app],
    );
    const xml = await store.fetchXml(
      '<fetch><entity name="application"><attribute name="applicationid"/><link-entity name="product" from="applicationid" to="applicationid"><attribute name="name"/></link-entity></entity></fetch>',
      identity(person),
    );
    assert.deepEqual(
      xml.entities.map((record) => record.applicationid),
      [app],
    );
  }
  assert.equal(
    (await store.query("application", new URLSearchParams(), identity("casey")))
      .value.length,
    2,
  );
  assert.equal(
    store.allowed(
      "application",
      "update",
      state.tables.application[0],
      identity("alex"),
    ),
    true,
  );
  assert.equal(
    store.allowed(
      "application",
      "update",
      state.tables.application[0],
      identity("sam"),
    ),
    false,
  );
  assert.equal(
    store.allowed(
      "product",
      "update",
      state.tables.product[0],
      identity("sam"),
    ),
    true,
  );
  assert.equal(
    store.allowed(
      "application",
      "update",
      state.tables.application[0],
      identity("casey"),
    ),
    false,
  );
  assert.equal(
    store.allowed(
      "application",
      "create",
      { companyid: "boreal" },
      identity("alex"),
    ),
    false,
  );
  assert.equal(
    store.allowed(
      "application",
      "create",
      { companyid: "helios" },
      identity("alex"),
    ),
    true,
  );
  assert.equal(
    store.allowed("contact", "read", state.tables.contact[0], identity("alex")),
    true,
  );
  assert.equal(
    store.allowed("contact", "read", state.tables.contact[1], identity("alex")),
    false,
  );
});

test("missing relationships, missing root roles, invalid child roles and parent cycles cannot broaden imported grants", () => {
  const { portal, state, relationships } = fixture();
  portal.records.push(
    {
      kind: "tablepermission",
      id: "cycle-a",
      adx_entitylogicalname: "application",
      adx_scope: 756150003,
      adx_parententitypermission: "cycle-b",
      adx_parentrelationship: "application_company",
      adx_read: true,
      adx_entitypermission_webrole: ["role-2"],
    },
    {
      kind: "tablepermission",
      id: "cycle-b",
      adx_entitylogicalname: "account",
      adx_scope: 756150003,
      adx_parententitypermission: "cycle-a",
      adx_parentrelationship: "application_company",
      adx_read: true,
      adx_entitypermission_webrole: ["role-2"],
    },
  );
  portal.records.find(
    (rule) => rule.id === "products-own",
  ).adx_entitypermission_webrole = ["role-5"];
  delete relationships.application_company;
  const model = buildPermissionModel(portal, state, {
    relationships,
    source: "exported",
  });
  assert.equal(
    model.permissions.find((rule) => rule.id === "application-edit").enabled,
    false,
  );
  assert.equal(
    model.permissions.find((rule) => rule.id === "products-own").enabled,
    false,
  );
  assert.equal(
    model.permissions.find((rule) => rule.id === "cycle-a").enabled,
    false,
  );
  assert.equal(
    model.permissions.find((rule) => rule.id === "cycle-b").enabled,
    false,
  );
  assert.ok(
    model.diagnostics.some((d) => d.code === "PERMISSION_PARENT_CYCLE"),
  );
  state.permissions = [
    {
      id: "explicit-local",
      entity: "product",
      roles: ["Local tester"],
      scope: "global",
      operations: ["read"],
    },
  ];
  const combined = buildPermissionModel(portal, state, {
    relationships,
    source: "combined",
  });
  assert.equal(
    combined.permissions.at(-1).provenance.type,
    "local-configuration",
  );
  assert.equal(state.permissions.length, 1);
});

test("editable local parent grants also reject missing parents, cycles and wrong parent table mappings", () => {
  const { portal, state } = fixture();
  state.permissions = [
    {
      id: "local-a",
      entity: "application",
      scope: "parent",
      roles: ["Review Manager"],
      operations: ["read"],
      parentPermissionId: "local-b",
      relationship: { entity: "account", from: "companyid", to: "accountid" },
    },
    {
      id: "local-b",
      entity: "account",
      scope: "parent",
      roles: ["Review Manager"],
      operations: ["read"],
      parentPermissionId: "local-a",
      relationship: {
        entity: "application",
        from: "accountid",
        to: "companyid",
      },
    },
    {
      id: "missing",
      entity: "product",
      scope: "parent",
      roles: [],
      operations: ["read"],
      relationship: {
        entity: "application",
        from: "applicationid",
        to: "applicationid",
      },
    },
    {
      id: "global",
      entity: "account",
      scope: "global",
      roles: ["Review Manager"],
      operations: ["read"],
    },
    {
      id: "wrong-target",
      entity: "product",
      scope: "parent",
      roles: [],
      operations: ["read"],
      parentPermissionId: "global",
      relationship: { entity: "contact", from: "ownerid", to: "contactid" },
    },
  ];
  const model = buildPermissionModel(portal, state);
  for (const key of ["local-a", "local-b", "missing", "wrong-target"])
    assert.equal(
      model.permissions.find((rule) => rule.id === key).enabled,
      false,
      key,
    );
  assert.equal(
    model.permissions.find((rule) => rule.id === "global").enabled,
    undefined,
  );
  assert.equal(state.permissions[0].enabled, undefined);
});

test("exported source switching cannot reuse a scoped mapping from deselected solution metadata", () => {
  const { portal, state, relationships } = fixture();
  const first = buildPermissionModel(portal, state, {
    relationships,
    source: "exported",
  });
  state.permissions = first.permissions;
  const next = buildPermissionModel(portal, state, {
    relationships: {},
    source: "exported",
  });
  assert.equal(
    next.permissions.find((rule) => rule.id === "application-own").enabled,
    false,
  );
  assert.equal(
    next.permissions.find((rule) => rule.id === "application-own").relationship,
    undefined,
  );
  assert.equal(
    next.permissions.find((rule) => rule.id === "company-own").enabled,
    false,
  );
});

test("duplicate source IDs are disabled rather than leaving an uncompiled duplicate parent grant active", () => {
  const { portal, state, relationships } = fixture();
  portal.records.push({
    ...portal.records.find((record) => record.id === "products-own"),
    _file: "another-source.yml",
  });
  const model = buildPermissionModel(portal, state, {
    relationships,
    source: "exported",
  });
  const duplicates = model.permissions.filter(
    (rule) => rule.id === "products-own",
  );
  assert.equal(duplicates.length, 2);
  assert.ok(duplicates.every((rule) => rule.enabled === false));
  assert.ok(
    model.diagnostics.some((item) => item.code === "PERMISSION_ID_AMBIGUOUS"),
  );
  const store = new DataStore({
    state: { ...state, permissions: model.permissions },
  });
  assert.equal(
    store
      .snapshot()
      .permissions.filter((rule) => rule.id === "products-own")
      .every((rule) => rule.enabled === false),
    true,
  );
});
