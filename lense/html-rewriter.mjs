import { orderedMap } from './async-map.mjs';
// Rewrites the HTML the online portal returns so that it reflects the local sources.
//
// Two techniques, because the portal renders pages server side and that cannot be reproduced locally:
//   * block sources  (custom JS/CSS of pages, forms, lists) are printed verbatim inside a single
//     <script>/<style> element. The element is found by content similarity and replaced as a whole.
//   * markup sources (web templates, content snippets, page copy) contain Liquid. The diff between
//     the baseline (what is deployed) and the working copy is applied to the HTML as a patch; it works
//     for changes in literal text, and tells you when a change needs a real deployment.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { racyStat } from './file-cache.mjs';
import { readLocalFile } from './local-file.mjs';
import { diffLines } from './line-diff.mjs';
import { urlKey, sourceText, createSourceReader, isSourceFile, indexingPass } from './portal-model.mjs';
import { applyRenderEdits, finalizePortalProvenance } from '../mirage/lib/render-provenance.mjs';
import { alignDocument, scanLiquidTokens as liquidTokens } from './response-alignment.mjs';

/** URL prefix of everything the overlay answers itself; nothing under it exists on the portal. */
export const LOCAL_PREFIX = '/__paqvilo/';
/** URL prefix under which the overlay serves the local file of an inline script (see `sourceMaps`). */
export const INLINE_PREFIX = `${LOCAL_PREFIX}inline/`;
/** URL prefix of the requests the dev panel on the page makes to the dev loop. */
export const API_PREFIX = `${LOCAL_PREFIX}api/`;

/** @param {string} rel path of the source relative to the extract, with forward slashes */
export const inlineScriptUrl = (rel) => INLINE_PREFIX + rel.split('/').map(encodeURIComponent).join('/');

const normEol = (s) => s.replace(/\r\n?/g, '\n');
const sourceCacheKey = (file) => {
  const absolute = path.resolve(file);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
};
const sameStamp = (a, b) =>
  a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
// A stamp recorded while racy (racyStat) never proves later that its bytes are current.
const stampOf = (file, real, info) => ({ file, real, info, racy: racyStat(info) });
const MAX_CONTEXT = 8;
// the longest text a {{ value }} is expected to render to
const MAX_VALUE_LENGTH = 50_000;
// below this much literal text a pattern is only trusted where it stands on its own (>text<, "text")
const WEAK_ANCHOR_LENGTH = 12;

function sourceLineWeight(frequency, weights, line) {
  if (!frequency.has(line)) return TRIVIAL_LINE.test(line) ? 0 : 1;
  if (!weights.has(line)) weights.set(line, TRIVIAL_LINE.test(line) ? 0 : 1 / frequency.get(line));
  return weights.get(line);
}

function addSourcePairs(block, candidates, weight, docKey, minSim, lineWeight, pairs) {
  for (const src of candidates) {
    if (src.tag !== block.tag) continue;
    let score = similarity(block.lines, src.lines, lineWeight, weight, src.weight, minSim);
    if (src.baseLines)
      score = Math.max(score, similarity(block.lines, src.baseLines, lineWeight, weight, src.baseWeight, minSim));
    if (score + 1e-12 < minSim) continue;
    // a couple of lines is too little to tell blocks apart, unless the source belongs to this page
    const tiny = Math.min(block.lines.size, Math.max(src.lines.size, src.baseLines?.size ?? 0)) < 3;
    if (tiny && !src.pageKey && score < 1) continue;
    // forms are often clones of each other: among near-equal candidates prefer the form this page is configured to show
    pairs.push({ block, src, score, rank: score + (src.usedKeys.has(docKey) ? 0.1 : 0) });
  }
}

// How much of a difference between the served page and the baseline one response reports.
const DRIFT_PLACES = 60;
const DRIFT_SEEN = 400;
const DRIFT_TEXT = 200;

function collectBlockPairs(html, candidates, docKey, minSim, lineWeight, markupBlocks = null) {
  const found = [];
  const pairs = [];
  for (const m of codeBlocks(html)) {
    const tag = m[1].toLowerCase();
    if (!isInlineCodeBlock(tag, m[2])) continue;
    // A script or style element a web template, snippet or page copy writes itself is that source's markup: it is
    // never the block of a page's, form's or list's custom code, however many lines the two share.
    if (markupBlocks?.has(m.index)) continue;
    const lines = lineSet(m[3]);
    if (!lines.size) continue;
    let weight = 0;
    for (const line of lines) weight += lineWeight(line);
    const block = { m, tag, lines, norm: normEol(m[3]).trim(), src: null, score: 0 };
    found.push(block);
    addSourcePairs(block, candidates, weight, docKey, minSim, lineWeight, pairs);
  }
  return { found, pairs };
}

const blockSourceIdentity = (src) => (src.pageKey ? `${src.kind}|${src.pageKey}` : src.file);

function noteAmbiguousPairs(ambiguous, best, notes) {
  for (const block of ambiguous) {
    const { src } = best.get(block);
    notes.push({
      rel: src.rel,
      reason:
        'multiple local sources or language variants match this inline block equally; no source was substituted because its identity cannot be determined safely',
    });
  }
}

function findAmbiguousBlockPairs(pairs) {
  const ambiguous = new Set();
  const best = new Map();
  for (const pair of pairs) {
    const first = best.get(pair.block);
    if (!first) best.set(pair.block, pair);
    else if (
      Math.abs(pair.rank - first.rank) < 1e-12 &&
      (blockSourceIdentity(pair.src) !== blockSourceIdentity(first.src) ||
        differentLocalizedVariants(pair.src, first.src)) &&
      pair.src.norm !== first.src.norm
    )
      ambiguous.add(pair.block);
  }
  return { ambiguous, best };
}

function assignBlockSources(pairs, ambiguous) {
  const claimed = new Map();
  for (const { block, src, score } of pairs) {
    if (block.src || ambiguous.has(block)) continue;
    const id = blockSourceIdentity(src);
    if (claimed.has(id) && claimed.get(id) !== block.norm) continue;
    claimed.set(id, block.norm);
    block.src = src;
    block.score = score;
  }
  return claimed;
}

function claimBlockPairs(pairs, notes) {
  pairs.sort((a, b) => b.rank - a.rank || Number(isLanguageCopy(b.src)) - Number(isLanguageCopy(a.src)));
  const { ambiguous, best } = findAmbiguousBlockPairs(pairs);
  noteAmbiguousPairs(ambiguous, best, notes);
  const claimed = assignBlockSources(pairs, ambiguous);
  return { claimed, identity: blockSourceIdentity };
}

function sumLineWeights(lines, lineWeight) {
  let total = 0;
  if (lines) for (const line of lines) total += lineWeight(line);
  return total;
}

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch {
    return null;
  }
}

/** URL path without the optional language segment (/en-US/...), as a lookup key. */
export function pageKey(urlPath, model = null) {
  const key = urlKey(urlPath);
  if (model?.pagePaths?.has(key)) return key;
  const prefix = key.split('/')[1];
  if (!model?.languageCodes?.has(prefix)) return key;
  return key.slice(prefix.length + 1) || '/';
}

// ---- block sources

function lineSet(text) {
  const set = new Set();
  for (const line of normEol(text).split('\n')) {
    const t = line.trim();
    if (t) set.add(t);
  }
  return set;
}

// Lines made of punctuation only (`});`, `}`) say nothing about which script a block is.
const TRIVIAL_LINE = /^[\s{}()[\];,]*$/;

/**
 * Weighted Jaccard similarity of two line sets. `weight(line)` is low for boilerplate that many
 * scripts share (`$(document).ready(function () {`), so two short scripts that only have their
 * boilerplate in common do not look alike.
 */
function similarity(a, b, weight, aWeight, bWeight, minimum) {
  if (!a.size || !b.size) return 0;
  if (Math.min(aWeight, bWeight) + 1e-12 < minimum * Math.max(aWeight, bWeight)) return 0;
  let shared = 0;
  let count = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const line of small) {
    if (large.has(line)) {
      shared += weight(line);
      count++;
    }
  }
  const total = aWeight + bWeight - shared;
  if (total <= 0) return 0;
  return count === a.size && count === b.size ? 1 : Math.min(1, shared / total);
}

const JS_TYPE_RE =
  /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:javascript1\.[0-5]|jscript|livescript)|module)$/i;
const RAW_TEXT = new Set([
  'script',
  'style',
  'textarea',
  'title',
  'xmp',
  'iframe',
  'noembed',
  'noframes',
  'noscript',
  'plaintext',
]);
const HTML_SPACE = /[\t\n\f\r ]/;

/* NOSONAR: single-pass routine, splitting it would change shared state */ function advanceTagState(state, char) {
  switch (state) {
    case 'value':
      if (HTML_SPACE.test(char)) return state;
      return char === '"' || char === "'" ? char : 'unquoted';
    case 'unquoted':
      return HTML_SPACE.test(char) ? 'before' : state;
    case 'name':
    case 'after':
      if (char === '=') return 'value';
      if (char === '/') return 'before';
      if (HTML_SPACE.test(char)) return 'after';
      return 'name';
    default:
      return !HTML_SPACE.test(char) && char !== '/' ? 'name' : state;
  }
}

function commentEnd(html, start) {
  if (html.startsWith('>', start + 4)) return start + 5;
  if (html.startsWith('->', start + 4)) return start + 6;
  const closing = /--!?>/g;
  closing.lastIndex = start + 4;
  return closing.exec(html) ? closing.lastIndex : html.length;
}

function declarationEnd(html, start) {
  const end = html.indexOf('>', start + 2);
  return end < 0 ? html.length : end + 1;
}

function nextScriptRawState(value, state) {
  if (value === '<!--' && state === 'data') return 'escaped';
  if (value === '-->') return 'data';
  if (value === '<script' && state === 'escaped') return 'double';
  if (value === '</script') return state === 'double' ? 'escaped' : 'close';
  return state;
}

// '<!-->' and '<!--->' end at once in script data, so they never enter the escaped states.
function emptyCommentEnd(html, start) {
  if (html.startsWith('>', start + 4)) return start + 5;
  if (html.startsWith('->', start + 4)) return start + 6;
  return -1;
}

function scriptRawEnd(html, from) {
  // Legacy HTML-comment escapes have a double-escaped state: a </script> after
  // <!--<script> is text until that state has ended, even inside a JavaScript string.
  const tokens = /<!--|-->|<\/?script(?=[\t\n\f\r />])/gi;
  tokens.lastIndex = from;
  let state = 'data';
  for (let token; ;) {
    token = tokens.exec(html);
    if (!token) break;
    const value = token[0].toLowerCase();
    const emptyEnd = state === 'data' && value === '<!--' ? emptyCommentEnd(html, token.index) : -1;
    if (emptyEnd >= 0) {
      tokens.lastIndex = emptyEnd;
      continue;
    }
    state = nextScriptRawState(value, state);
    if (state === 'close') return readTag(html, token.index);
  }
  return null;
}

// Consume a tag once, including an unfinished tag at EOF. A global tag regex retries every
// nested '<' in malformed attributes and can scan the same multi-megabyte tail quadratically.
function readTag(html, start) {
  let at = start + (html[start + 1] === '/' ? 2 : 1);
  const nameStart = at;
  while (at < html.length && !/[\t\n\f\r />]/.test(html[at])) at++;
  const name = html.slice(nameStart, at);
  const attrsStart = at;
  let state = 'before';
  for (; at < html.length; at++) {
    const char = html[at];
    if (state === '"' || state === "'") {
      if (char === state) state = 'before';
      continue;
    }
    if (char === '>')
      return Object.assign([html.slice(start, at + 1), name, html.slice(attrsStart, at)], {
        index: start,
        end: at + 1,
      });
    state = advanceTagState(state, char);
  }
  return null;
}

function nextTag(html, from) {
  for (let start = html.indexOf('<', from); start >= 0; start = html.indexOf('<', from)) {
    if (html.startsWith('<!--', start)) {
      from = commentEnd(html, start);
    } else if (html[start + 1] === '!' || html[start + 1] === '?') {
      from = declarationEnd(html, start);
    } else if (/[a-z]/i.test(html[start + (html[start + 1] === '/' ? 2 : 1)] ?? '')) {
      return readTag(html, start);
    } else from = start + 1;
  }
  return null;
}

function rawEnd(html, tag, from) {
  if (tag === 'script') return scriptRawEnd(html, from);
  const closing = new RegExp(String.raw`</${tag}(?=[\t\n\f\r />])`, 'gi');
  closing.lastIndex = from;
  const match = closing.exec(html);
  return match ? readTag(html, match.index) : null;
}

