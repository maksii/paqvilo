import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  bootstrapProject,
  loadProjectConfig,
  observedConfig,
  projectOrigin,
  projectStateFile,
  projectSummary,
} from '../lib/project-config.mjs';
import { makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const execFileAsync = promisify(execFile);

test('inactive-parent permission replay is an explicit site observation requiring evidence', () => {
  assert.throws(() => observedConfig({ tablePermissionOrphans: 'unrestricted' }), /evidence must name/);
  assert.throws(
    () => observedConfig({ tablePermissionOrphans: 'global', evidence: 'Invented observation' }),
    /must be closed or unrestricted/,
  );
  assert.deepEqual(
    observedConfig({ tablePermissionOrphans: 'unrestricted', evidence: 'Invented inactive-parent capture' }),
    { tablePermissionOrphans: 'unrestricted', evidence: 'Invented inactive-parent capture' },
  );
});

async function workspace(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-project-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const dir of ['portals/catalog', 'portals/forms', 'solutions/base', 'solutions/site'])
    await fs.mkdir(path.join(root, dir), { recursive: true });
  // Each portal has a home page: the CLI refuses a source with zero recognised pages.
  for (const portal of ['catalog', 'forms']) {
    await fs.mkdir(path.join(root, 'portals', portal, 'web-pages/home'), { recursive: true });
    await fs.writeFile(
      path.join(root, 'portals', portal, 'web-pages/home/Home.webpage.yml'),
      `adx_webpageid: ${portal}-home\nadx_name: Home\nadx_partialurl: /\n`,
    );
  }
  return root;
}

