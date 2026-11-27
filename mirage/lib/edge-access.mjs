// The hosted edge in front of a Power Pages site, as far as a local runtime can model it: the site's IP restriction
// allow list and its web application firewall (WAF) custom rules. Neither is in the export; both are per-site
// observations (observed.ipRestrictions, observed.firewall) recorded from the live site, for example with Lense
// readPowerPagesEdge (lense/dataverse/power-pages.mjs).
//
// IP restriction (hosted session F5, VERIFY-03e, two runs): once an allow list is set, a visitor whose address is not on
// it gets 403 on every path, with an Azure "Web App - Unavailable" HTML page, content-type text/html, an
// x-ms-forbidden-ip header naming the visitor's address and no site header.
//
// WAF custom rules: the rule shape is the Power Platform API's (Learn REST reference "Websites - Create Waf Rules",
// api-version 2024-10-01) and its evaluation follows Azure Front Door's custom rules (priority order, conditions joined
// with and, values with or). Hosted enforcement of a custom rule was not observed (F5: the firewall never reached
// Created), so this part is a local model. Where the local runtime cannot know the answer (a country match, match values
// the read withheld, a request body, a comparison whose result depends on letter case) it fails closed: a Block rule
// acts, an Allow rule does not, and the decision is logged. The managed rule set (DRS) is not modelled: its tuned rule
// content and anomaly thresholds are not published.
import net from 'node:net';

const MODES = ['Prevention', 'Detection'];
const ACTIONS = ['Allow', 'Block', 'Log'];
const RULE_TYPES = ['MatchRule', 'RateLimitRule'];
const OPERATORS = ['Contains', 'EndsWith', 'Equals', 'GeoMatch', 'StartsWith'];
const VARIABLES = [
  'RemoteAddr',
  'SocketAddr',
  'RequestMethod',
  'RequestUri',
  'QueryString',
  'RequestHeader',
  'Cookies',
  'PostArgs',
  'RequestBody',
];
const SELECTED = new Set(['RequestHeader', 'Cookies', 'PostArgs']);
const ADDRESSES = new Set(['RemoteAddr', 'SocketAddr']);
const TRANSFORMS = ['Lowercase', 'Uppercase', 'Trim', 'UrlDecode', 'UrlEncode', 'RemoveNulls'];
const RULE_KEYS = new Set([
  'name',
  'priority',
  'enabledState',
  'action',
  'ruleType',
  'rateLimitThreshold',
  'rateLimitDurationInMinutes',
  'matchConditions',
]);
const CONDITION_KEYS = new Set([
  'matchVariable',
  'operator',
  'negateCondition',
  'selector',
  'transforms',
  'values',
  'matchValue',
  'valueCount',
]);
const MAX_RULES = 100;
const MAX_CONDITIONS = 10;
const MAX_VALUES = 600;
const MAX_COUNTERS = 10_000;

const choice = (value, choices) =>
  choices.find((entry) => entry.toLowerCase() === String(value ?? '').toLowerCase()) ?? null;
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

// An address on its own family: an IPv4-mapped IPv6 address (::ffff:127.0.0.1) is the IPv4 address.
function normalAddress(value) {
  const text = String(value ?? '').trim();
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(text);
  const address = mapped ? mapped[1] : text;
  const family = net.isIP(address);
  return family ? { address: family === 6 ? address.toLowerCase() : address, family } : null;
}

// Parsed ranges by their text; the observed lists are bounded, so is this cache.
const RANGES = new Map();
const addressRange = (value) => {
  const key = String(value ?? '');
  if (!RANGES.has(key)) {
    if (RANGES.size >= MAX_COUNTERS) RANGES.clear();
    RANGES.set(key, parseRange(key));
  }
  return RANGES.get(key);
};

