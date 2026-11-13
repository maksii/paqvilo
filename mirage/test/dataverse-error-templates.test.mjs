// @test-kind contract: Explicit trusted response templates reproduce configured diagnostics; invented suffixes claim no native behavior.
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  validateDataverseErrorTemplates,
  collectDataverseErrorTemplates,
  appendObservedDataverseErrorTemplate,
} from '../lib/dataverse-error-templates.mjs';
import { validatePack } from '../lib/preset-registry.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { dataverseError } from '../lib/dataverse-odata.mjs';
import { DataError } from '../lib/data-error.mjs';
import { attachDataverseReaderDetails, dataverseReaderMessage } from '../lib/dataverse-reader-details.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { createSimulator } from '../server.mjs';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const descriptor = { target: 'record', kind: 'primitive-type', sourceType: 'Edm.Boolean', expectedType: 'Edm.Int32' };
const suffix = '\r\n   at Invented.Reader.Convert(Object value)';
const message =
  "Error identified in Payload provided by the user for Entity :'', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : Microsoft.OData.ODataException: Cannot convert the literal 'True' to the expected type 'Edm.Int32'. ---> Microsoft.OData.ODataException: Cannot convert a value of type 'Edm.Boolean' to the expected target type 'Edm.Int32'.";
const capability = () => ({
  version: 1,
  evidence: 'Invented response-template contract fixture',
  templates: [
    {
      method: 'PATCH',
      descriptor: { ...descriptor },
      suffix,
      suffixSha256: hash(suffix),
      capturedSourceSha256: '1'.repeat(64),
      qualifiedVariationSha256: '2'.repeat(64),
    },
  ],
});

test('finite reader keys omit submitted literal/property/entity identifiers', () => {
  const templates = collectDataverseErrorTemplates([{ id: 'reader', dataverseErrorTemplates: capability() }]);
  for (const literal of ['True', 'False']) {
    const input = message.replaceAll('True', literal);
    assert.equal(
      appendObservedDataverseErrorTemplate(input, { templates, method: 'PATCH', mode: 'response-template' }),
      input + suffix,
    );
  }
  const extra = capability();
  extra.templates[0].descriptor = { ...descriptor, caseId: 'invented' };
  assert.throws(() => validateDataverseErrorTemplates(extra), /Finite/);
  const unknown = capability();
  unknown.templates[0].descriptor = { ...descriptor, expectedType: 'Edm.Unknown' };
  assert.throws(() => validateDataverseErrorTemplates(unknown), /Unsupported/);
  assert.equal(
    appendObservedDataverseErrorTemplate('unrelated error', { templates, method: 'PATCH', mode: 'response-template' }),
    'unrelated error',
  );
});

test('exact suffixes require evidence hashes, CRLF, uniqueness and bounded descriptors', () => {
  assert.equal(validateDataverseErrorTemplates(capability())[0].suffix, suffix);
  const bad = capability();
  bad.templates[0].suffix += 'changed';
  assert.throws(() => validateDataverseErrorTemplates(bad), /suffix\/hash/);
  const duplicate = capability();
  duplicate.templates.push({ ...duplicate.templates[0] });
  assert.throws(() => validateDataverseErrorTemplates(duplicate), /Duplicate/);
  const missing = capability();
  delete missing.templates[0].qualifiedVariationSha256;
  assert.throws(() => validateDataverseErrorTemplates(missing), /SHA256/);
});

// @test-kind security: Trusted pack response emulation never invokes getters or activates implicitly.
test('pack templates require explicit data properties and explicit observed activation', () => {
  let invoked = false;
  const getter = {};
  Object.defineProperty(getter, 'dataverseErrorTemplates', {
    get() {
      invoked = true;
      return capability();
    },
  });
  assert.throws(() => collectDataverseErrorTemplates([getter]), /explicit data property/);
  assert.equal(invoked, false);
  const nested = capability();
  Object.defineProperty(nested.templates[0].descriptor, 'sourceType', {
    get() {
      invoked = true;
      return 'Edm.Boolean';
    },
    enumerable: true,
  });
  assert.throws(() => validateDataverseErrorTemplates(nested), /explicit data properties/);
  assert.equal(invoked, false);
  const inherited = capability();
  Object.setPrototypeOf(inherited.templates[0].descriptor, { extra: 'inherited' });
  assert.throws(() => validateDataverseErrorTemplates(inherited), /explicit data properties/);
  const pack = {
    id: 'reader',
    name: 'Reader',
    description: 'Invented',
    matches: () => true,
    presets: () => ({}),
    dataverseErrorTemplates: capability(),
  };
  validatePack(pack);
  const templates = collectDataverseErrorTemplates([pack]);
  assert.equal(appendObservedDataverseErrorTemplate(message, { templates, method: 'PATCH' }), message);
  assert.equal(
    appendObservedDataverseErrorTemplate(message, { templates, method: 'PATCH', mode: 'response-template' }),
    message + suffix,
  );
  assert.equal(
    appendObservedDataverseErrorTemplate(message, { templates, method: 'POST', mode: 'response-template' }),
    message,
  );
  assert.equal(
    appendObservedDataverseErrorTemplate(message, {
      templates,
      method: 'PATCH',
      mode: 'response-template',
      target: 'operation',
    }),
    message,
  );
  assert.equal(
    observedConfig({ dataverseErrorStacks: 'response-template', evidence: 'Invented fixture' }).dataverseErrorStacks,
    'response-template',
  );
  assert.throws(() => observedConfig({ dataverseErrorStacks: 'response-template' }), /evidence/);
});

