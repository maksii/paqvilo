import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { identityMapUrl, withFileSourceMap } from '../lense/source-map.mjs';

const file = path.resolve('test source ü.js');
const readMap = (url) => JSON.parse(Buffer.from(url.slice(url.indexOf(',') + 1), 'base64').toString('utf8'));

test('identity source maps retain local paths and embed the debugger source', () => {
  const source = 'one\r\ntwo\rthree\u2028four\u2029five';
  const body = withFileSourceMap(Buffer.from(source), file).toString('utf8');
  const map = readMap(body.match(/sourceMappingURL=(\S+)/)[1]);
  assert.equal(map.version, 3);
  assert.deepEqual(map.sources, [pathToFileURL(file).href]);
  assert.deepEqual(map.sourcesContent, [source]);
  assert.equal(map.mappings, 'AAAA;AACA;AACA;AACA;AACA');
});

test('existing large inline and block source maps are preserved', () => {
  for (const directive of [`//# sourceMappingURL=data:application/json;base64,${'a'.repeat(5000)}`, '/*# sourceMappingURL=app.js.map */']) {
    const body = Buffer.from(`console.log(1);\n${directive}\n`);
    assert.equal(withFileSourceMap(body, file), body);
  }
});

test('empty identity maps and invalid line counts are explicit', () => {
  assert.equal(readMap(identityMapUrl(file, 0)).mappings, '');
  assert.throws(() => identityMapUrl(file, -1), RangeError);
  assert.throws(() => identityMapUrl(file, 1.5), RangeError);
});

test('large blank sources and unterminated map directives complete without quadratic scans', { timeout: 5000 }, () => {
  const blanks = '\n'.repeat(300_000);
  const blankBody = withFileSourceMap(Buffer.from(blanks), file).toString();
  const blankMap = readMap(blankBody.slice(blankBody.lastIndexOf('sourceMappingURL=') + 'sourceMappingURL='.length).trim());
  assert.equal(blankMap.mappings.length, 4 + 300_000 * 5);
  assert.equal(blankMap.sourcesContent[0], blanks);
  const malformed = '/*# sourceMappingURL=missing\n'.repeat(4000);
  const malformedBody = withFileSourceMap(Buffer.from(malformed), file).toString();
  assert.ok(malformedBody.startsWith(malformed));
  assert.ok(malformedBody.includes('//# sourceMappingURL=data:application/json'));
});

test('existing directives with JavaScript horizontal whitespace are preserved', () => {
  for (const space of ['\t', '\v', '\f', '\u00a0', '\ufeff']) {
    const body = Buffer.from(`x();\n${space}//#${space}sourceMappingURL=existing.map`);
    assert.equal(withFileSourceMap(body, file), body);
  }
});

test('existing source-map directives after minified code on the same line are preserved', () => {
  const body = Buffer.from('window.bundle=true; //# sourceMappingURL=bundle.js.map\n');
  assert.equal(withFileSourceMap(body, file), body);
});
