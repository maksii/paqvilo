// Evidence comparison, not an authorization oracle. Original artifacts remain
// private; reports qualify only the exact configuration and cases supplied.
import { createHash } from 'node:crypto';
import { parseXmlDocument } from 'paqvilo/mirage/lib/fetchxml-engine.mjs';
import { stable, guid, laneOutcome } from './core.mjs';

const hash = (text) => createHash('sha256').update(text).digest('hex');
const roleSet = (roles) => [...new Set(roles ?? [])].sort((a, b) => Number(a > b) - Number(a < b));
const marker = (value) =>
  String(value)
    .replace(/^CO-OP:[a-f\d-]{36}$/i, 'CO-OP:{operation}')
    .replace(/^CO-UTC:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/, 'CO-UTC:{time}');
export function normalizeQuerySentinels(xml) {
  // Replace complete XML attribute or value-node literals only. Preserve every
  // other byte, including whitespace, attribute order and generated aliases.
  return String(xml)
    .replace(
      /(value\s*=\s*)(["'])(CO-(?:OP:[a-f\d-]{36}|UTC:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z))\2/g,
      (_, prefix, quote, value) => prefix + quote + marker(value) + quote,
    )
    .replace(
      /(<value(?:\s[^>]*)?>)(CO-(?:OP:[a-f\d-]{36}|UTC:\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z))(<\/value>)/g,
      (_, open, value, close) => open + marker(value) + close,
    );
}

/** Formatting and generated alias identity are canonicalized; predicates,
 * joins, union hints, ordering, projection and non-marker literals are retained.
 * A structural match does not mean byte-identical XML or query equivalence. */
export function queryFingerprint(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return null;
  if (Buffer.byteLength(xml) > 4 * 1024 * 1024) throw new Error('Recorded query exceeds comparison bound.');
  const tree = parseXmlDocument(xml, { root: 'fetch' });
  const aliases = new Map();
  let links = 0;
  const visit = (node) => {
    if (node.name === 'link-entity') links++;
    const alias = node.attrs.alias;
    if (alias?.startsWith('generated_alias_') && !aliases.has(alias))
      aliases.set(alias, `generated_alias_${aliases.size}`);
    for (const child of node.children) visit(child);
  };
  visit(tree);
  const canonical = (node) => ({
    name: node.name,
    attrs: Object.fromEntries(
      Object.entries(node.attrs)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, value]) => [
          key,
          ['alias', 'entityname'].includes(key) ? (aliases.get(value) ?? value) : marker(value),
        ]),
    ),
    text: node.name === 'value' ? marker(node.text) : marker(node.text.trim()),
    children: node.children.map(canonical),
  });
  return {
    exactHash: hash(xml),
    sentinelNormalizedByteHash: hash(normalizeQuerySentinels(xml)),
    structuralHash: hash(stable(canonical(tree))),
    linkCount: links,
  };
}

export function principalFootprint(xml) {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  const attributes = new Set();
  const visit = (node) => {
    if (
      node.name === 'condition' &&
      node.attrs.entityname?.startsWith('generated_alias_') &&
      node.attrs.attribute?.endsWith('principalid')
    )
      attributes.add(node.attrs.attribute);
    for (const child of node.children) visit(child);
  };
  visit(parseXmlDocument(xml, { root: 'fetch' }));
  return [...attributes].sort((a, b) => Number(a > b) - Number(a < b));
}

/** Each plugin artifact is checksummed and reconstructed independently. Missing
 * or mixed parts never become an absent-query success. */
function capturePayloadError(parts, payload, operationId) {
  if (operationId && guid(payload.operationId) !== guid(operationId)) return 'operation-binding';
  if (
    parts.some(
      (part) => part._pqvd_operationid_value && guid(part._pqvd_operationid_value) !== guid(payload.operationId),
    )
  )
    return 'operation-binding';
  const consistent = [
    'pqvd_depth',
    'pqvd_mode',
    'pqvd_querytype',
    'pqvd_message',
    'pqvd_correlationid',
    'pqvd_requestid',
  ];
  if (parts.some((part) => consistent.some((field) => part[field] !== parts[0][field]))) return 'part-metadata';
  if (
    payload.artifact !== parts[0].pqvd_artifacttype ||
    payload.context?.executionOrder !== parts[0].pqvd_executionorder
  )
    return 'artifact-order-binding';
  return null;
}

