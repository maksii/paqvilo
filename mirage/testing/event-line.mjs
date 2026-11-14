// Parse a single SSE line while preserving the previous matcher behavior.
export function eventLineParts(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return [line, ''];
  let value = line.slice(colon + 1);
  if (value.startsWith(' ')) value = value.slice(1);
  if (/[\r\n\u2028\u2029]/.test(value)) return null;
  return [line.slice(0, colon), value];
}
