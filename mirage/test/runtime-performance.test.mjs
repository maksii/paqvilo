import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createModelDrivenHandler } from '../lib/model-driven/http.mjs';
import { runtimePerformance, LARGE_PERFORMANCE_OPTIONS } from '../../scripts/runtime-performance.mjs';
import { createSimulator } from '../server.mjs';
import { performanceFixture, performanceId } from './runtime-performance-fixture.mjs';
import { createSolutionMetadataOverlay } from '../lib/dataverse-solution-metadata.mjs';
import { appCatalogue, appCatalogueAsync } from '../lib/model-driven/catalogue.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('paged FetchXML projects only returned rows while preserving counts, cookies, ordering and detached values', () => {
  const payload = 'Invented large payload'.repeat(16);
  const store = new DataStore({
    state: {
      tables: {
        x_item: Array.from({ length: 1500 }, (_, i) => ({
          x_itemid: performanceId(i + 1),
          x_name: String(i).padStart(4, '0'),
          x_payload: payload,
        })),
      },
      mappings: {
        x_item: {
          idColumn: 'x_itemid',
          entitySet: 'x_items',
          fields: { x_name: { type: 'text' }, x_payload: { type: 'text' } },
        },
      },
    },
  });
  const original = globalThis.structuredClone;
  let projected = 0;
  globalThis.structuredClone = (value) => {
    if (value === payload) projected++;
    return original(value);
  };
  try {
    const xml = (page, cookie = '') =>
      `<fetch count="25" page="${page}" returntotalrecordcount="true"${cookie ? ' paging-cookie="' + cookie.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;') + '"' : ''}><entity name="x_item"><attribute name="x_name"/><attribute name="x_payload"/><order attribute="x_name" descending="true"/></entity></fetch>`;
    const second = store.fetchXml(xml(2), { admin: true });
    assert.equal(projected, 25, 'Off-page values are neither copied nor projected');
    assert.equal(second.total_record_count, 1500);
    assert.equal(second.more_records, true);
    assert.equal(second.entities[0].x_name, '1474');
    assert.equal(second.entities.at(-1).x_name, '1450');
    assert.ok(second.paging_cookie);
    const third = store.fetchXml(xml(3, second.paging_cookie), { admin: true });
    assert.equal(projected, 50);
    assert.equal(third.entities[0].x_name, '1449');
    third.entities[0].x_payload = 'local response edit';
    assert.equal(store.tableRows('x_item')[1449].x_payload, payload);
  } finally {
    globalThis.structuredClone = original;
  }
});
import { settleFileTimes } from './support/file-times.mjs';

test('unchanged isolated composition clones each business graph once and owned replacement saves zero bytes', async (t) => {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-copy-count-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  for (const count of [32, 4096]) {
    const state = emptyState();
    state.tables.x_item = Array.from({ length: count }, (_, index) => ({
      x_itemid: `item-${index}`,
      value: 'local edit',
    }));
    const store = await new DataStore({
      file: path.join(directory, `${count}.json`),
      state,
      persistence: { journalThresholdBytes: 0 },
    }).init();
    await store.save();
    const bytes = await fs.readFile(store.file),
      revision = store.revision;
    let saves = 0,
      graphClones = 0;
    store.onSave = () => saves++;
    const clone = structuredClone,
      candidate = clone(store.state);
    const mock = t.mock.method(globalThis, 'structuredClone', (value, ...args) => {
      if (value?.tables?.x_item?.length === count) graphClones++;
      return clone(value, ...args);
    });
    try {
      await store.transact(() => undefined, { isolated: true, cloneResult: false, skipSaveIfUnchanged: true });
      assert.equal(graphClones, 1, `Only one business graph clone for ${count} rows.`);
      graphClones = 0;
      await store.replaceState(candidate, { cloneInput: false, returnSnapshot: false, skipSaveIfUnchanged: true });
      assert.equal(graphClones, 0, 'The detached composition candidate is adopted directly.');
      assert.equal(saves, 0);
      assert.equal(store.revision, revision);
      assert.deepEqual(await fs.readFile(store.file), bytes, 'Unchanged composition appends no journal bytes.');
      assert.equal(store.state.tables.x_item.length, count);
      assert.equal(store.state.tables.x_item.at(-1).value, 'local edit');
    } finally {
      mock.mock.restore();
    }
  }
});

