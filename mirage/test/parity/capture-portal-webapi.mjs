/**
 * Convert one recorded portal Web API run (a batched browser recorder of the demo site: plan.json, run.json and its
 * cases-*.json) to the raw input of scripts/parity-cases.mjs build for the portal-webapi surface.
 * Usage: node mirage/test/parity/capture-portal-webapi.mjs RUN_DIR OUT
 * The recorder wrote every case against owned records it created first (its bootstrap) and against new records with
 * ids it chose; it named them with a run marker. The input names none of them: a case reads `{account}`, `{contact}`
 * or `{annotation}` for the owned record of that table, the marker becomes `webapi-fixture`, and each case carries the
 * values its owned record held before it (`before`: every column the bootstrap set or an earlier case read back), so
 * every case replays on its own.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isEntryPoint } from '../../../lense/entry-point.mjs';

export const FIXTURE_MARKER = 'webapi-fixture';
const KEYS = { account: 'accountid', contact: 'contactid', annotation: 'annotationid' };
// Recorded cases the invented sources cannot reproduce, each with the reason.
const LEFT_OUT = {
  // An encoded object naming a column the table does not have: the platform knows every column of the system table, the
  // demo export describes only the columns it uses, so Mirage cannot tell an absent column from one not enabled.
  'lexer.string-17': 'the demo metadata does not describe every account column',
};

/** Replaces the run marker in every string of `value`. */
function unmarked(value, marker) {
  if (typeof value === 'string') return value.replaceAll(marker, FIXTURE_MARKER);
  if (Array.isArray(value)) return value.map((item) => unmarked(item, marker));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unmarked(item, marker)]));
  return value;
}

/** The request body the recorder sent for a case (its defaults for a new record), without the ids it chose. */
function authoredBody(entry, marker) {
  const body = structuredClone(entry.body ?? (entry.field ? { [entry.field]: entry.value } : undefined));
  if (entry.method === 'POST' && body) {
    if (entry.entity === 'account' && !('name' in body)) body.name = marker + ' ' + entry.id;
    if (entry.entity === 'contact' && !('lastname' in body)) body.lastname = marker + ' ' + entry.id;
    if (entry.entity === 'annotation') body['objectid_account@odata.bind'] = '/accounts({account})';
  }
  return body;
}

/** The read-back facts of a recorded result, as the adapter answers them. */
function recordedOutput(entry, row) {
  const output = {
    status: row.status,
    error: row.error ? { code: row.error.code ?? null, message: row.error.message ?? null } : null,
  };
  if (entry.method === 'GET') output.records = row.records ?? [];
  else if (entry.method === 'POST') output.persisted = row.persisted ?? null;
  else if (entry.readField) {
    output.readStatus = row.readStatus ?? null;
    output.persisted = row.persisted ?? null;
  }
  return output;
}

export function preparePortalWebApiCapture(runDir) {
  const read = (name) => JSON.parse(fs.readFileSync(path.join(runDir, name), 'utf8'));
  const plan = read('plan.json');
  const run = read('run.json');
  const marker = plan.marker;
  assert.match(marker, /^webapi-[0-9a-f]{8}$/, 'The plan names its run marker.');
  const hash = createHash('sha256');
  const rows = new Map();
  const dates = [];
  for (const name of fs
    .readdirSync(runDir)
    .filter((file) => /^cases-\d+\.json$/.test(file))
    .sort()) {
    const raw = fs.readFileSync(path.join(runDir, name));
    hash.update(name).update('\0').update(raw);
    const batch = JSON.parse(raw.toString('utf8'));
    if (batch.recordedAt) dates.push(batch.recordedAt.slice(0, 10));
    for (const row of batch.results) if (row.id) rows.set(row.id, row);
  }
  // What each owned record holds, field by field, as the recorded sequence left it.
  const state = { account: {}, contact: {}, annotation: {} };
  for (const seed of run.bootstrap ?? []) {
    assert.ok(seed.status >= 200 && seed.status < 300, `the ${seed.entity} bootstrap succeeded`);
    for (const [field, value] of Object.entries(seed.body))
      if (field !== KEYS[seed.entity] && !field.includes('@odata.bind')) state[seed.entity][field] = value;
  }
  const results = [];
  for (const entry of plan.cases) {
    const row = rows.get(entry.id);
    const reads = entry.readFields ?? (entry.readField ? [entry.readField] : []);
    const target = entry.method === 'POST' ? null : entry.entity;
    // Everything the recorded sequence shows its owned record holding: a plug-in can derive one column from another.
    const before = target ? { ...state[target] } : null;
    if (row && !row.fatal && !LEFT_OUT[entry.id]) {
      const input = {
        entity: entry.entity,
        method: entry.method,
        ...(entry.rawBody === undefined ? { body: authoredBody(entry, marker) ?? null } : { rawBody: entry.rawBody }),
        ...(entry.query ? { query: entry.query } : {}),
        ...(entry.contentType === undefined ? {} : { contentType: entry.contentType }),
        csrf: entry.omitCsrf ? 'omitted' : entry.wrongCsrf ? 'invalid' : 'present',
        readFields: reads,
        ...(before ? { before } : {}),
      };
      results.push({
        id: entry.id,
        input: unmarked(input, marker),
        output: unmarked(recordedOutput(entry, row), marker),
      });
    }
    if (row && entry.method === 'PATCH' && entry.readField && row.readStatus === 200)
      state[entry.entity][entry.readField] = row.persisted;
  }
  assert.ok(rows.size && dates.length, 'The run recorded dated results.');
  const capturedAt = dates.sort().at(-1);
  return { capture: { id: path.basename(runDir), capturedAt, sha256: hash.digest('hex') }, results };
}

