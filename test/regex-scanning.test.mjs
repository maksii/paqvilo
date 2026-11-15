// @test-kind security: unbounded text scanners preserve captures and redaction while avoiding repeated suffix searches.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  emailMatches,
  replaceEmails,
  replaceDelimitedAlternatives,
  moduleImportMatches,
  nestedElementText,
  matchNamedLine,
  trimLineEndSpaces,
  normalizeSemicolonWhitespace,
  replaceParenthesizedPath,
  stripTrailingCharacter,
  stripTrailingCharacters,
} from '../mirage/lib/text-scanning.mjs';
import { fetchXmlTagMatches, hasSelfClosingTag } from '../examples/company-operations/portal-harness/compile.mjs';
import { parseEntityPage } from '../scripts/dataverse-standard-tables.mjs';

test('email matches retain lexical boundaries, ordering and redaction', () => {
  const text = 'first+tag@a-b.example.test then x@y.z.. next@domain no-at';
  assert.deepEqual(
    [...emailMatches(text)].map((match) => [match.index, match[0]]),
    [
      [0, 'first+tag@a-b.example.test'],
      [32, 'x@y.z'],
    ],
  );
  assert.equal(replaceEmails(text, '{email}'), '{email} then {email}.. next@domain no-at');
  const hostile = 'x'.repeat(300000);
  assert.deepEqual([...emailMatches(hostile)], []);
  assert.equal(replaceEmails(hostile, '{email}'), hostile);
});

test('delimiter alternatives preserve mixed nesting, malformed openers and nonempty entities', () => {
  assert.equal(
    replaceDelimitedAlternatives(
      'a{{ {%%} }}b{% x %}c',
      [
        ['{{', '}}'],
        ['{%', '%}'],
      ],
      '*',
    ),
    'a*b*c',
  );
  assert.equal(
    replaceDelimitedAlternatives(
      'a{% broken {{ ok }}z',
      [
        ['{{', '}}'],
        ['{%', '%}'],
      ],
      '*',
    ),
    'a{% broken *z',
  );
  assert.equal(replaceDelimitedAlternatives('&;&&;x&value;', [['&', ';', 1]], ' '), '&; x ');
  const hostile = '{{'.repeat(150000);
  assert.equal(
    replaceDelimitedAlternatives(
      hostile,
      [
        ['{{', '}}'],
        ['{%', '%}'],
      ],
      '*',
    ),
    hostile,
  );
});

test('static resource imports retain original lexical capture semantics', () => {
  const input = `import 'side.js'; export {x} from "named.js"; import from 'invalid.js'; import  from 'odd.js';`;
  assert.deepEqual(
    [...moduleImportMatches(input)].map((match) => match[1]),
    ['side.js', 'named.js', 'odd.js'],
  );
  assert.deepEqual(
    [...moduleImportMatches('import a from\n"  "')].map((match) => match[1]),
    ['  '],
  );
  assert.deepEqual(
    [...moduleImportMatches('import  x.js\nfrom\n"FROM"')].map((match) => match[1]),
    ['FROM'],
  );
  assert.deepEqual([...moduleImportMatches('import x\ny from "not-a-match"')], []);
  assert.deepEqual(
    [...moduleImportMatches('import\n\r\u2028"side.js\'')].map((match) => match[1]),
    ['side.js'],
  );
  assert.deepEqual(
    [...moduleImportMatches('import \nfrom\n\'x"')].map((match) => match[1]),
    ['x'],
  );
  assert.deepEqual([...moduleImportMatches('import from "one-space-invalid"')], []);
  assert.deepEqual(
    [...moduleImportMatches('export x\r\u2028y from "allowed.js"')].map((match) => match[1]),
    ['allowed.js'],
  );
  assert.deepEqual([...moduleImportMatches('import a '.repeat(30000))], []);
});

test('FetchXML lexical tags retain group slots and skip consumed nested openers', () => {
  const xml = '<entity name="a"><attribute name="b"></attribute></entity>';
  assert.deepEqual(
    [...fetchXmlTagMatches(xml)].map((match) => match.slice(1)),
    [
      ['entity', 'name="a"', undefined, undefined],
      [undefined, undefined, undefined, 'name="b"'],
      [undefined, undefined, 'entity', undefined],
    ],
  );
  assert.deepEqual(
    [...fetchXmlTagMatches('<attribute  >', true)].map((match) => match[1]),
    [' '],
  );
  assert.deepEqual(
    [...fetchXmlTagMatches('<entity <attribute x>')].map((match) => match[2]),
    ['<attribute x'],
  );
  assert.deepEqual([...fetchXmlTagMatches('<entity '.repeat(30000))], []);
  assert.equal(hasSelfClosingTag('<one>text<two />'), true);
  assert.equal(hasSelfClosingTag('<one>text/>'), false);
});

test('whitespace and path normalization retain line terminators and exact suffix rules', () => {
  assert.equal(trimLineEndSpaces('a \t\r\nb \u2028c\t'), 'a\r\nb\u2028c');
  assert.equal(normalizeSemicolonWhitespace('  a \t;\r\n b ;  '), '  a;b;');
  assert.equal(replaceParenthesizedPath('at f (D:\\work/a.js:1)'), 'at f (a.js:1)');
  assert.equal(replaceParenthesizedPath('at f (one\ntwo/a.js)'), 'at f (one\ntwo/a.js)');
  assert.equal(stripTrailingCharacters('name.  ', '. '), 'name');
  assert.equal(stripTrailingCharacter('1000', '0'), '1');
  assert.equal(stripTrailingCharacter('/path///', '/'), '/path');
});

test('named lines and duplicated language elements retain whitespace captures', () => {
  assert.deepEqual(matchNamedLine('Client name \t:  value')?.slice(1), ['Client name ', 'value']);
  assert.equal(matchNamedLine('name\tbad: value'), null);
  assert.equal(nestedElementText('<id> <id> value \t</id>', 'id'), 'value');
  assert.equal(nestedElementText('<id> \t</id>', 'id'), undefined);
  assert.equal(nestedElementText('<id>bad<other><id>ok</id>', 'id'), 'ok');
});

test('Learn headings and malformed option rows retain their original line-separator boundaries', () => {
  const plain = readFileSync(new URL('../mirage/test/fixtures/standard-entity-page.md', import.meta.url), 'utf8');
  const heading = plain.replace('## Writable columns/attributes', '## Writable columns/attributes\u2028');
  assert.notEqual(heading, plain);
  const headingResult = parseEntityPage(heading, 'fx_widget');
  assert.deepEqual(headingResult.problems, []);
  assert.deepEqual(headingResult, parseEntityPage(plain, 'fx_widget'));

  const malformed = plain.replace('InvariantName: `Active`', 'InvariantName: `Active`\u2028');
  assert.notEqual(malformed, plain);
  // Exact base e66e7154 public parseEntityPage output rejects this row before parsing its detail values.
  const expected = structuredClone(parseEntityPage(plain, 'fx_widget'));
  expected.attributes.statecode.optionSet.states = [
    { value: 1, labels: { 1033: 'Inactive' }, defaultStatus: 2, invariantName: 'Inactive' },
  ];
  const malformedResult = parseEntityPage(malformed, 'fx_widget');
  assert.deepEqual(malformedResult.problems, []);
  assert.deepEqual(malformedResult, expected);
});
