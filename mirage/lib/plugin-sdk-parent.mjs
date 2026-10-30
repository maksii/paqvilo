import { cloneStateData } from './state-clone.mjs';

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
    SharedVariables: {
      $type: 'ParameterCollection',
      values: { AcceptLang: frameworkSource.acceptLanguage ?? '', IsAutoTransact: false },
    },
    PreEntityImages: { $type: 'EntityImageCollection', values: {} },
    PostEntityImages: { $type: 'EntityImageCollection', values: {} },
    PreEntityImagesCollection: { $type: 'EntityImageCollectionArray', values: [] },
    PostEntityImagesCollection: { $type: 'EntityImageCollectionArray', values: [] },
    ParentContext: null,
  };
  delete values.OwningExtension;
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
