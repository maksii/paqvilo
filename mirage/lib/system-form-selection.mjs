import { portalField } from './importer.mjs';

const canonical = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .trim()
    .toLowerCase();

/** A missing type is a legacy export, not proof that a form is a Card or Main. */
export function portalFormEligible(form) {
  if (Number.isInteger(form.systemFormType)) return form.systemFormType === 2;
  const type = canonical(form.formType);
  if (/^\d+$/.test(type)) return Number(type) === 2;
  // These are named FormXml groups; preserve unknown future group names without
  // inventing a numeric Dataverse type from a filename or directory.
  return !['card', 'quick', 'quickcreate', 'quickview', 'preview', 'dashboard', 'mobile', 'maininteractive'].includes(
    type,
  );
}

export function matchingSystemForms(definition, forms = []) {
  const id = canonical(portalField(definition.metadata ?? {}, 'formid'));
  return forms.filter(
    (form) =>
      canonical(form.entity) === canonical(definition.entityName) &&
      form.active !== false &&
      (id ? canonical(form.id) === id : canonical(form.name) === canonical(definition.formName)),
  );
}