// Startup diagnostics belong to stderr. Keep stdout as one JSON document. Readiness is the printed JSON, bounded by
// the test's own deadline (t.signal, the suite --test-timeout): CLI startup time depends on machine load, so a short
// fixed wall clock would fail a healthy CLI. Cleanup is bounded so a broken CLI cannot hold the suite open.
function jsonServer(cli, args, { signal, stopTimeout = 30_000 } = {}) {
  const child = spawn(process.execPath, [cli, ...args], {
    cwd: path.dirname(cli),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    signal,
  });
  let stdout = '',
    stderr = '';
  const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdin.on('error', () => {}); // a child may exit just before teardown writes
  const started = new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      try {
        resolve(JSON.parse(stdout));
      } catch {
        /* await complete JSON */
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    // An aborted test deadline kills the child and reports here.
    child.once('error', (error) =>
      reject(new Error(`serve failed: ${error.message}. stderr: ${stderr}; stdout: ${stdout}`)),
    );
    child.once('exit', (code, signal) => {
      reject(new Error(`serve exited ${code ?? signal}: ${stderr}; stdout: ${stdout}`));
    });
  });
  const waitForExit = async () => {
    let timer;
    try {
      return await Promise.race([
        exited.then(() => true),
        new Promise((resolve) => {
          timer = setTimeout(() => resolve(false), stopTimeout);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  return {
    child,
    started,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async stop() {
      if (!child.pid) return;
      if (child.exitCode !== null || child.signalCode !== null) return;
      if (!child.stdin.destroyed) child.stdin.end('stop\n');
      if (await waitForExit()) return;
      child.kill('SIGKILL');
      if (!(await waitForExit())) throw new Error('The owned test CLI did not exit after forced cleanup.');
    },
  };
}

function assertStartupStreams(server) {
  assert.doesNotThrow(() => JSON.parse(server.stdout), 'stdout must remain a standalone JSON document');
  const diagnostics = server.stderr
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert.ok(diagnostics.length > 0, 'runtime startup must report diagnostics on stderr');
  assert.ok(
    diagnostics.every((event) => event.type === 'runtime-startup'),
    server.stderr,
  );
}

test('project config resolves multiple portal and Solution source roots', async (t) => {
  const root = await workspace(t);
  const configPath = path.join(root, 'mirage.project.yml');
  await fs.writeFile(
    configPath,
    [
      'version: 1',
      'defaultPortal: catalog',
      'portals:',
      '  - id: catalog',
      '    path: portals/catalog',
      '  - id: forms',
      '    path: portals/forms',
      'solutions:',
      '  - id: base',
      '    path: solutions/base',
      '  - id: site',
      '    path: solutions/site',
      'references:',
      '  - id: sandbox',
      '    origin: https://example.test',
      '',
    ].join('\n'),
  );
  const project = await loadProjectConfig(configPath);
  assert.deepEqual(
    project.portals.map(({ id }) => id),
    ['catalog', 'forms'],
  );
  assert.deepEqual(
    project.solutions.map(({ id }) => id),
    ['base', 'site'],
  );
  assert.equal(project.solutionRoots[0], await fs.realpath(path.join(root, 'solutions/base')));
  assert.match(project.stateNamespace, /^[a-f0-9]{16}$/);
  // Solution roots are a set layered in dependency order unless solutionOrder: explicit.
  assert.equal(project.solutionOrder, 'derived');
  const otherConfig = path.join(root, 'mirage.other.yml');
  await fs.writeFile(otherConfig, await fs.readFile(configPath, 'utf8'));
  assert.notEqual((await loadProjectConfig(otherConfig)).stateNamespace, project.stateNamespace);
});

test('source-only bootstrap imports each portal against ordered shared solutions', async (t) => {
  const root = await workspace(t);
  const configPath = path.join(root, 'mirage.project.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      portals: ['portals/catalog', 'portals/forms'],
      solutions: ['solutions/base', 'solutions/site'],
    }),
  );
  const project = await loadProjectConfig(configPath);
  const result = await bootstrapProject(project);
  assert.deepEqual(
    result.portals.map(({ id, portal }) => [id, portal.sourceDir]),
    [
      ['portal-1', await fs.realpath(path.join(root, 'portals/catalog'))],
      ['portal-2', await fs.realpath(path.join(root, 'portals/forms'))],
    ],
  );
  assert.equal(result.portals[0].metadata.summary.sources.length, 2);
  assert.equal(result.portals[1].metadata.summary.sources.length, 2);
  assert.equal(result.solutionData.roots.length, 2);
});

test('project inspect CLI reports every configured portal', async (t) => {
  const root = await workspace(t);
  const configPath = path.join(root, 'mirage.project.yml');
  await fs.writeFile(
    configPath,
    ['version: 1', 'portals: [portals/catalog, portals/forms]', 'solutions: [solutions/base, solutions/site]', ''].join(
      '\n',
    ),
  );
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  // Asynchronous, so the test's own deadline (t.signal) can stop a hung CLI; a synchronous call would block it.
  const { stdout } = await execFileAsync(process.execPath, [cli, 'inspect', '--project', configPath, '--json'], {
    encoding: 'utf8',
    signal: t.signal,
    windowsHide: true,
  });
  const result = JSON.parse(stdout);
  assert.deepEqual(
    result.portals.map((portal) => portal.id),
    ['portal-1', 'portal-2'],
  );
  assert.equal(result.portals[0].solutionMetadata.sources.length, 2);
  assert.deepEqual(
    result.portals.map(({ liquidSyntax }) => [liquidSyntax.sourceCount, liquidSyntax.sourceParsePassed]),
    [
      [0, 0],
      [0, 0],
    ],
  );
});

test('project serve CLI starts isolated loopback servers for every portal', async (t) => {
  const root = await workspace(t);
  const configPath = path.join(root, 'mirage.project.yml');
  await fs.writeFile(
    configPath,
    ['version: 1', 'portals: [portals/catalog, portals/forms]', 'solutions: [solutions/base, solutions/site]', ''].join(
      '\n',
    ),
  );
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const server = jsonServer(
    cli,
    ['serve', '--project', configPath, '--state', path.join(root, 'state.json'), '--port', '0', '--no-watch', '--json'],
    { signal: t.signal },
  );
  try {
    const result = await server.started;
    assertStartupStreams(server);
    assert.equal(result.portals.length, 2);
    assert.notEqual(new URL(result.portals[0].url).port, new URL(result.portals[1].url).port);
    // --state FILE gives every portal its own directory, so caches, assets and evidence are not shared.
    assert.deepEqual(
      result.portals.map((portal) => path.relative(root, portal.stateFile)),
      result.portals.map((portal) => path.join(portal.id, 'state.json')),
    );
    assert.equal(new Set(result.portals.map((portal) => path.dirname(portal.stateFile))).size, 2);
    for (const portal of result.portals) {
      const response = await fetch(portal.adminUrl, { signal: t.signal });
      assert.equal(response.status, 200);
      assert.equal(await fs.stat(portal.stateFile).then((stat) => stat.isFile()), true);
    }
  } finally {
    await server.stop();
  }
});

test('invalid source references fail before import', async (t) => {
  const root = await workspace(t);
  const file = path.join(root, 'mirage.project.yml');
  await fs.writeFile(file, 'version: 1\nportals: [missing]\nsolutions: []\n');
  await assert.rejects(loadProjectConfig(file), /Portal 'portal-1' source directory does not exist/);
});

test('project origins reject credentials and non-origin URLs', async (t) => {
  const root = await workspace(t);
  const file = path.join(root, 'mirage.project.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      portals: [{ id: 'catalog', path: 'portals/catalog', origin: 'https://user:secret@example.test/path' }],
    }),
  );
  await assert.rejects(loadProjectConfig(file), /without credentials, path, query, or fragment/);
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 1,
      portals: [{ id: 'catalog', path: 'portals/catalog', origin: 'http://example.test' }],
    }),
  );
  await assert.rejects(loadProjectConfig(file), /must be an HTTPS origin/);
});

