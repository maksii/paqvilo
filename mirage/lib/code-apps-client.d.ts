export interface CodeAppContext {
  app: {
    appId: string;
    appSettings: Record<string, unknown>;
    environmentId: string;
    queryParams: Record<string, string>;
    dataverseOrgUrl: string;
    appUrl: string;
  };
  user: {
    fullName: string;
    objectId: string;
    systemUserId: string;
    tenantId: string;
    userPrincipalName: string;
  };
  host: { sessionId: string };
}
export interface CodeAppEvent {
  kind: 'request' | 'request-error';
  method: string;
  /** Query values and parenthesized record keys are omitted. */
  path: string;
  status: number;
  durationMs: number;
}
export function configure(options: { app: string; origin?: string; onEvent?: (event: CodeAppEvent) => void }): void;
export function getContext(): Promise<CodeAppContext>;
export function getStatus(): Promise<{
  name: string;
  mode: 'simulation';
  entitySets: Record<string, string>;
  appSettingNames: string[];
  diagnostics: { code: string; message: string }[];
}>;
export function getToken(resource: string): Promise<{ access_token: string; expires_on: number }>;
export interface CodeAppQuery {
  select?: string | string[];
  filter?: string;
  orderBy?: string | string[];
  top?: number;
  skipToken?: string;
  maxPageSize?: number;
  count?: boolean;
}
export interface CodeAppResult<T> {
  data: T;
  count?: number;
  skipToken?: string | null;
  fileName?: string;
}
export const dataClient: {
  create<T = Record<string, unknown>>(entitySet: string, record: unknown): Promise<CodeAppResult<T>>;
  get<T = Record<string, unknown>>(entitySet: string, id: string, options?: CodeAppQuery): Promise<CodeAppResult<T>>;
  getAll<T = Record<string, unknown>>(entitySet: string, options?: CodeAppQuery): Promise<CodeAppResult<T[]>>;
  update<T = Record<string, unknown>>(entitySet: string, id: string, changes: unknown): Promise<CodeAppResult<T>>;
  delete(entitySet: string, id: string): Promise<CodeAppResult<undefined>>;
  uploadFile(
    entitySet: string,
    id: string,
    column: string,
    fileName: string,
    data: BodyInit,
  ): Promise<CodeAppResult<undefined>>;
  downloadFile(entitySet: string, id: string, column: string, fullSize?: boolean): Promise<CodeAppResult<Uint8Array>>;
  deleteFile(entitySet: string, id: string, column: string): Promise<CodeAppResult<undefined>>;
  executeDataverseAction<T = unknown>(operation: string, body?: unknown): Promise<CodeAppResult<T>>;
  getEntityMetadata(
    table: string,
    options?: {
      metadata?: string[];
      schema?: { columns?: 'all' | string[]; oneToMany?: boolean; manyToOne?: boolean; manyToMany?: boolean };
    },
  ): Promise<CodeAppResult<Record<string, unknown>>>;
  execute<T = unknown>(reference: string, operation: string, parameters?: unknown): Promise<CodeAppResult<T>>;
};
