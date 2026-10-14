import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { resolveDeploymentProfiles, profileSelection, loadDeploymentProfiles, deploymentProfilesSummary } from '../lib/deployment-profiles.mjs';
import { resolveProjectConfig, bootstrapProject } from '../lib/project-config.mjs';
import { resolveMirageConfig } from '../../lense/config.mjs';
import { mirageSettings } from '../../lense/config-schema.mjs';
import { bootstrapReport } from '../bootstrap-report.mjs';
import { profileFixture } from './fixtures/deployment-profiles.mjs';
import { initProject, cliArgs } from '../../lense/commands/mirage.mjs';
import { loadProjectConfig } from '../lib/project-config.mjs';

test('profile mappings validate defaults, required sections, IDs, paths and enabled flags', () => {
  for (const config of [null, [], { unknown: true }, { default: 'absent' }, { required: ['unknown'] },
    { enabled: { pages: 'true' } }, { profiles: { dev: { unknown: 'a.json' } } },
    { profiles: { dev: { pages: '' } } }, { profiles: { dev: { pages: 'a.js' } } },
    { profiles: JSON.parse('{"__proto__":{"pages":"a.json"}}') }]) assert.throws(() => resolveDeploymentProfiles(config));
  const config = resolveDeploymentProfiles({ default: 'dev', required: ['pages'], profiles: { dev: { pages: 'a.yml' } } });
  assert.throws(() => profileSelection(config, { profile: null }), /required/);
  assert.throws(() => profileSelection(config, { profile: 'missing' }), /configured/);
  assert.throws(() => profileSelection(config, { profile: 'dev', enabled: { pages: false } }), /required/);
  assert.throws(() => profileSelection(config, { profile: 'dev', enabled: { environmentVariables: true } }), /no.*mapping/);
  assert.throws(() => profileSelection(config, {}), /requires profile/);
  assert.throws(() => profileSelection(config, { profile: 'dev', file: 'unregistered.json' }));
  assert.equal(profileSelection(config).pinned, false);
});

test('catalogue and project mappings resolve beside config, with portal-specific replacement', async t => {
  const fixture = await profileFixture(t);
  mirageSettings({ deploymentProfiles: fixture.deploymentProfiles }, 'mirage');
  const catalogue = resolveMirageConfig({ deploymentProfiles: fixture.deploymentProfiles }, { configDir: fixture.root, sourceRoot: fixture.sourceDir });
  assert.equal(catalogue.deploymentProfiles.profiles.dev.pages, path.join(fixture.root, 'profiles/dev.yml'));
  const project = await resolveProjectConfig({ version: 2, deploymentProfiles: fixture.deploymentProfiles,
    portals: [{ id: 'one', path: 'portal' }, { id: 'two', path: 'portal', deploymentProfiles: {} }], solutions: ['solution'],
  }, path.join(fixture.root, 'project.json'));
  assert.equal(project.portals[0].deploymentProfiles.default, 'dev');
  assert.equal(project.portals[1].deploymentProfiles.default, null);
  const boot = await bootstrapProject(project);
  assert.equal(boot.portals[0].portal.snippets.Greeting, 'Development');
  assert.equal(boot.portals[1].portal.snippets.Greeting, 'Exported');
  const active = await loadDeploymentProfiles(catalogue.deploymentProfiles);
  assert.equal(active.environmentVariables.sample_Url, 'dev variable');
  assert.doesNotMatch(JSON.stringify(deploymentProfilesSummary(catalogue.deploymentProfiles, active)), /dev variable|dev-connection/);
});

test('mirage init preserves profile paths and launches pass catalogue profile overrides to the configured project', async t => {
  const fixture = await profileFixture(t);
  const configPath = path.join(fixture.root, 'paqvilo.config.yml');
  const projectPath = path.join(fixture.root, 'generated', 'project.yml');
  const cfg = { siteName: 'sample', envName: 'dev', sourceDir: fixture.sourceDir, stateDir: path.join(fixture.root, '.paqvilo'),
    configFile: configPath, configDir: fixture.root, origin: 'http://localhost', mirageConfig: {
      project: projectPath, solutionRoots: fixture.solutionRoots,
      deploymentProfiles: resolveDeploymentProfiles(fixture.deploymentProfiles, fixture.root),
    },
  };
  await initProject(cfg);
  const project = await loadProjectConfig(projectPath);
  assert.equal(project.portals[0].deploymentProfiles.profiles.dev.pages, path.join(fixture.root, 'profiles/dev.yml'));
  const launch = cliArgs(cfg, 'serve', {}, project).values;
  assert.equal(launch[launch.indexOf('--site') + 1], 'sample');
  assert.equal(launch[launch.indexOf('--config') + 1], configPath);
  const explicitProject = cliArgs({ ...cfg, mirageConfig: { ...cfg.mirageConfig, project: null } }, 'serve', { project: projectPath }, project).values;
  assert.equal(explicitProject.includes('--site'), false);
});

