// @test-kind unproven: Other original registrations have not been reviewed against native proof.
import {
  assertParityBindings as __paqParityBindings,
  assertParityBindingsFromSource as __paqParitySourceBindings,
} from '../../scripts/qualify-parity.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { batchResponses, createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';
import { compileForm } from '../lib/model-driven/solution.mjs';
import { staffContext, USER_SETTINGS_EXTENSION } from '../lib/staff-session.mjs';
import { createModelDrivenWebApi } from '../lib/dataverse-model-driven.mjs';
import { uuidV5 } from '../lib/dataverse-security.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

test('$batch answers split on their declared boundaries only, so a body holding -- stays whole', () => {
  const body = [
    '--batchresponse_1',
    'Content-Type: multipart/mixed; boundary=changesetresponse_2',
    '',
    '--changesetresponse_2',
    'Content-Type: application/http',
    '',
    'HTTP/1.1 204 No Content',
    'OData-Version: 4.0',
    '',
    '',
    '--changesetresponse_2',
    'Content-Type: application/http',
    '',
    'HTTP/1.1 400 Bad Request',
    'Content-Type: application/json',
    '',
    '{"error":{"code":"0x80044331","message":"a -- b"}}',
    '--changesetresponse_2--',
    '--batchresponse_1--',
    '',
  ].join('\r\n');
  const parts = batchResponses(body, 'batchresponse_1');
  assert.deepEqual(
    parts.map((part) => part.status),
    [204, 400],
  );
  assert.deepEqual(JSON.parse(parts[1].body).error, { code: '0x80044331', message: 'a -- b' });
});

