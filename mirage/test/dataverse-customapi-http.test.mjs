// @test-kind compatibility: Microsoft Learn custom API tables and OData CSDL: row writes update routing, $metadata, parameter validation and deletion
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';

// Starts a Web API with one invented registry client and answers the store, the transport and the token response.
async function registryHarness(t, { variable, app, displayName, customApis }) {
  process.env[variable] = 'Invented registry secret';
  t.after(() => {
    delete process.env[variable];
  });
  const store = await new DataStore({ state: emptyState() }).init();
  const extensions = await sourceOrganizationExtensions({ customApis });
  const organization = await createOrganizationRuntime({
    store,
    extensions,
    settings: dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: app,
          displayName,
          secretEnvironmentVariable: variable,
          roles: ['System Administrator'],
        },
      ],
    }),
  });
  ownedFixture(t).add(() => organization.close());
  const transport = await startDataverseApi({ organization });
  ownedFixture(t).add(() => transport.close());
  const tokenResponse = await fetch(transport.authority + '/oauth2/v2.0/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: app,
      client_secret: process.env[variable],
      scope: transport.origin + '/.default',
    }),
  });
  return { store, transport, tokenResponse };
}

// Bearer calls to the Web API for a token: `call` sends one request and `json` asserts its status and parses its body.
function bearerCalls(transport, token) {
  const call = (method, route, value) =>
    fetch(transport.origin + '/api/data/v9.2/' + route, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        prefer: 'return=representation',
        ...(value ? { 'content-type': 'application/json' } : {}),
      },
      ...(value ? { body: JSON.stringify(value) } : {}),
    });
  const json = async (response, status = 200) => {
    const body = await response.text();
    assert.equal(response.status, status, body);
    return body ? JSON.parse(body) : null;
  };
  return { call, json };
}

