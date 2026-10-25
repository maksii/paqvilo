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
import { ownedFixture } from '../testing/owned-fixture.mjs';

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

test('globalContext.client.isOffline answers false like the PCF client', () => {
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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'usersettings-'));
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
