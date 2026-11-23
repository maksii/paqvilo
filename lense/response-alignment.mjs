import { createHash } from 'node:crypto';
import { Tokenizer, TokenizerMode } from 'parse5';
import { normalizePortalPath } from '../mirage/lib/importer.mjs';
import { resolvePageResources } from '../mirage/lib/page-resources.mjs';

/**
 * Aligns a served portal document with the exported markup sources.
 *
 * The portal renders Liquid on the server, so the browser never says which template wrote an element. What it serves
 * still contains the templates' literal markup: every start tag, end tag and text between two Liquid tokens of a web
 * template, content snippet or page copy appears in the response in source order. This module finds those literal
 * token sequences in the response and answers, for every start tag of the document:
 *
 * - `aligned`: the tag is this start tag of this source (a unique token sequence around it matches the source);
 * - `generated`: the tag sits between two matched parts of one source, where that source has Liquid code: that code
 *   produced it (an include, an output, a form or list tag);
 * - `shell`: the tag is outside everything the sources wrote: the portal's own page shell;
 * - `conflict`: two different sources explain the tag equally well.
 *
 * Nothing here reads data values: only tags, attribute values and text that the sources themselves contain.
 */

const MASK = '';
const MASKS = /+/g;
const VOID = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);
const RAW_TEXT = new Set(['style', 'xmp', 'iframe', 'noembed', 'noframes', 'noscript']);
const RC_DATA = new Set(['textarea', 'title']);
// Liquid tags that write nothing where they stand: a literal after one directly follows the literal before it.
const SILENT_TAGS = new Set([
  'assign',
  'capture',
  'endcapture',
  'comment',
  'if',
  'elsif',
  'else',
  'endif',
  'unless',
  'endunless',
  'case',
  'when',
  'endcase',
  'for',
  'endfor',
  'break',
  'continue',
  'increment',
  'decrement',
  'ifchanged',
  'endifchanged',
  'raw',
  'endraw',
  'block',
  'endblock',
  'extends',
  'substitution',
  'endsubstitution',
  'fetchxml',
  'endfetchxml',
  'entitylist',
  'endentitylist',
  'entityview',
  'endentityview',
  'searchindex',
  'endsearchindex',
  'manifest',
]);
// Block tags whose body is never written where it stands: a query (fetchxml, Liquid inside it included) or a raw
// manifest. The whole block is one silent token, so the markup-like text of its body is no literal of the source.
const HIDDEN_BODIES = new Map([
  ['fetchxml', 'endfetchxml'],
  ['manifest', 'endmanifest'],
]);
const LOOP_TAGS = new Set(['for', 'tablerow']);
const STRONG_WEIGHT = 3;
const UNIQUE_WEIGHT = 1.3;
const MAX_CANDIDATES = 4000;
// Served/source item pairs all runs of one document may extend over: beyond it the alignment is marked truncated.
const MAX_PAIRS = 4_000_000;

// The offset just past the closing `%}` (a tag) or `}}` (an output) of a token whose body starts at `from`, skipping
// quoted strings; -1 when the token is not closed.
function tokenEnd(text, from, isTag) {
  let position = from;
  while (position < text.length) {
    const ch = text[position++];
    if (ch === "'" || ch === '"') {
      const end = text.indexOf(ch, position);
      if (end < 0) return -1;
      position = end + 1;
    } else if ((isTag ? ch === '%' : ch === '}') && text[position] === '}') {
      return position + 1;
    }
  }
  return -1;
}