function captureContextError(parts, payload) {
  if (payload.context?.Stage !== parts[0].pqvd_stage || payload.spanId !== parts[0].pqvd_spanid)
    return 'context-binding';
  if (
    ['Depth', 'Mode', 'MessageName'].some((field, index) => {
      const column = ['pqvd_depth', 'pqvd_mode', 'pqvd_message'][index];
      return parts[0][column] !== undefined && payload.context[field] !== parts[0][column];
    }) ||
    (parts[0].pqvd_querytype !== undefined && payload.content.query.type !== parts[0].pqvd_querytype)
  )
    return 'context-metadata';
  return null;
}

function readCapturedQuery(parts, operationId) {
  try {
    // Both native transactional recording and the durable collector repeat the complete payload hash on every part.
    const text = parts.map((part) => part.pqvd_payloadtext).join('');
    const payloadHash = hash(text);
    if (parts.some((part) => part.pqvd_payloadhash !== payloadHash)) return { error: 'checksum' };
    const payload = JSON.parse(text);
    const bindingError = capturePayloadError(parts, payload, operationId);
    if (bindingError) return { error: bindingError };
    const xml = payload.content?.query?.xml;
    if (!xml) return {};
    const contextError = captureContextError(parts, payload);
    if (contextError) return { error: contextError };
    const fingerprint = queryFingerprint(xml);
    if (payload.content.linkCount !== undefined && payload.content.linkCount !== fingerprint.linkCount)
      return { error: 'link-count' };
    return {
      query: {
        artifact: payload.artifact,
        stage: payload.context.Stage,
        order: parts[0].pqvd_executionorder,
        queryType: payload.content.query.type,
        fingerprint,
        principalFootprint: principalFootprint(xml),
      },
    };
  } catch {
    return { error: 'invalid-artifact' };
  }
}

export function capturedQueries(events = [], { operationId } = {}) {
  const groups = new Map(),
    errors = [];
  for (const event of events) {
    const text = event.pqvd_payloadtext;
    if (typeof text !== 'string' || !/^[a-f\d]{64}$/i.test(event.pqvd_payloadhash ?? '')) {
      errors.push({ kind: 'checksum', artifact: event.pqvd_artifacttype });
      continue;
    }
    const key = stable([event.pqvd_spanid, event.pqvd_artifacttype, event.pqvd_stage, event.pqvd_executionorder]);
    const parts = groups.get(key) ?? [];
    parts.push(event);
    groups.set(key, parts);
  }
  const queries = [];
  for (const parts of groups.values()) {
    parts.sort((a, b) => a.pqvd_partnumber - b.pqvd_partnumber);
    if (parts.some((part, index) => part.pqvd_partnumber !== index + 1 || part.pqvd_partcount !== parts.length)) {
      errors.push({ kind: 'parts', artifact: parts[0].pqvd_artifacttype });
      continue;
    }
    const result = readCapturedQuery(parts, operationId);
    if (result.error) errors.push({ kind: result.error, artifact: parts[0].pqvd_artifacttype });
    if (result.query) queries.push(result.query);
  }
  return {
    queries: queries.toSorted(
      (a, b) => a.stage - b.stage || a.order - b.order || String(a.artifact).localeCompare(String(b.artifact)),
    ),
    errors,
  };
}

const multiset = (rows) => (rows ?? []).map(stable).sort();
function queryDiff(left, right) {
  if (!left || !right) return { verdict: 'unqualified', reason: 'missing-query' };
  return {
    verdict:
      left.structuralHash === right.structuralHash &&
      left.sentinelNormalizedByteHash === right.sentinelNormalizedByteHash
        ? 'equal'
        : 'different',
    structurallyEqual: left.structuralHash === right.structuralHash,
    exactXml: left.exactHash === right.exactHash,
    sentinelNormalizedBytesEqual: left.sentinelNormalizedByteHash === right.sentinelNormalizedByteHash,
    nativeLinks: left.linkCount,
    mirageLinks: right.linkCount,
    nativeHash: left.structuralHash,
    mirageHash: right.structuralHash,
  };
}

function lanePageIndexes(native, mirage, reasons) {
  const physicalKey = (page) => `${page.fragment ?? 1}:${page.page ?? 1}`;
  return [native, mirage].map((lane) => {
    const index = new Map();
    for (const page of lane.pages ?? []) {
      const key = physicalKey(page);
      if (index.has(key)) reasons.push('duplicate-page');
      index.set(key, page);
    }
    return index;
  });
}

