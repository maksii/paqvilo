import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';

const FORM = '77777777-7777-4777-8777-777777777777';
const manifest = name => `<ImportExportXml><SolutionManifest><UniqueName>${name}</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>`;
const entity = (extra = '') => `<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute></attributes></entity></EntityInfo>${extra}</Entity>`;
const systemForm = label => `<systemform><formid>{${FORM}}</formid><type>2</type><LocalizedNames><LocalizedName description="${label}" languagecode="1033"/></LocalizedNames><form><tabs><tab name="${label}"/></tabs></form></systemform>`;

async function layers(t, { fileIn, embeddedIn }) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'solution-form-precedence-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (relative, text) => {
    await fs.mkdir(path.dirname(path.join(root, relative)), { recursive: true });
    await fs.writeFile(path.join(root, relative), text);
  };
  await write('A/Other/Solution.xml', manifest('InventedA'));
  await write('B/Other/Solution.xml', manifest('InventedB'));
  await write(`${fileIn}/Entities/x_item/FormXml/main/{${FORM}}.xml`, `<forms type="main">${systemForm(`FROM_${fileIn}_FILE`)}</forms>`);
  await write(`${fileIn}/Entities/x_item/Entity.xml`, entity());
  await write(`${embeddedIn}/Entities/x_item/Entity.xml`, entity(`<FormXml><forms type="main">${systemForm(`FROM_${embeddedIn}_EMBEDDED`)}</forms></FormXml>`));
  return { root: await fs.realpath(root), metadata: await importSolutionMetadata([path.join(root, 'A'), path.join(root, 'B')], { order: 'explicit' }) };
}

const variants = metadata => metadata.diagnostics.filter(entry => entry.code === 'SOLUTION_LAYER_VARIANTS');

test('a later layer embedding a form wins over an earlier FormXml file, with one diagnostic', async t => {
  const { root, metadata } = await layers(t, { fileIn: 'A', embeddedIn: 'B' });
  const forms = metadata.forms.filter(form => form.entity === 'x_item');
  assert.equal(forms.length, 1);
  assert.equal(forms[0].name, 'FROM_B_EMBEDDED');
  assert.equal(path.relative(root, forms[0].file).split(path.sep)[0], 'B');
  const diagnostics = variants(metadata);
  assert.equal(diagnostics.length, 1);
  assert.equal(path.relative(root, diagnostics[0].selected).split(path.sep)[0], 'B');
  assert.equal(path.relative(root, diagnostics[0].previous).split(path.sep)[0], 'A');
});

test('a later FormXml file wins over an earlier embedded form, with one diagnostic', async t => {
  const { root, metadata } = await layers(t, { fileIn: 'B', embeddedIn: 'A' });
  const forms = metadata.forms.filter(form => form.entity === 'x_item');
  assert.equal(forms.length, 1);
  assert.equal(forms[0].name, 'FROM_B_FILE');
  const diagnostics = variants(metadata);
  assert.equal(diagnostics.length, 1);
  assert.equal(path.relative(root, diagnostics[0].selected).split(path.sep)[0], 'B');
});
