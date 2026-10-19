// Dataverse metadata service: EntityDefinitions, Attributes, Keys, relationship shapes and the
// $filter subset, from an invented mapping-only fixture and from a minimal Solution schema table.
import test from "node:test";
import assert from "node:assert/strict";
import { createMetadataService, objectTypeCode } from "../lib/dataverse-metadata.mjs";

const ORG = "5f0c2c1e-1d2b-4c3a-9a7e-0123456789ab";

const MAPPINGS = {
  widget: {
    entitySet: "widgets",
    idColumn: "widgetid",
    nameColumn: "name",
    label: "Widget",
    fields: {
      name: { dataverseType: "nvarchar", maxLength: 100, label: "Name" },
      price: { dataverseType: "money", precision: 2, minValue: 0, maxValue: 1000, label: "Price" },
      status: { dataverseType: "picklist", label: "Status", options: [{ value: 1, label: "Open" }, { value: 2, label: "Closed" }] },
      code: { dataverseType: "nvarchar", maxLength: 20, label: "Code" },
      ownerid: { dataverseType: "lookup", targets: ["systemuser", "team"], label: "Owner" },
    },
    relationships: {
      gadgets: { entity: "gadget", from: "widgetid", to: "widgetid", many: true, schemaName: "widget_gadgets", partner: "widget" },
      tags: {
        entity: "tag", from: "widgetid", to: "tagid", many: true, schemaName: "widget_tags",
        intersect: { entity: "widget_tag", from: "widgetid", to: "tagid" },
      },
    },
    alternateKeys: [{ name: "widget_code", schemaName: "widget_code_key", attributes: ["code"] }],
  },
  gadget: {
    entitySet: "gadgets",
    idColumn: "gadgetid",
    nameColumn: "name",
    fields: {
      name: { dataverseType: "nvarchar" },
      widgetid: { dataverseType: "lookup", targets: ["widget"], label: "Widget" },
    },
    relationships: {
      widget: { entity: "widget", from: "widgetid", to: "widgetid", many: false, schemaName: "widget_gadgets", partner: "gadgets" },
    },
  },
  tag: { entitySet: "tags", idColumn: "tagid", nameColumn: "name", fields: { name: { dataverseType: "nvarchar" } } },
};

// Minimal built Solution schema: the table shape solution-schema.mjs produces (attributes keyed by name).
const SCHEMA = {
  lcid: 1033,
  targets: {},
  optionSets: {},
  relationships: {},
  tables: {
    gizmo: {
      logicalName: "gizmo",
      entitySetName: "gizmos",
      primaryIdAttribute: "gizmoid",
      primaryNameAttribute: "gizmoname",
      ownership: "OrganizationOwned",
      labels: { 1033: "Gizmo" },
      collectionLabels: { 1033: "Gizmos" },
      schemaComplete: false,
      attributes: {
        gizmoid: { name: "gizmoid", type: "primarykey", requiredLevel: "systemrequired", labels: {} },
        gizmoname: {
          name: "gizmoname", type: "nvarchar", maxLength: 100, requiredLevel: "applicationrequired",
          displayMask: "ValidForAdvancedFind|PrimaryName", isPrimaryName: true, labels: { 1033: "Gizmo Name" },
        },
        gizmocolor: {
          name: "gizmocolor", type: "picklist", labels: { 1033: "Color" },
          optionSet: { type: "picklist", options: [{ value: 1, labels: { 1033: "Red" } }, { value: 2, labels: { 1033: "Blue" } }] },
        },
      },
    },
  },
};

const mapped = createMetadataService({ organizationId: ORG, schema: () => null, mappings: () => MAPPINGS });
const solution = createMetadataService({ organizationId: ORG, schema: () => SCHEMA, mappings: () => ({}) });
const names = (items) => items.map((item) => item.LogicalName);

test("metadata ids are deterministic per organization and kind", () => {
  const again = createMetadataService({ organizationId: ORG, schema: () => null, mappings: () => MAPPINGS });
  const id = mapped.metadataId("entity", "widget");
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(again.metadataId("entity", "widget"), id);
  assert.notEqual(mapped.metadataId("attribute", "widget", "name"), id);
  assert.notEqual(createMetadataService({ organizationId: "00000000-0000-4000-8000-000000000001" }).metadataId("entity", "widget"), id);
});

