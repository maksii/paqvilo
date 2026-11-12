import { portalField } from './importer.mjs';
import { contextualViewFetchXml } from './platform.mjs';
import { parseFetchTree, serializeFetchTree } from './native-services.mjs';
import { stripTrailingCharacter } from './text-scanning.mjs';
import {
  compareNumeric,
  exactNumeric,
  isExactNumeric,
  parseNumericLiteral,
  stringifyExactJson,
} from './exact-numeric.mjs';

/*
 * Entity list OData feeds: lists with adx_odata_enabled publish their OData view
 * at /_odata/<adx_odata_entitysetname>. Model from the legacy EntityListODataFeedDataAdapter
 * (MIT): the primary key, the view's columns (link-entity columns named
 * "<entity>-<attribute>"), lookups as EntityReference {Id, Name}, choices as OptionSet
 * {Name, Value}, and the list-id, view-id and entity-permissions-enabled properties.
 * Responses are OData v3 JSON (minimal metadata) for GET /_odata (service document),
 * /_odata/$metadata (EDMX), /_odata/<set> and /_odata/<set>(guid'<id>') with $filter
 * (eq, ne, gt, ge, lt, le, and, or, not, parentheses, substringof, startswith, endswith,
 * Id/Name/Value paths), $orderby, $top, $skip, $select and $inlinecount=allpages.
 */
const NAMESPACE = 'Xrm';
const canonical = (value) =>
  String(value ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class ODataError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

/** OData-enabled lists keyed by entity set name (case-insensitive). */
export function odataFeeds(portal) {
  const feeds = new Map();
  for (const list of portal.lists ?? []) {
    const m = list.metadata ?? {};
    if (portalField(m, 'odata_enabled', false) !== true) continue;
    const set = String(portalField(m, 'odata_entitysetname', '') || '').trim();
    if (!set) continue;
    feeds.set(set.toLowerCase(), {
      set,
      list,
      entity: canonical(list.entityName),
      typeName: String(portalField(m, 'odata_entitytypename', '') || list.entityName),
      viewId: canonical(portalField(m, 'odata_view', '') || portalField(m, 'view', '')),
      permissions: portalField(m, 'entitypermissionsenabled', false) === true,
    });
  }
  return feeds;
}

function feedView(feed, metadata) {
  const view = (metadata?.views ?? []).find(
    (candidate) => canonical(candidate.id) === feed.viewId && canonical(candidate.entity) === feed.entity,
  );
  if (!view?.fetchXml)
    throw new ODataError(`The OData view of list ${feed.list.name} is absent from the selected solution sources.`, 501);
  return view;
}

/** Feed properties: primary key, view columns and the list annotations. */
function feedColumns(feed, view, metadata, idColumn) {
  const fetch = parseFetchTree(view.fetchXml);
  const aliases = new Map();
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.name === 'link-entity' && child.attrs?.alias) aliases.set(child.attrs.alias, child.attrs.name);
      walk(child);
    }
  };
  walk(fetch);
  return (view.fields ?? [])
    .filter((field) => field.name && canonical(field.name) !== canonical(idColumn))
    .map((field) => {
      const [alias, attribute] = field.name.includes('.') ? field.name.split('.') : [null, field.name];
      const entity = alias ? (aliases.get(alias) ?? alias) : feed.entity;
      const definition = metadata?.entities?.[entity]?.fields?.[attribute] ?? {};
      return {
        source: field.name,
        property: alias ? `${entity}-${attribute}` : attribute,
        entity,
        attribute,
        definition,
      };
    });
}

const kindOf = (definition, value) => {
  const type = String(definition.dataverseType ?? definition.type ?? '').toLowerCase();
  if (
    /lookup|customer|owner/.test(type) ||
    (value && typeof value === 'object' && ('logical_name' in value || 'id' in value))
  )
    return 'reference';
  if (/picklist|state|status|choice|optionset/.test(type) || (value && typeof value === 'object' && 'label' in value))
    return 'optionset';
  if (/money|decimal|double/.test(type)) return 'decimal';
  if (/int|bigint/.test(type)) return 'integer';
  if (/bit|boolean/.test(type) || typeof value === 'boolean') return 'boolean';
  if (/datetime|date/.test(type)) return 'datetime';
  if (/uniqueidentifier/.test(type)) return 'guid';
  return 'string';
};

// A decimal keeps its exact digits when a JavaScript number cannot hold them; ordinary values stay numbers.
function decimalValue(value) {
  const raw = value?.value ?? value;
  const number = Number(raw);
  if (typeof raw === 'number' || !Number.isFinite(number)) return number;
  try {
    return exactNumeric(raw, 'Decimal');
  } catch (error) {
    if (error.code === 'NumericPrecisionUnsupported') return number;
    throw error;
  }
}

