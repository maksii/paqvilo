// Member completeness of the Web API metadata JSON: relationship metadata (RelationshipMetadataBase and its two derived types)
// and synthesized AttributeMetadata managed properties, over the invented fixture of dataverse-metadata.test.mjs.
// Member lists follow Microsoft Learn (RelationshipMetadataBase, OneToManyRelationshipMetadata, ManyToManyRelationshipMetadata)
// and the native capture the parity toolkit recorded (names only, no private values).
import test from "node:test";
import assert from "node:assert/strict";
import { attributeMetadata } from "../lib/attribute-metadata.mjs";
import { createMetadataService } from "../lib/dataverse-metadata.mjs";
import { dataverseError } from "../lib/dataverse-odata.mjs";
import { MANAGED_MEMBERS } from "../lib/dataverse-soap-contracts.mjs";

const ORG = "5f0c2c1e-1d2b-4c3a-9a7e-0123456789ab";

const MAPPINGS = {
  widget: {
    entitySet: "widgets",
    idColumn: "widgetid",
    nameColumn: "name",
    label: "Widget",
    fields: {
      name: { dataverseType: "nvarchar", maxLength: 100, label: "Name" },
      made: { dataverseType: "datetime", dateTimeBehavior: "UserLocal", label: "Made" },
    },
    relationships: {
      gadgets: { entity: "gadget", from: "widgetid", to: "widgetid", many: true, schemaName: "widget_gadgets", partner: "widget" },
      tags: {
        entity: "tag", from: "widgetid", to: "tagid", many: true, schemaName: "widget_tags",
        intersect: { entity: "widget_tag", from: "widgetid", to: "tagid" },
      },
    },
  },
  gadget: {
    entitySet: "gadgets",
    idColumn: "gadgetid",
    nameColumn: "name",
    fields: { name: { dataverseType: "nvarchar" }, widgetid: { dataverseType: "lookup", targets: ["widget"], label: "Widget" } },
    relationships: {
      widget: { entity: "widget", from: "widgetid", to: "widgetid", many: false, schemaName: "widget_gadgets", partner: "gadgets" },
    },
  },
  tag: { entitySet: "tags", idColumn: "tagid", nameColumn: "name", fields: { name: { dataverseType: "nvarchar" } } },
};

// Members of RelationshipMetadataBase (Learn), plus MetadataId and HasChanged from MetadataBase.
const BASE_MEMBERS = ["HasChanged", "IntroducedVersion", "IsCustomRelationship", "IsCustomizable", "IsManaged", "IsValidForAdvancedFind", "MetadataId", "RelationshipType", "SchemaName", "SecurityTypes"];
const ONE_TO_MANY_MEMBERS = [
  "AssociatedMenuConfiguration", "CascadeConfiguration", "DenormalizedAttributeName", "EntityKey", "IsDenormalizedLookup", "IsHierarchical",
  "IsRelationshipAttributeDenormalized", "RelationshipAttributes", "RelationshipBehavior", "ReferencedAttribute", "ReferencedEntity",
  "ReferencedEntityNavigationPropertyName", "ReferencingAttribute", "ReferencingEntity", "ReferencingEntityNavigationPropertyName",
];
const MANY_TO_MANY_MEMBERS = [
  "Entity1AssociatedMenuConfiguration", "Entity1IntersectAttribute", "Entity1LogicalName", "Entity1NavigationPropertyName",
  "Entity2AssociatedMenuConfiguration", "Entity2IntersectAttribute", "Entity2LogicalName", "Entity2NavigationPropertyName", "IntersectEntityName",
];
const keysOf = (object) => Object.keys(object).filter((key) => key !== "@odata.type").sort();
const sorted = (list) => [...list].sort();

const mapped = createMetadataService({ organizationId: ORG, schema: () => null, mappings: () => MAPPINGS });

test("a one-to-many relationship carries the RelationshipMetadataBase and OneToManyRelationshipMetadata members", () => {
  const [collection] = mapped.oneToMany("widget");
  assert.equal(collection["@odata.type"], "#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata");
  assert.deepEqual(keysOf(collection), sorted([...BASE_MEMBERS, ...ONE_TO_MANY_MEMBERS]));
  assert.equal(collection.SecurityTypes, "None");
  assert.equal(collection.RelationshipBehavior, 0);
  assert.equal(collection.RelationshipType, "OneToManyRelationship");
  assert.equal(collection.IsCustomRelationship, false, "a non-prefixed lookup is a system relationship");
  assert.equal(collection.IsValidForAdvancedFind, true);
  assert.deepEqual(collection.IsCustomizable, { Value: true, CanBeChanged: true, ManagedPropertyLogicalName: "iscustomizable" });
  assert.deepEqual(collection.RelationshipAttributes, []);
  assert.equal(collection.AssociatedMenuConfiguration.Behavior, "DoNotDisplay");
  assert.equal(collection.CascadeConfiguration.Archive, "NoCascade");
});