// One allow-list or match entry: an address, or a range in CIDR notation.
function parseRange(value) {
  const parts = String(value ?? '')
    .trim()
    .split('/');
  if (parts.length > 2) return null;
  const parsed = normalAddress(parts[0]);
  if (!parsed) return null;
  const bits = parsed.family === 4 ? 32 : 128;
  // Without a prefix the entry is the one address.
  const prefixText = parts.length === 2 ? parts[1] : String(bits);
  const prefix = Number(prefixText);
  if (!/^\d{1,3}$/.test(prefixText) || prefix > bits) return null;
  const list = new net.BlockList();
  list.addSubnet(parsed.address, prefix, parsed.family === 4 ? 'ipv4' : 'ipv6');
  return { text: `${parsed.address}/${prefix}`, family: parsed.family, list };
}
const inRange = (range, visitor) =>
  range.family === visitor.family && range.list.check(visitor.address, visitor.family === 4 ? 'ipv4' : 'ipv6');

/**
 * observed.ipRestrictions: the site's IP allow list. A list of addresses and CIDR ranges (or `{ ipAddress }` entries),
 * or `{ allowed, withheld }` as Lense readPowerPagesEdge reports it in `local.ipRestrictions.value`: `withheld` counts
 * the rows the read could not report. Without rows the site is not restricted, as online.
 * @returns {{ allowed: string[], withheld: number }} the normalized ranges (such as 203.0.113.7/32) and withheld rows
 */
export function observedIpRestrictions(value, label) {
  const list = plain(value) ? value.allowed : value;
  const withheld = plain(value) ? (value.withheld ?? 0) : 0;
  if (plain(value) && Object.keys(value).some((key) => !['allowed', 'withheld'].includes(key)))
    throw new Error(`${label} takes allowed and withheld`);
  if (!Array.isArray(list) || list.length > 1000)
    throw new Error(`${label} must be a list of at most 1000 allowed addresses or CIDR ranges`);
  if (!Number.isSafeInteger(withheld) || withheld < 0 || withheld > 1000)
    throw new Error(`${label}.withheld must count the allow-list rows the read withheld`);
  const allowed = list.map((entry, index) => {
    const text = plain(entry) ? (entry.ipAddress ?? entry.IpAddress) : entry;
    const range = typeof text === 'string' ? addressRange(text) : null;
    if (!range) throw new Error(`${label}[${index}] must be an IPv4 or IPv6 address or CIDR range`);
    return range.text;
  });
  return { allowed, withheld };
}

// values (Lense's name) or matchValue (the API's); null when the read withheld them (headers, cookies, bodies), and
// the selector with them.
function observedValues(condition, matchVariable, selector, label) {
  const values = condition.values !== undefined ? condition.values : (condition.matchValue ?? null);
  if (values === null) return null;
  if (SELECTED.has(matchVariable) && selector === null)
    throw new Error(`${label}.selector is required for ${matchVariable}`);
  const valid =
    Array.isArray(values) &&
    values.length > 0 &&
    values.length <= MAX_VALUES &&
    values.every((entry) => typeof entry === 'string' && entry.length <= 256);
  if (!valid)
    throw new Error(`${label}.values must be a non-empty list of strings, or null when the read withheld them`);
  return [...values];
}

function observedCondition(condition, label) {
  if (!plain(condition)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(condition))
    if (!CONDITION_KEYS.has(key)) throw new Error(`${label} has an unknown key '${key}'`);
  const matchVariable = choice(condition.matchVariable, VARIABLES);
  if (!matchVariable) throw new Error(`${label}.matchVariable must be one of ${VARIABLES.join(', ')}`);
  const operator = choice(condition.operator, OPERATORS);
  if (!operator) throw new Error(`${label}.operator must be one of ${OPERATORS.join(', ')}`);
  if (condition.negateCondition != null && typeof condition.negateCondition !== 'boolean')
    throw new Error(`${label}.negateCondition must be true or false`);
  const selector = condition.selector ?? null;
  if (selector !== null && (typeof selector !== 'string' || !selector.trim() || selector.length > 256))
    throw new Error(`${label}.selector must be a header, cookie or argument name`);
  const transforms = condition.transforms ?? [];
  if (!Array.isArray(transforms) || transforms.some((entry) => !choice(entry, TRANSFORMS)))
    throw new Error(`${label}.transforms must list ${TRANSFORMS.join(', ')}`);
  const values = observedValues(condition, matchVariable, selector, label);
  return {
    matchVariable,
    operator,
    negateCondition: condition.negateCondition === true,
    selector,
    transforms: transforms.map((entry) => choice(entry, TRANSFORMS)),
    values,
  };
}

