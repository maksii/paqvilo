import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { editSource } from '../lense/source-edit.mjs';
import { componentContent } from '../lense/portal-model.mjs';

test('unchanged edits preserve exact XML/BOM bytes and timestamps without any write', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const component = path.join(dir, 'powerpagecomponent.xml');
  const script = path.join(dir, 'script.js');
  const xml = '\uFEFF<component><content><![CDATA[{"customjavascript":"old", "customcss":"red"}]]></content><name>Keep formatting</name></component>\r\n';
  fs.writeFileSync(component, xml);
  fs.writeFileSync(script, '\uFEFFwindow.before = true;\r\n');
  for (const source of [{ file: component, field: 'customjavascript' }, { file: script }]) {
    const before = fs.readFileSync(source.file);
    const stamp = fs.statSync(source.file).mtimeMs;
    const write = fs.writeFileSync;
    let writes = 0;
    const mock = t.mock.method(fs, 'writeFileSync', (...args) => { writes++; return write(...args); });
    editSource(source, (text) => text);
    mock.mock.restore();
    assert.equal(writes, 0);
    assert.deepEqual(fs.readFileSync(source.file), before);
    assert.equal(fs.statSync(source.file).mtimeMs, stamp);
  }
  editSource({ file: script }, (text) => text.replace('before', 'after'));
  assert.equal(fs.readFileSync(script, 'utf8'), '\uFEFFwindow.after = true;\r\n');
});

test('enhanced edits preserve unrelated fields and metadata, and failed edits leave bytes intact', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'powerpagecomponent.xml');
  const outer = '<name>Fixture &amp; metadata</name><powerpagecomponenttype>15</powerpagecomponenttype>';
  fs.writeFileSync(file, `<component><content><![CDATA[{"customjavascript":"old","customcss":"untouched","settings":{"enabled":true}}]]></content>${outer}</component>`);
  const updated = 'if (a < b && b > 0) { window.label = "text ]]> &"; }';
  editSource({ path: file, field: 'customjavascript' }, () => updated);
  const raw = fs.readFileSync(file, 'utf8');
  assert.deepEqual(componentContent(raw), { customjavascript: updated, customcss: 'untouched', settings: { enabled: true } });
  assert.ok(raw.includes(outer));
  for (const change of [() => { throw new Error('transform failed'); }, () => undefined, () => Promise.resolve('async')]) {
    assert.throws(() => editSource({ file, field: 'customjavascript' }, change));
    assert.equal(fs.readFileSync(file, 'utf8'), raw);
  }
  assert.throws(() => editSource({ file, field: 'settings' }, () => 'wrong'), /not text/);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('source edits enforce the discovered extract boundary before and after transformation', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const sourceDir = path.join(dir, 'extract');
  const externalDir = path.join(dir, 'external');
  fs.mkdirSync(sourceDir);
  fs.mkdirSync(externalDir);
  const file = path.join(externalDir, 'app.js');
  fs.writeFileSync(file, 'external();');
  let transformed = false;
  assert.throws(() => editSource({ file, sourceDir }, () => { transformed = true; return 'changed();'; }), /outside the extract/);
  assert.equal(transformed, false);
  assert.equal(fs.readFileSync(file, 'utf8'), 'external();');

  const assets = path.join(sourceDir, 'assets');
  fs.mkdirSync(assets);
  const local = path.join(assets, 'app.js');
  fs.writeFileSync(local, 'local();');
  assert.throws(() => editSource({ file: local, sourceDir }, () => {
    fs.renameSync(assets, path.join(sourceDir, 'previous-assets'));
    fs.symlinkSync(externalDir, assets, process.platform === 'win32' ? 'junction' : 'dir');
    return 'changed();';
  }), /outside the extract/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'external();');
});

test('a simultaneous component save is preserved instead of overwriting unrelated fields', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'powerpagecomponent.xml');
  const original = '<component><content>{"customjavascript":"before","customcss":"red"}</content></component>';
  const saved = original.replace('red', 'blue');
  fs.writeFileSync(file, original);
  assert.throws(() => editSource({ file, sourceDir: dir, field: 'customjavascript' }, () => {
    fs.writeFileSync(file, saved);
    return 'after';
  }), /changed while preparing/);
  assert.equal(fs.readFileSync(file, 'utf8'), saved);
});

