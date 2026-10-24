// Dataverse metadata service: EntityDefinitions, Attributes, Keys, relationship shapes and the
// $filter subset, from a mapping-only fixture and from a minimal Solution schema table.
import test from "node:test";
import assert from "node:assert/strict";
import { createMetadataService, objectTypeCode, relationshipSchemaName } from "../lib/dataverse-metadata.mjs";
import { privilegeId } from "../lib/dataverse-security.mjs";
import { seed as seedStandard } from "../lib/dataverse-standard.mjs";

const ORG = "5f0c2c1e-1d2b-4c3a-9a7e-0123456789ab";

test('registered fields supplement a source shell but complete source schemas remain authoritative', () => {
  const mappings = { x_probe: { entitySet: 'x_probes', idColumn: 'x_probeid', nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' }, x_mappingonly: { dataverseType: 'int' } },
    fieldMetadata: { x_name: { dataverseType: 'nvarchar', columnMetadata: { isSecured: true } } } } };
  let table;
  const service = createMetadataService({ organizationId: ORG, mappings: () => mappings, schema: () => ({ tables: table ? { x_probe: table } : {}, relationships: {}, targets: {}, optionSets: {} }) });
  assert.ok(service.recordFields('x_probe').x_mappingonly);
  assert.equal(service.attributes('x_probe').find(field => field.LogicalName === 'x_name').IsSecured, true);
  table = { logicalName: 'x_probe', attributes: {}, layers: [], labels: {} };
  assert.ok(service.recordFields('x_probe').x_mappingonly);
  table = { ...table, attributes: { x_name: { name: 'x_name', type: 'nvarchar' } } };
  assert.equal(service.recordFields('x_probe').x_mappingonly, undefined, 'A column-declaring source retains its existing authority.');
  table = { ...table, completeFile: 'invented/Entity.xml' };
  assert.equal(service.recordFields('x_probe').x_mappingonly, undefined);
  assert.equal(service.recordFields('x_probe').x_unknown, undefined);
});

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

test("metadata $select preserves explicitly expanded relationship collections, including empty collections", () => {
  const entity = mapped.entity("widget", { expand: "OneToManyRelationships,ManyToManyRelationships" });
  const projected = mapped.selectMetadata(entity, "LogicalName");
  assert.equal(projected.LogicalName, "widget");
  assert.ok(projected.OneToManyRelationships.some((relationship) => relationship.SchemaName === "widget_gadgets"));
  assert.ok(projected.ManyToManyRelationships.some((relationship) => relationship.SchemaName === "widget_tags"));
  assert.equal(projected.DisplayName, undefined);
  const empty = mapped.selectMetadata(mapped.entity("tag", { expand: "OneToManyRelationships" }), "LogicalName");
  assert.deepEqual(empty.OneToManyRelationships, []);
  assert.equal(mapped.selectMetadata(mapped.entity("tag"), "LogicalName").OneToManyRelationships, undefined);
});

test("generated metadata validity reflects supplied GUIDs and read-only ownership fields while explicit facts win", () => {
  const attributes = Object.fromEntries(mapped.attributes("widget").map((attribute) => [attribute.LogicalName, attribute]));
  assert.equal(attributes.widgetid.IsValidForCreate, true);
  assert.equal(attributes.widgetid.IsValidForUpdate, false);
  assert.equal(attributes.statecode.IsValidForCreate, false);
  assert.equal(attributes.statecode.IsValidForUpdate, true);
  for (const name of ["owninguser", "owningteam", "owningbusinessunit"]) {
    assert.equal(attributes[name].IsValidForCreate, false); assert.equal(attributes[name].IsValidForUpdate, false);
  }
  const explicit = createMetadataService({ organizationId: ORG, mappings: () => ({ widget: { ...MAPPINGS.widget, fields: { ...MAPPINGS.widget.fields, statecode: { dataverseType: "state", validForCreate: true, validForUpdate: false } } } }) });
  const state = explicit.attributes("widget").find((attribute) => attribute.LogicalName === "statecode");
  assert.equal(state.IsValidForCreate, true); assert.equal(state.IsValidForUpdate, false);
});

test("an exact attribute cast omits a redundant discriminator while polymorphic enum casts keep it", () => {
  const strings = mapped.attributes("widget", { cast: "StringAttributeMetadata", select: "LogicalName,MaxLength" });
  assert.ok(strings.length > 0); assert.ok(strings.every((attribute) => !("@odata.type" in attribute)));
  const enums = mapped.attributes("widget", { cast: "EnumAttributeMetadata", select: "LogicalName" });
  assert.ok(enums.some((attribute) => attribute["@odata.type"] === "#Microsoft.Dynamics.CRM.PicklistAttributeMetadata"));
});

test("table tracking facts and custom-table optimistic concurrency defaults are exposed without overriding explicit false", () => {
  const schema = { ...SCHEMA, tables: { new_widget: { ...SCHEMA.tables.gizmo, logicalName: "new_widget", changeTrackingEnabled: true } } };
  const service = createMetadataService({ organizationId: ORG, schema: () => schema });
  assert.equal(service.entity("new_widget").ChangeTrackingEnabled, true);
  assert.equal(service.entity("new_widget").IsOptimisticConcurrencyEnabled, true);
  const overridden = createMetadataService({ organizationId: ORG, schema: () => schema, mappings: () => ({ new_widget: { dataverseMetadata: { IsOptimisticConcurrencyEnabled: false } } }) });
  assert.equal(overridden.entity("new_widget").IsOptimisticConcurrencyEnabled, false);
});

