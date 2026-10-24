import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore } from 'paqvilo/mirage/lib/data.mjs';
import { recordToSdkEntity } from 'paqvilo/mirage/lib/plugin-clr.mjs';
import {
  applyNativeDataSnapshot,
  compareRecordedContexts,
  contextFromNativeCapture,
  recordedPluginPayloads,
  validateNativeReadWitness,
  nativeRegistrationFingerprint,
  compareRecordedPluginArtifacts,
  prepareNativeReplayPlugins,
  compareNativeReadArtifacts,
  nativeReadRequestInput,
  nativeRecordingInputs,
  validateFinalQueryObserverWitness,
} from '../mirage-runtime.mjs';

test('recorder source inputs retain actual platform fields and reject altered intent/Run binding', () => {
  const actor = '10000000-0000-0000-0000-000000000031',
    runId = '10000000-0000-0000-0000-000000000032',
    operationId = '10000000-0000-0000-0000-000000000033',
    creator = '10000000-0000-0000-0000-000000000034',
    marker = 'CO-UTC:2026-10-13T00:00:00.000Z';
  const mappings = {
    widget: { entitySet: 'widgets', idColumn: 'widgetid', primaryNameColumn: 'title' },
    pqvd_testrun: { idColumn: 'pqvd_testrunid' },
    pqvd_testoperation: { idColumn: 'pqvd_testoperationid' },
  };
  for (const entity of ['pqvd_testrun', 'pqvd_testoperation'])
    mappings[entity].fields = {
      createdby: { type: 'lookup', targets: ['systemuser'] },
      pqvd_runnercontactid: { type: 'lookup', targets: ['contact'] },
      pqvd_runid: { type: 'lookup', targets: ['pqvd_testrun'] },
    };
  const store = new DataStore({
      state: { mappings, tables: { widget: [] }, settings: { permissionMode: 'permissive' } },
    }),
    url = new URL('http://127.0.0.1/_api/widgets');
  url.searchParams.set('$filter', `title ne 'CO-OP:${operationId}' and title ne '${marker}'`);
  const request = { lane: 'webapi', operationId, caseId: 'Q1', variant: 'odata', url: url.href },
    base = { '@odata.etag': 'W/"9007199254740993"', _createdby_value: creator, _pqvd_runnercontactid_value: actor };
  const capture = {
    runId,
    requests: [request],
    recordingInputs: {
      run: { ...base, pqvd_testrunid: runId, pqvd_name: 'Native name' },
      operations: [
        {
          ...base,
          pqvd_testoperationid: operationId,
          _pqvd_runid_value: runId,
          pqvd_caseid: 'Q1',
          pqvd_variant: 'odata',
          pqvd_markeroperation: 'CO-OP:' + operationId,
          pqvd_markerutc: marker,
          pqvd_roottable: 'widget',
          pqvd_expectedmessage: 'RetrieveMultiple',
          pqvd_lane: 183270001,
          pqvd_name: 'Actual source operation',
          createdon: '2026-10-13T00:00:00Z',
        },
      ],
    },
  };
  capture.recordingInputs.run._organizationid_value = creator;
  capture.recordingInputs.run._modifiedby_value = creator;
  const result = nativeRecordingInputs(store, capture, { contactId: actor });
  assert.equal(result.verified, true);
  assert.equal(result.operations[0].pqvd_name, 'Actual source operation');
  assert.equal(result.operations[0].versionnumber, '9007199254740993');
  assert.deepEqual(result.operations[0].createdby, { id: creator, logical_name: 'systemuser' });
  assert.deepEqual(result.run.organizationid, { id: creator, logical_name: 'organization' });
  assert.deepEqual(result.run.modifiedby, { id: creator, logical_name: 'systemuser' });
  assert.equal(store.state.tables.pqvd_testoperation, undefined);
  for (const mutate of [
    (c) => (c.recordingInputs.run._pqvd_runnercontactid_value = creator),
    (c) => (c.recordingInputs.operations[0].pqvd_variant = 'other'),
    (c) => delete c.recordingInputs.operations[0]['@odata.etag'],
    (c) => c.recordingInputs.operations.push(c.recordingInputs.operations[0]),
    (c) => (c.recordingInputs.operations[0].pqvd_markerutc = 'CO-UTC:2026-10-14T00:00:00.000Z'),
  ]) {
    const bad = structuredClone(capture);
    mutate(bad);
    assert.throws(() => nativeRecordingInputs(store, bad, { contactId: actor }), /recorder/);
  }
  assert.equal(
    nativeRecordingInputs(store, { ...capture, recordingInputs: undefined }, { contactId: actor }).verified,
    false,
  );
  const polymorphic = structuredClone(capture);
  polymorphic.recordingInputs.run._ownerid_value = creator;
  assert.throws(() => nativeRecordingInputs(store, polymorphic, { contactId: actor }), /typed source metadata/);
});