function preservesInlineBoundary(tag, content, closing = `</${tag}>`) {
  return rawEnd(content + closing, tag, 0)?.index === content.length;
}

// Walk real tags, consuming comments and raw-text elements as a unit. A <script> printed in a
// textarea, comment, or another script is text, not a second executable block.
function* codeBlocks(html) {
  let at = 0;
  for (let open; ;) {
    open = nextTag(html, at);
    if (!open) break;
    at = open.end;
    if (!open[1] || open[0].startsWith('</')) continue;
    const tag = open[1].toLowerCase();
    if (!RAW_TEXT.has(tag)) continue;
    if (tag === 'plaintext') break;
    const close = rawEnd(html, tag, at);
    if (!close) break;
    const content = html.slice(at, close.index);
    at = close.end;
    if (tag === 'script' || tag === 'style') {
      const block = [html.slice(open.index, close.end), open[1], open[2], content];
      Object.assign(block, { index: open.index, opening: open[0], closing: close[0] });
      yield block;
    }
  }
}

function closingTagOffset(tagMatch, name) {
  return tagMatch[0].startsWith('</') && tagMatch[1].toLowerCase() === name ? tagMatch.index : -1;
}

function rawTextEnd(html, tag, at) {
  if (tag === 'plaintext') return null;
  return rawEnd(html, tag, at)?.end ?? null;
}

function closingElementOffset(html, name) {
  let at = 0;
  let offset = -1;
  for (let m; ;) {
    m = nextTag(html, at);
    if (!m) break;
    at = m.end;
    if (!m[1]) continue;
    const tag = m[1].toLowerCase();
    const close = closingTagOffset(m, name);
    if (close >= 0) offset = close;
    else if (!m[0].startsWith('</') && RAW_TEXT.has(tag)) {
      const end = rawTextEnd(html, tag, at);
      if (end == null) break;
      at = end;
    }
  }
  return offset;
}

const ATTRIBUTE_PATTERN = /([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g; // NOSONAR: regex kept: a rewrite would change matches or captures

function attributes(attrs) {
  const out = new Map();
  for (const m of attrs.matchAll(ATTRIBUTE_PATTERN)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

// The source text of the first nonce attribute, with the quote that delimits it ('' when unquoted).
function nonceSource(attrs) {
  for (const m of attrs.matchAll(ATTRIBUTE_PATTERN)) {
    if (m[1].toLowerCase() !== 'nonce') continue;
    if (m[2] !== undefined) return { raw: m[2], quote: '"' };
    if (m[3] !== undefined) return { raw: m[3], quote: "'" };
    return { raw: m[4] ?? '', quote: '' };
  }
  return null;
}

// The nonce of the first script that carries one, as text for a double-quoted attribute value. A double-quoted
// value is copied as written; any other quoting is re-encoded only where its quote would end a double-quoted value.
function pageScriptNonce(html) {
  for (const block of codeBlocks(html)) {
    if (block[1].toLowerCase() !== 'script') continue;
    const source = nonceSource(block[2]);
    if (source?.raw) return source.quote === '"' ? source.raw : source.raw.replaceAll('"', '&quot;');
  }
  return '';
}

// A strict CSP admits an inline script only with the nonce of the page, so the injected script carries it.
function pageScriptOpening(html) {
  const nonce = pageScriptNonce(html);
  const nonceAttribute = nonce ? ` nonce="${nonce}"` : '';
  return `<script type="text/javascript"${nonceAttribute}>`;
}

function scriptType(values, useLanguage = true) {
  // Character references in type values are decoded by the HTML parser. Only ASCII values
  // can name a supported MIME type; include the named references that can occur in one.
  const named = { Tab: '\t', NewLine: '\n', sol: '/', period: '.' };
  return (values.get('type') ?? (useLanguage && values.get('language') ? `text/${values.get('language')}` : ''))
    .replace(/&#(?:x([\da-f]+)|(\d+));?|&(Tab|NewLine|sol|period);/gi, (whole, hex, dec, name) => {
      if (name) return named[name] ?? whole;
      const code = Number.parseInt(hex ?? dec, hex ? 16 : 10);
      return code > 0 && code < 128 ? String.fromCodePoint(code) : whole;
    })
    .trim()
    .toLowerCase();
}

// Relative dynamic imports in classic inline scripts resolve against the document URL too.
// Conservatively keep any source mentioning import inline, avoiding a JS parser on each edit.
const canExternalize = (src, type = '') => type !== 'module' && !/\bimport\b/.test(src.text);

function isInlineCodeBlock(tag, attrs) {
  const values = attributes(attrs);
  const type = scriptType(values, tag !== 'style');
  if (tag === 'style') return !type || type.toLowerCase() === 'text/css';
  if (values.has('src')) return false;
  return !type || JS_TYPE_RE.test(type);
}

const isLanguageCopy = (src) => src.rel.includes('/content-pages/');

// The language the portal served this document in: the language segment of the address, else what the document
// declares on its root element (lang, and the portal's own crm-lcid).
function documentLanguage(html, urlPath, model) {
  const root = /<html\b[^>]*>/i.exec(html.slice(0, 8192))?.[0] ?? '';
  const attribute = (name) => {
    const match = new RegExp(String.raw`\s${name}\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))`, 'i').exec(root);
    return match ? (match[1] ?? match[2] ?? match[3]) : null;
  };
  const key = urlKey(urlPath);
  const prefix = key.split('/')[1];
  const fromAddress = !model?.pagePaths?.has(key) && model?.languageCodes?.has(prefix) ? prefix : null;
  const code = (fromAddress ?? attribute('lang'))?.toLowerCase() ?? null;
  const lcid = Number(attribute('crm-lcid'));
  if (!code && (Number.isNaN(lcid) || lcid <= 0)) return null;
  return { code, lcid: Number.isInteger(lcid) && lcid > 0 ? lcid : null };
}

// The language a source is the copy of: an LCID entry of a localized field, the language in a classic file name, the
// language layer of an enhanced-model page; null for a root record.
function variantLanguage(src) {
  if (src.lcid != null) return Number(src.lcid);
  const named = /\.([a-z]{2,3}(?:-[a-z0-9]{2,8})+)\.(?:webpage|contentsnippet)\./i.exec(src.rel)?.[1];
  if (named) return named.toLowerCase();
  if (src.pageLayer && src.pageLayer !== 'root' && !src.pageLayer.startsWith('localized '))
    return String(src.pageLayer).toLowerCase();
  return null;
}

// The candidates that are copies of one page field, grouped by the field (or page) they are a copy of.
function groupLanguageVariants(candidates) {
  const groups = new Map();
  for (const src of candidates) {
    let key = null;
    if (src.lcid != null)
      key = 'field|' + src.file + '|' + (src.field ?? '') + '|' + JSON.stringify(src.fieldPath ?? null);
    else if (src.pageKey) key = 'page|' + src.kind + '|' + src.pageKey;
    if (!key) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(src);
  }
  return groups;
}

/**
 * Of the copies of one page field (its root record and one per language), the portal prints the copy of the
 * language it serves. When the document says its language and that copy exists, the other copies are not candidates:
 * an edit of the French copy is never laid over the English page, and identical copies are not "ambiguous".
 */
function servedLanguageVariants(candidates, language) {
  if (!language) return candidates;
  const groups = groupLanguageVariants(candidates);
  const dropped = new Set();
  const served = (src) => {
    const value = variantLanguage(src);
    return typeof value === 'number' ? value === language.lcid : value != null && value === language.code;
  };
  for (const group of groups.values()) {
    if (group.length < 2 || !group.some(served)) continue;
    for (const src of group) if (!served(src)) dropped.add(src);
  }
  return dropped.size ? candidates.filter((src) => !dropped.has(src)) : candidates;
}
const sourceLocale = (src) =>
  src.lcid ?? /\.([a-z]{2}(?:-[a-z]{2,4})?)\.(?:webpage|contentsnippet)\./i.exec(src.rel)?.[1]?.toLowerCase() ?? null;
function differentLocalizedVariants(a, b) {
  const aLocale = sourceLocale(a);
  const bLocale = sourceLocale(b);
  if (aLocale == null || bLocale == null || aLocale === bLocale || a.kind !== b.kind) return false;
  if (a.lcid != null || b.lcid != null)
    return a.file === b.file && a.field === b.field && JSON.stringify(a.fieldPath) === JSON.stringify(b.fieldPath);
  if (a.kind.startsWith('page-'))
    return a.pageUrl != null && b.pageUrl != null && urlKey(a.pageUrl) === urlKey(b.pageUrl);
  return (
    a.kind === 'content-snippet' &&
    a.snippetName &&
    b.snippetName &&
    a.snippetName.toLowerCase() === b.snippetName.toLowerCase()
  );
}

// ---- markup sources

function normExpr(expr) {
  // Whitespace and apostrophes inside Liquid string literals are data. Canonicalise quote
  // delimiters only, so changing a filter argument never reuses a different rendered value.
  return expr
    .trim()
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\s+/g, (part) =>
      /^\s/.test(part) ? ' ' : JSON.stringify(part.slice(1, -1)),
    );
}

function lineAtOffset(starts, lines, at) {
  let lo = 0;
  let hi = lines.length;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= at) lo = mid;
    else hi = mid;
  }
  return lo;
}

function protectLineRange(normalized, lines, starts, from, to) {
  const whitespaceControl = /\{[{%]-|-[}%]\}/.test(normalized.slice(from, to));
  for (
    let i = lineAtOffset(starts, lines, from);
    i <= lineAtOffset(starts, lines, Math.max(from, to - 1)) && i < lines.length;
    i++
  ) {
    lines[i].protected.push({
      start: Math.max(0, from - starts[i]),
      end: Math.min(lines[i].text.length, to - starts[i]),
    });
    // Trimming can affect literal text on either side of a token. Keep these lines
    // out of the literal-segment fallback even when the token itself is unchanged.
    if (whitespaceControl) lines[i].whitespaceControl = true;
  }
}

function markLogicRange(normalized, lines, starts, from, to) {
  protectLineRange(normalized, lines, starts, from, to);
  for (
    let i = lineAtOffset(starts, lines, from);
    i <= lineAtOffset(starts, lines, Math.max(from, to - 1)) && i < lines.length;
    i++
  )
    lines[i].logic = true;
}

function liquidTokenEnd(normalized, start, delimiter) {
  let quote = null;
  let end = start + 2;
  for (; end < normalized.length; end++) {
    const char = normalized[end];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") quote = char;
    else if (normalized.startsWith(delimiter, end)) break;
  }
  return end;
}

function processLiquidTag(normalized, lines, starts, tokens, token, end, capture) {
  const start = token.index;
  markLogicRange(normalized, lines, starts, start, end);
  const body = normalized.slice(start + 2, end - 2).trimStart();
  const tag = /^([a-z]+)/i.exec(body.startsWith('-') ? body.slice(1).trimStart() : body)?.[1]?.toLowerCase();
  if (tag === 'raw' || tag === 'comment') {
    const closing = new RegExp(String.raw`\{%-?\s*end${tag}\s*-?%\}`, 'gi');
    closing.lastIndex = end;
    const close = closing.exec(normalized);
    if (!close) {
      markLogicRange(normalized, lines, starts, start, normalized.length);
      return false;
    }
    if (tag === 'comment') markLogicRange(normalized, lines, starts, start, closing.lastIndex);
    else markLogicRange(normalized, lines, starts, close.index, closing.lastIndex);
    tokens.lastIndex = closing.lastIndex;
  } else if (tag === 'capture') {
    capture.start ??= start;
    capture.depth++;
  } else if (tag === 'endcapture' && capture.depth && --capture.depth === 0) {
    markLogicRange(normalized, lines, starts, capture.start, end);
    capture.start = null;
  }
  return true;
}

function processLiquidOutput(normalized, lines, starts, start, end) {
  const first = lineAtOffset(starts, lines, start);
  if (first !== lineAtOffset(starts, lines, end - 1) || normalized[start + 2] === '-' || normalized[end - 3] === '-') {
    markLogicRange(normalized, lines, starts, start, end);
    return;
  }
  protectLineRange(normalized, lines, starts, start, end);
  lines[first]?.outputs.push({
    index: start - starts[first],
    text: normalized.slice(start, end),
    expr: normalized.slice(start + 2, end - 2),
  });
}

