// Global Discovery service: the service document, $metadata and the Instances entity set.
// Pure: the instance comes from the caller, and key predicates and $filter are evaluated here.
import { DataError } from './data-error.mjs';

// Docs show versioned paths (/api/discovery/v9.1/) beside v2.0, so any vN.N is served.
const PATH = /^\/api\/discovery\/v(\d+\.\d+)(?:\/(\$metadata|Instances(?:\((.*)\))?))?\/?$/;
const NAMESPACE = 'Microsoft.Dynamics.CRM'; // CSDL namespace of the Instance type is a guess
const KEYS = 'OData.Community.Keys.V1';
const EDM = 'http://docs.oasis-open.org/odata/ns/edm';
// Property order is the CSDL and response order. Types are CSDL names.
const PROPERTIES = {
  ApiUrl: 'Edm.String',
  DatacenterId: 'Edm.String',
  DatacenterName: 'Edm.String',
  EnvironmentId: 'Edm.String',
  FriendlyName: 'Edm.String',
  Id: 'Edm.Guid',
  IsUserSysAdmin: 'Edm.Boolean',
  LastUpdated: 'Edm.DateTimeOffset',
  OrganizationType: 'Edm.Int32',
  Purpose: 'Edm.String',
  Region: 'Edm.String',
  SchemaType: 'Edm.String',
  State: 'Edm.Int32',
  StatusMessage: 'Edm.Int32',
  TenantId: 'Edm.Guid',
  TrialExpirationDate: 'Edm.DateTimeOffset',
  UniqueName: 'Edm.String',
  UrlName: 'Edm.String',
  Url: 'Edm.String',
  Version: 'Edm.String',
};
// Values a caller's instance may omit. StatusMessage 6 and OrganizationType 0 are guessed defaults.
const DEFAULTS = { DatacenterName: null, IsUserSysAdmin: false, State: 0, StatusMessage: 6, OrganizationType: 0 };
// Id is the key; these are the alternate keys that Instances(name=value) accepts.
const ALTERNATE_KEYS = ['UniqueName', 'Region', 'State', 'Version'];
const FUNCTIONS = ['contains', 'startswith', 'endswith'];
const COMPARISONS = ['eq', 'ne', 'gt', 'ge', 'lt', 'le'];
const KEYWORDS = ['and', 'or', 'not', ...COMPARISONS];
// Unquoted DateTimeOffset literals (2022-07-14T00:00:00Z) are matched before numbers, which would take their year.
const TOKEN =
  /(\{?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}?)|(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2}))|'((?:[^']|'')*)'|(-?\d+(?:\.\d+)?)|([A-Za-z_]\w*)|([(),=])/iy;
// $filter nesting (parentheses, function arguments and `not`) past this answers 400 instead of overflowing the stack.
const MAX_NESTING = 100;

function invalid(message, code = 'InvalidQuery') {
  return new DataError(message, 400, code);
}

// Milliseconds of a DateTimeOffset value (a literal already holds them), or null when it has none.
const instant = (value) => {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
};

function tokenize(text) {
  const tokens = [];
  let index = 0;
  for (;;) {
    while (index < text.length && /\s/.test(text[index])) index++;
    if (index >= text.length) return tokens;
    TOKEN.lastIndex = index;
    const match = TOKEN.exec(text);
    if (!match) throw invalid(`Invalid query expression near '${text.slice(index, index + 20)}'.`);
    const [source, guid, dateTime, string, number, word] = match;
    index = TOKEN.lastIndex;
    if (guid) tokens.push({ kind: 'lit', guid: true, value: guid.replace(/[{}]/g, '').toLowerCase(), text: source });
    else if (dateTime) {
      const ms = Date.parse(dateTime);
      if (Number.isNaN(ms)) throw invalid(`Invalid query expression near '${source}'.`);
      tokens.push({ kind: 'lit', date: true, value: ms, text: source });
    } else if (string !== undefined) tokens.push({ kind: 'lit', value: string.replace(/''/g, "'"), text: source });
    else if (number) tokens.push({ kind: 'lit', value: Number(number), text: source });
    else if (word) tokens.push({ kind: 'word', value: word, text: source });
    else tokens.push({ kind: 'punct', value: source, text: source });
  }
}

// Key predicates: a GUID is Id, otherwise Name=literal for an alternate key.
function keyPredicate(text) {
  const tokens = tokenize(text);
  const [first, second, third] = tokens;
  const invalidKey = () => new DataError(`Invalid key predicate '${text}'.`, 400, 'InvalidKey');
  if (tokens.length === 1 && first.guid)
    return comparison('eq', { kind: 'prop', name: 'Id' }, { kind: 'lit', value: first.value });
  if (
    tokens.length === 3 &&
    first.kind === 'word' &&
    second.value === '=' &&
    third.kind === 'lit' &&
    !third.date &&
    ALTERNATE_KEYS.includes(first.value)
  ) {
    return comparison('eq', { kind: 'prop', name: first.value }, { kind: 'lit', value: third.value });
  }
  throw invalidKey();
}

