// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 LIST-01f (modernlists.json runs a and b, calfeed.json runs c and d, 2026-11-27): the classic calendar feed's range format, refusal texts, CRLF-indented JSON and headers, events without a url (details page and details action alike), and the iCalendar download's shape, headers and range handling; replayed on an invented loopback list
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const SITE = '4f1d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e6f';
const LIST = '1b000000-0000-4000-8000-000000000011';
const VIEW = '5c000000-0000-4000-8000-000000000001';
const DETAILS_FORM = '2b000000-0000-4000-8000-000000000001';
const CONTACT = 'c0000000-0000-4000-8000-000000000001';
const row = (n) => `a0000000-0000-4000-8000-00000000000${n}`;
const MARKUP = 'line one\nline two, <b>bold</b> & "q"; back\\slash';
const SETTINGS = JSON.stringify({
  Type: 'CrmEntityFormView-GridMetadata',
  ItemActions: [{ Type: 'CrmEntityFormView-DetailsAction', EntityFormId: DETAILS_FORM, Label: 'Details' }],
});

async function launch(t) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'list-calendar-feed-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Calendar`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: shell',
    'Details.webpage.yml':
      'adx_webpageid: 6d000000-0000-4000-8000-000000000001\nadx_name: Details\nadx_partialurl: details\nadx_parentpageid: home\nadx_pagetemplateid: shell',
    'Shell.pagetemplate.yml': 'adx_pagetemplateid: shell\nadx_webtemplateid: shell',
    'Shell.webtemplate.yml': 'adx_webtemplateid: shell\nadx_name: Shell',
    'Shell.webtemplate.source.html': "{% include 'entity_list' key: 'Visits' %}",
    'Visits.list.yml': [
      `adx_entitylistid: ${LIST}`,
      'adx_name: Visits',
      'adx_entityname: account',
      `adx_view: ${VIEW}`,
      'adx_webpagefordetailsview: 6d000000-0000-4000-8000-000000000001',
      `adx_settings: '${SETTINGS}'`,
      'adx_calendar_enabled: true',
      'adx_calendar_startdatefieldname: opens',
      'adx_calendar_enddatefieldname: closes',
      'adx_calendar_summaryfieldname: name',
      'adx_calendar_descriptionfieldname: city',
    ].join('\n'),
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const initial = {
    version: 1,
    mappings: { account: { entitySet: 'accounts', idColumn: 'accountid', nameColumn: 'name' } },
    tables: {
      contact: [{ contactid: CONTACT, fullname: 'Ada' }],
      account: [
        {
          accountid: row(1),
          name: 'One hour',
          city: 'first',
          opens: '2026-11-03T09:00:00Z',
          closes: '2026-11-03T10:00:00Z',
        },
        { accountid: row(2), name: 'No end', opens: '2026-11-28T08:00:00Z' },
        {
          accountid: row(3),
          name: 'Marks a,b;c',
          city: MARKUP,
          opens: '2026-11-20T10:00:00Z',
          closes: '2026-11-20T11:00:00Z',
        },
        {
          accountid: row(4),
          name: 'December',
          city: 'fourth',
          opens: '2026-12-05T10:00:00Z',
          closes: '2026-12-05T11:00:00Z',
        },
      ],
    },
    permissions: [{ id: 'read-account', entity: 'account', scope: 'global', roles: ['Editor'], operations: ['read'] }],
    settings: { permissionMode: 'enforce' },
  };
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), initial, watch: false });
  ownedFixture(t).add(() => app.close());
  const headers = signInHeaders(app, CONTACT, { roles: ['Editor'] });
  const base = `${app.url}/EntityList/Calendar/${SITE}/${LIST}/${VIEW}`;
  return { app, get: (suffix) => fetch(base + suffix, { headers }) };
}
const FROM_ERROR =
  '{\r\n  "success": 0,\r\n  "error": "\\"Unable to parse \\"\\"from\\"\\" parameter in required date format.\\""\r\n}';
const TO_ERROR =
  '{\r\n  "success": 0,\r\n  "error": "Unable to parse \\"to\\" parameter in required date format."\r\n}';
const NOVEMBER = '?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00Z';

