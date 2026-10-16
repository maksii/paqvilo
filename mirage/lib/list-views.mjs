// List calendar views (adx_calendar_*): the server markup shell, the head resources the platform
// links, the language script and the event feed the calendar client reads. Evidence: a live
// Bootstrap 5 calendar list renders `div.entitylist[data-view=calendar]` with data-calendar-url
// /EntityList/Calendar/{website}/{list}/{view}, loads Areas/EntityList calendar scripts and
// styles plus /EntityList/Calendar/{website}/language.js, and reads
// `{"success":1,"result":[...]}` from the calendar URL with from/to (UTC ISO) parameters.
import { portalField } from "./importer.mjs";

const canonical = (value) => String(value ?? "").replace(/[{}]/g, "").toLowerCase();
const attr = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const VIEWS = { 756150000: "year", 756150001: "month", 756150002: "week", 756150003: "day" };
const STYLES = { 756150000: "full", 756150001: "list" };
const GUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

/**
 * Calendar settings of an exported list, or null when the calendar view is off. With the solution
 * metadata the start and end columns carry their date-time behaviour (the feed reports it).
 */
export function calendarSettings(list, metadata = null) {
  const m = list?.metadata ?? {};
  const columns = metadata?.entities?.[canonical(list?.entityName)]?.fields ?? {};
  const behavior = (name) => (name && columns[name]?.dateTimeBehavior) || "UserLocal";
  if (portalField(m, "calendar_enabled", false) !== true) return null;
  const field = (name) => canonical(portalField(m, `calendar_${name}fieldname`, "")) || null;
  const initialDate = String(portalField(m, "calendar_initialdate", "") ?? "");
  return {
    view: VIEWS[Number(portalField(m, "calendar_initialview", 756150001))] ?? "month",
    style: STYLES[Number(portalField(m, "calendar_style", 756150000))] ?? "full",
    // The calendar client takes "now" or yyyy-mm-dd.
    initialDate: /^\d{4}-\d{2}-\d{2}/.test(initialDate) ? initialDate.slice(0, 10) : "now",
    start: field("startdate"),
    end: field("enddate"),
    allDay: field("allday"),
    summary: field("summary"),
    description: field("description"),
    location: field("location"),
    organizer: field("organizer"),
    // 756150000 user local, 756150001 the list's time zone (adx_calendar_timezone code).
    timeZoneMode: Number(portalField(m, "calendar_timezonemode", 756150000)) === 756150001 ? "specific" : "user",
    timeZoneCode: portalField(m, "calendar_timezone", null),
    startBehavior: behavior(field("startdate")),
    endBehavior: behavior(field("enddate")),
  };
}

/*
 * Dataverse time zone codes (timezonedefinition.timezonecode) of the zones a list's fixed calendar
 * time zone (adx_calendar_timezone) commonly names, as IANA zones. This bounded table leaves
 * instants unshifted for an unknown code.
 */
const TIME_ZONES = { 4: "America/Los_Angeles", 10: "America/Denver", 20: "America/Chicago", 35: "America/New_York", 85: "Europe/London", 105: "Europe/Paris", 110: "Europe/Berlin", 235: "Asia/Tokyo", 255: "Australia/Sydney" };
/** The wall-clock time of an instant in a zone, written as a UTC instant. */
function wallClock(ms, zone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" }).formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour) % 24, Number(parts.minute), Number(parts.second)) + (ms % 1000);
}

const variantPath = (variant) => (variant === "BootstrapV5" ? "BootstrapV5/" : "");
/** Stylesheets (end of head) and scripts (after the platform bundles) of a calendar list page. */
export function calendarResources({ websiteId, variant }) {
  const v = variantPath(variant);
  const stylesheets = [`/Areas/EntityList/css/${v}calendar.min.css`, `/Areas/EntityList/css/${v}entitylist-calendar.css`];
  const scripts = [`/Areas/EntityList/js/${v}calendar.min.js`, "/Areas/EntityList/js/entitylist-calendar.js", `/EntityList/Calendar/${canonical(websiteId)}/language.js`];
  return {
    stylesheets,
    scripts,
    head: stylesheets.map((href) => `<link href="${attr(href)}" rel="stylesheet">`).join(""),
    body: scripts.map((src) => `<script src="${attr(src)}" type="text/javascript"></script>`).join("\n"),
  };
}

