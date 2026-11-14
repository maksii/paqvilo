import { createCodeAppSdkExecutor, type LocalClient } from '../../lib/code-apps-sdk.js';
import { setDataOperationExecutor } from '@microsoft/power-apps/internal/data';

const partial: LocalClient = {
  getEntityMetadata: async (table, options) => ({ data: { table, options } }),
  uploadFile: async (_table, _id, _column, _name, bytes) => ({ data: bytes }),
};
const executor = createCodeAppSdkExecutor({ client: partial, entitySets: { x_item: 'x_items' } });
setDataOperationExecutor(executor);
void executor.retrieveMultipleRecordsAsync('x_item', { select: ['x_name'], count: true });
