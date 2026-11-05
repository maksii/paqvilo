// @test-kind contract: Paqvilo-owned offline content diagnostics, not native runtime parity.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { analyzeContent, contentRules } from '../lense/analysis/content-rules.mjs';

function scan(text, kind = 'html') {
  const unit = {
    file: `invented.${kind}`,
    text,
    kind,
    line: 1,
    column: 1,
    exactLocation: true,
  };
  const findings = [];
  analyzeContent([unit], (id, source, _record, offset) => findings.push({ id, source, offset }));
  for (const finding of findings) {
    assert.equal(finding.source, unit);
    assert.ok(Number.isInteger(finding.offset) && finding.offset >= 0 && finding.offset < text.length);
    assert.ok(contentRules.some((rule) => rule.id === finding.id));
  }
  return findings;
}

test('HTML parsing identifies static image alternatives without flagging decorative, dynamic or inert images', () => {
  const text =
    '<!-- <img src="hidden"> -->\n<img src="missing">\n<img alt="">\n<img {{ imageAttributes }}>\n<template><img></template>\n<script>const example = "<img>";</script>';
  const findings = scan(text);
  assert.deepEqual(
    findings.map(({ id, offset }) => ({ id, offset })),
    [{ id: 'content.image-alt', offset: text.indexOf('<img src="missing">') }],
  );
});

test('only external executable scripts in an explicit head receive rendering hints', () => {
  const text =
    '<html><head><script src="blocking.js"></script><script defer src="deferred.js"></script><script async src="async.js"></script><script type="module" src="module.js"></script><script type="application/ld+json" src="data.json"></script></head><body><script src="body.js"></script></body></html>';
  assert.deepEqual(
    scan(text).map(({ id }) => id),
    ['content.blocking-head-script'],
  );
  assert.deepEqual(scan('<script src="fragment.js"></script>'), []);
});

test('FetchXML diagnostics distinguish explicit projection, bounds, aggregates and dynamic attributes', () => {
  const text =
    '<fetch count="10"><entity name="sample_item"><all-attributes /></entity></fetch>\n<fetch><entity name="sample_item"><attribute name="sample_title" /></entity></fetch>\n<fetch aggregate="true"><entity name="sample_item"><attribute name="sample_title" aggregate="count" /></entity></fetch>\n<fetch top="2"><entity name="sample_item" /></fetch>\n<fetch {{ queryOptions }}><entity name="sample_item" /></fetch>';
  assert.deepEqual(
    scan(text).map(({ id }) => id),
    ['content.fetchxml-all-attributes', 'content.fetchxml-unbounded'],
  );
});

test('Liquid loop hints preserve offsets and ignore comment, raw and HTML comment examples', () => {
  const text =
    '{% comment %}{% for ignored in ignored %}<fetch><entity /></fetch>{% endfor %}{% endcomment %}\n{% raw %}<fetch><entity /></fetch>{% endraw %}\n<!-- <fetch><entity /></fetch> -->\n{% for row in rows %}<fetch count="2"><entity><attribute name="sample_title" /></entity></fetch>{% endfor %}\n<fetch top="1"><entity /></fetch>';
  const findings = scan(text);
  assert.deepEqual(
    findings.map(({ id, offset }) => ({ id, offset })),
    [
      {
        id: 'content.fetchxml-in-loop',
        offset: text.indexOf('<fetch count="2">'),
      },
    ],
  );
});

test('Liquid whitespace-control tags and nested loops do not leak into later queries', () => {
  const text =
    '{%- for row in rows -%}{%- for cell in row -%}<fetch top="1"><entity /></fetch>{%- endfor -%}{%- endfor -%}<fetch top="1"><entity /></fetch>';
  assert.deepEqual(
    scan(text).map(({ id }) => id),
    ['content.fetchxml-in-loop'],
  );
});

test('FetchXML examples inside script, style and textarea bodies are not queries', () => {
  const text =
    '<script>const example = "<fetch><entity><all-attributes /></entity></fetch>";</script><style>.example { content: "<fetch><entity /></fetch>"; }</style><textarea><fetch><entity /></fetch></textarea>';
  assert.deepEqual(scan(text), []);
});

test('nested and unfinished Liquid literal blocks cannot create findings', () => {
  assert.deepEqual(scan('{% comment %}{% comment %}<img>{% endcomment %}<img>{% endcomment %}'), []);
  assert.deepEqual(scan('{% manifest %}<img>{% endmanifest %}{% raw %}<fetch><entity /></fetch>'), []);
});

test('unfinished and nested query syntax does not fabricate a completed FetchXML query', () => {
  assert.deepEqual(scan('<fetch>'.repeat(20000)), []);
  assert.deepEqual(scan('<fetch'.repeat(20000)), []);
  assert.deepEqual(scan('{% for '.repeat(20000)), []);
  assert.deepEqual(scan('<fetch><fetch><entity /></fetch></fetch>'), []);
});

test('unclosed comments and inert regions remain excluded from query analysis', () => {
  assert.deepEqual(scan('<!--'.repeat(20000) + '<fetch><entity /></fetch>'), []);
  assert.deepEqual(scan('<script>'.repeat(20000) + '<fetch><entity /></fetch>'), []);
  assert.deepEqual(scan('<template><fetch><entity /></fetch></template>'), []);
  assert.deepEqual(scan('/*'.repeat(20000) + '@import "hidden.css"', 'css'), []);
});

// @test-kind security: Malformed source near the file budget must not repeatedly rescan the remaining input.
test('repeated unmatched query tags finish within a bounded child process', () => {
  const module = new URL('../lense/analysis/content-rules.mjs', import.meta.url).href;
  const script = `const { analyzeContent } = await import(${JSON.stringify(module)});
    analyzeContent([{ file: 'invented.html', text: '<fetch>'.repeat(200000), kind: 'html' }], () => {});`;
  const result = spawnSync(process.execPath, ['--input-type=module', '--eval', script], {
    encoding: 'utf8',
    timeout: 10000,
    maxBuffer: 4096,
  });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test('CSS imports ignore comments and quoted text while preserving exact source offsets', () => {
  const text = '/* @import "ignored.css"; */\n.example { content: "@import ignored"; }\n@import url("actual.css");';
  assert.deepEqual(
    scan(text, 'css').map(({ id, offset }) => ({ id, offset })),
    [{ id: 'content.css-import', offset: text.lastIndexOf('@import') }],
  );
  assert.deepEqual(scan('// @import "not-a-runtime-stylesheet"', 'js'), []);
});

test('content diagnostics metadata contains no customer text and keeps advisory rules distinct', () => {
  assert.equal(new Set(contentRules.map(({ id }) => id)).size, contentRules.length);
  for (const rule of contentRules) {
    assert.ok(['warning', 'hint'].includes(rule.severity));
    assert.ok(['high', 'medium'].includes(rule.confidence));
    assert.ok(rule.references.every((reference) => reference.startsWith('https://')));
  }
});
