// @test-kind observation: Power Pages PCF context surface captured on a Power Pages site (Enhanced, 9.8.9.29, en-US) on 2026-11-26, run r1, one page load per zone: paqvilo-developer pcf-parity summary-A, digest-surface-r1.json and digest-surface-r1-kyiv.json, capture r1 actions-save, read-full-ny.json, insert-ny.json, lq-typed-ny.json
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { sharedBrowser, loopbackServer } from './shared-browser.mjs';
import { createSimulator } from '../server.mjs';
import { signInContext } from '../testing/session.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const browser = sharedBrowser({ headless: true });
const ROW = '10000000-0000-4000-8000-000000000001';
// The capture's fixed instant and the capture date (the browser's current offset is the user offset).
const INSTANT = '2026-03-15T14:05:09.123Z';
const NOW = '2026-11-26T12:00:00.000Z';

// Public members of the captured context and its namespaces (own members with their type, prototype methods with their
// arity), derived from digest-surface-r1.json; the fixture names its source.
const SURFACE = JSON.parse(
  await fs.readFile(new URL('./fixtures/pcf-context-surface-members.json', import.meta.url), 'utf8'),
);
const CONTEXT_MEMBERS = SURFACE.context;
const NAMESPACE_MEMBERS = SURFACE.namespaces;

const ENTITY_DEFINITION = {
  '@odata.context': 'fixture',
  LogicalName: 'tst_row',
  EntitySetName: 'tst_rows',
  PrimaryIdAttribute: 'tst_rowid',
  PrimaryNameAttribute: 'tst_title',
  ObjectTypeCode: 10001,
  IsCustomEntity: true,
  DisplayName: { UserLocalizedLabel: { Label: 'Row' }, LocalizedLabels: [{ Label: 'Row', LanguageCode: 1033 }] },
  DisplayCollectionName: { UserLocalizedLabel: { Label: 'Rows' }, LocalizedLabels: [] },
  Description: { UserLocalizedLabel: null, LocalizedLabels: [{ Label: 'Invented rows', LanguageCode: 1033 }] },
  Privileges: [{ Name: 'prvReadtst_row', PrivilegeType: 0 }],
  Attributes: [
    {
      '@odata.type': '#Microsoft.Dynamics.CRM.PicklistAttributeMetadata',
      LogicalName: 'tst_choice',
      AttributeType: 'Picklist',
      DisplayName: { UserLocalizedLabel: { Label: 'Choice' } },
    },
    {
      '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata',
      LogicalName: 'tst_title',
      AttributeType: 'String',
      DisplayName: { UserLocalizedLabel: { Label: 'Title' } },
    },
  ],
};

/** A loopback page with the PCF host script, a recorder control and a fixture /_api. */
async function hostPage(t, { timezoneId = 'America/New_York', locale = 'en-US' } = {}) {
  const host = await fs.readFile(new URL('../lib/code-components-client.js', import.meta.url), 'utf8');
  const requests = [];
  const { origin } = await loopbackServer(t, (request, response) => {
    if (request.url === '/host.js') {
      response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
      return response.end(host);
    }
    if (request.url.startsWith('/_api/')) {
      requests.push({ method: request.method, url: decodeURIComponent(request.url), headers: request.headers });
      response.setHeader('Content-Type', 'application/json');
      if (request.url.startsWith("/_api/EntityDefinitions(LogicalName='tst_row')"))
        return response.end(JSON.stringify(ENTITY_DEFINITION));
      if (request.method === 'POST' || request.method === 'PATCH' || request.method === 'DELETE') {
        response.statusCode = 204;
        if (request.method === 'POST') response.setHeader('OData-EntityId', `/_api/tst_rows(${ROW})`);
        return response.end();
      }
      response.statusCode = 403;
      return response.end(JSON.stringify({ error: { code: '90040120', message: 'Fixture read denied' } }));
    }
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html><html lang="en-US"><body><script src="/host.js"></script></body></html>');
  });
  const page = await browser.page(t, { timezoneId, locale });
  const errors = [],
    warnings = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => message.type() === 'warning' && warnings.push(message.text()));
  await page.clock.setFixedTime(new Date(NOW));
  await page.goto(origin);
  await page.evaluate(() => {
    window.contexts = {};
    window.log = [];
    window.shell = {
      getTokenDeferred: () => ({
        done(callback) {
          callback('fixture-token');
          return this;
        },
        fail() {
          return this;
        },
      }),
    };
    window.ComponentFramework.registerControl(
      'Synthetic.Surface',
      class {
        init(context, notify, state, container) {
          this.key = container.dataset.key;
          window.contexts[this.key] = context;
          window.log.push([this.key, 'init']);
        }
        updateView(context) {
          window.log.push([this.key, 'updateView', [...context.updatedProperties]]);
        }
        getOutputs() {
          return {};
        }
        destroy() {}
      },
    );
    // Mounts the recorder; markup becomes the native field wrapper when given.
    window.mountSurface = async (key, spec = {}, markup) => {
      let parent = document.body;
      if (markup !== undefined) {
        parent = document.createElement('div');
        parent.dataset.pcfNativeField = key;
        parent.innerHTML = '<div data-pcf-native-input>' + markup + '</div>';
        document.body.append(parent);
      }
      const target = document.createElement('div');
      target.dataset.key = key;
      parent.append(target);
      await window.__paqviloPcf.mount(
        {
          id: key,
          schemaName: 'tst_Synthetic.Surface',
          constructor: 'Synthetic.Surface',
          resources: [],
          strings: { Caption: 'Caption text' },
          args: {},
          mappings: { tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid' } },
          properties: [{ name: 'value', 'of-type': 'SingleLine.Text', usage: 'bound' }],
          events: [{ name: 'OnProbe' }],
          host: 'liquid',
          language: { code: 'en-US', lcid: 1033, isRTL: false },
          ...spec,
        },
        target,
      );
      return target.id;
    };
    window.updates = (key) =>
      window.log.filter((entry) => entry[0] === key && entry[1] === 'updateView').map((e) => e[2]);
    // The public members of an object: own members with their type, prototype methods with their arity.
    const kind = (value) => {
      if (value === null) return 'null';
      if (Array.isArray(value)) return 'array';
      if (typeof value === 'function') return 'function/' + value.length;
      return typeof value;
    };
    window.members = (value) => {
      const prototype = Object.getPrototypeOf(value);
      return {
        own: Object.fromEntries(
          Object.getOwnPropertyNames(value)
            .filter((name) => !name.startsWith('_'))
            .map((name) => [name, kind(value[name])]),
        ),
        proto:
          prototype && prototype !== Object.prototype
            ? Object.fromEntries(
                Object.getOwnPropertyNames(prototype)
                  .filter((name) => name !== 'constructor' && !name.startsWith('_'))
                  .map((name) => [name, prototype[name].length]),
              )
            : {},
      };
    };
    window.serial = (value) =>
      JSON.parse(
        JSON.stringify(value, function (key, item) {
          return this[key] instanceof Date ? '@' + this[key].getTime() + '@' : item;
        }),
      );
  });
  return { page, errors, warnings, requests };
}

const NATIVE = {
  host: 'field',
  args: { value: 'Row' },
  nativeBinding: {
    id: 'tst_title',
    control: 'text',
    properties: ['value'],
    attributes: { LogicalName: 'tst_title', DisplayName: 'Title' },
    context: { label: 'Title', entityId: ROW, entityTypeName: 'tst_row', entityRecordName: 'Saved row' },
  },
};
// The field host's column value: the platform's hidden input holding the value as JSON (lib/platform.mjs field host).
const NATIVE_MARKUP = '<input id="tst_title" type="hidden" value="&quot;Row&quot;">';

