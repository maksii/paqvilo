/** Resolve the configured organization, never an unrelated first row. Older
 * embedded fixtures without a runtime id retain their sole organization row. */
export function organizationRecord(storeOrState) {
  const state = storeOrState?.state ?? storeOrState ?? {};
  const rows =
    typeof storeOrState?.tableRows === 'function'
      ? storeOrState.tableRows('organization')
      : (state.tables?.organization ?? []);
  const id = state.dataverse?.organizationId;
  if (id) return rows.find((row) => String(row.organizationid).toLowerCase() === String(id).toLowerCase());
  if (rows.length === 1) return rows[0];
  // Invalid legacy/business identifiers must not become UUID namespaces.
  const valid = rows.filter((row) => /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(row.organizationid));
  return valid.length === 1 ? valid[0] : undefined;
}
