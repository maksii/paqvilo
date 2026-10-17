import test from "node:test";
import assert from "node:assert/strict";
import { renderComponent } from "../lib/platform.mjs";

// Invented "person" table with a computed fullname column (valid for neither create nor update)
// on a read-only form; a text box with the same (text box) classid stays a plain box.
test("the full name composite control renders a required composite box without a maximum length", async () => {
  const ID = "f0000000-0000-4000-8000-000000000001";
  const fields = [
    { name: "fullname", label: "Full Name", dataverseType: "nvarchar", maxLength: 160, validForCreate: false, validForUpdate: false, controlClassId: "{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" },
    { name: "nickname", label: "Nickname", dataverseType: "nvarchar", maxLength: 50, controlClassId: "{4273EDBD-AC1D-40d3-9FB2-095C621B552D}" },
  ];
  const store = { resolveMapping: () => ({ entitySet: "people", idColumn: "personid" }), get: async () => ({ personid: ID, fullname: "Ada Lovelace", nickname: "Ada" }), query: async () => ({ value: [] }) };
  const portal = { forms: [{ id: "form", name: "Person", mode: 100000002 }], records: [], website: { id: "site" }, pages: [], settings: { "Site/BootstrapV5Enabled": "true" } };
  const schemas = { form: { entity: "person", title: "Person", fields, layout: [{ name: "t", columns: [{ sections: [{ name: "s", rows: [[{ name: "fullname" }], [{ name: "nickname" }]] }] }] }] } };
  const html = await renderComponent("entityform", "form", { user: { id: "current" }, request: { params: { id: ID } } }, { portal, store, schemas });
  assert.match(html, /<div class="table-info required"><label for="fullname" id="fullname_label" class="field-label" readonly="readonly">Full Name<\/label><div class="validators"><span id="RequiredFieldValidatorfullname"[^>]*>\*<\/span><\/div><\/div>/);
  assert.match(html, /<input name="[^"]*\$fullname" type="text" value="Ada Lovelace" id="fullname" class="trigger text form-control  fullNameCompositeControl readonly" data-composite-control="" data-content-id="[0-9a-f-]{36}" data-editable="False" data-content-template="\{fullnamefirstname\} \{fullnamelastname\}" onchange="setIsDirty\(this\.id\);" readonly="readonly">/);
  assert.doesNotMatch(html, /MaximumLengthValidatorfullname/);
  assert.match(html, /MaximumLengthValidatornickname/);
  assert.doesNotMatch(html, /id="nickname" class="trigger/);
});

test("a computed composite address renders the address trigger box and its part boxes", async () => {
  const ID = "f0000000-0000-4000-8000-000000000002";
  const fields = [{ name: "address1_composite", label: "Address", dataverseType: "memo", maxLength: 1000, validForCreate: false, validForUpdate: false }];
  const store = { resolveMapping: () => ({ entitySet: "people", idColumn: "personid" }), get: async () => ({ personid: ID, address1_city: "Leeds" }), query: async () => ({ value: [] }) };
  const portal = { forms: [{ id: "form", name: "Person", mode: 100000002 }], records: [], website: { id: "site" }, pages: [], settings: { "Site/BootstrapV5Enabled": "true" } };
  const schemas = { form: { entity: "person", title: "Person", fields, layout: [{ name: "t", columns: [{ sections: [{ name: "s", rows: [[{ name: "address1_composite" }]] }] }] }] } };
  const html = await renderComponent("entityform", "form", { user: { id: "current" }, request: { params: { id: ID } } }, { portal, store, schemas });
  assert.match(html, /<td colspan="1" rowspan="1" class="clearfix cell text form-control-cell">/);
  assert.match(html, /<textarea name="[^"]*\$address1_composite" rows="4" cols="20" id="address1_composite" class="trigger text form-control  addressCompositeControl readonly " data-composite-control="" data-content-id="([0-9a-f-]{36})" data-editable="False" data-content-template="\{address1_composite_line1\} \{address1_composite_line2\} \{address1_composite_line3\}\{BREAK\}\{address1_composite_city\} \{address1_composite_stateorprovince\} \{address1_composite_postalcode\}\{BREAK\}\{address1_composite_country\}" readonly="readonly"><\/textarea><div id="\1" class="content d-none addressCompositeControlContainer">/);
  assert.match(html, /<input name="[^"]*\$address1_composite_city" type="text" id="address1_composite_city" class=" content  text form-control" value="Leeds" aria-label="City" onchange="setIsDirty\(this\.id\);" readonly="readonly">/);
  assert.match(html, /<input id="popoverUpdateButton_[0-9a-f-]{36}" class="btn btn-primary w-100" role="button" aria-label="Done" readonly="true" value="Done"><\/div>/);
  assert.doesNotMatch(html, /LimitInput/);
});
