// Return the capture of /\(([^)]+)\)$/ from a header string, or undefined.
export function trailingParenthesized(value) {
  const text = String(value);
  if (!text.endsWith(')')) return undefined;
  const previousClose = text.lastIndexOf(')', text.length - 2);
  const opening = text.indexOf('(', previousClose + 1);
  return opening < 0 || opening === text.length - 2 ? undefined : text.slice(opening + 1, -1);
}
