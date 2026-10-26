import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { DataStore, emptyState } from '../lib/data.mjs';
import { StateStorage } from '../lib/state-storage.mjs';
import { scanSolutionSources, buildSolutionSchema } from '../lib/solution-schema.mjs';
import { ensureSecurityModel } from '../lib/dataverse-security.mjs';
import { watchSources } from '../lib/source-watcher.mjs';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { createSimulator } from '../server.mjs';
import { performanceFixture } from './runtime-performance-fixture.mjs';
import { createMirageContext } from '../lib/mirage-context.mjs';
import { SolutionFileCache } from '../lib/solution-cache.mjs';
import { SCHEMA_PARSER_ID } from '../lib/solution-schema.mjs';
import { createSolutionMetadataOverlay } from '../lib/dataverse-solution-metadata.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { settleFileTimes } from './support/file-times.mjs';

// Watchers and runtimes are owned closers so they stop before their directories are removed
// (t.after hooks run in registration order).

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-cost-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test('selected fragmented sections skip reconstruction while checksum and torn-tail checks remain enforced', async (t) => {
  const root = await workspace(t),
    file = path.join(root, 'state.json'),
    state = emptyState();
  state.simulator = { deploymentProfilePin: 'invented-profile' };
  state.dataverse = {
    baseline: Array.from({ length: 8192 }, (_, id) => ({ id, xml: '<form>' + 'invented'.repeat(64) + '</form>' })),
  };
  const store = await new DataStore({ file, state, persistence: { journalThresholdBytes: 0 } }).init();
  const selected = new StateStorage(file);
  assert.deepEqual(await selected.load({ sections: ['simulator'] }), {
    simulator: store.snapshot({ sections: ['simulator'] }).simulator,
  });
  assert.ok(selected.skippedFragmentEntries > 0);
  await fs.appendFile(file, '{"op":"begin"}\n{"op":"fragments"}\n{"chunk":"incomplete');
  assert.equal(
    (await new StateStorage(file).load({ sections: ['simulator'] })).simulator.deploymentProfilePin,
    'invented-profile',
  );
  const bytes = await fs.readFile(file, 'utf8');
  await fs.writeFile(file, bytes.replace('invented', 'damaged'));
  await assert.rejects(new StateStorage(file).load({ sections: ['simulator'] }), /checksum/);
});

test('portal restart consumes one integrity-checked restore and rejects a stale preload', async (t) => {
  const fixture = await modelDrivenFixture(t);
  await fixture.sim.close();
  const original = StateStorage.prototype.load;
  let loads = 0;
  StateStorage.prototype.load = function (...args) {
    loads++;
    return original.apply(this, args);
  };
  let sim;
  try {
    sim = await fixture.start();
    assert.equal(loads, 1);
  } finally {
    StateStorage.prototype.load = original;
    await sim?.close();
  }
  const storage = new StateStorage(fixture.stateFile),
    restored = await storage.load();
  await fs.appendFile(fixture.stateFile, '\n');
  await assert.rejects(
    new DataStore({ file: fixture.stateFile }).init({ restoredState: restored, restoredStorage: storage }),
    { code: 'StateConflict' },
  );
});

test('scan reuse validates file inventory, order and content identity before sharing parsed facts', async (t) => {
  // The reuse assertions below concern files written moments ago.
  const settled = settleFileTimes(t);
  const root = await workspace(t),
    file = path.join(root, 'AppModules', 'x_app', 'AppModule.xml');
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '<AppModule><UniqueName>x_one</UniqueName></AppModule>');
  const scan = await scanSolutionSources([root]);
  assert.equal(await scanSolutionSources([root], { previous: scan }), scan);
  assert.notEqual(await scanSolutionSources([root], { previous: scan, order: 'derived' }), scan);
  // A same-size edit, possibly in the same file-time tick: the real clock lets the racy window catch it.
  settled.restore();
  await fs.writeFile(file, '<AppModule><UniqueName>x_two</UniqueName></AppModule>');
  const changed = await scanSolutionSources([root], { previous: scan });
  assert.notEqual(changed, scan);
  assert.notEqual(buildSolutionSchema(changed).fingerprint, buildSolutionSchema(scan).fingerprint);
  await fs.writeFile(
    path.join(path.dirname(file), 'Other.xml'),
    '<AppModule><UniqueName>x_three</UniqueName></AppModule>',
  );
  assert.notEqual(await scanSolutionSources([root], { previous: changed }), changed);
  await fs.unlink(file);
  assert.notEqual(await scanSolutionSources([root], { previous: scan }), scan);
});

