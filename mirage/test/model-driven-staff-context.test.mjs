import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../api.mjs';
import { staffContext } from '../lib/staff-session.mjs';
import { createFormClientRuntime } from '../lib/model-driven/client-runtime.mjs';
import { pcfUserSettings, staffFormatting, ANONYMOUS_STAFF_CONTEXT } from '../lib/model-driven/pcf-runtime.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

const USER = '77777777-7777-4777-8777-777777777777', ROLE = '77777777-7777-4777-8777-777777777778', EURO = '77777777-7777-4777-8777-777777777779';

// An organization: one user with a custom role, a German usersettings row in Central European time and a euro currency.
function runtime({ settings = true } = {}) {
  const tables = {
    organization: [{ organizationid: 'org', languagecode: 1033, localeid: 1033, basecurrencyid: { id: 'usd' } }],
    usersettings: settings ? [{ systemuserid: USER, uilanguageid: 1031, localeid: 1031, timezonecode: 110, transactioncurrencyid: { id: EURO } }] : [],
    transactioncurrency: [{ transactioncurrencyid: 'usd', currencyname: 'Base', isocurrencycode: 'USD', currencysymbol: '$', currencyprecision: 2 },
      { transactioncurrencyid: EURO, currencyname: 'Invented euro', isocurrencycode: 'EUR', currencysymbol: '€', currencyprecision: 2 }],
  };
  return { store: { tableRows: name => tables[name] ?? [] }, principals: { roles: () => [{ roleid: ROLE, name: 'Invented reviewer' }] } };
}
const user = { systemuserid: USER, fullname: 'Invented staff' };

test('the staff context derives roles, language, locale, time zone and currency from organization data', () => {
  const context = staffContext(runtime(), user);
  assert.deepEqual(context.securityRoles, [ROLE]);
  assert.deepEqual(context.roles, [{ id: ROLE, name: 'Invented reviewer' }]);
  assert.equal(context.languageId, 1031); assert.equal(context.locale, 'de-DE'); assert.equal(context.isRTL, false);
  assert.equal(context.timeZone.iana, 'Europe/Berlin');
  assert.deepEqual(context.transactionCurrency, { id: EURO, name: 'Invented euro', isoCode: 'EUR', symbol: '€', precision: 2 });
  assert.equal(context.numberFormattingInfo.numberDecimalSeparator, ','); assert.equal(context.numberFormattingInfo.numberGroupSeparator, '.');
  assert.equal(context.dateFormattingInfo.firstDayOfWeek, 1); assert.equal(context.dateFormattingInfo.dayNames[0], 'Sonntag');
  // Without a usersettings row the organization language, base currency and UTC apply.
  const fallback = staffContext(runtime({ settings: false }), user);
  assert.equal(fallback.languageId, 1033); assert.equal(fallback.transactionCurrency.isoCode, 'USD'); assert.equal(fallback.timeZone.iana, 'UTC');
});

test('PCF userSettings, PCF formatting and Xrm userSettings read the same staff context', () => {
  const context = staffContext(runtime(), user);
  const pcf = pcfUserSettings(context), formatting = staffFormatting(context);
  assert.deepEqual(pcf.securityRoles, [ROLE]); assert.equal(pcf.languageId, 1031); assert.equal(pcf.userId, USER);
  const winter = new Date(Date.UTC(2026, 0, 15)), summer = new Date(Date.UTC(2026, 6, 15));
  assert.equal(pcf.getTimeZoneOffsetMinutes(winter), 60); assert.equal(pcf.getTimeZoneOffsetMinutes(summer), 120);
  assert.match(formatting.formatCurrency(1234.5), /^1\.234,50\s?€$/);
  assert.equal(formatting.formatDecimal(1234.5, 1), '1.234,5');
  const table = { entity: 'x_item', idColumn: 'x_itemid', nameColumn: 'x_name', fields: { x_name: { name: 'x_name', type: 'text' } } };
  const { Xrm } = createFormClientRuntime({ table, tables: { x_item: table }, form: { clientEvents: [], attributes: ['x_name'] }, record: {}, read: () => null, write() {}, isDirty: () => false,
    controlNames: name => name ? [name] : ['x_name'], controlField: name => name, controlState() {}, notification() {}, request: async () => ({}), staffContext: context });
  const settings = Xrm.Utility.getGlobalContext().userSettings;
  assert.deepEqual(settings.securityRoles, pcf.securityRoles); assert.equal(settings.languageId, pcf.languageId); assert.equal(settings.isRTL, false);
  assert.deepEqual(settings.roles.get().map(role => [role.id, role.name]), [[ROLE, 'Invented reviewer']]);
  assert.deepEqual(settings.transactionCurrency, { id: EURO, entityType: 'transactioncurrency', name: 'Invented euro' });
  // Xrm takes no date: today's Berlin offset is standard or daylight time.
  assert.ok([60, 120].includes(settings.getTimeZoneOffsetMinutes()));
});

