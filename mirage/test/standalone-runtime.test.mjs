import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSimulator } from '../server.mjs';
import { loadProjectConfig, projectSummary } from '../lib/project-config.mjs';
import { writeSolutionAssetEntries } from '../lib/dataverse-solution-assets.mjs';
import { readLocalFile } from '../../lense/local-file.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const APP = '77777777-7777-4777-8777-777777777777';
const CLIENT = '99999999-9999-4999-8999-999999999999';

// Arc proves access to a fresh local challenge file. Keep that intentional
// file-to-Authorization protocol visible while confining both ends to this test.
function identityEndpoint(api, mode, params) {
  const origin = new URL(api.origin),
    port = Number(origin.port);
  if (
    !['appservice', 'imds', 'arc'].includes(mode) ||
    origin.protocol !== 'http:' ||
    origin.hostname !== '127.0.0.1' ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535 ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash ||
    !api.servers.some(
      (server) => server.listening && server.address()?.address === '127.0.0.1' && server.address().port === port,
    )
  )
    throw new Error('Identity requests require the exact owned HTTP loopback listener.');
  const endpoint = new URL(
    mode === 'appservice' ? '/msi/token' : '/metadata/identity/oauth2/token',
    `http://127.0.0.1:${port}`,
  );
  endpoint.search = params.toString();
  return endpoint.href;
}
const requestIdentity = (endpoint, headers) => fetch(endpoint, { headers, redirect: 'error' });

async function ownedArcChallenge(header, root) {
  const prefix = 'Basic realm=';
  if (typeof header !== 'string' || !header.startsWith(prefix))
    throw new Error('Expected an Arc Basic realm challenge.');
  const file = header.slice(prefix.length),
    directory = path.resolve(root, '.paqvilo', 'mirage');
  if (
    !path.isAbsolute(file) ||
    path.dirname(path.resolve(file)) !== directory ||
    !/^identity-[a-f0-9]{12}\.key$/.test(path.basename(file))
  )
    throw new Error('Arc challenge must name a direct file in the exact owned identity directory.');
  const canonicalRoot = await fs.realpath(root),
    canonicalDirectory = await fs.realpath(directory),
    canonicalFile = await fs.realpath(file);
  if (
    canonicalDirectory !== path.join(canonicalRoot, '.paqvilo', 'mirage') ||
    canonicalFile !== path.join(canonicalDirectory, path.basename(file))
  )
    throw new Error('Arc challenge escaped the owned directory through a link.');
  return { file, directory: canonicalDirectory };
}

async function readOwnedArcSecret(challenge) {
  const secret = await readLocalFile(challenge.file, { root: challenge.directory, maxBytes: 64, encoding: 'utf8' });
  if (!/^[a-f0-9]{64}$/.test(secret))
    throw new Error('Arc challenge must contain exactly the generated 64 hexadecimal characters.');
  return secret;
}
// Writes the invented Solution only; tests that start their own runtime (or CLI) need no fixture runtime.
async function solutionSources(t, sourceOverrides = {}) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-organization-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution');
  const files = {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedStandalone</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'Entities/x_item/Entity.xml':
      '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type><RequiredLevel>required</RequiredLevel><displaynames><displayname description="Name" languagecode="1033"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>',
    'AppModules/x_workspace/AppModule.xml': `<AppModule><UniqueName>x_workspace</UniqueName><AppModuleId>{${APP}}</AppModuleId><LocalizedNames><LocalizedName description="Standalone workspace" languagecode="1033"/></LocalizedNames><AppModuleComponents><AppModuleComponent type="1" schemaName="x_item"/></AppModuleComponents></AppModule>`,
  };
  Object.assign(files, sourceOverrides);
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(solution, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  return { root, solution, files };
}
async function fixture(t, options, sourceOverrides) {
  const { root, solution, files } = await solutionSources(t, sourceOverrides);
  const stateFile = path.join(root, 'must-not-be-written.json');
  const sim = await createSimulator({
    solutionRoots: [solution],
    stateFile,
    projectRoot: root,
    watch: false,
    simulation: { level: 'dry-run' },
    ...options,
  });
  ownedFixture(t).add(() => sim.close());
  return { sim, root, solution, stateFile, files };
}
async function body(response, status = 200) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return text ? JSON.parse(text) : null;
}
const ui = (sim, method, suffix = '', values, etag) =>
  fetch(sim.url + '/_apps/api' + suffix, {
    method,
    headers: {
      'x-sim-csrf': sim.csrf,
      ...(values ? { 'content-type': 'application/json' } : {}),
      ...(etag ? { 'if-match': etag } : {}),
    },
    ...(values ? { body: JSON.stringify(values) } : {}),
  });
