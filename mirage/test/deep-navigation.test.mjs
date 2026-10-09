import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DataError, DataStore } from "../lib/data.mjs";
import { importSolutionData } from "../lib/solution-data.mjs";

const entity = (name) =>
  `<Entity><Name>${name}</Name><EntityInfo><entity Name="${name}"><attributes><attribute PhysicalName="${name}Id"><Type>primarykey</Type><LogicalName>${name}id</LogicalName></attribute><attribute PhysicalName="name"><Type>nvarchar</Type><LogicalName>name</LogicalName></attribute><attribute PhysicalName="parentid"><Type>lookup</Type><LogicalName>parentid</LogicalName></attribute><attribute PhysicalName="ownerid"><Type>lookup</Type><LogicalName>ownerid</LogicalName></attribute></attributes><EntitySetName>${name}s</EntitySetName></entity></EntityInfo></Entity>`;
const relationship = (child, parent) => {
  const schema = `${parent}_${child}`;
  return `<EntityRelationship Name="${schema}"><EntityRelationshipType>OneToMany</EntityRelationshipType><ReferencingEntityName>${child}</ReferencingEntityName><ReferencedEntityName>${parent}</ReferencedEntityName><ReferencingAttributeName>parentid</ReferencingAttributeName><EntityRelationshipRoles><EntityRelationshipRole><RelationshipRoleType>1</RelationshipRoleType><NavigationPropertyName>parentid</NavigationPropertyName></EntityRelationshipRole><EntityRelationshipRole><RelationshipRoleType>0</RelationshipRoleType><NavigationPropertyName>${schema}</NavigationPropertyName></EntityRelationshipRole></EntityRelationship>`;
};

test("metadata-derived 27-table graph supports 16-level navigation with deepest scope filtering", async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pp-deep-metadata-"));
  try {
    const names = Array.from({ length: 27 }, (_, i) =>
      `fixture_level${String(i).padStart(2, "0")}`,
    );
    const metadataFile = join(root, "customizations.xml");
    await fs.writeFile(
      metadataFile,
      `<ImportExportXml><Entities>${names.map(entity).join("")}</Entities><EntityRelationships>${names
        .slice(1)
        .map((name, i) => relationship(name, names[i]))
        .join("")}</EntityRelationships></ImportExportXml>`,
    );
    const imported = await importSolutionData([metadataFile]);
    assert.equal(Object.keys(imported.mappings).length, 27);
    const tables = Object.fromEntries(
      names.map((name, i) => [
        name,
        [
          {
            [`${name}id`]: `row-${i}`,
            name: i === 0 ? "root" : `level-${i}`,
            ...(i ? { parentid: `row-${i - 1}` } : {}),
            ...([15, 16].includes(i) ? { ownerid: "contact-1" } : {}),
          },
        ],
      ]),
    );
    tables[names[15]].push({
      [`${names[15]}id`]: "hidden-terminal",
      name: "hidden",
      parentid: "row-14",
      ownerid: "contact-2",
    });
    const permissions = names.map((entity) => ({
      entity,
      roles: ["Member"],
      scope: "global",
      operations: ["read"],
    }));
    for (const level of [15, 16])
      permissions[level] = {
        entity: names[level],
        roles: ["Member"],
        scope: "contact",
        field: "ownerid",
        operations: ["read"],
      };
    const store = await new DataStore({
      state: {
        mappings: imported.mappings,
        tables,
        permissions,
        settings: { permissionMode: "enforce" },
      },
    }).init();
    const user = { roles: ["Member"], contactId: "contact-1" };

    // Child-to-parent navigation walks sixteen metadata-imported lookups.
    const path = Array(16).fill("parentid").join("/");
    const odata = store.query(names[16], {
      $filter: `${path}/name eq 'root'`,
    }, user);
    assert.deepEqual(odata.value.map((row) => row[`${names[16]}id`]), ["row-16"]);
    assert.ok(!JSON.stringify(odata).includes("hidden-terminal"));

    // FetchXML follows fifteen joins, Dataverse's documented query limit. The
    // linked terminal table is filtered by its permission before joining.
    let nested = '<attribute name="name" alias="terminalname" />';
    for (let i = 15; i >= 1; i--) {
      nested = `<link-entity name="${names[i]}" from="parentid" to="${names[i - 1]}id" alias="l${i}">${nested}</link-entity>`;
    }
    const xml = `<fetch><entity name="${names[0]}"><attribute name="${names[0]}id" />${nested}</entity></fetch>`;
    const fetched = store.fetchXml(xml, user).entities;
    assert.deepEqual(fetched, [{ [`${names[0]}id`]: "row-0", terminalname: "level-15" }]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("deep navigation cycles and recursive FetchXML are bounded", async () => {
  const state = {
    mappings: {
      a: { idColumn: "aid", entitySet: "as", relationships: { b: { entity: "b", from: "aid", to: "aid", many: false } } },
      b: { idColumn: "bid", entitySet: "bs", relationships: { a: { entity: "a", from: "bid", to: "bid", many: false } } },
    },
    tables: { a: [{ aid: "a1", bid: "b1" }], b: [{ bid: "b1", aid: "a1" }] },
    settings: { permissionMode: "permissive" },
  };
  const store = await new DataStore({ state }).init();
  const path = Array.from({ length: 33 }, (_, i) => (i % 2 ? "a" : "b")).join("/");
  assert.throws(
    () => store.query("a", { $filter: `${path}/aid eq 'a1'` }),
    (error) => error instanceof DataError && error.code === "UnsupportedQuery",
  );

  const deepFilter = `<fetch>${"<entity>".repeat(63)}${"</entity>".repeat(63)}</fetch>`;
  assert.throws(
    () => store.fetchXml(deepFilter),
    (error) => error instanceof DataError && error.code === "UnsupportedQuery",
  );
  const deepLinks = `<fetch><entity name="a">${Array.from(
    { length: 16 },
    (_, i) => `<link-entity name="unknown${i}" from="x" to="x">`,
  ).join("")}${"</link-entity>".repeat(16)}</entity></fetch>`;
  assert.throws(
    () => store.fetchXml(deepLinks),
    (error) => error instanceof DataError && error.code === "UnsupportedQuery",
  );
});
