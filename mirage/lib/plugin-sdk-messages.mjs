// Organization messages a CLR plug-in issues through IOrganizationService.Execute beyond the record, platform and custom API
// messages plugin-clr.mjs routes itself: WhoAmI, RetrieveVersion, ExecuteMultiple, ExecuteTransaction and the metadata
// reads the SOAP Organization service answers synchronously (dataverse-soap-metadata.mjs). Each answer is an SDK response
// wire value the CLR host decodes into the message's own response class (Microsoft.Xrm.Sdk.Messages or the Proxy's
// Microsoft.Crm.Sdk.Messages); metadata answers travel as the SOAP Execute XML the official DataContractSerializer reads.
// Also: the OrganizationServiceFault an SDK caller receives for an organization failure (sdkFault).
import { DataError } from './data-error.mjs';
import { dataverseError } from './dataverse-odata.mjs';
import { organizationRecord } from './organization-context.mjs';
import { metadataRequests } from './dataverse-soap-metadata.mjs';
import { encodeValue, envelope } from './dataverse-soap-xml.mjs';
import { xmlEscapeAttribute } from './fetchxml-engine.mjs';
import { effectiveEnvironmentVariables } from './secret-resolver.mjs';
import { notifyServiceEndpoint } from './dataverse-webhooks.mjs';

const fail = (message, code = 'LocalPluginSdkUnsupported', status = 501, details) => {
  throw new DataError(message, status, code, details);
};
const invalid = (message) => fail(message, 'InvalidArgument', 400, { innerCode: '0x80040203' });
const same = (a, b) => String(a ?? '').toLowerCase() === String(b ?? '').toLowerCase();
const refId = (value) => (value && typeof value === 'object' ? value.id : value) ?? null;
const guid = (value) => (value == null ? null : { $type: 'Guid', value });
// ExecuteMultiple runs at most this many requests (SDK documentation: the default batch size limit of 1,000).
const MAX_BATCH = 1000;
const OPTIONAL = [
  'tag',
  'BypassCustomPluginExecution',
  'BypassBusinessLogicExecution',
  'BypassBusinessLogicExecutionStepIds',
];
const response = (responseName, results = {}) => ({ $type: 'OrganizationResponse', responseName, results });
const sdkObject = (type, members) => ({ $type: 'Object', type, members });
const sdkCollection = (type, values) => ({ $type: 'Collection', type, values });

/** The organization API behind a store (its record entries carry it), or null for a store without an organization. */
export const organizationApiOf = (store) => store.recordPipeline?.organizationApi ?? null;

/**
 * The OrganizationServiceFault a plug-in's FaultException<OrganizationServiceFault> carries for an organization failure:
 * the Dataverse error code the Web API answers for the same failure (its innerCode, else the code its status maps to).
 * null for a local adapter gap (501) or an error that is not a DataError: those stay NotSupportedException in the host.
 */
export function sdkFault(cause) {
  if (!(cause instanceof DataError) || cause.status === 501) return null;
  const inner = cause.details?.innerCode ?? (cause.code === 'NotFound' ? '0x80040217' : null);
  const hex = /^0x[a-f\d]{1,8}$/i.test(inner ?? '') ? inner : dataverseError(cause).body?.error?.code;
  if (!/^0x[a-f\d]{1,8}$/i.test(hex ?? '')) return null;
  return {
    $type: 'OrganizationServiceFault',
    errorCode: parseInt(hex, 16) | 0,
    message: cause.message,
    timestamp: new Date().toISOString(),
    errorDetails: cause.details?.sourceException?.exceptionDetails ?? {},
    ...(Number.isInteger(cause.faultedRequestIndex) ? { faultedRequestIndex: cause.faultedRequestIndex } : {}),
    provenance: 'Local modeled SDK fault; native timestamp/correlation/stack are not available',
  };
}

