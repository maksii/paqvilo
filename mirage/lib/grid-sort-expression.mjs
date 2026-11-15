/** Parse "attr ASC, alias.attr DESC" accepting only known view columns. */
export function parseGridSortExpression(expression, allowed) {
  const parts = [];
  for (const part of String(expression ?? '').split(',')) {
    const match = /^\s*([a-z_]\w*(?:\.[a-z_]\w*)?)(?:\s*(asc|desc))?\s*$/i.exec(part);
    if (!match) continue;
    if (allowed && !allowed.has(match[1])) continue;
    parts.push({ attribute: match[1], descending: /desc/i.test(match[2] ?? '') });
  }
  return parts;
}