test('explicit YAML edits preserve comments, sibling fields, BOM and CRLF', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Footer.weblinkset.yml');
  const raw = '\uFEFF# metadata comment\r\nadx_name: Footer # retain this comment\r\nadx_copy: |\r\n  <p>Original</p>\r\nsettings:\r\n  enabled: true\r\n';
  const source = { file, sourceDir: dir, format: 'yaml', field: 'adx_copy', fieldPath: ['adx_copy'] };
  fs.writeFileSync(file, raw);
  editSource(source, text => text);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  editSource(source, () => '<p>Changed & \\"quoted\\"</p>\n');
  const updated = fs.readFileSync(file, 'utf8');
  assert.ok(updated.startsWith('\uFEFF'));
  assert.ok(updated.includes('# metadata comment\r\n'));
  assert.ok(updated.includes('# retain this comment\r\n'));
  assert.equal(updated.replace(/\r\n/g, '').includes('\n'), false);
  assert.deepEqual(YAML.parse(updated), { adx_name: 'Footer', adx_copy: '<p>Changed & \\"quoted\\"</p>\n', settings: { enabled: true } });
  assert.throws(() => editSource({ ...source, field: 'settings', fieldPath: ['settings'] }, () => 'wrong'), /not text/);
  assert.equal(fs.readFileSync(file, 'utf8'), updated);
});

test('YAML edits require an explicit field and preserve other records in a sequence', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'metadata.yml');
  const raw = '- id: one\n  adx_description: Before # field comment\n- id: two\n  adx_description: Keep\n';
  fs.writeFileSync(file, raw);
  assert.throws(() => editSource({ file, format: 'yaml' }, () => 'wrong'), /explicit field/);
  assert.throws(() => editSource({ file, format: 'yaml', field: 'adx_description', fieldPath: [] }, () => 'wrong'), /explicit field path/);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  editSource({ file, format: 'yaml', field: '0.adx_description', fieldPath: [0, 'adx_description'] }, () => 'After');
  const updated = fs.readFileSync(file, 'utf8');
  assert.ok(updated.includes('# field comment'));
  assert.deepEqual(YAML.parse(updated), [{ id: 'one', adx_description: 'After' }, { id: 'two', adx_description: 'Keep' }]);
});

test('localized YAML JSON edits preserve languages, settings, records and comments', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'metadata.yml');
  const localized = [{ LCID: 1033, Value: '<a>Before</a>', Extra: { enabled: true } }, { LCID: 1045, Value: '<a>Keep</a>' }];
  fs.writeFileSync(file, '# records comment\n' + YAML.stringify([{ id: 'one', adx_description: JSON.stringify(localized) }, { id: 'two', adx_description: 'Untouched' }]));
  const raw = fs.readFileSync(file, 'utf8');
  const source = { file, format: 'yaml', field: 'adx_description', fieldPath: [0, 'adx_description'], jsonPath: [0, 'Value'] };
  editSource(source, text => text);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  editSource(source, () => '<a title="Quoted & text">After</a>\n');
  const updated = fs.readFileSync(file, 'utf8');
  assert.ok(updated.includes('# records comment'));
  const records = YAML.parse(updated);
  assert.deepEqual(JSON.parse(records[0].adx_description), [{ ...localized[0], Value: '<a title="Quoted & text">After</a>\n' }, localized[1]]);
  assert.deepEqual(records[1], { id: 'two', adx_description: 'Untouched' });
  for (const jsonPath of [[], [3, 'Value'], [0, 'Extra']]) assert.throws(() => editSource({ ...source, jsonPath }, () => 'wrong'));
  assert.equal(fs.readFileSync(file, 'utf8'), updated);
});

test('YAML aliases cannot silently change sibling fields during an explicit edit', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'Footer.weblinkset.yml');
  const raw = 'adx_copy: &markup "<p>Before</p>"\nsibling: *markup\n';
  fs.writeFileSync(file, raw);
  assert.throws(() => editSource({ file, format: 'yaml', field: 'adx_copy', fieldPath: ['adx_copy'] }, () => '<p>After</p>'), /unrelated values/);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
});