const id = '10000000-0000-0000-0000-000000000001';
test('OData replay derives root and markers exclusively from the actual authored URL, retaining invalid projections for real HTTP admission', () => {
  const store = new DataStore({
    state: {
      mappings: { widget: { entitySet: 'widgets', idColumn: 'widgetid', primaryNameColumn: 'title' } },
      tables: { widget: [] },
      permissions: [],
      settings: { permissionMode: 'enforce' },
    },
  });
  const url = new URL('http://127.0.0.1/_api/widgets');
  url.searchParams.set('$select', 'invalid_alias');
  url.searchParams.set('$filter', `title ne 'CO-OP:${id}' and title ne 'CO-UTC:2026-10-13T00:00:00.000Z'`);
  const request = { lane: 'webapi', operationId: id, url: url.href };
  assert.deepEqual(nativeReadRequestInput(store, request), {
    source: null,
    table: 'widget',
    marker: 'CO-UTC:2026-10-13T00:00:00.000Z',
    page: 1,
  });
  for (const filter of [
    `title ne 'CO-OP:10000000-0000-0000-0000-000000000099' and title ne 'CO-UTC:2026-10-13T00:00:00.000Z'`,
    `title eq 'CO-OP:${id}' and title ne 'CO-UTC:2026-10-13T00:00:00.000Z'`,
    `other ne 'CO-OP:${id}' and title ne 'CO-UTC:2026-10-13T00:00:00.000Z'`,
  ]) {
    const invalid = new URL(url);
    invalid.searchParams.set('$filter', filter);
    assert.throws(() => nativeReadRequestInput(store, { ...request, url: invalid.href }), /markers/);
  }
});
async function sourceFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-native-source-')));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5 }));
  const exportRoot = path.join(root, 'exports'),
    sdkRoot = path.join(root, 'sdk'),
    sdkAssembly = path.join(sdkRoot, 'Sdk.dll'),
    cacheRoot = path.join(root, 'cache');
  await fs.mkdir(exportRoot);
  await fs.mkdir(sdkRoot);
  await fs.writeFile(sdkAssembly, 'invented SDK bytes');
  return {
    root,
    exportRoot,
    sdkRoot,
    sdkAssembly,
    cacheRoot,
    options: {
      exportRoot,
      sdkAssembly,
      cacheRoot,
      context: { initiatingUserId: id, organizationId: id, businessUnitId: id },
      serviceProfiles: [
        { userId: id, evidence: 'Invented source fixture', grants: [{ entity: 'widget', operations: ['read'] }] },
      ],
    },
  };
}

test('Native replay receipts use a bounded opened source handle and reject pathname replacement', async (t) => {
  const fixture = await sourceFixture(t),
    originalOpen = fs.open;
  const replacement = path.join(fixture.root, 'replacement.dll');
  await fs.writeFile(replacement, 'replacement SDK');
  const receipt = await prepareNativeReplayPlugins(fixture.options);
  assert.equal(receipt.receipt.sdkSha256, createHash('sha256').update('invented SDK bytes').digest('hex'));
  let opened;
  fs.open = async function (file, ...args) {
    const handle = await originalOpen(file, ...args);
    if (file === fixture.sdkAssembly) {
      opened = handle;
      await fs.rename(file, file + '.retained');
      await fs.rename(replacement, file);
    }
    return handle;
  };
  try {
    await assert.rejects(prepareNativeReplayPlugins(fixture.options), /regular DLL/);
    assert.equal(opened.fd, -1);
  } finally {
    fs.open = originalOpen;
  }
});

test('Native replay rejects source replacement during reading and closes its original handle', async (t) => {
  const fixture = await sourceFixture(t),
    originalOpen = fs.open;
  let opened;
  const replacement = path.join(fixture.root, 'replacement.dll');
  await fs.writeFile(replacement, 'replacement SDK');
  fs.open = async function (file, ...args) {
    const handle = await originalOpen(file, ...args);
    if (file === fixture.sdkAssembly) {
      opened = handle;
      const read = handle.read.bind(handle);
      let replaced = false;
      handle.read = async (args) => {
        if (!replaced) {
          replaced = true;
          await fs.rename(file, file + '.retained');
          await fs.rename(replacement, file);
        }
        return read(args);
      };
    }
    return handle;
  };
  try {
    await assert.rejects(prepareNativeReplayPlugins(fixture.options), /changed during preparation/);
    assert.equal(opened.fd, -1);
  } finally {
    fs.open = originalOpen;
  }
});

test('Native replay refuses sources growing past the 32 MiB limit on the opened handle', async (t) => {
  const fixture = await sourceFixture(t),
    originalOpen = fs.open;
  let opened,
    total = 0;
  const growing = await originalOpen(fixture.sdkAssembly, 'r+');
  fs.open = async function (file, ...args) {
    const handle = await originalOpen(file, ...args);
    if (file === fixture.sdkAssembly) {
      opened = handle;
      const read = handle.read.bind(handle);
      let grew = false;
      handle.read = async (args) => {
        if (!grew) {
          grew = true;
          await growing.truncate(32 * 1024 * 1024 + 100);
        }
        const answer = await read(args);
        total += answer.bytesRead;
        return answer;
      };
    }
    return handle;
  };
  try {
    await assert.rejects(prepareNativeReplayPlugins(fixture.options), /regular DLL/);
    assert.equal(total, 32 * 1024 * 1024 + 1);
    assert.equal(opened.fd, -1);
  } finally {
    fs.open = originalOpen;
    await growing.close();
  }
});

