// @test-kind contract: which export scripts Lense indexes by parsed-code hash, how it maps them back and when a hash proves nothing is Paqvilo's designed attribution rule
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scriptHashIndex } from '../lense/script-source-evidence.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const source = (name, text, { kind = 'webfile', field = '$content', file = name } = {}) => ({
  id: 'invented:' + name,
  key: 'invented:' + name,
  kind,
  fieldPath: [field],
  ref: name,
  file,
  sourceRevision: 'invented-revision',
  contentRevision: hash(text),
  text,
});
const indexOf = (...sources) => ({
  sourceRevision: 'invented-revision',
  sources: new Map(sources.map((s) => [s.id, s])),
});
// Where a generated offset lands in the source, through the entry's mappings.
const sourceOffset = (entry, offset) => {
  const mapping = entry.mappings.find((item) => item.generatedStart <= offset && offset < item.generatedEnd);
  return mapping.sourceStart + offset - mapping.generatedStart;
};

test('a web file is indexed as the browser parses it: without its byte order mark, with source offsets kept', () => {
  const text = '﻿document.createElement("i");\r\nwindow.x=1;';
  const index = scriptHashIndex(indexOf(source('web-files/app.js', text)));
  const entry = index.byHash.get(hash(text.slice(1)));
  assert.ok(entry);
  assert.equal(entry.ref.ref, 'web-files/app.js');
  assert.equal(entry.ref.text, undefined, 'the indexed ref carries no source text');
  assert.equal(sourceOffset(entry, 0), 1);
  assert.deepEqual(entry.lineStarts, [0, text.slice(1).indexOf('window')]);
  assert.equal(index.byHash.size, 1);
  const styles = scriptHashIndex(indexOf(source('web-files/site.css', 'body{}')));
  assert.equal(styles.byHash.size, 0, 'only JavaScript web files are scripts');
});

test('custom JavaScript and template script bodies are indexed with the newlines the HTML parser hands the script', () => {
  const custom = 'const a=1;\r\nconst b=2;\rconst c=3;';
  const template =
    '<div>{{ page.title }}</div><script>\r\nwindow.t=1;\r\n</script>' +
    '<script src="/x.js"></script><script type="text/x-template"><b></b></script>' +
    '<script>window.v="{{ value }}";</script>';
  const index = scriptHashIndex(
    indexOf(
      source('Home.customjs.js', custom, { kind: 'webpage', field: 'customjavascript' }),
      source('Layout.webtemplate.source.html', template, { kind: 'webtemplate', field: 'source' }),
    ),
  );
  const parsed = 'const a=1;\nconst b=2;\nconst c=3;';
  const entry = index.byHash.get(hash(parsed));
  assert.ok(entry);
  assert.equal(sourceOffset(entry, parsed.indexOf('const c')), custom.indexOf('const c'));
  assert.equal(sourceOffset(entry, parsed.indexOf('const b')), custom.indexOf('const b'));
  for (const mapping of entry.mappings)
    assert.equal(mapping.generatedEnd - mapping.generatedStart, mapping.sourceEnd - mapping.sourceStart);
  const body = '\nwindow.t=1;\n';
  const scripted = index.byHash.get(hash(body));
  assert.ok(scripted, 'the Liquid-free template script body is indexed');
  assert.equal(sourceOffset(scripted, body.indexOf('window')), template.indexOf('window.t'));
  assert.equal(index.byHash.has(hash('window.v="{{ value }}";')), false, 'a body with Liquid is not');
  assert.equal(index.byHash.has(hash('<b></b>')), false, 'a non-JavaScript script type is not');
});

test('a hash two places of the export produce is a conflict, and the bounds say when sources were left out', () => {
  const text = 'document.body.append(document.createElement("i"));';
  const index = scriptHashIndex(indexOf(source('web-files/a.js', text), source('web-files/b.js', text)));
  assert.deepEqual(index.byHash.get(hash(text)), { conflict: true });
  const twice = scriptHashIndex(
    indexOf(
      source('T.html', `<script>${text}</script><script>${text}</script>`, { kind: 'webtemplate', field: 'source' }),
    ),
  );
  assert.deepEqual(twice.byHash.get(hash(text)), { conflict: true }, 'one source, two places: no place is proved');
  const bounded = scriptHashIndex(indexOf(source('web-files/a.js', text), source('web-files/c.js', 'window.c=1;')), {
    sources: 1,
    characters: 1024,
    perTemplate: 64,
  });
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.byHash.size, 1);
  assert.equal(scriptHashIndex(indexOf(source('web-files/a.js', text))).truncated, false);
});

test('a script body ends where the parser ends it: an end tag with whitespace or stray text before its bracket', () => {
  const first = 'window.first=1;';
  const second = 'window.second=2;';
  const template = `<script>${first}</script\t\n bar><p>between</p><script>${second}</script >`;
  const index = scriptHashIndex(indexOf(source('T.html', template, { kind: 'webtemplate', field: 'source' })));
  assert.ok(index.byHash.get(hash(first)), 'the first body ends at its own end tag');
  assert.ok(index.byHash.get(hash(second)));
  assert.equal(index.byHash.has(hash(`${first}</script\t\n bar><p>between</p><script>${second}`)), false);
});
