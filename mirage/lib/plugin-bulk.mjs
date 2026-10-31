import { DataError } from './data-error.mjs';
import { sdkValueToRecord } from './local-organization-service.mjs';
import { handoffPluginResponse } from './plugin-response.mjs';
import { recordToSdkEntity } from './plugin-clr.mjs';
import { pluginStepBypassed } from './plugin-bypass.mjs';
import { messageNameOf, pluginStepMatchesEntity } from './exported-plugins.mjs';
import { initializePluginOperation } from './plugin-operation-context.mjs';
import { pluginInvocationSdkParent } from './plugin-execution-lifetime.mjs';
import { bulkTargetsCollection } from './plugin-single-multiple.mjs';
import { isDeepStrictEqual } from 'node:util';
const emptyId = '00000000-0000-0000-0000-000000000000';
const samePrimary = (target, primary) =>
  String(
    sdkValueToRecord({ ...target, attributes: { [primary]: target.attributes[primary] } })[primary] ?? '',
  ).toLowerCase() === String(target.id ?? '').toLowerCase();
const uuid = /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const fail = (message, code = 'LocalPluginBulkUnsupported', status = 501) => {
  throw new DataError(message, status, code);
};
/** The two drivers share validation, stage ordering and atomic main writes.
 * Tracing: one bulk span per message (docs/design/tracing.md); its per-row reads and writes open no spans of their own. */
