// Preserve the two replacement passes used for registration snippet text.
const BLOCK_TAG = /<\/?(?:p|div|br|li|ul|ol|h[1-6]|section|article|table|tr|td|th)\b/iy;

function replaceTags(text, replacement, blockOnly) {
  let cursor = 0;
  let output = '';
  while (cursor < text.length) {
    const start = text.indexOf('<', cursor);
    if (start < 0) break;
    if (blockOnly) {
      BLOCK_TAG.lastIndex = start;
      if (!BLOCK_TAG.test(text)) {
        output += text.slice(cursor, start + 1);
        cursor = start + 1;
        continue;
      }
    }
    const end = text.indexOf('>', start + 1);
    if (end < 0) break;
    output += text.slice(cursor, start) + replacement;
    cursor = end + 1;
  }
  return output + text.slice(cursor);
}

export function registrationSnippetText(text) {
  const separated = replaceTags(text, ' ', true);
  return replaceTags(separated, '', false)
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&amp;', '&')
    .replace(/\s+/g, ' ')
    .trim();
}