const onlyParameters = (name, parameters, allowed) => {
  const extra = Object.keys(parameters).find((key) => !allowed.includes(key) && !OPTIONAL.includes(key));
  if (extra) fail(`Unsupported SDK ${name} parameter: ${extra}`);
};
const requestsOf = (value, name) => {
  if (value?.$type !== 'Collection' || !Array.isArray(value.values))
    invalid(`${name} requires an OrganizationRequestCollection of Requests.`);
  if (value.values.some((request) => request?.$type !== 'OrganizationRequest'))
    invalid(`${name} Requests must be requests.`);
  return value.values;
};
const memberOf = (value, name) => (value?.$type === 'Object' ? value.members?.[name] : undefined);
// A boolean request input: absent or nil is false, as the SDK's default(bool) member is.
const flag = (value, name) => {
  if (value == null) return false;
  if (typeof value !== 'boolean') invalid(`${name} requires a Boolean value.`);
  return value;
};

// The metadata messages the SOAP service answers synchronously, with their request values in the SOAP decoder's shape.
function soapParameter(value) {
  if (value == null) return null;
  if (typeof value === 'string') return { type: 'string', value };
  if (typeof value === 'boolean') return { type: 'boolean', value };
  if (typeof value === 'number') return { type: 'int', value };
  if (value.$type === 'Guid') return { type: 'guid', value: value.value };
  if (value.$type === 'Enum') return { type: 'Enum', value: Number(value.value) };
  fail('Unsupported SDK metadata request value: ' + (value.$type ?? typeof value));
}
function metadataResponse(api, name, parameters) {
  const handler = metadataRequests(api).get(name);
  // Metadata writes go through the asynchronous Web API metadata routes; the synchronous SDK drive cannot await them.
  if (!handler || handler.constructor.name === 'AsyncFunction') return null;
  if (name === 'RetrieveMetadataChanges' && parameters.Query != null)
    fail('RetrieveMetadataChanges with an EntityQueryExpression is not read on the plug-in SDK drive.');
  const params = new Map(
    Object.entries(parameters)
      .filter(([key]) => !OPTIONAL.includes(key))
      .map(([key, value]) => [key, soapParameter(value)]),
  );
  const descriptor = handler(params, { api });
  const results = [...descriptor.results]
    .map(
      ([key, value]) =>
        value?.rawValueXml ??
        `<a:KeyValuePairOfstringanyType><b:key>${xmlEscapeAttribute(key)}</b:key>${encodeValue('b:value', value)}</a:KeyValuePairOfstringanyType>`,
    )
    .join('');
  return {
    $type: 'OrganizationResponseXml',
    xml: envelope(
      `<svc:ExecuteResponse><svc:ExecuteResult xmlns:r="${descriptor.namespace}" i:type="r:${descriptor.responseType}">` +
        `<a:ResponseName>${xmlEscapeAttribute(descriptor.name)}</a:ResponseName><a:Results>${results}</a:Results>` +
        `</svc:ExecuteResult></svc:ExecuteResponse>`,
    ),
  };
}

/**
 * Answers one Execute request whose message plugin-clr.mjs does not route itself, or returns undefined when the local
 * organization has no synchronous answer for it. userId is the service's user; dispatch(request) executes one nested
 * request wire value exactly as the plug-in's own Execute would and returns its response wire value.
 */