test('metadata inventory work scales with metadata once per read, independent of business-row count', () => {
  for (const forms of [8, 256]) {
    let scans = 0,
      revision = 0;
    const state = {
      tables: {
        systemform: Array.from({ length: forms }, (_, index) => ({
          formid: `f-${index}`,
          get name() {
            scans++;
            return `Form ${index}`;
          },
          settings: { title: 'original' },
        })),
      },
      dataverse: { sourceSolutionComponents: { baseline: { 'systemform/f-0': {} } } },
    };
    const base = {
        forms: state.tables.systemform.map((row) => ({ id: row.formid, entity: 'x_item', xml: '<form/>' })),
      },
      overlay = createSolutionMetadataOverlay();
    const counts = [];
    for (const businessRows of [16, 4096]) {
      scans = 0;
      const result = overlay.withReadEpoch(() => {
        const first = overlay(base, state);
        for (let row = 0; row < businessRows; row++) assert.equal(overlay(base, state), first);
        return first;
      });
      assert.equal(typeof result.then, 'undefined', 'Synchronous status consumers remain synchronous.');
      counts.push(scans);
    }
    assert.ok(
      counts.every((count) => count <= forms * 2),
      `${forms} forms read ${counts} times.`,
    );
    overlay.withReadEpoch(
      () => {
        const first = overlay(base, state);
        state.tables.systemform[0].settings.title = 'changed';
        revision++;
        assert.notEqual(overlay(base, state), first, 'A committed metadata revision expires the current scope.');
      },
      { revision: () => revision },
    );
  }
});

test('unchanged component checks avoid rebuilding field stamp trees and still detect structured in-place edits', (t) => {
  const size = 512;
  const rows = Array.from({ length: size }, (_, index) => ({
    formid: 'f-' + index,
    name: 'Form',
    formxml: '<form/>',
    settings: { enabled: true },
  }));
  const state = {
    tables: { systemform: rows },
    dataverse: { sourceSolutionComponents: { baseline: { 'systemform/f-0': {} } } },
  };
  const base = { forms: rows.map((row) => ({ id: row.formid, xml: row.formxml })) };
  const overlay = createSolutionMetadataOverlay();
  const first = overlay(base, state);
  const entries = Object.entries;
  let rowEntryCopies = 0;
  const rowSet = new Set(rows);
  const mock = t.mock.method(Object, 'entries', (value) => {
    if (rowSet.has(value)) rowEntryCopies++;
    return entries(value);
  });
  for (let read = 0; read < 8; read++) assert.equal(overlay(base, state), first);
  assert.equal(rowEntryCopies, 0, 'unchanged reads do not allocate one entry pair per field per component');
  mock.mock.restore();
  rows.at(-1).settings.enabled = false;
  const changed = overlay(base, state);
  assert.notEqual(changed, first);
  rows.at(-1).name = 'Edited locally';
  assert.equal(overlay(base, state).forms.at(-1).name, 'Edited locally');
  delete rows.at(-1).settings;
  assert.notEqual(overlay(base, state), changed);
  rows.push({ formid: 'new', formxml: '<form/>' });
  assert.notEqual(overlay(base, state), changed);
});

test('built-in startup metadata scans are bounded across tables and trusted extensions still see direct edits', async (t) => {
  const state = emptyState();
  let scans = 0;
  const forms = 16;
  state.tables.systemform = Array.from({ length: forms }, (_, index) => ({ formid: `f-${index}`, name: 'Invented' }));
  state.dataverse = { sourceSolutionComponents: { baseline: { 'systemform/f-0': {} } } };
  for (let index = 0; index < 64; index++) {
    const entity = `x_table${index}`;
    state.mappings[entity] = {
      logicalName: entity,
      entitySet: `${entity}s`,
      idColumn: `${entity}id`,
      nameColumn: 'x_name',
    };
    state.tables[entity] = [];
  }
  const store = new DataStore({ state }),
    overlay = createSolutionMetadataOverlay(),
    base = {
      entities: {},
      forms: Array.from({ length: forms }, (_, index) => ({ id: `f-${index}`, entity: 'x_table0', xml: '<form/>' })),
    };
  for (const row of store.state.tables.systemform) row.settings = { marker: 'metadata-probe' };
  const stringify = JSON.stringify;
  const mock = t.mock.method(JSON, 'stringify', (value, ...args) => {
    if (value?.marker === 'metadata-probe') scans++;
    return stringify(value, ...args);
  });
  const organization = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({ enabled: false }),
    metadataFields: (logical) => overlay(base, store.state).entities?.[logical]?.fields,
    readMetadata: (fn) => overlay.withReadEpoch(fn),
    extensions: [
      ...EXTENSIONS,
      {
        install(api) {
          const first = overlay(base, api.store.state);
          api.store.state.tables.systemform[0].formxml = '<form><tabs/></form>';
          assert.notEqual(
            overlay(base, api.store.state),
            first,
            'Arbitrary extension writes do not inherit a stale startup snapshot.',
          );
        },
      },
    ],
  });
  try {
    assert.ok(scans <= forms * 8, `${scans} source row reads for ${forms} forms and 64 tables.`);
  } finally {
    mock.mock.restore();
    await organization.close();
  }
});

