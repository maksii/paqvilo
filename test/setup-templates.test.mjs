import { makeTemporaryDirectory } from '../mirage/testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import YAML from 'yaml';
import { SetupStore } from '../lense/setup/store.mjs';
import { renderTemplate, setupTemplates } from '../lense/setup/templates.mjs';

async function work(t) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-setup-templates-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return directory;
}

for (const kind of ['catalogue', 'project']) {
  test(`${kind} templates validate and report exactly their expected next-step findings`, async (t) => {
    const templates = setupTemplates(kind);
    assert.deepEqual(
      templates.map((item) => item.id),
      ['power-pages', 'model-driven', 'dataverse-api', 'full-stack'],
    );
    for (const template of templates) {
      const directory = await work(t);
      const file = path.join(directory, kind === 'project' ? 'mirage.project.yml' : 'paqvilo.config.yml');
      await fs.writeFile(file, YAML.stringify(template.document));
      const snapshot = await new SetupStore({
        directory,
        ...(kind === 'project' ? { project: file } : {}),
        processEnv: {},
      }).snapshot();
      assert.deepEqual(
        [...new Set(snapshot.findings.map((item) => item.code))].sort(),
        [...template.expectedFindings].sort(),
        `${template.id}: ${JSON.stringify(snapshot.findings)}`,
      );
      assert.ok(template.title && template.description && template.surfaces.length && template.nextSteps.length);
      // Every URL is an example.test placeholder or loopback.
      for (const url of JSON.stringify(template.document).match(/https?:\/\/[^"\s]+/g) ?? [])
        assert.match(new URL(url).hostname, /(?:^|\.)example\.test$|^127\.0\.0\.1$/);
    }
  });
}

test('full-stack template declares providers, references and profiles without secret values', () => {
  const site = setupTemplates('catalogue').find((item) => item.id === 'full-stack').document.sites['invented-portal']
    .mirage;
  assert.deepEqual(Object.keys(site.providers.routes), ['dataverseFiles', 'annotations']);
  assert.equal(site.providers.storage['invented-disk'].kind, 'local-disk');
  assert.equal(Object.keys(site.providers.messaging.endpoints).length, 1);
  assert.equal(site.providers.outbox.kind, 'local');
  assert.equal(site.connections['invented-fixture'].provider, 'fixture');
  assert.ok(
    Object.values(site.secrets).every((entry) => entry.variable && !('value' in entry) && !('protectedValue' in entry)),
  );
  assert.equal(new URL(site.localServices['invented-api'].baseUrl).hostname, '127.0.0.1');
  assert.equal(site.personaContexts.maxInstances, 4);
  assert.equal(site.deploymentProfiles.default, 'test');
  assert.equal(site.dataverse.enabled, true);
  assert.equal(site.simulation.level, 'dry-run');
});

test('templates render the target name and source folder and reject unsafe values', () => {
  const document = renderTemplate('catalogue', 'power-pages', { id: 'alpha', root: './exports/alpha' });
  assert.equal(document.defaultSite, 'alpha');
  assert.equal(document.sites.alpha.source, './exports/alpha');
  assert.equal(document.sites.alpha.environments.dev, 'https://alpha.example.test');
  assert.equal(
    renderTemplate('project', 'model-driven', { root: './solutions/core' }).solutions[0].path,
    './solutions/core',
  );
  assert.throws(() => renderTemplate('catalogue', 'power-pages', { id: '__proto__' }), /Target name/);
  assert.throws(() => renderTemplate('catalogue', 'power-pages', { root: 'a\nb' }), /control characters/);
  assert.throws(() => renderTemplate('catalogue', 'unknown'), /Unknown setup template/);
});