/* NOSONAR: mixed return values are part of the contract */ function propertyValue(column, value) {
  const kind = kindOf(column.definition, value);
  if (value == null || value === '') return null;
  if (kind === 'reference') return { Id: canonical(value.id ?? value), Name: value.name ?? null };
  if (kind === 'optionset') {
    const number = Number(value?.value ?? value);
    const option = (column.definition.options ?? []).find((candidate) => Number(candidate.value) === number);
    return { Name: value?.label ?? option?.label ?? null, Value: Number.isFinite(number) ? number : null };
  }
  if (kind === 'decimal') return decimalValue(value);
  if (kind === 'integer') return Number(value);
  if (kind === 'boolean') return value === true || value === 1 || /^(true|1)$/i.test(String(value));
  if (kind === 'datetime') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }
  if (kind === 'guid') return canonical(value);
  return String(value);
}

// ---- $filter
function tokenIsUsable(text, index, match, pattern) {
  if (!match || match[0].length === 0) {
    if (/^\s*$/.test(text.slice(index))) return false;
    throw new ODataError(`Unsupported $filter syntax near '${text.slice(index, index + 20)}'.`);
  }
  if (match[7] && /[\w.]/.test(text[pattern.lastIndex] ?? ''))
    throw new ODataError(`Unsupported $filter syntax near '${text.slice(pattern.lastIndex, pattern.lastIndex + 20)}'.`);
  return true;
}

function tokenize(text) {
  const tokens = [];
  const pattern =
    /(?:(guid'([0-9a-fA-F-]{36})')|(datetime'([^']*)')|('([^']*(?:''[^']*)*)')|(-?\d+(?:\.\d+)?)|(\()|(\))|(,)|([A-Za-z_][\w.\-/]*))/y; // NOSONAR: regex kept: a rewrite would change matches or captures
  let index = 0;
  while (index < text.length) {
    while (index < text.length && /\s/.test(text[index])) index++;
    if (index === text.length) break;
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (!tokenIsUsable(text, index, match, pattern)) break;
    index = pattern.lastIndex;
    appendToken(tokens, match);
  }
  return tokens;
}

// An integer literal stays a number; a decimal literal keeps its exact digits (a number when that is exact).
const numericLiteral = (text) => (text.includes('.') ? parseNumericLiteral(text) : Number(text));

function appendToken(tokens, match) {
  if (match[2]) tokens.push({ type: 'literal', value: canonical(match[2]) });
  else if (match[3]) tokens.push({ type: 'literal', value: new Date(match[4]).getTime() });
  else if (match[5]) tokens.push({ type: 'literal', value: match[6].replaceAll("''", "'") });
  else if (match[7]) tokens.push({ type: 'literal', value: numericLiteral(match[7]) });
  else if (match[8]) tokens.push({ type: '(' });
  else if (match[9]) tokens.push({ type: ')' });
  else if (match[10]) tokens.push({ type: ',' });
  else tokens.push({ type: 'word', value: match[11] });
}

// Parenthesised groups, function arguments and `not` operands may nest this deep; deeper input is refused as a bad $filter.
const MAX_FILTER_DEPTH = 100;

