import test from "node:test";
import assert from "node:assert/strict";
import { renderComponent } from "../lib/platform.mjs";
import { webFormsForm } from "../lib/platform-manifest.mjs";

// Survey form: basic form metadata gives whole numbers, a choice and a two-option
// column the platform's survey control styles (adx_controlstyle + adx_groupname).
const ID = "d0000000-0000-4000-8000-000000000001";
const record = { widgetid: ID, first: 1, second: 2, third: 3, fourth: 4, fifth: 5, colour: 2, agreed: true, other: false };
const fields = [
  { name: "first", label: "First", dataverseType: "int" },
  { name: "second", label: "Second", dataverseType: "int" },
  { name: "third", label: "Third", dataverseType: "int" },
  { name: "fourth", label: "Fourth", dataverseType: "int" },
  { name: "fifth", label: "Fifth", dataverseType: "int" },
  { name: "colour", label: "Colour", dataverseType: "picklist", options: [{ value: 1, label: "Red" }, { value: 2, label: "Green" }, { value: 3, label: "Blue" }] },
  { name: "agreed", label: "Agreed", dataverseType: "boolean" },
  { name: "other", label: "Other", dataverseType: "boolean" },
];
const layout = [{ name: "tab", columns: [{ sections: [{ name: "survey", label: "Survey", showLabel: true, rows: fields.map((field) => [{ name: field.name, label: field.label }]) }] }] }];
const meta = (name, style, group) => ({ kind: "basicformmetadata", adx_entityform: "form", adx_type: 100000000, adx_attributelogicalname: name, adx_controlstyle: style, adx_groupname: group });

async function render(records) {
  const store = { resolveMapping: () => ({ entitySet: "widgets", idColumn: "widgetid" }), get: async () => record, query: async () => ({ value: [] }) };
  const portal = { forms: [{ id: "form", name: "Survey", mode: 100000001 }], records, website: { id: "site" }, pages: [], settings: { "Site/BootstrapV5Enabled": "true" } };
  const schemas = { form: { entity: "widget", title: "Survey", fields, layout } };
  return renderComponent("entityform", "form", { user: { id: "current" }, request: { params: { id: ID } } }, { portal, store, schemas });
}

test("survey control styles: constant sum, rank order, matrix and multiple choice cells", async () => {
  const html = await render([
    meta("first", 100000003, "sum"), meta("second", 100000003, "sum"),
    meta("third", 100000004, "ranks"), meta("fourth", 100000005, "ties"),
    meta("colour", 100000006, "grid"), meta("agreed", 100000007, "choice"), meta("other", 100000007, "choice"),
  ]);
  // Constant sum: narrow boxes; the group's last box carries the total and its validator, the
  // first member's row is followed by the hidden member count.
  assert.match(html, /<td colspan="1" rowspan="1" class="clearfix cell constant-sum form-control-cell">/);
  assert.match(html, /<input name="[^"]*\$first" type="text" value="1" id="first" class="text integer sum " onchange="setIsDirty\(this\.id\);setPrecision\(this\.id\);updateConstantSum\('sum'\);" style="width:30px;"><\/div>/);
  assert.match(html, /id="second" class="text integer sum "[^>]*><input name="[^"]*\$ConstantSumTotalValuesum" type="text" value="0" id="ConstantSumTotalValuesum" class="total" readonly="readonly" style="width:30px;"><span id="ConstantSumTotalValidatorsum" class="validator-text" style="visibility:hidden;">\*<\/span>/);
  assert.match(html, /<\/tr><input type="hidden" name="[^"]*\$ConstantSumIndexsum" id="ConstantSumIndexsum" value="2"><tr>/);
  assert.equal(html.match(/ConstantSumIndexsum" id=/g).length, 1);
  // Rank order: no ties adds the tie validator; allow ties does not.
  assert.match(html, /class="clearfix cell rank-order-cell">.*?<input name="[^"]*\$third" type="text" value="3" id="third" class="form-control text integer  ranks" onchange="setPrecision\(this\.id\);setIsDirty\(this\.id\);" style="width:30px;"><span id="RankOrderTieValidatorthird" class="validator-text" style="visibility:hidden;">\*<\/span>/);
  assert.match(html, /id="fourth" class="form-control text integer  ties" onchange="setPrecision\(this\.id\);setIsDirty\(this\.id\);" style="width:30px;"><\/div>/);
  // Matrix: reversed options in one table row, the label without a for attribute.
  assert.match(html, /class="clearfix cell picklist-matrix-cell"><div class="table-info"><label id="colour_label" class="field-label">Colour<\/label>/);
  assert.match(html, /<table id="colour" class="picklist horizontal labels-top " role="presentation" onchange="setIsDirty\(this\.id\);"><tr><td><label for="colour_0"><span class='visually-hidden'>Colour <\/span>Blue<\/label><input id="colour_0" type="radio" name="[^"]*\$colour" value="3"><\/td><td><label for="colour_1">.*?Green<\/label><input id="colour_1" type="radio" name="[^"]*" value="2" checked="checked"><\/td>/);
  // Multiple choice: check boxes classed by group; the group validator follows the first box only.
  assert.match(html, /<span class="checkbox checkbox  choice"><input id="agreed" type="checkbox" name="[^"]*\$agreed" checked="checked" onclick="setIsDirty\(this\.id\);"><\/span><span id="multipleChoiceValidatorchoice" class="validator-text" style="display:none;"><\/span>/);
  assert.match(html, /<span class="checkbox checkbox  choice"><input id="other" type="checkbox" name="[^"]*\$other" onclick="setIsDirty\(this\.id\);"><\/span><\/div>/);
});

test("stack rank cells load the platform stack ranking plug-in after the entity form view script", async () => {
  const html = await render([meta("first", 100000008, "stack"), meta("second", 100000008, "stack")]);
  assert.match(html, /class="clearfix cell stack-rank-cell">/);
  assert.match(html, /id="first" class="form-control text integer  stack" onchange="setPrecision\(this\.id\);setIsDirty\(this\.id\);" style="width:30px;">/);
  const form = webFormsForm({ content: html, variant: "BootstrapV5" });
  assert.match(form, /crmentityformview\.js" type="text\/javascript"><\/script>\n<script src="\/xrm-adx\/js\/jquery\.stackranking\.js"/);
  assert.doesNotMatch(webFormsForm({ content: await render([]), variant: "BootstrapV5" }), /stackranking/);
});
