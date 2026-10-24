// Elastic tables. An elastic table is a
// standard-shaped table with a partitionid column, a built-in key over (primary key, partitionid), and a time-to-live
// column (ttlinseconds). This module holds the TableType rules the metadata writers consult and the TTL expiry.
// Every rule keys on mapping.tableType === "Elastic", so portal and Solution mappings are unaffected.
// The restrictions are documented without error codes: each refusal is a guessed 400 InvalidRequest.
import { DataError } from './data-error.mjs';
import { createHash } from 'node:crypto';
import { contextUrl } from './dataverse-url.mjs';
import { compileCosmosQuery, cosmosParameters } from './dataverse-cosmos-query.mjs';
const refuse = (message) => new DataError(message, 400, 'InvalidRequest'); // status and code are guesses
const bare = (type) => String(type ?? '').replace(/^#?Microsoft\.Dynamics\.CRM\./, '');
const flagOf = (value) => (value !== null && typeof value === 'object' ? value.Value === true : value === true);
const valueOf = (value) => (value !== null && typeof value === 'object' ? value.Value : value);

export const TABLE_TYPES = ['Standard', 'Elastic'];
export const isElastic = (mapping) => mapping?.tableType === 'Elastic';

// Partition identifiers are opaque, case-sensitive strings. A missing partition addresses only rows created without one.
export const samePartition = (left, right) => (left ?? null) === (right ?? null);
export function assertPartition(value) {
  if (value == null) return;
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') > 1024 || /[/<>*%&:\\?+]/.test(value)) {
    throw refuse('partitionid must be a string of at most 1024 bytes without unsupported alternate-key characters.');
  }
}
export function assertElasticRecord(row) {
  assertPartition(row.partitionid);
  if (
    row.ttlinseconds != null &&
    (!Number.isInteger(row.ttlinseconds) || row.ttlinseconds < 1 || row.ttlinseconds > 2147483647)
  )
    throw refuse('ttlinseconds must be an integer between 1 and 2147483647.');
}
export function recordKey(mapping, row) {
  const id = row[mapping.idColumn];
  return isElastic(mapping) && row.partitionid != null
    ? `${mapping.idColumn}=${id},partitionid='${String(row.partitionid).replaceAll("'", "''")}'`
    : String(id);
}

/** TableType from a create body: Standard when omitted. Other values are refused. */
export function tableTypeOf(value) {
  if (value === undefined || value === null) return 'Standard';
  const match = TABLE_TYPES.find((type) => type.toLowerCase() === String(valueOf(value) ?? '').toLowerCase());
  if (!match) throw refuse(`TableType must be Standard or Elastic.`);
  return match;
}

// System columns every elastic table gets (the facts match the backgroundoperation entry of the standard file).
// Written as Web API attribute bodies so the metadata writer's addColumn reads them like any other column.
export const SYSTEM_ATTRIBUTES = [
  {
    '@odata.type': '#Microsoft.Dynamics.CRM.StringAttributeMetadata',
    SchemaName: 'PartitionId',
    MaxLength: 100,
    FormatName: { Value: 'Text' },
    DisplayName: { LocalizedLabels: [{ Label: 'Partition Id', LanguageCode: 1033 }] },
  },
  {
    '@odata.type': '#Microsoft.Dynamics.CRM.IntegerAttributeMetadata',
    SchemaName: 'TTLInSeconds',
    MinValue: 1,
    MaxValue: 2147483647,
    DisplayName: { LocalizedLabels: [{ Label: 'Time to live', LanguageCode: 1033 }] },
  },
];

/** The built-in alternate key every elastic table gets: primary key plus partitionid. */
export function builtInKey(idColumn) {
  return {
    name: 'keyfornosqlentitywithpkpartitionid',
    schemaName: 'KeyForNoSqlEntityWithPKPartitionId',
    attributes: [idColumn, 'partitionid'],
    labels: { 1033: 'Entity key for NoSql Entity that contains PrimaryKey and PartitionId attributes' },
    builtIn: true,
  };
}

