import { idOf, argsOf, rowOf } from './dataverse-message-context.mjs';
// Simulated Dataverse time zone and calendar messages: LocalTimeFromUtcTime, GetTimeZoneCodeByLocalizedName,
// GetAllTimeZonesWithDisplayName, ExpandCalendar, QuerySchedule, Search, RetrieveExchangeAppointments, Book, Reschedule,
// Validate, AddRecurrence, CreateInstance, CreateException, DeleteOpenInstances and ValidateRecurrenceRule.
//
// Time conversion: natively Windows converts and the timezonerule table is deprecated, so the simulator converts with IANA
// zones (Intl) for every platform time zone code (platform-time-zones.mjs TIME_ZONE_IDS).
// Recurrence expands on demand from the series rule. Materialised instance rows win over generated occurrences.
// ponytail: calendar rules repeat by RRULE FREQ=DAILY or WEEKLY only (other frequencies are refused), a lower rank trims a higher
// one on the same span, and Book on a series validates attendees against the first occurrence only.
import { randomUUID } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { privilegeDeniedError, privilegeName, uuidV5 } from './dataverse-security.mjs';
import { organizationRecord } from './organization-context.mjs';
import { contextUrl } from './dataverse-odata.mjs';
import { TIME_ZONE_DEFINITIONS, TIME_ZONE_IDS } from './platform-time-zones.mjs';

const MIN = 60000;
const DAY = 86400000;
const UTC_CODE = 92;
const LOCALE_EN_US = 1033;
const ZERO_GUID = '00000000-0000-0000-0000-000000000000';
const MAX_DAYS = 366 * 100;
// RecurrencePatternType 0 Daily, 1 Weekly, 2 Monthly, 3 Yearly. PatternEndType 1 No End Date, 2 Occurrences, 3 Pattern End Date.
const PATTERN = { daily: 0, weekly: 1, monthly: 2, yearly: 3 };
const END = { noEnd: 1, occurrences: 2, endDate: 3 };
// TimeCode enum 0 Available, 1 Busy, 2 Unavailable, 3 Filter.
const TIME_CODE = { Available: 0, Busy: 1, Unavailable: 2, Filter: 3 };
const BUSY = TIME_CODE.Busy;
// appointment InstanceTypeCode 2 is Recurring Instance (documented); 1 (series master) and 3 (exception) are a guess.
const INSTANCE = { master: 1, instance: 2, exception: 3 };
// SubCode 7 is Appointment.
const SUBCODE_APPOINTMENT = 7;
// The object type code of appointment in TimeInfo.SourceTypeCode is a guess.
const APPOINTMENT_OTC = 4201;

// ErrorInfo and ValidationResult carry no documented error-code strings; this name is a guess.
const ERROR_RESOURCE_BUSY = 'ResourceBusy';
// Book or Reschedule failed due to invalid data (0x80060914), the documented scheduling error.
const SCHEDULING_INVALID_DATA = {
  code: '0x80060914',
  message: 'Book or Reschedule operation failed due to invalid data.',
};

// Every platform code: Windows standard name and IANA zone (TIME_ZONE_IDS). Display names come from TIME_ZONE_DEFINITIONS.
const ZONES = TIME_ZONE_IDS.map(([code, standardName, iana]) => ({
  code,
  standardName,
  iana,
  userInterfaceName: TIME_ZONE_DEFINITIONS.find(([platform]) => platform === code)?.[1] ?? standardName,
}));
const ZONE_BY_CODE = new Map(ZONES.map((zone) => [zone.code, zone]));

const key = (value) => String(value ?? '').toLowerCase();
const sameId = (a, b) => key(a) === key(b);
// A GUID from a string, an object's id or @odata.id, or the first GUID-valued property of a reference object.

const tableOf = (store, logical) => (store.state.tables[logical] ??= []);
// Function parameters arrive as c.params and action parameters as the body; a SOAP call carries both.
const invalid = (message, innerCode = '0x80040203') => new DataError(message, 400, 'InvalidRequest', { innerCode });
const notFound = (logical, id) =>
  new DataError(`${logical} With Id = ${id} Does Not Exist`, 404, 'NotFound', { id, innerCode: '0x80040217' });
const schedulingInvalid = () =>
  new DataError(SCHEDULING_INVALID_DATA.message, 400, 'InvalidRequest', { innerCode: SCHEDULING_INVALID_DATA.code });
const instantOf = (value, name) => {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) throw invalid(`${name} must be a date and time.`);
  return ms;
};
const optionalInstant = (value) =>
  value === undefined || value === null || value === '' ? null : instantOf(value, 'date');
const integerOf = (value, name) => {
  const number = Number(value);
  if (value === undefined || value === null || value === '' || !Number.isInteger(number))
    throw invalid(`${name} must be an integer.`);
  return number;
};
const iso = (ms) => new Date(ms).toISOString();

// ---- time zones ----

const formatters = new Map();
function zoneFormat(iana) {
  let format = formatters.get(iana);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: iana,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    formatters.set(iana, format);
  }
  return format;
}

// The zone's offset from UTC at an instant, in minutes (positive east of Greenwich).
export function offsetMinutes(iana, utcMs) {
  const parts = Object.fromEntries(
    zoneFormat(iana)
      .formatToParts(new Date(utcMs))
      .map((part) => [part.type, Number(part.value)]),
  );
  const wallAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
  return Math.round((wallAsUtc - Math.floor(utcMs / 1000) * 1000) / MIN);
}

// The wall-clock fields of an instant in a zone.
function wallOf(iana, utcMs) {
  const offset = offsetMinutes(iana, utcMs);
  const wall = new Date(utcMs + offset * MIN);
  return {
    y: wall.getUTCFullYear(),
    m: wall.getUTCMonth() + 1,
    d: wall.getUTCDate(),
    hh: wall.getUTCHours(),
    mm: wall.getUTCMinutes(),
    offset,
  };
}

// The instant of a wall-clock time (given as if it were UTC) in a zone. A time inside a spring-forward gap resolves with the
// offset in force after the gap. ponytail: ambiguous fall-back times take the later offset, not the first occurrence.
function utcFromWall(iana, wallMs) {
  const first = offsetMinutes(iana, wallMs);
  return wallMs - offsetMinutes(iana, wallMs - first * MIN) * MIN;
}

