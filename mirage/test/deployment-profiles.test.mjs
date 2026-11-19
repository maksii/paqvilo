// @test-kind contract: Paqvilo deployment-profile design: profile selection, validation, application and status (mirage/docs/deployment-profiles.md)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import {
  resolveDeploymentProfiles,
  profileSelection,
  loadDeploymentProfiles,
  deploymentProfilesSummary,
  deploymentProfilesStatus,
  withDefinedVariables,
} from '../lib/deployment-profiles.mjs';
import { resolveProjectConfig, bootstrapProject } from '../lib/project-config.mjs';
import { resolveMirageConfig } from '../../lense/config.mjs';
import { mirageSettings } from '../../lense/config-schema.mjs';
import { bootstrapReport } from '../bootstrap-report.mjs';
import { profileFixture } from './fixtures/deployment-profiles.mjs';
import { ownedClose } from '../testing/owned-fixture.mjs';
import { initProject, cliArgs, mirageReadiness } from '../../lense/commands/mirage.mjs';
import { loadProjectConfig } from '../lib/project-config.mjs';
import { SCENARIO_HANG_GUARD_MS } from '../../test/helpers/bounded-command.mjs';

// The simulator announces each finished source reload on /__sim/events ("event: reload"). The watcher's write-stability
// and debounce windows make the time to a reload machine-dependent, so a test waits on these announcements, never a clock:
// the returned function resolves once the predicate holds, re-checking it after every reload.
async function reloadEvents(app, fixture) {
  const controller = new AbortController();
  fixture.onCleanup(() => controller.abort());
  const response = await fetch(`${app.url}/__sim/events`, { signal: controller.signal });
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  return async (predicate) => {
    while (!(await predicate())) {
      let match;
      while (!(match = /event: reload\ndata: \d+\n\n/.exec(buffer))) {
        const { value, done } = await reader.read();
        if (done) throw new Error('The simulator event stream ended before the expected reload.');
        buffer += value;
      }
      buffer = buffer.slice(match.index + match[0].length);
    }
  };
}

test('profile mappings validate defaults, required sections, IDs, paths and enabled flags', () => {
  for (const [config, message] of [
    [null, /must be an object containing only/],
    [[], /must be an object containing only/],
    [{ unknown: true }, /must be an object containing only/],
    [{ default: 'absent' }, /default must name a configured profile/],
    [{ required: ['unknown'] }, /required must list distinct profile sections/],
    [{ enabled: { pages: 'true' } }, /enabled values must be boolean/],
    [{ profiles: { dev: { unknown: 'a.json' } } }, /profiles\.dev must be an object containing only/],
    [{ profiles: { dev: { pages: '' } } }, /requires a JSON or YAML file path/],
    [{ profiles: { dev: { pages: 'a.js' } } }, /requires a JSON or YAML file path/],
    [{ profiles: JSON.parse('{"__proto__":{"pages":"a.json"}}') }, /profile IDs must be safe names/],
  ])
    assert.throws(() => resolveDeploymentProfiles(config), message);
  const config = resolveDeploymentProfiles({
    default: 'dev',
    required: ['pages'],
    profiles: { dev: { pages: 'a.yml' } },
  });
  assert.throws(() => profileSelection(config, { profile: null }), /required/);
  assert.throws(() => profileSelection(config, { profile: 'missing' }), /configured/);
  assert.throws(() => profileSelection(config, { profile: 'dev', enabled: { pages: false } }), /required/);
  assert.throws(
    () => profileSelection(config, { profile: 'dev', enabled: { environmentVariables: true } }),
    /no.*mapping/,
  );
  assert.throws(() => profileSelection(config, {}), /requires profile/);
  assert.throws(
    () => profileSelection(config, { profile: 'dev', file: 'unregistered.json' }),
    /pin must be an object containing only profile, enabled/,
  );
  assert.equal(profileSelection(config).pinned, false);
});

