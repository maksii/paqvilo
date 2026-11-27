// List calendar views (adx_calendar_*): the server markup shell, the head resources the platform
// links, the language script and the event feed the calendar client reads. The platform's
// Bootstrap 5 calendar list renders `div.entitylist[data-view=calendar]` with data-calendar-url
// /EntityList/Calendar/{website}/{list}/{view}, loads Areas/EntityList calendar scripts and
// styles plus /EntityList/Calendar/{website}/language.js, and reads
// `{"success":1,"result":[...]}` from the calendar URL with from/to (UTC ISO) parameters.
import { portalField } from './importer.mjs';

const canonical = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const attr = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
const VIEWS = { 756150000: 'year', 756150001: 'month', 756150002: 'week', 756150003: 'day' };
const STYLES = { 756150000: 'full', 756150001: 'list' };
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * Calendar settings of an exported list, or null when the calendar view is off. With the solution
 * metadata the start and end columns carry their date-time behaviour (the feed reports it).
 */
export function calendarSettings(list, metadata = null) {
  const m = list?.metadata ?? {};
  const columns = metadata?.entities?.[canonical(list?.entityName)]?.fields ?? {};
  const behavior = (name) => (name && columns[name]?.dateTimeBehavior) || 'UserLocal';
  if (portalField(m, 'calendar_enabled', false) !== true) return null;
  const field = (name) => canonical(portalField(m, `calendar_${name}fieldname`, '')) || null;
  const initialDate = String(portalField(m, 'calendar_initialdate', '') ?? '');
  return {
    view: VIEWS[Number(portalField(m, 'calendar_initialview', 756150001))] ?? 'month',
    style: STYLES[Number(portalField(m, 'calendar_style', 756150000))] ?? 'full',
    // The calendar client takes "now" or yyyy-mm-dd.
    initialDate: /^\d{4}-\d{2}-\d{2}/.test(initialDate) ? initialDate.slice(0, 10) : 'now',
    start: field('startdate'),
    end: field('enddate'),
    allDay: field('allday'),
    summary: field('summary'),
    description: field('description'),
    location: field('location'),
    organizer: field('organizer'),
    // 756150000 user local, 756150001 the list's time zone (adx_calendar_timezone code).
    timeZoneMode: Number(portalField(m, 'calendar_timezonemode', 756150000)) === 756150001 ? 'specific' : 'user',
    timeZoneCode: portalField(m, 'calendar_timezone', null),
    startBehavior: behavior(field('startdate')),
    endBehavior: behavior(field('enddate')),
  };
}

/*
 * Dataverse time zone codes (timezonedefinition.timezonecode) of the zones a list's fixed calendar
 * time zone (adx_calendar_timezone) commonly names, as IANA zones. This bounded table leaves
 * instants unshifted for an unknown code.
 */
const TIME_ZONES = {
  4: 'America/Los_Angeles',
  10: 'America/Denver',
  20: 'America/Chicago',
  35: 'America/New_York',
  85: 'Europe/London',
  105: 'Europe/Paris',
  110: 'Europe/Berlin',
  235: 'Asia/Tokyo',
  255: 'Australia/Sydney',
};
/** The wall-clock time of an instant in a zone, written as a UTC instant. */
function wallClock(ms, zone) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(ms))
      .map((part) => [part.type, part.value]),
  );
  return (
    Date.UTC(
      Number(parts.year),
      Number(parts.month) - 1,
      Number(parts.day),
      Number(parts.hour) % 24,
      Number(parts.minute),
      Number(parts.second),
    ) +
    (ms % 1000)
  );
}

const variantPath = (variant) => (variant === 'BootstrapV5' ? 'BootstrapV5/' : '');
/** Stylesheets (end of head) and scripts (after the platform bundles) of a calendar list page. */
export function calendarResources({ websiteId, variant, culture, defaultCulture = 'en-US' }) {
  const v = variantPath(variant);
  const languageQuery = culture && culture !== defaultCulture ? `?culture=${encodeURIComponent(culture)}` : '';
  const stylesheets = [
    `/Areas/EntityList/css/${v}calendar.min.css`,
    `/Areas/EntityList/css/${v}entitylist-calendar.css`,
  ];
  const scripts = [
    `/Areas/EntityList/js/${v}calendar.min.js`,
    '/Areas/EntityList/js/entitylist-calendar.js',
    `/EntityList/Calendar/${canonical(websiteId)}/language.js${languageQuery}`,
  ];
  return {
    stylesheets,
    scripts,
    head: stylesheets.map((href) => `<link href="${attr(href)}" rel="stylesheet">`).join(''),
    body: scripts.map((src) => `<script src="${attr(src)}" type="text/javascript"></script>`).join('\n'),
  };
}

