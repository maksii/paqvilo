// @test-kind contract: Explicit metadata epoch observations preserve synthesized defaults and follow configuration changes independently of data edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createMetadataService } from '../lib/dataverse-metadata.mjs';
import { DataStore, emptyState } from '../lib/data.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';

test('the explicit metadata epoch is optional, numeric and separate from synthesized schema versions', () => {
  const mappings = {
    sample: { entitySet: 'samples', idColumn: 'sampleid', fields: { name: { dataverseType: 'nvarchar' } } },
  };
  let epoch;
  const service = createMetadataService({
    organizationId: '70000000-0000-4000-8000-000000000001',
    mappings: () => mappings,
    observedMetadataVersion: () => epoch,
  });
  const original = service.etag();
  assert.match(original, /^"\d+"$/);
  epoch = '314159';
  service.captureObservedVersion();
  assert.equal(service.etag(), '"314159"');
  mappings.sample.fields.extra = { dataverseType: 'int' };
  assert.notEqual(service.etag(), '"314159"', 'A captured source epoch cannot survive a local metadata change');
  for (const invalid of [undefined, null, 42, '42x', '"42"', {}, '']) {
    epoch = invalid;
    assert.match(service.etag(), /^"\d+"$/);
    assert.notEqual(service.etag(), original, 'Default schema-derived ETag still detects metadata changes');
  }
  epoch = '271828';
  assert.equal(service.etag(), '"271828"');
});

// @test-kind observation: native CSDL ETags and query.annotations-all epoch recorded in fixtures/dataverse-native-record-shapes.json (service.metadata and annotation responses as hashes only); the epoch is an explicit invented input typed here, so it is not a replay case.
test('HTTP CSDL and record annotations share an explicitly configured source epoch', async (t) => {
  const bytes = await readFile(new URL('./fixtures/dataverse-native-record-shapes.json', import.meta.url));
  assert.equal(
    createHash('sha256').update(bytes).digest('hex'),
    'f31640555848018f3e365080293431ca49541f5204eee70652f397e27cbc0377',
  );
  const proof = JSON.parse(bytes);
  assert.equal(proof.captures.length, 2);
  assert.equal(proof.expected.metadataEpoch.quotedEtagEqualsGlobalAnnotation, true);
  const state = emptyState(),
    appId = '70000000-0000-4000-8000-000000000002';
  state.mappings.sample = {
    entitySet: 'samples',
    idColumn: 'sampleid',
    fields: { name: { dataverseType: 'nvarchar' } },
  };
  state.tables.sample = [{ sampleid: '70000000-0000-4000-8000-000000000003', name: 'Invented source epoch' }];
  const store = await new DataStore({ state }).init();
  store.setObserved({
    webApiGlobalMetadataVersion: '314159',
    evidence: 'Invented explicit source epoch, paired native response relation',
  });
  const secretName = 'PAQVILO_METADATA_EPOCH_TEST_SECRET';
  process.env[secretName] = 'Invented loopback secret';
  t.after(() => delete process.env[secretName]);
  const organization = await createOrganizationRuntime({
    store,
    settings: dataverseSettings({
      enabled: true,
      applications: [
        {
          appId,
          displayName: 'Invented epoch client',
          secretEnvironmentVariable: secretName,
          roles: ['System Administrator'],
        },
      ],
    }),
  });
  t.after(() => organization.close());
  const api = await startDataverseApi({ organization });
  t.after(() => api.close());
  const tokenResponse = await fetch(api.authority + '/oauth2/v2.0/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: appId,
      client_secret: process.env[secretName],
      scope: api.origin + '/.default',
    }),
  });
  assert.equal(tokenResponse.status, 200);
  const token = (await tokenResponse.json()).access_token;
  const headers = { authorization: 'Bearer ' + token, prefer: 'odata.include-annotations="*"' };
  const metadata = await fetch(api.origin + '/api/data/v9.2/$metadata', { headers });
  assert.equal(metadata.status, 200);
  assert.match(await metadata.text(), /EntityContainer/);
  const response = await fetch(api.origin + '/api/data/v9.2/samples?$select=name', { headers });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body['@Microsoft.Dynamics.CRM.globalmetadataversion'], '314159');
  assert.equal(metadata.headers.get('etag'), '"' + body['@Microsoft.Dynamics.CRM.globalmetadataversion'] + '"');
  // @test-kind contract: Local metadata edits invalidate the captured epoch, while row edits retain it; the matching conditional status is the native behaviour recorded in dataverse-native-metadata-conditionals.json.
  // Evidence: dataverse-native-metadata-conditionals.json records matching current CSDL ETags return304 in two fresh native cohorts, correcting the former local-only200 assumption.
  await t.test('local metadata changes invalidate the shared source epoch', async () => {
    await store.transact(() => {
      store.state.tables.sample[0].name = 'Row edit';
    });
    const unchanged = await fetch(api.origin + '/api/data/v9.2/$metadata', {
      headers: { ...headers, 'if-none-match': '"314159"' },
    });
    assert.equal(unchanged.status, 304);
    assert.equal(unchanged.headers.get('etag'), '"314159"', 'Row changes do not invalidate the metadata epoch');
    await unchanged.text();
    await store.transact(() => {
      store.state.mappings.sample.fields.extra = { dataverseType: 'nvarchar' };
    });
    const changed = await fetch(api.origin + '/api/data/v9.2/$metadata', {
      headers: { ...headers, 'if-none-match': '"314159"' },
    });
    assert.equal(changed.status, 200, 'Metadata changes must not answer a stale conditional304');
    assert.match(await changed.text(), /Property Name="extra"/);
    assert.notEqual(changed.headers.get('etag'), '"314159"');
    const refreshed = await fetch(api.origin + '/api/data/v9.2/samples?$select=name', { headers });
    assert.equal(
      changed.headers.get('etag'),
      '"' + (await refreshed.json())['@Microsoft.Dynamics.CRM.globalmetadataversion'] + '"',
    );
  });
});
