// Loopback fixtures exercise the same policy through actual HTTP hosts.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { modelDrivenFixture } from './model-driven-fixture.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const CLIENT = '99999999-9999-4999-8999-999999999998';
const ITEM = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const label = (text) => ({ LocalizedLabels: [{ Label: text, LanguageCode: 1033 }] });
const newTable = () => ({
  '@odata.type': '#Microsoft.Dynamics.CRM.EntityMetadata',
  SchemaName: 'new_Persisted',
  DisplayName: label('Persisted'),
  DisplayCollectionName: label('Persisted rows'),
  OwnershipType: 'UserOwned',
  IsActivity: false,
  HasActivities: false,
  HasNotes: false,
  Attributes: [
    {
      '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata',
      SchemaName: 'new_Name',
      DisplayName: label('Name'),
      IsPrimaryName: true,
      MaxLength: 100,
      FormatName: { Value: 'Text' },
    },
  ],
});
async function body(response, expected = 200) {
  const text = await response.text();
  assert.equal(response.status, expected, text);
  return text ? JSON.parse(text) : null;
}
async function pack(t, level) {
  // Persistence refuses declared files below a symbolic link (lib/transactional-files.mjs), and a runner's temporary
  // directory may be one (a symlinked TMPDIR, macOS /var): start from its real path.
  const root = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), 'mirage-simulation-runtime-')));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'data.json'),
    module = path.join(root, 'pack.mjs');
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        records: [{ x_itemid: ITEM, x_name: 'Pack source', x_quantity: 2 }],
        schema: {},
        newTables: {},
        unrelated: 'Retained',
      },
      null,
      2,
    ),
  );
  await fs.writeFile(
    module,
    `export default {id:'runtime-data',name:'Runtime data',description:'Invented fixture',matches:()=>true,presets:()=>({}),dataFiles:[{file:'data.json',tables:{x_item:{path:['records'],idColumn:'x_itemid'}},schemaPath:['schema'],newTablesPath:['newTables']}]};`,
  );
  return {
    file,
    module,
    options: { packs: [module], simulation: { level }, dataverse: { enabled: true, tds: { enabled: false } } },
  };
}
async function client(sim) {
  const headers = { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf };
  const application = await body(
    await fetch(sim.url + '/_sim/api/dataverse/applications', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        appId: CLIENT,
        displayName: 'Invented simulation client',
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
        client_secret: application.secret,
        scope: sim.dataverse.origin + '/.default',
      }),
    }),
  );
  return {
    privateSecret: application.secret,
    org: (method, suffix, value) =>
      fetch(sim.dataverse.origin + '/api/data/v9.2' + suffix, {
        method,
        headers: {
          authorization: `Bearer ${token.access_token}`,
          ...(value ? { 'content-type': 'application/json', prefer: 'return=representation' } : {}),
        },
        ...(value ? { body: JSON.stringify(value) } : {}),
      }),
    ui: (method, suffix, value, etag) =>
      fetch(sim.url + '/_apps/api' + suffix, {
        method,
        headers: { ...headers, ...(etag ? { 'if-match': etag } : {}) },
        ...(value ? { body: JSON.stringify(value) } : {}),
      }),
  };
}

for (const level of ['dry-run', 'simulation', 'deep'])
  test(`actual portal/API/model-driven host enforces ${level} and shared record persistence`, async (t) => {
    const data = await pack(t, level),
      original = await fs.readFile(data.file);
    const fixture = await modelDrivenFixture(t, data.options),
      { sim } = fixture,
      c = await client(sim);
    const current = await body(await c.ui('GET', `/tables/x_item/${ITEM}`));
    await body(await c.ui('PATCH', `/tables/x_item/${ITEM}`, { x_name: 'Changed in model app' }, current.etag));
    assert.equal((await body(await c.org('GET', `/x_items(${ITEM})`))).x_name, 'Changed in model app');
    const made = await body(await c.org('POST', '/x_items', { x_name: 'API created', x_quantity: 8 }), 201);
    assert.equal((await body(await c.ui('GET', `/tables/x_item/${made.x_itemid}`))).row.x_name, 'API created');
    const policy = await body(await fetch(sim.url + '/_sim/api/simulation'));
    assert.equal(policy.level, level);
    assert.equal(policy.controlPlanePersistence, level === 'dry-run' ? 'memory' : 'private-local-state');
    if (level === 'dry-run') {
      assert.deepEqual(await fs.readFile(data.file), original);
      await assert.rejects(fs.stat(fixture.stateFile), { code: 'ENOENT' });
      assert.deepEqual((await fs.readdir(fixture.root)).sort(), ['portal', 'solution']);
    } else {
      const records = JSON.parse(await fs.readFile(data.file, 'utf8'));
      assert.equal(records.records[0].x_name, 'Changed in model app');
      assert.equal(records.records[1].x_itemid, made.x_itemid);
      assert.equal(records.unrelated, 'Retained');
      assert.ok(!JSON.stringify(records).includes(c.privateSecret));
      assert.equal(records.applications, undefined);
    }
    const metadata = await c.org('POST', '/EntityDefinitions', newTable());
    if (level === 'deep') {
      await body(metadata, 204);
      const table = sim.store.state.mappings.new_persisted;
      const record = await body(await c.org('POST', '/' + table.entitySet, { new_name: 'Deep record' }), 201);
      const document = JSON.parse(await fs.readFile(data.file, 'utf8'));
      assert.equal(document.schema.mappings.new_persisted.idColumn, table.idColumn);
      assert.equal(document.newTables.new_persisted[0][table.idColumn], record[table.idColumn]);
    } else {
      await body(metadata, 403);
      assert.equal(sim.store.state.mappings.new_persisted, undefined);
    }
    await sim.close();
    // Pack data is authoritative, rather than a second copy that depends on the
    // private checkpoint to survive a restart.
    if (level !== 'dry-run') await fs.rm(fixture.stateFile);
    const restarted = await fixture.start();
    assert.equal(
      restarted.store.tableRows('x_item')[0].x_name,
      level === 'dry-run' ? 'Pack source' : 'Changed in model app',
    );
    assert.equal(restarted.store.tableRows('x_item').length, level === 'dry-run' ? 1 : 2);
    if (level === 'deep') assert.equal(restarted.store.tableRows('new_persisted')[0].new_name, 'Deep record');
  });

