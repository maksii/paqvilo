// @test-kind contract: structured locations point at the value a parsed JSON or YAML member occupies in its text.
import test from 'node:test';
import assert from 'node:assert/strict';
import YAML from 'yaml';
import { structuredLocator } from '../lense/analysis/structured-location.mjs';

// Line and column (1-based) of the first occurrence of `needle` in `text`.
function positionOf(text, needle) {
  const offset = text.indexOf(needle);
  assert.ok(offset >= 0, needle);
  const before = text.slice(0, offset).split('\n');
  return { line: before.length, column: before.at(-1).length + 1 };
}

const positionOfFound = (found) => ({ line: found.line, column: found.column });

test('a member value is located at its own line and column in pretty JSON', () => {
  const value = { inputs: { method: 'GET', uri: 'http://invented.example.test/' }, runAfter: {} };
  const text = JSON.stringify(value, null, 2);
  const entry = { file: 'Workflows/demo.json', text, line: 1, column: 1 };
  const at = structuredLocator(entry, value);
  const found = at(value.inputs, 'uri');
  assert.equal(found.exactLocation, true);
  assert.equal(found.file, 'Workflows/demo.json');
  assert.deepEqual(positionOfFound(found), positionOf(text, '"http://invented.example.test/"'));
});

test('an absent member, or an omitted key, points at the object that owns it', () => {
  const value = { inputs: { method: 'GET' } };
  const text = JSON.stringify(value, null, 2);
  const at = structuredLocator({ file: 'a.json', text, line: 1, column: 1 }, value);
  const found = at(value.inputs, 'retryPolicy');
  assert.equal(found.exactLocation, true);
  assert.deepEqual(positionOfFound(found), positionOf(text, '{\n    "method"'));
  assert.deepEqual(positionOfFound(at(value.inputs)), positionOf(text, '{\n    "method"'));
});

test('an array item is located by its index', () => {
  const value = { schemes: ['https', 'http'] };
  const text = JSON.stringify(value, null, 2);
  const at = structuredLocator({ file: 'a.json', text, line: 1, column: 1 }, value);
  const found = at(value.schemes, 1);
  assert.equal(found.exactLocation, true);
  assert.deepEqual(positionOfFound(found), positionOf(text, '"http"'));
});

test('an owner outside the document keeps the approximate anchor', () => {
  const value = { inputs: { uri: 'http://invented.example.test/' } };
  const entry = { file: 'a.json', text: JSON.stringify(value), line: 4, column: 2 };
  const at = structuredLocator(entry, value);
  assert.deepEqual(at({ uri: 'http://invented.example.test/' }, 'uri'), { ...entry, exactLocation: false });
  assert.equal(at(null, 'uri').exactLocation, false);
  assert.equal(at('text', 'uri').exactLocation, false);
});

test('a case-insensitive key matches a canonical lower-case field', () => {
  const value = { Value: 'invented', SchemaName: 'invented_name' };
  const text = JSON.stringify(value, null, 2);
  const at = structuredLocator({ file: 'a.json', text, line: 1, column: 1 }, value);
  const found = at(value, 'value');
  assert.equal(found.exactLocation, true);
  assert.deepEqual(positionOfFound(found), positionOf(text, '"invented"'));
});

test('a duplicate key resolves to the value JSON.parse keeps, the last one', () => {
  const text = '{\n  "uri": "http://first.example.test/",\n  "uri": "http://last.example.test/"\n}';
  const value = JSON.parse(text);
  const at = structuredLocator({ file: 'a.json', text, line: 1, column: 1 }, value);
  assert.deepEqual(positionOfFound(at(value, 'uri')), positionOf(text, '"http://last'));
});

test('a YAML document is located by the same walk', () => {
  const text = 'swagger: "2.0"\nschemes:\n  - http\nhost: invented.example.test\n';
  const value = YAML.parse(text);
  const at = structuredLocator({ file: 'api.yaml', text, line: 1, column: 1 }, value);
  const found = at(value, 'schemes');
  assert.equal(found.exactLocation, true);
  assert.deepEqual(positionOfFound(found), { line: 3, column: 3 });
});

test('unparseable text keeps the approximate anchor for every owner', () => {
  const value = { uri: 'x' };
  const entry = { file: 'a.json', text: '{ "uri": ', line: 3, column: 1 };
  assert.deepEqual(structuredLocator(entry, value)(value, 'uri'), { ...entry, exactLocation: false });
});

test('a value reached through an alias is located at the anchored node, and an aliased mapping keeps its members', () => {
  const text = 'base: &b\n  uri: "http://anchor.example.test/"\nalias: *b\n';
  const value = YAML.parse(text);
  const at = structuredLocator({ file: 'api.yaml', text, line: 1, column: 1 }, value);
  const found = at(value.alias, 'uri');
  assert.equal(found.exactLocation, true);
  assert.deepEqual(positionOfFound(found), positionOf(text, '"http://anchor'));
  assert.deepEqual(positionOfFound(at(value.alias)), positionOf(text, 'uri: "'));
});

test('a merge key value is located at the anchored node, and the mapping that merges it keeps its own members', () => {
  const text = 'base: &b\n  uri: "http://anchor.example.test/"\nnode:\n  <<: *b\n  other: 1\n';
  const value = YAML.parse(text);
  const at = structuredLocator({ file: 'api.yaml', text, line: 1, column: 1 }, value);
  const merged = at(value.node['<<'], 'uri');
  assert.equal(merged.exactLocation, true);
  assert.deepEqual(positionOfFound(merged), positionOf(text, '"http://anchor'));
  const own = at(value.node, 'other');
  assert.equal(own.exactLocation, true);
  assert.deepEqual(positionOfFound(own), positionOf(text, '1\n'));
});

test('an alias cycle in the data terminates and locates the members it reaches', () => {
  const sequence = 'a: &x [*x]\n';
  const list = YAML.parse(sequence);
  assert.equal(list.a[0], list.a);
  const atList = structuredLocator({ file: 'cycle.yaml', text: sequence, line: 1, column: 1 }, list);
  assert.equal(atList(list.a, 0).exactLocation, true);

  const mapping = 'a: &x {self: *x, v: 1}\n';
  const map = YAML.parse(mapping);
  assert.equal(map.a.self, map.a);
  const atMap = structuredLocator({ file: 'cycle.yaml', text: mapping, line: 1, column: 1 }, map);
  const found = atMap(map.a, 'v');
  assert.equal(found.exactLocation, true);
  assert.deepEqual(positionOfFound(found), positionOf(mapping, '1}'));
});
