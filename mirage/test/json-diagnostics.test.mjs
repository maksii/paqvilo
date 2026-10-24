import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { jsonErrorLocation } from '../lib/json-diagnostics.mjs';
import { loadDeploymentProfiles, resolveDeploymentProfiles } from '../lib/deployment-profiles.mjs';
import { inspectExportProfiles } from '../../lense/commands/doctor.mjs';

const malformed = [
  { name: 'missing-value', source: '{\n "name":\n}', line: 3, column: 1 },
  { name: 'missing-value-crlf', source: '{\r\n "name":\r\n}', line: 3, column: 1 },
  { name: 'missing-value-cr', source: '{\r "name":\r}', line: 3, column: 1 },
  { name: 'string-escape', source: '{"name":"\\q"}', line: 1, column: 11 },
  { name: 'unicode-escape', source: '{"name":"\\u12X4"}', line: 1, column: 14 },
  { name: 'unterminated-string', source: '{"name":"unterminated', line: 1, column: 22 },
  { name: 'array-trailing-comma', source: '{"name":\n [1,2,]\n}', line: 2, column: 7 },
  { name: 'object-trailing-comma', source: '{"name":\n {"x":1,}\n}', line: 2, column: 9 },
  { name: 'invalid-exponent', source: '{"name":\n 1e+\n}', line: 2, column: 5 },
  { name: 'leading-zero', source: '{"name":01}', line: 1, column: 10 },
  { name: 'trailing-token', source: '{"name":true}\nfalse', line: 2, column: 1 },
  { name: 'string-control', source: '{\n "name":"line\nbreak"\n}', line: 2, column: 14 },
  { name: 'private-value', source: '{"private":"PRIVATE_SENTINEL",\n "name":\n}', line: 3, column: 1 },
  { name: 'eof-after-whitespace', source: '{\n "name": \n ', line: 3, column: 2 },
  { name: 'interrupted-literal', source: '{\n "name": tru\n}', line: 2, column: 13 },
  { name: 'missing-colon', source: '{\n "name" true\n}', line: 2, column: 9 },
  { name: 'unquoted-key', source: '{\n name: true\n}', line: 2, column: 2 },
];

test('malformed JSON syntax locations do not depend on Node error-message wording', () => {
  for (const { name, source, line, column } of malformed) {
    assert.throws(() => JSON.parse(source), SyntaxError, name);
    assert.deepEqual(jsonErrorLocation(source), { line, column }, name);
  }
  const depth = 20000,
    deeplyNested = '['.repeat(depth) + 'x' + ']'.repeat(depth);
  assert.throws(() => JSON.parse(deeplyNested), SyntaxError);
  assert.deepEqual(
    jsonErrorLocation(deeplyNested),
    { line: 1, column: depth + 1 },
    'deep nesting is inspected without recursive calls',
  );
});

test('export-wide lint and selected profile loading agree on JSON syntax locations without echoing values', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'profile-json-locations-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profiles = path.join(root, 'deployment-profiles');
  await fs.mkdir(profiles);
  for (const row of malformed) await fs.writeFile(path.join(profiles, row.name + '.json'), row.source);
  const diagnostics = inspectExportProfiles(root);
  assert.equal(diagnostics.length, malformed.length);
  for (const { name, line, column } of malformed) {
    const diagnostic = diagnostics.find((row) => row.file === 'deployment-profiles/' + name + '.json');
    assert.equal(JSON.stringify(diagnostic).includes('PRIVATE_SENTINEL'), false);
    assert.deepEqual(
      { code: diagnostic.code, line: diagnostic.line, column: diagnostic.column },
      { code: 'JSON_SYNTAX_ERROR', line, column },
      name,
    );
    const config = resolveDeploymentProfiles(
      { default: 'dev', profiles: { dev: { pages: 'deployment-profiles/' + name + '.json' } } },
      root,
    );
    await assert.rejects(loadDeploymentProfiles(config), (error) => {
      assert.deepEqual(
        { code: error.details.parserCode, line: error.details.line, column: error.details.column },
        { code: 'JSON_SYNTAX_ERROR', line, column },
        name,
      );
      assert.equal(
        JSON.stringify({ message: error.message, details: error.details }).includes('PRIVATE_SENTINEL'),
        false,
      );
      assert.equal(
        error.message.includes('unterminated'),
        name === 'unterminated-string',
        'only the filename can identify this fixture',
      );
      return true;
    });
  }
  await fs.writeFile(path.join(profiles, 'valid.json'), '{"adx_contentsnippet":[]}\r\n\t ');
  const valid = resolveDeploymentProfiles(
    { default: 'dev', profiles: { dev: { pages: 'deployment-profiles/valid.json' } } },
    root,
  );
  assert.equal((await loadDeploymentProfiles(valid)).profile, 'dev');
});
