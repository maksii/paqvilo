import { cloneStateData } from './state-clone.mjs';
import { uuidV5 } from './dataverse-security.mjs';

/** A CLR invocation envelope separates scalar context from its parameter and
 * image collections. Reassemble a detached per-step SDK parent snapshot. */
export function clrSdkEntryContext(input) {
  return {
    $type: 'ExecutionContext',
    values: cloneStateData({
      ...input.context,
      InputParameters: input.inputParameters ?? { $type: 'ParameterCollection', values: {} },
      OutputParameters: input.outputParameters ?? { $type: 'ParameterCollection', values: {} },
      SharedVariables: input.sharedVariables ?? { $type: 'ParameterCollection', values: {} },
      PreEntityImages: { $type: 'EntityImageCollection', values: input.preImages ?? {} },
      PostEntityImages: { $type: 'EntityImageCollection', values: input.postImages ?? {} },
    }),
  };
}

/** Bare HTTP PATCH delegates through an outer Upsert main operation. Its SDK
 * parent is that framework frame, rather than the currently executing Update
 * step. The hidden system step identity is unavailable from ordinary exports. */
export function selectSdkEntryParent(entry, frameworkSource) {
  const snapshot = cloneStateData(entry);
  if (frameworkSource?.operation !== 'upsert' || snapshot?.values?.Mode === 1 || snapshot?.values?.Stage !== 20)
    return snapshot;
  const values = {
    ...snapshot.values,
    MessageName: 'Upsert',
    Stage: 30,
    PrimaryEntityName: 'none',
    PrimaryEntityId: { $type: 'Guid', value: '00000000-0000-0000-0000-000000000000' },
    SecondaryEntityName: 'none',
    Mode: 0,
    IsInTransaction: true,
    IsolationMode: 2,
    InputParameters: {
      $type: 'ParameterCollection',
      values: { Target: cloneStateData(frameworkSource.target), ReturnRowVersion: null },
    },
    OutputParameters: { $type: 'ParameterCollection', values: {} },
    SharedVariables: cloneStateData(
      frameworkSource.sharedVariables ?? {
        $type: 'ParameterCollection',
        values: { AcceptLang: frameworkSource.acceptLanguage ?? '', IsAutoTransact: false },
      },
    ),
    PreEntityImages: { $type: 'EntityImageCollection', values: {} },
    PostEntityImages: { $type: 'EntityImageCollection', values: {} },
    PreEntityImagesCollection: { $type: 'EntityImageCollectionArray', values: [] },
    PostEntityImagesCollection: { $type: 'EntityImageCollectionArray', values: [] },
    ParentContext: null,
    OwningExtension: mainOperationValues({ MessageName: 'Upsert' }).OwningExtension,
  };
  return { $type: 'ExecutionContext', values };
}

/** Qualified fields of an asynchronous multiple-message main frame. Parent
 * user/organization/secondary/owning-step fields and opaque platform Shared
 * values remain unavailable; never substitute the registered step's values. */
export function asyncMultiplePluginParent(frame, operation, entity) {
  const source = frame.asyncSourceParent;
  if (!source || !['createmultiple', 'updatemultiple'].includes(operation)) return undefined;
  const values = {
    MessageName: operation === 'createmultiple' ? 'CreateMultiple' : 'UpdateMultiple',
    PrimaryEntityName: entity,
    PrimaryEntityId: { $type: 'Guid', value: source.primaryId },
    Stage: 30,
    Mode: 1,
    Depth: frame.operationDepth,
    IsInTransaction: false,
    IsolationMode: 2,
    InputParameters: cloneStateData(source.inputParameters),
    OutputParameters: { $type: 'ParameterCollection', values: {} },
    SharedVariables: cloneStateData(source.sharedVariables ?? { $type: 'ParameterCollection', values: {} }),
    PreEntityImages: { $type: 'EntityImageCollection', values: {} },
    PostEntityImages: { $type: 'EntityImageCollection', values: {} },
  };
  for (const [name, key] of [
    ['RequestId', 'requestId'],
    ['OperationId', 'operationId'],
    ['CorrelationId', 'correlationId'],
  ])
    if (frame[key] != null) values[name] = { $type: 'Guid', value: frame[key] };
  if (frame.createdOnWire) values.OperationCreatedOn = cloneStateData(frame.createdOnWire);
  return { $type: 'ExecutionContext', values };
}

/** The platform step that performs a message's main operation (stage 30), as native contexts name it. */
const MAIN_OPERATION_STEP = 'ObjectModel Implementation';
const emptyParameters = () => ({ $type: 'ParameterCollection', values: {} });

/** Values of a main-operation (stage 30) context: native reports the PreValidation context of the same request
 * as this frame, inside the transaction, owned by the platform's ObjectModel step, with the main operation's live
 * SharedVariables and image collection and no step images. */
