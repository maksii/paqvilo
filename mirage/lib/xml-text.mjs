/** Decode exported XML text with a linear CDATA scan, including malformed input. */
export function decodeXml(value = '') {
  const text = String(value ?? '');
  const parts = [];
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf('<![CDATA[', cursor);
    if (start < 0) break;
    const end = text.indexOf(']]>', start + 9);
    if (end < 0) break;
    parts.push(text.slice(cursor, start), text.slice(start + 9, end));
    cursor = end + 3;
  }
  parts.push(text.slice(cursor));
  return parts.join('').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (match, entity) => {
    if (entity[0] !== '#') return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }[entity.toLowerCase()];
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
  });
}

const nameChar = (char) => /[\w:.-]/.test(char);
const space = (char) => /\s/.test(char);
// The first index of a needle at or after a position. A result is reused while it still lies ahead, so a scan
// whose searches move forward reads the text once even when the needle is missing.
function searcher(text, needle) {
  let searchedFrom = Infinity,
    found = -1;
  return (from) => {
    if (from < searchedFrom || (found !== -1 && found < from)) {
      searchedFrom = from;
      found = text.indexOf(needle, from);
    }
    return found;
  };
}

/**
 * Attribute name/raw value pairs (`name="value"` or `name='value'`) in start-tag markup, found by one linear
 * scan. Text that is not a complete quoted attribute is skipped.
 */
export function xmlAttributes(markup = '') {
  const text = String(markup),
    pairs = [],
    quoted = { '"': searcher(text, '"'), "'": searcher(text, "'") };
  let cursor = 0;
  while (cursor < text.length) {
    if (!nameChar(text[cursor])) {
      cursor++;
      continue;
    }
    const start = cursor;
    while (cursor < text.length && nameChar(text[cursor])) cursor++;
    let next = cursor;
    while (next < text.length && space(text[next])) next++;
    if (text[next] !== '=') continue;
    next++;
    while (next < text.length && space(text[next])) next++;
    const quote = text[next];
    if (quote !== '"' && quote !== "'") continue;
    const end = quoted[quote](next + 1);
    if (end < 0) continue;
    pairs.push([text.slice(start, cursor), text.slice(next + 1, end)]);
    cursor = end + 1;
  }
  return pairs;
}

/**
 * Markup tokens in document order, found by one linear scan: complete comments and processing instructions,
 * tags from `<` to the next `>`, and text runs. A `<` that starts no tag is dropped.
 */
export function xmlTokens(source = '') {
  const text = String(source),
    tokens = [],
    commentEnd = searcher(text, '-->'),
    instructionEnd = searcher(text, '?>'),
    tagEnd = searcher(text, '>');
  let cursor = 0;
  while (cursor < text.length) {
    if (text[cursor] !== '<') {
      const end = text.indexOf('<', cursor);
      const stop = end < 0 ? text.length : end;
      tokens.push(text.slice(cursor, stop));
      cursor = stop;
      continue;
    }
    const comment = text.startsWith('<!--', cursor) ? commentEnd(cursor + 4) : -1;
    if (comment >= 0) {
      tokens.push(text.slice(cursor, comment + 3));
      cursor = comment + 3;
      continue;
    }
    const instruction = text.startsWith('<?', cursor) ? instructionEnd(cursor + 2) : -1;
    if (instruction >= 0) {
      tokens.push(text.slice(cursor, instruction + 2));
      cursor = instruction + 2;
      continue;
    }
    const close = tagEnd(cursor + 1);
    if (close > cursor + 1) {
      tokens.push(text.slice(cursor, close + 1));
      cursor = close + 1;
    } else cursor++;
  }
  return tokens;
}

/** A start tag's name, attribute markup and self-closing flag, or null when the tag has no name. */
export function xmlStartTag(token) {
  let cursor = 1;
  while (cursor < token.length - 1 && nameChar(token[cursor])) cursor++;
  if (cursor === 1) return null;
  let end = token.length - 1;
  while (end > cursor && space(token[end - 1])) end--;
  const selfClosing = end > cursor && token[end - 1] === '/';
  return { name: token.slice(1, cursor), markup: token.slice(cursor, selfClosing ? end - 1 : end), selfClosing };
}
