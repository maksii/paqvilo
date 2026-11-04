// Reproduce the legacy quoted-input attribute matcher with linear scans.
export function liveInputAttributes(text) {
  // NOSONAR: preserve state, evaluation order, and lifecycle
  const pairs = [];
  let cursor = 0;
  const nameCharacter = (char) => char !== undefined && /[\w-]/.test(char);
  const whitespace = (char) => char !== undefined && /\s/.test(char);
  while (cursor < text.length) {
    if (!nameCharacter(text[cursor])) {
      cursor++;
      continue;
    }
    const start = cursor;
    while (nameCharacter(text[cursor])) cursor++;
    const name = text.slice(start, cursor).toLowerCase();
    let next = cursor;
    while (whitespace(text[next])) next++;
    if (text[next] !== '=') {
      cursor = next;
      continue;
    }
    next++;
    while (whitespace(text[next])) next++;
    const quote = text[next];
    if (quote !== '"' && quote !== "'") {
      cursor = next;
      continue;
    }
    const end = text.indexOf(quote, next + 1);
    if (end < 0 || /[\r\n\u2028\u2029]/.test(text.slice(next + 1, end))) {
      cursor = next + 1;
      continue;
    }
    pairs.push([name, text.slice(next + 1, end)]);
    cursor = end + 1;
  }
  return Object.fromEntries(pairs);
}
