export function groupDigitRuns(text, separator) {
  let result = '';
  let cursor = 0;
  while (cursor < text.length) {
    const code = text.charCodeAt(cursor);
    if (code < 48 || code > 57) {
      result += text[cursor++];
      continue;
    }
    const start = cursor;
    while (cursor < text.length && text.charCodeAt(cursor) >= 48 && text.charCodeAt(cursor) <= 57) cursor++;
    const previous = start > 0 ? text[start - 1] : '';
    let part = start;
    for (let index = start; index < cursor; index++) {
      const precedingWord = index > start || /[A-Za-z0-9_]/.test(previous);
      if (precedingWord && (cursor - index) % 3 === 0) {
        result += text.slice(part, index) + separator;
        part = index;
      }
    }
    result += text.slice(part, cursor);
  }
  return result;
}