function scanLiquidTokens(normalized, lines, starts) {
  // Only direct literal output is patchable. Comment bodies are never printed, capture bodies
  // may be transformed before being printed, and raw bodies print {{...}} as literal text.
  // Scan whole tokens so multiline tags/outputs cannot turn their middle lines into anchors.
  const tokens = /\{%|\{\{/g;
  const capture = { start: null, depth: 0 };
  for (let token; ;) {
    token = tokens.exec(normalized);
    if (!token) break;
    const start = token.index;
    const delimiter = token[0] === '{%' ? '%}' : '}}';
    let end = liquidTokenEnd(normalized, start, delimiter);
    if (end === normalized.length) {
      markLogicRange(normalized, lines, starts, start, end);
      break;
    }
    end += 2;
    tokens.lastIndex = end;
    if (delimiter === '%}') {
      if (!processLiquidTag(normalized, lines, starts, tokens, token, end, capture)) break;
    } else processLiquidOutput(normalized, lines, starts, start, end);
  }
  if (capture.start != null) markLogicRange(normalized, lines, starts, capture.start, normalized.length);
}

function toLines(text) {
  const { text: normalized, original } = normalise(text);
  const parts = normalized.split('\n');
  const starts = [];
  const lines = [];
  let offset = 0;
  for (let i = 0; i < parts.length; i++) {
    const lineText = parts[i];
    starts.push(offset);
    offset += lineText.length + 1;
    lines.push({
      text: lineText,
      sourceStart: original(starts.at(-1)),
      eol: i < parts.length - 1,
      logic: false,
      outputs: [],
      protected: [],
      whitespaceControl: false,
    });
  }
  if (lines.length && !lines.at(-1).eol && lines.at(-1).text === '') lines.pop();
  scanLiquidTokens(normalized, lines, starts);
  return lines;
}

const lineKey = (l) => l.text + (l.eol ? '\n' : '');

/**
 * A pattern is a flat list of tokens over LF-normalised text:
 *   {lit}  literal text          {expr} a {{ value }}: any text up to the next literal
 *   {mark} position marker ('core' = start of the changed lines, 'after' = their end)
 * It is matched left to right without backtracking, so its cost is linear in the page size.
 */
function buildPattern(baseLines, hunk, before, after) {
  const tokens = [];
  const lit = (s) => {
    if (!s) return;
    const last = tokens.at(-1);
    if (last?.lit != null) last.lit += s;
    else tokens.push({ lit: s });
  };
  const lines = (from, to) => {
    for (let i = from; i < to; i++) {
      const line = baseLines[i];
      let at = 0;
      for (const m of line.outputs) {
        lit(line.text.slice(at, m.index));
        tokens.push({ expr: normExpr(m.expr) });
        at = m.index + m.text.length;
      }
      lit(line.text.slice(at) + (line.eol ? '\n' : ''));
    }
  };
  lines(hunk.aStart - before, hunk.aStart);
  tokens.push({ mark: 'core' });
  lines(hunk.aStart, hunk.aEnd);
  tokens.push({ mark: 'after' });
  lines(hunk.aEnd, hunk.aEnd + after);

  const solid = tokens.filter((t) => !t.mark);
  const literal = solid.filter((t) => t.lit != null).map((t) => t.lit);
  return {
    tokens,
    literal,
    // a value needs literal text on both sides to know where it starts and ends
    anchored:
      solid.length > 0 &&
      solid[0].lit != null &&
      solid.at(-1).lit != null &&
      solid.every((t, i) => t.lit != null || solid[i + 1]?.lit != null),
    weight: literal.join('').replace(/\s+/g, '').length,
  };
}

/** All non-overlapping matches of `pattern` in LF-normalised `text` (at most `max`). */
function nextLiteral(text, memo, lit, pos) {
  const cached = memo.get(lit);
  if (cached && cached.from <= pos && (cached.at < 0 || pos <= cached.at)) return cached.at;
  const at = text.indexOf(lit, pos);
  memo.set(lit, { from: pos, at });
  return at;
}

function tightenMatch(tokens, text, start, match, first, next) {
  for (let later = next(first, start + 1); later >= 0 && later < match.end; later = next(first, later + 1)) {
    const tighter = matchAt(tokens, text, later, next);
    if (tighter && tighter.end <= match.end) {
      match = tighter;
      start = later;
    }
  }
  return { match, start };
}

function findMatches(pattern, text, max = Infinity) {
  const out = [];
  if (!pattern.anchored) return out;
  for (const piece of pattern.literal) if (!text.includes(piece)) return out;
  const { tokens } = pattern;
  const first = tokens.find((t) => t.lit != null).lit;
  // Next occurrence of a literal at or after `pos`. Remembering the last answer keeps the whole
  // search linear: thousands of candidate starts ask for the same literal from increasing positions.
  const memo = new Map();
  const next = (lit, pos) => nextLiteral(text, memo, lit, pos);
  let from = 0;
  while (out.length < max) {
    let start = next(first, from);
    if (start < 0) break;
    let match = matchAt(tokens, text, start, next);
    if (!match) {
      from = start + 1;
      continue;
    }
    // A {{ value }} matches any text, so a look-alike line earlier in the page can reach forward to
    // the real one. Keep the tightest match: the last start that still ends at the same place.
    ({ match, start } = tightenMatch(tokens, text, start, match, first, next));
    out.push(match);
    from = Math.max(match.end, start + 1);
  }
  return out;
}

/* NOSONAR */ function matchToken(state, tok, text, next) {
  if (tok.mark) {
    if (state.pending != null) state.waiting.push(tok.mark);
    else state.marks[tok.mark] = state.pos;
  } else if (tok.expr != null) state.pending = tok.expr;
  else if (state.pending != null) {
    const found = next(tok.lit, state.pos);
    if (found < 0 || found - state.pos > MAX_VALUE_LENGTH) return false;
    const value = text.slice(state.pos, found);
    if (state.values.has(state.pending) && state.values.get(state.pending) !== value) return false;
    state.values.set(state.pending, value);
    state.pos = found;
    for (const mark of state.waiting) state.marks[mark] = state.pos;
    state.pending = null;
    state.waiting = [];
    state.pos += tok.lit.length;
  } else {
    if (!text.startsWith(tok.lit, state.pos)) return false;
    state.pos += tok.lit.length;
  }
  return true;
}

function matchAt(tokens, text, start, next) {
  const state = { pos: start, pending: null, waiting: [], marks: {}, values: new Map() };
  for (const tok of tokens) if (!matchToken(state, tok, text, next)) return null;
  return { start, end: state.pos, core: state.marks.core, after: state.marks.after, values: state.values };
}

const WORD = /[\w$]/;

/** Rejects matches that start or end in the middle of a word, and weak ones that are not delimited. */
function standsAlone(pattern, text, match) {
  const prev = match.start > 0 ? text[match.start - 1] : '\n';
  const next = match.end < text.length ? text[match.end] : '\n';
  const first = pattern.literal[0][0];
  const last = pattern.literal.at(-1).at(-1);
  if (WORD.test(first) && WORD.test(prev)) return false;
  if (WORD.test(last) && WORD.test(next)) return false;
  if (pattern.weight < WEAK_ANCHOR_LENGTH) {
    // "Save" must not turn every "Save changes" on the page into something else
    const open = first === '\n' || /[>"'`\n]/.test(prev) || /[<\n]/.test(first);
    const close = last === '\n' || /[<"'`\n]/.test(next) || />/.test(last);
    return open && close;
  }
  return true;
}

/**
 * Prepares one diff hunk for patching: grows context until the old text is unique in the baseline.
 * Returns `{error}` when the change cannot be shown without deploying.
 */
/** Why a change cannot be located: its online value is empty, Liquid tags surround it, or no unique text does. */
function noAnchorReason(baseText, baseLines, hunk) {
  if (baseText.trim() === '')
    return 'the online value is empty, so no existing text can locate this change; deploy it to apply online';
  const adjacentLogic = Boolean(baseLines[hunk.aStart - 1]?.logic || baseLines[hunk.aEnd]?.logic);
  return adjacentLogic
    ? 'no literal text next to the change to locate it in the page (it sits between Liquid tags)'
    : 'no unique literal text next to the change to locate it in the page';
}

// A script of a source that is shown as a reference to the local file instead of inline text.
function staysExternal(block, src, identical) {
  return (
    !src.extract &&
    block.tag === 'script' &&
    canExternalize(src, scriptType(attributes(block.m[2]))) &&
    (identical || src.active) &&
    src.text.trim() !== ''
  );
}

// The marker interval that binds the element the portal wrote to the field it carries.
function wrapperIntervals(source, tag, src, openingLength) {
  if (!source) return [];
  return [
    {
      start: 0,
      end: openingLength,
      mapping: 'wrapper',
      tag,
      sourceRefId: source.id,
      sourceSpan: { start: 0, end: src.text.length },
    },
  ];
}

// The inline script element as a reference to the local file.
function externalScriptTag(m, src) {
  // Retaining async/defer/integrity after adding src changes execution or blocks the local script.
  const attrs = m[2].replace(
    /* NOSONAR */ /(?<!\s)\s+([^\s=/'"<>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g,
    (whole, name) =>
      // NOSONAR: preserve the exact grammar and captured values
      /^(?:async|defer|integrity)$/i.test(name) ? '' : whole,
  );
  return `<${m[1]}${attrs} src="${inlineScriptUrl(src.rel)}"></${m[1]}>`;
}

// The tags an edit replaces; for a change of text only, the tag it stands in.
function editBindings(edit, starts, aligned) {
  const bindings = starts
    .filter((start) => start >= edit.start && start < edit.end)
    .map((start) => aligned.byStart.get(start));
  if (bindings.length) return bindings;
  let before = -1;
  for (const start of starts) {
    if (start >= edit.start) break;
    before = start;
  }
  return before >= 0 ? [aligned.byStart.get(before)] : bindings;
}

const driftRel = (source) => (source.ref ?? source.file ?? source.id).replaceAll('\\', '/');

function clipDrift(value) {
  const one = value.replace(/\s+/g, ' ').trim();
  return one.length > DRIFT_TEXT ? one.slice(0, DRIFT_TEXT) + '…' : one;
}

// The line a text offset is on, counting from the line `first` the text starts at.
function lineNumberAt(text, offset, first) {
  let line = first;
  for (let at = text.indexOf('\n'); at >= 0 && at < offset; at = text.indexOf('\n', at + 1)) line++;
  return line;
}

// Adds the counted changes to the `patched N change(s)` entry of each file (made when the file has none yet).
function notePatchedCounts(counts, applied) {
  for (const [changed, count] of counts) {
    const known = applied.find((entry) => entry.rel === changed.rel && /^patched \d+ change/.test(entry.action));
    const total = count + (known ? Number(/\d+/.exec(known.action)[0]) : 0);
    const action = `patched ${total} change${total > 1 ? 's' : ''}`;
    if (known) known.action = action;
    else applied.push({ kind: changed.kind, rel: changed.rel, action });
  }
}

const hasLiquid = (text) => text.includes('{{') || text.includes('{%');

// Whether the page differs from the baseline at the place of a difference as well.
const servedElsewhere = (against, difference) =>
  against.some(
    (other) =>
      other.sourceRefId === 'baseline:' + difference.sourceRefId &&
      other.served.start <= difference.served.end &&
      difference.served.start <= other.served.end,
  );

// The edit that puts the text of a changed file where the page differs from it.
function literalEdit(difference, own, changed, text) {
  const line = lineNumberAt(own.text, difference.region.start, 1);
  return {
    start: difference.served.start,
    end: difference.served.end,
    text,
    where: `line ${line}`,
    changed,
    intervals: text
      ? [
          {
            start: 0,
            end: text.length,
            sourceRefId: own.id,
            sourceSpan: { start: difference.region.start, end: difference.region.end },
            mapping: 'literal',
          },
        ]
      : [],
  };
}

// The edits (last first) that do not overlap one that comes after them in the page, and how many each file has.
function acceptLiteralEdits(edits, length, notes) {
  const accepted = [];
  const counts = new Map();
  let limit = length;
  for (const change of edits) {
    if (change.end > limit) {
      notes.push({
        rel: change.changed.rel,
        reason: `${change.where}: overlaps another change in the page, not applied`,
      });
      continue;
    }
    accepted.push(change);
    limit = change.start;
    counts.set(change.changed, (counts.get(change.changed) ?? 0) + 1);
  }
  return { accepted, counts };
}

// The entry of one file in the drift, made when the first place of the file is found.
function driftEntry(files, rel, source, { base, deployed }) {
  let entry = files.get(rel);
  if (!entry) {
    entry = { rel, kind: source.kind, name: source.name ?? '', sourceRefId: source.id, places: 0 };
    if (deployed) entry.deployed = true;
    else if (base) entry.changed = true;
    files.set(rel, entry);
  }
  return entry;
}

// The files and places where the page differs from the version the portal is taken to have (cut short to the limits).
function collectDrift(body, scope, aligned, stand, { settled, unrooted }) {
  const files = new Map();
  const places = [];
  let truncated = false;
  for (const difference of aligned.differences) {
    if (unrooted.has(difference.sourceRefId)) continue;
    const base = stand.get(difference.sourceRefId);
    const source = base?.own ?? scope.index.sources.get(difference.sourceRefId);
    if (!source) continue;
    const rel = driftRel(source);
    const entry = driftEntry(files, rel, source, { base, deployed: settled.has(difference.sourceRefId) });
    entry.places++;
    if (entry.deployed) continue;
    if (places.length >= DRIFT_PLACES) {
      truncated = true;
      continue;
    }
    const version = base ? base.text : source.text;
    places.push({
      rel,
      change: difference.kind,
      line: lineNumberAt(version, difference.region.start, source.region?.line ?? 1),
      local: clipDrift(version.slice(difference.region.start, difference.region.end)),
      served: clipDrift(body.slice(difference.served.start, difference.served.end)),
      ...(difference.open ? { open: true } : {}),
    });
  }
  return { files, places, truncated };
}

// Whether the outer tags of a file (as the ids name it) are found in the page: true, false, or undefined when no
// coverage row says.
function rootedState(aligned, ids) {
  const rows = aligned.coverage.filter((row) => ids.includes(row.sourceRefId));
  if (rows.some((row) => row.rooted)) return true;
  if (rows.some((row) => row.rooted === false)) return false;
  return undefined;
}

function alignmentSummary(alignment) {
  if (alignment.failed) return { failed: alignment.failed };
  return {
    counts: alignment.counts,
    coverage: alignment.coverage,
    truncated: alignment.truncated,
    // places where the page as laid over still is not what the local sources say
    differences: alignment.differences?.length ?? 0,
  };
}

// A hunk that changes lines holding Liquid code: laid over where only literal text or markup around the code changed.
function prepareLogicHunk(oldCore, added, { where, place, baseText, otherLanguages }) {
  const literal = prepareLiteralSegment(oldCore, added, baseText, otherLanguages);
  if (literal) return { where, ...place, ...literal };
  // The same Liquid code before and after: only markup around it changed. That is laid over by position wherever
  // a page shows it between two tags of the file (html-rewriter #layLiteral); text the Liquid code prints into is
  // the portal's to write.
  const code = (lines) =>
    liquidTokens(lines.map((line) => line.text).join('\n'))
      .map((token) =>
        lines
          .map((line) => line.text)
          .join('\n')
          .slice(token.start, token.end),
      )
      .join('\u0000');
  // A comment or capture body is not written where it stands: its lines keep the general answer.
  // (Only the Liquid tokens of such a line are protected; a body is protected as a whole.)
  const inPlace = (lines) =>
    lines.every((line) => {
      const covered = new Uint8Array(line.text.length);
      for (const span of line.protected) covered.fill(1, Math.max(0, span.start), Math.min(line.text.length, span.end));
      const tokens = new Uint8Array(line.text.length);
      for (const token of liquidTokens(line.text)) tokens.fill(1, token.start, token.end);
      return covered.every((flag, at) => !flag || tokens[at]);
    });
  if (inPlace(oldCore) && inPlace(added) && code(oldCore) === code(added))
    return {
      where,
      error:
        'the line holds Liquid code: its changed markup is laid over where a page shows it between two of its tags; text right beside what the Liquid code prints needs a deployment',
    };
  return {
    where,
    error:
      'the change touches Liquid tags, a comment/capture body, or multiline/whitespace-controlled output; the portal has to render it',
  };
}

function prepareHunk(baseLines, newLines, hunk, baseText, otherLanguages = []) {
  const oldCore = baseLines.slice(hunk.aStart, hunk.aEnd);
  const added = newLines.slice(hunk.bStart, hunk.bEnd);
  const where = `line ${hunk.bStart + 1}`;
  // The changed lines' place in the baseline text (offsets of the text as committed), for telling the copies of a
  // repeated line apart in a served page.
  const place = {
    baseStart: hunk.aStart < baseLines.length ? baseLines[hunk.aStart].sourceStart : Number.MAX_SAFE_INTEGER,
    baseEnd: hunk.aEnd < baseLines.length ? baseLines[hunk.aEnd].sourceStart : Number.MAX_SAFE_INTEGER,
  };
  if (oldCore.some((l) => l.logic) || added.some((l) => l.logic))
    return prepareLogicHunk(oldCore, added, { where, place, baseText, otherLanguages });

  let before = 0;
  let after = 0;
  const canGrowBefore = () =>
    before < MAX_CONTEXT && hunk.aStart - before - 1 >= 0 && !baseLines[hunk.aStart - before - 1].logic;
  const canGrowAfter = () =>
    after < MAX_CONTEXT && hunk.aEnd + after < baseLines.length && !baseLines[hunk.aEnd + after].logic;

  let pattern = buildPattern(baseLines, hunk, before, after);
  const sharedLanguageAnchor = () =>
    otherLanguages.some((text) => findMatches(pattern, text).some((match) => standsAlone(pattern, text, match)));
  const good = () =>
    pattern.anchored &&
    pattern.weight >= 3 &&
    findMatches(pattern, baseText, 2).length === 1 &&
    !sharedLanguageAnchor();
  let unique = good();
  let turn = 0;
  while (!unique && (canGrowBefore() || canGrowAfter())) {
    // alternate sides so the anchor stays close to the change
    if ((turn++ % 2 === 0 && canGrowBefore()) || !canGrowAfter()) before++;
    else after++;
    pattern = buildPattern(baseLines, hunk, before, after);
    unique = good();
  }
  if (!pattern.anchored || pattern.weight < 3) return { where, error: noAnchorReason(baseText, baseLines, hunk) };
  if (sharedLanguageAnchor())
    return {
      where,
      error:
        'the literal anchor also occurs in another localized Value or language source; the portal language cannot be determined safely from this response',
    };
  return { where, ...place, pattern, added, unique };
}

/** A single changed literal gap may share a line with unchanged server-rendered logic. */
function prepareLiteralSegment(oldLines, newLines, baseText, otherLanguages) {
  if (oldLines.length !== 1 || newLines.length !== 1) return null;
  const [oldLine] = oldLines,
    [newLine] = newLines;
  if (oldLine.eol !== newLine.eol || oldLine.whitespaceControl || newLine.whitespaceControl) return null;
  const split = (line) => {
    const spans = [];
    for (const span of [...line.protected].sort((a, b) => a.start - b.start || b.end - a.end)) {
      const previous = spans.at(-1);
      if (previous && span.start <= previous.end) previous.end = Math.max(previous.end, span.end);
      else spans.push({ ...span });
    }
    const gaps = [],
      protectedText = [];
    let at = 0;
    for (const span of spans) {
      gaps.push(line.text.slice(at, span.start));
      protectedText.push(line.text.slice(span.start, span.end));
      at = span.end;
    }
    gaps.push(line.text.slice(at));
    return { gaps, protectedText };
  };
  const before = split(oldLine),
    after = split(newLine);
  if (!before.protectedText.length || JSON.stringify(before.protectedText) !== JSON.stringify(after.protectedText))
    return null;
  const changed = before.gaps.map((text, i) => (text !== after.gaps[i] ? i : -1)).filter((i) => i >= 0);
  if (changed.length !== 1) return null;
  const index = changed[0],
    oldText = before.gaps[index],
    newText = after.gaps[index];
  // Do not introduce Liquid or mistake a raw body's literal delimiters for a template gap.
  if (/\{%|\{\{/.test(oldText) || /\{%|\{\{/.test(newText)) return null;
  const pattern = {
    tokens: [{ mark: 'core' }, { lit: oldText }, { mark: 'after' }],
    literal: [oldText],
    anchored: !!oldText,
    weight: oldText.replace(/\s+/g, '').length,
  };
  if (!pattern.anchored || pattern.weight < 3 || findMatches(pattern, baseText, 2).length !== 1) return null;
  if (otherLanguages.some((text) => findMatches(pattern, text).some((match) => standsAlone(pattern, text, match))))
    return null;
  const gapStart = after.gaps
    .slice(0, index)
    .reduce((sum, gap, i) => sum + gap.length + after.protectedText[i].length, 0);
  return {
    pattern,
    added: [{ text: newText, sourceStart: newLine.sourceStart + gapStart, eol: false, outputs: [] }],
    unique: true,
    literalSegment: true,
  };
}

/** LF-normalised copy of `html` plus a way back to offsets in the original. */
function normalise(html) {
  const removed = []; // normalised offsets of the \n whose \r was dropped
  let text = '';
  let last = 0;
  for (let at = html.indexOf('\r\n'); at >= 0; at = html.indexOf('\r\n', at + 2)) {
    text += html.slice(last, at);
    removed.push(text.length);
    last = at + 1;
  }
  // a lone \r is a line break too (the baseline is normalised the same way); same length, so
  // offsets are not affected
  text = (text + html.slice(last)).replaceAll('\r', '\n');
  const original = (offset) => {
    // number of dropped \r strictly before `offset`
    let lo = 0;
    let hi = removed.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (removed[mid] < offset) lo = mid + 1;
      else hi = mid;
    }
    return offset + lo;
  };
  return { text, original, crlf: removed.length * 2 > text.split('\n').length - 1 };
}

// ---- rewriter

export class HtmlRewriter {
  /** Warm cold source reads asynchronously with at most 16 files in flight. */
  static async create(options) {
    const { model, site, baseline } = options;
    const changed = options.changedFiles ?? baseline.changedFiles();
    const inline = new Set(site.inline?.enabled === false ? [] : (site.inline?.kinds ?? []));
    const markup = new Set(site.markup?.enabled === false ? [] : (site.markup?.kinds ?? []));
    const files = [
      ...new Set(
        model.inlineSources
          .filter(
            (src) =>
              !(src.kind.startsWith('page-') && src.pageUrl == null) &&
              (src.mode === 'block' ? inline.has(src.kind) : markup.has(src.kind) && changed.has(src.file)),
          )
          .map((src) => src.file),
      ),
    ];
    const raw = new Map();
    const valid = new Map();
    const stamps = new Map();
    // The baseline blobs refresh() compares changed sources with load while the sources are read.
    const baselines = baseline.preloadAsync?.(
      model.inlineSources.filter((src) => changed.has(src.file)).map((src) => src.file),
    );
    const root = model.sourceDir ? await fs.promises.realpath(model.sourceDir) : null;
    // Each stat/realpath pair runs together: every sequential fs promise costs a thread-pool round trip.
    await orderedMap(files, 16, async (file) => {
      const key = sourceCacheKey(file);
      try {
        const [real, before] = await Promise.all([fs.promises.realpath(file), fs.promises.stat(file)]);
        const relative = root ? path.relative(root, real) : null;
        if (
          root &&
          (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
        )
          throw new Error('outside source root');
        if (!before.isFile()) throw new Error('not a regular source file');
        const text = await readLocalFile(file, { root, maxBytes: Number.MAX_SAFE_INTEGER, encoding: 'utf8' });
        const [after, current] = await Promise.all([fs.promises.stat(file), fs.promises.realpath(file)]);
        if (!sameStamp(before, after) || current !== real) throw new Error('source changed during startup');
        raw.set(key, text.replace(/^\uFEFF/, ''));
        valid.set(key, true);
        stamps.set(key, stampOf(file, real, after));
      } catch {
        // Retry only unstable/unreadable entries through the constructor's normal guarded
        // read. A save finishing during startup must not leave a permanently cached miss.
      }
    });
    // An early file can be saved while later files are still loading. Revalidate the entire
    // prefetched snapshot once all reads finish; the constructor retries only stale entries.
    await orderedMap(stamps, 16, async ([key, stamp]) => {
      try {
        const [info, real] = await Promise.all([fs.promises.stat(stamp.file), fs.promises.realpath(stamp.file)]);
        if (sameStamp(stamp.info, info) && real === stamp.real) return;
      } catch {
        /* removed or replaced source */
      }
      raw.delete(key);
      valid.delete(key);
      stamps.delete(key);
    });
    await baselines;
    return new HtmlRewriter(options, { raw, valid, changed, stamps });
  }

  /**
   * @param {object} o
   * @param {import('./portal-model.mjs').PortalModel} o.model
   * @param {import('./config.mjs').SiteConfig} o.site
   * @param {import('./git.mjs').GitBaseline} o.baseline
   * @param {boolean} [o.sourceMaps]
   * @param {Set<string>} [o.disabled] sources (`rel`) that are switched off: known, but not laid over the page
   */
  constructor({ model, site, baseline, sourceMaps = false, disabled = new Set(), changedFiles }, prepared) {
    this.disabled = disabled;
    this.model = model;
    this.site = site;
    this.baseline = baseline;
    this.changedFiles = changedFiles;
    /** load the inline scripts that correspond to a local file from that file, so they can be debugged */
    this.sourceMaps = sourceMaps;
    this.sourceCache = prepared?.raw ?? new Map();
    this.sourceStamps = prepared?.stamps ?? new Map();
    this.blockCache = new Map();
    this.prepared = prepared;
    this.refresh(prepared ? [] : undefined);
  }

  /** Re-reads changed sources, or all sources when no file list is supplied. */
  refresh(files, options) {
    // One synchronous index build: source checks resolve each directory once, not once per source.
    indexingPass(() => this.#refresh(files, options));
  }

  #refresh(files, { revalidate = false } = {}) {
    const invalidate = (key) => {
      this.sourceCache.delete(key);
      this.sourceStamps.delete(key);
    };
    this.#invalidateRefreshCache(files, invalidate);
    // Native realpath resolves like the startup prefetch (fs.promises.realpath), so stamps it took stay
    // comparable (8.3 names, drive-letter case), without lstat-ing every path component.
    if (revalidate) this.#revalidateSources(invalidate);
    const { site, model } = this;
    this.fieldReader = createSourceReader(model);
    this.baselineReader = createSourceReader(null, { readRaw: (file) => this.baseline.show(file) });
    const changed = this.prepared?.changed ?? this.changedFiles ?? this.baseline.changedFiles();
    this.readValidity = this.prepared?.valid ?? new Map();
    this.prepared = null;
    const previousBlocks = this.blockCache;
    this.blockCache = new Map();
    // After a partial refresh the browser can swap a changed block in place when it knows the
    // text the page currently shows. A full refresh cannot tell which blocks changed: null.
    const partial = Array.isArray(files) ? new Set(files.map(sourceCacheKey)) : null;
    /** @type {Map<string, {kind: string, tag: string, pageKey: string|null, before: string|null, after: string}>|null} */
    this.blockChanges = partial ? new Map() : null;
    this.baseline.preload?.(model.inlineSources.filter((src) => changed.has(src.file)).map((src) => src.file));
    const restrict = site.scope === 'changed';
    const inlineKinds = new Set(site.inline?.enabled === false ? [] : (site.inline?.kinds ?? []));
    const markupKinds = new Set(site.markup?.enabled === false ? [] : (site.markup?.kinds ?? []));

    /**
     * Every block source, used to recognise the online blocks. Only `active` ones replace anything:
     * with scope 'changed' an untouched script still has to be known, so that a block that is really
     * its online copy is not mistaken for the one being edited.
     */
    this.blocks = [];
    /** markup files with a prepared patch */
    this.patches = [];
    /** every markup source that differs from the baseline, with the baseline's text: [{...src, baseText}] */
    this.changedMarkup = [];
    /** changes that cannot be previewed locally: [{rel, reason}] */
    this.unsupported = model.deploymentChanges?.(this.baseline, changed) ?? [];
    this.#reportInactiveSources(model.inactiveSources, changed);
    this.snippets = null;

    // in how many local scripts each line occurs: the more, the less it identifies one of them
    const frequency = new Map();
    const weights = new Map();
    // Never retain arbitrary lines received from the portal across navigations.
    this.lineWeight = (line) => sourceLineWeight(frequency, weights, line);

    // the deployed version of a source; several sources can live in one file (enhanced format)
    const baseOf = (src) => this.baselineReader(src);
    const unreadable = new Set();
    const read = (src) => this.#readSourceForRefresh(src, unreadable);

    const refreshState = {
      changed,
      inlineKinds,
      markupKinds,
      previousBlocks,
      partial,
      frequency,
      restrict,
      read,
      baseOf,
    };
    for (const src of model.inlineSources) this.#refreshSource(src, refreshState);
    for (const block of this.blocks) {
      block.weight = sumLineWeights(block.lines, this.lineWeight);
      block.baseWeight = sumLineWeights(block.baseLines, this.lineWeight);
    }
    this.activeBlocks = this.blocks.filter((b) => b.active).length;
    this.readValidity = null;
  }

  #invalidateRefreshCache(files, invalidate) {
    if (files == null) {
      this.sourceCache.clear();
      this.sourceStamps.clear();
    } else for (const file of files) invalidate(sourceCacheKey(file));
  }

  #revalidateSources(invalidate) {
    for (const key of this.sourceCache.keys()) {
      const stamp = this.sourceStamps.get(key);
      try {
        if (
          stamp &&
          !stamp.racy &&
          sameStamp(stamp.info, fs.statSync(stamp.file)) &&
          fs.realpathSync.native(stamp.file) === stamp.real
        )
          continue;
      } catch {
        /* removed or replaced source */
      }
      invalidate(key);
    }
  }

  #reportInactiveSources(sources, changed) {
    for (const source of sources ?? [])
      if (changed.has(source.file))
        this.unsupported.push({
          rel: source.rel,
          reason:
            'the record or its parent is inactive; activate and deploy it before this local change can be previewed',
        });
  }

  #readSourceForRefresh(src, unreadable) {
    const text = this.#readSource(src);
    if (text == null && src.extract && !unreadable.has(src.file)) {
      unreadable.add(src.file);
      this.unsupported.push({
        rel: src.rel,
        reason:
          'the source field cannot be read from its metadata; the record, field or localized identity is missing or invalid',
      });
    }
    return text;
  }

  /* NOSONAR: single-pass routine, splitting it would change shared state */ #refreshSource(src, state) {
    const { changed, inlineKinds, markupKinds, read, baseOf } = state;
    if (src.kind.startsWith('page-') && src.pageUrl == null) {
      // Only a local edit of such a source is a limitation worth reporting; an untouched one is
      // what the portal already serves. The model warns about the broken page hierarchy itself.
      if (changed.has(src.file) && !this.disabled.has(src.rel))
        this.unsupported.push({
          rel: src.rel,
          reason: 'the page URL cannot be resolved from local metadata, so this local change cannot be previewed',
        });
      return;
    }
    const isChanged = changed.has(src.file);
    const enabledKinds = src.mode === 'block' ? inlineKinds : markupKinds;
    if (isChanged && !enabledKinds.has(src.kind) && !this.disabled.has(src.rel)) {
      const text = read(src);
      const base = baseOf(src);
      if (text != null && normEol(text) !== normEol(base ?? ''))
        this.unsupported.push({
          rel: src.rel,
          reason: `${src.kind} preview is disabled in this site's ${src.mode === 'block' ? 'inline' : 'markup'} settings; deploy this change to apply it online`,
        });
    }
    if (src.mode === 'block') {
      this.#refreshBlockSource(src, isChanged, state);
      return;
    }
    // What the baseline holds of a changed markup file, whether or not its change is laid over the page: the served
    // page is compared with it to tell whether the baseline is what the portal has.
    if (isChanged)
      this.changedMarkup.push({
        ...src,
        baseText: baseOf(src),
        // whether this file's change is laid over pages (its kind is enabled and the override is not paused)
        overlay: markupKinds.has(src.kind) && !this.disabled.has(src.rel),
      });
    if (markupKinds.has(src.kind) && isChanged && !this.disabled.has(src.rel)) {
      const text = read(src);
      if (text != null) this.#preparePatch(src, text, baseOf(src));
    }
  }

  #refreshBlockSource(src, isChanged, state) {
    const { inlineKinds, read, baseOf } = state;
    if (!inlineKinds.has(src.kind)) return;
    const text = read(src);
    if (text == null) return;
    const base = isChanged ? baseOf(src) : null;
    if (!text.trim() && !base?.trim()) return; // empty here and in the baseline
    if (/\{%|\{\{/.test(text) || (base && /\{%|\{\{/.test(base))) {
      // Liquid inside a custom JS/CSS field: the portal renders it, so patch instead of replace
      if (isChanged && !this.disabled.has(src.rel)) this.#preparePatch(src, text, base);
      return;
    }
    this.#cacheBlockSource(src, isChanged, text, base, state);
  }

  /* NOSONAR */ #cacheBlockSource(src, isChanged, text, base, state) {
    const { previousBlocks, partial, frequency, restrict } = state;
    const previous = previousBlocks.get(src.rel);
    const norm = previous?.text === text ? previous.norm : normEol(text);
    const lines = previous?.text === text ? previous.lines : lineSet(norm);
    const baseNorm = base == null ? null : normEol(base);
    let baseLines = null;
    if (baseNorm != null && baseNorm !== norm)
      baseLines = previous?.base === base && previous.baseLines ? previous.baseLines : lineSet(baseNorm);
    this.blockCache.set(src.rel, { text, norm, lines, base, baseLines });
    if (partial?.has(sourceCacheKey(src.file)) && previous?.text !== text) {
      this.blockChanges.set(src.rel, {
        kind: src.kind,
        tag: src.tag,
        pageKey: src.pageUrl ? urlKey(src.pageUrl) : null,
        before: previous?.text ?? null,
        after: text,
      });
    }
    for (const line of lines) frequency.set(line, (frequency.get(line) ?? 0) + 1);
    this.blocks.push({
      ...src,
      text,
      norm,
      lines,
      baseLines,
      active: (!restrict || isChanged) && !this.disabled.has(src.rel),
      isNew: isChanged && !base?.trim(),
      pageKey: src.pageUrl ? urlKey(src.pageUrl) : null,
      usedKeys: new Set((src.usedOn ?? []).map(urlKey)),
    });
  }

  #readSource(src) {
    const key = sourceCacheKey(src.file);
    let allowed = this.readValidity?.get(key);
    if (allowed === undefined) {
      allowed = !this.model.sourceDir || isSourceFile(this.model.sourceDir, src.file);
      this.readValidity?.set(key, allowed);
    }
    if (!allowed) {
      this.sourceCache.delete(key);
      this.sourceStamps.delete(key);
      return null;
    }
    // Metadata documents can describe thousands of individual fields. Reuse the
    // model's stamped parse instead of parsing the whole document for each field.
    if (src.fieldPath && /\.ya?ml$/i.test(src.file)) return this.fieldReader(src);
    if (!this.sourceCache.has(key)) {
      let text = null;
      // A concurrent atomic save may replace the file between its read and stat. Retry once;
      // never label old bytes with the new file's stamp and then retain them indefinitely.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const real = fs.realpathSync.native(src.file);
          const before = fs.statSync(src.file);
          text = readText(src.file);
          const after = fs.statSync(src.file);
          if (text != null && sameStamp(before, after) && fs.realpathSync.native(src.file) === real) {
            this.sourceStamps.set(key, stampOf(src.file, real, after));
            break;
          }
        } catch {
          /* unreadable source */
        }
        text = null;
      }
      this.sourceCache.set(key, text);
    }
    return sourceText(src, this.sourceCache.get(key));
  }

  #preparePatch(src, text, base) {
    if (base == null) {
      if (text.trim()) {
        this.unsupported.push({
          rel: src.rel,
          reason: `new ${src.kind}: it does not exist online yet, the portal has to render it`,
        });
      }
      return;
    }
    const baseLines = toLines(base);
    const newLines = toLines(text);
    const hunks = diffLines(baseLines.map(lineKey), newLines.map(lineKey));
    if (!hunks.length) return;
    const baseText = normEol(base);
    const otherLanguages =
      sourceLocale(src) == null
        ? []
        : this.model.inlineSources
            .filter((other) => other !== src && differentLocalizedVariants(src, other))
            .map((other) => this.baselineReader(other))
            .filter((value) => value != null)
            .map(normEol);
    const prepared = [];
    for (const hunk of hunks) {
      const p = prepareHunk(baseLines, newLines, hunk, baseText, otherLanguages);
      if (p.error) this.unsupported.push({ rel: src.rel, reason: `${p.where}: ${p.error}` });
      else prepared.push(p);
    }
    if (prepared.length)
      this.patches.push({
        ...src,
        hunks: prepared,
        contentRevision: createHash('sha256').update(text).digest('hex'),
        // What the portal has of this file: where a change may be laid is decided against it.
        baseText: base,
      });
  }

  /** Local snippet value plus whether choosing a value would guess its language. */
  #snippetValue(name) {
    if (!this.snippets) this.#loadSnippetIndex();
    const variants = this.snippets.get(name.toLowerCase());
    if (!variants?.length) return { value: null, ambiguous: false };
    const values = variants.map((src) => this.#readSource(src));
    // A new expression has no rendered baseline value identifying its language. Only an
    // identical value across variants can be inserted without guessing that language.
    const ambiguous = !values.every((value) => value === values[0]);
    return { value: ambiguous ? null : values[0], ambiguous };
  }

  #loadSnippetIndex() {
    this.snippets = new Map();
    for (const src of this.model.inlineSources) {
      if (src.kind !== 'content-snippet') continue;
      let snippetName = src.snippetName;
      if (snippetName === undefined) {
        const yml = readText(src.file.replace(/\.value\.html$/, '.yml'));
        snippetName =
          (yml &&
            /^adx_name:\s*(.+)$/m // NOSONAR: fixed line prefix; the first remaining non-line-terminator always succeeds at that line's end.
              .exec(yml)?.[1]
              .trim()
              .replace(/^["']|["']$/g, '')) ||
          null;
      }
      if (snippetName) {
        const key = snippetName.toLowerCase();
        if (!this.snippets.has(key)) this.snippets.set(key, []);
        this.snippets.get(key).push(src);
      }
    }
  }

  /**
   * @param {string} body the online response body
   * @param {string} urlPath pathname of the request
   * @param {{html?: boolean}} [opts] `html: false` for data responses (JSON, text) produced by a
   *   web template: only template changes are applied to those
   * @returns {{html: string, applied: Array<{kind:string, rel:string, action:string}>, notes: Array<{rel:string, reason:string}>, matched: Array<object>}}
   */
  rewrite(body, urlPath, { html = true, isDocument = false, sourceIndex = null, provenance: named = true } = {}) {
    const applied = [];
    const notes = [];
    /** every local block source recognised in the page, changed or not: [{kind, rel, score, identical, online}] */
    const matched = [];
    // `named` false: the export is asked only where a local change may be laid; no element is marked.
    const provenance = named && sourceIndex && isDocument && html ? { index: sourceIndex, intervals: [] } : null;
    /** page fields with local text that the served document does not carry: [{kind, rel, file}] */
    const absent = [];
    // The export's own view of the document, when the session has one: which script and style elements a markup
    // source wrote, and (for a changed markup file) whether a place in the document is that file's or another's.
    const scope = sourceIndex && html ? { index: sourceIndex, route: pageKey(urlPath, this.model) } : null;
    // The response as the portal sent it against what the baseline says the portal has.
    const served = scope ? this.#servedState(body, scope) : null;
    const markupBlocks = served && this.blocks.length ? served.markupBlocks : null;
    let out = html
      ? this.#rewriteBlocks(body, urlPath, applied, matched, notes, provenance, { markupBlocks, absent })
      : body;
    out = this.#applyPatches(out, applied, notes, html, urlPath, provenance, scope, served?.deployed);
    if (served?.drift.files.length) this.#driftNotes(served.drift.files, scope, notes);
    // Markup a changed file spells out that the page still shows differently: laid over where it stands.
    if (scope && this.changedMarkup.length) out = this.#layLiteral(out, scope, applied, notes, provenance);
    // What the document holds beyond the local changes laid over it: every other tag is matched against the export,
    // so an element the portal rendered from an unchanged template is identified as well.
    const alignment = provenance ? this.#alignProvenance(out, provenance, sourceIndex, urlPath) : null;
    const finalized = provenance
      ? finalizePortalProvenance({
          fragment: { text: out, intervals: provenance.intervals },
          index: sourceIndex,
          channel: 'lense-applied-response',
          tagBindings: alignment?.byStart ?? null,
        })
      : { html: out };
    return {
      ...finalized,
      applied,
      notes,
      matched,
      absent,
      ...(served ? { drift: served.drift } : {}),
      ...(alignment ? { alignment: alignmentSummary(alignment) } : {}),
    };
  }

  // The notes that say how the served files compare with the baseline (the drift a response showed).
  #driftNotes(driftFiles, scope, notes) {
    const patched = new Map();
    for (const patch of this.patches) {
      const own = this.#indexSource(scope.index, patch);
      if (own) patched.set(own.id, patch.rel);
    }
    for (const file of driftFiles)
      if (file.deployed)
        notes.push({
          rel: patched.get(file.sourceRefId) ?? file.rel,
          reason:
            'the portal already serves this version of the file where the page shows it: those changes are not laid over a second time',
        });
      else if (patched.has(file.sourceRefId))
        notes.push({
          rel: patched.get(file.sourceRefId),
          reason:
            'the portal serves another version of this file than the comparison baseline: a local change next to a place that differs may not be laid over',
        });
  }

  // What the document holds beyond the local changes laid over it: the tags matched against the export.
  #alignProvenance(out, provenance, sourceIndex, urlPath) {
    let alignment;
    const wrappers = provenance.intervals.filter((interval) => interval.mapping === 'wrapper');
    provenance.intervals = provenance.intervals.filter((interval) => interval.mapping !== 'wrapper');
    try {
      alignment = alignDocument(out, sourceIndex, pageKey(urlPath, this.model));
    } catch (error) {
      alignment = { failed: String(error?.message ?? error).split(/\r?\n/)[0], byStart: new Map() };
    }
    // An inline block matched to a field: its element was written by the portal to carry that field.
    // Script text a markup source holds literally maps to that source line for line.
    for (const interval of alignment.scriptIntervals ?? [])
      if (
        !provenance.intervals.some(
          (existing) =>
            existing.start < interval.end && existing.end > interval.start && existing.mapping === 'literal',
        )
      )
        provenance.intervals.push(interval);
    for (const wrapper of wrappers)
      alignment.byStart.set(wrapper.start, {
        start: wrapper.start,
        end: wrapper.end,
        tag: wrapper.tag,
        mapping: 'generated',
        sourceRefId: wrapper.sourceRefId,
        region: wrapper.sourceSpan,
        contexts: alignment.byStart.get(wrapper.start)?.contexts ?? [],
      });
    return alignment;
  }

  #provenanceSource(src, index, text) {
    if (!index) return null;
    const field =
      src.field?.replace(/^(?:adx|mspp)_/, '') ??
      {
        'web-template': 'source',
        'content-snippet': 'value',
        'page-copy': 'copy',
        'page-summary': 'summary',
        'page-js': 'customjavascript',
        'basic-form-js': 'customjavascript',
        'list-js': 'customjavascript',
        'advanced-form-step-js': 'customjavascript',
        'page-css': 'customcss',
      }[src.kind];
    const candidates = [...index.sources.values()].filter(
      (source) =>
        source.file &&
        source.file.toLowerCase() === src.file.toLowerCase() &&
        source.fieldPath?.at(-1) === field &&
        (src.lcid === undefined || source.lcid === src.lcid) &&
        (!(src.componentId ?? src.recordId) ||
          source.recordId === String(src.componentId ?? src.recordId).toLowerCase()),
    );
    return candidates.length === 1 && candidates[0].contentRevision === createHash('sha256').update(text).digest('hex')
      ? candidates[0]
      : null;
  }

  #inlineBlockReplacement(block, src, replace, provenance, notes) {
    const m = block.m;
    const content = m[3];
    const lead = /^\s*/.exec(content)[0];
    const trail = content.slice(content.trimEnd().length);
    const eol = content.includes('\r\n') || !content.includes('\n') ? '\r\n' : '\n';
    const newContent = `${lead}${src.norm.trim().replaceAll('\n', eol)}${trail}`;
    if (!preservesInlineBoundary(block.tag, newContent, m.closing)) {
      notes.push({
        rel: src.rel,
        reason: `the local ${block.tag} content changes its HTML closing boundary; escape the closing-tag text in the source before previewing it inline`,
      });
      return null;
    }
    const replacement = `${m.opening}${newContent}${m.closing}`;
    const source = this.#provenanceSource(src, provenance?.index, src.text);
    const intervals = source && replace ? this.#blockSourceIntervals(m, src, source, lead, eol) : [];
    return { replacement, intervals };
  }

  #blockSourceIntervals(m, src, source, lead, eol) {
    const intervals = [];
    const normalized = normalise(src.text);
    const trimmed = src.norm.trim();
    const leading = src.norm.length - src.norm.trimStart().length;
    let local = leading;
    let generated = m.opening.length + lead.length;
    for (const line of trimmed.split('\n')) {
      if (line)
        intervals.push({
          start: generated,
          end: generated + line.length,
          sourceRefId: source.id,
          sourceSpan: { start: normalized.original(local), end: normalized.original(local + line.length) },
          mapping: 'literal',
        });
      local += line.length + 1;
      generated += line.length + eol.length;
    }
    return intervals;
  }

  #rewriteMatchedBlock(block, { applied, matched, notes, provenance }) {
    const { m, src } = block;
    if (!src) return null;
    const identical = block.norm === src.norm.trim();
    matched.push({
      kind: src.kind,
      rel: src.rel,
      file: src.file,
      score: block.score,
      identical,
      active: src.active,
      online: identical ? undefined : block.norm,
    });
    const replace = !identical && src.active;
    // A script replaced by the local file can be debugged in that file, but debuggers do not
    // follow source maps of inline scripts. Modules stay inline because moving their URL changes imports.
    const external = this.sourceMaps && staysExternal(block, src, identical);
    // The element the portal wrote for this field (a page's custom JavaScript, a form's, a list's): bound to that
    // field whether its text is replaced or not.
    const source = this.#provenanceSource(src, provenance?.index, src.text);
    const wrapper = (openingLength) => wrapperIntervals(source, block.tag, src, openingLength);
    if (!replace && !external) {
      if (!source) return null;
      // Nothing is replaced: the served text stays. An identical one is the local file's text line for line, so
      // code it runs can be followed to the file.
      return {
        start: m.index,
        end: m.index + m[0].length,
        text: m[0],
        intervals: [...wrapper(m.opening.length), ...(identical ? this.#servedBlockIntervals(m, src, source) : [])],
      };
    }
    let replacement;
    let intervals;
    if (external) {
      replacement = externalScriptTag(m, src);
      intervals = wrapper(replacement.indexOf('>') + 1);
    } else {
      const inline = this.#inlineBlockReplacement(block, src, replace, provenance, notes);
      if (!inline) return null;
      ({ replacement, intervals } = inline);
      intervals = [...wrapper(m.opening.length), ...intervals];
    }
    if (replace) applied.push({ kind: src.kind, rel: src.rel, action: 'replaced inline block' });
    return { start: m.index, end: m.index + m[0].length, text: replacement, intervals };
  }

  // Lines of a served block that equal the lines of the local file, in order: each maps to its place in the file.
  #servedBlockIntervals(m, src, source) {
    const normalized = normalise(src.text);
    const sourceLines = normalized.text.split('\n');
    const intervals = [];
    let sourceAt = 0;
    let line = 0;
    while (line < sourceLines.length && !sourceLines[line].trim()) sourceAt += sourceLines[line++].length + 1;
    let generated = m.opening.length;
    let started = false;
    for (const part of m[3].split(/(\r\n|\n|\r)/)) {
      if (/^(?:\r\n|\n|\r)$/.test(part)) {
        generated += part.length;
        continue;
      }
      if (!started && !part.trim()) {
        generated += part.length;
        continue;
      }
      started = true;
      if (line >= sourceLines.length || sourceLines[line] !== part) break;
      if (part)
        intervals.push({
          start: generated,
          end: generated + part.length,
          sourceRefId: source.id,
          sourceSpan: { start: normalized.original(sourceAt), end: normalized.original(sourceAt + part.length) },
          mapping: 'literal',
        });
      generated += part.length;
      sourceAt += sourceLines[line++].length + 1;
    }
    return intervals;
  }

  #applyBlockReplacements(html, found, context) {
    let out = '';
    let at = 0;
    const blockEdits = [];
    for (const block of found) {
      const edit = this.#rewriteMatchedBlock(block, context);
      if (!edit) continue;
      out += html.slice(at, edit.start) + edit.text;
      blockEdits.push(edit);
      at = edit.end;
    }
    out += html.slice(at);
    if (context.provenance)
      context.provenance.intervals = applyRenderEdits({ text: html, intervals: [] }, blockEdits).intervals;
    return out;
  }

  /* NOSONAR */ #injectPageBlock(out, src, pending, applied, notes, provenance) {
    if (pending.some((other) => differentLocalizedVariants(src, other) && other.norm !== src.norm)) {
      notes.push({
        rel: src.rel,
        reason:
          'new page blocks differ between language variants; no rendered baseline identifies which language to inject',
      });
      return out;
    }
    const external = src.tag === 'script' && this.sourceMaps && !src.extract && canExternalize(src);
    const content = src.tag === 'style' ? src.text : `\n${src.text}\n`;
    if (!external && !preservesInlineBoundary(src.tag, content)) {
      notes.push({
        rel: src.rel,
        reason: `the local ${src.tag} content changes its HTML closing boundary; escape the closing-tag text in the source before previewing it inline`,
      });
      return out;
    }
    let element;
    // A strict CSP admits an inline style or a script only with the nonce of the page.
    const nonce = pageScriptNonce(out);
    const nonceAttribute = nonce ? ` nonce="${nonce}"` : '';
    let opening = `<style type="text/css"${nonceAttribute}>`;
    if (src.tag === 'style') element = `${opening}${src.text}</style>\n`;
    else if (external) {
      opening = `<script type="text/javascript"${nonceAttribute} src="${inlineScriptUrl(src.rel)}">`;
      element = `${opening}</script>\n`;
    } else {
      opening = pageScriptOpening(out);
      element = `${opening}\n${src.text}\n</script>\n`;
    }
    const anchor = closingElementOffset(out, src.tag === 'style' ? 'head' : 'body');
    if (anchor < 0) {
      notes.push({
        rel: src.rel,
        reason: `the page has no closing ${src.tag === 'style' ? 'head' : 'body'} tag to put the new ${src.tag} before; deploy it to see it`,
      });
      return out;
    }
    if (provenance) {
      const source = this.#provenanceSource(src, provenance.index, src.text);
      const start = opening.length + (src.tag === 'style' ? 0 : '\n'.length);
      const intervals = source
        ? [
            {
              start: 0,
              end: opening.length,
              mapping: 'wrapper',
              tag: src.tag,
              sourceRefId: source.id,
              sourceSpan: { start: 0, end: src.text.length },
            },
            ...(external
              ? []
              : [
                  {
                    start,
                    end: start + src.text.length,
                    sourceRefId: source.id,
                    sourceSpan: { start: 0, end: src.text.length },
                    mapping: 'literal',
                  },
                ]),
          ]
        : [];
      provenance.intervals = applyRenderEdits({ text: out, intervals: provenance.intervals }, [
        { start: anchor, end: anchor, text: element, intervals },
      ]).intervals;
    }
    const injected = out.slice(0, anchor) + element + out.slice(anchor);
    applied.push({ kind: src.kind, rel: src.rel, action: 'injected (not online yet)' });
    return injected;
  }

  #injectPageBlocks(out, candidates, docKey, claimed, identity, { applied, notes, provenance }) {
    const pending = candidates
      .filter((b) => b.active && b.pageKey === docKey && b.isNew && b.text.trim() && !claimed.has(identity(b)))
      .sort((a, b) => Number(isLanguageCopy(b)) - Number(isLanguageCopy(a)));
    const done = new Set();
    for (const src of pending) {
      if (done.has(src.kind)) continue;
      done.add(src.kind);
      out = this.#injectPageBlock(out, src, pending, applied, notes, provenance);
    }
    return out;
  }

  #rewriteBlocks(html, urlPath, applied, matched, notes, provenance, { markupBlocks = null, absent = null } = {}) {
    if (!this.blocks.length) return html;
    const docKey = pageKey(urlPath, this.model);
    const minSim = this.site.inline?.minSimilarity ?? 0.5;
    const candidates = servedLanguageVariants(
      this.blocks.filter((b) => !b.pageKey || b.pageKey === docKey),
      documentLanguage(html, urlPath, this.model),
    );
    if (!candidates.length) return html;
    const { found, pairs } = collectBlockPairs(html, candidates, docKey, minSim, this.lineWeight, markupBlocks);
    const { claimed, identity } = claimBlockPairs(pairs, notes);
    let out = this.#applyBlockReplacements(html, found, { applied, matched, notes, provenance });
    if (this.site.inline?.injectMissingPageBlocks !== false)
      out = this.#injectPageBlocks(out, candidates, docKey, claimed, identity, { applied, notes, provenance });
    for (const src of candidates) {
      if (!src.text.trim() || claimed.has(identity(src))) continue;
      // Custom code of a form, list or step that exists only locally: the portal does not print it yet, and Lense
      // cannot tell where in the page it would stand. Said on a page that is configured to show the component.
      if (!src.pageKey && src.isNew && src.active && src.usedKeys.has(docKey))
        notes.push({
          rel: src.rel,
          reason: `new ${src.kind}: the portal does not print it yet, deploy it to run it on this page`,
        });
      // A page field with local text the served page does not carry: not deployed, or not printed by the template.
      else if (src.pageKey && !src.isNew && absent) absent.push({ kind: src.kind, rel: src.rel, file: src.file });
    }
    return out;
  }

  #patchSourceReference(patch, provenance) {
    const field =
      patch.field?.replace(/^(?:adx|mspp)_/, '') ??
      { 'web-template': 'source', 'content-snippet': 'value', 'page-copy': 'copy', 'page-summary': 'summary' }[
        patch.kind
      ];
    const sourceCandidates = provenance
      ? [...provenance.index.sources.values()].filter(
          (source) =>
            source.file &&
            source.file.toLowerCase() === patch.file.toLowerCase() &&
            source.fieldPath?.at(-1) === field &&
            (patch.lcid === undefined || source.lcid === patch.lcid) &&
            (!(patch.componentId ?? patch.recordId) ||
              source.recordId === String(patch.componentId ?? patch.recordId).toLowerCase()),
        )
      : [];
    return sourceCandidates.length === 1 && sourceCandidates[0].contentRevision === patch.contentRevision
      ? sourceCandidates[0]
      : null;
  }

  #patchValue(whole, expr, match, state) {
    const key = normExpr(expr);
    if (match.values.has(key)) return match.values.get(key);
    const snippet = /^snippets?\s*\[\s*"([^"]+)"\s*\]$/.exec(key);
    const snippetValue = snippet ? this.#snippetValue(snippet[1]) : null;
    const value = snippetValue?.value;
    if (value != null && !/\{%|\{\{/.test(value)) return value;
    state.unresolved ??= whole;
    state.unresolvedLanguage ||= Boolean(snippetValue?.ambiguous);
    return whole;
  }

  #appendPatchLiteral(rendered, text, from, line, sourceRef, state) {
    if (text && sourceRef)
      state.intervals.push({
        start: state.outputOffset + rendered.length,
        end: state.outputOffset + rendered.length + text.length,
        sourceRefId: sourceRef.id,
        sourceSpan: { start: line.sourceStart + from, end: line.sourceStart + from + text.length },
        mapping: 'literal',
      });
    return rendered + text;
  }

  #renderAddedLine(line, match, sourceRef, eol, state) {
    let at = 0;
    let rendered = '';
    for (const output of line.outputs) {
      rendered = this.#appendPatchLiteral(rendered, line.text.slice(at, output.index), at, line, sourceRef, state);
      at = output.index + output.text.length;
      rendered += this.#patchValue(output.text, output.expr, match, state);
    }
    rendered = this.#appendPatchLiteral(rendered, line.text.slice(at), at, line, sourceRef, state);
    const result = rendered + (line.eol ? eol : '');
    state.outputOffset += result.length;
    return result;
  }

  #renderPatchReplacement(hunk, match, sourceRef, eol) {
    const state = { unresolved: null, unresolvedLanguage: false, intervals: [], outputOffset: 0 };
    let replacement = '';
    for (const line of hunk.added) replacement += this.#renderAddedLine(line, match, sourceRef, eol, state);
    return { replacement, ...state };
  }

  #patchHunkEdits(patch, hunk, text, original, eol, sourceRef, notes, locate = null) {
    const all = findMatches(hunk.pattern, text);
    if (!all.length) return [];
    let found = all.filter((match) => standsAlone(hunk.pattern, text, match));
    if (!found.length) return [];
    if ((!hunk.unique || hunk.literalSegment) && found.length > 1) {
      // The text stands in the page more than once. Where the export's view of the page shows which of those places
      // this line of this file wrote, the change goes there; otherwise nowhere.
      const placed = locate ? locate(found, hunk, original) : [];
      if (!placed.length) {
        notes.push({
          rel: patch.rel,
          reason: `${hunk.where}: the surrounding text occurs ${found.length} times in the page, change not applied`,
        });
        return [];
      }
      found = placed;
    }
    const edits = [];
    for (const match of found) {
      const rendered = this.#renderPatchReplacement(hunk, match, sourceRef, eol);
      if (rendered.unresolved) {
        notes.push({
          rel: patch.rel,
          reason: rendered.unresolvedLanguage
            ? `${hunk.where}: ${rendered.unresolved} has differing local language variants; the portal language cannot be determined safely for this new expression`
            : `${hunk.where}: ${rendered.unresolved} is new and only the portal can evaluate it`,
        });
        continue;
      }
      edits.push({
        start: original(match.core),
        end: original(match.after),
        text: rendered.replacement,
        where: hunk.where,
        intervals: rendered.intervals,
      });
    }
    return edits;
  }

  #applyPatchEdits(out, patch, edits, applied, notes, provenance) {
    if (!edits.length) return out;
    // apply from the end so earlier offsets stay valid
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    let limit = out.length;
    let hits = 0;
    const pieces = [];
    const acceptedEdits = [];
    for (const edit of edits) {
      if (edit.end > limit) {
        notes.push({
          rel: patch.rel,
          reason: `${edit.where}: overlaps another change of this file in the page, not applied`,
        });
        continue;
      }
      pieces.push(out.slice(edit.end, limit), edit.text);
      acceptedEdits.push(edit);
      limit = edit.start;
      hits++;
    }
    pieces.push(out.slice(0, limit));
    if (provenance)
      provenance.intervals = applyRenderEdits({ text: out, intervals: provenance.intervals }, acceptedEdits).intervals;
    const next = pieces.toReversed().join('');
    if (hits)
      applied.push({ kind: patch.kind, rel: patch.rel, action: `patched ${hits} change${hits > 1 ? 's' : ''}` });
    return next;
  }

  /**
   * A changed line is laid over the page only where this file wrote it. The same line can stand in another template
   * or snippet that is not changed: there the served text is that other source's, and patching it would show a
   * change the deployment would not make. The document is aligned with the export and with this file's baseline; a
   * place that another source explains (alone, or as well as this file) keeps the served text.
   */
  /**
   * The served document aligned with the export and with the baseline of a changed file: which tag of the document
   * is which tag of which source. Null when the file is not one field of the export's index.
   */
  #patchView(out, patch, scope) {
    const own = this.#indexSource(scope.index, patch);
    if (!own || typeof patch.baseText !== 'string') return null;
    const baseline = 'baseline:' + own.id;
    let aligned;
    try {
      aligned = alignDocument(out, scope.index, scope.route, {
        extra: [{ id: baseline, text: patch.baseText, like: own.id }],
      });
    } catch {
      return null;
    }
    return {
      aligned,
      baseline,
      starts: [...aligned.byStart.keys()].sort((a, b) => a - b),
      mine: (id) => id === own.id || id === baseline,
      // false: tags of the file are found, none of them one of its outer tags (the file is not shown to render here)
      rooted: rootedState(aligned, [own.id, baseline]),
    };
  }

  /**
   * Lays literal markup of the changed files over the page by position. A line change is laid over where its
   * surrounding text is found (the patches); that fails for a change inside one long line with Liquid code elsewhere
   * in it, and where the portal serves another version than the baseline. Here the page, with the patches applied, is
   * aligned with the working copies: between two tags of a changed file found in the page, with no Liquid code in
   * between, the page must hold exactly what the file holds. Where it does not, the file's text goes there. A stretch
   * that holds Liquid code is left to the portal.
   */
  #layLiteral(out, scope, applied, notes, provenance) {
    const targets = new Map();
    for (const changed of this.changedMarkup) {
      if (!changed.overlay) continue;
      const own = this.#indexSource(scope.index, changed);
      if (own && typeof own.text === 'string') targets.set(own.id, { changed, own });
    }
    if (!targets.size) return out;
    const edits = this.#literalEdits(out, scope, targets);
    if (!edits.length) return out;
    edits.sort((a, b) => b.start - a.start || b.end - a.end);
    const { accepted, counts } = acceptLiteralEdits(edits, out.length, notes);
    let next = out;
    for (const change of accepted) next = next.slice(0, change.start) + change.text + next.slice(change.end);
    if (provenance)
      provenance.intervals = applyRenderEdits({ text: out, intervals: provenance.intervals }, accepted).intervals;
    notePatchedCounts(counts, applied);
    return next;
  }

  // The stretches of the page that differ from a changed file and that its text is laid over (empty: none).
  #literalEdits(out, scope, targets) {
    let aligned;
    try {
      aligned = alignDocument(out, scope.index, scope.route);
    } catch {
      return [];
    }
    const wanted = aligned.differences.filter((difference) => targets.has(difference.sourceRefId) && !difference.open);
    if (!wanted.length) return [];
    // A file whose outer markup is not on the page is not shown to be rendered here: lines of it that stand inside
    // other markup (the portal's own, or data another template prints) are not its place.
    const unrooted = new Set(aligned.coverage.filter((row) => row.rooted === false).map((row) => row.sourceRefId));
    // Only the user's own change is laid over. Where the page differs from the baseline as well, the portal has
    // another version of that place: neither the baseline's nor the working copy's text is the page's there.
    let against;
    try {
      against = this.#servedAlignment(out, scope).aligned.differences;
    } catch {
      return [];
    }
    const edits = [];
    for (const difference of wanted) {
      if (unrooted.has(difference.sourceRefId) || servedElsewhere(against, difference)) continue;
      const { own, changed } = targets.get(difference.sourceRefId);
      const text = own.text.slice(difference.region.start, difference.region.end);
      // Liquid code inside the stretch (a tag with an expression in it): only the portal can write what it prints.
      if (hasLiquid(text)) continue;
      edits.push(literalEdit(difference, own, changed, text));
    }
    return edits;
  }

  /** The source of the export's index that is this markup file (or this field of a record file); null unless one is. */
  #indexSource(index, src) {
    let byFile = this.#indexFiles.get(index);
    if (!byFile) {
      byFile = new Map();
      for (const source of index.sources.values()) {
        if (!source.file) continue;
        const key = source.file.toLowerCase();
        if (!byFile.has(key)) byFile.set(key, []);
        byFile.get(key).push(source);
      }
      this.#indexFiles.set(index, byFile);
    }
    const field =
      src.field?.replace(/^(?:adx|mspp)_/, '') ??
      { 'web-template': 'source', 'content-snippet': 'value', 'page-copy': 'copy', 'page-summary': 'summary' }[
        src.kind
      ];
    const own = (byFile.get(String(src.file ?? '').toLowerCase()) ?? []).filter(
      (source) => source.fieldPath?.at(-1) === field && (src.lcid === undefined || source.lcid === src.lcid),
    );
    return own.length === 1 ? own[0] : null;
  }

  #indexFiles = new WeakMap();

  /**
   * Aligns a response as the portal sent it with what the portal is taken to have: every unchanged file as it is, and
   * every changed file as the baseline has it, or as `instead` says (by index source id; null leaves the file out).
   */
  #servedAlignment(body, scope, instead = null) {
    const extra = [];
    const exclude = [];
    const stand = new Map();
    for (const changed of this.changedMarkup) {
      const own = this.#indexSource(scope.index, changed);
      if (!own || instead?.has(own.id)) continue;
      // The working copy of a changed file is not what the portal has: only its baseline may explain the response.
      exclude.push(own.id);
      if (typeof changed.baseText !== 'string') continue;
      const id = 'baseline:' + own.id;
      extra.push({ id, text: changed.baseText, like: own.id, name: own.name });
      stand.set(id, { own, text: changed.baseText });
    }
    for (const [id, other] of instead ?? []) {
      const own = scope.index.sources.get(id);
      if (!own) continue;
      exclude.push(id);
      if (typeof other !== 'string') continue;
      extra.push({ id: 'version:' + id, text: other, like: id, name: own.name });
      stand.set('version:' + id, { own, text: other });
    }
    return { aligned: alignDocument(body, scope.index, scope.route, { extra, exclude }), stand };
  }

  /**
   * Whether a response as the portal sent it is what the given version of one source renders: the response holds
   * tags of that version and differs from it nowhere. `text` null asks about the working copy.
   * @returns {{fits: boolean, matched: number, places: number}|null} null when the response cannot be compared
   */
  servedFits(body, urlPath, sourceIndex, sourceRefId, text = null) {
    const scope = { index: sourceIndex, route: pageKey(urlPath, this.model) };
    const source = sourceIndex.sources.get(sourceRefId);
    if (!source) return null;
    let aligned;
    try {
      ({ aligned } = this.#servedAlignment(body, scope, new Map([[sourceRefId, text ?? source.text]])));
    } catch {
      return null;
    }
    const id = 'version:' + sourceRefId;
    const places = aligned.differences.filter((difference) => difference.sourceRefId === id).length;
    const matched = aligned.coverage.find((row) => row.sourceRefId === id)?.matched ?? 0;
    return { fits: matched > 0 && places === 0, matched, places };
  }

  /** The text one version of a file gives the source `sourceRefId` names; `readRaw(file)` reads that version. */
  versionText(sourceIndex, sourceRefId, readRaw) {
    const source = sourceIndex.sources.get(sourceRefId);
    if (!source?.file) return null;
    const src = this.model.inlineSources.find(
      (candidate) =>
        candidate.mode !== 'block' &&
        candidate.file?.toLowerCase() === source.file.toLowerCase() &&
        this.#indexSource(sourceIndex, candidate)?.id === sourceRefId,
    );
    if (!src) return null;
    try {
      return createSourceReader(null, { readRaw })(src);
    } catch {
      return null;
    }
  }

  /**
   * The response as the portal sent it, against what the comparison baseline says the portal has: an unchanged file
   * as it is, a changed file as the baseline has it. Where the two disagree in markup a file spells out, the portal
   * rendered another version of that file than the baseline: the checkout is ahead of what is deployed, or behind it.
   * A changed file whose working copy is what the portal rendered is already deployed.
   * @returns {{markupBlocks: Set<number>|null, deployed: Set<string>, drift: {files: object[], places: object[],
   *   seen: string[], truncated: boolean}}} `markupBlocks`: script and style elements a markup source wrote.
   *   `deployed`: files (rel) whose working copy the portal already serves. `drift.places`: each place with its
   *   file, the line in the compared version of the file, and both texts cut short.
   */
  #servedState(body, scope) {
    const none = {
      markupBlocks: null,
      deployed: new Map(),
      drift: { files: [], places: [], seen: [], truncated: false },
    };
    let aligned;
    let stand;
    try {
      ({ aligned, stand } = this.#servedAlignment(body, scope));
    } catch {
      return none;
    }
    const markupBlocks = new Set();
    for (const binding of aligned.byStart.values())
      if (binding.mapping === 'aligned' && (binding.tag === 'script' || binding.tag === 'style'))
        markupBlocks.add(binding.start);
    // A changed file the baseline does not explain: is the working copy what the portal rendered?
    // By index source id: the places of the baseline's text (offsets) that the page shows as the working copy has
    // them. Only a change at such a place is known to be served already; a change the page does not show compared
    // (beyond the last tag found, behind Liquid code) is laid over as usual.
    const deployed = new Map();
    const settled = new Set();
    // A source whose outer markup is not on the page is not shown to be rendered here: no other version is claimed.
    const unrooted = new Set(aligned.coverage.filter((row) => row.rooted === false).map((row) => row.sourceRefId));
    for (const id of new Set(aligned.differences.map((difference) => difference.sourceRefId))) {
      const own = stand.get(id)?.own;
      if (!own || unrooted.has(id)) continue;
      const working = this.servedFits(body, scope.route, scope.index, own.id);
      if (!working?.fits) continue;
      deployed.set(
        own.id,
        aligned.differences
          .filter((difference) => difference.sourceRefId === id)
          .map((difference) => difference.region),
      );
      settled.add(id);
    }
    const { files, places, truncated } = collectDrift(body, scope, aligned, stand, { settled, unrooted });
    const seen = [];
    for (const row of aligned.coverage ?? []) {
      const source = stand.get(row.sourceRefId)?.own ?? scope.index.sources.get(row.sourceRefId);
      if (source && seen.length < DRIFT_SEEN) seen.push(driftRel(source));
    }
    return { markupBlocks, deployed, drift: { files: [...files.values()], places, seen, truncated } };
  }

  /**
   * Of several places where a changed line's text stands in the page, the ones this line wrote. A place that holds
   * tags is this line's when those tags are the baseline's tags of exactly these lines. A place of text only is this
   * line's when the tag before it is the last tag the baseline has before these lines.
   */
  #placedMatches(view, matches, hunk, original) {
    if (!view) return [];
    const { aligned, baseline, starts } = view;
    const ofBaseline = (start) => {
      const binding = aligned.byStart.get(start);
      // A tag the baseline holds in several identical places, shown fewer times than that, names no line.
      return binding.mapping === 'aligned' && binding.sourceRefId === baseline && !binding.oneOf ? binding : null;
    };
    let closest = -1;
    for (const start of starts) {
      const binding = ofBaseline(start);
      if (binding && binding.region.start < hunk.baseStart) closest = Math.max(closest, binding.region.start);
    }
    return matches.filter((match) => {
      const from = original(match.core);
      const to = original(match.after);
      const inside = starts.filter((start) => start >= from && start < to).map(ofBaseline);
      if (inside.length)
        return inside.every(
          (binding) => binding && binding.region.start >= hunk.baseStart && binding.region.start < hunk.baseEnd,
        );
      let before = null;
      for (const start of starts) {
        if (start >= from) break;
        before = aligned.byStart.get(start);
      }
      return (
        closest >= 0 &&
        before?.mapping === 'aligned' &&
        before.sourceRefId === baseline &&
        before.region.start === closest
      );
    });
  }

  #scopedEdits(view, patch, edits, scope, notes) {
    if (!view) return edits;
    const { aligned, starts, mine } = view;
    // Inner lines of the file inside markup that is not the file's (the portal's own, data another template prints):
    // the file is not what rendered them.
    if (view.rooted === false) return [];
    // A page that shows nothing of this file has no place for its change: the look-alike text of another source is
    // left alone without a word. A page that shows the file is told where a change was held back.
    const present = [...aligned.byStart.values()].some(
      (binding) => binding.mapping === 'aligned' && mine(binding.sourceRefId),
    );
    const kept = [];
    for (const edit of edits) {
      const foreign = editBindings(edit, starts, aligned).find(
        (binding) =>
          (binding.mapping === 'aligned' && !mine(binding.sourceRefId)) ||
          (binding.mapping === 'conflict' && binding.sourceRefIds.some(mine) && !binding.sourceRefIds.every(mine)),
      );
      if (!foreign) {
        kept.push(edit);
        continue;
      }
      if (!present) continue;
      const other = (foreign.sourceRefIds ?? [foreign.sourceRefId]).find((id) => !mine(id));
      const name = scope.index.sources.get(other)?.name;
      notes.push({
        rel: patch.rel,
        reason: `${edit.where}: this text is written here by ${name ? '"' + name + '"' : 'another source'}${foreign.mapping === 'conflict' ? ' as well' : ''}, change not applied`,
      });
    }
    return kept;
  }

  #applyPatch(out, patch, applied, notes, isHtml, urlPath, provenance, scope = null) {
    const sourceRef = this.#patchSourceReference(patch, provenance);
    if (!isHtml && patch.kind !== 'web-template') return out;
    if (patch.pageUrl && urlKey(patch.pageUrl) !== pageKey(urlPath, this.model)) return out;
    // each file is applied to the result of the previous one, so two files changing the same
    // spot (a template line and the snippet printed on it) both take effect
    const { text, original, crlf } = normalise(out);
    const eol = crlf ? '\r\n' : '\n';
    const edits = [];
    // The export's view of this document, worked out once and only when a hunk or the scoping needs it.
    let view;
    const viewOf = () => {
      if (view === undefined) view = scope && isHtml ? this.#patchView(out, patch, scope) : null;
      return view;
    };
    const locate = scope && isHtml ? (matches, hunk, at) => this.#placedMatches(viewOf(), matches, hunk, at) : null;
    for (const hunk of patch.hunks) {
      const hunkEdits = this.#patchHunkEdits(patch, hunk, text, original, eol, sourceRef, notes, locate);
      for (const edit of hunkEdits) edits.push(edit);
    }
    const scoped = scope && isHtml && edits.length ? this.#scopedEdits(viewOf(), patch, edits, scope, notes) : edits;
    return this.#applyPatchEdits(out, patch, scoped, applied, notes, provenance);
  }

  #applyPatches(body, applied, notes, isHtml, urlPath, provenance, scope = null, deployed = null) {
    let out = body;
    for (const patch of this.patches) {
      let current = patch;
      const places = deployed?.size && scope ? deployed.get(this.#indexSource(scope.index, patch)?.id) : null;
      if (places?.length && typeof patch.baseText === 'string') {
        // The portal rendered these places from the working copy: laying a change over one would make it twice.
        // The lines of each place, with the line break after them (where an added line would go).
        const lines = places.map((place) => {
          const from = patch.baseText.lastIndexOf('\n', Math.max(0, place.start - 1)) + 1;
          const end = patch.baseText.indexOf('\n', place.end);
          return [from, end < 0 ? patch.baseText.length : end + 1];
        });
        const served = (hunk) =>
          hunk.baseStart !== undefined && lines.some(([from, to]) => from <= hunk.baseEnd && hunk.baseStart <= to);
        const hunks = patch.hunks.filter((hunk) => !served(hunk));
        if (!hunks.length) continue;
        if (hunks.length !== patch.hunks.length) current = { ...patch, hunks };
      }
      out = this.#applyPatch(out, current, applied, notes, isHtml, urlPath, provenance, scope);
    }
    return out;
  }
}
