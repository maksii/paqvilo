import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DataError } from './data-error.mjs';
import { ATTACHMENT_COLUMNS } from './dataverse-files.mjs';
import { fieldKind } from './dataverse-values.mjs';
import { isExactNumeric, stringifyExactJson } from './exact-numeric.mjs';
import { readRawBody } from './http-body.mjs';
import { parseExpand, parseSelect } from './odata-query.mjs';
import { collectPackExport } from './pack-exports.mjs';
import { packHandlerAnswer } from './pack-handler-answer.mjs';
import { siteSetting } from './redirects.mjs';
import { parseWebApiRoute, readWebApiSummaryCollection, readWebApiSummaryEntity } from './webapi-handler.mjs';

export const PORTAL_DATA_SUMMARY = '/_api/summarization/data/v1.0/';
const DEFAULT_CONTENT_LIMIT = 100_000;
const MAX_CONTENT_LIMIT = 1_000_000;
const MAX_SUMMARY_LENGTH = 8000;
// Local bounds on what a summary pack may suggest; the hosted count and length are not documented.
const MAX_RECOMMENDATIONS = 10;
const MAX_RECOMMENDATION_LENGTH = 500;
const CONTINUATION_VERSION = 1;
const inputError = (message) => new DataError(message, 400, 'InvalidDataSummaryRequest');
// The Web API's not-found codes of an entity read; a missing route segment keeps its own error.
const RECORD_NOT_FOUND = new Set(['0x80040217', 'ObjectDoesNotExist', 'NotFound']);
const continuationError = () =>
  new DataError('The recommendation configuration is not valid for this request.', 400, 'InvalidDataSummaryRequest');
const invalidResult = () =>
  new DataError('The local data summary provider returned an invalid summary.', 500, 'InvalidDataSummaryResult');

// One private continuation signing key per running store, as the Web API paging cursors have (webapi-handler pagingKey).
const continuationKeys = new WeakMap();
function continuationKey(store) {
  let key = continuationKeys.get(store);
  if (!key) {
    key = randomBytes(32);
    continuationKeys.set(store, key);
  }
  return key;
}

export const registerDataSummaryProvider = (packs) =>
  collectPackExport(packs ?? [], 'portalDataSummary').get('provider')?.value;

/**
 * The JSON request body. A first request may name a prompt setting (InstructionIdentifier); a follow-up passes a
 * returned recommendation's Config verbatim as RecommendationConfig, without InstructionIdentifier. An empty
 * RecommendationConfig is the documented placeholder of a first request. Hosted session F3 (summary-F3.md API-05d)
 * answered a request without InstructionIdentifier, and one naming a setting the site does not have, with a summary.
 */