export function executeBulkRecords(options) {
  if (!options.store.hasOperationContext())
    return options.store.withOperationContext(() => executeBulkRecords(options));
  return traceBulk(options, () => {
    const steps = bulkSteps(options, false);
    let next = steps.next();
    while (!next.done) next = steps.next(next.value);
    return next.value;
  });
}
export async function executeBulkRecordsAsync(options) {
  if (!options.store.hasOperationContext())
    return options.store.withOperationContext(() => executeBulkRecordsAsync(options));
  return traceBulk(options, async () => {
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
  });
}
function traceBulk(options, run) {
  const traces = options.store.traces;
  if (!traces?.enabled) return run();
  return traces.wrap(
    {
      kind: 'bulk',
      name: `${options.operation === 'updatemultiple' ? 'UpdateMultiple' : 'CreateMultiple'} ${options.entity}`,
      module: 'dataverse',
      operation: options.operation,
      entity: options.entity,
      attributes: { targets: Array.isArray(options.targets) ? options.targets.length : null, entity: options.entity },
    },
    (span) => {
      const output = (result) => {
        span.output(() => ({ ids: result?.ids }));
        return result;
      };
      const result = run();
      return typeof result?.then === 'function' ? result.then(output) : output(result);
    },
  );
}
function* bulkSteps(
  {
    store,
    entity,
    operation,
    targets: suppliedTargets,
    // Per target, the values the main operation stamps (audit, ownership, state): the Targets show them from
    // PreOperation on, and the write derives them again where no step changed them.
    preOperationStamps = [],
    identity,
    authorize,
    responseToken,
    write,
    runPostEffect,
    bypassCustomPlugins = false,
    bypassCustomAsync = false,
    bypassStepIds = [],
    systemParameters,
    sdkFromSandbox = false,
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
    // A Target may name its key as an attribute equal to Entity.Id (native Web API bulk bodies carry it).
    if (Object.hasOwn(target.attributes, primary) && !samePrimary(target, primary))
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
  // One request identity for the bulk message and every record it delegates (native bulk: all contexts of one request,
  // queued jobs included, share RequestId and CorrelationId).
  const operationIdentity = {};
  initializePluginOperation(operationIdentity, store, store.pluginParentContext ?? pluginInvocationSdkParent(store));
  let bulkFrameStarted = false,
    submittedTargets;
  const bulkFrame = () => {
    if (bulkFrameStarted) return {};
    bulkFrameStarted = true;
    return { initialFrame: structuredClone(operationIdentity) };
  };
  const requestIdentity = () => {
    const source = finalBulkFrame ?? operationIdentity;
    return Object.fromEntries(
      ['requestId', 'operationId', 'correlationId', 'createdOn', 'createdOnWire']
        .filter((key) => source[key] !== undefined)
        .map((key) => [key, structuredClone(source[key])]),
    );
  };
  // The bulk message's context of a stage, which every delegated record's step sees as its parent: PreValidation's has
  // only the request tag as input, PreOperation's and PostOperation's none and the CreateMultiple/30 main operation as
  // their own parent (native bulk; owned by the bulk step that ran last in that stage).
  const tagOf = () => (delegated ? undefined : (finalBulkFrame?.requestTag ?? store.pluginSdkTag));
  const stageSource = (stage, step) => ({
    operation,
    messageName: messageNameOf(operation),
    entity: mapping.logicalName,
    primaryId: emptyId,
    stage,
    ...(step
      ? {
          owningExtension: {
            $type: 'EntityReference',
            logicalName: 'sdkmessageprocessingstep',
            id: step.id,
            name: step.name ?? null,
          },
        }
      : {}),
    inputParameters: {
      $type: 'ParameterCollection',
      values: stage === 10 && tagOf() !== undefined ? { tag: tagOf() } : {},
    },
    sharedVariables: structuredClone(finalBulkFrame?.sharedVariables ?? { $type: 'ParameterCollection', values: {} }),
    frame: requestIdentity(),
    ...(finalBulkFrame?.operationDepth ? { depth: finalBulkFrame.operationDepth } : {}),
    isInTransaction: store.pluginInTransaction === true,
    ...(stage === 10
      ? {}
      : {
          parent: {
            operation,
            messageName: messageNameOf(operation),
            entity: mapping.logicalName,
            primaryId: emptyId,
            inputParameters: {
              $type: 'ParameterCollection',
              values: {
                Targets: structuredClone(
                  finalBulkFrame?.mainOperationTargets ??
                    bulkTargetsCollection(mapping.logicalName, submittedTargets, { submitted: true }),
                ),
                ...(tagOf() === undefined ? {} : { tag: tagOf() }),
              },
            },
            sharedVariables: structuredClone(
              finalBulkFrame?.mainSharedVariables ??
                finalBulkFrame?.sharedVariables ?? { $type: 'ParameterCollection', values: {} },
            ),
            frame: requestIdentity(),
            ...(finalBulkFrame?.operationDepth ? { depth: finalBulkFrame.operationDepth } : {}),
            isInTransaction: true,
          },
        }),
  });
  // One record's pipeline at a stage, under the bulk message's stage context.
  const recordPhase = function* (stage, records, index, context, step, extra = {}) {
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
      bulkParent: stageSource(stage, step),
      ...extra,
    });
    {
      const encoded = recordToSdkEntity(store, mapping.logicalName, singleFrame.target);
      if (!Object.hasOwn(target.attributes, primary) || !samePrimary(encoded, primary))
        delete encoded.attributes[primary];
      target.attributes = encoded.attributes;
    }
  };
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
          (Object.hasOwn(target.attributes, primary) && !samePrimary(target, primary)) ||
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
      systemParameters,
      sdkFromSandbox,
      bypassCustomPlugins,
      ...(concurrencyBehavior === undefined ? {} : { bulkConcurrencyBehavior: concurrencyBehavior }),
      ...(delegated ? { inheritsRequestTag: false } : {}),
      ...(awaitIo ? { awaitIo: true } : {}),
    };
    if (store.pluginPipeline) {
      let stageStep = null;
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
              ...bulkFrame(),
            });
            bulkStarted = true;
            stageStep = entry;
            finalBulkFrame = frame;
            if (stage === 40) handoffPluginResponse(store, operation, mapping.logicalName, frame, responseToken);
          } else {
            yield* recordPhase(stage, records, index, context, stageStep, {
              pluginStepIds: [entry.id],
              continuePhase: singleStarted.has(index),
            });
            singleStarted.add(index);
          }
          check();
        }
      } else {
        // Without a step catalogue the host's pipeline orders each message's steps: the bulk message's first, then
        // every record's own (the native bulk order).
        if (
          store.pluginPipelineActive({ entity: mapping.logicalName, operation, bypassCustomPlugins, bypassStepIds })
        ) {
          const frame = yield store.pluginPipeline({ ...context, ...bulkFrame() });
          finalBulkFrame = frame;
          if (stage === 40) handoffPluginResponse(store, operation, mapping.logicalName, frame, responseToken);
          check();
        }
        if (
          store.pluginPipelineActive({
            entity: mapping.logicalName,
            operation: single,
            bypassCustomPlugins,
            bypassStepIds,
          })
        )
          for (const index of targets.keys()) {
            yield* recordPhase(stage, records, index, context, null);
            check();
          }
      }
    }
    check();
  };
  try {
    submittedTargets = structuredClone(targets);
    yield* phase(10, []);
    const stamped = targets.map((target, index) => {
      const values = Object.fromEntries(
        Object.entries(preOperationStamps[index] ?? {}).filter(([name]) => !Object.hasOwn(target.attributes, name)),
      );
      target.attributes = {
        ...target.attributes,
        ...recordToSdkEntity(store, mapping.logicalName, values, { allColumns: true, target: true }).attributes,
      };
      return values;
    });
    yield* phase(20, []);
    // Preimages retain the original request snapshot. Authorization must see
    // current rows after every stage20 SDK side effect, for every target before
    // the first bulk primary write.
    const writes = writeIndexes.map((index) => {
      const target = targets[index];
      const values = sdkValueToRecord(target);
      // Stamps no step changed are the main operation's to derive again.
      for (const [name, value] of Object.entries(stamped[index]))
        if (isDeepStrictEqual(values[name], value)) delete values[name];
      if (update) delete values[primary];
      const current = update ? store.get(entity, target.id, identity, { skipPluginRead: true }) : null;
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
            // Every record ran its own message's steps in the phases above.
            skipPluginPipeline: true,
            deferCommittedEvent: true,
            bypassCustomAsync,
            bypassStepIds,
            postWriteEffects,
            targetIndex: index,
          })
        : update
          ? store.updateRecord(entity, target.id, data, identity, {
              coerce: true,
              bypassCustomPlugins,
              // Every record ran its own message's steps in the phases above.
              skipPluginPipeline: true,
              deferCommittedEvent: true,
              bypassCustomAsync,
              bypassStepIds,
            })
          : store.createRecord(entity, data, identity, {
              coerce: true,
              bypassCustomPlugins,
              // Every record ran its own message's steps in the phases above.
              skipPluginPipeline: true,
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
