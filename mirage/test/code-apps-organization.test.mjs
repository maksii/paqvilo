import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { codeAppDataverse } from '../lib/organization-host.mjs';
import { createCodeAppsHandler } from '../lib/code-apps-http.mjs';
import { configure } from '../lib/code-apps-client.js';
import { createCodeAppSdkExecutor } from '../lib/code-apps-sdk.js';

const USER = '11111111-1111-4111-8111-111111111111';
const ROW = '22222222-2222-4222-8222-222222222222';
test('SDK metadata and binary files traverse the actual local code app and organization handlers', async (t) => {
  const state = emptyState();
  state.mappings.x_item = {
    entitySet: 'x_items',
    idColumn: 'x_itemid',
    nameColumn: 'x_name',
    ownership: 'UserOwned',
    fields: {
      x_name: { dataverseType: 'nvarchar' },
      x_file: { dataverseType: 'file', MaxSizeInKB: 64 },
      x_image: { dataverseType: 'image', canStoreFullImage: true },
    },
  };
  state.tables.x_item = [{ x_itemid: ROW, x_name: 'Invented' }];
  const store = await new DataStore({ state }).init();
  const organization = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({
      enabled: false,
      users: [
        { objectId: USER, domainname: 'invented@example.test', fullname: 'Invented', roles: ['System Administrator'] },
      ],
    }),
    extensions: await sourceOrganizationExtensions(),
  });
  t.after(() => organization.close());
  organization.registry.register({
    name: 'x_Echo',
    kind: 'action',
    binding: 'unbound',
    handle: (context) => ({ status: 200, body: { result: context.body.message, caller: context.user.systemuserid } }),
  });
  organization.registry.register({
    name: 'x_EchoFunction',
    kind: 'function',
    binding: 'unbound',
    handle: (context) => ({ status: 200, body: { result: context.params.message } }),
  });
  const user = organization.principals.byObjectId(USER);
  const handler = createCodeAppsHandler({
    apps: () => [{ name: 'invented', connectionReferences: [] }],
    sessions: { resolve: () => ({ principalId: user.systemuserid, kind: 'staff' }) },
    user: () => user,
    csrf: () => 'test-csrf',
    organization: { environmentId: 'invented', organizationId: 'invented', tenantId: 'invented' },
    dataverse: codeAppDataverse({ organization, change: (fn) => fn(), origin: () => 'http://localhost' }),
  });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  configure({ app: 'invented', origin: `http://127.0.0.1:${server.address().port}` });
  const sdk = createCodeAppSdkExecutor({ entitySets: { x_item: 'x_items' } });
  const metadata = await sdk.executeAsync({
    dataverseRequest: {
      action: 'getEntityMetadata',
      parameters: { tableName: 'x_item', options: { metadata: ['LogicalName'], schema: { columns: ['x_name'] } } },
    },
  });
  assert.equal(metadata.success, true, metadata.error?.message);
  assert.equal(metadata.data.LogicalName, 'x_item');
  assert.deepEqual(
    metadata.data.Attributes.map((attribute) => attribute.LogicalName),
    ['x_name'],
  );
  // An ordinary Dataverse POST remains a wrong-verb request and is never translated to a function.
  const direct = await fetch(`http://127.0.0.1:${server.address().port}/_apps/code/invented/dataverse/WhoAmI`, {
    method: 'POST',
    headers: { 'x-sim-csrf': 'test-csrf', 'content-type': 'application/json' },
    body: '{}',
  });
  assert.equal(direct.ok, false);
  const who = await sdk.executeAsync({
    dataverseRequest: { action: 'customapi', parameters: { tableName: 'whoami', operationName: 'WhoAmI' } },
  });
  assert.equal(who.success, true, who.error?.message);
  assert.equal(who.data.UserId, user.systemuserid);
  assert.equal(who.data.OrganizationId, organization.organizationId);
  const fn = await sdk.executeAsync({
    dataverseRequest: {
      action: 'customapi',
      parameters: { tableName: 'x_item', operationName: 'x_EchoFunction', body: { message: 'function value' } },
    },
  });
  assert.equal(fn.success, true, fn.error?.message);
  assert.deepEqual(fn.data, { result: 'function value' });
  const action = await sdk.executeAsync({
    dataverseRequest: {
      action: 'customapi',
      parameters: { tableName: 'x_item', operationName: 'x_Echo', body: { message: 'invented' } },
    },
  });
  assert.equal(action.success, true, action.error?.message);
  assert.deepEqual(action.data, { result: 'invented', caller: user.systemuserid });
  const bytes = new Uint8Array([0, 255, 16, 127]);
  const uploaded = await sdk.uploadFileToRecord('x_item', ROW, 'x_file', 'invented name.bin', bytes);
  assert.equal(uploaded.success, true, uploaded.error?.message);
  const downloaded = await sdk.downloadFileFromRecord('x_item', ROW, 'x_file');
  assert.equal(downloaded.success, true, downloaded.error?.message);
  assert.deepEqual(downloaded.data, bytes);
  assert.equal(downloaded.fileName, 'invented name.bin');
  const removed = await sdk.deleteFileOrImageFromRecord('x_item', ROW, 'x_file');
  assert.equal(removed.success, true, removed.error?.message);
  const image = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
  const imageUpload = await sdk.uploadFileToRecord('x_item', ROW, 'x_image', 'invented.png', image);
  assert.equal(imageUpload.success, true, imageUpload.error?.message);
  const imageDownload = await sdk.downloadImageFromRecord('x_item', ROW, 'x_image', true);
  assert.equal(imageDownload.success, true, imageDownload.error?.message);
  assert.deepEqual(imageDownload.data, image);
  assert.equal((await sdk.deleteFileOrImageFromRecord('x_item', ROW, 'x_image')).success, true);
});
