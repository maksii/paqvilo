import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { parseKeySegment } from '../lib/data.mjs';
import { tokenize } from '../lib/liquid-engine.mjs';

test('alternate keys preserve quoting, separators and typed values while rejecting incomplete or ambiguous keys', () => {
  assert.deepEqual(parseKeySegment(" code = 'a,b''c' , number = -12.5, flag=true "), {
    code: "a,b'c",
    number: -12.5,
    flag: 'true',
  });
  assert.deepEqual(parseKeySegment("empty='',id={abc}"), { empty: '', id: 'abc' });
  assert.equal(parseKeySegment('plain-id'), null);
  for (const source of ["a='unterminated", "a='closed'junk", 'a=', 'a=1,a=2', '__proto__=1', 'constructor=2'])
    assert.throws(
      () => parseKeySegment(source),
      (e) => e.code === 'InvalidKey',
    );
});

test('whole-template Liquid shorthands retain whitespace, empty-body and final-newline behavior', () => {
  for (const source of ['{{{ hello }}}', '{{{\thello\t\t}}}\r\n', '{{{\nhello\n}}}', '{{{hello}}}\u2028'])
    assert.deepEqual(tokenize(source), ['{% literal %}', 'hello', '{% endliteral %}']);
  for (const source of ['{# hello #}', '{ #\thello\t# }\n', '{#\nhello\n#}'])
    assert.deepEqual(tokenize(source), ['{% comment %}', 'hello', '{% endcomment %}']);
  assert.deepEqual(tokenize('{{{}}}'), ['{% literal %}', '{% endliteral %}']);
  assert.deepEqual(tokenize('{##}'), ['{% comment %}', '{% endcomment %}']);
  assert.deepEqual(tokenize('{# hello\nworld #}'), ['{# hello\nworld #}']);
  assert.deepEqual(tokenize('{# hello #} suffix'), ['{# hello #} suffix']);
});

test('long malformed keys and shorthand templates finish within a bounded isolated process', () => {
  const script = `import {parseKeySegment} from ${JSON.stringify(new URL('../lib/data.mjs', import.meta.url).href)};import {tokenize} from ${JSON.stringify(new URL('../lib/liquid-engine.mjs', import.meta.url).href)};const tabs='\t'.repeat(200000);for(const source of ['a'+tabs+'=', 'a='+tabs+"'unclosed"]){try{parseKeySegment(source);}catch{}}for(const source of ['{{{'+tabs,'{#'+tabs]){try{tokenize(source);}catch{}}`;
  // A separate process, so a regression into super-linear backtracking is killed instead of blocking the runner. The
  // linear parse plus Node startup takes well under a second; quadratic scanning of 200,000 tabs takes minutes.
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 8000,
    windowsHide: true,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
});