test('project configuration v2 selects solutions per portal, references, data packs and runtime options', async (t) => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, 'packs/demo'), { recursive: true });
  await fs.writeFile(path.join(root, 'packs/demo/index.mjs'), "export default { id: 'demo' };\n");
  const configPath = path.join(root, 'mirage.project.yml');
  await fs.writeFile(
    configPath,
    [
      'version: 2',
      'defaultPortal: forms',
      'lcid: 1036',
      'watch: false',
      'solutionOrder: derived',
      'stateDirectory: .state/project',
      'portals:',
      '  - id: catalog',
      '    path: portals/catalog',
      '    solutions: [site, base]',
      '    reference: test',
      '  - id: forms',
      '    path: portals/forms',
      '    origin: https://forms.example.test',
      'solutions:',
      '  - { id: base, path: solutions/base }',
      '  - { id: site, path: solutions/site }',
      'references:',
      '  - { id: dev, name: Development, origin: https://dev.example.test, environment: sandbox, default: true }',
      '  - { id: test, origin: https://test.example.test }',
      'dataPacks:',
      '  - { id: demo, module: packs/demo/index.mjs }',
      'environmentVariables:',
      '  sample_ServiceUrl: https://local.example.test',
      '',
    ].join('\n'),
  );
  const project = await loadProjectConfig(configPath);
  assert.equal(project.version, 2);
  assert.equal(project.lcid, 1036);
  assert.equal(project.watch, false);
  assert.equal(project.solutionOrder, 'derived');
  assert.equal(project.stateDirectory, path.join(root, '.state', 'project'));
  const [catalog, forms] = project.portals;
  assert.deepEqual(catalog.solutions, ['site', 'base']);
  assert.deepEqual(catalog.solutionRoots, [
    await fs.realpath(path.join(root, 'solutions/site')),
    await fs.realpath(path.join(root, 'solutions/base')),
  ]);
  assert.deepEqual(forms.solutions, ['base', 'site']);
  assert.equal(project.defaultReference.id, 'dev');
  assert.equal(projectOrigin(project, catalog), 'https://test.example.test');
  assert.equal(projectOrigin(project, forms), 'https://forms.example.test');
  assert.equal(projectOrigin(project, { origin: null, reference: null }), 'https://dev.example.test');
  assert.deepEqual(project.dataPacks, [{ id: 'demo', module: path.join(root, 'packs', 'demo', 'index.mjs') }]);
  assert.deepEqual(project.environmentVariables, { sample_ServiceUrl: 'https://local.example.test' });
  assert.equal(
    projectStateFile(project, 'catalog', 'C:/default'),
    path.join(root, '.state', 'project', 'catalog', 'state.json'),
  );
  const summary = projectSummary(project, 'catalog');
  assert.equal(summary.portal, 'catalog');
  assert.deepEqual(
    summary.portals.map((portal) => portal.origin),
    ['https://test.example.test', 'https://forms.example.test'],
  );
  assert.equal(summary.defaultReference, 'dev');
  assert.deepEqual(summary.environmentVariables, ['sample_ServiceUrl']);
  const bootstrapped = await bootstrapProject(project);
  assert.deepEqual(
    bootstrapped.portals.map((portal) => portal.solutionData.roots.length),
    [2, 2],
  );
});