test('catalogue and project mappings resolve beside config, with portal-specific replacement', async (t) => {
  const fixture = await profileFixture(t);
  mirageSettings({ deploymentProfiles: fixture.deploymentProfiles }, 'mirage');
  const catalogue = resolveMirageConfig(
    { deploymentProfiles: fixture.deploymentProfiles },
    { configDir: fixture.root, sourceRoot: fixture.sourceDir },
  );
  assert.equal(catalogue.deploymentProfiles.profiles.dev.pages, path.join(fixture.root, 'profiles/dev.yml'));
  const project = await resolveProjectConfig(
    {
      version: 2,
      deploymentProfiles: fixture.deploymentProfiles,
      portals: [
        { id: 'one', path: 'portal' },
        { id: 'two', path: 'portal', deploymentProfiles: {} },
      ],
      solutions: ['solution'],
    },
    path.join(fixture.root, 'project.json'),
  );
  assert.equal(project.portals[0].deploymentProfiles.default, 'dev');
  assert.equal(project.portals[1].deploymentProfiles.default, null);
  const boot = await bootstrapProject(project);
  assert.equal(boot.portals[0].portal.snippets.Greeting, 'Development');
  assert.equal(boot.portals[1].portal.snippets.Greeting, 'Exported');
  const active = await loadDeploymentProfiles(catalogue.deploymentProfiles);
  assert.equal(active.environmentVariables.sample_Url, 'dev variable');
  assert.doesNotMatch(
    JSON.stringify(deploymentProfilesSummary(catalogue.deploymentProfiles, active)),
    /dev variable|dev-connection/,
  );
});

test('mirage init preserves profile paths and launches pass catalogue profile overrides to the configured project', async (t) => {
  const fixture = await profileFixture(t);
  const configPath = path.join(fixture.root, 'paqvilo.config.yml');
  const projectPath = path.join(fixture.root, 'generated', 'project.yml');
  const cfg = {
    siteName: 'sample',
    envName: 'dev',
    sourceDir: fixture.sourceDir,
    stateDir: path.join(fixture.root, '.paqvilo'),
    configFile: configPath,
    configDir: fixture.root,
    origin: 'http://localhost',
    mirageConfig: {
      project: projectPath,
      solutionRoots: fixture.solutionRoots,
      deploymentProfiles: resolveDeploymentProfiles(fixture.deploymentProfiles, fixture.root),
    },
  };
  await initProject(cfg);
  const project = await loadProjectConfig(projectPath);
  assert.equal(project.portals[0].deploymentProfiles.profiles.dev.pages, path.join(fixture.root, 'profiles/dev.yml'));
  const launch = cliArgs(cfg, 'serve', {}, project).values;
  assert.equal(launch[launch.indexOf('--site') + 1], 'sample');
  assert.equal(launch[launch.indexOf('--config') + 1], configPath);
  const explicitProject = cliArgs(
    { ...cfg, mirageConfig: { ...cfg.mirageConfig, project: null } },
    'serve',
    { project: projectPath },
    project,
  ).values;
  assert.equal(explicitProject.includes('--site'), false);
});

test('mapped files require correct PAC sections and reject duplicates, malformed connections and invalid Pages patches', async (t) => {
  const fixture = await profileFixture(t);
  const config = resolveDeploymentProfiles(fixture.deploymentProfiles, fixture.root);
  for (const [contents, message] of [
    [{}, /requires a EnvironmentVariables array/],
    [{ EnvironmentVariables: [{ SchemaName: 'sample_Url', Value: {} }] }, /requires scalar Value fields/],
    [
      {
        EnvironmentVariables: [
          { SchemaName: 'sample_Url', Value: 'a' },
          { SchemaName: 'SAMPLE_URL', Value: 'b' },
        ],
      },
      /requires distinct valid schema\/logical names/,
    ],
    [
      {
        EnvironmentVariables: [],
        ConnectionReferences: [{ LogicalName: 'sample_Api', ConnectionId: null, ConnectorId: 'api' }],
      },
      /requires valid ConnectionId fields/,
    ],
  ]) {
    await fs.writeFile(config.profiles.dev.environmentVariables, JSON.stringify(contents));
    await assert.rejects(loadDeploymentProfiles(config), message);
  }
  await fs.writeFile(config.profiles.dev.pages, 'adx_contentsnippet: broken');
  await assert.rejects(loadDeploymentProfiles(config), /record patches/);
  await assert.rejects(
    loadDeploymentProfiles(
      resolveDeploymentProfiles({ default: 'dev', profiles: { dev: { pages: 'missing.yml' } } }, fixture.root),
    ),
    /Cannot read/,
  );
});

