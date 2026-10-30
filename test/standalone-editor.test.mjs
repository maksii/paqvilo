import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { standaloneMirageConfiguration, standaloneCatalogueConfiguration } from '../lense/standalone-mirage.mjs';
import { loadCatalogue } from '../lense/config.mjs';

test('standalone and model-driven configuration respect project catalogue, personal and environment editor precedence', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-editor-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const project = { configFile: path.join(directory, 'project.json') };
  const file = path.join(directory, 'paqvilo.config.yml');
  // Shell settings such as PAQVILO_EDITOR or PAQVILO_SITE would otherwise override the files under test.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('PAQVILO_')));
  for (const key of Object.keys(inherited)) delete process.env[key];
  t.after(() => {
    delete process.env.PAQVILO_EDITOR;
    Object.assign(process.env, inherited);
  });
  assert.equal(standaloneMirageConfiguration(project).editor, 'code');
  await fs.writeFile(
    file,
    'editor: "code --new-window"\nsites:\n  invented:\n    mirage:\n      runtime: {kind: model-driven}\n',
  );
  assert.equal(standaloneMirageConfiguration(project).editor, 'code --new-window');
  await fs.writeFile(path.join(directory, 'paqvilo.config.local.yml'), 'editor: "code --reuse-window"\n');
  assert.equal(standaloneMirageConfiguration(project).editor, 'code --reuse-window');
  await fs.writeFile(path.join(directory, '.env'), 'PAQVILO_EDITOR="code --profile Invented"\n');
  assert.equal(standaloneMirageConfiguration(project).editor, 'code --profile Invented');
  process.env.PAQVILO_EDITOR = 'code --profile Explicit';
  assert.equal(standaloneMirageConfiguration(project).editor, process.env.PAQVILO_EDITOR);
  const catalogue = loadCatalogue({ config: file });
  assert.equal(
    standaloneCatalogueConfiguration(catalogue, 'invented', { config: file }).editor,
    process.env.PAQVILO_EDITOR,
  );
  const outside = { configFile: path.join(directory, 'outside', 'project.json') };
  assert.equal(standaloneMirageConfiguration(outside, { config: file }).editor, process.env.PAQVILO_EDITOR);
});
