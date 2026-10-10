import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  importSolutionMetadata,
  parseSolutionXml,
} from "../lib/solution-metadata.mjs";
import { formCells } from "../lib/native-services.mjs";
async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "solution-metadata-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, xml] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, xml);
  }
  return root;
}
const form = (title) =>
  `<forms xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><systemform><formid>{form-id}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="tab_1" id="tab-id"><labels><label description="General" languagecode="1033"/></labels><columns><column width="100%"><sections><section name="general" showlabel="true"><labels><label description="General &gt; label" languagecode="1033"/></labels><rows><row><cell showlabel="true"><labels><label description="${title}" languagecode="1033"/></labels><control id="name-control" datafieldname="fullname" disabled="false"/></cell></row></rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Portal edit" languagecode="1033"/></LocalizedNames></systemform></forms>`;
const entity =
  '<Entity><Name>contact</Name><EntityInfo><entity><attributes><attribute PhysicalName="fullname"><Name>fullname</Name><LogicalName>fullname</LogicalName><Type>nvarchar</Type><RequiredLevel>required</RequiredLevel><MaxLength>120</MaxLength><displaynames><displayname description="Name" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>';
const view =
  '<savedqueries><savedquery><savedqueryid>{view-id}</savedqueryid><layoutxml><grid><row><cell name="fullname" width="200"/></row></grid></layoutxml><fetchxml><fetch><entity name="contact"><attribute name="fullname"/></entity></fetch></fetchxml><LocalizedNames><LocalizedName description="Portal contacts" languagecode="1033"/></LocalizedNames></savedquery></savedqueries>';
const portal = () => ({
  forms: [
    {
      id: "basic-form",
      name: "Edit contact",
      entityName: "contact",
      formName: "Portal edit",
      metadata: { adx_tabname: "General" },
    },
  ],
  lists: [
    {
      id: "list",
      name: "Contacts",
      entityName: "contact",
      metadata: { adx_view: "view-id" },
    },
  ],
  advancedForms: [],
  records: [],
});

test("global option-set references resolve labels across solution roots and unresolved choices remain explicit", async (t) => {
  const first = await fixture(t, {
    "OptionSets/choice.xml":
      '<optionset Name="shared_choice"><options><option value="172250000"><labels><label description="Yes" languagecode="1033"/></labels></option></options></optionset>',
  });
  const second = await fixture(t, {
    "Entities/Contact/Entity.xml": entity.replace(
      "<Type>nvarchar</Type>",
      "<Type>picklist</Type><OptionSetName>shared_choice</OptionSetName>",
    ),
    "Entities/Contact/FormXml/main/form.xml": form("Choice"),
  });
  const resolved = await importSolutionMetadata([first, second], {
    portal: portal(),
  });
  assert.deepEqual(resolved.entities.contact.fields.fullname.options, [
    { value: 172250000, label: "Yes" },
  ]);
  assert.equal(
    resolved.componentSchemas["basic-form"].fields[0].type,
    "number",
  );
  assert.deepEqual(resolved.componentSchemas["basic-form"].fields[0].options, [
    { value: 172250000, label: "Yes" },
  ]);
  assert.equal(
    resolved.entities.contact.fields.fullname.optionSetSource,
    await fs.realpath(path.join(first, "OptionSets", "choice.xml")),
  );
  const unresolved = await importSolutionMetadata(second, { portal: portal() });
  assert.deepEqual(
    unresolved.componentSchemas["basic-form"].fields[0].options,
    [],
  );
  assert.equal(
    unresolved.diagnostics.filter(
      (d) => d.code === "SOLUTION_OPTIONSET_UNRESOLVED",
    ).length,
    1,
  );
});

