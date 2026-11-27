// @test-kind observation: paqvilo-developer hosted-f2 summary-F2 LIST-01f range follow-up (caledges.json runs e and f, 2026-11-27, identical answers on a list without and one with an all-day column): 22 rows against F = 2026-11-10T00:00Z and T = 2026-11-20T00:00Z, start UserLocal and end TimeZoneIndependent, portal query zone UTC+2; each range's event set is typed from the captures; invented row ids and names
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { calendarEvents } from '../lib/list-views.mjs';
import { zoneOffsetFunction } from '../lib/portal-query-time-zone.mjs';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const z = (day, time = '00:00:00') => `2026-${day}T${time}Z`;
// [name, start, end]: the captured rows (labels shortened), all-day rows included as timed rows.
const ROWS = [
  ['e01', z('11-01', '09:00:00'), z('11-01', '10:00:00')],
  ['e02', z('11-09', '23:00:00'), z('11-10')],
  ['e03', z('11-09', '12:00:00'), z('11-11', '12:00:00')],
  ['e04', z('11-10'), z('11-10', '01:00:00')],
  ['e05', z('11-15', '10:00:00'), z('11-15', '11:00:00')],
  ['e06', z('11-19', '23:00:00'), z('11-20')],
  ['e07', z('11-19', '12:00:00'), z('11-21', '12:00:00')],
  ['e08', z('11-20'), z('11-20', '01:00:00')],
  ['e09', z('11-25', '09:00:00'), z('11-25', '10:00:00')],
  ['e10', z('11-05'), z('11-25')],
  ['e11', z('11-15', '12:00:00'), null],
  ['e12', z('11-05', '12:00:00'), null],
  ['e13', z('11-10'), null],
  ['e14', z('11-20'), null],
  ['e15', z('11-10'), z('11-10')],
  ['e16', z('11-15'), z('11-12')],
  ['e17', null, z('11-15')],
  ['e18', z('11-15'), z('11-16')],
  ['e19', z('11-20'), z('11-21')],
  ['e20', z('11-09'), z('11-10')],
  ['e21', z('11-20'), z('11-20')],
  ['e22', z('11-09', '23:00:00'), z('11-09', '23:59:59')],
];
const all = (...names) => names.flatMap((name) => (Array.isArray(name) ? name : [name])).sort();
const NORMAL = all(
  'e02',
  'e03',
  'e04',
  'e05',
  'e06',
  'e07',
  'e08',
  'e10',
  'e11',
  'e13',
  'e14',
  'e15',
  'e16',
  'e18',
  'e19',
  'e20',
  'e21',
  'e22',
);
const REVERSED = all('e02', 'e03', 'e04', 'e05', 'e06', 'e07', 'e08', 'e10', 'e15', 'e16', 'e18', 'e19', 'e20', 'e21');
const CAPTURED = [
  ['normal', z('11-10'), z('11-20'), NORMAL],
  ['reversed', z('11-20'), z('11-10'), REVERSED],
  ['empty-at-F', z('11-10'), z('11-10'), all('e02', 'e03', 'e04', 'e10', 'e13', 'e15', 'e20', 'e22')],
  ['empty-at-T', z('11-20'), z('11-20'), all('e06', 'e07', 'e08', 'e10', 'e14', 'e19', 'e21')],
  ['point-inside', z('11-15', '12:00:00'), z('11-15', '12:00:00'), all('e05', 'e10', 'e11', 'e16', 'e18')],
  ['wide', z('10-01'), z('12-01'), all(ROWS.filter(([, start]) => start).map(([name]) => name))],
  ['wide-reversed', z('12-01'), z('10-01'), all(ROWS.filter(([, start, end]) => start && end).map(([name]) => name))],
  ['reversed-narrow', z('11-15'), z('11-12'), all('e05', 'e10', 'e16', 'e18')],
  ['inner-1s', z('11-10', '00:00:01'), z('11-19', '23:59:59'), NORMAL],
  ['outer-1s', z('11-09', '23:59:59'), z('11-20', '00:00:01'), NORMAL],
  ['reversed-outer-1s', z('11-20', '00:00:01'), z('11-09', '23:59:59'), all(REVERSED, 'e22')],
];