// Hang guard only: it starts a simulator and drives it through its reloads; on a loaded slow host that is slow, not hung.
test(
  'runtime pins profiles atomically, retains overrides and pins across restart, and resets defaults',
  { timeout: SCENARIO_HANG_GUARD_MS },
  async (t) => {
    const fixture = await profileFixture(t);
    let app = ownedClose(t, await createSimulator({ ...fixture, watch: false }));
    const call = async (route, body) => {
      const response = await fetch(
        `${app.url}/__sim/api${route}`,
        body === undefined
          ? {}
          : {
              method: 'PUT',
              headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
              body: JSON.stringify(body),
            },
      );
      return { status: response.status, body: await response.json() };
    };
    const variable = () =>
      app.state().data.environmentvariablevalue.find((row) => row.schemaname === 'sample_Url')?.value;
    assert.equal(app.portal.snippets.Greeting, 'Development');
    assert.equal(variable(), 'dev variable');
    assert.equal(app.state().data.connectionreference[0].connectionid, 'dev-connection');
    const before = (await call('/status')).body.sourceFingerprint;
    assert.equal(
      (await call('/environment/profiles', { profile: 'test', enabled: { connectionReferences: false } })).status,
      200,
    );
    assert.equal(app.portal.snippets.Greeting, 'Test');
    assert.equal(variable(), 'test variable');
    assert.equal(app.state().data.connectionreference.length, 0);
    assert.notEqual((await call('/status')).body.sourceFingerprint, before);
    assert.equal((await call('/environment/profiles', { profile: 'test', enabled: { pages: false } })).status, 400);
    assert.equal(app.portal.snippets.Greeting, 'Test');
    await call('/environment/variables/sample_Url', { value: 'Manual' });
    assert.equal(variable(), 'Manual');
    await app.close();
    app = ownedClose(t, await createSimulator({ ...fixture, watch: false }));
    assert.equal(app.portal.snippets.Greeting, 'Test');
    assert.equal(variable(), 'Manual');
    assert.equal((await call('/environment')).body.profileSelection.pinned, true);
    const current = (await call('/status')).body.sourceFingerprint;
    await fs.writeFile(path.join(fixture.root, 'profiles/dev-settings.json'), '{broken');
    assert.equal((await call('/environment/profiles', null)).status, 400);
    assert.equal(app.portal.snippets.Greeting, 'Test');
    assert.equal((await call('/status')).body.sourceFingerprint, current);
    await fs.writeFile(
      path.join(fixture.root, 'profiles/dev-settings.json'),
      fixture.files['profiles/dev-settings.json'],
    );
    await call('/environment/profiles', null);
    assert.equal(app.portal.snippets.Greeting, 'Development');
    assert.equal(variable(), 'Manual');
    await call('/environment/variables/sample_Url', { value: null });
    assert.equal(variable(), 'dev variable');
    for (const [name, content] of Object.entries(fixture.files).filter(([name]) => name.startsWith('portal/')))
      assert.equal(await fs.readFile(path.join(fixture.root, name), 'utf8'), content);
  },
);

test('optional sections disable cleanly, project variables win case-insensitively, and bootstrap reports apply defaults', async (t) => {
  const fixture = await profileFixture(t);
  const app = await createSimulator({ ...fixture, environmentVariables: { SAMPLE_URL: 'Project' }, watch: false });
  fixture.onCleanup(() => app.close());
  assert.equal(app.state().data.environmentvariablevalue[0].value, 'Project');
  await assert.rejects(createSimulator({ ...fixture, deploymentProfile: 'legacy', watch: false }), /not both/);
  const report = await bootstrapReport(
    {
      sourceDir: fixture.sourceDir,
      solutionRoots: fixture.solutionRoots,
      deploymentProfiles: resolveDeploymentProfiles(fixture.deploymentProfiles, fixture.root),
      lcid: 1033,
    },
    { noCache: true },
  );
  assert.equal(report.inputs.profileSelection.profile, 'dev');
  const config = {
    ...fixture.deploymentProfiles,
    required: [],
    enabled: { environmentVariables: false, connectionReferences: false },
  };
  await fs.writeFile(path.join(fixture.root, 'profiles/dev-settings.json'), '{broken');
  const active = await loadDeploymentProfiles(resolveDeploymentProfiles(config, fixture.root));
  assert.deepEqual(active.environmentVariables, {});
  assert.equal(active.connectionReferences.length, 0);
});

