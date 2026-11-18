#!/usr/bin/env node
// Baseline fixture data: one invented dataset with stable GUIDs (2 parents + 1 deactivated, 14 items (item3, item9–item11 deactivated), 4 children + 1 deactivated), usable three ways —
//   1. `reset` against the live environment (write the fields of each fixture row whose live value differs, delete
//      every other row of the fixture tables) so captures start from a known state; the plan reports the same diff;
//   2. `mirageTables(testerContactId)` for the Mirage data pack (same rows, Mirage record shape);
//   3. `catalogue(testerContactId)` in the toolkit data-catalogue shape for compare/query tooling.
//
//   node examples/project/baseline/data.mjs reset --connection FILE [--apply] [--tester <contactid>]
//
// The tester contact is the signed-in portal contact of the reference site (org-specific, passed
// in) or the synthetic Mirage contact; nothing here names a real person.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain, UsageError } from '../cli.mjs';
import { guid } from './generate.mjs';

const PREFIX = 'pqvd';
const p = (name) => `${PREFIX}_${name}`;
export const ITEM = p('baselineitem');
export const PARENT = p('baselineparent');
export const CHILD = p('baselinechild');
export const TESTER_CONTACT = guid('contact:tester');
export const OTHER_CONTACT = guid('contact:other');
export const ACCOUNT = guid('account:baseline');
export const CURRENCY = 'a4300000-0000-4000-8000-000000000001'; // the demo's EUR currency record
export const ids = {
  parent1: guid('parent:1'),
  parent2: guid('parent:2'),
  parent3: guid('parent:3'),
  item1: guid('item:1'),
  item2: guid('item:2'),
  item3: guid('item:3'),
  item4: guid('item:4'),
  item5: guid('item:5'),
  item6: guid('item:6'),
  item7: guid('item:7'),
  item8: guid('item:8'),
  item9: guid('item:9'),
  item10: guid('item:10'),
  item11: guid('item:11'),
  item12: guid('item:12'),
  item13: guid('item:13'),
  item14: guid('item:14'),
  child1: guid('child:1'),
  child2: guid('child:2'),
  child3: guid('child:3'),
  child4: guid('child:4'),
  child5: guid('child:5'),
  note1: guid('note:1'),
  note2: guid('note:2'),
  account: ACCOUNT,
  tester: TESTER_CONTACT,
  other: OTHER_CONTACT,
};
const BRIEF = Buffer.from('Baseline fixture attachment.\nThis file is invented test data.\n', 'utf8');

const item = (key, name, code, extra = {}) => ({
  key,
  id: ids[key],
  table: ITEM,
  ...(extra.computed ? { computed: extra.computed } : {}),
  fields: {
    [p('name')]: name,
    [p('code')]: code,
    [p('required')]: 'required value',
    statecode: 0,
    statuscode: 1,
    ...extra.fields,
  },
  refs: { [p('parentid')]: 'parent1', ...extra.refs },
});

