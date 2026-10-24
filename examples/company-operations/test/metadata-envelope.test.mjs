import test from 'node:test';
import assert from 'node:assert/strict';
import {
  readNativeMetadataEnvelope,
  readPortalMetadataEnvelope,
  compareMetadataEnvelopeWindow,
} from '../portal-harness/metadata-envelope.mjs';
const actor = '10000000-0000-0000-0000-000000000001',
  run = '10000000-0000-0000-0000-000000000002',
  role = '10000000-0000-0000-0000-000000000003',
  hash = '1'.repeat(64);
const native = (timestamp) => ({
  origin: 'https://invented-dataverse.test',
  async get(route) {
    if (route === 'RetrieveTimestamp()') return { Timestamp: timestamp };
    assert.ok(route.startsWith('RetrieveMetadataChanges(Query=@q)?@q='));
    const query = JSON.parse(decodeURIComponent(route.split('?@q=')[1]));
    assert.deepEqual(query.Properties, { AllProperties: false, PropertyNames: ['LogicalName'] });
    assert.deepEqual(query.Criteria.Conditions, [
      { PropertyName: 'LogicalName', ConditionOperator: 'Equals', Value: { Type: 'System.String', Value: 'account' } },
    ]);
    return { ServerVersionStamp: timestamp + '!metadata source time', EntityMetadata: [{ LogicalName: 'account' }] };
  },
});
const control = (version) => ({
  portalOrigin: 'https://invented-portal.test',
  runRecord: { pqvd_testrunid: run, _pqvd_runnercontactid_value: actor },
  actorId: actor,
  roleIds: [role],
  siteSourceHash: hash,
  registrationHash: hash,
  snapshotHash: hash,
  async readPortal(path) {
    assert.equal(path, `/_api/pqvd_testruns(${run})?$select=pqvd_testrunid`);
    return {
      status: 200,
      body: JSON.stringify({ pqvd_testrunid: run, '@Microsoft.Dynamics.CRM.globalmetadataversion': version }),
    };
  },
});

test('metadata controls observe a separate portal cache envelope and never infer it from current Dataverse timestamps', async () => {
  const nativeBefore = await readNativeMetadataEnvelope(native('9100')),
    portalBefore = await readPortalMetadataEnvelope(control('9000'));
  await new Promise((resolve) => setTimeout(resolve, 2));
  const portalAfter = await readPortalMetadataEnvelope(control('9000')),
    nativeAfter = await readNativeMetadataEnvelope(native('9100'));
  const result = compareMetadataEnvelopeWindow({ nativeBefore, nativeAfter, portalBefore, portalAfter });
  assert.equal(result.qualified, true);
  assert.equal(result.portalVersion, '9000');
  assert.equal(result.dataverseTimestamp, '9100');
  assert.equal(result.portalMatchesCurrentTimestamp, false);
  const changed = await readPortalMetadataEnvelope(control('9001'));
  assert.equal(
    compareMetadataEnvelopeWindow({
      nativeBefore,
      nativeAfter: await readNativeMetadataEnvelope(native('9100')),
      portalBefore,
      portalAfter: changed,
    }).qualified,
    false,
  );
  assert.throws(
    () =>
      compareMetadataEnvelopeWindow({
        nativeBefore,
        nativeAfter,
        portalBefore,
        portalAfter: { ...portalAfter, version: '9100' },
      }),
    /altered/,
  );
  assert.throws(
    () =>
      compareMetadataEnvelopeWindow({
        nativeBefore: nativeAfter,
        nativeAfter: nativeBefore,
        portalBefore,
        portalAfter,
      }),
    /chronological/,
  );
});

test('metadata observations reject unstable sources, foreign Run actors, malformed control responses and unbounded schema reads', async () => {
  await assert.rejects(readNativeMetadataEnvelope(native('1'), { tableName: "account' or 'x" }), /bounded/);
  await assert.rejects(
    readNativeMetadataEnvelope({
      origin: 'https://invented-dataverse.test',
      async get(route) {
        return route === 'RetrieveTimestamp()'
          ? { Timestamp: '1' }
          : { ServerVersionStamp: '1!time', EntityMetadata: [{ LogicalName: 'account' }, { LogicalName: 'contact' }] };
      },
    }),
    /single table/,
  );
  const drift = await readNativeMetadataEnvelope({
    origin: 'https://invented-dataverse.test',
    count: 0,
    async get(route) {
      return route === 'RetrieveTimestamp()'
        ? { Timestamp: String(++this.count) }
        : { ServerVersionStamp: '1!time', EntityMetadata: [{ LogicalName: 'account' }] };
    },
  });
  assert.equal(drift.stable, false);
  await assert.rejects(readPortalMetadataEnvelope({ ...control('9000'), actorId: run }), /actor-owned/);
  for (const [response, expected] of [
    [{ status: 403, body: '{}' }, /bounded successful response/],
    [{ status: 200, body: '<html />' }, /invalid JSON/],
    [
      {
        status: 200,
        body: JSON.stringify({ pqvd_testrunid: actor, '@Microsoft.Dynamics.CRM.globalmetadataversion': '9' }),
      },
      /identity or metadata envelope/,
    ],
    [
      {
        status: 200,
        body: JSON.stringify({ pqvd_testrunid: run, '@Microsoft.Dynamics.CRM.globalmetadataversion': 9 }),
      },
      /identity or metadata envelope/,
    ],
  ])
    await assert.rejects(readPortalMetadataEnvelope({ ...control('9'), readPortal: async () => response }), expected);
});