test('custom API rows immediately update canonical HTTP routing, CSDL, parameter validation and deletion', async (t) => {
  const variable = 'PAQVILO_CUSTOM_API_HTTP_TEST_SECRET',
    app = '55555555-5555-4555-8555-555555555555';
  const handler = async (context) => ({
    outputs: { Result: context.inputs.Text ?? context.inputs.Changed ?? 'empty' },
  });
  const { store, transport, tokenResponse } = await registryHarness(t, {
    variable,
    app,
    displayName: 'Invented registry client',
    customApis: new Map(['new_live', 'new_renamed'].map((name) => [name, { handler }])),
  });
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json()).access_token;
  const { call, json } = bearerCalls(transport, token);
  const schema = async () => {
    const response = await call('GET', '$metadata');
    assert.equal(response.status, 200);
    return { xml: await response.text(), etag: response.headers.get('etag') };
  };
  const action = (xml, name) => new RegExp(`<Action Name="${name}"[^>]*>[\\s\\S]*?</Action>`).exec(xml)?.[0];

  for (const description of [undefined, null]) {
    const before = store.tableRows('customapi').length;
    const failure = await json(
      await call('POST', 'customapis', {
        uniquename: 'new_MissingDescription',
        name: 'Missing description',
        description,
        bindingtype: 0,
        isfunction: false,
      }),
      400,
    );
    assert.equal(failure.error.code, '0x80040200');
    assert.match(failure.error.message, /Attribute 'description' cannot be NULL/);
    assert.equal(store.tableRows('customapi').length, before);
  }

  const api = await json(
    await call('POST', 'customapis', {
      uniquename: 'new_Live',
      name: 'Live',
      description: 'Invented runtime API',
      bindingtype: 0,
      isfunction: false,
    }),
    201,
  );
  const parameter = await json(
    await call('POST', 'customapirequestparameters', {
      uniquename: 'Text',
      name: 'Text',
      type: 10,
      isoptional: false,
      'CustomAPIId@odata.bind': `/customapis(${api.customapiid})`,
    }),
    201,
  );
  const property = await json(
    await call('POST', 'customapiresponseproperties', {
      uniquename: 'Result',
      name: 'Result',
      type: 10,
      'CustomAPIId@odata.bind': `/customapis(${api.customapiid})`,
    }),
    201,
  );
  const first = await schema();
  assert.match(action(first.xml, 'new_Live') ?? '', /Parameter Name="Text" Type="Edm.String"/);
  assert.match(action(first.xml, 'new_Live') ?? '', /ReturnType Type="mscrm.new_LiveResponse"/);
  assert.equal((await json(await call('POST', 'new_Live', { Text: 'First' }))).Result, 'First');
  const invalidName = {
    uniquename: 'invalid name',
    name: 'Incomplete row',
    description: 'Invented invalid-name repair scenario',
    bindingtype: 0,
    isfunction: false,
  };
  const invalidFailure = await json(await call('POST', 'customapis', invalidName), 400);
  assert.equal(invalidFailure.error.code, '0x800608ab');
  assert.match(invalidFailure.error.message, /must begin with a letter/);
  const missingBinding = {
    uniquename: 'new_MissingBinding',
    name: 'Missing bound entity',
    description: 'Invented missing-binding repair scenario',
    bindingtype: 1,
    isfunction: false,
  };
  const bindingFailure = await json(await call('POST', 'customapis', missingBinding), 400);
  assert.equal(bindingFailure.error.code, '0x80040265');
  assert.equal(bindingFailure.error.message, 'BoundEntityLogicalName is required.');
  // Incomplete exported source rows remain repairable even though authoring them
  // through the Dataverse service is rejected by native metadata validation.
  const invalid = { ...invalidName, customapiid: '10000000-0000-0000-0000-000000000003' };
  const unbound = { ...missingBinding, customapiid: '10000000-0000-0000-0000-000000000004' };
  await store.transact(() => store.state.tables.customapi.push(invalid, unbound));
  assert.equal(
    (await call('GET', 'WhoAmI')).status,
    200,
    'Incomplete authored metadata cannot block platform operations or repair requests.',
  );
  const repairable = (await schema()).xml;
  assert.ok(action(repairable, 'new_Live'));
  assert.equal(action(repairable, 'new_MissingBinding'), undefined);
  assert.equal((await json(await call('POST', 'new_Live', { Text: 'Still works' }))).Result, 'Still works');
  await json(await call('DELETE', `customapis(${invalid.customapiid})`), 204);
  await json(await call('DELETE', `customapis(${unbound.customapiid})`), 204);

  await json(
    await call('PATCH', `customapirequestparameters(${parameter.customapirequestparameterid})`, {
      uniquename: 'Changed',
    }),
  );
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
  const renamed = (await schema()).xml;
  assert.equal(action(renamed, 'new_Live'), undefined);
  assert.ok(action(renamed, 'new_Renamed'));
  await json(await call('POST', 'new_Live', { Changed: 'Old name' }), 404);
  await json(await call('POST', 'new_Renamed', { Changed: 'New name' }), 204);
  await json(await call('DELETE', `customapirequestparameters(${parameter.customapirequestparameterid})`), 204);
  await json(await call('POST', 'new_Renamed', {}), 204);
  await json(await call('DELETE', `customapis(${api.customapiid})`), 204);
  assert.equal(action((await schema()).xml, 'new_Renamed'), undefined);
  await json(await call('POST', 'new_Renamed', {}), 404);
});

// A started Web API with a custom API client, for the name and step tests: the calls, the store and the $batch route.
async function namesHarness(t) {
  const variable = 'PAQVILO_CUSTOM_API_NAMES_TEST_SECRET',
    app = '66666666-6666-4666-8666-666666666666';
  const { store, transport, tokenResponse } = await registryHarness(t, {
    variable,
    app,
    displayName: 'Invented names client',
    customApis: new Map(),
  });
  const token = (await tokenResponse.json()).access_token;
  const { call, json } = bearerCalls(transport, token);
  const metadata = async () => {
    const response = await call('GET', '$metadata');
    assert.equal(response.status, 200);
    return response.text();
  };
  const api = (uniquename, extra = {}) => ({
    uniquename,
    name: uniquename,
    description: 'Invented names API',
    bindingtype: 0,
    isfunction: false,
    ...extra,
  });
  const batch = (boundary, text) =>
    fetch(transport.origin + '/api/data/v9.2/$batch', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': `multipart/mixed; boundary=${boundary}` },
      body: text,
    });
  return { call, json, metadata, store, api, batch };
}

