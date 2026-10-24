import { AsyncLocalStorage } from 'node:async_hooks';

// Only the configured form submission establishes this scope. Consume it at
// the root create before plugins or deep inserts can perform another write.
const associations = new AsyncLocalStorage();
export function withNativeFormContactAssociation(association, work) {
  return association ? associations.run({ ...association, consumed: false }, work) : work();
}
export function takeNativeFormContactAssociation(entity, identity) {
  const association = associations.getStore();
  if (!association || association.consumed) return null;
  association.consumed = true;
  const contactId = String(identity?.contactId ?? identity?.id ?? '')
    .replace(/[{}]/g, '')
    .toLowerCase();
  return association.entity === entity && contactId && association.contactId === contactId
    ? { column: association.column, contactId }
    : null;
}
