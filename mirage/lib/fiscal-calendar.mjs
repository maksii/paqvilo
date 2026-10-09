import { DataError } from "./data-error.mjs";

/*
 * The organisation fiscal calendar behind the fiscal FetchXML operators (this-fiscal-year ...
 * in-or-after-fiscal-period-and-year), the matching Web API query functions and the
 * fiscal-period / fiscal-year date groupings.
 *
 * The calendar model and its period arithmetic are ported from Sql4Cds (MarkMpn/Sql4Cds,
 * MarkMpn.Sql4Cds.Engine/FetchXml2Sql.cs at commit 3abeada31fccff38786a8f95fb563b20916bcfb1:
 * the FiscalPeriodType codes and GetFiscalPeriodNumber, AddFiscalPeriod, SubtractFiscalPeriod
 * and GetFiscalPeriodDates, with the fiscal operator cases that use them). That code is
 * licensed as follows:
 *
 *   MIT License
 *
 *   Copyright (c) 2020 Mark Carrington
 *
 *   Permission is hereby granted, free of charge, to any person obtaining a copy
 *   of this software and associated documentation files (the "Software"), to deal
 *   in the Software without restriction, including without limitation the rights
 *   to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 *   copies of the Software, and to permit persons to whom the Software is
 *   furnished to do so, subject to the following conditions:
 *
 *   The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 *
 *   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *   IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *   FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *   AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *   LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *   OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *   SOFTWARE.
 */

/*
 * As in Sql4Cds: the organisation's FiscalCalendarStart gives the month and day each fiscal
 * year starts on; FiscalPeriodType 2000-2004 splits the year into 1, 2, 4 or 12 periods of
 * 12, 6, 3 or 1 months, or into 28-day periods; a fiscal year is numbered by the calendar
 * year it starts in; periods are numbered from 1 at the year's start; date bounds are
 * half-open [start, end). Deliberate differences, documented in docs/dataverse-parity.md
 * ("Fiscal calendar"):
 * - a date on a period's first day belongs to that period (Sql4Cds compares periodEnd < date
 *   and counts the first day of each period in the previous one);
 * - this-, last- and next-fiscal-year follow the fiscal year that contains today (Sql4Cds
 *   starts from the calendar year, so its next-fiscal-year returns the current fiscal year
 *   once that year has started in the current calendar year);
 * - period boundaries are counted from the fiscal year's start date instead of chaining
 *   month additions, so a start on the 29th-31st doesn't drift, and moving by periods steps
 *   across fiscal years by period index;
 * - a period number outside the year (period 5 of a quarterly year) matches nothing, as Learn
 *   documents for in-fiscal-period and in-fiscal-period-and-year (Sql4Cds rolls it forward);
 * - in-fiscal-period is evaluated per value (Sql4Cds can't translate it to SQL);
 * - the last days of a 28-day-period year, after 13 x 28 days, stay in period 13, and a
 *   29 February start falls on 28 February in other years.
 */
export const FISCAL_PERIOD_TYPES = Object.freeze({
  2000: Object.freeze({ name: "annually", periods: 1, months: 12 }),
  2001: Object.freeze({ name: "semiannually", periods: 2, months: 6 }),
  2002: Object.freeze({ name: "quarterly", periods: 4, months: 3 }),
  2003: Object.freeze({ name: "monthly", periods: 12, months: 1 }),
  2004: Object.freeze({ name: "fourweekly", periods: 13, days: 28 }),
});

const DAY = 86400000;
const BY_NAME = new Map(Object.entries(FISCAL_PERIOD_TYPES).map(([code, type]) => [type.name, Number(code)]));
// The earlier simulator setting (periods per year) mapped onto the period types.
const BY_PERIOD_COUNT = new Map([[1, 2000], [2, 2001], [4, 2002], [12, 2003], [13, 2004]]);

const invalid = (message) => {
  throw new DataError(message, 500, "InvalidFiscalCalendar");
};
const daysIn = (year, month) => new Date(Date.UTC(year, month + 1, 0)).getUTCDate();

