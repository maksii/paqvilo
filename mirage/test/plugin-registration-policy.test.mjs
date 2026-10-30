import test from 'node:test';
import assert from 'node:assert/strict';
import { contractModuleFixture } from './contract-module-fixture.mjs';
import { overlayRegisteredSteps, solutionPluginExtension } from '../lib/dataverse-plugin-registration.mjs';
import { importSolutionPlugins, parsePluginDocument, pluginCatalogue } from '../lib/exported-plugins.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { createOrganizationBackend } from '../lib/organization-backend.mjs';

const assembly = '40000000-0000-0000-0000-000000000001';
const type = '50000000-0000-0000-0000-000000000001';
async function fixture(t, plugins) {
  const f = await contractModuleFixture(t, {
    mappings: {
      x_item: {
        logicalName: 'x_item',
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        fields: { x_name: { dataverseType: 'nvarchar' } },
      },
    },
    tables: {
      pluginassembly: [{ pluginassemblyid: assembly, name: 'Invented.Policy', version: '1.0.0.0' }],
      plugintype: [{ plugintypeid: type, typename: 'Invented.Policy.Guard', pluginassemblyid: assembly }],
      customapi: [0, 1, 2].map((policy) => ({
        customapiid: `20000000-0000-0000-0000-00000000000${policy}`,
        uniquename: `x_Policy${policy}`,
        bindingtype: 0,
        isfunction: false,
        allowedcustomprocessingsteptype: policy,
      })),
    },
    extension: {
      name: 'registration-policy-probe',
      install: plugins ? (api) => solutionPluginExtension(plugins).install(api) : () => {},
    },
  });
  const register = async (message, stage, mode = 0, extra = {}) => {
    const msg = f.store.tableRows('sdkmessage').find((row) => row.name === message);
    const filter = f.store
      .tableRows('sdkmessagefilter')
      .find(
        (row) =>
          row.sdkmessageid === msg.sdkmessageid &&
          row.primaryobjecttypecode === (message.startsWith('x_Policy') ? 'none' : 'x_item'),
      );
    return f.request('POST', '/sdkmessageprocessingsteps', {
      name: `${message} ${stage}/${mode}`,
      stage,
      mode,
      'sdkmessageid@odata.bind': `/sdkmessages(${msg.sdkmessageid})`,
      'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${filter.sdkmessagefilterid})`,
      'eventhandler_plugintype@odata.bind': `/plugintypes(${type})`,
      ...extra,
    });
  };
  return { ...f, register };
}

test('exported and observed availability metadata survives import and rejects a proven server-only filter/client-only step mismatch', async (t) => {
  const messageId = '9ebdbb1b-ea3e-db11-86a7-000a3a5473e8',
    filterId = '60000000-0000-0000-0000-000000000001';
  const parsed = parsePluginDocument(
    `<ImportExportXml><SdkMessage SdkMessageId="${messageId}" Name="Create" Availability="2"/><SdkMessageFilter SdkMessageFilterId="${filterId}" SdkMessageId="${messageId}" PrimaryObjectTypeCode="x_item" Availability="0"/></ImportExportXml>`,
  );
  const exported = importSolutionPlugins([
    { documents: [{ file: '/invented/availability.xml', facts: { plugins: parsed } }] },
  ]);
  assert.equal(exported.messages[0].availability, 2);
  assert.equal(exported.messageFilters[0].availability, 0);
  const importedFixture = await fixture(t, exported);
  assert.equal((await importedFixture.register('Create', 20, 0, { supporteddeployment: 1 })).status, 400);
  const observed = observedConfig({
    evidence: 'Invented captured message availability',
    sdkMessages: {
      [messageId]: {
        name: 'Create',
        evidence: 'Invented captured SDK message and filter metadata',
        availability: 2,
        filterAvailability: { x_item: 0 },
      },
    },
  });
  const plugins = importSolutionPlugins([], { sdkMessages: observed.sdkMessages });
  const f = await fixture(t, plugins);
  assert.equal(f.store.tableRows('sdkmessage').find((row) => row.name === 'Create').availability, 2);
  const message = f.store.tableRows('sdkmessage').find((row) => row.name === 'Create');
  assert.equal(
    f.store
      .tableRows('sdkmessagefilter')
      .find((row) => row.sdkmessageid === message.sdkmessageid && row.primaryobjecttypecode === 'x_item').availability,
    0,
  );
  const rejected = await f.register('Create', 20, 0, { supporteddeployment: 1 });
  assert.equal(rejected.status, 400);
  const error = (await rejected.json()).error;
  assert.equal(error.code, '0x80040203');
  assert.equal(error.message, 'Supported deployment does not agree with message availability');
  const both = await f.register('Create', 20, 0, { supporteddeployment: 2 });
  assert.equal(both.status, 400);
  assert.equal((await both.json()).error.message, 'Supported deployment does not agree with message availability');
  assert.equal((await f.register('Create', 20, 0, { supporteddeployment: 0 })).status, 201);
  const unknown = await fixture(t);
  assert.equal(
    (await unknown.register('Create', 20, 0, { supporteddeployment: 1 })).status,
    201,
    'synthetic local availability is not treated as native source evidence',
  );
  assert.throws(
    () =>
      observedConfig({
        evidence: 'Invented',
        sdkMessages: { [messageId]: { name: 'Create', evidence: 'Invented', availability: 3 } },
      }),
    /availability/,
  );
});