// @test-kind observation: native probe NP-9, 2026-11-12, Dataverse Web API on a developer environment, one capture (workbench notes/native-probes-2026-11-12/NP-9.json)
test('a second custom API with the same uniquename is refused by the database key and nothing is created', async (t) => {
  const { call, json, store, api } = await namesHarness(t);
  const first = await json(await call('POST', 'customapis', api('new_Names')), 201);
  const duplicate = await json(await call('POST', 'customapis', api('new_Names')), 400);
  assert.equal(duplicate.error.code, '0x80072013');
  assert.equal(
    duplicate.error.message,
    'Cannot complete the creation of CustomAPI because it violates a database constraint. The violation happens on the key uniquename: new_Names. Please delete the existing record or use update.',
  );
  assert.equal(store.tableRows('customapi').filter((row) => row.uniquename === 'new_Names').length, 1);
  assert.ok(store.tableRows('customapi').some((row) => row.customapiid === first.customapiid));
});

// @test-kind unproven: same key as the observed create case; the update path has no capture
test('renaming a custom API onto the name of another API is refused by the same database key', async (t) => {
  const { call, json, store, api } = await namesHarness(t);
  await json(await call('POST', 'customapis', api('new_Names')), 201);
  const other = await json(await call('POST', 'customapis', api('new_Other')), 201);
  const refused = await json(await call('PATCH', `customapis(${other.customapiid})`, { uniquename: 'new_Names' }), 400);
  assert.equal(refused.error.code, '0x80072013');
  assert.match(refused.error.message, /key uniquename: new_Names\. /);
  assert.equal(
    store.tableRows('customapi').find((row) => row.customapiid === other.customapiid).uniquename,
    'new_Other',
  );
});

// @test-kind unproven: the database key compares names without regard to case; NP-9 captured an identical name only
test('a custom API name that differs only in case is refused by the same database key', async (t) => {
  const { call, json, api } = await namesHarness(t);
  await json(await call('POST', 'customapis', api('new_Names')), 201);
  const refused = await json(await call('POST', 'customapis', api('NEW_NAMES')), 400);
  assert.equal(refused.error.code, '0x80072013');
});

test('custom API names are export keys, parameter and property names are unique within their API, and a deleted API keeps the message another one uses', async (t) => {
  const { call, json, metadata, store, api } = await namesHarness(t);
  const first = await json(await call('POST', 'customapis', api('new_Names')), 201);
  const bind = { 'CustomAPIId@odata.bind': `/customapis(${first.customapiid})` };
  // A name that closes an attribute and opens an element is an export key the platform refuses.
  const injected = await json(
    await call('POST', 'customapirequestparameters', {
      uniquename: 'x"/><Evil a="',
      name: 'Injected',
      type: 10,
      isoptional: true,
      ...bind,
    }),
    400,
  );
  assert.equal(injected.error.code, '0x800608ab');
  const badProperty = await json(
    await call('POST', 'customapiresponseproperties', { uniquename: 'Bad name', name: 'Bad', type: 10, ...bind }),
    400,
  );
  assert.equal(badProperty.error.code, '0x800608ab');
  const badBinding = await json(
    await call('POST', 'customapis', {
      ...api('new_BadBinding'),
      bindingtype: 1,
      boundentitylogicalname: 'x"/><Evil',
    }),
    400,
  );
  assert.equal(badBinding.error.code, '0x800608ab');
  const xml = await metadata();
  assert.doesNotMatch(xml, /Evil/, 'no refused name reaches $metadata');
  assert.ok(new RegExp('<Action Name="new_Names"').test(xml));

  const second = await json(await call('POST', 'customapis', api('new_Other')), 201);
  await json(await call('PATCH', `customapis(${first.customapiid})`, { uniquename: 'New_Names' }));
  await json(await call('PATCH', `customapis(${first.customapiid})`, { uniquename: 'new_Names' }));

  // Parameter and property names are unique within their API, and may repeat across APIs.
  await json(
    await call('POST', 'customapirequestparameters', {
      uniquename: 'Text',
      name: 'Text',
      type: 10,
      isoptional: true,
      ...bind,
    }),
    201,
  );
  await json(
    await call('POST', 'customapirequestparameters', {
      uniquename: 'text',
      name: 'Again',
      type: 10,
      isoptional: true,
      ...bind,
    }),
    412,
  );
  const otherBind = { 'CustomAPIId@odata.bind': `/customapis(${second.customapiid})` };
  await json(
    await call('POST', 'customapirequestparameters', {
      uniquename: 'Text',
      name: 'Text',
      type: 10,
      isoptional: true,
      ...otherBind,
    }),
    201,
  );
  await json(
    await call('POST', 'customapiresponseproperties', { uniquename: 'Result', name: 'Result', type: 10, ...bind }),
    201,
  );
  await json(
    await call('POST', 'customapiresponseproperties', { uniquename: 'RESULT', name: 'Again', type: 10, ...bind }),
    412,
  );

  // A stored row that shares a name with another API (imported state) is not deleted from the message the other still uses.
  const sharing = { ...store.tableRows('customapi').find((row) => row.customapiid === first.customapiid) };
  await store.transact(() =>
    store.state.tables.customapi.push({ ...sharing, customapiid: '77777777-0000-4000-8000-000000000001' }),
  );
  const messageNamed = () => store.tableRows('sdkmessage').some((row) => row.name === 'new_Names');
  assert.equal(messageNamed(), true, 'the API has its message before the delete');
  await json(await call('DELETE', `customapis(${first.customapiid})`), 204);
  assert.equal(messageNamed(), true, 'the message stays for the API that still uses the name');
});