/** Liquid tokens of a source, in order: `{{ }}` outputs and `{% %}` tags, with comment bodies as one token. */
/* NOSONAR: one state machine over the token stream: comment depth, raw and hidden-body blocks span tokens */ export function scanLiquidTokens(
  text,
) {
  const tokens = [];
  const opening = /\{\{|\{%/g;
  let comment = null;
  let raw = null;
  let hidden = null;
  for (;;) {
    const match = opening.exec(text);
    if (!match) break;
    const isTag = match[0] === '{%';
    const position = tokenEnd(text, match.index + 2, isTag);
    if (position < 0) break;
    opening.lastIndex = position;
    const body = text
      .slice(match.index + 2, position - 2)
      .replace(/^-/, '')
      .replace(/-$/, '');
    const name = isTag ? (/^\s*([a-zA-Z_][\w-]*)/.exec(body)?.[1] ?? '').toLowerCase() : '';
    if (hidden) {
      if (isTag && name === hidden.close) {
        tokens.push({
          start: hidden.start,
          end: position,
          kind: 'tag',
          name: hidden.name,
          silent: true,
          body: hidden.body,
        });
        hidden = null;
      }
      continue;
    }
    if (raw) {
      if (isTag && name === 'endraw') {
        tokens.push({ start: match.index, end: position, kind: 'tag', name, silent: true });
        raw = null;
      }
      continue;
    }
    if (comment) {
      if (isTag && name === 'comment') comment.depth++;
      else if (isTag && name === 'endcomment' && --comment.depth === 0) {
        tokens.push({ start: comment.start, end: position, kind: 'tag', name: 'comment', silent: true });
        comment = null;
      }
      continue;
    }
    if (isTag && name === 'comment') {
      comment = { start: match.index, depth: 1 };
      continue;
    }
    if (isTag && HIDDEN_BODIES.has(name)) {
      hidden = { start: match.index, name, close: HIDDEN_BODIES.get(name), body: body.trim().slice(0, 400) };
      continue;
    }
    if (isTag && name === 'raw') raw = true;
    tokens.push({
      start: match.index,
      end: position,
      kind: isTag ? 'tag' : 'output',
      name,
      silent: isTag && SILENT_TAGS.has(name),
      body: body.trim().slice(0, 400),
    });
  }
  // An unclosed comment hides the rest of the source, as the renderer would refuse it.
  if (comment) tokens.push({ start: comment.start, end: text.length, kind: 'tag', name: 'comment', silent: true });
  else if (hidden)
    tokens.push({
      start: hidden.start,
      end: text.length,
      kind: 'tag',
      name: hidden.name,
      silent: true,
      body: hidden.body,
    });
  return tokens;
}

const collapse = (value) => value.replace(/\s+/g, ' ').trim();

function tokenizeHtml(text, visit) {
  let tokenizer = null;
  let textStart = 0;
  let chars = '';
  let rawMode = false;
  const flush = (end) => {
    if (chars) visit.text(chars, textStart, end, rawMode);
    chars = '';
  };
  const character = (token) => {
    chars += token.chars;
  };
  tokenizer = new Tokenizer(
    { sourceCodeLocationInfo: true },
    {
      onComment(token) {
        flush(token.location.startOffset);
        visit.comment(token.data, token.location.startOffset, token.location.endOffset);
        textStart = token.location.endOffset;
      },
      onDoctype(token) {
        flush(token.location.startOffset);
        textStart = token.location.endOffset;
      },
      onStartTag(token) {
        flush(token.location.startOffset);
        rawMode = false;
        visit.start(
          token.tagName,
          token.attrs,
          token.location.startOffset,
          token.location.endOffset,
          token.location.attrs,
        );
        textStart = token.location.endOffset;
        if (token.tagName === 'script') {
          tokenizer.state = TokenizerMode.SCRIPT_DATA;
          rawMode = true;
        } else if (RAW_TEXT.has(token.tagName)) {
          tokenizer.state = TokenizerMode.RAWTEXT;
          rawMode = true;
        } else if (RC_DATA.has(token.tagName)) tokenizer.state = TokenizerMode.RCDATA;
        else if (token.tagName === 'plaintext') tokenizer.state = TokenizerMode.PLAINTEXT;
        tokenizer.lastStartTagName = token.tagName;
      },
      onEndTag(token) {
        flush(token.location.startOffset);
        rawMode = false;
        visit.end(token.tagName, token.location.startOffset, token.location.endOffset);
        textStart = token.location.endOffset;
      },
      onEof() {
        flush(text.length);
      },
      onCharacter: character,
      onWhitespaceCharacter: character,
      onNullCharacter: character,
    },
  );
  tokenizer.write(text, true);
}

const textWeight = (norm) => 0.5 + Math.min(norm.length, 60) / 20;

function tagSignature(name, attrs) {
  return (
    'S:' +
    name +
    attrs
      .map((attr) => '\u0001' + attr.name + '\u0002' + attr.value)
      .sort(/* NOSONAR: plain code-unit order of generated keys */)
      .join('')
  );
}

function tagWeight(attrs) {
  let weight = 0.6;
  let counted = 0;
  for (const attr of attrs) {
    if (counted >= 3) break;
    counted++;
    weight += attr.name === 'id' ? 1.5 : 0.7;
  }
  return weight;
}

// Attributes the portal adds to tags a source wrote: they are not part of what the source says.
const PLATFORM_ATTRIBUTES = new Set(['nonce']);

/** Items of the served document: every tag, comment and text between tags, with offsets and element depth. */
function responseItems(html) {
  const items = [];
  const stack = [];
  tokenizeHtml(html, {
    start(name, given, start, end) {
      const attrs = given.some((attr) => PLATFORM_ATTRIBUTES.has(attr.name))
        ? given.filter((attr) => !PLATFORM_ATTRIBUTES.has(attr.name))
        : given;
      items.push({ t: 'start', name, attrs, sig: tagSignature(name, attrs), start, end, depth: stack.length });
      if (!VOID.has(name)) stack.push(items.length - 1);
    },
    end(name, start, end) {
      let at = stack.length - 1;
      while (at >= 0 && stack.length - at <= 32 && items[stack[at]].name !== name) at--;
      if (at >= 0 && items[stack[at]].name === name) {
        items[stack[at]].close = items.length;
        stack.length = at;
      }
      items.push({ t: 'end', name, sig: 'E:' + name, start, end, depth: stack.length });
    },
    text(chars, start, end, raw) {
      const norm = collapse(chars);
      if (norm) items.push({ t: 'text', norm, sig: 'T:' + norm, start, end, raw, depth: stack.length });
    },
    comment(data, start, end) {
      items.push({ t: 'comment', norm: collapse(data), sig: 'C:' + collapse(data), start, end, depth: stack.length });
    },
  });
  return items;
}

// Liquid block tags: what stands between one and its end is written only when the block runs.
const BLOCK_OPEN = new Set(['if', 'unless', 'case', 'for', 'tablerow', 'capture']);
const BLOCK_CLOSE = new Set(['endif', 'endunless', 'endcase', 'endfor', 'endtablerow', 'endcapture']);

// The ranges of a tag's text that stand inside a Liquid block opened within the tag.
function conditionalRanges(tokens) {
  const ranges = [];
  const stack = [];
  for (const token of tokens) {
    if (token.kind !== 'tag') continue;
    if (BLOCK_OPEN.has(token.name)) stack.push(token.start);
    else if (BLOCK_CLOSE.has(token.name) && stack.length) {
      const start = stack.pop();
      if (!stack.length) ranges.push([start, token.end]);
    }
  }
  return ranges;
}

// The literal pieces of an attribute value that the served value must hold, in order: text inside a Liquid block of
// the value (`class="a {% if x %}b{% endif %}"`) may be there or not and is left out. Null when the value's masked
// runs do not add up to the Liquid tokens given.
/* NOSONAR: one walk over masked runs that consumes the Liquid tokens with a shared cursor and block depth */ function valuePieces(
  value,
  tokens,
) {
  const pieces = [''];
  let depth = 0;
  let next = 0;
  let from = 0;
  for (const run of value.matchAll(MASKS)) {
    if (depth === 0) pieces[pieces.length - 1] += value.slice(from, run.index);
    let length = run[0].length;
    while (length > 0 && next < tokens.length) {
      const token = tokens[next++];
      length -= token.end - token.start;
      if (token.kind !== 'tag') continue;
      if (BLOCK_OPEN.has(token.name)) depth++;
      else if (BLOCK_CLOSE.has(token.name)) depth = Math.max(0, depth - 1);
    }
    if (length !== 0) return null;
    pieces.push('');
    from = run.index + run[0].length;
  }
  if (depth === 0) pieces[pieces.length - 1] += value.slice(from);
  return pieces;
}

function sourceTag(name, attrs, start, end, conditional = null, tokensOf = null) {
  if (name.includes(MASK)) return null;
  const fixed = [];
  const patterns = [];
  let open = false;
  for (const attr of attrs) {
    // An attribute a Liquid block inside the tag writes or leaves out: the served tag may carry it or not.
    if (conditional?.(attr.name)) {
      open = true;
      continue;
    }
    if (attr.name.includes(MASK)) {
      // A conditional or generated attribute: the served tag may carry attributes the source does not spell out.
      open = true;
      continue;
    }
    if (attr.value.includes(MASK)) {
      const tokens = tokensOf?.(attr.name);
      patterns.push({
        name: attr.name,
        pieces: (tokens && valuePieces(attr.value, tokens)) || attr.value.split(MASKS),
      });
    } else fixed.push(attr);
  }
  const dynamic = open || patterns.length > 0;
  return {
    t: 'start',
    name,
    attrs: fixed,
    patterns,
    open,
    dynamic,
    sig: dynamic ? null : tagSignature(name, fixed),
    start,
    end,
    weight: tagWeight(fixed) + patterns.length * 0.3,
  };
}

/** Items of one source: its literal tags and text, with a `gap` item wherever Liquid code stands between them. */
export function sourceItems(text) {
  const liquid = scanLiquidTokens(text);
  if (!liquid.length && !text.includes('<')) return { items: [], liquid, loops: [] };
  const masked = liquid.length ? maskLiquid(text, liquid) : text;
  const items = [];
  let cursor = 0;
  const gapBetween = (start, end) => {
    // Liquid tokens inside [start, end): one gap for a run of them, whatever whitespace separates them.
    const tokens = [];
    while (cursor < liquid.length && liquid[cursor].end <= start) cursor++;
    for (let at = cursor; at < liquid.length && liquid[at].start < end; at++) tokens.push(liquid[at]);
    return tokens;
  };
  const pushGap = (tokens) => {
    if (!tokens.length) return;
    const last = items.at(-1);
    if (last?.t === 'gap') {
      last.end = tokens.at(-1).end;
      last.liquid.push(...tokens);
      last.silent &&= tokens.every((token) => token.silent);
      return;
    }
    items.push({
      t: 'gap',
      start: tokens[0].start,
      end: tokens.at(-1).end,
      liquid: [...tokens],
      silent: tokens.every((token) => token.silent),
    });
  };
  tokenizeHtml(masked, {
    start(name, attrs, start, end, places) {
      let conditional = null;
      let tokensOf = null;
      if (liquid.length && masked.slice(start, end).includes(MASK)) {
        const inside = liquid.filter((token) => token.start >= start && token.end <= end);
        const ranges = conditionalRanges(inside);
        if (ranges.length)
          conditional = (attribute) => {
            const at = places?.[attribute]?.startOffset;
            return at !== undefined && ranges.some(([from, to]) => at >= from && at < to);
          };
        tokensOf = (attribute) => {
          const place = places?.[attribute];
          return place
            ? inside.filter((token) => token.start >= place.startOffset && token.end <= place.endOffset)
            : null;
        };
      }
      const tag = sourceTag(name, attrs, start, end, conditional, tokensOf);
      if (tag) items.push(tag);
      else pushGap(gapBetween(start, end));
    },
    end(name, start, end) {
      if (name.includes(MASK)) pushGap(gapBetween(start, end));
      else items.push({ t: 'end', name, sig: 'E:' + name, start, end, weight: 0.2 });
    },
    comment(data, start, end) {
      if (data.includes(MASK)) pushGap(gapBetween(start, end));
      else {
        const norm = collapse(data);
        items.push({ t: 'comment', norm, sig: 'C:' + norm, start, end, weight: 1 });
      }
    },
    /* NOSONAR: one pass over a text node's pieces that shares the gap cursor and the set of gaps awaiting a piece */ text(
      chars,
      start,
      end,
      raw,
    ) {
      if (!chars.includes(MASK)) {
        const norm = collapse(chars);
        if (norm) items.push({ t: 'text', norm, sig: 'T:' + norm, start, end, raw, weight: textWeight(norm) });
        return;
      }
      // Literal pieces between Liquid tokens of one text node. The decoded pieces and the raw pieces come in the same
      // order: character references never add or remove a masked character.
      const decoded = chars.split(MASKS);
      const rawText = masked.slice(start, end);
      const bounds = [];
      let from = 0;
      for (const match of rawText.matchAll(MASKS)) {
        bounds.push([start + from, start + match.index]);
        from = match.index + match[0].length;
      }
      bounds.push([start + from, end]);
      // Liquid code between two literal pieces of one text node: the served node holds both pieces and what the code
      // wrote, so one served item stands for both. Nothing is laid over across such a gap: it is never crossed as
      // silent nor taken as inert (a miss there instead of a false difference).
      let pieceBefore = false;
      const pending = new Set();
      for (let index = 0; index < decoded.length; index++) {
        const norm = collapse(decoded[index]);
        const [pieceStart, pieceEnd] = bounds[index] ?? [start, end];
        if (norm && pieceBefore)
          for (const gap of pending) {
            gap.inText = true;
            gap.silent = false;
          }
        if (norm) {
          pieceBefore = true;
          pending.clear();
        }
        if (norm)
          items.push({
            t: 'text',
            norm,
            sig: null,
            start: pieceStart,
            end: pieceEnd,
            raw,
            // The served text node continues with what the Liquid code printed.
            openStart: index > 0,
            openEnd: index < decoded.length - 1,
            weight: textWeight(norm),
          });
        if (index < decoded.length - 1) {
          pushGap(gapBetween(pieceEnd, bounds[index + 1]?.[0] ?? end));
          if (pieceBefore && items.at(-1)?.t === 'gap') pending.add(items.at(-1));
        }
      }
    },
  });
  linkElements(items);
  const skippable = branchSteps(items);
  // Text at the very start or end of a source shares its served text node with what is written next to the source
  // (the includer's text, the shell's): the served node may go on beyond it. Its exact text still seeds a match.
  for (const item of [items[0], items.at(-1)]) {
    if (item?.t !== 'text') continue;
    if (item.sig) item.seed = item.sig;
    item.sig = null;
    if (item === items[0]) item.openStart = true;
    if (item === items.at(-1)) item.openEnd = true;
  }
  markCaptured(items);
  return { items, liquid, loops: loopRanges(items), skippable };
}

// The source text with every Liquid token replaced by as many MASK characters: offsets stay those of the source.
function maskLiquid(text, liquid) {
  const parts = [];
  let from = 0;
  for (const token of liquid) {
    parts.push(text.slice(from, token.start), MASK.repeat(token.end - token.start));
    from = token.end;
  }
  parts.push(text.slice(from));
  return parts.join('');
}

// What stands in a capture body is printed elsewhere, and may be changed on the way (a filter on the captured
// value): the served text need not be the source's text there.
function markCaptured(items) {
  let capturing = 0;
  for (const item of items) {
    if (item.t !== 'gap') {
      if (capturing > 0) item.captured = true;
      continue;
    }
    for (const token of item.liquid) {
      if (token.kind !== 'tag') continue;
      if (token.name === 'capture') capturing++;
      else if (token.name === 'endcapture') capturing = Math.max(0, capturing - 1);
    }
  }
}

// Each loop of a source as the two gap items that hold its opening and closing tag.
function loopRanges(items) {
  const loops = [];
  const stack = [];
  for (let index = 0; index < items.length; index++) {
    if (items[index].t !== 'gap') continue;
    for (const token of items[index].liquid) {
      if (LOOP_TAGS.has(token.name)) stack.push(index);
      else if ((token.name === 'endfor' || token.name === 'endtablerow') && stack.length)
        loops.push({ open: stack.pop(), close: index });
    }
  }
  return loops;
}

// The end tag of each literal start tag of a source, when the source closes the element itself.
function linkElements(items) {
  const stack = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    // Element depth in the source's own markup: 0 for the tags at its top level.
    if (item.t === 'start') item.level = stack.length;
    if (item.t === 'start' && !VOID.has(item.name)) stack.push(index);
    else if (item.t === 'end') {
      let at = stack.length - 1;
      while (at >= 0 && stack.length - at <= 32 && items[stack[at]].name !== item.name) at--;
      if (at >= 0 && items[stack[at]].name === item.name) {
        items[stack[at]].close = index;
        stack.length = at;
      }
    }
  }
}

// Whether a served attribute value holds the literal pieces of a source value pattern, in order, from its first
// character and up to its last.
function piecesMatch(pieces, value) {
  let at = 0;
  for (let index = 0; index < pieces.length; index++) {
    const piece = pieces[index];
    if (index === 0) {
      if (!value.startsWith(piece)) return false;
      at = piece.length;
    } else {
      const found = value.indexOf(piece, at);
      if (found < 0) return false;
      at = found + piece.length;
    }
  }
  const tail = pieces.at(-1);
  return !tail || value.endsWith(tail);
}

function sameStartTag(source, served) {
  if (source.name !== served.name) return false;
  if (!source.dynamic) return source.sig === served.sig;
  if (!source.open && served.attrs.length !== source.attrs.length + source.patterns.length) return false;
  for (const attr of source.attrs)
    if (!served.attrs.some((actual) => actual.name === attr.name && actual.value === attr.value)) return false;
  for (const pattern of source.patterns) {
    const actual = served.attrs.find((attr) => attr.name === pattern.name);
    if (!actual || !piecesMatch(pattern.pieces, actual.value)) return false;
  }
  return true;
}

function sameItem(source, served) {
  if (source.t !== served.t) return false;
  if (source.t === 'start') return sameStartTag(source, served);
  if (source.t === 'end') return source.name === served.name;
  if (source.sig) return source.sig === served.sig;
  if (source.openStart && source.openEnd) return served.norm.includes(source.norm);
  if (source.openEnd) return served.norm.startsWith(source.norm);
  if (source.openStart) return served.norm.endsWith(source.norm);
  return source.norm === served.norm;
}

/**
 * Prepares the sources once per source revision.
 * @param {Array<{id:string, text:string, tier?:number, name?:string}>} sources `tier` 0 marks the sources of the
 *   requested page (its own copy, templates it can reach); other sources are tried with the same rules but lose a tie.
 */
export function prepareAlignment(sources) {
  const prepared = [];
  const seeds = new Map();
  for (const source of sources) {
    if (typeof source.text !== 'string' || !source.text || source.text.length > 2 * 1024 * 1024) continue;
    const { items, liquid, loops, skippable = 0 } = sourceItems(source.text);
    // A source without a tag of its own (only an include, only a form tag) is never found in a document, but a
    // reference to it can be followed into its Liquid code.
    if (!items.some((item) => item.t === 'start') && !liquid.length) continue;
    const entry = {
      id: source.id,
      tier: source.tier ?? 1,
      name: source.name ?? '',
      items,
      liquid,
      loops,
      text: source.text,
      skippable,
    };
    const number = prepared.length;
    prepared.push(entry);
    indexEntry(entry, number, seeds);
  }
  return { sources: prepared, seeds };
}

// The literal weights of a prepared source and its seeds: the items a run can start from, by signature.
function indexEntry(entry, number, seeds) {
  const { items } = entry;
  // The weight of the literal items up to each one: what a run through an item can weigh at most.
  entry.literal = new Int32Array(items.length);
  entry.prefix = new Float64Array(items.length + 1);
  let literals = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    entry.literal[index] = literals;
    if (item.t !== 'gap') entry.prefix[++literals] = entry.prefix[literals - 1] + item.weight;
    const seed = item.sig ?? item.seed;
    if (!seed || item.t === 'end' || (item.t === 'start' && !item.attrs.length)) continue;
    if (item.t === 'text' && item.norm.length < 3) continue;
    let rows = seeds.get(seed);
    if (!rows) {
      rows = [];
      seeds.set(seed, rows);
    }
    rows.push(number, index);
  }
  entry.literals = literals;
}

const BRANCH_OPEN = new Set(['if', 'unless', 'case', 'for', 'tablerow']);
const BRANCH_SEPARATOR = new Set(['else', 'elsif', 'when']);
const BRANCH_CLOSE = new Set(['endif', 'endunless', 'endcase', 'endfor', 'endtablerow']);

/**
 * Where a run goes on after a gap of control tags. A literal at the end of one branch of a condition is never followed
 * by the first literal of the next branch: crossing `else`, `elsif` or `when` from inside a branch goes on after the
 * end of the block, and backwards from the start of a branch, before the block's opening tag. Entering a block with
 * several branches, the run may go on in any of them: `other` lists the first literal of each other branch (the last,
 * backwards), and `unknown` says a branch starts with more Liquid code. Sets `forward` and `back` on each gap item
 * that holds a block tag: `{ next, silent, other, unknown }`, `silent` when every tag crossed writes nothing.
 */
function branchSteps(items) {
  const at = linkBlocks(items);
  // The literal a branch starts with (forward) or ends with (backward), next to separator `token`; null when Liquid
  // code stands there first.
  const edge = (token, step) => {
    const { index, position } = at.get(token);
    const tokens = items[index].liquid;
    // Tags that write nothing between the separator and the branch's first literal (an assign, the block's end).
    for (let k = position + step; k >= 0 && k < tokens.length; k += step) if (!tokens[k].silent) return null;
    const next = index + step;
    return next >= 0 && next < items.length && items[next].t !== 'gap' ? next : null;
  };
  /* NOSONAR: one walk across gap items with shared position, block depth and jump state; the branches it enters feed `other` */ function walk(
    index,
    step,
  ) {
    let silent = true;
    let position = step > 0 ? 0 : items[index].liquid.length - 1;
    let inner = 0;
    const other = [];
    let unknown = false;
    // Every pass moves to another item, so the walk makes at most one pass for each of them.
    for (let passes = items.length; passes > 0; passes--) {
      const tokens = items[index].liquid;
      let jumped = false;
      let target = null;
      for (; position >= 0 && position < tokens.length; position += step) {
        const token = tokens[position];
        silent &&= token.silent;
        if (token.kind !== 'tag') continue;
        // Blocks entered on the way are crossed into their first branch (last, backwards); the other branches are
        // where the run could go on as well. A separator of a block the run stands in leaves the block.
        if ((step > 0 ? BRANCH_OPEN : BRANCH_CLOSE).has(token.name)) {
          inner++;
          if (token.block?.close)
            for (const separator of token.block.separators) {
              const literal = edge(separator, step);
              if (literal === null) unknown = true;
              else other.push(literal);
            }
          // A loop may write its body no time at all: what follows the loop may come next as well.
          if (token.block?.close && LOOP_TAGS.has(token.block.open.name)) {
            const literal = edge(step > 0 ? token.block.close : token.block.open, step);
            if (literal === null) unknown = true;
            else other.push(literal);
          }
        } else if ((step > 0 ? BRANCH_CLOSE : BRANCH_OPEN).has(token.name)) inner = Math.max(0, inner - 1);
        else if (BRANCH_SEPARATOR.has(token.name) && inner === 0 && token.block?.close) {
          target = at.get(step > 0 ? token.block.close : token.block.open);
          jumped = true;
          break;
        }
      }
      if (!jumped) return { next: index + step, silent, other, unknown };
      // The separator leaves the block: the walk goes on after its closing tag (before its opening tag, backwards).
      index = target.index;
      position = target.position + step;
    }
    return { next: index + step, silent: false, other, unknown: true };
  }
  const skipped = new Uint8Array(items.length);
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.t !== 'gap' || !item.liquid.some((token) => token.block)) continue;
    item.forward = walk(index, 1);
    item.back = walk(index, -1);
    for (const token of item.liquid) {
      const block = token.block;
      if (!block?.close || !block.separators.length || !BRANCH_SEPARATOR.has(token.name)) continue;
      const last = at.get(block.close).index;
      for (let k = at.get(block.open).index; k <= last; k++) skipped[k] = 1;
    }
  }
  // How many literals a run may step over this way: the reach of a run is that much wider than its pairs.
  let skippable = 0;
  for (let index = 0; index < items.length; index++) if (skipped[index] && items[index].t !== 'gap') skippable++;
  return skippable;
}

