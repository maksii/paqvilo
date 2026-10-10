// Local FetchXML evaluation with Dataverse semantics. The store supplies
// permission-filtered rows and metadata; this module never bypasses them.
import { DataError } from "./data-error.mjs";
import {
  FETCH_OPERATORS,
  UNSUPPORTED_FETCH_OPERATORS,
  compileColumnComparison,
  compileOperator,
} from "./dataverse-conditions.mjs";
import { fiscalCalendar } from "./fiscal-calendar.mjs";
import {
  compareSortKeys,
  dateGroupValue,
  foldText,
  guidKey,
  isoUtc,
  makeSortKey,
  own,
  parseDateValue,
  scalar,
  sqlGuidSortKey,
} from "./dataverse-values.mjs";

export const FETCH_LIMITS = Object.freeze({
  links: 15,
  conditionsAndLinks: 500,
  pageSize: 5000,
  top: 5000,
  totalRecordCount: 5000,
  aggregateRecords: 50000,
  // Local bound on intermediate joined rows (not a Dataverse limit).
  joinRows: 250000,
  xmlDepth: 64,
  linkDepth: 32,
});
export const FETCH_LINK_TYPES = new Set([
  "inner", "outer", "any", "not any", "all", "not all", "exists", "in",
  "matchfirstrowusingcrossapply",
]);
const FILTER_LINK_TYPES = new Set(["any", "not any", "all", "not all"]);
const SEMI_JOIN_TYPES = new Set(["any", "not any", "all", "not all", "exists", "in"]);
export const FETCH_AGGREGATES = new Set(["count", "countcolumn", "sum", "avg", "min", "max"]);
export const FETCH_DATE_GROUPINGS = new Set([
  "day", "week", "month", "quarter", "year", "fiscal-period", "fiscal-year",
]);
export const FETCH_SCHEMA = Object.freeze({
  fetch: {
    children: ["entity"],
    attributes: [
      "version", "count", "page", "paging-cookie", "utc-offset", "aggregate",
      "aggregatelimit", "distinct", "mapping", "min-active-row-version",
      "output-format", "returntotalrecordcount", "no-lock", "top",
      "latematerialize", "useraworderby", "options", "datasource",
    ],
  },
  entity: {
    children: ["attribute", "all-attributes", "filter", "link-entity", "order"],
    attributes: ["name", "enableprefiltering", "prefilterparametername"],
  },
  "link-entity": {
    children: ["attribute", "all-attributes", "filter", "link-entity", "order"],
    attributes: [
      "name", "from", "to", "alias", "link-type", "visible", "intersect",
      "enableprefiltering", "prefilterparametername",
    ],
  },
  filter: {
    children: ["condition", "filter", "link-entity"],
    attributes: [
      "type", "hint", "isquickfindfields", "overridequickfindrecordlimitenabled",
      "overridequickfindrecordlimitdisabled",
    ],
  },
  condition: {
    children: ["value"],
    attributes: ["attribute", "operator", "value", "valueof", "entityname", "uiname", "uitype", "uihidden"],
  },
  value: { children: [], attributes: ["uiname", "uitype"] },
  attribute: {
    children: [],
    attributes: ["name", "alias", "aggregate", "groupby", "dategrouping", "distinct", "usertimezone", "rowaggregate"],
  },
  order: { children: [], attributes: ["attribute", "alias", "descending", "entityname"] },
  "all-attributes": { children: [], attributes: [] },
});
/** Accepted and ignored: execution hints and UI metadata that do not change results. */
export const FETCH_NO_OP_ATTRIBUTES = Object.freeze({
  fetch: ["version", "mapping", "output-format", "no-lock", "latematerialize", "options", "min-active-row-version", "utc-offset"],
  entity: ["enableprefiltering", "prefilterparametername"],
  "link-entity": ["visible", "intersect", "enableprefiltering", "prefilterparametername"],
  // hint="union" is a SQL performance hint (fetchxml/optimize-performance#union-hint): rows
  // are the same with or without it. planFetch reports its documented restrictions.
  filter: ["hint", "isquickfindfields", "overridequickfindrecordlimitenabled", "overridequickfindrecordlimitdisabled"],
  condition: ["uiname", "uitype", "uihidden"],
  value: ["uiname", "uitype"],
});
/**
 * Declared FetchXML attributes the evaluator rejects, with the reason, by element. The
 * schema accepts them (Dataverse does) but local execution can't honour them; the
 * static inventory reads this same table, so its support matrix matches execution.
 */
export const FETCH_UNSUPPORTED_ATTRIBUTES = Object.freeze({
  attribute: Object.freeze({
    rowaggregate:
      "FetchXML rowaggregate requires hierarchical relationship metadata, which the local store does not model.",
  }),
});

const fail = (message, status = 400, code = "InvalidFetchXml", details) => {
  throw new DataError(message, status, code, details);
};
const children = (node, name) => node.children.filter((child) => child.name === name);
const bool = (value) => /^(?:true|1)$/i.test(String(value ?? "").trim());
const integerAttribute = (fetch, name, { min = 1, max } = {}) => {
  const raw = fetch.attrs[name];
  if (raw == null) return null;
  const text = String(raw).trim();
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(Number(text)))
    fail(`The '${name}' attribute value '${raw}' is not a valid integer.`, 400, "InvalidFetchXml");
  const value = Number(text);
  if (value < min) fail(`The '${name}' attribute must be at least ${min}.`, 400, "InvalidFetchXml");
  if (max != null && value > max)
    fail(`The '${name}' attribute can't exceed ${max}.`, 400, "InvalidFetchXml");
  return value;
};

const XML_ENTITIES = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };
export const xmlDecode = (value) =>
  String(value).replace(
    /&(?:amp|lt|gt|quot|apos);|&#(?:x[\da-f]+|\d+);/gi,
    (entity) =>
      XML_ENTITIES[entity.toLowerCase()] ??
      String.fromCodePoint(
        parseInt(entity.slice(2, -1).replace(/^x/i, ""), /^&#x/i.test(entity) ? 16 : 10),
      ),
  );
export const xmlEscapeAttribute = (value) =>
  String(value)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

/** Small non-resolving XML parser. Declarations and external entities are rejected. */
export function parseXmlDocument(source, { root, maxDepth = FETCH_LIMITS.xmlDepth } = {}) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    fail("FetchXML declarations and external entities are not supported", 400, "InvalidRequest");
  const document = { name: "#document", attrs: {}, children: [] };
  const stack = [document];
  for (const token of xmlTokens(String(source))) {
    if (token.startsWith("<!--") || token.startsWith("<?")) continue;
    if (token.startsWith("</")) {
      const name = token.slice(2, -1).trim();
      if (stack.length === 1 || stack.pop().name !== name)
        fail("Malformed FetchXML closing tag", 400, "InvalidRequest");
      continue;
    }
    if (token.startsWith("<")) {
      const match = /^<([\w:-]+)/.exec(token);
      if (!match) fail("Malformed FetchXML element", 400, "InvalidRequest");
      const attrs = Object.create(null);
      const content = token.slice(match[0].length, -1).trimEnd();
      const selfClosing = content.endsWith("/");
      const attributeText = selfClosing ? content.slice(0, -1) : content;
      const attribute = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
      let at = 0;
      while (at < attributeText.length) {
        while (at < attributeText.length && /\s/.test(attributeText[at])) at++;
        if (at === attributeText.length) break;
        attribute.lastIndex = at;
        const parsed = attribute.exec(attributeText);
        if (!parsed) fail(`Malformed attributes on ${match[1]}`, 400, "InvalidRequest");
        attrs[parsed[1]] = xmlDecode(parsed[2] ?? parsed[3]);
        at = attribute.lastIndex;
      }
      const node = { name: match[1], attrs, children: [], text: "" };
      stack.at(-1).children.push(node);
      if (!selfClosing) {
        if (stack.length >= maxDepth)
          fail(`FetchXML nesting exceeds ${maxDepth} levels`, 400, "UnsupportedQuery");
        stack.push(node);
      }
    } else {
      if (stack.length === 1 && token.trim())
        fail("Unexpected text outside FetchXML", 400, "InvalidRequest");
      stack.at(-1).text = (stack.at(-1).text ?? "") + xmlDecode(token);
    }
  }
  if (stack.length !== 1 || document.children.length !== 1 || (root && document.children[0].name !== root))
    fail(
      root === "fetch" ? "FetchXML must contain one complete fetch element" : `XML must contain one complete ${root ?? "root"} element`,
      400,
      "InvalidRequest",
    );
  return document.children[0];
}

