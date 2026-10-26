// Rendering admission is narrower than the headless control catalogue. A logic-hosted
// Image or modern control must not make preflight claim that the HTML player renders it.
import { controlKind } from './canvas-controls.mjs';

const KINDS = new Set([
  'label',
  'textinput',
  'button',
  'gallery',
  'form',
  'formviewer',
  'card',
  'dropdown',
  'combobox',
  'checkbox',
  'toggle',
  'datepicker',
  'container',
]);
const MODERN = /^(?:Text|TextInput|Button|DropDown|ComboBox|CheckBox|Toggle|DatePicker)(?:@|$)/i;

/** Explicit source controls the baseline player cannot render; no formula is executed. */
export function canvasRenderingGaps(source) {
  const format = source.app?.format ?? source.tree?.format ?? 'pa.yaml';
  const gaps = [];
  for (const screen of source.tree?.screens ?? source.screens ?? []) {
    const controls = screen.controls ?? [];
    for (const control of controls) {
      const kind = controlKind(control.control, format);
      let reason = control.componentName
        ? 'Canvas components and code components are not rendered.'
        : !KINDS.has(kind)
          ? 'This control is not rendered by the local player.'
          : format !== 'fx.yaml' && MODERN.test(control.control ?? '')
            ? 'Modern controls are not rendered.'
            : null;
      const ancestors = [];
      for (let parent = control.parent; parent && !ancestors.includes(parent);) {
        ancestors.push(parent);
        parent = controls.find((candidate) => candidate.name === parent)?.parent;
      }
      if (
        !reason &&
        kind === 'container' &&
        /auto/i.test(control.variant ?? '') &&
        ancestors.some(
          (name) => controlKind(controls.find((item) => item.name === name)?.control, format) === 'gallery',
        )
      )
        reason = 'Automatic layout inside gallery templates is not rendered.';
      if (reason) gaps.push({ screen: screen.name, name: control.name, control: control.control, reason });
    }
  }
  return gaps;
}