test('the field host context exposes the captured namespaces, members, prototype placement and arity', async (t) => {
  const { page, errors } = await hostPage(t);
  const surface = await page.evaluate(
    async ([native, markup]) => {
      await window.mountSurface('field', native, markup);
      const context = window.contexts.field;
      const kind = (value) => (value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value);
      return {
        context: Object.fromEntries(Object.keys(context).map((name) => [name, kind(context[name])])),
        namespaces: Object.fromEntries(
          Object.entries(context)
            .filter(([, value]) => value && typeof value === 'object' && !Array.isArray(value))
            .filter(([name]) => !['parameters', 'children', 'events'].includes(name))
            .map(([name, value]) => [name, window.members(value)]),
        ),
        events: window.members(context.events),
        hasFluent: Object.hasOwn(context, 'fluentDesignLanguage'),
        children: context.children,
        shadowed: [
          context.communicationChannel.getPersonaInfo,
          typeof Object.getPrototypeOf(context.communicationChannel).getPersonaInfo,
        ],
      };
    },
    [NATIVE, NATIVE_MARKUP],
  );
  assert.deepEqual(surface.context, CONTEXT_MEMBERS);
  assert.deepEqual(surface.namespaces, NAMESPACE_MEMBERS);
  assert.deepEqual(surface.events, { own: { OnProbe: 'function/0' }, proto: {} });
  assert.equal(surface.hasFluent, true);
  assert.deepEqual(surface.children, {});
  assert.deepEqual(surface.shadowed, [undefined, 'function']);
  assert.deepEqual(errors, []);
});

const CAPTURED_DATE_INFO = {
  AMDesignator: 'AM',
  Calendar: {
    MinSupportedDateTime: '@-62135568000000@',
    MaxSupportedDateTime: '@253402300799999@',
    AlgorithmType: 1,
    CalendarType: 1,
    Eras: [1],
    TwoDigitYearMax: 2029,
    IsReadOnly: false,
  },
  DateSeparator: '/',
  FirstDayOfWeek: 0,
  CalendarWeekRule: 0,
  FullDateTimePattern: 'dddd, MMMM dd, yyyy h:mm:ss tt',
  LongDatePattern: 'dddd, MMMM dd, yyyy',
  LongTimePattern: 'h:mm:ss tt',
  MonthDayPattern: 'MMMM dd',
  PMDesignator: 'PM',
  RFC1123Pattern: "ddd, dd MMM yyyy HH':'mm':'ss 'GMT'",
  ShortDatePattern: 'M/d/yyyy',
  ShortTimePattern: 'h:mm tt',
  SortableDateTimePattern: "yyyy'-'MM'-'dd'T'HH':'mm':'ss",
  TimeSeparator: ':',
  UniversalSortableDateTimePattern: "yyyy'-'MM'-'dd HH':'mm':'ss'Z'",
  YearMonthPattern: 'MMMM, yyyy',
  AbbreviatedDayNames: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
  ShortestDayNames: ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'],
  DayNames: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
  AbbreviatedMonthNames: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec', ''],
  MonthNames: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
    '',
  ],
  IsReadOnly: false,
  NativeCalendarName: 'Gregorian Calendar',
  AbbreviatedMonthGenitiveNames: [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
    '',
  ],
  MonthGenitiveNames: [
    'January',
    'February',
    'March',
    'April',
    'May',
    'June',
    'July',
    'August',
    'September',
    'October',
    'November',
    'December',
    '',
  ],
};
const CAPTURED_NUMBER_INFO = {
  CurrencyDecimalDigits: 2,
  CurrencyDecimalSeparator: '.',
  IsReadOnly: false,
  CurrencyGroupSizes: [3],
  NumberGroupSizes: [3],
  PercentGroupSizes: [3],
  CurrencyGroupSeparator: ',',
  CurrencySymbol: '$',
  NaNSymbol: 'NaN',
  CurrencyNegativePattern: 0,
  NumberNegativePattern: 1,
  PercentPositivePattern: 0,
  PercentNegativePattern: 0,
  NegativeInfinitySymbol: '-Infinity',
  NegativeSign: '-',
  NumberDecimalDigits: 2,
  NumberDecimalSeparator: '.',
  NumberGroupSeparator: ',',
  CurrencyPositivePattern: 0,
  PositiveInfinitySymbol: 'Infinity',
  PositiveSign: '+',
  PercentDecimalDigits: 2,
  PercentDecimalSeparator: '.',
  PercentGroupSeparator: ',',
  PercentSymbol: '%',
  PerMilleSymbol: '‰',
  NativeDigits: ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'],
  DigitSubstitution: 1,
};
// Zone-independent formatting results of the capture (digest `formatting`, equal in New York and Kyiv).
const CAPTURED_FORMATTING = {
  'formatCurrency(1234.5)': '$1,234.50',
  'formatCurrency(1234.5,2)': '$1,234.50',
  'formatCurrency(1234.5,2,"€")': '€1,234.50',
  'formatCurrency(-0.5,0,"$")': '($1)',
  'formatDecimal(1234.5678)': '1,234.57',
  'formatDecimal(1234.5678,2)': '1,234.57',
  'formatDecimal(-0.004,2)': '-0.00',
  'formatInteger(1234567)': '1,234,567',
  'formatInteger(-12.7)': '-13',
  'formatLanguage(1033)': 'English (United States)',
  'formatLanguage(1058)': '1058',
  'formatDateShort(d)': '3/15/2026',
  'formatDateLong(d)': 'Sunday, March 15, 2026',
  'formatDateLongAbbreviated(d)': 'Sun, Mar 15, 2026',
  'formatDateYearMonth(d)': 'March, 2026',
  'formatDateAsFilterStringInUTC(d)': '2026-03-15',
  'formatUTCDateTimeToUserDate(d)': '@1773583509123@',
  'formatUTCDateTimeToUserDate(d,1)': '@1773583509123@',
  'formatUserDateTimeToUTC(d)': '3/15/2026',
  'formatUserDateTimeToUTC(d,1)': 'NaN/NaN/NaN',
  'formatUserInput("1234.5",dec)': '1234.5',
  'getWeekOfYear(d)': 'NaN',
};

// Mounts a recorder with `spec` and reads the formatting calls, user settings and client values at the fixed instant.
async function readFormattingValues([instant, spec]) {
  await window.mountSurface('values', spec);
  const { formatting: f, userSettings: u, client: c } = window.contexts.values;
  const d = new Date(instant);
  const calls = {
    'formatCurrency(1234.5)': () => f.formatCurrency(1234.5),
    'formatCurrency(1234.5,2)': () => f.formatCurrency(1234.5, 2),
    'formatCurrency(1234.5,2,"€")': () => f.formatCurrency(1234.5, 2, '€'),
    'formatCurrency(-0.5,0,"$")': () => f.formatCurrency(-0.5, 0, '$'),
    'formatDecimal(1234.5678)': () => f.formatDecimal(1234.5678),
    'formatDecimal(1234.5678,2)': () => f.formatDecimal(1234.5678, 2),
    'formatDecimal(-0.004,2)': () => f.formatDecimal(-0.004, 2),
    'formatInteger(1234567)': () => f.formatInteger(1234567),
    'formatInteger(-12.7)': () => f.formatInteger(-12.7),
    'formatLanguage(1033)': () => f.formatLanguage(1033),
    'formatLanguage(1058)': () => f.formatLanguage(1058),
    'formatDateShort(d)': () => f.formatDateShort(d),
    'formatDateShort(d,true)': () => f.formatDateShort(d, true),
    'formatDateLong(d)': () => f.formatDateLong(d),
    'formatDateLongAbbreviated(d)': () => f.formatDateLongAbbreviated(d),
    'formatDateYearMonth(d)': () => f.formatDateYearMonth(d),
    'formatTime(d,0)': () => f.formatTime(d, 0),
    'formatTime(d,1)': () => f.formatTime(d, 1),
    'formatTime(d,3)': () => f.formatTime(d, 3),
    'formatDateAsFilterStringInUTC(d)': () => f.formatDateAsFilterStringInUTC(d),
    'formatDateAsFilterStringInUTC(d,true)': () => f.formatDateAsFilterStringInUTC(d, true),
    'formatUTCDateTimeToUserDate(d)': () => f.formatUTCDateTimeToUserDate(d),
    'formatUTCDateTimeToUserDate(d,1)': () => f.formatUTCDateTimeToUserDate(d, 1),
    'formatUserDateTimeToUTC(d)': () => f.formatUserDateTimeToUTC(d),
    'formatUserDateTimeToUTC(d,1)': () => f.formatUserDateTimeToUTC(d, 1),
    'formatUserInput("1234.5",dec)': () => f.formatUserInput('1234.5', { Type: 'decimal' }),
    'parseDateFromInput("3/15/2026")': () => f.parseDateFromInput('3/15/2026', { Type: 'date', Format: 'date' }),
    'getWeekOfYear(d)': () => String(f.getWeekOfYear(d)),
  };
  let networkError;
  try {
    c.isNetworkAvailable();
  } catch (error) {
    networkError = [error.constructor.name, error.message];
  }
  return {
    formatting: window.serial(Object.fromEntries(Object.entries(calls).map(([name, call]) => [name, call()]))),
    dateFormattingInfo: window.serial(u.dateFormattingInfo),
    numberFormattingInfo: window.serial(u.numberFormattingInfo),
    user: {
      userId: u.userId,
      userName: u.userName,
      securityRoles: u.securityRoles,
      roles: 'roles' in u,
      languageId: u.languageId,
      isRTL: u.isRTL,
      locale: u.locale,
      formatInfoCultureName: u.formatInfoCultureName,
      timeZoneUtcOffsetMinutes: u.timeZoneUtcOffsetMinutes,
    },
    offsets: [
      u.getTimeZoneOffsetMinutes(),
      u.getTimeZoneOffsetMinutes(new Date(Date.UTC(2026, 0, 15, 12))),
      u.getTimeZoneOffsetMinutes(new Date(Date.UTC(2026, 6, 15, 12))),
    ],
    client: {
      getClient: c.getClient(),
      getFormFactor: c.getFormFactor(),
      formFactor: c.formFactor,
      isOffline: c.isOffline(),
      disableScroll: c.disableScroll,
      languageCode: c.languageCode,
      userTimeZoneUtcOffsetMinutes: c.userTimeZoneUtcOffsetMinutes,
      networkError,
    },
  };
}

