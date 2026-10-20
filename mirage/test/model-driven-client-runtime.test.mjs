import test from 'node:test';
import assert from 'node:assert/strict';
import { createFormClientRuntime, evaluateRibbonRules, parseHandlerParameters, resolveClientFunction, loadClientLibrary } from '../lib/model-driven/client-runtime.mjs';
import { compileForm, parseRibbonCommands, parseAppActionCommand } from '../lib/model-driven/solution.mjs';

function runtimeFixture(overrides = {}) {
  const record = { x_itemid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', x_name: 'Copper', x_quantity: 2 }, writes = [], requests = [], notices = [], state = new Map();
  const host = { record, table: { entity: 'x_item', idColumn: 'x_itemid', nameColumn: 'x_name', fields: { x_name: { name: 'x_name', type: 'text' }, x_quantity: { name: 'x_quantity', type: 'number' } } }, tables: { x_item: { idColumn: 'x_itemid' } },
    form: { clientEvents: [] }, extensions: { trusted: false }, read: name => record[name], write: (name, value) => { record[name] = value; writes.push({ name, value }); }, isDirty: name => name ? writes.some(write => write.name === name) : writes.length > 0,
    controlNames: name => name ? [name] : ['x_name', 'x_quantity'], controlField: name => name,
    controlState: (name, key, value) => value === undefined ? state.get(name + key) : state.set(name + key, value), notification: (...args) => notices.push(args),
    request: async (entity, id, options = {}) => { requests.push({ entity, id, options }); return { row: record, rows: [record], etag: 'W/"1"', more: false }; }, save: async close => writes.push({ save: close }), refresh() {}, close() {}, openForm() {}, alert: async () => {}, confirm: async () => true,
    environment: { location: { origin: 'http://127.0.0.1:1234', href: 'http://127.0.0.1:1234/main.aspx' } }, ...overrides };
  return { runtime: createFormClientRuntime(host), record, writes, requests, notices, state, host };
}

test('form client APIs dispatch async events, track edits and cancel OnSave without executing expressions', async () => {
  const { runtime, record, writes, notices } = runtimeFixture();
  let changes = 0;
  const attribute = runtime.formContext.getAttribute('x_name');
  attribute.addOnChange(async context => { await Promise.resolve(); changes++; assert.equal(context.getEventSource(), attribute); context.getFormContext().getAttribute('x_quantity').setValue(3); });
  attribute.setValue('Silver'); assert.equal(changes, 0, 'setValue does not implicitly fire OnChange');
  await attribute.fireOnChange(); assert.equal(changes, 1); assert.equal(record.x_quantity, 3); assert.equal(attribute.getIsDirty(), true);
  runtime.formContext.data.entity.addOnSave(context => { assert.equal(context.getEventArgs().getSaveMode(), 2); context.getEventArgs().preventDefault(); context.getFormContext().ui.setFormNotification('Explain why', 'ERROR', 'validation'); });
  assert.equal((await runtime.dispatch('onsave', undefined, 2)).prevented, true);
  assert.equal(writes.some(write => Object.hasOwn(write, 'save')), false); assert.deepEqual(notices[0], ['Explain why', 'ERROR', 'validation']);
  assert.throws(() => runtime.Xrm.Utility.getGlobalContext().organizationSettings, /does not support/);
  assert.throws(() => runtime.formContext.getAttribute('x_name').setSubmitMode('always'), /does not support/);
  runtime.destroy(); assert.throws(() => attribute.getValue(), /disposed/); assert.deepEqual(notices.at(-1), [null, null, 'validation']);
  assert.throws(() => runtime.Xrm.WebApi.updateRecord('x_item', 'id', { x_name: 'stale' }), /disposed/);
});

test('client attribute types and choice labels derive from exported metadata', () => {
  const { runtime } = runtimeFixture({ table: { entity: 'x_item', idColumn: 'x_itemid', fields: {
    x_amount: { name: 'x_amount', type: 'number', dataverseType: 'money' }, x_decimal: { name: 'x_decimal', type: 'number', dataverseType: 'decimal' },
    x_choice: { name: 'x_choice', type: 'number', options: [{ value: 1, label: 'One' }] },
  } } });
  assert.equal(runtime.formContext.getAttribute('x_amount').getAttributeType(), 'money');
  assert.equal(runtime.formContext.getAttribute('x_decimal').getAttributeType(), 'decimal');
  assert.equal(runtime.formContext.getAttribute('x_choice').getAttributeType(), 'optionset');
  assert.deepEqual(runtime.formContext.getAttribute('x_choice').getOption('One'), { text: 'One', value: 1 });
});

test('WebApi maps local logical names and typed bounded query options through the staff adapter', async () => {
  const { runtime, requests } = runtimeFixture();
  const result = await runtime.Xrm.WebApi.retrieveMultipleRecords('x_item', "?$select=x_name,x_quantity&$filter=x_quantity ge 2 and x_name ne 'Gold'&$orderby=x_quantity desc&$top=5");
  assert.equal(result.entities.length, 1);
  assert.deepEqual(requests[0].options.query, { columns: ['x_name', 'x_quantity'], filters: [{ field: 'x_quantity', operator: 'ge', value: 2 }, { field: 'x_name', operator: 'ne', value: 'Gold' }], sort: 'x_quantity', direction: 'desc', pageSize: 5, scope: 'table' });
  await runtime.Xrm.WebApi.updateRecord('x_item', 'id', { x_name: 'Gold' });
  assert.equal(requests.at(-1).options.etag, 'W/"1"'); assert.equal(requests.at(-1).options.method, 'PATCH');
  await assert.rejects(runtime.Xrm.WebApi.retrieveMultipleRecords('x_item', '?$expand=anything'), /does not support/);
  await assert.rejects(runtime.Xrm.WebApi.retrieveMultipleRecords('x_item', '?$filter=contains(x_name,\'A\')'), /does not support/);
});

test('exported script loading requires explicit trust and local resource admission', async () => {
  const environment = { location: { origin: 'http://127.0.0.1:1234', href: 'http://127.0.0.1:1234/main.aspx' }, document: { createElement() { throw new Error('must not create a script'); } } };
  await assert.rejects(loadClientLibrary('x.js', { trusted: false }, environment), /disabled/);
  await assert.rejects(loadClientLibrary('x.js', { trusted: true, resources: [{ name: 'x.js', type: 'script', url: 'https://example.invalid/x.js' }] }, environment), /local imported/);
  await assert.rejects(loadClientLibrary('x.js', { trusted: true, resources: [{ name: 'x.js', type: 'script', url: '/_sim/api' }] }, environment), /local imported/);
  assert.throws(() => resolveClientFunction({ Sample: {} }, 'Sample.constructor'), /invalid/);
  assert.throws(() => resolveClientFunction({}, 'fetch("https://example.invalid")'), /invalid/);
  const fn = () => {}; assert.equal(resolveClientFunction({ Sample: { Sample: fn } }, 'Sample.Sample').fn, fn);
  assert.deepEqual(parseHandlerParameters("'hello', 2, true, null, \"quoted\""), ['hello', 2, true, null, 'quoted']);
  assert.throws(() => parseHandlerParameters('window.location'), /primitive constants/);
  assert.throws(() => parseHandlerParameters('{"a":1}'), /primitive constants/);
});

test('unsupported WebApi lookup bindings fail before any record request or partial mutation', async () => {
  const { runtime, requests, record } = runtimeFixture(); const before = structuredClone(record);
  await assert.rejects(runtime.Xrm.WebApi.updateRecord('x_item', record.x_itemid, { x_name: 'Must not write', 'x_parentid@odata.bind': '/x_items(aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa)' }), /does not support Xrm.WebApi lookup binding/);
  await assert.rejects(runtime.Xrm.WebApi.createRecord('x_item', { x_name: 'Must not create', 'x_parentid@odata.bind': null }), /lookup binding/);
  assert.deepEqual(requests, []); assert.deepEqual(record, before);
});

test('form XML compiles native handler metadata and ribbon preserves unsupported commands visibly', () => {
  const form = compileForm({ id: 'events', xml: '<form><formLibraries><Library name="x_/sample.js" /></formLibraries><events><event name="onload"><Handlers><Handler functionName="Sample.load" libraryName="x_/sample.js" enabled="true" passExecutionContext="true" parameters="2"/></Handlers></event><event name="onchange" attribute="x_name"><Handlers><Handler functionName="Sample.change" libraryName="x_/sample.js" enabled="false"/></Handlers></event></events></form>' }, {});
  assert.deepEqual(form.libraries, ['x_/sample.js']); assert.equal(form.clientEvents[0].handlers[0].passExecutionContext, true); assert.equal(form.clientEvents[1].attribute, 'x_name'); assert.equal(form.clientEvents[1].handlers[0].enabled, false);
  const commands = parseRibbonCommands('<RibbonDiffXml><CustomActions><CustomAction><CommandUIDefinition><Button Id="x.Form.Do" Command="x.Do" LabelText="$LocLabels:x.Label"/></CommandUIDefinition></CustomAction><CustomAction><CommandUIDefinition><Button Id="x.HomePageGrid.Unsupported" Command="x.Unsupported" LabelText="Unsupported"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="x.Do"><EnableRules><EnableRule Id="x.Existing"/></EnableRules><Actions><JavaScriptFunction Library="$webresource:x_/sample.js" FunctionName="Sample.command"><CrmParameter Value="PrimaryControl"/></JavaScriptFunction></Actions></CommandDefinition><CommandDefinition Id="x.Unsupported"><Actions><Url Address="https://example.invalid"/></Actions></CommandDefinition></CommandDefinitions><RuleDefinitions><EnableRules><EnableRule Id="x.Existing"><FormStateRule State="Existing"/></EnableRule></EnableRules></RuleDefinitions><LocLabels><LocLabel Id="x.Label"><Titles><Title languagecode="1033" description="Do something"/></Titles></LocLabel></LocLabels></RibbonDiffXml>');
  assert.equal(commands[0].label, 'Do something'); assert.equal(commands[0].supported, true); assert.deepEqual(commands[0].locations, ['form']);
  assert.equal(evaluateRibbonRules(commands[0].enableRules, { existing: false }), false); assert.equal(evaluateRibbonRules(commands[0].enableRules, { existing: true }), true);
  assert.equal(commands[1].supported, false); assert.deepEqual(commands[1].locations, ['grid']);
});

test('save reentrancy is rejected during lifecycle events but allowed from ribbon-style form API calls', async () => {
  const { runtime, writes } = runtimeFixture();
  runtime.formContext.data.entity.addOnSave(async context => { await assert.rejects(async () => context.getFormContext().data.save(), /active onsave/); });
  await runtime.dispatch('onsave'); await runtime.formContext.data.save(); assert.deepEqual(writes, [{ save: false }]);
});

test('modern AppAction compiles its exported WebResource ID and PrimaryControl without evaluating parameter text', () => {
  const xml = '<appaction uniquename="x_modern"><buttonlabeltext default="Modern reviewed"><label description="Modern reviewed" languagecode="1033"/></buttonlabeltext><context>1</context><contextentity><logicalname>x_item</logicalname></contextentity><contextvalue>x_item</contextvalue><hidden>0</hidden><isdisabled>0</isdisabled><location>0</location><name>modern</name><onclickeventjavascriptfunctionname>Sample.mark</onclickeventjavascriptfunctionname><onclickeventjavascriptparameters>[{"type":5,"value":null}]</onclickeventjavascriptparameters><onclickeventjavascriptwebresourceid><webresourceid>aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa</webresourceid></onclickeventjavascriptwebresourceid><onclickeventtype>2</onclickeventtype><type>0</type></appaction>';
  const command = parseAppActionCommand(xml, { webresourcesById: new Map([['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'x_/sample.js']]) });
  assert.equal(command.entity, 'x_item'); assert.equal(command.supported, true); assert.deepEqual(command.actions[0].parameters, [{ kind: 'crm', value: 'PrimaryControl' }]);
  assert.equal(parseAppActionCommand(xml).supported, false, 'missing resource keeps command disabled');
  assert.equal(parseAppActionCommand(xml.replace('<context>1</context>', '<context>2</context>'), { webresourcesById: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'x_/sample.js' } }).supported, false);
  assert.equal(parseAppActionCommand(xml.replace('<hidden>0</hidden>', '<statecode>1</statecode>'), { webresourcesById: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'x_/sample.js' } }).supported, false);
  assert.equal(parseAppActionCommand(xml.replace('[{"type":5,"value":null}]', 'window.alert(1)'), { webresourcesById: { 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa': 'x_/sample.js' } }).supported, false);
});