test('bound contexts share immutable schema parses and invalidate changed Solution and portal sources', async (t) => {
  // The reuse assertions below concern files written moments ago.
  settleFileTimes(t);
  const fixture = await modelDrivenFixture(t, { defer: true });
  const config = path.join(fixture.root, 'catalogue.json');
  const profile = path.join(fixture.root, 'profile.json');
  const writeProfile = (value) =>
    fs.writeFile(profile, JSON.stringify({ adx_contentsnippet: [{ adx_name: 'Welcome', adx_value: value }] }));
  await writeProfile('Bound profile one');
  const settings = {
    source: fixture.sourceDir,
    environments: { local: 'http://127.0.0.1:8787' },
    mirage: {
      solutionRoots: [fixture.solutionDir],
      deploymentProfiles: { default: 'bound', profiles: { bound: { pages: profile } } },
    },
  };
  await fs.writeFile(config, JSON.stringify({ sites: { invented: settings } }));
  const context = await createMirageContext({ config, site: 'invented', env: 'local' });
  const original = SolutionFileCache.prototype.parse;
  let schemaParses = 0,
    sim;
  SolutionFileCache.prototype.parse = function (file, parser, ...args) {
    if (parser.startsWith(SCHEMA_PARSER_ID)) schemaParses++;
    return original.call(this, file, parser, ...args);
  };
  try {
    sim = await context.createSimulator({ stateFile: null, watch: false });
    assert.match(await (await fetch(sim.url)).text(), /Bound profile one/);
    assert.equal(schemaParses, 0, 'A validated bound scan is not parsed again.');
    await sim.close();
    sim = null;
    await writeProfile('Bound profile two');
    sim = await context.createSimulator({
      stateFile: null,
      watch: false,
      dataverse: { enabled: false, localeId: 1036 },
    });
    assert.match(await (await fetch(sim.url)).text(), /Bound profile two/);
    assert.deepEqual(sim.state({ summary: true }).status.bootstrap.timings.solutionReuse, {
      scan: true,
      schema: false,
    });
    assert.equal(schemaParses, 0);
    await sim.close();
    sim = null;
    const entity = path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml');
    await fs.writeFile(
      entity,
      (await fs.readFile(entity, 'utf8')).replace(
        '</attributes>',
        '<attribute PhysicalName="x_added"><Name>x_added</Name><Type>nvarchar</Type></attribute></attributes>',
      ),
    );
    const copy = path.join(fixture.sourceDir, 'web-templates/Main.webtemplate.source.html');
    await fs.writeFile(copy, '<main>Changed bound portal source</main>');
    sim = await context.createSimulator({ stateFile: null, watch: false });
    assert.ok(schemaParses > 0);
    const metadata = await (await fetch(sim.url + '/_apps/api/metadata/x_item')).json();
    assert.ok(metadata.fields.x_added);
    assert.match(await (await fetch(sim.url)).text(), /Changed bound portal source/);
  } finally {
    SolutionFileCache.prototype.parse = original;
    await sim?.close();
  }
});

test('source form/view overlay work is linear in source components and current rows', () => {
  const measure = (size) => {
    let reads = 0;
    const baseline = {},
      forms = [],
      views = [],
      systemform = [],
      savedquery = [];
    for (let index = 0; index < size; index++) {
      const key = String(index);
      forms.push({ id: key, entity: 'x_item', xml: '<form/>' });
      views.push({ id: key, entity: 'x_item', queryType: 0 });
      baseline['systemform/' + key] = {};
      baseline['savedquery/' + key] = {};
      systemform.push({
        get formid() {
          reads++;
          return key;
        },
        formxml: '<form/>',
        name: 'Edited form ' + key,
      });
      savedquery.push({
        get savedqueryid() {
          reads++;
          return key;
        },
        name: 'Edited view ' + key,
      });
    }
    const result = createSolutionMetadataOverlay()(
      { forms, views },
      { tables: { systemform, savedquery }, dataverse: { sourceSolutionComponents: { baseline } } },
    );
    assert.equal(result.forms.length, size);
    assert.equal(result.views.length, size);
    assert.equal(result.forms.at(-1).name, 'Edited form ' + (size - 1));
    assert.ok(reads < size * 10, `${reads} ID reads for ${size} forms and views`);
    return reads;
  };
  assert.ok(measure(256) < measure(128) * 2.2);
});