test("native state and status choices retain their source-declared associations", async (t) => {
  const root = await fixture(t, {
    "Entities/Contact/Entity.xml": entity.replace(
      "</attributes>",
      '<attribute PhysicalName="statecode"><Name>statecode</Name><Type>state</Type><optionset><states><state value="0" defaultstatus="7" invariantname="Active"><labels><label description="Open" languagecode="1033"/></labels></state></states></optionset></attribute><attribute PhysicalName="statuscode"><Name>statuscode</Name><Type>status</Type><optionset><statuses><status value="7" state="0"><labels><label description="Pending" languagecode="1033"/></labels></status></statuses></optionset></attribute></attributes>',
    ),
  });
  const metadata = await importSolutionMetadata(root);
  assert.equal(
    metadata.entities.contact.fields.statecode.states[0].defaultStatus,
    7,
  );
  assert.equal(
    metadata.entities.contact.fields.statuscode.statuses[0].state,
    0,
  );
  assert.equal(
    metadata.entities.contact.fields.statecode.options[0].label,
    "Open",
  );
  assert.equal(
    metadata.entities.contact.fields.statuscode.options[0].label,
    "Pending",
  );
});

test("invisible native tabs do not add duplicate required bindings to portal forms", async (t) => {
  const base = form("Name");
  const tab = /<tab\b[\s\S]*?<\/tab>/.exec(base)[0];
  const hidden = tab.replace(
    'name="tab_1"',
    'name="tab_hidden" visible="false"',
  );
  const root = await fixture(t, {
    "Entities/Contact/Entity.xml": entity,
    "Entities/Contact/FormXml/main/{form-id}.xml": base.replace(
      "</tabs>",
      hidden + "</tabs>",
    ),
  });
  const site = portal();
  site.forms[0].metadata = {};
  const metadata = await importSolutionMetadata(root, { portal: site });
  const schema = metadata.componentSchemas["basic-form"];
  assert.equal(schema.layout.length, 1);
  assert.deepEqual(
    schema.fields.map((f) => f.name),
    ["fullname"],
  );
});

test("native audit and operation-specific immutable columns retain exported Dataverse write capabilities", async (t) => {
  const xml = entity.replace(
    "<MaxLength>120</MaxLength>",
    "<MaxLength>120</MaxLength><ValidForCreateApi>1</ValidForCreateApi><ValidForUpdateApi>0</ValidForUpdateApi>",
  );
  const root = await fixture(t, {
    "Entities/Contact/Entity.xml": xml,
    "Entities/Contact/FormXml/main/{form-id}.xml": form("Name"),
  });
  const site = portal();
  site.forms[0].mode = 100000001;
  const update = await importSolutionMetadata(root, { portal: site });
  assert.equal(
    update.componentSchemas["basic-form"].fields[0].validForUpdate,
    false,
  );
  assert.equal(update.componentSchemas["basic-form"].fields[0].readOnly, true);
  site.forms[0].mode = 100000000;
  const create = await importSolutionMetadata(root, { portal: site });
  assert.equal(create.componentSchemas["basic-form"].fields[0].readOnly, false);
});

test("PAC advanced steps with omitted mode retain the platform Insert default", async (t) => {
  const root = await fixture(t, {
    "Solution/Entities/Contact/Entity.xml": entity,
    "Solution/Entities/Contact/FormXml/main/{form-id}.xml":
      form("Friendly name"),
  });
  const site = portal();
  site.advancedForms = [
    {
      id: "wizard",
      name: "Wizard",
      metadata: { adx_startstep: "create-step" },
    },
  ];
  site.records = [
    {
      kind: "advancedformstep",
      id: "create-step",
      name: "Create",
      adx_webform: "wizard",
      adx_targetentitylogicalname: "contact",
      adx_formname: "Portal edit",
    },
  ];
  const result = await importSolutionMetadata(root, { portal: site });
  assert.equal(result.componentSchemas.wizard.steps[0].mode, 100000000);
});

test('PAC redirect step import does not invent a missing record query name', async t => {
  const root = await fixture(t, { 'Solution/Entities/Contact/Entity.xml': entity });
  const site = portal();
  site.pages = [{ id: 'done', url: '/done/' }];
  site.advancedForms = [{ id: 'wizard', name: 'Wizard', metadata: { adx_startstep: 'redirect' } }];
  site.records = [{ kind: 'advancedformstep', id: 'redirect', adx_webform: 'wizard', adx_type: 100000003, adx_redirectwebpage: 'done', adx_redirecturlappendentityidquerystring: true }];
  const omitted = await importSolutionMetadata(root, { portal: site });
  assert.equal(omitted.componentSchemas.wizard.steps[0].recordQueryName, null);
  site.records[0].adx_redirecturlquerystringname = 'record';
  const named = await importSolutionMetadata(root, { portal: site });
  assert.equal(named.componentSchemas.wizard.steps[0].recordQueryName, 'record');
});

