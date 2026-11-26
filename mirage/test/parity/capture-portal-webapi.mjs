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

if (isEntryPoint(import.meta.url)) {
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
