import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';

test('custom API rows immediately update canonical HTTP routing, CSDL, parameter validation and deletion', async t => {
  const variable = 'PAQVILO_CUSTOM_API_HTTP_TEST_SECRET', app = '55555555-5555-4555-8555-555555555555';
  process.env[variable] = 'Invented registry secret'; t.after(() => { delete process.env[variable]; });
  const store = await new DataStore({ state: emptyState() }).init();
  const handler = async context => ({ outputs: { Result: context.inputs.Text ?? context.inputs.Changed ?? 'empty' } });
  const extensions = await sourceOrganizationExtensions({ customApis: new Map(['new_live', 'new_renamed'].map(name => [name, { handler }])) });
  const organization = await createOrganizationRuntime({ store, extensions, settings: dataverseSettings({ enabled: true,
    applications: [{ appId: app, displayName: 'Invented registry client', secretEnvironmentVariable: variable, roles: ['System Administrator'] }] }) });
  t.after(() => organization.close());
  const transport = await startDataverseApi({ organization }); t.after(() => transport.close());
  const tokenResponse = await fetch(transport.authority + '/oauth2/v2.0/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: app, client_secret: process.env[variable], scope: transport.origin + '/.default' }) });
  assert.equal(tokenResponse.status, 200); const token = (await tokenResponse.json()).access_token;
  const call = (method, route, value) => fetch(transport.origin + '/api/data/v9.2/' + route, { method,
    headers: { authorization: `Bearer ${token}`, prefer: 'return=representation', ...(value ? { 'content-type': 'application/json' } : {}) },
    ...(value ? { body: JSON.stringify(value) } : {}) });
  const json = async (response, status = 200) => { const body = await response.text(); assert.equal(response.status, status, body); return body ? JSON.parse(body) : null; };
  const schema = async () => { const response = await call('GET', '$metadata'); assert.equal(response.status, 200); return { xml: await response.text(), etag: response.headers.get('etag') }; };
  const action = (xml, name) => new RegExp(`<Action Name="${name}"[^>]*>[\\s\\S]*?</Action>`).exec(xml)?.[0];

  const api = await json(await call('POST', 'customapis', { uniquename: 'new_Live', name: 'Live', bindingtype: 0, isfunction: false }), 201);
  const parameter = await json(await call('POST', 'customapirequestparameters', { uniquename: 'Text', name: 'Text', type: 10, isoptional: false, 'CustomAPIId@odata.bind': `/customapis(${api.customapiid})` }), 201);
  const property = await json(await call('POST', 'customapiresponseproperties', { uniquename: 'Result', name: 'Result', type: 10, 'CustomAPIId@odata.bind': `/customapis(${api.customapiid})` }), 201);
  const first = await schema();
  assert.match(action(first.xml, 'new_Live') ?? '', /Parameter Name="Text" Type="Edm.String"/);
  assert.match(action(first.xml, 'new_Live') ?? '', /ReturnType Type="mscrm.new_LiveResponse"/);
  assert.equal((await json(await call('POST', 'new_Live', { Text: 'First' }))).Result, 'First');
  const invalid = await json(await call('POST', 'customapis', { uniquename: 'invalid name', name: 'Incomplete row', bindingtype: 0, isfunction: false }), 201);
  const unbound = await json(await call('POST', 'customapis', { uniquename: 'new_MissingBinding', name: 'Missing bound entity', bindingtype: 1, isfunction: false }), 201);
  assert.equal((await call('GET', 'WhoAmI')).status, 200, 'Incomplete authored metadata cannot block platform operations or repair requests.');
  const repairable = (await schema()).xml;
  assert.ok(action(repairable, 'new_Live'));
  assert.equal(action(repairable, 'new_MissingBinding'), undefined);
  assert.equal((await json(await call('POST', 'new_Live', { Text: 'Still works' }))).Result, 'Still works');
  await json(await call('DELETE', `customapis(${invalid.customapiid})`), 204);
  await json(await call('DELETE', `customapis(${unbound.customapiid})`), 204);

  await json(await call('PATCH', `customapirequestparameters(${parameter.customapirequestparameterid})`, { uniquename: 'Changed' }));
  const changed = await schema();
  assert.notEqual(changed.etag, first.etag);
  assert.match(action(changed.xml, 'new_Live') ?? '', /Parameter Name="Changed"/);
  assert.doesNotMatch(action(changed.xml, 'new_Live') ?? '', /Parameter Name="Text"/);
  await json(await call('POST', 'new_Live', { Text: 'Rejected old parameter' }), 400);
  assert.equal((await json(await call('POST', 'new_Live', { Changed: 'Second' }))).Result, 'Second');

  await json(await call('DELETE', `customapiresponseproperties(${property.customapiresponsepropertyid})`), 204);
  assert.doesNotMatch(action((await schema()).xml, 'new_Live') ?? '', /ReturnType/);
  await json(await call('POST', 'new_Live', { Changed: 'No output contract' }), 204);
  await json(await call('PATCH', `customapis(${api.customapiid})`, { uniquename: 'new_Renamed' }));
  assert.equal(action((await schema()).xml, 'new_Live'), undefined);
  assert.ok(action((await schema()).xml, 'new_Renamed'));
  await json(await call('POST', 'new_Live', { Changed: 'Old name' }), 404);
  await json(await call('POST', 'new_Renamed', { Changed: 'New name' }), 204);
  await json(await call('DELETE', `customapirequestparameters(${parameter.customapirequestparameterid})`), 204);
  await json(await call('POST', 'new_Renamed', {}), 204);
  await json(await call('DELETE', `customapis(${api.customapiid})`), 204);
  assert.equal(action((await schema()).xml, 'new_Renamed'), undefined);
  await json(await call('POST', 'new_Renamed', {}), 404);
});