function compareLanePage(key, indexes) {
  const [left, right] = indexes.map((index) => index.get(key));
  const queries = {};
  for (const field of ['authoredFetchXml', 'effectiveFetchXml']) {
    try {
      queries[field] = queryDiff(queryFingerprint(left?.[field]), queryFingerprint(right?.[field]));
    } catch {
      queries[field] = { verdict: 'unqualified', reason: 'invalid-query' };
    }
  }
  const [a, b] = [left, right].map((page) => capturedQueries(page?.backendEvents, { operationId: page?.operationId }));
  const shape = (capture) =>
    capture.queries.map((query) => ({
      artifact: query.artifact,
      stage: query.stage,
      order: query.order,
      queryType: query.queryType,
      ...query.fingerprint,
      exactHash: undefined,
    }));
  let backend;
  if (a.errors.length || b.errors.length || !a.queries.length || !b.queries.length) backend = 'unqualified';
  else backend = stable(shape(a)) === stable(shape(b)) ? 'equal' : 'different';
  const page = {
    key,
    queries,
    backend,
    nativeStages: a.queries.map((q) => [q.stage, q.order, q.fingerprint.linkCount]),
    mirageStages: b.queries.map((q) => [q.stage, q.order, q.fingerprint.linkCount]),
    artifactErrors: [...a.errors, ...b.errors],
  };
  return page;
}

function compareLanePages(native, mirage, reasons) {
  const pages = [],
    indexes = lanePageIndexes(native, mirage, reasons);
  for (const key of new Set([...indexes[0].keys(), ...indexes[1].keys()])) {
    const page = compareLanePage(key, indexes);
    pages.push(page);
    if (page.backend !== 'equal') reasons.push(`backend-${page.backend}`);
    if (page.queries.authoredFetchXml.verdict !== 'equal')
      reasons.push(`authored-${page.queries.authoredFetchXml.verdict}`);
    // The native API does not expose Liquid's effective XML. Backend is mandatory.
    if (native.engine === 'liquid' && page.queries.effectiveFetchXml.verdict !== 'equal')
      reasons.push(`effective-${page.queries.effectiveFetchXml.verdict}`);
  }
  if (!pages.length) reasons.push('missing-pages');
  return pages;
}

export function compareLane(native, mirage) {
  if (!native || !mirage) return { verdict: 'unqualified', reasons: ['missing-lane'] };
  const reasons = [],
    outcome = stable(laneOutcome(native)) === stable(laneOutcome(mirage)) ? 'equal' : 'different';
  if (outcome !== 'equal') reasons.push('outcome');
  let rows;
  if (
    native.complete &&
    mirage.complete &&
    Array.isArray(native.rows) &&
    Array.isArray(mirage.rows) &&
    native.outcome === 'success' &&
    mirage.outcome === 'success'
  )
    rows = stable(multiset(native.rows)) === stable(multiset(mirage.rows)) ? 'equal' : 'different';
  else rows = 'unqualified';
  if (rows !== 'equal') reasons.push(rows === 'different' ? 'rows' : 'incomplete-rows');
  const pages = compareLanePages(native, mirage, reasons);
  const unique = [...new Set(reasons)];
  let verdict;
  if (
    unique.some((reason) =>
      ['outcome', 'rows', 'backend-different', 'authored-different', 'effective-different'].includes(reason),
    )
  )
    verdict = 'different';
  else if (unique.length) verdict = 'unqualified';
  else verdict = 'equal';
  return {
    verdict,
    outcome,
    rows,
    pages,
    reasons: unique,
  };
}

