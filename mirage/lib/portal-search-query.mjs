import { searchTokens } from './dataverse-search.mjs';
import { partialWordScore, phraseScore, proximityBonus, wordScore } from './portal-search-rank.mjs';
import { searchStem } from './search-stemmer.mjs';

export const MAX_QUERY_LENGTH = 1024;
const MAX_GROUP_DEPTH = 16;
const MAX_SLOP = 2147483647; // Lucene reads the slop into an int.
const MAX_PROXIMITY_STEPS = 2_000_000; // candidate window starts x phrase words, per column
const NUMBER = String.raw`\d+(?:\.\d+)?`;
// A phrase takes an optional proximity slop before its boost: QUOTED [FUZZY_SLOP] [^boost] (Lucene query parser grammar).
const QUOTED_TOKEN = new RegExp(String.raw`[+-]?"[^"]*"(?:~(?:${NUMBER})?)?(?:\^${NUMBER})?`, 'uy');
const ORDINARY_TOKEN = /[^\s"()&|!]+|\|\||&&|[()!]/uy;
const TERM_TOKEN = /[\p{L}\p{N}][\p{L}\p{N}*?]*/gu;
// A term takes TERM [FUZZY_SLOP] [^boost [FUZZY_SLOP]]; the later slop wins.
const TERM_PARTS = new RegExp(String.raw`^(.*?)(~(${NUMBER})?)?(?:\^(${NUMBER})(~(${NUMBER})?)?)?$`, 'su');
const PHRASE_PARTS = new RegExp(String.raw`^("[^"]*")(~(${NUMBER})?)?(?:\^(${NUMBER}))?$`, 'su');
const FIELD_PREFIX = /^([A-Za-z_][\w.]*):(.*)$/su;
const KEYWORD_FIELDS = new Set(['_logicalname']);
const QUERY_PLACEHOLDER = '@Query';
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

/**
 * Edit distance between two indexable sequences, or max + 1 once every path exceeds max. With transpositions, swapping
 * two adjacent characters is one edit (optimal string alignment).
 */
function boundedDistance(a, b, max, transpositions) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let before = null;
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    let best = i;
    for (let j = 1; j <= b.length; j++) {
      let value = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (transpositions && i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        value = Math.min(value, before[j - 2] + 1);
      current[j] = value;
      best = Math.min(best, value);
    }
    if (best > max) return max + 1;
    before = previous;
    previous = current;
  }
  return previous[b.length];
}

/**
 * The fuzzy modifier `term~` / `term~N`. Dataverse search (Lucene query parser over Dataverse search): N is an edit distance
 * from 0 to 2 (default 2), a value below 1 a similarity converted to edits; a fractional value of 1 or more is refused.
 * Legacy Lucene .NET search: N is a minimum similarity below 1 (default 0.5).
 */
function fuzzySpec(value, legacyLucene) {
  const given = value == null ? null : Math.fround(Number(value));
  if (legacyLucene) {
    const similarity = given ?? Math.fround(0.5);
    if (Number.isNaN(similarity) || similarity >= 1)
      throw invalidQuery('A fuzzy search similarity must be at least 0 and less than 1.', SYNTAX_ERROR);
    return { legacyLucene, similarity };
  }
  const edits = given ?? 2;
  if (edits >= 1 && (edits !== Math.trunc(edits) || edits > MAX_SLOP))
    throw invalidQuery('A fuzzy search edit distance must be a whole number.', SYNTAX_ERROR);
  return { legacyLucene, edits };
}

function fuzzyMatcher(word, spec) {
  if (spec.legacyLucene) {
    // Lucene .NET compares UTF-16 units: similarity = 1 - distance / shorter length, kept only above the minimum.
    return (token) => {
      if (token === word) return true;
      const shorter = Math.min(word.length, token.length);
      const max = Math.ceil((1 - spec.similarity) * shorter) + 1; // a pruning bound; the similarity decides
      const distance = boundedDistance(word, token, max, false);
      return distance <= max && Math.fround(1 - Math.fround(distance / shorter)) > spec.similarity;
    };
  }
  const chars = [...word];
  let edits = Math.min(spec.edits, 2);
  if (spec.edits < 1) edits = spec.edits === 0 ? 0 : Math.min(Math.trunc((1 - spec.edits) * chars.length), 2);
  return (token) => {
    if (token === word) return true;
    if (!edits) return false;
    const other = [...token];
    const distance = boundedDistance(chars, other, edits, true);
    // An edit count that consumes the whole shorter term is no match (similarity above zero).
    return distance <= edits && distance < Math.min(chars.length, other.length);
  };
}