// @test-kind parity: Two independent authenticated native draft forms execute both original client state calls with the exact original results.
// @parity-evidence: Manifest guarantee online-client-state; exact capsule/run/fact/source bindings are asserted below.
test('globalContext.client.isOffline answers false like the PCF client', () => {
  __paqParityBindings(import.meta.url, [
    {
      baselineId: 'mirage/test/model-driven-client-state.test.mjs:45:0',
      repositoryRoot: '../..',
      titleExpressionSha256: '2654b57b5c4c4d2d4b744bef0fb07de2cbe4ae2b64377acd3f2af3854b8ef4e2',
      originalAssertions: [
        'c82aa5ecea8677d9081941ddf1af7b617d8c283b4fb2eae45b938e016ae0bc87',
        '136f7650ba33444c8cb2fb872010def595f68b154d4d87d3c65d7d5dbc603d2b',
      ],
      originalBodyAstSha256: '87e247813572b9d0ab4a2db2a70e2d41dd662f38fa58b925e297e1be4288c971',
      originalGuardHashes: [],
      moduleContextAstSha256: '13749593e8ba7a69157cfc94ec1b87f288ef8a3bb4b35d7e6c437199d605c9a5',
      isolationRegistrationsAstSha256: 'c5075daac0eeb403d49b8a4de3fd48538b3c43719c4e05a4f4b0aac69374d4e5',
      importRoles: [
        {
          source: '../api.mjs',
          role: 'implementation-under-test',
          reviewedBy: 'frontend-agent',
          reason: 'Toolkit implementation imports; only createFormClientRuntime is used in the selected registration.',
        },
        {
          source: '../lib/model-driven/client-runtime.mjs',
          role: 'implementation-under-test',
          reviewedBy: 'frontend-agent',
          reason: 'Toolkit implementation imports; only createFormClientRuntime is used in the selected registration.',
        },
        {
          source: '../lib/model-driven/solution.mjs',
          role: 'implementation-under-test',
          reviewedBy: 'frontend-agent',
          reason: 'Toolkit implementation imports; only createFormClientRuntime is used in the selected registration.',
        },
        {
          source: '../lib/staff-session.mjs',
          role: 'implementation-under-test',
          reviewedBy: 'frontend-agent',
          reason: 'Toolkit implementation imports; only createFormClientRuntime is used in the selected registration.',
        },
        {
          source: '../lib/dataverse-model-driven.mjs',
          role: 'implementation-under-test',
          reviewedBy: 'frontend-agent',
          reason: 'Toolkit implementation imports; only createFormClientRuntime is used in the selected registration.',
        },
        {
          source: '../lib/dataverse-security.mjs',
          role: 'implementation-under-test',
          reviewedBy: 'frontend-agent',
          reason: 'Toolkit implementation imports; only createFormClientRuntime is used in the selected registration.',
        },
        {
          source: '../testing/owned-fixture.mjs',
          role: 'test-input',
          reviewedBy: 'frontend-agent',
          reason:
            'Temporary directory ownership helper for a separate registration; selected registration does not reference it.',
        },
      ],
      runtimeInputs: [],
      inputDependencies: [
        {
          path: 'mirage/testing/owned-fixture.mjs',
          sha256: '88ddbb5a2a7a001fc9389340419536ae561a65606384e9744c440c4e363754a0',
        },
      ],
      sourceBindings: [],
      loopHeaders: [],
      caseUniverse: {
        count: 1,
        cases: ['globalContext.client.isOffline answers false like the PCF client'],
        casesSha256: '275afddbe7be4e3541779fedc253e5ecd866a36b92bb97eb1a936eb315448a1e',
        sourceBindings: [],
        ancestorLoops: [],
      },
      proofs: [
        {
          path: 'mirage/test/fixtures/model-driven-client-online-native-facts.json',
          sha256: 'd519e56b9676cb4d7fc2276a242ffee633bb13bf64e1eb1edde7ebf27efb73e3',
          mode: 'reproduced-native',
          capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
          facts: [
            {
              id: 'offline',
              pointer: '/captures/0/result/values/0',
              sha256: 'fcbcf165908dd18a9e49f7ff27810176db8e9f63b4352213741664245224f8aa',
              replicatedPointers: ['/captures/0/result/values/0', '/captures/1/result/values/0'],
            },
            {
              id: 'state',
              pointer: '/captures/0/result/values/1',
              sha256: 'b11148e2002ef092742cbd4566f96b67a8f517f32279b1b399b479efcef62634',
              replicatedPointers: ['/captures/0/result/values/1', '/captures/1/result/values/1'],
            },
          ],
        },
      ],
    },
  ]);
  const table = {
    entity: 'x_item',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    fields: { x_name: { name: 'x_name', type: 'text' } },
  };
  const { Xrm } = createFormClientRuntime({
    table,
    tables: { x_item: table },
    form: { clientEvents: [], attributes: ['x_name'] },
    record: {},
    read: () => null,
    write() {},
    isDirty: () => false,
    controlNames: (name) => (name ? [name] : ['x_name']),
    controlField: (name) => name,
    controlState() {},
    notification() {},
    request: async () => ({}),
  });
  const client = Xrm.Utility.getGlobalContext().client;
  assert.equal(client.isOffline(), false);
  assert.equal(client.getClientState(), 'Online');
});

test('header and footer columns compile to header_/footer_ controls', () => {
  const fields = {
    x_name: { name: 'x_name', type: 'text' },
    x_status: { name: 'x_status', type: 'text' },
    x_owner: { name: 'x_owner', type: 'text' },
  };
  const xml =
    '<form><header><rows><row><cell><control id="header_x_status" datafieldname="x_status"/></cell></row></rows></header><tabs><tab name="general"><columns><column><sections><section name="main"><rows><row><cell><control id="x_name" datafieldname="x_name"/></cell></row></rows></section></sections></column></columns></tab></tabs><footer><rows><row><cell><control id="footer_x_owner" datafieldname="x_owner"/></cell></row></rows></footer></form>';
  const form = compileForm({ id: 'f', name: 'Information', xml }, fields);
  assert.deepEqual(
    form.regionControls.map(({ region, id, name }) => ({ region, id, name })),
    [
      { region: 'header', id: 'header_x_status', name: 'x_status' },
      { region: 'footer', id: 'footer_x_owner', name: 'x_owner' },
    ],
  );
  assert.deepEqual(
    form.regionControls.map(({ sourceControl }) => ({
      id: sourceControl.id,
      ordinal: sourceControl.ordinal,
      field: sourceControl.attributes.datafieldname,
      uniqueId: sourceControl.uniqueId,
    })),
    [
      { id: 'header_x_status', ordinal: 0, field: 'x_status', uniqueId: null },
      { id: 'footer_x_owner', ordinal: 2, field: 'x_owner', uniqueId: null },
    ],
  );
  for (const { sourceControl } of form.regionControls)
    assert.match(sourceControl.xml, new RegExp(`id="${sourceControl.id}"`));
});

