// @test-kind contract: the workbook writer produces the .xlsx package parts Excel reads, with escaped text and typed cells.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decimalCell, xlsxWorkbook } from '../lib/xlsx-writer.mjs';
import { readSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';

const PARTS = [
  '[Content_Types].xml',
  '_rels/.rels',
  'xl/workbook.xml',
  'xl/_rels/workbook.xml.rels',
  'xl/worksheets/sheet1.xml',
];

// Reads the package back: readSolutionAssetEntries verifies every entry's CRC-32 and local header.
function unpack(bytes) {
  return new Map(readSolutionAssetEntries(bytes).map((entry) => [entry.name, entry.data.toString('utf8')]));
}

// A tag balance check over the markup: every start tag has its end tag, in order.
function balanced(xml) {
  const stack = [];
  for (const [, closing, name, selfClosing] of xml.matchAll(/<(\/?)([A-Za-z][\w:.-]*)[^<>]*?(\/?)>/g)) {
    if (closing) {
      if (stack.pop() !== name) return false;
    } else if (!selfClosing) stack.push(name);
  }
  return stack.length === 0;
}

test('a workbook is a stored ZIP of the five package parts, each with a verified CRC-32', () => {
  const bytes = xlsxWorkbook([['Name'], ['Alpha']], { sheetName: 'Children' });
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  assert.equal(bytes.readUInt16LE(8), 0, 'the first entry is stored, not deflated');
  const parts = unpack(bytes);
  assert.deepEqual([...parts.keys()].sort(), [...PARTS].sort());
  for (const part of PARTS) assert.ok(parts.get(part).length > 0, part);
  assert.match(parts.get('xl/workbook.xml'), /<sheet name="Children" sheetId="1" r:id="rId1"\/>/);
});

test('sheet cells hold escaped text, numbers as numeric cells and formula-looking text as text', () => {
  const rows = [
    ['Name', 'Count'],
    ['Alpha & <Beta> "x"', 42],
    ['=SUM(1,2)', -3.5],
    ['+1', ''],
  ];
  const sheet = unpack(xlsxWorkbook(rows)).get('xl/worksheets/sheet1.xml');
  assert.ok(balanced(sheet), 'the sheet XML is well formed');
  assert.ok(sheet.includes('<c r="A1" t="inlineStr"><is><t xml:space="preserve">Name</t></is></c>'));
  assert.ok(
    sheet.includes(
      '<c r="A2" t="inlineStr"><is><t xml:space="preserve">Alpha &amp; &lt;Beta&gt; &quot;x&quot;</t></is></c>',
    ),
  );
  assert.ok(sheet.includes('<c r="B2"><v>42</v></c>'));
  assert.ok(sheet.includes('<c r="B3"><v>-3.5</v></c>'));
  assert.ok(sheet.includes('<c r="A3" t="inlineStr"><is><t xml:space="preserve">=SUM(1,2)</t></is></c>'));
  assert.ok(sheet.includes('<c r="A4" t="inlineStr"><is><t xml:space="preserve">+1</t></is></c>'));
  assert.ok(!sheet.includes('<f>'), 'no cell is a formula');
});

test('cell text is cut to 32,767 characters after illegal characters are removed, never inside a surrogate pair', () => {
  const cellTextOf = (rows) =>
    /<t xml:space="preserve">([^<]*)<\/t>/.exec(unpack(xlsxWorkbook(rows)).get('xl/worksheets/sheet1.xml'))[1];
  assert.equal(cellTextOf([['a'.repeat(40000)]]).length, 32767);
  assert.equal(cellTextOf([['\u0001'.repeat(3) + 'a'.repeat(40000)]]), 'a'.repeat(32767));
  assert.equal(cellTextOf([[`${'a'.repeat(32766)}\u{1F600}b`]]), 'a'.repeat(32766));
});

test('illegal XML characters are removed and the sheet name keeps 31 characters without forbidden symbols', () => {
  const parts = unpack(xlsxWorkbook([['a\u0001b￾c']], { sheetName: `${'x'.repeat(40)}[:*?/\\]` }));
  assert.ok(parts.get('xl/worksheets/sheet1.xml').includes('<t xml:space="preserve">abc</t>'));
  const name = /<sheet name="([^"]*)"/.exec(parts.get('xl/workbook.xml'))[1];
  assert.equal(name, 'x'.repeat(31));
  assert.equal(
    /<sheet name="([^"]*)"/.exec(unpack(xlsxWorkbook([[]], { sheetName: '[]:' })).get('xl/workbook.xml'))[1],
    'Sheet1',
  );
});

test('a decimal cell is a numeric cell written from its digits; text that is not a decimal has none', () => {
  assert.equal(decimalCell('=1+1'), null);
  assert.equal(decimalCell('1,5'), null);
  const sheet = unpack(
    xlsxWorkbook([[decimalCell('12345678901234567.891'), decimalCell('+5'), decimalCell('-1.5E+3'), decimalCell('0')]]),
  ).get('xl/worksheets/sheet1.xml');
  assert.ok(sheet.includes('<c r="A1"><v>12345678901234567.891</v></c>'));
  assert.ok(sheet.includes('<c r="B1"><v>5</v></c>'));
  assert.ok(sheet.includes('<c r="C1"><v>-1.5E+3</v></c>'));
  assert.ok(sheet.includes('<c r="D1"><v>0</v></c>'));
});
