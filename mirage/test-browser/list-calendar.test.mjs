// Calendar lists in a browser: the local calendar client requests the platform templates in the
// platform order and renders the platform calendar DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';
import { AssetCache } from '../lib/asset-cache.mjs';
import { sharedBrowser, fileScope } from './shared-browser.mjs';

const chrome = sharedBrowser();
// The calendar tests only read, so tests on the same list and Bootstrap version share one simulator; each opens
// its own context (a fresh browser cache, so the recorded template requests stay per test).
const scope = fileScope();
const sites = new Map();

const SITE = '4f1d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e70';
const YEAR = '1b000000-0000-4000-8000-000000000011';
const MONTH = '1b000000-0000-4000-8000-000000000012';
const CONTACT = 'c0000000-0000-4000-8000-000000000011';

async function site(owner, list, bootstrapV5, capturedCss) {
  const dir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'list-calendar-browser-'));
  ownedFixture(owner).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const calendar =
    'adx_calendar_enabled: true\nadx_calendar_startdatefieldname: opens\nadx_calendar_summaryfieldname: name\nadx_calendar_descriptionfieldname: city';
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Calendar`,
    'Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template',
    'Main.pagetemplate.yml': 'adx_pagetemplateid: template\nadx_webtemplateid: main',
    'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html': `{% include 'entity_list' key: '${list}' %}`,
    // A year list in the list style (event list beside the year), and a month list without an end date column.
    'Year.list.yml': `adx_entitylistid: ${YEAR}\nadx_name: Year\nadx_entityname: account\n${calendar}\nadx_calendar_enddatefieldname: closes\nadx_calendar_initialview: 756150000\nadx_calendar_style: 756150001\nadx_calendar_initialdate: 2026-01-01T00:00:00.0000000`,
    'Month.list.yml': `adx_entitylistid: ${MONTH}\nadx_name: Month\nadx_entityname: account\n${calendar}\nadx_calendar_initialview: 756150001\nadx_calendar_initialdate: 2026-10-01T00:00:00.0000000`,
    'sitesetting.yml':
      '- adx_sitesettingid: 5e000000-0000-4000-8000-000000000071\n  adx_name: Site/BootstrapV5Enabled\n  adx_value: "' +
      bootstrapV5 +
      '"',
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const initial = {
    version: 1,
    mappings: {
      account: { entitySet: 'accounts', idColumn: 'accountid', nameColumn: 'name' },
      contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
    },
    tables: {
      contact: [{ contactid: CONTACT, fullname: 'Ada' }],
      account: [
        {
          accountid: 'a0000000-0000-4000-8000-000000000011',
          name: 'Alpha',
          city: 'London',
          opens: '2026-03-04T10:30:00Z',
          closes: '2026-03-06T08:00:00Z',
        },
        {
          accountid: 'a0000000-0000-4000-8000-000000000012',
          name: 'Beta',
          opens: '2026-01-15T09:00:00Z',
          closes: '2026-01-15T09:00:00Z',
        },
      ],
    },
    permissions: [{ id: 'read-account', entity: 'account', scope: 'global', roles: ['Editor'], operations: ['read'] }],
    settings: { permissionMode: 'enforce' },
    simulator: {
      mode: 'local',
      pageMode: 'local',
      identity: { id: CONTACT, contactId: CONTACT, fullname: 'Ada', roles: ['Editor'] },
      live: { origin: null },
      endpoints: [],
      componentSchemas: {},
    },
  };
  if (capturedCss !== null) {
    const origin = 'https://calendar.example.test';
    initial.simulator.live.origin = origin;
    const cache = await new AssetCache({ directory: path.join(dir, 'assets'), origin }).init();
    await cache.capture(['/Areas/EntityList/css/' + (bootstrapV5 ? 'BootstrapV5/' : '') + 'calendar.min.css'], {
      origin,
      request: async () => ({ status: 200, headers: { 'content-type': 'text/css' }, body: Buffer.from(capturedCss) }),
    });
  }
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, 'state.json'), initial, watch: false });
  ownedFixture(owner).add(() => app.close());
  return app;
}

async function open(t, list, { width = 1200, bootstrapV5 = true, capturedCss = null } = {}) {
  const key = list + ':' + bootstrapV5;
  if (capturedCss === null && !sites.has(key)) sites.set(key, site(scope, list, bootstrapV5, null));
  const app = await (capturedCss === null ? sites.get(key) : site(t, list, bootstrapV5, capturedCss));
  const context = await chrome.browser.newContext({ timezoneId: 'UTC', viewport: { width, height: 900 } });
  ownedFixture(t).add(() => context.close());
  await signInContext(context, app, CONTACT, { roles: ['Editor'] });
  const page = await context.newPage();
  const requests = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (
      /^\/(Areas\/EntityList\/(tmpls|css\/img)|EntityList\/Calendar\/[^/]+\/[^/]+)/.test(url.pathname.slice(1)) ||
      /tmpls|loading-bar|EntityList\/Calendar\/[^/]+\/[^/]+\//.test(url.pathname)
    )
      requests.push(url.pathname.replace(/^.*\//, ''));
  });
  await page.route('**/*', (route) => (route.request().url().startsWith(app.url) ? route.continue() : route.abort()));
  await page.goto(`${app.url}/`);
  await page.locator('.entitylist .announce-calendar-title-sr-only').waitFor({ state: 'attached' });
  return { page, requests, app };
}

test('explicitly captured calendar stylesheet bytes replace the structural fallback', async (t) => {
  const capturedCss = '/* Invented reference bytes */ .calendar{--calendar-capture:retained}';
  const { page, app } = await open(t, 'Month', { capturedCss });
  const response = await page.request.get(app.url + '/Areas/EntityList/css/BootstrapV5/calendar.min.css');
  assert.equal(response.status(), 200);
  assert.equal(await response.text(), capturedCss);
  assert.equal(
    await page.locator('.calendar').evaluate((node) => getComputedStyle(node).getPropertyValue('--calendar-capture')),
    'retained',
  );
});

for (const bootstrapV5 of [true, false])
  for (const width of [1200, 390]) {
    test(
      'calendar fallback lays out seven usable day columns (Bootstrap ' + (bootstrapV5 ? 5 : 3) + ', ' + width + 'px)',
      async (t) => {
        const { page } = await open(t, 'Month', { width, bootstrapV5 });
        const geometry = await page
          .locator('.cal-month-box > .cal-row-fluid')
          .first()
          .locator(':scope > .cal-cell1')
          .evaluateAll((cells) =>
            cells.map((cell) => {
              const r = cell.getBoundingClientRect();
              return { x: r.x, y: r.y, width: r.width, height: r.height };
            }),
          );
        assert.equal(geometry.length, 7);
        assert.ok(
          geometry.every((r) => Math.abs(r.y - geometry[0].y) < 1),
          JSON.stringify(geometry),
        );
        assert.ok(
          geometry.every((r) => r.width > 30 && r.height >= 60),
          JSON.stringify(geometry),
        );
        for (let index = 1; index < geometry.length; index++)
          assert.ok(
            geometry[index].x >= geometry[index - 1].x + geometry[index - 1].width - 1,
            JSON.stringify(geometry),
          );
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.locator('[data-cal-date="2026-10-01"][data-cal-view="day"]').first().click();
        await page.waitForFunction(
          () =>
            document.querySelector('.calendar-title').textContent.includes('October') &&
            !document.querySelector('.cal-month-box'),
        );
        assert.equal(
          await page.locator('.calendar-error .message').textContent(),
          'Calendars require both a start and end date.',
        );
      },
    );
  }

test('year month targets, event badges and week spans have visible geometry through actual navigation', async (t) => {
  const { page } = await open(t, 'Year');
  const months = await page
    .locator('.cal-year-box > .row')
    .first()
    .locator(':scope > .cal-cell')
    .evaluateAll((cells) =>
      cells.map((cell) => {
        const r = cell.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      }),
    );
  assert.equal(months.length, 4);
  assert.ok(
    months.every((r) => Math.abs(r.y - months[0].y) < 1 && r.height >= 24),
    JSON.stringify(months),
  );
  const badge = await page
    .locator('.cal-events-num')
    .first()
    .evaluate((node) => {
      const s = getComputedStyle(node),
        r = node.getBoundingClientRect();
      return { color: s.color, background: s.backgroundColor, width: r.width, height: r.height };
    });
  assert.notEqual(badge.color, badge.background);
  assert.notEqual(badge.background, 'rgba(0, 0, 0, 0)');
  assert.ok(badge.width >= 10 && badge.height >= 10, JSON.stringify(badge));
  await page.locator('[data-cal-date="2026-03-01"][data-cal-view="month"]').click();
  await page.locator('.cal-month-box').waitFor();
  await page.locator('[data-cal-date="2026-03-04"][data-cal-view="day"]').click();
  await page.waitForFunction(
    () =>
      !document.querySelector('.cal-month-box') && document.querySelectorAll('.event-list .event-item').length === 1,
  );
  assert.equal(await page.locator('.event-list .event-item').count(), 1);
  await page.locator('[data-calendar-view="week"]').click();
  await page.locator('.cal-week-box').waitFor();
  const week = await page.locator('.cal-week-box').evaluate((node) => {
    const row = node.querySelector('.cal-row-head'),
      cells = [...row.children].map((cell) => {
        const r = cell.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width };
      });
    const event = node.querySelector('.day-highlight').getBoundingClientRect();
    return { cells, event: { x: event.x, width: event.width }, row: row.getBoundingClientRect().width };
  });
  assert.equal(week.cells.length, 7);
  assert.ok(
    week.cells.every((r) => Math.abs(r.y - week.cells[0].y) < 1),
    JSON.stringify(week),
  );
  assert.ok(week.event.x > week.cells[0].x + week.row / 7, JSON.stringify(week));
  assert.ok(week.event.width > week.row / 7 && week.event.width < week.row / 2, JSON.stringify(week));
});

test('a list-style year calendar fetches the platform templates in order and renders the event list beside the year', async (t) => {
  const { page, requests } = await open(t, 'Year');
  assert.deepEqual(
    requests.filter((name) => !/^[0-9a-f-]{36}$/.test(name)),
    ['view.html', 'loading-bar.gif', 'view-event-list.html', 'year.html', 'year-month.html', 'events-list.html'],
  );
  const list = page.locator('.entitylist');
  assert.equal(await list.getAttribute('style'), 'position: static; zoom: 1;');
  assert.equal(await list.locator('.calendar-title').textContent(), '2026');
  assert.deepEqual(
    await list
      .locator('[data-calendar-view]')
      .evaluateAll((buttons) => buttons.map((b) => [b.className, b.getAttribute('aria-label')])),
    [
      ['btn btn-default btn-sm active', ' Pressed'],
      ['btn btn-default btn-sm', ''],
      ['btn btn-default btn-sm', ''],
    ],
  );
  assert.equal(await list.locator('[data-calendar-nav=prev]').getAttribute('title'), 'Previous year');
  assert.equal(await list.locator('.calendar-error').evaluate((node) => node.style.display), 'none');
  assert.equal(await list.locator('.row .calendar').getAttribute('class'), 'calendar cal-context calendar-small');
  assert.deepEqual(
    await list
      .locator('.event-list a.event-item')
      .evaluateAll((links) => links.map((a) => a.getAttribute('aria-label'))),
    ['Beta. January 15, 2026 at 9:00 AM. Thursday.', 'Alpha. March 4, 2026 at 10:30 AM. Wednesday.'],
  );
  assert.equal(
    await list.locator('.event-list a.event-item').nth(1).locator('.calendar-event-datetime').first().textContent(),
    'March 4, 2026 10:30 AM – March 6, 2026 8:00 AM',
  );
  assert.deepEqual(
    await list
      .locator('.cal-year-box [data-cal-view=month]')
      .evaluateAll((spans) => spans.slice(0, 3).map((s) => [s.getAttribute('data-cal-date'), s.textContent])),
    [
      ['2026-01-01', 'Jan'],
      ['2026-02-01', 'Feb'],
      ['2026-03-01', 'Mar'],
    ],
  );
  assert.equal(await list.locator('.cal-year-box .cal-events-num').count(), 2);
  assert.equal(await list.locator(':scope > .announce-calendar-title-sr-only').getAttribute('aria-label'), '2026');
});

test('a month calendar without an end date column shows the platform error over the month grid', async (t) => {
  const { page, requests } = await open(t, 'Month');
  assert.deepEqual(
    requests.filter((name) => !/^[0-9a-f-]{36}$/.test(name)),
    ['view.html', 'loading-bar.gif', 'month.html', 'month-day.html', 'events-list.html'],
  );
  const list = page.locator('.entitylist');
  assert.equal(
    await list.locator('.calendar-error .message').textContent(),
    'Calendars require both a start and end date.',
  );
  assert.equal(await list.locator('.calendar-title').textContent(), 'October 2026');
  // October 2026 starts on a Thursday and ends on a Saturday: five Sunday-first rows.
  assert.equal(await list.locator('.cal-month-box > .cal-row-fluid').count(), 5);
  assert.deepEqual(
    await list
      .locator('.cal-month-day')
      .first()
      .evaluate((day) => [
        day.className,
        day.getAttribute('aria-label'),
        day.querySelector('span').getAttribute('data-cal-date'),
      ]),
    ['cal-month-day cal-day-outmonth cal-day-weekend cal-month-first-row ', 'Sunday September 27, 2026', '2026-09-27'],
  );
  assert.deepEqual(
    await list.locator('.cal-row-head .cal-cell1').evaluateAll((cells) => cells.map((c) => c.textContent)),
    ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  );
});