async function client(sim) {
  const registration = await body(
    await fetch(sim.url + '/_sim/api/dataverse/applications', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: JSON.stringify({
        appId: CLIENT,
        displayName: 'Invented standalone client',
        roles: ['System Administrator'],
      }),
    }),
    201,
  );
  const token = await body(
    await fetch(sim.dataverse.authority + '/oauth2/v2.0/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: CLIENT,
        client_secret: registration.secret,
        scope: sim.dataverse.origin + '/.default',
      }),
    }),
  );
  return (method, suffix, values) =>
    fetch(sim.dataverse.origin + '/api/data/v9.2' + suffix, {
      method,
      headers: {
        authorization: `Bearer ${token.access_token}`,
        ...(values ? { 'content-type': 'application/json', prefer: 'return=representation' } : {}),
      },
      ...(values ? { body: JSON.stringify(values) } : {}),
    });
}

test('solution-only model-driven runtime uses its organization core with HTTP API disabled and no portal source', async (t) => {
  const { sim, root, solution, stateFile, files } = await fixture(t, {
    runtime: { kind: 'model-driven', defaultApp: APP },
  });
  assert.equal(sim.dataverse, undefined);
  assert.equal((await fetch(sim.url + '/main.aspx')).status, 200);
  const catalogue = await body(await ui(sim, 'GET'));
  assert.equal(catalogue.defaultApp, APP);
  assert.equal(catalogue.apps.length, 1);
  assert.equal(
    Object.keys(catalogue.tables).some((name) => /^(adx_|mspp_)/.test(name)),
    false,
  );
  const record = await body(await ui(sim, 'POST', '/tables/x_item', { x_name: 'Created without a portal' }), 201);
  const changed = await body(
    await ui(sim, 'PATCH', `/tables/x_item/${record.row.x_itemid}`, { x_name: 'Edited' }, record.etag),
  );
  assert.equal(changed.row.x_name, 'Edited');
  await body(await ui(sim, 'DELETE', `/tables/x_item/${record.row.x_itemid}`, undefined, changed.etag));
  assert.equal((await fetch(sim.url + '/_api/x_items')).status, 404);
  const status = await body(await fetch(sim.url + '/_sim/api/status'));
  assert.equal(status.capabilities.organization, true);
  assert.equal(status.capabilities.dataverseApi, false);
  assert.equal(status.links.powerPages, null);
  assert.equal(status.simulation.recordPersistence, 'memory');
  assert.equal((await fetch(sim.url + '/_sim/api/dataverse/session')).status, 200);
  const summary = await body(await fetch(sim.url + '/_sim/api/state'));
  assert.equal(summary.summaryMode, true);
  assert.equal(Object.hasOwn(summary, 'data'), false);
  assert.ok(summary.mappings.some((mapping) => mapping.logicalName === 'x_item'));
  // Follow real module imports: a successful shell alone does not prove the browser can start.
  const visited = new Set(),
    pending = ['/__sim/app.mjs'];
  while (pending.length) {
    const pathname = pending.shift();
    if (visited.has(pathname)) continue;
    visited.add(pathname);
    const response = await fetch(sim.url + pathname);
    assert.equal(response.status, 200, pathname);
    assert.match(response.headers.get('content-type'), /javascript/);
    const source = await response.text();
    for (const match of source.matchAll(/(?:from\s*|import\s*)['"](\.\/[^'"]+\.mjs)['"]/g))
      pending.push(new URL(match[1], sim.url + pathname).pathname);
  }
  assert.ok(visited.has('/__sim/persona-search.mjs'));
  assert.ok(visited.has('/__sim/persona-picker-view.mjs'));
  await assert.rejects(fs.stat(stateFile), { code: 'ENOENT' });
  assert.deepEqual((await fs.readdir(root)).sort(), ['solution']);
  for (const [relative, content] of Object.entries(files))
    assert.equal(await fs.readFile(path.join(solution, relative), 'utf8'), content);
});