const STEP = '99999999-0000-4000-8000-0000000000a1';
const messageOf = (store, name) => store.tableRows('sdkmessage').find((row) => row.name === name);
const filterOf = (store, name) => {
  const id = messageOf(store, name)?.sdkmessageid;
  return id
    ? store.tableRows('sdkmessagefilter').find((row) => row.sdkmessageid === id && row.primaryobjecttypecode === 'none')
    : undefined;
};
// A step on the API's message, through its 'none' filter when filtered; the row keeps the fields the record pipeline writes.
async function pushStep(store, name, filtered) {
  const message = messageOf(store, name);
  const filter = filtered ? filterOf(store, name) : null;
  await store.transact(() => {
    (store.state.tables.sdkmessageprocessingstep ??= []).push({
      sdkmessageprocessingstepid: STEP,
      name: `Invented step on ${name}`,
      sdkmessageid: message.sdkmessageid,
      ...(filter ? { sdkmessagefilterid: filter.sdkmessagefilterid } : {}),
      stage: 40,
      mode: 0,
      rank: 1,
      statecode: 0,
      statuscode: 1,
    });
  });
}
const REFUSED_FIRST = /^The object you tried to delete is associated with another object and cannot be deleted\./;

// @test-kind observation: native probe NP-9, 2026-11-12, Dataverse Web API on a developer environment, one capture (workbench notes/native-probes-2026-11-12/NP-9.json)
test('a custom API with a step on its filter is not deleted, and its message and filter go with it once the step is deleted', async (t) => {
  const { call, json, store, api } = await namesHarness(t);
  const created = await json(await call('POST', 'customapis', api('new_Step')), 201);
  await pushStep(store, 'new_Step', true);
  const refused = await call('DELETE', `customapis(${created.customapiid})`);
  assert.equal(refused.status, 405, await refused.clone().text());
  const body = await refused.json();
  assert.equal(body.error.code, '0x80040227');
  assert.match(body.error.message, REFUSED_FIRST);
  assert.ok(messageOf(store, 'new_Step'), 'the message stays');
  assert.ok(filterOf(store, 'new_Step'), 'the filter stays');
  assert.ok(
    store.tableRows('customapi').some((row) => row.customapiid === created.customapiid),
    'the API stays',
  );
  await json(await call('DELETE', `sdkmessageprocessingsteps(${STEP})`), 204);
  await json(await call('DELETE', `customapis(${created.customapiid})`), 204);
  assert.equal(messageOf(store, 'new_Step'), undefined, 'the message is removed with the API');
  assert.equal(filterOf(store, 'new_Step'), undefined, 'and its filter');
});

