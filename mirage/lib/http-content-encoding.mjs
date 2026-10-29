/** Positive explicit gzip quality wins over a wildcard; q=0 excludes it. */
export function acceptsGzip(req) {
  let gzip, wildcard;
  for (const entry of String(req.headers?.['accept-encoding'] ?? '').split(',')) {
    const [name, ...parameters] = entry.trim().toLowerCase().split(';');
    if (!['gzip', '*'].includes(name.trim())) continue;
    const weight = parameters.find((value) => /^\s*q\s*=/.test(value));
    const raw = weight?.split('=')[1]?.trim();
    const quality = raw === undefined ? 1 : /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/.test(raw) ? Number(raw) : 0;
    if (name.trim() === 'gzip') gzip = quality;
    else wildcard = quality;
  }
  return (gzip ?? wildcard ?? 0) > 0;
}
