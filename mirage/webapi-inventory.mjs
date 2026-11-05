#!/usr/bin/env node
import { stripLastLineQuery } from './lib/strip-last-line-query.mjs';
import { reportCliError } from './cli-output.mjs';
// Static inventory of portal Web API (/_api) request shapes and FetchXML
// features, compared with what the local Dataverse implementation supports.
// Reads exported sources only; never contacts a portal.
import { parseToolArgs, toolOptionsHelp, inventoryInputs } from './tool-options.mjs';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { importPortal } from './lib/importer.mjs';
import { importSolutionData } from './lib/solution-data.mjs';
import { inventoryPortalQueries } from './query-inventory.mjs';
import {
  FETCH_AGGREGATES,
  FETCH_DATE_GROUPINGS,
  FETCH_LINK_TYPES,
  FETCH_NO_OP_ATTRIBUTES,
  FETCH_SCHEMA,
  FETCH_UNSUPPORTED_ATTRIBUTES,
  parseXmlDocument,
  planFetch,
} from './lib/fetchxml-engine.mjs';
import { CRM_FUNCTIONS, FETCH_OPERATORS, UNSUPPORTED_FETCH_OPERATORS } from './lib/dataverse-conditions.mjs';
import {
  ODATA_APPLY_METHODS,
  ODATA_COMPARISON,
  ODATA_QUERY_OPTIONS,
  ODATA_STRING_FUNCTIONS,
  parseApply,
  parseExpand,
  parseODataExpression,
  parseOrderBy,
  parseSelect,
} from './lib/odata-query.mjs';
import { WEBAPI_ANNOTATIONS, WEBAPI_HEADERS, WEBAPI_PREFERENCES, WEBAPI_ROUTES } from './lib/webapi-capabilities.mjs';

const PLACEHOLDER = '⟦dyn⟧';
const TEXT_EXTENSIONS = /\.(?:js|mjs|css|html?|json|txt|xml|liquid|svg)$/i;

const count = (map, key, by = 1) => map.set(key, (map.get(key) ?? 0) + by);
const sorted = (map) =>
  Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));

async function readText(file) {
  try {
    const bytes = await fs.readFile(file);
    if (bytes.subarray(0, 8192).includes(0)) return null;
    return bytes.toString('utf8');
  } catch {
    return null;
  }
}

/** Every authored text source the importer can see, across languages and formats. */
function* recordTextCandidates(record, suffixes) {
  if (record.kind === 'webfile') return;
  if (record._file && /\.ya?ml$/i.test(record._file)) {
    const stem = record._file.replace(/\.ya?ml$/i, '');
    for (const [suffix, field] of suffixes)
      yield {
        readFile: `${stem}.${suffix}`,
        kind: `${record.kind}:${field}`,
        name: record.name,
        file: `${stem}.${suffix}`,
      };
  }
  for (const [key, value] of Object.entries(record)) {
    if (key.startsWith('_') || typeof value !== 'string') continue;
    if (/\/_api\/|<fetch\b|fetchxml|odata/i.test(value))
      yield { kind: `${record.kind}:${key}`, name: record.name, file: record._file, text: value };
  }
}

function* recordCandidates(portal, suffixes) {
  for (const record of portal.records) yield* recordTextCandidates(record, suffixes);
}