function observedRule(rule, label) {
  if (!plain(rule)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(rule)) if (!RULE_KEYS.has(key)) throw new Error(`${label} has an unknown key '${key}'`);
  if (typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 128)
    throw new Error(`${label}.name must be the rule's name`);
  if (!Number.isSafeInteger(rule.priority) || rule.priority < 0)
    throw new Error(`${label}.priority must be a non-negative integer`);
  const action = choice(rule.action, ACTIONS);
  if (!action) throw new Error(`${label}.action must be ${ACTIONS.join(', ')}`);
  const ruleType = rule.ruleType == null ? 'MatchRule' : choice(rule.ruleType, RULE_TYPES);
  if (!ruleType) throw new Error(`${label}.ruleType must be ${RULE_TYPES.join(' or ')}`);
  const enabledState = rule.enabledState == null ? 'Enabled' : choice(rule.enabledState, ['Enabled', 'Disabled']);
  if (!enabledState) throw new Error(`${label}.enabledState must be Enabled or Disabled`);
  const conditions = rule.matchConditions;
  if (!Array.isArray(conditions) || !conditions.length || conditions.length > MAX_CONDITIONS)
    throw new Error(`${label}.matchConditions must list 1 to ${MAX_CONDITIONS} conditions`);
  const normalized = {
    name: rule.name,
    priority: rule.priority,
    enabledState,
    action,
    ruleType,
    matchConditions: conditions.map((condition, index) =>
      observedCondition(condition, `${label}.matchConditions[${index}]`),
    ),
  };
  if (ruleType === 'RateLimitRule') {
    const { rateLimitThreshold: threshold, rateLimitDurationInMinutes: minutes } = rule;
    // Learn (Power Pages WAF custom rules): the rate-limit window is 1 to 5 minutes.
    if (
      !Number.isSafeInteger(threshold) ||
      threshold < 1 ||
      !Number.isSafeInteger(minutes) ||
      minutes < 1 ||
      minutes > 5
    )
      throw new Error(`${label} needs rateLimitThreshold (at least 1) and rateLimitDurationInMinutes (1 to 5)`);
    normalized.rateLimitThreshold = threshold;
    normalized.rateLimitDurationInMinutes = minutes;
  }
  return normalized;
}

/**
 * observed.firewall: `{ mode?, customRules }`, the site's WAF policy mode (Prevention or Detection) and its custom
 * rules in the shape Lense readPowerPagesEdge reports (`firewall.customRules.rules`) or the Power Platform API takes.
 * @returns {{ mode: string|null, customRules: object[] }} rules in evaluation order (priority, then listed order)
 */
export function observedFirewall(value, label) {
  if (!plain(value)) throw new Error(`${label} must be an object such as { mode: Prevention, customRules: [...] }`);
  for (const key of Object.keys(value))
    if (!['mode', 'customRules'].includes(key)) throw new Error(`${label} has an unknown key '${key}'`);
  const mode = value.mode == null ? null : choice(value.mode, MODES);
  if (value.mode != null && !mode) throw new Error(`${label}.mode must be Prevention or Detection`);
  if (!Array.isArray(value.customRules) || value.customRules.length > MAX_RULES)
    throw new Error(`${label}.customRules must list at most ${MAX_RULES} rules`);
  const rules = value.customRules.map((rule, index) => observedRule(rule, `${label}.customRules[${index}]`));
  const names = rules.map((rule) => rule.name.toLowerCase());
  if (new Set(names).size !== names.length) throw new Error(`${label}.customRules names must be unique`);
  return {
    mode,
    customRules: rules
      .map((rule, index) => ({ rule, index }))
      .sort((left, right) => left.rule.priority - right.rule.priority || left.index - right.index)
      .map(({ rule }) => rule),
  };
}