// @test-kind observation: native probe NP-9, 2026-11-12, Dataverse Web API on a developer environment, one capture (workbench notes/native-probes-2026-11-12/NP-9.json)
test('a $batch changeset with a refused custom API delete fails as a whole and deletes nothing', async (t) => {
  const { call, json, store, api, batch } = await namesHarness(t);
  const plain = await json(await call('POST', 'customapis', api('new_Plain')), 201);
  const stepped = await json(await call('POST', 'customapis', api('new_Batch')), 201);
  await pushStep(store, 'new_Batch', true);
  const deleteOf = (id, customapiid) =>
    [
      '--changeset_1',
      'Content-Type: application/http',
      'Content-Transfer-Encoding: binary',
      `Content-ID: ${id}`,
      '',
      `DELETE /api/data/v9.2/customapis(${customapiid}) HTTP/1.1`,
    ].join('\r\n');
  const text = [
    '--batch_1',
    'Content-Type: multipart/mixed; boundary=changeset_1',
    '',
    deleteOf(1, plain.customapiid),
    deleteOf(2, stepped.customapiid),
    '--changeset_1--',
    '--batch_1--',
    '',
  ].join('\r\n');
  const response = await batch('batch_1', text);
  const answer = await response.text();
  assert.match(answer, /0x80040227/);
  assert.match(answer, /The object you tried to delete is associated with another object and cannot be deleted\./);
  assert.ok(
    store.tableRows('customapi').some((row) => row.customapiid === plain.customapiid),
    'the plain API stays',
  );
  assert.ok(
    store.tableRows('customapi').some((row) => row.customapiid === stepped.customapiid),
    'the stepped API stays',
  );
});

// @test-kind unproven: a step on the message without a filter is refused the same way; NP-9 registered its step through the filter only
test('a custom API with a step on its message but no filter is not deleted either', async (t) => {
  const { call, json, store, api } = await namesHarness(t);
  const created = await json(await call('POST', 'customapis', api('new_Bare')), 201);
  await pushStep(store, 'new_Bare', false);
  const refused = await call('DELETE', `customapis(${created.customapiid})`);
  assert.equal(refused.status, 405);
  assert.equal((await refused.json()).error.code, '0x80040227');
});

// A second step on a message, with its own id; the row keeps the fields the record pipeline writes, as pushStep does.
async function pushStepAs(store, name, id) {
  const message = messageOf(store, name);
  await store.transact(() => {
    (store.state.tables.sdkmessageprocessingstep ??= []).push({
      sdkmessageprocessingstepid: id,
      name: `Invented step ${name}`,
      sdkmessageid: message.sdkmessageid,
      stage: 40,
      mode: 0,
      rank: 1,
      statecode: 0,
      statuscode: 1,
    });
  });
}
const SECOND_STEP = '99999999-0000-4000-8000-0000000000a2';

// @test-kind unproven: the removal of a renamed custom API's kept message when its last step is deleted is a local model
test('a renamed custom API keeps its old message for its step, and the old message and filter go with the step', async (t) => {
  const { call, json, store, api } = await namesHarness(t);
  const created = await json(await call('POST', 'customapis', api('new_Old')), 201);
  await pushStep(store, 'new_Old', true);
  const oldMessageId = messageOf(store, 'new_Old').sdkmessageid;
  const oldFilterId = filterOf(store, 'new_Old').sdkmessagefilterid;
  await json(await call('PATCH', `customapis(${created.customapiid})`, { uniquename: 'new_New' }));
  assert.ok(messageOf(store, 'new_Old'), 'the old name keeps its message while the step uses it');
  await json(await call('DELETE', `sdkmessageprocessingsteps(${STEP})`), 204);
  assert.equal(
    store.tableRows('sdkmessage').some((row) => row.sdkmessageid === oldMessageId),
    false,
    'the old name message goes with its last step',
  );
  assert.equal(
    store.tableRows('sdkmessagefilter').some((row) => row.sdkmessagefilterid === oldFilterId),
    false,
    'and its filter',
  );
  assert.ok(messageOf(store, 'new_New'), 'the new name has its message');
  assert.ok(filterOf(store, 'new_New'), 'and its filter');
});

