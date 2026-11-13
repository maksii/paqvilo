// @test-kind contract: Paqvilo project configuration parses invented power.config.json inputs read-only and reports its own diagnostics, overrides, reference bindings and inventory records.
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import {
  codeAppSettings,
  readCodeAppConfig,
  loadCodeApps,
  codeAppInventoryRecord,
  pinnedLocalFetch,
} from '../lib/code-apps-config.mjs';

const APP = '77777777-7777-4777-8777-777777777777';

async function tempDir(t) {
  // The real path: loaded apps report their folder as the OS resolves it (8.3 aliases expanded).
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-apps-config-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

// @test-kind contract+security: Paqvilo settings apply explicit defaults while refusing duplicate names, escaping directories, remote dev URLs and unknown configuration keys.
test('codeAppSettings validates names, relative dirs and loopback localAppUrl', () => {
  assert.deepEqual(codeAppSettings(null), []);
  assert.deepEqual(codeAppSettings([{ name: 'invented-app', dir: 'apps/invented' }]), [
    { name: 'invented-app', dir: 'apps/invented', config: 'power.config.json' },
  ]);
  assert.deepEqual(
    codeAppSettings([{ name: 'a', dir: 'a', localAppUrl: 'http://localhost:3000', config: 'alt.json' }])[0],
    { name: 'a', dir: 'a', config: 'alt.json', localAppUrl: 'http://localhost:3000' },
  );
  assert.throws(() => codeAppSettings({}), /codeApps must be an array/);
  assert.throws(
    () =>
      codeAppSettings([
        { name: 'a', dir: 'a' },
        { name: 'A', dir: 'b' },
      ]),
    /not unique/,
  );
  assert.throws(() => codeAppSettings([{ name: 'bad/name', dir: 'a' }]), /name must be/);
  assert.throws(() => codeAppSettings([{ name: 'a', dir: '../outside' }]), /relative to the project root/);
  assert.throws(() => codeAppSettings([{ name: 'a', dir: 'C:\\abs' }]), /relative to the project root/);
  assert.throws(() => codeAppSettings([{ name: 'a', dir: 'a', localAppUrl: 'https://app.example.test' }]), /loopback/);
  assert.throws(
    () => codeAppSettings([{ name: 'a', dir: 'a', extra: 1 }]),
    /codeApps\[0\]\.extra is not a supported setting/,
  );
});

// The asserted CODEAPP_* diagnostics and byte-for-byte unchanged file are local source-ingestion contracts, not native host behavior.
test('readCodeAppConfig parses power.config.json read-only with diagnostics', async (t) => {
  const root = await tempDir(t);
  assert.deepEqual(
    readCodeAppConfig(root).diagnostics.map((d) => d.code),
    ['CODEAPP_CONFIG_MISSING'],
  );

  await fs.writeFile(path.join(root, 'power.config.json'), '{ not json');
  assert.deepEqual(
    readCodeAppConfig(root).diagnostics.map((d) => d.code),
    ['CODEAPP_CONFIG_INVALID'],
  );

  const document = {
    appId: APP,
    environmentId: 'env-invented',
    localAppUrl: 'http://localhost:3000/',
    region: 'prod',
    appSettings: { showHeader: false },
    connectionReferences: {
      'ref-one': {
        id: '/providers/Microsoft.PowerApps/apis/shared_fx_invented',
        displayName: 'Invented',
        dataSources: ['FxInvented'],
      },
      'ref-two': { id: '/providers/Microsoft.PowerApps/apis/shared_fx_other' },
    },
    databaseReferences: { 'default.cds': { environmentVariableName: '' } },
  };
  const text = '\uFEFF' + JSON.stringify(document, null, 2);
  const file = path.join(root, 'power.config.json');
  await fs.writeFile(file, text);
  const config = readCodeAppConfig(root, 'power.config.json', {
    bindings: { 'ref-one': { connector: 'shared_fx_invented' } },
  });
  assert.equal(config.appId, APP);
  assert.equal(config.environmentId, 'env-invented');
  assert.equal(config.localAppUrl, 'http://localhost:3000/');
  assert.deepEqual(config.connectionReferences[0], {
    key: 'ref-one',
    apiId: 'shared_fx_invented',
    displayName: 'Invented',
    dataSources: ['FxInvented'],
  });
  assert.deepEqual(config.databaseReferences, document.databaseReferences);
  assert.equal(config.raw.region, 'prod');
  assert.deepEqual(
    config.diagnostics.map((d) => [d.code, d.message.includes('ref-two')]),
    [['CODEAPP_CONNECTION_UNBOUND', true]],
  );
  assert.equal(await fs.readFile(file, 'utf8'), text, 'power.config.json is never written');

  await fs.writeFile(file, JSON.stringify({ appId: 5, localAppUrl: 'https://remote.example.test' }));
  const bad = readCodeAppConfig(root);
  assert.equal(bad.appId, null);
  assert.equal(bad.localAppUrl, null);
  assert.deepEqual(
    bad.diagnostics.map((d) => d.code),
    ['CODEAPP_CONFIG_INVALID', 'CODEAPP_CONFIG_INVALID'],
  );
});

// Project URL precedence and the Paqvilo capability record's contract level are explicit toolkit policies.
test('loadCodeApps prefers the project localAppUrl and codeAppInventoryRecord is contract level', async (t) => {
  const root = await tempDir(t);
  await fs.mkdir(path.join(root, 'apps', 'invented'), { recursive: true });
  await fs.writeFile(
    path.join(root, 'apps', 'invented', 'power.config.json'),
    JSON.stringify({
      appId: APP,
      localAppUrl: 'http://localhost:3000/',
      connectionReferences: { 'ref-one': { id: '/providers/Microsoft.PowerApps/apis/shared_fx_invented' } },
    }),
  );
  const [app] = loadCodeApps(
    codeAppSettings([{ name: 'invented', dir: 'apps/invented', localAppUrl: 'http://127.0.0.1:5173/' }]),
    root,
  );
  assert.equal(app.localAppUrl, 'http://127.0.0.1:5173/');
  assert.equal(app.dir, path.join(root, 'apps', 'invented'));
  const record = codeAppInventoryRecord(app);
  assert.equal(record.level, 'contract');
  assert.equal(record.component, 'codeapp');
  assert.equal(record.id, APP);
  assert.deepEqual(record.dependencies, [
    { component: 'connectionreference', name: 'ref-one', apiId: 'shared_fx_invented' },
  ]);
  assert.deepEqual(record.diagnostics, ['CODEAPP_CONNECTION_UNBOUND']);
});

// Invalid authored siblings produce bounded local diagnostics while valid source entries remain available.
test('validates reference maps and binding values without losing valid siblings', async (t) => {
  const root = await tempDir(t);
  const file = path.join(root, 'power.config.json');
  await fs.writeFile(
    file,
    JSON.stringify({
      localAppUrl: '',
      connectionReferences: {
        broken: null,
        invalid: { id: 5, displayName: 7, dataSources: ['Good', 4] },
        valid: { id: '/providers/Microsoft.PowerApps/apis/shared_invented', dataSources: ['Invented'] },
      },
      databaseReferences: {
        'default.cds': {
          dataSources: {
            invented: { entitySetName: 'inventeds', logicalName: 'invented', isHidden: false },
            bad: { entitySetName: 3, isHidden: 'no' },
          },
        },
        broken: [],
      },
    }),
  );
  const config = readCodeAppConfig(root, 'power.config.json', {
    bindings: { invalid: null, valid: { connector: 'shared_invented' } },
  });
  assert.equal(config.localAppUrl, null);
  assert.deepEqual(
    config.connectionReferences.map((r) => r.key),
    ['valid'],
  );
  assert.deepEqual(
    config.diagnostics.filter((d) => d.code === 'CODEAPP_CONNECTION_UNBOUND'),
    [],
  );
  assert.equal(config.diagnostics.filter((d) => d.code === 'CODEAPP_CONFIG_INVALID').length, 8);
  assert.equal(config.databaseReferences['default.cds'].dataSources.invented.entitySetName, 'inventeds');
  await fs.writeFile(file, JSON.stringify({ connectionReferences: [], databaseReferences: [] }));
  assert.equal(readCodeAppConfig(root).diagnostics.filter((d) => d.code === 'CODEAPP_CONFIG_INVALID').length, 2);
});

// A project override resolves the local dev URL before the toolkit emits CODEAPP_LOCAL_URL_MISSING.
test('loadCodeApps reports a missing local URL only after applying the project override', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'power.config.json'), JSON.stringify({ environmentId: 'invented' }));
  const [missing] = loadCodeApps(codeAppSettings([{ name: 'a', dir: '.' }]), root);
  assert.deepEqual(
    missing.diagnostics.map((d) => d.code),
    ['CODEAPP_LOCAL_URL_MISSING'],
  );
  const [override] = loadCodeApps(
    codeAppSettings([{ name: 'a', dir: '.', localAppUrl: 'http://localhost:3000/' }]),
    root,
  );
  assert.deepEqual(override.diagnostics, []);
});

