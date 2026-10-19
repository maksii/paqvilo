// Global Discovery service: the service document, $metadata and the Instances entity set.
// Pure: the instance comes from the caller, and key predicates and $filter are evaluated here.
import { DataError } from "./data-error.mjs";

// Docs show versioned paths (/api/discovery/v9.1/) beside v2.0, so any vN.N is served.
const PATH = /^\/api\/discovery\/v(\d+\.\d+)(?:\/(\$metadata|Instances(?:\((.*)\))?))?\/?$/;
const NAMESPACE = "Microsoft.Dynamics.CRM"; // unverified: CSDL namespace of the Instance type
const KEYS = "OData.Community.Keys.V1";
const EDM = "http://docs.oasis-open.org/odata/ns/edm";
// Property order is the CSDL and response order. Types are CSDL names.
const PROPERTIES = {
  ApiUrl: "Edm.String",
  DatacenterId: "Edm.String",
  DatacenterName: "Edm.String",
  EnvironmentId: "Edm.String",
  FriendlyName: "Edm.String",
  Id: "Edm.Guid",
  IsUserSysAdmin: "Edm.Boolean",
  LastUpdated: "Edm.DateTimeOffset",
  OrganizationType: "Edm.Int32",
  Purpose: "Edm.String",
  Region: "Edm.String",
  SchemaType: "Edm.String",
  State: "Edm.Int32",
  StatusMessage: "Edm.Int32",
  TenantId: "Edm.Guid",
  TrialExpirationDate: "Edm.DateTimeOffset",
  UniqueName: "Edm.String",
  UrlName: "Edm.String",
  Url: "Edm.String",
  Version: "Edm.String",
};
// Values a caller's instance may omit. unverified: StatusMessage 6 and OrganizationType 0 are defaults chosen here, not seen in a live response.
const DEFAULTS = { DatacenterName: null, IsUserSysAdmin: false, State: 0, StatusMessage: 6, OrganizationType: 0 };
// Id is the key; these are the alternate keys that Instances(name=value) accepts.
const ALTERNATE_KEYS = ["UniqueName", "Region", "State", "Version"];
const FUNCTIONS = ["contains", "startswith", "endswith"];
const COMPARISONS = ["eq", "ne", "gt", "ge", "lt", "le"];
const KEYWORDS = ["and", "or", "not", ...COMPARISONS];
const TOKEN = /(\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?)|'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|([A-Za-z_]\w*)|([(),=])/iy;

function invalid(message, code = "InvalidQuery") {
  return new DataError(message, 400, code);
}

function tokenize(text) {
  const tokens = [];
  let index = 0;
  for (;;) {
    while (index < text.length && /\s/.test(text[index])) index++;
    if (index >= text.length) return tokens;
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(text);
    if (!match) throw invalid(`Invalid query expression near '${text.slice(index, index + 20)}'.`);
    const [source, guid, string, number, word] = match;
    index = TOKEN.lastIndex;
    if (guid) tokens.push({ kind: "lit", guid: true, value: guid.replace(/[{}]/g, "").toLowerCase(), text: source });
    else if (string !== undefined) tokens.push({ kind: "lit", value: string.replace(/''/g, "'"), text: source });
    else if (number) tokens.push({ kind: "lit", value: Number(number), text: source });
    else if (word) tokens.push({ kind: "word", value: word, text: source });
    else tokens.push({ kind: "punct", value: source, text: source });
  }
}

// Key predicates: a GUID is Id, otherwise Name=literal for an alternate key.
function keyPredicate(text) {
  const tokens = tokenize(text);
  const [first, second, third] = tokens;
  const invalidKey = () => new DataError(`Invalid key predicate '${text}'.`, 400, "InvalidKey");
  if (tokens.length === 1 && first.guid) return comparison("eq", { kind: "prop", name: "Id" }, { kind: "lit", value: first.value });
  if (tokens.length === 3 && first.kind === "word" && second.value === "=" && third.kind === "lit" && ALTERNATE_KEYS.includes(first.value)) {
    return comparison("eq", { kind: "prop", name: first.value }, { kind: "lit", value: third.value });
  }
  throw invalidKey();
}

