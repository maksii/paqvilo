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

/** Bare HTTP PATCH delegates through an outer Upsert main operation. A PreOperation or PostOperation step (stage 20 or
 * 40) of its Update has that framework frame as its SDK parent, rather than the currently executing Update step
 * (native nestedImages). The hidden system step identity is unavailable from ordinary exports. */
export function selectSdkEntryParent(entry, frameworkSource) {
  const snapshot = cloneStateData(entry);
  if (
    frameworkSource?.operation !== 'upsert' ||
    snapshot?.values?.Mode === 1 ||
    ![20, 40].includes(snapshot?.values?.Stage)
  )
    return snapshot;
  const shared = cloneStateData(
    frameworkSource.sharedVariables ?? {
      $type: 'ParameterCollection',
      values: { AcceptLang: frameworkSource.acceptLanguage ?? '', IsAutoTransact: false },
    },
  );
  if (frameworkSource.tag !== undefined && !Object.hasOwn(shared.values, 'tag'))
    shared.values.tag = frameworkSource.tag;
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
      values: {
        Target: cloneStateData(frameworkSource.target),
        ReturnRowVersion: null,
        ...(frameworkSource.tag === undefined ? {} : { tag: frameworkSource.tag }),
      },
    },
    OutputParameters: { $type: 'ParameterCollection', values: {} },
    SharedVariables: shared,
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
 * that identity structure is reproduced. variant names a second platform step of that message and table (native
 * imagesOrder: the Update main operation above SetStateDynamicEntity has its own ObjectModel step). */
export function mainOperationStep(messageName, entity, variant) {
  return {
    $type: 'EntityReference',
    logicalName: 'sdkmessageprocessingstep',
    id: uuidV5(
      '00000000-0000-0000-0000-000000000000',
      `sdkmessageprocessingstep:${MAIN_OPERATION_STEP}:${messageName}:${entity ?? 'none'}${variant ? ':' + variant : ''}`,
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
 * message, and fileattachment once a single-record operation queues asynchronous work). table is the
 * ChangedEntityTypes key; sharing marks a principalobjectaccess change; asyncQueued the queued job attachment. */
export function recordRequestRootChange(store, requestId, { table, sharing = false, asyncQueued = false } = {}) {
  if (!store || !requestId || (!table && !sharing && !asyncQueued)) return;
  const roots = (store.pluginRequestRoots ??= new Map());
  let root = roots.get(requestId);
  if (!root) {
    roots.set(requestId, (root = {}));
    if (roots.size > REQUEST_ROOT_LIMIT) roots.delete(roots.keys().next().value);
  }
  for (const key of [table, sharing ? 'principalobjectaccess' : null].filter(Boolean))
    root.ChangedEntityTypes = { ...(root.ChangedEntityTypes ?? {}), [key]: 'Update' };
  // The platform's asynchronous job attachment (recorded value 'Create'), once per request.
  if (asyncQueued && !root.ChangedEntityTypes?.fileattachment)
    root.ChangedEntityTypes = { ...(root.ChangedEntityTypes ?? {}), fileattachment: 'Create' };
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

// Context facts a frame without its own value shares with the job (a bridged multiple's main frame keeps only its
// operation's request): native parent frames report the job's identities.
const SHARED_FACTS = [
  'UserId',
  'InitiatingUserId',
  'BusinessUnitId',
  'OrganizationId',
  'OrganizationName',
  'SecondaryEntityName',
  'IsExecutingOffline',
  'IsOfflinePlayback',
  'UserAzureActiveDirectoryObjectId',
  'InitiatingUserAzureActiveDirectoryObjectId',
  'InitiatingUserApplicationId',
  'PortalsContactId',
  'IsPortalsClientCall',
  'AuthenticatedUserId',
  'InitiatingUserAgent',
  'EnvironmentId',
  'TenantId',
  'IsApplicationUser',
];
/** Native async parents hold at most three frames (corpus depth.json: Depth 2-10 jobs all report X/30 < X/40 < X/30). */
const ASYNC_PARENT_FRAMES = 3;

/** An asynchronous job's ParentContext: the parent chain its message's synchronous PostOperation step sees, cut after
 * three frames. Each frame keeps its stage, inputs, outputs, shared variables, entity name, identities and Context4
 * image collections (native depth: the calling Create/40 frame keeps its AsynchronousStepPrimaryName post collection),
 * but reports the job's mode, depth, message, operation row (a bridged multiple's single row), isolation, step
 * (unnamed), operation id, correlation and creation time, outside a transaction, without step images (native corpus:
 * depth, bulk, faults, ownerAndState, customApi asynchronous contexts and their web hook copies). */
export function asynchronousParentChain(
  node,
  context,
  { remaining = ASYNC_PARENT_FRAMES, primaryEntityId = context.PrimaryEntityId } = {},
) {
  if (!node?.values || remaining <= 0) return null;
  const shared = Object.fromEntries(
    SHARED_FACTS.filter((key) => node.values[key] === undefined && context[key] !== undefined).map((key) => [
      key,
      cloneStateData(context[key]),
    ]),
  );
  return {
    $type: 'ExecutionContext',
    values: {
      ...node.values,
      ...shared,
      Mode: 1,
      Depth: context.Depth,
      MessageName: context.MessageName,
      PrimaryEntityId: cloneStateData(primaryEntityId),
      IsInTransaction: false,
      IsolationMode: context.IsolationMode,
      OwningExtension: cloneStateData(context.OwningExtension),
      OperationId: cloneStateData(context.OperationId),
      OperationCreatedOn: cloneStateData(context.OperationCreatedOn),
      CorrelationId: cloneStateData(context.CorrelationId ?? node.values.CorrelationId),
      PreEntityImages: { $type: 'EntityImageCollection', values: {} },
      PostEntityImages: { $type: 'EntityImageCollection', values: {} },
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