function parseFilter(text) {
  const tokens = tokenize(text);
  let position = 0;
  let depth = 0;
  const nested = (parse) => {
    if (++depth > MAX_FILTER_DEPTH) throw new ODataError('The $filter expression is nested too deeply.');
    try {
      return parse();
    } finally {
      depth--;
    }
  };
  const group = () => nested(expression);
  const peek = () => tokens[position];
  const take = (type, value) => {
    const token = tokens[position];
    if (!token || token.type !== type || (value && token.value?.toLowerCase() !== value))
      throw new ODataError(`Expected ${value ?? type} in $filter.`);
    position++;
    return token;
  };
  const isWord = (value) => peek()?.type === 'word' && peek().value.toLowerCase() === value;
  const operand = () => {
    const token = peek();
    if (!token) throw new ODataError('Incomplete $filter expression.');
    if (token.type === '(') {
      position++;
      const inner = group();
      take(')');
      return inner;
    }
    if (token.type === 'literal') {
      position++;
      return { literal: token.value };
    }
    if (token.type === 'word') {
      position++;
      const word = token.value;
      if (/^(true|false)$/i.test(word)) return { literal: word.toLowerCase() === 'true' };
      if (/^null$/i.test(word)) return { literal: null };
      if (peek()?.type === '(' && /^(substringof|startswith|endswith|tolower|toupper)$/i.test(word)) {
        position++;
        const args = [group()];
        while (peek()?.type === ',') {
          position++;
          args.push(group());
        }
        take(')');
        return { call: word.toLowerCase(), args };
      }
      return { path: word };
    }
    throw new ODataError('Unsupported $filter operand.');
  };
  const comparison = () => {
    if (isWord('not')) {
      position++;
      return { not: nested(comparison) };
    }
    const left = operand();
    const operator =
      peek()?.type === 'word' && /^(eq|ne|gt|ge|lt|le)$/i.test(peek().value)
        ? tokens[position++].value.toLowerCase()
        : null;
    return operator ? { operator, left, right: operand() } : left;
  };
  // Chains are flat n-ary nodes, so a long chain adds no tree depth for evaluate() to recurse through.
  const conjunction = () => {
    const terms = [comparison()];
    while (isWord('and')) {
      position++;
      terms.push(comparison());
    }
    return terms.length === 1 ? terms[0] : { and: terms };
  };
  const expression = () => {
    const terms = [conjunction()];
    while (isWord('or')) {
      position++;
      terms.push(conjunction());
    }
    return terms.length === 1 ? terms[0] : { or: terms };
  };
  const tree = expression();
  if (position !== tokens.length) throw new ODataError('Unsupported trailing $filter syntax.');
  return tree;
}

function resolvePath(entry, path) {
  let value = entry;
  for (const part of path.split('/')) value = value == null ? null : value[part];
  return value;
}

/* NOSONAR: mixed return values are part of the contract */ function evaluateCall(node, entry) {
  const args = node.args.map((child) => evaluate(child, entry));
  const text = (value) => String(value ?? '');
  if (node.call === 'substringof') return text(args[1]).toLowerCase().includes(text(args[0]).toLowerCase());
  if (node.call === 'startswith') return text(args[0]).toLowerCase().startsWith(text(args[1]).toLowerCase());
  if (node.call === 'endswith') return text(args[0]).toLowerCase().endsWith(text(args[1]).toLowerCase());
  if (node.call === 'tolower') return text(args[0]).toLowerCase();
  if (node.call === 'toupper') return text(args[0]).toUpperCase();
}

function comparable(value) {
  if (typeof value === 'string' && GUID.test(value)) return value.toLowerCase();
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}T/.test(value))
    return Date.parse(value);
  return value;
}

// A pair of numbers where one is an exact numeric compares by digits.
const isNumeric = (value) => typeof value === 'number' || isExactNumeric(value);
const exactNumericPair = (left, right) =>
  isNumeric(left) && isNumeric(right) && (isExactNumeric(left) || isExactNumeric(right));
// The operands of such a pair become its digit comparison (-1, 0, 1, or NaN when not comparable) and zero.
const comparisonOperands = (left, right) =>
  exactNumericPair(left, right) ? [compareNumeric(left, right), 0] : [left, right];

function equalValues(left, right) {
  return left === right || (left == null && right == null);
}

function orderedComparison(operator, left, right) {
  if (left == null || right == null) return false;
  switch (operator) {
    case 'gt':
      return left > right;
    case 'ge':
      return left >= right;
    case 'lt':
      return left < right;
    case 'le':
      return left <= right;
    default:
      throw new ODataError('Unsupported $filter operator.');
  }
}

function compareValues(operator, left, right) {
  switch (operator) {
    case 'eq':
      return equalValues(left, right);
    case 'ne':
      return !equalValues(left, right);
    case 'gt':
    case 'ge':
    case 'lt':
    case 'le':
      return orderedComparison(operator, left, right);
    default:
      throw new ODataError('Unsupported $filter operator.');
  }
}

function evaluate(node, entry) {
  if ('literal' in node) return node.literal;
  if (node.path) {
    const value = resolvePath(entry, node.path);
    if (value === undefined) throw new ODataError(`Unknown property '${node.path}' in $filter.`);
    return value;
  }
  if (node.not) return !evaluate(node.not, entry);
  if (node.and) return node.and.every((child) => evaluate(child, entry));
  if (node.or) return node.or.some((child) => evaluate(child, entry));
  if (node.call) return evaluateCall(node, entry);
  const [left, right] = comparisonOperands(
    comparable(evaluate(node.left, entry)),
    comparable(evaluate(node.right, entry)),
  );
  return compareValues(node.operator, left, right);
}

