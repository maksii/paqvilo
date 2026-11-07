import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSolutionXml } from '../mirage/lib/solution-xml.mjs';

const sources = [
  ['pqvd_baselineitem', 'bf599af2-f636-414f-8a8d-05a4306b92ac'],
  ['pqvd_baselineitem', '5dd6a7d1-f659-467c-8cdc-68988b1d311d'],
  ['pqvd_baselineparent', '0b56975b-fd29-4034-808e-1c8b5ff65d8e'],
].map(([table, id]) => ({
  id,
  xml: parseSolutionXml(
    fs.readFileSync(
      new URL(`../examples/project/baseline/solution/Entities/${table}/FormXml/main/{${id}}.xml`, import.meta.url),
      'utf8',
    ),
  ),
}));
const descendants = (node, name) => [
  ...(node.name === name ? [node] : []),
  ...node.children.flatMap((child) => descendants(child, name)),
];

test('committed baseline Solution forms allocate every spanning cell inside existing section rows and columns', () => {
  for (const { id, xml } of sources) {
    assert.equal(descendants(xml, 'formid')[0].text.replace(/[{}]/g, '').trim(), id);
    for (const section of descendants(xml, 'section')) {
      const rows = section.children.find((node) => node.name === 'rows').children;
      const columns = section.attrs.columns.length;
      const slots = rows.map(() => Array(columns).fill(null));
      for (const [rowIndex, row] of rows.entries()) {
        let column = 0;
        for (const cell of row.children.filter((node) => node.name === 'cell')) {
          while (slots[rowIndex][column] !== undefined && slots[rowIndex][column] !== null) column++;
          const width = Number(cell.attrs.colspan ?? 1);
          const height = Number(cell.attrs.rowspan ?? 1);
          const context = `${id}/${section.attrs.name}/row ${rowIndex}/${cell.attrs.id}`;
          assert.ok(Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0, context);
          assert.ok(column + width <= columns, `${context}: would create an implicit extra column`);
          assert.ok(rowIndex + height <= rows.length, `${context}: missing rows for its complete height`);
          for (let nextRow = rowIndex; nextRow < rowIndex + height; nextRow++)
            for (let nextColumn = column; nextColumn < column + width; nextColumn++) {
              assert.equal(slots[nextRow][nextColumn], null, `${context}: overlaps another spanning cell`);
              slots[nextRow][nextColumn] = cell.attrs.id;
            }
          column += width;
        }
      }
    }
  }
});

test('the committed item quick view starts after its related subgrid frees the declared column', () => {
  const section = descendants(sources[0].xml, 'section').find((node) => node.attrs.name === 'related');
  const rows = section.children.find((node) => node.name === 'rows').children;
  const placement = (id) => rows.findIndex((row) => descendants(row, 'control').some((node) => node.attrs.id === id));
  const gridRow = placement('subgrid_children');
  const gridCell = rows[gridRow].children.find((node) => node.name === 'cell');
  assert.equal(gridRow, 0);
  assert.equal(placement('quickview_parent'), gridRow + Number(gridCell.attrs.rowspan));
  assert.equal(placement('notescontrol'), 7);
});