// Sets `block` on every block tag of the gap items (`{ open, close, separators }`, shared by the tags of one block)
// and returns where each Liquid token stands: its gap item and its position in that item's tokens.
function linkBlocks(items) {
  const at = new Map();
  const stack = [];
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    if (item.t !== 'gap') continue;
    item.liquid.forEach((token, position) => {
      at.set(token, { index, position });
      if (token.kind !== 'tag') return;
      if (BRANCH_OPEN.has(token.name)) {
        token.block = { open: token, close: null, separators: [] };
        stack.push(token.block);
      } else if (BRANCH_SEPARATOR.has(token.name) && stack.length) {
        token.block = stack.at(-1);
        token.block.separators.push(token);
      } else if (BRANCH_CLOSE.has(token.name) && stack.length) {
        token.block = stack.pop();
        token.block.close = token;
      }
    });
  }
  return at;
}

// Where a run goes on from gap item `item` towards served item `served`: the next source item, or -1 when it stops.
// It stops where the gap prints, and where more than one branch the run could go on in fits the served item.
function stepOver(items, item, index, step, served) {
  const way = (step > 0 ? item.forward : item.back) ?? { next: index + step, silent: item.silent, other: [] };
  if (!way.silent || item.inText) return -1;
  if (!way.other.length && !way.unknown) return way.next;
  if (!served || way.unknown) return -1;
  const fits = [way.next, ...way.other].filter(
    (at, k, all) =>
      all.indexOf(at) === k && at >= 0 && at < items.length && items[at].t !== 'gap' && sameItem(items[at], served),
  );
  // A gap next to the default way (more Liquid code) is followed as before; a choice between branches is not made.
  if (items[way.next]?.t === 'gap') return fits.length ? -1 : way.next;
  if (fits.length === 1) return fits[0];
  return fits.length ? -1 : way.next;
}

function extendRun(source, served, sourceIndex, servedIndex) {
  // One diagonal: source items and served items that follow each other one to one. A gap of Liquid code that writes
  // nothing in place (a control tag) is crossed when the next literal directly follows in the served document.
  // `contradicted`: on one side the source goes on with a literal, no Liquid code in between that prints or decides,
  // and the document holds something else there.
  const pairs = [[sourceIndex, servedIndex]];
  const { items } = source;
  const contradictedAfter = extendForward(items, served, sourceIndex + 1, servedIndex + 1, pairs);
  const contradictedBefore = extendBackward(items, served, sourceIndex - 1, servedIndex - 1, pairs);
  return { pairs, contradicted: contradictedAfter || contradictedBefore };
}

// The forward half of a diagonal from source item `i` and served item `j` on: appends the pairs it finds and returns
// whether the source is contradicted there.
function extendForward(items, served, i, j, pairs) {
  let direct = true;
  while (i < items.length && j < served.length) {
    const item = items[i];
    if (item.t === 'gap') {
      const next = stepOver(items, item, i, 1, served[j]);
      if (next < 0) break;
      if (!inertGap(item)) direct = false;
      i = next;
      continue;
    }
    if (!sameItem(item, served[j])) return direct;
    pairs.push([i, j]);
    direct = true;
    i++;
    j++;
  }
  return false;
}

// The backward half of a diagonal from source item `i` and served item `j` back: prepends the pairs it finds and
// returns whether the source is contradicted there.
function extendBackward(items, served, i, j, pairs) {
  let direct = true;
  while (i >= 0 && j >= 0) {
    const item = items[i];
    if (item.t === 'gap') {
      const next = stepOver(items, item, i, -1, served[j]);
      if (next < 0) break;
      if (!inertGap(item)) direct = false;
      i = next;
      continue;
    }
    if (!sameItem(item, served[j])) return direct;
    pairs.unshift([i, j]);
    direct = true;
    i--;
    j--;
  }
  return false;
}

