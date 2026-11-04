import { Parser, defaultTreeAdapter } from 'parse5';
import { replaceDelimitedAlternatives } from '../mirage/lib/text-scanning.mjs';

// parse5's parseFragment moves each top-level node with detachNode(firstChild), which is quadratic in the number of
// top-level nodes (80 000 take seconds). The fragment is taken from the parser's root in one step instead.
// ponytail: Parser is exported as internal; recheck on a parse5 major upgrade.
function parseFlatFragment(text) {
  const parser = Parser.getFragmentParser(null, { sourceCodeLocationInfo: true });
  parser.tokenizer.write(text, true);
  const root = defaultTreeAdapter.getFirstChild(parser.document),
    fragment = defaultTreeAdapter.createDocumentFragment();
  fragment.childNodes = root.childNodes;
  root.childNodes = [];
  for (const child of fragment.childNodes) child.parentNode = fragment;
  return fragment;
}

const markupCache = new Map();
let markupBytes = 0,
  markupParses = 0,
  markupHits = 0;
const scriptCache = new Map();
let scriptBytes = 0;
export const elementSourceHintCacheStats = () => ({
  entries: markupCache.size,
  bytes: markupBytes,
  parses: markupParses,
  hits: markupHits,
});
const copyHint = (hint, source) => ({
  ...source,
  ...hint,
  classes: [...(hint.classes ?? [])],
  attributes: { ...hint.attributes },
  locations: (hint.locations ?? []).map((location) => ({
    ...location,
    classes: [...(location.classes ?? [])],
    attributes: { ...location.attributes },
    contexts: [...location.contexts],
    ancestors: (location.ancestors ?? []).map((item) => ({ ...item, classes: [...item.classes] })),
  })),
  lines: [...(hint.lines ?? [])],
});

const cssId = (value) =>
  '#' +
  [...value]
    .map((char, index) =>
      /[a-zA-Z_]/.test(char) ||
      (char === '-' && (index > 0 || value.length > 1)) ||
      (/\d/.test(char) && index > 0 && !(index === 1 && value[0] === '-'))
        ? char
        : `\\${char.codePointAt(0).toString(16)} `,
    )
    .join('');

// Preserve original offsets/lines. Raw emits its body, while comments/manifests do not.
// An attribute intersecting any Liquid range is rejected below, rather than joining tokens.
function processLiquidTag(match, text, ranges, state) {
  const tag = match[1].toLowerCase(),
    end = match.index + match[0].length;
  if (state.kind === 'raw') {
    if (tag === 'endraw') {
      ranges.push([match.index, end]);
      state.kind = null;
    }
    return;
  }
  if (state.kind) {
    if (tag === state.kind && state.kind === 'comment') state.depth++;
    else if (tag === 'end' + state.kind && !--state.depth) {
      ranges.push([state.start, end]);
      state.kind = null;
    }
    return;
  }
  if (tag === 'raw') {
    ranges.push([match.index, end]);
    state.kind = 'raw';
  } else if (tag === 'comment' || tag === 'manifest') {
    state.kind = tag;
    state.start = match.index;
    state.depth = 1;
  }
}

function liquidRanges(text) {
  const tags = /{%-?\s*(raw|endraw|comment|endcomment|manifest|endmanifest)\b[^%]*%-?}/gi;
  const ranges = [];
  const state = { kind: null, start: 0, depth: 0 };
  for (const match of text.matchAll(tags)) processLiquidTag(match, text, ranges, state);
  if (state.kind && state.kind !== 'raw') ranges.push([state.start, text.length]);
  return ranges;
}

function markupForInspection(text) {
  const ranges = liquidRanges(text);
  let from = 0,
    masked = '';
  for (const [begin, end] of ranges) {
    masked += text.slice(from, begin) + text.slice(begin, end).replace(/[^\r\n]/g, ' ');
    from = end;
  }
  return { text: masked + text.slice(from), ranges };
}

