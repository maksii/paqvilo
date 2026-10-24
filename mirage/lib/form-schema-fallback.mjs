import { portalField } from "./importer.mjs";
import { matchingSystemForms, portalFormEligible } from './system-form-selection.mjs';
import { advancedFormGraph } from './advanced-form-graph.mjs';

/*
 * Local layouts for exported basic and advanced forms whose Dataverse systemforms are absent
 * from the configured solutions. Used by the form renderer (lib/platform.mjs) and
 * the native form service (lib/form-service.mjs) so approximated forms render and submit.
 */
const canonicalId = (value) =>
  String(value ?? "")
    .replace(/[{}]/g, "")
    .toLowerCase();
const fieldOf = (record, name) => portalField(record ?? {}, name);
const FORM_MODE = { insert: 100000000, edit: 100000001, readOnly: 100000002 };

/** Basic form metadata rows of a form, or advanced form metadata rows of a step. */
function formMetadataRows(portal, definition, stepId) {
  return (portal.records ?? []).filter(
    (row) =>
      ["basicformmetadata", "advancedformmetadata"].includes(row.kind) &&
      ((definition && canonicalId(fieldOf(row, "entityform")) === canonicalId(definition.id)) ||
        (stepId && canonicalId(fieldOf(row, "webformstep")) === canonicalId(stepId))),
  );
}

/**
 * The platform renders a basic form from its Dataverse systemform. When the
 * configured solutions do not contain that form, approximate it locally: one
 * "General" section with the table's primary name and required columns plus the
 * attributes named by the form's own metadata rows, and report the
 * approximation (COMPONENT_SCHEMA_REQUIRED) as a diagnostic.
 */
export function approximateFormSchema({ definition, portal, metadata, diagnostic, step = null }) {
  const matches = matchingSystemForms(definition, metadata?.forms);
  // An absent layout can be approximated; an explicitly ineligible exported
  // layout must not silently become an editable invented form.
  if (matches.length && !matches.some(portalFormEligible)) {
    diagnostic?.({ code: 'SYSTEMFORM_INELIGIBLE_TYPE', component: step ? 'webform' : 'entityform', form: definition.name, message: 'Matching exported forms have a declared non-Main type; approximation is unavailable.' });
    return null;
  }
  const entity = canonicalId(definition.entityName ?? fieldOf(definition.metadata, "entityname"));
  if (!entity) return null;
  const table = metadata?.entities?.[entity] ?? {};
  const known = table.fields ?? {};
  const mode = Number(definition.mode ?? FORM_MODE.insert);
  const usable = (field) =>
    Boolean(field) &&
    (mode === FORM_MODE.insert ? field.validForCreate !== false : field.validForUpdate !== false) &&
    !/^(owner|state|status|uniqueidentifier|virtual|partylist)$/i.test(String(field.dataverseType ?? ""));
  const names = [];
  const add = (value) => {
    const key = canonicalId(value);
    if (key && !names.includes(key)) names.push(key);
  };
  if (usable(known[table.primaryNameAttribute])) add(table.primaryNameAttribute);
  for (const [attribute, field] of Object.entries(known))
    if (field.required && field.requiredLevel !== "systemrequired" && usable(field)) add(attribute);
  for (const row of step ? formMetadataRows(portal, null, step.id) : formMetadataRows(portal, definition))
    if (Number(fieldOf(row, "type")) === 100000000) add(fieldOf(row, "attributelogicalname"));
  const fields = names.map((attribute) => ({
    ...(known[attribute] ?? {}),
    name: attribute,
    id: attribute,
    label: known[attribute]?.label ?? attribute,
    readOnly: known[attribute] ? !usable(known[attribute]) : false,
  }));
  diagnostic?.({
    code: "COMPONENT_SCHEMA_REQUIRED",
    severity: "warning",
    component: step ? "webform" : "entityform",
    form: definition.name,
    formName: definition.formName ?? null,
    entity,
    fields: names,
    ...(step ? { step: step.name ?? step.id } : {}),
    message: `${step ? `Advanced form step '${step.name ?? step.id}' of '${definition.name}'` : `Basic form '${definition.name}'`} uses form '${definition.formName ?? "(unnamed)"}' of table ${entity}, which is absent in the configured solutions; the local layout is approximated as one section with ${names.length} field(s).`,
  });
  return {
    entity,
    mode,
    title: definition.formName ?? definition.name,
    approximated: true,
    fields,
    layout: [{ name: "general", label: "General", columns: [{ width: "100%", sections: [{ name: "general", label: "General", showLabel: false, rows: fields.map((field) => [field]) }] }] }],
  };
}

