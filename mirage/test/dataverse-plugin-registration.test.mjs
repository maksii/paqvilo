// @test-kind compatibility: Microsoft Learn plug-in registration tables and documented errors; a few codes come from single native registration probes, not reproduced
// Plug-in registration through the Dataverse API: seeded sdkmessage and sdkmessagefilter rows, the Solution's registrations
// mirrored as rows, the write rules with their documented errors, the cascade and the privileges.
import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { EXTENSIONS } from '../lib/dataverse-extensions.mjs';
import { hashSecret } from '../lib/dataverse-auth.mjs';
import {
  install,
  overlayRegisteredSteps,
  solutionPluginExtension,
  solutionPluginRows,
} from '../lib/dataverse-plugin-registration.mjs';
import { createAsyncPluginRunner } from '../lib/plugin-async.mjs';
import {
  importSolutionPlugins,
  parsePluginDocument,
  pluginCatalogue,
  pluginHandlers,
  pluginPhaseRequiresCheckpoint,
  pluginStepMatchesEntity,
  runPluginPhase,
} from '../lib/exported-plugins.mjs';
import { install as installStandard } from '../lib/dataverse-standard.mjs';
import { createPrincipals, ensureSecurityModel, uuidV5 } from '../lib/dataverse-security.mjs';
import { createRecordHandlers, createRecordHooks } from '../lib/dataverse-records.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import { handleSoap } from '../lib/dataverse-soap.mjs';
import { NS } from '../lib/dataverse-soap-xml.mjs';
import { runAtomic } from '../lib/dataverse-api.mjs';
import { createHash } from 'node:crypto';
import { assemblyBase64, fakePublicKey, certificateInspectionFixture } from './clr-assembly-fixture.mjs';
import { createSelfSignedCertificate } from '../lib/dataverse-tls.mjs';
import { X509Certificate } from 'node:crypto';
import { zipOf } from '../lib/dataverse-solutions.mjs';

const ORIGIN = 'http://127.0.0.1:5555';

const APP_ID = '22222222-2222-2222-2222-222222222222';
const PUBLIC_APP_ID = '44444444-4444-4444-4444-444444444444';
const REDIRECT = 'http://localhost:1/cb';
const SECRET_VAR = 'PAQVILO_PLUGIN_REGISTRATION_SECRET';
const PASSWORD = 'Pass!23';
const BASIC_OID = '66666666-6666-6666-6666-666666666666';
const NO_ROLE_OID = '67676767-6767-4767-8767-676767676767';
const WIDGET = 'aaaaaaaa-0000-0000-0000-000000000011';
const ASSEMBLY = 'a1000000-0000-4000-8000-000000000001';
const TYPE = 'a1000000-0000-4000-8000-000000000002';
const STEP = 'a1000000-0000-4000-8000-000000000003';
const CONTOSO = 'Contoso.Plugins.WidgetCheck';

// The Solution's facts as importSolutionPlugins returns them: one assembly, one type, one Update step with a pre-image.
const PLUGINS = {
  assemblies: [
    {
      id: ASSEMBLY,
      name: 'Contoso.Plugins',
      fullName: 'Contoso.Plugins, Version=1.0.0.0, Culture=neutral, PublicKeyToken=0123456789abcdef',
      version: '1.0.0.0',
      isolationMode: 2,
      sourceType: 0,
    },
  ],
  types: [{ id: TYPE, assemblyId: ASSEMBLY, name: CONTOSO, friendlyName: 'WidgetCheck' }],
  steps: [
    {
      id: STEP,
      name: 'WidgetCheck: Update',
      message: 'Update',
      entity: 'contoso_widget',
      typeId: TYPE,
      typeName: CONTOSO,
      stage: 20,
      mode: 0,
      rank: 1,
      supportedDeployment: 0,
      enabled: true,
      filteringAttributes: ['name'],
      impersonatingUserId: null,
      images: [{ name: 'Before', alias: 'before', type: 0, attributes: ['name'] }],
    },
  ],
  diagnostics: [],
};

function fixtureState() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: 'contoso_widget',
    entitySet: 'contoso_widgets',
    idColumn: 'contoso_widgetid',
    nameColumn: 'contoso_name',
    userConfigured: true,
    fields: { contoso_name: { dataverseType: 'nvarchar' }, contoso_status: { dataverseType: 'int' } },
    relationships: {},
  };
  state.tables.contoso_widget = [{ contoso_widgetid: WIDGET, contoso_name: 'alpha', contoso_status: 1 }];
  return state;
}

// An extension that stands in for the server's solution extension, with the Solution's rows.
const solution = solutionPluginExtension(PLUGINS);

// Assembly content: a signed plug-in assembly, the same unsigned, and one that declares no plug-in.
const PLUGIN_TYPES = {
  typeRefs: ['Microsoft.Xrm.Sdk.IPlugin', 'System.Activities.CodeActivity'],
  typeDefs: [
    { full: CONTOSO, interfaces: ['Microsoft.Xrm.Sdk.IPlugin'] },
    { full: 'Contoso.Plugins.AuditActivity', base: 'System.Activities.CodeActivity' },
  ],
};
const SIGNED = assemblyBase64({
  name: 'Contoso.Signed',
  version: '1.2.3.4',
  culture: 'en-US',
  publicKey: fakePublicKey,
  ...PLUGIN_TYPES,
});
const UNSIGNED = assemblyBase64({ name: 'Contoso.Unsigned', version: '1.0.0.0', ...PLUGIN_TYPES });
const HELPERS = assemblyBase64({
  name: 'Contoso.Helpers',
  version: '1.0.0.0',
  publicKey: fakePublicKey,
  typeDefs: [{ full: 'Contoso.Helpers.Util' }],
});
const tokenOf = (key) => createHash('sha1').update(key).digest().subarray(-8).reverse().toString('hex');
// Seeded registration ids read from the store; a Web API $filter over the ~2,000 seeded filter rows takes over a second.
const messageId = (store, name) => store.tableRows('sdkmessage').find((row) => row.name === name).sdkmessageid;
const filterId = (store, message, table) =>
  store.tableRows('sdkmessagefilter').find((row) => row.sdkmessageid === message && row.primaryobjecttypecode === table)
    .sdkmessagefilterid;