/** Static selectors provide candidates, never proof of which Liquid branch rendered a node. */
const staticMarkupValue = (value) => value && value.length <= 160 && !/[{}%]/.test(value);
const MARKUP_ATTRIBUTES = [
  'for',
  'data-entityname',
  'data-formid',
  'data-viewid',
  'data-listid',
  'data-fieldname',
  'data-field',
  'data-attribute',
];

function collectMarkupNodes(tree, prepared) {
  const nodes = [],
    ids = new Map(),
    pending = [tree];
  while (pending.length) {
    const node = pending.pop();
    if (['script', 'style', 'template'].includes(node.tagName)) continue;
    const attrs = Object.fromEntries(
      (node.attrs ?? [])
        .filter((attr) => {
          const location = node.sourceCodeLocation?.attrs?.[attr.name];
          return (
            !location ||
            !prepared.ranges.some(([start, end]) => start < location.endOffset && end > location.startOffset)
          );
        })
        .map((attr) => [attr.name, attr.value]),
    );
    const id = attrs.id;
    if (staticMarkupValue(id) && !/\s/.test(id)) ids.set(id, (ids.get(id) ?? 0) + 1);
    nodes.push({ node, attrs, id });
    const children = node.childNodes ?? [];
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  return { nodes, ids };
}

function selectorForMarkupNode(node, attrs, id, staticClasses) {
  if (staticMarkupValue(id) && !/\s/.test(id)) return { selector: cssId(id), matchKind: 'id' };
  // Intrinsic class/metadata selectors survive moved nodes. Positional/nth-child paths
  // would wrongly identify neighbours after scripts restructure a page.
  const classes = staticClasses.slice(0, 4);
  const explicit = MARKUP_ATTRIBUTES.find((name) => staticMarkupValue(attrs[name]));
  if (explicit && /^[a-zA-Z0-9_{}-]+$/.test(attrs[explicit]))
    return { selector: `${node.tagName}[${explicit}="${attrs[explicit]}"]`, matchKind: 'attribute' };
  if (classes.length)
    return {
      selector: node.tagName + classes.map((value) => '.' + cssId(value).slice(1)).join(''),
      matchKind: 'class',
    };
  return null;
}

function markupAncestors(node, ids) {
  const contexts = [];
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
    const aid = ancestor.attrs?.find((attr) => attr.name === 'id')?.value;
    if (staticMarkupValue(aid) && ids.get(aid) === 1) contexts.push(cssId(aid));
  }
  const ancestors = [];
  for (let ancestor = node.parentNode; ancestor && ancestors.length < 6; ancestor = ancestor.parentNode) {
    const classes = replaceDelimitedAlternatives(
      ancestor.attrs?.find((attr) => attr.name === 'class')?.value ?? '',
      [
        ['{{', '}}'],
        ['{%', '%}'],
      ],
      '{dynamic}',
    )
      .split(/\s+/)
      .filter(staticMarkupValue);
    if (classes.length) ancestors.push({ tag: ancestor.tagName, classes });
  }
  return { contexts, ancestors };
}

function sourceLine(source, node) {
  return /\.html?$/i.test(source.sourceFile ?? '') ? node.sourceCodeLocation?.startLine : undefined;
}

function markupLocation(source, node, attrs, ids, staticClasses) {
  const { contexts, ancestors } = markupAncestors(node, ids);
  const attributes = Object.fromEntries(
    MARKUP_ATTRIBUTES.filter((name) => staticMarkupValue(attrs[name])).map((name) => [name, attrs[name]]),
  );
  const line = sourceLine(source, node);
  return { line, contexts, ancestors, tag: node.tagName, classes: staticClasses, attributes };
}