/** The cases two runs share with the same input, in the first run's order: the corpus both captures record. */
export function sharedCorpus(first, second) {
  const other = new Map(second.results.map((result) => [result.id, result]));
  const shared = first.results.filter(
    (result) => other.has(result.id) && JSON.stringify(other.get(result.id).input) === JSON.stringify(result.input),
  );
  const keep = (capture) => ({
    ...capture,
    results: shared.map((result) => capture.results.find((item) => item.id === result.id)),
  });
  return [keep(first), keep(second)];
}

// ---- Hosted session F1 (paqvilo-developer hosted-f1): one structured file per scenario group and run, runs/<run>/<group>.json

// The settings each recorded activity phase ran with (the session's phases-activity scripts), over the site's own; null
// removes a setting.
const TASK_FIELDS = 'activityid,subject,pqf1_note';
const POINTER_FIELDS = 'activityid,subject,description,activitytypecode';
const ACTIVITY_PHASES = {
  'A-inherited-only': {
    'Webapi/pqf1_task/enabled': 'true',
    'Webapi/pqf1_task/fields': 'activityid,subject,description',
  },
  'B-mixed': { 'Webapi/pqf1_task/enabled': 'true', 'Webapi/pqf1_task/fields': TASK_FIELDS },
  'C-activitypointer-only': {
    'Webapi/activitypointer/enabled': 'true',
    'Webapi/activitypointer/fields': POINTER_FIELDS,
  },
  'D-task-settings-plus-activitypointer-fields': {
    'Webapi/pqf1_task/enabled': 'true',
    'Webapi/pqf1_task/fields': TASK_FIELDS,
    'Webapi/activitypointer/fields': POINTER_FIELDS,
  },
  'E-task-settings-plus-activitypointer-enabled-fields': {
    'Webapi/pqf1_task/enabled': 'true',
    'Webapi/pqf1_task/fields': TASK_FIELDS,
    'Webapi/activitypointer/enabled': 'true',
    'Webapi/activitypointer/fields': POINTER_FIELDS,
  },
};
// The suites of the hosted-f1 corpus: the group files each run recorded, and the results each suite keeps.
const HOSTED_F1_SUITES = {
  'hosted-f1-odata-shapes': {
    files: ['odata-shapes.json'],
    // FetchXML reads are the FetchXML surface's (DATA-02b), recorded in their own groups.
    keep: (result) => !result.id.startsWith('fetch-'),
  },
  'hosted-f1-predefined': { files: ['predefined.json'], keep: (result) => result.input },
  // The first phase A attempt of the second run read 404 everywhere because the new setting had not reached the portal
  // yet (phases-activity-a-retry.sh); its retry, with a readiness check, is that run's phase A.
  'hosted-f1-activity': {
    files: ['activity-A.json', 'activity-B.json', 'activity-C.json', 'activity-D.json', 'activity-E.json'],
    replacement: { 'activity-A.json': 'activity-A-retry.json' },
    keep: (result) => result.input,
  },
  'hosted-f1-chunked-upload': { files: ['files.json'], keep: (result) => result.id === 'chunked-start' },
  // The follow-up of 2026-11-27 on its own trial site (hosted-f1-nav-fixture-site.mjs): the provider healthy, the provider
  // throwing (the run made sequentially after the overlapped attempt was discarded), and the phase-marked reads, which
  // bypass the platform's read cache. The -throw-cache runs read cached answers in one run and fresh ones in the other, so
  // they are evidence for the read cache, not replay cases.
  'hosted-f1-nav-followup': { files: ['nav-followup.json'], keep: (result) => result.input, site: 'nav' },
  'hosted-f1-nav-followup-throw': { files: ['nav-followup-throw.json'], keep: (result) => result.input, site: 'nav' },
  'hosted-f1-nav-followup-marked': {
    files: ['nav-followup-marked.json'],
    keep: (result) =>
      ['nav1:vrows-phase-marked', 'nav1:expand-collection-phase-marked', 'nav1:keyed-vrow'].includes(result.id),
    site: 'nav',
  },
};
// The provider state of each follow-up phase (the session's trial-nav.mjs --switch).
const PROVIDER_PHASES = { 'provider-healthy': 'healthy', 'provider-throwing': 'throwing' };
export const HOSTED_F1_SUITE_NAMES = Object.keys(HOSTED_F1_SUITES);