describe('plug-in registration over HTTP', () => {
  let api;
  let store;
  let origin;
  let tenantId;
  let organizationId;
  let appToken;
  let basicToken;
  const ids = {};

  before(async () => {
    process.env[SECRET_VAR] = 'registration-secret';
    store = await new DataStore({ state: fixtureState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP_ID,
          displayName: 'Registration app',
          secretEnvironmentVariable: SECRET_VAR,
          roles: ['System Administrator'],
        },
        { appId: PUBLIC_APP_ID, displayName: 'Public app', publicClient: true, redirectUris: [REDIRECT] },
      ],
      users: [
        { domainname: 'basic@example.test', fullname: 'Basic', objectId: BASIC_OID, roles: ['Basic User'] },
        { domainname: 'none@example.test', fullname: 'No roles', objectId: NO_ROLE_OID, roles: [] },
      ],
    });
    api = await startDataverseApi({ store, settings, log: () => {}, extensions: [...EXTENSIONS, solution] });
    origin = api.origin;
    tenantId = api.tenantId;
    organizationId = api.organizationId;
    const basicId = uuidV5(organizationId, `systemuser:oid:${BASIC_OID}`);
    await store.transact(() => {
      store.state.dataverse.passwords ??= {};
      store.state.dataverse.passwords[basicId] = hashSecret(PASSWORD);
    });
    appToken = await clientToken();
    basicToken = await userToken('basic@example.test');
    for (const name of ['Create', 'Update', 'Delete', 'WhoAmI', 'RetrieveMultiple']) ids[name] = messageId(store, name);
    ids.createFilter = filterId(store, ids.Create, 'contoso_widget');
    ids.updateFilter = filterId(store, ids.Update, 'contoso_widget');
    ids.deleteFilter = filterId(store, ids.Delete, 'contoso_widget');
    ids.retrieveMultipleFilter = filterId(store, ids.RetrieveMultiple, 'contoso_widget');
    ids.organizationFilter = filterId(store, ids.Create, 'organization');
  });

  after(async () => {
    delete process.env[SECRET_VAR];
    await api?.close();
  });

  it('GetPluginCertificateInfo returns typed empty certificate facts for unsigned registrations and validates access', async () => {
    const path = `GetPluginCertificateInfo(ComponentName='pluginassembly',ComponentId=${ASSEMBLY})`;
    const response = await call(path);
    assert.equal(response.status, 200);
    const info = await response.json();
    assert.equal(info.SubjectDN, null);
    assert.equal(info.CertificateHash, null);
    assert.equal(info.IsSelfSigned, null);
    assert.equal((await call(path, { token: basicToken })).status, 200, 'standard registration read access is honored');
    assert.equal((await call(`GetPluginCertificateInfo(ComponentName='account',ComponentId=${ASSEMBLY})`)).status, 400);
    assert.equal(
      (
        await call(
          `GetPluginCertificateInfo(ComponentName='pluginassembly',ComponentId=11111111-1111-4111-8111-111111111111)`,
        )
      ).status,
      404,
    );
  });

  it('GetPluginCertificateInfo exposes the embedded CMS signer certificate without claiming image trust', async () => {
    const cert = new X509Certificate(createSelfSignedCertificate({ commonName: 'Invented plugin signer' }).cert);
    const { image } = certificateInspectionFixture(cert.raw);
    const registration = store.state.tables.pluginassembly.find((row) => row.pluginassemblyid === ASSEMBLY);
    const previous = registration.content;
    registration.content = image.toString('base64');
    try {
      const response = await call(`GetPluginCertificateInfo(ComponentName='pluginassembly',ComponentId=${ASSEMBLY})`);
      assert.equal(response.status, 200);
      const facts = await response.json();
      assert.equal(facts.SubjectDN, cert.subject);
      assert.equal(facts.IsSelfSigned, true);
      assert.equal(facts.CertificateSegment, cert.raw.toString('base64'));
      assert.equal(facts.CertificateHash, cert.fingerprint.replaceAll(':', ''));
    } finally {
      registration.content = previous;
    }
  });

  async function clientToken() {
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: APP_ID,
        client_secret: process.env[SECRET_VAR],
        scope: `${origin}/.default`,
      }),
    });
    return (await response.json()).access_token;
  }

  async function userToken(username) {
    const response = await fetch(`${origin}/${tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: PUBLIC_APP_ID,
        username,
        password: PASSWORD,
        scope: `${origin}/.default`,
      }),
    });
    return (await response.json()).access_token;
  }

  const call = (path, { token = appToken, method = 'GET', body } = {}) =>
    fetch(`${origin}/api/data/v9.2/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const read = async (path) => (await call(path)).json();
  const idFromLocation = (response) => /\(([^)]+)\)/.exec(response.headers.get('OData-EntityId'))[1];
  const errorOf = async (response) => (await response.json()).error;

  // A step body with its lookups: the message, the filter and the plug-in type (eventhandler and plugintypeid).
  const stepBody = (over = {}) => ({
    name: 'Probe step',
    stage: 20,
    mode: 0,
    'sdkmessageid@odata.bind': `/sdkmessages(${ids.Create})`,
    'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${ids.createFilter})`,
    'plugintypeid@odata.bind': `/plugintypes(${TYPE})`,
    'eventhandler_plugintype@odata.bind': `/plugintypes(${TYPE})`,
    ...over,
  });
  const createStep = (body, token) =>
    call('sdkmessageprocessingsteps', { method: 'POST', body: stepBody(body), token });

  it('seeds the well-known sdkmessage rows and a filter per table', async () => {
    const create = await read('sdkmessages(9ebdbb1b-ea3e-db11-86a7-000a3a5473e8)');
    assert.equal(create.name, 'Create');
    assert.equal(create.isprivate, false);
    const filter = await read(`sdkmessagefilters(${ids.createFilter})`);
    assert.equal(filter._sdkmessageid_value, create.sdkmessageid);
    assert.equal(filter.primaryobjecttypecode, 'contoso_widget');
    assert.equal(filter.iscustomprocessingstepallowed, true);
    const organization = await read(`sdkmessagefilters(${ids.organizationFilter})`);
    assert.equal(organization.iscustomprocessingstepallowed, false, 'system tables take no custom step');
  });

  it('mirrors the Solution step, its type, assembly and image as rows', async () => {
    const step = await (await call(`sdkmessageprocessingsteps(${STEP})`)).json();
    assert.equal(step.name, 'WidgetCheck: Update');
    assert.equal(step.stage, 20);
    assert.equal(step.statecode, 0);
    assert.equal(step._sdkmessageid_value, ids.Update);
    assert.equal(step._sdkmessagefilterid_value, ids.updateFilter);
    assert.equal(step._plugintypeid_value, TYPE);
    assert.equal(step.filteringattributes, 'name');
    const type = await (await call(`plugintypes(${TYPE})`)).json();
    assert.equal(type.typename, CONTOSO);
    assert.equal(type._pluginassemblyid_value, ASSEMBLY);
    assert.equal(type.assemblyname, 'Contoso.Plugins');
    const assembly = await (await call(`pluginassemblies(${ASSEMBLY})`)).json();
    assert.equal(assembly.publickeytoken, '0123456789abcdef');
    assert.equal(assembly.major, 1);
    const images = (
      await (await call(`sdkmessageprocessingstepimages?$filter=sdkmessageprocessingstepid eq ${STEP}`)).json()
    ).value;
    assert.equal(images.length, 1);
    assert.equal(images[0].messagepropertyname, 'Target');
    assert.equal(images[0].imagetype, 0);
  });

  it('restores the Solution rows on reseed (reset), after a row was changed', async () => {
    store.state.tables.sdkmessageprocessingstep.find((row) => row.sdkmessageprocessingstepid === STEP).name = 'changed';
    await solution.reset({ store });
    const step = await (await call(`sdkmessageprocessingsteps(${STEP})`)).json();
    assert.equal(step.name, 'WidgetCheck: Update');
  });

  it('refuses writes to sdkmessage and sdkmessagefilter with 0x80040800', async () => {
    const created = await call('sdkmessages', { method: 'POST', body: { name: 'Contoso_Probe' } });
    assert.equal(created.status, 400);
    assert.equal((await errorOf(created)).code, '0x80040800');
    const patched = await call(`sdkmessagefilters(${ids.createFilter})`, {
      method: 'PATCH',
      body: { isvisible: false },
    });
    assert.equal(patched.status, 400);
    assert.equal((await errorOf(patched)).code, '0x80040800');
  });

  it('accepts a valid step (stage 20, filtered) and answers it with 204 and a row id', async () => {
    const response = await createStep({ name: 'Valid step' });
    assert.equal(response.status, 204, JSON.stringify(await response.clone().text()));
    assert.match(idFromLocation(response), /^[0-9a-f-]{36}$/);
  });

  // @test-kind parity: native recorder corpus n6-registration (trial environment, captures native-trial and native-trial-r2): an administrator's step whose impersonatinguserid binds a systemuser that does not exist is accepted with 204
  it('accepts a step impersonating a systemuser that does not exist', async () => {
    const response = await createStep({
      name: 'Impersonating a missing user',
      'impersonatinguserid@odata.bind': '/systemusers(dddddddd-0000-4000-8000-0000000000ff)',
    });
    assert.equal(response.status, 204, await response.clone().text());
  });

  // @test-kind compatibility: Microsoft Learn plug-in registration tables and documented errors
  it('refuses a stage outside the custom-step stages with 0x80044184', async () => {
    const error = await errorOf(await createStep({ stage: 30 }));
    assert.equal(error.code, '0x80044184');
    assert.match(error.message, /^Invalid plug-in registration stage\./);
  });

  it('refuses an asynchronous step outside the PostOperation stage', async () => {
    assert.equal((await errorOf(await createStep({ mode: 1, stage: 20 }))).code, '0x80040203');
    assert.equal((await createStep({ mode: 1, stage: 40 })).status, 204);
  });

  // Native accepts a negative rank (registration probe: Update at stage 20 with rank -1).
  it('accepts any whole rank, a negative one included, and defaults a missing rank to 1', async () => {
    assert.equal((await createStep({ rank: -1 })).status, 204);
    // @parity-evidence: native registration round 2 (_registration-probes-2.json) "rank 1.5": 0x80048d19, the OData payload reader cannot convert 1.5 to Edm.Int32
    assert.equal((await errorOf(await createStep({ rank: 1.5 }))).code, '0x80048d19');
    const response = await createStep({ name: 'Default rank' });
    const step = await (await call(`sdkmessageprocessingsteps(${idFromLocation(response)})`)).json();
    assert.equal(step.rank, 1);
  });

  // @parity-evidence: native registration round 2 (_registration-probes-2.json): "Merge with the probe Update filter" is accepted, "Merge with an unknown filter" answers
  // 404 0x80040217; the earlier refusal of another message's filter had no native basis
  it('accepts a filter of another message, and answers 404 for an unknown filter', async () => {
    assert.equal(
      (await createStep({ 'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${ids.updateFilter})` })).status,
      204,
    );
    const unknown = await createStep({
      'sdkmessagefilterid@odata.bind': '/sdkmessagefilters(a1000000-0000-4000-8000-0000000000e8)',
    });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error.code, '0x80040217');
  });

  it('refuses a filter the table does not allow a custom step on with 0x80044187', async () => {
    const error = await errorOf(
      await createStep({ 'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${ids.organizationFilter})` }),
    );
    assert.equal(error.code, '0x80044187');
  });

  // @test-kind parity: native accepted steps without a filter on every existing message, including messages with no filter
  // row at all (registered global RetrieveExchangeRate, AddMembers, Send steps) and messages whose 'none' filter refuses
  // custom steps (Upsert, Merge, RetrieveEntityChanges)
  // @parity-evidence: native _steps.json global "Recorder: <message>" registrations on 156 platform messages, classified
  // against native sdkmessagefilter rows (audit C02a); the earlier 0x80090307 refusal had no native basis
  it('accepts a step with no filter on any existing message, and answers 404 for a message that does not exist', async () => {
    const accepted = await createStep({
      'sdkmessageid@odata.bind': `/sdkmessages(${messageId(store, 'RetrieveExchangeRate')})`,
      'sdkmessagefilterid@odata.bind': undefined,
    });
    assert.equal(accepted.status, 204, await accepted.clone().text());
    const missing = await createStep({
      'sdkmessageid@odata.bind': '/sdkmessages(a1000000-0000-4000-8000-0000000000e9)',
      'sdkmessagefilterid@odata.bind': undefined,
    });
    assert.equal(missing.status, 404);
  });

  it('refuses filtering attributes that are not columns of the filter table', async () => {
    const error = await errorOf(
      await createStep({
        sdkmessageprocessingstepid: 'a1000000-0000-4000-8000-0000000000f0',
        filteringattributes: 'contoso_name,no_such_column',
      }),
    );
    // Native: a missing dependency (registration probe with an unknown filtering attribute).
    assert.equal(error.code, '0x8004f036');
    assert.equal(
      error.message,
      'The dependent component Attribute (Id=no_such_column) does not exist.  Failure trying to associate it with SdkMessageProcessingStep (Id=a1000000-0000-4000-8000-0000000000f0) as a dependency. Missing dependency lookup type = AttributeNameLookup.',
    );
    assert.equal((await createStep({ filteringattributes: 'contoso_name' })).status, 204);
  });

  it('refuses a secure configuration on a step that is not ServerOnly with 0x80044185', async () => {
    const secure = await call('sdkmessageprocessingstepsecureconfigs', {
      method: 'POST',
      body: { secureconfig: 'probe-value' },
    });
    assert.equal(secure.status, 204);
    const secureId = idFromLocation(secure);
    // An unfiltered Create step: the message's availability (2) admits deployment 2, so the secure-configuration rule
    // answers (a custom table filter is server-only and answers the availability error first).
    const error = await errorOf(
      await createStep({
        supporteddeployment: 2,
        'sdkmessagefilterid@odata.bind': undefined,
        'sdkmessageprocessingstepsecureconfigid@odata.bind': `/sdkmessageprocessingstepsecureconfigs(${secureId})`,
      }),
    );
    assert.equal(error.code, '0x80044185');
  });

  it('refuses a web hook step that carries configuration', async () => {
    const hook = await call('serviceendpoints', {
      method: 'POST',
      body: { name: 'Probe hook', url: 'http://127.0.0.1:9/probe', authtype: 5, contract: 8 },
    });
    assert.equal(hook.status, 204);
    const hookId = idFromLocation(hook);
    const body = {
      configuration: '{"probe":true}',
      'eventhandler_serviceendpoint@odata.bind': `/serviceendpoints(${hookId})`,
    };
    const error = await errorOf(
      await createStep({
        ...body,
        'plugintypeid@odata.bind': undefined,
        'eventhandler_plugintype@odata.bind': undefined,
      }),
    );
    assert.equal(error.code, '0x80040203');
    assert.equal(error.message, 'A web hook step cannot have a configuration.');
    assert.equal(
      (
        await createStep({
          'plugintypeid@odata.bind': undefined,
          'eventhandler_plugintype@odata.bind': undefined,
          'eventhandler_serviceendpoint@odata.bind': `/serviceendpoints(${hookId})`,
        })
      ).status,
      204,
    );
  });

  // @parity-evidence: native registration round 2 (_registration-probes-2.json) "step without event handler": 0x80040200 "plugintypeid is missing."
  it('refuses a step without its handler (the eventhandler is required)', async () => {
    const error = await errorOf(
      await createStep({ 'plugintypeid@odata.bind': undefined, 'eventhandler_plugintype@odata.bind': undefined }),
    );
    assert.equal(error.code, '0x80040200');
    assert.equal(error.message, 'plugintypeid is missing.');
  });

  // Images: each rule with the step it needs. The step on Update is valid for a pre-image; the others need their message.
  async function stepOn(messageId, filterId, stage) {
    const response = await createStep({
      'sdkmessageid@odata.bind': `/sdkmessages(${messageId})`,
      'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${filterId})`,
      stage,
    });
    assert.equal(response.status, 204, `step on ${messageId}`);
    return idFromLocation(response);
  }
  const imageBody = (stepId, over = {}) => ({
    name: 'Image',
    entityalias: 'img',
    imagetype: 0,
    messagepropertyname: 'Target',
    'sdkmessageprocessingstepid@odata.bind': `/sdkmessageprocessingsteps(${stepId})`,
    ...over,
  });
  const postImage = (body) => call('sdkmessageprocessingstepimages', { method: 'POST', body });

  it('accepts a pre-image on Update at stage 20 and refuses a post-image there with 0x8004416e', async () => {
    const updateStep = await stepOn(ids.Update, ids.updateFilter, 20);
    assert.equal((await postImage(imageBody(updateStep))).status, 204);
    assert.equal((await errorOf(await postImage(imageBody(updateStep, { imagetype: 1 })))).code, '0x8004416e');
  });

  it('refuses an image on a message without image support with 0x80044189', async () => {
    const step = await stepOn(ids.RetrieveMultiple, ids.retrieveMultipleFilter, 20);
    const error = await errorOf(await postImage(imageBody(step)));
    assert.equal(error.code, '0x80044189');
    assert.equal(error.message, "Message 'RetrieveMultiple' does not support image registration.");
  });

  it('refuses a message property the message does not carry with 0x8004416b', async () => {
    const step = await stepOn(ids.Update, ids.updateFilter, 20);
    const error = await errorOf(await postImage(imageBody(step, { messagepropertyname: 'EmailId' })));
    assert.equal(error.code, '0x8004416b');
    assert.equal(error.message, "Message property name 'EmailId' is not valid on message Update.");
  });

  it('refuses a pre-image on Create and a post-image on Delete with 0x8004416d', async () => {
    const createStepId = await stepOn(ids.Create, ids.createFilter, 40);
    assert.equal(
      (await errorOf(await postImage(imageBody(createStepId, { imagetype: 0, messagepropertyname: 'Id' })))).code,
      '0x8004416d',
    );
    const deleteStep = await stepOn(ids.Delete, ids.deleteFilter, 40);
    assert.equal((await errorOf(await postImage(imageBody(deleteStep, { imagetype: 1 })))).code, '0x8004416d');
  });

  // Native registration round 2: deleting a plug-in type with a step answers 0x8004f01f and the step survives; Learn
  // register-plug-in: no assembly is unregistered while steps depend on it; images go with their step.
  it('builds the assembly, type and step chain; refuses to delete the assembly or type while a step uses it', async () => {
    const assembly = await call('pluginassemblies', {
      method: 'POST',
      body: { name: 'Contoso.Probe', version: '2.0.0.0', culture: 'neutral', publickeytoken: 'fedcba9876543210' },
    });
    assert.equal(assembly.status, 204);
    const probeAssembly = idFromLocation(assembly);
    const type = await call('plugintypes', {
      method: 'POST',
      body: {
        typename: 'Contoso.Probe.Check',
        name: 'Contoso.Probe.Check',
        'pluginassemblyid@odata.bind': `/pluginassemblies(${probeAssembly})`,
      },
    });
    assert.equal(type.status, 204);
    const probeType = idFromLocation(type);
    const derived = await (await call(`plugintypes(${probeType})`)).json();
    assert.equal(derived.assemblyname, 'Contoso.Probe', 'the type takes the assembly name');
    // A post-image needs stage 40 (a pre-image on Create is refused, 0x8004416d).
    const step = await createStep({
      stage: 40,
      'plugintypeid@odata.bind': `/plugintypes(${probeType})`,
      'eventhandler_plugintype@odata.bind': `/plugintypes(${probeType})`,
    });
    assert.equal(step.status, 204);
    const probeStep = idFromLocation(step);
    const image = await postImage(imageBody(probeStep, { imagetype: 1, messagepropertyname: 'Id' }));
    assert.equal(image.status, 204);
    const probeImage = idFromLocation(image);
    for (const path of [`pluginassemblies(${probeAssembly})`, `plugintypes(${probeType})`]) {
      const refused = await call(path, { method: 'DELETE' });
      assert.equal(refused.status, 400, path);
      const { error } = await refused.json();
      assert.equal(error.code, '0x8004f01f');
      assert.match(error.message, /component cannot be deleted because it is referenced by 1 other components\./);
    }
    assert.equal((await call(`sdkmessageprocessingsteps(${probeStep})`)).status, 200, 'the step remains');
    assert.equal((await call(`sdkmessageprocessingsteps(${probeStep})`, { method: 'DELETE' })).status, 204);
    assert.equal(
      (await call(`sdkmessageprocessingstepimages(${probeImage})`)).status,
      404,
      'the image went with its step',
    );
    assert.equal((await call(`pluginassemblies(${probeAssembly})`, { method: 'DELETE' })).status, 204);
    assert.equal((await call(`plugintypes(${probeType})`)).status, 404, 'the type went with its assembly');
  });

  it('refuses a second assembly with the same fullname, ignoring the build and revision, with 0x8004417B', async () => {
    const error = await errorOf(
      await call('pluginassemblies', {
        method: 'POST',
        body: { name: 'Contoso.Plugins', version: '1.0.0.9', culture: 'neutral', publickeytoken: '0123456789abcdef' },
      }),
    );
    // The Web API envelope writes the hex code in lower case; the module keeps the documented spelling.
    assert.equal(error.code.toLowerCase(), '0x8004417b');
    const other = await call('pluginassemblies', {
      method: 'POST',
      body: { name: 'Contoso.Plugins', version: '2.0.0.0', culture: 'neutral', publickeytoken: '0123456789abcdef' },
    });
    assert.equal(other.status, 204);
  });

  it('takes the identity from supplied content over HTTP, and refuses unsigned content with 0x80081114', async () => {
    const created = await call('pluginassemblies', {
      method: 'POST',
      body: { name: 'ignored', version: '0.0.0.1', content: SIGNED },
    });
    assert.equal(created.status, 204);
    const row = await (await call(`pluginassemblies(${idFromLocation(created)})`)).json();
    assert.deepEqual(
      [row.name, row.version, row.culture, row.publickeytoken],
      ['Contoso.Signed', '1.2.3.4', 'en-US', tokenOf(fakePublicKey)],
    );
    const unsigned = await errorOf(
      await call('pluginassemblies', {
        method: 'POST',
        body: { name: 'Contoso.Unsigned', version: '1.0.0.0', content: UNSIGNED },
      }),
    );
    assert.equal(unsigned.code.toLowerCase(), '0x80081114');
    const helpers = await errorOf(
      await call('pluginassemblies', {
        method: 'POST',
        body: { name: 'Contoso.Helpers', version: '1.0.0.0', content: HELPERS },
      }),
    );
    assert.equal(helpers.code.toLowerCase(), '0x8004418b');
  });

  it('lets the Basic User read the registration tables and refuses writes to them', async () => {
    assert.equal((await call('sdkmessages?$top=1', { token: basicToken })).status, 200);
    const step = await call('sdkmessageprocessingsteps', { method: 'POST', body: stepBody(), token: basicToken });
    assert.equal(step.status, 403);
    assert.equal((await errorOf(step)).code, '0x80040220');
    const assembly = await call('pluginassemblies', {
      method: 'POST',
      body: { name: 'Contoso.Basic', version: '1.0.0.0' },
      token: basicToken,
    });
    assert.equal(assembly.status, 403);
  });

  // @test-kind parity: native trial captures native-trial and native-trial-r2 (dataverse-recorder round 2, n6-registration): a caller without registration privileges (impersonated through MSCRMCallerID) registering a step, with or without impersonatinguserid, is refused 403 0x80040220 naming prvReadSolution
  it('a step registered by a principal without privileges is refused naming prvReadSolution', async () => {
    const caller = uuidV5(organizationId, `systemuser:oid:${NO_ROLE_OID}`);
    for (const body of [stepBody(), stepBody({ 'impersonatinguserid@odata.bind': `/systemusers(${caller})` })]) {
      const refused = await fetch(`${origin}/api/data/v9.2/sdkmessageprocessingsteps`, {
        method: 'POST',
        headers: { authorization: `Bearer ${appToken}`, 'content-type': 'application/json', MSCRMCallerID: caller },
        body: JSON.stringify(body),
      });
      assert.equal(refused.status, 403);
      const { error } = await refused.json();
      assert.equal(error.code, '0x80040220');
      assert.match(
        error.message,
        new RegExp(`^Principal user \\(Id=${caller}, .*\\), is missing prvReadSolution privileg`),
      );
    }
  });
});

describe('plug-in registration: unit rules and mirror shape', () => {
  // A store with the seeded tables and a fake api: the hook is captured from install and called directly.
  async function harness({ roles = [], privileges = [] } = {}) {
    const state = fixtureState();
    state.tables.organization = [{ organizationid: 'bbbbbbbb-0000-4000-8000-000000000001' }];
    state.tables.pluginassembly ??= [];
    const store = await new DataStore({ state }).init();
    const hooks = [];
    const api = {
      store,
      registry: { names: () => ['WhoAmI'] },
      recordHooks: { add: (name, fn) => hooks.push({ name, fn }) },
      principals: {
        roles: () => roles.map((name) => ({ name })),
        privileges: () => new Map(privileges.map((name) => [name, 1])),
      },
    };
    await install(api);
    const hook = hooks.find((entry) => entry.name === 'beforeWrite').fn;
    const user = {
      systemuserid: 'cccccccc-0000-4000-8000-000000000001',
      organizationid: 'bbbbbbbb-0000-4000-8000-000000000001',
    };
    const mapping = (logical) => ({ logicalName: logical });
    // async: the hook throws synchronously, and assert.rejects needs the rejection as a promise.
    const run = async (logical, operation, data, existing = null) =>
      hook({ user, identity: {} }, mapping(logical), { operation, data, existing });
    return { store, run };
  }

  it('the row of a Solution step is a pure function of the plug-in facts', () => {
    const rows = solutionPluginRows(PLUGINS, { organizationId: 'bbbbbbbb-0000-4000-8000-000000000001' });
    assert.deepEqual(
      solutionPluginRows(structuredClone(PLUGINS), { organizationId: 'bbbbbbbb-0000-4000-8000-000000000001' }),
      rows,
    );
    assert.equal(rows.sdkmessageprocessingstep[0].sdkmessageid, '20bebb1b-ea3e-db11-86a7-000a3a5473e8');
    assert.equal(rows.sdkmessageprocessingstep[0].sdkmessagefilterid.length, 36);
    assert.equal(rows.sdkmessageprocessingstepimage[0].messagepropertyname, 'Target');
    assert.equal(rows.plugintype[0].assemblyname, 'Contoso.Plugins');
  });

  it('impersonation needs an administrator role or the impersonation privilege (privilegeDenied)', async () => {
    const step = (run) =>
      run('sdkmessageprocessingstep', 'create', {
        name: 'x',
        stage: 20,
        'sdkmessageid@odata.bind': '/sdkmessages(9ebdbb1b-ea3e-db11-86a7-000a3a5473e8)',
        'plugintypeid@odata.bind': `/plugintypes(${TYPE})`,
        'impersonatinguserid@odata.bind': '/systemusers(dddddddd-0000-4000-8000-000000000001)',
      });
    const denied = await harness();
    await assert.rejects(step(denied.run), (error) => error.details?.innerCode === '0x80040220');
    const customizer = await harness({ roles: ['System Customizer'] });
    await step(customizer.run);
  });

  it('an assembly content over 16 MB is refused with the documented 0x8004418f', async () => {
    const { run } = await harness();
    const content = 'A'.repeat(Math.ceil(((16 * 1024 * 1024 + 1) * 4) / 3));
    await assert.rejects(
      run('pluginassembly', 'create', { name: 'Contoso.Big', version: '1.0.0.0', content }),
      (error) =>
        error.details?.innerCode === '0x8004418f' &&
        error.message ===
          "The assembly content size '16777217 bytes' has exceeded the maximum value allowed for isolated plug-ins '16777216 bytes'.",
    );
  });

  it('a plug-in type with no typename is refused, and an assembly without a version too', async () => {
    const { run } = await harness();
    await assert.rejects(run('plugintype', 'create', { name: 'x' }), {
      message: "The 'typename' attribute is required.",
    });
    await assert.rejects(run('pluginassembly', 'create', { name: 'Contoso.Nov' }), {
      message: "The 'version' attribute is required.",
    });
  });

  it('the local managed-base edit contract refuses managed level-zero steps (0x8004419a)', async () => {
    const { run } = await harness();
    const existing = {
      sdkmessageprocessingstepid: STEP,
      ismanaged: true,
      customizationlevel: 0,
      sdkmessageid: 'x',
      stage: 20,
    };
    await assert.rejects(
      run('sdkmessageprocessingstep', 'update', { name: 'changed' }, existing),
      (error) =>
        error.details?.innerCode === '0x8004419a' &&
        error.message === 'A Microsoft registered SDK message processing step cannot be modified.',
    );
  });
});

// The SOAP Organization service writes through the same record hooks. A SOAP Create that breaks a rule faults with the signed
// decimal of the same inner code (the Plug-in Registration Tool and ServiceClient write through SOAP).
describe('plug-in registration over SOAP', () => {
  const SOAP_ORG = 'bbbbbbbb-0000-4000-8000-000000000002';
  const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
  const SETTINGS = {
    organizationId: SOAP_ORG,
    tenantId: 'tenant-test',
    uniqueName: 'testorg',
    friendlyName: 'Test Org',
    version: '9.2.25041.00000',
    users: [{ objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] }],
  };
  const DECL = Object.entries(NS)
    .map(([p, uri]) => `xmlns:${p}="${uri}"`)
    .join(' ');
  const envelope = (body) => `<s:Envelope ${DECL}><s:Body>${body}</s:Body></s:Envelope>`;
  const valueEl = (type, inner) => `<b:value i:type="${type}">${inner}</b:value>`;
  const pair = (key, valueXml) =>
    `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key>${valueXml}</a:KeyValuePairOfstringanyType>`;
  const str = (value) => valueEl('c:string', value);
  const int = (value) => valueEl('c:int', value);
  const refValue = (logical, id) =>
    valueEl('a:EntityReference', `<a:Id>${id}</a:Id><a:LogicalName>${logical}</a:LogicalName><a:Name i:nil="true"/>`);
  const entityValue = (logical, attributes) =>
    valueEl('a:Entity', `<a:Attributes>${attributes.join('')}</a:Attributes><a:LogicalName>${logical}</a:LogicalName>`);
  const createRequest = (entity) =>
    envelope(
      `<Execute xmlns="${NS.svc}"><request i:type="a:CreateRequest"><a:Parameters>${pair('Target', entity)}</a:Parameters><a:RequestName>Create</a:RequestName></request></Execute>`,
    );
  const faultCode = (xml) => Number(/<(?:a:)?ErrorCode>(-?\d+)<\/(?:a:)?ErrorCode>/.exec(xml)?.[1]);

  it('a SOAP Create with a stage outside the custom stages faults with the signed decimal of 0x80044184', async () => {
    const state = fixtureState();
    state.tables.organization = [{ organizationid: SOAP_ORG }];
    state.tables.plugintype = [{ plugintypeid: TYPE, typename: CONTOSO, name: CONTOSO }]; // the lookup must name a row
    const store = new DataStore({ state });
    const recordHooks = createRecordHooks();
    const registry = createOperationRegistry();
    const principals = createPrincipals(store, SETTINGS);
    const changes = createChangeLog(store);
    // The standard tables first (the API installs them before this extension), then the registration tables.
    await installStandard({ store, registry, recordHooks, principals, change: (fn) => fn() });
    await install({ store, registry, recordHooks, principals });
    await ensureSecurityModel(store, SETTINGS);
    const records = createRecordHandlers({
      store,
      change: (fn) => fn(),
      principals,
      metadataFields: () => undefined,
      changes,
      hooks: recordHooks,
    });
    const api = {
      store,
      change: (fn) => fn(),
      registry,
      principals,
      metadata: null,
      metadataFields: () => undefined,
      records,
      changes,
      settings: SETTINGS,
      clock: () => Date.parse('2026-10-20T10:00:00Z'),
      log: () => {},
    };
    api.runAtomic = (fn) => runAtomic(api, fn);
    const admin = principals.byObjectId(ADMIN_OID);
    const send = (xml) =>
      handleSoap(
        {
          method: 'POST',
          headers: {},
          bodyText: xml,
          user: admin,
          caller: admin,
          identity: { admin: true, id: admin.systemuserid, systemUserId: admin.systemuserid },
          origin: ORIGIN,
          version: 'v9.2',
          requestId: 'soap-test',
        },
        api,
      );
    const message = store.tableRows('sdkmessage').find((row) => row.name === 'Create');
    const filter = store
      .tableRows('sdkmessagefilter')
      .find((row) => row.sdkmessageid === message.sdkmessageid && row.primaryobjecttypecode === 'contoso_widget');
    const xml = createRequest(
      entityValue('sdkmessageprocessingstep', [
        pair('name', str('Soap probe')),
        pair('stage', int(30)),
        pair('mode', int(0)),
        pair('sdkmessageid', refValue('sdkmessage', message.sdkmessageid)),
        pair('sdkmessagefilterid', refValue('sdkmessagefilter', filter.sdkmessagefilterid)),
        pair('plugintypeid', refValue('plugintype', TYPE)),
      ]),
    );
    const res = await send(xml);
    assert.equal(faultCode(res.body), Number(BigInt('0x80044184') - 2n ** 32n));
  });
});

// With the Dataverse API on and zero registration writes, the pipeline's step list is the Solution's own list.
// @test-kind contract: Paqvilo design: with no API writes the pipeline step list equals the Solution step list
describe('plug-in registration: zero API writes keep the Solution step list', () => {
  const RESOLVED = importSolutionPlugins([
    { documents: [{ file: 'Contoso.Plugins.xml', facts: { plugins: PLUGINS } }] },
  ]);
  const HANDLERS = pluginHandlers([{ id: 'invented-zero-writes', pluginSteps: { [STEP]: () => {} } }]);
  let api;
  let store;

  before(async () => {
    store = await new DataStore({ state: fixtureState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [{ appId: APP_ID, displayName: 'Zero app', publicClient: true, redirectUris: [REDIRECT] }],
    });
    api = await startDataverseApi({
      store,
      settings,
      log: () => {},
      extensions: [...EXTENSIONS, solutionPluginExtension(RESOLVED)],
    });
  });

  after(async () => {
    await api?.close();
  });

  it('the overlay with seeded rows and no API writes deep-equals the Solution step list, and no row was added', () => {
    const solutionList = pluginCatalogue({ plugins: RESOLVED, handlers: HANDLERS });
    const overlayList = pluginCatalogue({ plugins: overlayRegisteredSteps(RESOLVED, store), handlers: HANDLERS });
    assert.equal(solutionList.length, 1);
    assert.deepStrictEqual(overlayList, solutionList);
    assert.equal(
      store.tableRows('sdkmessageprocessingstep').length,
      1,
      'the Solution step is the only registration row',
    );
    assert.deepStrictEqual(overlayRegisteredSteps(RESOLVED, store).steps, RESOLVED.steps);
  });
});

// API-registered steps run through the pipeline the server installs (store.setPluginPipeline). Trusted pack handlers are
// keyed by plug-in type name, and their context is the IPluginExecutionContext-like one.
describe('plug-in registration: pipeline', () => {
  const PIPE_SECRET = 'PAQVILO_PLUGIN_PIPELINE_SECRET';
  const PIPE_APP = '77777777-7777-7777-7777-777777777777';
  const AUDIT = 'Contoso.Plugins.WidgetAudit';
  const UNHANDLED = 'Contoso.Plugins.Unhandled';
  const BASIC_USER = '66666666-6666-6666-6666-666666666666';
  const trace = [];
  const diagnostics = [];
  const created = [];
  const behaviour = { error: null };
  const ids = {};
  let api;
  let store;
  let origin;
  let token;
  let basicId;
  let auditType;
  let unhandledType;
  let asyncRunner;

  const call = (path, { method = 'GET', body, prefer } = {}) =>
    fetch(`${origin}/api/data/v9.2/${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(prefer ? { prefer } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const first = async (set, filter) =>
    (await (await call(`${set}?$filter=${encodeURIComponent(filter)}`)).json()).value[0];
  const idFromLocation = (response) => /\(([^)]+)\)/.exec(response.headers.get('OData-EntityId'))[1];
  const binds = (message) => ({
    'sdkmessageid@odata.bind': `/sdkmessages(${ids[message]})`,
    'sdkmessagefilterid@odata.bind': `/sdkmessagefilters(${ids[`${message}Filter`]})`,
  });
  async function createType(typename, assemblyName) {
    const assembly = idFromLocation(
      await call('pluginassemblies', { method: 'POST', body: { name: assemblyName, version: '1.0.0.0' } }),
    );
    return idFromLocation(
      await call('plugintypes', {
        method: 'POST',
        body: { typename, name: typename, 'pluginassemblyid@odata.bind': `/pluginassemblies(${assembly})` },
      }),
    );
  }
  // A step on Create unless a message is given; the type is the eventhandler and the plugintypeid.
  async function registerStep(over = {}, type = auditType) {
    const response = await call('sdkmessageprocessingsteps', {
      method: 'POST',
      body: {
        name: 'Audit step',
        stage: 20,
        mode: 0,
        rank: 1,
        ...binds('Create'),
        'plugintypeid@odata.bind': `/plugintypes(${type})`,
        'eventhandler_plugintype@odata.bind': `/plugintypes(${type})`,
        ...over,
      },
    });
    assert.equal(response.status, 204, await response.clone().text());
    const id = idFromLocation(response);
    created.push(id);
    return id;
  }
  const createWidget = (name, prefer) =>
    call('contoso_widgets', { method: 'POST', body: { contoso_name: name, contoso_status: 1 }, prefer });
  const patchWidget = (id, body) => call(`contoso_widgets(${id})`, { method: 'PATCH', body });

  before(async () => {
    process.env[PIPE_SECRET] = 'pipeline-secret';
    store = await new DataStore({ state: fixtureState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: PIPE_APP,
          displayName: 'Pipeline app',
          secretEnvironmentVariable: PIPE_SECRET,
          roles: ['System Administrator'],
        },
      ],
      users: [
        {
          domainname: 'pipeline-basic@example.test',
          fullname: 'Pipeline basic',
          objectId: BASIC_USER,
          roles: ['Basic User'],
        },
      ],
    });
    api = await startDataverseApi({ store, settings, log: () => {}, extensions: [...EXTENSIONS] });
    origin = api.origin;
    basicId = uuidV5(api.organizationId, `systemuser:oid:${BASIC_USER}`);
    token = (
      await (
        await fetch(`${origin}/${api.tenantId}/oauth2/v2.0/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: PIPE_APP,
            client_secret: process.env[PIPE_SECRET],
            scope: `${origin}/.default`,
          }),
        })
      ).json()
    ).access_token;
    // Native: Associate and Disassociate have only the 'none' filter.
    for (const name of ['Create', 'Update', 'Associate', 'Disassociate']) {
      ids[name] = messageId(store, name);
      ids[`${name}Filter`] = filterId(store, ids[name], name.endsWith('ssociate') ? 'none' : 'contoso_widget');
    }
    auditType = await createType(AUDIT, 'Contoso.Plugins.Audit');
    unhandledType = await createType(UNHANDLED, 'Contoso.Plugins.Other');
    // The server's wiring: pack handlers by type name, the step list from the rows, and the committed-write queue for mode 1.
    const handlers = pluginHandlers([
      {
        id: 'invented-pipeline',
        pluginTypes: {
          [AUDIT]: (args) => {
            trace.push({ name: args.step.name, stage: args.stage, operation: args.operation, context: args.context });
            if (behaviour.error) throw behaviour.error;
          },
        },
      },
    ]);
    const diagnostic = (entry) => diagnostics.push(entry);
    const pluginSteps = () => pluginCatalogue({ plugins: overlayRegisteredSteps({ steps: [] }, store), handlers });
    store.setPluginPipeline(
      (context) => runPluginPhase({ ...context, store, items: pluginSteps(), handlers, diagnostic }),
      ({ entity, operation }) =>
        pluginSteps().some(
          (step) =>
            step.enabled && pluginStepMatchesEntity(step, entity) && String(step.message).toLowerCase() === operation,
        ),
      (context) => pluginPhaseRequiresCheckpoint(pluginSteps(), context),
    );
    asyncRunner = createAsyncPluginRunner({ store, items: pluginSteps, handlers, diagnostic });
  });

  after(async () => {
    await asyncRunner?.close();
    await api?.close();
    delete process.env[PIPE_SECRET];
  });

  afterEach(async () => {
    for (const id of created.splice(0)) await call(`sdkmessageprocessingsteps(${id})`, { method: 'DELETE' });
    trace.length = 0;
    diagnostics.length = 0;
    behaviour.error = null;
  });

  it('runs the registered steps by stage, then rank, around a Web API create, with the typed context', async () => {
    await registerStep({ name: 'Post', stage: 40, rank: 1 });
    await registerStep({ name: 'Pre rank 2', stage: 20, rank: 2 });
    await registerStep({ name: 'Pre rank 1', stage: 20, rank: 1 });
    await registerStep({ name: 'Validation', stage: 10, rank: 1 });
    const response = await createWidget('beta');
    assert.equal(response.status, 204);
    assert.deepEqual(
      trace.map((entry) => entry.name),
      ['Validation', 'Pre rank 1', 'Pre rank 2', 'Post'],
    );
    const [validation, , , post] = trace;
    assert.equal(validation.context.MessageName, 'Create');
    assert.equal(validation.context.PrimaryEntityName, 'contoso_widget');
    assert.equal(validation.context.Depth, 1);
    assert.equal(validation.context.InputParameters.Target.contoso_name, 'beta');
    assert.equal(post.context.OutputParameters.id, idFromLocation(response));
  });

  it('delivers the registered pre- and post-images, and UserId is the impersonated user', async () => {
    const step = await registerStep({
      name: 'Update with images',
      stage: 40,
      ...binds('Update'),
      'impersonatinguserid@odata.bind': `/systemusers(${basicId})`,
    });
    const image = (body) =>
      call('sdkmessageprocessingstepimages', {
        method: 'POST',
        body: {
          messagepropertyname: 'Target',
          attributes: 'contoso_name',
          'sdkmessageprocessingstepid@odata.bind': `/sdkmessageprocessingsteps(${step})`,
          ...body,
        },
      });
    assert.equal((await image({ name: 'Before', entityalias: 'before', imagetype: 0 })).status, 204);
    assert.equal((await image({ name: 'After', entityalias: 'after', imagetype: 1 })).status, 204);
    const widget = idFromLocation(await createWidget('alpha'));
    trace.length = 0;
    assert.equal((await patchWidget(widget, { contoso_name: 'gamma' })).status, 204);
    assert.equal(trace.length, 1);
    const [{ context }] = trace;
    assert.equal(context.MessageName, 'Update');
    assert.equal(context.PreEntityImages.before.contoso_name, 'alpha');
    assert.equal(context.PostEntityImages.after.contoso_name, 'gamma');
    assert.equal(context.UserId, basicId);
  });

  it('filtering attributes decide whether an update runs the step', async () => {
    await registerStep({ name: 'Name only', stage: 20, ...binds('Update'), filteringattributes: 'contoso_name' });
    const widget = idFromLocation(await createWidget('delta'));
    trace.length = 0;
    assert.equal((await patchWidget(widget, { contoso_status: 2 })).status, 204);
    assert.equal(trace.length, 0, 'a column outside the filter does not run the step');
    assert.equal((await patchWidget(widget, { contoso_name: 'epsilon' })).status, 204);
    assert.equal(trace.length, 1);
  });

  it('a throwing handler rolls the create back and surfaces 0x80040265 with the SubErrorCode', async () => {
    await registerStep({ name: 'Rejecting', stage: 20 });
    behaviour.error = new Error('Invented rejection');
    const response = await createWidget('rolled', 'odata.include-annotations="*"');
    assert.equal(response.status, 400);
    const error = (await response.json()).error;
    assert.equal(error.code, '0x80040265');
    assert.equal(error.message, 'Invented rejection');
    assert.equal(error['@Microsoft.PowerApps.CDS.ErrorDetails.SubErrorCode'], '-2146233088');
    assert.equal(await first('contoso_widgets', "contoso_name eq 'rolled'"), undefined, 'the create rolled back');
  });

  it('a step without a trusted handler is stored, skipped and reported as a placeholder', async () => {
    const step = await registerStep({
      name: 'Unhandled',
      stage: 20,
      'plugintypeid@odata.bind': `/plugintypes(${unhandledType})`,
      'eventhandler_plugintype@odata.bind': `/plugintypes(${unhandledType})`,
    });
    assert.equal((await createWidget('zeta')).status, 204);
    assert.equal(trace.length, 0);
    assert.ok(
      diagnostics.some(
        (entry) =>
          entry.code === 'PLUGIN_STEP_PLACEHOLDER' && String(entry.stepId).toLowerCase() === step.toLowerCase(),
      ),
    );
  });

  it('a disabled step stops running, and a re-enabled one runs again', async () => {
    const step = await registerStep({ name: 'Toggled', stage: 20 });
    assert.equal(
      (await call(`sdkmessageprocessingsteps(${step})`, { method: 'PATCH', body: { statecode: 1, statuscode: 2 } }))
        .status,
      204,
    );
    assert.equal((await createWidget('eta')).status, 204);
    assert.equal(trace.length, 0);
    assert.equal(
      (await call(`sdkmessageprocessingsteps(${step})`, { method: 'PATCH', body: { statecode: 0, statuscode: 1 } }))
        .status,
      204,
    );
    assert.equal((await createWidget('theta')).status, 204);
    assert.equal(trace.length, 1);
  });

  it('accepts a step on Associate and Disassociate, whose none filters are seeded (no 0x80090307)', async () => {
    const associate = await registerStep({ name: 'Associate probe', stage: 20, ...binds('Associate') });
    const disassociate = await registerStep({ name: 'Disassociate probe', stage: 20, ...binds('Disassociate') });
    assert.match(associate, /^[0-9a-f-]{36}$/);
    assert.match(disassociate, /^[0-9a-f-]{36}$/);
  });

  it('a deleted step is removed from the pipeline', async () => {
    const step = await registerStep({ name: 'Deleted', stage: 20 });
    assert.equal((await call(`sdkmessageprocessingsteps(${step})`, { method: 'DELETE' })).status, 204);
    assert.equal((await createWidget('iota')).status, 204);
    assert.equal(trace.length, 0);
  });

  it('a mode 1 stage 40 step runs after commit through the committed-write queue', async () => {
    await registerStep({ name: 'Async audit', stage: 40, mode: 1 });
    assert.equal((await createWidget('kappa')).status, 204);
    await asyncRunner.drain();
    assert.deepEqual(
      trace.map((entry) => entry.name),
      ['Async audit'],
    );
    assert.equal(trace[0].context.Stage, 40);
    assert.equal(trace[0].context.Mode, 1);
  });
});