/* NOSONAR: one pass over seeds that prunes by and updates the shared best-weight arrays, seen pairs and candidate budget */ function collectRuns(
  prepared,
  served,
  excluded = null,
  tierOf = null,
) {
  const runs = [];
  // Pairs already in a run, per source: a seed on a diagonal already followed is not followed again.
  const seen = new Map();
  // The heaviest uncontradicted run through each served item so far, and its source.
  const best = new Float64Array(served.length).fill(-1);
  const bestSource = new Int32Array(served.length).fill(-1);
  const stride = served.length + 1;
  let candidates = 0;
  let extended = 0;
  let truncated = false;
  let lastNumber = -1;
  let pairsSeen = null;
  // How many places of the sources the page can print hold this markup. A source it is not seen to print (the same
  // page's copy in another language, another page's copy) does not make the markup of the page's own source common.
  const places = new Map();
  const placesOf = (seed) => {
    let count = places.get(seed);
    if (count !== undefined) return count;
    count = 0;
    const rows = prepared.seeds.get(seed) ?? [];
    for (let at = 0; at < rows.length; at += 2)
      if (!excluded?.has(rows[at]) && (tierOf ? tierOf(rows[at]) < 1 : true)) count++;
    places.set(seed, count);
    return count;
  };
  for (let j = 0; j < served.length; j++) {
    const rows = prepared.seeds.get(served[j].sig);
    if (!rows) continue;
    for (let at = 0; at < rows.length; at += 2) {
      const number = rows[at];
      if (excluded?.has(number)) continue;
      const index = rows[at + 1];
      const source = prepared.sources[number];
      // What a run through this seed can weigh at most: the literals of the source that as many served items before
      // and after it could pair with. Markup a source repeats (a static grid) would otherwise be followed along every
      // shifted diagonal; one that cannot reach the weight the same source already has here changes no answer. A run
      // that steps over other branches of a condition pairs literals further away: the window widens by those.
      if (bestSource[j] === number && source.prefix) {
        const literal = source.literal[index];
        const bound =
          source.prefix[Math.min(source.literals, literal + served.length - j + source.skippable)] -
          source.prefix[Math.max(0, literal - j - source.skippable)];
        if (bound < best[j] - 1e-9) continue;
      }
      if (number !== lastNumber) {
        lastNumber = number;
        pairsSeen = seen.get(number);
        if (!pairsSeen) {
          pairsSeen = new Set();
          seen.set(number, pairsSeen);
        }
      }
      if (pairsSeen.has(index * stride + j)) continue;
      if (++candidates > MAX_CANDIDATES * 50 || extended > MAX_PAIRS) {
        truncated = true;
        break;
      }
      const { pairs, contradicted } = extendRun(source, served, index, j);
      extended += pairs.length;
      let weight = 0;
      let unique = false;
      for (const [i, k] of pairs) {
        pairsSeen.add(i * stride + k);
        weight += source.items[i].weight;
        const item = source.items[i];
        const seed = item.sig ?? item.seed;
        if (seed && placesOf(seed) === 1) unique = true;
      }
      // A long sequence names its source. A short one does only when nothing else in the export holds it, the page
      // is known to print that source, and the document does not go on differently from the source right beside it:
      // short markup that merely looks the same (a link of the header inside a menu, the portal's own breadcrumb) is
      // not that source's.
      const sole = unique && weight >= UNIQUE_WEIGHT && !contradicted && (tierOf ? tierOf(number) < 1 : true);
      if (weight < STRONG_WEIGHT && !sole) continue;
      runs.push({
        source: number,
        pairs,
        weight,
        contradicted,
        servedStart: pairs[0][1],
        servedEnd: pairs.at(-1)[1],
      });
      if (!contradicted)
        for (const [, k] of pairs)
          if (weight > best[k]) {
            best[k] = weight;
            bestSource[k] = number;
          }
    }
    if (truncated) break;
  }
  return { runs, truncated };
}

const producing = (gap) => gap.liquid.filter((token) => !token.silent);

// Where the source's own tags stand in the served document: every start tag it won, and the end tag of that element
// when the source closes it itself (the served element then ends where the source says).
function placements(prepared, served, winners) {
  const bySource = new Map();
  for (let j = 0; j < served.length; j++) {
    const winner = winners[j];
    if (!winner || winner.rivals.length) continue;
    if (!bySource.has(winner.source)) bySource.set(winner.source, []);
    const list = bySource.get(winner.source);
    list.push({ src: winner.item, resp: j });
    const sourceClose = prepared.sources[winner.source].items[winner.item].close;
    const servedClose = served[j].close;
    if (sourceClose !== undefined && servedClose !== undefined) list.push({ src: sourceClose, resp: servedClose });
  }
  for (const list of bySource.values()) list.sort((a, b) => a.resp - b.resp);
  return bySource;
}

// Literal start tags of a source between two of its placements that no token sequence could place on their own: a
// bare `<li>` in a loop, an `<h1>` around an output. Inside the served range between the two placements such a tag
// can only stand at the element depth the source gives it. Outside a loop the source writes it once, so it is placed
// only when exactly one served tag fits.
function placeBetween(source, number, served, winners, before, after, weak) {
  const { items } = source;
  const anchor = served[before.resp];
  const base = anchor.depth + (anchor.t === 'start' && !VOID.has(anchor.name) ? 1 : 0);
  const placed = new Set();
  for (let j = before.resp + 1; j < after.resp; j++) if (winners[j]?.source === number) placed.add(winners[j].item);
  const place = (index, wanted, repeated) => {
    const item = items[index];
    if (!repeated && placed.has(index)) return;
    const found = [];
    for (let j = before.resp + 1; j < after.resp; j++) {
      const candidate = served[j];
      if (candidate.t === 'start' && !winners[j] && candidate.depth === wanted && sameItem(item, candidate))
        found.push(j);
    }
    if (!found.length || (!repeated && found.length > 1)) return;
    for (const j of found) {
      weak[j] ??= [];
      weak[j].push({ source: number, item: index, weight: item.weight });
    }
  };
  // The start tags of items[from, to) with their element depth, starting at `depth`.
  /* NOSONAR: one walk that carries element depth and loop depth across the items and places tags as it goes */ function walk(
    from,
    to,
    depth,
    repeated,
    visit,
    dry = false,
  ) {
    let loops = repeated ? 1 : 0;
    for (let index = from; index < to; index++) {
      const item = items[index];
      if (item.t === 'gap') {
        for (const token of item.liquid) {
          if (LOOP_TAGS.has(token.name)) loops++;
          else if (token.name === 'endfor' || token.name === 'endtablerow') loops = Math.max(0, loops - 1);
        }
        visit?.(index, depth);
        continue;
      }
      if (item.t === 'end') depth--;
      else if (item.t === 'start') {
        if (!dry) place(index, base + depth, loops > 0);
        if (!VOID.has(item.name)) depth++;
      }
    }
    return depth;
  }
  if (after.src <= before.src) {
    // The second place stands earlier in the source than the first: a later item of a loop whose body holds both. Its
    // body is written again from where the first place's item ends, at the depth the loop closes at.
    for (const loop of source.loops)
      if (loop.open < after.src && before.src < loop.close)
        walk(loop.open + 1, loop.close, walk(before.src + 1, loop.close, 0, false, null, true), true);
    return;
  }
  walk(before.src + 1, after.src, 0, false, (index, depth) => {
    // A loop that opened before this range and closes in it: its body is written once more per further item, at the
    // depth the closing tag stands at.
    for (const loop of source.loops)
      if (loop.close === index && loop.open <= before.src) walk(loop.open + 1, loop.close, depth, true);
  });
}

/**
 * The literal start tag of `entry` that served tag `j` is, when the whole served stretch [from, to] is what a reference
 * printed of that source: the only tag of the source that fits, at the element depth it stands at in the source, and
 * no other free tag of the stretch fits it. -1 otherwise.
 */
function fitWithin(entry, served, winners, j, from, to) {
  const base = served[from].depth;
  const fits = (item, candidate) =>
    candidate.t === 'start' && candidate.depth === base + item.level && sameItem(item, candidate);
  let found = -1;
  for (let index = 0; index < entry.items.length; index++) {
    const item = entry.items[index];
    if (item.t !== 'start' || !fits(item, served[j])) continue;
    if (found >= 0) return -1;
    found = index;
  }
  if (found < 0) return -1;
  for (let k = from; k <= to; k++) if (k !== j && !winners[k] && fits(entry.items[found], served[k])) return -1;
  return found;
}

// Liquid tags that write nothing and decide nothing about what follows them.
const INERT_TAGS = new Set(['assign', 'comment', 'raw', 'endraw']);
const inertGap = (gap) =>
  !gap.inText && gap.liquid.every((token) => token.kind === 'tag' && INERT_TAGS.has(token.name));
// Liquid tags that only decide whether and how often the literals around them are written.
const DECIDING_TAGS = new Set([
  ...INERT_TAGS,
  'if',
  'elsif',
  'else',
  'endif',
  'unless',
  'endunless',
  'case',
  'when',
  'endcase',
  'for',
  'endfor',
]);
const decidingGap = (gap) =>
  !gap.inText && gap.liquid.every((token) => token.kind === 'tag' && DECIDING_TAGS.has(token.name));

/**
 * Where a source and the served document disagree in markup the source spells out. Between two tags of a source that
 * stand in the document, with no Liquid code in between that prints or decides, the document must hold exactly what
 * the source holds; the same goes for what the source holds before its first and after its last tag found. Anything
 * else means the document was rendered from another version of that source.
 *
 * Tags found equal on the way that no rule had placed yet are placed (`winners` is filled in).
 * @returns {Array<{source:number, kind:'served-only'|'local-only'|'changed', region:{start:number,end:number},
 *   servedFrom:number, servedTo:number, served:{start:number,end:number}, open?:boolean, exact?:boolean}>}
 *   `servedFrom..servedTo` are served item numbers (empty when to < from). `open` marks a place where Liquid code
 *   stands between the two tags: the two sides cannot be laid over one another. `exact` (with `open`): the served
 *   side is exactly what no literal of that stretch of the source is.
 */
// The literal items of [i, i2], when the only Liquid code there decides (conditions, loops); null otherwise.
function decidingLiterals(items, i, i2) {
  const literals = [];
  for (let at = i; at <= i2; at++) {
    const item = items[at];
    if (item.t === 'gap') {
      if (!decidingGap(item)) return null;
    } else literals.push(item);
  }
  return literals;
}

// A difference with items on both sides changed them; with items on one side only, that side alone holds them.
function differenceKind(local, there) {
  if (local && there) return 'changed';
  return local ? 'local-only' : 'served-only';
}