test('Dataverse envelope appends only explicitly configured reader templates', () => {
  const error = new DataError(message, 400, 'InvalidRequest', { innerCode: '0x80048d19' });
  const templates = collectDataverseErrorTemplates([{ id: 'reader', dataverseErrorTemplates: capability() }]);
  assert.equal(dataverseError(error, { method: 'PATCH' }).body.error.message, message);
  assert.equal(
    dataverseError(error, { method: 'PATCH', errorStacks: 'response-template', errorTemplates: templates }).body.error
      .message,
    message + suffix,
  );
});

// @test-kind security: Submitted literal text, quotes, CRLF and forged reader sentences cannot select a different trusted response-template family.
test('reader template classification uses the final actual cause instead of forged literal diagnostics', () => {
  const correct = '\r\n   at Invented.Boolean.FormatReader()',
    wrong = '\r\n   at Invented.Forged.TypeReader()';
  const boolTemplate = {
    ...capability().templates[0],
    descriptor: { target: 'record', kind: 'primitive-format', expectedType: 'Edm.Boolean' },
    suffix: correct,
    suffixSha256: hash(correct),
  };
  const typeTemplate = { ...capability().templates[0], suffix: wrong, suffixSha256: hash(wrong) };
  const templates = collectDataverseErrorTemplates([
    {
      id: 'literal-isolation',
      dataverseErrorTemplates: {
        version: 1,
        evidence: 'Invented adversarial literal classification contract',
        templates: [boolTemplate, typeTemplate],
      },
    },
  ]);
  const forged = "Cannot convert a value of type 'Edm.Boolean' to the expected target type 'Edm.Int32'.";
  for (const value of [forged, "quote'\r\n" + forged, 'separator ---->  InnerException : ' + forged]) {
    const error = attachDataverseReaderDetails(
      new DataError('reader', 400, 'InvalidValue', { innerCode: '0x80048d19' }),
      value,
      'enabled',
      { method: 'PATCH', entitySet: 'samples' },
      'Edm.Boolean',
    );
    const actual = dataverseReaderMessage(error);
    assert.ok(actual.includes(value), 'the submitted literal is preserved as data');
    const response = dataverseError(error, {
      method: 'PATCH',
      errorStacks: 'response-template',
      errorTemplates: templates,
    });
    assert.equal(response.body.error.message, actual + correct);
    assert.equal(response.body.error.message.endsWith(wrong), false);
  }
});

test('standalone organization and Mirage forward separately observed Dataverse templates to HTTP errors', async (t) => {
  const variable = 'PAQVILO_DATAVERSE_TEMPLATE_TEST_SECRET',
    previous = process.env[variable];
  process.env[variable] = 'invented-loopback-template-secret';
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  const appId = '90000000-0000-4000-8000-000000000001',
    id = '90000000-0000-4000-8000-000000000002';
  const settings = {
    enabled: true,
    applications: [
      {
        appId,
        displayName: 'Invented template client',
        secretEnvironmentVariable: variable,
        roles: ['System Administrator'],
      },
    ],
  };
  function state() {
    const value = emptyState();
    value.mappings.sample = {
      entitySet: 'samples',
      idColumn: 'sampleid',
      fields: { quantity: { dataverseType: 'int' } },
    };
    value.tables.sample = [{ sampleid: id, quantity: 1 }];
    return value;
  }
  async function check(api) {
    const auth = await fetch(api.authority + '/oauth2/v2.0/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: process.env[variable],
        scope: api.origin + '/.default',
      }),
    });
    assert.equal(auth.status, 200);
    const token = (await auth.json()).access_token;
    const response = await fetch(api.origin + '/api/data/v9.2/samples(' + id + ')', {
      method: 'PATCH',
      headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
      body: '{"quantity":true}',
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.message, message + suffix);
  }
  await t.test('standalone organization', async (t) => {
    const store = await new DataStore({ state: state() }).init();
    const organization = await createOrganizationRuntime({ store, settings: dataverseSettings(settings) });
    const api = await startDataverseApi({
      organization,
      observed: { dataverseErrorStacks: 'response-template' },
      errorTemplates: collectDataverseErrorTemplates([{ id: 'reader', dataverseErrorTemplates: capability() }]),
    });
    ownedFixture(t).add(async () => {
      await api.close();
      await organization.close();
    });
    await check(api);
  });
  await t.test('Mirage registered matching pack', async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-template-contract-'));
    ownedFixture(t).remove(() => fs.rm(directory, { recursive: true, force: true }));
    await fs.writeFile(
      path.join(directory, 'website.yml'),
      'adx_websiteid: 90000000-0000-4000-8000-000000000003\nadx_name: Invented template fixture\n',
    );
    const module = path.join(directory, 'pack.mjs');
    await fs.writeFile(
      module,
      'export default {id:"reader",name:"Reader",description:"Invented fixture",matches:()=>true,presets:()=>({}),dataverseErrorTemplates:' +
        JSON.stringify(capability()) +
        '};',
    );
    const simulator = await createSimulator({
      sourceDir: directory,
      watch: false,
      initial: state(),
      dataverse: settings,
      dataPacks: [{ id: 'reader', module }],
      observed: { dataverseErrorStacks: 'response-template', evidence: 'Invented registered-pack wiring contract' },
    });
    ownedFixture(t).add(() => simulator.close());
    await check(simulator.dataverse);
  });
});