test('state replacement retains its old graph without cloning it on success and restores failed saves', async () => {
  const state = emptyState();
  state.tables.x_item = [{ id: 'one', value: 'old' }];
  const store = new DataStore({ state });
  let reads = 0;
  Object.defineProperty(store.state.tables.x_item[0], 'value', {
    enumerable: true,
    get() {
      reads++;
      return 'old';
    },
  });
  const next = emptyState();
  next.tables.x_item = [{ id: 'two', value: 'new' }];
  await store.replaceState(next, { returnSnapshot: false });
  assert.equal(reads, 0, 'An unchanged rollback graph is retained by reference.');
  next.tables.x_item[0].value = 'outside';
  assert.equal(store.state.tables.x_item[0].value, 'new');
  store.save = async () => {
    throw Error('Invented durable failure');
  };
  await assert.rejects(store.replaceState(state, { returnSnapshot: false }), /Invented durable failure/);
  assert.equal(store.state.tables.x_item[0].value, 'new');
});

test('startup can omit a preset result while public preset results and inputs remain detached', async () => {
  const preset = { tables: { x_item: [{ id: 'one', value: 'initial' }] }, mappings: { x_item: { idColumn: 'id' } } };
  const store = new DataStore({ state: emptyState(), presetLibrary: { invented: preset } });
  assert.equal(await store.applyPreset('invented', { returnSnapshot: false }), undefined);
  preset.tables.x_item[0].value = 'outside';
  assert.equal(store.state.tables.x_item[0].value, 'initial');
  const result = await store.applyPreset('invented');
  result.tables.x_item[0].value = 'returned result';
  assert.equal(store.state.tables.x_item[0].value, 'outside');
});

test('security seed lookup work grows linearly and preserves case-insensitive edited grants', async () => {
  async function measure(size) {
    const state = emptyState();
    state.mappings = Object.fromEntries(
      Array.from({ length: size }, (_, index) => [`x_table${index}`, { idColumn: 'id', fields: {} }]),
    );
    const store = { state, tableRows: (name) => state.tables[name] ?? [], transact: async (fn) => fn() };
    const settings = { organizationId: '12345678-1234-4234-8234-123456789abc', uniqueName: 'invented' };
    await ensureSecurityModel(store, settings);
    const grant = state.tables.roleprivileges[0];
    grant.privilegedepthmask = 1;
    let reads = 0;
    for (const [table, column] of [
      ['privilege', 'privilegeid'],
      ['roleprivileges', 'roleprivilegeid'],
    ])
      for (const row of state.tables[table]) {
        const id = row[column].toUpperCase();
        Object.defineProperty(row, column, {
          enumerable: true,
          configurable: true,
          get() {
            reads++;
            return id;
          },
        });
      }
    const count = state.tables.privilege.length + state.tables.roleprivileges.length;
    await ensureSecurityModel(store, settings);
    assert.equal(state.tables.privilege.length + state.tables.roleprivileges.length, count);
    assert.equal(grant.privilegedepthmask, 1);
    assert.ok(reads < count * 5, `${reads} lookups for ${count} security rows`);
    return reads;
  }
  const small = await measure(128),
    large = await measure(256);
  assert.ok(large < small * 2.2, `${small} -> ${large}`);
});

test('failed security seeding rolls back, drops its indexes and admits extension tables on a later seed', async () => {
  const store = new DataStore({ state: emptyState() }),
    before = store.snapshot();
  const settings = { organizationId: '12345678-1234-4234-8234-123456789abc', uniqueName: 'invented' };
  await assert.rejects(
    ensureSecurityModel(store, {
      ...settings,
      users: [{ upn: 'invented@example.test', roles: ['11111111-1111-4111-8111-111111111111'] }],
    }),
    /does not exist/,
  );
  assert.deepEqual(store.snapshot(), before);
  await ensureSecurityModel(store, settings);
  const grants = store.state.tables.roleprivileges.length;
  await store.transact(() => {
    store.state.mappings.x_extension = { idColumn: 'x_extensionid' };
  });
  await ensureSecurityModel(store, settings);
  assert.ok(store.state.tables.roleprivileges.length > grants);
  const other = new DataStore({ state: emptyState() });
  await ensureSecurityModel(other, { ...settings, organizationId: '22345678-1234-4234-8234-123456789abc' });
  assert.notEqual(other.state.tables.privilege[0].privilegeid, store.state.tables.privilege[0].privilegeid);
});