/**
 * A plain word matches a token with the same search stem in Dataverse search mode (`stemming`; search-stemmer.mjs) and the
 * exact token otherwise. Fuzzy, wildcard and prefix words match unstemmed tokens.
 */
function termMatcher(term, fuzzy, stemming = false) {
  if (!/[*?]/.test(term)) {
    if (fuzzy) return fuzzyMatcher(term, fuzzy);
    if (!stemming) return (token) => token === term;
    const stem = searchStem(term);
    return (token) => token === term || searchStem(token) === stem;
  }
  if (term.endsWith('*') && !/[*?]/.test(term.slice(0, -1))) {
    const prefix = term.slice(0, -1);
    return (token) => token.startsWith(prefix);
  }
  const pattern = [...term];
  return (token) => wildcardMatch(pattern, token);
}

/** The first index of sorted `values` at or above `target`. */
function lowerBound(values, target) {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (values[middle] < target) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Phrase positions within `slop` moves (Lucene sloppy phrase): max(p - offset) - min(p - offset) <= slop, each phrase word on
 * its own position. The window start is one of the p - offset values; per start, each word takes the first free position
 * of its range, which is optimal because ranges of a repeated word are ordered. Work beyond MAX_PROXIMITY_STEPS is refused.
 */
function sloppyPhrase(column, words, slop) {
  const wanted = new Set(words);
  const positions = new Map();
  column.forEach((token, position) => {
    if (!wanted.has(token)) return;
    if (!positions.has(token)) positions.set(token, []);
    positions.get(token).push(position);
  });
  if (words.some((word) => !positions.has(word))) return false;
  const candidates = words.reduce((total, word) => total + positions.get(word).length, 0);
  if (candidates * words.length > MAX_PROXIMITY_STEPS)
    throw invalidQuery('The proximity search exceeds the local work limit.');
  const starts = [...new Set(words.flatMap((word, offset) => positions.get(word).map((p) => p - offset)))];
  return starts.some((start) => {
    const taken = new Map();
    return words.every((word, offset) => {
      const list = positions.get(word);
      const index = Math.max(lowerBound(list, start + offset), taken.get(word) ?? 0);
      if (index >= list.length || list[index] - offset > start + slop) return false;
      taken.set(word, index + 1);
      return true;
    });
  });
}

/** The fewest position moves a sloppy phrase needs in `column` (at most `slop`), or null when it does not match. */
function slopNeeded(column, words, slop) {
  let high = Math.min(slop, column.length + words.length);
  if (!sloppyPhrase(column, words, high)) return null;
  let low = 0;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (sloppyPhrase(column, words, middle)) high = middle;
    else low = middle + 1;
  }
  return low;
}

function exactPhrase(column, words) {
  return column.some((_, index) => words.every((word, offset) => column[index + offset] === word));
}

/** The row a clause reads: the whole indexed record, or one named field of it. */
const targetRow = (row, field) => (field ? (row.field?.(field) ?? EMPTY_ROW) : row);

/** The words of a term. A keyword field (the table logical name) is one unanalyzed value. */
function termWords(term, phrase, field) {
  if (KEYWORD_FIELDS.has(field)) {
    const keyword = phrase ? term.slice(1, -1) : term;
    return keyword ? [keyword] : [];
  }
  return phrase ? searchTokens(term) : (term.match(TERM_TOKEN) ?? []);
}

/** The fuzzy modifier of a plain term. Wildcard and prefix terms ignore a fuzzy modifier, as the Lucene parser does. */
function termFuzzy(term, { slopMark, slopValue, laterSlopMark, laterSlopValue }, legacyLucene) {
  const fuzzyMark = laterSlopMark ?? slopMark;
  if (!fuzzyMark || /[*?]/.test(term)) return null;
  return fuzzySpec(laterSlopMark ? laterSlopValue : slopValue, legacyLucene);
}