// Pack validation and the one-handler-per-type lookup, without HTTP.
// @test-kind contract: Paqvilo pack API: one handler per plug-in type name; ambiguous or invalid handlers rejected
describe('plug-in type handlers: contract', () => {
  const TYPE_ID = 'a1000000-0000-4000-8000-000000000002';
  const ASSEMBLY_ID = 'a1000000-0000-4000-8000-000000000001';
  const CREATE_MESSAGE = '9ebdbb1b-ea3e-db11-86a7-000a3a5473e8';
  const step = (id, entity) => ({
    id,
    name: `Invented ${entity}`,
    typeId: TYPE_ID,
    typeName: CONTOSO,
    messageId: CREATE_MESSAGE,
    message: 'Create',
    entity,
    messageFilterId: null,
    unfiltered: false,
    stage: 20,
    rank: 1,
    mode: 0,
    supportedDeployment: 0,
    enabled: true,
    filteringAttributes: [],
    impersonatingUserId: null,
    images: [],
    assemblyId: ASSEMBLY_ID,
    assemblyName: 'Contoso.Plugins',
    typeSourceFile: null,
    sourceFile: null,
  });

  it('one type handler serves the steps of two tables, and each sees its own table in the context', () => {
    const calls = [];
    const handlers = pluginHandlers([
      {
        id: 'invented-unit',
        pluginTypes: {
          [CONTOSO]: (args) => {
            calls.push([args.context.PrimaryEntityName, args.context.Depth, args.context.MessageName]);
          },
        },
      },
    ]);
    const items = pluginCatalogue({
      plugins: {
        steps: [
          step('b1000000-0000-4000-8000-000000000001', 'contoso_widget'),
          step('b1000000-0000-4000-8000-000000000002', 'contoso_gadget'),
        ],
      },
      handlers,
    });
    assert.ok(items.every((item) => item.mode === 'handler'));
    for (const entity of ['contoso_widget', 'contoso_gadget'])
      runPluginPhase({
        items,
        handlers,
        entity,
        operation: 'create',
        stage: 20,
        target: { contoso_name: 'x' },
        record: { contoso_name: 'x' },
        previous: null,
        identity: {},
        changedAttributes: [],
      });
    assert.deepEqual(calls, [
      ['contoso_widget', 1, 'Create'],
      ['contoso_gadget', 1, 'Create'],
    ]);
  });

  it('a type name handled by two packs is ambiguous, and the name and handler must be valid', () => {
    assert.throws(
      () =>
        pluginHandlers([
          { id: 'one', pluginTypes: { [CONTOSO]: () => {} } },
          { id: 'two', pluginTypes: { [CONTOSO]: () => {} } },
        ]),
      /Ambiguous pluginTypes registration for Contoso\.Plugins\.WidgetCheck in packs one and two/,
    );
    assert.throws(
      () => pluginHandlers([{ id: 'bad', pluginTypes: { 'not-a-type': () => {} } }]),
      /pluginTypes must map plug-in type names to synchronous functions/,
    );
    assert.throws(
      () => pluginHandlers([{ id: 'bad', pluginTypes: { [CONTOSO]: async () => {} } }]),
      /pluginTypes must map plug-in type names to synchronous functions/,
    );
  });

  it('a pack without pluginTypes changes nothing: its step-id handler keeps the step-id lookup only', () => {
    const handlers = pluginHandlers([{ id: 'steps-only', pluginSteps: { [STEP]: () => {} } }]);
    assert.equal(handlers.has(CONTOSO), false);
    const [item] = pluginCatalogue({
      plugins: { steps: [{ ...step(STEP, 'contoso_widget'), typeName: 'Contoso.Other' }] },
      handlers,
    });
    assert.equal(item.mode, 'handler');
  });
});