/** Fixture rows in dependency order. `tester` is the signed-in contact of the side being reset. */
export function records(tester = TESTER_CONTACT) {
  const rows = [
    {
      key: 'account',
      id: ids.account,
      table: 'account',
      fields: { name: 'Baseline Account', accountnumber: 'BL-ACC-1', telephone1: '+1 555 0199' },
      refs: {},
    },
    {
      key: 'other',
      id: ids.other,
      table: 'contact',
      fields: { firstname: 'Baseline', lastname: 'Other Contact', emailaddress1: 'baseline.other@example.invalid' },
      refs: {},
    },
    {
      key: 'parent1',
      id: ids.parent1,
      table: PARENT,
      fields: {
        [p('name')]: 'Baseline Parent One',
        [p('code')]: 'P-001',
        [p('rank')]: 1,
        [p('description')]: 'First invented parent.',
        [p('summary')]: 'Parent one summary',
      },
      refs: {},
    },
    {
      key: 'parent2',
      id: ids.parent2,
      table: PARENT,
      fields: {
        [p('name')]: 'Baseline Parent Two',
        [p('code')]: 'P-002',
        [p('rank')]: 2,
        [p('description')]: 'Second invented parent.',
        [p('summary')]: 'Parent two summary',
      },
      refs: {},
    },
    // Deactivated parent and child: the inactive-record states of the parent and child edit forms.
    {
      key: 'parent3',
      id: ids.parent3,
      table: PARENT,
      fields: {
        [p('name')]: 'Baseline Parent Three',
        [p('code')]: 'P-003',
        [p('rank')]: 3,
        [p('description')]: 'Deactivated invented parent.',
        statecode: 1,
        statuscode: 2,
      },
      refs: {},
    },
    item('item1', 'Baseline Item Alpha', 'I-001', {
      fields: {
        [p('text')]: 'alpha text',
        [p('textarea')]: 'line one\nline two',
        [p('email')]: 'alpha@example.invalid',
        [p('url')]: 'https://example.invalid/alpha',
        [p('phone')]: '+1 555 0100',
        [p('ticker')]: 'ALP',
        [p('richtext')]: '<p>Rich <strong>text</strong> value</p>',
        [p('memo')]: 'Memo paragraph one.\n\nMemo paragraph two.',
        [p('wholenumber')]: 42,
        [p('duration')]: 90,
        [p('timezone')]: 85,
        [p('language')]: 1033,
        [p('decimal')]: 12.34,
        [p('float')]: 1.5,
        [p('amount')]: 199.99,
        [p('bigint')]: '9007199254740993',
        [p('datetime')]: '2026-03-04T10:30:00Z',
        [p('dateonly')]: '2026-03-05',
        [p('datetimetzi')]: '2026-03-06T08:00:00Z',
        [p('dateonlyuserlocal')]: '2026-03-07T00:00:00Z',
        [p('localchoice')]: 2,
        [p('globalchoice')]: 18327002,
        [p('multichoice')]: '18327010,18327012',
        [p('flag')]: true,
        [p('flagcheckbox')]: true,
        [p('recommended')]: 'recommended value',
        [p('readonly')]: 'read only value',
        [p('hidden')]: 'hidden value',
        [p('nolabel')]: 'no label value',
        [p('wide')]: 'wide value',
        [p('relabelled')]: 'relabelled value',
        [p('hiddenbyrule')]: 'hidden by rule value',
        [p('lockedbyrule')]: 'locked by rule value',
        [p('requiredbyrule')]: 'required by rule value',
        [p('defaultbyrule')]: 'existing value',
        [p('setbyrule')]: 'set by rule' /* the live entity-scope rule writes it on the reset's update */,
        [p('ruleerror')]: 10,
        [p('secret')]: 'secret value',
        [p('notupdatable')]: 'fixed at create',
        [p('defaulted')]: 7,
      },
      refs: {
        [p('contactid')]: 'tester',
        [p('accountid')]: 'account',
        [p('customerid')]: 'account',
        [p('anyid')]: 'parent2',
      },
      // Values Dataverse computes on the live row, which the reset cannot write: the file column the reset uploads (baseline-brief.txt) and
      // the formula column Concatenate(name, " / ", code). Mirage rows only: this seeded
      // formula output covers initial rendering and does not recalculate after name/code edits.
      computed: {
        [p('file')]: guid('file:item1'),
        [p('file_name')]: 'baseline-brief.txt',
        [p('formula')]: 'Baseline Item Alpha / I-001',
      },
    }),
    item('item2', 'Baseline Item Beta', 'I-002', {
      fields: {
        [p('flag')]: false,
        [p('wholenumber')]: 7,
        [p('globalchoice')]: 18327000,
        [p('datetime')]: '2026-01-15T09:00:00Z',
      },
    }),
    item('item3', 'Baseline Item Gamma', 'I-003', {
      fields: { statecode: 1, statuscode: 2, [p('wholenumber')]: 3 },
      refs: { [p('parentid')]: 'parent2' },
    }),
    item('item4', 'Baseline Item Delta', 'I-004', {
      fields: { [p('ruleerror')]: 0, [p('wholenumber')]: 400, [p('globalchoice')]: 18327001 },
      refs: { [p('parentid')]: 'parent2', [p('contactid')]: 'other' },
    }),
    // item5 belongs to the fixture account but not to the tester contact: it tells the account-scope persona from the contact-scope one.
    item('item5', 'Baseline Item Epsilon', 'I-005', {
      fields: { [p('wholenumber')]: 50, [p('decimal')]: 5.5, [p('datetime')]: '2026-05-05T05:05:00Z' },
      refs: { [p('accountid')]: 'account' },
    }),
    item('item6', 'Baseline Item Zeta', 'I-006', {
      fields: { [p('wholenumber')]: 60, [p('decimal')]: 6.5 },
      refs: { [p('parentid')]: 'parent2' },
    }),
    item('item7', 'Baseline Item Eta', 'I-007', { fields: { [p('wholenumber')]: 70, [p('multichoice')]: '18327011' } }),
    // item8: flag false satisfies the hide-by-flag rule's condition, so its hidden-by-rule value shows what the live form does with the rule.
    item('item8', 'Baseline Item Theta', 'I-008', {
      fields: {
        [p('wholenumber')]: 80,
        [p('flag')]: false,
        [p('dateonly')]: '2026-08-08',
        [p('hiddenbyrule')]: 'hidden when flag is false',
      },
      refs: { [p('parentid')]: 'parent2', [p('contactid')]: 'other' },
    }),
    // item9–item11: deactivated rows reserved for the form action scenarios (one per actions variant); a scenario activates
    // and deactivates its own row, so the portal's record cache never leaks a state change into another capture and the
    // active views stay unchanged.
    item('item9', 'Baseline Item Iota', 'I-009', { fields: { statecode: 1, statuscode: 2, [p('wholenumber')]: 90 } }),
    item('item10', 'Baseline Item Kappa', 'I-010', {
      fields: { statecode: 1, statuscode: 2, [p('wholenumber')]: 100 },
    }),
    // item11 has no parent: the parent-scope role (items through their parent) is denied it while the reader reads it (persona probe).
    item('item11', 'Baseline Item Lambda', 'I-011', {
      fields: { statecode: 1, statuscode: 2, [p('wholenumber')]: 110 },
      refs: { [p('parentid')]: null },
    }),
    // item12–item14: active rows of the tester contact and the fixture account, so the contact-filtered list (item-list-mine)
    // and the account-filtered list (item-list-options, account-scope persona) show at least four rows each. Name order
    // (Mu, Nu, Omega) differs from code order (I-012 Omega, I-013 Mu, I-014 Nu), so a sort by code visibly reorders them.
    // No parent (the helper defaults to parent1), date or coordinates: parent subgrids, calendars and maps keep their rows.
    item('item12', 'Baseline Item Omega', 'I-012', {
      fields: { [p('wholenumber')]: 120 },
      refs: { [p('parentid')]: null, [p('contactid')]: 'tester', [p('accountid')]: 'account' },
    }),
    item('item13', 'Baseline Item Mu', 'I-013', {
      fields: { [p('wholenumber')]: 130 },
      refs: { [p('parentid')]: null, [p('contactid')]: 'tester', [p('accountid')]: 'account' },
    }),
    item('item14', 'Baseline Item Nu', 'I-014', {
      fields: { [p('wholenumber')]: 140 },
      refs: { [p('parentid')]: null, [p('contactid')]: 'tester', [p('accountid')]: 'account' },
    }),
    {
      key: 'child1',
      id: ids.child1,
      table: CHILD,
      fields: { [p('name')]: 'Child One', [p('sortorder')]: 1, [p('note')]: 'First child.' },
      refs: { [p('itemid')]: 'item1' },
    },
    {
      key: 'child2',
      id: ids.child2,
      table: CHILD,
      fields: { [p('name')]: 'Child Two', [p('sortorder')]: 2, [p('note')]: 'Second child.' },
      refs: { [p('itemid')]: 'item1' },
    },
    {
      key: 'child3',
      id: ids.child3,
      table: CHILD,
      fields: { [p('name')]: 'Child Three', [p('sortorder')]: 3 },
      refs: { [p('itemid')]: 'item1' },
    },
    {
      key: 'child4',
      id: ids.child4,
      table: CHILD,
      fields: { [p('name')]: 'Child Four', [p('sortorder')]: 1 },
      refs: { [p('itemid')]: 'item2' },
    },
    {
      key: 'child5',
      id: ids.child5,
      table: CHILD,
      fields: {
        [p('name')]: 'Child Five',
        [p('sortorder')]: 5,
        [p('note')]: 'Deactivated child.',
        statecode: 1,
        statuscode: 2,
      },
      refs: { [p('itemid')]: 'item1' },
    },
    // The portal shows only notes whose text starts with the site setting KnowledgeManagement/NotesFilter (`*WEB*` on the shared site); portal-created notes carry it.
    {
      key: 'note1',
      id: ids.note1,
      table: 'annotation',
      fields: { subject: 'Baseline note', notetext: '*WEB*A plain note on the alpha item.' },
      refs: { objectid: 'item1' },
    },
    {
      key: 'note2',
      id: ids.note2,
      table: 'annotation',
      fields: {
        subject: 'Baseline attachment',
        notetext: '*WEB*A note with a text attachment.',
        filename: 'baseline-brief.txt',
        mimetype: 'text/plain',
        documentbody: BRIEF.toString('base64'),
        isdocument: true,
      },
      refs: { objectid: 'item1' },
    },
  ];
  const resolved = { tester: { id: tester, table: 'contact' } };
  for (const row of rows) resolved[row.key] = { id: row.id, table: row.table };
  return { rows, resolved };
}