function periodType(value, setting) {
  if (value == null || value === "") return null;
  const text = String(value).trim().toLowerCase().replace(/[\s_-]/g, "");
  const code = /^\d+$/.test(text) ? Number(text) : BY_NAME.get(text);
  if (!FISCAL_PERIOD_TYPES[code])
    invalid(`${setting} must be a fiscal period type (2000-2004 or ${[...BY_NAME.keys()].join(", ")}), not '${value}'.`);
  return code;
}

function startDate(value, setting) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  // YYYY-MM-DD (any time part is ignored) or MM-DD; only the month and day are used.
  const match = /^(?:\d{4}-)?(\d{2})-(\d{2})(?:[T ].*)?$/.exec(text);
  const month = match ? Number(match[1]) - 1 : NaN,
    day = match ? Number(match[2]) : NaN;
  if (!(month >= 0 && month <= 11 && day >= 1 && day <= daysIn(2000, month)))
    invalid(`${setting} must be a date (YYYY-MM-DD or MM-DD), not '${value}'.`);
  return { month, day };
}

/**
 * The fiscal calendar from query settings: fiscalCalendarStart (the organisation's
 * FiscalCalendarStart) and fiscalPeriodType (its FiscalPeriodType: 2000-2004 or the type
 * name), else the earlier fiscalPeriodsPerYear (1, 2, 4, 12 or 13). Without settings the
 * simulator uses 1 January and quarters; Dataverse's own default isn't documented.
 */
export function fiscalCalendar(settings = {}) {
  // A calendar this function made passes through unchanged.
  if (Number.isInteger(settings?.periods) && Number.isInteger(settings?.startMonth)) return settings;
  const start = startDate(settings?.fiscalCalendarStart, "fiscalCalendarStart") ?? { month: 0, day: 1 };
  let code = periodType(settings?.fiscalPeriodType, "fiscalPeriodType");
  if (code == null && settings?.fiscalPeriodsPerYear != null && settings.fiscalPeriodsPerYear !== "") {
    code = BY_PERIOD_COUNT.get(Number(settings.fiscalPeriodsPerYear));
    if (code == null)
      invalid(`fiscalPeriodsPerYear must be 1, 2, 4, 12 or 13, not '${settings.fiscalPeriodsPerYear}'.`);
  }
  code ??= 2002;
  return Object.freeze({ startMonth: start.month, startDay: start.day, type: code, ...FISCAL_PERIOD_TYPES[code] });
}

const localMidnight = (year, month, day, offset) => Date.UTC(year, month, day) - offset * 60000;

/** Start (local midnight, as an instant) of fiscal year `year`: its start day in that calendar year. */
export function fiscalYearStart(calendar, year, offset = 0) {
  return localMidnight(year, calendar.startMonth, Math.min(calendar.startDay, daysIn(year, calendar.startMonth)), offset);
}

// Start of period `period` (1 to periods) of fiscal year `year`, counted from the year's start.
function periodStart(calendar, year, period, offset) {
  if (calendar.days) return fiscalYearStart(calendar, year, offset) + (period - 1) * calendar.days * DAY;
  const total = calendar.startMonth + (period - 1) * calendar.months;
  const y = year + Math.floor(total / 12),
    m = total % 12;
  return localMidnight(y, m, Math.min(calendar.startDay, daysIn(y, m)), offset);
}

/** [start, end) of a fiscal period, or null when the period number is outside the year. */
export function fiscalPeriodBounds(calendar, year, period, offset = 0) {
  if (!Number.isInteger(period) || period < 1 || period > calendar.periods) return null;
  return [
    periodStart(calendar, year, period, offset),
    period === calendar.periods ? fiscalYearStart(calendar, year + 1, offset) : periodStart(calendar, year, period + 1, offset),
  ];
}

/** { year, period } of the fiscal period that contains the instant `ms`. */
export function fiscalPeriodOf(calendar, ms, offset = 0) {
  let year = new Date(ms + offset * 60000).getUTCFullYear();
  if (ms < fiscalYearStart(calendar, year, offset)) year -= 1;
  let period = 1;
  while (period < calendar.periods && ms >= periodStart(calendar, year, period + 1, offset)) period++;
  return { year, period };
}

