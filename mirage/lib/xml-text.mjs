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
