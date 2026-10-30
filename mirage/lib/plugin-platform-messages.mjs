// Named platform messages a plug-in issues through IOrganizationService.Execute, each with its own plug-in pipeline
// (PreValidation, PreOperation, main operation, PostOperation and the committed asynchronous event), as the recorded
// native corpus shows: Assign, SetState (executed as SetStateDynamicEntity), GrantAccess, ModifyAccess, RevokeAccess,
// RetrievePrincipalAccess, RetrieveSharedPrincipalsAndAccess. Upsert runs no pipeline of its own: its existence query
// and the delegated Create or Update run instead. Merge refuses tables the platform cannot merge.
import { DataError } from './data-error.mjs';
import { cloneStateData } from './state-clone.mjs';
import { initializePluginOperation } from './plugin-operation-context.mjs';
import { pluginInvocationDepth, pluginInvocationSdkParent } from './plugin-execution-lifetime.mjs';
import { recordRequestRootChange, selectSdkEntryParent } from './plugin-sdk-parent.mjs';
import { PLUGIN_DEPTH_MESSAGE, PLUGIN_MAX_DEPTH, pluginExecutionDepth } from './plugin-clr.mjs';
import { authorizeGrant } from './local-organization-service.mjs';
import { ACCESS_RIGHTS, createPrincipals, grantAccessNow, revokeAccessNow } from './dataverse-security.mjs';

const EMPTY = '00000000-0000-0000-0000-000000000000';
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// The tables with a Merge message filter (dataverse-record-messages.mjs implements Merge for them over the Web API).
const MERGE_TABLES = new Set(['account', 'contact', 'lead', 'incident']);
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
const maskOfNames = (names) =>
  String(names ?? '')
    .split(',')
    .map((part) => ACCESS_RIGHTS[part.trim().replace(/Access$/, '')] ?? 0)
    .reduce((mask, right) => mask | right, 0);
const sharesOf = (store, target) =>
  store
    .tableRows('principalobjectaccess')
    .filter((row) => same(row.objectid, target.id) && same(row.objecttypecode, target.logicalName));
const principalIdOf = (row) => row.principalid?.id ?? row.principalid;

