import { mainOperationStep } from './plugin-sdk-parent.mjs';
import { currentRequest } from './request-context.mjs';

const upsertIdentities = new WeakMap();
// The request identity of the Upsert main operation an inbound request runs: its existence read and the Create or Update
// it then runs share it (native crud: a PATCH's RetrieveMultiple and Update carry one RequestId, OperationId and
// CorrelationId).
function upsertRequestIdentity() {
  const request = currentRequest();
  if (!request?.ids) return {};
  let identity = upsertIdentities.get(request);
  if (!identity) {
    const requestId = request.ids.uuid();
    identity = { requestId, operationId: requestId, correlationId: request.ids.uuid() };
    upsertIdentities.set(request, identity);
  }
  return { ...identity };
}

/** A platform single-to-multiple delegation is a core main-operation parent at the same plug-in depth, owned by the
 * message's ObjectModel step on its table (native Upsert/30, UpsertMultiple/30, CreateMultiple/30, UpdateMultiple/30). */
export function delegatedPluginParent(source, context, executionUserId) {
  const values = {
    ...context,
    MessageName: source.messageName ?? source.operation[0].toUpperCase() + source.operation.slice(1),
    // An Upsert main operation names no primary table (native bare-PATCH parent: PrimaryEntityName none).
    PrimaryEntityName: source.operation === 'upsert' ? 'none' : source.entity,
    PrimaryEntityId: { $type: 'Guid', value: source.primaryId },
    // A bulk message's stage context (the parent of the records it delegates) keeps that stage.
    Stage: source.stage ?? 30,
    Mode: 0,
    Depth: source.depth ?? context.Depth,
    IsInTransaction: context.IsInTransaction,
    UserId: { $type: 'Guid', value: executionUserId },
    InputParameters: source.inputParameters ?? { $type: 'ParameterCollection', values: { Target: source.target } },
    OutputParameters: source.frame?.outputParameters ?? { $type: 'ParameterCollection', values: {} },
    SharedVariables: source.sharedVariables ??
      source.frame?.sharedVariables ?? { $type: 'ParameterCollection', values: {} },
    PreEntityImages: { $type: 'EntityImageCollection', values: {} },
    PostEntityImages: { $type: 'EntityImageCollection', values: {} },
    PreEntityImagesCollection: { $type: 'EntityImageCollectionArray', values: [] },
    PostEntityImagesCollection: { $type: 'EntityImageCollectionArray', values: [] },
  };
  // A bulk message's stage context is owned by its step; a main operation by the message's ObjectModel step.
  values.OwningExtension = source.owningExtension
    ? structuredClone(source.owningExtension)
    : mainOperationStep(values.MessageName, values.PrimaryEntityName);
  delete values.trace;
  for (const [field, key, type] of [
    ['CorrelationId', 'correlationId', 'Guid'],
    ['OperationId', 'operationId', 'Guid'],
    ['RequestId', 'requestId', 'Guid'],
    ['OperationCreatedOn', 'createdOn', 'DateTime'],
  ])
    if (source.frame?.[key] != null) values[field] = { $type: type, value: source.frame[key] };
  if (source.frame?.createdOnWire) values.OperationCreatedOn = structuredClone(source.frame.createdOnWire);
  // A main operation run inside an Upsert has that Upsert as its own parent.
  if (source.parent) values.ParentContext = delegatedPluginParent(source.parent, context, executionUserId);
  return { $type: 'ExecutionContext', values };
}

/** The Upsert main operation a bare Web API PATCH runs under (native recorder parity corpus, upsert): it names no
 * primary table, carries the inner message's Target with ReturnRowVersion and shares only the framework variables
 * (IsAutoTransact false, AcceptLang, the request tag). Its IsInTransaction is the observing step's. */
export function upsertSourceOperation({ target, id, acceptLanguage = '', tag, identity, depth }) {
  const withTag = (values) => (tag === undefined ? values : { ...values, tag });
  return {
    operation: 'upsert',
    entity: 'none',
    primaryId: '00000000-0000-0000-0000-000000000000',
    target: { ...target, id: id ?? target.id },
    inputParameters: {
      $type: 'ParameterCollection',
      values: withTag({ Target: { ...target, id: id ?? target.id }, ReturnRowVersion: null }),
    },
    sharedVariables: {
      $type: 'ParameterCollection',
      values: withTag({ IsAutoTransact: false, AcceptLang: acceptLanguage }),
    },
    frame: upsertRequestIdentity(),
    identity,
    depth,
  };
}
