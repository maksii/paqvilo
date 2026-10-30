/** A platform single-to-multiple delegation is a core main-operation parent at
 * the same plug-in depth. Its hidden internal step identity is not fabricated. */
export function delegatedPluginParent(source, context, executionUserId) {
  const values = {
    ...context,
    MessageName: source.operation[0].toUpperCase() + source.operation.slice(1),
    PrimaryEntityName: source.entity,
    PrimaryEntityId: { $type: 'Guid', value: source.primaryId },
    Stage: 30,
    Mode: 0,
    Depth: source.depth ?? context.Depth,
    IsInTransaction: source.isInTransaction ?? context.IsInTransaction,
    UserId: { $type: 'Guid', value: executionUserId },
    InputParameters: source.inputParameters ?? { $type: 'ParameterCollection', values: { Target: source.target } },
    OutputParameters: source.frame?.outputParameters ?? { $type: 'ParameterCollection', values: {} },
    SharedVariables: source.frame?.sharedVariables ?? { $type: 'ParameterCollection', values: {} },
    PreEntityImages: { $type: 'EntityImageCollection', values: {} },
    PostEntityImages: { $type: 'EntityImageCollection', values: {} },
  };
  delete values.OwningExtension;
  delete values.trace;
  delete values.PreEntityImagesCollection;
  delete values.PostEntityImagesCollection;
  for (const [field, key, type] of [
    ['CorrelationId', 'correlationId', 'Guid'],
    ['OperationId', 'operationId', 'Guid'],
    ['RequestId', 'requestId', 'Guid'],
    ['OperationCreatedOn', 'createdOn', 'DateTime'],
  ])
    if (source.frame?.[key] != null) values[field] = { $type: type, value: source.frame[key] };
  if (context.UserId?.value !== executionUserId) delete values.BusinessUnitId;
  return { $type: 'ExecutionContext', values };
}