// Never restart matching inside an unterminated tag/comment. Each input character
// is scanned once, including quoted '>' values and malformed adversarial XML.
function* xmlTokens(source) {
  let at = 0;
  while (at < source.length) {
    const start = at;
    if (source[at] !== "<") {
      const next = source.indexOf("<", at);
      at = next < 0 ? source.length : next;
    } else if (source.startsWith("<!--", at) || source.startsWith("<?", at)) {
      const comment = source.startsWith("<!--", at);
      const end = source.indexOf(comment ? "-->" : "?>", at + (comment ? 4 : 2));
      if (end < 0) fail("Unterminated FetchXML comment or instruction", 400, "InvalidRequest");
      at = end + (comment ? 3 : 2);
    } else {
      let quote = null;
      for (at++; at < source.length; at++) {
        const char = source[at];
        if (quote) { if (char === quote) quote = null; }
        else if (char === '"' || char === "'") quote = char;
        else if (char === ">") { at++; break; }
        else if (char === "<") fail("Malformed FetchXML element", 400, "InvalidRequest");
      }
      if (source[at - 1] !== ">" || quote) fail("Unterminated FetchXML element", 400, "InvalidRequest");
    }
    yield source.slice(start, at);
  }
}

/**
 * Validate a parsed <fetch> against the documented schema and query limits.
 * profile "webapi": Dataverse validates the schema, so undeclared attributes fail.
 * profile "portal" (Liquid, lists, lookups): the portal re-serialises the query
 * through its own object model, which drops unmodelled attributes; they are
 * ignored and reported in plan.diagnostics. The documented Liquid `xml`
 * output shows count="5000" page="1" returntotalrecordcount="true" added
 * when absent, so the portal profile reports total_record_count by default.
 */