// Hang guard only: a runtime start and two source reloads that follow file-watcher events.
test(
  'external profile changes reload local rendering and seeded values with a new fingerprint',
  { timeout: SCENARIO_HANG_GUARD_MS },
  async (t) => {
    const fixture = await profileFixture(t);
    // Ordered file-list mappings must participate in normal watched development.
    for (const profile of Object.values(fixture.deploymentProfiles.profiles)) {
      profile.environmentVariables = [profile.environmentVariables];
      profile.connectionReferences = [profile.connectionReferences];
    }
    const app = await createSimulator({ ...fixture, watch: true });
    fixture.onCleanup(() => app.close());
    const reloaded = await reloadEvents(app, fixture);
    const status = async () => await (await fetch(app.url + '/__sim/api/status')).json();
    const fingerprint = (await status()).sourceFingerprint;
    await fs.writeFile(
      path.join(fixture.root, 'profiles/dev.yml'),
      'adx_contentsnippet:\n- adx_contentsnippetid: greeting\n  adx_value: Reloaded',
    );
    await reloaded(
      async () => app.portal.snippets.Greeting === 'Reloaded' && (await status()).sourceFingerprint !== fingerprint,
    );
    assert.equal(app.portal.snippets.Greeting, 'Reloaded');
    assert.notEqual((await status()).sourceFingerprint, fingerprint);
    await fs.writeFile(
      path.join(fixture.root, 'profiles/dev-settings.json'),
      JSON.stringify({
        EnvironmentVariables: [{ SchemaName: 'sample_Url', Value: 'Reloaded variable' }],
        ConnectionReferences: [],
      }),
    );
    await reloaded(() => app.state().data.environmentvariablevalue[0].value === 'Reloaded variable');
    assert.equal(app.state().data.environmentvariablevalue[0].value, 'Reloaded variable');
    assert.equal(app.state().data.connectionreference.length, 0);
  },
);