test("rich text controls resolve their per-control managed configuration from systemform descriptions", async (t) => {
  const richForm = form("Narrative")
    .replace(
      'datafieldname="fullname" disabled="false"',
      'datafieldname="fullname" disabled="false" uniqueid="{rich-control}"',
    )
    .replace(
      "</tabs>",
      '</tabs><controlDescriptions><controlDescription forControl="{rich-control}"><customControl formFactor="0" name="MscrmControls.RichTextEditor.RichTextEditorControl"><parameters><value>fullname</value><configUrl static="true" type="SingleLine.URL">/WebResources/custom-rte.json</configUrl></parameters></customControl></controlDescription></controlDescriptions>',
    );
  const root = await fixture(t, {
    "Entities/Contact/Entity.xml": entity,
    "Entities/Contact/FormXml/main/{form-id}.xml": richForm,
  });
  const result = await importSolutionMetadata(root, { portal: portal() });
  assert.deepEqual(result.componentSchemas["basic-form"].fields[0].richText, {
    name: "MscrmControls.RichTextEditor.RichTextEditorControl",
    configUrl: "/WebResources/custom-rte.json",
  });
});
test('native PCF bindings preserve desktop selection, static values and sibling form factors from exported FormXml', async t => {
  const customForm = form('Profile')
    .replace('datafieldname="fullname" disabled="false"', 'datafieldname="fullname" disabled="false" uniqueid="{pcf-control}"')
    .replace('</tabs>', '</tabs><controlDescriptions><controlDescription forControl="{pcf-control}"><customControl id="{4273edbd-ac1d-40d3-9fb2-095c621b552d}"><parameters><datafieldname>fullname</datafieldname></parameters></customControl><customControl name="tst_Synthetic.Editor" formFactor="0"><parameters><value type="SingleLine.Text">fullname</value><caption static="true" type="SingleLine.Text">Exported caption</caption><rows><complex/></rows></parameters></customControl><customControl name="tst_Synthetic.TabletEditor" formFactor="1"><parameters><value>fullname</value></parameters></customControl></controlDescription></controlDescriptions>');
  const root = await fixture(t, { 'Entities/Contact/Entity.xml': entity, 'Entities/Contact/FormXml/main/{form-id}.xml': customForm });
  const result = await importSolutionMetadata(root, { portal: portal() });
  const field = result.componentSchemas['basic-form'].fields[0];
  assert.equal(field.codeComponent.name, 'tst_Synthetic.Editor');
  assert.equal(field.codeComponent.formFactor, '0');
  assert.equal(field.codeComponent.controlId, 'pcf-control');
  assert.equal(field.codeComponent.sourceFile, path.join(root, 'Entities/Contact/FormXml/main/{form-id}.xml'));
  assert.deepEqual(field.codeComponent.parameters.value, { kind: 'binding', column: 'fullname', type: 'SingleLine.Text' });
  assert.deepEqual(field.codeComponent.parameters.caption, { kind: 'static', value: 'Exported caption', type: 'SingleLine.Text' });
  assert.equal(field.codeComponent.parameters.rows.kind, 'unresolved');
  assert.deepEqual(field.codeComponent.boundAttributes, ['fullname']);
  assert.deepEqual(field.codeComponents.map(component => component.name), ['tst_Synthetic.Editor', 'tst_Synthetic.TabletEditor']);
  const mobileOnly = customForm.replace('formFactor="0"', 'formFactor="2"');
  await fs.writeFile(path.join(root, 'Entities/Contact/FormXml/main/{form-id}.xml'), mobileOnly);
  const second = await importSolutionMetadata(root, { portal: portal() });
  assert.equal(second.componentSchemas['basic-form'].fields[0].codeComponent, undefined);
  assert.equal(second.componentSchemas['basic-form'].fields[0].codeComponents.length, 2);
});