// @test-kind observation: paqvilo-developer pcf-parity digest-surface-r1.json (America/New_York) and digest-surface-r1-kyiv.json (Europe/Kyiv) `formatting`, `userSettings`, `getTimeZoneOffsetMinutes` and `client`, captured 2026-11-26 on a Power Pages site with the fixed instant 2026-03-15T14:05:09.123Z
for (const zone of [
  {
    timezoneId: 'America/New_York',
    offset: -300,
    local: {
      'formatDateShort(d,true)': '3/15/2026 10:05 AM',
      'formatTime(d,0)': '3/15/2026 10:05 AM',
      'formatTime(d,1)': '3/15/2026 9:05 AM',
      'formatTime(d,3)': '3/15/2026 6:05 AM',
      'formatDateAsFilterStringInUTC(d,true)': '2026-03-15T10:05:09',
      'parseDateFromInput("3/15/2026")': '@1773547200000@',
    },
  },
  {
    timezoneId: 'Europe/Kyiv',
    offset: 120,
    local: {
      'formatDateShort(d,true)': '3/15/2026 4:05 PM',
      'formatTime(d,0)': '3/15/2026 4:05 PM',
      'formatTime(d,1)': '3/15/2026 4:05 PM',
      'formatTime(d,3)': '3/15/2026 6:05 PM',
      'formatDateAsFilterStringInUTC(d,true)': '2026-03-15T16:05:09',
      'parseDateFromInput("3/15/2026")': '@1773525600000@',
    },
  },
])
  test(`formatting, user settings and client values match the capture in ${zone.timezoneId}`, async (t) => {
    const { page, errors } = await hostPage(t, { timezoneId: zone.timezoneId });
    const result = await page.evaluate(readFormattingValues, [INSTANT, {}]);
    assert.deepEqual(result.formatting, { ...CAPTURED_FORMATTING, ...zone.local });
    assert.deepEqual(result.dateFormattingInfo, CAPTURED_DATE_INFO);
    assert.deepEqual(result.numberFormattingInfo, CAPTURED_NUMBER_INFO);
    assert.deepEqual(result.user, {
      userId: null,
      userName: null,
      securityRoles: [],
      roles: false,
      languageId: 1033,
      isRTL: false,
      locale: undefined,
      formatInfoCultureName: '1033',
      timeZoneUtcOffsetMinutes: zone.offset,
    });
    assert.deepEqual(result.offsets, [zone.offset, zone.offset, zone.offset]);
    assert.deepEqual(result.client, {
      getClient: 'Web',
      getFormFactor: 1,
      formFactor: 2,
      isOffline: false,
      disableScroll: false,
      languageCode: '1033',
      userTimeZoneUtcOffsetMinutes: zone.offset,
      networkError: ['Error', 'Function not implemented.'],
    });
    assert.deepEqual(errors, []);
  });

// @test-kind observation: paqvilo-developer pcf-parity summary-E de-DE k1/k2 edit-full-de (a de-DE page of a site with en-US and de-DE, Europe/Kyiv, two loads), fixed instant 2026-03-15T14:05:09.123Z
test('a de-DE page reports its language but keeps the en-US formatting except two results', async (t) => {
  const { page, errors } = await hostPage(t, { timezoneId: 'Europe/Kyiv' });
  const result = await page.evaluate(readFormattingValues, [
    INSTANT,
    {
      language: { code: 'de-DE', lcid: 1031, isRTL: false },
      languages: [
        { code: 'en-US', lcid: 1033 },
        { code: 'de-DE', lcid: 1031 },
      ],
    },
  ]);
  assert.deepEqual(result.formatting, {
    ...CAPTURED_FORMATTING,
    'formatDateShort(d,true)': '3/15/2026 4:05 PM',
    'formatTime(d,0)': '3/15/2026 4:05 PM',
    'formatTime(d,1)': '3/15/2026 4:05 PM',
    'formatTime(d,3)': '3/15/2026 6:05 PM',
    'formatDateAsFilterStringInUTC(d,true)': '2026-03-15T16:05:09',
    'parseDateFromInput("3/15/2026")': '@1773525600000@',
    // Only these follow the page language.
    'formatLanguage(1033)': '1033',
    'formatUserDateTimeToUTC(d)': '15.03.2026',
    'formatUserDateTimeToUTC(d,1)': 'NaN.NaN.NaN',
  });
  assert.deepEqual(result.dateFormattingInfo, CAPTURED_DATE_INFO);
  assert.deepEqual(result.numberFormattingInfo, CAPTURED_NUMBER_INFO);
  assert.equal(result.user.languageId, 1031);
  assert.equal(result.user.formatInfoCultureName, '1031');
  assert.equal(result.client.languageCode, '1031');
  // orgSettings reports the page LCID, not the site's en-US base language; client.orgSettings has no languageId.
  assert.deepEqual(
    await page.evaluate(() => {
      const { orgSettings, client } = window.contexts.values;
      return [orgSettings.languageId, 'languageId' in client.orgSettings];
    }),
    [1031, false],
  );
  assert.deepEqual(errors, []);
});