function runPrerequisiteFailures(native, mirage) {
  const prerequisiteFailures = [];
  for (const flag of [
    'nativeConfigurationVerified',
    'nativeMembershipsVerified',
    'nativeDataVerified',
    'nativeCacheQualified',
  ])
    if (native?.evidenceQualification?.[flag] !== true || mirage?.evidenceQualification?.[flag] !== true)
      prerequisiteFailures.push(`unverified-${flag}`);
  for (const snapshot of ['permissionSnapshotHash', 'membershipSnapshotHash', 'dataSnapshotHash'])
    if (!native?.configuration?.[snapshot] || native.configuration[snapshot] !== mirage?.configuration?.[snapshot])
      prerequisiteFailures.push(snapshot);
  for (const field of ['datasetVersion', 'manifestHash', 'sourceHash'])
    if (!native?.[field] || native[field] !== mirage?.[field]) prerequisiteFailures.push(field);
  if (!native?.contactId || guid(native.contactId) !== guid(mirage?.contactId)) prerequisiteFailures.push('contactId');
  if (!native?.configuration || stable(native.configuration) !== stable(mirage?.configuration))
    prerequisiteFailures.push('configuration');
  if (
    !Array.isArray(native?.roles) ||
    !Array.isArray(mirage?.roles) ||
    stable(roleSet(native.roles)) !== stable(roleSet(mirage.roles))
  )
    prerequisiteFailures.push('roles');
  return prerequisiteFailures;
}

function matchRunPairs(native, mirage, prerequisiteFailures) {
  const pairs = [],
    byId = new Map();
  for (const pair of mirage?.pairs ?? []) {
    const key = pair.pairId ?? pair.caseId;
    if (byId.has(key)) prerequisiteFailures.push('duplicate-pair');
    byId.set(key, pair);
  }
  const expected = new Set();
  for (const pair of native?.pairs ?? []) {
    const key = pair.pairId ?? pair.caseId;
    if (expected.has(key)) prerequisiteFailures.push('duplicate-pair');
    expected.add(key);
    const actual = byId.get(key);
    pairs.push({
      caseId: pair.caseId,
      pairId: key,
      liquid: compareLane(pair.liquid, actual?.liquid),
      webapi: compareLane(pair.webapi, actual?.webapi),
    });
  }
  for (const key of byId.keys()) if (!expected.has(key)) prerequisiteFailures.push('extra-pair');
  if (!pairs.length) prerequisiteFailures.push('missing-pairs');
  return pairs;
}

function runComparisonVerdict(failures, pairs) {
  if (failures.length) return 'unqualified';
  if (pairs.some((pair) => [pair.liquid, pair.webapi].some((lane) => lane.verdict === 'different'))) return 'different';
  if (pairs.every((pair) => [pair.liquid, pair.webapi].every((lane) => lane.verdict === 'equal'))) return 'equal';
  return 'unqualified';
}

export function compareRuns(native, mirage) {
  const prerequisiteFailures = runPrerequisiteFailures(native, mirage);
  const pairs = matchRunPairs(native, mirage, prerequisiteFailures);
  const failures = [...new Set(prerequisiteFailures)];
  const verdict = runComparisonVerdict(failures, pairs);
  return {
    schemaVersion: 1,
    kind: 'native-vs-mirage-recorded-evidence',
    prerequisiteFailures: failures,
    pairs,
    verdict,
    qualification:
      'Only supplied actor, configuration, query shapes and complete checksummed captures; no universal role or pipeline claim.',
  };
}

/** Declared roles are a finite domain. Recorded subsets are counted explicitly;
 * this ledger never promotes offline enumeration to native coverage. */
export function coverageLedger(runs, businessRoles) {
  if (
    !Array.isArray(businessRoles) ||
    new Set(businessRoles).size !== businessRoles.length ||
    businessRoles.length > 52
  )
    throw new Error('Invalid finite role domain.');
  const observed = new Set(),
    cases = new Set(),
    excluded = [];
  for (const run of runs) {
    if (!Array.isArray(run.roles) || !run.configuration || !run.contactId) {
      excluded.push('missing-provenance');
      continue;
    }
    const roles = businessRoles.filter((role) => run.roles.includes(role));
    observed.add(stable(roles));
    for (const pair of run.pairs ?? []) cases.add(stable([roles, pair.caseId]));
  }
  const possible = 2n ** BigInt(businessRoles.length),
    count = BigInt(observed.size);
  return {
    roleDomain: businessRoles,
    possibleSubsets: possible.toString(),
    observedSubsets: observed.size,
    unobservedSubsets: (possible - count).toString(),
    observedSubsetCases: cases.size,
    excludedRuns: excluded.length,
    observedSubsetsComplete: count === possible,
    nativeCoverageComplete: false,
    limitations: [
      'Subset presence does not qualify every permission graph, actor, data state, CRUD right, query shape or plugin configuration.',
    ],
  };
}