function mainOperationValues(values, { sharedVariables, images } = {}) {
  return {
    ...values,
    Stage: 30,
    Mode: 0,
    IsInTransaction: true,
    OwningExtension: {
      $type: 'EntityReference',
      logicalName: 'sdkmessageprocessingstep',
      id: uuidV5(
        '00000000-0000-0000-0000-000000000000',
        `sdkmessageprocessingstep:${MAIN_OPERATION_STEP}:${values.MessageName}`,
      ),
      name: MAIN_OPERATION_STEP,
    },
    SharedVariables: cloneStateData(sharedVariables ?? values.SharedVariables ?? emptyParameters()),
    PreEntityImages: { $type: 'EntityImageCollection', values: {} },
    PostEntityImages: { $type: 'EntityImageCollection', values: {} },
    PreEntityImagesCollection: images ?? { $type: 'EntityImageCollectionArray', values: [] },
    PostEntityImagesCollection: { $type: 'EntityImageCollectionArray', values: [] },
  };
}

/** The ParentContext of a CRUD PreOperation/PostOperation step: the request's PreValidation snapshot when a
 * PreValidation step ran, else the current context reduced to the PreValidation inputs. Natively the main
 * operation runs as the caller (never an impersonating step's user). */
export function mainOperationParent({ frame, context, parent, callerUserId, objectId, inputs, images }) {
  const snapshot = frame.preValidationContext?.values;
  const base = snapshot
    ? cloneStateData(snapshot)
    : {
        ...cloneStateData(context),
        InputParameters: { $type: 'ParameterCollection', values: inputs() },
        OutputParameters: emptyParameters(),
        ParentContext: parent ?? null,
      };
  base.UserId = { $type: 'Guid', value: callerUserId };
  base.UserAzureActiveDirectoryObjectId = { $type: 'Guid', value: objectId(callerUserId) };
  return {
    $type: 'ExecutionContext',
    values: mainOperationValues(base, { sharedVariables: frame.mainSharedVariables, images }),
  };
}

/** Native async parents hold at most three frames (corpus depth.json: Depth 2-10 jobs all report X/30 < X/40 < X/30). */
const ASYNC_PARENT_FRAMES = 3;

/** An asynchronous job's ParentContext: the parent chain its message's synchronous PostOperation step sees, cut after
 * three frames. Each frame keeps its stage, inputs, outputs, shared variables, entity name and identities, but reports
 * the job's mode, depth, message, operation row (a bridged multiple's single row), isolation, step (unnamed),
 * operation id and creation time, outside a
 * transaction, with no images (native corpus: depth, bulk, faults, ownerAndState, customApi asynchronous contexts and
 * their web hook copies). */
export function asynchronousParentChain(
  node,
  context,
  { remaining = ASYNC_PARENT_FRAMES, primaryEntityId = context.PrimaryEntityId } = {},
) {
  if (!node?.values || remaining <= 0) return null;
  return {
    $type: 'ExecutionContext',
    values: {
      ...node.values,
      Mode: 1,
      Depth: context.Depth,
      MessageName: context.MessageName,
      PrimaryEntityId: cloneStateData(primaryEntityId),
      IsInTransaction: false,
      IsolationMode: context.IsolationMode,
      OwningExtension: cloneStateData(context.OwningExtension),
      OperationId: cloneStateData(context.OperationId),
      OperationCreatedOn: cloneStateData(context.OperationCreatedOn),
      PreEntityImages: { $type: 'EntityImageCollection', values: {} },
      PostEntityImages: { $type: 'EntityImageCollection', values: {} },
      PreEntityImagesCollection: { $type: 'EntityImageCollectionArray', values: [] },
      PostEntityImagesCollection: { $type: 'EntityImageCollectionArray', values: [] },
      ParentContext: asynchronousParentChain(node.values.ParentContext, context, {
        remaining: remaining - 1,
        primaryEntityId,
      }),
    },
  };
}

/** The caller chain a committed message event keeps for its asynchronous jobs: the synchronous step parent
 * (store.pluginParentContext, else the invoking plug-in's SDK context), cut to the frames a job can report. */
export function asyncCallerParent(parent, remaining = ASYNC_PARENT_FRAMES) {
  if (!parent?.values || remaining <= 0) return null;
  const { ParentContext: next, ...values } = parent.values;
  return {
    $type: 'ExecutionContext',
    values: { ...cloneStateData(values), ParentContext: asyncCallerParent(next, remaining - 1) },
  };
}

/** A bridged multiple job's ParentContext: the single operation's main frame over its synchronous caller chain, relabelled
 * as the job but naming the single row (native depth, faults, pipelineEffects: CreateMultiple/30 < CreateMultiple/40 <
 * CreateMultiple/30 for a nested Create, CreateMultiple/30 < CreateMultiple/10 under a PreValidation step). */
export function asyncMultipleJobParent(frame, operation, entity, context) {
  const main = asyncMultiplePluginParent(frame, operation, entity);
  if (!main) return undefined;
  main.values.ParentContext = frame.asyncCallerParent ?? null;
  return asynchronousParentChain(main, context, { primaryEntityId: main.values.PrimaryEntityId });
}
