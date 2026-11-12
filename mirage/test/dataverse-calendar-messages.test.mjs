// Simulated Dataverse time zone, calendar, app and report messages: happy paths, the documented scheduling refusal, a privilege
// denial, DST boundary conversion, a weekly series with an exception, and a Book conflict.
// @test-kind contract: Paqvilo's own designed calendar, time zone and scheduling behaviour, with its rank trimming checked against a reference
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { seed as seedStandard } from '../lib/dataverse-standard.mjs';
import { ensureSecurityModel, createPrincipals } from '../lib/dataverse-security.mjs';
import { createOperationRegistry } from '../lib/dataverse-operations.mjs';
import { createRecordHandlers } from '../lib/dataverse-records.mjs';
import { createChangeLog } from '../lib/dataverse-changes.mjs';
import { runAtomic } from '../lib/dataverse-api.mjs';
import { install as installCalendar } from '../lib/dataverse-calendar-messages.mjs';
import { install as installApps } from '../lib/dataverse-app-messages.mjs';
import {
  disjointSpans,
  intersectSpans,
  offsetMinutes,
  subtractSpans,
  trimByRank,
} from '../lib/dataverse-calendar-messages.mjs';
import { TIME_ZONE_DEFINITIONS, TIME_ZONE_IDS } from '../lib/platform-time-zones.mjs';

const ORIGIN = 'http://127.0.0.1:5555';
const ORG = '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const ADMIN_OID = 'aaaaaaaa-0000-4000-8000-000000000001';
const NOROLE_OID = 'aaaaaaaa-0000-4000-8000-000000000003';
const RESOURCE = '33333333-3333-4333-8333-333333333333';
const OTHER = '44444444-4444-4444-8444-444444444444';
const APP = '55555555-5555-4555-8555-555555555555';
const REPORT = '66666666-6666-4666-8666-666666666666';
const UNKNOWN = '11111111-1111-4111-8111-111111111111';
const CLOCK = Date.parse('2026-10-20T09:00:00Z');
const SETTINGS = {
  organizationId: ORG,
  tenantId: 'tenant-test',
  uniqueName: 'testorg',
  friendlyName: 'Test Org',
  version: '9.2.25041.00000',
  users: [
    { objectId: ADMIN_OID, upn: 'admin@example.test', displayName: 'Admin', roles: ['System Administrator'] },
    { objectId: NOROLE_OID, upn: 'norole@example.test', displayName: 'No Role', roles: [] },
  ],
};

async function setup() {
  const store = new DataStore({ state: emptyState() });
  await store.transact(() => seedStandard(store));
  await ensureSecurityModel(store, SETTINGS);
  const principals = createPrincipals(store, SETTINGS);
  const changes = createChangeLog(store);
  const records = createRecordHandlers({
    store,
    change: (fn) => fn(),
    principals,
    metadataFields: () => undefined,
    changes,
  });
  const api = {
    store,
    change: (fn) => fn(),
    registry: createOperationRegistry(),
    principals,
    metadata: null,
    metadataFields: () => undefined,
    records,
    changes,
    settings: SETTINGS,
    clock: () => CLOCK,
    log: () => {},
  };
  api.runAtomic = (fn) => runAtomic(api, fn);
  await installCalendar(api);
  await installApps(api);
  return { store, api, admin: principals.byObjectId(ADMIN_OID), norole: principals.byObjectId(NOROLE_OID) };
}

// Calls a registered operation the way the router does: parameters for functions, the body for actions, the target when bound.
async function invoke(api, name, { kind = 'function', binding = 'unbound', entity, user, target, params, body } = {}) {
  const op = api.registry.find({ name, kind, binding, entity });
  assert.ok(op, `${name} is registered`);
  return op.handle({
    user,
    caller: null,
    target,
    params,
    body,
    identity: { admin: true },
    origin: ORIGIN,
    version: 'v9.2',
    url: new URL(`${ORIGIN}/api/data/v9.2/${name}`),
  });
}
const action = (api, name, args) => invoke(api, name, { kind: 'action', ...args });
const refused = (e) => e.status === 400 && e.details?.innerCode === '0x80040203';
const scheduling = (e) => e.status === 400 && e.details?.innerCode === '0x80060914';

const rows = (t, logical) => t.store.state.tables[logical] ?? [];
const busy = async (t, from, to) => {
  const response = await invoke(t.api, 'QuerySchedule', {
    user: t.admin,
    params: { ResourceId: RESOURCE, Start: from, End: to, TimeCodes: ['Busy'] },
  });
  return response.body.TimeInfos;
};

// A weekly series on Mondays and Wednesdays from Monday 2 November 2026 (UTC zone), four occurrences, 09:00 to 10:00.
const weekly = (overrides = {}) => ({
  subject: 'Standup',
  recurrencepatterntype: 1,
  interval: 1,
  daysofweekmask: 10,
  firstdayofweek: 0,
  patternstartdate: '2026-11-02T00:00:00Z',
  starttime: '2026-11-02T09:00:00Z',
  endtime: '2026-11-02T10:00:00Z',
  duration: 60,
  patternendtype: 2,
  occurrences: 4,
  utcconversiontimezonecode: 92,
  requiredattendees: [RESOURCE],
  ...overrides,
});