// Why a condition cannot be decided locally for any request, or null.
function staticUnknown(condition) {
  if (condition.operator === 'GeoMatch') return 'a country match needs the hosted geolocation of the address';
  if (condition.values === null) return 'the read withheld its match values';
  return null;
}

/** Load-time diagnostics of the observed edge controls. */
export function edgeDiagnostics(observed) {
  const diagnostics = [];
  const ranges = observed?.ipRestrictions?.allowed ?? [];
  const withheld = observed?.ipRestrictions?.withheld ?? 0;
  if (withheld)
    diagnostics.push({
      code: 'PORTAL_EDGE_IP_RESTRICTION_WITHHELD',
      severity: 'warning',
      withheld,
      message: `The read withheld ${withheld} allow-list row(s): a visitor address not on the known entries is refused, failing closed.`,
    });
  if (ranges.length || withheld) {
    const loopback = ['127.0.0.1', '::1'].some((address) =>
      ranges.some((range) => inRange(addressRange(range), normalAddress(address))),
    );
    diagnostics.push({
      code: 'PORTAL_EDGE_IP_RESTRICTION',
      severity: loopback ? 'info' : 'warning',
      ranges: [...ranges],
      message: loopback
        ? 'The local portal applies the observed IP restriction: a visitor address outside the allow list gets the hosted 403 page.'
        : 'The local portal applies the observed IP restriction, and no loopback address is on the allow list: every portal request gets the hosted 403 page, as a visitor outside the list does online.',
    });
  }
  const firewall = observed?.firewall;
  if (!firewall) return diagnostics;
  diagnostics.push({
    code: 'PORTAL_EDGE_FIREWALL_LOCAL_MODEL',
    severity: 'info',
    rules: firewall.customRules.map((rule) => rule.name),
    message:
      'The local portal evaluates the observed WAF custom rules as Azure Front Door does; hosted enforcement and the hosted block response were not observed, and the managed rule set is not emulated.',
  });
  if (!firewall.mode)
    diagnostics.push({
      code: 'PORTAL_EDGE_FIREWALL_MODE_UNRECORDED',
      severity: 'warning',
      message:
        'observed.firewall names no mode: Block rules are enforced (Prevention), failing closed. Record the policy mode of the site.',
    });
  const undecided = firewall.customRules
    .filter((rule) => rule.enabledState === 'Enabled')
    .map((rule) => ({
      rule: rule.name,
      reasons: [...new Set(rule.matchConditions.map(staticUnknown).filter(Boolean))],
    }))
    .filter((entry) => entry.reasons.length);
  if (undecided.length)
    diagnostics.push({
      code: 'PORTAL_EDGE_FIREWALL_RULE_UNDECIDED',
      severity: 'warning',
      rules: undecided,
      message:
        'These WAF custom rules cannot be decided locally: a Block rule acts on every request it might match and an Allow rule never allows, failing closed.',
    });
  return diagnostics;
}

const TRANSFORM = {
  Lowercase: (text) => text.toLowerCase(),
  Uppercase: (text) => text.toUpperCase(),
  Trim: (text) => text.trim(),
  UrlDecode: (text) => {
    try {
      return decodeURIComponent(text.replaceAll('+', ' '));
    } catch {
      return text;
    }
  },
  UrlEncode: (text) => encodeURIComponent(text),
  RemoveNulls: (text) => text.replaceAll('\0', ''),
};

const hasBody = (req) =>
  req.headers['transfer-encoding'] !== undefined || Number(req.headers['content-length'] ?? 0) > 0;

function cookieValues(header, name) {
  const values = [];
  for (const part of String(header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) values.push(part.slice(at + 1).trim());
  }
  return values;
}

