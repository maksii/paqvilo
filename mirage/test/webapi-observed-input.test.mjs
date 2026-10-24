import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { likeMatcher } from '../lib/dataverse-values.mjs';
import { parseODataExpression } from '../lib/odata-query.mjs';
import { webApiErrorResponse } from '../lib/webapi-handler.mjs';
import { DataError } from '../lib/data.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';

const G = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const observed = {
  webApiCdsErrorMessage: 'Common Data Service error occurred.',
  webApiAntiForgery: 'decryption-401',
  webApiReferenceErrors: 'unexpected',
  webApiInvalidDate: 'crm-minimum',
  webApiInnerError: 'all-errors',
  headers: { webApi: { 'cache-control': 'no-cache, no-store, must-revalidate' } },
  evidence: 'Synthetic loopback fixture for selectable observed response contracts',
};

test('observed failed date conversion reports the CRM minimum error without a fabricated exception type', () => {
  const failure = new DataError('Invalid date', 400, 'InvalidDateTime', {
    innerCode: '0x80040239',
    failedDateConversion: true,
  });
  const response = webApiErrorResponse(failure, {
    innerError: true,
    innerErrorScope: 'all-errors',
    invalidDate: 'crm-minimum',
  });
  assert.equal(response.body.error.innererror.code, '0x80040239');
  assert.equal(
    response.body.error.innererror.message,
    'DateTime is less than minumum value supported by CrmDateTime. Actual value: 01/01/0001 00:00:00, Minimum value supported: 01/01/1753 00:00:00',
  );
  assert.equal(Object.hasOwn(response.body.error.innererror, 'type'), false);
  assert.equal(
    webApiErrorResponse(failure, { innerError: true }).body.error.innererror.message,
    'Invalid date',
    'default retains its supported error contract',
  );
});

test('SQL bracket patterns and OData quoted values preserve the distinct wire grammars', () => {
  assert.equal(likeMatcher('%[[]1]%')('value [1]'), true);
  assert.equal(likeMatcher('%[[]1[]]%')('value [1]'), false);
  assert.equal(likeMatcher('%[]]%')('value ]'), false);
  assert.equal(likeMatcher('%[1]%')('value 1'), true);
  assert.equal(likeMatcher('%[_]%')('value _'), true);
  assert.throws(() => parseODataExpression('contains(title,"value")'), /single quotes/);
  assert.doesNotThrow(() =>
    parseODataExpression('Microsoft.Dynamics.CRM.In(PropertyName=\'title\',PropertyValues=["one","two"])'),
  );
  assert.equal(parseODataExpression('"value"', { dialect: 'extended' }).value, 'value');
});

test('observed API errors retain rejection and atomicity without contacting bound origins', async (t) => {
  const source = await fs.mkdtemp(path.join(os.tmpdir(), 'mirage-observed-input-'));
  ownedFixture(t).remove(() => fs.rm(source, { recursive: true, force: true }));
  await fs.writeFile(
    path.join(source, 'website.yml'),
    'adx_websiteid: invented-observation\nadx_name: Input observation\n',
  );
  await fs.writeFile(
    path.join(source, 'sitesetting.yml'),
    '- adx_name: Webapi/probe/enabled\n  adx_value: "true"\n- adx_name: Webapi/probe/fields\n  adx_value: "probeid,title,category,parentid"\n- adx_name: Webapi/error/innererror\n  adx_value: "true"\n',
  );
  const app = await createSimulator({
    sourceDir: source,
    watch: false,
    observed,
    initial: {
      mappings: {
        probe: {
          entitySet: 'probes',
          idColumn: 'probeid',
          schemaComplete: true,
          alternateKeys: [{ attributes: ['title'] }],
          fields: {
            probeid: { dataverseType: 'uniqueidentifier', validForUpdate: false },
            title: { dataverseType: 'nvarchar', maxLength: 20 },
            category: { dataverseType: 'picklist', options: [{ value: 1, label: 'One' }] },
            parentid: { dataverseType: 'lookup', targets: ['probe'] },
          },
          relationships: { parentid: { entity: 'probe', from: 'parentid', to: 'probeid', many: false } },
        },
      },
      tables: {
        probe: [
          { probeid: G(1), title: 'Original', versionnumber: 1 },
          { probeid: G(3), title: 'Lookup target', versionnumber: 1 },
        ],
      },
      settings: { permissionMode: 'permissive' },
    },
  });
  ownedFixture(t).add(() => app.close());
  const baseline = app.store.snapshot().tables;
  const route = '/_api/probes(' + G(1) + ')';
  async function send(body, { token = app.csrf, raw } = {}) {
    const r = await fetch(app.url + route, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', ...(token == null ? {} : { __RequestVerificationToken: token }) },
      body: raw ?? JSON.stringify(body),
    });
    return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') };
  }
  for (const [body, status, code] of [
    [{ unknown: 'x' }, 403, '90040101'],
    [{ category: { value: 1 } }, 403, '90040101'],
    [{ title: { value: 'x' } }, 403, '90040101'],
    [{ probeid: 'not-guid' }, 400, '9004010D'],
    [{ 'parentid@odata.bind': null }, 500, '9004010A'],
    [{ 'parentid@odata.bind': '/probes(not-guid)' }, 500, '9004010A'],
    [{ 'parentid@odata.bind': 'https://example.invalid/probes(' + G(2) + ')' }, 500, '9004010A'],
    [{ 'parentid@odata.bind': '/probes(' + G(2) + ')' }, 404, '9004010D'],
  ]) {
    const r = await send(body);
    assert.equal(r.status, status, JSON.stringify(body));
    assert.equal(r.body.error.code, code);
    assert.equal(r.cache, 'no-cache, no-store, must-revalidate');
    if (status >= 400 && code === '9004010D') assert.equal(r.body.error.message, observed.webApiCdsErrorMessage);
    if (Object.keys(body)[0].endsWith('@odata.bind')) assert.equal(Object.hasOwn(r.body.error, 'innererror'), false);
    assert.deepEqual(app.store.snapshot().tables, baseline);
  }
  for (const token of [null, 'invalid']) {
    const r = await send({ title: 'Rejected' }, { token });
    assert.equal(r.status, 401);
    assert.equal(r.body.error.code, '90040107');
    assert.match(r.body.error.message, /^Request validation failed : /);
    assert.equal(r.body.error.innererror.message, r.body.error.message);
    assert.deepEqual(app.store.snapshot().tables, baseline);
  }
  const empty = await send(null, { raw: '' });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error.innererror.message, 'Passed entity object cannot be null or empty.');
  assert.deepEqual(app.store.snapshot().tables, baseline);
  assert.equal(empty.body.error.innererror.code, '0x80072530');
  assert.equal(
    Object.hasOwn(empty.body.error.innererror, 'type'),
    false,
    'Dataverse details do not acquire a portal exception type',
  );
  const missingKey = await send({ 'parentid@odata.bind': "/probes(title='Missing')" });
  assert.equal(missingKey.status, 404);
  assert.deepEqual(app.store.snapshot().tables, baseline);
  const bound = await fetch(app.url + route, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', __RequestVerificationToken: app.csrf },
    body: JSON.stringify({ 'parentid@odata.bind': "/probes(title='Lookup target')" }),
  });
  assert.equal(bound.status, 204);
  const record = await fetch(app.url + route + '?$select=_parentid_value', {
    headers: { __RequestVerificationToken: app.csrf },
  });
  assert.equal(
    (await record.json())._parentid_value,
    G(3),
    'observed reference checks retain declared alternate-key bindings',
  );
});