test('LocalTimeFromUtcTime converts across the US and EU DST boundaries', async () => {
  const t = await setup();
  const local = async (code, utc) =>
    (await invoke(t.api, 'LocalTimeFromUtcTime', { user: t.admin, params: { TimeZoneCode: code, UtcTime: utc } })).body
      .LocalTime;
  // New York (35) springs forward at 02:00 local on 8 March 2026 and falls back on 1 November 2026.
  assert.equal(await local(35, '2026-03-08T06:59:59Z'), '2026-03-08T01:59:59-05:00');
  assert.equal(await local(35, '2026-03-08T07:00:00Z'), '2026-03-08T03:00:00-04:00');
  assert.equal(await local(35, '2026-11-01T05:59:59Z'), '2026-11-01T01:59:59-04:00');
  assert.equal(await local(35, '2026-11-01T06:00:00Z'), '2026-11-01T01:00:00-05:00');
  // London (85) changes on 29 March 2026 at 01:00 UTC.
  assert.equal(await local(85, '2026-03-29T00:59:59Z'), '2026-03-29T00:59:59+00:00');
  assert.equal(await local(85, '2026-03-29T01:00:00Z'), '2026-03-29T02:00:00+01:00');
  // UTC (92) has no offset.
  assert.equal(await local(92, '2026-07-01T12:00:00Z'), '2026-07-01T12:00:00+00:00');
});

test('LocalTimeFromUtcTime refuses a time zone code outside the seeded subset', async () => {
  const t = await setup();
  await assert.rejects(
    invoke(t.api, 'LocalTimeFromUtcTime', {
      user: t.admin,
      params: { TimeZoneCode: 999, UtcTime: '2026-07-01T12:00:00Z' },
    }),
    refused,
  );
});

test('time zone rows are seeded with their standard names and found by name', async () => {
  const t = await setup();
  assert.equal(rows(t, 'timezonedefinition').length, 133);
  assert.equal(rows(t, 'timezonerule').length, 0, 'the deprecated rule table is not seeded');
  const found = await invoke(t.api, 'GetTimeZoneCodeByLocalizedName', {
    user: t.admin,
    params: { LocalizedStandardName: 'Eastern Standard Time', LocaleId: 1033 },
  });
  assert.equal(found.body.TimeZoneCode, 35);
  await assert.rejects(
    invoke(t.api, 'GetTimeZoneCodeByLocalizedName', {
      user: t.admin,
      params: { LocalizedStandardName: 'Nowhere Standard Time', LocaleId: 1033 },
    }),
    (e) => e.status === 404,
  );
  const all = await invoke(t.api, 'GetAllTimeZonesWithDisplayName', {
    user: t.admin,
    binding: 'collection',
    entity: 'timezonedefinition',
    params: { LocaleId: 1033 },
  });
  assert.equal(all.body.value.length, 133);
  assert.ok(all.body.value.every((entry) => Object.keys(entry).join() === 'userinterfacename'));
});

test('a weekly series with an exception: Book, QuerySchedule, CreateInstance, CreateException and DeleteOpenInstances', async () => {
  const t = await setup();
  const booked = await action(t.api, 'Book', { user: t.admin, body: weekly() });
  assert.equal(booked.body.ValidationResult.ValidationSuccess, true);
  assert.equal(rows(t, 'recurringappointmentmaster').length, 1);
  assert.equal(rows(t, 'recurrencerule').length, 1);

  // Mondays and Wednesdays: 2, 4, 9 and 11 November, the series' four occurrences.
  let blocks = await busy(t, '2026-11-01T00:00:00Z', '2026-11-15T00:00:00Z');
  assert.deepEqual(
    blocks.map((block) => block.Start),
    ['2026-11-02T09:00:00.000Z', '2026-11-04T09:00:00.000Z', '2026-11-09T09:00:00.000Z', '2026-11-11T09:00:00.000Z'],
  );

  // Materialise the first three instances, then make the 9 November instance an exception moved to 14:00.
  const master = rows(t, 'recurringappointmentmaster')[0];
  await action(t.api, 'CreateInstance', { user: t.admin, body: { Target: { id: master.activityid }, Count: 3 } });
  assert.equal(rows(t, 'appointment').length, 3);
  const nov9 = rows(t, 'appointment').find((row) => row.scheduledstart === '2026-11-09T09:00:00.000Z');
  assert.ok(nov9, 'the 9 November instance is materialised');
  // The transaction may replace the state, so the row is read again after each write.
  const moveTo = (id, start, end) =>
    t.store.transact(() => {
      const row = rows(t, 'appointment').find((entry) => entry.activityid === id);
      row.scheduledstart = start;
      row.scheduledend = end;
    });
  await moveTo(nov9.activityid, '2026-11-09T14:00:00.000Z', '2026-11-09T15:00:00.000Z');
  const exception = await action(t.api, 'CreateException', {
    user: t.admin,
    binding: 'collection',
    entity: 'recurringappointmentmaster',
    body: { Target: { id: nov9.activityid }, OriginalStartDate: '2026-11-09T09:00:00Z', IsDeleted: false },
  });
  assert.equal(exception.body.id, nov9.activityid);
  assert.equal(rows(t, 'appointment').find((entry) => entry.activityid === nov9.activityid).instancetypecode, 3);

  // Delete the 4 November occurrence from the series: its start is recorded and its instance row goes.
  const nov4 = rows(t, 'appointment').find((row) => row.scheduledstart === '2026-11-04T09:00:00.000Z');
  await action(t.api, 'CreateException', {
    user: t.admin,
    binding: 'collection',
    entity: 'recurringappointmentmaster',
    body: { Target: { id: nov4.activityid }, OriginalStartDate: '2026-11-04T09:00:00Z', IsDeleted: true },
  });
  assert.equal(rows(t, 'appointment').length, 2);
  blocks = await busy(t, '2026-11-01T00:00:00Z', '2026-11-15T00:00:00Z');
  assert.deepEqual(
    blocks.map((block) => block.Start),
    ['2026-11-02T09:00:00.000Z', '2026-11-09T14:00:00.000Z', '2026-11-11T09:00:00.000Z'],
  );

  // Open instances starting on or after the series end go: the moved 9 November instance goes, the 2 November one stays.
  await action(t.api, 'DeleteOpenInstances', {
    user: t.admin,
    body: { Target: { id: master.activityid }, SeriesEndDate: '2026-11-09T00:00:00Z', StateOfPastInstances: 1 },
  });
  assert.deepEqual(
    rows(t, 'appointment').map((row) => row.scheduledstart),
    ['2026-11-02T09:00:00.000Z'],
  );
});

