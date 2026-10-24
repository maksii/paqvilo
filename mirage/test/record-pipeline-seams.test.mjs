// The organization entries a flow connector calls with an explicit backend profile: store.recordPipeline
// .fileContentInternal (file column upload and download) and .executeMessageInternal (a custom API action).
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';

const DOC = '77777777-7777-4777-8777-777777777701';
const API = '77777777-7777-4777-8777-777777777702';
const USER = '77777777-7777-4777-8777-777777777703';

async function organization(t) {
  const state = emptyState();
  state.mappings.x_doc = { logicalName: 'x_doc', entitySet: 'x_docs', idColumn: 'x_docid', nameColumn: 'x_name',
    fields: { x_name: { dataverseType: 'nvarchar' }, x_file: { dataverseType: 'file' } } };
  state.tables.x_doc = [{ x_docid: DOC, x_name: 'Invented', statecode: 0, statuscode: 1 }];
  state.tables.systemuser = [{ systemuserid: USER, fullname: 'Invented flow owner', isdisabled: false }];
  state.tables.customapi = [{ customapiid: API, uniquename: 'x_Echo', name: 'x_Echo', bindingtype: 0, isfunction: false }];
  state.tables.customapirequestparameter = [{ customapirequestparameterid: '77777777-7777-4777-8777-777777777704', uniquename: 'Text', name: 'Text', type: 10, isoptional: false, customapiid: API }];
  state.tables.customapiresponseproperty = [{ customapiresponsepropertyid: '77777777-7777-4777-8777-777777777705', uniquename: 'Echo', name: 'Echo', type: 10, customapiid: API }];
  const store = await new DataStore({ state }).init();
  const customApis = new Map([['x_echo', { handler: (ctx) => ({ outputs: { Echo: `echo ${ctx.inputs.Text}` } }), pluginType: null }]]);
  const runtime = await createOrganizationRuntime({ store, settings: dataverseSettings({ enabled: true }), extensions: await sourceOrganizationExtensions({ customApis }) });
  t.after(() => runtime.close());
  return store;
}

const profile = (grants) => ({ userId: USER, evidence: 'invented seam test', grants });

test('fileContentInternal uploads and downloads a file column under the profile grants', async (t) => {
  const store = await organization(t);
  const entry = store.recordPipeline.fileContentInternal;
  const writer = profile([{ entity: 'x_doc', operations: ['read', 'update'] }]);
  const uploaded = await entry({ principal: writer, operation: 'upload', entity: 'x_doc', id: DOC, column: 'x_file',
    content: { '$content-type': 'text/plain', '$content': Buffer.from('invented bytes').toString('base64') }, fileName: 'invented.txt' });
  assert.deepEqual(uploaded, { statusCode: 204, body: {} });
  const downloaded = await entry({ principal: writer, operation: 'download', entity: 'x_doc', id: DOC, column: 'x_file' });
  assert.equal(downloaded.statusCode, 200);
  assert.equal(Buffer.from(downloaded.body.$content, 'base64').toString(), 'invented bytes');
  await assert.rejects(entry({ principal: profile([{ entity: 'x_doc', operations: ['update'] }]), operation: 'download', entity: 'x_doc', id: DOC, column: 'x_file' }),
    { status: 403, code: 'LocalBackendPermissionDenied' });
});

test('executeMessageInternal runs an unbound custom API action and answers its response properties', async (t) => {
  const store = await organization(t);
  const execute = (...names) => names.map((message) => ({ message, operations: ['execute'] }));
  const answer = await store.recordPipeline.executeMessageInternal({ principal: profile(execute('x_Echo')), name: 'x_Echo', target: null, parameters: { Text: 'hello' } });
  assert.deepEqual(answer, { statusCode: 200, body: { Echo: 'echo hello' } });
  await assert.rejects(store.recordPipeline.executeMessageInternal({ principal: profile(execute('x_Missing')), name: 'x_Missing', target: null, parameters: {} }), { status: 404 });
  await assert.rejects(store.recordPipeline.executeMessageInternal({ principal: profile(execute('x_Echo')), name: 'x_Echo', target: { entity: 'x_doc', id: DOC }, parameters: {} }),
    { status: 403, code: 'LocalBackendPermissionDenied' }, 'a bound call needs the read grant on its target');
  await assert.rejects(store.recordPipeline.executeMessageInternal({ principal: profile([]), name: 'x_Echo', target: null, parameters: { Text: 'hello' } }),
    { status: 403, code: 'LocalBackendPermissionDenied' }, 'the message needs an execute grant');
  await assert.rejects(store.recordPipeline.executeMessageInternal({ principal: { ...profile(execute('x_Echo')), userId: '77777777-7777-4777-8777-777777777799' }, name: 'x_Echo', target: null, parameters: { Text: 'hello' } }),
    { status: 403, code: 'LocalBackendIdentityRequired' }, 'never SYSTEM: the profile user must be a systemuser');
});
