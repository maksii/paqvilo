import test from 'node:test';
import assert from 'node:assert/strict';
import { compileForm } from '../lib/model-driven/solution.mjs';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';

// A form: x_name in the body, x_status in the header; the table also has x_secret and its primary id.
const fields = { x_itemid: { name: 'x_itemid', type: 'text', isPrimaryId: true }, x_name: { name: 'x_name', type: 'text' }, x_status: { name: 'x_status', type: 'number', options: [{ value: 1, label: 'Open' }] }, x_secret: { name: 'x_secret', type: 'text' } };
const xml = '<form><header><rows><row><cell><control id="header_x_status" datafieldname="x_status"/></cell></row></rows></header><tabs><tab name="general"><columns><column><sections><section name="main"><rows><row><cell><control id="x_name" datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form>';

function runtime(extra = {}) {
  const form = compileForm({ id: 'invented-form', name: 'Information', xml }, fields);
  const table = { entity: 'x_item', idColumn: 'x_itemid', nameColumn: 'x_name', fields };
  const record = { x_itemid: '77777777-7777-4777-8777-777777777777', x_name: 'Invented', x_status: 1, x_secret: 'not on the form' };
  const cells = form.tabs.flatMap(tab => tab.sections.flatMap(section => section.fields)).filter(cell => cell.name);
  return { form, client: createFormClientRuntime({ table, tables: { x_item: table }, form, record, read: name => record[name], write() {}, isDirty: () => false,
    controlNames: name => cells.filter(cell => !name || cell.name === name).map(cell => cell.sourceControl.id), controlField: id => cells.find(cell => cell.sourceControl.id === id)?.name,
    controlState() {}, notification() {}, request: async () => ({}), extensions: { trusted: false }, ...extra }) };
}

test('formContext exposes exactly the columns bound on the form body and header', () => {
  const { form, client } = runtime();
  assert.deepEqual(form.attributes, ['x_status', 'x_name']);
  assert.deepEqual(client.formContext.getAttribute().map(attribute => attribute.getName()).sort(), ['x_name', 'x_status']);
  assert.deepEqual(client.formContext.data.entity.attributes.get().map(attribute => attribute.getName()).sort(), ['x_name', 'x_status']);
  assert.equal(client.formContext.getAttribute('x_status').getText(), 'Open');
});

test('columns that are not on the form are absent, including the primary id', () => {
  const { client } = runtime();
  assert.equal(client.formContext.getAttribute('x_secret'), null);
  assert.equal(client.formContext.getAttribute('x_itemid'), null);
  assert.equal(client.formContext.getControl('x_secret'), null);
  assert.equal(client.formContext.data.entity.getId(), '{77777777-7777-4777-8777-777777777777}');
});

test('a ribbon PrimaryControl sees the same form-bound attribute set', async () => {
  let seen;
  const environment = { location: { href: 'http://127.0.0.1:1/main.aspx', origin: 'http://127.0.0.1:1' },
    document: { createElement: () => ({}), head: { append: element => queueMicrotask(() => element.onload()) } } };
  const extensions = { trusted: true, resources: [{ name: 'x_/ribbon.js', type: 'script', url: '/_apps/resources/invented' }] };
  const { client } = runtime({ extensions, environment, scope: { inventedRibbon: { inspect: primary => { seen = primary.getAttribute().map(attribute => attribute.getName()).sort(); } } } });
  await client.command({ supported: true, actions: [{ library: 'x_/ribbon.js', functionName: 'inventedRibbon.inspect', parameters: [{ kind: 'crm', value: 'PrimaryControl' }] }] });
  assert.deepEqual(seen, ['x_name', 'x_status']);
});