// Column types an elastic table cannot have.
const REFUSED_TYPES = new Map([
  ['MoneyAttributeMetadata', 'Money'],
  ['MultiSelectPicklistAttributeMetadata', 'MultiSelectPicklist'],
  ['StateAttributeMetadata', 'State'],
  ['StatusAttributeMetadata', 'Status'],
  ['ImageAttributeMetadata', 'Image'],
]);
// Whole-number formats other than None are not available (Duration, Language code, Time zone).
const WHOLE_NUMBER_FORMATS = new Set(['duration', 'languagecode', 'language', 'timezone', 'time zone']);

/** Refuses a column body an elastic table cannot take. Calculated, rollup and formula columns (SourceType 1, 2 or 3). */
export function assertElasticColumn(attr) {
  const type = bare(attr?.['@odata.type']);
  const name = REFUSED_TYPES.get(type);
  if (name) throw refuse(`${name} columns are not supported on elastic tables.`);
  const source = Number(valueOf(attr?.SourceType));
  if (source === 1 || source === 2 || source === 3 || attr?.FormulaDefinition)
    throw refuse('Calculated, rollup and formula columns are not supported on elastic tables.');
  if (type === 'IntegerAttributeMetadata') {
    const format = String(valueOf(attr.Format) ?? 'None')
      .toLowerCase()
      .replace(/\s+/g, '');
    if (WHOLE_NUMBER_FORMATS.has(format))
      throw refuse(`Whole number format ${valueOf(attr.Format)} is not supported on elastic tables.`);
  }
}

/** Table-level flags an elastic table refuses (charts and duplicate detection are not supported). */
export function assertElasticTable(body) {
  if (flagOf(body.CanCreateCharts)) throw refuse('Charts are not supported on elastic tables.');
  if (flagOf(body.IsDuplicateDetectionEnabled)) throw refuse('Duplicate detection is not supported on elastic tables.');
  for (const attr of body.Attributes ?? []) assertElasticColumn(attr);
}

/** Alternate keys cannot be created on an elastic table: only the built-in one exists. */
export function assertElasticKey() {
  throw refuse("You can't create custom alternate keys for elastic tables.");
}

/** N:N relationships are not supported with an elastic table, on either side. */
export function assertElasticManyToMany(...mappings) {
  if (mappings.some(isElastic)) throw refuse('Many-to-many relationships are not supported with elastic tables.');
}

/**
 * One-to-many relationships with an elastic table: the lookup must sit on a standard table (many-to-one
 * is documented only when the N table is standard), and every cascade must be NoCascade (Cascade.None). Returns the cascade to store.
 */
export function assertElasticOneToMany({ referencing, referenced, cascade }) {
  if (isElastic(referencing)) throw refuse('A lookup on an elastic table is not supported.');
  if (!isElastic(referenced)) return cascade;
  const values = Object.values(cascade ?? {}).map((value) => String(value).toLowerCase());
  if (values.some((value) => value !== 'nocascade' && value !== 'none')) {
    throw refuse('Cascading behavior must be None for a relationship to an elastic table.');
  }
  return Object.fromEntries(
    ['Archive', 'Assign', 'Delete', 'Merge', 'Reparent', 'RollupView', 'Share', 'Unshare'].map((name) => [
      name,
      'NoCascade',
    ]),
  );
}

/** The companion string column a lookup to an elastic table gets: <lookup>pid, holding the partitionid. */
export const partitionColumnOf = (lookup) => `${lookup}pid`;

// ---- TTL expiry

/** Expiry instant in ms: modifiedon (createdon before the first write) plus ttlinseconds. Null when there is no TTL. */
export function expiresAt(row) {
  const ttl = row?.ttlinseconds;
  if (ttl === null || ttl === undefined || ttl === '') return null;
  const base = Date.parse(row.modifiedon ?? row.createdon ?? '');
  return Number.isFinite(base) ? base + Number(ttl) * 1000 : null;
}
export const isExpired = (row, now) => {
  const at = expiresAt(row);
  return at !== null && at <= now;
};

