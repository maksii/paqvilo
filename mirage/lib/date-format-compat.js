/* Local fallbacks for the platform's Date extensions, in two parts:
 * - `Date.prototype.format`, which MicrosoftAjax (a ScriptResource.axd of form pages) provides;
 * - the Datejs `Date.parse` / `Date.today` of the postpreform bundle (on reference-portal `Date.parse`
 *   returns a Date object, or null when the text does not parse, for the site culture en-US).
 * The platform bundle equivalents (lib/native-services.mjs) serve each part at its platform
 * position; documents without the platform bundles load the whole file. */
// @part format
(() => {
  if (typeof Date.prototype.format !== "function") {
    const pad = (value, length = 2) => String(value).padStart(length, "0");
    const months = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    const tokenValues = (date) => ({
      yyyy: String(date.getFullYear()), yy: pad(date.getFullYear() % 100),
      MMMM: months[date.getMonth()], MMM: months[date.getMonth()].slice(0, 3),
      MM: pad(date.getMonth() + 1), M: String(date.getMonth() + 1),
      dd: pad(date.getDate()), d: String(date.getDate()),
      dddd: days[date.getDay()], ddd: days[date.getDay()].slice(0, 3),
      HH: pad(date.getHours()), H: String(date.getHours()),
      hh: pad(date.getHours() % 12 || 12), h: String(date.getHours() % 12 || 12),
      mm: pad(date.getMinutes()), m: String(date.getMinutes()),
      ss: pad(date.getSeconds()), s: String(date.getSeconds()),
      fff: pad(date.getMilliseconds(), 3), tt: date.getHours() < 12 ? "AM" : "PM", t: date.getHours() < 12 ? "A" : "P",
    });
    Object.defineProperty(Date.prototype, "format", {
      configurable: true,
      value(pattern = "ddd MMM dd yyyy HH:mm:ss") {
        const values = tokenValues(this);
        return String(pattern).replace(/\\(.)|"([^"]*)"|'([^']*)'|yyyy|yy|MMMM|MMM|MM|M|dddd|ddd|dd|d|HH|H|hh|h|mm|m|ss|s|fff|tt|t/g,
          (match, escaped, doubleQuoted, singleQuoted) => escaped ?? doubleQuoted ?? singleQuoted ?? values[match] ?? match);
      },
    });
    ((globalThis.__portalSimulation ||= {}).compatibility ||= {}).dateFormatMode = "local-compatibility";
    console.info("Local Date formatting compatibility active for source-authored Date.format calls.");
  }
})();
// @part datejs
(() => {
  // Datejs semantics: a Date for parseable text, null otherwise; en-US M/d/yyyy order.
  if (!Date.parse.__ppSimDatejs && !/Grammar/.test(String(Date.parse))) {
    const nativeParse = Date.parse;
    const monthNames = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
    const build = (year, month, day, hour = 0, minute = 0, second = 0) => {
      const date = new Date(year, month, day, hour, minute, second);
      return date.getFullYear() === year && date.getMonth() === month && date.getDate() === day ? date : null;
    };
    const hours = (value, meridiem) => {
      let hour = Number(value);
      if (meridiem) hour = (hour % 12) + (/^p/i.test(meridiem) ? 12 : 0);
      return hour;
    };
    const parse = function (value) {
      if (value == null || value === "") return null;
      if (value instanceof Date) return value;
      const text = String(value).trim();
      if (!text) return null;
      let match = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?)?$/i.exec(text);
      if (match) {
        if (match[4] != null && Number(match[4]) > 23) return null;
        return build(Number(match[3]), Number(match[1]) - 1, Number(match[2]), match[4] == null ? 0 : hours(match[4], match[7]), Number(match[5] ?? 0), Number(match[6] ?? 0));
      }
      match = /^([a-z]{3,})\.?\s+(\d{1,2}),?\s+(\d{4})$/i.exec(text) ?? null;
      if (match && monthNames.includes(match[1].slice(0, 3).toLowerCase())) return build(Number(match[3]), monthNames.indexOf(match[1].slice(0, 3).toLowerCase()), Number(match[2]));
      match = /^(\d{1,2})\s+([a-z]{3,})\.?,?\s+(\d{4})$/i.exec(text);
      if (match && monthNames.includes(match[2].slice(0, 3).toLowerCase())) return build(Number(match[3]), monthNames.indexOf(match[2].slice(0, 3).toLowerCase()), Number(match[1]));
      if (/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i.test(text)) {
        const time = nativeParse.call(Date, text.replace(" ", "T"));
        return Number.isNaN(time) ? null : new Date(time);
      }
      return null;
    };
    parse.__ppSimDatejs = true;
    Date.parse = parse;
    if (typeof Date.today !== "function")
      Date.today = function () {
        const date = new Date();
        date.setHours(0, 0, 0, 0);
        return date;
      };
    ((globalThis.__portalSimulation ||= {}).compatibility ||= {}).dateParseMode = "datejs-compatibility";
  }
})();
