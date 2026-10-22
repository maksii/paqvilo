import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { parseCookies } from './auth-session.mjs';
import { DataError } from './data-error.mjs';
import { uuidV5 } from './dataverse-security.mjs';
import { TIME_ZONE_IDS } from './platform-time-zones.mjs';
import { portalLanguage } from './portal-languages.mjs';

const unavailable = () => new DataError('The selected staff user is unavailable or disabled.', 401, 'StaffPrincipalUnavailable');
const GUID = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const bare = value => String(value?.id ?? value ?? '').replace(/[{}]/g, '').toLowerCase();
const UTC_CODE = 92;
const SAMPLE = new Date(Date.UTC(2026, 0, 5, 3, 4, 5));

// .NET-style pattern of an Intl format, read from the parts of a sample date with single-digit month, day and hour.
function pattern(locale, options) {
  return new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).formatToParts(SAMPLE).map(({ type, value }) => {
    const two = value.length === 2;
    if (type === 'year') return value.length === 2 ? 'yy' : 'yyyy';
    if (type === 'month') return /^\d+$/.test(value) ? (two ? 'MM' : 'M') : value.length > 4 ? 'MMMM' : 'MMM';
    if (type === 'day') return two ? 'dd' : 'd';
    if (type === 'weekday') return value.length > 4 ? 'dddd' : 'ddd';
    if (type === 'hour') { const h24 = new Intl.DateTimeFormat(locale, { hour: 'numeric', timeZone: 'UTC' }).resolvedOptions().hourCycle?.startsWith('h2'); return (h24 ? 'H' : 'h').repeat(two ? 2 : 1); }
    if (type === 'minute') return 'mm';
    if (type === 'second') return 'ss';
    if (type === 'dayPeriod') return 'tt';
    return /[A-Za-z]/.test(value) ? `'${value}'` : value;
  }).join('');
}

/** The one staff context the model-driven host gives both the PCF context and
 * Xrm.Utility.getGlobalContext().userSettings, derived from the organization:
 * roles from the role assignments, language/locale/time zone/currency/format
 * overrides from the user's usersettings row, else the organization row. */
