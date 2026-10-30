import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { createMirageContext } from '../api.mjs';
import { loadProjectConfig } from '../lib/project-config.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

async function portal(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-content-policy-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'web-pages'));
  await fs.writeFile(path.join(root, 'website.yml'), 'adx_websiteid: site\nadx_name: Invented policy');
  await fs.writeFile(path.join(root, 'Home.webpage.yml'), 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /');
  return root;
}

test('persisted project policy retains its value but reports current default drift consistently', async (t) => {
  const root = await portal(t),
    stateFile = path.join(root, 'local-state.json');
  let app;
  ownedFixture(t).add(() => app?.close());
  app = await createSimulator({
    sourceDir: root,
    stateFile,
    watch: false,
    contentPolicyDefaults: { confinePortalPages: true },
  });
  assert.equal(app.state().config.contentPolicySource, 'project defaults');
  await app.store.compact();
  await app.close();
  app = await createSimulator({
    sourceDir: root,
    stateFile,
    watch: false,
    contentPolicyDefaults: { confinePortalPages: false },
  });
  assert.equal(app.state().config.confinePortalPages, true);
  assert.equal(app.state().config.contentPolicySource, 'runtime state (project default differs)');
  assert.equal(
    (await (await fetch(app.url + '/__sim/api/status')).json()).contentPolicySource,
    'runtime state (project default differs)',
  );
  assert.equal(
    JSON.parse(readFileSync(stateFile)).simulator.contentPolicySource,
    'project defaults',
    'reporting does not rewrite persisted provenance',
  );
  const changed = await fetch(app.url + '/_sim/api/config', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': app.state().csrf },
    body: JSON.stringify({ pageMode: 'local' }),
  });
  assert.equal(changed.status, 200, await changed.text());
  await app.store.compact();
  assert.equal(JSON.parse(readFileSync(stateFile)).simulator.contentPolicySource, 'project defaults');
  await app.close();
  app = await createSimulator({
    sourceDir: root,
    stateFile,
    watch: false,
    contentPolicyDefaults: { confinePortalPages: true },
  });
  assert.equal(app.state().config.contentPolicySource, 'project defaults');
  await app.close();
  app = await createSimulator({
    sourceDir: root,
    stateFile,
    watch: false,
    contentPolicyDefaults: { externalAssets: false },
  });
  assert.equal(
    app.state().config.contentPolicySource,
    'runtime state (project default differs)',
    'removing the confined default also counts as drift when another policy default remains',
  );
  await app.close();
  app = await createSimulator({ sourceDir: root, stateFile, watch: false });
  assert.equal(app.state().config.contentPolicySource, 'project defaults (no longer configured)');
});

test('project confinement seeds new states and a saved runtime setting wins on restart', async (t) => {
  const root = await portal(t),
    settings = {
      sourceDir: root,
      stateFile: path.join(root, 'state.json'),
      watch: false,
      contentPolicyDefaults: { confinePortalPages: true },
    };
  const app = await createSimulator(settings);
  ownedFixture(t).add(() => app.close());
  assert.equal(app.state().config.confinePortalPages, true);
  assert.match((await fetch(app.url + '/')).headers.get('content-security-policy'), /connect-src 'self'/);
  app.store.state.simulator.confinePortalPages = false;
  await app.store.compact();
  await app.close();
  const restarted = await createSimulator(settings);
  ownedFixture(t).add(() => restarted.close());
  assert.equal(restarted.state().config.confinePortalPages, false);
  const other = await createSimulator({
    ...settings,
    stateFile: path.join(root, 'default-state.json'),
    contentPolicyDefaults: {},
  });
  ownedFixture(t).add(() => other.close());
  assert.equal(other.state().config.confinePortalPages, false);
});

test('project confinement does not mutate shared initial state or leak defaults between runtimes', async (t) => {
  const root = await portal(t);
  const initial = { settings: { permissionMode: 'permissive' }, simulator: { identity: { roles: [] } } },
    before = structuredClone(initial);
  const first = await createSimulator({
    sourceDir: root,
    initial,
    watch: false,
    contentPolicyDefaults: { confinePortalPages: true },
  });
  ownedFixture(t).add(() => first.close());
  assert.equal(first.state().config.confinePortalPages, true);
  assert.equal(first.state().config.contentPolicySource, 'project defaults');
  assert.deepEqual(initial, before, 'starting a runtime must not change caller-owned seed data');
  const second = await createSimulator({
    sourceDir: root,
    initial,
    watch: false,
    contentPolicyDefaults: { confinePortalPages: false },
  });
  ownedFixture(t).add(() => second.close());
  assert.equal(second.state().config.confinePortalPages, false);
  assert.equal(second.state().config.contentPolicySource, 'project defaults');
  assert.deepEqual(initial, before);
});

test('project file policy defaults inherit per site and reach a catalogue-bound runtime', async (t) => {
  const root = await portal(t);
  const projectFile = path.join(root, 'project.json'),
    catalogue = path.join(root, 'catalogue-policy.json');
  await fs.writeFile(
    projectFile,
    JSON.stringify({
      version: 1,
      confinePortalPages: true,
      externalFrameOrigins: ['https://frames.example.test/'],
      portals: [
        { id: 'inherited', path: '.' },
        { id: 'override', path: '.', confinePortalPages: false, externalFrameOrigins: [] },
      ],
    }),
  );
  const project = await loadProjectConfig(projectFile);
  assert.equal(project.portals[0].confinePortalPages, true);
  assert.equal(project.portals[1].confinePortalPages, false);
  assert.deepEqual(project.portals[0].externalFrameOrigins, ['https://frames.example.test']);
  assert.deepEqual(project.portals[1].externalFrameOrigins, []);
  await fs.writeFile(
    catalogue,
    JSON.stringify({
      sites: {
        invented: {
          source: root,
          environments: { local: 'http://127.0.0.1:8787' },
          mirage: { project: 'project.json' },
        },
      },
    }),
  );
  const context = await createMirageContext({ config: catalogue, site: 'invented' }),
    app = await context.createSimulator({ watch: false });
  ownedFixture(t).add(() => app.close());
  assert.equal(app.state().config.confinePortalPages, true);
  assert.equal(app.state().config.contentPolicySource, 'project defaults');
  const response = await fetch(app.url);
  assert.match(response.headers.get('content-security-policy'), /frame-src 'self' https:\/\/frames\.example\.test/);
  await fs.writeFile(
    projectFile,
    JSON.stringify({ version: 1, confinePortalPages: 'true', portals: [{ id: 'invalid', path: '.' }] }),
  );
  await assert.rejects(loadProjectConfig(projectFile), /confinePortalPages must be true or false/);
});
