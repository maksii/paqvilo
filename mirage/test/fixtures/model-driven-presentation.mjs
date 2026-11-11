import { createFormClientRuntime } from '../../lib/model-driven/client-runtime.mjs';

export function presentationFixture({ falseBooleanDefault = false } = {}) {
  const options = ['Planned', 'In progress', 'Complete'].map((label, index) => ({ label, value: 198720000 + index }));
  const fields = Object.fromEntries(Object.entries({
    title: { type: 'text' }, email: { type: 'text', format: 'email' }, memo: { type: 'textarea' },
    quantity: { type: 'number', dataverseType: 'int', minValue: 0, maxValue: 10000 },
    choice: { type: 'number', options }, multi: { type: 'multiselect', options },
    boolean: { type: 'boolean', ...(falseBooleanDefault ? { defaultValue: false } : {}) }, date: { type: 'date' }, lookup: { type: 'lookup', targets: ['x_contract'] },
  }).map(([role, value]) => ['x_' + role, { ...value, name: 'x_' + role, label: role }]));
  const record = Object.fromEntries(Object.keys(fields).map(name => [name, null]));
  if (falseBooleanDefault) record.x_boolean = false;
  const section = { name: 'fixture-section', label: 'Fixture section', fields: Object.keys(fields).map(name => ({ name })) };
  const tab = { id: 'fixture-tab', label: 'Native components', sections: [section] };
  const states = new Map(), layout = new Map(), touched = new Set(); let dirty = false;
  const runtime = createFormClientRuntime({
    table: { entity: 'x_contract', idColumn: 'x_contractid', nameColumn: 'x_title', fields },
    form: { attributes: Object.keys(fields), tabs: [tab] }, record,
    read: name => record[name],
    write: (name, value, { changed = true } = {}) => { record[name] = value; if (changed) { dirty = true; touched.add(name); } },
    isDirty: name => name ? touched.has(name) : dirty,
    controlNames: name => name ? [name] : Object.keys(fields), controlField: name => name,
    controlState: (name, key, value) => {
      if (value !== undefined) return states.set(name + ':' + key, value);
      return states.get(name + ':' + key) ?? (key === 'disabled' ? false : key === 'label' ? fields[name].label : undefined);
    },
    setLayoutVisible: (item, value) => { layout.set(item, value); },
    layoutVisible: item => layout.get(item) ?? true,
    notification() {},
  });
  return { runtime, record, tab, section, input: {
    entity: 'x_contract', tabLabel: 'Native components',
    names: { quantity: 'x_quantity', email: 'x_email', title: 'x_title' },
    controls: Object.fromEntries(['quantity','email','choice','multi','boolean','date','lookup'].map(role => [role, 'x_' + role])),
  } };
}
