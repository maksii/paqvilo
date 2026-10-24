// Canvas control catalogue for the headless runtime (canvas-runtime.mjs): which source control types it hosts, under
// which kind, with the documented property names it reads, the input/output properties it maintains and the defaults it
// assumes for properties the source leaves out (pa.yaml serializes only properties that differ from their default).
// Every other control type is listed as unsupported (by name and type) and keeps only its declared formulas.

const LEARN = 'https://learn.microsoft.com/power-apps/maker/canvas-apps/controls/';

/**
 * kind → { title, doc, defaults }. `defaults` are values (not formulas) used when the source omits the property.
 * Every default below is a guess except Form DefaultMode (FormMode.Edit is the documented Form default) and Visible
 * (controls are visible unless Visible is false).
 */
export const CONTROL_CATALOGUE = Object.freeze({
  screen: { title: 'Screen', doc: `${LEARN}control-screen`, defaults: {} },
  label: { title: 'Label', doc: `${LEARN}control-text-box`, defaults: { Text: '' } },
  textinput: { title: 'Text input', doc: `${LEARN}control-text-input`, defaults: { Default: '' } },
  button: { title: 'Button', doc: `${LEARN}control-button`, defaults: { Text: '' } },
  gallery: { title: 'Gallery', doc: `${LEARN}control-gallery`, defaults: {} },
  form: { title: 'Edit form', doc: `${LEARN}control-form-detail`, defaults: { DefaultMode: 'Edit' } },
  formviewer: { title: 'Display form', doc: `${LEARN}control-form-detail`, defaults: {} },
  card: { title: 'Card', doc: `${LEARN}control-card`, defaults: { Required: false } },
  dropdown: { title: 'Drop down', doc: `${LEARN}control-drop-down`, defaults: {} },
  combobox: { title: 'Combo box', doc: `${LEARN}control-combo-box`, defaults: {} },
  checkbox: { title: 'Check box', doc: `${LEARN}control-check-box`, defaults: { Default: false } },
  toggle: { title: 'Toggle', doc: `${LEARN}control-toggle`, defaults: { Default: false } },
  datepicker: { title: 'Date picker', doc: `${LEARN}control-date-picker`, defaults: {} },
  image: { title: 'Image', doc: `${LEARN}control-image`, defaults: { Image: '' } },
  container: { title: 'Container', doc: `${LEARN}control-container`, defaults: {} },
});
/** Defaults every hosted control shares; DisplayMode.Edit for every control is a guess. */
export const COMMON_DEFAULTS = Object.freeze({ Visible: true, DisplayMode: 'Edit' });

// pa.yaml `Control: [Classic/]Type@version` (the Classic/ prefix names the classic variant of a control that also has a modern one).
// Type ids beyond Label, Gallery and Button are guessed from the control names.
const PA_TYPES = {
  screen: 'screen',
  label: 'label',
  text: 'label',
  textinput: 'textinput',
  button: 'button',
  gallery: 'gallery',
  form: 'form',
  formviewer: 'formviewer',
  typeddatacard: 'card',
  datacard: 'card',
  dropdown: 'dropdown',
  combobox: 'combobox',
  checkbox: 'checkbox',
  toggle: 'toggle',
  datepicker: 'datepicker',
  image: 'image',
  groupcontainer: 'container',
  container: 'container',
};
// .fx.yaml `Name As type[.variant]`; `text` is the text input there (a retired format with no published type list).
const FX_TYPES = {
  screen: 'screen',
  label: 'label',
  text: 'textinput',
  button: 'button',
  gallery: 'gallery',
  form: 'form',
  formviewer: 'formviewer',
  typeddatacard: 'card',
  datacard: 'card',
  dropdown: 'dropdown',
  combobox: 'combobox',
  checkbox: 'checkbox',
  toggleswitch: 'toggle',
  datepicker: 'datepicker',
  image: 'image',
  groupcontainer: 'container',
};

/** The hosted kind of a source control type, or null when the runtime does not host it. */
export function controlKind(control, format = 'pa.yaml') {
  if (!control) return null;
  const bare = String(control)
    .replace(/^classic\//i, '')
    .replace(/@.*$/, '');
  const base = (format === 'fx.yaml' ? bare.split('.')[0] : bare).toLowerCase();
  return (format === 'fx.yaml' ? FX_TYPES : PA_TYPES)[base] ?? null;
}

/** Controls of every screen the runtime lists but does not host: `{ screen, name, control }` (a component instance names its component). */
export function unsupportedControls(source) {
  const format = source.app?.format ?? source.tree?.format ?? 'pa.yaml';
  const rows = [];
  for (const screen of source.tree?.screens ?? source.screens ?? [])
    for (const control of screen.controls ?? [])
      if (control.componentName || !controlKind(control.control, format))
        rows.push({
          screen: screen.name,
          name: control.name,
          control: control.componentName ? `component ${control.componentName}` : String(control.control ?? 'unknown'),
        });
  return rows;
}
