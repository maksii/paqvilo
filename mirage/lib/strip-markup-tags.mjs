// Remove complete angle-bracket tags, leaving unterminated text unchanged.
export function stripMarkupTags(text) {
  let cursor = 0;
  let result = '';
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor);
    if (start < 0) break;
    const end = text.indexOf('>', start + 1);
    if (end < 0) break;
    result += text.slice(cursor, start);
    cursor = end + 1;
  }
  return result + text.slice(cursor);
}