const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The recorded response in the portable shape the adapter answers: status, wire headers, the error or the body. */
export function hostedOutput(output) {
  const headers = output.headers ?? {};
  const projected = {
    status: output.status,
    wire: {
      odataVersion: headers['odata-version'] ?? null,
      requestId: Object.hasOwn(headers, 'x-ms-request-id'),
      serverTiming: headers['server-timing']?.replaceAll(GUID, '<id>') ?? null,
    },
  };
  const body = output.body;
  if (body?.error) projected.error = body.error;
  else if (body && typeof body === 'object') projected.body = hostedBody(body);
  else if (typeof output.text === 'string') projected.text = output.text;
  return projected;
}

// pqf1_query is the follow-up test provider's echo of the query it received, with the platform's own user ids: provider
// output, not platform behaviour.
const ROW_SKIP = new Set(['@odata.etag', 'pqf1_query']);
function hostedRow(row) {
  if (Array.isArray(row)) return row.map(hostedRow);
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const key of Object.keys(row).sort()) {
    if (ROW_SKIP.has(key)) continue;
    out[key] = key.endsWith('@odata.nextLink') ? true : hostedRow(row[key]);
  }
  return out;
}
function hostedBody(body) {
  const context = String(body['@odata.context'] ?? '').replace(/^https?:\/\/[^/]+/, '');
  const projected = { context };
  if (Object.hasOwn(body, '@odata.count')) projected.count = body['@odata.count'];
  if (Object.hasOwn(body, '@Microsoft.Dynamics.CRM.totalrecordcount'))
    projected.total = body['@Microsoft.Dynamics.CRM.totalrecordcount'];
  if (Object.hasOwn(body, 'value')) {
    projected.nextLink = Object.hasOwn(body, '@odata.nextLink');
    projected.rows = hostedRow(body.value);
  } else {
    const row = Object.fromEntries(Object.entries(body).filter(([key]) => key !== '@odata.context'));
    projected.rows = [hostedRow(row)];
  }
  return projected;
}

/**
 * Replaces the recorded contact's id and name, and the ids of the environment's own views, with placeholders and fails on
 * any other recorded identifier.
 */
function anonymized(value, contact, contactName, views = []) {
  let text = JSON.stringify(value)
    .replace(new RegExp(contact, 'gi'), '{contact}')
    .replaceAll(JSON.stringify(contactName), JSON.stringify('{contactName}'));
  views.forEach((id, index) => {
    text = text.replace(new RegExp(id, 'gi'), `{view-${index + 1}}`);
  });
  for (const id of text.match(GUID) ?? [])
    if (!id.toLowerCase().startsWith('f1f1f1f1-0000-4000-8000-'))
      throw new Error(`A recorded identifier outside the session's synthetic rows would enter a case: ${id}.`);
  return JSON.parse(text);
}

/**
 * Converts one hosted-F1 run (`runDir` = runs/<run>) to the raw input of scripts/parity-cases.mjs build for `suite`.
 * A case's input is its request (method, path, headers) and the phase settings it ran with; a request that followed the
 * nextLink of an earlier result names that request (`follow`) instead of the hosted link, which carries the platform's
 * own paging cookie. The recorded contact becomes `{contact}` and its name `{contactName}`.
 */
