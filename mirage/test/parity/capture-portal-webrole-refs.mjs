/**
 * Convert one recorded `refs` run of hosted session F1 (the developer workbench's hosted-f1 recorder: runs/<run>/refs.json
 * and the session's hosted-actions.log) to the raw input of scripts/parity-cases.mjs build for the portal-webrole-refs
 * surface.
 * Usage: node mirage/test/parity/capture-portal-webrole-refs.mjs RUN_FILE ACTIONS_LOG OUT
 *
 * The run made eight signed-in portal Web API requests on web role membership navigations: $ref POSTs from the contact and
 * from the web role, a read of mspp_webroles, a read through the contact's membership navigation and a DELETE $ref. The
 * input names no recorded id or host: the signed-in contact is `{contact}`, the referenced web role `{role}` and the site
 * origin `{origin}`. The site configuration the run met is read from the actions log: `webrole-api` when the refs phase
 * (Webapi/mspp_webrole and Webapi/powerpagecomponent settings and Global permissions on both tables) was on at the run's
 * start, else `none`. The output is the status and the error's code and message.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { isEntryPoint } from '../../../lense/entry-point.mjs';

// Recorded results the local fixture cannot reproduce, each with the reason (none: every recorded request replays).
const LEFT_OUT = {};
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** The configuration the refs phase left on the site when the run started, from the actions log. */
export function refsConfiguration(log, recordedAt) {
  const at = Date.parse(recordedAt);
  let phase = 'none';
  for (const line of log.split(/\r?\n/)) {
    const [time, action] = line.split('\t');
    if (!time || Date.parse(time) >= at) continue;
    if (action === 'refs-phase.mjs --on') phase = 'webrole-api';
    else if (action === 'refs-phase.mjs --off') phase = 'none';
  }
  return phase;
}

function placeholders(value, { contact, role, origin }) {
  if (typeof value === 'string')
    return value.replaceAll(origin, '{origin}').replaceAll(contact, '{contact}').replaceAll(role, '{role}');
  if (Array.isArray(value)) return value.map((item) => placeholders(item, { contact, role, origin }));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, placeholders(item, { contact, role, origin })]),
    );
  return value;
}

export function preparePortalWebRoleRefsCapture(runFile, logFile) {
  const raw = fs.readFileSync(runFile);
  const run = JSON.parse(raw.toString('utf8'));
  assert.equal(run.group, 'refs', 'Use a refs run.');
  const contact = String(run.session?.contactId ?? '').toLowerCase();
  assert.match(contact, /^[0-9a-f-]{36}$/, 'The run names its signed-in contact.');
  const first = run.results.find((result) => result.id === 'contact-nav-powerpagecomponent');
  const reference = first?.input?.body?.['@odata.id'];
  assert.ok(reference, 'The first $ref names its web role.');
  const origin = new URL(reference).origin;
  const role = /\(([0-9a-f-]{36})\)$/i.exec(reference)?.[1]?.toLowerCase();
  assert.ok(role, 'The referenced web role has an id.');
  const configuration = refsConfiguration(fs.readFileSync(logFile, 'utf8'), run.recordedAt);
  const ids = { contact, role, origin };
  const results = [];
  for (const result of run.results) {
    if (LEFT_OUT[result.id]) continue;
    const input = placeholders(
      { configuration, method: result.input.method, path: result.input.path, body: result.input.body ?? null },
      ids,
    );
    const error = result.output.body?.error;
    const output = {
      status: result.output.status,
      error: error ? { code: error.code ?? null, message: error.message ?? null } : null,
    };
    // Every id left in the case is one the recorder chose for the fixture, never a recorded environment id.
    assert.deepEqual(JSON.stringify({ input, output }).match(GUID) ?? [], [], `${result.id} names no recorded id`);
    results.push({ id: result.id, input, output });
  }
  assert.ok(results.length, 'The run recorded results.');
  return {
    capture: {
      id: `refs-${run.run}`,
      capturedAt: String(run.recordedAt).slice(0, 10),
      sha256: createHash('sha256').update(raw).digest('hex'),
    },
    results,
  };
}

if (isEntryPoint(import.meta.url)) {
  const [runFile, logFile, out, ...extra] = process.argv.slice(2);
  if (!runFile || !logFile || !out || extra.length)
    throw new Error('Usage: node mirage/test/parity/capture-portal-webrole-refs.mjs RUN_FILE ACTIONS_LOG OUT');
  fs.writeFileSync(out, JSON.stringify(preparePortalWebRoleRefsCapture(runFile, logFile), null, 2) + '\n');
}