// These project binding diagnostics validate explicitly registered local connection objects and their declared connector identity.
test('binding diagnostics reflect project connection objects and connector identity', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(
    path.join(root, 'power.config.json'),
    JSON.stringify({
      connectionReferences: {
        missing: { id: '/providers/Microsoft.PowerApps/apis/x_invented' },
        wrong: { id: '/providers/Microsoft.PowerApps/apis/x_invented' },
        good: { id: '/providers/Microsoft.PowerApps/apis/x_invented' },
      },
    }),
  );
  const config = readCodeAppConfig(root, 'power.config.json', {
    bindings: { missing: 'not-an-object', wrong: { connector: 'x_other' }, good: { connector: 'x_invented' } },
  });
  const unbound = config.diagnostics.filter((d) => d.code === 'CODEAPP_CONNECTION_UNBOUND');
  assert.equal(unbound.length, 2);
  assert.match(unbound[0].message, /missing/);
  assert.match(unbound[1].message, /wrong/);
});

// Reference-key fallback is the toolkit's project extension lookup policy when the source omits an API ID.
test('binding diagnostics use the reference key when no connector id is declared', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(
    path.join(root, 'power.config.json'),
    JSON.stringify({ connectionReferences: { x_invented: {} } }),
  );
  const config = readCodeAppConfig(root, 'power.config.json', {
    bindings: { x_invented: { connector: 'x_invented' } },
  });
  assert.deepEqual(config.diagnostics, []);
});

