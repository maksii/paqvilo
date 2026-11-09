// The same finite, draft-only probe runs in a native form and the local client.
// Inputs name explicitly selected fixture fields; no identity, tokens or pre-existing record values are collected.
export async function captureModelDrivenContract(input, form = globalThis.Xrm.Page) {
  const results = [];
  const capture = async (id, operation) => {
    try {
      const value = await operation();
      results.push({ id, value: value === undefined ? { undefined: true } : value });
    } catch (error) {
      results.push({ id, error: { name: error.name, message: error.message } });
    }
  };
  for (const spec of input.fields) {
    const attribute = form.getAttribute(spec.name);
    if (!attribute) throw new Error(`Missing fixture attribute: ${spec.role}`);
    for (const method of spec.metadata ?? ['getAttributeType', 'getFormat', 'getRequiredLevel', 'getSubmitMode'])
      await capture(`${spec.role}.${method}`, () => attribute[method]());
    const original = attribute.getValue();
    const originalRequired = spec.requiredLevels ? attribute.getRequiredLevel() : undefined;
    const originalSubmitMode = spec.submitModes ? attribute.getSubmitMode() : undefined;
    try {
      for (const value of spec.values ?? []) {
        await capture(`${spec.role}.value.${JSON.stringify(value)}`, () => {
          attribute.setValue(value);
          return attribute.getValue();
        });
      }
      if (spec.changeEvents) {
        let calls = 0,
          context,
          changed;
        const change = new Promise((resolve) => {
          changed = resolve;
        });
        const handler = (event) => {
          calls++;
          context = {
            form: event.getFormContext() === form,
            source: event.getEventSource() === attribute,
            depth: event.getDepth(),
          };
          changed();
        };
        attribute.addOnChange(handler);
        try {
          attribute.setValue(spec.values[0]);
          await capture(`${spec.role}.setValue.eventCount`, () => calls);
          await attribute.fireOnChange();
          let timer;
          try {
            await Promise.race([
              change,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('OnChange was not delivered')), 10000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          await capture(`${spec.role}.fireOnChange`, () => ({ calls, context }));
        } finally {
          attribute.removeOnChange(handler);
        }
        await attribute.fireOnChange();
        await capture(`${spec.role}.removeOnChange`, () => calls);
        const depths = [];
        let delivered;
        const delivery = new Promise((resolve) => {
          delivered = resolve;
        });
        const first = (event) => depths.push(event.getDepth());
        const second = (event) => {
          depths.push(event.getDepth());
          delivered();
        };
        attribute.addOnChange(first);
        attribute.addOnChange(second);
        try {
          await attribute.fireOnChange();
          let timer;
          try {
            await Promise.race([
              delivery,
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error('Second OnChange was not delivered')), 10000);
              }),
            ]);
          } finally {
            clearTimeout(timer);
          }
          await capture(`${spec.role}.handlerDepths`, () => depths);
        } finally {
          attribute.removeOnChange(first);
          attribute.removeOnChange(second);
        }
      }
      for (const level of spec.requiredLevels ?? []) {
        attribute.setRequiredLevel(level);
        await capture(`${spec.role}.required.${level}`, () => attribute.getRequiredLevel());
      }
      for (const mode of spec.submitModes ?? []) {
        await capture(`${spec.role}.submit.${mode}`, () => {
          attribute.setSubmitMode(mode);
          return attribute.getSubmitMode();
        });
      }
    } finally {
      attribute.setValue(original);
      if (spec.requiredLevels) attribute.setRequiredLevel(originalRequired);
      if (spec.submitModes) attribute.setSubmitMode(originalSubmitMode);
    }
  }
  await capture('attributes.missing', () => form.getAttribute('x_missing_contract_field'));
  await capture('controls.missing', () => form.getControl('x_missing_contract_control'));
  for (const [role, select] of [
    ['attributes', () => form.data.entity.attributes],
    ['controls', () => form.ui.controls],
  ]) {
    const items = select();
    await capture(`${role}.length`, () => items.getLength() === items.get().length);
    await capture(`${role}.negativeIndex`, () => items.get(-1));
    await capture(`${role}.outOfRange`, () => items.get(100000));
    await capture(`${role}.filterEmpty`, () => items.get(() => false));
    await capture(`${role}.forEach`, () => {
      const indices = [];
      items.forEach((item, index) => indices.push(index));
      return indices.every((value, index) => value === index) && indices.length === items.getLength();
    });
  }
  return results;
}

// Additional API probes use acknowledged control-option state and explicit numeric validity.
export async function captureModelDrivenControlContract(input, form = globalThis.Xrm.Page) {
  const results = [];
  const capture = async (id, fn) => {
    try {
      const value = await fn();
      results.push({ id, value: value === undefined ? { undefined: true } : value });
    } catch (error) {
      results.push({ id, error: { name: error.name, message: error.message } });
    }
  };
  for (const role of ['choice', 'multi']) {
    const attribute = form.getAttribute(input.names[role]),
      control = form.getControl(input.names[role]);
    await capture(role + '.sourceOptions', () => attribute.getOptions());
    control.clearOptions();
    control.addOption(input.dynamic);
    control.addOption(input.kept);
    await capture(role + '.attributeOptionsAfterControlEdit', () => attribute.getOptions());
    await capture(role + '.controlOptionsAfterControlEdit', () => control.getOptions());
    await capture(role + '.setDynamicValue', () => {
      attribute.setValue(role === 'multi' ? [input.dynamic.value] : input.dynamic.value);
      return attribute.getValue();
    });
    await capture(role + '.dynamicText', () => attribute.getText());
    await capture(role + '.dynamicOption', () => attribute.getOption(input.dynamic.value));
    await capture(role + '.sourceValueAfterRemoval', () => {
      attribute.setValue(role === 'multi' ? [input.removed, input.dynamic.value] : input.removed);
      return attribute.getValue();
    });
  }
  form.getAttribute(input.names.title).setValue('Draft numeric validity proof');
  const quantity = form.getAttribute(input.names.quantity);
  await capture('numeric.baselineValidity', () => form.data.entity.isValid());
  for (const value of input.numbers)
    await capture('numeric.bound.' + value, () => {
      quantity.setValue(value);
      return { value: quantity.getValue(), valid: form.data.entity.isValid() };
    });
  return results;
}
