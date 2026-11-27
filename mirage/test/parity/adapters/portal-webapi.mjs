// Adapter for the portal-webapi surface: one recorded portal Web API request (a write, a raw body, a query or a
// token variation) against the account, contact and note tables of the demo site the recordings ran on
// (examples/project/portal with the baseline fixture site over it; mirage/test/parity/baseline-fixture-site.mjs) ->
// the same request to Mirage's /_api/ -> its status, error code and message, and what a read-back finds.
// One simulator serves a case file (`open`); every case creates its own owned records first, holding the values the
// recorded owned record held before that case (`before`), so a case depends on no other. The request is built as the
// recorder built it: the token header unless omitted or replaced, the content type (none when empty), the body as JSON
// or the raw text. Placeholders `{account}` and `__ID__` name the case's owned records; a new record gets its own id.
// The demo's plug-in models (examples/project/pack) run as they ran natively in the recorded site's plug-in steps.
// Projection: status and the error's code and message (never the inner exception text); a PATCH reads back its field,
// a POST reads back the new record's fields (then deletes it), a GET lists the queried fields of each row.
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createSimulator } from '../../../server.mjs';
import { signInHeaders } from '../../../testing/session.mjs';
import { makeTemporaryDirectory, removeFixtureDirectory } from '../../../testing/owned-fixture.mjs';
import { TESTER_CONTACT } from '../../../../examples/project/baseline/data.mjs';
import { baselineFixtureOptions, writeBaselineFixtureSite } from '../baseline-fixture-site.mjs';
import { F1_CONTACT, F1_ROLE, writeHostedF1Site } from '../hosted-f1-fixture-site.mjs';
import { writeHostedF1NavSite } from '../hosted-f1-nav-fixture-site.mjs';
import {
  F7_CONTACT,
  F7_RECORD,
  F7_RECORD_LOCATION,
  F7_RECORD_NAME,
  F7_ROLE,
  writeHostedF7Site,
} from '../hosted-f7-fixture-site.mjs';
import { hostedOutput } from '../capture-portal-webapi.mjs';

const SETS = { account: 'accounts', contact: 'contacts', annotation: 'annotations' };
const KEYS = { account: 'accountid', contact: 'contactid', annotation: 'annotationid' };
// The recorded identity's web roles (the demo's editor role and the fixture's editor role).
const ROLES = ['Workspace Editors', 'Baseline Editors'];
const MARKER = 'webapi-fixture';
// The recorded site's observed Web API behaviour, the choices its own native captures established for it (lib/project-config.mjs
// OBSERVED_CHOICES): it is configuration of that site, not derivable from its export.
const OBSERVED = {
  webApiCdsErrorMessage: 'Common Data Service error occurred.',
  webApiAntiForgery: 'decryption-401',
  webApiReferenceErrors: 'unexpected',
  webApiInnerError: 'all-errors',
  webApiInvalidDate: 'crm-minimum',
  webApiRequestBody: 'portal-classic',
  evidence: 'Observed Web API settings of the recorded demo site, established by its own signed-in native captures.',
};

const fill = (value, ids) =>
  typeof value === 'string'
    ? value.replaceAll('{account}', ids.account ?? '').replaceAll('__ID__', ids.current ?? '')
    : value;
const filled = (value, ids) => {
  if (Array.isArray(value)) return value.map((item) => filled(item, ids));
  if (value && typeof value === 'object')
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, filled(item, ids)]));
  return fill(value, ids);
};