// The request's values of a match variable, or null when the local runtime cannot read them before the site.
function variableValues(condition, req, url, visitor) {
  switch (condition.matchVariable) {
    case 'RemoteAddr':
    case 'SocketAddr':
      // No proxy stands between the browser and the loopback listener: both are the connection's address.
      return visitor ? [visitor.address] : [];
    case 'RequestMethod':
      return [req.method];
    case 'RequestUri':
      // Learn (Power Pages WAF custom rules): "the requested path or query string".
      return [url.pathname + url.search];
    case 'QueryString':
      return url.search ? [url.search.slice(1)] : [];
    case 'RequestHeader': {
      const value = req.headers[condition.selector.toLowerCase()];
      if (value === undefined) return [];
      return Array.isArray(value) ? value : [value];
    }
    case 'Cookies':
      return cookieValues(req.headers.cookie, condition.selector);
    default:
      // PostArgs and RequestBody: the edge reads the body before the site; the local gate does not.
      return hasBody(req) ? null : [];
  }
}

function compare(operator, candidate, value) {
  if (operator === 'Contains') return candidate.includes(value);
  if (operator === 'StartsWith') return candidate.startsWith(value);
  if (operator === 'EndsWith') return candidate.endsWith(value);
  return candidate === value;
}

// true, false or 'unknown' (with its reason) for one condition.
function conditionResult(condition, req, url, visitor) {
  const fixed = staticUnknown(condition);
  if (fixed) return { result: 'unknown', reason: fixed };
  const read = variableValues(condition, req, url, visitor);
  if (!read) return { result: 'unknown', reason: 'the request body is not read before the site' };
  const candidates = read.map((value) =>
    condition.transforms.reduce((text, transform) => TRANSFORM[transform](text), String(value)),
  );
  let matched;
  if (ADDRESSES.has(condition.matchVariable) && condition.operator === 'Equals') {
    // An address Equals a value that is that address or a range holding it (local model of the IP match).
    const ranges = condition.values.map(addressRange);
    matched = candidates.some((candidate) => {
      const address = normalAddress(candidate);
      return Boolean(address) && ranges.some((range) => range && inRange(range, address));
    });
  } else {
    const any = (fold) =>
      candidates.some((candidate) =>
        condition.values.some((value) =>
          compare(condition.operator, fold ? candidate.toLowerCase() : candidate, fold ? value.toLowerCase() : value),
        ),
      );
    matched = any(false);
    // Whether the edge compares letter case is not established: a result that depends on it is unknown.
    if (matched !== any(true)) return { result: 'unknown', reason: 'the result depends on letter case' };
  }
  return { result: matched !== condition.negateCondition };
}

// A rule's conditions joined with and: false wins, then unknown, then true.
function ruleResult(rule, req, url, visitor) {
  let unknown = null;
  for (const condition of rule.matchConditions) {
    const { result, reason } = conditionResult(condition, req, url, visitor);
    if (result === false) return { result: false };
    if (result === 'unknown') unknown ??= reason;
  }
  return unknown ? { result: 'unknown', reason: unknown } : { result: true };
}

const FORBIDDEN_IP_BODY =
  '<!DOCTYPE html>\r\n<html>\r\n<head>\r\n    <title>Web App - Unavailable</title>\r\n</head>\r\n<body bgcolor="#00abec">\r\n    <div id="feature">\r\n        <div id="content">\r\n            <h1 id="unavailable">Error 403 - Forbidden</h1>\r\n            <p id="tryAgain">The web app you have attempted to reach has blocked your access.</p>\r\n        </div>\r\n    </div>\r\n</body>\r\n</html>\r\n';
const FIREWALL_BLOCK_BODY =
  '<!DOCTYPE html><html><head><title>Request blocked</title></head><body><h1>The request is blocked.</h1></body></html>';

// Requests per rule and client address in the rule's window (a rate-limit rule's count).
function rateCounters(now) {
  const counters = new Map();
  return (rule, visitor) => {
    const time = now();
    const key = `${rule.name.toLowerCase()}\u0000${visitor?.address ?? ''}`;
    const windowMs = rule.rateLimitDurationInMinutes * 60_000;
    let counter = counters.get(key);
    if (!counter || time - counter.start >= windowMs) {
      if (!counter && counters.size >= MAX_COUNTERS)
        for (const [name, entry] of counters) if (time - entry.start >= windowMs) counters.delete(name);
      counter = { start: time, count: 0 };
      counters.set(key, counter);
    }
    counter.count += 1;
    return counter.count > rule.rateLimitThreshold;
  };
}