/** Server markup of a calendar list (the native EntityListControl). */
export function renderCalendarList({ list, calendar, websiteId, viewId, variant, culture = 'en-US' }) {
  const base = `/EntityList/Calendar/${canonical(websiteId)}/${canonical(list.id)}/${canonical(viewId)}`;
  return `<div id="EntityListControl_${attr(canonical(list.id).replaceAll('-', ''))}">
\t<div class="entitylist" data-calendar-url="${attr(base)}" data-calendar-download-url="${attr(base)}/icalendar" data-view="calendar" data-calendar-template-path="/Areas/EntityList/tmpls/${variantPath(variant)}" lang="${attr(culture)}" data-calendar-style="${attr(calendar.style)}" data-calendar-initial-view="${attr(calendar.view)}" data-calendar-initial-date="${attr(calendar.initialDate)}">
\t\t<div class="view"></div>
\t</div>
</div>`;
}

/** The calendar client's language table (window.calendar_languages[culture]) from ICU data. */
export function calendarLanguageScript(culture = 'en-US') {
  const month = (style) =>
    Array.from({ length: 12 }, (_, i) =>
      new Intl.DateTimeFormat(culture, { month: style, timeZone: 'UTC' }).format(Date.UTC(2026, i, 1)),
    );
  const day = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(culture, { weekday: 'long', timeZone: 'UTC' }).format(Date.UTC(2026, 1, 1 + i)),
  );
  let firstDay;
  try {
    firstDay = new Intl.Locale(culture).getWeekInfo?.().firstDay ?? new Intl.Locale(culture).weekInfo?.firstDay ?? 7;
  } catch {
    firstDay = 7;
  }
  const strings = {
    error_noview: 'Calendar: View {0} not found',
    error_dateformat: 'Calendar: Wrong date format {0}. Should be either "now" or "yyyy-mm-dd"',
    error_loadurl: 'Calendar: Event URL is not set',
    error_where: 'Calendar: Wrong navigation direction {0}. Can be only "next" or "prev" or "today"',
    error_timedevide:
      'Calendar: The time split parameter should divide 60 without decimals, for example, 10, 15, 30, and so on.',
    no_events_in_day: 'No events in this day.',
    title_year: '{0}',
    title_month: '{0} {1}',
    title_week: 'week {0} of {1}',
    title_day: '{0} {1} {2}, {3}',
    week: 'Week {0}',
    all_day: 'All day',
    time: 'Time',
    events: 'Events',
    before_time: 'Ends before timeline',
    after_time: 'Starts after timeline',
  };
  const lines = Object.entries(strings).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`);
  const names = [
    ...month('long').map((name, i) => `  m${i}: ${JSON.stringify(name)},`),
    '  m12: "",',
    ...month('short').map((name, i) => `  ms${i}: ${JSON.stringify(name)},`),
    '  ms12: "",',
    // Sunday first (d0), as the client indexes Date#getDay().
    ...day.map((name, i) => `  d${i}: ${JSON.stringify(name)},`),
  ];
  // The client's first_day: 1 Monday, 2 Sunday.
  // The platform view renders CRLF lines with two blank lines before the month names.
  return `\nif(!window.calendar_languages) {\n  window.calendar_languages = {};\n}\n\nwindow.calendar_languages[${JSON.stringify(culture)}] = {\n${lines.join('\n')}\n\n\n${names.join('\n\n')}\n\n  \n  first_day: ${firstDay === 7 ? 2 : 1}\n};\n`.replaceAll(
    '\n',
    '\r\n',
  );
}

const scalar = (value) =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value.value ?? value.id ?? value.name ?? null) : value;
const text = (value) => {
  if (value == null) return null;
  if (typeof value === 'object' && !Array.isArray(value)) return value.name ?? value.label ?? scalar(value);
  return String(value);
};

/**
 * The event feed of rows overlapping [from, to): numeric start/end instants (epoch ms), no event URL (with a
 * details page and a details action alike: hosted-f2 summary-F2 LIST-01f runs a-d), the organizer as {name, email},
 * and the conversion and date-time behaviour flags. A list with a fixed time zone sends user-local
 * instants as that zone's wall clock (05:05Z in May with time zone 85 is sent as 06:05) and no
 * client conversion.
 */
export function calendarEvents(rows, { calendar, idColumn, from, to, queryZone = 0 }) {
  const events = [];
  const inRange = calendarRangePredicate(calendar, { from, to, queryZone });
  const zone = calendar.timeZoneMode === 'specific' ? TIME_ZONES[Number(calendar.timeZoneCode)] : null;
  const shift = (ms, behavior) => (zone && behavior === 'UserLocal' ? wallClock(ms, zone) : ms);
  for (const row of rows) {
    const startValue = Date.parse(scalar(row[calendar.start]) ?? '');
    if (!Number.isFinite(startValue)) continue;
    const endValue = calendar.end ? Date.parse(scalar(row[calendar.end]) ?? '') : Number.NaN;
    const startMs = shift(startValue, calendar.startBehavior ?? 'UserLocal');
    const endMs = Number.isFinite(endValue) ? shift(endValue, calendar.endBehavior ?? 'UserLocal') : startMs;
    if (!inRange(startValue, Number.isFinite(endValue) ? endValue : null)) continue;
    const event = calendarEvent(row, { calendar, idColumn, startMs, endMs });
    if (!Number.isFinite(endValue)) OPEN_ENDED.add(event);
    events.push(event);
  }
  return events.sort((a, b) => a.start - b.start);
}

const DAY = 86400000;
/**
 * The platform's range predicate over the stored start and end (hosted-f2 summary-F2 LIST-01f runs e/f: 22 rows against
 * normal, reversed, empty and one-second-shifted ranges, with and without an all-day column, identical answers):
 * calendar days, both bounds inclusive, an event matches when its start day lies in [from, to], or its end day does, or
 * it starts on or before `from` and ends on or after `to`; a row without an end matches only by its start. A UserLocal
 * column's days, and the bounds compared with it, are read in the portal query zone (observed.portalQueryTimeZone,
 * minutes east of UTC as a number or a function of the instant); DateOnly and TimeZoneIndependent columns use the stored
 * date. A range that is not finite (the iCalendar download without a valid range) matches every event.
 */
function calendarRangePredicate(calendar, { from, to, queryZone }) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return () => true;
  const offset = typeof queryZone === 'function' ? queryZone : () => Number(queryZone) || 0;
  const dayOf = (ms, behavior) =>
    Math.floor((ms + ((behavior ?? 'UserLocal') === 'UserLocal' ? offset(ms) * 60000 : 0)) / DAY);
  const [startFrom, startTo] = [from, to].map((bound) => dayOf(bound, calendar.startBehavior));
  const [endFrom, endTo] = [from, to].map((bound) => dayOf(bound, calendar.endBehavior));
  return (start, end) => {
    const startDay = dayOf(start, calendar.startBehavior);
    if (startDay >= startFrom && startDay <= startTo) return true;
    if (end == null) return false;
    const endDay = dayOf(end, calendar.endBehavior);
    return (endDay >= endFrom && endDay <= endTo) || (startDay <= startFrom && endDay >= endTo);
  };
}

// Events of rows without an end value: the feed sends end = start, the iCalendar download no DTEND (captured).
const OPEN_ENDED = new WeakSet();

function calendarEvent(row, { calendar, idColumn, startMs, endMs }) {
  const id = canonical(row[idColumn]);
  const event = {
    id,
    class: 'event-info',
    title: text(row[calendar.summary]) ?? '',
  };
  event.start = startMs;
  event.end = endMs;
  event.description = calendar.description ? text(row[calendar.description]) : null;
  event.location = calendar.location ? text(row[calendar.location]) : null;
  const organizer = calendar.organizer ? text(row[calendar.organizer]) : null;
  if (organizer) event.organizer = { name: organizer, email: null };
  event.isconversionrequired = calendar.timeZoneMode === 'specific' ? 'false' : 'true';
  event.startdatebehavior = calendar.startBehavior ?? 'UserLocal';
  event.enddatebehavior = calendar.endBehavior ?? 'UserLocal';
  return event;
}

const icsDate = (ms) =>
  new Date(Number(ms))
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
// Carriage returns become line breaks before the escape, so no bare CR reaches the output; other control
// characters are dropped except the tab, which RFC 5545 allows in TEXT.
const icsText = (value) =>
  String(value ?? '')
    .replaceAll(/\r\n?/g, '\n')
    .replaceAll('\\', '\\\\')
    .replaceAll('\n', String.raw`\n`)
    .replaceAll(/[,;]/g, (c) => `\\${c}`)
    .replaceAll(/\p{Cc}/gu, (c) => (c === '\t' ? c : ''));
// The plain DESCRIPTION drops markup and turns line breaks into spaces; X-ALT-DESC keeps the HTML (captured).
function plainText(value) {
  const source = String(value ?? '');
  let out = '',
    cursor = 0;
  for (let open = source.indexOf('<'); open >= 0; open = source.indexOf('<', cursor)) {
    const close = source.indexOf('>', open + 1);
    if (close < 0) break;
    out += source.slice(cursor, open);
    cursor = close + 1;
  }
  return (out + source.slice(cursor)).replaceAll('\r\n', ' ').replaceAll(/[\r\n]/g, ' ');
}
// Content lines fold at 73 octets (75 with the CRLF); a continuation starts with one space (captured).
function fold(line) {
  const parts = [];
  let current = '',
    size = 0;
  for (const character of line) {
    const bytes = Buffer.byteLength(character);
    if (size + bytes > 73) {
      parts.push(current);
      current = ' ';
      size = 1;
    }
    current += character;
    size += bytes;
  }
  parts.push(current);
  return parts;
}
/**
 * iCalendar download of the calendar events, in the platform's shape (hosted-f2 summary-F2 LIST-01f runs a-d): UID
 * `<id>@<host>`, DTEND only for a row with an end, DTSTAMP the download time, DESCRIPTION and X-ALT-DESC when the
 * event has a description, a display alarm 15 minutes before with the summary.
 */
export function calendarIcs(events, { host = 'localhost', now = Date.now() } = {}) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Adxstudio Inc.//Adxstudio Portals//EN'];
  for (const event of events) {
    const summary = icsText(event.title);
    lines.push(
      'BEGIN:VEVENT',
      `UID:${event.id}@${host}`,
      `DTSTART:${icsDate(event.start)}`,
      ...(OPEN_ENDED.has(event) ? [] : [`DTEND:${icsDate(event.end)}`]),
      `DTSTAMP:${icsDate(now)}`,
      `SUMMARY:${summary}`,
      ...(event.description
        ? [
            `DESCRIPTION:${icsText(plainText(event.description))}`,
            `X-ALT-DESC;FMTTYPE=text/html:${icsText(event.description)}`,
          ]
        : []),
      'BEGIN:VALARM',
      'TRIGGER:-PT15M',
      'ACTION:DISPLAY',
      `DESCRIPTION:${summary}`,
      'END:VALARM',
      'END:VEVENT',
    );
  }
  lines.push('END:VCALENDAR');
  return lines.flatMap(fold).join('\r\n') + '\r\n';
}

// The feed's range format (yyyy-MM-ddTHH:mm:ssZ); milliseconds, epoch values, other zones or a missing value are
// refused, `from` first, each with its own message text (captured, hosted-f2 summary-F2 LIST-01f runs a-d).
const RANGE_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
export const CALENDAR_RANGE_ERRORS = Object.freeze({
  from: '"Unable to parse ""from"" parameter in required date format."',
  to: 'Unable to parse "to" parameter in required date format.',
});
/** The requested range as epoch ms, or `{ error: 'from' | 'to' }` for the first value that is not in the format. */
export function calendarRange(searchParams) {
  const range = {};
  for (const name of ['from', 'to']) {
    const value = searchParams.get(name) ?? '';
    const time = RANGE_FORMAT.test(value) ? Date.parse(value) : Number.NaN;
    if (!Number.isFinite(time)) return { error: name };
    range[name] = time;
  }
  return range;
}

/** `/EntityList/Calendar/{website}/language.js`, `/{website}/{list}/{view}[/icalendar]`. */
export function parseCalendarPath(pathname) {
  const match = /^\/EntityList\/Calendar\/([^/]+)(?:\/language\.js|\/([^/]+)\/([^/]+)(\/icalendar)?)\/?$/i.exec(
    pathname,
  );
  if (!match) return null;
  if (!GUID.test(match[1])) return null;
  if (!match[2]) return { kind: 'language', website: canonical(match[1]) };
  if (!GUID.test(match[2]) || !GUID.test(match[3])) return null;
  return {
    kind: match[4] ? 'icalendar' : 'events',
    website: canonical(match[1]),
    list: canonical(match[2]),
    view: canonical(match[3]),
  };
}

/** A rendered page carries a calendar list (the page shell then adds calendarResources). */
export const CALENDAR_MARKER = /<div class="entitylist" data-calendar-url="/;
