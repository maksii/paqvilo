// Redact query or fragment pairs without parsing or normalizing the supplied URL.
export function /* NOSONAR */ redactUrlQuery(value) {
  // NOSONAR: preserve state, evaluation order, and lifecycle
  if (!/[?#]/.test(value)) return value;
  let scan = 0;
  let copied = 0;
  let result = '';
  while (scan < value.length) {
    while (scan < value.length && value[scan] !== '?' && value[scan] !== '&' && value[scan] !== '#') scan++;
    if (scan === value.length) break;
    const start = scan++;
    while (scan < value.length && value[scan] !== '=' && value[scan] !== '&' && value[scan] !== '#') scan++;
    if (scan === value.length) break;
    if (value[scan] !== '=') continue;
    if (scan === start + 1) {
      scan++;
      continue;
    }
    result += value.slice(copied, scan + 1) + '[redacted]';
    scan++;
    while (scan < value.length && value[scan] !== '&' && value[scan] !== '#') scan++;
    copied = scan;
  }
  return result + value.slice(copied);
}

// WHATWG URL: the special schemes, whose authority follows any run of "/" or "\" (also none) after "scheme:".
const SPECIAL_SCHEMES = new Set(['ftp', 'file', 'http', 'https', 'ws', 'wss']);
const SCHEME = /^[a-z][a-z\d+.-]*:/i;
const isSlash = (character) => character === '/' || character === '\\';
/**
 * Where the authority of `text` starts as the WHATWG URL parser finds it, with whether "\" ends it, or null. Leading
 * C0 controls and spaces are skipped. After a special scheme any run of "/" or "\" (also an empty one) precedes the
 * authority; after another scheme only "//" does. Without a scheme, a run of two or more "/" or "\" starts a
 * scheme-relative URL (the run is read against a special base, which Mirage cannot know, so the wider reading is used).
 */
function authorityStart(text) {
  let index = 0;
  while (index < text.length && text.charCodeAt(index) <= 0x20) index++;
  const scheme = SCHEME.exec(text.slice(index));
  if (scheme && !SPECIAL_SCHEMES.has(scheme[0].slice(0, -1).toLowerCase()))
    return text.startsWith('//', index + scheme[0].length)
      ? { start: index + scheme[0].length + 2, special: false }
      : null;
  let start = index + (scheme ? scheme[0].length : 0);
  while (start < text.length && isSlash(text[start])) start++;
  return scheme || start - index >= 2 ? { start, special: true } : null;
}
/**
 * Redact the userinfo (user name and password) of a URL's authority without normalizing the rest: the text from the
 * authority start (authorityStart) to the last "@" before the authority ends ("/", "?", "#", and "\" for a special
 * URL) becomes "[redacted]". The URL parser removes every tab, CR and LF first, so the redacted value is the value
 * without them; a value without userinfo is returned unchanged. Each step is one linear scan.
 */
export function redactUrlUserinfo(value) {
  const text = value.replaceAll(/[\t\n\r]/g, '');
  const authority = authorityStart(text);
  if (!authority) return value;
  let end = authority.start;
  while (end < text.length && !'/?#'.includes(text[end]) && !(authority.special && text[end] === '\\')) end++;
  const at = text.lastIndexOf('@', end - 1);
  return at < authority.start ? value : `${text.slice(0, authority.start)}[redacted]${text.slice(at)}`;
}