export function prepareHostedF1Capture(runDir, suite) {
  const spec = HOSTED_F1_SUITES[suite];
  assert.ok(spec, `unknown hosted-f1 suite ${suite}`);
  const hash = createHash('sha256');
  const results = [];
  const dates = [];
  for (const file of spec.files) {
    const name = fs.existsSync(path.join(runDir, spec.replacement?.[file] ?? '\0')) ? spec.replacement[file] : file;
    const raw = fs.readFileSync(path.join(runDir, name));
    hash.update(name).update('\0').update(raw);
    const run = JSON.parse(raw.toString('utf8'));
    dates.push(run.recordedAt.slice(0, 10));
    const contact = run.session.contactId;
    const phase = run.results.find((result) => result.id === 'phase')?.note;
    const provider = spec.site === 'nav' ? PROVIDER_PHASES[phase] : undefined;
    const settings = phase === undefined || provider ? {} : ACTIVITY_PHASES[phase];
    assert.ok(settings, `the phase ${phase} of ${name} has recorded settings`);
    const byId = new Map(run.results.map((result) => [result.id, result]));
    // The environment's own saved and user views (savedQuery values), named by their order in the run.
    const listed = byId.get('views')?.note;
    const views = [...(listed?.savedqueries ?? []), ...(listed?.userqueries ?? [])].map((view) => view.id);
    const named = run.results
      .flatMap((result) => [result.output?.body, ...(result.output?.body?.value ?? [])])
      .flatMap((row) => (row && typeof row === 'object' ? Object.values(row) : []))
      .find((value) => value?.contactid?.toLowerCase?.() === contact.toLowerCase())?.fullname;
    for (const result of run.results.filter((item) => item.input && spec.keep(item))) {
      const { method, path: address, headers = {}, followed } = result.input;
      const input = provider
        ? { method, site: spec.site, provider, settings, headers }
        : { method, ...(phase === undefined ? {} : { phase }), settings, headers };
      if (followed) {
        const source = byId.get(/^nextLink of (.+)$/.exec(followed)?.[1] ?? '');
        assert.ok(source?.input, `${result.id} follows a recorded result`);
        input.follow = { path: source.input.path, headers: source.input.headers ?? {} };
      } else input.path = address;
      const id = phase === undefined || provider ? result.id : `${phase.split('-')[0]}:${result.id}`;
      results.push({
        id,
        input: anonymized(input, contact, named ?? '\0', views),
        output: anonymized(hostedOutput(result.output), contact, named ?? '\0', views),
      });
    }
  }
  const capturedAt = dates.sort().at(-1);
  return {
    capture: { id: `hosted-f1-${path.basename(runDir)}-${suite}`, capturedAt, sha256: hash.digest('hex') },
    results,
  };
}

// ---- Hosted session F7 (paqvilo-developer hosted-f7): one file per phase and run, runs/<run>/api-<phase>.json, each an
// `api` map of read id -> { path, status, headers, body }. The recorded paths name the read record as `<record>`.
const HOSTED_F7_SUITES = {
  // S0 (Web API lists `*` on the two SharePoint tables) and the explicit-list phase of S1-loc.
  'hosted-f7-sharepoint-reads': { phases: ['s0', 's1-loc-fields'] },
};
export const HOSTED_F7_SUITE_NAMES = Object.keys(HOSTED_F7_SUITES);

/**
 * Converts one hosted-F7 run (`runDir` = runs/<run>) to the raw input of scripts/parity-cases.mjs build. A case's input
 * is its phase and its request, the read record as `{record}`; the output of a read that names the record names it, its
 * name, its folder id (upper case without dashes) and its location as `{record}`, `{recordName}`, `{RECORD}` and
 * `{location}`, since the two runs read different records. Any other identifier outside the session's synthetic
 * `f7f7f7f7-0000-4000-8000-…` rows stops the conversion.
 */
