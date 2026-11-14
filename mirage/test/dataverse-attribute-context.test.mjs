// @test-kind contract: Organization-cache diagnostics require explicit observations with their source; invented IDs and indices check only configuration and wiring.
import { ownedFixture } from '../testing/owned-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { observedConfig } from '../lib/project-config.mjs';
import { dataverseAttributeErrorContext } from '../lib/dataverse-attribute-context.mjs';
import { dataverseError } from '../lib/dataverse-odata.mjs';
import { DataError } from '../lib/data-error.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';

const sourceId = 'a0000000-0000-4000-8000-000000000001';
const capturedId = 'a0000000-0000-4000-8000-000000000002';
const observed = (contexts = { sample: { organizationIndex: 17, metadataId: capturedId } }) => ({
  dataverseAttributeErrorContexts: contexts,
  evidence: 'Invented source-bound organization-cache diagnostic fixture',
});
const failure = () =>
  new DataError('Missing attribute.', 400, 'InvalidFetchXml', {
    innerCode: '0x80041103',
    entity: 'sample',
    attribute: 'unknown',
  });

test('source metadata wins; absent metadata can use an explicit fallback and defaults never append a context', () => {
  const error = failure();
  const configured = observedConfig(observed());
  const store = { resolveMapping: () => ({ dataverseMetadata: { MetadataId: sourceId } }) };
  const context = dataverseAttributeErrorContext(error, configured, store);
  assert.deepEqual(context, { entity: 'sample', organizationIndex: 17, metadataId: sourceId });
  assert.equal(
    dataverseError(error, { attributeErrorContext: context }).body.error.message,
    `Missing attribute.orgIndex: 17, id: ${sourceId}, logicalName: sample`,
  );
  assert.equal(
    dataverseAttributeErrorContext(error, configured, { resolveMapping: () => ({}) }).metadataId,
    capturedId,
  );
  assert.equal(dataverseAttributeErrorContext(error, undefined, store), null);
  assert.equal(
    dataverseAttributeErrorContext(error, configured, {
      resolveMapping() {
        throw new DataError('Unknown fixture', 404, 'UnknownEntity');
      },
    }),
    null,
  );
  assert.equal(dataverseAttributeErrorContext(error, observed({ other: { organizationIndex: 2 } }), store), null);
  assert.equal(
    dataverseAttributeErrorContext(error, observed({ sample: { organizationIndex: 2 } }), {
      resolveMapping: () => ({}),
    }),
    null,
  );
  assert.equal(dataverseError(error).body.error.message, 'Missing attribute.');
  const unrelated = new DataError('Other error.', 400, 'InvalidValue', error.details);
  assert.equal(dataverseAttributeErrorContext(unrelated, configured, store), null);
  assert.equal(dataverseError(unrelated, { attributeErrorContext: context }).body.error.message, 'Other error.');
  const wrongCode = failure();
  wrongCode.details.innerCode = '0x80041102';
  assert.equal(dataverseAttributeErrorContext(wrongCode, configured, store), null);
});

// @test-kind security: Context admission rejects getters and malformed or unbounded organization-specific observations before reading their values.
test('contexts reject unknown fields, entity syntax, non-GUID IDs, bounds, prototypes and accessors', () => {
  for (const contexts of [
    {},
    { 'invalid-name': { organizationIndex: 1 } },
    { sample: { organizationIndex: -1 } },
    { sample: { organizationIndex: 2147483648 } },
    { sample: { organizationIndex: 1.5 } },
    { sample: { organizationIndex: '1' } },
    { sample: { organizationIndex: 1, metadataId: 'not-a-guid' } },
    { sample: { organizationIndex: 1, unexpected: true } },
    Object.create({ sample: { organizationIndex: 1 } }),
  ])
    assert.throws(() => observedConfig(observed(contexts)));
  for (const kind of ['top', 'map', 'context', 'symbol']) {
    let invoked = false;
    const configuration = observed();
    const getter = {
      get() {
        invoked = true;
        throw Error('Getter was executed');
      },
    };
    if (kind === 'top') Object.defineProperty(configuration, 'dataverseAttributeErrorContexts', getter);
    if (kind === 'map') Object.defineProperty(configuration.dataverseAttributeErrorContexts, 'sample', getter);
    if (kind === 'context')
      Object.defineProperty(configuration.dataverseAttributeErrorContexts.sample, 'organizationIndex', getter);
    if (kind === 'symbol')
      Object.defineProperty(configuration.dataverseAttributeErrorContexts.sample, Symbol('unexpected'), { value: 1 });
    assert.throws(() => observedConfig(configuration));
    assert.equal(invoked, false);
  }
  assert.throws(
    () => observedConfig({ dataverseAttributeErrorContexts: { sample: { organizationIndex: 1 } } }),
    /evidence/,
  );
  assert.equal(
    observedConfig(observed({ sample: { organizationIndex: 2147483647 } })).dataverseAttributeErrorContexts.sample
      .organizationIndex,
    2147483647,
  );
});

test('standalone HTTP and batch apply the same context only to genuine missing-attribute FetchXML errors', async (t) => {
  const variable = 'PAQVILO_ATTRIBUTE_CONTEXT_TEST_SECRET',
    previous = process.env[variable];
  process.env[variable] = 'invented-loopback-context-secret';
  t.after(() => {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  });
  const appId = 'a0000000-0000-4000-8000-000000000003';
  const settings = {
    enabled: true,
    applications: [
      {
        appId,
        displayName: 'Invented context client',
        secretEnvironmentVariable: variable,
        roles: ['System Administrator'],
      },
    ],
  };
  const state = emptyState();
  state.mappings.sample = {
    entitySet: 'samples',
    idColumn: 'sampleid',
    fields: { name: {} },
    dataverseMetadata: { MetadataId: sourceId },
  };
  state.tables.sample = [];
  const store = await new DataStore({ state }).init();
  const organization = await createOrganizationRuntime({ store, settings: dataverseSettings(settings) });
  const api = await startDataverseApi({ organization, observed: observedConfig(observed()) });
  ownedFixture(t).add(async () => {
    await api.close();
    await organization.close();
  });
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
  const target =
    '/api/data/v9.2/samples?fetchXml=' +
    encodeURIComponent('<fetch><entity name="sample"><attribute name="unknown"/></entity></fetch>');
  const response = await fetch(api.origin + target, { headers: { authorization: 'Bearer ' + token } });
  assert.equal(response.status, 400);
  const expected = (await response.json()).error;
  assert.equal(expected.code, '0x80041103');
  assert.ok(expected.message.endsWith(`.orgIndex: 17, id: ${sourceId}, logicalName: sample`));
  const body = [
    '--context_batch',
    'Content-Type: application/http',
    'Content-Transfer-Encoding: binary',
    '',
    'GET ' + target + ' HTTP/1.1',
    '',
    '',
    '--context_batch--',
  ].join('\r\n');
  const batch = await fetch(api.origin + '/api/data/v9.2/$batch', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'multipart/mixed; boundary=context_batch' },
    body,
  });
  assert.equal(batch.status, 400);
  const text = await batch.text();
  assert.ok(text.includes(JSON.stringify(expected)), text);
});
