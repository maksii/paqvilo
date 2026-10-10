import { portalField } from "./importer.mjs";
import { contextualViewFetchXml } from "./platform.mjs";
import { parseFetchTree, serializeFetchTree } from "./native-services.mjs";

/*
 * Entity list OData feeds : lists with adx_odata_enabled publish their OData view
 * at /_odata/<adx_odata_entitysetname>. Model from the legacy EntityListODataFeedDataAdapter
 * (MIT): the primary key, the view's columns (link-entity columns named
 * "<entity>-<attribute>"), lookups as EntityReference {Id, Name}, choices as OptionSet
 * {Name, Value}, and the list-id, view-id and entity-permissions-enabled properties.
 * Responses are OData v3 JSON (minimal metadata) for GET /_odata (service document),
 * /_odata/$metadata (EDMX), /_odata/<set> and /_odata/<set>(guid'<id>') with $filter
 * (eq, ne, gt, ge, lt, le, and, or, not, parentheses, substringof, startswith, endswith,
 * Id/Name/Value paths), $orderby, $top, $skip, $select and $inlinecount=allpages.
 */
const NAMESPACE = "Xrm";
const canonical = (value) => String(value ?? "").replace(/[{}]/g, "").toLowerCase();
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
    if (portalField(m, "odata_enabled", false) !== true) continue;
    const set = String(portalField(m, "odata_entitysetname", "") || "").trim();
    if (!set) continue;
    feeds.set(set.toLowerCase(), {
      set,
      list,
      entity: canonical(list.entityName),
      typeName: String(portalField(m, "odata_entitytypename", "") || list.entityName),
      viewId: canonical(portalField(m, "odata_view", "") || portalField(m, "view", "")),
      permissions: portalField(m, "entitypermissionsenabled", false) === true,
    });
  }
  return feeds;
}

function feedView(feed, metadata) {
  const view = (metadata?.views ?? []).find((candidate) => canonical(candidate.id) === feed.viewId && canonical(candidate.entity) === feed.entity);
  if (!view?.fetchXml) throw new ODataError(`The OData view of list ${feed.list.name} is absent from the selected solution sources.`, 501);
  return view;
}

/** Feed properties: primary key, view columns and the list annotations. */
function feedColumns(feed, view, metadata, idColumn) {
  const fetch = parseFetchTree(view.fetchXml);
  const aliases = new Map();
  const walk = (node) => {
    for (const child of node.children ?? []) {
      if (child.name === "link-entity" && child.attrs?.alias) aliases.set(child.attrs.alias, child.attrs.name);
      walk(child);
    }
  };
  walk(fetch);
  return (view.fields ?? [])
    .filter((field) => field.name && canonical(field.name) !== canonical(idColumn))
    .map((field) => {
      const [alias, attribute] = field.name.includes(".") ? field.name.split(".") : [null, field.name];
      const entity = alias ? aliases.get(alias) ?? alias : feed.entity;
      const definition = metadata?.entities?.[entity]?.fields?.[attribute] ?? {};
      return { source: field.name, property: alias ? `${entity}-${attribute}` : attribute, entity, attribute, definition };
    });
}

const kindOf = (definition, value) => {
  const type = String(definition.dataverseType ?? definition.type ?? "").toLowerCase();
  if (/lookup|customer|owner/.test(type) || (value && typeof value === "object" && ("logical_name" in value || "id" in value))) return "reference";
  if (/picklist|state|status|choice|optionset/.test(type) || (value && typeof value === "object" && "label" in value)) return "optionset";
  if (/money|decimal|double/.test(type)) return "decimal";
  if (/int|bigint/.test(type)) return "integer";
  if (/bit|boolean/.test(type) || typeof value === "boolean") return "boolean";
  if (/datetime|date/.test(type)) return "datetime";
  if (/uniqueidentifier/.test(type)) return "guid";
  return "string";
};

function propertyValue(column, value) {
  const kind = kindOf(column.definition, value);
  if (value == null || value === "") return null;
  if (kind === "reference") return { Id: canonical(value.id ?? value), Name: value.name ?? null };
  if (kind === "optionset") {
    const number = Number(value?.value ?? value);
    const option = (column.definition.options ?? []).find((candidate) => Number(candidate.value) === number);
    return { Name: value?.label ?? option?.label ?? null, Value: Number.isFinite(number) ? number : null };
  }
  if (kind === "decimal") return Number(value?.value ?? value);
  if (kind === "integer") return Number(value);
  if (kind === "boolean") return value === true || value === 1 || /^(true|1)$/i.test(String(value));
  if (kind === "datetime") {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().replace(/\.\d{3}Z$/, "Z");
  }
  if (kind === "guid") return canonical(value);
  return String(value);
}