// Connector-ID fallback resolves an explicitly supplied project binding and its local diagnostics.
test('binding diagnostics recognize connector-id fallback when reference key differs', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(
    path.join(root, 'power.config.json'),
    JSON.stringify({ connectionReferences: { ref: { id: '/providers/Microsoft.PowerApps/apis/x_invented' } } }),
  );
  const config = readCodeAppConfig(root, 'power.config.json', {
    bindings: { x_invented: { connector: 'x_invented' } },
  });
  assert.deepEqual(config.diagnostics, []);
});

// @test-kind security: inherited __proto__ properties cannot stand in for an explicitly configured connection binding.
test('inherited binding properties do not satisfy a declared connection reference', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(
    path.join(root, 'power.config.json'),
    JSON.stringify({ connectionReferences: { reference: { apiName: '__proto__' } } }),
  );
  const config = readCodeAppConfig(root, 'power.config.json', { bindings: {} });
  assert.deepEqual(
    config.diagnostics.map((diagnostic) => diagnostic.code),
    ['CODEAPP_CONNECTION_UNBOUND'],
  );
});

// @test-kind security: malformed local configuration reports CODEAPP_CONFIG_INVALID without disclosing an invented sensitive source marker.
test('invalid JSON diagnostics do not expose source contents', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'power.config.json'), '{"secret":"invented-sensitive-marker", bad}');
  const config = readCodeAppConfig(root);
  assert.equal(config.diagnostics[0].code, 'CODEAPP_CONFIG_INVALID');
  assert.doesNotMatch(JSON.stringify(config.diagnostics), /invented-sensitive-marker/);
});

