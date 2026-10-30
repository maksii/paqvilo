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
    OwningExtension: mainOperationStep('Upsert', 'none'),
  };
  return { $type: 'ExecutionContext', values };
}

/** Qualified fields of an asynchronous multiple-message main frame. The job's request, caller, organization and
 * environment facts and its own step complete it when observed (observedParentChain); opaque platform Shared values
 * are not invented. */
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
const emptyImageCollections = () => ({ $type: 'EntityImageCollectionArray', values: [] });

/** The ObjectModel Implementation step of a message on a table. Native step ids are generated per environment and
 * are stable per message and table (recorded Create on two tables, Update, Upsert/none, UpsertMultiple/none), so only
 * that identity structure is reproduced. */
export function mainOperationStep(messageName, entity) {
  return {
    $type: 'EntityReference',
    logicalName: 'sdkmessageprocessingstep',
    id: uuidV5(
      '00000000-0000-0000-0000-000000000000',
      `sdkmessageprocessingstep:${MAIN_OPERATION_STEP}:${messageName}:${entity ?? 'none'}`,
    ),
    name: MAIN_OPERATION_STEP,
  };
}

// Request, caller, organization and environment facts a platform frame shares with the context that observes it.
const OBSERVED_FACTS = [
  'UserId',
  'InitiatingUserId',
  'BusinessUnitId',
  'OrganizationId',
  'OrganizationName',
  'SecondaryEntityName',
  'IsolationMode',
  'IsExecutingOffline',
  'IsOfflinePlayback',
  'InitiatingUserAzureActiveDirectoryObjectId',
  'InitiatingUserApplicationId',
  'PortalsContactId',
  'IsPortalsClientCall',
  'AuthenticatedUserId',
  'EnvironmentId',
  'TenantId',
  'IsApplicationUser',
  'CorrelationId',
  'RequestId',
  'OperationId',
  'OperationCreatedOn',
];

// ponytail: the root changes of the latest 256 requests; an asynchronous job of an older request keeps its snapshot.
const REQUEST_ROOT_LIMIT = 256;

/** Records what a request changed in its root SharedVariables collection: the outermost main operation of the
 * request, as every ancestor chain shows it live (native: ChangedEntityTypes appears only on the root ancestor, also
 * for tables a nested plug-in request wrote, and principalobjectaccess with POADistributionChanged after a sharing
 * message). table is the ChangedEntityTypes key; sharing marks a principalobjectaccess change. */
export function recordRequestRootChange(store, requestId, { table, sharing = false } = {}) {
  if (!store || !requestId || (!table && !sharing)) return;
  const roots = (store.pluginRequestRoots ??= new Map());
  let root = roots.get(requestId);
  if (!root) {
    roots.set(requestId, (root = {}));
    if (roots.size > REQUEST_ROOT_LIMIT) roots.delete(roots.keys().next().value);
  }
  for (const key of [table, sharing ? 'principalobjectaccess' : null].filter(Boolean))
    root.ChangedEntityTypes = { ...(root.ChangedEntityTypes ?? {}), [key]: 'Update' };
  // The recorded platform value after GrantAccess, ModifyAccess and RevokeAccess.
  if (sharing) root.POADistributionChanged = 10760;
}

/** The ParentContext chain as a step observes it. Native never leaves an ancestor property unavailable: a platform
 * frame (main operation, framework Upsert, refused DeleteMultiple) carries the request's identity, organization and
 * environment, the ObjectModel step (an asynchronous job's own step) and empty image collections. Every ancestor reports the observing context's
 * IsInTransaction and InitiatingUserAgent (recorded corpus: 855 synchronous ancestor samples, depth chains whose d1
 * ancestors read '' from a plug-in's request). The root ancestor shows its request's live root changes
 * (recordRequestRootChange); a stage-30 frame never carries the Create telemetry root. objectId(userId) answers a
 * user's Azure AD object id; roots is the store's request root registry. */
