// Simulated Global Discovery service: service document, $metadata, Instances keys,
// $select and $filter.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscovery } from '../lib/dataverse-discovery.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const ORG = '6F1D7C1E-2B3A-4C5D-8E9F-0A1B2C3D4E5F';
const MISSING = '00000000-0000-4000-8000-0000000000ff';
// Upper-case Id on purpose: records lower-case Guid values, so the lower-case literal must match too.
const INSTANCE = {
  Id: ORG,
  UniqueName: 'contosotest',
  UrlName: 'contosotest',
  FriendlyName: 'Contoso Test',
  Version: '9.2.25041.00000',
  Url: ORIGIN,
  ApiUrl: ORIGIN,
  Region: 'NA',
  State: 0,
  IsUserSysAdmin: true,
  TenantId: '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d',
  EnvironmentId: '11111111-2222-4333-8444-555555555555',
  LastUpdated: '2026-10-01T00:00:00.0000000Z',
  TrialExpirationDate: '9999-12-31T23:59:59.9999999Z',
  Purpose: null,
  SchemaType: 'Standard',
  DatacenterId: '00000000-0000-0000-0000-000000000000',
};

function discovery(instance = INSTANCE) {
  return createDiscovery({ instance: () => instance });
}

function get(pathname, query = '', api = discovery()) {
  return api.handle({ pathname, searchParams: new URLSearchParams(query), origin: ORIGIN });
}

function ids(path, query) {
  return get(path, query).body.value.map((row) => row.UniqueName);
}

function filtered(filter) {
  return get('/api/discovery/v2.0/Instances', new URLSearchParams({ $filter: filter })).body.value.length;
}

function assertDataError(fn, status, code) {
  assert.throws(fn, (error) => error.name === 'DataError' && error.status === status && error.code === code);
}

test('service document lists the Instances entity set', () => {
  const result = get('/api/discovery/v2.0/');
  assert.equal(result.status, 200);
  assert.equal(result.body['@odata.context'], `${ORIGIN}/api/discovery/v2.0/$metadata`);
  assert.deepEqual(result.body.value, [{ name: 'Instances', kind: 'EntitySet', url: 'Instances' }]);
  assert.equal(get('/api/discovery/v2.0').status, 200);
});

test('metadata declares Instance with Id key and the alternate keys', () => {
  const result = get('/api/discovery/v2.0/$metadata');
  assert.equal(result.status, 200);
  assert.equal(result.headers['content-type'], 'application/xml; charset=utf-8');
  const xml = result.body;
  assert.match(xml, /<EntityType Name="Instance">\s*<Key><PropertyRef Name="Id"\/><\/Key>/);
  assert.match(xml, /<Property Name="State" Type="Edm.Int32"\/>/);
  assert.match(xml, /<Property Name="Id" Type="Edm.Guid" Nullable="false"\/>/);
  for (const name of ['UniqueName', 'Region', 'State', 'Version']) {
    assert.match(xml, new RegExp(`PropertyValue Property="Name" PropertyPath="${name}"`));
  }
  assert.match(xml, /EntitySet Name="Instances"/);
});

test('collection returns every property with defaults filled in', () => {
  const result = get('/api/discovery/v2.0/Instances');
  assert.equal(result.body['@odata.context'], `${ORIGIN}/api/discovery/v2.0/$metadata#Instances`);
  const [row] = result.body.value;
  assert.equal(Object.keys(row).length, 20);
  assert.equal(row.Id, ORG.toLowerCase());
  assert.equal(row.DatacenterName, null);
  assert.equal(row.State, 0);
  assert.equal(row.StatusMessage, 6);
  assert.equal(row.OrganizationType, 0);
  assert.equal(row.IsUserSysAdmin, true);
});

test('versioned paths echo the requested version in the context', () => {
  const result = get('/api/discovery/v9.1/Instances');
  assert.equal(result.body['@odata.context'], `${ORIGIN}/api/discovery/v9.1/$metadata#Instances`);
  assert.equal(result.body.value.length, 1);
});

test('Id key and alternate keys return collections, empty when nothing matches', () => {
  assert.equal(get(`/api/discovery/v2.0/Instances(${ORG.toLowerCase()})`).body.value.length, 1);
  assert.equal(get(`/api/discovery/v2.0/Instances({${ORG}})`).body.value.length, 1);
  assert.equal(get(`/api/discovery/v2.0/Instances(${MISSING})`).body.value.length, 0);
  assert.deepEqual(ids("/api/discovery/v2.0/Instances(UniqueName='contosotest')"), ['contosotest']);
  assert.deepEqual(ids("/api/discovery/v2.0/Instances(UniqueName='nope')"), []);
  assert.deepEqual(ids("/api/discovery/v2.0/Instances(Region='NA')"), ['contosotest']);
  assert.deepEqual(ids('/api/discovery/v2.0/Instances(State=0)'), ['contosotest']);
  assert.deepEqual(ids("/api/discovery/v2.0/Instances(Version='9.2.25041.00000')"), ['contosotest']);
  assert.deepEqual(ids('/api/discovery/v2.0/Instances(UniqueName%3D%27contosotest%27)'), ['contosotest']);
});