test('the calendar range predicate selects the captured events of every range', () => {
  const calendar = {
    start: 's',
    end: 'e',
    summary: 'n',
    startBehavior: 'UserLocal',
    endBehavior: 'TimeZoneIndependent',
  };
  const rows = ROWS.map(([name, s, e]) => ({ id: name, n: name, s, e }));
  const queryZone = zoneOffsetFunction('Europe/Kiev');
  for (const [label, from, to, expected] of CAPTURED)
    assert.deepEqual(
      calendarEvents(rows, { calendar, idColumn: 'id', from: Date.parse(from), to: Date.parse(to), queryZone })
        .map((event) => event.title)
        .sort(),
      expected,
      label,
    );
});

test('the feed applies the predicate for a reversed range, with UserLocal days in the observed portal query zone', async (t) => {
  const SITE = '4f1d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e6f';
  const LIST = '1b000000-0000-4000-8000-000000000021';
  const VIEW = '5c000000-0000-4000-8000-000000000001';
  const CONTACT = 'c0000000-0000-4000-8000-000000000001';
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'list-calendar-range-'));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Calendar`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: shell',
    'Shell.pagetemplate.yml': 'adx_pagetemplateid: shell\nadx_webtemplateid: shell',
    'Shell.webtemplate.yml': 'adx_webtemplateid: shell\nadx_name: Shell',
    'Shell.webtemplate.source.html': "{% include 'entity_list' key: 'Slots' %}",
    'Slots.list.yml': `adx_entitylistid: ${LIST}\nadx_name: Slots\nadx_entityname: account\nadx_view: ${VIEW}\nadx_calendar_enabled: true\nadx_calendar_startdatefieldname: opens\nadx_calendar_enddatefieldname: closes\nadx_calendar_summaryfieldname: name`,
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const account = (n, name, opens, closes) => ({
    accountid: `a0000000-0000-4000-8000-00000000000${n}`,
    name,
    opens,
    closes,
  });
  const initial = {
    version: 1,
    mappings: { account: { entitySet: 'accounts', idColumn: 'accountid', nameColumn: 'name' } },
    tables: {
      contact: [{ contactid: CONTACT, fullname: 'Ada' }],
      account: [
        account(1, 'spans both', z('11-05'), z('11-25')),
        account(2, 'inside', z('11-15', '10:00:00'), z('11-15', '11:00:00')),
        account(3, 'before', z('11-01', '09:00:00'), z('11-01', '10:00:00')),
        account(4, 'no end inside', z('11-15', '12:00:00'), null),
        // Starts 23:00Z on 9 November: the 10th in the UTC+2 query zone, the 9th in UTC.
        account(5, 'late on the 9th', z('11-09', '23:00:00'), z('11-09', '23:30:00')),
      ],
    },
    permissions: [{ id: 'read-account', entity: 'account', scope: 'global', roles: ['Editor'], operations: ['read'] }],
    settings: { permissionMode: 'enforce' },
  };
  let launched = 0;
  const titles = async (observed, query) => {
    const app = await createSimulator({
      sourceDir: dir,
      stateFile: path.join(dir, `state-${++launched}.json`),
      initial,
      watch: false,
      ...(observed ? { observed } : {}),
    });
    ownedFixture(t).add(() => app.close());
    const response = await fetch(`${app.url}/EntityList/Calendar/${SITE}/${LIST}/${VIEW}${query}`, {
      headers: signInHeaders(app, CONTACT, { roles: ['Editor'] }),
    });
    return (await response.json()).result.map((event) => event.title).sort();
  };
  const zone = { evidence: 'invented test site: UTC+2 portal query zone', portalQueryTimeZone: 'Europe/Kiev' };
  assert.deepEqual(await titles(zone, `?from=${z('11-20')}&to=${z('11-10')}`), [
    'inside',
    'late on the 9th',
    'spans both',
  ]);
  assert.deepEqual(await titles(zone, `?from=${z('11-10')}&to=${z('11-20')}`), [
    'inside',
    'late on the 9th',
    'no end inside',
    'spans both',
  ]);
  // Without the observation the store's own offset (UTC here) reads the late start as the 9th.
  assert.deepEqual(await titles(null, `?from=${z('11-10')}&to=${z('11-20')}`), [
    'inside',
    'no end inside',
    'spans both',
  ]);
});