test("entity shape from the mapping, with lcid labels and ownership", () => {
  const widget = mapped.entity("widget");
  assert.equal(widget.LogicalName, "widget");
  assert.equal(widget.EntitySetName, "widgets");
  assert.equal(widget.PrimaryIdAttribute, "widgetid");
  assert.equal(widget.PrimaryNameAttribute, "name");
  assert.equal(widget.OwnershipType, "UserOwned");
  assert.equal(widget.IsCustomEntity, false);
  assert.equal(widget.ObjectTypeCode, objectTypeCode("widget"));
  assert.equal(widget.DisplayName.UserLocalizedLabel.Label, "Widget");
  assert.equal(widget.DisplayName.UserLocalizedLabel.LanguageCode, 1033);
  assert.equal(widget.MetadataId, mapped.metadataId("entity", "widget"));
  assert.equal(widget.Attributes, undefined);
  assert.equal(mapped.entity("nope"), null);
  assert.equal(mapped.entity(`LogicalName='gadget'`).EntitySetName, "gadgets");
  assert.equal(mapped.entity(mapped.metadataId("entity", "tag")).LogicalName, "tag");
});

test("entities lists every mapped table in logical-name order and expands on request", () => {
  assert.deepEqual(names(mapped.entities()), ["gadget", "tag", "widget"]);
  const expanded = mapped.entity("widget", { expand: ["Attributes", "Keys"] });
  assert.ok(expanded.Attributes.some((a) => a.LogicalName === "name"));
  assert.equal(expanded.Keys[0].LogicalName, "widget_code");
});