describe('plug-in registration: assembly content and plug-in types', () => {
  const ASSEMBLY = 'a1000000-0000-4000-8000-0000000000a1';
  const PACKAGE = 'a1000000-0000-4000-8000-0000000000b1';
  // The rules run as the record hook: a store with the seeded tables, and the hook called directly with the merged payload.
  async function registry({ virtual = false } = {}) {
    const state = fixtureState();
    state.tables.organization = [{ organizationid: 'bbbbbbbb-0000-4000-8000-000000000001' }];
    state.tables.pluginassembly ??= [];
    if (virtual)
      state.mappings.contoso_virtual = {
        logicalName: 'contoso_virtual',
        entitySet: 'contoso_virtuals',
        idColumn: 'contoso_virtualid',
        fields: {},
        isVirtual: true,
      };
    const store = await new DataStore({ state }).init();
    const hooks = [];
    const api = {
      store,
      registry: { names: () => ['WhoAmI', 'OnExternalCreated', 'OnExternalUpdated', 'OnExternalDeleted'] },
      recordHooks: { add: (name, fn) => hooks.push({ name, fn }) },
      principals: { roles: () => [], privileges: () => new Map() },
    };
    await install(api);
    const hook = hooks.find((entry) => entry.name === 'beforeWrite').fn;
    const user = {
      systemuserid: 'cccccccc-0000-4000-8000-000000000001',
      organizationid: 'bbbbbbbb-0000-4000-8000-000000000001',
    };
    // async: the hook throws synchronously, and assert.rejects needs the rejection as a promise.
    return {
      store,
      run: async (logical, operation, data, existing = null) =>
        hook({ user, identity: {} }, { logicalName: logical }, { operation, data, existing }),
    };
  }

  it('external notifications have filters only for virtual tables and permit only async PostOperation steps', async () => {
    const { store, run } = await registry({ virtual: true });
    for (const name of ['OnExternalCreated', 'OnExternalUpdated', 'OnExternalDeleted']) {
      const message = store.state.tables.sdkmessage.find((row) => row.name === name);
      const filters = store.state.tables.sdkmessagefilter.filter((row) => row.sdkmessageid === message.sdkmessageid);
      assert.deepEqual(
        filters.map((row) => row.primaryobjecttypecode),
        ['contoso_virtual'],
      );
      const data = {
        name: 'Invented external step',
        sdkmessageid: message.sdkmessageid,
        sdkmessagefilterid: filters[0].sdkmessagefilterid,
        eventhandler: TYPE,
        stage: 40,
        mode: 0,
        rank: 1,
      };
      await assert.rejects(
        run('sdkmessageprocessingstep', 'create', data),
        (error) => error.details?.innerCode === '0x80090303',
      );
      await assert.rejects(
        run('sdkmessageprocessingstep', 'create', { ...data, stage: 20, mode: 1 }),
        (error) => error.details?.innerCode === '0x80090303',
      );
      await run('sdkmessageprocessingstep', 'create', { ...data, mode: 1 });
    }
  });

  it('supplied content sets the name, version, culture, token and major and minor, so a content-only create works', async () => {
    const { run } = await registry();
    const data = { name: 'Ignored', version: '9.9.9.9', content: SIGNED };
    await run('pluginassembly', 'create', data);
    assert.deepEqual(
      [data.name, data.version, data.culture, data.major, data.minor],
      ['Contoso.Signed', '1.2.3.4', 'en-US', 1, 2],
    );
    assert.equal(data.publickeytoken, tokenOf(fakePublicKey));
    const bare = { content: SIGNED };
    await run('pluginassembly', 'create', bare);
    assert.equal(bare.name, 'Contoso.Signed');
  });

  it('content that declares no plug-in or workflow activity, or is not an assembly, is refused with 0x8004418b', async () => {
    const { run } = await registry();
    const data = (content) => ({ name: 'x', version: '1.0.0.0', content });
    await assert.rejects(
      run('pluginassembly', 'create', data(HELPERS)),
      (error) => error.details?.innerCode === '0x8004418b',
    );
    await assert.rejects(
      run('pluginassembly', 'create', data(Buffer.from('not an assembly').toString('base64'))),
      (error) => error.details?.innerCode === '0x8004418b',
    );
  });

  it('unsigned content is refused with 0x80081114 unless a package owns the assembly', async () => {
    const { run } = await registry();
    await assert.rejects(
      run('pluginassembly', 'create', { name: 'x', version: '1.0.0.0', content: UNSIGNED }),
      (error) =>
        error.details?.innerCode === '0x80081114' && error.message === 'Plug-in assembly is not strong name signed.',
    );
    await run('pluginassembly', 'create', {
      name: 'x',
      version: '1.0.0.0',
      content: UNSIGNED,
      'packageid@odata.bind': `/pluginpackages(${PACKAGE})`,
    });
  });

  // @parity-evidence: native registration round 2 (_registration-probes-2.json) "plugintype that does not implement IPlugin": 0x8004418b "PluginType [..] not found in
  // PluginAssembly [..] which has a total of [n] plugin/workflow activity types."
  it('a plug-in type must be one of the assembly plug-in types (0x8004418b), and an activity type is flagged isworkflowactivity', async () => {
    const { store, run } = await registry();
    store.insertRow('pluginassembly', store.state.tables.pluginassembly, {
      pluginassemblyid: ASSEMBLY,
      name: 'Contoso.Signed',
      version: '1.2.3.4',
      culture: 'en-US',
      publickeytoken: tokenOf(fakePublicKey),
      content: SIGNED,
    });
    const bind = { 'pluginassemblyid@odata.bind': `/pluginassemblies(${ASSEMBLY})` };
    await assert.rejects(
      run('plugintype', 'create', { typename: 'Contoso.Plugins.Missing', name: 'Contoso.Plugins.Missing', ...bind }),
      (error) =>
        error.details?.innerCode === '0x8004418b' &&
        error.message ===
          `PluginType [Contoso.Plugins.Missing] not found in PluginAssembly [Contoso.Signed, Version=1.2.3.4, Culture=en-US, PublicKeyToken=${tokenOf(fakePublicKey)}] which has a total of [2] plugin/workflow activity types.`,
    );
    const check = { typename: CONTOSO, name: CONTOSO, ...bind };
    await run('plugintype', 'create', check);
    assert.equal(check.isworkflowactivity, false);
    const activity = { typename: 'Contoso.Plugins.AuditActivity', name: 'Contoso.Plugins.AuditActivity', ...bind };
    await run('plugintype', 'create', activity);
    assert.equal(activity.isworkflowactivity, true);
  });

  it('a Solution assembly without content is not inspected, so every type of it passes as before', async () => {
    const { store, run } = await registry();
    store.insertRow('pluginassembly', store.state.tables.pluginassembly, {
      pluginassemblyid: ASSEMBLY,
      name: 'Contoso.Plugins',
      version: '1.0.0.0',
      culture: 'neutral',
      publickeytoken: '0123456789abcdef',
    });
    await run('plugintype', 'create', {
      typename: 'Contoso.Anything',
      name: 'Contoso.Anything',
      'pluginassemblyid@odata.bind': `/pluginassemblies(${ASSEMBLY})`,
    });
  });

  it('documented type and assembly rules: unique typename per assembly, IPlugin implementation, sandbox and database source', async () => {
    const { store, run } = await registry();
    const content = assemblyBase64({
      name: 'Contoso.Mixed',
      version: '1.0.0.0',
      publicKey: fakePublicKey,
      typeRefs: ['Microsoft.Xrm.Sdk.IPlugin'],
      typeDefs: [{ full: CONTOSO, interfaces: ['Microsoft.Xrm.Sdk.IPlugin'] }, { full: 'Contoso.Plugins.Model' }],
    });
    store.insertRow('pluginassembly', store.state.tables.pluginassembly, {
      pluginassemblyid: ASSEMBLY,
      name: 'Contoso.Mixed',
      version: '1.0.0.0',
      content,
    });
    const bind = { 'pluginassemblyid@odata.bind': `/pluginassemblies(${ASSEMBLY})` };
    await assert.rejects(
      run('plugintype', 'create', { typename: 'Contoso.Plugins.Model', ...bind }),
      (error) =>
        error.details?.innerCode === '0x8004418b' &&
        error.message.startsWith('PluginType [Contoso.Plugins.Model] not found in PluginAssembly [Contoso.Mixed,'),
    );
    await run('plugintype', 'create', { typename: CONTOSO, ...bind });
    store.insertRow('plugintype', (store.state.tables.plugintype ??= []), {
      plugintypeid: TYPE,
      typename: CONTOSO,
      pluginassemblyid: ASSEMBLY,
    });
    await assert.rejects(
      run('plugintype', 'create', { typename: CONTOSO, ...bind }),
      (error) => error.details?.innerCode === '0x8004417C',
    );
    const assembly = { name: 'Contoso.Other', version: '1.0.0.0' };
    // @parity-evidence: native N3 package trial (native-trial/n3-package.json): PATCH isolationmode of an assembly answers 403 0x80040256 "Action failed for assembly
    // '<full name>': No publisher is found, assembly must be registered in isolation."
    await assert.rejects(
      run('pluginassembly', 'create', { ...assembly, isolationmode: 1 }),
      (error) =>
        error.status === 403 &&
        error.details?.innerCode === '0x80040256' &&
        error.message ===
          "Action failed for assembly 'Contoso.Other, Version=1.0.0.0, Culture=neutral, PublicKeyToken=null': No publisher is found, assembly must be registered in isolation.",
    );
    await assert.rejects(
      run('pluginassembly', 'create', { ...assembly, sourcetype: 1 }),
      (error) => error.details?.innerCode === '0x8004417D',
    );
    await run('pluginassembly', 'create', { ...assembly, isolationmode: 2, sourcetype: 0 });
  });

  // Native N3 package trial: the package's IPlugin assemblies are registered and associated with it (source type 4, token
  // 'null' when unsigned); name and version PATCHes are accepted (Microsoft Learn says otherwise); a package-owned assembly
  // is not deleted on its own (0x80081117); a second package with the same assembly is a duplicate key (0x80040265); a
  // package with steps cannot be deleted (0x8004f01f), otherwise its assemblies and types go with it. Learn: an update cannot
  // drop a type that steps use (the code is a guess).
  it('a plug-in package registers its plug-in assemblies and types and follows the package rules', async () => {
    const { store, run } = await registry();
    const nuspec = (version) =>
      Buffer.from(
        `<?xml version="1.0"?><package><metadata><id>Contoso.Package</id><version>${version}</version></metadata></package>`,
      );
    const nupkg = (dlls, version = '1.0.0') =>
      zipOf([
        { name: 'Contoso.Package.nuspec', data: nuspec(version) },
        ...dlls.map(([file, base64]) => ({ name: `lib/net462/${file}`, data: Buffer.from(base64, 'base64') })),
      ]).toString('base64');
    const pkg = {
      content: nupkg([
        ['Contoso.Unsigned.dll', UNSIGNED],
        ['Contoso.Helpers.dll', HELPERS],
      ]),
    };
    await run('pluginpackage', 'create', pkg);
    assert.deepEqual([pkg.name, pkg.version], ['Contoso.Package', '1.0.0']);
    const owned = store.tableRows('pluginassembly').filter((row) => row.packageid === pkg.pluginpackageid);
    assert.deepEqual(
      owned.map((row) => row.name),
      ['Contoso.Unsigned'],
      'only the assembly with an IPlugin type is registered',
    );
    assert.deepEqual([owned[0].sourcetype, owned[0].isolationmode, owned[0].publickeytoken], [4, 2, 'null']);
    const typesOf = () =>
      store.tableRows('plugintype').filter((row) => row.pluginassemblyid === owned[0].pluginassemblyid);
    assert.deepEqual(
      typesOf().map((row) => row.typename),
      [CONTOSO],
      'workflow activities are not package types',
    );
    await assert.rejects(
      run('pluginassembly', 'delete', {}, owned[0]),
      (error) => error.details?.innerCode === '0x80081117',
    );
    const existing = { pluginpackageid: pkg.pluginpackageid, name: pkg.name, version: pkg.version };
    // @parity-evidence: native N3 package trial (native-trial/n3-package.json): PATCH version 204 (1.0.1) and PATCH name 204; the earlier refusal followed Learn only
    await run('pluginpackage', 'update', { version: '2.0.0', name: 'Contoso.Package.Renamed' }, existing);
    await assert.rejects(
      run('pluginpackage', 'create', { name: 'Contoso.Second', version: '1.0.0', content: pkg.content }),
      (error) =>
        error.details?.innerCode === '0x80040265' &&
        error.message.includes("Violation of UNIQUE KEY constraint 'UQ_PluginAssemblyBase_AssemblyMetadata'"),
    );
    await assert.rejects(
      run('pluginpackage', 'create', {
        name: 'x',
        version: '1.0.0',
        content: nupkg([['Contoso.Helpers.dll', HELPERS]]),
      }),
      (error) => error.details?.innerCode === '0x8004418b',
    );
    const typeId = typesOf()[0].plugintypeid;
    store.insertRow('sdkmessageprocessingstep', (store.state.tables.sdkmessageprocessingstep ??= []), {
      sdkmessageprocessingstepid: 'a1000000-0000-4000-8000-0000000000c1',
      plugintypeid: typeId,
      eventhandler: typeId,
    });
    const other = assemblyBase64({
      name: 'Contoso.Unsigned',
      version: '1.0.0.0',
      typeRefs: ['Microsoft.Xrm.Sdk.IPlugin'],
      typeDefs: [{ full: 'Contoso.Plugins.Other', interfaces: ['Microsoft.Xrm.Sdk.IPlugin'] }],
    });
    await assert.rejects(
      run('pluginpackage', 'update', { content: nupkg([['Contoso.Unsigned.dll', other]]) }, existing),
      (error) => error.details?.innerCode === '0x8004418b',
    );
    await assert.rejects(
      run('pluginpackage', 'delete', {}, existing),
      (error) => error.details?.innerCode === '0x8004f01f',
    );
    store.removeRow('sdkmessageprocessingstep', store.state.tables.sdkmessageprocessingstep, 0);
    await run('pluginpackage', 'update', { content: nupkg([['Contoso.Unsigned.dll', other]]) }, existing);
    assert.deepEqual(
      typesOf().map((row) => row.typename),
      ['Contoso.Plugins.Other'],
      'an update replaces the types it no longer declares and keeps the assembly row',
    );
    await run('pluginpackage', 'delete', {}, existing);
    assert.equal(
      store.tableRows('pluginassembly').some((row) => row.packageid === pkg.pluginpackageid),
      false,
    );
    assert.equal(typesOf().length, 0);
  });

  // @test-kind parity: native trial captures native-trial and native-trial-r2 (dataverse-recorder round 2, n3-package): a package-owned assembly has sourcetype 4, and PATCH of the package version and name answer 204 (contrary to Microsoft Learn)
  it('a plug-in package registers its assembly with sourcetype 4, and its name and version can be changed', async () => {
    const { store, run } = await registry();
    const content = zipOf([
      {
        name: 'Contoso.Package.nuspec',
        data: Buffer.from(
          '<?xml version="1.0"?><package><metadata><id>Contoso.Package</id><version>1.0.0</version></metadata></package>',
        ),
      },
      { name: 'lib/net462/Contoso.Unsigned.dll', data: Buffer.from(UNSIGNED, 'base64') },
    ]).toString('base64');
    const pkg = { content };
    await run('pluginpackage', 'create', pkg);
    const owned = store.tableRows('pluginassembly').find((row) => row.packageid === pkg.pluginpackageid);
    assert.equal(owned.sourcetype, 4);
    assert.equal(owned.isolationmode, 2);
    const existing = { pluginpackageid: pkg.pluginpackageid, name: pkg.name, version: pkg.version };
    const version = { version: '1.0.1' };
    await run('pluginpackage', 'update', version, existing);
    assert.equal(version.version, '1.0.1');
    const name = { name: 'Contoso.Package.Renamed' };
    await run('pluginpackage', 'update', name, { ...existing, version: '1.0.1' });
    assert.equal(name.name, 'Contoso.Package.Renamed');
  });

  // @test-kind parity: native trial captures native-trial and native-trial-r2 (dataverse-recorder round 2, n3-package): on a package-owned assembly PATCH isolationmode answers 403 0x80040256, POST of a plugintype its content does not declare answers 204, and the type is gone after the next package content update
  it('a package-owned assembly refuses another isolation mode, takes a posted plug-in type, and the next package content update drops it', async () => {
    const { store, run } = await registry();
    const entries = Object.entries({
      'Contoso.Owned.nuspec': '<package><metadata><id>Contoso.Owned</id><version>2.0.0</version></metadata></package>',
      'lib/net462/Contoso.Unsigned.dll': Buffer.from(UNSIGNED, 'base64'),
    });
    const content = zipOf(entries.map(([name, data]) => ({ name, data: Buffer.from(data) }))).toString('base64');
    const existing = { content };
    await run('pluginpackage', 'create', existing);
    const owned = store.tableRows('pluginassembly').find((row) => row.packageid === existing.pluginpackageid);
    await assert.rejects(
      run('pluginassembly', 'update', { isolationmode: 1 }, owned),
      (error) =>
        error.status === 403 &&
        error.details?.innerCode === '0x80040256' &&
        error.message.startsWith("Action failed for assembly 'Contoso.Unsigned, Version=1.0.0.0, Culture=neutral"),
    );
    const posted = { typename: 'Contoso.Plugins.Missing', pluginassemblyid: owned.pluginassemblyid };
    await run('plugintype', 'create', posted);
    store.insertRow('plugintype', store.state.tables.plugintype, {
      plugintypeid: 'a1000000-0000-4000-8000-0000000000d1',
      ...posted,
    });
    const typenames = () =>
      store
        .tableRows('plugintype')
        .filter((row) => row.pluginassemblyid === owned.pluginassemblyid)
        .map((row) => row.typename)
        .sort();
    assert.deepEqual(typenames(), ['Contoso.Plugins.Missing', CONTOSO]);
    await run('pluginpackage', 'update', { content }, existing);
    assert.deepEqual(typenames(), [CONTOSO], 'the same content again drops the type it does not declare');
  });

  // @test-kind contract: SolutionPackager step image XML carries MessagePropertyName; the mirrored row keeps it
  it('a Solution step image keeps its exported MessagePropertyName', () => {
    const facts = parsePluginDocument(
      `<ImportExportXml><SdkMessageProcessingStep SdkMessageProcessingStepId="${STEP}"><PluginTypeId>${TYPE}</PluginTypeId><MessageName>SetState</MessageName><PrimaryEntity>contoso_widget</PrimaryEntity><Stage>40</Stage><Mode>0</Mode><Rank>1</Rank><SdkMessageProcessingStepImages><SdkMessageProcessingStepImage Name="Post"><EntityAlias>post</EntityAlias><ImageType>1</ImageType><MessagePropertyName>EntityMoniker</MessagePropertyName></SdkMessageProcessingStepImage></SdkMessageProcessingStepImages></SdkMessageProcessingStep></ImportExportXml>`,
    );
    assert.equal(facts.steps[0].images[0].messagePropertyName, 'EntityMoniker');
    const rows = solutionPluginRows(facts, { organizationId: 'bbbbbbbb-0000-4000-8000-000000000001' });
    assert.equal(rows.sdkmessageprocessingstepimage[0].messagepropertyname, 'EntityMoniker');
  });
});