function comparison(op, left, right) {
  return { kind: "cmp", op, left, right };
}

// $filter grammar, lowest precedence first: or, and, not, comparison, primary.
function parseFilter(text) {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const isWord = (token, word) => token?.kind === "word" && token.value.toLowerCase() === word;
  const fail = (token) => invalid(`Invalid $filter expression near '${token?.text ?? "end of input"}'.`);
  const expectPunct = (value) => {
    const token = take();
    if (token?.kind !== "punct" || token.value !== value) throw fail(token);
  };

  function orExpr() {
    let node = andExpr();
    while (isWord(peek(), "or")) {
      take();
      node = { kind: "or", left: node, right: andExpr() };
    }
    return node;
  }

  function andExpr() {
    let node = notExpr();
    while (isWord(peek(), "and")) {
      take();
      node = { kind: "and", left: node, right: notExpr() };
    }
    return node;
  }

  function notExpr() {
    if (!isWord(peek(), "not")) return comparisonExpr();
    take();
    return { kind: "not", arg: notExpr() };
  }

  function comparisonExpr() {
    const left = primary();
    const op = peek()?.kind === "word" ? peek().value.toLowerCase() : null;
    if (!COMPARISONS.includes(op)) return left;
    take();
    return comparison(op, left, primary());
  }

  function primary() {
    const token = take();
    if (!token) throw fail(token);
    if (token.kind === "punct" && token.value === "(") {
      const node = orExpr();
      expectPunct(")");
      return node;
    }
    if (token.kind === "lit") return { kind: "lit", value: token.value };
    if (token.kind !== "word") throw fail(token);
    const word = token.value.toLowerCase();
    if (word === "true" || word === "false") return { kind: "lit", value: word === "true" };
    if (word === "null") return { kind: "lit", value: null };
    if (FUNCTIONS.includes(word) && peek()?.value === "(") {
      take();
      const subject = orExpr();
      expectPunct(",");
      const argument = orExpr();
      expectPunct(")");
      return { kind: "fn", name: word, args: [subject, argument] };
    }
    if (KEYWORDS.includes(word)) throw fail(token);
    if (!Object.hasOwn(PROPERTIES, token.value)) throw invalid(`Could not find a property named '${token.value}' on type 'Instance'.`);
    return { kind: "prop", name: token.value };
  }

  const ast = orExpr();
  if (pos < tokens.length) throw fail(tokens[pos]);
  return ast;
}

function evaluate(node, row) {
  switch (node.kind) {
    case "prop":
      return row[node.name];
    case "lit":
      return node.value;
    case "not":
      return !evaluate(node.arg, row);
    case "and":
      return Boolean(evaluate(node.left, row) && evaluate(node.right, row));
    case "or":
      return Boolean(evaluate(node.left, row) || evaluate(node.right, row));
    case "fn": {
      const [subject, argument] = node.args.map((arg) => evaluate(arg, row));
      if (typeof subject !== "string" || typeof argument !== "string") return false;
      // unverified: string comparison is case-sensitive here (the brief's rule), unlike Dataverse.
      if (node.name === "contains") return subject.includes(argument);
      return node.name === "startswith" ? subject.startsWith(argument) : subject.endsWith(argument);
    }
    case "cmp": {
      const left = evaluate(node.left, row);
      const right = evaluate(node.right, row);
      if (node.op === "eq") return left === right;
      if (node.op === "ne") return left !== right;
      if (left == null || right == null) return false;
      // unverified: ordering is ordinal and case-sensitive; dates compare as ISO text.
      if (node.op === "gt") return left > right;
      if (node.op === "ge") return left >= right;
      if (node.op === "lt") return left < right;
      return left <= right;
    }
    default:
      throw new Error(`Unknown filter node ${node.kind}`);
  }
}