test('Book refuses a conflicting appointment without writing it, and an invalid time with 0x80060914', async () => {
  const t = await setup();
  const first = await action(t.api, 'Book', {
    user: t.admin,
    body: {
      subject: 'Review',
      scheduledstart: '2026-11-20T10:00:00Z',
      scheduledend: '2026-11-20T11:00:00Z',
      requiredattendees: [RESOURCE],
    },
  });
  assert.equal(first.body.ValidationResult.ValidationSuccess, true);
  assert.equal(rows(t, 'appointment').length, 1);

  const clash = await action(t.api, 'Book', {
    user: t.admin,
    body: {
      subject: 'Clash',
      scheduledstart: '2026-11-20T10:30:00Z',
      scheduledend: '2026-11-20T11:30:00Z',
      requiredattendees: [RESOURCE],
    },
  });
  assert.equal(clash.body.ValidationResult.ValidationSuccess, false);
  assert.equal(clash.body.ValidationResult.TraceInfo.ErrorInfoList[0].ResourceList[0].ResourceId, RESOURCE);
  assert.equal(rows(t, 'appointment').length, 1, 'a conflicting booking writes nothing');

  // A different resource is free at the same time.
  const free = await action(t.api, 'Book', {
    user: t.admin,
    body: {
      subject: 'Other',
      scheduledstart: '2026-11-20T10:30:00Z',
      scheduledend: '2026-11-20T11:30:00Z',
      requiredattendees: [OTHER],
    },
  });
  assert.equal(free.body.ValidationResult.ValidationSuccess, true);

  await assert.rejects(
    action(t.api, 'Book', {
      user: t.admin,
      body: { subject: 'Reversed', scheduledstart: '2026-11-21T11:00:00Z', scheduledend: '2026-11-21T10:00:00Z' },
    }),
    scheduling,
  );
});

test('Reschedule moves an appointment when it is free, and Validate reports its own time as valid', async () => {
  const t = await setup();
  const booked = await action(t.api, 'Book', {
    user: t.admin,
    body: {
      activityid: '77777777-7777-4777-8777-777777777777',
      subject: 'Move me',
      scheduledstart: '2026-11-22T10:00:00Z',
      scheduledend: '2026-11-22T11:00:00Z',
      requiredattendees: [RESOURCE],
    },
  });
  const id = booked.body.ValidationResult.ActivityId;
  const moved = await action(t.api, 'Reschedule', {
    user: t.admin,
    body: { Target: { id }, scheduledstart: '2026-11-22T12:00:00Z', scheduledend: '2026-11-22T13:00:00Z' },
  });
  assert.equal(moved.body.ValidationResult.ValidationSuccess, true);
  assert.equal(rows(t, 'appointment')[0].scheduledstart, '2026-11-22T12:00:00.000Z');
  const validated = await action(t.api, 'Validate', { user: t.admin, body: { Activities: [{ activityid: id }] } });
  assert.equal(validated.body.Result[0].ValidationSuccess, true);
  await assert.rejects(
    action(t.api, 'Validate', { user: t.admin, body: { Activities: [{ activityid: UNKNOWN }] } }),
    (e) => e.status === 404,
  );
});

test('AddRecurrence turns an appointment into the first instance of a series', async () => {
  const t = await setup();
  const booked = await action(t.api, 'Book', {
    user: t.admin,
    body: {
      activityid: '88888888-8888-4888-8888-888888888888',
      subject: 'Sync',
      scheduledstart: '2026-11-23T08:00:00Z',
      scheduledend: '2026-11-23T08:30:00Z',
      requiredattendees: [RESOURCE],
    },
  });
  const id = booked.body.ValidationResult.ActivityId;
  const master = await invoke(t.api, 'AddRecurrence', {
    kind: 'action',
    binding: 'entity',
    entity: 'appointment',
    user: t.admin,
    target: { id },
    body: {
      Target: {
        recurrencepatterntype: 0,
        interval: 1,
        patternendtype: 1,
        patternstartdate: '2026-11-23T08:00:00Z',
        starttime: '2026-11-23T08:00:00Z',
        endtime: '2026-11-23T08:30:00Z',
        duration: 30,
        utcconversiontimezonecode: 92,
      },
    },
  });
  assert.equal(master.status, 200);
  const appointment = rows(t, 'appointment')[0];
  assert.equal(appointment.seriesid, master.body.activityid);
  assert.equal(appointment.instancetypecode, 2);
});

test('ValidateRecurrenceRule accepts a valid rule and refuses a weekly rule with no days', async () => {
  const t = await setup();
  const valid = await invoke(t.api, 'ValidateRecurrenceRule', {
    user: t.admin,
    params: { Target: { recurrencepatterntype: 1, interval: 2, daysofweekmask: 2, patternendtype: 1 } },
  });
  assert.equal(valid.body.Description, 'Every 2 weeks');
  await assert.rejects(
    invoke(t.api, 'ValidateRecurrenceRule', {
      user: t.admin,
      params: { Target: { recurrencepatterntype: 1, interval: 1, daysofweekmask: 0, patternendtype: 1 } },
    }),
    refused,
  );
});

