// $expand rules for the simulated Dataverse Web API: option count, nested expansion limits,
// $ref and N:N checks, and the @odata.nextLink of an expanded collection.
// Pure functions over parseExpand() items. Errors are 400 0x80060888 DataErrors.
import { DataError } from "./data-error.mjs";
import { encodeSkipToken, skipTokenQueryValue } from "./dataverse-odata.mjs";

const MAX_EXPAND_OPTIONS = 15; // unverified: docs say "up to 15 $expand options in a query"; counted across nesting levels here
const PAGING_MESSAGE = "Only $select and $filter clause can be provided while doing $expand on many-to-one relationship or nested one-to-many relationship.";
const UNSUPPORTED_OPTION = /[;(]\s*\$(skip|count|search|levels)\s*=/;
const OPTION_KEYS = [["$select", "select"], ["$filter", "filter"], ["$orderby", "orderby"], ["$top", "top"]];

function invalid(message) {
  return new DataError(message, 400, "InvalidRequest", { innerCode: "0x80060888" });
}

/** Throws when raw $expand text uses $skip, $count, $search or $levels inside an option. Message unverified. */
export function assertExpandText(text) {
  const match = UNSUPPORTED_OPTION.exec(String(text ?? "").replace(/'(?:[^']|'')*'/g, "''"));
  if (match) throw invalid(`The expand option $${match[1]} is not supported in $expand.`); // unverified: message text
}

function countOptions(items) {
  return items.reduce((total, item) => total + 1 + countOptions(item.expand ?? []), 0);
}

/**
 * Validates parsed $expand items against a mapping.
 * resolveRelationship(mapping, navigation) returns { many, intersect?, target? } or null, where target is the related
 * mapping. Items may carry ref: true for nav/$ref, which parseExpand rejects, so the caller flags that form.
 */
export function assertExpand(items, mapping, resolveRelationship) {
  if (countOptions(items) > MAX_EXPAND_OPTIONS)
    throw invalid(`The number of $expand options exceeded the limit of ${MAX_EXPAND_OPTIONS}.`); // unverified: message text
  const nested = items.some((item) => item.expand?.length > 0);
  checkLevel(items, mapping, resolveRelationship, nested);
}

function checkLevel(items, mapping, resolveRelationship, nested) {
  for (const item of items) {
    const rel = resolveRelationship(mapping, item.navigation);
    if (!rel) throw new DataError(`Could not find a navigation property named '${item.navigation}' on ${mapping.logicalName}.`, 400, "InvalidAttribute");
    if (item.ref && rel.many) throw invalid("Expand with $ref is only supported on lookup type navigation property.");
    const hasNested = item.expand?.length > 0;
    if ((hasNested || nested) && rel.intersect)
      throw invalid(`The navigation property '${item.navigation}' cannot be expanded. Only many-to-one relationships are supported for nested expansion.`);
    if (rel.many && nested && (item.top != null || item.orderby)) throw invalid(PAGING_MESSAGE);
    if (!rel.many && (item.top != null || item.orderby)) throw invalid(PAGING_MESSAGE); // unverified: Dataverse may accept paging on a lookup
    // ponytail: nested children are not checked when the resolver gives no target mapping.
    if (hasNested && rel.target) checkLevel(item.expand, rel.target, resolveRelationship, nested);
  }
}

// Percent-encodes an option value, keeping the characters the documented nextLinks leave literal.
const encodeOption = (value) => encodeURIComponent(String(value)).replace(/%24/g, "$").replace(/%2C/g, ",").replace(/%3B/g, ";").replace(/%3D/g, "=");

/** The option pairs of one expand item, raw: $select, $filter, $orderby, $top and a nested $expand. */
function optionPairs(item) {
  const pairs = OPTION_KEYS.filter(([, key]) => item[key] != null && item[key] !== "").map(([name, key]) => `${name}=${item[key]}`);
  if (item.expand?.length) pairs.push(`$expand=${serializeExpand(item.expand)}`);
  return pairs;
}

function serializeExpand(items) {
  return items
    .map((item) => {
      const pairs = optionPairs(item);
      return pairs.length ? `${item.navigation}(${pairs.join(";")})` : item.navigation;
    })
    .join(",");
}

/**
 * @odata.nextLink of an expanded collection-valued navigation property: { key: "<nav>@odata.nextLink", url }.
 * options is the parsed expand item. A $skiptoken is added only when nested is true and a token object
 * (encodeSkipToken input, with countOfRecords) is given, which is the nested paging case.
 */
export function childLinks(origin, version, set, id, nav, options = {}, { nested = false, token } = {}) {
  const query = optionPairs(options).map((pair) => {
    const at = pair.indexOf("=");
    return `${pair.slice(0, at + 1)}${encodeOption(pair.slice(at + 1))}`;
  });
  if (nested && token) query.push(`$skiptoken=${skipTokenQueryValue(decodeURIComponent(encodeSkipToken(token)))}`);
  return {
    key: `${nav}@odata.nextLink`,
    url: `${origin}/api/data/${version}/${set}(${id})/${nav}${query.length ? `?${query.join("&")}` : ""}`,
  };
}