export const TABLES = [
  { name: 'account', entitySet: 'accounts', primaryId: 'accountid', keys: [['accountnumber']] },
  { name: 'contact', entitySet: 'contacts', primaryId: 'contactid', keys: [] },
  // Keys list only the alternate keys the baseline manifest creates; the parent declares none.
  { name: PARENT, entitySet: `${PARENT}s`, primaryId: `${PARENT}id`, keys: [] },
  { name: ITEM, entitySet: `${ITEM}s`, primaryId: `${ITEM}id`, keys: [[p('code')]] },
  { name: CHILD, entitySet: `${CHILD}s`, primaryId: `${CHILD}id`, keys: [] },
  { name: 'annotation', entitySet: 'annotations', primaryId: 'annotationid', keys: [] },
];
const entitySet = (table) => TABLES.find((t) => t.name === table).entitySet;
/** Lookup navigation property names on the Web API for each fixture lookup. */
const NAVIGATION = {
  [p('parentid')]: { nav: `${p('parentid')}`, set: `${PARENT}s` },
  [p('contactid')]: { nav: `${p('contactid')}`, set: 'contacts' },
  [p('accountid')]: { nav: `${p('accountid')}`, set: 'accounts' },
  [p('itemid')]: { nav: `${p('itemid')}`, set: `${ITEM}s` },
  [p('customerid')]: { nav: `${p('customerid')}_account`, set: 'accounts' },
  [p('anyid')]: { nav: `${p('anyid')}_${PARENT}`, set: `${PARENT}s` },
  objectid: { nav: `objectid_${ITEM}`, set: `${ITEM}s` },
};