// @test-kind observation: paqvilo-developer pcf-parity capture r1 actions-save, capture x1 extras (layout) and summary-B (label), 2026-11-26
test('mode, page, utils, resources, events and factory calls behave as captured on the field host', async (t) => {
  const { page, errors } = await hostPage(t);
  const result = await page.evaluate(
    async ([native, markup]) => {
      await window.mountSurface('field', native, markup);
      const context = window.contexts.field;
      const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
      await settle();
      const before = window.updates('field').length;
      const sizes = () => [context.mode.allocatedWidth, context.mode.allocatedHeight];
      const mode = {
        isControlDisabled: context.mode.isControlDisabled,
        isVisible: context.mode.isVisible,
        isRead: context.mode.isRead,
        label: context.mode.label,
        contextInfo: context.mode.contextInfo,
        sizes: sizes(),
        isAuthoringMode: context.mode.isAuthoringMode,
        isPreview: context.mode.isPreview,
        fullscreen: context.mode.fullscreen,
        hasFocus: context.mode.hasFocus,
      };
      const state = context.mode.setControlState({ probe: 1 });
      await settle();
      const afterState = window.updates('field').slice(before);
      const tracked = context.mode.trackContainerResize(true);
      await settle();
      const afterTracking = window.updates('field').slice(before + afterState.length);
      // Tracking again reports nothing more.
      context.mode.trackContainerResize(true);
      const fullScreen = context.mode.setFullScreen(false);
      let fullScreenTrue;
      try {
        context.mode.setFullScreen(true);
      } catch (error) {
        fullScreenTrue = [error.name, error.message];
      }
      const event = context.events.OnProbe();
      const render = context.factory.requestRender();
      const popup = typeof context.factory.getPopupService();
      await settle();
      const quiet = window.updates('field').length === before + afterState.length + afterTracking.length;
      let privilege;
      try {
        context.utils.hasEntityPrivilege('tst_row', 1, 3);
      } catch (error) {
        privilege = [error.name, error.message];
      }
      const dependency = await context.utils.loadDependency('tst_Synthetic.Missing').then(
        () => 'resolved',
        (reason) => ({ rejected: reason }),
      );
      const resourceCalls = [];
      for (const name of ['img/probe.png', 'img/missing.png', 'strings/Surface.1033.resx']) {
        let synchronous = true;
        context.resources.getResource(
          name,
          () => resourceCalls.push({ name, callback: 'success', synchronous }),
          (...args) => resourceCalls.push({ name, callback: 'failure', synchronous, args: args.length }),
        );
        synchronous = false;
      }
      await settle();
      return {
        mode,
        state,
        afterState,
        tracked: [tracked, sizes()],
        afterTracking,
        fullScreen,
        fullScreenTrue,
        event,
        render,
        popup,
        quiet,
        privilege,
        dependency: JSON.stringify(dependency),
        resourceCalls,
        strings: [context.resources.getString('Caption'), context.resources.getString('Missing_Key')],
        statusLabel: await window
          .mountSurface(
            'status',
            {
              host: 'field',
              args: { value: 1 },
              properties: [{ name: 'value', 'of-type': 'OptionSet', usage: 'bound' }],
              nativeBinding: {
                id: 'statuscode',
                control: 'status',
                properties: ['value'],
                attributes: { LogicalName: 'statuscode', Options: [{ Label: 'Active', Value: 1 }] },
                context: {
                  label: 'Status Reason',
                  entityId: native.nativeBinding.context.entityId,
                  entityTypeName: 'tst_row',
                },
              },
            },
            '<input id="statuscode" type="hidden" value="1">',
          )
          .then(() => window.contexts.status?.mode.label),
        page: {
          entityId: context.page.entityId,
          entityTypeName: context.page.entityTypeName,
          isPageReadOnly: context.page.isPageReadOnly,
          appId: context.page.appId,
          clientUrl: context.page.getClientUrl() === location.origin,
        },
      };
    },
    [NATIVE, NATIVE_MARKUP],
  );
  assert.deepEqual(result.mode, {
    isControlDisabled: false,
    isVisible: true,
    isRead: false,
    label: 'tst_Synthetic.Surface',
    contextInfo: { entityTypeName: 'tst_row', entityId: ROW, entityRecordName: '' },
    sizes: [-1, -1],
    isAuthoringMode: false,
    isPreview: false,
    fullscreen: undefined,
    hasFocus: true,
  });
  assert.equal(result.state, true);
  // summary-A2 Q3 (capture x1 extras): no updateView after setControlState, one ['layout'] after tracking starts.
  assert.deepEqual(result.afterState, []);
  assert.deepEqual(result.tracked, [undefined, [-1, -1]]);
  assert.deepEqual(result.afterTracking, [['layout']]);
  assert.equal(result.fullScreen, undefined);
  assert.deepEqual(result.fullScreenTrue, ['TypeError', 'r.overrideStyle is not a function']);
  assert.equal(result.event, null);
  assert.equal(result.render, undefined);
  assert.equal(result.popup, 'object');
  assert.equal(result.quiet, true);
  assert.deepEqual(result.privilege, ['PCFNonImplementedError', 'hasEntityPrivilege: Method not implemented.']);
  assert.equal(result.dependency, '{}');
  assert.deepEqual(result.resourceCalls, [
    { name: 'img/probe.png', callback: 'failure', synchronous: true, args: 0 },
    { name: 'img/missing.png', callback: 'failure', synchronous: true, args: 0 },
    { name: 'strings/Surface.1033.resx', callback: 'failure', synchronous: true, args: 0 },
  ]);
  assert.deepEqual(result.strings, ['Caption text', 'Missing_Key']);
  // summary-B: a status reason (and multi-select) column reports its display name.
  assert.equal(result.statusLabel, 'Status Reason');
  assert.deepEqual(result.page, {
    entityId: ROW,
    entityTypeName: 'tst_row',
    isPageReadOnly: false,
    appId: '047efa7c-0976-e711-8104-000d3aa167ac',
    clientUrl: true,
  });
  assert.deepEqual(errors, []);
});

// @test-kind observation+contract: paqvilo-developer pcf-parity capture r1 actions-save, summary-A2 Q1 (capture x1 extras) and summary-A3 Q-R1 (webapi-headers-1795684484298.json) webAPI sequence (2026-11-26): one token fetch reused, success shapes, entity-set names and a bad id with options rejected, a delete with a null id, retrieveRecord without options returns undefined with no request, and every rejection carries undefined; the detail kept in inspect().webApiErrors and the console warning are Paqvilo's own diagnostics
test('webAPI resolves the captured shapes, rejects with undefined and keeps the detail for the debugger', async (t) => {
  const { page, errors, warnings, requests } = await hostPage(t);
  const result = await page.evaluate(async (row) => {
    let tokens = 0;
    const provider = window.shell.getTokenDeferred;
    window.shell.getTokenDeferred = () => {
      tokens++;
      return provider();
    };
    const id = await window.mountSurface('api');
    const { webAPI } = window.contexts.api;
    const settle = async (promise) =>
      promise.then(
        (value) => ({ value }),
        (reason) => ({ rejected: reason === undefined ? 'undefined' : String(reason) }),
      );
    const created = await settle(webAPI.createRecord('tst_row', { tst_title: 'New' }));
    const noOptions = webAPI.retrieveRecord('tst_row', row);
    const badId = webAPI.retrieveRecord('tst_row', 'not-a-guid');
    const denied = await settle(webAPI.retrieveMultipleRecords('tst_row', '?$select=tst_title&$top=1'));
    const updated = await settle(webAPI.updateRecord('tst_row', row, { tst_title: 'Changed' }));
    const removed = await settle(webAPI.deleteRecord('tst_row', row));
    const unmapped = await settle(webAPI.createRecord('tst_missing', {}));
    const badIdWithOptions = await settle(webAPI.retrieveRecord('tst_row', 'not-a-guid', '?$select=tst_title'));
    const entitySet = await settle(webAPI.retrieveMultipleRecords('tst_rows', '?$select=tst_title', 1));
    return {
      tokens,
      badIdWithOptions,
      entitySet,
      created,
      noOptions: [noOptions === undefined, badId === undefined],
      denied,
      updated,
      removed,
      unmapped,
      details: window.__paqviloPcf
        .inspect(id)[0]
        .webApiErrors.map(({ operation, entityType, message, errorCode, status }) => ({
          operation,
          entityType,
          message,
          errorCode,
          status,
        })),
    };
  }, ROW);
  assert.equal(result.tokens, 1);
  // summary-A3 Q-R1: the host's webAPI requests name their table in pcf-entity-logical-name.
  assert.ok(requests.every((request) => request.headers['pcf-entity-logical-name'] === 'tst_row'));
  assert.deepEqual(result.badIdWithOptions, { rejected: 'undefined' });
  assert.deepEqual(result.entitySet, { rejected: 'undefined' });
  assert.deepEqual(result.created, { value: { id: ROW, entityType: 'tst_row' } });
  assert.deepEqual(result.noOptions, [true, true]);
  assert.deepEqual(result.denied, { rejected: 'undefined' });
  assert.deepEqual(result.updated, { value: { id: ROW, entityType: 'tst_row' } });
  assert.deepEqual(result.removed, { value: { id: null, entityType: 'tst_row' } });
  assert.deepEqual(result.unmapped, { rejected: 'undefined' });
  assert.deepEqual(result.details, [
    {
      operation: 'retrieveMultipleRecords',
      entityType: 'tst_row',
      message: 'Fixture read denied',
      errorCode: '90040120',
      status: 403,
    },
    {
      operation: 'createRecord',
      entityType: 'tst_missing',
      message: 'PCF Web API table has no imported mapping: tst_missing',
      errorCode: null,
      status: null,
    },
    {
      operation: 'retrieveRecord',
      entityType: 'tst_row',
      message: 'PCF Web API requires a record GUID',
      errorCode: null,
      status: null,
    },
    {
      operation: 'retrieveMultipleRecords',
      entityType: 'tst_rows',
      message: 'PCF Web API table has no imported mapping: tst_rows',
      errorCode: null,
      status: null,
    },
  ]);
  // Without options retrieveRecord sends nothing: one POST, the denied GET, the PATCH and the DELETE.
  assert.deepEqual(
    requests.map((request) => request.method + ' ' + request.url),
    [
      'POST /_api/tst_rows',
      'GET /_api/tst_rows?$select=tst_title&$top=1',
      `PATCH /_api/tst_rows(${ROW})`,
      `DELETE /_api/tst_rows(${ROW})`,
    ],
  );
  assert.equal(warnings.filter((text) => text.includes('inspect().webApiErrors')).length, 4);
  assert.deepEqual(errors, []);
});