// The places each source is compared from: the start tags it won alone, by source, and the end tags of elements it
// writes without Liquid code inside.
function comparePlaces(prepared, served, winners) {
  const bySource = new Map();
  for (let j = 0; j < served.length; j++) {
    const winner = winners[j];
    // A tag the source holds in several identical places names no place to compare from; nor does one of a capture
    // body, whose text the page may show changed.
    if (!winner || winner.rivals.length || winner.uncertain) continue;
    if (prepared.sources[winner.source].items[winner.item].captured) continue;
    if (!bySource.has(winner.source)) bySource.set(winner.source, []);
    // Only a start tag found is a place to compare from: where its element ends in the document is not what the
    // source says when Liquid code inside it stopped short.
    bySource.get(winner.source).push({ src: winner.item, resp: j });
  }
  // An element the source writes without any Liquid code inside ends in the document where the source ends it: its
  // end tag is a place to compare from as well.
  for (const [number, list] of bySource) addEndPlaces(prepared.sources[number].items, served, list);
  return bySource;
}

// Appends to `list` the end tag of each start tag in it whose element the source writes without Liquid code inside.
function addEndPlaces(items, served, list) {
  const gapsBefore = new Array(items.length + 1).fill(0);
  for (let index = 0; index < items.length; index++)
    gapsBefore[index + 1] = gapsBefore[index] + (items[index].t === 'gap' && !inertGap(items[index]) ? 1 : 0);
  // The start tags found so far: the loop appends end tags to the list.
  const starts = list.slice();
  for (const { src, resp } of starts) {
    const close = items[src].close;
    const servedClose = served[resp].close;
    if (close === undefined || servedClose === undefined || gapsBefore[close] !== gapsBefore[src]) continue;
    list.push({ src: close, resp: servedClose });
  }
}

function literalDifferences(prepared, served, winners) {
  const differences = [];
  const bySource = comparePlaces(prepared, served, winners);
  const offsetAfter = (j) => (j < 0 ? 0 : served[Math.min(j, served.length - 1)].end);
  for (const [number, list] of bySource) {
    list.sort((a, b) => a.resp - b.resp);
    const source = prepared.sources[number];
    const { items } = source;
    const take = (i, j) => {
      if (items[i].t === 'start' && !winners[j])
        winners[j] = { source: number, item: i, weight: items[i].weight, rivals: [], bracketed: true };
    };
    const report = (i, i2, j, j2, open, exact = false) => {
      // Local items [i, i2] against served items [j, j2]; either side may be empty.
      const local = i <= i2;
      const there = j <= j2;
      if (!local && !there) return;
      // End tags alone: the portal closes an element a template leaves open, and drops an end tag that closes nothing.
      // That is the portal tidying the markup, not another version of the source.
      const ends = (list, from, to) => {
        for (let at = from; at <= to; at++) if (list[at].t !== 'end') return false;
        return true;
      };
      if ((!local || ends(items, i, i2)) && (!there || ends(served, j, j2))) return;
      const region = local
        ? { start: items[i].start, end: items[i2].end }
        : { start: i > 0 ? items[i - 1].end : 0, end: i > 0 ? items[i - 1].end : 0 };
      differences.push({
        source: number,
        kind: differenceKind(local, there),
        region,
        servedFrom: j,
        servedTo: j2,
        served: there
          ? { start: served[j].start, end: served[j2].end }
          : { start: offsetAfter(j - 1), end: offsetAfter(j - 1) },
        ...(open ? { open: true } : {}),
        ...(exact ? { exact: true } : {}),
      });
    };
    // Served items [from, to] that are none of the literals of source items [i, i2], when the only Liquid code there
    // decides (conditions, loops) and writes nothing of its own. Returns whether any was found.
    const foreign = (i, i2, from, to) => {
      const literals = decidingLiterals(items, i, i2);
      if (!literals?.length || (to - from + 1) * literals.length > 200_000) return false;
      let found = false;
      let start = -1;
      for (let k = from; k <= to + 1; k++) {
        const known = k <= to && literals.some((literal) => sameItem(literal, served[k]));
        if (k <= to && !known) {
          if (start < 0) start = k;
          continue;
        }
        if (start >= 0) {
          report(i, i2, start, k - 1, true, true);
          found = true;
          start = -1;
        }
      }
      return found;
    };
    // The literal source items of [i, i2] and the served items [j, j2] that stand for one another, in order: the
    // longest sequence common to both. Null when the two are too long to compare.
    /* NOSONAR: one longest-common-subsequence table filled and walked back in place; the walk reads the table and equality marks the fill writes */ function common(
      i,
      i2,
      j,
      j2,
    ) {
      const local = [];
      for (let at = i; at <= i2; at++) if (items[at].t !== 'gap') local.push(at);
      const n = local.length;
      const m = j2 - j + 1;
      if (n * m > 250_000) return null;
      const pairs = [];
      if (n > 0 && m > 0) {
        const width = m + 1;
        const table = new Uint32Array((n + 1) * width);
        const same = new Uint8Array(n * m);
        for (let a = n - 1; a >= 0; a--)
          for (let b = m - 1; b >= 0; b--) {
            const equal = sameItem(items[local[a]], served[j + b]);
            if (equal) same[a * m + b] = 1;
            table[a * width + b] = equal
              ? table[(a + 1) * width + b + 1] + 1
              : Math.max(table[(a + 1) * width + b], table[a * width + b + 1]);
          }
        let a = 0;
        let b = 0;
        while (a < n && b < m) {
          if (same[a * m + b] && table[a * width + b] === table[(a + 1) * width + b + 1] + 1) pairs.push([a++, b++]);
          else if (table[(a + 1) * width + b] >= table[a * width + b + 1]) a++;
          else b++;
        }
      }
      return { local, pairs };
    }
    // What is left on either side between two items that stand for one another is one difference. `from` skips the
    // pairs before it; local items [i, i2] and served items [j, j2] are the whole stretch.
    const between = (found, i2, j, j2, from = 0) => {
      const { local, pairs } = found;
      let a = from > 0 ? pairs[from - 1][0] : -1;
      let b = from > 0 ? pairs[from - 1][1] : -1;
      for (let index = from; index <= pairs.length; index++) {
        const [nextA, nextB] = index < pairs.length ? pairs[index] : [local.length, j2 - j + 1];
        if (index < pairs.length) take(local[nextA], j + nextB);
        const localFrom = a + 1 < local.length ? local[a + 1] : i2 + 1;
        const localTo = nextA - 1 >= a + 1 ? local[nextA - 1] : localFrom - 1;
        report(localFrom, localTo, j + b + 1, j + nextB - 1, false);
        a = nextA;
        b = nextB;
      }
    };
    const weighty = (found) =>
      found.pairs.some(([a]) => {
        const item = items[found.local[a]];
        return (
          (item.t === 'start' && (item.attrs.length > 0 || item.patterns.length > 0)) ||
          (item.t === 'text' && item.norm.length >= 3)
        );
      });
    // One stretch: source items (fromSrc, toSrc) against served items (fromResp, toResp), bounds excluded.
    /* NOSONAR: forward walk, backward walk and difference steps share the cursors i, j, i2, j2 and the blocked/shared state */ function compare(
      fromSrc,
      toSrc,
      fromResp,
      toResp,
      forward,
      backward,
    ) {
      let i = fromSrc + 1;
      let j = fromResp + 1;
      let blocked = false;
      // A text the source continues with Liquid code: the served text node holds what follows that code too.
      let shared = 0;
      if (forward)
        while (i < toSrc) {
          const item = items[i];
          if (item.t === 'gap') {
            if (!inertGap(item)) {
              blocked = true;
              break;
            }
            i++;
            continue;
          }
          if (j >= toResp || !sameItem(item, served[j])) break;
          take(i, j);
          shared = item.openEnd ? 1 : 0;
          i++;
          j++;
        }
      if (forward && i >= toSrc && (j >= toResp || !backward)) return;
      let i2 = toSrc - 1;
      let j2 = toResp - 1;
      let blockedBack = false;
      const floor = forward ? i : fromSrc + 1;
      const sharedBefore = blocked ? shared : 0;
      const floorResp = forward ? j - sharedBefore : fromResp + 1;
      if (backward)
        while (i2 >= floor) {
          const item = items[i2];
          if (item.t === 'gap') {
            if (!inertGap(item)) {
              blockedBack = true;
              break;
            }
            i2--;
            continue;
          }
          if (j2 < floorResp || !sameItem(item, served[j2])) break;
          take(i2, j2);
          i2--;
          j2--;
        }
      if (forward && backward) {
        // Both walks may stop at a literal that differs while Liquid code that prints or decides still stands
        // between where they stopped: the two sides cannot be laid over one another there.
        let code = false;
        for (let at = i; at <= i2 && !code; at++) code = items[at].t === 'gap' && !inertGap(items[at]);
        if (!blocked && !blockedBack && !code) {
          // No Liquid code in between: what the two sides do not have in common is the difference.
          const found = common(i, i2, j, j2);
          if (found) between(found, i2, j, j2);
          else report(i, i2, j, j2, false);
          return;
        }
        // Liquid code stands somewhere in between. When it only decides, whatever the document holds there is one of
        // the literals the source has there; anything else was written by another version of the source.
        if (i <= i2 && foreign(i, i2, j - (blocked ? shared : 0), j2)) return;
        // Literal items before it that the document does not continue with, and literal items after it that the
        // document does not end with, differ; where they end is not shown.
        if (!blocked) {
          let last = i;
          while (last + 1 < toSrc && items[last + 1].t !== 'gap') last++;
          report(i, last, j, Math.min(j, toResp - 1), true);
        }
        if (!blockedBack && i2 >= floor) {
          let first = i2;
          while (first - 1 > fromSrc && items[first - 1].t !== 'gap') first--;
          report(first, i2, Math.max(j2, floorResp), j2, true);
        }
        return;
      }
      // What the source holds after its last tag found, up to its end or its next Liquid code. Where that ends in the
      // document is not marked by a tag found: the items next to the last tag are compared as far as the source goes.
      if (forward && !blocked && i < toSrc) {
        let last = i;
        while (last + 1 < toSrc && items[last + 1].t !== 'gap') last++;
        const reach = Math.min(toResp - 1, j + (last - i + 1) + 12);
        const found = j <= reach ? common(i, last, j, reach) : null;
        if (found?.pairs.length && weighty(found)) {
          // Up to the last item both sides have, the two are compared; what the source holds after it is not there.
          const [lastA, lastB] = found.pairs.at(-1);
          const kept = { local: found.local.slice(0, lastA + 1), pairs: found.pairs };
          between(kept, found.local[lastA], j, j + lastB);
          if (lastA + 1 < found.local.length) report(found.local[lastA + 1], last, j + lastB + 1, j + lastB, true);
        } else report(i, last, j, j < toResp ? j : j - 1, true);
      }
      // The same for what the source holds before its first tag found.
      if (backward && !blockedBack && i2 >= floor) {
        let first = i2;
        while (first - 1 > fromSrc && items[first - 1].t !== 'gap') first--;
        const reach = Math.max(floorResp, j2 - (i2 - first + 1) - 12);
        const found = reach <= j2 ? common(first, i2, reach, j2) : null;
        if (found?.pairs.length && weighty(found)) {
          const [firstA, firstB] = found.pairs[0];
          const kept = {
            local: found.local.slice(firstA),
            pairs: found.pairs.map(([a, b]) => [a - firstA, b - firstB]),
          };
          between(kept, i2, reach + firstB, j2);
          if (firstA > 0) report(first, found.local[firstA - 1], reach + firstB, reach + firstB - 1, true);
        } else report(first, i2, j2 >= floorResp ? j2 : j2 + 1, j2, true);
      }
    }
    // What the source holds before its first tag found, and after its last.
    compare(-1, list[0].src, -1, list[0].resp, false, true);
    for (let index = 0; index + 1 < list.length; index++) {
      const before = list[index];
      const after = list[index + 1];
      if (after.src > before.src) compare(before.src, after.src, before.resp, after.resp, true, true);
    }
    const last = list.at(-1);
    compare(last.src, items.length, last.resp, served.length, true, false);
  }
  return differences;
}