export function executeSdkOrganizationMessage({ store, userId, request, parameters, dispatch }) {
  const name = request.requestName;
  switch (name) {
    case 'WhoAmI': {
      onlyParameters(name, parameters, []);
      const user = store.tableRows('systemuser').find((row) => same(row.systemuserid, userId));
      if (!user) fail(`systemuser With Id = ${userId} Does Not Exist`, 'NotFound', 404, { innerCode: '0x80040217' });
      const organizationId = refId(user.organizationid) ?? organizationRecord(store)?.organizationid ?? null;
      return response(name, {
        UserId: guid(user.systemuserid),
        BusinessUnitId: guid(refId(user.businessunitid)),
        OrganizationId: guid(organizationId),
      });
    }
    case 'RetrieveVersion': {
      onlyParameters(name, parameters, []);
      const api = organizationApiOf(store);
      if (!api) return undefined;
      return response(name, { Version: String(api.settings?.version ?? '') });
    }
    case 'ExecuteMultiple': {
      onlyParameters(name, parameters, ['Requests', 'Settings']);
      const requests = requestsOf(parameters.Requests, name);
      if (requests.length > MAX_BATCH)
        invalid(`The ExecuteMultiple request has ${requests.length} requests; the maximum is ${MAX_BATCH}.`);
      const settings = parameters.Settings;
      const continueOnError = flag(memberOf(settings, 'ContinueOnError'), 'ContinueOnError');
      const returnResponses = flag(memberOf(settings, 'ReturnResponses'), 'ReturnResponses');
      const items = [];
      let faulted = false;
      for (const [index, inner] of requests.entries()) {
        let answer, fault;
        try {
          if (inner.requestName === 'ExecuteMultiple')
            invalid('An ExecuteMultiple request cannot contain another ExecuteMultiple request.');
          answer = dispatch(inner);
        } catch (cause) {
          fault = sdkFault(cause);
          if (!fault) throw cause;
        }
        if (fault) faulted = true;
        if (fault || returnResponses)
          items.push(
            sdkObject('Microsoft.Xrm.Sdk.ExecuteMultipleResponseItem', {
              RequestIndex: index,
              ...(fault ? { Fault: fault } : { Response: answer }),
            }),
          );
        // Without ContinueOnError processing stops at the faulted item, which is still returned.
        if (fault && !continueOnError) break;
      }
      return response(name, {
        IsFaulted: faulted,
        Responses: sdkCollection('Microsoft.Xrm.Sdk.ExecuteMultipleResponseItemCollection', items),
      });
    }
    case 'ExecuteTransaction': {
      onlyParameters(name, parameters, ['Requests', 'ReturnResponses']);
      const requests = requestsOf(parameters.Requests, name);
      const returnResponses = flag(parameters.ReturnResponses, 'ReturnResponses');
      // One savepoint: a failed request rolls back the requests before it and faults with its index. Its requests run
      // inside that transaction (they join it instead of committing on their own, and their steps see IsInTransaction).
      const responses = store.sdkMutation(() => {
        const previous = store.pluginInTransaction;
        store.pluginInTransaction = true;
        try {
          return run();
        } finally {
          store.pluginInTransaction = previous;
        }
      });
      function run() {
        return requests.map((inner, index) => {
          if (['ExecuteMultiple', 'ExecuteTransaction'].includes(inner.requestName))
            invalid('An ExecuteTransaction cannot contain another ExecuteMultiple or ExecuteTransaction.');
          try {
            return dispatch(inner);
          } catch (cause) {
            if (cause && typeof cause === 'object') cause.faultedRequestIndex = index;
            throw cause;
          }
        });
      }
      return response(name, {
        Responses: sdkCollection('Microsoft.Xrm.Sdk.OrganizationResponseCollection', returnResponses ? responses : []),
      });
    }
    default: {
      const api = organizationApiOf(store);
      return api ? (metadataResponse(api, name, parameters) ?? undefined) : undefined;
    }
  }
}

/**
 * The plug-in services besides the organization service (IServiceProvider.GetService), as the host's RPC names them
 * ("<interface>.<method>"): IEnvironmentVariableService answers the effective value of an environment variable (its value row,
 * else its definition default; null when the organization has no such definition), IFeatureControlService has no feature
 * controls locally (null), and IManagedIdentityService cannot acquire a token: a local process has no Azure managed identity
 * federated to the plug-in package.
 */
export function executePluginServiceCall({ store, method, args = [], diagnostic }) {
  switch (method) {
    case 'IServiceEndpointNotificationService.Execute': {
      const [endpoint, body] = args;
      if (endpoint?.$type !== 'EntityReference' || typeof body !== 'string')
        invalid('IServiceEndpointNotificationService.Execute requires a service endpoint reference and a context.');
      return notifyServiceEndpoint(store, endpoint.id, body, diagnostic);
    }
    case 'IEnvironmentVariableService.RetrieveEnvironmentVariableValue': {
      const [name] = args;
      if (typeof name !== 'string' || !name) invalid('An environment variable schema name is required.');
      const entry = effectiveEnvironmentVariables(store.state)[name.toLowerCase()];
      if (entry?.secret)
        fail('A secret environment variable is resolved by its Key Vault provider, not by the local plug-in service.');
      return entry?.value ?? null;
    }
    case 'IFeatureControlService.GetFeatureControl':
      return null;
    case 'IManagedIdentityService.AcquireToken':
      fail(
        'IManagedIdentityService.AcquireToken needs the Azure managed identity federated to the plug-in package; a local process has none.',
        'LocalPluginManagedIdentityUnavailable',
      );
      break;
    default:
      fail('Unsupported plug-in service call: ' + method);
  }
}