/** A phrase compares search stems position by position in Dataverse search mode (`stemming`), tokens otherwise. */
function phraseScorer(phraseWords, slopMark, slopValue, weight, field, stemming) {
  const words = stemming ? phraseWords.map(searchStem) : phraseWords;
  const view = stemming ? (column) => column.map(searchStem) : (column) => column;
  const exactSlop = (column) => (exactPhrase(view(column), words) ? 0 : null);
  const slop = slopMark ? Math.min(Math.trunc(Number(slopValue ?? 0)), MAX_SLOP) : 0;
  const matches = slop
    ? (column) => sloppyPhrase(view(column), words, slop)
    : (column) => exactPhrase(view(column), words);
  return (row) => {
    const target = targetRow(row, field);
    if (!target.columns.some(matches)) return null;
    return weight * phraseScore(target, words, slop ? (column) => slopNeeded(view(column), words, slop) : exactSlop);
  };
}

function termOf(raw, highlights, visible = true, { legacyLucene = false, field = null } = {}) {
  const quoted = raw.startsWith('"');
  const parts = (quoted ? PHRASE_PARTS : TERM_PARTS).exec(raw) ?? [raw, raw];
  const [, base, slopMark, slopValue, boostValue, laterSlopMark, laterSlopValue] = parts;
  const weight = boostValue === undefined ? 1 : Number(boostValue);
  if (!Number.isFinite(weight) || weight <= 0)
    throw invalidQuery('A search boost must be a positive number.', SYNTAX_ERROR);
  const term = base.toLowerCase();
  const phrase = quoted;
  const words = termWords(term, phrase, field);
  if (!words.length) return null;
  if (phrase && /[*?]/.test(term)) return null;
  if (/^[*?]/.test(term))
    throw invalidQuery('A search wildcard must follow the first character of a term.', SYNTAX_ERROR);
  const fuzzy = phrase ? null : termFuzzy(term, { slopMark, slopValue, laterSlopMark, laterSlopValue }, legacyLucene);
  // Dataverse search stems plain words (hosted session F3, PAGE-04f); the legacy Lucene .NET search and the unanalyzed
  // keyword field do not.
  const stemming = !legacyLucene && !KEYWORD_FIELDS.has(field);
  const matchers = words.map((word) => termMatcher(word, fuzzy, stemming));
  highlights.hasWildcard ||= words.some((word) => /[*?]/.test(word));
  if (visible) highlights.matchers.push(...matchers);
  if (phrase) return phraseScorer(words, slopMark, slopValue, weight, field, stemming);
  // A wildcard or prefix word ignores term frequency (portal-search-rank.mjs); any other word scores frequency and length.
  const partial = words.map((word) => /[*?]/.test(word));
  return (row) => {
    const target = targetRow(row, field);
    let matched = 0;
    let score = 0;
    words.forEach((word, index) => {
      const value = (partial[index] ? partialWordScore : wordScore)(target, word, matchers[index]);
      if (value === null) return;
      matched++;
      score += value;
    });
    return matched ? score * weight : null;
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

function closeGroup(clauses, depth) {
  if (!depth) throw invalidQuery('Unexpected search group end.', SYNTAX_ERROR);
  return clauses;
}

/**
 * Parse the query. With `fields`, `name:term` and `name:(group)` restrict a clause to one field, and `placeholder` (the
 * `@Query` token) evaluates another compiled query against the clause's row.
 */
function structuredQuery(query, { legacyLucene = false, fields = false, placeholder = null } = {}) {
  const tokens = queryTokens(query);
  const highlights = { matchers: [], hasWildcard: false };
  let index = 0;

  function parseGroup(depth, shouldHighlight, field) {
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
      const score = clauseScore(token.term, depth, visible, field);
      if (score) clauses.push({ mode: token.mode, score });
      mode = 'optional';
    }
    if (depth) throw invalidQuery('An opened search group must be closed.', SYNTAX_ERROR);
    return clauses;
  }

  function clauseScore(term, depth, visible, field) {
    if (term === '(') {
      const group = parseGroup(depth + 1, visible, field);
      return group.length ? (row) => scoreGroup(group, row) : null;
    }
    if (placeholder && term === QUERY_PLACEHOLDER) return (row) => placeholder(targetRow(row, field));
    const named = fields ? FIELD_PREFIX.exec(term) : null;
    if (!named) return termOf(term, highlights, visible, { legacyLucene, field });
    const name = named[1].toLowerCase();
    if (named[2]) return clauseScore(named[2], depth, visible, name);
    // `name:` applies to the following term, phrase or group.
    if (index >= tokens.length || tokens[index] === ')')
      throw invalidQuery('A search field must be followed by a term.', SYNTAX_ERROR);
    return clauseScore(tokens[index++], depth, visible, name);
  }

  return { clauses: parseGroup(0, true, null), highlights };
}

function parseQuery(query, recoverSyntax, legacyLucene) {
  try {
    return structuredQuery(query, { legacyLucene });
  } catch (error) {
    if (!recoverSyntax || error.kind !== SYNTAX_ERROR) throw error;
    // Analyze the whole input as plain text. No Lucene operators survive, and the local bounds still apply.
    const highlights = { matchers: [], hasWildcard: false };
    const clauses = searchTokens(query).map((word) => ({
      mode: 'optional',
      score: termOf(word, highlights, true, { legacyLucene }),
    }));
    return { clauses, highlights };
  }
}

const EMPTY_ROW = Object.freeze({ values: [], columns: [], tokens: [] });

function textRow(values) {
  const columns = values.map(searchTokens);
  return { values, columns, tokens: [...new Set(columns.flat())] };
}

/**
 * Compile the documented portal query subset over the local secured view scan. `legacyLucene` selects the fuzzy semantics
 * of the deprecated Lucene .NET search (Search/EnableDataverseSearch false).
 */
export function compilePortalSearchQuery(value, { recoverSyntax = false, legacyLucene = false } = {}) {
  const query = String(value ?? '');
  if (query.length > MAX_QUERY_LENGTH) throw invalidQuery('The search query exceeds the local length limit.');
  const { clauses, highlights } = parseQuery(query, recoverSyntax, legacyLucene);
  return {
    // A wildcard query has no result fragment, even when a plain term also matches.
    highlight: (token) => !highlights.hasWildcard && highlights.matchers.some((match) => match(token)),
    /** The row's local relevance (portal-search-rank.mjs), or null when the query does not match it. */
    score(values) {
      if (!clauses.length) return query.trim() ? null : 0;
      const row = textRow(values);
      const score = scoreGroup(clauses, row);
      return score === null ? null : score + proximityBonus(row, highlights.matchers);
    },
  };
}

/**
 * Compile a Search/Query template around a compiled visitor query. `@Query` stands for the visitor query as a whole (it is
 * never re-parsed inside the template). Fields: `_logicalname` (the table logical name as one keyword), `_title` (the first
 * indexed column) and any indexed column by logical name. Membership: required, prohibited and, without a required clause,
 * at least one optional clause. Rank: the sum of the matched clauses' scores with their boosts, an `@Query` clause scoring
 * the visitor query over its field (so `_title:(@Query)` weighs a title match again). Syntax errors throw
 * PORTAL_SEARCH_QUERY_INVALID.
 */
export function compilePortalSearchTemplate(value, search, { legacyLucene = false } = {}) {
  const template = String(value ?? '');
  if (template.length > MAX_QUERY_LENGTH)
    throw invalidQuery('The search query template exceeds the local length limit.');
  const { clauses } = structuredQuery(template, {
    legacyLucene,
    fields: true,
    placeholder: (row) => search.score(row.values),
  });
  if (!clauses.length) return null;
  /** record: { logicalName, columns: [[logical name, text value], ...] } with the title column first. */
  const rank = ({ logicalName, columns }) => {
    const values = columns.map(([, text]) => text).filter(Boolean);
    const row = textRow(values);
    row.field = (name) => {
      if (name === '_logicalname') return { values: [logicalName], columns: [[logicalName]], tokens: [logicalName] };
      if (name === '_title') return textRow(columns[0]?.[1] ? [columns[0][1]] : []);
      const column = columns.find(([column]) => column.toLowerCase() === name);
      return textRow(column?.[1] ? [column[1]] : []);
    };
    return scoreGroup(clauses, row);
  };
  return {
    /** The record's template score (the local rank of the default search page), or null when the template excludes it. */
    rank,
    admits: (record) => rank(record) !== null,
  };
}
