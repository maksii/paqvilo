// @test-kind security: report messages refuse a report the caller cannot read or write, with the Web API 403 of that report
// Report messages (dataverse-app-messages.mjs) through the Web API as an admin application and as a Basic User application. The
// admin answers keep their values. A Basic User gets the Web API refusal for an admin-owned report, and its categories stay as they were.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { webApiCall } from './support/dataverse-fixtures.mjs';

const ADMIN_APP = '11111111-1111-4111-8111-111111111111';
const BASIC_APP = '12121212-1212-4121-8121-121212121212';
const ADMIN_SECRET = 'PAQVILO_REPORT_ADMIN_SECRET';
const BASIC_SECRET = 'PAQVILO_REPORT_BASIC_SECRET';
const BODY = '<Report>SALARY QUERY</Report>';

describe('report messages', () => {
  let server, store, tokens, reportId;

  async function bearer(appId, secret) {
    const response = await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: secret,
        scope: `${server.origin}/.default`,
      }),
    });
    return (await response.json()).access_token;
  }

  async function request(who, method, path, body) {
    const headers = {
      authorization: `Bearer ${tokens[who]}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json', prefer: 'return=representation' }),
    };
    return webApiCall(server.origin, 'v9.2', method, path, headers, body);
  }

  const categories = () =>
    store
      .tableRows('reportcategory')
      .filter((row) => String(row.reportid).toLowerCase() === reportId)
      .map((row) => row.categorycode)
      .sort((a, b) => a - b);

  before(async () => {
    process.env[ADMIN_SECRET] = 'report-admin-secret';
    process.env[BASIC_SECRET] = 'report-basic-secret';
    store = await new DataStore({ state: emptyState() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: ADMIN_APP,
          displayName: 'Report admin',
          secretEnvironmentVariable: ADMIN_SECRET,
          roles: ['System Administrator'],
        },
        {
          appId: BASIC_APP,
          displayName: 'Report basic',
          secretEnvironmentVariable: BASIC_SECRET,
          roles: ['Basic User'],
        },
      ],
    });
    server = await startDataverseApi({ store, settings, log: () => {} });
    tokens = {
      admin: await bearer(ADMIN_APP, 'report-admin-secret'),
      basic: await bearer(BASIC_APP, 'report-basic-secret'),
    };
    const created = await request('admin', 'POST', 'reports', { name: 'Payroll', bodytext: BODY, reporttypecode: 1 });
    assert.equal(created.status, 201, created.text);
    reportId = created.json.reportid.toLowerCase();
    const seeded = await request('admin', 'POST', 'SetReportRelated', {
      ReportId: reportId,
      Entities: [],
      Categories: [1, 2],
      Visibility: [],
    });
    assert.equal(seeded.status, 204, seeded.text);
  });

  after(async () => {
    delete process.env[ADMIN_SECRET];
    delete process.env[BASIC_SECRET];
    await server?.close();
  });

  it('DownloadReportDefinition answers an admin with the definition of the report', async () => {
    const response = await request(
      'admin',
      'GET',
      `reports(${reportId})/Microsoft.Dynamics.CRM.DownloadReportDefinition()`,
    );
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.BodyText, BODY);
  });

  it('GetReportHistoryLimit answers an admin with the stand-in limit of 0', async () => {
    const response = await request(
      'admin',
      'GET',
      `reports(${reportId})/Microsoft.Dynamics.CRM.GetReportHistoryLimit()`,
    );
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.HistoryLimit, 0);
  });

  it('SetReportRelated stores the categories of the report for an admin', async () => {
    const response = await request('admin', 'POST', 'SetReportRelated', {
      ReportId: reportId,
      Entities: [],
      Categories: [3],
      Visibility: [],
    });
    assert.equal(response.status, 204, response.text);
    assert.deepEqual(categories(), [3]);
  });

  it('a Basic User cannot download the definition of an admin-owned report: the message answers the Web API 403', async () => {
    const direct = await request('basic', 'GET', `reports(${reportId})?$select=name`);
    assert.equal(direct.status, 403, direct.text);
    const response = await request(
      'basic',
      'GET',
      `reports(${reportId})/Microsoft.Dynamics.CRM.DownloadReportDefinition()`,
    );
    assert.equal(response.status, 403, response.text);
    assert.equal(response.json.error.code, direct.json.error.code);
    assert.doesNotMatch(response.text, /SALARY QUERY/);
  });

  it('a Basic User cannot read the history limit of an admin-owned report: the message answers the Web API 403', async () => {
    const direct = await request('basic', 'GET', `reports(${reportId})?$select=name`);
    const response = await request(
      'basic',
      'GET',
      `reports(${reportId})/Microsoft.Dynamics.CRM.GetReportHistoryLimit()`,
    );
    assert.equal(response.status, 403, response.text);
    assert.equal(response.json.error.code, direct.json.error.code);
  });

  it('a Basic User cannot set the categories of an admin-owned report: SetReportRelated answers 403 and changes no category', async () => {
    const direct = await request('basic', 'GET', `reports(${reportId})?$select=name`);
    const before = categories();
    const response = await request('basic', 'POST', 'SetReportRelated', {
      ReportId: reportId,
      Entities: [],
      Categories: [4],
      Visibility: [],
    });
    assert.equal(response.status, 403, response.text);
    assert.equal(response.json.error.code, direct.json.error.code);
    assert.deepEqual(categories(), before);
  });
});
