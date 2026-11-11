/** Select an unknown schema property without consulting rows or bypassing any known field policy. */
export function rejectedGatewayProperty(body, { mapping, fields = [], metadataFields = [], assertWrite, operation }) {
  if (mapping.schemaComplete !== true) return null;
  const names = new Set(
    [mapping.idColumn, ...fields.filter((name) => name !== '*')].filter(Boolean).map((name) => name.toLowerCase()),
  );
  for (const definitions of [mapping.fields, mapping.fieldMetadata, ...metadataFields])
    for (const name of Object.keys(definitions ?? {})) names.add(name.toLowerCase());
  for (const [name, relation] of Object.entries(mapping.relationships ?? {})) {
    names.add(name.toLowerCase());
    if (relation.from) names.add(relation.from.toLowerCase());
  }
  const known = [],
    unknown = [];
  for (const [name, value] of Object.entries(body)) {
    const column = name.replace(/@odata\.bind$/, ''),
      physical = /^_(.+)_value$/.exec(column)?.[1] ?? column;
    // Protocol annotations, reference aliases, private names and all known columns still pass through normal policy.
    if (
      name.includes('@') ||
      /^__sim/i.test(physical) ||
      ['__proto__', 'constructor', 'prototype'].includes(physical) ||
      names.has(column.toLowerCase()) ||
      names.has(physical.toLowerCase())
    )
      known.push([name, value]);
    else unknown.push(name);
  }
  if (!unknown.length) return null;
  assertWrite(Object.fromEntries(known), operation);
  return unknown[0];
}