export function staffContext(runtime, user) {
  const store = runtime.store, org = store.tableRows('organization')[0] ?? {};
  const settings = store.tableRows('usersettings').find(row => bare(row.systemuserid) === bare(user.systemuserid)) ?? {};
  const languageId = Number(settings.uilanguageid ?? org.languagecode) || null;
  const localeId = Number(settings.localeid ?? org.localeid ?? languageId) || null;
  // ponytail: LCIDs resolve through the Power Pages language catalogue; others format with the invariant (en-US) culture and say so (localeResolved: false).
  const resolved = portalLanguage({ lcid: localeId })?.code ?? null, locale = resolved ?? 'en-US';
  const zone = TIME_ZONE_IDS.find(([code]) => code === Number(settings.timezonecode ?? UTC_CODE)) ?? TIME_ZONE_IDS.find(([code]) => code === UTC_CODE);
  const currencies = store.tableRows('transactioncurrency');
  const currencyRow = currencies.find(row => bare(row.transactioncurrencyid) === bare(settings.transactioncurrencyid))
    ?? currencies.find(row => bare(row.transactioncurrencyid) === bare(org.basecurrencyid)) ?? currencies[0] ?? null;
  const currency = currencyRow ? { id: bare(currencyRow.transactioncurrencyid), name: currencyRow.currencyname ?? '', isoCode: currencyRow.isocurrencycode ?? null,
    symbol: currencyRow.currencysymbol ?? currencyRow.isocurrencycode ?? '', precision: Number.isInteger(currencyRow.currencyprecision) ? currencyRow.currencyprecision : 2 } : null;
  const numberPart = (type, value = -12345.5, options = {}) => new Intl.NumberFormat(locale, options).formatToParts(value).find(part => part.type === type)?.value;
  const decimal = settings.decimalsymbol ?? numberPart('decimal'), group = settings.numberseparator ?? numberPart('group');
  const names = (options, count, at) => Array.from({ length: count }, (_, index) => new Intl.DateTimeFormat(locale, { ...options, timeZone: 'UTC' }).format(at(index)));
  const day = index => new Date(Date.UTC(2026, 0, 4 + index)), month = index => new Date(Date.UTC(2026, index, 15));
  const dateSeparator = settings.dateseparator ?? new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeZone: 'UTC' }).formatToParts(SAMPLE).find(part => part.type === 'literal')?.value ?? '/';
  const timeSeparator = settings.timeseparator ?? new Intl.DateTimeFormat(locale, { timeStyle: 'short', timeZone: 'UTC' }).formatToParts(SAMPLE).find(part => part.type === 'literal')?.value ?? ':';
  const intlLocale = new Intl.Locale(locale), weekInfo = intlLocale.getWeekInfo?.() ?? intlLocale.weekInfo, textInfo = intlLocale.getTextInfo?.() ?? intlLocale.textInfo;
  const roles = runtime.principals.roles(user).map(role => ({ id: bare(role.roleid), name: role.name }));
  return { userId: bare(user.systemuserid), userName: user.fullname ?? user.domainname ?? '', roles, securityRoles: roles.map(role => role.id),
    languageId, localeId, locale, localeResolved: Boolean(resolved), isRTL: textInfo?.direction === 'rtl',
    timeZone: { code: zone[0], standardName: zone[1], iana: zone[2] }, transactionCurrency: currency,
    numberFormattingInfo: { numberDecimalSeparator: decimal, numberGroupSeparator: group, numberGroupSizes: [3], numberDecimalDigits: 2,
      currencyDecimalSeparator: decimal, currencyGroupSeparator: group, currencyGroupSizes: [3], currencyDecimalDigits: currency?.precision ?? 2, currencySymbol: currency?.symbol ?? '',
      negativeSign: numberPart('minusSign') ?? '-', positiveSign: numberPart('plusSign', 1, { signDisplay: 'always' }) ?? '+', percentSymbol: numberPart('percentSign', 0.5, { style: 'percent' }) ?? '%',
      nanSymbol: numberPart('nan', NaN) ?? 'NaN', positiveInfinitySymbol: numberPart('infinity', Infinity) ?? 'Infinity', negativeInfinitySymbol: `${numberPart('minusSign') ?? '-'}${numberPart('infinity', Infinity) ?? 'Infinity'}` },
    dateFormattingInfo: { dayNames: names({ weekday: 'long' }, 7, day), abbreviatedDayNames: names({ weekday: 'short' }, 7, day), shortestDayNames: names({ weekday: 'narrow' }, 7, day),
      monthNames: [...names({ month: 'long' }, 12, month), ''], abbreviatedMonthNames: [...names({ month: 'short' }, 12, month), ''],
      amDesignator: new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true, timeZone: 'UTC' }).formatToParts(SAMPLE).find(part => part.type === 'dayPeriod')?.value ?? '',
      pmDesignator: new Intl.DateTimeFormat(locale, { hour: 'numeric', hour12: true, timeZone: 'UTC' }).formatToParts(new Date(Date.UTC(2026, 0, 5, 15))).find(part => part.type === 'dayPeriod')?.value ?? '',
      // .NET DayOfWeek: 0 is Sunday; Intl weekInfo: 7 is Sunday.
      firstDayOfWeek: (weekInfo?.firstDay ?? 7) % 7, dateSeparator, timeSeparator,
      // .NET ShortDatePattern keeps a four-digit year where ICU's short style has two (en-US M/d/yyyy, Learn DateTimeFormatInfo).
      // unverified: the four-digit year for every catalogue locale other than en-US.
      shortDatePattern: settings.dateformatstring ?? pattern(locale, { dateStyle: 'short' }).replace(/(^|[^y])yy(?!y)/, '$1yyyy'), longDatePattern: pattern(locale, { dateStyle: 'full' }),
      shortTimePattern: settings.timeformatstring ?? pattern(locale, { timeStyle: 'short' }), longTimePattern: pattern(locale, { timeStyle: 'medium' }),
      monthDayPattern: pattern(locale, { month: 'long', day: 'numeric' }), yearMonthPattern: pattern(locale, { year: 'numeric', month: 'long' }),
      sortableDateTimePattern: "yyyy'-'MM'-'dd'T'HH':'mm':'ss", universalSortableDateTimePattern: "yyyy'-'MM'-'dd HH':'mm':'ss'Z'" } };
}