// The depth of a message issued now: one below the calling plug-in or operation. A nested caller's SDK parent is the
// depth-1 step (plugin-clr.mjs dispatchSdkCall), so the executing CLR steps count too.
function messageDepth(store) {
  const depth =
    Math.max(
      pluginExecutionDepth(),
      pluginInvocationDepth(store),
      Number((store.pluginParentContext ?? pluginInvocationSdkParent(store))?.values?.Depth ?? 0),
    ) + 1;
  if (depth > PLUGIN_MAX_DEPTH) fail(PLUGIN_DEPTH_MESSAGE, 'LocalPluginDepth', 400);
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
    // The platform frame the message runs under when no plug-in issued it (a PATCH statecode's Upsert main operation).
    parentContext: platformParent,
    // Reads run outside the automatic transaction (native sdkMessages: RetrievePrincipalAccess and
    // RetrieveSharedPrincipalsAndAccess report IsAutoTransact false).
    autoTransact = true,
  },
) {
  const operation = message.toLowerCase(),
    mapping = store.resolveMapping(entity),
    record = { [mapping.idColumn]: id ?? EMPTY },
    customApi = { name: message, platformMessage: true, bindingType: 0, parameters: [], properties: [] },
    requestTag = store.pluginSdkTag;
  const values = { ...inputs };
  if (requestTag !== undefined) values.tag = requestTag;
  if (Object.hasOwn(inputs, 'FromSandbox')) {
    delete values.FromSandbox;
    values.FromSandbox = inputs.FromSandbox;
  }
  const messageParameters = {
    inputParameters: { $type: 'ParameterCollection', values },
    outputParameters: { $type: 'ParameterCollection', values: {} },
  };
  const active =
    Boolean(store.pluginPipeline) &&
    store.pluginPipelineActive({ entity: mapping.logicalName, operation, bypassCustomPlugins, bypassStepIds });
  const parentContext = platformParent ?? store.pluginParentContext ?? pluginInvocationSdkParent(store);
  let frame = {
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
  const phase = (stage) => {
    if (stage !== 10) store.pluginInTransaction = true;
    if (!active) return;
    frame =
      store.pluginPipeline({
        store,
        entity: mapping.logicalName,
        operation,
        stage,
        record,
        identity,
        changedAttributes: [],
        bypassStepIds,
        bypassCustomPlugins,
        customApi,
        messageParameters,
        ...(stage === 10 ? { initialFrame: frame } : {}),
      }) ?? frame;
  };
  try {
    phase(10);
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
    let outputs;
    try {
      outputs = main() ?? {};
    } finally {
      store.pluginMainOperation = previousMain;
    }
    if (preValidationOnly) return outputs;
    messageParameters.outputParameters.values = { ...outputs };
    phase(40);
    store.pluginFrames ??= new WeakMap();
    store.pluginFrames.set(record, frame);
    store.recordCommittedEvent(mapping.logicalName, operation, record, [], {
      customApi,
      target: {},
      identity,
      messageEvent: true,
      bypassCustomAsync,
      bypassStepIds,
    });
    return messageParameters.outputParameters.values;
  } catch (error) {
    store.markPluginTransactionFailure?.(error);
    throw error;
  } finally {
    store.pluginInTransaction = inherited;
  }
}

/**
 * IOrganizationService.Execute of a named platform message from a plug-in. service is the caller's local organization
 * service; invoke(method, args) runs a record SDK method (Create, Update, RetrieveMultiple) as the plug-in would.
 * Authorization uses the explicit backend grants: update on the target for Assign, SetState and sharing changes, read for
 * the access queries (the profile's grants stand in for the Assign/Share privileges, which it does not model).
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
  const innerUpdate = (target, values) =>
    service.messageUpdate(target.logicalName, target.id, values, {
      skipPreValidation: true,
      omitConcurrencyBehavior: true,
      stateMessage: false,
      sdkFromSandbox: false,
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
      existing(target, 'update');
      named({ Target: parameters.Target, Assignee: parameters.Assignee }, target, () => {
        // Natively the Assign main operation updates the owner as the organization's system user.
        const system = store.tableRows('systemuser').find((row) => row.fullname === 'SYSTEM');
        const previous = store.pluginExecutionUserId;
        if (system) store.pluginExecutionUserId = system.systemuserid;
        try {
          innerUpdate(target, { ownerid: { id: assignee.id, logical_name: assignee.logicalName } });
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
      existing(target, 'update');
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
      if (!GUID.test(target.id ?? '') || target.id === EMPTY)
        fail('SDK Upsert requires a Target with a primary key value.', 'LocalPluginSdkUnsupported', 501);
      // Natively both run at the calling plug-in's depth, with its context as their parent (recorded corpus).
      const caller = store.pluginParentContext ?? pluginInvocationSdkParent(store),
        previousMain = store.pluginMainOperation;
      if (caller)
        store.pluginMainOperation = {
          context: caller,
          depth: Math.max(Number(caller.values?.Depth ?? 1), pluginExecutionDepth()),
          exactDepth: true,
          keepsRequestTag: true,
        };
      let created;
      try {
        const found = invoke('RetrieveMultiple', [
          {
            $type: 'QueryExpression',
            entityName: mapping.logicalName,
            columnSet: { allColumns: false, columns: [] },
            criteria: {
              operatorName: 'And',
              conditions: [
                {
                  attributeName: mapping.idColumn,
                  operatorName: 'Equal',
                  values: [{ $type: 'Guid', value: target.id }],
                },
              ],
              filters: [],
            },
            orders: [],
            linkEntities: [],
            topCount: 2,
            distinct: false,
            noLock: false,
          },
        ]);
        created = !found?.entities?.length;
        invoke(created ? 'Create' : 'Update', [target]);
      } finally {
        store.pluginMainOperation = previousMain;
      }
      return respond({
        RecordCreated: created,
        Target: { $type: 'EntityReference', logicalName: mapping.logicalName, id: target.id, name: null },
      });
    }
    case 'Merge': {
      const target = reference(parameters.Target, 'Target');
      if (!MERGE_TABLES.has(target.logicalName)) throw mergeUnsupported(target.logicalName);
      return fail('SDK Merge requires the Web API Merge message adapter.');
    }
  }
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
              { ...options, omitConcurrencyBehavior: true },
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
