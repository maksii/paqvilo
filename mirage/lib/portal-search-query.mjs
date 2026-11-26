import { searchTokens } from './dataverse-search.mjs';

const MAX_QUERY_LENGTH = 1024;
const MAX_GROUP_DEPTH = 16;
const QUOTED_TOKEN = /[+-]?"[^"]*"(?:\^\d+(?:\.\d+)?)?/uy;
const ORDINARY_TOKEN = /[^\s"()&|!]+|\|\||&&|[()!]/uy;
const TERM_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}*?]*/gu;
const ANY = new Set(['OR', '||']);
const ALL = new Set(['AND', '&&']);
const EXCLUDE = new Set(['NOT', '!', '-']);
const SYNTAX_ERROR = Symbol('portal search syntax');

function queryTokens(query) {
  const tokens = [];
  for (let index = 0; index < query.length;) {
    QUOTED_TOKEN.lastIndex = index;
    ORDINARY_TOKEN.lastIndex = index;
    // Prefer a signed quoted phrase over the ordinary token ending before its quote.
    const match = QUOTED_TOKEN.exec(query) ?? ORDINARY_TOKEN.exec(query);
    if (match) {
      tokens.push(match[0]);
      index += match[0].length;
    } else index++;
  }
  return tokens;
}

function nextClauseMode(token, current, clauses) {
  if (ANY.has(token)) return current;
  if (ALL.has(token)) {
    const prior = clauses.at(-1);
    if (prior?.mode === 'optional') prior.mode = 'require';
    return 'require';
  }
  if (EXCLUDE.has(token)) return 'exclude';
  return token === '+' ? 'require' : null;
}

function clauseToken(token, currentMode) {
  if (token.startsWith('+')) return { term: token.slice(1), mode: 'require' };
  if (token.startsWith('-')) return { term: token.slice(1), mode: 'exclude' };
  return { term: token, mode: currentMode };
}

const invalidQuery = (reason, kind) =>
  Object.assign(new Error(reason), { status: 400, code: 'PORTAL_SEARCH_QUERY_INVALID', kind });

/** The bounded wildcard match used on an individual indexed token. */
function wildcardMatch(pattern, value) {
  const chars = [...value];
  let token = 0;
  let index = 0;
  let star = -1;
  let resume = 0;
  while (index < chars.length) {
    if (pattern[token] === '?' || pattern[token] === chars[index]) {
      token++;
      index++;
    } else if (pattern[token] === '*') {
      star = token++;
      resume = index;
    } else if (star >= 0) {
      token = star + 1;
      index = ++resume;
    } else return false;
  }
  while (pattern[token] === '*') token++;
  return token === pattern.length;
}

function termMatcher(term) {
  if (!/[*?]/.test(term)) return (token) => token === term;
  if (term.endsWith('*') && !/[*?]/.test(term.slice(0, -1))) {
    const prefix = term.slice(0, -1);
    return (token) => token.startsWith(prefix);
  }
  const pattern = [...term];
  return (token) => wildcardMatch(pattern, token);
}

function termOf(raw, highlight) {
  const boost = /\^(\d+(?:\.\d+)?)$/.exec(raw);
  const weight = boost ? Number(boost[1]) : 1;
  if (!Number.isFinite(weight) || weight <= 0)
    throw invalidQuery('A search boost must be a positive number.', SYNTAX_ERROR);
  const term = (boost ? raw.slice(0, boost.index) : raw).toLowerCase();
  const phrase = term.startsWith('"') && term.endsWith('"');
  const words = phrase ? searchTokens(term) : (term.match(TERM_TOKEN) ?? []);
  if (!words.length) return null;
  if (phrase && /[*?]/.test(term)) return null;
  if (/^[*?]/.test(term))
    throw invalidQuery('A search wildcard must follow the first character of a term.', SYNTAX_ERROR);
  const matchers = words.map(termMatcher);
  highlight.push(...matchers);
  return phrase
    ? ({ columns }) =>
        columns.some((column) =>
          column.some((_, index) => words.every((word, offset) => column[index + offset] === word)),
        )
          ? weight
          : null
    : ({ tokens }) => {
        const matched = matchers.filter((match) => tokens.some(match)).length;
        return matched ? matched * weight : null;
      };
}

function scoreGroup(clauses, row) {
  let matched = false;
  let score = 0;
  for (const { score: evaluate, mode } of clauses) {
    const hit = evaluate(row);
    if ((mode === 'exclude' && hit !== null) || (mode === 'require' && hit === null)) return null;
    if (mode !== 'exclude' && hit !== null) {
      matched = true;
      score += hit;
    }
  }
  return matched ? score : null;
}

function structuredQuery(query) {
  const tokens = queryTokens(query);
  const highlight = [];
  let index = 0;

  function parseGroup(depth, shouldHighlight) {
    if (depth > MAX_GROUP_DEPTH) throw invalidQuery('The search query exceeds the local group depth limit.');
    const clauses = [];
    let mode = 'optional';
    while (index < tokens.length) {
      const raw = tokens[index++];
      if (raw === ')') return closeGroup(clauses, depth);
      const next = nextClauseMode(raw, mode, clauses);
      if (next) {
        mode = next;
        continue;
      }
      const token = clauseToken(raw, mode);
      const visible = shouldHighlight && token.mode !== 'exclude';
      const score = clauseScore(token.term, depth, visible);
      if (score) clauses.push({ mode: token.mode, score });
      mode = 'optional';
    }
    if (depth) throw invalidQuery('An opened search group must be closed.', SYNTAX_ERROR);
    return clauses;
  }

  function closeGroup(clauses, depth) {
    if (!depth) throw invalidQuery('Unexpected search group end.', SYNTAX_ERROR);
    return clauses;
  }

  function clauseScore(term, depth, visible) {
    if (term !== '(') return termOf(term, visible ? highlight : []);
    const group = parseGroup(depth + 1, visible);
    return group.length ? (row) => scoreGroup(group, row) : null;
  }

  return { clauses: parseGroup(0, true), highlight };
}

function parseQuery(query, recoverSyntax) {
  try {
    return structuredQuery(query);
  } catch (error) {
    if (!recoverSyntax || error.kind !== SYNTAX_ERROR) throw error;
    // Analyze the whole input as plain text. No Lucene operators survive, and the local bounds still apply.
    const highlight = [];
    const clauses = searchTokens(query).map((word) => ({ mode: 'optional', score: termOf(word, highlight) }));
    return { clauses, highlight };
  }
}

/** Compile the documented portal query subset over the local secured view scan. */
export function compilePortalSearchQuery(value, { recoverSyntax = false } = {}) {
  const query = String(value ?? '');
  if (query.length > MAX_QUERY_LENGTH) throw invalidQuery('The search query exceeds the local length limit.');
  const { clauses, highlight } = parseQuery(query, recoverSyntax);
  return {
    highlight: (token) => highlight.some((match) => match(token)),
    score(values) {
      if (!clauses.length) return query.trim() ? null : 0;
      const columns = values.map(searchTokens);
      const words = [...new Set(columns.flat())];
      return scoreGroup(clauses, { columns, tokens: words });
    },
  };
}