// @test-kind parity: native rankNegative: a rank -1 Update PreOperation step runs before the rank 1 steps of the stage
// @parity-evidence: native and native-r2 rankNegative (C05d)
it('a rank -1 synchronous Update step runs before the rank 1, 2 and 10 steps of the same stage', async () => {
  const state = emptyState();
  state.mappings.x_widget = { entitySet: 'x_widgets', idColumn: 'x_widgetid' };
  state.tables.x_widget = [];
  const store = new DataStore({ state });
  const row = await store.create('x_widget', { x_name: 'Ranked' }, { admin: true });
  const order = [];
  const ranks = [
    ['10000000-0000-4000-8000-000000000061', -1],
    ['10000000-0000-4000-8000-000000000062', 1],
    ['10000000-0000-4000-8000-000000000063', 2],
    ['10000000-0000-4000-8000-000000000064', 10],
  ];
  const steps = ranks.map(([id, rank]) => ({
    id,
    name: `Invented rank ${rank}`,
    entity: 'x_widget',
    message: 'Update',
    enabled: true,
    stage: 20,
    rank,
    mode: 0,
    typeName: 'Invented.Ranked',
    assemblyId: 'invented',
    supportedDeployment: 0,
    filteringAttributes: [],
    images: [],
  }));
  const handlers = new Map(
    ranks.map(([id, rank]) => [
      id,
      () => {
        order.push(rank);
      },
    ]),
  );
  const items = pluginCatalogue({ plugins: { steps }, handlers });
  store.setPluginPipeline((context) => runPluginPhase({ ...context, store, items, handlers }));
  await store.update('x_widget', row.x_widgetid, { x_name: 'Changed' }, { admin: true });
  assert.deepEqual(order, [-1, 1, 2, 10]);
});
