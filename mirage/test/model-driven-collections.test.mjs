import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';

const formId = 'aabbccdd-1234-4abc-8def-123456abcdef';

function fixture() {
  const fields = {
    x_title: { name: 'x_title', type: 'text' },
    x_count: { name: 'x_count', type: 'number' },
  };
  const bindings = { title_editor: 'x_title', count_editor: 'x_count' };
  return createFormClientRuntime({
    table: { entity: 'x_item', fields, idColumn: 'x_itemid', nameColumn: 'x_title' },
    form: { id: formId, name: 'Invented form', attributes: Object.keys(fields) },
    record: { x_title: 'Invented', x_count: 2 },
    controlNames: (name) => Object.keys(bindings).filter((key) => !name || bindings[key] === name),
    controlField: (name) => bindings[name],
  });
}

test('form items resolve by form identity while attribute and control collections retain their own names', () => {
  const runtime = fixture(),
    form = runtime.formContext,
    attributes = form.data.entity.attributes,
    controls = form.ui.controls,
    forms = form.ui.formSelector.items,
    current = form.ui.formSelector.getCurrentItem();
  assert.equal(forms.get(current.getId()), current);
  assert.equal(forms.get(formId), current);
  assert.equal(forms.get(`{${formId.toUpperCase()}}`), current);
  assert.equal(forms.get('Invented form'), undefined, 'the form label is not its identity');
  assert.equal(forms.get('ffffffff-ffff-4fff-8fff-ffffffffffff'), undefined);
  assert.equal(attributes.get('x_title').getName(), 'x_title');
  assert.equal(attributes.get('title_editor'), undefined);
  assert.equal(controls.get('title_editor').getAttribute().getName(), 'x_title');
  assert.equal(controls.get('x_title'), undefined);
  assert.equal(attributes.get('x_title').controls.get('title_editor').getName(), 'title_editor');
  assert.equal(forms.get(0), current);
  assert.deepEqual(forms.get(), [current]);
  assert.deepEqual(
    forms.get((item, index) => index === 0 && item.getId() === current.getId()),
    [current],
  );
  assert.deepEqual(
    forms.get(() => false),
    [],
  );
  assert.equal(controls.get(1).getName(), 'count_editor');
  assert.deepEqual(
    attributes.get((attribute, index) => index === 1).map((attribute) => attribute.getName()),
    ['x_count'],
  );
});

test('form collection identity lookups preserve disposed-context checks', () => {
  const runtime = fixture(),
    form = runtime.formContext,
    items = form.ui.formSelector.items,
    attributes = form.data.entity.attributes,
    controls = form.ui.controls,
    retained = items.get(formId);
  runtime.destroy();
  assert.throws(() => items.get(formId), /disposed/);
  assert.throws(() => retained.getId(), /disposed/);
  assert.throws(() => attributes.get('x_title'), /disposed/);
  assert.throws(() => controls.get('title_editor'), /disposed/);
  assert.throws(() => items.get(0).getId(), /disposed/);
});