test('solution-only API and model-driven surfaces share actual organization CRUD', async (t) => {
  const { sim } = await fixture(t, {
    runtime: { kind: 'model-driven' },
    dataverse: { enabled: true, tls: false, tds: { enabled: false } },
  });
  const org = await client(sim);
  const created = await body(await org('POST', '/x_items', { x_name: 'Organization row' }), 201);
  const row = await body(await ui(sim, 'GET', `/tables/x_item/${created.x_itemid}`));
  assert.equal(row.row.x_name, 'Organization row');
  await body(await ui(sim, 'PATCH', `/tables/x_item/${created.x_itemid}`, { x_name: 'Shell edit' }, row.etag));
  assert.equal((await body(await org('GET', `/x_items(${created.x_itemid})`))).x_name, 'Shell edit');
});

test('solution-only API runtime exposes administration and organization API without a model-driven or portal renderer', async (t) => {
  const { sim } = await fixture(t, {
    runtime: { kind: 'dataverse-api' },
    dataverse: { tls: false, tds: { enabled: false } },
  });
  assert.equal((await fetch(sim.url + '/main.aspx')).status, 404);
  assert.equal((await fetch(sim.url + '/_apps/api')).status, 404);
  assert.equal((await fetch(sim.url + '/_sim/')).status, 200);
  const org = await client(sim);
  const row = await body(await org('POST', '/x_items', { x_name: 'API only' }), 201);
  assert.equal((await body(await org('GET', `/x_items(${row.x_itemid})`))).x_name, 'API only');
});

test('JSON groups with a later external predecessor roll back creates, updates, versions and tracking', async (t) => {
  const { sim } = await fixture(t, {
    runtime: { kind: 'dataverse-api' },
    dataverse: { tls: false, tds: { enabled: false } },
  });
  const org = await client(sim),
    created = await body(await org('POST', '/x_items', { x_name: 'Original' }), 201);
  const before = await body(await org('GET', `/x_items(${created.x_itemid})`));
  const tracking = await sim.organization.changes.since('x_item', 0),
    version = sim.store.state.rowVersion;
  const batch = await org('POST', '/$batch', {
    requests: [
      { id: 'create', method: 'POST', url: 'x_items', atomicityGroup: 'g', body: { x_name: 'Must roll back' } },
      {
        id: 'update',
        method: 'PATCH',
        url: `x_items(${created.x_itemid})`,
        atomicityGroup: 'g',
        body: { x_name: 'Must roll back' },
      },
      {
        id: 'fail',
        method: 'POST',
        url: 'x_items',
        atomicityGroup: 'g',
        dependsOn: ['external'],
        body: { unknown: true },
      },
      { id: 'external', method: 'GET', url: 'WhoAmI' },
    ],
  });
  assert.equal(batch.status, 400, await batch.text());
  assert.deepEqual(await body(await org('GET', `/x_items(${created.x_itemid})`)), before);
  assert.deepEqual(
    (await body(await org('GET', '/x_items'))).value.map((row) => row.x_name),
    ['Original'],
  );
  assert.equal(sim.store.state.rowVersion, version);
  assert.deepEqual(await sim.organization.changes.since('x_item', 0), tracking);
});