// @test-kind security: a user without privileges cannot book
test('a user with no privileges is refused a booking', async () => {
  const t = await setup();
  await assert.rejects(
    action(t.api, 'Book', {
      user: t.norole,
      body: { subject: 'No', scheduledstart: '2026-11-24T10:00:00Z', scheduledend: '2026-11-24T11:00:00Z' },
    }),
    (e) => e.status === 403 && e.code === 'PrivilegeDenied',
  );
  assert.equal(rows(t, 'appointment').length, 0);
});

test('app components are listed, validated and removed; a missing app is not found', async () => {
  const t = await setup();
  await t.store.transact(() => {
    rows(t, 'appmodule').push({ appmoduleid: APP, appmoduleidunique: APP, uniquename: 'contoso_sales', name: 'Sales' });
    rows(t, 'appmodulecomponent').push(
      {
        appmodulecomponentid: 'aaaaaaa1-0000-4000-8000-000000000001',
        appmoduleidunique: APP,
        objectid: 'bbbbbbb1-0000-4000-8000-000000000001',
        componenttype: 1,
      },
      {
        appmodulecomponentid: 'aaaaaaa1-0000-4000-8000-000000000002',
        appmoduleidunique: APP,
        objectid: 'bbbbbbb1-0000-4000-8000-000000000002',
        componenttype: 26,
      },
    );
  });
  const listed = await invoke(t.api, 'RetrieveAppComponents', { user: t.admin, params: { AppModuleId: APP } });
  assert.equal(listed.body.value.length, 2);
  const validated = await invoke(t.api, 'ValidateApp', { user: t.admin, params: { AppModuleId: APP } });
  assert.equal(validated.body.AppValidationResponse.ValidationSuccess, true);
  await invoke(t.api, 'RemoveAppComponents', {
    kind: 'action',
    user: t.admin,
    body: { AppId: APP, Components: [{ objectid: 'bbbbbbb1-0000-4000-8000-000000000001' }] },
  });
  assert.equal(rows(t, 'appmodulecomponent').length, 1);
  await assert.rejects(
    invoke(t.api, 'RetrieveAppComponents', { user: t.admin, params: { AppModuleId: UNKNOWN } }),
    (e) => e.status === 404,
  );
});

test('AddAppComponents validates the whole batch, adds source views once, and checks app write access', async () => {
  const t = await setup();
  const viewId = 'bbbbbbb1-0000-4000-8000-000000000003';
  await t.store.transact(() => {
    rows(t, 'appmodule').push({ appmoduleid: APP, appmoduleidunique: APP, name: 'Invented app' });
    rows(t, 'savedquery').push({ savedqueryid: viewId, name: 'Invented view', returnedtypecode: 'account' });
  });
  const payload = {
    AppId: APP,
    Components: [{ '@odata.type': 'Microsoft.Dynamics.CRM.savedquery', savedqueryid: viewId }],
  };
  await assert.rejects(
    action(t.api, 'AddAppComponents', {
      user: t.admin,
      body: { ...payload, Components: [...payload.Components, { componenttype: 26, objectid: UNKNOWN }] },
    }),
    (error) => error.status === 404,
  );
  assert.equal(rows(t, 'appmodulecomponent').length, 0);
  assert.equal((await action(t.api, 'AddAppComponents', { user: t.admin, body: payload })).status, 204);
  await action(t.api, 'AddAppComponents', { user: t.admin, body: payload });
  assert.equal(rows(t, 'appmodulecomponent').length, 1);
  assert.equal(rows(t, 'appmodulecomponent')[0].objectid, viewId);
  await assert.rejects(
    action(t.api, 'AddAppComponents', { user: t.norole, body: payload }),
    (error) => error.status === 403,
  );
});

test('report definitions are returned as stored; SetReportRelated checks its code lists', async () => {
  const t = await setup();
  await t.store.transact(() =>
    rows(t, 'report').push({ reportid: REPORT, name: 'Contoso pipeline', bodytext: '<Report/>' }),
  );
  const definition = await invoke(t.api, 'DownloadReportDefinition', {
    user: t.admin,
    binding: 'entity',
    entity: 'report',
    target: { id: REPORT },
  });
  assert.equal(definition.body.BodyText, '<Report/>');
  const history = await invoke(t.api, 'GetReportHistoryLimit', {
    user: t.admin,
    binding: 'entity',
    entity: 'report',
    target: { id: REPORT },
  });
  assert.equal(history.body.HistoryLimit, 0);
  const related = await action(t.api, 'SetReportRelated', {
    user: t.admin,
    body: { ReportId: REPORT, Entities: [2], Categories: [], Visibility: [0] },
  });
  assert.equal(related.status, 204);
  await assert.rejects(
    action(t.api, 'SetReportRelated', {
      user: t.admin,
      body: { ReportId: REPORT, Entities: ['x'], Categories: [], Visibility: [] },
    }),
    refused,
  );
});

// Working hours, 09:00 to 17:00 UTC on weekdays, as an outer calendar's weekly rule through an inner calendar.
const OUTER = '77777777-7777-4777-8777-777777777777';
const INNER = '88888888-8888-4888-8888-888888888888';
const CALENDAR_RESOURCE = '99999999-9999-4999-8999-999999999999';
const MON = '2026-11-02T00:00:00Z';
const WEEK_END = '2026-11-09T00:00:00Z';
async function workingHours(t, resourceIds) {
  const table = (name) => (t.store.state.tables[name] ??= []);
  await t.store.transact(() => {
    table('calendar').push({ calendarid: OUTER, timezonecode: 92 }, { calendarid: INNER, timezonecode: 92 });
    table('calendarrule').push(
      {
        calendarruleid: 'a1000000-0000-4000-8000-000000000001',
        calendarid: INNER,
        offset: 540,
        duration: 480,
        timecode: 0,
        name: 'Hours',
      },
      {
        calendarruleid: 'a1000000-0000-4000-8000-000000000002',
        calendarid: OUTER,
        pattern: 'FREQ=WEEKLY;INTERVAL=1;BYDAY=MO,TU,WE,TH,FR',
        innercalendarid: INNER,
        timezonecode: 92,
      },
    );
    for (const id of resourceIds)
      table('systemuser').push({ systemuserid: id, fullname: `User ${id.slice(0, 4)}`, calendarid: OUTER });
  });
}