// @test-kind contract+security: local dev-server configuration retains explicit argv and rejects escaping cwd, invalid environment values and unbounded timeout settings.
test('dev server settings validate explicit argv, cwd, environment and bounded timeout', () => {
  const entry = {
    name: 'local',
    dir: 'apps/one',
    localAppUrl: 'http://localhost:3000',
    devServer: { command: ['node', 'server.js', ''], cwd: 'web', env: { MODE: 'local' }, timeoutMs: 5000 },
  };
  assert.deepEqual(codeAppSettings([entry])[0].devServer, entry.devServer);
  for (const devServer of [
    { command: [] },
    { command: [''] },
    { command: ['node'], cwd: '../other' },
    { command: ['node'], env: { MODE: 1 } },
    { command: ['node'], timeoutMs: 999 },
    { command: ['node'], timeoutMs: 300001 },
  ])
    assert.throws(() => codeAppSettings([{ name: 'local', dir: 'a', devServer }]));
});

// @test-kind security: a line break or NUL in a command element would be split or truncated by the launcher
test('dev server commands refuse NUL and line breaks in any element and keep ordinary arguments', () => {
  const settings = (command) => codeAppSettings([{ name: 'local', dir: 'a', devServer: { command } }]);
  for (const command of [
    ['node', 'x\0y'],
    ['node', 'x\ny'],
    ['node', 'x\ry'],
    ['node', 'x\r\ny'],
    ['node\n', 'server.js'],
  ])
    assert.throws(() => settings(command), /codeApps\[0\]\.devServer\.command must be/);
  const ordinary = ['node', '--title=Q "a" & b%c', 'two  spaces', "it's"];
  assert.deepEqual(settings(ordinary)[0].devServer.command, ordinary);
});

// The refusal names the directory a relative path is resolved against: the app directory for cwd and config.
test('relative path refusals name the app directory for devServer.cwd and config', () => {
  assert.throws(
    () => codeAppSettings([{ name: 'a', dir: 'apps/a', devServer: { command: ['node'], cwd: '../shared' } }]),
    /codeApps\[0\]\.devServer\.cwd must be a path relative to the app directory/,
  );
  assert.throws(
    () => codeAppSettings([{ name: 'a', dir: 'apps/a', config: '../power.config.json' }]),
    /codeApps\[0\]\.config must be a path relative to the app directory/,
  );
  assert.throws(
    () => codeAppSettings([{ name: 'a', dir: '../outside' }]),
    /codeApps\[0\]\.dir must be a path relative to the project root/,
  );
});

// @test-kind security: a local app URL with a username or password is refused, and its credential never reaches a diagnostic.
test('localAppUrl with credentials is refused at both configuration entry points without echoing them', async (t) => {
  const secret = 'invented-secret-marker';
  const localAppUrl = `http://invented-user:${secret}@127.0.0.1:5199/`;
  assert.throws(
    () => codeAppSettings([{ name: 'a', dir: 'a', localAppUrl }]),
    (error) => /loopback http\(s\) URL without credentials/.test(error.message) && !error.message.includes(secret),
  );
  const root = await tempDir(t);
  await fs.writeFile(path.join(root, 'power.config.json'), JSON.stringify({ localAppUrl }));
  const config = readCodeAppConfig(root);
  assert.equal(config.localAppUrl, null);
  assert.deepEqual(
    config.diagnostics.map((d) => d.code),
    ['CODEAPP_CONFIG_INVALID'],
  );
  assert.doesNotMatch(JSON.stringify(config.diagnostics), new RegExp(secret));
});