function comparison(op, left, right) {
  return { kind: 'cmp', op, left, right };
}

// $filter grammar, lowest precedence first: or, and, not, comparison, primary.
function parseFilter(text) {
  const tokens = tokenize(text);
  let pos = 0;
  const peek = () => tokens[pos];
  const take = () => tokens[pos++];
  const isWord = (token, word) => token?.kind === 'word' && token.value.toLowerCase() === word;
  const fail = (token) => invalid(`Invalid $filter expression near '${token?.text ?? 'end of input'}'.`);
  const expectPunct = (value) => {
    const token = take();
    if (token?.kind !== 'punct' || token.value !== value) throw fail(token);
  };

  // Every parenthesised group, function argument and `not` nests here; the count bounds the recursion.
  let depth = 0;
  const nested = (parse) => {
    if (++depth > MAX_NESTING) throw invalid('The $filter expression is nested too deeply.');
    try {
      return parse();
    } finally {
      depth -= 1;
    }
  };

  function orExpr() {
    return nested(() => {
      let node = andExpr();
      while (isWord(peek(), 'or')) {
        take();
        node = { kind: 'or', left: node, right: andExpr() };
      }
      return node;
    });
  }

  function andExpr() {
    let node = notExpr();
    while (isWord(peek(), 'and')) {
      take();
      node = { kind: 'and', left: node, right: notExpr() };
    }
    return node;
  }

  function notExpr() {
    if (!isWord(peek(), 'not')) return comparisonExpr();
    take();
    return nested(() => ({ kind: 'not', arg: notExpr() }));
  }

  function comparisonExpr() {
    const left = primary();
    const op = peek()?.kind === 'word' ? peek().value.toLowerCase() : null;
    if (!COMPARISONS.includes(op)) return left;
    take();
    return comparison(op, left, primary());
  }

  function primary() {
    const token = take();
    if (!token) throw fail(token);
    if (token.kind === 'punct' && token.value === '(') {
      const node = orExpr();
      expectPunct(')');
      return node;
    }
    if (token.kind === 'lit') return { kind: 'lit', value: token.value, date: token.date };
    if (token.kind !== 'word') throw fail(token);
    const word = token.value.toLowerCase();
    if (word === 'true' || word === 'false') return { kind: 'lit', value: word === 'true' };
    if (word === 'null') return { kind: 'lit', value: null };
    if (FUNCTIONS.includes(word) && peek()?.value === '(') {
      take();
      const subject = orExpr();
      expectPunct(',');
      const argument = orExpr();
      expectPunct(')');
      return { kind: 'fn', name: word, args: [subject, argument] };
    }
    if (KEYWORDS.includes(word)) throw fail(token);
    if (!Object.hasOwn(PROPERTIES, token.value))
      throw invalid(`Could not find a property named '${token.value}' on type 'Instance'.`);
    return { kind: 'prop', name: token.value };
  }

  const ast = orExpr();
  if (pos < tokens.length) throw fail(tokens[pos]);
  return ast;
}

function evaluate(node, row) {
  switch (node.kind) {
    case 'prop':
      return row[node.name];
    case 'lit':
      return node.value;
    case 'not':
      return !evaluate(node.arg, row);
    case 'and':
      return Boolean(evaluate(node.left, row) && evaluate(node.right, row));
    case 'or':
      return Boolean(evaluate(node.left, row) || evaluate(node.right, row));
    case 'fn': {
      const [subject, argument] = node.args.map((arg) => evaluate(arg, row));
      if (typeof subject !== 'string' || typeof argument !== 'string') return false;
      // String comparison is case-sensitive here, unlike Dataverse.
      if (node.name === 'contains') return subject.includes(argument);
      return node.name === 'startswith' ? subject.startsWith(argument) : subject.endsWith(argument);
    }
    case 'cmp': {
      let left = evaluate(node.left, row);
      let right = evaluate(node.right, row);
      if (node.left.date || node.right.date) {
        // A stored value and a literal can differ in offset or fraction text, so dates compare as instants.
        left = instant(left);
        right = instant(right);
        if (left == null || right == null) return false;
      }
      if (node.op === 'eq') return left === right;
      if (node.op === 'ne') return left !== right;
      if (left == null || right == null) return false;
      // Strings order ordinally and case-sensitively (a guess).
      if (node.op === 'gt') return left > right;
      if (node.op === 'ge') return left >= right;
      if (node.op === 'lt') return left < right;
      return left <= right;
    }
    default:
      throw new Error(`Unknown filter node ${node.kind}`);
  }
}