function markupHint(source, node, attrs, id, ids, prepared) {
  if (!node.tagName || !/^[a-z][a-z0-9:_-]*$/.test(node.tagName)) return null;
  const opening = node.sourceCodeLocation?.startTag;
  if (opening && prepared.ranges.some(([start, end]) => start < opening.endOffset && end > opening.startOffset))
    return null;
  const staticClasses = replaceDelimitedAlternatives(
    attrs.class ?? '',
    [
      ['{{', '}}'],
      ['{%', '%}'],
    ],
    '{dynamic}',
  )
    .split(/\s+/)
    .filter(staticMarkupValue);
  const matched = selectorForMarkupNode(node, attrs, id, staticClasses);
  if (!matched) return null;
  const location = markupLocation(source, node, attrs, ids, staticClasses);
  return {
    selector: matched.selector,
    hint: {
      selector: matched.selector,
      matchKind: matched.matchKind,
      domId: matched.matchKind === 'id' ? id : undefined,
      tag: node.tagName,
      attributes: Object.fromEntries(
        MARKUP_ATTRIBUTES.filter((name) => staticMarkupValue(attrs[name])).map((name) => [name, attrs[name]]),
      ),
      classes: staticClasses,
      occurrences: 1,
      locations: [location],
      lines: location.line ? [location.line] : [],
      // Enhanced-model HTML is nested in XML/JSON; its line is not a file line.
      line: sourceLine(source, node),
      evidence: 'source-selector',
      certainty: 'candidate',
    },
    location,
  };
}

function addMarkupHints(nodes, ids, source, prepared) {
  const selectors = new Map();
  for (const { node, attrs, id } of nodes) {
    const candidate = markupHint(source, node, attrs, id, ids, prepared);
    if (!candidate) continue;
    const existing = selectors.get(candidate.selector);
    if (existing) {
      existing.occurrences++;
      existing.locations.push(candidate.location);
      if (candidate.location.line) existing.lines.push(candidate.location.line);
      continue;
    }
    selectors.set(candidate.selector, candidate.hint);
  }
  return selectors;
}

export function elementSourceHints(body, source, { limit = Infinity } = {}) {
  if (!body || String(body).length > 1024 * 1024) return [];
  const text = String(body),
    cacheKey = source.sourceFile ? source.sourceFile + '\u0000' + (source.recordId ?? source.id ?? '') : null,
    cached = cacheKey && markupCache.get(cacheKey);
  if (cached?.body === text) {
    markupHits++;
    markupCache.delete(cacheKey);
    markupCache.set(cacheKey, cached);
    return cached.hints.slice(0, limit).map((hint) => copyHint(hint, source));
  }
  const original = String(body),
    prepared = markupForInspection(original);
  markupParses++;
  const tree = parseFlatFragment(prepared.text);
  const { nodes, ids } = collectMarkupNodes(tree, prepared);
  const selectors = addMarkupHints(nodes, ids, source, prepared);
  const hints = [...selectors.values()].sort((a, b) => (a.matchKind === 'id' ? 0 : 1) - (b.matchKind === 'id' ? 0 : 1));
  if (cacheKey) {
    if (cached) markupBytes -= cached.body.length * 2;
    markupCache.delete(cacheKey);
    markupCache.set(cacheKey, { body: text, hints });
    markupBytes += text.length * 2;
    while (markupCache.size > 4096 || markupBytes > 32 * 1024 * 1024) {
      const key = markupCache.keys().next().value;
      markupBytes -= markupCache.get(key).body.length * 2;
      markupCache.delete(key);
    }
  }
  return hints.slice(0, limit).map((hint) => copyHint(hint, source));
}

