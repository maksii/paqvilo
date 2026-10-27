// Rendering admission is narrower than the headless control catalogue. A logic-hosted
// Image or modern control must not make preflight claim that the HTML player renders it.
import { controlKind } from './canvas-controls.mjs';
import { prepareCanvasSource } from './canvas-components.mjs';

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
  'slider',
  'numberinput',
  'radio',
  'progress',
  'spinner',
  'timer',
  'image',
  'audio',
  'video',
  'codecomponent',
  'icon',
  'rectangle',
  'circle',
  'htmlviewer',
  'addmedia',
]);
const MODERN = /^(?:Modern(?:\/|[A-Z])|(?:Text|TextInput|Button|DropDown|ComboBox|CheckBox|Toggle|DatePicker)(?:@|$))/i;

/** Explicit source controls the baseline player cannot render; no formula is executed. */
export function canvasRenderingGaps(source) {
  const expanded = prepareCanvasSource(source);
  const format = expanded.app?.format ?? expanded.tree?.format ?? 'pa.yaml';
  const gaps = [];
  for (const screen of expanded.tree?.screens ?? expanded.screens ?? []) {
    const controls = screen.controls ?? [];
    for (const control of controls) {
      const kind = controlKind(control.control, format);
      const modern = format !== 'fx.yaml' && MODERN.test(control.control ?? '');
      const pcf = kind === 'codecomponent';
      const reason = pcf
        ? expanded.codeComponents?.[control.name]?.admitted
          ? null
          : 'Code component is not admitted by its local manifest.'
        : control.componentName
          ? 'Canvas component definition is unavailable.'
          : !KINDS.has(kind)
            ? 'This control is not rendered by the local player.'
            : modern
              ? 'Modern control behavior is approximated; version-specific properties may be unsupported.'
              : kind === 'htmlviewer'
                ? 'HTML viewer supports a restricted safe markup and typography subset; links and external media are omitted.'
                : kind === 'icon'
                  ? 'Icons use approximate text glyphs.'
                  : ['audio', 'video'].includes(kind)
                    ? 'Media playback can be interrupted by screen redraws; local assets and native events are supported.'
                    : null;
      if (reason)
        gaps.push({
          screen: screen.name,
          name: control.name,
          control: control.control,
          reason,
          ...((modern || ['audio', 'video', 'icon', 'htmlviewer'].includes(kind)) &&
          KINDS.has(kind) &&
          !control.componentName
            ? { renderable: true }
            : {}),
        });
    }
  }
  return gaps;
}