export function observedParentChain(node, context, objectId, roots) {
  if (!node?.values) return node ?? null;
  const values = { ...node.values };
  for (const key of OBSERVED_FACTS)
    if (!Object.hasOwn(values, key) && Object.hasOwn(context, key)) values[key] = cloneStateData(context[key]);
  if (!Object.hasOwn(values, 'UserAzureActiveDirectoryObjectId'))
    values.UserAzureActiveDirectoryObjectId =
      values.UserId?.value === context.UserId?.value
        ? cloneStateData(context.UserAzureActiveDirectoryObjectId)
        : { $type: 'Guid', value: objectId(values.UserId?.value) };
  // An asynchronous job reports its own (unnamed) step on every level.
  values.OwningExtension ??=
    context.Mode === 1
      ? cloneStateData(context.OwningExtension)
      : mainOperationStep(values.MessageName, values.PrimaryEntityName);
  values.InputParameters ??= emptyParameters();
  values.OutputParameters ??= emptyParameters();
  values.SharedVariables ??= emptyParameters();
  const root = values.ParentContext?.values ? null : roots?.get(values.RequestId?.value);
  if ((values.Stage === 30 && Object.hasOwn(values.SharedVariables.values ?? {}, 'telemetryrootcontext')) || root) {
    const { telemetryrootcontext, ...shared } = values.SharedVariables.values ?? {};
    if (values.Stage !== 30 && telemetryrootcontext !== undefined) shared.telemetryrootcontext = telemetryrootcontext;
    if (root?.ChangedEntityTypes)
      shared.ChangedEntityTypes = { ...(shared.ChangedEntityTypes ?? {}), ...root.ChangedEntityTypes };
    if (root?.POADistributionChanged !== undefined) shared.POADistributionChanged = root.POADistributionChanged;
    values.SharedVariables = { $type: 'ParameterCollection', values: shared };
  }
  values.PreEntityImages ??= { $type: 'EntityImageCollection', values: {} };
  values.PostEntityImages ??= { $type: 'EntityImageCollection', values: {} };
  values.PreEntityImagesCollection ??= emptyImageCollections();
  values.PostEntityImagesCollection ??= emptyImageCollections();
  values.IsInTransaction = context.IsInTransaction;
  values.InitiatingUserAgent = context.InitiatingUserAgent;
  values.ParentContext = observedParentChain(values.ParentContext ?? null, context, objectId, roots);
  return { $type: 'ExecutionContext', values };
}

/** Values of a main-operation (stage 30) context: native reports the PreValidation context of the same request
 * as this frame, inside the transaction, owned by the platform's ObjectModel step, with the main operation's live
 * SharedVariables and image collection and no step images. */
function mainOperationValues(values, { sharedVariables, images } = {}) {
  return {
    ...values,
    Stage: 30,
    Mode: 0,
    IsInTransaction: true,
    OwningExtension: mainOperationStep(values.MessageName, values.PrimaryEntityName),
    SharedVariables: cloneStateData(sharedVariables ?? values.SharedVariables ?? emptyParameters()),
    PreEntityImages: { $type: 'EntityImageCollection', values: {} },
    PostEntityImages: { $type: 'EntityImageCollection', values: {} },
    PreEntityImagesCollection: images ?? emptyImageCollections(),
    PostEntityImagesCollection: emptyImageCollections(),
  };
}

/** The ParentContext of a CRUD PreOperation/PostOperation step: the request's PreValidation snapshot when a
 * PreValidation step ran, else the current context reduced to the PreValidation inputs. userId is the step's
 * executing user: natively an impersonating step sees its main operation run as its user (recorded crud
 * "Probe: Update 40 impersonated"), its grandparents keep the caller. */
export function mainOperationParent({ frame, context, parent, userId, objectId, inputs, images }) {
  const snapshot = frame.preValidationContext?.values;
  const base = snapshot
    ? cloneStateData(snapshot)
    : {
        ...cloneStateData(context),
        InputParameters: { $type: 'ParameterCollection', values: inputs() },
        OutputParameters: emptyParameters(),
        ParentContext: parent ?? null,
      };
  base.UserId = { $type: 'Guid', value: userId };
  base.UserAzureActiveDirectoryObjectId = { $type: 'Guid', value: objectId(userId) };
  return {
    $type: 'ExecutionContext',
    values: mainOperationValues(base, { sharedVariables: frame.mainSharedVariables, images }),
  };
}

/** An asynchronous job's view of the committed synchronous parent chain: native keeps each level's stage, inputs,
 * shared variables and identities, but reports the job's mode, depth, message, row, step (unnamed), operation id
 * and creation time, outside a transaction. */
export function asynchronousParentChain(node, context) {
  if (!node?.values) return node ?? null;
  return {
    $type: 'ExecutionContext',
    values: {
      ...node.values,
      Mode: 1,
      Depth: context.Depth,
      MessageName: context.MessageName,
      PrimaryEntityId: cloneStateData(context.PrimaryEntityId),
      IsInTransaction: false,
      OwningExtension: cloneStateData(context.OwningExtension),
      OperationId: cloneStateData(context.OperationId),
      OperationCreatedOn: cloneStateData(context.OperationCreatedOn),
      ParentContext: asynchronousParentChain(node.values.ParentContext, context),
    },
  };
}