test("metadata-only save attributes and Web API column views import their actual table definitions", async (t) => {
  const contactEntity = entity.replace(
    "</attributes>",
    '<attribute PhysicalName="modifiedcontact"><LogicalName>modifiedcontact</LogicalName><Type>lookup</Type></attribute><attribute PhysicalName="creator"><LogicalName>creator</LogicalName><Type>lookup</Type></attribute></attributes>',
  );
  const accountEntity = entity.replace(/contact/g, "account");
  const apiView = view
    .replace(/view-id/g, "api-view")
    .replace(/contact/g, "account")
    .replace("Portal accounts", "Power Pages Web API Columns");
  const root = await fixture(t, {
    "Solution/Entities/Contact/Entity.xml": contactEntity,
    "Solution/Entities/Contact/FormXml/main/{form-id}.xml":
      form("Friendly name"),
    "Solution/Entities/Account/Entity.xml": accountEntity,
    "Solution/Entities/Account/SavedQueries/{api-view}.xml": apiView,
  });
  const site = portal();
  site.settings = { "Webapi/account/UseFieldsFromView": "true" };
  site.records = [
    {
      kind: "basicformmetadata",
      adx_entityform: "basic-form",
      adx_attributelogicalname: "modifiedcontact",
      adx_setvalueonsave: true,
      adx_onsavetype: 100000002,
      adx_onsavefromattribute: "contactid",
    },
  ];
  site.forms[0].metadata.adx_associatecurrentportaluser = true;
  site.forms[0].metadata.adx_portaluserlookupattribute = "creator";
  site.advancedForms = [{ id: "wizard", metadata: { adx_startstep: "first" } }];
  site.records.push({
    kind: "advancedformstep",
    id: "first",
    name: "First",
    adx_webform: "wizard",
    adx_targetentitylogicalname: "contact",
    adx_formname: "Portal edit",
    adx_associatecurrentportaluser: true,
    adx_targetentityportaluserlookupattribute: "creator",
  });
  const result = await importSolutionMetadata(root, { portal: site });
  assert.equal(
    result.componentSchemas["basic-form"].onSaveFields[0].name,
    "modifiedcontact",
  );
  assert.equal(
    result.componentSchemas["basic-form"].fields.some(
      (f) => f.name === "modifiedcontact",
    ),
    false,
  );
  assert.equal(
    result.componentSchemas["basic-form"].currentUserAssociationField.name,
    "creator",
  );
  assert.equal(
    result.componentSchemas.wizard.steps[0].currentUserAssociationField.name,
    "creator",
  );
  assert.equal(
    result.views.find((view) => view.id === "api-view").name,
    "Power Pages Web API Columns",
  );
  assert.equal(
    result.views.find((view) => view.id === "api-view").entity,
    "account",
  );
});
test("imports actual unpacked solution shapes and maps portal form tab and saved query", async (t) => {
  const root = await fixture(t, {
    "Solution/Entities/Contact/Entity.xml": entity,
    "Solution/Entities/Contact/FormXml/main/{form-id}.xml":
      form("Friendly name"),
    "Solution/Entities/Contact/SavedQueries/{view-id}.xml": view,
  });
  const result = await importSolutionMetadata(root, { portal: portal() });
  assert.equal(result.filesRead, 3);
  assert.equal(result.summary.resolved.forms, 1);
  const schema = result.componentSchemas["basic-form"];
  assert.equal(schema.formId, "form-id");
  assert.equal(schema.fields[0].id, "name-control");
  assert.equal(schema.fields[0].required, true);
  assert.equal(schema.fields[0].maxLength, 120);
  assert.equal(
    schema.layout[0].columns[0].sections[0].label,
    "General > label",
  );
  assert.match(
    result.componentSchemas.list.fetchXml,
    /<entity name="contact">/,
  );
  assert.equal(result.componentSchemas.list.fields[0].width, 200);
  assert.match(result.fingerprint, /^[a-f\d]{64}$/);
  assert.deepEqual(result.diagnostics, []);
});

