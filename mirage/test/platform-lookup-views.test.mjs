import test from "node:test";
import assert from "node:assert/strict";
import { lookupModel, platformLookupView, buildLayout } from "../lib/native-services.mjs";

const portal = { forms: [{ id: "f1", name: "Gadget", metadata: {} }] };
const schemas = { f1: { entity: "gadget", fields: [{ name: "ownerid", type: "lookup", lookupTargets: ["contact", "account", "transactioncurrency", "vendor"] }] } };
const store = {
  resolveMapping: (entity) => ({ idColumn: `${entity}id`, nameColumn: entity === "contact" ? "fullname" : "name", relationships: {} }),
};

test("system-table lookups without an exported view use the platform default lookup views; other tables keep the synthesized projection", () => {
  const model = lookupModel({ portal, schemas, metadata: { views: [] }, store, kind: "entityform", formId: "f1", field: "ownerid" });
  const [contact, account, currency, vendor] = model.views;
  assert.equal(contact.name, "Contacts Lookup View");
  assert.deepEqual(contact.fields.map((f) => [f.name, f.width]), [["fullname", 300], ["emailaddress1", 200], ["telephone1", 125], ["parentcustomerid", 150], ["address1_city", 100], ["address1_telephone1", 125]]);
  assert.match(contact.fetchXml, /<order attribute="fullname"\/>/);
  assert.equal(account.name, "Account Lookup View");
  assert.doesNotMatch(account.fetchXml, /<order/);
  assert.equal(currency.fields.length, 5);
  assert.equal(vendor.synthesized, true);
  assert.equal(platformLookupView("vendor"), null);
});

test("an exported default lookup view of a system table wins over the platform catalog", () => {
  const metadata = { views: [{ id: "custom-contact", entity: "contact", name: "Custom Contacts", queryType: 64, isDefault: true, fetchXml: '<fetch><entity name="contact"/></fetch>', fields: [{ name: "fullname", width: 200 }] }] };
  const model = lookupModel({ portal, schemas, metadata, store, kind: "entityform", formId: "f1", field: "ownerid" });
  assert.equal(model.views[0].id, "custom-contact");
});

test("platform lookup columns carry their labels, widths and column types without exported metadata", () => {
  const view = platformLookupView("account");
  const layout = buildLayout({ view, entity: "account", idColumn: "accountid", primaryName: "name", metadata: { entities: {} }, configuration: {}, secure: {}, selectColumn: "visually-hidden" });
  const columns = layout.Columns.filter((c) => c.Type === 0);
  assert.deepEqual(columns.map((c) => c.Name), ["Account Name", "Email", "Main Phone", "Account Number", "Primary Contact", "Address 1: City"]);
  assert.equal(columns[4].Metadata.AttributeType, 6);
  assert.equal(layout.ColumnsTotalWidth, 970);
  assert.equal(layout.SortExpression, "");
  assert.equal(layout.ViewName, "Account Lookup View");
});
