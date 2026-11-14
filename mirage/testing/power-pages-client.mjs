// Serializable metadata-only client API probe for explicitly selected rendered controls.
// It neither reads visitor identity nor submits or changes any form value.
export async function capturePowerPagesClientContract(input) {
  const ready = globalThis.Microsoft?.PowerPages?.onPagesClientApiReady;
  if (typeof ready !== 'function') throw new Error('The native Power Pages readiness API is unavailable.');
  const deadline = input.readyTimeoutMs;
  if (deadline !== undefined && !(Number.isInteger(deadline) && deadline > 0))
    throw new Error('readyTimeoutMs must be a positive integer.');
  let timer;
  const pages = await new Promise((resolve, reject) => {
    if (deadline !== undefined)
      timer = setTimeout(() => reject(new Error('Power Pages API readiness deadline exceeded.')), deadline);
    try {
      const pending = ready.call(globalThis.Microsoft.PowerPages, resolve);
      if (pending?.then) pending.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
  }).finally(() => clearTimeout(timer));
  const results = [];
  const capture = (id, operation) => {
    try {
      const value = operation();
      results.push({ id, value: value === undefined ? { undefined: true } : value });
    } catch (error) {
      results.push({ id, error: { name: error.name, message: error.message } });
    }
  };
  const forms = pages.currentPage.forms.getAll();
  const form = forms.find((candidate) => candidate.getControlByLogicalName(input.fields[0].name));
  if (!form) throw new Error('Source-selected rendered form is absent from the Power Pages client context.');
  capture('forms.count', () => forms.length);
  capture('form.nameMatchesSource', () => form.name === input.formName);
  capture('form.byName', () => pages.currentPage.forms.getFormByName(form.name)?.id === form.id);
  capture('form.byId', () => pages.currentPage.forms.getFormById(form.id)?.name === form.name);
  capture('form.isMultiStep', () => form.isMultiStep);
  capture('form.visible', () => form.getVisible());
  capture('form.htmlContainsSelectedFields', () =>
    input.fields.every((spec) => form.getHtmlElement().querySelector('#' + CSS.escape(spec.name))),
  );
  for (const spec of [...input.fields, ...(input.groups ?? [])]) {
    const control = form.getControlByLogicalName(spec.name);
    if (!control) throw new Error('Source-selected client control is absent: ' + spec.role);
    capture(spec.role + '.nameMatchesSource', () => control.getName() === spec.name);
    capture(spec.role + '.logicalNameMatchesSource', () => control.getLogicalName() === spec.name);
    for (const method of ['getType', 'getDisabled', 'getRequired', 'getVisible'])
      capture(spec.role + '.' + method, () => control[method]());
    capture(spec.role + '.isReadOnly', () => control.isReadOnly);
  }
  return results;
}
