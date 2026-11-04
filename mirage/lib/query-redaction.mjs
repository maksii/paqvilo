// Redact query or fragment pairs without parsing or normalizing the supplied URL.
export function redactUrlQuery(value) {
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