// Kept apart from MAPPINGS so the table lists above stay fixed: owner/customer lookups, ownership and principal tables.
const EXTENDED = {
  ...MAPPINGS,
  ticket: {
    entitySet: "tickets", idColumn: "ticketid", nameColumn: "title",
    fields: {
      title: { dataverseType: "nvarchar" },
      customerid: { dataverseType: "customer", label: "Customer" },
      ownerid: { dataverseType: "owner", label: "Owner" },
    },
  },
  orgbox: { entitySet: "orgboxes", idColumn: "orgboxid", nameColumn: "name", ownership: "OrganizationOwned", fields: { name: { dataverseType: "nvarchar" } } },
  systemuser: { entitySet: "systemusers", idColumn: "systemuserid", nameColumn: "fullname", fields: { fullname: { dataverseType: "nvarchar" } } },
  role: { entitySet: "roles", idColumn: "roleid", nameColumn: "name", fields: { name: { dataverseType: "nvarchar" } } },
};
const extended = createMetadataService({ organizationId: ORG, schema: () => null, mappings: () => EXTENDED });

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
  for (const attribute of list) {
    if (attribute["@odata.type"]) assert.match(attribute["@odata.type"], /^#Microsoft\.Dynamics\.CRM\.\w*AttributeMetadata$/);
    else assert.ok(attribute.IsPrimaryId || attribute.AttributeType === 'Virtual');
  }
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
  // An uncast single-key lookup is RelationshipMetadataBase, like the uncast list; the derived shape needs the cast.
  assert.deepEqual(mapped.relationship("widget_tags"), mapped.relationships().find((r) => r.SchemaName === "widget_tags"));
  assert.equal("IntersectEntityName" in mapped.relationship("widget_tags"), false);
  assert.deepEqual(mapped.relationship("widget_tags", { cast: "ManyToManyRelationshipMetadata" }), m2m);
  assert.equal(mapped.relationship("widget_tags", { cast: "OneToManyRelationshipMetadata" }), null);
  assert.equal(mapped.relationship("nope"), null);
  assert.equal(mapped.relationships({ cast: "Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata" }).length, 1);
  assert.deepEqual(mapped.relationships({ cast: "#Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata" }), [m2m]);
});