test('mapped files require correct PAC sections and reject duplicates, malformed connections and invalid Pages patches', async t => {
  const fixture = await profileFixture(t);
  const config = resolveDeploymentProfiles(fixture.deploymentProfiles, fixture.root);
  for (const contents of [{}, { EnvironmentVariables: [{ SchemaName: 'sample_Url', Value: {} }] },
    { EnvironmentVariables: [{ SchemaName: 'sample_Url', Value: 'a' }, { SchemaName: 'SAMPLE_URL', Value: 'b' }] },
    { EnvironmentVariables: [], ConnectionReferences: [{ LogicalName: 'sample_Api', ConnectionId: null, ConnectorId: 'api' }] }]) {
    await fs.writeFile(config.profiles.dev.environmentVariables, JSON.stringify(contents));
    await assert.rejects(loadDeploymentProfiles(config));
  }
  await fs.writeFile(config.profiles.dev.pages, 'adx_contentsnippet: broken');
  await assert.rejects(loadDeploymentProfiles(config), /record patches/);
  await assert.rejects(loadDeploymentProfiles(resolveDeploymentProfiles({ default: 'dev', profiles: { dev: { pages: 'missing.yml' } } }, fixture.root)), /Cannot read/);
});

test('runtime pins profiles atomically, retains overrides and pins across restart, and resets defaults', async t => {
  const fixture = await profileFixture(t);
  let app = await createSimulator({ ...fixture, watch: false });
  fixture.onCleanup(() => app?.close());
  const call = async (route, body) => {
    const response = await fetch(`${app.url}/__sim/api${route}`, body === undefined ? {} : { method: 'PUT', headers: { 'content-type': 'application/json', 'x-sim-csrf': app.state().csrf }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const variable = () => app.state().data.environmentvariablevalue.find(row => row.schemaname === 'sample_Url')?.value;
  assert.equal(app.portal.snippets.Greeting, 'Development');
  assert.equal(variable(), 'dev variable');
  assert.equal(app.state().data.connectionreference[0].connectionid, 'dev-connection');
  const before = (await call('/status')).body.sourceFingerprint;
  assert.equal((await call('/environment/profiles', { profile: 'test', enabled: { connectionReferences: false } })).status, 200);
  assert.equal(app.portal.snippets.Greeting, 'Test');
  assert.equal(variable(), 'test variable');
  assert.equal(app.state().data.connectionreference.length, 0);
  assert.notEqual((await call('/status')).body.sourceFingerprint, before);
  assert.equal((await call('/environment/profiles', { profile: 'test', enabled: { pages: false } })).status, 400);
  assert.equal(app.portal.snippets.Greeting, 'Test');
  await call('/environment/variables/sample_Url', { value: 'Manual' });
  assert.equal(variable(), 'Manual');
  await app.close();
  app = await createSimulator({ ...fixture, watch: false });
  assert.equal(app.portal.snippets.Greeting, 'Test');
  assert.equal(variable(), 'Manual');
  assert.equal((await call('/environment')).body.profileSelection.pinned, true);
  const current = (await call('/status')).body.sourceFingerprint;
  await fs.writeFile(path.join(fixture.root, 'profiles/dev-settings.json'), '{broken');
  assert.equal((await call('/environment/profiles', null)).status, 400);
  assert.equal(app.portal.snippets.Greeting, 'Test');
  assert.equal((await call('/status')).body.sourceFingerprint, current);
  await fs.writeFile(path.join(fixture.root, 'profiles/dev-settings.json'), fixture.files['profiles/dev-settings.json']);
  await call('/environment/profiles', null);
  assert.equal(app.portal.snippets.Greeting, 'Development');
  assert.equal(variable(), 'Manual');
  await call('/environment/variables/sample_Url', { value: null });
  assert.equal(variable(), 'dev variable');
  for (const [name, content] of Object.entries(fixture.files).filter(([name]) => name.startsWith('portal/'))) assert.equal(await fs.readFile(path.join(fixture.root, name), 'utf8'), content);
});

test('optional sections disable cleanly, project variables win case-insensitively, and bootstrap reports apply defaults', async t => {
  const fixture = await profileFixture(t);
  const app = await createSimulator({ ...fixture, environmentVariables: { SAMPLE_URL: 'Project' }, watch: false });
  fixture.onCleanup(() => app.close());
  assert.equal(app.state().data.environmentvariablevalue[0].value, 'Project');
  await assert.rejects(createSimulator({ ...fixture, deploymentProfile: 'legacy', watch: false }), /not both/);
  const report = await bootstrapReport({ sourceDir: fixture.sourceDir, solutionRoots: fixture.solutionRoots,
    deploymentProfiles: resolveDeploymentProfiles(fixture.deploymentProfiles, fixture.root), lcid: 1033 }, { noCache: true });
  assert.equal(report.inputs.profileSelection.profile, 'dev');
  const config = { ...fixture.deploymentProfiles, required: [], enabled: { environmentVariables: false, connectionReferences: false } };
  await fs.writeFile(path.join(fixture.root, 'profiles/dev-settings.json'), '{broken');
  const active = await loadDeploymentProfiles(resolveDeploymentProfiles(config, fixture.root));
  assert.deepEqual(active.environmentVariables, {});
  assert.equal(active.connectionReferences.length, 0);
});

test('external profile changes reload local rendering and seeded values with a new fingerprint', async t => {
  const fixture = await profileFixture(t);
  // Ordered file-list mappings must participate in normal watched development.
  for (const profile of Object.values(fixture.deploymentProfiles.profiles)) {
    profile.environmentVariables = [profile.environmentVariables];
    profile.connectionReferences = [profile.connectionReferences];
  }
  const app = await createSimulator({ ...fixture, watch: true });
  fixture.onCleanup(() => app.close());
  const status = async () => (await (await fetch(app.url + '/__sim/api/status')).json());
  const fingerprint = (await status()).sourceFingerprint;
  await fs.writeFile(path.join(fixture.root, 'profiles/dev.yml'), 'adx_contentsnippet:\n- adx_contentsnippetid: greeting\n  adx_value: Reloaded');
  // Poll the bounded local watcher rather than assuming a fixed delay.
  const end = Date.now() + 10000;
  while (app.portal.snippets.Greeting !== 'Reloaded' && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(app.portal.snippets.Greeting, 'Reloaded');
  assert.notEqual((await status()).sourceFingerprint, fingerprint);
  await fs.writeFile(path.join(fixture.root, 'profiles/dev-settings.json'), JSON.stringify({ EnvironmentVariables: [{ SchemaName: 'sample_Url', Value: 'Reloaded variable' }], ConnectionReferences: [] }));
  const valuesEnd = Date.now() + 10000;
  while (app.state().data.environmentvariablevalue[0].value !== 'Reloaded variable' && Date.now() < valuesEnd) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(app.state().data.environmentvariablevalue[0].value, 'Reloaded variable');
  assert.equal(app.state().data.connectionreference.length, 0);
});

test('no-profile pin restores source values, removes owned seeds only and preserves manual snippet overrides', async t => {
  const fixture = await profileFixture(t);
  fixture.deploymentProfiles.required = [];
  const app = await createSimulator({ ...fixture, watch: false });
  fixture.onCleanup(() => app.close());
  const mutate = async (route, method, body) => fetch(app.url + '/__sim/api' + route, {
    method, headers: { 'content-type': 'application/json', 'x-sim-csrf': app.state().csrf }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  app.store.state.tables.connectionreference.push({ connectionreferenceid: 'unrelated', connectionreferencelogicalname: 'sample_Other', connectionid: 'local' });
  assert.equal((await mutate('/portal-snippets/Greeting', 'PATCH', { value: 'Manual snippet' })).status, 200);
  await mutate('/environment/profiles', 'PUT', { profile: 'test' });
  assert.equal(app.portal.snippets.Greeting, 'Manual snippet');
  await mutate('/environment/profiles', 'PUT', { profile: null });
  assert.equal(app.portal.snippets.Greeting, 'Manual snippet');
  assert.equal(app.state().data.environmentvariablevalue[0].value, 'Exported variable');
  assert.deepEqual(app.state().data.connectionreference.map(row => row.connectionreferenceid), ['unrelated']);
  await mutate('/portal-snippets/Greeting', 'DELETE');
  assert.equal(app.portal.snippets.Greeting, 'Exported');
  assert.equal(app.state().status.profileSelection.profile, null);
  await app.close();
  const stale = { ...fixture.deploymentProfiles, profiles: {} };
  delete stale.default;
  // A saved non-null pin must not silently fall back if its mapping disappears.
  await fs.writeFile(fixture.stateFile, JSON.stringify({ simulator: { deploymentProfilePin: { profile: 'test' } } }));
  await assert.rejects(createSimulator({ ...fixture, deploymentProfiles: stale, watch: false }), /configured deployment profile/);
});

test('shutdown drains an in-flight source reload before fixture removal and rejects later reloads', { timeout: 15000 }, async t => {
  const fixture = await profileFixture(t);
  const app = await createSimulator({ ...fixture, watch: true });
  let release, entered;
  const blocked = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  fixture.onCleanup(() => { release(); return app.close(); });
  const replace = app.store.replaceState.bind(app.store);
  let replacements = 0;
  app.store.replaceState = async state => {
    replacements++;
    entered();
    await blocked;
    return replace(state);
  };
  const pending = app.reload();
  await started;
  let closed = false;
  const shutdown = app.close().then(() => { closed = true; });
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(closed, false, 'shutdown must wait for the accepted reload');
  release();
  await Promise.all([pending, shutdown]);
  await app.reload();
  assert.equal(replacements, 1, 'a closed runtime cannot schedule another source write');
  await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 5 });
  await new Promise(resolve => setTimeout(resolve, 400));
  await assert.rejects(fs.stat(fixture.root), { code: 'ENOENT' });
});