test('Associate and Disassociate accept explicit null message filters and retain their unfiltered binding', async (t) => {
  const f = await fixture(t);
  for (const message of ['Associate', 'Disassociate']) {
    const response = await f.register(message, 20, 0, { 'sdkmessagefilterid@odata.bind': null });
    assert.equal(response.status, 201);
    const row = await response.json();
    const step = overlayRegisteredSteps({ assemblies: [], types: [], steps: [] }, f.store).steps.find(
      (entry) => entry.id === row.sdkmessageprocessingstepid,
    );
    assert.equal(step.unfiltered, true);
    assert.equal(step.entity, null);
    assert.equal(step.unsupported, null);
  }
});

test('bulk image registration accepts supported Context4 images and keeps stage/message restrictions', async (t) => {
  const f = await fixture(t);
  for (const [message, stage, imageType, expected] of [
    ['CreateMultiple', 40, 1, 201],
    ['UpdateMultiple', 20, 0, 201],
    ['UpdateMultiple', 40, 2, 201],
    ['CreateMultiple', 20, 0, 400],
    ['UpdateMultiple', 20, 1, 400],
  ]) {
    const stepResponse = await f.register(message, stage);
    assert.equal(stepResponse.status, 201);
    const step = await stepResponse.json();
    const response = await f.request('POST', '/sdkmessageprocessingstepimages', {
      name: 'observed',
      entityalias: 'observed',
      imagetype: imageType,
      messagepropertyname: 'Targets',
      attributes: 'x_name',
      'sdkmessageprocessingstepid@odata.bind': `/sdkmessageprocessingsteps(${step.sdkmessageprocessingstepid})`,
    });
    assert.equal(response.status, expected, `${message} ${stage} image ${imageType}`);
    if (expected === 201) assert.equal((await response.json()).messagepropertyname, 'Targets');
    else assert.match((await response.json()).error.code, /^0x800441/);
  }
});

test('Create images require Id and retain post-image stage, type, alias and runtime projection', async (t) => {
  const f = await fixture(t);
  let accepted, acceptedImage;
  for (const [stage, imageType, property, code] of [
    [40, 1, 'Target', '0x8004416b'],
    [10, 1, 'Id', '0x8004416e'],
    [20, 1, 'Id', '0x8004416e'],
    [40, 0, 'Id', '0x8004416d'],
    [40, 2, 'Id', '0x8004416d'],
    [40, 1, 'Id', null],
  ]) {
    const step = await f.json(await f.register('Create', stage), 201);
    const response = await f.request('POST', '/sdkmessageprocessingstepimages', {
      name: 'Invented Create image',
      entityalias: 'Created',
      imagetype: imageType,
      messagepropertyname: property,
      attributes: 'x_name',
      'sdkmessageprocessingstepid@odata.bind': `/sdkmessageprocessingsteps(${step.sdkmessageprocessingstepid})`,
    });
    if (code) {
      assert.equal(response.status, 400, `${stage}/${imageType}/${property}`);
      assert.equal((await response.json()).error.code, code);
    } else {
      const image = await f.json(response, 201);
      assert.equal(image.entityalias, 'Created');
      assert.equal(image.messagepropertyname, 'Id');
      assert.equal(image.imagetype, 1);
      accepted = step.sdkmessageprocessingstepid;
      acceptedImage = image.sdkmessageprocessingstepimageid;
    }
  }
  const invalidPatch = await f.request('PATCH', `/sdkmessageprocessingstepimages(${acceptedImage})`, {
    messagepropertyname: 'Target',
  });
  assert.equal(invalidPatch.status, 400);
  assert.equal((await invalidPatch.json()).error.code, '0x8004416b');
  const retained = await f.json(await f.request('GET', `/sdkmessageprocessingstepimages(${acceptedImage})`), 200);
  assert.equal(retained.messagepropertyname, 'Id');
  assert.equal(retained.entityalias, 'Created');
  const seen = [],
    handlers = new Map([
      [
        accepted,
        ({ stage, postImage }) => {
          assert.deepEqual(postImage, { x_name: 'Invented post-image' });
          seen.push(stage);
        },
      ],
    ]);
  const items = () =>
    pluginCatalogue({ plugins: overlayRegisteredSteps({ assemblies: [], types: [], steps: [] }, f.store), handlers });
  const backend = await createOrganizationBackend({ store: f.store, items, handlers });
  t.after(() => backend.close());
  const created = await f.request('POST', '/x_items', { x_name: 'Invented post-image' });
  assert.equal(created.status, 201, await created.text());
  assert.deepEqual(seen, [40]);
});