function parseSelect(text) {
  if (text == null || text.trim() === '' || text.trim() === '*') return null;
  return text.split(',').map((name) => {
    const trimmed = name.trim();
    if (!Object.hasOwn(PROPERTIES, trimmed))
      throw invalid(`Could not find a property named '${trimmed}' on type 'Instance'.`);
    return trimmed;
  });
}

// Every property gets a value: defaults fill gaps, and Guid values are lower-cased so Id and TenantId compare the same way as their literals.
function toRecord(source) {
  const merged = { ...DEFAULTS, ...source };
  const row = {};
  for (const [name, type] of Object.entries(PROPERTIES)) {
    const value = merged[name] ?? null;
    row[name] = type === 'Edm.Guid' && typeof value === 'string' ? value.toLowerCase() : value;
  }
  return row;
}

function metadataDocument() {
  const properties = Object.entries(PROPERTIES).map(
    ([name, type]) => `        <Property Name="${name}" Type="${type}"${name === 'Id' ? ' Nullable="false"' : ''}/>`,
  );
  // The alternate key annotation mirrors dataverse-metadata.mjs; the native shape for this entity is a guess.
  const alternateKeys = ALTERNATE_KEYS.map(
    (name) =>
      `            <Record Type="${KEYS}.AlternateKey"><PropertyValue Property="Key"><Collection><Record Type="${KEYS}.PropertyRef"><PropertyValue Property="Alias" String="${name}"/><PropertyValue Property="Name" PropertyPath="${name}"/></Record></Collection></PropertyValue></Record>`,
  );
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<edmx:Edmx Version="4.0" xmlns:edmx="http://docs.oasis-open.org/odata/ns/edmx">',
    '  <edmx:DataServices>',
    `    <Schema Namespace="${NAMESPACE}" xmlns="${EDM}">`,
    '      <EntityType Name="Instance">',
    '        <Key><PropertyRef Name="Id"/></Key>',
    ...properties,
    `        <Annotation Term="${KEYS}.AlternateKeys"><Collection>`,
    ...alternateKeys,
    '        </Collection></Annotation>',
    '      </EntityType>',
    `      <EntityContainer Name="Default"><EntitySet Name="Instances" EntityType="${NAMESPACE}.Instance"/></EntityContainer>`,
    '    </Schema>',
    '  </edmx:DataServices>',
    '</edmx:Edmx>',
  ].join('\n');
}

/** Builds the Global Discovery handler. `instance()` returns the caller's instance object (see DEFAULTS for values it may omit). */
export function createDiscovery({ instance }) {
  function handle({ pathname, searchParams, origin }) {
    const path = String(pathname ?? '');
    const match = PATH.exec(path);
    if (!match) {
      const segment = path.split('/').filter(Boolean).at(-1) ?? '';
      throw new DataError(`Resource not found for the segment '${segment}'.`, 404, 'UnknownResource', { segment });
    }
    const [, version, target, keyText] = match;
    const base = `${origin}/api/discovery/v${version}`;
    if (target === undefined) {
      return {
        status: 200,
        body: {
          '@odata.context': `${base}/$metadata`,
          value: [{ name: 'Instances', kind: 'EntitySet', url: 'Instances' }],
        },
      };
    }
    if (target === '$metadata') {
      return { status: 200, headers: { 'content-type': 'application/xml; charset=utf-8' }, body: metadataDocument() };
    }

    let rows = [toRecord(instance())];
    if (keyText !== undefined) {
      let decoded;
      try {
        decoded = decodeURIComponent(keyText);
      } catch {
        throw new DataError(`Invalid key predicate '${keyText}'.`, 400, 'InvalidKey');
      }
      const key = keyPredicate(decoded);
      rows = rows.filter((row) => evaluate(key, row));
    }
    const filter = searchParams?.get('$filter');
    if (filter?.trim()) {
      const ast = parseFilter(filter);
      rows = rows.filter((row) => evaluate(ast, row));
    }
    const select = parseSelect(searchParams?.get('$select'));
    const names = select ?? Object.keys(PROPERTIES);
    const value = rows.map((row) => Object.fromEntries(names.map((name) => [name, row[name]])));
    const context = `${base}/$metadata#Instances${select ? `(${select.join(',')})` : ''}`;
    return { status: 200, body: { '@odata.context': context, value } };
  }

  return { handle };
}
