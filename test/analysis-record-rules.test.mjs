// @test-kind contract: local normalized record checks report evidence without resolving live configuration.
import assert from 'node:assert/strict';
import test from 'node:test';
import { analyzeRecords, recordRules } from '../lense/analysis/record-rules.mjs';

function setting(name, value, extra = {}) {
  return { kind: 'sitesetting', file: `${name}.yml`, line: 1, column: 1, fields: { name, value, ...extra } };
}

function role(id, fields = {}) {
  return { kind: 'webrole', id, file: `${id}.yml`, line: 1, column: 1, fields };
}

function findings(records) {
  const found = [];
  analyzeRecords(records, (id, record, field) => found.push({ id, file: record.file, field }));
  return found;
}

function ids(records) {
  return findings(records).map((finding) => finding.id);
}

test('record rule registry has unique IDs and actionable metadata', () => {
  assert.equal(new Set(recordRules.map((rule) => rule.id)).size, recordRules.length);
  for (const rule of recordRules) {
    assert.ok(['error', 'warning', 'hint'].includes(rule.severity));
    assert.ok(rule.title && rule.message && rule.remediation && rule.category && rule.confidence);
    assert.ok(rule.references.every((reference) => reference.startsWith('https://')));
  }
});

test('enabled Web API requires explicit columns or a view and supports both sources', () => {
  const enabled = setting('Webapi/sample_entry/enabled', 'True');
  assert.deepEqual(ids([enabled]), ['PP-API-002']);
  assert.deepEqual(ids([enabled, setting('Webapi/sample_entry/fields', 'sample_name')]), []);
  assert.deepEqual(ids([enabled, setting('Webapi/sample_entry/UseFieldsFromView', 'true')]), ['PP-API-003']);
  assert.deepEqual(
    ids([
      enabled,
      setting('Webapi/sample_entry/UseFieldsFromView', 'true'),
      setting('Webapi/sample_entry/fields', 'sample_name'),
    ]),
    ['PP-API-003'],
  );
  assert.deepEqual(ids([enabled, setting('Webapi/sample_entry/UseFieldsFromView', 'false')]), ['PP-API-002']);
});

test('wildcard configuration is reported without a suggested guessed replacement', () => {
  const wildcard = setting('Webapi/sample_entry/fields', ' * ');
  assert.deepEqual(findings([wildcard]), [{ id: 'PP-API-001', file: wildcard.file, field: 'value' }]);
  assert.deepEqual(ids([setting('Webapi/sample_entry/fields', 'sample_name,sample_code')]), []);
});

test('disabled, unknown and inactive settings do not establish missing fields', () => {
  assert.deepEqual(
    ids([
      setting('Webapi/sample_first/enabled', 'false'),
      setting('Webapi/sample_second/enabled', '1'),
      setting('Webapi/sample_third/enabled', 'true', { statecode: 1 }),
      setting('Webapi/sample_fourth/enabled', 'true', { source: 1 }),
    ]),
    ['PP-CONFIG-002', 'PP-CONFIG-002'],
  );
});

test('environment-backed companion settings keep the effective allowlist unresolved', () => {
  for (const extra of [{ source: 1 }, { environmentvariableid: 'sample-reference' }]) {
    assert.deepEqual(
      ids([setting('Webapi/sample_entry/enabled', 'true'), setting('Webapi/sample_entry/fields', '', extra)]),
      ['PP-CONFIG-002'],
    );
  }
  assert.deepEqual(
    ids([
      setting('Webapi/sample_entry/enabled', 'true'),
      setting('Webapi/sample_entry/UseFieldsFromView', '${SAMPLE_VIEW}'),
    ]),
    ['PP-CONFIG-002'],
  );
});

test('duplicate settings are unresolved even with matching literal values', () => {
  for (const second of ['sample_name', 'sample_other']) {
    assert.deepEqual(
      ids([
        setting('Webapi/sample_entry/enabled', 'true'),
        setting('Webapi/sample_entry/fields', 'sample_name'),
        { ...setting('Webapi/sample_entry/fields', second), file: 'duplicate.yml' },
      ]),
      ['PP-CONFIG-001', 'PP-CONFIG-001'],
    );
  }
});

test('settings are grouped by website and inactive duplicates are ignored', () => {
  assert.deepEqual(
    ids([
      setting('Webapi/sample_entry/enabled', 'true', { websiteid: 'site-a' }),
      setting('Webapi/sample_entry/fields', 'sample_name', { websiteid: 'site-b' }),
      setting('Webapi/sample_entry/enabled', 'false', { websiteid: 'site-a', statecode: '1' }),
    ]),
    ['PP-API-002'],
  );
});