/** Rows of one table with the expired ones removed. Called from DataStore.tableRows, so every reader (Dataverse or portal) sees it. */
export function liveRows(rows, now) {
  return rows.some((row) => isExpired(row, now)) ? rows.filter((row) => !isExpired(row, now)) : rows;
}

const elasticTables = (store) =>
  Object.keys(store.state.mappings).filter((logical) => isElastic(store.state.mappings[logical]));
const hasExpired = (store, now) =>
  elasticTables(store).some((logical) => (store.state.tables[logical] ?? []).some((row) => isExpired(row, now)));

/**
 * Purges every expired elastic row in one store transaction: a system delete, with no plug-in pipeline of its own.
 * Each delete is a committed delete event, so change tracking reports it. Returns the number of rows purged.
 */
export function sweepExpired(api) {
  const { store } = api;
  const now = api.clock();
  if (!hasExpired(store, now)) return Promise.resolve(0);
  return store.transact(() => {
    let purged = 0;
    for (const logical of elasticTables(store)) {
      const mapping = store.state.mappings[logical];
      const rows = store.state.tables[logical] ?? [];
      for (let index = rows.length - 1; index >= 0; index -= 1) {
        const row = rows[index];
        if (!isExpired(row, now)) continue;
        store.removeRow(logical, rows, index);
        store.recordCommittedEvent(logical, 'delete', row, [mapping.idColumn], {
          target: { [mapping.idColumn]: row[mapping.idColumn] },
          previous: row,
          identity: null,
        });
        purged += 1;
      }
    }
    return purged;
  });
}

const lifecycles = new WeakMap();