test('project configuration v2 rejects unknown keys and inconsistent references', async (t) => {
  const root = await workspace(t);
  const file = path.join(root, 'mirage.project.json');
  const write = (value) =>
    fs.writeFile(
      file,
      JSON.stringify({
        version: 2,
        portals: [{ id: 'catalog', path: 'portals/catalog' }],
        solutions: [{ id: 'base', path: 'solutions/base' }],
        ...value,
      }),
    );
  await write({ unknown: true });
  await assert.rejects(loadProjectConfig(file), /Unknown project configuration key 'unknown'/);
  await write({ portals: [{ id: 'catalog', path: 'portals/catalog', solutions: ['missing'] }] });
  await assert.rejects(loadProjectConfig(file), /selects unknown solution 'missing'/);
  await write({
    references: [
      { id: 'a', origin: 'https://a.test', default: true },
      { id: 'b', origin: 'https://b.test', default: true },
    ],
  });
  await assert.rejects(loadProjectConfig(file), /Only one reference can be the default/);
  await write({ dataPacks: [{ id: 'x', module: 'packs/missing.mjs' }] });
  await assert.rejects(loadProjectConfig(file), /Data pack 'x' module does not exist/);
  await write({ solutionOrder: 'alphabetical' });
  await assert.rejects(loadProjectConfig(file), /solutionOrder must be explicit or derived/);
  await write({ environmentVariables: { sample_x: { nested: true } } });
  await assert.rejects(loadProjectConfig(file), /environmentVariables\.sample_x/);
  // Version 1 files keep loading (unknown keys were never validated there).
  await fs.writeFile(file, JSON.stringify({ version: 1, portals: ['portals/catalog'], extra: 1 }));
  assert.equal((await loadProjectConfig(file)).version, 1);
});

test('project serve exposes the resolved project and falls back to the default reference origin', async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, 'portals/catalog/website.yml'), 'adx_name: Catalog\nadx_websiteid: catalog');
  const configPath = path.join(root, 'mirage.project.yml');
  await fs.writeFile(
    configPath,
    [
      'version: 2',
      'portals: [{ id: catalog, path: portals/catalog }]',
      'solutions: [{ id: base, path: solutions/base }]',
      "references: [{ id: dev, origin: 'https://dev.example.test', default: true }]",
      'stateDirectory: .state',
      '',
    ].join('\n'),
  );
  const cli = fileURLToPath(new URL('../cli.mjs', import.meta.url));
  const server = jsonServer(
    cli,
    ['serve', '--project', configPath, '--portal', 'catalog', '--port', '0', '--no-watch'],
    { signal: t.signal },
  );
  try {
    const result = await server.started;
    assertStartupStreams(server);
    assert.equal(result.stateFile, path.join(root, '.state', 'catalog', 'state.json'));
    const state = await (await fetch(new URL('/__sim/api/state?summary=1', result.url), { signal: t.signal })).json();
    assert.equal(state.status.project.configFile, configPath);
    assert.equal(state.status.project.portal, 'catalog');
    assert.deepEqual(
      state.status.project.solutions.map((solution) => solution.id),
      ['base'],
    );
    assert.equal(state.status.project.defaultReference, 'dev');
    assert.equal(state.config.live.origin, 'https://dev.example.test');
  } finally {
    await server.stop();
  }
});

