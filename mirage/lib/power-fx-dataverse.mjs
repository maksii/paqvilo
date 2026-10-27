// Dataverse tables as Power Fx data sources for the engine (power-fx.mjs), and the typed record form of a stored row.
//
// dataverseHost(api, { c }) is the host every Dataverse caller hands the engine: a formula column (c null: the platform
// computes it, so it reads related rows and has no table data sources), a Dataverse Function and an automated low-code
// plug-in (c is the request or write context: tables read and write as the caller, never SYSTEM).
// Learn ("Supported functions" for Dataverse functions): functions read and write Dataverse tables with Collect, Patch,
// Filter and LookUp; delegation operations are supported and a warning is issued when an expression can't be delegated.
// Reads go through the records layer as the Web API does for the caller: the read privilege (principals.authorize), the
// caller's row filter (principals.readFilter), column security (fieldSecurity.rowMask) and the read projection
// (records.projectInternal). Writes go through records.createInternal / updateInternal / removeInternal (privileges, record
// hooks, business rules, plug-ins), synchronously, inside a store savepoint (store.sdkMutation).
// Delegated queries are OData $filter / $orderby / $top over the store's Dataverse dialect (Learn delegation table for
// Dataverse: comparisons, And/Or/Not, IsBlank, StartsWith, in, Sort, First, LookUp, CountRows, Sum/Min/Max/Average).
// Power Fx resolves Dataverse names through the table's display names; here a table is found by its entity set,
//   logical name or collection label, and a column by its logical name or its definition's displayName/label.
// ponytail: an asynchronous after-write hook of a write made by a formula finishes after the formula returns (its failure is
//   reported as POWERFX_DEFERRED_EFFECT); a formula's writes are synchronous because the engine is.
import {
  ALIASES,
  FxDataSource,
  FxDate,
  FxFloat,
  FxGuid,
  FxRecordRef,
  FxUntyped,
  isBlank,
  isNumeric,
  isRecord,
  isoOf,
  toText,
} from './power-fx.mjs';
import { isExactNumeric } from './exact-numeric.mjs';
import { organizationPrincipalContext } from './dataverse-principal-context.mjs';
import { portalLanguage } from './portal-languages.mjs';

const TEXT = new Set(['nvarchar', 'string', 'memo', 'ntext', 'text', 'varchar', 'email', 'phone', 'url']);
const NUMBER = new Set(['int', 'integer', 'bigint', 'decimal', 'money', 'float', 'double']);
const FLOAT = new Set(['float', 'double']);
const LOOKUP = new Set(['lookup', 'customer', 'owner']);
const CHOICE = new Set(['picklist', 'state', 'status', 'choice', 'optionset']);
// The stored row a record came from: { table, id }. Lets a record from one table be a lookup value in another.
const ROW = Symbol('power-fx.row');

const typeName = (definition) => String(definition?.dataverseType ?? definition?.type ?? '').toLowerCase();
const behaviourOf = (definition) =>
  String(
    definition?.behavior ??
      definition?.dateTimeBehavior ??
      definition?.DateTimeBehavior?.Value ??
      definition?.DateTimeBehavior ??
      definition?.format ??
      '',
  ).toLowerCase();
const labelOf = (value) => (typeof value === 'string' ? value : null);