/**
 * Advanced forms render their steps from Dataverse systemforms. Steps whose form is absent
 * from the configured solutions (or advanced forms without any resolved step) are completed
 * from the exported step records: load-form steps get the approximated basic form layout,
 * redirect and condition steps keep their targets, and each approximation is reported.
 */
export function approximateAdvancedFormSchema({ definition, portal, metadata, schema, diagnostic }) {
  const graph = advancedFormGraph(definition, portal.records);
  for (const entry of graph.diagnostics) diagnostic?.(entry);
  const records = graph.steps;
  if (!records.length) return schema ?? null;
  const known = new Map((schema?.steps ?? []).map((step) => [canonicalId(step.stepId), step]));
  const steps = [];
  for (const record of records) {
    const stepId = canonicalId(record.id);
    if (known.has(stepId)) {
      steps.push(known.get(stepId));
      continue;
    }
    const type = Number(fieldOf(record, "type") ?? 100000001);
    const nextStepId = canonicalId(fieldOf(record, "nextstep")) || null;
    if (type === 100000003) {
      const target = portal.pages.find((page) => canonicalId(page.id) === canonicalId(fieldOf(record, "redirectwebpage")));
      const redirectUrl = target?.url ?? fieldOf(record, "redirecturl");
      if (redirectUrl)
        steps.push({ stepId: record.id, type: "redirect", redirectUrl, appendRecordId: fieldOf(record, "redirecturlappendentityidquerystring") ?? false, recordQueryName: fieldOf(record, "redirecturlquerystringname"), js: record.customJavascript, metadata: record });
      else diagnostic?.({ code: "ADVANCEDFORM_STEP_UNRESOLVED", severity: "warning", component: "webform", form: definition.name, step: record.name ?? record.id, message: `Redirect step '${record.name ?? record.id}' of advanced form '${definition.name}' has no exported target page or URL.` });
      continue;
    }
    if (type === 100000000) {
      steps.push({ stepId: record.id, type: "condition", condition: fieldOf(record, "condition"), nextStepId, conditionDefaultNextStepId: canonicalId(fieldOf(record, "conditiondefaultnextstep")) || null, js: record.customJavascript, metadata: record });
      continue;
    }
    if (![100000001, 100000002].includes(type)) {
      diagnostic?.({ code: 'ADVANCEDFORM_STEP_UNSUPPORTED', component: 'webform', form: definition.id, step: record.id, stepType: type, message: 'The exported step type cannot be approximated as a load form.' });
      continue;
    }
    const approximated = approximateFormSchema({
      definition: { id: record.id, name: definition.name, entityName: fieldOf(record, "targetentitylogicalname") ?? fieldOf(record, "entityname"), formName: fieldOf(record, "formname"), mode: fieldOf(record, "mode") ?? FORM_MODE.insert, metadata: record },
      portal,
      metadata,
      diagnostic,
      step: record,
    });
    if (approximated) steps.push({ ...approximated, stepId: record.id, nextStepId, js: record.customJavascript, metadata: record });
  }
  const start = graph.initialStepId || canonicalId(schema?.initialStepId);
  const first = steps.find((step) => canonicalId(step.stepId) === start);
  if (!first) {
    diagnostic?.({ code: 'ADVANCEDFORM_STEP_UNRESOLVED', component: 'webform', form: definition.id, step: start || null, message: 'The declared initial step is unavailable; another exported step is not rendered instead.' });
    return null;
  }
  return { ...(schema ?? {}), ...first, steps, initialStepId: start };
}