// The hosted-f1-* suites ran on hosted session F1's site (hosted-f1-fixture-site.mjs) as its contact with the F1 role.
// A case names the phase settings it ran with; each distinct set gets its own simulator. A case that followed an earlier
// result's @odata.nextLink (`follow`) makes that request first and follows Mirage's own link. Projection: the converter's
// (hostedOutput: status, wire headers, the error object or the body's context, counts, nextLink presence and rows), with
// the invented contact's id and name as the recorded placeholders.
async function openHostedF1() {
  const sessions = new Map();
  // A follow-up case (site "nav") runs on the follow-up site with its provider healthy or throwing.
  const session = ({ settings = {}, site, provider }) => {
    const key = JSON.stringify([settings, site ?? null, provider ?? null]);
    if (!sessions.has(key))
      sessions.set(
        key,
        (async () => {
          const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-replay-hosted-f1-'));
          try {
            const options =
              site === 'nav'
                ? await writeHostedF1NavSite(directory, { provider })
                : await writeHostedF1Site(directory, settings);
            const app = await createSimulator(options);
            return { app, directory, cookie: signInHeaders(app, F1_CONTACT, { roles: [F1_ROLE] }).cookie };
          } catch (error) {
            await removeFixtureDirectory(directory);
            throw error;
          }
        })(),
      );
    return sessions.get(key);
  };
  const send = async ({ app, cookie }, method, address, headers = {}) => {
    const response = await fetch(new URL(address, app.url), {
      method,
      headers: {
        accept: 'application/json',
        cookie,
        ...(method === 'GET' ? {} : { __RequestVerificationToken: app.portalToken }),
        ...headers,
      },
    });
    const text = await response.text();
    const json = /json/i.test(response.headers.get('content-type') ?? '');
    let body;
    if (json && text)
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
    return {
      status: response.status,
      headers: Object.fromEntries(response.headers),
      ...(body === undefined ? { text } : { body }),
    };
  };
  return {
    async run(input) {
      const current = await session(input);
      let address = input.path;
      if (input.follow) {
        const first = await send(current, 'GET', input.follow.path, input.follow.headers);
        const link = first.body?.['@odata.nextLink'];
        if (!link) return { followed: null, status: first.status };
        address = new URL(link).pathname + new URL(link).search;
      }
      const answer = await send(current, input.method, address, input.headers);
      const text = JSON.stringify(hostedOutput(answer))
        .replaceAll(F1_CONTACT, '{contact}')
        .replaceAll('"Invented Reader"', '"{contactName}"');
      return JSON.parse(text);
    },
    async close() {
      for (const pending of sessions.values()) {
        const opened = await pending.catch(() => null);
        if (!opened) continue;
        await opened.app.close();
        await removeFixtureDirectory(opened.directory);
      }
    },
  };
}

// The hosted-f7-* suites ran on hosted session F7's site (hosted-f7-fixture-site.mjs), one simulator per recorded phase, as
// its invented contact. Projection: the converter's (hostedOutput); a read naming the record names it, its name, its folder
// id and its location by the recorded placeholders.
async function openHostedF7() {
  const sessions = new Map();
  const session = (phase) => {
    if (!sessions.has(phase))
      sessions.set(
        phase,
        (async () => {
          const directory = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-replay-hosted-f7-'));
          try {
            const app = await createSimulator(await writeHostedF7Site(directory, phase));
            return { app, directory, cookie: signInHeaders(app, F7_CONTACT, { roles: [F7_ROLE] }).cookie };
          } catch (error) {
            await removeFixtureDirectory(directory);
            throw error;
          }
        })(),
      );
    return sessions.get(phase);
  };
  return {
    async run(input) {
      const { app, cookie } = await session(input.phase);
      const response = await fetch(new URL(input.path.replaceAll('{record}', F7_RECORD), app.url), {
        method: input.method,
        headers: { accept: 'application/json', cookie, ...input.headers },
      });
      const text = await response.text();
      let body;
      if (/json/i.test(response.headers.get('content-type') ?? '') && text)
        try {
          body = JSON.parse(text);
        } catch {
          body = undefined;
        }
      let projected = JSON.stringify(
        hostedOutput({
          status: response.status,
          headers: Object.fromEntries(response.headers),
          ...(body === undefined ? { text } : { body }),
        }),
      );
      if (input.path.includes('{record}'))
        projected = projected
          .replaceAll(F7_RECORD, '{record}')
          .replaceAll(F7_RECORD.replaceAll('-', '').toUpperCase(), '{RECORD}')
          .replaceAll(F7_RECORD_NAME, '{recordName}')
          .replaceAll(F7_RECORD_LOCATION, '{location}');
      return JSON.parse(projected);
    },
    async close() {
      for (const pending of sessions.values()) {
        const opened = await pending.catch(() => null);
        if (!opened) continue;
        await opened.app.close();
        await removeFixtureDirectory(opened.directory);
      }
    },
  };
}

