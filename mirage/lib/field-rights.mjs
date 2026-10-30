// Private projection values only. These encode boolean combinations, never a
// principal or authorization decision. Public APIs keep independent objects.
const rights = Array.from({ length: 8 }, (_, mask) =>
  Object.freeze({
    read: Boolean(mask & 1),
    create: Boolean(mask & 2),
    update: Boolean(mask & 4),
  }),
);
const fields = Array.from({ length: 16 }, (_, mask) =>
  Object.freeze({
    secured: Boolean(mask & 8),
    ...rights[mask & 7],
  }),
);
const maskOf = (read, create, update) => Number(read) | (Number(create) << 1) | (Number(update) << 2);
export const immutableColumnRights = (read, create, update) =>
  typeof read === 'boolean' && typeof create === 'boolean' && typeof update === 'boolean'
    ? rights[maskOf(read, create, update)]
    : Object.freeze({ read, create, update });
export const immutableFieldRights = (secured, read, create, update) =>
  typeof secured === 'boolean' &&
  typeof read === 'boolean' &&
  typeof create === 'boolean' &&
  typeof update === 'boolean'
    ? fields[maskOf(read, create, update) | (Number(secured) << 3)]
    : Object.freeze({ secured, read, create, update });
