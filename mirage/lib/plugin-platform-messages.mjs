// Named platform messages a plug-in issues through IOrganizationService.Execute, each with its own plug-in pipeline
// (PreValidation, PreOperation, main operation, PostOperation and the committed asynchronous event), as the recorded
// native corpus shows: Assign, SetState (executed as SetStateDynamicEntity), GrantAccess, ModifyAccess, RevokeAccess,
// RetrievePrincipalAccess, RetrieveSharedPrincipalsAndAccess. Upsert runs no pipeline of its own: its existence query
// and the delegated Create or Update run instead. Merge runs the Web API Merge main operation on a table with a Merge message filter and refuses others.
import { DataError } from './data-error.mjs';
import { cloneStateData } from './state-clone.mjs';
import { initializePluginOperation } from './plugin-operation-context.mjs';
import { pluginInvocationDepth, pluginInvocationSdkParent } from './plugin-execution-lifetime.mjs';
import { pluginDepthFault, PLUGIN_MAX_DEPTH, pluginExecutionDepth, recordToSdkEntity } from './plugin-clr.mjs';
import { mainOperationParent, recordRequestRootChange, selectSdkEntryParent } from './plugin-sdk-parent.mjs';
import { internalStepReference, setInternalStageSource } from './plugin-internal-stage.mjs';
import { pluginEntryStep } from './plugin-message-admission.mjs';
import { authorizeGrant, messageFilters, sdkRecordKey, sdkValueToRecord } from './local-organization-service.mjs';
import { relationshipsOf } from './dataverse-standard.mjs';
import { ACCESS_RIGHTS, createPrincipals, grantAccessNow, revokeAccessNow } from './dataverse-security.mjs';

const EMPTY = '00000000-0000-0000-0000-000000000000';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHAPES = {
  Assign: ['Target', 'Assignee'],
  SetState: ['EntityMoniker', 'State', 'Status'],
  SetStateDynamicEntity: ['EntityMoniker', 'State', 'Status'],
  GrantAccess: ['Target', 'PrincipalAccess'],
  ModifyAccess: ['Target', 'PrincipalAccess'],
  RevokeAccess: ['Target', 'Revokee'],
  RetrievePrincipalAccess: ['Target', 'Principal'],
  RetrieveSharedPrincipalsAndAccess: ['Target'],
  Upsert: ['Target'],
  Merge: ['Target', 'SubordinateId', 'UpdateContent', 'PerformParentingChecks'],
};
export const isPlatformSdkMessage = (name) => Object.hasOwn(SHAPES, name);

const fail = (message, code = 'LocalPluginSdkUnsupported', status = 501, details) => {
  throw new DataError(message, status, code, details);
};
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const reference = (value, name) => {
  if (value?.$type !== 'EntityReference' || !GUID.test(value.id ?? '') || !value.logicalName)
    fail(`SDK ${name} requires a typed EntityReference.`);
  return value;
};
const option = (value, name) => {
  if (value?.$type !== 'OptionSetValue' || !Number.isInteger(value.value))
    fail(`SDK ${name} requires an OptionSetValue.`);
  return value.value;
};
const principalOf = (store, value, name) => {
  const ref = reference(value, name);
  if (
    !['systemuser', 'team'].includes(ref.logicalName) ||
    !store.get(ref.logicalName, ref.id, { admin: true }, { skipPluginRead: true })
  )
    fail('Invalid argument.', 'InvalidArgument', 400, { innerCode: '0x80040203' });
  return ref;
};
const accessMaskOf = (value) => {
  const mask = value?.$type === 'AccessRights' ? value.value : value;
  if (!Number.isInteger(mask) || mask <= 0)
    fail('Invalid access mask.', 'InvalidArgument', 400, { innerCode: '0x80040203' });
  return mask;
};
export const maskOfNames = (names) =>
  String(names ?? '')
    .split(',')
    .map((part) => ACCESS_RIGHTS[part.trim().replace(/Access$/, '')] ?? 0)
    .reduce((mask, right) => mask | right, 0);
const sharesOf = (store, target) =>
  store
    .tableRows('principalobjectaccess')
    .filter((row) => same(row.objectid, target.id) && same(row.objecttypecode, target.logicalName));
const principalIdOf = (row) => row.principalid?.id ?? row.principalid;
/** The rights a principal's direct shares of a row give it (a team with only a share answers the shared mask). */
export const sharedMaskOf = (store, logicalName, id, principalId) =>
  sharesOf(store, { logicalName, id })
    .filter((share) => same(principalIdOf(share), principalId))
    .reduce((mask, share) => mask | Number(share.accessrightsmask), 0);
/** AccessRights names (ReadAccess, WriteAccess, ...) of a mask; None when empty. */
export const accessNamesOf = (mask) =>
  Object.keys(ACCESS_RIGHTS)
    .filter((right) => mask & ACCESS_RIGHTS[right])
    .map((right) => `${right}Access`)
    .join(', ') || 'None';

// The depth of a message issued now: one below the calling plug-in or operation. A nested caller's SDK parent is the
// depth-1 step (plugin-clr.mjs dispatchSdkCall), so the executing CLR steps count too.
function messageDepth(store) {
  const depth =
    Math.max(
      pluginExecutionDepth(),
      pluginInvocationDepth(store),
      Number((store.pluginParentContext ?? pluginInvocationSdkParent(store))?.values?.Depth ?? 0),
    ) + 1;
  if (depth > PLUGIN_MAX_DEPTH) throw pluginDepthFault();
  return depth;
}

