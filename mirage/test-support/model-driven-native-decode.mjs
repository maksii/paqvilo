export const decode = (node) => {
  if (node.type === 'array')
    return node.entries.filter((entry) => entry.key !== 'length').map((entry) => decode(entry.value));
  if (node.type === 'object') return Object.fromEntries(node.entries.map((entry) => [entry.key, decode(entry.value)]));
  if (node.type === 'number' && node.value === 'NaN') return Number.NaN;
  if (node.type === 'number' && node.value === '+Infinity') return Infinity;
  if (node.type === 'null') return null;
  if (node.type === 'undefined') return undefined;
  return node.value;
};
