// Serializable draft-only presentation probe; callers select owned fields and a tab explicitly.
export async function captureModelDrivenPresentationContract(input, form = globalThis.Xrm.Page) {
  const results = [];
  const capture = async (id, operation) => {
    try {
      const value = await operation();
      results.push({ id, value: value === undefined ? { undefined: true } : value });
    } catch (error) {
      results.push({ id, error: { name: error.name, message: error.message } });
    }
  };
  const quantity = form.getAttribute(input.names.quantity),
    email = form.getAttribute(input.names.email),
    title = form.getAttribute(input.names.title),
    control = form.getControl(input.names.quantity),
    tab = form.ui.tabs.get().find((item) => item.getLabel() === input.tabLabel),
    section = tab?.sections.get(0);
  if (!quantity || !email || !title || !control || !tab || !section)
    throw new Error('Presentation fixture fields and layout must be ready');
  const original = {
    quantity: quantity.getValue(),
    email: email.getValue(),
    title: title.getValue(),
    required: quantity.getRequiredLevel(),
    visible: control.getVisible(),
    disabled: control.getDisabled(),
    label: control.getLabel(),
    tabLabel: tab.getLabel(),
    tabVisible: tab.getVisible(),
    sectionLabel: section.getLabel(),
    sectionVisible: section.getVisible(),
  };
  const mutate = async (id, operation, read) => {
    await capture(id + '.return', operation);
    await capture(id + '.readback', read);
  };
  try {
    await capture('form.type', () => form.ui.getFormType());
    await capture('form.newId', () => form.data.entity.getId());
    await capture('form.entityMatchesInput', () => form.data.entity.getEntityName() === input.entity);
    for (const [role, name] of Object.entries(input.controls))
      await capture('control.type.' + role, () => form.getControl(name).getControlType());
    title.setValue('Draft presentation proof');
    quantity.setValue(null);
    await capture('form.primaryValue', () => form.data.entity.getPrimaryAttributeValue());
    await capture('dirty.email.baseline', () => email.getIsDirty());
    email.setValue('presentation@example.invalid');
    await capture('dirty.email.edited', () => email.getIsDirty());
    await capture('dirty.entity.edited', () => form.data.entity.getIsDirty());
    await capture('dirty.data.edited', () => form.data.getIsDirty());
    email.setValue(original.email);
    await capture('dirty.email.restored', () => email.getIsDirty());
    await mutate(
      'control.label',
      () => control.setLabel('Invented quantity'),
      () => control.getLabel(),
    );
    await mutate(
      'control.disabled',
      () => control.setDisabled(true),
      () => control.getDisabled(),
    );
    await mutate(
      'control.enabled',
      () => control.setDisabled(false),
      () => control.getDisabled(),
    );
    await mutate(
      'control.hidden',
      () => control.setVisible(false),
      () => control.getVisible(),
    );
    await mutate(
      'control.visible',
      () => control.setVisible(true),
      () => control.getVisible(),
    );
    await capture('control.parentIsSection', () => control.getParent().getParent() === tab);
    await capture('section.parentIsTab', () => section.getParent() === tab);
    await mutate(
      'tab.label',
      () => tab.setLabel('Invented tab'),
      () => tab.getLabel(),
    );
    await mutate(
      'section.label',
      () => section.setLabel('Invented section'),
      () => section.getLabel(),
    );
    await mutate(
      'section.hidden',
      () => section.setVisible(false),
      () => section.getVisible(),
    );
    await mutate(
      'section.visible',
      () => section.setVisible(true),
      () => section.getVisible(),
    );
    await mutate(
      'tab.hidden',
      () => tab.setVisible(false),
      () => tab.getVisible(),
    );
    await mutate(
      'tab.visible',
      () => tab.setVisible(true),
      () => tab.getVisible(),
    );
    await capture('control.notification.set', () => control.setNotification('Invented issue', 'presentation-proof'));
    await capture('control.notification.clear', () => control.clearNotification('presentation-proof'));
    await capture('control.notification.clearMissing', () => control.clearNotification('presentation-proof'));
    for (const level of ['INFO', 'WARNING', 'ERROR']) {
      await capture('form.notification.set.' + level, () =>
        form.ui.setFormNotification('Invented notice', level, 'presentation-proof'),
      );
      await capture('form.notification.clear.' + level, () => form.ui.clearFormNotification('presentation-proof'));
    }
    await capture('form.notification.clearMissing', () => form.ui.clearFormNotification('presentation-proof'));
  } finally {
    control.clearNotification('presentation-proof');
    form.ui.clearFormNotification('presentation-proof');
    control.setLabel(original.label);
    control.setDisabled(original.disabled);
    control.setVisible(original.visible);
    quantity.setRequiredLevel(original.required);
    quantity.setValue(original.quantity);
    email.setValue(original.email);
    title.setValue(original.title);
    if (typeof tab.setLabel === 'function') tab.setLabel(original.tabLabel);
    if (typeof section.setLabel === 'function') section.setLabel(original.sectionLabel);
    section.setVisible(original.sectionVisible);
    tab.setVisible(original.tabVisible);
  }
  return results;
}