test('key predicates reject unknown names and empty keys', () => {
  assertDataError(() => get("/api/discovery/v2.0/Instances(UrlName='contosotest')"), 400, 'InvalidKey');
  assertDataError(() => get('/api/discovery/v2.0/Instances()'), 400, 'InvalidKey');
});

test('$select limits and orders the properties and names them in the context', () => {
  const result = get('/api/discovery/v2.0/Instances', '$select=ApiUrl,FriendlyName');
  assert.equal(result.body['@odata.context'], `${ORIGIN}/api/discovery/v2.0/$metadata#Instances(ApiUrl,FriendlyName)`);
  assert.deepEqual(Object.keys(result.body.value[0]), ['ApiUrl', 'FriendlyName']);
  assertDataError(() => get('/api/discovery/v2.0/Instances', '$select=Nope'), 400, 'InvalidQuery');
});

test('$filter compares case-sensitively and combines with the key', () => {
  assert.equal(filtered("UniqueName eq 'contosotest'"), 1);
  assert.equal(filtered("UniqueName eq 'ContosoTest'"), 0);
  assert.equal(filtered("startswith(FriendlyName,'Contoso')"), 1);
  assert.equal(filtered("startswith(FriendlyName,'contoso')"), 0);
  assert.equal(filtered("contains(FriendlyName,'Test')"), 1);
  assert.equal(filtered("endswith(UniqueName,'test')"), 1);
  assert.equal(filtered("endswith(UniqueName,'TEST')"), 0);
  assert.equal(get("/api/discovery/v2.0/Instances(Region='NA')", '$filter=State eq 1').body.value.length, 0);
  assert.deepEqual(ids("/api/discovery/v2.0/Instances(Region='NA')", '$filter=State eq 0'), ['contosotest']);
});

test('$filter supports comparison, logical operators, grouping and literals', () => {
  assert.equal(filtered("State eq 0 and Region eq 'NA'"), 1);
  assert.equal(filtered("State eq 1 or Region eq 'EU'"), 0);
  assert.equal(filtered('not (State eq 1)'), 1);
  assert.equal(filtered("(State eq 1 or Region eq 'NA') and IsUserSysAdmin eq true"), 1);
  assert.equal(filtered('IsUserSysAdmin'), 1);
  assert.equal(filtered('State gt -1 and State le 0'), 1);
  assert.equal(filtered('State ge 1'), 0);
  assert.equal(filtered('State lt 1'), 1);
  assert.equal(filtered('StatusMessage eq 6 and OrganizationType eq 0'), 1);
  assert.equal(filtered('DatacenterName eq null'), 1);
  assert.equal(filtered('DatacenterName ne null'), 0);
  assert.equal(filtered(`Id eq ${ORG}`), 1);
  assert.equal(filtered("UniqueName eq 'a''b'"), 0);
});

test('$filter rejects unknown properties and malformed expressions', () => {
  for (const filter of ['Nope eq 1', 'State eq', 'State eq 0 and', "UniqueName eq 'x", 'State eq 0)', 'State in (0)']) {
    assertDataError(
      () => get('/api/discovery/v2.0/Instances', new URLSearchParams({ $filter: filter }).toString()),
      400,
      'InvalidQuery',
    );
  }
});

test('unknown resource segments are a 404', () => {
  assertDataError(() => get('/api/discovery/v2.0/Accounts'), 404, 'UnknownResource');
});

test('$filter accepts unquoted DateTimeOffset literals and compares them as instants', () => {
  const count = (api, filter) =>
    get('/api/discovery/v2.0/Instances', new URLSearchParams({ $filter: filter }), api).body.value.length;
  const documented = 'TrialExpirationDate gt 2022-07-14T00:00:00Z and IsUserSysAdmin eq true';
  const later = discovery({ ...INSTANCE, TrialExpirationDate: '2030-01-01T00:00:00Z' });
  const earlier = discovery({ ...INSTANCE, TrialExpirationDate: '2020-01-01T00:00:00Z' });
  assert.equal(count(later, documented), 1);
  assert.equal(count(earlier, documented), 0);
  assert.equal(count(earlier, 'TrialExpirationDate lt 2022-07-14T00:00:00Z'), 1);
  // The same moment written with an offset is equal to the Z literal, although the text differs.
  const sameMoment = discovery({ ...INSTANCE, TrialExpirationDate: '2022-07-14T00:00:00Z' });
  assert.equal(count(sameMoment, 'TrialExpirationDate eq 2022-07-14T02:00:00+02:00'), 1);
  assertDataError(() => count(later, 'TrialExpirationDate gt 2022-13-40T00:00:00Z'), 400, 'InvalidQuery');
});

test('$filter nesting deeper than 100 answers 400 instead of overflowing the stack', () => {
  assert.equal(filtered(`${'('.repeat(20)}IsUserSysAdmin eq true${')'.repeat(20)}`), 1);
  assertDataError(() => filtered(`${'('.repeat(200)}IsUserSysAdmin eq true${')'.repeat(200)}`), 400, 'InvalidQuery');
  assertDataError(() => filtered(`${'not '.repeat(200)}IsUserSysAdmin`), 400, 'InvalidQuery');
  assertDataError(() => filtered('('.repeat(20000)), 400, 'InvalidQuery');
});