test('organization seeders checkpoint once, keep existing rows and roll back failed composition', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'paqvilo-bootstrap-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = emptyState();
  state.mappings.x_item = { entitySet: 'x_items', idColumn: 'x_itemid' };
  state.tables.x_item = [{ x_itemid: 'local', value: 'Keep this local edit' }];
  const file = path.join(root, 'state.json'),
    store = await new DataStore({ file, state, persistence: { journalThresholdBytes: 0 } }).init();
  let saves = 0;
  store.onSave = () => saves++;
  const extensions = Array.from({ length: 12 }, (_, i) => ({
    install: (api) =>
      api.store.transact(() => {
        api.store.state.tables[`x_seed${i}`] ??= [];
      }),
  }));
  const options = { store, settings: dataverseSettings({ enabled: false }), extensions };
  const core = await createOrganizationRuntime(options);
  assert.equal(saves, 1, 'All extension seeders share a single durable checkpoint.');
  assert.equal(store.tableRows('x_item')[0].value, 'Keep this local edit');
  await core.close();
  saves = 0;
  const restart = await createOrganizationRuntime(options);
  await restart.close();
  assert.equal(saves, 0, 'Insert-only unchanged bootstrap does not rewrite business state.');
  const before = store.snapshot(),
    bytes = await fs.readFile(file);
  await assert.rejects(
    createOrganizationRuntime({
      ...options,
      extensions: [
        {
          install: (api) =>
            api.store.transact(() => {
              api.store.state.tables.x_item[0].value = 'Must roll back';
            }),
        },
        {
          install() {
            throw Error('Invented failure');
          },
        },
      ],
    }),
    /Invented failure/,
  );
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(await fs.readFile(file), bytes);
  let closed = 0;
  const save = store.save.bind(store);
  store.save = async () => {
    throw Error('Invented checkpoint failure');
  };
  await assert.rejects(
    createOrganizationRuntime({
      ...options,
      extensions: [
        {
          install: (api) =>
            api.store.transact(() => {
              api.store.state.tables.x_item[0].value = 'Not durable';
            }),
          close() {
            closed++;
          },
        },
      ],
    }),
    /Invented checkpoint failure/,
  );
  store.save = save;
  assert.equal(closed, 1, 'An organization whose final checkpoint fails closes its installed resources.');
  assert.deepEqual(store.snapshot(), before);
  assert.deepEqual(await fs.readFile(file), bytes);
});

test('deferred startup callbacks read committed state while a later isolated transaction is open', async () => {
  const state = emptyState();
  state.tables.x_item = [{ value: 'startup' }];
  const store = await new DataStore({ state }).init();
  let releaseContinuation, releaseIsolation, isolationEntered, continuation;
  const continuationGate = new Promise((resolve) => {
    releaseContinuation = resolve;
  });
  const core = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({ enabled: false }),
    extensions: [
      {
        install(api) {
          // Promise callbacks inherit their registration's async context, just as an
          // extension timer does after startup has committed and its frame has closed.
          continuation = continuationGate.then(() => api.store.state.tables.x_item[0].value);
        },
      },
    ],
  });
  await store.transact(() => {
    store.state.tables.x_item[0].value = 'committed after bootstrap';
  });
  const entered = new Promise((resolve) => {
    isolationEntered = resolve;
  });
  const isolationGate = new Promise((resolve) => {
    releaseIsolation = resolve;
  });
  const isolated = store.transact(
    async () => {
      store.state.tables.x_item[0].value = 'private pending transaction';
      isolationEntered();
      await isolationGate;
    },
    { isolated: true },
  );
  try {
    await entered;
    releaseContinuation();
    assert.equal(await continuation, 'committed after bootstrap');
  } finally {
    releaseIsolation();
    await isolated;
    await core.close();
  }
});