// usersettingscollection(<systemuserid>) (Learn usersettings table reference: entity set usersettingscollection, key
// systemuserid; Retrieve and Update): GET and PATCH of the columns staffContext reads, in the private runtime table
// usersettings (seeded rows win on reset). Secrets are never stored there: only language, locale, time zone, currency and formats.
// ponytail: a caller reads and updates its own row only; another user's row (prvReadUserSettings/prvWriteUserSettings) is refused.
const USER_SETTINGS_ROUTE = /^\/api\/data\/v\d+\.\d+\/usersettingscollection\(([^)]*)\)\/?$/i;
const USER_SETTINGS_NUMBERS = ['uilanguageid', 'localeid', 'timezonecode'];
const USER_SETTINGS_TEXT = ['dateformatstring', 'timeformatstring', 'dateseparator', 'timeseparator', 'decimalsymbol', 'numberseparator'];
const userSettingsJson = (status, body) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8' }, body });
function installUserSettings(api) {
  const { store } = api;
  api.addRoute((path, method) => USER_SETTINGS_ROUTE.test(path) && (method === 'GET' || method === 'PATCH'), async c => {
    if (!c.caller) throw new DataError('Authentication is required.', 401, 'Unauthorized');
    const id = bare(USER_SETTINGS_ROUTE.exec(c.url.pathname)[1]);
    if (!GUID.test(id)) throw new DataError(`The key '${id}' is not a systemuserid.`, 400, 'BadRequest');
    // unverified: the native status and code for another user's settings without prvReadUserSettings.
    if (bare(c.caller.systemuserid) !== id) throw new DataError("Only the caller's own usersettings row is available locally.", 403, 'Forbidden');
    const org = store.tableRows('organization')[0] ?? {};
    const rowOf = () => store.tableRows('usersettings').find(row => bare(row.systemuserid) === id);
    if (c.method === 'GET') {
      const row = rowOf() ?? { uilanguageid: org.languagecode ?? null, localeid: org.localeid ?? null, timezonecode: UTC_CODE };
      return userSettingsJson(200, { '@odata.context': `${c.origin}/api/data/${c.version}/$metadata#usersettingscollection/$entity`, systemuserid: id,
        ...Object.fromEntries([...USER_SETTINGS_NUMBERS, ...USER_SETTINGS_TEXT].map(name => [name, row[name] ?? null])), _transactioncurrencyid_value: row.transactioncurrencyid ? bare(row.transactioncurrencyid) : null });
    }
    const body = c.body ?? {}, patch = {};
    for (const [name, value] of Object.entries(body)) {
      if (USER_SETTINGS_NUMBERS.includes(name) && Number.isInteger(value)) patch[name] = value;
      else if (USER_SETTINGS_TEXT.includes(name) && typeof value === 'string' && value.length <= 255) patch[name] = value;
      else if (name === 'transactioncurrencyid@odata.bind' && /^\/?transactioncurrencies\(([^)]+)\)$/i.test(String(value))) {
        const currency = bare(/\(([^)]+)\)/.exec(value)[1]);
        if (!store.tableRows('transactioncurrency').some(row => bare(row.transactioncurrencyid) === currency)) throw new DataError(`transactioncurrency With Id = ${currency} Does Not Exist`, 404, 'NotFound');
        patch.transactioncurrencyid = currency;
      } else throw new DataError(`The usersettings property '${name}' cannot be updated locally.`, 400, 'BadRequest');
    }
    await api.change(() => store.transact(() => {
      const rows = (store.state.tables ??= {}).usersettings ??= [];
      const row = rows.find(item => bare(item.systemuserid) === id);
      if (row) Object.assign(row, patch); else rows.push({ systemuserid: id, ...patch });
    }));
    return { status: 204, headers: {}, body: undefined };
  });
}
export const USER_SETTINGS_EXTENSION = { name: 'usersettings', install: installUserSettings,
  describe: () => ({ name: 'usersettings', version: 1, kind: 'organization-module', level: 'behaviour',
    operations: [{ name: 'retrieve', level: 'behaviour' }, { name: 'update', level: 'behaviour' }, { name: 'otherUsers', level: 'inventory', reason: 'USERSETTINGS_OWN_ROW_ONLY' }],
    requires: ['table:usersettings'], principal: 'caller', stateOwner: 'store:tables.usersettings', lifecycle: 'in-process' }) };

