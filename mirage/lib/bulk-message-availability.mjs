const messages = ['CreateMultiple', 'UpdateMultiple'];
const equal = (left, right) => String(left ?? '').toLowerCase() === String(right ?? '').toLowerCase();
const profileAssertsMessage = (profile, entity, message) =>
  (profile?.bulkTables ?? []).some(
    (table) =>
      equal(table.entity, entity) &&
      equal(table.tableType, 'standard') &&
      typeof table.evidence === 'string' &&
      table.evidence.trim() &&
      table.messages?.some((name) => equal(name, message)),
  );

/** A synthetic registration filter describes the local pipeline, not native
 * table/message availability. Only source registrations with a native filter
 * reference or an explicitly evidenced backend profile qualify availability. */
export function bulkMessageAvailabilityRecord({ store, plugins = {}, profiles = [] }) {
  const tables = Object.entries(store?.state?.mappings ?? {})
    .filter(([, mapping]) => !equal(mapping.tableType, 'Elastic'))
    .map(([entity]) => ({
      entity,
      messages: messages.map((message) => {
        const source = (plugins?.steps ?? []).some(
          (step) => equal(step.entity, entity) && equal(step.message, message) && Boolean(step.messageFilterId),
        );
        const observed =
          (plugins?.messages ?? []).some(
            (record) => equal(record.name, message) && [0, 1, 2].includes(record.filterAvailability?.[entity]),
          ) ||
          (plugins?.messageFilters ?? []).some(
            (filter) =>
              equal(filter.entity, entity) &&
              [0, 1, 2].includes(filter.availability) &&
              (plugins?.messages ?? []).some(
                (record) => equal(record.id, filter.messageId) && equal(record.name, message),
              ),
          );
        const asserted = profiles.some((profile) => profileAssertsMessage(profile, entity, message));
        let sourceName;
        if (source) sourceName = 'solution-registration-filter';
        else if (observed) sourceName = 'observed-message-filter';
        else if (asserted) sourceName = 'evidenced-service-profile';
        else sourceName = 'synthetic-local-support';
        return {
          message,
          availability: source || observed || asserted ? 'qualified-metadata' : 'unqualified',
          source: sourceName,
        };
      }),
    }));
  const qualified = tables
    .flatMap((table) => table.messages)
    .filter((message) => message.availability === 'qualified-metadata').length;
  const total = tables.length * messages.length;
  return {
    name: 'dataverse-standard-bulk-availability',
    kind: 'inventory',
    level: 'contract',
    operations: messages.map((name) => ({ name, level: 'contract' })),
    reason: `${qualified}/${total} standard table/message combinations have source metadata or an evidenced profile. Unqualified combinations are local contracts; synthetic registration filters do not establish native availability.`,
    seams: {
      availability: { qualified, unqualified: total - qualified, tables },
      diagnostic: total > qualified ? 'BULK_MESSAGE_AVAILABILITY_UNQUALIFIED' : null,
    },
  };
}