// ExecuteCosmosSqlQuery. The local engine is immediately
// consistent; supplying a SessionToken preserves read-your-writes without fabricating eventual-consistency delays.
function installCosmosQuery(api) {
  api.registry.register({
    name: 'ExecuteCosmosSqlQuery',
    kind: 'function',
    binding: 'unbound',
    soapResult: 'Result',
    csdl: `<ComplexType Name="ParameterCollection"><Property Name="Keys" Type="Collection(Edm.String)" /><Property Name="Values" Type="Collection(mscrm.Object)" /></ComplexType>
<Function Name="ExecuteCosmosSqlQuery"><Parameter Name="QueryText" Type="Edm.String" Nullable="false" /><Parameter Name="EntityLogicalName" Type="Edm.String" Nullable="false" /><Parameter Name="QueryParameters" Type="mscrm.ParameterCollection" /><Parameter Name="PageSize" Type="Edm.Int64" /><Parameter Name="PagingCookie" Type="Edm.String" /><Parameter Name="PartitionId" Type="Edm.String" /><ReturnType Type="mscrm.crmbaseentity" Nullable="false" /></Function>`,
    handle: (ctx) => {
      const args = { ...(ctx.body ?? {}), ...(ctx.params ?? {}) };
      const mapping = api.store.resolveMapping(String(args.EntityLogicalName ?? ''));
      if (!isElastic(mapping)) throw refuse('ExecuteCosmosSqlQuery requires an elastic table.');
      api.principals.authorize({ user: ctx.user, entity: mapping.logicalName, operation: 'read', mapping });
      const parameters = cosmosParameters(args.QueryParameters);
      const execute = compileCosmosQuery(args.QueryText, parameters);
      // Column security as on every read: a masked column is never a WHERE or ORDER BY operand (0x80041155), and the documents
      // carry what the caller receives (hidden columns null, masked columns masked), so a projection or DISTINCT sees no clear value.
      const view = { unmask: false, single: false };
      if (
        execute.operands.some(
          (path) =>
            path[1] === 'props' &&
            api.fieldSecurity?.maskedFor?.(ctx.user, mapping.logicalName, String(path[2] ?? ''), view),
        )
      )
        throw api.fieldSecurity.maskedOperand();
      const readFilter = api.principals.readFilter({ user: ctx.user, entity: mapping.logicalName, mapping });
      const rows = api.store
        .tableRows(mapping.logicalName)
        .filter(
          (row) =>
            (args.PartitionId == null || samePartition(row.partitionid, args.PartitionId)) &&
            (!readFilter || readFilter(row)),
        )
        .map((row) => {
          const props = { ...(api.fieldSecurity?.mask?.(ctx.user, mapping.logicalName, row, { view }) ?? row) };
          for (const [name, value] of Object.entries(props)) {
            if (typeof value !== 'string' || !/^[\s]*[[{]/.test(value)) continue;
            const definition = api.store.fieldDefinition(mapping.logicalName, name, api.metadataFields);
            const format =
              definition?.columnMetadata?.formatName ??
              definition?.columnMetadata?.format ??
              definition?.formatName ??
              definition?.format;
            if (String(format?.Value ?? format).toLowerCase() !== 'json') continue;
            try {
              props[name] = JSON.parse(value);
            } catch {
              /* An invalid legacy JSON value stays a string. */
            }
          }
          return { id: row[mapping.idColumn], ttl: row.ttlinseconds, props };
        });
      const results = execute(rows);
      const size = args.PageSize == null ? 500 : Number(args.PageSize);
      if (!Number.isSafeInteger(size) || size < 1 || size > 5000)
        throw refuse('PageSize must be an integer between 1 and 5000.');
      const scope = createHash('sha256')
        .update(
          JSON.stringify([
            mapping.logicalName,
            args.QueryText,
            parameters,
            args.PartitionId ?? null,
            ctx.user?.systemuserid,
            size,
          ]),
        )
        .digest('hex');
      let offset = 0;
      if (args.PagingCookie != null) {
        let cookie;
        try {
          cookie = JSON.parse(Buffer.from(String(args.PagingCookie), 'base64url').toString('utf8'));
        } catch {
          throw refuse('Invalid Cosmos SQL paging cookie.');
        }
        if (cookie.scope !== scope || !Number.isSafeInteger(cookie.offset) || cookie.offset < 0)
          throw refuse('Invalid Cosmos SQL paging cookie.');
        offset = cookie.offset;
      }
      const page = results.slice(offset, offset + size),
        more = offset + page.length < results.length;
      return {
        status: 200,
        body: {
          '@odata.context': contextUrl(ctx.origin, ctx.version, 'Microsoft.Dynamics.CRM.expando'),
          '@odata.type': '#Microsoft.Dynamics.CRM.expando',
          PagingCookie: more
            ? Buffer.from(JSON.stringify({ scope, offset: offset + page.length })).toString('base64url')
            : null,
          HasMore: more,
          Result: JSON.stringify(page),
        },
      };
    },
  });
}
export function close(api) {
  const lifecycle = lifecycles.get(api);
  if (!lifecycle) return;
  clearInterval(lifecycle.timer);
  if (api.store.expiryFilter === lifecycle.filter) api.store.expiryFilter = lifecycle.previous;
  lifecycles.delete(api);
}

export function install(api) {
  close(api);
  const { store } = api;
  installCosmosQuery(api);
  // Reads filter first, so an expired row is invisible from the moment its time runs out; the purge only removes it.
  const previous = store.expiryFilter;
  const filter = (logical, rows) => liveRows(rows, api.clock());
  store.expiryFilter = filter;
  // The lazy filter hides expired rows immediately; the timer removes their storage and reports the system deletes.
  const timer = setInterval(() => {
    if (!hasExpired(store, api.clock())) return;
    Promise.resolve()
      .then(() => api.change(() => sweepExpired(api)))
      .catch((error) => api.log?.('elastic TTL purge failed', { message: error?.message }));
  }, 1000);
  timer.unref?.();
  lifecycles.set(api, { timer, filter, previous });
}
