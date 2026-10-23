import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { resolveProjectConfig } from '../mirage/lib/project-config.mjs';
import { importModelDrivenResources } from '../mirage/lib/model-driven-resources.mjs';
import { createModelDrivenPanelSources, modelDrivenPanelUi } from '../lense/model-driven-panel.mjs';
import { modelDrivenTargets, modelDrivenTargetSessions, readTargetMappings } from '../lense/model-driven-targets.mjs';

const references = [{ id: 'first', origin: 'https://first.example.invalid', default: true }, { id: 'other', origin: 'https://other.example.invalid' }];
const config = extra => ({ version: 2, runtime: { kind: 'model-driven' }, references, ...extra });
const resolve = input => resolveProjectConfig(input, path.resolve('invented/project.json'), { checkSources: false });
const imported = { assets: new Map([['x.js', { name: 'x.js', data: Buffer.from('1'), mime: 'text/javascript' }]]), resources: [{ name: 'x.js' }], diagnostics: [] };

test('only explicit model-driven targets admit references, defaults and per-target metadata', async () => {
  const project = await resolve(config({ modelDriven: { targets: [{ reference: 'first', resourceMap: './first.json', startPath: '/main.aspx?view=1', caution: true }] } }));
  const { targets, selected } = modelDrivenTargets(project);
  assert.equal(targets.length, 1);
  assert.equal(selected.id, 'first');
  assert.equal(selected.caution, true);
  assert.equal(modelDrivenPanelUi({ filter: 'edited' }).filter, 'edited');
  assert.equal(modelDrivenPanelUi({ filter: 'differs' }).filter, 'differs');
  assert.deepEqual(modelDrivenPanelUi({ filter: 'foreign' }), {});
  assert.equal(selected.mapFile, path.resolve('invented/first.json'));
  assert.throws(() => modelDrivenTargets(project, { env: 'other' }), /explicitly declared/);
  assert.throws(() => modelDrivenTargets(project, { env: 'first', url: references[0].origin }), /not both/);
  const legacy = modelDrivenTargets(project, { url: 'https://custom.example.invalid', path: '/main.aspx?form=2', 'resource-map': 'custom.json' });
  assert.equal(legacy.selected.id, 'explicit-url');
  assert.equal(legacy.selected.mapFile, path.resolve('custom.json'));
  assert.equal(legacy.targets[0].mapFile, selected.mapFile);
  assert.throws(() => modelDrivenTargets(project, { path: '//foreign.invalid/' }), /declared origin/);
});

test('config refuses missing references, duplicate origins, unsafe paths and non-opted loopback origins', async () => {
  await assert.rejects(resolve(config({ modelDriven: { targets: {} } })), /targets must contain/);
  await assert.rejects(resolve(config({ modelDriven: { targets: [{ reference: 'missing' }] } })), /unknown reference/);
  await assert.rejects(resolve(config({ references: references.map(item => ({ ...item, origin: references[0].origin })), modelDriven: { targets: references.map(item => ({ reference: item.id })) } })), /distinct origins/);
  for (const startPath of ['//foreign.invalid/', '/\\foreign', '/a b', '/a\n']) await assert.rejects(resolve(config({ modelDriven: { targets: [{ reference: 'first', startPath }] } })), /origin-local/);
  const loopback = { id: 'local', origin: 'http://127.0.0.1:1234' };
  await assert.rejects(resolve(config({ references: [loopback] })), /HTTPS origin/);
  const local = await resolve(config({ references: [loopback], modelDriven: { targets: [{ reference: 'local' }] } }));
  assert.equal(modelDrivenTargets(local).selected.origin, loopback.origin);
  await assert.rejects(resolve(config({ references: [{ ...loopback, origin: 'http://foreign.invalid' }], modelDriven: { targets: [{ reference: 'local' }] } })), /HTTPS origin/);
});