/**
 * @param {string} html the document as it will be served
 * @param {ReturnType<typeof prepareAlignment>} prepared
 * @param {{resolve?: (token: object, source: object) => string|null, tiers?: Map<string, number>,
 *   exclude?: Iterable<string>}} [options]
 *   `resolve` names the source a Liquid token prints (an include, a snippet, the page copy), by source id, when the
 *   export says so. `tiers` ranks sources for this request (0: the requested page's own); a lower tier wins a tie.
 *   `exclude` leaves sources out by id (the working copy of a file whose other version is being compared).
 */
/* NOSONAR: the alignment stages hand the shared winners array from one to the next, and the binding loop shares its bracket cursor and open list */ export function alignResponse(
  html,
  prepared,
  { resolve = null, tiers = null, exclude = null } = {},
) {
  const served = responseItems(html);
  let excluded = null;
  if (exclude)
    for (const id of exclude) {
      const number = prepared.byId?.get(id)?.number ?? prepared.sources.findIndex((entry) => entry.id === id);
      if (number >= 0) {
        excluded ??= new Set();
        excluded.add(number);
      }
    }
  const { runs, truncated } = collectRuns(
    prepared,
    served,
    excluded,
    (number) => tiers?.get(prepared.sources[number].id) ?? prepared.sources[number].tier,
  );
  /** @type {Array<Array<{source:number,item:number,weight:number}>>} */
  const claims = new Array(served.length);
  for (const run of runs)
    for (const [i, j] of run.pairs) {
      if (served[j].t !== 'start') continue;
      claims[j] ??= [];
      claims[j].push({ source: run.source, item: i, weight: run.weight, contradicted: run.contradicted });
    }
  const winners = new Array(served.length);
  const tierOf = (row) => tiers?.get(prepared.sources[row.source].id) ?? prepared.sources[row.source].tier;
  for (let j = 0; j < served.length; j++) {
    const rows = claims[j];
    if (!rows) continue;
    // A source the page is seen to print comes before one it is not (another page's copy, a template out of reach):
    // the page's own file stays the answer where its deployed version differs and a look-alike elsewhere matches a
    // longer stretch. Among those, the longest matching token sequence around a tag explains it best; a source of the
    // requested page wins a tie.
    const reach = (row) => (tierOf(row) < 1 ? 0 : 1);
    // A sequence the document goes on from as the source does comes before one it does not: of two places that hold
    // the same markup (a caret in a menu and in another menu), the one whose surroundings fit is the place.
    const better = (row, than) => {
      if (reach(row) !== reach(than)) return reach(row) < reach(than);
      if (row.contradicted !== than.contradicted) return !row.contradicted;
      if (Math.abs(row.weight - than.weight) > 1e-9) return row.weight > than.weight;
      return tierOf(row) < tierOf(than);
    };
    let best = rows[0];
    for (const row of rows) if (better(row, best)) best = row;
    const rivals = new Set();
    const twins = new Set();
    for (const row of rows) {
      if (reach(row) !== reach(best) || row.contradicted !== best.contradicted || row.weight < best.weight - 1e-9)
        continue;
      if (row.source === best.source) twins.add(row.item);
      else if (tierOf(row) === tierOf(best)) rivals.add(row.source);
    }
    winners[j] = { ...best, rivals: [...rivals] };
    if (twins.size > 1) winners[j].twins = [...twins].sort((a, b) => a - b);
  }
  // One source holds the same markup in several places and the page shows it: the places are taken in the order the
  // source has them, once round per repetition. When the page shows fewer or more of them than whole rounds (one
  // branch of several was rendered), which place a served tag is cannot be told: the file is known, the line is not.
  const repeated = new Map();
  for (let j = 0; j < served.length; j++) {
    const winner = winners[j];
    if (!winner?.twins || winner.rivals.length) continue;
    const key = winner.source + ':' + winner.twins.join(',');
    if (!repeated.has(key)) repeated.set(key, []);
    repeated.get(key).push(j);
  }
  for (const positions of repeated.values()) {
    const { twins } = winners[positions[0]];
    const whole = positions.length % twins.length === 0;
    positions.forEach((j, order) => {
      if (whole) winners[j].item = twins[order % twins.length];
      else winners[j].uncertain = twins.length;
    });
  }

  for (let pass = 0; pass < 4; pass++) {
    const weak = new Array(served.length);
    // Places found across a later item of a loop count only where places in source order found none: the whole body
    // of the loop is laid over that stretch, and several of its tags may fit one served tag.
    const across = new Array(served.length);
    for (const [number, list] of placements(prepared, served, winners)) {
      const source = prepared.sources[number];
      for (let index = 0; index + 1 < list.length; index++) {
        const before = list[index];
        const after = list[index + 1];
        if (after.src !== before.src + 1 && after.src !== before.src && after.resp > before.resp + 1)
          placeBetween(source, number, served, winners, before, after, after.src > before.src ? weak : across);
      }
    }
    let added = 0;
    for (let j = 0; j < served.length; j++) {
      const rows = weak[j] ?? across[j];
      if (!rows || winners[j]) continue;
      const first = rows[0];
      // Two sources that would both put a bare tag here: neither is shown to have written it.
      if (rows.some((row) => row.source !== first.source || row.item !== first.item)) continue;
      winners[j] = { ...first, rivals: [], bracketed: true };
      added++;
    }
    if (!added) break;
  }

  // A script or style element no markup source wrote, whose text is a custom JavaScript or CSS field of the export
  // (with whatever its Liquid code printed in between): the portal wrote the element to carry that field.
  const carriers = new Map();
  if (prepared.raw?.length)
    for (let j = 0; j + 1 < served.length; j++) {
      const tag = served[j];
      const body = served[j + 1];
      if (tag.t !== 'start' || winners[j] || body.t !== 'text' || !body.raw) continue;
      let best = null;
      for (const raw of prepared.raw) {
        if (raw.tag !== tag.name || !rawTextMatches(body.norm, raw)) continue;
        const tier = tiers?.get(raw.id) ?? raw.tier;
        if (!best || tier < best.tier) best = { tier, ids: [raw.id], length: raw.length };
        else if (tier === best.tier && !best.ids.includes(raw.id)) best.ids.push(raw.id);
      }
      if (best) carriers.set(j, best);
    }

  // Text of a script the source holds literally, line for line: code it runs can be followed to the file.
  const scriptIntervals = [];
  for (let j = 0; j + 1 < served.length; j++) {
    const winner = winners[j];
    const body = served[j + 1];
    if (!winner || winner.rivals.length || served[j].name !== 'script' || body.t !== 'text' || !body.raw) continue;
    const source = prepared.sources[winner.source];
    const item = source.items[winner.item + 1];
    if (item?.t !== 'text' || !item.sig || !sameItem(item, body)) continue;
    literalLines(html, body, source.text, item, source.id, scriptIntervals);
  }

  // Comparing places tags that no sequence had placed (a tag both sides hold between two differences); those are
  // places to compare from in turn, until a round finds no more.
  let differences = [];
  for (let round = 0; round < 4; round++) {
    const placed = winners.reduce((count, winner) => count + (winner ? 1 : 0), 0);
    differences = literalDifferences(prepared, served, winners);
    if (winners.reduce((count, winner) => count + (winner ? 1 : 0), 0) === placed) break;
  }

  // Liquid code of a source between two consecutive placements of it: what the served document holds between those
  // two places was written by that code (or by what it includes).
  const brackets = [];
  // What the served document holds where the local source holds something else, or nothing: the deployed copy of
  // that source differs from the local one there.
  for (const difference of differences)
    if (difference.servedTo >= difference.servedFrom && (!difference.open || difference.exact))
      brackets.push({
        source: difference.source,
        servedStart: difference.servedFrom,
        servedEnd: difference.servedTo,
        start: difference.region.start,
        end: difference.region.end,
        tokens: [],
        drift: true,
      });
  for (const [number, list] of placements(prepared, served, winners)) {
    const source = prepared.sources[number];
    for (let index = 0; index + 1 < list.length; index++) {
      const before = list[index];
      const after = list[index + 1];
      if (after.src <= before.src || after.resp <= before.resp + 1) continue;
      const between = [];
      for (let at = before.src + 1; at < after.src; at++)
        if (source.items[at].t === 'gap') between.push(source.items[at]);
      if (!between.length) continue;
      const tokens = between.flatMap(producing);
      brackets.push({
        source: number,
        servedStart: before.resp + 1,
        servedEnd: after.resp - 1,
        start: between[0].start,
        end: between.at(-1).end,
        tokens: tokens.length ? tokens : between.flatMap((gap) => gap.liquid),
      });
    }
  }
  brackets.sort((a, b) => a.servedStart - b.servedStart || b.servedEnd - a.servedEnd);

  // Where each source placed tags of its own, in served order.
  const placedAt = new Map();
  for (let j = 0; j < served.length; j++) {
    const winner = winners[j];
    if (!winner || winner.rivals.length) continue;
    if (!placedAt.has(winner.source)) placedAt.set(winner.source, []);
    placedAt.get(winner.source).push(j);
  }
  const placedWithin = (number, from, to) => placedAt.get(number)?.some((j) => j >= from && j <= to) ?? false;
  const bindings = [];
  const counts = { aligned: 0, bracketed: 0, generated: 0, drift: 0, shell: 0, conflict: 0 };
  const open = [];
  let cursor = 0;
  // One Liquid token that prints: the region is that token. Several: everything between the two literals.
  const regionOf = (bracket) =>
    bracket.tokens.length === 1
      ? { start: bracket.tokens[0].start, end: bracket.tokens[0].end }
      : { start: bracket.start, end: bracket.end };
  for (let j = 0; j < served.length; j++) {
    while (cursor < brackets.length && brackets[cursor].servedStart <= j) open.push(brackets[cursor++]);
    for (let index = open.length - 1; index >= 0; index--) if (open[index].servedEnd < j) open.splice(index, 1);
    const item = served[j];
    if (item.t !== 'start') continue;
    const winner = winners[j];
    let carrier = winner ? null : carriers.get(j);
    // Enclosing Liquid code, innermost first.
    const enclosing = [...open].sort(
      (a, b) => a.servedEnd - a.servedStart - (b.servedEnd - b.servedStart) || b.servedStart - a.servedStart,
    );
    const contexts = [];
    for (const bracket of enclosing) {
      if (bracket.drift || (winner && bracket.source === winner.source)) continue;
      const source = prepared.sources[bracket.source];
      const region = regionOf(bracket);
      if (contexts.some((context) => context.sourceRefId === source.id && context.region.start === region.start))
        continue;
      contexts.push({ sourceRefId: source.id, region });
      if (contexts.length >= 16) break;
    }
    // Two sources hold this markup equally, inside a stretch that Liquid code of a placed source wrote: that code is
    // shown to have written it, whichever of the two it printed.
    const settled =
      winner?.rivals.length > 0 &&
      enclosing.length > 0 &&
      !enclosing[0].drift &&
      enclosing[0].source !== winner.source &&
      !winner.rivals.includes(enclosing[0].source);
    // The same for a script or style element several fields hold the text of (two forms with the same script).
    if (carrier?.ids.length > 1 && enclosing.length > 0 && !enclosing[0].drift) carrier = null;
    if (winner && !settled) {
      const source = prepared.sources[winner.source];
      const tag = source.items[winner.item];
      if (winner.rivals.length) {
        counts.conflict++;
        bindings.push({
          start: item.start,
          end: item.end,
          tag: item.name,
          mapping: 'conflict',
          sourceRefIds: [source.id, ...winner.rivals.map((number) => prepared.sources[number].id)],
          contexts,
        });
        continue;
      }
      if (winner.bracketed) counts.bracketed++;
      else counts.aligned++;
      bindings.push({
        start: item.start,
        end: item.end,
        tag: item.name,
        mapping: 'aligned',
        sourceRefId: source.id,
        region: { start: tag.start, end: tag.end },
        ...(tag.dynamic ? { dynamic: true } : {}),
        ...(winner.bracketed ? { placement: 'bracketed' } : {}),
        // The file holds this tag in several identical places and the page does not show which one this is.
        ...(winner.uncertain ? { oneOf: winner.uncertain } : {}),
        contexts,
      });
      continue;
    }
    if (carrier) {
      if (carrier.ids.length > 1) {
        counts.conflict++;
        bindings.push({
          start: item.start,
          end: item.end,
          tag: item.name,
          mapping: 'conflict',
          sourceRefIds: carrier.ids.slice(0, 8),
          contexts,
        });
      } else {
        counts.generated++;
        bindings.push({
          start: item.start,
          end: item.end,
          tag: item.name,
          mapping: 'generated',
          sourceRefId: carrier.ids[0],
          region: { start: 0, end: carrier.length },
          carrier: true,
          contexts,
        });
      }
      continue;
    }
    if (enclosing[0]?.drift) {
      const source = prepared.sources[enclosing[0].source];
      counts.drift++;
      bindings.push({
        start: item.start,
        end: item.end,
        tag: item.name,
        mapping: 'drift',
        sourceRefId: source.id,
        region: { start: enclosing[0].start, end: Math.max(enclosing[0].start, enclosing[0].end) },
        contexts: contexts.filter((context) => context.sourceRefId !== source.id),
      });
      continue;
    }
    if (enclosing.length) {
      let bracket = enclosing[0];
      let source = prepared.sources[bracket.source];
      let region = regionOf(bracket);
      const chain = contexts.filter(
        (context) => !(context.sourceRefId === source.id && context.region.start === region.start),
      );
      // Follow a single include / snippet / page-copy reference into a source that placed no tag of its own here.
      // A referenced source with tags of its own in this range names those tags itself: what stands around them
      // (the wrapper an editable tag writes) was written by the reference, not by code inside the referenced source.
      const { servedStart, servedEnd } = bracket;
      let literal = null;
      for (let depth = 0; resolve && depth < 8 && bracket.tokens.length === 1; depth++) {
        const id = resolve(bracket.tokens[0], source);
        const target = id == null ? null : prepared.byId?.get(id);
        if (!target || target.entry === source || placedWithin(target.number, servedStart, servedEnd)) break;
        // Everything in this stretch is what the reference printed: a literal tag of the printed source that alone
        // fits this tag, at the element depth the source gives it, is that tag.
        const fit = fitWithin(target.entry, served, winners, j, servedStart, servedEnd);
        if (fit >= 0) {
          chain.unshift({ sourceRefId: source.id, region });
          literal = { entry: target.entry, item: target.entry.items[fit] };
          break;
        }
        const inner = target.entry.liquid.filter((token) => !token.silent);
        if (!inner.length) break;
        chain.unshift({ sourceRefId: source.id, region });
        source = target.entry;
        region =
          inner.length === 1
            ? { start: inner[0].start, end: inner[0].end }
            : { start: 0, end: target.entry.text.length };
        bracket = { tokens: inner, start: region.start, end: region.end };
      }
      if (literal) {
        counts.bracketed++;
        bindings.push({
          start: item.start,
          end: item.end,
          tag: item.name,
          mapping: 'aligned',
          sourceRefId: literal.entry.id,
          region: { start: literal.item.start, end: literal.item.end },
          ...(literal.item.dynamic ? { dynamic: true } : {}),
          placement: 'bracketed',
          contexts: chain,
        });
        continue;
      }
      counts.generated++;
      bindings.push({
        start: item.start,
        end: item.end,
        tag: item.name,
        mapping: 'generated',
        sourceRefId: source.id,
        region,
        liquid: bracket.tokens.slice(0, 4).map((token) => ({ kind: token.kind, name: token.name })),
        contexts: chain,
      });
      continue;
    }
    counts.shell++;
    bindings.push({ start: item.start, end: item.end, tag: item.name, mapping: 'shell', contexts: [] });
  }
  const coverage = [];
  const matchedBySource = new Map();
  for (let j = 0; j < served.length; j++) {
    const winner = winners[j];
    if (!winner || winner.rivals.length) continue;
    if (!matchedBySource.has(winner.source)) matchedBySource.set(winner.source, new Set());
    matchedBySource.get(winner.source).add(winner.item);
  }
  for (const [number, matched] of matchedBySource) {
    const source = prepared.sources[number];
    coverage.push({
      sourceRefId: source.id,
      startTags: source.items.filter((item) => item.t === 'start').length,
      matched: matched.size,
      // A tag at the source's own top level stands on the page: the source's outer markup is there, not only
      // markup from inside it. An unrooted source still names the tags it matched: its outer element may be what
      // the deployed version changed (a built-in template the portal updated), which the page cannot tell apart from
      // the same inner lines written by something else.
      rooted: [...matched].some((item) => source.items[item].level === 0),
    });
  }
  return {
    bindings,
    counts,
    coverage,
    truncated,
    items: served.length,
    scriptIntervals,
    differences: differences.map((difference) => ({
      sourceRefId: prepared.sources[difference.source].id,
      kind: difference.kind,
      region: difference.region,
      served: difference.served,
      ...(difference.open ? { open: true } : {}),
      ...(difference.exact ? { exact: true } : {}),
    })),
  };
}