// @test-kind security: a probe connects to the one address its name resolved to, and a later answer never redirects the connection.
test('a loopback probe connects to the first checked address even when the name resolves elsewhere later', async () => {
  const answers = [[{ address: '127.0.0.1', family: 4 }], [{ address: '203.0.113.7', family: 4 }]];
  const lookups = [];
  const lookup = async (host) => {
    lookups.push(host);
    return answers.shift();
  };
  const connected = [];
  const connect = (options, onResponse) => {
    connected.push(options);
    const request = new EventEmitter();
    request.end = () => onResponse({ statusCode: 302, destroy() {} });
    return request;
  };
  const response = await pinnedLocalFetch('http://app.localhost:5399/mounted', { method: 'HEAD' }, { lookup, connect });
  assert.equal(response.status, 302, 'a redirect is reported, not followed');
  assert.deepEqual(lookups, ['app.localhost']);
  assert.equal(connected.length, 1);
  assert.equal(connected[0].hostname, '127.0.0.1');
  assert.equal(connected[0].headers.host, 'app.localhost:5399');
  assert.equal(connected[0].path, '/mounted');
  await assert.rejects(
    pinnedLocalFetch(
      'http://app.localhost:5399/',
      {},
      { lookup: async () => [{ address: '203.0.113.7', family: 4 }], connect },
    ),
    /does not resolve only to loopback/,
  );
  assert.equal(connected.length, 1, 'a name with a non-loopback answer is never connected');
});

test('a pinned https probe passes an SNI name for a host name and no SNI name for an IP literal', async () => {
  const servernames = [];
  const connect = (options, onResponse) => {
    servernames.push(options.servername);
    const request = new EventEmitter();
    request.end = () => onResponse({ statusCode: 302, destroy() {} });
    return request;
  };
  await pinnedLocalFetch('https://127.0.0.1:8443/', {}, { connect });
  await pinnedLocalFetch(
    'https://localhost:8443/',
    {},
    { lookup: async () => [{ address: '127.0.0.1', family: 4 }], connect },
  );
  assert.deepEqual(servernames, [undefined, 'localhost']);
});

