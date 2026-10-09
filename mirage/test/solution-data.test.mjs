import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { deflateRawSync } from "node:zlib";
import {
  importSolutionData,
  applySolutionData,
  readSolutionZip,
} from "../lib/solution-data.mjs";
import { DataStore } from "../lib/data.mjs";

const entity = (name, set = name + "s") =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><attributes><attribute PhysicalName="${name}Id"><Type>primarykey</Type><LogicalName>${name}id</LogicalName></attribute><attribute PhysicalName="name"><Type>nvarchar</Type><LogicalName>name</LogicalName><DisplayMask>PrimaryName|ValidForForm</DisplayMask></attribute></attributes><EntitySetName>${set}</EntitySetName></entity></EntityInfo></Entity>`;
const relationship = (schema, child, parent, lookup) =>
  `<EntityRelationship Name="${schema}"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>${child}</ReferencingEntityName><ReferencedEntityName>${parent}</ReferencedEntityName><ReferencingAttributeName>${lookup}</ReferencingAttributeName><EntityRelationshipRoles><EntityRelationshipRole><RelationshipRoleType>1</RelationshipRoleType><NavigationPropertyName>${lookup}</NavigationPropertyName></EntityRelationshipRole><EntityRelationshipRole><RelationshipRoleType>0</RelationshipRoleType><NavigationPropertyName>${schema}</NavigationPropertyName></EntityRelationshipRole></EntityRelationshipRoles></EntityRelationship>`;
function zipXml(name, xml) {
  const source = Buffer.from(xml),
    compressed = deflateRawSync(source),
    filename = Buffer.from(name),
    local = Buffer.alloc(30),
    central = Buffer.alloc(46),
    end = Buffer.alloc(22);
  local.writeUInt32LE(0x04034b50);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(source.length, 22);
  local.writeUInt16LE(filename.length, 26);
  central.writeUInt32LE(0x02014b50);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(source.length, 24);
  central.writeUInt16LE(filename.length, 28);
  const first = Buffer.concat([local, filename, compressed]),
    directory = Buffer.concat([central, filename]);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(first.length, 16);
  return Buffer.concat([first, directory, end]);
}

test("solution XML imports exact sets, primary columns, navigation names and layered partial patches", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pp-solutions-"));
  try {
    const base = join(root, "base.xml"),
      patch = join(root, "patch.xml");
    await fs.writeFile(
      base,
      `<ImportExportXml><Entities>${entity("sample_item", "sample_items_exact")}${entity("contact")}</Entities><EntityRelationships>${relationship("contact_items", "sample_item", "contact", "sample_contact")}</EntityRelationships></ImportExportXml>`,
    );
    await fs.writeFile(
      patch,
      '<Entities><Entity><Name>sample_item</Name><EntityInfo><entity Name="sample_item"><attributes><attribute><LogicalName>sample_extra</LogicalName><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity></Entities>',
    );
    const result = await importSolutionData([base, patch]);
    assert.equal(result.mappings.sample_item.entitySet, "sample_items_exact");
    assert.equal(result.mappings.sample_item.idColumn, "sample_itemid");
    assert.equal(result.mappings.sample_item.nameColumn, "name");
    assert.equal(result.mappings.sample_item.inferred, false);
    assert.equal(
      result.mappings.sample_item.relationships.sample_contact.entity,
      "contact",
    );
    assert.equal(
      result.mappings.contact.relationships.contact_items.many,
      true,
    );
    assert.equal(result.mappings.sample_item.metadataSources.length, 2);
    assert.match(result.fingerprint, /^[a-f0-9]{64}$/);
    const unchanged = await importSolutionData([base, patch]);
    assert.equal(unchanged.fingerprint, result.fingerprint);
    await fs.appendFile(patch, "<!--changed-->");
    assert.notEqual(
      (await importSolutionData([base, patch])).fingerprint,
      result.fingerprint,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("permission relationship metadata resolves scoped access, inherits parent roles and preserves manual mapping choices", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pp-solution-perm-"));
  try {
    const file = join(root, "customizations.xml");
    await fs.writeFile(
      file,
      `<ImportExportXml>${entity("contact")}${entity("sample_parent")}${entity("sample_child")}<EntityRelationships>${relationship("contact_parent", "sample_parent", "contact", "ownercontact")}${relationship("parent_child", "sample_child", "sample_parent", "parentid")}</EntityRelationships></ImportExportXml>`,
    );
    const metadata = await importSolutionData([file]);
    const state = {
      mappings: {
        contact: {
          entitySet: "contacts",
          idColumn: "contactid",
          inferred: true,
        },
        sample_parent: {
          entitySet: "sample_parents",
          idColumn: "sample_parentid",
          inferred: true,
        },
        sample_child: {
          entitySet: "CUSTOM_CHILDS",
          idColumn: "sample_childid",
          userConfigured: true,
        },
      },
      tables: {
        contact: [{ contactid: "c1" }],
        sample_parent: [
          { sample_parentid: "p1", ownercontact: "c1" },
          { sample_parentid: "p2", ownercontact: "c2" },
        ],
        sample_child: [
          { sample_childid: "one", parentid: "p1" },
          { sample_childid: "two", parentid: "p2" },
        ],
      },
      permissions: [
        {
          id: "parent",
          entity: "sample_parent",
          scope: "contact",
          relationshipName: "contact_parent",
          roles: ["Member"],
          operations: ["read"],
          imported: true,
          enabled: false,
        },
        {
          id: "child",
          entity: "sample_child",
          scope: "parent",
          relationshipName: "parent_child",
          parentPermissionId: "parent",
          roles: [],
          operations: ["read", "update"],
          imported: true,
          enabled: false,
        },
      ],
      simulator: {
        importDiagnostics: [
          { id: "parent", code: "PERMISSION_MAPPING_REQUIRED" },
          { id: "child", code: "PERMISSION_MAPPING_REQUIRED" },
        ],
      },
      presets: {
        demo: {
          mappings: {
            sample_parent: {
              inferred: true,
              entitySet: "wrong",
              idColumn: "wrong",
            },
          },
        },
      },
    };
    const resolved = applySolutionData(state, metadata);
    assert.equal(resolved.mappings.sample_child.entitySet, "CUSTOM_CHILDS");
    assert.equal(resolved.permissions[0].field, "ownercontact");
    assert.equal(resolved.permissions[1].enabled, true);
    assert.deepEqual(resolved.permissions[1].roles, ["Member"]);
    assert.equal(resolved.simulator.importDiagnostics.length, 0);
    assert.equal(
      resolved.presets.demo.mappings.sample_parent.entitySet,
      "sample_parents",
    );
    const store = new DataStore({ state: resolved });
    const user = { contactId: "c1", roles: ["Member"] };
    assert.equal(store.query("sample_child", {}, user).value.length, 1);
    await store.update(
      "sample_child",
      "one",
      { name: "allowed via read-only parent" },
      user,
    );
    await assert.rejects(
      store.update("sample_child", "two", { name: "forbidden" }, user),
      (e) => e.status === 403,
    );
    const removed = applySolutionData(resolved, {
      ...metadata,
      relationships: {},
    });
    assert.equal(
      removed.permissions.every((p) => p.enabled === false),
      true,
    );
    assert.equal(
      removed.simulator.importDiagnostics.filter(
        (d) => d.code === "PERMISSION_MAPPING_REQUIRED",
      ).length,
      2,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("replacing imported permissions with a mock preset clears obsolete permission diagnostics", async () => {
  const store = new DataStore({
    state: {
      mappings: { contact: { entitySet: "contacts", idColumn: "contactid" } },
      tables: { contact: [] },
      permissions: [
        {
          id: "exported",
          entity: "contact",
          scope: "contact",
          enabled: false,
          imported: true,
          disabledReason: "missing relation",
          roles: ["Member"],
          operations: ["read"],
        },
      ],
      simulator: {
        importDiagnostics: [
          {
            id: "exported",
            code: "PERMISSION_MAPPING_REQUIRED",
            message: "old export relation",
          },
          {
            id: "no-longer-present",
            code: "PERMISSION_MAPPING_REQUIRED",
            message: "obsolete",
          },
          { code: "UNRELATED_IMPORT_DIAGNOSTIC", message: "keep this" },
        ],
      },
    },
  });
  assert.equal(store.snapshot().simulator.importDiagnostics.length, 2);
  await store.applyPreset("contact-demo");
  assert.deepEqual(store.snapshot().simulator.importDiagnostics, [
    { code: "UNRELATED_IMPORT_DIAGNOSTIC", message: "keep this" },
  ]);
  assert.equal(
    store.snapshot().tables.contact[0].contactid,
    "11111111-1111-1111-1111-111111111111",
  );
});

test("standard reverse contact/customer scope follows only the selected identity record", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pp-solution-reverse-"));
  try {
    const file = join(root, "customizations.xml");
    await fs.writeFile(
      file,
      `<ImportExportXml>${entity("account")}${entity("contact")}</ImportExportXml>`,
    );
    const metadata = await importSolutionData([file]);
    const state = {
      mappings: {
        account: {
          entitySet: "accounts",
          idColumn: "accountid",
          inferred: true,
        },
        contact: {
          entitySet: "contacts",
          idColumn: "contactid",
          inferred: true,
        },
      },
      tables: {
        account: [{ accountid: "a1" }, { accountid: "a2" }],
        contact: [
          { contactid: "c1", parentcustomerid: "a1" },
          { contactid: "c2", parentcustomerid: "a2" },
        ],
      },
      permissions: [
        {
          id: "permission",
          entity: "account",
          scope: "contact",
          relationshipName: "contact_customer_accounts",
          roles: ["Member"],
          operations: ["read"],
          imported: true,
          enabled: false,
        },
      ],
    };
    const resolved = applySolutionData(state, metadata);
    const store = new DataStore({ state: resolved });
    assert.deepEqual(
      store.query("accounts", {}, { contactId: "c1", roles: ["Member"] }).value,
      [{ accountid: "a1" }],
    );
    assert.equal(
      metadata.relationships.contact_customer_accounts.standardFallback,
      true,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("solution ZIP is parsed in memory and rejects traversal or invalid archives", async () => {
  const archive = zipXml(
    "customizations.xml",
    `<ImportExportXml>${entity("sample_zip", "sample_zip_records")}</ImportExportXml>`,
  );
  assert.equal(readSolutionZip(archive)[0].name, "customizations.xml");
  assert.throws(
    () => readSolutionZip(zipXml("../customizations.xml", "<root/>")),
    /traversal/,
  );
  assert.throws(() => readSolutionZip(Buffer.from("not a zip")));
  const root = await fs.mkdtemp(join(tmpdir(), "pp-solution-zip-"));
  try {
    const file = join(root, "solution.zip");
    await fs.writeFile(file, archive);
    const metadata = await importSolutionData([file]);
    assert.equal(metadata.mappings.sample_zip.entitySet, "sample_zip_records");
    assert.equal(metadata.stats.exactPrimaryIds, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Self-referencing many-to-many XML retains distinct structural sides and first association direction", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pp-self-many-"));
  try {
    const file = join(root, "Relationships.xml");
    await fs.writeFile(
      file,
      '<EntityRelationships><EntityRelationship Name="term_related"><EntityRelationshipType>ManyToMany</EntityRelationshipType><FirstEntityName>term</FirstEntityName><SecondEntityName>term</SecondEntityName><IntersectEntityName>term_related</IntersectEntityName><EntityRelationshipRoles><EntityRelationshipRole><NavigationPropertyName>term_related</NavigationPropertyName><AssociationRoleOrdinal>1</AssociationRoleOrdinal></EntityRelationshipRole><EntityRelationshipRole><NavigationPropertyName>term_related</NavigationPropertyName><AssociationRoleOrdinal>2</AssociationRoleOrdinal></EntityRelationshipRole></EntityRelationshipRoles></EntityRelationship></EntityRelationships>',
    );
    const metadata = await importSolutionData([file]);
    assert.deepEqual(
      metadata.mappings.term.relationships.term_related.intersect,
      { entity: "term_related", from: "termidone", to: "termidtwo" },
    );
    const store = await new DataStore({
      state: {
        mappings: metadata.mappings,
        tables: {
          term: [{ termid: "country" }, { termid: "group" }],
          term_related: [{ termidone: "country", termidtwo: "group" }],
        },
        permissions: [{ entity: "term", roles: ["Member"], scope: "global" }],
      },
    }).init();
    const rows = store.fetchXml(
      '<fetch><entity name="term"><attribute name="termid"/><link-entity name="term_related" from="termidone" to="termid"><link-entity name="term" from="termid" to="termidtwo"><attribute name="termid" alias="group"/></link-entity></link-entity></entity></fetch>',
      { roles: ["Member"] },
    ).entities;
    assert.deepEqual(rows, [{ termid: "country", group: "group" }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("many-to-many exports produce usable intersection relationship mappings and scoped expansions", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pp-solution-many-"));
  try {
    const file = join(root, "Relationships.xml");
    await fs.writeFile(
      file,
      '<EntityRelationships><EntityRelationship Name="sample_one_two"><EntityRelationshipType>ManyToMany</EntityRelationshipType><FirstEntityName>sample_one</FirstEntityName><SecondEntityName>sample_two</SecondEntityName><IntersectEntityName>sample_one_two</IntersectEntityName></EntityRelationship></EntityRelationships>',
    );
    const metadata = await importSolutionData([file]);
    assert.deepEqual(
      metadata.mappings.sample_one.relationships.sample_one_two.intersect,
      { entity: "sample_one_two", from: "sample_oneid", to: "sample_twoid" },
    );
    assert.equal(metadata.relationships.sample_one_two.type, "many-to-many");
    const store = new DataStore({
      state: {
        mappings: metadata.mappings,
        tables: {
          sample_one: [{ sample_oneid: "one" }],
          sample_two: [{ sample_twoid: "first" }, { sample_twoid: "second" }],
          sample_one_two: [{ sample_oneid: "one", sample_twoid: "second" }],
        },
        permissions: [
          {
            entity: "sample_one",
            scope: "global",
            operations: ["read"],
            roles: ["Member"],
          },
          {
            entity: "sample_two",
            scope: "global",
            operations: ["read"],
            roles: ["Member"],
          },
        ],
      },
    });
    assert.deepEqual(
      store.query("sample_one", { $expand: "sample_one_two" }, { roles: ["Member"] })
        .value[0].sample_one_two,
      [{ sample_twoid: "second" }],
    );
    assert.throws(
      () => store.query("sample_one_two", {}, { roles: ["Member"] }),
      (e) => e.status === 403,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("exported account, contact (many-to-many) and parent grants resolve through solution and documented relationships", async () => {
  const { buildPermissionModel } = await import("../lib/permissions.mjs");
  const root = await fs.mkdtemp(join(tmpdir(), "pp-solution-scopes-"));
  try {
    const file = join(root, "customizations.xml");
    const many = (schema, first, second) =>
      `<EntityRelationship Name="${schema}"><EntityRelationshipType>ManyToMany</EntityRelationshipType><FirstEntityName>${first}</FirstEntityName><SecondEntityName>${second}</SecondEntityName><IntersectEntityName>${schema}</IntersectEntityName></EntityRelationship>`;
    await fs.writeFile(
      file,
      `<ImportExportXml><Entities>${entity("account")}${entity("contact")}${entity("sample_case")}${entity("sample_note")}${entity("knowledgearticle")}${entity("annotation")}</Entities><EntityRelationships>${relationship("sample_case_account", "sample_case", "account", "sample_account")}${many("sample_case_contact", "sample_case", "contact")}${many("sample_note_case", "sample_note", "sample_case")}</EntityRelationships></ImportExportXml>`,
    );
    const metadata = await importSolutionData([file]);
    assert.equal(metadata.relationships.knowledgearticle_annotations.standardFallback, true);
    const grant = (id, entity, scope, extra = {}) => ({ kind: "tablepermission", id, name: id, adx_entitylogicalname: entity, adx_scope: scope, adx_read: true, ...extra });
    const portal = {
      records: [
        { kind: "webrole", id: "member", name: "Member" },
        grant("by-account", "sample_case", 756150002, { adx_accountrelationship: "sample_case_account", adx_entitypermission_webrole: ["member"] }),
        grant("by-contact", "sample_case", 756150001, { adx_contactrelationship: "sample_case_contact", adx_entitypermission_webrole: ["member"] }),
        grant("notes", "sample_note", 756150003, { adx_parententitypermission: "by-contact", adx_parentrelationship: "sample_note_case" }),
        grant("articles", "knowledgearticle", 756150000, { adx_entitypermission_webrole: ["member"] }),
        grant("article-notes", "annotation", 756150003, { adx_parententitypermission: "articles", adx_parentrelationship: "knowledgearticle_Annotations" }),
      ],
    };
    const state = {
      mappings: metadata.mappings,
      tables: {
        account: [{ accountid: "a1" }],
        contact: [{ contactid: "c1", parentcustomerid: { id: "a1", logical_name: "account" } }],
        sample_case: [{ sample_caseid: "mine", sample_account: "a1" }, { sample_caseid: "shared" }, { sample_caseid: "other", sample_account: "a2" }],
        sample_case_contact: [{ sample_caseid: "shared", contactid: "c1" }],
        sample_note: [{ sample_noteid: "n-shared" }, { sample_noteid: "n-other" }],
        sample_note_case: [{ sample_noteid: "n-shared", sample_caseid: "shared" }, { sample_noteid: "n-other", sample_caseid: "other" }],
        knowledgearticle: [{ knowledgearticleid: "k1" }],
        annotation: [{ annotationid: "note-k1", objectid: "k1" }, { annotationid: "orphan" }],
      },
      permissions: [],
      settings: { permissionMode: "enforce" },
      simulator: { permissionSource: "exported" },
    };
    const model = buildPermissionModel(portal, state, { relationships: metadata.relationships });
    assert.deepEqual(model.permissions.filter((p) => p.enabled === false), []);
    assert.equal(model.permissions.find((p) => p.id === "by-account").field, "sample_account");
    assert.deepEqual(model.permissions.find((p) => p.id === "by-contact").identityRelationship.intersect, { entity: "sample_case_contact", from: "sample_caseid", to: "contactid" });
    const store = new DataStore({ state: { ...state, permissions: model.permissions } });
    const identity = { id: "c1", contactId: "c1", accountId: "a1", roles: ["Member"] };
    const ids = (entity, key) => store.rows(entity, identity).map((row) => row[key]).sort();
    assert.deepEqual(ids("sample_case", "sample_caseid"), ["mine", "shared"]);
    assert.deepEqual(ids("sample_note", "sample_noteid"), ["n-shared"]);
    assert.deepEqual(ids("annotation", "annotationid"), ["note-k1"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