test('catalogue metadata epoch reuses one snapshot and expires before later source or raw metadata edits', async () => {
  const overlay = createSolutionMetadataOverlay();
  const base = { forms: [{ id: 'form-one', entity: 'x_item', xml: '<form/>' }] };
  let xml = '<form/>',
    scans = 0,
    deferred,
    release;
  const row = {
    formid: 'form-one',
    get formxml() {
      scans++;
      return xml;
    },
  };
  const state = {
    tables: { systemform: [row] },
    dataverse: { sourceSolutionComponents: { baseline: { 'systemform/form-one': {} } } },
  };
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await overlay.withReadEpoch(async () => {
    const first = overlay(base, state),
      counted = scans;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(overlay(base, state), first);
    assert.equal(scans, counted, 'Repeated table/field reads do not rescan source rows.');
    deferred = gate.then(() => overlay(base, state));
  });
  xml = '<form><tabs/></form>';
  release();
  const changed = await deferred;
  assert.equal(changed.forms[0].xml, xml, 'Deferred callbacks cannot reuse a completed read epoch.');
  await overlay.withReadEpoch(() => {
    const next = { ...base, forms: [{ ...base.forms[0], name: 'Changed source' }] };
    assert.equal(overlay(next, state).forms[0].name, 'Changed source');
    assert.equal(
      overlay(base, state).forms[0].name,
      undefined,
      "An epoch does not return another metadata input's value.",
    );
  });
});

test('overlay invalidates column metadata, component presence and same-ID solution asset edits', () => {
  const overlay = createSolutionMetadataOverlay();
  const base = {
    entities: { x_item: { fields: { x_name: { label: 'Original' } } } },
    forms: [{ id: 'f', entity: 'x_item', xml: '<form/>' }],
  };
  const state = {
    tables: { systemform: [{ formid: 'f' }] },
    mappings: { x_item: { fields: { x_name: { columnMetadata: { labels: { 1033: 'First' }, isSecured: false } } } } },
    dataverse: { sourceSolutionComponents: { baseline: { 'systemform/f': {} } } },
  };
  const first = overlay(base, state);
  state.mappings.x_item.fields.x_name.columnMetadata.labels[1033] = 'Second';
  state.mappings.x_item.fields.x_name.columnMetadata.isSecured = true;
  const changed = overlay(base, state);
  assert.notEqual(changed, first);
  assert.equal(changed.entities.x_item.fields.x_name.label, 'Second');
  assert.equal(changed.entities.x_item.fields.x_name.isSecured, true);
  assert.equal(
    first.entities.x_item.fields.x_name.columnMetadata.labels[1033],
    'First',
    'Published metadata does not retain mutable nested mapping values',
  );
  const withoutLayers = structuredClone(state);
  delete withoutLayers.dataverse.sourceSolutionComponents;
  assert.equal(
    overlay(base, withoutLayers).entities.x_item.fields.x_name.label,
    'Second',
    'Relevant mapping changes also apply without imported layers or a baseline',
  );
  state.tables.systemform = [];
  const absent = overlay(base, state);
  assert.equal(absent.forms.length, 0);
  delete state.dataverse.sourceSolutionComponents.baseline['systemform/f'];
  state.dataverse.sourceSolutionComponents.baseline.other = {};
  assert.equal(overlay(base, state).forms.length, 1, 'component presence changes invalidate without a row edit');
  const bytes = Buffer.from('<Entity><Name>x_item</Name></Entity>');
  const entry = {
    name: 'Entities/x_item/Entity.xml',
    bytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    content: bytes.toString('base64'),
  };
  state.dataverse.solutionAssets = { layers: [{ id: 'invented-layer', ownerSolutionId: 'owner', entries: [entry] }] };
  overlay(base, state);
  entry.content = Buffer.from('tampered').toString('base64');
  assert.throws(
    () => overlay(base, state),
    /integrity/,
    'cached parsed assets cannot conceal a same-ID integrity failure',
  );
});