export function planFetch(fetch, { profile = "portal" } = {}) {
  if (fetch?.name !== "fetch") fail("FetchXML must contain one complete fetch element", 400, "InvalidRequest");
  const strict = profile === "webapi";
  const diagnostics = [];
  const links = [];
  let conditions = 0,
    unionHints = 0;
  // Filter nesting: the entity's (or link-entity's) own filter is level 1.
  const filterLevels = new Map();
  const filterLevel = (node) => (node?.name === "filter" ? (filterLevels.get(node) ?? 1) : 0);
  const visit = (node, depth, linkDepth, parent) => {
    if (node.name === "filter") filterLevels.set(node, filterLevel(parent) + 1);
    if (depth > FETCH_LIMITS.xmlDepth)
      fail(`FetchXML nesting exceeds ${FETCH_LIMITS.xmlDepth} levels`, 400, "UnsupportedQuery");
    const schema = FETCH_SCHEMA[node.name];
    if (!schema) fail(`Unsupported FetchXML element ${node.name}`, 400, "UnsupportedQuery");
    for (const [key, reason] of Object.entries(FETCH_UNSUPPORTED_ATTRIBUTES[node.name] ?? {}))
      if (node.attrs[key] != null) fail(reason, 400, "UnsupportedQuery");
    for (const key of Object.keys(node.attrs))
      if (!schema.attributes.includes(key) && !/^xmlns(?::|$)/.test(key)) {
        if (strict)
          fail(`The '${key}' attribute is not declared on FetchXML ${node.name}.`, 400, "InvalidFetchXml");
        diagnostics.push({
          code: "FETCHXML_ATTRIBUTE_IGNORED",
          element: node.name,
          attribute: key,
          message: `The portal FetchXML model ignores the undeclared '${key}' attribute on ${node.name}.`,
        });
      }
    for (const child of node.children)
      if (!schema.children.includes(child.name))
        fail(`Unsupported FetchXML ${child.name} inside ${node.name}`, 400, "UnsupportedQuery");
    let nextLinkDepth = linkDepth;
    switch (node.name) {
      case "entity":
        if (!node.attrs.name) fail("The FetchXML entity element requires a name.", 400, "InvalidFetchXml");
        break;
      case "link-entity": {
        if (!node.attrs.name) fail("The FetchXML link-entity element requires a name.", 400, "InvalidFetchXml");
        const type = node.attrs["link-type"] ?? "inner";
        if (!FETCH_LINK_TYPES.has(type))
          fail(`Unsupported FetchXML link-type ${type}`, 400, "UnsupportedQuery");
        if (parent?.name === "filter" && !FILTER_LINK_TYPES.has(type))
          fail(
            `A link-entity inside a filter must use link-type any, not any, all or not all (found ${type}).`,
            400,
            "InvalidFetchXml",
          );
        links.push(node);
        nextLinkDepth++;
        if (links.length > FETCH_LIMITS.links)
          fail("Number of link entities in query exceeded maximum limit.", 400, "UnsupportedQuery", {
            innerCode: "0x8004430d",
          });
        if (nextLinkDepth > FETCH_LIMITS.linkDepth)
          fail(`FetchXML link nesting exceeds ${FETCH_LIMITS.linkDepth} levels`, 400, "UnsupportedQuery");
        break;
      }
      case "filter": {
        if (!["and", "or"].includes(node.attrs.type ?? "and"))
          fail(`Unsupported FetchXML filter type ${node.attrs.type}`, 400, "UnsupportedQuery");
        const hint = node.attrs.hint;
        if (hint != null) {
          // Learn documents one value, union, for an or filter; one per query; moved to the
          // root filter when nested; ignored more than three filter levels deep. What
          // Dataverse does with the other cases isn't documented, so they are reported and
          // the hint never changes the rows.
          const level = filterLevels.get(node);
          const report = (code, message) => diagnostics.push({ code, element: "filter", attribute: "hint", value: hint, message });
          if (hint !== "union")
            report("FETCHXML_FILTER_HINT_UNKNOWN", `FetchXML filter hint '${hint}' is not documented; only union is, and it doesn't change the rows.`);
          else {
            unionHints++;
            if ((node.attrs.type ?? "and") !== "or")
              report("FETCHXML_UNION_HINT_RESTRICTION", "The union hint needs a filter of type or (fetchxml/optimize-performance#union-hint).");
            if (unionHints === 2)
              report("FETCHXML_UNION_HINT_RESTRICTION", "A query can contain only one union hint (fetchxml/optimize-performance#union-hint).");
            if (level > 3)
              report("FETCHXML_UNION_HINT_IGNORED", `A union hint ${level} filter levels deep is ignored (more than three levels).`);
          }
        }
        break;
      }
      case "condition": {
        conditions++;
        if (!node.attrs.attribute)
          fail("FetchXML condition requires attribute", 400, "InvalidFetchXml");
        const operator = node.attrs.operator;
        if (operator == null)
          fail(`The required attribute 'operator' is missing on condition ${node.attrs.attribute}.`, 400, "InvalidFetchXml");
        if (UNSUPPORTED_FETCH_OPERATORS.has(operator))
          fail(
            `FetchXML operator ${operator} is not supported locally: ${UNSUPPORTED_FETCH_OPERATORS.get(operator)}.`,
            400,
            "UnsupportedQuery",
          );
        if (!FETCH_OPERATORS.has(operator === "neq" ? "ne" : operator) && operator !== "neq")
          fail(`Unsupported FetchXML operator ${operator}`, 400, "UnsupportedQuery");
        break;
      }
      case "attribute":
        if (!node.attrs.name) fail("The FetchXML attribute element requires a name.", 400, "InvalidFetchXml");
        if (node.attrs.aggregate != null && !FETCH_AGGREGATES.has(node.attrs.aggregate))
          fail(`Unsupported aggregate ${node.attrs.aggregate}`, 400, "UnsupportedQuery");
        if (node.attrs.dategrouping != null && !FETCH_DATE_GROUPINGS.has(node.attrs.dategrouping))
          fail(`Unsupported FetchXML dategrouping ${node.attrs.dategrouping}`, 400, "UnsupportedQuery");
        break;
      case "order":
        if (!node.attrs.attribute && !node.attrs.alias)
          fail("A FetchXML order element requires an attribute or alias.", 400, "InvalidFetchXml");
        break;
    }
    if (conditions + links.length > FETCH_LIMITS.conditionsAndLinks)
      fail("Number of conditions in query exceeded maximum limit.", 400, "UnsupportedQuery", {
        innerCode: "0x8004430c",
      });
    for (const child of node.children) visit(child, depth + 1, nextLinkDepth, node);
  };
  visit(fetch, 0, 0, null);
  const entities = children(fetch, "entity");
  if (entities.length !== 1) fail("FetchXML requires one entity", 400, "InvalidFetchXml");
  const root = entities[0];
  const aliasOf = new Map(),
    byAlias = new Map(),
    byName = new Map(),
    parentOf = new Map();
  links.forEach((link, index) => {
    const alias = link.attrs.alias ?? `${link.attrs.name}${index + 1}`;
    if (byAlias.has(alias))
      fail(
        `${alias} is not a unique alias. It clashes with an autogenerated alias or user provided alias`,
        400,
        "InvalidFetchXml",
        { innerCode: "0x80041130" },
      );
    aliasOf.set(link, alias);
    byAlias.set(alias, link);
    if (!link.attrs.alias && !byName.has(link.attrs.name)) byName.set(link.attrs.name, link);
  });
  const indexParents = (node, owner) => {
    for (const child of node.children) {
      if (child.name === "link-entity") {
        parentOf.set(child, owner);
        indexParents(child, child);
      } else if (child.name === "filter") indexParents(child, owner);
    }
  };
  indexParents(root, root);
  const aggregate = bool(fetch.attrs.aggregate);
  const top = integerAttribute(fetch, "top", { min: 1, max: FETCH_LIMITS.top });
  const count = integerAttribute(fetch, "count", { min: 0 });
  const page = integerAttribute(fetch, "page", { min: 1 });
  const returnTotal = bool(fetch.attrs.returntotalrecordcount);
  if (top != null && (count != null || page != null || returnTotal))
    fail(
      "The FetchXML top attribute can't be combined with the page, count or returntotalrecordcount attributes.",
      400,
      "InvalidFetchXml",
    );
  const datasource = fetch.attrs.datasource;
  if (datasource != null && !/^(?:retained|default)$/i.test(datasource))
    fail(`Unsupported FetchXML datasource ${datasource}`, 400, "UnsupportedQuery");
  const injectedTotal =
    profile === "portal" &&
    top == null &&
    !aggregate &&
    fetch.attrs.returntotalrecordcount == null;
  return {
    fetch,
    root,
    links,
    aliasOf,
    byAlias,
    byName,
    parentOf,
    aggregate,
    profile,
    diagnostics,
    distinct: bool(fetch.attrs.distinct),
    top,
    pageSize: count ? Math.min(count, FETCH_LIMITS.pageSize) : FETCH_LIMITS.pageSize,
    page: page ?? 1,
    pagingCookie: fetch.attrs["paging-cookie"] ?? null,
    returnTotal: returnTotal || injectedTotal,
    rawChoiceOrder: bool(fetch.attrs.useraworderby),
    aggregateLimit: integerAttribute(fetch, "aggregatelimit", {
      min: 1,
      max: FETCH_LIMITS.aggregateRecords,
    }),
    retained: /^retained$/i.test(datasource ?? ""),
  };
}

/** Parse a native paging cookie (raw XML or the Web API wrapper with a double-encoded payload). */
export function parsePagingCookie(value) {
  if (value == null || String(value).trim() === "") return null;
  let text = String(value).trim();
  let node;
  try {
    node = parseXmlDocument(text, { root: "cookie" });
  } catch {
    fail("The FetchXML paging-cookie value is not a valid paging cookie.", 400, "InvalidPagingCookie");
  }
  if (node.attrs.pagingcookie != null) {
    try {
      text = decodeURIComponent(decodeURIComponent(node.attrs.pagingcookie));
      node = parseXmlDocument(text, { root: "cookie" });
    } catch {
      fail("The FetchXML paging-cookie value is not a valid paging cookie.", 400, "InvalidPagingCookie");
    }
  }
  const page = Number(node.attrs.page);
  return {
    page: Number.isSafeInteger(page) && page > 0 ? page : null,
    values: new Map(node.children.map((child) => [child.name, { last: child.attrs.last, first: child.attrs.first }])),
  };
}

/** Lowercase double percent-encoding, matching documented Dataverse cookie bytes. */
const cookieEncode = (value) =>
  encodeURIComponent(value)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16))
    .replace(/%[\dA-F]{2}/g, (escape) => escape.toLowerCase());
/** Web API wrapper published as @Microsoft.Dynamics.CRM.fetchxmlpagingcookie. */
export function webApiPagingCookie(cookie, page) {
  return `<cookie pagenumber="${page + 1}" pagingcookie="${cookieEncode(cookieEncode(cookie))}" istracking="False" />`;
}

/** Read a column; lookups may be stored by logical name or Web API _x_value name. */
export function fieldValue(row, attribute) {
  if (row == null) return undefined;
  if (own(row, attribute)) return row[attribute];
  const lookup = /^_(.+)_value$/.exec(attribute);
  if (lookup && own(row, lookup[1])) return scalar(row[lookup[1]]);
  if (!lookup && own(row, `_${attribute}_value`)) return row[`_${attribute}_value`];
  return undefined;
}
const isEmpty = (value) => value == null || value === "" || (Array.isArray(value) && !value.length);
const joinKey = (value) => {
  const raw = scalar(value);
  if (raw == null || raw === "") return null;
  return guidKey(raw) ?? (typeof raw === "number" ? String(raw) : foldText(raw));
};
const cookieValue = (value) => {
  const raw = scalar(value);
  if (raw == null) return "";
  const guid = guidKey(raw);
  if (guid) return `{${guid.toUpperCase()}}`;
  if (typeof raw === "boolean") return raw ? "1" : "0";
  return String(raw);
};