test('an unknown session answers the documented anonymous context', () => {
  const pcf = pcfUserSettings();
  assert.deepEqual(pcf.securityRoles, []); assert.equal(pcf.languageId, ANONYMOUS_STAFF_CONTEXT.languageId); assert.equal(pcf.getTimeZoneOffsetMinutes(new Date()), 0);
});

test('the staff session payload carries the server-built context and record capabilities flag secured columns', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'staff-context-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  const entity = '<Entity><Name>x_item</Name><EntityInfo><entity Name="x_item"><EntitySetName>x_items</EntitySetName><PrimaryIdAttribute>x_itemid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes>'
    + '<attribute PhysicalName="x_itemid"><Name>x_itemid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute>'
    + '<attribute PhysicalName="x_secret"><Name>x_secret</Name><Type>nvarchar</Type><IsSecured>1</IsSecured></attribute></attributes></entity></EntityInfo></Entity>';
  for (const [name, content] of Object.entries({ 'solution/Other/Solution.xml': '<ImportExportXml><SolutionManifest><UniqueName>InventedStaff</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>', 'solution/Entities/x_item/Entity.xml': entity })) {
    const file = path.join(root, name); await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(file, content);
  }
  const sim = await createSimulator({ runtime: { kind: 'model-driven' }, solutionRoots: [path.join(root, 'solution')], projectRoot: root, port: 0, watch: false, simulation: { level: 'dry-run' },
    dataverse: { enabled: false, tds: { enabled: false }, users: [{ objectId: USER, domainname: 'staff@example.test', fullname: 'Invented staff', roles: ['Basic User'] }] } });
  ownedFixture(t).add(() => sim.close());
  const headers = { 'content-type': 'application/json', 'x-sim-csrf': sim.csrf };
  const session = await (await fetch(sim.url + '/_sim/api/dataverse/session', { headers })).json();
  const staff = session.users.find(entry => entry.name === 'Invented staff');
  const selected = await fetch(sim.url + '/_sim/api/dataverse/session', { method: 'POST', headers, body: JSON.stringify({ userId: staff.id }) });
  const body = await selected.json(), cookie = selected.headers.get('set-cookie').split(';')[0];
  const basicUser = sim.store.tableRows('role').find(role => role.name === 'Basic User');
  assert.deepEqual(body.current.context.securityRoles, [String(basicUser.roleid).toLowerCase()]);
  assert.equal(body.current.context.userName, 'Invented staff'); assert.equal(body.current.context.languageId, 1033);
  const created = await (await fetch(sim.url + '/_apps/api/tables/x_item', { method: 'POST', headers, body: JSON.stringify({ x_name: 'Invented' }) })).json();
  const read = await (await fetch(sim.url + `/_apps/api/tables/x_item/${created.id}`, { headers: { ...headers, cookie } })).json();
  assert.equal(read.capabilities.fields.x_secret.secured, true); assert.equal(read.capabilities.fields.x_name.secured, false);
});
