// Serializable dirty-state probe for an owned, unsaved form. It never saves or fires OnChange.
export async function captureModelDrivenDirtyContract(input, form = globalThis.Xrm.Page) {
  const results = [];
  const capture = (id, operation) => {
    try {
      const value = operation();
      results.push({ id, value: value === undefined ? { undefined: true } : value });
    } catch (error) {
      results.push({ id, error: { name: error.name, message: error.message } });
    }
  };
  capture('entity.baseline', () => form.data.entity.getIsDirty());
  capture('data.baseline', () => form.data.getIsDirty());
  for (const spec of input.fields) {
    const attribute = form.getAttribute(spec.name);
    if (!attribute) throw new Error('Dirty fixture field is missing: ' + spec.role);
    const original = attribute.getValue();
    const edited = spec.kind === 'date' ? new Date(spec.value) : spec.value;
    try {
      capture(spec.role + '.baseline', () => attribute.getIsDirty());
      capture(spec.role + '.idempotent.return', () => attribute.setValue(original));
      capture(spec.role + '.idempotent.attribute', () => attribute.getIsDirty());
      capture(spec.role + '.idempotent.entity', () => form.data.entity.getIsDirty());
      attribute.setValue(edited);
      capture(spec.role + '.edited.attribute', () => attribute.getIsDirty());
      capture(spec.role + '.edited.entity', () => form.data.entity.getIsDirty());
      capture(spec.role + '.edited.data', () => form.data.getIsDirty());
      attribute.setValue(original);
      capture(spec.role + '.restored.attribute', () => attribute.getIsDirty());
      capture(spec.role + '.restored.entity', () => form.data.entity.getIsDirty());
      capture(spec.role + '.restored.data', () => form.data.getIsDirty());
    } finally {
      attribute.setValue(original);
    }
  }
  return results;
}