/** The fiscal period `count` periods after (negative: before) { year, period }. */
export function shiftFiscalPeriod(calendar, { year, period }, count) {
  const index = year * calendar.periods + (period - 1) + count;
  return {
    year: Math.floor(index / calendar.periods),
    period: (((index % calendar.periods) + calendar.periods) % calendar.periods) + 1,
  };
}

const positiveInteger = (value, operator) => {
  const text = String(value ?? "").trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)) || Number(text) < 1)
    throw new DataError(`${operator} requires a positive integer value`, 400, "InvalidQuery");
  return Number(text);
};

export const FISCAL_OPERATORS = new Set([
  "this-fiscal-year", "last-fiscal-year", "next-fiscal-year", "this-fiscal-period",
  "last-fiscal-period", "next-fiscal-period", "last-x-fiscal-years", "next-x-fiscal-years",
  "last-x-fiscal-periods", "next-x-fiscal-periods", "in-fiscal-year", "in-fiscal-period",
  "in-fiscal-period-and-year", "in-or-before-fiscal-period-and-year",
  "in-or-after-fiscal-period-and-year",
]);

/**
 * Predicate over instants for a fiscal operator, or null for any other operator. `now` is
 * the query's clock, `offset` the user's time zone offset in minutes.
 */
export function fiscalOperatorPredicate(operator, values, { now = Date.now(), offset = 0, calendar = fiscalCalendar() } = {}) {
  if (!FISCAL_OPERATORS.has(operator)) return null;
  const range = (start, end) => (ms) => ms >= start && ms < end;
  const none = () => false;
  const bounds = (target) => fiscalPeriodBounds(calendar, target.year, target.period, offset);
  const yearStart = (year) => fiscalYearStart(calendar, year, offset);
  const current = fiscalPeriodOf(calendar, now, offset);
  const n = () => positiveInteger(values[0], operator);
  switch (operator) {
    case "this-fiscal-year":
      return range(yearStart(current.year), yearStart(current.year + 1));
    case "last-fiscal-year":
      return range(yearStart(current.year - 1), yearStart(current.year));
    case "next-fiscal-year":
      return range(yearStart(current.year + 1), yearStart(current.year + 2));
    case "this-fiscal-period":
      return range(...bounds(current));
    case "last-fiscal-period":
      return range(...bounds(shiftFiscalPeriod(calendar, current, -1)));
    case "next-fiscal-period":
      return range(...bounds(shiftFiscalPeriod(calendar, current, 1)));
    // Sql4Cds: from the start of the period (year) X before the current one up to now, and
    // from now to the end of the period (year) X after the current one.
    case "last-x-fiscal-periods":
      return range(bounds(shiftFiscalPeriod(calendar, current, -n()))[0], now);
    case "next-x-fiscal-periods":
      return range(now, bounds(shiftFiscalPeriod(calendar, current, n()))[1]);
    case "last-x-fiscal-years":
      return range(yearStart(current.year - n()), now);
    case "next-x-fiscal-years":
      return range(now, yearStart(current.year + n() + 1));
    case "in-fiscal-year": {
      const year = positiveInteger(values[0], operator);
      return range(yearStart(year), yearStart(year + 1));
    }
    case "in-fiscal-period": {
      const period = positiveInteger(values[0], operator);
      if (period > calendar.periods) return none;
      return (ms) => fiscalPeriodOf(calendar, ms, offset).period === period;
    }
    default: {
      // in-fiscal-period-and-year and in-or-before/after-fiscal-period-and-year: period, then year.
      const period = positiveInteger(values[0], operator),
        year = positiveInteger(values[1], operator);
      const target = fiscalPeriodBounds(calendar, year, period, offset);
      if (!target) return none;
      if (operator === "in-fiscal-period-and-year") return range(...target);
      if (operator === "in-or-before-fiscal-period-and-year") return (ms) => ms < target[1];
      return (ms) => ms >= target[0];
    }
  }
}