// @test-kind observation: paqvilo-developer pcf-parity summary-A2 Q2 and Q5 (2026-11-26, capture r2 dialogs and capture x1 extras): navigation, device and utils members that throw PCFNonImplementedError, openErrorDialog and pickFile results, client and orgSettings values
test('navigation, device, utils, client and orgSettings members behave as captured on the field host', async (t) => {
  const { page, errors } = await hostPage(t);
  const result = await page.evaluate(
    async ([native, markup]) => {
      await window.mountSurface('field', native, markup);
      const { navigation, device, utils, client, orgSettings } = window.contexts.field;
      const thrown = (call) => {
        try {
          const value = call();
          return { returned: value === undefined ? 'undefined' : typeof value };
        } catch (error) {
          return [error.name, error.message];
        }
      };
      const errorOptions = { message: 'Save failed', details: 'Detail' };
      const errorDialog = navigation.openErrorDialog(errorOptions);
      const pending = await Promise.race([
        device.pickFile({}).then(() => 'settled'),
        new Promise((resolve) => setTimeout(() => resolve('pending'), 200)),
      ]);
      const entities = await utils.getEntitiesMetadata({ tst_row: ['tst_title'] }).then(
        () => 'resolved',
        (reason) => (reason === undefined ? 'undefined' : String(reason)),
      );
      const href = location.href;
      return {
        navigation: {
          openAlertDialog: thrown(() =>
            navigation.openAlertDialog({ text: 'Saved', title: 'Done', confirmButtonLabel: 'OK' }, { height: 200 }),
          ),
          openAlertDialogEmpty: thrown(() => navigation.openAlertDialog(undefined)),
          openConfirmDialog: thrown(() => navigation.openConfirmDialog({ text: 'Sure?' })),
          openWebResource: thrown(() => navigation.openWebResource('tst_page.html')),
          openFile: thrown(() =>
            navigation.openFile({ fileContent: 'YQ==', fileName: 'a.txt', mimeType: 'text/plain' }, { openMode: 2 }),
          ),
          openUrl: thrown(() => navigation.openUrl('/claude-pcf/')),
          openForm: thrown(() =>
            navigation.openForm({ entityName: 'tst_row', entityId: native.nativeBinding.context.entityId }),
          ),
          errorDialogSame: (await errorDialog) === errorOptions,
          dialogs: document.querySelectorAll('dialog[open]').length,
          stayed: location.href === href,
        },
        device: Object.fromEntries(
          ['captureImage', 'captureAudio', 'captureVideo', 'getBarcodeValue', 'getCurrentPosition'].map((name) => [
            name,
            thrown(() => device[name]({})),
          ]),
        ),
        pickFile: pending,
        utils: {
          lookupObjects: thrown(() => utils.lookupObjects({ entityTypes: ['contact'], allowMultiSelect: false })),
          getFormId: thrown(() => utils.getFormId()),
          getResourceString: thrown(() => utils.getResourceString('tst_Synthetic.Surface', 'Caption')),
          isFeatureEnabled: utils.isFeatureEnabled('PcfDatasetGrid'),
          getEntitiesMetadata: entities,
        },
        client: {
          getClientState: client.getClientState(),
          getClientInfo: thrown(() => client.getClientInfo()),
          getEnvironmentEndpoint: thrown(() => client.getEnvironmentEndpoint()),
        },
        orgSettings: window.serial(
          Object.fromEntries(
            Object.keys(orgSettings)
              .filter((name) => !name.startsWith('_'))
              .map((name) => [name, orgSettings[name] === undefined ? '(undefined)' : orgSettings[name]]),
          ),
        ),
      };
    },
    [NATIVE, NATIVE_MARKUP],
  );
  const notImplemented = (name) => ['PCFNonImplementedError', name + ': Method not implemented.'];
  assert.deepEqual(result.navigation, {
    openAlertDialog: notImplemented('openAlertDialog'),
    openAlertDialogEmpty: notImplemented('openAlertDialog'),
    openConfirmDialog: notImplemented('openConfirmDialog'),
    openWebResource: notImplemented('openWebResource'),
    openFile: notImplemented('openFile'),
    openUrl: notImplemented('openUrl'),
    openForm: notImplemented('openForm'),
    errorDialogSame: true,
    dialogs: 0,
    stayed: true,
  });
  assert.deepEqual(result.device, {
    captureImage: notImplemented('captureImage'),
    captureAudio: notImplemented('captureAudio'),
    captureVideo: notImplemented('captureVideo'),
    getBarcodeValue: notImplemented('getBarcodeValue'),
    getCurrentPosition: notImplemented('getCurrentPosition'),
  });
  assert.equal(result.pickFile, 'pending');
  assert.deepEqual(result.utils, {
    lookupObjects: notImplemented('lookupObjects'),
    getFormId: notImplemented('getFormId'),
    getResourceString: notImplemented('getResourceString'),
    isFeatureEnabled: false,
    getEntitiesMetadata: 'undefined',
  });
  assert.deepEqual(result.client, {
    getClientState: null,
    getClientInfo: ['Error', 'getClientInfo API not supported'],
    getEnvironmentEndpoint: ['Error', 'getEnvironmentEndpoint API not supported'],
  });
  const undefinedMembers =
    'webResourceHash enableBingMapsIntegration bingMapsApiKey availableBingMapLocales excludedCountriesForMaps bFDatacenter securitySettingForEmail appointmentRichEditorExperience gridTotalRecordCountLimit lookupCharacterCountBeforeResolve lookupResolveDelayMS advancedLookupEnabled isCollaborationExperienceEnabled pcfDatasetGridEnabled allowUsersHidingSystemViews appointmentWithTeamsMeeting appointmentWithTeamsMeetingV2 isEmailAddressValidationEnabled';
  assert.deepEqual(result.orgSettings, {
    languageId: 1033,
    attributes: {},
    uniqueName: null,
    isAutoSaveEnabled: false,
    tenantId: '(undefined)',
    isRTL: false,
    fiscalYearStartDate: '@' + Date.parse('2017-01-01T18:59:00Z') + '@',
    fiscalPeriodFormat: 1,
    fiscalPeriodType: 2002,
    fiscalYearFormatYear: 1,
    fiscalYearFormatPrefix: 1,
    fiscalYearFormatSuffix: 3,
    fiscalYearDisplayCode: 1,
    fiscalPeriodConnector: 's',
    showWeekNumber: false,
    boundDashboardDefaultCardExpanded: false,
    allowUnresolvedPartiesOnEmailSend: false,
    ...Object.fromEntries(undefinedMembers.split(' ').map((name) => [name, '(undefined)'])),
  });
  assert.deepEqual(errors, []);
});

