import test from 'node:test';
import { qualificationMutationIntent } from '../portal-security/qualification-native-adapters.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import vm from 'node:vm';
import {
  provisionQualificationFixtures,
  restoreQualificationFixtures,
  executeQualificationPortalRequest,
  planQualificationCrudRequest,
  createNativeConfigurationAdapters,
} from '../portal-security/qualification-native-adapters.mjs';
import { planQualificationFixtures } from '../portal-security/qualification-fixtures.mjs';
import { equipmentLifecycleConfigurations } from '../portal-security/qualification-priority.mjs';
import { makeTemporaryDirectory } from 'paqvilo/mirage/testing/owned-fixture.mjs';

const id = (n) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const actor = id(1),
  writer = id(2),
  token = 'uniquerun';
function fixture() {
  return {
    records: ['own-scope', 'same-company-other-branch', 'foreign-company'].map((region, index) => ({
      table: 'asset',
      id: id(index + 3),
      region,
      key: region,
      fields: { name: token + region },
      refs: {},
      deferredRefs: [],
      uniqueRunToken: token,
    })),
    associations: [],
    actorContactId: actor,
    ownAccountId: id(3),
    tables: [{ name: 'asset', entitySet: 'assets', primaryId: 'assetid' }],
    regionRecordIds: { 'own-scope': [id(3)], 'same-company-other-branch': [id(4)], 'foreign-company': [id(5)] },
  };
}
function api() {
  const records = new Map(),
    calls = [];
  return {
    records,
    calls,
    failAfterCommit: false,
    get: async (endpoint) => (endpoint === 'WhoAmI' ? { UserId: writer } : structuredClone(records.get(endpoint))),
    optional: async (endpoint) => structuredClone(records.get(endpoint) ?? null),
    list: async () => [],
    request: async (endpoint, options) => {
      calls.push({ endpoint, options });
      if (options.method === 'DELETE') records.delete(endpoint);
      else {
        if (options.ifNoneMatch && records.has(endpoint)) throw new Error('collision');
        records.set(endpoint, {
          ...records.get(endpoint),
          ...options.body,
          assetid: /\((.*?)\)/.exec(endpoint)?.[1],
          '@odata.etag': 'W/"1"',
        });
      }
      if (apiCurrent.failAfterCommit) {
        apiCurrent.failAfterCommit = false;
        throw new Error('power loss');
      }
    },
  };
}
let apiCurrent;
async function workspace(run) {
  const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'qualification-native-adapters-'));
  try {
    await run(path.join(directory, 'lease.json'));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

test('native fixture lease verifies all regions, journals creates and conditionally restores only its owned identities', async () =>
  workspace(async (journalFile) => {
    const client = (apiCurrent = api()),
      fixtures = fixture();
    const result = await provisionQualificationFixtures(client, fixtures, { journalFile, trustedWriterId: writer });
    assert.equal(result.nativeDataVerified, true);
    assert.deepEqual(result.regionRecordIds, fixtures.regionRecordIds);
    assert.ok(client.calls.every((call) => call.options.ifNoneMatch === '*'));
    const receipt = await restoreQualificationFixtures(client, { journalFile });
    assert.equal(receipt.allRegionsRestored, true);
    assert.equal(client.records.size, 0);
    assert.ok(
      client.calls.filter((call) => call.options.method === 'DELETE').every((call) => call.options.ifMatch === 'W/"1"'),
    );
    const calls = client.calls.length;
    await restoreQualificationFixtures(client, { journalFile });
    assert.equal(client.calls.length, calls);
  }));

test('unknown committed create is not retried and can be recovered; foreign scalar/lookup edits block cleanup', async () =>
  workspace(async (journalFile) => {
    const client = (apiCurrent = api());
    client.failAfterCommit = true;
    await assert.rejects(
      provisionQualificationFixtures(client, fixture(), { journalFile, trustedWriterId: writer }),
      /outcome unknown/,
    );
    assert.equal(client.calls.length, 1);
    assert.equal(client.records.size, 1);
    await restoreQualificationFixtures(client, { journalFile });
    assert.equal(client.records.size, 0);
    await fs.unlink(journalFile);
    await provisionQualificationFixtures(client, fixture(), { journalFile, trustedWriterId: writer });
    client.records.get(`assets(${id(3)})`).name = 'foreign edit';
    await assert.rejects(restoreQualificationFixtures(client, { journalFile }), /Foreign fixture scalar drift/);
    assert.equal((await fs.stat(journalFile)).isFile(), true);
  }));

test('browser mutations use a single origin-confined call and keep unknown responses journalled', async () =>
  workspace(async (journalFile) => {
    let calls = 0,
      writes = 0,
      tokenRequests = 0;
    const context = vm.createContext({
      document: {
        getElementById: () => ({ textContent: '<context contact-id="' + actor + '"><roles></roles></context>' }),
      },
      shell: {
        getTokenDeferred: () => {
          tokenRequests++;
          return {
            done(resolve) {
              resolve('invented-token');
              return this;
            },
            fail() {
              return this;
            },
          };
        },
      },
      fetch: async (url, options) => {
        writes++;
        assert.equal(url, '/_api/assets(' + id(3) + ')');
        assert.equal(options.method, 'DELETE');
        assert.equal(options.redirect, 'error');
        assert.equal(options.credentials, 'same-origin');
        assert.equal(options.cache, 'no-store');
        assert.equal(options.headers.__RequestVerificationToken, 'invented-token');
        return { status: 204, headers: { get: () => null }, text: async () => '' };
      },
    });
    context.window = context;
    const browser = {
      run: async (program) => {
        calls++;
        await vm.runInContext(
          program,
          context,
        )({
          goto: async (url) => assert.equal(url, 'https://portal.invalid/permission-lab/'),
          evaluate: async (callback, input) => callback(input),
        });
        throw new Error('response lost');
      },
    };
    await assert.rejects(
      executeQualificationPortalRequest(browser, {
        portalOrigin: 'https://portal.invalid',
        actorContactId: actor,
        request: { method: 'DELETE', url: `/_api/assets(${id(3)})` },
        journalFile,
      }),
      /outcome unknown/,
    );
    assert.equal(calls, 1);
    assert.equal(writes, 1);
    assert.equal(tokenRequests, 1);
    assert.equal(JSON.parse(await fs.readFile(journalFile)).status, 'unknown');
    await assert.rejects(
      executeQualificationPortalRequest(browser, {
        portalOrigin: 'https://portal.invalid',
        actorContactId: actor,
        request: { method: 'POST', url: 'https://foreign.invalid/_api/assets' },
        journalFile,
      }),
      /escaped/,
    );
    assert.equal(calls, 1);
  }));

test('portal qualification serializes hostile request values as data and rejects nonboolean identity modes', async () =>
  workspace(async (journalFile) => {
    const hostile = '"});globalThis.injected=true;//` ${globalThis.injected=true}\u2028\u2029';
    let browserCalls = 0,
      fetchCalls = 0,
      body;
    const context = vm.createContext({
      document: {
        getElementById: () => ({
          textContent: `<context contact-id="${actor}"><roles><role>A &amp; B &lt;x&gt; &#x1F680;</role></roles></context>`,
        }),
      },
      shell: {
        getTokenDeferred: () => ({
          done(resolve) {
            resolve('invented-token');
            return this;
          },
          fail() {
            return this;
          },
        }),
      },
      fetch: async (url, options) => {
        fetchCalls++;
        body = JSON.parse(options.body);
        assert.equal(options.redirect, 'error');
        assert.equal(options.headers['If-Match'], hostile);
        return { status: 200, headers: { get: () => null }, text: async () => '{}' };
      },
    });
    context.window = context;
    const browser = {
      run: async (program) => {
        browserCalls++;
        return vm.runInContext(
          program,
          context,
        )({
          goto: async (url) => assert.equal(url, 'https://portal.invalid/permission-lab/'),
          evaluate: async (callback, input) => callback(input),
        });
      },
    };
    const options = {
      portalOrigin: 'https://portal.invalid',
      actorContactId: actor,
      request: { method: 'PATCH', url: `/_api/assets(${id(3)})`, ifMatch: hostile, body: { name: hostile } },
      journalFile,
    };
    await assert.rejects(executeQualificationPortalRequest(browser, { ...options, anonymous: hostile }), /Bounded/);
    assert.equal(browserCalls, 0);
    const result = await executeQualificationPortalRequest(browser, options);
    assert.equal(result.wire.status, 200);
    assert.equal(browserCalls, 1);
    assert.equal(fetchCalls, 1);
    assert.equal(body.name, hostile);
    assert.equal(context.injected, undefined);
    assert.deepEqual(Array.from(result.identityReceipt.roleNames), ['A & B <x> 🚀']);
    assert.equal(JSON.parse(await fs.readFile(journalFile)).status, 'response-received');
  }));

test('portal qualification rejects malformed context or embedded markup before any mutation', async () => {
  for (const text of [
    '<context contact-id="wrong"><roles/></context>',
    `<context contact-id="${actor}"><roles><role><script>bad</script></role></roles></context>`,
    `<context contact-id="${actor}"><roles><role>&unknown;</role></roles></context>`,
  ])
    await workspace(async (journalFile) => {
      let writes = 0;
      const context = vm.createContext({
        document: { getElementById: () => ({ textContent: text }) },
        fetch: async () => {
          writes++;
          throw new Error('must not write');
        },
      });
      const browser = {
        run: async (program) =>
          vm.runInContext(
            program,
            context,
          )({ goto: async () => {}, evaluate: async (callback, input) => callback(input) }),
      };
      await assert.rejects(
        executeQualificationPortalRequest(browser, {
          portalOrigin: 'https://portal.invalid',
          actorContactId: actor,
          request: { method: 'DELETE', url: `/_api/assets(${id(3)})` },
          journalFile,
        }),
        /outcome unknown/,
      );
      assert.equal(writes, 0);
    });
});

test('CRUD planning uses independent Create identities and binds Append source versus AppendTo destination by native navigation', () => {
  const fixtures = fixture(),
    own = fixtures.records[0],
    parent = { ...own, id: id(8), table: 'container', fields: { title: token }, refs: {} };
  fixtures.records.push(parent);
  own.refs.containerid = { id: parent.id, table: parent.table };
  const bound = {
    ...fixtures,
    tables: [...fixtures.tables, { name: 'container', entitySet: 'containers', primaryId: 'containerid' }],
    lookupNavigation: { [own.id]: { containerid: 'containerlookup' } },
    requests: [
      {
        kind: 'create',
        endpoint: `assets(${own.id})`,
        body: { name: own.fields.name, 'containerlookup@odata.bind': `/containers(${parent.id})` },
      },
    ],
  };
  const configuration = { query: { table: 'asset', primaryName: 'name' } },
    cell = { operation: 'create', region: 'own-scope' };
  const created = planQualificationCrudRequest({ configuration, cell, fixtures, bound, operationId: id(9) });
  assert.notEqual(created.target.id, own.id);
  assert.equal(created.body.assetid, created.target.id);
  assert.equal(created.body.name, 'CO-OP:' + id(9));
  const schema = {
    relationships: [{ kind: 'oneToMany', child: 'asset', parent: 'container', lookup: { name: 'containerid' } }],
  };
  const append = planQualificationCrudRequest({
    configuration,
    cell: { ...cell, operation: 'append' },
    fixtures,
    bound,
    schema,
  });
  const appendTo = planQualificationCrudRequest({
    configuration: { query: { table: 'container' } },
    cell: { ...cell, operation: 'appendTo' },
    fixtures,
    bound,
    schema,
  });
  assert.equal(append.testedObjectRole, 'append');
  assert.equal(append.target.id, own.id);
  assert.equal(appendTo.testedObjectRole, 'appendTo');
  assert.equal(appendTo.boundTarget.id, parent.id);
  assert.deepEqual(append.body, appendTo.body);
});

test('concrete adapter factory rehydrates an unknown browser mutation from disk before deleting fixtures', async () =>
  workspace(async (journalFile) => {
    const directory = path.dirname(journalFile),
      cellDirectory = path.join(directory, 'm0', 'cell');
    await fs.mkdir(cellDirectory, { recursive: true });
    const client = (apiCurrent = api()),
      baseRequest = client.request;
    client.request = async (endpoint, options) => {
      if (options.method !== 'POST') return baseRequest(endpoint, options);
      const body = options.body,
        primary = endpoint === 'pqvd_testruns' ? 'pqvd_testrunid' : 'pqvd_testoperationid';
      const row = { ...body, '@odata.etag': 'W/"1"', _pqvd_runnercontactid_value: actor };
      if (endpoint === 'pqvd_testoperations') row.pqvd_markeroperation = 'CO-OP:' + body[primary];
      client.records.set(`${endpoint}(${body[primary]})`, row);
    };
    const options = {
      client,
      browser: {
        run: async () => {
          throw new Error('response lost');
        },
      },
      portalOrigin: 'https://portal.invalid',
      actorContactId: actor,
      siteId: id(8),
      trustedWriterId: writer,
      schema: { relationships: [] },
      registrationSource: { steps: [] },
      manifest: {
        suiteVersion: 'test',
        manifestHash: 'a'.repeat(64),
        datasetVersion: 'v1',
        sourceHash: 'b'.repeat(64),
        choices: { pqvd_runstate: { Running: 1 }, pqvd_phase: { Baseline: 1 } },
        navigation: { pqvd_testruns: { pqvd_runnercontactid: 'runner' }, pqvd_testoperations: { pqvd_runid: 'run' } },
      },
      assertExclusiveNativeWriter: async () => {},
      replayNativeCell: async () => {},
      liquidEndpointForConfiguration: async () => '/permission-lab/query/',
      clearPortalCaches: async () => {},
    };
    const adapters = createNativeConfigurationAdapters(options),
      fixtures = fixture();
    await adapters.provisionFixtures({ phase: 'records', fixtures, directory });
    const configuration = { roles: [], query: { table: 'asset', primaryName: 'name', id: 'Q1', variant: 'fixture' } };
    const cell = { operation: 'write', region: 'own-scope', lane: 'webapi' };
    const prepared = await adapters.prepareCell({ cell, configuration, fixtures, directory: cellDirectory, repeat: 0 });
    assert.equal(prepared.boundOperation.target.id, fixtures.records[0].id);
    const stateFile = path.join(cellDirectory, 'native-cell-state-0.json'),
      state = JSON.parse(await fs.readFile(stateFile));
    client.records.get(`assets(${state.request.target.id})`).name = state.request.body.name;
    // A fresh process has no folders/cells map: recovery must use its write-ahead
    // source file, reconcile the known target and restore the original scalar.
    const recovered = createNativeConfigurationAdapters(options);
    await recovered.recoverFixtures({ directory });
    assert.equal(client.records.get(`assets(${state.request.target.id})`).name, fixtures.records[0].fields.name);
    const receipt = await recovered.cleanupFixtures({ directory });
    assert.equal(receipt.allRegionsRestored, true);
    assert.ok([...client.records.keys()].every((key) => !key.startsWith('assets(')));
    assert.ok(
      [...client.records.keys()].some((key) => key.startsWith('pqvd_testoperations(')),
      'recording history must survive fixture cleanup',
    );
  }));

test('Source5 lifecycle fixtures provide actual second owned targets and a cooperating Probe child root', async () => {
  const schema = JSON.parse(await fs.readFile(new URL('../dataverse/manifest.json', import.meta.url))),
    catalogue = JSON.parse(await fs.readFile(new URL('../data/stress-catalogue.json', import.meta.url)));
  schema.relationships.push({
    name: 'pqvd_equipment_crudprobes',
    kind: 'oneToMany',
    parent: 'pqvd_equipment',
    child: 'pqvd_crudprobe',
    lookup: { name: 'pqvd_equipmentid', required: 'none' },
    cascade: { Delete: 'RemoveLink' },
  });
  const configuration = equipmentLifecycleConfigurations({ schema, catalogue }).configurations.find(
    (configuration) =>
      configuration.parameters.leafPrivileges === 63 &&
      configuration.parameters.ancestorProfile === 'cooperating-lookup-targets',
  );
  const fixtures = planQualificationFixtures(configuration, {
    schema,
    catalogue,
    actorContactId: actor,
    runId: id(20),
    ownedRunId: id(21),
    resolvedIds: Object.fromEntries(catalogue.records.map((record) => [record.key, record.id])),
    bindingCohorts: true,
  });
  assert.equal(fixtures.records.length, 33);
  assert.equal(fixtures.records.filter((record) => record.bindingProbe).length, 3);
  const bound = {
    ...fixtures,
    lookupNavigation: Object.fromEntries(
      fixtures.records.map((record) => [
        record.id,
        Object.fromEntries(Object.keys(record.refs).map((field) => [field, field])),
      ]),
    ),
    requests: fixtures.records.map((record) => ({
      kind: 'create',
      endpoint: `${fixtures.tables.find((table) => table.name === record.table).entitySet}(${record.id})`,
      body: {
        ...record.fields,
        ...Object.fromEntries(
          Object.entries(record.refs)
            .filter(([, target]) => target)
            .map(([field, target]) => [
              field + '@odata.bind',
              `/${fixtures.tables.find((table) => table.name === target.table).entitySet}(${target.id})`,
            ]),
        ),
      },
    })),
  };
  const append = planQualificationCrudRequest({
    configuration,
    cell: { operation: 'append', region: 'own-scope' },
    fixtures,
    bound,
    schema,
  });
  const equipment = fixtures.records.find((record) => record.id === append.target.id),
    secondRoom = fixtures.records.find((record) => record.id === append.boundTarget.id);
  assert.notEqual(equipment.refs.pqvd_roomid.id, secondRoom.id);
  const originalRoom = fixtures.records.find((record) => record.id === equipment.refs.pqvd_roomid.id);
  assert.equal(originalRoom.refs.pqvd_buildingid.id, secondRoom.refs.pqvd_buildingid.id);
  const appendTo = planQualificationCrudRequest({
    configuration,
    cell: { operation: 'appendTo', region: 'own-scope' },
    fixtures,
    bound,
    schema,
  });
  assert.equal(appendTo.target.table, 'pqvd_crudprobe');
  assert.equal(appendTo.boundTarget.table, 'pqvd_equipment');
  const probe = fixtures.records.find((record) => record.id === appendTo.target.id);
  assert.notEqual(probe.refs.pqvd_equipmentid.id, appendTo.boundTarget.id);
  assert.equal(probe.refs.pqvd_runid.id, equipment.refs.pqvd_canaryrunid.id);
  assert.equal(probe.refs.pqvd_ownercontactid.id, actor);
});

test('Source5 immutable lookup intents bind actual child and desired counterpart and refuse legacy40-character Variant', () => {
  const configuration = { family: 'equipment-lifecycle', query: { id: 'fixture-read', variant: 'fetchxml' } },
    schema = { tables: [{ name: 'pqvd_testoperation', columns: [{ name: 'pqvd_variant', maxLength: 128 }] }] };
  const source = id(60),
    desired = id(61),
    room = { target: { table: 'pqvd_equipment', id: source }, boundTarget: { table: 'pqvd_room', id: desired } },
    probe = { target: { table: 'pqvd_crudprobe', id: source }, boundTarget: { table: 'pqvd_equipment', id: desired } };
  const append = qualificationMutationIntent({ configuration, cell: { operation: 'append' }, request: room, schema });
  assert.equal(append.caseId, 'PORTAL-EQUIPMENT-APPEND');
  assert.equal(append.variant, `TARGET:${source};ROOM:${desired}`);
  const appendTo = qualificationMutationIntent({
    configuration,
    cell: { operation: 'appendTo' },
    request: probe,
    schema,
  });
  assert.equal(appendTo.caseId, 'PORTAL-EQUIPMENT-APPENDTO');
  assert.equal(appendTo.variant, `TARGET:${source};EQUIPMENT:${desired}`);
  assert.throws(
    () =>
      qualificationMutationIntent({
        configuration,
        cell: { operation: 'append' },
        request: { ...room, boundTarget: probe.boundTarget },
        schema,
      }),
    /counterpart/,
  );
  schema.tables[0].columns[0].maxLength = 40;
  assert.throws(
    () => qualificationMutationIntent({ configuration, cell: { operation: 'write' }, request: room, schema }),
    /length128/,
  );
});
