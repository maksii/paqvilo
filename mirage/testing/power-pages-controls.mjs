// Serializable rendered basic-form probe. Reads source-selected controls and restores
// authored unsaved edits; it does not submit, navigate, or read visitor identities.
export function capturePowerPagesControlContract(input) {
  const results = [];
  const capture = (id, value) => results.push({ id, value: value === undefined ? { undefined: true } : value });
  for (const spec of input.fields) {
    const node = document.getElementById(spec.name);
    if (!node) throw new Error('Rendered form fixture field is missing: ' + spec.role);
    capture(spec.role + '.tag', node.tagName.toLowerCase());
    capture(spec.role + '.type', node.type);
    capture(spec.role + '.maxLength', node.maxLength);
    capture(spec.role + '.disabled', node.disabled);
    capture(spec.role + '.readOnly', node.readOnly);
    capture(
      spec.role + '.labelAssociated',
      [...(node.labels ?? [])].some((label) => label.htmlFor === node.id && label.textContent.trim().length > 0),
    );
    capture(spec.role + '.formContainer', !!node.closest('.crmEntityFormView'));
    const feedback = spec.feedbackId ? document.getElementById(spec.feedbackId) : null;
    if (spec.feedbackId) {
      if (!feedback) throw new Error('Authored form feedback is missing: ' + spec.role);
      capture(
        spec.role + '.feedbackAssociation',
        (node.getAttribute('aria-describedby') ?? '').split(/\s+/).includes(spec.feedbackId),
      );
      capture(spec.role + '.feedbackInitialLength', Number.parseInt(feedback.textContent, 10) === node.value.length);
    }
    if (spec.edit !== undefined) {
      const original = node.value;
      try {
        node.value = spec.edit;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
        capture(spec.role + '.editedValue', node.value);
        if (feedback)
          capture(spec.role + '.feedbackEditedLength', Number.parseInt(feedback.textContent, 10) === node.value.length);
      } finally {
        node.value = original;
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }
      capture(spec.role + '.restoredValue', node.value === original);
      if (feedback)
        capture(spec.role + '.feedbackRestoredLength', Number.parseInt(feedback.textContent, 10) === node.value.length);
    }
  }
  for (const spec of input.groups ?? []) {
    const node = document.getElementById(spec.name);
    if (!node) throw new Error('Rendered form fixture group is missing: ' + spec.role);
    const radios = [...node.querySelectorAll('input[type="radio"]')];
    capture(spec.role + '.tag', node.tagName.toLowerCase());
    capture(spec.role + '.formContainer', !!node.closest('.crmEntityFormView'));
    capture(spec.role + '.optionCount', radios.length);
    capture(
      spec.role + '.values',
      radios.map((radio) => radio.value),
    );
    capture(
      spec.role + '.disabled',
      radios.map((radio) => radio.disabled),
    );
    capture(
      spec.role + '.labelsAssociated',
      radios.every((radio) =>
        [...radio.labels].some((label) => label.htmlFor === radio.id && label.textContent.trim().length > 0),
      ),
    );
    const original = radios.map((radio) => radio.checked);
    try {
      for (const radio of radios) {
        radio.checked = true;
        radio.dispatchEvent(new Event('change', { bubbles: true }));
        capture(
          spec.role + '.selected.' + radio.value,
          radios.filter((item) => item.checked).map((item) => item.value),
        );
      }
    } finally {
      radios.forEach((radio, index) => {
        radio.checked = original[index];
      });
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }
    capture(
      spec.role + '.restored',
      radios.every((radio, index) => radio.checked === original[index]),
    );
  }
  return results;
}