/** A local staff persona is independent of Power Pages contact sign-in. The
 * signed, process-local cookie stores only a user id; roles are resolved anew
 * on every request. Absence retains explicit local administration compatibility. */
export function createStaffSessions({ organization, port = () => '', secret = randomBytes(32) }) {
  const core = () => typeof organization === 'function' ? organization() : organization;
  const name = () => `paqvilo-mirage-staff${port() ? `-${port()}` : ''}`;
  const sign = value => createHmac('sha256', secret).update(value).digest('base64url');
  const selected = req => {
    const runtime = core();
    if (!runtime) throw new DataError('The organization runtime is unavailable.', 503, 'OrganizationUnavailable');
    const raw = parseCookies(req.headers?.cookie)[name()];
    if (raw === undefined) return { principalId: uuidV5(runtime.organizationId, 'systemuser:SYSTEM'), kind: 'local-admin' };
    const [id, signature, extra] = raw.split('.');
    if (extra !== undefined || !GUID.test(id ?? '') || typeof signature !== 'string') throw unavailable();
    const actual = Buffer.from(signature), expected = Buffer.from(sign(id));
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw unavailable();
    const user = runtime.principals.byId(id);
    if (!user || user.isdisabled === true || user.applicationid || user.accessmode === 4) throw unavailable();
    return { principalId: user.systemuserid, kind: 'staff' };
  };
  const cookie = id => `${name()}=${id ? `${id}.${sign(id)}` : ''}; Path=/; HttpOnly; SameSite=Lax${id ? '' : '; Max-Age=0'}`;
  const describe = req => {
    const runtime = core(), current = selected(req), user = runtime.principals.byId(current.principalId);
    const users = runtime.store.tableRows('systemuser').filter(row => row.isdisabled !== true && !row.applicationid && row.accessmode !== 4 && row.systemuserid !== uuidV5(runtime.organizationId, 'systemuser:SYSTEM'))
      .map(row => ({ id: row.systemuserid, name: row.fullname ?? row.domainname ?? row.systemuserid, roles: runtime.principals.roles(row).map(role => role.name) }));
    return { current: { ...current, id: current.principalId, name: current.kind === 'local-admin' ? 'Local administrator' : user.fullname ?? user.domainname,
      roles: runtime.principals.roles(user).map(role => role.name), privilegeCount: runtime.principals.privileges(user).size,
      context: { ...staffContext(runtime, user), ...(current.kind === 'local-admin' ? { userName: 'Local administrator' } : {}) } },
      users, default: { kind: 'local-admin', name: 'Local administrator' } };
  };
  return { resolve: selected, describe, cookie, select(req, id) {
    if (!GUID.test(id ?? '')) throw unavailable();
    const header = cookie(id.toLowerCase());
    selected({ headers: { cookie: header.split(';')[0] } });
    return header;
  } };
}

export function createStaffSessionHandler({ sessions, csrf, json, readBody }) {
  return async (req, res, url) => {
    if (!/^\/(?:_sim|__sim)\/api\/dataverse\/session\/?$/.test(url.pathname)) return false;
    try {
      if (!['GET', 'POST', 'DELETE'].includes(req.method)) throw new DataError('Method not allowed.', 405, 'MethodNotAllowed');
      if (req.method !== 'GET' && req.headers['x-sim-csrf'] !== csrf()) throw new DataError('Missing simulator CSRF token.', 403, 'CsrfRequired');
      if (req.method === 'POST') {
        const body = await readBody(req);
        const header = sessions.select(req, body?.userId ?? body?.principalId);
        res.setHeader('set-cookie', header);
        json(res, 200, sessions.describe({ headers: { cookie: header.split(';')[0] } }));
      } else if (req.method === 'DELETE') {
        res.setHeader('set-cookie', sessions.cookie(null));
        json(res, 200, sessions.describe({ headers: {} }));
      } else json(res, 200, sessions.describe(req));
    } catch (error) { json(res, error.status ?? 500, { error: { message: error.message, code: error.code ?? 'StaffSessionError' } }); }
    return true;
  };
}