test('portals record observed site behaviour with its evidence; observations are validated', async (t) => {
  const root = await workspace(t);
  const file = path.join(root, 'mirage.project.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 2,
      portals: [
        {
          id: 'catalog',
          path: 'portals/catalog',
          observed: { loginPath: '/SignIn', evidence: 'parity/live-signin-redirect.json' },
        },
        { id: 'forms', path: 'portals/forms' },
      ],
    }),
  );
  const project = await loadProjectConfig(file);
  assert.deepEqual(
    project.portals.map((portal) => portal.observed),
    [{ loginPath: '/SignIn', evidence: 'parity/live-signin-redirect.json' }, null],
  );
  assert.deepEqual(projectSummary(project, 'catalog').portals[0].observed, {
    loginPath: '/SignIn',
    evidence: 'parity/live-signin-redirect.json',
  });
  assert.equal(observedConfig(undefined), null);
  assert.equal(observedConfig({ evidence: 'only evidence' }), null);
  // Web API and data observations  share the mechanism; absent keys stay absent.
  assert.deepEqual(observedConfig({ webApiInnerError: 'all-errors', evidence: 'fixture/reports/inner-errors.json' }), {
    webApiInnerError: 'all-errors',
    evidence: 'fixture/reports/inner-errors.json',
  });
  assert.deepEqual(observedConfig({ anonymousDataAccess: 'blocked', loginPath: '/SignIn', evidence: 'e' }), {
    loginPath: '/SignIn',
    anonymousDataAccess: 'blocked',
    evidence: 'e',
  });
  assert.throws(
    () => observedConfig({ webApiInnerError: 'some', evidence: 'e' }),
    /observed\.webApiInnerError must be all-errors or dataverse-errors/,
  );
  assert.throws(
    () => observedConfig({ anonymousDataAccess: 'open', evidence: 'e' }),
    /observed\.anonymousDataAccess must be allowed or blocked/,
  );
  assert.deepEqual(observedConfig({ redirect301: 'temporary', evidence: 'fixture/redirect-wire.json' }), {
    redirect301: 'temporary',
    evidence: 'fixture/redirect-wire.json',
  });
  assert.throws(
    () => observedConfig({ redirect301: 'permanent', evidence: 'e' }),
    /observed\.redirect301 must be configured or temporary/,
  );
  assert.throws(
    () => observedConfig({ redirect301: 'temporary' }),
    /observed\.evidence must name the observation behind redirect301/,
  );
  assert.throws(
    () => observedConfig({ webApiInnerError: 'all-errors' }),
    /observed\.evidence must name the observation behind webApiInnerError/,
  );
  // The Web API wildcard exemption (Webapi/<table>/fields = "*") is an observation too.
  assert.deepEqual(observedConfig({ webApiWildcard: 'exempt', evidence: 'fixture/reports/wildcard.json' }), {
    webApiWildcard: 'exempt',
    evidence: 'fixture/reports/wildcard.json',
  });
  assert.deepEqual(observedConfig({ webApiWildcard: 'enforced', evidence: 'e' }), {
    webApiWildcard: 'enforced',
    evidence: 'e',
  });
  assert.throws(
    () => observedConfig({ webApiWildcard: 'allowed', evidence: 'e' }),
    /observed\.webApiWildcard must be enforced or exempt/,
  );
  assert.throws(
    () => observedConfig({ webApiWildcard: 'exempt' }),
    /observed\.evidence must name the observation behind webApiWildcard/,
  );
  // Response headers the platform adds per kind (page, webFile); names are lower-cased.
  assert.deepEqual(
    observedConfig({
      headers: {
        page: { 'X-Content-Type-Options': 'nosniff' },
        webFile: { 'access-control-allow-origin': ' https://app.powerbi.com ' },
      },
      evidence: 'wave3/report.json',
    }),
    {
      headers: {
        page: { 'x-content-type-options': 'nosniff' },
        webFile: { 'access-control-allow-origin': 'https://app.powerbi.com' },
      },
      evidence: 'wave3/report.json',
    },
  );
  assert.equal(observedConfig({ headers: { page: {} }, evidence: 'e' }), null);
  assert.throws(
    () => observedConfig({ headers: { api: { a: 'b' } }, evidence: 'e' }),
    /observed\.headers\.api must be page, webFile or webApi/,
  );
  assert.deepEqual(
    observedConfig({
      headers: { webApi: { 'Cache-Control': 'no-cache, no-store, must-revalidate' } },
      webApiCdsErrorMessage: 'Common Data Service error occurred.',
      webApiAntiForgery: 'decryption-401',
      webApiReferenceErrors: 'unexpected',
      evidence: 'loopback-fixture',
    }),
    {
      headers: { webApi: { 'cache-control': 'no-cache, no-store, must-revalidate' } },
      webApiCdsErrorMessage: 'Common Data Service error occurred.',
      webApiAntiForgery: 'decryption-401',
      webApiReferenceErrors: 'unexpected',
      evidence: 'loopback-fixture',
    },
  );
  assert.throws(() => observedConfig({ webApiAntiForgery: 'any', evidence: 'e' }), /observed.webApiAntiForgery/);
  assert.throws(() => observedConfig({ webApiReferenceErrors: 'unexpected' }), /evidence/);
  assert.throws(() => observedConfig({ webApiInvalidDate: 'crm-minimum' }), /evidence/);
  assert.equal(
    observedConfig({ webApiInvalidDate: 'crm-minimum', evidence: 'loopback' }).webApiInvalidDate,
    'crm-minimum',
  );
  assert.throws(() => observedConfig({ liquidDecimalStringMultiply: 'convert' }), /evidence/);
  assert.equal(
    observedConfig({ liquidDecimalStringMultiply: 'convert', evidence: 'loopback/math.json' })
      .liquidDecimalStringMultiply,
    'convert',
  );
  assert.throws(
    () => observedConfig({ liquidDecimalStringMultiply: 'coerce', evidence: 'loopback' }),
    /liquidDecimalStringMultiply must be dotliquid or convert/,
  );
  assert.throws(() => observedConfig({ liquidTimesDispatch: 'observed' }), /evidence/);
  assert.equal(
    observedConfig({ liquidTimesDispatch: 'observed', evidence: 'loopback/dispatch.json' }).liquidTimesDispatch,
    'observed',
  );
  assert.throws(
    () => observedConfig({ liquidTimesDispatch: 'any', evidence: 'loopback' }),
    /liquidTimesDispatch must be dotliquid or observed/,
  );
  for (const [key, value] of Object.entries({
    siteMarkerRedirect: 'null-reference',
    webTemplateResponseNewline: 'crlf',
    webFileMimeCharset: 'source',
    liquidFilterErrors: 'observed',
    liquidFilterRegistration: 'observed',
    liquidServiceTags: 'observed',
    liquidObjectCompatibility: 'observed',
    liquidHtmlVoidSerialization: 'html',
    liquidHtmlSafeInput: 'observed',
    liquidPathAndQueryFragment: 'query',
    liquidRuntimeCompatibility: 'observed',
    liquidEditableMetadata: 'observed',
    liquidMissingData: 'empty',
  })) {
    assert.throws(() => observedConfig({ [key]: value }), /evidence/);
    assert.equal(observedConfig({ [key]: value, evidence: 'loopback/observations.json' })[key], value);
    assert.throws(() => observedConfig({ [key]: 'unverified', evidence: 'loopback' }), new RegExp(key));
  }
  assert.throws(
    () => observedConfig({ headers: { page: { 'bad name': 'x' } }, evidence: 'e' }),
    /must be a header name with a one-line value/,
  );
  assert.throws(
    () => observedConfig({ headers: { page: { 'x-a': 'line\nbreak' } }, evidence: 'e' }),
    /must be a header name with a one-line value/,
  );
  assert.throws(
    () => observedConfig({ headers: { page: { 'x-a': 'b' } } }),
    /observed\.evidence must name the observation behind headers/,
  );
  // The built-in Microsoft Entra provider's authority seen on the site (external sign-in).
  assert.deepEqual(
    observedConfig({
      azureAdAuthority: ' https://login.windows.net/0f0f0f0f-1111-4222-8333-444444444444/ ',
      evidence: 'signin-chain/summary.json',
    }),
    {
      azureAdAuthority: 'https://login.windows.net/0f0f0f0f-1111-4222-8333-444444444444/',
      evidence: 'signin-chain/summary.json',
    },
  );
  assert.deepEqual(
    observedConfig({
      azureAdAuthority: 'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0',
      evidence: 'e',
    }).azureAdAuthority,
    'https://login.microsoftonline.com/contoso.onmicrosoft.com/v2.0',
  );
  // An observation names one tenant: placeholders and the multi-tenant endpoints are rejected.
  for (const authority of [
    'https://login.windows.net/{tenant}/',
    'https://login.windows.net/<tenant>/',
    'https://login.windows.net/common/',
    'https://login.microsoftonline.com/organizations/',
    'https://login.windows.net/0f0f0f0f-1111-4222-8333/',
    'https://login.windows.net/',
    'https://evil.example/0f0f0f0f-1111-4222-8333-444444444444/',
  ])
    assert.throws(
      () => observedConfig({ azureAdAuthority: authority, evidence: 'e' }),
      /observed\.azureAdAuthority must be the observed Microsoft Entra authority of one tenant/,
      authority,
    );
  assert.throws(() => observedConfig({ loginPath: '/SignIn' }), /observed\.evidence must name the observation/);
  assert.throws(() => observedConfig({ loginPath: '//evil.example/SignIn', evidence: 'x' }), /site-relative path/);
  assert.throws(
    () => observedConfig({ loginPath: '/SignIn', evidence: 'x', casing: 'upper' }),
    /Unknown observed key 'casing'/,
  );
  assert.throws(() => observedConfig(['/SignIn'], 'portals[0].observed'), /portals\[0\]\.observed must be an object/);
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 2,
      portals: [{ id: 'catalog', path: 'portals/catalog', observed: { loginPath: 'SignIn', evidence: 'x' } }],
    }),
  );
  await assert.rejects(loadProjectConfig(file), /portals\[0\]\.observed\.loginPath must be a site-relative path/);
});