/**
 * Structural many-to-many traversals of a planned query: link-entities to an
 * intersect that the parent table's relationships declare, selecting none of its
 * columns, whose own links lead only to the relationship's other table. They read
 * the intersect without exposing it as an independently readable table, so the
 * intersect needs no table permission of its own; the tables on both sides do.
 * mappingOf maps the root and each link to its table mapping.
 * Returns Map(link -> { relation, columns }).
 */
export function structuralIntersects(plan, mappingOf) {
  const structural = new Map();
  for (const link of plan.links) {
    const parent = plan.parentOf.get(link);
    if (!parent || parent.name === "filter") continue;
    const parentMapping = mappingOf.get(parent);
    const lm = mappingOf.get(link);
    if (children(link, "attribute").length || children(link, "all-attributes").length) continue;
    const relation = Object.values(parentMapping.relationships ?? {}).find(
      (rel) =>
        rel.intersect?.entity === lm.logicalName &&
        rel.intersect.from === link.attrs.from &&
        rel.from === link.attrs.to &&
        children(link, "link-entity").every(
          (target) =>
            target.attrs.name === rel.entity &&
            target.attrs.from === rel.to &&
            target.attrs.to === rel.intersect.to,
        ),
    );
    if (relation)
      structural.set(link, {
        relation,
        columns: new Set([relation.intersect.from, relation.intersect.to, lm.idColumn]),
      });
  }
  return structural;
}

/**
 * Execute a planned FetchXML query.
 * ctx: { mapping(name), readableRows(logical), tableRows(logical),
 *        canRead(logical,row), definition(logical, attribute), lookupName(ref),
 *        identity, settings, now, platformLanguageCode }
 */