test('standalone validation responses agree with the documented payload and query codes', async (t) => {
  const { sim } = await fixture(t, {
    runtime: { kind: 'dataverse-api' },
    dataverse: { tls: false, tds: { enabled: false } },
  });
  const org = await client(sim),
    documentation = await fs.readFile(new URL('../docs/dataverse-api.md', import.meta.url), 'utf8');
  const payload = await body(await org('POST', '/x_items', { unknown: true }), 400);
  assert.equal(payload.error.code, '0x80048d19');
  assert.ok(documentation.includes('`0x80048d19`'));
  assert.ok(documentation.includes('`0x80060888`'));
  for (const query of ['$select=unknown', "$filter=unknown eq 'x'", '$orderby=unknown', '$expand=unknown']) {
    const result = await body(await org('GET', '/x_items?' + query), 400);
    assert.equal(result.error.code, '0x80060888', query);
  }
});

test('project platform settings need evidence, known keys and in-range values', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-platform-config-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'project.json'),
    solution = path.join(root, 'solution');
  await fs.mkdir(solution);
  const config = {
    version: 2,
    runtime: { kind: 'dataverse-api' },
    solutions: [{ id: 'schema', path: solution }],
    platform: { QueryLinkEntityLimit: 1, evidence: 'Invented organization limit' },
  };
  await fs.writeFile(file, JSON.stringify(config));
  const project = await loadProjectConfig(file);
  assert.deepEqual(projectSummary(project).platform, config.platform);
  assert.deepEqual(project.platform, config.platform);
  for (const [platform, message] of [
    [{ QueryLinkEntityLimit: 0, evidence: 'Invalid' }, /QueryLinkEntityLimit/],
    [{ QueryLinkEntityLimit: 50 }, /evidence/],
    [{ unknown: 1, evidence: 'Invalid' }, /unknown/],
  ]) {
    await fs.writeFile(file, JSON.stringify({ ...config, platform }));
    await assert.rejects(loadProjectConfig(file), message);
  }
});

for (const kind of ['dataverse-api', 'model-driven'])
  test(`${kind} root platform configuration is retained, enforced and exposed through public administration`, async (t) => {
    const { sim } = await fixture(t, {
      runtime: { kind },
      dataverse: { enabled: true, tls: false, tds: { enabled: false } },
      platform: { QueryLinkEntityLimit: 1, evidence: 'Invented organization limit' },
    });
    const config = { platform: { QueryLinkEntityLimit: 1, evidence: 'Invented organization limit' } };
    const org = await client(sim);
    const xml =
      '<fetch><entity name="x_item"><attribute name="x_itemid"/><link-entity name="x_item" alias="a" from="x_itemid" to="x_itemid"/><link-entity name="x_item" alias="b" from="x_itemid" to="x_itemid"/></entity></fetch>';
    assert.equal((await org('GET', '/x_items?fetchXml=' + encodeURIComponent(xml))).status, 400);
    const admin = async (method = 'GET', suffix = '', values) =>
      body(
        await fetch(sim.url + '/_sim/api/platform-settings' + suffix, {
          method,
          headers: { 'x-sim-csrf': sim.csrf, 'content-type': 'application/json' },
          ...(values ? { body: JSON.stringify(values) } : {}),
        }),
      );
    assert.equal(
      (await admin()).find((item) => item.key === 'QueryLinkEntityLimit').configuredEvidence,
      config.platform.evidence,
    );
    await admin('PATCH', '', { QueryLinkEntityLimit: 50 });
    assert.equal((await org('GET', '/x_items?fetchXml=' + encodeURIComponent(xml))).status, 200);
    await admin('DELETE', '/QueryLinkEntityLimit');
    assert.equal((await admin()).find((item) => item.key === 'QueryLinkEntityLimit').value, 1);
    assert.equal(sim.status().platformSettings.find((item) => item.key === 'QueryLinkEntityLimit').value, 1);
  });