export async function dataSummaryBody(req) {
  if (req.headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw inputError('Data summarization requires a JSON object.');
  const bytes = await readRawBody(req, {
    maximum: 16 * 1024,
    tooLarge: () => new DataError('The data summarization request exceeds 16 KiB.', 413, 'PayloadTooLarge'),
  });
  let body;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw inputError('Data summarization requires a JSON object.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw inputError('Data summarization requires a JSON object.');
  if (Object.keys(body).some((key) => key !== 'InstructionIdentifier' && key !== 'RecommendationConfig'))
    throw inputError('Data summarization received an unknown property.');
  const config = body.RecommendationConfig;
  if (Object.hasOwn(body, 'RecommendationConfig') && typeof config !== 'string')
    throw inputError('RecommendationConfig must be a string.');
  if (config) {
    if (Object.hasOwn(body, 'InstructionIdentifier'))
      throw inputError('Pass a RecommendationConfig without InstructionIdentifier.');
    return { config };
  }
  const identifier = body.InstructionIdentifier;
  if (identifier === undefined || identifier === null) return { identifier: null };
  if (typeof identifier !== 'string' || !/^Summarization\/prompt\/[^\r\n]+$/i.test(identifier))
    throw inputError('InstructionIdentifier names a Summarization/prompt setting.');
  return { identifier };
}

/**
 * The projection tree of one level: its explicit $select columns and each expansion's own tree. Every other option
 * ($filter, $orderby, $top, $count, nested $expand options) is evaluated by the portal Web API read itself.
 */
function selection(value) {
  const columns = parseSelect(value);
  if (!columns?.length)
    throw inputError('Data summarization requires an explicit $select on the entity and each expansion.');
  return [...new Set(columns)];
}

function projectionTree(select, specs) {
  const expansions = specs.map((spec) => ({
    navigation: spec.navigation,
    ...projectionTree(spec.select, spec.expand),
  }));
  if (expansions.length !== new Set(expansions.map((spec) => spec.navigation)).size)
    throw inputError('Specify each expansion once.');
  return { columns: selection(select), expansions };
}

function summaryRead(url) {
  const params = url.searchParams;
  if (params.size !== new Set(params.keys()).size) throw inputError('Specify each query option once.');
  const apply = params.has('$apply');
  // $apply rows are aggregates: their properties are the grouped columns and aggregate aliases, and $apply cannot be
  // combined with $select or $expand (the query engine refuses the combination).
  const tree = apply ? null : projectionTree(params.get('$select'), parseExpand(params.get('$expand')));
  const shadow = new URL(url);
  shadow.pathname = '/_api/' + url.pathname.slice(PORTAL_DATA_SUMMARY.length);
  return { shadow, tree };
}

function scalarValue(value) {
  if (isExactNumeric(value)) return stringifyExactJson(value);
  if (typeof value === 'string' && value.trim()) return value;
  return typeof value === 'boolean' || typeof value === 'number' ? value : undefined;
}

function valueFor(row, column, mapping, deps) {
  if (!Object.hasOwn(row, column)) return undefined;
  const physical = /^_(.+)_value$/.exec(column)?.[1] ?? column;
  const { store, identity, metadata } = deps;
  const definition = store.fieldDefinition(mapping.logicalName, physical, metadata);
  if (physical === ATTACHMENT_COLUMNS[mapping.logicalName] || fieldKind(definition) === 'file') return undefined;
  if (
    store.portalAuthorization?.canReadRawColumn(identity, mapping.logicalName, physical, row[mapping.idColumn]) ===
    false
  )
    return undefined;
  return scalarValue(row[column]);
}

const define = (target, name, value) => Object.defineProperty(target, name, { value, enumerable: true });

function recordValues(row, tree, mapping, deps) {
  const values = {};
  for (const column of tree.columns) {
    const value = valueFor(row, column, mapping, deps);
    if (value !== undefined) define(values, column, value);
  }
  for (const expansion of tree.expansions) {
    if (!Object.hasOwn(row, expansion.navigation)) continue;
    const value = expandedValues(row[expansion.navigation], expansion, mapping, deps);
    if (value !== undefined) define(values, expansion.navigation, value);
  }
  return values;
}

function expandedValues(value, expansion, mapping, deps) {
  if (!value || !Object.hasOwn(mapping.relationships ?? {}, expansion.navigation)) return undefined;
  const related = deps.store.resolveMapping(mapping.relationships[expansion.navigation].entity);
  const many = Array.isArray(value);
  const rows = (many ? value : [value])
    .map((row) => recordValues(row, expansion, related, deps))
    .filter((row) => Object.keys(row).length);
  if (!rows.length) return undefined;
  return many ? rows : rows[0];
}

/** An aggregate row of $apply: its scalar properties, without OData annotations. */
function aggregateValues(row) {
  const values = {};
  for (const [name, raw] of Object.entries(row)) {
    if (name.includes('@')) continue;
    const value = scalarValue(raw);
    if (value !== undefined) define(values, name, value);
  }
  return values;
}

function assertDataSummaryLength(content, empty, portal) {
  const configured = Number(siteSetting(portal, 'Summarization/Data/ContentSizeLimit'));
  const limit = Number.isSafeInteger(configured) && configured > 0 ? configured : DEFAULT_CONTENT_LIMIT;
  if (JSON.stringify(content).length > Math.min(limit, MAX_CONTENT_LIMIT))
    throw new DataError('Content length exceeds the limit.', 400, '90041004');
  if (empty) throw new DataError('No records found to summarize.', 400, '90041005');
}

/** Canonical form of the summarized query: the route and every query option, sorted, as the continuation binds it. */
function queryBinding(url) {
  const params = [...url.searchParams.entries()].sort(([a, av], [b, bv]) => a.localeCompare(b) || av.localeCompare(bv));
  return JSON.stringify({ path: url.pathname, params });
}

// The signature covers the payload, the visitor and the canonical query, so a value replays only where it was issued.
const sign = (scope, payload) =>
  createHmac('sha256', scope.key).update([payload, scope.visitor, scope.query].join('\u0000')).digest();

/** A Mirage-signed opaque continuation: it carries only the prompt setting name and the recommendation text. */
function continuationToken(scope, identifier, text) {
  const payload = Buffer.from(JSON.stringify({ v: CONTINUATION_VERSION, i: identifier, t: text })).toString(
    'base64url',
  );
  return `${payload}.${sign(scope, payload).toString('base64url')}`;
}

function readContinuation(token, scope) {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts.every((part) => /^[\w-]+$/.test(part))) throw continuationError();
  const [payload, signature] = parts;
  const expected = sign(scope, payload);
  const actual = Buffer.from(signature, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw continuationError();
  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    throw continuationError();
  }
  if (data?.v !== CONTINUATION_VERSION || (typeof data.i !== 'string' && data.i !== null) || typeof data.t !== 'string')
    throw continuationError();
  return { identifier: data.i, recommendation: data.t };
}

/**
 * The authorized summary source of one request. A continuation is verified against this visitor and this exact query
 * before any read, and it carries no data or grant: the record is read again with the visitor's current permissions.
 */
export async function dataSummarySource(url, request, deps) {
  // Copilot hub governance decides before the site's own switch; it is not exported, so it is an observed setting.
  if (deps.portal?.observed?.siteUserGenerativeAi === 'disabled')
    throw new DataError('Generative AI features are disabled', 400, '90041001');
  if (String(siteSetting(deps.portal, 'Summarization/Data/Enable')).trim().toLowerCase() !== 'true')
    throw new DataError(
      'Data summarization disabled for this site. Please enable using site setting.',
      400,
      '90041003',
    );
  const scope = {
    key: continuationKey(deps.store),
    visitor: String(deps.visitor ?? ''),
    query: queryBinding(url),
  };
  const { identifier, recommendation } = request.config
    ? readContinuation(request.config, scope)
    : { identifier: request.identifier };
  // A request without a prompt setting, or naming one the site does not have, is summarized without a prompt.
  const configured = identifier ? siteSetting(deps.portal, identifier) : null;
  const prompt = typeof configured === 'string' && configured.trim() ? configured : null;
  const { shadow, tree } = summaryRead(url);
  const input = (table, content) => ({
    table,
    instructionIdentifier: identifier,
    prompt,
    ...(recommendation === undefined ? {} : { recommendation }),
    ...content,
  });
  if (parseWebApiRoute(shadow.pathname).kind === 'entity') {
    if (!tree) throw inputError('$apply aggregates an entity set, not a single record.');
    try {
      return await readWebApiSummaryEntity(shadow, deps, (body, mapping) => {
        const record = recordValues(body, tree, mapping, deps);
        assertDataSummaryLength(record, !Object.keys(record).length, deps.portal);
        return { input: input(mapping.logicalName, { record }), scope };
      });
    } catch (error) {
      // A missing row answers 404 9004010D (captured), not the Web API's own not-found error.
      if (error?.status === 404 && RECORD_NOT_FOUND.has(String(error.code)))
        throw new DataError('Common Data Service error occurred.', 404, '9004010D');
      throw error;
    }
  }
  return readWebApiSummaryCollection(
    shadow,
    deps,
    (rows, mapping, { apply }) => {
      const records = rows
        .map((row) => (apply ? aggregateValues(row) : recordValues(row, tree, mapping, deps)))
        .filter((row) => Object.keys(row).length);
      assertDataSummaryLength(records, !records.length, deps.portal);
      return { input: input(mapping.logicalName, { records }), scope };
    },
    { prefer: deps.prefer },
  );
}

function recommendationTexts(answer) {
  const list = answer.recommendations ?? [];
  if (!Array.isArray(list) || list.length > MAX_RECOMMENDATIONS) throw invalidResult();
  return list.map((item) => {
    const text = typeof item === 'string' ? item : item?.text;
    if (typeof text !== 'string' || !text.trim() || text.length > MAX_RECOMMENDATION_LENGTH) throw invalidResult();
    return text;
  });
}

/** Ask the explicitly registered local pack (the AI stand-in) for the summary, then sign each suggested follow-up. */
export async function summarizeData(provider, { input, scope }) {
  let answer;
  try {
    answer = await packHandlerAnswer({ kind: 'portalDataSummary', name: input.table, usable: () => true }, () =>
      provider(input),
    );
  } catch (error) {
    if (error?.code === 'PackHandlerTimeout') throw error;
    throw new DataError('Error occurred while summarizing the content.', 400, '90041006');
  }
  if (typeof answer?.summary !== 'string' || answer.summary.length > MAX_SUMMARY_LENGTH) throw invalidResult();
  return {
    Summary: answer.summary,
    Recommendations: recommendationTexts(answer).map((text) => ({
      Text: text,
      Config: continuationToken(scope, input.instructionIdentifier, text),
    })),
  };
}