test('Native replay rejects SDK directory links introduced between validation and opening', async (t) => {
  const fixture = await sourceFixture(t),
    originalOpen = fs.open,
    originalRealpath = fs.realpath;
  let opened,
    replaced = false;
  fs.realpath = async function (directory, ...args) {
    const actual = await originalRealpath(directory, ...args);
    if (directory === fixture.sdkRoot && !replaced) {
      replaced = true;
      await fs.rename(fixture.sdkRoot, fixture.sdkRoot + '.retained');
      await fs.symlink(
        fixture.sdkRoot + '.retained',
        fixture.sdkRoot,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    return actual;
  };
  fs.open = async function (file, ...args) {
    const handle = await originalOpen(file, ...args);
    if (file === path.join(fixture.sdkRoot + '.retained', 'Sdk.dll')) opened = handle;
    return handle;
  };
  try {
    await assert.rejects(prepareNativeReplayPlugins(fixture.options), /symlink|directory changed/);
    assert.equal(replaced, true);
    assert.equal(opened.fd, -1);
  } finally {
    fs.open = originalOpen;
    fs.realpath = originalRealpath;
  }
});

test('Native replay copies the exact assembly bytes that matched the receipt without reopening the export', async (t) => {
  const fixture = await sourceFixture(t),
    directory = path.join(fixture.exportRoot, 'PluginAssemblies');
  await fs.mkdir(directory);
  const assembly = path.join(directory, 'Original.dll'),
    originalBytes = Buffer.from('invented original DLL');
  await fs.writeFile(assembly, originalBytes);
  const replacement = path.join(fixture.root, 'replacement.dll');
  await fs.writeFile(replacement, 'unverified replacement DLL');
  const typeId = '20000000-0000-0000-0000-000000000001',
    stepId = '30000000-0000-0000-0000-000000000001';
  await fs.writeFile(
    path.join(directory, 'Original.xml'),
    `<ImportExportXml><PluginAssembly PluginAssemblyId="${id}" Name="Invented.Original"><FileName>/PluginAssemblies/Original.dll</FileName><PluginType PluginTypeId="${typeId}" TypeName="Invented.Original"/></PluginAssembly><SdkMessageProcessingStep SdkMessageProcessingStepId="${stepId}"><PluginTypeId>${typeId}</PluginTypeId><MessageName>Create</MessageName><PrimaryEntity>widget</PrimaryEntity><Stage>20</Stage><Rank>1</Rank><Mode>0</Mode></SdkMessageProcessingStep></ImportExportXml>`,
  );
  const originalMkdir = fs.mkdir;
  let replacements = 0;
  fs.mkdir = async function (directory, ...args) {
    if (directory === fixture.cacheRoot) {
      await fs.rename(assembly, assembly + '.retained');
      await fs.rename(replacement, assembly);
      replacements++;
    }
    return originalMkdir(directory, ...args);
  };
  try {
    await assert.rejects(
      prepareNativeReplayPlugins({
        ...fixture.options,
        expectedAssemblyHashes: { 'Invented.Original': createHash('sha256').update(originalBytes).digest('hex') },
      }),
      (error) => ['LocalPluginClrBuild', 'LocalPluginClrUnavailable'].includes(error.code),
    );
    assert.equal(replacements, 1);
    assert.deepEqual(
      await fs.readFile(path.join(fixture.cacheRoot, 'trusted-originals', 'Original.dll')),
      originalBytes,
    );
  } finally {
    fs.mkdir = originalMkdir;
  }
});

test('Native snapshot defaults, exact lookup targets and independent SDK RowVersion survive a selected projection', () => {
  const store = new DataStore({
    state: {
      mappings: {
        item: {
          entitySet: 'items',
          idColumn: 'itemid',
          fields: { principal: { type: 'lookup', targets: ['contact'] } },
        },
      },
      tables: { item: [] },
      relationships: {},
      permissions: [],
      plugins: [],
      settings: { permissionMode: 'enforce' },
    },
  });
  applyNativeDataSnapshot(
    store,
    {
      tables: { item: [{ itemid: id, title: 'Native default', _principal_value: id, statecode: 0 }] },
      projections: {},
      dataSnapshotHash: 'proof',
    },
    { rowVersions: { item: { [id]: '123456789' } } },
  );
  assert.deepEqual(store.state.tables.item[0].principal, { id, logical_name: 'contact' });
  assert.equal(store.state.tables.item[0].statecode, 0);
  const sdk = recordToSdkEntity(store, 'item', { itemid: id, title: 'Native default' }, { columns: ['title'] });
  assert.equal(sdk.rowVersion, '123456789');
  assert.deepEqual(sdk.attributes, { title: 'Native default' });
});

test('Actual actor/customer supplemental rows preserve polymorphic lookup targets and actor versions atomically', () => {
  const contact = '10000000-0000-0000-0000-000000000002',
    customer = '10000000-0000-0000-0000-000000000003';
  const store = new DataStore({
    state: {
      mappings: {
        contact: {
          idColumn: 'contactid',
          entitySet: 'contacts',
          fields: { parentcustomerid: { type: 'lookup', targets: ['account'] } },
        },
        account: { idColumn: 'accountid', entitySet: 'accounts' },
      },
      tables: { contact: [], account: [] },
      plugins: [],
      permissions: [],
      settings: { permissionMode: 'enforce' },
    },
  });
  const snapshot = {
      contactId: contact,
      tables: { contact: [], account: [] },
      projections: {},
      actorBinding: {
        actor: { contactid: contact, _parentcustomerid_value: customer, statecode: 0 },
        customer: { id: customer, type: 'contact', row: { contactid: customer, statecode: 0 } },
      },
      rowVersions: { actor: { contact: '9007199254740993' } },
      dataSnapshotHash: 'a'.repeat(64),
    },
    before = structuredClone(snapshot);
  applyNativeDataSnapshot(store, snapshot);
  assert.deepEqual(snapshot, before);
  assert.deepEqual(store.state.tables.contact.find((row) => row.contactid === contact).parentcustomerid, {
    id: customer,
    logical_name: 'contact',
  });
  assert.equal(
    recordToSdkEntity(
      store,
      'contact',
      store.state.tables.contact.find((row) => row.contactid === contact),
      { columns: ['contactid'] },
    ).rowVersion,
    '9007199254740993',
  );
  assert.equal(store.nativeReadSnapshot.dataSnapshotHash, snapshot.dataSnapshotHash);
  const state = store.snapshot(),
    conflicting = structuredClone(snapshot);
  conflicting.actorBinding.customer.row.contactid = contact;
  assert.throws(() => applyNativeDataSnapshot(store, conflicting), /customer binding/);
  assert.deepEqual(store.snapshot(), state);
});
test('Malformed projection snapshots do not partially replace local data', () => {
  const store = new DataStore({
    state: {
      mappings: { item: { entitySet: 'items', idColumn: 'itemid' } },
      tables: { item: [{ itemid: id, title: 'Original' }] },
      relationships: {},
      settings: { permissionMode: 'permissive' },
    },
  });
  const before = store.snapshot();
  assert.throws(
    () =>
      applyNativeDataSnapshot(store, {
        tables: { item: [{ itemid: id, title: 'Changed' }] },
        projections: { unknown: [] },
      }),
    /exact imported relationship/,
  );
  assert.deepEqual(store.snapshot(), before);
});
test('Frozen lookup target annotations preserve source provenance and reject metadata conflicts atomically', () => {
  const store = new DataStore({
    state: {
      mappings: {
        item: {
          entitySet: 'items',
          idColumn: 'itemid',
          fields: { principal: { type: 'lookup', targets: ['contact'] } },
        },
      },
      tables: { item: [] },
      relationships: {},
      settings: { permissionMode: 'permissive' },
    },
  });
  applyNativeDataSnapshot(store, {
    tables: {
      item: [
        { itemid: id, _createdby_value: id, '_createdby_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'systemuser' },
      ],
    },
    projections: {},
  });
  assert.deepEqual(store.state.tables.item[0].createdby, { id, logical_name: 'systemuser' });
  const before = store.snapshot();
  assert.throws(
    () =>
      applyNativeDataSnapshot(store, {
        tables: {
          item: [
            {
              itemid: id,
              _principal_value: id,
              '_principal_value@Microsoft.Dynamics.CRM.lookuplogicalname': 'account',
            },
          ],
        },
        projections: {},
      }),
    /conflicts/,
  );
  assert.deepEqual(store.snapshot(), before);
});

test('Context comparison preserves volatile differences explicitly and ignores object key order', () => {
  const native = {
    MessageName: 'RetrieveMultiple',
    input: { Query: { type: 'FetchExpression', xml: '<fetch />' }, AppModuleId: { type: 'Guid', value: id } },
    RequestId: id,
  };
  const local = {
    ...native,
    input: { AppModuleId: { value: id, type: 'Guid' }, Query: { xml: '<fetch />', type: 'FetchExpression' } },
    RequestId: '10000000-0000-0000-0000-000000000002',
  };
  const comparison = compareRecordedContexts(native, local);
  assert.equal(comparison.stableEqual, true);
  assert.equal(comparison.fullSnapshotEqual, false);
  assert.ok(comparison.generatedFields.includes('RequestId'));
  local.input.Query.xml = '<fetch distinct="true" />';
  assert.deepEqual(
    compareRecordedContexts(native, local).differences.map((change) => change.field),
    ['input'],
  );
});
test('Generated context values still require matching presence and runtime type', () => {
  const native = {
    RequestId: id,
    OperationCreatedOn: '/Date(123)/',
    parents: [{ CorrelationId: id, OperationId: id, OperationCreatedOn: '/Date(123)/' }],
  };
  const local = {
    RequestId: '10000000-0000-0000-0000-000000000002',
    OperationCreatedOn: '/Date(456)/',
    parents: [
      { CorrelationId: '10000000-0000-0000-0000-000000000002', OperationId: id, OperationCreatedOn: '/Date(456)/' },
    ],
  };
  assert.equal(compareRecordedContexts(native, local).stableEqual, true);
  for (const mutate of [
    (x) => delete x.RequestId,
    (x) => (x.RequestId = 'invalid'),
    (x) => (x.OperationCreatedOn = 456),
    (x) => (x.parents[0].CorrelationId = null),
  ]) {
    const changed = structuredClone(local);
    mutate(changed);
    assert.equal(compareRecordedContexts(native, changed).stableEqual, false);
  }
});

test('Only a well-shaped generated span value is excluded from shared-variable comparison', () => {
  const native = {
    schemaVersion: 1,
    sharedVariables: {
      'pqvd.lab.operation': { type: 'String', value: id, truncated: false },
      'pqvd.lab.span': { type: 'String', value: id, truncated: false },
      custom: { type: 'String', value: 'same', truncated: false },
    },
  };
  const local = structuredClone(native);
  local.sharedVariables['pqvd.lab.span'].value = '10000000-0000-0000-0000-000000000002';
  assert.equal(compareRecordedContexts(native, local).stableEqual, true);
  for (const mutate of [
    (x) => (x.sharedVariables.custom.value = 'changed'),
    (x) => (x.sharedVariables['pqvd.lab.operation'].value = 'changed'),
    (x) => (x.sharedVariables['pqvd.lab.span'].type = 'Guid'),
    (x) => (x.schemaVersion = 2),
  ]) {
    const changed = structuredClone(local);
    mutate(changed);
    assert.equal(compareRecordedContexts(native, changed).stableEqual, false);
  }
});

test('Source Context7 profiles preserve only safe observed portal inputs and user-agent presence', () => {
  const capture = {
    interfaceVersion: 7,
    UserId: id,
    InitiatingUserId: id,
    OrganizationId: id,
    BusinessUnitId: id,
    SecondaryEntityName: 'none',
    organizationName: { value: 'observed' },
    input: {
      AppModuleId: { type: 'Guid', value: id },
      IsAppModuleContext: { type: 'Boolean', value: false },
      Query: { type: 'FetchExpression', xml: 'private query' },
    },
    extensions: {
      context5: { values: { initiatingUserAgentPresent: true } },
      context6: {
        observed: true,
        values: { environmentId: { value: 'observed-environment' }, tenantId: { value: id } },
      },
      context7: { observed: true, values: { IsApplicationUser: true } },
    },
  };
  const context = contextFromNativeCapture(capture);
  assert.equal(context.secondaryEntityName, 'none');
  assert.deepEqual(context.portalInputParameters, {
    AppModuleId: { $type: 'Guid', value: id },
    IsAppModuleContext: false,
  });
  assert.equal(context.initiatingUserAgentPresent, true);
  assert.ok(!JSON.stringify(context).includes('private query'));
  const withGoldenOutput = { ...capture, output: { BusinessEntityCollection: { entities: [], pagingCookie: '' } } };
  assert.deepEqual(
    contextFromNativeCapture(withGoldenOutput),
    context,
    'Expected output must never influence the local context profile.',
  );
});
test('Native event replay rejects missing, reordered-number and modified payload parts', () => {
  const content = JSON.stringify({ artifact: 'Incoming query', text: 'Unicode \ud83d\ude00' }),
    checksum = createHash('sha256').update(content).digest('hex');
  const split = content.indexOf('Unicode'),
    parts = [content.slice(0, split), content.slice(split)].map((pqvd_payloadtext, index) => ({
      pqvd_eventkey: 'test-event',
      pqvd_partnumber: index + 1,
      pqvd_partcount: 2,
      pqvd_payloadhash: checksum,
      pqvd_payloadtext,
    }));
  assert.deepEqual(recordedPluginPayloads([...parts].reverse()), [JSON.parse(content)]);
  assert.throws(() => recordedPluginPayloads(parts.slice(1)), /incomplete/);
  assert.throws(() => recordedPluginPayloads(parts.map((part) => ({ ...part, pqvd_partnumber: 1 }))), /inconsistent/);
  assert.throws(
    () =>
      recordedPluginPayloads(
        parts.map((part, index) => ({ ...part, pqvd_payloadtext: part.pqvd_payloadtext + (index ? 'tamper' : '') })),
      ),
    /checksum/,
  );
});
test('Complete read qualification requires frozen data, versions, permission graph, memberships and registration', () => {
  const fields = ['permissionSnapshotHash', 'membershipSnapshotHash', 'dataSnapshotHash', 'rowVersionSnapshotHash'],
    before = { ...Object.fromEntries(fields.map((field) => [field, 'a'.repeat(64)])), complete: true },
    witness = { before, after: { ...before }, registrationSha256: 'b'.repeat(64) },
    receipt = { registrationSha256: 'b'.repeat(64) };
  assert.equal(validateNativeReadWitness(witness, receipt, before).verified, true);
  for (const field of fields) {
    const changed = structuredClone(witness);
    changed.after[field] = 'c'.repeat(64);
    assert.deepEqual(validateNativeReadWitness(changed, receipt, before).reasons, [field]);
  }
  assert.equal(validateNativeReadWitness(undefined, receipt, before).verified, false);
  assert.deepEqual(validateNativeReadWitness(witness, { registrationSha256: 'c'.repeat(64) }, before).reasons, [
    'registrationSha256',
  ]);
  assert.equal(validateNativeReadWitness(witness, receipt).verified, false);
  assert.deepEqual(
    validateNativeReadWitness({ ...witness, after: { ...before, complete: false } }, receipt, before).reasons,
    ['sourceCompleteness'],
  );
});
test('Registration witness ignores discovery clocks and OData annotations but retains actual configuration and step state', () => {
  const native = {
    schemaVersion: 1,
    capturedAt: 'old',
    applicationUserId: id,
    steps: [{ sdkmessageprocessingstepid: id, statecode: 0, configuration: 'fixture', '@odata.etag': 'W/123' }],
    filters: [],
    messages: [],
    images: [],
  };
  const changed = structuredClone(native);
  changed.capturedAt = 'new';
  changed.steps[0]['@odata.etag'] = 'W/456';
  assert.equal(nativeRegistrationFingerprint(native), nativeRegistrationFingerprint(changed));
  for (const mutate of [
    (x) => (x.steps[0].statecode = 1),
    (x) => (x.steps[0].configuration = 'changed'),
    (x) => (x.steps[0].rank = 99),
  ]) {
    const changed = structuredClone(native);
    mutate(changed);
    assert.notEqual(nativeRegistrationFingerprint(native), nativeRegistrationFingerprint(changed));
  }
});
test('Original plugin artifact qualification binds actual assembly identity, content and durable mode', () => {
  const native = {
    schemaVersion: 1,
    assemblyIdentity: { name: 'Invented', version: '1.0.0.0', moduleVersionId: id },
    operationId: id,
    artifact: 'Query',
    content: { physicalQueryHash: 'hash', query: { xml: '<fetch />' }, actorBinding: 'Native' },
    durability: 'Transactional',
    captureTime: '2026-10-13T13:49:04.9764884Z',
    spanId: id,
    parentSpanId: null,
  };
  const local = {
    ...structuredClone(native),
    captureTime: '2026-10-13T14:19:37.2730431Z',
    spanId: '10000000-0000-0000-0000-000000000002',
  };
  assert.equal(compareRecordedPluginArtifacts(native, local).stableEqual, true);
  for (const mutate of [
    (x) => (x.assemblyIdentity.moduleVersionId = '10000000-0000-0000-0000-000000000002'),
    (x) => (x.content.actorBinding = 'Changed'),
    (x) => (x.durability = 'Changed'),
    (x) => (x.spanId = null),
  ]) {
    const changed = structuredClone(local);
    mutate(changed);
    assert.equal(compareRecordedPluginArtifacts(native, changed).stableEqual, false);
  }
});

test('native artifact decoding preserves distinct Int64 and decimal digits instead of qualifying rounded JSON values', () => {
  const payload = (number) => {
    const pqvd_payloadtext = `{"schemaVersion":2,"artifact":"Precision","content":{"value":${number}}}`;
    return [
      {
        pqvd_eventkey: 'precision',
        pqvd_partnumber: 1,
        pqvd_partcount: 1,
        pqvd_payloadhash: createHash('sha256').update(pqvd_payloadtext).digest('hex'),
        pqvd_payloadtext,
      },
    ];
  };
  const integer = recordedPluginPayloads(payload('9007199254740993'))[0],
    roundedInteger = recordedPluginPayloads(payload('9007199254740992'))[0];
  const decimal = recordedPluginPayloads(payload('12345678901234567890.01'))[0],
    changedDecimal = recordedPluginPayloads(payload('12345678901234567890.02'))[0];
  assert.notDeepEqual(integer.content, roundedInteger.content);
  assert.notDeepEqual(decimal.content, changedDecimal.content);
  assert.equal(compareRecordedPluginArtifacts(integer, roundedInteger).stableEqual, false);
  assert.equal(compareRecordedPluginArtifacts(decimal, changedDecimal).stableEqual, false);
});

test('admitted fault comparison requires exact pre-fault artifacts, independent wire failure and no extra collection or execution', () => {
  const native = [10, 20].map((Stage) => ({
    schemaVersion: 2,
    artifact: 'Query.' + Stage,
    operationId: id,
    assemblyIdentity: { moduleVersionId: id },
    content: { query: { type: 'FetchExpression', xml: '<fetch />' } },
    context: { schemaVersion: 2, Stage, owningExtension: { id }, input: { Query: { xml: '<fetch />' } }, output: {} },
    captureTime: '2026-10-13T12:00:00.1234567Z',
    spanId: id,
    parentSpanId: null,
  }));
  const options = {
    wireQualified: true,
    wireFailure: true,
    localPhases: [{ stage: 10 }, { stage: 20 }],
    localBackendExecutions: 1,
  };
  const good = compareNativeReadArtifacts(native, structuredClone(native), options);
  assert.equal(good.qualified, true);
  assert.equal(good.admittedFaultExact, true);
  assert.equal(good.rowExact, false);
  assert.equal(good.backendFaultCodeObserved, false);
  const extra = structuredClone(native);
  extra.push({
    ...structuredClone(native[1]),
    artifact: 'Query.40',
    context: {
      ...structuredClone(native[1].context),
      Stage: 40,
      output: { BusinessEntityCollection: { type: 'EntityCollection', entities: [] } },
    },
  });
  assert.equal(compareNativeReadArtifacts(native, extra, options).qualified, false);
  assert.equal(compareNativeReadArtifacts(native, native.slice(0, 1), options).qualified, false);
  const changedXml = structuredClone(native);
  changedXml[0].content.query.xml = '<fetch distinct="true"/>';
  assert.equal(compareNativeReadArtifacts(native, changedXml, options).qualified, false);
  for (const changed of [
    { wireQualified: false },
    { wireFailure: false },
    { localBackendExecutions: 2 },
    { localPhases: [{ stage: 10 }, { stage: 20 }, { stage: 40 }] },
    { localPhases: [{ stage: 20 }, { stage: 10 }] },
    { localPhases: [{ stage: 20 }] },
    { localPhases: [{ stage: 10 }, { stage: 10 }, { stage: 20 }] },
  ])
    assert.equal(
      compareNativeReadArtifacts(native, structuredClone(native), { ...options, ...changed }).qualified,
      false,
    );
  const absentQuery = structuredClone(native);
  for (const event of absentQuery) delete event.content.query;
  assert.equal(compareNativeReadArtifacts(absentQuery, structuredClone(absentQuery), options).qualified, false);
  const truncated = [
    {
      ...structuredClone(native[1]),
      artifact: 'Query.40',
      context: {
        ...structuredClone(native[1].context),
        Stage: 40,
        output: { BusinessEntityCollection: { type: 'EntityCollection', entities: [], truncated: true } },
      },
    },
  ];
  assert.equal(compareNativeReadArtifacts(truncated, structuredClone(truncated), options).rowExact, false);
  const positive = [
      ...structuredClone(native),
      {
        ...structuredClone(native[1]),
        artifact: 'Query.40',
        context: {
          ...structuredClone(native[1].context),
          Stage: 40,
          output: { BusinessEntityCollection: { type: 'EntityCollection', entities: [], truncated: false } },
        },
      },
    ],
    positiveOptions = {
      wireQualified: true,
      localBackendExecutions: 1,
      localPhases: [{ stage: 10 }, { stage: 20 }, { stage: 40 }],
    };
  assert.equal(compareNativeReadArtifacts(positive, structuredClone(positive), positiveOptions).qualified, true);
  for (const changed of [
    { localBackendExecutions: 2 },
    { localPhases: [{ stage: 10 }, { stage: 20 }] },
    { localPhases: [{ stage: 10 }, { stage: 20 }, { stage: 40 }, { stage: 40 }] },
  ])
    assert.equal(
      compareNativeReadArtifacts(positive, structuredClone(positive), { ...positiveOptions, ...changed }).qualified,
      false,
    );
  const global = structuredClone(positive);
  for (const event of structuredClone(positive)) {
    event.context.owningExtension.id = '10000000-0000-0000-0000-000000000099';
    global.push(event);
  }
  assert.equal(
    compareNativeReadArtifacts(global, [...structuredClone(global)].reverse(), positiveOptions).qualified,
    true,
    'Same artifact names from distinct real registrations are qualified independently.',
  );
  const duplicated = structuredClone(global);
  duplicated.at(-1).context.owningExtension.id = id;
  assert.equal(compareNativeReadArtifacts(global, duplicated, positiveOptions).qualified, false);
});

test('final-query/wire scope requires actual paired source calibration and never promotes missing SDK collection evidence', () => {
  const operation = '10000000-0000-0000-0000-000000000041',
    step = '10000000-0000-0000-0000-000000000042',
    type = '10000000-0000-0000-0000-000000000043',
    early = '10000000-0000-0000-0000-000000000044',
    xml = `<fetch><entity name="widget"><filter><condition attribute="title" operator="ne" value="CO-OP:${operation}"/><condition attribute="title" operator="ne" value="CO-UTC:2026-10-13T00:00:00.000Z"/></filter></entity></fetch>`;
  const artifact = {
    schemaVersion: 2,
    operationId: operation,
    artifact: 'Final20',
    assemblyIdentity: { name: 'Invented.Observer', version: '1.0.0.0', moduleVersionId: type },
    content: { query: { type: 'FetchExpression', xml } },
    context: { schemaVersion: 2, Stage: 20, owningExtension: { id: step }, input: { Query: { xml } }, output: {} },
    captureTime: '2026-10-13T12:00:00.1234567Z',
    spanId: operation,
    parentSpanId: null,
  };
  const encoded = (row) => {
    const pqvd_payloadtext = JSON.stringify(row);
    return {
      pqvd_eventkey: row.artifact,
      pqvd_partnumber: 1,
      pqvd_partcount: 1,
      pqvd_payloadtext,
      pqvd_payloadhash: createHash('sha256').update(pqvd_payloadtext).digest('hex'),
    };
  };
  const snapshot = {
      complete: true,
      contactId: id,
      ...Object.fromEntries(
        ['permissionSnapshotHash', 'membershipSnapshotHash', 'dataSnapshotHash', 'rowVersionSnapshotHash'].map(
          (field) => [field, 'a'.repeat(64)],
        ),
      ),
    },
    site = [
      { powerpagecomponentid: id, name: 'Fixture source', content: '{}', statecode: 0, powerpagecomponenttype: 8 },
    ];
  const post = '10000000-0000-0000-0000-000000000045',
    registration = {
      steps: [
        {
          sdkmessageprocessingstepid: step,
          _eventhandler_value: type,
          stage: 20,
          rank: 9900,
          mode: 0,
          statecode: 0,
          statuscode: 1,
        },
        {
          sdkmessageprocessingstepid: early,
          _eventhandler_value: type,
          stage: 10,
          rank: 10,
          mode: 0,
          statecode: 0,
          statuscode: 1,
        },
        {
          sdkmessageprocessingstepid: post,
          _eventhandler_value: type,
          stage: 40,
          rank: 9900,
          mode: 0,
          statecode: 0,
          statuscode: 1,
        },
      ],
      filters: [],
      messages: [],
      images: [],
    },
    finalRegistration = structuredClone(registration);
  for (const row of finalRegistration.steps.slice(1)) {
    row.statecode = 1;
    row.statuscode = 2;
  }
  const capture = {
      requests: [{ operationId: operation, caseId: 'Q1', variant: 'fetchxml', lane: 'webapi', authoredFetchXml: xml }],
      backendEvents: [encoded(artifact)],
      results: [{ operationId: operation, status: 200, body: '{"value":[]}' }],
    },
    fullCapture = structuredClone(capture);
  fullCapture.backendEvents.push(
    encoded({
      ...artifact,
      artifact: 'Full40',
      context: {
        ...artifact.context,
        Stage: 40,
        owningExtension: { id: post },
        output: { BusinessEntityCollection: { type: 'EntityCollection', entities: [], truncated: false } },
      },
    }),
  );
  const calibration = {
    observerTypeId: type,
    full: { before: snapshot, after: snapshot, siteBefore: site, siteAfter: site, registration, capture: fullCapture },
    final: {
      before: snapshot,
      after: snapshot,
      siteBefore: site,
      siteAfter: site,
      registration: finalRegistration,
      capture: structuredClone(capture),
    },
  };
  const witness = validateFinalQueryObserverWitness(calibration),
    options = {
      wireQualified: true,
      localBackendExecutions: 1,
      localPhases: [{ stage: 10 }, { stage: 20 }, { stage: 40 }],
      finalObserverWitness: witness,
    },
    actual = compareNativeReadArtifacts([artifact], [structuredClone(artifact)], options);
  assert.equal(actual.finalQueryWireExact, true);
  assert.equal(actual.qualified, true);
  assert.equal(actual.collectionObservation, 'not-recorded');
  assert.equal(actual.backendArtifactsExact, false);
  assert.equal(actual.collectionComplete, false);
  assert.equal(actual.rowExact, false);
  assert.ok(Object.isFrozen(witness) && Object.isFrozen(witness.finalStepIds));
  assert.equal(
    compareNativeReadArtifacts([artifact], [artifact], { ...options, finalObserverWitness: { ...witness } }).qualified,
    false,
    'A caller Boolean/profile copy cannot replace actual source calibration.',
  );
  for (const mutate of [
    (c) => (c.final.after = { ...snapshot, dataSnapshotHash: 'b'.repeat(64) }),
    (c) => (c.final.siteAfter = [{ ...site[0], content: 'changed' }]),
    (c) => (c.final.registration.steps[0].rank = 20),
    (c) => (c.final.registration.steps[1].configuration = 'different'),
    (c) => (c.final.capture.results = []),
    (c) => (c.final.capture.results[0].body = '{"value":[{}]}'),
    (c) => (c.final.capture.backendEvents = []),
    (c) => (c.final.capture.requests[0].authoredFetchXml = xml.replace('name="widget"', 'name="other"')),
  ]) {
    const changed = structuredClone(calibration);
    mutate(changed);
    assert.throws(() => validateFinalQueryObserverWitness(changed), /observer|Observer|Final|Full\/final/);
  }
  const missing = compareNativeReadArtifacts([artifact], [], options);
  assert.equal(missing.qualified, false);
  assert.equal(
    compareNativeReadArtifacts([artifact], [artifact], { ...options, localBackendExecutions: 2 }).qualified,
    false,
  );
  assert.equal(
    compareNativeReadArtifacts([artifact], [artifact], { ...options, localPhases: [{ stage: 20 }] }).qualified,
    false,
  );
  assert.equal(
    compareNativeReadArtifacts([artifact], [artifact], { ...options, wireQualified: false }).qualified,
    false,
  );
});