test('no-profile pin restores source values, removes owned seeds only and preserves manual snippet overrides', async (t) => {
  const fixture = await profileFixture(t);
  fixture.deploymentProfiles.required = [];
  const app = await createSimulator({ ...fixture, watch: false });
  fixture.onCleanup(() => app.close());
  const mutate = async (route, method, body) =>
    fetch(app.url + '/__sim/api' + route, {
      method,
      headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  app.store.state.tables.connectionreference.push({
    connectionreferenceid: 'unrelated',
    connectionreferencelogicalname: 'sample_Other',
    connectionid: 'local',
  });
  assert.equal((await mutate('/portal-snippets/Greeting', 'PATCH', { value: 'Manual snippet' })).status, 200);
  await mutate('/environment/profiles', 'PUT', { profile: 'test' });
  assert.equal(app.portal.snippets.Greeting, 'Manual snippet');
  await mutate('/environment/profiles', 'PUT', { profile: null });
  assert.equal(app.portal.snippets.Greeting, 'Manual snippet');
  assert.equal(app.state().data.environmentvariablevalue[0].value, 'Exported variable');
  assert.deepEqual(
    app.state().data.connectionreference.map((row) => row.connectionreferenceid),
    ['unrelated'],
  );
  await mutate('/portal-snippets/Greeting', 'DELETE');
  assert.equal(app.portal.snippets.Greeting, 'Exported');
  assert.equal(app.state().status.profileSelection.profile, null);
  await app.close();
  const stale = { ...fixture.deploymentProfiles, profiles: {} };
  delete stale.default;
  // A saved non-null pin must not silently fall back if its mapping disappears.
  await fs.writeFile(fixture.stateFile, JSON.stringify({ simulator: { deploymentProfilePin: { profile: 'test' } } }));
  await assert.rejects(
    createSimulator({ ...fixture, deploymentProfiles: stale, watch: false }),
    /configured deployment profile/,
  );
});

test('a restored pin naming an unconfigured profile names the pin, the configured profiles and the state file', async (t) => {
  const fixture = await profileFixture(t);
  await fs.mkdir(path.dirname(fixture.stateFile), { recursive: true });
  await fs.writeFile(fixture.stateFile, JSON.stringify({ simulator: { deploymentProfilePin: { profile: 'gone' } } }));
  const configured = Object.keys(fixture.deploymentProfiles.profiles).join(', ');
  await assert.rejects(createSimulator({ ...fixture, watch: false }), {
    message: `Select a configured deployment profile: the locally pinned profile "gone" is not configured (configured: ${configured}). Remove simulator.deploymentProfilePin from ${path.resolve(fixture.stateFile)}, or restore the profile.`,
  });
  // A request naming an unknown profile (no state file involved) keeps the generic message.
  const config = resolveDeploymentProfiles(fixture.deploymentProfiles, fixture.projectRoot);
  assert.throws(() => profileSelection(config, { profile: 'gone' }), {
    message: 'Select a configured deployment profile.',
  });
});

// Negative windows: there is no positive signal for "has not happened". A close that ignored the held reload finishes in a
// few turns; a late source write would come from the watcher's 200 ms write-stability and 250 ms debounce (server.mjs).
const SHUTDOWN_PROBE_MS = 40;
const LATE_WRITE_WINDOW_MS = 200 + 250;

test('shutdown drains an in-flight source reload before fixture removal and rejects later reloads', async (t) => {
  const fixture = await profileFixture(t);
  const app = await createSimulator({ ...fixture, watch: true });
  let release, entered;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise((resolve) => {
    entered = resolve;
  });
  fixture.onCleanup(() => {
    release();
    return app.close();
  });
  const replace = app.store.replaceState.bind(app.store);
  let replacements = 0;
  app.store.replaceState = async (state) => {
    replacements++;
    entered();
    await blocked;
    return replace(state);
  };
  const pending = app.reload();
  await started;
  let closed = false;
  const shutdown = app.close().then(() => {
    closed = true;
  });
  // Nothing signals "close is waiting", so a bounded window proves close has not finished while the reload is held.
  await new Promise((resolve) => setTimeout(resolve, SHUTDOWN_PROBE_MS));
  assert.equal(closed, false, 'shutdown must wait for the accepted reload');
  release();
  await Promise.all([pending, shutdown]);
  await app.reload();
  assert.equal(replacements, 1, 'a closed runtime cannot schedule another source write');
  await fs.rm(fixture.root, { recursive: true, force: true, maxRetries: 5 });
  // No late writer may recreate the removed fixture: wait out one watcher write-stability and debounce window.
  await new Promise((resolve) => setTimeout(resolve, LATE_WRITE_WINDOW_MS));
  await assert.rejects(fs.stat(fixture.root), { code: 'ENOENT' });
});

test('unused PAC connection references are reported without dropping connected entries', async (t) => {
  const fixture = await profileFixture(t),
    file = path.join(fixture.root, 'mixed.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      ConnectionReferences: [
        { LogicalName: 'unused', ConnectionId: '', ConnectorId: '' },
        { LogicalName: 'active', ConnectionId: 'synthetic-connection', ConnectorId: 'connector' },
      ],
    }),
  );
  const config = resolveDeploymentProfiles(
    { default: 'dev', profiles: { dev: { connectionReferences: 'mixed.json' } } },
    fixture.root,
  );
  const loaded = await loadDeploymentProfiles(config);
  assert.equal(loaded.connectionReferences.length, 1);
  assert.equal(loaded.connectionReferences[0].logicalName, 'active');
  assert.equal(loaded.diagnostics[0].code, 'DEPLOYMENT_PROFILE_CONNECTION_UNSET');
  assert.equal(loaded.diagnostics[0].count, 1);
  assert.deepEqual(loaded.diagnostics[0].logicalNames, ['unused']);
  assert.equal(loaded.diagnostics[0].message, '1 connection reference entry has no ConnectionId and was not seeded.');
  await fs.writeFile(
    file,
    JSON.stringify({
      ConnectionReferences: [
        { LogicalName: 'unused', ConnectionId: '', ConnectorId: '' },
        { LogicalName: 'second', ConnectionId: '', ConnectorId: '' },
      ],
    }),
  );
  assert.equal(
    (await loadDeploymentProfiles(config)).diagnostics[0].message,
    '2 connection reference entries have no ConnectionId and were not seeded.',
  );
  await fs.writeFile(
    file,
    JSON.stringify({
      ConnectionReferences: [
        { LogicalName: 'unused', ConnectionId: '', ConnectorId: '' },
        { LogicalName: 'active', ConnectionId: 'synthetic-connection', ConnectorId: 'connector' },
      ],
    }),
  );
  const app = await createSimulator({ ...fixture, deploymentProfiles: config, watch: false });
  fixture.onCleanup(() => app.close());
  assert.equal(app.store.snapshot().tables.connectionreference.length, 1);
  assert.ok(app.state().diagnostics.some((d) => d.code === 'DEPLOYMENT_PROFILE_CONNECTION_UNSET'));
});

