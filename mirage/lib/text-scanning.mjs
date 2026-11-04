/**
 * Remove a trailing run of one UTF-16 code unit from a primitive string.
 * Callers pass primitive strings and a one-code-unit character; this does not
 * coerce values or trim any other whitespace.
 */
export function stripTrailingCharacter(text, character) {
  let end = text.length;
  while (end > 0 && text[end - 1] === character) end--;
  return text.slice(0, end);
}

/** Remove only a trailing run of characters named by the caller. */
export function stripTrailingCharacters(text, characters) {
  let end = text.length;
  while (end > 0 && characters.includes(text[end - 1])) end--;
  return text.slice(0, end);
}

function emailDomainEnd(text, start) {
  const domain = /[\w-]/;
  let end = start;
  while (end < text.length && domain.test(text[end])) end++;
  if (end === start) return -1;
  let matchedEnd = -1;
  while (text[end] === '.' && domain.test(text[end + 1] ?? '')) {
    end++;
    while (end < text.length && domain.test(text[end])) end++;
    matchedEnd = end;
  }
  return matchedEnd;
}

/** Matches the toolkit's ASCII email-shaped text grammar, without retrying each local-part suffix. */
export function* emailMatches(text) {
  const local = /[\w.+-]/;
  let cursor = 0;
  while (cursor < text.length) {
    if (!local.test(text[cursor])) {
      cursor++;
      continue;
    }
    const start = cursor;
    while (cursor < text.length && local.test(text[cursor])) cursor++;
    if (text[cursor] !== '@') continue;
    const matchedEnd = emailDomainEnd(text, cursor + 1);
    if (matchedEnd < 0) {
      cursor++;
      continue;
    }
    const match = [text.slice(start, matchedEnd)];
    match.index = start;
    match.input = text;
    yield match;
    cursor = matchedEnd;
  }
}