test("attributes carry @odata.type, system columns and the id", () => {
  const list = mapped.attributes("widget");
  for (const attribute of list) assert.match(attribute["@odata.type"], /^#Microsoft\.Dynamics\.CRM\.\w+AttributeMetadata$/);
  const byName = Object.fromEntries(list.map((a) => [a.LogicalName, a]));
  for (const column of ["widgetid", "createdon", "modifiedon", "createdby", "modifiedby", "ownerid", "owninguser", "owningbusinessunit", "statecode", "statuscode", "versionnumber"])
    assert.ok(byName[column], `missing ${column}`);
  assert.equal(byName.widgetid.IsPrimaryId, true);
  assert.equal(byName.name["@odata.type"], "#Microsoft.Dynamics.CRM.StringAttributeMetadata");
  assert.equal(byName.name.MaxLength, 100);
  assert.equal(byName.price["@odata.type"], "#Microsoft.Dynamics.CRM.MoneyAttributeMetadata");
  assert.equal(byName.price.RequiredLevel.Value, "None");
  assert.equal(byName.statecode.AttributeTypeName.Value, "StateType");
  assert.equal(mapped.attributes("nope"), null);
});

test("cast and key narrow attributes", () => {
  const picklists = mapped.attributes("widget", { cast: "Microsoft.Dynamics.CRM.PicklistAttributeMetadata" });
  assert.deepEqual(names(picklists), ["status"]);
  assert.deepEqual(picklists[0].OptionSet.Options.map((o) => o.Label.UserLocalizedLabel.Label), ["Open", "Closed"]);
  const [byKey] = mapped.attributes("widget", { key: "LogicalName='name'" });
  assert.equal(byKey.LogicalName, "name");
  assert.equal(byKey.IsPrimaryName, true);
  const [byId] = mapped.attributes("widget", { key: mapped.attributes("widget", { key: "LogicalName='price'" })[0].MetadataId });
  assert.equal(byId.LogicalName, "price");
  assert.deepEqual(mapped.attributes("widget", { select: "LogicalName" })[0], {
    "@odata.type": mapped.attributes("widget")[0]["@odata.type"],
    MetadataId: mapped.attributes("widget")[0].MetadataId,
    LogicalName: mapped.attributes("widget")[0].LogicalName,
  });
});

test("keys come from alternate keys", () => {
  const [key] = mapped.keys("widget");
  assert.equal(key["@odata.type"], "#Microsoft.Dynamics.CRM.EntityKeyMetadata");
  assert.equal(key.LogicalName, "widget_code");
  assert.deepEqual(key.KeyAttributes, ["code"]);
  assert.equal(key.EntityKeyIndexStatus, "Active");
});

test("lookup and collection relationships mirror each other", () => {
  const [lookup] = mapped.manyToOne("gadget");
  const [collection] = mapped.oneToMany("widget");
  assert.deepEqual(lookup, collection);
  assert.equal(lookup["@odata.type"], "#Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata");
  assert.equal(lookup.SchemaName, "widget_gadgets");
  assert.equal(lookup.ReferencedEntity, "widget");
  assert.equal(lookup.ReferencedAttribute, "widgetid");
  assert.equal(lookup.ReferencingEntity, "gadget");
  assert.equal(lookup.ReferencingAttribute, "widgetid");
  assert.equal(lookup.ReferencedEntityNavigationPropertyName, "gadgets");
  assert.equal(lookup.ReferencingEntityNavigationPropertyName, "widget");
  assert.equal(lookup.CascadeConfiguration.Delete, "RemoveLink");
  assert.deepEqual(mapped.manyToOne("widget"), []);
});

test("many-to-many returns the intersect with both sides", () => {
  const [m2m] = mapped.manyToMany("widget");
  assert.equal(m2m["@odata.type"], "#Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata");
  assert.equal(m2m.SchemaName, "widget_tags");
  assert.equal(m2m.IntersectEntityName, "widget_tag");
  assert.equal(m2m.Entity1LogicalName, "widget");
  assert.equal(m2m.Entity1IntersectAttribute, "widgetid");
  assert.equal(m2m.Entity1NavigationPropertyName, "tags");
  assert.equal(m2m.Entity2LogicalName, "tag");
  assert.equal(m2m.Entity2IntersectAttribute, "tagid");
  assert.deepEqual(mapped.relationship("widget_tags"), m2m);
  assert.equal(mapped.relationship("nope"), null);
  assert.equal(mapped.relationships({ cast: "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata" }).length, 1);
});

test("service document lists entity sets sorted by name", () => {
  const doc = mapped.serviceDocument("https://org.example", "v9.2");
  assert.equal(doc["@odata.context"], "https://org.example/api/data/v9.2/$metadata");
  assert.deepEqual(doc.value.map((v) => v.name), ["gadgets", "tags", "widgets"]);
  assert.equal(doc.value[0].kind, "EntitySet");
});

test("filterMetadata evaluates the supported subset", () => {
  const entities = mapped.entities();
  assert.deepEqual(names(mapped.filterMetadata(entities, "LogicalName eq 'widget'")), ["widget"]);
  assert.deepEqual(names(mapped.filterMetadata(entities, "LogicalName+eq+'widget'")), ["widget"]);
  assert.deepEqual(names(mapped.filterMetadata(entities, `MetadataId eq ${mapped.metadataId("entity", "gadget")}`)), ["gadget"]);
  assert.deepEqual(names(mapped.filterMetadata(entities, "LogicalName ne 'widget' and not (LogicalName eq 'tag')")), ["gadget"]);

  const attributes = mapped.attributes("widget");
  assert.deepEqual(names(mapped.filterMetadata(attributes, "AttributeType eq Microsoft.Dynamics.CRM.AttributeTypeCode'Picklist'")), ["status"]);
  assert.deepEqual(names(mapped.filterMetadata(attributes, "RequiredLevel/Value eq Microsoft.Dynamics.CRM.AttributeRequiredLevel'SystemRequired'")), ["widgetid"]);
  assert.deepEqual(names(mapped.filterMetadata(attributes, "IsPrimaryName eq true and IsCustomAttribute eq false")), ["name"]);
  assert.deepEqual(names(mapped.filterMetadata(attributes, "(LogicalName eq 'price' or LogicalName eq 'status') and IsPrimaryId eq false")), ["price", "status"]);
  assert.equal(mapped.filterMetadata(attributes, "").length, attributes.length);

  for (const bad of ["LogicalName gt 'a'", "LogicalName eq", "contains(LogicalName,'x')", "LogicalName eq 'a' )"]) {
    assert.throws(() => mapped.filterMetadata(entities, bad), { status: 400, code: "UnsupportedQuery" }, bad);
  }
});

test("selectMetadata keeps MetadataId and @odata.type", () => {
  const [attribute] = mapped.attributes("widget", { key: "LogicalName='price'" });
  const picked = mapped.selectMetadata(attribute, "LogicalName");
  assert.deepEqual(Object.keys(picked).sort(), ["@odata.type", "LogicalName", "MetadataId"]);
  assert.equal(picked.OptionSet, undefined);
  const entity = mapped.selectMetadata(mapped.entity("tag"), ["EntitySetName"]);
  assert.deepEqual(Object.keys(entity).sort(), ["EntitySetName", "MetadataId"]);
});

test("object type codes: standard fixed, custom stable in the custom range", () => {
  assert.equal(objectTypeCode("account"), 1);
  assert.equal(objectTypeCode("systemuser"), 8);
  const custom = objectTypeCode("new_thing");
  assert.ok(custom >= 10000 && custom < 60000);
  assert.equal(objectTypeCode("new_thing"), custom);
});

test("schema table drives attributes, option labels and entity names", () => {
  const gizmo = solution.entity("gizmo");
  assert.equal(gizmo.EntitySetName, "gizmos");
  assert.equal(gizmo.PrimaryIdAttribute, "gizmoid");
  assert.equal(gizmo.PrimaryNameAttribute, "gizmoname");
  assert.equal(gizmo.OwnershipType, "OrganizationOwned");
  assert.equal(gizmo.DisplayCollectionName.UserLocalizedLabel.Label, "Gizmos");

  const [color] = solution.attributes("gizmo", { cast: "PicklistAttributeMetadata" });
  assert.equal(color.LogicalName, "gizmocolor");
  assert.equal(color["@odata.type"], "#Microsoft.Dynamics.CRM.PicklistAttributeMetadata");
  assert.deepEqual(color.OptionSet.Options.map((o) => o.Label.UserLocalizedLabel.Label), ["Red", "Blue"]);

  const attributes = solution.attributes("gizmo");
  const name = attributes.find((a) => a.LogicalName === "gizmoname");
  assert.equal(name.IsPrimaryName, true);
  assert.equal(name.DisplayName.UserLocalizedLabel.Label, "Gizmo Name");
  assert.equal(name.MaxLength, 100);
  assert.ok(attributes.find((a) => a.LogicalName === "createdon"), "system columns are added to schema tables");
  assert.equal(attributes.find((a) => a.LogicalName === "ownerid"), undefined, "organization-owned tables have no owner columns");
});

// The element body of one EntityType, from its opening tag to its close.
const block = (xml, name) => {
  const start = xml.indexOf(`<EntityType Name="${name}"`);
  return xml.slice(start, xml.indexOf("</EntityType>", start));
};
// Cheap well-formedness: every element name opens and closes the same number of times (no XML parser in the repo).
const balanced = (xml) => {
  const tally = (pattern) => {
    const counts = new Map();
    for (const [, tag] of xml.matchAll(pattern)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
    return JSON.stringify([...counts].sort());
  };
  return tally(/<([A-Za-z][\w:.]*)(?:\s[^>]*)?(?<!\/)>/g) === tally(/<\/([A-Za-z][\w:.]*)>/g);
};
function assertWellFormed(xml) {
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="utf-8"?>'));
  assert.ok(balanced(xml), "tags balance");
  const declared = new Set([...xml.matchAll(/<(?:EntityType|ComplexType|EnumType|Function|Action) Name="(\w+)"/g)].map((m) => m[1]));
  for (const [, ref] of xml.matchAll(/="(?:Collection\()?mscrm\.(\w+)/g)) assert.ok(declared.has(ref), `unresolved mscrm.${ref}`);
}

test("csdl declares entities, navigation, the container and the functions", () => {
  const xml = mapped.csdl("https://org.example");
  assertWellFormed(xml);
  assert.match(xml, /<Schema Namespace="Microsoft\.Dynamics\.CRM" Alias="mscrm"/);
  assert.match(block(xml, "widget"), /<PropertyRef Name="widgetid" \/>/);
  assert.match(block(xml, "widget"), /<Property Name="_ownerid_value" Type="Edm\.Guid" \/>/);
  assert.match(block(xml, "widget"), /<NavigationProperty Name="widget_gadgets" Type="Collection\(mscrm\.gadget\)" Partner="widgetid" \/>/);
  assert.match(block(xml, "gadget"), /<NavigationProperty Name="widgetid" Type="mscrm\.widget" Partner="widget_gadgets">\s*<ReferentialConstraint Property="_widgetid_value" ReferencedProperty="widgetid" \/>\s*<\/NavigationProperty>/);
  assert.match(xml, /<EntityContainer Name="System">/);
  assert.match(xml, /<EntitySet Name="widgets" EntityType="mscrm\.widget">\s*<NavigationPropertyBinding Path="widget_gadgets" Target="gadgets" \/>/);
  assert.match(xml, /<ComplexType Name="WhoAmIResponse">/);
  assert.match(xml, /<Function Name="WhoAmI">/);
  assert.ok(!xml.includes("OData.Community.Keys.V1"), "annotations are opt-in");
});

test("csdl annotations add descriptions, computed values and alternate keys", () => {
  const xml = mapped.csdl(null, { annotations: true });
  assertWellFormed(xml);
  assert.match(xml, /Term="Org\.OData\.Core\.V1\.Description" String="Widget"/);
  assert.match(block(xml, "widget"), /<Property Name="_ownerid_value" Type="Edm\.Guid">[\s\S]*?Term="Org\.OData\.Core\.V1\.Computed" Bool="true"/);
  assert.match(xml, /<Annotation Term="OData\.Community\.Keys\.V1\.AlternateKeys">/);
  assert.match(xml, /<PropertyValue Property="Alias" String="code" \/>/);
  assert.match(xml, /<PropertyValue Property="Name" PropertyPath="code" \/>/);
});

test("csdl follows the solution schema and leaves out systemuser-bound functions without systemuser", () => {
  const xml = solution.csdl();
  assertWellFormed(xml);
  assert.match(block(xml, "gizmo"), /<Property Name="gizmoname" Type="Edm\.String" \/>/);
  assert.match(block(xml, "gizmo"), /<Property Name="gizmocolor" Type="Edm\.Int32" \/>/);
  assert.ok(!block(xml, "gizmo").includes("_ownerid_value"), "organization-owned tables have no owner lookup");
  assert.ok(!xml.includes('<Function Name="RetrieveUserPrivileges"'));
});

const WIDGET_QUERY = {
  Properties: { AllProperties: false, PropertyNames: ["SchemaName", "Attributes"] },
  Criteria: { FilterOperator: "Or", Conditions: [{ ConditionOperator: "Equals", PropertyName: "LogicalName", Value: { Type: "System.String", Value: "widget" } }] },
  AttributeQuery: {
    Properties: { AllProperties: false, PropertyNames: ["LogicalName"] },
    Criteria: { FilterOperator: "And", Conditions: [{ ConditionOperator: "Equals", PropertyName: "IsValidForCreate", Value: { Type: "System.Boolean", Value: "True" } }] },
  },
  LabelQuery: { FilterLanguages: [1033], MissingLabelBehavior: 0 },
};

test("RetrieveMetadataChanges answers the sample query with complex shapes", () => {
  const result = mapped.retrieveMetadataChanges(WIDGET_QUERY);
  assert.match(result.ServerVersionStamp, /^\d+!\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/);
  assert.deepEqual(result.DeletedMetadata, { Count: 0, IsReadOnly: false, Keys: [], Values: [] });
  assert.equal(result.EntityMetadata.length, 1);
  const [widget] = result.EntityMetadata;
  assert.equal(widget["@odata.type"], "#Microsoft.Dynamics.CRM.ComplexEntityMetadata");
  assert.equal(widget.SchemaName, "Widget");
  assert.equal(widget.MetadataId, mapped.metadataId("entity", "widget"));
  assert.equal(widget.DisplayName, undefined, "unrequested properties are left out");
  assert.ok(widget.Attributes.length > 0);
  for (const attribute of widget.Attributes) assert.match(attribute["@odata.type"], /^#Microsoft\.Dynamics\.CRM\.Complex\w+AttributeMetadata$/);
  const attributeNames = widget.Attributes.map((a) => a.LogicalName);
  assert.ok(attributeNames.includes("name"));
  assert.ok(!attributeNames.includes("widgetid"), "AttributeQuery criteria filters the attributes");
  assert.deepEqual(Object.keys(widget.Attributes[0]).sort(), ["@odata.type", "HasChanged", "LogicalName", "MetadataId"]);
});

test("RetrieveMetadataChanges: null query returns every table, nested keys included, and an unchanged stamp returns nothing", () => {
  const all = mapped.retrieveMetadataChanges(null);
  assert.deepEqual(names(all.EntityMetadata), ["gadget", "tag", "widget"]);
  const widgetKeys = all.EntityMetadata.find((e) => e.LogicalName === "widget").Keys;
  assert.equal(widgetKeys[0].LogicalName, "widget_code");
  assert.equal(mapped.retrieveMetadataChanges(null, { clientVersionStamp: all.ServerVersionStamp }).EntityMetadata.length, 0);
  assert.equal(mapped.retrieveMetadataChanges(null, { clientVersionStamp: "1!01/01/1999 00:00:00" }).EntityMetadata.length, 3);
});
