// @test-kind contract: Paqvilo Mirage CLI design: a catalogue site's Solution roots, presets and data packs apply to standalone runtimes and to data generate as they do to Power Pages commands (docs/cli.md, docs/configuration.md)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runMirageCommand } from '../cli-command.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const ENTITY =
  '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>';
const ROW = '77777777-7777-4777-8777-0000000000d1';

// A catalogue whose default (and only) site is a standalone Mirage site with its Solution roots and one data pack.
async function workspace(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-catalogue-site-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedSite</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/x_item/Entity.xml': ENTITY,
    'pack/pack.mjs': `export default { id: 'fx-site', name: 'Invented', description: 'Invented rows', matches: () => true, presets: () => ({}),
  dataset: () => ({ mappings: { x_item: { entitySet: 'x_items', idColumn: 'x_itemid' } }, tables: { x_item: [{ x_itemid: '${ROW}', x_name: 'From the site pack' }] } }) };`,
    'paqvilo.config.yml':
      'sourceRoot: .\ndefaultSite: lab\nsites:\n  lab:\n    mirage:\n      runtime: { kind: dataverse-api }\n      solutionRoots: [./solution]\n      dataPacks:\n        - { id: fx-site, module: ./pack/pack.mjs }\n',
  };
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
  return dir;
}

async function mirage(args, cwd) {
  let stdout = '',
    stderr = '';
  const code = await runMirageCommand(args, {
    cwd,
    stdout: { write: (text) => (stdout += text) },
    stderr: { write: (text) => (stderr += text) },
  });
  return { code, stdout, stderr };
}

test('a standalone inspect from a catalogue without --site uses the default site and its Solution roots', async (t) => {
  const dir = await workspace(t);
  for (const args of [
    ['--config', 'paqvilo.config.yml'],
    ['--config', 'paqvilo.config.yml', '--site', 'lab'],
  ]) {
    const result = await mirage(['inspect', ...args], dir);
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.runtime.kind, 'dataverse-api', args.join(' '));
    assert.deepEqual(report.solutions, [path.join(dir, 'solution')], args.join(' '));
    assert.ok(report.entities.includes('x_item'), args.join(' '));
  }
});

test('data generate finds the catalogue site data packs, as serve registers them', async (t) => {
  const dir = await workspace(t);
  for (const args of [
    ['--config', 'paqvilo.config.yml', '--site', 'lab'],
    ['--config', 'paqvilo.config.yml'],
  ]) {
    const state = path.join(dir, `state-${args.length}.json`);
    const result = await mirage(['data', 'generate', ...args, '--pack', 'fx-site', '--state', state], dir);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).rows.x_item.added, 1, args.join(' '));
  }
});