test("quick form bindings and subgrid metadata remain separate from editable payload fields", async (t) => {
  const xml = form("Name").replace(
    "</row>",
    '<cell><control id="CustomerDetails" datafieldname="fullname"><parameters><QuickForms>&lt;QuickFormIds&gt;&lt;QuickFormId entityname="account"&gt;quick-form&lt;/QuickFormId&gt;&lt;/QuickFormIds&gt;</QuickForms></parameters></control></cell><cell><control id="Children" indicationOfSubgrid="true"><parameters><TargetEntityType>contact</TargetEntityType><RelationshipName>contact_children</RelationshipName><ViewId>view-id</ViewId><EnableQuickFind>true</EnableQuickFind><RecordsPerPage>4</RecordsPerPage></parameters></control></cell></row>',
  );
  const root = await fixture(t, {
    "Solution/Entities/Contact/FormXml/main/{form-id}.xml": xml,
    "Solution/Entities/Account/FormXml/quick/{quick-form}.xml": form(
      "Quick name",
    )
      .replace("{form-id}", "{quick-form}")
      .replace("Portal edit", "Quick details"),
    "Solution/Entities/Contact/SavedQueries/{view-id}.xml": view,
  });
  const result = await importSolutionMetadata(root, { portal: portal() });
  const schema = result.componentSchemas["basic-form"];
  assert.equal(schema.fields.length, 1);
  const cells = schema.layout[0].columns[0].sections[0].rows[0];
  assert.equal(cells[1].type, "quickform");
  assert.equal(cells[1].schema.fields[0].label, "Quick name");
  assert.equal(cells[2].type, "subgrid");
  assert.equal(cells[2].relationship, "contact_children");
  assert.equal(cells[2].searchEnabled, true);
  assert.equal(cells[2].recordsPerPage, 4);
  assert.match(cells[2].fetchXml, /<entity name="contact">/);
});
test("explicit last root wins with recorded source layer conflict and no deployed inference", async (t) => {
  const first = await fixture(t, {
    "Solution/Entities/Contact/FormXml/main/{form-id}.xml": form("First"),
  });
  const last = await fixture(t, {
    "Solution/Entities/Contact/FormXml/main/{form-id}.xml": form("Second"),
  });
  const result = await importSolutionMetadata([first, last], {
    portal: portal(),
  });
  assert.equal(result.componentSchemas["basic-form"].fields[0].label, "Second");
  assert.equal(
    result.diagnostics.find((d) => d.code === "SOLUTION_LAYER_VARIANTS")
      .selected,
    await fs.realpath(
      path.join(last, "Solution/Entities/Contact/FormXml/main/{form-id}.xml"),
    ),
  );
});
test("an absent form tab falls back to the first visible tab; unknown declarations and malformed XML fail", async (t) => {
  const root = await fixture(t, {
    "Solution/Entities/Contact/FormXml/main/{form-id}.xml": form("Name"),
  });
  const p = portal();
  p.forms[0].metadata.adx_tabname = "Absent";
  // Legacy tab selection (platform-internals-reference.md 6.1.3): name, else label, else
  // the first visible tab; the fallback is reported.
  const result = await importSolutionMetadata(root, { portal: p });
  const schema = result.componentSchemas["basic-form"];
  assert.deepEqual(schema.tabSelection, { requested: "Absent", matched: "first-visible", tab: "tab_1" });
  assert.deepEqual(schema.fields.map((field) => field.name), ["fullname"]);
  const fallback = result.diagnostics.find((d) => d.code === "SYSTEMFORM_TAB_FALLBACK");
  assert.deepEqual([fallback.id, fallback.formId, fallback.requested, fallback.tab], ["basic-form", "form-id", "Absent", "tab_1"]);
  assert.ok(!result.diagnostics.some((d) => d.code === "SYSTEMFORM_MAPPING_ERROR"));
  // A label match is not a fallback.
  p.forms[0].metadata.adx_tabname = "General";
  const labelled = await importSolutionMetadata(root, { portal: p });
  assert.equal(labelled.componentSchemas["basic-form"].tabSelection.matched, "label");
  assert.ok(!labelled.diagnostics.some((d) => d.code === "SYSTEMFORM_TAB_FALLBACK"));
  // Without a visible tab nothing renders and the diagnostic says so.
  const hidden = await fixture(t, {
    "Solution/Entities/Contact/FormXml/main/{form-id}.xml": form("Name").replace('<tab name="tab_1" id="tab-id">', '<tab name="tab_1" id="tab-id" visible="false">'),
  });
  p.forms[0].metadata.adx_tabname = "Absent";
  const none = await importSolutionMetadata(hidden, { portal: p });
  assert.equal(none.componentSchemas["basic-form"].tabSelection.matched, "none");
  assert.match(none.diagnostics.find((d) => d.code === "SYSTEMFORM_TAB_FALLBACK").message, /no visible tab/);
  assert.throws(() => parseSolutionXml("<!DOCTYPE x><x></x>"), /declarations/);
  assert.throws(() => parseSolutionXml("<x><y></x>"), /Malformed/);
});

