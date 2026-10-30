import test from 'node:test';
import assert from 'node:assert/strict';
import { FORMS } from '../examples/project/baseline/generate.mjs';
import { parseSolutionXml } from '../mirage/lib/solution-xml.mjs';

function descendants(node, name) {
  return [...(node.name === name ? [node] : []), ...node.children.flatMap((child) => descendants(child, name))];
}

test('generated baseline forms keep row-spanning controls inside declared section columns', () => {
  for (const form of FORMS) {
    const xml = parseSolutionXml(form.build());
    for (const section of descendants(xml, 'section')) {
      const columns = section.attrs.columns.length;
      const occupied = Array(columns).fill(0);
      const rows = section.children.find((node) => node.name === 'rows').children;
      for (const [index, row] of rows.entries()) {
        let cursor = 0;
        for (const cell of row.children.filter((node) => node.name === 'cell')) {
          while (occupied[cursor] > 0) cursor++;
          const width = Number(cell.attrs.colspan ?? 1);
          assert.ok(
            cursor + width <= columns,
            `${form.file}/${section.attrs.name}/row ${index}: cell overlaps a spanning predecessor`,
          );
          for (let column = cursor; column < cursor + width; column++) {
            assert.equal(occupied[column], 0, `${form.file}/${section.attrs.name}: overlapping spans`);
            occupied[column] = Number(cell.attrs.rowspan ?? 1);
          }
          cursor += width;
        }
        for (let column = 0; column < columns; column++) occupied[column] = Math.max(0, occupied[column] - 1);
      }
      assert.ok(
        occupied.every((remaining) => remaining === 0),
        `${form.file}/${section.attrs.name}: trailing span rows are missing`,
      );
    }
  }
});

test('the baseline quick view follows the complete subgrid span and retains both controls', () => {
  const xml = parseSolutionXml(FORMS.find((form) => form.file === 'item-main').build());
  const related = descendants(xml, 'section').find((section) => section.attrs.name === 'related');
  const rows = related.children.find((node) => node.name === 'rows').children;
  const at = (id) => rows.findIndex((row) => descendants(row, 'control').some((node) => node.attrs.id === id));
  assert.equal(at('subgrid_children'), 0);
  assert.equal(at('quickview_parent'), 6);
  assert.equal(at('notescontrol'), 7);
  assert.equal(rows[0].children[0].attrs.rowspan, '6');
});