test('source-relative profile paths follow the selected checkout and Solution files merge in order', async (t) => {
  const fixture = await profileFixture(t);
  await fs.mkdir(path.join(fixture.sourceDir, 'deployment-profiles'), { recursive: true });
  await fs.writeFile(
    path.join(fixture.sourceDir, 'deployment-profiles', 'local.json'),
    JSON.stringify({
      EnvironmentVariables: [{ SchemaName: 'sample_Url', Value: 'local last' }],
      ConnectionReferences: [{ LogicalName: 'sample_Api', ConnectionId: 'local-connection', ConnectorId: 'connector' }],
    }),
  );
  const mirage = {
    deploymentProfiles: {
      default: 'dev',
      profiles: {
        dev: {
          environmentVariables: ['profiles/dev-settings.json', { source: 'deployment-profiles/local.json' }],
          connectionReferences: ['profiles/dev-settings.json', { source: 'deployment-profiles/local.json' }],
        },
      },
    },
  };
  const config = resolveMirageConfig(mirage, {
    configDir: fixture.root,
    sourceRoot: path.dirname(fixture.sourceDir),
    sourceDir: fixture.sourceDir,
  }).deploymentProfiles;
  const loaded = await loadDeploymentProfiles(config);
  assert.equal(loaded.environmentVariables.sample_Url, 'local last');
  assert.equal(loaded.connectionReferences[0].connectionId, 'local-connection');
  const other = resolveMirageConfig(mirage, {
    configDir: fixture.root,
    sourceRoot: fixture.root,
    sourceDir: path.join(fixture.root, 'other-checkout'),
  });
  assert.equal(
    other.deploymentProfiles.profiles.dev.environmentVariables[1],
    path.join(fixture.root, 'other-checkout', 'deployment-profiles', 'local.json'),
  );
});

test('profile parser failures report file, code and line without exposing source values, including doctor', async (t) => {
  const fixture = await profileFixture(t),
    file = path.join(fixture.root, 'duplicate.yml');
  await fs.writeFile(file, 'adx_contentsnippet: []\nadx_contentsnippet: []\nsecret: do-not-echo-this\n');
  const config = resolveDeploymentProfiles(
    { default: 'broken', profiles: { broken: { pages: 'duplicate.yml' } } },
    fixture.root,
  );
  await assert.rejects(
    loadDeploymentProfiles(config),
    (error) =>
      error.details.file === 'duplicate.yml' &&
      error.details.parserCode === 'DUPLICATE_KEY' &&
      error.details.line === 2 &&
      !error.message.includes('do-not-echo-this'),
  );
  const status = await deploymentProfilesStatus(config);
  assert.equal(status.ready, false);
  assert.equal(status.profiles[0].files[0].exists, true);
  const report = await mirageReadiness(
    {
      configDir: fixture.root,
      stateDir: path.join(fixture.root, '.paqvilo'),
      siteName: 'synthetic',
      sourceDir: fixture.sourceDir,
      mirageConfig: { solutionRoots: [], dataPacks: [], deploymentProfiles: config },
    },
    {},
    { checkPort: async () => true },
  );
  assert.equal(report.deploymentProfiles.profiles[0].error.line, 2);
  assert.ok(report.errors.some((message) => message.includes('duplicate.yml')));
});

