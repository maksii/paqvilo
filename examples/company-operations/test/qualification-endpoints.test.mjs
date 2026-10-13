import test from 'node:test';
import assert from 'node:assert/strict';
import { compileAnonymousQualificationEndpoint } from '../portal-security/qualification-endpoints.mjs';

test('anonymous dispatcher fixes its table/query and uses escaped SDK markers without granting recording-table access', () => {
  const configuration = { roles: [{ anonymous: true }], query: { id: 'QF-ANON', table: 'asset', pageSize: 50, fixtureBindings: [],
    fields: [{ name: 'assetid', type: 'guid' }], fetchXml: '<fetch page="{{page}}"><entity name="asset"><attribute name="assetid"/><filter><condition attribute="name" operator="ne" value="{{markerUtc}}"/><condition attribute="name" operator="ne" value="{{markerOperation}}"/></filter></entity></fetch>' } };
  const endpoint = compileAnonymousQualificationEndpoint(configuration, { suiteVersion: 'suite-1', datasetVersion: 'data-1', namespace: 'anon-fixture' });
  assert.equal(endpoint.policy.recordingTableGlobalGrants, false); assert.equal(endpoint.policy.acceptsAuthoredFetchXml, false);
  assert.ok(!/entities\.|operation\./.test(endpoint.template.content.source));
  assert.match(endpoint.template.content.source, /bound_utc_marker \| xml_escape/);
  assert.match(endpoint.template.content.source, /bound_operation_marker \| xml_escape/);
  assert.match(endpoint.template.content.source, /user == nil/);
  const operation = { pqvd_testoperationid: '00000000-0000-0000-0000-000000000001', pqvd_markerutc: 'CO-UTC:2026-10-13T00:00:00.000Z' };
  assert.equal(new URLSearchParams(endpoint.requestParameters(operation)).get('markerUtc'), operation.pqvd_markerutc);
  assert.throws(() => endpoint.requestParameters(operation, 21), /immutable SDK marker/);
  assert.throws(() => compileAnonymousQualificationEndpoint({ ...configuration, roles: [] }, { suiteVersion: 'suite-1', datasetVersion: 'data-1', namespace: 'anon-fixture' }), /Anonymous endpoint/);
});