function orderBy(entries, clause) {
  if (!clause) return entries;
  const keys = clause.split(',').map((part) => {
    const [path, direction] = part.trim().split(/\s+/);
    return { path, descending: /^desc$/i.test(direction ?? '') };
  });
  return [...entries].sort((a, b) => {
    for (const { path, descending } of keys) {
      const left = resolvePath(a, path);
      const right = resolvePath(b, path);
      const order = left === right ? 0 : compareForOrder(left, right);
      if (order !== 0) return descending ? -order : order;
    }
    return 0;
  });
}

// Nulls first; exact numerics by their digits; other values by JavaScript order.
function compareForOrder(left, right) {
  if (left == null) return -1;
  if (right == null) return 1;
  if (exactNumericPair(left, right)) return compareNumeric(left, right) || 0; // NaN: not comparable, a tie
  return left < right ? -1 : 1;
}

const EDM = {
  reference: `${NAMESPACE}.EntityReference`,
  optionset: `${NAMESPACE}.OptionSet`,
  decimal: 'Edm.Decimal',
  integer: 'Edm.Int32',
  boolean: 'Edm.Boolean',
  datetime: 'Edm.DateTime',
  guid: 'Edm.Guid',
  string: 'Edm.String',
};
const xmlEscape = (value) =>
  String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

function metadataDocument(feeds, context) {
  const types = [];
  const sets = [];
  for (const feed of feeds.values()) {
    let columns;
    let idColumn = `${feed.entity}id`;
    try {
      const view = feedView(feed, context.metadata);
      idColumn = context.store.resolveMapping(feed.entity).idColumn ?? idColumn;
      columns = feedColumns(feed, view, context.metadata, idColumn);
    } catch {
      columns = [];
    }
    const properties = [
      `<Property Name="${xmlEscape(idColumn)}" Type="Edm.Guid" Nullable="false"/>`,
      ...columns.map(
        (column) => `<Property Name="${xmlEscape(column.property)}" Type="${EDM[kindOf(column.definition, null)]}"/>`,
      ),
      '<Property Name="list-id" Type="Edm.String"/>',
      '<Property Name="view-id" Type="Edm.String"/>',
      '<Property Name="entity-permissions-enabled" Type="Edm.String"/>',
    ];
    types.push(
      `<EntityType Name="${xmlEscape(feed.typeName)}"><Key><PropertyRef Name="${xmlEscape(idColumn)}"/></Key>${properties.join('')}</EntityType>`,
    );
    sets.push(`<EntitySet Name="${xmlEscape(feed.set)}" EntityType="${NAMESPACE}.${xmlEscape(feed.typeName)}"/>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices m:DataServiceVersion="3.0" m:MaxDataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"><Schema Namespace="${NAMESPACE}" xmlns="http://schemas.microsoft.com/ado/2009/11/edm"><ComplexType Name="EntityReference"><Property Name="Id" Type="Edm.Guid"/><Property Name="Name" Type="Edm.String"/></ComplexType><ComplexType Name="OptionSet"><Property Name="Name" Type="Edm.String"/><Property Name="Value" Type="Edm.Int32"/></ComplexType>${types.join('')}<EntityContainer Name="${NAMESPACE}" m:IsDefaultEntityContainer="true">${sets.join('')}</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
}

async function feedEntries(feed, context) {
  const view = feedView(feed, context.metadata);
  const mapping = context.store.resolveMapping(feed.entity);
  const idColumn = mapping.idColumn ?? `${feed.entity}id`;
  const columns = feedColumns(feed, view, context.metadata, idColumn);
  const fetch = parseFetchTree(
    contextualViewFetchXml(view.fetchXml, { user: context.identity, website: context.portal.website }),
  );
  delete fetch.attrs.top;
  fetch.attrs.count = '5000';
  const result = await context.readProvider.fetchXml(serializeFetchTree(fetch), context.identity);
  const rows = result.entities ?? result.value ?? [];
  return rows.map((row) => {
    const entry = { [idColumn]: canonical(row[idColumn]) };
    for (const column of columns) entry[column.property] = propertyValue(column, row[column.source]);
    entry['list-id'] = canonical(feed.list.id);
    entry['view-id'] = feed.viewId;
    entry['entity-permissions-enabled'] = feed.permissions ? 'True' : 'False';
    return { entry, idColumn };
  });
}

function feedForRequest(rest, feeds) {
  const target = /^([^/(]+)(?:\(guid'([0-9a-fA-F-]{36})'\)|\(([0-9a-fA-F-]{36})\))?$/.exec(rest);
  const feed = target ? feeds.get(target[1].toLowerCase()) : null;
  if (!feed) throw new ODataError(`No OData feed is published at /_odata/${rest}.`, 404);
  return { target, feed };
}

function assertFeedPermission(feed, context) {
  if (
    feed.permissions &&
    typeof context.store.allowed === 'function' &&
    !context.store.allowed(feed.entity, 'read', null, context.identity)
  )
    throw new ODataError("You don't have permission to perform this operation.", 403);
}

function sendFeedEntry(target, entries, feed, context, base, send) {
  const id = canonical(target[2] ?? target[3] ?? '');
  if (!id) return null;
  const idColumn = context.store.resolveMapping(feed.entity).idColumn ?? `${feed.entity}id`;
  const entry = entries.find((candidate) => candidate[idColumn] === id);
  if (!entry) throw new ODataError('Resource not found for the segment.', 404);
  return send(200, { 'odata.metadata': `${base}/$metadata#${feed.set}/@Element`, ...entry });
}

function sendFeedCollection(entries, url, feed, base, send) {
  const filter = url.searchParams.get('$filter');
  if (filter) {
    const tree = parseFilter(filter);
    entries = entries.filter((entry) => evaluate(tree, entry));
  }
  entries = orderBy(entries, url.searchParams.get('$orderby'));
  const count = entries.length;
  const skip = Math.max(0, Number(url.searchParams.get('$skip') ?? 0) || 0);
  const top = url.searchParams.has('$top') ? Math.max(0, Number(url.searchParams.get('$top')) || 0) : null;
  entries = entries.slice(skip, top == null ? undefined : skip + top);
  const select = (url.searchParams.get('$select') ?? '')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean);
  if (select.length && !select.includes('*'))
    entries = entries.map((entry) =>
      Object.fromEntries(select.filter((name) => name in entry).map((name) => [name, entry[name]])),
    );
  return send(200, {
    'odata.metadata': `${base}/$metadata#${feed.set}`,
    ...(url.searchParams.get('$inlinecount') === 'allpages' ? { 'odata.count': String(count) } : {}),
    value: entries,
  });
}

function responseSender(req, res) {
  return (status, body, type = 'application/json; odata=minimalmetadata; streaming=true; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-cache', dataserviceversion: '3.0' });
    let responseBody;
    if (req.method !== 'HEAD') {
      if (typeof body === 'string') responseBody = body;
      else responseBody = stringifyExactJson(body);
    }
    res.end(responseBody);
    return true;
  };
}