/** Replace with a literal string; these callers do not use RegExp replacement-token expansion. */
export function replaceEmails(text, replacement) {
  const parts = [];
  let cursor = 0;
  for (const match of emailMatches(text)) {
    parts.push(text.slice(cursor, match.index), replacement);
    cursor = match.index + match[0].length;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

export function trimLineEndSpaces(text) {
  const parts = [];
  let cursor = 0;
  for (let index = 0; index <= text.length; index++) {
    if (index < text.length && !'\r\n\u2028\u2029'.includes(text[index])) continue;
    let start = index;
    while (start > cursor && (text[start - 1] === ' ' || text[start - 1] === '\t')) start--;
    if (start < index) {
      parts.push(text.slice(cursor, start));
      cursor = index;
    }
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

export function normalizeSemicolonWhitespace(text) {
  const parts = text.split(';');
  return parts
    .map((part, index) => {
      if (index > 0) part = part.trimStart();
      if (index < parts.length - 1) part = part.trimEnd();
      return part;
    })
    .join(';');
}

export function replaceParenthesizedPath(text) {
  let start = 0;
  for (let end = 0; end <= text.length; end++) {
    if (end < text.length && !'\r\n\u2028\u2029'.includes(text[end])) continue;
    const line = text.slice(start, end);
    const open = line.indexOf('(');
    const slash = Math.max(line.lastIndexOf('/'), line.lastIndexOf('\\'));
    if (open >= 0 && slash > open) return text.slice(0, start + open + 1) + text.slice(start + slash + 1);
    start = end + 1;
  }
  return text;
}

/** Non-overlapping lazy delimiter alternatives and a literal replacement; every search cursor advances. */
export function replaceDelimitedAlternatives(text, pairs, replacement) {
  const next = pairs.map(([open, close, minimum = 0]) => ({ open, close, minimum, at: text.indexOf(open), end: -2 }));
  const parts = [];
  let cursor = 0;
  while (true) {
    const selected = nextDelimitedCandidate(next, text, cursor);
    if (!selected) break;
    const content = selected.at + selected.open.length;
    if (selected.end !== -1 && selected.end < content) selected.end = text.indexOf(selected.close, content);
    if (selected.end < 0) {
      selected.at = -1;
      continue;
    }
    if (selected.end - content < selected.minimum) {
      selected.at = text.indexOf(selected.open, selected.at + 1);
      continue;
    }
    parts.push(text.slice(cursor, selected.at), replacement);
    cursor = selected.end + selected.close.length;
  }
  parts.push(text.slice(cursor));
  return parts.join('');
}

function nextDelimitedCandidate(candidates, text, cursor) {
  let selected;
  for (const candidate of candidates) {
    if (candidate.at >= 0 && candidate.at < cursor) candidate.at = text.indexOf(candidate.open, cursor);
    if (candidate.at >= 0 && (!selected || candidate.at < selected.at)) selected = candidate;
  }
  return selected;
}

export function hasDelimitedText(text, open, close) {
  const start = text.indexOf(open);
  return start >= 0 && text.indexOf(close, start + open.length) >= 0;
}

/** The former line-label grammar: key characters, optional whitespace, separator and rest of line. */
export function matchNamedLine(text) {
  let end = 0;
  while (end < text.length && /[a-zA-Z _-]/.test(text[end])) end++;
  if (end === 0) return null;
  let separator = end;
  while (separator < text.length && /\s/.test(text[separator])) separator++;
  if (text[separator] !== ':' && text[separator] !== '=') return null;
  let start = separator + 1;
  while (start < text.length && /\s/.test(text[start])) start++;
  const rest = /^(.*)$/.exec(text.slice(start));
  if (!rest) return null;
  return [text, text.slice(0, end), rest[1]];
}

function nextDelimiter(text, start, delimiters) {
  let end = text.length;
  for (const delimiter of delimiters) {
    const found = text.indexOf(delimiter, start);
    if (found >= 0 && found < end) end = found;
  }
  return end;
}

function whitespaceEnd(text, start) {
  while (start < text.length && /\s/.test(text[start])) start++;
  return start;
}

function whitespaceStart(text, end) {
  while (end > 0 && /\s/.test(text[end - 1])) end--;
  return end;
}

function moduleQuoteInfo(text, boundary) {
  const quoteEnd = nextDelimiter(text, boundary + 1, ["'", '"']);
  const end = whitespaceStart(text, boundary);
  let fromStart = -1;
  if (end < boundary && text.slice(end - 4, end).toLowerCase() === 'from' && /\s/.test(text[end - 5] ?? ''))
    fromStart = end - 4;
  return { quoteEnd, fromStart, prefixEnd: whitespaceStart(text, fromStart) };
}

function validModulePrefix(after, content, boundary, info, newline) {
  return content === boundary || (info.fromStart >= after + 2 && newline >= info.prefixEnd);
}

/** Captures for the static import/export resource grammar, without re-scanning failed prefixes. */
export function* moduleImportMatches(text) {
  let boundary = -1;
  let newline = -1;
  let previousBoundary = -1;
  let info;
  let consumed = 0;
  for (const prefix of text.matchAll(/\b(?:import|export)(?=\s)/gi)) {
    if (prefix.index < consumed) continue;
    const after = prefix.index + prefix[0].length;
    const content = whitespaceEnd(text, after);
    if (boundary < content) boundary = nextDelimiter(text, content, [';', "'", '"']);
    if (text[boundary] !== "'" && text[boundary] !== '"') continue;
    if (previousBoundary !== boundary) {
      previousBoundary = boundary;
      info = moduleQuoteInfo(text, boundary);
    }
    if (info.quoteEnd <= boundary + 1 || info.quoteEnd === text.length) continue;
    if (newline < content) newline = nextDelimiter(text, content, ['\n']);
    if (!validModulePrefix(after, content, boundary, info, newline)) continue;
    const match = [text.slice(prefix.index, info.quoteEnd + 1), text.slice(boundary + 1, info.quoteEnd)];
    match.index = prefix.index;
    yield match;
    consumed = info.quoteEnd + 1;
  }
}
/** First nonempty text inside an element, allowing the historical duplicated opening element. */
export function nestedElementText(text, name) {
  const open = `<${name}>`;
  const close = `</${name}>`;
  let cursor = 0;
  while (cursor < text.length) {
    const start = text.indexOf(open, cursor);
    if (start < 0) return undefined;
    cursor = start + open.length;
    let content = cursor;
    while (content < text.length && /\s/.test(text[content])) content++;
    if (text.startsWith(open, content)) {
      content += open.length;
      while (content < text.length && /\s/.test(text[content])) content++;
    }
    const end = text.indexOf('<', content);
    if (end > content && text.startsWith(close, end)) return text.slice(content, end).trimEnd();
  }
  return undefined;
}
