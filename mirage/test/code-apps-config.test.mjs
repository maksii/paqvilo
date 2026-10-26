import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { codeAppSettings, readCodeAppConfig, loadCodeApps, codeAppInventoryRecord } from '../lib/code-apps-config.mjs';

const APP = '77777777-7777-4777-8777-777777777777';

async function tempDir(t) {
  // The real path: loaded apps report their folder as the OS resolves it (8.3 aliases expanded).
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'code-apps-config-')));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

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