test('every seeded time zone converts; Romance Standard Time matches Europe/Paris and the offsets match the display names', async () => {
  const t = await setup();
  for (const [code] of TIME_ZONE_IDS) {
    const local = await invoke(t.api, 'LocalTimeFromUtcTime', {
      user: t.admin,
      params: { TimeZoneCode: code, UtcTime: '2026-01-15T12:00:00Z' },
    });
    assert.match(local.body.LocalTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/, `code ${code}`);
  }
  const paris = async (utc) =>
    (await invoke(t.api, 'LocalTimeFromUtcTime', { user: t.admin, params: { TimeZoneCode: 105, UtcTime: utc } })).body
      .LocalTime;
  assert.equal(await paris('2026-01-15T12:00:00Z'), '2026-01-15T13:00:00+01:00');
  assert.equal(await paris('2026-07-15T12:00:00Z'), '2026-07-15T14:00:00+02:00');
  // The smaller of the January and July 2026 offsets equals the display name's base offset, for every code.
  const mismatches = TIME_ZONE_IDS.filter(([code, , iana]) => {
    const [, sign, hours, minutes] = /\((?:GMT|UTC)(?:([+-])(\d\d):(\d\d))?\)/.exec(
      TIME_ZONE_DEFINITIONS.find(([c]) => c === code)[1],
    );
    const base = hours === undefined ? 0 : (sign === '-' ? -1 : 1) * (Number(hours) * 60 + Number(minutes));
    return (
      Math.min(offsetMinutes(iana, Date.UTC(2026, 0, 15, 12)), offsetMinutes(iana, Date.UTC(2026, 6, 15, 12))) !== base
    );
  });
  assert.deepEqual(mismatches, []);
});

test('GetTimeZoneCodeByLocalizedName finds a newly seeded zone (Yukon 305)', async () => {
  const t = await setup();
  const found = await invoke(t.api, 'GetTimeZoneCodeByLocalizedName', {
    user: t.admin,
    params: { LocalizedStandardName: 'Yukon Standard Time', LocaleId: 1033 },
  });
  assert.equal(found.body.TimeZoneCode, 305);
  const local = await invoke(t.api, 'LocalTimeFromUtcTime', {
    user: t.admin,
    params: { TimeZoneCode: 305, UtcTime: '2026-07-01T12:00:00Z' },
  });
  assert.equal(local.body.LocalTime, '2026-07-01T05:00:00-07:00');
});

test('ExpandCalendar expands a weekly working-hours rule through its inner calendar', async () => {
  const t = await setup();
  await workingHours(t, []);
  const expanded = await invoke(t.api, 'ExpandCalendar', {
    user: t.admin,
    binding: 'entity',
    entity: 'calendar',
    target: { id: OUTER },
    params: { Start: MON, End: WEEK_END },
  });
  const blocks = expanded.body.result;
  assert.deepEqual(
    blocks.map((block) => block.Start),
    ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'].map((day) => `${day}T09:00:00.000Z`),
  );
  assert.ok(blocks.every((block) => block.End.endsWith('T17:00:00.000Z') && block.TimeCode === 0));
});

test('QuerySchedule returns Available blocks minus a booked appointment, and the Unavailable gaps', async () => {
  const t = await setup();
  await workingHours(t, [CALENDAR_RESOURCE]);
  await action(t.api, 'Book', {
    user: t.admin,
    body: {
      subject: 'Review',
      scheduledstart: '2026-11-02T10:00:00Z',
      scheduledend: '2026-11-02T11:00:00Z',
      requiredattendees: [CALENDAR_RESOURCE],
    },
  });
  const schedule = async (codes) =>
    (
      await invoke(t.api, 'QuerySchedule', {
        user: t.admin,
        params: { ResourceId: CALENDAR_RESOURCE, Start: MON, End: '2026-11-03T00:00:00Z', TimeCodes: codes },
      })
    ).body.TimeInfos;
  const available = await schedule(['Available']);
  assert.deepEqual(
    available.map((block) => [block.Start, block.End]),
    [
      ['2026-11-02T09:00:00.000Z', '2026-11-02T10:00:00.000Z'],
      ['2026-11-02T11:00:00.000Z', '2026-11-02T17:00:00.000Z'],
    ],
  );
  const unavailable = await schedule(['Unavailable']);
  assert.deepEqual(
    unavailable.map((block) => [block.Start, block.End]),
    [
      ['2026-11-02T00:00:00.000Z', '2026-11-02T09:00:00.000Z'],
      ['2026-11-02T17:00:00.000Z', '2026-11-03T00:00:00.000Z'],
    ],
  );
});

