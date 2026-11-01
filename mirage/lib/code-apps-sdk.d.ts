import type { IDataOperationExecutor } from '@microsoft/power-apps/data/executors';
import type { IOperationOptions } from '@microsoft/power-apps/data';
import type { GetEntityMetadataOptions } from '@microsoft/power-apps/data/metadata/dataverse';

interface LocalResult {
  data: unknown;
  skipToken?: string;
  count?: number;
}

export interface LocalClient {
  create?(entitySet: string, data: unknown): Promise<LocalResult>;
  get?(entitySet: string, id: string, options?: IOperationOptions): Promise<LocalResult>;
  getAll?(entitySet: string, options?: IOperationOptions): Promise<LocalResult>;
  update?(entitySet: string, id: string, changes: unknown): Promise<LocalResult>;
  delete?(entitySet: string, id: string): Promise<LocalResult>;
  execute?(reference: string, operation: string, parameters?: unknown): Promise<LocalResult>;
  uploadFile?(
    entitySet: string,
    id: string,
    column: string,
    fileName: string,
    data: string | Uint8Array | ArrayBuffer | Blob,
  ): Promise<LocalResult>;
  downloadFile?(
    entitySet: string,
    id: string,
    column: string,
    fullSize?: boolean,
  ): Promise<LocalResult & { fileName?: string }>;
  deleteFile?(entitySet: string, id: string, column: string): Promise<LocalResult>;
  executeDataverseAction?(operationName: string, body?: unknown): Promise<LocalResult>;
  getEntityMetadata?(
    tableName: string,
    options?: GetEntityMetadataOptions<Record<string, unknown>>,
  ): Promise<LocalResult>;
}

/** Optional SDK data override. It does not supply the Power Apps host or context. */
export function createCodeAppSdkExecutor(options?: {
  entitySets?: Record<string, string>;
  client?: LocalClient;
}): IDataOperationExecutor;