test('lazy catalogue inventories every table without reading unrelated form bodies and preserves the complete contract', async () => {
  const mappings = {},
    entities = {},
    forms = [];
  const reads = new Map();
  for (let index = 0; index < 80; index++) {
    const entity = 'x_table' + index;
    mappings[entity] = { idColumn: entity + 'id', nameColumn: 'x_name' };
    entities[entity] = { fields: { x_name: { name: 'x_name', type: 'string', label: 'Name' } } };
    forms.push({
      id: 'form' + index,
      entity,
      get xml() {
        reads.set(entity, (reads.get(entity) ?? 0) + 1);
        return '<form><tabs><tab name="main"><columns><column><sections><section><rows><row><cell><control datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs></form>';
      },
    });
  }
  const options = { mappings, metadata: { entities, forms } };
  const lazy = await appCatalogueAsync({ ...options, lazy: true });
  assert.equal(Object.keys(lazy.tableIndex).length, 80);
  assert.equal(reads.size, 0, 'index construction never compiles form bodies');
  assert.equal(lazy.tables.x_table79.forms.length, 1);
  assert.deepEqual([...reads.keys()], ['x_table79']);
  assert.deepEqual(
    JSON.parse(JSON.stringify(lazy)),
    JSON.parse(JSON.stringify(appCatalogue(options))),
    'enumerating the complete catalogue retains every table, form, view, control and source',
  );
});

test('metadata reuse stops before a potentially mutating read plug-in runs', async () => {
  const overlay = createSolutionMetadataOverlay(),
    state = emptyState();
  state.tables.systemform = [{ formid: 'form-one', formxml: '<form/>' }];
  state.dataverse = { sourceSolutionComponents: { baseline: { 'systemform/form-one': {} } } };
  const store = new DataStore({ state }),
    base = { forms: [{ id: 'form-one', entity: 'x_item', xml: '<form/>' }] };
  await store.readOperation(() =>
    overlay.withReadEpoch(
      () => {
        const first = overlay(base, store.state);
        assert.equal(store.isUnmodifiedRead(), true);
        store.ensureReadSnapshot();
        store.state.tables.systemform[0].formxml = '<form><tabs/></form>';
        assert.equal(store.isUnmodifiedRead(), false);
        assert.notEqual(overlay(base, store.state), first);
        assert.equal(overlay(base, store.state).forms[0].xml, '<form><tabs/></form>');
      },
      { valid: () => store.isUnmodifiedRead() },
    ),
  );
});

test('temporarily invalid metadata scopes never restore the cached projection from before a write', () => {
  const overlay = createSolutionMetadataOverlay(),
    base = { forms: [{ id: 'f', xml: '<form/>' }] },
    state = {
      tables: { systemform: [{ formid: 'f', name: 'Before' }] },
      dataverse: { sourceSolutionComponents: { baseline: { 'systemform/f': {} } } },
    };
  let valid = true;
  overlay.withReadEpoch(
    () => {
      overlay(base, state);
      valid = false;
      state.tables.systemform[0].name = 'After';
      assert.equal(overlay(base, state).forms[0].name, 'After');
      valid = true;
      assert.equal(overlay(base, state).forms[0].name, 'After');
    },
    { valid: () => valid },
  );
});

test('explicit nested metadata boundaries enforce both validity and revisions and expire the outer snapshot', () => {
  const overlay = createSolutionMetadataOverlay(),
    base = { forms: [{ id: 'f', xml: '<form/>' }] },
    state = {
      tables: { systemform: [{ formid: 'f', name: 'Before' }] },
      dataverse: { sourceSolutionComponents: { baseline: { 'systemform/f': {} } } },
    };
  let outerValid = true,
    revision = 0;
  overlay.withReadEpoch(
    () => {
      overlay(base, state);
      overlay.withReadEpoch(
        () => {
          state.tables.systemform[0].name = 'Direct inner write';
          assert.equal(overlay(base, state).forms[0].name, 'Direct inner write');
        },
        { valid: () => false },
      );
      assert.equal(overlay(base, state).forms[0].name, 'Direct inner write');
      overlay.withReadEpoch(
        () => {
          overlay(base, state);
          state.tables.systemform[0].name = 'New revision';
          revision++;
          assert.equal(overlay(base, state).forms[0].name, 'New revision');
          outerValid = false;
          state.tables.systemform[0].name = 'Invalid parent';
          assert.equal(overlay(base, state).forms[0].name, 'Invalid parent');
        },
        { revision: () => revision },
      );
    },
    { valid: () => outerValid },
  );
});

