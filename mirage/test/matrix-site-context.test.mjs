import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveTargets } from '../portal-matrix.mjs';
import { createMirageContext } from '../api.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

test('matrix runtimes retain site-bound platform, observations, profiles and explicit packs with independent state', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-matrix-context-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, value) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
    return file;
  };
  for (const site of ['first', 'second']) {
    await write(`${site}/website.yml`, `adx_websiteid: ${site}\nadx_name: ${site}\n`);
    await write(
      `${site}/web-pages/home/Home.webpage.yml`,
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\n',
    );
    await write(`${site}/Main.pagetemplate.yml`, 'adx_pagetemplateid: main\nadx_webtemplateid: main\n');
    await write(`${site}/Main.webtemplate.yml`, 'adx_webtemplateid: main\nadx_name: Main\n');
    await write(`${site}/Main.webtemplate.source.html`, '<html><body>{{ snippets["Label"] }}</body></html>');
    await write(
      `${site}/Label.contentsnippet.yml`,
      'adx_contentsnippetid: label\nadx_name: Label\nadx_value: Original\n',
    );
    await write(
      `${site}/deployment-profiles/dev.yml`,
      `adx_contentsnippet:\n  - adx_contentsnippetid: label\n    adx_value: ${site} patched\n`,
    );
    await write(`${site}/client/WebResources/events.js`, `window.Invented = '${site}';`);
    await write(
      `${site}/client/WebResources/events.js.data.xml`,
      '<WebResource><Name>x_/events.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/events.js</FileName></WebResource>',
    );
    await write(
      `${site}.mjs`,
      `export default { id: '${site}-pack', name: 'Invented ${site}', description: 'Synthetic bounded pack', matches: ({portal}) => portal.website.name === '${site}', presets: () => ({}), endpoints: [{id:'${site}-probe', methods:['GET'], pattern:/^\\/__sim\\/${site}-probe$/, handle: ({res}) => res.end('${site} pack')}] };`,
    );
  }
  const config = await write(
    'catalogue.json',
    JSON.stringify({
      sourceRoot: path.join(root, 'unused-original-checkout'),
      sites: Object.fromEntries(
        ['first', 'second'].map((site, index) => [
          site,
          {
            source: site,
            environments: { local: 'http://127.0.0.1:8787' },
            mirage: {
              sourceMaps: Boolean(index),
              solutionRoots: [],
              platform: { QueryLinkEntityLimit: index ? 50 : 1, evidence: 'Invented local test' },
              observed: {
                headers: { page: { 'x-invented-site': site } },
                evidence: 'Synthetic loopback response fixture',
              },
              deploymentProfiles: {
                default: 'dev',
                profiles: { dev: { pages: `${site}/deployment-profiles/dev.yml` } },
              },
              dataPacks: [{ id: `${site}-pack`, module: `${site}.mjs` }],
              modelDriven: { trustedExtensions: true, clientSources: [`${site}/client`] },
            },
          },
        ]),
      ),
    }),
  );
  const { targets } = await resolveTargets({ config, repo: root, sites: ['first', 'second'] });
  const opened = [];
  ownedFixture(t).add(async () => {
    for (const runtime of opened) await runtime.close();
  });
  const inspect = async (runtime) => {
    const home = await fetch(runtime.url);
    const platform = await fetch(`${runtime.url}/_sim/api/platform-settings`).then((response) => response.json());
    return {
      header: home.headers.get('x-invented-site'),
      body: await home.text(),
      joins: platform.find((item) => item.key === 'QueryLinkEntityLimit').value,
    };
  };
  const inspectScript = async (runtime, site, sourceMaps) => {
    const catalogue = await (await fetch(`${runtime.url}/_apps/api`)).json();
    assert.equal(catalogue.clientExtensions.trusted, true);
    assert.equal(catalogue.clientExtensions.resources.length, 1);
    const response = await fetch(runtime.url + catalogue.clientExtensions.resources[0].url);
    assert.equal(response.status, 200);
    const original = `window.Invented = '${site}';`,
      body = await response.text();
    if (!sourceMaps) assert.equal(body, original);
    else {
      assert.ok(body.startsWith(original));
      const encoded = /sourceMappingURL=data:application\/json;charset=utf-8;base64,([\w+/=]+)/.exec(body)?.[1];
      assert.ok(encoded, `${site} should retain its debugger policy`);
      const map = JSON.parse(Buffer.from(encoded, 'base64').toString());
      assert.deepEqual(map.sources, [
        pathToFileURL(await fs.realpath(path.join(root, site, 'client/WebResources/events.js'))).href,
      ]);
      assert.deepEqual(map.sourcesContent, [original]);
    }
  };
  for (const [index, target] of targets.entries()) {
    const site = target.id,
      expected = index ? 50 : 1;
    const runtime = await target.createRuntime({
      stateFile: path.join(root, `${site}-matrix.json`),
      watch: false,
      port: 0,
    });
    opened.push(runtime);
    const direct = await (
      await createMirageContext({ config, site, repo: root })
    ).createSimulator({ stateFile: path.join(root, `${site}-direct.json`), watch: false, port: 0 });
    opened.push(direct);
    const matrix = await inspect(runtime),
      bound = await inspect(direct);
    assert.equal(matrix.joins, expected);
    assert.equal(matrix.header, site);
    assert.match(matrix.body, new RegExp(`${site} patched`));
    assert.equal(bound.joins, matrix.joins);
    assert.equal(bound.header, matrix.header);
    await inspectScript(runtime, site, Boolean(index));
    await inspectScript(direct, site, Boolean(index));
    assert.equal(await (await fetch(`${runtime.url}/__sim/${site}-probe`)).text(), `${site} pack`);
    assert.equal((await fetch(`${runtime.url}/__sim/${index ? 'first' : 'second'}-probe`)).status, 404);
    assert.notEqual(runtime.store.file, direct.store.file);
    await runtime.close();
    opened.splice(opened.indexOf(runtime), 1);
    const restarted = await target.createRuntime({
      stateFile: path.join(root, `${site}-matrix.json`),
      watch: false,
      port: 0,
    });
    opened.push(restarted);
    assert.equal((await inspect(restarted)).joins, expected);
    await inspectScript(restarted, site, Boolean(index));
  }
});