async function loopbackServer(t, handler) {
  const server = http.createServer(handler);
  let connections = 0;
  server.on('connection', () => {
    connections += 1;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  ownedFixture(t).add(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  return { port: server.address().port, connections: () => connections };
}

test('a loopback name reaches a server listening only on the address family of its later answer', async () => {
  const lookup = async () => [
    { address: '::1', family: 6 },
    { address: '127.0.0.1', family: 4 },
  ];
  const attempts = [];
  const connect = (options, onResponse) => {
    attempts.push(options.hostname);
    const request = new EventEmitter();
    request.end = () => {
      if (options.hostname === '::1') {
        request.emit('error', Object.assign(new Error('connect ECONNREFUSED ::1'), { code: 'ECONNREFUSED' }));
      } else {
        onResponse({ statusCode: 200, destroy() {} });
      }
    };
    return request;
  };
  const response = await pinnedLocalFetch('http://localhost:5399/', {}, { lookup, connect });
  assert.deepEqual(attempts, ['::1', '127.0.0.1']);
  assert.equal(response.status, 200);
});

test('a loopback probe makes one attempt at the first validated answer, with the requested Host and SNI name', async (t) => {
  const server = await loopbackServer(t, (req, res) => res.end('ok'));
  const attempts = [];
  const connect = (options, onResponse) => {
    attempts.push(options);
    return http.request(options, onResponse);
  };
  const lookup = async () => [
    { address: '127.0.0.1', family: 4 },
    { address: '::1', family: 6 },
  ];
  const response = await pinnedLocalFetch(`http://localhost:${server.port}/`, {}, { lookup, connect });
  assert.equal(response.status, 200);
  assert.deepEqual(
    attempts.map((options) => options.hostname),
    ['127.0.0.1'],
  );
  assert.equal(attempts[0].headers.host, `localhost:${server.port}`);
  assert.equal(attempts[0].servername, 'localhost');
});

// @test-kind security: a name with any answer outside loopback is refused before any connection is made, to any answer.
test('a loopback probe refuses a name with any non-loopback answer before connecting to a loopback answer', async (t) => {
  const server = await loopbackServer(t, (req, res) => res.end('ok'));
  const lookup = async () => [
    { address: '127.0.0.1', family: 4 },
    { address: '10.0.0.1', family: 4 },
  ];
  await assert.rejects(
    pinnedLocalFetch(`http://localhost:${server.port}/`, {}, { lookup }),
    /does not resolve only to loopback/,
  );
  assert.equal(server.connections(), 0);
});

test('a loopback probe rejects with the last connect error when every validated answer refuses', async () => {
  const codes = { '::1': 'EADDRNOTAVAIL', '127.0.0.1': 'ECONNREFUSED' };
  const attempts = [];
  const connect = (options) => {
    attempts.push(options.hostname);
    const request = new EventEmitter();
    request.end = () => {
      const code = codes[options.hostname];
      request.emit('error', Object.assign(new Error(`connect ${code}`), { code }));
    };
    return request;
  };
  const lookup = async () => [
    { address: '::1', family: 6 },
    { address: '127.0.0.1', family: 4 },
  ];
  await assert.rejects(pinnedLocalFetch('http://localhost:5399/', {}, { lookup, connect }), { code: 'ECONNREFUSED' });
  assert.deepEqual(attempts, ['::1', '127.0.0.1']);
});

test('a loopback probe returns the HTTP status of its first validated answer without trying the next answer', async () => {
  const attempts = [];
  const connect = (options, onResponse) => {
    attempts.push(options.hostname);
    const request = new EventEmitter();
    request.end = () => onResponse({ statusCode: 500, destroy() {} });
    return request;
  };
  const lookup = async () => [
    { address: '127.0.0.1', family: 4 },
    { address: '::1', family: 6 },
  ];
  const response = await pinnedLocalFetch('http://localhost:5399/', {}, { lookup, connect });
  assert.equal(response.status, 500);
  assert.deepEqual(attempts, ['127.0.0.1']);
});

test('localAppUrl accepts every loopback spelling the dev server treats as local', () => {
  for (const localAppUrl of ['http://127.0.0.2:5199/', 'http://app.localhost:5199/', 'http://[::1]:5199/'])
    assert.equal(codeAppSettings([{ name: 'a', dir: 'a', localAppUrl }])[0].localAppUrl, localAppUrl);
});

// The toolkit derives its local source-name map, refuses an ambiguous alias and carries the configured dev-server command unchanged.
test('config reads app settings and derives unambiguous entity sets from data sources', async (t) => {
  const root = await tempDir(t);
  await fs.writeFile(
    path.join(root, 'power.config.json'),
    JSON.stringify({
      appSettings: { showHeader: true },
      databaseReferences: {
        one: {
          dataSources: {
            Items: { logicalName: 'x_item', entitySetName: 'x_items' },
            Shared: { logicalName: 'x_a', entitySetName: 'x_as' },
          },
        },
        two: { dataSources: { Shared: { logicalName: 'x_b', entitySetName: 'x_bs' } } },
      },
    }),
  );
  const config = readCodeAppConfig(root);
  assert.deepEqual(config.appSettings, { showHeader: true });
  assert.deepEqual(config.entitySets, { Items: 'x_items', x_item: 'x_items', x_a: 'x_as', x_b: 'x_bs' });
  assert.deepEqual(
    config.diagnostics.map((d) => d.code),
    ['CODEAPP_DATASOURCE_AMBIGUOUS'],
  );
  const [app] = loadCodeApps(
    codeAppSettings([{ name: 'a', dir: '.', devServer: { command: ['node', 'app.js'] } }]),
    root,
  );
  assert.deepEqual(app.devServer, { command: ['node', 'app.js'] });
});
