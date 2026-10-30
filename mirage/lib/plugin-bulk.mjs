import { DataError } from './data-error.mjs';
import { sdkValueToRecord } from './local-organization-service.mjs';
import { handoffPluginResponse } from './plugin-response.mjs';
import { recordToSdkEntity } from './plugin-clr.mjs';
import { pluginStepBypassed } from './plugin-bypass.mjs';
import { pluginStepMatchesEntity } from './exported-plugins.mjs';
const emptyId = '00000000-0000-0000-0000-000000000000';
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fail = (message, code = 'LocalPluginBulkUnsupported', status = 501) => {
  throw new DataError(message, status, code);
};
/** The two drivers share validation, stage ordering and atomic main writes. */
export function executeBulkRecords(options) {
  if (!options.store.hasOperationContext())
    return options.store.withOperationContext(() => executeBulkRecords(options));
  const steps = bulkSteps(options, false);
  let next = steps.next();
  while (!next.done) next = steps.next(next.value);
  return next.value;
}
export async function executeBulkRecordsAsync(options) {
  if (!options.store.hasOperationContext())
    return options.store.withOperationContext(() => executeBulkRecordsAsync(options));
  const steps = bulkSteps(options, true);
  let next = steps.next();
  while (!next.done) {
    try {
      next = steps.next(await next.value);
    } catch (error) {
      next = steps.throw(error);
    }
  }
  return next.value;
}
function* bulkSteps(
  {
    store,
    entity,
    operation,
    targets: suppliedTargets,
    identity,
    authorize,
    responseToken,
    write,
    runPostEffect,
    bypassCustomPlugins = false,
    bypassCustomAsync = false,
    bypassStepIds = [],
    portalRequest = false,
    concurrencyBehavior,
    // A bulk message another message delegates (UpsertMultiple): inside its transaction, without the request tag.
    delegated = false,
  },
  awaitIo,
) {
  const mapping = store.resolveMapping(entity),
    primary = mapping.idColumn,
    update = operation === 'updatemultiple',
    single = update ? 'update' : 'create';
  if (
    !['createmultiple', 'updatemultiple'].includes(operation) ||
    !Array.isArray(suppliedTargets) ||
    !suppliedTargets.length
  )
    fail('Bulk SDK targets must contain one or more records of one supported message.');
  const catalogue = store.pluginPipeline?.steps;
  if (
    !catalogue &&
    !bypassCustomPlugins &&
    store.pluginPipeline &&
    store.pluginPipelineActive({ entity: mapping.logicalName, operation: single, bypassCustomPlugins, bypassStepIds })
  )
    fail('Mixed single-record and bulk registrations require source-qualified native merged-pipeline ordering.');
  const previous = [],
    targets = [],
    writeIndexes = [],
    ids = new Set();
  for (const target of suppliedTargets) {
    if (
      target?.$type !== 'Entity' ||
      target.logicalName !== mapping.logicalName ||
      !target.attributes ||
      typeof target.attributes !== 'object' ||
      Array.isArray(target.attributes)
    )
      fail('Bulk Targets must be typed entities of one exact logical table.', 'LocalPluginBulkInput', 400);
    if (update && (!uuid.test(target.id) || target.id === emptyId))
      fail('UpdateMultiple requires each original entity ID.', 'LocalPluginBulkInput', 400);
    target.id ??= emptyId;
    if (Object.hasOwn(target.attributes, primary))
      fail('Bulk identity belongs to Entity.Id, not a conflicting primary-key attribute.', 'LocalPluginBulkInput', 400);
    let duplicate = false;
    if (target.id !== emptyId) {
      if (!uuid.test(target.id) || (!update && ids.has(target.id.toLowerCase())))
        fail('Duplicate or malformed bulk entity identity.', 'LocalPluginBulkInput', 400);
      target.id = target.id.toLowerCase();
      duplicate = update && ids.has(target.id.toLowerCase());
      ids.add(target.id.toLowerCase());
    }
    const before = update ? store.get(entity, target.id, identity, { skipPluginRead: true }) : null;
    if (update && !before) fail('Bulk target record not found.', 'NotFound', 404);
    const input = sdkValueToRecord(target);
    if (!duplicate) {
      authorize(single, update ? { ...before, ...input } : input, before);
      writeIndexes.push(targets.length);
    }
    previous.push(before);
    targets.push(target);
  }
  const original = targets.map((target) => ({ id: target.id ?? emptyId, logicalName: target.logicalName })),
    holder = { [primary]: emptyId },
    inherited = store.pluginInTransaction;
  const singleFrames = targets.map((target, index) => ({
    target: sdkValueToRecord(target),
    record: {
      ...previous[index],
      ...sdkValueToRecord(target),
      [primary]: target.id === emptyId ? store.ids.uuid() : target.id,
    },
  }));
  let finalBulkFrame;
  const check = () => {
    const unique = new Set();
    if (
      targets.length !== original.length ||
      targets.some((target, index) => {
        if (
          target?.$type !== 'Entity' ||
          target.logicalName !== original[index].logicalName ||
          !target.attributes ||
          typeof target.attributes !== 'object' ||
          Array.isArray(target.attributes) ||
          Object.hasOwn(target.attributes, primary) ||
          !uuid.test(target.id) ||
          ((update || original[index].id !== emptyId) && target.id !== original[index].id)
        )
          return true;
        if (target.id !== emptyId) {
          if (!update && unique.has(target.id.toLowerCase())) return true;
          unique.add(target.id.toLowerCase());
        }
        return false;
      })
    )
      fail('Bulk plugin changed the table/count or an existing target identity.', 'LocalPluginBulkInput', 400);
  };
  const phase = function* (stage, records) {
    if (stage !== 10 || delegated) store.pluginInTransaction = true;
    const context = {
      entity: mapping.logicalName,
      operation,
      stage,
      targets,
      previousRecords: previous,
      records,
      record: holder,
      identity,
      changedAttributes: [...new Set(targets.flatMap((target) => Object.keys(target.attributes ?? {})))],
      portalRequest,
      bulkOrigin: true,
      bypassStepIds,
      bypassCustomPlugins,
      ...(concurrencyBehavior === undefined ? {} : { bulkConcurrencyBehavior: concurrencyBehavior }),
      ...(delegated ? { inheritsRequestTag: false } : {}),
      ...(awaitIo ? { awaitIo: true } : {}),
    };
    if (store.pluginPipeline) {
      if (catalogue) {
        let bulkStarted = false;
        const singleStarted = new Set();
        const entries = catalogue()
          .filter(
            (step) =>
              step.enabled &&
              step.contract?.supportedDeployment !== 1 &&
              !pluginStepBypassed(step, { bypassCustomPlugins, bypassStepIds }, store.pluginPipeline.diagnostic) &&
              pluginStepMatchesEntity(step, mapping.logicalName) &&
              (step.contract?.mode ?? 0) === 0 &&
              step.stage === stage &&
              [single, operation].includes(String(step.message).toLowerCase()),
          )
          .sort(
            (a, b) =>
              Number(String(a.message).toLowerCase() === single) - Number(String(b.message).toLowerCase() === single) ||
              a.rank - b.rank ||
              a.id.localeCompare(b.id),
          );
        const bulkEntries = entries.filter((entry) => String(entry.message).toLowerCase() === operation);
        const singleEntries = entries.filter((entry) => String(entry.message).toLowerCase() === single);
        const scheduled = [
          ...bulkEntries.map((entry) => ({ entry })),
          ...targets.flatMap((_target, index) => singleEntries.map((entry) => ({ entry, index }))),
        ];
        for (const { entry, index } of scheduled) {
          if (index === undefined) {
            const frame = yield store.pluginPipeline({
              ...context,
              changedAttributes: [...new Set(targets.flatMap((target) => Object.keys(target.attributes ?? {})))],
              pluginStepIds: [entry.id],
              continuePhase: bulkStarted,
            });
            bulkStarted = true;
            finalBulkFrame = frame;
            if (stage === 40) handoffPluginResponse(store, operation, mapping.logicalName, frame, responseToken);
          } else {
            const target = targets[index];
            const singleFrame = singleFrames[index],
              values = sdkValueToRecord(target);
            for (const key of Object.keys(singleFrame.target)) delete singleFrame.target[key];
            Object.assign(singleFrame.target, values);
            if (stage === 40) Object.assign(singleFrame.record, records[index]);
            else Object.assign(singleFrame.record, previous[index], values);
            singleFrame.frame = yield store.pluginPipeline({
              ...context,
              operation: single,
              target: singleFrame.target,
              record: singleFrame.record,
              previous: previous[index],
              changedAttributes: Object.keys(singleFrame.target),
              targets: undefined,
              previousRecords: undefined,
              records: undefined,
              // A record a bulk message delegates has neither the request tag nor ConcurrencyBehavior (recorded corpus).
              inheritsRequestTag: false,
              concurrencyBehavior: null,
              pluginStepIds: [entry.id],
              continuePhase: singleStarted.has(index),
            });
            singleStarted.add(index);
            {
              const encoded = recordToSdkEntity(store, mapping.logicalName, singleFrame.target);
              delete encoded.attributes[primary];
              target.attributes = encoded.attributes;
            }
          }
          check();
        }
      } else if (
        store.pluginPipelineActive({ entity: mapping.logicalName, operation, bypassCustomPlugins, bypassStepIds })
      ) {
        const frame = yield store.pluginPipeline(context);
        finalBulkFrame = frame;
        if (stage === 40) handoffPluginResponse(store, operation, mapping.logicalName, frame, responseToken);
      }
    }
    check();
  };
  try {
    yield* phase(10, []);
    yield* phase(20, []);
    // Preimages retain the original request snapshot. Authorization must see
    // current rows after every stage20 SDK side effect, for every target before
    // the first bulk primary write.
    const writes = writeIndexes.map((index) => {
      const target = targets[index];
      const values = sdkValueToRecord(target),
        current = update ? store.get(entity, target.id, identity, { skipPluginRead: true }) : null;
      if (update && !current) fail('Bulk target was removed during PreOperation.', 'NotFound', 404);
      authorize(single, update ? { ...current, ...values } : values, current);
      return { index, target, values };
    });
    const rows = new Array(targets.length),
      postWriteEffects = [];
    for (const { index, target, values } of writes) {
      const data = update
        ? values
        : { ...values, [primary]: target.id === emptyId ? singleFrames[index].record[primary] : target.id };
      rows[index] = yield write
        ? write(update, target.id, data, {
            bypassCustomPlugins,
            skipPluginPipeline: Boolean(catalogue),
            deferCommittedEvent: true,
            bypassCustomAsync,
            bypassStepIds,
            postWriteEffects,
          })
        : update
          ? store.updateRecord(entity, target.id, data, identity, {
              coerce: true,
              bypassCustomPlugins,
              skipPluginPipeline: Boolean(catalogue),
              deferCommittedEvent: true,
              bypassCustomAsync,
              bypassStepIds,
            })
          : store.createRecord(entity, data, identity, {
              coerce: true,
              bypassCustomPlugins,
              skipPluginPipeline: Boolean(catalogue),
              deferCommittedEvent: true,
              bypassCustomAsync,
              bypassStepIds,
            });
      if (!update) target.id = rows[index][primary];
    }
    if (update) {
      const persisted = new Map(writeIndexes.map((index) => [targets[index].id, rows[index]]));
      for (const [index, target] of targets.entries()) rows[index] ??= persisted.get(target.id);
    }
    holder.bulkIds = rows.map((row) => row[primary]);
    yield* phase(40, rows);
    if (
      finalBulkFrame?.inputParametersStage === 40 &&
      finalBulkFrame.inputParameters?.values?.Targets?.$type === 'EntityCollection'
    )
      finalBulkFrame.inputParameters.values.Targets.entities = structuredClone(targets);
    for (const [index, row] of rows.entries()) {
      store.recordCommittedEvent(mapping.logicalName, single, row, Object.keys(targets[index].attributes), {
        target: sdkValueToRecord(targets[index]),
        previous: previous[index],
        identity,
        frame: singleFrames[index].frame ?? {},
        bypassCustomAsync,
        bypassStepIds,
        fromBulk: true,
        messageEvent: !writeIndexes.includes(index),
      });
    }
    store.recordCommittedEvent(
      mapping.logicalName,
      operation,
      holder,
      [...new Set(targets.flatMap((target) => Object.keys(target.attributes)))],
      {
        target: {},
        targets,
        previousRecords: previous,
        records: rows,
        identity,
        frame: finalBulkFrame ?? {},
        messageEvent: true,
        bypassCustomAsync,
        bypassStepIds,
      },
    );
    for (const effect of postWriteEffects) yield runPostEffect ? runPostEffect(effect) : effect();
    return { rows, ids: holder.bulkIds, outputParameters: finalBulkFrame?.outputParameters };
  } finally {
    store.pluginInTransaction = inherited;
  }
}