test('Search proposes the first free slot for two users and reports ResourceBusy when none fits', async () => {
  const t = await setup();
  await workingHours(t, [RESOURCE, OTHER]);
  await action(t.api, 'Book', {
    user: t.admin,
    body: {
      subject: 'First',
      scheduledstart: '2026-11-02T09:00:00Z',
      scheduledend: '2026-11-02T10:00:00Z',
      requiredattendees: [RESOURCE],
    },
  });
  await action(t.api, 'Book', {
    user: t.admin,
    body: {
      subject: 'Second',
      scheduledstart: '2026-11-02T09:00:00Z',
      scheduledend: '2026-11-02T11:00:00Z',
      requiredattendees: [OTHER],
    },
  });
  const required = [{ ResourceId: RESOURCE }, { ResourceId: OTHER }];
  const search = (request) => invoke(t.api, 'Search', { user: t.admin, params: { AppointmentRequest: request } });
  const found = await search({
    Duration: 60,
    SearchWindowStart: '2026-11-02T08:00:00Z',
    SearchWindowEnd: '2026-11-02T18:00:00Z',
    NumberOfResults: 2,
    RequiredResources: required,
  });
  const { Proposals, TraceInfo } = found.body.SearchResults;
  assert.deepEqual(
    Proposals.map((proposal) => proposal.Start),
    ['2026-11-02T11:00:00.000Z', '2026-11-02T11:15:00.000Z'],
  );
  assert.equal(Proposals[0].End, '2026-11-02T12:00:00.000Z');
  assert.deepEqual(
    Proposals[0].ProposalParties.map((party) => party.ResourceId),
    [RESOURCE, OTHER],
  );
  assert.deepEqual(TraceInfo.ErrorInfoList, []);

  const none = await search({
    Duration: 120,
    SearchWindowStart: '2026-11-02T09:00:00Z',
    SearchWindowEnd: '2026-11-02T10:30:00Z',
    RequiredResources: required,
  });
  assert.deepEqual(none.body.SearchResults.Proposals, []);
  assert.equal(none.body.SearchResults.TraceInfo.ErrorInfoList[0].ErrorCode, 'ResourceBusy');
  assert.deepEqual(
    none.body.SearchResults.TraceInfo.ErrorInfoList[0].ResourceList.map((entry) => entry.Id),
    [OTHER],
  );

  await assert.rejects(
    search({
      Duration: 60,
      ServiceId: RESOURCE,
      SearchWindowStart: MON,
      SearchWindowEnd: WEEK_END,
      RequiredResources: required,
    }),
    refused,
  );
});

// Two Available blocks of one calendar overlap (the working hours and a later rule of the same rank). Their free time is merged
// before proposals are made: each start is proposed once, and the merged span allows every quarter hour that fits in it.
test('Search proposes each start once when overlapping Available blocks cover the same free time', async () => {
  const t = await setup();
  await workingHours(t, [RESOURCE]);
  await t.store.transact(() =>
    t.store.state.tables.calendarrule.push({
      calendarruleid: 'a1000000-0000-4000-8000-000000000003',
      calendarid: INNER,
      offset: 600,
      duration: 480,
      timecode: 0,
      name: 'Late hours',
    }),
  );
  await action(t.api, 'Book', {
    user: t.admin,
    body: {
      subject: 'Booked',
      scheduledstart: '2026-11-02T10:00:00Z',
      scheduledend: '2026-11-02T11:00:00Z',
      requiredattendees: [RESOURCE],
    },
  });
  const found = await invoke(t.api, 'Search', {
    user: t.admin,
    params: {
      AppointmentRequest: {
        Duration: 60,
        SearchWindowStart: '2026-11-02T08:00:00Z',
        SearchWindowEnd: '2026-11-02T18:00:00Z',
        NumberOfResults: 100,
        RequiredResources: [{ ResourceId: RESOURCE }],
      },
    },
  });
  const starts = found.body.SearchResults.Proposals.map((proposal) => proposal.Start);
  // 09:00 fits the free hour before the booking; 11:00 to 17:00 in quarter hours fit the free time after it (18:00 ends it).
  assert.equal(starts.length, 26);
  assert.equal(new Set(starts).size, starts.length, 'no start is proposed twice');
  assert.deepEqual(starts.slice(0, 2), ['2026-11-02T09:00:00.000Z', '2026-11-02T11:00:00.000Z']);
  assert.equal(starts.at(-1), '2026-11-02T17:00:00.000Z');
});

test("RetrieveExchangeAppointments returns the caller's appointments in range", async () => {
  const t = await setup();
  await action(t.api, 'Book', {
    user: t.admin,
    body: {
      subject: 'Mine',
      scheduledstart: '2026-11-02T10:00:00Z',
      scheduledend: '2026-11-02T11:00:00Z',
      requiredattendees: [t.admin.systemuserid],
    },
  });
  await action(t.api, 'Book', {
    user: t.admin,
    body: {
      subject: 'Elsewhere',
      scheduledstart: '2026-11-05T10:00:00Z',
      scheduledend: '2026-11-05T11:00:00Z',
      requiredattendees: [OTHER],
    },
  });
  const inRange = await invoke(t.api, 'RetrieveExchangeAppointments', {
    user: t.admin,
    params: { StartDate: MON, EndDate: WEEK_END },
  });
  assert.deepEqual(
    inRange.body.BusinessEntityCollection.BusinessEntities.map((row) => row.subject),
    ['Mine'],
  );
});

test('SetReportRelated stores categories and refuses code 9', async () => {
  const t = await setup();
  await t.store.transact(() =>
    rows(t, 'report').push({ reportid: REPORT, name: 'Contoso pipeline', bodytext: '<Report/>' }),
  );
  const categoriesOf = () =>
    rows(t, 'reportcategory')
      .filter((row) => row.reportid === REPORT)
      .map((row) => row.categorycode)
      .sort();
  await action(t.api, 'SetReportRelated', {
    user: t.admin,
    body: { ReportId: REPORT, Entities: [], Categories: [1, 3], Visibility: [] },
  });
  assert.deepEqual(categoriesOf(), [1, 3]);
  await action(t.api, 'SetReportRelated', {
    user: t.admin,
    body: { ReportId: REPORT, Entities: [], Categories: [2], Visibility: [] },
  });
  assert.deepEqual(categoriesOf(), [2], 'categories replace the earlier set');
  await assert.rejects(
    action(t.api, 'SetReportRelated', {
      user: t.admin,
      body: { ReportId: REPORT, Entities: [], Categories: [9], Visibility: [] },
    }),
    refused,
  );
  assert.deepEqual(categoriesOf(), [2], 'a refused call writes nothing');
});