test('recursive source watching uses bounded Windows handles, observes atomic saves and closes cleanly', async (t) => {
  const root = await workspace(t),
    nested = path.join(root, 'Entities', 'x_item');
  await fs.mkdir(nested, { recursive: true });
  const file = path.join(nested, 'Entity.xml');
  await fs.writeFile(file, '<Entity/>');
  const watcher = watchSources([root, nested, ...(process.platform === 'win32' ? [root.toUpperCase()] : [])], {
    ignoreInitial: true,
    ignored: (file) => file.endsWith('.tmp'),
    awaitWriteFinish: { stabilityThreshold: 20 },
  });
  ownedFixture(t).add(() => watcher.close());
  await once(watcher, 'ready');
  if (process.platform === 'win32') assert.equal(watcher.nativeWatchCount(), root.split(path.sep).length);
  const observed = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Error('Source save was not observed')), 5000);
    watcher.on('all', (_event, changed) => {
      if (path.resolve(changed) === file) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  const temp = file + '.tmp';
  await fs.writeFile(temp, '<Entity Name="updated"/>');
  await fs.rename(temp, file);
  await observed;
  await watcher.close();
  if (process.platform === 'win32') assert.equal(watcher.nativeWatchCount(), 0);
});

test(
  'Windows source watching recovers replaced export roots and containing directories',
  { skip: process.platform !== 'win32' },
  async (t) => {
    const workspaceRoot = await workspace(t),
      container = path.join(workspaceRoot, 'project'),
      root = path.join(container, 'source'),
      file = path.join(root, 'Entity.xml');
    await fs.mkdir(root, { recursive: true });
    await fs.writeFile(file, '<Entity Name="initial"/>');
    const watcher = watchSources([root], { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 20 } });
    ownedFixture(t).add(() => watcher.close());
    await once(watcher, 'ready');
    const waitFor = (wanted) =>
      new Promise((resolve, reject) => {
        const changed = (_event, changedFile) => {
          if (path.resolve(changedFile) === wanted) {
            clearTimeout(timer);
            watcher.off('all', changed);
            resolve();
          }
        };
        const timer = setTimeout(() => {
          watcher.off('all', changed);
          reject(Error('Replaced source was not observed: ' + wanted));
        }, 5000);
        watcher.on('all', changed);
      });
    for (const [index, replaced] of [root, container].entries()) {
      const replacement = waitFor(root);
      if (index === 0) await fs.rename(replaced, path.join(workspaceRoot, 'previous-' + index));
      else await fs.rm(replaced, { recursive: true });
      await fs.mkdir(root, { recursive: true });
      await fs.writeFile(file, '<Entity Name="replacement"/>');
      await replacement;
      const edit = waitFor(file);
      await fs.writeFile(file, '<Entity Name="after replacement"/>');
      await edit;
      assert.equal(watcher.nativeWatchCount(), root.split(path.sep).length);
    }
  },
);

