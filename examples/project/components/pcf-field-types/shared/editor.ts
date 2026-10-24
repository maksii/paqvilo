export function createEditor(
  container: HTMLDivElement,
  className: string,
  value: string,
  onInput: () => void,
  type: string,
  step?: string,
): HTMLInputElement | HTMLTextAreaElement {
  const field = type === 'textarea' ? document.createElement('textarea') : document.createElement('input');
  if (field instanceof HTMLInputElement) {
    field.type = type;
    if (step) field.step = step;
  }
  field.className = className;
  field.value = value;
  field.addEventListener('input', onInput);
  container.appendChild(field);
  return field;
}
export function releaseEditor(field: HTMLInputElement | HTMLTextAreaElement, onInput: () => void): void {
  field.removeEventListener('input', onInput);
}
export function numberValue(raw: number | null): number | undefined {
  return raw === null || Number.isNaN(raw) ? undefined : raw;
}
