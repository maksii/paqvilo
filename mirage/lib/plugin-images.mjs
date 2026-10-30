/** Native image Attributes omit null/unset columns while retaining falsy data.
 * Identity is carried separately by the SDK Entity encoder. Callers detach the
 * returned values before exposing the image to a handler. */
export function imageAttributes(row, columns = []) {
  const selected = columns.length ? new Set(columns) : null;
  return Object.fromEntries(
    Object.entries(row ?? {}).filter(([name, value]) => value != null && (!selected || selected.has(name))),
  );
}