export async function open(context) {
  if (context?.suite?.startsWith('hosted-f1-')) return openHostedF1();
  if (context?.suite?.startsWith('hosted-f7-')) return openHostedF7();
  const sourceDir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-replay-portal-webapi-'));
  let app;
  try {
    await writeBaselineFixtureSite(sourceDir);
    app = await createSimulator({
      ...baselineFixtureOptions(sourceDir, { packs: ['example', 'baseline'] }),
      observed: OBSERVED,
    });
  } catch (error) {
    await app?.close();
    await removeFixtureDirectory(sourceDir);
    throw error;
  }
  const { cookie } = signInHeaders(app, TESTER_CONTACT, { roles: ROLES });

  /** One request as the recorder's page made it: {status, data, error}. */
  const request = async (method, address, { body, rawBody, contentType, csrf = 'present' } = {}) => {
    const headers = { accept: 'application/json', cookie };
    if (csrf === 'present') headers.__RequestVerificationToken = app.portalToken;
    else if (csrf === 'invalid') headers.__RequestVerificationToken = 'invalid-probe-token';
    if (method !== 'GET' && method !== 'DELETE' && contentType !== '')
      headers['content-type'] = contentType ?? 'application/json';
    let raw;
    if (rawBody !== undefined) raw = rawBody;
    else if (body !== undefined && body !== null) raw = JSON.stringify(body);
    const response = await fetch(new URL(address, app.url), {
      method,
      headers,
      ...(raw === undefined ? {} : { body: raw }),
    });
    const text = await response.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    const id =
      response.headers.get('entityid') ??
      /\(([-a-f0-9]{36})\)/i.exec(response.headers.get('odata-entityid') ?? '')?.[1];
    const error = data?.error
      ? {
          code: data.error.code ?? null,
          message: typeof data.error.message === 'object' ? (data.error.message?.value ?? null) : data.error.message,
        }
      : null;
    return { status: response.status, data, error, id };
  };
  const create = async (entity, body, later = {}) => {
    const id = randomUUID();
    const created = await request('POST', `/_api/${SETS[entity]}`, { body: { ...body, [KEYS[entity]]: id } });
    if (created.status < 200 || created.status >= 300)
      throw new Error(`The owned ${entity} could not be created (HTTP ${created.status}).`);
    if (Object.keys(later).length) {
      const updated = await request('PATCH', `/_api/${SETS[entity]}(${id})`, { body: later });
      if (updated.status < 200 || updated.status >= 300)
        throw new Error(`The owned ${entity} could not take its earlier values (HTTP ${updated.status}).`);
    }
    return id;
  };

  return {
    async run(input) {
      const before = input.before ?? {};
      const owned = [];
      try {
        // The case's owned records, as the recorder's bootstrap made them, then given the values they held before this
        // case: created with the primary column, then updated with the rest, as the recorded sequence wrote them.
        const ids = {};
        const { name = `${MARKER} Account`, ...account } = input.entity === 'account' ? before : {};
        ids.account = await create('account', { name, accountnumber: 'PQIN-20261010' }, account);
        owned.push(['account', ids.account]);
        if (input.entity === 'contact') {
          const { lastname = `${MARKER} Contact`, ...rest } = before;
          const bind = { 'parentcustomerid_account@odata.bind': `/accounts(${ids.account})` };
          ids.contact = await create('contact', { lastname, ...bind }, rest);
          owned.unshift(['contact', ids.contact]);
        }
        if (input.entity === 'annotation') {
          const { subject = `${MARKER} Note`, ...rest } = before;
          const bind = { 'objectid_account@odata.bind': `/accounts(${ids.account})` };
          ids.annotation = await create('annotation', { subject, ...bind }, rest);
          owned.unshift(['annotation', ids.annotation]);
        }
        ids.current = ids[input.entity];
        const set = SETS[input.entity];
        const body = input.body === null || input.body === undefined ? undefined : filled(input.body, ids);
        if (input.method === 'POST' && body) body[KEYS[input.entity]] = randomUUID();
        let address = input.method === 'POST' ? `/_api/${set}` : `/_api/${set}(${ids.current})`;
        if (input.query)
          address =
            `/_api/${set}?` +
            new URLSearchParams(Object.entries(input.query).map(([key, value]) => [key, fill(value, ids)]));
        const answer = await request(input.method, address, {
          body,
          rawBody: input.rawBody,
          contentType: input.contentType,
          csrf: input.csrf,
        });
        const output = { status: answer.status, error: answer.error };
        const fields = input.readFields ?? [];
        if (input.method === 'GET')
          output.records = (answer.data?.value ?? []).map((row) =>
            Object.fromEntries(fields.map((field) => [field, row[field] ?? null])),
          );
        else if (input.method === 'POST') {
          output.persisted = null;
          if (answer.id) {
            const read = await request('GET', `/_api/${set}(${answer.id})?$select=${fields.join(',')}`);
            output.persisted = Object.fromEntries(fields.map((field) => [field, read.data?.[field] ?? null]));
            await request('DELETE', `/_api/${set}(${answer.id})`);
          }
        } else if (fields.length) {
          const read = await request('GET', `/_api/${set}(${ids.current})?$select=${fields[0]}`);
          output.readStatus = read.status;
          output.persisted = read.data?.[fields[0]] ?? null;
        }
        return output;
      } finally {
        for (const [entity, id] of owned) await request('DELETE', `/_api/${SETS[entity]}(${id})`).catch(() => {});
      }
    },
    async close() {
      await app.close();
      await removeFixtureDirectory(sourceDir);
    },
  };
}