test('deep source-table columns survive source reload and checkpoint-free restart from declared schema DATA', async (t) => {
  const data = await pack(t, 'deep');
  const fixture = await modelDrivenFixture(t, { ...data.options, initial: undefined });
  const source = await fs.readFile(path.join(fixture.solutionDir, 'Entities', 'x_item', 'Entity.xml'));
  let sim = fixture.sim,
    c = await client(sim);
  assert.ok(
    sim.store.state.mappings.x_item.metadataSources?.length,
    'Use an imported source mapping rather than an explicit configured mapping.',
  );
  await body(
    await c.org('POST', "/EntityDefinitions(LogicalName='x_item')/Attributes", {
      '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata',
      SchemaName: 'new_Extra',
      DisplayName: label('Extra'),
      MaxLength: 100,
    }),
    204,
  );
  await body(await c.org('PATCH', `/x_items(${ITEM})`, { new_extra: 'Retained record value' }));
  assert.ok(JSON.parse(await fs.readFile(data.file, 'utf8')).schema.mappings.x_item.fields.new_extra);
  await sim.reload();
  assert.ok(
    sim.store.state.mappings.x_item.fields.new_extra,
    'Source refresh must reapply the authored column before publishing state.',
  );
  await sim.close();
  await fs.rm(fixture.stateFile);
  sim = await fixture.start();
  c = await client(sim);
  const metadata = await body(
    await c.org('GET', "/EntityDefinitions(LogicalName='x_item')/Attributes(LogicalName='new_extra')"),
  );
  assert.equal(metadata.LogicalName, 'new_extra');
  assert.equal(
    (await body(await c.org('GET', `/x_items(${ITEM})?$select=new_extra`))).new_extra,
    'Retained record value',
  );
  const catalogue = await body(await fetch(sim.url + '/_apps/api'));
  assert.ok(catalogue.tables.x_item.fields.new_extra, 'MDA sees the same effective source-plus-authored schema.');
  assert.deepEqual(await fs.readFile(path.join(fixture.solutionDir, 'Entities', 'x_item', 'Entity.xml')), source);
});

test('deep declared operation schema keeps source API edits and deletions after reload and checkpoint-free restart', async (t) => {
  // The custom APIs are part of the sources from the first start, so the fixture starts no runtime of its own.
  const data = await pack(t, 'deep'),
    fixture = await modelDrivenFixture(t, { ...data.options, defer: true });
  const files = new Map();
  for (const name of ['new_Kept', 'new_Deleted']) {
    const file = path.join(fixture.solutionDir, 'customapis', name, 'customapi.xml');
    const xml = `<customapi uniquename="${name}"><name>${name}</name><bindingtype>0</bindingtype><isfunction>0</isfunction></customapi>`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, xml);
    files.set(file, xml);
  }
  let sim = await fixture.start();
  let c = await client(sim);
  const keep = sim.store.tableRows('customapi').find((row) => row.uniquename === 'new_Kept');
  const remove = sim.store.tableRows('customapi').find((row) => row.uniquename === 'new_Deleted');
  assert.ok(keep && remove);
  await body(
    await c.org('PATCH', `/customapis(${keep.customapiid})`, {
      uniquename: 'new_Authored',
      description: 'Deep authored description',
    }),
  );
  await body(await c.org('DELETE', `/customapis(${remove.customapiid})`), 204);
  assert.equal(sim.store.storageAdapter.schemaRecordsAuthoritative('customapi'), true);
  await sim.reload();
  assert.equal(
    sim.store.tableRows('customapi').find((row) => row.customapiid === keep.customapiid).uniquename,
    'new_Authored',
  );
  assert.equal(
    sim.store.tableRows('customapi').some((row) => row.customapiid === remove.customapiid),
    false,
  );
  await sim.close();
  await fs.rm(fixture.stateFile);
  sim = await fixture.start();
  c = await client(sim);
  assert.equal(
    (await body(await c.org('GET', `/customapis(${keep.customapiid})`))).description,
    'Deep authored description',
  );
  assert.equal((await c.org('GET', `/customapis(${remove.customapiid})`)).status, 404);
  const metadata = await (await c.org('GET', '/$metadata')).text();
  assert.match(metadata, /Name="new_Authored"/);
  assert.doesNotMatch(metadata, /Name="new_Kept"|Name="new_Deleted"/);
  await body(await c.org('DELETE', `/customapis(${keep.customapiid})`), 204);
  await sim.close();
  await fs.rm(fixture.stateFile);
  sim = await fixture.start();
  assert.deepEqual(
    sim.store.tableRows('customapi'),
    [],
    'An explicit empty schemaRecords table is an authoritative tombstone.',
  );
  for (const [file, xml] of files) assert.equal(await fs.readFile(file, 'utf8'), xml);
});