test("several active systemforms with the form name: the first is used and the candidates are reported", async (t) => {
  const root = await fixture(t, {
    "Solution/Entities/Contact/FormXml/main/{form-a}.xml": form("First").replace("{form-id}", "{form-a}"),
    "Solution/Entities/Contact/FormXml/main/{form-b}.xml": form("Second").replace("{form-id}", "{form-b}"),
  });
  const result = await importSolutionMetadata(root, { portal: portal() });
  const schema = result.componentSchemas["basic-form"];
  const ambiguous = result.diagnostics.find((d) => d.code === "SYSTEMFORM_NAME_AMBIGUOUS");
  assert.ok(ambiguous, JSON.stringify(result.diagnostics));
  assert.deepEqual(ambiguous.candidates.map((candidate) => candidate.formId).sort(), ["form-a", "form-b"]);
  assert.equal(ambiguous.formId, ambiguous.candidates[0].formId);
  assert.equal(schema.formId, ambiguous.formId);
  assert.equal(schema.fields[0].label, ambiguous.formId === "form-a" ? "First" : "Second");
  // A form ID on the basic form selects the form without ambiguity.
  const p = portal();
  p.forms[0].metadata.adx_formid = "form-b";
  const chosen = await importSolutionMetadata(root, { portal: p });
  assert.equal(chosen.componentSchemas["basic-form"].fields[0].label, "Second");
  assert.ok(!chosen.diagnostics.some((d) => d.code === "SYSTEMFORM_NAME_AMBIGUOUS"));
});

test("lookup DefaultViewId imports its dependent table and preserves the exact saved query", async (t) => {
  const lookupForm = form("Country").replace(
    'disabled="false"/>',
    'disabled="false"><parameters><DefaultViewId>{country-view}</DefaultViewId></parameters></control>',
  );
  const countryView = view
    .replaceAll("view-id", "country-view")
    .replaceAll("contact", "country")
    .replaceAll("fullname", "shortname");
  const root = await fixture(t, {
    "Entities/contact/Entity.xml": entity,
    "Entities/contact/FormXml/main/{form-id}.xml": lookupForm,
    "Entities/country/SavedQueries/{country-view}.xml": countryView,
  });
  const p = portal();
  p.lists = [];
  const result = await importSolutionMetadata(root, { portal: p });
  const field = result.componentSchemas["basic-form"].fields[0];
  assert.equal(field.lookupView.entity, "country");
  assert.equal(field.lookupView.id, "country-view");
  assert.equal(field.lookupView.fields[0].name, "shortname");
  assert.match(field.lookupView.fetchXml, /<entity name="country">/);
});

test('notes cells without datafieldname survive exported systemform parsing', async t => {
  const notes = '<row><cell colspan="2"><labels><label description="Related notes" languagecode="1033"/></labels><control id="notescontrol" classid="{06375649-C143-495E-A496-C962E5B4488E}"/></cell></row>';
  const root = await fixture(t, {'Entities/contact/Entity.xml': entity, 'Entities/contact/FormXml/main/{form-id}.xml': form('Name').replace('</rows>', notes + '</rows>')});
  const metadata = await importSolutionMetadata(root, {portal: portal()});
  const cell = formCells(metadata.componentSchemas['basic-form']).find(c => c.type === 'notes');
  assert.equal(cell.id, 'notescontrol');
  assert.equal(cell.label, 'Related notes');
  assert.equal(cell.colspan, 2);
  assert.equal(metadata.componentSchemas['basic-form'].fields.length, 1);
});