/** Server markup of a calendar list (the native EntityListControl). */
export function renderCalendarList({ list, calendar, websiteId, viewId, variant, culture = "en-US" }) {
  const base = `/EntityList/Calendar/${canonical(websiteId)}/${canonical(list.id)}/${canonical(viewId)}`;
  return `<div id="EntityListControl_${attr(canonical(list.id).replace(/-/g, ""))}">
\t<div class="entitylist" data-calendar-url="${attr(base)}" data-calendar-download-url="${attr(base)}/icalendar" data-view="calendar" data-calendar-template-path="/Areas/EntityList/tmpls/${variantPath(variant)}" lang="${attr(culture)}" data-calendar-style="${attr(calendar.style)}" data-calendar-initial-view="${attr(calendar.view)}" data-calendar-initial-date="${attr(calendar.initialDate)}">
\t\t<div class="view"></div>
\t</div>
</div>`;
}

/** The calendar client's language table (window.calendar_languages[culture]) from ICU data. */
export function calendarLanguageScript(culture = "en-US") {
  const month = (style) => Array.from({ length: 12 }, (_, i) => new Intl.DateTimeFormat(culture, { month: style, timeZone: "UTC" }).format(Date.UTC(2026, i, 1)));
  const day = Array.from({ length: 7 }, (_, i) => new Intl.DateTimeFormat(culture, { weekday: "long", timeZone: "UTC" }).format(Date.UTC(2026, 1, 1 + i)));
  let firstDay = 7;
  try {
    firstDay = new Intl.Locale(culture).getWeekInfo?.().firstDay ?? new Intl.Locale(culture).weekInfo?.firstDay ?? 7;
  } catch {
    firstDay = 7;
  }
  const strings = {
    error_noview: "Calendar: View {0} not found",
    error_dateformat: 'Calendar: Wrong date format {0}. Should be either "now" or "yyyy-mm-dd"',
    error_loadurl: "Calendar: Event URL is not set",
    error_where: 'Calendar: Wrong navigation direction {0}. Can be only "next" or "prev" or "today"',
    error_timedevide: "Calendar: The time split parameter should divide 60 without decimals, for example, 10, 15, 30, and so on.",
    no_events_in_day: "No events in this day.",
    title_year: "{0}",
    title_month: "{0} {1}",
    title_week: "week {0} of {1}",
    title_day: "{0} {1} {2}, {3}",
    week: "Week {0}",
    all_day: "All day",
    time: "Time",
    events: "Events",
    before_time: "Ends before timeline",
    after_time: "Starts after timeline",
  };
  const lines = Object.entries(strings).map(([key, value]) => `  ${key}: ${JSON.stringify(value)},`);
  const names = [
    ...month("long").map((name, i) => `  m${i}: ${JSON.stringify(name)},`), "  m12: \"\",",
    ...month("short").map((name, i) => `  ms${i}: ${JSON.stringify(name)},`), "  ms12: \"\",",
    // Sunday first (d0), as the client indexes Date#getDay().
    ...day.map((name, i) => `  d${i}: ${JSON.stringify(name)},`),
  ];
  // The client's first_day: 1 Monday, 2 Sunday.
  // The platform view renders CRLF lines with two blank lines before the month names (live language.js).
  return `\nif(!window.calendar_languages) {\n  window.calendar_languages = {};\n}\n\nwindow.calendar_languages[${JSON.stringify(culture)}] = {\n${lines.join("\n")}\n\n\n${names.join("\n\n")}\n\n  \n  first_day: ${firstDay === 7 ? 2 : 1}\n};\n`.replace(/\n/g, "\r\n");
}

const scalar = (value) => (value && typeof value === "object" && !Array.isArray(value) ? (value.value ?? value.id ?? value.name ?? null) : value);
const text = (value) => {
  if (value == null) return null;
  if (typeof value === "object" && !Array.isArray(value)) return value.name ?? value.label ?? scalar(value);
  return String(value);
};

