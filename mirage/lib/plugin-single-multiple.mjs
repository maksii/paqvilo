import { DataError } from './data-error.mjs';

const multiples = { create: 'createmultiple', update: 'updatemultiple', delete: 'deletemultiple' };
/** The *Multiple message whose steps a single Create, Update or Delete also runs. */
export function multipleMessage(operation) {
  return multiples[operation];
}

/** A single-origin Create, Update or Delete runs its paired multiple message's steps inside its own pipeline (native
 * recorder parity corpus crud, depth, async, upsert, faults): one frame, so one PrimaryEntityId, RequestId, ParentContext,
 * SharedVariables and OutputParameters for both messages. The pipeline merges the two registrations by rank, the
 * requested message's steps first at equal rank (runPluginPhase bridgedMessage). Bulk-origin requests order their own
 * grouped steps (plugin-bulk.mjs). */
export function singleMultiplePipeline(execute) {
  return (context) =>
    execute(
      multipleMessage(context.operation) && !context.bulkOrigin && !context.pluginStepIds
        ? { ...context, bridgedMessage: multipleMessage(context.operation) }
        : context,
    );
}

/** A bridged multiple step sees the single message's InputParameters with its Target as a one-record Targets
 * collection: an EntityCollection named after the table (TotalRecordCount 0, MinActiveRowVersion null), or for Delete an
 * EntityReferenceCollection (native crud CreateMultiple/UpdateMultiple/DeleteMultiple at stages 10, 20, 40 and async). */
export function bridgeTargetInputs(values, entity) {
  if (!values || !Object.hasOwn(values, 'Target')) return values;
  const { Target: target, ...rest } = values;
  return {
    ...rest,
    Targets:
      target?.$type === 'EntityReference'
        ? { $type: 'EntityReferenceCollection', values: [target] }
        : {
            $type: 'EntityCollection',
            entityName: entity,
            entities: [target],
            moreRecords: false,
            totalRecordCount: 0,
            totalRecordCountLimitExceeded: false,
            pagingCookie: null,
            minActiveRowVersion: null,
          },
  };
}

/** The Targets of a bulk-origin CreateMultiple/UpdateMultiple, named after the table: as the request supplied them at
 * PreValidation (TotalRecordCount 0, MinActiveRowVersion null), as the platform carries them from PreOperation on and in
 * queued jobs (TotalRecordCount -1, MinActiveRowVersion "-1") (native recorder corpus bulk). */
export function bulkTargetsCollection(entity, entities, { submitted }) {
  return {
    $type: 'EntityCollection',
    entityName: entity,
    entities,
    moreRecords: false,
    totalRecordCount: submitted ? 0 : -1,
    totalRecordCountLimitExceeded: false,
    pagingCookie: null,
    minActiveRowVersion: submitted ? null : '-1',
  };
}

/** The single message's InputParameters after a bridged step ran: its one Targets record is the Target again. A step
 * that changes the record count, table or identity of that collection is refused. */
export function unbridgeTargetInputs(values, { entity, id }) {
  if (!values || !Object.hasOwn(values, 'Targets')) return values;
  const { Targets: targets, ...rest } = values;
  const list = targets?.$type === 'EntityReferenceCollection' ? targets.values : targets?.entities;
  const target = Array.isArray(list) && list.length === 1 ? list[0] : null;
  if (
    !target ||
    target.logicalName !== entity ||
    (id != null && String(target.id ?? '').toLowerCase() !== String(id).toLowerCase())
  )
    throw new DataError(
      'A multiple-message step invoked by a single request must preserve its one bound target identity.',
      501,
      'LocalPluginBulkUnsupported',
    );
  return { Target: target, ...rest };
}
