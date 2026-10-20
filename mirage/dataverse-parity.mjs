import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseArgs, isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const credentialHeader = /^(authorization|proxy-authorization|cookie|set-cookie|x-ms-token-.*|__requestverificationtoken)$/i;
const credentialKey = /^(access_token|refresh_token|id_token|client_secret|clientsecret|password|authorization|cookie|set-cookie|__requestverificationtoken)$/i;
const idPattern = /^[a-z0-9][a-z0-9_.:-]{0,199}$/i;
export const sha256 = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
const clone = value => structuredClone(value);
const escapePointer = text => text.replaceAll('~', '~0').replaceAll('/', '~1');
const bodyBytes = response => Buffer.from(response.bodyBase64 ?? '', 'base64');
const credentialError = message => Object.assign(Error(message), { code: 'PARITY_CREDENTIAL' });

export function assertNoCredentials(value) {
  function walk(node) {
    if (typeof node === 'string' && (/\bBearer\s+(?![A-Za-z][A-Za-z0-9_-]*\s*=)[A-Za-z0-9_.~+/-]{16,}={0,2}(?=$|[\s"'<>])/i.test(node) || /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/.test(node))) throw credentialError('Credential-shaped content cannot enter parity evidence');
    if (node && typeof node === 'object') for (const [key, child] of Object.entries(node)) {
      if (credentialKey.test(key)) throw credentialError('Credential fields cannot enter parity evidence');
      walk(child);
    }
  }
  walk(value);
}

function assertCredentialSafeText(text) {
  let json; try { json = JSON.parse(text); } catch { /* Malformed JSON is still inspected conservatively below. */ }
  assertNoCredentials(json ?? text);
  const decoded = text.replace(/\\u([a-f\d]{4})/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
  if (/(?:^|\r?\n)[ \t]*(?:authorization|proxy-authorization|cookie|set-cookie|x-ms-token-[^:\s]+|__requestverificationtoken)\s*:/i.test(decoded) || /"(?:access_token|refresh_token|id_token|client_secret|clientsecret|password|authorization|cookie|set-cookie|__requestverificationtoken)"\s*:/i.test(decoded)) throw credentialError('Credential field in encoded or multipart body');
}

export function pointer(value, selector) {
  if (selector === '') return value;
  if (typeof selector !== 'string' || !selector.startsWith('/')) throw Error('Capture selectors must be JSON pointers');
  return selector.slice(1).split('/').reduce((current, key) => current != null && Object.hasOwn(Object(current), key.replaceAll('~1', '/').replaceAll('~0', '~')) ? current[key.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined, value);
}

export function expandTemplate(value, variables) {
  if (Array.isArray(value)) return value.map(item => expandTemplate(item, variables));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, expandTemplate(item, variables)]));
  if (typeof value !== 'string') return value;
  const exact = value.match(/^\{\{([a-zA-Z][\w.-]*)\}\}$/);
  const get = name => { if (!Object.hasOwn(variables, name)) throw Error('Unresolved parity variable: ' + name); return clone(variables[name]); };
  if (exact) return get(exact[1]);
  return value.replace(/\{\{([a-zA-Z][\w.-]*)\}\}/g, (_, name) => {
    const item = get(name);
    if (!['string', 'number', 'boolean'].includes(typeof item)) throw Error('Embedded variable must be scalar: ' + name);
    return String(item);
  });
}

export function validatePlan(input) {
  const plan = clone(input);
  if (plan.schemaVersion !== 1 || !idPattern.test(plan.id ?? '') || !Array.isArray(plan.cases) || !plan.cases.length) throw Error('Invalid parity plan');
  assertNoCredentials(plan);
  const ids = new Set();
  for (const entry of plan.cases) {
    if (!idPattern.test(entry.id ?? '') || ids.has(entry.id) || typeof entry.family !== 'string' || !entry.family) throw Error('Cases require unique ids and a family');
    if (!entry.request || typeof entry.request.path !== 'string') throw Error('Case requires request.path');
    entry.request.method = (entry.request.method ?? 'GET').toUpperCase();
    if (!/^[A-Z]+$/.test(entry.request.method)) throw Error('Invalid HTTP method');
    if (entry.request.body !== undefined && (entry.request.bodyBase64 !== undefined || entry.request.bodyText !== undefined) || entry.request.bodyBase64 !== undefined && entry.request.bodyText !== undefined) throw Error('Choose one request body representation');
    if (entry.request.bodyText !== undefined) {
      if (typeof entry.request.bodyText !== 'string') throw Error('bodyText must be a string');
      assertCredentialSafeText(entry.request.bodyText);
    }
    if (entry.request.bodyBase64 !== undefined) {
      if (typeof entry.request.bodyBase64 !== 'string') throw Error('bodyBase64 must be a string');
      assertCredentialSafeText(Buffer.from(entry.request.bodyBase64, 'base64').toString('utf8'));
    }
    for (const [name, value] of Object.entries(entry.request.headers ?? {})) {
      if (credentialHeader.test(name) || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || typeof value !== 'string' || /[\r\n]/.test(value)) throw Error('Invalid or credential-bearing request header');
    }
    for (const dependency of entry.dependsOn ?? []) if (!ids.has(dependency)) throw Error('Dependencies must precede their case');
    if (entry.acceptStatus && (!Array.isArray(entry.acceptStatus) || !entry.acceptStatus.length || entry.acceptStatus.some(status => !Number.isInteger(status) || status < 100 || status > 599))) throw Error('Invalid accepted status');
    for (const [name, capture] of Object.entries(entry.capture ?? {})) if (!/^[a-zA-Z][\w.-]*$/.test(name) || typeof capture !== 'string' || !capture.startsWith('/')) throw Error('Invalid capture');
    ids.add(entry.id);
  }
  return plan;
}

export function prepareRequest(source, variables) {
  const request = expandTemplate(source, variables);
  const headers = { ...request.headers };
  for (const [name, value] of Object.entries({ Accept: 'application/json', 'OData-Version': '4.0', 'OData-MaxVersion': '4.0' })) {
    if (!Object.keys(headers).some(key => key.toLowerCase() === name.toLowerCase())) headers[name] = value;
  }
  if (Object.hasOwn(request, 'body')) {
    request.bodyBase64 = Buffer.from(JSON.stringify(request.body)).toString('base64');
    if (!Object.keys(headers).some(name => name.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json; charset=utf-8';
  } else if (Object.hasOwn(request, 'bodyText')) request.bodyBase64 = Buffer.from(request.bodyText).toString('base64');
  if (request.bodyBase64 !== undefined) {
    const text = Buffer.from(request.bodyBase64, 'base64').toString('utf8');
    assertCredentialSafeText(text);
  }
  delete request.body; delete request.bodyText;
  return { ...request, headers };
}

export function sealResponse(input) {
  if (input.transportError) return { transportError: /^[a-z][a-z0-9-]{0,79}$/.test(String(input.transportError)) ? String(input.transportError) : 'transport-failed', outcome: 'unknown' };
  if (!Number.isInteger(input.status) || input.status < 100 || input.status > 599 || typeof input.bodyBase64 !== 'string') throw Error('Invalid response from transport');
  const headers = {}, withheldHeaders = [...(input.withheldHeaders ?? [])];
  for (const [key, value] of Object.entries(input.headers ?? {})) {
    if (credentialHeader.test(key)) { withheldHeaders.push(key.toLowerCase()); continue; }
    headers[key.toLowerCase()] = value;
  }
  const bytes = bodyBytes(input), text = bytes.toString('utf8');
  let json;
  try { json = JSON.parse(text); } catch { /* Raw bytes remain the authority. */ }
  assertNoCredentials(json ?? text); assertNoCredentials(headers);
  let multipart, multipartParseError;
  if (/^multipart\//i.test(headers['content-type'] ?? '')) {
    // A malformed MIME envelope remains useful evidence, but a parser failure
    // must never conceal credential headers or obvious secret JSON fields.
    assertCredentialSafeText(text);
    try { multipart = inspectMultipart(bytes, headers['content-type']); }
    catch (error) {
      if (error.code === 'PARITY_CREDENTIAL') throw error;
      multipartParseError = 'malformed-multipart';
    }
  }
  return { status: input.status, headers, withheldHeaders: [...new Set(withheldHeaders)].sort(), bodyBase64: input.bodyBase64, bodySha256: sha256(bytes), bytes: bytes.length, ...(json === undefined ? {} : { json }), ...(multipart === undefined ? {} : { multipart }), ...(multipartParseError ? { multipartParseError } : {}) };
}

export function inspectMultipart(bytes, contentType, depth = 0) {
  if (depth > 8) throw Error('Multipart nesting limit');
  const match = contentType.match(/\bboundary\s*=\s*(?:"([^"\r\n]+)"|([^;\s]+))/i), boundary = match?.[1] ?? match?.[2];
  if (!boundary || boundary.length > 200 || /[\r\n]/.test(boundary)) throw Error('Multipart boundary missing');
  const text = bytes.toString('latin1');
  const escaped = boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const delimiters = [...text.matchAll(new RegExp('(?:^|\\r\\n)--' + escaped + '(--)?[ \\t]*(?:\\r\\n|$)', 'g'))];
  if (!delimiters.length || !delimiters.at(-1)[1] || delimiters.length > 1002) throw Error('Malformed multipart delimiters');
  const parseHeaders = source => {
    const headers = {};
    for (const line of source.split('\r\n')) {
      const colon = line.indexOf(':'); if (colon <= 0) throw Error('Malformed multipart header');
      const name = line.slice(0, colon).trim().toLowerCase(), value = line.slice(colon + 1).trim();
      // Inner authentication material would also be present in the raw body.
      if (credentialHeader.test(name)) throw credentialError('Credential header in multipart body');
      headers[name] = Object.hasOwn(headers, name) ? [].concat(headers[name], value) : value;
    }
    return headers;
  };
  const parts = [];
  for (let i = 0; i < delimiters.length - 1; i++) {
    if (delimiters[i][1]) throw Error('Premature multipart close');
    const source = text.slice(delimiters[i].index + delimiters[i][0].length, delimiters[i + 1].index), split = source.indexOf('\r\n\r\n');
    if (split < 0) throw Error('Multipart part lacks headers');
    const headers = parseHeaders(source.slice(0, split)), body = source.slice(split + 4), type = headers['content-type'] ?? '';
    if (typeof type !== 'string') throw Error('Duplicate MIME content type');
    if (/^multipart\//i.test(type)) parts.push({ headers, multipart: inspectMultipart(Buffer.from(body, 'latin1'), type, depth + 1) });
    else if (/^application\/http/i.test(type)) {
      const lineEnd = body.indexOf('\r\n'), status = body.slice(0, lineEnd).match(/^HTTP\/\d(?:\.\d)? (\d{3})(?: (.*))?$/);
      if (!status) throw Error('Invalid batch HTTP status line');
      const rest = body.slice(lineEnd + 2), headerEnd = rest.indexOf('\r\n\r\n');
      const innerHeaders = headerEnd >= 0 ? parseHeaders(rest.slice(0, headerEnd)) : rest.startsWith('\r\n') ? {} : null;
      if (!innerHeaders) throw Error('Invalid batch HTTP headers');
      const payload = Buffer.from(headerEnd >= 0 ? rest.slice(headerEnd + 4) : rest.slice(2), 'latin1');
      let json; try { json = JSON.parse(payload.toString('utf8')); } catch { /* Preserve non-JSON and empty bodies. */ }
      assertNoCredentials(json ?? payload.toString('utf8'));
      parts.push({ headers, status: Number(status[1]), reason: status[2] ?? '', responseHeaders: innerHeaders, bodySha256: sha256(payload), bytes: payload.length, ...(json === undefined ? {} : { json }) });
    } else parts.push({ headers, bodySha256: sha256(Buffer.from(body, 'latin1')), bytes: Buffer.byteLength(body, 'latin1') });
  }
  return { boundary, parts };
}

// No implicit retry: an interrupted write has an unknown outcome until reconciled.
export async function runSuite(input, { transport, variables = {}, allowWrites = false, sink = async () => {}, onProgress = () => {} } = {}) {
  const plan = validatePlan(input);
  if (typeof transport !== 'function') throw Error('A parity transport is required');
  if (!allowWrites && plan.cases.some(entry => !['GET', 'HEAD', 'OPTIONS'].includes(entry.request.method))) throw Error('Plan contains writes; explicit allowWrites required');
  const state = { ...clone(plan.variables ?? {}), ...clone(variables) };
  assertNoCredentials(state);
  // Initial variables can supply encoded bodies. Inspect every resolvable
  // request before the start event can persist the plan or variables.
  for (const entry of plan.cases) {
    try { prepareRequest(entry.request, state); }
    catch (error) { if (error.code === 'PARITY_CREDENTIAL') throw error; }
  }
  const run = { schemaVersion: 1, planId: plan.id, planSha256: sha256(plan), plan: clone(plan), startedAt: new Date().toISOString(), complete: false, results: [], variables: clone(state) };
  await sink({ type: 'start', plan, run: clone(run) });
  const results = new Map();
  for (const entry of plan.cases) {
    const result = { id: entry.id, family: entry.family, covers: entry.covers ?? [] };
    if ((entry.dependsOn ?? []).some(id => results.get(id)?.outcome !== 'observed')) {
      Object.assign(result, { outcome: 'blocked', reason: 'dependency-not-observed' });
    } else {
      let request;
      try { request = prepareRequest(entry.request, state); } catch { result.outcome = 'blocked'; result.reason = 'unresolved-request'; }
      if (request) {
        result.request = request;
        // Persist intent before the transport can mutate anything.
        await sink({ type: 'intent', id: entry.id, request });
        const start = performance.now();
        let response;
        try { response = await transport(request); } catch { response = { transportError: 'transport-failed' }; }
        result.elapsedMs = Math.round(performance.now() - start);
        try {
          result.response = sealResponse(response);
          result.outcome = result.response.transportError ? 'unknown' : entry.acceptStatus && !entry.acceptStatus.includes(result.response.status) ? 'unexpected-status' : 'observed';
          if (result.outcome === 'observed') {
            const captures = {};
            for (const [name, selector] of Object.entries(entry.capture ?? {})) {
              const value = pointer(result.response, selector);
              if (value === undefined) { result.outcome = 'missing-capture'; result.reason = 'capture-absent'; break; }
              captures[name] = value;
            }
            if (result.outcome === 'observed') { Object.assign(state, captures); result.captures = captures; }
          }
        } catch {
          result.response = { ...(Number.isInteger(response.status) ? { status: response.status } : {}), evidenceWithheld: true };
          result.outcome = 'invalid-evidence'; result.reason = 'response-or-capture-invalid';
        }
      }
    }
    run.results.push(result); results.set(entry.id, result);
    await sink({ type: 'result', result });
    await onProgress({ id: result.id, outcome: result.outcome, status: result.response?.status ?? null });
  }
  run.complete = true; run.finishedAt = new Date().toISOString(); run.finalVariables = state;
  run.counts = Object.fromEntries(['observed', 'blocked', 'unknown', 'unexpected-status', 'invalid-evidence', 'missing-capture'].map(outcome => [outcome, run.results.filter(entry => entry.outcome === outcome).length]));
  await sink({ type: 'finish', run });
  return run;
}

export async function createRunWriter(directory) {
  await fs.mkdir(path.dirname(path.resolve(directory)), { recursive: true });
  await fs.mkdir(directory); // A run is immutable; never reuse an evidence directory.
  const journal = await fs.open(path.join(directory, 'journal.jsonl'), 'wx');
  return {
    async sink(event) {
      await journal.write(JSON.stringify(event) + '\n'); await journal.sync();
      if (event.type === 'start') await fs.writeFile(path.join(directory, 'plan.json'), JSON.stringify(event.plan, null, 2), { flag: 'wx' });
      if (event.type === 'finish') await fs.writeFile(path.join(directory, 'run.json'), JSON.stringify(event.run, null, 2), { flag: 'wx' });
    },
    close: () => journal.close()
  };
}

export function createFetchTransport({ baseUrl, token, fetchImpl = fetch, allowRemote = false, timeoutMs = 45000, maxResponseBytes = 32 * 1024 * 1024 }) {
  const base = new URL(baseUrl);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((!loopback && (!allowRemote || base.protocol !== 'https:')) || !['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw Error('Remote parity targets require explicit allowRemote and HTTPS');
  if (!/^\/api\/data\/v9\.\d+\/$/.test(base.pathname)) throw Error('baseUrl must end with /api/data/v9.x/');
  return async request => {
    const url = new URL(request.path, base);
    if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.username || url.password || url.hash) throw Error('Parity request escaped API origin');
    const headers = { ...request.headers };
    for (const key of Object.keys(headers)) if (credentialHeader.test(key)) throw Error('Credentials must be supplied through transport');
    if (token) headers.Authorization = 'Bearer ' + await token();
    let response;
    try {
      response = await fetchImpl(url, { method: request.method, headers, ...(request.bodyBase64 !== undefined ? { body: Buffer.from(request.bodyBase64, 'base64') } : {}), redirect: 'manual', signal: AbortSignal.timeout(request.timeoutMs ?? timeoutMs) });
      const chunks = []; let length = 0;
      if (response.body) for await (const chunk of response.body) { length += chunk.length; if (length > maxResponseBytes) { await response.body.cancel().catch(() => {}); return { transportError: 'response-limit' }; } chunks.push(chunk); }
      return { status: response.status, headers: Object.fromEntries(response.headers), bodyBase64: Buffer.concat(chunks).toString('base64') };
    } catch { return { transportError: 'network-or-timeout' }; }
  };
}

function differences(expected, actual, location, emit) {
  if (Object.is(expected, actual)) return;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) emit(location + '/length', expected.length, actual.length);
    for (let i = 0; i < Math.max(expected.length, actual.length); i++) {
      if (i >= expected.length || i >= actual.length) emit(location + '/' + i, i < expected.length ? expected[i] : { absent: true }, i < actual.length ? actual[i] : { absent: true });
      else differences(expected[i], actual[i], location + '/' + i, emit);
    }
  } else if (expected && actual && typeof expected === 'object' && typeof actual === 'object' && !Array.isArray(expected) && !Array.isArray(actual)) {
    for (const key of new Set([...Object.keys(expected), ...Object.keys(actual)])) {
      const next = location + '/' + escapePointer(key);
      if (!Object.hasOwn(expected, key) || !Object.hasOwn(actual, key)) emit(next, Object.hasOwn(expected, key) ? expected[key] : { absent: true }, Object.hasOwn(actual, key) ? actual[key] : { absent: true });
      else differences(expected[key], actual[key], next, emit);
    }
  } else emit(location, expected, actual);
}

function validStoredResponse(response) {
  try {
    return !response?.evidenceWithheld && typeof response?.bodyBase64 === 'string' && Buffer.from(response.bodyBase64, 'base64').toString('base64') === response.bodyBase64 && isDeepStrictEqual(sealResponse(response), response);
  } catch { return false; }
}

function requestEvidenceIssues(plan, run) {
  const issues = [], state = clone(run.variables ?? {}), results = new Map(run.results.map(item => [item.id, item]));
  if (run.planSha256 !== sha256(plan)) return [{ id: '$run', reason: 'plan-hash-mismatch' }];
  const plannedIds = new Set(plan.cases.map(item => item.id));
  if (results.size !== run.results.length) issues.push({ id: '$run', reason: 'duplicate-result-ids' });
  for (const id of results.keys()) if (!plannedIds.has(id)) issues.push({ id, reason: 'unplanned-result' });
  for (const entry of plan.cases) {
    const result = results.get(entry.id);
    if (!result) { issues.push({ id: entry.id, reason: 'missing-planned-result' }); continue; }
    if (result.request || result.outcome === 'observed') {
      try {
        if (!isDeepStrictEqual(prepareRequest(entry.request, state), result.request)) issues.push({ id: entry.id, reason: 'executed-request-does-not-match-plan' });
      } catch { issues.push({ id: entry.id, reason: 'request-cannot-be-reconstructed' }); }
    }
    if (result.outcome === 'observed') for (const [name, selector] of Object.entries(entry.capture ?? {})) {
      const value = pointer(result.response, selector);
      if (value === undefined) issues.push({ id: entry.id, reason: 'capture-cannot-be-reconstructed' });
      else state[name] = value;
    }
  }
  return issues;
}

export function compareRuns(reference, actual, { maxDeltas = 10000, rules = [], plan = reference.plan ?? actual.plan } = {}) {
  if (!Number.isInteger(maxDeltas) || maxDeltas < 1) throw Error('maxDeltas must be positive');
  for (const rule of rules) if (typeof rule.reason !== 'string' || !rule.reason.trim() || typeof rule.path !== 'string' || !rule.path.startsWith('/') || !rule.caseId || rule.reference === undefined || rule.actual === undefined) throw Error('Reviewed deltas require caseId, exact path, reference/actual values and reason');
  const report = { schemaVersion: 1, exactMatch: false, referenceComplete: reference.complete === true, actualComplete: actual.complete === true, totalDeltas: 0, reviewedDeltas: 0, unexplainedDeltas: 0, groups: {}, deltas: [], truncated: false, cases: [] };
  const emit = (id, location, expected, got) => {
    const rule = rules.find(item => item.caseId === id && item.path === location && JSON.stringify(item.reference) === JSON.stringify(expected) && JSON.stringify(item.actual) === JSON.stringify(got));
    report.totalDeltas++; if (rule) report.reviewedDeltas++; else report.unexplainedDeltas++;
    const group = location.split('/')[1]; report.groups[group] = (report.groups[group] ?? 0) + 1;
    if (report.deltas.length < maxDeltas) report.deltas.push({ id, path: location, reference: expected, actual: got, ...(rule ? { reviewedReason: rule.reason } : {}) }); else report.truncated = true;
  };
  if (!report.referenceComplete || !report.actualComplete) emit('$run', '/complete', reference.complete, actual.complete);
  if (reference.planSha256 !== actual.planSha256) emit('$run', '/planSha256', reference.planSha256, actual.planSha256);
  report.requestsVerified = false;
  if (plan) {
    try {
      plan = validatePlan(plan);
      const issues = [['reference', requestEvidenceIssues(plan, reference)], ['actual', requestEvidenceIssues(plan, actual)]];
      for (const [side, values] of issues) for (const value of values) emit(value.id, '/requestEvidence/' + side, 'request matches target-bound plan', value.reason);
      report.requestsVerified = issues.every(([, values]) => !values.length);
    } catch { emit('$run', '/requestEvidence', 'valid plan', 'invalid plan or request evidence'); }
  } else emit('$run', '/requestEvidence', 'plan required to verify executed requests', 'plan unavailable');
  const refs = new Map(reference.results.map(item => [item.id, item])), acts = new Map(actual.results.map(item => [item.id, item]));
  if (refs.size !== reference.results.length || acts.size !== actual.results.length) emit('$run', '/duplicate-case-id', reference.results.length - refs.size, actual.results.length - acts.size);
  for (const id of new Set([...refs.keys(), ...acts.keys()])) {
    const ref = refs.get(id), act = acts.get(id), before = report.totalDeltas;
    if (!ref || !act) emit(id, '/case', !!ref, !!act);
    else if (ref.outcome !== 'observed' || act.outcome !== 'observed' || !ref.response || !act.response) emit(id, '/outcome', ref.outcome, act.outcome);
    else {
      for (const [side, item] of [['reference', ref], ['actual', act]]) {
        if (!validStoredResponse(item.response)) emit(id, '/evidence/' + side, 'valid sealed response', 'invalid or inconsistent response');
      }
      // Target-specific captures may change paths/headers, but a response to a
      // different HTTP method never establishes parity for the planned method.
      differences(ref.request?.method, act.request?.method, '/request/method', (p, a, b) => emit(id, p, a, b));
      differences(ref.response.status, act.response.status, '/status', (p, a, b) => emit(id, p, a, b));
      differences(ref.response.headers, act.response.headers, '/headers', (p, a, b) => emit(id, p, a, b));
      differences(ref.response.withheldHeaders, act.response.withheldHeaders, '/withheldHeaders', (p, a, b) => emit(id, p, a, b));
      const refBytes = bodyBytes(ref.response), actBytes = bodyBytes(act.response);
      if (!refBytes.equals(actBytes)) emit(id, '/bodyBytes', { sha256: sha256(refBytes), bytes: refBytes.length }, { sha256: sha256(actBytes), bytes: actBytes.length });
      differences(ref.response.json, act.response.json, '/json', (p, a, b) => emit(id, p, a, b));
      differences(ref.response.multipart, act.response.multipart, '/multipart', (p, a, b) => emit(id, p, a, b));
      differences(ref.response.multipartParseError, act.response.multipartParseError, '/multipartParseError', (p, a, b) => emit(id, p, a, b));
    }
    report.cases.push({ id, exactMatch: report.totalDeltas === before });
  }
  if (!refs.size || !acts.size) emit('$run', '/empty', refs.size, acts.size);
  report.exactMatch = report.totalDeltas === 0;
  return report;
}

// Cataloguing is intentionally separate from execution. Metadata describes many
// administrative actions; discovering an action does not authorize invoking it.
export function inspectCsdl(xml) {
  const unescape = text => text.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const attrs = text => Object.fromEntries([...text.matchAll(/([\w:.]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)].map(match => [match[1], unescape(match[2] ?? match[3])]));
  if (typeof xml !== 'string' || !/<(?:\w+:)?Edmx[\s>]/.test(xml)) throw Error('Expected an Edmx metadata document');
  const operations = [], entitySets = [], types = [];
  for (const schema of xml.matchAll(/<(?:\w+:)?Schema\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?Schema>/g)) {
    const namespace = attrs(schema[1]).Namespace;
    for (const match of schema[2].matchAll(/<(?:\w+:)?(Action|Function)\b([^>]*?)(?:\/\s*>|>([\s\S]*?)<\/(?:\w+:)?\1>)/g)) {
      const content = match[3] ?? '';
      const meta = attrs(match[2]), parameters = [...content.matchAll(/<(?:\w+:)?Parameter\b([^>]*?)\/?\s*>/g)].map(item => attrs(item[1]));
      const signature = `${namespace}.${meta.Name}(${parameters.map(item => `${item.Name}:${item.Type}`).join(',')})`;
      operations.push({ id: 'operation:' + signature, kind: match[1], name: meta.Name, namespace, bound: meta.IsBound === 'true', parameters, returnType: attrs(content.match(/<(?:\w+:)?ReturnType\b([^>]*)/)?.[1] ?? '').Type ?? null });
    }
    for (const match of schema[2].matchAll(/<(?:\w+:)?EntitySet\b([^>]*?)\/?\s*>/g)) { const meta = attrs(match[1]); entitySets.push({ id: 'entitySet:' + meta.Name, name: meta.Name, type: meta.EntityType }); }
    for (const match of schema[2].matchAll(/<(?:\w+:)?(EntityType|ComplexType|EnumType)\b([^>]*?)\/?\s*>/g)) { const meta = attrs(match[2]); types.push({ name: namespace + '.' + meta.Name, kind: match[1], baseType: meta.BaseType ?? null }); }
  }
  return { schemaVersion: 1, metadataSha256: sha256(xml), operations, entitySets, types };
}

export function coverageReport(plan, run, catalogue = { operations: [], entitySets: [] }, requiredFamilies = []) {
  plan = validatePlan(plan);
  const byId = new Map((run?.results ?? []).map(item => [item.id, item]));
  const planVerified = run?.planSha256 === sha256(plan) && byId.size === (run?.results ?? []).length && byId.size === plan.cases.length && plan.cases.every(item => byId.has(item.id)) && requestEvidenceIssues(plan, run).length === 0;
  const covered = new Set(), families = {};
  for (const entry of plan.cases) {
    const result = byId.get(entry.id), outcome = !planVerified ? 'unverified-plan' : result?.outcome === 'observed' && !validStoredResponse(result.response) ? 'invalid-evidence' : result?.outcome ?? 'unrecorded';
    const family = families[entry.family] ??= { planned: 0, observed: 0, gaps: [] };
    family.planned++;
    if (outcome === 'observed' && result?.response && !result.response.transportError) { family.observed++; for (const id of entry.covers ?? []) covered.add(id); }
    else family.gaps.push({ id: entry.id, outcome });
  }
  for (const family of requiredFamilies) families[family] ??= { planned: 0, observed: 0, gaps: [{ outcome: 'unplanned' }] };
  const inventory = [...catalogue.operations, ...catalogue.entitySets];
  const unrecorded = inventory.filter(item => !covered.has(item.id));
  return { schemaVersion: 1, planVerified, complete: run?.complete === true && planVerified && unrecorded.length === 0 && Object.values(families).every(family => family.planned > 0 && family.gaps.length === 0), families, metadata: { discovered: inventory.length, observed: inventory.length - unrecorded.length, unrecorded }, limits: ['Finite recorded cases do not establish every possible input, identity, schema, plug-in, concurrency interleaving or future platform behavior.'] };
}

// Documentation and SDK expectations are a separate oracle from native captures.
// Only explicit, executable assertions are evaluated; prose is never inferred.
export function evaluateAssertions(run, checks) {
  const results = [], byId = new Map(run.results.map(item => [item.id, item]));
  const ids = new Set();
  for (const check of checks) {
    if (!idPattern.test(check.id ?? '') || ids.has(check.id) || !check.caseId || !Array.isArray(check.assertions) || !check.assertions.length || !['documentation', 'sdk-fixture', 'native'].includes(check.source?.kind) || !check.source.url) throw Error('Assertion checks require unique ids, provenance and executable assertions');
    ids.add(check.id);
    const entry = byId.get(check.caseId), result = { id: check.id, caseId: check.caseId, source: check.source, untested: check.untested ?? [], outcome: 'unrecorded', assertions: [] };
    if (run.complete === true && entry?.outcome === 'observed' && validStoredResponse(entry.response) && run.results.filter(item => item.id === check.caseId).length === 1) {
      for (const item of check.assertions) {
        const value = pointer(entry.response, item.path), expected = expandTemplate(item.expected, run.finalVariables ?? run.variables ?? {});
        let passed;
        if (item.op === 'exists') passed = value !== undefined;
        else if (item.op === 'absent') passed = value === undefined;
        else if (item.op === 'equals') passed = isDeepStrictEqual(value, expected);
        else if (item.op === 'type') passed = expected === 'array' ? Array.isArray(value) : expected === 'null' ? value === null : expected === 'integer' ? Number.isInteger(value) : expected === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : typeof value === expected;
        else if (item.op === 'includes') passed = typeof value === 'string' ? value.includes(expected) : Array.isArray(value) && value.some(child => isDeepStrictEqual(child, expected));
        else throw Error('Unknown assertion operator');
        result.assertions.push({ path: item.path, op: item.op, expected, ...(value === undefined ? { absent: true } : { actual: value }), passed });
      }
      result.outcome = result.assertions.every(item => item.passed) ? 'passed' : 'failed';
    }
    results.push(result);
  }
  return { schemaVersion: 1, scope: 'Only selected executable facets; untested prose/preconditions remain separate obligations.', passed: results.filter(item => item.outcome === 'passed').length, failed: results.filter(item => item.outcome === 'failed').length, unrecorded: results.filter(item => item.outcome === 'unrecorded').length, results };
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    plan: { type: 'string' }, base: { type: 'string' }, out: { type: 'string' }, reference: { type: 'string' }, actual: { type: 'string' }, metadata: { type: 'string' }, rules: { type: 'string' }, checks: { type: 'string' }, 'token-env': { type: 'string' }, 'allow-remote': { type: 'boolean' }, 'allow-writes': { type: 'boolean' }
  } });
  const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
  const command = positionals[0];
  if (command === 'catalogue') {
    const catalogue = inspectCsdl(await fs.readFile(values.metadata, 'utf8'));
    await fs.writeFile(values.out, JSON.stringify(catalogue, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ operations: catalogue.operations.length, entitySets: catalogue.entitySets.length }));
  } else if (command === 'record' || command === 'replay') {
    const plan = await read(values.plan);
    const secret = values['token-env'] ? process.env[values['token-env']] : undefined;
    if (values['token-env'] && !secret) throw Error('Requested token environment variable is unavailable');
    const transport = createFetchTransport({ baseUrl: values.base, token: secret ? async () => secret : undefined, allowRemote: values['allow-remote'] });
    const writer = await createRunWriter(values.out);
    let run;
    try { run = await runSuite(plan, { transport, variables: { base: values.base }, allowWrites: values['allow-writes'], sink: writer.sink }); } finally { await writer.close(); }
    console.log(JSON.stringify({ complete: run.complete, counts: run.counts }));
    if (Object.entries(run.counts).some(([key, count]) => key !== 'observed' && count)) process.exitCode = 1;
    if (values.reference) {
      const comparison = compareRuns(await read(values.reference), run, { rules: values.rules ? await read(values.rules) : [], plan });
      await fs.writeFile(path.join(values.out, 'comparison.json'), JSON.stringify(comparison, null, 2), { flag: 'wx' });
      console.log(JSON.stringify({ exactMatch: comparison.exactMatch, totalDeltas: comparison.totalDeltas, unexplainedDeltas: comparison.unexplainedDeltas }));
      if (!comparison.exactMatch) process.exitCode = 1;
    }
  } else if (command === 'assert') {
    const report = evaluateAssertions(await read(values.actual), await read(values.checks));
    await fs.writeFile(values.out, JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ passed: report.passed, failed: report.failed, unrecorded: report.unrecorded }));
    if (report.failed || report.unrecorded) process.exitCode = 1;
  } else if (command === 'diff') {
    const comparison = compareRuns(await read(values.reference), await read(values.actual), { rules: values.rules ? await read(values.rules) : [], ...(values.plan ? { plan: await read(values.plan) } : {}) });
    await fs.writeFile(values.out, JSON.stringify(comparison, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ exactMatch: comparison.exactMatch, totalDeltas: comparison.totalDeltas, unexplainedDeltas: comparison.unexplainedDeltas }));
    if (!comparison.exactMatch) process.exitCode = 1;
  } else throw Error('Use catalogue --metadata FILE --out FILE; record/replay --plan FILE --base URL --out DIRECTORY [--reference RUN]; diff --reference RUN --actual RUN --out FILE');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(() => { console.error('Dataverse parity command failed; inspect private journal and arguments. No automatic retry was attempted.'); process.exitCode = 1; });