test('matrix and public site contexts retain the explicitly selected environment and its runtime origin', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-matrix-env-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const write = async (name, value) => {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, value);
    return file;
  };
  await write('portal/website.yml', 'adx_websiteid: invented\nadx_name: Invented\n');
  await write(
    'portal/web-pages/Home.webpage.yml',
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main\n',
  );
  await write('portal/Main.pagetemplate.yml', 'adx_pagetemplateid: main\nadx_webtemplateid: main\n');
  await write('portal/Main.webtemplate.yml', 'adx_webtemplateid: main\nadx_name: Main\n');
  await write('portal/Main.webtemplate.source.html', '<html><body>Only local source bytes</body></html>');
  // The fake reference URLs are configuration values only. This test requests
  // local administration and rendered content; no reference origin is contacted.
  const first = 'https://first.example.invalid',
    second = 'https://second.example.invalid';
  const config = await write(
    'catalogue.json',
    JSON.stringify({
      sourceRoot: root,
      sites: {
        invented: {
          source: 'portal',
          defaultEnv: 'first',
          environments: { first, second },
          mirage: {
            solutionRoots: [],
            observed: {
              headers: { page: { 'x-invented-local': 'retained' } },
              evidence: 'Synthetic local response fixture',
            },
          },
        },
      },
    }),
  );
  const opened = [];
  ownedFixture(t).add(async () => {
    for (const runtime of opened) await runtime.close();
  });
  const open = async (context, state) => {
    const runtime = await context.createSimulator({ stateFile: path.join(root, state), watch: false, port: 0 });
    opened.push(runtime);
    return runtime;
  };
  const {
    targets: [target],
  } = await resolveTargets({ config, sites: ['invented'], env: { invented: 'second' } });
  assert.equal(target.label, 'invented/second');
  assert.equal(target.reference, 'second');
  assert.equal(target.origin, second);
  const matrix = await target.createRuntime({ stateFile: path.join(root, 'matrix.json'), watch: false, port: 0 });
  opened.push(matrix);
  const direct = await open(await createMirageContext({ config, site: 'invented', env: 'second' }), 'direct.json');
  const defaultRuntime = await open(await createMirageContext({ config, site: 'invented' }), 'default.json');
  for (const [runtime, origin] of [
    [matrix, second],
    [direct, second],
    [defaultRuntime, first],
  ]) {
    assert.equal(runtime.live.status().origin, origin);
    assert.equal(runtime.store.state.simulator.live.origin, origin);
    const state = await fetch(runtime.url + '/_sim/api/state').then((response) => response.json());
    assert.equal(state.config.live.origin, origin);
    const home = await fetch(runtime.url);
    assert.equal(home.headers.get('x-invented-local'), 'retained');
    assert.match(await home.text(), /Only local source bytes/);
  }
  await assert.rejects(createMirageContext({ config, site: 'invented', env: 'absent' }), /Unknown environment/);
});