/** Literal selector references identify script candidates, never event-handler ownership. */
export function scriptSourceHints(body, source, { limit = 120, ids = [] } = {}) {
  if (typeof body !== 'string' || !body || body.length > 1024 * 1024) return [];
  const cap = Math.max(0, Math.min(1000, limit)),
    key = source.sourceFile ?? null,
    cached = key && scriptCache.get(key);
  const answer = (hints) => {
    const present = new Set(ids.map(cssId)),
      rank = (hint) => {
        if (present.has(hint.selector)) return 0;
        if (hint.selector.startsWith('#')) return 1;
        return 2;
      };
    const result = [...hints]
      .sort((a, b) => rank(a) - rank(b))
      .slice(0, cap)
      .map((hint) => ({ ...source, ...hint }));
    Object.defineProperty(result, 'truncated', { value: hints.length > cap });
    return result;
  };
  if (cached?.body === body) return answer(cached.hints);
  const hints = scanScriptSourceHints(body, { sourceFile: source.sourceFile }, 10000).map(
    ({ sourceFile, ...hint }) => hint,
  );
  if (key) {
    if (cached) scriptBytes -= cached.body.length * 2;
    scriptCache.delete(key);
    scriptCache.set(key, { body, hints });
    scriptBytes += body.length * 2;
    while (scriptCache.size > 128 || scriptBytes > 4 * 1024 * 1024) {
      const old = scriptCache.keys().next().value;
      scriptBytes -= scriptCache.get(old).body.length * 2;
      scriptCache.delete(old);
    }
  }
  return answer(hints);
}
function scanScriptSourceHints(body, source, limit) {
  const state = { rows: [], seen: new Set(), index: 0, previous: '' };
  while (state.index < body.length && state.rows.length < limit) {
    state.index = skipScriptTrivia(body, state.index);
    const char = body[state.index];
    if (!char) break;
    if (char === '`') {
      state.index = skipTemplate(body, state.index);
      state.previous = 'string';
      continue;
    }
    if (char === '"' || char === "'") {
      state.index = skipQuoted(body, state.index);
      state.previous = 'string';
      continue;
    }
    if (char === '/') {
      if (!scanScriptSlash(body, state)) break;
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      scanScriptIdentifier(body, source, state);
      continue;
    }
    state.previous = char;
    state.index++;
  }
  return state.rows;
}

function skipQuoted(text, start) {
  const quote = text[start];
  for (let at = start + 1; at < text.length; at++) {
    if (text[at] === '\\') {
      at++;
      continue;
    }
    if (text[at] === quote) return at + 1;
    if (/[\r\n]/.test(text[at])) return at;
  }
  return text.length;
}
function skipRegex(text, start) {
  let inClass = false;
  for (let at = start + 1; at < text.length; at++) {
    const char = text[at];
    if (char === '\\') {
      at++;
      continue;
    }
    if (/[\r\n]/.test(char)) return null;
    if (char === '[') inClass = true;
    if (char === ']') inClass = false;
    if (char !== '/' || inClass) continue;
    at++;
    while (at < text.length && /[a-z]/i.test(text[at])) at++;
    return at;
  }
  return null;
}
function advanceTemplateText(text, stack, at) {
  const char = text[at];
  if (char === '\\') return at + 2;
  if (char === '`') {
    stack.pop();
    return at + 1;
  }
  if (char === '$' && text[at + 1] === '{') {
    stack.push({ kind: 'expression', depth: 1, previous: '' });
    return at + 2;
  }
  return at + 1;
}

/* NOSONAR */ function advanceTemplateExpression(text, stack, state, at) {
  const char = text[at];
  if (char === '"' || char === "'") {
    state.previous = 'value';
    return skipQuoted(text, at);
  }
  if (char === '`') {
    stack.push({ kind: 'template' });
    state.previous = 'value';
    return at + 1;
  }
  if (text.startsWith('//', at)) {
    const end = text.indexOf('\n', at + 2);
    return end < 0 ? text.length : end + 1;
  }
  if (text.startsWith('/*', at)) {
    const end = text.indexOf('*/', at + 2);
    return end < 0 ? text.length : end + 2;
  }
  if (
    char === '/' &&
    ['', '=', '(', ':', ',', '[', '!', '&', '|', '?', '{', ';', 'return', 'case'].includes(state.previous)
  ) {
    const end = skipRegex(text, at);
    if (end) {
      state.previous = 'value';
      return end;
    }
  }
  if (/[A-Za-z_$]/.test(char)) {
    const start = at++;
    while (at < text.length && /[\w$]/.test(text[at])) at++;
    state.previous = text.slice(start, at);
    return at;
  }
  if (char === '{') state.depth++;
  if (char === '}' && !--state.depth) {
    stack.pop();
    return at + 1;
  }
  if (!/\s/.test(char)) state.previous = char;
  return at + 1;
}

