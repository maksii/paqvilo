import { portalField } from './importer.mjs';

export const canonicalStepId = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .trim()
    .toLowerCase();

/** Preserve exported step records and follow their explicit references only. */
export function advancedFormGraph(definition, records = []) {
  const active = records.filter(
    (row) => row.kind === 'advancedformstep' && Number(portalField(row, 'statecode', 0)) !== 1,
  );
  const byId = new Map(active.map((row) => [canonicalStepId(row.id), row]));
  const owned = active.filter((row) => canonicalStepId(portalField(row, 'webform')) === canonicalStepId(definition.id));
  const initialStepId = canonicalStepId(portalField(definition.metadata ?? {}, 'startstep'));
  const selected = new Map(owned.map((row) => [canonicalStepId(row.id), row]));
  const diagnostics = [],
    seen = new Set(),
    queue = [{ id: initialStepId, field: 'startstep', from: definition.id }];
  // Keep every owned child, including unreachable steps, and inspect its references.
  queue.push(...owned.map((row) => ({ id: canonicalStepId(row.id), field: 'webform', from: definition.id })));
  while (queue.length) {
    const reference = queue.shift();
    if (!reference.id) continue;
    const row = byId.get(reference.id);
    if (!row) {
      diagnostics.push({
        code: 'ADVANCEDFORM_STEP_REFERENCE_UNRESOLVED',
        id: definition.id,
        step: reference.from,
        referenceField: reference.field,
        targetStepId: reference.id,
        message: 'An exported multistep reference has no active exported step record.',
      });
      continue;
    }
    if (seen.has(reference.id)) continue;
    seen.add(reference.id);
    selected.set(reference.id, row);
    if (canonicalStepId(portalField(row, 'webform')) !== canonicalStepId(definition.id))
      diagnostics.push({
        code: 'ADVANCEDFORM_SHARED_STEP_REFERENCE',
        severity: 'info',
        id: definition.id,
        step: row.id,
        owner: portalField(row, 'webform'),
        message:
          'An explicit exported reference selects a step owned by another form; its source is preserved, while native reuse behavior remains unqualified.',
      });
    for (const field of ['nextstep', 'conditiondefaultnextstep']) {
      const id = canonicalStepId(portalField(row, field));
      if (id) queue.push({ id, field, from: row.id });
    }
  }
  return { initialStepId, steps: [...selected.values()], diagnostics };
}
