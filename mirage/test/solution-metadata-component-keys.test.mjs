// @test-kind contract: Solution metadata keys component schemas by record identity and lists the tables the selected sources define; invented schemas only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function solution(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'solution-component-keys-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = {
    'Entities/fx_item/Entity.xml':
      '<Entity><Name>fx_item</Name><EntityInfo><entity Name="fx_item"><EntitySetName>fx_items</EntitySetName><attributes><attribute PhysicalName="fx_name"><Type>nvarchar</Type><Name>fx_name</Name><LogicalName>fx_name</LogicalName></attribute></attributes></entity></EntityInfo></Entity>',
    'Entities/fx_item/SavedQueries/item-view.xml':
      '<savedquery><savedqueryid>item-view</savedqueryid><fetchxml><fetch><entity name="fx_item"><attribute name="fx_name"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="fx_name" width="100"/></row></grid></layoutxml><LocalizedNames><LocalizedName description="Items" languagecode="1033"/></LocalizedNames></savedquery>',
    'Entities/fx_extra/Entity.xml':
      '<Entity><Name>fx_extra</Name><EntityInfo><entity Name="fx_extra"><EntitySetName>fx_extras</EntitySetName><attributes/></entity></EntityInfo></Entity>',
  };
  for (const [name, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), body);
  }
  return fs.realpath(root);
}

const portal = () => ({
  forms: [{ id: 'same-form', name: 'Same', entityName: 'fx_item', formName: 'Absent', metadata: {} }],
  lists: [{ id: 'same-list', name: 'Same', entityName: 'fx_item', metadata: { adx_view: 'item-view' } }],
  advancedForms: [],
  records: [],
  pages: [],
  settings: {},
});

test('C6: component schemas are keyed by record ID, so a form never reads a same-named list view', async (t) => {
  const metadata = await importSolutionMetadata(await solution(t), { portal: portal() });
  assert.equal(metadata.componentSchemas['same-list'].viewId, 'item-view');
  assert.equal(metadata.componentSchemas['same-form'], undefined);
  assert.equal(Object.hasOwn(metadata.componentSchemas, 'Same'), false, 'no name key');
  assert.ok(metadata.diagnostics.some((row) => row.code === 'SYSTEMFORM_UNRESOLVED' && row.id === 'same-form'));
});

test('C21: the table catalogue tells a table the sources define but were not asked for from one they lack', async (t) => {
  const metadata = await importSolutionMetadata(await solution(t), { portal: portal() });
  assert.equal(metadata.entities.fx_extra, undefined, 'only the portal tables are loaded');
  assert.deepEqual(metadata.tableCatalog.fx_extra, { entitySet: 'fx_extras', entitySetSource: 'solution' });
  assert.equal(metadata.tableCatalog.fx_absent, undefined);
  assert.deepEqual(metadata.requestedTables, ['fx_item']);
  const loaded = await importSolutionMetadata(await solution(t), {
    portal: portal(),
    entities: ['fx_item', 'fx_extra'],
  });
  assert.ok(loaded.entities.fx_extra);
});