// @test-kind observation: paqvilo-developer pcf-parity summary-A2 Q3 (2026-11-26, capture x1 extras layout): setControlState causes no updateView and trackContainerResize(true) one ['layout'] update, so a control calling both from updateView cannot loop
test('a control calling setControlState and trackContainerResize(true) inside updateView gets one layout update', async (t) => {
  const { page, errors } = await hostPage(t);
  const updates = await page.evaluate(async () => {
    window.ComponentFramework.registerControl(
      'Synthetic.Reentrant',
      class {
        init(context, notify, state, container) {
          this.key = container.dataset.key;
        }
        updateView(context) {
          window.log.push([this.key, 'updateView', [...context.updatedProperties]]);
          context.mode.setControlState({ seen: window.log.length });
          context.mode.trackContainerResize(true);
        }
        getOutputs() {
          return {};
        }
        destroy() {}
      },
    );
    await window.mountSurface('loop', { constructor: 'Synthetic.Reentrant', schemaName: 'tst_Synthetic.Reentrant' });
    for (let turn = 0; turn < 20; turn++) await new Promise((resolve) => setTimeout(resolve, 0));
    return window.updates('loop');
  });
  assert.deepEqual(updates, [[], ['layout']]);
  assert.deepEqual(errors, []);
});

// @test-kind observation: paqvilo-developer pcf-parity summary-A2 Q6 (2026-11-26, capture r2 subgrid-actions DatasetProbe): a subgrid control reports the parent form's record with an empty record name, the control name as label and -1 sizes
test('a subgrid control reports the parent form record, the control name and no size', async (t) => {
  const { page, errors } = await hostPage(t);
  const result = await page.evaluate(async (row) => {
    await window.mountSurface('grid', {
      host: 'subgrid',
      properties: [],
      datasetContext: { entityTypeName: 'tst_row', entityId: row },
    });
    const { mode, page: host } = window.contexts.grid;
    return {
      contextInfo: mode.contextInfo,
      page: [host.entityTypeName, host.entityId],
      label: mode.label,
      sizes: [mode.allocatedWidth, mode.allocatedHeight],
    };
  }, ROW);
  assert.deepEqual(result, {
    contextInfo: { entityTypeName: 'tst_row', entityId: ROW, entityRecordName: '' },
    page: ['tst_row', ROW],
    label: 'tst_Synthetic.Surface',
    sizes: [-1, -1],
  });
  assert.deepEqual(errors, []);
});

// @test-kind observation: paqvilo-developer pcf-parity summary-A3 Q-R1, Q-R2 and Q-R3 (2026-11-26, metadata-raw-admin2-1795684424035.json, capture m1 metadata, capture na1 extras): the metadata request headers, the Attributes collection, every other navigation member and the device quirks
test('getEntityMetadata sends the host headers, its collection and the remaining navigation and device members behave as captured', async (t) => {
  const { page, errors, requests } = await hostPage(t);
  const result = await page.evaluate(async () => {
    await window.mountSurface('model');
    const { navigation, device, utils } = window.contexts.model;
    const thrown = (call) => {
      try {
        const value = call();
        return { returned: value };
      } catch (error) {
        return [error.name, error.message];
      }
    };
    const metadata = await utils.getEntityMetadata('tst_row', ['tst_title', 'tst_choice']);
    const collection = metadata.Attributes;
    const visited = [];
    collection.forEach((item, index) => visited.push([item.LogicalName, index]));
    const all = collection.get();
    return {
      collection: {
        isArray: Array.isArray(collection),
        length: collection.getLength(),
        first: collection.getByIndex(0).LogicalName,
        sameList: [collection.get(0), collection.get('tst_title')].every((list) => list === all),
        list: all.map((item) => item.LogicalName),
        visited,
      },
      navigation: Object.fromEntries(
        [
          'openGridPage',
          'openGrid',
          'openEditForm',
          'openDashboard',
          'openCreateForm',
          'openSearch',
          'openPowerBIFullScreenPage',
          'openUrlWithProtocol',
          'openPhoneNumber',
          'openMaps',
          'openMap',
          'openDialog',
          'openTaskFlow',
          'navigateTo',
        ].map((name) => [name, thrown(() => navigation[name]())]),
      ),
      device: {
        openARViewer: thrown(() => device.openARViewer({})),
        getMessageReceiver: thrown(() => device.getMessageReceiver()),
        isTakePictureOperationAvailable: thrown(() => device.isTakePictureOperationAvailable()),
        getDeclaredFeatures: thrown(() => device.getDeclaredFeatures()),
      },
      calls: window.__paqviloPcf.inspect('model-1')[0].hostCalls.map((call) => call.api),
    };
  });
  const notImplemented = (name) => ['PCFNonImplementedError', name + ': Method not implemented.'];
  assert.deepEqual(result.collection, {
    isArray: false,
    length: 2,
    first: 'tst_choice',
    sameList: true,
    list: ['tst_choice', 'tst_title'],
    visited: [
      ['tst_choice', 0],
      ['tst_title', 1],
    ],
  });
  const navigation = Object.fromEntries(Object.keys(result.navigation).map((name) => [name, notImplemented(name)]));
  navigation.openGrid = notImplemented('openGridPage');
  navigation.openEditForm = notImplemented('openForm');
  assert.deepEqual(result.navigation, navigation);
  assert.deepEqual(result.device, {
    openARViewer: notImplemented('openARViewer'),
    getMessageReceiver: notImplemented('openARViewer'),
    isTakePictureOperationAvailable: { returned: null },
    getDeclaredFeatures: notImplemented('isCaptureAudioOperationAvailable'),
  });
  assert.deepEqual(result.calls, []);
  const metadataRequest = requests.find((request) => request.url.startsWith('/_api/EntityDefinitions'));
  assert.equal(
    metadataRequest.url,
    "/_api/EntityDefinitions(LogicalName='tst_row')?$expand=Attributes($filter=LogicalName eq 'tst_title' or LogicalName eq 'tst_choice')",
  );
  assert.deepEqual(
    {
      'pcf-entity-logical-name': metadataRequest.headers['pcf-entity-logical-name'],
      'x-requested-with': metadataRequest.headers['x-requested-with'],
      'content-type': metadataRequest.headers['content-type'],
      accept: metadataRequest.headers.accept,
      token: metadataRequest.headers.__requestverificationtoken,
    },
    {
      'pcf-entity-logical-name': 'tst_row',
      'x-requested-with': 'XMLHttpRequest',
      'content-type': 'application/json',
      accept: '*/*',
      token: undefined,
    },
  );
  assert.deepEqual(errors, []);
});

// @test-kind observation: paqvilo-developer pcf-parity summary-A3 Q-R4 (2026-11-26, capture m1 list-bodies DatasetProbe on an entity list): no record, the control name as label, -1 sizes and an enabled control
test('an entity list control reports no record, the control name and no size', async (t) => {
  const { page, errors } = await hostPage(t);
  const result = await page.evaluate(async () => {
    await window.mountSurface('list', { host: 'list', properties: [] });
    const { mode, page: host } = window.contexts.list;
    return {
      contextInfo: mode.contextInfo,
      page: [host.entityTypeName, host.entityId, host.isPageReadOnly],
      label: mode.label,
      sizes: [mode.allocatedWidth, mode.allocatedHeight],
      isControlDisabled: mode.isControlDisabled,
    };
  });
  assert.deepEqual(result, {
    contextInfo: { entityTypeName: undefined, entityId: undefined, entityRecordName: '' },
    page: [undefined, undefined, false],
    label: 'tst_Synthetic.Surface',
    sizes: [-1, -1],
    isControlDisabled: false,
  });
  assert.deepEqual(errors, []);
});

// @test-kind unproven: the refusal of an invalid column list follows the local model
test('invalid metadata columns follow the local model', async (t) => {
  const { page, errors, requests } = await hostPage(t);
  const result = await page.evaluate(async () => {
    await window.mountSurface('model');
    const invalid = await window.contexts.model.utils.getEntityMetadata('tst_row', ['not a column']).then(
      () => 'resolved',
      (error) => error.message,
    );
    return { invalid };
  });
  assert.deepEqual(result, { invalid: 'PCF utils.getEntityMetadata needs column logical names: not a column' });
  // An invalid column list sends no request.
  assert.equal(requests.filter((request) => request.url.startsWith('/_api/EntityDefinitions')).length, 0);
  assert.deepEqual(errors, []);
});

