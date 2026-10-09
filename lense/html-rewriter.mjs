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
import { diffLines } from './line-diff.mjs';
import { urlKey, sourceText, isSourceFile } from './portal-model.mjs';

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
const sameStamp = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const LANG_PREFIX = /^\/[a-z]{2}(?:-[a-z]{2,4})?(?=\/|$)/i;
const MAX_CONTEXT = 8;
// the longest text a {{ value }} is expected to render to
const MAX_VALUE_LENGTH = 50_000;
// below this much literal text a pattern is only trusted where it stands on its own (>text<, "text")
const WEAK_ANCHOR_LENGTH = 12;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch {
    return null;
  }
}

/** URL path without the optional language segment (/en-US/...), as a lookup key. */
export function pageKey(urlPath) {
  const key = urlKey(urlPath);
  const stripped = key.replace(LANG_PREFIX, '');
  return stripped === '' ? '/' : stripped;
}

// ---------------------------------------------------------------------------------- block sources

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

const JS_TYPE_RE = /^(?:(?:text|application)\/(?:x-)?(?:java|ecma)script|text\/(?:javascript1\.[0-5]|jscript|livescript)|module)$/i;
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript', 'plaintext']);
const HTML_SPACE = /[\t\n\f\r ]/;

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
    if (state === '"' || state === "'") { if (char === state) state = 'before'; continue; }
    if (char === '>') return Object.assign([html.slice(start, at + 1), name, html.slice(attrsStart, at)], { index: start, end: at + 1 });
    if (state === 'value') {
      if (HTML_SPACE.test(char)) continue;
      state = char === '"' || char === "'" ? char : 'unquoted';
    } else if (state === 'unquoted') {
      if (HTML_SPACE.test(char)) state = 'before';
    } else if (state === 'name' || state === 'after') {
      if (char === '=') state = 'value';
      else if (char === '/') state = 'before';
      else if (HTML_SPACE.test(char)) state = 'after';
      else state = 'name';
    } else if (!HTML_SPACE.test(char) && char !== '/') state = 'name';
  }
  return null;
}

function nextTag(html, from) {
  for (let start = html.indexOf('<', from); start >= 0; start = html.indexOf('<', from)) {
    if (html.startsWith('<!--', start)) {
      let end;
      if (html.startsWith('>', start + 4)) end = start + 5;
      else if (html.startsWith('->', start + 4)) end = start + 6;
      else {
        const closing = /--!?>/g;
        closing.lastIndex = start + 4;
        end = closing.exec(html) ? closing.lastIndex : html.length;
      }
      from = end;
    } else if (html[start + 1] === '!' || html[start + 1] === '?') {
      const end = html.indexOf('>', start + 2);
      from = end < 0 ? html.length : end + 1;
    } else if (/[a-z]/i.test(html[start + (html[start + 1] === '/' ? 2 : 1)] ?? '')) {
      return readTag(html, start);
    } else from = start + 1;
  }
  return null;
}

