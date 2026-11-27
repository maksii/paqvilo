// @test-kind contract: the activity timeline reads its activities through the same paged provider reader as the notes service: a provider page that cannot be continued answers 502 TimelineProviderPagingInvalid, and a record with more activities than the per-record memory bound answers 503 TimelineRowLimitExceeded with a diagnostic, never a partial list or total
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { handleNativeService } from '../lib/native-services.mjs';
import { serveRoutes } from './support/route-server.mjs';

const id = (n) => `03000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const website = id(100);
const reader = id(101);
const record = id(1);

async function timelineFixture(t, alter) {
  const state = emptyState();
  state.mappings = {
    pqx_case: { logicalName: 'pqx_case', entitySet: 'pqx_cases', idColumn: 'pqx_caseid', nameColumn: 'pqx_name' },
    contact: { logicalName: 'contact', entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
    phonecall: { logicalName: 'phonecall', entitySet: 'phonecalls', idColumn: 'activityid', nameColumn: 'subject' },
  };
  state.tables.pqx_case = [{ pqx_caseid: record, pqx_name: 'Invented case' }];
  state.tables.contact = [{ contactid: reader, fullname: 'Reader' }];
  state.tables.phonecall = [];
  state.permissions = ['pqx_case', 'phonecall'].map((entity) => ({
    entity,
    scope: 'global',
    roles: ['Reader'],
    operations: ['read'],
  }));
  state.settings.permissionMode = 'enforce';
  const store = await new DataStore({ state }).init();
  const identity = { contactId: reader, id: reader, roles: ['Reader'] };
  const diagnostics = [];
  const pages = [];
  const context = {
    store,
    identity,
    csrf: 'page-token',
    portal: { website: { id: website }, settings: {} },
    metadata: { views: [] },
    recordDiagnostic: (entry) => diagnostics.push(entry),
    readProvider: {
      get: (entity, recordId, caller) => store.get(entity, recordId, caller, { portalRequest: true }),
      fetchXml(xml) {
        pages.push(xml);
        return alter(pages.length);
      },
    },
  };
  const origin = await serveRoutes(t, (req, res, url) => handleNativeService(req, res, url, context));
  const timeline = () =>
    fetch(`${origin}/_portal/${website}/EntityActivity/GetActivities`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', __RequestVerificationToken: context.csrf },
      body: JSON.stringify({ regarding: { LogicalName: 'pqx_case', Id: record }, page: 1 }),
    });
  return { timeline, pages, diagnostics };
}

// One provider page of `size` phone calls regarding the record, keyed by the page number.
const activities = (page, size) =>
  Array.from({ length: size }, (_, index) => ({
    activityid: `04${String(page).padStart(6, '0')}-0000-4000-8000-${String(index).padStart(12, '0')}`,
    subject: `Call ${page}.${index}`,
    regardingobjectid: { id: record, logical_name: 'pqx_case' },
    createdon: '2026-01-01T00:00:00Z',
  }));

test('a repeated provider paging cookie answers 502 TimelineProviderPagingInvalid without a partial list', async (t) => {
  const { timeline, pages } = await timelineFixture(t, (page) => ({
    entities: activities(page, 2),
    more_records: true,
    paging_cookie: 'invented-cookie',
  }));
  const response = await timeline();
  assert.equal(response.status, 502);
  const error = await response.json();
  assert.equal(error.InnerError.Code, 'TimelineProviderPagingInvalid');
  assert.match(error.Message, /cookie is missing or repeated/);
  assert.equal(Object.hasOwn(error, 'Records'), false);
  assert.equal(Object.hasOwn(error, 'ItemCount'), false);
  assert.equal(pages.length, 2);
});

test('a record with more activities than the memory bound answers 503 TimelineRowLimitExceeded with a diagnostic', async (t) => {
  // Full pages of 5,000 activities, eleven of them (55,000 rows) before the provider would stop.
  const { timeline, pages, diagnostics } = await timelineFixture(t, (page) => ({
    entities: activities(page, 5000),
    more_records: page < 12,
    paging_cookie: `invented-cookie-${page}`,
  }));
  const response = await timeline();
  assert.equal(response.status, 503);
  const error = await response.json();
  assert.equal(error.InnerError.Code, 'TimelineRowLimitExceeded');
  assert.equal(Object.hasOwn(error, 'Records'), false);
  assert.equal(pages.length, 11);
  assert.deepEqual(
    diagnostics.filter(({ code }) => code === 'TimelineRowLimitExceeded').map(({ severity }) => severity),
    ['warning'],
  );
  assert.match(
    diagnostics.find(({ code }) => code === 'TimelineRowLimitExceeded').message,
    /more than 50,000 activities/,
  );
});