/**
 * Runs one named message through the plug-in pipeline of its registered steps: PreValidation (10), PreOperation (20),
 * the main operation `main()` (stage 30, whose nested record pipelines run at this message's depth with the stage-30
 * context as parent, as natively), PostOperation (40) with main's outputs, then the committed event that queues the
 * asynchronous steps. inputs are SDK wire values; the request tag is appended as natively. Answers the outputs.
 */
function runMessagePipeline(
  store,
  {
    message,
    entity,
    id,
    inputs,
    identity,
    depth = messageDepth(store),
    acceptLanguage = '',
    bypassStepIds,
    bypassCustomPlugins = false,
    bypassCustomAsync = false,
    main = () => ({}),
    // A message the platform refuses after PreValidation (DeleteMultiple on a standard table): only stage 10 runs, and
    // main runs the per-record PreValidation it delegates, with the stage-10 context as their parent.
    preValidationOnly = false,
    // A message an internal platform stage issues (runRetrieveExchangeRate) has no PreValidation stage, no tag input,
    // outputs the platform computed before PreOperation and a frame that joins the issuing operation (frame).
    preValidation = true,
    inputTag = true,
    outputs: initialOutputs = {},
    frame: frameFacts = {},
    record: suppliedRecord,
    // The platform frame the message runs under when no plug-in issued it (a PATCH statecode's Upsert main operation).
    parentContext: platformParent,
    // Reads run outside the automatic transaction (native sdkMessages: RetrievePrincipalAccess and
    // RetrieveSharedPrincipalsAndAccess report IsAutoTransact false).
    autoTransact = true,
  },
) {
  // An unbound message (PrimaryEntityName none) has no table and an empty PrimaryEntityId.
  const operation = message.toLowerCase(),
    mapping =
      entity == null || entity === 'none' ? { logicalName: 'none', idColumn: 'id' } : store.resolveMapping(entity),
    record = suppliedRecord ?? { [mapping.idColumn]: id ?? EMPTY },
    customApi = { name: message, platformMessage: true, bindingType: 0, parameters: [], properties: [] },
    requestTag = store.pluginSdkTag;
  // The message's row before the operation (pre images, the Assign primary-name image) and, for PostOperation, after
  // it: registered images of Assign, SetState and the sharing messages hold the record (Microsoft Learn image table).
  const storedRow = () =>
    cloneStateData(store.tableRows(mapping.logicalName).find((row) => same(row[mapping.idColumn], id)) ?? null);
  const previous = id && id !== EMPTY ? storedRow() : null;
  const values = { ...inputs };
  if (requestTag !== undefined && inputTag) values.tag = requestTag;
  if (Object.hasOwn(inputs, 'FromSandbox')) {
    delete values.FromSandbox;
    values.FromSandbox = inputs.FromSandbox;
  }
  const messageParameters = {
    inputParameters: { $type: 'ParameterCollection', values },
    outputParameters: { $type: 'ParameterCollection', values: { ...initialOutputs } },
  };
  const active =
    Boolean(store.pluginPipeline) &&
    store.pluginPipelineActive({ entity: mapping.logicalName, operation, bypassCustomPlugins, bypassStepIds });
  const parentContext = platformParent ?? store.pluginParentContext ?? pluginInvocationSdkParent(store);
  let frame = {
    ...frameFacts,
    ...(inputTag ? {} : { inputTagConsumed: true }),
    requestTag,
    operationDepth: depth,
    ...(platformParent ? { delegatedParentContext: platformParent, delegatedDepth: depth, exactDepth: true } : {}),
    suppliedRequestId: store.pluginRequestId,
    sharedVariables: {
      $type: 'ParameterCollection',
      values: {
        AcceptLang: acceptLanguage,
        IsAutoTransact: autoTransact,
        ...(requestTag === undefined ? {} : { tag: requestTag }),
      },
    },
  };
  const inherited = store.pluginInTransaction;
  const restore = () => {
      store.pluginInTransaction = inherited;
    },
    failed = (error) => {
      store.markPluginTransactionFailure?.(error);
      throw error;
    };
  let settled = true,
    first = true;
  const phase = (stage) => {
    if (stage !== 10) store.pluginInTransaction = true;
    if (!active) return;
    const initial = first;
    first = false;
    frame =
      store.pluginPipeline({
        store,
        entity: mapping.logicalName,
        operation,
        stage,
        record,
        previous,
        identity,
        changedAttributes: [],
        bypassStepIds,
        bypassCustomPlugins,
        customApi,
        messageParameters,
        ...(initial ? { initialFrame: frame } : {}),
      }) ?? frame;
  };
  try {
    if (preValidation) phase(10);
    if (!preValidationOnly) phase(20);
    initializePluginOperation(frame, store, parentContext);
    const executionUser = store.pluginExecutionUserId ?? identity?.systemUserId ?? identity?.id ?? null;
    const mainContext = {
      $type: 'ExecutionContext',
      values: {
        MessageName: message,
        PrimaryEntityName: mapping.logicalName,
        SecondaryEntityName: 'none',
        PrimaryEntityId: { $type: 'Guid', value: record[mapping.idColumn] },
        Stage: preValidationOnly ? 10 : 30,
        Mode: 0,
        Depth: depth,
        IsInTransaction: !preValidationOnly && store.pluginInTransaction === true,
        IsolationMode: 2,
        ...(executionUser ? { UserId: { $type: 'Guid', value: executionUser } } : {}),
        InitiatingUserId:
          parentContext?.values?.InitiatingUserId ??
          (executionUser ? { $type: 'Guid', value: executionUser } : undefined),
        CorrelationId: { $type: 'Guid', value: frame.correlationId },
        OperationId: { $type: 'Guid', value: frame.operationId },
        RequestId: { $type: 'Guid', value: frame.requestId },
        OperationCreatedOn: cloneStateData(frame.createdOnWire),
        InputParameters: cloneStateData(messageParameters.inputParameters),
        OutputParameters: { $type: 'ParameterCollection', values: {} },
        SharedVariables: cloneStateData(frame.sharedVariables ?? { $type: 'ParameterCollection', values: {} }),
        ParentContext: parentContext ?? null,
        PreEntityImages: { $type: 'EntityImageCollection', values: {} },
        PostEntityImages: { $type: 'EntityImageCollection', values: {} },
      },
    };
    // Record pipelines the main operation starts belong to this message (exported-plugins.mjs runPluginPhase).
    const previousMain = store.pluginMainOperation;
    store.pluginMainOperation = {
      context: mainContext,
      depth,
      namedMessage: true,
      ...(preValidationOnly ? { preValidationOnly: true } : {}),
    };
    const finish = (outputs = {}) => {
      store.pluginMainOperation = previousMain;
      if (preValidationOnly) return outputs;
      messageParameters.outputParameters.values = { ...outputs };
      if (previous) Object.assign(record, storedRow() ?? {});
      phase(40);
      store.pluginFrames ??= new WeakMap();
      store.pluginFrames.set(record, frame);
      const event = {
        customApi,
        target: {},
        previous,
        identity,
        messageEvent: true,
        bypassCustomAsync,
        bypassStepIds,
      };
      if (store.committedEventCandidates || !store.commitStagers?.size)
        store.recordCommittedEvent(mapping.logicalName, operation, record, [], event);
      // An entry message whose writes committed on their own (or that wrote nothing) stages its event in its own
      // transaction, as a read does (data.mjs).
      else
        store
          .transact(
            () => store.recordCommittedEvent(mapping.logicalName, operation, cloneStateData(record), [], event),
            { skipSaveIfUnchanged: true },
          )
          .catch((error) => {
            (store.committedEventErrors ??= []).push({
              code: error.code ?? 'CommitStagerError',
              message: error.message,
            });
          });
      return messageParameters.outputParameters.values;
    };
    let pending;
    try {
      pending = main();
    } catch (error) {
      store.pluginMainOperation = previousMain;
      throw error;
    }
    // A main operation that answers a promise (a Web API or SOAP message's own adapter) finishes once it settles.
    if (typeof pending?.then !== 'function') return finish(pending ?? undefined);
    settled = false;
    return pending
      .then(
        (outputs) => finish(outputs ?? undefined),
        (error) => {
          store.pluginMainOperation = previousMain;
          throw error;
        },
      )
      .catch(failed)
      .finally(restore);
  } catch (error) {
    failed(error);
  } finally {
    if (settled) restore();
  }
}