function* webFileCandidates(portal) {
  for (const file of portal.webFiles) {
    const mime = String(file.mimeType ?? '');
    // Inventory classification, not a URL/sanitization allowlist: font and binary
    // subtypes occur under both font/* and application/* media types.
    if ((/^image\//i.test(mime) || /font|octet-stream|pdf|zip/i.test(mime)) && !/svg/i.test(mime)) continue;
    if (path.extname(file.file) && !TEXT_EXTENSIONS.test(file.file) && !/text|javascript|json|xml|html/i.test(mime))
      continue;
    yield { readFile: file.file, kind: 'webfile', name: file.name, file: file.file };
  }
}

function* sourceCandidates(portal, suffixes) {
  yield* recordCandidates(portal, suffixes);
  yield* webFileCandidates(portal);
}

async function collectSources(portal, root) {
  const sources = [];
  const seen = new Set();
  const add = (kind, name, file, text) => {
    if (typeof text !== 'string' || !text.trim()) return;
    const digest = createHash('sha256').update(text).digest('hex');
    const key = `${kind}\u0000${file ?? name}\u0000${digest}`;
    if (seen.has(key)) return;
    seen.add(key);
    sources.push({
      kind,
      name: name ?? '',
      file: file ? path.relative(root, file).replaceAll(path.sep, '/') : null,
      text,
    });
  };
  const suffixes = [
    ['custom_javascript.js', 'javascript'],
    ['copy.html', 'copy'],
    ['value.html', 'value'],
    ['source.html', 'source'],
    ['summary.html', 'summary'],
  ];
  for (const candidate of sourceCandidates(portal, suffixes)) {
    if (candidate.readFile !== undefined) {
      const text = await readText(candidate.readFile);
      if (text != null) add(candidate.kind, candidate.name, candidate.file, text);
    } else add(candidate.kind, candidate.name, candidate.file, candidate.text);
  }
  return sources;
}

/** Read a JS string literal starting at `start` (a quote character). */
function templateExpressionEnd(text, index) {
  let depth = 1,
    cursor = index + 2;
  while (cursor < text.length && depth) {
    if (text[cursor] === '{') depth++;
    else if (text[cursor] === '}') depth--;
    cursor++;
  }
  return cursor;
}

function readLiteral(text, start) {
  const quote = text[start];
  let out = '';
  let index = start + 1;
  while (index < text.length) {
    const c = text[index];
    if (c === '\\') {
      out += text[index + 1] ?? '';
      index += 2;
      continue;
    }
    if (c === quote) return { value: out, end: index + 1 };
    if (quote !== '`' && c === '\n') return { value: out, end: index };
    if (quote === '`' && c === '$' && text[index + 1] === '{') {
      out += PLACEHOLDER;
      index = templateExpressionEnd(text, index);
      continue;
    }
    out += c;
    index++;
  }
  return { value: out, end: index };
}

function expressionEnd(text, index) {
  let depth = 0,
    cursor = index;
  while (cursor < text.length) {
    const ch = text[cursor];
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) {
      if (!depth) break;
      depth--;
    } else if (depth === 0 && (ch === '+' || ch === ',' || ch === ';' || ch === '\n')) break;
    cursor++;
  }
  return cursor;
}

/** Extend a literal through `+ expr + 'literal'` concatenations on the same statement. */
function readConcatenation(text, end) {
  let value = '';
  let index = end;
  for (let guard = 0; guard < 50; guard++) {
    const rest = /^\s*\+\s*/.exec(text.slice(index, index + 200));
    if (!rest) break;
    index += rest[0].length;
    const c = text[index];
    if (c === "'" || c === '"' || c === '`') {
      const literal = readLiteral(text, index);
      value += literal.value;
      index = literal.end;
      continue;
    }
    value += PLACEHOLDER;
    index = expressionEnd(text, index);
  }
  return value;
}

/** Locate /_api expressions with their literal URL template text. */
function findApiLiteralStart(text, at) {
  for (let i = at - 1; i >= 0 && at - i < 4000; i--) {
    const c = text[i];
    if ((c === "'" || c === '"') && text[i - 1] !== '\\') {
      const lineBreak = text.lastIndexOf('\n', at);
      return i > lineBreak ? i : -1;
    }
    if (c === '`' && text[i - 1] !== '\\') return i;
    if (c === '\n' && !text.slice(Math.max(0, i - 4000), i).includes('`')) break;
  }
  return -1;
}

function replaceDelimited(text, open, close, replacement, standalone = false) {
  const parts = [];
  let cursor = 0;
  let search = 0;
  while (search < text.length) {
    const start = text.indexOf(open, search);
    if (start < 0) break;
    if (standalone && (start === 0 || !/\s/.test(text[start - 1]))) {
      search = start + 1;
      continue;
    }
    let end = text.indexOf(close, start + open.length);
    while (standalone && end >= 0 && !/[\s/>]/.test(text[end + close.length] ?? '')) end = text.indexOf(close, end + 1);
    if (end < 0) break;
    parts.push(text.slice(cursor, start), replacement);
    cursor = end + close.length;
    search = cursor;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function normalizeApiUrl(url) {
  return replaceDelimited(replaceDelimited(url, '{{', '}}', PLACEHOLDER), '{%', '%}', '')
    .replace(/\{\d+\}/g, PLACEHOLDER)
    .trim();
}

function extractApiExpressions(text) {
  const results = [];
  const pattern = /\/_api\/[A-Za-z_]/g;
  let match;
  while ((match = pattern.exec(text))) {
    const at = match.index;
    const start = findApiLiteralStart(text, at);
    let url;
    if (start >= 0) {
      const literal = readLiteral(text, start);
      if (literal.end <= at) continue;
      const fromApi = literal.value.indexOf('/_api/');
      url = literal.value.slice(Math.max(fromApi, 0)) + readConcatenation(text, literal.end);
    } else {
      // Unquoted snippet/template URL text keeps OData string quotes, spaces and
      // inline FetchXML; it ends at a line break, double quote or backtick.
      const tail = /^[^"`\r\n]+/.exec(text.slice(at));
      url = tail ? tail[0] : '/_api/';
    }
    results.push({ index: at, url: normalizeApiUrl(url) });
    pattern.lastIndex = at + 6;
  }
  return results;
}

/** Split a query string into raw name/value pairs without breaking FetchXML values. */
function splitQuery(query) {
  const positions = [];
  const pattern = /(?:^|&)([$@]?[A-Za-z][\w.]*)=/g;
  let match;
  while ((match = pattern.exec(query)))
    positions.push({ name: match[1], start: match.index, valueStart: pattern.lastIndex });
  const params = [];
  positions.forEach((item, index) => {
    if (item.name.toLowerCase() === 'fetchxml') {
      params.push({ name: item.name, value: query.slice(item.valueStart) });
      positions.length = index + 1;
      return;
    }
    const end = positions[index + 1]?.start ?? query.length;
    params.push({ name: item.name, value: query.slice(item.valueStart, end) });
  });
  return params;
}
const decode = (value) => {
  try {
    return /%[\da-f]{2}/i.test(value) ? decodeURIComponent(value) : value;
  } catch {
    return value;
  }
};

/** Replace dynamic parts with type-appropriate stand-ins so syntax can be checked. */
function concreteFilter(text, emptyDynamic = false) {
  return text
    .replace(new RegExp(`'([^']*)${PLACEHOLDER}([^']*)'`, 'g'), "'$1X$2'")
    .replace(new RegExp(`'${PLACEHOLDER}'`, 'g'), "'X'")
    .replace(
      new RegExp(String.raw`(\b(?:eq|ne|gt|ge|lt|le)\s+)${PLACEHOLDER}`, 'g'),
      '$100000000-0000-0000-0000-000000000000',
    )
    .replaceAll(new RegExp(PLACEHOLDER, 'g'), emptyDynamic ? '' : '00000000-0000-0000-0000-000000000000');
}
function concreteFetch(text) {
  const tagsRemoved = replaceDelimited(text, '{%', '%}', '');
  const attributesRemoved = replaceDelimited(tagsRemoved, '{{', '}}', '', true);
  const outputsRemoved = replaceDelimited(attributesRemoved, '{{', '}}', PLACEHOLDER);
  const expressionsRemoved = replaceDelimited(outputsRemoved, '${', '}', PLACEHOLDER).replace(/\{\d+\}/g, PLACEHOLDER);
  return replaceDelimited(expressionsRemoved, '<!--', '-->', '');
}
const dynamicValue = (value) => (String(value).includes(PLACEHOLDER) ? '(dynamic)' : value);

function walkFetch(node, visit, parent = null) {
  visit(node, parent);
  for (const child of node.children ?? []) walkFetch(child, visit, node);
}

function addFetchFeature(features, origins, origin, key) {
  count(features, key);
  if (!origins.has(key)) origins.set(key, new Set());
  origins.get(key).add(origin);
}

function recordFetchAttributeFeature(node, key, value, features, origins, origin) {
  if (node.name === 'condition' && key === 'operator')
    addFetchFeature(features, origins, origin, `fetchxml.operator.${dynamicValue(value)}`);
  if (node.name === 'link-entity' && key === 'link-type')
    addFetchFeature(features, origins, origin, `fetchxml.link-type.${dynamicValue(value)}`);
  if (node.name === 'attribute' && key === 'aggregate')
    addFetchFeature(features, origins, origin, `fetchxml.aggregate.${dynamicValue(value)}`);
  if (node.name === 'attribute' && key === 'dategrouping')
    addFetchFeature(features, origins, origin, `fetchxml.dategrouping.${dynamicValue(value)}`);
  if (
    node.name === 'fetch' &&
    ['distinct', 'aggregate', 'no-lock', 'latematerialize', 'returntotalrecordcount', 'useraworderby'].includes(key) &&
    /^(?:true|1)$/i.test(value)
  )
    addFetchFeature(features, origins, origin, `fetchxml.flag.${key}`);
}

function recordFetchAttributes(node, features, origins, origin) {
  for (const [key, value] of Object.entries(node.attrs)) {
    addFetchFeature(features, origins, origin, `fetchxml.attribute.${node.name}@${key}`);
    recordFetchAttributeFeature(node, key, value, features, origins, origin);
  }
}

function recordLinkPatterns(node, parent, features, origins, origin) {
  if (node.name === 'link-entity' && !node.attrs['link-type'])
    addFetchFeature(features, origins, origin, 'fetchxml.link-type.inner(default)');
  if (node.name === 'link-entity' && parent?.name === 'filter')
    addFetchFeature(features, origins, origin, 'fetchxml.pattern.link-entity-in-filter');
  if (node.name === 'link-entity' && (!node.attrs.from || !node.attrs.to))
    addFetchFeature(features, origins, origin, 'fetchxml.pattern.link-without-from-to');
  if (
    node.name === 'link-entity' &&
    parent?.name === 'link-entity' &&
    (parent.attrs['link-type'] ?? 'inner') === 'outer' &&
    (node.attrs['link-type'] ?? 'inner') === 'inner'
  )
    addFetchFeature(features, origins, origin, 'fetchxml.pattern.inner-link-under-outer-link');
}

function recordConditionPatterns(node, features, origins, origin) {
  if (node.name === 'condition' && node.attrs.entityname)
    addFetchFeature(features, origins, origin, 'fetchxml.pattern.condition-entityname');
  if (node.name === 'condition' && node.attrs.valueof)
    addFetchFeature(
      features,
      origins,
      origin,
      `fetchxml.pattern.condition-valueof${node.attrs.valueof.includes('.') ? '-cross-table' : ''}`,
    );
  if (node.name === 'condition' && node.children.some((child) => child.name === 'value'))
    addFetchFeature(features, origins, origin, 'fetchxml.pattern.condition-value-elements');
}

function recordOrderPatterns(node, parent, features, origins, origin) {
  if (node.name === 'order' && node.attrs.entityname)
    addFetchFeature(features, origins, origin, 'fetchxml.pattern.order-entityname');
  if (node.name === 'order' && parent?.name === 'link-entity')
    addFetchFeature(features, origins, origin, 'fetchxml.pattern.order-on-link-entity');
}

function recordFetchPagingPattern(node, features, origins, origin) {
  if (node.name === 'fetch' && node.attrs.top && (node.attrs.count || node.attrs.page))
    addFetchFeature(features, origins, origin, 'fetchxml.pattern.top-with-paging');
}

function recordFetchPatterns(node, parent, features, origins, origin) {
  recordLinkPatterns(node, parent, features, origins, origin);
  recordConditionPatterns(node, features, origins, origin);
  recordOrderPatterns(node, parent, features, origins, origin);
  recordFetchPagingPattern(node, features, origins, origin);
}

function recordFetchNode(node, parent, features, origins, origin) {
  addFetchFeature(features, origins, origin, `fetchxml.element.${node.name}`);
  recordFetchAttributes(node, features, origins, origin);
  recordFetchPatterns(node, parent, features, origins, origin);
}

function recordFallbackAttribute(name, attr, features, origins, origin) {
  addFetchFeature(features, origins, origin, `fetchxml.attribute.${name}@${attr[1]}`);
  if (name === 'condition' && attr[1] === 'operator')
    addFetchFeature(features, origins, origin, `fetchxml.operator.${dynamicValue(attr[3])}`);
  if (name === 'link-entity' && attr[1] === 'link-type')
    addFetchFeature(features, origins, origin, `fetchxml.link-type.${dynamicValue(attr[3])}`);
  if (name === 'attribute' && attr[1] === 'aggregate')
    addFetchFeature(features, origins, origin, `fetchxml.aggregate.${dynamicValue(attr[3])}`);
}

function scanFetchFallback(text, features, origins, origin) {
  for (const tag of text.matchAll(/<([a-z][\w-]*)\b([^<>]*?)\/?>/gi)) {
    const name = tag[1].toLowerCase();
    if (!FETCH_SCHEMA[name] && !['no-attrs'].includes(name)) continue;
    addFetchFeature(features, origins, origin, `fetchxml.element.${name}`);
    for (const attr of tag[2].matchAll(/(?<![\w:-])([\w:-]+)\s*=\s*(["'])((?:(?!\2)[\s\S])*)\2/g))
      recordFallbackAttribute(name, attr, features, origins, origin);
  }
}

/** FetchXML feature counts from a parsed tree (or a tolerant tag scan as fallback). */
function fetchFeatures(xml, features, origin, origins) {
  const text = concreteFetch(xml);
  let tree;
  try {
    tree = parseXmlDocument(text, { root: 'fetch' });
  } catch {
    tree = null;
  }
  if (tree) {
    walkFetch(tree, (node, parent) => recordFetchNode(node, parent, features, origins, origin));
    return { parsed: true, tree, text };
  }
  scanFetchFallback(text, features, origins, origin);
  return { parsed: false, origin, text };
}
function scanFilterFunctions(value, add) {
  for (const fn of value.replace(/'(?:[^']|'')*'/g, "''").matchAll(/(?<![\w/.])([A-Za-z_][\w.]*)\s*\(/g)) {
    const id = fn[1];
    if (/^(?:and|or|not|eq|ne|gt|ge|lt|le|in)$/i.test(id)) continue;
    if (/^Microsoft\.Dynamics\.CRM\./i.test(id)) add(`odata.crm-function.${id.split('.').at(-1)}`);
    else if (!['and', 'or', 'not'].includes(id.toLowerCase())) add(`odata.function.${id.toLowerCase()}`);
  }
}

function scanFilterPatterns(value, add) {
  for (const lambda of value.matchAll(/\/(any|all)\s*\(/gi)) add(`odata.lambda.${lambda[1].toLowerCase()}`);
  for (const op of concreteFilter(value)
    .replace(/'(?:[^']|'')*'/g, "''")
    .matchAll(/\b(eq|ne|gt|ge|lt|le|in|has|and|or|not)\b/gi))
    add(`odata.operator.${op[1].toLowerCase()}`);
  if (/\w\/\w/.test(value.replace(/'(?:[^']|'')*'/g, "''"))) add('odata.pattern.navigation-path');
  if (/'[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}'/i.test(value)) add('odata.pattern.quoted-guid');
  if (/\b[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\b(?!')/i.test(value.replace(/'(?:[^']|'')*'/g, "''")))
    add('odata.pattern.unquoted-guid');
  if (/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/.test(value)) add('odata.pattern.datetime-literal');
}

function analyzeFilter(value, aliases, failures, context, add) {
  scanFilterFunctions(value, add);
  scanFilterPatterns(value, add);
  checkSyntax(
    () => parseODataExpression(concreteFilter(value), { dialect: 'dataverse', aliases }),
    () => parseODataExpression(concreteFilter(value, true), { dialect: 'dataverse', aliases }),
    '$filter',
    value,
    failures,
    context,
  );
}

function analyzeSelect(value, failures, context, add) {
  for (const item of value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean))
    if (/^_.+_value$/.test(item)) add('odata.pattern.select-lookup-value');
  checkSyntax(() => parseSelect(value.replaceAll(PLACEHOLDER, 'x')), null, '$select', value, failures, context);
}

function visitExpandSpecs(list, depth, failures, context, add) {
  for (const spec of list) {
    add(depth ? 'odata.pattern.nested-expand' : 'odata.pattern.expand');
    for (const option of ['select', 'filter', 'orderby', 'top'])
      if (spec[option] != null) add(`odata.expand-option.$${option}`);
    if (spec.filter)
      checkSyntax(
        () => parseODataExpression(spec.filter, { dialect: 'dataverse' }),
        null,
        '$expand/$filter',
        spec.filter,
        failures,
        context,
      );
    visitExpandSpecs(spec.expand ?? [], depth + 1, failures, context, add);
  }
}

function analyzeExpand(value, failures, context, add) {
  try {
    visitExpandSpecs(parseExpand(concreteFilter(value)), 0, failures, context, add);
  } catch (error) {
    failures.push({
      ...context,
      option: '$expand',
      text: value.slice(0, 300),
      error: error.message,
      dynamic: value.includes(PLACEHOLDER),
    });
  }
}

function analyzeOrderBy(value, failures, context) {
  checkSyntax(
    () => parseOrderBy(value.replaceAll(PLACEHOLDER, 'x'), { dialect: 'dataverse' }),
    null,
    '$orderby',
    value,
    failures,
    context,
  );
}

function analyzeApply(value, aliases, failures, context, add) {
  for (const transform of value.matchAll(/\b(filter|groupby|aggregate)\(/gi))
    add(`odata.apply.${transform[1].toLowerCase()}`);
  for (const method of value.matchAll(/\bwith\s+([a-z]+)/gi)) add(`odata.apply-method.${method[1].toLowerCase()}`);
  if (/\$count\s+as/i.test(value)) add('odata.apply-method.$count');
  checkSyntax(
    () => parseApply(concreteFilter(value), { dialect: 'dataverse', aliases }),
    () => parseApply(concreteFilter(value, true), { dialect: 'dataverse', aliases }),
    '$apply',
    value,
    failures,
    context,
  );
}

function analyzeODataParameter(name, value, aliases, features, failures, context) {
  const add = (key) => count(features, key);
  add(`odata.option.${name}`);
  if (name === '$filter') analyzeFilter(value, aliases, failures, context, add);
  if (name === '$select') analyzeSelect(value, failures, context, add);
  if (name === '$expand') analyzeExpand(value, failures, context, add);
  if (name === '$orderby') analyzeOrderBy(value, failures, context);
  if (name === '$apply') analyzeApply(value, aliases, failures, context, add);
  if (name.toLowerCase() === 'fetchxml') {
    add('odata.fetchxml');
    context.fetchXml.push(value);
  }
}

function oDataFeatures(params, features, failures, context) {
  const aliases = Object.fromEntries(
    params.filter((item) => item.name.startsWith('@')).map((item) => [item.name, concreteFilter(decode(item.value))]),
  );
  for (const { name, value: raw } of params)
    analyzeODataParameter(name, decode(raw), aliases, features, failures, context);
}
function checkSyntax(primary, fallback, option, text, failures, context) {
  try {
    primary();
  } catch (error) {
    if (fallback) {
      try {
        fallback();
        return;
      } catch {
        // report the first error below
      }
    }
    // Snippet templates are often prefixes completed by JavaScript concatenation.
    const fragment =
      /\b(?:eq|ne|gt|ge|lt|le|and|or)\s*$/i.test(text.trim()) ||
      (text.match(/\(/g)?.length ?? 0) > (text.match(/\)/g)?.length ?? 0);
    failures.push({
      ...context,
      option,
      text: text.slice(0, 400),
      error: error.message,
      dynamic: text.includes(PLACEHOLDER) || fragment,
    });
  }
}

function classifyCollectionShape(segments) {
  if (!segments.length) return 'collection';
  if (segments[0] === '$count') return 'collection/$count';
  return `other:${segments.join('/')}`;
}

function classifyEntityShape(key, segments) {
  if (!segments.length) return /=/.test(key) ? 'entity(alternate-key)' : 'entity';
  if (segments.at(-1) === '$ref')
    return segments.length === 2 && /\(/.test(segments[0]) ? 'entity/navigation(key)/$ref' : 'entity/navigation/$ref';
  if (segments.at(-1) === '$value') return 'entity/property/$value';
  if (segments.length === 1) return 'entity/property-or-navigation';
  return `other:${segments.join('/')}`;
}

function classifyRouteShape(entitySet, key, segments) {
  if (entitySet === 'cloudflow') return 'cloudflow';
  if (!key) return classifyCollectionShape(segments);
  return classifyEntityShape(key, segments);
}

function routeShape(pathText) {
  const clean = stripLastLineQuery(pathText);
  const match = /^\/_api\/([A-Za-z_]\w*)(\([^)]*\))?((?:\/[^/]+)*)$/.exec(clean);
  if (!match) return { entitySet: null, shape: 'unparsed' };
  const [, entitySet, key, rest] = match;
  const segments = rest.split('/').filter(Boolean);
  return { entitySet, shape: classifyRouteShape(entitySet, key, segments) };
}

/**
 * Methods called on a site's own Web API client objects: `clientWrappers` names them (for
 * example --client-wrapper App.WebApi counts App.WebApi._get / App.WebApi.post as GET / POST).
 * No project's wrapper is built in.
 */
const escapeRegExp = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
const wrapperPattern = (name) => new RegExp(String.raw`${escapeRegExp(name)}\._?(get|post|patch|put|delete)\b`, 'gi');
function scanPreferences(text, add) {
  for (const match of text.matchAll(/["']?Prefer["']?\s*[:,]\s*(?:\([^)]*\)\s*\?\s*)?([`"'])([\s\S]*?)\1/gi)) {
    const value = match[2];
    if (/maxpagesize/i.test(value)) add('header.prefer.odata.maxpagesize');
    if (/include-annotations/i.test(value))
      add(`header.prefer.odata.include-annotations=${/\*/.test(value) ? '*' : 'list'}`);
    if (/return=representation/i.test(value)) add('header.prefer.return=representation');
  }
}

function scanKnownHeaders(text, features) {
  const headers = [
    ['If-Match', /["']If-Match["']/gi],
    ['If-None-Match', /["']If-None-Match["']/gi],
    ['MSCRM.SuppressDuplicateDetection', /MSCRM\.SuppressDuplicateDetection/gi],
    ['MSCRM.BypassCustomPluginExecution', /MSCRM\.BypassCustomPluginExecution/gi],
    ['OData-MaxVersion', /OData-MaxVersion/gi],
    ['OData-Version', /["']OData-Version["']/gi],
    ['X-HTTP-Method', /X-HTTP-Method/gi],
    ['__RequestVerificationToken', /__RequestVerificationToken/g],
    ['X-Requested-With', /X-Requested-With/gi],
  ];
  for (const [name, pattern] of headers) {
    const hits = text.match(pattern)?.length ?? 0;
    if (hits) count(features, `header.${name}`, hits);
  }
}

function scanAnnotations(text, add) {
  for (const match of text.matchAll(/@((?:OData\.Community\.Display\.V1|Microsoft\.Dynamics\.CRM)\.[A-Za-z]+)/g))
    add(`annotation.${match[1]}`);
  for (const match of text.matchAll(/@odata\.(bind|id|nextLink|count|etag|context|type)\b/g))
    add(`annotation.odata.${match[1]}`);
}

function scanPaging(text, add) {
  for (const match of text.matchAll(
    /\b(paging-cookie|paging_cookie|fetchxmlpagingcookie|morerecords|more_records|total_record_count|totalrecordcount)\b/g,
  ))
    add(`paging.${match[1]}`);
}

function scanMethods(text, add, clientWrappers) {
  for (const match of text.matchAll(/\b(?:type|method)\s*:\s*["'](GET|POST|PATCH|PUT|DELETE)["']/gi))
    add(`method.${match[1].toUpperCase()}`);
  for (const wrapper of clientWrappers)
    for (const match of text.matchAll(wrapperPattern(wrapper))) add(`method.${match[1].toUpperCase()}`);
}

function scanClientApis(text, features) {
  const safeAjax = text.match(/\bwebapi\.safeAjax\s*\(/g)?.length ?? 0;
  if (safeAjax) count(features, 'client.webapi.safeAjax', safeAjax);
  for (const match of text.matchAll(/\$pages\.webAPI\.(\w+)/g)) count(features, `client.$pages.webAPI.${match[1]}`);
}

function scanHeadersAndAnnotations(text, features, { clientWrappers = [] } = {}) {
  const add = (key) => count(features, key);
  scanPreferences(text, add);
  scanKnownHeaders(text, features);
  scanAnnotations(text, add);
  scanPaging(text, add);
  scanMethods(text, add, clientWrappers);
  scanClientApis(text, features);
}

function supportFetchAttribute(key, rest, origins) {
  const [element, attribute] = rest.split('@');
  if (!FETCH_SCHEMA[element]) return { supported: false, note: 'undeclared element' };
  if (FETCH_UNSUPPORTED_ATTRIBUTES[element]?.[attribute])
    return { supported: false, note: FETCH_UNSUPPORTED_ATTRIBUTES[element][attribute] };
  if (FETCH_SCHEMA[element].attributes.includes(attribute))
    return {
      supported: true,
      note: FETCH_NO_OP_ATTRIBUTES[element]?.includes(attribute) ? 'accepted; does not change results' : undefined,
    };
  // The portal re-serialises Liquid FetchXML through its object model, which drops unmodelled attributes.
  if ([...(origins.get(key) ?? [])].every((origin) => ['liquid', 'portal-metadata'].includes(origin)))
    return {
      supported: true,
      note: 'undeclared attribute in Liquid FetchXML: ignored by the portal model (diagnostic FETCHXML_ATTRIBUTE_IGNORED)',
    };
  return { supported: false, note: 'Dataverse rejects undeclared FetchXML attributes on the Web API' };
}

function supportFetchPattern(rest) {
  if (rest === 'link-without-from-to')
    return {
      supported: false,
      note: 'relationship inference without from/to is not implemented; Dataverse requires from/to for custom many-to-many',
    };
  if (rest === 'top-with-paging')
    return { supported: false, note: 'Dataverse documents top as incompatible with page/count' };
  return { supported: true };
}

function supportFetch(kind, rest, key, origins) {
  switch (kind) {
    case 'element':
      return FETCH_SCHEMA[rest] ? { supported: true } : { supported: false, note: 'undeclared FetchXML element' };
    case 'attribute':
      return supportFetchAttribute(key, rest, origins);
    case 'operator':
      if (UNSUPPORTED_FETCH_OPERATORS.has(rest))
        return { supported: false, note: UNSUPPORTED_FETCH_OPERATORS.get(rest) };
      return FETCH_OPERATORS.has(rest) ? { supported: true } : { supported: false, note: 'unknown operator' };
    case 'link-type':
      return FETCH_LINK_TYPES.has(rest.replace('(default)', '')) ? { supported: true } : { supported: false };
    case 'aggregate':
      return FETCH_AGGREGATES.has(rest) ? { supported: true } : { supported: false };
    case 'dategrouping':
      return FETCH_DATE_GROUPINGS.has(rest) ? { supported: true } : { supported: false };
    case 'flag':
      return { supported: true };
    case 'pattern':
      return supportFetchPattern(rest);
  }
}

function supportODataOption(rest) {
  if (rest.startsWith('@')) return { supported: true, note: 'parameter alias' };
  if (rest.toLowerCase() === 'fetchxml') return { supported: true };
  if (rest === '$skip') return { supported: false, note: 'the portal rejects $skip; follow @odata.nextLink' };
  if (rest === '$skiptoken') return { supported: true, note: 'local signed continuation' };
  return ODATA_QUERY_OPTIONS.has(rest) ? { supported: true } : { supported: false };
}

function supportCrmFunction(rest) {
  const entry = Object.entries(CRM_FUNCTIONS).find(([name]) => name.toLowerCase() === rest.toLowerCase());
  if (!entry) return { supported: false, note: 'unknown Dataverse query function' };
  if (entry[1].rejection)
    return {
      supported: false,
      note: `Dataverse answers ${entry[1].rejection.innerCode} unless the column is full-text indexed; local metadata has no full-text indexing`,
    };
  if (entry[1].unsupported) return { supported: false, note: entry[1].unsupported };
  return UNSUPPORTED_FETCH_OPERATORS.has(entry[1].operator)
    ? { supported: false, note: UNSUPPORTED_FETCH_OPERATORS.get(entry[1].operator) }
    : { supported: true };
}

function supportOData(kind, rest) {
  switch (kind) {
    case 'option':
      return supportODataOption(rest);
    case 'function':
      return ODATA_STRING_FUNCTIONS.has(rest)
        ? { supported: true }
        : { supported: false, note: 'not a documented Dataverse filter function' };
    case 'crm-function':
      return supportCrmFunction(rest);
    case 'operator':
      if (['and', 'or', 'not'].includes(rest) || ODATA_COMPARISON.has(rest)) return { supported: true };
      return { supported: false, note: 'Dataverse supports eq/ne/gt/ge/lt/le/and/or/not only' };
    case 'lambda':
      return { supported: true };
    case 'apply':
      return { supported: ['filter', 'groupby', 'aggregate'].includes(rest) };
    case 'apply-method':
      return rest === '$count' || ODATA_APPLY_METHODS.has(rest) ? { supported: true } : { supported: false };
    case 'expand-option':
    case 'pattern':
    case 'fetchxml':
      return { supported: true };
  }
}

function supportRoute(kind, restParts) {
  const shape = [kind, ...restParts].join('.');
  if (WEBAPI_ROUTES.has(shape)) return { supported: true };
  if (shape === 'cloudflow')
    return {
      supported: true,
      note: 'Power Automate flow triggers run server-side: an explicit simulator endpoint supplies a local response or live forwarding; unconfigured triggers return 501',
    };
  return {
    supported: true,
    note: 'not a documented Power Pages Web API route; the local handler returns the same 404/400 class as an unknown resource',
  };
}

function supportHeader(kind, rest, restParts) {
  if (kind === 'prefer')
    return WEBAPI_PREFERENCES.has(rest.replace(/=(?:\*|list)$/, '')) ? { supported: true } : { supported: false };
  return WEBAPI_HEADERS.has([kind, ...restParts].join('.')) ? { supported: true } : { supported: false };
}

/** Classify every observed feature against the implementation's capability tables. */
export function supportOf(key, origins = new Map()) {
  const [area, kind, ...restParts] = key.split('.');
  if (key.endsWith('(dynamic)'))
    return {
      supported: true,
      note: 'value assembled at runtime; the evaluator validates it against the supported set when the query executes',
    };
  const rest = restParts.join('.');
  if (area === 'fetchxml') return supportFetch(kind, rest, key, origins) ?? { supported: true };
  if (area === 'odata') return supportOData(kind, rest) ?? { supported: true };
  if (area === 'route') return supportRoute(kind, restParts);
  if (area === 'header') return supportHeader(kind, rest, restParts);
  if (area === 'annotation')
    return WEBAPI_ANNOTATIONS.has([kind, ...restParts].join('.')) ? { supported: true } : { supported: false };
  return { supported: true };
}

/** Build the inventory for one exported portal directory. */
function scanSourceApiRequests(source, state) {
  for (const expression of extractApiExpressions(source.text)) {
    const [pathText, query = ''] = expression.url.split(/\?(.*)/s);
    const { entitySet, shape } = routeShape(pathText);
    if (entitySet) count(state.entitySets, entitySet);
    count(state.routes, shape);
    count(state.features, `route.${shape}`);
    const context = { kind: source.kind, name: source.name, file: source.file, fetchXml: [] };
    const params = splitQuery(query);
    oDataFeatures(params, state.features, state.failures, context);
    state.requests.push({ file: source.file, entitySet, shape, options: params.map((p) => p.name) });
    for (const xml of context.fetchXml) state.fetchSources.push({ xml, origin: 'webapi', source });
  }
}

function scanSourceFetchXml(source, fetchSources) {
  // Liquid blocks and other FetchXML literals.
  const liquid = /\{%-?\s*fetchxml\b[^%]*%\}([\s\S]*?)\{%-?\s*endfetchxml\s*-?%\}/gi;
  const covered = [];
  for (const block of source.text.matchAll(liquid)) {
    fetchSources.push({ xml: block[1], origin: 'liquid', source });
    covered.push([block.index, block.index + block[0].length]);
  }
  for (const raw of source.text.matchAll(/<fetch\b[\s\S]*?<\/fetch>/gi)) {
    if (covered.some(([start, end]) => raw.index >= start && raw.index < end)) continue;
    const before = source.text.slice(Math.max(0, raw.index - 20), raw.index);
    if (/fetchxml=\s*$/i.test(before)) continue; // already analysed from the URL
    // Form/list metadata (lookup FilterCriteria, view definitions) is executed
    // by the portal itself; JSON-escaped YAML strings are unescaped first.
    const metadata =
      /metadata|basicform|advancedform|list|savedquery/i.test(source.kind) || /\.ya?ml$/i.test(source.file ?? '');
    // In a web template, FetchXML outside <script> is Liquid include content
    // rendered into a {% fetchxml %} block elsewhere, not a Web API string.
    const scripts = [...source.text.matchAll(/<script\b[\s\S]*?<\/script>/gi)].map((m) => [
      m.index,
      m.index + m[0].length,
    ]);
    const inScript = scripts.some(([start, end]) => raw.index >= start && raw.index < end);
    const liquidInclude = /webtemplate/i.test(source.kind) && !inScript;
    const xml = /\\"/.test(raw[0])
      ? raw[0]
          .replace(/\\r\\n|\\n|\\r/g, '\n')
          .replaceAll(String.raw`\t`, '\t')
          .replaceAll(String.raw`\"`, '"')
          .replaceAll('\\\\', '\\')
      : raw[0];
    let origin;
    if (liquidInclude) origin = 'liquid';
    else if (metadata) origin = 'portal-metadata';
    else origin = 'literal';
    fetchSources.push({ xml, origin, source });
  }
}

function scanInventorySources(sources, clientWrappers, state) {
  for (const source of sources) {
    scanHeadersAndAnnotations(source.text, state.features, { clientWrappers });
    scanSourceApiRequests(source, state);
    scanSourceFetchXml(source, state.fetchSources);
  }
}

function analyzeFetchSources(fetchSources, features, featureOrigins, failures, includeFetchXml) {
  let parsedFetch = 0;
  const fetchOrigins = new Map();
  const fetchBlocks = [];
  for (const item of fetchSources) {
    const xml = decode(item.xml);
    count(fetchOrigins, item.origin);
    const result = fetchFeatures(xml, features, item.origin, featureOrigins);
    if (!result.parsed) {
      failures.push({
        kind: item.source.kind,
        name: item.source.name,
        file: item.source.file,
        option: `fetchxml:${item.origin}`,
        text: xml.slice(0, 300),
        error: 'FetchXML is not well-formed after removing dynamic Liquid/JS parts',
        dynamic: true,
      });
      continue;
    }
    parsedFetch++;
    if (includeFetchXml)
      fetchBlocks.push({
        xml: result.text,
        origin: item.origin,
        file: item.source.file,
        dynamic: result.text.includes(PLACEHOLDER),
      });
    try {
      // FetchXML literals in JavaScript are sent through /_api?fetchXml= and
      // validated by Dataverse; Liquid blocks and form metadata run in the portal.
      planFetch(result.tree, {
        profile: ['webapi', 'literal'].includes(item.origin) ? 'webapi' : 'portal',
      });
    } catch (error) {
      failures.push({
        kind: item.source.kind,
        name: item.source.name,
        file: item.source.file,
        option: `fetchxml:${item.origin}`,
        text: xml.slice(0, 300),
        error: error.message,
        dynamic: result.text.includes(PLACEHOLDER),
      });
    }
  }
  return { parsedFetch, fetchOrigins, fetchBlocks };
}

function buildSolutionSummary(data, entitySets) {
  const sets = new Map(Object.entries(data.mappings).map(([logical, mapping]) => [mapping.entitySet, logical]));
  return {
    roots: data.roots,
    unknownEntitySets: Object.keys(sorted(entitySets)).filter(
      (set) => !sets.has(set) && !['cloudflow', 'EntityLists'].includes(set),
    ),
    knownEntitySets: [...entitySets.keys()].filter((set) => sets.has(set)).length,
  };
}

function buildFeatureMatrix(features, featureOrigins) {
  return [...features.entries()]
    .map(([feature, uses]) => ({
      feature,
      uses,
      ...supportOf(feature, featureOrigins),
      ...(featureOrigins.has(feature)
        ? { origins: [...featureOrigins.get(feature)].sort((a, b) => Number(a > b) - Number(a < b)) }
        : {}),
    }))
    .sort((a, b) => a.feature.localeCompare(b.feature));
}

function buildWebApiSettings(portal) {
  const settings = Object.entries(portal.settings ?? {}).filter(([name]) => /^Webapi\//i.test(name));
  const wildcard = settings
    .filter(([name, value]) => /\/fields$/i.test(name) && String(value).trim() === '*')
    .map(([name]) => name);
  const disabledFilter = settings
    .filter(([name, value]) => /\/disableodatafilter$/i.test(name) && /^true$/i.test(String(value).trim()))
    .map(([name]) => name);
  const enabledTables = settings
    .filter(([name, value]) => /\/enabled$/i.test(name) && /^true$/i.test(String(value).trim()))
    .map(([name]) => name.split('/')[1]);
  return { enabledTables, wildcard, disabledFilter };
}

function buildSourceKinds(sources) {
  return sorted(sources.reduce((map, source) => count(map, source.kind) && map, new Map()));
}

function buildSyntaxFailures(failures) {
  return {
    total: failures.length,
    staticFailures: failures.filter((item) => !item.dynamic),
    dynamicOnly: failures.filter((item) => item.dynamic).length,
    dynamicSamples: failures.filter((item) => item.dynamic).slice(0, 25),
  };
}

function unsupportedFeatures(matrix) {
  return matrix.filter((row) => !row.supported);
}

export async function inventoryWebApi(
  portalRoot,
  { solutionRoots = [], includeFetchXml = false, clientWrappers = [] } = {},
) {
  const root = await fs.realpath(path.resolve(portalRoot));
  const portal = await importPortal(root);
  const sources = await collectSources(portal, root);
  const features = new Map();
  const featureOrigins = new Map();
  const entitySets = new Map();
  const routes = new Map();
  const failures = [];
  const fetchSources = [];
  const requests = [];
  const state = { entitySets, routes, features, failures, fetchSources, requests };
  scanInventorySources(sources, clientWrappers, state);
  const { parsedFetch, fetchOrigins, fetchBlocks } = analyzeFetchSources(
    fetchSources,
    features,
    featureOrigins,
    failures,
    includeFetchXml,
  );
  let solution = null;
  if (solutionRoots.length) {
    const data = await importSolutionData(solutionRoots);
    solution = buildSolutionSummary(data, entitySets);
  }
  const matrix = buildFeatureMatrix(features, featureOrigins);
  const { enabledTables, wildcard, disabledFilter } = buildWebApiSettings(portal);
  const templateQueries = await inventoryPortalQueries(root);
  return {
    portalRoot: root,
    ...(includeFetchXml ? { fetchBlocks } : {}),
    format: portal.format,
    sourceCount: sources.length,
    sourceKinds: buildSourceKinds(sources),
    webApi: {
      requestExpressions: requests.length,
      entitySets: sorted(entitySets),
      routes: sorted(routes),
      settings: {
        enabledTables: enabledTables.length,
        wildcardFields: wildcard,
        disableOdataFilterTrue: disabledFilter,
        innerError: portal.settings?.['Webapi/error/innererror'] ?? null,
      },
    },
    fetchXml: {
      blocksAnalysed: fetchSources.length,
      parsed: parsedFetch,
      origins: sorted(fetchOrigins),
      templateInventory: {
        literalFetchXmlBlocks: templateQueries.literalFetchXmlBlocks,
        unresolvedOrDynamicBlocks: templateQueries.unresolvedOrDynamicBlocks,
        maxLiteralLinkEntitiesPerBlock: templateQueries.maxLiteralLinkEntitiesPerBlock,
        maxLiteralNestedLinkDepth: templateQueries.maxLiteralNestedLinkDepth,
      },
    },
    solution,
    supportMatrix: matrix,
    unsupported: unsupportedFeatures(matrix),
    syntaxFailures: buildSyntaxFailures(failures),
    limitations: [
      'Static analysis of exported text only: request URLs assembled at runtime from variables are recorded with placeholders and checked after type-appropriate substitution.',
      'Features are counted per occurrence in the exported sources (all language copies), not per executed request.',
      'Dynamic-only syntax failures need runtime evidence; static failures are real parser rejections.',
    ],
  };
}

async function main(args) {
  const options = parseToolArgs('webapi-inventory', args);
  if (options.help) {
    console.log(`Usage: paqvilo mirage webapi-inventory ${toolOptionsHelp('webapi-inventory')}`);
    return;
  }
  if (!(options.portal || options.config || options.site))
    throw new Error('Select --portal DIR or --config FILE --site ID.');
  const inputs = await inventoryInputs(options);
  const result = await inventoryWebApi(inputs.sourceDir, {
    solutionRoots: inputs.solutionRoots,
    clientWrappers: options['client-wrapper'] ?? [],
  });
  const json = options.json;
  if (json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`Portal source: ${result.portalRoot} (${result.format})`);
  console.log(`Text sources scanned: ${result.sourceCount}`);
  console.log(
    `/_api expressions: ${result.webApi.requestExpressions} across ${Object.keys(result.webApi.entitySets).length} entity sets`,
  );
  console.log(`FetchXML blocks analysed: ${result.fetchXml.blocksAnalysed} (${result.fetchXml.parsed} parsed)`);
  console.log(`Features observed: ${result.supportMatrix.length}; unsupported: ${result.unsupported.length}`);
  for (const row of result.unsupported)
    console.log(`  UNSUPPORTED ${row.feature} x${row.uses}${row.note ? ' - ' + row.note : ''}`);
  console.log(
    `Static syntax failures: ${result.syntaxFailures.staticFailures.length}; dynamic-only: ${result.syntaxFailures.dynamicOnly}`,
  );
  for (const failure of result.syntaxFailures.staticFailures.slice(0, 20))
    console.log(`  ${failure.file ?? failure.name} ${failure.option}: ${failure.error}`);
  if (result.webApi.settings.wildcardFields.length)
    console.log(
      `Wildcard Webapi fields (unsupported by hosted sites since 2026-09-14 without an exemption): ${result.webApi.settings.wildcardFields.join(', ')}`,
    );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  /* NOSONAR: module-level promise chain must not block evaluation */ main(process.argv.slice(2)).catch((error) => {
    reportCliError(error);
    process.exitCode = 1;
  });
}
