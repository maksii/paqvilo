// The step facts $pages multistep forms read (Learn, client-api/forms-tabs-sections "Multistep form": hasNextStep,
// hasPreviousStep): platform.mjs writes them into the form's local configuration script. Invented data.
import test from "node:test";
import assert from "node:assert/strict";
import { renderComponent } from "../lib/platform.mjs";
import { createWebFormSessions } from "../lib/form-service.mjs";

const portal = { website: { id: "site" }, forms: [], lists: [], pages: [], settings: {}, websiteLanguages: [{ lcid: 1033, isDefault: true }],
  advancedForms: [{ id: "survey", name: "Survey Wizard", metadata: {} }], records: [] };
const step = (stepId, extra) => ({ stepId, entity: "x_answer", mode: 100000000, formName: "Answer", metadata: {},
  fields: [{ name: "x_note", label: "Note", dataverseType: "nvarchar" }], layout: [{ name: "tab", columns: [{ sections: [{ name: "s", rows: [[{ name: "x_note" }]] }] }] }], ...extra });
const schemas = { survey: { initialStepId: "one", steps: [step("one", { nextStepId: "two" }), step("two", {})] } };
const store = { resolveMapping: () => ({ entitySet: "x_answers", idColumn: "x_answerid" }), get: async () => null, query: async () => ({ value: [] }) };

test("a multistep step's configuration says whether a next and a previous step exist", async () => {
  const html = await renderComponent("webform", "Survey Wizard", { request: { params: {} } },
    { portal, store, schemas, renderLiquid: async (s) => s, webFormSessions: createWebFormSessions(), webFormOwner: () => "visitor:a" });
  const config = JSON.parse(/<script type="application\/json" data-paqvilo-mirage-form-config>([^<]*)<\/script>/.exec(html)[1]);
  assert.deepEqual(config.clientStep, { hasNextStep: true, hasPreviousStep: false });
  assert.match(html, /<div id="WebFormPanel" class="crmEntityFormView" data-form-name="Survey Wizard"/);
});