// ---- $filter ---------------------------------------------------------------------------
function tokenize(text) {
  const tokens = [];
  const pattern = /\s*(?:(guid'([0-9a-fA-F-]{36})')|(datetime'([^']*)')|('((?:[^']|'')*)')|(-?\d+(?:\.\d+)?)(?![\w.])|(\()|(\))|(,)|([A-Za-z_][\w.\-/]*))/y;
  let index = 0;
  while (index < text.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (!match || match[0].length === 0) {
      if (/^\s*$/.test(text.slice(index))) break;
      throw new ODataError(`Unsupported $filter syntax near '${text.slice(index, index + 20)}'.`);
    }
    index = pattern.lastIndex;
    if (match[2]) tokens.push({ type: "literal", value: canonical(match[2]) });
    else if (match[3]) tokens.push({ type: "literal", value: new Date(match[4]).getTime() });
    else if (match[5]) tokens.push({ type: "literal", value: match[6].replace(/''/g, "'") });
    else if (match[7]) tokens.push({ type: "literal", value: Number(match[7]) });
    else if (match[8]) tokens.push({ type: "(" });
    else if (match[9]) tokens.push({ type: ")" });
    else if (match[10]) tokens.push({ type: "," });
    else tokens.push({ type: "word", value: match[11] });
  }
  return tokens;
}

function parseFilter(text) {
  const tokens = tokenize(text);
  let position = 0;
  const peek = () => tokens[position];
  const take = (type, value) => {
    const token = tokens[position];
    if (!token || token.type !== type || (value && token.value?.toLowerCase() !== value)) throw new ODataError(`Expected ${value ?? type} in $filter.`);
    position++;
    return token;
  };
  const isWord = (value) => peek()?.type === "word" && peek().value.toLowerCase() === value;
  const operand = () => {
    const token = peek();
    if (!token) throw new ODataError("Incomplete $filter expression.");
    if (token.type === "(") {
      position++;
      const inner = expression();
      take(")");
      return inner;
    }
    if (token.type === "literal") {
      position++;
      return { literal: token.value };
    }
    if (token.type === "word") {
      position++;
      const word = token.value;
      if (/^(true|false)$/i.test(word)) return { literal: word.toLowerCase() === "true" };
      if (/^null$/i.test(word)) return { literal: null };
      if (peek()?.type === "(" && /^(substringof|startswith|endswith|tolower|toupper)$/i.test(word)) {
        position++;
        const args = [expression()];
        while (peek()?.type === ",") {
          position++;
          args.push(expression());
        }
        take(")");
        return { call: word.toLowerCase(), args };
      }
      return { path: word };
    }
    throw new ODataError("Unsupported $filter operand.");
  };
  const comparison = () => {
    if (isWord("not")) {
      position++;
      return { not: comparison() };
    }
    const left = operand();
    const operator = peek()?.type === "word" && /^(eq|ne|gt|ge|lt|le)$/i.test(peek().value) ? tokens[position++].value.toLowerCase() : null;
    return operator ? { operator, left, right: operand() } : left;
  };
  const conjunction = () => {
    let node = comparison();
    while (isWord("and")) {
      position++;
      node = { and: [node, comparison()] };
    }
    return node;
  };
  const expression = () => {
    let node = conjunction();
    while (isWord("or")) {
      position++;
      node = { or: [node, conjunction()] };
    }
    return node;
  };
  const tree = expression();
  if (position !== tokens.length) throw new ODataError("Unsupported trailing $filter syntax.");
  return tree;
}

function resolvePath(entry, path) {
  let value = entry;
  for (const part of path.split("/")) value = value == null ? null : value[part];
  return value;
}

function evaluate(node, entry) {
  if ("literal" in node) return node.literal;
  if (node.path) {
    const value = resolvePath(entry, node.path);
    if (value === undefined) throw new ODataError(`Unknown property '${node.path}' in $filter.`);
    return value;
  }
  if (node.not) return !evaluate(node.not, entry);
  if (node.and) return node.and.every((child) => evaluate(child, entry));
  if (node.or) return node.or.some((child) => evaluate(child, entry));
  if (node.call) {
    const args = node.args.map((child) => evaluate(child, entry));
    const text = (value) => String(value ?? "");
    if (node.call === "substringof") return text(args[1]).toLowerCase().includes(text(args[0]).toLowerCase());
    if (node.call === "startswith") return text(args[0]).toLowerCase().startsWith(text(args[1]).toLowerCase());
    if (node.call === "endswith") return text(args[0]).toLowerCase().endsWith(text(args[1]).toLowerCase());
    if (node.call === "tolower") return text(args[0]).toLowerCase();
    if (node.call === "toupper") return text(args[0]).toUpperCase();
  }
  const comparable = (value) => (typeof value === "string" && GUID.test(value) ? value.toLowerCase() : typeof value === "string" && !Number.isNaN(Date.parse(value)) && /\d{4}-\d{2}-\d{2}T/.test(value) ? Date.parse(value) : value);
  const left = comparable(evaluate(node.left, entry));
  const right = comparable(evaluate(node.right, entry));
  switch (node.operator) {
    case "eq":
      return left === right || (left == null && right == null);
    case "ne":
      return !(left === right || (left == null && right == null));
    case "gt":
      return left != null && right != null && left > right;
    case "ge":
      return left != null && right != null && left >= right;
    case "lt":
      return left != null && right != null && left < right;
    case "le":
      return left != null && right != null && left <= right;
    default:
      throw new ODataError("Unsupported $filter operator.");
  }
}

function orderBy(entries, clause) {
  if (!clause) return entries;
  const keys = clause.split(",").map((part) => {
    const [path, direction] = part.trim().split(/\s+/);
    return { path, descending: /^desc$/i.test(direction ?? "") };
  });
  return [...entries].sort((a, b) => {
    for (const { path, descending } of keys) {
      const left = resolvePath(a, path);
      const right = resolvePath(b, path);
      if (left === right) continue;
      const order = left == null ? -1 : right == null ? 1 : left < right ? -1 : 1;
      return descending ? -order : order;
    }
    return 0;
  });
}

const EDM = { reference: `${NAMESPACE}.EntityReference`, optionset: `${NAMESPACE}.OptionSet`, decimal: "Edm.Decimal", integer: "Edm.Int32", boolean: "Edm.Boolean", datetime: "Edm.DateTime", guid: "Edm.Guid", string: "Edm.String" };
const xmlEscape = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function metadataDocument(feeds, context) {
  const types = [];
  const sets = [];
  for (const feed of feeds.values()) {
    let columns = [];
    let idColumn = `${feed.entity}id`;
    try {
      const view = feedView(feed, context.metadata);
      idColumn = context.store.resolveMapping(feed.entity).idColumn ?? idColumn;
      columns = feedColumns(feed, view, context.metadata, idColumn);
    } catch {
      columns = [];
    }
    const properties = [`<Property Name="${xmlEscape(idColumn)}" Type="Edm.Guid" Nullable="false"/>`, ...columns.map((column) => `<Property Name="${xmlEscape(column.property)}" Type="${EDM[kindOf(column.definition, null)]}"/>`), '<Property Name="list-id" Type="Edm.String"/>', '<Property Name="view-id" Type="Edm.String"/>', '<Property Name="entity-permissions-enabled" Type="Edm.String"/>'];
    types.push(`<EntityType Name="${xmlEscape(feed.typeName)}"><Key><PropertyRef Name="${xmlEscape(idColumn)}"/></Key>${properties.join("")}</EntityType>`);
    sets.push(`<EntitySet Name="${xmlEscape(feed.set)}" EntityType="${NAMESPACE}.${xmlEscape(feed.typeName)}"/>`);
  }
  return `<?xml version="1.0" encoding="utf-8"?><edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx"><edmx:DataServices m:DataServiceVersion="3.0" m:MaxDataServiceVersion="3.0" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"><Schema Namespace="${NAMESPACE}" xmlns="http://schemas.microsoft.com/ado/2009/11/edm"><ComplexType Name="EntityReference"><Property Name="Id" Type="Edm.Guid"/><Property Name="Name" Type="Edm.String"/></ComplexType><ComplexType Name="OptionSet"><Property Name="Name" Type="Edm.String"/><Property Name="Value" Type="Edm.Int32"/></ComplexType>${types.join("")}<EntityContainer Name="${NAMESPACE}" m:IsDefaultEntityContainer="true">${sets.join("")}</EntityContainer></Schema></edmx:DataServices></edmx:Edmx>`;
}

async function feedEntries(feed, context) {
  const view = feedView(feed, context.metadata);
  const mapping = context.store.resolveMapping(feed.entity);
  const idColumn = mapping.idColumn ?? `${feed.entity}id`;
  const columns = feedColumns(feed, view, context.metadata, idColumn);
  const fetch = parseFetchTree(contextualViewFetchXml(view.fetchXml, { user: context.identity, website: context.portal.website }));
  delete fetch.attrs.top;
  fetch.attrs.count = "5000";
  const result = await context.readProvider.fetchXml(serializeFetchTree(fetch), context.identity);
  const rows = result.entities ?? result.value ?? [];
  return rows.map((row) => {
    const entry = { [idColumn]: canonical(row[idColumn]) };
    for (const column of columns) entry[column.property] = propertyValue(column, row[column.source]);
    entry["list-id"] = canonical(feed.list.id);
    entry["view-id"] = feed.viewId;
    entry["entity-permissions-enabled"] = feed.permissions ? "True" : "False";
    return { entry, idColumn };
  });
}

/** Handle /_odata requests; returns true when handled. */
export async function handleODataFeed(req, res, url, context) {
  const match = /^\/_odata(?:\/(.*))?$/i.exec(url.pathname);
  if (!match) return false;
  if (!["GET", "HEAD"].includes(req.method)) return false;
  const feeds = odataFeeds(context.portal);
  const base = `${context.origin}/_odata`;
  const send = (status, body, type = "application/json; odata=minimalmetadata; streaming=true; charset=utf-8") => {
    res.writeHead(status, { "content-type": type, "cache-control": "no-cache", dataserviceversion: "3.0" });
    res.end(req.method === "HEAD" ? undefined : typeof body === "string" ? body : JSON.stringify(body));
    return true;
  };
  const fail = (error) => send(error.status ?? 500, { "odata.error": { code: "", message: { lang: "en-US", value: error.message } } });
  const accept = String(req.headers.accept ?? "");
  const format = url.searchParams.get("$format");
  if ((format && !/^json$/i.test(format)) || (!format && /application\/atom\+xml|application\/xml/i.test(accept) && !/json|\*\/\*/i.test(accept)))
    return fail(new ODataError("Only the OData JSON format is available locally ($format=json).", 406));
  const rest = (match[1] ?? "").replace(/\/+$/, "");
  try {
    if (!rest) return send(200, { "odata.metadata": `${base}/$metadata`, value: [...feeds.values()].map((feed) => ({ name: feed.set, url: feed.set })) });
    if (rest === "$metadata") return send(200, metadataDocument(feeds, context), "application/xml; charset=utf-8");
    const target = /^([^/(]+)(?:\(guid'([0-9a-fA-F-]{36})'\)|\(([0-9a-fA-F-]{36})\))?$/.exec(rest);
    const feed = target ? feeds.get(target[1].toLowerCase()) : null;
    if (!feed) throw new ODataError(`No OData feed is published at /_odata/${rest}.`, 404);
    if (feed.permissions && typeof context.store.allowed === "function" && !context.store.allowed(feed.entity, "read", null, context.identity))
      throw new ODataError("You don't have permission to perform this operation.", 403);
    let entries = (await feedEntries(feed, context)).map((item) => item.entry);
    const id = canonical(target[2] ?? target[3] ?? "");
    if (id) {
      const idColumn = context.store.resolveMapping(feed.entity).idColumn ?? `${feed.entity}id`;
      const entry = entries.find((candidate) => candidate[idColumn] === id);
      if (!entry) throw new ODataError("Resource not found for the segment.", 404);
      return send(200, { "odata.metadata": `${base}/$metadata#${feed.set}/@Element`, ...entry });
    }
    const filter = url.searchParams.get("$filter");
    if (filter) {
      const tree = parseFilter(filter);
      entries = entries.filter((entry) => evaluate(tree, entry));
    }
    entries = orderBy(entries, url.searchParams.get("$orderby"));
    const count = entries.length;
    const skip = Math.max(0, Number(url.searchParams.get("$skip") ?? 0) || 0);
    const top = url.searchParams.has("$top") ? Math.max(0, Number(url.searchParams.get("$top")) || 0) : null;
    entries = entries.slice(skip, top == null ? undefined : skip + top);
    const select = (url.searchParams.get("$select") ?? "").split(",").map((name) => name.trim()).filter(Boolean);
    if (select.length && !select.includes("*")) entries = entries.map((entry) => Object.fromEntries(select.filter((name) => name in entry).map((name) => [name, entry[name]])));
    return send(200, {
      "odata.metadata": `${base}/$metadata#${feed.set}`,
      ...(url.searchParams.get("$inlinecount") === "allpages" ? { "odata.count": String(count) } : {}),
      value: entries,
    });
  } catch (error) {
    return fail(error);
  }
}