function unsupportedFormat(format, accept) {
  return (
    (format && !/^json$/i.test(format)) ||
    (!format && /application\/atom\+xml|application\/xml/i.test(accept) && !/json|\*\/\*/i.test(accept))
  );
}

/**
 * Handle /_odata requests; returns true when handled. Power Pages removed list OData feeds by
 * June 2026 (diagnostic LIST_ODATA_FEED_REMOVED), so /_odata is left to the site's
 * page-not-found handling as on the platform (404 "Page Not Found" even for a feed-enabled
 * list). A site whose platform
 * still serves the feeds declares observed.listODataFeeds: "served" to get the local feed.
 */
export async function handleODataFeed(req, res, url, context) {
  const match = /^\/_odata(?:\/(.*))?$/i.exec(url.pathname);
  if (!match) return false;
  if ((context.config?.observed ?? context.portal?.observed)?.listODataFeeds !== 'served') return false;
  if (!['GET', 'HEAD'].includes(req.method)) return false;
  const feeds = odataFeeds(context.portal);
  const base = `${context.origin}/_odata`;
  const send = responseSender(req, res);
  const fail = (error) =>
    send(error.status ?? 500, { 'odata.error': { code: '', message: { lang: 'en-US', value: error.message } } });
  const accept = String(req.headers.accept ?? '');
  const format = url.searchParams.get('$format');
  if (unsupportedFormat(format, accept))
    return fail(new ODataError('Only the OData JSON format is available locally ($format=json).', 406));
  const rest = stripTrailingCharacter(match[1] ?? '', '/');
  try {
    if (!rest)
      return send(200, {
        'odata.metadata': `${base}/$metadata`,
        value: [...feeds.values()].map((feed) => ({ name: feed.set, url: feed.set })),
      });
    if (rest === '$metadata') return send(200, metadataDocument(feeds, context), 'application/xml; charset=utf-8');
    const { target, feed } = feedForRequest(rest, feeds);
    assertFeedPermission(feed, context);
    const entries = (await feedEntries(feed, context)).map((item) => item.entry);
    const single = sendFeedEntry(target, entries, feed, context, base, send);
    return single ?? sendFeedCollection(entries, url, feed, base, send);
  } catch (error) {
    return fail(error);
  }
}
