const WORD = String.raw`\p{L}\p{Mn}\p{Nd}\p{Pc}`;
const TAG_NAME = new RegExp(String.raw`^\s*([${WORD}]+)`, 'u');
// Tags whose body the runtime does not tokenise (RawBlock subclasses in liquid-engine.mjs / liquid.mjs).
const RAW_BODY_TAGS = new Set(['raw', 'comment', 'manifest']);
// Block tags whose body may render zero times or only on one branch.
const CONDITIONAL_BLOCKS = new Set(['if', 'unless', 'case', 'for', 'tablerow']);
const BLOCK_TAGS = new Set([
  ...CONDITIONAL_BLOCKS,
  'capture',
  'block',
  'entitylist',
  'entityview',
  'searchindex',
  'fetchxml',
  'literal',
]);

/**
 * Liquid tags and outputs of a source in document order, delimited as the runtime tokeniser
 * delimits them (liquid-engine.mjs scanDelimitedToken): a tag ends at the first `%}` and an output
 * at the first `}}` outside a quoted string, so a `%` or `}` inside arguments does not end it.
 * An unterminated token ends the scan (the runtime rejects the template from that point).
 * Bodies of raw, comment and manifest blocks are skipped. Each token reports the enclosing block
 * tags and whether one of them is conditional (if, unless, case, for, tablerow). The scan reads
 * every character at most twice.
 *
 * @returns {{ type: 'tag'|'output', name: string|null, markup: string, text: string, start: number,
 *   end: number, blocks: string[], conditional: boolean }[]}
 */
export function scanLiquidTokens(source) {
  const text = String(source ?? '');
  const tokens = [];
  const stack = [];
  const opening = /\{\{|\{%/g;
  let position = 0,
    lenient = false;
  while (position < text.length) {
    opening.lastIndex = position;
    const match = opening.exec(text);
    if (!match) break;
    const isTag = match[0] === '{%';
    const closer = isTag ? '%' : '}';
    let end = lenient ? -1 : delimitedTokenEnd(text, match.index + 2, closer);
    // An unbalanced quote makes the runtime reject the template. Inspection stays best effort and,
    // from that token on, ends each token at its first closer (one pass, never a rescan per token).
    if (end < 0) {
      lenient = true;
      const close = text.indexOf(`${closer}}`, match.index + 2);
      if (close < 0) break;
      end = close + 2;
    }
    position = recordToken(tokens, stack, text, isTag, match.index, end);
  }
  return tokens;
}

/**
 * Records the token `[start, end)` of `text` (an output, or a tag with its enclosing block tags) and returns where the
 * scan resumes: after the token, or after the body of a raw, comment or manifest tag.
 */
function recordToken(tokens, stack, text, isTag, start, end) {
  let inner = text.slice(start + 2, end - 2);
  if (inner.startsWith('-')) inner = inner.slice(1);
  if (inner.endsWith('-')) inner = inner.slice(0, -1);
  if (!isTag) {
    tokens.push(tokenOf('output', null, inner, text, start, end, stack));
    return end;
  }
  const nameMatch = TAG_NAME.exec(inner);
  const name = nameMatch ? nameMatch[1].toLowerCase() : '';
  const markup = nameMatch ? inner.slice(nameMatch[0].length) : inner;
  if (RAW_BODY_TAGS.has(name)) return rawBodyEnd(text, name, end);
  if (name.startsWith('end') && BLOCK_TAGS.has(name.slice(3))) {
    const index = stack.lastIndexOf(name.slice(3));
    if (index >= 0) stack.length = index;
    tokens.push(tokenOf('tag', name, markup, text, start, end, stack));
    return end;
  }
  tokens.push(tokenOf('tag', name, markup, text, start, end, stack));
  if (BLOCK_TAGS.has(name)) stack.push(name);
  return end;
}

/** The end of the token whose body starts at `from`: after its first `closer}` outside a quoted string, else -1. */
function delimitedTokenEnd(text, from, closer) {
  let cursor = from;
  while (cursor < text.length) {
    const character = text[cursor];
    if (character === "'" || character === '"') {
      const close = text.indexOf(character, cursor + 1);
      if (close < 0) return -1;
      cursor = close + 1;
    } else if (character === closer && text[cursor + 1] === '}') {
      return cursor + 2;
    } else cursor++;
  }
  return -1;
}

/** Where the scan resumes after a raw, comment or manifest tag whose body starts at `from`: past its end tag. */
function rawBodyEnd(text, name, from) {
  const close = new RegExp(String.raw`\{%-?\s*end${name}\s*-?%\}`, 'gi');
  close.lastIndex = from;
  const found = close.exec(text);
  return found ? found.index + found[0].length : text.length;
}

function tokenOf(type, name, markup, text, start, end, stack) {
  return {
    type,
    name,
    markup,
    text: text.slice(start, end),
    start,
    end,
    blocks: [...stack],
    conditional: stack.some((block) => CONDITIONAL_BLOCKS.has(block)),
  };
}

/**
 * The web template record that an include, render or extends name selects, as the runtime's
 * template lookup selects it (liquid.mjs createPortalRenderer findTemplate): the first record in
 * portal.templates order whose name equals the reference exactly, else the first whose trimmed,
 * case-insensitive name equals it. Inspection reads the body of this record (by its id), never
 * `portal.templates[name]`, which the importer overwrites with the last record of that name.
 */
export function findWebTemplate(portal, reference) {
  if (reference == null) return undefined;
  const wanted = String(reference);
  const key = (value) =>
    String(value ?? '')
      .trim()
      .toLowerCase();
  let match;
  for (const [name, template] of Object.entries(portal?.templates ?? {})) {
    if (!template || typeof template !== 'object') continue;
    const templateName = template.name ?? name;
    if (templateName === wanted) return template;
    if (match === undefined && key(templateName) === key(wanted)) match = template;
  }
  return match;
}

/** Hide non-executing Liquid bodies when indexing Liquid references, preserving offsets. */
export function stripLiquidLiteralBlocks(source) {
  const text = String(source ?? '');
  const tags = /{%-?\s*(raw|endraw|comment|endcomment|manifest|endmanifest)\b[^%]*%-?}/gi;
  let kind = null,
    depth = 0,
    start = 0,
    from = 0,
    result = '';
  const blank = (body) => body.replace(/[^\r\n]/g, ' ');
  for (const match of text.matchAll(tags)) {
    const tag = match[1].toLowerCase();
    if (!kind) {
      if (tag.startsWith('end')) continue;
      kind = tag;
      depth = 1;
      start = match.index;
      result += text.slice(from, start);
    } else if (kind === 'comment' && tag === 'comment') depth++;
    else if (tag === 'end' + kind && --depth === 0) {
      from = match.index + match[0].length;
      result += blank(text.slice(start, from));
      kind = null;
    }
  }
  return result + (kind ? blank(text.slice(start)) : text.slice(from));
}