const offsetText = (minutes) => {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`;
};

function zoneOf(code) {
  const zone = ZONE_BY_CODE.get(Number(code));
  if (!zone) throw invalid(`TimeZoneCode ${code} is not a supported time zone.`); // Native wording not known.
  return zone;
}

// Seeds the timezonedefinition and timezonelocalizedname rows for the seeded subset. The rule table is deprecated, so
// timezonerule has no rows.
function seedTimeZones(store) {
  const organizationId = organizationRecord(store)?.organizationid ?? ZERO_GUID;
  const definitions = tableOf(store, 'timezonedefinition');
  const localized = tableOf(store, 'timezonelocalizedname');
  definitions.length = 0;
  localized.length = 0;
  for (const zone of ZONES) {
    const timezonedefinitionid = uuidV5(organizationId, `timezonedefinition:${zone.code}`);
    // Bias is minutes west of UTC (the sign is a guess): the smaller of the January and July 2026 offsets, negated.
    const bias =
      -Math.min(offsetMinutes(zone.iana, Date.UTC(2026, 0, 15)), offsetMinutes(zone.iana, Date.UTC(2026, 6, 15))) || 0;
    definitions.push({
      timezonedefinitionid,
      timezonecode: zone.code,
      standardname: zone.standardName,
      userinterfacename: zone.userInterfaceName,
      bias,
      retiredorder: 0,
    });
    localized.push({
      timezonelocalizednameid: uuidV5(organizationId, `timezonelocalizedname:${zone.code}:${LOCALE_EN_US}`),
      timezonedefinitionid,
      cultureid: LOCALE_EN_US,
      standardname: zone.standardName,
      userinterfacename: zone.userInterfaceName,
    });
  }
}

// ---- recurrence ----

const dayNumber = (y, m, d) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
const weekdayOf = (y, m, d) => new Date(Date.UTC(y, m - 1, d)).getUTCDay();
const daysInMonth = (y, m) => new Date(Date.UTC(y, m, 0)).getUTCDate();
// The nth weekday of a month: 1..4, with 5 meaning the last. The instance picklist values are a guess.
const nthMatches = (instance, d, y, m) =>
  instance === 5 ? d + 7 > daysInMonth(y, m) : Math.floor((d - 1) / 7) + 1 === instance;

// The rule fields a series needs, checked the way the service checks a recurrence rule before it stores one.
function checkRule(rule) {
  const type = integerOf(rule.recurrencepatterntype, 'RecurrencePatternType');
  if (!Object.values(PATTERN).includes(type)) throw invalid('RecurrencePatternType must be 0, 1, 2 or 3.');
  if (rule.interval !== undefined && integerOf(rule.interval, 'Interval') < 1)
    throw invalid('Interval must be at least 1.');
  const endType = rule.patternendtype === undefined ? END.noEnd : integerOf(rule.patternendtype, 'PatternEndType');
  if (![END.noEnd, END.occurrences, END.endDate].includes(endType)) throw invalid('PatternEndType must be 1, 2 or 3.');
  if (endType === END.occurrences && integerOf(rule.occurrences, 'Occurrences') < 1)
    throw invalid('Occurrences must be at least 1.');
  if (endType === END.endDate) {
    if (rule.patternenddate == null) throw invalid('PatternEndDate is required for an end date.');
    if (instantOf(rule.patternenddate, 'PatternEndDate') < instantOf(rule.patternstartdate, 'PatternStartDate')) {
      throw invalid('PatternEndDate must be on or after PatternStartDate.');
    }
  }
  if (type === PATTERN.weekly) {
    const mask = integerOf(rule.daysofweekmask, 'DaysOfWeekMask');
    if (mask < 1 || mask > 127) throw invalid('DaysOfWeekMask must be between 1 and 127.');
  }
  if (type === PATTERN.monthly || type === PATTERN.yearly) {
    const day = integerOf(rule.dayofmonth, 'DayOfMonth');
    if (!rule.isnthmonthly && !rule.isnthyearly && (day < 1 || day > 31))
      throw invalid('DayOfMonth must be between 1 and 31.');
  }
  if (type === PATTERN.yearly) {
    const month = integerOf(rule.monthofyear, 'MonthOfYear');
    if (month < 1 || month > 12) throw invalid('MonthOfYear must be between 1 and 12.');
  }
  return type;
}

// Whether a local date (day number) is an occurrence of the rule. n0 is the day number of the pattern start.
function dayMatches(rule, n0, dayN, wall) {
  const { y, m, d } = wall;
  const type = Number(rule.recurrencepatterntype);
  const interval = Math.max(1, Number(rule.interval ?? 1));
  const start = fromDayNumber(n0);
  if (type === PATTERN.daily) return (dayN - n0) % interval === 0;
  if (type === PATTERN.weekly) {
    const first = Number(rule.firstdayofweek ?? 0);
    const offset = (weekdayOf(start.y, start.m, start.d) - first + 7) % 7;
    const week = Math.floor((dayN - n0 + offset) / 7);
    return week % interval === 0 && (Number(rule.daysofweekmask) & (1 << weekdayOf(y, m, d))) !== 0;
  }
  if (type === PATTERN.monthly) {
    if (((y - start.y) * 12 + (m - start.m)) % interval !== 0) return false;
    if (rule.isnthmonthly)
      return (
        (Number(rule.daysofweekmask) & (1 << weekdayOf(y, m, d))) !== 0 && nthMatches(Number(rule.instance), d, y, m)
      );
    return d === Number(rule.dayofmonth);
  }
  if (type === PATTERN.yearly) {
    if ((y - start.y) % interval !== 0 || m !== Number(rule.monthofyear)) return false;
    if (rule.isnthyearly)
      return (
        (Number(rule.daysofweekmask) & (1 << weekdayOf(y, m, d))) !== 0 && nthMatches(Number(rule.instance), d, y, m)
      );
    return d === Number(rule.dayofmonth);
  }
  return false;
}

function fromDayNumber(n) {
  const date = new Date(n * DAY);
  return { y: date.getUTCFullYear(), m: date.getUTCMonth() + 1, d: date.getUTCDate() };
}

function deletedOccurrences(master) {
  try {
    return new Set(JSON.parse(master.deletedexceptionslist || '[]').map((value) => Date.parse(value)));
  } catch {
    return new Set();
  }
}

// Occurrences of a series that overlap [fromMs, toMs), in start order. Each is { startMs, endMs, materialized }: materialized
// marks an occurrence that already has an instance or exception row, so callers read that row instead.
function seriesOccurrences(store, master, fromMs, toMs) {
  const rule = rowOf(store, 'recurrencerule', 'ruleid', idOf(master.ruleid));
  if (!rule) return [];
  const zone = zoneOf(master.utcconversiontimezonecode ?? UTC_CODE);
  const first = wallOf(zone.iana, instantOf(rule.patternstartdate, 'PatternStartDate'));
  const n0 = dayNumber(first.y, first.m, first.d);
  const time = wallOf(zone.iana, instantOf(rule.starttime ?? rule.patternstartdate, 'StartTime'));
  const durationMs = Number(rule.duration ?? master.duration ?? 0) * MIN;
  const lastWindow = wallOf(zone.iana, toMs);
  let lastDay = dayNumber(lastWindow.y, lastWindow.m, lastWindow.d);
  const endType = Number(rule.patternendtype ?? END.noEnd);
  if (endType === END.endDate) lastDay = Math.min(lastDay, dayNumber(...dateParts(zone.iana, rule.patternenddate)));
  const deleted = deletedOccurrences(master);
  const rows = tableOf(store, 'appointment').filter((row) => sameId(row.seriesid, master.activityid));
  const materialized = new Set(
    rows.flatMap((row) => [Date.parse(row.originalstartdate), Date.parse(row.scheduledstart)]).filter(Number.isFinite),
  );
  const limit = endType === END.occurrences ? Number(rule.occurrences) : Infinity;
  const out = [];
  let index = 0;
  for (let n = 0; n < MAX_DAYS && n0 + n <= lastDay; n += 1) {
    const dayN = n0 + n;
    const wall = fromDayNumber(dayN);
    if (!dayMatches(rule, n0, dayN, wall)) continue;
    index += 1;
    if (index > limit) break;
    const startMs = utcFromWall(zone.iana, Date.UTC(wall.y, wall.m - 1, wall.d, time.hh, time.mm));
    if (deleted.has(startMs)) continue;
    const endMs = startMs + durationMs;
    if (startMs >= toMs) break;
    if (endMs <= fromMs) continue;
    out.push({ startMs, endMs, materialized: materialized.has(startMs) });
  }
  return out;
}

function dateParts(iana, value) {
  const w = wallOf(iana, instantOf(value, 'PatternEndDate'));
  return [w.y, w.m, w.d];
}

// Busy blocks of a resource (an activityparty partyid) in [fromMs, toMs): its appointments, and the unmaterialised occurrences
// of its series. Each block is { activityId, startMs, endMs }.
function busyBlocks(store, resourceId, fromMs, toMs, exceptActivity = null) {
  const blocks = [];
  for (const party of tableOf(store, 'activityparty').filter((row) => sameId(row.partyid, resourceId))) {
    const activityId = idOf(party.activityid);
    if (!activityId || sameId(activityId, exceptActivity)) continue;
    const row = rowOf(store, 'appointment', 'activityid', activityId);
    if (row) {
      const startMs = Date.parse(row.scheduledstart);
      const endMs = Date.parse(row.scheduledend);
      if (row.statecode === 0 && startMs < toMs && fromMs < endMs) blocks.push({ activityId, startMs, endMs });
      continue;
    }
    const master = rowOf(store, 'recurringappointmentmaster', 'activityid', activityId);
    if (!master) continue;
    for (const occurrence of seriesOccurrences(store, master, fromMs, toMs)) {
      if (!occurrence.materialized) blocks.push({ activityId, startMs: occurrence.startMs, endMs: occurrence.endMs });
    }
  }
  return blocks.sort((left, right) => left.startMs - right.startMs);
}

// ---- availability and calendar rules ----

// Spans [start, end) in ms, as pairs. A span is cut by each cut span; the pieces left are returned.
function minus(spans, cuts) {
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
function intersect(left, right) {
  return left.flatMap(([s1, e1]) =>
    right.map(([s2, e2]) => [Math.max(s1, s2), Math.min(e1, e2)]).filter(([s, e]) => e > s),
  );
}

const RRULE_DAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };
const STEP = 15 * MIN;
// Inner calendars nest up to this depth.
const MAX_NEST = 5;

// A calendar rule's RRULE pattern as a recurrence rule. ponytail: FREQ DAILY or WEEKLY only; a weekly rule without BYDAY repeats
// on every day.
function patternOf(text) {
  const parts = Object.fromEntries(
    String(text)
      .split(';')
      .map((part) => {
        const [name, value = ''] = part.split('=');
        return [name.trim().toUpperCase(), value.trim().toUpperCase()];
      }),
  );
  if (parts.FREQ !== 'DAILY' && parts.FREQ !== 'WEEKLY')
    throw invalid('Calendar rule pattern must use FREQ=DAILY or FREQ=WEEKLY.');
  const interval = parts.INTERVAL === undefined ? 1 : integerOf(parts.INTERVAL, 'INTERVAL');
  if (interval < 1) throw invalid('INTERVAL must be at least 1.');
  let mask = 0;
  for (const day of (parts.BYDAY ?? '').split(',').filter(Boolean)) {
    if (!(day in RRULE_DAY)) throw invalid('BYDAY must name MO, TU, WE, TH, FR, SA or SU.');
    mask |= 1 << RRULE_DAY[day];
  }
  return {
    recurrencepatterntype: parts.FREQ === 'DAILY' ? PATTERN.daily : PATTERN.weekly,
    interval,
    daysofweekmask: mask || 127,
    firstdayofweek: 0,
  };
}

// Blocks of a calendar's rules overlapping [fromMs, toMs): { startMs, endMs, rule, calendarId }. A leaf rule is a block at its
// starttime, or inside an inner calendar at its offset from base (the day's local midnight). A pattern rule places a block, or
// its inner calendar's rules, on each matching day of its effective interval, in its zone or the calendar's zone (default UTC).
function expandRules(store, calendarId, fromMs, toMs, base = null, depth = 0) {
  if (depth > MAX_NEST) return [];
  const calendar = rowOf(store, 'calendar', 'calendarid', calendarId);
  const blocks = [];
  for (const rule of tableOf(store, 'calendarrule').filter((row) => sameId(idOf(row.calendarid), calendarId))) {
    if (!rule.pattern) {
      const startMs =
        base === null ? (rule.starttime ? Date.parse(rule.starttime) : NaN) : base + Number(rule.offset ?? 0) * MIN;
      const endMs = rule.duration != null ? startMs + Number(rule.duration) * MIN : Date.parse(rule.endtime);
      if (Number.isFinite(startMs) && Number.isFinite(endMs) && startMs < toMs && fromMs < endMs)
        blocks.push({ startMs, endMs, rule, calendarId });
      continue;
    }
    const zone = zoneOf(rule.timezonecode ?? calendar?.timezonecode ?? UTC_CODE);
    const recurrence = patternOf(rule.pattern);
    const first = wallOf(zone.iana, fromMs);
    const startDay = dayNumber(first.y, first.m, first.d);
    const last = wallOf(zone.iana, toMs);
    const endDay = dayNumber(last.y, last.m, last.d);
    const effectiveStart = rule.effectiveintervalstart
      ? dayNumber(...dateParts(zone.iana, rule.effectiveintervalstart))
      : -Infinity;
    const effectiveEnd = rule.effectiveintervalend
      ? dayNumber(...dateParts(zone.iana, rule.effectiveintervalend))
      : Infinity;
    const anchor = Number.isFinite(effectiveStart) ? effectiveStart : startDay;
    for (let dayN = startDay; dayN <= endDay && dayN - startDay < MAX_DAYS; dayN += 1) {
      if (dayN < effectiveStart || dayN > effectiveEnd) continue;
      const wall = fromDayNumber(dayN);
      if (!dayMatches(recurrence, anchor, dayN, wall)) continue;
      const midnight = utcFromWall(zone.iana, Date.UTC(wall.y, wall.m - 1, wall.d));
      if (rule.innercalendarid) {
        const dayFrom = Math.max(fromMs, midnight);
        const dayTo = Math.min(toMs, midnight + DAY);
        if (dayFrom < dayTo)
          blocks.push(...expandRules(store, idOf(rule.innercalendarid), dayFrom, dayTo, midnight, depth + 1));
        continue;
      }
      const startMs = midnight + Number(rule.offset ?? 0) * MIN;
      const endMs = startMs + Number(rule.duration ?? 0) * MIN;
      if (startMs < toMs && fromMs < endMs) blocks.push({ startMs, endMs, rule, calendarId });
    }
  }
  return blocks;
}

// Blocks from a lower rank trim the higher-rank blocks they cover (the rank direction is a guess).
function calendarBlocks(store, calendarId, fromMs, toMs) {
  const blocks = expandRules(store, calendarId, fromMs, toMs);
  const out = [];
  let covered = [];
  const ranks = [...new Set(blocks.map((block) => Number(block.rule.rank ?? 0)))].sort((a, b) => a - b);
  for (const rank of ranks) {
    const layer = blocks.filter((block) => Number(block.rule.rank ?? 0) === rank);
    for (const block of layer) {
      for (const [startMs, endMs] of minus([[block.startMs, block.endMs]], covered))
        out.push({ ...block, startMs, endMs });
    }
    covered = covered.concat(layer.map((block) => [block.startMs, block.endMs]));
  }
  return out.sort((left, right) => left.startMs - right.startMs);
}

// The resource's calendar (systemuser.calendarid), or null when it has none.
const calendarOf = (store, resourceId) => idOf(rowOf(store, 'systemuser', 'systemuserid', resourceId)?.calendarid);

// The spans a resource is available in the window: its Available calendar blocks, or the whole window without a calendar.
function availableSpans(store, resourceId, fromMs, toMs) {
  const calendarId = calendarOf(store, resourceId);
  if (!calendarId) return [[fromMs, toMs]];
  const spans = calendarBlocks(store, calendarId, fromMs, toMs)
    .filter((block) => Number(block.rule.timecode ?? TIME_CODE.Available) === TIME_CODE.Available)
    .map((block) => [block.startMs, block.endMs]);
  return intersect(spans, [[fromMs, toMs]]);
}

// The attendees (resources) of an activity, from its activityparty rows.
const attendeesOf = (store, activityId) =>
  tableOf(store, 'activityparty')
    .filter((row) => sameId(idOf(row.activityid), activityId))
    .map((row) => idOf(row.partyid))
    .filter(Boolean);

function setAttendees(store, activityId, attendeeIds) {
  const parties = tableOf(store, 'activityparty');
  for (let i = parties.length - 1; i >= 0; i -= 1)
    if (sameId(idOf(parties[i].activityid), activityId)) parties.splice(i, 1);
  for (const partyId of attendeeIds) {
    parties.push({
      activitypartyid: randomUUID(),
      activityid: activityId,
      partyid: partyId,
      partyobjecttypecode: 'systemuser',
      participationtypemask: 5,
    });
  }
}

// Conflicts of the given attendees with the window, as ErrorInfo-shaped entries (ErrorInfoList, ResourceList).
function conflictsFor(store, attendeeIds, startMs, endMs, exceptActivity) {
  const errors = [];
  for (const resourceId of attendeeIds) {
    const clash = busyBlocks(store, resourceId, startMs, endMs, exceptActivity);
    if (clash.length) errors.push({ ErrorCode: ERROR_RESOURCE_BUSY, ResourceList: [{ ResourceId: resourceId }] });
  }
  return errors;
}

const validationResult = (activityId, errors) => ({
  ActivityId: activityId,
  TraceInfo: { ErrorInfoList: errors },
  ValidationSuccess: errors.length === 0,
});

// Attendee ids from a body value: an array of GUIDs, references or party objects with partyid.
function attendeeIdsOf(value) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => idOf(entry?.partyid ?? entry)).filter(Boolean);
}

// The series owned by a master row: its rule, with the master fields the rule lacks.
function seriesRule(fields, master) {
  return {
    recurrencepatterntype: fields.recurrencepatterntype,
    interval: fields.interval ?? 1,
    daysofweekmask: fields.daysofweekmask,
    dayofmonth: fields.dayofmonth,
    monthofyear: fields.monthofyear,
    isnthmonthly: fields.isnthmonthly,
    isnthyearly: fields.isnthyearly,
    instance: fields.instance,
    firstdayofweek: fields.firstdayofweek ?? 0,
    patternstartdate: fields.patternstartdate ?? master.scheduledstart,
    patternendtype: fields.patternendtype ?? END.noEnd,
    occurrences: fields.occurrences,
    patternenddate: fields.patternenddate,
    starttime: fields.starttime ?? master.scheduledstart,
    endtime: fields.endtime ?? master.scheduledend,
    duration: fields.duration,
  };
}

// Creates a series: a rule row, a master row and its attendees. Returns the master row.
function createSeries(store, fields, attendeeIds) {
  const organizationId = organizationRecord(store)?.organizationid ?? ZERO_GUID;
  const ruleid = randomUUID();
  const activityid = randomUUID();
  const master = {
    activityid,
    subject: fields.subject ?? '',
    scheduledstart: fields.starttime ?? fields.patternstartdate,
    scheduledend: fields.endtime,
    duration: fields.duration,
    utcconversiontimezonecode: fields.utcconversiontimezonecode ?? UTC_CODE,
    ruleid,
    deletedexceptionslist: '[]',
    statecode: 0,
    statuscode: 1,
    instancetypecode: INSTANCE.master,
    organizationid: organizationId,
  };
  const rule = { ...seriesRule(fields, master), ruleid, statecode: 0, statuscode: 1 };
  checkRule(rule);
  tableOf(store, 'recurrencerule').push(rule);
  tableOf(store, 'recurringappointmentmaster').push(master);
  setAttendees(store, activityid, attendeeIds);
  return master;
}

// Validates a rule given as an object or a recurrencerule reference, and returns the description.
function describeRule(rule) {
  const type = checkRule(rule);
  const every = Number(rule.interval ?? 1);
  const names = ['day', 'week', 'month', 'year'];
  return `Every ${every} ${names[type]}${every === 1 ? '' : 's'}`; // Native description wording not known.
}

// ---- operations ----

function operations(api) {
  const { store } = api;
  const write = (fn) => api.change(() => store.transact(fn, { isolated: true }));
  const need = (c, logical, right) => {
    const privilege = privilegeName(right, api.principals.privilegeNoun(logical));
    if (!(api.principals.privileges(c.user).get(privilege) > 0)) throw privilegeDeniedError(c.user, privilege, logical);
  };
  const respond = (c, name, payload) => ({
    status: 200,
    body: { '@odata.context': contextUrl(c.origin, c.version, `Microsoft.Dynamics.CRM.${name}Response`), ...payload },
  });
  const now = () => api.clock?.() ?? Date.now();
  // The appointment or series a Book, Reschedule or Validate names: a target id, or a Target / Activities value in the body.
  const targetRow = (c, args) => {
    const id = c.target?.id ?? idOf(args.Target) ?? idOf(args.activityid) ?? idOf(args.id);
    if (!id) throw schedulingInvalid();
    const row =
      rowOf(store, 'appointment', 'activityid', id) ?? rowOf(store, 'recurringappointmentmaster', 'activityid', id);
    if (!row) throw notFound('appointment', id);
    return row;
  };

  return [
    {
      name: 'LocalTimeFromUtcTime',
      kind: 'function',
      binding: 'unbound',
      // ponytail: time zone reads are not privilege-checked; the platform's time zone tables are read-only reference data.
      handle: (c) => {
        const args = argsOf(c);
        const zone = zoneOf(integerOf(args.TimeZoneCode, 'TimeZoneCode'));
        const utc = instantOf(args.UtcTime, 'UtcTime');
        const wall = wallOf(zone.iana, utc);
        const localMs = utc + wall.offset * MIN;
        return respond(c, 'LocalTimeFromUtcTime', {
          LocalTime: `${iso(localMs).slice(0, 19)}${offsetText(wall.offset)}`,
        });
      },
      csdl: null,
    },
    {
      name: 'GetTimeZoneCodeByLocalizedName',
      kind: 'function',
      binding: 'unbound',
      // Matches the standard or display name, case-insensitive. The native not-found wording and code are not known.
      handle: (c) => {
        const args = argsOf(c);
        const name = String(args.LocalizedStandardName ?? '');
        if (!name.trim()) throw invalid('LocalizedStandardName is required.');
        const row = tableOf(store, 'timezonelocalizedname').find(
          (entry) => sameId(entry.standardname, name) || sameId(entry.userinterfacename, name),
        );
        if (!row) throw new DataError(`No time zone is named ${name}.`, 404, 'NotFound', { innerCode: '0x80040217' });
        return respond(c, 'GetTimeZoneCodeByLocalizedName', {
          TimeZoneCode:
            rowOf(store, 'timezonedefinition', 'timezonedefinitionid', idOf(row.timezonedefinitionid))?.timezonecode ??
            null,
        });
      },
      csdl: null,
    },
    {
      name: 'GetAllTimeZonesWithDisplayName',
      kind: 'function',
      binding: 'collection',
      entity: 'timezonedefinition',
      // Returns the display name attribute only, in store order (the native order is not known).
      handle: (c) => ({
        status: 200,
        body: {
          '@odata.context': contextUrl(c.origin, c.version, 'timezonedefinitions'),
          value: tableOf(store, 'timezonedefinition').map((row) => ({ userinterfacename: row.userinterfacename })),
        },
      }),
      csdl: null,
    },
    {
      name: 'ExpandCalendar',
      kind: 'function',
      binding: 'entity',
      entity: 'calendar',
      // The calendar's blocks overlapping [Start, End): leaf rules and pattern rules, with inner calendars expanded.
      handle: (c) => {
        need(c, 'calendarrule', 'Read');
        const args = argsOf(c);
        const calendarId = c.target?.id;
        if (!rowOf(store, 'calendar', 'calendarid', calendarId)) throw notFound('calendar', calendarId);
        const fromMs = instantOf(args.Start, 'Start');
        const toMs = instantOf(args.End, 'End');
        const result = calendarBlocks(store, calendarId, fromMs, toMs).map(({ startMs, endMs, rule }) => ({
          ActivityStatusCode: 0,
          CalendarId: calendarId,
          DisplayText: rule.name ?? '',
          Effort: Number(rule.effort ?? 0),
          End: iso(endMs),
          IsActivity: false,
          SourceId: rule.calendarruleid,
          SourceTypeCode: 0,
          Start: iso(startMs),
          SubCode: rule.subcode ?? 0,
          TimeCode: rule.timecode ?? 0,
        }));
        return respond(c, 'ExpandCalendar', { result });
      },
      csdl: null,
    },
    {
      name: 'QuerySchedule',
      kind: 'function',
      binding: 'unbound',
      // Busy blocks of the resource (its appointments and series occurrences). Available is the resource's calendar minus Busy;
      // Unavailable is the window minus Available. A resource with no calendar has Busy blocks only.
      // Whether native splits Available around Busy is a guess.
      handle: (c) => {
        need(c, 'appointment', 'Read');
        const args = argsOf(c);
        const resourceId = idOf(args.ResourceId);
        if (!resourceId) throw invalid('ResourceId must be a GUID.');
        const codes = (Array.isArray(args.TimeCodes) ? args.TimeCodes : [args.TimeCodes]).map((code) => {
          if (typeof code === 'number' || /^\d+$/.test(String(code))) return Number(code);
          const name = String(code).replace(/^.*'(\w+)'$/, '$1');
          if (!(name in TIME_CODE)) throw invalid('TimeCodes must be Available, Busy, Unavailable or Filter.');
          return TIME_CODE[name];
        });
        const fromMs = instantOf(args.Start, 'Start');
        const toMs = instantOf(args.End, 'End');
        const calendarId = calendarOf(store, resourceId);
        const busy = busyBlocks(store, resourceId, fromMs, toMs);
        const available = calendarId ? availableSpans(store, resourceId, fromMs, toMs) : null;
        const info = (startMs, endMs, timeCode, extra) => ({
          ActivityStatusCode: 0,
          CalendarId: null,
          DisplayText: '',
          Effort: 0,
          End: iso(endMs),
          IsActivity: false,
          SourceId: null,
          SourceTypeCode: 0,
          Start: iso(startMs),
          SubCode: 0,
          TimeCode: timeCode,
          ...extra,
        });
        const TimeInfos = [];
        if (codes.includes(BUSY)) {
          for (const block of busy) {
            TimeInfos.push({
              ActivityStatusCode: 0,
              CalendarId: null,
              DisplayText: '',
              Effort: 0,
              End: iso(block.endMs),
              IsActivity: true,
              SourceId: block.activityId,
              SourceTypeCode: APPOINTMENT_OTC,
              Start: iso(block.startMs),
              SubCode: SUBCODE_APPOINTMENT,
              TimeCode: BUSY,
            });
          }
        }
        if (available && codes.includes(TIME_CODE.Available)) {
          for (const [startMs, endMs] of minus(
            available,
            busy.map((block) => [block.startMs, block.endMs]),
          )) {
            TimeInfos.push(info(startMs, endMs, TIME_CODE.Available, { CalendarId: calendarId }));
          }
        }
        if (available && codes.includes(TIME_CODE.Unavailable)) {
          for (const [startMs, endMs] of minus([[fromMs, toMs]], available)) {
            TimeInfos.push(info(startMs, endMs, TIME_CODE.Unavailable, { CalendarId: calendarId }));
          }
        }
        return respond(c, 'QuerySchedule', {
          TimeInfos: TimeInfos.sort((left, right) => Date.parse(left.Start) - Date.parse(right.Start)),
        });
      },
      csdl: null,
    },
    {
      name: 'Search',
      kind: 'function',
      binding: 'unbound',
      // Proposes times when every required resource is free. Free means inside its Available calendar blocks (or the
      // whole window without a calendar) and outside its Busy blocks. ponytail: 15-minute steps. The defaults for Direction
      // and NumberOfResults and the error codes are a guess. The service and resource specification tables are
      // absent natively, so a ServiceId or ResourceSpecId is refused (400 0x80040203).
      signature: { params: [['AppointmentRequest', 'Edm.String']], response: [['SearchResults', 'Edm.String']] },
      handle: (c) => {
        need(c, 'appointment', 'Read');
        const args = argsOf(c);
        const request = args.AppointmentRequest ?? args;
        const requiredResources = Array.isArray(request.RequiredResources) ? request.RequiredResources : [];
        if (request.ServiceId || request.ResourceSpecId || requiredResources.some((entry) => entry?.ResourceSpecId)) {
          throw invalid('Services and resource specifications are not simulated.');
        }
        const durationMs = integerOf(request.Duration, 'Duration') * MIN;
        if (durationMs <= 0) throw invalid('Duration must be at least 1 minute.');
        const fromMs = instantOf(request.SearchWindowStart, 'SearchWindowStart');
        const toMs = instantOf(request.SearchWindowEnd, 'SearchWindowEnd');
        const direction = request.Direction === undefined ? 0 : integerOf(request.Direction, 'Direction');
        if (direction !== 0 && direction !== 1) throw invalid('Direction must be 0 (forward) or 1 (backward).');
        const limit =
          request.NumberOfResults === undefined ? 10 : integerOf(request.NumberOfResults, 'NumberOfResults');
        const resources = requiredResources.map((entry) => {
          const id = idOf(entry?.ResourceId);
          if (!id) throw invalid('ResourceId must be a GUID.');
          const row = rowOf(store, 'systemuser', 'systemuserid', id);
          const free = minus(
            intersect(availableSpans(store, id, fromMs, toMs), [[fromMs, toMs]]),
            busyBlocks(store, id, fromMs, toMs).map((block) => [block.startMs, block.endMs]),
          );
          return { id, name: row?.fullname ?? id, free };
        });
        if (!resources.length) throw invalid('RequiredResources must name at least one resource.');
        const common = resources.reduce((spans, resource) => intersect(spans, resource.free), [[fromMs, toMs]]);
        const starts = [];
        for (const [s, e] of direction === 0 ? common : [...common].reverse()) {
          if (direction === 0) {
            for (let t = Math.ceil(s / STEP) * STEP; t + durationMs <= e && starts.length < limit; t += STEP)
              starts.push(t);
          } else {
            for (let t = Math.floor((e - durationMs) / STEP) * STEP; t >= s && starts.length < limit; t -= STEP)
              starts.push(t);
          }
        }
        const Proposals = starts.map((startMs) => ({
          Start: iso(startMs),
          End: iso(startMs + durationMs),
          SiteId: null,
          SiteName: null,
          ProposalParties: resources.map((resource) => ({
            ResourceId: resource.id,
            ResourceSpecId: null,
            DisplayName: resource.name,
            EntityName: 'systemuser',
            EffortRequired: 1,
          })),
        }));
        const busyOnes = resources.filter((resource) => resource.free.length === 0);
        const ResourceList = (busyOnes.length ? busyOnes : resources).map((resource) => ({
          Id: resource.id,
          DisplayName: resource.name,
          EntityName: 'systemuser',
        }));
        const ErrorInfoList = Proposals.length ? [] : [{ ErrorCode: ERROR_RESOURCE_BUSY, ResourceList }];
        return respond(c, 'Search', { SearchResults: { Proposals, TraceInfo: { ErrorInfoList } } });
      },
    },
    {
      name: 'RetrieveExchangeAppointments',
      kind: 'function',
      binding: 'unbound',
      // The caller's appointments overlapping [StartDate, EndDate). ponytail: the store stands in for Exchange.
      // The response shape, and whether activityid is present on each row, are a guess.
      signature: {
        params: [
          ['StartDate', 'Edm.DateTimeOffset'],
          ['EndDate', 'Edm.DateTimeOffset'],
        ],
        response: [['BusinessEntityCollection', 'Edm.String']],
      },
      handle: (c) => {
        need(c, 'appointment', 'Read');
        const args = argsOf(c);
        const fromMs = instantOf(args.StartDate, 'StartDate');
        const toMs = instantOf(args.EndDate, 'EndDate');
        const mine = new Set(
          tableOf(store, 'activityparty')
            .filter((row) => sameId(idOf(row.partyid), c.user?.systemuserid))
            .map((row) => key(idOf(row.activityid))),
        );
        const BusinessEntities = tableOf(store, 'appointment').filter(
          (row) =>
            mine.has(key(row.activityid)) &&
            Date.parse(row.scheduledstart) < toMs &&
            fromMs < Date.parse(row.scheduledend),
        );
        return respond(c, 'RetrieveExchangeAppointments', {
          BusinessEntityCollection: { BusinessEntities, EntityName: 'appointment' },
        });
      },
    },
    {
      name: 'Book',
      kind: 'action',
      binding: 'unbound',
      // A new appointment or series is written when no attendee conflicts. A conflict answers 200 with ValidationSuccess false
      // and writes nothing. A missing or reversed time fails with the documented 0x80060914.
      handle: async (c) => {
        const args = argsOf(c);
        const isSeries = args.recurrencepatterntype !== undefined;
        need(c, 'appointment', 'Write');
        const attendees = attendeeIdsOf(args.requiredattendees ?? args.RequiredAttendees);
        if (isSeries) {
          const startMs = optionalInstant(args.starttime ?? args.patternstartdate);
          if (startMs === null) throw schedulingInvalid();
          describeRule(args);
          const errors = conflictsFor(store, attendees, startMs, startMs + Number(args.duration ?? 0) * MIN, null);
          if (errors.length)
            return respond(c, 'Book', { Notifications: [], ValidationResult: validationResult(ZERO_GUID, errors) });
          let activityId = null;
          await write(() => {
            activityId = createSeries(store, args, attendees).activityid;
          });
          return respond(c, 'Book', { Notifications: [], ValidationResult: validationResult(activityId, []) });
        }
        const startMs = optionalInstant(args.scheduledstart);
        const endMs = optionalInstant(args.scheduledend);
        if (startMs === null || endMs === null || endMs <= startMs) throw schedulingInvalid();
        const errors = conflictsFor(store, attendees, startMs, endMs, idOf(args.activityid));
        const activityId = idOf(args.activityid) ?? randomUUID();
        if (errors.length)
          return respond(c, 'Book', { Notifications: [], ValidationResult: validationResult(activityId, errors) });
        await write(() => {
          tableOf(store, 'appointment').push({
            activityid: activityId,
            subject: args.subject ?? '',
            scheduledstart: iso(startMs),
            scheduledend: iso(endMs),
            scheduleddurationminutes: Math.round((endMs - startMs) / MIN),
            statecode: 0,
            statuscode: 1,
            instancetypecode: 0,
          });
          setAttendees(store, activityId, attendees);
        });
        return respond(c, 'Book', { Notifications: [], ValidationResult: validationResult(activityId, []) });
      },
      csdl: null,
    },
    {
      name: 'Reschedule',
      kind: 'action',
      binding: 'unbound',
      // Moves the appointment after the same conflict check as Book; a conflict writes nothing.
      handle: async (c) => {
        const args = argsOf(c);
        need(c, 'appointment', 'Write');
        const row = targetRow(c, args);
        const startMs = optionalInstant(args.scheduledstart ?? args.starttime) ?? Date.parse(row.scheduledstart);
        const endMs = optionalInstant(args.scheduledend ?? args.endtime) ?? Date.parse(row.scheduledend);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) throw schedulingInvalid();
        const errors = conflictsFor(store, attendeesOf(store, row.activityid), startMs, endMs, row.activityid);
        if (errors.length)
          return respond(c, 'Reschedule', {
            Notifications: [],
            ValidationResult: validationResult(row.activityid, errors),
          });
        // The transaction may replace the state, so the row is read again inside it.
        const logical = 'ruleid' in row ? 'recurringappointmentmaster' : 'appointment';
        await write(() => {
          const current = rowOf(store, logical, 'activityid', row.activityid);
          current.scheduledstart = iso(startMs);
          current.scheduledend = iso(endMs);
          // A series keeps its minutes on the master's duration; an appointment on scheduleddurationminutes.
          const minutes = Math.round((endMs - startMs) / MIN);
          if ('duration' in current) current.duration = minutes;
          else current.scheduleddurationminutes = minutes;
        });
        return respond(c, 'Reschedule', { Notifications: [], ValidationResult: validationResult(row.activityid, []) });
      },
      csdl: null,
    },
    {
      name: 'Validate',
      kind: 'action',
      binding: 'unbound',
      // Verifies that each appointment has available resources for its time. Activities is a collection of references.
      handle: (c) => {
        need(c, 'appointment', 'Read');
        const activities = argsOf(c).Activities;
        if (!Array.isArray(activities)) throw invalid('Activities must be a collection.');
        const Result = activities.map((activity) => {
          const activityId = idOf(activity);
          const row = rowOf(store, 'appointment', 'activityid', activityId);
          if (!row) throw notFound('activitypointer', activityId);
          const startMs = Date.parse(row.scheduledstart);
          const endMs = Date.parse(row.scheduledend);
          return validationResult(
            activityId,
            conflictsFor(store, attendeesOf(store, activityId), startMs, endMs, activityId),
          );
        });
        return respond(c, 'Validate', { Result });
      },
      csdl: null,
    },
    {
      name: 'AddRecurrence',
      kind: 'action',
      binding: 'entity',
      entity: 'appointment',
      // Converts the bound appointment into the first instance of a new series described by Target (a recurringappointmentmaster).
      handle: async (c) => {
        need(c, 'appointment', 'Write');
        const appointment = rowOf(store, 'appointment', 'activityid', c.target?.id);
        if (!appointment) throw notFound('appointment', c.target?.id);
        const fields = { ...argsOf(c).Target };
        let master = null;
        await write(() => {
          const current = rowOf(store, 'appointment', 'activityid', appointment.activityid);
          master = createSeries(
            store,
            { subject: current.subject, starttime: current.scheduledstart, endtime: current.scheduledend, ...fields },
            attendeesOf(store, current.activityid),
          );
          current.seriesid = master.activityid;
          current.instancetypecode = INSTANCE.instance;
        });
        return respond(c, 'AddRecurrence', { ...master });
      },
      csdl: null,
    },
    {
      name: 'CreateInstance',
      kind: 'action',
      binding: 'unbound',
      // Materialises the next Count unexpanded occurrences of the series as instance rows. SeriesCanBeExpanded is true while
      // occurrences remain beyond the materialised ones.
      handle: async (c) => {
        need(c, 'appointment', 'Write');
        const args = argsOf(c);
        const count = integerOf(args.Count, 'Count');
        if (count < 1) throw invalid('Count must be at least 1.');
        const id = idOf(args.Target) ?? c.target?.id;
        const master = rowOf(store, 'recurringappointmentmaster', 'activityid', id);
        if (!master) throw notFound('recurringappointmentmaster', id);
        const horizon = Date.parse('2100-01-01T00:00:00Z');
        const pending = seriesOccurrences(store, master, 0, horizon).filter((occurrence) => !occurrence.materialized);
        const chosen = pending.slice(0, count);
        await write(() => {
          for (const occurrence of chosen) {
            const instanceId = randomUUID();
            tableOf(store, 'appointment').push({
              activityid: instanceId,
              subject: master.subject ?? '',
              scheduledstart: iso(occurrence.startMs),
              scheduledend: iso(occurrence.endMs),
              scheduleddurationminutes: Math.round((occurrence.endMs - occurrence.startMs) / MIN),
              seriesid: master.activityid,
              originalstartdate: iso(occurrence.startMs),
              instancetypecode: INSTANCE.instance,
              statecode: 0,
              statuscode: 1,
            });
            setAttendees(store, instanceId, attendeesOf(store, master.activityid));
          }
        });
        return respond(c, 'CreateInstance', { SeriesCanBeExpanded: pending.length > chosen.length });
      },
      csdl: null,
    },
    {
      name: 'CreateException',
      kind: 'action',
      binding: 'collection',
      entity: 'recurringappointmentmaster',
      // An instance of a series becomes an exception (IsDeleted false), or is deleted from the series (IsDeleted true, which
      // records the original start in deletedexceptionslist). The series is the Target's seriesid.
      handle: async (c) => {
        need(c, 'appointment', 'Write');
        const args = argsOf(c);
        const target = rowOf(store, 'appointment', 'activityid', idOf(args.Target));
        if (!target) throw notFound('appointment', idOf(args.Target));
        const seriesId = idOf(target.seriesid) ?? idOf(args.seriesid);
        const master = rowOf(store, 'recurringappointmentmaster', 'activityid', seriesId);
        if (!master) throw notFound('recurringappointmentmaster', seriesId);
        const originalMs = instantOf(args.OriginalStartDate, 'OriginalStartDate');
        const isDeleted = args.IsDeleted === true || args.IsDeleted === 'true';
        await write(() => {
          const currentMaster = rowOf(store, 'recurringappointmentmaster', 'activityid', master.activityid);
          const current = rowOf(store, 'appointment', 'activityid', target.activityid);
          if (isDeleted) {
            const list = deletedOccurrences(currentMaster);
            list.add(originalMs);
            currentMaster.deletedexceptionslist = JSON.stringify([...list].map(iso));
            const rows = tableOf(store, 'appointment');
            const index = rows.findIndex(
              (row) =>
                sameId(row.seriesid, currentMaster.activityid) && Date.parse(row.originalstartdate) === originalMs,
            );
            if (index >= 0) rows.splice(index, 1);
          } else {
            current.seriesid = currentMaster.activityid;
            current.originalstartdate = iso(originalMs);
            current.instancetypecode = INSTANCE.exception;
          }
        });
        return respond(c, 'CreateException', { id: isDeleted ? ZERO_GUID : target.activityid });
      },
      csdl: null,
    },
    {
      name: 'DeleteOpenInstances',
      kind: 'action',
      binding: 'unbound',
      // Deletes open instances starting on or after SeriesEndDate, and moves open instances already past to StateOfPastInstances.
      // The past-instance state mapping and the boundary are a guess.
      handle: async (c) => {
        need(c, 'appointment', 'Write');
        const args = argsOf(c);
        const id = idOf(args.Target) ?? c.target?.id;
        const master = rowOf(store, 'recurringappointmentmaster', 'activityid', id);
        if (!master) throw notFound('recurringappointmentmaster', id);
        const endMs = instantOf(args.SeriesEndDate, 'SeriesEndDate');
        const past = integerOf(args.StateOfPastInstances, 'StateOfPastInstances');
        const nowMs = now();
        await write(() => {
          const rows = tableOf(store, 'appointment');
          for (let i = rows.length - 1; i >= 0; i -= 1) {
            const row = rows[i];
            if (!sameId(row.seriesid, master.activityid) || row.statecode !== 0) continue;
            if (Date.parse(row.scheduledstart) >= endMs) rows.splice(i, 1);
            else if (Date.parse(row.scheduledend) < nowMs) row.statecode = past;
          }
        });
        return { status: 204 };
      },
      csdl: null,
    },
    {
      name: 'ValidateRecurrenceRule',
      kind: 'function',
      binding: 'unbound',
      // Target is a recurrencerule reference or the rule's fields. Returns a description when the rule is valid.
      handle: (c) => {
        const target = argsOf(c).Target;
        const stored = rowOf(store, 'recurrencerule', 'ruleid', idOf(target));
        const rule = stored ?? target;
        if (!rule || typeof rule !== 'object') throw invalid('Target must be a recurrence rule.');
        return respond(c, 'ValidateRecurrenceRule', { Description: describeRule(rule) });
      },
      csdl: null,
    },
  ];
}

// ponytail: no CSDL fragments, so these operations are served but absent from $metadata until a client needs them.
export function install(api) {
  for (const op of operations(api)) api.registry.register(op);
  return api.store.transact(() => seedTimeZones(api.store));
}

function reset(api) {
  return api.store.transact(() => seedTimeZones(api.store));
}

export const EXTENSION = { name: 'dataverse-calendar-messages', install, reset };
