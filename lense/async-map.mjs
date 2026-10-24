/** Ordered, bounded mapping of a synchronous iterable. Invalid limits reject before any work. */
export async function orderedMap(items, limit, mapper) {
  if (!Number.isInteger(limit) || limit < 1) throw new Error('Concurrency limit must be a positive integer');
  const list = Array.from(items);
  const results = new Array(list.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, list.length) }, async () => {
      while (next < list.length) {
        const index = next++;
        results[index] = await mapper(list[index], index);
      }
    }),
  );
  return results;
}