test('cooperative catalogue construction preserves the complete synchronous contract and supports cancellation', async () => {
  const options = {
    mappings: Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [`x_table${i}`, { idColumn: 'id', fields: { name: { type: 'nvarchar' } } }]),
    ),
  };
  assert.deepEqual(await appCatalogueAsync(options), appCatalogue(options));
  let checks = 0;
  await assert.rejects(appCatalogueAsync(options, { cancelled: () => ++checks > 3 }), (error) => error.status === 499);
  assert.deepEqual(
    await appCatalogueAsync(options),
    appCatalogue(options),
    'Cancellation does not retain a partially built catalogue.',
  );
});

for (const watch of [false, true])
  test(`catalogue invalidates source, form and field-security metadata with watch ${watch}`, async (t) => {
    const fixture = await performanceFixture({ tables: 2, records: 8 });
    ownedFixture(t).remove(fixture.cleanup);
    for (let i = 0; i < 2; i++) {
      const file = path.join(fixture.solutionRoots[0], `Entities/x_scale${i}/Entity.xml`);
      await fs.writeFile(
        file,
        (await fs.readFile(file, 'utf8')).replace(
          '</EntitySetName>',
          '</EntitySetName><OwnershipTypeMask>UserOwned</OwnershipTypeMask>',
        ),
      );
    }
    const sim = await createSimulator({
      runtime: { kind: 'model-driven' },
      solutionRoots: fixture.solutionRoots,
      watch,
      packs: [fixture.pack],
      preset: 'invented-scale',
      presetMode: 'bootstrap',
      dataverse: {
        enabled: false,
        users: [
          {
            objectId: performanceId(700),
            domainname: 'invented@example.test',
            fullname: 'Invented restricted staff',
            roles: ['Basic User'],
          },
        ],
      },
    });
    ownedFixture(t).add(() => sim.close());
    const session = await (await fetch(sim.url + '/_sim/api/dataverse/session')).json();
    const selected = await fetch(sim.url + '/_sim/api/dataverse/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf },
      body: JSON.stringify({ userId: session.users.find((user) => user.name === 'Invented restricted staff').id }),
    });
    assert.equal(selected.status, 200);
    const cookie = selected.headers.get('set-cookie').split(';')[0];
    const catalogue = async () =>
      await (await fetch(sim.url + '/_apps/api/metadata/x_scale0', { headers: { cookie } })).json();
    const before = await catalogue();
    assert.equal(before.capabilities.fields.x_value1.read, false);
    const csrf = sim.csrf,
      headers = { 'content-type': 'application/json', 'x-sim-csrf': csrf };
    const made = await fetch(sim.url + '/_apps/api/tables/x_scale0', {
      method: 'POST',
      headers: { ...headers, cookie },
      body: JSON.stringify({ x_value0: 'Invented staff row' }),
    });
    assert.equal(made.status, 201);
    const created = await made.json();
    const saved = await fetch(sim.url + '/_apps/api/tables/x_scale0/' + created.id, {
      method: 'PATCH',
      headers: { ...headers, 'if-match': created.etag },
      body: JSON.stringify({ x_value1: 'Must stay masked' }),
    });
    assert.equal(saved.status, 200);
    const read = async (route) => {
      const response = await fetch(sim.url + '/_apps/api/' + route, { headers: { cookie } });
      assert.equal(response.status, 200);
      return response.json();
    };
    const recordRoute = 'tables/x_scale0/' + created.id;
    assert.equal((await read(recordRoute)).row.x_value1, null);
    const grid = await read(
      'tables/x_scale0?query=' +
        encodeURIComponent(
          JSON.stringify({
            columns: ['x_value0', 'x_value1'],
            filters: [{ field: 'x_value0', operator: 'eq', value: 'Invented staff row' }],
            pageSize: 50,
          }),
        ),
    );
    assert.equal(grid.rows.length, 1);
    assert.ok(grid.rows[0].x_value1 == null);
    assert.doesNotMatch(JSON.stringify(grid), /Must stay masked/);
    const entityFile = path.join(fixture.solutionRoots[0], 'Entities/x_scale0/Entity.xml'),
      formFile = path.join(fixture.solutionRoots[0], 'Entities/x_scale0/FormXml/main/form.xml');
    await fs.writeFile(
      entityFile,
      (await fs.readFile(entityFile, 'utf8'))
        .replace('<IsSecured>1</IsSecured>', '<IsSecured>0</IsSecured>')
        .replace(
          '</attributes>',
          '<attribute PhysicalName="x_added"><Name>x_added</Name><Type>nvarchar</Type></attribute></attributes>',
        ),
    );
    await fs.writeFile(
      formFile,
      (await fs.readFile(formFile, 'utf8')).replace(
        '</rows>',
        '<row><cell><control datafieldname="x_added"/></cell></row></rows>',
      ),
    );
    if (!watch) await sim.reload();
    let changed;
    const deadline = performance.now() + 120_000;
    do {
      changed = await catalogue();
      if (changed.fields.x_added && changed.capabilities.fields.x_value1.read) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (performance.now() < deadline);
    assert.ok(changed.fields.x_added);
    assert.equal(changed.capabilities.fields.x_value1.read, true);
    assert.equal(
      (await read(recordRoute)).row.x_value1,
      'Must stay masked',
      'The next record read uses changed source security metadata.',
    );
    assert.ok(
      changed.forms.some((form) =>
        form.tabs.some((tab) =>
          tab.sections.some((section) => section.fields.some((field) => field.name === 'x_added')),
        ),
      ),
    );
  });