// The text of a script or style element against a custom JavaScript or CSS field: every literal piece of the field
// stands in the element, in order, from its first character to its last unless Liquid code stands there.
function rawTextMatches(norm, raw) {
  if (!raw.dynamic) return norm === raw.pieces[0];
  let at = 0;
  for (let index = 0; index < raw.pieces.length; index++) {
    const piece = raw.pieces[index];
    if (index === 0 && !raw.openStart) {
      if (!norm.startsWith(piece)) return false;
      at = piece.length;
      continue;
    }
    const found = norm.indexOf(piece, at);
    if (found < 0) return false;
    at = found + piece.length;
  }
  return raw.openEnd || norm.endsWith(raw.pieces.at(-1));
}

// Lines of a served script body that are the lines of the source text, in order.
function literalLines(html, body, sourceText, item, sourceRefId, intervals) {
  const served = html.slice(body.start, body.end);
  const local = sourceText.slice(item.start, item.end);
  if (served === local) {
    intervals.push({
      start: body.start,
      end: body.end,
      sourceRefId,
      sourceSpan: { start: item.start, end: item.end },
      mapping: 'literal',
    });
    return;
  }
  const breaks = /(\r\n|\n|\r)/;
  const servedParts = served.split(breaks);
  const localParts = local.split(breaks);
  let servedAt = body.start;
  let localAt = item.start;
  let s = 0;
  let l = 0;
  const lineBreak = (part) => part === '\r\n' || part === '\n' || part === '\r';
  while (s < servedParts.length && l < localParts.length) {
    if (lineBreak(servedParts[s])) {
      servedAt += servedParts[s++].length;
      continue;
    }
    if (lineBreak(localParts[l])) {
      localAt += localParts[l++].length;
      continue;
    }
    if (servedParts[s] !== localParts[l]) return;
    if (servedParts[s])
      intervals.push({
        start: servedAt,
        end: servedAt + servedParts[s].length,
        sourceRefId,
        sourceSpan: { start: localAt, end: localAt + localParts[l].length },
        mapping: 'literal',
      });
    servedAt += servedParts[s++].length;
    localAt += localParts[l++].length;
  }
}

/** Adds the by-id lookup `alignResponse` uses to follow references between sources. */
export function indexPrepared(prepared) {
  prepared.byId = new Map(prepared.sources.map((entry, number) => [entry.id, { entry, number }]));
  return prepared;
}

// Fields of exported records that hold markup the portal prints into a page.
const MARKUP_FIELDS = {
  webtemplate: ['source'],
  contentsnippet: ['value'],
  webpage: ['copy', 'summary'],
  weblinkset: ['copy'],
  sitesetting: ['value'],
  basicform: ['instructions'],
  advancedformstep: ['instructions'],
};
// Fields that hold the text of a script or style element the portal writes for a record.
const RAW_FIELDS = {
  webpage: { customjavascript: 'script', customcss: 'style' },
  basicform: { customjavascript: 'script' },
  list: { customjavascript: 'script' },
  advancedformstep: { customjavascript: 'script' },
};
const RAW_MINIMUM = 24;
const preparedByIndex = new WeakMap();
const contextByIndex = new WeakMap();