// @test-kind unproven: the popup service and the trackContainerResize latch are local models; the capture shows the popup service's members only and called trackContainerResize(true) once
test('a created popup stays out of the page until opened, a repeated name replaces it and tracking reports layout once', async (t) => {
  const { page, errors } = await hostPage(t);
  await page.evaluate(async () => {
    const button = document.createElement('button');
    button.id = 'under';
    button.textContent = 'Under the popup';
    button.style.cssText = 'position:fixed;top:10px;left:10px';
    button.addEventListener('click', () => (window.underClicks = (window.underClicks ?? 0) + 1));
    document.body.append(button);
    await window.mountSurface('popups');
    const service = window.contexts.popups.factory.getPopupService();
    const content = document.createElement('p');
    content.textContent = 'Popup content';
    service.createPopup({ name: 'first', type: 1, content });
    window.service = service;
  });
  const popup = page.locator('[data-paqvilo-pcf-popup="first"]');
  assert.equal(await popup.isVisible(), false);
  await page.locator('#under').click();
  assert.equal(await page.evaluate(() => window.underClicks), 1);
  await page.evaluate(() => window.service.openPopup('first'));
  assert.equal(await popup.isVisible(), true);
  await page.evaluate(() => window.service.closePopup('first'));
  assert.equal(await popup.isVisible(), false);
  await page.locator('#under').click();
  assert.equal(await page.evaluate(() => window.underClicks), 2);
  const result = await page.evaluate(async () => {
    window.service.createPopup({ name: 'first', type: 1 });
    const nodes = document.querySelectorAll('[data-paqvilo-pcf-popup="first"]').length;
    let unnamed;
    try {
      window.service.createPopup({ type: 1 });
    } catch (error) {
      unnamed = error.message;
    }
    const { mode } = window.contexts.popups;
    const before = window.updates('popups').length;
    mode.trackContainerResize(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    mode.trackContainerResize(false);
    mode.trackContainerResize(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const layout = window.updates('popups').slice(before);
    document.querySelector('[data-key="popups"]').remove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    return { nodes, unnamed, layout, left: document.querySelectorAll('[data-paqvilo-pcf-popup]').length };
  });
  assert.deepEqual(result, {
    nodes: 1,
    unnamed: 'PCF popup service: createPopup needs a popup name',
    layout: [['layout']],
    left: 0,
  });
  assert.deepEqual(errors, []);
});

// The Liquid probe's manifest properties (capture r1 lq-typed): name, of-type, usage.
const LIQUID_PROPERTIES = [
  ['boundText', 'SingleLine.Text', 'bound'],
  ['textValue', 'SingleLine.Text', 'input'],
  ['wholeValue', 'Whole.None', 'input'],
  ['decimalValue', 'Decimal', 'input'],
  ['floatValue', 'FP', 'input'],
  ['moneyValue', 'Currency', 'input'],
  ['flagValue', 'TwoOptions', 'input'],
  ['dayValue', 'DateAndTime.DateOnly', 'input'],
  ['momentValue', 'DateAndTime.DateAndTime', 'input'],
  ['flavour', 'Enum', 'input'],
  ['MixedCaseArg', 'SingleLine.Text', 'input'],
].map(([name, type, usage]) => ({ name, 'of-type': type, usage, 'default-value': '' }));
const input = (raw, type, extra = {}) => ({
  raw,
  formatted: null,
  attributes: {},
  type,
  error: false,
  errorMessage: null,
  notifications: null,
  security: {},
  ...extra,
});
const invalidNumber = (type) => input('NaN', type, { error: true, errorMessage: 'Value is not a valid number' });

// @test-kind observation: paqvilo-developer pcf-parity capture r1 lq-typed and lq-no-arguments-ny.json (2026-11-26, America/New_York): Liquid-tag parameters built from the server's ControlProperties, the parameter order with labelForPrefix and deviceSizeMode, input shapes, NaN numbers and absent dates
test('Liquid-tag parameters follow the captured ControlProperties coercion and shapes', async (t) => {
  const { page, errors } = await hostPage(t);
  const result = await page.evaluate(async (properties) => {
    const describe = (parameters) =>
      Object.fromEntries(
        Object.entries(parameters).map(([name, parameter]) => {
          const { attributes, raw, ...rest } = parameter;
          return [
            name,
            {
              ...rest,
              raw: raw instanceof Date ? 'local ' + raw.toString().slice(0, 24) : Number.isNaN(raw) ? 'NaN' : raw,
              ...(attributes === undefined
                ? {}
                : { attributes: Object.keys(attributes).length ? Object.keys(attributes).length : {} }),
            },
          ];
        }),
      );
    await window.mountSurface('typed', {
      properties,
      // ControlProperties as the server writes them for the lq-typed case.
      args: {
        boundText: 'bound',
        textValue: 'typed',
        wholeValue: 42,
        floatValue: '1.25',
        moneyValue: '99.99',
        flagValue: true,
        dayValue: '2026-03-15T00:00:00',
        momentValue: '2026-03-15T14:05:09',
        flavour: '3',
        MixedCaseArg: 'mixed',
      },
    });
    await window.mountSurface('empty', { properties, args: { textvalue: 'case differs', dayValue: 'not a date' } });
    const typed = window.contexts.typed.parameters;
    return {
      order: Object.keys(typed),
      typed: describe(typed),
      empty: describe(window.contexts.empty.parameters),
      bound: {
        logicalName: /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(typed.boundText.attributes.LogicalName),
        displayName: typed.boundText.attributes.DisplayName,
        type: typed.boundText.attributes.Type,
        format: typed.boundText.attributes.Format,
      },
      device: typed.deviceSizeMode.attributes.LogicalName,
    };
  }, LIQUID_PROPERTIES);
  const bound = (raw) => ({
    raw,
    formatted: raw,
    attributes: 26,
    type: 'SingleLine.Text',
    error: false,
    errorMessage: null,
    notifications: null,
    security: { secured: false, editable: true, readable: true },
  });
  const edges = {
    labelForPrefix: { type: '', raw: 'Surface-Surface-Surface', error: false, errorMessage: '', security: null },
    deviceSizeMode: {
      raw: 0,
      formatted: '0',
      attributes: 26,
      type: 'Whole.None',
      error: false,
      errorMessage: null,
      notifications: null,
      security: { secured: false, editable: true, readable: true },
    },
  };
  assert.deepEqual(result.order, ['labelForPrefix', ...LIQUID_PROPERTIES.map((item) => item.name), 'deviceSizeMode']);
  assert.deepEqual(result.typed, {
    labelForPrefix: edges.labelForPrefix,
    boundText: bound('bound'),
    textValue: input('typed', 'SingleLine.Text'),
    wholeValue: input(42, 'Whole.None'),
    decimalValue: invalidNumber('Decimal'),
    floatValue: input(1.25, 'FP'),
    moneyValue: input(99.99, 'Currency'),
    flagValue: input(true, 'TwoOptions'),
    dayValue: input('local Sun Mar 15 2026 00:00:00', 'DateAndTime.DateOnly'),
    momentValue: input('local Sun Mar 15 2026 14:05:09', 'DateAndTime.DateAndTime'),
    flavour: input('3', 'Enum'),
    MixedCaseArg: input('mixed', 'SingleLine.Text'),
    deviceSizeMode: edges.deviceSizeMode,
  });
  assert.deepEqual(result.empty, {
    labelForPrefix: edges.labelForPrefix,
    boundText: bound(null),
    textValue: input(null, 'SingleLine.Text'),
    wholeValue: invalidNumber('Whole.None'),
    decimalValue: invalidNumber('Decimal'),
    floatValue: invalidNumber('FP'),
    moneyValue: invalidNumber('Currency'),
    flagValue: input(null, 'TwoOptions'),
    flavour: input(null, 'Enum'),
    MixedCaseArg: input(null, 'SingleLine.Text'),
    deviceSizeMode: edges.deviceSizeMode,
  });
  assert.deepEqual(result.bound, { logicalName: true, displayName: 'boundText', type: 'string', format: 'Text' });
  assert.equal(result.device, 'deviceSizeMode');
  assert.deepEqual(errors, []);
});

const labels = (text) => `<labels><label description="${text}" languagecode="1033"/></labels>`;
const attribute = (name, type, extra = '') =>
  `<attribute PhysicalName="${name}"><Name>${name}</Name><LogicalName>${name}</LogicalName><Type>${type}</Type>${extra}<displaynames><displayname description="${name}" languagecode="1033"/></displaynames></attribute>`;

// @test-kind observation: paqvilo-developer pcf-parity capture r1 edit-full, read-full-ny.json, lq-typed-ny.json and summary-A2 Q4 (capture x1 extras), 2026-11-26, signed-in contact: a form field reports the control name and the form record with an empty record name, a read-only form isRead and isControlDisabled, a Liquid tag no record, userSettings no user, and getEntityMetadata reads the EntityDefinitions route
test('native form fields and a Liquid tag on the local portal report the captured mode, page, user and metadata values', async (t) => {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'pcf-context-surface-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const bundle = `ComponentFramework.registerControl('Synthetic.Surface', class {
    init(context) {
      const key = context.parameters.value.attributes.LogicalName === 'tst_title' ? 'field' : 'liquid';
      window.surface = window.surface || {};
      const { mode, page, userSettings } = context;
      if (key === 'field' && !window.metadata)
        window.metadata = context.utils.getEntityMetadata('tst_row', ['tst_title']).then((metadata) => ({
          LogicalName: metadata.LogicalName,
          EntitySetName: metadata.EntitySetName,
          PrimaryNameAttribute: metadata.PrimaryNameAttribute,
          DisplayName: typeof metadata.DisplayName,
          privileges: Array.isArray(metadata.Privileges) && metadata.Privileges.length > 0,
          attributes: metadata.Attributes.get('tst_title').map((attribute) => [attribute['@odata.type'], attribute.LogicalName, attribute.AttributeType]),
          length: metadata.Attributes.getLength(),
        }), (error) => ({ failed: String(error?.message ?? error) }));
      window.surface[key] = {
        label: mode.label,
        isControlDisabled: mode.isControlDisabled,
        contextInfo: mode.contextInfo,
        isRead: mode.isRead,
        sizes: [mode.allocatedWidth, mode.allocatedHeight],
        page: [page.entityTypeName, page.entityId],
        user: [userSettings.userId, userSettings.userName, userSettings.securityRoles, 'roles' in userSettings],
      };
    }
    updateView() {}
    getOutputs() { return {}; }
    destroy() {}
  });`;
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Surface',
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html':
      '{% entityform name:"Edit row" %}{% codecomponent name:tst_Synthetic.Surface value:"Liquid" %}',
    'portal/Read.webpage.yml':
      'adx_webpageid: read\nadx_name: Read\nadx_partialurl: read\nadx_parentpageid: home\nadx_pagetemplateid: readtemplate',
    'portal/Read.pagetemplate.yml':
      'adx_pagetemplateid: readtemplate\nadx_webtemplateid: readweb\nadx_usewebsiteheaderandfooter: true',
    'portal/Read.webtemplate.yml': 'adx_webtemplateid: readweb\nadx_name: Read',
    'portal/Read.webtemplate.source.html': '{% entityform name:"Read row" %}',
    'portal/ReadRow.basicform.yml':
      'adx_entityformid: row-read\nadx_name: Read row\nadx_entityname: tst_row\nadx_formname: Portal row\nadx_mode: 100000002\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: id',
    'portal/tst_title_read.basicform.basicformmetadata.yml':
      'adx_entityformmetadataid: m-title-read\nadx_entityform: row-read\nadx_type: 100000000\nadx_attributelogicalname: tst_title\nadx_controlstyle: 756150001',
    'portal/Row.basicform.yml':
      'adx_entityformid: row-basic\nadx_name: Edit row\nadx_entityname: tst_row\nadx_formname: Portal row\nadx_mode: 100000001\nadx_entitysourcetype: 756150001\nadx_recordidquerystringparametername: id\nadx_hideformonsuccess: false',
    'portal/tst_title.basicform.basicformmetadata.yml':
      'adx_entityformmetadataid: m-title\nadx_entityform: row-basic\nadx_type: 100000000\nadx_attributelogicalname: tst_title\nadx_controlstyle: 756150001',
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Synthetic</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    'solution/Entities/tst_Row/Entity.xml': `<Entity><Name>tst_row</Name><EntityInfo><entity Name="tst_row"><EntitySetName>tst_rows</EntitySetName><attributes>${attribute('tst_rowid', 'primarykey')}${attribute('tst_title', 'nvarchar', '<DisplayMask>PrimaryName|ValidForForm</DisplayMask><MaxLength>100</MaxLength>')}</attributes></entity></EntityInfo></Entity>`,
    'solution/Entities/tst_Row/FormXml/main/row-form.xml': `<forms><systemform><formid>{row-form}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="general"><columns><column><sections><section name="main"><rows><row><cell>${labels('Title')}<control id="tst_title" uniqueid="u-title" datafieldname="tst_title"/></cell></row></rows></section></sections></column></columns></tab></tabs><controlDescriptions><controlDescription forControl="u-title"><customControl name="tst_Synthetic.Surface" formFactor="0"><parameters><value type="SingleLine.Text">tst_title</value></parameters></customControl></controlDescription></controlDescriptions></form><LocalizedNames><LocalizedName description="Portal row" languagecode="1033"/></LocalizedNames></systemform></forms>`,
    'solution/Controls/tst_Synthetic.Surface/ControlManifest.xml':
      '<manifest><control namespace="Synthetic" constructor="Surface" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound"/><resources><code path="bundle.js"/></resources></control></manifest>',
    'solution/Controls/tst_Synthetic.Surface/ControlManifest.xml.data.xml':
      '<CustomControl><Name>tst_Synthetic.Surface</Name></CustomControl>',
    'solution/Controls/tst_Synthetic.Surface/bundle.js': bundle,
  };
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
  const app = await createSimulator({
    sourceDir: path.join(root, 'portal'),
    solutionRoots: [path.join(root, 'solution')],
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: { tst_row: { entitySet: 'tst_rows', idColumn: 'tst_rowid', nameColumn: 'tst_title' } },
      tables: { tst_row: [{ tst_rowid: ROW, tst_title: 'Saved row' }] },
      permissions: [],
      settings: { permissionMode: 'permissive' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        identity: { id: 'editor', roles: ['Editor'] },
        endpoints: [],
        live: { origin: null },
        componentSchemas: {},
      },
    },
  });
  ownedFixture(t).add(() => app.close());
  const page = await browser.page(t);
  await signInContext(page.context(), app, 'editor', { roles: ['Editor'] });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(app.url + '/?id=' + ROW);
  await page.waitForFunction(
    () =>
      (window.surface?.field && window.surface?.liquid) ||
      document.querySelector('[data-mirage-component="codecomponent"][role="alert"]'),
  );
  assert.deepEqual(await page.locator('[data-mirage-component="codecomponent"][role="alert"]').allTextContents(), []);
  const surface = await page.evaluate(() => window.surface);
  assert.deepEqual(await page.evaluate(() => window.metadata), {
    LogicalName: 'tst_row',
    EntitySetName: 'tst_rows',
    PrimaryNameAttribute: 'tst_title',
    DisplayName: 'string',
    privileges: true,
    attributes: [['#Microsoft.Dynamics.CRM.StringAttributeMetadata', 'tst_title', 'String']],
    length: 1,
  });
  assert.deepEqual(surface.field, {
    label: 'tst_Synthetic.Surface',
    isControlDisabled: false,
    contextInfo: { entityTypeName: 'tst_row', entityId: ROW, entityRecordName: '' },
    isRead: false,
    sizes: [-1, -1],
    page: ['tst_row', ROW],
    user: [null, null, [], false],
  });
  assert.deepEqual(surface.liquid, {
    label: 'tst_Synthetic.Surface',
    isControlDisabled: false,
    contextInfo: { entityTypeName: undefined, entityId: undefined, entityRecordName: '' },
    isRead: false,
    sizes: [-1, -1],
    page: [undefined, undefined],
    user: [null, null, [], false],
  });
  // The read-only form: isRead and isControlDisabled (read-full-ny.json).
  await page.goto(app.url + '/read/?id=' + ROW);
  await page.waitForFunction(
    () => window.surface?.field || document.querySelector('[data-mirage-component="codecomponent"][role="alert"]'),
  );
  assert.deepEqual(await page.locator('[data-mirage-component="codecomponent"][role="alert"]').allTextContents(), []);
  const read = await page.evaluate(() => window.surface.field);
  assert.deepEqual([read.isRead, read.isControlDisabled, read.contextInfo.entityId], [true, true, ROW]);
  assert.deepEqual(errors, []);
});
