// The time zone portal queries evaluate UserLocal date conditions in (observed.portalQueryTimeZone).
//
// Hosted session F1 (DATA-03d, two runs, Liquid {% fetchxml %} and the portal Web API): on/today/yesterday/last-x-days and a
// zone-less datetime literal over a UserLocal column were evaluated in the visitor browser's zone (UTC+2 with EU daylight
// saving time, so a 21:30Z June row is on the next local day and a 21:30Z January row is not), while the same query
// directly against Dataverse as the same application user evaluated in UTC. Overriding the portal's time-zone cookies,
// even before a fresh sign-in, did not change the zone, so where the portal takes it from is not identified: it is
// modelled as a per-site observation naming an IANA zone, or "runtime" for the zone this local runtime is configured for.
// DateOnly and TimeZoneIndependent columns keep their own (zone-free) evaluation.

const formatters = new Map();
const formatterOf = (zone) => {
  if (!formatters.has(zone))
    formatters.set(
      zone,
      new Intl.DateTimeFormat('en-US', {
        timeZone: zone,
        hourCycle: 'h23',
        year: 'numeric',
        month: 'numeric',
        day: 'numeric',
        hour: 'numeric',
        minute: 'numeric',
        second: 'numeric',
      }),
    );
  return formatters.get(zone);
};

/** Whether `zone` is a time zone name this runtime's Intl data knows. */
export function isTimeZoneName(zone) {
  if (typeof zone !== 'string' || !zone || zone.length > 64) return false;
  try {
    formatterOf(zone);
    return true;
  } catch {
    return false;
  }
}

const QUARTER_HOUR = 15 * 60000;

/**
 * (utcMs) => minutes east of UTC in `zone` at that instant ("runtime": the zone of this process). Offsets change on
 * quarter-hour boundaries, so one evaluation per quarter hour is cached.
 */
export function zoneOffsetFunction(zone) {
  const name = zone === 'runtime' ? Intl.DateTimeFormat().resolvedOptions().timeZone : zone;
  const format = formatterOf(name);
  const cache = new Map();
  return (ms) => {
    const bucket = Math.floor(ms / QUARTER_HOUR);
    let offset = cache.get(bucket);
    if (offset === undefined) {
      const at = bucket * QUARTER_HOUR;
      const parts = Object.fromEntries(format.formatToParts(new Date(at)).map(({ type, value }) => [type, value]));
      const wall = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
      offset = Math.round((wall - at) / 60000);
      if (cache.size > 4096) cache.clear();
      cache.set(bucket, offset);
    }
    return offset;
  };
}