// ---- Rank trimming of calendar blocks: the reference is the pairwise cut, one cover and one span at a time.

const MIN_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MIN_MS;
const JAN_2026 = Date.UTC(2026, 0, 1);

function referenceMinus(spans, cuts) {
  return cuts.reduce(
    (pieces, [cutStart, cutEnd]) =>
      pieces.flatMap(([s, e]) =>
        cutEnd <= s || cutStart >= e
          ? [[s, e]]
          : [
              [s, cutStart],
              [cutEnd, e],
            ].filter(([a, b]) => b > a),
      ),
    spans,
  );
}

// The pairwise trimming, layer by layer. With dropMalformedCovers, a block that ends before it starts is not one of the
// covering spans: the documented normalisation of malformed spans in trimByRank.
function referenceTrim(blocks, { dropMalformedCovers = false } = {}) {
  const out = [];
  let covered = [];
  const ranks = [...new Set(blocks.map((block) => Number(block.rule.rank ?? 0)))].sort((a, b) => a - b);
  for (const rank of ranks) {
    const layer = blocks.filter((block) => Number(block.rule.rank ?? 0) === rank);
    for (const block of layer) {
      for (const [startMs, endMs] of referenceMinus([[block.startMs, block.endMs]], covered))
        out.push({ ...block, startMs, endMs });
    }
    const kept = layer.filter((block) => !dropMalformedCovers || block.endMs >= block.startMs);
    covered = covered.concat(kept.map((block) => [block.startMs, block.endMs]));
  }
  return out.sort((left, right) => left.startMs - right.startMs);
}