function parseSelect(text) {
  if (text == null || text.trim() === "" || text.trim() === "*") return null;
  return text.split(",").map((name) => {
    const trimmed = name.trim();
    if (!Object.hasOwn(PROPERTIES, trimmed)) throw invalid(`Could not find a property named '${trimmed}' on type 'Instance'.`);
    return trimmed;
  });
}

// Every property gets a value: defaults fill gaps, and Guid values are lower-cased so Id and TenantId compare the same way as their literals.
function toRecord(source) {
  const merged = { ...DEFAULTS, ...source };
  const row = {};
  for (const [name, type] of Object.entries(PROPERTIES)) {
    const value = merged[name] ?? null;
    row[name] = type === "Edm.Guid" && typeof value === "string" ? value.toLowerCase() : value;
  }
  return row;
}

function metadataDocument() {
  const properties = Object.entries(PROPERTIES).map(([name, type]) => `        <Property Name="${name}" Type="${type}"${name === "Id" ? ' Nullable="false"' : ""}/>`);
  // unverified: the alternate key annotation mirrors dataverse-metadata.mjs; Dataverse's exact shape for this entity is not confirmed.
  const alternateKeys = ALTERNATE_KEYS.map((name) => `            <Record Type="${KEYS}.AlternateKey"><PropertyValue Property="Key"><Collection><Record Type="${KEYS}.PropertyRef"><PropertyValue Property="Alias" String="${name}"/><PropertyValue Property="Name" PropertyPath="${name}"/></Record></Collection></PropertyValue></Record>`);
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">',
    "  <edmx:DataServices>",
    `    <Schema Namespace="${NAMESPACE}" xmlns="${EDM}">`,
    '      <EntityType Name="Instance">',
    '        <Key><PropertyRef Name="Id"/></Key>',
    ...properties,
    `        <Annotation Term="${KEYS}.AlternateKeys"><Collection>`,
    ...alternateKeys,
    "        </Collection></Annotation>",
    "      </EntityType>",
    `      <EntityContainer Name="Default"><EntitySet Name="Instances" EntityType="${NAMESPACE}.Instance"/></EntityContainer>`,
    "    </Schema>",
    "  </edmx:DataServices>",
    "</edmx:Edmx>",
  ].join("\n");
}

/** Builds the Global Discovery handler. `instance()` returns the caller's instance object (see DEFAULTS for values it may omit). */
export function createDiscovery({ instance }) {
  function handle({ pathname, searchParams, origin }) {
    const path = String(pathname ?? "");
    const match = PATH.exec(path);
    if (!match) {
      const segment = path.split("/").filter(Boolean).at(-1) ?? "";
      throw new DataError(`Resource not found for the segment '${segment}'.`, 404, "UnknownResource", { segment });
    }
    const [, version, target, keyText] = match;
    const base = `${origin}/api/discovery/v${version}`;
    if (target === undefined) {
      return { status: 200, body: { "@odata.context": `${base}/$metadata`, value: [{ name: "Instances", kind: "EntitySet", url: "Instances" }] } };
    }
    if (target === "$metadata") {
      return { status: 200, headers: { "content-type": "application/xml; charset=utf-8" }, body: metadataDocument() };
    }

    let rows = [toRecord(instance())];
    if (keyText !== undefined) {
      let decoded;
      try {
        decoded = decodeURIComponent(keyText);
      } catch {
        throw new DataError(`Invalid key predicate '${keyText}'.`, 400, "InvalidKey");
      }
      const key = keyPredicate(decoded);
      rows = rows.filter((row) => evaluate(key, row));
    }
    const filter = searchParams?.get("$filter");
    if (filter?.trim()) {
      const ast = parseFilter(filter);
      rows = rows.filter((row) => evaluate(ast, row));
    }
    const select = parseSelect(searchParams?.get("$select"));
    const names = select ?? Object.keys(PROPERTIES);
    const value = rows.map((row) => Object.fromEntries(names.map((name) => [name, row[name]])));
    const context = `${base}/$metadata#Instances${select ? `(${select.join(",")})` : ""}`;
    return { status: 200, body: { "@odata.context": context, value } };
  }

  return { handle };
}
