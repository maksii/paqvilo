// Match the permissive CSDL attribute catalogue grammar without rescanning failed name prefixes.
export function csdlAttributes(text) {
  // NOSONAR: preserve state, evaluation order, and lifecycle
  const pairs = [];
  const lastDouble = text.lastIndexOf('"');
  const lastSingle = text.lastIndexOf("'");
  let cursor = 0;
  const isName = (char) => char !== undefined && /[\w:.]/.test(char);
  const isSpace = (char) => char !== undefined && /\s/.test(char);
  while (cursor < text.length) {
    if (!isName(text[cursor])) {
      cursor++;
      continue;
    }
    const start = cursor;
    while (isName(text[cursor])) cursor++;
    const name = text.slice(start, cursor);
    let next = cursor;
    while (isSpace(text[next])) next++;
    if (text[next] !== '=') {
      cursor = next;
      continue;
    }
    next++;
    while (isSpace(text[next])) next++;
    const quote = text[next];
    if (quote !== '"' && quote !== "'") {
      cursor = next;
      continue;
    }
    if (next >= (quote === '"' ? lastDouble : lastSingle)) {
      cursor = next + 1;
      continue;
    }
    const end = text.indexOf(quote, next + 1);
    const value = text
      .slice(next + 1, end)
      .replaceAll('&quot;', '"')
      .replaceAll('&apos;', "'")
      .replaceAll('&lt;', '<')
      .replaceAll('&gt;', '>')
      .replaceAll('&amp;', '&');
    pairs.push([name, value]);
    cursor = end + 1;
  }
  return Object.fromEntries(pairs);
}