/** Toolkit data-catalogue shape (schemaVersion 1). */
export function catalogue(tester = TESTER_CONTACT) {
  const { rows } = records(tester);
  return {
    schemaVersion: 1,
    datasetId: 'paqvilo-baseline',
    version: '1.0.0',
    clock: '2026-10-01T00:00:00Z',
    tables: TABLES,
    records: rows.map((row) => ({
      key: row.key,
      id: row.id,
      table: row.table,
      fields: row.fields,
      // The tester contact is per site, not a catalogue record: its links are left unchecked rather than expected empty.
      refs: Object.fromEntries(Object.entries(row.refs).filter(([, key]) => key !== 'tester')),
      deferredRefs: [],
    })),
    associations: [],
    queries: [],
  };
}

/** Mirage record shape: lookups are { id, logical_name, name } objects. */
export function mirageTables(tester = TESTER_CONTACT) {
  const { rows, resolved } = records(tester);
  const nameOf = (key) =>
    rows.find((row) => row.key === key)?.fields[p('name')] ??
    rows.find((row) => row.key === key)?.fields.name ??
    (key === 'tester' ? 'Baseline Tester' : key);
  const tables = {};
  for (const row of rows) {
    const primary = TABLES.find((t) => t.name === row.table).primaryId;
    const record = { [primary]: row.id, ...row.fields, ...row.computed };
    if (row.table === ITEM)
      record.transactioncurrencyid = { id: CURRENCY, logical_name: 'transactioncurrency', name: 'Euro' };
    for (const [field, key] of Object.entries(row.refs))
      record[field] = key ? { id: resolved[key].id, logical_name: resolved[key].table, name: nameOf(key) } : null;
    tables[row.table] ??= [];
    tables[row.table].push(record);
  }
  tables.contact = [
    {
      contactid: tester,
      firstname: 'Baseline',
      lastname: 'Tester',
      fullname: 'Baseline Tester',
      emailaddress1: 'baseline.tester@example.invalid',
      statecode: 0,
      statuscode: 1,
      parentcustomerid: { id: ids.account, logical_name: 'account', name: 'Baseline Account' },
    },
    ...(tables.contact ?? []).map((row) => ({ ...row, fullname: `${row.firstname} ${row.lastname}` })),
  ];
  tables.transactioncurrency = [
    {
      transactioncurrencyid: CURRENCY,
      currencyname: 'Euro',
      isocurrencycode: 'EUR',
      currencysymbol: '€',
      exchangerate: 1,
      currencyprecision: 2,
      statecode: 0,
    },
  ];
  return tables;
}