test('the shell index and selected-table transport exclude unrelated forms and re-evaluate each caller', async (t) => {
  const fixture = await performanceFixture({ tables: 16, records: 16, formsPerTable: 4 });
  ownedFixture(t).remove(fixture.cleanup);
  const sim = await createSimulator({
    runtime: { kind: 'model-driven' },
    solutionRoots: fixture.solutionRoots,
    watch: false,
    packs: [fixture.pack],
    preset: 'invented-scale',
    dataverse: {
      enabled: false,
      users: [
        {
          objectId: 'aaaaaaaa-0000-4000-8000-000000000001',
          domainname: 'restricted@example.test',
          fullname: 'Invented restricted staff',
          roles: [],
        },
      ],
    },
  });
  ownedFixture(t).add(() => sim.close());
  const read = async (route, cookie) => {
    const response = await fetch(sim.url + '/_apps/api/' + route, {
      headers: { 'x-mirage-provenance-format': '1', ...(cookie ? { cookie } : {}) },
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    const { decodeModelDrivenProvenance } = await import('../lib/model-driven/provenance-transport.mjs');
    return { value: decodeModelDrivenProvenance(JSON.parse(text)), bytes: Buffer.byteLength(text) };
  };
  const index = await read('index'),
    table = await read('metadata/x_scale0');
  assert.equal(table.value.forms.length, 4);
  assert.ok(table.value.fields.x_value1);
  assert.ok(Object.keys(index.value.tables).length >= 16);
  assert.ok(
    Object.values(index.value.tables).every(
      (table) => !table.fields && !table.forms && !table.views && table.metadata === 'lazy',
    ),
  );
  assert.ok(index.bytes < 160000, `Navigation index: ${index.bytes} bytes`);
  assert.ok(table.bytes < 100000, `Selected table: ${table.bytes} bytes`);
  const canonical = await (await fetch(sim.url + '/_apps/api/metadata/x_scale0')).json();
  assert.deepEqual(
    table.value,
    canonical,
    'the actual shell wire format retains every source key, file, revision and range',
  );
  assert.ok(table.value.provenanceRefs.length > 100);
  const full = await read('');
  assert.ok(full.bytes > index.bytes * 3);
  assert.equal(table.value.capabilities.read, true);
  const sessions = await (await fetch(sim.url + '/_sim/api/dataverse/session')).json();
  const staff = sessions.users.find((user) => user.name === 'Invented restricted staff');
  assert.ok(staff);
  const selected = await fetch(sim.url + '/_sim/api/dataverse/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf },
    body: JSON.stringify({ userId: staff.id }),
  });
  assert.equal(selected.status, 200);
  const cookie = selected.headers.get('set-cookie').split(';')[0];
  assert.equal((await read('metadata/x_scale0', cookie)).value.capabilities.read, false);
  assert.equal((await read('index', cookie)).value.tables.x_scale0.capabilities.read, false);
  assert.equal((await read('metadata/x_scale0')).value.capabilities.read, true);
  assert.equal((await fetch(sim.url + '/_apps/api/metadata/constructor')).status, 404);
});

test('quadrupling unrelated forms does not grow selected-table metadata transfer', async () => {
  const sizes = [];
  for (const tables of [8, 32]) {
    const fixture = await performanceFixture({ tables, records: tables, formsPerTable: 4 });
    let sim;
    try {
      sim = await createSimulator({
        runtime: { kind: 'model-driven' },
        solutionRoots: fixture.solutionRoots,
        watch: false,
      });
      const response = await fetch(sim.url + '/_apps/api/metadata/x_scale0');
      assert.equal(response.status, 200);
      const text = await response.text(),
        value = JSON.parse(text);
      assert.equal(value.forms.length, 4);
      sizes.push(Buffer.byteLength(text));
    } finally {
      await sim?.close();
      await fixture.cleanup();
    }
  }
  assert.ok(Math.abs(sizes[1] - sizes[0]) < 128, `${sizes[0]} -> ${sizes[1]} bytes`);
});

test('selected-table provenance opens a source file no more often when more columns and controls name it', async () => {
  const opensPerFile = [];
  for (const columns of [2, 16]) {
    const fixture = await performanceFixture({ tables: 1, columns, records: 1 });
    let sim;
    const openSync = fsSync.openSync;
    try {
      sim = await createSimulator({
        runtime: { kind: 'model-driven' },
        solutionRoots: fixture.solutionRoots,
        watch: false,
      });
      const root = fsSync.realpathSync.native(fixture.root),
        opens = new Map();
      fsSync.openSync = (file, ...rest) => {
        if (typeof file === 'string' && file.startsWith(root)) opens.set(file, (opens.get(file) ?? 0) + 1);
        return openSync(file, ...rest);
      };
      const response = await fetch(sim.url + '/_apps/api/metadata/x_scale0');
      fsSync.openSync = openSync;
      assert.equal(response.status, 200);
      assert.ok((await response.json()).provenanceRefs.length > columns, 'every column and control carries provenance');
      assert.ok(opens.size > 0, 'the first catalogue request reads its source files');
      opensPerFile.push(Math.max(...opens.values()));
    } finally {
      fsSync.openSync = openSync;
      await sim?.close();
      await fixture.cleanup();
    }
  }
  assert.equal(opensPerFile[1], opensPerFile[0], `${opensPerFile[0]} -> ${opensPerFile[1]} opens of one source file`);
});

test('form/view-only source layers retain mapped OData columns through public list and record routes and reload', async (t) => {
  const initial = {
    version: 1,
    mappings: {
      x_item: {
        userConfigured: true,
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        nameColumn: 'x_name',
        fields: {
          x_itemid: { dataverseType: 'uniqueidentifier' },
          x_name: { dataverseType: 'nvarchar' },
          x_quantity: { dataverseType: 'int' },
        },
        fieldMetadata: {
          x_name: { dataverseType: 'nvarchar', label: 'Mapped name' },
          x_quantity: { dataverseType: 'int', isSecured: true },
        },
      },
    },
    tables: { x_item: [{ x_itemid: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', x_name: 'Mapped row', x_quantity: 2 }] },
  };
  const fixture = await modelDrivenFixture(t, { defer: true });
  await fs.unlink(path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml'));
  const sim = await fixture.start({
    stateFile: null,
    initial,
    dataverse: {
      enabled: false,
      users: [
        {
          objectId: 'aaaaaaaa-0000-4000-8000-000000000001',
          domainname: 'reader@example.test',
          fullname: 'Invented reader',
          roles: ['Basic User'],
        },
        {
          objectId: 'aaaaaaaa-0000-4000-8000-000000000002',
          domainname: 'denied@example.test',
          fullname: 'Invented denied staff',
          roles: [],
        },
      ],
    },
  });
  ownedFixture(t).add(() => sim.close());
  const read = async (id, options, status = 200, cookie) => {
    const route =
      '/_apps/api/tables/x_item' +
      (id ? '/' + id : '') +
      '?query=' +
      encodeURIComponent(JSON.stringify({ scope: 'odata', options }));
    const response = await fetch(sim.url + route, { headers: cookie ? { cookie } : {} });
    const body = await response.json();
    assert.equal(response.status, status, JSON.stringify(body));
    return body;
  };
  for (const reload of [false, true]) {
    if (reload) await sim.reload();
    for (const id of [null, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa']) {
      const value = await read(id, '?$select=x_name');
      assert.equal((id ? value : value.entities[0]).x_name, 'Mapped row');
      await read(id, '?$select=x_unregistered', 400);
    }
    const filtered = await read(null, "?$select=x_name&$filter=x_name eq 'Mapped row'");
    assert.equal(filtered.entities.length, 1);
    assert.equal(filtered.entities[0].x_name, 'Mapped row');
    await read(null, "?$select=x_name&$filter=x_unregistered eq 'unknown'", 400);
  }
  const sessions = await (await fetch(sim.url + '/_sim/api/dataverse/session')).json();
  const cookieFor = async (name) => {
    const userId = sessions.users.find((user) => user.name === name).id;
    const response = await fetch(sim.url + '/_sim/api/dataverse/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.state().csrf },
      body: JSON.stringify({ userId }),
    });
    assert.equal(response.status, 200);
    return response.headers.get('set-cookie').split(';')[0];
  };
  const reader = await cookieFor('Invented reader'),
    denied = await cookieFor('Invented denied staff');
  await read(null, '?$select=x_name', 403, denied);
  assert.equal((await read(null, '?$select=x_name,x_quantity', 200, reader)).entities[0].x_quantity, null);
  await sim.store.transact(() => {
    sim.store.state.mappings.x_item.fields.x_quantity.dataverseMetadata = { IsSecured: false };
  });
  assert.equal((await read(null, '?$select=x_quantity', 200, reader)).entities[0].x_quantity, 2);
  // A complete schema still closes the structural property set, including fields
  // declared only by a mapping. Reading supported form-only fields is no bypass.
  const names = [
    'x_itemid',
    'x_quantity',
    'createdon',
    'createdby',
    'modifiedon',
    'modifiedby',
    'statecode',
    'statuscode',
  ];
  const attribute = (name) =>
    `<attribute PhysicalName="${name}"><Name>${name}</Name><Type>${name === 'x_itemid' ? 'primarykey' : name === 'x_quantity' ? 'int' : 'nvarchar'}</Type></attribute>`;
  await fs.writeFile(
    path.join(fixture.solutionDir, 'Entities/x_item/Entity.xml'),
    `<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><attributes>${names.map(attribute).join('')}</attributes></entity></EntityInfo></Entity>`,
  );
  await sim.reload();
  await read(null, '?$select=x_name', 400);
  await read('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '?$select=x_name', 400);
  await read(null, '?$select=x_quantity');
});