test('standalone project CLI forwards organization platform settings into the actual query runtime', async (t) => {
  const { root, solution } = await solutionSources(t);
  const file = path.join(root, 'cli-project.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      version: 2,
      runtime: { kind: 'dataverse-api' },
      solutions: [{ id: 'schema', path: solution }],
      dataverse: { tls: false, tds: { enabled: false } },
      platform: { QueryLinkEntityLimit: 1, evidence: 'Invented CLI organization' },
    }),
  );
  const toolkitRoot = fileURLToPath(new URL('../..', import.meta.url)),
    cli = fileURLToPath(new URL('../../bin/paqvilo.mjs', import.meta.url));
  const child = spawn(
    process.execPath,
    [
      cli,
      'mirage',
      'serve',
      '--project',
      file,
      '--port',
      '0',
      '--state',
      path.join(root, 'cli-state.json'),
      '--no-watch',
      '--json',
    ],
    { cwd: toolkitRoot, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
  );
  const exited = new Promise((resolve) => child.once('exit', resolve));
  // Stop the CLI (which holds its state file) before the owned directory is removed.
  ownedFixture(t).add(async () => {
    if (child.exitCode === null) {
      child.stdin.write('stop\n');
      // Bounded fallback for a CLI that ignores the documented stdin stop command.
      const timer = setTimeout(() => child.kill(), 10000);
      await exited;
      clearTimeout(timer);
    }
  });
  // Startup settles on the ready report or the child's failure; no wall-clock bound below the test's own timeout,
  // since importing and starting the runtime on a loaded runner has no documented startup budget.
  const started = await new Promise((resolve, reject) => {
    let stdout = '',
      stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      try {
        const report = JSON.parse(stdout);
        if (report.url) resolve(report);
      } catch {
        /* await complete JSON */
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Standalone CLI exited ${code}: ${stderr}`)));
  });
  const status = await body(await fetch(started.url + '/_sim/api/status'));
  assert.equal(status.platformSettings.find((item) => item.key === 'QueryLinkEntityLimit').value, 1);
  const org = await client({
    url: started.url,
    dataverse: status.dataverse,
    csrf: status.csrf,
    state: () => ({ csrf: status.csrf }),
  });
  const xml =
    '<fetch><entity name="x_item"><link-entity name="x_item" alias="a" from="x_itemid" to="x_itemid"/><link-entity name="x_item" alias="b" from="x_itemid" to="x_itemid"/></entity></fetch>';
  assert.equal((await org('GET', '/x_items?fetchXml=' + encodeURIComponent(xml))).status, 400);
});

for (const kind of ['dataverse-api', 'model-driven'])
  for (const mode of ['appservice', 'imds', 'arc'])
    test(`${kind} composes ${mode} managed identity and cleans unused challenges`, async (t) => {
      const { sim, root } = await fixture(t, {
        runtime: { kind },
        dataverse: {
          enabled: true,
          tls: false,
          tds: { enabled: false },
          managedIdentity: kind === 'dataverse-api' && mode === 'appservice' ? undefined : { mode },
          managedIdentities: [
            { clientId: CLIENT, displayName: 'Invented managed identity', roles: ['System Administrator'] },
          ],
        },
      });
      const listing = await body(await fetch(sim.url + '/_sim/api/dataverse'));
      const info = listing.managedIdentity;
      assert.equal(info.mode, mode);
      assert.equal(info.enabled, true);
      assert.equal(sim.status().dataverse.managedIdentity.header, null);
      assert.equal((await body(await fetch(sim.url + '/_sim/api/dataverse'))).managedIdentity.header, null);
      const params = new URLSearchParams({ resource: sim.dataverse.origin, 'api-version': '2019-08-01' });
      const endpoint = identityEndpoint(sim.dataverse, mode, params);
      const headers = mode === 'appservice' ? { 'x-identity-header': info.header } : { metadata: 'true' };
      let response = await requestIdentity(endpoint, headers);
      if (mode === 'arc') {
        assert.equal(response.status, 401);
        const challenge = await ownedArcChallenge(response.headers.get('www-authenticate'), root);
        response = await requestIdentity(endpoint, {
          ...headers,
          authorization: 'Basic ' + (await readOwnedArcSecret(challenge)),
        });
        await assert.rejects(fs.stat(challenge.file), { code: 'ENOENT' });
      }
      const token = await body(response);
      assert.equal(
        (
          await fetch(sim.dataverse.origin + '/api/data/v9.2/x_items', {
            headers: { authorization: 'Bearer ' + token.access_token },
          })
        ).status,
        200,
      );
      if (kind === 'dataverse-api' && mode === 'appservice') {
        const restricted = await body(
          await fetch(sim.url + '/_sim/api/dataverse/managed-identities', {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
            body: JSON.stringify({ displayName: 'Restricted identity', roles: [] }),
          }),
          201,
        );
        const limitedToken = await body(await requestIdentity(endpoint + '&client_id=' + restricted.clientId, headers));
        assert.equal(
          (
            await fetch(sim.dataverse.origin + '/api/data/v9.2/x_items', {
              headers: { authorization: 'Bearer ' + limitedToken.access_token },
            })
          ).status,
          403,
        );
      }
      if (mode === 'arc') {
        const unused = await requestIdentity(endpoint, headers);
        const { file } = await ownedArcChallenge(unused.headers.get('www-authenticate'), root);
        await fs.stat(file);
        await sim.close();
        await assert.rejects(fs.stat(file), { code: 'ENOENT' });
      }
    });

test('independent client directory and ZIP sources reload without changing complete organization metadata', async (t) => {
  const { root, solution } = await solutionSources(t);
  const clientRoot = path.join(root, 'external-clients'),
    archive = path.join(root, 'external.zip');
  await fs.mkdir(path.join(clientRoot, 'WebResources'), { recursive: true });
  const descriptor = (name, file) =>
    `<WebResource><Name>${name}</Name><WebResourceType>3</WebResourceType><FileName>${file}</FileName></WebResource>`;
  await fs.writeFile(path.join(clientRoot, 'WebResources/events.js'), 'window.External = 1;');
  await fs.writeFile(
    path.join(clientRoot, 'WebResources/events.js.data.xml'),
    descriptor('x_/external.js', 'WebResources/events.js'),
  );
  const zip = (value) =>
    writeSolutionAssetEntries([
      {
        name: 'customizations.xml',
        data: Buffer.from(
          `<ImportExportXml><WebResources>${descriptor('x_/archive.js', 'WebResources/archive.js')}</WebResources></ImportExportXml>`,
        ),
      },
      { name: 'WebResources/archive.js', data: Buffer.from(`window.Archive = ${value};`) },
    ]);
  await fs.writeFile(archive, zip(1));
  const sim = await createSimulator({
    runtime: { kind: 'model-driven' },
    solutionRoots: [solution],
    projectRoot: root,
    simulation: { level: 'dry-run' },
    modelDriven: { trustedExtensions: true, clientSources: [clientRoot, archive] },
    watch: true,
  });
  // The watcher closes before the owned directory is removed; t.after hooks run in registration order.
  ownedFixture(t).add(() => sim.close());
  const catalogue = await body(await ui(sim, 'GET'));
  assert.ok(catalogue.tables.x_item);
  const urls = Object.fromEntries(
    catalogue.clientExtensions.resources.map((resource) => [resource.name, sim.url + resource.url]),
  );
  const selectedSource = async (url) => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    const text = await response.text();
    if (url === urls['x_/archive.js']) {
      assert.doesNotMatch(text, /sourceMappingURL=/, 'a ZIP resource has no editable physical file');
      return text;
    }
    const encoded = /sourceMappingURL=data:application\/json;charset=utf-8;base64,([\w+/=]+)/.exec(text)?.[1];
    assert.ok(encoded, 'an external file-backed client retains debugger metadata after reload');
    const map = JSON.parse(Buffer.from(encoded, 'base64').toString());
    assert.deepEqual(map.sources, [
      pathToFileURL(await fs.realpath(path.join(clientRoot, 'WebResources/events.js'))).href,
    ]);
    assert.ok(text.startsWith(map.sourcesContent[0]));
    return map.sourcesContent[0];
  };
  assert.equal(await selectedSource(urls['x_/external.js']), 'window.External = 1;');
  assert.equal(await selectedSource(urls['x_/archive.js']), 'window.Archive = 1;');
  const changed = async (url, expected) => {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if ((await selectedSource(url)) === expected) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.fail('Selected client source was not reloaded: ' + expected);
  };
  await fs.writeFile(path.join(clientRoot, 'WebResources/events.js'), 'window.External = 2;');
  await changed(urls['x_/external.js'], 'window.External = 2;');
  await fs.writeFile(archive, zip(2));
  await changed(urls['x_/archive.js'], 'window.Archive = 2;');
  assert.ok((await body(await ui(sim, 'GET'))).tables.x_item);
});

test('selected Dataverse locale reaches source apps, navigation, forms, views and canonical source rows', async (t) => {
  const FORM = '55555555-5555-4555-8555-555555555555',
    VIEW = '66666666-6666-4666-8666-666666666666';
  const labels = (en, fr) =>
    `<LocalizedNames><LocalizedName languagecode="1033" description="${en}"/><LocalizedName languagecode="1036" description="${fr}"/></LocalizedNames>`;
  const titles = (en, fr) => `<Titles><Title LCID="1033" Title="${en}"/><Title LCID="1036" Title="${fr}"/></Titles>`;
  const { sim, solution, files } = await fixture(
    t,
    {
      runtime: { kind: 'model-driven' },
      dataverse: { enabled: true, tls: false, localeId: 1036, tds: { enabled: false } },
    },
    {
      'Entities/x_item/Entity.xml': `<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item">${labels('Item', 'Article')}<EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type><RequiredLevel>required</RequiredLevel><displaynames><displayname description="Name" languagecode="1033"/><displayname description="Nom" languagecode="1036"/></displaynames></attribute></attributes></entity></EntityInfo></Entity>`,
      'AppModules/x_workspace/AppModule.xml': `<AppModule><UniqueName>x_workspace</UniqueName><AppModuleId>${APP}</AppModuleId>${labels('Workspace', 'Espace')}<SiteMap><Area Id="main">${titles('Main', 'Principal')}<Group Id="work">${titles('Work', 'Travail')}<SubArea Id="items" Entity="x_item">${titles('Items', 'Articles')}</SubArea></Group></Area></SiteMap></AppModule>`,
      'Entities/x_item/FormXml/main/item.xml': `<systemform><formid>${FORM}</formid><type>2</type>${labels('Information', 'Informations')}<form><tabs><tab name="general"><columns><column><sections><section><rows><row><cell><control datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform>`,
      'Entities/x_item/SavedQueries/items.xml': `<savedquery><savedqueryid>${VIEW}</savedqueryid><querytype>0</querytype>${labels('Active items', 'Articles actifs')}<fetchxml><fetch><entity name="x_item"><attribute name="x_name"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="x_name" width="200"/></row></grid></layoutxml></savedquery>`,
    },
  );
  const catalogue = await body(await ui(sim, 'GET'));
  assert.equal(catalogue.apps[0].name, 'Espace');
  assert.equal(catalogue.apps[0].navigation[0].title, 'Principal');
  assert.equal(catalogue.apps[0].navigation[0].groups[0].title, 'Travail');
  assert.equal(catalogue.apps[0].navigation[0].groups[0].items[0].title, 'Articles');
  assert.equal(catalogue.tables.x_item.forms[0].name, 'Informations');
  assert.equal(Object.hasOwn(catalogue.tables.x_item.forms[0].tabs[0].sections[0].fields[0], 'reason'), false);
  assert.equal(catalogue.tables.x_item.views[0].name, 'Articles actifs');
  const org = await client(sim);
  const entity = await body(await org('GET', "/EntityDefinitions(LogicalName='x_item')?$select=DisplayName"));
  assert.equal(entity.DisplayName.UserLocalizedLabel.Label, 'Article');
  assert.equal(entity.DisplayName.UserLocalizedLabel.LanguageCode, 1036);
  const attribute = await body(
    await org('GET', "/EntityDefinitions(LogicalName='x_item')/Attributes(LogicalName='x_name')?$select=DisplayName"),
  );
  assert.equal(attribute.DisplayName.UserLocalizedLabel.Label, 'Nom');
  assert.equal(attribute.DisplayName.UserLocalizedLabel.LanguageCode, 1036);
  assert.equal((await body(await org('GET', `/appmodules(${APP})?$select=name`))).name, 'Espace');
  assert.equal((await body(await org('GET', `/systemforms(${FORM})?$select=name`))).name, 'Informations');
  assert.equal((await body(await org('GET', `/savedqueries(${VIEW})?$select=name`))).name, 'Articles actifs');
  await body(await org('PATCH', `/appmodules(${APP})`, { name: 'Locally renamed' }));
  assert.equal((await body(await ui(sim, 'GET'))).apps[0].name, 'Locally renamed');
  await body(
    await org('PATCH', `/systemforms(${FORM})`, {
      formxml:
        '<form><tabs><tab><columns><column><sections><section><rows><row><cell><control datafieldname="x_name"/></cell><cell><control datafieldname="x_missing"/></cell><cell><control id="unsupported"/></cell></row></rows></section></sections></column></columns></tab></tabs></form>',
    }),
  );
  const overlaidFields = (await body(await ui(sim, 'GET'))).tables.x_item.forms[0].tabs[0].sections[0].fields;
  assert.equal(overlaidFields[0].supported, true);
  assert.equal(Object.hasOwn(overlaidFields[0], 'reason'), false);
  assert.equal(overlaidFields[1].supported, false);
  assert.equal(overlaidFields[1].reason, 'Column metadata is unavailable.');
  assert.equal(overlaidFields[2].supported, false);
  assert.equal(overlaidFields[2].reason, 'This control is not supported locally yet.');
  for (const [relative, content] of Object.entries(files))
    assert.equal(await fs.readFile(path.join(solution, relative), 'utf8'), content);
});

test('standalone close settles an accepted admin write before tearing down its organization', async (t) => {
  const { sim } = await fixture(t, { runtime: { kind: 'model-driven' } });
  let entered,
    release,
    closed = false;
  const waiting = new Promise((resolve) => {
      entered = resolve;
    }),
    blocked = new Promise((resolve) => {
      release = resolve;
    });
  const create = sim.store.create.bind(sim.store),
    closeOrganization = sim.organization.close.bind(sim.organization);
  sim.store.create = async (...args) => {
    entered();
    await blocked;
    assert.equal(closed, false);
    return create(...args);
  };
  sim.organization.close = async () => {
    closed = true;
    return closeOrganization();
  };
  const request = fetch(sim.url + '/_sim/api/records/x_item', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
    body: JSON.stringify({ x_name: 'Accepted write' }),
  });
  await waiting;
  const closing = sim.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, false);
  release();
  assert.equal((await body(await request, 201)).x_name, 'Accepted write');
  await closing;
  assert.equal(closed, true);
  assert.equal(sim.store.tableRows('x_item')[0].x_name, 'Accepted write');
});