// @test-kind unproven: the removal of a renamed custom API's kept message when its last step is deleted is a local model
test('a renamed custom API old message stays while another step uses it and goes with the last of its steps', async (t) => {
  const { call, json, store, api } = await namesHarness(t);
  const created = await json(await call('POST', 'customapis', api('new_Two')), 201);
  await pushStep(store, 'new_Two', false);
  await pushStepAs(store, 'new_Two', SECOND_STEP);
  await json(await call('PATCH', `customapis(${created.customapiid})`, { uniquename: 'new_Moved' }));
  await json(await call('DELETE', `sdkmessageprocessingsteps(${STEP})`), 204);
  assert.ok(messageOf(store, 'new_Two'), 'the message stays for the step still on it');
  await json(await call('DELETE', `sdkmessageprocessingsteps(${SECOND_STEP})`), 204);
  assert.equal(messageOf(store, 'new_Two'), undefined, 'the message goes with the last step');
});

// @test-kind unproven: a local model of the Web API changeset rollback; no capture exists of a failed changeset that deletes a step
test('a rolled-back delete of the last step keeps the old name message', async (t) => {
  const { call, json, store, api, batch } = await namesHarness(t);
  const created = await json(await call('POST', 'customapis', api('new_Rolled')), 201);
  await pushStep(store, 'new_Rolled', true);
  await json(await call('PATCH', `customapis(${created.customapiid})`, { uniquename: 'new_Kept' }));
  const oldMessageId = messageOf(store, 'new_Rolled').sdkmessageid;
  const part = (id, target) => [
    'Content-Type: application/http',
    'Content-Transfer-Encoding: binary',
    `Content-ID: ${id}`,
    '',
    `DELETE ${target} HTTP/1.1`,
  ];
  const text = [
    '--batch_1',
    'Content-Type: multipart/mixed; boundary=changeset_1',
    '',
    '--changeset_1',
    ...part(1, `/api/data/v9.2/sdkmessageprocessingsteps(${STEP})`),
    '--changeset_1',
    ...part(2, '/api/data/v9.2/sdkmessageprocessingsteps(99999999-0000-4000-8000-0000000000ff)'),
    '--changeset_1--',
    '--batch_1--',
    '',
  ].join('\r\n');
  const answer = await (await batch('batch_1', text)).text();
  assert.match(answer, /HTTP\/1\.1 404/);
  assert.ok(
    store.tableRows('sdkmessageprocessingstep').some((row) => row.sdkmessageprocessingstepid === STEP),
    'the step stays',
  );
  assert.ok(
    store.tableRows('sdkmessage').some((row) => row.sdkmessageid === oldMessageId),
    'the old name message stays',
  );
});

test('a custom API function accepts parameter aliases as the built-in functions do', async (t) => {
  const variable = 'PAQVILO_CUSTOM_API_ALIAS_TEST_SECRET',
    app = '66666666-6666-4666-8666-666666666666';
  const handler = async (context) => ({ outputs: { Result: String(context.inputs.Count) } });
  const { transport, tokenResponse } = await registryHarness(t, {
    variable,
    app,
    displayName: 'Invented registry client',
    customApis: new Map([['new_fn', { handler }]]),
  });
  const token = (await tokenResponse.json()).access_token;
  const { call, json } = bearerCalls(transport, token);
  const api = await json(
    await call('POST', 'customapis', {
      uniquename: 'new_fn',
      name: 'fn',
      description: 'Invented function',
      bindingtype: 0,
      isfunction: true,
    }),
    201,
  );
  const bind = { 'CustomAPIId@odata.bind': `/customapis(${api.customapiid})` };
  await json(
    await call('POST', 'customapirequestparameters', {
      uniquename: 'Count',
      name: 'Count',
      type: 7,
      isoptional: false,
      ...bind,
    }),
    201,
  );
  await json(
    await call('POST', 'customapiresponseproperties', { uniquename: 'Result', name: 'Result', type: 10, ...bind }),
    201,
  );
  assert.equal((await json(await call('GET', 'new_fn(Count=5)'))).Result, '5');
  assert.equal((await json(await call('GET', 'new_fn(Count=@c)?@c=5'))).Result, '5');
});