export function executeFetch(plan, ctx) {
  const settings = ctx.settings ?? {};
  const collation = settings.collation ?? "CI_AI";
  const now = ctx.now ?? Date.now();
  const { root } = plan;
  const mappingOf = new Map([[root, ctx.mapping(root.attrs.name)]]);
  for (const link of plan.links) mappingOf.set(link, ctx.mapping(link.attrs.name));
  const rootMapping = mappingOf.get(root);
  const aliasNode = (alias) => (alias == null ? root : plan.byAlias.get(alias));
  const definition = (node, attribute) =>
    ctx.definition?.(mappingOf.get(node).logicalName, attribute);
  const resolveEntityName = (name) => {
    if (plan.byAlias.has(name)) return plan.aliasOf.get(plan.byAlias.get(name));
    if (plan.byName.has(name)) return plan.aliasOf.get(plan.byName.get(name));
    if (name === root.attrs.name) return null;
    fail(`The FetchXML entityname '${name}' does not match a link-entity alias or name.`, 400, "InvalidFetchXml");
  };
  const pkSort = (rows, idColumn) =>
    rows
      .map((row, index) => ({ row, index, key: sqlGuidSortKey(row[idColumn]) }))
      .sort((a, b) =>
        a.key && b.key
          ? a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index
          : a.key
            ? -1
            : b.key
              ? 1
              : String(a.row[idColumn] ?? "").localeCompare(String(b.row[idColumn] ?? "")) || a.index - b.index,
      )
      .map((entry) => entry.row);

  const structural = structuralIntersects(plan, mappingOf);

  // Columns the query names (projection, conditions, orders and join columns) are checked
  // against the local metadata. Complete Solution metadata still can't prove a column is
  // absent from an environment, which can carry columns no exported Solution defines
  // (a live page renders a custom table's column that no exported layer defines). So a
  // column complete metadata lacks (ctx.column "unknown") is a FETCHXML_COLUMN_UNKNOWN
  // diagnostic, and fails like Dataverse (QueryBuilderNoAttribute, 0x80041103) only with
  // settings.fetchColumnValidation "strict". A column of a table whose metadata isn't
  // complete that no stored row has is FETCHXML_COLUMN_UNVERIFIED. A structural
  // intersect's own columns come from its relationship and aren't checked.
  const checkedColumns = new Set();
  const assertColumn = (node, attribute, use) => {
    if (!ctx.column || node == null || attribute == null || attribute === "") return;
    if (structural.has(node) && use === "join") return;
    const logical = mappingOf.get(node)?.logicalName;
    if (!logical) return;
    const key = `${logical}\u0000${attribute}`;
    if (checkedColumns.has(key)) return;
    checkedColumns.add(key);
    const status = ctx.column(logical, attribute);
    if (status === "unknown" && settings.fetchColumnValidation === "strict")
      fail("The specified attribute does not exist on this entity.", 400, "InvalidFetchXml", {
        innerCode: "0x80041103",
        entity: logical,
        attribute,
        use,
      });
    if (status === "unknown")
      (plan.diagnostics ??= []).push({
        code: "FETCHXML_COLUMN_UNKNOWN",
        entity: logical,
        attribute,
        use,
        message: `${logical}.${attribute} (${use}) isn't in the table's complete Solution metadata; Dataverse rejects it unless the environment defines it outside the exported Solutions.`,
      });
    if (status === "unverified")
      (plan.diagnostics ??= []).push({
        code: "FETCHXML_COLUMN_UNVERIFIED",
        entity: logical,
        attribute,
        use,
        message: `${logical}.${attribute} (${use}) is neither in the table's metadata nor in its local rows; the metadata isn't complete, so the query isn't rejected.`,
      });
  };
  const columnOwner = (entityname, owner) => (entityname != null ? aliasNode(resolveEntityName(entityname)) : owner);
  const visitColumns = (node, owner) => {
    for (const child of node.children ?? []) {
      if (child.name === "attribute") assertColumn(owner, child.attrs.name, "attribute");
      else if (child.name === "order" && child.attrs.attribute)
        assertColumn(columnOwner(child.attrs.entityname, owner), child.attrs.attribute, "order");
      else if (child.name === "condition") {
        assertColumn(columnOwner(child.attrs.entityname, owner), child.attrs.attribute, "condition");
        if (child.attrs.valueof != null) {
          const [otherAlias, otherAttribute] = child.attrs.valueof.includes(".")
            ? child.attrs.valueof.split(".", 2)
            : [child.attrs.entityname, child.attrs.valueof];
          assertColumn(columnOwner(otherAlias, owner), otherAttribute, "condition");
        }
      } else if (child.name === "filter") visitColumns(child, owner);
      else if (child.name === "link-entity") {
        assertColumn(child, child.attrs.from, "join");
        if (!structural.has(owner) || !mappingOf.has(owner)) assertColumn(owner, child.attrs.to, "join");
        visitColumns(child, child);
      }
    }
  };
  visitColumns(root, root);
  const assertStructural = (alias, attribute, kind) => {
    const link = alias == null ? null : plan.byAlias.get(alias);
    const info = link && structural.get(link);
    if (!info) return;
    if (kind === "attribute")
      fail("FetchXML intersection columns cannot be returned without table permission", 403, "InvalidIntersectionQuery");
    if (!info.columns.has(attribute))
      fail("FetchXML intersection may only inspect mapped structural columns", 403, "InvalidIntersectionQuery");
  };

  // A selected portal language is public platform configuration. This
  // trusted renderer-only option permits an unprojected language catalog
  // constraint on already authorised articles, never direct table access.
  const isLanguageJoin = (link) => {
    const filters = children(link, "filter");
    const condition = filters[0]?.children?.[0];
    const referencesAlias = (part, alias) =>
      part.attrs?.entityname === alias || (part.children ?? []).some((c) => referencesAlias(c, alias));
    return (
      typeof ctx.platformLanguageCode === "string" &&
      /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(ctx.platformLanguageCode) &&
      plan.parentOf.get(link) === root &&
      root.attrs.name === "knowledgearticle" &&
      mappingOf.get(link).logicalName === "languagelocale" &&
      link.attrs.from === "languagelocaleid" &&
      link.attrs.to === "languagelocaleid" &&
      (link.attrs["link-type"] ?? "inner") === "inner" &&
      link.children.length === 1 &&
      filters.length === 1 &&
      (!filters[0].attrs.type || filters[0].attrs.type === "and") &&
      filters[0].children.length === 1 &&
      condition?.name === "condition" &&
      condition.attrs.attribute === "code" &&
      condition.attrs.operator === "eq" &&
      condition.attrs.value === ctx.platformLanguageCode &&
      !condition.attrs.entityname &&
      !referencesAlias(plan.fetch, plan.aliasOf.get(link))
    );
  };

  const candidates = new Map();
  const candidatesFor = (link) => {
    if (candidates.has(link)) return candidates.get(link);
    const lm = mappingOf.get(link);
    let rows;
    if (isLanguageJoin(link)) {
      rows = (ctx.tableRows(lm.logicalName) ?? [])
        .filter((row) => row.code === ctx.platformLanguageCode)
        .map((row) => ({ languagelocaleid: row.languagelocaleid, code: row.code }));
    } else if (structural.has(link)) {
      const { relation, columns } = structural.get(link);
      const endpoint = ctx.mapping(relation.entity);
      const readable = new Set(
        ctx.readableRows(endpoint.logicalName).map((row) => joinKey(fieldValue(row, relation.to))),
      );
      rows = (ctx.tableRows(lm.logicalName) ?? [])
        .filter((edge) => readable.has(joinKey(fieldValue(edge, relation.intersect.to))))
        .map((edge) =>
          Object.fromEntries([...columns].filter((key) => own(edge, key)).map((key) => [key, edge[key]])),
        );
    } else rows = pkSort(ctx.readableRows(lm.logicalName), lm.idColumn);
    candidates.set(link, rows);
    return rows;
  };

  // ---- filters -----------------------------------------------------------
  const valuesOf = (condition) => {
    const items = children(condition, "value").map((value) => (value.text ?? "").trim());
    if (items.length) return items;
    return own(condition.attrs, "value") ? [condition.attrs.value] : [];
  };
  const referencesOtherAlias = (node, ownerAlias) =>
    (node.name === "condition" &&
      ((node.attrs.entityname != null && resolveEntityName(node.attrs.entityname) !== ownerAlias) ||
        (node.attrs.valueof ?? "").includes("."))) ||
    (node.name !== "link-entity" && node.children.some((child) => referencesOtherAlias(child, ownerAlias)));
  const compileCondition = (condition, ownerAlias) => {
    const targetAlias =
      condition.attrs.entityname != null ? resolveEntityName(condition.attrs.entityname) : ownerAlias;
    const targetNode = aliasNode(targetAlias);
    const attribute = condition.attrs.attribute;
    assertStructural(targetAlias, attribute, "condition");
    const columnDefinition = definition(targetNode, attribute);
    const read = (item) => {
      const source = targetAlias == null ? item.base : item.aliases[targetAlias];
      return source == null ? undefined : fieldValue(source, attribute);
    };
    const qualified = `${mappingOf.get(targetNode).logicalName}.${attribute}`;
    if (condition.attrs.valueof != null) {
      const [otherAliasRaw, otherAttribute] = condition.attrs.valueof.includes(".")
        ? condition.attrs.valueof.split(".", 2)
        : [undefined, condition.attrs.valueof];
      const otherAlias = otherAliasRaw === undefined ? targetAlias : resolveEntityName(otherAliasRaw);
      assertStructural(otherAlias, otherAttribute, "condition");
      const compare = compileColumnComparison(condition.attrs.operator, {
        attribute: qualified,
        definition: columnDefinition,
        settings,
      });
      return (item) => {
        const other = otherAlias == null ? item.base : item.aliases[otherAlias];
        return compare(read(item), other == null ? undefined : fieldValue(other, otherAttribute));
      };
    }
    const predicate = compileOperator(condition.attrs.operator, {
      attribute: qualified,
      values: valuesOf(condition),
      definition: columnDefinition,
      identity: ctx.identity,
      settings,
      now,
    });
    return (item) => predicate(read(item));
  };
  const compileFilter = (filter, ownerAlias) => {
    const parts = filter.children.map((child) => {
      if (child.name === "filter") return compileFilter(child, ownerAlias);
      if (child.name === "condition") return compileCondition(child, ownerAlias);
      return compileSemiJoin(child, ownerAlias);
    });
    if (!parts.length) return () => true;
    return (filter.attrs.type ?? "and") === "or"
      ? (item) => parts.some((part) => part(item))
      : (item) => parts.every((part) => part(item));
  };
  const compileFilters = (node, ownerAlias) => {
    const parts = children(node, "filter").map((filter) => compileFilter(filter, ownerAlias));
    return parts.length ? (item) => parts.every((part) => part(item)) : null;
  };

  // ---- joins -------------------------------------------------------------
  const linkPlans = new Map();
  const linkPlan = (link) => {
    if (linkPlans.has(link)) return linkPlans.get(link);
    const alias = plan.aliasOf.get(link);
    if (!link.attrs.from || !link.attrs.to)
      fail(
        `No system many-to-many relationship exists between ${mappingOf.get(plan.parentOf.get(link)).logicalName} and ${link.attrs.name}.  If attempting to link through a custom many-to-many relationship ensure that you provide the from and to attributes.`,
        400,
        "InvalidFetchXml",
        { innerCode: "0x80041102" },
      );
    assertStructural(alias, link.attrs.from, "condition");
    const filter = compileFilters(link, alias);
    const local = !children(link, "filter").some((f) => referencesOtherAlias(f, alias));
    let rows = candidatesFor(link);
    if (filter && local) rows = rows.filter((row) => filter({ base: null, aliases: { [alias]: row } }));
    const index = new Map();
    for (const row of rows) {
      const key = joinKey(fieldValue(row, link.attrs.from));
      if (key == null) continue;
      if (!index.has(key)) index.set(key, []);
      index.get(key).push(row);
    }
    const result = { alias, index, filter: local ? null : filter, unfiltered: null };
    if (link.attrs["link-type"] === "all") {
      const all = new Map();
      for (const row of candidatesFor(link)) {
        const key = joinKey(fieldValue(row, link.attrs.from));
        if (key != null) all.set(key, true);
      }
      result.unfiltered = all;
    }
    linkPlans.set(link, result);
    return result;
  };
  const matchesFor = (row, link, parentAlias) => {
    const { alias, index, filter } = linkPlan(link);
    const parent = parentAlias == null ? row.base : row.aliases[parentAlias];
    const key = parent == null ? null : joinKey(fieldValue(parent, link.attrs.to));
    const candidatesForRow = key == null ? [] : (index.get(key) ?? []);
    const items = candidatesForRow.map((candidate) => ({
      base: row.base,
      aliases: { ...row.aliases, [alias]: candidate },
    }));
    return filter ? items.filter(filter) : items;
  };
  const semiJoinTest = (link, ownerAlias) => {
    const type = link.attrs["link-type"] ?? "inner";
    return (row) => {
      const items = joinTree(matchesFor(row, link, ownerAlias), link);
      const exists = items.length > 0;
      if (type === "not any") return !exists;
      if (type === "all") {
        const parent = ownerAlias == null ? row.base : row.aliases[ownerAlias];
        const key = parent == null ? null : joinKey(fieldValue(parent, link.attrs.to));
        return key != null && Boolean(linkPlan(link).unfiltered.get(key)) && !exists;
      }
      return exists;
    };
  };
  function compileSemiJoin(link, ownerAlias) {
    return semiJoinTest(link, ownerAlias);
  }
  // Joined rows are bounded: a query whose joins produce more intermediate rows than
  // settings.fetchJoinRowLimit (default FETCH_LIMITS.joinRows) fails instead of
  // exhausting memory.
  const stats = { joinedRows: 0, earlyLimit: null };
  const joinRowLimit = Number(settings.fetchJoinRowLimit ?? FETCH_LIMITS.joinRows);
  let joinedRows = 0;
  function countJoined(count) {
    joinedRows += count;
    if (joinedRows > joinRowLimit)
      fail(
        `The FetchXML joins produce more than ${joinRowLimit} intermediate rows locally; narrow the query with conditions or fewer links.`,
        400,
        "UnsupportedQuery",
        { joinRows: joinedRows, limit: joinRowLimit },
      );
  }
  function joinTree(rows, node) {
    const nodeAlias = node === root ? null : plan.aliasOf.get(node);
    for (const link of children(node, "link-entity")) {
      const type = link.attrs["link-type"] ?? "inner";
      if (SEMI_JOIN_TYPES.has(type)) {
        const test = semiJoinTest(link, nodeAlias);
        rows = rows.filter(test);
        continue;
      }
      const alias = plan.aliasOf.get(link);
      const next = [];
      for (const row of rows) {
        const matches = matchesFor(row, link, nodeAlias);
        if (type === "matchfirstrowusingcrossapply") {
          if (matches.length) next.push(matches[0]);
        } else if (matches.length) next.push(...matches);
        else if (type === "outer") next.push({ base: row.base, aliases: { ...row.aliases, [alias]: null } });
      }
      countJoined(next.length);
      // Dataverse emits flat joins: a nested link joins against every row
      // produced so far, so an inner child of an outer link removes rows
      // whose outer parent is null.
      rows = joinTree(next, link);
    }
    return rows;
  }

  const lookupName = (ref) => ctx.lookupName?.(ref) ?? ref?.name;
  const sortKeyOf = (value, columnDefinition) =>
    makeSortKey(value, {
      definition: columnDefinition,
      rawChoice: plan.rawChoiceOrder,
      lookupName,
      timeZoneOffsetMinutes: Number(settings.timeZoneOffsetMinutes ?? 0),
    });
  /**
   * Rows the evaluation must produce before the result is known, or null when every row
   * is needed: with no aggregate, no distinct, no paging cookie and only root attribute
   * orders, the first `top` rows (or those up to the end of the page, plus one to know
   * whether more exist) decide the result; a requested total needs up to the 5,000-row
   * count limit plus one.
   */
  function earlyLimit() {
    if (plan.aggregate || plan.distinct || plan.pagingCookie) return null;
    if (children(root, "order").some((order) => order.attrs.entityname != null || !order.attrs.attribute)) return null;
    const ordersLinks = (node) =>
      children(node, "link-entity").some((link) => children(link, "order").length || ordersLinks(link));
    if (ordersLinks(root)) return null;
    let limit = plan.top != null ? plan.top : plan.page * plan.pageSize + 1;
    if (plan.returnTotal) limit = Math.max(limit, FETCH_LIMITS.totalRecordCount + 1);
    return limit;
  }

  // ---- evaluate ------------------------------------------------------------
  let rows = plan.retained ? [] : pkSort(ctx.readableRows(rootMapping.logicalName), rootMapping.idColumn).map((base) => ({ base, aliases: {} }));
  const rootFilter = compileFilters(root, null);
  const pushdown = rootFilter && !children(root, "filter").some((f) => referencesOtherAlias(f, null));
  if (pushdown) rows = rows.filter(rootFilter);
  const limit = earlyLimit();
  if (limit == null) {
    rows = joinTree(rows, root);
    if (rootFilter && !pushdown) rows = rows.filter(rootFilter);
  } else {
    // Rows of one root stay together and roots keep the final order, so joining roots
    // in that order and stopping once `limit` rows exist gives the same first rows.
    const specs = children(root, "order").map((order) => ({
      attribute: order.attrs.attribute,
      descending: bool(order.attrs.descending),
      definition: definition(root, order.attrs.attribute),
    }));
    const keyed = rows.map((row, index) => ({
      row,
      index,
      keys: specs.map((spec) => sortKeyOf(fieldValue(row.base, spec.attribute), spec.definition)),
      pk: makeSortKey(row.base[rootMapping.idColumn], { definition: { dataverseType: "primarykey" } }),
    }));
    keyed.sort((a, b) => {
      for (let i = 0; i < specs.length; i++) {
        const result = compareSortKeys(a.keys[i], b.keys[i], collation);
        if (result) return specs[i].descending ? -result : result;
      }
      return compareSortKeys(a.pk, b.pk, collation) || a.index - b.index;
    });
    const collected = [];
    for (const { row } of keyed) {
      let joined = joinTree([row], root);
      if (rootFilter && !pushdown) joined = joined.filter(rootFilter);
      collected.push(...joined);
      if (collected.length >= limit) break;
    }
    rows = collected;
    stats.earlyLimit = limit;
  }
  stats.joinedRows = joinedRows;

  // ---- columns -------------------------------------------------------------
  const columns = [];
  const outputKeys = new Map();
  // Repeating an identical <attribute> in the same entity or link-entity
  // selects that column once (exported portal templates do this and render on
  // the live site); a different column claiming the same name still fails.
  const sameSelection = (a, b) =>
    a.alias === b.alias &&
    a.attribute === b.attribute &&
    a.aliased === b.aliased &&
    a.aggregate === b.aggregate &&
    a.groupby === b.groupby &&
    a.dategrouping === b.dategrouping &&
    a.distinct === b.distinct &&
    a.usertimezone === b.usertimezone;
  const claim = (key, column) => {
    const existing = outputKeys.get(key);
    if (existing) {
      if (sameSelection(existing, column)) return false;
      fail(
        `${key} is not a unique alias. It clashes with an autogenerated alias or user provided alias`,
        400,
        "InvalidFetchXml",
        { innerCode: "0x80041130" },
      );
    }
    outputKeys.set(key, column);
    return true;
  };
  const collectColumns = (node, alias) => {
    const type = node === root ? "inner" : (node.attrs["link-type"] ?? "inner");
    if (SEMI_JOIN_TYPES.has(type)) return;
    const crossApply = type === "matchfirstrowusingcrossapply";
    const lm = mappingOf.get(node);
    for (const attribute of children(node, "attribute")) {
      const name = attribute.attrs.name;
      assertStructural(alias, name, "attribute");
      const columnDefinition = definition(node, name);
      const key =
        attribute.attrs.alias ??
        (alias == null
          ? name
          : crossApply
            ? (columnDefinition?.schemaName ?? name)
            : `${alias}.${name}`);
      const column = {
        key,
        alias,
        entity: lm.logicalName,
        attribute: name,
        aliased: attribute.attrs.alias != null,
        aggregate: attribute.attrs.aggregate ?? null,
        groupby: bool(attribute.attrs.groupby),
        dategrouping: attribute.attrs.dategrouping ?? null,
        distinct: bool(attribute.attrs.distinct),
        usertimezone: attribute.attrs.usertimezone == null ? true : bool(attribute.attrs.usertimezone),
        definition: columnDefinition,
      };
      if (plan.aggregate) {
        if (!attribute.attrs.alias)
          fail(`An alias is required for the aggregate query attribute ${name}.`, 400, "InvalidFetchXml");
        if (!column.groupby && !column.aggregate)
          fail(
            `Attribute ${name} must specify an aggregate function or groupby in an aggregate query.`,
            400,
            "InvalidFetchXml",
          );
      } else if (column.aggregate || column.groupby)
        fail("Aggregate attributes require <fetch aggregate=\"true\">.", 400, "InvalidFetchXml");
      if (claim(key, column)) columns.push(column);
    }
    for (const link of children(node, "link-entity")) collectColumns(link, plan.aliasOf.get(link));
  };
  collectColumns(root, null);
  const allAttributeAliases = [];
  const collectAll = (node, alias) => {
    const type = node === root ? "inner" : (node.attrs["link-type"] ?? "inner");
    if (SEMI_JOIN_TYPES.has(type)) return;
    if (children(node, "all-attributes").length) {
      assertStructural(alias, "*", "attribute");
      allAttributeAliases.push(alias);
    }
    for (const link of children(node, "link-entity")) collectAll(link, plan.aliasOf.get(link));
  };
  collectAll(root, null);
  const rootAll = allAttributeAliases.includes(null) || !children(root, "attribute").length;

  // ---- ordering ----------------------------------------------------------
  const orderSpecs = [];
  for (const order of children(root, "order"))
    orderSpecs.push({ order, alias: order.attrs.entityname != null ? resolveEntityName(order.attrs.entityname) : null, linked: order.attrs.entityname != null && resolveEntityName(order.attrs.entityname) != null });
  const collectLinkOrders = (node) => {
    for (const link of children(node, "link-entity")) {
      if (SEMI_JOIN_TYPES.has(link.attrs["link-type"] ?? "inner")) continue;
      for (const order of children(link, "order"))
        orderSpecs.push({ order, alias: plan.aliasOf.get(link), linked: true });
      collectLinkOrders(link);
    }
  };
  collectLinkOrders(root);

  const total = { value: 0 };
  let entities, keys, cookieSupported;
  if (plan.aggregate) {
    ({ entities, keys } = aggregateRows());
    cookieSupported = false;
  } else {
    const specs = orderSpecs.map(({ order, alias }) => {
      if (order.attrs.alias && !order.attrs.attribute)
        fail("An order alias is valid only in aggregate queries.", 400, "InvalidFetchXml");
      const node = aliasNode(alias);
      assertStructural(alias, order.attrs.attribute, "condition");
      return {
        alias,
        attribute: order.attrs.attribute,
        descending: bool(order.attrs.descending),
        definition: definition(node, order.attrs.attribute),
      };
    });
    const pk = rootMapping.idColumn;
    const keyed = rows.map((row, index) => ({
      row,
      index,
      keys: specs.map((spec) =>
        sortKeyOf(fieldValue(spec.alias == null ? row.base : row.aliases[spec.alias], spec.attribute), spec.definition),
      ),
      pk: plan.distinct ? null : makeSortKey(row.base[pk], { definition: { dataverseType: "primarykey" } }),
    }));
    keyed.sort((a, b) => {
      for (let i = 0; i < specs.length; i++) {
        const result = compareSortKeys(a.keys[i], b.keys[i], collation);
        if (result) return specs[i].descending ? -result : result;
      }
      if (a.pk || b.pk) {
        const result = compareSortKeys(a.pk, b.pk, collation);
        if (result) return result;
      }
      return a.index - b.index;
    });
    let projected = keyed.map((entry) => ({ entity: project(entry.row), entry }));
    if (plan.distinct) {
      const seen = new Set();
      projected = projected.filter(({ entity, entry }) => {
        const signature = JSON.stringify([
          Object.keys(entity).sort().map((key) => [key, canonical(entity[key])]),
          entry.keys.map((key) => (key ? [key.t, key.v] : null)),
        ]);
        if (seen.has(signature)) return false;
        seen.add(signature);
        return true;
      });
    }
    entities = projected.map((item) => item.entity);
    keys = projected.map((item) => ({ ...item.entry, specs }));
    cookieSupported = !specs.some((spec) => spec.alias != null);
  }
  total.value = entities.length;

  // ---- paging ------------------------------------------------------------
  let start = 0,
    end = entities.length,
    more = false,
    pagingCookie = null;
  if (plan.top != null) end = Math.min(plan.top, entities.length);
  else {
    start = (plan.page - 1) * plan.pageSize;
    const cookie = plan.pagingCookie ? parsePagingCookie(plan.pagingCookie) : null;
    if (cookie && cookieSupported && !plan.distinct && cookie.page === plan.page - 1 && keys.length) {
      const seek = seekIndex(cookie, keys);
      if (seek != null) start = seek;
    }
    end = Math.min(start + plan.pageSize, entities.length);
    more = entities.length > start + plan.pageSize;
  }
  const pageEntities = entities.slice(start, end);
  if (plan.top == null && cookieSupported && pageEntities.length)
    pagingCookie = buildCookie(plan.page, keys.slice(start, end));
  const result = {
    entities: pageEntities,
    more_records: more,
    paging_cookie: pagingCookie,
    total_record_count: plan.returnTotal ? Math.min(total.value, FETCH_LIMITS.totalRecordCount) : -1,
    total_record_count_limit_exceeded: plan.returnTotal && total.value > FETCH_LIMITS.totalRecordCount,
    entity_name: rootMapping.logicalName,
  };
  Object.defineProperty(result, "columns", {
    value: {
      root: rootMapping.logicalName,
      idColumn: rootMapping.idColumn,
      aggregate: plan.aggregate,
      distinct: plan.distinct,
      page: plan.page,
      columns: columns.map(({ definition: _definition, ...column }) => column),
      aliases: Object.fromEntries(plan.links.map((link) => [plan.aliasOf.get(link), mappingOf.get(link).logicalName])),
      allAttributeAliases,
    },
    enumerable: false,
  });
  Object.defineProperty(result, "diagnostics", { value: plan.diagnostics ?? [], enumerable: false });
  Object.defineProperty(result, "stats", { value: stats, enumerable: false });
  return result;

  function project(row) {
    const out = {};
    const pk = rootMapping.idColumn;
    if (!plan.distinct && row.base[pk] != null) out[pk] = row.base[pk];
    if (rootAll)
      for (const [key, value] of Object.entries(row.base))
        if (!isEmpty(value) && !key.includes("@")) out[key] = structuredClone(value);
    for (const alias of allAttributeAliases) {
      if (alias == null) continue;
      for (const [key, value] of Object.entries(row.aliases[alias] ?? {}))
        if (!isEmpty(value) && !key.includes("@")) out[`${alias}.${key}`] = structuredClone(value);
    }
    // Distinct queries don't add the primary key implicitly; an explicitly
    // selected key (attribute element or all-attributes) is an ordinary column.
    for (const column of columns) {
      const source = column.alias == null ? row.base : row.aliases[column.alias];
      const value = fieldValue(source, column.attribute);
      if (!isEmpty(value)) out[column.key] = structuredClone(value);
      else delete out[column.key];
    }
    return out;
  }

  function aggregateRows() {
    let input = rows;
    const limit = plan.aggregateLimit;
    if (limit != null) input = input.slice(0, limit + 1);
    else if (input.length > FETCH_LIMITS.aggregateRecords)
      fail("AggregateQueryRecordLimit exceeded. Cannot perform this operation.", 400, "AggregateQueryRecordLimit", {
        innerCode: "0x8004e023",
      });
    const groups = columns.filter((column) => column.groupby);
    const aggregates = columns.filter((column) => column.aggregate);
    const read = (row, column) => fieldValue(column.alias == null ? row.base : row.aliases[column.alias], column.attribute);
    let fiscal;
    const groupValue = (row, column) => {
      const value = read(row, column);
      if (isEmpty(value)) return null;
      if (column.dategrouping)
        return dateGroupValue(value, column.dategrouping, {
          timeZoneOffsetMinutes: column.usertimezone ? Number(settings.timeZoneOffsetMinutes ?? 0) : 0,
          // fiscal-period and fiscal-year follow the organisation fiscal calendar.
          fiscal: /^fiscal-/.test(column.dategrouping) ? (fiscal ??= fiscalCalendar(settings)) : undefined,
        });
      return value;
    };
    const buckets = new Map();
    for (const row of input) {
      const values = groups.map((column) => groupValue(row, column));
      const signature = JSON.stringify(values.map(canonical));
      if (!buckets.has(signature)) buckets.set(signature, { values, rows: [] });
      buckets.get(signature).rows.push(row);
    }
    if (!groups.length && !buckets.size) buckets.set("[]", { values: [], rows: [] });
    const out = [...buckets.values()].map((bucket) => {
      const entity = {};
      groups.forEach((column, index) => {
        if (bucket.values[index] != null) entity[column.key] = structuredClone(bucket.values[index]);
      });
      for (const column of aggregates) {
        let values = bucket.rows.map((row) => read(row, column)).filter((value) => !isEmpty(value));
        if (column.distinct) {
          const seen = new Set();
          values = values.filter((value) => {
            const signature = JSON.stringify(canonical(value));
            if (seen.has(signature)) return false;
            seen.add(signature);
            return true;
          });
        }
        const numbers = () => values.map((value) => Number(scalar(value))).filter(Number.isFinite);
        let result;
        switch (column.aggregate) {
          case "count":
            result = bucket.rows.length;
            break;
          case "countcolumn":
            result = values.length;
            break;
          case "sum":
            result = numbers().reduce((sum, value) => sum + value, 0);
            break;
          case "avg": {
            const list = numbers();
            if (!list.length) result = null;
            else {
              const average = list.reduce((sum, value) => sum + value, 0) / list.length;
              const integer = ["int", "integer", "bigint"].includes(
                String(column.definition?.dataverseType ?? "").toLowerCase(),
              );
              result = integer ? Math.trunc(average) : average;
            }
            break;
          }
          case "min":
          case "max": {
            if (!values.length) {
              result = null;
              break;
            }
            const keyed = values.map((value) => ({
              value,
              key: makeSortKey(value, { definition: column.definition, rawChoice: true }),
            }));
            keyed.sort((a, b) => compareSortKeys(a.key, b.key, collation));
            const chosen = column.aggregate === "min" ? keyed[0].value : keyed.at(-1).value;
            const date = parseDateValue(chosen);
            result = typeof chosen === "string" && date && !date.dateOnly ? isoUtc(date.ms) : structuredClone(chosen);
            break;
          }
        }
        if (result != null) entity[column.key] = result;
      }
      return entity;
    });
    const specs = children(root, "order").map((order) => {
      const alias = order.attrs.alias;
      const column =
        (alias && columns.find((item) => item.key === alias)) ||
        (!alias && columns.find((item) => item.groupby && item.alias == null && item.attribute === order.attrs.attribute));
      if (!column)
        fail("An order element in an aggregate query must reference a groupby or aggregate alias.", 400, "InvalidFetchXml");
      return { column, descending: bool(order.attrs.descending) };
    });
    if (specs.length)
      out.sort((a, b) => {
        for (const spec of specs) {
          const result = compareSortKeys(
            makeSortKey(a[spec.column.key], { definition: spec.column.aggregate ? null : spec.column.definition, rawChoice: plan.rawChoiceOrder, lookupName }),
            makeSortKey(b[spec.column.key], { definition: spec.column.aggregate ? null : spec.column.definition, rawChoice: plan.rawChoiceOrder, lookupName }),
            collation,
          );
          if (result) return spec.descending ? -result : result;
        }
        return 0;
      });
    return { entities: out, keys: [] };
  }

  function seekIndex(cookie, keyed) {
    const specs = keyed[0].specs;
    const pk = rootMapping.idColumn;
    const lastValues = [];
    for (const spec of specs) {
      const entry = cookie.values.get(spec.attribute);
      if (!entry || entry.last == null) return null;
      const kind = String(spec.definition?.dataverseType ?? "").toLowerCase();
      if (["lookup", "customer", "owner", "picklist", "state", "status", "multiselectpicklist"].includes(kind)) return null;
      lastValues.push(makeSortKey(entry.last, { definition: spec.definition, rawChoice: true }));
    }
    const pkEntry = cookie.values.get(pk);
    if (!pkEntry?.last) return null;
    const lastPk = makeSortKey(pkEntry.last, { definition: { dataverseType: "primarykey" } });
    for (let index = 0; index < keyed.length; index++) {
      const item = keyed[index];
      let comparison = 0;
      for (let i = 0; i < specs.length && !comparison; i++) {
        const result = compareSortKeys(item.keys[i], lastValues[i], collation);
        comparison = specs[i].descending ? -result : result;
      }
      if (!comparison) comparison = compareSortKeys(item.pk, lastPk, collation);
      if (comparison > 0) return index;
    }
    return keyed.length;
  }

  function buildCookie(page, keyed) {
    const first = keyed[0],
      last = keyed.at(-1);
    const parts = [];
    const pk = rootMapping.idColumn;
    const seen = new Set();
    for (const spec of first.specs) {
      if (spec.alias != null || seen.has(spec.attribute) || spec.attribute === pk) continue;
      seen.add(spec.attribute);
      const read = (item) => fieldValue(item.row.base, spec.attribute);
      parts.push(
        `<${spec.attribute} last="${xmlEscapeAttribute(cookieValue(read(last)))}" first="${xmlEscapeAttribute(cookieValue(read(first)))}" />`,
      );
    }
    if (!plan.distinct)
      parts.push(
        `<${pk} last="${xmlEscapeAttribute(cookieValue(last.row.base[pk]))}" first="${xmlEscapeAttribute(cookieValue(first.row.base[pk]))}" />`,
      );
    return `<cookie page="${page}">${parts.join("")}</cookie>`;
  }
}

function canonical(value) {
  if (value == null) return null;
  if (typeof value === "object" && !Array.isArray(value)) {
    if (own(value, "id")) return ["ref", guidKey(value.id) ?? String(value.id)];
    if (own(value, "value")) return ["choice", value.value];
    return Object.keys(value)
      .sort()
      .map((key) => [key, canonical(value[key])]);
  }
  if (Array.isArray(value)) return value.map(canonical);
  const guid = guidKey(value);
  if (guid) return ["guid", guid];
  return value;
}