test('explicit performance and security opt-outs have precise negative controls', () => {
  assert.deepEqual(
    ids([
      setting('Header/OutputCache/Enabled', 'false'),
      setting('Footer/OutputCache/Enabled', false),
      setting('Webapi/error/innererror', true),
      setting('Site/EnableDefaultHtmlEncoding', 'False'),
    ]),
    ['PP-PERF-001', 'PP-PERF-001', 'PP-SEC-001', 'PP-SEC-002'],
  );
  assert.deepEqual(
    ids([
      setting('Header/OutputCache/Enabled', 'true'),
      setting('Webapi/error/innererror', 'false'),
      setting('Site/EnableDefaultHtmlEncoding', 'true'),
    ]),
    [],
  );
});

// @test-kind security: reports contain only registry IDs and anchors, never literal credentials.
test('identity secret review excludes environment references and never exposes their values', () => {
  const secret = 'Invented-credential-9384';
  const result = findings([
    setting('Authentication/OpenIdConnect/Sample/ClientSecret', secret),
    setting('Authentication/Sample/AppSecret', '', {}),
    setting('Authentication/Sample/ConsumerSecret', secret, { source: 1 }),
    setting('Authentication/Other/ClientSecret', secret, { environmentvariableid: 'sample-ref' }),
    setting('Authentication/Placeholder/ClientSecret', '${SAMPLE_SECRET}'),
  ]);
  assert.equal(result.length, 4);
  assert.equal(result[0].id, 'PP-SEC-003');
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.deepEqual(
    result.slice(1).map((finding) => finding.id),
    ['PP-CONFIG-002', 'PP-CONFIG-002', 'PP-CONFIG-002'],
  );
});

test('default web roles are counted per website and ignore inactive records', () => {
  assert.deepEqual(
    ids([
      role('one', { websiteid: 'a', anonymoususersrole: true, authenticatedusersrole: true }),
      role('two', { websiteid: 'a', anonymoususersrole: 'true', authenticatedusersrole: 'true' }),
      role('other-site', { websiteid: 'b', anonymoususersrole: true }),
      role('inactive', { websiteid: 'b', anonymoususersrole: true, statecode: 1 }),
    ]),
    ['PP-ROLE-001', 'PP-ROLE-001', 'PP-ROLE-002', 'PP-ROLE-002'],
  );
});

test('repeated representation of one role is not a duplicate default identity', () => {
  assert.deepEqual(
    ids([
      role('sample-id', { anonymoususersrole: true }),
      { ...role('SAMPLE-ID', { anonymoususersrole: true }), file: 'representation.yml' },
    ]),
    [],
  );
});

test('aggregate records without IDs retain distinct source identities', () => {
  const first = { ...role('', { anonymoususersrole: true }), file: 'roles.yml', line: 2, column: 1 };
  const second = { ...first, line: 8 };
  assert.deepEqual(ids([first, second]), ['PP-ROLE-001', 'PP-ROLE-001']);
});

test('normalized ID fields and website lookups preserve identity and site isolation', () => {
  assert.deepEqual(
    ids([
      role('', { id: 'one', websiteid: { id: 'site-a' }, anonymoususersrole: true }),
      { ...role('', { id: 'ONE', websiteid: { id: 'SITE-A' }, anonymoususersrole: true }), file: 'other.yml' },
      role('', { id: 'two', websiteid: { id: 'site-b' }, anonymoususersrole: true }),
    ]),
    [],
  );
});

test('mixed wildcard tokens warn without matching asterisk-like column strings', () => {
  assert.deepEqual(ids([setting('Webapi/sample_entry/fields', 'sample_name, *')]), ['PP-API-004']);
  assert.deepEqual(ids([setting('Webapi/sample_entry/fields', 'sample_name,sample_*')]), []);
});

test('unknown view flags and non-string field values remain unresolved', () => {
  for (const companion of [
    setting('Webapi/sample_entry/UseFieldsFromView', 'unknown'),
    setting('Webapi/sample_entry/fields', { expression: 'external' }),
  ]) {
    assert.deepEqual(ids([setting('Webapi/sample_entry/enabled', 'true'), companion]), ['PP-CONFIG-002']);
  }
});

test('duplicate views suppress missing-column and published-view conclusions', () => {
  assert.deepEqual(
    ids([
      setting('Webapi/sample_entry/enabled', 'true'),
      setting('Webapi/sample_entry/UseFieldsFromView', 'true'),
      { ...setting('Webapi/sample_entry/UseFieldsFromView', 'false'), file: 'other.yml' },
    ]),
    ['PP-CONFIG-001', 'PP-CONFIG-001'],
  );
});
