// Canonical Dataverse Git YAML through the one YAML adapter (solution-yaml.mjs) into the schema, metadata and source graph.
// Fixture: mirage/test/fixtures/yaml-solution.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOrganizationSources } from '../lib/solution-runtime-source.mjs';
import { buildSourceGraph } from '../lib/source-graph.mjs';
import { preflight, preflightExitCode } from '../lib/capability-report.mjs';
import { yamlNode, classifyYamlPath } from '../lib/solution-yaml.mjs';

const FIXTURE = fileURLToPath(new URL('./fixtures/yaml-solution/', import.meta.url));

async function copy(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'solution-yaml-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.cp(FIXTURE, root, { recursive: true });
  for (const [relative, text] of Object.entries(extra)) {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), text);
  }
  return root;
}

test('the XML↔YAML element rule: @ keys are attributes, lists repeat elements, null is an empty element', () => {
  const node = yamlNode(
    "Publisher:\n  UniqueName: fx\n  LocalizedNames:\n    LocalizedName:\n      '@description': Fx\n      '@languagecode': '1033'\n  Descriptions:\n",
    'Publisher',
  );
  assert.equal(node.name, 'Publisher');
  assert.equal(node.children.find((item) => item.name === 'UniqueName').text, 'fx');
  assert.deepEqual(node.children.find((item) => item.name === 'LocalizedNames').children[0].attrs, {
    description: 'Fx',
    languagecode: '1033',
  });
  assert.equal(node.children.find((item) => item.name === 'Descriptions').children.length, 0);
  assert.deepEqual(classifyYamlPath('entities/x_item/formxml/main/f.yml'), {
    kind: 'yaml',
    part: 'form',
    entityDir: 'x_item',
    formType: 'main',
  });
  assert.equal(classifyYamlPath('entities/x_item/entity.xml'), null);
});

test('a YAML repository imports tables, attributes, forms, views, option sets and relationships with one layer per solution', async () => {
  const sources = await loadOrganizationSources({ solutionRoots: [FIXTURE] });
  assert.deepEqual(
    sources.scan.layers.map((layer) => [layer.name, layer.format]),
    [
      ['FxCore', 'yaml'],
      ['FxExtension', 'yaml'],
    ],
  );
  assert.ok(
    !sources.scan.diagnostics.some((item) => item.severity === 'error'),
    JSON.stringify(sources.scan.diagnostics),
  );
  const { tables, relationships, optionSets } = sources.schema;
  assert.deepEqual(Object.keys(tables.x_item.attributes).sort(), ['x_itemid', 'x_name', 'x_status']);
  assert.equal(tables.x_item.entitySet, 'x_items');
  assert.equal(tables.x_item.primaryNameAttribute, 'x_name');
  assert.equal(tables.x_item.attributes.x_name.maxLength, 100);
  // Membership: x_item belongs to FxCore, x_part to FxExtension (solutioncomponents.yml).
  assert.deepEqual(
    tables.x_item.layers.map((layer) => layer.solution),
    ['FxCore'],
  );
  assert.deepEqual(
    tables.x_part.layers.map((layer) => layer.solution),
    ['FxExtension'],
  );
  assert.deepEqual(
    optionSets.x_status.options.map((option) => option.value),
    [100000000, 100000001],
  );
  assert.equal(relationships.x_part_item.referencedEntity, 'x_item');
  assert.equal(relationships.x_part_item.referencingEntity, 'x_part');
  assert.deepEqual(
    sources.metadata.forms.map((form) => [form.id, form.entity, form.name]),
    [['77777777-7777-4777-8777-777777777782', 'x_item', 'Item main']],
  );
  assert.deepEqual(
    sources.metadata.views.map((view) => [view.id, view.name, view.isDefault]),
    [['77777777-7777-4777-8777-777777777783', 'Active Items', true]],
  );
});

test('rootcomponents.yml and missingdependencies.yml feed the same graph rows as Solution.xml', async () => {
  const sources = await loadOrganizationSources({ solutionRoots: [FIXTURE] });
  const rows = buildSourceGraph(sources).requirements();
  assert.deepEqual(
    rows.map((row) => [row.id, row.status, row.reason]),
    [
      ['dashboard:77777777-7777-4777-8777-777777777784', 'missing', 'SOLUTION_COMPONENT_SOURCE_MISSING'],
      ['role:77777777-7777-4777-8777-777777777781', 'missing', 'SOLUTION_MISSING_DEPENDENCY'],
    ],
  );
});

test('a YAML component file the adapter cannot read is an unsupported row and strict preflight exits 1', async (t) => {
  const root = await copy(t, {
    'entities/x_item/attributes/x_unnamed.yml': 'attribute:\n  Type: nvarchar\n',
    'entities/x_item/attributes/x_bad.yml': 'attribute: [unclosed\n',
  });
  const report = await preflight({ solutionRoots: [root], strict: true, packs: [], env: {} });
  const rows = report.requirements.filter((row) => row.kind === 'solution-source');
  assert.deepEqual(rows.map((row) => [row.status, row.reason]).sort(), [
    ['missing', 'SOLUTION_YAML_INVALID'],
    ['unsupported', 'SOLUTION_YAML_COMPONENT_NOT_IMPORTED'],
  ]);
  assert.ok(rows.every((row) => row.blocking));
  assert.equal(preflightExitCode(report), 1);
  assert.ok(!JSON.stringify(report).includes('[unclosed'), 'the parser excerpt of the file stays out of the report');
});

test('a YAML solution that loads nothing is SOLUTION_YAML_EMPTY and blocks strict preflight', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'solution-yaml-empty-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'solutions', 'FxEmpty'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'solutions', 'FxEmpty', 'solution.yml'),
    'SolutionManifest:\n  UniqueName: FxEmpty\n  Version: 1.0.0.0\n',
  );
  const report = await preflight({ solutionRoots: [root], strict: true, packs: [], env: {} });
  assert.ok(
    report.requirements.some((row) => row.reason === 'SOLUTION_YAML_EMPTY' && row.status === 'missing' && row.blocking),
  );
  assert.equal(preflightExitCode(report), 1);
});