function rawSource(source, tag) {
  const tokens = scanLiquidTokens(source.text);
  const pieces = [];
  let from = 0;
  for (const token of tokens) {
    pieces.push(source.text.slice(from, token.start));
    from = token.end;
  }
  pieces.push(source.text.slice(from));
  const normalized = pieces.map(collapse);
  const literal = normalized.filter(Boolean);
  if (literal.join('').length < RAW_MINIMUM) return null;
  return {
    id: source.id,
    tag,
    tier: source.kind === 'webpage' ? 2 : 1,
    dynamic: tokens.length > 0,
    pieces: literal,
    openStart: tokens.length > 0 && !normalized[0],
    openEnd: tokens.length > 0 && !normalized.at(-1),
    length: source.text.length,
  };
}

function preparedFor(index) {
  let prepared = preparedByIndex.get(index);
  if (prepared) return prepared;
  const sources = [];
  for (const source of index.sources.values()) {
    const field = source.fieldPath?.at(-1);
    if (source.ambiguous || !MARKUP_FIELDS[source.kind]?.includes(field)) continue;
    if (typeof source.text !== 'string' || !source.text.includes('<')) continue;
    // Only text that is the field's current content may name the field: an index entry whose revision does not
    // describe its text is left out.
    if (source.contentRevision !== createHash('sha256').update(source.text).digest('hex')) continue;
    sources.push({ id: source.id, text: source.text, name: source.name, tier: source.kind === 'webpage' ? 2 : 1 });
  }
  prepared = indexPrepared(prepareAlignment(sources));
  prepared.raw = rawSources(index);
  preparedByIndex.set(index, prepared);
  return prepared;
}

// The custom JavaScript and CSS fields of the index whose text is the field's current content.
function rawSources(index) {
  const raws = [];
  for (const source of index.sources.values()) {
    const tag = RAW_FIELDS[source.kind]?.[source.fieldPath?.at(-1)];
    if (!tag || source.ambiguous || typeof source.text !== 'string' || !source.text.trim()) continue;
    if (source.contentRevision !== createHash('sha256').update(source.text).digest('hex')) continue;
    const raw = rawSource(source, tag);
    if (raw) raws.push(raw);
  }
  return raws;
}

// The same prepared sources with a few more (the Git baseline of a changed file): the shared index is not rebuilt.
function extendPrepared(base, extra) {
  const added = prepareAlignment(extra);
  if (!added.sources.length) return base;
  const offset = base.sources.length;
  const sources = base.sources.concat(added.sources);
  const seeds = {
    get(sig) {
      const first = base.seeds.get(sig);
      const second = added.seeds.get(sig);
      if (!second) return first;
      const shifted = second.map((value, at) => (at % 2 === 0 ? value + offset : value));
      return first ? first.concat(shifted) : shifted;
    },
  };
  return indexPrepared({ sources, seeds, raw: base.raw });
}

const pageOf = (index, route) => {
  const wanted = normalizePortalPath(route);
  return (index.portal?.pages ?? []).find((page) => normalizePortalPath(page.url) === wanted) ?? null;
};

const lower = (value) => String(value ?? '').toLowerCase();

// What the export says the requested address renders: its page (the page of a marker route too: sign-in, not found)
// and the templates and snippets that page can reach. Sources the page prints come first when two sources hold the
// same markup: the page's own fields in the served language before its other language copies, those before other
// pages; a template or snippet the page reaches before one it does not; the snippet of the served language before the
// same snippet in another language.
function pageContext(index, route) {
  let cache = contextByIndex.get(index);
  if (!cache) {
    cache = new Map();
    contextByIndex.set(index, cache);
  }
  const key = normalizePortalPath(route);
  const known = cache.get(key);
  if (known) return known;
  let graph = null;
  try {
    graph = resolvePageResources(index.portal, route, { solutionMetadata: index.metadata ?? {} });
  } catch {
    graph = null;
  }
  const pages = index.portal?.pages ?? [];
  const page =
    (graph?.page?.id && pages.find((candidate) => lower(candidate.id) === lower(graph.page.id))) ||
    pageOf(index, route);
  const tiers = new Map();
  rankReachable(index, graph, tiers);
  if (page) rankPageFields(index, page, tiers);
  const context = { page, tiers };
  if (cache.size >= 128) cache.delete(cache.keys().next().value);
  cache.set(key, context);
  return context;
}

// A template or snippet the page is not seen to reach ranks 1: only a long sequence of its markup names it. When the
// page names one in a way the export does not resolve (a name held in a variable), any of them may be it: those rank
// between (0.5), behind the ones the page is seen to reach.
function unreachedRanks(graph) {
  const unresolved = graph?.unresolved ?? [];
  const beyondTemplates = unresolved.some((row) => row.kind === 'web-template' || row.kind === 'page-template')
    ? 0.5
    : 1;
  const beyondSnippets = unresolved.some((row) => row.kind === 'content-snippet' || row.kind === 'snippet') ? 0.5 : 1;
  return { beyondTemplates, beyondSnippets };
}

// The rank of every template and snippet of the index for a page whose resource graph is `graph` (null: unknown).
function rankReachable(index, graph, tiers) {
  const templates = graph ? new Set((graph.webTemplates ?? []).map((row) => lower(row.id)).filter(Boolean)) : null;
  const snippets = graph ? new Set((graph.snippets ?? []).map((row) => lower(row.name))) : null;
  const { beyondTemplates, beyondSnippets } = unreachedRanks(graph);
  for (const source of index.sources.values()) {
    if (source.kind === 'webtemplate')
      tiers.set(source.id, !templates || templates.has(lower(source.recordId)) ? 0 : beyondTemplates);
    else if (source.kind === 'contentsnippet') {
      const served = index.snippets?.get(lower(source.name))?.id === source.id;
      tiers.set(source.id, (!snippets || snippets.has(lower(source.name)) ? 0 : beyondSnippets) + (served ? 0 : 1));
    }
  }
}

// The page's own fields rank 0, the fields of its other language copies 1.
function rankPageFields(index, page, tiers) {
  const fields = [...MARKUP_FIELDS.webpage, ...Object.keys(RAW_FIELDS.webpage)];
  for (const variant of [page, ...Object.values(page.translations ?? {})])
    for (const field of fields) {
      const ref = index.source(variant.metadata ?? page.metadata, field);
      if (ref) tiers.set(ref.id, 1);
    }
  for (const field of fields) {
    const ref = index.source(page.metadata, field);
    if (ref) tiers.set(ref.id, 0);
  }
}

const quoted = `(?:'([^']*)'|"([^"]*)")`;
const INCLUDE = new RegExp(String.raw`^(?:include|render)\s+${quoted}`, 'i');
const SNIPPET_NAME = new RegExp(String.raw`\bsnippet_name\s*:\s*${quoted}`, 'i');
const EDITABLE_SNIPPET = new RegExp(String.raw`^editable\s+snippets?\s+${quoted}`, 'i');
const EDITABLE_PAGE = new RegExp(String.raw`^editable\s+page\s+${quoted}`, 'i');
const SNIPPET_OUTPUT = new RegExp(String.raw`^snippets?\s*(?:\[\s*${quoted}\s*\]|\.([\w-]+))`, 'i');
const PAGE_OUTPUT = /^page\.(?:adx_)?(copy|summary)\b/i;

// The source a single Liquid token prints, when the export names it literally.
function referenceResolver(index, page) {
  const pageField = (field) => (page ? (index.source(page.metadata, field)?.id ?? null) : null);
  const snippet = (name) => index.snippets?.get(String(name).toLowerCase())?.id ?? null;
  const tagReference = (body) => {
    const include = INCLUDE.exec(body);
    if (include) {
      const name = (include[1] ?? include[2]).trim().toLowerCase();
      if (name === 'page_copy' || name === 'page copy') return pageField('copy');
      if (name === 'snippet') {
        const named = SNIPPET_NAME.exec(body);
        return named ? snippet(named[1] ?? named[2]) : null;
      }
      return index.templates?.get(name)?.id ?? null;
    }
    const editableSnippet = EDITABLE_SNIPPET.exec(body);
    if (editableSnippet) return snippet(editableSnippet[1] ?? editableSnippet[2]);
    const editablePage = EDITABLE_PAGE.exec(body);
    if (editablePage) {
      const field = (editablePage[1] ?? editablePage[2]).replace(/^(?:adx|mspp)_/i, '').toLowerCase();
      return ['copy', 'summary'].includes(field) ? pageField(field) : null;
    }
    return null;
  };
  return (token) => {
    const body = token.body ?? '';
    if (token.kind === 'tag') return tagReference(body);
    const snippetOutput = SNIPPET_OUTPUT.exec(body);
    if (snippetOutput) return snippet(snippetOutput[1] ?? snippetOutput[2] ?? snippetOutput[3]);
    const pageOutput = PAGE_OUTPUT.exec(body);
    if (pageOutput) return pageField(pageOutput[1].toLowerCase());
    return null;
  };
}

/**
 * Aligns a served document with the sources of an imported portal (the index of lense/source-inspection.mjs).
 * @param {string} html the document as it will be served
 * @param {object} index portal source index: `sources`, `portal`, `templates`, `snippets`, `source(record, field)`
 * @param {string} route path of the request without a language prefix
 * @param {{extra?: Array<{id:string, text:string, like?:string}>, exclude?: Iterable<string>}} [options] `extra`
 *   adds sources for this call only (the Git baseline of a changed file); `like` names the index source whose rank
 *   the extra source takes. `exclude` leaves index sources out by id.
 * @returns {{byStart: Map<number, object>, counts: object, coverage: object[], truncated: boolean,
 *   scriptIntervals: object[], differences: object[]}}
 */
export function alignDocument(html, index, route, { extra = [], exclude = null } = {}) {
  const base = preparedFor(index);
  const { page, tiers } = pageContext(index, route);
  let prepared = base;
  let ranks = tiers;
  if (extra.length) {
    prepared = extendPrepared(base, extra);
    ranks = new Map(tiers);
    for (const source of extra) ranks.set(source.id, tiers.get(source.like) ?? 1);
  }
  const result = alignResponse(html, prepared, { tiers: ranks, resolve: referenceResolver(index, page), exclude });
  const byStart = new Map();
  for (const binding of result.bindings) byStart.set(binding.start, binding);
  return {
    byStart,
    counts: result.counts,
    coverage: result.coverage,
    truncated: result.truncated,
    scriptIntervals: result.scriptIntervals,
    differences: result.differences,
  };
}