function skipTemplate(text, start) {
  const stack = [{ kind: 'template' }];
  let at = start + 1;
  while (at < text.length && stack.length) {
    if (stack.length > 128) return text.length;
    const state = stack.at(-1);
    at =
      state.kind === 'template'
        ? advanceTemplateText(text, stack, at)
        : advanceTemplateExpression(text, stack, state, at);
  }
  return at;
}
function skipAmbiguousStatement(text, start) {
  let at = skipRegex(text, start) ?? start + 1;
  while (at < text.length) {
    const char = text[at];
    if (char === ';' || char === '\n') return at + 1;
    if (char === '"' || char === "'") {
      at = skipQuoted(text, at);
      continue;
    }
    if (char === '`') {
      at = skipTemplate(text, at);
      continue;
    }
    if (text.startsWith('/*', at)) {
      const end = text.indexOf('*/', at + 2);
      at = end < 0 ? text.length : end + 2;
      continue;
    }
    at++;
  }
  return at;
}

function skipScriptTrivia(body, from) {
  let at = from;
  while (at < body.length) {
    if (/\s/.test(body[at])) {
      at++;
      continue;
    }
    if (body.startsWith('//', at) || body.startsWith('<!--', at) || body.startsWith('-->', at)) {
      const end = body.indexOf('\n', at + 2);
      at = end < 0 ? body.length : end + 1;
      continue;
    }
    if (body.startsWith('/*', at)) {
      const end = body.indexOf('*/', at + 2);
      at = end < 0 ? body.length : end + 2;
      continue;
    }
    break;
  }
  return at;
}

/* NOSONAR: single-pass routine, splitting it would change shared state */ function scanRegexLiteral(body, start) {
  let at = start + 1,
    inClass = false;
  for (; at < body.length; at++) {
    if (body[at] === '\\') {
      at++;
      continue;
    }
    if (/[\r\n]/.test(body[at])) return null;
    if (body[at] === '[') inClass = true;
    if (body[at] === ']') inClass = false;
    if (body[at] === '/' && !inClass) {
      at++;
      while (/[a-z]/i.test(body[at] ?? '') && at < body.length) at++;
      return at;
    }
  }
  return null;
}

function selectorForScriptReference(name, value) {
  if (name !== 'getElementById') return safeScriptSelector(value);
  // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
  return !/[\s?=&/{}%\x00-\x08\x0e-\x1f\x7f]/.test(value) && value.length <= 160 && value ? cssId(value) : null;
}

function addScriptHint(rows, seen, source, body, start, selector) {
  if (!selector || seen.has(selector)) return;
  seen.add(selector);
  rows.push({
    ...source,
    selector,
    line: /\.[cm]?js$/i.test(source.sourceFile ?? '') ? body.slice(0, start).split('\n').length : undefined,
    evidence: 'script-selector',
    certainty: 'candidate',
  });
}

function scanScriptIdentifier(body, source, state) {
  const start = state.index;
  while (/[\w$]/.test(body[state.index] ?? '') && state.index < body.length) state.index++;
  const name = body.slice(start, state.index);
  if (
    (state.previous === '.' && ['getElementById', 'querySelector', 'querySelectorAll'].includes(name)) ||
    (state.previous !== '.' && ['$', 'jQuery'].includes(name))
  ) {
    let at = skipScriptTrivia(body, state.index);
    if (body[at] === '(') {
      at = skipScriptTrivia(body, at + 1);
      const string = quotedString(body, at);
      if (string) {
        const end = skipScriptTrivia(body, string.end);
        if (body[end] === ')') {
          const selector = selectorForScriptReference(name, string.value);
          addScriptHint(state.rows, state.seen, source, body, start, selector);
          state.index = end + 1;
          state.previous = ')';
          return;
        }
      }
    }
  }
  state.previous = name;
}