/** Calendar events of rows inside [from, to): start/end in epoch milliseconds (strings). */
/**
 * The event feed (live list calendar feed): numeric start/end instants, the details URL only when
 * the list has a details page, the organizer as {name, email}, and the conversion and date-time
 * behaviour flags. A list with a fixed time zone sends user-local instants as that zone's wall
 * clock (live: 05:05Z in May with time zone 85 is sent as 06:05) and no client conversion.
 */
export function calendarEvents(rows, { calendar, idColumn, detailsUrl, idParameter = "id", from, to }) {
  const events = [];
  const zone = calendar.timeZoneMode === "specific" ? TIME_ZONES[Number(calendar.timeZoneCode)] : null;
  const shift = (ms, behavior) => (zone && behavior === "UserLocal" ? wallClock(ms, zone) : ms);
  for (const row of rows) {
    const startValue = Date.parse(scalar(row[calendar.start]) ?? "");
    if (!Number.isFinite(startValue)) continue;
    const endValue = calendar.end ? Date.parse(scalar(row[calendar.end]) ?? "") : NaN;
    const startMs = shift(startValue, calendar.startBehavior ?? "UserLocal");
    const endMs = Number.isFinite(endValue) ? shift(endValue, calendar.endBehavior ?? "UserLocal") : startMs;
    if ((Number.isFinite(to) && startMs >= to) || (Number.isFinite(from) && endMs < from)) continue;
    const id = canonical(row[idColumn]);
    const organizer = calendar.organizer ? text(row[calendar.organizer]) : null;
    events.push({
      id,
      class: "event-info",
      title: text(row[calendar.summary]) ?? "",
      ...(detailsUrl ? { url: `${detailsUrl}${detailsUrl.includes("?") ? "&" : "?"}${encodeURIComponent(idParameter)}=${id}` } : {}),
      start: startMs,
      end: endMs,
      description: calendar.description ? text(row[calendar.description]) : null,
      location: calendar.location ? text(row[calendar.location]) : null,
      ...(organizer ? { organizer: { name: organizer, email: null } } : {}),
      isconversionrequired: calendar.timeZoneMode === "specific" ? "false" : "true",
      startdatebehavior: calendar.startBehavior ?? "UserLocal",
      enddatebehavior: calendar.endBehavior ?? "UserLocal",
    });
  }
  return events.sort((a, b) => a.start - b.start);
}

const icsDate = (ms) => new Date(Number(ms)).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const icsText = (value) => String(value ?? "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/[,;]/g, (c) => `\\${c}`);
/** iCalendar download of the calendar events. */
export function calendarIcs(events) {
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Paqvilo Mirage//Calendar//EN"];
  for (const event of events)
    lines.push("BEGIN:VEVENT", `UID:${event.id}`, `DTSTART:${icsDate(event.start)}`, `DTEND:${icsDate(event.end)}`, `SUMMARY:${icsText(event.title)}`, ...(event.description ? [`DESCRIPTION:${icsText(event.description)}`] : []), ...(event.location ? [`LOCATION:${icsText(event.location)}`] : []), "END:VEVENT");
  lines.push("END:VCALENDAR");
  return lines.join("\r\n") + "\r\n";
}

/** `/EntityList/Calendar/{website}/language.js`, `/{website}/{list}/{view}[/icalendar]`. */
export function parseCalendarPath(pathname) {
  const match = /^\/EntityList\/Calendar\/([^/]+)(?:\/language\.js|\/([^/]+)\/([^/]+)(\/icalendar)?)\/?$/i.exec(pathname);
  if (!match) return null;
  if (!GUID.test(match[1])) return null;
  if (!match[2]) return { kind: "language", website: canonical(match[1]) };
  if (!GUID.test(match[2]) || !GUID.test(match[3])) return null;
  return { kind: match[4] ? "icalendar" : "events", website: canonical(match[1]), list: canonical(match[2]), view: canonical(match[3]) };
}

/** A rendered page carries a calendar list (the page shell then adds calendarResources). */
export const CALENDAR_MARKER = /<div class="entitylist" data-calendar-url="/;
