import { DataError } from './data-error.mjs';
import { pluginExecutionDepth, recordToSdkEntity } from './plugin-clr.mjs';
import { sdkValueToRecord } from './local-organization-service.mjs';
import { pluginInvocationDepth, pluginInvocationSdkParent } from './plugin-execution-lifetime.mjs';
import { pluginStepBypassed } from './plugin-bypass.mjs';
import { pluginStepMatchesEntity } from './exported-plugins.mjs';
import { upsertSourceOperation } from './plugin-delegation.mjs';

const empty = '00000000-0000-0000-0000-000000000000';
const operationFields = ['requestId', 'operationId', 'correlationId', 'createdOn', 'createdOnWire', 'operationDepth'];
export const multipleMessage = (operation) => ({ create: 'createmultiple', update: 'updatemultiple' })[operation];

/** Single-origin requests merge single and multiple registrations by rank in
 * each stage. Bulk-origin requests have their separate grouped ordering. */
export function singleMultiplePipeline(store, items, execute) {
  const frames = new WeakMap();
  return (context) => {
    const operation = multipleMessage(context.operation);
    if (
      !operation ||
      context.pluginStepIds ||
      !items().some(
        (step) =>
          step.enabled &&
          step.contract?.supportedDeployment !== 1 &&
          !pluginStepBypassed(step, context) &&
          pluginStepMatchesEntity(step, context.entity) &&
          String(step.message).toLowerCase() === operation &&
          (step.contract?.mode ?? 0) === 0,
      )
    )
      return execute(context);
    const mapping = store.resolveMapping(context.entity),
      primary = mapping.idColumn;
    let frame = frames.get(context.record);
    if (!frame || context.stage === 10) {
      frame = {
        record: { [primary]: empty },
        targets: [],
        authoredPrimary: Object.hasOwn(context.target ?? {}, primary),
        operationMetadata: {},
      };
      frames.set(context.record, frame);
    }
    // PreOperation starts its own wrapper identity. Actual scalar
    // invocations advance it in rank order; the final PreOperation value then
    // carries into PostOperation. PreValidation does not supply that value.
    if (context.stage === 20) frame.record[primary] = empty;
    const sourceInputTarget = frame.singleFrame?.inputParameters?.values?.Target;
    if (
      context.operation === 'update' &&
      sourceInputTarget?.$type === 'Entity' &&
      frame.singleFrame.inputParametersStage !== context.stage
    )
      sourceInputTarget.id = context.record[primary];
    const currentTargetId = () => frame.singleFrame?.inputParameters?.values?.Target?.id ?? context.record[primary];
    const encodeMultipleTarget = () => {
      const target = recordToSdkEntity(
        store,
        mapping.logicalName,
        context.operation === 'update' ? { ...context.target, [primary]: context.record[primary] } : context.target,
        { allColumns: true, submitted: context.stage === 10, target: true, postOperation: context.stage === 40 },
      );
      target.id = currentTargetId();
      if (context.operation === 'create' && !frame.authoredPrimary && context.stage === 10)
        delete target.attributes[primary];
      return target;
    };
    if (context.stage === 40) frame.record.bulkIds = [context.record[primary]];
    const applyMultiple = (multipleFrame) => {
      frame.multipleFrame = multipleFrame;
      const next = frame.targets[0];
      if (
        frame.targets.length !== 1 ||
        next?.$type !== 'Entity' ||
        next.logicalName !== mapping.logicalName ||
        typeof next.id !== 'string' ||
        next.id.toLowerCase() !== String(currentTargetId()).toLowerCase()
      )
        throw new DataError(
          'A multiple-message step invoked by a single request must preserve its one bound target identity.',
          501,
          'LocalPluginBulkUnsupported',
        );
      {
        const values = sdkValueToRecord(next),
          retainsEmptyPrimary =
            context.operation === 'create' &&
            context.stage === 10 &&
            context.target[primary] === empty &&
            values[primary] === empty;
        // The Update wrapper materializes its identity Attribute separately
        // from the original scalar Target and its authored/filtering columns.
        // A changed key remains visible to the normal immutable-key validator.
        if (
          context.operation === 'update' &&
          !Object.hasOwn(context.target, primary) &&
          values[primary] === context.record[primary]
        )
          delete values[primary];
        for (const key of Object.keys(context.target))
          if (!Object.hasOwn(values, key) && key !== primary) {
            delete context.target[key];
            if (context.stage !== 40) {
              if (context.previous && Object.hasOwn(context.previous, key)) context.record[key] = context.previous[key];
              else delete context.record[key];
            }
          }
        Object.assign(context.target, values);
        if (context.stage !== 40)
          for (const [key, value] of Object.entries(values))
            if (key !== primary || !retainsEmptyPrimary) context.record[key] = value;
      }
    };
    const entries = items()
      .filter(
        (step) =>
          step.enabled &&
          step.contract?.supportedDeployment !== 1 &&
          !pluginStepBypassed(step, context) &&
          pluginStepMatchesEntity(step, context.entity) &&
          (step.contract?.mode ?? 0) === 0 &&
          step.stage === context.stage &&
          [operation, context.operation].includes(String(step.message).toLowerCase()),
      )
      .sort((a, b) => a.rank - b.rank || a.id.localeCompare(b.id));
    let singleStarted = false,
      multipleStarted = false;
    const run = (index) => {
      if (index === entries.length) {
        if (
          context.stage === 40 &&
          frame.multipleFrame?.inputParametersStage === 40 &&
          frame.multipleFrame.inputParameters?.values?.Targets?.$type === 'EntityCollection'
        ) {
          const encoded = encodeMultipleTarget();
          const prior = frame.multipleFrame.inputParameters.values.Targets.entities[0] ?? {};
          frame.multipleFrame.inputParameters.values.Targets.entities = [
            { ...prior, id: currentTargetId(), attributes: encoded.attributes },
          ];
        }
        const singleFrame = { ...frame.operationMetadata, ...(frame.singleFrame ?? {}) };
        if (!frame.singleFrame && frame.multipleFrame) {
          singleFrame.suppliedRequestId = frame.multipleFrame.suppliedRequestId;
          singleFrame.requestTag = frame.multipleFrame.requestTag;
          if (singleFrame.requestTag !== undefined)
            singleFrame.sharedVariables = {
              $type: 'ParameterCollection',
              values: { tag: singleFrame.requestTag },
            };
        }
        return { ...singleFrame, multipleFrame: frame.multipleFrame ?? {} };
      }
      const entry = entries[index],
        multiple = String(entry.message).toLowerCase() === operation;
      const base = { ...context, pluginStepIds: [entry.id] };
      if (multiple) {
        const target = encodeMultipleTarget();
        frame.targets.splice(0, frame.targets.length, target);
        const parent = store.pluginParentContext ?? pluginInvocationSdkParent(store);
        const priorValues = { ...(frame.multipleFrame?.inputParameters?.values ?? {}) };
        const concurrencyBehavior = priorValues.ConcurrencyBehavior ?? {
          $type: 'ConcurrencyBehavior',
          value: context.concurrencyBehavior ?? 0,
        };
        delete priorValues.Targets;
        if (context.operation === 'update') {
          delete priorValues.FromSandbox;
          delete priorValues.ConcurrencyBehavior;
        }
        const inputParameters = {
          ...(frame.multipleFrame?.inputParameters ?? {}),
          $type: 'ParameterCollection',
          values: {
            ...(context.operation === 'update'
              ? {
                  ...(context.stage === 10 && context.sdkFromSandbox === true ? { FromSandbox: true } : {}),
                  // A named message's own Update has no ConcurrencyBehavior input (plugin-platform-messages.mjs).
                  ...(context.concurrencyBehavior === null ? {} : { ConcurrencyBehavior: concurrencyBehavior }),
                }
              : {}),
            ...priorValues,
            Targets: {
              ...(frame.multipleFrame?.inputParameters?.values?.Targets ?? {}),
              $type: 'EntityCollection',
              entities: frame.targets,
            },
          },
        };
        const upsertOrigin = context.preValidationSourceOperation === 'upsert',
          preValidationUpsert = upsertOrigin && context.stage === 10;
        // The single message's main operation Target is the one PreValidation left (context.mainTarget).
        const mainTarget = context.stage === 10 ? context.target : (context.mainTarget ?? context.target);
        const sourceTarget =
          context.operation === 'update'
            ? recordToSdkEntity(
                store,
                mapping.logicalName,
                { ...mainTarget, [primary]: context.record[primary] },
                { allColumns: true, submitted: true, target: true },
              )
            : {
                ...recordToSdkEntity(
                  store,
                  mapping.logicalName,
                  // The Create main operation's Target names its allocated key (native Create/30 parent).
                  context.stage === 10 ? mainTarget : { ...mainTarget, [primary]: context.record[primary] },
                  { allColumns: true, submitted: true, target: true },
                ),
                id: currentTargetId(),
              };
        // A nested caller's SDK parent is the depth-1 step (plugin-clr.mjs dispatchSdkCall); executing CLR steps count.
        const depth = Math.max(
          pluginExecutionDepth() + 1,
          pluginInvocationDepth(store) + 1,
          Number(parent?.values?.Depth ?? 0) + 1,
        );
        const upsertSource = () =>
          upsertSourceOperation({
            target:
              context.stage === 10
                ? sourceTarget
                : context.operation === 'update'
                  ? recordToSdkEntity(
                      store,
                      mapping.logicalName,
                      { ...mainTarget, [primary]: context.record[primary] },
                      { allColumns: true, submitted: true, target: true },
                    )
                  : {
                      ...recordToSdkEntity(store, mapping.logicalName, mainTarget, {
                        allColumns: true,
                        submitted: true,
                        target: true,
                      }),
                      id: currentTargetId(),
                    },
            acceptLanguage: context.acceptLanguage,
            tag: store.pluginSdkTag,
            identity: context.identity,
            depth,
          });
        Object.assign(base, {
          operation,
          record: frame.record,
          targets: frame.targets,
          previousRecords: [context.previous ?? null],
          records: context.stage === 40 ? [context.record] : [],
          target: undefined,
          changedAttributes: Object.keys(target.attributes),
          continuePhase: multipleStarted,
          initialFrame: {
            ...(frame.multipleFrame ?? {}),
            ...frame.operationMetadata,
            inputParameters,
            inputParametersStage: context.stage,
            ...(context.stage === 10 && !preValidationUpsert
              ? {}
              : preValidationUpsert
                ? { delegatedSourceOperation: upsertSource() }
                : {
                    delegatedSourceOperation: {
                      ...(upsertOrigin ? { parent: upsertSource() } : {}),
                      operation: context.operation,
                      entity: context.entity,
                      primaryId: context.record[primary],
                      target: sourceTarget,
                      ...(context.operation === 'update'
                        ? {
                            inputParameters: {
                              $type: 'ParameterCollection',
                              values: {
                                Target: sourceTarget,
                                ...(context.sdkFromSandbox === true ? { FromSandbox: true } : {}),
                                ConcurrencyBehavior: concurrencyBehavior,
                              },
                            },
                          }
                        : {}),
                      frame: frame.singleFrame ?? {},
                      identity: context.identity,
                      depth,
                      isInTransaction: store.pluginInTransaction === true,
                    },
                  }),
          },
        });
        multipleStarted = true;
      } else {
        base.initialFrame = { ...(frame.singleFrame ?? {}), ...frame.operationMetadata };
        base.onStepExecuted = () => {
          frame.record[primary] = context.record[primary];
        };
        base.changedAttributes =
          context.operation === 'update' ? Object.keys(context.target) : context.changedAttributes;
        base.continuePhase = singleStarted;
        singleStarted = true;
      }
      const result = execute(base);
      const finish = (answer) => {
        // Both message lanes belong to this same operation. Publish only known
        // identity metadata after execution, so the first actual adapter keeps
        // its observed timestamp precedence and lane-specific inputs stay apart.
        for (const key of operationFields)
          if (frame.operationMetadata[key] == null && answer?.[key] != null)
            frame.operationMetadata[key] = structuredClone(answer[key]);
        if (multiple) applyMultiple(answer);
        else frame.singleFrame = answer;
        return run(index + 1);
      };
      return result?.then ? result.then(finish) : finish(result);
    };
    return run(0);
  };
}
