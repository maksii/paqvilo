import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { DataStore } from '../lib/data.mjs';
import { parseSchemaDocument, scanSolutionSources, classifySolutionPath } from '../lib/solution-schema.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { importSolutionPlugins, pluginCatalogue, pluginHandlers, runPluginPhase, parsePluginDocument, resolvePluginSourceFiles } from '../lib/exported-plugins.mjs';
import { validateOperationOverrides } from '../lib/operation-catalogue.mjs';
import { pluginFixture, pluginId, assemblyXml, pluginStepsXml } from './plugin-fixture.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { resolveMirageConfig } from '../../lense/config.mjs';
import { loadProjectConfig } from '../lib/project-config.mjs';

test('explicit C# sources stay confined to trusted roots and survive generated-project root normalization', async t => {
  const { dir, portal, solution } = await pluginFixture(t);
  const codeDir = path.join(dir, 'components/PluginRules');
  await fs.mkdir(codeDir, { recursive: true });
  const codeFile = path.join(codeDir, 'Rules.cs');
  await fs.writeFile(codeFile, 'namespace Invented.WidgetRules { public class Validate {} }');
  const raw = { evidence: 'Invented exact source association', pluginSources: { 'Invented.WidgetRules.Validate': { path: 'components/PluginRules/Rules.cs', evidence: 'Source fixture type association' } } };
  const catalogue = resolveMirageConfig({ observed: raw }, { sourceRoot: dir, configDir: dir });
  assert.equal(catalogue.observed.pluginSources['Invented.WidgetRules.Validate'].root, dir);
  const metadata = await importSolutionMetadata([solution], { observed: observedConfig(catalogue.observed) });
  assert.equal(metadata.plugins.steps[0].codeSourceFile, await fs.realpath(codeFile));
  assert.deepEqual(metadata.plugins.sourceRoots, [await fs.realpath(codeDir)]);
  assert.deepEqual(metadata.plugins.sourceFiles, [await fs.realpath(codeFile)]);
  const generated = path.join(dir, 'temporary-project/project.json');
  await fs.mkdir(path.dirname(generated));
  await fs.writeFile(generated, JSON.stringify({ version: 2, portals: [{ id: 'fixture', path: portal, observed: catalogue.observed }], solutions: [{ id: 'plugins', path: solution }] }));
  const project = await loadProjectConfig(generated);
  assert.equal(project.portals[0].observed.pluginSources['Invented.WidgetRules.Validate'].root, dir, 'temporary manifest must preserve original root');
  assert.throws(() => observedConfig({ evidence: 'Fixture', pluginSources: { 'Invented.WidgetRules.Validate': { path: '../outside.cs', evidence: 'Fixture' } } }), /relative/);
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-plugin-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.writeFile(path.join(outside, 'Outside.cs'), 'Outside trusted root');
  await fs.symlink(outside, path.join(codeDir, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const escaped = await resolvePluginSourceFiles(importSolutionPlugins((await scanSolutionSources([solution])).layers), { 'Invented.WidgetRules.Validate': { root: dir, path: 'components/PluginRules/linked/Outside.cs', evidence: 'Escape fixture' } });
  assert.equal(escaped.steps[0].codeSourceFile, null);
  assert.deepEqual(escaped.sourceRoots, []); assert.match(escaped.steps[0].codeSourceDiagnostic, /outside/);
});

test('PAC assembly attributes and GUID-only messages resolve only through exported facts or evidence-backed observations', () => {
  const messageId = pluginId(91);
  const xml = `<ImportExportXml><PluginAssembly FullName="Invented.WidgetRules, Version=2.0.0.0, Culture=neutral" PluginAssemblyId="${pluginId(1)}"><PluginTypes><PluginType Name="Invented.WidgetRules.Validate" AssemblyQualifiedName="Invented.WidgetRules.Validate, Invented.WidgetRules" PluginTypeId="${pluginId(2)}"/></PluginTypes><FileName>/PluginAssemblies/Rules.dll</FileName></PluginAssembly><SdkMessageProcessingStep Name="Misleading Create label" SdkMessageProcessingStepId="${pluginId(3)}"><SdkMessageId>${messageId}</SdkMessageId><PluginTypeId>${pluginId(2)}</PluginTypeId><PluginTypeName>Invented.WidgetRules.Validate, Invented.WidgetRules</PluginTypeName><PrimaryEntity>fx_widget</PrimaryEntity><Stage>10</Stage><Rank>3</Rank><Mode>0</Mode><SupportedDeployment>0</SupportedDeployment><Configuration>invented-secret-not-indexed</Configuration></SdkMessageProcessingStep></ImportExportXml>`;
  const facts = parseSchemaDocument(xml, { kind: 'customizations' });
  assert.equal(facts.plugins.assemblies[0].name, 'Invented.WidgetRules');
  assert.equal(facts.plugins.assemblies[0].version, '2.0.0.0');
  assert.equal(facts.plugins.types[0].name, 'Invented.WidgetRules.Validate');
  assert.equal(JSON.stringify(facts).includes('invented-secret-not-indexed'), false);
  const layers = [{ documents: [{ file: '/invented/Rules.dll.data.xml', facts }] }];
  const unknown = importSolutionPlugins(layers);
  assert.equal(unknown.steps[0].message, null); assert.match(unknown.steps[0].unsupported, /SDK message name is not exported/);
  const observed = observedConfig({ evidence: 'Invented API response fixture', sdkMessages: { [messageId]: { name: 'Update', evidence: 'Exact SDK message row fixture' } } });
  const resolved = importSolutionPlugins(layers, observed);
  assert.equal(resolved.steps[0].message, 'Update'); assert.equal(resolved.steps[0].messageEvidence, 'project-observation'); assert.equal(resolved.steps[0].unsupported, null);
  assert.notEqual(resolved.fingerprint, unknown.fingerprint);
  const exported = parseSchemaDocument(`<SdkMessage SdkMessageId="${messageId}" Name="Delete"/>`, { kind: 'plugin' });
  assert.equal(importSolutionPlugins([...layers, { documents: [{ file: '/invented/SdkMessages/message.xml', facts: exported }] }]).steps[0].message, 'Delete');
  assert.throws(() => observedConfig({ evidence: 'Fixture', sdkMessages: { [messageId]: { name: 'Create' } } }), /evidence/);
});

test('solution plugin facts preserve assembly/type/step registrations and exact source dependencies', async t => {
  const { solution } = await pluginFixture(t);
  const scan = await scanSolutionSources([solution]);
  const metadata = await importSolutionMetadata([solution], { scan });
  assert.equal(metadata.plugins.assemblies[0].name, 'Invented.WidgetRules');
  assert.equal(metadata.plugins.types[0].name, 'Invented.WidgetRules.Validate');
  assert.equal(metadata.plugins.steps.length, 9);
  const step = metadata.plugins.steps.find(item => item.id === pluginId(7));
  assert.equal(step.message, 'Update'); assert.equal(step.entity, 'fx_widget');
  assert.deepEqual(step.filteringAttributes, ['fx_title']); assert.equal(step.stageName, 'PreValidation');
  assert.equal(step.unsupported, null);
  assert.match(step.sourceFile, /SdkMessageProcessingSteps/); assert.match(step.typeSourceFile, /PluginAssemblies/); assert.match(step.assemblySourceFile, /PluginAssemblies/);
  assert.match(metadata.plugins.steps.find(item => item.id === pluginId(9)).unsupported, /Asynchronous/);
  assert.equal(metadata.plugins.steps.find(item => item.id === pluginId(10)).enabled, false);
  assert.equal(classifySolutionPath('PluginAssemblies/Synthetic/Synthetic.dll'), null);
  const combined = parseSchemaDocument(`<ImportExportXml>${assemblyXml}<SdkMessageProcessingSteps>${pluginStepsXml.join('')}</SdkMessageProcessingSteps></ImportExportXml>`, { kind: 'customizations' });
  assert.equal(importSolutionPlugins([{ documents: [{ file: '/invented/Customizations.xml', facts: combined, hash: 'one' }] }]).steps.length, 9);
  const unresolved = parsePluginDocument('<SdkMessageProcessingStep SdkMessageProcessingStepId="x"><SdkMessageId>an-id</SdkMessageId><Stage>10</Stage></SdkMessageProcessingStep>');
  assert.equal(unresolved.steps[0].message, null, 'message GUIDs are never guessed');
});

test('synchronous trusted plugin phases sort rank, filter submitted columns, reject async handlers and roll back failures', async () => {
  const parsed = parseSchemaDocument(`<ImportExportXml>${assemblyXml}${pluginStepsXml.join('')}</ImportExportXml>`, { kind: 'customizations' });
  const plugins = importSolutionPlugins([{ documents: [{ file: '/invented.xml', facts: parsed }] }]);
  const events = [], diagnostics = [];
  const handlers = pluginHandlers([{ id: 'trusted', pluginSteps: {
    [pluginId(3)]: ({ target, reject }) => { events.push('create10'); if (target.fx_title === 'bad') reject('Title rejected.'); },
    [pluginId(4)]: () => { events.push('rank2'); return { target: { fx_note: 'second' } }; },
    [pluginId(5)]: () => { events.push('rank1'); return { target: { fx_note: 'first' } }; },
    [pluginId(6)]: ({ record, reject }) => { events.push('create40'); if (record.fx_title === 'late') reject('PostOperation rejected.'); },
    [pluginId(7)]: () => { events.push('update10'); },
    [pluginId(8)]: ({ target }) => { events.push('update20'); return { target: { fx_title: target.fx_title.trim() } }; },
  } }]);
  const store = new DataStore({ state: { version: 1, mappings: { fx_widget: { entitySet: 'fx_widgets', idColumn: 'fx_widgetid' } }, tables: { fx_widget: [] }, plugins: [], permissions: [{ entity: 'fx_widget', scope: 'global', roles: ['Editor'], operations: ['create', 'update', 'delete', 'read'] }], settings: { permissionMode: 'enforce' } } });
  store.setPluginPipeline(context => runPluginPhase({ ...context, items: pluginCatalogue({ plugins, handlers }), handlers, diagnostic: note => diagnostics.push(note) }));
  const editor = { roles: ['Editor'] };
  await assert.rejects(store.create('fx_widgets', { fx_title: 'Denied' }, { roles: [] }), /permission/i);
  assert.deepEqual(events, [], 'denied writes never invoke handlers');
  const created = await store.create('fx_widgets', { fx_title: 'Valid' }, editor);
  assert.deepEqual(events, ['create10', 'rank1', 'rank2', 'create40']); assert.equal(created.fx_note, 'second');
  const before = store.snapshot();
  await assert.rejects(store.create('fx_widgets', { fx_title: 'bad' }, editor), /Title rejected/);
  await assert.rejects(store.create('fx_widgets', { fx_title: 'late' }, editor), /PostOperation rejected/);
  assert.deepEqual(store.snapshot(), before, 'both early and late exceptions roll back');
  events.length = 0;
  await store.update('fx_widgets', created.fx_widgetid, { fx_note: 'Changed note' }, editor);
  assert.deepEqual(events, [], 'unrelated attributes skip filtered Update registrations');
  assert.ok(diagnostics.some(item => item.code === 'PLUGIN_STEP_UNSUPPORTED' && item.stepId === pluginId(9)));
  await store.update('fx_widgets', created.fx_widgetid, { fx_title: 'Valid' }, editor);
  assert.deepEqual(events, ['update10', 'update20'], 'unchanged values still trigger submitted filtering attributes');
  assert.throws(() => pluginHandlers([{ id: 'async', pluginSteps: { [pluginId(3)]: async () => ({}) } }]), /synchronous/);
  const thenableHandlers = new Map([[pluginId(3), () => Promise.resolve({ target: { fx_title: 'Cannot escape' } })]]);
  const row = { fx_title: 'Original' };
  assert.throws(() => runPluginPhase({ items: pluginCatalogue({ plugins, handlers: thenableHandlers }), handlers: thenableHandlers, entity: 'fx_widget', operation: 'create', stage: 10, target: { ...row }, record: row, previous: null, identity: {}, changedAttributes: ['fx_title'] }), /synchronously/);
  assert.equal(row.fx_title, 'Original');
  assert.throws(() => validateOperationOverrides({ [`plugin-step:${pluginId(3)}`]: { mode: 'exported' } }), /.NET/);
  const targetBefore = store.snapshot();
  const invalidHandlers = new Map([[pluginId(7), () => ({ target: { fx_widgetid: pluginId(93) } })]]);
  store.setPluginPipeline(context => runPluginPhase({ ...context, items: pluginCatalogue({ plugins, handlers: invalidHandlers }), handlers: invalidHandlers }));
  await assert.rejects(store.update('fx_widgets', created.fx_widgetid, { fx_title: 'Cannot replace key' }, editor), /primary key/);
  assert.deepEqual(store.snapshot(), targetBefore);
  const lateHandlers = new Map([[pluginId(6), () => ({ target: { fx_title: 'Cannot persist after write' } })]]);
  store.setPluginPipeline(context => runPluginPhase({ ...context, items: pluginCatalogue({ plugins, handlers: lateHandlers }), handlers: lateHandlers }));
  await assert.rejects(store.create('fx_widgets', { fx_title: 'Post mutation' }, editor), /PostOperation/);
  assert.deepEqual(store.snapshot(), targetBefore);
});

test('automatic plugin placeholders and editable mocks are inventoried, CSRF protected, and prevent bad CRUD writes', async t => {
  const { app } = await pluginFixture(t);
  const csrf = app.state().csrf;
  const admin = (route, method = 'GET', value) => fetch(app.url + '/__sim/api' + route, { method, headers: { 'content-type': 'application/json', 'x-sim-csrf': csrf }, body: value === undefined ? undefined : JSON.stringify(value) });
  const write = (method, route, value, token = csrf) => fetch(app.url + '/_api/' + route, { method, headers: { 'content-type': 'application/json', __RequestVerificationToken: token }, body: value === undefined ? undefined : JSON.stringify(value) });
  const items = (await (await admin('/operations')).json()).items;
  assert.equal(items.length, 9); assert.equal(items[0].kind, 'plugin-step'); assert.equal(items[0].mode, 'placeholder');
  assert.equal((await write('POST', 'fx_widgets', { fx_title: 'Missing token' }, '')).status, 401);
  const created = await write('POST', 'fx_widgets', { fx_title: 'Placeholder allowed' });
  assert.equal(created.status, 204, await created.text());
  assert.ok(app.state().diagnostics.some(item => item.code === 'PLUGIN_STEP_PLACEHOLDER'));
  const row = app.store.snapshot().tables.fx_widget[0];
  const route = '/operations/' + encodeURIComponent(`plugin-step:${pluginId(7)}`);
  assert.equal((await admin(route, 'PATCH', { mode: 'mock', body: { error: { message: 'Local rejection' } } })).status, 200);
  const before = app.store.snapshot();
  const denied = await write('PATCH', `fx_widgets(${row.fx_widgetid})`, { fx_title: 'Rejected' });
  assert.equal(denied.status, 400);
  assert.equal((await denied.json()).error.code, '9004010D');
  assert.ok(app.state().diagnostics.some(item => item.code === 'PLUGIN_STEP_REJECTED' && item.message === 'Local rejection'));
  assert.deepEqual(app.store.snapshot(), before);
  assert.equal((await admin(route, 'PATCH', { mode: 'mock', body: { target: { fx_title: 'Configured title' } } })).status, 200);
  assert.equal((await write('PATCH', `fx_widgets(${row.fx_widgetid})`, { fx_title: 'Input' })).status, 204);
  assert.equal(app.store.snapshot().tables.fx_widget[0].fx_title, 'Configured title');
  assert.equal((await admin('/operations/' + encodeURIComponent(`plugin-step:${pluginId(9)}`), 'PATCH', { mode: 'mock' })).status, 409);
});