function rawEnd(html, tag, from) {
  if (tag === 'script') {
    // Legacy HTML-comment escapes have a double-escaped state: a </script> after
    // <!--<script> is text until that state has ended, even inside a JavaScript string.
    const tokens = /<!--|-->|<\/?script(?=[\t\n\f\r />])/gi;
    tokens.lastIndex = from;
    let state = 'data';
    for (let token; (token = tokens.exec(html));) {
      const value = token[0].toLowerCase();
      if (value === '<!--' && state === 'data') state = 'escaped';
      else if (value === '-->') state = 'data';
      else if (value === '<script' && state === 'escaped') state = 'double';
      else if (value === '</script') {
        if (state === 'double') state = 'escaped';
        else return readTag(html, token.index);
      }
    }
    return null;
  }
  const closing = new RegExp(`</${tag}(?=[\\t\\n\\f\\r />])`, 'gi');
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
  for (let open; (open = nextTag(html, at));) {
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

function closingElementOffset(html, name) {
  let at = 0;
  let offset = -1;
  for (let m; (m = nextTag(html, at));) {
    at = m.end;
    if (!m[1]) continue;
    const tag = m[1].toLowerCase();
    if (m[0].startsWith('</')) {
      if (tag === name) offset = m.index;
    } else if (RAW_TEXT.has(tag)) {
      if (tag === 'plaintext') break;
      const end = rawEnd(html, tag, at);
      if (!end) break;
      at = end.end;
    }
  }
  return offset;
}

function attributes(attrs) {
  const out = new Map();
  const pattern = /([^\s=/'"<>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const m of attrs.matchAll(pattern)) {
    const name = m[1].toLowerCase();
    if (!out.has(name)) out.set(name, m[2] ?? m[3] ?? m[4] ?? '');
  }
  return out;
}

function scriptType(values, useLanguage = true) {
  // Character references in type values are decoded by the HTML parser. Only ASCII values
  // can name a supported MIME type; include the named references that can occur in one.
  const named = { Tab: '\t', NewLine: '\n', sol: '/', period: '.' };
  return (values.get('type') ?? (useLanguage && values.get('language') ? `text/${values.get('language')}` : ''))
    .replace(/&#(?:x([\da-f]+)|(\d+));?|&(Tab|NewLine|sol|period);/gi, (whole, hex, dec, name) => {
      if (name) return named[name] ?? whole;
      const code = Number.parseInt(hex ?? dec, hex ? 16 : 10);
      return code > 0 && code < 128 ? String.fromCharCode(code) : whole;
    }).trim().toLowerCase();
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
const sourceLocale = (src) => src.lcid ?? /\.([a-z]{2}(?:-[a-z]{2,4})?)\.(?:webpage|contentsnippet)\./i.exec(src.rel)?.[1]?.toLowerCase() ?? null;
function differentLocalizedVariants(a, b) {
  const aLocale = sourceLocale(a);
  const bLocale = sourceLocale(b);
  if (aLocale == null || bLocale == null || aLocale === bLocale || a.kind !== b.kind) return false;
  if (a.lcid != null || b.lcid != null) return a.file === b.file && a.field === b.field && JSON.stringify(a.fieldPath) === JSON.stringify(b.fieldPath);
  if (a.kind.startsWith('page-')) return a.pageUrl != null && b.pageUrl != null && pageKey(a.pageUrl) === pageKey(b.pageUrl);
  return a.kind === 'content-snippet' && a.snippetName && b.snippetName && a.snippetName.toLowerCase() === b.snippetName.toLowerCase();
}

// --------------------------------------------------------------------------------- markup sources

function normExpr(expr) {
  // Whitespace and apostrophes inside Liquid string literals are data. Canonicalise quote
  // delimiters only, so changing a filter argument never reuses a different rendered value.
  return expr.trim().replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\s+/g, (part) =>
    /^\s/.test(part) ? ' ' : JSON.stringify(part.slice(1, -1)),
  );
}

function toLines(text) {
  const normalized = normEol(text);
  const parts = normalized.split('\n');
  const starts = [];
  let offset = 0;
  const lines = parts.map((t, i) => {
    starts.push(offset);
    offset += t.length + 1;
    return { text: t, eol: i < parts.length - 1, logic: false, outputs: [] };
  });
  if (lines.length && !lines.at(-1).eol && lines.at(-1).text === '') lines.pop();
  const lineAt = (at) => {
    let lo = 0;
    let hi = lines.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const markLogic = (from, to) => {
    for (let i = lineAt(from); i <= lineAt(Math.max(from, to - 1)) && i < lines.length; i++) lines[i].logic = true;
  };
  // Only direct literal output is patchable. Comment bodies are never printed, capture bodies
  // may be transformed before being printed, and raw bodies print {{...}} as literal text.
  // Scan whole tokens so multiline tags/outputs cannot turn their middle lines into anchors.
  const tokens = /\{%|\{\{/g;
  let captureStart = null;
  let captureDepth = 0;
  for (let token; (token = tokens.exec(normalized));) {
    const start = token.index;
    const delimiter = token[0] === '{%' ? '%}' : '}}';
    let quote = null;
    let end = start + 2;
    for (; end < normalized.length; end++) {
      const c = normalized[end];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") quote = c;
      else if (normalized.startsWith(delimiter, end)) break;
    }
    if (end === normalized.length) { markLogic(start, end); break; }
    end += 2;
    tokens.lastIndex = end;
    if (delimiter === '%}') {
      markLogic(start, end);
      const tag = /^\s*-?\s*([a-z]+)/i.exec(normalized.slice(start + 2, end - 2))?.[1]?.toLowerCase();
      if (tag === 'raw' || tag === 'comment') {
        const closing = new RegExp(`\\{%-?\\s*end${tag}\\s*-?%\\}`, 'gi');
        closing.lastIndex = end;
        const close = closing.exec(normalized);
        if (!close) { markLogic(start, normalized.length); break; }
        if (tag === 'comment') markLogic(start, closing.lastIndex);
        else markLogic(close.index, closing.lastIndex);
        tokens.lastIndex = closing.lastIndex;
      } else if (tag === 'capture') {
        captureStart ??= start;
        captureDepth++;
      } else if (tag === 'endcapture' && captureDepth && --captureDepth === 0) {
        markLogic(captureStart, end);
        captureStart = null;
      }
    } else {
      const first = lineAt(start);
      if (first !== lineAt(end - 1) || normalized[start + 2] === '-' || normalized[end - 3] === '-') markLogic(start, end);
      else lines[first]?.outputs.push({ index: start - starts[first], text: normalized.slice(start, end), expr: normalized.slice(start + 2, end - 2) });
    }
  }
  if (captureStart != null) markLogic(captureStart, normalized.length);
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
    if (last && last.lit != null) last.lit += s;
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
function findMatches(pattern, text, max = Infinity) {
  const out = [];
  if (!pattern.anchored) return out;
  for (const piece of pattern.literal) if (!text.includes(piece)) return out;
  const { tokens } = pattern;
  const first = tokens.find((t) => t.lit != null).lit;
  // Next occurrence of a literal at or after `pos`. Remembering the last answer keeps the whole
  // search linear: thousands of candidate starts ask for the same literal from increasing positions.
  const memo = new Map();
  const next = (lit, pos) => {
    const m = memo.get(lit);
    if (m && m.from <= pos && (m.at < 0 || pos <= m.at)) return m.at;
    const at = text.indexOf(lit, pos);
    memo.set(lit, { from: pos, at });
    return at;
  };
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
    for (let later = next(first, start + 1); later >= 0 && later < match.end; later = next(first, later + 1)) {
      const tighter = matchAt(tokens, text, later, next);
      if (tighter && tighter.end <= match.end) {
        match = tighter;
        start = later;
      }
    }
    out.push(match);
    from = Math.max(match.end, start + 1);
  }
  return out;
}

function matchAt(tokens, text, start, next) {
  let pos = start;
  let pending = null; // a {{ value }} whose end is not known yet
  let waiting = []; // marks sitting directly after that value
  const marks = {};
  const values = new Map();
  for (const tok of tokens) {
    if (tok.mark) {
      if (pending != null) waiting.push(tok.mark);
      else marks[tok.mark] = pos;
    } else if (tok.expr != null) {
      pending = tok.expr;
    } else if (pending != null) {
      const found = next(tok.lit, pos);
      if (found < 0 || found - pos > MAX_VALUE_LENGTH) return null;
      const value = text.slice(pos, found);
      if (values.has(pending) && values.get(pending) !== value) return null;
      values.set(pending, value);
      pos = found;
      for (const mark of waiting) marks[mark] = pos;
      pending = null;
      waiting = [];
      pos += tok.lit.length;
    } else {
      if (!text.startsWith(tok.lit, pos)) return null;
      pos += tok.lit.length;
    }
  }
  return { start, end: pos, core: marks.core, after: marks.after, values };
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
function prepareHunk(baseLines, newLines, hunk, baseText, otherLanguages = []) {
  const oldCore = baseLines.slice(hunk.aStart, hunk.aEnd);
  const added = newLines.slice(hunk.bStart, hunk.bEnd);
  const where = `line ${hunk.bStart + 1}`;
  if (oldCore.some((l) => l.logic) || added.some((l) => l.logic)) {
    return { where, error: 'the change touches Liquid tags, a comment/capture body, or multiline/whitespace-controlled output; the portal has to render it' };
  }

  let before = 0;
  let after = 0;
  const canGrowBefore = () =>
    before < MAX_CONTEXT && hunk.aStart - before - 1 >= 0 && !baseLines[hunk.aStart - before - 1].logic;
  const canGrowAfter = () =>
    after < MAX_CONTEXT && hunk.aEnd + after < baseLines.length && !baseLines[hunk.aEnd + after].logic;

  let pattern = buildPattern(baseLines, hunk, before, after);
  const sharedLanguageAnchor = () => otherLanguages.some((text) => findMatches(pattern, text).some((match) => standsAlone(pattern, text, match)));
  const good = () => pattern.anchored && pattern.weight >= 3 && findMatches(pattern, baseText, 2).length === 1 && !sharedLanguageAnchor();
  let unique = good();
  let turn = 0;
  while (!unique && (canGrowBefore() || canGrowAfter())) {
    // alternate sides so the anchor stays close to the change
    if ((turn++ % 2 === 0 && canGrowBefore()) || !canGrowAfter()) before++;
    else after++;
    pattern = buildPattern(baseLines, hunk, before, after);
    unique = good();
  }
  if (!pattern.anchored || pattern.weight < 3) {
    return { where, error: 'no literal text next to the change to locate it in the page (it sits between Liquid tags)' };
  }
  if (sharedLanguageAnchor()) return { where, error: 'the literal anchor also occurs in another localized Value or language source; the portal language cannot be determined safely from this response' };
  return { where, pattern, added, unique };
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
  text = (text + html.slice(last)).replace(/\r/g, '\n');
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

// ------------------------------------------------------------------------------------- rewriter

export class HtmlRewriter {
  /** Warm cold source reads asynchronously with at most 16 files in flight. */
  static async create(options) {
    const { model, site, baseline } = options;
    const changed = options.changedFiles ?? baseline.changedFiles();
    const inline = new Set(site.inline?.enabled === false ? [] : site.inline?.kinds ?? []);
    const markup = new Set(site.markup?.enabled === false ? [] : site.markup?.kinds ?? []);
    const files = [...new Set(model.inlineSources.filter((src) =>
      !(src.kind.startsWith('page-') && src.pageUrl == null) &&
      (src.mode === 'block' ? inline.has(src.kind) : markup.has(src.kind) && changed.has(src.file)),
    ).map((src) => src.file))];
    const raw = new Map();
    const valid = new Map();
    const stamps = new Map();
    const root = model.sourceDir ? await fs.promises.realpath(model.sourceDir) : null;
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(16, files.length) }, async () => {
      for (let index; (index = next++) < files.length;) {
        const file = files[index];
        const key = sourceCacheKey(file);
        try {
          const real = await fs.promises.realpath(file);
          const relative = root ? path.relative(root, real) : null;
          if (root && (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))) throw new Error('outside source root');
          const before = await fs.promises.stat(file);
          if (!before.isFile()) throw new Error('not a regular source file');
          const text = await fs.promises.readFile(file, 'utf8');
          const after = await fs.promises.stat(file);
          if (!sameStamp(before, after) || await fs.promises.realpath(file) !== real) throw new Error('source changed during startup');
          raw.set(key, text.replace(/^﻿/, ''));
          valid.set(key, true);
          stamps.set(key, { file, real, info: after });
        } catch {
          // Retry only unstable/unreadable entries through the constructor's normal guarded
          // read. A save finishing during startup must not leave a permanently cached miss.
        }
      }
    }));
    // An early file can be saved while later files are still loading. Revalidate the entire
    // prefetched snapshot once all reads finish; the constructor retries only stale entries.
    next = 0;
    const entries = [...stamps];
    await Promise.all(Array.from({ length: Math.min(16, entries.length) }, async () => {
      for (let index; (index = next++) < entries.length;) {
        const [key, stamp] = entries[index];
        try {
          if (sameStamp(stamp.info, await fs.promises.stat(stamp.file)) && await fs.promises.realpath(stamp.file) === stamp.real) continue;
        } catch { /* removed or replaced source */ }
        raw.delete(key);
        valid.delete(key);
        stamps.delete(key);
      }
    }));
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
  refresh(files, { revalidate = false } = {}) {
    const invalidate = (key) => { this.sourceCache.delete(key); this.sourceStamps.delete(key); };
    if (files == null) { this.sourceCache.clear(); this.sourceStamps.clear(); }
    else for (const file of files) invalidate(sourceCacheKey(file));
    if (revalidate) for (const key of this.sourceCache.keys()) {
      const stamp = this.sourceStamps.get(key);
      try {
        if (stamp && sameStamp(stamp.info, fs.statSync(stamp.file)) && fs.realpathSync(stamp.file) === stamp.real) continue;
      } catch { /* removed or replaced source */ }
      invalidate(key);
    }
    const { site, model } = this;
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
    const inlineKinds = new Set(site.inline?.enabled === false ? [] : site.inline?.kinds ?? []);
    const markupKinds = new Set(site.markup?.enabled === false ? [] : site.markup?.kinds ?? []);

    /**
     * Every block source, used to recognise the online blocks. Only `active` ones replace anything:
     * with scope 'changed' an untouched script still has to be known, so that a block that is really
     * its online copy is not mistaken for the one being edited.
     */
    this.blocks = [];
    /** markup files with a prepared patch */
    this.patches = [];
    /** changes that cannot be previewed locally: [{rel, reason}] */
    this.unsupported = model.deploymentChanges?.(this.baseline, changed) ?? [];
    for (const source of model.inactiveSources ?? []) {
      if (changed.has(source.file)) this.unsupported.push({ rel: source.rel, reason: 'the record or its parent is inactive; activate and deploy it before this local change can be previewed' });
    }
    this.snippets = null;

    // in how many local scripts each line occurs: the more, the less it identifies one of them
    const frequency = new Map();
    const weights = new Map();
    this.lineWeight = (line) => {
      // Never retain arbitrary lines received from the portal across navigations.
      if (!frequency.has(line)) return TRIVIAL_LINE.test(line) ? 0 : 1;
      if (!weights.has(line)) weights.set(line, TRIVIAL_LINE.test(line) ? 0 : 1 / frequency.get(line));
      return weights.get(line);
    };

    // the deployed version of a source; several sources can live in one file (enhanced format)
    const baseOf = (src) => {
      const raw = this.baseline.show(src.file);
      return raw == null ? null : sourceText(src, raw);
    };
    const unreadable = new Set();
    const read = (src) => {
      const text = this.#readSource(src);
      if (text == null && src.extract && !unreadable.has(src.file)) {
        unreadable.add(src.file);
        this.unsupported.push({ rel: src.rel, reason: 'the source field cannot be read from its metadata; the record, field or localized identity is missing or invalid' });
      }
      return text;
    };

    for (const src of model.inlineSources) {
      if (src.kind.startsWith('page-') && src.pageUrl == null) {
        // Only a local edit of such a source is a limitation worth reporting; an untouched one is
        // what the portal already serves. The model warns about the broken page hierarchy itself.
        if (changed.has(src.file) && (inlineKinds.has(src.kind) || markupKinds.has(src.kind))) {
          this.unsupported.push({ rel: src.rel, reason: 'the page URL cannot be resolved from local metadata, so this local change cannot be previewed' });
        }
        continue;
      }
      const isChanged = changed.has(src.file);
      if (src.mode === 'block') {
        if (!inlineKinds.has(src.kind)) continue;
        const text = read(src);
        if (text == null) continue;
        const base = isChanged ? baseOf(src) : null;
        if (!text.trim() && !(base && base.trim())) continue; // empty here and in the baseline
        if (/\{%|\{\{/.test(text) || (base && /\{%|\{\{/.test(base))) {
          // Liquid inside a custom JS/CSS field: the portal renders it, so patch instead of replace
          if (isChanged && !this.disabled.has(src.rel)) this.#preparePatch(src, text, base);
          continue;
        }
        const previous = previousBlocks.get(src.rel);
        const norm = previous?.text === text ? previous.norm : normEol(text);
        const lines = previous?.text === text ? previous.lines : lineSet(norm);
        const baseNorm = base == null ? null : normEol(base);
        const baseLines = baseNorm != null && baseNorm !== norm ? previous?.base === base && previous.baseLines ? previous.baseLines : lineSet(baseNorm) : null;
        this.blockCache.set(src.rel, { text, norm, lines, base, baseLines });
        if (partial?.has(sourceCacheKey(src.file)) && previous?.text !== text) {
          this.blockChanges.set(src.rel, { kind: src.kind, tag: src.tag, pageKey: src.pageUrl ? pageKey(src.pageUrl) : null, before: previous?.text ?? null, after: text });
        }
        for (const line of lines) frequency.set(line, (frequency.get(line) ?? 0) + 1);
        this.blocks.push({
          ...src,
          text,
          norm,
          lines,
          baseLines,
          active: (!restrict || isChanged) && !this.disabled.has(src.rel),
          isNew: isChanged && !(base && base.trim()),
          pageKey: src.pageUrl ? pageKey(src.pageUrl) : null,
          usedKeys: new Set((src.usedOn ?? []).map(pageKey)),
        });
      } else if (markupKinds.has(src.kind) && isChanged && !this.disabled.has(src.rel)) {
        const text = read(src);
        if (text != null) this.#preparePatch(src, text, baseOf(src));
      }
    }
    const totalWeight = (lines) => {
      let total = 0;
      if (lines) for (const line of lines) total += this.lineWeight(line);
      return total;
    };
    for (const block of this.blocks) {
      block.weight = totalWeight(block.lines);
      block.baseWeight = totalWeight(block.baseLines);
    }
    this.activeBlocks = this.blocks.filter((b) => b.active).length;
    this.readValidity = null;
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
    if (!this.sourceCache.has(key)) {
      let text = null;
      // A concurrent atomic save may replace the file between its read and stat. Retry once;
      // never label old bytes with the new file's stamp and then retain them indefinitely.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const real = fs.realpathSync(src.file);
          const before = fs.statSync(src.file);
          text = readText(src.file);
          const after = fs.statSync(src.file);
          if (text != null && sameStamp(before, after) && fs.realpathSync(src.file) === real) {
            this.sourceStamps.set(key, { file: src.file, real, info: after });
            break;
          }
        } catch { /* unreadable source */ }
        text = null;
      }
      this.sourceCache.set(key, text);
    }
    return sourceText(src, this.sourceCache.get(key));
  }

  #preparePatch(src, text, base) {
    if (base == null) {
      if (text.trim()) {
        this.unsupported.push({ rel: src.rel, reason: `new ${src.kind}: it does not exist online yet, the portal has to render it` });
      }
      return;
    }
    const baseLines = toLines(base);
    const newLines = toLines(text);
    const hunks = diffLines(baseLines.map(lineKey), newLines.map(lineKey));
    if (!hunks.length) return;
    const baseText = normEol(base);
    const otherLanguages = sourceLocale(src) == null ? [] : this.model.inlineSources
      .filter((other) => other !== src && differentLocalizedVariants(src, other))
      .map((other) => sourceText(other, this.baseline.show(other.file) ?? null))
      .filter((value) => value != null).map(normEol);
    const prepared = [];
    for (const hunk of hunks) {
      const p = prepareHunk(baseLines, newLines, hunk, baseText, otherLanguages);
      if (p.error) this.unsupported.push({ rel: src.rel, reason: `${p.where}: ${p.error}` });
      else prepared.push(p);
    }
    if (prepared.length) this.patches.push({ ...src, hunks: prepared });
  }

  /** Local snippet value plus whether choosing a value would guess its language. */
  #snippetValue(name) {
    if (!this.snippets) {
      this.snippets = new Map();
      for (const src of this.model.inlineSources) {
        if (src.kind !== 'content-snippet') continue;
        let snippetName = src.snippetName;
        if (snippetName === undefined) {
          const yml = readText(src.file.replace(/\.value\.html$/, '.yml'));
          snippetName = (yml && /^adx_name:\s*(.+)$/m.exec(yml)?.[1].trim().replace(/^["']|["']$/g, '')) || null;
        }
        if (snippetName) {
          const key = snippetName.toLowerCase();
          if (!this.snippets.has(key)) this.snippets.set(key, []);
          this.snippets.get(key).push(src);
        }
      }
    }
    const variants = this.snippets.get(name.toLowerCase());
    if (!variants?.length) return { value: null, ambiguous: false };
    const values = variants.map((src) => this.#readSource(src));
    // A new expression has no rendered baseline value identifying its language. Only an
    // identical value across variants can be inserted without guessing that language.
    const ambiguous = !values.every((value) => value === values[0]);
    return { value: ambiguous ? null : values[0], ambiguous };
  }

  /**
   * @param {string} body the online response body
   * @param {string} urlPath pathname of the request
   * @param {{html?: boolean}} [opts] `html: false` for data responses (JSON, text) produced by a
   *   web template: only template changes are applied to those
   * @returns {{html: string, applied: Array<{kind:string, rel:string, action:string}>, notes: Array<{rel:string, reason:string}>, matched: Array<object>}}
   */
  rewrite(body, urlPath, { html = true } = {}) {
    const applied = [];
    const notes = [];
    /** every local block source recognised in the page, changed or not: [{kind, rel, score, identical, online}] */
    const matched = [];
    let out = html ? this.#rewriteBlocks(body, urlPath, applied, matched, notes) : body;
    out = this.#applyPatches(out, applied, notes, html, urlPath);
    return { html: out, applied, notes, matched };
  }

  #rewriteBlocks(html, urlPath, applied, matched, notes) {
    if (!this.blocks.length) return html;
    const docKey = pageKey(urlPath);
    const minSim = this.site.inline?.minSimilarity ?? 0.5;
    const candidates = this.blocks.filter((b) => !b.pageKey || b.pageKey === docKey);
    if (!candidates.length) return html;

    // 1. every (online block, local source) pair that is alike enough
    const found = [];
    const pairs = [];
    for (const m of codeBlocks(html)) {
      const tag = m[1].toLowerCase();
      if (!isInlineCodeBlock(tag, m[2])) continue;
      const lines = lineSet(m[3]);
      if (!lines.size) continue;
      let weight = 0;
      for (const line of lines) weight += this.lineWeight(line);
      const block = { m, tag, lines, norm: normEol(m[3]).trim(), src: null, score: 0 };
      found.push(block);
      for (const src of candidates) {
        if (src.tag !== tag) continue;
        let score = similarity(lines, src.lines, this.lineWeight, weight, src.weight, minSim);
        if (src.baseLines) score = Math.max(score, similarity(lines, src.baseLines, this.lineWeight, weight, src.baseWeight, minSim));
        if (score + 1e-12 < minSim) continue;
        // a couple of lines is too little to tell blocks apart, unless the source belongs to this page
        const tiny = Math.min(lines.size, Math.max(src.lines.size, src.baseLines?.size ?? 0)) < 3;
        if (tiny && !src.pageKey && score < 1) continue;
        // forms are often clones of each other: among near-equal candidates prefer the form this
        // page is configured to show
        pairs.push({ block, src, score, rank: score + (src.usedKeys.has(docKey) ? 0.1 : 0) });
      }
    }

    // 2. best pairs first; a source stands for one online script, so it cannot also claim a
    //    different one (the same script printed twice is fine)
    pairs.sort((a, b) => b.rank - a.rank || Number(isLanguageCopy(b.src)) - Number(isLanguageCopy(a.src)));
    // the language copy and the root copy of a page are the same block online
    const identity = (src) => (src.pageKey ? `${src.kind}|${src.pageKey}` : src.file);
    const ambiguous = new Set();
    const best = new Map();
    for (const pair of pairs) {
      const first = best.get(pair.block);
      if (!first) best.set(pair.block, pair);
      else if (Math.abs(pair.rank - first.rank) < 1e-12 && (identity(pair.src) !== identity(first.src) || differentLocalizedVariants(pair.src, first.src)) && pair.src.norm !== first.src.norm) {
        ambiguous.add(pair.block);
      }
    }
    for (const block of ambiguous) {
      const { src } = best.get(block);
      notes.push({ rel: src.rel, reason: 'multiple local sources or language variants match this inline block equally; no source was substituted because its identity cannot be determined safely' });
    }
    const claimed = new Map();
    for (const { block, src, score } of pairs) {
      if (block.src || ambiguous.has(block)) continue;
      const id = identity(src);
      if (claimed.has(id) && claimed.get(id) !== block.norm) continue;
      claimed.set(id, block.norm);
      block.src = src;
      block.score = score;
    }

    // 3. swap the content of the blocks whose source is in scope
    let out = '';
    let at = 0;
    for (const block of found) {
      const { m, src } = block;
      if (!src) continue;
      const identical = block.norm === src.norm.trim();
      // `online`: what the portal printed, kept for the ones that differ so the two can be compared
      matched.push({ kind: src.kind, rel: src.rel, file: src.file, score: block.score, identical, active: src.active, online: identical ? undefined : block.norm });
      const replace = !identical && src.active;
      // A script that is (now) the local file can be debugged in that file, but debuggers do not
      // follow source maps of inline scripts. So it is loaded from the overlay as a file instead;
      // a plain <script src> runs at the same point of the page as the inline block did.
      // (not for text that lives inside another file: there is no script file to load)
      // A module resolves relative imports against its own URL. Moving an inline module to the
      // overlay URL would silently change those imports, so keep modules inline.
      const external = this.sourceMaps && !src.extract && block.tag === 'script' && canExternalize(src, scriptType(attributes(m[2]))) && (identical || src.active) && src.text.trim() !== '';
      if (!replace && !external) continue;
      let replacement;
      if (external) {
        // async/defer and integrity do not act on inline classic scripts, but become active
        // after adding src. Retaining a stale integrity hash would block the local script.
        const attrs = m[2].replace(/\s+([^\s=/'"<>]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g, (whole, name) => /^(?:async|defer|integrity)$/i.test(name) ? '' : whole);
        replacement = `<${m[1]}${attrs} src="${inlineScriptUrl(src.rel)}"></${m[1]}>`;
      } else {
        const content = m[3];
        const lead = /^\s*/.exec(content)[0];
        const trail = /\s*$/.exec(content)[0];
        const eol = content.includes('\r\n') || !content.includes('\n') ? '\r\n' : '\n';
        const newContent = `${lead}${src.norm.trim().replace(/\n/g, eol)}${trail}`;
        if (!preservesInlineBoundary(block.tag, newContent, m.closing)) {
          notes.push({ rel: src.rel, reason: `the local ${block.tag} content changes its HTML closing boundary; escape the closing-tag text in the source before previewing it inline` });
          continue;
        }
        replacement = `${m.opening}${newContent}${m.closing}`;
      }
      if (replace) applied.push({ kind: src.kind, rel: src.rel, action: 'replaced inline block' });
      out += html.slice(at, m.index) + replacement;
      at = m.index + m[0].length;
    }
    out += html.slice(at);

    if (this.site.inline?.injectMissingPageBlocks !== false) {
      // custom JS/CSS added to a page that has none online yet
      const pending = candidates
        .filter((b) => b.active && b.pageKey === docKey && b.isNew && b.text.trim() && !claimed.has(identity(b)))
        .sort((a, b) => Number(isLanguageCopy(b)) - Number(isLanguageCopy(a)));
      const done = new Set();
      for (const src of pending) {
        if (done.has(src.kind)) continue;
        done.add(src.kind);
        if (pending.some((other) => differentLocalizedVariants(src, other) && other.norm !== src.norm)) {
          notes.push({ rel: src.rel, reason: 'new page blocks differ between language variants; no rendered baseline identifies which language to inject' });
          continue;
        }
        const external = src.tag === 'script' && this.sourceMaps && !src.extract && canExternalize(src);
        const content = src.tag === 'style' ? src.text : `\n${src.text}\n`;
        if (!external && !preservesInlineBoundary(src.tag, content)) {
          notes.push({ rel: src.rel, reason: `the local ${src.tag} content changes its HTML closing boundary; escape the closing-tag text in the source before previewing it inline` });
          continue;
        }
        const element =
          src.tag === 'style'
            ? `<style type="text/css">${src.text}</style>\n`
            : external
              ? `<script type="text/javascript" src="${inlineScriptUrl(src.rel)}"></script>\n`
              : `<script type="text/javascript">\n${src.text}\n</script>\n`;
        const anchor = closingElementOffset(out, src.tag === 'style' ? 'head' : 'body');
        if (anchor < 0) continue;
        out = out.slice(0, anchor) + element + out.slice(anchor);
        applied.push({ kind: src.kind, rel: src.rel, action: 'injected (not online yet)' });
      }
    }
    return out;
  }

  #applyPatches(body, applied, notes, isHtml, urlPath) {
    let out = body;
    for (const patch of this.patches) {
      if (!isHtml && patch.kind !== 'web-template') continue;
      if (patch.pageUrl && pageKey(patch.pageUrl) !== pageKey(urlPath)) continue;
      // each file is applied to the result of the previous one, so two files changing the same
      // spot (a template line and the snippet printed on it) both take effect
      const { text, original, crlf } = normalise(out);
      const eol = crlf ? '\r\n' : '\n';
      const edits = [];
      for (const hunk of patch.hunks) {
        const all = findMatches(hunk.pattern, text);
        if (!all.length) continue; // this template/snippet is simply not part of this page
        const found = all.filter((match) => standsAlone(hunk.pattern, text, match));
        if (!found.length) continue;
        if (!hunk.unique && found.length > 1) {
          notes.push({ rel: patch.rel, reason: `${hunk.where}: the surrounding text occurs ${found.length} times in the page, change not applied` });
          continue;
        }
        for (const match of found) {
          let unresolved = null;
          let unresolvedLanguage = false;
          const replacement = hunk.added
            .map((line) => {
              let at = 0;
              let rendered = '';
              for (const output of line.outputs) {
                rendered += line.text.slice(at, output.index);
                at = output.index + output.text.length;
                const valueOf = (whole, expr) => {
                  const key = normExpr(expr);
                  if (match.values.has(key)) return match.values.get(key);
                  const snippet = /^snippets?\s*\[\s*"([^"]+)"\s*\]$/.exec(key);
                  const snippetValue = snippet ? this.#snippetValue(snippet[1]) : null;
                  const value = snippetValue?.value;
                  if (value != null && !/\{%|\{\{/.test(value)) return value;
                  unresolved ??= whole;
                  unresolvedLanguage ||= Boolean(snippetValue?.ambiguous);
                  return whole;
                };
                rendered += valueOf(output.text, output.expr);
              }
              rendered += line.text.slice(at);
              return rendered + (line.eol ? eol : '');
            })
            .join('');
          if (unresolved) {
            notes.push({ rel: patch.rel, reason: unresolvedLanguage
              ? `${hunk.where}: ${unresolved} has differing local language variants; the portal language cannot be determined safely for this new expression`
              : `${hunk.where}: ${unresolved} is new and only the portal can evaluate it` });
            continue;
          }
          edits.push({ start: original(match.core), end: original(match.after), text: replacement, where: hunk.where });
        }
      }
      if (!edits.length) continue;
      // apply from the end so earlier offsets stay valid
      edits.sort((a, b) => b.start - a.start || b.end - a.end);
      let limit = out.length;
      let hits = 0;
      const pieces = [];
      for (const e of edits) {
        if (e.end > limit) {
          notes.push({ rel: patch.rel, reason: `${e.where}: overlaps another change of this file in the page, not applied` });
          continue;
        }
        pieces.push(out.slice(e.end, limit), e.text);
        limit = e.start;
        hits++;
      }
      pieces.push(out.slice(0, limit));
      out = pieces.reverse().join('');
      if (hits) applied.push({ kind: patch.kind, rel: patch.rel, action: `patched ${hits} change${hits > 1 ? 's' : ''}` });
    }
    return out;
  }
}
