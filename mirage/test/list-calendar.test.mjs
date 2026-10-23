// Calendar lists: markup shell, language table and the event feed (invented account rows).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createSimulator } from "../server.mjs";
import { signInHeaders } from "../testing/session.mjs";
import { calendarSettings, renderCalendarList, calendarResources, calendarLanguageScript, parseCalendarPath } from "../lib/list-views.mjs";
import { ownedFixture } from "../testing/owned-fixture.mjs";

const SITE = "4f1d9b2a-7c3e-4a5b-9d6e-1a2b3c4d5e6f";
const LIST = "1b000000-0000-4000-8000-000000000001";
const VIEW = "5c000000-0000-4000-8000-000000000001";
const OPEN = "1b000000-0000-4000-8000-000000000002";
const CONTACT = "c0000000-0000-4000-8000-000000000001";

test("calendar list settings, markup shell and resources follow the exported list", () => {
  const list = { id: LIST, metadata: { adx_calendar_enabled: true, adx_calendar_initialview: 756150002, adx_calendar_style: 756150001, adx_calendar_initialdate: "2026-01-01T00:00:00.0000000", adx_calendar_startdatefieldname: "opens", adx_calendar_summaryfieldname: "name" } };
  const calendar = calendarSettings(list);
  assert.deepEqual([calendar.view, calendar.style, calendar.initialDate, calendar.start, calendar.end, calendar.timeZoneMode], ["week", "list", "2026-01-01", "opens", null, "user"]);
  assert.equal(calendarSettings({ metadata: {} }), null);
  const html = renderCalendarList({ list, calendar, websiteId: SITE, viewId: VIEW, variant: "BootstrapV5" });
  assert.match(html, /^<div id="EntityListControl_1b000000000040008000000000000001">/);
  assert.match(html, new RegExp(`data-calendar-url="/EntityList/Calendar/${SITE}/${LIST}/${VIEW}" data-calendar-download-url="/EntityList/Calendar/${SITE}/${LIST}/${VIEW}/icalendar" data-view="calendar" data-calendar-template-path="/Areas/EntityList/tmpls/BootstrapV5/" lang="en-US" data-calendar-style="list" data-calendar-initial-view="week" data-calendar-initial-date="2026-01-01">`));
  const resources = calendarResources({ websiteId: SITE, variant: "BootstrapV5" });
  assert.deepEqual(resources.scripts, ["/Areas/EntityList/js/BootstrapV5/calendar.min.js", "/Areas/EntityList/js/entitylist-calendar.js", `/EntityList/Calendar/${SITE}/language.js`]);
  assert.deepEqual(resources.stylesheets, ["/Areas/EntityList/css/BootstrapV5/calendar.min.css", "/Areas/EntityList/css/BootstrapV5/entitylist-calendar.css"]);
  const language = calendarLanguageScript("en-US");
  assert.match(language, /window\.calendar_languages\["en-US"\] = \{/);
  assert.match(language, /m9: "October",/);
  assert.match(language, /d0: "Sunday",/);
  assert.match(language, /first_day: 2\r\n/);
  assert.deepEqual(parseCalendarPath(`/EntityList/Calendar/${SITE}/${LIST}/${VIEW}/icalendar`), { kind: "icalendar", website: SITE, list: LIST, view: VIEW });
  assert.equal(parseCalendarPath("/EntityList/Calendar/x/language.js"), null);
});

test("calendar event feed returns rows in the requested period with summary and description", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "list-calendar-"));
  ownedFixture(t).remove(() => fs.rm(dir, { recursive: true, force: true }));
  const files = {
    "website.yml": `adx_websiteid: ${SITE}\nadx_name: Calendar`,
    "Home.webpage.yml": "adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: template",
    "Main.pagetemplate.yml": "adx_pagetemplateid: template\nadx_webtemplateid: main",
    "Main.webtemplate.yml": "adx_webtemplateid: main\nadx_name: Main",
    "Main.webtemplate.source.html": "{% include 'entity_list' key: 'Accounts' %}",
    "Accounts.list.yml": `adx_entitylistid: ${LIST}\nadx_name: Accounts\nadx_entityname: account\nadx_pagesize: 2\nadx_calendar_enabled: true\nadx_calendar_startdatefieldname: opens\nadx_calendar_enddatefieldname: opens\nadx_calendar_summaryfieldname: name\nadx_calendar_descriptionfieldname: city`,
    "Open.list.yml": `adx_entitylistid: ${OPEN}\nadx_name: Open\nadx_entityname: account\nadx_calendar_enabled: true\nadx_calendar_startdatefieldname: opens\nadx_calendar_summaryfieldname: name`,
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const initial = {
    version: 1,
    mappings: { account: { entitySet: "accounts", idColumn: "accountid", nameColumn: "name" }, contact: { entitySet: "contacts", idColumn: "contactid", nameColumn: "fullname" } },
    tables: {
      contact: [{ contactid: CONTACT, fullname: "Ada" }],
      account: [
        { accountid: "a0000000-0000-4000-8000-000000000001", name: "Alpha", city: "London", opens: "2026-03-04T10:30:00Z" },
        { accountid: "a0000000-0000-4000-8000-000000000002", name: "Beta", city: "Paris", opens: "2026-04-01T09:00:00Z" },
        { accountid: "a0000000-0000-4000-8000-000000000003", name: "Gamma", city: "Rome" },
      ],
    },
    permissions: [{ id: "read-account", entity: "account", scope: "global", roles: ["Editor"], operations: ["read"] }],
    settings: { permissionMode: "enforce" },
    simulator: { mode: "local", pageMode: "local", identity: { id: CONTACT, contactId: CONTACT, fullname: "Ada", roles: ["Editor"] }, live: { origin: null }, endpoints: [], componentSchemas: { Accounts: { entity: "account", fields: [{ name: "name", label: "Name" }] } } },
  };
  const app = await createSimulator({ sourceDir: dir, stateFile: path.join(dir, "state.json"), initial, watch: false });
  ownedFixture(t).add(() => app.close());
  const headers = signInHeaders(app, CONTACT, { roles: ["Editor"] });
  const base = `${app.url}/EntityList/Calendar/${SITE}/${LIST}/${VIEW}`;
  const march = await fetch(`${base}?from=2026-02-28T22:00:00Z&to=2026-03-31T21:00:00Z`, { headers });
  assert.equal(march.status, 200);
  const data = await march.json();
  assert.equal(data.success, 1);
  assert.deepEqual(data.result.map((event) => [event.title, event.start, event.description]), [["Alpha", Date.parse("2026-03-04T10:30:00Z"), "London"]]);
  const all = await (await fetch(`${base}?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`, { headers })).json();
  assert.deepEqual(all.result.map((event) => event.title), ["Alpha", "Beta"]);
  const ics = await (await fetch(`${base}/icalendar?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`, { headers })).text();
  assert.match(ics, /BEGIN:VEVENT\r\nUID:a0000000-0000-4000-8000-000000000001\r\nDTSTART:20260304T103000Z/);
  const language = await fetch(`${app.url}/EntityList/Calendar/${SITE}/language.js`, { headers });
  assert.equal(language.status, 200);
  assert.equal(language.headers.get("vary"), "*");
  assert.match(await language.text(), /calendar_languages/);
  // A list without an end date column: the platform feed's error (live).
  const open = await (await fetch(`${app.url}/EntityList/Calendar/${SITE}/${OPEN}/${VIEW}?from=2026-01-01T00:00:00Z&to=2027-01-01T00:00:00Z`, { headers })).json();
  assert.deepEqual(open, { success: 0, error: "Calendars require both a start and end date." });
  // The calendar templates are served by name, uncached, as on the platform.
  const template = await fetch(`${app.url}/Areas/EntityList/tmpls/BootstrapV5/month-day.html`, { headers });
  assert.equal(template.status, 200);
  assert.equal(template.headers.get("cache-control"), "no-cache, no-store, must-revalidate");
  assert.match(await template.text(), /cal-month-day/);
  const client = await fetch(`${app.url}/Areas/EntityList/js/entitylist-calendar.js`, { headers });
  assert.equal(client.status, 200);
  assert.match(await client.text(), /data-view="calendar"/);
});