// @test-kind contract: an EnvironmentVariables entry without a Solution definition changes nothing, so it is reported and never counted as applied (mirage/docs/deployment-profiles.md)
test('a profile environment variable without a definition is a diagnostic on both hosts and is not counted', async (t) => {
  const fixture = await profileFixture(t);
  await fs.writeFile(
    path.join(fixture.root, 'profiles', 'dev-settings.json'),
    JSON.stringify({
      EnvironmentVariables: [
        { SchemaName: 'sample_Url', Value: 'dev variable' },
        { SchemaName: 'sample_Missing', Value: 'nowhere' },
      ],
      ConnectionReferences: JSON.parse(fixture.files['profiles/dev-settings.json']).ConnectionReferences,
    }),
  );
  const standalone = {
    runtime: { kind: 'dataverse-api' },
    solutionRoots: fixture.solutionRoots,
    projectRoot: fixture.root,
    deploymentProfiles: fixture.deploymentProfiles,
    stateFile: path.join(fixture.root, 'standalone-state.json'),
    simulation: { level: 'dry-run' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  };
  for (const options of [{ ...fixture, deploymentProfiles: fixture.deploymentProfiles }, standalone]) {
    const app = await createSimulator({ ...options, port: 0, watch: false });
    fixture.onCleanup(() => app.close());
    const selection = (await (await fetch(`${app.url}/_sim/api/environment`)).json()).profileSelection;
    assert.equal(selection.counts.environmentVariables, 1, JSON.stringify(selection.counts));
    const undefinedEntry = selection.diagnostics.filter(
      (entry) => entry.code === 'DEPLOYMENT_PROFILE_VARIABLE_UNDEFINED',
    );
    assert.deepEqual(
      undefinedEntry.map(({ profile, schemaName }) => [profile, schemaName]),
      [['dev', 'sample_Missing']],
    );
    await app.close();
  }
});

// @test-kind contract: the standalone host cannot switch deployment profiles at run time and says so, not that none are configured
test('a standalone profile switch is refused with its own reason when profiles are configured', async (t) => {
  const fixture = await profileFixture(t);
  const catalogue = path.join(fixture.root, 'paqvilo.config.yml'),
    projectFile = path.join(fixture.root, 'mirage.project.yml');
  // The reason names where the starting profile is selected: the catalogue site, the project file or the API option.
  for (const [setup, where] of [
    [undefined, 'pass the profile as deploymentProfiles.default to createSimulator'],
    [
      { config: catalogue, site: 'sample' },
      `set mirage.deploymentProfiles.default for site sample in the catalogue ${catalogue}`,
    ],
    [{ project: projectFile }, `set deploymentProfiles.default in the project file ${projectFile}`],
  ]) {
    const app = await createSimulator({
      runtime: { kind: 'dataverse-api' },
      solutionRoots: fixture.solutionRoots,
      projectRoot: fixture.root,
      deploymentProfiles: fixture.deploymentProfiles,
      stateFile: path.join(fixture.root, 'standalone-state.json'),
      simulation: { level: 'dry-run' },
      port: 0,
      watch: false,
      ...(setup ? { setup } : {}),
    });
    try {
      const response = await fetch(`${app.url}/_sim/api/environment/profiles`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-sim-csrf': app.csrf },
        body: JSON.stringify({ profile: 'test' }),
      });
      const body = await response.json();
      assert.equal(response.status, 501);
      assert.equal(body.supported, false);
      assert.equal(
        body.reason,
        `The standalone host does not switch deployment profiles while it runs: ${where} and restart.`,
      );
    } finally {
      await app.close();
    }
  }
});

test('withDefinedVariables starts from the loaded entries each time', () => {
  const active = { profile: 'dev', environmentVariables: { a: '1', b: '2' }, diagnostics: [] };
  const first = withDefinedVariables(active, [{ schemaName: 'A' }]);
  assert.deepEqual(first.environmentVariables, { a: '1' });
  const again = withDefinedVariables(first, [{ schemaName: 'a' }, { schemaName: 'b' }]);
  assert.deepEqual(again.environmentVariables, { a: '1', b: '2' });
  assert.deepEqual(again.diagnostics, []);
});