test('the en-US staff short date pattern is the .NET M/d/yyyy', () => {
  const runtime = {
    store: { tableRows: (name) => (name === 'organization' ? [{ languagecode: 1033, localeid: 1033 }] : []) },
    principals: { roles: () => [] },
  };
  assert.equal(
    staffContext(runtime, { systemuserid: '77777777-7777-4777-8777-777777777777' }).dateFormattingInfo.shortDatePattern,
    'M/d/yyyy',
  );
});

test('usersettingscollection answers GET and PATCH for the caller and feeds the staff context', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'usersettings-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const solution = path.join(root, 'solution', 'Other');
  await fs.mkdir(solution, { recursive: true });
  await fs.writeFile(
    path.join(solution, 'Solution.xml'),
    '<ImportExportXml><SolutionManifest><UniqueName>InventedSettings</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  );
  const sim = await createSimulator({
    runtime: { kind: 'model-driven' },
    solutionRoots: [path.join(root, 'solution')],
    projectRoot: root,
    port: 0,
    watch: false,
    simulation: { level: 'dry-run' },
    dataverse: { enabled: false, tds: { enabled: false } },
  });
  ownedFixture(t).add(() => sim.close());
  // The extension is listed in dataverse-extensions.mjs; installing it here as well is harmless (the first route wins).
  USER_SETTINGS_EXTENSION.install(sim.organization.api);
  const system = uuidV5(sim.organization.organizationId, 'systemuser:SYSTEM');
  const webApi = createModelDrivenWebApi({ organization: () => sim.organization });
  const call = (method, id, body) =>
    webApi({
      method,
      path: `/api/data/v9.2/usersettingscollection(${id})`,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body && JSON.stringify(body),
      principal: { principalId: system, kind: 'local-admin' },
      host: '127.0.0.1',
    });
  assert.equal((await call('PATCH', system, { localeid: 1031, uilanguageid: 1031, timezonecode: 110 })).status, 204);
  const read = await call('GET', system);
  assert.equal(read.status, 200);
  assert.deepEqual([JSON.parse(read.body).localeid, JSON.parse(read.body).timezonecode], [1031, 110]);
  const context = staffContext(sim.organization, sim.organization.principals.byId(system));
  assert.equal(context.locale, 'de-DE');
  assert.equal(context.timeZone.iana, 'Europe/Berlin');
  assert.equal((await call('GET', '77777777-7777-4777-8777-777777777777')).status, 403);
  assert.equal((await call('PATCH', system, { secretvalue: 'x' })).status, 400);
  // The bridge never acts as bare SYSTEM: a principal without a staff or local-admin kind is refused.
  await assert.rejects(
    webApi({ method: 'GET', path: '/api/data/v9.2/WhoAmI', principal: { principalId: system }, host: '127.0.0.1' }),
    (error) => error.status === 401,
  );
});

// @test-kind tooling: Shared source guard reads expected bindings from protected parity bodies and runs independently of their generators; no baseline closure credit.
test('parity source bindings 9a3d659896a1c89b', () => {
  assert.doesNotThrow(() => __paqParitySourceBindings(import.meta.url));
});