/**
 * IOrganizationService.Execute of a named platform message from a plug-in. service is the caller's local organization
 * service; invoke(method, args) runs a record SDK method (Create, Update, RetrieveMultiple) as the plug-in would.
 * Authorization is the run-as user's security roles, or the explicit profile grants when the store has no security model
 * (authorizeGrant): Assign checks Write (update) and Assign on the target row, SetState checks Write, the sharing changes
 * check Share, the access queries check Read.
 */
export function executePlatformSdkMessage({ store, profile, service, request, parameters, options = {}, invoke }) {
  const name = request.requestName,
    shape = SHAPES[name];
  const allowed = new Set([
    ...shape,
    'tag',
    'BypassCustomPluginExecution',
    'BypassBusinessLogicExecution',
    'BypassBusinessLogicExecutionStepIds',
  ]);
  if (Object.keys(parameters).some((key) => !allowed.has(key)) || shape.some((key) => !Object.hasOwn(parameters, key)))
    fail('Unsupported SDK Execute request or parameters: ' + name);
  const respond = (results = {}) => ({ $type: 'OrganizationResponse', responseName: name, custom: true, results });
  const identity = { id: profile.userId, systemUserId: profile.userId, admin: true };
  const fromSandbox = options.sdkFromSandbox === true ? { FromSandbox: true } : {};
  const pipelineOptions = {
    identity,
    bypassStepIds: options.bypassStepIds,
    bypassCustomPlugins: options.bypassCustomPlugins === true,
    bypassCustomAsync: options.bypassCustomAsync === true,
  };
  const existing = (target, operation) => {
    const row = store.get(target.logicalName, target.id, { admin: true }, { skipPluginRead: true });
    if (!row)
      fail(`${target.logicalName} With Id = ${target.id} Does Not Exist`, 'NotFound', 404, { innerCode: '0x80040217' });
    authorizeGrant(store, profile, target.logicalName, operation, row);
    return row;
  };
  // The main operation's own Update: no PreValidation stage, no ConcurrencyBehavior or FromSandbox input and no nested
  // SetStateDynamicEntity (recorded native Assign and SetState).
  const innerUpdate = (target, values, writeOptions = {}) =>
    service.messageUpdate(target.logicalName, target.id, values, {
      skipPreValidation: true,
      omitConcurrencyBehavior: true,
      stateMessage: false,
      sdkFromSandbox: false,
      ...writeOptions,
    });
  const named = (inputs, target, main) =>
    runMessagePipeline(store, {
      message: name === 'SetState' ? 'SetStateDynamicEntity' : name,
      entity: target.logicalName,
      id: target.id,
      inputs: { ...inputs, ...fromSandbox },
      main,
      autoTransact: !['RetrievePrincipalAccess', 'RetrieveSharedPrincipalsAndAccess'].includes(name),
      ...pipelineOptions,
    });
  switch (name) {
    case 'Assign': {
      const target = reference(parameters.Target, 'Target'),
        assignee = principalOf(store, parameters.Assignee, 'Assignee');
      authorizeGrant(store, profile, target.logicalName, 'assign', existing(target, 'update'));
      named({ Target: parameters.Target, Assignee: parameters.Assignee }, target, () => {
        // Natively the Assign main operation updates the owner as the organization's system user.
        const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM');
        const previous = store.pluginExecutionUserId;
        if (system) store.pluginExecutionUserId = system.systemuserid;
        try {
          innerUpdate(
            target,
            { ownerid: { id: assignee.id, logical_name: assignee.logicalName } },
            { assignOwner: true },
          );
        } finally {
          store.pluginExecutionUserId = previous;
        }
      });
      return respond();
    }
    case 'SetState':
    case 'SetStateDynamicEntity': {
      const target = reference(parameters.EntityMoniker, 'EntityMoniker'),
        state = option(parameters.State, 'State'),
        status = option(parameters.Status, 'Status');
      existing(target, 'update');
      const outputs = named(
        { EntityMoniker: parameters.EntityMoniker, State: parameters.State, Status: parameters.Status },
        target,
        () => {
          innerUpdate(target, { statecode: state, ...(status === -1 ? {} : { statuscode: status }) });
          return { IsValid: true };
        },
      );
      return respond(name === 'SetState' ? {} : outputs);
    }
    case 'GrantAccess':
    case 'ModifyAccess':
    case 'RevokeAccess': {
      const target = reference(parameters.Target, 'Target');
      existing(target, 'share');
      const access = parameters.PrincipalAccess;
      if (name !== 'RevokeAccess' && access?.$type !== 'PrincipalAccess')
        fail('SDK PrincipalAccess requires a typed value.');
      const principal = principalOf(
        store,
        name === 'RevokeAccess' ? parameters.Revokee : access.principal,
        'Principal',
      );
      const inputs =
        name === 'RevokeAccess'
          ? { Target: parameters.Target, Revokee: parameters.Revokee }
          : { Target: parameters.Target, PrincipalAccess: parameters.PrincipalAccess };
      named(inputs, target, () => {
        // The request's root collection records the sharing change (native sdkMessages root after each message).
        recordRequestRootChange(store, store.pluginMainOperation?.context?.values?.RequestId?.value, { sharing: true });
        const share = {
          target: { logical: target.logicalName, id: target.id },
          principal: { id: principal.id, logical_name: principal.logicalName },
        };
        if (name === 'RevokeAccess') revokeAccessNow(store, share);
        else
          grantAccessNow(
            store,
            { ...share, mask: accessMaskOf(access.accessMask) },
            { replace: name === 'ModifyAccess' },
          );
      });
      return respond();
    }
    case 'RetrievePrincipalAccess': {
      const target = reference(parameters.Target, 'Target'),
        principal = principalOf(store, parameters.Principal, 'Principal'),
        row = existing(target, 'read');
      return respond(
        named({ Target: parameters.Target, Principal: parameters.Principal }, target, () => {
          const principals = createPrincipals(store),
            subject = store.get(principal.logicalName, principal.id, { admin: true }, { skipPluginRead: true });
          const granted =
            principal.logicalName === 'team'
              ? principals.teamAccess({ team: subject, entity: target.logicalName, row })
              : principals.principalAccess({ user: subject, entity: target.logicalName, row });
          // A direct share's rights are the principal's rights on the row (native: a team with only a share answers
          // the shared mask).
          const shared = sharesOf(store, target)
            .filter((share) => same(principalIdOf(share), principal.id))
            .reduce((mask, share) => mask | Number(share.accessrightsmask), 0);
          return { AccessRights: { $type: 'AccessRights', value: maskOfNames(granted) | shared } };
        }),
      );
    }
    case 'RetrieveSharedPrincipalsAndAccess': {
      const target = reference(parameters.Target, 'Target');
      existing(target, 'read');
      return respond(
        named({ Target: parameters.Target }, target, () => ({
          PrincipalAccesses: {
            $type: 'SdkArray',
            elementType: 'PrincipalAccess',
            values: sharesOf(store, target).map((share) => {
              const id = principalIdOf(share);
              const team = store.tableRows('team').some((row) => same(row.teamid, id));
              return {
                $type: 'PrincipalAccess',
                principal: { $type: 'EntityReference', logicalName: team ? 'team' : 'systemuser', id, name: null },
                accessMask: Number(share.accessrightsmask),
              };
            }),
          },
        })),
      );
    }
    case 'Upsert': {
      // Native runs no Upsert pipeline for an SDK UpsertRequest: a RetrieveMultiple by the target's key decides
      // between the Create and Update pipelines (recorded corpus).
      const target = parameters.Target;
      if (target?.$type !== 'Entity' || !target.logicalName) fail('SDK Upsert requires a typed Target Entity.');
      const mapping = store.resolveMapping(target.logicalName);
      // A Target by alternate key (Entity.KeyAttributes): the key must be one the table declares (store.findByKey, as
      // the Web API's key segments); the existence query filters on the key columns (recorded native sdkSurface).
      const keys = Object.keys(target.keyAttributes ?? {}).length ? target.keyAttributes : null;
      if (keys) store.findByKey(mapping, sdkRecordKey(store, mapping.logicalName, target));
      else if (!GUID.test(target.id ?? '') || target.id === EMPTY)
        fail(
          'SDK Upsert requires a Target with a primary key value or key attributes.',
          'LocalPluginSdkUnsupported',
          501,
        );
      const conditions = Object.entries(keys ?? { [mapping.idColumn]: { $type: 'Guid', value: target.id } }).map(
        ([attributeName, value]) => ({ attributeName, operatorName: 'Equal', values: [value] }),
      );
      // Natively both run at the calling plug-in's depth, with its context as their parent (recorded corpus).
      const caller = store.pluginParentContext ?? pluginInvocationSdkParent(store),
        previousMain = store.pluginMainOperation;
      const delegated = caller && {
        context: caller,
        depth: Math.max(Number(caller.values?.Depth ?? 1), pluginExecutionDepth()),
        exactDepth: true,
        keepsRequestTag: true,
      };
      // The existence query is the platform's own read (app-module inputs, no IncludeAnnotations; recorded sdkMessages).
      if (delegated) store.pluginMainOperation = { ...delegated, internalRead: true };
      let created,
        id = target.id;
      try {
        const found = invoke('RetrieveMultiple', [
          {
            $type: 'QueryExpression',
            entityName: mapping.logicalName,
            columnSet: { allColumns: false, columns: [] },
            criteria: { operatorName: 'And', conditions, filters: [] },
            orders: [],
            linkEntities: [],
            topCount: 2,
            distinct: false,
            noLock: false,
          },
        ]);
        created = !found?.entities?.length;
        if (delegated) store.pluginMainOperation = delegated;
        if (!keys) invoke(created ? 'Create' : 'Update', [target]);
        else {
          // By key, as the Web API upsert: a create keeps the Target's values and adds the key values it lacks (native
          // Create Target: the attributes, then the key column, no KeyAttributes); an update addresses the found row and
          // drops the key columns (Learn: the server removes the data that uses the same keys).
          const attributes = { ...target.attributes };
          for (const [name, value] of Object.entries(keys))
            if (!created) delete attributes[name];
            else if (!Object.hasOwn(attributes, name)) attributes[name] = value;
          const written = invoke(created ? 'Create' : 'Update', [
            { ...target, id: created ? (target.id ?? EMPTY) : found.entities[0].id, keyAttributes: {}, attributes },
          ]);
          id = created ? (written?.value ?? written) : found.entities[0].id;
        }
      } finally {
        store.pluginMainOperation = previousMain;
      }
      return respond({
        RecordCreated: created,
        Target: { $type: 'EntityReference', logicalName: mapping.logicalName, id, name: null },
      });
    }
    case 'Merge': {
      const target = reference(parameters.Target, 'Target');
      // The table's Merge message filter makes Merge available (native sdkMerge: none on a custom table, 0x80040800).
      if (!messageFilters(store, target.logicalName)?.has('merge')) throw mergeUnsupported(target.logicalName);
      const subordinate = {
        logicalName: target.logicalName,
        id: parameters.SubordinateId?.$type === 'Guid' ? parameters.SubordinateId.value : null,
      };
      const content = parameters.UpdateContent;
      if (!GUID.test(subordinate.id ?? '') || same(subordinate.id, target.id))
        fail('SDK Merge requires a SubordinateId Guid of another record.', 'InvalidArgument', 400, {
          innerCode: '0x80040203',
        });
      if (content != null && content.$type !== 'Entity') fail('SDK Merge UpdateContent requires an Entity.');
      if (typeof parameters.PerformParentingChecks !== 'boolean')
        fail('The PerformParentingChecks parameter is required.', 'InvalidArgument', 400, { innerCode: '0x80040203' });
      const mapping = store.resolveMapping(target.logicalName),
        targetRow = existing(target, 'update'),
        subordinateRow = existing(subordinate, 'update');
      const values = Object.fromEntries(
        Object.entries(sdkValueToRecord(content ?? { $type: 'Entity', attributes: {} })).filter(
          ([column]) => column !== mapping.idColumn,
        ),
      );
      // The main operation is the Web API Merge's (dataverse-record-messages.mjs): the same changes, as Updates.
      named(
        {
          Target: parameters.Target,
          SubordinateId: parameters.SubordinateId,
          UpdateContent: content,
          PerformParentingChecks: parameters.PerformParentingChecks,
        },
        target,
        () => {
          const changes = mergeChanges(store, mapping, targetRow, subordinateRow, {
            content: values,
            performParentingChecks: parameters.PerformParentingChecks,
          });
          innerUpdate(target, changes.target);
          innerUpdate(subordinate, changes.subordinate);
          for (const { childMapping, row, rel } of changes.children)
            innerUpdate(
              { logicalName: childMapping.logicalName, id: row[childMapping.idColumn] },
              { [rel.to]: { id: target.id, logical_name: mapping.logicalName } },
            );
        },
      );
      return respond();
    }
  }
}