test('catalogue yields to status while retaining one security read and releases cancelled readers', async (t) => {
  const store = new DataStore(),
    tables = Object.fromEntries(
      Array.from({ length: 64 }, (_, i) => [
        `x_item${i}`,
        { fields: { name: {} }, rows: [{ name: 'Never expose rows' }] },
      ]),
    );
  const json = (res, status, value) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  let checks = 0,
    entered;
  const started = () =>
    new Promise((resolve) => {
      entered = resolve;
    });
  const handler = createModelDrivenHandler({
    catalogue: () => ({ tables }),
    data: {
      capabilities(name, actor, id, fields) {
        entered?.();
        entered = null;
        checks++;
        assert.equal(fields, tables[name].fields);
        const until = performance.now() + 2;
        while (performance.now() < until) {
          /* simulated bounded table work */
        }
        return { read: store.state.settings.permissionMode === 'enforce' };
      },
    },
    read: (fn) => store.readOperation(fn),
    csrf: () => 'invented',
    json,
  });
  // The latest catalogue request's handler settles only once it has stopped working, answered or not.
  let handled;
  const server = http.createServer(async (req, res) => {
    if (req.url === '/status') return json(res, 200, { running: true });
    handled = handler(req, res, new URL(req.url, 'http://127.0.0.1'));
    await handled;
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(resolve);
      }),
  );
  const origin = `http://127.0.0.1:${server.address().port}`,
    admission = started();
  let complete = false;
  const pending = fetch(origin + '/_apps/api')
    .then((response) => response.json())
    .finally(() => {
      complete = true;
    });
  await admission;
  const write = store.transact(() => {
    store.state.settings.permissionMode = 'permissive';
  });
  const status = await fetch(origin + '/status');
  assert.equal(status.status, 200);
  assert.equal(complete, false, 'Unrelated status completes before catalogue work finishes.');
  const value = await pending;
  assert.equal(checks, 64);
  assert.ok(Object.values(value.tables).every((table) => table.capabilities.read && !Object.hasOwn(table, 'rows')));
  await write;
  const abort = new AbortController(),
    admitted = started();
  checks = 0;
  const cancelled = fetch(origin + '/_apps/api', { signal: abort.signal }).catch((error) => error);
  await admitted;
  abort.abort();
  await cancelled;
  await handled;
  await store.readOperation(() => assert.equal(store.state.settings.permissionMode, 'permissive'));
  assert.ok(checks < 64, `A disconnected consumer stopped after ${checks} of 64 tables instead of computing them all.`);
});