test('the event feed refuses a range outside yyyy-MM-ddTHH:mm:ssZ with the captured texts, from first', async (t) => {
  const { get } = await launch(t);
  for (const [query, expected] of [
    ['?from=2026-11-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z', FROM_ERROR],
    ['?from=1793491200000&to=1796083200000', FROM_ERROR],
    ['', FROM_ERROR],
    ['?to=2026-12-01T00:00:00Z', FROM_ERROR],
    ['?from=2026-11-01T00:00:00&to=2026-12-01T00:00:00', FROM_ERROR],
    ['?from=2026-11-01&to=2026-12-01', FROM_ERROR],
    ['?from=2026-11-01T00:00:00%2B00:00&to=2026-12-01T00:00:00%2B00:00', FROM_ERROR],
    ['?from=2026-11-01t00:00:00z&to=2026-12-01t00:00:00z', FROM_ERROR],
    ['?from=&to=', FROM_ERROR],
    ['?from=2026-11-01T00:00:00Z&to=2026-12-01T00:00:00.000Z', TO_ERROR],
    ['?from=2026-11-01T00:00:00Z', TO_ERROR],
  ]) {
    const response = await get(query);
    assert.equal(response.status, 200, query);
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8', query);
    assert.equal(response.headers.get('cache-control'), 'no-cache, no-store, must-revalidate', query);
    assert.deepEqual([response.headers.get('pragma'), response.headers.get('expires')], ['no-cache', '-1'], query);
    assert.equal(await response.text(), expected, query);
  }
});

test('feed events carry no url with a details page and a details action, in CRLF-indented JSON', async (t) => {
  const { get } = await launch(t);
  const text = await (await get(NOVEMBER)).text();
  assert.match(text, /^\{\r\n {2}"success": 1,\r\n {2}"result": \[\r\n {4}\{\r\n {6}"id": "/);
  const { result } = JSON.parse(text);
  assert.deepEqual(
    result.map((event) => [event.id, event.start, event.end]),
    [
      [row(1), Date.parse('2026-11-03T09:00:00Z'), Date.parse('2026-11-03T10:00:00Z')],
      [row(3), Date.parse('2026-11-20T10:00:00Z'), Date.parse('2026-11-20T11:00:00Z')],
      // A row without an end: end = start.
      [row(2), Date.parse('2026-11-28T08:00:00Z'), Date.parse('2026-11-28T08:00:00Z')],
    ],
  );
  for (const event of result)
    assert.deepEqual(Object.keys(event), [
      'id',
      'class',
      'title',
      'start',
      'end',
      'description',
      'location',
      'isconversionrequired',
      'startdatebehavior',
      'enddatebehavior',
    ]);
});

test('the iCalendar download has the platform shape and headers, and lists every event unless the range is in the feed format', async (t) => {
  const { app, get } = await launch(t);
  const host = new URL(app.url).hostname;
  const response = await get('/icalendar');
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'text/calendar; charset=utf-8');
  assert.equal(response.headers.get('cache-control'), 'private');
  assert.deepEqual(
    ['content-disposition', 'pragma', 'expires'].map((name) => response.headers.get(name)),
    [null, null, null],
  );
  const lines = (await response.text()).split('\r\n');
  assert.deepEqual(lines.slice(0, 3), [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Adxstudio Inc.//Adxstudio Portals//EN',
  ]);
  const uids = (body) => body.split('\r\n').filter((line) => line.startsWith('UID:'));
  assert.deepEqual(
    uids(lines.join('\r\n')),
    [1, 3, 2, 4].map((n) => `UID:${row(n)}@${host}`),
  );
  // A range with milliseconds is ignored; one in the feed's format selects the events of the range.
  const ignored = await (await get('/icalendar?from=2026-11-01T00:00:00.000Z&to=2026-12-01T00:00:00.000Z')).text();
  assert.equal(uids(ignored).length, 4);
  assert.deepEqual(
    uids(await (await get(`/icalendar${NOVEMBER}`)).text()),
    [1, 3, 2].map((n) => `UID:${row(n)}@${host}`),
  );
  const event = (id) => {
    const start = lines.indexOf(`UID:${row(id)}@${host}`);
    return lines
      .slice(start, lines.indexOf('END:VEVENT', start) + 1)
      .map((line) => line.replace(/^DTSTAMP:\d{8}T\d{6}Z$/, 'DTSTAMP'));
  };
  assert.deepEqual(event(3), [
    `UID:${row(3)}@${host}`,
    'DTSTART:20261120T100000Z',
    'DTEND:20261120T110000Z',
    'DTSTAMP',
    'SUMMARY:Marks a\\,b\\;c',
    'DESCRIPTION:line one line two\\, bold & "q"\\; back\\\\slash',
    'X-ALT-DESC;FMTTYPE=text/html:line one\\nline two\\, <b>bold</b> & "q"\\; bac',
    ' k\\\\slash',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:Marks a\\,b\\;c',
    'END:VALARM',
    'END:VEVENT',
  ]);
  // No end: no DTEND; no description: neither description line.
  assert.deepEqual(event(2), [
    `UID:${row(2)}@${host}`,
    'DTSTART:20261128T080000Z',
    'DTSTAMP',
    'SUMMARY:No end',
    'BEGIN:VALARM',
    'TRIGGER:-PT15M',
    'ACTION:DISPLAY',
    'DESCRIPTION:No end',
    'END:VALARM',
    'END:VEVENT',
  ]);
});