export function dataverseHost(api, { c = null, diagnostic = null, timeZone = 'UTC', fieldAliases = [] } = {}) {
  const { store } = api;
  const definitions = (logical) => store.fieldDefinitions(logical, api.metadataFields) ?? {};
  // The store mapping of a table name; a mapping keyed by its logical name may omit logicalName, so the key names it.
  const mappingOf = (name) => {
    const mapping = store.resolveMapping(name);
    if (mapping.logicalName) return mapping;
    const key =
      Object.keys(store.state.mappings ?? {}).find((candidate) => store.state.mappings[candidate] === mapping) ?? name;
    return { ...mapping, logicalName: key };
  };
  const exportedAliases = (logical) => {
    const matching = fieldAliases.filter(
      (entry) => typeof entry.table === 'string' && entry.table.toLowerCase() === logical.toLowerCase(),
    );
    return matching.length === 1 ? (matching[0].fieldAliases ?? {}) : {};
  };
  // The caller (never SYSTEM): the request's user, else the acting systemuser an SDK context names.
  const caller = (() => {
    if (!c) return null;
    const user = c.user ?? (c.userId != null ? api.principals.byId?.(c.userId) : null) ?? null;
    if (!user) return null;
    const identity = c.identity ?? organizationPrincipalContext(store, user).identity;
    return { ...c, user, identity };
  })();

  function columnInfo(logical, name) {
    const mapping = mappingOf(logical);
    const fields = definitions(logical);
    let key = Object.hasOwn(fields, name) || name === mapping.idColumn ? name : null;
    if (!key) key = Object.keys(fields).find((column) => column.toLowerCase() === name.toLowerCase()) ?? null;
    if (!key)
      key =
        Object.entries(fields).find(
          ([, definition]) => labelOf(definition.displayName ?? definition.label) === name,
        )?.[0] ?? null;
    if (!key)
      key =
        Object.entries(exportedAliases(logical)).find(([, label]) => label.toLowerCase() === name.toLowerCase())?.[0] ??
        null;
    if (!key) return null;
    const definition = fields[key] ?? {};
    const type = typeName(definition);
    const kind =
      key === mapping.idColumn || type === 'uniqueidentifier'
        ? 'guid'
        : TEXT.has(type)
          ? 'text'
          : type === 'money'
            ? 'currency'
            : NUMBER.has(type)
              ? 'number'
              : LOOKUP.has(type)
                ? 'lookup'
                : CHOICE.has(type)
                  ? 'choice'
                  : type === 'datetime' || type === 'date'
                    ? behaviourOf(definition) === 'dateonly' || type === 'date'
                      ? 'date'
                      : 'datetime'
                    : type === 'bit' || type === 'boolean'
                      ? 'boolean'
                      : 'other';
    return { logical: key, odata: kind === 'lookup' ? `_${key}_value` : key, type: kind, definition };
  }
  function aliasesOf(logical) {
    const map = new Map();
    for (const [column, definition] of Object.entries(definitions(logical))) {
      const label = labelOf(definition.displayName ?? definition.label);
      if (label) map.set(label, column);
      map.set(column.toLowerCase(), column);
    }
    for (const [column, label] of Object.entries(exportedAliases(logical))) {
      map.set(label, column);
      map.set(label.toLowerCase(), column);
      map.set(column.toLowerCase(), column);
    }
    return map;
  }
  // A stored row as a typed Power Fx record: date/time by column behaviour, GUIDs, related records, exact numbers.
  function toRecord(logical, row) {
    const mapping = mappingOf(logical);
    const record = {};
    for (const [key, value] of Object.entries(row)) {
      if (key.includes('@')) continue;
      record[key] = typed(logical, key, value);
    }
    Object.defineProperty(record, ALIASES, { value: aliasesOf(logical) });
    Object.defineProperty(record, ROW, { value: { table: mapping.logicalName, id: row[mapping.idColumn] ?? null } });
    return record;
  }
  function typed(logical, key, value) {
    if (isBlank(value)) return null;
    const info = columnInfo(logical, key);
    if (info?.type === 'guid' && typeof value === 'string') return new FxGuid(value);
    if (info?.type === 'lookup' && typeof value === 'object' && value.id) {
      const table = value.logical_name ?? info.definition.targets?.[0];
      return table ? new FxRecordRef(table, value.id, () => readOne(table, value.id)) : new FxGuid(value.id);
    }
    if ((info?.type === 'datetime' || info?.type === 'date') && typeof value === 'string') {
      const ms = Date.parse(value);
      if (Number.isNaN(ms)) return value;
      if (info.type === 'date')
        return new FxDate(
          'date',
          Date.UTC(new Date(ms).getUTCFullYear(), new Date(ms).getUTCMonth(), new Date(ms).getUTCDate()),
        );
      return new FxDate('datetime', ms, behaviourOf(info.definition) === 'timezoneindependent');
    }
    // Decimal, money and whole numbers stay exact (store exact-numeric values); float and double columns are Float.
    if (info?.type === 'number' && FLOAT.has(typeName(info.definition)))
      return new FxFloat(Number(isExactNumeric(value) ? value.value : value));
    if (Array.isArray(value)) return value.map((item) => ({ Value: item }));
    if (isRecord(value)) return value;
    return value;
  }
  // A Power Fx record (or change record) as store values: logical names, ISO dates, GUID text, lookups as { id, logical_name }.
  function toRow(logical, record) {
    const mapping = mappingOf(logical);
    const row = {};
    for (const [key, value] of Object.entries(record ?? {})) {
      const column = columnInfo(logical, key)?.logical ?? key;
      if (column === mapping.idColumn) continue;
      row[column] = storeValue(value);
    }
    return row;
  }
  function storeValue(value) {
    if (isBlank(value)) return null;
    if (value instanceof FxDate) return value.kind === 'datetime' ? new Date(value.ms).toISOString() : isoOf(value);
    if (value instanceof FxGuid) return value.value;
    if (value instanceof FxFloat) return value.value;
    if (value instanceof FxUntyped) return value.raw;
    if (value instanceof FxRecordRef) return { id: value.id, logical_name: value.table };
    if (isRecord(value) && value[ROW]?.id)
      return { id: String(value[ROW].id).toLowerCase(), logical_name: value[ROW].table };
    if (Array.isArray(value))
      return value.map((item) =>
        isRecord(item) && Object.keys(item).length === 1 ? storeValue(Object.values(item)[0]) : storeValue(item),
      );
    return value;
  }

  // One row by id: the caller's secured read, or (formula columns) the platform's read of the stored row.
  function readOne(logical, id) {
    const mapping = mappingOf(logical);
    if (!caller) {
      const row = store
        .tableRows(mapping.logicalName)
        .find((item) => String(item[mapping.idColumn]).toLowerCase() === String(id).toLowerCase());
      return row ? toRecord(mapping.logicalName, store.withComputed?.(mapping.logicalName, [row])?.[0] ?? row) : null;
    }
    const rows = query(mapping.logicalName, { $filter: `${mapping.idColumn} eq ${String(id).toLowerCase()}` });
    return rows[0] ?? null;
  }
  function query(logical, params, extended = false) {
    const mapping = mappingOf(logical);
    api.principals.authorize({ user: caller.user, entity: mapping.logicalName, operation: 'read', mapping });
    const filters = new Map();
    const options = {
      // The delegated text functions (toupper, tolower, substring, concat) are read in the store's extended OData dialect.
      dialect: extended ? 'extended' : 'dataverse',
      includeKeys: true,
      backendRowsFilter: (name, row) => {
        if (!filters.has(name))
          filters.set(name, api.principals.readFilter({ user: caller.user, entity: name }) ?? (() => true));
        return filters.get(name)(row);
      },
      ...(api.fieldSecurity?.rowMask
        ? { backendRowsMask: (name) => api.fieldSecurity.rowMask(caller.user, name) }
        : {}),
    };
    const answer = store.query(mapping.logicalName, params, caller.identity ?? {}, undefined, options);
    return answer.value.map((row) =>
      toRecord(
        mapping.logicalName,
        api.records?.projectInternal
          ? api.records.projectInternal(caller, mapping.logicalName, row, { single: false })
          : row,
      ),
    );
  }
  // A write as the caller inside a store savepoint; a refusal names the Power Fx error kind of its operation.
  function write(kind, run) {
    const deferred = [];
    try {
      const result = store.sdkMutation ? store.sdkMutation(() => run(deferred)) : run(deferred);
      for (const effect of deferred) {
        Promise.resolve(effect).catch((error) =>
          (diagnostic ?? api.diagnostic)?.({
            code: 'POWERFX_DEFERRED_EFFECT',
            severity: 'warning',
            message: `An asynchronous record hook of a Power Fx write failed after the formula returned: ${error?.message ?? error}`,
          }),
        );
      }
      return result;
    } catch (error) {
      if (error?.status === 403) error.powerFxKind = kind;
      throw error;
    }
  }

  function adapterFor(mapping) {
    const logical = mapping.logicalName;
    const keyOf = (record) => {
      const id = record?.[ROW]?.table === logical ? record[ROW].id : record?.[mapping.idColumn];
      return isBlank(id) ? null : String(id instanceof FxGuid ? id.value : id).toLowerCase();
    };
    const read = ({ filters = [], orderby = [], top = null, extended = false } = {}) => {
      const params = {};
      if (filters.length) params.$filter = filters.join(' and ');
      if (orderby.length) params.$orderby = orderby.join(',');
      if (top !== null) params.$top = String(top);
      return query(logical, params, extended);
    };
    return {
      [Symbol.for('paqvilo.power-fx.dataverse-choices')]: true,
      read,
      count: (q) => read(q).length,
      column: (name) => columnInfo(logical, name),
      choices(name) {
        api.principals.authorize({ user: caller.user, entity: logical, operation: 'read', mapping });
        const column = columnInfo(logical, name);
        if (!column) return undefined;
        if (column.type === 'choice') {
          const options = column.definition.options;
          if (
            !Array.isArray(options) ||
            options.some((option) => !Number.isFinite(option.value) || typeof option.label !== 'string')
          )
            return undefined;
          return { kind: 'choice', values: options.map((option) => ({ Value: option.label, Id: option.value })) };
        }
        if (column.type === 'lookup') {
          const targets = column.definition.targets;
          if (!Array.isArray(targets) || targets.length !== 1 || typeof targets[0] !== 'string') return undefined;
          let target;
          try {
            target = mappingOf(targets[0]);
          } catch {
            return undefined;
          }
          if (!target?.logicalName || !target?.nameColumn) return undefined;
          return {
            kind: 'lookup',
            source: new FxDataSource(target.logicalName, adapterFor(target)),
            nameColumn: target.nameColumn,
          };
        }
        return undefined;
      },
      dataSourceInfo(info, name) {
        const operations = {
          ReadPermission: 'read',
          CreatePermission: 'create',
          EditPermission: 'write',
          DeletePermission: 'delete',
        };
        if (Object.hasOwn(operations, info)) {
          try {
            api.principals.authorize({ user: caller.user, entity: logical, operation: operations[info], mapping });
            return true;
          } catch (error) {
            if (error?.status === 403) return false;
            return undefined;
          }
        }
        if (info === 'AllowedValues') return undefined;
        const column = columnInfo(logical, name);
        if (!column) return undefined;
        const definition = column.definition;
        if (info === 'DisplayName') return labelOf(definition.displayName ?? definition.label) ?? column.logical;
        if (info === 'Required') {
          if (definition.requiredLevel == null) return undefined;
          return ['systemrequired', 'applicationrequired'].includes(String(definition.requiredLevel).toLowerCase());
        }
        const field = { MaxLength: 'maxLength', MaxValue: 'maxValue', MinValue: 'minValue' }[info];
        return field ? definition[field] : undefined;
      },

      literal(column, value) {
        if (isBlank(value)) return 'null';
        if (value instanceof FxUntyped) value = value.raw;
        switch (column.type) {
          case 'text':
            return typeof value === 'string' ? `'${value.replace(/'/g, "''")}'` : null;
          case 'number':
          case 'choice':
            return isNumeric(value) ? toText(value) : null;
          case 'boolean':
            return typeof value === 'boolean' ? String(value) : null;
          case 'datetime':
            return value instanceof FxDate ? new Date(value.ms).toISOString() : null;
          case 'date':
            return value instanceof FxDate ? new Date(value.ms).toISOString().slice(0, 10) : null;
          case 'guid':
          case 'lookup': {
            const id =
              value instanceof FxRecordRef
                ? value.id
                : isRecord(value)
                  ? value[ROW]?.id
                  : value instanceof FxGuid
                    ? value.value
                    : value;
            return typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id) ? id.toLowerCase() : null;
          }
          default:
            return null;
        }
      },
      create(record) {
        const data = toRow(logical, record);
        const row = write('CreatePermission', (deferred) =>
          api.records.createInternal(caller, logical, data, { sync: true, deferred }),
        );
        return readOne(logical, row[mapping.idColumn]) ?? toRecord(logical, row);
      },
      update(base, changes) {
        const id = keyOf(base);
        write('EditPermissions', (deferred) =>
          api.records.updateInternal(caller, logical, id, toRow(logical, changes), { sync: true, deferred }),
        );
        return readOne(logical, id);
      },
      remove(record) {
        const id = keyOf(record);
        if (!id) throw Object.assign(new Error('The record to remove has no primary key.'), { status: 404 });
        write('DeletePermissions', (deferred) =>
          api.records.removeInternal(caller, logical, id, { sync: true, deferred }),
        );
      },
      defaults: () => Object.defineProperty({}, ALIASES, { value: aliasesOf(logical) }),
      key: keyOf,
    };
  }

  // Tables by entity set, logical name or collection label; only for a caller (a formula column has no table sources).
  function dataSource(name) {
    if (!caller) return undefined;
    const mappings = store.state.mappings ?? {};
    // A mapping keyed by its logical name may omit logicalName: the key names the table then.
    const entry = Object.entries(mappings).find(
      ([key, m]) =>
        m.entitySet === name ||
        (m.logicalName ?? key) === name ||
        m.collectionLabel === name ||
        m.displayCollectionName === name,
    );
    return entry
      ? new FxDataSource(name, adapterFor({ ...entry[1], logicalName: entry[1].logicalName ?? entry[0] }))
      : undefined;
  }

  const user = caller?.user;
  // The caller's UI language (usersettings uilanguageid, else the organization's base language) as a BCP-47 tag through the
  // Power Pages language catalogue; Language() and Value/Decimal/Float without a tag follow it. An unknown LCID leaves en-US.
  const languageOf = () => {
    if (!user) return undefined;
    const bare = (value) =>
      String(value ?? '')
        .replace(/[{}]/g, '')
        .toLowerCase();
    const settings =
      store.tableRows?.('usersettings')?.find((row) => bare(row.systemuserid) === bare(user.systemuserid)) ?? {};
    return portalLanguage({
      lcid: Number(settings.uilanguageid ?? store.tableRows?.('organization')?.[0]?.languagecode),
    })?.code;
  };
  return {
    dataSource,
    timeZone,
    get language() {
      return languageOf();
    },
    now: () => (typeof api.clock === 'function' ? api.clock() : Date.now()),
    diagnostic: diagnostic ?? api.diagnostic ?? undefined,
    // The record User() answers in Dataverse functions is not documented; the canvas User() columns are filled from systemuser.
    user: user
      ? {
          FullName: user.fullname ?? null,
          Email: user.internalemailaddress ?? user.domainname ?? null,
          EntraObjectId: user.azureactivedirectoryobjectid ?? null,
        }
      : undefined,
    record: toRecord,
    // Every column of a table (an automated plug-in's ThisRecord holds them all, so Set reaches any column).
    columns: (logical) => Object.keys(definitions(mappingOf(logical).logicalName)),
    row: toRow,
    caller,
  };
}

/** The changed columns of an automated plug-in's ThisRecord (Set on its columns), as store values. */
export function changedColumns(host, logical, before, record) {
  const after = host.row(logical, record);
  const original = host.row(logical, before);
  return Object.fromEntries(
    Object.entries(after).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(original[key])),
  );
}
