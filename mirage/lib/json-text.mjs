// Coalesce immutable values in owned, parsed JSON objects. Cache entries and
// journal rows otherwise duplicate recurring text across independent parses.
// Separate bounded generations keep recurring GUID references from being
// displaced by unique display text. Neither pool outlives this load. Mutable objects
// remain independent and all bytes/checksums still cover the original file.
export function createJsonTextCoalescer() {
  const pool = (limit) => {
    let current = new Map(),
      previous = new Map();
    return (value) => {
      const existing = current.get(value);
      if (existing !== undefined) return existing;
      const retained = previous.get(value) ?? value;
      if (current.size >= limit) {
        previous = current;
        current = new Map();
      }
      current.set(retained, retained);
      return retained;
    };
  };
  // At most 8,192 ordinary strings (16–256 characters) and 131,072 GUID-shaped
  // strings (36 characters), independent of the number of restored rows.
  const text = pool(4096),
    guid = pool(65536);
  return (row) => {
    if (!row || typeof row !== 'object') return;
    for (const key of Object.keys(row)) {
      const value = row[key];
      if (typeof value !== 'string' || value.length < 16 || value.length > 256) continue;
      const identifier =
        value.length === 36 && value[8] === '-' && value[13] === '-' && value[18] === '-' && value[23] === '-';
      row[key] = identifier ? guid(value) : text(value);
    }
  };
}