test("service document lists entity sets sorted by name", () => {
  const doc = mapped.serviceDocument("https://org.example", "v9.2");
  assert.equal(doc["@odata.context"], "https://org.example/api/data/v9.2/$metadata");
  assert.deepEqual(doc.value.map((v) => v.name), ["EntityDefinitions", "GlobalOptionSetDefinitions", "RelationshipDefinitions", "gadgets", "tags", "widgets"]);
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

  for (const bad of ["LogicalName gt 'a'", "LogicalName eq", "LogicalName eq 'a' )"]) {
    assert.throws(() => mapped.filterMetadata(entities, bad), { status: 400, code: "UnsupportedQuery" }, bad);
  }
  assert.throws(() => mapped.filterMetadata(entities, "contains(LogicalName,'x')"), { status: 501, code: "UnsupportedQueryFunction", message: 'The "contains" function isn\'t supported for Metadata Entities.' });
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

test("a Solution table's keys (kept by name in the schema) read back as Keys", () => {
  const keyed = createMetadataService({
    organizationId: ORG, mappings: () => ({}),
    schema: () => ({ ...SCHEMA, tables: { gizmo: { ...SCHEMA.tables.gizmo, keys: { gizmo_name_key: { name: "gizmo_name_key", schemaName: "gizmo_name_key", attributes: ["gizmoname"], labels: { 1033: "Gizmo Name Key" } } } } } }),
  });
  const [key] = keyed.entity("gizmo", { expand: ["Keys"] }).Keys;
  assert.equal(key.LogicalName, "gizmo_name_key");
  assert.deepEqual(key.KeyAttributes, ["gizmoname"]);
  assert.equal(key.EntityKeyIndexStatus, "Active");
  assert.equal(solution.entity("gizmo", { expand: ["Keys"] }).Keys.length, 0);
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
  assert.equal(color["@odata.type"], undefined, "the exact URL cast supplies the metadata type");
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
  assert.match(block(xml, "widget"), /<NavigationProperty Name="gadgets" Type="Collection\(mscrm\.gadget\)" Partner="widget" \/>/);
  assert.match(block(xml, "gadget"), /<NavigationProperty Name="widget" Type="mscrm\.widget" Partner="gadgets">\s*<ReferentialConstraint Property="_widgetid_value" ReferencedProperty="widgetid" \/>\s*<\/NavigationProperty>/);
  assert.match(xml, /<EntityContainer Name="System">/);
  assert.match(xml, /<EntitySet Name="widgets" EntityType="mscrm\.widget">\s*<NavigationPropertyBinding Path="gadgets" Target="gadgets" \/>/);
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
  assert.ok(attributeNames.includes("widgetid"), "a primary GUID can be supplied on create");
  assert.ok(!attributeNames.includes("createdon"), "AttributeQuery criteria filters read-only system attributes");
  assert.deepEqual(Object.keys(widget.Attributes[0]).sort(), ["@odata.type", "HasChanged", "LogicalName", "MetadataId"]);
});

test("RetrieveMetadataChanges: null query returns every table, nested keys included, and an unchanged stamp returns nothing", () => {
  const all = mapped.retrieveMetadataChanges(null);
  assert.deepEqual(names(all.EntityMetadata), ["gadget", "tag", "widget"]);
  const widgetKeys = all.EntityMetadata.find((e) => e.LogicalName === "widget").Keys;
  assert.equal(widgetKeys[0].LogicalName, "widget_code");
  assert.equal(mapped.retrieveMetadataChanges(null, { clientVersionStamp: all.ServerVersionStamp }).EntityMetadata.length, 0);
  // A stamp 90 days old, or ahead of the server, is ExpiredVersionStamp.
  assert.throws(() => mapped.retrieveMetadataChanges(null, { clientVersionStamp: "1!01/01/1999 00:00:00" }), (e) => e.details?.innerCode === "0x80044352");
});

test("RetrieveMetadataChanges criteria: nested Filters combine under their own FilterOperator", () => {
  const either = mapped.retrieveMetadataChanges({
    Properties: { AllProperties: false, PropertyNames: ["SchemaName"] },
    Criteria: {
      FilterOperator: "Or",
      Conditions: [{ ConditionOperator: "Equals", PropertyName: "LogicalName", Value: "tag" }],
      Filters: [{ FilterOperator: "And", Conditions: [
        { ConditionOperator: "Equals", PropertyName: "LogicalName", Value: { Type: "System.String", Value: "gadget" } },
        { ConditionOperator: "NotEquals", PropertyName: "SchemaName", Value: "Nothing" },
      ] }],
    },
  });
  assert.deepEqual(names(either.EntityMetadata), ["gadget", "tag"]);
  const disjoint = mapped.retrieveMetadataChanges({
    Criteria: { FilterOperator: "And", Conditions: [{ ConditionOperator: "Equals", PropertyName: "LogicalName", Value: "widget" }],
      Filters: [{ Conditions: [{ ConditionOperator: "Equals", PropertyName: "LogicalName", Value: "tag" }] }] },
  });
  assert.deepEqual(disjoint.EntityMetadata, []);
  // Nested Filters of an AttributeQuery select attributes the same way; In takes a list of plain values.
  const inList = mapped.retrieveMetadataChanges({
    Properties: { AllProperties: false, PropertyNames: ["LogicalName", "Attributes"] },
    Criteria: { Conditions: [{ ConditionOperator: "In", PropertyName: "LogicalName", Value: ["widget", "gadget"] }] },
    AttributeQuery: { Properties: { AllProperties: false, PropertyNames: ["LogicalName"] },
      Criteria: { FilterOperator: "Or", Filters: [{ Conditions: [{ ConditionOperator: "Equals", PropertyName: "LogicalName", Value: "name" }] }] } },
  });
  assert.deepEqual(names(inList.EntityMetadata), ["gadget", "widget"]);
  for (const entity of inList.EntityMetadata) assert.deepEqual(names(entity.Attributes), ["name"]);
});

test("RetrieveMetadataChanges filters before expansion and normalizes a large catalog once per request", () => {
  const tableCount = 120;
  let mappingReads = 0;
  const attributeReads = new Map();
  const catalog = Object.fromEntries(Array.from({ length: tableCount }, (_, index) => {
    const logical = `bench${index}`;
    const fields = Object.fromEntries(Array.from({ length: 8 }, (_, column) => [`field${column}`, {
      get dataverseType() {
        attributeReads.set(logical, (attributeReads.get(logical) ?? 0) + 1);
        return "nvarchar";
      },
    }]));
    return [logical, { entitySet: `${logical}s`, idColumn: `${logical}id`, nameColumn: "field0", fields }];
  }));
  const service = createMetadataService({ organizationId: ORG, mappings: () => { mappingReads++; return catalog; } });
  const query = { Criteria: { Conditions: [{ PropertyName: "LogicalName", ConditionOperator: "Equals", Value: "bench0" }] } };
  const filtered = service.retrieveMetadataChanges(query);
  assert.deepEqual(names(filtered.EntityMetadata), ["bench0"]);
  assert.ok(attributeReads.get("bench0") > 0);
  assert.deepEqual([...attributeReads.keys()], ["bench0"], "rejected tables must not expand their attributes");

  mappingReads = 0;
  assert.equal(service.retrieveMetadataChanges().EntityMetadata.length, tableCount);
  assert.ok(mappingReads < tableCount * 20, `catalog normalization must be linear, observed ${mappingReads} reads`);

  // A request-local snapshot must not retain a relationship after the next schema edit.
  catalog.bench0.relationships = { peers: { entity: "bench1", from: "bench0id", to: "bench1id", many: true, schemaName: "bench0_peers" } };
  assert.ok(service.retrieveMetadataChanges(query).EntityMetadata[0].OneToManyRelationships.some((item) => item.SchemaName === "bench0_peers"));
  delete catalog.bench0.relationships;
  assert.equal(service.retrieveMetadataChanges(query).EntityMetadata[0].OneToManyRelationships.length, 0);
});

test("RetrieveMetadataChanges LabelQuery.FilterLanguages keeps only the requested labels", () => {
  const labelled = createMetadataService({
    organizationId: ORG, schema: () => null,
    mappings: () => ({ ...MAPPINGS, widget: { ...MAPPINGS.widget, fields: { ...MAPPINGS.widget.fields, name: { dataverseType: "nvarchar", maxLength: 100, labels: { 1033: "Name", 1031: "Name DE" } } } } }),
  });
  const query = (languages) => ({
    Properties: { AllProperties: true },
    Criteria: { Conditions: [{ ConditionOperator: "Equals", PropertyName: "LogicalName", Value: "widget" }] },
    LabelQuery: languages ? { FilterLanguages: languages } : undefined,
  });
  const codes = (languages) => labelled.retrieveMetadataChanges(query(languages)).EntityMetadata[0].Attributes
    .find((a) => a.LogicalName === "name").DisplayName.LocalizedLabels.map((label) => label.LanguageCode);
  assert.deepEqual(codes([1031]), [1031]);
  assert.deepEqual(codes(null).sort(), [1031, 1033]);
});

test("Web API JSON: synthesized ManagedProperty members are objects, and flag enums are names", () => {
  const attributes = Object.fromEntries(mapped.attributes("widget").map((a) => [a.LogicalName, a]));
  assert.deepEqual(attributes.name.IsValidForAdvancedFind, { Value: true, CanBeChanged: true, ManagedPropertyLogicalName: "canmodifysearchsettings" });
  assert.equal(attributes.widgetid.IsValidForAdvancedFind.Value, false, "a primary key is not valid for Advanced Find");
  assert.equal(attributes.name.IsCustomizable.ManagedPropertyLogicalName, "iscustomizable");
  assert.equal(attributes.name.IsAuditEnabled.ManagedPropertyLogicalName, "canmodifyauditsettings");
  assert.equal(attributes.name.RequiredLevel.Value, "None");
});

test("owner and customer lookups are LookupAttributeMetadata with their own AttributeType and targets", () => {
  const lookups = extended.attributes("ticket", { cast: "LookupAttributeMetadata" });
  const byName = Object.fromEntries(lookups.map((a) => [a.LogicalName, a]));
  assert.equal(byName.ownerid["@odata.type"], undefined);
  assert.equal(byName.ownerid.AttributeType, "Owner");
  assert.equal(byName.ownerid.AttributeTypeName.Value, "OwnerType");
  assert.deepEqual(byName.ownerid.Targets, ["systemuser", "team"]);
  assert.equal(byName.customerid["@odata.type"], undefined);
  assert.equal(byName.customerid.AttributeType, "Customer");
  assert.equal(byName.customerid.AttributeTypeName.Value, "CustomerType");
  assert.deepEqual(byName.customerid.Targets, ["account", "contact"]);
  assert.ok(mapped.attributes("widget", { cast: "LookupAttributeMetadata" }).some((a) => a.LogicalName === "ownerid"));
  // The captured CSDL has no Owner or Customer AttributeMetadata type: such a cast is a query error, not an empty list.
  for (const cast of ["OwnerAttributeMetadata", "CustomerAttributeMetadata"]) {
    assert.throws(() => extended.attributes("ticket", { cast }), { status: 400, details: { innerCode: "0x80060888", route: true } });
  }
});

test("an Attributes cast must name a CSDL AttributeMetadata type; an unknown one answers 400 0x80060888", () => {
  assert.throws(() => extended.attributes("ticket", { cast: "DoesNotExistMetadata" }), { status: 400, details: { innerCode: "0x80060888", route: true } });
  assert.throws(() => extended.attributes("ticket", { cast: "Microsoft.Dynamics.CRM.DoesNotExistMetadata" }), { status: 400, details: { innerCode: "0x80060888", route: true } });
  // The base type returns every column; the enum base returns only the enum-typed columns; a derived type with no column is an empty list.
  assert.equal(extended.attributes("ticket", { cast: "AttributeMetadata" }).length, extended.attributes("ticket").length);
  const enums = extended.attributes("ticket", { cast: "EnumAttributeMetadata" });
  assert.ok(enums.length > 0);
  for (const a of enums) assert.match(a["@odata.type"], /#Microsoft\.Dynamics\.CRM\.(Picklist|MultiSelectPicklist|State|Status|EntityName)AttributeMetadata$/);
  assert.equal(extended.attributes("ticket", { cast: "ManagedPropertyAttributeMetadata" }).length, 0);
});

test("OwnershipType and owner columns come from one ownership answer per table", () => {
  assert.equal(extended.entity("widget").OwnershipType, "UserOwned");
  assert.equal(extended.entity("orgbox").OwnershipType, "OrganizationOwned");
  assert.equal(extended.entity("systemuser").OwnershipType, "BusinessOwned");
  const columnsOf = (table) => extended.attributes(table).map((a) => a.LogicalName);
  for (const column of ["ownerid", "owninguser", "owningteam", "owningbusinessunit"]) assert.ok(columnsOf("widget").includes(column), `widget has ${column}`);
  for (const table of ["orgbox", "systemuser"]) {
    for (const column of ["ownerid", "owninguser", "owningteam", "owningbusinessunit"]) assert.ok(!columnsOf(table).includes(column), `${table} has no ${column}`);
  }
});

// The body of one ComplexType, from its opening tag to its close.
const complexBlock = (xml, name) => {
  const start = xml.indexOf(`<ComplexType Name="${name}"`);
  return xml.slice(start, xml.indexOf("</ComplexType>", start));
};

test("csdl: owner has one principal navigation; principal tables derive from mscrm.principal and declare ownerid", () => {
  const xml = extended.csdl("https://org.example");
  assertWellFormed(xml);
  assert.match(block(xml, "ticket"), /<NavigationProperty Name="ownerid" Type="mscrm\.principal">\s*<ReferentialConstraint Property="_ownerid_value" ReferencedProperty="ownerid" \/>/);
  assert.match(block(xml, "ticket"), /<Property Name="_ownerid_value" Type="Edm\.Guid" \/>/);
  assert.ok(!xml.includes("ownerid_systemuser") && !xml.includes("ownerid_team"), "no per-target owner navigations");
  assert.match(block(xml, "systemuser"), /BaseType="mscrm\.principal"/);
  // Native $metadata: systemuser and team are BaseType mscrm.principal with Key ownerid; principal is abstract with Key ownerid.
  assert.match(block(xml, "systemuser"), /<Key>\s*<PropertyRef Name="ownerid" \/>\s*<\/Key>/, "systemuser declares the ownerid key");
  assert.match(block(xml, "principal"), /<EntityType Name="principal" BaseType="mscrm\.crmbaseentity" Abstract="true">\s*<Key>\s*<PropertyRef Name="ownerid" \/>/);
  assert.match(block(xml, "systemuser"), /<Property Name="systemuserid" Type="Edm\.Guid" Nullable="false" \/>/);
  assert.ok(!block(xml, "systemuser").includes('<NavigationProperty Name="ownerid"'), "systemuser gets no owner navigation");
  assert.match(block(xml, "widget"), /<PropertyRef Name="widgetid" \/>/, "non-principal tables keep their Key");
});

test("csdl: OrganizationDetail, RolePrivilege, metadata changes and the role action", () => {
  const xml = extended.csdl("https://org.example");
  assertWellFormed(xml);
  assert.equal(complexBlock(xml, "OrganizationDetail").match(/<Property /g).length, 13);
  assert.match(xml, /<EnumType Name="OrganizationType">/);
  assert.match(xml, /<EnumType Name="SchemaType">/);
  assert.match(xml, /<EnumType Name="OrganizationState">/);
  assert.match(complexBlock(xml, "RolePrivilege"), /<Property Name="RecordFilterId" Type="Edm\.Guid"(?: Nullable="true")? \/>/);
  assert.match(complexBlock(xml, "RolePrivilege"), /<Property Name="RecordFilterUniqueName" Type="Edm\.String"(?: Unicode="false")? \/>/);
  assert.match(xml, /<Function Name="RetrieveMetadataChanges">\s*<Parameter Name="Query" Type="mscrm\.EntityQueryExpression">\s*<Annotation Term="Org\.OData\.Core\.V1\.OptionalParameter" \/>/);
  assert.match(xml, /<FunctionImport Name="RetrieveMetadataChanges" Function="mscrm\.RetrieveMetadataChanges"/);
  assert.match(xml, /<Action Name="AddPrivilegesRole" IsBound="true">\s*<Parameter Name="entity" Type="mscrm\.role" Nullable="false" \/>\s*<Parameter Name="Privileges" Type="Collection\(mscrm\.RolePrivilege\)" \/>/);
  assert.ok(!mapped.csdl("https://org.example").includes("AddPrivilegesRole"), "the role action needs a role table");
});

test("IsHierarchical: the standard account parent relationship reports true, a custom one-to-many reports false", () => {
  const oneToMany = (service, schemaName) => service.relationship(schemaName, { cast: "OneToManyRelationshipMetadata" });
  assert.equal(oneToMany(STANDARD, "account_parent_account").IsHierarchical, true);
  assert.equal(oneToMany(STANDARD, "user_parent_user").IsHierarchical, true);
  assert.equal(oneToMany(STANDARD, "contact_master_contact").IsHierarchical, false);
  assert.equal(oneToMany(mapped, "widget_gadgets").IsHierarchical, false);
  assert.equal(STANDARD.relationships({ cast: "OneToManyRelationshipMetadata" }).filter((r) => r.IsHierarchical).length, 2);
  // Uncast RelationshipDefinitions are RelationshipMetadataBase: the flag is a derived property.
  assert.equal("IsHierarchical" in STANDARD.relationship("account_parent_account"), false);
});

test("attribute option sets: OptionSet and GlobalOptionSet sub-paths, and an unknown global set is absent", () => {
  const local = solution.attributeOptionSet("gizmo", "gizmocolor", { select: "Options" });
  assert.deepEqual(Object.keys(local).sort(), ["MetadataId", "Options"]);
  assert.deepEqual(local.Options.map((o) => o.Label.UserLocalizedLabel.Label), ["Red", "Blue"]);
  assert.equal(solution.attributeOptionSet("gizmo", "gizmoname"), null);
  assert.equal(solution.attributeOptionSet("nope", "gizmocolor"), null);

  const withGlobal = createMetadataService({
    organizationId: ORG,
    schema: () => null,
    mappings: () => ({ widget: { ...MAPPINGS.widget, fields: { ...MAPPINGS.widget.fields, tone: { dataverseType: "picklist", globalOptionSet: "sample_tone" } } } }),
    globalOptionSets: () => ({ sample_tone: { Name: "sample_tone", DisplayName: "Tone", Options: [{ Value: 727000000, Label: "Warm" }] } }),
  });
  const global = withGlobal.attributeOptionSet("widget", "tone", { global: true, select: "Options" });
  assert.equal(global.Options[0].Label.UserLocalizedLabel.Label, "Warm");
  assert.equal(withGlobal.attributeOptionSet("widget", "status", { global: true }), null, "a local-only picklist has no global set");
});

test("LabelLanguages keeps only the requested LocalizedLabels", () => {
  const bilingual = createMetadataService({
    organizationId: ORG,
    schema: () => ({ ...SCHEMA, tables: { gizmo: { ...SCHEMA.tables.gizmo, labels: { 1033: "Gizmo", 1036: "Gadget" } } } }),
    mappings: () => ({}),
  });
  const all = bilingual.entity("gizmo");
  assert.deepEqual(all.DisplayName.LocalizedLabels.map((l) => l.LanguageCode), [1033, 1036]);
  const fr = bilingual.entity("gizmo", { labelLanguages: "1036" });
  assert.deepEqual(fr.DisplayName.LocalizedLabels.map((l) => [l.LanguageCode, l.Label]), [[1036, "Gadget"]]);
  const attrs = bilingual.attributes("gizmo", { labelLanguages: 1033 });
  assert.ok(attrs.every((a) => a.DisplayName.LocalizedLabels.every((l) => l.LanguageCode === 1033)));
  assert.equal(bilingual.entity("gizmo").DisplayName.LocalizedLabels.length, 2, "no option means no filter");
});

test("file and image columns are Virtual with their own type names, size and image flags", () => {
  const media = createMetadataService({
    organizationId: ORG,
    schema: () => null,
    mappings: () => ({
      album: {
        entitySet: "albums", idColumn: "albumid", nameColumn: "name",
        fields: {
          name: { dataverseType: "nvarchar" },
          cover: { dataverseType: "image", columnMetadata: { type: "image", maxSizeInKB: 2048, canStoreFullImage: true } },
          banner: { dataverseType: "image", label: "Banner" },
          score: { dataverseType: "file", columnMetadata: { type: "file", maxSizeInKB: 512 } },
        },
      },
    }),
  });
  const byName = Object.fromEntries(media.attributes("album").map((a) => [a.LogicalName, a]));
  assert.equal(byName.score.AttributeType, "Virtual");
  assert.equal(byName.cover.AttributeType, "Virtual");
  assert.equal(byName.score["@odata.type"], "#Microsoft.Dynamics.CRM.FileAttributeMetadata");
  assert.equal(byName.score.AttributeTypeName.Value, "FileType");
  assert.equal(byName.score.MaxSizeInKB, 512);
  assert.equal(byName.cover["@odata.type"], "#Microsoft.Dynamics.CRM.ImageAttributeMetadata");
  assert.equal(byName.cover.AttributeTypeName.Value, "ImageType");
  assert.equal(byName.cover.MaxSizeInKB, 2048);
  assert.equal(byName.cover.CanStoreFullImage, true);
  assert.equal(byName.cover.IsPrimaryImage, false, "two image columns: no default primary");
  assert.equal(byName.banner.MaxSizeInKB, 10240, "image default is 10 MB");
  assert.equal(byName.banner.CanStoreFullImage, false);
  assert.equal(byName.name.AttributeTypeName.Value, "StringType", "other columns keep their own type");
  assert.equal(media.attributes("album", { cast: "Microsoft.Dynamics.CRM.ImageAttributeMetadata" }).length, 2);

  const single = createMetadataService({
    organizationId: ORG,
    schema: () => null,
    mappings: () => ({ album: { entitySet: "albums", idColumn: "albumid", fields: { photo: { dataverseType: "image" } } } }),
  });
  assert.equal(single.attributes("album").find((a) => a.LogicalName === "photo").IsPrimaryImage, true, "the only image column is primary");
});

test("IsSecured, IsAuditEnabled and dataverseMetadata overrides come from the mapping, as booleans or { Value } objects", () => {
  const overridden = createMetadataService({
    organizationId: ORG,
    schema: () => null,
    mappings: () => ({
      vault: {
        entitySet: "vaults", idColumn: "vaultid", nameColumn: "code", label: "Vault",
        dataverseMetadata: { IsAuditEnabled: true, ObjectTypeCode: 10500, MetadataId: "ignored" },
        fields: {
          code: { dataverseType: "nvarchar", dataverseMetadata: { IsAuditEnabled: false } },
          pin: { dataverseType: "nvarchar", columnMetadata: { isSecured: true } },
          note: { dataverseType: "nvarchar", dataverseMetadata: { IsSecured: true } },
          sealed: { dataverseType: "nvarchar", dataverseMetadata: { IsSecured: { Value: true }, IsAuditEnabled: { Value: true } } },
          open: { dataverseType: "nvarchar", dataverseMetadata: { IsSecured: { Value: false }, IsAuditEnabled: { Value: false } } },
        },
      },
    }),
  });
  const entity = overridden.entity("vault");
  assert.deepEqual(entity.IsAuditEnabled, { Value: true, CanBeChanged: true, ManagedPropertyLogicalName: "isauditenabled" });
  assert.equal(entity.ObjectTypeCode, 10500);
  assert.equal(entity.MetadataId, overridden.metadataId("entity", "vault"), "identity keys are never overridden");
  const byName = Object.fromEntries(overridden.attributes("vault").map((a) => [a.LogicalName, a]));
  assert.equal(byName.pin.IsSecured, true);
  assert.equal(byName.note.IsSecured, true);
  assert.equal(byName.code.IsSecured, false);
  assert.equal(byName.code.IsAuditEnabled.Value, false, "a column override wins");
  assert.equal(byName.note.IsAuditEnabled.Value, false, "unset audit defaults to off");
  assert.equal(byName.sealed.IsSecured, true);
  assert.equal(byName.sealed.IsAuditEnabled.Value, true);
  assert.equal(byName.open.IsSecured, false, "a { Value: false } object is not truthy");
  assert.equal(byName.open.IsAuditEnabled.Value, false);
  assert.equal(entity.IsAuditEnabled.Value, true);
});

test("globalOptionSets also reads the Web API sets; the Solution set wins on a name clash", () => {
  const stored = createMetadataService({
    organizationId: ORG,
    schema: () => ({ ...SCHEMA, optionSets: { sample_colors: { name: "sample_colors", displayLabels: { 1033: "Schema Colors" }, type: "picklist", options: [{ value: 1, labels: { 1033: "Solution Red" } }] } } }),
    mappings: () => ({}),
    globalOptionSets: () => ({
      sample_colors: { Name: "sample_colors", DisplayName: "Colors", Options: [{ Value: 727000000, Label: "Red" }] },
      sample_tone: { Name: "sample_tone", DisplayName: "Tone", OptionSetType: "Picklist", Options: [{ Value: 727000000, Label: "Warm" }] },
      broken: { DisplayName: "No name" },
    }),
  });
  assert.deepEqual(stored.globalOptionSets().map((s) => s.Name), ["sample_colors", "sample_tone"]);
  assert.equal(stored.globalOptionSet("sample_colors").DisplayName.UserLocalizedLabel.Label, "Schema Colors");
  const tone = stored.globalOptionSet("sample_tone");
  assert.equal(tone.IsGlobal, true);
  assert.equal(tone.DisplayName.UserLocalizedLabel.Label, "Tone");
  assert.equal(tone.Options[0].Label.UserLocalizedLabel.Label, "Warm");
  assert.equal(tone.MetadataId, stored.metadataId("optionset", "sample_tone"));
  assert.equal(stored.globalOptionSet("broken"), null);
});

test("RetrieveEntity builder: EntityFilters choose the collections, RetrieveAttribute by name or MetadataId", () => {
  const entityOnly = mapped.retrieveEntityResponse("widget", undefined);
  assert.equal(entityOnly.EntityMetadata.LogicalName, "widget");
  assert.equal(entityOnly.EntityMetadata["@odata.type"], "#Microsoft.Dynamics.CRM.EntityMetadata");
  assert.equal("Attributes" in entityOnly.EntityMetadata, false);
  assert.equal("OneToManyRelationships" in entityOnly.EntityMetadata, false);

  const attrs = mapped.retrieveEntityResponse(`LogicalName='widget'`, "Attributes").EntityMetadata;
  assert.ok(attrs.Attributes.some((a) => a.LogicalName === "price"));
  assert.equal("OneToManyRelationships" in attrs, false);

  const everything = mapped.retrieveEntityResponse(mapped.metadataId("entity", "widget"), "Microsoft.Dynamics.CRM.EntityFilters'All'").EntityMetadata;
  assert.ok(everything.Attributes.length > 0 && everything.OneToManyRelationships.length === 1 && everything.ManyToManyRelationships.length === 1);
  assert.equal(mapped.retrieveEntityResponse(mapped.metadataId("entity", "widget"), "2").EntityMetadata.Attributes.length, everything.Attributes.length);
  assert.equal(mapped.retrieveEntityResponse("nope", "All"), null);
  assert.throws(() => mapped.retrieveEntityResponse("widget", "Bogus"), (error) => error.code === "UnsupportedQuery");

  const price = mapped.retrieveAttributeResponse("widget", "price");
  assert.equal(price.AttributeMetadata.LogicalName, "price");
  assert.equal(price.AttributeMetadata["@odata.type"], "#Microsoft.Dynamics.CRM.MoneyAttributeMetadata");
  const byId = mapped.retrieveAttributeResponse(null, mapped.metadataId("attribute", "widget", "price"));
  assert.equal(byId.AttributeMetadata.LogicalName, "price");
  assert.equal(mapped.retrieveAttributeResponse(null, "price"), null, "a name needs its table");
  assert.equal(mapped.retrieveAttributeResponse("widget", "nope"), null);
  assert.equal(mapped.retrieveAttributeResponse("widget", "price", { labelLanguages: 1036 }).AttributeMetadata.DisplayName.LocalizedLabels.length, 0);
});

test("table labels, SchemaName, ObjectTypeCode and the audit flag come from dataverseMetadata written by the 1.9 writer", () => {
  const written = createMetadataService({
    organizationId: ORG,
    schema: () => null,
    mappings: () => ({
      new_bankaccount: {
        entitySet: "new_bankaccounts", idColumn: "new_bankaccountid", nameColumn: "new_name",
        fields: { new_name: { dataverseType: "nvarchar" } },
        dataverseMetadata: {
          schemaName: "new_BankAccount",
          labels: { DisplayName: { 1033: "Bank Account" }, DisplayCollectionName: { 1033: "Bank Accounts" }, Description: { 1033: "Accounts held" } },
          ObjectTypeCode: 10500,
          IsAuditEnabled: { Value: false },
        },
      },
    }),
  });
  const entity = written.entity("new_bankaccount");
  assert.equal(entity.SchemaName, "new_BankAccount");
  assert.equal(entity.DisplayName.UserLocalizedLabel.Label, "Bank Account");
  assert.equal(entity.DisplayCollectionName.UserLocalizedLabel.Label, "Bank Accounts");
  assert.equal(entity.Description.UserLocalizedLabel.Label, "Accounts held");
  assert.equal(entity.ObjectTypeCode, 10500);
  assert.equal(entity.IsAuditEnabled.Value, false);
});

test("global option sets written by the option-set writer read back, and a bound 1.9 column reports them", () => {
  const sets = {
    sample_colors: { name: "sample_colors", displayLabels: { 1033: "Colors" }, type: "picklist", options: [{ value: 100000000, label: "Red", labels: { 1033: "Red" } }] },
  };
  const service = createMetadataService({
    organizationId: ORG,
    schema: () => null,
    mappings: () => ({
      paint: {
        entitySet: "paints", idColumn: "paintid", nameColumn: "name",
        fields: {
          name: { dataverseType: "nvarchar" },
          color: { dataverseType: "picklist", globalOptionSet: "sample_colors" },
          tint: { dataverseType: "picklist", columnMetadata: { type: "picklist", optionSet: { isGlobal: true, name: "sample_colors" } } },
        },
      },
    }),
    globalOptionSets: () => sets,
  });
  assert.deepEqual(service.globalOptionSets().map((s) => s.Name), ["sample_colors"]);
  const set = service.globalOptionSet("sample_colors");
  assert.equal(set.DisplayName.UserLocalizedLabel.Label, "Colors");
  assert.equal(set.Options[0].Value, 100000000);
  assert.equal(set.Options[0].Label.UserLocalizedLabel.Label, "Red");
  assert.equal(service.attributeOptionSet("paint", "color", { global: true }).Name, "sample_colors");
  assert.equal(service.attributeOptionSet("paint", "tint", { global: true }).Name, "sample_colors", "the columnMetadata binding reads too");
});

test("relationship schema names: N:N without one is the intersect table, 1:N is table_nav", () => {
  assert.equal(relationshipSchemaName("widget", "tags", MAPPINGS.widget.relationships.tags), "widget_tags");
  assert.equal(relationshipSchemaName("widget", "tags", { intersect: { entity: "widget_tag" } }), "widget_tag");
  assert.equal(relationshipSchemaName("gadget", "widget", { entity: "widget" }), "gadget_widget");
});

test("privileges: EntityFilters bit 4 gives the rights with security's names and ids; organization-owned tables get six", () => {
  const user = extended.retrieveEntityResponse("widget", "Privileges").EntityMetadata;
  assert.equal(user.Privileges.length, 8, "user-owned: eight rights");
  const read = user.Privileges.find((p) => p.Name === "prvReadWidget");
  assert.equal(read.PrivilegeType, 2);
  assert.equal(read.PrivilegeId, privilegeId(ORG, "prvReadWidget"));
  assert.equal(read.CanBeBasic, true);
  assert.equal(read.CanBeGlobal, true);
  const org = extended.retrieveEntityResponse("orgbox", "Privileges").EntityMetadata;
  assert.equal(org.Privileges.length, 6, "organization-owned: no Assign or Share");
  assert.ok(!org.Privileges.some((p) => p.PrivilegeType === 5 || p.PrivilegeType === 6));
  assert.equal(org.Privileges.find((p) => p.Name === "prvReadOrgbox").CanBeBasic, false);
  assert.equal(extended.retrieveEntityResponse("widget", "Attributes").EntityMetadata.Privileges, undefined, "not requested, not returned");
  const systemuser = extended.retrieveEntityResponse("systemuser", "Privileges").EntityMetadata;
  assert.ok(systemuser.Privileges.some((p) => p.Name === "prvReadUser" && p.PrivilegeId === privilegeId(ORG, "prvReadUser")), "systemuser privileges use the User noun");
  assert.ok(!systemuser.Privileges.some((p) => /prv\w+Systemuser$/.test(p.Name)));
});

test("change log: changed children, containing tables with HasChanged false, deletes behind a filter, expiry", () => {
  const T0 = Date.UTC(2026, 9, 19, 10, 0, 0);
  const log = [];
  const tracked = createMetadataService({ organizationId: ORG, schema: () => null, mappings: () => MAPPINGS, changeLog: () => log, clock: () => T0 });
  const start = tracked.retrieveMetadataChanges(null).ServerVersionStamp;
  assert.equal(start, "0!10/19/2026 10:00:00");
  assert.equal(tracked.retrieveMetadataChanges(null, { clientVersionStamp: start }).EntityMetadata.length, 0);

  log.push({ seq: 1, at: T0 + 1000, op: "change", kind: "attribute", logical: "widget", name: "price" });
  const one = tracked.retrieveMetadataChanges(null, { clientVersionStamp: start });
  assert.equal(one.ServerVersionStamp, "1!10/19/2026 10:00:01");
  assert.deepEqual(names(one.EntityMetadata), ["widget"]);
  assert.equal(one.EntityMetadata[0].HasChanged, false, "the containing table did not change");
  assert.deepEqual(one.EntityMetadata[0].Attributes.map((a) => [a.LogicalName, a.HasChanged]), [["price", true]]);

  log.push({ seq: 2, at: T0 + 2000, op: "change", kind: "entity", logical: "gadget", name: null });
  const gadget = tracked.retrieveMetadataChanges(null, { clientVersionStamp: one.ServerVersionStamp }).EntityMetadata;
  assert.deepEqual(names(gadget), ["gadget"]);
  assert.equal(gadget[0].HasChanged, true);
  assert.ok(gadget[0].Attributes.length > 0 && gadget[0].Attributes.every((a) => a.HasChanged === false), "the table's own change keeps every child, none flagged");

  log.push({ seq: 3, at: T0 + 3000, op: "delete", kind: "attribute", logical: "widget", name: "code" });
  const since2 = "2!10/19/2026 10:00:02";
  const deleted = tracked.retrieveMetadataChanges(null, { clientVersionStamp: since2, deletedMetadataFilters: "Attribute" }).DeletedMetadata;
  assert.deepEqual(deleted, { Count: 1, IsReadOnly: false, Keys: ["Attribute"], Values: [[tracked.metadataId("attribute", "widget", "code")]] });
  assert.equal(tracked.retrieveMetadataChanges(null, { clientVersionStamp: since2 }).DeletedMetadata.Count, 0, "no filter, no deleted items");

  const expired = (e) => e.details?.innerCode === "0x80044352";
  assert.throws(() => tracked.retrieveMetadataChanges(null, { clientVersionStamp: "9!10/19/2026 10:00:09" }), expired, "ahead of the server");
  assert.throws(() => tracked.retrieveMetadataChanges(null, { clientVersionStamp: "1!01/01/2020 00:00:00" }), expired, "older than 90 days");
  const trimmed = createMetadataService({ organizationId: ORG, schema: () => null, mappings: () => MAPPINGS, changeLog: () => [{ seq: 5, at: T0, op: "change", kind: "entity", logical: "tag" }], clock: () => T0 });
  assert.throws(() => trimmed.retrieveMetadataChanges(null, { clientVersionStamp: "2!10/19/2026 10:00:00" }), expired, "before the log start");

  const named = tracked.retrieveMetadataChanges({ Properties: { AllProperties: false, PropertyNames: ["Privileges"] } }, { clientVersionStamp: "3!10/19/2026 10:00:03" }).EntityMetadata;
  assert.equal(named.length, 3, "named Privileges come back for every table, changed or not");
  assert.ok(named.every((e) => e.HasChanged === false && e.Privileges.length > 0));
});

test("csdl: registry fragments join the schema; change-tracked entity sets carry the annotation only with annotations=true", () => {
  const withFragment = createMetadataService({ organizationId: ORG, schema: () => null, mappings: () => MAPPINGS, extraCsdl: () => '<Function Name="PaqFragment" />' });
  const plain = withFragment.csdl(null);
  assertWellFormed(plain);
  assert.match(plain, /<Function Name="PaqFragment" \/>/);
  assert.ok(!plain.includes('<Member Name="Entity" />'), "the Web API DeletedMetadataFilters enum has no Entity member");

  const tracked = createMetadataService({
    organizationId: ORG,
    schema: () => null,
    mappings: () => ({ ...MAPPINGS, gadget: { ...MAPPINGS.gadget, dataverseMetadata: { ChangeTrackingEnabled: true } } }),
  });
  const annotated = tracked.csdl(null, { annotations: true });
  assertWellFormed(annotated);
  // One EntitySet element by name, self-closing or with children.
  const setOf = (xml, name) => [...xml.matchAll(/<EntitySet Name="[^"]+"[^>]*\/>|<EntitySet Name="[^"]+"[^>]*>[\s\S]*?<\/EntitySet>/g)].map((m) => m[0]).find((s) => s.includes(`Name="${name}"`));
  assert.match(setOf(annotated, "gadgets"), /<Annotation Term="Org\.OData\.Capabilities\.V1\.ChangeTracking">\s*<Record>\s*<PropertyValue Property="Supported" Bool="true" \/>/);
  assert.ok(!setOf(annotated, "widgets").includes("ChangeTracking"));
  assert.ok(!setOf(tracked.csdl(null), "gadgets").includes("ChangeTracking"), "entity-set annotations are opt-in");
});

// Standard tables: the seeded mappings (seedStandard) read the documented columns, labels and ownership.
const standardState = seedStandard({ state: {} });
const STANDARD = createMetadataService({ organizationId: ORG, schema: () => null, mappings: () => standardState.mappings });
const standardAttribute = (table, column) => STANDARD.attributes(table).find((a) => a.LogicalName === column);

test("standard account: SchemaName, primary name, ownership and the column facts from the reference", () => {
  const account = STANDARD.entity("account");
  assert.equal(account.SchemaName, "Account");
  assert.equal(account.PrimaryNameAttribute, "name");
  assert.equal(account.OwnershipType, "UserOwned");
  assert.equal(account.IsActivity, false);
  assert.equal(standardAttribute("account", "name").MaxLength, 160);
  assert.equal(standardAttribute("account", "name").RequiredLevel.Value, "ApplicationRequired");
  const industry = standardAttribute("account", "industrycode");
  assert.equal(industry["@odata.type"], "#Microsoft.Dynamics.CRM.PicklistAttributeMetadata");
  assert.equal(industry.OptionSet.Options.find((o) => o.Value === 1).Label.UserLocalizedLabel.Label, "Accounting");
  assert.equal(standardAttribute("account", "donotemail").DefaultValue, false);
  assert.equal(standardAttribute("account", "statecode").OptionSet.Options[0].DefaultStatus, 1);
  assert.equal(STANDARD.entity("organization").OwnershipType, "OrganizationOwned");
});

test("standard activities: task is an activity, and the activity columns are typed as party lists and managed properties", () => {
  assert.equal(STANDARD.entity("task").IsActivity, true);
  assert.equal(STANDARD.entity("task").OwnershipType, "UserOwned");
  assert.equal(standardAttribute("activitypointer", "allparties").AttributeType, "PartyList");
  assert.equal(standardAttribute("connectionrole", "iscustomizable").AttributeType, "ManagedProperty");
});

test("a Solution account overrides the columns it declares; the standard columns it omits remain", () => {
  const SOLUTION_ACCOUNT = {
    lcid: 1033,
    targets: {},
    optionSets: {},
    relationships: {},
    tables: {
      account: {
        logicalName: "account",
        entitySetName: "accounts",
        primaryIdAttribute: "accountid",
        primaryNameAttribute: "name",
        ownership: "UserOwned",
        labels: { 1033: "Account" },
        collectionLabels: { 1033: "Accounts" },
        schemaComplete: false,
        attributes: {
          accountid: { name: "accountid", type: "primarykey", requiredLevel: "systemrequired", labels: {} },
          name: { name: "name", type: "nvarchar", maxLength: 200, requiredLevel: "applicationrequired", isPrimaryName: true, labels: { 1033: "Account Name" } },
          x_tier: { name: "x_tier", type: "int", requiredLevel: "none", labels: { 1033: "Tier" } },
        },
      },
    },
  };
  const overridden = createMetadataService({ organizationId: ORG, schema: () => SOLUTION_ACCOUNT, mappings: () => standardState.mappings });
  const columns = overridden.attributes("account");
  const column = (name) => columns.find((a) => a.LogicalName === name);
  assert.equal(column("name").MaxLength, 200);
  assert.ok(column("x_tier"), "x_tier is added");
  assert.ok(column("industrycode"), "industrycode stays from the standard file");
  assert.equal(overridden.entity("account").OwnershipType, "UserOwned");
});

test("metadata keys under $select carry the selected properties and no @odata.type", () => {
  const all = mapped.keys("widget");
  assert.equal(all[0]["@odata.type"], "#Microsoft.Dynamics.CRM.EntityKeyMetadata");
  const selected = mapped.keys("widget", { select: "LogicalName,EntityKeyIndexStatus,KeyAttributes" });
  assert.deepEqual(Object.keys(selected[0]).sort(), ["EntityKeyIndexStatus", "KeyAttributes", "LogicalName", "MetadataId"]);
  assert.deepEqual(selected[0].KeyAttributes, ["code"]);
});

test("csdl: activitypointer is abstract with the activityid key, and an activity derives from it with its own columns only", () => {
  const xml = STANDARD.csdl("https://org.example");
  assertWellFormed(xml);
  assert.match(block(xml, "activitypointer"), /<EntityType Name="activitypointer" BaseType="mscrm\.crmbaseentity" Abstract="true">\s*<Key>\s*<PropertyRef Name="activityid" \/>/);
  const task = block(xml, "task");
  assert.match(task, /<EntityType Name="task" BaseType="mscrm\.activitypointer">/);
  // Native $metadata also declares the key on the derived type.
  assert.match(task, /<Key>\s*<PropertyRef Name="activityid" \/>\s*<\/Key>/);
  assert.doesNotMatch(task, /<Property Name="activityid"/);
  assert.match(task, /<Property Name="percentcomplete"/);
  assert.match(block(xml, "account"), /<EntityType Name="account" BaseType="mscrm\.crmbaseentity">/);
});
