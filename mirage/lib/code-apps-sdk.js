// Optional adapter for the documented Power Apps IDataOperationExecutor interface. The application supplies
// the SDK and installs this executor itself; no Microsoft SDK code or host protocol is included here.
import { dataClient } from './code-apps-client.js';

const unsupported = (message) => Object.assign(new Error(message), { status: 501, code: 'NotSimulated' });
const failure = (error) => ({
  success: false,
  data: undefined,
  error: error instanceof Error ? error : new Error(String(error)),
});

/** Create an executor for setDataOperationExecutor. entitySets maps SDK source names to local entity sets. */
export function createCodeAppSdkExecutor({ client = dataClient, entitySets = {} } = {}) {
  const entitySet = (name) => (Object.hasOwn(entitySets, name) ? entitySets[name] : name);
  const result = async (run) => {
    try {
      const answer = await run();
      return { success: true, ...answer };
    } catch (error) {
      return failure(error);
    }
  };
  const invoke = (method, ...args) => {
    if (typeof client?.[method] !== 'function') throw unsupported(`The local client does not implement ${method}.`);
    return client[method](...args);
  };
  const noPartition = (partitionId) => {
    if (partitionId != null) throw unsupported('Partitioned operations are not simulated.');
  };
  return {
    createRecordAsync: (table, data) => result(() => invoke('create', entitySet(table), data)),
    updateRecordAsync: (table, id, data, partitionId) =>
      result(() => {
        noPartition(partitionId);
        return invoke('update', entitySet(table), id, data);
      }),
    deleteRecordAsync: (table, id, partitionId) =>
      result(() => {
        noPartition(partitionId);
        return invoke('delete', entitySet(table), id);
      }),
    retrieveRecordAsync: (table, id, options) =>
      result(() => {
        noPartition(options?.partitionId);
        return invoke('get', entitySet(table), id, options);
      }),
    retrieveMultipleRecordsAsync: (table, options) =>
      result(() => {
        noPartition(options?.partitionId);
        return invoke('getAll', entitySet(table), options);
      }),
    executeAsync: (operation) =>
      result(async () => {
        const metadata = operation?.dataverseRequest;
        if (metadata?.action === 'getEntityMetadata' && !operation?.connectorOperation)
          return invoke('getEntityMetadata', metadata.parameters?.tableName, metadata.parameters?.options);
        if (
          metadata?.action === 'customapi' &&
          !operation?.connectorOperation &&
          typeof metadata.parameters?.operationName === 'string'
        )
          return invoke('executeDataverseAction', metadata.parameters.operationName, metadata.parameters.body);
        const connector = operation?.connectorOperation;
        if (
          operation?.dataverseRequest ||
          !connector ||
          typeof connector.tableName !== 'string' ||
          typeof connector.operationName !== 'string'
        )
          throw unsupported('This SDK data operation is not simulated.');
        const answer = await invoke('execute', connector.tableName, connector.operationName, connector.parameters);
        // The local connector endpoint returns a provider HTTP envelope, not the connector response itself.
        const response = answer.data;
        if (!response || !Number.isInteger(response.statusCode))
          throw unsupported('The connector returned an unsupported response.');
        if (response.statusCode < 200 || response.statusCode >= 300)
          throw Object.assign(new Error('The connector operation failed.'), {
            status: response.statusCode,
            code: 'ConnectorFailed',
          });
        return { data: response.body };
      }),
    uploadFileToRecord: (table, id, column, fileName, data, partitionId) =>
      result(() => {
        noPartition(partitionId);
        return invoke('uploadFile', entitySet(table), id, column, fileName, data);
      }),
    downloadFileFromRecord: (table, id, column, partitionId) =>
      result(() => {
        noPartition(partitionId);
        return invoke('downloadFile', entitySet(table), id, column);
      }),
    downloadImageFromRecord: (table, id, column, fullSize) =>
      result(() => invoke('downloadFile', entitySet(table), id, column, fullSize)),
    deleteFileOrImageFromRecord: (table, id, column, partitionId) =>
      result(() => {
        noPartition(partitionId);
        return invoke('deleteFile', entitySet(table), id, column);
      }),
  };
}