test("observed portalApplicationUser keeps the application user's display name and rejects an empty one", () => {
  assert.equal(
    observedConfig({ portalApplicationUser: ' # Portal app ', evidence: 'invented notes response' })
      .portalApplicationUser,
    '# Portal app',
  );
  assert.throws(() => observedConfig({ portalApplicationUser: ' ', evidence: 'invented' }), /portalApplicationUser/);
  assert.equal(
    observedConfig({ portalApplicationUserId: '{00000000-0000-4000-8000-0000000000AA}', evidence: 'invented' })
      .portalApplicationUserId,
    '00000000-0000-4000-8000-0000000000aa',
  );
  assert.throws(
    () => observedConfig({ portalApplicationUserId: 'app', evidence: 'invented' }),
    /portalApplicationUserId/,
  );
});

test('observed listODataFeeds names whether the site still serves list OData feeds', () => {
  assert.equal(
    observedConfig({ listODataFeeds: 'served', evidence: 'Invented feed capture' }).listODataFeeds,
    'served',
  );
  assert.equal(
    observedConfig({ listODataFeeds: 'removed', evidence: 'Invented feed capture' }).listODataFeeds,
    'removed',
  );
  assert.throws(() => observedConfig({ listODataFeeds: 'maybe', evidence: 'Invented feed capture' }), /listODataFeeds/);
});