// The outcome of a rule that admits the request.
const ALLOWED = Object.freeze({ allowed: true });

// One rule's outcome for the request: null when it does not apply, ALLOWED when it admits the request, else the event
// to log (enforced: the rule blocks the request).
function ruleOutcome(rule, firewall, request, rateExceeded) {
  if (rule.enabledState !== 'Enabled') return null;
  const { result, reason } = ruleResult(rule, request.req, request.url, request.visitor);
  if (result === false) return null;
  // Fail closed: an undecided rule never allows, and blocks as if it matched.
  if (rule.action === 'Allow')
    return result === true ? ALLOWED : { rule: rule.name, action: 'Allow', decided: false, enforced: false, reason };
  if (rule.ruleType === 'RateLimitRule' && !rateExceeded(rule, request.visitor)) return null;
  const enforced = rule.action === 'Block' && firewall.mode !== 'Detection';
  const event = { rule: rule.name, action: rule.action, decided: result === true, enforced };
  return reason ? { ...event, reason } : event;
}

// The rule that blocks the request, or null; `events` receives every rule that matched or might have.
function firewallDecision(firewall, request, events, rateExceeded) {
  for (const rule of firewall.customRules) {
    const outcome = ruleOutcome(rule, firewall, request, rateExceeded);
    if (outcome === ALLOWED) return null;
    if (!outcome) continue;
    events.push(outcome);
    if (outcome.enforced) return rule;
  }
  return null;
}

const firewallRefusal = (rule) => ({
  status: 403,
  code: 'PORTAL_EDGE_FIREWALL_BLOCKED',
  message: `The WAF custom rule ${rule.name} blocked the request.`,
  headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  body: FIREWALL_BLOCK_BODY,
});
const ipRefusal = (visitor) => ({
  status: 403,
  code: 'PORTAL_EDGE_IP_FORBIDDEN',
  message: 'The visitor address is not on the site IP restriction allow list.',
  headers: { 'content-type': 'text/html', 'x-ms-forbidden-ip': visitor?.address ?? '' },
  body: FORBIDDEN_IP_BODY,
});
const listed = (ranges, visitor) => Boolean(visitor && ranges.some((range) => inRange(addressRange(range), visitor)));
// An event for a visitor the known entries do not admit while rows were withheld: it might be on one (fail closed).
const withheldEvent = (withheld) => ({
  rule: 'IP restriction allow list',
  action: 'Block',
  decided: false,
  enforced: true,
  reason: `the read withheld ${withheld} allow-list row(s)`,
});

/**
 * The local edge gate. `check(req, url)` answers `{ refusal, events }`: refusal is null to admit the request, else the
 * response the edge sends instead of the site; events name the rules that matched (or might have) for the log.
 * @param {{ observed: () => object|null, now?: () => number }} options
 */
export function createEdgeAccess({ observed, now = () => Date.now() }) {
  const rateExceeded = rateCounters(now);
  return {
    check(req, url) {
      const site = observed();
      const events = [];
      const visitor = normalAddress(req.socket?.remoteAddress);
      // The WAF runs at the front door, before the web app's IP restriction.
      const rule = site?.firewall ? firewallDecision(site.firewall, { req, url, visitor }, events, rateExceeded) : null;
      if (rule) return { events, refusal: firewallRefusal(rule) };
      const { allowed = [], withheld = 0 } = site?.ipRestrictions ?? {};
      if ((allowed.length || withheld) && !listed(allowed, visitor)) {
        if (withheld) events.push(withheldEvent(withheld));
        return { events, refusal: ipRefusal(visitor) };
      }
      return { events, refusal: null };
    },
  };
}