function recordDeletionCandidate(row, table, fixtureIds, summary, idField = `${table}id`, preserveId = false) {
  const originalId = String(row[idField]);
  const id = originalId.toLowerCase();
  if (fixtureIds.has(id)) return null;
  summary.deleted.push({ table, id: preserveId ? row[idField] : id });
  return preserveId ? true : id;
}

function* deletionRequests(rows, { table, fixtureIds, summary, idField, preserveId, apply, urlOf }) {
  for (const row of rows) {
    const id = recordDeletionCandidate(row, table, fixtureIds, summary, idField, preserveId);
    if (id === null || !apply) continue;
    yield urlOf(id, row);
  }
}

// BigInt (Edm.Int64) columns: the fixture keeps the exact value as a string, because a JavaScript number rounds it
// past 2^53. Dataverse rejects a quoted Int64 with HTTP 400, so the Web API body carries the digits as a JSON number.
const BIGINT_COLUMNS = [p('bigint')];

function liveUpsertBody(row, resolved) {
  const body = { ...row.fields };
  for (const column of BIGINT_COLUMNS) if (typeof body[column] === 'string') body[column] = JSON.rawJSON(body[column]);
  for (const [field, key] of Object.entries(row.refs)) {
    const navigation = NAVIGATION[field];
    if (!navigation) throw new Error(`No navigation property for ${field}`);
    body[`${navigation.nav}@odata.bind`] = key ? `/${navigation.set}(${resolved[key].id})` : null;
  }
  if (row.table === ITEM) body['transactioncurrencyid@odata.bind'] = `/transactioncurrencies(${CURRENCY})`;
  const { statecode, statuscode, ...rest } = body;
  return { rest, statecode, statuscode };
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The client parses Int64 values past 2^53 as their exact digits, so a string fixture value compares exactly.
function sameValue(live, want) {
  if (typeof want === 'string' && typeof live === 'string')
    return GUID.test(want) ? live.toLowerCase() === want.toLowerCase() : live.replace(/\r\n/g, '\n') === want;
  if (typeof want === 'number' && typeof live === 'number')
    return Math.abs(live - want) <= 1e-9 * Math.max(1, Math.abs(want));
  if (typeof want === 'string' && typeof live === 'number') return String(live) === want;
  return (live ?? null) === (want ?? null);
}

/** The fields of one fixture row whose live value differs (every field when the row does not exist). */
async function rowDifferences(client, row, resolved) {
  const wanted = { ...row.fields };
  for (const [field, key] of Object.entries(row.refs)) wanted[`_${field}_value`] = key ? resolved[key].id : null;
  if (row.table === ITEM) wanted._transactioncurrencyid_value = CURRENCY;
  const live = await client.optional(`${entitySet(row.table)}(${row.id})?$select=${Object.keys(wanted).join(',')}`);
  return Object.keys(wanted).filter((name) => !live || !sameValue(live[name], wanted[name]));
}

/** Writes the differing fields of one fixture row (its state with a second PATCH, as the platform requires). */
async function resetRow(client, row, resolved, { apply, summary, log }) {
  const differing = new Set(await rowDifferences(client, row, resolved));
  if (!differing.size) {
    summary.unchanged++;
    return;
  }
  const { rest, statecode, statuscode } = liveUpsertBody(row, resolved);
  // A lookup is written as `nav@odata.bind` and read back as `_field_value`.
  const readName = { 'transactioncurrencyid@odata.bind': '_transactioncurrencyid_value' };
  for (const field of Object.keys(row.refs)) readName[`${NAVIGATION[field].nav}@odata.bind`] = `_${field}_value`;
  const body = Object.fromEntries(Object.entries(rest).filter(([key]) => differing.has(readName[key] ?? key)));
  const change = { table: row.table, id: row.id, key: row.key, fields: [...differing] };
  summary.changes.push(change);
  const url = `${entitySet(row.table)}(${row.id})`;
  if (apply && Object.keys(body).length) await client.request(url, { method: 'PATCH', body });
  if (apply && statecode !== undefined && (differing.has('statecode') || differing.has('statuscode')))
    await client.request(url, { method: 'PATCH', body: { statecode, statuscode } });
  log({ change: row.key, table: row.table, fields: change.fields });
}

/** File column data on the alpha item, compared byte for byte (the Web API uploads single-request files with PATCH). */
async function resetFile(client, { apply, summary }) {
  const file = client.url(`${entitySet(ITEM)}(${ids.item1})/${p('file')}`);
  const authorization = { Authorization: `Bearer ${await client.token()}` };
  const current = await client.fetch(`${file}/$value`, { headers: authorization });
  const stored = current.ok ? Buffer.from(await current.arrayBuffer()) : Buffer.alloc(0);
  if (stored.equals(BRIEF) && current.headers.get('x-ms-file-name') === 'baseline-brief.txt') return;
  summary.files.push({ item: ids.item1, column: p('file') });
  if (!apply) return;
  const response = await client.fetch(file, {
    method: 'PATCH',
    headers: { ...authorization, 'Content-Type': 'application/octet-stream', 'x-ms-file-name': 'baseline-brief.txt' },
    body: BRIEF,
  });
  if (!response.ok) throw new Error(`File upload failed (HTTP ${response.status})`);
}

/** Live reset: write the fixture rows' differing fields, remove every other row of the three fixture tables. */
export async function resetLive(client, { apply = false, tester, log = () => {} }) {
  if (!tester) throw new Error('The live tester contact id is required (--tester).');
  const { rows, resolved } = records(tester);
  const summary = { deleted: [], changes: [], unchanged: 0, files: [] };
  const fixtureIds = new Set(rows.map((row) => row.id.toLowerCase()));
  for (const table of [CHILD, ITEM, PARENT]) {
    const set = entitySet(table);
    const existing = await client.list(`${set}?$select=${table}id`);
    for (const url of deletionRequests(existing, {
      table,
      fixtureIds,
      summary,
      apply,
      urlOf: (id) => `${set}(${id})`,
    }))
      await client.request(url, { method: 'DELETE' });
  }
  const notes = await client
    .list(`annotations?$select=annotationid&$filter=objecttypecode eq '${ITEM}'`)
    .catch(() => []);
  for (const url of deletionRequests(notes, {
    table: 'annotation',
    fixtureIds,
    summary,
    idField: 'annotationid',
    preserveId: true,
    apply,
    urlOf: (_id, note) => `annotations(${note.annotationid})`,
  }))
    await client.request(url, { method: 'DELETE' });
  for (const row of rows) await resetRow(client, row, resolved, { apply, summary, log });
  await resetFile(client, { apply, summary });
  return summary;
}

async function main() {
  const { values, positionals } = cli(
    `Usage: node examples/project/baseline/data.mjs reset --connection FILE --tester CONTACTID [--apply]
       node examples/project/baseline/data.mjs catalogue [--out FILE]

  reset       plan (or with --apply, write) the fixture rows in the live environment named by --connection;
              requires --connection and --tester, --apply is optional
  catalogue   write the fixture catalogue offline (default: baseline/data/catalogue.json in this project);
              --out is optional, the other options do not apply
  --tester    contact id of the signed-in portal Contact of the reference site (required by reset)
Relative paths resolve from the working directory.`,
    {
      connection: { type: 'string' },
      apply: { type: 'boolean' },
      tester: { type: 'string' },
      out: { type: 'string' },
    },
    { positionals: 1 },
  );
  const action = positionals[0];
  const misplaced = { catalogue: ['connection', 'apply', 'tester'], reset: ['out'] }[action]?.find(
    (name) => values[name] !== undefined,
  );
  if (misplaced) throw new UsageError(`--${misplaced} does not apply to ${action}.`);
  if (action === 'catalogue') {
    const out = values.out ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'data', 'catalogue.json');
    await fs.mkdir(path.dirname(out), { recursive: true });
    await fs.writeFile(out, JSON.stringify(catalogue(), null, 2) + '\n');
    console.log(JSON.stringify({ catalogue: out, records: catalogue().records.length }));
    return;
  }
  if (action !== 'reset') throw new UsageError(`Unknown action ${action}; use reset or catalogue.`);
  if (!values.connection) throw new UsageError('reset requires --connection FILE.');
  if (!values.tester) throw new UsageError('reset requires --tester CONTACTID (the live tester contact id).');
  const { loadConnection, connectedClient } = await import('paqvilo/lense/dataverse/index.mjs');
  const info = await loadConnection(values.connection);
  const client = connectedClient(info);
  await client.verify(info.organisationId);
  const summary = await resetLive(client, {
    apply: Boolean(values.apply),
    tester: values.tester,
    log: (entry) => console.log(JSON.stringify(entry)),
  });
  console.log(
    JSON.stringify({
      apply: Boolean(values.apply),
      deleted: summary.deleted.length,
      changes: summary.changes.length,
      unchanged: summary.unchanged,
      files: summary.files.length,
    }),
  );
}

if (isMain(import.meta)) await main();