const SYSTEM_PARAMETERS = new Set([
  'tag',
  'BypassCustomPluginExecution',
  'BypassBusinessLogicExecution',
  'BypassBusinessLogicExecutionStepIds',
]);
const ODATA_TYPE = /^#?(?:Microsoft\.Dynamics\.CRM\.|mscrm\.)/;

/**
 * An SDK value for a Web API (or SOAP-relayed) message parameter that has no typed parameter metadata here: GUID text as a
 * Guid, an @odata.type object as an EntityReference when it names only its key (else an Entity), other JSON as it is.
 * ponytail: no CSDL-typed conversion (Int64, Decimal, DateTime, Money arrive as their JSON form). Upgrade: map the
 * operation's declared Edm parameter types.
 */
function entryValue(store, value) {
  if (typeof value === 'string' && GUID.test(value)) return { $type: 'Guid', value };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  // An @odata.id reference (a function's parameter alias) names its row by entity set and key.
  const linked = /([A-Za-z_]\w*)\(([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)$/i.exec(
    typeof value['@odata.id'] === 'string' ? value['@odata.id'] : '',
  );
  if (linked)
    return {
      $type: 'EntityReference',
      logicalName: store.resolveMapping(linked[1]).logicalName,
      id: linked[2].toLowerCase(),
      name: null,
    };
  const type = value['@odata.type'];
  if (typeof type !== 'string') return cloneStateData(value);
  const mapping = store.resolveMapping(type.replace(ODATA_TYPE, ''));
  const columns = Object.fromEntries(Object.entries(value).filter(([name]) => !name.includes('@')));
  const id = columns[mapping.idColumn];
  if (Object.keys(columns).length === 1 && id != null)
    return { $type: 'EntityReference', logicalName: mapping.logicalName, id, name: null };
  return recordToSdkEntity(store, mapping.logicalName, columns);
}

/** The typed InputParameters of an entry point's request values (system parameters and annotations left out). */
export function entryParameters(store, values = {}) {
  return Object.fromEntries(
    Object.entries(values ?? {})
      .filter(([name]) => !name.startsWith('@') && !name.includes('@odata.') && !SYSTEM_PARAMETERS.has(name))
      .map(([name, value]) => [name, entryValue(store, value)]),
  );
}

/** Whether an entry point of the message has a registered step to run for the request table (entity; else the request's Target). */
export const entryMessageActive = (store, message, entity, context = {}) =>
  Boolean(pluginEntryStep(store, message, context, entity));

/**
 * Runs a named message that a Web API action or function, or a SOAP request, invokes through its plug-in pipeline at the
 * request's depth (PreValidation, PreOperation, main(), PostOperation, the committed asynchronous event), as the SDK
 * path does (executePlatformSdkMessage). main may answer a promise; it answers the message's typed outputs. The entry
 * point's request identity, Accept-Language and bypass choices apply. Answers a promise of the outputs.
 */
export async function runEntryMessage(store, { message, entity, id, inputs, context = {}, main }) {
  const header = (name) => context.headers?.get?.(name) ?? context.headers?.[name];
  return runMessagePipeline(store, {
    message,
    entity: entity ?? 'none',
    id,
    inputs,
    identity: context.identity ?? {},
    acceptLanguage: header('accept-language') ?? '',
    bypassStepIds: context.bypassStepIds,
    bypassCustomPlugins: context.bypassCustomPlugins === true,
    bypassCustomAsync: context.bypassCustomAsync === true,
    // The access reads run outside the automatic transaction, as on the SDK path (native sdkMessages).
    autoTransact: !['RetrievePrincipalAccess', 'RetrieveSharedPrincipalsAndAccess'].includes(message),
    main,
  });
}

// Never copied by a merge: ownership, audit and state columns.
const MERGE_SYSTEM_COLUMNS = new Set([
  'createdby',
  'createdon',
  'createdonbehalfby',
  'modifiedby',
  'modifiedon',
  'modifiedonbehalfby',
  'ownerid',
  'owninguser',
  'owningteam',
  'owningbusinessunit',
  'versionnumber',
  'statecode',
  'statuscode',
  'masterid',
]);
const refOf = (value) => (value !== null && typeof value === 'object' ? value.id : value);

/**
 * The writes of a Merge main operation, for the Web API and the SDK: target gets the subordinate's values it lacks and
 * content (the UpdateContent columns; an incident merge ignores them), subordinate is deactivated (and takes masterid
 * when declared), and its child rows ({ childMapping, row, rel }; rel.to is the child's lookup column) move to the target.
 * performParentingChecks refuses two different non-null parents on the table's self lookup.
 * ponytail: the missing-parent variant of PerformParentingChecks (async cascade docs) is not modelled.
 */
export function mergeChanges(store, mapping, targetRow, subRow, { content = {}, performParentingChecks = false } = {}) {
  const { idColumn } = mapping,
    fields = mapping.fields ?? {},
    relationships = Object.entries(relationshipsOf(store, mapping.logicalName, mapping.relationships));
  const sameRef = (a, b) => a != null && b != null && same(a, b);
  if (performParentingChecks)
    for (const [nav, rel] of relationships) {
      if (rel.many || rel.entity !== mapping.logicalName) continue;
      const left = refOf(targetRow[rel.from ?? nav]),
        right = refOf(subRow[rel.from ?? nav]);
      if (left != null && right != null && !sameRef(left, right))
        fail('The Target and Subordinate records have different parent records.', 'InvalidRequest', 400, {
          innerCode: '0x80040203',
        });
    }
  const copied = Object.fromEntries(
    Object.keys(fields)
      .filter(
        (name) =>
          name !== idColumn && !MERGE_SYSTEM_COLUMNS.has(name) && subRow[name] != null && targetRow[name] == null,
      )
      .map((name) => [name, subRow[name]]),
  );
  const children = [];
  for (const [, rel] of relationships) {
    if (!rel.many || rel.intersect) continue;
    const childMapping = store.resolveMapping(rel.entity);
    for (const row of store.tableRows(childMapping.logicalName))
      if (sameRef(refOf(row[rel.to]), refOf(subRow[rel.from ?? idColumn]))) children.push({ childMapping, row, rel });
  }
  return {
    target: { ...copied, ...(mapping.logicalName === 'incident' ? {} : content) },
    subordinate: { statecode: 1, ...(Object.hasOwn(fields, 'masterid') ? { masterid: targetRow[idColumn] } : {}) },
    children,
  };
}

/** The platform's refusal of Merge on a table without a Merge message filter (recorded native fault 0x80040800). */
function mergeUnsupported(logical) {
  return new DataError(
    `The 'Merge' method does not support entities of type '${logical}'. MessageProcessorCache returned MessageProcessor.Empty. `,
    400,
    'MergeUnsupported',
    { innerCode: '0x80040800' },
  );
}

/**
 * The RetrieveExchangeRate the platform's MultiCurrencyPlugin issues at internal stage 25 of a Create or Update that
 * writes a money value (recorded native crud and currency): PreOperation and PostOperation (no PreValidation, even with a
 * registered step) inside the issuer's transaction, at its depth and request, executing as SYSTEM for the caller, with
 * TransactionCurrencyId as the only input and the ExchangeRate output already present at PreOperation; the asynchronous
 * steps queue once the issuer commits. ParentContext is the issuer's PreOperation context reported as stage 25
 * (plugin-internal-stage.mjs). Answers the ExchangeRate the message ends with (a PostOperation step may replace it).
 * ponytail: a CreateMultiple runs it once per target; natively once per request under Create/20 < CreateMultiple/25.
 */
export function runRetrieveExchangeRate(
  store,
  { mapping, operation: issuer = 'create', row, previous = null, target, currencyId, rate, identity, options = {} },
) {
  const issuerMessage = issuer === 'update' ? 'Update' : 'Create';
  const entity = 'transactioncurrency',
    operation = 'retrieveexchangerate',
    bypass = { bypassStepIds: options.bypassStepIds, bypassCustomPlugins: options.bypassCustomPlugins === true };
  if (!store.pluginPipeline || !store.pluginPipelineActive({ entity, operation, ...bypass })) return rate;
  const system = store.tableRows('systemuser').find((user) => user.fullname === 'SYSTEM')?.systemuserid;
  const callerId = identity?.systemUserId ?? identity?.id ?? null,
    executing = system ?? callerId;
  const issuing = store.pluginFrames?.get(row) ?? {},
    outer = issuing.delegatedParentContext ?? store.pluginParentContext ?? pluginInvocationSdkParent(store) ?? null,
    depth = issuing.operationDepth ?? messageDepth(store);
  issuing.callerIdentity ??= identity;
  initializePluginOperation(issuing, store, outer, { requestId: issuing.suppliedRequestId ?? store.pluginRequestId });
  const guid = (value) => ({ $type: 'Guid', value });
  const id = row[mapping.idColumn],
    owner = internalStepReference('MultiCurrencyPlugin', issuerMessage),
    initiating = outer?.values?.InitiatingUserId ?? guid(callerId ?? executing);
  // The issuing Create's PreOperation context for steps that are not CLR (a CLR step builds the full one itself).
  const createValues = {
    MessageName: issuerMessage,
    PrimaryEntityName: mapping.logicalName,
    SecondaryEntityName: 'none',
    PrimaryEntityId: guid(id),
    Stage: 25,
    Mode: 0,
    Depth: depth,
    IsInTransaction: true,
    IsolationMode: 2,
    UserId: guid(executing),
    InitiatingUserId: initiating,
    RequestId: guid(issuing.requestId),
    OperationId: guid(issuing.operationId),
    CorrelationId: guid(issuing.correlationId),
    OperationCreatedOn: cloneStateData(issuing.createdOnWire),
    InputParameters: {
      $type: 'ParameterCollection',
      values: { Target: recordToSdkEntity(store, mapping.logicalName, { ...target, [mapping.idColumn]: id }) },
    },
    OutputParameters: { $type: 'ParameterCollection', values: {} },
    SharedVariables: cloneStateData(issuing.sharedVariables ?? { $type: 'ParameterCollection', values: {} }),
    PreEntityImages: { $type: 'EntityImageCollection', values: {} },
    PostEntityImages: { $type: 'EntityImageCollection', values: {} },
    OwningExtension: owner,
  };
  createValues.ParentContext = mainOperationParent({
    frame: issuing,
    context: { ...createValues, ParentContext: outer },
    parent: outer,
    userId: executing,
    objectId: () => EMPTY,
    inputs: () => ({
      ...cloneStateData(issuing.mainOperationInputs ?? {}),
      Target: recordToSdkEntity(
        store,
        mapping.logicalName,
        { ...(issuing.mainOperationTarget ?? target), [mapping.idColumn]: id },
        { allColumns: false, columns: [...Object.keys(issuing.mainOperationTarget ?? target), mapping.idColumn] },
      ),
    }),
  });
  const record = { [store.resolveMapping(entity).idColumn]: EMPTY };
  setInternalStageSource(record, {
    entity: mapping.logicalName,
    operation: issuer,
    message: issuerMessage,
    previous,
    target,
    record: row,
    frame: issuing,
    stage: 25,
    owner: 'MultiCurrencyPlugin',
    userId: executing,
  });
  const exchangeRate = (value) => ({ $type: 'Decimal', value: Number(value).toFixed(12) });
  // SYSTEM executes through the pipeline identity; the caller stays the initiating user (an SDK run-as user, which
  // store.pluginExecutionUserId models, would initiate too).
  {
    const outputs = runMessagePipeline(store, {
      message: 'RetrieveExchangeRate',
      entity,
      record,
      inputs: { TransactionCurrencyId: guid(currencyId) },
      outputs: { ExchangeRate: exchangeRate(rate) },
      // The caller's request facts stay (application, user agent); SYSTEM executes, also the asynchronous steps.
      identity: { ...identity, id: executing, systemUserId: executing, admin: true },
      depth,
      acceptLanguage: issuing.sharedVariables?.values?.AcceptLang ?? options.pluginAcceptLanguage ?? '',
      ...bypass,
      bypassCustomAsync: options.bypassCustomAsync === true,
      preValidation: false,
      inputTag: false,
      frame: {
        requestId: issuing.requestId,
        operationId: issuing.operationId,
        correlationId: issuing.correlationId,
        createdOn: issuing.createdOn,
        createdOnWire: cloneStateData(issuing.createdOnWire),
        delegatedParentContext: { $type: 'ExecutionContext', values: createValues },
        delegatedDepth: depth,
        exactDepth: true,
      },
      main: () => ({ ExchangeRate: exchangeRate(rate) }),
    });
    const answered = Number(outputs?.ExchangeRate?.value ?? outputs?.ExchangeRate);
    return Number.isFinite(answered) && answered > 0 ? answered : rate;
  }
}

/** The SetStateDynamicEntity pipeline of an Update that sets statecode (data.mjs commitUpdateSteps), one level below it.
 * Under a bare Web API PATCH it joins the Update's request beneath that request's Upsert main operation, at its own
 * depth (native ownerAndState: SetStateDynamicEntity/10/d2 < Upsert/30/d2, one RequestId and OperationId). */
export function runStateMessage(store, mapping, row, identity, options = {}) {
  const scalar = (value) => Number(value?.value ?? value);
  const id = row[mapping.idColumn],
    update = store.pluginFrames?.get(row),
    depth = (update?.operationDepth ?? messageDepth(store)) + 1;
  const request = Object.fromEntries(
    [
      ['RequestId', update?.requestId],
      ['OperationId', update?.operationId ?? update?.requestId],
      ['CorrelationId', update?.correlationId],
    ]
      .filter(([, value]) => value != null)
      .map(([name, value]) => [name, { $type: 'Guid', value }]),
  );
  const parentContext = update?.sdkFrameworkSource
    ? selectSdkEntryParent(
        {
          $type: 'ExecutionContext',
          values: {
            Stage: 20,
            Mode: 0,
            Depth: depth,
            ...request,
            ...(update.createdOnWire ? { OperationCreatedOn: cloneStateData(update.createdOnWire) } : {}),
          },
        },
        update.sdkFrameworkSource,
      )
    : undefined;
  runMessagePipeline(store, {
    message: 'SetStateDynamicEntity',
    entity: mapping.logicalName,
    id,
    inputs: {
      EntityMoniker: { $type: 'EntityReference', logicalName: mapping.logicalName, id, name: null },
      State: { $type: 'OptionSetValue', value: scalar(row.statecode) },
      Status: { $type: 'OptionSetValue', value: scalar(row.statuscode) },
      ...(options.sdkFromSandbox === true ? { FromSandbox: true } : {}),
    },
    identity,
    depth,
    parentContext,
    acceptLanguage: options.pluginAcceptLanguage ?? '',
    bypassStepIds: options.bypassStepIds,
    bypassCustomPlugins: options.bypassCustomPlugins === true,
    bypassCustomAsync: options.bypassCustomAsync === true,
    main: () => ({ IsValid: true }),
  });
}

/**
 * DeleteMultiple on a standard (non-elastic) table: the platform runs the PreValidation stage of DeleteMultiple and of
 * each target's Delete, then refuses with 405 0x8004023b (recorded native corpus). Nothing is deleted.
 */
export function refuseDeleteMultiple(store, { mapping, rows, identity, options = {} }) {
  runMessagePipeline(store, {
    message: 'DeleteMultiple',
    entity: mapping.logicalName,
    id: EMPTY,
    inputs: {
      Targets: {
        $type: 'EntityReferenceCollection',
        values: rows.map((row) => ({
          $type: 'EntityReference',
          logicalName: mapping.logicalName,
          id: row[mapping.idColumn],
          name: null,
        })),
      },
    },
    identity,
    acceptLanguage: options.pluginAcceptLanguage ?? '',
    bypassStepIds: options.bypassStepIds,
    bypassCustomPlugins: options.bypassCustomPlugins === true,
    preValidationOnly: true,
    main: () => {
      for (const row of rows) {
        const target = { [mapping.idColumn]: row[mapping.idColumn] };
        store.runRecordSteps(
          (function* () {
            yield [
              mapping,
              'delete',
              10,
              target,
              cloneStateData(row),
              cloneStateData(row),
              identity,
              Object.keys(target),
              // Native: the per-record Delete has only its Target as input (no ConcurrencyBehavior).
              { ...options, bulkOrigin: true, omitConcurrencyBehavior: true },
            ];
          })(),
        );
      }
    },
  });
  throw new DataError('DeleteMultiple has not yet been implemented', 405, 'NotImplemented', {
    innerCode: '0x8004023b',
  });
}