// docs/runtime-performance.md: the probe's defaults are its declared budgets (30,000 ms per startup and catalogue
// response, 1,000 ms per status heartbeat and first grid or record read), while the ordinary suite checks invariants
// instead of elapsed time. The suite therefore runs the probe with those budgets in recording mode: a miss on a loaded
// machine is a finding, never a failure, but every finding must be an honest latency record. Only a status request may
// end in its own timeout; a failed catalogue, first status or data read still fails the test.
const PROBE = { budgetMs: 30000, heartbeatBudgetMs: 1000, strictBudgets: false };
function assertLatencyFindingsOnly(report) {
  assert.deepEqual(
    [report.budgetMs, report.catalogueBudgetMs, report.heartbeatBudgetMs, report.dataBudgetMs, report.strictBudgets],
    [PROBE.budgetMs, PROBE.budgetMs, PROBE.heartbeatBudgetMs, PROBE.heartbeatBudgetMs, false],
    'The report states the documented budgets it measured against.',
  );
  for (const finding of report.findings) {
    const text = JSON.stringify(finding);
    if (finding.error) assert.deepEqual([finding.stage, finding.error], ['status request', 'TimeoutError'], text);
    // durationMs is rounded; the probe records a finding only when the raw duration exceeded the budget.
    else assert.ok(finding.stage && finding.durationMs >= finding.budgetMs, text);
  }
}

for (const portal of [false, true])
  test(
    `${portal ? 'portal' : 'standalone'} fresh, unchanged and grown-journal startup retains bootstrap data and reports costs`,
    { timeout: 60000 },
    async (t) => {
      // The reuse assertions below concern files written moments ago.
      settleFileTimes(t);
      const report = await runtimePerformance({ ...PROBE, scales: [2], records: 32, portal });
      assertLatencyFindingsOnly(report);
      assert.deepEqual(
        report.results.map((result) => result.generated),
        [1, 0, 0],
      );
      assert.deepEqual(
        report.results.map((result) => result.preset.applied),
        [true, false, false],
      );
      assert.ok(
        report.results.every(
          (result) => result.rows === 16 && result.timings.stateRestoreMs >= 0 && result.timings.organizationMs >= 0,
        ),
      );
      assert.ok(report.results[1].timings.solutionCache.hits > 0);
      assert.equal(report.results[1].timings.solutionCache.misses, 0);
      assert.equal(report.results[2].timings.stateRestore.journal, true);
      for (const result of report.results) {
        assert.equal(result.metadataTransport.length, 4);
        assert.ok(result.metadataTransport.every((read) => read.bytes > 0 && read.parseMs >= 0));
        assert.deepEqual(
          result.progress
            .filter((entry) =>
              ['state-restore', 'state-composition', 'preset', 'organization', 'listener', 'listener-ready'].includes(
                entry.phase,
              ),
            )
            .map((entry) => entry.phase),
          ['state-restore', 'state-composition', 'preset', 'organization', 'listener', 'listener-ready'],
        );
        assert.ok(result.progress.every((entry, i) => entry.elapsedMs >= (result.progress[i - 1]?.elapsedMs ?? 0)));
      }
    },
  );

test(
  'optional source-volume probe retains every form and the exact requested records on a small fixture',
  { timeout: 60000 },
  async () => {
    assert.ok(LARGE_PERFORMANCE_OPTIONS.scales[0] * (1 + LARGE_PERFORMANCE_OPTIONS.formsPerTable) + 2 > 10000);
    // The fixture inventory and record count are settled by the first start. Restarts are covered by the cases above,
    // and restarts with several forms per table by test/runtime-performance-options.test.mjs.
    const report = await runtimePerformance({
      ...PROBE,
      scales: [2],
      formsPerTable: 3,
      columns: 4,
      records: 17,
      portal: false,
      phases: ['fresh'],
    });
    assertLatencyFindingsOnly(report);
    assert.deepEqual(
      report.results.map((result) => result.phase),
      ['fresh'],
      'The start completed its catalogue, metadata and data checks.',
    );
    for (const result of report.results) {
      assert.equal(result.inventory.xmlFiles, 10);
      assert.equal(result.inventory.forms, 6);
      assert.equal(result.actualRecords, 17);
      assert.equal(result.rows, 9);
      assert.ok(result.inventory.sourceBytes > 0);
      assert.ok(result.fixtureMs >= 0);
    }
  },
);