test("a relationship mapping that names a RelationshipBehavior sets SecurityTypes by the observed pairs (2 is ParentChild)", () => {
  const withBehavior = structuredClone(MAPPINGS);
  withBehavior.gadget.relationships.widget.relationshipBehavior = 2;
  const service = createMetadataService({ organizationId: ORG, schema: () => null, mappings: () => withBehavior });
  const [lookup] = service.manyToOne("gadget");
  assert.equal(lookup.RelationshipBehavior, 2);
  assert.equal(lookup.SecurityTypes, "ParentChild");
});

test("a many-to-many relationship carries the RelationshipMetadataBase and ManyToManyRelationshipMetadata members, no behavior", () => {
  const [intersect] = mapped.manyToMany("widget");
  assert.equal(intersect["@odata.type"], "#Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata");
  assert.deepEqual(keysOf(intersect), sorted([...BASE_MEMBERS, ...MANY_TO_MANY_MEMBERS]));
  assert.equal(intersect.RelationshipType, "ManyToManyRelationship");
  assert.equal(intersect.SecurityTypes, "None");
  assert.equal(intersect.IsCustomRelationship, true, "the intersect name carries a table prefix, which the custom rule reads as custom");
  assert.equal(intersect.Entity1AssociatedMenuConfiguration.Behavior, "DoNotDisplay");
  assert.equal(intersect.Entity2AssociatedMenuConfiguration.Behavior, "DoNotDisplay");
});

test("an uncast RelationshipDefinitions item is typed RelationshipMetadataBase: exactly its ten members", () => {
  assert.ok(mapped.relationships().length > 0);
  for (const r of mapped.relationships()) assert.deepEqual(Object.keys(r).sort(), sorted(BASE_MEMBERS));
  const base = mapped.relationships().find((r) => r.SchemaName === "widget_gadgets");
  assert.deepEqual(Object.keys(base).sort(), sorted(BASE_MEMBERS));
  assert.deepEqual(base.IsCustomizable, { Value: true, CanBeChanged: true, ManagedPropertyLogicalName: "iscustomizable" });
});

test("a synthesized column carries the managed properties IsRenameable, IsSortableEnabled, IsGlobalFilterEnabled and CanModifyAdditionalSettings", () => {
  const attributes = Object.fromEntries(mapped.attributes("widget").map((a) => [a.LogicalName, a]));
  const name = attributes.name;
  assert.deepEqual(name.IsRenameable, { Value: true, CanBeChanged: name.IsCustomAttribute, ManagedPropertyLogicalName: "isrenameable" });
  assert.equal(name.IsSortableEnabled.Value, false);
  assert.equal(name.IsSortableEnabled.ManagedPropertyLogicalName, "canmodifyissortablesettings");
  assert.equal(name.IsGlobalFilterEnabled.ManagedPropertyLogicalName, "canmodifyglobalfiltersettings");
  assert.equal(name.CanModifyAdditionalSettings.Value, true);
  assert.equal(name.CanModifyAdditionalSettings.ManagedPropertyLogicalName, "canmodifyadditionalsettings");
  assert.equal(name.CanModifyAdditionalSettings.CanBeChanged, name.IsCustomAttribute);
});

test("the DateTime managed name is the one the SOAP writer and the exported column path share", () => {
  const made = Object.fromEntries(mapped.attributes("widget").map((a) => [a.LogicalName, a])).made;
  const name = MANAGED_MEMBERS.DateTimeAttributeMetadata.CanChangeDateTimeBehavior;
  assert.equal(made.CanChangeDateTimeBehavior.ManagedPropertyLogicalName, name);
  const exported = attributeMetadata("widget", "made", {
    dateTimeBehavior: "UserLocal",
    columnMetadata: { type: "datetime", format: "dateandtime", isCustomField: true, customTable: true, labels: { 1033: "Made" } },
  });
  assert.equal(exported.CanChangeDateTimeBehavior.ManagedPropertyLogicalName, name);
});

test("an unknown attribute cast answers one REQ_ID header; an engine error repeats it", () => {
  let error;
  try { mapped.attributes("widget", { cast: "Microsoft.Dynamics.CRM.NoSuchAttributeMetadata" }); } catch (e) { error = e; }
  assert.ok(error, "the unknown cast throws");
  const route = dataverseError(error, { requestId: "req-1" });
  assert.equal(route.status, 400);
  assert.equal(route.headers.REQ_ID, "req-1", "a route-level error carries a single REQ_ID");
  const engine = dataverseError(Object.assign(new Error("engine"), { code: "InvalidRequest", status: 400, details: { innerCode: "0x80040217" } }), { requestId: "req-2" });
  assert.deepEqual(engine.headers.REQ_ID, ["req-2", "req-2"], "an engine error repeats REQ_ID");
});