test('localized component JSON edits preserve other languages and XML metadata', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'powerpagecomponent.xml');
  const localized = [{ LCID: 1033, Value: '<p>Before</p>' }, { LCID: 1045, Value: '<p>Keep</p>' }];
  const original = { description: JSON.stringify(localized), settings: { enabled: true }, name: 'Fixture' };
  const outer = '<name>Fixture &amp; metadata</name>';
  const raw = `\uFEFF<component><content><![CDATA[${JSON.stringify(original)}]]></content>${outer}</component>`;
  fs.writeFileSync(file, raw);
  const source = { file, sourceDir: dir, field: 'description', jsonPath: [0, 'Value'] };
  editSource(source, text => text);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  editSource(source, () => '<p>After & text ]]> quoted "text"</p>');
  const updated = fs.readFileSync(file, 'utf8');
  assert.ok(updated.startsWith('\uFEFF'));
  assert.ok(updated.includes(outer));
  const content = componentContent(updated);
  assert.deepEqual(JSON.parse(content.description), [{ ...localized[0], Value: '<p>After & text ]]> quoted "text"</p>' }, localized[1]]);
  assert.deepEqual({ ...content, description: original.description }, original);
  assert.throws(() => editSource({ ...source, jsonPath: [8, 'Value'] }, () => 'wrong'), /missing JSON field/);
  assert.equal(fs.readFileSync(file, 'utf8'), updated);
});

test('stale record and language descriptors cannot edit a reordered metadata value', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'metadata.yml');
  const languages = [{ LCID: 1045, Value: '<p>Polish</p>' }, { LCID: 1033, Value: '<p>English</p>' }];
  const raw = YAML.stringify([{ adx_entityformmetadataid: 'second', adx_description: JSON.stringify(languages) }, { adx_entityformmetadataid: 'first', adx_description: 'Before' }]);
  fs.writeFileSync(file, raw);
  const source = { file, format: 'yaml', field: 'adx_description', fieldPath: [0, 'adx_description'], jsonPath: [0, 'Value'], recordId: 'first', recordIdField: 'adx_entityformmetadataid', lcid: 1033 };
  let transforms = 0;
  const transform = () => { transforms++; return 'wrong'; };
  assert.throws(() => editSource(source, transform), /stale record identity/);
  assert.throws(() => editSource({ ...source, recordId: 'second' }, transform), /stale language identity/);
  assert.equal(transforms, 0);
  assert.equal(fs.readFileSync(file, 'utf8'), raw);
  editSource({ ...source, recordId: 'second', lcid: 1045 }, () => '<p>Updated Polish</p>');
  const updated = YAML.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(JSON.parse(updated[0].adx_description)[0].Value, '<p>Updated Polish</p>');
  assert.equal(JSON.parse(updated[0].adx_description)[1].Value, '<p>English</p>');
});

test('component edits preserve XML when CDATA contains closing-tag text and split terminators', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'powerpagecomponent.xml');
  const initial = { customjavascript: "const tag = '</content>'; const terminator = ']]>';", settings: { enabled: true } };
  const body = JSON.stringify(initial).replaceAll(']]>', ']]]]><![CDATA[>');
  const suffix = '</content><name>Preserve metadata</name></component>';
  const raw = '<component><!-- <content>Fake</content> --><content><![CDATA[' + body + ']]>' + suffix;
  fs.writeFileSync(file, raw);
  editSource({ file, field: 'customjavascript', jsonPath: null }, text => text + '\nchanged();');
  const updated = fs.readFileSync(file, 'utf8');
  assert.ok(updated.endsWith(suffix));
  assert.ok(updated.includes('<!-- <content>Fake</content> -->'));
  assert.deepEqual(componentContent(updated), { ...initial, customjavascript: initial.customjavascript + '\nchanged();' });
});

test('duplicate JSON keys cannot be collapsed and lost by component or localized source edits', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pp-source-edit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const component = path.join(dir, 'powerpagecomponent.xml');
  const metadata = path.join(dir, 'metadata.yml');
  const xml = '<component><content><![CDATA[{"customjavascript":"Before","settings":{"enabled":true,"enabled":false}}]]></content></component>';
  const localized = '[{"LCID":1033,"Value":"Before","Value":"Keep duplicate"}]';
  const yaml = YAML.stringify([{ adx_description: localized }]);
  fs.writeFileSync(component, xml);
  fs.writeFileSync(metadata, yaml);
  let transforms = 0;
  const transform = () => { transforms++; return 'After'; };
  assert.throws(() => editSource({ file: component, field: 'customjavascript' }, transform), /ambiguous JSON/);
  assert.throws(() => editSource({ file: metadata, format: 'yaml', field: 'adx_description', fieldPath: [0, 'adx_description'], jsonPath: [0, 'Value'] }, transform), /ambiguous serialized JSON/);
  assert.equal(transforms, 0);
  assert.equal(fs.readFileSync(component, 'utf8'), xml);
  assert.equal(fs.readFileSync(metadata, 'utf8'), yaml);
});