test('custom API registration respects None, AsyncOnly and SyncAndAsync policies and exposes the message contract', async (t) => {
  const f = await fixture(t);
  for (const [policy, mode, expected] of [
    [0, 0, 400],
    [0, 1, 400],
    [1, 0, 400],
    [1, 1, 201],
    [2, 0, 201],
    [2, 1, 201],
  ]) {
    const response = await f.register(`x_Policy${policy}`, 40, mode);
    assert.equal(response.status, expected, `policy ${policy}, mode ${mode}`);
    if (expected === 400) assert.equal((await response.json()).error.code, policy === 0 ? '0x80090307' : '0x80090306');
    else await response.text();
  }
  const steps = overlayRegisteredSteps({ steps: [] }, f.store).steps;
  assert.equal(steps.length, 3);
  assert.deepEqual(
    steps.map((step) => step.customApi.allowedCustomProcessingStepType),
    [1, 2, 2],
  );
  assert.ok(steps.every((step) => step.customApi.bindingType === 0));
  f.store.tableRows('customapi').find((row) => row.uniquename === 'x_Policy2').isfunction = true;
  assert.equal(
    (await f.register('x_Policy2', 40, 1)).status,
    201,
    'function extension policy is independent of workflow-enabled restrictions',
  );
  const none = f.store.tableRows('sdkmessage').find((row) => row.name === 'x_Policy0');
  assert.equal(
    f.store.tableRows('sdkmessagefilter').find((row) => row.sdkmessageid === none.sdkmessageid)
      .iscustomprocessingstepallowed,
    false,
  );
});

test('plug-in type friendly names are globally unique on create and update', async (t) => {
  const f = await fixture(t);
  const create = (typename, friendlyname) =>
    f.request('POST', '/plugintypes', {
      typename,
      friendlyname,
      'pluginassemblyid@odata.bind': `/pluginassemblies(${assembly})`,
    });
  const first = await create('Invented.Policy.First', 'Same display name');
  assert.equal(first.status, 201);
  const duplicate = await create('Invented.Policy.Second', 'Same display name');
  assert.equal(duplicate.status, 412);
  assert.equal((await duplicate.json()).error.code, '0x80040237');
  const differentCase = await create('Invented.Policy.Third', 'SAME DISPLAY NAME');
  assert.equal(differentCase.status, 412);
  const secondAssembly = '40000000-0000-0000-0000-000000000002';
  f.store.state.tables.pluginassembly.push({
    pluginassemblyid: secondAssembly,
    name: 'Invented.Other',
    version: '1.0.0.0',
  });
  assert.equal(
    (
      await f.request('POST', '/plugintypes', {
        typename: 'Invented.Other.Type',
        friendlyname: 'Same display name',
        'pluginassemblyid@odata.bind': `/pluginassemblies(${secondAssembly})`,
      })
    ).status,
    412,
  );
  const second = await create('Invented.Policy.Second', 'Second display name');
  assert.equal(second.status, 201);
  const row = await second.json();
  const update = await f.request('PATCH', `/plugintypes(${row.plugintypeid})`, { friendlyname: 'Same display name' });
  assert.equal(update.status, 412);
  assert.equal(
    f.store.tableRows('plugintype').find((entry) => entry.plugintypeid === row.plugintypeid).friendlyname,
    'Second display name',
  );
});

test('registration refuses unsupported mode and deployment enum values with the native validation envelope', async (t) => {
  const f = await fixture(t);
  const msg = f.store.tableRows('sdkmessage').find((row) => row.name === 'Create');
  for (const [column, value, accepted] of [
    ['mode', 2, '0,1'],
    ['supporteddeployment', 9, '0,1,2'],
  ]) {
    const response = await f.request('POST', '/sdkmessageprocessingsteps', {
      name: 'Invalid enum',
      stage: 20,
      [column]: value,
      'sdkmessageid@odata.bind': `/sdkmessages(${msg.sdkmessageid})`,
      'eventhandler_plugintype@odata.bind': `/plugintypes(${type})`,
    });
    assert.equal(response.status, 400);
    const error = (await response.json()).error;
    assert.equal(error.code, '0x8004431a');
    assert.equal(
      error.message,
      `A validation error occurred. The value ${value} of '${column}' on record of type 'sdkmessageprocessingstep' is outside the valid range. Accepted Values: ${accepted}`,
    );
  }
});