function scanScriptSlash(body, state) {
  if (!['', '=', '(', ',', ':', ';', '[', '{', '!', '?', 'return', 'case', '=>'].includes(state.previous)) {
    state.index = skipAmbiguousStatement(body, state.index);
    state.previous = ';';
    return true;
  }
  const end = scanRegexLiteral(body, state.index);
  if (!end) return false;
  state.index = end;
  state.previous = 'regex';
  return true;
}

function containsSurrogate(value) {
  return [...value].some((item) => {
    const code = item.codePointAt(0);
    return code >= 0xd800 && code <= 0xdfff;
  });
}

/* NOSONAR: single-pass routine, splitting it would change shared state */ function decodeQuotedEscape(text, index) {
  let char = text[++index];
  if (char === undefined) return null;
  if (char === '\r' || char === '\n') {
    if (char === '\r' && text[index + 1] === '\n') index++;
    return { index, continuation: true };
  }
  if (/[1-9]/.test(char) || (char === '0' && /\d/.test(text[index + 1] ?? ''))) return null;
  const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' };
  if (Object.hasOwn(simple, char)) char = simple[char];
  else if (char === 'x' || char === 'u') {
    if (char === 'u' && text[index + 1] === '{') {
      const close = text.indexOf('}', index + 2),
        hex = text.slice(index + 2, close);
      if (close < 0 || !/^[0-9a-f]{1,6}$/i.test(hex) || Number.parseInt(hex, 16) > 0x10ffff) return null;
      char = String.fromCodePoint(Number.parseInt(hex, 16));
      index = close;
    } else {
      const count = char === 'x' ? 2 : 4,
        hex = text.slice(index + 1, index + 1 + count);
      if (!new RegExp(`^[0-9a-f]{${count}}$`, 'i').test(hex)) return null;
      char = String.fromCodePoint(Number.parseInt(hex, 16));
      index += count;
    }
  }
  return { character: char, index, continuation: false };
}

/* NOSONAR: single-pass routine, splitting it would change shared state */ function quotedString(text, start) {
  const quote = text[start];
  if (quote !== '"' && quote !== "'") return null;
  let value = '';
  for (let at = start + 1; at < text.length; at++) {
    let char = text[at];
    if (char === quote) {
      if (containsSurrogate(value)) return null;
      return { value, end: at + 1 };
    }
    if (/[\r\n]/.test(char)) return null;
    if (char === '\\') {
      const escape = decodeQuotedEscape(text, at);
      if (!escape) return null;
      at = escape.index; // NOSONAR: loop cursor is advanced in the body on purpose
      if (escape.continuation) continue;
      char = escape.character;
    }
    value += char;
    if (value.length > 160) return null;
  }
  return null;
}

function safeScriptSelector(value) {
  // eslint-disable-next-line no-control-regex -- Control-character matching is deliberate validation or redaction at this boundary.
  if (!value || value.length > 160 || /[\x00-\x1f\x7f{}%]/.test(value)) return null;
  // Only declared schema/component identifiers may appear as attribute values. Arbitrary
  // DOM values, hrefs and nested functional selectors must never become saved evidence.
  const rest = value.replace(
    /\[(data-(?:field(?:name)?|attribute|entityname|formid|viewid|listid))(?:\s*=\s*(?:(['"])[a-z0-9_-]+\2|[a-z0-9_-]+))?\s*\]/gi, // NOSONAR: regex kept: a rewrite would change matches or captures
    '',
  );
  return /[#.[]/.test(value) && /^[\w#.\s>+~,*:\\-]*$/.test(rest) ? value : null;
}