test('all declared maps are validated before any target revision can be published', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-target-maps-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const mapFile = path.join(dir, 'map.json');
  const targets = [{ id: 'first', origin: references[0].origin }, { id: 'other', origin: references[1].origin, mapFile }];
  await fs.writeFile(mapFile, JSON.stringify({ version: 1, resources: [{ path: '/asset.js', resource: 'not-declared.js' }] }));
  await assert.rejects(readTargetMappings(targets, imported), /undeclared Solution resource/);
  await fs.writeFile(mapFile, JSON.stringify({ version: 1, resources: [{ path: '/api/data', resource: 'x.js' }] }));
  await assert.rejects(readTargetMappings(targets, imported), /cannot target/);
  await fs.writeFile(mapFile, JSON.stringify({ version: 1, resources: [{ path: '/asset.js', resource: 'x.js' }] }));
  assert.equal((await readTargetMappings(targets, imported)).get('other')[0].path, '/asset.js');
});

test('switch and auth suspension retire identities/agents while source/UI state remains target-specific', async () => {
  const targets = references.map(item => ({ ...item, startPath: '/main.aspx' }));
  const events = [], saved = [];
  const sessions = modelDrivenTargetSessions({ targets, initial: targets[0], imported, mappings: new Map(targets.map(item => [item.id, []])),
    createInspector: async session => {
      const generation = events.length;
      events.push(`start:${session.target.id}`);
      saved.push(session.saved);
      return { refresh() {}, persistentState: () => ({ ui: { open: true }, sourceWitness: generation }), close: async () => { events.push(`close:${session.target.id}`); } };
    } });
  await sessions.activate(targets[0].origin);
  assert.equal(sessions.report().targets[1].activated, false);
  sessions.current().live = false;
  await sessions.activate(targets[1].origin);
  assert.deepEqual(events.slice(0, 3), ['start:first', 'close:first', 'start:other']);
  assert.equal(saved[1], null);
  await sessions.suspend();
  assert.equal(sessions.current().inspector, null);
  await assert.rejects(sessions.activate('https://undeclared.invalid'), /not declared/);
  await sessions.activate(targets[0].origin);
  assert.deepEqual(saved[2], { ui: { open: true }, sourceWitness: 0 });
  assert.equal(sessions.current().live, false);
  await sessions.close();
  await assert.rejects(sessions.activate(targets[1].origin), /stopped/);
});

test('a failed target retirement prevents another identity/agent from starting', async () => {
  const targets = references;
  let starts = 0;
  const failure = new Error('owned agent removal failed');
  const sessions = modelDrivenTargetSessions({ targets, initial: targets[0], imported, mappings: new Map(targets.map(item => [item.id, []])),
    createInspector: async () => { starts++; return { persistentState: () => ({}), close: async () => { throw failure; } }; } });
  await sessions.activate(targets[0].origin);
  await assert.rejects(sessions.activate(targets[1].origin), error => error === failure);
  assert.equal(starts, 1);
  await assert.rejects(sessions.activate(targets[1].origin), error => error === failure);
  assert.equal(starts, 1, 'retirement uncertainty cannot admit a later target');
  await sessions.close();
});


test('real Solution import native Diff uses declared names rather than importer URL keys and releases bytes on retirement', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-import-native-diff-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const resources = path.join(root, 'WebResources');
  await fs.mkdir(resources);
  await fs.writeFile(path.join(resources, 'x_script.js'), 'window.invented="local";');
  await fs.writeFile(path.join(resources, 'x_script.js.data.xml'), '<WebResource><Name>x_script.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/x_script.js</FileName></WebResource>');
  const source = await importModelDrivenResources([{ type: 'directory', dir: root }]);
  assert.equal(source.assets.has('x_script.js'), false, 'production importer is URL keyed');
  assert.equal([...source.assets.values()].some(asset => asset.name === 'x_script.js'), true);
  const tracker = await createModelDrivenPanelSources(source);
  assert.equal(tracker.observe('x_script.js', Buffer.from('window.invented="native";')), true);
  assert.equal(tracker.diff('x_script.js', 'Invented native').against, 'Invented native');
  assert.equal(tracker.diff('x_script.js', 'Invented native').rawEqual, false);
  await tracker.update(source);
  assert.equal(tracker.observationSize().resources, 1, 'a source update retains the matching native observation');
  assert.equal(tracker.state.facts.get('x_script.js').differs, true);
  tracker.clearNative();
  assert.equal(tracker.observationSize().bytes, 0);
  assert.equal(tracker.state.facts.get('x_script.js').differs, null);
  assert.equal(tracker.diff('x_script.js', 'Invented native').ok, false);
});