test("a fixed-zone calendar feed sends user-local instants as the zone's wall clock with the behaviour flags", async () => {
  const { calendarEvents } = await import("../lib/list-views.mjs");
  const calendar = { start: "s", end: "e", summary: "n", organizer: "o", timeZoneMode: "specific", timeZoneCode: 85, startBehavior: "UserLocal", endBehavior: "TimeZoneIndependent" };
  const [summer, winter] = calendarEvents([{ id: "a", s: "2026-05-05T05:05:00Z", n: "Summer" }, { id: "b", s: "2026-01-15T09:00:00Z", e: "2026-01-15T10:00:00Z", n: "Winter", o: "x@example.invalid" }], { calendar, idColumn: "id" }).sort((a, b) => a.title < b.title ? -1 : 1);
  assert.deepEqual(summer, { id: "a", class: "event-info", title: "Summer", start: Date.parse("2026-05-05T06:05:00Z"), end: Date.parse("2026-05-05T06:05:00Z"), description: null, location: null, isconversionrequired: "false", startdatebehavior: "UserLocal", enddatebehavior: "TimeZoneIndependent" });
  // A time-zone-independent end is not shifted; the organizer is {name, email}.
  assert.equal(winter.end, Date.parse("2026-01-15T10:00:00Z"));
  assert.deepEqual(winter.organizer, { name: "x@example.invalid", email: null });
  assert.equal("url" in winter || "allDay" in winter, false);
});