export function prepareHostedF7Capture(runDir, suite) {
  const spec = HOSTED_F7_SUITES[suite];
  assert.ok(spec, `unknown hosted-f7 suite ${suite}`);
  const hash = createHash('sha256');
  const results = [];
  const dates = [];
  for (const phase of spec.phases) {
    const name = `api-${phase}.json`;
    const raw = fs.readFileSync(path.join(runDir, name));
    hash.update(name).update('\0').update(raw);
    const run = JSON.parse(raw.toString('utf8'));
    dates.push(run.recordedAt.slice(0, 10));
    const record = run.record;
    const location = run.locationsBefore?.find(
      (row) => row._regardingobjectid_value?.toLowerCase() === record.id.toLowerCase(),
    )?.sharepointdocumentlocationid;
    for (const [id, read] of Object.entries(run.api)) {
      const named = read.path.includes('<record>');
      let text = JSON.stringify(hostedOutput({ status: read.status, headers: read.headers, body: read.body }));
      if (named) {
        text = text
          .replace(new RegExp(record.id, 'gi'), '{record}')
          .replace(new RegExp(record.id.replaceAll('-', ''), 'gi'), '{RECORD}')
          .replaceAll(JSON.stringify(record.name).slice(1, -1), '{recordName}');
        if (location) text = text.replace(new RegExp(location, 'gi'), '{location}');
      }
      for (const guid of text.match(GUID) ?? [])
        if (!guid.toLowerCase().startsWith('f7f7f7f7-0000-4000-8000-'))
          throw new Error(`A recorded identifier outside the session's synthetic rows would enter a case: ${guid}.`);
      results.push({
        id: `${phase}:${id}`,
        input: { method: 'GET', phase, headers: {}, path: read.path.replaceAll('<record>', '{record}') },
        output: JSON.parse(text),
      });
    }
  }
  return {
    capture: {
      id: `hosted-f7-${path.basename(runDir)}-${suite}`,
      capturedAt: dates.sort().at(-1),
      sha256: hash.digest('hex'),
    },
    results,
  };
}

if (isEntryPoint(import.meta.url) && process.argv[2] === '--hosted-f7') {
  const [, suite, firstDir, secondDir, firstOut, secondOut, ...extra] = process.argv.slice(2);
  if (!HOSTED_F7_SUITES[suite] || !firstDir || !secondDir || !firstOut || !secondOut || extra.length)
    throw new Error(
      'Usage: node mirage/test/parity/capture-portal-webapi.mjs --hosted-f7 SUITE FIRST_RUN_DIR SECOND_RUN_DIR FIRST_OUT SECOND_OUT\n' +
        `  SUITE: ${HOSTED_F7_SUITE_NAMES.join(', ')}`,
    );
  const [first, second] = sharedCorpus(
    prepareHostedF7Capture(firstDir, suite),
    prepareHostedF7Capture(secondDir, suite),
  );
  fs.writeFileSync(firstOut, JSON.stringify(first, null, 2) + '\n');
  fs.writeFileSync(secondOut, JSON.stringify(second, null, 2) + '\n');
  process.stdout.write(`${first.results.length} shared cases\n`);
} else if (isEntryPoint(import.meta.url) && process.argv[2] === '--hosted-f1') {
  const [, suite, firstDir, secondDir, firstOut, secondOut, ...extra] = process.argv.slice(2);
  if (!HOSTED_F1_SUITES[suite] || !firstDir || !secondDir || !firstOut || !secondOut || extra.length)
    throw new Error(
      'Usage: node mirage/test/parity/capture-portal-webapi.mjs --hosted-f1 SUITE FIRST_RUN_DIR SECOND_RUN_DIR FIRST_OUT SECOND_OUT\n' +
        `  SUITE: ${HOSTED_F1_SUITE_NAMES.join(', ')}`,
    );
  const [first, second] = sharedCorpus(
    prepareHostedF1Capture(firstDir, suite),
    prepareHostedF1Capture(secondDir, suite),
  );
  fs.writeFileSync(firstOut, JSON.stringify(first, null, 2) + '\n');
  fs.writeFileSync(secondOut, JSON.stringify(second, null, 2) + '\n');
  process.stdout.write(`${first.results.length} shared cases\n`);
} else if (isEntryPoint(import.meta.url)) {
  const [firstDir, secondDir, firstOut, secondOut, ...extra] = process.argv.slice(2);
  if (!firstDir || !secondDir || !firstOut || !secondOut || extra.length)
    throw new Error(
      'Usage: node mirage/test/parity/capture-portal-webapi.mjs FIRST_RUN_DIR SECOND_RUN_DIR FIRST_OUT SECOND_OUT',
    );
  const [first, second] = sharedCorpus(preparePortalWebApiCapture(firstDir), preparePortalWebApiCapture(secondDir));
  fs.writeFileSync(firstOut, JSON.stringify(first, null, 2) + '\n');
  fs.writeFileSync(secondOut, JSON.stringify(second, null, 2) + '\n');
  process.stdout.write(`${first.results.length} shared cases\n`);
}