// The time the positive pieces cover, merged: equal for two outputs that cut the same time into differently many pieces.
function coveredTime(pieces) {
  const merged = [];
  for (const [startMs, endMs] of pieces.filter(([s, e]) => e > s).toSorted((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && startMs <= last[1]) last[1] = Math.max(last[1], endMs);
    else merged.push([startMs, endMs]);
  }
  return merged;
}

// A seeded generator (mulberry32): the same rule sets on every run.
function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random blocks of ranks 0 to 2 starting in the window. Durations are zero (a point), short, long, or negative on
// every tenth round, so touching, nested, zero-length and malformed spans all occur.
function randomBlocks(random, from, to, malformed) {
  const durations = malformed ? [0, 30, -30, 240] : [0, 0, 30, 60, 240, 480];
  const span = Math.max(1, Math.floor((to - from) / MIN_MS));
  const count = Math.floor(random() * 40);
  return Array.from({ length: count }, () => {
    const startMs = from + Math.floor(random() * span) * MIN_MS;
    const duration = durations[Math.floor(random() * durations.length)];
    return {
      startMs,
      endMs: startMs + duration * MIN_MS,
      rule: { rank: Math.floor(random() * 3) },
      calendarId: 'calendar',
    };
  });
}

// Daily rules as the expansion makes them: a rank 0 block of eight hours and a rank 1 block of one hour inside it.
function dailyBlocks(years) {
  const blocks = [];
  for (let day = 0; day < years * 365; day += 1) {
    const midnight = JAN_2026 + day * DAY_MS;
    blocks.push({ startMs: midnight + 480 * MIN_MS, endMs: midnight + 960 * MIN_MS, rule: { rank: 0 } });
    blocks.push({ startMs: midnight + 600 * MIN_MS, endMs: midnight + 660 * MIN_MS, rule: { rank: 1 } });
  }
  return blocks;
}

// Well-formed rounds give the pairwise reference output exactly. A round with a malformed block gives the reference output over
// the covers that are well formed (the normalisation), and covers the same time as the reference output that keeps them.
test('trimByRank asserts the documented normalisation of malformed spans against the pairwise reference', () => {
  const random = seededRandom(20260501);
  for (let round = 0; round < 300; round += 1) {
    const from = JAN_2026 + Math.floor(random() * 400) * DAY_MS;
    const to = from + (1 + Math.floor(random() * 20)) * DAY_MS;
    const blocks = randomBlocks(random, from, to, round % 10 === 0).filter(
      (block) => block.startMs < to && from < block.endMs,
    );
    const malformed = blocks.some((block) => block.endMs < block.startMs);
    assert.deepEqual(trimByRank(blocks), referenceTrim(blocks, { dropMalformedCovers: malformed }), `round ${round}`);
    if (malformed) {
      const pairs = (output) => output.map((block) => [block.startMs, block.endMs]);
      assert.deepEqual(
        coveredTime(pairs(trimByRank(blocks))),
        coveredTime(pairs(referenceTrim(blocks))),
        `round ${round}`,
      );
    }
  }
});

test('subtractSpans gives the pairwise reference on seeded random spans and cuts, malformed cuts included', () => {
  const random = seededRandom(20260502);
  for (let round = 0; round < 300; round += 1) {
    const from = JAN_2026 + Math.floor(random() * 400) * DAY_MS;
    const to = from + (1 + Math.floor(random() * 20)) * DAY_MS;
    const malformed = round % 10 === 0;
    const toPairs = (blocks) => blocks.map((block) => [block.startMs, block.endMs]);
    const spans = toPairs(randomBlocks(random, from, to, malformed));
    const cuts = toPairs(randomBlocks(random, from, to, malformed));
    const wellFormed = cuts.filter(([startMs, endMs]) => endMs >= startMs);
    assert.deepEqual(subtractSpans(spans, cuts), referenceMinus(spans, wellFormed), `round ${round}`);
    if (wellFormed.length < cuts.length)
      assert.deepEqual(
        coveredTime(subtractSpans(spans, cuts)),
        coveredTime(referenceMinus(spans, cuts)),
        `round ${round} covers`,
      );
  }
});

test('trimByRank does work in step with the blocks: a 16-year window takes under 20 times the comparisons of a 1-year window', () => {
  const comparisons = (years) => {
    const work = { comparisons: 0 };
    trimByRank(dailyBlocks(years), work);
    return work.comparisons;
  };
  const oneYear = comparisons(1);
  const sixteenYears = comparisons(16);
  assert.ok(sixteenYears < 20 * oneYear, `${sixteenYears} comparisons for 16 years, ${oneYear} for one year`);
});

// The same minutes of each day, for years of days: a span of the window per day.
function dailyPairs(years, startMinute, endMinute) {
  const pairs = [];
  for (let day = 0; day < years * 365; day += 1) {
    const midnight = JAN_2026 + day * DAY_MS;
    pairs.push([midnight + startMinute * MIN_MS, midnight + endMinute * MIN_MS]);
  }
  return pairs;
}

test('subtractSpans does work in step with the spans: 16 years of busy blocks cost under 20 times one year', () => {
  const comparisons = (years) => {
    const work = { comparisons: 0 };
    subtractSpans(dailyPairs(years, 480, 960), dailyPairs(years, 600, 660), work);
    return work.comparisons;
  };
  const oneYear = comparisons(1);
  const sixteenYears = comparisons(16);
  assert.ok(sixteenYears < 20 * oneYear, `${sixteenYears} comparisons for 16 years, ${oneYear} for one year`);
});

test('trimByRank stays linear when the window holds malformed spans: 16 years cost under 20 times one year', () => {
  const comparisons = (years) => {
    const work = { comparisons: 0 };
    const malformed = dailyPairs(years, 900, 500).map(([startMs, endMs]) => ({ startMs, endMs, rule: { rank: 0 } }));
    trimByRank([...dailyBlocks(years), ...malformed], work);
    return work.comparisons;
  };
  const oneYear = comparisons(1);
  const sixteenYears = comparisons(16);
  assert.ok(sixteenYears < 20 * oneYear, `${sixteenYears} comparisons for 16 years, ${oneYear} for one year`);
});

// Sorted, disjoint spans from a base instant: gaps of none (touching spans) or more, and lengths of half an hour
// or more.
function sortedSpans(random, count, base) {
  const spans = [];
  let at = base;
  for (let index = 0; index < count; index += 1) {
    const startMs = at + Math.floor(random() * 4) * 30 * MIN_MS;
    const endMs = startMs + (1 + Math.floor(random() * 8)) * 30 * MIN_MS;
    spans.push([startMs, endMs]);
    at = endMs;
  }
  return spans;
}

// The pairwise overlaps of two span lists, in the order of the left spans: the reference the sweep must reproduce.
function pairwiseOverlaps(left, right) {
  return left.flatMap(([s1, e1]) =>
    right.map(([s2, e2]) => [Math.max(s1, s2), Math.min(e1, e2)]).filter(([s, e]) => e > s),
  );
}

test('intersectSpans gives the pairwise overlaps on seeded sorted, disjoint span lists', () => {
  const random = seededRandom(20260503);
  for (let round = 0; round < 300; round += 1) {
    const base = JAN_2026 + Math.floor(random() * 400) * DAY_MS;
    const left = sortedSpans(random, Math.floor(random() * 30), base);
    const right = sortedSpans(random, Math.floor(random() * 30), base + Math.floor(random() * 6) * 30 * MIN_MS);
    assert.deepEqual(intersectSpans(left, right), pairwiseOverlaps(left, right), `round ${round}`);
    assert.deepEqual(intersectSpans(right, left), pairwiseOverlaps(right, left), `round ${round} reversed`);
  }
});

test('disjointSpans merges strictly overlapping spans, keeps touching spans apart, and covers the same time', () => {
  assert.deepEqual(
    disjointSpans([
      [30, 40],
      [0, 10],
      [5, 12],
      [50, 50],
      [40, 45],
    ]),
    [
      [0, 12],
      [30, 40],
      [40, 45],
    ],
    'the touching pair at 40 stays apart',
  );
  assert.deepEqual(
    disjointSpans([
      [10, 20],
      [0, 10],
    ]),
    [
      [0, 10],
      [10, 20],
    ],
    'touching spans stay apart, so each keeps its own split',
  );
  const random = seededRandom(20260504);
  for (let round = 0; round < 300; round += 1) {
    const base = JAN_2026 + Math.floor(random() * 400) * DAY_MS;
    const spans = Array.from({ length: Math.floor(random() * 30) }, () => {
      const startMs = base + Math.floor(random() * 200) * 15 * MIN_MS;
      return [startMs, startMs + Math.floor(random() * 12) * 15 * MIN_MS];
    });
    const out = disjointSpans(spans);
    assert.ok(
      out.every(([s, e], index) => e > s && (index === 0 || out[index - 1][1] <= s)),
      `round ${round} sorted and disjoint`,
    );
    assert.deepEqual(coveredTime(out), coveredTime(spans), `round ${round} covers the same time`);
  }
});

test('intersectSpans does work in step with the spans: 16 years of sorted spans cost under 20 times one year', () => {
  const comparisons = (years) => {
    const work = { comparisons: 0 };
    intersectSpans(dailyPairs(years, 480, 960), dailyPairs(years, 420, 600), work);
    return work.comparisons;
  };
  const oneYear = comparisons(1);
  const sixteenYears = comparisons(16);
  assert.ok(sixteenYears < 20 * oneYear, `${sixteenYears} comparisons for 16 years, ${oneYear} for one year`);
});
